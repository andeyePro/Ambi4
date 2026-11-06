/**
 * tests/grid-lanes-page.mjs
 * Run with: npm run build && node tests/grid-lanes-page.mjs
 * (or as part of `node tests/all.mjs`, which discovers this file by name).
 *
 * Step lanes are as long as their track's RESOLUTION stores — forty slots at
 * demisemiquavers, thirty at semiquaver triplets — and every page path that
 * builds or repairs one used to cut it to twenty: the load path (so a reload,
 * a preset, a link and undo), the "+" tab, the block editor, and the Create
 * writers (Words, Write a tune, typed Beat). The grid then threw drawing slot
 * 20, and the engine padded the missing slots with its all-on default. This
 * suite boots the BUILT page (the jsdom harness tests/voice-rule-page.mjs and
 * tests/blank-slate-sounds.mjs share, copied) from a seeded device and drives
 * those paths, plus the smaller faults the same hunt found: Strip a layer
 * keyed on the id 'percussion', a Words metre change redrawing one grid, a
 * one-bar write leaving a chain behind, focus lost on removing a lane, a
 * group past the bar invisible to "next group", and the resolution buttons
 * named only by their glyphs.
 *
 * Every assertion reads the engine (window.__ambi4Engine) or the page's own
 * stored settings; the DOM is the way in.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(repoRoot, 'dist');
const indexHtml = join(distDir, 'index.html');

if (!existsSync(indexHtml)) {
  console.error('grid-lanes-page: dist/index.html is missing — run `npm run build` first.');
  process.exit(1);
}

const html = readFileSync(indexHtml, 'utf8');
const scriptMatch = /<script[^>]*type="module"[^>]*src="([^"]+)"/.exec(html);
if (!scriptMatch) {
  console.error('grid-lanes-page: no module script found in dist/index.html');
  process.exit(1);
}
const bundlePath = join(distDir, scriptMatch[1].replace(/^\//, ''));
if (!existsSync(bundlePath)) {
  console.error(`grid-lanes-page: built page script missing: ${bundlePath}`);
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

async function bootScenario(SPEED = 6, seed = null) {
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

  // A seeded device: consent granted and the stored piece written raw, so the
  // page boots through its own LOAD path (normaliseSequencerList) with it.
  if (seed) seed(window);
  await import(`${pathToFileURL(bundlePath).href}?grid-lanes-page-${scenarioCounter}`);
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
// The seeded piece
// ---------------------------------------------------------------------------
// One stored device state carries every situation the hunt found:
//   * bass at demisemiquavers (forty stored slots) with steps at 0 and 30 —
//     slot 30 is past the twenty every page path used to cut a lane to;
//   * the kit at demisemiquavers too, so typed Beat writes a 32-slot bar;
//   * melody chained over two bars, with a probability group at slot 18 —
//     past the sixteen a 4/4 bar plays, still in the lane;
//   * a user percussive track ("hand-kit"), which Strip a layer must treat as
//     a kit by its family rather than by the id 'percussion'.

const FINE = 0.125;
const FINE_SLOTS = engineModule.laneSlotsFor(FINE);
const blankStep = () => ({ on: false, prob: 1, vmin: 0.5, vmax: 0.9 });
const lane = (n, onAt = () => false, extra = () => ({})) =>
  Array.from({ length: n }, (unused, i) => ({ ...blankStep(), on: Boolean(onAt(i)), ...extra(i) }));
const onSlots = (steps, below = Infinity) =>
  (steps || []).map((s, i) => (s && s.on && i < below ? i : null)).filter((i) => i !== null);

const SEED = {
  timeSignature: '4/4',
  tracks: {
    bass: {
      state: 'on',
      stepBeats: FINE,
      sequencers: [{ mode: 'manual', weights: [1], steps: lane(FINE_SLOTS, (i) => i === 0 || i === 30) }],
    },
    percussion: { state: 'on', stepBeats: FINE, sequencerAdvance: 'chain' },
    melody: {
      state: 'on',
      sequencerAdvance: 'chain',
      sequencers: [
        { mode: 'manual', weights: [1, 1], steps: lane(20, (i) => i === 0 || i === 18, (i) => (i === 18 ? { group: 0 } : {})) },
        { mode: 'manual', weights: [1, 1], steps: lane(20, (i) => i === 4) },
      ],
    },
    'hand-kit': {
      state: 'on',
      sequencers: [{
        mode: 'manual',
        weights: [1],
        steps: { low: lane(20, (i) => i % 4 === 0), mid: lane(20, (i) => i === 4), high: lane(20) },
      }],
    },
  },
  userTracks: [{ id: 'hand-kit', label: 'Hand kit', family: 'percussive', voiceSet: 'percussion' }],
};

const seedDevice = (win) => {
  win.document.cookie = 'ambi4-consent=granted; Path=/';
  win.localStorage.setItem('ambi4:generator', JSON.stringify(SEED));
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const clickEl = (win, el) => el && el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));

function setSelect(win, doc, id, value) {
  const el = doc.getElementById(id);
  if (!el) throw new Error(`no #${id} in the DOM`);
  el.value = value;
  el.dispatchEvent(new win.Event('change', { bubbles: true }));
  if (el.value !== value) throw new Error(`#${id} has no option ${value}`);
  return el;
}

async function openEditor(win, doc, track) {
  const already = doc.getElementById(`voice-editor-${track}`);
  if (!(already && !already.hidden)) clickEl(win, doc.getElementById(`voice-edit-toggle-${track}`));
  await waitUntil(() => {
    const ed = doc.getElementById(`voice-editor-${track}`);
    return Boolean(ed && !ed.hidden && ed.querySelector('.seq-cell'));
  });
  const ed = doc.getElementById(`voice-editor-${track}`);
  if (!ed || ed.hidden || !ed.querySelector('.seq-cell')) throw new Error(`${track}'s editor did not open with a grid`);
  return ed;
}

/** Cells in ONE lane row of an editor's grid — the bar the grid draws. */
const cellsPerRow = (ed) => {
  const first = ed.querySelector('.seq-cell');
  return first ? first.parentElement.querySelectorAll('.seq-cell').length : 0;
};

