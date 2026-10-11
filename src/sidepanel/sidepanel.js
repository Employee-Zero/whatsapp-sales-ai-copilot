/**
 * Side panel controller.
 *
 * The panel is a thin view over the service worker: every read, every AI call
 * and every send goes through chrome.runtime messaging, never directly to the
 * page or to an API.
 *
 * The state it owns is all per-chat and all local:
 *   - the last context it rendered, which decides whether Send is usable
 *   - the unsent draft for each chat, in chrome.storage.local
 *   - the extra instruction for each chat, in chrome.storage.local
 *
 * The drafts exist because a single shared textarea is a loaded gun: generate a
 * reply for one customer, click another chat, press Send, and the first
 * customer's reply goes to the second. Each chat now gets its own box, restored
 * when you come back to it.
 *
 * The instructions are per-chat for the same reason — "ask how the loan went"
 * is about one customer — and they are drawn in amber throughout, because the
 * one box in this panel that must never be confused with the reply is the one
 * that tells the AI what to write.
 */

/* global MSG, ERR, PHONE_STATUS, STORAGE_KEYS, DRAFT_LIMITS, INSTRUCTION_LIMITS,
   REPLY_LENGTH_SPECS, THINKING_SPECS, CONTEXT_MESSAGE_CHOICES, AI_FIELD_LABELS,
   CONNECTION_MODE, CONNECTION_MODE_SPECS, CHATGPT_HELPER_DEFAULT_URL, CONNECTOR_RELEASE_URL, CONNECTOR_DOWNLOAD_URL,
   describeTextLength, formatPhoneDisplay, phoneFromDisplayName, helperBaseUrl,
   helperStartCommand, log, logError */

const $ = (id) => document.getElementById(id);

const el = {
  settings: $('settings'),
  btnSettings: $('btn-settings'),

  btnConn: $('btn-conn'),
  connLabel: $('conn-label'),

  setup: $('setup'),
  suModes: $('su-modes'),
  suModeHint: $('su-mode-hint'),
  suChatgpt: $('su-chatgpt'),
  suApiKeyPane: $('su-apikey'),
  suCgB1: $('su-cg-b1'),
  suCgB2: $('su-cg-b2'),
  suCgB3: $('su-cg-b3'),
  suCgA1: $('su-cg-a1'),
  suCgDownload: $('su-cg-download'),
  suCgRecheck: $('su-cg-recheck'),
  suCgFallback: $('su-cg-fallback'),
  suCgRelease: $('su-cg-release'),
  cfgCgB1: $('cfg-cg-b1'),
  cfgCgB2: $('cfg-cg-b2'),
  cfgCgB3: $('cfg-cg-b3'),
  cfgCgA1: $('cfg-cg-a1'),
  cfgCgDownload: $('cfg-cg-download'),
  cfgCgRecheck: $('cfg-cg-recheck'),
  cfgCgFallback: $('cfg-cg-fallback'),
  cfgCgRelease: $('cfg-cg-release'),
  suCgAllow: $('su-cg-allow'),
  cfgCgAllow: $('cfg-cg-allow'),
  cfgThinkingWrap: $('cfg-thinking-wrap'),
  cfgBackupRow: $('cfg-backup-row'),
  cfgApiFallback: $('cfg-apiFallback'),
  cfgBackupHint: $('cfg-backup-hint'),
  cfgAdvApi: $('cfg-adv-api'),
  suCgSignIn: $('su-cg-signin'),
  suCgSignOut: $('su-cg-signout'),
  suCgModel: $('su-cg-model'),
  suCgModelHint: $('su-cg-model-hint'),
  suCgRefresh: $('su-cg-refresh'),
  suCgSave: $('su-cg-save'),
  suCgResult: $('su-cg-result'),
  suBaseUrl: $('su-baseUrl'),
  suApiKey: $('su-apiKey'),
  suModel: $('su-model'),
  suFallback: $('su-fallback'),
  suToggleKey: $('su-toggle-key'),
  suTest: $('su-test'),
  suSave: $('su-save'),
  suResult: $('su-result'),

  quickstart: $('quickstart'),
  qsDone: $('qs-done'),

  cfgSystemPrompt: $('cfg-systemPrompt'),
  btnResetPrompt: $('btn-reset-prompt'),
  cfgContextMessages: $('cfg-contextMessages'),
  cfgThinking: $('cfg-thinking'),

  cfgModes: $('cfg-modes'),
  cfgModeHint: $('cfg-mode-hint'),
  cfgChatgpt: $('cfg-chatgpt'),
  cfgApiKeyPane: $('cfg-apikey'),
  cfgCgSignIn: $('cfg-cg-signin'),
  cfgCgSignOut: $('cfg-cg-signout'),
  cfgCgModel: $('cfg-cg-model'),
  cfgCgModelHint: $('cfg-cg-model-hint'),
  cfgCgRefresh: $('cfg-cg-refresh'),
  cfgCgTest: $('cfg-cg-test'),
  cfgHelperUrl: $('cfg-helperUrl'),
  cgTestResult: $('cg-test-result'),

  cfgPrimaryBaseUrl: $('cfg-primaryBaseUrl'),
  cfgFallbackBaseUrl: $('cfg-fallbackBaseUrl'),
  cfgApiKey: $('cfg-apiKey'),
  cfgModel: $('cfg-model'),
  cfgTemperature: $('cfg-temperature'),
  cfgMaxTokens: $('cfg-maxTokens'),
  cfgMaxChars: $('cfg-maxChars'),
  effectiveTokens: $('effective-tokens'),
  btnToggleKey: $('btn-toggle-key'),
  btnTest: $('btn-test'),
  btnSaveConfig: $('btn-save-config'),
  btnClearKey: $('btn-clear-key'),
  testResult: $('test-result'),

  chatName: $('chat-name'),
  chatPhone: $('chat-phone'),
  chatCount: $('chat-count'),
  chatBreakdown: $('chat-breakdown'),

  btnRead: $('btn-read'),
  btnGenerate: $('btn-generate'),
  btnSend: $('btn-send'),
  btnFollowup: $('btn-followup'),

  lengthSeg: $('length-seg'),
  lengthCount: $('length-count'),

  insAdd: $('ins-add'),
  insPanel: $('ins-panel'),
  insBox: $('ins-box'),
  insClear: $('ins-clear'),
  insDone: $('ins-done'),
  insChip: $('ins-chip'),
  insChipText: $('ins-chip-text'),

  status: $('status'),
  replyState: $('reply-state'),
  blocked: $('blocked'),
  blockedDetail: $('blocked-detail'),

  reply: $('reply'),
  replyMeta: $('reply-meta'),
};

/**
 * Everything we know about the currently open chat.
 * @type {{chatId: string, chatIdStable: boolean, contactName: string, phone: string,
 *         phoneStatus: string, isGroup: boolean, counts: object, hasOpenChat: boolean}|null}
 */
let current = null;

/** The chat the reply box currently belongs to. */
let currentChatId = null;

/**
 * What the reply box holds: '' (nothing / typed by hand), 'draft' (the AI wrote
 * it, not sent) or 'sent' (Follow-up & Send already delivered it).
 */
let draftState = '';

/** True while any async operation is running — blocks re-entry. */
let busy = false;

/** Timer behind the auto-hiding status line. */
let statusTimer = null;

/** The stored AI config, as last seen from the worker. */
let cfg = null;

/**
 * First-run state, mirrored from chrome.storage.local.
 *
 * `connected` is set the first time a complete configuration is saved, and is
 * what stops the welcome screen reappearing on every panel open. `dismissed`
 * only concerns the short list of steps shown right after connecting.
 */
let onboarding = { connected: false, dismissed: false };

/**
 * True once the user has typed into the welcome form.
 *
 * The form is a second view of the same stored config the Settings pane edits,
 * so it has to follow that config — but not while somebody is halfway through
 * typing a Base URL, which is exactly when a poll-driven re-render would land.
 */
let setupDirty = false;

/** In-memory mirror of the per-chat instruction store. */
let instructions = null;

/**
 * Which of the three instruction states is on screen. Only meaningful together
 * with `currentChatId`: the editor is open for the chat it was opened on.
 */
let insOpen = false;

/** Pending debounced write of the instruction box. */
let insTimer = null;

/** In-memory mirror of the draft store. */
let drafts = null;

/**
 * Which of the two connection methods the form is currently showing.
 *
 * Separate from `cfg.connectionMode` on purpose. The segmented control is a form
 * field like any other: clicking it decides what gets saved, not what is saved.
 * Reading the mode off `cfg` here would make the panes jump back the next time
 * anything re-rendered the form.
 */
let modeChoice = CONNECTION_MODE.API_KEY;

/**
 * The last `/auth/status` payload from the worker, or null before the first read.
 *
 * Null is a real state — "we have not asked yet" is not "signed out" — and the
 * panel says "Checking…" rather than guessing.
 *
 * @type {{helper: string, signedIn: boolean, planScope: boolean, email: string,
 *         label: string, expiresInSec: number, signIn: string, signInError: string,
 *         startCommand: string, helperUrl: string, error: string}|null}
 */
let chatgptStatus = null;

/**
 * The models this ChatGPT account reported, as last fetched.
 *
 * Never synthesised locally. A model name that did not come from the account's
 * own catalogue is a request that will fail later with a less useful message.
 *
 * @type {Array<{slug: string, displayName: string}>}
 */
let chatgptModels = [];

/** Timer that watches for a sign-in completing in the other tab. */
let signInWatch = null;

// ---------------------------------------------------------------------------
// Per-chat drafts
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<object>} the draft store, `{}` when unreadable
 */
async function loadDrafts() {
  if (drafts) return drafts;
  try {
    const got = await chrome.storage.local.get(STORAGE_KEYS.DRAFTS);
    const raw = got && got[STORAGE_KEYS.DRAFTS];
    drafts = raw && typeof raw === 'object' ? raw : {};
  } catch (err) {
    logError('draft store read failed', err && err.message);
    drafts = {};
  }
  return drafts;
}

async function persistDrafts() {
  const store = drafts || {};
  const ids = Object.keys(store);
  if (ids.length > DRAFT_LIMITS.MAX_CHATS) {
    ids
      .sort((a, b) => (store[a].at || 0) - (store[b].at || 0))
      .slice(0, ids.length - DRAFT_LIMITS.MAX_CHATS)
      .forEach((id) => delete store[id]);
  }
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.DRAFTS]: store });
  } catch (err) {
    logError('draft store write failed', err && err.message);
  }
}

