/**
 * Stored prefs, tampered with — run with:
 *   npm run build && node tests/hostile-prefs.mjs
 *
 * Every stored pref the page reads goes through a cleaner (genres, voices,
 * genre, hidden, layout) except, until v0.0.279, `presets`: the read checked
 * only Array.isArray. So a stored `presets: [null]` threw inside
 * refreshPresetSelect (top level of init) and the page never came up; a null
 * entry broke Save's findIndex; an entry whose `params` was a string or an
 * array was listed, and loading it deep-merged to DEFAULTS — the setup
 * silently wiped. Nothing capped the count either.
 *
 * One boot per corrupt stored value, consent granted so the page reads it
 * from localStorage. Per presets boot:
 *   - the page boots: no "Ambi4 init failed", no fallback;
 *   - the Load preset list holds exactly the well-formed entries;
 *   - Save of a preset works, and the stored list reads back clean;
 *   - loading a surviving preset leaves the engine's getParams() agreeing
 *     with the page, field by field (hostile-link's comparison).
 * Then one boot each for corrupt layout, hidden, genre, genres and voices
 * values, which lock in the cleaners those already had.
 *
 * Boot machinery: hostile-link's — about:blank first, a fresh JSDOM per boot,
 * the shared prefs Map emptied between boots, Math.random seeded.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(repoRoot, 'dist');
const indexHtml = join(distDir, 'index.html');
if (!existsSync(indexHtml)) {
  console.error('hostile-prefs: dist/index.html is missing — run `npm run build` first.');
  process.exit(1);
}
const html = readFileSync(indexHtml, 'utf8');
const scriptMatch = /<script[^>]*type="module"[^>]*src="([^"]+)"/.exec(html);
if (!scriptMatch) {
  console.error('hostile-prefs: no module script in dist/index.html');
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
    if (process.env.HOSTILE_PREFS_VERBOSE === '1') original(...args);
  };
}

// --------------------------------------------------------------------------
// Stubs (hostile-link's)
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
async function boot(url, label, seed) {
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
  // Consent GRANTED, so the page reads its prefs from this jsdom's own
  // localStorage, where `seed` has just written the stored values raw.
  win.document.cookie = 'ambi4-consent=granted; Path=/';
  if (seed) seed(win);
  bootCount += 1;
  const errorsBefore = consoleErrors.length;
  await import(`${pathToFileURL(bundlePath).href}?hostile-prefs-${bootCount}-${label}`);
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


// The bundle's prefs module is shared by every boot (same chunk URL). Its
// memory Map is emptied before every boot; with consent granted, everything
// else lives in each jsdom's own localStorage, which is new per boot.
const prefsChunk = readdirSync(join(distDir, '_astro')).find((f) => /^prefs\..*\.js$/.test(f));
const { prefs } = await import(pathToFileURL(join(distDir, '_astro', prefsChunk)).href);
const PREFS_KEYS = ['generator', 'genre', 'genres', 'hidden', 'layout', 'presets', 'voices'];
const forgetDevice = () => { for (const key of PREFS_KEYS) prefs.remove(key); };

/** Write `stored` raw, the way a tampered device holds it. */
const seedWith = (stored) => (win) => {
  for (const [key, value] of Object.entries(stored)) {
    win.localStorage.setItem(`ambi4:${key}`, JSON.stringify(value));
  }
};

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The caps the page applies (index.astro, cleanPresets beside cleanUserGenres).
const PRESET_CAP = 100;
const PRESET_NAME_MAX = 60;

// --------------------------------------------------------------------------
// The page, read
// --------------------------------------------------------------------------
/** The Load preset list's entries, placeholder excluded. */
function listedPresets(win) {
  return [...win.document.querySelectorAll('#preset-load option')]
    .filter((opt) => opt.value !== '')
    .map((opt) => opt.textContent);
}

/** Save under `name`; returns the stored list as it reads back. */
function saveAs(win, name) {
  adoptGlobals(win);
  win.document.getElementById('preset-name').value = name;
  win.document.getElementById('preset-save').click();
  return prefs.get('presets');
}

