/**
 * Talk to the loaded extension the way the side panel does.
 *
 * The extension's content script lives in an isolated world; this tool locates
 * that world and sends real chrome.runtime messages from inside it, then prints
 * the structured response. Nothing here is part of the extension itself.
 *
 * Usage: node tools/ext-test.js GET_CHAT_CONTEXT [json-payload]
 *        node tools/ext-test.js --list
 */

const { connectToPage, listTargets } = require('./cdp.js');
const { extensionIdFor, REPO_ROOT } = require('./compute-extension-id.js');

// Derived from the repository's own path, the same way Chrome derives it, so
// there is no machine-specific id baked into the source.
const EXT_ID = process.env.WA_EXT_ID || extensionIdFor(REPO_ROOT);

async function main() {
  const args = process.argv.slice(2);
  const targets = await listTargets();
  const wa = targets.find((t) => t.type === 'page' && /web\.whatsapp\.com/.test(t.url || ''));
  if (!wa) throw new Error('WhatsApp Web tab not found');

  const cdp = await connectToPage(/web\.whatsapp\.com/);
  const worldId = await cdp.findExtensionWorld(EXT_ID);
  if (worldId == null) throw new Error(`Content script world not found for ${EXT_ID}`);

  const type = args[0] || 'GET_CHAT_CONTEXT';
  const payload = args[1] ? JSON.parse(args[1]) : {};

  const result = await cdp.eval(
    `chrome.runtime.sendMessage(${JSON.stringify({ type, ...payload })})
       .then(r => JSON.stringify(r))
       .catch(e => JSON.stringify({ __error: String(e) }))`,
    { contextId: worldId },
  );

  let parsed;
  try {
    parsed = JSON.parse(result);
  } catch (e) {
    parsed = result;
  }

  if (args[0] === '--list') {
    console.log(JSON.stringify(parsed, null, 2));
  } else if (parsed && parsed.text) {
    console.log(JSON.stringify({ ok: parsed.ok, text: parsed.text, context: parsed.context }, null, 2));
  } else if (parsed && parsed.context) {
    // Print a compact, key-safe summary (never dump the raw API key).
    const c = parsed.context;
    console.log(
      JSON.stringify(
        {
          ok: parsed.ok,
          hasOpenChat: c.hasOpenChat,
          contactName: c.contactName,
          phone: c.phone,
          phoneStatus: c.phoneStatus,
          allowed: c.allowed,
          isGroup: c.isGroup,
          counts: c.counts,
          chatKey: c.chatKey,
          diagnostics: c.diagnostics,
          transcript: (c.transcript || '').slice(0, 400),
        },
        null,
        2,
      ),
    );
  } else {
    console.log(JSON.stringify(parsed, null, 2));
  }
  cdp.close();
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