/**
 * Remember what is in the reply box under a chat id.
 *
 * An empty box deletes the entry rather than storing a blank, and a box marked
 * 'sent' is never stored at all. That second rule matters: Follow-up & Send
 * leaves the delivered text on screen so the user can see what went out, and
 * restoring it in a later session would put a Send button next to a message the
 * customer has already received — one click from sending it twice.
 *
 * @param {string} chatId
 * @param {string} text
 * @param {string} state '' | 'draft' | 'sent'
 */
async function saveDraft(chatId, text, state) {
  if (!chatId) return;
  const store = await loadDrafts();
  const body = state === 'sent' ? '' : String(text || '').slice(0, DRAFT_LIMITS.MAX_CHARS);
  if (!body.trim()) {
    if (store[chatId]) {
      delete store[chatId];
      await persistDrafts();
    }
    return;
  }
  const previous = store[chatId];
  if (previous && previous.text === body && previous.state === state) return;
  store[chatId] = { text: body, state: state || '', at: Date.now() };
  await persistDrafts();
}

/**
 * Drop a chat's draft — used once the text has actually been sent.
 * @param {string} chatId
 */
async function clearDraft(chatId) {
  if (!chatId) return;
  const store = await loadDrafts();
  if (!store[chatId]) return;
  delete store[chatId];
  await persistDrafts();
}

// ---------------------------------------------------------------------------
// Per-chat instructions
// ---------------------------------------------------------------------------

/**
 * The instruction store: chatId → { text, at }.
 *
 * Same lifecycle as the drafts, for the same reason — an instruction is about
 * one customer. It goes to the worker on generate, not to the customer, so it
 * needs no 'sent' state and no state column at all.
 *
 * @returns {Promise<object>} the store, `{}` when unreadable
 */
async function loadInstructions() {
  if (instructions) return instructions;
  try {
    const got = await chrome.storage.local.get(STORAGE_KEYS.INSTRUCTIONS);
    const raw = got && got[STORAGE_KEYS.INSTRUCTIONS];
    instructions = raw && typeof raw === 'object' ? raw : {};
  } catch (err) {
    logError('instruction store read failed', err && err.message);
    instructions = {};
  }
  return instructions;
}

async function persistInstructions() {
  const store = instructions || {};
  const ids = Object.keys(store);
  if (ids.length > INSTRUCTION_LIMITS.MAX_CHATS) {
    ids
      .sort((a, b) => (store[a].at || 0) - (store[b].at || 0))
      .slice(0, ids.length - INSTRUCTION_LIMITS.MAX_CHATS)
      .forEach((id) => delete store[id]);
  }
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.INSTRUCTIONS]: store });
  } catch (err) {
    logError('instruction store write failed', err && err.message);
  }
}

/**
 * Remember the instruction for a chat. Empty text deletes the entry rather than
 * storing a blank, so "has an instruction" stays a single truthy check.
 *
 * @param {string} chatId
 * @param {string} text
 */
async function saveInstruction(chatId, text) {
  if (!chatId) return;
  const store = await loadInstructions();
  const body = String(text || '').slice(0, INSTRUCTION_LIMITS.MAX_CHARS).trim();
  const previous = store[chatId];
  if (!body) {
    if (previous) {
      delete store[chatId];
      await persistInstructions();
    }
    return;
  }
  if (previous && previous.text === body) return;
  store[chatId] = { text: body, at: Date.now() };
  await persistInstructions();
}

/**
 * Write the instruction box out now, cancelling the pending debounce.
 *
 * Called before a chat switch and before either generate path. The box is
 * debounced, and a Generate click lands inside that window easily; without this
 * the worker would answer using the previous instruction, or none.
 */
async function flushInstruction() {
  if (insTimer) {
    clearTimeout(insTimer);
    insTimer = null;
  }
  await saveInstruction(currentChatId, el.insBox.value);
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

/**
 * Show a status line.
 *
 * Informational and success messages clear themselves after a few seconds —
 * the panel should not narrate routine work. Errors and warnings stay until
 * something replaces them, because the user needs to read those.
 *
 * @param {string} text
 * @param {'info'|'error'|'warn'|'success'} [kind]
 */
function setStatus(text, kind = 'info') {
  if (statusTimer) {
    clearTimeout(statusTimer);
    statusTimer = null;
  }
  const clearInline = () => {
    el.replyState.textContent = '';
    el.replyState.title = '';
    el.replyState.className = 'reply-state';
  };
  const clearBanner = () => {
    el.status.classList.add('hidden');
    el.status.textContent = '';
  };

  if (!text) {
    clearInline();
    clearBanner();
    return;
  }

  if (kind === 'progress') {
    // Work in flight. Deliberately has no timer: the previous behaviour cleared
    // "Generating…" after 4.5 s, so a slow reply left a blank header between the
    // label vanishing and the text arriving. It stays until replaced.
    clearBanner();
    el.replyState.textContent = text;
    el.replyState.title = text;
    el.replyState.className = 'reply-state progress';
    return;
  }

  if (kind === 'info' || kind === 'success' || kind === 'ready') {
    // Routine progress lives in the AI Reply header, in space that is always
    // there, so the reply box never jumps when it appears or goes away.
    clearBanner();
    el.replyState.textContent = text;
    el.replyState.title = text;
    el.replyState.className = `reply-state${kind === 'success' || kind === 'ready' ? ' success' : ''}`;
    statusTimer = setTimeout(() => {
      statusTimer = null;
      clearInline();
    }, 4500);
    return;
  }

  // Errors and warnings carry diagnostics, so they keep the full-width banner.
  clearInline();
  el.status.textContent = text;
  el.status.className = `status ${kind}`.trim();
  el.status.classList.remove('hidden');
}

/**
 * Set the disabled state of a button together with a spinner class.
 * @param {HTMLButtonElement} btn
 * @param {boolean} disabled
 * @param {boolean} [spinner]
 */
function setBtn(btn, disabled, spinner = false) {
  btn.disabled = disabled;
  btn.classList.toggle('busy', spinner);
}

/**
 * Update the two readouts tied to the reply box: the draft state next to the
 * "AI Reply" label, and how long the draft actually is.
 */
function updateReplyMeta() {
  const text = el.reply.value;
  el.replyMeta.textContent = text.trim() ? draftState : '';
  el.lengthCount.textContent = describeTextLength(text);
}

/**
 * Re-evaluate what the user is allowed to click.
 *
 * Sending is open to any conversation — 1:1 or group. The only things that can
 * disable the buttons are: no conversation open, another operation in flight,
 * or (for Send) an empty reply box. The worker re-checks the open conversation
 * immediately before it clicks Send, so this is convenience, not the guard.
 */
function refreshSendButtons() {
  const hasChat = !!(current && current.hasOpenChat);
  const hasText = el.reply.value.trim().length > 0;

  setBtn(el.btnSend, busy || !hasChat || !hasText);
  setBtn(el.btnFollowup, busy || !hasChat);
  setBtn(el.btnGenerate, busy || !hasChat);

  // Only shown when something is genuinely wrong — never for routine state.
  if (current && !current.hasOpenChat) {
    el.blocked.classList.remove('hidden');
    el.blockedDetail.textContent =
      'No conversation is open. Open WhatsApp Web and click the customer you want to reply to.';
  } else {
    el.blocked.classList.add('hidden');
    el.blockedDetail.textContent = '';
  }
}

/**
 * Render the identity bar and the conversation strip.
 *
 * The name shown is whatever WhatsApp itself decided: a saved contact's name,
 * otherwise the name the customer set for themselves, otherwise their number.
 * When that name already IS the number it is not printed twice — the number
 * simply moves to the identity slot, which is where the eye looks for it.
 *
 * This is also what publishes the context to the rest of the panel: it assigns
 * `current` before calling `refreshSendButtons()`. Callers used to assign
 * `current` themselves *after* calling this, so the button state was always one
 * render behind — opening the panel left both buttons disabled for a full poll
 * interval, because `current` was still null when the buttons were evaluated.
 *
 * @param {object} ctx
 */
function renderContext(ctx) {
  current = ctx;

  const name = (ctx.contactName || '').trim();
  const phoneText = formatPhoneDisplay(ctx.phone);
  const nameIsNumber = !!phoneFromDisplayName(name);

  if (nameIsNumber) {
    el.chatName.textContent = formatPhoneDisplay(phoneFromDisplayName(name));
    el.chatName.classList.remove('muted');
    el.chatPhone.textContent = '';
  } else {
    el.chatName.textContent = name || (ctx.hasOpenChat ? '(unnamed chat)' : 'No chat open');
    el.chatName.classList.toggle('muted', !name);
    // A group has no single number, and WhatsApp does not print a saved
    // contact's number in the header at all — say nothing rather than clutter
    // the bar with a placeholder for information that does not exist.
    el.chatPhone.textContent = ctx.isGroup ? 'group' : phoneText;
  }

  el.chatCount.textContent = String(ctx.counts.total);
  if (ctx.counts.total) {
    el.chatBreakdown.textContent = `${ctx.counts.incoming} received / ${ctx.counts.outgoing} sent`;
  } else {
    el.chatBreakdown.textContent = '';
  }

  refreshSendButtons();
}

/**
 * Show whichever of the three shapes the instruction is in.
 *
 *   nothing written  → a slim "add" row. Most customers need no instruction, so
 *                      the empty state is the one that must not take up room.
 *   editor open      → the amber box
 *   written, closed  → a two-line chip. Collapsed, not hidden: while the reply
 *                      is being reviewed it should still be possible to check it
 *                      against what was actually asked for.
 *
 * All three collapse to nothing when no conversation is open — an instruction
 * has no meaning without a chat to attach it to.
 */
async function renderInstruction() {
  const store = await loadInstructions();
  const active = !!(current && current.hasOpenChat) && !!currentChatId;
  const entry = active ? store[currentChatId] : null;
  const has = !!(entry && entry.text);

  el.insAdd.classList.toggle('hidden', !active || insOpen || has);
  el.insPanel.classList.toggle('hidden', !active || !insOpen);
  el.insChip.classList.toggle('hidden', !active || insOpen || !has);

  el.insChipText.textContent = has ? entry.text : '';
  // "Clear" only means something once there is something to clear.
  el.insClear.classList.toggle('hidden', !el.insBox.value.trim());
}

/**
 * Point the panel's per-chat boxes at a chat.
 *
 * Called on every context render, but only does work when the chat actually
 * changed: stash what is in the reply and instruction boxes under the old chat,
 * then restore whatever the new chat had. An unstable id (the header has not
 * rendered yet, mid-switch) is ignored rather than treated as a real chat —
 * otherwise a draft would be filed under "unknown" and appear to vanish.
 *
 * Both boxes move together because they are keyed by the same chat id. Keeping
 * them in one function is deliberate: two sync functions would need two "last
 * chat" variables, and two variables that must stay equal is a bug waiting to
 * be written.
 *
 * @param {object} ctx
 */
async function syncPanesToChat(ctx) {
  const id = ctx.chatIdStable ? ctx.chatId : '';
  if (!id || id === currentChatId) return;

  await flushInstruction();
  await saveDraft(currentChatId, el.reply.value, draftState);
  currentChatId = id;

  const store = await loadDrafts();
  const draft = store[id];
  el.reply.value = draft ? draft.text : '';
  draftState = draft ? draft.state || '' : '';
  updateReplyMeta();

  const insStore = await loadInstructions();
  const entry = insStore[id];
  el.insBox.value = entry ? entry.text : '';
  // Always collapsed on arrival: "does this customer have an instruction?" is a
  // question the panel should answer without anything being opened.
  insOpen = false;
}

// ---------------------------------------------------------------------------
// First run
// ---------------------------------------------------------------------------

/**
 * Read the first-run flags.
 *
 * Kept out of the AI config on purpose: they describe what the *user* has seen,
 * not how the extension talks to a provider, and clearing one should never be a
 * side effect of the other.
 *
 * @returns {Promise<{connected: boolean, dismissed: boolean}>}
 */
async function loadOnboarding() {
  try {
    const got = await chrome.storage.local.get(STORAGE_KEYS.ONBOARDING);
    const raw = got && got[STORAGE_KEYS.ONBOARDING];
    onboarding = {
      connected: !!(raw && raw.connected),
      dismissed: !!(raw && raw.dismissed),
    };
  } catch (err) {
    logError('onboarding read failed', err && err.message);
    onboarding = { connected: false, dismissed: false };
  }
  return onboarding;
}

/**
 * Write the first-run flags, merging over whatever is stored.
 * @param {{connected?: boolean, dismissed?: boolean}} patch
 */
async function saveOnboarding(patch) {
  onboarding = Object.assign({}, onboarding, patch);
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.ONBOARDING]: onboarding });
  } catch (err) {
    logError('onboarding write failed', err && err.message);
  }
  renderOnboarding();
}

