/**
 * The OAuth half of the ChatGPT-plan flow: discovery, the authorization URL,
 * the code exchange, ID-token validation, refresh, and revocation.
 *
 * Everything here is dictated by the published Sign-in-with-ChatGPT pages plus
 * the live OIDC discovery document at `https://auth.openai.com/.well-known/
 * openid-configuration`. Where the two disagree, the disagreement is written
 * down next to the code rather than smoothed over — see `planScopes()`.
 *
 * No file in this module ever logs a token. The `redact()` helpers at the bottom
 * are the only way a caller gets a printable form.
 */

import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { createPkce, randomUrlSafe } from './pkce.js';
import { HelperError } from './errors.js';

const ISSUER = 'https://auth.openai.com';
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`;
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;

/**
 * The client ID that *starts* a first-time registration.
 *
 * The documentation is explicit that this value "is the first-time registration
 * entrypoint, not the client ID to save": OpenAI answers such a request by
 * issuing a per-account client ID, and that issued ID is what every later
 * sign-in and every token refresh must use. Storing this constant as if it were
 * the client ID is the single easiest way to get this flow wrong.
 */
const DYNAMIC_CLIENT_ID = 'dynamic_agent_client';

/** How long the discovery document is trusted before being fetched again. */
const DISCOVERY_TTL_MS = 60 * 60 * 1000;

/** Network timeout for every call to OpenAI. */
const NETWORK_TIMEOUT_MS = 30_000;

/** @type {{at: number, doc: object}|null} */
let discoveryCache = null;
/** @type {{at: number, keys: Array<object>}|null} */
let jwksCache = null;

/**
 * Fetch and cache the OIDC discovery document.
 *
 * Used for the JWKS location and the revocation endpoint — the two things the
 * Sign-in-with-ChatGPT pages leave to "OpenAI's published JWKS" and a pointer at
 * `.well-known/openid-configuration` without quoting a URL.
 *
 * @param {boolean} [force]
 * @returns {Promise<object>}
 */
async function discover(force = false) {
  const now = Date.now();
  if (!force && discoveryCache && now - discoveryCache.at < DISCOVERY_TTL_MS) return discoveryCache.doc;

  const res = await fetchWithTimeout(DISCOVERY_URL, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    throw new HelperError('CONFIG_INVALID', `Could not read OpenAI's sign-in configuration (HTTP ${res.status}).`, {
      status: 502,
      retryable: true,
    });
  }
  const doc = await res.json();
  if (!doc || typeof doc !== 'object' || !doc.jwks_uri || !doc.revocation_endpoint) {
    throw new HelperError('CONFIG_INVALID', "OpenAI's sign-in configuration did not contain the expected endpoints.", {
      status: 502,
      retryable: true,
    });
  }
  discoveryCache = { at: now, doc };
  return doc;
}

/**
 * The scope set to request.
 *
 * Read from the published flow documentation, deliberately NOT from the OIDC
 * discovery document. Discovery advertises `openid profile email offline_access`
 * and stops there — the two scopes that actually authorise ChatGPT plan usage
 * (`resource.invoke`, `chatgpt.tokens.use.direct`) are absent from it. A helper
 * that built its scope string out of discovery would sign the user in perfectly
 * and then never be allowed to make an inference request.
 *
 * @param {string} scopes the constant from the extension's shared constants
 * @returns {string}
 */
function planScopes(scopes) {
  return scopes;
}

/**
 * Build the authorization URL the user's browser is sent to.
 *
 * The `state` and `nonce` are returned to the caller because they have to be
 * held until the callback arrives; nothing about them is stored on disk.
 *
 * `agent_name_hint` is sent only for a first-time registration, because the
 * documentation says to "omit your app's `agent_name_hint` from reauthorization
 * requests". `ext_agent_host_id` goes on both — the docs ask for it on the
 * returning path too.
 *
 * @param {object} opts
 * @param {string} opts.redirectUri exact loopback callback, port included
 * @param {string} opts.scopes space-separated
 * @param {string} opts.resource
 * @param {string} opts.hostId
 * @param {string} opts.appName used as agent_name_hint on first registration
 * @param {string} [opts.clientId] issued client ID; omit for a first registration
 * @param {string} [opts.idTokenHint] retained ID token, to skip the account picker
 * @param {string} [opts.loginHint] remembered email
 * @param {boolean} [opts.forceConsent] re-ask for the plan scopes
 * @returns {{url: string, verifier: string, state: string, nonce: string, clientId: string, firstRegistration: boolean}}
 */
