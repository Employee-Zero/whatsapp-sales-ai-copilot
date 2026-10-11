/**
 * ChatGPT-subscription client — the extension's half of the local-helper
 * protocol.
 *
 * Runs ONLY in the service worker, like every other AI call in this project.
 *
 * ## What is deliberately absent
 *
 * No token. Not an access token, not a refresh token, not an ID token. This
 * module cannot leak a credential because it is never given one: OpenAI's
 * Sign-in-with-ChatGPT documentation says to keep tokens out of browser storage,
 * and the only way to be certain of that is for the browser never to hold them.
 * The helper is the credential holder; this is an HTTP client for a loopback
 * service that has two endpoints that matter.
 *
 * The nearest thing to a secret in here is the *base URL* of the helper, which is
 * a fixed loopback address and is not one.
 *
 * ## Why the extension talks to a helper at all
 *
 * Because it cannot do the sign-in itself. The documented callback for this flow
 * is an HTTP listener on `127.0.0.1`, and an MV3 extension cannot open a
 * listening socket; `chrome.identity.launchWebAuthFlow` only intercepts
 * `https://<extension-id>.chromiumapp.org/*`, which is not an accepted redirect.
 * `docs/ARCHITECTURE.md` sets the whole chain out, and `README.md` states the
 * user-visible consequence: this method needs a small program running on the
 * same computer.
 */

import {
  CHATGPT_HELPER_PATHS,
  ERR,
} from './../shared/constants.js';
import { helperBaseUrl, helperStartCommand, log, logError, withTimeout } from './../shared/utils.js';

/** How long a status or model-list call may take. */
const HELPER_CALL_TIMEOUT_MS = 15_000;

/** How long the sign-in start call may take (it does no network I/O at all). */
const HELPER_START_TIMEOUT_MS = 15_000;

/**
 * One call to the helper.
 *
 * A closed port is the common case and gets its own code, because it is the one
 * failure the user can fix in five seconds and the generic message would send
 * them looking at their ChatGPT account instead.
 *
 * @param {object} cfg
 * @param {string} path
 * @param {{method?: string, body?: object, timeoutMs?: number}} [opts]
 * @returns {Promise<object>} the parsed JSON body
 * @throws {Error} HELPER_UNREACHABLE | CHATGPT_* | TIMEOUT
 */
async function callHelper(cfg, path, opts = {}) {
  const url = `${helperBaseUrl(cfg)}${path}`;
  const timeoutMs = opts.timeoutMs || HELPER_CALL_TIMEOUT_MS;
  const init = { method: opts.method || 'GET', headers: { Accept: 'application/json' } };
  if (opts.body !== undefined) {
    init.method = 'POST';
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }

  let res;
  try {
    res = await withTimeout(fetch(url, init), timeoutMs, 'The local helper did not answer in time.');
  } catch (err) {
    if (err && err.code === ERR.TIMEOUT) {
      const e = new Error('The local helper did not answer in time.');
      e.code = ERR.CHATGPT_FAILED;
      throw e;
    }
    // TypeError from fetch: nothing is listening, or the request was refused.
    // Never include the raw message — it can contain the URL, and on some
    // platforms the whole request.
    logError('helper unreachable at', safeHost(url));
    const e = new Error(`The local helper is not running. Start it with: ${helperStartCommand(cfg)}`);
    e.code = ERR.HELPER_UNREACHABLE;
    e.startCommand = helperStartCommand(cfg);
    e.helperUrl = helperBaseUrl(cfg);
    throw e;
  }

  let data = null;
  try {
    data = await res.json();
  } catch (err) {
    data = null;
  }

  if (!res.ok) {
    const code = data && typeof data.code === 'string' && KNOWN_HELPER_CODES.includes(data.code) ? data.code : ERR.CHATGPT_FAILED;
    const e = new Error((data && data.message) || `The local helper returned HTTP ${res.status}.`);
    e.code = code;
    e.status = res.status;
    e.detail = (data && data.detail) || '';
    e.requestId = (data && data.requestId) || '';
    e.retryable = !!(data && data.retryable);
    throw e;
  }

  if (!data || typeof data !== 'object') {
    const e = new Error('The local helper returned a response this extension could not read.');
    e.code = ERR.CHATGPT_FAILED;
    throw e;
  }
  return data;
}

/**
 * Codes the helper is allowed to hand back.
 *
 * Anything else is replaced with the generic failure, so a helper from a newer
 * version cannot put an unrecognised code in front of `describeError` and produce
 * "Something went wrong (SOME_NEW_CODE)".
 */
const KNOWN_HELPER_CODES = Object.freeze([
  ERR.HELPER_UNREACHABLE,
  ERR.CHATGPT_NOT_SIGNED_IN,
  ERR.CHATGPT_NO_PLAN_SCOPE,
  ERR.CHATGPT_NOT_ELIGIBLE,
  ERR.CHATGPT_USAGE_LIMIT,
  ERR.CHATGPT_UNAVAILABLE,
  ERR.CHATGPT_FAILED,
  ERR.HELPER_CONFIG_INVALID,
]);

