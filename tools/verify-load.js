#!/usr/bin/env node
/**
 * Verify that the extension is loaded in the target Chrome profile, and report
 * what the profile actually contains.
 *
 * Reads the profile's Preferences / Secure Preferences directly — no Chrome
 * interaction, no remote debugging required. Read-only: never writes to the
 * profile.
 *
 * Usage: node tools/verify-load.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const EXT_PATH = path.resolve(__dirname, '..');
const PROFILE_DIR = path.join(
  os.homedir(),
  'Library/Application Support/Google/Chrome/Profile 1',
);

function extensionIdFor(p) {
  return crypto
    .createHash('sha256')
    .update(p)
    .digest('hex')
    .slice(0, 32)
    .split('')
    .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
    .join('');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return null;
  }
}

const expectedId = extensionIdFor(EXT_PATH);

console.log('=== Extension load verification ===\n');
console.log('Extension path :', EXT_PATH);
console.log('Expected ID    :', expectedId);
console.log('Profile        :', PROFILE_DIR);
console.log('Profile exists :', fs.existsSync(PROFILE_DIR) ? 'yes' : 'NO');
console.log();

if (!fs.existsSync(PROFILE_DIR)) {
  console.log('RESULT: BLOCKED — cannot read the target Chrome profile.');
  process.exit(2);
}

const prefs = readJson(path.join(PROFILE_DIR, 'Preferences'));
const securePrefs = readJson(path.join(PROFILE_DIR, 'Secure Preferences'));

if (!prefs) {
  console.log('RESULT: BLOCKED — Preferences unreadable (TCC / Full Disk Access?).');
  process.exit(2);
}

// Collect extension entries from both files; unpacked extensions live in
// Preferences, and the HMAC-signed Secure Preferences mirror may also list them.
const settings = Object.assign(
  {},
  (securePrefs && securePrefs.extensions && securePrefs.extensions.settings) || {},
  (prefs.extensions && prefs.extensions.settings) || {},
);

const entries = Object.entries(settings);
console.log(`Extensions recorded in the profile: ${entries.length}\n`);

let found = null;
for (const [id, value] of entries) {
  const loc = value && value.location;
  // location 4 = LOAD_UNPACKED (a.k.a. "Unpacked"), 2 = external, 1 = internal
  const locName =
    { 1: 'internal', 2: 'external', 3: 'external-policy', 4: 'unpacked', 5: 'component' }[loc] || `loc=${loc}`;
  const p = (value && value.path) || '';
  const marker = id === expectedId ? '  <== THIS EXTENSION' : '';
  console.log(`  ${id}  ${locName.padEnd(12)} ${p}${marker}`);
  if (id === expectedId) found = value;
}

console.log();

if (!prefs.extensions || !prefs.extensions.settings || !Object.keys(prefs.extensions.settings).length) {
  console.log(
    'NOTE: Preferences contains no extension entries. This is expected when the\n' +
      '      profile is currently locked by a running Chrome — Chrome holds the\n' +
      '      live copy in memory and writes it on clean exit. Close Chrome and\n' +
      '      re-run this script for an accurate reading.',
  );
  console.log();
}

if (found) {
  console.log('RESULT: LOADED');
  console.log('  Extension ID  :', expectedId);
  console.log('  Location      :', found.location === 4 ? 'unpacked' : found.location);
  console.log('  Path          :', found.path);
  console.log('  Version       :', (found.manifest && found.manifest.version) || 'unknown');
  console.log('  Side panel    :', `chrome-extension://${expectedId}/src/sidepanel/sidepanel.html`);
  process.exit(0);
}

console.log('RESULT: NOT LOADED (or profile locked — see NOTE above)');
console.log();
console.log('To load it manually (one-time, ~20 seconds):');
console.log('  1. Open Chrome on the "AI" profile');
console.log('  2. Go to  chrome://extensions');
console.log('  3. Enable "Developer mode" (top right)');
console.log('  4. Click "Load unpacked"');
console.log('  5. Select:  ' + EXT_PATH);
process.exit(1);
