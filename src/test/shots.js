/**
 * Scene driver for documentation screenshots. Development-only.
 *
 * Renders the real side panel in an iframe and populates it, through the same
 * probe the tests use, with invented people and invented messages. Nothing here
 * reads WhatsApp, and nothing here runs against a profile that is signed in to
 * it — tools/shoot.js starts Chrome on a throwaway user-data-dir for exactly
 * that reason. A screenshot of a documentation page must not be a screenshot of
 * somebody's customer.
 *
 * See shots.html for the list of scenes.
 */
'use strict';

const PANEL_PATH = 'src/sidepanel/sidepanel.html';
const PROBE_PATH = 'src/test/panel-probe.classic.js';

/**
 * The invented conversation every scene is built on.
 *
 * Deliberately mundane and deliberately fictional: a fabricated company, a
 * fabricated contact, and the reserved 555-01xx number range that exists so
 * fiction cannot collide with a real subscriber.
 */
const CHAT = Object.freeze({
  hasOpenChat: true,
  chatIdStable: true,
  chatId: 'dm:Northwind Fabrication | Dana Whitfield',
  contactName: 'Dana Whitfield',
  phone: '+1 555 010 0000',
  isGroup: false,
  counts: { total: 9, incoming: 3, outgoing: 6 },
});

const DRAFT = [
  'Hi Dana — thanks for the update. I reworked the numbers for the twelve stainless',
  'enclosures: $8,940 for the batch, held for 30 days. Lead time is four weeks from',
  'PO, and we can split it 6/6 if that suits your line better. Shall I send the',
  'revised drawing across for sign-off?',
].join(' ');

const INSTRUCTION = 'She asked about the IP66 rating — mention the test certificate.';

/** The shape the panel expects from the service worker, with nothing configured. */
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

/** The same shape after a provider has been entered. */
const CONFIGURED = {
  primaryBaseUrl: 'https://api.example.com/v1',
  fallbackBaseUrl: '',
  model: 'example-model-mini',
  hasApiKey: true,
  keyHint: '…4f2a',
  hasRequiredConfig: true,
  missingFields: [],
  missingFieldLabels: [],
};

/** The subscription method, with nothing signed in yet. */
const CHATGPT_CONFIG = Object.assign({}, UNCONFIGURED, {
  connectionMode: 'chatgpt',
  chatgptModel: '',
  helperUrl: 'http://127.0.0.1:8788',
  missingFields: ['chatgptModel'],
  missingFieldLabels: ['Model'],
});

/**
 * What the worker reports when the helper has not been started.
 *
 * This is the state most people meet first, so it is the honest one to
 * photograph: it is also what the panel really renders in this throwaway
 * profile, because there is no helper running anywhere near it.
 */
const HELPER_DOWN = {
  helper: 'unreachable',
  signedIn: false,
  planScope: false,
  signIn: 'none',
  signInError: '',
  startCommand: 'node helper/siwc-helper.js',
  helperUrl: 'http://127.0.0.1:8788',
  email: '',
  label: '',
  error: 'CHATGPT_HELPER_UNREACHABLE',
};

/**
 * A connected subscription account.
 *
 * Invented, like the conversation: there is no account behind it and no token
 * anywhere. The placeholder model names are not real ones either — publishing a
 * picture of a real account's catalogue would date the docs and say something
 * about somebody's plan that is theirs to say.
 */
const CHATGPT_CONNECTED = Object.assign({}, HELPER_DOWN, {
  helper: 'running',
  signedIn: true,
  planScope: true,
  email: 'd.whitfield@example.com',
  label: 'd.whitfield@example.com',
  error: '',
});

const CHATGPT_MODELS = [
  { slug: 'example-standard', displayName: 'Example Standard' },
  { slug: 'example-mini', displayName: 'Example Mini' },
  { slug: 'example-reasoning', displayName: 'Example Reasoning' },
];

