#!/usr/bin/env node
/**
 * Which Chromium build the browser-driving tools should use.
 *
 * Not the installed Google Chrome. Since Chrome 137, the stable build refuses
 * `--load-extension` outright — it prints "--load-extension is not allowed in
 * Google Chrome, ignoring" and starts with no extension at all, which looks
 * exactly like a broken extension. Chrome for Testing is the same browser under
 * a build that still permits the flag, so an unpacked extension can be loaded
 * into a throwaway profile without going through a file picker by hand.
 *
 * Override with CHROME_BIN.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RELATIVE = [
  'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-linux/chrome',
];

/**
 * @returns {string} path to a browser that will load an unpacked extension
 */
function findBrowser() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;

  const roots = [
    path.join(os.homedir(), 'Library/Caches/ms-playwright'),
    path.join(os.homedir(), '.cache/ms-playwright'),
  ];

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    // Newest build first — the side panel API needs a reasonably recent Chrome.
    const builds = fs
      .readdirSync(root)
      .filter((d) => d.startsWith('chromium-'))
      .sort()
      .reverse();
    for (const build of builds) {
      for (const rel of RELATIVE) {
        const bin = path.join(root, build, rel);
        if (fs.existsSync(bin)) return bin;
      }
    }
  }

  return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
}

/** Refuse to drive a browser that cannot load what we are about to give it. */
function assertCanLoadExtensions(browser) {
  if (/Google Chrome\.app/.test(browser)) {
    throw new Error(
      'only Chrome for Testing (or Chromium) will load an unpacked extension from the command line;\n' +
        '  the stable Google Chrome build ignores --load-extension. Set CHROME_BIN to a suitable binary.',
    );
  }
  if (!fs.existsSync(browser)) throw new Error(`no browser to drive — looked for ${browser}`);
}

module.exports = { findBrowser, assertCanLoadExtensions };