/**
 * Which of the panel's two first-run screens belongs on screen, if either.
 *
 *   config incomplete   → the setup form, unconditionally. The extension cannot
 *                         generate anything until it is filled in, so hiding it
 *                         would leave the user with a dead Generate button and
 *                         no explanation.
 *   complete, unseen    → the short "what to click next" list.
 *   complete, seen      → neither. Everything lives behind ⚙ from then on.
 */
function renderOnboarding() {
  const configured = !!(cfg && cfg.hasRequiredConfig);
  const showSetup = !configured;
  const showQuickstart = configured && onboarding.connected && !onboarding.dismissed;

  el.setup.classList.toggle('hidden', !showSetup);
  el.quickstart.classList.toggle('hidden', !showQuickstart);

  if (showSetup && cfg) renderSetupForm(cfg);
}

/**
 * Point the welcome form at the stored configuration.
 *
 * The API key is never rendered back — the field is left blank with a masked
 * hint, exactly as in Settings, so replacing a key never means deleting the old
 * one from the DOM first. A blank field on save means "keep the stored key".
 *
 * @param {object} c public config shape from the service worker
 */
function renderSetupForm(c) {
  if (setupDirty) return;
  el.suBaseUrl.value = c.primaryBaseUrl || '';
  el.suFallback.value = c.fallbackBaseUrl || '';
  el.suModel.value = c.model || '';
  el.suApiKey.value = '';
  el.suApiKey.placeholder = c.hasApiKey ? `${'•'.repeat(20)}${c.keyHint || ''}` : 'the key from your provider';
  // A brand-new install (nothing configured for either route) opens on ChatGPT,
  // the primary route. Anyone who already has an API key or a ChatGPT model keeps
  // exactly the mode they saved.
  const untouched = !c.hasApiKey && !c.primaryBaseUrl && !c.chatgptModel;
  setMode(untouched ? CONNECTION_MODE.CHATGPT : c.connectionMode, { save: false });
  renderChatGptPanes({ resetModels: true });
}

/** Read the welcome form into the same patch shape Settings produces. */
function readSetupForm() {
  const patch = {
    connectionMode: modeChoice,
    primaryBaseUrl: el.suBaseUrl.value.trim(),
    fallbackBaseUrl: el.suFallback.value.trim(),
    model: el.suModel.value.trim(),
    chatgptModel: el.suCgModel.value,
    // Blank is fine: the worker normalises an empty helper URL back to the
    // documented loopback default, so the welcome screen never has to render a
    // field the user cannot see in order to send a sensible value.
    helperUrl: el.cfgHelperUrl.value.trim(),
  };
  const key = el.suApiKey.value.trim();
  if (key) patch.apiKey = key;
  return patch;
}

/** Show a result line under the welcome form. */
function setSetupResult(text, kind) {
  if (!text) {
    el.suResult.classList.add('hidden');
    el.suResult.textContent = '';
    return;
  }
  el.suResult.textContent = text;
  el.suResult.className = `test-result ${kind}`;
  el.suResult.classList.remove('hidden');
}

/**
 * Bring the setup form into view and put the caret in the first empty box.
 *
 * Called when a Generate is refused for want of configuration, so the user is
 * not left reading an error with no idea where to go next.
 */
function focusSetup() {
  renderOnboarding();
  const target = modeChoice === CONNECTION_MODE.CHATGPT ? el.suChatgpt : el.suApiKeyPane;
  target.scrollIntoView({ block: 'start' });
  if (modeChoice === CONNECTION_MODE.CHATGPT) {
    if (el.suCgSignIn.classList.contains('hidden')) el.suCgModel.focus();
    else el.suCgSignIn.focus();
    return;
  }
  const order = [el.suBaseUrl, el.suApiKey, el.suModel, el.suFallback];
  const empty = order.find((input) => !input.value.trim() && input !== el.suApiKey);
  if (empty) empty.focus();
}

/**
 * Save the welcome form and move on.
 *
 * "Connected" is recorded only when the saved result genuinely has everything a
 * request needs — a half-filled form must not dismiss the screen that is asking
 * for the rest.
 */
async function onSetupSave() {
  const patch = readSetupForm();
  const res = await callWorker({ type: MSG.SET_AI_CONFIG, patch });
  if (!res.ok) {
    setSetupResult(describeError(res.code, res.message, res), 'error');
    return;
  }
  setupDirty = false;
  renderConfig(res.config);
  setSetupResult('', '');
  setCgResult('', 'success');

  if (res.config.hasRequiredConfig) {
    await saveOnboarding({ connected: true, dismissed: false });
    el.quickstart.scrollIntoView({ block: 'start' });
    setStatus(
      modeChoice === CONNECTION_MODE.CHATGPT ? 'ChatGPT plan connected.' : 'AI provider connected.',
      'success',
    );
    return;
  }

  // Saved, but still not usable. On the ChatGPT path the only thing that can be
  // missing is the model, and saying so is more use than re-rendering the same
  // screen silently.
  if (modeChoice === CONNECTION_MODE.CHATGPT) {
    setCgResult('Saved. Choose a model above to finish — replies need one.', 'error');
  } else {
    renderOnboarding();
  }
}

/** Test the values currently typed in the welcome form, without saving them. */
async function onSetupTest() {
  await run(el.suTest, 'setup-test', async () => {
    setSetupResult('Testing…', 'success');
    const res = await callWorker({
      type: MSG.TEST_CONNECTION,
      override: readSetupForm(),
    });

    if (!res.ok) {
      const lines = [res.error || 'Request failed.'];
      if (res.status) lines.push(`HTTP status: ${res.status}`);
      if (res.attempts && res.attempts.length > 1) {
        lines.push(`Tried: ${res.attempts.map((a) => `${a.host} (${a.code})`).join(' → ')}`);
      }
      setSetupResult(lines.join('\n'), 'error');
      return;
    }

    const via = res.usedFallback ? ' (via fallback address)' : '';
    setSetupResult(
      `Connection successful${via}\nModel: ${res.model}\nAddress: ${res.host}\nResponse time: ${res.responseMs} ms`,
      'success',
    );
  });
}

// ---------------------------------------------------------------------------
// ChatGPT subscription connection
//
// The panel's whole job on this path is to be a truthful readout of a process it
// does not control. Three things follow from that, and they explain most of the
// code below:
//
//   1. The extension never sees a credential. The sign-in token lives in a file
//      owned by the local helper; everything here is an HTTP call to a loopback
//      address, and the panel has no field that could hold a token even by
//      accident. That is the design, not an omission.
//
//   2. Sign-in happens in a real browser tab, not in a popup the extension
//      intercepts. The documented callback for this flow is a listener on
//      127.0.0.1, which an MV3 extension cannot open — `launchWebAuthFlow` only
//      intercepts `chromiumapp.org`, which is not an accepted redirect. So the
//      panel opens the authorize URL with chrome.tabs.create and then watches
//      the helper's status until the other tab finishes.
//
//   3. Nothing about the state is inferred. "Not signed in", "helper not
//      running" and "signed in but without plan permission" are three different
//      screens because they need three different actions from the user.
// ---------------------------------------------------------------------------

/** The two panes that show ChatGPT state — first-run and Settings. */
const CG_PANES = [
  { b1: el.suCgB1, b2: el.suCgB2, b3: el.suCgB3, a1: el.suCgA1, fallback: el.suCgFallback, recheck: el.suCgRecheck, signIn: el.suCgSignIn, signOut: el.suCgSignOut, model: el.suCgModel, modelHint: el.suCgModelHint, allow: el.suCgAllow, refresh: el.suCgRefresh, save: el.suCgSave },
  { b1: el.cfgCgB1, b2: el.cfgCgB2, b3: el.cfgCgB3, a1: el.cfgCgA1, fallback: el.cfgCgFallback, recheck: el.cfgCgRecheck, signIn: el.cfgCgSignIn, signOut: el.cfgCgSignOut, model: el.cfgCgModel, modelHint: el.cfgCgModelHint, allow: el.cfgCgAllow, refresh: el.cfgCgRefresh, test: el.cfgCgTest },
];

/** Fill one step badge: a small coloured pill at the end of the step's title row. */
function setBadge(node, text, kind, title = '') {
  node.textContent = text;
  node.title = title;
  node.className = `cg-badge ${kind}`;
}

/** How often the panel re-reads the helper's status while a sign-in is open. */
const SIGN_IN_POLL_MS = 2000;

/** Give up watching after this long; the user can always press the button again. */
const SIGN_IN_WATCH_MS = 3 * 60 * 1000;

