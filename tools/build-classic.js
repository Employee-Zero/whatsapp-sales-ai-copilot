#!/usr/bin/env node
'use strict';

/**
 * Regenerate the `*.classic.js` copies of the shared modules.
 *
 * `src/shared/constants.js` and `src/shared/utils.js` are ES modules: the service
 * worker imports them (`"type": "module"`) and the dev bridge `import()`s them.
 * The content script and the side panel are classic scripts, where a single
 * `export` statement aborts the whole file with `Unexpected token 'export'` —
 * every constant in it then silently becomes `undefined`.
 *
 * So each shared module ships twice: the module itself, and a classic copy with
 * the `import` lines and the trailing `export { … }` block removed. The
 * declarations are identical either way, which is why the copy is generated
 * rather than hand-maintained.
 *
 * Forgetting to re-run this is a silent failure: new constants simply do not
 * exist on the page side. Run it after every edit to a shared module.
 *
 *   node tools/build-classic.js           # write the copies
 *   node tools/build-classic.js --check   # fail if a copy is stale
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/** @type {Array<[string, string]>} source → generated copy, both repo-relative */
const PAIRS = [
  ['src/shared/constants.js', 'src/shared/constants.classic.js'],
  ['src/shared/utils.js', 'src/shared/utils.classic.js'],
];

/**
 * Strip the ESM-only syntax from a shared module.
 *
 * Only two things are removed, and both are unambiguous: `import … from '…';`
 * lines at the top, and the final `export { … };` block. Anything else — every
 * declaration, every comment — is carried over verbatim so the copy can be read
 * as the same file.
 *
 * @param {string} source
 * @returns {string}
 */
function toClassic(source) {
  const withoutImports = source.replace(/^import\s+\{[^}]*\}\s+from\s+'[^']*';\s*$/gm, '');
  const exportAt = withoutImports.lastIndexOf('\nexport {');
  if (exportAt === -1) {
    throw new Error('no `export {` block found — refusing to write a copy that still has exports');
  }
  const banner = [
    '/*',
    ' * GENERATED FILE — do not edit.',
    ' *',
    ' * Classic-script copy of the module next to it, for the content script and',
    ' * the side panel. Regenerate with:  node tools/build-classic.js',
    ' */',
    '',
  ].join('\n');
  return banner + withoutImports.slice(0, exportAt).replace(/^\s*\n/, '') + '\n';
}

function main() {
  const check = process.argv.includes('--check');
  let stale = 0;

  for (const [src, dst] of PAIRS) {
    const source = fs.readFileSync(path.join(ROOT, src), 'utf8');
    const expected = toClassic(source);
    const current = fs.existsSync(path.join(ROOT, dst)) ? fs.readFileSync(path.join(ROOT, dst), 'utf8') : null;

    if (current === expected) {
      console.log(`  = ${dst} (up to date)`);
      continue;
    }
    if (check) {
      stale++;
      console.error(`  ! ${dst} is stale — run: node tools/build-classic.js`);
      continue;
    }
    fs.writeFileSync(path.join(ROOT, dst), expected);
    console.log(`  + ${dst} regenerated from ${src}`);
  }

  if (check && stale) process.exit(1);
}

main();
