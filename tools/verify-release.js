#!/usr/bin/env node
/**
 * Prove that the release archives actually install and actually run.
 *
 * Building a ZIP and listing its contents says nothing about whether Chrome will
 * accept it, or whether the helper inside the second archive starts. This
 * extracts each archive into a throwaway directory, loads the extension into a
 * throwaway Chrome profile, and checks the things a person would notice: the
 * extension is enabled with no manifest errors, the service worker starts, the
 * side panel page initialises with both connection methods on offer, the
 * development-only files are genuinely absent — and the helper, run out of the
 * archive as a user would run it, reports its status without a credential file
 * existing yet.
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
  const helperZip = path.join(path.dirname(zip), `whatsapp-sales-ai-copilot-helper-${manifest.version}.zip`);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wsaic-verify-'));
  const app = path.join(work, 'extension');
  const profile = path.join(work, 'profile');
  fs.mkdirSync(app, { recursive: true });

  execFileSync('unzip', ['-q', zip, '-d', app]);

  console.log(`\n[1] the archives themselves\n`);
  const entries = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).trim().split('\n');
  check('the manifest is at the root, not in a folder', entries.includes('manifest.json'), entries.slice(0, 3).join(', '));
  check('nothing from tools/ shipped', !entries.some((e) => e.startsWith('tools/')), entries.filter((e) => e.startsWith('tools/')).join(', '));
  check('the dev bridge did not ship', !entries.some((e) => e.startsWith('src/test/')), entries.filter((e) => e.startsWith('src/test/')).join(', '));
  check('no git history', !entries.some((e) => e.startsWith('.git/')));
  check('no docs or screenshots', !entries.some((e) => /^(docs|dist)\//.test(e) || (/\.(md|png)$/i.test(e) && !e.startsWith('src/icons/'))));
  check('it is not empty', entries.length > 5, `${entries.length} entries`);

  // The panel tells the user to run `node helper/siwc-helper.js` from the folder
  // they downloaded, so the helper has to ship as its own archive with that exact
  // layout. If it is missing, the subscription method is documented but not
  // installable.
  check('the helper archive was built alongside it', fs.existsSync(helperZip), helperZip);
  if (fs.existsSync(helperZip)) {
    const hEntries = execFileSync('unzip', ['-Z1', helperZip], { encoding: 'utf8' }).trim().split('\n');
    const required = [
      'helper/siwc-helper.js',
      'helper/package.json',
      'helper/README.md',
      'helper/lib/constants.js',
      'helper/lib/errors.js',
      'helper/lib/guard.js',
      'helper/lib/oauth.js',
      'helper/lib/pkce.js',
      'helper/lib/responses.js',
      'helper/lib/store.js',
    ];
    const missing = required.filter((f) => !hEntries.includes(f));
    check('it contains everything the helper needs to run', missing.length === 0, `missing: ${missing.join(', ')}`);
    check(
      'every file keeps its helper/ prefix, so the documented command works',
      hEntries.every((e) => e.startsWith('helper/')),
      hEntries.filter((e) => !e.startsWith('helper/')).join(', '),
    );
    check('no dependencies shipped', !hEntries.some((e) => e.includes('node_modules')));
    check('no credentials shipped', !hEntries.some((e) => /credential|\.json$/.test(e) && !e.endsWith('package.json')));
  }

  console.log(`\n[2] the helper runs from its archive\n`);
  if (fs.existsSync(helperZip)) {
    const helperHome = path.join(work, 'helper-run');
    fs.mkdirSync(helperHome, { recursive: true });
    execFileSync('unzip', ['-q', helperZip, '-d', helperHome]);
    const runEnv = { ...process.env, WHATSAPP_COPILOT_HOME: path.join(helperHome, 'config') };

    // Exactly the command the panel shows the user, run from the folder they
    // would have extracted it into.
    let status = null;
    let statusError = '';
    try {
      status = JSON.parse(
        execFileSync(process.execPath, ['helper/siwc-helper.js', '--status'], {
          cwd: helperHome,
          env: runEnv,
          encoding: 'utf8',
          timeout: 30_000,
        }),
      );
    } catch (err) {
      statusError = (err && err.message) || String(err);
    }
    check('it starts and answers --status', !!status, statusError);
    if (status) {
      const helperVersion = JSON.parse(fs.readFileSync(path.join(REPO, 'helper/package.json'), 'utf8')).version;
      check('it reports its own version', status.version === helperVersion, `${status.version} vs ${helperVersion}`);
      check('it is not signed in on a fresh machine', status.signedIn === false, String(status.signedIn));
      check('it says no credential file exists yet', status.credentialFile && status.credentialFile.exists === false, JSON.stringify(status.credentialFile));
      check('it reads no credential file without writing one', !fs.existsSync(path.join(helperHome, 'config', 'credentials.json')));
    }

    let help = '';
    try {
      help = execFileSync(process.execPath, ['helper/siwc-helper.js', '--help'], { cwd: helperHome, env: runEnv, encoding: 'utf8', timeout: 30_000 });
    } catch (err) {
      help = `FAILED: ${(err && err.message) || err}`;
    }
    check('it documents how to run it', /--port/.test(help) && /--status/.test(help) && /--sign-out/.test(help));

    // The two halves have to be able to find each other: the extension defaults
    // to this URL, so the helper has to default to the same port.
    const constants = fs.readFileSync(path.join(helperHome, 'helper', 'lib', 'constants.js'), 'utf8');
    const helperPort = (constants.match(/DEFAULT_PORT\s*=\s*(\d+)/) || [])[1];
    const shared = fs.readFileSync(path.join(app, 'src', 'shared', 'constants.js'), 'utf8');
    const extUrl = (shared.match(/CHATGPT_HELPER_DEFAULT_URL\s*=\s*'([^']+)'/) || [])[1];
    check('the two halves agree on where the helper lives', !!helperPort && extUrl === `http://127.0.0.1:${helperPort}`, `helper port ${helperPort}, extension ${extUrl}`);
  } else {
    check('the helper could be run', false, 'the helper archive is missing');
  }

  console.log(`\n[3] Chrome accepts it\n`);
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

    console.log(`\n[4] the side panel runs from the packaged copy\n`);
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

    // A brand-new user must be offered both ways to connect, and the one that
    // needs nothing installed has to be the one they land on. If the packaging
    // dropped a pane or the mode logic failed to run, the wizard shows a dead
    // end here.
    const modes = await panel.eval(`(() => {
      const seg = document.getElementById('su-modes');
      const btns = seg ? Array.from(seg.querySelectorAll('.seg-btn')) : [];
      const pane = (id) => { const n = document.getElementById(id); return n ? !n.classList.contains('hidden') : null; };
      return JSON.stringify({
        offered: btns.map(b => b.dataset.mode),
        on: btns.filter(b => b.classList.contains('is-on')).map(b => b.dataset.mode),
        chatgpt: pane('su-chatgpt'),
        apiKey: pane('su-apikey'),
        signIn: !!document.getElementById('su-cg-signin'),
        model: !!document.getElementById('su-cg-model'),
        pill: !!document.getElementById('btn-conn'),
        pillLabel: (document.getElementById('conn-label') || {}).textContent || '',
      });
    })()`);
    const m = JSON.parse(modes);
    check('both routes are offered, ChatGPT first', m.offered.join(',') === 'chatgpt,apiKey', m.offered.join(','));
    check('ChatGPT (the primary route) is selected on a fresh install', m.on.join(',') === 'chatgpt', m.on.join(','));
    check('exactly one pane is open, and it is the ChatGPT one', m.chatgpt === true && m.apiKey === false, JSON.stringify(m));
    check('the ChatGPT pane is wired, not just markup', m.signIn && m.model, JSON.stringify(m));
    check('the header shows the connection state', m.pill && m.pillLabel.length > 0, m.pillLabel);

    // Switching must not be a one-way door: the other method's saved answer has
    // to still be there when you come back.
    const roundTrip = await panel.eval(`(() => {
      const seg = document.getElementById('su-modes');
      const click = (mode) => seg.querySelector('[data-mode="' + mode + '"]').click();
      click('chatgpt');
      const a = { chatgpt: !document.getElementById('su-chatgpt').classList.contains('hidden'),
                  apiKey: !document.getElementById('su-apikey').classList.contains('hidden') };
      click('apiKey');
      const b = { chatgpt: !document.getElementById('su-chatgpt').classList.contains('hidden'),
                  apiKey: !document.getElementById('su-apikey').classList.contains('hidden') };
      return JSON.stringify({ a, b });
    })()`);
    const rt = JSON.parse(roundTrip);
    check('switching to ChatGPT opens its pane and closes the other', rt.a.chatgpt === true && rt.a.apiKey === false, JSON.stringify(rt.a));
    check('switching back restores the key pane', rt.b.apiKey === true && rt.b.chatgpt === false, JSON.stringify(rt.b));
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
