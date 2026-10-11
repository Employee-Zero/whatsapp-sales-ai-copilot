#!/usr/bin/env node
/**
 * Build the ZIP that goes on the GitHub Release.
 *
 * Development tooling — not part of the extension.
 *
 * ## Two archives, because there are two things to install
 *
 * `whatsapp-sales-ai-copilot-<version>.zip` is the extension. What ships in it is
 * deliberately tiny: the manifest and `src/`, minus `src/test/`. Everything a
 * user installs is code the extension actually runs, and nothing else. That
 * keeps three things out of the download that have no business in it:
 *
 *   - `tools/`, which is Node.js testing machinery a salesperson will never run;
 *   - `src/test/`, the dev bridge and the screenshot harness, which exist to
 *     drive the extension from outside and would be dead weight (and a wider
 *     surface) in a shipped build;
 *   - the repository itself — no `.git`, no docs, no screenshots, no history.
 *
 * `whatsapp-sales-ai-copilot-helper-<version>.zip` is the local helper, and it
 * exists only for the ChatGPT-subscription connection method, which cannot work
 * without it. It is a separate download on purpose: a Node program has no place
 * inside a browser extension's package, the API-key method needs neither the
 * download nor Node, and putting the two together would make everyone pay for a
 * feature most of them do not use.
 *
 * The helper archive keeps the `helper/` prefix, so extracting it next to the
 * extension produces exactly the path the panel tells the user to run.
 *
 * Both builds are checked, not assumed: every file the manifest names must be in
 * the extension archive, the extension archive must contain nothing that is not
 * either the manifest or under `src/`, and the helper archive must contain a
 * runnable entry point.
 *
 *   node tools/build-release.js
 *   node tools/build-release.js --out /tmp
 */

'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'manifest.json'), 'utf8'));

/** Every file the extension loads at runtime, straight from the manifest. */
function runtimeFiles() {
  const named = new Set(['manifest.json']);

  named.add(manifest.background.service_worker);
  named.add(manifest.side_panel.default_path);
  for (const cs of manifest.content_scripts || []) for (const js of cs.js || []) named.add(js);
  for (const war of manifest.web_accessible_resources || []) for (const r of war.resources || []) named.add(r);
  // The side panel's own assets are not listed in the manifest; they sit beside
  // its HTML and are referenced by it.
  for (const asset of ['src/sidepanel/sidepanel.js', 'src/sidepanel/sidepanel.css']) named.add(asset);
  for (const icon of Object.values(manifest.icons || {})) named.add(icon);
  for (const icon of Object.values((manifest.action && manifest.action.default_icon) || {})) named.add(icon);

  return [...named].sort();
}

/** Everything under src/ that is not development-only. */
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'test' || entry.name === 'node_modules') continue;
      walk(full, out);
    } else if (entry.isFile()) {
      out.push(path.relative(REPO, full));
    }
  }
  return out;
}

/** The helper's own files, kept under their `helper/` prefix. */
function helperFiles() {
  return walk(path.join(REPO, 'helper')).sort();
}

function main() {
  const outDir = path.resolve(process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : path.join(REPO, 'dist'));
  fs.mkdirSync(outDir, { recursive: true });

  const name = `whatsapp-sales-ai-copilot-${manifest.version}.zip`;
  const dest = path.join(outDir, name);

  const files = [...new Set(['manifest.json', ...walk(path.join(REPO, 'src'))])].sort();

  // A missing runtime file is the failure mode that produces a ZIP which
  // installs and then does nothing, so it is caught here rather than by a user.
  const missing = runtimeFiles().filter((f) => !files.includes(f));
  if (missing.length) {
    console.error(`refusing to build — the manifest names files that do not exist:\n  ${missing.join('\n  ')}`);
    process.exit(1);
  }

  const strays = files.filter((f) => f !== 'manifest.json' && !f.startsWith('src/'));
  if (strays.length) {
    console.error(`refusing to build — unexpected top-level files:\n  ${strays.join('\n  ')}`);
    process.exit(1);
  }

  fs.rmSync(dest, { force: true });
  execFileSync('zip', ['-q', '-X', '-9', dest, ...files], { cwd: REPO });

  const bytes = fs.statSync(dest).size;
  console.log(`  ${files.length} files, ${(bytes / 1024).toFixed(0)} KB`);
  console.log(`  → ${dest}`);

  // --- the helper ----------------------------------------------------------
  const helperDest = path.join(outDir, `whatsapp-sales-ai-copilot-helper-${manifest.version}.zip`);
  const hFiles = helperFiles();

  // The same class of failure as a missing runtime file: an archive without its
  // entry point extracts cleanly and then cannot be started, and the user has no
  // way to tell that from having done something wrong.
  const required = ['helper/siwc-helper.js', 'helper/package.json', 'helper/lib/oauth.js', 'helper/lib/responses.js', 'helper/lib/store.js', 'helper/lib/pkce.js', 'helper/lib/guard.js', 'helper/lib/errors.js', 'helper/lib/constants.js'];
  const hMissing = required.filter((f) => !hFiles.includes(f));
  if (hMissing.length) {
    console.error(`refusing to build — the helper is incomplete:\n  ${hMissing.join('\n  ')}`);
    process.exit(1);
  }
  const hStrays = hFiles.filter((f) => !f.startsWith('helper/'));
  if (hStrays.length) {
    console.error(`refusing to build — unexpected files in the helper archive:\n  ${hStrays.join('\n  ')}`);
    process.exit(1);
  }

  fs.rmSync(helperDest, { force: true });
  execFileSync('zip', ['-q', '-X', '-9', helperDest, ...hFiles], { cwd: REPO });

  const hBytes = fs.statSync(helperDest).size;
  console.log(`  ${hFiles.length} files, ${(hBytes / 1024).toFixed(0)} KB`);
  console.log(`  → ${helperDest}`);

  console.log('\n  Verify both before publishing:');
  console.log(`    node tools/verify-release.js ${path.relative(REPO, dest)}`);
}

main();
