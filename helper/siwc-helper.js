#!/usr/bin/env node
/**
 * The local helper — the piece that makes "Sign in with ChatGPT" possible for a
 * browser extension at all.
 *
 * ## Why this program exists
 *
 * OpenAI's Sign-in-with-ChatGPT flow for open-source clients accepts exactly one
 * kind of callback: an HTTP loopback listener on `127.0.0.1`. The published
 * contract is specific — the path is fixed, only the port may vary, and
 * `localhost` is explicitly not the same thing. Chrome extensions cannot satisfy
 * that. `chrome.identity.launchWebAuthFlow` only ever intercepts
 * `https://<extension-id>.chromiumapp.org/*`, which is not an accepted redirect,
 * and an MV3 extension has no way to open a listening socket.
 *
 * So the extension alone cannot complete this flow. This helper can: it is an
 * ordinary local process, it listens on `127.0.0.1`, and it is the thing that
 * holds the credential — which is also what the documentation requires, since it
 * says to keep tokens out of browser storage. The extension never sees a token.
 *
 * ## What it is not
 *
 * It is not a proxy for the ChatGPT website. It does not read cookies, it does
 * not touch `chatgpt.com`, and it never calls ChatGPT's internal `backend-api`.
 * The only two hosts it talks to are `auth.openai.com` (OAuth) and
 * `api.openai.com` (the public Responses API and model list).
 *
 * ## Running it
 *
 *   node helper/siwc-helper.js
 *
 * There is nothing to install; it uses only the Node standard library.
 */

import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { CHATGPT_PLAN_SCOPE, CHATGPT_RESOURCE, CHATGPT_SCOPES, DEFAULT_PORT } from './lib/constants.js';
import { HelperError } from './lib/errors.js';
import { hostAllowed, originAllowed, isJsonRequest } from './lib/guard.js';
import {
  buildAuthorizeUrl,
  discover,
  exchangeCode,
  grantedScopes,
  parseRegistrationCallback,
  refreshTokens,
  revoke,
  tokenFingerprint,
  validateIdToken,
} from './lib/oauth.js';
import { newHostId } from './lib/pkce.js';
import { setNetLogger } from './lib/net.js';
import { generate, listModels } from './lib/responses.js';
import {
  accountKey,
  deleteStore,
  describeProtection,
  readStore,
  redact,
  storeFile,
  writeStore,
} from './lib/store.js';

const HELPER_VERSION = '0.1.3';
const APP_NAME = 'WhatsApp Sales AI Copilot';

/** Bodies are tiny; a cap keeps a stuck client from growing the heap. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** Refresh an access token this long before it actually expires. */
const REFRESH_SKEW_MS = 60_000;

/** How long a started-but-unfinished sign-in stays valid. */
const PENDING_AUTH_TTL_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * The sign-in currently in flight, if any.
 *
 * In memory only, and deliberately so: a `code_verifier` is worthless once its
 * flow ends, and writing one to disk would create a file whose only purpose is
 * to be deleted.
 *
 * @type {null|{state: string, nonce: string, verifier: string, redirectUri: string,
 *              clientIdUsed: string, firstRegistration: boolean, startedAt: number,
 *              status: 'pending'|'connected'|'error', error: string,
 *              registration: object|null}}
 */
let pendingAuth = null;

/**
 * Serialises token refreshes.
 *
 * Refresh tokens rotate: each successful refresh returns a replacement and
 * invalidates the one that was sent. Two concurrent refreshes with the same
 * token therefore mean one succeeds and the other is handed a dead token — and
 * whichever writes last wins. The documentation says to serialise refreshes for
 * a session; the original comment claimed it too. This is that serialisation.
 */
