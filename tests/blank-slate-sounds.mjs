/**
 * tests/blank-slate-sounds.mjs
 * Run with: npm run build && node tests/blank-slate-sounds.mjs
 * (or as part of `node tests/all.mjs`, which discovers this file by name).
 *
 * A brand-new instrument (Create -> Blank slate) is meant to be playable two
 * ways — tap its step grid, or type notes onto it — and to sound like
 * something once it plays. This suite drives the BUILT page (dist/index.html)
 * in jsdom, the way tests/page-boot.mjs does, but with a fast-clock fake
 * AudioContext (modelled on the /tmp scratchpad `bass-walk.mjs` harness that
 * first surfaced these gaps): real DOM events go in, and every
 * engine.setParams() payload, every engine 'note' event and every oscillator
 * start() comes back out for inspection.
 *
 * It is written RED FIRST: several of the checks below are known to fail on
 * the code as it stands today (see the per-check comments). That is the
 * point — they document real gaps rather than assert what already works.
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
  console.error('blank-slate-sounds: dist/index.html is missing — run `npm run build` first.');
  process.exit(1);
}

const html = readFileSync(indexHtml, 'utf8');
const scriptMatch = /<script[^>]*type="module"[^>]*src="([^"]+)"/.exec(html);
if (!scriptMatch) {
  console.error('blank-slate-sounds: no module script found in dist/index.html');
  process.exit(1);
}
const bundlePath = join(distDir, scriptMatch[1].replace(/^\//, ''));
if (!existsSync(bundlePath)) {
  console.error(`blank-slate-sounds: built page script missing: ${bundlePath}`);
  process.exit(1);
}

// Read from SOURCE for the engine's own numbers (bar length, track labels) —
// the same discipline tests/page-boot.mjs uses, so this suite is measured
// against the engine's own contract rather than a number written into the
// test by hand.
const engineModule = await import(
  pathToFileURL(join(repoRoot, 'src/scripts/ambient-engine.js')).href
);
const REGISTRY = typeof engineModule.getTracks === 'function' ? engineModule.getTracks() : [];
const labelOf = (id) => (REGISTRY.find((t) => t.id === id) || {}).label || id;

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
// Boot harness — tests/page-boot.mjs's stubs, plus:
//   * a fast-clock AudioContext (SPEED×), so a "wait one bar" check doesn't
//     take a real bar's length of wall-clock time;
//   * a connect() that actually records graph edges. page-boot's stub nodes
//     don't (connect() is a no-op there) — but check 6 below needs to walk
//     from a started oscillator to the gain node it feeds, so this harness's
//     node() factory keeps a real, if minimal, edge list.
// Each call boots a FRESH jsdom + fresh AudioContext, and re-imports the
// built bundle with a cache-busting query string — the same trick
// tests/page-boot.mjs uses for its own second boot. Node's ESM loader caches
// by exact specifier, so importing the identical dist/ URL twice would hand
// back the ALREADY-INITIALISED module rather than booting a fresh page into
// the fresh document.
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

  // No consent cookie: tests/page-boot.mjs's PRIMARY boot does not set one
  // either (it only grants consent for a later, separate reload scenario) —
  // this is every first-time visitor's state, which is exactly Blank
  // slate's audience.
  await import(`${pathToFileURL(bundlePath).href}?blank-slate-sounds-${scenarioCounter}`);
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

async function openCreateAndBlank(win, doc) {
  clickEl(win, doc.getElementById('play-along-open'));
  await sleep(50);
  clickEl(win, doc.getElementById('create-blank'));
  await sleep(50);
}

function closeCreate(win, doc) {
  clickEl(win, doc.getElementById('play-along-open'));
}

/**
 * Tap grid steps with REAL pointer events — the same pointerdown/pointerup
 * pair tests/kit-softness-drive.mjs and tests/tie-merge-drive.mjs send
 * against a live browser, and the actual mechanism wireCell() listens for
 * (.seq-cell has no 'click' listener at all — only pointerdown/up and
 * keydown). A tap with no pointermove between down and up is a plain toggle:
 * `s.on = !s.on`, then commitSequencer().
 */
