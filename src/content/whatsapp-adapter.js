/**
 * WhatsAppAdapter — the ONLY place in this extension that touches WhatsApp Web's
 * DOM.
 *
 * Design rules (see docs/ARCHITECTURE.md):
 *   1. Never rely on auto-generated class names (`.x1n2onr6`, `.x78zum5`, ...).
 *   2. Selector priority: semantic attributes > role > aria-label >
 *      contenteditable > stable data-* > DOM structure > (last resort) class.
 *   3. Every public method is defensive: WhatsApp ships DOM changes weekly, so
 *      each lookup falls back through several strategies and degrades to a
 *      typed error instead of throwing raw.
 *
 * DOM profile targeted: WhatsApp Web "Comet" build (2026), verified live via
 * CDP on 2026-09-23. Confirmed facts from that inspection:
 *   - `#main` EXISTS BUT IS EMPTY — never read messages through it.
 *   - messages live in `[data-testid="conversation-panel-messages"]`,
 *     one row per message: `[data-testid="msg-container"]`
 *   - **`.message-in` / `.message-out` DO NOT EXIST** (count 0). Direction comes
 *     from `[data-testid="tail-out"]` / `[data-testid="tail-in"]`, corroborated
 *     by `span[aria-label="你："]`, by the delivery-status label and finally by
 *     which edge the bubble hugs. `data-pre-plain-text` is a *display name*, not
 *     a phone number, and must never be used to decide direction.
 *   - composer: `[data-testid="conversation-compose-box-input"]`
 *   - **the send button only renders once the composer is non-empty**; when it
 *     exists it is `button[data-tab="11"]` containing `[data-icon="wds-ic-send-filled"]`
 *     and `aria-label="发送"` (locale-dependent — never match on that text alone).
 *   - contact phone: `[data-testid="chat-info-drawer"]` →
 *     `[data-testid^="contact-info-subtitle"]` (also mirrored in "拉黑+86…" rows)
 *
 * When WhatsApp changes again, this file should be the only one needing edits.
 */

/* global normalizePhone, phoneFromDisplayName, formatTranscript, directionFromGaps, MESSAGE_DIRECTION, DELIVERY_STATUS_LABELS, PHONE_STATUS, ERR, log, logError, sleep */

class WhatsAppAdapter {
  constructor() {
    /** Cached phone lookup for the currently open chat. */
    this._phoneCache = { chatKey: null, phone: '', status: PHONE_STATUS.UNKNOWN };
    /**
     * Cache of the last identity/context read, keyed by a cheap "has the
     * conversation moved on?" signature. Avoids re-walking every message row on
     * the hot paths (read → generate → re-read → send → re-check), which on a
     * long conversation is hundreds of layout reads per click.
     * @type {{sig: string, value: object}|null}
     */
    this._contextCache = null;
  }

  /**
   * Cheap change detector for the open conversation.
   *
   * Combines the header text, the first and last rendered rows, and the composer
   * contents. Any of those changing means the cached transcript is stale.
   *
   * The first/last row text is what makes this correct rather than merely
   * plausible: WhatsApp only keeps a window of messages in the DOM, so sending a
   * message appends a row at the bottom *and evicts one at the top* — the row
   * count alone stays the same and a count-only signature would happily serve a
   * transcript that is missing the message that was just sent.
   *
   * @returns {string}
   * @private
   */
  _contextSignature() {
    const header = this.getHeader();
    const composer = this.getComposer();
    const rows = this.getMessageRows();
    const first = rows.length ? (rows[0].innerText || '').slice(0, 60) : '';
    const last = rows.length ? (rows[rows.length - 1].innerText || '').slice(0, 60) : '';
    return [
      header ? (header.innerText || '').trim() : '',
      rows.length,
      first,
      last,
      composer ? (composer.innerText || '').length : 0,
    ].join('\u0001');
  }

  // ---------------------------------------------------------------------------
  // Root lookups
  // ---------------------------------------------------------------------------

  /**
   * The app root. WhatsApp mounts a single #app node.
   * @returns {HTMLElement|null}
   */
  getAppRoot() {
    return document.querySelector('#app') || document.body;
  }

  /**
   * The pane that holds the open conversation (right-hand side).
   *
   * `#main` is present but EMPTY in the Comet build, so it is only accepted as
   * a fallback when nothing better exists.
   *
   * @returns {HTMLElement|null}
   */
  getMainPanel() {
    const composer = document.querySelector('[data-testid="conversation-compose-box-input"]');
    const composerPane = composer ? composer.closest('[data-testid="conversation-panel-wrapper"]') : null;
    return (
      document.querySelector('[data-testid="conversation-panel-wrapper"]') ||
      (document.querySelector('#main') && document.querySelector('#main').children.length
        ? document.querySelector('#main')
        : null) ||
      (composerPane instanceof HTMLElement ? composerPane : null) ||
      document.querySelector('div[role="application"]') ||
      null
    );
  }

  /** @returns {HTMLElement|null} the open conversation's header */
  getHeader() {
    return (
      document.querySelector('[data-testid="conversation-header"]') ||
      document.querySelector('#main header') ||
      null
    );
  }

  /** @returns {HTMLElement|null} the empty-state panel shown when no chat is open */
  getIntroPanel() {
    return document.querySelector('[data-testid="intro-panel"]');
  }

