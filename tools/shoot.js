#!/usr/bin/env node
/**
 * Capture documentation screenshots of the real side panel.
 *
 * Development tooling — not part of the extension, not shipped in the release ZIP.
 *
 * Why a throwaway profile: the screenshots have to show the genuine panel, but
 * they must never show a genuine conversation. Starting Chrome on a fresh
 * `--user-data-dir` gives an extension whose storage is empty and which is not
 * signed in to WhatsApp, so there is nothing real for a scene to leak. The
 * profile is deleted afterwards.
 *
 * This does NOT clone, copy or open the profile you use day to day, and it never
 * touches WhatsApp's login state. See AGENTS.md §2 and §3.
 *
 * Usage:
 *   node tools/shoot.js                     # every scene, into docs/assets
 *   node tools/shoot.js --only reply        # one scene
 *   node tools/shoot.js --out /tmp/shots
 *   node tools/shoot.js --keep              # leave the throwaway profile behind
 */

'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { connectToPage } = require('./cdp');
const { findBrowser, assertCanLoadExtensions } = require('./browser');

const REPO = path.resolve(__dirname, '..');

const WIDTH = 400;

/**
 * A second kind of capture: the page a user meets before the panel.
 *
 * `chrome://extensions` with Developer mode on and the extension listed is the
 * one picture the install guide cannot do without, and it is a different shape
 * from the panel scenes — different size, and it has to be driven through its
 * own shadow DOM rather than the panel probe.
 */
const EXTENSIONS_PAGE = { file: '00-chrome-extensions.png', width: 1000, height: 560 };

/**
 * One entry per scene. `height` is the panel viewport in CSS pixels: a real side
 * panel is roughly this tall, and the panel's layout depends on it, so it is
 * chosen per scene rather than being one universal value.
 *
 * `file` is the published name. Documentation links to these, so renaming one
 * means updating the pages that embed it.
 */
const SCENES = [
  { scene: 'setup', file: '01-first-run-setup.png', height: 1160 },
  { scene: 'connected', file: '02-connect-your-ai.png', height: 1260 },
  { scene: 'quickstart', file: '03-what-to-do-next.png', height: 800 },
  { scene: 'reply', file: '04-generated-draft.png', height: 820 },
  { scene: 'instruction', file: '05-per-chat-instruction.png', height: 820 },
  { scene: 'followup', file: '06-followup-confirmation.png', height: 820 },
  { scene: 'settingsAdvanced', file: '07-settings.png', height: 1400 },
  { scene: 'chatgpt', file: '08-chatgpt-helper-off.png', height: 1180 },
  { scene: 'chatgptConnected', file: '09-chatgpt-connected.png', height: 1180 },
  { scene: 'settingsChatgpt', file: '10-settings-chatgpt.png', height: 1400 },
];

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}
const has = (name) => process.argv.includes(`--${name}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until Chrome answers on its debug port, or give up. */
async function waitForPort(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  throw new Error(`Chrome never opened a debug port on ${port}`);
}

/** Ask Chrome to open a tab and return its target. */
async function openTab(port, url) {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!res.ok) throw new Error(`could not open a tab: ${res.status}`);
  return res.json();
}

/**
 * Pin the page to the exact viewport the picture should have.
 *
 * Worth doing rather than cropping a taller window: the panel is a full-height
 * flex layout, so its shape depends on how tall the viewport is. Sizing the
 * viewport to the intended image is what makes the screenshot show what a user
 * with that panel height actually sees.
 */
async function setViewport(session, width, height) {
  await session.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await sleep(400);
}

async function capture(session, file, height) {
  await session.send('Page.enable');

  const deadline = Date.now() + 30_000;
  let title = '';
  while (Date.now() < deadline) {
    title = await session.eval('document.title');
    if (title === 'ready' || String(title).startsWith('error:')) break;
    await sleep(200);
  }
  if (title !== 'ready') throw new Error(`scene did not settle — ${title}`);

  await setViewport(session, WIDTH, height);
  const shot = await session.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  return height;
}

/**
 * Capture `chrome://extensions` with Developer mode switched on.
 *
 * The toggle lives three shadow roots deep; `#devMode` is the switch the page
 * itself binds, so clicking it is the same thing a person does.
 */
async function captureExtensionsPage(port, outDir) {
  const target = await openTab(port, 'chrome://extensions/');
  await sleep(2500);
  const session = await connectToPage(/chrome:\/\/extensions/, port);

  await session.eval(`(() => {
    const mgr = document.querySelector('extensions-manager');
    const bar = mgr && mgr.shadowRoot && mgr.shadowRoot.querySelector('extensions-toolbar');
    const box = bar && bar.shadowRoot && bar.shadowRoot.querySelector('#devMode');
    if (box && !box.checked) box.click();
    return true;
  })()`);
  // The item list re-renders once developer mode is on; capturing before that
  // yields a card with no reload button on it.
  await sleep(1500);

  await setViewport(session, EXTENSIONS_PAGE.width, EXTENSIONS_PAGE.height);
  const shot = await session.send('Page.captureScreenshot', { format: 'png' });
  const dest = path.join(outDir, EXTENSIONS_PAGE.file);
  fs.writeFileSync(dest, Buffer.from(shot.data, 'base64'));
  session.close();
  await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => {});
  return `${EXTENSIONS_PAGE.file} (${EXTENSIONS_PAGE.width}x${EXTENSIONS_PAGE.height} css px)`;
}

