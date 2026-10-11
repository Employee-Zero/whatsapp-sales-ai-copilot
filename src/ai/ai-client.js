/**
 * AI client — OpenAI-compatible chat/completions, with primary → fallback.
 *
 * Runs ONLY in the service worker (task §8: never call the AI API from the
 * content script).
 *
 * Configuration is ALWAYS read from chrome.storage.local, falling back to
 * DEFAULT_AI_CONFIG only when storage is empty. Nothing here reads a hardcoded
 * constant for the live request, so a Settings change takes effect immediately
 * without touching source.
 */

import {
  DEFAULT_AI_CONFIG,
  DEFAULT_SYSTEM_PROMPT,
  AI_LIMITS,
  STORAGE_KEYS,
  ERR,
  FALLBACK_ELIGIBLE,
  AI_CONFIG_NUMBER_RANGES,
  AI_FIELD_LABELS,
  REPLY_LENGTH,
  REPLY_LENGTH_SPECS,
  THINKING_MODE,
  THINKING_SPECS,
  CONFIG_VERSION,
  CONNECTION_MODE,
  connectionModeOf,
  hasRequiredConfig,
  missingAiFields,
} from './../shared/constants.js';
import {
  mergeConfig,
  clamp,
  withTimeout,
  log,
  logError,
  resolveChatEndpoint,
  resolveModelsEndpoint,
  classifyNetworkError,
  describeHttpFailure,
  normalizeBaseUrl,
  limitMessages,
  formatTranscript,
  resolveMaxTokens,
  thinkingRequestParam,
  instructionBlock,
  migrateStoredConfig,
} from './../shared/utils.js';
import {
  helperBaseUrl,
  generate as chatgptGenerate,
  checkConnection as chatgptCheckConnection,
  sendTestRequest as chatgptTestRequest,
  helperStatus,
} from './chatgpt-client.js';

/**
 * The system prompt, as configured.
 *
 * It lives in storage because the user rewrites it often and must never have to
 * edit source to change the wording. `DEFAULT_SYSTEM_PROMPT` is the fallback for
 * an empty or missing value, and what "Reset to default" restores.
 */
function systemPromptFor(cfg) {
  const custom = cfg && typeof cfg.systemPrompt === 'string' ? cfg.systemPrompt.trim() : '';
  return custom || DEFAULT_SYSTEM_PROMPT;
}

/**
 * Reject values outside a fixed set, falling back to the default.
 * @param {string} value @param {object} allowed @param {string} fallback
 */
function oneOf(value, allowed, fallback) {
  return Object.prototype.hasOwnProperty.call(allowed, value) ? value : fallback;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Read the stored AI config, merged over defaults.
 *
 * storage.local  →  migration  →  DEFAULT_AI_CONFIG  →  usable config
 *
 * @returns {Promise<object>}
 */
async function loadAiConfig() {
  let raw = null;
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.AI_CONFIG);
    raw = stored ? stored[STORAGE_KEYS.AI_CONFIG] : null;
  } catch (err) {
    logError('storage read failed, using defaults');
  }
  const migrated = migrateStoredConfig(raw);
  const cfg = mergeConfig(DEFAULT_AI_CONFIG, migrated);
  // No fallback to a shipped default here: the published build has no default
  // Base URL, and inventing one would send a first-run user's conversation to a
  // provider they never chose. An empty string is the honest answer, and the
  // panel turns it into the setup screen.
  cfg.primaryBaseUrl = normalizeBaseUrl(cfg.primaryBaseUrl);
  cfg.fallbackBaseUrl = normalizeBaseUrl(cfg.fallbackBaseUrl);
  cfg.model = String(cfg.model || '').trim();
  // A config written before this field existed has no `connectionMode`; mergeConfig
  // fills the default, which is the API-key path, which is what that build did.
  cfg.connectionMode = connectionModeOf(cfg);
  cfg.chatgptModel = String(cfg.chatgptModel || '').trim();
  cfg.helperUrl = helperBaseUrl(cfg);
  cfg.replyLength = oneOf(cfg.replyLength, REPLY_LENGTH_SPECS, REPLY_LENGTH.MEDIUM);
  cfg.thinking = oneOf(cfg.thinking, THINKING_SPECS, THINKING_MODE.AUTO);

  // Persist a migration once, so storage and the running config agree and the
  // next read is a plain merge. After the first write the version matches and
  // this is a no-op, so it does not add a write to the hot path.
  if (migrated !== raw && raw) {
    chrome.storage.local.set({ [STORAGE_KEYS.AI_CONFIG]: cfg }).catch(() => {});
  }
  return cfg;
}

