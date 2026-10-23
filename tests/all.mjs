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
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Everything that runs under bare node: *-smoke.mjs plus the named gates.
// Discovered rather than listed, so a NEW suite is run the day it lands.
const EXCLUDE = new Set(['all.mjs']);
// A drive is a browser test: its default export is run by the Mac bridge and
// importing it under bare node proves nothing. Three of them are named
// *-render.mjs, so the name alone is not enough — onset-render, the click
// guard every voice is held to, was being "passed" here by merely loading.
const isDrive = (name) =>
  name.endsWith('-drive.mjs') ||
  /^export default (async )?function drive\b/m.test(readFileSync(path.join(HERE, name), 'utf8'));
const suites = readdirSync(HERE)
  .filter((name) => name.endsWith('.mjs') && !EXCLUDE.has(name) && !isDrive(name))
  .sort();

// page-boot first (a blank page makes every other result meaningless), then
// the rest alphabetically.
suites.sort((a, b) => (a === 'page-boot.mjs' ? -1 : b === 'page-boot.mjs' ? 1 : a.localeCompare(b)));

// Peak memory per suite (2026-10-23): page-boot was OOM-killed on the 8 GB box
// with nothing in the output saying it had grown, so each suite's line now
// carries its wall time and its peak resident set. The peak is the largest
// VmHWM (the kernel's own high-water mark) of the suite's process or any
// process under it — page-boot re-runs itself in a child — sampled every
// quarter second. Linux /proc only; elsewhere the column is simply absent.
const peakKb = (pid) => {
  let peak = 0;
  const visit = (id) => {
    try {
      const hwm = /VmHWM:\s+(\d+)/.exec(readFileSync(`/proc/${id}/status`, 'utf8'));
      if (hwm) peak = Math.max(peak, Number(hwm[1]));
      for (const kid of readFileSync(`/proc/${id}/task/${id}/children`, 'utf8').split(/\s+/).filter(Boolean)) visit(kid);
    } catch {}
  };
  visit(pid);
  return peak;
};

const run = (name) =>
  new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(HERE, name)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let kb = 0;
    const sampler = setInterval(() => { kb = Math.max(kb, peakKb(child.pid)); }, 250);
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { out += chunk; });
    child.on('close', (code) => {
      clearInterval(sampler);
      resolve({ name, code, out, ms: Date.now() - started, mb: Math.round(kb / 1024) });
    });
  });

const results = [];
for (const name of suites) {
  const result = await run(name);
  const tail = result.out.trim().split('\n').filter(Boolean).pop() || '(no output)';
  results.push({ ...result, tail });
  const secs = `${(result.ms / 1000).toFixed(1)}s`.padStart(7);
  const mem = result.mb ? `${result.mb} MB`.padStart(8) : '';
  console.log(`${result.code === 0 ? 'ok  ' : 'FAIL'} ${name.padEnd(24)} ${secs}${mem}  ${tail.slice(0, 90)}`);
}

const failed = results.filter((r) => r.code !== 0);
const totalSecs = (results.reduce((sum, r) => sum + r.ms, 0) / 1000).toFixed(1);
const maxMb = Math.max(0, ...results.map((r) => r.mb || 0));
console.log(`\n${results.length - failed.length}/${results.length} suites green in ${totalSecs}s` + (maxMb ? `, largest peak ${maxMb} MB` : ''));
if (failed.length) {
  for (const f of failed) {
    console.error(`\n──── ${f.name} ────\n${f.out.trim().split('\n').slice(-25).join('\n')}`);
  }
  process.exit(1);
}
