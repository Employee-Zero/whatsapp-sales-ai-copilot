#!/usr/bin/env node
/**
 * Offline unit tests for the pure logic that everything else depends on.
 *
 * These do NOT need Chrome. They cover:
 *   1. phone normalization handles every format WhatsApp actually renders
 *   2. masking never leaks a full number into a log
 *   3. the send-related error codes the panel maps to user-facing text
 *   4. endpoint resolution, defaults, fallback eligibility, HTTP failure text
 *
 * Run: node tools/test-safety.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

/**
 * Load a dependency-free shared file into a sandbox that mimics a browser
 * classic-script global scope.
 */
function loadShared() {
  // `URL` is part of the platform, not of the bundle: the helper-address rules
  // parse one, and a sandbox without it would exercise the catch branch instead
  // of the code under test.
  const sandbox = { console, URL };
  vm.createContext(sandbox);
  const src = ['src/shared/constants.classic.js', 'src/shared/utils.classic.js']
    .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8'))
    .join('\n;\n');
  // `const` declarations live in the script's lexical scope, not on the global
  // object — append an explicit export so the test can read them.
  vm.runInContext(`${src}\n;globalThis.__shared = {publicContext, instructionBlock, AI_LIMITS, DEFAULT_AI_CONFIG, AI_CONFIG_STRING_KEYS, AI_CONFIG_NUMBER_RANGES, FALLBACK_ELIGIBLE, MESSAGE_DIRECTION, DELIVERY_STATUS_LABELS, STORAGE_KEYS, MSG, ERR, PHONE_STATUS, LOG_PREFIX, WHATSAPP_ORIGIN, DEFAULT_SYSTEM_PROMPT, LEGACY_SYSTEM_PROMPT_VENDING, REQUIRED_AI_FIELDS, REQUIRED_CHATGPT_FIELDS, AI_FIELD_LABELS, missingAiFields, hasRequiredConfig, connectionModeOf, CONNECTION_MODE, CONNECTION_MODE_SPECS, CHATGPT_HELPER_DEFAULT_URL, CHATGPT_HELPER_PATHS, CHATGPT_SCOPES, CHATGPT_RESOURCE, CHATGPT_PLAN_SCOPE, helperBaseUrl, helperStartCommand, REPLY_LENGTH, REPLY_LENGTH_SPECS, THINKING_MODE, THINKING_SPECS, CONTEXT_MESSAGE_CHOICES, MESSAGE_STORE_LIMITS, DRAFT_LIMITS, INSTRUCTION_LIMITS, CONFIG_VERSION};`, sandbox, {
    filename: 'shared-bundle.js',
  });
  return sandbox;
}

const sandbox = loadShared();
const S = Object.assign({}, sandbox, sandbox.__shared);

let pass = 0;
let fail = 0;