/** What is wrong with a stored presets value, or [] when it is clean. */
function storedProblems(list) {
  if (!Array.isArray(list)) return [`stored presets is ${String(JSON.stringify(list)).slice(0, 60)}, not a list`];
  const out = [];
  const seen = new Set();
  list.forEach((entry, i) => {
    if (!isPlain(entry)) out.push(`entry ${i} is ${String(JSON.stringify(entry)).slice(0, 40)}`);
    else if (typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > PRESET_NAME_MAX) out.push(`entry ${i} name ${String(JSON.stringify(entry.name)).slice(0, 40)}`);
    else if (!isPlain(entry.params)) out.push(`entry ${i} (${entry.name}) params ${String(JSON.stringify(entry.params)).slice(0, 40)}`);
    else if (seen.has(entry.name)) out.push(`entry ${i} repeats the name ${entry.name}`);
    if (isPlain(entry) && typeof entry.name === 'string') seen.add(entry.name);
  });
  if (list.length > PRESET_CAP) out.push(`${list.length} entries stored (cap ${PRESET_CAP})`);
  return out;
}

// Page vs engine, as hostile-link compares them: every scalar the page holds
// at the top level, in arp and in every track, against getParams().
const NOT_MIRRORED = {
  reverbTail: 'the engine gets the governor-capped tail, the page keeps the ask',
  origin: 'page-only provenance',
  speed: 'pinned to 1 on every push; the page copy is a leftover',
  'tracks.*.level': 'the engine gets the density-scaled level, the page keeps the ask',
};
const isExcluded = (label) => Object.keys(NOT_MIRRORED).some((k) => label === k
  || (k.startsWith('tracks.*.') && label.startsWith('tracks.') && label.endsWith(`.${k.slice(9)}`)));
const isScalar = (v) => v === null || ['number', 'string', 'boolean'].includes(typeof v) || (isPlain(v) && 'min' in v && 'max' in v);
function disagreements(page, engine) {
  const out = [];
  const check = (label, pv, ev, span) => {
    if (isExcluded(label) || !isScalar(pv) || ev === undefined) return;
    const ok = isPlain(pv) && 'min' in pv && span ? same(pv, span) : same(pv, ev);
    if (!ok) out.push(`${label} page ${JSON.stringify(pv)} engine ${JSON.stringify(ev)}`);
  };
  for (const [k, v] of Object.entries(page)) check(k, v, engine[k], engine.spans?.[k]);
  for (const [k, v] of Object.entries(page.arp || {})) check(`arp.${k}`, v, engine.arp?.[k]);
  for (const [t, track] of Object.entries(page.tracks || {})) {
    for (const [k, v] of Object.entries(track || {})) check(`tracks.${t}.${k}`, v, engine.tracks?.[t]?.[k]);
  }
  return out;
}

const failures = [];
let boots = 0;

// ==========================================================================
// The good preset: a whole setup the page itself saved, on a pinned genre
// ==========================================================================
forgetDevice();
const maker = await boot('https://ambi4.work/', 'maker');
if (maker.failed) {
  realError(`hostile-prefs FAILED — a clean device did not boot: ${maker.failed}`);
  process.exit(1);
}
{
  const select = maker.win.document.getElementById('genre-select');
  select.value = 'g:synthwave';
  select.dispatchEvent(new maker.win.Event('change', { bubbles: true }));
  await waitUntil(() => maker.win.__ambi4Engine.getParams().genre === 'synthwave');
}
const madeList = saveAs(maker.win, 'good');
const GOOD = Array.isArray(madeList) ? madeList.find((p) => p && p.name === 'good') : null;
maker.win.close();
boots += 1;
if (!GOOD || !isPlain(GOOD.params)) {
  realError('hostile-prefs FAILED — Save on a clean device stored no preset');
  process.exit(1);
}

/**
 * One device holding `stored`, booted and judged. `expected` is the list the
 * Load preset select should show; `load` names a surviving preset to load and
 * hold the engine to; `saveName` is what Save is pressed with.
 */