/**
 * Whether Chrome has granted `http://127.0.0.1/*`. null = not asked yet.
 * Only consulted on the ChatGPT path; API Key mode never requests it.
 * @type {boolean|null}
 */
let loopbackGranted = null;

async function checkLoopbackPermission() {
  try {
    loopbackGranted = await chrome.permissions.contains({ origins: ['http://127.0.0.1/*'] });
  } catch (err) {
    loopbackGranted = false;
  }
  return loopbackGranted;
}

/**
 * Recheck: look for the Connector now. A user gesture, so if the local-access
 * permission is missing Chrome can ask for it first — without it the panel
 * cannot know whether the Connector runs. Touches nothing else: no reload, no
 * sign-in, no reply.
 */
async function onRecheck(btn) {
  await run(btn, 'chatgpt-recheck', async () => {
    if (loopbackGranted !== true) loopbackGranted = await ensureLoopbackPermission();
    renderChatGptPanes();
    if (loopbackGranted) await refreshChatGptStatus({ quiet: true });
  });
}

// Download for Mac: the real release asset, with the release page as a fallback.
for (const [dl, rel] of [[el.suCgDownload, el.suCgRelease], [el.cfgCgDownload, el.cfgCgRelease]]) {
  dl.href = CONNECTOR_DOWNLOAD_URL;
  rel.href = CONNECTOR_RELEASE_URL;
}

/** The "Allow local access" button: a user gesture, so Chrome can show its prompt. */
async function onAllowLocalAccess(btn) {
  await run(btn, 'chatgpt-allow', async () => {
    loopbackGranted = await ensureLoopbackPermission();
    renderChatGptPanes();
    if (!loopbackGranted) {
      setCgResult('Chrome did not grant local access, so ChatGPT Connector cannot be found. Press Allow Access to try again.', 'error');
      return;
    }
    setCgResult('', 'success');
    await refreshChatGptStatus({ quiet: true });
  });
}

/** The connection method that is actually saved — not the one the form shows. */
function activeMode() {
  return cfg && cfg.connectionMode === CONNECTION_MODE.CHATGPT ? CONNECTION_MODE.CHATGPT : CONNECTION_MODE.API_KEY;
}

/**
 * Show one method and hide the other, in both places the choice is offered.
 *
 * Does not save anything. The segmented control is a form field: it decides what
 * Save will write, not what is stored, so switching back and forth to compare the
 * two panes costs nothing and loses nothing.
 *
 * @param {string} mode one of CONNECTION_MODE
 * @param {{save?: boolean}} [opts] save=true is for the Settings pane, where
 *   changing the method IS the edit and there is no Save button to press.
 */
function setMode(mode, { save = false } = {}) {
  modeChoice = mode === CONNECTION_MODE.CHATGPT ? CONNECTION_MODE.CHATGPT : CONNECTION_MODE.API_KEY;
  const isCg = modeChoice === CONNECTION_MODE.CHATGPT;

  for (const seg of [el.suModes, el.cfgModes]) {
    if (!seg) continue;
    for (const btn of seg.querySelectorAll('.seg-btn')) {
      btn.classList.toggle('is-on', btn.dataset.mode === modeChoice);
    }
  }

  el.suChatgpt.classList.toggle('hidden', !isCg);
  el.suApiKeyPane.classList.toggle('hidden', isCg);
  el.cfgChatgpt.classList.toggle('hidden', !isCg);
  // ChatGPT is the primary route. In that mode the API Key fields are only a
  // backup: they show when the user turns the backup on, and the opt-in itself
  // is offered only there. In "API Key only" the fields are the whole setup.
  const backupOn = isCg && el.cfgApiFallback.checked;
  el.cfgBackupRow.classList.toggle('hidden', !isCg);
  el.cfgApiKeyPane.classList.toggle('hidden', isCg && !backupOn);

  const spec = CONNECTION_MODE_SPECS[modeChoice];
  el.suModeHint.textContent = spec ? spec.hint : '';
  el.cfgModeHint.textContent = spec ? spec.hint : '';

  // Thinking depth, temperature and token ceiling are API Key settings: the
  // ChatGPT route cannot accept them, so they are not shown for it.
  const apiShown = !isCg || backupOn;
  el.cfgThinkingWrap.classList.toggle('hidden', !apiShown);
  el.cfgAdvApi.classList.toggle('hidden', !apiShown);
  updateBackupHint();

  renderConnectionPill();

  if (isCg) {
    // The state this pane renders is not in the extension, so it has to be asked
    // for. Quiet: a failed status read is a state the pane draws, not an error
    // to announce.
    checkLoopbackPermission()
      .then((granted) => (granted ? refreshChatGptStatus({ quiet: true }) : renderChatGptPanes()))
      .catch(() => {});
    if (save && modeChoice !== activeMode()) persistMode();
  }
}

/** Say so when the backup is on but cannot work yet. */
function updateBackupHint() {
  const missing = [];
  if (!el.cfgPrimaryBaseUrl.value.trim()) missing.push('API Base URL');
  if (!el.cfgApiKey.value.trim() && !(cfg && cfg.hasApiKey)) missing.push('API Key');
  if (!el.cfgModel.value.trim()) missing.push('Model ID');
  el.cfgBackupHint.textContent =
    modeChoice === CONNECTION_MODE.CHATGPT && el.cfgApiFallback.checked && missing.length
      ? `Backup is not active yet. Fill in: ${missing.join(', ')}.`
      : '';
}

/** Save just the method, for the Settings pane where the choice is the edit. */
async function persistMode() {
  const res = await callWorker({
    type: MSG.SET_AI_CONFIG,
    patch: { connectionMode: modeChoice, chatgptModel: el.cfgCgModel.value, helperUrl: el.cfgHelperUrl.value.trim() },
  });
  if (!res.ok) {
    setStatus(describeError(res.code, res.message, res), 'error');
    return;
  }
  renderConfig(res.config);
  setStatus(
    modeChoice === CONNECTION_MODE.CHATGPT
      ? 'Replies will use your ChatGPT plan.'
      : 'Replies will use your API key.',
    'success',
  );
}

/**
 * The header pill: which AI is answering, and whether it can.
 *
 * Reads the *saved* mode, never the form's. A pill that changed colour because
 * an unsaved segmented control moved would be reporting a connection that does
 * not exist yet.
 */
function renderConnectionPill() {
  const pill = el.btnConn;
  const label = el.connLabel;
  pill.className = 'conn-pill';

  if (!cfg) {
    label.textContent = 'Not set up';
    pill.title = 'AI connection';
    return;
  }

  if (activeMode() === CONNECTION_MODE.CHATGPT) {
    const model = shortModelName(cfg.chatgptModel);
    if (!chatgptStatus) {
      label.textContent = 'Checking…';
      pill.classList.add('is-busy');
      pill.title = 'Asking ChatGPT Connector for its status.';
      return;
    }
    if (chatgptStatus.helper !== 'running') {
      label.textContent = 'Connector off';
      pill.classList.add('is-warn');
      pill.title = 'ChatGPT Connector is not running, so your ChatGPT plan cannot be reached.';
      return;
    }
    if (!chatgptStatus.signedIn) {
      label.textContent = chatgptStatus.signIn === 'error' ? 'Sign-in failed' : 'Sign in';
      pill.classList.add('is-warn');
      pill.title = 'No ChatGPT account is connected yet.';
      return;
    }
    if (!chatgptStatus.planScope) {
      label.textContent = 'No plan access';
      pill.classList.add('is-warn');
      pill.title = 'Signed in, but this sign-in did not include permission to use the ChatGPT plan.';
      return;
    }
    if (!String(cfg.chatgptModel || '').trim()) {
      label.textContent = 'Pick a model';
      pill.classList.add('is-warn');
      pill.title = 'Signed in. Choose which model to use in AI settings.';
      return;
    }
    label.textContent = model || 'ChatGPT';
    pill.classList.add('is-ok');
    pill.title = `Using your ChatGPT plan with ${cfg.chatgptModel}.`;
    return;
  }

  if (!cfg.hasRequiredConfig) {
    label.textContent = 'Not set up';
    pill.classList.add('is-warn');
    pill.title = 'Add your AI provider details to start generating replies.';
    return;
  }
  label.textContent = shortModelName(cfg.model) || 'API key';
  pill.classList.add('is-ok');
  pill.title = `Using your API key with ${cfg.model}.`;
}

/**
 * Trim a model name down to something that fits in the pill.
 *
 * Only for display — every request uses the full stored value. A model name is
 * often namespaced (`vendor/model-name`), and the part after the slash is the
 * part that identifies it.
 * @param {string} name
 * @returns {string}
 */
function shortModelName(name) {
  const raw = String(name || '').trim();
  if (!raw) return '';
  const tail = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw;
  return tail.length > 16 ? `${tail.slice(0, 15)}…` : tail;
}

/**
 * Read the helper's status and redraw everything that depends on it.
 *
 * Never throws and never reports an error on its own: the status box IS the
 * error report on this path, and it can say something more useful than a toast.
 *
 * @param {{quiet?: boolean}} [opts]
 * @returns {Promise<object|null>}
 */
async function refreshChatGptStatus({ quiet = false } = {}) {
  const res = await callWorker({ type: MSG.CHATGPT_STATUS });
  if (!res.ok || !res.status) {
    // The worker itself could not answer — the extension is in a worse state
    // than the helper being down, so say the same thing the button would.
    chatgptStatus = {
      helper: 'unreachable',
      signedIn: false,
      planScope: false,
      signIn: 'none',
      signInError: '',
      startCommand: helperStartCommand(cfg || {}),
      helperUrl: helperBaseUrl(cfg || {}),
      error: (res && res.code) || ERR.CHATGPT_FAILED,
    };
    if (!quiet) logError('chatgpt status failed', res && res.code);
  } else {
    chatgptStatus = res.status;
  }
  renderChatGptPanes();
  renderConnectionPill();
  return chatgptStatus;
}

