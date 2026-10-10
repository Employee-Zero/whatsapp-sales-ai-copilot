#!/usr/bin/env node
/**
 * Live verification that a per-chat instruction reaches the AI request.
 *
 * The panel writes the instruction to chrome.storage.local; the worker reads it
 * back and hands it to the AI client. Both halves were verified separately, and
 * this closes the gap between them: it makes two real calls to the configured
 * model — one with an instruction, one without — and reads the request bodies
 * off the wire.
 *
 * The request is made by the extension's own `generateReply`, imported straight
 * from the extension, so nothing here reimplements the prompt assembly. The
 * body is read by wrapping `fetch` inside the extension page for the duration of
 * the call; the Authorization header is never read, returned, printed or stored.
 *
 * Needs the extension running in a Chrome window that is on screen, with a
 * configured API key, plus the dev bridge page open. See AGENTS.md §4.
 *
 *   node tools/test-instruction-ai-path.js
 */

const { Bridge } = require('./bridge-server.js');

const PORT = Number(process.env.BRIDGE_PORT || 8787);

const INSTRUCTION = 'Ask specifically how the trial installation went, and nothing about price.';
const TRANSCRIPT = [
  'CUSTOMER: Oi, tudo bem?',
  'ME: Tudo! Você chegou a ver a proforma?',
  'CUSTOMER: Ainda não.',
].join('\n');

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

/** Never print a request body wholesale — it is the customer's conversation. */
function summarise(content) {
  return `${String(content).length} chars, starts: ${JSON.stringify(String(content).slice(0, 60))}`;
}

(async () => {
  const bridge = await Bridge.start({ port: PORT });
  await bridge.waitForPage(Number(process.env.BRIDGE_WAIT_MS || 60_000));

  /** Run generateReply for one context and return the request body it produced. */
  async function callOnce(instruction) {
    const res = await bridge.self('aiReply', {
      contactName: 'Alice',
      transcript: TRANSCRIPT,
      messageCount: 3,
      instruction: instruction || '',
    });
    let body = null;
    try {
      body = JSON.parse(res.body || 'null');
    } catch (err) {
      /* leave null — reported below */
    }
    return { out: res, body, url: res.url };
  }

  console.log('\n[1] a real call, with an instruction\n');
  const withIns = await callOnce(INSTRUCTION);
  check('the model was actually called', !!withIns.body, JSON.stringify(withIns.out && withIns.out.code));
  check('and answered', withIns.out.ok === true && !!withIns.out.text, JSON.stringify(withIns.out && (withIns.out.code || withIns.out.error)));

  if (withIns.body) {
    const msgs = withIns.body.messages || [];
    check('exactly two messages go out', msgs.length === 2, `${msgs.length}`);
    check('system first, user second', msgs[0].role === 'system' && msgs[1].role === 'user');

    const sys = String((msgs[0] || {}).content || '');
    const usr = String((msgs[1] || {}).content || '');

    check('the instruction is in the system message', sys.includes(INSTRUCTION));
    check('it is labelled as an instruction', /ADDITIONAL INSTRUCTION FOR THIS CONVERSATION/.test(sys));
    check(
      'the general guidance is still there — the instruction is appended, not substituted',
      sys.length > INSTRUCTION.length + 200,
      summarise(sys),
    );
    check('the no-invention bar travels with it', /does not override the rules about not inventing/.test(sys));

    // The whole point of riding on the system message.
    check('the instruction is NOT in the user message', !usr.includes(INSTRUCTION));
    check('the user message is still the transcript and the length guidance', usr.includes('CUSTOMER: Oi, tudo bem?') && /Reply with the message text only/.test(usr));

    check('the customer transcript is not leaking into the system message', !sys.includes('CUSTOMER: Oi, tudo bem?'));
  }

  console.log('\n[2] the same call with no instruction\n');
  const without = await callOnce('');
  check('a second real call went out', !!without.body, JSON.stringify(without.out && (without.out.code || without.out.error)));
  if (without.body) {
    const sys = String((without.body.messages || [{}])[0].content || '');
    check('no instruction block is appended', !/ADDITIONAL INSTRUCTION/.test(sys));
    check('and no priority claim either', !/takes priority/.test(sys));
    if (withIns.body) {
      const lenWith = String(withIns.body.messages[0].content).length;
      check(
        'the system message is shorter by exactly the block',
        lenWith > sys.length && lenWith - sys.length > INSTRUCTION.length,
        `${lenWith} vs ${sys.length}`,
      );
      check('everything before the block is byte-identical', String(withIns.body.messages[0].content).startsWith(sys));
    }
  }

  console.log('\n[3] the client discarded nothing\n');
  if (withIns.body && without.body) {
    const sysWith = String(withIns.body.messages[0].content);
    const sysBase = String(without.body.messages[0].content);
    check(
      'the instruction sits after the general guidance',
      sysWith.indexOf(INSTRUCTION) >= sysBase.length,
      `instruction at ${sysWith.indexOf(INSTRUCTION)}, base prompt is ${sysBase.length}`,
    );
  }
  if (withIns.body) {
    const bodies = [withIns, without].filter((r) => r.body).map((r) => JSON.stringify(r.body));
    check('no api key appears in any request body', !bodies.some((b) => /sk-|Bearer |api[_-]?key/i.test(b)));
  }

  console.log(`\n${'='.repeat(56)}`);
  console.log(`  PASS: ${pass}   FAIL: ${fail}`);
  console.log(`${'='.repeat(56)}\n`);
  await bridge.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('FATAL', err && err.message);
  process.exit(1);
});
