/**
 * Dev bridge — the browser half.
 *
 * Long-polls `tools/bridge-server.js` on loopback for commands and runs them in
 * one of three realms, then posts the answer back:
 *
 *   panel  the real side panel, in the iframe next to this page, driven through
 *          `panel-probe.classic.js`
 *   self   this page, which can import the extension's own modules
 *   wa     the WhatsApp tab, through chrome.scripting
 *
 * Why not CDP: Chrome 154 refuses a remote-debugging port on the default
 * user-data-dir, and the only WhatsApp session we may drive lives there. See
 * AGENTS.md §2 and §4.
 *
 * Peripheral to the extension: nothing in the manifest references this file,
 * and no extension code imports it.
 */

const params = new URLSearchParams(location.search);
const PORT = Number(params.get('port') || 8787);
// `localhost`, not `127.0.0.1`: this page may only reach an origin the manifest
// declares, and the manifest declares the one loopback pattern that also has a
// user-facing reason to exist (a model server on the user's own machine). The
// server still binds to loopback only — see tools/bridge-server.js.
const ENDPOINT = `http://localhost:${PORT}`;
const ORIGIN_PATTERN = 'http://localhost/*';
const PANEL_PATH = 'src/sidepanel/sidepanel.html';
const PROBE_PATH = 'src/test/panel-probe.classic.js';
const PAGE_LABEL = 'bridge';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const el = {
  state: document.getElementById('state'),
  connect: document.getElementById('connect'),
  log: document.getElementById('log'),
  frame: document.getElementById('panel-frame'),
};

let running = false;

// ------------------------------------------------------------------- chrome

function setState(text, cls) {
  el.state.textContent = text;
  el.state.className = cls;
}

function log(text, cls = '') {
  const at = new Date().toLocaleTimeString('en-GB', { hour12: false });
  const line = document.createElement('div');
  const stamp = document.createElement('span');
  stamp.className = 't';
  stamp.textContent = `${at} `;
  const body = document.createElement('span');
  body.className = cls;
  body.textContent = text;
  line.append(stamp, body);
  el.log.append(line);
  el.log.scrollTop = el.log.scrollHeight;
}

/** Never let a rejection escape into the console as an unhandled promise. */
const swallow = (err) => log(String((err && err.message) || err), 'e');

// --------------------------------------------------------------- panel realm

function panelWindow() {
  const win = el.frame.contentWindow;
  if (!win) throw new Error('the panel iframe has no window yet');
  return win;
}

function whenLoaded(frame) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      frame.removeEventListener('load', onLoad);
      reject(new Error('the panel iframe did not finish loading within 15s'));
    }, 15_000);
    function onLoad() {
      clearTimeout(timer);
      frame.removeEventListener('load', onLoad);
      resolve();
    }
    frame.addEventListener('load', onLoad);
  });
}

/**
 * Inject the probe as a file rather than evaluating a string.
 *
 * The extension's CSP is `script-src 'self'` with no `unsafe-eval`, so a string
 * would be blocked — and loosening the CSP for a test tool would be the wrong
 * trade. A same-origin script file is allowed, and because it is a classic
 * script it shares the panel's global lexical scope, which is the only way to
 * reach `insOpen`.
 */
function injectProbe(frame) {
  return new Promise((resolve, reject) => {
    const doc = frame.contentDocument;
    if (!doc) return reject(new Error('the panel iframe has no document'));
    const script = doc.createElement('script');
    script.src = chrome.runtime.getURL(PROBE_PATH);
    script.onload = () => resolve(true);
    script.onerror = () => reject(new Error(`could not load ${PROBE_PATH} — is it blocked by the extension CSP?`));
    (doc.head || doc.documentElement).appendChild(script);
  });
}

/**
 * Load a fresh panel and wait until its controller is live.
 *
 * Reloading has to go through about:blank: assigning the same src twice does
 * not necessarily navigate, so a second `openPanel` would silently reuse the
 * previous page's state.
 */
async function openPanel() {
  const frame = el.frame;
  const target = chrome.runtime.getURL(PANEL_PATH);

  if (frame.contentWindow && frame.contentWindow.location.href === target) {
    frame.contentWindow.location.reload();
  } else {
    frame.src = 'about:blank';
    await whenLoaded(frame);
    frame.src = target;
  }
  await whenLoaded(frame);
  await injectProbe(frame);

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const probe = panelWindow().__probe;
    if (probe && probe.ready && probe.ready()) {
      log('panel ready');
      return true;
    }
    await sleep(100);
  }
  throw new Error('the panel controller did not initialise');
}

