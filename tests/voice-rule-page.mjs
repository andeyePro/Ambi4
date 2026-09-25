/**
 * tests/voice-rule-page.mjs
 * Run with: npm run build && node tests/voice-rule-page.mjs
 * (or as part of `node tests/all.mjs`, which discovers this file by name).
 *
 * v0.0.195 put a voice rule (chance, when, pool, order) behind the page's own
 * controls: the Randomise row's Voice knob (now "Voice chance"), the When
 * select beside it, and the Pool editor. tests/voice-rule-smoke.mjs already
 * proves the rule at the engine directly, against hand-built params; this
 * suite drives the BUILT page (dist/index.html) in jsdom — the way
 * tests/blank-slate-sounds.mjs does, boot/stubs/fast-clock copied verbatim
 * from it — so it is self-contained, and proves the DOM path a person
 * actually uses reaches those same engine params.
 *
 * Every assertion reads window.__ambi4Engine.getParams()/getResolved(); the
 * DOM is only ever the way IN.
 *
 * Each check is independent and continues past a failure — one check's throw
 * or assertion failure does not stop the others. The suite exits non-zero,
 * listing every failure, iff at least one check failed, the same contract
 * tests/all.mjs expects of every suite it discovers.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(repoRoot, 'dist');
const indexHtml = join(distDir, 'index.html');

if (!existsSync(indexHtml)) {
  console.error('voice-rule-page: dist/index.html is missing — run `npm run build` first.');
  process.exit(1);
}

const html = readFileSync(indexHtml, 'utf8');
const scriptMatch = /<script[^>]*type="module"[^>]*src="([^"]+)"/.exec(html);
if (!scriptMatch) {
  console.error('voice-rule-page: no module script found in dist/index.html');
  process.exit(1);
}
const bundlePath = join(distDir, scriptMatch[1].replace(/^\//, ''));
if (!existsSync(bundlePath)) {
  console.error(`voice-rule-page: built page script missing: ${bundlePath}`);
  process.exit(1);
}

// Read from SOURCE for the engine's own numbers (bar length) — the same
// discipline tests/blank-slate-sounds.mjs and tests/page-boot.mjs use, so
// this suite is measured against the engine's own contract rather than a
// number written into the test by hand.
const engineModule = await import(
  pathToFileURL(join(repoRoot, 'src/scripts/ambient-engine.js')).href
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(check, timeoutMs = 4000, stepMs = 25) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return true;
    await sleep(stepMs);
  }
  return check();
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

const failures = [];
const passed = [];
function record(name, ok, detail) {
  if (ok) passed.push(name);
  else failures.push(`${name} — ${detail}`);
}
/** Runs one check block; a throw inside it fails just that check. */
async function checkBlock(name, fn) {
  try {
    await fn();
  } catch (err) {
    failures.push(`${name} — threw: ${err && err.stack ? err.stack : err}`);
  }
}

// ---------------------------------------------------------------------------
// Boot harness — copied from tests/blank-slate-sounds.mjs's bootScenario():
// a fast-clock AudioContext (SPEED×) so waiting bars out doesn't take a
// bar's real length, real DOM events in, every engine.setParams() payload
// and 'note'/'bar' event available for inspection. Each call boots a FRESH
// jsdom + fresh AudioContext and re-imports the built bundle with a
// cache-busting query string, exactly as blank-slate-sounds.mjs does — Node's
// ESM loader caches by exact specifier, so importing the identical dist/ URL
// twice would hand back the ALREADY-INITIALISED module rather than booting a
// fresh page into the fresh document.
// ---------------------------------------------------------------------------

let scenarioCounter = 0;

