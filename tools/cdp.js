#!/usr/bin/env node
/**
 * Minimal Chrome DevTools Protocol client for real-browser testing.
 *
 * No dependencies — uses the WebSocket implementation built into Node 22+.
 * Connects to an already-running Chrome that was started with
 * --remote-debugging-port, finds tabs by URL, and evaluates JS in them.
 *
 * This tool is part of the verification harness, NOT part of the extension.
 */

const DEFAULT_PORT = 9222;

/**
 * How long to wait for one CDP reply. Overridable because some probes run a
 * batch of real network calls inside a single evaluate() and legitimately take
 * longer than a UI round-trip.
 */
const CDP_TIMEOUT_MS = Number(process.env.CDP_TIMEOUT_MS || 30000);

/** @returns {Promise<Array<object>>} the target list */
async function listTargets(port = DEFAULT_PORT) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  return res.json();
}

/**
 * Find a page target whose URL matches `pattern`.
 * @param {RegExp|string} pattern
 * @param {number} [port]
 * @returns {Promise<object|null>}
 */
async function findTarget(pattern, port = DEFAULT_PORT) {
  const targets = await listTargets(port);
  const re = pattern instanceof RegExp ? pattern : new RegExp(pattern);
  return targets.find((t) => t.type === 'page' && re.test(t.url || '')) || null;
}

/**
 * Open a CDP session against a target and return a small helper API.
 *
 * @param {string} wsUrl
 * @returns {Promise<{send: Function, eval: Function, close: Function}>}
 */
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const events = [];

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', (e) => reject(new Error(`WS error: ${e.message || 'unknown'}`)), { once: true });
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch (e) {
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  });

  /** @param {string} method @param {object} [params] @param {number} [timeoutMs] */
  function send(method, params = {}, timeoutMs = CDP_TIMEOUT_MS) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, timeoutMs);
    });
  }

  /**
   * Evaluate an expression in the page and return its JSON value.
   * Rejections inside the page are surfaced with the page's own error message.
   *
   * @param {string} expression
   * @param {boolean|object} [opts] awaitPromise (legacy: boolean)
   */
  async function evaluate(expression, opts = true) {
    // Backwards compatibility: the second argument used to be a bare boolean.
    const awaitPromise = typeof opts === 'boolean' ? opts : opts.awaitPromise !== false;
    const contextId = typeof opts === 'object' && opts.contextId != null ? opts.contextId : undefined;
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
      ...(contextId != null ? { contextId } : {}),
    });
    if (result.exceptionDetails) {
      const d = result.exceptionDetails;
      const msg = (d.exception && (d.exception.description || d.exception.value)) || d.text;
      throw new Error(`Page exception: ${msg}`);
    }
    return result.result ? result.result.value : undefined;
  }

  /**
   * Find the isolated world a given extension injected into `target`.
   *
   * Content scripts live in an isolated world, so the page's main world can
   * never see `chrome.runtime`. This resolves the world id so tests can talk to
   * the extension the way a human clicking the side panel would.
   *
   * Every extension document shares the same origin, so an origin match alone
   * is not enough: with the side panel open there are ~30 matching contexts and
   * the newest one is a side-panel frame with no content script in it. Each
   * candidate is therefore probed for the adapter global, newest first.
   *
   * @param {string} extensionId
   * @param {string} [probe] expression that must evaluate truthy in the world
   * @returns {Promise<number|null>} context id, or null when not injected
   */
  async function findExtensionWorld(extensionId, probe = 'typeof WhatsAppAdapter') {
    // `Runtime.enable` only *replays* executionContextCreated for contexts that
    // already existed when the session attached — and only if the Runtime domain
    // was not already enabled on this session. connectToPage() enables it, so we
    // disable first to guarantee a fresh replay.
    try {
      await send('Runtime.disable', {});
    } catch (e) {
      /* domain may not have been enabled */
    }
    events.length = 0;
    await send('Runtime.enable', {});
    await new Promise((r) => setTimeout(r, 900));
    const matches = events
      .filter((e) => e.method === 'Runtime.executionContextCreated')
      .map((e) => e.params.context)
      .filter((c) => c.auxData && c.auxData.type === 'isolated' && (c.origin || '') === `chrome-extension://${extensionId}`)
      .sort((a, b) => b.id - a.id);

    for (const c of matches) {
      const r = await evaluate(probe, { contextId: c.id }).catch(() => null);
      if (r && r !== 'undefined' && r !== 'null' && r !== false) return c.id;
    }
    return null;
  }

  return {
    send,
    eval: evaluate,
    findExtensionWorld,
    events,
    close: () => ws.close(),
  };
}

/** Connect to a page target matched by URL pattern. */
async function connectToPage(pattern, port = DEFAULT_PORT) {
  const target = await findTarget(pattern, port);
  if (!target) throw new Error(`No page target matching ${pattern}`);
  const cdp = await connect(target.webSocketDebuggerUrl);
  cdp.target = target;
  await cdp.send('Runtime.enable');
  return cdp;
}

module.exports = { listTargets, findTarget, connect, connectToPage, DEFAULT_PORT };