let refreshChain = Promise.resolve();

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function serialize(fn) {
  const run = refreshChain.then(fn, fn);
  refreshChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ---------------------------------------------------------------------------
// Store access
// ---------------------------------------------------------------------------

/** @returns {object} the store, creating a host ID on first use */
function loadStore() {
  const { store } = readStore();
  if (!store.hostId) {
    store.hostId = newHostId();
    writeStore(store);
    log(`Assigned this computer a host ID: ${store.hostId}`);
  }
  return store;
}

/**
 * The account record a request should use.
 * @param {object} store
 * @returns {{key: string, account: object}|null}
 */
function activeRegistration(store) {
  const key = store.activeAccount;
  if (!key) return null;
  const account = store.accounts[key];
  if (!account) return null;
  return { key, account };
}

/** @param {object} account @returns {boolean} */
function hasPlanScope(account) {
  return String((account && account.scope) || '')
    .split(/\s+/)
    .includes(CHATGPT_PLAN_SCOPE);
}

// ---------------------------------------------------------------------------
// Token lifecycle
// ---------------------------------------------------------------------------

/**
 * Refresh once, under the serialisation lock, re-reading the store first so two
 * callers cannot both decide a refresh is needed.
 *
 * @param {{force?: boolean}} [opts]
 * @returns {Promise<string>} a usable access token
 */
function freshAccessToken(opts = {}) {
  return serialize(async () => {
    const store = loadStore();
    const active = activeRegistration(store);
    if (!active) {
      throw new HelperError('CHATGPT_NOT_SIGNED_IN', 'No ChatGPT account is connected yet. Sign in first.', {
        status: 401,
      });
    }
    const { key, account } = active;

    const stillGood = account.accessToken && Number(account.expiresAt || 0) - REFRESH_SKEW_MS > Date.now();
    if (stillGood && !opts.force) return account.accessToken;

    if (!account.refreshToken || !account.clientId) {
      throw new HelperError('CHATGPT_NOT_SIGNED_IN', 'This sign-in cannot be renewed. Sign in with ChatGPT again.', {
        status: 401,
      });
    }

    let tokenResponse;
    try {
      tokenResponse = await refreshTokens({
        clientId: account.clientId,
        refreshToken: account.refreshToken,
        resource: account.resource || CHATGPT_RESOURCE,
      });
    } catch (err) {
      if (err && err.terminal) {
        // Documented terminal refresh failures. The registration itself survives
        // — the docs are explicit that revocation "does not delete the registered
        // client" — so the client ID and label are kept and only the tokens go.
        account.accessToken = '';
        account.refreshToken = '';
        account.idToken = '';
        account.expiresAt = 0;
        account.needsSignIn = true;
        writeStore(store);
        log('Refresh token was rejected terminally; tokens cleared, registration kept');
      }
      throw err;
    }

    const next = Object.assign({}, account, {
      accessToken: tokenResponse.access_token,
      // A replacement refresh token is issued on every refresh; keeping the old
      // one is how a working sign-in turns into a dead one after one more cycle.
      refreshToken: tokenResponse.refresh_token || account.refreshToken,
      idToken: tokenResponse.id_token || account.idToken,
      expiresAt: Date.now() + Number(tokenResponse.expires_in || 3600) * 1000,
      scope: tokenResponse.scope || account.scope,
      needsSignIn: false,
      refreshedAt: Date.now(),
    });
    store.accounts[key] = next;
    writeStore(store);
    log(`Refreshed the access token for ${next.label || key} (${tokenFingerprint(next.accessToken)})`);
    return next.accessToken;
  });
}

/**
 * Run `fn` with a valid token, refreshing once if the call comes back 401.
 *
 * The documentation's guidance for a 401 on this route is to check the account
 * and the granted scopes rather than to loop — so this retries exactly once, and
 * a second 401 becomes an error the user can act on.
 *
 * @template T
 * @param {(accessToken: string) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withAccessToken(fn) {
  const store = loadStore();
  const active = activeRegistration(store);
  if (!active) {
    throw new HelperError('CHATGPT_NOT_SIGNED_IN', 'No ChatGPT account is connected yet. Sign in first.', {
      status: 401,
    });
  }
  if (!hasPlanScope(active.account)) {
    throw new HelperError(
      'CHATGPT_NO_PLAN_SCOPE',
      'This sign-in did not include permission to use your ChatGPT plan. Sign in again and allow plan usage.',
      { status: 403 },
    );
  }

  const token = await freshAccessToken();
  try {
    return await fn(token);
  } catch (err) {
    if (err instanceof HelperError && err.status === 401) {
      log('Direct admission refused the token; refreshing once and retrying');
      const retried = await freshAccessToken({ force: true });
      return fn(retried);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

/**
 * Begin a sign-in and return the URL the browser should be sent to.
 *
 * @param {number} port
 * @returns {Promise<{authorizeUrl: string, firstRegistration: boolean}>}
 */
async function startSignIn(port) {
  const store = loadStore();
  const active = activeRegistration(store);

  const redirectUri = `http://127.0.0.1:${port}/auth/callback`;
  const built = buildAuthorizeUrl({
    redirectUri,
    scopes: CHATGPT_SCOPES,
    resource: CHATGPT_RESOURCE,
    hostId: store.hostId,
    appName: APP_NAME,
    // A returning sign-in reuses the issued client ID. Only a first registration
    // sends `dynamic_agent_client`.
    clientId: active ? active.account.clientId : '',
    // `id_token_hint` is documented to skip the account selector. It is sent to
    // the authorization endpoint and nowhere else, and is redacted from logs.
    idTokenHint: active && active.account.idToken ? active.account.idToken : '',
    loginHint: active && active.account.email ? active.account.email : '',
    forceConsent: false,
  });

  pendingAuth = {
    state: built.state,
    nonce: built.nonce,
    verifier: built.verifier,
    redirectUri,
    clientIdUsed: built.clientId,
    firstRegistration: built.firstRegistration,
    startedAt: Date.now(),
    status: 'pending',
    error: '',
    registration: null,
  };

  log(
    `Sign-in started (${built.firstRegistration ? 'first registration' : 'returning'}) — ` +
      `state=${built.state.slice(0, 6)}… client_id=${built.clientId}`,
  );
  return { authorizeUrl: built.url, firstRegistration: built.firstRegistration };
}

/**
 * Handle the browser landing back on the loopback callback.
 *
 * @param {URL} url
 * @returns {Promise<{title: string, body: string, ok: boolean}>} the page to show
 */
async function handleCallback(url) {
  const params = url.searchParams;

  if (!pendingAuth || Date.now() - pendingAuth.startedAt > PENDING_AUTH_TTL_MS) {
    return page(false, 'This sign-in has expired', 'Start again from the extension.');
  }

  const returnedState = params.get('state') || '';
  if (returnedState !== pendingAuth.state) {
    // The state check is what stops a callback that belongs to a different
    // sign-in — or to somebody else's — being accepted here.
    pendingAuth.status = 'error';
    pendingAuth.error = 'The sign-in response did not match this request.';
    log('Callback rejected: state mismatch');
    return page(false, 'Sign-in could not be verified', 'The response did not match this sign-in attempt. Try again.');
  }

  const oauthError = params.get('error');
  if (oauthError) {
    // On `access_denied` there is no code to exchange, and trying would be wrong.
    pendingAuth.status = 'error';
    pendingAuth.error = params.get('error_description') || oauthError;
    log(`Callback returned an OAuth error: ${oauthError}`);
    return page(false, 'Sign-in was not completed', pendingAuth.error);
  }

  const code = params.get('code');
  if (!code) {
    pendingAuth.status = 'error';
    pendingAuth.error = 'The sign-in response contained no authorization code.';
    return page(false, 'Sign-in could not be completed', pendingAuth.error);
  }

  try {
    // The issued client ID arrives on this same callback and must be read BEFORE
    // the code is exchanged: the token request has to name the registered
    // client (oaiapp_…), not the dynamic entrypoint used to start the flow.
    const registration = parseRegistrationCallback(params);
    const issuedClientId = registration.issuedClientId || '';
    let effectiveClientId;

    if (pendingAuth.firstRegistration) {
      if (!/^oaiapp_[A-Za-z0-9_-]+$/.test(issuedClientId)) {
        // Stop here. Exchanging with dynamic_agent_client would burn the
        // single-use code on a request that is known to be wrong.
        log(`Registration callback carried no usable oaiapp_… client ID (parameters: ${registration.parameterNames.join(',')})`);
        throw new HelperError(
          'CONFIG_INVALID',
          'OpenAI did not return a client registration for this app, so the sign-in cannot be completed. Try again.',
          { status: 502 },
        );
      }
      effectiveClientId = issuedClientId;
      log(`Registration returned a client ID (${issuedClientId.slice(0, 12)}…)`);
    } else {
      // Returning sign-in: the stored client is the only acceptable one.
      if (issuedClientId && issuedClientId !== pendingAuth.clientIdUsed) {
        log('Callback named a different client ID than the saved registration — refusing');
        throw new HelperError(
          'CONFIG_INVALID',
          'The sign-in response named a different app registration than the one saved. Sign out and sign in again.',
          { status: 502 },
        );
      }
      effectiveClientId = pendingAuth.clientIdUsed;
    }

    const tokenResponse = await exchangeCode({
      code,
      verifier: pendingAuth.verifier,
      redirectUri: pendingAuth.redirectUri,
      clientId: effectiveClientId,
      firstRegistration: pendingAuth.firstRegistration,
      resource: CHATGPT_RESOURCE,
    });

    // The ID token's audience is the client ID the token request used.
    const claims = await validateIdToken(tokenResponse.id_token, {
      clientId: effectiveClientId,
      nonce: pendingAuth.nonce,
    });

    const scopes = grantedScopes(tokenResponse);
    const account = {
      clientId: effectiveClientId,
      usedDynamicClientId: false,
      label: claims.email || claims.name || claims.sub,
      email: claims.email || '',
      name: claims.name || '',
      sub: claims.sub || '',
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token || '',
      idToken: tokenResponse.id_token || '',
      expiresAt: Date.now() + Number(tokenResponse.expires_in || 3600) * 1000,
      scope: scopes.join(' '),
      resource: CHATGPT_RESOURCE,
      registeredAt: Date.now(),
      needsSignIn: false,
    };

    const key = accountKey(account.sub);
    if (!key) {
      pendingAuth.status = 'error';
      pendingAuth.error = 'The identity token did not identify an account.';
      return page(false, 'Sign-in could not be completed', pendingAuth.error);
    }

    const store = loadStore();
    // Never overwrite one registration's credentials with another's.
    store.accounts[key] = Object.assign({}, store.accounts[key], account);
    store.activeAccount = key;
    writeStore(store);

    pendingAuth.status = 'connected';
    pendingAuth.registration = { parameterNames: registration.parameterNames, issuedClientId: !!issuedClientId };
    log(
      `Signed in as ${account.label} — plan scope ${hasPlanScope(account) ? 'granted' : 'NOT granted'}, ` +
        `access token ${tokenFingerprint(account.accessToken)}`,
    );

    if (!hasPlanScope(account)) {
      return page(
        true,
        'Signed in — plan usage not allowed',
        'You signed in, but you did not allow this app to use your ChatGPT plan. ' +
          'The extension will ask you to sign in again if you want to turn that on.',
      );
    }
    return page(true, 'You are signed in', 'Close this tab and go back to WhatsApp.');
  } catch (err) {
    const message = err instanceof HelperError ? err.message : (err && err.message) || 'Unknown failure.';
    pendingAuth.status = 'error';
    pendingAuth.error = message;
    log(`Callback failed: ${err && err.code ? err.code : 'ERROR'} — ${message}`);
    return page(false, 'Sign-in could not be completed', message);
  }
}

/**
 * End the session.
 *
 * Revocation is attempted first and its result recorded, because "signed out"
 * and "signed out, but OpenAI was not told" are different facts and the user is
 * entitled to the true one. Either way the local tokens go.
 *
 * @returns {Promise<{revoked: boolean, message: string}>}
 */
async function signOut() {
  const store = loadStore();
  const active = activeRegistration(store);
  if (!active) {
    deleteStore();
    return { revoked: false, message: 'No account was connected.' };
  }

  let revoked = false;
  let detail = '';
  if (active.account.refreshToken) {
    const out = await revoke({ clientId: active.account.clientId, refreshToken: active.account.refreshToken });
    revoked = out.revoked;
    detail = out.detail;
  }

  // The registration survives a sign-out: the docs say revoking the session does
  // not delete the registered client, and keeping the client ID means the next
  // sign-in is a returning one rather than a fresh registration.
  store.accounts[active.key] = Object.assign({}, active.account, {
    accessToken: '',
    refreshToken: '',
    idToken: '',
    expiresAt: 0,
    needsSignIn: true,
  });
  if (!store.accounts[active.key].clientId) delete store.accounts[active.key];
  writeStore(store);
  pendingAuth = null;

  if (revoked) {
    log('Signed out; OpenAI confirmed the session was revoked');
    return { revoked: true, message: 'Signed out. The session was revoked with OpenAI.' };
  }
  log(`Signed out locally; revocation unconfirmed (${detail || 'no detail'})`);
  return {
    revoked: false,
    message:
      'Signed out on this computer. OpenAI did not confirm the revocation — ' +
      'you can also disconnect the app from ChatGPT → Settings.',
  };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/** @returns {object} the status the extension renders */
function status() {
  const protection = describeProtection();
  let store = null;
  let readError = '';
  try {
    store = readStore().store;
  } catch (err) {
    readError = (err && err.message) || 'The credential file could not be read.';
  }

  const active = store ? activeRegistration(store) : null;
  const account = active ? active.account : null;

  return {
    ok: true,
    version: HELPER_VERSION,
    appName: APP_NAME,
    hostId: store ? store.hostId : '',
    credentialFile: protection,
    storeError: readError,
    signedIn: !!(account && account.accessToken && !account.needsSignIn),
    account: account
      ? Object.assign(redact(account), {
          planScope: hasPlanScope(account),
          needsSignIn: !!account.needsSignIn,
          expiresInSec: account.expiresAt ? Math.max(0, Math.round((account.expiresAt - Date.now()) / 1000)) : 0,
        })
      : null,
    accountCount: store ? Object.keys(store.accounts).length : 0,
    pending: pendingAuth
      ? {
          status: pendingAuth.status,
          error: pendingAuth.error,
          startedAt: pendingAuth.startedAt,
          firstRegistration: pendingAuth.firstRegistration,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<any>}
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HelperError('CONFIG_INVALID', 'The request body was too large.', { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(new HelperError('CONFIG_INVALID', 'The request body was not valid JSON.', { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/** @param {import('node:http').ServerResponse} res @param {number} status @param {any} body */
function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    // Nothing here is cacheable, and a cached status would be a stale one.
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(text);
}

/** @param {import('node:http').ServerResponse} res @param {number} status @param {string} html */
function sendHtml(res, status, html) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    // The page has no scripts and no stylesheets; say so, so that even a
    // hypothetical injection has nothing to run.
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
  });
  res.end(html);
}

/** @param {boolean} ok @param {string} title @param {string} body */
function page(ok, title, body) {
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{margin:0;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
       background:#0f1512;color:#e8efe9;display:flex;min-height:100vh;align-items:center;justify-content:center}
  main{max-width:34rem;padding:2.5rem;text-align:center}
  h1{font-size:1.35rem;margin:0 0 .6rem;color:${ok ? '#7ee2a8' : '#ffb4a8'}}
  p{margin:0;color:#b9c6bd}
  .mark{font-size:2rem;line-height:1;margin-bottom:1rem}
</style></head>
<body><main>
  <div class="mark" aria-hidden="true">${ok ? '&#10003;' : '&#9888;'}</div>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(body)}</p>
</main></body></html>`;
  return { html, ok };
}

/** @param {string} s @returns {string} */
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Build the request handler.
 *
 * Exported as a factory so `tools/test-helper.js` can start this exact server on
 * an ephemeral port and drive it, rather than testing a re-implementation of it.
 *
 * @param {{port: number, log?: (...args: unknown[]) => void}} opts
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
function createHandler(opts) {
  const port = opts.port;
  const emit = opts.log || log;

  return function handle(req, res) {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    const route = `${req.method} ${url.pathname}`;

    // --- guards, before any route logic -----------------------------------
    if (!hostAllowed(req.headers.host, port)) {
      emit(`Refused ${route}: Host header is not this server's own address`);
      sendJson(res, 403, { ok: false, code: 'FORBIDDEN', message: 'This helper only answers on 127.0.0.1.' });
      return;
    }
    if (!originAllowed(req.headers.origin)) {
      emit(`Refused ${route}: Origin ${String(req.headers.origin).slice(0, 40)} is not an extension origin`);
      sendJson(res, 403, { ok: false, code: 'FORBIDDEN', message: 'Requests must come from the extension.' });
      return;
    }
    if (req.method === 'OPTIONS') {
      // A preflight from a web page never reaches this line — it carries an
      // Origin and is refused above. This answers the case where something
      // sends OPTIONS without one, and it is refused here too: no `Allow`
      // beyond the two verbs that exist, and no CORS header of any kind, ever.
      res.writeHead(405, { Allow: 'GET, POST', 'Cache-Control': 'no-store' });
      res.end();
      return;
    }

    const isPost = req.method === 'POST';
    if (isPost && !isJsonRequest(req.headers['content-type'])) {
      sendJson(res, 415, { ok: false, code: 'CONFIG_INVALID', message: 'Expected a JSON request body.' });
      return;
    }

    Promise.resolve()
      .then(() => dispatch(req, res, url, isPost, port))
      .catch((err) => {
        const helperError =
          err instanceof HelperError
            ? err
            : new HelperError('CHATGPT_FAILED', (err && err.message) || 'The helper failed unexpectedly.', {
                status: 500,
              });
        if (!(err instanceof HelperError)) emit(`Unhandled failure on ${route}:`, (err && err.stack) || err);
        else emit(`Failed ${route}: ${helperError.code}`);
        if (!res.headersSent) sendJson(res, helperError.status, helperError.toBody());
        else res.end();
      });
  };
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url
 * @param {boolean} isPost
 * @param {number} port the port this handler is serving on
 */
async function dispatch(req, res, url, isPost, port) {
  const route = url.pathname;

  if (route === '/health' && req.method === 'GET') {
    const s = status();
    sendJson(res, 200, {
      ok: true,
      version: s.version,
      appName: s.appName,
      hostId: s.hostId,
      credentialFile: s.credentialFile,
      signedIn: s.signedIn,
      planScope: s.account ? s.account.planScope : false,
      account: s.account ? { label: s.account.label, email: s.account.email } : null,
    });
    return;
  }

  if (route === '/auth/status' && req.method === 'GET') {
    sendJson(res, 200, status());
    return;
  }

  if (route === '/auth/start' && isPost) {
    // The port comes from the handler, not from a module-level global: the
    // redirect URI has to name the port this server is *actually* on, and a
    // helper started with `--port` would otherwise send the browser back to
    // 8788, where nothing is listening.
    const { authorizeUrl, firstRegistration } = await startSignIn(port);
    sendJson(res, 200, { ok: true, authorizeUrl, firstRegistration });
    return;
  }

  if (route === '/auth/callback' && req.method === 'GET') {
    const result = await handleCallback(url);
    sendHtml(res, result.ok ? 200 : 400, result.html);
    return;
  }

  if (route === '/auth/sign-out' && isPost) {
    const out = await signOut();
    sendJson(res, 200, { ok: true, revoked: out.revoked, message: out.message });
    return;
  }

  if (route === '/models' && req.method === 'GET') {
    const out = await withAccessToken((token) => listModels({ accessToken: token }));
    sendJson(res, 200, {
      ok: true,
      models: out.models,
      total: out.total,
      visibilityReported: out.visibilityReported,
    });
    return;
  }

  if (route === '/generate' && isPost) {
    const body = await readJsonBody(req);
    const model = String(body.model || '').trim();
    const input = String(body.input || '');
    const instructions = String(body.instructions || '');
    if (!model) throw new HelperError('CONFIG_INVALID', 'No model was named.', { status: 400 });
    if (!input.trim()) throw new HelperError('CONFIG_INVALID', 'There was nothing to send.', { status: 400 });

    const controller = new AbortController();
    // If the extension gives up — the user closed the panel, the worker was
    // evicted — stop paying for tokens nobody will read.
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    const out = await withAccessToken((token) =>
      generate({
        accessToken: token,
        model,
        instructions,
        input,
        signal: controller.signal,
        timeoutMs: body.timeoutMs,
      }),
    );
    sendJson(res, 200, { ok: true, ...out });
    return;
  }

  if (route === '/test' && isPost) {
    const body = await readJsonBody(req);
    const model = String(body.model || '').trim();
    if (!model) throw new HelperError('CONFIG_INVALID', 'No model was named.', { status: 400 });

    const out = await withAccessToken((token) =>
      generate({
        accessToken: token,
        model,
        instructions: 'Reply with the single word: ok',
        input: 'ping',
      }),
    );
    sendJson(res, 200, { ok: true, text: out.text.slice(0, 80), model: out.model, elapsedMs: out.elapsedMs });
    return;
  }

  sendJson(res, 404, { ok: false, code: 'NOT_FOUND', message: `No route for ${req.method} ${route}` });
}

// ---------------------------------------------------------------------------
// Process
// ---------------------------------------------------------------------------

/** @param {...unknown} args */
function log(...args) {
  console.log('[siwc-helper]', ...args);
}
setNetLogger((line) => log(line));

/** @param {string} [line] */
function usage(line) {
  if (line) console.error(`\n${line}`);
  console.log(`
WhatsApp Sales AI Copilot — local helper v${HELPER_VERSION}

  node helper/siwc-helper.js [options]

Options
  --port <n>              Port to listen on (default ${DEFAULT_PORT}). Must match the
                          Helper address in the extension's settings.
  --print-authorize-url   Start a sign-in and print the URL, instead of waiting
                          for the extension to ask. Useful for checking the flow
                          by hand.
  --status                Print the current connection status and exit.
  --sign-out              Sign out (revoking the session with OpenAI) and exit.
  --help                  This text.

The helper listens on 127.0.0.1 only, and holds your ChatGPT credential in
${storeFile()}
`);
}

/** @returns {Promise<void>} */
async function main() {
  const argv = process.argv.slice(2);
  /** @type {{port: number, printUrl: boolean, statusOnly: boolean, signOut: boolean}} */
  const opts = { port: DEFAULT_PORT, printUrl: false, statusOnly: false, signOut: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      usage();
      return;
    }
    if (arg === '--print-authorize-url') opts.printUrl = true;
    else if (arg === '--status') opts.statusOnly = true;
    else if (arg === '--sign-out') opts.signOut = true;
    else if (arg === '--port') {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 1 || value > 65535) {
        usage('--port needs a port number between 1 and 65535.');
        process.exitCode = 2;
        return;
      }
      opts.port = value;
      i += 1;
    } else {
      usage(`Unknown option: ${arg}`);
      process.exitCode = 2;
      return;
    }
  }

  if (opts.statusOnly) {
    console.log(JSON.stringify(status(), null, 2));
    return;
  }

  if (opts.signOut) {
    const out = await signOut();
    console.log(out.message);
    return;
  }

  const protection = describeProtection();
  const current = status();
  log(`v${HELPER_VERSION} — credential file ${protection.path} (${protection.note})`);
  if (protection.exists && !protection.ownerOnly && process.platform !== 'win32') {
    log('WARNING: the credential file exists and is not owner-only. Check the permissions on the directory above.');
  }
  log(
    current.signedIn
      ? `Signed in as ${current.account.label}${current.account.planScope ? '' : ' (plan usage NOT allowed)'}`
      : 'No ChatGPT account connected yet — the extension will start a sign-in.',
  );

  const server = http.createServer(createHandler({ port: opts.port, log }));

  await new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err && err.code === 'EADDRINUSE') {
        reject(
          new Error(
            `Port ${opts.port} is already in use. Another helper may be running, ` +
              `or choose a different port with --port.`,
          ),
        );
        return;
      }
      reject(err);
    });
    // 127.0.0.1 and nothing else. Binding the wildcard address would put the
    // credential holder on the local network.
    server.listen(opts.port, '127.0.0.1', resolve);
  });

  const boundPort = server.address().port;
  log(`Listening on http://127.0.0.1:${boundPort} — press Ctrl+C to stop`);

  if (opts.printUrl) {
    const { authorizeUrl, firstRegistration } = await startSignIn(boundPort);
    log(`Sign-in (${firstRegistration ? 'first registration' : 'returning'}):`);
    console.log(`\n${authorizeUrl}\n`);
    log('Open that URL in a browser on this computer to complete the sign-in.');
  }

  const shutdown = () => {
    log('Shutting down');
    server.close(() => process.exit(0));
    // Do not wait forever for keep-alive sockets.
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

export { createHandler, status, startSignIn, signOut, freshAccessToken, HELPER_VERSION };

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main().catch((err) => {
    console.error(`[siwc-helper] ${(err && err.message) || err}`);
    process.exitCode = 1;
  });
}
