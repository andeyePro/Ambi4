/**
 * The power governor against four faults a 2026-11-06 audit found — run with:
 *   node tests/power-hunt-smoke.mjs
 *
 * Each case runs in its own Node process with a fake clock, rAF, document,
 * PressureObserver and battery (the audit's harness). Each was red on
 * v0.0.307's governor:
 *  1. under a load that depends on the tier (too much at Full, fine at Med)
 *     the tier flipped every 10–14 s for ever;
 *  2. a late pulse counted while the tab was hidden (throttled timers, a
 *     sleep) stepped the tier down on return and held raises for 30 s;
 *  3. auto → pin → auto before getBattery() answered left a battery listener
 *     attached after destroy();
 *  4. the engine was sent maxNotes alone, which lifted its reverb cap.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = "// scratch harness for power.js\nlet now = 1_000_000, nextT = 1; const timers = new Map();\nglobalThis.setTimeout = (fn, d = 0) => { const id = nextT++; timers.set(id, { at: now + Math.max(0, d), fn }); return id; };\nglobalThis.clearTimeout = (id) => timers.delete(id);\nDate.now = () => now;\nlet rafCbs = new Map(), rafId = 1, rafOn = true;\nconst installRaf = () => { globalThis.requestAnimationFrame = (cb) => { const id = rafId++; rafCbs.set(id, cb); return id; }; globalThis.cancelAnimationFrame = (id) => rafCbs.delete(id); };\ninstallRaf();\nlet frameMs = 16;\nfunction advance(ms, frameFn) {\n  const target = now + ms;\n  for (;;) {\n    let due = null; for (const [id, t] of timers) if (t.at <= target && (!due || t.at < due[1].at)) due = [id, t];\n    if (!due) break; timers.delete(due[0]); now = due[1].at; due[1].fn();\n    if (!doc.hidden && rafCbs.size) { let p = [...rafCbs.values()]; rafCbs.clear(); p.forEach(c => c(0)); p = [...rafCbs.values()]; rafCbs.clear(); p.forEach(c => c(frameFn ? frameFn() : frameMs)); }\n  }\n  now = target;\n}\nconst listeners = new Map();\nconst doc = { hidden: false, addEventListener(t, f) { (listeners.get(t) || listeners.set(t, new Set()).get(t)).add(f); }, removeEventListener(t, f) { listeners.get(t)?.delete(f); } };\nglobalThis.document = doc;\nconst setHidden = (h) => { doc.hidden = h; for (const f of listeners.get('visibilitychange') || []) f(); };\nlet pressureCb = null, pressureDisconnects = 0;\nglobalThis.PressureObserver = class { constructor(cb) { pressureCb = cb; } observe() { return Promise.resolve(); } disconnect() { pressureDisconnects++; } };\nconst battListeners = new Set();\nconst battery = { charging: true, addEventListener(t, f) { battListeners.add(f); }, removeEventListener(t, f) { battListeners.delete(f); } };\nlet batteryResolvers = [];\nObject.defineProperty(globalThis, 'navigator', { value: { hardwareConcurrency: 8, deviceMemory: 8, getBattery: () => new Promise(r => batteryResolvers.push(r)) }, configurable: true });\nconst { createGovernor } = await import('__ROOT__/src/scripts/power.js');\nconst engineMock = { late: 0, budgets: [], getStats() { return { late: { count: this.late } }; }, setPowerBudget(b) { this.budgets.push(b); } };\nconst log = []; const t0 = now;\nconst mk = () => createGovernor({ engine: engineMock, onTierChange: (b) => log.push(`${((now - t0) / 1000).toFixed(0)}s:${b.tier}`) });\nconst flush = () => new Promise(r => setImmediate(r));\n";
const CASES = {
  "osc": "\nconst g = mk(); g.setTier('auto');\nadvance(30000, () => 15);\nconst mark = log.length;\nadvance(180000, () => (g.stats().tier === 'full' ? 45 : 15));\nconsole.log(JSON.stringify({ changes: log.slice(mark) }));\n",
  "hidden": "\nconst g = mk(); advance(40000, () => 16);\nconst before = g.stats().tier;\nsetHidden(true); advance(5 * 60000); engineMock.late += 1;\nconst mark = log.length;\nsetHidden(false); advance(60000, () => 16);\nconsole.log(JSON.stringify({ before, after: g.stats().tier, changes: log.slice(mark) }));\n",
  "battery": "\nconst g = mk(); g.setTier('low'); g.setTier('auto');\nbatteryResolvers.forEach((r) => r(battery)); await flush(); await flush();\ng.destroy();\nconsole.log(JSON.stringify({ listeners: battListeners.size }));\n",
  "budget": "\nconst g = mk(); g.setTier('low');\nconst last = engineMock.budgets[engineMock.budgets.length - 1] || {};\nconsole.log(JSON.stringify({ reverbSeconds: last.reverbSeconds ?? null, maxNotes: last.maxNotes ?? null }));\ng.destroy();\n"
};
const run = (name) => {
  const code = (BASE + CASES[name]).replaceAll('__ROOT__', ROOT);
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
};

const tests = [
  ['a tier the load drove out of is not raised straight back into (the flips die away)', () => {
    const { changes } = run('osc');
    assert.ok(changes.length <= 4, `the tier changed ${changes.length} times in three minutes: ${changes.join(' ')}`);
  }],
  ['lateness counted while the tab was hidden does not step the tier down on return', () => {
    const r = run('hidden');
    assert.deepEqual(r.changes, [], `the tier moved after returning (${r.before} before): ${r.changes.join(' ')}`);
  }],
  ['destroy() leaves no battery listener behind, however the lookups raced', () => {
    assert.equal(run('battery').listeners, 0);
  }],
  ['the engine is sent the tier\'s reverb cap with its note cap', () => {
    assert.equal(run('budget').reverbSeconds, 2, 'Low caps the reverb at 2 s');
  }],
];

let failures = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`FAIL ${name}\n     ${String(e.message).split('\n')[0]}`);
  }
}
console.log(`\n${tests.length - failures}/${tests.length} passed`);
process.exit(failures ? 1 : 0);