async function tapGridSteps(win, doc, track, indices) {
  clickEl(win, doc.getElementById(`voice-edit-toggle-${track}`));
  await waitUntil(() => {
    const ed = doc.getElementById(`voice-editor-${track}`);
    return Boolean(ed && !ed.hidden && ed.querySelectorAll('.seq-cell').length);
  });
  const editor = doc.getElementById(`voice-editor-${track}`);
  const cells = [...editor.querySelectorAll('.seq-cell')];
  for (const i of indices) {
    const cell = cells[i];
    if (!cell) continue;
    cell.dispatchEvent(new win.PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0, clientX: 10, clientY: 10,
    }));
    cell.dispatchEvent(new win.PointerEvent('pointerup', {
      bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0, clientX: 10, clientY: 10,
    }));
    await sleep(5);
  }
  return editor;
}

function setLamp(win, doc, track, times) {
  const lamp = doc.getElementById(`track-lamp-${track}`);
  for (let i = 0; i < times; i++) clickEl(win, lamp);
}

async function clickPlay(win, doc) {
  clickEl(win, doc.getElementById('toggle-play'));
  await sleep(300);
}

function writeTyped(win, doc, track, text) {
  const picker = doc.getElementById('compose-melody-track');
  picker.value = track;
  picker.dispatchEvent(new win.Event('change', { bubbles: true }));
  const textEl = doc.getElementById('compose-melody-text');
  textEl.value = text;
  textEl.dispatchEvent(new win.Event('input', { bubbles: true }));
  clickEl(win, doc.getElementById('compose-melody-write'));
}

function barSecondsOf(engine) {
  const p = engine.getParams();
  return engineModule.beatsPerBar(p.timeSignature) * 60 / (p.bpm * (p.speed || 1));
}

/** Collapse a written step lane into the ordered, de-duplicated onset pitches. */
function onsetPitches(steps) {
  const out = [];
  let prevMidi = null;
  for (const step of steps || []) {
    if (step && step.on && Number.isFinite(step.midi)) {
      if (step.midi !== prevMidi) out.push(step.midi);
      prevMidi = step.midi;
    } else {
      prevMidi = null;
    }
  }
  return out;
}

/** Walk downstream from a started oscillator to the nearest gain node it feeds. */
function findFeedingGain(oscNode) {
  const seen = new Set();
  const queue = [...(oscNode.__out || [])];
  while (queue.length) {
    const n = queue.shift();
    if (!n || seen.has(n)) continue;
    seen.add(n);
    if (n.__gain) return n;
    if (n.__out) queue.push(...n.__out);
    if (seen.size > 40) break;
  }
  return null;
}

async function waitForNote(notes, track, timeoutMs) {
  const found = await waitUntil(() => notes.some((n) => n.track === track), timeoutMs, 30);
  return found ? notes.find((n) => n.track === track) : null;
}

// ===========================================================================
// Checks 1 & 2 — GRID PATH (bass, melody)
// ===========================================================================

async function checkGridPath(track, num) {
  const { win, doc, engine, payloads, notes, Ctx } = await bootScenario();
  try {
    await openCreateAndBlank(win, doc);
    closeCreate(win, doc);

    const beforeTapCount = payloads.length;
    await tapGridSteps(win, doc, track, [0, 4, 8, 12]);
    const tapPayloads = payloads.slice(beforeTapCount);

    const anyTurnedOn = tapPayloads.some((p) => p.tracks && p.tracks[track] && p.tracks[track].state === 'on');
    record(
      `[${num}a] GRID ${track}: tapping the step grid also switches the track state to 'on'`,
      anyTurnedOn,
      `none of the ${tapPayloads.length} setParams payload(s) from tapping steps 0/4/8/12 carried ` +
        `tracks.${track}.state — commitSequencer() only ever sends sequencers/sequencer` +
        `${track === 'percussion' ? '/lanes' : ''}, never state, so a freshly-tapped track stays 'off' ` +
        `until something else turns it on`
    );

    const stateAfterTap = engine.getParams().tracks[track].state;
    record(
      `[${num}b] GRID ${track}: engine.getParams().tracks.${track}.state is not 'off' after tapping`,
      stateAfterTap !== 'off',
      `engine reports tracks.${track}.state = '${stateAfterTap}' after the taps (Blank slate leaves every ` +
        `track 'off', and tapping the grid never changes state — see [${num}a])`
    );

    await clickPlay(win, doc);
    const playEngineTime = Ctx.last.currentTime;
    const barSeconds = barSecondsOf(engine);
    // Real-time budget: enough simulated engine-clock headroom to cover a bit
    // over one bar, converted back to wall-clock via the fast clock's speed.
    const waitMs = Math.min(6000, (barSeconds * 1.5 / 6) * 1000 + 1000);
    const hit = await waitUntil(
      () => notes.some((n) => n.track === track && n.time >= playEngineTime && n.time <= playEngineTime + barSeconds),
      waitMs,
      30
    );
    const trackNotes = notes.filter((n) => n.track === track);
    record(
      `[${num}c] GRID ${track}: at least one ${track} note is scheduled within one bar of Play`,
      hit,
      `Play landed at engine time ${playEngineTime.toFixed(2)}s, one bar is ${barSeconds.toFixed(2)}s ` +
        `(bpm ${engine.getParams().bpm}, ${engine.getParams().timeSignature}); ` +
        (trackNotes.length
          ? `saw ${trackNotes.length} ${track} note(s), first at ${trackNotes[0].time.toFixed(2)}s`
          : `no ${track} note event fired at all — consistent with tracks.${track}.state staying 'off' (see [${num}b])`)
    );
  } finally {
    win.close();
  }
}