  /**
   * True when a conversation is actually open (not the "Keep your phone
   * connected" splash / empty state).
   * @returns {boolean}
   */
  hasOpenChat() {
    if (this.getIntroPanel()) return false;
    return !!(this.getComposer() && this.getHeader());
  }

  /**
   * The scrollable message list container.
   * @returns {HTMLElement|null}
   */
  getMessageList() {
    return (
      document.querySelector('[data-testid="conversation-panel-messages"]') ||
      document.querySelector('div[role="application"]') ||
      null
    );
  }

  /**
   * Is the message list scrolled to (or very near) its newest end?
   *
   * Only used to disambiguate a message window that does not overlap anything we
   * have stored: at the bottom, the window must contain the newest messages; up
   * the history, it must be older than everything stored.
   *
   * @returns {boolean}
   */
  isPaneAtBottom() {
    const list = this.getMessageList();
    if (!list) return true;
    const scroller = list.scrollHeight > list.clientHeight ? list : list.parentElement || list;
    return scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 48;
  }

  /**
   * The message composer.
   *
   * Comet uses a Lexical contenteditable DIV (`conversation-compose-box-input`).
   * @returns {HTMLElement|null}
   */
  getComposer() {
    return (
      document.querySelector('[data-testid="conversation-compose-box-input"]') ||
      document.querySelector('footer div[contenteditable="true"][data-lexical-editor="true"]') ||
      document.querySelector('footer div[contenteditable="true"][role="textbox"]') ||
      document.querySelector('#main div[contenteditable="true"][role="textbox"]') ||
      null
    );
  }

  // ---------------------------------------------------------------------------
  // Current chat identity
  // ---------------------------------------------------------------------------

  /**
   * A stable-ish identifier for the currently open chat. Built from the things
   * that actually change when the user switches conversations, so it can be used
   * to detect "the user switched chats while we were generating".
   *
   * @returns {string} '' when no chat is open
   */
  getChatKey() {
    if (!this.hasOpenChat()) return '';
    const name = this.getCurrentContactName();
    const msgs = this.getLoadedMessages();
    const first = msgs.length ? msgs[0] : null;
    const last = msgs.length ? msgs[msgs.length - 1] : null;
    // The composer's aria-label embeds the recipient ("输入要向"+86 …"发送的消息")
    // and is refreshed on every chat switch — a strong, cheap switch signal.
    const composer = this.getComposer();
    const aria = composer ? composer.getAttribute('aria-label') || '' : '';
    return [
      name,
      this.isGroupChat() ? 'group' : 'dm',
      aria,
      msgs.length,
      first ? first.text.slice(0, 40) : '',
      last ? last.text.slice(0, 40) : '',
    ].join('|');
  }

  /**
   * A STABLE identity for the open conversation.
   *
   * `getChatKey()` cannot be used for anything that must survive a scroll or a
   * new message — it deliberately includes the row count and the first/last row
   * text, so it changes constantly. That is what makes it a good "has the
   * conversation moved on?" signature and a terrible storage key.
   *
   * This is the opposite: it is derived only from the header title and the
   * composer's recipient, both of which stay put for as long as the chat is
   * open. It is the key for the accumulated message history, the per-chat draft
   * and the chat-switch send guard.
   *
   * Not globally unique — two different unsaved contacts who both saved
   * themselves under the same display name would collide. For a single-user
   * extension that is an acceptable trade; the alternative is opening the
   * contact drawer on every poll, which makes the page flash.
   *
   * @returns {{id: string, stable: boolean}} `stable: false` means the header had
   *   not rendered a usable identity yet (mid-switch) and callers must not
   *   treat the value as a real chat.
   */
  getChatId() {
    if (!this.hasOpenChat()) return { id: '', stable: false };

    const name = this.getCurrentContactName();
    // The composer's aria-label names the recipient and is refreshed on every
    // chat switch — for a saved contact it carries the name, for an unsaved one
    // the number. For groups it is a bare "输入消息" and carries nothing.
    const composer = this.getComposer();
    const aria = composer ? composer.getAttribute('aria-label') || '' : '';
    const m = aria.match(/向\s*[“"](.+?)[”"]\s*发送的消息/);
    const recipient = m ? m[1].trim() : '';

    const titlePhone = phoneFromDisplayName(name);
    const anchor = titlePhone || recipient || name;
    if (!anchor) return { id: '', stable: false };

    // Prefer the number when we have one — it is the same string WhatsApp shows,
    // and it cannot change when the contact renames themselves.
    const kind = this.isGroupChat() ? 'group' : 'dm';
    return { id: `${kind}:${anchor}`, stable: true };
  }

  /**
   * The display name shown in the conversation header.
   * @returns {string}
   */
  getCurrentContactName() {
    const header = this.getHeader();
    if (!header) return '';

    // Strategy 1 — the dedicated title node. This is the element that actually
    // carries the conversation name in the Comet build.
    const titleNode = header.querySelector('[data-testid="conversation-info-header-chat-title"]');
    if (titleNode) {
      const t = (titleNode.getAttribute('title') || titleNode.textContent || '').trim();
      if (t && !this._isChromeLabel(titleNode, t)) return t;
    }

    // Strategy 2 — any titled span inside the info-header button.
    const titled = header.querySelector('[data-testid="conversation-info-header"] span[title]');
    if (titled) {
      const t = (titled.getAttribute('title') || '').trim();
      if (t && !this._isChromeLabel(titled, t)) return t;
    }

    // Strategy 3 — any span[dir="auto"], skipping images/buttons/timestamps.
    for (const el of header.querySelectorAll('span[dir="auto"]')) {
      const t = (el.textContent || '').trim();
      if (!t || /^\d{1,2}:\d{2}/.test(t)) continue;
      if (this._isChromeLabel(el, t)) continue;
      return t;
    }

    // Strategy 4 — the header's own text, first line only.
    const line = (header.innerText || '')
      .split('\n')
      .map((s) => s.trim())
      .find(Boolean);
    if (line && !this._isChromeLabel(header, line)) return line;

    return '';
  }

