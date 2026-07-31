/**
 * Every Node suite, in one command:
 *
 *   npm run build && node tests/all.mjs
 *
 * Why this exists (audit, 2026-07-31): the gates were a LIST IN A DOC, run by
 * hand and by memory. Two suites — `voices-smoke` (red since v0.0.88, nine
 * failures) and `power-smoke` (red since the Node 22 move, six) — sat failing
 * for dozens of versions because nothing ran them and nobody noticed. A list
 * cannot fail; a runner can. Exit code is non-zero if ANY suite is red, and
 * the summary names which.
 *
 * The browser drives are NOT here: they need the Mac test bridge
 * (`.vibe/measure.sh`, see docs/rendering-host.md) and a built `dist/`, so
 * they stay a separate, explicitly-invoked pass.
 */

import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Everything that runs under bare node: *-smoke.mjs plus the named gates.
// Discovered rather than listed, so a NEW suite is run the day it lands.
const EXCLUDE = new Set(['all.mjs']);
const isDrive = (name) => name.endsWith('-drive.mjs');
const suites = readdirSync(HERE)
  .filter((name) => name.endsWith('.mjs') && !EXCLUDE.has(name) && !isDrive(name))
  .sort();

// page-boot first (a blank page makes every other result meaningless), then
// the rest alphabetically.
suites.sort((a, b) => (a === 'page-boot.mjs' ? -1 : b === 'page-boot.mjs' ? 1 : a.localeCompare(b)));

const run = (name) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HERE, name)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { out += chunk; });
    child.on('close', (code) => resolve({ name, code, out }));
  });

const results = [];
for (const name of suites) {
  const result = await run(name);
  const tail = result.out.trim().split('\n').filter(Boolean).pop() || '(no output)';
  results.push({ ...result, tail });
  console.log(`${result.code === 0 ? 'ok  ' : 'FAIL'} ${name.padEnd(24)} ${tail.slice(0, 90)}`);
}

const failed = results.filter((r) => r.code !== 0);
console.log(`\n${results.length - failed.length}/${results.length} suites green`);
if (failed.length) {
  for (const f of failed) {
    console.error(`\n──── ${f.name} ────\n${f.out.trim().split('\n').slice(-25).join('\n')}`);
  }
  process.exit(1);
}
