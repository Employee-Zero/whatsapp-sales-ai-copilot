/**
 * Shared constants — loaded by the content script, the service worker and the
 * side panel. Keep this file dependency-free (no import/export statements) so
 * it can be injected as a classic content script AND imported as an ES module
 * from extension pages.
 */

/** WhatsApp Web origin the content script runs on. */
const WHATSAPP_ORIGIN = 'https://web.whatsapp.com';

/** Runtime message types exchanged between side panel / worker / content script. */
const MSG = Object.freeze({
  // content script (ping / diagnostics)
  PING: 'WA_FOLLOWUP_PING',
  // content script (chat reading)
  GET_CHAT_CONTEXT: 'WA_FOLLOWUP_GET_CHAT_CONTEXT',
  // content script (contact info panel: reveal + read the real phone number)
  REVEAL_PHONE: 'WA_FOLLOWUP_REVEAL_PHONE',
  // content script (composer write + send button click)
  SET_COMPOSER_TEXT: 'WA_FOLLOWUP_SET_COMPOSER_TEXT',
  CLEAR_COMPOSER: 'WA_FOLLOWUP_CLEAR_COMPOSER',
  // service worker → content script bridge used by the verification harness
  DOM_PROBE: 'WA_FOLLOWUP_DOM_PROBE',
  CLICK_SEND: 'WA_FOLLOWUP_CLICK_SEND',
  // service worker orchestration
  GENERATE_REPLY: 'WA_FOLLOWUP_GENERATE_REPLY',
  FOLLOWUP_AND_SEND: 'WA_FOLLOWUP_FOLLOWUP_AND_SEND',
  // panel → worker: send a reviewed draft (worker relays it to the content
  // script's guarded SEND_MESSAGE handler)
  SEND_MESSAGE: 'WA_FOLLOWUP_SEND_MESSAGE',
  // side panel — AI settings
  PANEL_HELLO: 'WA_FOLLOWUP_PANEL_HELLO',
  GET_AI_CONFIG: 'WA_FOLLOWUP_GET_AI_CONFIG',
  SET_AI_CONFIG: 'WA_FOLLOWUP_SET_AI_CONFIG',
  CLEAR_API_KEY: 'WA_FOLLOWUP_CLEAR_API_KEY',
  TEST_CONNECTION: 'WA_FOLLOWUP_TEST_CONNECTION',
  // side panel → worker: the ChatGPT-subscription connection, which lives in the
  // local helper rather than in this extension. See CHATGPT_HELPER_* below.
  CHATGPT_STATUS: 'WA_FOLLOWUP_CHATGPT_STATUS',
  CHATGPT_SIGN_IN: 'WA_FOLLOWUP_CHATGPT_SIGN_IN',
  CHATGPT_SIGN_OUT: 'WA_FOLLOWUP_CHATGPT_SIGN_OUT',
  CHATGPT_MODELS: 'WA_FOLLOWUP_CHATGPT_MODELS',
  CHATGPT_TEST_REQUEST: 'WA_FOLLOWUP_CHATGPT_TEST_REQUEST',
});

/** chrome.storage.local keys. */
const STORAGE_KEYS = Object.freeze({
  AI_CONFIG: 'aiConfig',
  AI_CONFIG_SEEDED: 'aiConfigSeeded',
  /** Per-chat accumulated message history — see `mergeMessageWindows`. */
  MESSAGE_STORE: 'messageStore',
  /** Per-chat unsent drafts, so switching chats never carries one across. */
  DRAFTS: 'drafts',
  /** Per-chat extra instructions, applied on top of the global system prompt. */
  INSTRUCTIONS: 'instructions',
  /**
   * First-run state: `{ connected: true, dismissed: true }`.
   *
   * `connected` is set the first time a complete AI configuration is saved, and
   * is what stops the welcome screen coming back. `dismissed` records that the
   * user has read the short "what next" list.
   */
  ONBOARDING: 'onboarding',
});

