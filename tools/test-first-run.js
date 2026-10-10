#!/usr/bin/env node
/**
 * Live verification of what a brand-new user meets, and of the two guards that
 * stand between a click and a message going out.
 *
 * Three things are under test that nothing else covers:
 *
 *   - an install with no provider configured shows the welcome screen, says
 *     which fields are missing, and never reaches the point of making a request;
 *   - "Follow-up & Send" asks before it sends, and the question is dropped the
 *     moment it stops being about the open conversation;
 *   - a draft that has been sent cannot come back and be sent again.
 *
 * It drives the real panel through the dev bridge, so it needs the bridge page
 * open in the Chrome window that has the extension installed. See AGENTS.md §4:
 *
 *   node tools/open-bridge.js
 *   node tools/test-first-run.js
 *
 * Nothing here clicks the button that writes and sends without a preview. That
 * is the whole point of the confirmation being a separate step, and in this
 * profile the open conversation belongs to a real customer.
 */

const { Bridge } = require('./bridge-server.js');

const PORT = Number(process.env.BRIDGE_PORT || 8787);

const CHAT_A = 'dm:15550100001';
const CHAT_B = 'dm:15550100002';
const CHAT_C = 'dm:15550100003';

function ctxFor(chatId, name) {
  return {
    hasOpenChat: true,
    chatId,
    chatIdStable: true,
    chatKey: `${name}|dm|anchor|4`,
    contactName: name,
    phone: '',
    phoneStatus: 'hidden',
    isGroup: false,
    loadedInDom: 4,
    counts: { total: 4, incoming: 2, outgoing: 2, unknown: 0 },
  };
}

/** A public config shape with nothing filled in, as a fresh install has it. */
const UNCONFIGURED = {
  primaryBaseUrl: '',
  fallbackBaseUrl: '',
  model: '',
  hasApiKey: false,
  keyHint: '',
  hasRequiredConfig: false,
  missingFields: ['primaryBaseUrl', 'apiKey', 'model'],
  missingFieldLabels: ['API Base URL', 'API Key', 'Model ID'],
};

