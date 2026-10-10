#!/usr/bin/env node
'use strict';

/**
 * Dev-only bridge between a Node test script and a live Chrome.
 *
 * Why this exists: Chrome 154 refuses to open a remote-debugging port on the
 * default user-data-dir, and the only WhatsApp session we are allowed to drive
 * lives in exactly that directory (Profile 1). Rather than stand up a second
 * WhatsApp login, the extension itself carries a small dev page
 * (`src/test/bridge.html`) that long-polls this server over loopback and
 * executes commands inside its own realms.
 *
 * Three realms are reachable, and between them they cover everything the old
 * CDP harnesses did:
 *
 *   panel  a hidden-until-needed iframe holding the real sidepanel.html, with
 *          `src/test/panel-probe.classic.js` injected into it. Same origin as
 *          the extension, so the probe shares the panel's global lexical scope
 *          and can reach `insOpen` and friends, which are not on `window`.
 *   self   the bridge page itself, which can `import()` the extension's own
 *          modules and hand them a wrapped `fetch`.
 *   wa     the WhatsApp tab, through `chrome.scripting.executeScript`.
 *
 * Security posture: binds to 127.0.0.1 only, is started on demand by a test
 * script and shut down when it exits. It carries no credentials and never sees
 * an API key — the bridge page talks to the same chrome.storage the extension
 * already uses.
 *
 *   node tools/bridge-server.js            # run standalone, for manual poking
 *   const { Bridge } = require('./bridge-server.js')
 */

const http = require('http');

const DEFAULT_PORT = 8787;
/** How long a `/next` poll may be held before answering 204. */
const LONG_POLL_MS = 25_000;
/**
 * A page is "connected" while it has a poll in flight. Polls are held for
 * LONG_POLL_MS, so the freshness window has to outlast one held poll.
 */
