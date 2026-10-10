/**
 * Content script — the bridge between WhatsApp Web's DOM and the extension.
 *
 * Responsibilities:
 *   - own the single WhatsAppAdapter instance
 *   - answer chrome.runtime messages from the service worker / side panel
 *   - enforce "chat identity must not change between generate and send"
 *
 * It does NOT talk to any AI API (task §8: side panel → service worker → AI).
 */

/* global WhatsAppAdapter, MSG, ERR, PHONE_STATUS, STORAGE_KEYS, MESSAGE_STORE_LIMITS, mergeMessageWindows, messageKey, log, logError */

(() => {
  const adapter = new WhatsAppAdapter();

  /**
   * Snapshot of the chat identity at the moment an async operation started.
   * Used to cancel a send when the user switched conversations mid-flight
   * (task §15, acceptance criterion J).
   *
   * This holds the STABLE chat id, not `getChatKey()`. The key embeds the row
   * count and the first/last row text, so it changes every time a message is
   * sent or the list is virtualised — using it here produced "Chat changed
   * while generating" on sends that were perfectly safe.
   */
  let pendingChatId = null;

  // ---------------------------------------------------------------------------
  // Accumulated message history
  //
  // WhatsApp Web virtualises the message list: only a window of rows exists in
  // the DOM, and scrolling replaces that window instead of extending it. Reading
  // the DOM alone therefore makes a conversation appear to SHRINK as the user
  // scrolls up — 7 messages, then 4, then 5.
  //
  // The store below is the fix: every read is merged into a per-chat sequence
  // that only ever grows, persisted in chrome.storage.local so it survives a
  // browser restart. Nothing here scrolls the page or asks WhatsApp for history;
  // it only remembers what the page has already shown.
  // ---------------------------------------------------------------------------

  /** In-memory mirror of the store, so a read costs no storage round-trip. */
  let storeCache = null;

  /**
   * @returns {Promise<object>} the whole per-chat store, `{}` when unreadable
   */
  async function loadStore() {
    if (storeCache) return storeCache;
    try {
      const got = await chrome.storage.local.get(STORAGE_KEYS.MESSAGE_STORE);
      const raw = got && got[STORAGE_KEYS.MESSAGE_STORE];
      storeCache = raw && typeof raw === 'object' ? raw : {};
    } catch (err) {
      logError('message store read failed', err && err.message);
      storeCache = {};
    }
    return storeCache;
  }

  /**
   * Persist the store, dropping the least recently seen chats when it grows past
   * its cap. Never throws — losing the history is survivable, breaking the read
   * path is not.
   *
   * @param {object} store
   */
  async function saveStore(store) {
    const ids = Object.keys(store);
    if (ids.length > MESSAGE_STORE_LIMITS.MAX_CHATS) {
      ids
        .sort((a, b) => (store[a].updatedAt || 0) - (store[b].updatedAt || 0))
        .slice(0, ids.length - MESSAGE_STORE_LIMITS.MAX_CHATS)
        .forEach((id) => delete store[id]);
    }
    try {
      await chrome.storage.local.set({ [STORAGE_KEYS.MESSAGE_STORE]: store });
    } catch (err) {
      logError('message store write failed', err && err.message);
    }
  }

  /**
   * Merge the freshly-read DOM window into the stored sequence for this chat.
   *
   * @param {string} chatId stable chat identity
   * @param {string} contactName for the stored record, so the history is legible
   * @param {Array<object>} fresh oldest → newest, exactly what the DOM shows
   * @returns {Promise<Array<object>>} oldest → newest, never shorter than before
   */
  async function accumulate(chatId, contactName, fresh) {
    if (!chatId) return fresh;
    const store = await loadStore();
    const entry = store[chatId];
    const stored = entry && Array.isArray(entry.messages) ? entry.messages : [];

    // A window that is entirely disjoint from what we hold is either older (the
    // user scrolled up into history we have never seen) or newer. The scroll
    // position is the only signal available, and it is unambiguous: at the
    // bottom of the pane, the window must contain the newest message.
    const prepend = !adapter.isPaneAtBottom();
    const merged = mergeMessageWindows(stored, fresh, {
      prepend,
      maxMessages: MESSAGE_STORE_LIMITS.MAX_MESSAGES_PER_CHAT,
    });

    // The panel polls this every few seconds, so the write has to be conditional
    // — an unchanged history must not touch storage at all.
    const unchanged =
      entry &&
      merged.length === stored.length &&
      (!merged.length ||
        (messageKey(merged[0]) === messageKey(stored[0]) &&
          messageKey(merged[merged.length - 1]) === messageKey(stored[stored.length - 1])));
    if (unchanged) return merged;

    log(`History for ${contactName || chatId}: ${stored.length} → ${merged.length} messages`);
    store[chatId] = {
      id: chatId,
      name: contactName || (entry && entry.name) || '',
      updatedAt: Date.now(),
      messages: merged,
    };
    await saveStore(store);
    return merged;
  }

  /**
   * @param {{revealPhone?: boolean}} [opts] revealPhone opens the contact-info
   *   drawer to read the number. Only ever set for an explicit user action —
   *   the background refresh stays passive so the drawer never flashes.
   * @returns {Promise<object>} a full context payload for the side panel
   */
  async function buildChatContext(opts = {}) {
    const contactName = adapter.getCurrentContactName();
    const isGroup = adapter.isGroupChat();
    const identity = adapter.getChatId();
    const window_ = adapter.getLoadedMessagesCached();
    const messages = await accumulate(identity.id, contactName, window_);
    const transcript = adapter.buildTranscript(messages);

    let phone = '';
    let phoneStatus = PHONE_STATUS.UNKNOWN;
    if (adapter.hasOpenChat()) {
      const res = await adapter.getCurrentPhone({ allowUi: opts.revealPhone === true });
      phone = res.phone;
      phoneStatus = res.status;
    }

    return {
      hasOpenChat: adapter.hasOpenChat(),
      chatId: identity.id,
      chatIdStable: identity.stable,
      chatKey: adapter.getChatKey(),
      contactName,
      isGroup,
      phone,
      phoneStatus,
      messages,
      transcript,
      /** How many rows the DOM itself currently holds — for the "N loaded" hint. */
      loadedInDom: window_.length,
      counts: {
        total: messages.length,
        incoming: messages.filter((m) => m.direction === 'incoming').length,
        outgoing: messages.filter((m) => m.direction === 'outgoing').length,
        unknown: messages.filter((m) => m.direction === 'unknown').length,
      },
      diagnostics: adapter.describe(),
    };
  }

  /**
   * Guard executed immediately before any real send.
   *
   * Sending is open to any conversation the user has open — 1:1 and group alike.
   * The one thing that must never happen is sending a draft into the *wrong*
   * conversation, so the chat identity is re-checked against the live DOM here,
   * after the AI call and after the composer write, immediately before the click.
   *
   * @param {string} expectedChatId stable chat id the draft was generated for
   * @returns {Promise<{phone: string}>}
   * @throws {Error} NO_CHAT_OPEN / CHAT_CHANGED_DURING_GENERATION
   */
  async function assertSafeToSend(expectedChatId) {
    if (!adapter.hasOpenChat()) {
      logError('Send blocked — no chat open');
      const e = new Error('NO_CHAT_OPEN');
      e.code = ERR.NO_CHAT_OPEN;
      throw e;
    }

    // Chat-switch guard (task §15). Only enforced when the caller passed the id
    // it generated the reply for.
    if (expectedChatId) {
      const now = adapter.getChatId();
      if (now.stable && now.id !== expectedChatId) {
        logError('Chat changed during generation — send cancelled');
        const e = new Error('CHAT_CHANGED_DURING_GENERATION');
        e.code = ERR.CHAT_CHANGED;
        throw e;
      }
    }

    // Read-only, passive: the number is reported back for the status line, but
    // it never blocks the send.
    const { phone } = await adapter.getCurrentPhone();
    log('Chat verified');
    return { phone };
  }

  /**
   * Write-then-send with the guard applied, and the composer cleaned up when the
   * guard refuses.
   *
   * By the time the guard runs, the draft has already been written into the
   * composer — that is the whole point of checking here rather than earlier. If
   * the check fails, the composer now holds text in a conversation the user did
   * not intend to send to, so leaving it there would hand them a loaded gun: one
   * press of Enter and the draft goes to the wrong customer.
   *
   * @param {string} expectedChatId
   * @returns {Promise<{phone: string}>}
   */
  async function guardedSend(expectedChatId) {
    try {
      const { phone } = await assertSafeToSend(expectedChatId);
      await adapter.sendCurrentMessage();
      return { phone };
    } catch (err) {
      try {
        await adapter.clearComposer();
      } catch (e) {
        logError('Could not clear the composer after a refused send', e && e.message);
      }
      throw err;
    }
  }

  /**
   * Message router. Every handler returns a plain JSON-serializable object so
   * the side panel receives a structured `{ok, ...}` or `{ok:false, code}`.
   */
  const handlers = {
    [MSG.PING]: async () => ({ ok: true, href: location.href, at: Date.now() }),

    [MSG.GET_CHAT_CONTEXT]: async (msg) => {
      const ctx = await buildChatContext({ revealPhone: msg && msg.revealPhone === true });
      pendingChatId = ctx.chatId || null;
      log('Current chat detected:', ctx.contactName || '(none)');
      log(`Loaded ${ctx.counts.total} messages`);
      return { ok: true, context: ctx };
    },

    [MSG.REVEAL_PHONE]: async () => {
      const res = await adapter.getCurrentPhone({ allowUi: true });
      return { ok: true, ...res };
    },

    [MSG.SET_COMPOSER_TEXT]: async ({ text }) => {
      const written = await adapter.setComposerText(text);
      return { ok: written, written, inComposer: adapter.getComposerText() };
    },

    /** Clear the composer. Used by tests and by the panel's "discard draft". */
    [MSG.CLEAR_COMPOSER]: async () => {
      const before = adapter.getComposerText();
      const cleared = await adapter.clearComposer();
      return { ok: true, cleared, before, inComposer: adapter.getComposerText() };
    },

    [MSG.CLICK_SEND]: async ({ chatId }) => {
      const { phone } = await guardedSend(chatId);
      log('Sent');
      return { ok: true, phone };
    },

    /**
     * Combined guarded send used by both "Send" and "Follow-up & Send".
     * The service worker has already checked that a conversation is open; this
     * handler re-validates the chat identity against the live DOM before
     * clicking.
     */
    [MSG.SEND_MESSAGE]: async () => {
      const { phone } = await guardedSend(pendingChatId);
      pendingChatId = null;
      log('Sent');
      return { ok: true, phone };
    },
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const handler = handlers[msg && msg.type];
    if (!handler) {
      sendResponse({ ok: false, code: 'UNKNOWN_MESSAGE_TYPE', message: `No handler for ${msg && msg.type}` });
      return false;
    }
    Promise.resolve()
      .then(() => handler(msg))
      .then((res) => sendResponse(res))
      .catch((err) => {
        logError('Handler error', msg.type, err && err.code ? err.code : '', err && err.message);
        sendResponse({
          ok: false,
          code: (err && err.code) || 'CONTENT_SCRIPT_ERROR',
          message: (err && err.message) || String(err),
        });
      });
    return true; // keep the channel open for the async response
  });

  log('Content script ready on', location.href);
})();