/** The same shape once a provider is in place. */
const CONFIGURED = {
  primaryBaseUrl: 'https://api.example.com/v1',
  fallbackBaseUrl: '',
  model: 'example-model',
  hasApiKey: true,
  keyHint: '…4f2a',
  hasRequiredConfig: true,
  missingFields: [],
  missingFieldLabels: [],
};

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
  const page = bridge;

  await page.waitForPage(Number(process.env.BRIDGE_WAIT_MS || 60_000));
  await page.openPanel();
  await page.panel('whenInitDone');
  await page.panel('detachChat');
  await page.panel('dropChatKeys', [CHAT_A, CHAT_B, CHAT_C]);

  // The first-run flags belong to the person using this profile, not to the
  // test. Whatever they were before is put back at the end.
  const onboardingBefore = await page.panel('onboardingState');

  const pin = (ctx) => page.panel('pinContext', ctx);
  const ui = () => page.panel('ui');

  // ---------------------------------------------------------------------- A
  console.log('\n[A] a fresh install shows the welcome, not the reply UI\n');

  await pin(ctxFor(CHAT_A, 'Alice'));
  await page.panel('overrideConfig', UNCONFIGURED);
  await sleep(200);

  let u = await ui();
  check('the setup card is on screen', u.setup === true, JSON.stringify(u.setup));
  check('the quickstart list is not', u.quickstart === false);
  check('settings stay folded away', u.settings === false);
  check('the welcome card says what the product is', /Welcome to WhatsApp Sales AI Copilot/.test(u.setupTitle || ''), u.setupTitle);
  check('the stored key is never rendered back', u.suApiKey === '', JSON.stringify(u.suApiKey));
  check('an empty install gets a neutral key hint, not a masked one', u.suApiKeyPlaceholder === 'the key from your provider', u.suApiKeyPlaceholder);

  // ---------------------------------------------------------------------- B
  console.log('\n[B] the panel says which fields are missing\n');

  const msg = await page.panel('describeError', 'AI_API_KEY_NOT_SET', 'fallback', { missingFieldLabels: UNCONFIGURED.missingFieldLabels });
  check('it names all three fields', /API Base URL, API Key, Model ID/.test(msg), msg);
  check('it does not say "something went wrong"', !/went wrong/i.test(msg), msg);
  check('and it does not print an internal code', !/AI_NOT_CONFIGURED|AI_API_KEY_NOT_SET/.test(msg), msg);

  const generic = await page.panel('describeError', 'AI_API_KEY_NOT_SET', 'fallback', null);
  check('with no labels it still explains itself', /not set up yet/.test(generic), generic);
  check('and points at the gear icon', /⚙/.test(generic), generic);

  check('Generate is still offered, so the user gets told why', u.generateDisabled === false);

  // ---------------------------------------------------------------------- C
  console.log('\n[C] after connecting, the welcome gives way to three steps\n');

  await page.panel('overrideConfig', CONFIGURED);
  await page.panel('callGlobal', 'saveOnboarding', [{ connected: true, dismissed: false }]);
  await sleep(200);

  u = await ui();
  check('the setup card is gone', u.setup === false);
  check('the quickstart list is shown once', u.quickstart === true);
  check('settings are still folded away', u.settings === false);

  await page.panel('click', 'qs-done');
  await sleep(200);
  u = await ui();
  check('"Got it" dismisses it', u.quickstart === false);
  check('and the setup card does not come back', u.setup === false);

  await page.panel('overrideConfig', CONFIGURED);
  await sleep(200);
  u = await ui();
  check('a later re-render does not resurrect either', u.quickstart === false && u.setup === false);

  const flags = await page.panel('onboardingState');
  check('the dismissal is remembered in storage', flags.dismissed === true, JSON.stringify(flags));

  // ---------------------------------------------------------------------- D
  console.log('\n[D] Follow-up & Send asks first\n');

  await pin(ctxFor(CHAT_A, 'Alice'));
  await sleep(200);
  u = await ui();
  check('the question is not on screen to begin with', u.followupConfirm === false);
  check('and it is asked before it can send', /you won't see it first/.test(u.followupLabel || ''), u.followupLabel);
  check('the button is offered while a chat is open', u.followupDisabled === false);

  await page.panel('click', 'followup');
  await sleep(200);
  u = await ui();
  check('clicking it opens the confirmation', u.followupConfirm === true);

  const recipient = (await ui()).followupRecipient;
  check('the confirmation names the recipient', /Alice/.test(String(recipient)), String(recipient));

  await page.panel('click', 'followupCancel');
  await sleep(200);
  u = await ui();
  check('Cancel closes it', u.followupConfirm === false);

  await page.panel('click', 'followup');
  await sleep(150);
  await pin(ctxFor(CHAT_B, 'Bob'));
  await sleep(250);
  u = await ui();
  check('switching customer drops the question', u.followupConfirm === false);

  // A question that has stopped being about the open chat must not survive a
  // moment where there is no chat at all, either.
  await page.panel('openFollowupConfirm');
  await page.panel('detachChat');
  await sleep(250);
  u = await ui();
  check('so does closing the conversation', u.followupConfirm === false);

  // ---------------------------------------------------------------------- E
  console.log('\n[E] a sent draft cannot be sent twice\n');

  await pin(ctxFor(CHAT_A, 'Alice'));
  await sleep(200);
  u = await ui();
  check('an empty reply box leaves Send disabled', u.sendDisabled === true);

  await page.panel('type', 'reply', 'Hello there');
  await sleep(200);
  u = await ui();
  check('typing into it enables Send', u.sendDisabled === false);

  // The panel marks a draft `sent` once the message is away. That state is
  // deliberately never written to storage: the box is emptied instead, so a
  // reopened panel cannot offer the same text for sending a second time.
  await page.panel('callGlobal', 'saveDraft', [CHAT_A, 'Hello there', 'sent']);
  const stored = (await page.panel('readStore', ['drafts'])).drafts || {};
  check('the sent draft is not persisted', !stored[CHAT_A], JSON.stringify(stored[CHAT_A]));

  await page.panel('callGlobal', 'saveDraft', [CHAT_B, 'Bob, following up', 'draft']);
  const stored2 = (await page.panel('readStore', ['drafts'])).drafts || {};
  check('an unsent draft for another chat still is', !!stored2[CHAT_B], JSON.stringify(Object.keys(stored2)));

  // ---------------------------------------------------------------------- F
  console.log('\n[F] drafts stay with their customer\n');

  await pin(ctxFor(CHAT_A, 'Alice'));
  await page.panel('type', 'reply', 'Alice, about the quote');
  await sleep(400);
  await pin(ctxFor(CHAT_B, 'Bob'));
  await sleep(300);
  const bobBox = await page.panel('value', 'reply');
  check('the other chat shows its own draft, not hers', bobBox === 'Bob, following up', JSON.stringify(bobBox));

  await pin(ctxFor(CHAT_C, 'Carol'));
  await sleep(300);
  const carolBox = await page.panel('value', 'reply');
  check('a customer with no draft gets an empty box', carolBox === '', JSON.stringify(carolBox));

  await pin(ctxFor(CHAT_A, 'Alice'));
  await sleep(300);
  check('and Alice still has hers', (await page.panel('value', 'reply')) === 'Alice, about the quote', JSON.stringify(await page.panel('value', 'reply')));

  // ------------------------------------------------------------------- done
  await page.panel('detachChat');
  await page.panel('dropChatKeys', [CHAT_A, CHAT_B, CHAT_C]);
  await page.panel('restoreConfig');
  await page.self('storageSet', { onboarding: onboardingBefore });

  console.log(`\n${'='.repeat(56)}`);
  console.log(`  PASS: ${pass}   FAIL: ${fail}`);
  console.log(`${'='.repeat(56)}\n`);

  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error(`\nFATAL ${(err && err.message) || err}`);
  process.exit(1);
});