async function judgePresets(label, stored, { expected, load = null, saveName = 'fresh' }) {
  forgetDevice();
  const { win, failed } = await boot('https://ambi4.work/', `presets-${boots}`, seedWith({ presets: stored }));
  boots += 1;
  if (failed) { failures.push(`presets ${label}: ${failed}`); win.close(); return; }
  const wrong = [];
  const listed = listedPresets(win);
  if (!same(listed, expected)) {
    const show = (list) => `${list.length} [${list.slice(0, 4).map((n) => JSON.stringify(String(n).slice(0, 20))).join(', ')}${list.length > 4 ? ', …' : ''}]`;
    wrong.push(`listed ${show(listed)}, expected ${show(expected)}`);
  }
  if (load !== null) {
    const index = listed.indexOf(load);
    if (index < 0) wrong.push(`"${load}" is not listed, so it cannot be loaded`);
    else {
      adoptGlobals(win);
      const select = win.document.getElementById('preset-load');
      select.value = select.options[index + 1].value;
      select.dispatchEvent(new win.Event('change', { bubbles: true }));
      const engine = win.__ambi4Engine.getParams();
      const want = Array.isArray(stored) ? stored.find((p) => isPlain(p) && p.name === load)?.params : null;
      if (isPlain(want) && want.genre !== undefined && engine.genre !== want.genre) {
        wrong.push(`loaded "${load}": engine genre ${JSON.stringify(engine.genre)}, the preset's ${JSON.stringify(want.genre)}`);
      }
      // The page's settings as Save writes them (over the same name, so a
      // list at the cap takes it), against the engine.
      const after = saveAs(win, load);
      const page = Array.isArray(after) ? after.find((p) => isPlain(p) && p.name === load)?.params : null;
      if (!isPlain(page)) wrong.push(`loaded "${load}": the next Save stored no setup`);
      else {
        const off = disagreements(page, win.__ambi4Engine.getParams());
        if (off.length) wrong.push(`loaded "${load}": ${off.length} field(s) page vs engine: ${off.slice(0, 6).join('; ')}`);
      }
    }
  }
  const before = consoleErrors.length;
  const list = saveAs(win, saveName);
  const thrown = consoleErrors.slice(before).filter((l) => !/Not implemented/.test(l));
  if (thrown.length) wrong.push(`Save "${saveName}" reported: ${thrown.join(' | ').slice(0, 160)}`);
  if (!Array.isArray(list) || !list.some((p) => isPlain(p) && p.name === saveName && isPlain(p.params))) {
    wrong.push(`Save "${saveName}" did not store it`);
  }
  const problems = storedProblems(list);
  if (problems.length) wrong.push(`stored after Save: ${problems.slice(0, 4).join('; ')}${problems.length > 4 ? ` (+${problems.length - 4})` : ''}`);
  if (!listedPresets(win).includes(saveName)) wrong.push(`Save "${saveName}" is not in the list`);
  win.close();
  if (wrong.length) failures.push(`presets ${label}: ${wrong.length} problem(s)\n      ${wrong.join('\n      ')}`);
}