function buildAuthorizeUrl(opts) {
  const firstRegistration = !opts.clientId;
  const clientId = opts.clientId || DYNAMIC_CLIENT_ID;
  const pkce = createPkce();
  const state = randomUrlSafe(32);
  const nonce = randomUrlSafe(32);

  const params = new URLSearchParams();
  params.set('response_type', 'code');
  params.set('client_id', clientId);
  params.set('redirect_uri', opts.redirectUri);
  params.set('scope', planScopes(opts.scopes));
  params.set('resource', opts.resource);
  params.set('state', state);
  params.set('nonce', nonce);
  params.set('code_challenge', pkce.challenge);
  params.set('code_challenge_method', pkce.method);
  params.set('ext_agent_host_id', opts.hostId);
  if (firstRegistration) params.set('agent_name_hint', opts.appName);
  if (opts.idTokenHint) params.set('id_token_hint', opts.idTokenHint);
  if (opts.loginHint) params.set('login_hint', opts.loginHint);
  // `force_reconsent` is documented as usable only once OpenAI has confirmed the
  // integration's deployment; until then the ordinary OAuth `prompt` parameter
  // is what re-asks for the plan scopes.
  if (opts.forceConsent) params.set('prompt', 'consent');

  return {
    url: `${AUTHORIZE_URL}?${params.toString()}`,
    verifier: pkce.verifier,
    state,
    nonce,
    clientId,
    firstRegistration,
  };
}

/**
 * Exchange an authorization code for tokens.
 *
 * Public client: no secret, no `Authorization` header. PKCE is the whole
 * authentication, which is why the verifier has to be the same one whose
 * challenge went out with the authorization request.
 *
 * @param {object} opts
 * @param {string} opts.code
 * @param {string} opts.verifier
 * @param {string} opts.redirectUri exact URI, port included — a mismatch is rejected
 * @param {string} opts.clientId the value that was sent as `client_id`
 * @param {string} opts.resource
 * @returns {Promise<object>} the token response
 */
