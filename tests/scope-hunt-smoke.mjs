/**
 * The scope and the piano roll, against the five faults a 2026-11-06 hunt
 * found — run with:
 *   node tests/scope-hunt-smoke.mjs
 *
 * Each case runs in its own Node process: the modules read window/document
 * globals at import time, and the cases need different ones. Each was red
 * on v0.0.304:
 *  1. a hidden scope canvas (0×0) re-measured from its BACKING store, so it
 *     grew by the pixel ratio on every draw (600×240 → 9600×3840);
 *  2. the piano roll did the same (1000×400 → 8000×3200);
 *  3. the legend's "second double-click restores the selection" died in the
 *     app, because the page echoes every change back through setTracks;
 *  4. the piano roll's lamps were built once: a track added later had none,
 *     a removed one kept its lamp;
 *  5. after the engine rebuilt its AudioContext the traces kept reading the
 *     closed one (the scope listened only for 'state');
 *  6. the scope ran at 30 fps whatever the Processor tier asked (v0.0.307).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (code) => {
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', code.replaceAll('__ROOT__', ROOT)], { encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
};
const CASES = {
  "r1": "// A: a live scope whose canvas goes display:none (rect 0, clientWidth 0) re-measures its CSS size from the BACKING store.\nconst ros = [];\nglobalThis.window = { devicePixelRatio: 2, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) };\nglobalThis.ResizeObserver = class { constructor(cb) { this.cb = cb; ros.push(this); } observe() {} disconnect() {} };\nconst scope = await import('__ROOT__/src/scripts/scope.js');\nconst ctx = new Proxy({}, { get: (t, p) => (p in t ? t[p] : () => ({ width: 10 })), set: (t, p, v) => ((t[p] = v), true) });\nlet hidden = false;\nconst canvas = { width: 300, height: 150,\n  get clientWidth() { return hidden ? 0 : 300; }, get clientHeight() { return hidden ? 0 : 120; },\n  getContext: () => ctx, getBoundingClientRect: () => (hidden ? { width: 0, height: 0 } : { width: 300, height: 120 }),\n  addEventListener() {}, removeEventListener() {} };\nconst an = { fftSize: 2048, getFloatTimeDomainData(b) { for (let i = 0; i < b.length; i++) b[i] = Math.sin(i / 9) * 0.3; } };\nconst h = scope.attachMultiScope(canvas, { running: true, getAnalysers: () => ({ pad: an }), on: () => () => {} }, { tracks: ['pad'] });\nconst before = [canvas.width, canvas.height];\nhidden = true;\nfor (let i = 1; i <= 4; i++) ros[ros.length - 1].cb([]);\nconsole.log(JSON.stringify({ before, after: [canvas.width, canvas.height] }));\nh.destroy();\n",
  "r2": "const ros = [];\nglobalThis.window = { devicePixelRatio: 2, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) };\nglobalThis.ResizeObserver = class { constructor(cb) { this.cb = cb; ros.push(this); } observe() {} disconnect() {} };\nconst { initVisualiser } = await import('__ROOT__/src/scripts/visualiser.js');\nconst ctx = new Proxy({}, { get: (t, p) => (p in t ? t[p] : () => ({ width: 10 })), set: (t, p, v) => ((t[p] = v), true) });\nlet hidden = false;\nconst canvas = { width: 300, height: 150,\n  get clientWidth() { return hidden ? 0 : 500; }, get clientHeight() { return hidden ? 0 : 200; },\n  getContext: () => ctx, getBoundingClientRect: () => (hidden ? { width: 0, height: 0 } : { width: 500, height: 200 }) };\nconst v = initVisualiser(canvas, { running: false, on: () => () => {}, now: () => 0 });\nconst before = [canvas.width, canvas.height];\nhidden = true;\nfor (let i = 1; i <= 3; i++) ros[0].cb([]);\nconsole.log(JSON.stringify({ before, after: [canvas.width, canvas.height] }));\nv.destroy();\n",
  "r3": "// B: the page echoes every onSelectionChange back through handle.setTracks() (applySelection -> updateFrontScope),\n// and setTracks() clears preSoloSelection, so the documented \"second double-click restores\" never fires in the app.\nfunction el(tag) {\n  const e = { tag, children: [], attrs: {}, style: {}, listeners: {}, textContent: '',\n    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k]; },\n    appendChild(c) { this.children.push(c); return c; }, removeChild(c) { this.children = this.children.filter((x) => x !== c); },\n    addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }, removeEventListener(t, f) { this.listeners[t] = (this.listeners[t] || []).filter((x) => x !== f); },\n    dispatch(t, ev = {}) { for (const f of this.listeners[t] || []) f(ev); } };\n  Object.defineProperty(e, 'textContent', { get() { return e._t || ''; }, set(v) { e._t = v; if (v === '') e.children = []; } });\n  return e;\n}\nglobalThis.document = { createElement: el, hidden: false, addEventListener() {}, removeEventListener() {} };\nglobalThis.window = { devicePixelRatio: 1, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) };\nconst scope = await import('__ROOT__/src/scripts/scope.js');\nconst ctx = new Proxy({}, { get: (t, p) => (p in t ? t[p] : () => ({ width: 10 })), set: (t, p, v) => ((t[p] = v), true) });\nconst canvas = { width: 300, height: 120, clientWidth: 300, clientHeight: 120, getContext: () => ctx,\n  getBoundingClientRect: () => ({ width: 300, height: 120 }), addEventListener() {}, removeEventListener() {} };\nconst legend = el('div');\nconst out = {};\nfor (const echo of [false, true]) {\n  let handle;\n  handle = scope.attachMultiScope(canvas, { running: false, on: () => () => {} }, {\n    tracks: ['pad', 'bass', 'melody'], legendContainer: legend,\n    onSelectionChange: (ids) => { if (echo) handle.setTracks(ids); }, // the page's path\n  });\n  const btn = (id) => legend.children.find((b) => b.children[1].textContent === id);\n  const pressed = () => legend.children.filter((b) => b.attrs['aria-pressed'] === 'true').map((b) => b.children[1].textContent);\n  btn('melody').dispatch('dblclick');\n  const afterSolo = pressed().join(',');\n  btn('melody').dispatch('dblclick');\n  out[echo ? 'echo' : 'plain'] = { afterSolo, restored: pressed().join(',') };\n  handle.destroy();\n}\nconsole.log(JSON.stringify(out));\n",
  "r4": "// C: refreshTracks() re-lanes the roll but never rebuilds the lamp buttons, which are the ONLY lane labels when a lamp host exists.\nfunction el(tag) {\n  const e = { tag, children: [], dataset: {}, attrs: {}, style: {}, parentNode: null, textContent: '',\n    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k]; },\n    appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); this.children.push(c); c.parentNode = this; return c; },\n    insertBefore(c, ref) { if (c.parentNode) c.parentNode.removeChild(c); const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); c.parentNode = this; return c; },\n    removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; },\n    remove() { this.parentNode?.removeChild(this); },\n    addEventListener() {}, removeEventListener() {}, get nextSibling() { return null; } };\n  return e;\n}\nglobalThis.document = { createElement: el, hidden: false, addEventListener() {}, removeEventListener() {} };\nglobalThis.window = { devicePixelRatio: 1, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) };\nglobalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });\nconst { initVisualiser } = await import('__ROOT__/src/scripts/visualiser.js');\nconst fills = [];\nconst ctx = new Proxy({}, { get: (t, p) => (p in t ? t[p] : p === 'fillText' ? (s) => fills.push(s) : () => ({ width: 10 })), set: (t, p, v) => ((t[p] = v), true) });\nconst root = el('div');\nconst canvas = Object.assign(el('canvas'), { width: 600, height: 300, clientWidth: 600, clientHeight: 300, getContext: () => ctx, getBoundingClientRect: () => ({ width: 600, height: 300 }) });\nroot.appendChild(canvas);\nconst six = ['pad', 'arp', 'melody', 'bass', 'texture', 'percussion'].map((id) => ({ id, label: id }));\nlet reg = six;\nconst engine = { running: false, on: () => () => {}, now: () => 0, getTracks: () => reg };\nconst v = initVisualiser(canvas, engine);\nconst lamps = () => canvas.parentNode.children.filter((c) => c.tag === 'button' && c.dataset.track).map((c) => c.dataset.track);\nconst before = lamps();\nreg = [...six, { id: 'user-1', label: 'Strings' }];\nv.refreshTracks();\nconst added = lamps();\nreg = six.filter((t) => t.id !== 'texture');\nv.refreshTracks();\nconsole.log(JSON.stringify({ before, added, removed: lamps() }));\nv.destroy();\n",
  "r7": "// G: engine.resume() -> rebuildContext() swaps every analyser and emits only 'rebuilt'. The multi-scope never re-fetches.\nconst rafs = new Map(); let id = 0;\nglobalThis.requestAnimationFrame = (cb) => { rafs.set(++id, cb); return id; };\nglobalThis.cancelAnimationFrame = (i) => rafs.delete(i);\nglobalThis.window = { devicePixelRatio: 1, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) };\nconst scope = await import('__ROOT__/src/scripts/scope.js');\nconst ctx = new Proxy({}, { get: (t, p) => (p in t ? t[p] : () => ({ width: 10 })), set: (t, p, v) => ((t[p] = v), true) });\nconst canvas = { width: 300, height: 120, clientWidth: 300, clientHeight: 120, getContext: () => ctx, getBoundingClientRect: () => ({ width: 300, height: 120 }), addEventListener() {}, removeEventListener() {} };\nconst reads = { old: 0, fresh: 0 };\nconst mk = (tag) => ({ fftSize: 8192, getFloatTimeDomainData(b) { reads[tag]++; b.fill(tag === 'old' ? 0 : 0.3); } });\nlet graph = { pad: mk('old'), total: mk('old') };\nconst handlers = {};\nconst engine = { running: true, getAnalysers: () => graph, on: (t, f) => { (handlers[t] ||= []).push(f); return () => {}; } };\nconst h = scope.attachMultiScope(canvas, engine, { tracks: ['pad'], totalAnalyser: graph.total });\nh.setTotalVisible(true);\nconst step = (ts) => { const c = [...rafs.values()]; rafs.clear(); c.forEach((f) => f(ts)); };\nstep(0);\ngraph = { pad: mk('fresh'), total: mk('fresh') }; // rebuildContext(): new nodes\nfor (const f of handlers.rebuilt || []) f({});      // the only event emitted\n// the page then runs updateAllScopeModes -> updateFrontScope: key unchanged -> no setTracks / re-attach\nreads.old = reads.fresh = 0;\nfor (let i = 1; i <= 10; i++) step(i * 40);\nconsole.log(JSON.stringify(reads));\nh.destroy();\n"
};


const FPS_CASE = `
const rafs = new Map(); let id = 0;
globalThis.requestAnimationFrame = (cb) => { rafs.set(++id, cb); return id; };
globalThis.cancelAnimationFrame = (i) => rafs.delete(i);
globalThis.window = { devicePixelRatio: 1, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) };
const scope = await import('__ROOT__/src/scripts/scope.js');
let draws = 0;
const ctx = new Proxy({}, { get: (t, p) => (p in t ? t[p] : () => ({ width: 10 })), set: (t, p, v) => ((t[p] = v), true) });
const canvas = { width: 300, height: 120, clientWidth: 300, clientHeight: 120, getContext: () => ctx, getBoundingClientRect: () => ({ width: 300, height: 120 }), addEventListener() {}, removeEventListener() {} };
const an = { fftSize: 2048, getFloatTimeDomainData(b) { draws++; for (let i = 0; i < b.length; i++) b[i] = Math.sin(i / 9) * 0.3; } };
const engine = { running: true, getAnalysers: () => ({ pad: an }), on: () => () => {} };
const count = (fps) => {
  if (typeof scope.setScopeFps === 'function') scope.setScopeFps(fps);
  const h = scope.attachMultiScope(canvas, engine, { tracks: ['pad'] });
  draws = 0;
  // 1 ms frames for two seconds, so the frame gate is not quantised by the
  // display's own rate.
  for (let f = 1; f <= 2000; f++) { const c = [...rafs.values()]; rafs.clear(); c.forEach((cb) => cb(f)); }
  h.destroy();
  return draws;
};
console.log(JSON.stringify({ full: count(30), low: count(24), eco: count(5), hasApi: typeof scope.setScopeFps === 'function' }));
`;
const tests = [
  ['a hidden scope canvas keeps its backing size (no growth by the pixel ratio)', () => {
    const r = run(CASES.r1);
    assert.deepEqual(r.after, r.before);
  }],
  ['a hidden piano roll keeps its backing size', () => {
    const r = run(CASES.r2);
    assert.deepEqual(r.after, r.before);
  }],
  ['the legend\'s second double-click restores the selection, even with the page echoing it back', () => {
    const r = run(CASES.r3);
    assert.equal(r.plain.afterSolo, 'melody');
    assert.equal(r.echo.afterSolo, 'melody');
    assert.equal(r.echo.restored, r.plain.restored);
    assert.equal(r.echo.restored.split(',').length, 3);
  }],
  ['the piano roll\'s lamps follow a track added and a track removed', () => {
    const r = run(CASES.r4);
    assert.ok(r.added.includes('user-1'), JSON.stringify(r.added));
    assert.ok(!r.removed.includes('texture'), JSON.stringify(r.removed));
    assert.equal(r.removed.length, 5);
  }],
  ['the scope draws at the Processor tier\'s frame rate (Low asks 24, not the fixed 30)', () => {
    const r = run(FPS_CASE);
    assert.equal(r.hasApi, true, 'scope.js has no setScopeFps');
    assert.ok(r.low < r.full * 0.9, `Low drew ${r.low} frames to Full's ${r.full}`);
    assert.ok(r.eco < r.low / 2, `a 5 fps cap drew ${r.eco}`);
  }],
  ['after the engine rebuilds its AudioContext the traces read the NEW analysers', () => {
    const r = run(CASES.r7);
    assert.equal(r.old, 0, 'still reading the closed context');
    assert.ok(r.fresh > 0, 'never read the rebuilt one');
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
