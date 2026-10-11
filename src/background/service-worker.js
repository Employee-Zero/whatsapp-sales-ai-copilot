/**
 * Service worker — orchestration + the authoritative send guard.
 *
 * Flow: side panel → service worker → (content script | AI API)
 *
 * This module owns:
 *   - the busy lock that prevents duplicate sends (task §16)
 *   - the pre-send chat guard (a conversation must be open, and it must still be
 *     the same conversation the draft was generated for)
 *   - the AI call (task §8: never from the content script)
 */

/* global MSG, ERR, STORAGE_KEYS, log, logError */

import { MSG, ERR, STORAGE_KEYS } from './../shared/constants.js';
import { log, logError, publicContext } from './../shared/utils.js';
import {
  loadAiConfig,
  saveAiConfig,
  seedAiConfigIfMissing,
  publicConfig,
  assertConfigured,
  generateReply,
  testConnection,
  testChatGPTRequest,
  helperStatus,
  sendToTab,
} from './../ai/ai-client.js';
import { startSignIn, signOut, listModels } from './../ai/chatgpt-client.js';

// ---------------------------------------------------------------------------
// Busy lock — one in-flight operation at a time, process-wide.
// ---------------------------------------------------------------------------

/** @type {{name: string, startedAt: number}|null} */
let inFlight = null;

/**
 * Acquire the single-operation lock.
 * @param {string} name
 * @throws {Error} code OPERATION_ALREADY_RUNNING
 */
function acquireLock(name) {
  if (inFlight) {
    const e = new Error(`Another operation is already running (${inFlight.name}).`);
    e.code = ERR.BUSY;
    throw e;
  }
  inFlight = { name, startedAt: Date.now() };
  log(`Lock acquired: ${name}`);
}

function releaseLock() {
  if (inFlight) log(`Lock released: ${inFlight.name}`);
  inFlight = null;
}

// ---------------------------------------------------------------------------
// Tab resolution
// ---------------------------------------------------------------------------

/**
 * Find the WhatsApp Web tab in the current window (falling back to any window).
 * @returns {Promise<chrome.tabs.Tab|null>}
 */
async function findWhatsAppTab() {
  const patterns = ['https://web.whatsapp.com/*'];
  let tabs = await chrome.tabs.query({ url: patterns, currentWindow: true });
  if (!tabs.length) tabs = await chrome.tabs.query({ url: patterns });
  if (!tabs.length) return null;
  // Prefer the active tab when several are open.
  return tabs.find((t) => t.active) || tabs[0];
}

// ---------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------

/**
 * Read the currently open chat (read-only, no scrolling).
 *
 * @param {{revealPhone?: boolean}} [opts] revealPhone opens the contact-info
 *   drawer to read the number. Only set for an explicit user action.
 * @returns {Promise<object>}
 */
async function opReadChat(opts = {}) {
  const tab = await findWhatsAppTab();
  if (!tab || tab.id === undefined) {
    const e = new Error('WhatsApp Web is not open in this browser.');
    e.code = ERR.WHATSAPP_NOT_OPEN;
    throw e;
  }
  const res = await sendToTab(tab.id, {
    type: MSG.GET_CHAT_CONTEXT,
    revealPhone: opts.revealPhone === true,
  });
  if (!res.ok) {
    const e = new Error(res.message || 'Could not read the current chat.');
    e.code = res.code || ERR.NO_CHAT_OPEN;
    throw e;
  }
  return res.context;
}

/**
 * The extra instruction stored for a chat, or '' when there is none.
 *
 * Read here rather than passed down from the panel so that it is looked up by
 * the chat the worker actually read — the panel's idea of "current chat" and
 * the worker's can differ for a moment during a switch, and an instruction is
 * about a specific customer.
 *
 * @param {string} chatId
 * @returns {Promise<string>}
 */
async function loadInstruction(chatId) {
  if (!chatId) return '';
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.INSTRUCTIONS);
    const map = (stored && stored[STORAGE_KEYS.INSTRUCTIONS]) || {};
    const entry = map[chatId];
    return entry && typeof entry.text === 'string' ? entry.text : '';
  } catch (err) {
    logError('instruction read failed', err && err.message);
    return '';
  }
}