/**
 * The system prompt the extension ships with.
 *
 * Editable from Settings — the user rewrites this often and must never have to
 * touch source. `DEFAULT_AI_CONFIG.systemPrompt` holds a copy of this string,
 * and "Reset to default" restores it.
 *
 * The "do not invent" list is the part that matters most: a sales assistant that
 * hallucinates a price is worse than no assistant at all.
 *
 * Note what is deliberately NOT here: reply length. That is a separate control
 * (see REPLY_LENGTH_SPECS) appended to the user message, so it can be changed
 * per message without editing this prompt.
 */
const DEFAULT_SYSTEM_PROMPT = `You are an AI sales assistant helping a B2B salesperson reply to customers on WhatsApp.

Use only the conversation context. Never invent prices, product details, specifications, certifications, stock availability, delivery timelines, discounts, or payment terms.

Understand the customer's latest intent and write the most natural next reply.

Rules:
- concise, natural, and conversational
- use the customer's first name in a greeting when clearly known; otherwise omit it
- no unnecessary greeting in an active conversation
- reply in the customer's language when clear
- prefer specific, relevant follow-ups over generic check-ins
- when useful, end with one easy question or CTA that moves the conversation forward
- ask for at most one concrete next step, decision, detail, or feedback
- no pressure or overly salesy language
- output only the message to send`;

/**
 * The prompt this project shipped before it was published.
 *
 * Kept only so the v2 → v3 migration can recognise it: a stored prompt that is
 * byte-for-byte this string was never customised by anyone, so replacing it with
 * the current default loses nothing. Anything the user actually edited is left
 * alone.
 */
const LEGACY_SYSTEM_PROMPT_VENDING = `You are helping a vending machine salesperson reply to an existing WhatsApp customer.

Use only information contained in the conversation.
Do not invent:
- prices
- specifications
- certifications
- delivery promises
- stock
- discounts
- payment terms

Understand the customer's latest intent and conversation context.

Generate the most natural next WhatsApp message.

Rules:
- natural and conversational, the way a person types on WhatsApp
- no unnecessary greeting if the conversation is already active
- respond in the customer's language when it is clear
- ask at most one useful next-step question, and only when it helps
- do not explain your reasoning
- output only the message that should be sent`;

/**
 * Reply length — the three levels offered above the buttons.
 *
 * These are NOT sentence counts. Sentence counts do not survive translation
 * (a "one sentence" rule produces a paragraph in Chinese and a fragment in
 * Portuguese), and a hard one-sentence ceiling makes the model drop the actual
 * ask — the question is usually the whole point of a B2B follow-up. Each level
 * is therefore defined by its *purpose* plus a word ceiling, and the model is
 * explicitly allowed to keep one question.
 *
 * `outputTokens` is the answer budget that level needs; it feeds the automatic
 * max_tokens (see `resolveMaxTokens`). It is a ceiling, not a target — being
 * generous here costs nothing and prevents the truncated-reply failure.
 */
const REPLY_LENGTH = Object.freeze({
  SHORT: 'short',
  MEDIUM: 'medium',
  LONG: 'long',
});

const REPLY_LENGTH_SPECS = Object.freeze({
  short: {
    label: 'Short',
    hint: 'One line. No greeting, no pleasantries.',
    words: 20,
    outputTokens: 500,
    guidance:
      'LENGTH: SHORT. One line, at most about 20 words. No greeting, no pleasantries, no summary. If a question is the point of the message, keep exactly one short question.',
  },
  medium: {
    label: 'Medium',
    hint: 'One to three short sentences.',
    words: 60,
    outputTokens: 1000,
    guidance:
      'LENGTH: MEDIUM. One to three short sentences, at most about 60 words. Natural WhatsApp tone.',
  },
  long: {
    label: 'Long',
    hint: 'Up to five sentences. Line breaks allowed.',
    words: 120,
    outputTokens: 2000,
    guidance:
      'LENGTH: LONG. Up to five sentences, at most about 120 words. Line breaks are allowed. Still WhatsApp, not email: no signature, and no bullet lists unless the customer asked for details.',
  },
});

