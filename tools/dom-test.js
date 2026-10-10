/**
 * Exercise adapter-level DOM operations through the extension's own paths.
 *
 * The content script is only reachable the way the service worker reaches it
 * (`chrome.tabs.sendMessage` from the background), so that is exactly what this
 * tool uses — a lower-level probe would not prove the real path works.
 *
 * Usage:
 *   node tools/dom-test.js SET_TEXT "some text"
 *   node tools/dom-test.js CLEAR
 *   node tools/dom-test.js DOM
 */

const { connectToPage } = require('./cdp.js');
const { extensionIdFor, REPO_ROOT } = require('./compute-extension-id.js');

// Derived from the repository's own path, the same way Chrome derives it, so
// there is no machine-specific id baked into the source.
const EXT_ID = process.env.WA_EXT_ID || extensionIdFor(REPO_ROOT);

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const c = await connectToPage(/web\.whatsapp\.com/);
  const world = await c.findExtensionWorld(EXT_ID);
  if (world == null) throw new Error('content-script world not found');

  /** Ask the background worker to relay a message to the content script. */
  async function probe(kind, extra = {}) {
    return c.eval(
      `chrome.runtime.sendMessage(${JSON.stringify({ type: 'WA_FOLLOWUP_DOM_PROBE', kind, arg, ...extra })})
         .then(x => JSON.stringify(x)).catch(e => JSON.stringify({ __err: String(e) }))`,
      { contextId: world },
    );
  }

  if (cmd === 'SET_TEXT') console.log('setComposerText →', await probe('SET_TEXT', { text: arg }));
  if (cmd === 'CLEAR') console.log('clearComposer  →', await probe('CLEAR'));

  console.log(
    await c.eval(`(() => {
    const el = document.querySelector('[data-testid="conversation-compose-box-input"]');
    const rows = [...document.querySelectorAll('[data-testid="msg-container"]')];
    const txt = el ? (el.innerText || el.textContent || '') : null;
    return JSON.stringify({
      composerChars: txt ? txt.replace(/\\n/g, '').length : null,
      sendButtonVisible: !!(document.querySelector('[data-icon="wds-ic-send-filled"]') ||
        [...document.querySelectorAll('button[aria-label]')].some(b => ['发送', 'Send'].includes(b.getAttribute('aria-label')))),
      messageCount: rows.length,
      lastThree: rows.slice(-3).map(r => ({
        dir: r.querySelector('[data-testid="tail-out"]') ? 'out' : (r.querySelector('[data-testid="tail-in"]') ? 'in' : '?'),
        text: (r.querySelector('[data-testid="selectable-text"]') || {}).innerText || '',
      })),
    }, null, 1);
  })()`),
  );
  c.close();
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