/**
 * Worker-side send guard.
 *
 * Runs immediately before the content script is asked to click Send. Sending is
 * open to any conversation the user has open — 1:1 or group — so this no longer
 * checks the recipient. What it does check is that there *is* a conversation:
 * a context with no `chatId` means the read failed or no chat is open, and
 * clicking Send then would fire into whatever happens to be focused.
 *
 * @param {{chatId: string, contactName: string}} ctx
 * @throws {Error} NO_CHAT_OPEN
 */
function assertSendAllowed(ctx) {
  if (!ctx || !ctx.chatId) {
    logError('Send blocked — no conversation is open');
    const e = new Error('No conversation is open — cannot send.');
    e.code = ERR.NO_CHAT_OPEN;
    throw e;
  }
  log('Send guard passed', ctx.isGroup ? '(group)' : '(direct)');
}

/**
 * Write `text` into the composer and click Send, after re-checking that the
 * chat is still the same one the reply was generated for.
 *
 * @param {string} text
 * @param {string} chatId stable chat identity the draft was generated for
 * @param {object} ctx
 * @returns {Promise<{phone: string}>}
 */
async function opWriteAndSend(text, chatId, ctx) {
  const tab = await findWhatsAppTab();
  if (!tab || tab.id === undefined) {
    const e = new Error('WhatsApp Web is not open in this browser.');
    e.code = ERR.WHATSAPP_NOT_OPEN;
    throw e;
  }

  // Gate #1 (worker-side): a conversation must be open.
  assertSendAllowed(ctx);

  // Write into the composer first, then send. The content script re-checks the
  // chat identity and the phone immediately before clicking.
  const writeRes = await sendToTab(tab.id, { type: MSG.SET_COMPOSER_TEXT, text });
  if (!writeRes.ok) {
    const e = new Error(
      writeRes.code === ERR.COMPOSER_NOT_FOUND
        ? 'Could not find the WhatsApp message box.'
        : 'Could not write into the WhatsApp message box.',
    );
    e.code = writeRes.code || ERR.COMPOSER_NOT_FOUND;
    throw e;
  }

  log('Sending');
  const sendRes = await sendToTab(tab.id, { type: MSG.CLICK_SEND, chatId });
  if (!sendRes.ok) {
    const e = new Error(sendRes.message || 'Send failed.');
    e.code = sendRes.code || ERR.AI_FAILED;
    throw e;
  }
  log('Sent');
  return { phone: sendRes.phone };
}

/**
 * Generate-only path: read the chat, call the AI, return the draft.
 * Never sends. Allowed for any contact.
 *
 * @returns {Promise<{text: string, context: object}>}
 */