/**
 * Thinking depth — how much reasoning the model may do before answering.
 *
 * Only meaningful for a reasoning model; `auto` is the default because it omits
 * the parameter entirely, so a non-reasoning model never sees a field it might
 * reject with HTTP 400.
 *
 * `reserveTokens` is added to the answer budget in the automatic max_tokens,
 * because on a reasoning model the thinking tokens are billed against
 * max_tokens and will otherwise consume the entire allowance — which is exactly
 * how "The AI returned an empty reply" happens.
 *
 * Measured against a reasoning model (2026-09-25): `disabled` → 0 reasoning
 * tokens and 1436 ms; `auto` → ~192 reasoning tokens and 4694 ms. A
 * `budget_tokens` value is accepted but does not tightly bound the real
 * reasoning length (32 → 291, 256 → 452, 1024 → 399), so treat it as a hint.
 */
const THINKING_MODE = Object.freeze({
  OFF: 'off',
  AUTO: 'auto',
  LOW: 'low',
  HIGH: 'high',
});

const THINKING_SPECS = Object.freeze({
  off: { label: 'Off', hint: 'Fastest. No reasoning.', type: 'disabled', budgetTokens: 0, reserveTokens: 0 },
  auto: { label: 'Auto', hint: 'Model decides.', type: null, budgetTokens: 0, reserveTokens: 2048 },
  low: { label: 'Low', hint: 'A little reasoning.', type: 'enabled', budgetTokens: 512, reserveTokens: 512 },
  high: { label: 'High', hint: 'Reason carefully. Slower.', type: 'enabled', budgetTokens: 4096, reserveTokens: 4096 },
});

/**
 * How much of the accumulated conversation to hand the model.
 * `0` means every message we have, which is the default: the user's rule is
 * "everything the page shows must be analysed", and any real limit belongs on
 * max_tokens, not on how much context the model is allowed to read.
 */
const CONTEXT_MESSAGE_CHOICES = Object.freeze([0, 20, 50, 100]);

/** Accumulated-history limits. Bounds storage growth, not what is analysed. */
const MESSAGE_STORE_LIMITS = Object.freeze({
  MAX_MESSAGES_PER_CHAT: 600,
  MAX_CHARS_PER_CHAT: 400000,
  MAX_CHATS: 40,
  MAX_CHARS_PER_MESSAGE: 4000,
});

/** Unsent-draft limits for the per-chat draft store. */
const DRAFT_LIMITS = Object.freeze({
  MAX_CHATS: 40,
  MAX_CHARS: 6000,
});

/**
 * Per-chat extra instructions — "ask how the trial installation went", that kind
 * of thing. Short by nature: this is a nudge for the model, not a document.
 */
const INSTRUCTION_LIMITS = Object.freeze({
  MAX_CHATS: 40,
  MAX_CHARS: 1000,
});

/**
 * Bumped whenever a value already sitting in storage needs reinterpreting.
 * `migrateStoredConfig` in utils.js is what acts on it.
 *
 * Still 3 after `connectionMode` was added. That field is *additive*: an install
 * that has never heard of it must keep behaving exactly as it did, and it does —
 * `connectionModeOf()` below reads anything that is not the ChatGPT value as
 * "API key", which is what the v3 build did unconditionally. Nothing already in
 * storage needs reinterpreting, so bumping the version would be a lie that
 * `tools/test-chatgpt.js` would then have to work around.
 */
const CONFIG_VERSION = 3;

/**
 * How the extension reaches a model.
 *
 * Two methods, one at a time. They are stored side by side in the same config
 * record — switching method must never discard the other one's settings, because
 * "try the subscription, keep my key" and "the subscription lapsed, go back to
 * my key" are both normal things for a user to do.
 *
 *   apiKey  → any OpenAI-compatible `POST /chat/completions`, from the service
 *             worker, with the user's own key. Unchanged since v0.1.0.
 *   chatgpt → the user's own ChatGPT plan, over the Responses API, through the
 *             local helper. The extension holds NO token for this: OpenAI's
 *             Sign-in-with-ChatGPT documentation requires the credential to live
 *             in a protected local file, and the browser is not that. The helper
 *             is the credential holder and this extension is only a client of it.
 */