const PAGE_FRESH_MS = LONG_POLL_MS + 5_000;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'cache-control': 'no-store',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Bridge {
  static async start(opts = {}) {
    const bridge = new Bridge(opts);
    await bridge.listen();
    return bridge;
  }

  constructor(opts = {}) {
    this.host = opts.host || '127.0.0.1';
    this.port = Number(opts.port || DEFAULT_PORT);
    this.timeoutMs = Number(opts.timeoutMs || 30_000);

    this._server = null;
    this._nextId = 1;
    /** id -> {resolve, reject, timer} for commands the page has not answered. */
    this._pending = new Map();
    /** Commands waiting for a poll to pick them up. */
    this._queue = [];
    /** The single held `/next` response, if any. */
    this._hold = null;
    this._lastSeen = 0;
    /** Set by the page on every `/next`, so we can report which build is live. */
    this.pageInfo = null;
  }

  get connected() {
    return Date.now() - this._lastSeen < PAGE_FRESH_MS;
  }

  listen() {
    return new Promise((resolve, reject) => {
      this._server = http.createServer((req, res) => {
        try {
          this._route(req, res);
        } catch (err) {
          this._json(res, 500, { error: String((err && err.message) || err) });
        }
      });
      this._server.on('error', reject);
      this._server.listen(this.port, this.host, () => resolve());
    });
  }

  async close() {
    if (this._hold) {
      clearTimeout(this._hold.timer);
      this._json(this._hold.res, 204, null);
      this._hold = null;
    }
    for (const [, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(new Error('bridge closed'));
    }
    this._pending.clear();
    if (!this._server) return;
    await new Promise((resolve) => this._server.close(resolve));
    this._server = null;
  }

  // ---------------------------------------------------------------- commands

  /**
   * Queue a command and resolve with the page's answer.
   *
   * @param {string} op
   * @param {object} [extra]
   */
  send(op, extra = {}) {
    const id = this._nextId++;
    const cmd = Object.assign({ id, op }, extra);

    const answer = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        const why = this.connected
          ? 'the bridge page is connected but did not answer'
          : 'no bridge page is connected — open the dev bridge page in the browser (see AGENTS.md §4)';
        reject(new Error(`bridge command '${op}' timed out after ${this.timeoutMs}ms: ${why}`));
      }, this.timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
    });

    if (this._hold) {
      const held = this._hold;
      this._hold = null;
      clearTimeout(held.timer);
      this._json(held.res, 200, cmd);
    } else {
      this._queue.push(cmd);
    }
    return answer;
  }

  /** Run `fn(...args)` in the panel iframe, via the injected probe. */
  panel(fn, ...args) {
    return this.send('panel', { fn, args });
  }

  /** Run `fn(...args)` in the bridge page's own realm. */
  self(fn, ...args) {
    return this.send('self', { fn, args });
  }

  /** Run `fn(...args)` in the WhatsApp tab, through chrome.scripting. */
  wa(fn, ...args) {
    return this.send('wa', { fn, args });
  }

  /** Load (or reload) the panel iframe and wait for its controller to boot. */
  openPanel() {
    return this.send('openPanel');
  }

  tabs() {
    return this.send('tabs');
  }

  status() {
    return this.send('status');
  }

  // ------------------------------------------------------------------- setup

  /**
   * Block until a bridge page is polling us.
   *
   * @param {number} [timeoutMs]
   */
  async waitForPage(timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.connected) return this.pageInfo || {};
      await sleep(250);
    }
    throw new Error(
      `no bridge page connected on http://${this.host}:${this.port} within ${timeoutMs}ms.\n` +
        '  Open chrome-extension://<id>/src/test/bridge.html in Profile 1 and press Connect.\n' +
        '  See AGENTS.md §4.',
    );
  }

  // ------------------------------------------------------------------ routing

  _route(req, res) {
    const url = new URL(req.url, `http://${this.host}:${this.port}`);
    if (req.method === 'OPTIONS') return this._json(res, 204, null);
    if (url.pathname === '/next') return this._onNext(req, res, url);
    if (url.pathname === '/result') return this._onResult(req, res);
    if (url.pathname === '/health') {
      return this._json(res, 200, {
        ok: true,
        connected: this.connected,
        queued: this._queue.length,
        inFlight: this._pending.size,
        page: this.pageInfo,
      });
    }
    return this._json(res, 404, { error: 'not found' });
  }

  _onNext(req, res, url) {
    this._lastSeen = Date.now();
    const label = url.searchParams.get('page');
    if (label) this.pageInfo = { label, at: this._lastSeen };

    if (this._queue.length) return this._json(res, 200, this._queue.shift());
    // One held poll at a time: the page runs a single loop, so a second
    // concurrent hold would only ever be answered late.
    if (this._hold) return this._json(res, 204, null);

    const timer = setTimeout(() => {
      this._hold = null;
      this._json(res, 204, null);
    }, LONG_POLL_MS);
    this._hold = { res, timer };
  }

  _onResult(req, res) {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) req.destroy();
    });
    req.on('end', () => {
      let msg;
      try {
        msg = JSON.parse(body);
      } catch (err) {
        return this._json(res, 400, { error: 'malformed result body' });
      }
      const entry = this._pending.get(msg.id);
      if (!entry) return this._json(res, 200, { ok: true, note: 'no such command' });
      this._pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.ok) entry.resolve(msg.value === undefined ? null : msg.value);
      else entry.reject(new Error(msg.error || 'the bridge page reported a failure'));
      return this._json(res, 200, { ok: true });
    });
  }

  _json(res, status, body) {
    if (res.writableEnded) return;
    const payload = body === null ? '' : JSON.stringify(body);
    res.writeHead(status, Object.assign({ 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }, CORS));
    res.end(payload);
  }
}

module.exports = { Bridge, DEFAULT_PORT, LONG_POLL_MS };

// Standalone mode: hold the port open so a browser page can attach by hand.
if (require.main === module) {
  const port = Number(process.argv[2] || DEFAULT_PORT);
  Bridge.start({ port }).then(async (bridge) => {
    console.log(`bridge listening on http://127.0.0.1:${port}`);
    console.log('open chrome-extension://<id>/src/test/bridge.html and press Connect');
    process.on('SIGINT', async () => {
      await bridge.close();
      process.exit(0);
    });
    // Keep the process alive; the server alone does that, but be explicit.
    setInterval(() => {}, 1 << 30);
  });
}