/**
 * Persist a partial AI config. Unknown keys are dropped by mergeConfig, and
 * numeric fields are clamped into their documented ranges.
 *
 * @param {object} partial
 * @returns {Promise<object>} the stored config
 */
async function saveAiConfig(partial) {
  const current = await loadAiConfig();
  const next = mergeConfig(DEFAULT_AI_CONFIG, Object.assign({}, current, partial));

  for (const [key, range] of Object.entries(AI_CONFIG_NUMBER_RANGES)) {
    next[key] = key === 'temperature' ? clamp(next[key], range.min, range.max) : Math.round(clamp(next[key], range.min, range.max));
  }
  next.primaryBaseUrl = normalizeBaseUrl(next.primaryBaseUrl);
  next.fallbackBaseUrl = normalizeBaseUrl(next.fallbackBaseUrl);
  next.model = String(next.model || '').trim();
  next.connectionMode = connectionModeOf(next);
  next.chatgptModel = String(next.chatgptModel || '').trim();
  next.helperUrl = helperBaseUrl(next);
  next.replyLength = oneOf(next.replyLength, REPLY_LENGTH_SPECS, REPLY_LENGTH.MEDIUM);
  next.thinking = oneOf(next.thinking, THINKING_SPECS, THINKING_MODE.AUTO);
  // An emptied prompt means "use the built-in one", never "send no instructions".
  next.systemPrompt = typeof next.systemPrompt === 'string' && next.systemPrompt.trim() ? next.systemPrompt : DEFAULT_SYSTEM_PROMPT;
  next.configVersion = CONFIG_VERSION;

  await chrome.storage.local.set({
    [STORAGE_KEYS.AI_CONFIG]: next,
    [STORAGE_KEYS.AI_CONFIG_SEEDED]: true,
  });
  return next;
}


/**
 * First-run seeding, called from onInstalled.
 *
 * It writes the empty default record so the panel has a shape to render, and
 * nothing else. If a config already exists it is left untouched — an upgrade
 * must never disturb a working provider or key.
 *
 * @returns {Promise<{seeded: boolean}>}
 */
async function seedAiConfigIfMissing() {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.AI_CONFIG, STORAGE_KEYS.AI_CONFIG_SEEDED]);
  if (stored && stored[STORAGE_KEYS.AI_CONFIG]) {
    log('AI config already present — not re-seeding');
    return { seeded: false };
  }
  await chrome.storage.local.set({
    [STORAGE_KEYS.AI_CONFIG]: Object.assign({}, DEFAULT_AI_CONFIG),
    [STORAGE_KEYS.AI_CONFIG_SEEDED]: true,
  });
  log('AI config seeded from defaults');
  return { seeded: true };
}

/**
 * The config shape the side panel is allowed to see. The API key is reduced to
 * a presence flag plus a masked tail — the raw key never leaves the worker.
 *
 * @param {object} cfg
 * @returns {object}
 */