/** Redraw both ChatGPT panes from `chatgptStatus` and `chatgptModels`. */
function renderChatGptPanes({ resetModels = false } = {}) {
  const s = chatgptStatus;
  const helperUp = !!s && s.helper === 'running';
  const connected = !!(helperUp && s.signedIn && s.planScope);
  const busy = !!(s && (s.signIn === 'pending' || (helperUp && s.signedIn && !s.planScope)));
  const allowed = loopbackGranted === true;

  for (const pane of CG_PANES) {
    // Step 1 — the Connector. "Ready" only when it actually answered; without
    // the local-access permission the panel cannot know, so it says so rather
    // than claiming it is not installed.
    if (helperUp) setBadge(pane.b1, '✓ Ready', 'is-ok');
    else if (!allowed) setBadge(pane.b1, 'Not checked', 'is-idle', 'Allow local access first so the panel can look for it.');
    else setBadge(pane.b1, 'Not installed', 'is-warn', 'Not detected — it is not installed, or not running.');
    pane.a1.classList.toggle('hidden', helperUp);
    pane.fallback.classList.toggle('hidden', helperUp);

    // Step 2 — Chrome's permission for 127.0.0.1.
    if (allowed) setBadge(pane.b2, '✓ Allowed', 'is-ok');
    else setBadge(pane.b2, 'Not allowed', 'is-warn');
    pane.allow.classList.toggle('hidden', allowed);

    // Step 3 — the ChatGPT account.
    if (connected) {
      const who = s.label || s.email;
      setBadge(pane.b3, '✓ Connected', 'is-ok', who ? `Connected as ${who}` : '');
    } else if (s && s.signIn === 'pending') {
      setBadge(pane.b3, 'Waiting…', 'is-warn');
    } else if (helperUp && s.signedIn && !s.planScope) {
      setBadge(pane.b3, 'Plan access needed', 'is-bad', 'Sign out and sign in again, accepting the plan permissions.');
    } else if (s && s.signIn === 'error') {
      setBadge(pane.b3, 'Failed', 'is-bad', s.signInError || '');
    } else {
      setBadge(pane.b3, 'Not connected', 'is-idle');
    }

    // The main button is enabled only when steps 1 and 2 are done, and goes away
    // once connected. While disabled, the badges above show what is missing.
    pane.signIn.classList.toggle('hidden', connected);
    pane.signIn.classList.toggle('busy', busy);
    pane.signIn.disabled = busy || !(helperUp && allowed);
    pane.signIn.title = helperUp && allowed ? '' : 'Finish steps 1 and 2 first.';
    pane.signOut.classList.toggle('hidden', !(s && s.signedIn));

    // Models, refresh, continue and test only make sense after authorisation.
    for (const key of ['refresh', 'save', 'test']) {
      if (pane[key]) pane[key].disabled = !connected;
    }

    fillModelSelect(pane.model, resetModels ? (cfg && cfg.chatgptModel) || '' : '', { reset: resetModels });
    if (!connected) pane.model.disabled = true;
    if (pane.modelHint) pane.modelHint.textContent = modelHintText(s);
  }
}

/**
 * Text under the model picker.
 *
 * @param {object|null} s
 * @returns {string}
 */
function modelHintText(s) {
  const ready = s && s.helper === 'running' && s.signedIn && s.planScope;
  return ready && !chatgptModels.length ? 'No models loaded yet. Press Refresh Models.' : '';
}

/**
 * Fill a model dropdown from the account's own catalogue.
 *
 * The saved model is kept as an option even when it is not in the list. Dropping
 * it would silently rewrite the user's choice; keeping it means Test Connection
 * can say "this one is not available to your account", which is the useful
 * sentence. The list is never invented — a name that did not come from the
 * account is a request that fails later with a worse message.
 *
 * @param {HTMLSelectElement} select
 * @param {string} prefer model to select, used when resetting the form
 * @param {{reset?: boolean}} [opts] reset=true ignores whatever is in the DOM
 */
function fillModelSelect(select, prefer, { reset = false } = {}) {
  if (!select) return;

  // While the user is mid-edit, the DOM is the truth: a background status poll
  // must not undo a choice that has not been saved yet.
  const keep = reset ? String(prefer || '') : select.value || String(prefer || '');

  const options = chatgptModels.slice();
  if (keep && !options.some((m) => m.slug === keep)) {
    options.unshift({ slug: keep, displayName: '', saved: true });
  }

  select.innerHTML = '';
  if (!options.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No models loaded';
    select.appendChild(opt);
    select.disabled = true;
    return;
  }

  select.disabled = false;
  for (const m of options) {
    const opt = document.createElement('option');
    opt.value = m.slug;
    opt.textContent = m.saved
      ? `${m.slug} (saved)`
      : m.displayName && m.displayName !== m.slug
        ? `${m.displayName} — ${m.slug}`
        : m.slug;
    select.appendChild(opt);
  }
  select.value = options.some((m) => m.slug === keep) ? keep : options[0].slug;
}

/** The result line of whichever ChatGPT pane is on screen. */
function cgResultEl() {
  return el.setup.classList.contains('hidden') ? el.cgTestResult : el.suCgResult;
}

/**
 * @param {string} text
 * @param {'success'|'error'} kind
 */
function setCgResult(text, kind) {
  const target = cgResultEl();
  if (!text) {
    target.classList.add('hidden');
    target.textContent = '';
    return;
  }
  target.textContent = text;
  target.className = `test-result ${kind}`;
  target.classList.remove('hidden');
}

/**
 * Make sure the extension may talk to the local helper.
 *
 * `http://127.0.0.1/*` is an optional host permission, requested here rather
 * than at install: an extension that asks for a loopback permission up front,
 * before the user has chosen the method that needs it, is asking for something
 * it has no use for yet. Returns false rather than throwing, because "Chrome
 * said no" is a state the pane has to explain.
 *
 * @returns {Promise<boolean>}
 */
async function ensureLoopbackPermission() {
  const origins = ['http://127.0.0.1/*'];
  try {
    if (await chrome.permissions.contains({ origins })) return true;
    return await chrome.permissions.request({ origins });
  } catch (err) {
    logError('loopback permission request failed', err && err.message);
    return false;
  }
}

/**
 * Continue with ChatGPT.
 *
 * The order matters: permission first (the click is still the user gesture),
 * then the helper's authorize URL, then a real tab. The panel does not touch the
 * resulting credential — it cannot, it is not there.
 *
 * @param {HTMLButtonElement} btn
 */
async function onChatGptSignIn(btn) {
  await run(btn, 'chatgpt-signin', async () => {
    setCgResult('Starting sign-in…', 'success');

    const granted = await ensureLoopbackPermission();
    if (!granted) {
      setCgResult(
        'Chrome did not grant access to 127.0.0.1, and without it the extension cannot reach ChatGPT Connector. Allow access when Chrome asks, or use your own API key instead.',
        'error',
      );
      return;
    }

    const res = await callWorker({ type: MSG.CHATGPT_SIGN_IN });
    if (!res.ok) {
      setCgResult(describeError(res.code, res.message, res), 'error');
      await refreshChatGptStatus({ quiet: true });
      return;
    }

    await chrome.tabs.create({ url: res.authorizeUrl });
    setCgResult(
      'A sign-in tab has opened. Finish signing in there — this panel notices on its own, and you can close the tab afterwards.',
      'success',
    );
    await refreshChatGptStatus({ quiet: true });
    watchSignIn();
  });
}

/** Stop watching for a sign-in to complete. */
function stopSignInWatch() {
  if (signInWatch) {
    clearInterval(signInWatch);
    signInWatch = null;
  }
}

/**
 * Watch the helper's status until the tab that opened finishes its job.
 *
 * Polling, not events: the thing that completes the sign-in is a different tab
 * talking to a different process, and the only channel back is the helper's own
 * status endpoint.
 */
function watchSignIn() {
  stopSignInWatch();
  const startedAt = Date.now();

  signInWatch = setInterval(async () => {
    if (Date.now() - startedAt > SIGN_IN_WATCH_MS) {
      stopSignInWatch();
      return;
    }
    const status = await refreshChatGptStatus({ quiet: true });
    if (!status) return;

    if (status.signedIn && status.planScope) {
      stopSignInWatch();
      setCgResult('Signed in. Loading the models your account can use…', 'success');
      const models = await refreshChatGptModels({ quiet: true });
      setCgResult(
        models.length
          ? 'Connected. Pick the model you want, then Save.'
          : 'Connected, but this account reported no models for this app. You can still try your own API key instead.',
        models.length ? 'success' : 'error',
      );
      return;
    }
    if (status.signedIn && !status.planScope) {
      stopSignInWatch();
      setCgResult(
        'Signed in, but the plan permission was not granted, so replies cannot use your ChatGPT plan. Sign out and try again, accepting the plan permissions.',
        'error',
      );
      return;
    }
    if (status.signIn === 'error') {
      stopSignInWatch();
      setCgResult(status.signInError || 'The sign-in did not finish.', 'error');
    }
  }, SIGN_IN_POLL_MS);
}

/**
 * Sign out, and revoke the credential at OpenAI.
 *
 * Says plainly whether OpenAI confirmed the revocation, because "signed out
 * here" and "the credential is dead everywhere" are different claims and only
 * one of them is ours to make.
 */
async function onChatGptSignOut(btn) {
  await run(btn, 'chatgpt-signout', async () => {
    const res = await callWorker({ type: MSG.CHATGPT_SIGN_OUT });
    if (!res.ok) {
      setCgResult(describeError(res.code, res.message, res), 'error');
      return;
    }
    stopSignInWatch();
    chatgptModels = [];
    chatgptStatus = res.status || null;
    renderChatGptPanes({ resetModels: true });
    renderConnectionPill();
    setCgResult(
      res.revoked
        ? 'Signed out, and the credential was revoked at OpenAI.'
        : 'Signed out on this computer. OpenAI did not confirm the revocation — the credential expires on its own.',
      'success',
    );
  });
}

/**
 * Refresh the account's model list.
 *
 * @param {{quiet?: boolean}} [opts] quiet=true only updates the dropdown
 * @returns {Promise<Array<object>>}
 */
async function refreshChatGptModels({ quiet = false } = {}) {
  const res = await callWorker({ type: MSG.CHATGPT_MODELS });
  if (!res.ok) {
    if (!quiet) setCgResult(describeError(res.code, res.message, res), 'error');
    return [];
  }
  chatgptModels = res.models || [];
  renderChatGptPanes();
  if (!quiet) {
    setCgResult(
      chatgptModels.length
        ? `${chatgptModels.length} model${chatgptModels.length === 1 ? '' : 's'} available to this account.`
        : 'This account reported no models available to this app.',
      chatgptModels.length ? 'success' : 'error',
    );
  }
  return chatgptModels;
}

/** @param {HTMLButtonElement} btn */
async function onChatGptRefreshModels(btn) {
  await run(btn, 'chatgpt-models', async () => {
    const models = await refreshChatGptModels();
    if (!models.length && chatgptStatus && chatgptStatus.helper === 'running' && chatgptStatus.signedIn) {
      // The empty list above is already on screen; this only makes sure the
      // status line is not still claiming everything is fine.
      await refreshChatGptStatus({ quiet: true });
    }
  });
}