async function bootScenario(SPEED = 6) {
  scenarioCounter += 1;
  const oscLog = []; // { t, node, type, freq, buffer? }
  let clockStart = null;

  function stubAudioParam(value = 0) {
    const p = { value, defaultValue: value, last: value };
    const rec = (v) => {
      if (Number.isFinite(v)) {
        p.last = v;
        p.value = v;
      }
      return p;
    };
    p.setValueAtTime = (v) => rec(v);
    p.linearRampToValueAtTime = (v) => rec(v);
    p.exponentialRampToValueAtTime = (v) => rec(v);
    p.setTargetAtTime = (v) => rec(v);
    p.setValueCurveAtTime = () => p;
    p.cancelScheduledValues = () => p;
    p.cancelAndHoldAtTime = () => p;
    return p;
  }

  function node(extra = {}) {
    const n = {
      __out: [],
      connect(target) {
        n.__out.push(target);
        return target; // matches the real Web Audio API's chaining return
      },
      disconnect() {},
      addEventListener() {},
      removeEventListener() {},
      ...extra,
    };
    return n;
  }

  class Ctx {
    constructor() {
      this.state = 'suspended';
      this.sampleRate = 48000;
      this.baseLatency = 0.01;
      this.outputLatency = 0.02;
      this.destination = node({ channelCount: 2 });
      this.listener = {};
      Ctx.last = this;
    }
    get currentTime() {
      return clockStart === null ? 0 : ((Date.now() - clockStart) / 1000) * SPEED;
    }
    createGain() {
      return node({ gain: stubAudioParam(1), __gain: true });
    }
    createOscillator() {
      const o = node({
        frequency: stubAudioParam(440),
        detune: stubAudioParam(0),
        type: 'sine',
        __osc: true,
        setPeriodicWave() {},
        stop() {},
      });
      o.start = (t) => {
        oscLog.push({
          t: t ?? 0,
          node: o,
          type: o.type,
          freq: o.frequency.last !== 440 ? o.frequency.last : o.frequency.value,
        });
      };
      return o;
    }
    createBufferSource() {
      const b = node({
        buffer: null, playbackRate: stubAudioParam(1), detune: stubAudioParam(0), loop: false, stop() {},
      });
      b.start = (t) => oscLog.push({ t: t ?? 0, node: b, buffer: true });
      return b;
    }
    createBiquadFilter() {
      return node({
        type: 'lowpass', frequency: stubAudioParam(350), Q: stubAudioParam(1), gain: stubAudioParam(0), detune: stubAudioParam(0),
      });
    }
    createStereoPanner() { return node({ pan: stubAudioParam(0) }); }
    createPanner() { return node({ positionX: stubAudioParam(0) }); }
    createDelay() { return node({ delayTime: stubAudioParam(0) }); }
    createConvolver() { return node({ buffer: null, normalize: true }); }
    createDynamicsCompressor() {
      return node({
        threshold: stubAudioParam(-24), knee: stubAudioParam(30), ratio: stubAudioParam(12),
        attack: stubAudioParam(0.003), release: stubAudioParam(0.25), reduction: 0,
      });
    }
    createWaveShaper() { return node({ curve: null, oversample: 'none' }); }
    createAnalyser() {
      return node({
        fftSize: 2048, frequencyBinCount: 1024, smoothingTimeConstant: 0.8, minDecibels: -100, maxDecibels: -30,
        getByteTimeDomainData: (a) => a.fill(128), getFloatTimeDomainData: (a) => a.fill(0),
        getByteFrequencyData: (a) => a.fill(0), getFloatFrequencyData: (a) => a.fill(-100),
      });
    }
    createMediaStreamDestination() { return node({ stream: { getTracks: () => [] } }); }
    createBuffer(ch, len, sr) {
      const d = Array.from({ length: ch }, () => new Float32Array(len));
      return { numberOfChannels: ch, length: len, sampleRate: sr, duration: len / sr, getChannelData: (i) => d[i] };
    }
    createPeriodicWave() { return {}; }
    resume() {
      this.state = 'running';
      if (clockStart === null) clockStart = Date.now();
      return Promise.resolve();
    }
    suspend() { this.state = 'suspended'; return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
    addEventListener() {}
    removeEventListener() {}
  }

  const dom = new JSDOM(html, { url: 'https://ambi4.work/', pretendToBeVisual: true, runScripts: 'outside-only' });
  const { window } = dom;
  const noopCtx = new Proxy({}, {
    get: (t, k) => (k in t ? t[k]
      : k === 'measureText' ? () => ({ width: 0 })
        : k === 'getImageData' ? () => ({ data: new Uint8ClampedArray(4) })
          : k.toString().startsWith('create') ? () => ({ addColorStop() {} })
            : () => {}),
    set: (t, k, v) => { t[k] = v; return true; },
  });
  window.HTMLCanvasElement.prototype.getContext = () => noopCtx;
  window.HTMLCanvasElement.prototype.toDataURL = () => 'data:,';
  window.AudioContext = Ctx;
  window.OfflineAudioContext = undefined;
  window.devicePixelRatio = 1;
  for (const key of [
    'window', 'document', 'navigator', 'location', 'history', 'localStorage', 'sessionStorage',
    'getComputedStyle', 'matchMedia', 'requestAnimationFrame', 'cancelAnimationFrame', 'HTMLElement',
    'HTMLCanvasElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent',
    'PointerEvent', 'CSS', 'DOMParser', 'Image', 'Blob', 'URL', 'AudioContext',
  ]) {
    if (window[key] !== undefined) {
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: window[key] });
    }
  }
  globalThis.self = window;

  const errors = [];
  console.error = (...args) => { errors.push(args.map(String).join(' ')); };

  // No consent cookie: every first-time visitor's state.
  await import(`${pathToFileURL(bundlePath).href}?voice-rule-page-${scenarioCounter}`);
  const doc = window.document;
  const app = doc.getElementById('generator-app');
  const bootStarted = Date.now();
  while (app.hidden && Date.now() - bootStarted < 8000) await sleep(25);
  if (app.hidden) throw new Error(`page never booted (scenario ${scenarioCounter})`);

  const engine = window.__ambi4Engine;
  const payloads = [];
  const realSetParams = engine.setParams.bind(engine);
  engine.setParams = (p) => { payloads.push(structuredClone(p)); return realSetParams(p); };
  const notes = [];
  engine.on('note', (e) => notes.push(e));

  return { win: window, doc, engine, payloads, notes, oscLog, Ctx, errors };
}