const CONNECTION_MODE = Object.freeze({
  API_KEY: 'apiKey',
  CHATGPT: 'chatgpt',
});

/**
 * Presentation for the two methods. The order here is the order they are offered
 * in: the subscription first, the API key second, because the subscription is
 * the one that needs no separate account with a provider.
 */
const CONNECTION_MODE_SPECS = Object.freeze({
  chatgpt: {
    label: 'ChatGPT',
    short: 'ChatGPT',
    hint: 'Uses an eligible ChatGPT subscription. Availability depends on your account.',
  },
  apiKey: {
    label: 'API Key',
    short: 'API key',
    hint: 'Any OpenAI-compatible provider.',
  },
});

/**
 * Local helper that owns the ChatGPT-plan credential.
 *
 * Loopback on `127.0.0.1`, never `localhost`. That is not a style choice: the
 * documented OAuth contract for this flow accepts a loopback callback on
 * `127.0.0.1` and states that `localhost` does not match it. The helper binds
 * `127.0.0.1`, so one address serves both the callback and the extension's API
 * calls — see `docs/ARCHITECTURE.md`.
 */
const CHATGPT_HELPER_DEFAULT_URL = 'http://127.0.0.1:8788';

/** Where ChatGPT Connector (the macOS installer) is published. */
const CONNECTOR_RELEASE_URL = 'https://github.com/Employee-Zero/whatsapp-sales-ai-copilot/releases/tag/v0.1.2';
const CONNECTOR_DOWNLOAD_URL = 'https://github.com/Employee-Zero/whatsapp-sales-ai-copilot/releases/download/v0.1.2/ChatGPT-Connector-for-Sales-AI-Copilot-macOS-arm64.pkg';

/** Helper endpoints, relative to its base URL. */
const CHATGPT_HELPER_PATHS = Object.freeze({
  HEALTH: '/health',
  AUTH_START: '/auth/start',
  AUTH_STATUS: '/auth/status',
  AUTH_SIGN_OUT: '/auth/sign-out',
  MODELS: '/models',
  GENERATE: '/generate',
  TEST: '/test',
});

/**
 * The exact scope set this flow asks for, and the resource it is scoped to.
 *
 * `openid profile email` is the identity half. The rest is ChatGPT plan usage:
 * `offline_access` is what returns a refresh token, `resource.invoke` and
 * `chatgpt.tokens.use.direct` are what authorise the subscription itself.
 *
 * Note where these come from: the published Sign-in-with-ChatGPT pages, not from
 * the OIDC discovery document. That document lists only the four identity scopes
 * — reading the scope list out of discovery would silently drop plan access.
 *
 * `chatgpt.tokens.use.direct` is checked before any inference, because the
 * documentation is explicit that a valid ID token alone does not authorise plan
 * usage: a user who declines the plan scopes still signs in successfully, and
 * the app has to notice.
 */
const CHATGPT_SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const CHATGPT_RESOURCE = 'https://api.openai.com/v1';
const CHATGPT_PLAN_SCOPE = 'chatgpt.tokens.use.direct';

/**
 * Default AI configuration.
 *
 * Seeded into chrome.storage.local on install; every AI call reads from
 * storage, never from this constant, so changing Settings takes effect
 * instantly and no code edit is ever needed.
 *
 * Every connection field is deliberately EMPTY, and the README asks the user to
 * fill them in. There is no default provider, no default model and no default
 * key: shipping one would mean publishing somebody's endpoint and having every
 * install spend somebody's credits. It would also quietly imply that the
 * extension works out of the box, which it does not — it needs an
 * OpenAI-compatible provider of the user's own choosing.
 *
 * `hasRequiredConfig()` below is what turns "these are blank" into a first-run
 * screen instead of a failed request.
 */