const live = (engine, track) => engine.getParams().tracks[track];

/** What the page itself holds, read back from the device after a persist. */
async function stored(win, track) {
  await sleep(400); // persistSettings debounces by 250 ms
  const raw = win.localStorage.getItem('ambi4:generator');
  const s = raw ? JSON.parse(raw) : null;
  return s && s.tracks ? s.tracks[track] : null;
}

const laneLengths = (seqs) => (seqs || []).flatMap((seq) => (
  Array.isArray(seq.steps) ? [seq.steps.length] : Object.values(seq.steps || {}).map((l) => l.length)
));

const pageErrors = (ctx) => ctx.errors.filter((line) => /TypeError|Cannot read|undefined/.test(line));

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

async function checkLoad(ctx) {
  // #1: the load path sized the bass lane to TWENTY, and the engine padded
  // slots 20+ back with the all-on default: a reload rewrote the line.
  const seq = live(ctx.engine, 'bass').sequencers[0];
  record('load keeps a demisemiquaver lane at its stored length',
    seq.steps.length === FINE_SLOTS, `length ${seq.steps.length}, wanted ${FINE_SLOTS}`);
  record('load keeps the step at slot 30 and adds none',
    JSON.stringify(onSlots(seq.steps)) === '[0,30]', `on at ${onSlots(seq.steps).join(',')}`);
}

async function checkPlusTab(ctx) {
  const { win, doc, engine } = ctx;
  const ed = await openEditor(win, doc, 'bass');
  record('the bass grid draws a 32-slot bar', cellsPerRow(ed) === 32, `${cellsPerRow(ed)} cells`);
  const before = pageErrors(ctx).length;
  clickEl(win, ed.querySelector('.seq-add'));
  await sleep(200);
  const seqs = live(engine, 'bass').sequencers;
  record('"+" adds a sequencer', seqs.length === 2, `${seqs.length} sequencers`);
  record('"+" keeps every bass lane forty slots on the page',
    laneLengths((await stored(win, 'bass')).sequencers).every((n) => n === FINE_SLOTS),
    `stored lengths ${laneLengths((await stored(win, 'bass')).sequencers).join(',')}`);
  record('"+" copies slot 30 and switches nothing else on',
    seqs.every((seq) => JSON.stringify(onSlots(seq.steps)) === '[0,30]'),
    seqs.map((seq) => onSlots(seq.steps).join(',')).join(' | '));
  const after = pageErrors(ctx).slice(before);
  record('"+" redraws the grid without throwing', after.length === 0, after.join(' / ').slice(0, 300));
}

