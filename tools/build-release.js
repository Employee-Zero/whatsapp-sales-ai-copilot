#!/usr/bin/env node
/**
 * Build the ZIP that goes on the GitHub Release.
 *
 * Development tooling — not part of the extension.
 *
 * What ships is deliberately tiny: the manifest and `src/`, minus `src/test/`.
 * Everything a user installs is code the extension actually runs, and nothing
 * else. That keeps three things out of the download that have no business in it:
 *
 *   - `tools/`, which is Node.js testing machinery a salesperson will never run;
 *   - `src/test/`, the dev bridge and the screenshot harness, which exist to
 *     drive the extension from outside and would be dead weight (and a wider
 *     surface) in a shipped build;
 *   - the repository itself — no `.git`, no docs, no screenshots, no history.
 *
 * The build is checked, not assumed: every file the manifest names must be in
 * the archive, and the archive must contain nothing that is not either the
 * manifest or under `src/`.
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

  return [...named].sort();
}

/** Everything under src/ that is not development-only. */
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'test') continue;
      walk(full, out);
    } else if (entry.isFile()) {
      out.push(path.relative(REPO, full));
    }
  }
  return out;
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
  console.log('\n  Verify it installs before publishing:');
  console.log(`    node tools/verify-release.js ${path.relative(REPO, dest)}`);
}

main();