/**
 * Send one real request, and say so before it happens.
 *
 * Separate from Test Connection on purpose. This spends part of the account's
 * allowance, so it is an action the user takes knowingly rather than something
 * that happens behind a button labelled "Test".
 *
 * @param {HTMLButtonElement} btn
 */
async function onChatGptTestRequest(btn) {
  await run(btn, 'chatgpt-test-request', async () => {
    setCgResult('Sending one short request to your ChatGPT plan…', 'success');
    const res = await callWorker({
      type: MSG.CHATGPT_TEST_REQUEST,
      override: readConfigForm(),
    });

    if (!res.ok) {
      setCgResult(res.error || 'The request failed.', 'error');
      setStatus('ChatGPT request failed.', 'error');
      return;
    }
    setCgResult(
      `Real request succeeded.\nModel: ${res.model}\nResponse time: ${res.responseMs} ms\nIt replied: “${res.sample}…”`,
      'success',
    );
    setStatus('ChatGPT request succeeded.', 'success');
  });
}

// ---------------------------------------------------------------------------
// Settings form
// ---------------------------------------------------------------------------

/**
 * Render the AI configuration form.
 *
 * The stored API key is never sent to this page. The field shows a masked hint
 * only, and is left blank so the user can type a replacement without the old key
 * ever being present in the DOM.
 *
 * @param {object} c public config shape from the service worker
 */
function renderConfig(c) {
  cfg = c;
  el.cfgSystemPrompt.value = c.systemPrompt || c.defaultSystemPrompt || '';
  el.cfgPrimaryBaseUrl.value = c.primaryBaseUrl || '';
  el.cfgFallbackBaseUrl.value = c.fallbackBaseUrl || '';
  el.cfgModel.value = c.model || '';
  el.cfgTemperature.value = c.temperature;
  el.cfgMaxTokens.value = c.maxTokens;
  el.cfgMaxChars.value = c.maxChars;
  el.effectiveTokens.textContent = `${c.effectiveMaxTokens} tokens`;
  el.cfgApiKey.value = '';
  el.cfgApiKey.placeholder = c.hasApiKey ? `${'•'.repeat(20)}${c.keyHint || ''}` : 'your provider’s API key';

  el.cfgHelperUrl.value = c.helperUrl || CHATGPT_HELPER_DEFAULT_URL;

  el.cfgContextMessages.value = String(c.contextMessages);
  el.cfgThinking.value = c.thinking;

  el.cfgApiFallback.checked = c.apiFallback === true;

  setLengthControl(c.replyLength);
  // The mode the form shows comes from storage on every re-render, exactly like
  // every other field. Both methods' values are sent to this page at once, so
  // switching the control back and forth never blanks the other one.
  setMode(c.connectionMode, { save: false });
  renderChatGptPanes({ resetModels: true });
  renderOnboarding();
}

/** Reflect the active reply length in the segmented control. */
function setLengthControl(replyLength) {
  for (const btn of el.lengthSeg.querySelectorAll('.seg-btn')) {
    btn.classList.toggle('is-on', btn.dataset.length === replyLength);
  }
}

/**
 * @param {string} text
 * @param {'success'|'error'} kind
 */
function setTestResult(text, kind) {
  if (!text) {
    el.testResult.classList.add('hidden');
    el.testResult.textContent = '';
    return;
  }
  el.testResult.textContent = text;
  el.testResult.className = `test-result ${kind}`;
  el.testResult.classList.remove('hidden');
}

/** Read the Settings form into a patch object. */
function readConfigForm() {
  const patch = {
    connectionMode: modeChoice,
    systemPrompt: el.cfgSystemPrompt.value,
    primaryBaseUrl: el.cfgPrimaryBaseUrl.value.trim(),
    fallbackBaseUrl: el.cfgFallbackBaseUrl.value.trim(),
    model: el.cfgModel.value.trim(),
    temperature: Number(el.cfgTemperature.value),
    maxTokens: Number(el.cfgMaxTokens.value),
    maxChars: Number(el.cfgMaxChars.value),
    contextMessages: Number(el.cfgContextMessages.value),
    thinking: el.cfgThinking.value,
    chatgptModel: el.cfgCgModel.value,
    apiFallback: el.cfgApiFallback.checked,
    helperUrl: el.cfgHelperUrl.value.trim(),
  };
  const key = el.cfgApiKey.value.trim();
  // Only send the key when the user actually typed one; otherwise let the worker
  // fall back to whatever is stored.
  if (key) patch.apiKey = key;
  return patch;
}

/** Populate the two dropdowns from the shared constants. */
function buildSettingsOptions() {
  const CONTEXT_LABELS = {
    0: 'All loaded messages',
    20: 'Last 20 messages',
    50: 'Last 50 messages',
    100: 'Last 100 messages',
  };
  el.cfgContextMessages.innerHTML = '';
  for (const n of CONTEXT_MESSAGE_CHOICES) {
    const opt = document.createElement('option');
    opt.value = String(n);
    opt.textContent = CONTEXT_LABELS[n] || `Last ${n} messages`;
    el.cfgContextMessages.appendChild(opt);
  }

  el.cfgThinking.innerHTML = '';
  for (const [value, spec] of Object.entries(THINKING_SPECS)) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = spec.label;
    el.cfgThinking.appendChild(opt);
  }
}

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

/**
 * Send a message to the service worker.
 * @param {object} message
 * @returns {Promise<object>}
 */
async function callWorker(message) {
  try {
    const res = await chrome.runtime.sendMessage(message);
    return res || { ok: false, code: 'EMPTY_RESPONSE', message: 'No response from the extension worker.' };
  } catch (err) {
    logError('worker call failed', message && message.type, err && err.message);
    return {
      ok: false,
      code: 'WORKER_UNREACHABLE',
      message: 'The extension service worker is not reachable. Reload the extension.',
    };
  }
}

/**
 * Human-readable text for a failure code.
 *
 * Written for someone who sells things, not someone who writes software. Every
 * line says what happened and what to do about it; none of them name an HTTP
 * status, a stack frame or a source file. Where the worker can tell us *which*
 * field is missing, that is spelled out rather than summarised as
 * "not configured".
 *
 * @param {string} code
 * @param {string} fallback raw message from the worker, used when nothing better exists
 * @param {object} [res] the full worker response, for the field-level details
 * @returns {string}
 */