const DEFAULT_AI_CONFIG = Object.freeze({
  /** Bumped when a stored value needs reinterpreting — see `migrateConfig`. */
  configVersion: CONFIG_VERSION,
  /** apiKey | chatgpt — see CONNECTION_MODE. Existing installs default to apiKey. */
  connectionMode: CONNECTION_MODE.API_KEY,
  primaryBaseUrl: '',
  fallbackBaseUrl: '',
  apiKey: '',
  model: '',
  /**
   * The model used in ChatGPT mode, kept separate from `model` on purpose.
   *
   * The two methods have different catalogues: `model` is whatever the user's
   * provider calls a model, `chatgptModel` is a `slug` from their ChatGPT
   * account's own list. One shared field would mean switching method silently
   * replaced the other one's answer.
   */
  chatgptModel: '',
  /** Where the local helper listens. See CHATGPT_HELPER_DEFAULT_URL. */
  helperUrl: CHATGPT_HELPER_DEFAULT_URL,
  temperature: 0.4,
  /**
   * 0 = derive the ceiling from reply length + thinking depth.
   *
   * It used to be a flat 300, which is smaller than a reasoning model's thinking
   * budget on its own: every request came back with `finish_reason: "length"`,
   * zero content and the message "The AI returned an empty reply". Auto is the
   * right default because the two things that decide the budget are already
   * settings of their own.
   */
  maxTokens: 0,
  replyLength: REPLY_LENGTH.MEDIUM,
  thinking: THINKING_MODE.AUTO,
  contextMessages: 0,
  /** Hard safety cap on the serialized transcript, in characters. */
  maxChars: 20000,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  timeoutMs: 30000,
});

/**
 * The connection fields that must be filled before any request can be made.
 *
 * Grouped here rather than inline so the panel, the worker and the tests all
 * answer "is this configured?" the same way. Order is the order the first-run
 * screen asks for them.
 */
const REQUIRED_AI_FIELDS = Object.freeze(['primaryBaseUrl', 'apiKey', 'model']);

/**
 * The same question for ChatGPT mode.
 *
 * Only the model. Whether the helper is running and whether an account is signed
 * in are *live* facts, not stored ones, so they cannot be answered by looking at
 * the config — the worker checks them against the helper at the moment of the
 * request, and the panel shows them as connection status. Keeping them out of
 * here is what lets `missingAiFields` stay a pure function that a test can call.
 */
const REQUIRED_CHATGPT_FIELDS = Object.freeze(['chatgptModel']);

/** Human labels for those fields, for messages that name what is missing. */
const AI_FIELD_LABELS = Object.freeze({
  primaryBaseUrl: 'API Base URL',
  fallbackBaseUrl: 'Fallback Base URL',
  apiKey: 'API Key',
  model: 'Model ID',
  chatgptModel: 'Model',
  helperUrl: 'Helper address',
});

/**
 * Which connection method a config is using.
 *
 * Anything that is not exactly the ChatGPT value reads as API key. That is the
 * behaviour every build before this one had, so an upgrade cannot change how an
 * existing install talks to its provider — including a config written by a
 * newer build that this one does not understand.
 *
 * @param {object} cfg
 * @returns {string} one of CONNECTION_MODE
 */
function connectionModeOf(cfg) {
  const mode = cfg && cfg.connectionMode;
  return mode === CONNECTION_MODE.CHATGPT ? CONNECTION_MODE.CHATGPT : CONNECTION_MODE.API_KEY;
}

/**
 * Which required fields are still blank, for the method in use.
 *
 * @param {object} cfg
 * @returns {string[]} field names, empty when the config is usable
 */
function missingAiFields(cfg) {
  const c = cfg || {};
  const fields = connectionModeOf(c) === CONNECTION_MODE.CHATGPT ? REQUIRED_CHATGPT_FIELDS : REQUIRED_AI_FIELDS;
  return fields.filter((key) => !String(c[key] == null ? '' : c[key]).trim());
}

/**
 * True when the config has everything an AI request needs.
 * @param {object} cfg
 * @returns {boolean}
 */
function hasRequiredConfig(cfg) {
  return missingAiFields(cfg).length === 0;
}


/**
 * Fields the Settings form owns. Used by mergeConfig so stray storage keys can
 * never inject unexpected fields into an AI request.
 */
