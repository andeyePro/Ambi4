/**
 * A hostile share link, opened — run with:
 *   npm run build && node tests/hostile-link.mjs
 *
 * A link that DECODES is trusted further than it should be: decodeShareParams
 * checks only that the top level is a plain object, deepMerge(DEFAULTS, …)
 * hands a scalar back as whatever arrived, and the page's normaliser repaired
 * only some fields. So `bpm: "fast"` or a track's `level: {}` stayed in the
 * page's own settings while the engine's sanitiser defaulted ITS copy: page
 * and engine disagreed (the Speed dial read NaN), and the next Save persisted
 * the bad value. A tampered stored `generator` blob takes the same path.
 *
 * Every payload starts from a link the page itself minted. Each scalar the
 * page holds — top level, arp, and every track's — is replaced with each of
 * HOSTILE (one value per boot, top level and tracks in separate boots, so a
 * failure names its field and value). Per boot:
 *   - the page boots: no "Ambi4 init failed", no fallback;
 *   - no knob readout or aria-valuetext says NaN / undefined / Infinity;
 *   - every tampered field the page holds equals the ENGINE's copy
 *     (getParams(); a spread page value against the engine's `spans`);
 *   - a field that is a number (or a {min,max} span) on an untouched boot is
 *     still one in the page's Save and in the stored generator prefs.
 *
 * Boot machinery: share-roundtrip.mjs's (page-boot's second boot) — about:blank
 * first, a fresh JSDOM per boot, and the shared prefs Map emptied between them
 * (CLAUDE.md "Traps").
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(repoRoot, 'dist');
const indexHtml = join(distDir, 'index.html');
if (!existsSync(indexHtml)) {
  console.error('hostile-link: dist/index.html is missing — run `npm run build` first.');
  process.exit(1);
}
const html = readFileSync(indexHtml, 'utf8');
const scriptMatch = /<script[^>]*type="module"[^>]*src="([^"]+)"/.exec(html);
if (!scriptMatch) {
  console.error('hostile-link: no module script in dist/index.html');
  process.exit(1);
}
const bundlePath = join(distDir, scriptMatch[1].replace(/^\//, ''));

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
    if (process.env.HOSTILE_LINK_VERBOSE === '1') original(...args);
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
  installClipboard(win);
  adoptGlobals(win);
  bootCount += 1;
  const errorsBefore = consoleErrors.length;
  await import(`${pathToFileURL(bundlePath).href}?hostile-link-${bootCount}-${label}`);
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
  return out;
}

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNumberOrRange = (v) => (typeof v === 'number' && Number.isFinite(v))
  || (isPlain(v) && Number.isFinite(v.min) && Number.isFinite(v.max));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Does the page's value agree with the engine's? A spread on the page is the
 * engine's `spans` entry (getParams keeps a plain number in the field itself
 * and the span beside it); anything else compares as it stands.
 */
function agrees(pageValue, engineValue, engineSpan) {
  if (isPlain(pageValue) && 'min' in pageValue && engineSpan) return same(pageValue, engineSpan);
  return same(pageValue, engineValue);
}

/** Every [path, page value, engine value, engine span] for the fields tampered. */
function fieldPairs(snapshot, params, fields) {
  return fields.map(({ scope, track, key }) => {
    if (scope === 'top') return { label: key, page: snapshot?.[key], has: snapshot && key in snapshot, eng: params[key], engHas: key in params, span: params.spans?.[key] };
    if (scope === 'arp') return { label: `arp.${key}`, page: snapshot?.arp?.[key], has: snapshot?.arp && key in snapshot.arp, eng: params.arp?.[key], engHas: params.arp && key in params.arp };
    return { label: `tracks.${track}.${key}`, page: snapshot?.tracks?.[track]?.[key], has: snapshot?.tracks?.[track] && key in snapshot.tracks[track],
      eng: params.tracks?.[track]?.[key], engHas: params.tracks?.[track] && key in params.tracks[track] };
  });
}

// --------------------------------------------------------------------------
// Exclusions — a field whose page copy is NOT the engine's by design, each
// with its reason. Calibrated on the untouched boot: anything that disagrees
// there and is not listed here is itself a failure.
// --------------------------------------------------------------------------
const NOT_MIRRORED = {
  // The page stores the person's ASK; the engine is handed it through the
  // performance governor's tier cap (engineParamsFrom → cappedReverbTail).
  reverbTail: 'the engine gets the governor-capped tail, the page keeps the ask',
  // Page-only bookkeeping, never part of the engine's params.
  origin: 'page-only provenance',
  // Deprecated at the UI: every push pins the engine's speed to 1
  // (engineParamsFrom), whatever a stored setup still carries.
  speed: 'pinned to 1 on every push; the page copy is a leftover',
  // The page keeps each track's level as the person set it; the engine is
  // handed it scaled by the density governor (applyDensityScale).
  'tracks.*.level': 'the engine gets the density-scaled level, the page keeps the ask',
};
const isExcludedLabel = (label) => Object.keys(NOT_MIRRORED).some((k) => label === k
  || (k.startsWith('tracks.*.') && label.startsWith('tracks.') && label.endsWith(`.${k.slice(9)}`)));