  /**
   * Is this text the button's own label rather than the conversation name?
   *
   * While a chat is opening, the header briefly renders before its title node
   * exists, and the only text in it is the info button's accessible name
   * ("点击此处查看联系人信息" / "Click here for contact info" / "个人主页详情").
   * Reading that as the contact name produced a chat card that flickered to a
   * UI string on every switch, so any candidate that is an ancestor's
   * aria-label or title is rejected.
   *
   * @param {HTMLElement} node
   * @param {string} text
   * @returns {boolean}
   * @private
   */
  _isChromeLabel(node, text) {
    for (let el = node; el && el !== document.body; el = el.parentElement) {
      const aria = (el.getAttribute && el.getAttribute('aria-label')) || '';
      const title = (el.getAttribute && el.getAttribute('title')) || '';
      if (aria && aria.trim() === text) return true;
      if (title && title.trim() === text) return true;
    }
    return false;
  }

  /**
   * Is the open chat a group / broadcast rather than a 1:1 conversation?
   *
   * Used for labelling only — groups are sent to exactly like 1:1 chats. The
   * check exists so the UI can say "group" instead of showing an empty phone
   * row, and so the transcript header names the right kind of conversation.
   *
   * @returns {boolean}
   */
  isGroupChat() {
    const header = this.getHeader();
    if (!header) return false;
    const text = (header.textContent || '').toLowerCase();
    if (/\b\d+\s*(participants?|位参与者|名参与者|人)\b/.test(text)) return true;
    if (header.querySelector('[data-testid="default-group-icon"], [data-icon="default-group"]')) return true;
    // The composer aria-label is "…向"<name>"发送的消息" for DMs; group chats
    // render a bare "输入消息" without a recipient.
    const composer = this.getComposer();
    const aria = composer ? composer.getAttribute('aria-label') || '' : '';
    if (aria && !/向[“"].+[”"]发送的消息/.test(aria) && /输入消息/.test(aria)) return true;
    return false;
  }

  // ---------------------------------------------------------------------------
  // Phone number verification
  // ---------------------------------------------------------------------------

  /**
   * Open the contact-info drawer if it is not already open.
   *
   * This DOES click the UI (header). It never sends anything and never scrolls
   * the message list. It is the only reliable way to learn the real phone number
   * of the open chat — names alone must never be trusted (task §3).
   *
   * @returns {Promise<boolean>} true when a contact panel is present afterwards
   */
  async openContactInfo() {
    if (this.getContactPanel()) return true;

    const header = this.getHeader();
    if (!header) return false;

    const candidates = [
      header.querySelector('[data-testid="conversation-info-header"]'),
      header.querySelector('[data-testid="conversation-info-header-chat-title"]'),
      header.querySelector('div[role="button"][title="个人主页详情"]'),
      header.querySelector('div[role="button"][tabindex]'),
    ].filter(Boolean);

    for (const el of candidates) {
      try {
        el.click();
        await sleep(400);
        if (this.getContactPanel()) return true;
      } catch (e) {
        /* try the next candidate */
      }
    }
    return !!this.getContactPanel();
  }

  /**
   * The contact-info drawer (right overlay) that shows the phone number.
   * @returns {HTMLElement|null}
   */
  getContactPanel() {
    const el =
      document.querySelector('[data-testid="chat-info-drawer"]') ||
      document.querySelector('[data-testid="contact-info-drawer"]') ||
      document.querySelector('section[role="complementary"]') ||
      null;
    return el instanceof HTMLElement ? el : null;
  }

  /**
   * Close the contact-info drawer, returning the UI to its previous state.
   * @returns {Promise<void>}
   */
  async closeContactInfo() {
    const panel = this.getContactPanel();
    if (!panel) return;
    const closeBtn = panel.querySelector('button[aria-label="关闭"], button[aria-label="Close"]');
    if (closeBtn instanceof HTMLElement) {
      try {
        closeBtn.click();
        await sleep(250);
      } catch (e) {
        /* non-fatal */
      }
    }
  }