function describeError(code, fallback, res) {
  if (code === ERR.AI_NOT_CONFIGURED) {
    const labels = (res && res.missingFieldLabels) || [];
    if (labels.length) {
      return `Your AI provider is not set up yet. Fill in ${labels.join(', ')} to start generating replies.`;
    }
    return 'Your AI provider is not set up yet. Open ⚙ and add your AI details.';
  }

  const map = {
    [ERR.WHATSAPP_NOT_OPEN]:
      'WhatsApp Web is not open in this browser. Open https://web.whatsapp.com and sign in, then try again.',
    [ERR.NO_CHAT_OPEN]: 'No conversation is open. Click a customer in WhatsApp Web, then try again.',
    [ERR.NO_MESSAGES]:
      'This conversation has no messages loaded yet. Open it in WhatsApp Web and scroll to the messages you want the AI to read.',
    [ERR.COMPOSER_NOT_FOUND]:
      'Could not find WhatsApp’s message box. Make sure a conversation is open in WhatsApp Web.',
    [ERR.SEND_BUTTON_NOT_FOUND]:
      'Could not find WhatsApp’s Send button. Make sure a conversation is open, then try again.',
    [ERR.AI_FAILED]: fallback || 'The AI request failed. Check your AI settings and try again.',
    [ERR.AI_AUTH_FAILED]:
      'Your AI provider rejected the API key. Check the API Key in ⚙ — it may be wrong, expired, or from a different provider.',
    [ERR.EMPTY_MESSAGE]: 'Nothing to send — the reply box is empty.',
    [ERR.AI_EMPTY]:
      'The AI did not manage to write a reply. Some AI models spend their whole reply budget thinking. Open ⚙ → Advanced and set Max output tokens to 0 (automatic), or set Thinking depth to Off.',
    [ERR.AI_TRUNCATED]:
      'The AI reply was cut off before it finished, so nothing was sent. Raise Max output tokens in ⚙ → Advanced and try again.',
    [ERR.TIMEOUT]:
      'The AI took too long to answer. Try again, or choose a faster model in ⚙.',
    [ERR.CHAT_CHANGED]:
      'You switched to a different conversation while the reply was being written, so it was not sent. Generate again for this customer.',
    [ERR.BUSY]: 'Another action is still running. Please wait a moment.',

    // --- ChatGPT subscription path -----------------------------------------
    //
    // These four states are not failures of the extension and not failures of
    // the user's ChatGPT account: they are the local helper being off, nobody
    // being signed in, plan permission not having been granted, and the account
    // being out of allowance. Each one needs a different action, so each one
    // gets its own sentence rather than a shared "connection problem".
    [ERR.HELPER_UNREACHABLE]:
      fallback ||
      'ChatGPT Connector is not running. Open the ChatGPT section in AI settings to install or recheck it.',
    [ERR.CHATGPT_NOT_SIGNED_IN]:
      'No ChatGPT account is connected yet. Click “Continue with ChatGPT” in AI settings to sign in.',
    [ERR.CHATGPT_NO_PLAN_SCOPE]:
      'This sign-in does not include permission to use your ChatGPT plan, so replies cannot be written with it. Sign out in AI settings, then sign in again and accept the plan permissions.',
    [ERR.CHATGPT_NOT_ELIGIBLE]:
      'This ChatGPT account is not eligible for plan usage in other apps. You can use your own API key instead — switch to it in AI settings.',
    [ERR.CHATGPT_USAGE_LIMIT]:
      'Your ChatGPT plan has no allowance left for this right now. It resets on its own; until then you can switch to your own API key in AI settings.',
    [ERR.CHATGPT_UNAVAILABLE]:
      'OpenAI reported that ChatGPT plan usage is unavailable at the moment. Try again shortly, or switch to your own API key.',
    [ERR.CHATGPT_FAILED]:
      fallback || 'The request to your ChatGPT plan failed. Check the connection in AI settings and try again.',
    [ERR.HELPER_CONFIG_INVALID]:
      fallback ||
      'ChatGPT Connector is running but could not read OpenAI’s sign-in configuration. Check this computer’s internet connection — nothing is wrong with your ChatGPT account.',
  };
  return map[code] || fallback || `Something went wrong (${code}). Try again.`;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * Run an operation with the busy guard applied.
 * @param {HTMLButtonElement} btn
 * @param {string} label
 * @param {() => Promise<void>} fn
 */
async function run(btn, label, fn) {
  if (busy) {
    setStatus('Another operation is still running. Please wait.', 'warn');
    return;
  }
  busy = true;
  if (btn) setBtn(btn, true, true);
  refreshSendButtons();
  try {
    await fn();
  } catch (err) {
    logError(label, err && err.message);
    setStatus(describeError(err && err.code, err && err.message), 'error');
  } finally {
    busy = false;
    // Never leave "Generating…" on screen after the work is over, whichever path
    // got here.
    if (el.replyState.classList.contains('progress')) setStatus('');
    if (btn) setBtn(btn, false, false);
    refreshSendButtons();
  }
}

const EMPTY_CONTEXT = {
  hasOpenChat: false,
  chatId: '',
  chatIdStable: false,
  contactName: '',
  isGroup: false,
  phone: '',
  phoneStatus: PHONE_STATUS.UNKNOWN,
  counts: { total: 0, incoming: 0, outgoing: 0, unknown: 0 },
};

/**
 * Read-only refresh of the current chat context.
 *
 * @param {{silent?: boolean, revealPhone?: boolean}} [opts] revealPhone opens the
 *   contact-info drawer to read the number; only set for an explicit user action.
 */
async function readChat({ silent = false, revealPhone = false } = {}) {
  const res = await callWorker({ type: MSG.GET_CHAT_CONTEXT, revealPhone });
  if (!res.ok) {
    current = null;
    renderContext(EMPTY_CONTEXT);
    renderInstruction();
    if (!silent) setStatus(describeError(res.code, res.message, res), 'error');
    return null;
  }
  await syncPanesToChat(res.context);
  renderContext(res.context);
  renderInstruction();
  return res.context;
}

async function onRead() {
  await run(el.btnRead, 'read', async () => {
    // Explicit user action: allow the contact drawer to be opened so a number
    // that WhatsApp is not showing in the header can still be read.
    await readChat({ revealPhone: true });
  });
}

async function onGenerate() {
  await run(el.btnGenerate, 'generate', async () => {
    setStatus('Reading…', 'progress');
    // The worker reads the instruction from storage, so anything still sitting
    // in the debounce window has to land there first.
    await flushInstruction();
    setStatus('Generating…', 'progress');
    const res = await callWorker({ type: MSG.GENERATE_REPLY });
    if (!res.ok) {
      setStatus(describeError(res.code, res.message, res), 'error');
      if (res.code === ERR.AI_NOT_CONFIGURED) {
        // The one failure the user can fix on this screen, so put the fix on
        // screen rather than describing where to find it.
        focusSetup();
        return;
      }
      if (res.code === ERR.NO_CHAT_OPEN || res.code === ERR.NO_MESSAGES) {
        await readChat({ silent: true });
      }
      return;
    }
    // The draft belongs to the chat it was generated for, which is the one the
    // worker read — not whichever chat the panel happens to be showing now.
    await saveDraft(currentChatId, el.reply.value, draftState);
    currentChatId = res.context.chatId || currentChatId;
    el.reply.value = res.text;
    draftState = 'draft';
    updateReplyMeta();
    await saveDraft(currentChatId, res.text, 'draft');
    renderContext(res.context);
    // Collapse back to the chip: the instruction has done its job, and the room
    // belongs to the reply that now has to be reviewed against it.
    insOpen = false;
    await renderInstruction();
    setStatus(res.apiBackup ? '✓ Ready · API Key backup' : '✓ Ready', 'ready');
    refreshSendButtons();
    el.reply.focus();
  });
}

async function onSend() {
  await run(el.btnSend, 'send', async () => {
    const text = el.reply.value.trim();
    if (!text) {
      setStatus('Nothing to send — the reply box is empty.', 'warn');
      return;
    }
    if (!current || !current.hasOpenChat) {
      setStatus(describeError(ERR.NO_CHAT_OPEN), 'error');
      return;
    }

    setStatus('Sending…', 'progress');
    const res = await callWorker({
      type: MSG.SEND_MESSAGE,
      text,
      chatId: current.chatId,
      context: current,
    });

    if (!res.ok) {
      setStatus(describeError(res.code, res.message, res), 'error');
      return;
    }
    setStatus(`Sent to ${res.contactName || res.phone || 'the open chat'}.`, 'success');
    await clearDraft(currentChatId);
    el.reply.value = '';
    draftState = '';
    updateReplyMeta();
    await readChat({ silent: true });
  });
}

async function onFollowUpAndSend() {
  await run(el.btnFollowup, 'followup', async () => {
    if (!current || !current.hasOpenChat) {
      setStatus(describeError(ERR.NO_CHAT_OPEN), 'error');
      return;
    }

    setStatus('Generating…', 'progress');
    await flushInstruction();
    const res = await callWorker({ type: MSG.FOLLOWUP_AND_SEND });

    if (!res.ok) {
      setStatus(describeError(res.code, res.message, res), 'error');
      // Refresh so the panel reflects whatever the user did to the page.
      await readChat({ silent: true });
      return;
    }

    // It went out already, so there is nothing left to send: show it, mark it
    // sent, and drop any draft this chat was holding.
    await clearDraft(currentChatId);
    el.reply.value = res.text;
    draftState = 'sent';
    updateReplyMeta();
    setStatus(`Sent to ${res.contactName || res.phone || 'the open chat'}.`, 'success');
    await readChat({ silent: true });
  });
}

async function onSaveConfig() {
  const patch = readConfigForm();
  const res = await callWorker({ type: MSG.SET_AI_CONFIG, patch });
  if (!res.ok) {
    setStatus(describeError(res.code, res.message, res), 'error');
    return;
  }
  setupDirty = false;
  renderConfig(res.config);
  // Saving a complete configuration from Settings counts as connecting, exactly
  // as the first-run form does — otherwise clearing the key and re-entering it
  // would put the welcome screen back for good.
  if (res.config.hasRequiredConfig && !onboarding.connected) {
    await saveOnboarding({ connected: true });
  }
  setStatus('Settings saved.', 'success');
}

async function onClearKey() {
  const res = await callWorker({ type: MSG.CLEAR_API_KEY });
  if (!res.ok) {
    setStatus(describeError(res.code, res.message, res), 'error');
    return;
  }
  renderConfig(res.config);
  setStatus('Stored API key cleared.', 'success');
}

/**
 * Test Connection: validates the values currently in the form (not the saved
 * ones), so the user can check a config before committing it.
 *
 * Reports exactly which of network / key / model / endpoint failed — never a
 * generic "something went wrong".
 *
 * On the ChatGPT path this is the free check, and the panel says which four
 * things it verified and that no request was sent. The real request is a
 * separate button, because this one spends the user's plan allowance.
 */
async function onTestConnection() {
  await run(el.btnTest, 'test', async () => {
    // Same rule as the red asterisks: these three are required for this method.
    if (modeChoice !== CONNECTION_MODE.CHATGPT) {
      const missing = [];
      if (!el.cfgPrimaryBaseUrl.value.trim()) missing.push('API Base URL');
      if (!el.cfgApiKey.value.trim() && !(cfg && cfg.hasApiKey)) missing.push('API Key');
      if (!el.cfgModel.value.trim()) missing.push('Model ID');
      if (missing.length) {
        setTestResult(`Fill in: ${missing.join(', ')}.`, 'error');
        return;
      }
    }
    setTestResult('Testing…', 'success');
    const res = await callWorker({
      type: MSG.TEST_CONNECTION,
      override: readConfigForm(),
    });

    if (res.mode === CONNECTION_MODE.CHATGPT) {
      await renderChatGptTestResult(res);
      return;
    }

    if (!res.ok) {
      const lines = [res.error || 'Request failed.'];
      if (res.status) lines.push(`HTTP status: ${res.status}`);
      if (res.attempts && res.attempts.length > 1) {
        lines.push(`Tried: ${res.attempts.map((a) => `${a.host} (${a.code})`).join(' → ')}`);
      }
      setTestResult(lines.join('\n'), 'error');
      setStatus('Test Connection failed.', 'error');
      return;
    }

    const via = res.usedFallback ? ' (via fallback host)' : '';
    setTestResult(
      `Connection successful${via}\nModel: ${res.model}\nHost: ${res.host}\nResponse time: ${res.responseMs} ms`,
      'success',
    );
    setStatus('Test Connection succeeded.', 'success');
  });
}

/**
 * Draw the outcome of the free ChatGPT check.
 *
 * Every line here is something the extension actually verified. The last line
 * states that no request was sent, because the whole point of this button on
 * this path is that it does not spend anything.
 *
 * @param {object} res the worker's response, with `mode: 'chatgpt'`
 */
async function renderChatGptTestResult(res) {
  if (!res.ok) {
    setTestResult(describeError(res.code, res.error, res), 'error');
    setStatus('Test Connection failed.', 'error');
    await refreshChatGptStatus({ quiet: true });
    return;
  }

  const lines = [
    'Connection check passed.',
    `Account: ${res.account || 'signed in'}`,
    `Model: ${res.model}`,
    `Model list: ${res.modelCount} available to this account`,
    res.helperVersion ? `Connector version: ${res.helperVersion}` : '',
    'No request was sent to the model, so this cost nothing of your plan.',
  ].filter(Boolean);

  setTestResult(lines.join('\n'), 'success');
  setStatus('Test Connection succeeded.', 'success');
  await refreshChatGptStatus({ quiet: true });
}

/**
 * Reply length is a preference, not a per-request argument: choosing Short now
 * means "Short is what I want" until it is changed. It is persisted immediately
 * so the next panel session starts where this one left off, and it deliberately
 * does NOT touch Max output tokens — coupling them would shrink the budget on
 * Short and bring back the empty-reply failure.
 *
 * @param {string} length
 */
async function onPickLength(length) {
  if (!REPLY_LENGTH_SPECS[length] || (cfg && cfg.replyLength === length)) {
    setLengthControl(length);
    return;
  }
  setLengthControl(length);
  const res = await callWorker({ type: MSG.SET_AI_CONFIG, patch: { replyLength: length } });
  if (!res.ok) {
    setStatus(describeError(res.code, res.message, res), 'error');
    if (cfg) setLengthControl(cfg.replyLength);
    return;
  }
  // Only the fields this change actually affects are refreshed. Re-rendering the
  // whole form would wipe an unsaved system-prompt edit sitting in the box.
  if (cfg) {
    cfg.replyLength = res.config.replyLength;
    cfg.effectiveMaxTokens = res.config.effectiveMaxTokens;
  }
  el.effectiveTokens.textContent = `${res.config.effectiveMaxTokens} tokens`;
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

el.btnSettings.addEventListener('click', () => {
  const opening = el.settings.classList.contains('hidden');
  el.settings.classList.toggle('hidden', !opening);
  el.btnSettings.setAttribute('aria-expanded', String(opening));
});

// The connection pill is a shortcut to the connection block at the top of Settings.
el.btnConn.addEventListener('click', () => {
  el.settings.classList.remove('hidden');
  el.btnSettings.setAttribute('aria-expanded', 'true');
  el.cfgModes.scrollIntoView({ block: 'start' });
  // Opening ChatGPT settings is a reason to look; an API-only user gets no probe.
  if (modeChoice === CONNECTION_MODE.CHATGPT) refreshChatGptStatus({ quiet: true }).catch(() => {});
});


el.btnRead.addEventListener('click', onRead);
el.btnGenerate.addEventListener('click', onGenerate);
el.btnSend.addEventListener('click', onSend);
el.btnSaveConfig.addEventListener('click', onSaveConfig);
el.btnClearKey.addEventListener('click', onClearKey);
el.btnTest.addEventListener('click', onTestConnection);

// Follow-up & Send is one click by design: it generates and sends without ever
// showing the user the text. The two-line warning inside the button is therefore
// the whole safeguard, and nothing else in the panel sends a message the user
// has not read.
el.btnFollowup.addEventListener('click', onFollowUpAndSend);

// First-run form. Both buttons act on what is typed, not on what is stored, so
// a configuration can be checked before it is committed.
el.suSave.addEventListener('click', () => {
  run(el.suSave, 'setup-save', onSetupSave);
});
el.suTest.addEventListener('click', onSetupTest);
el.suToggleKey.addEventListener('click', () => {
  const showing = el.suApiKey.type === 'text';
  el.suApiKey.type = showing ? 'password' : 'text';
  el.suToggleKey.textContent = showing ? 'Show' : 'Hide';
  if (!showing) el.suApiKey.focus();
});
el.qsDone.addEventListener('click', () => saveOnboarding({ dismissed: true }));

// --- ChatGPT subscription ---------------------------------------------------
//
// One set of handlers, two panes. The segmented control is the only difference
// between them: in the welcome screen it edits what Save will write, in Settings
// the choice IS the edit and is persisted straight away.
for (const [seg, persist] of [
  [el.suModes, false],
  [el.cfgModes, true],
]) {
  seg.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.seg-btn');
    if (!btn || !btn.dataset.mode) return;
    if (!persist) setupDirty = true;
    setCgResult('', 'success');
    setMode(btn.dataset.mode, { save: persist });
  });
}