function publicConfig(cfg) {
  const key = cfg.apiKey || '';
  const missing = missingAiFields(cfg);
  const mode = connectionModeOf(cfg);
  return {
    /**
     * Which method is live, and the fields of both.
     *
     * The inactive method's fields are sent too, always. Switching method is a
     * two-way door — a user tries the subscription, it turns out their account
     * is not eligible, and they go back to the key they already had. Hiding the
     * other method's values from the panel is how that door quietly becomes
     * one-way.
     */
    connectionMode: mode,
    chatgptModel: cfg.chatgptModel,
    helperUrl: cfg.helperUrl,
    primaryBaseUrl: cfg.primaryBaseUrl,
    fallbackBaseUrl: cfg.fallbackBaseUrl,
    model: cfg.model,
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens,
    /** What the request will actually use when maxTokens is 0 ("auto"). */
    effectiveMaxTokens: resolveMaxTokens(cfg),
    replyLength: cfg.replyLength,
    thinking: cfg.thinking,
    contextMessages: cfg.contextMessages,
    maxChars: cfg.maxChars,
    systemPrompt: cfg.systemPrompt,
    defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT,
    timeoutMs: cfg.timeoutMs,
    hasApiKey: !!key.trim(),
    keyHint: key.trim() ? `…${key.trim().slice(-4)}` : '',
    /**
     * Whether an AI request could be made at all, and if not, which fields are
     * still blank. The panel renders its first-run screen from these two values
     * rather than re-deriving the rule and drifting away from it.
     */
    hasRequiredConfig: missing.length === 0,
    missingFields: missing,
    missingFieldLabels: missing.map((f) => AI_FIELD_LABELS[f] || f),
  };
}

/**
 * Refuse to make a request that cannot succeed.
 *
 * Every one of these would otherwise become an HTTP round trip that fails in a
 * way the user cannot act on — an empty Base URL turns into `POST /v1/chat/
 * completions` against nothing, and an empty model into whatever the provider
 * decides to do with `"model": ""`. Checking here means the panel can say
 * exactly which field to fill in, before anything leaves the browser.
 *
 * @param {object} cfg
 * @throws {Error} AI_API_KEY_NOT_SET | AI_NOT_CONFIGURED
 */