/**
 * @param {string} name
 * @param {boolean} cond
 * @param {string} [detail]
 */
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? `  → ${detail}` : ''}`);
  }
}

function eq(name, actual, expected) {
  check(name, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

console.log('\n[1] normalizePhone — formats WhatsApp actually renders\n');

const normCases = [
  ['+86 138 0013 8000', '8613800138000'],
  ['+86 139 0013 9000', '8613900139000'],
  ['+8613800138000', '8613800138000'],
  ['8613800138000', '8613800138000'],
  ['0086 138 0013 8000', '8613800138000'],
  ['+86-138-0013-8000', '8613800138000'],
  ['+86 (138) 0013-8000', '8613800138000'],
  ['  +86 138 0013 8000  ', '8613800138000'],
  ['+86 138 0013 8000', '8613800138000'], // non-breaking spaces
  ['+86 138 0013 8000', '8613800138000'], // bidi marks WhatsApp injects
  ['+86 138 0013 8000', '8613800138000'], // LRM
  ['+1 (555) 010-0002', '15550100002'],
  ['08613800138000', '8613800138000'], // national trunk "0" is stripped
  ['861380013800', '861380013800'], // 12 digits IS a valid length — not "too short"
  ['+861380013800', '861380013800'], // same number written internationally
  ['8619026', ''], // 7 digits — genuinely too short
  ['+86138001380001234567890', ''], // too long (>15)
  ['Sam', ''],
  ['', ''],
  [null, ''],
  [undefined, ''],
  ['000000', ''],
];

for (const [input, expected] of normCases) {
  eq(`normalizePhone(${JSON.stringify(input)})`, S.normalizePhone(input), expected);
}

console.log('\n[2] phoneFromDisplayName — a chat title is only a phone if it IS one\n');

// WhatsApp prints an unsaved contact's number as the conversation title, and
// that is the only passive source of the number. The guard has to be strict:
// a saved contact's name or a group subject must never become a "phone number".
const titleIsPhone = [
  ['+86 138 0013 8000', '8613800138000'],
  ['86 138 0013 8000', '8613800138000'],
  ['+86-138-0013-8000', '8613800138000'],
  ['+1 (555) 010-0002', '15550100002'],
  ['15550100002', '15550100002'],
];
for (const [input, expected] of titleIsPhone) {
  eq(`title ${JSON.stringify(input)} → number`, S.phoneFromDisplayName(input), expected);
}

const titleIsNotPhone = [
  'Sam',
  'Carol',
  'Acme Vending · Dealers',
  'John 2024',
  'Order 20240915', // digits, but embedded in words — must NOT be read as a number
  '86 138 0013 8000 ext 12', // has letters
  'Alice (sales)',
  '+86 138 0013 8000 +86 139 0013 9000', // two numbers — ambiguous, refuse
  '',
  null,
  undefined,
  '0000000',
];
for (const bad of titleIsNotPhone) {
  eq(`title ${JSON.stringify(bad)} → not a number`, S.phoneFromDisplayName(bad), '');
}

// Known and accepted: an all-numeric title that happens to be a date IS read as
// a number. It is display-only — nothing in the send path consults the phone —
// so the cost of the false positive is a cosmetic one, and tightening the rule
// further would start rejecting real numbers.
eq('an all-numeric title is read as a number', S.phoneFromDisplayName('2024-09-15'), '20240915');

console.log('\n[3] maskPhone — logging must not leak full numbers\n');

const masked = S.maskPhone('8613800138000');
check('masks middle digits', masked.includes('*') && masked.endsWith('000'), `got ${masked}`);
check('does not contain the full number', !masked.includes('8613800138000'));
eq('empty input → (unverified)', S.maskPhone(''), '(unverified)');
eq('a name is not masked into digits', S.maskPhone('Carol'), '(unverified)');

console.log('\n[4] error codes the panel maps to user-facing text\n');

for (const key of [
  'NO_CHAT_OPEN',
  'NO_MESSAGES',
  'COMPOSER_NOT_FOUND',
  'SEND_BUTTON_NOT_FOUND',
  'AI_NOT_CONFIGURED',
  'AI_AUTH_FAILED',
  'AI_EMPTY',
  'AI_TRUNCATED',
  'EMPTY_MESSAGE',
  'CHAT_CHANGED',
  'BUSY',
  'WHATSAPP_NOT_OPEN',
]) {
  check(`ERR.${key} exists`, typeof S.ERR[key] === 'string' && S.ERR[key].length > 0);
}

// The allowlist is gone: no send path may still be gated on a recipient.
check(
  'no allowlist error codes remain',
  !Object.keys(S.ERR).some((k) => /ALLOWLIST|PHONE_UNVERIFIED/.test(k)),
  Object.keys(S.ERR).join(','),
);

console.log('\n[5] mergeConfig — stray storage keys cannot inject fields\n');

const merged = S.mergeConfig(
  { baseUrl: 'https://x/v1', apiKey: '', model: 'm', temperature: 0.4, maxTokens: 300, timeoutMs: 30000 },
  { apiKey: 'secret', evil: 'payload', baseUrl: 123, temperature: '0.9' },
);
eq('keeps numeric string as number', merged.temperature, 0.9);
eq('ignores wrong-typed baseUrl', merged.baseUrl, 'https://x/v1');
check('does not copy unknown keys', !('evil' in merged));
eq('copies known string key', merged.apiKey, 'secret');

console.log('\n[6] constants sanity\n');

check('LOG_PREFIX present', typeof S.LOG_PREFIX === 'string' && S.LOG_PREFIX.length > 0);
check('ERR codes are strings', Object.values(S.ERR).every((v) => typeof v === 'string'));
check('PHONE_STATUS.VERIFIED defined', S.PHONE_STATUS.VERIFIED === 'verified');
check(
  'content-script message names are unique',
  new Set(Object.values(S.MSG)).size === Object.keys(S.MSG).length,
);
check(
  'no allowlist constant is exported any more',
  !('ALLOWED_TEST_RECIPIENTS' in S) && !('ALLOWED_TEST_RECIPIENTS_DISPLAY' in S),
);

console.log('\n[7] resolveChatEndpoint — Base URL forms the user may paste\n');

const epCases = [
  ['https://api.example.com', 'https://api.example.com/v1/chat/completions'],
  ['https://api.example.com/', 'https://api.example.com/v1/chat/completions'],
  ['https://api.example.com/v1', 'https://api.example.com/v1/chat/completions'],
  ['https://api.example.com/v1/', 'https://api.example.com/v1/chat/completions'],
  ['https://api.example.com/v1/chat/completions', 'https://api.example.com/v1/chat/completions'],
  ['https://other-provider.example', 'https://other-provider.example/v1/chat/completions'],
  ['', ''],
  [null, ''],
];
for (const [input, expected] of epCases) {
  eq(`resolveChatEndpoint(${JSON.stringify(input)})`, S.resolveChatEndpoint(input), expected);
}

console.log('\n[8] defaults — no provider, no model, no key\n');

// The published build must not name anybody's service. A default Base URL or
// model id would be an endorsement the project cannot make, and would send a
// first-run user's requests somewhere they never chose.
eq('no default base url', S.DEFAULT_AI_CONFIG.primaryBaseUrl, '');
eq('no default fallback url', S.DEFAULT_AI_CONFIG.fallbackBaseUrl, '');
eq('no default model', S.DEFAULT_AI_CONFIG.model, '');
// A key committed here would ship with the source and be spent by anyone who
// cloned it. The panel asks for one instead.
check('no api key is committed', S.DEFAULT_AI_CONFIG.apiKey === '');
check('defaults are frozen', Object.isFrozen(S.DEFAULT_AI_CONFIG));

console.log('\n[8b] hasRequiredConfig — what "not set up yet" means\n');

check('an empty config is not configured', S.hasRequiredConfig(S.DEFAULT_AI_CONFIG) === false);
eq('every blank required field is named', S.missingAiFields(S.DEFAULT_AI_CONFIG).join(','), 'primaryBaseUrl,apiKey,model');
check('a fallback url is never required',
  S.hasRequiredConfig({ primaryBaseUrl: 'https://a.example', apiKey: 'k', model: 'm', fallbackBaseUrl: '' }) === true);
check('whitespace does not count as filled',
  S.hasRequiredConfig({ primaryBaseUrl: '  ', apiKey: 'k', model: 'm' }) === false);
check('a key without a model is still not configured',
  S.hasRequiredConfig({ primaryBaseUrl: 'https://a.example', apiKey: 'k', model: '' }) === false);
check('every required field has a human label',
  S.REQUIRED_AI_FIELDS.every((f) => typeof S.AI_FIELD_LABELS[f] === 'string' && S.AI_FIELD_LABELS[f]));

console.log('\n[9] fallback eligibility — only connectivity failures may switch host\n');

check('network error IS fallback-eligible', S.FALLBACK_ELIGIBLE.includes('NETWORK_ERROR'));
check('timeout IS fallback-eligible', S.FALLBACK_ELIGIBLE.includes('CONNECTION_TIMEOUT'));
check('401/403 auth is NOT fallback-eligible', !S.FALLBACK_ELIGIBLE.includes('HTTP_ERROR'));
check('model not found is NOT fallback-eligible', !S.FALLBACK_ELIGIBLE.includes('MODEL_NOT_FOUND'));
check('bad request is NOT fallback-eligible', !S.FALLBACK_ELIGIBLE.includes('BAD_REQUEST'));

console.log('\n[10] describeHttpFailure — must name the real problem\n');

check('401 says authentication', /Authentication failed/i.test(S.describeHttpFailure(401, '')));
check('403 says authentication', /Authentication failed/i.test(S.describeHttpFailure(403, '')));
check('404 says endpoint invalid', /endpoint invalid/i.test(S.describeHttpFailure(404, '')));
check('429 says rate limited', /[Rr]ate limited/.test(S.describeHttpFailure(429, '')));
check('500 mentions the status', /500/.test(S.describeHttpFailure(500, '')));
check('surfaces the provider message', /model_not_found/.test(S.describeHttpFailure(400, 'model_not_found')));
check('never says "Something went wrong"', !/something went wrong/i.test(S.describeHttpFailure(400, '')));

console.log('\n[11] classifyNetworkError — fetch TypeError → connectivity\n');

eq('TypeError → NETWORK_ERROR', S.classifyNetworkError(new TypeError('Failed to fetch')), 'NETWORK_ERROR');
eq('refused → CONNECTION_REFUSED', S.classifyNetworkError(new TypeError('connection refused')), 'CONNECTION_REFUSED');
eq('DNS → DNS_FAILURE', S.classifyNetworkError(new TypeError('DNS lookup failed')), 'DNS_FAILURE');
eq('AbortError → CONNECTION_TIMEOUT', S.classifyNetworkError(Object.assign(new Error('x'), { name: 'AbortError' })), 'CONNECTION_TIMEOUT');
eq('our TIMEOUT code → CONNECTION_TIMEOUT', S.classifyNetworkError(Object.assign(new Error('x'), { code: 'TIMEOUT' })), 'CONNECTION_TIMEOUT');
eq('an HTTP error is not a network error', S.classifyNetworkError(Object.assign(new Error('HTTP 401'), { failureClass: 'HTTP_ERROR' })), null);

console.log('\n[12] directionFromGaps — the comparison that was inverted\n');

// Every pair below was measured on the live Comet page on 2026-09-25, in a
// 1280px conversation column. The first four are outgoing, the last three
// incoming. `gapLeft > gapRight → outgoing`: an outgoing bubble is pinned to
// the RIGHT edge, so its LEFT gap is the big one.
const W = 1280;
const measured = [
  [465, 68, 'outgoing'], // chat +86 138 0013 8000, own message
  [474, 80, 'outgoing'], // same, wrapped to full bubble width
  [991, 68, 'outgoing'], // same, short message
  [1124, 57, 'outgoing'], // chat +86 139 0013 9000, own message
  [62, 1113, 'incoming'], // same chat, message from the contact
  [62, 830, 'incoming'], // chat +1 (555) 010-0002
  [62, 830, 'incoming'], // chat +1 (555) 010-0002
];
for (const [l, r, want] of measured) {
  eq(`gapLeft ${l} / gapRight ${r} → ${want}`, S.directionFromGaps(l, r, W), want);
}

eq('a wide own bubble is still outgoing', S.directionFromGaps(474, 80, W), 'outgoing');
eq('a wide own bubble is NOT incoming', S.directionFromGaps(474, 80, W) !== 'incoming', true);
eq('far from both edges → unknown (centred system notice)', S.directionFromGaps(700, 700, W), 'unknown');
eq('equidistant but not centred → incoming', S.directionFromGaps(300, 300, W), 'incoming');
eq('zero-width column cannot decide', typeof S.directionFromGaps(0, 0, 0), 'string');

console.log('\n[13] message-direction constants\n');

eq('MESSAGE_DIRECTION.OUTGOING', S.MESSAGE_DIRECTION.OUTGOING, 'outgoing');
eq('MESSAGE_DIRECTION.INCOMING', S.MESSAGE_DIRECTION.INCOMING, 'incoming');
eq('MESSAGE_DIRECTION.UNKNOWN', S.MESSAGE_DIRECTION.UNKNOWN, 'unknown');
check('directionFromGaps returns only declared directions', measured.every(([l, r]) =>
  Object.values(S.MESSAGE_DIRECTION).includes(S.directionFromGaps(l, r, W))));
check('delivery-status labels cover zh read/delivered', ['已读', '已送达'].every((s) => S.DELIVERY_STATUS_LABELS.includes(s)));
check('delivery-status labels cover en read/delivered', ['Read', 'Delivered'].every((s) => S.DELIVERY_STATUS_LABELS.includes(s)));

console.log('\n[14] resolveMaxTokens — the budget that made replies come back empty\n');

// The old default was a flat 300, which is smaller than the reasoning budget on
// its own. Every request came back finish_reason:"length", zero content, and the
// user saw "The AI returned an empty reply".
const cfgWith = (o) => Object.assign({}, S.DEFAULT_AI_CONFIG, o);

check('an explicit value wins', S.resolveMaxTokens(cfgWith({ maxTokens: 1234 })) === 1234);
check('0 means automatic', S.resolveMaxTokens(cfgWith({ maxTokens: 0, replyLength: 'short', thinking: 'off' })) > 0);
check('auto is always above the old broken 300',
  ['short', 'medium', 'long'].every((replyLength) =>
    ['off', 'auto', 'low', 'high'].every((thinking) =>
      S.resolveMaxTokens(cfgWith({ maxTokens: 0, replyLength, thinking })) > 300)));
check('thinking raises the budget', S.resolveMaxTokens(cfgWith({ maxTokens: 0, replyLength: 'medium', thinking: 'high' }))
  > S.resolveMaxTokens(cfgWith({ maxTokens: 0, replyLength: 'medium', thinking: 'off' })));
check('longer replies get more room', S.resolveMaxTokens(cfgWith({ maxTokens: 0, replyLength: 'long', thinking: 'off' }))
  > S.resolveMaxTokens(cfgWith({ maxTokens: 0, replyLength: 'short', thinking: 'off' })));
check('never exceeds the ceiling', S.resolveMaxTokens(cfgWith({ maxTokens: 999999 })) === S.AI_LIMITS.MAX_TOKENS_CEILING);
check('never goes below 16', S.resolveMaxTokens(cfgWith({ maxTokens: 1 })) >= 16);
check('the shipped default is automatic', S.DEFAULT_AI_CONFIG.maxTokens === 0);
check('the ceiling covers the largest auto budget',
  S.REPLY_LENGTH_SPECS.long.outputTokens + S.THINKING_SPECS.high.reserveTokens <= S.AI_LIMITS.MAX_TOKENS_CEILING);
check('an explicit budget above the thinking budget leaves room to answer',
  ['low', 'high'].every((thinking) =>
    S.resolveMaxTokens(cfgWith({ maxTokens: 0, replyLength: 'long', thinking })) > S.THINKING_SPECS[thinking].budgetTokens));

console.log('\n[15] thinkingRequestParam — the field must not be sent on auto\n');

eq('auto omits the field entirely (a model without thinking would 400)', S.thinkingRequestParam('auto'), null);
eq('off disables it', S.thinkingRequestParam('off').type, 'disabled');
eq('low enables it with a budget', S.thinkingRequestParam('low').type, 'enabled');
check('low carries budget_tokens', S.thinkingRequestParam('low').budget_tokens > 0);
check('high budgets more than low',
  S.thinkingRequestParam('high').budget_tokens > S.thinkingRequestParam('low').budget_tokens);
eq('an unknown mode is treated as auto', S.thinkingRequestParam('nonsense'), null);
check('a disabled mode carries no budget', S.thinkingRequestParam('off').budget_tokens === undefined);

console.log('\n[16] reply-length levels are purpose-based, not sentence counts\n');

check('three levels', Object.keys(S.REPLY_LENGTH_SPECS).length === 3);
check('every level has a word ceiling', Object.values(S.REPLY_LENGTH_SPECS).every((s) => s.words > 0));
check('every level has guidance for the model', Object.values(S.REPLY_LENGTH_SPECS).every((s) => /LENGTH:/.test(s.guidance)));
check('ceilings increase short → medium → long',
  S.REPLY_LENGTH_SPECS.short.words < S.REPLY_LENGTH_SPECS.medium.words &&
  S.REPLY_LENGTH_SPECS.medium.words < S.REPLY_LENGTH_SPECS.long.words);
check('short is not a hard one-sentence rule', !/one sentence/i.test(S.REPLY_LENGTH_SPECS.short.guidance));
check('short still allows the question that is the point of the message',
  /question/i.test(S.REPLY_LENGTH_SPECS.short.guidance));
check('medium is the default', S.DEFAULT_AI_CONFIG.replyLength === 'medium');
check('thinking defaults to auto', S.DEFAULT_AI_CONFIG.thinking === 'auto');

console.log('\n[17] describeTextLength / measureText — words, not characters\n');

eq('empty → empty', S.describeTextLength(''), '');
eq('one English word', S.describeTextLength('Hello'), '1 word');
eq('three English words', S.describeTextLength('How are you'), '3 words');
check('punctuation is not a word', S.describeTextLength('Hi, -- there!') === '2 words');
check('CJK is counted in characters', /字$/.test(S.describeTextLength('你好，请问价格是多少？')));
check('a CJK message is not reported as "1 word"', S.describeTextLength('你好，请问价格是多少？') !== '1 word');
check('a mixed message counts both', S.measureText('OK 好的').total === 3);

console.log('\n[18] formatPhoneDisplay — always the full international form\n');

eq('adds the +', S.formatPhoneDisplay('861380013801'), '+861380013801');
eq('does not double the +', S.formatPhoneDisplay('+861380013801'), '+861380013801');
eq('strips spaces', S.formatPhoneDisplay('+86 138 0013 8000'), '+8613800138000');
eq('empty in, empty out', S.formatPhoneDisplay(''), '');
eq('null in, empty out', S.formatPhoneDisplay(null), '');

console.log('\n[19] mergeMessageWindows — the count must only ever grow\n');

const M = (direction, timestamp, text) => ({ direction, timestamp, text, kind: 'text' });

// A conversation of 10 messages. Each window below is a slice of it, exactly as
// WhatsApp's virtualised list would render it.
const full = [];
for (let i = 0; i < 10; i += 1) {
  full.push(M(i % 2 ? 'outgoing' : 'incoming', `10:0${i}`, `message ${i}`));
}

// The bug the user reported: 7 messages on open, then FEWER after scrolling.
let acc = S.mergeMessageWindows([], full.slice(4, 10));
eq('first read stores the window', acc.length, 6);
acc = S.mergeMessageWindows(acc, full.slice(0, 6));
eq('scrolling up adds the older ones', acc.length, 10);
check('scrolling up never shrinks', acc.length >= 6);
eq('the union is the whole conversation, in order', acc.map((m) => m.text).join('|'), full.map((m) => m.text).join('|'));

// Re-reading the same window must be a no-op, not a reset.
eq('a repeat read changes nothing', S.mergeMessageWindows(acc, full.slice(4, 10)).length, 10);
// A window that moved down (a message arrived, one was evicted at the top).
eq('a shifted window still merges to the full set', S.mergeMessageWindows(acc, full.slice(2, 10)).length, 10);
// Scrolling back to the bottom after visiting the top.
eq('scrolling back down keeps everything', S.mergeMessageWindows(acc, full.slice(7, 10)).length, 10);

// Disjoint windows: the seam must be marked, never silently concatenated.
const gapPrepend = S.mergeMessageWindows(full.slice(5, 10), full.slice(0, 3), { prepend: true });
eq('an older disjoint window is prepended', gapPrepend.length, 3 + 1 + 5);
eq('prepended content comes first', gapPrepend[0].text, 'message 0');
check('the seam is marked', gapPrepend[3].kind === 'gap');
check('the seam says how many are missing', /\d+ messages/.test(gapPrepend[3].text));

const gapAppend = S.mergeMessageWindows(full.slice(0, 4), full.slice(7, 10), { prepend: false });
eq('a newer disjoint window is appended', gapAppend[gapAppend.length - 1].text, 'message 9');
check('the appended seam is marked', gapAppend[4].kind === 'gap');

// Alignment must not be fooled by a couple of coincidental matches.
const decoy = [M('incoming', '10:00', 'message 0'), M('incoming', '99:99', 'unrelated'), M('incoming', '99:98', 'also unrelated')];
check('a mostly-unrelated window is not aligned onto the history',
  S.mergeMessageWindows(full, decoy).length >= full.length);

eq('an empty stored sequence takes the window', S.mergeMessageWindows([], full).length, 10);
eq('an empty window keeps the stored sequence', S.mergeMessageWindows(full, []).length, 10);
eq('both empty', S.mergeMessageWindows([], []).length, 0);

// Two identical messages in the same minute collide — acceptable, and it must
// not lose either of them.
const dupes = [M('outgoing', '10:00', 'ok'), M('outgoing', '10:00', 'ok'), M('outgoing', '10:00', 'ok')];
eq('identical repeats survive a merge', S.mergeMessageWindows(dupes, dupes).length, 3);

// Caps.
const many = [];
for (let i = 0; i < 50; i += 1) many.push(M('incoming', `1:${i}`, `m${i}`));
eq('the message cap trims from the head', S.capFromTail(many, 10).length, 10);
eq('the cap keeps the NEWEST messages', S.capFromTail(many, 10)[9].text, 'm49');
const longOnes = [];
for (let i = 0; i < 50; i += 1) longOnes.push(M('incoming', `1:${i}`, `m${i} ${'x'.repeat(200)}`));
check('the character cap trims too', S.capFromTail(longOnes, 1000, 1000).length < 50);
check('the character cap keeps the newest',
  S.capFromTail(longOnes, 1000, 1000).slice(-1)[0].text.startsWith('m49'));
check('a merged result respects the cap', S.mergeMessageWindows(many.slice(0, 25), many.slice(25), { maxMessages: 30 }).length <= 30);

console.log('\n[20] limitMessages — the "last N" context option\n');

eq('0 keeps everything', S.limitMessages(full, 0).length, 10);
eq('undefined keeps everything', S.limitMessages(full, undefined).length, 10);
eq('last 3', S.limitMessages(full, 3).length, 3);
eq('the newest are the ones kept', S.limitMessages(full, 3)[2].text, 'message 9');
eq('a limit larger than the list is harmless', S.limitMessages(full, 99).length, 10);
eq('the default context option is everything', S.DEFAULT_AI_CONFIG.contextMessages, 0);

console.log('\n[21] formatTranscript — ME / CUSTOMER labels\n');

eq('outgoing is ME', S.formatTranscript([M('outgoing', '1:00', 'hi')]), 'ME: hi');
eq('incoming is CUSTOMER', S.formatTranscript([M('incoming', '1:00', 'hi')]), 'CUSTOMER: hi');
eq('unknown stays UNKNOWN', S.formatTranscript([M('unknown', '1:00', 'hi')]), 'UNKNOWN: hi');
eq('empty text is dropped', S.formatTranscript([M('outgoing', '1:00', '')]), '');
eq('a seam marker is labelled UNKNOWN', S.formatTranscript([{ direction: 'unknown', text: '[... 3 messages ...]', kind: 'gap' }]),
  'UNKNOWN: [... 3 messages ...]');
eq('the adapter output and the worker output are identical',
  S.formatTranscript(full), full.map((m) => `${m.direction === 'outgoing' ? 'ME' : 'CUSTOMER'}: ${m.text}`).join('\n'));

console.log('\n[22] default system prompt — shipped, editable, never empty\n');

check('a default prompt exists', typeof S.DEFAULT_SYSTEM_PROMPT === 'string' && S.DEFAULT_SYSTEM_PROMPT.length > 100);
check('the config ships it', S.DEFAULT_AI_CONFIG.systemPrompt === S.DEFAULT_SYSTEM_PROMPT);
check('it forbids inventing prices', /never invent/i.test(S.DEFAULT_SYSTEM_PROMPT) && /prices/i.test(S.DEFAULT_SYSTEM_PROMPT));
check('it forbids inventing lead times and stock',
  /delivery timelines/i.test(S.DEFAULT_SYSTEM_PROMPT) && /stock availability/i.test(S.DEFAULT_SYSTEM_PROMPT));
check('it is written for B2B sales, not one industry',
  /B2B salesperson/i.test(S.DEFAULT_SYSTEM_PROMPT) && !/vending/i.test(S.DEFAULT_SYSTEM_PROMPT));
check('it still answers in the customer language', /customer's language/i.test(S.DEFAULT_SYSTEM_PROMPT));
check('it no longer hardcodes a reply length', !/1-3 short sentences/i.test(S.DEFAULT_SYSTEM_PROMPT));
check('length is configurable instead', S.AI_CONFIG_STRING_KEYS.includes('replyLength'));
check('the prompt is configurable', S.AI_CONFIG_STRING_KEYS.includes('systemPrompt'));
check('thinking is configurable', S.AI_CONFIG_STRING_KEYS.includes('thinking'));

console.log('\n[22b] the pre-publish prompt is migrated, a custom one is not\n');

// The old prompt was specific to one company's vending machines. Anyone who
// never edited it should get the published default; anyone who did edit it must
// keep their words exactly.
eq('the shipped v2 prompt is recognised', S.migrateStoredConfig({ configVersion: 2, systemPrompt: S.LEGACY_SYSTEM_PROMPT_VENDING }).systemPrompt, S.DEFAULT_SYSTEM_PROMPT);
eq('a customised prompt survives',
  S.migrateStoredConfig({ configVersion: 2, systemPrompt: 'Always sign off as Dave from Acme.' }).systemPrompt,
  'Always sign off as Dave from Acme.');
eq('a prompt at the current version is left alone',
  S.migrateStoredConfig({ configVersion: S.CONFIG_VERSION, systemPrompt: S.LEGACY_SYSTEM_PROMPT_VENDING }).systemPrompt,
  S.LEGACY_SYSTEM_PROMPT_VENDING);
check('the legacy prompt is not the current one', S.LEGACY_SYSTEM_PROMPT_VENDING !== S.DEFAULT_SYSTEM_PROMPT);

console.log('\n[22c] the connection fields are never migrated away\n');

// The whole point of the empty defaults is that a fresh install starts blank.
// An install that is already talking to a provider must keep doing so.
const working = S.migrateStoredConfig({
  configVersion: 2,
  primaryBaseUrl: 'https://api.example.com',
  fallbackBaseUrl: 'https://backup.example.com',
  apiKey: 'a-key-the-user-entered',
  model: 'some-model',
});
eq('base url kept', working.primaryBaseUrl, 'https://api.example.com');
eq('fallback kept', working.fallbackBaseUrl, 'https://backup.example.com');
eq('key kept', working.apiKey, 'a-key-the-user-entered');
eq('model kept', working.model, 'some-model');
check('and it counts as configured', S.hasRequiredConfig(working) === true);

console.log('\n[23] migrateStoredConfig — the old default must not survive an upgrade\n');

// The real upgrade path: an install that stored maxTokens 300 before the field
// meant anything. It must come back as auto, not stay broken.
const oldCfg = { primaryBaseUrl: 'https://api.example.com', model: 'some-model', temperature: 0.4, maxTokens: 300, timeoutMs: 30000 };
const migrated = S.migrateStoredConfig(oldCfg);
eq('a stored 300 becomes auto', migrated.maxTokens, 0);
eq('the migration stamps the version', migrated.configVersion, S.CONFIG_VERSION);
eq('the raw object is not mutated', oldCfg.maxTokens, 300);
check('the migrated value resolves to a usable budget',
  S.resolveMaxTokens(Object.assign({}, S.DEFAULT_AI_CONFIG, migrated)) > 300);

// A deliberate non-default value must be left alone.
eq('a chosen value is untouched', S.migrateStoredConfig({ maxTokens: 800 }).maxTokens, 800);
eq('a config already at the current version is returned as-is',
  S.migrateStoredConfig({ configVersion: S.CONFIG_VERSION, maxTokens: 300 }).maxTokens, 300);
eq('null in, null out', S.migrateStoredConfig(null), null);
eq('a non-object is passed through', S.migrateStoredConfig('nonsense'), 'nonsense');
check('the shipped default carries the current version', S.DEFAULT_AI_CONFIG.configVersion === S.CONFIG_VERSION);

console.log('\n[24] config schema — every new field is typed and bounded\n');

check('configVersion is present so old installs can migrate', S.DEFAULT_AI_CONFIG.configVersion === S.CONFIG_VERSION);
check('maxTokens accepts 0 as "auto"', S.AI_CONFIG_NUMBER_RANGES.maxTokens.min === 0);
check('maxTokens ceiling matches the retry ceiling', S.AI_CONFIG_NUMBER_RANGES.maxTokens.max === S.AI_LIMITS.MAX_TOKENS_CEILING);
check('contextMessages is bounded', S.AI_CONFIG_NUMBER_RANGES.contextMessages.min === 0);
check('maxChars is bounded', S.AI_CONFIG_NUMBER_RANGES.maxChars.min >= 1000);
check('the transcript default is the ceiling, not a small window',
  S.DEFAULT_AI_CONFIG.maxChars >= 20000);
check('storage keys for history and drafts exist',
  S.STORAGE_KEYS.MESSAGE_STORE === 'messageStore' && S.STORAGE_KEYS.DRAFTS === 'drafts');
check('the history store is bounded', S.MESSAGE_STORE_LIMITS.MAX_MESSAGES_PER_CHAT > 0 && S.MESSAGE_STORE_LIMITS.MAX_CHATS > 0);
check('the history store is bounded by characters too', S.MESSAGE_STORE_LIMITS.MAX_CHARS_PER_CHAT > 0);
check('the draft store is bounded', S.DRAFT_LIMITS.MAX_CHATS > 0 && S.DRAFT_LIMITS.MAX_CHARS > 0);

console.log('\n[25] the worker → panel context contract\n');

const panelSrc = fs.readFileSync(path.join(ROOT, 'src/sidepanel/sidepanel.js'), 'utf8');
const workerSrc = fs.readFileSync(path.join(ROOT, 'src/background/service-worker.js'), 'utf8');

// A full context exactly as the content script builds it.
const FULL_CTX = {
  hasOpenChat: true,
  chatId: 'dm:8613800138000',
  chatIdStable: true,
  chatKey: 'Alice|dm|向“+55 11 9123 4567”发送的消息|17|Oi|Ok',
  contactName: 'Alice',
  isGroup: false,
  phone: '551191234567',
  phoneStatus: 'read',
  messages: [{ direction: 'incoming', text: 'Ok' }],
  transcript: 'CUSTOMER: Ok',
  loadedInDom: 13,
  counts: { total: 17, incoming: 6, outgoing: 11, unknown: 0 },
  diagnostics: { rows: 13 },
};
const pub = S.publicContext(FULL_CTX);

// Every field the panel reads off a context has to survive the projection. This
// is the defect that shipped: `hasOpenChat` was missing from the object
// GENERATE_REPLY hand-built, so the panel read `undefined`, took it for "no
// conversation open", and printed the red "Click a chat in WhatsApp Web."
// notice directly under the green "AI reply ready" one.
const readFields = Array.from(
  new Set(Array.from(panelSrc.matchAll(/\b(?:ctx|current)\.([A-Za-z_$][\w$]*)/g)).map((m) => m[1])),
);
const dropped = readFields.filter((k) => pub[k] === undefined);
check(
  'every context field the panel reads survives publicContext',
  dropped.length === 0,
  `dropped: ${dropped.join(', ')}`,
);

// The exact expression that produced the contradictory pair of notices.
check('the panel still gates on !current.hasOpenChat', /\bcurrent\.hasOpenChat\b/.test(panelSrc));
check('an open chat does not trip that gate', !(pub && !pub.hasOpenChat));
check('hasOpenChat is a boolean, never undefined', pub.hasOpenChat === true);
check('publicContext({}) is still a safe object', S.publicContext({}).hasOpenChat === false);
check('publicContext(null) does not throw', S.publicContext(null).hasOpenChat === false);

// The transcript and the DOM diagnostics must NOT cross into the panel.
check('the bulk fields stay behind', pub.transcript === undefined && pub.messages === undefined && pub.diagnostics === undefined);

// Both routes that hand a context to the panel must go through publicContext,
// or the two shapes drift apart again — which is exactly how this broke.
// Comments are stripped first: the JSDoc blocks contain `context: object` and
// would otherwise be read as a passthrough.
const workerCode = workerSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const contextValues = Array.from(workerCode.matchAll(/context:\s*([A-Za-z_$][\w$.]*)/g)).map((m) => m[1]);
check(
  'every route hands the panel a publicContext',
  contextValues.length >= 2 && contextValues.every((v) => v.startsWith('publicContext')),
  `found: ${contextValues.join(', ') || 'none'}`,
);
check('both routes are covered', contextValues.length === 2);

// The panel used to assign `current` *after* calling renderContext(), so the
// buttons were always evaluated against the previous context — opening the
// panel left both buttons disabled for a whole poll interval.
check(
  'renderContext publishes the context it renders',
  /function renderContext\(ctx\)\s*\{\s*current = ctx;/.test(panelSrc),
);
const strayAssign = Array.from(panelSrc.matchAll(/^\s*current = (?!ctx;|null;)/gm));
check('no other code assigns current', strayAssign.length === 0, `${strayAssign.length} stray assignment(s)`);

console.log('\n[26] the per-chat instruction\n');

const aiSrc = fs.readFileSync(path.join(ROOT, 'src/ai/ai-client.js'), 'utf8');
const insPanelSrc = panelSrc;
// The panel's instruction handling, without the comments that describe it — the
// assertions below are about code, and prose about code keeps matching.
const insPanelCode = insPanelSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

check('the store key is registered', S.STORAGE_KEYS.INSTRUCTIONS === 'instructions');
check('the instruction store is bounded', S.INSTRUCTION_LIMITS.MAX_CHATS > 0 && S.INSTRUCTION_LIMITS.MAX_CHARS > 0);

// Nothing written must mean nothing appended. An empty block would put a
// dangling "ADDITIONAL INSTRUCTION … (from the salesperson)" header into every
// single prompt for every customer who has no instruction.
eq('no instruction appends nothing', S.instructionBlock(''), '');
eq('null appends nothing', S.instructionBlock(null), '');
eq('undefined appends nothing', S.instructionBlock(undefined), '');
eq('whitespace-only appends nothing', S.instructionBlock('   \n\t  '), '');

const block = S.instructionBlock('Ask how the trial installation went.');
check('the text is carried through', block.includes('Ask how the trial installation went.'));
check('it is labelled as an instruction, not as customer speech', /ADDITIONAL INSTRUCTION/.test(block));
check('it is marked as coming from the salesperson', /salesperson/i.test(block));
check('it claims priority over the general guidance', /takes priority/i.test(block));

// The priority claim is scoped. An instruction that could override the
// no-invention rules would turn "ask about the loan" into a licence to promise
// a price — and the message goes to a real customer.
check('it is explicitly barred from overriding the no-invention rules', /does not override/i.test(block));
check(
  'and the bar names the things that must not be invented',
  /prices/.test(block) && /delivery promises/.test(block) && /discounts/.test(block),
);

const overlong = S.instructionBlock('x'.repeat(S.INSTRUCTION_LIMITS.MAX_CHARS + 500));
eq(
  'an overlong instruction is truncated',
  (overlong.match(/x/g) || []).length,
  S.INSTRUCTION_LIMITS.MAX_CHARS,
);

// Where it lands matters as much as what it says. On the system message it
// outranks the general guidance; on the user message it would read as something
// the customer said.
check(
  'the instruction rides on the system message',
  /\{\s*role:\s*'system',\s*content:\s*systemPromptFor\(cfg\)\s*\+\s*instructionBlock\(ctx\.instruction\)/.test(
    aiSrc,
  ),
);
check('the user message is untouched by it', !/buildUserPrompt\([^)]*instruction/.test(aiSrc));

// The worker has to actually fetch it — the panel writing to storage is only
// half a feature.
check('the worker reads the instruction store', /STORAGE_KEYS\.INSTRUCTIONS/.test(workerSrc));
check('the worker passes it to the generate op', /instruction:\s*await loadInstruction\(/.test(workerSrc));

// Persistence mirror. The instruction is keyed by chat id for the same reason
// drafts are: it is about one customer.
check('the panel mirrors the store in memory', /async function loadInstructions\(/.test(insPanelCode));
check('the panel bounds the store on write', /INSTRUCTION_LIMITS\.MAX_CHATS/.test(insPanelCode));
check('the panel truncates on write', /INSTRUCTION_LIMITS\.MAX_CHARS/.test(insPanelCode));
check('an empty instruction deletes the entry', /delete store\[chatId\]/.test(insPanelCode));

// Debounced typing loses a race with a click. Both generate paths have to write
// the box out before the worker reads storage, or the reply answers the
// previous instruction.
const flushCalls = Array.from(insPanelCode.matchAll(/await flushInstruction\(\)/g));
check('the box is flushed before the worker can read it', flushCalls.length >= 2, `${flushCalls.length} call(s)`);
check(
  'both generate paths flush before calling the worker',
  /await flushInstruction\(\);\s*const res = await callWorker\(\{ type: MSG\.GENERATE_REPLY \}\)/.test(insPanelCode) &&
    /await flushInstruction\(\);\s*const res = await callWorker\(\{ type: MSG\.FOLLOWUP_AND_SEND \}\)/.test(insPanelCode),
);
check(
  'the debounce is cancelled by a flush',
  /async function flushInstruction\(\)\s*\{\s*if \(insTimer\)/.test(insPanelCode),
);

// Three states, and the chip is the one that matters: collapsed but still
// readable, so the reply can be checked against what was asked for.
check('the empty state is a single add row', /el\.insAdd\.classList\.toggle\('hidden'/.test(insPanelCode));
check('the editor is a separate element', /el\.insPanel\.classList\.toggle\('hidden'/.test(insPanelCode));
check('the set state is a readable chip', /el\.insChip\.classList\.toggle\('hidden'/.test(insPanelCode));
check('the chip shows the instruction text', /el\.insChipText\.textContent = has \? entry\.text/.test(insPanelCode));
check('generating collapses back to the chip', /insOpen = false;\s*await renderInstruction\(\)/.test(insPanelCode));

// A hidden element cannot take focus, and the panel is hidden until the render
// resolves — so an un-awaited render followed by a focus() silently does nothing.
check(
  'the editor is rendered before it is focused',
  !/(?<!await )renderInstruction\(\);\s*\n\s*el\.insBox\.focus\(\)/.test(insPanelCode),
);
check(
  'both ways of opening it await the render',
  (insPanelCode.match(/await renderInstruction\(\);\s*\n\s*el\.insBox\.focus\(\)/g) || []).length === 2,
);

// Switching chats moves both boxes. If the instruction sync had its own "last
// chat" variable there would be two variables that must stay equal.
check('one function moves both per-chat boxes', /async function syncPanesToChat\(/.test(insPanelCode));
check('and no separate instruction sync exists', !/syncInstructionToChat/.test(insPanelCode));
check('the old draft-only sync is gone', !/syncDraftToChat/.test(insPanelCode));
check('the panel switches chats through it', /await syncPanesToChat\(res\.context\)/.test(insPanelCode));

// The instruction is input to the AI. It must never become the text of a
// message, which is the failure mode the amber styling exists to prevent.
check('the instruction is never sent as message text', !/text:\s*el\.insBox\.value/.test(insPanelCode));

// The send payload, verbatim: it must carry the reply box and nothing else.
const sendPayload = (insPanelCode.match(/callWorker\(\{[\s\S]*?MSG\.SEND_MESSAGE[\s\S]*?\}\)/) || [''])[0];
check('the send payload was found', /SEND_MESSAGE/.test(sendPayload));
check('Send takes its text from the reply box', /const text = el\.reply\.value\.trim\(\)/.test(insPanelCode));
check('Send never reads the instruction box', !/insBox/.test(sendPayload), sendPayload.replace(/\s+/g, ' '));

// ---------------------------------------------------------------------------
// First run: what happens before anyone has configured a provider.
//
// The shipped defaults are empty on purpose, so "not configured yet" is the
// state every new user starts in and the state the panel has to handle without
// ever making a request. These check the two halves of that promise: the pure
// predicate, and the source contract that the predicate is actually consulted
// before anything is sent anywhere.
// ---------------------------------------------------------------------------

console.log('\n[27] an unconfigured install makes no request\n');

const partial = (patch) => Object.assign({}, S.DEFAULT_AI_CONFIG, patch);

eq('nothing configured names all three fields', S.missingAiFields(partial({})).join(','), 'primaryBaseUrl,apiKey,model');
eq('a base URL alone is not enough', S.missingAiFields(partial({ primaryBaseUrl: 'https://api.example.com/v1' })).join(','), 'apiKey,model');
eq('whitespace is not configuration', S.missingAiFields(partial({ primaryBaseUrl: '   ', apiKey: ' ', model: '\t' })).join(','), 'primaryBaseUrl,apiKey,model');
eq('the fallback URL is never required', S.missingAiFields(partial({ primaryBaseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'm' })).join(','), '');
check('so a complete config reports ready', S.hasRequiredConfig(partial({ primaryBaseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'm' })));
check('and an incomplete one does not', !S.hasRequiredConfig(partial({ apiKey: 'k' })));

// A key with no `sk-` prefix is a first-class key. Plenty of providers issue
// bare hex or JWT-shaped keys, and rejecting them at the door would be a bug
// that only shows up for whoever picked that provider.
const aiClientSrc = fs.readFileSync(path.join(ROOT, 'src/ai/ai-client.js'), 'utf8');
const workerSrcRaw = fs.readFileSync(path.join(ROOT, 'src/background/service-worker.js'), 'utf8');
check('no code demands an sk- prefix', !/sk-/.test(aiClientSrc) && !/sk-/.test(workerSrcRaw));
check('nor anywhere else in src', !/['"`]sk-/.test(
  fs
    .readdirSync(path.join(ROOT, 'src/shared'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => fs.readFileSync(path.join(ROOT, 'src/shared', f), 'utf8'))
    .join('\n'),
));