/** @param {string} url @returns {string} */
function safeHost(url) {
  try {
    return new URL(url).host;
  } catch (err) {
    return 'loopback';
  }
}

/**
 * Everything the panel needs in order to describe the connection truthfully.
 *
 * Never throws: "the helper is not running" is a state the panel has to render,
 * not an error it has to catch.
 *
 * @param {object} cfg
 * @returns {Promise<object>}
 */
async function helperStatus(cfg) {
  const base = {
    helperUrl: helperBaseUrl(cfg),
    startCommand: helperStartCommand(cfg),
    /** 'running' | 'unreachable' */
    helper: 'unreachable',
    signedIn: false,
    planScope: false,
    email: '',
    label: '',
    expiresInSec: 0,
    credentialFile: null,
    version: '',
    /** 'none' | 'pending' | 'connected' | 'error' */
    signIn: 'none',
    signInError: '',
    error: '',
  };

  try {
    const data = await callHelper(cfg, CHATGPT_HELPER_PATHS.AUTH_STATUS);
    return Object.assign(base, {
      helper: 'running',
      version: String(data.version || ''),
      signedIn: !!data.signedIn,
      planScope: !!(data.account && data.account.planScope),
      email: (data.account && data.account.email) || '',
      label: (data.account && data.account.label) || '',
      expiresInSec: (data.account && data.account.expiresInSec) || 0,
      credentialFile: data.credentialFile || null,
      signIn: signInStateOf(data),
      signInError: (data.pending && data.pending.error) || '',
      storeError: String(data.storeError || ''),
    });
  } catch (err) {
    return Object.assign(base, {
      error: err && err.code ? err.code : ERR.CHATGPT_FAILED,
    });
  }
}

/**
 * Reduce the helper's two status fields to the one word the panel renders.
 *
 * The stored sign-in and the in-flight sign-in are separate facts and both
 * matter: "no account" is not the same screen as "a sign-in is open in another
 * tab waiting for you".
 *
 * @param {object} data helper status payload
 * @returns {'none'|'pending'|'connected'|'error'}
 */
function signInStateOf(data) {
  const pending = data && data.pending;
  if (pending && pending.status === 'pending') return 'pending';
  if (pending && pending.status === 'error') return 'error';
  if (data && data.signedIn) return 'connected';
  if (data && data.account && data.account.needsSignIn) return 'expired';
  return 'none';
}

/**
 * Ask the helper to begin a sign-in, and return the URL to open.
 *
 * @param {object} cfg
 * @returns {Promise<{authorizeUrl: string, firstRegistration: boolean}>}
 */
async function startSignIn(cfg) {
  const data = await callHelper(cfg, CHATGPT_HELPER_PATHS.AUTH_START, {
    method: 'POST',
    body: {},
    timeoutMs: HELPER_START_TIMEOUT_MS,
  });
  const authorizeUrl = String(data.authorizeUrl || '');
  if (!/^https:\/\/auth\.openai\.com\//.test(authorizeUrl)) {
    // Refuse to open anything that is not OpenAI's own authorization endpoint.
    // This is the one place where a compromised or mis-pointed helper could send
    // the user's browser somewhere harmful.
    const e = new Error('The local helper did not return an OpenAI sign-in address.');
    e.code = ERR.CHATGPT_FAILED;
    throw e;
  }
  log('ChatGPT sign-in started', data.firstRegistration ? '(first registration)' : '(returning)');
  return { authorizeUrl, firstRegistration: !!data.firstRegistration };
}

/**
 * Sign out, and report whether OpenAI confirmed the revocation.
 *
 * @param {object} cfg
 * @returns {Promise<{revoked: boolean, message: string}>}
 */
async function signOut(cfg) {
  const data = await callHelper(cfg, CHATGPT_HELPER_PATHS.AUTH_SIGN_OUT, { method: 'POST', body: {} });
  return { revoked: !!data.revoked, message: String(data.message || 'Signed out.') };
}

/**
 * The models this ChatGPT account may use.
 *
 * @param {object} cfg
 * @returns {Promise<{models: Array<{slug: string, displayName: string}>, total: number, visibilityReported: boolean}>}
 */
async function listModels(cfg) {
  const data = await callHelper(cfg, CHATGPT_HELPER_PATHS.MODELS, { timeoutMs: 30_000 });
  const models = Array.isArray(data.models) ? data.models : [];
  return {
    models: models.filter((m) => m && typeof m.slug === 'string'),
    total: Number(data.total || models.length),
    visibilityReported: data.visibilityReported !== false,
  };
}

/**
 * Generate a reply over the user's ChatGPT plan.
 *
 * The body this ends up sending is built by the helper, and is deliberately
 * minimal: `model`, `instructions`, `input`, `store: false`, `stream: true`. A
 * whole set of ordinary Responses parameters is rejected in this flow, and
 * `helper/lib/responses.js` documents which and why. Nothing here re-adds them —
 * temperature and max-token settings genuinely do not apply on this path, and
 * the panel says so rather than pretending otherwise.
 *
 * @param {object} cfg
 * @param {{instructions: string, input: string, timeoutMs?: number}} args
 * @returns {Promise<{text: string, model: string, usage: object|null, elapsedMs: number}>}
 */
