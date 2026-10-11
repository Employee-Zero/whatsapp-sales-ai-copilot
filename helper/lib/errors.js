/**
 * The helper's error vocabulary.
 *
 * Every failure the extension can be told about gets a stable `code` here, and
 * the extension maps those codes to sentences. The helper never sends a raw
 * provider message as the *only* thing the user sees — but it does forward the
 * provider's own text alongside the code, because "the plan allowance is used
 * up" and "this workspace is not permitted in your region" are both a 403 and
 * the user needs to know which one they got.
 *
 * The codes used *in this file* are the helper's own names; the strings that go
 * out over the wire are the extension's `ERR` values, translated in exactly one
 * place — `HelperError.toBody()` — from the `CODES` table in `constants.js`.
 * Splitting it that way means a name can be used freely at a throw site without
 * every one of them having to spell `CHATGPT_USAGE_LIMIT_EXCEEDED` correctly.
 * `tools/test-helper.js` compares the table against `src/shared/constants.js` in
 * both directions, so the two cannot drift silently.
 */

import { CODES } from './constants.js';

/** @typedef {'HELPER_UNREACHABLE'|'CHATGPT_NOT_SIGNED_IN'|'CHATGPT_NO_PLAN_SCOPE'|'CHATGPT_NOT_ELIGIBLE'|'CHATGPT_USAGE_LIMIT'|'CHATGPT_UNAVAILABLE'|'CHATGPT_FAILED'|'CONFIG_INVALID'} HelperCode */

/** A failure with a stable code and an HTTP status for the local response. */
class HelperError extends Error {
  /**
   * @param {string} code
   * @param {string} message user-facing sentence
   * @param {{status?: number, detail?: string, requestId?: string, retryable?: boolean}} [opts]
   */
  constructor(code, message, opts = {}) {
    super(message);
    this.name = 'HelperError';
    this.code = code;
    this.status = opts.status || 500;
    /** The provider's own wording, kept for support — never a token. */
    this.detail = opts.detail || '';
    this.requestId = opts.requestId || '';
    this.retryable = !!opts.retryable;
    /** True when reply text had already started streaming; the request must not be repeated elsewhere. */
    this.partialOutput = !!opts.partialOutput;
  }

  /** The JSON body the local API returns for this failure. */
  toBody() {
    return {
      ok: false,
      // The one translation between the helper's vocabulary and the
      // extension's. An unknown name is passed through unchanged rather than
      // mapped to a generic failure, so a typo is visible in the response
      // instead of being hidden behind a plausible-looking code.
      code: CODES[this.code] || this.code,
      message: this.message,
      detail: this.detail,
      requestId: this.requestId,
      retryable: this.retryable,
      partialOutput: this.partialOutput,
    };
  }
}

/**
 * Provider error code → this helper's code.
 *
 * The left-hand column is transcribed from the published "Errors and recovery"
 * table for the ChatGPT-plan flow. Anything not listed falls through to a
 * generic failure that still carries the provider's own code and message, so an
 * unrecognised code is diagnosable rather than swallowed.
 */
const PROVIDER_CODE_MAP = Object.freeze({
  subscription_sharing_user_not_eligible: 'CHATGPT_NOT_ELIGIBLE',
  subscription_sharing_usage_limit_exceeded: 'CHATGPT_USAGE_LIMIT',
  subscription_sharing_usage_unavailable: 'CHATGPT_UNAVAILABLE',
  subscription_sharing_user_unavailable: 'CHATGPT_UNAVAILABLE',
  subscription_sharing_unsupported_capability: 'CHATGPT_FAILED',
  subscription_sharing_route_not_supported: 'CHATGPT_FAILED',
  subscription_sharing_invalid_user: 'CHATGPT_NOT_SIGNED_IN',
  chatpass_v2_scope_not_authorized: 'CHATGPT_NO_PLAN_SCOPE',
  chatpass_v2_invalid_authorization_context: 'CHATGPT_NO_PLAN_SCOPE',
});

/**
 * Turn a provider failure into a `HelperError`.
 *
 * Two shapes arrive from `api.openai.com` and both are handled:
 *
 *   1. The documented structured error — `{ error: { code, message, param } }`.
 *   2. A bare `{ detail: "..." }`, which the documentation says direct-route
 *      admission may return *before* a Responses request has begun. That body is
 *      diagnostic text, not a machine-readable code, so the status decides.
 *
 * @param {number} status
 * @param {any} body parsed response body, or null when it was not JSON
 * @param {string} [requestId]
 * @returns {HelperError}
 */