check(
  'generateReply refuses before it builds a request',
  /function generateReply[\s\S]{0,400}?assertConfigured\(/.test(aiClientSrc),
);
check(
  'and assertConfigured names the fields it wants',
  /function assertConfigured[\s\S]{0,600}?missingFieldLabels/.test(aiClientSrc),
);
check('the connection test explains what is missing', /Fill in \$\{/.test(aiClientSrc));
check(
  'the worker checks configuration before it reads the chat',
  workerSrcRaw.indexOf('assertConfigured(') > -1 &&
    workerSrcRaw.indexOf('assertConfigured(') < workerSrcRaw.indexOf('opReadChat()'),
);

// ---------------------------------------------------------------------------

console.log('\n[28] two connection methods — the subscription must not disturb the key\n');

// The upgrade path. A config written by the previous build has no
// `connectionMode` at all, and must keep working as an API-key config rather
// than being treated as unconfigured.
eq('an old config with no connectionMode reads as apiKey', S.connectionModeOf({ primaryBaseUrl: 'https://x/v1', model: 'm' }), S.CONNECTION_MODE.API_KEY);
eq('an empty config reads as apiKey', S.connectionModeOf({}), S.CONNECTION_MODE.API_KEY);
eq('a missing config reads as apiKey', S.connectionModeOf(null), S.CONNECTION_MODE.API_KEY);
eq('an unknown mode falls back to apiKey, not to chatgpt', S.connectionModeOf({ connectionMode: 'something-else' }), S.CONNECTION_MODE.API_KEY);
eq('the chatgpt mode is recognised', S.connectionModeOf({ connectionMode: 'chatgpt' }), S.CONNECTION_MODE.CHATGPT);

const OLD_CONFIG = { primaryBaseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'm', configVersion: 3 };
check('an old, complete config still reports ready after upgrade', S.hasRequiredConfig(OLD_CONFIG));
eq('and it still asks for the API-key fields', S.missingAiFields(OLD_CONFIG).length, 0);

// The subscription path needs a model and nothing else: there is no key to
// paste and no base URL to know.
const CG_CONFIG = { connectionMode: 'chatgpt', chatgptModel: 'gpt-6.1-sol' };
check('a subscription config with a model is complete', S.hasRequiredConfig(CG_CONFIG));
eq('and needs only the model', S.missingAiFields({ connectionMode: 'chatgpt' }).join(','), 'chatgptModel');
check('the subscription path never demands an API key', !S.missingAiFields(CG_CONFIG).includes('apiKey'));
check('nor a base URL', !S.missingAiFields(CG_CONFIG).includes('primaryBaseUrl'));
check(
  'a subscription config with no model is refused',
  !S.hasRequiredConfig({ connectionMode: 'chatgpt', primaryBaseUrl: 'https://x/v1', apiKey: 'k', model: 'm' }),
);
check(
  'and an API-key config with no key is refused even with a model set',
  !S.hasRequiredConfig({ connectionMode: 'apiKey', primaryBaseUrl: 'https://x/v1', model: 'm' }),
);

// Switching method must be a two-way door. The panel is sent both methods'
// values on every read, so this is a property of what the worker hands over.
check(
  'the panel receives both methods’ fields at once',
  ['connectionMode', 'chatgptModel', 'helperUrl', 'primaryBaseUrl', 'model'].every((k) =>
    new RegExp(`^\\s*${k}:`, 'm').test(aiClientSrc),
  ),
);
check(
  'the panel form sends both methods’ values back',
  /function readConfigForm[\s\S]*?connectionMode: modeChoice[\s\S]*?model: el\.cfgModel\.value[\s\S]*?chatgptModel: el\.cfgCgModel\.value[\s\S]*?helperUrl: el\.cfgHelperUrl\.value/.test(panelSrc),
);
check('the panel sends the subscription model from the welcome form too', /chatgptModel: el\.suCgModel\.value/.test(panelSrc));

// Defaults. The new fields are additive, which is why the config version is
// deliberately NOT bumped: an existing install must not be rewritten.
eq('the default method is the API key', S.DEFAULT_AI_CONFIG.connectionMode, S.CONNECTION_MODE.API_KEY);
eq('the default subscription model is empty, not invented', S.DEFAULT_AI_CONFIG.chatgptModel, '');
eq('the default helper address is loopback', S.DEFAULT_AI_CONFIG.helperUrl, S.CHATGPT_HELPER_DEFAULT_URL);
eq('the config version did not move for an additive change', S.CONFIG_VERSION, 3);
for (const key of ['connectionMode', 'chatgptModel', 'helperUrl']) {
  check(`${key} is a declared string field`, S.AI_CONFIG_STRING_KEYS.includes(key));
}
check(
  'both methods are described for the panel to render',
  !!(S.CONNECTION_MODE_SPECS.chatgpt && S.CONNECTION_MODE_SPECS.apiKey),
);

// The loopback address. `localhost` is explicitly not an accepted redirect for
// this flow, so a helper configured on `localhost` would fail the callback at
// the last step with an error nobody could act on.
check('the helper default is 127.0.0.1, never localhost', /^http:\/\/127\.0\.0\.1:\d+$/.test(S.CHATGPT_HELPER_DEFAULT_URL));
check('and nothing in the helper path uses localhost', !/localhost/.test(S.CHATGPT_HELPER_DEFAULT_URL));
eq('a blank helper address falls back to the loopback default', S.helperBaseUrl({}), S.CHATGPT_HELPER_DEFAULT_URL);
eq('a trailing slash is stripped', S.helperBaseUrl({ helperUrl: 'http://127.0.0.1:9999/' }), 'http://127.0.0.1:9999');
eq('the start command is a copy-pasteable line', S.helperStartCommand({}), 'node helper/siwc-helper.js');
eq('and it carries a non-default port', S.helperStartCommand({ helperUrl: 'http://127.0.0.1:9999' }), 'node helper/siwc-helper.js --port 9999');
eq('the default port is not spelled out', S.helperStartCommand({ helperUrl: 'http://127.0.0.1:8788' }), 'node helper/siwc-helper.js');

// Scopes. The plan half of this list is what makes the subscription usable at
// all, and it cannot be read out of the OIDC discovery document — that document
// lists only the four identity scopes.
for (const scope of ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct']) {
  check(`the scope set asks for ${scope}`, S.CHATGPT_SCOPES.split(' ').includes(scope));
}
check('the plan scope is one the request actually asks for', S.CHATGPT_SCOPES.split(' ').includes(S.CHATGPT_PLAN_SCOPE));
eq('the resource is the OpenAI API host', S.CHATGPT_RESOURCE, 'https://api.openai.com/v1');
check(
  'asking for no scope we do not need',
  S.CHATGPT_SCOPES.split(' ').length === 6,
  `got ${S.CHATGPT_SCOPES.split(' ').length}: ${S.CHATGPT_SCOPES}`,
);

// Error codes: each of the seven states needs its own sentence in the panel, so
// each needs its own code. A collision would silently collapse two different
// problems into one message.
const CG_CODES = ['HELPER_UNREACHABLE', 'CHATGPT_NOT_SIGNED_IN', 'CHATGPT_NO_PLAN_SCOPE', 'CHATGPT_NOT_ELIGIBLE', 'CHATGPT_USAGE_LIMIT', 'CHATGPT_UNAVAILABLE', 'CHATGPT_FAILED'];
const codeValues = CG_CODES.map((k) => S.ERR[k]);
check('every connection state has an error code', codeValues.every((v) => typeof v === 'string' && v));
eq('and no two of them are the same code', new Set(codeValues).size, CG_CODES.length);
check('the panel maps every one of them to real text', CG_CODES.every((k) => panelSrc.includes(`ERR.${k}]`)));

// The end-to-end security claim: no credential ever enters the extension.
// This is worth asserting rather than trusting, because it is the single
// property the whole architecture exists to provide.
const credentialWords = /access_token|refresh_token|id_token|client_secret|code_verifier/i;
check('the panel never handles a token', !credentialWords.test(panelSrc));
check('the worker’s helper client never handles a token', !credentialWords.test(fs.readFileSync(path.join(ROOT, 'src/ai/chatgpt-client.js'), 'utf8')));
check('nor does the shared config layer', !credentialWords.test(fs.readFileSync(path.join(ROOT, 'src/shared/constants.js'), 'utf8')));
check(
  'the worker holds no token field either',
  !credentialWords.test(workerSrcRaw),
);

// The rejected route. An extension-side OAuth popup is the obvious
// implementation and it cannot work: the documented callback is an HTTP
// listener on 127.0.0.1, and launchWebAuthFlow only intercepts chromiumapp.org.
// Comments explaining that are fine; a call would not be.
check('the panel does not pretend to run the OAuth flow itself', !/\.launchWebAuthFlow\s*\(/.test(panelSrc));
check('nor does anything else in src', !/\.launchWebAuthFlow\s*\(/.test(fs.readFileSync(path.join(ROOT, 'src/ai/chatgpt-client.js'), 'utf8')));

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
check('the extension asks for no identity permission it cannot use', !(manifest.permissions || []).includes('identity'));
check('loopback is optional, requested only when the method is chosen', (manifest.optional_host_permissions || []).includes('http://127.0.0.1/*'));
check('and no loopback host permission is granted up front', !(manifest.host_permissions || []).some((h) => /127\.0\.0\.1|localhost/.test(h)));

// ---------------------------------------------------------------------------

console.log(`\n${'='.repeat(56)}`);
console.log(`  PASS: ${pass}   FAIL: ${fail}`);
console.log(`${'='.repeat(56)}\n`);

process.exit(fail === 0 ? 0 : 1);