function assertConfigured(cfg) {
  const missing = missingAiFields(cfg);
  if (!missing.length) return;

  const labels = missing.map((f) => AI_FIELD_LABELS[f] || f);
  const e = new Error(`AI_NOT_CONFIGURED:${missing.join(',')}`);
  e.code = ERR.AI_NOT_CONFIGURED;
  e.missingFields = missing;
  e.missingFieldLabels = labels;
  throw e;
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

/**
 * Build the user message: transcript + framing + the two live directives.
 *
 * Reply length is appended here rather than baked into the system prompt so the
 * user can change it per message without editing their own prompt text, and so
 * a custom prompt can never contradict the length control by accident — the
 * instruction the model reads last is the one that wins.
 *
 * @param {{contactName: string, transcript: string, messageCount: number}} ctx
 * @param {object} cfg
 * @returns {string}
 */
function buildUserPrompt(ctx, cfg) {
  const maxChars = clamp(Number(cfg && cfg.maxChars) || AI_LIMITS.MAX_CHARS, 1000, 100000);
  let transcript = ctx.transcript || '';
  if (transcript.length > maxChars) {
    // Keep the NEWEST part — that is what the reply must respond to.
    transcript = `[...earlier messages omitted...]\n${transcript.slice(-maxChars)}`;
  }

  const lengthSpec = REPLY_LENGTH_SPECS[(cfg && cfg.replyLength) || REPLY_LENGTH.MEDIUM] || REPLY_LENGTH_SPECS.medium;

  return [
    `Current customer: ${ctx.contactName || 'Unknown'}`,
    '',
    'Conversation:',
    transcript || '(no messages loaded)',
    '',
    `Current time: ${new Date().toString()}`,
    '',
    lengthSpec.guidance,
    'Reply with the message text only.',
  ].join('\n');
}


// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * Perform one POST /chat/completions against a single host.
 *
 * Never falls back internally — the caller decides that.
 *
 * Returns an EMPTY `text` rather than throwing when the model produced no
 * content. That is deliberate: on a reasoning model an empty reply is the
 * signature of a thinking budget that ate the whole `max_tokens` allowance, and
 * only the caller — which knows how to retry with a bigger one — can tell that
 * apart from a genuine provider fault. Throwing here is what made the retry
 * unreachable and left the user staring at "The AI returned an empty reply".
 *
 * @param {string} baseUrl
 * @param {object} cfg
 * @param {Array<{role: string, content: string}>} messages
 * @param {number} [maxTokensOverride]
 * @param {{budgetTokens?: number}} [retryOpts] raises the thinking budget too
 * @returns {Promise<{text: string, finishReason: string, model: string, usage: object|null, elapsedMs: number, host: string, maxTokens: number}>}
 */
async function callChatEndpoint(baseUrl, cfg, messages, maxTokensOverride, retryOpts = {}) {
  const endpoint = resolveChatEndpoint(baseUrl);
  if (!endpoint) {
    const e = new Error('The API Base URL is empty or invalid.');
    e.code = ERR.AI_FAILED;
    e.failureClass = 'CONFIG_INVALID';
    throw e;
  }

  const maxTokens = clamp(
    Math.round(Number(maxTokensOverride) || resolveMaxTokens(cfg)),
    16,
    AI_LIMITS.MAX_TOKENS_CEILING,
  );

  const body = {
    model: cfg.model,
    messages,
    temperature: cfg.temperature,
    max_tokens: maxTokens,
    stream: false,
  };

  // Omitted entirely on "auto": a provider whose model has no thinking mode may
  // reject the field outright, and omitting it IS the auto behaviour.
  const thinking = thinkingRequestParam(cfg.thinking);
  if (thinking) {
    if (retryOpts.budgetTokens) thinking.budget_tokens = retryOpts.budgetTokens;
    body.thinking = thinking;
  }

  const timeoutMs = clamp(cfg.timeoutMs, AI_LIMITS.MIN_TIMEOUT_MS, AI_LIMITS.MAX_TIMEOUT_MS);
  const startedAt = Date.now();

  let res;
  try {
    res = await withTimeout(
      fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // The key exists only in this header. Never logged, never persisted
          // outside chrome.storage.local, never sent back to the side panel.
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(body),
      }),
      timeoutMs,
      'AI request timed out',
    );
  } catch (err) {
    const failureClass = classifyNetworkError(err);
    logError('AI transport failure:', failureClass || 'UNKNOWN');
    const e = new Error(failureClass === 'CONNECTION_TIMEOUT' ? 'Connection timeout' : 'Network error');
    e.code = failureClass === 'CONNECTION_TIMEOUT' ? ERR.TIMEOUT : ERR.AI_FAILED;
    e.failureClass = failureClass || 'NETWORK_ERROR';
    throw e;
  }

  const elapsedMs = Date.now() - startedAt;

  if (!res.ok) {
    let providerMessage = '';
    try {
      const errJson = await res.json();
      providerMessage =
        (errJson && errJson.error && (errJson.error.message || errJson.error.type)) ||
        (typeof errJson.message === 'string' ? errJson.message : '') ||
        '';
    } catch (e) {
      /* body was not JSON */
    }
    const e = new Error(describeHttpFailure(res.status, providerMessage));
    e.code = res.status === 401 || res.status === 403 ? ERR.AI_AUTH_FAILED : ERR.AI_FAILED;
    e.status = res.status;
    // HTTP failures are configuration problems — deliberately NOT fallback-eligible.
    e.failureClass = res.status === 404 ? 'ENDPOINT_INVALID' : 'HTTP_ERROR';
    throw e;
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    const e = new Error('The provider returned a non-JSON response.');
    e.code = ERR.AI_FAILED;
    e.failureClass = 'BAD_RESPONSE';
    throw e;
  }

  const { text, finishReason } = extractText(data);

  return {
    text,
    finishReason,
    model: data.model || cfg.model,
    usage: data.usage || null,
    elapsedMs,
    host: safeHost(endpoint),
    maxTokens,
  };
}