async function opGenerateReply() {
  // Configuration first. A brand-new user has no chat open and no provider
  // configured, and "fill in your API key" is the more useful of the two things
  // to say — it is the one they cannot work out for themselves.
  assertConfigured(await loadAiConfig());

  const context = await opReadChat();

  if (!context.hasOpenChat) {
    const e = new Error('No WhatsApp conversation is open.');
    e.code = ERR.NO_CHAT_OPEN;
    throw e;
  }
  if (!context.counts.total) {
    const e = new Error('No messages are loaded in this conversation yet.');
    e.code = ERR.NO_MESSAGES;
    throw e;
  }

  const instruction = await loadInstruction(context.chatId);
  const result = await generateReply({
    contactName: context.contactName,
    transcript: context.transcript,
    messages: context.messages,
    messageCount: context.counts.total,
    instruction,
  });

  // The tip is input to the AI, never output. If the model parrots it back as
  // the whole reply, refuse it here — this also protects Follow-up & Send, which
  // would otherwise deliver the salesperson's private note to the customer.
  const squash = (t) => String(t || '').toLowerCase().replace(/[\s"'“”‘’.!?。]+/g, ' ').trim();
  if (instruction && squash(result.text) === squash(instruction)) {
    const e = new Error('The AI repeated your tip instead of writing a reply. Reword the tip and try again.');
    e.code = ERR.AI_EMPTY;
    throw e;
  }

  return { text: result.text, context };
}

/**
 * Follow-up & Send: read → AI → re-verify → write → send, in one click.
 *
 * @returns {Promise<{text: string, phone: string, contactName: string}>}
 */
async function opFollowUpAndSend() {
  const { text, context } = await opGenerateReply();

  // Re-read the live context right before sending so a chat switch during the
  // AI call is caught here as well as inside the content script (task §15).
  const live = await opReadChat();

  if (live.chatId !== context.chatId) {
    logError('Chat changed while generating — send cancelled');
    const e = new Error('Chat changed while generating. Send cancelled.');
    e.code = ERR.CHAT_CHANGED;
    throw e;
  }

  if (!text || !text.trim()) {
    const e = new Error('The AI returned an empty reply — nothing to send.');
    e.code = ERR.AI_EMPTY;
    throw e;
  }

  await opWriteAndSend(text.trim(), live.chatId, live);
  return { text: text.trim(), phone: live.phone, contactName: live.contactName };
}

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------

const ROUTES = {
  [MSG.PANEL_HELLO]: async () => ({
    ok: true,
    busy: inFlight ? inFlight.name : null,
  }),

  [MSG.GET_AI_CONFIG]: async () => {
    const cfg = await loadAiConfig();
    // Never leak the key back to a caller. The panel receives a masked hint so
    // the user can confirm which key is stored without it appearing in the UI.
    return { ok: true, config: publicConfig(cfg) };
  },

  [MSG.SET_AI_CONFIG]: async (msg) => {
    const patch = Object.assign({}, msg.patch || {});
    // An empty key field means "leave the stored key alone" — only an explicit
    // null-ish sentinel clears it (the Clear key button).
    if (patch.apiKey === undefined || patch.apiKey === null) delete patch.apiKey;
    const next = await saveAiConfig(patch);
    return { ok: true, config: publicConfig(next) };
  },

  [MSG.CLEAR_API_KEY]: async () => {
    const next = await saveAiConfig({ apiKey: '' });
    return { ok: true, config: publicConfig(next) };
  },

  [MSG.TEST_CONNECTION]: async (msg) => {
    acquireLock('test');
    try {
      const result = await testConnection(msg.override || null);
      return result;
    } finally {
      releaseLock();
    }
  },

  /**
   * ChatGPT mode: state of the local helper, as the panel needs to render it.
   *
   * Never fails. "The helper is not running" is a state, not an error, and a
   * route that threw for it would make the panel show a red banner on every
   * open for a user who simply has not started the helper yet.
   */
  [MSG.CHATGPT_STATUS]: async () => {
    const cfg = await loadAiConfig();
    return { ok: true, status: await helperStatus(cfg) };
  },

  /**
   * Begin a sign-in and hand the panel the URL to open.
   *
   * The worker does not open the tab itself: the panel's click is the user
   * gesture this act belongs to, and a route that opens windows as a side effect
   * of being called is a route that can be called by anything.
   */
  [MSG.CHATGPT_SIGN_IN]: async () => {
    acquireLock('chatgpt-signin');
    try {
      const cfg = await loadAiConfig();
      const out = await startSignIn(cfg);
      return { ok: true, authorizeUrl: out.authorizeUrl, firstRegistration: out.firstRegistration };
    } finally {
      releaseLock();
    }
  },

  [MSG.CHATGPT_SIGN_OUT]: async () => {
    acquireLock('chatgpt-signout');
    try {
      const cfg = await loadAiConfig();
      const out = await signOut(cfg);
      log('ChatGPT sign-out', out.revoked ? 'revoked' : 'local only');
      return { ok: true, revoked: out.revoked, message: out.message, status: await helperStatus(cfg) };
    } finally {
      releaseLock();
    }
  },

  [MSG.CHATGPT_MODELS]: async () => {
    acquireLock('chatgpt-models');
    try {
      const cfg = await loadAiConfig();
      const out = await listModels(cfg);
      return { ok: true, models: out.models, total: out.total, visibilityReported: out.visibilityReported };
    } finally {
      releaseLock();
    }
  },

  [MSG.CHATGPT_TEST_REQUEST]: async (msg) => {
    acquireLock('chatgpt-test');
    try {
      return await testChatGPTRequest(msg.override || null);
    } finally {
      releaseLock();
    }
  },

  [MSG.GET_CHAT_CONTEXT]: async (msg) => {
    acquireLock('read');
    try {
      const ctx = await opReadChat({ revealPhone: msg && msg.revealPhone === true });
      return { ok: true, context: publicContext(ctx) };
    } finally {
      releaseLock();
    }
  },

  [MSG.GENERATE_REPLY]: async () => {
    acquireLock('generate');
    try {
      const { text, context } = await opGenerateReply();
      return {
        ok: true,
        text,
        context: publicContext(context),
      };
    } finally {
      releaseLock();
    }
  },

  [MSG.SEND_MESSAGE]: async (msg) => {
    acquireLock('send');
    try {
      const context = msg.context || (await opReadChat());
      const text = (msg.text || '').trim();
      if (!text) {
        const e = new Error('Nothing to send — the reply box is empty.');
        e.code = ERR.EMPTY_MESSAGE;
        throw e;
      }
      const { phone } = await opWriteAndSend(text, msg.chatId || context.chatId, context);
      return { ok: true, phone, contactName: context.contactName };
    } finally {
      releaseLock();
    }
  },

  /**
   * Test/diagnostic bridge: run a content-script DOM operation and return the
   * raw result. Kept because the content script is only reachable through the
   * service worker, and verifying a real send requires exactly that path.
   */
  [MSG.DOM_PROBE]: async (msg) => {
    const tab = await findWhatsAppTab();
    if (!tab) {
      const e = new Error('WhatsApp Web is not open.');
      e.code = ERR.WHATSAPP_NOT_OPEN;
      throw e;
    }
    if (msg.kind === 'SET_TEXT') {
      return sendToTab(tab.id, { type: MSG.SET_COMPOSER_TEXT, text: msg.text });
    }
    if (msg.kind === 'CLEAR') {
      return sendToTab(tab.id, { type: MSG.CLEAR_COMPOSER });
    }
    if (msg.kind === 'CLICK_SEND') {
      // Exercises the content script's own guard, bypassing the worker's Gate #1.
      // Used by the safety tests to prove layer 2 is independent of layer 1.
      return sendToTab(tab.id, { type: MSG.CLICK_SEND, chatId: msg.chatId });
    }
    if (msg.kind === 'CHAT_CONTEXT') {
      return sendToTab(tab.id, { type: MSG.GET_CHAT_CONTEXT });
    }
    const e = new Error(`Unknown DOM probe: ${msg.kind}`);
    e.code = ERR.UNKNOWN_ERROR;
    throw e;
  },

  [MSG.FOLLOWUP_AND_SEND]: async () => {
    acquireLock('followup');
    try {
      return { ok: true, ...(await opFollowUpAndSend()) };
    } finally {
      releaseLock();
    }
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const route = ROUTES[msg && msg.type];
  if (!route) {
    sendResponse({ ok: false, code: 'UNKNOWN_MESSAGE_TYPE', message: `No route for ${msg && msg.type}` });
    return false;
  }
  Promise.resolve()
    .then(() => route(msg))
    .then((res) => sendResponse(res))
    .catch((err) => {
      const code = (err && err.code) || 'UNKNOWN_ERROR';
      logError('Route error', msg.type, code);
      const res = { ok: false, code, message: (err && err.message) || String(err) };
      // Field-level detail travels with the failure so the panel can name the
      // box that needs filling in, instead of a generic "not configured". These
      // are labels and field names — never a value, and never the key.
      if (err && err.missingFields) res.missingFields = err.missingFields;
      if (err && err.missingFieldLabels) res.missingFieldLabels = err.missingFieldLabels;
      sendResponse(res);
    });
  return true;
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async (details) => {
  log('Extension installed / updated', details && details.reason);
  // Seed the config record on a fresh install so the panel always has a shape
  // to render. The seeded values are deliberately empty — no provider, no
  // model, no key — which is what makes the panel show its setup screen instead
  // of a Generate button that cannot work.
  //
  // An install that already has a config is left exactly as it is; that is what
  // keeps an existing user's provider and key working across an upgrade.
  try {
    await seedAiConfigIfMissing();
  } catch (err) {
    logError('config seeding failed', err && err.message);
  }
});

// Side panel behaviour: clicking the toolbar icon opens the panel.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => logError('setPanelBehavior failed', err && err.message));