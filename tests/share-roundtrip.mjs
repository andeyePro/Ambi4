/**
 * A share link, opened end to end — run with:
 *   npm run build && node tests/share-roundtrip.mjs
 *
 * Nothing else opens a link the page itself minted. page-boot arrives on
 * hand-written payloads; sharelink-drive compares a handful of fields in a
 * browser. But the compact form is an ORIGIN plus a DIFF that the receiver
 * rebuilds with its own compiler and presets, so a field dropped from the
 * diff — or rebuilt wrongly from the origin — would sound different on the
 * other end with nothing anywhere saying so.
 *
 * So: the BUILT bundle boots in jsdom as the sender, takes a setup through the
 * page's own load path (Save, then Load — loadParamsSnapshot, exactly what the
 * preset picker does), presses #preset-share and reads the link off the
 * clipboard. A second, fresh jsdom boots the same bundle on that link, and the
 * two ENGINES' getParams() are compared whole. Every field the engine's
 * registry declares (PARAM_REGISTRY — read the way registry-contract.mjs reads
 * it, never a hand list) is set to a non-default value the sanitiser keeps,
 * on every track and every track's voice, before the edited link is minted.
 *
 * Cases: an untouched setup and an edited one as compact links; a whole-tree
 * link (the permanent legacy branch — the page mints one itself when its
 * origin cannot be rebuilt); a link carrying a genre of the person's own (g);
 * and one link for each schema stamp 1-5, checked against what shareSchemaFor
 * should pick, the compact spread stamp included (it reads the DIFF, not the
 * settings: an untouched genre whose base has a spread is still a 1).
 *
 * The boot machinery is page-boot's second boot: stubbed AudioContext, canvas
 * and clipboard, a cache-busting import query per boot, a fresh JSDOM per
 * page, and the bundle's globals adopted after each one (CLAUDE.md "Traps").
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';
import {
  PARAM_REGISTRY,
  sanitiseParams,
} from '../src/scripts/ambient-engine.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(repoRoot, 'dist');
const indexHtml = join(distDir, 'index.html');
if (!existsSync(indexHtml)) {
  console.error('share-roundtrip: dist/index.html is missing — run `npm run build` first.');
  process.exit(1);
}
const html = readFileSync(indexHtml, 'utf8');
const scriptMatch = /<script[^>]*type="module"[^>]*src="([^"]+)"/.exec(html);
if (!scriptMatch) {
  console.error('share-roundtrip: no module script in dist/index.html');
  process.exit(1);
}
const bundlePath = join(distDir, scriptMatch[1].replace(/^\//, ''));

// --------------------------------------------------------------------------
// Determinism: the page draws its opening genre and every genre seed with
// Math.random, and the bundle runs in THIS realm. A seeded generator pins the
// draw, the seed and so the whole run.
// --------------------------------------------------------------------------
let rngState = 0x5eed1234;
Math.random = () => {
  rngState = (rngState + 0x6d2b79f5) | 0;
  let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// --------------------------------------------------------------------------
// Stubs (page-boot's, cut to what a boot and a Share press touch)
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
/** Point the bundle's globals at `win` (page-boot's adoptGlobals). */
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