async function checkResolutionNames(ctx) {
  // #9: the ×2 / ÷2 buttons were named by their glyphs alone, and a test
  // that picked "finer" by /×2/ pressed the coarser one.
  const ed = await openEditor(ctx.win, ctx.doc, 'bass');
  const names = [...ed.querySelectorAll('.seq-res-step')].map((b) => b.getAttribute('aria-label') || '');
  record('the resolution buttons name their direction',
    names.some((n) => /^Coarser grid/.test(n)) && names.some((n) => /^Finer grid/.test(n)),
    `aria-labels: ${JSON.stringify(names)}`);
}

async function checkGroups(ctx) {
  // #8: a group at slot 18 (past a 4/4 bar's sixteen) was invisible to the
  // scan, so the "next group" dot reused its id 0.
  const ed = await openEditor(ctx.win, ctx.doc, 'melody');
  const host = ed.querySelector('.seq-dot-cell');
  const ids = host ? [...host.querySelectorAll('.seq-dot')].map((d) => d.dataset.group) : [];
  record('the next group skips an id used past the bar', JSON.stringify(ids) === '["0","1"]',
    `dots offer groups ${JSON.stringify(ids)}`);
}

async function checkBeat(ctx) {
  // #3: typed Beat built 20-slot lanes; at demisemiquavers a 4/4 bar is 32,
  // so slots 20-39 of the lanes it did not write kept the old grid's hits.
  const { win, doc, engine } = ctx;
  setSelect(win, doc, 'compose-beat-track', 'percussion');
  doc.getElementById('compose-beat-text').value = Array.from({ length: 32 }, (u, i) => (i % 4 === 0 ? 'K' : '.')).join(' ');
  clickEl(win, doc.getElementById('compose-beat-write'));
  await sleep(200);
  const t = live(engine, 'percussion');
  const steps = t.sequencers[0].steps;
  record('typed Beat writes the whole 32-slot bar',
    JSON.stringify(onSlots(steps.low, 32)) === JSON.stringify([0, 4, 8, 12, 16, 20, 24, 28]),
    `low on at ${onSlots(steps.low, 32).join(',')}`);
  const others = Object.entries(steps).filter(([id]) => id !== 'low').flatMap(([id, l]) => onSlots(l).map((i) => `${id}:${i}`));
  record('typed Beat leaves the lanes it did not write silent', others.length === 0, `still on: ${others.join(' ')}`);
  record('typed Beat stores forty-slot kit lanes',
    laneLengths((await stored(win, 'percussion')).sequencers).every((n) => n === FINE_SLOTS),
    `stored lengths ${laneLengths((await stored(win, 'percussion')).sequencers).join(',')}`);
  // #6: one bar is not a chain.
  record('a one-bar Beat clears the chain', t.sequencerAdvance !== 'chain'
    && (await stored(win, 'percussion')).sequencerAdvance === undefined,
    `engine ${t.sequencerAdvance}, page ${(await stored(win, 'percussion')).sequencerAdvance}`);
}

async function checkMelodyChain(ctx) {
  // #6: a one-bar typed melody over a chained two-bar one.
  const { win, doc, engine } = ctx;
  setSelect(win, doc, 'compose-melody-track', 'melody');
  doc.getElementById('compose-melody-text').value = 'C4 D4 E4 F4';
  clickEl(win, doc.getElementById('compose-melody-write'));
  await sleep(200);
  const t = live(engine, 'melody');
  const page = await stored(win, 'melody');
  record('a one-bar melody clears the chain', t.sequencers.length === 1 && t.sequencerAdvance !== 'chain'
    && page.sequencerAdvance === undefined,
    `${t.sequencers.length} sequencers, engine ${t.sequencerAdvance}, page ${page.sequencerAdvance}`);
}