async function main() {
  const browser = findBrowser();
  assertCanLoadExtensions(browser);
  const outDir = path.resolve(arg('out', path.join(REPO, 'docs', 'assets')));
  const only = arg('only', null);
  const chosen = only ? SCENES.filter((s) => s.scene === only) : SCENES;
  if (only && !chosen.length && only !== 'extensions') throw new Error(`no such scene: ${only}`);
  const withExtensionsPage = only ? only === 'extensions' : true;

  fs.mkdirSync(outDir, { recursive: true });

  const { extensionIdFor } = require('./compute-extension-id');
  const id = extensionIdFor(REPO);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wsaic-shots-'));
  const port = 9333 + (process.pid % 500);

  const child = spawn(
    browser,
    [
      '--headless=new',
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      `--load-extension=${REPO}`,
      `--disable-extensions-except=${REPO}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-component-update',
      '--hide-scrollbars',
      // The real viewport is set per capture with Emulation.setDeviceMetricsOverride;
      // this is only the size the window opens at.
      '--window-size=1000,1000',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const written = [];
  try {
    await waitForPort(port);

    for (const { scene, file, height } of chosen) {
      const url = `chrome-extension://${id}/src/test/shots.html?scene=${scene}`;
      const target = await openTab(port, url);
      const session = await connectToPage(new RegExp(`${id}/src/test/shots\\.html`), port).catch(() => null);
      if (!session) {
        // The tab may not have registered yet on the first pass.
        await sleep(500);
      }
      const live = session || (await connectToPage(new RegExp(`${id}/src/test/shots\\.html`), port));
      const dest = path.join(outDir, file);
      const used = await capture(live, dest, height);
      live.close();
      written.push(`${file} (${WIDTH}x${used} css px)`);
      // Close the tab so the next scene starts from a clean extension page.
      await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => {});
    }

    if (withExtensionsPage) written.push(await captureExtensionsPage(port, outDir));
  } finally {
    child.kill('SIGTERM');
    await sleep(400);
    if (!has('keep')) fs.rmSync(profile, { recursive: true, force: true });
  }

  for (const line of written) console.log(`  ${line}`);
  console.log(`\n${written.length} screenshot(s) → ${outDir}`);
}

main().catch((err) => {
  console.error(`shoot failed: ${(err && err.message) || err}`);
  process.exit(1);
});