// ---------------------------------------------------------------------------
// DOM-interaction helpers
// ---------------------------------------------------------------------------

const clickEl = (win, el) => el && el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));

function setSelect(win, doc, id, value) {
  const el = doc.getElementById(id);
  if (!el) throw new Error(`no #${id} in the DOM`);
  el.value = value;
  el.dispatchEvent(new win.Event('change', { bubbles: true }));
  return el;
}

function barSecondsOf(engine) {
  const p = engine.getParams();
  return engineModule.beatsPerBar(p.timeSignature) * 60 / (p.bpm * (p.speed || 1));
}

async function clickPlay(win, doc) {
  clickEl(win, doc.getElementById('toggle-play'));
  await sleep(300);
}

/** Open a track's editor accordion if it is not already open (the toggle is a flip). */
async function ensureTrackEditorOpen(win, doc, track) {
  const already = doc.getElementById(`voice-editor-${track}`);
  if (already && !already.hidden) return already;
  clickEl(win, doc.getElementById(`voice-edit-toggle-${track}`));
  await waitUntil(() => {
    const ed = doc.getElementById(`voice-editor-${track}`);
    return Boolean(ed && !ed.hidden && ed.querySelector('.vary-cells'));
  });
  return doc.getElementById(`voice-editor-${track}`);
}

/**
 * The Voice chance knob root (a knob.js `.knob` element, aria-label "Voice
 * chance") inside a track's editor. Looked up FRESH every time it is needed
 * — the Pool editor's Done/No pool re-renders the whole track editor
 * (renderVoiceEditorIfOpen), which rebuilds every knob from scratch, so a
 * reference taken before that point is stale afterwards.
 */
function findVoiceChanceKnob(doc, track) {
  const editor = doc.getElementById(`voice-editor-${track}`);
  if (!editor) return null;
  return [...editor.querySelectorAll('.vary-cells .knob, .rule-chance-slot .knob')]
    .find((k) => k.getAttribute('aria-label') === 'Voice chance') || null;
}

/**
 * Drive the knob's click-to-type readout, the same path
 * tests/page-boot.mjs uses for the Release and Tempo dials: click the
 * `.knob-value` readout button to open its typed editor, set the input's
 * value, then Enter to commit. This particular knob was built with no
 * `parse` option (see src/scripts/knob.js's `parsed()`), so — unlike a
 * log-mapped dial such as Tempo — the typed text is read on the knob's own
 * internal 0–21 raw scale, not through its display format ("Hold" / "Auto" /
 * a percentage). Raw 0 is the Auto detent (voiceRule.chance = null, follows
 * Randomness); raw 1 is Hold (voiceRule.chance = 0, exactly what a rule
 * needs to hold a pick); raw 21 is chance = 1. Typing "0" therefore reaches
 * Auto, not Hold — this suite types "1" for Hold, documented at its call
 * site below.
 */
