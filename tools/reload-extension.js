/**
 * Reload the unpacked extension inside a Chrome instance running with
 * --remote-debugging-port, then reload WhatsApp Web so the new content scripts
 * are injected.
 *
 * Chrome keeps the extension id of an unpacked extension in
 * `Profile N/Secure Preferences` → `extensions.settings.<id>.path`. We read that
 * file to discover the id instead of guessing (the id is a hash of the path and
 * of the profile's salt, so it differs between profiles).
 *
 * Usage: node tools/reload-extension.js --profile-dir <path> [--port 9222] [--profile "Profile 1"]
 *
 * `--profile-dir` is required and has no default. It must be the user-data-dir of
 * a Chrome that was started with --remote-debugging-port, which by Chrome 154's
 * rules cannot be the default `~/Library/Application Support/Google/Chrome`.
 * See AGENTS.md §2 and §4.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listTargets, connect } = require('./cdp.js');

const args = process.argv.slice(2);
function arg(name, dflt) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}

const PORT = Number(arg('port', '9222'));
const PROFILE_DIR = arg('profile-dir', '');
const PROFILE = arg('profile', 'Profile 1');
const EXT_PATH = arg('ext-path', path.resolve(__dirname, '..'));

/** Where Chrome keeps its user data when no --user-data-dir is given. */
function defaultUserDataDir() {
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library/Application Support/Google/Chrome');
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Google/Chrome/User Data');
  }
  return path.join(home, '.config/google-chrome');
}

/**
 * Refuse the cases that cannot work, up front and by name.
 *
 * There is deliberately no default profile dir: the one this script used to
 * carry was a throwaway test profile that no longer exists, and silently
 * pointing at a banned profile is worse than failing.
 */
function assertUsableProfileDir() {
  if (!PROFILE_DIR) {
    throw new Error(
      'Missing --profile-dir.\n' +
        '  CDP needs a non-default user-data-dir (Chrome 154), so there is no safe default.\n' +
        '  See AGENTS.md §2 and §4.',
    );
  }
  if (path.resolve(PROFILE_DIR) === path.resolve(defaultUserDataDir())) {
    throw new Error(
      `--profile-dir points at the default user-data-dir, where Chrome 154 refuses ` +
        `to open a debug port.\n  ${defaultUserDataDir()}\n` +
        '  Use a dedicated CDP profile instead — see AGENTS.md §4.',
    );
  }
}

/** Find the extension id whose recorded `path` matches EXT_PATH. */
function findExtensionId() {
  const file = path.join(PROFILE_DIR, PROFILE, 'Secure Preferences');
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  const settings = (json.extensions && json.extensions.settings) || {};
  for (const [id, v] of Object.entries(settings)) {
    if (v && v.location === 4 && v.path === EXT_PATH) return id;
  }
  return null;
}

async function main() {
  assertUsableProfileDir();
  const id = findExtensionId();
  if (!id) throw new Error(`No unpacked extension found for path ${EXT_PATH} in ${PROFILE_DIR}/${PROFILE}`);
  console.log(`extension id: ${id}`);

  const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const browser = await connect(version.webSocketDebuggerUrl);

  // Chrome's devtools protocol refuses Extensions.loadUnpacked on a *packed*
  // extension; the documented flow is to load the unpacked path, which for an
  // already-loaded path is a no-op reload.
  try {
    await browser.send('Extensions.loadUnpacked', { path: EXT_PATH });
    console.log('Extensions.loadUnpacked OK');
  } catch (e) {
    console.log('Extensions.loadUnpacked failed:', e.message);
    console.log('This Chrome build does not expose that domain; falling back to a service-worker wake + page reload.');
  }
  await new Promise((r) => setTimeout(r, 1500));

  const targets = await listTargets(PORT);
  const wa = targets.find((t) => t.type === 'page' && /web\.whatsapp\.com/.test(t.url || ''));
  if (wa) {
    const c = await connect(wa.webSocketDebuggerUrl);
    await c.send('Page.enable', {});
    await c.send('Page.reload', { ignoreCache: true });
    console.log('WhatsApp Web reloaded — content scripts re-injected');
    c.close();
  } else {
    console.log('No WhatsApp Web tab found');
  }
  browser.close();
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
