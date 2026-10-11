/**
 * Credential storage.
 *
 * The one rule this file exists to enforce: **tokens live here and nowhere
 * else.** The Sign-in-with-ChatGPT documentation is unambiguous — "Keep tokens
 * out of browser storage, source control, logs, analytics, and support
 * transcripts" — and the extension obeys it by never being handed a token at
 * all. The browser talks to this process; this process talks to OpenAI.
 *
 * Concretely:
 *   - directory mode 0700, file mode 0600, created with the mode at open time
 *     so there is no window where the file is world-readable;
 *   - atomic replace (write temp in the same directory, then `rename`), so a
 *     crash mid-write cannot leave a truncated credential file behind;
 *   - `redact()` for anything that is about to be printed.
 *
 * On Windows the POSIX mode bits are accepted and ignored by Node, which is a
 * real limitation rather than something to paper over: the file then inherits
 * the profile directory's ACLs. `describeProtection()` says which of the two
 * happened, and the helper prints it at startup.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STORE_VERSION = 1;
const FILE_NAME = 'credentials.json';
const DIR_NAME = 'whatsapp-sales-ai-copilot';

/**
 * Where the credential file lives.
 *
 * `WHATSAPP_COPILOT_HOME` overrides it, which is what `tools/test-helper.js`
 * uses to point at a temporary directory. Without that, a test run would write
 * over a real sign-in.
 *
 * @returns {string}
 */
function storeHome() {
  const override = process.env.WHATSAPP_COPILOT_HOME;
  if (override) return path.resolve(override);
  const xdg = process.env.XDG_CONFIG_HOME;
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), DIR_NAME);
  }
  return path.join(xdg && xdg.trim() ? xdg : path.join(os.homedir(), '.config'), DIR_NAME);
}

/** @returns {string} absolute path of the credential file */
function storeFile() {
  return path.join(storeHome(), FILE_NAME);
}

/** An empty store. */
function emptyStore() {
  return { version: STORE_VERSION, hostId: '', activeAccount: '', accounts: {} };
}

/**
 * Read the credential file.
 *
 * A missing file is normal (nothing has been signed in yet) and yields an empty
 * store. A *corrupt* file is not normal, and is reported rather than silently
 * replaced: overwriting it would destroy the only copy of a refresh token that
 * may still be revocable, and quietly starting over hides the fact that
 * something went wrong.
 *
 * @returns {{store: object, existed: boolean}}
 * @throws {Error} code STORE_CORRUPT
 */
function readStore() {
  const file = storeFile();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { store: emptyStore(), existed: false };
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const e = new Error(`The credential file is not valid JSON: ${file}`);
    e.code = 'STORE_CORRUPT';
    throw e;
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.accounts !== 'object' || parsed.accounts === null) {
    const e = new Error(`The credential file has an unexpected shape: ${file}`);
    e.code = 'STORE_CORRUPT';
    throw e;
  }
  const store = Object.assign(emptyStore(), parsed);
  store.version = STORE_VERSION;
  return { store, existed: true };
}

/**
 * Replace the credential file atomically.
 *
 * @param {object} store
 */
function writeStore(store) {
  const dir = storeHome();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdirSync's mode is masked by umask; chmod is what actually pins it.
  tryChmod(dir, 0o700);

  const file = storeFile();
  const tmp = path.join(dir, `.${FILE_NAME}.${process.pid}.tmp`);
  const body = `${JSON.stringify(store, null, 2)}\n`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  tryChmod(tmp, 0o600);
  fs.renameSync(tmp, file);
  tryChmod(file, 0o600);
}

/** @param {string} target @param {number} mode */
function tryChmod(target, mode) {
  try {
    fs.chmodSync(target, mode);
  } catch (err) {
    /* Windows, or a filesystem that does not carry POSIX modes. */
  }
}

/**
 * Whether the credential file is actually owner-only on this machine.
 *
 * Reported at startup instead of assumed. On Windows the answer is "no", and a
 * user is entitled to know that before they sign in rather than after. A file
 * that does not exist yet reports `exists: false`, so "not created yet" is never
 * mistaken for "created and world-readable".
 *
 * @returns {{path: string, exists: boolean, ownerOnly: boolean, note: string}}
 */
function describeProtection() {
  const file = storeFile();
  if (process.platform === 'win32') {
    return {
      path: file,
      exists: fs.existsSync(file),
      ownerOnly: false,
      note: 'Windows does not use POSIX file modes; the file inherits the ACL of your user profile directory.',
    };
  }
  try {
    const mode = fs.statSync(file).mode & 0o777;
    return {
      path: file,
      exists: true,
      ownerOnly: (mode & 0o077) === 0,
      note: `mode ${mode.toString(8).padStart(3, '0')}`,
    };
  } catch (err) {
    return { path: file, exists: false, ownerOnly: true, note: 'not created yet; it will be created 0600' };
  }
}

/**
 * Delete the credential file.
 *
 * Used only after a revocation attempt has been made and its outcome recorded,
 * so "signed out" and "revocation unconfirmed" can be told apart.
 */
function deleteStore() {
  try {
    fs.unlinkSync(storeFile());
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }
}

/**
 * A copy of a credential record with every secret replaced by a short marker.
 *
 * Nothing in this codebase should ever need the raw record in a log line, so the
 * only way to get one is to ask for it explicitly by name.
 *
 * @param {object} account
 * @returns {object}
 */
function redact(account) {
  const a = account || {};
  return {
    label: a.label || '',
    email: a.email || '',
    sub: a.sub || '',
    clientId: a.clientId || '',
    scope: a.scope || '',
    expiresAt: a.expiresAt || 0,
    hasAccessToken: !!a.accessToken,
    hasRefreshToken: !!a.refreshToken,
    hasIdToken: !!a.idToken,
  };
}

/**
 * The key a registration is stored under.
 *
 * The account's `sub` is the stable identifier the documentation says to use for
 * identity, and the docs warn that an email can appear on more than one
 * registration. So `sub` is the key and the email is only ever a label.
 *
 * @param {string} sub
 * @returns {string}
 */
function accountKey(sub) {
  const s = String(sub || '').trim();
  return s ? `sub:${s}` : '';
}

export {
  STORE_VERSION,
  storeHome,
  storeFile,
  emptyStore,
  readStore,
  writeStore,
  deleteStore,
  describeProtection,
  redact,
  accountKey,
};