// ==========================================================================
// The sender: a page-minted compact link on a pinned genre
// ==========================================================================
const failures = [];
const notes = [];

forgetDevice();
const senderBoot = await boot('https://ambi4.work/', 'sender');
if (senderBoot.failed) {
  realError(`hostile-link FAILED — the sender did not boot: ${senderBoot.failed}`);
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
  realError('hostile-link FAILED — Share put no link on the clipboard');
  process.exit(1);
}
const mintedPayload = decodeLink(clipboard.text);
const senderSnapshot = savedSnapshot(sender, 'hostile sender');
sender.close();
if (!mintedPayload || !mintedPayload.o || !isPlain(mintedPayload.d)) {
  realError(`hostile-link FAILED — the sender minted ${mintedPayload ? 'a whole-tree' : 'no readable'} link, not a compact one`);
  process.exit(1);
}

// ==========================================================================
// The fields: every scalar (or {min,max} span) the page holds
// ==========================================================================
const isScalar = (v) => v === null || ['number', 'string', 'boolean'].includes(typeof v) || (isPlain(v) && 'min' in v && 'max' in v);
// DEFAULTS' top-level scalars, named so a sparse one (absent on this setup)
// is still tampered with.
const DEFAULT_TOP = ['swing', 'complexity', 'repetition', 'volume', 'root', 'mode', 'timeSignature', 'bpm', 'structure'];
const TOP_FIELDS = [...new Set([
  ...DEFAULT_TOP,
  ...Object.keys(senderSnapshot).filter((k) => isScalar(senderSnapshot[k]) && k !== 'origin'),
])].map((key) => ({ scope: 'top', key }));
const ARP_FIELDS = Object.keys(senderSnapshot.arp || {}).filter((k) => isScalar(senderSnapshot.arp[k]))
  .map((key) => ({ scope: 'arp', key }));
const TRACK_IDS = Object.keys(senderSnapshot.tracks);
const TRACK_FIELDS = TRACK_IDS.flatMap((track) => Object.keys(senderSnapshot.tracks[track])
  .filter((k) => isScalar(senderSnapshot.tracks[track][k]))
  .map((key) => ({ scope: 'track', track, key })));
const MASTER_FIELDS = [...TOP_FIELDS, ...ARP_FIELDS];

const HOSTILE = [
  ['"fast"', 'fast'],
  ['null', null],
  ['{}', {}],
  ['[]', []],
  ['true', true],
  ['-1e9', -1e9],
  ['1e9', 1e9],
];

/** `base` (a settings-shaped object) with every field in `fields` set to `value`. */
function tamper(base, fields, value) {
  const out = structuredClone(base);
  for (const { scope, track, key } of fields) {
    if (scope === 'top') out[key] = structuredClone(value);
    else if (scope === 'arp') { if (!isPlain(out.arp)) out.arp = {}; out.arp[key] = structuredClone(value); }
    else {
      if (!isPlain(out.tracks)) out.tracks = {};
      if (!isPlain(out.tracks[track])) out.tracks[track] = {};
      out.tracks[track][key] = structuredClone(value);
    }
  }
  return out;
}

// ==========================================================================
// The untouched boot: the calibration every hostile boot is read against
// ==========================================================================
async function openAndRead(url, label) {
  const { win, failed } = await boot(url, label);
  if (failed) { win.close(); return { failed }; }
  const engine = win.__ambi4Engine;
  const params = structuredClone(engine.getParams());
  const snapshot = savedSnapshot(win, `hostile ${label}`);
  const stored = await storedGenerator(win);
  const readouts = badReadouts(win);
  win.close();
  return { params, snapshot, stored, readouts };
}

forgetDevice();
const control = await openAndRead(`https://ambi4.work/#p=${encodePayload(mintedPayload)}`, 'control');
if (control.failed) {
  realError(`hostile-link FAILED — the untouched link did not boot: ${control.failed}`);
  process.exit(1);
}
const ALL_FIELDS = [...MASTER_FIELDS, ...TRACK_FIELDS];
const numericInControl = new Set();
for (const pair of fieldPairs(control.snapshot, control.params, ALL_FIELDS)) {
  if (pair.has && isNumberOrRange(pair.page)) numericInControl.add(pair.label);
  if (!pair.has || !pair.engHas || isExcludedLabel(pair.label)) continue;
  if (!agrees(pair.page, pair.eng, pair.span)) {
    failures.push(`untouched link: ${pair.label} page ${JSON.stringify(pair.page)} vs engine ${JSON.stringify(pair.eng)} — not mirrored, and not a named exclusion`);
  }
}
if (control.readouts.length) failures.push(`untouched link: bad readouts ${control.readouts.slice(0, 5).join(', ')}`);