// ===========================================================================
// Checks 3 & 4 — TYPED PATH (bass, melody)
// ===========================================================================

async function checkTypedPath(track, text, expectedMidi, num) {
  const { win, doc, engine, notes, Ctx } = await bootScenario();
  try {
    await openCreateAndBlank(win, doc);

    // The engine time BEFORE Write it: the first note may be scheduled in the
    // same tick the transport starts, before this test gets to look again.
    const writeEngineTime = Ctx.last ? Ctx.last.currentTime : 0;
    writeTyped(win, doc, track, text);
    await sleep(50);

    const running = Boolean(engine.running);
    record(
      `[${num}a] TYPED ${track}: the transport is running without pressing Play`,
      running,
      `engine.running is ${running} after writing "${text}" onto ${track} via #compose-melody-write — ` +
        `writeTypedMelody() only calls engine.setParams(), never engine.start()/the Play button, so the ` +
        `transport never begins on its own`
    );

    // Give the (fast) clock every chance it will ever get. If the transport
    // never started, no note will ever arrive here no matter how long this
    // waits — waitForNote's timeout is generous but bounded.
    const barSeconds = barSecondsOf(engine);
    const firstNote = await waitForNote(notes, track, 2500);
    const withinBar = Boolean(
      running && firstNote && firstNote.time >= writeEngineTime - 0.01 && firstNote.time <= writeEngineTime + barSeconds
    );
    record(
      `[${num}b] TYPED ${track}: the first ${track} note is scheduled within one bar of the transport starting`,
      withinBar,
      running
        ? (firstNote
          ? `transport started at ${writeEngineTime.toFixed(2)}s (bar = ${barSeconds.toFixed(2)}s), ` +
            `first ${track} note at ${firstNote.time.toFixed(2)}s`
          : `transport reports running, but no ${track} note event ever fired`)
        : `the transport never started (see [${num}a]), so there is no start time to measure "within one bar" ` +
          `against, and indeed no ${track} note event fired`
    );

    // The pitches ARE scheduled the moment Write it runs — into the track's
    // own sequencer steps — independent of whether the transport is running.
    // This is checked structurally (the written grid), which is the only
    // honest way to answer "what did Write it schedule" while [${num}a]
    // stays red; it is not weaker than a playback check, it is the same
    // question asked before the note ever has a chance to sound.
    const p = engine.getParams().tracks[track];
    const steps = (p.sequencer && p.sequencer.steps) || (p.sequencers && p.sequencers[0] && p.sequencers[0].steps) || [];
    const pitches = onsetPitches(steps);
    const pitchesMatch = expectedMidi.length === pitches.length && expectedMidi.every((m, i) => m === pitches[i]);
    record(
      `[${num}c] TYPED ${track}: the written pitches are MIDI [${expectedMidi.join(', ')}] in order`,
      pitchesMatch,
      `engine.getParams().tracks.${track}.sequencer.steps decode to onset pitches [${pitches.join(', ')}] ` +
        `for typed "${text}", expected [${expectedMidi.join(', ')}]`
    );
  } finally {
    win.close();
  }
}

// ===========================================================================
// Check 5 — LABEL and description honesty on the compose-onto-track picker
// ===========================================================================

