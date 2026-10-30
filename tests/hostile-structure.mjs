/**
 * A hostile share link, opened — its STRUCTURES this time. Run with:
 *   npm run build && node tests/hostile-structure.mjs
 *
 * tests/hostile-link.mjs tampers every scalar a link carries. This suite
 * tampers everything else: every non-scalar field the page holds — top level
 * (customStructure, harmony, routing, sampling, stepRule, lfo1, patches,
 * userTracks, and arp/tracks themselves), the arp's (steps, additive), and
 * every track's (sequencers, sequencer, lanes, macroPatch, voiceRule,
 * voiceWeights, walkHold, grooveRule, motif, motifRule, variantRule,
 * fillRule, …) — with each of null, "x", [], {}, [null] and [{}]; then single
 * ENTRIES inside the lists (a step with midi 999, prob "x", a step that is an
 * array, a sequencer that is a string, a structure block with no label, …).
 *
 * The engine deep-sanitises every one of these; the page's own copy passes
 * through deepMerge and the page's lighter normalisers, and the page DRAWS
 * its copy (a step grid reads step.midi, prob, vmin straight off it). So per
 * boot:
 *   - the page boots: no "Ambi4 init failed", no fallback;
 *   - no readout, aria-valuetext or step-cell label says NaN / undefined /
 *     Infinity;
 *   - opening every track's editor (queries scoped to #voice-editor-<track>)
 *     raises no window error and no console.error;
 *   - the page's copy of each tampered structure (as the next Save writes it)
 *     deep-equals the ENGINE's copy (getParams()), except where the two
 *     differ on purpose — each such field named in NOT_MIRRORED with its
 *     reason, and calibrated on the untouched link;
 *   - the next Save stores nothing the engine would reject: the engine's own
 *     sanitiseParams, run over the saved tree, hands each tampered structure
 *     back unchanged.
 *
 * Fields are batched per boot (one hostile value × one scope: top level, arp,
 * or one track) for time, but every assertion names its field; a batch that
 * does not boot is re-run one field per boot so the failure is attributable.
 * Whole-tree links carry every value (a null in a compact DIFF means "remove
 * the key", and {} merges as nothing); a compact pass then sends "x" and [{}]
 * through the diff branch, and one stored-generator pass sends them through
 * prefs. One case runs the other way: a page-only `voiceDrafts` on the link
 * must SURVIVE the reconcile (the engine has no such key; a reconcile that
 * dropped every key the engine lacks wiped it).
 *
 * Boot machinery: hostile-link.mjs's — about:blank first, a fresh JSDOM per
 * boot, the shared prefs Map emptied between boots, a seeded Math.random
 * (CLAUDE.md "Traps").
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';
import { spawnSync } from 'node:child_process';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(repoRoot, 'dist');
const indexHtml = join(distDir, 'index.html');
if (!existsSync(indexHtml)) {
  console.error('hostile-structure: dist/index.html is missing — run `npm run build` first.');
  process.exit(1);
}
const html = readFileSync(indexHtml, 'utf8');
const scriptMatch = /<script[^>]*type="module"[^>]*src="([^"]+)"/.exec(html);
if (!scriptMatch) {
  console.error('hostile-structure: no module script in dist/index.html');
  process.exit(1);
}
const bundlePath = join(distDir, scriptMatch[1].replace(/^\//, ''));

// --------------------------------------------------------------------------
// Shards. Every boot imports the bundle afresh and a jsdom window does not
// give all of its memory back, so ~150 boots in one process run out of heap.
// This file therefore runs itself as SHARD_COUNT child processes, one after
// another (never concurrently — CLAUDE.md, one gate at a time), each taking
// every SHARD_COUNT-th case; the parent only collects and reports.
// --------------------------------------------------------------------------
const SHARD_COUNT = 12;
const SHARD = process.env.HOSTILE_STRUCTURE_SHARD || '';
if (!SHARD) {
  const results = [];
  for (let k = 0; k < SHARD_COUNT; k++) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ...process.env, HOSTILE_STRUCTURE_SHARD: `${k}/${SHARD_COUNT}` },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    const line = (child.stdout || '').split('\n').find((l) => l.startsWith('HS-RESULT '));
    for (const l of (child.stdout || '').split('\n')) if (l && !l.startsWith('HS-RESULT ')) console.log(l);
    if (!line) {
      results.push({ boots: 0, ran: 0, failedCases: [`shard ${k}`], failures: [`shard ${k}/${SHARD_COUNT} died (exit ${child.status}${child.signal ? `, ${child.signal}` : ''}): ${(child.stderr || '').trim().split('\n').slice(-6).join(' | ').slice(0, 600)}`] });
      continue;
    }
    results.push(JSON.parse(line.slice('HS-RESULT '.length)));
  }
  const boots = results.reduce((n, r) => n + r.boots, 0);
  const ran = results.reduce((n, r) => n + r.ran, 0);
  const failures = results.flatMap((r) => r.failures);
  const failedCases = results.flatMap((r) => r.failedCases);
  const head = results.find((r) => r.structures) || {};
  console.log(`hostile-structure: ${head.structures} structures (${head.tracks} tracks) × 6 hostile values, plus list entries — ${ran} of ${head.cases} cases, ${boots} boots, ${SHARD_COUNT} shards`);
  for (const note of head.notes || []) console.log(`  ${note}`);
  if (failures.length) {
    console.error(`hostile-structure FAILED — ${failedCases.length} failing case(s):`);
    for (const f of failures) process.stderr.write(`  - ${f}\n`);
    process.exit(1);
  }
  console.log(`hostile-structure ok — every tampered structure reconciled with the engine across ${boots} boots`);
  process.exit(0);
}

// Determinism: the opening genre and every seed come from Math.random.
let rngState = 0x0badf00d;
Math.random = () => {
  rngState = (rngState + 0x6d2b79f5) | 0;
  let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// "Ambi4 init failed" is a console.error from the bundle, which runs in this
// realm: catch it here.
const consoleErrors = [];
const realError = console.error.bind(console);
{
  const original = realError;
  console.error = (...args) => {
    const line = args.map((a) => (a && a.message ? a.message : String(a))).join(' ');
    consoleErrors.push(line);
    if (process.env.HOSTILE_STRUCTURE_VERBOSE === '1') original(...args);
  };
}

// --------------------------------------------------------------------------
// Stubs (share-roundtrip's)
// --------------------------------------------------------------------------
function stubCanvasContext() {
  const noop = () => {};
  return new Proxy({ canvas: null, measureText: () => ({ width: 0 }),
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    createPattern: () => null,
    getImageData: () => ({ data: new Uint8ClampedArray(4) }) }, {
    get: (target, key) => (key in target ? target[key] : noop),
    set: (target, key, value) => { target[key] = value; return true; },
  });
}
function stubAudioParam(value = 0) {
  const param = { value, defaultValue: value };
  for (const m of ['setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime', 'setTargetAtTime',
    'setValueCurveAtTime', 'cancelScheduledValues', 'cancelAndHoldAtTime']) param[m] = () => param;
  return param;
}
function stubAudioNode(extra = {}) {
  const node = { connect: () => node, disconnect: () => {}, addEventListener: () => {}, removeEventListener: () => {}, ...extra };
  return node;
}
class StubAudioContext {
  constructor() {
    this.state = 'suspended';
    this.currentTime = 0;
    this.sampleRate = 48000;
    this.baseLatency = 0.01;
    this.outputLatency = 0.02;
    this.destination = stubAudioNode({ channelCount: 2 });
    this.listener = {};
  }
  createGain() { return stubAudioNode({ gain: stubAudioParam(1) }); }
  createOscillator() {
    return stubAudioNode({ frequency: stubAudioParam(440), detune: stubAudioParam(0), type: 'sine', start() {}, stop() {}, setPeriodicWave() {} });
  }
  createBufferSource() {
    return stubAudioNode({ buffer: null, playbackRate: stubAudioParam(1), detune: stubAudioParam(0), loop: false, start() {}, stop() {} });
  }
  createBiquadFilter() {
    return stubAudioNode({ type: 'lowpass', frequency: stubAudioParam(350), Q: stubAudioParam(1), gain: stubAudioParam(0), detune: stubAudioParam(0) });
  }
  createStereoPanner() { return stubAudioNode({ pan: stubAudioParam(0) }); }
  createPanner() { return stubAudioNode({ positionX: stubAudioParam(0) }); }
  createDelay() { return stubAudioNode({ delayTime: stubAudioParam(0) }); }
  createConvolver() { return stubAudioNode({ buffer: null, normalize: true }); }
  createDynamicsCompressor() {
    return stubAudioNode({ threshold: stubAudioParam(-24), knee: stubAudioParam(30), ratio: stubAudioParam(12),
      attack: stubAudioParam(0.003), release: stubAudioParam(0.25), reduction: 0 });
  }
  createWaveShaper() { return stubAudioNode({ curve: null, oversample: 'none' }); }
  createAnalyser() {
    return stubAudioNode({ fftSize: 2048, frequencyBinCount: 1024, smoothingTimeConstant: 0.8, minDecibels: -100, maxDecibels: -30,
      getByteTimeDomainData: (a) => a.fill(128), getFloatTimeDomainData: (a) => a.fill(0),
      getByteFrequencyData: (a) => a.fill(0), getFloatFrequencyData: (a) => a.fill(-100) });
  }
  createMediaStreamDestination() { return stubAudioNode({ stream: { getTracks: () => [] } }); }
  createBuffer(channels, length, sampleRate) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { numberOfChannels: channels, length, sampleRate, duration: length / sampleRate, getChannelData: (i) => data[i] };
  }
  createPeriodicWave() { return {}; }
  resume() { this.state = 'running'; return Promise.resolve(); }
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
  addEventListener() {}
  removeEventListener() {}
}

const passthrough = [
  'window', 'document', 'navigator', 'location', 'history', 'localStorage',
  'sessionStorage', 'getComputedStyle', 'matchMedia', 'requestAnimationFrame',
  'cancelAnimationFrame', 'HTMLElement', 'HTMLCanvasElement', 'Element', 'Node',
  'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'PointerEvent',
  'CSS', 'DOMParser', 'Image', 'Blob', 'URL', 'AudioContext',
];
function adoptGlobals(win) {
  for (const key of passthrough) {
    if (win[key] !== undefined) {
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: win[key] });
    }
  }
  globalThis.self = win;
}

const clipboard = { text: '' };
function installClipboard(win) {
  const stub = { writeText: (text) => { clipboard.text = String(text); return Promise.resolve(); } };
  try {
    win.navigator.clipboard = stub;
    if (win.navigator.clipboard !== stub) throw new Error('read-only');
  } catch {
    Object.defineProperty(win.navigator, 'clipboard', { configurable: true, value: stub });
  }
}

async function waitUntil(check, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return check();
}

let bootCount = 0;
/**
 * A fresh jsdom on `url` (after about:blank, so a fragment-only change can
 * never be a same-document navigation), the bundle imported under a query of
 * its own. Resolves to { win, failed } — failed names why the page did not
 * come up, rather than throwing, so one dead boot does not hide the rest.
 */