// ==========================================================================
// The hostile boots
// ==========================================================================
/** Check one booted page against the fields that were tampered with. */
function judge(label, result, fields) {
  if (result.failed) { failures.push(`${label}: ${result.failed}`); return; }
  const wrong = [];
  for (const pair of fieldPairs(result.snapshot, result.params, fields)) {
    if (!pair.has) continue; // the page dropped it — nothing held, nothing to disagree
    if (pair.engHas && !isExcludedLabel(pair.label) && !agrees(pair.page, pair.eng, pair.span)) {
      wrong.push(`${pair.label} page ${JSON.stringify(pair.page)} engine ${JSON.stringify(pair.eng)}`);
    } else if (!pair.engHas && numericInControl.has(pair.label) && !isNumberOrRange(pair.page)) {
      wrong.push(`${pair.label} page ${JSON.stringify(pair.page)} (no engine copy; a number on the untouched link)`);
    }
  }
  // The next Save and the stored generator prefs: a numeric field stays numeric.
  for (const [where, tree] of [['save', result.snapshot], ['stored generator', result.stored]]) {
    if (!tree) { wrong.push(`${where}: nothing written`); continue; }
    for (const pair of fieldPairs(tree, result.params, fields)) {
      // A nullable field (a track's swing or density: null is its Auto
      // detent) may hold null — when the engine holds null too.
      const engineNull = pair.page === null && pair.engHas && pair.eng === null;
      if (pair.has && numericInControl.has(pair.label) && !isNumberOrRange(pair.page) && !engineNull) {
        wrong.push(`${where}: ${pair.label} = ${JSON.stringify(pair.page)}`);
      }
    }
  }
  if (result.readouts.length) wrong.push(`readouts: ${result.readouts.slice(0, 6).join(', ')}`);
  if (wrong.length) failures.push(`${label}: ${wrong.length} field(s)\n      ${[...new Set(wrong)].slice(0, 40).join('\n      ')}`);
}

/** Every field label that failed, for the red-on-old record. */
const failedFields = new Map();
function recordFailures(fromIndex, valueLabel) {
  for (const f of failures.slice(fromIndex)) {
    for (const m of f.matchAll(/(?:^|\n\s+|: )((?:tracks\.\w+\.|arp\.)?[A-Za-z]+) (?:page|=)/g)) {
      if (!failedFields.has(m[1])) failedFields.set(m[1], new Set());
      failedFields.get(m[1]).add(valueLabel);
    }
  }
}

let boots = 1;
for (const [valueLabel, value] of HOSTILE) {
  for (const [batch, fields] of [['master', MASTER_FIELDS], ['tracks', TRACK_FIELDS]]) {
    // A null in a compact DIFF means "remove the key" (applyShareDiff), so a
    // null value travels as a whole tree — the legacy branch, which every
    // link minted before v0.0.79 takes and always will.
    const whole = value === null;
    const payload = whole
      ? { ...tamper(senderSnapshot, fields, value), v: mintedPayload.v }
      : { ...mintedPayload, d: tamper(mintedPayload.d, fields, value) };
    const label = `link ${batch} = ${valueLabel}${whole ? ' (whole tree)' : ''}`;
    forgetDevice();
    const before = failures.length;
    judge(label, await openAndRead(`https://ambi4.work/#p=${encodePayload(payload)}`, `${batch}-${bootCount}`), fields);
    recordFailures(before, valueLabel);
    boots += 1;
  }
}

// One whole-tree link with a non-null value too — the legacy branch with a string.
{
  const fields = [...MASTER_FIELDS, ...TRACK_FIELDS];
  const payload = { ...tamper(senderSnapshot, fields, 'fast'), v: mintedPayload.v };
  forgetDevice();
  const before = failures.length;
  judge('link all = "fast" (whole tree)', await openAndRead(`https://ambi4.work/#p=${encodePayload(payload)}`, 'whole-fast'), fields);
  recordFailures(before, '"fast"');
  boots += 1;
}

// ==========================================================================
// A tampered STORED generator blob — same merge, same normaliser
// ==========================================================================
for (const [valueLabel, value] of [['"fast"', 'fast'], ['{}', {}]]) {
  const fields = [...MASTER_FIELDS, ...TRACK_FIELDS];
  forgetDevice();
  prefs.set('generator', tamper(senderSnapshot, fields, value));
  const before = failures.length;
  judge(`stored generator = ${valueLabel}`, await openAndRead('https://ambi4.work/', `stored-${bootCount}`), fields);
  recordFailures(before, valueLabel);
  boots += 1;
}
forgetDevice();

console.log(`hostile-link: ${MASTER_FIELDS.length} master + ${TRACK_FIELDS.length} track fields (${TRACK_IDS.length} tracks) × ${HOSTILE.length} hostile values, ${boots} boots`);
for (const note of notes) console.log(`  ${note}`);
for (const [key, why] of Object.entries(NOT_MIRRORED)) console.log(`  not mirrored: ${key} — ${why}`);

if (failures.length) {
  realError(`hostile-link FAILED — ${failures.length} failure(s):`);
  for (const f of failures) process.stderr.write(`  - ${f}\n`);
  if (failedFields.size) {
    process.stderr.write(`  fields that failed: ${[...failedFields].map(([f, vs]) => `${f} [${[...vs].join(' ')}]`).join('; ')}\n`);
  }
  process.exit(1);
}
console.log(`hostile-link ok — every tampered field reconciled with the engine across ${boots} boots`);
process.exit(0);