const AI_CONFIG_STRING_KEYS = Object.freeze([
  'connectionMode',
  'primaryBaseUrl',
  'fallbackBaseUrl',
  'apiKey',
  'model',
  'chatgptModel',
  'helperUrl',
  'replyLength',
  'thinking',
  'systemPrompt',
]);

/** Numeric AI config fields, with their allowed ranges. */
const AI_CONFIG_NUMBER_RANGES = Object.freeze({
  temperature: { min: 0, max: 2 },
  /** 0 is meaningful: "derive it from reply length + thinking depth". */
  maxTokens: { min: 0, max: 8192 },
  contextMessages: { min: 0, max: 1000 },
  maxChars: { min: 1000, max: 100000 },
  timeoutMs: { min: 5000, max: 120000 },
});

/**
 * Failure classes that justify retrying against the fallback host.
 *
 * Only genuine connectivity problems qualify. HTTP-level failures (401, 403,
 * 404, 400, model_not_found, …) are configuration errors and must NOT trigger a
 * fallback — retrying them on a second host just hides the real problem and
 * doubles latency.
 */
const FALLBACK_ELIGIBLE = Object.freeze([
  'NETWORK_ERROR',
  'CONNECTION_TIMEOUT',
  'DNS_FAILURE',
  'CONNECTION_REFUSED',
  'TLS_ERROR',
]);

/** AI request tuning. */
const AI_LIMITS = Object.freeze({
  MAX_MESSAGES: 40, // default context window; 0 in config means "all loaded"
  MAX_CHARS: 20000, // default hard cap on the serialized conversation block
  MIN_TIMEOUT_MS: 5000,
  MAX_TIMEOUT_MS: 120000,
  // Ceiling for the automatic retry when a reply was cut off, or swallowed
  // whole, by max_tokens.
  MAX_TOKENS_CEILING: 8192,
});

/** Log prefix used everywhere. Never log secrets next to it. */
const LOG_PREFIX = '[WA-FOLLOWUP]';

/** Stable error codes surfaced to the side panel. */
const ERR = Object.freeze({
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
  CHAT_CHANGED: 'CHAT_CHANGED_DURING_GENERATION',
  NO_CHAT_OPEN: 'NO_CHAT_OPEN',
  NO_MESSAGES: 'NO_MESSAGES_LOADED',
  EMPTY_MESSAGE: 'NOTHING_TO_SEND',
  COMPOSER_NOT_FOUND: 'COMPOSER_NOT_FOUND',
  SEND_BUTTON_NOT_FOUND: 'SEND_BUTTON_NOT_FOUND',
  AI_NOT_CONFIGURED: 'AI_API_KEY_NOT_SET',
  AI_FAILED: 'AI_REQUEST_FAILED',
  AI_AUTH_FAILED: 'AI_AUTHENTICATION_FAILED',
  AI_EMPTY: 'AI_RETURNED_EMPTY',
  AI_TRUNCATED: 'AI_REPLY_TRUNCATED',
  // ChatGPT-subscription connection (the local helper)
  /** Nothing is listening on the helper's loopback port. */
  HELPER_UNREACHABLE: 'CHATGPT_HELPER_UNREACHABLE',
  /** The helper is running but no ChatGPT account is signed in. */
  CHATGPT_NOT_SIGNED_IN: 'CHATGPT_NOT_SIGNED_IN',
  /** Signed in, but the account did not grant ChatGPT plan usage. */
  CHATGPT_NO_PLAN_SCOPE: 'CHATGPT_PLAN_NOT_AUTHORIZED',
  /** The account is not eligible for plan usage in an app like this one. */
  CHATGPT_NOT_ELIGIBLE: 'CHATGPT_NOT_ELIGIBLE',
  /** Plan allowance (or an app-specific limit) is used up. */
  CHATGPT_USAGE_LIMIT: 'CHATGPT_USAGE_LIMIT_EXCEEDED',
  /** Availability could not be checked — retry later, credentials are fine. */
  CHATGPT_UNAVAILABLE: 'CHATGPT_USAGE_UNAVAILABLE',
  /** The helper answered, but with a failure this build does not recognise. */
  CHATGPT_FAILED: 'CHATGPT_REQUEST_FAILED',
  /**
   * The helper is running but cannot read OpenAI's own sign-in configuration.
   * Nothing about the account is wrong — this is their side, or a machine that
   * cannot reach auth.openai.com — and the advice is different, which is why it
   * is not folded into CHATGPT_FAILED.
   */
  HELPER_CONFIG_INVALID: 'CONFIG_INVALID',
  WHATSAPP_NOT_OPEN: 'WHATSAPP_WEB_NOT_OPEN',
  BUSY: 'OPERATION_ALREADY_RUNNING',
  TIMEOUT: 'TIMEOUT',
});

