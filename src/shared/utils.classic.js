/*
 * GENERATED FILE — do not edit.
 *
 * Classic-script copy of the module next to it, for the content script and
 * the side panel. Regenerate with:  node tools/build-classic.js
 */
/**
 * Shared helpers — in the service worker this file is an ES module that imports
 * LOG_PREFIX from constants.js; in content scripts / the side panel the
 * generated `utils.classic.js` copy provides the same functions as globals.
 *
 * Safety-critical functions live here:
 *   normalizePhone() / maskPhone()
 */

/* eslint-disable no-unused-vars */

/**
 * Normalize a phone number to digits-only international form (no leading "+").
 * Returns '' when the input cannot be interpreted as a phone number.
 *
 * Handles: "+86 138 0013 8000", "0086 138 0013 8000", "+86-138-0013-8000",
 * bidi/zero-width marks that WhatsApp injects into the contact panel.
 *
 * @param {string} raw
 * @returns {string}
 */
function normalizePhone(raw) {
  if (typeof raw !== 'string' || !raw) return '';

  // Strip bidi control chars, zero-width chars and exotic spaces that WhatsApp
  // inserts into the contact info panel (these break naive parsing).
  let s = raw.replace(/[​-‏‪-‮⁦-⁩﻿]/g, '');
  s = s.replace(/[  -   　]/g, ' ');

  // Keep only digits and '+'.
  s = s.replace(/[^\d+]/g, '');
  if (!s) return '';

  const hadPlus = s.startsWith('+');
  s = s.replace(/\+/g, ''); // a phone number has at most one leading '+'
  if (!s) return '';

  // "00" is the international access prefix used in place of "+".
  if (!hadPlus && s.startsWith('00')) s = s.slice(2);

  // A real international number is E.164: at most 15 digits, and never shorter
  // than 8 (country code + subscriber). Anything shorter is a short code or a
  // truncated paste, and must not be treated as a usable phone number.
  if (s.length < 8 || s.length > 15) return '';
  if (/^0+$/.test(s)) return '';

  // Strip a leading national trunk "0" so "08613800138000" and "8613800138000"
  // collapse to the same value, then re-check the length: a number that only
  // looked long enough *because* of the trunk prefix is a malformed paste.
  s = s.replace(/^0+/, '');
  if (s.length < 8) return '';

  return s;
}

/**
 * Read a phone number out of a chat title, but only when the title *is* a phone
 * number.
 *
 * WhatsApp Web prints an unsaved contact's number as the conversation title
 * ("+86 138 0013 8000"), and that is the only passive source of the number —
 * the alternative is opening the contact-info drawer, which makes the UI flash.
 *
 * The guard matters: this must never turn a saved contact's name or a group
 * subject into a "phone number". `normalizePhone` alone is not enough — it
 * strips non-digits, so "Order 20240915" would come back as "20240915". So the
 * title has to consist of nothing but digits and phone punctuation.
 *
 * @param {string} title the conversation title as rendered
 * @returns {string} normalized digits, or '' when the title is not a number
 */
function phoneFromDisplayName(title) {
  const raw = String(title == null ? '' : title).trim();
  if (!raw) return '';
  // Digits, spaces (incl. NBSP), and the punctuation phone numbers are written
  // with — plus at most one leading '+'. Anything else means it is a name.
  if (!/^\+?[\d\s ()\-.]{6,}$/.test(raw)) return '';
  if ((raw.match(/\+/g) || []).length > 1) return '';
  return normalizePhone(raw);
}

/**
 * Mask a phone number for logging. Keeps the country code and last 3 digits.
 * Used to keep the "RECIPIENT VERIFIED" trace useful without leaking full PII.
 *
 * @param {string} phone
 * @returns {string}
 */
function maskPhone(phone) {
  const n = normalizePhone(phone);
  if (!n) return '(unverified)';
  if (n.length <= 6) return n[0] + '*'.repeat(n.length - 1);
  return n.slice(0, 2) + '*'.repeat(n.length - 5) + n.slice(-3);
}