el.suCgRecheck.addEventListener('click', () => onRecheck(el.suCgRecheck));
el.cfgCgRecheck.addEventListener('click', () => onRecheck(el.cfgCgRecheck));
el.suCgAllow.addEventListener('click', () => onAllowLocalAccess(el.suCgAllow));
el.cfgCgAllow.addEventListener('click', () => onAllowLocalAccess(el.cfgCgAllow));
el.suCgSignIn.addEventListener('click', () => onChatGptSignIn(el.suCgSignIn));
el.cfgCgSignIn.addEventListener('click', () => onChatGptSignIn(el.cfgCgSignIn));
el.suCgSignOut.addEventListener('click', () => onChatGptSignOut(el.suCgSignOut));
el.cfgCgSignOut.addEventListener('click', () => onChatGptSignOut(el.cfgCgSignOut));
el.suCgRefresh.addEventListener('click', () => onChatGptRefreshModels(el.suCgRefresh));
el.cfgCgRefresh.addEventListener('click', () => onChatGptRefreshModels(el.cfgCgRefresh));
el.cfgApiFallback.addEventListener('change', () => setMode(modeChoice, { save: false }));
for (const input of [el.cfgPrimaryBaseUrl, el.cfgApiKey, el.cfgModel]) input.addEventListener('input', updateBackupHint);
el.cfgCgTest.addEventListener('click', () => onChatGptTestRequest(el.cfgCgTest));
el.suCgSave.addEventListener('click', () => run(el.suCgSave, 'setup-save', onSetupSave));

// Choosing a model is an edit to the welcome form like any other, so it stops
// the form tracking storage until it is saved.
el.suCgModel.addEventListener('change', () => {
  setupDirty = true;
  setCgResult('', 'success');
});
el.cfgCgModel.addEventListener('change', () => setTestResult('', 'success'));

// Once the user types, the form stops tracking storage until it is saved.
for (const input of [el.suBaseUrl, el.suApiKey, el.suModel, el.suFallback]) {
  input.addEventListener('input', () => {
    setupDirty = true;
    // An edit invalidates the previous verdict; leaving a green "Connection
    // successful" under changed fields is worse than showing nothing.
    setSetupResult('', '');
  });
}

el.btnResetPrompt.addEventListener('click', () => {
  if (cfg && cfg.defaultSystemPrompt) el.cfgSystemPrompt.value = cfg.defaultSystemPrompt;
});

el.lengthSeg.addEventListener('click', (ev) => {
  const btn = ev.target.closest('.seg-btn');
  if (btn && btn.dataset.length) onPickLength(btn.dataset.length);
});

// Show / Hide the API key. Defaults to hidden; toggling clears the hint text so
// a stored key can never be revealed by this control.
el.btnToggleKey.addEventListener('click', () => {
  const showing = el.cfgApiKey.type === 'text';
  el.cfgApiKey.type = showing ? 'password' : 'text';
  el.btnToggleKey.textContent = showing ? 'Show' : 'Hide';
  if (!showing) el.cfgApiKey.focus();
});

// The instruction editor: three controls, one state variable. Opening it is
// always explicit (the add row or the chip), closing it always writes first.
el.insAdd.addEventListener('click', async () => {
  if (!currentChatId) return;
  insOpen = true;
  // Await the render: a hidden element cannot take focus, and the panel is
  // still hidden until this resolves.
  await renderInstruction();
  el.insBox.focus();
});

el.insDone.addEventListener('click', async () => {
  insOpen = false;
  await flushInstruction();
  await renderInstruction();
});

el.insChip.addEventListener('click', async () => {
  insOpen = true;
  await renderInstruction();
  el.insBox.focus();
  // Reopening a written instruction is nearly always to append to it.
  el.insBox.setSelectionRange(el.insBox.value.length, el.insBox.value.length);
});

el.insClear.addEventListener('click', async () => {
  el.insBox.value = '';
  insOpen = false;
  await flushInstruction();
  await renderInstruction();
});

el.insBox.addEventListener('input', () => {
  el.insClear.classList.toggle('hidden', !el.insBox.value.trim());
  if (insTimer) clearTimeout(insTimer);
  insTimer = setTimeout(async () => {
    insTimer = null;
    await saveInstruction(currentChatId, el.insBox.value);
    await renderInstruction();
  }, 400);
});

// Any manual edit re-evaluates whether Send should be enabled, and the draft
// store follows along so a chat switch never loses what was typed.
let draftSaveTimer = null;
el.reply.addEventListener('input', () => {
  updateReplyMeta();
  refreshSendButtons();
  if (draftSaveTimer) clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(() => {
    draftSaveTimer = null;
    saveDraft(currentChatId, el.reply.value, draftState).catch(() => {});
  }, 400);
});

/**
 * Keep the connection pill honest while the panel is open.
 *
 * The helper is a separate process: it can be stopped, restarted, or have its
 * sign-in expire, all without anything happening in this panel. On the API-key
 * path there is nothing to watch — the config is local and static — so this only
 * runs while the subscription method is the saved one.
 *
 * Slow on purpose. Nothing here is time-critical (a reply in flight reports its
 * own failure), and a loopback call every few seconds would be noise.
 */
let helperPollTimer = null;
function startHelperPolling() {
  if (helperPollTimer) return;
  let lastPoll = 0;
  helperPollTimer = setInterval(() => {
    if (document.hidden || busy) return;
    // Also while the first-run form merely shows the ChatGPT pane: the point is
    // to notice the Helper the moment the installer finishes.
    if (activeMode() !== CONNECTION_MODE.CHATGPT && modeChoice !== CONNECTION_MODE.CHATGPT) return;
    // Quick (3s) until the Helper is found, then slow.
    const found = !!(chatgptStatus && chatgptStatus.helper === 'running');
    if (found && Date.now() - lastPoll < 20_000) return;
    lastPoll = Date.now();
    if (loopbackGranted !== true) {
      // Not allowed yet: nothing to ask the Helper. Re-check, in case the user
      // granted it from Chrome's own settings.
      checkLoopbackPermission().then((ok) => (ok ? refreshChatGptStatus({ quiet: true }) : renderChatGptPanes())).catch(() => {});
      return;
    }
    refreshChatGptStatus({ quiet: true }).catch(() => {});
  }, 3000);
}

/**
 * Follow the user across chats: poll the context while the panel is open so the
 * contact card never shows a stale contact. Read-only, cheap, and passive — it
 * never opens the contact-info drawer, so nothing flashes on screen.
 */
let pollTimer = null;
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (busy || document.hidden) return;
    readChat({ silent: true }).catch(() => {});
  }, 4000);
}

/** @returns {Promise<void>} */
async function init() {
  buildSettingsOptions();
  refreshSendButtons();
  updateReplyMeta();
  // The worker truncates too — this only stops the user typing past the limit
  // without being told. A silently shortened instruction would be worse.
  el.insBox.maxLength = INSTRUCTION_LIMITS.MAX_CHARS;
  // Nothing is on screen until the stored config has been read: showing the
  // reply UI for a moment and then replacing it with the welcome screen would
  // be the first thing a new user sees.
  el.setup.classList.add('hidden');
  el.quickstart.classList.add('hidden');

  const hello = await callWorker({ type: MSG.PANEL_HELLO });
  if (hello.ok) log('panel ready');

  await loadOnboarding();
  const cfgRes = await callWorker({ type: MSG.GET_AI_CONFIG });
  if (cfgRes.ok) {
    renderConfig(cfgRes.config);
  } else {
    renderOnboarding();
  }

  await readChat({ silent: true });
  startPolling();
  startHelperPolling();

  // Refresh immediately when the user switches tabs or comes back to the panel.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || busy) return;
    readChat({ silent: true }).catch(() => {});
    if (activeMode() === CONNECTION_MODE.CHATGPT) refreshChatGptStatus({ quiet: true }).catch(() => {});
  });

  // Flush the pending draft and instruction before the panel goes away.
  window.addEventListener('pagehide', () => {
    stopSignInWatch();
    saveDraft(currentChatId, el.reply.value, draftState).catch(() => {});
    flushInstruction().catch(() => {});
  });
}

init().catch((err) => {
  logError('panel init failed', err && err.message);
  setStatus('The side panel failed to initialise. Reload the extension.', 'error');
});