async function checkTune(ctx) {
  const { win, doc, engine } = ctx;
  setSelect(win, doc, 'compose-tune-track', 'bass');
  clickEl(win, doc.getElementById('compose-tune'));
  await waitUntil(() => live(engine, 'bass').sequencers.some((seq) => seq.hand && seq.steps.some((s) => Number.isFinite(s.midi))), 3000);
  const page = await stored(win, 'bass');
  const t = live(engine, 'bass');
  record('the tune wrote onto the bass', t.sequencers.some((seq) => seq.steps.some((s) => Number.isFinite(s.midi))),
    'no pinned step on the bass');
  record('the tune stores forty-slot lanes', laneLengths(page.sequencers).every((n) => n === FINE_SLOTS),
    `stored lengths ${laneLengths(page.sequencers).join(',')}`);
  const mismatch = t.sequencers.map((seq, b) => [onSlots(seq.steps).join(','), onSlots(page.sequencers[b]?.steps).join(',')])
    .filter(([e, p]) => e !== p);
  record('the engine plays the tune the page shows', mismatch.length === 0, JSON.stringify(mismatch).slice(0, 300));
}

async function checkWords(ctx) {
  const { win, doc, engine } = ctx;
  setSelect(win, doc, 'compose-words-track', 'bass');
  doc.getElementById('compose-words-text').value = 'the river runs beneath the bridge and carries all the light away';
  clickEl(win, doc.getElementById('compose-words-write'));
  await waitUntil(() => live(engine, 'bass').sequencers.every((seq) => !seq.steps.some((s) => s.on && !Number.isFinite(s.midi))), 3000);
  await sleep(200);
  const page = await stored(win, 'bass');
  const t = live(engine, 'bass');
  record('Words stores forty-slot lanes', laneLengths(page.sequencers).every((n) => n === FINE_SLOTS),
    `stored lengths ${laneLengths(page.sequencers).join(',')}`);
  const mismatch = t.sequencers.map((seq, b) => [onSlots(seq.steps).join(','), onSlots(page.sequencers[b]?.steps).join(',')])
    .filter(([e, p]) => e !== p);
  record('the engine sings the syllables the page shows', mismatch.length === 0, JSON.stringify(mismatch).slice(0, 300));
}

async function checkWordsOneBar(ctx) {
  // #6: a one-bar Words write over a chained multi-bar line must clear the
  // chain on the page AND in the engine (it sent nothing, so 'chain' stayed).
  const { win, doc, engine } = ctx;
  const before = live(engine, 'bass');
  if (before.sequencerAdvance !== 'chain' || before.sequencers.length < 2) {
    throw new Error(`precondition: bass should be a chained multi-bar line, got ${before.sequencers.length} bars, ${before.sequencerAdvance}`);
  }
  setSelect(win, doc, 'compose-words-track', 'bass');
  doc.getElementById('compose-words-text').value = 'hello there';
  clickEl(win, doc.getElementById('compose-words-write'));
  await waitUntil(() => live(engine, 'bass').sequencers.length === 1, 3000);
  await sleep(200);
  const t = live(engine, 'bass');
  const page = await stored(win, 'bass');
  record('a one-bar Words write clears the chain', t.sequencers.length === 1 && t.sequencerAdvance !== 'chain'
    && page.sequencerAdvance === undefined,
    `${t.sequencers.length} sequencers, engine ${t.sequencerAdvance}, page ${page.sequencerAdvance}`);
}

async function checkStrip(ctx) {
  // #4: Strip notes cleared a user kit (it was not 'percussion'); Strip
  // rhythms left it alone for the same reason.
  const { win, doc, engine } = ctx;
  const kitOn = () => {
    const t = live(engine, 'hand-kit');
    return t ? t.sequencers.flatMap((seq) => Object.values(seq.steps).flatMap((l) => onSlots(l))).length : -1;
  };
  record('the seeded user kit is live', kitOn() > 0, `hand-kit on-steps ${kitOn()}`);
  clickEl(win, doc.getElementById('zero-notes'));
  await sleep(300);
  record('Strip notes leaves a user kit alone', kitOn() > 0, `hand-kit on-steps ${kitOn()}`);
  // Give the kit a beat of its own first, so Strip rhythms is judged on hits
  // it must clear rather than on whatever Strip notes may have left.
  setSelect(win, doc, 'compose-beat-track', 'hand-kit');
  doc.getElementById('compose-beat-text').value = 'K . S . K . S .';
  clickEl(win, doc.getElementById('compose-beat-write'));
  await sleep(200);
  record('typed Beat lands on the user kit', kitOn() > 0, `hand-kit on-steps ${kitOn()}`);
  clickEl(win, doc.getElementById('zero-rhythms'));
  await sleep(300);
  record('Strip rhythms clears a user kit', kitOn() === 0, `hand-kit on-steps ${kitOn()}`);
}

