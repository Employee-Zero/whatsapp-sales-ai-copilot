#!/usr/bin/env node
'use strict';

/**
 * Open exactly one dev-bridge tab in the Chrome profile you are already using.
 *
 * The bridge page is a script like any other: Chrome serves it from the copy it
 * cached when the page loaded, so editing `bridge.js` or `panel-probe.classic.js`
 * has no effect until the page is reloaded. Doing that by hand means finding the
 * tab, and it is easy to end up with two of them — the test server hands each
 * command to whichever page polls first, so a stale second tab makes results
 * depend on timing.
 *
 * This closes any existing bridge tab and opens a fresh one. It talks to Chrome
 * through AppleScript and never touches any other tab, window or profile.
 *
 *   node tools/open-bridge.js
 *
 * macOS only, and only for development. Nothing in the shipped extension uses it.
 */

const { execFileSync } = require('child_process');
const path = require('path');

const BRIDGE_PATH = 'src/test/bridge.html';

/** The extension id, derived the same way Chrome derives it (see compute-extension-id.js). */
function extensionId() {
  const out = execFileSync(process.execPath, [path.join(__dirname, 'compute-extension-id.js')], {
    encoding: 'utf8',
  });
  const m = out.match(/Extension ID\s*:\s*(\S+)/);
  if (!m) throw new Error('could not read the extension id from compute-extension-id.js');
  return m[1];
}

/** Run an AppleScript snippet and return its stdout. */
function osa(script) {
  return execFileSync('osascript', ['-e', script], { encoding: 'utf8' }).trim();
}

function main() {
  const url = `chrome-extension://${extensionId()}/${BRIDGE_PATH}`;

  // Close only tabs whose URL is this extension's bridge page — matched by URL,
  // never by position, so nothing else in the window can be hit by accident.
  //
  // Closing inside a `repeat with t in tabs` loop invalidates the iteration, so
  // this re-scans for the first match after every close instead. A window whose
  // only tab matches is left alone rather than closed.
  const closed = osa(`
    set n to 0
    tell application "Google Chrome"
      repeat with w in windows
        repeat
          set tabList to tabs of w
          if (count of tabList) is 1 then exit repeat
          set hit to 0
          repeat with i from 1 to (count of tabList)
            if URL of (item i of tabList) starts with "${url}" then
              set hit to i
              exit repeat
            end if
          end repeat
          if hit is 0 then exit repeat
          close (item hit of tabList)
          set n to n + 1
        end repeat
      end repeat
    end tell
    return n
  `);

  osa(`tell application "Google Chrome" to open location "${url}"`);
  console.log(`closed ${closed} stale bridge tab(s)`);
  console.log(`opened ${url}`);
  console.log('give it a second, then run a test script — it starts its own server.');
}

main();