async function checkComposeLabel() {
  const { win, doc } = await bootScenario();
  try {
    await openCreateAndBlank(win, doc);

    const picker = doc.getElementById('compose-melody-track');
    const label = doc.querySelector('label[for="compose-melody-track"]');
    const labelHidden = Boolean(label && label.classList.contains('visually-hidden'));
    const labelText = label ? label.textContent.trim() : '';
    record(
      '[5a] #compose-melody-track has a visible (non-visually-hidden), non-empty label',
      Boolean(label) && !labelHidden && labelText.length > 0,
      label
        ? `the <label for="compose-melody-track"> is "${labelText}" but carries class="visually-hidden" ` +
          `(class list: ${[...label.classList].join(' ') || '(none)'}), so it is invisible on screen — ` +
          `only screen readers get told what the picker is for`
        : 'no <label for="compose-melody-track"> element exists at all'
    );

    picker.value = 'bass';
    picker.dispatchEvent(new win.Event('change', { bubbles: true }));
    const writeButton = doc.getElementById('compose-melody-write');
    const descId = writeButton.getAttribute('aria-describedby');
    const descEl = descId ? doc.getElementById(descId) : null;
    const descText = descEl ? descEl.textContent : '';
    const saysMelodyGrid = /melody grid/i.test(descText);
    const namesBass = /\bbass\b/i.test(descText);
    record(
      '[5b] "Write it" description names bass (not "melody grid") once bass is the selected target',
      namesBass && !saysMelodyGrid,
      `with #compose-melody-track set to "bass", #compose-melody-write's aria-describedby text is: ` +
        `"${descText}" — describe() writes this text ONCE at boot and never updates it on a 'change' ` +
        `of the picker, so it always says "onto the melody grid" no matter which track is selected`
    );
  } finally {
    win.close();
  }
}

// ===========================================================================
// Check 6 — BLANK BASS AUDIBLE
// ===========================================================================

async function checkBlankBassAudible() {
  const { win, doc, engine, notes, oscLog, Ctx } = await bootScenario();
  try {
    await openCreateAndBlank(win, doc);
    closeCreate(win, doc);
    await tapGridSteps(win, doc, 'bass', [0, 4, 8, 12]);
    // Force the state on directly (this check is about the SOUND, not the
    // [1a]/[1b] state-activation bug) — off -> auto -> on.
    setLamp(win, doc, 'bass', 2);
    await waitUntil(() => engine.getParams().tracks.bass.state === 'on', 1000);

    await clickPlay(win, doc);
    const note = await waitForNote(notes, 'bass', 4000);
    if (!note) {
      record(
        '[6] BLANK BASS AUDIBLE: at least one bass note plays after Blank slate',
        false,
        'no bass note event fired at all within 4s of Play, even with tracks.bass.state forced to \'on\' ' +
          'and steps 0/4/8/12 tapped — cannot inspect its oscillators because it never played'
      );
      return;
    }

    const window_ = 0.25; // engine-seconds either side of the note's own time
    const near = oscLog.filter((o) => !o.buffer && Math.abs(o.t - note.time) < window_);
    const details = near.map((o) => {
      const g = findFeedingGain(o.node);
      const gainValue = g ? g.gain.value : null;
      return {
        type: o.type,
        freq: Number(o.freq.toFixed(2)),
        gain: gainValue === null ? null : Number(gainValue.toFixed(4)),
      };
    });

    const NONTRIVIAL_GAIN = 0.02;
    const nonSineNonTrivial = details.some((d) => d.type !== 'sine' && d.gain !== null && d.gain > NONTRIVIAL_GAIN);
    const distinctFreqs = new Set(details.filter((d) => d.gain === null || d.gain > NONTRIVIAL_GAIN).map((d) => Math.round(d.freq)));
    const twoFreqs = distinctFreqs.size >= 2;
    const pass = nonSineNonTrivial || twoFreqs;

    const describeOsc = (d) => `${d.type}@${d.freq}Hz(gain ${d.gain === null ? 'unknown' : d.gain})`;
    record(
      '[6] BLANK BASS AUDIBLE: the first bass note is not a single pure-sine oscillator with no colour',
      pass,
      details.length
        ? `oscillators started for bass note @midi ${note.midi}, t=${note.time.toFixed(2)}s: ` +
          `${details.map(describeOsc).join(', ')}`
        : `no oscillator start() was recorded within ${window_}s of the bass note at t=${note.time.toFixed(2)}s`
    );
  } finally {
    win.close();
  }
}