/**
 * The subscription method once it is finished: a model chosen, nothing missing.
 *
 * The difference from `CHATGPT_CONFIG` is not cosmetic — with a field still
 * missing the panel correctly keeps the welcome card up, and a picture of the
 * settings pane would have that card stacked above it.
 */
const CHATGPT_READY = Object.assign({}, CHATGPT_CONFIG, {
  chatgptModel: 'example-standard',
  hasRequiredConfig: true,
  missingFields: [],
  missingFieldLabels: [],
});

// ------------------------------------------------------------------- plumbing

const params = new URLSearchParams(location.search);
const SCENE = params.get('scene') || 'setup';
const frame = document.getElementById('stage');

function whenLoaded() {
  return new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }));
}

function probe() {
  const p = frame.contentWindow && frame.contentWindow.__probe;
  if (!p) throw new Error('the panel probe is not injected');
  return p;
}

function panelDoc() {
  return frame.contentDocument;
}

function setValue(id, value) {
  const node = panelDoc().getElementById(id);
  if (!node) throw new Error(`no #${id} in the panel`);
  node.value = value;
}

function click(id) {
  const node = panelDoc().getElementById(id);
  if (!node) throw new Error(`no #${id} in the panel`);
  node.click();
}

/** Let the panel's own async render passes finish before the shot is taken. */
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

async function loadPanel() {
  frame.src = chrome.runtime.getURL(PANEL_PATH);
  await whenLoaded();

  await new Promise((resolve, reject) => {
    const script = panelDoc().createElement('script');
    script.src = chrome.runtime.getURL(PROBE_PATH);
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('the probe was blocked by the extension CSP'));
    (panelDoc().head || panelDoc().documentElement).appendChild(script);
  });

  const win = frame.contentWindow;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (win.__probe && win.__probe.ready()) return;
    await settle(100);
  }
  throw new Error('the panel controller did not initialise');
}

/**
 * Put the panel on the invented conversation and keep it there.
 *
 * `stubChat` replaces the panel's reader before the first pin, so the four-second
 * poll returns the same chat rather than asking WhatsApp — which in this profile
 * is not running, and would otherwise blank the scene on the next tick.
 */
async function pinChat() {
  const p = probe();
  p.stubChat(CHAT);
  await p.pinContext(CHAT);
}

/** Write a per-chat draft or instruction the way the panel itself would. */
function seedStorage(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}

/**
 * Wait out the panel's own first pass.
 *
 * `ready()` only says the controller exists; `init()` is still awaiting the
 * service worker and then re-reads the conversation, and that late read would
 * overwrite a scene pinned a moment too early with "no chat open". Letting it
 * finish first is what makes the pinned conversation stick.
 */
async function waitForInit() {
  await settle(900);
}

// --------------------------------------------------------------------- scenes

/**
 * Each scene is `{ seed?, run }`.
 *
 * `seed` is written to `chrome.storage.local` *before* the panel is loaded. That
 * ordering matters: the panel caches the draft and instruction stores for the
 * life of the page, so anything written after it boots is invisible to it. The
 * opening `chrome.storage.local.clear()` would otherwise leave every scene
 * sharing whatever the previous one wrote.
 */