async function boot(url, label) {
  new JSDOM('', { url: 'about:blank' }).window.close();
  const dom = new JSDOM(html, { url, pretendToBeVisual: true, runScripts: 'outside-only' });
  const win = dom.window;
  const contexts = new WeakMap();
  win.HTMLCanvasElement.prototype.getContext = function getContext() {
    let ctx = contexts.get(this);
    if (!ctx) { ctx = stubCanvasContext(); ctx.canvas = this; contexts.set(this, ctx); }
    return ctx;
  };
  win.HTMLCanvasElement.prototype.toDataURL = () => 'data:,';
  win.AudioContext = StubAudioContext;
  win.OfflineAudioContext = undefined;
  win.devicePixelRatio = 1;
  // jsdom implements no scrolling; an editor that scrolls itself into view
  // would otherwise log "Not implemented" as an error.
  win.scrollTo = () => {};
  win.scrollBy = () => {};
  win.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};
  installClipboard(win);
  adoptGlobals(win);
  bootCount += 1;
  const errorsBefore = consoleErrors.length;
  await import(`${pathToFileURL(bundlePath).href}?hostile-structure-${bootCount}-${label}`);
  const booted = await waitUntil(() => {
    const el = win.document.getElementById('generator-app');
    const un = win.document.getElementById('generator-unavailable');
    return (Boolean(el) && !el.hidden && Boolean(win.__ambi4Engine)) || (un && !un.hidden);
  }, 10000);
  const reasons = [];
  const app = win.document.getElementById('generator-app');
  const un = win.document.getElementById('generator-unavailable');
  if (!booted || !app || app.hidden) reasons.push('#generator-app never unhid');
  if (un && !un.hidden) reasons.push(`fallback showing: ${un.textContent.trim().slice(0, 160)}`);
  const initErrors = consoleErrors.slice(errorsBefore).filter((line) => line.includes('Ambi4 init failed'));
  if (initErrors.length) reasons.push(`init reported: ${initErrors.join(' | ').slice(0, 200)}`);
  return { win, failed: reasons.join('; ') };
}