  /**
   * Extract the phone number displayed inside the contact-info drawer.
   *
   * Comet renders it as `<span data-testid="contact-info-subtitle selectable-text">`
   * and repeats it in the destructive-action rows ("拉黑+86 138 0013 8000").
   * We scan every text node and keep the ones that normalize to a plausible
   * international number, preferring the dedicated subtitle node.
   *
   * @returns {string} normalized digits, or '' when not found
   */
  readPhoneFromContactPanel() {
    const panel = this.getContactPanel();
    if (!panel) return '';

    const candidates = [];

    // Strategy 1 — the dedicated subtitle node.
    const subtitle = panel.querySelector('[data-testid^="contact-info-subtitle"]');
    if (subtitle) candidates.push((subtitle.textContent || '').trim());

    // Strategy 2 — selectable / titled spans.
    for (const el of panel.querySelectorAll('span.selectable-text, span[dir="auto"], span[title]')) {
      const t = (el.getAttribute('title') || el.textContent || '').trim();
      if (t) candidates.push(t);
    }

    // Strategy 3 — every line of the drawer text.
    for (const line of (panel.innerText || panel.textContent || '').split('\n')) {
      const t = line.trim();
      if (t) candidates.push(t);
    }

    const seen = new Set();
    for (const c of candidates) {
      if (!c || seen.has(c)) continue;
      seen.add(c);
      // WhatsApp writes action labels as "拉黑+86 138 0013 8000" — strip any
      // leading non-numeric prefix before validating.
      const m = c.match(/\+?[\d][\d\s()\-. ]{6,}\d/);
      if (!m) continue;
      const norm = normalizePhone(m[0]);
      if (norm) return norm;
    }
    return '';
  }

  /**
   * Resolve the phone number of the currently open chat.
   *
   * Returns a status alongside the number so the caller can distinguish
   * "verified" from "we simply could not find it" — never guess from the name.
   *
   * PASSIVE BY DEFAULT. The number used to be a send gate, so every read opened
   * the contact-info drawer to fetch it; that made the drawer flash open and
   * shut on every chat switch. Sending is no longer gated on the number, so the
   * default path never touches the UI: it reads whatever is already on screen.
   * `allowUi: true` (an explicit user action) still opens the drawer.
   *
   * @param {{allowUi?: boolean}} [opts] allowUi=true permits opening the drawer
   * @returns {Promise<{phone: string, status: string, contactName: string, isGroup: boolean}>}
   */
  async getCurrentPhone(opts = {}) {
    const allowUi = opts.allowUi === true;
    const contactName = this.getCurrentContactName();
    const isGroup = this.isGroupChat();

    if (!this.hasOpenChat()) {
      return { phone: '', status: PHONE_STATUS.UNKNOWN, contactName, isGroup };
    }
    if (isGroup) {
      // A group has no single phone number. This is not an error any more — it
      // just means the card has no number to show.
      return { phone: '', status: PHONE_STATUS.UNVERIFIED, contactName, isGroup: true };
    }

    const chatKey = this.getChatKey();

    // 1. Already-open drawer?
    let phone = this.readPhoneFromContactPanel();
    if (phone) {
      this._phoneCache = { chatKey, phone, status: PHONE_STATUS.VERIFIED };
      return { phone, status: PHONE_STATUS.VERIFIED, contactName, isGroup };
    }

    // 2. Cached from a previous lookup of this exact chat?
    if (this._phoneCache.chatKey === chatKey && this._phoneCache.phone) {
      return { phone: this._phoneCache.phone, status: PHONE_STATUS.VERIFIED, contactName, isGroup };
    }

    // 3. Unsaved contacts are displayed by their raw number — WhatsApp itself is
    // showing us the phone, so this is a read, not a guess from a name.
    // `phoneFromDisplayName` refuses anything that is not purely a number, so a
    // saved contact's name or a group subject can never become one.
    const fromHeader = phoneFromDisplayName(contactName);
    if (fromHeader) {
      this._phoneCache = { chatKey, phone: fromHeader, status: PHONE_STATUS.VERIFIED };
      return { phone: fromHeader, status: PHONE_STATUS.VERIFIED, contactName, isGroup };
    }

    if (!allowUi) {
      return { phone: '', status: PHONE_STATUS.UNVERIFIED, contactName, isGroup };
    }

    // 4. Explicit request: open the contact drawer and read it.
    const opened = await this.openContactInfo();
    if (opened) {
      await sleep(300);
      phone = this.readPhoneFromContactPanel();
      await this.closeContactInfo();
    }

    if (phone) {
      this._phoneCache = { chatKey, phone, status: PHONE_STATUS.VERIFIED };
      return { phone, status: PHONE_STATUS.VERIFIED, contactName, isGroup };
    }

    this._phoneCache = { chatKey, phone: '', status: PHONE_STATUS.UNVERIFIED };
    return { phone: '', status: PHONE_STATUS.UNVERIFIED, contactName, isGroup };
  }

  // ---------------------------------------------------------------------------
  // Reading loaded messages
  // ---------------------------------------------------------------------------

  /**
   * Collect the message row elements currently rendered in the DOM.
   *
   * IMPORTANT: read-only. This never scrolls, never requests history, never
   * touches the left chat list. Only what is already painted is returned.
   *
   * @returns {HTMLElement[]}
   */
  getMessageRows() {
    const list = this.getMessageList();
    if (!list) return [];

    // Comet: one `msg-container` per message. NEVER filter on
    // `[role="row"]` here — in this build `#pane-side` list items also carry
    // role=row and would leak the chat list into the transcript.
    let rows = Array.from(list.querySelectorAll('[data-testid="msg-container"]'));
    if (!rows.length) {
      rows = Array.from(list.children).filter(
        (el) => el instanceof HTMLElement && el.querySelector('[data-testid="msg-container"]'),
      );
    }
    // Only keep the outermost containers (some builds nest them).
    return rows.filter((r) => r instanceof HTMLElement && !r.parentElement.closest('[data-testid="msg-container"]'));
  }

