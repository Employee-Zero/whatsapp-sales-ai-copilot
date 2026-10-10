/**
 * Click an element in the WhatsApp Web tab using REAL CDP mouse events.
 *
 * `el.click()` is not enough: WhatsApp's Comet UI opens chats / drawers through
 * pointer-event handlers, so a synthetic `.click()` leaves the pane unchanged.
 *
 * Usage: node tools/click.js <css-selector>            # by selector
 *        node tools/click.js --text "+86 138 0013 8000" # by visible text
 *        node tools/click.js --list                    # dump open-chat state
 */

const { listTargets, connect } = require('./cdp.js');

async function mousePoint(cdp, expression) {
  return cdp.eval(`(() => {
    const el = ${expression};
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
}

async function clickAt(cdp, p) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none', clickCount: 0 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
}

async function main() {
  const args = process.argv.slice(2);
  const targets = await listTargets();
  const wa = targets.find((t) => t.type === 'page' && /web\.whatsapp\.com/.test(t.url || ''));
  if (!wa) throw new Error('WhatsApp Web tab not found');
  const cdp = await connect(wa.webSocketDebuggerUrl);

  if (args[0] === '--list') {
    const state = await cdp.eval(`(() => ({
      intro: !!document.querySelector('[data-testid="intro-panel"]'),
      composer: !!document.querySelector('[data-testid="conversation-compose-box-input"]'),
      header: document.querySelector('[data-testid="conversation-header"]') ? document.querySelector('[data-testid="conversation-header"]').innerText : null,
      messages: document.querySelectorAll('[data-testid="msg-container"]').length,
    }))()`);
    console.log(JSON.stringify(state, null, 2));
    cdp.close();
    return;
  }

  let expr;
  if (args[0] === '--text') {
    expr = `[...document.querySelectorAll('#pane-side [role="row"]')].find(r => (r.innerText||'').includes(${JSON.stringify(args[1])}))`;
  } else {
    expr = `document.querySelector(${JSON.stringify(args[0])})`;
  }

  const p = await mousePoint(cdp, expr);
  if (!p) throw new Error('element not found / zero-size');
  await clickAt(cdp, p);
  await new Promise((r) => setTimeout(r, 1200));

  const after = await cdp.eval(`(() => ({
    composer: !!document.querySelector('[data-testid="conversation-compose-box-input"]'),
    header: document.querySelector('[data-testid="conversation-header"]') ? document.querySelector('[data-testid="conversation-header"]').innerText.split('\\n')[0] : null,
    messages: document.querySelectorAll('[data-testid="msg-container"]').length,
  }))()`);
  console.log('clicked at', p, '→', JSON.stringify(after));
  cdp.close();
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