async function checkRemoveLaneFocus(ctx) {
  // #7: removing a lane redrew the grid under the pressed × and focus fell
  // to the page.
  const { win, doc } = ctx;
  const ed = await openEditor(win, doc, 'percussion');
  const manual = doc.querySelector('label[for="seq-mode-percussion-manual"]');
  const radio = doc.getElementById('seq-mode-percussion-manual');
  if (radio && !radio.checked && manual) clickEl(win, manual);
  await sleep(100);
  clickEl(win, ed.querySelector('.seq-lane-add'));
  await sleep(100);
  const removes = [...ed.querySelectorAll('.seq-lane-remove')];
  if (!removes.length) throw new Error('no removable lane after Add lane');
  const pressed = removes[removes.length - 1];
  pressed.focus();
  clickEl(win, pressed);
  await sleep(100);
  const active = doc.activeElement;
  record('removing a lane keeps focus in the lane tools',
    Boolean(active && active !== doc.body && active.isConnected
      && (active.classList.contains('seq-lane-remove') || active.classList.contains('seq-lane-add'))),
    `focus on ${active ? `${active.tagName}.${active.className}` : 'nothing'}`);
}

async function checkWordsMetre(ctx) {
  // #5: words that change the metre redrew only the target's grid, and the
  // Custom… metre row stayed open under a named metre.
  const { win, doc } = ctx;
  // The bass grid is the one open; the words land on the MELODY, whose
  // editor is closed — the old code redrew only the target's.
  const bassEd = await openEditor(win, doc, 'bass');
  setSelect(win, doc, 'timeSignature', 'custom');
  await sleep(100);
  const row = doc.getElementById('custom-metre');
  if (!row || row.hidden) throw new Error('the Custom… metre row did not open');
  setSelect(win, doc, 'compose-words-track', 'melody');
  doc.getElementById('compose-words-text').value = 'merrily merrily over the water and under the trees';
  clickEl(win, doc.getElementById('compose-words-write'));
  await waitUntil(() => ctx.engine.getParams().timeSignature === '6/8', 3000);
  await sleep(200);
  const sig = ctx.engine.getParams().timeSignature;
  record('the words set 6/8', sig === '6/8', `metre ${sig}`);
  record('the Custom… row closes under a named metre', row.hidden === true, 'still showing');
  const want = engineModule.stepsPerBarAt('6/8', FINE);
  record('the open grid of another track redraws at the new bar length', !bassEd.hidden && cellsPerRow(bassEd) === want,
    `bass grid ${cellsPerRow(bassEd)} cells, wanted ${want}`);
}

// ===========================================================================
// Run
// ===========================================================================

const ctx = await bootScenario(6, seedDevice);
try {
  await checkBlock('[1] LOAD', () => checkLoad(ctx));
  await checkBlock('[1] + TAB', () => checkPlusTab(ctx));
  await checkBlock('[9] RESOLUTION NAMES', () => checkResolutionNames(ctx));
  await checkBlock('[8] GROUPS PAST THE BAR', () => checkGroups(ctx));
  await checkBlock('[3][6] TYPED BEAT', () => checkBeat(ctx));
  await checkBlock('[6] TYPED MELODY', () => checkMelodyChain(ctx));
  await checkBlock('[3] TUNE', () => checkTune(ctx));
  await checkBlock('[3] WORDS', () => checkWords(ctx));
  await checkBlock('[6] WORDS ONE BAR', () => checkWordsOneBar(ctx));
  await checkBlock('[4] STRIP A LAYER', () => checkStrip(ctx));
  await checkBlock('[7] REMOVE LANE FOCUS', () => checkRemoveLaneFocus(ctx));
  await checkBlock('[5] WORDS METRE', () => checkWordsMetre(ctx));
} finally {
  ctx.win.close();
}

console.log(`\n${passed.length}/${passed.length + failures.length} checks green`);
for (const name of passed) console.log(`  ok   ${name}`);
if (failures.length) {
  console.log('\ngrid-lanes-page FAILED');
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
console.log('grid-lanes-page ok');
process.exit(0);
