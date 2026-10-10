#!/usr/bin/env node
/**
 * Compute the Chrome extension ID that an unpacked extension will receive.
 *
 * Chrome derives it from the SHA-256 of the extension's ABSOLUTE PATH:
 *   - take the first 16 bytes of sha256(path)
 *   - map each hex character 0..f onto a..p
 *
 * Knowing the ID lets us confirm the load worked by reading the profile's
 * Preferences, and lets us open chrome-extension://<id>/... for smoke tests.
 *
 * Usage: node tools/compute-extension-id.js [path]
 */

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const REPO_ROOT = path.join(__dirname, '..');

/**
 * @param {string} target absolute or relative directory
 * @returns {string} the 32-character extension ID Chrome will assign
 */
function extensionIdFor(target) {
  // Chrome hashes the path it is handed, and resolves symlinks before doing so.
  // On macOS that matters: /tmp and /var are symlinks into /private, so a
  // guessed id for a temp directory is wrong until the path is resolved.
  const resolved = fs.existsSync(target) ? fs.realpathSync(target) : path.resolve(target);
  const digest = crypto.createHash('sha256').update(resolved).digest('hex');
  return digest
    .slice(0, 32)
    .split('')
    .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
    .join('');
}

module.exports = { extensionIdFor, REPO_ROOT };

// Only print when run directly, so other tools can require the helper.
if (require.main !== module) return;

const target = path.resolve(process.argv[2] || REPO_ROOT);

if (!fs.existsSync(target)) {
  console.error(`Path does not exist: ${target}`);
  process.exit(1);
}

const id = extensionIdFor(target);

console.log('Extension path :', target);
console.log('Extension ID   :', id);
console.log('Side panel URL :', `chrome-extension://${id}/src/sidepanel/sidepanel.html`);
console.log('Options-less   : (no options page — settings live in the side panel)');
console.log();
console.log('Verify the load by running:');
console.log(`  node tools/verify-load.js`);