async function exchangeCode(opts) {
  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('code', opts.code);
  body.set('redirect_uri', opts.redirectUri);
  body.set('client_id', opts.clientId);
  body.set('code_verifier', opts.verifier);
  body.set('resource', opts.resource);

  const res = await fetchWithTimeout(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  const parsed = await readJson(res);
  if (!res.ok) throw tokenEndpointError(res, parsed);
  if (!parsed || !parsed.access_token) {
    throw new HelperError('CHATGPT_FAILED', 'The token response did not contain an access token.', { status: 502 });
  }
  return parsed;
}

/**
 * Refresh an access token.
 *
 * `scope` is deliberately omitted: the documentation says that omitting it
 * retains the existing grant, and re-sending the scope list is how a plan
 * authorisation quietly narrows itself.
 *
 * The caller must serialise refreshes for one account. Refresh tokens rotate —
 * every successful refresh returns a replacement and invalidates the one that
 * was sent — so two concurrent refreshes with the same token means one of them
 * wins and the other leaves a dead token in its caller's hands. This module
 * cannot enforce that by itself; `siwc-helper.js` does, with a per-account
 * promise chain.
 *
 * @param {object} opts
 * @param {string} opts.clientId the *issued* client ID, never the dynamic one
 * @param {string} opts.refreshToken
 * @param {string} opts.resource
 * @returns {Promise<object>}
 */
async function refreshTokens(opts) {
  const body = new URLSearchParams();
  body.set('grant_type', 'refresh_token');
  body.set('client_id', opts.clientId);
  body.set('refresh_token', opts.refreshToken);
  body.set('resource', opts.resource);

  const res = await fetchWithTimeout(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  const parsed = await readJson(res);
  if (!res.ok) throw tokenEndpointError(res, parsed);
  return parsed;
}

/**
 * A refresh failure that means the token set is dead rather than merely unlucky.
 *
 * The documentation lists these by name and says to clear the unusable tokens
 * and repeat the OAuth flow. Everything else — a timeout, a 5xx — must NOT
 * delete anything, because the refresh token is still the only way back in.
 */
const TERMINAL_REFRESH_CODES = Object.freeze([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
]);

/**
 * @param {Response} res
 * @param {any} body
 * @returns {HelperError}
 */
function tokenEndpointError(res, body) {
  const code = body && typeof body.error === 'string' ? body.error : '';
  const description =
    (body && typeof body.error_description === 'string' && body.error_description) ||
    (body && typeof body.message === 'string' && body.message) ||
    '';

  if (code === 'invalid_client') {
    return new HelperError('CONFIG_INVALID', 'The saved client registration was rejected. Sign in again.', {
      status: 401,
      detail: description,
    });
  }
  if (TERMINAL_REFRESH_CODES.includes(code)) {
    const e = new HelperError('CHATGPT_NOT_SIGNED_IN', 'This sign-in can no longer be renewed. Sign in again.', {
      status: 401,
      detail: `${code}${description ? `: ${description}` : ''}`,
    });
    e.terminal = true;
    return e;
  }
  return new HelperError('CHATGPT_FAILED', description || `The sign-in service returned HTTP ${res.status}.`, {
    status: 502,
    detail: code,
    retryable: res.status >= 500,
  });
}

/**
 * End the renewable session.
 *
 * An empty HTTP 200 is the documented success response, *including* for a token
 * that was already invalid — which is why a failure here does not stop the
 * caller from clearing local credentials. It changes what the user is told, not
 * what happens next.
 *
 * @param {object} opts
 * @param {string} opts.clientId
 * @param {string} opts.refreshToken
 * @returns {Promise<{revoked: boolean, detail: string}>}
 */
async function revoke(opts) {
  let endpoint;
  try {
    const doc = await discover();
    endpoint = doc.revocation_endpoint;
  } catch (err) {
    return { revoked: false, detail: 'Could not reach OpenAI to revoke the session.' };
  }

  const body = new URLSearchParams();
  body.set('token', opts.refreshToken);
  body.set('token_type_hint', 'refresh_token');
  body.set('client_id', opts.clientId);

  try {
    const res = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (res.ok) return { revoked: true, detail: '' };
    return { revoked: false, detail: `Revocation returned HTTP ${res.status}.` };
  } catch (err) {
    return { revoked: false, detail: 'Revocation could not be sent.' };
  }
}

// ---------------------------------------------------------------------------
// ID token validation
// ---------------------------------------------------------------------------

/**
 * Validate an ID token and return its claims.
 *
 * All six checks the documentation asks for, in the order it lists them:
 * signature, issuer, audience, expiry, not-before, and nonce. The audience check
 * is against the client ID the token was issued to — an ID token minted for a
 * different registration is a valid token that says nothing about this user.
 *
 * The alternative — reading `email` straight out of the payload without
 * verifying — is the classic version of this bug, and would let anyone who can
 * reach the loopback callback claim any identity.
 *
 * @param {string} idToken
 * @param {object} expected
 * @param {string} expected.clientId
 * @param {string} [expected.nonce]
 * @param {number} [expected.clockToleranceSec]
 * @returns {Promise<object>} the verified claims
 */
async function validateIdToken(idToken, expected) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) {
    throw new HelperError('CHATGPT_FAILED', 'The identity token was not a well-formed JWT.', { status: 502 });
  }
  const header = decodeJsonPart(parts[0]);
  const claims = decodeJsonPart(parts[1]);

  if (!header || !claims) {
    throw new HelperError('CHATGPT_FAILED', 'The identity token could not be decoded.', { status: 502 });
  }
  if (header.alg !== 'RS256') {
    // Discovery advertises RS256 only. Accepting anything else — `none` above
    // all — would make the signature check meaningless.
    throw new HelperError('CHATGPT_FAILED', `Unsupported token signature algorithm: ${header.alg}`, { status: 502 });
  }

  const key = await findSigningKey(header.kid);
  if (!key) {
    throw new HelperError('CHATGPT_FAILED', 'No matching signing key was published for this token.', { status: 502 });
  }

  const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii');
  const signature = Buffer.from(parts[2], 'base64url');
  let signatureOk = false;
  try {
    signatureOk = cryptoVerify('RSA-SHA256', signingInput, key, signature);
  } catch (err) {
    signatureOk = false;
  }
  if (!signatureOk) {
    throw new HelperError('CHATGPT_FAILED', 'The identity token signature did not verify.', { status: 502 });
  }

  const tolerance = Number.isFinite(expected.clockToleranceSec) ? expected.clockToleranceSec : 120;
  const now = Math.floor(Date.now() / 1000);

  if (claims.iss !== ISSUER) {
    throw new HelperError('CHATGPT_FAILED', `The identity token was issued by ${claims.iss || 'nobody'}.`, {
      status: 502,
    });
  }
  if (!audienceMatches(claims.aud, expected.clientId)) {
    throw new HelperError('CHATGPT_FAILED', 'The identity token was issued to a different client.', { status: 502 });
  }
  if (!Number.isFinite(claims.exp) || claims.exp + tolerance < now) {
    throw new HelperError('CHATGPT_FAILED', 'The identity token has expired.', { status: 502 });
  }
  if (Number.isFinite(claims.nbf) && claims.nbf - tolerance > now) {
    throw new HelperError('CHATGPT_FAILED', 'The identity token is not valid yet.', { status: 502 });
  }
  if (expected.nonce && claims.nonce !== expected.nonce) {
    // The nonce is what stops a token captured from a different sign-in attempt
    // being replayed into this one.
    throw new HelperError('CHATGPT_FAILED', 'The identity token did not match this sign-in attempt.', { status: 502 });
  }

  return claims;
}