  /**
   * Extract the text of a single message row.
   *
   * @param {HTMLElement} row
   * @returns {{text: string, kind: string}}
   */
  extractRowContent(row) {
    // The copyable text of a WhatsApp message lives in
    // `span[data-testid="selectable-text"]` (legacy builds also add
    // `.selectable-text` + a `span[dir="ltr"]` leaf).
    const leaves = row.querySelectorAll('[data-testid="selectable-text"] span[dir="ltr"]');
    if (leaves.length) {
      const text = Array.from(leaves)
        .map((n) => (n.innerText || n.textContent || '').trim())
        .filter(Boolean)
        .join(' ')
        .trim();
      if (text) return { text, kind: 'text' };
    }

    const blocks = row.querySelectorAll('[data-testid="selectable-text"], span.selectable-text');
    if (blocks.length) {
      const text = Array.from(blocks)
        .map((n) => (n.innerText || n.textContent || '').trim())
        .filter(Boolean)
        .join(' ')
        .trim();
      if (text) return { text, kind: 'text' };
    }

    // Media placeholders we deliberately do not process in Phase 1.
    const MEDIA_MAP = {
      'media-camera': '[IMAGE]',
      'media-image': '[IMAGE]',
      'media-download': '[DOCUMENT]',
      document: '[DOCUMENT]',
      'audio-play': '[VOICE MESSAGE]',
      'media-audio': '[VOICE MESSAGE]',
      'status-sticker': '[STICKER]',
      sticker: '[STICKER]',
      'video-play': '[VIDEO]',
      'media-video': '[VIDEO]',
    };
    for (const icon of row.querySelectorAll('span[data-icon]')) {
      const name = icon.getAttribute('data-icon') || '';
      // `tail-in` / `tail-out` are bubble tails, not message types.
      if (MEDIA_MAP[name]) return { text: MEDIA_MAP[name], kind: 'media' };
    }

    return { text: '', kind: 'unknown' };
  }

  /**
   * Determine the time label of a message row, if present.
   * @param {HTMLElement} row
   * @returns {string}
   */
  extractRowTimestamp(row) {
    const meta = row.querySelector('[data-testid="msg-meta"]');
    const scope = meta || row;
    const t = (scope.textContent || '').trim();
    const m = t.match(/\d{1,2}:\d{2}(\s*[APap]\.?[Mm]\.?)?/);
    return m ? m[0] : '';
  }

  /**
   * Determine whether a row is incoming (customer) or outgoing (me).
   *
   * Comet does NOT use `.message-in` / `.message-out` (verified live: both count
   * 0). Priority order — every signal below was measured on the live page:
   *
   *   1. `[data-testid="tail-out"]` / `[data-testid="tail-in"]` — the bubble
   *      tail. Authoritative, but WhatsApp only renders it on the *last*
   *      message of a run, so it is absent from most rows (7 of 14 in the test
   *      conversation).
   *   2. `span[aria-label="你："]` — the sender label WhatsApp prints above own
   *      messages. Also only on the *first* message of a run. Locale-dependent,
   *      hence second.
   *   3. delivery-status label — WhatsApp never renders read/delivered state on
   *      an incoming message, so its presence proves the row is ours. This is
   *      the only signal present on *every* outgoing row.
   *   4. geometry — which edge the bubble hugs. The catch-all; see
   *      `_directionFromGeometry`.
   *
   * There is deliberately no `data-pre-plain-text` branch any more. That
   * attribute holds the sender's *display name* (`"Acme Vending: "`), not a
   * phone number, and the adapter has no trustworthy source for the account's
   * own number — `_phoneCache` holds the *contact's* number for the open chat.
   * So the branch could only ever misfire, and it did: with an empty cache it
   * declared every row whose label happened to be numeric to be incoming,
   * including our own.
   *
   * @param {HTMLElement} row
   * @returns {'incoming'|'outgoing'|'unknown'}
   */
  extractRowDirection(row) {
    if (row.querySelector('[data-testid="tail-out"], [data-icon="tail-out"]')) {
      return MESSAGE_DIRECTION.OUTGOING;
    }
    if (row.querySelector('[data-testid="tail-in"], [data-icon="tail-in"]')) {
      return MESSAGE_DIRECTION.INCOMING;
    }

    for (const span of row.querySelectorAll('span[aria-label]')) {
      const label = (span.getAttribute('aria-label') || '').trim();
      if (/^(你|You)\s*[:：]/.test(label)) return MESSAGE_DIRECTION.OUTGOING;
      if (this._isDeliveryStatus(label)) return MESSAGE_DIRECTION.OUTGOING;
    }

    return this._directionFromGeometry(row);
  }

  /**
   * Is this accessible name one of WhatsApp's delivery-status labels?
   *
   * @param {string} label
   * @returns {boolean}
   * @private
   */
  _isDeliveryStatus(label) {
    if (!label) return false;
    return DELIVERY_STATUS_LABELS.some((s) => label.indexOf(s) !== -1);
  }

