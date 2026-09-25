/**
 * Boot gate for src/pages/index.astro — run with:
 *   npm run build && node tests/page-boot.mjs
 *
 * The page has shipped blank twice (a TDZ crash inside init(), 6105e0d/bb29670);
 * neither the module smoke tests nor `astro build` catch that, because the page
 * script is only ever executed by a browser. This harness executes the BUILT
 * bundle — the exact file the site serves — inside jsdom with stubbed audio,
 * and asserts the app actually unhides.
 *
 * It is a boot gate, not a feature test: it proves init() runs to completion
 * against whatever the sibling modules currently export (engine, voices, knob,
 * scope, visualiser, power, prefs). Anything the page feature-detects must
 * therefore degrade cleanly here rather than throw.
 *
 * It also holds the page's PLACEMENT gates — where a module ends up in the
 * document is markup the build can produce but neither `astro build` nor a
 * module smoke test ever looks at (v16: factory presets below the Simple
 * dials; v18: the oscilloscope above the tabs, with no title of its own).
 */

import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';
import { readTutorialSteps, resolveTutorialTargets, readLessonChapters } from './tutorial-smoke.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(repoRoot, 'dist');
const indexHtml = join(distDir, 'index.html');
const BOOT_TIMEOUT_MS = 8000;

if (!existsSync(indexHtml)) {
  console.error('page-boot: dist/index.html is missing — run `npm run build` first.');
  process.exit(1);
}