/**
 * @param {string|string[]} aud
 * @param {string} clientId
 * @returns {boolean}
 */
function audienceMatches(aud, clientId) {
  if (Array.isArray(aud)) return aud.includes(clientId);
  return aud === clientId;
}

/**
 * Find the JWKS entry that signed a token, and turn it into a KeyObject.
 *
 * `crypto.createPublicKey({ format: 'jwk' })` does the JWK → key conversion, so
 * there is no hand-rolled ASN.1 in this file.
 *
 * @param {string} kid
 * @returns {Promise<import('node:crypto').KeyObject|null>}
 */
async function findSigningKey(kid) {
  const keys = await loadJwks();
  const jwk = keys.find((k) => !kid || k.kid === kid) || null;
  if (!jwk) return null;
  try {
    return createPublicKey({ key: jwk, format: 'jwk' });
  } catch (err) {
    return null;
  }
}

/** @returns {Promise<Array<object>>} */
async function loadJwks() {
  const now = Date.now();
  if (jwksCache && now - jwksCache.at < DISCOVERY_TTL_MS) return jwksCache.keys;

  const doc = await discover();
  const res = await fetchWithTimeout(doc.jwks_uri, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    throw new HelperError('CONFIG_INVALID', `Could not read OpenAI's signing keys (HTTP ${res.status}).`, {
      status: 502,
      retryable: true,
    });
  }
  const body = await res.json();
  const keys = body && Array.isArray(body.keys) ? body.keys : [];
  if (!keys.length) {
    throw new HelperError('CONFIG_INVALID', "OpenAI's signing key list was empty.", { status: 502, retryable: true });
  }
  jwksCache = { at: now, keys };
  return keys;
}

