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

/** A 2d context whose every method is a no-op — jsdom ships none at all. */
function stubCanvasContext() {
  const noop = () => {};
  return {
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
    moveTo: noop,
    lineTo: noop,
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

window.HTMLCanvasElement.prototype.getContext = function getContext() {
  const ctx = stubCanvasContext();
  ctx.canvas = this;
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
} catch (err) {
  failures.push(`importing the built page script threw: ${err && err.stack ? err.stack : err}`);
}

console.error = realConsoleError;

if (failures.length) {
  console.log('\npage-boot FAILED');
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}

console.log(`page-boot ok — #generator-app unhid in ${bootMs} ms (${scriptMatch[1]})`);
window.close();
process.exit(0);