function fromProvider(status, body, requestId = '') {
  const err = body && typeof body === 'object' && body.error && typeof body.error === 'object' ? body.error : null;
  const providerCode = err && typeof err.code === 'string' ? err.code : '';
  const providerMessage =
    (err && typeof err.message === 'string' && err.message) ||
    (body && typeof body === 'object' && typeof body.detail === 'string' && body.detail) ||
    '';
  const param = err && typeof err.param === 'string' ? err.param : '';

  const mapped = PROVIDER_CODE_MAP[providerCode] || '';

  if (mapped) {
    return new HelperError(mapped, describe(mapped, providerMessage, param), {
      status: statusFor(mapped),
      detail: providerCode + (param ? ` (param: ${param})` : ''),
      requestId,
      retryable: mapped === 'CHATGPT_UNAVAILABLE',
    });
  }

  // No code we recognise: the HTTP status is the only signal left.
  if (status === 401) {
    return new HelperError(
      'CHATGPT_NOT_SIGNED_IN',
      'OpenAI did not accept the signed-in session. Sign in with ChatGPT again.',
      { status: 401, detail: providerMessage, requestId },
    );
  }
  if (status === 403) {
    return new HelperError(
      'CHATGPT_NOT_ELIGIBLE',
      'OpenAI refused this request for this account or region. Your ChatGPT plan cannot be used here.',
      { status: 403, detail: providerMessage, requestId },
    );
  }
  if (status === 429) {
    return new HelperError(
      'CHATGPT_USAGE_LIMIT',
      'The ChatGPT plan allowance for this account is used up. Check ChatGPT → Settings → Usage.',
      { status: 429, detail: providerMessage, requestId },
    );
  }
  if (status === 503) {
    return new HelperError(
      'CHATGPT_UNAVAILABLE',
      'ChatGPT plan usage is temporarily unavailable. Your sign-in is still good — try again shortly.',
      { status: 503, detail: providerMessage, requestId, retryable: true },
    );
  }
  if (status === 400) {
    return new HelperError('CHATGPT_FAILED', 'OpenAI rejected the request as unsupported for this flow.', {
      status: 400,
      detail: providerMessage,
      requestId,
    });
  }
  return new HelperError('CHATGPT_FAILED', providerMessage || `OpenAI returned HTTP ${status}.`, {
    status: status || 502,
    detail: providerMessage,
    requestId,
  });
}

/** @param {string} code @param {string} providerMessage @param {string} param */
function describe(code, providerMessage, param) {
  const tail = providerMessage ? ` (${providerMessage})` : '';
  switch (code) {
    case 'CHATGPT_NOT_ELIGIBLE':
      return `This ChatGPT account cannot use its plan in an app like this one${tail}. Use your own API key instead.`;
    case 'CHATGPT_USAGE_LIMIT':
      return `The ChatGPT plan allowance for this account is used up${tail}. Check ChatGPT → Settings → Usage.`;
    case 'CHATGPT_UNAVAILABLE':
      return `ChatGPT plan usage could not be confirmed right now${tail}. Try again shortly.`;
    case 'CHATGPT_NOT_SIGNED_IN':
      return `The signed-in ChatGPT session is no longer valid${tail}. Sign in again.`;
    case 'CHATGPT_NO_PLAN_SCOPE':
      return `This sign-in did not include permission to use your ChatGPT plan${tail}. Sign in again and allow plan usage.`;
    case 'CHATGPT_FAILED':
    default:
      return `OpenAI could not complete this request${param ? ` (${param})` : ''}${tail}.`;
  }
}

/** @param {string} code @returns {number} */
function statusFor(code) {
  switch (code) {
    case 'CHATGPT_NOT_SIGNED_IN':
      return 401;
    case 'CHATGPT_NOT_ELIGIBLE':
    case 'CHATGPT_NO_PLAN_SCOPE':
      return 403;
    case 'CHATGPT_USAGE_LIMIT':
      return 429;
    case 'CHATGPT_UNAVAILABLE':
      return 503;
    default:
      return 502;
  }
}

export { HelperError, PROVIDER_CODE_MAP, fromProvider };