  /**
   * Measure a row's alignment.
   *
   * Alignment cannot be read from the row's own box. In the Comet build the row
   * spans the full conversation width no matter who sent the message — only the
   * *bubble* inside it is left- or right-aligned. A real `Range` over the
   * message text gives that alignment directly: a Range's `getBoundingClientRect`
   * is the union of the text's client rects, i.e. exactly the visible text block.
   *
   * That is the one measurement here that survives the side panel being open,
   * which is the only way the extension is ever used. Under CDP — and only
   * under CDP — layout can be stale while nothing has forced a reflow, so the
   * measured box comes back as the row's full width; the message row then falls
   * back to the tail markers / check marks. See `_directionFromGeometry`.
   *
   * @param {HTMLElement} row
   * @returns {{left: number, right: number, width: number}|null}
   * @private
   */
  _measureMessageBox(row) {
    try {
      const target = row.querySelector('[data-testid="selectable-text"]')
        || row.querySelector('div.copyable-text')
        || row;
      const range = document.createRange();
      range.selectNodeContents(target);
      const rect = range.getBoundingClientRect();
      if (rect && rect.width) {
        return { left: rect.left, right: rect.right, width: rect.width };
      }
    } catch (e) {
      /* fall through to the element box */
    }

    const el = row.querySelector('div.copyable-text');
    const box = el ? el.getBoundingClientRect() : row.getBoundingClientRect();
    return box.width ? { left: box.left, right: box.right, width: box.width } : null;
  }

  /**
   * Decide direction from which edge of the conversation the message hugs.
   *
   * Used only when the tail marker, the "你：" label and the delivery-status
   * label are all absent — which in Comet is the norm for the messages in the
   * *middle* of a run, not the exception.
   *
   * The thresholds are not symmetric, because the two sides are not symmetric:
   * an outgoing bubble carries ~60px of trailing chrome (timestamp + check
   * marks) that keeps it off the right edge, while an incoming bubble carries
   * that chrome on its left, so it sits flush against the left edge. Measured
   * live: outgoing → gapLeft 465–1124, gapRight 57–68; incoming → gapLeft 62,
   * gapRight 830–1113. The comparison lives in `directionFromGaps` so it can be
   * unit-tested without a browser.
   *
   * @param {HTMLElement} row
   * @returns {'incoming'|'outgoing'|'unknown'}
   * @private
   */
  _directionFromGeometry(row) {
    const box = this._measureMessageBox(row);
    if (!box) return MESSAGE_DIRECTION.UNKNOWN;

    // The bubble's distance to each side of the conversation column.
    const pane = this.getMainPanel() || this.getMessageList() || row;
    const paneRect = pane.getBoundingClientRect();
    if (!paneRect.width) return MESSAGE_DIRECTION.UNKNOWN;

    return directionFromGaps(box.left - paneRect.left, paneRect.right - box.right, paneRect.width);
  }

  /**
   * Read the messages already loaded in the open conversation.
   *
   * Never scrolls. Never requests history. Returns oldest → newest.
   *
   * @returns {Array<{direction: string, text: string, timestamp: string, kind: string}>}
   */
  getLoadedMessages() {
    const rows = this.getMessageRows();
    const out = [];
    let lastDirection = MESSAGE_DIRECTION.UNKNOWN;
    let lastTimestamp = '';

    for (const row of rows) {
      const { text, kind } = this.extractRowContent(row);
      const timestamp = this.extractRowTimestamp(row) || lastTimestamp;

      // Direction FIRST, then carry forward. A continuation row is a paragraph
      // break inside one bubble: it has no tail marker of its own, and the
      // geometry fallback would confidently call it "incoming" because its
      // short line does not reach the right edge. Inheriting the parent
      // bubble's direction is both correct and cheap.
      let direction = this.extractRowDirection(row);
      if (direction === MESSAGE_DIRECTION.UNKNOWN) direction = lastDirection;
      if (direction !== MESSAGE_DIRECTION.UNKNOWN) lastDirection = direction;
      if (timestamp) lastTimestamp = timestamp;

      if (!text) continue;
      out.push({ direction, text, timestamp, kind });
    }

    // The DOM renders oldest → newest; keep that order explicitly so a future
    // container change cannot silently reverse the conversation.
    return out;
  }

  /**
   * Cached variant of {@link getLoadedMessages} for the hot paths.
   *
   * Reading a transcript walks every rendered row and each row needs several
   * layout reads to work out its direction, so a single "Follow-up & Send"
   * click would otherwise repeat that walk four times (read → generate →
   * re-read → send → re-check). The cache is keyed by a signature of the
   * conversation, so a new message, a different chat or a composer edit all
   * invalidate it — the send path therefore still sees live data.
   *
   * @returns {Array<{direction: string, text: string, timestamp: string, kind: string}>}
   */
  getLoadedMessagesCached() {
    const sig = this._contextSignature();
    if (this._contextCache && this._contextCache.sig === sig) {
      return this._contextCache.value;
    }
    const value = this.getLoadedMessages();
    this._contextCache = { sig, value };
    return value;
  }

  /**
   * Serialize the loaded conversation into the `CUSTOMER: / ME:` transcript
   * format handed to the AI.
   *
   * Delegates to the shared `formatTranscript` so the service worker — which
   * applies the "last N messages" context window after accumulation — produces
   * byte-identical output from a trimmed array.
   *
   * @param {Array<{direction: string, text: string}>} [messages]
   * @returns {string}
   */
  buildTranscript(messages) {
    return formatTranscript(messages || this.getLoadedMessages());
  }

  // ---------------------------------------------------------------------------
  // Writing + sending
  // ---------------------------------------------------------------------------

