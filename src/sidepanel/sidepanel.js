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
   describeTextLength, formatPhoneDisplay, phoneFromDisplayName, log, logError */

const $ = (id) => document.getElementById(id);

const el = {
  settings: $('settings'),
  btnSettings: $('btn-settings'),
  tabBasic: $('tab-basic'),
  tabAdvanced: $('tab-advanced'),
  paneBasic: $('pane-basic'),
  paneAdvanced: $('pane-advanced'),

  setup: $('setup'),
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
  thinkingHint: $('thinking-hint'),

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

  followupConfirm: $('followup-confirm'),
  btnFollowupCancel: $('btn-followup-cancel'),
  btnFollowupGo: $('btn-followup-go'),
  fuRecipient: $('fu-recipient'),

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
  if (!text) {
    el.status.classList.add('hidden');
    el.status.textContent = '';
    return;
  }
  el.status.textContent = text;
  el.status.className = `status ${kind === 'info' ? '' : kind}`.trim();
  el.status.classList.remove('hidden');

  if (kind === 'success' || kind === 'info') {
    statusTimer = setTimeout(() => {
      statusTimer = null;
      el.status.classList.add('hidden');
      el.status.textContent = '';
    }, 4500);
  }
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
  setBtn(el.btnFollowupGo, busy || !hasChat);

  // The confirmation belongs to one conversation. If that conversation is no
  // longer the open one, the question it asks has stopped having an answer.
  if (!hasChat) closeFollowupConfirm();

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
 * Show the "this sends without a preview" confirmation.
 *
 * Names the recipient, because the mistake this step exists to prevent is
 * sending to the wrong customer.
 */
function openFollowupConfirm() {
  const who = (current && (current.contactName || formatPhoneDisplay(current.phone))) || '';
  el.fuRecipient.textContent = who ? `this chat (${who})` : 'the open chat';
  el.followupConfirm.classList.remove('hidden');
  el.btnFollowupGo.focus();
}

/** Hide the confirmation without doing anything. */
function closeFollowupConfirm() {
  el.followupConfirm.classList.add('hidden');
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
    el.chatBreakdown.textContent = `${ctx.counts.incoming} in / ${ctx.counts.outgoing} out`;
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

  // A pending "send without preview?" question was about the previous customer.
  closeFollowupConfirm();

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
}

/** Read the welcome form into the same patch shape Settings produces. */
function readSetupForm() {
  const patch = {
    primaryBaseUrl: el.suBaseUrl.value.trim(),
    fallbackBaseUrl: el.suFallback.value.trim(),
    model: el.suModel.value.trim(),
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
  el.setup.scrollIntoView({ block: 'start' });
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

  if (res.config.hasRequiredConfig) {
    await saveOnboarding({ connected: true, dismissed: false });
    el.quickstart.scrollIntoView({ block: 'start' });
    setStatus('AI provider connected.', 'success');
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

  el.cfgContextMessages.value = String(c.contextMessages);
  el.cfgThinking.value = c.thinking;
  updateThinkingHint();

  setLengthControl(c.replyLength);
  renderOnboarding();
}

/** Explain what the selected thinking depth costs, in plain terms. */
function updateThinkingHint() {
  const spec = THINKING_SPECS[el.cfgThinking.value];
  el.thinkingHint.textContent = spec ? spec.hint : '';
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
    systemPrompt: el.cfgSystemPrompt.value,
    primaryBaseUrl: el.cfgPrimaryBaseUrl.value.trim(),
    fallbackBaseUrl: el.cfgFallbackBaseUrl.value.trim(),
    model: el.cfgModel.value.trim(),
    temperature: Number(el.cfgTemperature.value),
    maxTokens: Number(el.cfgMaxTokens.value),
    maxChars: Number(el.cfgMaxChars.value),
    contextMessages: Number(el.cfgContextMessages.value),
    thinking: el.cfgThinking.value,
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
    opt.textContent = `${spec.label} — ${spec.hint}`;
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
    setStatus('Reading the current conversation…');
    // The worker reads the instruction from storage, so anything still sitting
    // in the debounce window has to land there first.
    await flushInstruction();
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
    setStatus('AI reply ready — review it, then Send.', 'success');
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

    setStatus('Sending…');
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

    setStatus('Reading the conversation and generating a reply…');
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
 */
async function onTestConnection() {
  await run(el.btnTest, 'test', async () => {
    setTestResult('Testing…', 'success');
    const res = await callWorker({
      type: MSG.TEST_CONNECTION,
      override: readConfigForm(),
    });

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

function showSettingsTab(which) {
  const basic = which === 'basic';
  el.paneBasic.classList.toggle('hidden', !basic);
  el.paneAdvanced.classList.toggle('hidden', basic);
  el.tabBasic.classList.toggle('is-on', basic);
  el.tabAdvanced.classList.toggle('is-on', !basic);
  el.tabBasic.setAttribute('aria-selected', String(basic));
  el.tabAdvanced.setAttribute('aria-selected', String(!basic));
}

el.tabBasic.addEventListener('click', () => showSettingsTab('basic'));
el.tabAdvanced.addEventListener('click', () => showSettingsTab('advanced'));
el.cfgThinking.addEventListener('change', updateThinkingHint);

el.btnRead.addEventListener('click', onRead);
el.btnGenerate.addEventListener('click', onGenerate);
el.btnSend.addEventListener('click', onSend);
el.btnSaveConfig.addEventListener('click', onSaveConfig);
el.btnClearKey.addEventListener('click', onClearKey);
el.btnTest.addEventListener('click', onTestConnection);

// Follow-up & Send is two clicks by design: the first one asks, the second one
// commits. Nothing else in the panel sends a message the user has not read.
el.btnFollowup.addEventListener('click', () => {
  if (current && current.hasOpenChat) openFollowupConfirm();
});
el.btnFollowupCancel.addEventListener('click', closeFollowupConfirm);
el.btnFollowupGo.addEventListener('click', () => {
  closeFollowupConfirm();
  onFollowUpAndSend();
});

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

  // Refresh immediately when the user switches tabs or comes back to the panel.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !busy) readChat({ silent: true }).catch(() => {});
  });

  // Flush the pending draft and instruction before the panel goes away.
  window.addEventListener('pagehide', () => {
    saveDraft(currentChatId, el.reply.value, draftState).catch(() => {});
    flushInstruction().catch(() => {});
  });
}

init().catch((err) => {
  logError('panel init failed', err && err.message);
  setStatus('The side panel failed to initialise. Reload the extension.', 'error');
});