/**
 * Who sent a message. Used as the label in the AI context block (`ME:` /
 * `CUSTOMER:`), so a wrong value actively misleads the model — it would read
 * its own draft as something the customer said.
 */
const MESSAGE_DIRECTION = Object.freeze({
  INCOMING: 'incoming',
  OUTGOING: 'outgoing',
  UNKNOWN: 'unknown',
});

/**
 * Accessible names WhatsApp puts on the delivery-status node of a message *we*
 * sent — 已读 = read, 已送达 = delivered, and so on.
 *
 * Verified live (2026-09-25, Comet build): all 18 outgoing rows sampled across
 * four chats carried exactly one of these, and none of the three incoming rows
 * carried any. The `[data-icon="msg-dblcheck"]` selector this replaced matched
 * nothing at all in the current build, so that check had silently never fired.
 *
 * Locale-dependent by nature — add a language here if the panel is ever used
 * with a UI language that is not listed.
 */
const DELIVERY_STATUS_LABELS = Object.freeze([
  // zh
  '已读', '已送达', '已发送', '发送中', '等待发送',
  // en
  'Read', 'Delivered', 'Sent', 'Pending', 'Sending',
]);

/**
 * Contact-identity confidence levels.
 *
 * `verified` means the number was read from a trustworthy source (the contact
 * info panel or the chat header), never guessed from a name or from message
 * text. It is shown in the UI as a trust signal; it is no longer a send gate.
 */
const PHONE_STATUS = Object.freeze({
  VERIFIED: 'verified',
  UNVERIFIED: 'unverified',
  UNKNOWN: 'unknown',
  LOADING: 'loading',
});
// ---------------------------------------------------------------------------
// ES module exports — the service worker imports this file as a module while
// the content script loads it as a classic script. Both work because the
// declarations above stay in the module/global scope either way.
// ---------------------------------------------------------------------------

export {
  MSG,
  STORAGE_KEYS,
  CONFIG_VERSION,
  DEFAULT_SYSTEM_PROMPT,
  LEGACY_SYSTEM_PROMPT_VENDING,
  CONNECTION_MODE,
  CONNECTION_MODE_SPECS,
  CHATGPT_HELPER_DEFAULT_URL,
  CONNECTOR_RELEASE_URL,
  CONNECTOR_DOWNLOAD_URL,
  CHATGPT_HELPER_PATHS,
  CHATGPT_SCOPES,
  CHATGPT_RESOURCE,
  CHATGPT_PLAN_SCOPE,
  REQUIRED_AI_FIELDS,
  REQUIRED_CHATGPT_FIELDS,
  AI_FIELD_LABELS,
  connectionModeOf,
  missingAiFields,
  hasRequiredConfig,
  REPLY_LENGTH,
  REPLY_LENGTH_SPECS,
  THINKING_MODE,
  THINKING_SPECS,
  CONTEXT_MESSAGE_CHOICES,
  MESSAGE_STORE_LIMITS,
  DRAFT_LIMITS,
  INSTRUCTION_LIMITS,
  DEFAULT_AI_CONFIG,
  AI_CONFIG_STRING_KEYS,
  AI_CONFIG_NUMBER_RANGES,
  AI_LIMITS,
  FALLBACK_ELIGIBLE,
  MESSAGE_DIRECTION,
  DELIVERY_STATUS_LABELS,
  PHONE_STATUS,
  ERR,
  LOG_PREFIX,
};