  /**
   * Put `text` into the composer, replacing whatever is there.
   *
   * Comet uses a Lexical editor, which keeps its OWN selection model. Two
   * consequences, both learned from live sends:
   *
   *   1. Clearing via DOM (`textContent = ''`, Range + `execCommand('delete')`)
   *      does NOT clear Lexical's model. It looks empty, then the next insert
   *      makes the editor re-emit the old text — that is how a sent message
   *      ended up containing its own body three times.
   *      The only reliable clear is a real selection + a real Backspace, so the
   *      editor processes the deletion through its own input path.
   *   2. The text must be inserted EXACTLY ONCE. Layering a `textContent`
   *      fallback or a synthetic `input` event on top of a successful insert
   *      makes Lexical ingest it again.
   *
   * @param {string} text
   * @returns {Promise<boolean>} true when the composer holds exactly `text`
   */
  async setComposerText(text) {
    const composer = this.getComposer();
    if (!composer) {
      const e = new Error('COMPOSER_NOT_FOUND');
      e.code = ERR.COMPOSER_NOT_FOUND;
      throw e;
    }

    // Single line breaks only: Lexical treats Enter as "send".
    const safe = String(text).replace(/\r/g, '').replace(/\n{2,}/g, '\n').trim();
    if (!safe) return false;

    // `insertText` REPLACES the current selection, so "clear then insert" is not
    // needed here: select the whole field and insert once. One operation, one
    // Lexical transaction — no window in which a half-cleared model can be
    // re-emitted, which is what produced the duplicated body in an earlier build.
    this._selectAllInComposer(composer);

    let inserted = false;
    try {
      inserted = document.execCommand('insertText', false, safe);
    } catch (e) {
      inserted = false;
    }
    await sleep(220);

    const final = this.getComposerText();
    if (final === safe) return true;
    // Accept a whitespace-only difference (Lexical normalises some spaces).
    if (final && final.replace(/\s+/g, ' ').trim() === safe.replace(/\s+/g, ' ').trim()) return true;

    logError('Composer write failed', `wanted ${safe.length} chars, box has ${final.length}`, `insertText=${inserted}`);
    // Leave the box EMPTY rather than wrong — never send a corrupted draft.
    await this.clearComposer();
    return false;
  }