// The bundle's prefs module is shared by every boot (same chunk URL); before
// consent it is an in-module Map. Emptied before every boot: each is a fresh
// device, unless the case is the stored blob itself.
const prefsChunk = readdirSync(join(distDir, '_astro')).find((f) => /^prefs\..*\.js$/.test(f));
const { prefs } = await import(pathToFileURL(join(distDir, '_astro', prefsChunk)).href);
const PREFS_KEYS = ['generator', 'genre', 'genres', 'hidden', 'layout', 'presets', 'voices'];
const forgetDevice = () => { for (const key of PREFS_KEYS) prefs.remove(key); };

function decodeLink(link) {
  const at = link.indexOf('#p=');
  if (at < 0) return null;
  return JSON.parse(Buffer.from(link.slice(at + 3).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}
function encodePayload(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// --------------------------------------------------------------------------
// What a booted page holds, and what its engine holds
// --------------------------------------------------------------------------
/** The page's settings as the next Save writes them (Save → presets). */
function savedSnapshot(win, name) {
  adoptGlobals(win);
  win.document.getElementById('preset-name').value = name;
  win.document.getElementById('preset-save').click();
  const entry = (prefs.get('presets') || []).find((p) => p.name === name);
  return entry ? structuredClone(entry.params) : null;
}

/** The stored generator prefs, after a harmless commit (a tab switch). */
async function storedGenerator(win) {
  adoptGlobals(win);
  prefs.remove('generator');
  win.document.getElementById('tab-advanced').click();
  await waitUntil(() => prefs.get('generator') != null, 2000);
  const stored = prefs.get('generator');
  return stored ? structuredClone(stored) : null;
}


// Uncaught errors in a handler surface through jsdom's virtual console as a
// console.error (caught above); a rejected promise lands here.
process.on('unhandledRejection', (reason) => {
  consoleErrors.push(`unhandledRejection: ${reason && reason.message ? reason.message : String(reason)}`);
});

// The engine's own sanitiser, from source (the bundle is built from it).
const { sanitiseParams } = await import('../src/scripts/ambient-engine.js');

const BAD_TEXT = /NaN|undefined|Infinity/;
function badReadouts(win) {
  const out = [];
  for (const el of win.document.querySelectorAll('.knob-value')) {
    if (BAD_TEXT.test(el.textContent)) out.push(`${el.closest('[id]')?.id || '?'} readout "${el.textContent.trim()}"`);
  }
  for (const attr of ['aria-valuetext', 'aria-valuenow']) {
    for (const el of win.document.querySelectorAll(`[${attr}]`)) {
      const text = el.getAttribute(attr);
      if (BAD_TEXT.test(text)) out.push(`${el.id || el.closest('[id]')?.id || '?'} ${attr} "${text}"`);
    }
  }
  // The step grids draw the page's copy of every step.
  for (const el of win.document.querySelectorAll('.seq-cell[aria-label]')) {
    const text = el.getAttribute('aria-label');
    if (BAD_TEXT.test(text)) out.push(`${el.closest('[id]')?.id || '?'} step cell "${text}"`);
  }
  return out;
}

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isSpan = (v) => isPlain(v) && 'min' in v && 'max' in v && Object.keys(v).length === 2;
const isStructure = (v) => v !== null && typeof v === 'object' && !isSpan(v);
// Key order is not meaning: a map's keys compare as a set.
const canon = (v) => (Array.isArray(v) ? v.map(canon)
  : isPlain(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const fmt = (v) => {
  const t = JSON.stringify(v);
  if (t === undefined) return 'absent';
  return t.length > 140 ? `${t.slice(0, 140)}…` : t;
};

function getPath(tree, path) {
  let at = tree;
  for (const key of path) {
    if (at === null || typeof at !== 'object' || !(key in at)) return { has: false };
    at = at[key];
  }
  return { has: true, value: at };
}
/** Set `path` in `tree`; plain objects are made on the way, an index into a non-array is skipped. */
function setPath(tree, path, value) {
  let at = tree;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (typeof path[i + 1] === 'number') {
      if (!Array.isArray(at[key])) return false;
    } else if (!isPlain(at[key])) at[key] = {};
    at = at[key];
  }
  at[path[path.length - 1]] = structuredClone(value);
  return true;
}
const label = (path) => path.join('.');

/** The first place two trees differ, as `sub.path: a vs b` — or '' when equal. */
function firstDiff(a, b, at = '') {
  if (same(a, b)) return '';
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = firstDiff(a[key], b[key], at ? `${at}.${key}` : key);
      if (d) return d;
    }
  }
  return `${at || '(whole)'}: ${fmt(a)} vs ${fmt(b)}`;
}

// ==========================================================================
// The sender: a page-minted link on a pinned genre
// ==========================================================================
const failures = [];

forgetDevice();
const senderBoot = await boot('https://ambi4.work/', 'sender');
if (senderBoot.failed) {
  realError(`hostile-structure FAILED — the sender did not boot: ${senderBoot.failed}`);
  process.exit(1);
}
const sender = senderBoot.win;
{
  const select = sender.document.getElementById('genre-select');
  select.value = 'g:synthwave';
  select.dispatchEvent(new sender.Event('change', { bubbles: true }));
  await waitUntil(() => sender.__ambi4Engine.getParams().genre === 'synthwave');
}
adoptGlobals(sender);
clipboard.text = '';
sender.document.getElementById('preset-share').click();
if (!(await waitUntil(() => clipboard.text.includes('#p=')))) {
  realError('hostile-structure FAILED — Share put no link on the clipboard');
  process.exit(1);
}
const mintedPayload = decodeLink(clipboard.text);
const senderSnapshot = savedSnapshot(sender, 'hostile sender');
sender.close();
if (!mintedPayload || !mintedPayload.o || !isPlain(mintedPayload.d) || !senderSnapshot) {
  realError('hostile-structure FAILED — the sender minted no compact link (or Save wrote nothing)');
  process.exit(1);
}

// ==========================================================================
// The fields: every structure the page holds, plus the sparse ones by name
// ==========================================================================
const PAGE_ONLY_TOP = new Set(['origin', 'ui']);
const NAMED_TOP = ['customStructure', 'harmony', 'routing', 'sampling', 'stepRule', 'lfo1', 'patches', 'userTracks', 'arp', 'tracks'];
const NAMED_HARMONY = ['voicing', 'hookRule'];
const NAMED_ARP = ['steps', 'additive'];
const TRACK_IDS = Object.keys(senderSnapshot.tracks);
const PERCUSSIVE = new Set(['percussion']);
const NAMED_TRACK = (id) => [
  'sequencers', 'sequencer', 'macroPatch', 'voiceRule', 'voiceWeights', 'walkHold',
  ...(PERCUSSIVE.has(id) ? ['lanes', 'variantRule', 'fillRule'] : []),
  ...(id === 'bass' ? ['grooveRule'] : []),
  ...(id === 'melody' ? ['motif', 'motifRule'] : []),
];
const structuresOf = (obj) => Object.keys(obj || {}).filter((k) => isStructure(obj[k]));

const GROUPS = new Map(); // group name -> [path]
GROUPS.set('top', [...new Set([...NAMED_TOP, ...structuresOf(senderSnapshot)])]
  .filter((k) => !PAGE_ONLY_TOP.has(k)).map((k) => [k]));
GROUPS.set('harmony', NAMED_HARMONY.map((k) => ['harmony', k]));
GROUPS.set('arp', [...new Set([...NAMED_ARP, ...structuresOf(senderSnapshot.arp)])].map((k) => ['arp', k]));
for (const id of TRACK_IDS) {
  GROUPS.set(`tracks.${id}`, [...new Set([...NAMED_TRACK(id), ...structuresOf(senderSnapshot.tracks[id])])]
    .map((k) => ['tracks', id, k]));
}

const HOSTILE = [
  ['null', null],
  ['"x"', 'x'],
  ['[]', []],
  ['{}', {}],
  ['[null]', [null]],
  ['[{}]', [{}]],
];

// Single entries inside the lists. `at` is what is tampered, `check` the
// structure compared (the list, or the sequencer list holding the step).
const ENTRY_CASES = [];
{
  const firstStep = (id) => (PERCUSSIVE.has(id)
    ? ['tracks', id, 'sequencers', 0, 'steps', 'low', 0]
    : ['tracks', id, 'sequencers', 0, 'steps', 0]);
  for (const id of TRACK_IDS) {
    if (!Array.isArray(senderSnapshot.tracks[id].sequencers)) continue;
    const check = ['tracks', id, 'sequencers'];
    const base = getPath(senderSnapshot, firstStep(id)).value || { on: true, prob: 1, vmin: 0.5, vmax: 0.9 };
    const steps = [
      ['midi 999', { ...base, on: true, midi: 999 }],
      ['midi "60"', { ...base, on: true, midi: '60' }],
      ['prob "x"', { ...base, prob: 'x' }],
      ['prob {min:"a"}', { ...base, prob: { min: 'a', max: 1 } }],
      ['vmin "x" vmax 5', { ...base, vmin: 'x', vmax: 5 }],
      ['gate "x"', { ...base, on: true, gate: 'x' }],
      ['on "yes"', { ...base, on: 'yes' }],
      ['group -3', { ...base, group: -3 }],
      ['an array', [1, 2]],
      ['null', null],
      ['"x"', 'x'],
    ];
    for (const [name, value] of steps) {
      ENTRY_CASES.push({ name: `${id} step 0 = ${name}`, at: firstStep(id), check, value });
    }
    for (const [name, value] of [['null', null], ['"x"', 'x'], ['[]', []], ['{steps:"x"}', { steps: 'x', weights: 'x', mode: 'x' }]]) {
      ENTRY_CASES.push({ name: `${id} sequencer 0 = ${name}`, at: ['tracks', id, 'sequencers', 0], check, value });
    }
    ENTRY_CASES.push({ name: `${id} sequencer 0 weights ["x",-1,null]`, at: ['tracks', id, 'sequencers', 0, 'weights'], check, value: ['x', -1, null] });
  }
  if (Array.isArray(senderSnapshot.tracks.percussion?.lanes)) {
    for (const [name, value] of [['null', null], ['{id:""}', { id: '' }], ['{id:7}', { id: 7, kind: 'x' }]]) {
      ENTRY_CASES.push({ name: `percussion lane 0 = ${name}`, at: ['tracks', 'percussion', 'lanes', 0], check: ['tracks', 'percussion', 'lanes'], value });
    }
  }
  for (const [name, value] of [['null', null], ['{label:"Z"}', { label: 'Z', bars: 4 }], ['{bars:"x"}', { label: 'a', bars: 'x', intensity: 'x', tracks: 'x' }]]) {
    ENTRY_CASES.push({ name: `customStructure 0 = ${name}`, at: ['customStructure', 0], check: ['customStructure'], value });
  }
  ENTRY_CASES.push({ name: 'routing = [{source:"x"}]', at: ['routing'], check: ['routing'], value: [{ source: 'x', destination: 'y' }] });
  ENTRY_CASES.push({ name: 'userTracks = [{id:"x"}]', at: ['userTracks'], check: ['userTracks'], value: [{ id: 'x', family: 'melodic' }] });
}

// ==========================================================================
// Exclusions — a structure whose page copy is NOT the engine's by design.
// Calibrated on the untouched link: anything that disagrees there and is not
// listed here is itself a failure. `*` matches any one path segment.
// ==========================================================================
const NOT_MIRRORED = {
};
const matches = (k, path) => {
  const parts = k.split('.');
  return parts.length === path.length && parts.every((p, i) => p === '*' || p === String(path[i]));
};
// A field whose SHAPE differs on purpose, compared through a view of both
// sides. Each with its reason.
const VIEWS = {
  'tracks.*.lanes': [
    (v) => (Array.isArray(v) ? v.map((l) => (isPlain(l) ? Object.fromEntries(Object.entries(l).filter(([k]) => k !== 'order')) : l)) : v),
    'the engine numbers each lane (order) by its place in the list; the page keeps the list in that order and no number',
  ],
};
function view(path, value) {
  for (const [k, [fn]] of Object.entries(VIEWS)) if (matches(k, path)) return fn(value);
  return value;
}
const excluded = (path) => Object.keys(NOT_MIRRORED).some((k) => {
  const parts = k.split('.');
  return parts.length === path.length && parts.every((p, i) => p === '*' || p === String(path[i]));
});

// ==========================================================================
// One boot, read
// ==========================================================================
async function openAndRead(url, tag) {
  const errorsBefore = consoleErrors.length;
  const { win, failed } = await boot(url, tag);
  if (failed) { win.close(); return { failed }; }
  const windowErrors = [];
  win.addEventListener('error', (e) => windowErrors.push(e.message || String(e.error)));
  const raised = () => consoleErrors.length + windowErrors.length;
  const params = structuredClone(win.__ambi4Engine.getParams());
  const snapshot = savedSnapshot(win, `hostile ${tag}`);
  // Every track's editor, opened; each query scoped to its own editor.
  const editorProblems = [];
  adoptGlobals(win);
  for (const id of Object.keys(params.tracks || {})) {
    const toggle = win.document.getElementById(`voice-edit-toggle-${id}`);
    if (!toggle) continue;
    const consoleAt = consoleErrors.length;
    const windowAt = windowErrors.length;
    try {
      toggle.click();
    } catch (err) {
      editorProblems.push(`${id} editor threw: ${err.message}`);
      continue;
    }
    const opened = await waitUntil(() => {
      const el = win.document.getElementById(`voice-editor-${id}`);
      return Boolean(el && !el.hidden && el.childElementCount > 0);
    }, 1500);
    if (!opened) editorProblems.push(`${id} editor did not open`);
    const said = [...consoleErrors.slice(consoleAt), ...windowErrors.slice(windowAt)];
    if (said.length) editorProblems.push(`${id} editor raised: ${said.slice(0, 2).join(' | ').slice(0, 200)}`);
  }
  const readouts = badReadouts(win);
  const stored = await storedGenerator(win);
  const errors = [...consoleErrors.slice(errorsBefore), ...windowErrors];
  win.close();
  return { params, snapshot, stored, readouts, editorProblems, errors, raised: raised() };
}

/**
 * `tracks` and `arp` as wholes hold scalars too, some of them page-only (or
 * scaled on the way to the engine — hostile-link's NOT_MIRRORED). Replaced
 * whole, they are compared child by child over the keys both sides hold,
 * and the track ids themselves must match.
 */
const SCALAR_NOT_MIRRORED = new Set(['level']);
function expand(path, result) {
  if (path.length !== 1 || (path[0] !== 'tracks' && path[0] !== 'arp')) return [path];
  const page = getPath(result.snapshot, path).value;
  const eng = getPath(result.params, path).value;
  if (!isPlain(page) || !isPlain(eng)) return [path];
  const both = (a, b) => Object.keys(a).filter((k) => k in b);
  if (path[0] === 'arp') return both(page, eng).map((k) => ['arp', k]);
  const out = [];
  for (const id of new Set([...Object.keys(page), ...Object.keys(eng)])) {
    if (!isPlain(page[id]) || !isPlain(eng[id])) { out.push(['tracks', id]); continue; }
    for (const k of both(page[id], eng[id])) if (!SCALAR_NOT_MIRRORED.has(k)) out.push(['tracks', id, k]);
  }
  return out;
}

/** Assertions for one boot over the structures it compares. */
function judge(caseLabel, result, checks) {
  if (result.failed) return [`${caseLabel}: ${result.failed}`];
  const wrong = [];
  if (!result.snapshot) wrong.push('Save wrote nothing');
  if (!result.stored) wrong.push('no stored generator written');
  let resaved = null;
  try {
    resaved = result.snapshot ? sanitiseParams(structuredClone(result.snapshot)) : null;
  } catch (err) {
    wrong.push(`the engine's sanitiser threw on the Save: ${err.message}`);
  }
  for (const path of checks.flatMap((p) => expand(p, result))) {
    if (excluded(path)) continue;
    const page = getPath(result.snapshot, path);
    const eng = getPath(result.params, path);
    const d = (page.has || eng.has) ? firstDiff(view(path, page.value), view(path, eng.value)) : '';
    if (d) wrong.push(`${label(path)} page vs engine — ${d}`);
    if (resaved && page.has) {
      const again = getPath(resaved, path);
      const r = firstDiff(view(path, page.value), view(path, again.value));
      if (r) wrong.push(`${label(path)} the Save vs the engine's reading of it — ${r}`);
    }
    const kept = getPath(result.stored, path);
    if (result.stored && page.has) {
      const k = firstDiff(page.value, kept.value);
      if (k) wrong.push(`${label(path)} the Save vs the stored generator — ${k}`);
    }
  }
  if (result.readouts.length) wrong.push(`readouts: ${result.readouts.slice(0, 4).join(', ')}`);
  for (const p of result.editorProblems) wrong.push(p);
  if (result.errors.length) wrong.push(`errors: ${[...new Set(result.errors)].slice(0, 3).join(' | ').slice(0, 300)}`);
  return wrong.length ? [`${caseLabel}:\n      ${[...new Set(wrong)].slice(0, 30).join('\n      ')}`] : [];
}

const ALL_CHECKS = [...GROUPS.values()].flat();

const wholeTree = (tree) => `https://ambi4.work/#p=${encodePayload({ ...tree, v: mintedPayload.v })}`;
const compact = (d) => `https://ambi4.work/#p=${encodePayload({ ...mintedPayload, d })}`;

// ==========================================================================
// The cases, as one list — each shard runs every SHARD_COUNT-th of them
// ==========================================================================
const CASES = [];
for (const [valueLabel, value] of HOSTILE) {
  for (const [group, paths] of GROUPS) {
    const tree = structuredClone(senderSnapshot);
    for (const path of paths) setPath(tree, path, value);
    const retry = paths.map((path) => {
      const t = structuredClone(senderSnapshot);
      setPath(t, path, value);
      return { path, url: wholeTree(t), checks: [path] };
    });
    CASES.push({ label: `whole ${group} = ${valueLabel}`, url: wholeTree(tree), checks: paths, retry });
  }
}
// The compact branch: a value the diff carries as itself.
for (const [valueLabel, value] of [['"x"', 'x'], ['[{}]', [{}]]]) {
  for (const [group, paths] of GROUPS) {
    const d = structuredClone(mintedPayload.d);
    for (const path of paths) setPath(d, path, value);
    const retry = paths.map((path) => {
      const dd = structuredClone(mintedPayload.d);
      setPath(dd, path, value);
      return { path, url: compact(dd), checks: [path] };
    });
    CASES.push({ label: `compact ${group} = ${valueLabel}`, url: compact(d), checks: paths, retry });
  }
}
// Entries inside lists, one per boot.
for (const c of ENTRY_CASES) {
  const tree = structuredClone(senderSnapshot);
  if (!setPath(tree, c.at, c.value)) continue;
  CASES.push({ label: `entry ${c.name}`, url: wholeTree(tree), checks: [c.check], retry: null });
}
// A tampered STORED generator: every structure below the top two at once.
for (const [valueLabel, value] of [['"x"', 'x'], ['[{}]', [{}]]]) {
  const paths = ALL_CHECKS.filter((p) => !(p.length === 1 && (p[0] === 'tracks' || p[0] === 'arp')));
  const tree = structuredClone(senderSnapshot);
  for (const path of paths) setPath(tree, path, value);
  CASES.push({ label: `stored generator = ${valueLabel}`, url: 'https://ambi4.work/', stored: tree, checks: paths, retry: null });
}
// The other direction: what the page keeps and the engine never sees must
// SURVIVE the reconcile. `voiceDrafts` (edits parked by the leave-guard)
// rides on a link and in a Save; the engine has no such key, and a reconcile
// that dropped every key the engine does not hold would wipe it on load.
{
  const voice = Object.keys(senderSnapshot.patches?.pad || {})[0] || senderSnapshot.tracks.pad.voice;
  const draft = structuredClone(senderSnapshot.patches?.pad?.[voice] || { filter: { cutoff: 1200 } });
  const tree = structuredClone(senderSnapshot);
  tree.voiceDrafts = { pad: { [voice]: draft } };
  CASES.push({ label: 'page-only voiceDrafts survives', url: wholeTree(tree), checks: [], keep: { tree, paths: [['voiceDrafts']] }, retry: null });
}

let boots = 0;
async function runCase(c) {
  forgetDevice();
  if (c.stored) prefs.set('generator', structuredClone(c.stored));
  const result = await openAndRead(c.url, `${boots}`);
  boots += 1;
  if (result.failed && c.retry && c.retry.length > 1) {
    // A batch that did not boot: one field per boot, so the failure names it.
    for (const one of c.retry) await runCase({ label: `${c.label} [${label(one.path)}]`, url: one.url, checks: one.checks, retry: null });
    return;
  }
  for (const f of judge(c.label, result, c.checks)) failures.push(f);
  for (const path of c.keep?.paths || []) {
    if (result.failed) break;
    const sent = getPath(c.keep.tree, path);
    const kept = getPath(result.snapshot, path);
    const d = firstDiff(sent.value, kept.value);
    if (d) failures.push(`${c.label}: ${label(path)} sent vs saved — ${d}`);
  }
}

const ONLY = process.env.HOSTILE_STRUCTURE_ONLY || '';
const [shardIndex, shardCount] = SHARD.split('/').map(Number);
const failedCases = [];
if (shardIndex === 0) {
  // The untouched link: the calibration every exclusion is read against.
  forgetDevice();
  const control = await openAndRead(`https://ambi4.work/#p=${encodePayload(mintedPayload)}`, 'control');
  boots += 1;
  const before = failures.length;
  if (control.failed) failures.push(`untouched link: ${control.failed}`);
  else for (const f of judge('untouched link', control, ALL_CHECKS)) failures.push(f);
  if (failures.length > before) failedCases.push('untouched link');
  if (process.env.HOSTILE_STRUCTURE_LIST === '1') {
    for (const [g, paths] of GROUPS) console.log(`${g}: ${paths.map(label).join(', ')}`);
  }
}
let ran = 0;
for (let i = shardIndex; i < CASES.length; i += shardCount) {
  const c = CASES[i];
  if (ONLY && !c.label.includes(ONLY)) continue;
  const before = failures.length;
  await runCase(c);
  ran += 1;
  if (failures.length > before) failedCases.push(c.label);
}
forgetDevice();

process.stdout.write(`HS-RESULT ${JSON.stringify({
  boots, ran, failures, failedCases,
  structures: ALL_CHECKS.length, tracks: TRACK_IDS.length, cases: CASES.length,
  notes: shardIndex === 0 ? [
    ...Object.entries(NOT_MIRRORED).map(([key, why]) => `not mirrored: ${key} — ${why}`),
    ...Object.entries(VIEWS).map(([key, [, why]]) => `compared as a view: ${key} — ${why}`),
  ] : [],
})}\n`);
process.exit(0);