async function generate(cfg, args) {
  const data = await callHelper(cfg, CHATGPT_HELPER_PATHS.GENERATE, {
    method: 'POST',
    body: {
      model: cfg.chatgptModel,
      instructions: args.instructions,
      input: args.input,
      timeoutMs: args.timeoutMs,
    },
    // The helper's own ceiling is 120 s; give the extension a little more than
    // the request it asked for, so the helper's tidy error wins the race rather
    // than this side's blunt timeout.
    timeoutMs: Math.max(HELPER_CALL_TIMEOUT_MS, Math.round(Number(args.timeoutMs) || 0) + 5_000),
  });

  const text = String(data.text || '').trim();
  if (!text) {
    const e = new Error('ChatGPT completed the request but returned no text.');
    e.code = ERR.AI_EMPTY;
    throw e;
  }
  return { text, model: String(data.model || cfg.chatgptModel), usage: data.usage || null, elapsedMs: Number(data.elapsedMs || 0) };
}

/**
 * Send one real, minimal request — the "does this actually work" button.
 *
 * Deliberately NOT what "Test Connection" does by default: this spends the
 * account's allowance, so it is a separate action the user takes knowingly.
 *
 * @param {object} cfg
 * @returns {Promise<object>} always resolves; inspect `.ok`
 */
async function sendTestRequest(cfg) {
  const startedAt = Date.now();
  try {
    const data = await callHelper(cfg, CHATGPT_HELPER_PATHS.TEST, {
      method: 'POST',
      body: { model: cfg.chatgptModel },
      timeoutMs: 90_000,
    });
    return {
      ok: true,
      model: String(data.model || cfg.chatgptModel),
      sample: String(data.text || '').slice(0, 60),
      responseMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      ok: false,
      error: (err && err.message) || 'The request failed.',
      code: (err && err.code) || ERR.CHATGPT_FAILED,
      status: err && err.status,
      detail: err && err.detail,
      requestId: err && err.requestId,
      retryable: !!(err && err.retryable),
    };
  }
}

/**
 * The free half: is the helper there, is an account signed in, does the account
 * allow plan usage, and is the chosen model one the account actually has?
 *
 * Makes no inference request, so it costs nothing and can be clicked freely.
 *
 * @param {object} cfg
 * @returns {Promise<object>} always resolves; inspect `.ok`
 */
async function checkConnection(cfg) {
  const status = await helperStatus(cfg);
  if (status.helper !== 'running') {
    return {
      ok: false,
      code: ERR.HELPER_UNREACHABLE,
      error: 'The local helper is not running.',
      startCommand: status.startCommand,
      helperUrl: status.helperUrl,
    };
  }
  if (!status.signedIn) {
    return {
      ok: false,
      code: status.signIn === 'error' ? ERR.CHATGPT_FAILED : ERR.CHATGPT_NOT_SIGNED_IN,
      error:
        status.signIn === 'error'
          ? status.signInError || 'The last sign-in attempt did not finish.'
          : 'No ChatGPT account is connected yet.',
      helperUrl: status.helperUrl,
    };
  }
  if (!status.planScope) {
    return {
      ok: false,
      code: ERR.CHATGPT_NO_PLAN_SCOPE,
      error: 'This sign-in did not include permission to use your ChatGPT plan.',
      helperUrl: status.helperUrl,
    };
  }
  if (!String(cfg.chatgptModel || '').trim()) {
    return { ok: false, code: ERR.AI_NOT_CONFIGURED, error: 'Choose a model first.', missingFields: ['chatgptModel'], missingFieldLabels: ['Model'] };
  }

  try {
    const out = await listModels(cfg);
    const found = out.models.some((m) => m.slug === cfg.chatgptModel);
    if (!found) {
      return {
        ok: false,
        code: ERR.AI_NOT_CONFIGURED,
        error:
          out.models.length === 0
            ? 'Your ChatGPT account reported no models available to this app. Check the account, or use your own API key.'
            : `“${cfg.chatgptModel}” is not among the models available to this account. Pick one from the list.`,
        helperUrl: status.helperUrl,
      };
    }
    return {
      ok: true,
      account: status.label || status.email,
      model: cfg.chatgptModel,
      modelCount: out.models.length,
      helperUrl: status.helperUrl,
      helperVersion: status.version,
      planScope: status.planScope,
      expiresInSec: status.expiresInSec,
      /** The panel prints this, so the free check can never be mistaken for a real call. */
      inferenceRequestSent: false,
    };
  } catch (err) {
    return {
      ok: false,
      code: (err && err.code) || ERR.CHATGPT_FAILED,
      error: (err && err.message) || 'The helper could not list this account’s models.',
      helperUrl: status.helperUrl,
    };
  }
}

export {
  helperBaseUrl,
  helperStartCommand,
  callHelper,
  helperStatus,
  signInStateOf,
  startSignIn,
  signOut,
  listModels,
  generate,
  sendTestRequest,
  checkConnection,
  KNOWN_HELPER_CODES,
};