/**
 * How many tokens the model spent thinking rather than answering.
 *
 * Providers disagree on where this lives, so every known shape is checked. It
 * matters because it is the difference between "the model had nothing to say"
 * and "the model never got to speak".
 *
 * @param {object|null} usage
 * @returns {number}
 */
function reasoningTokens(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  const details = usage.completion_tokens_details || {};
  const candidates = [
    details.reasoning_tokens,
    usage.reasoning_tokens,
    usage.reasoningTokens,
    usage.thinking_tokens,
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

/**
 * Run a chat completion against the primary host, falling back to the secondary
 * host ONLY for genuine connectivity failures.
 *
 * @param {object} cfg
 * @param {Array<{role: string, content: string}>} messages
 * @param {number} [maxTokensOverride]
 * @param {{budgetTokens?: number}} [retryOpts]
 * @returns {Promise<object>}
 */
async function callWithFallback(cfg, messages, maxTokensOverride, retryOpts) {
  const attempts = [];
  const primary = cfg.primaryBaseUrl;
  const fallback = cfg.fallbackBaseUrl;

  try {
    const out = await callChatEndpoint(primary, cfg, messages, maxTokensOverride, retryOpts);
    out.usedFallback = false;
    return out;
  } catch (err) {
    attempts.push({ host: safeHost(resolveChatEndpoint(primary)), code: err.failureClass || err.code });

    const eligible = err && FALLBACK_ELIGIBLE.includes(err.failureClass);
    if (!eligible || !fallback || fallback === primary) {
      if (!eligible) {
        logError('Not using fallback — failure is not a connectivity problem:', err.failureClass);
      }
      err.attempts = attempts;
      throw err;
    }

    log('Primary unreachable — trying fallback host');
    try {
      const out = await callChatEndpoint(fallback, cfg, messages, maxTokensOverride, retryOpts);
      out.usedFallback = true;
      return out;
    } catch (err2) {
      attempts.push({ host: safeHost(resolveChatEndpoint(fallback)), code: err2.failureClass || err2.code });
      err2.attempts = attempts;
      throw err2;
    }
  }
}

/** Extract the hostname from a URL without throwing on malformed input. */
function safeHost(url) {
  try {
    return new URL(url).host;
  } catch (e) {
    return String(url || '');
  }
}

/**
 * Pull the assistant text out of an OpenAI-style response.
 * Tolerates `choices[].message.content` (string or parts array) and
 * `choices[].text`.
 *
 * @param {any} data
 * @returns {{text: string, finishReason: string}}
 */
function extractText(data) {
  if (!data || typeof data !== 'object') return { text: '', finishReason: '' };
  const choices = Array.isArray(data.choices) ? data.choices : [];
  for (const c of choices) {
    if (!c) continue;
    const finishReason = typeof c.finish_reason === 'string' ? c.finish_reason : '';
    const msg = c.message;
    if (msg && typeof msg.content === 'string' && msg.content.trim()) {
      return { text: msg.content.trim(), finishReason };
    }
    if (msg && Array.isArray(msg.content)) {
      const joined = msg.content
        .map((p) => (typeof p === 'string' ? p : p && typeof p.text === 'string' ? p.text : ''))
        .join('')
        .trim();
      if (joined) return { text: joined, finishReason };
    }
    if (typeof c.text === 'string' && c.text.trim()) return { text: c.text.trim(), finishReason };
  }
  return { text: '', finishReason: '' };
}

// ---------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------

/**
 * Generate a follow-up message for the given conversation context.
 *
 * Retries once with a larger budget when the model ran out of room — which
 * happens in two different-looking ways, both of which are the same failure:
 *
 *   1. It stopped mid-sentence. `finish_reason: "length"` with partial text.
 *      Sending half a sentence to a real customer is worse than not sending.
 *   2. It returned NOTHING at all. On a reasoning model the thinking tokens are
 *      billed against `max_tokens`, so a budget that is too small is spent
 *      entirely on thinking and the content comes back empty — HTTP 200, no
 *      error, no text. This is what "The AI returned an empty reply" actually
 *      was, and the previous code could not recover from it: the empty check
 *      threw before the caller ever saw `finish_reason`.
 *
 * The retry raises the answer budget and, when thinking is explicitly enabled,
 * its budget too — raising only one of the two would leave the same starvation
 * in place. A reply that is still unusable on the retry is reported as an error
 * rather than handed to the user as a draft.
 *
 * @param {{contactName: string, transcript: string, messages?: Array<object>,
 *          messageCount: number}} ctx
 * @returns {Promise<{text: string, model: string, usage: object|null}>}
 * @throws {Error} AI_API_KEY_NOT_SET | AI_REQUEST_FAILED | TIMEOUT |
 *   AI_RETURNED_EMPTY | AI_REPLY_TRUNCATED
 */
async function generateReply(ctx) {
  const cfg = await loadAiConfig();

  // Before anything else: is there a provider to talk to at all? Nothing is sent
  // until Base URL, API Key and Model are all present.
  assertConfigured(cfg);

  // The context window is applied here rather than in the content script so the
  // trim, the transcript and the budget all come from one config read.
  let transcript = ctx.transcript || '';
  if (Array.isArray(ctx.messages) && ctx.messages.length) {
    const limited = limitMessages(ctx.messages, cfg.contextMessages);
    if (limited !== ctx.messages) transcript = formatTranscript(limited);
  }

  const baseBudget = resolveMaxTokens(cfg);

  // The two methods share everything above this line — the config read, the
  // configuration gate, the context window, the prompt assembly — and nothing
  // below it. That split is deliberate: the prompt a salesperson tunes is the
  // same prompt on either path, and only the transport differs.
  if (connectionModeOf(cfg) === CONNECTION_MODE.CHATGPT) {
    log('Calling ChatGPT plan', `model=${cfg.chatgptModel}`, `helper=${helperBaseUrl(cfg)}`, `length=${cfg.replyLength}`);
    const out = await chatgptGenerate(cfg, {
      instructions: systemPromptFor(cfg) + instructionBlock(ctx.instruction),
      input: buildUserPrompt(Object.assign({}, ctx, { transcript }), cfg),
      timeoutMs: cfg.timeoutMs,
    });
    log('ChatGPT plan completed', `${out.elapsedMs}ms`);
    return { text: out.text, model: out.model, usage: out.usage, elapsedMs: out.elapsedMs, usedFallback: false };
  }

  log(
    'Calling AI',
    `model=${cfg.model}`,
    `host=${safeHost(resolveChatEndpoint(cfg.primaryBaseUrl))}`,
    `max_tokens=${baseBudget}`,
    `length=${cfg.replyLength}`,
    `thinking=${cfg.thinking}`,
  );

  const messages = [
    // The per-chat instruction rides on the system message so it outranks the
    // general guidance — see `instructionBlock`.
    { role: 'system', content: systemPromptFor(cfg) + instructionBlock(ctx.instruction) },
    { role: 'user', content: buildUserPrompt(Object.assign({}, ctx, { transcript }), cfg) },
  ];

  let out = await callWithFallback(cfg, messages);
  const firstWasEmpty = !out.text;

  if (!out.text || out.finishReason === 'length') {
    const retryBudget = Math.min(
      AI_LIMITS.MAX_TOKENS_CEILING,
      Math.max(baseBudget * 3, baseBudget + 1024),
    );
    const thinkSpec = THINKING_SPECS[cfg.thinking] || THINKING_SPECS.auto;
    const retryOpts = thinkSpec.budgetTokens ? { budgetTokens: Math.round(retryBudget / 2) } : {};

    if (firstWasEmpty) {
      log(
        'Empty reply — the token budget was consumed before any content',
        `reasoning_tokens=${reasoningTokens(out.usage)}`,
        `finish=${out.finishReason || 'n/a'}`,
        `retrying with ${retryBudget}`,
      );
    } else {
      log('Reply was cut off by max_tokens — retrying with a larger budget', String(retryBudget));
    }

    out = await callWithFallback(cfg, messages, retryBudget, retryOpts);

    if (!out.text) {
      const e = new Error('AI_RETURNED_EMPTY');
      e.code = ERR.AI_EMPTY;
      e.reasoningTokens = reasoningTokens(out.usage);
      e.maxTokens = out.maxTokens;
      throw e;
    }
    if (out.finishReason === 'length') {
      const e = new Error('AI_REPLY_TRUNCATED');
      e.code = ERR.AI_TRUNCATED;
      e.partial = out.text;
      throw e;
    }
  }

  log('AI completed', `${out.elapsedMs}ms`, out.usedFallback ? '(via fallback)' : '');
  return { text: out.text, model: out.model, usage: out.usage, elapsedMs: out.elapsedMs, usedFallback: out.usedFallback };
}

/**
 * Test Connection — used by the Settings panel.
 *
 * Sends a deliberately small request so the user learns, quickly and truthfully,
 * whether the endpoint / key / model combination actually works.
 *
 * The budget is 512, not 16. A reasoning model spends more than 16 tokens
 * thinking before it writes anything, so the old budget made a perfectly healthy
 * configuration report "The model returned an empty message" — a false negative
 * on the one screen whose entire job is to tell the truth about the connection.
 * 512 is still small enough to be fast on any model.
 *
 * `thinking` is deliberately not sent: this call must not fail on a model that
 * does not know the field.
 *
 * @param {object} [overrideCfg] values currently typed in the Settings form
 * @returns {Promise<object>} always resolves; inspect `.ok`
 */
async function testConnection(overrideCfg) {
  const base = await loadAiConfig();
  const cfg = mergeConfig(DEFAULT_AI_CONFIG, Object.assign({}, base, overrideCfg || {}));
  cfg.primaryBaseUrl = normalizeBaseUrl(cfg.primaryBaseUrl);
  cfg.fallbackBaseUrl = normalizeBaseUrl(cfg.fallbackBaseUrl);
  cfg.model = String(cfg.model || '').trim();
  cfg.connectionMode = connectionModeOf(cfg);
  cfg.chatgptModel = String(cfg.chatgptModel || '').trim();
  cfg.helperUrl = helperBaseUrl(cfg);

  // ChatGPT mode: this button deliberately does NOT send an inference request.
  //
  // The API-key test costs a fraction of a cent and the user has already agreed
  // to pay for that key, so it makes a real call. This path spends an allowance
  // the user shares with every other app on their ChatGPT account, and a
  // "Test" button that quietly consumes part of it is a button people learn not
  // to press. So it answers the four questions that can be answered for free —
  // helper running, account signed in, plan usage allowed, model in this
  // account's catalogue — and reports `inferenceRequestSent: false` so the panel
  // can say what it actually did. The real request is a separate, labelled
  // button: `testChatGPTRequest` below.
  if (cfg.connectionMode === CONNECTION_MODE.CHATGPT) {
    const out = await chatgptCheckConnection(cfg);
    return Object.assign({ mode: 'chatgpt' }, out);
  }

  // Same gate as a real request, so "Test" can never report on a request that
  // could not have been made. Naming the missing fields is the whole value of
  // the button: "Authentication failed" for a blank key sends the user looking
  // in the wrong place.
  const missing = missingAiFields(cfg);
  if (missing.length) {
    const labels = missing.map((f) => AI_FIELD_LABELS[f] || f);
    return {
      ok: false,
      error: `Fill in ${labels.join(', ')} first.`,
      code: ERR.AI_NOT_CONFIGURED,
      missingFields: missing,
      missingFieldLabels: labels,
    };
  }
  if (!resolveChatEndpoint(cfg.primaryBaseUrl)) {
    return {
      ok: false,
      error: 'That API Base URL is not a valid URL. It should look like https://api.your-provider.com/v1',
      code: ERR.AI_NOT_CONFIGURED,
      missingFields: ['primaryBaseUrl'],
      missingFieldLabels: [AI_FIELD_LABELS.primaryBaseUrl],
    };
  }

  // A minimal request: one short exchange, a budget a reasoning model can work
  // inside.
  const messages = [
    { role: 'system', content: 'Reply with the single word: ok' },
    { role: 'user', content: 'ping' },
  ];

  const startedAt = Date.now();
  try {
    const out = await callWithFallback(cfg, messages, 512);
    if (!out.text) {
      return {
        ok: false,
        error: 'The model accepted the request but returned no text. Raise Max output tokens, or set Thinking to Off.',
        code: ERR.AI_EMPTY,
        failureClass: 'EMPTY_RESPONSE',
      };
    }
    return {
      ok: true,
      host: out.host,
      model: out.model,
      usedFallback: out.usedFallback,
      responseMs: Date.now() - startedAt,
      sample: out.text.slice(0, 60),
    };
  } catch (err) {
    return {
      ok: false,
      error: (err && err.message) || 'Request failed.',
      code: (err && err.code) || ERR.AI_FAILED,
      status: err && err.status,
      failureClass: err && err.failureClass,
      attempts: err && err.attempts,
    };
  }
}

/**
 * ChatGPT mode: send ONE real, minimal request to the user's plan.
 *
 * Separate from `testConnection` on purpose — this one spends the account's
 * allowance, so it is only ever reached from a button that says so.
 *
 * @param {object} [overrideCfg] values currently typed in the Settings form
 * @returns {Promise<object>} always resolves; inspect `.ok`
 */
async function testChatGPTRequest(overrideCfg) {
  const base = await loadAiConfig();
  const cfg = mergeConfig(DEFAULT_AI_CONFIG, Object.assign({}, base, overrideCfg || {}));
  cfg.connectionMode = connectionModeOf(cfg);
  cfg.chatgptModel = String(cfg.chatgptModel || '').trim();
  cfg.helperUrl = helperBaseUrl(cfg);

  if (!cfg.chatgptModel) {
    return {
      ok: false,
      code: ERR.AI_NOT_CONFIGURED,
      error: 'Choose a model first.',
      missingFields: ['chatgptModel'],
      missingFieldLabels: [AI_FIELD_LABELS.chatgptModel],
    };
  }

  const out = await chatgptTestRequest(cfg);
  log('ChatGPT test request', out.ok ? 'succeeded' : `failed (${out.code})`);
  return Object.assign({ mode: 'chatgpt', inferenceRequestSent: true }, out);
}

/**
 * Send a message to the WhatsApp tab's content script, re-injecting the scripts
 * if the tab was reloaded and the content script is gone.
 *
 * @param {number} tabId
 * @param {object} message
 * @returns {Promise<object>}
 */
async function sendToTab(tabId, message) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, message);
    return res || { ok: false, code: 'EMPTY_RESPONSE' };
  } catch (err) {
    logError('sendToTab failed', message && message.type);
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: [
          'src/shared/constants.classic.js',
          'src/shared/utils.classic.js',
          'src/content/whatsapp-adapter.js',
          'src/content/content-script.js',
        ],
      });
      await new Promise((r) => setTimeout(r, 250));
      const res = await chrome.tabs.sendMessage(tabId, message);
      return res || { ok: false, code: 'EMPTY_RESPONSE' };
    } catch (err2) {
      return { ok: false, code: ERR.WHATSAPP_NOT_OPEN, message: 'Cannot reach the WhatsApp Web tab.' };
    }
  }
}
// ---------------------------------------------------------------------------
// ES module exports (the service worker imports this file as a module).
// ---------------------------------------------------------------------------

export {
  systemPromptFor,
  reasoningTokens,
  loadAiConfig,
  saveAiConfig,
  seedAiConfigIfMissing,
  publicConfig,
  assertConfigured,
  buildUserPrompt,
  extractText,
  generateReply,
  testConnection,
  testChatGPTRequest,
  helperStatus,
  sendToTab,
};