function typeKnobValue(win, doc, track, text) {
  const root = findVoiceChanceKnob(doc, track);
  if (!root) throw new Error(`no "Voice chance" knob in ${track}'s editor`);
  const readout = root.querySelector('.knob-value');
  if (!readout) throw new Error('the Voice chance knob has no .knob-value readout');
  clickEl(win, readout);
  const edit = root.querySelector('.knob-value-edit');
  if (!edit) throw new Error('clicking the Voice chance readout did not open its typed editor');
  edit.value = text;
  edit.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}

/** Dispatch a keydown directly on the knob root — knob.js listens there, not on document.activeElement. */
function keyKnob(win, doc, track, key) {
  const root = findVoiceChanceKnob(doc, track);
  if (!root) throw new Error(`no "Voice chance" knob in ${track}'s editor`);
  root.dispatchEvent(new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  return root;
}

// ===========================================================================
// Checks
// ===========================================================================

/**
 * [1] Pin Synthwave, open Melody's editor, and set its Voice chance knob to
 * Hold (chance 0). See typeKnobValue's comment: raw 1, not raw 0, is Hold —
 * this is typed directly rather than via Home (which lands on the Auto
 * detent, chance null, not chance 0).
 */
async function check1(ctx) {
  const { win, doc, engine } = ctx;
  await waitUntil(() => !!doc.querySelector('#genre-select option[value="g:synthwave"]'), 4000);
  setSelect(win, doc, 'genre-select', 'g:synthwave');
  const pinned = await waitUntil(
    () => engine.getParams().genre === 'synthwave' && engine.getParams().tracks.melody.voice === 'keys',
    4000
  );
  record(
    '[1a] pinning Synthwave reaches the engine with melody on Keys',
    pinned,
    `engine.getParams().genre = ${JSON.stringify(engine.getParams().genre)}, ` +
      `tracks.melody.voice = ${JSON.stringify(engine.getParams().tracks.melody.voice)}`
  );

  await ensureTrackEditorOpen(win, doc, 'melody');
  const knobFound = await waitUntil(() => !!findVoiceChanceKnob(doc, 'melody'), 3000);
  if (!knobFound) {
    record('[1b] Melody editor has a Voice chance knob', false, 'no .knob[aria-label="Voice chance"] found under #voice-editor-melody (.vary-cells or .rule-chance-slot)');
    return;
  }
  typeKnobValue(win, doc, 'melody', '1'); // raw 1 = Hold = chance 0 (see typeKnobValue's comment)
  const held = await waitUntil(() => {
    const rule = engine.getParams().tracks.melody.voiceRule;
    return rule && typeof rule === 'object' && rule.chance === 0;
  }, 2000);
  record(
    '[1b] typing "1" into the Voice chance readout (raw scale, Hold) sets voiceRule.chance = 0',
    held,
    `engine.getParams().tracks.melody.voiceRule = ${JSON.stringify(engine.getParams().tracks.melody.voiceRule)}`
  );
}

/** [2] Play; the held melody must read 'keys' at every one of 8 bars. */
async function check2(ctx) {
  const { win, doc, engine } = ctx;
  const voices = [];
  const unsub = engine.on('bar', () => voices.push(engine.getResolved().tracks.melody.voice));
  try {
    if (!engine.running) await clickPlay(win, doc);
    const gotEight = await waitUntil(() => voices.length >= 8, 25000, 50);
    const firstEight = voices.slice(0, 8);
    record(
      '[2] melody reads \'keys\' at every bar for 8 bars while held at Chance 0',
      gotEight && firstEight.every((v) => v === 'keys'),
      `bars seen: ${voices.length}; first 8: ${JSON.stringify(firstEight)}`
    );
  } finally {
    unsub();
  }
}

/** [3] Next (#fast-forward) keeps the held rule and the pick it holds. */
async function check3(ctx) {
  const { win, doc, engine } = ctx;
  clickEl(win, doc.getElementById('fast-forward'));
  const ok = await waitUntil(() => {
    const t = engine.getParams().tracks.melody;
    return t.voiceRule && t.voiceRule.chance === 0 && t.voice === 'keys';
  }, 4000);
  const t = engine.getParams().tracks.melody;
  record(
    '[3] Next keeps voiceRule.chance = 0 and voice = \'keys\'',
    ok,
    `after Next: tracks.melody.voice = ${JSON.stringify(t.voice)}, voiceRule = ${JSON.stringify(t.voiceRule)}`
  );
}

/**
 * [4] Pool editor: the melody bank's Organ-stab entry is registry id "stab"
 * (label "Organ stab" — see src/scripts/engine-voices.js's melody bank),
 * not "organstab". ensureVoiceRule seeded the pool from the whole bank when
 * check 1 first touched the rule, so "stab" is in it. Remove it, choose
 * In turn, Done, and check the engine.
 */
async function check4(ctx) {
  const { win, doc, engine } = ctx;
  clickEl(win, doc.getElementById('voice-rule-pool-melody'));
  const opened = await waitUntil(() => {
    const panel = doc.getElementById('voice-blend-editor');
    return !!(panel && panel.querySelector('.blend-row[data-voice="stab"]'));
  }, 3000);
  if (!opened) {
    const panel = doc.getElementById('voice-blend-editor');
    record(
      '[4] Pool editor opens with an Organ stab (voice id "stab") row',
      false,
      panel
        ? `#voice-blend-editor exists but has no .blend-row[data-voice="stab"]; rows present: ` +
          `${[...panel.querySelectorAll('.blend-row[data-voice]')].map((r) => r.dataset.voice).join(', ')}`
        : '#voice-blend-editor was never created after clicking #voice-rule-pool-melody'
    );
    return;
  }
  const panel = doc.getElementById('voice-blend-editor');
  const row = panel.querySelector('.blend-row[data-voice="stab"]');
  clickEl(win, row.querySelector('.blend-remove'));
  const turnRadio = panel.querySelector('input[name="blend-order-melody"][value="turn"]');
  if (turnRadio) {
    clickEl(win, turnRadio);
    if (!turnRadio.checked) {
      turnRadio.checked = true;
      turnRadio.dispatchEvent(new win.Event('change', { bubbles: true }));
    }
  }
  const doneBtn = [...panel.querySelectorAll('button')].find((b) => b.textContent === 'Done');
  if (!doneBtn) {
    record('[4] Pool editor has a Done button', false, `buttons present: ${[...panel.querySelectorAll('button')].map((b) => b.textContent).join(', ')}`);
    return;
  }
  clickEl(win, doneBtn);
  const ok = await waitUntil(() => {
    const rule = engine.getParams().tracks.melody.voiceRule;
    return rule && Array.isArray(rule.pool) && !rule.pool.some((p) => p.id === 'stab') && rule.order === 'turn';
  }, 3000);
  const rule = engine.getParams().tracks.melody.voiceRule;
  record(
    '[4] removing Organ stab from the Pool and choosing In turn reaches the engine (no "stab", order "turn")',
    ok,
    `voiceRule = ${JSON.stringify(rule)}`
  );
}

/** [5] The When select reaches the engine's rule.when. */
async function check5(ctx) {
  const { win, doc, engine } = ctx;
  const sel = doc.getElementById('voice-rule-when-melody');
  if (!sel) {
    record('[5] #voice-rule-when-melody exists', false, 'not found — the Pool editor\'s Done in check 4 re-renders the track editor, which should have rebuilt it');
    return;
  }
  setSelect(win, doc, 'voice-rule-when-melody', 'section');
  const ok = await waitUntil(() => {
    const rule = engine.getParams().tracks.melody.voiceRule;
    return rule && rule.when === 'section';
  }, 3000);
  record(
    '[5] setting the When select to \'section\' sets voiceRule.when',
    ok,
    `voiceRule = ${JSON.stringify(engine.getParams().tracks.melody.voiceRule)}`
  );
}

/**
 * [6] Raise Voice chance to 1 via keyboard End (raw max = 21 = chance 1,
 * unlike Home/raw 0 used for check 1 — see typeKnobValue's comment), then
 * confirm the picker's live option reads "· drawn" once the rule has any
 * chance of a redraw (refreshVoiceSelect's `ruled` branch, v0.0.195).
 */
async function check6(ctx) {
  const { win, doc, engine } = ctx;
  const knobFound = await waitUntil(() => !!findVoiceChanceKnob(doc, 'melody'), 3000);
  if (!knobFound) {
    record('[6a] Voice chance knob is present after check 4/5\'s re-renders', false, 'no .knob[aria-label="Voice chance"] found under #voice-editor-melody');
    return;
  }
  keyKnob(win, doc, 'melody', 'End');
  const raised = await waitUntil(() => engine.getParams().tracks.melody.voiceRule?.chance === 1, 3000);
  record(
    '[6a] keyboard End on the Voice chance knob sets voiceRule.chance = 1',
    raised,
    `voiceRule = ${JSON.stringify(engine.getParams().tracks.melody.voiceRule)}`
  );

  if (!engine.running) await clickPlay(win, doc);
  const drawnOk = await waitUntil(() => {
    const opt = doc.querySelector('#track-voice-melody .voice-live-option');
    return !!(opt && /·\s*drawn/.test(opt.textContent || ''));
  }, 8000, 100);
  const opt = doc.querySelector('#track-voice-melody .voice-live-option');
  record(
    '[6b] the melody picker shows a "· drawn" live option once Chance > 0',
    drawnOk,
    `#track-voice-melody .voice-live-option = ${opt ? JSON.stringify(opt.textContent) : 'absent'}`
  );
}

/** [7] Picking a voice explicitly holds the rule (chance -> 0) at that voice. */
async function check7(ctx) {
  const { win, doc, engine } = ctx;
  setSelect(win, doc, 'track-voice-melody', 'tines');
  const ok = await waitUntil(() => {
    const t = engine.getParams().tracks.melody;
    return t.voice === 'tines' && t.voiceRule && t.voiceRule.chance === 0;
  }, 3000);
  const t = engine.getParams().tracks.melody;
  record(
    '[7] picking Tines explicitly holds the rule (voice = \'tines\', voiceRule.chance = 0)',
    ok,
    `voice = ${JSON.stringify(t.voice)}, voiceRule = ${JSON.stringify(t.voiceRule)}`
  );
}

/** [8] Create -> Blank slate zeroes every track's voice rule (chance 0, empty pool). */
async function check8(ctx) {
  const { win, doc, engine } = ctx;
  clickEl(win, doc.getElementById('play-along-open'));
  await sleep(50);
  clickEl(win, doc.getElementById('create-blank'));
  const ok = await waitUntil(() => {
    const tracks = engine.getParams().tracks;
    return Object.values(tracks).every(
      (t) => t.voiceRule && t.voiceRule.chance === 0 && Array.isArray(t.voiceRule.pool) && t.voiceRule.pool.length === 0
    );
  }, 3000);
  const tracks = engine.getParams().tracks;
  const bad = Object.entries(tracks).filter(
    ([, t]) => !(t.voiceRule && t.voiceRule.chance === 0 && Array.isArray(t.voiceRule.pool) && t.voiceRule.pool.length === 0)
  );
  record(
    '[8] Create -> Blank slate zeroes every track\'s voiceRule (chance 0, empty pool)',
    ok,
    bad.length
      ? `tracks with a non-zeroed rule: ${bad.map(([id, t]) => `${id}=${JSON.stringify(t.voiceRule)}`).join('; ')}`
      : `all ${Object.keys(tracks).length} tracks zeroed`
  );
}

// ===========================================================================
// Run everything — one continuous scenario, in the order the checks narrate
// (pin -> hold -> play -> Next -> Pool -> When -> raise -> pick -> Blank
// slate), each step wrapped so a failure does not stop the ones after it.
// ===========================================================================

const ctx = await bootScenario();
try {
  await checkBlock('[1] PIN + HOLD', () => check1(ctx));
  await checkBlock('[2] PLAY 8 BARS HELD', () => check2(ctx));
  await checkBlock('[3] NEXT KEEPS HOLD', () => check3(ctx));
  await checkBlock('[4] POOL EDITOR', () => check4(ctx));
  await checkBlock('[5] WHEN SELECT', () => check5(ctx));
  await checkBlock('[6] RAISE CHANCE + DRAWN', () => check6(ctx));
  await checkBlock('[7] PICK HOLDS', () => check7(ctx));
  await checkBlock('[8] BLANK SLATE ZEROES', () => check8(ctx));
} finally {
  ctx.win.close();
}

console.log(`\n${passed.length}/${passed.length + failures.length} checks green`);
for (const name of passed) console.log(`  ok   ${name}`);
if (failures.length) {
  console.log('\nvoice-rule-page FAILED');
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
console.log('voice-rule-page ok');
process.exit(0);