  /**
   * Empty the composer so Lexical's model is empty too.
   *
   * @returns {Promise<boolean>} true when the composer is empty afterwards
   */
  async clearComposer() {
    const composer = this.getComposer();
    if (!composer) return true;
    if (!this.getComposerText()) return true;

    // One strategy, retried — never several strategies stacked in a row.
    //
    // The deceptively obvious `document.execCommand('selectAll')` is NOT used
    // here. Live probes on the Comet build show it returns `true` while leaving
    // `document.getSelection()` EMPTY (selLen 0) — it does not touch the
    // contenteditable's internal selection at all. Deleting against it silently
    // no-ops, which is exactly how an early build "cleared" the box while the
    // text stayed put and later got sent three times over.
    //
    // What does work: put a real Range on the editable's contents, then dispatch
    // `beforeinput` / `deleteContentBackward` — the one synthetic event Lexical
    // processes as its own deletion.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      this._focusComposer(composer);
      await sleep(attempt === 0 ? 60 : 140);

      this._selectAllInComposer(composer);
      this._dispatchDeleteBackward(composer);
      await sleep(240);

      if (!this.getComposerText()) return true;
    }
    logError('Composer could not be cleared');
    return false;
  }

  /**
   * Put a real selection over the composer's entire contents.
   *
   * The Range must live on a node INSIDE the contenteditable root for Lexical to
   * treat the selection as its own. `document.execCommand('selectAll')` is
   * deliberately not used: see `clearComposer()`.
   *
   * @param {HTMLElement} composer
   * @returns {boolean} whether a non-empty selection was established
   * @private
   */
  _selectAllInComposer(composer) {
    try {
      composer.focus();
      // A real caret first, so Lexical has a selection object to extend.
      document.execCommand('selectAll', false, null);

      if (!String(document.getSelection() || '').length) {
        const sel = document.getSelection();
        if (!sel) return false;
        const range = document.createRange();
        // Selecting a TEXT node's contents (not the element itself) is what
        // makes Lexical read the selection as "the whole paragraph".
        if (!this._selectContentsOfDeepestText(composer, range)) {
          range.selectNodeContents(composer);
        }
        sel.removeAllRanges();
        sel.addRange(range);
      }

      // Let the editor observe the selection before the deletion arrives.
      composer.dispatchEvent(new Event('selectionchange', { bubbles: true }));
      return String(document.getSelection() || '').length > 0;
    } catch (e) {
      return false;
    }
  }

  /**
   * Aim a Range at the deepest text node inside `root`.
   *
   * Selecting the element wrapper is not the same as selecting its text: Lexical
   * resolves the former to a node-level selection and refuses to delete. Pointing
   * the Range at a text node gives it the character offsets it expects.
   *
   * @param {HTMLElement} root
   * @param {Range} range
   * @returns {boolean}
   * @private
   */
  _selectContentsOfDeepestText(root, range) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let last = null;
    let node = walker.nextNode();
    while (node) {
      if (node.nodeValue && node.nodeValue.length) last = node;
      node = walker.nextNode();
    }
    if (!last) return false;
    range.selectNodeContents(last);
    return true;
  }

  /**
   * Dispatch the one synthetic event Lexical honours as a deletion.
   *
   * `targetRanges` must be omitted entirely — constructing one from a live Range
   * throws `TypeError: Failed to convert value to 'StaticRange'`. A synthetic
   * Backspace `KeyboardEvent` is ignored by the editor and does nothing.
   *
   * @param {HTMLElement} composer
   * @returns {boolean} `dispatchEvent`'s return (false when handled)
   * @private
   */
  _dispatchDeleteBackward(composer) {
    try {
      const ev = new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'deleteContentBackward',
        data: null,
      });
      return composer.dispatchEvent(ev);
    } catch (e) {
      return false;
    }
  }

  /**
   * Focus the composer.
   *
   * `focus()` is not always enough: when the box already had DOM focus but the
   * editor's selection was reset (which is what happens after the side panel
   * steals focus and hands it back), Lexical sees no caret and silently ignores
   * every deletion. A click dispatches through the editor's own pointer path and
   * rebuilds the caret.
   *
   * Unlike the round trips this file used to make, everything here is
   * synchronous — Chrome only guarantees the user gesture stays "recent" inside
   * one task, and `document.execCommand` needs that gesture.
   *
   * @param {HTMLElement} composer
   * @private
   */
  _focusComposer(composer) {
    composer.focus();

    const rect = composer.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const base = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: 1,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
    };

    try {
      composer.dispatchEvent(new PointerEvent('pointerdown', base));
      composer.dispatchEvent(new MouseEvent('mousedown', base));
      composer.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0 }));
      composer.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }));
      composer.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0 }));
    } catch (e) {
      /* PointerEvent unavailable — focus() alone will have to do */
    }
  }

  /** @returns {string} the composer's current text */
  getComposerText() {
    const composer = this.getComposer();
    if (!composer) return '';
    // `innerText` is null (not empty) in a detached/hidden subtree, so `||`
    // hands over to `textContent`.
    const raw = composer.innerText || composer.textContent || '';
    // Non-breaking spaces are Lexical's padding, but they are characters with
    // real width — a run of them is a real gap that keeps the bubble off the
    // edge. They must not count as *content*, but they must count as *length*,
    // otherwise a left-aligned incoming message reads as "touching the right
    // edge" and every message is mislabelled as outgoing.
    const text = raw.replace(/ /g, ' ').trim();
    return text || (/^\s+$/.test(raw.replace(/ /g, ' ')) && raw.length ? '' : text);
  }

  /**
   * Locate the composer's send button.
   *
   * Comet renders it ONLY when the composer is non-empty. Before that the same
   * slot holds the voice-message button, so we must never fall back to "any
   * data-tab=11 button" without checking the send icon/aria.
   *
   * @returns {HTMLElement|null}
   */
  getSendButton() {
    const scope = this.getMainPanel() || document;
    const byIcon = scope.querySelector(
      'button [data-icon="wds-ic-send-filled"], button [data-icon="send"], button [data-icon="send-light"]',
    );
    const btn = byIcon ? byIcon.closest('button') : null;
    if (btn instanceof HTMLElement) return btn;

    for (const b of scope.querySelectorAll('button[aria-label], div[role="button"][aria-label]')) {
      const label = (b.getAttribute('aria-label') || '').trim();
      if (label === '发送' || label === 'Send') return b;
    }
    return null;
  }

  /**
   * Click the composer's send button.
   * @returns {Promise<boolean>}
   */
  async clickSend() {
    const btn = this.getSendButton();
    if (!btn) {
      const e = new Error('SEND_BUTTON_NOT_FOUND');
      e.code = ERR.SEND_BUTTON_NOT_FOUND;
      throw e;
    }
    btn.click();
    await sleep(400);
    return true;
  }

  /**
   * Full send path for the composer's current content.
   *
   * NOTE: this method enforces nothing itself — the content script checks that
   * the open chat is still the one the draft was generated for, and the service
   * worker checks that a conversation is open, immediately before calling it.
   * Kept separate so the send guards live in exactly one reviewed place (see
   * service-worker.js `assertSendAllowed` and content-script.js
   * `assertSafeToSend`).
   *
   * @returns {Promise<{ok: boolean}>}
   */
  async sendCurrentMessage() {
    const before = this.getComposerText();
    if (!before) {
      const e = new Error('COMPOSER_EMPTY');
      e.code = 'COMPOSER_EMPTY';
      throw e;
    }
    await this.clickSend();

    // Duplicate-send guard (task §16): the composer must be empty afterwards.
    // If the click did not take (button moved, chat re-rendered, network hiccup)
    // the text is still sitting there — report it instead of silently claiming
    // success, because the caller must never click send twice on the same text.
    await sleep(300);
    const after = this.getComposerText();
    if (after && after === before) {
      logError('Send did not clear the composer');
      const e = new Error('SEND_DID_NOT_SUBMIT');
      e.code = 'SEND_DID_NOT_SUBMIT';
      throw e;
    }
    return { ok: true, submitted: before };
  }

  // ---------------------------------------------------------------------------
  // Diagnostics
  // ---------------------------------------------------------------------------

  /** @returns {object} a compact snapshot used by the side panel "diagnose" path */
  describe() {
    const msgs = this.getLoadedMessages();
    return {
      hasOpenChat: this.hasOpenChat(),
      contactName: this.getCurrentContactName(),
      isGroup: this.isGroupChat(),
      messageCount: msgs.length,
      incoming: msgs.filter((m) => m.direction === 'incoming').length,
      outgoing: msgs.filter((m) => m.direction === 'outgoing').length,
      unknown: msgs.filter((m) => m.direction === 'unknown').length,
      composerFound: !!this.getComposer(),
      sendButtonFound: !!this.getSendButton(),
      contactPanelFound: !!this.getContactPanel(),
    };
  }
}