/** Test seam: forget everything cached from the network. */
function resetCaches() {
  discoveryCache = null;
  jwksCache = null;
}

// ---------------------------------------------------------------------------
// Callback parsing
// ---------------------------------------------------------------------------

/**
 * Pull the issued client ID out of the registration callback.
 *
 * This is the one place in the flow where the documentation names a value but
 * not the parameter that carries it: it says a new-registration callback
 * "returns an issued ID such as `oaiapp_...`" without stating the key. Rather
 * than guess one parameter name and break on the real one, every value in the
 * callback is scanned for the documented `oaiapp_` prefix — and the parameter
 * *names* that arrived are recorded, so the first real sign-in tells us which
 * one it actually was.
 *
 * @param {URLSearchParams} params
 * @returns {{issuedClientId: string, parameterNames: string[]}}
 */
function parseRegistrationCallback(params) {
  const parameterNames = [...params.keys()].sort();
  let issuedClientId = '';
  const explicit = params.get('client_id');
  if (explicit && explicit !== DYNAMIC_CLIENT_ID) issuedClientId = explicit;
  if (!issuedClientId) {
    for (const value of params.values()) {
      if (/^oaiapp_/.test(value)) {
        issuedClientId = value;
        break;
      }
    }
  }
  return { issuedClientId, parameterNames };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * fetch with a hard timeout.
 *
 * Node's `AbortSignal.timeout` rejects with a `TimeoutError`, which callers
 * would otherwise have to recognise; converted here into the helper's own
 * vocabulary so every network failure has one shape.
 *
 * @param {string} url
 * @param {RequestInit} init
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, init = {}) {
  try {
    return await fetch(url, Object.assign({}, init, { signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) }));
  } catch (err) {
    const name = err && err.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new HelperError('CHATGPT_UNAVAILABLE', 'OpenAI did not answer in time.', {
        status: 503,
        retryable: true,
        detail: 'timeout',
      });
    }
    throw new HelperError('CHATGPT_UNAVAILABLE', 'Could not reach OpenAI from this computer.', {
      status: 503,
      retryable: true,
      detail: (err && err.message) || 'network error',
    });
  }
}

/**
 * @param {Response} res
 * @returns {Promise<any>} parsed JSON, or null when the body was not JSON
 */
async function readJson(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    return { detail: text.slice(0, 400) };
  }
}

/** @param {string} part @returns {object|null} */
function decodeJsonPart(part) {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch (err) {
    return null;
  }
}

/**
 * Shorten a token for a status line. Never prints more than a recognisable stub,
 * and never the payload.
 * @param {string} token
 * @returns {string}
 */
function tokenFingerprint(token) {
  const s = String(token || '');
  if (!s) return '(none)';
  return `${s.slice(0, 4)}…${s.slice(-2)} (${s.length} chars)`;
}

/**
 * The scopes that were actually granted, out of a token response.
 *
 * The documentation says granted scopes come back space-separated and that
 * `chatgpt.tokens.use.direct` must be checked before inference, because "a valid
 * ID token alone does not authorize ChatGPT plan usage".
 *
 * @param {object} tokenResponse
 * @returns {string[]}
 */
function grantedScopes(tokenResponse) {
  const raw = tokenResponse && typeof tokenResponse.scope === 'string' ? tokenResponse.scope : '';
  return raw.split(/\s+/).filter(Boolean);
}

export {
  ISSUER,
  DISCOVERY_URL,
  AUTHORIZE_URL,
  TOKEN_URL,
  DYNAMIC_CLIENT_ID,
  TERMINAL_REFRESH_CODES,
  discover,
  buildAuthorizeUrl,
  exchangeCode,
  refreshTokens,
  revoke,
  validateIdToken,
  parseRegistrationCallback,
  grantedScopes,
  tokenFingerprint,
  audienceMatches,
  planScopes,
  resetCaches,
  readJson,
  fetchWithTimeout,
};