const html = readFileSync(indexHtml, 'utf8');
const scriptMatch = /<script[^>]*type="module"[^>]*src="([^"]+)"/.exec(html);
assert.ok(scriptMatch, 'no module script found in dist/index.html');
const bundlePath = join(distDir, scriptMatch[1].replace(/^\//, ''));
assert.ok(existsSync(bundlePath), `built page script missing: ${bundlePath}`);

// --------------------------------------------------------------------------
// Stubs — everything the page touches that jsdom has no implementation for.
// Each one is deliberately dumb: the gate is "does init() survive", not "does
// the audio graph do the right thing" (that is engine-smoke.mjs's job).
// --------------------------------------------------------------------------

/**
 * A 2d context whose every method is a no-op — jsdom ships none at all.
 * lineTo/moveTo additionally record a per-strokeStyle point count (`ctx.
 * pointsByColor`) so the offline-waveform-rule tests can tell "drew a real
 * trace" from "drew only the fixed graticule" without a live browser —
 * scope.js's grid lines and traces are told apart purely by which colour
 * was active when moveTo/lineTo ran.
 */
function stubCanvasContext() {
  const noop = () => {};
  const ctx = {
    canvas: null,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    shadowBlur: 0,
    shadowColor: '',
    lineJoin: 'miter',
    lineCap: 'butt',
    pointsByColor: {},
    save: noop,
    restore: noop,
    scale: noop,
    translate: noop,
    rotate: noop,
    setTransform: noop,
    clearRect: noop,
    fillRect: noop,
    strokeRect: noop,
    beginPath: noop,
    closePath: noop,
    moveTo(x, y) {
      (ctx.pointsByColor[ctx.strokeStyle] ||= []).push(y);
    },
    lineTo(x, y) {
      (ctx.pointsByColor[ctx.strokeStyle] ||= []).push(y);
    },
    arc: noop,
    rect: noop,
    quadraticCurveTo: noop,
    bezierCurveTo: noop,
    fill: noop,
    stroke: noop,
    clip: noop,
    setLineDash: noop,
    fillText: noop,
    strokeText: noop,
    measureText: () => ({ width: 0 }),
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    createPattern: () => null,
    drawImage: noop,
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    putImageData: noop,
  };
  return ctx;
}

function stubAudioParam(value = 0) {
  const param = {
    value,
    defaultValue: value,
    setValueAtTime: () => param,
    linearRampToValueAtTime: () => param,
    exponentialRampToValueAtTime: () => param,
    setTargetAtTime: () => param,
    setValueCurveAtTime: () => param,
    cancelScheduledValues: () => param,
    cancelAndHoldAtTime: () => param,
  };
  return param;
}

function stubAudioNode(extra = {}) {
  const node = {
    connect: () => node,
    disconnect: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    ...extra,
  };
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
  createGain() {
    return stubAudioNode({ gain: stubAudioParam(1) });
  }
  createOscillator() {
    return stubAudioNode({
      frequency: stubAudioParam(440),
      detune: stubAudioParam(0),
      type: 'sine',
      start: () => {},
      stop: () => {},
      setPeriodicWave: () => {},
    });
  }
  createBufferSource() {
    return stubAudioNode({
      buffer: null,
      playbackRate: stubAudioParam(1),
      detune: stubAudioParam(0),
      loop: false,
      start: () => {},
      stop: () => {},
    });
  }
  createBiquadFilter() {
    return stubAudioNode({
      type: 'lowpass',
      frequency: stubAudioParam(350),
      Q: stubAudioParam(1),
      gain: stubAudioParam(0),
      detune: stubAudioParam(0),
    });
  }
  createStereoPanner() {
    return stubAudioNode({ pan: stubAudioParam(0) });
  }
  createPanner() {
    return stubAudioNode({ positionX: stubAudioParam(0) });
  }
  createDelay() {
    return stubAudioNode({ delayTime: stubAudioParam(0) });
  }
  createConvolver() {
    return stubAudioNode({ buffer: null, normalize: true });
  }
  createDynamicsCompressor() {
    return stubAudioNode({
      threshold: stubAudioParam(-24),
      knee: stubAudioParam(30),
      ratio: stubAudioParam(12),
      attack: stubAudioParam(0.003),
      release: stubAudioParam(0.25),
      reduction: 0,
    });
  }
  createWaveShaper() {
    return stubAudioNode({ curve: null, oversample: 'none' });
  }
  createAnalyser() {
    return stubAudioNode({
      fftSize: 2048,
      frequencyBinCount: 1024,
      smoothingTimeConstant: 0.8,
      minDecibels: -100,
      maxDecibels: -30,
      getByteTimeDomainData: (a) => a.fill(128),
      getFloatTimeDomainData: (a) => a.fill(0),
      getByteFrequencyData: (a) => a.fill(0),
      getFloatFrequencyData: (a) => a.fill(-100),
    });
  }
  createMediaStreamDestination() {
    return stubAudioNode({ stream: { getTracks: () => [] } });
  }
  createBuffer(channels, length, sampleRate) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return {
      numberOfChannels: channels,
      length,
      sampleRate,
      duration: length / sampleRate,
      getChannelData: (i) => data[i],
    };
  }
  createPeriodicWave() {
    return {};
  }
  resume() {
    this.state = 'running';
    return Promise.resolve();
  }
  suspend() {
    this.state = 'suspended';
    return Promise.resolve();
  }
  close() {
    this.state = 'closed';
    return Promise.resolve();
  }
  addEventListener() {}
  removeEventListener() {}
}

// --------------------------------------------------------------------------
// Environment
// --------------------------------------------------------------------------

const dom = new JSDOM(html, {
  url: 'https://ambi4.work/',
  pretendToBeVisual: true,
  runScripts: 'outside-only',
});

const { window } = dom;

// One stub ctx per canvas (not a fresh object per call): scope.js calls
// canvas.getContext('2d') anew on every render, and the offline-waveform
// tests below need to inspect what got drawn AFTER the fact — a fresh
// object per call would lose that history.
const canvasContexts = new WeakMap();
window.HTMLCanvasElement.prototype.getContext = function getContext() {
  let ctx = canvasContexts.get(this);
  if (!ctx) {
    ctx = stubCanvasContext();
    ctx.canvas = this;
    canvasContexts.set(this, ctx);
  }
  return ctx;
};
window.HTMLCanvasElement.prototype.toDataURL = () => 'data:,';
window.AudioContext = StubAudioContext;
window.OfflineAudioContext = undefined;

// v28 Web MIDI: jsdom has none, and the page feature-detects it — so its
// absence is a supported state that every OTHER run of this harness proves.
// This mock is here for the present-and-working path, which nothing else could
// reach: an instrument that plays into the same noteOn/noteOff seam the
// computer keyboard uses.
const midiMock = {
  requested: 0,
  options: null,
  input: { name: 'Stub keyboard', onmidimessage: null },
  access: null,
};
midiMock.access = {
  inputs: new Map([['stub-1', midiMock.input]]),
  outputs: new Map(),
  onstatechange: null,
};
try {
  window.navigator.requestMIDIAccess = (options) => {
    midiMock.requested += 1;
    midiMock.options = options || null;
    return Promise.resolve(midiMock.access);
  };
} catch {
  Object.defineProperty(window.navigator, 'requestMIDIAccess', {
    configurable: true,
    value: (options) => {
      midiMock.requested += 1;
      midiMock.options = options || null;
      return Promise.resolve(midiMock.access);
    },
  });
}
window.devicePixelRatio = 1;

// v29 share names: jsdom ships no Clipboard API, and the page's Share button
// is the only way to see the name a link gets. The stub records what was
// copied, which is also how the gate below gets hold of the fragment.
const clipboard = { text: '' };
installClipboard(window);

/**
 * v0.0.186: the link on the clipboard, decoded — the payload and its schema
 * stamp (`v`), read the way the page's own decoder reads them. Null when no
 * link was copied or it does not decode.
 */
function decodeCopiedLink() {
  const at = clipboard.text.indexOf('#p=');
  if (at < 0) return null;
  const value = clipboard.text.slice(at + 3);
  try {
    return JSON.parse(Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function installClipboard(win) {
  const stub = {
    writeText: (text) => {
      clipboard.text = String(text);
      return Promise.resolve();
    },
  };
  try {
    win.navigator.clipboard = stub;
    if (win.navigator.clipboard !== stub) throw new Error('read-only');
  } catch {
    Object.defineProperty(win.navigator, 'clipboard', { configurable: true, value: stub });
  }
}

// Copy the DOM globals the bundle expects onto this realm. The bundle is a
// plain ES module: Node executes it, so `document`/`window` have to be here.
const passthrough = [
  'window', 'document', 'navigator', 'location', 'history', 'localStorage',
  'sessionStorage', 'getComputedStyle', 'matchMedia', 'requestAnimationFrame',
  'cancelAnimationFrame', 'HTMLElement', 'HTMLCanvasElement', 'Element', 'Node',
  'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'PointerEvent',
  'CSS', 'DOMParser', 'Image', 'Blob', 'URL', 'AudioContext',
];
for (const key of passthrough) {
  // Node 21+ ships getter-only globals (navigator); plain assignment throws.
  if (window[key] !== undefined) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: window[key] });
  }
}
globalThis.self = window;

const consoleErrors = [];
const realConsoleError = console.error;
console.error = (...args) => {
  consoleErrors.push(args.map(String).join(' '));
  realConsoleError(...args);
};

// --------------------------------------------------------------------------
// The engine's own track registry (v21)
// --------------------------------------------------------------------------
// Read from SOURCE, not from dist: this is the contract the built page is
// measured against. The page must build its rows, editors and lanes from
// getTracks() — count, order and labels — rather than from six ids of its own.

const engineModule = await import(
  pathToFileURL(join(repoRoot, 'src/scripts/ambient-engine.js')).href
);
const REGISTRY_TRACKS = typeof engineModule.getTracks === 'function' ? engineModule.getTracks() : [];
const REGISTRY_IDS = REGISTRY_TRACKS.map((track) => track.id);

// --------------------------------------------------------------------------
// Share names (v29)
// --------------------------------------------------------------------------
// The name a link shows is recomputed HERE, from source, over the fragment the
// page actually produced — the gate is that the two agree. tests/
// share-name-smoke.mjs proves the arithmetic itself; this proves the page is
// wired to it, at both ends of a link.

const shareNameModule = await import(
  pathToFileURL(join(repoRoot, 'src/scripts/share-name.js')).href
);
const SHARE_POOL = shareNameModule.wordPoolFrom(
  JSON.parse(readFileSync(join(repoRoot, 'src/data/wordlist.json'), 'utf8'))
);

// --------------------------------------------------------------------------
// Boot
// --------------------------------------------------------------------------

const failures = [];
let bootMs = 0;

try {
  await import(pathToFileURL(bundlePath).href);

  const started = Date.now();
  const app = window.document.getElementById('generator-app');
  assert.ok(app, '#generator-app is missing from the built page');
  while (app.hidden && Date.now() - started < BOOT_TIMEOUT_MS) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  bootMs = Date.now() - started;

  const unavailable = window.document.getElementById('generator-unavailable');
  if (app.hidden) {
    failures.push(
      `#generator-app never unhid within ${BOOT_TIMEOUT_MS} ms` +
        (unavailable && !unavailable.hidden ? ` — fallback says: ${unavailable.textContent.trim()}` : '')
    );
  }
  if (unavailable && !unavailable.hidden) {
    failures.push(`the "can't run the generator" fallback is showing: ${unavailable.textContent.trim()}`);
  }
  const initErrors = consoleErrors.filter((line) => line.includes('Ambi4 init failed'));
  if (initErrors.length) failures.push(`init reported: ${initErrors.join(' | ')}`);

  // Fresh-install gate: this realm boots with an EMPTY localStorage and no
  // consent cookie, which is every first-time visitor and the state the v7
  // RangeValue defaults land in — a param the engine ships as {min,max} has
  // no stored number for the page to fall back on, so a dial that mishandles
  // the object form shows "NaN" here rather than throwing anywhere.
  // Two things are asserted: nothing was persisted before consent was asked,
  // and every dial that built came up with a readable value.
  {
    const stored = ['ambi4:generator', 'ambi4-generator-settings-v2'].filter(
      (key) => window.localStorage.getItem(key) !== null
    );
    if (stored.length) {
      failures.push(`settings were persisted before consent was granted: ${stored.join(', ')}`);
    }
    const readouts = Array.from(window.document.querySelectorAll('.knob-value'));
    if (!readouts.length) {
      failures.push('no knob value readouts rendered on a fresh-install boot');
    }
    const broken = readouts
      .map((el) => el.textContent.trim())
      .filter((text) => !text || /NaN|undefined|Infinity/.test(text));
    if (broken.length) {
      failures.push(`dial readouts unreadable on a fresh install: ${broken.slice(0, 5).join(' | ')}`);
    }
    for (const track of REGISTRY_IDS) {
      const row = window.document.querySelector(`.track-row[data-track="${track}"]`);
      if (row && !row.querySelector('.rand-knob, .rand-slider')) {
        failures.push(`the ${track} row rendered no randomness control on a fresh install`);
      }
    }
  }

  // v21 track-registry gate: the page holds no track list of its own. Every
  // row it renders — count, order and label — comes from the engine's
  // getTracks(), so a registry the page has drifted from shows up here as a
  // row that is missing, extra, out of order or wrongly named.
  {
    const rows = Array.from(window.document.querySelectorAll('.track-row[data-track]'));
    const rowIds = rows.map((row) => row.getAttribute('data-track'));
    if (rowIds.join() !== REGISTRY_IDS.join()) {
      failures.push(
        `the track rows do not match the engine registry: rows [${rowIds.join(', ')}] ` +
          `vs getTracks() [${REGISTRY_IDS.join(', ')}]`
      );
    }
    for (const track of REGISTRY_TRACKS) {
      const row = window.document.querySelector(`.track-row[data-track="${track.id}"]`);
      const name = row && row.querySelector('.lamp-text');
      const shown = name ? name.textContent.trim() : null;
      if (row && shown !== track.label) {
        failures.push(
          `the ${track.id} row is labelled "${shown}" where the registry says "${track.label}"`
        );
      }
    }
  }

  // Fallback proof: an engine bundle without getTracks() boots the page on its
  // one remaining hardcoded table, FALLBACK_TRACKS. A fallback that has
  // drifted from the registry is a fallback that boots the WRONG tracks, and
  // nothing else in this harness would ever exercise it — so the table is read
  // out of the page source and matched against the live registry 1:1: ids,
  // order, labels, families, and both of the sets derived from it.
  {
    const pageSource = readFileSync(join(repoRoot, 'src/pages/index.astro'), 'utf8');
    const table = /const FALLBACK_TRACKS = (\[[\s\S]*?\n {4}\]);/.exec(pageSource);
    if (!table) {
      failures.push(
        'src/pages/index.astro has no FALLBACK_TRACKS table — an engine without getTracks() ' +
          'has nothing left to boot on'
      );
    } else {
      const fallback = new Function(`return ${table[1]};`)();
      const fallbackIds = fallback.map((track) => track.id);
      if (fallbackIds.join() !== REGISTRY_IDS.join()) {
        failures.push(
          `FALLBACK_TRACKS is not the registry: [${fallbackIds.join(', ')}] ` +
            `vs getTracks() [${REGISTRY_IDS.join(', ')}]`
        );
      }
      for (const track of REGISTRY_TRACKS) {
        const entry = fallback.find((item) => item.id === track.id);
        if (!entry) continue;
        if (entry.label !== track.label) {
          failures.push(`FALLBACK_TRACKS labels ${track.id} "${entry.label}", registry says "${track.label}"`);
        }
        if (entry.family !== track.family) {
          failures.push(`FALLBACK_TRACKS puts ${track.id} in family "${entry.family}", registry says "${track.family}"`);
        }
      }
      const fallbackSequenced = fallback
        .filter((track) => track.sequenced !== null)
        .sort((a, b) => a.sequenced - b.sequenced)
        .map((track) => track.id);
      if (fallbackSequenced.join() !== (engineModule.SEQUENCED_TRACKS || []).join()) {
        failures.push(
          `FALLBACK_TRACKS derives sequenced [${fallbackSequenced.join(', ')}] where the engine ` +
            `exports [${(engineModule.SEQUENCED_TRACKS || []).join(', ')}]`
        );
      }
      const fallbackTuned = fallback
        .filter((track) => track.family === 'melodic')
        .map((track) => track.id);
      // Set comparison: page lists run in DISPLAY order, engine lists in engine order.
      if ([...fallbackTuned].sort().join() !== [...(engineModule.TUNED_TRACKS || [])].sort().join()) {
        failures.push(
          `FALLBACK_TRACKS derives tuned [${fallbackTuned.join(', ')}] where the engine ` +
            `exports [${(engineModule.TUNED_TRACKS || []).join(', ')}]`
        );
      }
    }
  }

  // v16 placement gate: the factory-preset gallery moved BELOW the Simple
  // dials, and it is built by the page script from the build-time preset list
  // — so an empty row means the JSON payload never reached the page, which
  // `astro build` cannot see either.
  const doc = window.document;
  const simplePanel = doc.getElementById('panel-simple');
  const dials = simplePanel && simplePanel.querySelector('.sliders-module');
  const gallery = doc.getElementById('factory-presets');
  if (!dials) {
    failures.push("the Simple tab's dials container (.sliders-module) is missing");
  }
  if (!gallery) {
    failures.push('the factory-preset gallery (#factory-presets) is missing');
  } else if (!simplePanel || !simplePanel.contains(gallery)) {
    failures.push('the factory-preset gallery is not on the Simple tab');
  } else if (dials) {
    const following = dials.compareDocumentPosition(gallery) & window.Node.DOCUMENT_POSITION_FOLLOWING;
    if (!following) failures.push('the factory-preset gallery renders ABOVE the Simple dials');
  }
  const cards = doc.querySelectorAll('#factory-preset-row .factory-preset');
  if (!cards.length) failures.push('no factory preset button was rendered into #factory-preset-row');

  // v18 placement gate: the oscilloscope is PERSISTENT — it sits between the
  // transport strip and the piano roll, above the tab strip, so it survives a
  // tab switch; it carries no title of its own (the twisty is the only chrome,
  // and the word "Oscilloscope" shows only while it is collapsed); and its
  // legend is always populated, because the legend is the control surface even
  // when the trace is detached (which is exactly this harness's state — the
  // engine never plays here, so scope.js's own legend is never built and the
  // page's fallback must cover it).
  const scopeModule = doc.getElementById('front-scope-module');
  const tabs = doc.querySelector('.tabs');
  const pianoRoll = doc.getElementById('track-visualiser');
  const FOLLOWING = window.Node.DOCUMENT_POSITION_FOLLOWING;
  if (!scopeModule) {
    failures.push('the oscilloscope module (#front-scope-module) is missing');
  } else {
    if (simplePanel && simplePanel.contains(scopeModule)) {
      failures.push('the oscilloscope is inside the Simple tab panel — it must live above the tabs');
    }
    if (tabs && !(scopeModule.compareDocumentPosition(tabs) & FOLLOWING)) {
      failures.push('the oscilloscope renders BELOW the tab strip');
    }
    if (pianoRoll && !(scopeModule.compareDocumentPosition(pianoRoll) & FOLLOWING)) {
      failures.push('the oscilloscope renders BELOW the piano-roll visualiser');
    }
    if (scopeModule.querySelector('.panel-label')) {
      failures.push('the oscilloscope module still carries a panel title');
    }
    // v26: no faceplate either. The scope is a BARE display like the piano
    // roll, so it must not carry the module furniture class — the chrome is
    // an overlay on the canvas, not a box around it.
    if (scopeModule.classList.contains('module-panel')) {
      failures.push('the oscilloscope module still carries the .module-panel faceplate');
    }
    const overlay = doc.getElementById('front-scope-overlay');
    const scopeBody = doc.getElementById('front-scope-body');
    if (!overlay) {
      failures.push('the oscilloscope has no chrome overlay (#front-scope-overlay)');
    } else if (scopeBody && scopeBody.contains(overlay)) {
      failures.push(
        'the oscilloscope overlay is inside the collapsible body — collapsing would take the twisty with it'
      );
    }
    const word = doc.getElementById('front-scope-word');
    const toggle = doc.getElementById('front-scope-toggle');
    if (!toggle || !toggle.hasAttribute('aria-expanded')) {
      failures.push('the oscilloscope has no collapse twisty (#front-scope-toggle)');
    } else if (toggle.getAttribute('aria-expanded') === 'true' && word && !word.hidden) {
      failures.push('the word "Oscilloscope" shows while the scope is expanded');
    } else if (overlay && word && !overlay.contains(word)) {
      failures.push('the word "Oscilloscope" is not in the overlay — it would vanish when collapsed');
    }
    if (!scopeModule.hidden) {
      const legendKeys = doc.querySelectorAll('#front-scope-legend .scope-legend-track');
      if (!legendKeys.length) failures.push('the oscilloscope legend rendered no track keys');
    }
  }

  // v26 fullscreen: a toggle on each display, plus the host they are moved
  // into and the "+ the other one" control that stacks them. jsdom implements
  // no Fullscreen API, so the page feature-detects and HIDES both buttons
  // here — presence in the document is what this gate can prove, and a
  // missing button is the regression it is for.
  {
    const scopeFs = doc.getElementById('front-scope-fullscreen');
    const rollFs = doc.getElementById('roll-fullscreen');
    if (!scopeFs) failures.push('the oscilloscope has no fullscreen button (#front-scope-fullscreen)');
    if (!rollFs) failures.push('the piano roll has no fullscreen button (#roll-fullscreen)');
    if (scopeModule && scopeFs && !scopeModule.contains(scopeFs)) {
      failures.push('the oscilloscope fullscreen button is outside the module it fullscreens');
    }
    const rollStage = doc.getElementById('roll-stage');
    if (!rollStage) {
      failures.push('the piano roll has no fullscreen wrapper (#roll-stage)');
    } else if (pianoRoll && !rollStage.contains(pianoRoll)) {
      failures.push('#roll-stage does not wrap the piano-roll canvas');
    }
    if (!doc.getElementById('fullscreen-stage')) {
      failures.push('the fullscreen host (#fullscreen-stage) is missing');
    }
    if (!doc.getElementById('fullscreen-slots')) {
      failures.push('the fullscreen host has no slot container (#fullscreen-slots)');
    }
    if (!doc.getElementById('fullscreen-add')) {
      failures.push('the fullscreen host has no "+ the other display" control (#fullscreen-add)');
    }
  }

  // Guided tour: every step rings a control, and a step whose selector matches
  // nothing walks the newcomer past a blank. tests/tutorial-smoke.mjs holds the
  // whole rule set against the built MARKUP; this is the half only a booted
  // page can prove — the targets the page script builds itself (Add track)
  // exist, and exactly once, in the document the visitor actually gets.
  {
    const steps = readTutorialSteps();
    failures.push(...resolveTutorialTargets(steps, doc));
    for (const [index, step] of steps.entries()) {
      if (!step.tab) continue;
      if (!doc.getElementById(`tab-${step.tab}`)) {
        failures.push(`tutorial step ${index + 1} switches to a tab the page has not got: "${step.tab}"`);
      }
    }
  }

  // v26 Advanced layout rule: dials pack HORIZONTALLY. Repetition, Swing and
  // Reverb tail share the main-dial row rather than sitting on lines of their
  // own — a regression here reads to the user as "dials scattered at random".
  {
    const row = doc.querySelector('#advanced-dials .advanced-dial-row');
    if (!row) {
      failures.push('the Advanced main-dial row (#advanced-dials .advanced-dial-row) is missing');
    } else {
      for (const id of ['dial-repetition', 'dial-swing', 'dial-reverb-tail']) {
        const dial = doc.getElementById(id);
        if (!dial) failures.push(`the Advanced tab has no #${id}`);
        else if (!row.contains(dial)) failures.push(`#${id} is not in the shared main-dial row`);
      }
    }
  }

  // v19 roadmap "Offline waveform rule": with the engine stopped (this
  // harness never plays — no Play click, no OfflineAudioContext), the
  // per-voice editor scope must show the STATIC patch render rather than a
  // blank canvas, and the front oscilloscope a composite of every non-off
  // track. Grid-only draws stay well under this threshold (14 grid lines ×
  // 2 points = 28); a drawn trace is 512 math-model-fallback samples × 1–2
  // strokeTraceLine passes — hundreds to low-thousands of points.
  async function waitUntil(check, timeoutMs = 2000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (check()) return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return check();
  }
  const NON_TRIVIAL_TRACE_POINTS = 50;
  function traceColorCount(ctx) {
    return Object.values(ctx.pointsByColor || {}).filter(
      (points) => points.length >= NON_TRIVIAL_TRACE_POINTS
    ).length;
  }

  const padToggle = doc.getElementById('voice-edit-toggle-pad');
  if (!padToggle) {
    failures.push('no Edit toggle for the pad track (#voice-edit-toggle-pad)');
  } else {
    padToggle.click();
    const padScopeCanvas = () => doc.querySelector('#voice-editor-pad .patch-scope');
    const gotCanvas = await waitUntil(() => !!padScopeCanvas());
    if (!gotCanvas) {
      failures.push('opening the pad voice editor never rendered its scope canvas (.patch-scope)');
    } else {
      const canvas = padScopeCanvas();
      const drew = await waitUntil(() => traceColorCount(canvas.getContext('2d')) >= 1);
      const indicator = doc.querySelector('#voice-editor-pad .scope-mode');
      if (!indicator || indicator.textContent !== 'OFFLINE') {
        failures.push(
          'the stopped-engine pad editor scope should read OFFLINE, got: ' +
            (indicator ? indicator.textContent : '(missing)')
        );
      }
      if (!drew) {
        failures.push(
          'the stopped-engine pad editor scope drew no static trace beyond the fixed grid ' +
            '(offline waveform rule regression)'
        );
      }
      // The v19 groups are claimed by a voice SHIPPING those fields, never by
      // a blanket `controls: {source: true}` — the warm pad must not grow a
      // Spectral row it has no code to read.
      const padSections = Array.from(
        doc.querySelectorAll('#voice-editor-pad .knob-section > .panel-label')
      ).map((el) => el.textContent);
      const strays = padSections.filter((name) =>
        ['Spectral', 'Motion', 'Bursts', 'Glide', 'Formants', 'Phrasing'].includes(name)
      );
      if (strays.length) {
        failures.push(`the pad editor grew v19 sculpting rows it cannot use: ${strays.join(', ')}`);
      }
    }
  }

  // Knob-editor gate: buildKnobEditor is wrapped in a try/catch that falls
  // back to the slider editor, so a ReferenceError inside it is SILENT — the
  // editor still opens, just built from the wrong path (this is exactly how a
  // missing `base` binding hid for a whole iteration). Every track's editor
  // must therefore be proved to have built knob cells, not sliders.
  for (const track of REGISTRY_IDS) {
    doc.getElementById(`voice-edit-toggle-${track}`).click();
    const cells = () => doc.querySelectorAll(`#voice-editor-${track} .patch-controls .knob-cell`).length;
    const built = await waitUntil(() => cells() > 0);
    if (!built) {
      failures.push(
        `the ${track} voice editor fell back to the slider path — buildKnobEditor threw silently`
      );
    }
  }
  // The kit editor's per-instrument tab is the one path that renders ghosts.
  {
    doc.getElementById('voice-edit-toggle-percussion').click();
    await waitUntil(() => !!doc.getElementById('kit-kind-percussion-high'));
    const highTab = doc.getElementById('kit-kind-percussion-high');
    if (!highTab) {
      failures.push('the percussion editor has no High kit tab');
    } else {
      highTab.checked = true;
      highTab.dispatchEvent(new window.Event('change', { bubbles: true }));
      const ghosted = await waitUntil(
        () => doc.querySelectorAll('#voice-editor-percussion .knob-cell-ghosted').length > 0
      );
      if (!ghosted) {
        failures.push('the kit editor High tab showed no Common-value ghost on any dial');
      }
    }
  }

  // ---- v21 probe-gated surfaces --------------------------------------------
  // The page renders these only where the engine's own sanitiser accepts the
  // param behind them, so the gate has to ask the SAME question rather than
  // assert unconditionally: with the engine landed the control must be there;
  // against an engine that predates it, its absence is correct.
  const sanitise = engineModule.sanitiseParams;
  function probeTracks(partial) {
    if (typeof sanitise !== 'function') return null;
    try {
      const out = sanitise({ tracks: partial });
      return out && out.tracks ? out.tracks : null;
    } catch {
      return null;
    }
  }
  const laneProbe = probeTracks({
    percussion: { lanes: [{ id: '__probe', label: 'Lane 4', kind: 'mid' }] },
  });
  const engineTakesLanes = Boolean(
    laneProbe &&
      laneProbe.percussion &&
      Array.isArray(laneProbe.percussion.lanes) &&
      laneProbe.percussion.lanes.some((lane) => lane && lane.id === '__probe')
  );
  const feelProbe = probeTracks({ melody: { swing: 0.5, density: 1.5 } });
  const feelNullProbe = probeTracks({ melody: { swing: null, density: null } });
  const engineTakesSwing = Boolean(
    feelProbe && feelProbe.melody && feelProbe.melody.swing === 0.5 &&
      feelNullProbe && feelNullProbe.melody && feelNullProbe.melody.swing === null
  );
  const engineTakesDensity = Boolean(
    feelProbe && feelProbe.melody && feelProbe.melody.density === 1.5 &&
      feelNullProbe && feelNullProbe.melody && feelNullProbe.melody.density === null
  );

  async function openEditor(track) {
    const editor = doc.getElementById(`voice-editor-${track}`);
    if (editor && editor.hidden) doc.getElementById(`voice-edit-toggle-${track}`).click();
    await waitUntil(() => {
      const el = doc.getElementById(`voice-editor-${track}`);
      return el && !el.hidden;
    });
    return doc.getElementById(`voice-editor-${track}`);
  }

  // Per-track Swing (pulsed tracks) and Density (tuned tracks). Melody is both,
  // so one editor answers for both dials; percussion (untuned) must NOT grow a
  // Density dial even though the engine accepts the param on every track.
  {
    await openEditor('melody');
    const swingKnob = () =>
      doc.querySelector('#voice-editor-melody .track-swing-knob, #voice-editor-melody [id^="swing-melody"]');
    const densityKnob = () =>
      doc.querySelector(
        '#voice-editor-melody .track-density-knob, #voice-editor-melody [id^="density-melody"]'
      );
    if (engineTakesSwing) {
      if (!(await waitUntil(() => !!swingKnob()))) {
        failures.push('the engine accepts tracks.melody.swing but the melody editor has no Swing dial');
      }
    } else if (swingKnob()) {
      failures.push('a per-track Swing dial rendered against an engine that drops the param');
    }
    if (engineTakesDensity) {
      if (!(await waitUntil(() => !!densityKnob()))) {
        failures.push('the engine accepts tracks.melody.density but the melody editor has no Density dial');
      }
    } else if (densityKnob()) {
      failures.push('a per-track Density dial rendered against an engine that drops the param');
    }
    await openEditor('percussion');
    if (doc.querySelector('#voice-editor-percussion .track-density-knob')) {
      failures.push('the percussion editor grew a Density dial — it is a tuned-track control');
    }
  }

  // Per-step note length: the third axis on a melodic lane, keyboard path.
  {
    const gateProbe = sanitise
      ? sanitise({ tracks: { melody: { sequencer: { steps: [{ on: true, gate: 1.5 }] } } } })
      : null;
    const probedStep =
      gateProbe && gateProbe.tracks.melody.sequencer
        ? gateProbe.tracks.melody.sequencer.steps[0]
        : null;
    const engineTakesGate = Boolean(probedStep && probedStep.gate === 1.5);
    const editor = await openEditor('melody');
    const cell = editor.querySelector('.seq-cell');
    if (!cell) {
      failures.push('the melody editor rendered no step sequencer cells');
    } else if (engineTakesGate) {
      cell.dispatchEvent(new window.KeyboardEvent('keydown', { key: '=', bubbles: true }));
      const labelled = await waitUntil(() =>
        /length/.test(editor.querySelector('.seq-cell').getAttribute('aria-label') || '')
      );
      if (!labelled) {
        failures.push(
          'the engine accepts a per-step gate but "=" on a melody step changed no note length'
        );
      }
    }
  }

  // Kit lanes: the list renders HIGH kinds at the top, "Add lane" copies the
  // pattern of the lane it lands beside, the name is click-to-type, and the
  // built-ins keep their remove-proof status.
  {
    const editor = await openEditor('percussion');
    const heads = () => Array.from(editor.querySelectorAll('.seq-lane-head'));
    const laneNames = () =>
      heads().map((head) => (head.querySelector('.seq-lane-label') || {}).textContent);
    const built = await waitUntil(() => heads().length >= 3);
    if (!built) {
      failures.push('the percussion sequencer rendered no lane headers');
    } else {
      const names = laneNames();
      if (names[0] !== 'High' || names[names.length - 1] !== 'Low') {
        failures.push(`percussion lanes are not HIGH-first / LOW-last: ${names.join(', ')}`);
      }
      const addButton = editor.querySelector('.seq-lane-add');
      if (!engineTakesLanes) {
        if (addButton && !addButton.closest('[hidden]')) {
          failures.push('the Add lane button rendered against an engine with no dynamic lanes');
        }
      } else if (!addButton) {
        failures.push('the engine accepts user percussion lanes but the sequencer has no Add lane button');
      } else {
        const before = heads().length;
        // The new lane lands under Mid (its default kind), so the pattern it
        // copies is Mid's — an empty new row would be the regression here.
        const midRow = editor.querySelectorAll('.seq-rows > .seq-lane:not(.seq-lane-head-row):not(.seq-dot-row):not(.seq-prob-row)')[1];
        const midPattern = midRow
          ? Array.from(midRow.querySelectorAll('.seq-cell')).map((cell) =>
              cell.classList.contains('seq-cell-on')
            )
          : null;
        addButton.click();
        const grew = await waitUntil(() => heads().length === before + 1);
        if (!grew) {
          failures.push(`Add lane did not add a lane (still ${heads().length} lanes)`);
        } else {
          const names2 = laneNames();
          if (names2[2] !== 'Lane 4') {
            failures.push(`the added lane is not "Lane 4" below Mid: ${names2.join(', ')}`);
          }
          const newRow = editor.querySelectorAll('.seq-rows > .seq-lane:not(.seq-lane-head-row):not(.seq-dot-row):not(.seq-prob-row)')[2];
          const newPattern = newRow
            ? Array.from(newRow.querySelectorAll('.seq-cell')).map((cell) =>
                cell.classList.contains('seq-cell-on')
              )
            : null;
          if (!midPattern || !newPattern || newPattern.join() !== midPattern.join()) {
            failures.push('the added lane did not copy the nearest lane’s steps');
          }
          // Rename: the name is a button that swaps for a text input.
          const nameButton = heads()[2].querySelector('.seq-lane-name');
          if (!nameButton) {
            failures.push('the added lane has no click-to-type name');
          } else {
            nameButton.click();
            const input = heads()[2].querySelector('.seq-lane-input');
            if (!input) {
              failures.push('clicking a lane name did not open a text input');
            } else {
              input.value = 'Rim';
              input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
              const renamed = await waitUntil(() => laneNames()[2] === 'Rim');
              if (!renamed) failures.push(`renaming a lane did not stick: ${laneNames().join(', ')}`);
            }
          }
          // The block editor is the same pattern seen a second way, so it has
          // to be handed the same kit: a lane list it cannot adopt would show
          // three lanes (or "[object Object]" names) while the grid shows four.
          const blocksButton = editor.querySelector('.seq-blocks-button');
          if (blocksButton && !blocksButton.hidden) {
            blocksButton.click();
            const laneRows = () => editor.querySelectorAll('.seq-blocks .block-lane').length;
            const opened = await waitUntil(() => laneRows() > 0);
            if (opened && laneRows() !== heads().length) {
              failures.push(
                `the block editor shows ${laneRows()} lanes where the grid shows ${heads().length}`
              );
            }
            const blockNames = Array.from(
              editor.querySelectorAll('.seq-blocks .block-lane-name')
            ).map((el) => el.textContent);
            if (blockNames.some((name) => /object Object/.test(name))) {
              failures.push(`the block editor mangled the lane names: ${blockNames.join(', ')}`);
            }
            blocksButton.click(); // back to the grid
          }
          // Built-ins are protected; a user lane is removable.
          if (heads()[0].querySelector('.seq-lane-remove')) {
            failures.push('a built-in percussion lane offers a remove button');
          }
          const remove = heads()[2].querySelector('.seq-lane-remove');
          if (!remove) {
            failures.push('the added lane has no remove button');
          } else {
            remove.click();
            const shrank = await waitUntil(() => heads().length === before);
            if (!shrank) failures.push('removing a user lane left it in the grid');
          }
        }
      }
    }
  }

  // ---- iteration 4 probe-gated surfaces ------------------------------------
  // Same discipline as the v21 block above: ask the engine's own sanitiser the
  // same question the page does, then assert presence/absence to match — the
  // control renders once the engine lands the param, and stays absent before
  // then rather than doing nothing.
  const NEW_MODE_OPTIONS = [
    ['ionian', 'Ionian (Major)'],
    ['mixolydian', 'Mixolydian'],
    ['phrygian', 'Phrygian'],
  ];
  function probeMode(id) {
    if (typeof sanitise !== 'function') return false;
    try {
      const out = sanitise({ mode: id });
      return Boolean(out && out.mode === id);
    } catch {
      return false;
    }
  }
  {
    const modeSelect = doc.getElementById('mode');
    if (!modeSelect) {
      failures.push('the Scale select (#mode) is missing');
    } else {
      for (const [id, label] of NEW_MODE_OPTIONS) {
        const accepted = probeMode(id);
        const option = Array.from(modeSelect.options).find((o) => o.value === id);
        if (accepted && !option) {
          failures.push(`the engine accepts mode "${id}" but the Scale select has no "${label}" option`);
        } else if (!accepted && option) {
          failures.push(`a "${id}" Scale option rendered against an engine that drops it`);
        }
      }
    }
  }

  // Chord length select (harmony.rhythm), near Structure on the Advanced tab.
  {
    let engineTakesHarmonyRhythm = false;
    if (typeof sanitise === 'function') {
      try {
        const out = sanitise({ harmony: { rhythm: 4 } });
        engineTakesHarmonyRhythm = Boolean(out && out.harmony && out.harmony.rhythm === 4);
      } catch {}
    }
    const control = doc.getElementById('control-chord-length');
    const visible = Boolean(control && !control.hidden);
    if (engineTakesHarmonyRhythm && !visible) {
      failures.push('the engine accepts harmony.rhythm but the Chord length select stayed hidden');
    } else if (!engineTakesHarmonyRhythm && visible) {
      failures.push('the Chord length select is showing against an engine that drops harmony.rhythm');
    }
  }

  // Pad breath depth knob — pad's own editor only, never another track's.
  {
    // AUDIT FIX: this probed `tracks.pad.padBreath`, but the engine ships
    // padBreath as a GLOBAL param — so the gate was permanently false, the
    // dial never rendered, and BOTH branches of this assertion were dead
    // code for ~100 versions. Probed where the param actually lives.
    const globalProbe = (() => {
      try {
        const probed = sanitise({ padBreath: 0.4 });
        return probed && probed.padBreath === 0.4;
      } catch {
        return false;
      }
    })();
    const engineTakesPadBreath = Boolean(globalProbe);
    const padEditor = await openEditor('pad');
    const padKnob = () => padEditor.querySelector('.pad-breath-knob, #pad-breath');
    if (engineTakesPadBreath) {
      if (!(await waitUntil(() => !!padKnob()))) {
        failures.push('the engine accepts tracks.pad.padBreath but the pad editor has no Breath control');
      }
    } else if (padKnob()) {
      failures.push('a pad Breath control rendered against an engine that drops padBreath');
    }
    const arpEditor = await openEditor('arp');
    if (arpEditor.querySelector('.pad-breath-knob, #pad-breath')) {
      failures.push('the arp editor grew a pad Breath control — it is pad-only');
    }
  }

  // v26 OSC 2 ↔ Mix linkage: Mix is the BALANCE between the two oscillators,
  // so with Osc 2 switched off there is nothing for it to balance and it must
  // hide with the toggle. Switching Osc 2 back on brings it straight back —
  // this is a visibility rule, the stored balance is never rewritten.
  {
    let checked = false;
    for (const track of REGISTRY_IDS) {
      const editor = await openEditor(track);
      const toggle = editor.querySelector('.osc2-toggle');
      if (!toggle) continue;
      const mixCell = Array.from(editor.querySelectorAll('.patch-controls .knob-cell')).find(
        (cell) => {
          const label = cell.querySelector('.knob-label');
          return label && label.textContent.trim() === 'Mix';
        }
      );
      if (!mixCell) continue;
      checked = true;
      if (!toggle.getAttribute('title') && !toggle.getAttribute('aria-describedby')) {
        failures.push('the Osc 2 toggle carries no explanation of what Mix is for');
      }
      if (toggle.getAttribute('aria-pressed') === 'true') toggle.click(); // switch Osc 2 OFF
      if (!mixCell.hidden) {
        failures.push(`the ${track} editor still shows the Mix dial with Osc 2 switched off`);
      }
      toggle.click(); // and back ON
      if (mixCell.hidden) {
        failures.push(`the ${track} editor left the Mix dial hidden after Osc 2 was re-enabled`);
      }
      break;
    }
    if (!checked) {
      failures.push('no voice editor offered both an Osc 2 toggle and a Mix dial (v26 linkage unproved)');
    }
  }

  // v26 layout rule, per-track feel dials: Randomness/Swing/Density/Drift
  // rate/Dissonance form ONE aligned row inside the editor, never a column of
  // one-dial lines. The percussion editor (drift rate + swing, no dissonance,
  // no density) is the named offender, so it is the one asserted.
  {
    const editor = await openEditor('percussion');
    const rows = editor.querySelectorAll(':scope > .dissonance-row');
    if (rows.length > 1) {
      failures.push(
        `the percussion editor scatters its feel dials over ${rows.length} rows — they share one`
      );
    }
  }

  // v19 gate: the sculpting surface is only real if the dials actually build.
  // Texture's "Coloured noise" voice declares eleven source fields in its
  // `controls` (octave + the ten sculpting dials), grouped by the page into
  // Spectral / Motion / Bursts sub-rows. A voice whose controls table names
  // fields the editor's builder doesn't know about renders NOTHING for them
  // and no test below the DOM would notice.
  const textureSelect = doc.getElementById('track-voice-texture');
  if (!textureSelect) {
    failures.push('no voice selector for the texture track (#track-voice-texture)');
  } else if (!Array.from(textureSelect.options).some((option) => option.value === 'colour')) {
    failures.push('the texture voice selector does not offer the v19 "colour" voice');
  } else {
    textureSelect.value = 'colour';
    textureSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
    doc.getElementById('voice-edit-toggle-texture').click();
    const sourceKnobs = () =>
      doc.querySelectorAll('#voice-editor-texture .patch-controls .knob-cell').length;
    const built = await waitUntil(() => sourceKnobs() >= 10);
    if (!built) {
      failures.push(
        `the Coloured noise editor rendered ${sourceKnobs()} patch dials, expected at least 10 ` +
          '(v19 sculpting surface missing)'
      );
    }
    const headings = Array.from(
      doc.querySelectorAll('#voice-editor-texture .knob-section > .panel-label')
    ).map((el) => el.textContent);
    for (const heading of ['Spectral', 'Motion', 'Bursts']) {
      if (!headings.includes(heading)) {
        failures.push(`the Coloured noise editor has no "${heading}" sub-row (got: ${headings.join(', ')})`);
      }
    }
    // v12 mono/glide: engine params since v12, UI only now. Both are probed
    // against getParams() before they render, so their absence here means
    // either the probe or the engine's params changed shape.
    const header = doc.querySelector('#voice-editor-texture .ve-header');
    // v0.0.58: a Poly | Mono segmented pair, not a single pressed button. Both
    // options must be present — the whole reason for the change is that one
    // button distinguished only by fill-versus-outline cannot be read.
    const voiceMode = header && header.querySelector('.segmented.voice-mode');
    const modeOptions = voiceMode
      ? [...voiceMode.querySelectorAll('label')].map((l) => l.textContent)
      : [];
    if (!voiceMode || modeOptions.join('|') !== 'Poly|Mono') {
      failures.push(`the texture editor header has no Poly | Mono control (got: ${modeOptions.join(', ') || 'nothing'})`);
    }
    if (!header || !header.querySelector('.glide-knob, .glide-slider')) {
      failures.push('the texture editor header has no Glide control');
    }
  }

  // --------------------------------------------------------------------------
  // v0.0.172 — every dial says what you will hear, and the editor names its
  // engine (docs/synthesis-programme.md § 3). Checked on EVERY built-in
  // track's editor, against the registry row each dial says it edits
  // (data-field, the v0.0.171 seam): the hint must reach the dial's
  // ACCESSIBLE description, not just a hover title — keyboard and screen-
  // reader users get the same words. And the chip's class must be the one
  // the voice table declares for the sounding voice, not a page-side guess.
  // --------------------------------------------------------------------------
  {
    const registry = engineModule.PARAM_REGISTRY || {};
    const voicesModule = await import(
      pathToFileURL(join(repoRoot, 'src/scripts/engine-voices.js')).href
    );
    const VOICE_TABLE = voicesModule.VOICES || {};
    let dialsChecked = 0;
    for (const track of ['pad', 'arp', 'melody', 'bass', 'texture', 'percussion']) {
      const editor = await openEditor(track);
      await waitUntil(() => editor.querySelectorAll('.patch-controls .knob-cell[data-field]').length > 0);
      const cells = editor.querySelectorAll('.patch-controls .knob-cell[data-field]');
      if (!cells.length) {
        failures.push(`${track}: the editor rendered no dial that names its field — nothing to describe`);
        continue;
      }
      for (const cell of cells) {
        const field = cell.dataset.field;
        const row = registry[`patch.${field}`];
        if (!row) continue; // v0.0.171: a field with no row does not render — its own gate holds that
        const knob = cell.querySelector('.knob');
        const descId = knob && knob.getAttribute('aria-describedby');
        const desc = descId ? doc.getElementById(descId) : null;
        if (!desc || desc.textContent !== row.hint) {
          failures.push(
            `${track}: the ${field} dial's accessible description is ` +
              `${desc ? JSON.stringify(desc.textContent) : 'missing'}, not its registry hint`
          );
        }
        dialsChecked += 1;
      }
      const chip = editor.querySelector('.ve-header .ve-engine');
      const select = doc.getElementById(`track-voice-${track}`);
      const voiceSet = track;
      const chosen = select && VOICE_TABLE[voiceSet] && VOICE_TABLE[voiceSet][select.value]
        ? select.value
        : null;
      if (!chip || chip.hidden) {
        failures.push(`${track}: the editor header has no engine chip`);
      } else if (chosen && chip.dataset.engine !== VOICE_TABLE[voiceSet][chosen].engineType) {
        failures.push(
          `${track}: the chip says ${JSON.stringify(chip.dataset.engine)} but the voice table says ` +
            `${chosen} is ${JSON.stringify(VOICE_TABLE[voiceSet][chosen].engineType)}`
        );
      }
      const words = editor.querySelector('.ve-engine-words');
      if (!words || !words.textContent.trim()) {
        failures.push(`${track}: the editor has no sentence saying what its engine does`);
      }
    }
    if (dialsChecked < 40) {
      failures.push(`only ${dialsChecked} dials were checked for a hint across six editors — the seam has moved`);
    }

    // v0.0.175 — the FM section appears on an FM voice and on no other: the
    // disclosure rule, checked on the melody editor with Bell then Pluck.
    {
      const select = doc.getElementById('track-voice-melody');
      const fmCells = () => doc.querySelectorAll('#voice-editor-melody .patch-controls .knob-cell[data-field^="fm."]');
      const fmHeading = () => Array.from(doc.querySelectorAll('#voice-editor-melody .knob-section > .panel-label')).some((el) => el.textContent === 'FM');
      const pick = async (voice) => {
        select.value = voice;
        select.dispatchEvent(new window.Event('change', { bubbles: true }));
        await openEditor('melody');
        await waitUntil(() => doc.querySelectorAll('#voice-editor-melody .patch-controls .knob-cell').length > 0);
      };
      await pick('bell');
      if (!(await waitUntil(() => fmCells().length === 3))) {
        failures.push(`Bell's editor shows ${fmCells().length} FM dials, expected Ratio, Depth and Bite`);
      } else if (!fmHeading()) {
        failures.push('Bell\'s FM dials have no "FM" section heading');
      } else {
        for (const cell of fmCells()) {
          const row = registry[`patch.${cell.dataset.field}`];
          const knob = cell.querySelector('.knob');
          const descId = knob && knob.getAttribute('aria-describedby');
          const desc = descId ? doc.getElementById(descId) : null;
          if (!row || !desc || desc.textContent !== row.hint) {
            failures.push(`${cell.dataset.field}: the FM dial does not carry its registry hint`);
          }
        }
        const words = doc.querySelector('#voice-editor-melody .ve-words');
        if (!words || !/FM\) at 3\.47× the note/.test(words.textContent)) {
          failures.push(`Bell's words line does not name its FM ratio: ${JSON.stringify(words && words.textContent)}`);
        }
      }
      await pick('pluck');
      await new Promise((r) => setTimeout(r, 50));
      if (fmCells().length || fmHeading()) {
        failures.push('Pluck, a subtractive voice, grew FM dials — the disclosure rule is broken');
      }
    }

    // v0.0.176 — the Additive section appears on Glass (five drawbars and a
    // stretch, no sixth) and on no subtractive pad.
    {
      const select = doc.getElementById('track-voice-pad');
      const cells = () => doc.querySelectorAll('#voice-editor-pad .patch-controls .knob-cell[data-field^="additive."]');
      const pick = async (voice) => {
        select.value = voice;
        select.dispatchEvent(new window.Event('change', { bubbles: true }));
        await openEditor('pad');
        await waitUntil(() => doc.querySelectorAll('#voice-editor-pad .patch-controls .knob-cell').length > 0);
      };
      await pick('glass');
      if (!(await waitUntil(() => cells().length === 6))) {
        failures.push(`Glass's editor shows ${cells().length} additive dials, expected P1–P5 and Stretch`);
      } else {
        const fields = Array.from(cells()).map((c) => c.dataset.field);
        if (fields.includes('additive.p6')) failures.push('Glass has five partials but the editor shows a sixth drawbar');
        for (const cell of cells()) {
          const row = registry[`patch.${cell.dataset.field}`];
          const knob = cell.querySelector('.knob');
          const descId = knob && knob.getAttribute('aria-describedby');
          const desc = descId ? doc.getElementById(descId) : null;
          if (!row || !desc || desc.textContent !== row.hint) failures.push(`${cell.dataset.field}: the drawbar does not carry its registry hint`);
        }
      }
      await pick('warm');
      await new Promise((r) => setTimeout(r, 50));
      if (cells().length) failures.push('Warm, a subtractive pad, grew additive dials — the disclosure rule is broken');
    }

    // v0.0.177 — the Modal section appears on Marimba and on no plucked arp.
    {
      const select = doc.getElementById('track-voice-arp');
      const cells = () => doc.querySelectorAll('#voice-editor-arp .patch-controls .knob-cell[data-field^="modal."]');
      const pick = async (voice) => {
        select.value = voice;
        select.dispatchEvent(new window.Event('change', { bubbles: true }));
        await openEditor('arp');
        await waitUntil(() => doc.querySelectorAll('#voice-editor-arp .patch-controls .knob-cell').length > 0);
      };
      await pick('marimba');
      if (!(await waitUntil(() => cells().length === 3))) {
        failures.push(`Marimba's editor shows ${cells().length} modal dials, expected Material, Hardness and Damping`);
      } else {
        for (const cell of cells()) {
          const row = registry[`patch.${cell.dataset.field}`];
          const knob = cell.querySelector('.knob');
          const descId = knob && knob.getAttribute('aria-describedby');
          const desc = descId ? doc.getElementById(descId) : null;
          if (!row || !desc || desc.textContent !== row.hint) failures.push(`${cell.dataset.field}: the modal dial does not carry its registry hint`);
        }
        const words = doc.querySelector('#voice-editor-arp .ve-words');
        if (!words || !/\(modal, wood\)/.test(words.textContent)) failures.push(`Marimba's words line does not name its material: ${JSON.stringify(words && words.textContent)}`);
      }
      await pick('softPluck');
      await new Promise((r) => setTimeout(r, 50));
      if (cells().length) failures.push('Soft pluck, a subtractive arp, grew modal dials — the disclosure rule is broken');
    }

    // v0.0.182 — unit 8: My voices. Pin the pad on Warm, move Cutoff through
    // the real typed readout, save it under a name; the picker gains a My
    // voices entry that is selected; picking Glass then picking the saved
    // voice puts Warm back with that cutoff AT THE ENGINE; Forget removes it.
    {
      const select = doc.getElementById('track-voice-pad');
      const engine = window.__ambi4Engine;
      // Consent recorded here, deliberately: prefs writes then go to this
      // window's storage and leave its in-memory layer — which the bundle's
      // prefs module shares across the boots below, unlike a real reload —
      // so the reload boot reads its OWN storage rather than a shadow.
      doc.cookie = 'ambi4-consent=granted';
      select.value = 'warm';
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
      const editor = await openEditor('pad');
      // Release, not Cutoff: cutoff opens as a SPAN by default (v7's rangeDefault
      // list) and a typed single number is not a span; release is a plain dial.
      await waitUntil(() => editor.querySelectorAll('.patch-controls .knob-cell[data-field="adsr.release"]').length === 1);
      const cutoffCell = editor.querySelector('.patch-controls .knob-cell[data-field="adsr.release"]');
      const readout = cutoffCell && cutoffCell.querySelector('.knob-value');
      const nameBox = editor.querySelector('.ve-voice-name');
      const saveButton = editor.querySelector('.ve-save-voice');
      if (!readout || !nameBox || !saveButton) {
        failures.push('the pad editor has no Release readout, name box or Save as my voice button');
      } else {
        readout.click();
        const edit = cutoffCell.querySelector('.knob-value-edit');
        if (!edit) {
          failures.push('clicking the Release readout did not open its typed editor');
        } else {
          const releaseIs = (v) => (v && typeof v === 'object' ? Math.abs(v.min - 2.5) < 0.05 && Math.abs(v.max - 2.5) < 0.05 : Math.abs(Number(v) - 2.5) < 0.05);
          edit.value = '2.5';
          edit.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          const landed = await waitUntil(() => {
            const p = engine.getParams().patches;
            return p && p.pad && p.pad.warm && p.pad.warm.adsr && releaseIs(p.pad.warm.adsr.release);
          });
          if (!landed) failures.push(`typing 2.5 s into Release did not reach the engine's patch (${JSON.stringify(engine.getParams().patches && engine.getParams().patches.pad && engine.getParams().patches.pad.warm && engine.getParams().patches.pad.warm.adsr)})`);
          nameBox.value = 'Dusk pad';
          saveButton.click();
          const group = () => select.querySelector('optgroup.my-voices');
          const saved = await waitUntil(() => group() && group().querySelectorAll('option').length === 1);
          if (!saved) {
            failures.push('Save as my voice did not add a My voices entry to the pad picker');
          } else {
            const option = group().querySelector('option');
            if (option.textContent !== 'Dusk pad') failures.push(`the saved voice is listed as ${JSON.stringify(option.textContent)}`);
            if (select.value !== option.value) failures.push(`the picker did not read as the saved voice (reads ${select.value})`);
            // Away to Glass, then back to the saved voice.
            select.value = 'glass';
            select.dispatchEvent(new window.Event('change', { bubbles: true }));
            await waitUntil(() => engine.getParams().tracks.pad.voice === 'glass');
            select.value = option.value;
            select.dispatchEvent(new window.Event('change', { bubbles: true }));
            const back = await waitUntil(() => {
              const params = engine.getParams();
              const patch = params.patches && params.patches.pad && params.patches.pad.warm;
              return params.tracks.pad.voice === 'warm' && patch && patch.adsr && releaseIs(patch.adsr.release);
            });
            if (!back) failures.push('picking the saved voice did not put Warm with release 2.5 s back at the engine');
            if (select.value !== option.value) failures.push('the picker does not read as the saved voice after picking it');
            // v0.0.183 (unit 9): Share carries the voice's name beside its
            // base and patch — the tag rides the diff, the sound already did.
            const shareButton = doc.getElementById('preset-share');
            if (shareButton) {
              clipboard.text = '';
              shareButton.click();
              const copied = await waitUntil(() => clipboard.text.includes('#p='));
              if (!copied) {
                failures.push('Share while a voice of the person\'s own plays copied nothing');
              } else {
                const value = clipboard.text.slice(clipboard.text.indexOf('#p=') + 3);
                let decoded = null;
                try {
                  decoded = JSON.parse(Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
                } catch (err) {
                  failures.push(`the shared link did not decode: ${err && err.message}`);
                }
                const tag = decoded && ((decoded.d && decoded.d.tracks && decoded.d.tracks.pad && decoded.d.tracks.pad.userVoice)
                  || (decoded.tracks && decoded.tracks.pad && decoded.tracks.pad.userVoice));
                if (!tag || tag.name !== 'Dusk pad' || tag.id !== option.value.slice('mine:'.length)) {
                  failures.push(`the shared link does not name the voice of the person's own (${JSON.stringify(tag)})`);
                }
              }
            }
            // v0.0.190 (review #4): an Apply of the genre rules keeps the tag,
            // so the picker still names the voice rather than "Warm · edited".
            const rulesToggle = doc.getElementById('genre-rules-toggle');
            if (rulesToggle && !rulesToggle.hidden && engine.getParams().genre) {
              rulesToggle.click();
              await waitUntil(() => !doc.getElementById('genre-rules').hidden);
              doc.getElementById('genre-rules-apply').click();
              await new Promise((r) => setTimeout(r, 150));
              if (select.value !== option.value) failures.push(`an Apply of the rules dropped the own-voice tag: the picker reads ${JSON.stringify(select.value)}`);
              rulesToggle.click();
              // Apply may have redrawn the pad's voice from the genre; put the saved one back for Forget.
              select.value = option.value;
              select.dispatchEvent(new window.Event('change', { bubbles: true }));
              await new Promise((r) => setTimeout(r, 60));
            }
            const forget = doc.querySelector('#voice-editor-pad .ve-forget-voice');
            if (!forget || forget.hidden) {
              failures.push('Forget this voice is hidden while the saved voice plays');
            } else {
              forget.click();
              const gone = await waitUntil(() => !group());
              if (!gone) failures.push('Forget this voice left the My voices group in the picker');
            }
          }
        }
      }
    }

    // v0.0.184 — unit 15: every lesson chapter's targets resolve to exactly
    // one dial in its home editor on its home voice, and pressing the chip
    // opens the lesson in the panel with the first dial highlighted; Next
    // advances; closing the panel ends the lesson and the tour returns.
    {
      const chapters = readLessonChapters();
      for (const chapter of chapters) {
        const select = doc.getElementById(`track-voice-${chapter.track}`);
        select.value = chapter.voice;
        select.dispatchEvent(new window.Event('change', { bubbles: true }));
        const editor = await openEditor(chapter.track);
        await waitUntil(() => editor.querySelectorAll('.patch-controls .knob-cell[data-field]').length > 0);
        await waitUntil(() => {
          const chip = editor.querySelector('.ve-header .ve-engine');
          return chip && chip.dataset.engine && editor.querySelector(chapter.steps[0].target);
        });
        for (const [i, step] of chapter.steps.entries()) {
          const found = editor.querySelectorAll(step.target).length;
          if (found !== 1) failures.push(`lesson "${chapter.label}" step ${i + 1}: ${step.target} matches ${found} dials in the ${chapter.track} editor on ${chapter.voice}`);
        }
        const chip = editor.querySelector('.ve-header .ve-engine');
        if (!chip || chip.tagName !== 'BUTTON') {
          failures.push(`the ${chapter.track} editor's engine chip is not a button`);
          continue;
        }
        chip.click();
        const panel = doc.getElementById('tutorial-panel');
        const title = doc.getElementById('tutorial-title');
        const opened = await waitUntil(() => panel && !panel.hidden && title && title.textContent === chapter.label);
        if (!opened) {
          failures.push(`pressing the ${chapter.engine} chip did not open "${chapter.label}" (panel ${panel && panel.hidden ? 'hidden' : 'open'}, title ${JSON.stringify(title && title.textContent)})`);
          continue;
        }
        const first = editor.querySelector(chapter.steps[0].target);
        if (!first || !first.classList.contains('tutorial-highlight')) failures.push(`"${chapter.label}" did not highlight its first dial`);
        if (doc.getElementById('tutorial-progress').textContent !== `1 / ${chapter.steps.length}`) failures.push(`"${chapter.label}" progress reads ${doc.getElementById('tutorial-progress').textContent}`);
        doc.getElementById('tutorial-next').click();
        const second = editor.querySelector(chapter.steps[1].target);
        if (!second || !second.classList.contains('tutorial-highlight')) failures.push(`"${chapter.label}" Next did not move the highlight to the second dial`);
        doc.getElementById('tutorial-close').click();
        if (!panel.hidden) failures.push(`closing "${chapter.label}" left the panel open`);
        if (editor.querySelector('.tutorial-highlight')) failures.push(`closing "${chapter.label}" left a dial highlighted`);
      }
      // The tour itself is untouched by a lesson: opening it by its button shows the tour's title.
      doc.getElementById('tutorial-toggle').click();
      if (doc.getElementById('tutorial-title').textContent !== 'Guided tour') failures.push('after a lesson the tour opens under the wrong title');
      doc.getElementById('tutorial-close').click();
    }

    // v0.0.185 — unit 16: the finder. On the melody, press "bright" and
    // "glassy": the answer names Bell (FM) and two moves; Set it up puts Bell
    // on the track at the ENGINE with its FM depth moved up from the default.
    // On the kit, every word is refused with a plain sentence.
    {
      const engine = window.__ambi4Engine;
      const select = doc.getElementById('track-voice-melody');
      select.value = 'pluck';
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
      const editor = await openEditor('melody');
      await waitUntil(() => editor.querySelector('.ve-finder-word[data-word="bright"]'));
      const finder = editor.querySelector('.ve-finder');
      if (!finder) {
        failures.push('the melody editor has no finder row');
      } else {
        finder.querySelector('.ve-finder-word[data-word="bright"]').click();
        finder.querySelector('.ve-finder-word[data-word="glassy"]').click();
        const answer = finder.querySelector('.ve-finder-answer').textContent;
        if (!/^Try Bell \(FM\)/.test(answer)) failures.push(`bright and glassy on the melody answered ${JSON.stringify(answer)}, not Bell (FM)`);
        const go = finder.querySelector('.ve-finder-go');
        if (!go || go.hidden) {
          failures.push('the finder has an answer but no Set it up button');
        } else {
          const depthBefore = 1;
          go.click();
          const landed = await waitUntil(() => {
            const params = engine.getParams();
            const fm = params.patches && params.patches.melody && params.patches.melody.bell && params.patches.melody.bell.fm;
            return params.tracks.melody.voice === 'bell' && fm && Number(fm.depth) > depthBefore;
          });
          if (!landed) failures.push(`Set it up did not put Bell with a raised FM depth at the engine (${JSON.stringify(engine.getParams().tracks.melody.voice)})`);
        }
        // Pressing the opposite un-presses its pair.
        const rebuilt = await openEditor('melody');
        await waitUntil(() => rebuilt.querySelector('.ve-finder-word[data-word="dark"]'));
        rebuilt.querySelector('.ve-finder-word[data-word="bright"]').click();
        rebuilt.querySelector('.ve-finder-word[data-word="dark"]').click();
        if (rebuilt.querySelector('.ve-finder-word[data-word="bright"]').getAttribute('aria-pressed') !== 'false') failures.push('pressing dark left bright pressed');
      }
      const kit = await openEditor('percussion');
      await waitUntil(() => kit.querySelector('.ve-finder-word[data-word="bright"]'));
      kit.querySelector('.ve-finder-word[data-word="bright"]').click();
      const kitAnswer = kit.querySelector('.ve-finder-answer').textContent;
      if (!/Nothing here is honestly bright on this track/.test(kitAnswer)) failures.push(`the kit's finder answered ${JSON.stringify(kitAnswer)} rather than refusing honestly`);
      if (!kit.querySelector('.ve-finder-go').hidden) failures.push('the kit offers Set it up with nothing to set up');
    }

    // v0.0.187 — the dial LAYOUT of every stock voice, pinned. Phase 2c of
    // the routing programme turns the knob editor's hand-written literals
    // into a loop over the registry, and "byte-identical" needs a witness:
    // this fixture is every built-in track's every voice's dials — field and
    // label, in order — captured from the page BEFORE the refactor and held
    // afterwards. Missing fixture: written (the first run is the truth);
    // present: asserted.
    {
      const fixturePath = join(repoRoot, 'tests/fixtures/editor-dials.json');
      const layout = {};
      const voicesModule = await import(pathToFileURL(join(repoRoot, 'src/scripts/engine-voices.js')).href);
      for (const track of ['pad', 'arp', 'melody', 'bass', 'texture', 'percussion']) {
        const select = doc.getElementById(`track-voice-${track}`);
        layout[track] = {};
        for (const voice of Object.keys(voicesModule.VOICES[track])) {
          select.value = voice;
          select.dispatchEvent(new window.Event('change', { bubbles: true }));
          const editor = await openEditor(track);
          await waitUntil(() => {
            const cells = editor.querySelectorAll('.patch-controls .knob-cell[data-field]');
            return cells.length > 0 && editor.querySelector('.ve-header .ve-engine');
          });
          await new Promise((r) => setTimeout(r, 30));
          layout[track][voice] = Array.from(editor.querySelectorAll('.patch-controls .knob-section')).map((section) => ({
            heading: section.querySelector('.panel-label') ? section.querySelector('.panel-label').textContent : '',
            dials: Array.from(section.querySelectorAll('.knob-cell')).map((cell) => ({
              field: cell.dataset.field || null,
              label: cell.querySelector('.knob-label') ? cell.querySelector('.knob-label').textContent : (cell.querySelector('button') ? cell.querySelector('button').textContent : ''),
              hidden: cell.hidden === true,
              // v0.0.192: the dial's own domain as the DOM states it — a log
              // dial reads 0–1 here (its log map lives in the page), so a
              // linear dial turning log, or a domain moving, changes the pin.
              min: cell.querySelector('.knob') ? cell.querySelector('.knob').getAttribute('aria-valuemin') : null,
              max: cell.querySelector('.knob') ? cell.querySelector('.knob').getAttribute('aria-valuemax') : null,
            })),
          }));
        }
      }
      if (!existsSync(fixturePath)) {
        writeFileSync(fixturePath, JSON.stringify(layout, null, 1) + '\n');
        console.log(`editor-dials fixture written: ${fixturePath}`);
      } else {
        const pinned = JSON.parse(readFileSync(fixturePath, 'utf8'));
        const want = JSON.stringify(pinned);
        const got = JSON.stringify(layout);
        if (want !== got) {
          for (const track of Object.keys(pinned)) {
            for (const voice of Object.keys(pinned[track])) {
              if (JSON.stringify(pinned[track][voice]) !== JSON.stringify(layout[track] && layout[track][voice])) {
                failures.push(`${track}.${voice}: the dial layout moved — pinned ${JSON.stringify(pinned[track][voice])} got ${JSON.stringify(layout[track] && layout[track][voice])}`);
              }
            }
          }
        }
      }
    }

    // v0.0.188 — the slider fallback editor, booted on purpose. With the seam
    // set, every stock voice renders through the path the page takes when
    // knob.js is missing: every control names its field (pinned, with its
    // label and kind, in tests/fixtures/editor-controls-fallback.json — written
    // when absent, asserted when present), and every control's input or select
    // carries its registry hint as its accessible description.
    {
      const fixturePath = join(repoRoot, 'tests/fixtures/editor-controls-fallback.json');
      const registry = engineModule.PARAM_REGISTRY || {};
      const voicesModule = await import(pathToFileURL(join(repoRoot, 'src/scripts/engine-voices.js')).href);
      const layout = {};
      let described = 0;
      window.__ambi4SliderEditor = true;
      for (const track of ['pad', 'arp', 'melody', 'bass', 'texture', 'percussion']) {
        const select = doc.getElementById(`track-voice-${track}`);
        layout[track] = {};
        for (const voice of Object.keys(voicesModule.VOICES[track])) {
          select.value = voice;
          select.dispatchEvent(new window.Event('change', { bubbles: true }));
          const editor = await openEditor(track);
          const built = await waitUntil(() => editor.querySelectorAll('.patch-controls .ve-control[data-field]').length > 0
            && !editor.querySelector('.patch-controls .knob-cell'));
          if (!built) {
            failures.push(`${track}.${voice}: the slider editor did not render with the seam set`);
            continue;
          }
          await new Promise((r) => setTimeout(r, 30));
          layout[track][voice] = Array.from(editor.querySelectorAll('.patch-controls .ve-control')).map((wrap) => ({
            field: wrap.dataset.field || null,
            label: wrap.querySelector('label') ? wrap.querySelector('label').textContent : '',
            kind: wrap.querySelector('select') ? 'select' : wrap.querySelector('input[type="range"]') ? 'range' : 'other',
            // v0.0.192: the slider's own min, max and step — a log slider reads 0–1, step 0.001.
            range: wrap.querySelector('input[type="range"]')
              ? ['min', 'max', 'step'].map((a) => wrap.querySelector('input[type="range"]').getAttribute(a))
              : null,
          }));
          for (const wrap of editor.querySelectorAll('.patch-controls .ve-control[data-field]')) {
            const row = registry[`patch.${wrap.dataset.field}`];
            const control = wrap.querySelector('input, select');
            const descId = control && control.getAttribute('aria-describedby');
            const desc = descId ? doc.getElementById(descId) : null;
            if (!row) continue;
            if (!desc || desc.textContent !== row.hint) failures.push(`${track}.${voice}: the fallback ${wrap.dataset.field} control does not carry its registry hint`);
            described += 1;
          }
        }
      }
      window.__ambi4SliderEditor = false;
      // Back to the knob editor for everything after this block.
      for (const track of ['pad', 'arp', 'melody', 'bass', 'texture', 'percussion']) {
        const select = doc.getElementById(`track-voice-${track}`);
        select.dispatchEvent(new window.Event('change', { bubbles: true }));
      }
      if (described < 200) failures.push(`only ${described} fallback controls were checked for a hint — the seam has moved`);
      if (!existsSync(fixturePath)) {
        writeFileSync(fixturePath, JSON.stringify(layout, null, 1) + '\n');
        console.log(`editor-controls-fallback fixture written: ${fixturePath}`);
      } else {
        const pinned = JSON.parse(readFileSync(fixturePath, 'utf8'));
        for (const track of Object.keys(pinned)) {
          for (const voice of Object.keys(pinned[track])) {
            if (JSON.stringify(pinned[track][voice]) !== JSON.stringify(layout[track] && layout[track][voice])) {
              failures.push(`${track}.${voice}: the fallback control layout moved — pinned ${JSON.stringify(pinned[track][voice])} got ${JSON.stringify(layout[track] && layout[track][voice])}`);
            }
          }
        }
      }
    }

    // v0.0.191 — the engine's genre table is registered: a slug no genre
    // has is refused at the engine rather than kept as an opaque tag (the
    // call that should have done this never ran). Saved and carried user
    // genres still tag the engine — the checks further on hold that half.
    {
      const engine = window.__ambi4Engine;
      const before = engine.getParams().genre;
      engine.setParams({ genre: 'not-a-genre' });
      await new Promise((r) => setTimeout(r, 30));
      if (engine.getParams().genre === 'not-a-genre') failures.push('the engine kept a genre slug no genre has — its genre table was never registered');
      engine.setParams({ genre: before ?? null });
    }

    // v0.0.174 — "what makes this sound": the words line under the dials is
    // exactly what the pure module says for the sounding voice's patch, so the
    // page's wiring (voice, controls, detune mode, the live patch object) is
    // proven against the module the smoke test holds to its number law.
    const wordsModule = await import(
      pathToFileURL(join(repoRoot, 'src/scripts/patch-words.js')).href
    );
    for (const track of ['pad', 'arp', 'melody', 'bass', 'texture', 'percussion']) {
      const editor = await openEditor(track);
      const line = editor.querySelector('.ve-words');
      const select = doc.getElementById(`track-voice-${track}`);
      const voice = select && VOICE_TABLE[track] && VOICE_TABLE[track][select.value]
        ? VOICE_TABLE[track][select.value]
        : null;
      if (!line || line.hidden || !line.textContent.trim()) {
        failures.push(`${track}: the editor has no "what makes this sound" line`);
        continue;
      }
      if (!voice) continue;
      // A fresh boot stores no patch, so the page describes the voice's own
      // defaults; an edited patch is the smoke test's business.
      const want = wordsModule.describePatch({
        engineType: voice.engineType,
        patch: voice.defaults,
        controls: voice.controls,
        detuneMode: voice.detuneMode || null,
      });
      // The page describes the RESOLVED patch (defaults merged over the
      // fallback patch and shape-normalised), which prints the same words as
      // the voice's own defaults for a stock voice — every number is the same.
      if (line.textContent !== want) {
        failures.push(`${track}: the words line says ${JSON.stringify(line.textContent)} but the module says ${JSON.stringify(want)}`);
      }
    }
  }

  if (scopeModule && !scopeModule.hidden) {
    const activeTracks = doc.querySelectorAll('.track-row:not([data-track-state="off"])').length;
    const frontCanvas = doc.getElementById('front-scope');
    if (!frontCanvas) {
      failures.push('#front-scope canvas is missing');
    } else if (!activeTracks) {
      // every track off — no composite preview possible, nothing to assert
    } else {
      // Owner ruling (fromMartin 22): the front scope stays DARK until Play —
      // the composite stopped-state preview is retired; assert the inverse.
      await new Promise((r) => setTimeout(r, 300));
      const got = traceColorCount(frontCanvas.getContext('2d'));
      if (got !== 0) {
        failures.push(`the stopped front oscilloscope must stay dark (surprise ruling), drew ${got} traces`);
      }
    }
  }

  // ---- v26 genre transport --------------------------------------------------
  // LAST in this harness on purpose: picking a genre replaces the whole params
  // object, so every assertion above runs against the boot state rather than
  // against whatever this block last chose.
  //
  // The genre files are read from SOURCE and matched against the built list,
  // the same discipline the track-registry gate uses: a glob that silently
  // resolved to nothing, or a genre file added without the page picking it up,
  // is invisible to `astro build` and to every module smoke test.
  {
    const genreDir = join(repoRoot, 'src/data/genres');
    const genres = readdirSync(genreDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(readFileSync(join(genreDir, name), 'utf8')));
    const select = doc.getElementById('genre-select');
    if (!genres.length) {
      failures.push('src/data/genres holds no genre files — the genre transport has nothing to offer');
    } else if (!select) {
      failures.push('the genre picker (#genre-select) is missing from the transport');
    } else {
      const values = () => Array.from(select.options).map((option) => option.value);
      // v0.0.63: four genres are deliberately hidden from the public list.
      // They must still COMPILE — a share link or a stored preset naming one
      // has to keep playing what it always played, which is the whole reason
      // they are hidden rather than deleted — but they must not be offered.
      // v0.0.64: only the two genres the owner did not criticise are offered.
      // The rest still exist as files — that is what keeps old share links
      // playing — and must not appear in the picker.
      const PUBLIC = new Set(['synthwave', 'techno-tools']);
      const HIDDEN = new Set(genres.map((g) => g.slug).filter((s) => !PUBLIC.has(s)));
      const shownButHidden = genres
        .filter((genre) => HIDDEN.has(genre.slug) && values().includes(`g:${genre.slug}`))
        .map((genre) => genre.slug);
      if (shownButHidden.length) {
        failures.push(`hidden genres are being offered in the picker: ${shownButHidden.join(', ')}`);
      }
      const missing = genres
        .filter((genre) => !HIDDEN.has(genre.slug) && !values().includes(`g:${genre.slug}`))
        .map((genre) => genre.slug);
      if (missing.length) {
        failures.push(
          `the genre list is missing ${missing.length} of the ${genres.length - HIDDEN.size} public genre files: ${missing.join(', ')}`
        );
      }
      if (!values().includes('surprise')) {
        failures.push('the genre list has no "Surprise me" entry');
      }
      if (!values().includes('favourites')) {
        failures.push('the genre list has no favourites entry');
      }

      // Placement: the picker sits UNDER the Play/Finish key, which is where
      // the spec puts it and where a listener looks for it.
      const play = doc.getElementById('toggle-play');
      const genreRow = select.closest('.genre-row');
      if (!genreRow) {
        failures.push('the genre picker is not in a .genre-row');
      } else if (play && !(play.compareDocumentPosition(genreRow) & FOLLOWING)) {
        failures.push('the genre picker renders ABOVE the Play button');
      }

      // The opening draw: this realm boots with empty storage and no consent,
      // which is exactly the fresh visit the weighted pick exists for. The
      // reported finding was that every fresh load sounded the same piece, so
      // "opened on the bare defaults" is the regression.
      const opened = select.value.startsWith('g:') ? select.value.slice(2) : null;
      const openedGenre = genres.find((genre) => genre.slug === opened) || null;
      if (!openedGenre) {
        failures.push(
          `a fresh visit did not open on a genre — the picker reads "${select.value || '(none)'}"`
        );
      } else {
        const defaults = engineModule.DEFAULT_PARAMS || {};
        // v0.0.46: the standalone BPM slider is gone, so the tempo is read off
        // the Tempo dial's own readout ("52 bpm") instead of an input's value.
        // The bpm-range checks below are worth keeping — they are what proves a
        // genre's declared tempo actually reaches the engine — so they get a
        // reader rather than being dropped with the input.
        const readBpm = () => {
          const el =
            doc.querySelector('#speed-dial .knob-value') ||
            doc.querySelector('#speed-dial-adv .knob-value');
          const n = el ? parseInt(String(el.textContent).replace(/[^0-9]/g, ''), 10) : NaN;
          return Number.isFinite(n) ? n : NaN;
        };
        const signature = () => ({
          mode: doc.getElementById('mode').value,
          timeSignature: doc.getElementById('timeSignature').value,
          structure: doc.getElementById('structure').value,
          states: REGISTRY_IDS.map((id) => {
            const row = doc.querySelector(`.track-row[data-track="${id}"]`);
            return row ? row.getAttribute('data-track-state') : '';
          }),
        });
        const defaultSignature = {
          mode: defaults.mode,
          timeSignature: defaults.timeSignature,
          structure: defaults.structure,
          states: REGISTRY_IDS.map((id) => (defaults.tracks?.[id] || {}).state ?? ''),
        };
        if (JSON.stringify(signature()) === JSON.stringify(defaultSignature)) {
          failures.push(
            'a fresh visit opened on a genre tag but every headline param is still the engine ' +
              'default — the opening compile never reached the params'
          );
        }
        const [lo, hi] = openedGenre.essence.bpm;
        const openedBpm = readBpm();
        if (!(openedBpm >= Math.floor(lo) && openedBpm <= Math.ceil(hi))) {
          failures.push(
            `the opening genre is ${openedGenre.slug} (${lo}-${hi} bpm) but the tempo reads ${openedBpm}`
          );
        }
      }

      // Picking a genre compiles it into the live params: the proof is that
      // the params land inside the rules that genre declares.
      // v0.0.63: pick from what the PICKER actually offers. Four genres are
      // hidden from the public list (they still exist and still compile, so
      // old links keep working), and selecting one that has no <option> sets
      // the select to "" — which reads as "picking it did not stick" when the
      // real fault is that the test asked for something off the menu.
      const offered = new Set(
        [...select.querySelectorAll('option')]
          .map((o) => o.value)
          .filter((v) => v.startsWith('g:'))
          .map((v) => v.slice(2))
      );
      const target = genres.find((genre) => genre.slug !== opened && offered.has(genre.slug))
        || genres.find((genre) => offered.has(genre.slug))
        || genres[0];
      select.value = `g:${target.slug}`;
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
      const picked = await waitUntil(() => select.value === `g:${target.slug}`);
      if (!picked) {
        failures.push(`picking ${target.slug} did not stick in the genre picker (${select.value})`);
      } else {
        const bpm = (() => {
          const el =
            doc.querySelector('#speed-dial .knob-value') ||
            doc.querySelector('#speed-dial-adv .knob-value');
          const n = el ? parseInt(String(el.textContent).replace(/[^0-9]/g, ''), 10) : NaN;
          return Number.isFinite(n) ? n : NaN;
        })();
        const [lo, hi] = target.essence.bpm;
        if (!(bpm >= Math.floor(lo) && bpm <= Math.ceil(hi))) {
          failures.push(`picking ${target.slug} (${lo}-${hi} bpm) left the tempo at ${bpm}`);
        }
        const allowed = target.essence.modes.map((entry) =>
          entry && typeof entry === 'object' ? entry.value : entry
        );
        const mode = doc.getElementById('mode').value;
        if (!allowed.includes(mode)) {
          failures.push(
            `picking ${target.slug} left the scale on "${mode}", which the genre does not declare`
          );
        }
      }

      // Loading a factory preset CLEARS the tag: a preset is a fixed params
      // snapshot, so the piece it loads is no longer the genre's.
      const card = doc.querySelector('#factory-preset-row .factory-preset');
      if (card) {
        card.click();
        const cleared = await waitUntil(() => select.value === '');
        if (!cleared) {
          failures.push(`loading a factory preset left the genre tag at "${select.value}"`);
        }
      }

      // Favourites: the entry opens a checkbox editor over the whole set, and
      // ticking one adds its MOOD group to the list; the hide toggle prunes
      // the main list to favourites.
      select.value = 'favourites';
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
      const editor = doc.getElementById('genre-favourites');
      const boxes = editor
        ? Array.from(editor.querySelectorAll('.genre-fav-item input[type="checkbox"]'))
        : [];
      const hideOthers = doc.getElementById('genre-hide-others');
      if (!editor || editor.hidden) {
        failures.push('the favourites entry did not open the favourites editor');
      }
      // The editor offers the PUBLIC set, not every file: a tick-box for a
      // genre the picker will not list is a control that cannot do anything.
      const publicCount = genres.filter((g) => PUBLIC.has(g.slug)).length;
      if (boxes.length !== publicCount) {
        failures.push(
          `the favourites editor offers ${boxes.length} genres where ${publicCount} are public`
        );
      }
      if (!hideOthers) {
        failures.push('the favourites editor has no hide-non-favourites toggle');
      }
      if (boxes.length && hideOthers) {
        boxes[0].checked = true;
        boxes[0].dispatchEvent(new window.Event('change', { bubbles: true }));
        if (!values().some((value) => value.startsWith('mood:'))) {
          failures.push('a favourited genre added no mood group to the genre list');
        }
        hideOthers.checked = true;
        hideOthers.dispatchEvent(new window.Event('change', { bubbles: true }));
        const listed = values().filter((value) => value.startsWith('g:'));
        if (listed.length >= genres.length) {
          failures.push(
            `hide-non-favourites left all ${listed.length} genres in the list — the toggle prunes nothing`
          );
        }
        if (!values().includes('surprise') || !values().includes('favourites')) {
          failures.push('hide-non-favourites also pruned the Surprise me / favourites entries');
        }
      }
      doc.getElementById('genre-favourites-done')?.click();
    }

    // Pause and fast-forward. Both ship on every engine build — a stop-and-
    // rebuild is still a pause to the listener — but WHICH pause the button
    // runs is probed, and its own explanation has to match what it will do.
    const pauseButton = doc.getElementById('pause-toggle');
    if (!pauseButton) {
      failures.push('the transport has no Pause button (#pause-toggle)');
    } else {
      if (!pauseButton.disabled) {
        failures.push('the Pause button is live with the engine stopped — there is nothing to hold');
      }
      let enginePauses = false;
      try {
        enginePauses = typeof engineModule.createEngine().pause === 'function';
      } catch {}
      const describedBy = pauseButton.getAttribute('aria-describedby');
      const explanation = describedBy ? (doc.getElementById(describedBy) || {}).textContent || '' : '';
      if (!explanation) {
        failures.push('the Pause button carries no explanation of what it will do');
      }
      const claimsExact = /same point/i.test(explanation);
      if (enginePauses && !claimsExact) {
        failures.push(
          'the engine ships pause() but the Pause button still explains itself as a stop-and-rebuild'
        );
      }
      if (!enginePauses && claimsExact) {
        failures.push(
          'the Pause button promises an exact-position resume against an engine with no pause()'
        );
      }
    }
    const forwardButton = doc.getElementById('fast-forward');
    if (!forwardButton) {
      failures.push('the transport has no fast-forward button (#fast-forward)');
    } else if (forwardButton.hidden) {
      failures.push('the fast-forward button is hidden against an engine that can re-seed');
    }
  }
  // ---- v23 user tracks — probe-gated ---------------------------------------
  // The Add Track surface renders ONLY where the engine can answer both halves
  // of the question — canAddTrack (may I) and addTrack (do it). Against a build
  // that predates them its ABSENCE is the correct state; present-but-does-
  // nothing is the bug this gate exists to catch, so the harness asks the same
  // question the page does rather than asserting unconditionally.
  let engineTakesUserTracks = false;
  try {
    const probe = engineModule.createEngine();
    engineTakesUserTracks =
      typeof probe.canAddTrack === 'function' && typeof probe.addTrack === 'function';
  } catch {}
  {
    const button = doc.getElementById('add-track');
    if (!engineTakesUserTracks) {
      if (button) {
        failures.push(
          'the Add Track button renders against an engine with no addTrack/canAddTrack — ' +
            'a control that cannot do anything'
        );
      }
    } else if (!button) {
      failures.push('the engine ships addTrack/canAddTrack but the tracks panel has no #add-track button');
    } else {
      if (button.disabled) {
        failures.push('the Add Track button is disabled on a boot with none of the six user slots used');
      }
      const form = doc.getElementById('add-track-form');
      if (!form) {
        failures.push('#add-track has no #add-track-form to open');
      } else if (!form.hidden) {
        failures.push('the Add Track form is open before the button has been pressed');
      }
      // The panel must not jiggle when the note text changes, so the note has
      // to be in the document from the start rather than appearing with words.
      if (!doc.getElementById('add-track-note')) {
        failures.push('the Add Track control has no always-present note line (#add-track-note)');
      }
    }
  }

  // v0.0.178 — unit 10: the Rules panel shows the genre's essence, and an
  // edit reaches the ENGINE. Pin the genre first (a fresh visit draws a
  // random one). The Tempo dial's typed readout takes "lo-hi" — the same
  // click-to-type every dial has — so the test edits through the real
  // control, then Apply, then reads the engine's stored bpm, not the readout.
  {
    const genreSelect = doc.getElementById('genre-select');
    const toggle = doc.getElementById('genre-rules-toggle');
    const engine = window.__ambi4Engine;
    if (!genreSelect || !toggle || !engine) {
      failures.push('the rules panel needs #genre-select, #genre-rules-toggle and the engine seam');
    } else {
      genreSelect.value = 'g:synthwave';
      genreSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
      await waitUntil(() => engine.getParams().genre === 'synthwave');
      // The button shows once the compiler has loaded and the row is live.
      if (!(await waitUntil(() => !toggle.hidden))) failures.push('the Rules button is hidden with a genre chosen');
      toggle.click();
      const panel = doc.getElementById('genre-rules');
      await waitUntil(() => panel && !panel.hidden);
      const tempoCell = doc.querySelector('#genre-rules-tempo-ui .rules-dial[data-field="essence.bpm"]');
      const swingCell = doc.querySelector('#genre-rules-tempo-ui .rules-dial[data-field="essence.swing"]');
      if (!tempoCell || !swingCell) failures.push('the rules panel has no Tempo and Swing dials');
      const metres = doc.querySelectorAll('#genre-rules-metres-ui .rules-row').length;
      const modes = doc.querySelectorAll('#genre-rules-modes-ui .rules-row').length;
      const rates = doc.querySelectorAll('#genre-rules-rhythm-ui .rules-row').length;
      if (metres !== 1 || modes !== 2 || rates !== 3) {
        failures.push(`synthwave's essence rows: ${metres} metre(s), ${modes} mode(s), ${rates} rate(s) — expected 1, 2, 3 as its file declares`);
      }
      const before = engine.getParams().bpm;
      const readout = tempoCell && tempoCell.querySelector('.knob-value');
      if (readout) {
        readout.click();
        const edit = tempoCell.querySelector('.knob-value-edit');
        if (!edit) {
          failures.push('clicking the Tempo readout did not open its typed editor');
        } else {
          edit.value = '200-200';
          edit.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          doc.getElementById('genre-rules-apply').click();
          const landed = await waitUntil(() => engine.getParams().bpm === 200);
          if (!landed) failures.push(`Apply with Tempo 200–200 left the engine at ${engine.getParams().bpm} bpm (was ${before})`);
          // v0.0.186 — the share wire's version stamp, the other half: with an
          // essence re-ruling in place a link carries a genreRules key a
          // pre-178 build reads past, so it takes the latest stamp (2), and
          // the diff carries the re-ruling itself.
          {
            const share = doc.getElementById('preset-share');
            if (share) {
              clipboard.text = '';
              share.click();
              const copied = await waitUntil(() => clipboard.text.includes('#p='));
              const ruled = copied ? decodeCopiedLink() : null;
              if (!ruled) {
                failures.push('Share with an essence re-ruling copied nothing that decodes');
              } else {
                if (ruled.v !== 2) failures.push(`a link carrying an essence re-ruling is stamped schema ${JSON.stringify(ruled.v)}, not 2`);
                const rules = (ruled.d && ruled.d.genreRules) || ruled.genreRules;
                if (!rules || !Array.isArray(rules.bpm) || rules.bpm[0] !== 200) failures.push(`the link does not carry the tempo re-ruling (${JSON.stringify(rules)})`);
              }
            }
          }
          if (toggle.textContent !== 'Rules · edited') failures.push(`the Rules button does not say edited after an essence change (says ${JSON.stringify(toggle.textContent)})`);
          // v0.0.179 (unit 11): the rest of the essence is on screen, and a
          // ruled LINE-UP lands at the engine — the one kind of rule Apply
          // used to keep out, because the person asked for it here.
          const arcs = doc.querySelectorAll('#genre-rules-arc-ui .rules-row').length;
          if (arcs !== 3) failures.push(`synthwave's structure rows: ${arcs}, expected 3 (abab, journey, waves)`);
          for (const field of ['essence.extensionBias', 'essence.dissonanceRange', 'essence.densityBias', 'essence.reverbTail']) {
            if (!doc.querySelector(`#genre-rules-colour-ui .rules-dial[data-field="${field}"]`)) failures.push(`the rules panel has no ${field} dial`);
          }
          const lineupRows = doc.querySelectorAll('#genre-rules-lineup-ui .rules-lineup-row');
          if (lineupRows.length !== 6) failures.push(`the line-up shows ${lineupRows.length} rows, expected six built-in tracks`);
          const padRow = doc.querySelector('#genre-rules-lineup-ui .rules-lineup-row[data-track="pad"]');
          const padVoice = padRow && padRow.querySelectorAll('select')[1];
          if (!padVoice || padVoice.value !== 'polysaw') failures.push(`the pad line-up row does not show synthwave's polysaw (got ${padVoice && padVoice.value})`);
          const padState = padRow && padRow.querySelectorAll('select')[0];
          if (padState) {
            padState.value = 'off';
            padState.dispatchEvent(new window.Event('change', { bubbles: true }));
            doc.getElementById('genre-rules-apply').click();
            const padOff = await waitUntil(() => engine.getParams().tracks && engine.getParams().tracks.pad && engine.getParams().tracks.pad.state === 'off');
            if (!padOff) failures.push(`ruling the pad Off in the line-up left the engine at ${JSON.stringify(engine.getParams().tracks && engine.getParams().tracks.pad && engine.getParams().tracks.pad.state)}`);
            // v0.0.190 (review #3): a ruled row lands ONCE. Pick Strings on the
            // pad by hand, Apply again with nothing changed in Rules: Strings
            // stays — the row said "Poly saw" when it was ruled, not now.
            const padPicker = doc.getElementById('track-voice-pad');
            padPicker.value = 'strings';
            padPicker.dispatchEvent(new window.Event('change', { bubbles: true }));
            await waitUntil(() => engine.getParams().tracks.pad.voice === 'strings');
            doc.getElementById('genre-rules-apply').click();
            await new Promise((r) => setTimeout(r, 120));
            if (engine.getParams().tracks.pad.voice !== 'strings') failures.push(`a second Apply with no rule changed re-landed the pad's ruled voice over the hand-picked one (${engine.getParams().tracks.pad.voice})`);
          }
          // v0.0.180 (unit 12): Save as my genre. The rules above (pad Off, tempo
          // 200) become a genre of the person's own: it appears under My genres,
          // is the current genre at the engine, and NEXT draws a fresh piece
          // from it with the pad still Off — the proof the rule lives in the
          // genre, not in the setup. Forget returns to the genre it came from.
          const nameInput = doc.getElementById('genre-rules-name');
          const saveButton = doc.getElementById('genre-rules-save');
          if (!nameInput || !saveButton) {
            failures.push('the rules panel has no name box and Save as my genre button');
          } else {
            saveButton.click();
            const errorEl = doc.getElementById('genre-rules-error');
            if (!errorEl || errorEl.hidden) failures.push('Save with no name did not ask for one');
            // v0.0.190 (review #5): an unapplied edit is refused — what you keep
            // must be what is playing.
            const metreSelect = doc.querySelector('#genre-rules-metres-ui .rules-row select');
            if (metreSelect) {
              metreSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
              nameInput.value = 'Night pads';
              saveButton.click();
              if (!errorEl || errorEl.hidden || !/Apply your changes first/.test(errorEl.textContent)) failures.push(`Save as my genre with an unapplied edit was not refused (${JSON.stringify(errorEl && errorEl.textContent)})`);
              doc.getElementById('genre-rules-apply').click();
              await new Promise((r) => setTimeout(r, 120));
            }
            nameInput.value = 'Night pads';
            saveButton.click();
            const mineGroup = () => Array.from(doc.querySelectorAll('#genre-select optgroup')).find((g) => g.label === 'My genres');
            const saved = await waitUntil(() => !!mineGroup() && mineGroup().querySelectorAll('option').length === 1);
            if (!saved) {
              failures.push('Save as my genre did not add a My genres entry to the picker');
            } else {
              const option = mineGroup().querySelector('option');
              const slug = option.value.slice(2);
              if (option.textContent !== 'Night pads') failures.push(`the saved genre is listed as ${JSON.stringify(option.textContent)}`);
              if (genreSelect.value !== option.value) failures.push(`the picker did not move to the saved genre (reads ${genreSelect.value})`);
              if (engine.getParams().genre !== slug) failures.push(`the engine's genre tag is ${JSON.stringify(engine.getParams().genre)}, not the saved genre`);
              if (engine.getParams().bpm !== 200) failures.push('saving must not change what is playing');
              if (toggle.textContent !== 'Rules') failures.push(`the rules are baked into the saved genre, yet the button says ${JSON.stringify(toggle.textContent)}`);
              const forget = doc.getElementById('genre-rules-forget');
              if (!forget || forget.hidden) failures.push('Forget this genre is hidden on a genre of the person\'s own');
              // Next: a fresh draw from the saved genre keeps the ruled pad Off and the tempo 200.
              // Next redraws from the saved genre. Whether the chord loop changes
              // is chance (the genre's grammar has five loops, so one draw in
              // five repeats it); what is asserted is that the redraw is a draw
              // OF THE SAVED GENRE — its tag, its ruled pad, its ruled tempo.
              doc.getElementById('fast-forward').click();
              await new Promise((r) => setTimeout(r, 150));
              const redrawn = await waitUntil(() => engine.getParams().genre === slug, 8000);
              if (!redrawn) failures.push('Next did not draw from the saved genre');
              const pad = engine.getParams().tracks && engine.getParams().tracks.pad;
              if (!pad || pad.state !== 'off') failures.push(`a fresh draw from the saved genre has the pad ${JSON.stringify(pad && pad.state)}, not Off — the rule did not live in the genre`);
              if (engine.getParams().bpm !== 200) failures.push(`a fresh draw from the saved genre is at ${engine.getParams().bpm} bpm, not the ruled 200`);
              // v0.0.181 (unit 13): Share carries the genre as data. The link on
              // the clipboard decodes to a compact payload whose origin names
              // the saved genre and whose 'g' key IS the genre, stamped latest.
              const shareButton = doc.getElementById('preset-share');
              if (shareButton) {
                clipboard.text = '';
                shareButton.click();
                const copied = await waitUntil(() => clipboard.text.includes('#p='));
                if (!copied) {
                  failures.push('Share on a genre of the person\'s own copied nothing');
                } else {
                  const value = clipboard.text.slice(clipboard.text.indexOf('#p=') + 3);
                  let decoded = null;
                  try {
                    decoded = JSON.parse(Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
                  } catch (err) {
                    failures.push(`the shared link did not decode: ${err && err.message}`);
                  }
                  if (decoded) {
                    if (!decoded.o || decoded.o.id !== slug) failures.push(`the shared link's origin names ${JSON.stringify(decoded.o && decoded.o.id)}, not the saved genre`);
                    if (!decoded.g || decoded.g.slug !== slug || decoded.g.name !== 'Night pads') failures.push('the shared link does not carry the genre as data');
                    if (decoded.g && decoded.g.essence && decoded.g.essence.instrumentation && decoded.g.essence.instrumentation.perTrack && decoded.g.essence.instrumentation.perTrack.pad && decoded.g.essence.instrumentation.perTrack.pad.state !== 'off') failures.push('the carried genre lost its ruled pad');
                    if (decoded.v !== 2) failures.push(`a link carrying a genre is stamped ${JSON.stringify(decoded.v)}, not the latest schema`);
                  }
                }
              }
              if (forget) {
                forget.click();
                const gone = await waitUntil(() => !mineGroup() && genreSelect.value === 'g:synthwave');
                if (!gone) failures.push(`Forget did not remove the genre and return the picker to Synthwave (reads ${genreSelect.value})`);
                if (engine.getParams().genre !== 'synthwave') failures.push('Forget did not tag the setup with the genre it was made from');
              }
            }
          }
          // Back to the genre's rules: the same seed redraws the genre's own tempo.
          doc.getElementById('genre-rules-reset').click();
          const restored = await waitUntil(() => engine.getParams().bpm !== 200);
          if (!restored) failures.push('Back to the genre\'s rules left the essence override in place');
          const padBack = await waitUntil(() => engine.getParams().tracks && engine.getParams().tracks.pad && engine.getParams().tracks.pad.state === 'on');
          if (!padBack) failures.push('Back to the genre\'s rules did not restore the pad to On');
        }
      } else if (tempoCell) {
        failures.push('the Tempo dial has no typed readout');
      }
      if (panel && !panel.hidden) toggle.click();
    }
  }

  // ---- v23 fallback table is still the built-in six -------------------------
  // FALLBACK_TRACKS is the branch an engine bundle WITHOUT getTracks() boots
  // on, and an engine that can addTrack necessarily HAS getTracks() — so that
  // branch can never meet a seventh track and the table stays six forever. The
  // comparison is against the MODULE registry (built-ins), never the live
  // instance list, or adding a track in this harness would fail a test about
  // something else entirely.
  {
    const pageSource = readFileSync(join(repoRoot, 'src/pages/index.astro'), 'utf8');
    const table = /const FALLBACK_TRACKS = (\[[\s\S]*?\n {4}\]);/.exec(pageSource);
    const fallback = table ? new Function(`return ${table[1]};`)() : [];
    if (fallback.length !== 6) {
      failures.push(`FALLBACK_TRACKS has ${fallback.length} entries — it is the built-in six, forever`);
    }
    if (REGISTRY_IDS.length !== 6) {
      failures.push(
        `the MODULE getTracks() returned ${REGISTRY_IDS.length} tracks — the build-time export is ` +
          'built-ins only; a user track must never reach it'
      );
    }
    const notBuiltin = REGISTRY_TRACKS.filter((track) => track.builtin !== true).map((t) => t.id);
    if (notBuiltin.length) {
      failures.push(`the MODULE registry carries non-built-in tracks: ${notBuiltin.join(', ')}`);
    }
    if (fallback.map((t) => t.id).join() !== REGISTRY_IDS.join()) {
      failures.push(
        `FALLBACK_TRACKS [${fallback.map((t) => t.id).join(', ')}] is not the module registry ` +
          `[${REGISTRY_IDS.join(', ')}]`
      );
    }
  }

  // ---- v23 a user track row appends below the built-in six ------------------
  // The whole of commit 4 in one gate: the row is BUILT (it did not exist at
  // build time), it is built BELOW everything that did (v18 — nothing above it
  // moves), and it answers to the SAME listeners a built-in row answers to.
  // That last clause is the pre-mortem's fourth blocker: a runtime row wired by
  // a second, parallel set of handlers is the failure this proves against.
  if (engineTakesUserTracks && doc.getElementById('add-track')) {
    const rowIdsOf = () =>
      Array.from(doc.querySelectorAll('.track-row[data-track]')).map((row) =>
        row.getAttribute('data-track')
      );
    const before = rowIdsOf();
    const beforeOrder = before.join();
    doc.getElementById('add-track').click();
    const form = doc.getElementById('add-track-form');
    const nameInput = doc.getElementById('add-track-name');
    if (!form || form.hidden || !nameInput) {
      failures.push('pressing Add Track did not open its form');
    } else {
      nameInput.value = 'Chimes 2';
      form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      const appeared = await waitUntil(() => rowIdsOf().length === before.length + 1);
      if (!appeared) {
        const err = doc.getElementById('add-track-error');
        failures.push(
          'submitting the Add Track form built no new row' +
            (err && err.textContent ? ` — the form says: ${err.textContent}` : '')
        );
      } else {
        const after = rowIdsOf();
        const newId = after[after.length - 1];
        if (after.slice(0, before.length).join() !== beforeOrder) {
          failures.push(
            `adding a track moved the built-in rows: [${beforeOrder}] became [${after.slice(0, before.length).join()}]`
          );
        }
        const row = doc.querySelector(`.track-row[data-track="${newId}"]`);
        const item = row && row.parentElement;
        const items = Array.from(doc.querySelectorAll('.track-rows > [data-track-item], .track-rows > .track-item'));
        if (item && items.length && items[items.length - 1] !== item) {
          failures.push('the user track row is not the LAST row in the tracks panel');
        }
        // Colour: the theme must define the token the engine assigned, and the
        // row has to carry the class that reads it.
        if (item && !item.className.includes('track-color-user-1')) {
          failures.push(`the first user track row carries no --track-user-1 accent class (got "${item.className}")`);
        }
        // Every control a built-in row has, on a row the build never rendered.
        const missing = [];
        if (!doc.getElementById(`track-lamp-${newId}`)) missing.push('lamp');
        const select = doc.getElementById(`track-voice-${newId}`);
        if (!select || !select.options.length) missing.push('voice select with options');
        if (!row?.querySelector('.level-knob, .level-slider')) missing.push('level control');
        if (!row?.querySelector('.rand-knob, .rand-slider')) missing.push('randomness control');
        if (!doc.getElementById(`voice-edit-toggle-${newId}`)) missing.push('Edit toggle');
        if (!doc.getElementById(`track-remove-${newId}`)) missing.push('remove button');
        if (missing.length) {
          failures.push(`the user track row is missing: ${missing.join(', ')}`);
        }
        // The listeners, not just the markup: a lamp that does not cycle is a
        // row that was drawn rather than wired.
        const lamp = doc.getElementById(`track-lamp-${newId}`);
        const stateBefore = row?.getAttribute('data-track-state');
        lamp?.click();
        const cycled = await waitUntil(() => row?.getAttribute('data-track-state') !== stateBefore);
        if (!cycled) {
          failures.push(`the user track's lamp does not cycle its state — the row was built but not wired`);
        }
        // The editor accordion, the knob path and the step grid, on the same
        // terms the six get: buildKnobEditor falling back to sliders here would
        // be silent everywhere else.
        doc.getElementById(`voice-edit-toggle-${newId}`)?.click();
        const built = await waitUntil(
          () => doc.querySelectorAll(`#voice-editor-${newId} .patch-controls .knob-cell`).length > 0
        );
        if (!built) {
          failures.push(`the user track's voice editor built no knob cells — it fell back to sliders`);
        }
        const stepped = await waitUntil(
          () => doc.querySelectorAll(`#voice-editor-${newId} .seq-cell`).length > 0
        );
        if (!stepped) {
          failures.push('the user track\'s editor rendered no step sequencer — every user track is sequenced');
        }
        // Removal is offered on user tracks only, and it takes the row with it.
        for (const track of REGISTRY_IDS) {
          if (doc.getElementById(`track-remove-${track}`)) {
            failures.push(`the built-in ${track} row carries a remove button — a built-in cannot go`);
          }
        }
        doc.getElementById(`track-remove-${newId}`)?.click();
        const gone = await waitUntil(() => !doc.querySelector(`.track-row[data-track="${newId}"]`));
        if (!gone) {
          failures.push('removing the user track left its row in the document');
        } else if (rowIdsOf().join() !== beforeOrder) {
          failures.push(
            `removing the user track disturbed the built-in rows: [${rowIdsOf().join()}] vs [${beforeOrder}]`
          );
        }
      }
    }
  }

  // ---- v28 play along + Capture — probe-gated -------------------------------
  // The row renders only where the engine can sound a live note, for the same
  // reason the Add Track surface does: a control that cannot do anything is
  // worse than no control. What this gate proves beyond presence is the part
  // no unit test can reach — that the KEYS are wired to the engine, that they
  // are armed only while the toggle is on, and that they never fire while
  // someone is typing.
  let engineTakesLiveNotes = false;
  try {
    const probe = engineModule.createEngine();
    engineTakesLiveNotes =
      typeof probe.noteOn === 'function' && typeof probe.noteOff === 'function';
  } catch {}
  {
    // v0.0.40: the panel became a POPOVER hanging off a keyboard icon in the
    // transport icon row, so the panel itself is correctly hidden until asked
    // for. What the probe gate now proves is that the ICON is there and
    // reachable when the engine can sound live notes, and absent when it
    // cannot — a keyboard with nothing behind it is still the thing to catch.
    const row = doc.getElementById('play-along');
    const opener = doc.getElementById('play-along-open');
    const openerAnchor = opener ? opener.closest('.popover-anchor') : null;
    const openerShown = !!opener && !(openerAnchor && openerAnchor.hidden);
    if (!engineTakesLiveNotes) {
      if (openerShown) {
        failures.push(
          'the play-along keyboard renders against an engine with no noteOn/noteOff — ' +
            'a keyboard with nothing behind it'
        );
      }
    } else if (!row) {
      failures.push('the engine sounds live notes but the transport has no play-along panel (#play-along)');
    } else if (!opener) {
      failures.push('the engine sounds live notes but there is no keyboard button to open the panel (#play-along-open)');
    } else if (!openerShown) {
      failures.push('the play-along keyboard is hidden against an engine that ships noteOn/noteOff');
    } else if (!row.hidden) {
      failures.push('the play-along panel is open on load — it is a popover and must start closed');
    } else {
      const transport = doc.querySelector('.transport-module');
      if (transport && !transport.contains(row)) {
        failures.push('the play-along panel is not in the transport panel');
      }
      // v0.0.89 (his 103, reversing v0.0.85's placement): Create is the
      // orange ICON in the icon row — icon-only, CREATE in the tooltip; the
      // wide in-row button forced the transport onto two lines.
      if (!doc.querySelector('.transport-icons #play-along-open')) {
        failures.push('the Create icon is not in the transport icon row');
      }
      const toggle = doc.getElementById('play-along-toggle');
      const picker = doc.getElementById('play-along-track');
      const capture = doc.getElementById('play-along-capture');
      const undo = doc.getElementById('play-along-undo');
      const readout = doc.getElementById('play-along-readout');
      const note = doc.getElementById('play-along-note');
      const missing = [];
      if (!toggle) missing.push('toggle (#play-along-toggle)');
      if (!picker) missing.push('track picker (#play-along-track)');
      if (!capture) missing.push('Capture button (#play-along-capture)');
      if (!undo) missing.push('Undo button (#play-along-undo)');
      if (!readout) missing.push('note readout (#play-along-readout)');
      if (!note) missing.push('always-present note line (#play-along-note)');
      if (missing.length) failures.push(`the play-along row is missing: ${missing.join(', ')}`);

      if (picker && picker.options.length < REGISTRY_IDS.length) {
        failures.push(
          `the play-along picker offers ${picker.options.length} tracks where the registry has ` +
            `${REGISTRY_IDS.length} — the keys must be able to reach any of them`
        );
      }
      // A step grid holds no pitch, so a page that lets someone record into
      // one owes them that sentence before they play.
      if (note && !/pitch/i.test(note.textContent || '')) {
        failures.push(
          'the play-along note never mentions pitch — a captured take is a rhythm, and ' +
            'the page has to say so'
        );
      }

      if (toggle && capture && undo && readout) {
        const key = (type, k, target) =>
          (target || doc.body).dispatchEvent(
            new window.KeyboardEvent(type, { key: k, bubbles: true, cancelable: true })
          );
        const press = (k, target) => key('keydown', k, target);
        const release = (k, target) => key('keyup', k, target);

        if (toggle.getAttribute('aria-pressed') !== 'false') {
          failures.push('the play-along toggle boots pressed — the keys must be off until asked for');
        }
        if (!capture.disabled) failures.push('Capture is live before the keyboard is armed');
        if (!undo.disabled) failures.push('Undo is live with nothing to undo');

        // Disarmed: the page must not touch a key.
        press('z');
        release('z');
        if (readout.textContent !== '') {
          failures.push(
            `a key press sounded a note with Play along switched OFF (readout "${readout.textContent}")`
          );
        }

        toggle.click();
        if (toggle.getAttribute('aria-pressed') !== 'true') {
          failures.push('clicking Play along did not arm it');
        }
        press('z');
        const sounded = readout.textContent;
        if (!/^[A-G]/.test(sounded)) {
          failures.push(`pressing z with Play along armed left the readout at "${sounded}"`);
        }
        release('z');

        // Typing is not playing. A text box, a select and a dialog all keep
        // their keystrokes — this is the gate that stops the instrument eating
        // a preset name.
        const nameBox = doc.getElementById('preset-name');
        const genreSelect = doc.getElementById('genre-select');
        const sleepDialog = doc.getElementById('sleep-popover');
        for (const [label, target] of [
          ['a text input', nameBox],
          ['a select', genreSelect],
          ['an open dialog', sleepDialog],
        ]) {
          if (!target) continue;
          readout.textContent = 'guard';
          press('x', target);
          release('x', target);
          if (readout.textContent !== 'guard') {
            failures.push(`a key pressed inside ${label} played a note (readout "${readout.textContent}")`);
          }
        }
        readout.textContent = '';

        // Octave shift, and a note from the octave it moved to.
        press('=');
        const shifted = readout.textContent;
        if (!/^Oct /.test(shifted)) {
          failures.push(`the octave-up key left the readout at "${shifted}"`);
        }
        press('z');
        const higher = readout.textContent;
        release('z');
        press('-');
        press('z');
        const lower = readout.textContent;
        release('z');
        if (!/^[A-G]/.test(higher) || !/^[A-G]/.test(lower) || higher === lower) {
          failures.push(
            `the same key sounded "${lower}" and "${higher}" either side of an octave shift`
          );
        }

        // A MIDI instrument plays the same seam.
        if (midiMock.requested === 0) {
          failures.push('arming Play along never asked the browser for MIDI access');
        }
        await waitUntil(() => typeof midiMock.input.onmidimessage === 'function');
        if (typeof midiMock.input.onmidimessage !== 'function') {
          failures.push('MIDI access was granted but no input was ever listened to');
        } else {
          readout.textContent = '';
          midiMock.input.onmidimessage({ data: new Uint8Array([0x90, 67, 100]) });
          if (readout.textContent !== 'G4') {
            failures.push(`a MIDI note-on left the readout at "${readout.textContent}", not G4`);
          }
          midiMock.input.onmidimessage({ data: new Uint8Array([0x80, 67, 0]) });
        }

        // Capture: arm, play, write — and Undo becomes the way back. The
        // undoable flag comes from the ENGINE, so it going live is proof the
        // take actually reached a step lane.
        if (capture.disabled) {
          failures.push('Capture is disabled with the keyboard armed on a sequenced track');
        } else {
          capture.click();
          if (capture.getAttribute('aria-pressed') !== 'true') {
            failures.push('clicking Capture did not arm the recording');
          }
          for (const k of ['z', 'c', 'b']) {
            press(k);
            release(k);
          }
          capture.click();
          if (capture.getAttribute('aria-pressed') !== 'false') {
            failures.push('clicking Capture again did not stop the recording');
          }
          if (undo.disabled) {
            failures.push('a recorded take left Undo disabled — nothing was written to the lane');
          } else {
            undo.click();
            if (!undo.disabled) failures.push('Undo stayed live after undoing — it is one click, once');
          }
        }

        // Off again: the keys go quiet, and stay quiet.
        toggle.click();
        if (toggle.getAttribute('aria-pressed') !== 'false') {
          failures.push('clicking Play along again did not switch it off');
        }
        readout.textContent = '';
        press('z');
        release('z');
        if (readout.textContent !== '') {
          failures.push('a key press still sounded after Play along was switched off');
        }
      }
    }
  }

  // ---- v29 share names, sending end ----------------------------------------
  // Copying a link must show the link's three-word name: in the reserved line
  // under the Share row, in the share note, and as the suggested preset name
  // while the name box is still empty. The expected name is computed here from
  // the copied fragment, so a page that shows A name but not THE name fails.
  {
    const shareButton = doc.getElementById('preset-share');
    const nameValue = doc.getElementById('share-name-value');
    const nameBox = doc.getElementById('preset-name');
    const note = doc.getElementById('share-note');
    if (!shareButton || !nameValue || !nameBox || !note) {
      failures.push('the Share row has no #share-name-value read-out');
    } else {
      // Reserved space: the line is in the layout BEFORE any link exists, so
      // a name appearing cannot push the buttons above it.
      // (The Advanced panel itself is hidden while the Simple tab is up — the
      // gate is that the NAME LINE never hides inside its own row.)
      if (nameValue.hidden || nameValue.parentElement?.hidden) {
        failures.push('the link-name line is hidden before a share — it must hold its space');
      }
      if (!nameValue.textContent.trim()) {
        failures.push('the link-name line is empty before a share — it must hold its space');
      }
      nameBox.value = '';
      clipboard.text = '';
      shareButton.click();
      const copied = await waitUntil(() => clipboard.text.includes('#'));
      if (!copied) {
        failures.push('clicking Share copied nothing to the clipboard');
      } else {
        const fragment = clipboard.text.slice(clipboard.text.indexOf('#') + 1);
        const expected = shareNameModule.shareNameFor(fragment, SHARE_POOL);
        if (!/^[a-z]+-[a-z]+-[a-z]+$/.test(expected)) {
          failures.push(`the copied fragment produced no three-word name ("${expected}")`);
        }
        const shown = await waitUntil(() => nameValue.textContent.trim() === expected);
        if (!shown) {
          failures.push(
            `the Share row shows "${nameValue.textContent.trim()}" for a link named "${expected}"`
          );
        }
        if (!note.textContent.includes(expected)) {
          failures.push(`the share note does not name the link: "${note.textContent}"`);
        }
        if (nameBox.value !== expected) {
          failures.push(
            `Share left the empty preset name as "${nameBox.value}" instead of suggesting "${expected}"`
          );
        }
        // v0.0.186 — the share wire's version stamp, the plain half: a link
        // carrying nothing an older build would drop (no cable, no sampling,
        // no LFO or macro change, no essence re-ruling, no genre of the
        // person's own) is a schema-1 link every older build reads in full.
        // The state here is plain: every user genre and voice above was
        // forgotten and the rules reset before this block runs.
        {
          const plain = decodeCopiedLink();
          if (!plain) {
            failures.push('the plain Share link did not decode');
          } else {
            if (plain.v !== 1) failures.push(`a plain link is stamped schema ${JSON.stringify(plain.v)}, not 1 — an older build would refuse or misread a link it could have read in full`);
            if (plain.g !== undefined) failures.push('a plain link carries a genre it has no reason to');
          }
        }
        // Deterministic: the same settings, shared again, is the same name.
        clipboard.text = '';
        shareButton.click();
        const again = await waitUntil(() => clipboard.text.includes('#'));
        const secondName = again
          ? shareNameModule.shareNameFor(
              clipboard.text.slice(clipboard.text.indexOf('#') + 1),
              SHARE_POOL
            )
          : '';
        if (secondName !== expected) {
          failures.push(`sharing the same settings twice named "${expected}" then "${secondName}"`);
        }
        // A name the user has typed is theirs — Share must not overwrite it.
        nameBox.value = 'My own name';
        clipboard.text = '';
        shareButton.click();
        await waitUntil(() => clipboard.text.includes('#'));
        if (nameBox.value !== 'My own name') {
          failures.push(`Share overwrote a typed preset name with "${nameBox.value}"`);
        }
        nameBox.value = '';
      }
    }
  }

  // ---- v27 blank slate (fromMartin 25) --------------------------------------
  // Clicking Blank slate must leave every track OFF — the "all you" state.
  // Runs LAST: it rewrites the whole params object, so it must follow every
  // boot-state and fresh-visit-genre assertion.
  {
    const button = doc.getElementById('blank-slate');
    if (!button) {
      failures.push('the Advanced tab has no #blank-slate button');
    } else {
      button.click();
      const allOff = await waitUntil(
        () =>
          doc.querySelectorAll('.track-row').length > 0 &&
          doc.querySelectorAll('.track-row:not([data-track-state="off"])').length === 0
      );
      if (!allOff) {
        const on = doc.querySelectorAll('.track-row:not([data-track-state="off"])').length;
        failures.push(`after Blank slate, ${on} track(s) are still not off`);
      }
    }
  }

  // ---- v29 share names, receiving end --------------------------------------
  // A `#p=` link must announce itself by the SAME three words its sender saw.
  // Nothing in the first boot can show this — that page arrived with no
  // fragment — so this is a second, deliberately minimal boot of the same
  // bundle in a second jsdom, against a URL that carries a share link. It runs
  // LAST because it swaps the DOM globals the bundle reads.
  {
    const payload = Buffer.from(JSON.stringify({ bpm: 71, reverb: 0.42 }), 'utf8').toString(
      'base64url'
    );
    const expected = shareNameModule.shareNameFor(`p=${payload}`, SHARE_POOL);
    const arrivalDom = new JSDOM(html, {
      url: `https://ambi4.work/#p=${payload}`,
      pretendToBeVisual: true,
      runScripts: 'outside-only',
    });
    const arrivalWindow = arrivalDom.window;
    const arrivalContexts = new WeakMap();
    arrivalWindow.HTMLCanvasElement.prototype.getContext = function getContext() {
      let ctx = arrivalContexts.get(this);
      if (!ctx) {
        ctx = stubCanvasContext();
        ctx.canvas = this;
        arrivalContexts.set(this, ctx);
      }
      return ctx;
    };
    arrivalWindow.HTMLCanvasElement.prototype.toDataURL = () => 'data:,';
    arrivalWindow.AudioContext = StubAudioContext;
    arrivalWindow.OfflineAudioContext = undefined;
    arrivalWindow.devicePixelRatio = 1;
    installClipboard(arrivalWindow);
    for (const key of passthrough) {
      if (arrivalWindow[key] !== undefined) globalThis[key] = arrivalWindow[key];
    }
    globalThis.self = arrivalWindow;

    try {
      // The query is a cache-buster: Node caches an ES module by URL, and this
      // boot needs the page's top-level code to run again against the new DOM.
      await import(`${pathToFileURL(bundlePath).href}?share-arrival`);
      const arrivalDoc = arrivalWindow.document;
      const booted = await waitUntil(() => {
        const el = arrivalDoc.getElementById('generator-app');
        return Boolean(el) && !el.hidden;
      }, 8000);
      if (!booted) {
        failures.push('the page did not boot on a #p= share link');
      } else {
        const note = arrivalDoc.getElementById('share-note');
        const nameValue = arrivalDoc.getElementById('share-name-value');
        const nameBox = arrivalDoc.getElementById('preset-name');
        if (!note || note.hidden) {
          failures.push('a #p= link arrived without the shared-preset note');
        } else if (!note.textContent.includes(expected)) {
          failures.push(
            `an arriving link named "${expected}" announced itself as "${note.textContent}"`
          );
        }
        if (!nameValue || nameValue.textContent.trim() !== expected) {
          failures.push(
            `the Share row shows "${nameValue ? nameValue.textContent.trim() : '(missing)'}" ` +
              `for an arriving link named "${expected}"`
          );
        }
        if (!nameBox || nameBox.value !== expected) {
          failures.push(
            `an arriving link left the preset name as "${nameBox ? nameBox.value : '(missing)'}" ` +
              `instead of suggesting "${expected}"`
          );
        }
        if (arrivalWindow.location.hash) {
          failures.push('the share fragment was left in the URL after it was applied');
        }
      }
    } catch (err) {
      failures.push(`booting on a #p= share link threw: ${err && err.stack ? err.stack : err}`);
    }
  }

  // v0.0.182 (unit 8): a voice of the person's own survives a reload — the
  // storage format is what a fresh boot reads. Consent recorded, one voice
  // under prefs 'voices', and the pad picker lists it; picking it puts its
  // base and its patch at the engine.
  {
    const storedVoice = {
      id: 'v-reloadtest',
      name: 'Kept pad',
      voiceSet: 'pad',
      voice: 'strings',
      patch: { source: {}, filter: { type: 'lowpass', cutoff: 777, q: 0.8, envAmount: 0 }, adsr: {}, sends: {} },
    };
    const reloadDom = new JSDOM(html, {
      url: 'https://ambi4.work/',
      pretendToBeVisual: true,
      runScripts: 'outside-only',
    });
    const reloadWindow = reloadDom.window;
    const reloadContexts = new WeakMap();
    reloadWindow.HTMLCanvasElement.prototype.getContext = function getContext() {
      let ctx = reloadContexts.get(this);
      if (!ctx) {
        ctx = stubCanvasContext();
        ctx.canvas = this;
        reloadContexts.set(this, ctx);
      }
      return ctx;
    };
    reloadWindow.HTMLCanvasElement.prototype.toDataURL = () => 'data:,';
    reloadWindow.AudioContext = StubAudioContext;
    reloadWindow.OfflineAudioContext = undefined;
    reloadWindow.devicePixelRatio = 1;
    installClipboard(reloadWindow);
    for (const key of passthrough) {
      if (reloadWindow[key] !== undefined) globalThis[key] = reloadWindow[key];
    }
    globalThis.self = reloadWindow;
    // prefs reads the GLOBAL document.cookie and localStorage — the bundle's
    // view, whichever window the passthrough left in place — so the stored
    // voice and the consent record go where it will look, and on the window.
    for (const doc of new Set([reloadWindow.document, globalThis.document])) {
      if (doc) doc.cookie = 'ambi4-consent=granted';
    }
    for (const store of new Set([reloadWindow.localStorage, globalThis.localStorage])) {
      if (store && typeof store.setItem === 'function') store.setItem('ambi4:voices', JSON.stringify([storedVoice]));
    }
    try {
      await import(`${pathToFileURL(bundlePath).href}?reload-voice`);
      const reloadDoc = reloadWindow.document;
      const booted = await waitUntil(() => {
        const el = reloadDoc.getElementById('generator-app');
        return Boolean(el) && !el.hidden;
      }, 8000);
      if (!booted) {
        failures.push('the page did not boot with a stored voice of the person\'s own');
      } else {
        const select = reloadDoc.getElementById('track-voice-pad');
        const group = select && select.querySelector('optgroup.my-voices');
        const option = group && group.querySelector('option[value="mine:v-reloadtest"]');
        if (!option || option.textContent !== 'Kept pad') {
          const evidence = {
            cookie: reloadDoc.cookie,
            stored: reloadWindow.localStorage.getItem('ambi4:voices'),
            globalStored: (globalThis.localStorage && globalThis.localStorage.getItem('ambi4:voices')) || null,
            options: select ? Array.from(select.querySelectorAll('option')).map((o) => o.value) : null,
            groups: select ? Array.from(select.querySelectorAll('optgroup')).map((g) => g.label) : null,
          };
          failures.push(`a stored voice of the person's own is not listed under My voices after a reload: ${JSON.stringify(evidence)}`);
        } else {
          select.value = option.value;
          select.dispatchEvent(new reloadWindow.Event('change', { bubbles: true }));
          const reloadEngine = reloadWindow.__ambi4Engine;
          const played = await waitUntil(() => {
            const params = reloadEngine && reloadEngine.getParams();
            const patch = params && params.patches && params.patches.pad && params.patches.pad.strings;
            return params && params.tracks.pad.voice === 'strings' && patch && patch.filter && Math.round(patch.filter.cutoff) === 777;
          });
          if (!played) failures.push('picking a reloaded voice did not put its base and patch at the engine');
        }
      }
    } catch (err) {
      failures.push(`booting with a stored voice threw: ${err && err.stack ? err.stack : err}`);
    }
  }

  // v0.0.183 (unit 9): a link whose pad is tagged with a voice of someone's
  // own arrives on a device that has never seen it: the sound plays (voice
  // and patch, as any link), and the name joins this visit's My voices.
  {
    const payload = Buffer.from(JSON.stringify({
      tracks: {
        pad: { voice: 'strings', state: 'on', userVoice: { id: 'v-arrivedtest', name: 'Arrived pad' } },
        // v0.0.190 (review #2): a base that is no voice of the set is refused.
        melody: { voice: 'nope', userVoice: { id: 'v-badbase', name: 'Bad base' } },
      },
      patches: { pad: { strings: { filter: { type: 'lowpass', cutoff: 654, q: 0.8, envAmount: 0 } } } },
      v: 2,
    }), 'utf8').toString('base64url');
    const voiceDom = new JSDOM(html, {
      url: `https://ambi4.work/#p=${payload}`,
      pretendToBeVisual: true,
      runScripts: 'outside-only',
    });
    const voiceWindow = voiceDom.window;
    const voiceContexts = new WeakMap();
    voiceWindow.HTMLCanvasElement.prototype.getContext = function getContext() {
      let ctx = voiceContexts.get(this);
      if (!ctx) {
        ctx = stubCanvasContext();
        ctx.canvas = this;
        voiceContexts.set(this, ctx);
      }
      return ctx;
    };
    voiceWindow.HTMLCanvasElement.prototype.toDataURL = () => 'data:,';
    voiceWindow.AudioContext = StubAudioContext;
    voiceWindow.OfflineAudioContext = undefined;
    voiceWindow.devicePixelRatio = 1;
    installClipboard(voiceWindow);
    for (const key of passthrough) {
      if (voiceWindow[key] !== undefined) globalThis[key] = voiceWindow[key];
    }
    globalThis.self = voiceWindow;
    for (const d of new Set([voiceWindow.document, globalThis.document])) if (d) d.cookie = 'ambi4-consent=granted';
    try {
      await import(`${pathToFileURL(bundlePath).href}?arriving-voice`);
      const voiceDoc = voiceWindow.document;
      const booted = await waitUntil(() => {
        const el = voiceDoc.getElementById('generator-app');
        return Boolean(el) && !el.hidden;
      }, 8000);
      if (!booted) {
        failures.push('the page did not boot on a link naming a voice of someone\'s own');
      } else {
        const voiceEngine = voiceWindow.__ambi4Engine;
        const params = voiceEngine && voiceEngine.getParams();
        const patch = params && params.patches && params.patches.pad && params.patches.pad.strings;
        if (!params || params.tracks.pad.voice !== 'strings' || !patch || !patch.filter || Math.round(patch.filter.cutoff) !== 654) {
          failures.push('an arriving link\'s voice and patch did not reach the engine');
        }
        const select = voiceDoc.getElementById('track-voice-pad');
        const option = select && select.querySelector('optgroup.my-voices option[value="mine:v-arrivedtest"]');
        if (!option || option.textContent !== 'Arrived pad') {
          failures.push('a voice named in an arriving link is not listed under My voices for this visit');
        } else if (select.value !== option.value) {
          failures.push(`the arriving pad does not read as its named voice (reads ${select.value})`);
        }
        const melodyPicker = voiceDoc.getElementById('track-voice-melody');
        if (melodyPicker && melodyPicker.querySelector('option[value="mine:v-badbase"]')) {
          failures.push('a link naming a voice on a base that is no voice of the set was adopted anyway');
        }
        // v0.0.190 (review #1): an arrival is this visit's, not the device's.
        // Save a DIFFERENT voice of one's own on the melody: storage then holds
        // that one, and not the arrival nobody saved.
        const melodyToggle = voiceDoc.getElementById('voice-edit-toggle-melody');
        const melodyEditor = voiceDoc.getElementById('voice-editor-melody');
        if (melodyToggle && melodyEditor) {
          if (melodyEditor.hidden) melodyToggle.click();
          await waitUntil(() => !melodyEditor.hidden && melodyEditor.querySelector('.ve-save-voice'));
          const nameBox = melodyEditor.querySelector('.ve-voice-name');
          nameBox.value = 'Kept melody';
          melodyEditor.querySelector('.ve-save-voice').click();
          await new Promise((r) => setTimeout(r, 100));
          const stored = voiceWindow.localStorage.getItem('ambi4:voices') || (globalThis.localStorage && globalThis.localStorage.getItem('ambi4:voices')) || '';
          if (!stored.includes('Kept melody')) failures.push(`saving a voice after an arrival did not persist it (${stored.slice(0, 120)})`);
          if (stored.includes('v-arrivedtest')) failures.push('an arriving voice nobody saved was persisted when another voice was saved');
        }
      }
    } catch (err) {
      failures.push(`booting on a link naming a voice threw: ${err && err.stack ? err.stack : err}`);
    }
  }

  // v0.0.181 (unit 13): a link CARRYING a genre of someone's own arrives on a
  // device that has never seen it. The base rebuilds from the carried genre
  // (tempo 200, pad Off are its rules), the engine is tagged with it, and it
  // sits under My genres for this visit.
  {
    const synthwave = JSON.parse(readFileSync(join(repoRoot, 'src/data/genres/synthwave.json'), 'utf8'));
    const carried = structuredClone(synthwave);
    carried.slug = 'u-carriedtest';
    carried.name = 'Carried';
    carried.madeFrom = 'synthwave';
    carried.essence.bpm = [200, 200];
    carried.essence.instrumentation.perTrack.pad.state = 'off';
    const payload = Buffer.from(JSON.stringify({
      o: { kind: 'genre', id: 'u-carriedtest', seed: 11 },
      d: {},
      g: carried,
      v: 2,
    }), 'utf8').toString('base64url');
    const carryDom = new JSDOM(html, {
      url: `https://ambi4.work/#p=${payload}`,
      pretendToBeVisual: true,
      runScripts: 'outside-only',
    });
    const carryWindow = carryDom.window;
    const carryContexts = new WeakMap();
    carryWindow.HTMLCanvasElement.prototype.getContext = function getContext() {
      let ctx = carryContexts.get(this);
      if (!ctx) {
        ctx = stubCanvasContext();
        ctx.canvas = this;
        carryContexts.set(this, ctx);
      }
      return ctx;
    };
    carryWindow.HTMLCanvasElement.prototype.toDataURL = () => 'data:,';
    carryWindow.AudioContext = StubAudioContext;
    carryWindow.OfflineAudioContext = undefined;
    carryWindow.devicePixelRatio = 1;
    installClipboard(carryWindow);
    for (const key of passthrough) {
      if (carryWindow[key] !== undefined) globalThis[key] = carryWindow[key];
    }
    globalThis.self = carryWindow;
    try {
      await import(`${pathToFileURL(bundlePath).href}?carried-genre`);
      const carryDoc = carryWindow.document;
      const booted = await waitUntil(() => {
        const el = carryDoc.getElementById('generator-app');
        return Boolean(el) && !el.hidden;
      }, 8000);
      if (!booted) {
        failures.push('the page did not boot on a link carrying a genre');
      } else {
        const carryEngine = carryWindow.__ambi4Engine;
        const params = carryEngine && carryEngine.getParams();
        if (!params || params.genre !== 'u-carriedtest') failures.push(`a carried genre did not tag the setup (genre ${JSON.stringify(params && params.genre)})`);
        if (!params || params.bpm !== 200) failures.push(`a carried genre's ruled tempo did not rebuild the base (bpm ${params && params.bpm})`);
        if (!params || !params.tracks || !params.tracks.pad || params.tracks.pad.state !== 'off') failures.push('a carried genre\'s ruled pad Off did not rebuild the base');
        const group = Array.from(carryDoc.querySelectorAll('#genre-select optgroup')).find((g) => g.label === 'My genres');
        const entry = group && group.querySelector('option[value="g:u-carriedtest"]');
        if (!entry || entry.textContent !== 'Carried') failures.push('a carried genre is not listed under My genres for this visit');
      }
    } catch (err) {
      failures.push(`booting on a link carrying a genre threw: ${err && err.stack ? err.stack : err}`);
    }
  }

} catch (err) {
  failures.push(`importing the built page script threw: ${err && err.stack ? err.stack : err}`);
}

console.error = realConsoleError;


if (failures.length) {
  console.log('\npage-boot FAILED');
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}

const cardCount = window.document.querySelectorAll('#factory-preset-row .factory-preset').length;
console.log(
  `page-boot ok — #generator-app unhid in ${bootMs} ms, ${cardCount} factory presets below the Simple dials (${scriptMatch[1]})`
);
window.close();
process.exit(0);
