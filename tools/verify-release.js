#!/usr/bin/env node
/**
 * Prove that the release ZIP actually installs.
 *
 * Building a ZIP and listing its contents says nothing about whether Chrome will
 * accept it. This extracts the archive into a throwaway directory, loads it into
 * a throwaway Chrome profile, and checks the things a person would notice:
 * the extension is enabled with no manifest errors, the service worker starts,
 * the side panel page initialises, and the development-only files are genuinely
 * absent.
 *
 * The profile is a fresh temp directory. It is not the profile you use, it is
 * not signed in to WhatsApp, and it is deleted afterwards — see AGENTS.md §2.
 *
 *   node tools/verify-release.js                      # builds, then verifies
 *   node tools/verify-release.js dist/foo.zip
 */

'use strict';

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { connectToPage, listTargets } = require('./cdp');
const { findBrowser, assertCanLoadExtensions } = require('./browser');
const { extensionIdFor } = require('./compute-extension-id');

const REPO = path.resolve(__dirname, '..');
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

async function main() {
  const given = process.argv[2];
  if (!given) {
    console.log('building first…');
    execFileSync(process.execPath, [path.join(REPO, 'tools/build-release.js')], { stdio: 'inherit' });
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'manifest.json'), 'utf8'));
  const zip = path.resolve(given || path.join(REPO, 'dist', `whatsapp-sales-ai-copilot-${manifest.version}.zip`));
  if (!fs.existsSync(zip)) throw new Error(`no such archive: ${zip}`);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wsaic-verify-'));
  const app = path.join(work, 'extension');
  const profile = path.join(work, 'profile');
  fs.mkdirSync(app, { recursive: true });

  execFileSync('unzip', ['-q', zip, '-d', app]);

  console.log(`\n[1] the archive itself\n`);
  const entries = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).trim().split('\n');
  check('the manifest is at the root, not in a folder', entries.includes('manifest.json'), entries.slice(0, 3).join(', '));
  check('nothing from tools/ shipped', !entries.some((e) => e.startsWith('tools/')), entries.filter((e) => e.startsWith('tools/')).join(', '));
  check('the dev bridge did not ship', !entries.some((e) => e.startsWith('src/test/')), entries.filter((e) => e.startsWith('src/test/')).join(', '));
  check('no git history', !entries.some((e) => e.startsWith('.git/')));
  check('no docs or screenshots', !entries.some((e) => /^(docs|dist)\//.test(e) || /\.(md|png)$/i.test(e)));
  check('it is not empty', entries.length > 5, `${entries.length} entries`);

  console.log(`\n[2] Chrome accepts it\n`);
  const browser = findBrowser();
  assertCanLoadExtensions(browser);
  const port = 9901 + (process.pid % 90);

  const child = spawn(
    browser,
    [
      '--headless=new',
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      `--load-extension=${app}`,
      `--disable-extensions-except=${app}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-component-update',
      '--window-size=1000,1000',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  try {
    await waitForPort(port);

    await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('chrome://extensions/')}`, { method: 'PUT' });
    await sleep(3000);
    const extPage = await connectToPage(/chrome:\/\/extensions/, port);
    const info = JSON.parse(
      await extPage.eval(`new Promise(res => chrome.developerPrivate.getExtensionsInfo(
        { includeDisabled: true, includeTerminated: true },
        list => res(JSON.stringify(list.map(e => ({
          name: e.name, version: e.version, state: e.state,
          manifestErrors: (e.manifestErrors || []).map(x => x.message),
          runtimeErrors: (e.runtimeErrors || []).map(x => x.message),
          warnings: (e.warnings || []).map(x => x.message),
        }))))
      ))`),
    );
    extPage.close();

    const ext = info.find((e) => e.name === manifest.name);
    check('the extension is installed', !!ext, JSON.stringify(info.map((e) => e.name)));
    if (ext) {
      check('it is enabled', ext.state === 'ENABLED', ext.state);
      check('the version matches the manifest', ext.version === manifest.version, ext.version);
      check('the manifest parses without errors', ext.manifestErrors.length === 0, ext.manifestErrors.join('; '));
      check('it raised no runtime errors', ext.runtimeErrors.length === 0, ext.runtimeErrors.join('; '));
      check('it raised no warnings', ext.warnings.length === 0, ext.warnings.join('; '));
    }

    // The id is derived from the path Chrome was handed, so it changes with the
    // temp directory — and Chrome resolves symlinks before hashing, which macOS
    // temp paths are full of. Read it back off the service worker rather than
    // recomputing it.
    const targets = await listTargets(port);
    const swTarget = targets.find(
      (t) => t.type === 'service_worker' && /\/src\/background\/service-worker\.js$/.test(t.url || ''),
    );
    check('the service worker started', !!swTarget, targets.map((t) => t.url).join(', '));
    const id = swTarget ? new URL(swTarget.url).host : extensionIdFor(app);

    console.log(`\n[3] the side panel runs from the packaged copy\n`);
    const panelUrl = `chrome-extension://${id}/${manifest.side_panel.default_path}`;
    await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(panelUrl)}`, { method: 'PUT' });
    await sleep(2500);

    const panel = await connectToPage(new RegExp(`${manifest.side_panel.default_path.replace(/[.]/g, '\\.')}$`), port);
    check('the panel page loaded', (await panel.eval('location.protocol')) === 'chrome-extension:', await panel.eval('location.href'));

    // A packaged copy starts with empty storage, so the welcome screen is what
    // a new user gets. If the classic copies or the worker were left out of the
    // archive, this is where it shows: the panel stays blank instead.
    let ready = false;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      ready = await panel.eval(`(() => {
        const setup = document.getElementById('setup');
        const name = document.getElementById('chat-name');
        return !!setup && !setup.classList.contains('hidden') && !!name;
      })()`).catch(() => false);
      if (ready) break;
      await sleep(300);
    }
    check('it boots to the welcome screen on a fresh install', ready === true);
    check(
      'the reply UI is behind it, not on top of it',
      (await panel.eval(`document.getElementById('settings').classList.contains('hidden')`)) === true,
    );
    panel.close();
  } finally {
    child.kill('SIGTERM');
    await sleep(500);
    fs.rmSync(work, { recursive: true, force: true });
  }

  console.log(`\n${'='.repeat(56)}`);
  console.log(`  PASS: ${pass}   FAIL: ${fail}`);
  console.log(`${'='.repeat(56)}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nFATAL ${(err && err.message) || err}`);
  process.exit(1);
});
