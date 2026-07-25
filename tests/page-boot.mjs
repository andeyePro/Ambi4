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
    const word = doc.getElementById('front-scope-word');
    const toggle = doc.getElementById('front-scope-toggle');
    if (!toggle || !toggle.hasAttribute('aria-expanded')) {
      failures.push('the oscilloscope has no collapse twisty (#front-scope-toggle)');
    } else if (toggle.getAttribute('aria-expanded') === 'true' && word && !word.hidden) {
      failures.push('the word "Oscilloscope" shows while the scope is expanded');
    }
    if (!scopeModule.hidden) {
      const legendKeys = doc.querySelectorAll('#front-scope-legend .scope-legend-track');
      if (!legendKeys.length) failures.push('the oscilloscope legend rendered no track keys');
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