/** @returns {string} ISO-8601 timestamp */
function nowIso() {
  return new Date().toISOString();
}

/** @returns {string} local wall clock as HH:MM:SS */
function nowClock() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * Clamp a number into [min, max].
 * @param {number} v @param {number} min @param {number} max
 * @returns {number}
 */
function clamp(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/**
 * Decide a message's direction from which side of the conversation column its
 * bubble hugs.
 *
 * The comparison is not obvious and was wrong once: an outgoing bubble sits
 * hard against the *right* edge, so its distance to the left edge is the large
 * one. Getting it backwards mislabels every message it decides.
 *
 * Measured live (2026-09-25, 1280px conversation column):
 *   outgoing → gapLeft 465–1124, gapRight 57–68
 *   incoming → gapLeft 62,       gapRight 830–1113
 *
 * A bubble that is far from *both* edges is not a message bubble at all
 * (a centred system notice, or a measurement taken before layout settled).
 *
 * @param {number} gapLeft distance from the bubble's left edge to the column's
 * @param {number} gapRight distance from the bubble's right edge to the column's
 * @param {number} paneWidth width of the conversation column
 * @returns {'incoming'|'outgoing'|'unknown'}
 */
function directionFromGaps(gapLeft, gapRight, paneWidth) {
  const half = paneWidth / 2;
  if (gapLeft > half && gapRight > half) return MESSAGE_DIRECTION.UNKNOWN;
  return gapLeft > gapRight ? MESSAGE_DIRECTION.OUTGOING : MESSAGE_DIRECTION.INCOMING;
}

/**
 * Serialize messages into the `CUSTOMER: / ME:` transcript handed to the AI.
 *
 * Lives here rather than in the adapter because the service worker also needs
 * it: the context window ("last N messages") is applied after the accumulated
 * history is read, so the transcript has to be rebuilt from the trimmed array.
 *
 * @param {Array<{direction?: string, text?: string}>} messages
 * @returns {string}
 */
function formatTranscript(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((m) => m && m.text)
    .map((m) => {
      const who =
        m.direction === MESSAGE_DIRECTION.OUTGOING
          ? 'ME'
          : m.direction === MESSAGE_DIRECTION.INCOMING
            ? 'CUSTOMER'
            : 'UNKNOWN';
      return `${who}: ${m.text}`;
    })
    .join('\n');
}

/**
 * Merge a stored config object over defaults, ignoring unknown and blank keys.
 * Only keys present in `defaults` are copied, so stray storage keys can never
 * smuggle unexpected fields into an AI request.
 *
 * @param {object} defaults
 * @param {object} incoming
 * @returns {object}
 */
function mergeConfig(defaults, incoming) {
  const out = Object.assign({}, defaults);
  if (!incoming || typeof incoming !== 'object') return out;
  for (const key of Object.keys(defaults)) {
    const v = incoming[key];
    if (v === undefined || v === null) continue;
    if (typeof defaults[key] === 'number') {
      const num = Number(v);
      if (Number.isFinite(num)) out[key] = num;
    } else if (typeof defaults[key] === 'string') {
      if (typeof v === 'string') out[key] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Text measurement (the panel shows words, not characters)
// ---------------------------------------------------------------------------

const CJK_RE = /[㐀-䶿一-鿿぀-ヿ가-힯豈-﫿]/;

/**
 * Count how long a piece of text is, in the units a human would use.
 *
 * Characters are a bad unit here: 120 characters is a full message in English
 * and a single clause in Chinese. So CJK ideographs are counted per character
 * and everything else per whitespace-delimited word.
 *
 * @param {string} text
 * @returns {{words: number, cjk: number, total: number}}
 */
function measureText(text) {
  const s = String(text == null ? '' : text);
  if (!s.trim()) return { words: 0, cjk: 0, total: 0 };
  let cjk = 0;
  let stripped = '';
  for (const ch of s) {
    if (CJK_RE.test(ch)) cjk += 1;
    else stripped += ch;
  }
  const words = (stripped.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu) || []).length;
  return { words, cjk, total: words + cjk };
}

/**
 * Human-readable length of a draft, e.g. "27 words" or "约 180 字".
 * Returns '' for empty text so callers can hide the element.
 *
 * @param {string} text
 * @returns {string}
 */
function describeTextLength(text) {
  const { words, cjk, total } = measureText(text);
  if (!total) return '';
  // CJK-dominant text is measured in characters; a mixed message falls back to
  // whichever count is larger, which is the one the reader would notice.
  if (cjk >= words) return `约 ${total} 字`;
  return `${words} word${words === 1 ? '' : 's'}`;
}

/**
 * Render a normalized phone number the way an international number is written.
 *
 * `normalizePhone` strips the '+', but a number without it is ambiguous — the
 * user asked for the fully-qualified form so it can be read and dialled from
 * anywhere. No digit grouping is applied: grouping rules are per-country, and a
 * wrong split (Brazil and China both look like they want one) is worse than no
 * split at all.
 *
 * @param {string} phone normalized digits, with or without a leading '+'
 * @returns {string} "+<digits>", or '' when there is nothing to show
 */
function formatPhoneDisplay(phone) {
  const digits = String(phone == null ? '' : phone).replace(/\D/g, '');
  return digits ? `+${digits}` : '';
}

// ---------------------------------------------------------------------------
// Message accumulation
//
// WhatsApp virtualises the message list: only a window of rows exists in the
// DOM at any moment, and scrolling replaces that window rather than extending
// it. Reading the DOM alone therefore makes the conversation appear to *shrink*
// as the user scrolls. The functions below rebuild a single, monotonically
// growing sequence per chat by aligning each freshly-read window against the
// stored one.
// ---------------------------------------------------------------------------

/** Separator that cannot occur in message text. */
const KEY_SEP = '\u0001';

/**
 * Identity of a message, used to align two windows.
 *
 * Direction + timestamp + text. Timestamps are minute-resolution in WhatsApp, so
 * two identical messages sent in the same minute collide — acceptable, because a
 * collision only ever merges two truly identical adjacent rows.
 *
 * @param {{direction?: string, timestamp?: string, text?: string}} m
 * @returns {string}
 */
function messageKey(m) {
  if (!m) return '';
  return [m.direction || '', m.timestamp || '', String(m.text || '').trim()].join(KEY_SEP);
}

/** Is this entry the "N messages not loaded" seam marker? */
function isGapMessage(m) {
  return !!(m && m.kind === 'gap');
}

/** Build the seam marker inserted where two disjoint windows were joined. */
function gapMessage(count) {
  const n = Math.max(1, Math.round(Number(count) || 0));
  return {
    direction: MESSAGE_DIRECTION.UNKNOWN,
    timestamp: '',
    kind: 'gap',
    text: `[... ${n} messages in this conversation are not loaded ...]`,
  };
}

/**
 * Find how the fresh window W sits relative to the stored sequence S.
 *
 * Tries every alignment offset and keeps the one with the most matching
 * messages, requiring both a minimum absolute number of matches and a minimum
 * match *ratio* — a long window will always share a few messages by accident,
 * and aligning on those would scramble the history.
 *
 * @param {Array<object>} stored
 * @param {Array<object>} fresh
 * @returns {{offset: number, matches: number, ratio: number}|null}
 *   `offset` is the index in S that corresponds to index 0 of W.
 */
function alignMessageWindows(stored, fresh) {
  if (!stored.length || !fresh.length) return null;

  const storedKeys = stored.map(messageKey);
  const freshKeys = fresh.map(messageKey);

  let best = null;
  // offset d means: fresh[j] corresponds to stored[j + d].
  for (let d = -(fresh.length - 1); d <= stored.length - 1; d += 1) {
    let overlap = 0;
    let matches = 0;
    for (let j = 0; j < fresh.length; j += 1) {
      const i = j + d;
      if (i < 0 || i >= stored.length) continue;
      overlap += 1;
      if (storedKeys[i] === freshKeys[j]) matches += 1;
    }
    if (!overlap) continue;
    const ratio = matches / overlap;
    // Require at least 2 anchors, or a complete match when the overlap is tiny
    // (a one-message window that matches must match exactly).
    const needed = Math.min(2, overlap);
    if (matches < needed) continue;
    if (ratio < 0.6) continue;
    if (!best || matches > best.matches || (matches === best.matches && ratio > best.ratio)) {
      best = { offset: d, matches, ratio };
    }
  }
  return best;
}

/**
 * Rebuild the union of a stored sequence and a freshly-read window.
 *
 * Guarantees the result never loses a message the stored sequence already had:
 * every stored index is present in the output. Fresh entries win where both
 * exist, because the DOM is the authority on what a message currently says.
 *
 * When the two windows do not overlap at all, they are joined with a seam
 * marker rather than silently concatenated, and the caller's `prepend` hint
 * decides which side the fresh window belongs on.
 *
 * @param {Array<object>} stored oldest → newest
 * @param {Array<object>} fresh oldest → newest
 * @param {{prepend?: boolean, maxMessages?: number}} [opts]
 *   `prepend` is only consulted when the windows are disjoint: true means the
 *   fresh window is *older* than everything stored (the user scrolled up).
 * @returns {Array<object>} oldest → newest
 */
function mergeMessageWindows(stored, fresh, opts = {}) {
  const S = Array.isArray(stored) ? stored.filter(Boolean) : [];
  const W = Array.isArray(fresh) ? fresh.filter(Boolean) : [];
  if (!S.length) return capFromTail(W, opts.maxMessages);
  if (!W.length) return capFromTail(S, opts.maxMessages);

  const align = alignMessageWindows(S, W);
  if (align) {
    const d = align.offset;
    const start = Math.min(0, d);
    const end = Math.max(S.length, d + W.length);
    const out = [];
    for (let i = start; i < end; i += 1) {
      const j = i - d;
      if (j >= 0 && j < W.length) out.push(W[j]);
      else if (i >= 0 && i < S.length) out.push(S[i]);
    }
    return capFromTail(out, opts.maxMessages);
  }

  // Disjoint. The fresh window is either entirely older (user scrolled up past
  // everything we had) or entirely newer (a message arrived and WhatsApp evicted
  // the whole previous window).
  const gap = gapMessage(Math.max(S.length, W.length));
  const joined = opts.prepend ? W.concat([gap], S) : S.concat([gap], W);
  return capFromTail(joined, opts.maxMessages);
}

/**
 * Trim an accumulated sequence to its caps, counting only real messages.
 *
 * The tail is what a reply must respond to, so trimming drops the oldest
 * entries. A seam marker left dangling at the head is removed with them.
 *
 * Two caps apply: a message count, and a total character budget. The character
 * budget is the one that actually protects `chrome.storage.local` — a chat full
 * of long messages blows past the count cap long before it hits it.
 *
 * @param {Array<object>} messages
 * @param {number} [maxMessages]
 * @param {number} [maxChars]
 * @returns {Array<object>}
 */
function capFromTail(messages, maxMessages, maxChars) {
  const cap = Math.max(10, Math.round(Number(maxMessages) || MESSAGE_STORE_LIMITS.MAX_MESSAGES_PER_CHAT));
  const charCap = Math.max(1000, Math.round(Number(maxChars) || MESSAGE_STORE_LIMITS.MAX_CHARS_PER_CHAT));
  let out = messages;

  if (out.length > cap) out = out.slice(out.length - cap);

  let total = out.reduce((n, m) => n + String((m && m.text) || '').length, 0);
  let from = 0;
  while (from < out.length - 1 && total > charCap) {
    total -= String((out[from] && out[from].text) || '').length;
    from += 1;
  }
  if (from) out = out.slice(from);

  while (out.length && isGapMessage(out[0])) out = out.slice(1);
  return out;
}

/**
 * Keep the newest `limit` messages, for the "last N" context options.
 * A limit of 0 (or anything falsy) means "keep everything".
 *
 * @param {Array<object>} messages
 * @param {number} limit
 * @returns {Array<object>}
 */
function limitMessages(messages, limit) {
  const n = Math.round(Number(limit) || 0);
  if (n <= 0 || messages.length <= n) return messages;
  return messages.slice(messages.length - n);
}

// ---------------------------------------------------------------------------
// The worker → side panel context contract
// ---------------------------------------------------------------------------

/**
 * The slice of a chat context the side panel is allowed to see.
 *
 * Deliberately a whitelist: `messages`, `transcript` and `diagnostics` are large
 * and the panel has no use for them.
 *
 * It has to carry **every** field the panel reads, though, and that is not
 * self-enforcing. `hasOpenChat` was missing from the hand-built object
 * GENERATE_REPLY returned, so the panel's `!current.hasOpenChat` test saw
 * `undefined`, took it for "no conversation is open", and printed the red
 * "No conversation is open. Click a chat in WhatsApp Web." notice directly
 * under the green "AI reply ready — review it, then Send." one — while
 * disabling Generate and Send — immediately after a Generate that had just
 * succeeded.
 *
 * Both routes that hand a context to the panel now go through here, so they
 * cannot drift apart again, and `tools/test-safety.js` checks the output
 * against the fields the panel actually reads.
 *
 * @param {object} ctx full context as returned by the content script
 * @returns {object}
 */
function publicContext(ctx) {
  const c = ctx || {};
  return {
    hasOpenChat: !!c.hasOpenChat,
    chatId: c.chatId,
    chatIdStable: c.chatIdStable,
    chatKey: c.chatKey,
    contactName: c.contactName,
    phone: c.phone,
    phoneStatus: c.phoneStatus,
    isGroup: c.isGroup,
    loadedInDom: c.loadedInDom,
    counts: c.counts,
  };
}

// ---------------------------------------------------------------------------
// Per-chat instructions
// ---------------------------------------------------------------------------

/**
 * Fold a per-chat instruction into the system prompt.
 *
 * The instruction is appended to the SYSTEM message rather than added as a
 * second user turn, because that is the only way to give it real precedence:
 * everything in the system message outranks the user message, so a line like
 * "ask how the trial installation went" reliably shapes the reply instead of
 * competing with the transcript.
 *
 * Precedence is not absolute, though. The last paragraph re-states the
 * no-invention rules, so a per-chat instruction cannot talk the model into
 * quoting a price or a delivery date it made up. The store is per chat, so this
 * is the salesperson's own note about their own customer — but it is still
 * free-form text arriving from a textbox, and the guard rail costs one
 * sentence.
 *
 * @param {string} instruction
 * @returns {string} '' when there is nothing to add, so callers can concatenate
 */
function instructionBlock(instruction) {
  const text = String(instruction == null ? '' : instruction).trim();
  if (!text) return '';
  return [
    '',
    '',
    'ADDITIONAL INSTRUCTION FOR THIS CONVERSATION',
    '(from the salesperson, about this customer specifically)',
    text.slice(0, INSTRUCTION_LIMITS.MAX_CHARS),
    '',
    'Where this conflicts with the guidance above, it takes priority.',
    'It does not override the rules about not inventing prices, specifications,',
    'certifications, delivery promises, stock, discounts or payment terms.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// AI budget derivation
// ---------------------------------------------------------------------------

/**
 * Bring a STORED config forward to the current schema.
 *
 * This runs on the raw object from storage, before it is merged over the
 * defaults — merging first would stamp the current `configVersion` onto an old
 * config and the migration would never fire.
 *
 * v1 → v2: v1 shipped `maxTokens: 300`, which is smaller than the reasoning
 * budget of the configured model on its own. Every request therefore came back
 * with `finish_reason: "length"`, no content, and the message "The AI returned
 * an empty reply". A stored 300 is the old default rather than a decision, so it
 * is handed back to auto (0).
 *
 * v2 → v3: the project was published, and its built-in prompt stopped being
 * about one company's vending machines. A stored prompt that is still
 * byte-for-byte the old default was never edited by anyone, so it is replaced;
 * a prompt the user actually wrote is left exactly as it is. The connection
 * fields — Base URL, key, model — are NOT touched by this migration. Whatever a
 * working install already points at keeps working, even though a fresh install
 * of the published build starts with all of them blank.
 *
 * @param {object|null} raw the value straight out of chrome.storage.local
 * @returns {object|null} a migrated copy
 */
function migrateStoredConfig(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  if (Number(raw.configVersion) >= CONFIG_VERSION) return raw;
  const out = Object.assign({}, raw);
  if (Number(out.maxTokens) === 300) out.maxTokens = 0;
  if (typeof out.systemPrompt === 'string' && out.systemPrompt.trim() === LEGACY_SYSTEM_PROMPT_VENDING) {
    out.systemPrompt = DEFAULT_SYSTEM_PROMPT;
  }
  out.configVersion = CONFIG_VERSION;
  return out;
}

/**
 * Decide the `max_tokens` ceiling for a request.
 *
 * A configured value wins — the user asked for a number, they get it. Otherwise
 * it is derived from the two things that actually decide how much room the model
 * needs: how long the answer should be, and how much it may think first.
 *
 * This exists because the previous flat default (300) was smaller than the
 * reasoning budget on its own, so the model spent the whole allowance thinking
 * and returned no content at all.
 *
 * @param {object} cfg
 * @returns {number}
 */
function resolveMaxTokens(cfg) {
  const explicit = Math.round(Number(cfg && cfg.maxTokens) || 0);
  if (explicit > 0) return clamp(explicit, 16, AI_LIMITS.MAX_TOKENS_CEILING);

  const lengthSpec = REPLY_LENGTH_SPECS[(cfg && cfg.replyLength) || REPLY_LENGTH.MEDIUM] || REPLY_LENGTH_SPECS.medium;
  const thinkSpec = THINKING_SPECS[(cfg && cfg.thinking) || 'auto'] || THINKING_SPECS.auto;
  return clamp(
    lengthSpec.outputTokens + thinkSpec.reserveTokens,
    16,
    AI_LIMITS.MAX_TOKENS_CEILING,
  );
}

/**
 * Build the provider's `thinking` field for a mode, or null to omit it.
 *
 * `auto` returns null on purpose: sending a thinking field to a model that does
 * not support it is an HTTP 400, and omitting it is exactly what "whatever the
 * model decides" means.
 *
 * @param {string} mode one of THINKING_MODE
 * @returns {{type: string, budget_tokens?: number}|null}
 */
function thinkingRequestParam(mode) {
  const spec = THINKING_SPECS[mode];
  if (!spec || !spec.type) return null;
  const param = { type: spec.type };
  if (spec.type === 'enabled' && spec.budgetTokens) param.budget_tokens = spec.budgetTokens;
  return param;
}

/**
 * Strip trailing slashes from a base URL so `${base}/chat/completions` never
 * produces a double slash. Returns '' for non-strings.
 *
 * @param {string} url
 * @returns {string}
 */
function normalizeBaseUrl(url) {
  if (typeof url !== 'string') return '';
  return url.trim().replace(/\/+$/, '');
}

/**
 * Resolve an OpenAI-compatible API base URL to its chat/completions endpoint.
 *
 * Accepts every shape a user might paste into Settings:
 *   https://api.example.com                  → https://api.example.com/v1/chat/completions
 *   https://api.example.com/                 → …/v1/chat/completions
 *   https://api.example.com/v1               → …/v1/chat/completions
 *   https://api.example.com/v1/chat/completions → unchanged
 *
 * @param {string} base
 * @returns {string}
 */
function resolveChatEndpoint(base) {
  const b = normalizeBaseUrl(base);
  if (!b) return '';
  if (/\/chat\/completions$/.test(b)) return b;
  if (/\/v\d+$/.test(b)) return `${b}/chat/completions`;
  return `${b}/v1/chat/completions`;
}

/**
 * Resolve an OpenAI-compatible API base URL to its models endpoint.
 * @param {string} base
 * @returns {string}
 */
function resolveModelsEndpoint(base) {
  const b = normalizeBaseUrl(base);
  if (!b) return '';
  if (/\/models$/.test(b)) return b;
  if (/\/v\d+$/.test(b)) return `${b}/models`;
  return `${b}/v1/models`;
}

/**
 * Classify a fetch failure into one of the FALLBACK_ELIGIBLE codes, or null when
 * the failure is a configuration/API error that must NOT trigger a fallback.
 *
 * `fetch` rejects with a TypeError for genuine transport failures (DNS, refused
 * connection, TLS, offline). An AbortError means we hit our own timeout.
 *
 * @param {Error} err
 * @returns {string|null}
 */
function classifyNetworkError(err) {
  if (!err) return null;
  if (err.code === 'TIMEOUT' || err.name === 'AbortError') return 'CONNECTION_TIMEOUT';
  if (err.name === 'TypeError') {
    const msg = String(err.message || '').toLowerCase();
    if (msg.includes('dns') || msg.includes('name not resolved') || msg.includes('name resolution')) {
      return 'DNS_FAILURE';
    }
    if (msg.includes('refused')) return 'CONNECTION_REFUSED';
    if (msg.includes('certificate') || msg.includes('ssl') || msg.includes('tls')) return 'TLS_ERROR';
    return 'NETWORK_ERROR';
  }
  return null;
}

/**
 * Turn an HTTP status + provider error body into a short, truthful, user-facing
 * message. The Settings "Test Connection" panel shows exactly this text, so it
 * must name the real problem rather than "Something went wrong".
 *
 * @param {number} status
 * @param {string} providerMessage
 * @returns {string}
 */
function describeHttpFailure(status, providerMessage) {
  const detail = (providerMessage || '').trim();
  const short = detail.length > 140 ? `${detail.slice(0, 140)}…` : detail;
  const base = (() => {
    if (status === 401 || status === 403) return 'Authentication failed — check the API key';
    if (status === 404) return 'API endpoint invalid — check the Base URL';
    if (status === 429) return 'Rate limited by the provider';
    if (status === 400) return 'Bad request — the model may not accept these parameters';
    if (status >= 500) return `Provider server error (HTTP ${status})`;
    return `Request failed (HTTP ${status})`;
  })();
  return short ? `${base}: ${short}` : base;
}

/** Promise-based sleep. @param {number} ms */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Reject with a TIMEOUT-coded error if `promise` does not settle within `ms`.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} [label]
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(label || 'TIMEOUT');
      err.code = ERR.TIMEOUT;
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Structured logger. NEVER pass API keys, tokens or Authorization headers.
 * @param {...unknown} args
 */
function log(...args) {
  // eslint-disable-next-line no-console
  console.log(LOG_PREFIX, ...args);
}

/** @param {...unknown} args */
function logError(...args) {
  // eslint-disable-next-line no-console
  console.error(LOG_PREFIX, ...args);
}
// ---------------------------------------------------------------------------
// ES module exports (see constants.js for why this coexists with classic-script
// loading).
// ---------------------------------------------------------------------------

