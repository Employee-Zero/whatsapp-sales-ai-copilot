/**
 * The handful of shared values the helper needs.
 *
 * These are duplicated from `src/shared/constants.js` on purpose, and the
 * duplication is checked rather than trusted: `tools/test-helper.js` imports
 * both files and fails if the strings differ. Sharing one file between a browser
 * ES module and a Node process would make the helper un-runnable on its own,
 * which is the whole point of it being a separate program — so the copy stays,
 * and the test is what keeps it honest.
 *
 * The scope string and the resource value are the two that must never be guessed
 * at: they come from the published ChatGPT-plan-usage documentation, and the
 * scope set is deliberately *not* the one in the OIDC discovery document, which
 * lists only the identity scopes.
 */

/** Identity plus ChatGPT plan usage. */
const CHATGPT_SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';

/** The resource every token in this flow is scoped to. */
const CHATGPT_RESOURCE = 'https://api.openai.com/v1';

/** The one scope that actually authorises plan usage. */
const CHATGPT_PLAN_SCOPE = 'chatgpt.tokens.use.direct';

/**
 * Every failure the local API can report, and the string it goes out as.
 *
 * The helper names these states in its own code (`CHATGPT_USAGE_LIMIT`) because
 * that is what reads well at the throw site; the wire value is the extension's
 * `ERR` constant (`CHATGPT_USAGE_LIMIT_EXCEEDED`) because that is what
 * `describeError` switches on. `HelperError.toBody()` does the translation, so
 * this table is the only place the two vocabularies meet.
 *
 * Getting this wrong is not a crash. It is worse: a code the extension does not
 * recognise is replaced by the generic failure, so "your plan allowance is used
 * up — it resets on its own" arrives as "the request failed". That is why
 * `tools/test-helper.js` compares this table against `ERR` in
 * `src/shared/constants.js` in both directions, and why it is a table rather
 * than a bare list of strings.
 */
const CODES = Object.freeze({
  HELPER_UNREACHABLE: 'CHATGPT_HELPER_UNREACHABLE',
  CHATGPT_NOT_SIGNED_IN: 'CHATGPT_NOT_SIGNED_IN',
  CHATGPT_NO_PLAN_SCOPE: 'CHATGPT_PLAN_NOT_AUTHORIZED',
  CHATGPT_NOT_ELIGIBLE: 'CHATGPT_NOT_ELIGIBLE',
  CHATGPT_USAGE_LIMIT: 'CHATGPT_USAGE_LIMIT_EXCEEDED',
  CHATGPT_UNAVAILABLE: 'CHATGPT_USAGE_UNAVAILABLE',
  CHATGPT_FAILED: 'CHATGPT_REQUEST_FAILED',
  /**
   * The helper is running but cannot read OpenAI's own sign-in configuration —
   * an outage on their side, or a machine that cannot reach `auth.openai.com`.
   * Distinct from every code above because the fix is different: nothing about
   * the user's account is wrong.
   */
  CONFIG_INVALID: 'CONFIG_INVALID',
});

/** The extension's wire codes, for the cross-check in `tools/test-helper.js`. */
const HELPER_ERROR_CODES = Object.freeze(Object.values(CODES));

/** The default loopback port. Matches CHATGPT_HELPER_DEFAULT_URL in the extension. */
const DEFAULT_PORT = 8788;

/** The default helper address, as the extension spells it. */
const DEFAULT_HELPER_URL = `http://127.0.0.1:${DEFAULT_PORT}`;

export {
  CHATGPT_SCOPES,
  CHATGPT_RESOURCE,
  CHATGPT_PLAN_SCOPE,
  CODES,
  HELPER_ERROR_CODES,
  DEFAULT_PORT,
  DEFAULT_HELPER_URL,
};