function callPanel(fn, args) {
  const probe = panelWindow().__probe;
  if (!probe) throw new Error('the panel probe is not injected — run openPanel first');
  const impl = probe[fn];
  if (typeof impl !== 'function') {
    throw new Error(`no such panel probe function: ${fn} (have: ${Object.keys(probe).join(', ')})`);
  }
  return impl.apply(probe, args);
}

// ---------------------------------------------------------------- self realm

/**
 * A few things are easier from the bridge page itself than from the panel —
 * mainly anything that wants to import an extension module.
 */
const selfOps = {
  ping: () => 'pong',

  info: () => ({
    id: chrome.runtime.id,
    version: chrome.runtime.getManifest().version,
    href: location.href,
  }),

  /** Relay a message to the background worker, exactly as the panel would. */
  runtimeMessage: (msg) => chrome.runtime.sendMessage(msg),

  storageGet: (keys) =>
    new Promise((resolve) => chrome.storage.local.get(keys, (got) => resolve(got || {}))),

  storageSet: (obj) =>
    new Promise((resolve) => chrome.storage.local.set(obj, () => resolve(true))),

  storageRemove: (keys) =>
    new Promise((resolve) => chrome.storage.local.remove(keys, () => resolve(true))),

  /**
   * Reload the extension — the same thing the ⟳ button on chrome://extensions
   * does, and the only way to pick up an edited source file.
   *
   * Deferred by a tick so the command's own answer reaches the test server
   * before this page is torn down; the page then reloads itself and reconnects
   * to whatever server is listening next.
   */
  reloadExtension: () => {
    setTimeout(() => chrome.runtime.reload(), 200);
    return true;
  },

  /**
   * Make one real AI call through the extension's own `generateReply`, and
   * return the request body it produced.
   *
   * `fetch` is wrapped for the duration so the body can be read without CDP.
   * The wrapper records the URL and body only — request headers, which carry
   * the Authorization header, are deliberately not captured or returned, and
   * nothing here is written to storage or to the console.
   */
  async aiReply(ctx) {
    const mod = await import(chrome.runtime.getURL('src/ai/ai-client.js'));
    const realFetch = globalThis.fetch;
    const captured = [];

    globalThis.fetch = async (url, init) => {
      const body = init && typeof init.body === 'string' ? init.body : init && init.body ? String(init.body) : '';
      captured.push({ url: String(url), body });
      return realFetch(url, init);
    };

    let answer = null;
    let failure = null;
    try {
      const out = await mod.generateReply(ctx);
      answer = { ok: true, text: out.text, model: out.model, elapsedMs: out.elapsedMs, usedFallback: !!out.usedFallback };
    } catch (err) {
      answer = { ok: false, code: (err && err.code) || (err && err.message) || 'UNKNOWN' };
      failure = String((err && err.message) || err);
    } finally {
      globalThis.fetch = realFetch;
    }

    const chat = captured.find((c) => /\/chat\/completions/.test(c.url)) || captured[0] || null;
    return Object.assign(answer, {
      url: chat ? chat.url : null,
      body: chat ? chat.body : null,
      calls: captured.length,
      error: failure,
    });
  },
};

// ------------------------------------------------------------------ wa realm

/** Tabs, with titles omitted — they are not needed and are none of our business. */
async function listTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.map((t) => ({ id: t.id, url: t.url, active: t.active, windowId: t.windowId }));
}

/**
 * What the WhatsApp page looks like from the extension's isolated world.
 *
 * The injected function must be self-contained: it is serialised and run in the
 * page, so it cannot close over anything from this file.
 */
function collectWhatsApp(sampleCount) {
  const composer = document.querySelector('[data-testid="conversation-compose-box-input"]');
  const rows = Array.from(document.querySelectorAll('[data-testid="msg-container"]'));
  const composerText = composer ? composer.innerText || composer.textContent || '' : null;
  const sendButton = Array.from(document.querySelectorAll('button[aria-label]')).some((b) =>
    ['Send', '发送'].includes(b.getAttribute('aria-label')),
  );
  return {
    composerChars: composerText === null ? null : composerText.replace(/\n/g, '').length,
    sendButtonVisible: sendButton,
    messageCount: rows.length,
    last: rows.slice(-Math.max(1, sampleCount)).map((row) => {
      const text = row.querySelector('[data-testid="selectable-text"]');
      return {
        dir: row.querySelector('[data-testid="tail-out"]') ? 'out' : row.querySelector('[data-testid="tail-in"]') ? 'in' : '?',
        text: text ? text.innerText : '',
      };
    }),
  };
}

