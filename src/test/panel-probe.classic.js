/**
 * Probe injected into the side panel by the dev bridge.
 *
 * This is a classic script on purpose. `sidepanel.js` is a classic script too,
 * so its top-level `let`/`const` live in the page's global *lexical* scope —
 * reachable from another script in the same realm, but invisible on `window`.
 * `insOpen` is one of those, and the panel tests need to set it. Injecting a
 * file (rather than evaluating a string) keeps the extension's CSP untouched:
 * module and page script-src stay `'self'` with no `unsafe-eval`.
 *
 * Loaded only by `src/test/bridge.html`, which is loaded only by hand during
 * development. Nothing in the shipped extension references this file.
 *
 * Every function here is called from the bridge as `panel('<name>', ...args)`,
 * so the surface is deliberately flat and JSON-friendly.
 */

/* eslint-env browser */
/* global renderContext, renderInstruction, syncPanesToChat, readChat,
   renderConfig, renderOnboarding, focusSetup, openFollowupConfirm,
   closeFollowupConfirm, describeError, el, cfg, onboarding,
   chatgptStatus, chatgptModels, renderChatGptPanes, renderConnectionPill,
   CONNECTION_MODE */

(function () {
  'use strict';

  /** Ids the panel tests touch, kept in one place so a rename fails loudly. */
  var IDS = {
    add: 'ins-add',
    panel: 'ins-panel',
    box: 'ins-box',
    clear: 'ins-clear',
    done: 'ins-done',
    chip: 'ins-chip',
    chipText: 'ins-chip-text',
    reply: 'reply',
    setup: 'setup',
    quickstart: 'quickstart',
    settings: 'settings',
    suBaseUrl: 'su-baseUrl',
    suApiKey: 'su-apiKey',
    suModel: 'su-model',
    suFallback: 'su-fallback',
    suResult: 'su-result',
    followupConfirm: 'followup-confirm',
    followupGo: 'btn-followup-go',
    followupCancel: 'btn-followup-cancel',
    followup: 'btn-followup',
    generate: 'btn-generate',
    send: 'btn-send',
    blocked: 'blocked',
  };

  function el(id) {
    return document.getElementById(IDS[id] || id);
  }

  /** Is this node actually painted, or merely present and class-hidden? */
  function visible(id) {
    var node = el(id);
    if (!node) return 'MISSING';
    return node.classList.contains('hidden') ? false : getComputedStyle(node).display !== 'none';
  }

  /**
   * The panel's view of the three instruction states, read off the live DOM —
   * visibility, colours, focus and text, in one round trip.
   */
  function snapshot() {
    var box = el('box');
    var reply = el('reply');
    var boxStyle = box ? getComputedStyle(box) : null;
    var replyStyle = reply ? getComputedStyle(reply) : null;
    return {
      add: visible('add'),
      panel: visible('panel'),
      chip: visible('chip'),
      clear: visible('clear'),
      chipText: el('chipText') ? el('chipText').textContent : null,
      boxValue: box ? box.value : null,
      focused: document.activeElement === box,
      maxLength: box ? box.maxLength : null,
      boxColor: boxStyle ? boxStyle.color : null,
      boxBg: boxStyle ? boxStyle.backgroundColor : null,
      boxBorderLeft: boxStyle ? boxStyle.borderLeftColor : null,
      replyValue: reply ? reply.value : null,
      replyColor: replyStyle ? replyStyle.color : null,
      replyBg: replyStyle ? replyStyle.backgroundColor : null,
    };
  }

  /** Height in CSS pixels, or null when the node is absent. */
  function height(id) {
    var node = el(id);
    return node ? node.getBoundingClientRect().height : null;
  }

  function value(id) {
    var node = el(id);
    return node ? node.value : null;
  }

  function caret(id) {
    var node = el(id);
    return node ? node.selectionStart : null;
  }

  function click(id) {
    var node = el(id);
    if (!node) throw new Error('no such element: ' + id);
    node.click();
    return true;
  }

  /** Type into a box the way a person would: set the value, then fire `input`. */
  function type(id, text) {
    var node = el(id);
    if (!node) throw new Error('no such element: ' + id);
    node.value = text;
    node.dispatchEvent(new Event('input', { bubbles: true }));
    return node.value;
  }

  /**
   * What the stand-in reader reports when nothing has been pinned.
   *
   * Shaped like a content-script context with no conversation open rather than
   * `null`, because that is a state the panel genuinely renders and `null` is
   * not.
   */
  var NO_CHAT = {
    hasOpenChat: false,
    chatIdStable: false,
    chatId: '',
    contactName: '',
    phone: '',
    isGroup: false,
    counts: { total: 0, incoming: 0, outgoing: 0 },
  };

  /**
   * The conversation the panel should believe is open, or null for none.
   *
   * The panel re-reads WhatsApp every four seconds. Whatever a caller pins has
   * to survive that poll, and the only way to guarantee it does is to answer the
   * poll from here instead of from the real WhatsApp tab — which, in the profile
   * these tests run in, holds somebody's actual customer.
   */
  var pinnedCtx = null;

  function useStubReader() {
    readChat = async function () {
      return pinnedCtx || NO_CHAT;
    };
  }

  /**
   * Re-assert "a chat is open on this panel" and keep it that way.
   *
   * In the real extension the 4-second poll does this. In the bridge the poll
   * runs too but the worker has no chat to read, so it reports none and
   * correctly collapses the instruction UI. Pinning reproduces the precondition
   * the real poll maintains, without touching the panel's own code.
   */
  async function pinContext(ctx) {
    pinnedCtx = ctx;
    useStubReader();
    await syncPanesToChat(ctx);
    renderContext(ctx);
    await renderInstruction();
    return true;
  }

  /**
   * Stop the panel's context poll dead.
   *
   * `readChat` is a function declaration, so replacing it on the global object
   * is what the polling loop will call next. Returning null leaves the panel in
   * whatever state the caller last rendered; prefer `stubChat` or `pinContext`,
   * which keep the poll answering coherently.
   */
  function silencePoll() {
    readChat = async function () {
      return null;
    };
    return true;
  }

  /**
   * Freeze the panel onto one invented conversation.
   *
   * The context poll re-reads WhatsApp every four seconds, so a context handed
   * in by hand would last only until the next tick — and in the profile these
   * tests run in, that tick would return somebody's real customer. Substituting
   * `readChat` itself, rather than the render calls it feeds, makes the invented
   * chat the panel's steady state: every later tick returns the same object,
   * `syncPanesToChat` sees an unchanged chat id and leaves the draft and
   * instruction alone.
   *
   * @param {object} ctx a content-script chat context
   */
  function stubChat(ctx) {
    pinnedCtx = ctx;
    useStubReader();
    return true;
  }

  /**
   * Resolve once the panel's `init()` has finished.
   *
   * `ready()` only says the controller's functions exist; `init()` is still
   * awaiting the service worker and then reads the conversation. That read lands
   * *after* a test has pinned its own context, and it is what used to bind these
   * tests to whichever chat the real WhatsApp tab happened to have open.
   */
  function whenInitDone(timeoutMs) {
    var deadline = Date.now() + (timeoutMs || 15000);
    return new Promise(function (resolve, reject) {
      (function tick() {
        if (pollTimer) return resolve(true);
        if (Date.now() > deadline) return reject(new Error('the panel never finished initialising'));
        setTimeout(tick, 50);
      })();
    });
  }

  /**
   * Cut the panel loose from the conversation the real WhatsApp tab has open.
   *
   * This has to happen before any test pins a context of its own, for two
   * reasons that both involve damaging the person's actual data:
   *
   *   - pinning flushes the draft of the chat being left. Were the *real* chat
   *     still bound, that flush would write an empty reply box over whatever
   *     they had half-typed for a customer.
   *   - the real chat's stored instruction would be loaded into the very box
   *     the next assertion is about to read.
   *
   * `currentChatId` is emptied rather than pointed elsewhere because
   * `syncPanesToChat` returns early on an empty id, which is what makes that
   * flush a no-op. The draft and instruction caches are dropped so the next
   * read comes from storage rather than from whatever was loaded at boot.
   */
  function detachChat() {
    pinnedCtx = null;
    useStubReader();
    currentChatId = '';
    current = null;
    drafts = null;
    instructions = null;
    el('reply').value = '';
    draftState = '';
    updateReplyMeta();
    renderContext(NO_CHAT);
    return renderInstruction().then(function () {
      return true;
    });
  }

  /**
   * The panel's editor-open flag.
   *
   * Named `getInsOpen` rather than `insOpen`: a function declaration called
   * `insOpen` would shadow the outer lexical binding it is trying to read and
   * return itself.
   */
  function getInsOpen() {
    return insOpen;
  }

  function setInsOpen(next) {
    insOpen = !!next;
    return insOpen;
  }

  /** Read the persisted instruction and draft stores straight from chrome.storage. */
  function readStore(keys) {
    var wanted = keys || ['instructions', 'drafts'];
    return new Promise(function (resolve) {
      chrome.storage.local.get(wanted, function (got) {
        resolve(got || {});
      });
    });
  }

  function removeStore(keys) {
    var wanted = [].concat(keys);
    return new Promise(function (resolve) {
      chrome.storage.local.remove(wanted, function () {
        resolve(true);
      });
    });
  }

  /** True once sidepanel.js has finished evaluating. */
  function ready() {
    return (
      typeof renderInstruction === 'function' &&
      typeof syncPanesToChat === 'function' &&
      typeof renderContext === 'function' &&
      typeof renderOnboarding === 'function'
    );
  }

  /**
   * Call one of the panel's own top-level functions by name.
   *
   * They are function declarations in a classic script, so they really are
   * properties of the global object — this reaches them without an `eval`,
   * which the extension's CSP would refuse anyway.
   */
  function callGlobal(name, args) {
    var fn = window[name];
    if (typeof fn !== 'function') throw new Error('no such panel function: ' + name);
    return fn.apply(null, args || []);
  }

  /**
   * Drop the panel's in-memory copy of the instruction store.
   *
   * `loadInstructions` memoises, so removing the stored key alone leaves the
   * old object live in `instructions` and the next render still sees it.
   */
  function resetInstructionCache() {
    instructions = null;
    return true;
  }

  /**
   * Why a test can look like it is asserting against a stale panel.
   *
   * `timeOrigin` is fixed for the lifetime of a document, so comparing it across
   * two calls answers the only question that matters when a snapshot contradicts
   * the storage it was just read from: did the page actually reload, or is this
   * the same controller with leftover state?
   */
  function diag() {
    return {
      href: location.href,
      timeOrigin: performance.timeOrigin,
      readyState: document.readyState,
      insOpen: insOpen,
      currentChatId: currentChatId,
      hasProbe: true,
    };
  }

  /**
   * What the panel looks like *around* the reply box: which of the first-run
   * screens is up, what the buttons say, what the user is being told.
   *
   * This is the copy the product is judged on, so the tests assert on it
   * directly rather than on the constants behind it.
   */
  function ui() {
    function text(id) {
      var node = el(id);
      return node ? (node.textContent || '').replace(/\s+/g, ' ').trim() : null;
    }
    function disabled(id) {
      var node = el(id);
      return node ? !!node.disabled : null;
    }
    return {
      setup: visible('setup'),
      quickstart: visible('quickstart'),
      settings: visible('settings'),
      setupTitle: text('setup') === null ? null : text('setup').slice(0, 60),
      suBaseUrl: value('suBaseUrl'),
      suApiKey: value('suApiKey'),
      suApiKeyPlaceholder: (function () {
        var n = el('suApiKey');
        return n ? n.placeholder : null;
      })(),
      suModel: value('suModel'),
      suFallback: value('suFallback'),
      suResult: text('suResult'),
      followupConfirm: visible('followupConfirm'),
      followupRecipient: text('fu-recipient'),
      followupTitle: text('fu-title'),
      followupLabel: text('followup'),
      followupDisabled: disabled('followup'),
      generateDisabled: disabled('generate'),
      sendDisabled: disabled('send'),
      blocked: text('blocked'),
      replyMeta: text('reply'),
    };
  }

  /**
   * Replace the panel's idea of the stored configuration, without touching
   * chrome.storage.
   *
   * The first-run screens are driven entirely by the config the worker returns,
   * so this exercises the real render path while leaving the profile's actual
   * provider, key and model exactly where they were. No test should ever have to
   * blank a real API key to see the welcome screen.
   *
   * @param {object} c a public config shape, partial
   */
  function overrideConfig(c) {
    cfg = Object.assign({}, cfg, c);
    renderConfig(cfg);
    return cfg;
  }

  /** Put the panel back on the real stored configuration. */
  function restoreConfig() {
    return chrome.runtime
      .sendMessage({ type: MSG.GET_AI_CONFIG })
      .then(function (res) {
        if (res && res.ok) renderConfig(res.config);
        return !!res && res.ok;
      });
  }

  /**
   * Show a ChatGPT-connection state the panel would otherwise only reach with a
   * real helper running and a real account signed in.
   *
   * Documentation needs the connected view; producing it must not require an
   * account, and must not put one anywhere near a screenshot. Nothing is faked
   * in the markup — the panel renders from these values exactly as it does from
   * the helper's answer, so the picture is still the real UI.
   *
   * `chatgptStatus` and `chatgptModels` are top-level `let` bindings in
   * sidepanel.js, which is why this file has to be a classic script: they live
   * in the global lexical scope and are reachable from here by name, but they
   * are not properties of `window`.
   *
   * @param {object|null} status the shape the worker's CHATGPT_STATUS returns
   * @param {Array} models the shape GET /models returns
   */
  function overrideChatGptStatus(status, models) {
    chatgptStatus = status;
    chatgptModels = models || [];
    renderChatGptPanes({ resetModels: true });
    renderConnectionPill();
    return chatgptStatus;
  }

  /**
   * Remove a few chat ids from the draft and instruction stores.
   *
   * Deliberately surgical where `removeStore` is not: these tests run against
   * the profile a person actually sells from, so clearing a whole store to get a
   * clean slate would take their real notes with it. Only the synthetic ids the
   * tests invent are dropped.
   */
  function dropChatKeys(ids) {
    var wanted = [].concat(ids);
    return chrome.storage.local.get(['instructions', 'drafts']).then(function (got) {
      var patch = {};
      ['instructions', 'drafts'].forEach(function (name) {
        var store = Object.assign({}, got[name] || {});
        var changed = false;
        wanted.forEach(function (id) {
          if (store[id]) {
            delete store[id];
            changed = true;
          }
        });
        if (changed) patch[name] = store;
      });
      // Drop the panel's own caches too. They were filled at boot, so clearing
      // storage alone would leave the panel still rendering the previous run's
      // instruction until something happened to reload it. The pending debounce
      // is cancelled for the same reason: it would otherwise write the stale
      // text back a second later.
      if (insTimer) {
        clearTimeout(insTimer);
        insTimer = null;
      }
      instructions = null;
      drafts = null;

      if (!Object.keys(patch).length) return true;
      return chrome.storage.local.set(patch).then(function () {
        return true;
      });
    });
  }

  /** The first-run flags actually sitting in storage. */
  function onboardingState() {
    return chrome.storage.local.get('onboarding').then(function (got) {
      return (got && got.onboarding) || {};
    });
  }

  window.__probe = {
    IDS: IDS,
    ready: ready,
    diag: diag,
    ui: ui,
    overrideConfig: overrideConfig,
    restoreConfig: restoreConfig,
    overrideChatGptStatus: overrideChatGptStatus,
    onboardingState: onboardingState,
    focusSetup: focusSetup,
    openFollowupConfirm: openFollowupConfirm,
    closeFollowupConfirm: closeFollowupConfirm,
    describeError: describeError,
    snapshot: snapshot,
    height: height,
    value: value,
    caret: caret,
    click: click,
    type: type,
    pinContext: pinContext,
    silencePoll: silencePoll,
    stubChat: stubChat,
    whenInitDone: whenInitDone,
    detachChat: detachChat,
    dropChatKeys: dropChatKeys,
    insOpen: getInsOpen,
    setInsOpen: setInsOpen,
    readStore: readStore,
    removeStore: removeStore,
    callGlobal: callGlobal,
    resetInstructionCache: resetInstructionCache,
  };
})();