const scenes = {
  /** First run: nothing configured, so the welcome card is the whole story. */
  setup: {
    async run() {
      const p = probe();
      await pinChat();
      p.overrideConfig(UNCONFIGURED);
      await settle();
    },
  },

  /** The same card with a provider filled in and a passing connection test. */
  connected: {
    async run() {
      const p = probe();
      await pinChat();
      p.overrideConfig(UNCONFIGURED);
      setValue('su-baseUrl', CONFIGURED.primaryBaseUrl);
      setValue('su-model', CONFIGURED.model);
      setValue('su-apiKey', 'placeholder-not-a-real-key');
      panelDoc().getElementById('su-apiKey').type = 'password';
      frame.contentWindow.setSetupResult(
        'Connection successful\nModel: example-model-mini\nAddress: api.example.com\nResponse time: 412 ms',
        'success',
      );
      await settle();
    },
  },

  /** What the panel shows in the minute after a successful save. */
  quickstart: {
    seed: { onboarding: { connected: true, dismissed: false } },
    async run() {
      const p = probe();
      await pinChat();
      p.overrideConfig(CONFIGURED);
      await frame.contentWindow.saveOnboarding({ connected: true, dismissed: false });
      await settle();
    },
  },

  /** A generated draft, waiting to be read and sent. */
  reply: {
    seed: { drafts: { [CHAT.chatId]: { text: DRAFT, state: 'draft', at: Date.now() } } },
    async run() {
      const p = probe();
      await pinChat();
      p.overrideConfig(CONFIGURED);
      await settle();
    },
  },

  /** The per-chat instruction, collapsed to its chip, above a draft. */
  instruction: {
    seed: {
      drafts: { [CHAT.chatId]: { text: DRAFT, state: 'draft', at: Date.now() } },
      instructions: { [CHAT.chatId]: { text: INSTRUCTION, at: Date.now() } },
    },
    async run() {
      const p = probe();
      await pinChat();
      p.overrideConfig(CONFIGURED);
      await settle();
    },
  },

  /** Settings, on the Basic pane. */
  settings: {
    async run() {
      const p = probe();
      await pinChat();
      p.overrideConfig(CONFIGURED);
      click('btn-settings');
      await settle();
    },
  },

  /** Settings, on the Advanced pane where the provider details live. */
  settingsAdvanced: {
    async run() {
      const p = probe();
      await pinChat();
      p.overrideConfig(CONFIGURED);
      click('btn-settings');
      click('tab-advanced');
      await settle();
    },
  },

  /**
   * The first-run card on the subscription method, before the helper is up.
   *
   * Nothing here is staged: `renderConfig` asks the worker for the helper's
   * status, the worker finds nothing listening on 127.0.0.1, and the panel says
   * so. The instruction underneath is the panel's own.
   */
  chatgpt: {
    async run() {
      const p = probe();
      await pinChat();
      p.overrideConfig(CHATGPT_CONFIG);
      // Let the panel's own status round-trip land first, so it is not
      // overwritten a tick later by the answer that was already in flight.
      await settle(800);
      p.overrideChatGptStatus(HELPER_DOWN, []);
      await settle();
    },
  },

  /** The same card once a plan is connected and a model has been chosen. */
  chatgptConnected: {
    async run() {
      const p = probe();
      await pinChat();
      p.overrideConfig(Object.assign({}, CHATGPT_CONFIG, { chatgptModel: 'example-standard' }));
      await settle(800);
      p.overrideChatGptStatus(CHATGPT_CONNECTED, CHATGPT_MODELS);
      await settle();
    },
  },

  /** Settings, on the subscription method's own pane. */
  settingsChatgpt: {
    async run() {
      const p = probe();
      await pinChat();
      p.overrideConfig(CHATGPT_READY);
      click('btn-settings');
      click('tab-advanced');
      await settle(800);
      p.overrideChatGptStatus(CHATGPT_CONNECTED, CHATGPT_MODELS);
      await settle();
    },
  },
};

// ----------------------------------------------------------------------- run

(async () => {
  try {
    const scene = scenes[SCENE];
    if (!scene) throw new Error(`unknown scene: ${SCENE}`);
    // Scenes share one browser profile. Each starts from nothing.
    await new Promise((r) => chrome.storage.local.clear(r));
    if (scene.seed) await seedStorage(scene.seed);
    await loadPanel();
    await waitForInit();
    await scene.run();
    // Published for tools/shoot.js, which clips the capture to the real content
    // rather than to a guessed window height.
    window.__shotHeight = Math.ceil(panelDoc().documentElement.getBoundingClientRect().height);
    document.title = 'ready';
  } catch (err) {
    document.title = `error: ${(err && err.message) || err}`;
  }
})();