// ===========================================================================
// Check 7 — STAGED COUNTDOWN
// ===========================================================================

async function checkStagedCountdown() {
  const { win, doc, engine, Ctx } = await bootScenario();
  try {
    await openCreateAndBlank(win, doc);

    // Stage the melody: off -> on, via its own state control (the lamp). Its
    // grid is empty and not hand-written, so ruling 7 holds it back two bars
    // (the pad enters at bar 0, so it can never be the one waiting).
    setLamp(win, doc, 'melody', 2);
    await waitUntil(() => engine.getParams().tracks.melody.state === 'on', 1000);

    // A manual, hand-written track coexists (case 3's typed bass line), so
    // the countdown — if it ever appears — has something to be WRONG about.
    writeTyped(win, doc, 'bass', 'C2 - G2 A2');
    await sleep(50);

    // Write it starts the transport (v0.0.194); pressing Play now would be
    // pressing Finish. Only press it if nothing is running.
    if (!engine.running) await clickPlay(win, doc);
    const barSeconds = barSecondsOf(engine);
    const statusEl = doc.getElementById('transport-status');
    const bassLabel = labelOf('bass');
    const padLabel = labelOf('melody');

    let firstBarText = '';
    let sawDuringFirstBar = false;
    const pollStarted = Date.now();
    while (Ctx.last.currentTime < barSeconds && Date.now() - pollStarted < 6000) {
      const text = (statusEl.textContent || '');
      if (/enters in/i.test(text)) {
        sawDuringFirstBar = true;
        firstBarText = text;
        break;
      }
      await sleep(30);
    }
    record(
      `[7a] STAGED COUNTDOWN: #transport-status says "enters in" while the staged ${padLabel} track waits (bar 1)`,
      sawDuringFirstBar && new RegExp(padLabel, 'i').test(firstBarText),
      `after Play, with ${padLabel} staged (state 'on', empty grid), #transport-status never named it with "enters in" ` +
        `during bar 1 (engine time 0–${barSeconds.toFixed(2)}s) — its text stayed "${(statusEl.textContent || '').trim()}"; ` +
        `#transport-status is currently wired only to the sleep/alarm timers`
    );

    while (Ctx.last.currentTime < barSeconds * 3.2 && Date.now() - pollStarted < 14000) await sleep(30);
    const laterText = (statusEl.textContent || '').trim();
    record(
      '[7b] STAGED COUNTDOWN: the countdown stops being named once the staged bar has passed',
      !/enters in/i.test(laterText),
      `#transport-status still reads "enters in" after the staged bar has passed: "${laterText}"`
    );

    const namesTheHandWrittenTrack = new RegExp(bassLabel, 'i').test(firstBarText) && /enters in/i.test(firstBarText);
    record(
      `[7c] STAGED COUNTDOWN: the countdown (if any) names ${padLabel}, never the hand-written ${bassLabel}`,
      !namesTheHandWrittenTrack,
      `the "enters in" text named the manually-written ${bassLabel} track instead of the staged ${padLabel} ` +
        `track: "${firstBarText}"`
    );
  } finally {
    win.close();
  }
}

// ===========================================================================
// Run everything
// ===========================================================================

await checkBlock('[1] GRID PATH bass', () => checkGridPath('bass', 1));
await checkBlock('[2] GRID PATH melody', () => checkGridPath('melody', 2));
await checkBlock('[3] TYPED PATH bass', () => checkTypedPath('bass', 'C2 - G2 A2', [36, 43, 45], 3));
await checkBlock('[4] TYPED PATH melody', () => checkTypedPath('melody', 'C4 E4 G4', [60, 64, 67], 4));
await checkBlock('[5] LABEL', () => checkComposeLabel());
await checkBlock('[6] BLANK BASS AUDIBLE', () => checkBlankBassAudible());
await checkBlock('[7] STAGED COUNTDOWN', () => checkStagedCountdown());

console.log(`\n${passed.length}/${passed.length + failures.length} checks green`);
for (const name of passed) console.log(`  ok   ${name}`);
if (failures.length) {
  console.log('\nblank-slate-sounds FAILED');
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
console.log('blank-slate-sounds ok');
process.exit(0);