// ==========================================================================
// Corrupt presets, each BEFORE one good entry, so a dropped entry must not
// shift which setup a list index loads
// ==========================================================================
const good = { name: 'good', params: GOOD.params };
const CORRUPT_ENTRIES = [
  ['null', null],
  ['5', 5],
  ['"x"', 'x'],
  ['{}', {}],
  ['{name:5,params:{}}', { name: 5, params: {} }],
  ['{name:"a",params:"x"}', { name: 'a', params: 'x' }],
  ['{name:"a",params:[]}', { name: 'a', params: [] }],
  ['{name:"   ",params:{}}', { name: '   ', params: {} }],
];
for (const [label, entry] of CORRUPT_ENTRIES) {
  await judgePresets(`[${label}, good]`, [entry, good], { expected: ['good'], load: 'good' });
}
// The bare single-entry forms too: nothing survives, and the page still starts.
for (const [label, entry] of CORRUPT_ENTRIES.slice(0, 3)) {
  await judgePresets(`[${label}]`, [entry], { expected: [] });
}
// A later entry repeating a name is dropped: the first one is what loads.
await judgePresets('[good, {name:"good",params:{}}]', [good, { name: 'good', params: {} }], { expected: ['good'], load: 'good' });
// A name longer than any the page mints is cut, not refused.
{
  const long = 'L'.repeat(500);
  await judgePresets('[{name:"L"x500,params:{}}]', [{ name: long, params: {} }], { expected: [long.slice(0, PRESET_NAME_MAX)] });
}
// Not a list at all.
await judgePresets('{}', {}, { expected: [] });
await judgePresets('"x"', 'x', { expected: [] });
// Ten thousand entries: the list stops at the cap. Save over one that is
// listed (a NEW name at the cap is refused, as a layout is).
{
  const many = Array.from({ length: 10000 }, (_, i) => ({ name: `p${i}`, params: {} }));
  const expected = many.slice(0, PRESET_CAP).map((p) => p.name);
  await judgePresets('10k entries', many, { expected, load: 'p0', saveName: 'p1' });
}
// At the cap, a NEW name is refused and says so; the stored list is untouched.
{
  const full = Array.from({ length: PRESET_CAP }, (_, i) => ({ name: `p${i}`, params: {} }));
  forgetDevice();
  const { win, failed } = await boot('https://ambi4.work/', `presets-cap-${boots}`, seedWith({ presets: full }));
  boots += 1;
  if (failed) failures.push(`presets at the cap: ${failed}`);
  else {
    const list = saveAs(win, 'one more');
    const said = win.document.body.textContent.includes(`This device holds ${PRESET_CAP} presets already`);
    if (!Array.isArray(list) || list.length !== PRESET_CAP || list.some((p) => p.name === 'one more')) {
      failures.push(`presets at the cap: a new name was stored (${Array.isArray(list) ? list.length : typeof list} entries)`);
    }
    if (!said) failures.push('presets at the cap: the refusal said nothing');
  }
  win.close();
}

// ==========================================================================
// The other prefs: their cleaners already exist; these lock them in
// ==========================================================================
const OTHER = [
  ['layout', { pins: [null, 5, { key: 5 }, { key: 'x', label: {} }], saved: { a: null, b: { pins: 'x', tab: 5, editor: [] }, c: 5 } }],
  ['layout', [1, 2, 3]],
  ['hidden', { voices: [5, null, 'noslash', {}, 'pad/nope', '/'], genres: [null, {}, 'nope', 5] }],
  ['hidden', 'x'],
  ['genre', { favourites: 'x', hideOthers: 'yes', picked: 1 }],
  ['genre', { favourites: [null, 5, {}, 'nope'] }],
  ['genres', [null, 5, 'x', { slug: 'u-abc' }, { slug: 5, name: 'x', essence: {} }, { slug: 'u-ok', name: 'ok', essence: 'x' }]],
  ['genres', {}],
  ['voices', [null, 5, { id: 'uv-x' }, { id: 'uv-y', name: 'y', voiceSet: 'pad', voice: 'nope', patch: {} }]],
  ['voices', 'x'],
];
for (const [key, value] of OTHER) {
  const label = `${key} = ${JSON.stringify(value).slice(0, 70)}`;
  forgetDevice();
  const { win, failed } = await boot('https://ambi4.work/', `other-${boots}`, seedWith({ [key]: value }));
  boots += 1;
  if (failed) { failures.push(`${label}: ${failed}`); win.close(); continue; }
  const list = saveAs(win, 'fresh');
  const wrong = [];
  const saved = Array.isArray(list) ? list.find((p) => isPlain(p) && p.name === 'fresh') : null;
  if (!saved) wrong.push('Save stored nothing');
  else {
    const off = disagreements(saved.params, win.__ambi4Engine.getParams());
    if (off.length) wrong.push(`${off.length} field(s) page vs engine: ${off.slice(0, 4).join('; ')}`);
  }
  win.close();
  if (wrong.length) failures.push(`${label}: ${wrong.join('; ')}`);
}
forgetDevice();

const presetBoots = CORRUPT_ENTRIES.length + 3 + 6;
console.log(`hostile-prefs: ${presetBoots} corrupt presets values, ${OTHER.length} corrupt layout/hidden/genre/genres/voices values, ${boots} boots`);
if (failures.length) {
  realError(`hostile-prefs FAILED — ${failures.length} failure(s):`);
  for (const f of failures) process.stderr.write(`  - ${f}\n`);
  process.exit(1);
}
console.log(`hostile-prefs ok — every corrupt stored value booted, listed clean and saved clean across ${boots} boots`);
process.exit(0);
