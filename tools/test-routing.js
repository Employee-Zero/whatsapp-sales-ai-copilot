#!/usr/bin/env node
'use strict';

/**
 * Routing tests for the ChatGPT-first / API Key backup logic.
 *
 * Offline: chrome.storage and fetch are stubbed, so no Connector, no account, no
 * network. The point most worth pinning is the performance rule: an API-only
 * install must make exactly one request per reply, to its provider, and never
 * touch the Connector (127.0.0.1) — no probe, no status check, no model refresh.
 */

const path = require('node:path');
const { pathToFileURL } = require('node:url');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `  (${detail})` : ''}`); }
}

const API_HOST = 'https://api.example-provider.test';
const HELPER = 'http://127.0.0.1:8788';

let storedConfig = {};
let calls = [];
let helperBehaviour = null; // (url, init) => Response-like | throws

global.chrome = {
  storage: {
    local: {
      get: async () => ({ waAiConfig: storedConfig, aiConfig: storedConfig }),
      set: async () => {},
    },
  },
};

function json(status, body) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => '' }, json: async () => body, text: async () => JSON.stringify(body) };
}

global.fetch = async (url, init) => {
  const u = String(url);
  calls.push(u);
  if (u.startsWith(API_HOST)) {
    return json(200, { model: 'm', choices: [{ message: { content: 'API reply' }, finish_reason: 'stop' }], usage: {} });
  }
  if (u.startsWith('http://127.0.0.1')) return helperBehaviour(u, init);
  throw new TypeError('unexpected host ' + u);
};

(async () => {
  const root = path.resolve(__dirname, '..');
  const consts = await import(pathToFileURL(path.join(root, 'src/shared/constants.js')));
  const ai = await import(pathToFileURL(path.join(root, 'src/ai/ai-client.js')));
  const { ERR, STORAGE_KEYS } = consts;

  const API = { primaryBaseUrl: `${API_HOST}/v1`, apiKey: 'k-test', model: 'gpt-x' };
  const ctx = { contactName: 'Ana', transcript: '[10:00] Customer: hi', messages: [], messageCount: 1 };

  function setConfig(cfg) {
    storedConfig = cfg;
    global.chrome.storage.local.get = async () => ({ [STORAGE_KEYS.AI_CONFIG]: cfg });
    calls = [];
  }
  const helperFails = (code, extra = {}) => (url) =>
    json(code === ERR.CHATGPT_USAGE_LIMIT ? 429 : 503, Object.assign({ ok: false, code, message: 'x', retryable: true }, extra));

  console.log('\n[1] API-only install: straight to the provider');
  setConfig(Object.assign({ connectionMode: 'apiKey' }, API));
  helperBehaviour = () => { throw new Error('the Connector must not be contacted'); };
  let r = await ai.generateReply(ctx);
  check('one request in total', calls.length === 1, calls.join(', '));
  check('it went to the API provider', calls[0].startsWith(API_HOST));
  check('the Connector was never contacted (no probe, status or models call)', !calls.some((u) => u.includes('127.0.0.1')));
  check('the reply came from the API', r.text === 'API reply' && r.usedApiBackup === false);
  check('routeOf is decided from config alone', ai.routeOf({ connectionMode: 'apiKey' }) === 'api' && ai.routeOf({ connectionMode: 'chatgpt' }) === 'chatgpt');

  console.log('\n[2] ChatGPT primary, backup OFF (default)');
  const CG = { connectionMode: 'chatgpt', chatgptModel: 'gpt-5', ...API };
  setConfig(CG);
  helperBehaviour = helperFails(ERR.CHATGPT_USAGE_LIMIT);
  let err = null;
  try { await ai.generateReply(ctx); } catch (e) { err = e; }
  check('usage limit surfaces as an error', err && err.code === ERR.CHATGPT_USAGE_LIMIT, err && err.code);
  check('nothing was sent to the API provider', !calls.some((u) => u.startsWith(API_HOST)));

  console.log('\n[3] ChatGPT primary, backup ON');
  setConfig({ ...CG, apiFallback: true });
  helperBehaviour = helperFails(ERR.CHATGPT_USAGE_LIMIT);
  r = await ai.generateReply(ctx);
  check('allowance exhausted → API backup answers', r.text === 'API reply' && r.usedApiBackup === true);
  check('ChatGPT was tried first, then the API', calls[0].startsWith(HELPER) && calls[calls.length - 1].startsWith(API_HOST));

  setConfig({ ...CG, apiFallback: true });
  helperBehaviour = helperFails(ERR.CHATGPT_UNAVAILABLE);
  r = await ai.generateReply(ctx);
  check('service temporarily unavailable → API backup', r.usedApiBackup === true);

  setConfig({ ...CG, apiFallback: true });
  helperBehaviour = () => { throw new TypeError('fetch failed'); };
  r = await ai.generateReply(ctx);
  check('Connector unreachable → API backup', r.usedApiBackup === true);

  setConfig({ ...CG, apiFallback: true });
  helperBehaviour = helperFails(ERR.CHATGPT_UNAVAILABLE, { partialOutput: true });
  err = null;
  try { await ai.generateReply(ctx); } catch (e) { err = e; }
  check('reply text had started streaming → NOT retried elsewhere', err && !calls.some((u) => u.startsWith(API_HOST)));

  for (const code of [ERR.CHATGPT_NOT_SIGNED_IN, ERR.CHATGPT_NOT_ELIGIBLE, ERR.CHATGPT_NO_PLAN_SCOPE, ERR.CHATGPT_FAILED]) {
    setConfig({ ...CG, apiFallback: true });
    helperBehaviour = helperFails(code);
    err = null;
    try { await ai.generateReply(ctx); } catch (e) { err = e; }
    check(`${code} never falls back`, err && !calls.some((u) => u.startsWith(API_HOST)));
  }

  setConfig({ connectionMode: 'chatgpt', chatgptModel: 'gpt-5', apiFallback: true, primaryBaseUrl: `${API_HOST}/v1`, apiKey: '', model: '' });
  helperBehaviour = helperFails(ERR.CHATGPT_USAGE_LIMIT);
  err = null;
  try { await ai.generateReply(ctx); } catch (e) { err = e; }
  check('backup on but API fields incomplete → no fallback', err && !calls.some((u) => u.startsWith(API_HOST)));

  console.log('\n[4] ChatGPT healthy');
  setConfig({ ...CG, apiFallback: true });
  helperBehaviour = () => json(200, { ok: true, text: 'GPT reply', model: 'gpt-5', usage: null, elapsedMs: 5 });
  r = await ai.generateReply(ctx);
  check('ChatGPT answers, API untouched', r.text === 'GPT reply' && !calls.some((u) => u.startsWith(API_HOST)));

  console.log(`\n========================================================\n  PASS: ${pass}   FAIL: ${fail}\n========================================================`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
