#!/usr/bin/env node
'use strict';

/**
 * Static checks for the install guidance: the in-panel "macOS blocked the
 * installer?" help, the hard-coded Download for Mac link, and the public docs.
 * No browser, no network.
 */

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `  (${detail})` : ''}`); }
}

const manifest = JSON.parse(read('manifest.json'));
const helperPkg = JSON.parse(read('helper/package.json'));
const version = manifest.version;
const html = read('src/sidepanel/sidepanel.html');
const consts = read('src/shared/constants.js');
const build = read('tools/helper-installer/build-macos-pkg.sh');

console.log('\n[1] versions and the Download for Mac link agree');
check('manifest and helper package share a version', helperPkg.version === version, `${helperPkg.version} vs ${version}`);
check('helper reports the same version', read('helper/siwc-helper.js').includes(`HELPER_VERSION = '${version}'`));
const dl = (consts.match(/CONNECTOR_DOWNLOAD_URL = '([^']+)'/) || [])[1] || '';
const rel = (consts.match(/CONNECTOR_RELEASE_URL = '([^']+)'/) || [])[1] || '';
check('download URL is on this repository\'s release for this version', dl.startsWith(`https://github.com/Employee-Zero/whatsapp-sales-ai-copilot/releases/download/v${version}/`), dl);
check('release page URL is this version\'s tag', rel === `https://github.com/Employee-Zero/whatsapp-sales-ai-copilot/releases/tag/v${version}`, rel);
const pkgNameInBuild = (build.match(/PKG_NAME="([^"]+)"/) || [])[1] || '';
const expectedName = pkgNameInBuild.replace('${HELPER_VERSION}', version).replace('${ARCH}', 'arm64');
check('the built PKG filename is exactly the one the extension links to', dl.endsWith(`/${expectedName}`), `${expectedName}`);

console.log('\n[2] in-panel help for a blocked installer');
for (const P of ['su', 'cfg']) {
  const m = html.match(new RegExp(`<details id="${P}-cg-blocked"[\\s\\S]*?</details>`));
  check(`${P}: a collapsed help block exists next to Download`, !!m && !/<details[^>]*\sopen/.test(m[0]));
  const t = m ? m[0] : '';
  check(`${P}: it names the real macOS path and button`, /Privacy &amp; Security/.test(t) && /Open Anyway/.test(t));
  check(`${P}: it is short (3 steps)`, (t.match(/<li>/g) || []).length === 3);
  check(`${P}: it never suggests weakening macOS protection`, !/spctl|xattr|master-disable|Terminal|sudo|Gatekeeper/i.test(t));
}

console.log('\n[3] public docs are not stale');
const guide = read('docs/GETTING_STARTED.md');
const readme = read('README.md');
const privacy = read('PRIVACY.md');
for (const [name, text] of [['README', readme], ['Getting Started', guide], ['Privacy', privacy]]) {
  check(`${name}: no spctl / xattr / Gatekeeper-off advice`, !/spctl|xattr|master-disable/i.test(text.replace(/never[^\n]*(spctl|xattr)[^\n]*/gi, '')));
}
check('README no longer says an API key is required', !/require[s]? (either )?your own API key/i.test(readme) && /no API key/i.test(readme));
check('README names the Connector requirement and platform', /Apple Silicon/.test(readme) && /ChatGPT Connector/.test(readme));
check('Getting Started starts from the Chrome extension, then offers both options', guide.indexOf('Step 1') < guide.indexOf('Option A') && guide.indexOf('Option A') < guide.indexOf('Option B'));
check('Getting Started documents Open Anyway', /Open Anyway/.test(guide));
check('Getting Started explains the backup is opt-in', /off by default/i.test(guide));
check('Privacy is for this version', privacy.includes(`**Version:** ${version}`));
check('Privacy mentions the Connector', /ChatGPT Connector/.test(privacy));
check('Privacy no longer says there is no login', !/no login to this project/i.test(privacy) || /not.*OpenAI/i.test(privacy));
for (const f of [guide, readme]) {
  const imgs = [...f.matchAll(/assets\/([\w.-]+\.png)/g)].map((x) => x[1]);
  check('every image referenced exists', imgs.every((i) => fs.existsSync(path.join(root, 'docs/assets', i))), imgs.join(','));
}

console.log(`\n========================================================\n  PASS: ${pass}   FAIL: ${fail}\n========================================================`);
process.exit(fail ? 1 : 0);
