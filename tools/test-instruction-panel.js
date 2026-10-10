#!/usr/bin/env node
/**
 * Live verification of the per-chat instruction UI, driven through the real
 * panel page in a real Chrome.
 *
 * The panel is loaded for real — same HTML, same CSS, same controller — inside
 * an iframe on the extension's own dev bridge page. The bridge's probe file
 * shares the panel's realm, so clicks, typing, storage and computed styles are
 * all the genuine article; only the chat context is handed in directly, because
 * the bridge has no WhatsApp conversation to read.
 *
 * This used to run over CDP. Chrome 154 will not open a debugging port on the
 * default user-data-dir, which is where the only usable WhatsApp session lives,
 * so it now runs over the bridge instead. See AGENTS.md §4.
 *
 *   node tools/bridge-server.js          # in one terminal, if you want the page
 *   node tools/test-instruction-panel.js # starts its own server by default
 */

const { Bridge } = require('./bridge-server.js');

const PORT = Number(process.env.BRIDGE_PORT || 8787);

const CHAT_A = 'dm:8613800138000';
const CHAT_B = 'dm:551191234567';

function ctxFor(chatId, name) {
  return {
    hasOpenChat: true,
    chatId,
    chatIdStable: true,
    chatKey: `${name}|dm|anchor|17`,
    contactName: name,
    phone: '',
    phoneStatus: 'hidden',
    isGroup: false,
    loadedInDom: 13,
    counts: { total: 17, incoming: 6, outgoing: 11, unknown: 0 },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? `  → ${detail}` : ''}`);
  }
}

(async () => {
  const bridge = await Bridge.start({ port: PORT });
  /** @type {import('./bridge-server.js').Bridge} */
  const page = bridge;

  await page.waitForPage(Number(process.env.BRIDGE_WAIT_MS || 60_000));
  await page.openPanel();

  // Wait for `init()` to finish, then unhook the panel from the conversation the
  // real WhatsApp tab has open. Without this the panel boots bound to a real
  // customer: their stored instruction would be loaded into the box the first
  // assertion reads, and the first pin would flush an empty reply box over
  // whatever draft the person had half-written for them.
  await page.panel('whenInitDone');
  await page.panel('detachChat');

  const pin = (ctx) => page.panel('pinContext', ctx);
  const store = async () => (await page.panel('readStore', ['instructions'])).instructions || {};

  // Only the ids these tests invent are cleared — never the person's own notes.
  await page.panel('dropChatKeys', [CHAT_A, CHAT_B]);

  console.log('\n[A] reaching a chat\n');
  await pin(ctxFor(CHAT_A, 'Alice'));
  let s = await page.panel('snapshot');
  check('with no instruction written, only the add row shows', s.add === true && s.panel === false && s.chip === false, JSON.stringify(s));
  check('the add row is the slim empty state', (await page.panel('height', 'add')) <= 32);
  check('the textarea enforces the stored limit', s.maxLength === 1000, String(s.maxLength));

  console.log('\n[B] opening the editor\n');
  await pin(ctxFor(CHAT_A, 'Alice'));
  await page.panel('click', 'add');
  await sleep(300);
  s = await page.panel('snapshot');
  check('the editor opens', s.panel === true && s.add === false && s.chip === false, JSON.stringify(s));
  check('and takes focus', s.focused === true);
  check('Clear is hidden while the box is empty', s.clear === false);

  console.log('\n[C] the instruction is amber, the reply is not\n');
  check('the instruction box is amber-on-amber', s.boxColor === 'rgb(122, 60, 5)' && s.boxBg === 'rgb(255, 250, 235)', `${s.boxColor} on ${s.boxBg}`);
  check('with the amber left rule', s.boxBorderLeft === 'rgb(240, 162, 2)', s.boxBorderLeft);
  check(
    'and the reply box looks nothing like it',
    s.replyBg !== s.boxBg && s.replyColor !== s.boxColor,
    `reply ${s.replyColor} on ${s.replyBg}`,
  );

  console.log('\n[D] typing persists per chat\n');
  await pin(ctxFor(CHAT_A, 'Alice'));
  await page.panel('click', 'add');
  await sleep(250);
  await page.panel('type', 'box', 'Ask how the trial installation went.');
  await sleep(150);
  s = await page.panel('snapshot');
  check('Clear appears as soon as there is text', s.clear === true);
  await sleep(500);
  let saved = await store();
  check(
    'the debounce wrote it to storage',
    saved[CHAT_A] && saved[CHAT_A].text === 'Ask how the trial installation went.',
    JSON.stringify(saved),
  );

  console.log('\n[E] closing collapses it to a readable chip\n');
  await pin(ctxFor(CHAT_A, 'Alice'));
  await page.panel('click', 'done');
  await sleep(300);
  s = await page.panel('snapshot');
  check('the editor closes', s.panel === false && s.add === false, JSON.stringify(s));
  check('the chip shows', s.chip === true);
  check('carrying the instruction text verbatim', s.chipText === 'Ask how the trial installation went.', s.chipText);
  const chipH = await page.panel('height', 'chip');
  check('and stays compact', chipH > 0 && chipH < 60, `${Math.round(chipH)}px`);

  console.log('\n[F] the chip reopens the editor\n');
  await pin(ctxFor(CHAT_A, 'Alice'));
  await page.panel('click', 'chip');
  await sleep(300);
  s = await page.panel('snapshot');
  check('the editor comes back with the text', s.panel === true && s.boxValue === 'Ask how the trial installation went.', JSON.stringify(s));
  check('focused, caret at the end', s.focused === true && (await page.panel('caret', 'box')) === s.boxValue.length);

  console.log('\n[G] a chat switch carries the instruction with it\n');
  await pin(ctxFor(CHAT_B, 'Someone else'));
  s = await page.panel('snapshot');
  check('the other chat starts empty', s.add === true && s.boxValue === '' && s.chip === false, JSON.stringify(s));
  saved = await store();
  check('and the first chat kept its instruction', (saved[CHAT_A] || {}).text === 'Ask how the trial installation went.', JSON.stringify(saved));
  await page.panel('click', 'add');
  await sleep(250);
  await page.panel('type', 'box', 'Mention the 3-year warranty.');
  await sleep(550);
  await page.panel('click', 'done');
  await sleep(250);
  saved = await store();
  check('two chats, two instructions', Object.keys(saved).length === 2, JSON.stringify(saved));

  console.log('\n[H] switching back restores the right one\n');
  await pin(ctxFor(CHAT_A, 'Alice'));
  s = await page.panel('snapshot');
  check('the chip shows chat A again', s.chip === true && s.chipText === 'Ask how the trial installation went.', JSON.stringify(s));
  check('arriving collapsed', s.panel === false);

  console.log('\n[I] Clear removes it\n');
  await pin(ctxFor(CHAT_A, 'Alice'));
  await page.panel('click', 'chip');
  await sleep(250);
  await page.panel('click', 'clear');
  await sleep(300);
  s = await page.panel('snapshot');
  check('back to the empty add row', s.add === true && s.panel === false && s.chip === false, JSON.stringify(s));
  check('the box was emptied too', s.boxValue === '', JSON.stringify(s.boxValue));
  saved = await store();
  check('and the entry is gone from storage', !saved[CHAT_A], JSON.stringify(saved));
  check('the other chat is untouched', (saved[CHAT_B] || {}).text === 'Mention the 3-year warranty.', JSON.stringify(saved));

  console.log('\n[J] no chat open means no instruction control at all\n');
  await pin({
    hasOpenChat: false,
    chatId: '',
    chatIdStable: false,
    contactName: '',
    isGroup: false,
    counts: { total: 0, incoming: 0, outgoing: 0, unknown: 0 },
  });
  s = await page.panel('snapshot');
  check('all three states are hidden', s.add === false && s.panel === false && s.chip === false, JSON.stringify(s));

  console.log('\n[K] truncation and the flush\n');
  await pin(ctxFor(CHAT_A, 'Alice'));
  const savedLen = await page.panel('callGlobal', 'saveInstruction', [CHAT_A, 'L'.repeat(1500)]).then(async () => {
    const again = await store();
    return (again[CHAT_A] || {}).text ? again[CHAT_A].text.length : 0;
  });
  check('an overlong instruction is cut to the limit in storage', savedLen === 1000, String(savedLen));

  // The debounce is what the flush exists for: type, click Generate inside the
  // 400ms window, and the worker must still see the new text.
  await page.panel('callGlobal', 'saveInstruction', [CHAT_A, 'old']);
  await page.panel('setInsOpen', true);
  await page.panel('callGlobal', 'renderInstruction', []);
  await page.panel('type', 'box', 'new');
  await page.panel('callGlobal', 'flushInstruction', []);
  saved = await store();
  check('a flush beats the debounce', saved[CHAT_A].text === 'new', JSON.stringify(saved[CHAT_A]));

  console.log('\n[L] the panel never derived message text from the instruction box\n');
  const leak = await page.panel('type', 'box', 'INSTRUCTION SENTINEL').then(() => page.panel('value', 'reply'));
  check('writing an instruction does not touch the reply box', leak === '', JSON.stringify(leak));

  const remembered = await page.panel('value', 'reply');
  check('and the reply box still holds whatever it held', remembered === leak);

  console.log(`\n${'='.repeat(56)}`);
  console.log(`  PASS: ${pass}   FAIL: ${fail}`);
  console.log(`${'='.repeat(56)}\n`);
  await bridge.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('FATAL', err && err.message);
  process.exit(1);
});