/** The leave-guard asks before an edited voice is left; Move on, always. */
function answerLeaveGuardWithMoveOn(win) {
  const observer = new win.MutationObserver(() => {
    // A closed receiver's window has no document left to answer from.
    win.document?.querySelector('#leave-guard .leave-guard-move')?.click();
  });
  observer.observe(win.document.body || win.document.documentElement, { childList: true, subtree: false });
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
 * A fresh jsdom on `url`, the bundle imported again under a query of its own
 * (Node caches an ES module by URL, and every boot needs the page's top-level
 * code to run against ITS document), globals adopted. Resolves to the window
 * once #generator-app unhides.
 */
async function boot(url, label) {
  const dom = new JSDOM(html, { url, pretendToBeVisual: true, runScripts: 'outside-only' });
  const win = dom.window;
  answerLeaveGuardWithMoveOn(win);
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
  await import(`${pathToFileURL(bundlePath).href}?share-roundtrip-${bootCount}-${label}`);
  const booted = await waitUntil(() => {
    const el = win.document.getElementById('generator-app');
    return Boolean(el) && !el.hidden && Boolean(win.__ambi4Engine);
  }, 10000);
  if (!booted) throw new Error(`${label}: the page did not boot on ${url.slice(0, 80)}`);
  return win;
}

// The bundle's prefs module is shared by every boot (same chunk URL), and
// before consent it keeps everything in an in-module Map. Importing the SAME
// chunk reaches that Map: the sender's own genre is seeded through it (how a
// stored genre reaches a boot), its saved presets are read back through it,
// and before every receiver it is emptied — a receiver is another device,
// and must not find the sender's genres, presets or setup waiting for it.
const prefsChunk = readdirSync(join(distDir, '_astro')).find((f) => /^prefs\..*\.js$/.test(f));
const { prefs } = await import(pathToFileURL(join(distDir, '_astro', prefsChunk)).href);
const PREFS_KEYS = ['generator', 'genre', 'genres', 'hidden', 'layout', 'presets', 'voices'];
const forgetDevice = () => { for (const key of PREFS_KEYS) prefs.remove(key); };

/** The payload of a copied link, `v` included, decoded the page's way. */
function decodeLink(link) {
  const at = link.indexOf('#p=');
  if (at < 0) return null;
  const value = link.slice(at + 3);
  return JSON.parse(Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

/** Every path where `a` and `b` differ (arrays compared element-wise). */
function diffPaths(a, b, path = '', out = []) {
  if (Object.is(a, b)) return out;
  const isObj = (v) => v !== null && typeof v === 'object';
  if (!isObj(a) || !isObj(b) || Array.isArray(a) !== Array.isArray(b)) {
    out.push(`${path || '(root)'}: ${JSON.stringify(a)?.slice(0, 120)} -> ${JSON.stringify(b)?.slice(0, 120)}`);
    return out;
  }
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    diffPaths(a[key], b[key], path ? `${path}.${key}` : key, out);
  }
  return out;
}

const getAt = (obj, keys) => keys.reduce((o, k) => (o == null ? undefined : o[k]), obj);

// --------------------------------------------------------------------------
// Exclusions — every one named, with its reason. A path listed here is not
// compared between sender and receiver.
// --------------------------------------------------------------------------
// Empty on purpose (v0.0.277): every field of getParams() arrived identical on
// all four links. An entry is { path: 'tracks.melody.x', why: '...' }, and
// needs a reason a reviewer would accept — "it differs" is not one.
const EXCLUDED = [
];
const isExcluded = (line) => EXCLUDED.some(({ path }) => line.startsWith(`${path}:`) || line.startsWith(`${path}.`));

const failures = [];
const notes = [];
// SHARE_ROUNDTRIP_VERBOSE=1 prints each link's size and what its diff holds.
const verbose = process.env.SHARE_ROUNDTRIP_VERBOSE === '1';

// ==========================================================================
// The sender
// ==========================================================================
const STOCK_GENRE = 'synthwave';
const USER_GENRE = 'u-roundtrip';
{
  const own = JSON.parse(readFileSync(join(repoRoot, 'src/data/genres/synthwave.json'), 'utf8'));
  own.slug = USER_GENRE;
  own.name = 'Round trip';
  own.madeFrom = STOCK_GENRE;
  own.essence.bpm = [97, 97];
  prefs.set('genres', [own]);
}

const sender = await boot('https://ambi4.work/', 'sender');
const sdoc = sender.document;
const sengine = sender.__ambi4Engine;
const change = (el, value) => {
  el.value = value;
  el.dispatchEvent(new sender.Event('change', { bubbles: true }));
};

async function pickGenre(slug) {
  const select = sdoc.getElementById('genre-select');
  if (![...select.options].some((o) => o.value === `g:${slug}`)) throw new Error(`the genre picker has no g:${slug}`);
  change(select, `g:${slug}`);
  if (!(await waitUntil(() => sengine.getParams().genre === slug))) throw new Error(`picking ${slug} did not reach the engine`);
}

/** Press Share; resolve to the copied link once the clipboard changes. */
async function share() {
  adoptGlobals(sender);
  clipboard.text = '';
  sdoc.getElementById('preset-share').click();
  if (!(await waitUntil(() => clipboard.text.includes('#p=')))) throw new Error('Share put no link on the clipboard');
  return clipboard.text;
}

/** Save the live setup under `name`; resolve to that preset's stored params. */
function save(name) {
  adoptGlobals(sender);
  sdoc.getElementById('preset-name').value = name;
  sdoc.getElementById('preset-save').click();
  const entry = (prefs.get('presets') || []).find((p) => p.name === name);
  if (!entry) throw new Error(`Save did not keep a preset named ${name}`);
  return entry;
}

/**
 * Make `params` the live setup the way a person does: Save (so the picker
 * lists an entry), that entry's params replaced IN the page's own presets
 * array (prefs hands back the array itself before consent), then the picker
 * pointed at it — loadParamsSnapshot, the preset load path.
 */
function load(name, params) {
  const entry = save(name);
  entry.params = structuredClone(params);
  const select = sdoc.getElementById('preset-load');
  const option = [...select.options].find((o) => o.textContent.trim() === name);
  if (!option) throw new Error(`the preset picker does not list ${name}`);
  change(select, option.value);
}

/** Open `link` on a fresh device; resolve to its engine's params. */
async function receive(link, label) {
  forgetDevice();
  const at = link.indexOf('#p=');
  const win = await boot(`https://ambi4.work/${link.slice(at)}`, label);
  const params = structuredClone(win.__ambi4Engine.getParams());
  const note = win.document.getElementById('share-note');
  const said = note && !note.hidden ? note.textContent.trim() : '';
  win.close();
  adoptGlobals(sender);
  return { params, said };
}

function compare(label, sent, got) {
  const lines = diffPaths(sent, got);
  const real = lines.filter((line) => !isExcluded(line));
  if (real.length) failures.push(`${label}: ${real.length} field(s) arrived different:\n    ${real.slice(0, 25).join('\n    ')}`);
  return lines.length - real.length;
}

// --- pin genre, key and seed (the seed is the seeded Math.random's draw) ---
await pickGenre(STOCK_GENRE);
{
  const root = sdoc.getElementById('root');
  const now = sengine.getParams().root;
  const other = [...root.options].map((o) => o.value).find((v) => v !== now && v !== String(now));
  change(root, other);
  if (!(await waitUntil(() => String(sengine.getParams().root) === other))) failures.push(`the key select did not move the engine to ${other}`);
}
const untouched = save('roundtrip untouched').params;
const origin = untouched.origin;
if (!origin || origin.kind !== 'genre' || origin.id !== STOCK_GENRE || !Number.isFinite(origin.seed)) {
  failures.push(`the pinned setup's origin is ${JSON.stringify(origin)}, not ${STOCK_GENRE} with a seed`);
}

// ==========================================================================
// The registry, as every field a link must carry
// ==========================================================================
const TRACK_IDS = Object.keys(untouched.tracks);

/** A non-default value for a registry row, given what is there now. */
function valueFor(path, row, now, salt) {
  if (row.kind === 'enum') return row.domain.find((v) => v !== now) ?? row.domain[0];
  const [lo, hi] = row.domain;
  for (const f of [0.37, 0.61, 0.83]) {
    const at = lo + (hi - lo) * ((f + salt * 0.013) % 1);
    const v = row.integer ? Math.round(at) : Math.round(at * 1000) / 1000;
    if (v !== now && v !== 0) return v;
  }
  return hi;
}

/**
 * The partial a registry path is written at, for one track — the same
 * scope/field split registry-contract.mjs drives the sanitiser with.
 */
function partialAt(path, track, voice, value) {
  const [scope, a, b] = path.split('.');
  if (scope === 'master') return { at: [a], partial: { [a]: value } };
  if (scope === 'track') return { at: ['tracks', track, a], partial: { tracks: { [track]: { [a]: value } } } };
  return { at: ['patches', track, voice, a, b], partial: { patches: { [track]: { [voice]: { [a]: { [b]: value } } } } } };
}

/**
 * `untouched` with every registry field the sanitiser keeps set to a
 * non-default value: master rows once, track rows on every track, patch rows
 * on every track's voice. A field the sanitiser drops for that track (a kit
 * has no octave wander) is not a field a link could carry, and is noted.
 */
function editedFrom(snapshot) {
  const out = structuredClone(snapshot);
  const set = [];
  const refused = [];
  let salt = 0;
  for (const [path, row] of Object.entries(PARAM_REGISTRY)) {
    const [scope] = path.split('.');
    const targets = scope === 'master' ? [null] : TRACK_IDS;
    for (const track of targets) {
      const voice = track ? out.tracks[track]?.voice : null;
      if (scope === 'patch' && typeof voice !== 'string') { refused.push(`${path}@${track} (no voice id)`); continue; }
      const probe = partialAt(path, track, voice, 0);
      salt += 1;
      let value = valueFor(path, row, getAt(out, probe.at), salt);
      // A rangeable track field takes a span — the D8 dials are spreads.
      if (scope === 'track' && row.domain && row.kind === 'number' && path !== 'track.drive' && path !== 'track.passingNotes') {
        const [lo, hi] = row.domain;
        value = { min: Math.round((lo + (hi - lo) * 0.2) * 1000) / 1000, max: Math.round((lo + (hi - lo) * 0.7) * 1000) / 1000 };
      }
      const { at, partial } = partialAt(path, track, voice, value);
      const kept = getAt(sanitiseParams(partial), at);
      if (JSON.stringify(kept) !== JSON.stringify(value)) { refused.push(`${path}@${track ?? 'master'}`); continue; }
      let node = out;
      for (const key of at.slice(0, -1)) {
        if (node[key] == null || typeof node[key] !== 'object') node[key] = {};
        node = node[key];
      }
      node[at[at.length - 1]] = value;
      set.push({ path, track, at, value });
    }
  }
  return { params: out, set, refused };
}

// ==========================================================================
// Case 1 — the untouched setup, compact
// ==========================================================================
const untouchedLink = await share();
const untouchedPayload = decodeLink(untouchedLink);
const untouchedSent = structuredClone(sengine.getParams());
if (!untouchedPayload || !untouchedPayload.o || !('d' in untouchedPayload)) {
  failures.push(`an untouched genre setup minted a ${untouchedPayload ? 'whole-tree' : 'unreadable'} link, not a compact one`);
}

// ==========================================================================
// The stamps, 1-5 — each the untouched setup plus the one thing that should
// raise it to that number, minted through the page.
// ==========================================================================
const stampCases = [];
stampCases.push({ want: 1, label: 'untouched genre', payload: untouchedPayload });
{
  // Does the genre base itself carry a spread? If so, stamp 1 above is the
  // proof that the compact spread stamp reads the diff, not the settings.
  const fresh = { pan: 0, timing: 0, dynamics: 0, octaveWander: 0, voiceWander: 0 };
  const spreadInBase = Object.entries(untouched.tracks).filter(([, t]) => Object.keys(fresh)
    .some((f) => t[f] !== undefined && JSON.stringify(t[f]) !== JSON.stringify(fresh[f])));
  notes.push(spreadInBase.length
    ? `stamp 1 holds with a spread in the BASE (${spreadInBase.map(([id]) => id).join(', ')}) — the spread stamp reads the diff`
    : 'note: this genre base has no spread of its own, so stamp 1 does not exercise the diff-reading clause');
  if (!spreadInBase.length) failures.push(`${STOCK_GENRE}'s base carries no spread — pick a genre whose base does, or stamp 1 proves nothing about the diff`);
}
const variants = [
  { want: 2, label: 'macro 1 moved', edit: (p) => { p.macro1 = p.macro1 === 0.8 ? 0.2 : 0.8; } },
  { want: 3, label: 'master Drive on', edit: (p) => { p.drive = 0.4; } },
  { want: 4, label: 'bass on the Pulse voice', edit: (p) => { p.tracks.bass.voice = 'pulse'; } },
  { want: 5, label: 'one track\'s Octave wander in the diff', edit: (p) => { p.tracks.melody.octaveWander = 0.45; } },
];
for (const variant of variants) {
  const params = structuredClone(untouched);
  variant.edit(params);
  load(`roundtrip stamp ${variant.want}`, params);
  stampCases.push({ want: variant.want, label: variant.label, payload: decodeLink(await share()) });
}

// ==========================================================================
// Case 2 — the edited setup, compact
// ==========================================================================
const edited = editedFrom(untouched);
load('roundtrip edited', edited.params);
{
  // The sender's ENGINE must hold every value before the link is worth
  // reading: a page that never handed a value over is a different fault.
  const live = sengine.getParams();
  const missing = edited.set.filter(({ at, value }) => JSON.stringify(getAt(live, at)) !== JSON.stringify(value));
  if (missing.length) {
    failures.push(`the sender's engine did not take ${missing.length} of ${edited.set.length} values through the preset load path:\n    ${missing.slice(0, 15)
      .map(({ at, value }) => `${at.join('.')} want ${JSON.stringify(value)} got ${JSON.stringify(getAt(live, at))}`).join('\n    ')}`);
  }
}
const editedLink = await share();
const editedPayload = decodeLink(editedLink);
const editedSent = structuredClone(sengine.getParams());
if (!editedPayload || !editedPayload.o) failures.push('the edited setup minted a whole-tree link, not a compact one');
stampCases.push({ want: 5, label: 'every registry field edited (compact)', payload: editedPayload });

// ==========================================================================
// Case 3 — a whole-tree link, minted by the page: an origin it cannot
// rebuild (a genre this build does not have) leaves it nothing to diff
// against, so it sends the tree. The receiver takes the legacy branch.
// ==========================================================================
load('roundtrip whole', { ...edited.params, origin: { kind: 'genre', id: 'no-such-genre-roundtrip', seed: 7 } });
const wholeLink = await share();
const wholePayload = decodeLink(wholeLink);
const wholeSent = structuredClone(sengine.getParams());
if (!wholePayload || 'o' in wholePayload || 'd' in wholePayload) failures.push('an origin the page cannot rebuild did not mint a whole-tree link');
stampCases.push({ want: 5, label: 'whole tree with spreads', payload: wholePayload });

// ==========================================================================
// Case 4 — a genre of the person's own rides along as g
// ==========================================================================
await pickGenre(USER_GENRE);
const ownBase = save('roundtrip own').params;
const ownEdited = editedFrom(ownBase);
load('roundtrip own edited', ownEdited.params);
const ownLink = await share();
const ownPayload = decodeLink(ownLink);
const ownSent = structuredClone(sengine.getParams());
if (!ownPayload || !ownPayload.g || ownPayload.g.slug !== USER_GENRE) failures.push('a setup on a genre of the person\'s own minted a link without its genre (g)');
if (ownSent.bpm !== 97 && !(ownSent.bpm && typeof ownSent.bpm === 'object')) notes.push(`own-genre bpm on the sender: ${JSON.stringify(ownSent.bpm)}`);

// --- the stamps ---
for (const { want, label, payload } of stampCases) {
  const got = payload && payload.v;
  if (got !== want) failures.push(`stamp: ${label} minted v=${JSON.stringify(got)}, shareSchemaFor should pick ${want}`);
}

// ==========================================================================
// The receivers — each a fresh device
// ==========================================================================
let excluded = 0;
for (const [label, link, sent] of [
  ['untouched compact', untouchedLink, untouchedSent],
  ['edited compact', editedLink, editedSent],
  ['whole tree', wholeLink, wholeSent],
  ['own genre (g)', ownLink, ownSent],
]) {
  const { params, said } = await receive(link, label.replace(/\W+/g, '-'));
  if (verbose) {
    const payload = decodeLink(link);
    console.log(`  ${label}: ${link.length} chars, ${payload.o ? `compact, diff keys ${Object.keys(payload.d).join(',')}` : 'whole tree'}, ${diffPaths(sent, params).length} difference(s)`);
  }
  excluded += compare(label, sent, params);
  if (/newer|missing|could not/i.test(said)) failures.push(`${label}: the receiver warned "${said}"`);
}

const setPaths = new Set(edited.set.map(({ path }) => path));
const registryPaths = Object.keys(PARAM_REGISTRY);
const uncovered = registryPaths.filter((p) => !setPaths.has(p));
if (uncovered.length) failures.push(`registry rows no track could carry (nothing set): ${uncovered.join(', ')}`);

console.log(`share-roundtrip: ${edited.set.length} registry values set across ${TRACK_IDS.length} tracks (${setPaths.size}/${registryPaths.length} registry rows); ` +
  `${edited.refused.length} track/field pairs the sanitiser refuses: ${edited.refused.join(', ') || 'none'}`);
for (const note of notes) console.log(`  ${note}`);
for (const { path, why } of EXCLUDED) console.log(`  excluded ${path}: ${why}`);

if (failures.length) {
  console.error(`share-roundtrip FAILED — ${failures.length} failure(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`share-roundtrip ok — 4 links opened end to end (untouched, edited, whole tree, own genre), ${stampCases.length} stamps checked, ${excluded} excluded difference(s)`);
process.exit(0);
