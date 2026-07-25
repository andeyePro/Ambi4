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
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';

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
window.devicePixelRatio = 1;

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
  if (window[key] !== undefined) globalThis[key] = window[key];
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
    const padProbe = probeTracks({ pad: { padBreath: 0.4 } });
    const engineTakesPadBreath = Boolean(padProbe && padProbe.pad && padProbe.pad.padBreath === 0.4);
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
    if (!header || !header.querySelector('.mono-toggle')) {
      failures.push('the texture editor header has no Mono toggle');
    }
    if (!header || !header.querySelector('.glide-knob, .glide-slider')) {
      failures.push('the texture editor header has no Glide control');
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
      const drewN = await waitUntil(() => traceColorCount(frontCanvas.getContext('2d')) === activeTracks);
      if (!drewN) {
        const got = traceColorCount(frontCanvas.getContext('2d'));
        failures.push(
          `the stopped-engine front oscilloscope should draw ${activeTracks} static traces ` +
            `(one per non-off track), drew ${got}`
        );
      }
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