async function callWa(fn, args) {
  if (fn !== 'whatsappDom') throw new Error(`no such wa operation: ${fn}`);
  const tabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
  if (!tabs.length) throw new Error('no WhatsApp Web tab is open');
  const results = await chrome.scripting.executeScript({
    target: { tabId: tabs[0].id },
    func: collectWhatsApp,
    args: [Number(args[0] || 3)],
  });
  const first = results && results[0];
  if (!first) throw new Error('the WhatsApp page returned nothing');
  if (first.error) throw new Error(String(first.error.message || first.error));
  return first.result;
}

// ------------------------------------------------------------------ dispatch

async function dispatch(cmd) {
  switch (cmd.op) {
    case 'ping':
      return 'pong';
    case 'status':
      return {
        id: chrome.runtime.id,
        href: location.href,
        panelReady: !!(el.frame.contentWindow && el.frame.contentWindow.__probe),
        tabCount: (await chrome.tabs.query({})).length,
      };
    case 'tabs':
      return listTabs();
    case 'openPanel':
      return openPanel();
    case 'panel':
      return callPanel(cmd.fn, cmd.args || []);
    case 'self': {
      const impl = selfOps[cmd.fn];
      if (typeof impl !== 'function') throw new Error(`no such self operation: ${cmd.fn}`);
      return impl.apply(selfOps, cmd.args || []);
    }
    case 'wa':
      return callWa(cmd.fn, cmd.args || []);
    default:
      throw new Error(`unknown bridge op: ${cmd.op}`);
  }
}

// ------------------------------------------------------------------ the loop

async function poll() {
  while (running) {
    let res;
    try {
      res = await fetch(`${ENDPOINT}/next?page=${PAGE_LABEL}`, { cache: 'no-store' });
    } catch (err) {
      // Normal between runs: the test script starts the server, and it is not
      // running right now. Not an error, so it does not go red.
      setState('waiting for the test script', 'connect');
      await sleep(1000);
      continue;
    }
    if (res.status === 204) {
      setState('connected', 'ok');
      continue;
    }
    if (!res.ok) {
      setState(`server said HTTP ${res.status}`, 'bad');
      await sleep(1000);
      continue;
    }

    let cmd;
    try {
      cmd = await res.json();
    } catch (err) {
      continue;
    }
    setState('connected', 'ok');

    let payload;
    try {
      payload = { id: cmd.id, ok: true, value: await dispatch(cmd) };
      if (cmd.op !== 'ping') log(`ok  ${cmd.op}${cmd.fn ? `:${cmd.fn}` : ''}`);
    } catch (err) {
      const message = String((err && err.message) || err);
      payload = { id: cmd.id, ok: false, error: message };
      log(`err ${cmd.op}${cmd.fn ? `:${cmd.fn}` : ''} — ${message}`, 'e');
    }

    try {
      await fetch(`${ENDPOINT}/result`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      // The answer is lost; the Node side reports it as a timeout.
      log('could not return the result', 'e');
    }
  }
}

async function hasPermission() {
  try {
    return await chrome.permissions.contains({ origins: [ORIGIN_PATTERN] });
  } catch (err) {
    return false;
  }
}

async function start() {
  if (running) return;
  running = true;
  el.connect.hidden = true;
  setState('connecting', 'connect');
  log(`polling ${ENDPOINT}`);
  poll().catch(swallow);
}

/**
 * One-time, user-gesture grant of `http://localhost/*`.
 *
 * That origin is already declared in `optional_host_permissions`, so granting
 * it changes nothing the extension can reach beyond the loopback server. Once
 * granted it persists for the profile, so this button is a one-off.
 */
el.connect.addEventListener('click', async () => {
  try {
    const granted = await chrome.permissions.request({ origins: [ORIGIN_PATTERN] });
    if (!granted) {
      setState('permission refused', 'bad');
      return;
    }
    log(`granted ${ORIGIN_PATTERN}`);
    await start();
  } catch (err) {
    swallow(err);
    setState('permission failed', 'bad');
  }
});

(async () => {
  log(`extension ${chrome.runtime.id}`);
  if (await hasPermission()) {
    await start();
  } else {
    setState('needs permission', 'connect');
    el.connect.hidden = false;
    log(`this page needs ${ORIGIN_PATTERN} to reach the test server — press the button once`);
  }
  // Leave the panel empty until a test asks for one: a panel loaded now would
  // boot against whatever WhatsApp happens to be showing and make the first
  // assertion depend on timing.
  el.frame.src = 'about:blank';
})().catch(swallow);
