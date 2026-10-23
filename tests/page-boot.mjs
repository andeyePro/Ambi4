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
import { registerHooks } from 'node:module';
import { spawnSync } from 'node:child_process';
import { readTutorialSteps, resolveTutorialTargets, readLessonChapters, readRuleChapters } from './tutorial-smoke.mjs';

// --------------------------------------------------------------------------
// Memory: a heap ceiling, so garbage is collected rather than banked
// --------------------------------------------------------------------------
// What this harness keeps ALIVE is a few hundred MB (six booted pages). What it
// ALLOCATES is far more — every editor is rebuilt hundreds of times — and on
// an 8 GB machine V8's default old-space ceiling (~4 GB) lets that garbage
// pile up to 2.5 GB+ before a full collection bothers: two concurrent runs
// were OOM-killed (exit 137) that way (2026-10-23). So the gate re-runs itself
// once under an explicit ceiling. Live data peaks at about half of it; a
// change that truly needs more fails loudly as an out-of-memory crash, which
// is a finding, not a flake. PAGE_BOOT_HEAP_MB overrides the ceiling; passing
// your own --max-old-space-size runs in-process as given.
const HEAP_FLAG = '--max-old-space-size';
if (!process.execArgv.some((arg) => arg.startsWith(HEAP_FLAG))) {
  const heapMb = Number(process.env.PAGE_BOOT_HEAP_MB) || 1280;
  const child = spawnSync(
    process.execPath,
    [`${HEAP_FLAG}=${heapMb}`, ...process.execArgv, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: 'inherit' }
  );
  if (child.error) throw child.error;
  if (child.signal) console.error(`page-boot: the run was killed by ${child.signal}`);
  process.exit(child.status === null ? 1 : child.status);
}

// --------------------------------------------------------------------------
// Memory: jsdom's selector engine keeps garbage alive
// --------------------------------------------------------------------------
// nwsapi (under jsdom's querySelector) caches a compiled resolver per selector
// string, and with it the RESULT ARRAY and context of the first query that
// compiled it — never refreshed, never dropped. In this harness, where every
// editor is rebuilt dozens of times, each cached selector pins the detached
// editor its first answer lived in, and every closure that editor's listeners
// hold. That cache alone was a large share of a ~3.5 GB heap (2026-10-23).
// The cache changes no answer (a hit recomputes the nodes), so dropping it is
// free: every nwsapi instance is remembered here, and dropSelectorCaches()
// asks each to clear itself through nwsapi's own configure(option, clear).
// The factory is wrapped by a load hook BEFORE jsdom loads (hence jsdom's
// dynamic import below); a newer nwsapi whose source no longer matches is
// simply left alone — the gate then runs as it did, only heavier.
const NWSAPI_KEY = Symbol.for('ambi4.pageBoot.nwsapiInstances');
const nwsapiInstances = [];
globalThis[NWSAPI_KEY] = nwsapiInstances;
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (!url.endsWith('/@asamuzakjp/nwsapi/src/nwsapi.js')) return loaded;
    const source = String(loaded.source);
    const hook = 'module.exports = factory;';
    if (!source.includes(hook)) return loaded;
    return {
      ...loaded,
      source: source.replace(
        hook,
        'module.exports = function nwsapiTracked() { const dom = factory.apply(this, arguments); ' +
          "globalThis[Symbol.for('ambi4.pageBoot.nwsapiInstances')].push(new WeakRef(dom)); return dom; };"
      ),
    };
  },
});
function dropSelectorCaches() {
  for (let i = nwsapiInstances.length - 1; i >= 0; i--) {
    const instance = nwsapiInstances[i].deref();
    if (!instance) nwsapiInstances.splice(i, 1);
    else instance.configure({}, true);
  }
}
// Between blocks is not often enough (one block rebuilds editors hundreds of
// times), and a query is synchronous, so this timer can never land inside one.
setInterval(dropSelectorCaches, 1000).unref();
const { JSDOM } = await import('jsdom');

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

/**
 * TODO step 2, the leave-guard: leaving an edited voice through the UI (a
 * pick, closing its editor, Next, a genre) now asks first. The blocks below
 * that predate it edit a voice and move on without cleaning up — the step-1
 * behaviour, which the guard's Move on keeps (go ahead, park the edit under
 * Edited). So every window answers Move on by itself, unless a block that
 * tests the guard sets `win.__leaveGuardManual = true` and answers it by hand.
 */
function answerLeaveGuardWithMoveOn(win) {
  const observer = new win.MutationObserver(() => {
    if (win.__leaveGuardManual) return;
    const move = win.document.querySelector('#leave-guard .leave-guard-move');
    if (move) move.click();
  });
  observer.observe(win.document.body || win.document.documentElement, { childList: true, subtree: false });
}
answerLeaveGuardWithMoveOn(window);

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

/**
 * v0.0.193: the UNIT a readout is printed in — the format a loop derives —
 * without the value, which is state (the genre a fresh boot draws sets the
 * patches). Milliseconds fold into seconds because the seconds format picks
 * between them by value.
 */
function readoutUnit(text) {
  if (typeof text !== 'string') return null;
  const m = /(Hz|oct|ct|st|ms|s|%|×)(?=[\s,)]|$)/.exec(text);
  if (!m) return '';
  return m[1] === 'ms' ? 's' : m[1];
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
/**
 * Point the bundle's globals at `win`. Every bundle imported here reads
 * `document`, `window`, `localStorage`... off THIS realm at the moment it
 * runs, so the last window adopted is the one EVERY bundle sees — the main
 * page's own listeners included. The second boots near the end each adopt
 * their own window and never hand it back, so after them a click on the
 * main page runs its handler against the last second boot's document: Edit
 * "stops opening" (it opens that page's editor) with no error. A main-page
 * section placed after them must adopt `window` again first (2026-10-23).
 */
function adoptGlobals(win) {
  for (const key of passthrough) {
    // Node 21+ ships getter-only globals (navigator); plain assignment throws.
    if (win[key] !== undefined) {
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: win[key] });
    }
  }
  globalThis.self = win;
}
adoptGlobals(window);

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

// Every self-contained section below is `await (async () => { ... })();`
// rather than a bare `{ ... }` block (2026-10-23). This module's body is one
// long async function, and V8 keeps a suspended function's registers — every
// block-scoped const it has ever held — alive until the function ends: an
// element a finished section looked at stays reachable, and with it the whole
// detached editor it lived in. A section's own function frees them when it
// returns. Nothing else changes: the sections still run in order, one at a
// time, against the same shared state.
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
  await (async () => {
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
  })();

  // v21 track-registry gate: the page holds no track list of its own. Every
  // row it renders — count, order and label — comes from the engine's
  // getTracks(), so a registry the page has drifted from shows up here as a
  // row that is missing, extra, out of order or wrongly named.
  await (async () => {
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
  })();

  // Fallback proof: an engine bundle without getTracks() boots the page on its
  // one remaining hardcoded table, FALLBACK_TRACKS. A fallback that has
  // drifted from the registry is a fallback that boots the WRONG tracks, and
  // nothing else in this harness would ever exercise it — so the table is read
  // out of the page source and matched against the live registry 1:1: ids,
  // order, labels, families, and both of the sets derived from it.
  await (async () => {
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
  })();

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
  await (async () => {
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
  })();

  // Guided tour: every step rings a control, and a step whose selector matches
  // nothing walks the newcomer past a blank. tests/tutorial-smoke.mjs holds the
  // whole rule set against the built MARKUP; this is the half only a booted
  // page can prove — the targets the page script builds itself (Add track)
  // exist, and exactly once, in the document the visitor actually gets.
  await (async () => {
    const steps = readTutorialSteps();
    failures.push(...resolveTutorialTargets(steps, doc));
    for (const [index, step] of steps.entries()) {
      if (!step.tab) continue;
      if (!doc.getElementById(`tab-${step.tab}`)) {
        failures.push(`tutorial step ${index + 1} switches to a tab the page has not got: "${step.tab}"`);
      }
    }
  })();

  // v26 Advanced layout rule: dials pack HORIZONTALLY. Repetition, Swing and
  // Reverb tail share the main-dial row rather than sitting on lines of their
  // own — a regression here reads to the user as "dials scattered at random".
  await (async () => {
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
  })();

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
  /** Type `text` into a knob cell's readout and press Enter — the same
   *  click-to-type path a person uses. False if the knob has no readout. */
  function typeIntoKnob(cell, text) {
    const readout = cell && cell.querySelector('.knob-value');
    if (!readout) return false;
    readout.click();
    const edit = cell.querySelector('.knob-value-edit');
    if (!edit) return false;
    edit.value = String(text);
    edit.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  }
  // v0.0.245: Save as WAV. The button sits in the transport row beside
  // Record, hidden before launch like Record (the pricing ruling puts wav in
  // Plus). This harness is the browser with nothing to tap — no AudioWorklet,
  // no ScriptProcessor, no OfflineAudioContext, no MediaRecorder, and the
  // engine never played — so pressing it must say so in its status line, not
  // throw and not sit pressed recording nothing.
  {
    const wav = doc.getElementById('wav-save');
    const status = doc.getElementById('wav-status');
    if (!wav || !status) {
      failures.push('the transport row has no Save as WAV button (#wav-save) and status line (#wav-status)');
    } else {
      if (!/Save as WAV/.test(wav.textContent)) failures.push(`the WAV button reads ${JSON.stringify(wav.textContent.trim())}`);
      if (wav.closest('.transport-buttons') !== doc.getElementById('record-toggle').closest('.transport-buttons')) failures.push('Save as WAV is not beside Record');
      if (!wav.hidden) failures.push('Save as WAV shows before launch, but wav recording is a Plus feature');
      if (status.textContent !== '') failures.push(`the WAV status line speaks before anyone pressed it: ${JSON.stringify(status.textContent)}`);
      wav.click();
      const said = await waitUntil(() => /cannot hand raw audio to the page \(it has neither AudioWorklet nor ScriptProcessor\), so Save as WAV is unavailable here/.test(status.textContent));
      if (!said) failures.push(`with nothing to tap, Save as WAV said ${JSON.stringify(status.textContent)}`);
      if (wav.getAttribute('aria-pressed') !== 'false') failures.push('Save as WAV was left pressed with nothing recording');
    }
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
  await (async () => {
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
  })();

  // 2026-10-23 — every dial that DRAWS a range hands the engine a range.
  // A dial that takes the sideways gesture (data-spread="yes") and then reads
  // "drifting" must have left a {min, max} in the engine's params — CLAUDE.md:
  // assert the ENGINE's stored value, not just the readout. Groove chance drew
  // a span and stored NaN (sanitised to Auto); Motif chance drew one and
  // stored its middle. This is the generic form, so the next dial that does it
  // is caught the day it lands: every spreadable dial on the page, spread with
  // Shift+ArrowRight (the keyboard's sideways drag, which reaches the same
  // applySpread as the pointer), the engine's params diffed before and after.
  // The genre-rules dials are a model that lands on Apply, so they are spread
  // together, applied once, and read back from the share link's genreRules.
  // It moves every dial on the page and resets each with Backspace.
  await (async () => {
    const engine = window.__ambi4Engine;
    const LOG = process.env.PAGE_BOOT_RANGE_LOG === '1';
    const isSpan = (v) => (v && typeof v === 'object' && !Array.isArray(v)
      && Number.isFinite(v.min) && Number.isFinite(v.max) && v.min < v.max)
      || (Array.isArray(v) && v.length === 2 && Number.isFinite(v[0]) && Number.isFinite(v[1]) && v[0] < v[1]);
    const holdsSpan = (v) => isSpan(v) || Boolean(v && typeof v === 'object' && Object.values(v).some(holdsSpan));
    // Every path whose value differs, with the value after.
    const diffPaths = (a, b, path = '', out = []) => {
      if (Object.is(a, b)) return out;
      const objA = a && typeof a === 'object';
      const objB = b && typeof b === 'object';
      if (!objA || !objB || Array.isArray(a) !== Array.isArray(b) || isSpan(b)) {
        if (JSON.stringify(a) !== JSON.stringify(b)) out.push([path, b]);
        return out;
      }
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffPaths(a[k], b[k], `${path}.${k}`, out);
      return out;
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const spreadKeys = (knob) => {
      // Several presses: one keyboard step on a fine dial (Tempo's 0.001) is
      // narrower than the engine's own rounding, which is not the fault here.
      for (let i = 0; i < 8; i += 1) {
        knob.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }));
      }
    };
    const drewSpan = (knob) => (knob.getAttribute('aria-valuetext') || '').includes('drifting');
    // A stable name per dial, so an editor rebuilt by an edit (new nodes) is
    // not swept twice and a dial skipped as detached is never silent.
    const listDials = () => {
      const all = [...doc.querySelectorAll('.knob[data-spread="yes"]')];
      const count = new Map();
      return all.map((knob) => {
        const where = knob.closest('[id]')?.id || '?';
        const label = knob.getAttribute('aria-label') || '?';
        const base = `${where} | ${label}`;
        const n = (count.get(base) || 0) + 1;
        count.set(base, n);
        return { knob, where, label, key: `${base} #${n}`, rules: Boolean(knob.closest('#genre-rules')) };
      });
    };
    if (!engine || typeof engine.getParams !== 'function') {
      failures.push('range sweep: no engine seam to check the spreadable dials against');
      return;
    }
    // Two things outside the dial decide where its spread lands, and both
    // made this sweep red about half the time on Reverb tail (2026-10-23):
    // the RANDOM genre draw sets the tail (Synthwave 2.8 s, Cinematic 5 s),
    // and the power governor caps the tail the engine is sent (Low 2 s, Full
    // 4 s; jsdom's Auto sits at Low). A 2.8 s tail spread to 2-3.6 s reached
    // the engine as {min:2, max:2} — the governor's documented clip, not a
    // dial dropping its range. So the sweep pins the Processor to Full and
    // starts every dial from its own default (Backspace), not from the draw.
    const gov = window.__ambi4Governor;
    const priorTier = gov && typeof gov.getTier === 'function' ? gov.getTier() : null;
    if (priorTier) gov.setTier('full');
    const seen = new Set();
    let drew = 0;
    async function sweepVisible() {
      for (let guard = 0; guard < 1000; guard += 1) {
        const next = listDials().find((d) => !d.rules && !seen.has(d.key));
        if (!next) return;
        seen.add(next.key);
        const { knob, where, label } = next;
        knob.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
        await sleep(140);
        if (!knob.isConnected) continue;
        // The Processor dial is swept too, and its Backspace is Auto: pin
        // Full again for every other dial, whatever came before it.
        if (priorTier && where !== 'processor-dial') gov.setTier('full');
        const before = engine.getParams();
        spreadKeys(knob);
        if (!drewSpan(knob)) {
          if (LOG) console.log(`range sweep: ${next.key} drew no span`);
        } else {
          drew += 1;
          // Some commits are debounced (Complexity, Energy: 120 ms).
          let changed = [];
          await waitUntil(() => {
            changed = diffPaths(before, engine.getParams());
            return changed.some(([, v]) => holdsSpan(v));
          }, 500);
          const spanned = changed.filter(([, v]) => holdsSpan(v));
          if (LOG) console.log(`range sweep: ${next.key} -> ${spanned.map(([p]) => p).join(', ') || JSON.stringify(changed).slice(0, 200)} [tier ${window.__ambi4Governor?.getAuto?.()}, ${knob.getAttribute('aria-valuetext')}]`);
          if (!spanned.length) {
            failures.push(`${label} (${where}) draws a range the engine never receives: after a spread the engine changed ${changed.length ? JSON.stringify(changed).slice(0, 200) : 'nothing'}`);
          }
        }
        // Put it back as a person would (Backspace resets to the default), and
        // let a debounced commit land before the next dial's snapshot.
        if (knob.isConnected) knob.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
        await sleep(140);
      }
    }
    await sweepVisible();
    // Then each track's editor in turn: opening one may tear another down, so
    // an editor's dials are swept while it is the one open.
    for (const track of REGISTRY_IDS) {
      const editor = doc.getElementById(`voice-editor-${track}`);
      if (!editor || editor.hidden) doc.getElementById(`voice-edit-toggle-${track}`)?.click();
      const open = await waitUntil(() => {
        const el = doc.getElementById(`voice-editor-${track}`);
        return Boolean(el && !el.hidden && el.querySelector('.knob'));
      });
      if (!open) {
        const el = doc.getElementById(`voice-editor-${track}`);
        const tg = doc.getElementById(`voice-edit-toggle-${track}`);
        failures.push(`range sweep: the ${track} editor did not open (editor ${el ? (el.hidden ? 'hidden' : 'shown') : 'missing'}, ${el ? el.querySelectorAll('.knob').length : 0} dials, toggle ${tg ? (tg.hidden ? 'hidden' : tg.getAttribute('aria-expanded')) : 'missing'})`);
      }
      await sweepVisible();
    }
    if (priorTier) gov.setTier(priorTier);
    if (LOG) console.log(`range sweep: ${seen.size} spreadable dials, ${drew} drew a span`);
    if (drew < 100) failures.push(`range sweep: only ${drew} of ${seen.size} spreadable dials drew a span under Shift+ArrowRight — the sweep lost its dials`);
    for (const must of ['Groove chance', 'Motif chance', 'Volume', 'Tempo']) {
      if (![...seen].some((key) => key.includes(`| ${must} #`))) {
        // A dial made single-valued leaves the sweep: say so only if it still
        // claims the gesture somewhere.
        const still = [...doc.querySelectorAll('.knob')].some((k) => k.getAttribute('aria-label') === must && k.dataset.spread === 'yes');
        if (still) failures.push(`range sweep: ${must} takes the gesture but was never swept`);
      }
    }

    // The genre rules: spread every one, Apply once, read the link's genreRules.
    const genreSelect = doc.getElementById('genre-select');
    const toggle = doc.getElementById('genre-rules-toggle');
    const panel = doc.getElementById('genre-rules');
    if (!genreSelect || !toggle || !panel) {
      failures.push('range sweep: no genre rules panel to sweep');
      return;
    }
    genreSelect.value = 'g:synthwave';
    genreSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
    await waitUntil(() => engine.getParams().genre === 'synthwave');
    await waitUntil(() => !toggle.hidden);
    if (panel.hidden) toggle.click();
    await waitUntil(() => !panel.hidden);
    const ruled = [];
    for (const d of listDials().filter((x) => x.rules)) {
      spreadKeys(d.knob);
      const field = d.knob.closest('.rules-dial')?.dataset.field || '';
      if (drewSpan(d.knob)) ruled.push({ ...d, field });
    }
    if (ruled.length < 10) failures.push(`range sweep: only ${ruled.length} genre-rules dials drew a span`);
    doc.getElementById('genre-rules-apply').click();
    await sleep(150);
    const share = doc.getElementById('preset-share');
    clipboard.text = '';
    share?.click();
    await waitUntil(() => clipboard.text.includes('#p='));
    const link = decodeCopiedLink();
    const rules = link && ((link.d && link.d.genreRules) || link.genreRules);
    for (const d of ruled) {
      const path = d.field.replace(/^essence\./, '').split('.');
      const got = path.reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), rules);
      if (LOG) console.log(`range sweep: rules ${d.field} -> ${JSON.stringify(got)}`);
      if (!isSpan(got)) failures.push(`${d.label} (${d.field}) draws a range Apply never hands on: the applied rules hold ${JSON.stringify(got)}`);
    }
    const reset = doc.getElementById('genre-rules-reset');
    if (reset && !reset.hidden) reset.click();
    if (!panel.hidden) toggle.click();
  })();

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
  await (async () => {
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
  })();

  // Per-step note length: the third axis on a melodic lane, keyboard path.
  await (async () => {
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
  })();

  // v0.0.246 — the grid says WHY: a lit step's tooltip and aria-label carry
  // the note's role AND its source/development in plain words. Driven through
  // the open editor's noteChosen exactly as the engine's 'note' wiring does.
  {
    const wordsMod = await import(pathToFileURL(join(repoRoot, 'src/scripts/note-words.js')).href);
    for (const [track, values] of Object.entries(engineModule.NOTE_SOURCES)) {
      for (const value of values) {
        if (!wordsMod.SOURCE_WORDS[value]) failures.push(`NOTE_SOURCES.${track} has "${value}" but SOURCE_WORDS has no words for it`);
      }
    }
    const whyEditor = await openEditor('melody');
    const seq = window.__ambi4Editors && window.__ambi4Editors.get('melody') && window.__ambi4Editors.get('melody').seq;
    if (!seq || typeof seq.noteChosen !== 'function') {
      failures.push('the open melody editor exposes no seq.noteChosen to drive');
    } else {
      seq.noteChosen(0, null, 9001, 64, 'third', 'motif', 'transpose');
      seq.noteChosen(1, null, 9001, 43, 'root', 'approach', null);
      const cells = whyEditor.querySelectorAll('.seq-cell');
      const first = cells[0];
      const second = cells[1];
      const need = (cell, label, parts) => {
        for (const text of [cell.title, cell.getAttribute('aria-label') || '']) {
          for (const part of parts) {
            if (!text.includes(part)) failures.push(`${label} should say "${part}" but reads: ${text}`);
          }
        }
      };
      need(first, 'a motif note on step 1', ['its third', 'from the motif', 'transposed']);
      need(second, 'an approach note on step 2', ['the chord\u2019s root', 'leaning into the next chord']);
    }
  }

  // Kit lanes: the list renders HIGH kinds at the top, "Add lane" copies the
  // pattern of the lane it lands beside, the name is click-to-type, and the
  // built-ins keep their remove-proof status.
  await (async () => {
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
  })();

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
  await (async () => {
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
  })();

  // Chord length select (harmony.rhythm), near Structure on the Advanced tab.
  await (async () => {
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
  })();

  // Pad breath depth knob — pad's own editor only, never another track's.
  await (async () => {
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
  })();

  // v0.0.254 — opt-in saturation: a Drive dial on the master (Advanced →
  // Sound, behind its "more") and in every track editor's feel row. Typed in
  // through the readout as a person would, and asserted at the ENGINE — a
  // dial drawing a value the engine never received is the failure this
  // house has hit twice.
  {
    const engine = window.__ambi4Engine;
    const takesDrive = (() => {
      try {
        const probed = sanitise({ drive: 0.5 });
        return Boolean(probed && probed.drive === 0.5);
      } catch {
        return false;
      }
    })();
    const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-9;
    const master = doc.getElementById('dial-drive');
    if (!takesDrive) {
      failures.push('the engine sanitiser drops a master drive');
    } else if (!engine) {
      failures.push('no engine seam to check the Drive dials against');
    } else if (!master || master.hidden) {
      failures.push('the master Drive dial (#dial-drive) is missing or hidden');
    } else {
      if (!doc.getElementById('adv-more-box-sound')?.contains(master)) {
        failures.push('the master Drive dial is not behind the Sound "more"');
      }
      const cell = doc.getElementById('drive-dial');
      if (!typeIntoKnob(cell, '40')) {
        failures.push('the master Drive dial has no typable readout');
      } else {
        if (!near(engine.getParams().drive, 0.4)) {
          failures.push(`master Drive typed 40% but the engine holds ${JSON.stringify(engine.getParams().drive)}`);
        }
        typeIntoKnob(cell, '0');
        if ('drive' in engine.getParams()) failures.push('master Drive back at 0 left a drive stored in the engine');
      }
      for (const track of ['pad', 'bass']) {
        const editor = await openEditor(track);
        const has = await waitUntil(() => !!editor.querySelector(`.drive-knob, #drive-${track}`));
        if (!has) {
          failures.push(`the ${track} editor has no Drive dial`);
          continue;
        }
        const knob = editor.querySelector('.drive-knob');
        if (!knob) continue;
        if (!typeIntoKnob(knob, '30')) {
          failures.push(`the ${track} Drive dial has no typable readout`);
          continue;
        }
        const got = engine.getParams().tracks[track]?.drive;
        if (!near(got, 0.3)) failures.push(`${track} Drive typed 30% but the engine holds ${JSON.stringify(got)}`);
        for (const other of ['pad', 'bass', 'melody'].filter((t) => t !== track)) {
          if ('drive' in (engine.getParams().tracks[other] || {})) failures.push(`${track}'s Drive leaked onto ${other}`);
        }
        typeIntoKnob(knob, '0');
        if ('drive' in (engine.getParams().tracks[track] || {})) failures.push(`${track} Drive back at 0 left a drive stored`);
      }
    }
  }

  // The contract's single-valued numeric dials SAY why a spread gesture does
  // nothing (CLAUDE.md: never refuse in silence). Loop chance refused
  // silently until the v0.0.266 browser sweep named it; this holds the line
  // without the Mac, through the keyboard spread (Shift+Arrow), which reaches
  // the same onRangeRefused as the pointer drag.
  {
    const line = doc.getElementById('dial-confirm');
    // 2026-10-23: Drift rate, the kit's rule Chance, the four arp dials
    // and a block's intensity refused in silence too. Each label is matched
    // exactly, except the block dials, which carry their block's number.
    const want = [
      ['Loop chance', /already a chance/],
      ['Drive', /pump the tone/],
      ['Drift rate', /pace every other/],
      ['Chance', /already a chance/],
      ['Octaves', /span of the figure/],
      ['Gate', /articulation of the figure/],
      ['Phase', /back in unison/],
      ['Additive', /build-up IS the movement/],
      [/^Block \d+ intensity$/, /blocks themselves/],
      // 2026-10-23: three that DREW a span the engine never received (the
      // range sweep above): each lives in one track's editor, opened first.
      ['Breath', /swell the pad already makes/, 'pad'],
      ['Groove chance', /already a chance/, 'bass'],
      ['Motif chance', /already a chance/, 'melody'],
    ];
    // The block dials exist only while a block structure shows its blocks:
    // pick ABAB (a block preset, shown since v0.0.202) and put it back after.
    const structureSel = doc.getElementById('structure');
    const structureWas = structureSel ? structureSel.value : null;
    if (structureSel && [...structureSel.options].some((o) => o.value === 'abab')) {
      structureSel.value = 'abab';
      structureSel.dispatchEvent(new window.Event('change', { bubbles: true }));
    }
    for (const [label, words, track] of want) {
      const named = (k) => (typeof label === 'string' ? k.getAttribute('aria-label') === label : label.test(k.getAttribute('aria-label') || ''));
      if (track) {
        const editor = doc.getElementById(`voice-editor-${track}`);
        if (!editor || editor.hidden) doc.getElementById(`voice-edit-toggle-${track}`)?.click();
        await waitUntil(() => [...(doc.getElementById(`voice-editor-${track}`)?.querySelectorAll('.knob') || [])].some(named));
      }
      const scope = track ? doc.getElementById(`voice-editor-${track}`) || doc : doc;
      const knobs = [...scope.querySelectorAll('.knob')].filter(named);
      if (!knobs.length) {
        failures.push(`single-valued dials: no ${label} dial to test`);
        continue;
      }
      for (const knob of knobs) {
        if (line) line.textContent = '';
        knob.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }));
        const said = line ? line.textContent : '';
        if (!words.test(said)) {
          failures.push(`${label} (${knob.closest('[id]')?.id || '?'}) refuses a spread in silence: the line under the dials read ${JSON.stringify(said)}`);
        }
        if (knob.getAttribute('aria-valuetext')?.includes('drifting')) failures.push(`${label} opened a span it should refuse`);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    if (structureSel && structureWas !== null && structureSel.value !== structureWas) {
      structureSel.value = structureWas;
      structureSel.dispatchEvent(new window.Event('change', { bubbles: true }));
    }
    if (line) line.textContent = '';
  }

  // v0.0.219 — UI review fixes 15, 16, 17.
  // 16: the scope legend solos on Alt/Option-click and on a press-and-hold,
  // not only a double-click. The legend is drawn from the page's
  // settings.ui.scopeTracks (selectedTracks), so aria-pressed is that state.
  await (async () => {
    const keys = [...doc.querySelectorAll('#front-scope-legend .scope-legend-track')]
      .filter((b) => b.id !== 'front-scope-total');
    const pressed = () => keys.filter((b) => b.getAttribute('aria-pressed') === 'true').length;
    if (keys.length < 3) {
      failures.push('legend solo: fewer than three legend keys to test with');
    } else {
      const target = keys[1];
      const startPressed = pressed();
      // Alt-click: immediate, no double-click window.
      target.dispatchEvent(new window.MouseEvent('click', { bubbles: true, altKey: true }));
      if (!(await waitUntil(() => pressed() === 1 && target.getAttribute('aria-pressed') === 'true', 400))) {
        failures.push(`legend solo: Alt-click did not solo the key (pressed ${pressed()} of ${startPressed})`);
      }
      // Restore all keys, then a long-press on a different key.
      for (const k of keys) {
        if (k.getAttribute('aria-pressed') !== 'true') {
          k.click();
          await new Promise((r) => setTimeout(r, 330));
        }
      }
      const held = keys[2];
      held.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
      await new Promise((r) => setTimeout(r, 650));
      held.dispatchEvent(new window.MouseEvent('pointerup', { bubbles: true, button: 0 }));
      held.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 400)); // outlast the toggle window
      if (!(pressed() === 1 && held.getAttribute('aria-pressed') === 'true')) {
        failures.push(`legend solo: a 650 ms hold did not solo cleanly, or its release click toggled it (pressed ${pressed()})`);
      }
      // Leave everything on for the checks below.
      for (const k of keys) {
        if (k.getAttribute('aria-pressed') !== 'true') {
          k.click();
          await new Promise((r) => setTimeout(r, 330));
        }
      }
    }
  })();
  // 14b: accessibility of the controls added in the 0.0.229-0.0.263 run.
  await (async () => {
    // Every ⓘ names the box it opens.
    for (const btn of doc.querySelectorAll('button.info-button')) {
      const id = btn.getAttribute('aria-controls');
      const box = id && doc.getElementById(id);
      if (!box || !btn.parentElement.contains(box)) failures.push(`a11y: the ⓘ "${btn.getAttribute('aria-label')}" has no aria-controls pointing at its box`);
    }
    // Live regions only where the user's act changes them: the played-note
    // and processor readouts change on every key / governor tick.
    for (const id of ['play-along-readout', 'processor-readout']) {
      const el = doc.getElementById(id);
      if (!el || el.getAttribute('aria-live') !== 'off' || el.getAttribute('role') === 'status') failures.push(`a11y: #${id} is a live region that speaks on every change`);
    }
    // Six "Write it" buttons must not all be called "Write it".
    const writeNames = ['compose-melody-write', 'compose-chords-write', 'compose-beat-write'].map((id) => {
      const el = doc.getElementById(id);
      return el ? (el.getAttribute('aria-label') || el.textContent.trim()) : '';
    });
    if (new Set(writeNames).size !== writeNames.length || writeNames.some((n) => !n || n === 'Write it')) failures.push(`a11y: the Write it buttons share a name (${JSON.stringify(writeNames)})`);
    // A visible "onto" is not a name.
    for (const id of ['compose-melody-track', 'create-tap-track', 'compose-tune-track', 'compose-beat-track']) {
      const el = doc.getElementById(id);
      const label = el && (el.getAttribute('aria-label') || [...doc.querySelectorAll(`label[for="${id}"]`)].map((l) => l.textContent.trim()).join(' '));
      if (!el || !label || label.length < 6 || /^onto$/i.test(label)) failures.push(`a11y: #${id} has no accessible name that says what it picks (${JSON.stringify(label)})`);
    }
    // The pads are buttons whose names say the note.
    const pads = [...doc.querySelectorAll('#play-along-pads button.play-along-pad')];
    if (!pads.length) failures.push('a11y: the on-screen keys rendered no buttons');
    for (const pad of pads) {
      const name = pad.getAttribute('aria-label') || '';
      if (!/^Play .+/.test(name)) failures.push(`a11y: a pad is named ${JSON.stringify(name)}`);
    }
    if (pads.length && !doc.getElementById('play-along-pads').getAttribute('aria-label')) failures.push('a11y: the pads group has no name');
    // Toggles expose their state; the disabled Follow says so by attribute.
    for (const id of ['play-along-toggle', 'play-along-capture', 'play-along-follow', 'create-tap', 'wav-save']) {
      const el = doc.getElementById(id);
      if (el && !['true', 'false'].includes(el.getAttribute('aria-pressed'))) failures.push(`a11y: #${id} exposes no aria-pressed state`);
    }
    // A held Enter on a pad is one press: a repeat must not sound again.
    if (pads.length) {
      const engine = window.__ambi4Engine;
      let ons = 0;
      const realOn = engine.noteOn;
      engine.noteOn = (...args) => { ons += 1; return true; };
      try {
        const down = (repeat) => pads[0].dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', repeat, bubbles: true, cancelable: true }));
        down(false);
        down(true);
        down(true);
      } finally { engine.noteOn = realOn; }
      // Put the keys back as the pad found them (it armed Keys), so the
      // play-along checks that follow start from a cold page.
      const keysToggle = doc.getElementById('play-along-toggle');
      if (keysToggle.getAttribute('aria-pressed') === 'true') keysToggle.click();
      if (ons !== 1) failures.push(`a11y: a held Enter on a pad sounded ${ons} times, not once`);
    }
    // The pin menu hands focus back to where it came from.
    {
      const knob = doc.querySelector('.knob[tabindex="0"]');
      if (knob) {
        knob.focus();
        knob.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
        const menu = doc.getElementById('pin-menu');
        if (!menu) failures.push('a11y: a context-menu on a dial opened no pin menu');
        else {
          if (!menu.contains(doc.activeElement)) failures.push('a11y: opening the pin menu did not move focus into it');
          menu.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
          if (doc.getElementById('pin-menu')) failures.push('a11y: Esc did not close the pin menu');
          else if (doc.activeElement !== knob) failures.push('a11y: closing the pin menu with Esc did not return focus to its dial');
        }
      }
    }
  })();
  // 15: Presets and Rules explanations are ⓘ buttons, not paragraphs.
  await (async () => {
    for (const [slotId, why] of [['preset-submit-info', 'Submit preset'], ['genre-rules-info', 'Genre rules'], ['genre-rules-save-info', 'Save genre'], ['share-name-info', 'the link name']]) {
      const slot = doc.getElementById(slotId);
      const btn = slot && slot.querySelector('button.info-button');
      if (!btn) { failures.push(`help in one form: ${why} has no ⓘ button (#${slotId})`); continue; }
      const box = slot.querySelector('.info-box');
      btn.click();
      if (!box || box.hidden || btn.getAttribute('aria-expanded') !== 'true') failures.push(`help in one form: the ⓘ for ${why} does not open`);
      btn.click();
    }
    // v0.0.241: the sections that were left without an ⓘ each have one that
    // opens on click with real text (static slots, then the editor's fold).
    {
      for (const [slotId, why] of [['processor-info', 'the Processor'], ['sleep-timer-info', 'the sleep timer'], ['alarm-timer-info', 'Schedule start'], ['tracks-info', 'the tracks']]) {
        const slot = doc.getElementById(slotId);
        const btn = slot && slot.querySelector('button.info-button');
        const box = slot && slot.querySelector('.info-box');
        if (!btn || !box) { failures.push(`ⓘ coverage: ${why} has no ⓘ (#${slotId})`); continue; }
        btn.click();
        if (box.hidden || btn.getAttribute('aria-expanded') !== 'true' || box.textContent.trim().length < 40) failures.push(`ⓘ coverage: the ⓘ for ${why} does not open with text`);
        btn.click();
        if (!box.hidden) failures.push(`ⓘ coverage: the ⓘ for ${why} does not close on a second click`);
      }
      const ed = await openEditor('pad');
      const moreSlot = ed && ed.querySelector('.ve-more-info');
      const moreBtn = moreSlot && moreSlot.querySelector('button.info-button');
      const moreBox = moreSlot && moreSlot.querySelector('.info-box');
      if (!moreBtn || !moreBox) failures.push('ⓘ coverage: the voice editor\'s "more" fold has no ⓘ');
      else {
        moreBtn.click();
        if (moreBox.hidden || moreBox.textContent.trim().length < 40) failures.push('ⓘ coverage: the voice editor\'s "more" ⓘ does not open with text');
        moreBtn.click();
      }
    }
    // v0.0.235: hover peeks, click pins. A mouse entering opens the box and
    // leaving closes it; a click keeps it open after the mouse leaves; a
    // finger's pointerenter does nothing (the tap is touch's one gesture).
    {
      const slot = doc.getElementById('share-name-info');
      const wrap = slot && slot.querySelector('.info-anchor');
      const box = wrap && wrap.querySelector('.info-box');
      const btn = wrap && wrap.querySelector('button.info-button');
      const pointer = (type, pointerType) => {
        const event = new window.Event(type);
        Object.defineProperty(event, 'pointerType', { value: pointerType });
        wrap.dispatchEvent(event);
      };
      if (!wrap || !box || !btn) {
        failures.push('ⓘ hover: no ⓘ beside the link name to hover');
      } else {
        pointer('pointerenter', 'mouse');
        if (box.hidden || btn.getAttribute('aria-expanded') !== 'true') failures.push('ⓘ hover: a mouse over the ⓘ did not open its box');
        pointer('pointerleave', 'mouse');
        if (!box.hidden) failures.push('ⓘ hover: the box stayed open after the mouse left without a click');
        pointer('pointerenter', 'mouse');
        btn.click();
        pointer('pointerleave', 'mouse');
        if (box.hidden) failures.push('ⓘ hover: a click did not keep the box open once the mouse left');
        btn.click();
        if (!box.hidden) failures.push('ⓘ hover: a second click did not close the pinned box');
        pointer('pointerenter', 'touch');
        if (!box.hidden) failures.push('ⓘ hover: a finger touching down opened the box before its tap');
      }
    }
    const leftovers = [...doc.querySelectorAll('p.hint')].filter((p) =>
      /^(Every share link has its own|Submitting opens our contact form|Save genre keeps|The rules this genre draws)/.test(p.textContent.trim()));
    if (leftovers.length) failures.push(`help in one form: ${leftovers.length} explanatory paragraph(s) still on the page: "${leftovers[0].textContent.trim().slice(0, 40)}"`);
  })();
  // 15b: on a wide screen an ⓘ opens in the tutorial panel (TODO: "ⓘ content
  // opens in the tutorial area right of the main UI where space permits").
  // jsdom has no matchMedia, so the viewport is stubbed: a query for
  // (max-width: Npx) answers against a pretend width, exactly as the CSS that
  // docks #tutorial-panel above 1100px would. The SAME box node must move —
  // a copy would be the v0.0.267 duplicate-editor leak again.
  await (async () => {
    const realMatchMedia = window.matchMedia;
    const realWidth = window.innerWidth;
    const pretend = (width) => {
      window.innerWidth = width;
      window.matchMedia = (query) => {
        const max = /max-width:\s*([\d.]+)px/.exec(query);
        const min = /min-width:\s*([\d.]+)px/.exec(query);
        const matches = max ? width <= Number(max[1]) : min ? width >= Number(min[1]) : false;
        return { matches, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} };
      };
    };
    try {
      const panel = doc.getElementById('tutorial-panel');
      const slotOf = (id) => doc.getElementById(id);
      const partsOf = (id) => {
        const slot = slotOf(id);
        const wrap = slot && slot.querySelector('.info-anchor');
        return { wrap, btn: wrap && wrap.querySelector('button.info-button'), box: wrap && wrap.querySelector('.info-box') };
      };
      const a = partsOf('processor-info');
      const b = partsOf('tracks-info');
      if (!a.btn || !a.box || !b.btn || !b.box) {
        failures.push('ⓘ in the panel: the Processor or tracks ⓘ is missing');
        return;
      }
      if (!panel.hidden) doc.getElementById('tutorial-close').click();

      pretend(1400);
      a.btn.click();
      const inPanel = panel.contains(a.box) && !a.box.hidden && !panel.hidden;
      if (!inPanel) failures.push('ⓘ in the panel: at 1400px the Processor ⓘ did not put its box in #tutorial-panel');
      if (a.btn.getAttribute('aria-expanded') !== 'true') failures.push('ⓘ in the panel: the docked ⓘ is not aria-expanded');
      const controlled = doc.getElementById(a.btn.getAttribute('aria-controls') || '');
      if (!controlled || controlled.hidden || !controlled.contains(a.box)) failures.push(`ⓘ in the panel: aria-controls (${a.btn.getAttribute('aria-controls')}) does not point at what is shown`);
      const heading = doc.getElementById('tutorial-info-title');
      if (!heading || !/processor/i.test(heading.textContent)) failures.push(`ⓘ in the panel: the panel heading does not name the control (${heading && heading.textContent})`);
      if (doc.querySelectorAll(`#${a.box.id}`).length !== 1 || a.wrap.querySelector('.info-box')) failures.push('ⓘ in the panel: the box was copied, not moved');
      if (!doc.getElementById('tutorial-info-close')) failures.push('ⓘ in the panel: the panel has no Close for the box');

      // Another ⓘ replaces it, and the first goes home.
      b.btn.click();
      if (!panel.contains(b.box) || b.box.hidden) failures.push('ⓘ in the panel: a second ⓘ did not replace the first in the panel');
      if (panel.contains(a.box) || a.box.parentElement !== a.wrap || !a.box.hidden || a.btn.getAttribute('aria-expanded') !== 'false') failures.push('ⓘ in the panel: the replaced box did not go back, closed, beside its ⓘ');
      if (a.btn.getAttribute('aria-controls') !== a.box.id) failures.push('ⓘ in the panel: the replaced ⓘ\'s aria-controls did not come back to its box');

      // Esc (from inside the panel) restores it inline and focus to the ⓘ.
      doc.getElementById('tutorial-info-close').focus();
      doc.getElementById('tutorial-info-close').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      if (panel.contains(b.box) || b.box.parentElement !== b.wrap || !b.box.hidden) failures.push('ⓘ in the panel: Esc did not put the box back inline');
      if (!panel.hidden) failures.push('ⓘ in the panel: Esc left the panel open');
      if (doc.activeElement !== b.btn) failures.push('ⓘ in the panel: Esc did not return focus to the ⓘ');
      if (b.btn.getAttribute('aria-controls') !== b.box.id || b.btn.getAttribute('aria-expanded') !== 'false') failures.push('ⓘ in the panel: after Esc aria-controls/aria-expanded are wrong');

      // Close button does the same.
      a.btn.click();
      doc.getElementById('tutorial-info-close').click();
      if (a.box.parentElement !== a.wrap || !a.box.hidden || !panel.hidden) failures.push('ⓘ in the panel: Close did not put the box back');

      // While the tour runs, an ⓘ stays inline and the tour is untouched.
      doc.getElementById('tutorial-toggle').click();
      const tourText = doc.getElementById('tutorial-step-text').textContent;
      a.btn.click();
      if (panel.contains(a.box) || a.box.hidden) failures.push('ⓘ in the panel: with the tour open, the ⓘ did not open inline');
      if (panel.hidden || panel.classList.contains('info-mode') || doc.getElementById('tutorial-step-text').textContent !== tourText) failures.push('ⓘ in the panel: an ⓘ press disturbed the running tour');
      a.btn.click();
      doc.getElementById('tutorial-close').click();

      // "?" over a docked box opens the tour and sends the box home.
      a.btn.click();
      doc.getElementById('tutorial-toggle').click();
      if (a.box.parentElement !== a.wrap || panel.hidden || panel.classList.contains('info-mode') || doc.getElementById('tutorial-title').textContent !== 'Guided tour') failures.push('ⓘ in the panel: "?" over a docked box did not give the panel back to the tour');
      doc.getElementById('tutorial-close').click();

      // Narrow: inline, as before.
      pretend(900);
      a.btn.click();
      if (panel.contains(a.box) || a.box.parentElement !== a.wrap || a.box.hidden || !panel.hidden) failures.push('ⓘ in the panel: at 900px the ⓘ did not stay inline');
      if (a.btn.getAttribute('aria-controls') !== a.box.id) failures.push('ⓘ in the panel: at 900px aria-controls does not point at the inline box');
      a.btn.click();
    } finally {
      window.matchMedia = realMatchMedia;
      window.innerWidth = realWidth;
    }
  })();
  // 17: "Rules show" is mirrored in each voice editor head — one setting.
  await (async () => {
    const padEd = await openEditor('pad');
    const arpEd = await openEditor('arp');
    const padSel = padEd && padEd.querySelector('.ve-header select.ve-rule-level');
    const arpSel = arpEd && arpEd.querySelector('.ve-header select.ve-rule-level');
    const global = doc.getElementById('rule-level');
    if (!padSel || !arpSel || !global) {
      failures.push('Rules show: the voice editor head has no Rules show select (or the Advanced one is gone)');
    } else {
      const was = global.value;
      const next = was === 'expert' ? 'simple' : 'expert';
      padSel.value = next;
      padSel.dispatchEvent(new window.Event('change', { bubbles: true }));
      if (global.value !== next) failures.push(`Rules show: changing it in the pad editor left the Advanced select on "${global.value}", not "${next}"`);
      if (arpSel.value !== next) failures.push(`Rules show: changing it in the pad editor left the arp editor's copy on "${arpSel.value}", not "${next}"`);
      // The level is page state, not a look: it decides whether an editor's
      // "more" opens (expert) — read that, in both editors.
      const moreOf = (ed) => ed.querySelector('.ve-more');
      const wantOpen = next === 'expert';
      for (const [name, ed] of [['pad', padEd], ['arp', arpEd]]) {
        const more = moreOf(ed);
        if (more && !ed.hidden && (more.getAttribute('aria-expanded') === 'true') !== wantOpen) {
          failures.push(`Rules show: set to "${next}" in the pad head, but the ${name} editor's "more" did not follow`);
        }
      }
      global.value = was;
      global.dispatchEvent(new window.Event('change', { bubbles: true }));
      if (padSel.value !== was || arpSel.value !== was) failures.push('Rules show: changing the Advanced copy did not reach the editors');
    }
  })();

  // v0.0.201 — owner ruling 2026-09-25, "auto writes its choice into Now":
  // the arp's Pattern/Rate/Octaves readouts must equal the ENGINE's own
  // getResolved().arp while auto is playing — never a page-side
  // recomputation — and touching one of them must drop the arp into manual
  // seeded from exactly what auto had just chosen, so the sound does not
  // jump. Asserted at the ENGINE (getParams()), not just the DOM, per the
  // house rule that a DOM-only pass has hidden this exact failure before.
  await (async () => {
    const engine = window.__ambi4Engine;
    const toggle = doc.getElementById('voice-edit-toggle-arp');
    const editorEl = doc.getElementById('voice-editor-arp');
    if (!engine || !toggle || !editorEl) {
      failures.push('the arp editor/engine seam is missing — cannot check the auto Now readout');
    } else if (typeof engine.getResolved !== 'function') {
      console.log('SKIP arp-now-readout: this engine build has no getResolved()');
    } else {
      // Pin complexity to a value whose auto pick (autoArpSettings) is known
      // and distinctive, then force a REBUILD of the arp editor so its
      // controls pick up this complexity rather than whatever was resolved
      // when it was last opened above.
      engine.setParams({ complexity: 0.83, arp: { mode: 'auto' } });
      if (!editorEl.hidden) toggle.click(); // close
      await waitUntil(() => editorEl.hidden);
      toggle.click(); // reopen — rebuilds arpUI fresh against complexity 0.83
      await waitUntil(() => !editorEl.hidden);

      const autoRadio = doc.getElementById('arp-mode-auto');
      const manualRadio = doc.getElementById('arp-mode-manual');
      const patternSelect = doc.getElementById('arp-pattern');
      const rateSelect = doc.getElementById('arp-rate');
      // UI review fix 10: Octaves is a dial now — its value is the knob's
      // readout and its " · auto" tag rides on the knob's label.
      const octavesCell = doc.getElementById('arp-octaves');
      const patternOut = patternSelect && patternSelect.closest('.control').querySelector('.value-readout');
      const rateOut = rateSelect && rateSelect.closest('.control').querySelector('.value-readout');
      const octavesValue = octavesCell && octavesCell.querySelector('.knob-value');
      const octavesOut = octavesCell && octavesCell.querySelector('.knob-label');
      if (!autoRadio || !manualRadio || !patternSelect || !rateSelect || !octavesCell
        || !patternOut || !rateOut || !octavesValue || !octavesOut) {
        failures.push('the arp editor is missing a mode radio, a Pattern/Rate/Octaves control, or its readout');
      } else {
        if (!autoRadio.checked) failures.push('the arp editor did not reopen in auto mode');
        const resolved = engine.getResolved().arp;
        if (!resolved || resolved.auto !== true) {
          failures.push(`getResolved().arp did not report auto: true while arp.mode is auto (${JSON.stringify(resolved)})`);
        }
        if (patternSelect.value !== resolved.pattern) {
          failures.push(`the Pattern control shows ${JSON.stringify(patternSelect.value)} while the engine resolves ${JSON.stringify(resolved.pattern)} — the readout is not reading the engine`);
        }
        if (rateSelect.value !== resolved.rate) {
          failures.push(`the Rate control shows ${JSON.stringify(rateSelect.value)} while the engine resolves ${JSON.stringify(resolved.rate)}`);
        }
        if (octavesValue.textContent.trim() !== String(resolved.octaves)) {
          failures.push(`the Octaves dial shows ${octavesValue.textContent} while the engine resolves ${resolved.octaves}`);
        }
        if (!/auto/i.test(patternOut.textContent)) {
          failures.push(`the Pattern readout does not mark itself auto-resolved: ${JSON.stringify(patternOut.textContent)}`);
        }
        if (!/auto/i.test(rateOut.textContent)) {
          failures.push(`the Rate readout does not mark itself auto-resolved: ${JSON.stringify(rateOut.textContent)}`);
        }
        if (!/auto/i.test(octavesOut.textContent)) {
          failures.push(`the Octaves readout does not mark itself auto-resolved: ${JSON.stringify(octavesOut.textContent)}`);
        }

        // Touching Octaves while auto is playing: the mode must flip to
        // manual, Octaves must take the touched value, and Pattern/Rate
        // must be SEEDED from exactly what auto had just resolved — proof
        // that the first manual bar equals the last auto bar's settings,
        // checked at the engine.
        const lastAutoPattern = resolved.pattern;
        const lastAutoRate = resolved.rate;
        const untouchedOctaves = resolved.octaves;
        const nextOctaves = untouchedOctaves === 1 ? 2 : 1;
        if (!typeIntoKnob(octavesCell, nextOctaves)) failures.push('the Octaves dial has no typed readout');
        const switched = await waitUntil(() => engine.getParams().arp.mode === 'manual');
        const afterParams = engine.getParams().arp;
        if (!switched || afterParams.mode !== 'manual') {
          failures.push('touching Octaves while the arp was in auto did not switch it to manual');
        }
        if (afterParams.octaves !== nextOctaves) {
          failures.push(`touching Octaves to ${nextOctaves} left the engine at ${afterParams.octaves}`);
        }
        if (afterParams.pattern !== lastAutoPattern) {
          failures.push(`the first manual bar's pattern (${JSON.stringify(afterParams.pattern)}) does not match `
            + `the last auto bar's (${JSON.stringify(lastAutoPattern)}) — the sound would have jumped`);
        }
        if (afterParams.rate !== lastAutoRate) {
          failures.push(`the first manual bar's rate (${JSON.stringify(afterParams.rate)}) does not match `
            + `the last auto bar's (${JSON.stringify(lastAutoRate)}) — the sound would have jumped`);
        }
        if (!manualRadio.checked || autoRadio.checked) {
          failures.push('the mode radios did not follow the switch to manual triggered by touching Octaves');
        }
        // Reset for whatever runs after this block.
        engine.setParams({ complexity: 0.5, arp: { mode: 'auto' } });
      }
    }
  })();

  // v26 OSC 2 ↔ Mix linkage: Mix is the BALANCE between the two oscillators,
  // so with Osc 2 switched off there is nothing for it to balance and it must
  // hide with the toggle. Switching Osc 2 back on brings it straight back —
  // this is a visibility rule, the stored balance is never rewritten.
  await (async () => {
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
  })();

  // v26 layout rule, per-track feel dials: Randomness/Swing/Density/Drift
  // rate/Dissonance form ONE aligned row inside the editor, never a column of
  // one-dial lines. The percussion editor (drift rate + swing, no dissonance,
  // no density) is the named offender, so it is the one asserted.
  await (async () => {
    const editor = await openEditor('percussion');
    const rows = editor.querySelectorAll(':scope > .dissonance-row');
    if (rows.length > 1) {
      failures.push(
        `the percussion editor scatters its feel dials over ${rows.length} rows — they share one`
      );
    }
  })();

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
  await (async () => {
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

    // The Plucked string: its section appears on the arp's Plucked string and
    // nowhere else, every dial carries its registry hint, the chip says
    // String (not the struck-object Modal), and the words call it a string.
    {
      const select = doc.getElementById('track-voice-arp');
      const cells = () => doc.querySelectorAll('#voice-editor-arp .patch-controls .knob-cell[data-field^="pluck."]');
      const pick = async (voice) => {
        select.value = voice;
        select.dispatchEvent(new window.Event('change', { bubbles: true }));
        await openEditor('arp');
        await waitUntil(() => doc.querySelectorAll('#voice-editor-arp .patch-controls .knob-cell').length > 0);
      };
      if (!Array.from(select.options).some((o) => o.value === 'string')) {
        failures.push('the arp picker does not offer Plucked string');
      } else {
        await pick('string');
        if (!(await waitUntil(() => cells().length === 3))) {
          failures.push(`Plucked string's editor shows ${cells().length} pluck dials, expected Damping, Brightness and Position`);
        } else {
          for (const cell of cells()) {
            const row = registry[`patch.${cell.dataset.field}`];
            const knob = cell.querySelector('.knob');
            const descId = knob && knob.getAttribute('aria-describedby');
            const desc = descId ? doc.getElementById(descId) : null;
            if (!row || !desc || desc.textContent !== row.hint) failures.push(`${cell.dataset.field}: the pluck dial does not carry its registry hint`);
          }
          const chip = doc.querySelector('#voice-editor-arp .ve-engine');
          if (!chip || chip.textContent !== 'String') failures.push(`Plucked string's engine chip reads ${JSON.stringify(chip && chip.textContent)}, not String`);
          const words = doc.querySelector('#voice-editor-arp .ve-words');
          if (!words || !/plucked string/.test(words.textContent) || /modal/.test(words.textContent)) failures.push(`Plucked string's words line: ${JSON.stringify(words && words.textContent)}`);
        }
        await pick('marimba');
        await new Promise((r) => setTimeout(r, 50));
        if (cells().length) failures.push('Marimba grew pluck dials — the disclosure rule is broken');
        await pick('softPluck');
      }
    }

    // Pulse & sync: Sync lead shows Sync ratio, Slave and Width; Pulse bass
    // shows Width alone; every dial carries its registry hint; the voice
    // picked after them grows none of it.
    for (const [track, voice, want, back] of [
      ['melody', 'sync', ['pulse.ratio', 'pulse.slave', 'pulse.width'], 'pluck'],
      ['bass', 'pulse', ['pulse.width'], 'sub'],
    ]) {
      const select = doc.getElementById(`track-voice-${track}`);
      const cells = () => doc.querySelectorAll(`#voice-editor-${track} .patch-controls .knob-cell[data-field^="pulse."]`);
      const pick = async (id) => {
        select.value = id;
        select.dispatchEvent(new window.Event('change', { bubbles: true }));
        await openEditor(track);
        await waitUntil(() => doc.querySelectorAll(`#voice-editor-${track} .patch-controls .knob-cell`).length > 0);
      };
      if (!select || !Array.from(select.options).some((o) => o.value === voice)) {
        failures.push(`the ${track} picker does not offer ${voice}`);
        continue;
      }
      const was = select.value;
      await pick(voice);
      if (!(await waitUntil(() => cells().length === want.length))) {
        failures.push(`${track}.${voice}'s editor shows ${cells().length} pulse dials, expected ${want.join(', ')}`);
      } else {
        const fields = Array.from(cells()).map((c) => c.dataset.field);
        if (JSON.stringify(fields) !== JSON.stringify(want)) failures.push(`${track}.${voice}: pulse dials ${fields.join(', ')}, expected ${want.join(', ')}`);
        for (const cell of cells()) {
          const row = registry[`patch.${cell.dataset.field}`];
          const knob = cell.querySelector('.knob');
          const descId = knob && knob.getAttribute('aria-describedby');
          const desc = descId ? doc.getElementById(descId) : null;
          if (!row || !desc || desc.textContent !== row.hint) failures.push(`${cell.dataset.field}: the pulse dial does not carry its registry hint`);
        }
      }
      await pick(back);
      await new Promise((r) => setTimeout(r, 50));
      if (cells().length) failures.push(`${track}.${back} grew pulse dials — the disclosure rule is broken`);
      await pick(was || back);
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
      // UI review fix 9: Save as my voice sits behind the editor's "more".
      const moreToggle = editor.querySelector('.ve-more');
      if (moreToggle && moreToggle.getAttribute('aria-expanded') !== 'true') moreToggle.click();
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

    // v0.0.203: the rule chapter "Hold the melody's voice". The button sets the
    // scene (Synthwave, the melody editor open), every step's target resolves to
    // exactly ONE element once the step has run, Next walks the chapter, and
    // doing what it says (removing Organ stab, then Done) lands at the ENGINE.
    {
      const chapters = readRuleChapters();
      const chapter = chapters.find((c) => c.id === 'hold-voice');
      const engine = window.__ambi4Engine;
      if (!chapter) failures.push('RULE_CHAPTERS has no hold-voice chapter');
      else {
        doc.getElementById('tutorial-toggle').click();
        const button = doc.getElementById(chapter.button);
        if (!button || button.hidden) failures.push('the tour panel does not offer the "Hold the melody\'s voice" chapter');
        else {
          button.click();
          const panel = doc.getElementById('tutorial-panel');
          const title = doc.getElementById('tutorial-title');
          const ok = await waitUntil(() => title.textContent === chapter.label && engine.getParams().genre === 'synthwave');
          if (!ok) failures.push(`the chapter button did not open "${chapter.label}" on Synthwave (title ${JSON.stringify(title.textContent)}, genre ${engine.getParams().genre})`);
          const melody = doc.getElementById('voice-editor-melody');
          if (!melody || melody.hidden) failures.push('the chapter did not open the melody editor');
          if (!button.hidden) failures.push('the chapter button stays visible inside a chapter');
          for (const [i, step] of chapter.steps.entries()) {
            const found = doc.querySelectorAll(step.target).length;
            if (found !== 1) failures.push(`rule chapter step ${i + 1}: ${step.target} matches ${found} elements once its step has run`);
            else if (!doc.querySelector(step.target).classList.contains('tutorial-highlight')) failures.push(`rule chapter step ${i + 1}: its target is not highlighted (highlighted: ${[...doc.querySelectorAll('.tutorial-highlight')].map((e) => e.className + '/' + e.id).join(',')})`);
            if (doc.getElementById('tutorial-progress').textContent !== `${i + 1} / ${chapter.steps.length}`) failures.push(`rule chapter step ${i + 1}: progress reads ${doc.getElementById('tutorial-progress').textContent}`);
            if (i === 2) {
              // Do what the step says: take Organ stab out of the Pool, then Done.
              doc.querySelector(step.target).click();
            }
            if (i === 3) {
              doc.querySelector(step.target).click();
              await waitUntil(() => !doc.getElementById('voice-blend-editor'));
              const rule = engine.getParams().tracks.melody.voiceRule;
              if (!rule || !Array.isArray(rule.pool) || rule.pool.length < 2) failures.push('the chapter\'s Done left no pool at the engine');
              else if (rule.pool.some((entry) => entry.id === 'stab')) failures.push('removing Organ stab and pressing Done left it in the engine\'s pool');
            }
            if (i < chapter.steps.length - 1) doc.getElementById('tutorial-next').click();
          }
          if (!doc.getElementById('tutorial-next').disabled) failures.push('the chapter\'s last step leaves Next enabled');
          doc.getElementById('tutorial-close').click();
          if (!panel.hidden) failures.push('closing the chapter left the panel open');
          if (doc.querySelector('.tutorial-highlight')) failures.push('closing the chapter left a control highlighted');
          doc.getElementById('tutorial-toggle').click();
          if (title.textContent !== 'Guided tour') failures.push('after a rule chapter the tour opens under the wrong title');
          if (doc.getElementById(chapter.button).hidden) failures.push('the chapter button is hidden again on the tour');
          doc.getElementById('tutorial-close').click();
        }
      }
    }

    // The rule chapter "Make a sound of your own": its button sets the scene
    // (Melody on Keys, its editor open), and every step's target resolves to
    // exactly ONE element inside that editor and is highlighted when reached.
    {
      const chapter = readRuleChapters().find((c) => c.id === 'own-sound');
      if (!chapter) failures.push('RULE_CHAPTERS has no own-sound chapter');
      else {
        doc.getElementById('tutorial-toggle').click();
        const button = doc.getElementById(chapter.button);
        if (!button || button.hidden) failures.push('the tour panel does not offer the "Make a sound of your own" chapter');
        else {
          button.click();
          const title = doc.getElementById('tutorial-title');
          const inside = (step) => step.target.replace('#voice-editor-melody ', '');
          const ready = await waitUntil(() => title.textContent === chapter.label
            && doc.getElementById('track-voice-melody').value === chapter.voice
            && doc.querySelector(chapter.steps[3].target));
          if (!ready) failures.push(`the own-sound chapter did not open on ${chapter.voice} (title ${JSON.stringify(title.textContent)}, voice ${doc.getElementById('track-voice-melody').value})`);
          const editor = doc.getElementById('voice-editor-melody');
          for (const [i, step] of chapter.steps.entries()) {
            const found = editor ? editor.querySelectorAll(inside(step)).length : 0;
            if (found !== 1) failures.push(`own-sound step ${i + 1}: ${step.target} matches ${found} elements in the melody editor`);
            else if (!await waitUntil(() => editor.querySelector(inside(step)).classList.contains('tutorial-highlight'))) failures.push(`own-sound step ${i + 1}: its target is not highlighted`);
            if (i < chapter.steps.length - 1) doc.getElementById('tutorial-next').click();
          }
          doc.getElementById('tutorial-close').click();
          if (doc.querySelector('.tutorial-highlight')) failures.push('closing the own-sound chapter left a control highlighted');
        }
      }
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
      const finderMore = editor.querySelector('.ve-more');
      if (finderMore && finderMore.getAttribute('aria-expanded') !== 'true') finderMore.click();
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
          go.focus();
          go.click();
          const landed = await waitUntil(() => {
            const params = engine.getParams();
            const fm = params.patches && params.patches.melody && params.patches.melody.bell && params.patches.melody.bell.fm;
            return params.tracks.melody.voice === 'bell' && fm && Number(fm.depth) > depthBefore;
          });
          if (!landed) failures.push(`Set it up did not put Bell with a raised FM depth at the engine (${JSON.stringify(engine.getParams().tracks.melody.voice)})`);
          // a11y: the editor rebuilt under the press; focus must not fall to <body>.
          const refocused = await waitUntil(() => doc.activeElement && doc.activeElement !== doc.body && doc.getElementById('voice-editor-melody').contains(doc.activeElement));
          if (!refocused) failures.push('a11y: after Set it up rebuilt the editor, keyboard focus was dropped on the page body');
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

    // v0.0.229: Match a sample. A pitched track's editor carries the row — a
    // Choose button driving a hidden audio file input — and a kit does not (a
    // kit is many sounds, not one). The harness has no OfflineAudioContext,
    // which is exactly the browser the row must answer honestly rather than
    // throw in: hand it a file and the answer says what is missing.
    {
      const editor = await openEditor('melody');
      const more = editor.querySelector('.ve-more');
      if (more && more.getAttribute('aria-expanded') !== 'true') more.click();
      await waitUntil(() => editor.querySelector('.ve-sample-match'));
      const row = editor.querySelector('.ve-sample-match');
      if (!row) {
        failures.push('the melody editor has no Match a sample row');
      } else {
        const input = row.querySelector('input[type="file"]');
        const choose = row.querySelector('.ve-sample-choose');
        if (!input || !/audio/.test(input.accept)) failures.push(`the sample row's file input accepts ${JSON.stringify(input && input.accept)}, not audio`);
        if (!choose || !/Choose a sound file/.test(choose.textContent)) failures.push('the sample row has no Choose a sound file button');
        if (input) {
          Object.defineProperty(input, 'files', { configurable: true, value: [new window.File([new Uint8Array(8)], 'note.wav', { type: 'audio/wav' })] });
          input.dispatchEvent(new window.Event('change'));
          const said = await waitUntil(() => /cannot render sound offline/.test(row.querySelector('.ve-sample-answer').textContent));
          if (!said) failures.push(`with no OfflineAudioContext the sample row said ${JSON.stringify(row.querySelector('.ve-sample-answer').textContent)}`);
        }
        // The microphone half: the harness has no mediaDevices, so pressing
        // Record must say so rather than throw or hang in a recording state.
        const record = row.querySelector('.ve-sample-record');
        if (!record || !/Record a note/.test(record.textContent)) {
          failures.push('the sample row has no Record a note button');
        } else {
          record.click();
          const refused = await waitUntil(() => /cannot record from a microphone/.test(row.querySelector('.ve-sample-answer').textContent));
          if (!refused) failures.push(`with no microphone API, Record a note said ${JSON.stringify(row.querySelector('.ve-sample-answer').textContent)}`);
          if (record.getAttribute('aria-pressed') !== 'false') failures.push('Record a note was left pressed with nothing recording');
        }
      }
      // v0.0.234: the kit matches ONE sound — the open tab's. On Common it
      // asks for a tab rather than guessing which drum a sample is.
      const kit = await openEditor('percussion');
      const kitMore = kit.querySelector('.ve-more');
      if (kitMore && kitMore.getAttribute('aria-expanded') !== 'true') kitMore.click();
      await waitUntil(() => kit.querySelector('.ve-sample-match'));
      const kitRow = kit.querySelector('.ve-sample-match');
      if (!kitRow) {
        failures.push('the kit editor has no Match a sample row');
      } else {
        const hand = async () => {
          const input = kitRow.querySelector('input[type="file"]');
          Object.defineProperty(input, 'files', { configurable: true, value: [new window.File([new Uint8Array(8)], 'kick.wav', { type: 'audio/wav' })] });
          input.dispatchEvent(new window.Event('change'));
        };
        const commonTab = kit.querySelector('input[name="kit-kind-percussion"][value="common"]');
        if (commonTab && !commonTab.checked) { commonTab.checked = true; commonTab.dispatchEvent(new window.Event('change')); }
        await hand();
        if (!await waitUntil(() => /Pick a sound's tab first/.test(kitRow.querySelector('.ve-sample-answer').textContent))) {
          failures.push(`the kit's sample row on Common said ${JSON.stringify(kitRow.querySelector('.ve-sample-answer').textContent)}`);
        }
        const lowTab = kit.querySelector('input[name="kit-kind-percussion"][value="low"]');
        if (!lowTab) {
          failures.push('the kit editor has no Low tab to match a sound on');
        } else {
          lowTab.checked = true;
          lowTab.dispatchEvent(new window.Event('change'));
          await hand();
          if (!await waitUntil(() => /cannot render sound offline/.test(kitRow.querySelector('.ve-sample-answer').textContent))) {
            failures.push(`on the Low tab the kit's sample row said ${JSON.stringify(kitRow.querySelector('.ve-sample-answer').textContent)}`);
          }
        }
      }
    }

    // Review of v0.0.229–251: the two races in Match a sample, each proved
    // red on the code before its fix. Both need what this harness otherwise
    // lacks (an offline context, a microphone), so each is installed here and
    // taken away again afterwards.
    //
    // (1) A kit match is for the sound whose tab it started on. The search
    // runs for seconds and the tabs stay live; it read the OPEN tab when it
    // finished, so a Low match landed on High (or on Common, the whole kit).
    {
      class OfflineStub extends StubAudioContext {
        constructor(channels, length, sampleRate) { super(); this.length = length; this.sampleRate = sampleRate; }
        async decodeAudioData() {
          const sr = 24000;
          const data = new Float32Array(sr);
          for (let i = 0; i < sr; i++) data[i] = Math.sin((2 * Math.PI * 110 * i) / sr) * Math.exp((-6 * i) / sr);
          return { numberOfChannels: 1, sampleRate: sr, getChannelData: () => data };
        }
        async startRendering() {
          await new Promise((resolve) => setTimeout(resolve, 1));
          const data = new Float32Array(this.length);
          return { getChannelData: () => data };
        }
      }
      globalThis.OfflineAudioContext = OfflineStub;
      window.OfflineAudioContext = OfflineStub;
      try {
        const engine = window.__ambi4Engine;
        const voicesModule = await import(pathToFileURL(join(repoRoot, 'src/scripts/engine-voices.js')).href);
        const kitVoice = () => engine.getParams().tracks.percussion.voice;
        // What each sound PLAYS: its published envelope under its override.
        const sounds = () => {
          const per = structuredClone(((engine.getParams().patches?.percussion || {})[kitVoice()] || {}).perKind || {});
          const published = (voicesModule.VOICES.percussion[kitVoice()].defaults || {}).perKind || {};
          const out = {};
          for (const kind of new Set([...Object.keys(per), ...Object.keys(published)])) {
            const merged = structuredClone(published[kind] || {});
            for (const [section, fields] of Object.entries(per[kind] || {})) merged[section] = { ...(merged[section] || {}), ...fields };
            out[kind] = JSON.stringify(Object.keys(merged).sort().map((s) => [s, Object.keys(merged[s]).sort().map((k) => [k, merged[s][k]])]));
          }
          return out;
        };
        // The kit-wide dials as they sound: the voice's defaults under what
        // is stored. (Any commit stores the whole resolved patch where there
        // was a sparse one, so the stored objects alone are not comparable.)
        const common = () => {
          const out = structuredClone(voicesModule.VOICES.percussion[kitVoice()].defaults || {});
          const stored = (engine.getParams().patches?.percussion || {})[kitVoice()] || {};
          for (const [section, fields] of Object.entries(stored)) {
            if (section === 'perKind') continue;
            out[section] = fields && typeof fields === 'object' && !Array.isArray(fields) ? { ...(out[section] || {}), ...fields } : fields;
          }
          delete out.perKind;
          return out;
        };
        const commonMoved = (was, now) => Object.entries(was).flatMap(([section, fields]) => (
          fields && typeof fields === 'object' && !Array.isArray(fields)
            ? Object.keys(fields).filter((key) => JSON.stringify(fields[key]) !== JSON.stringify((now[section] || {})[key])).map((key) => `${section}.${key}`)
            : JSON.stringify(fields) !== JSON.stringify(now[section]) ? [section] : []));
        for (const elsewhere of ['high', 'common']) {
          const kit = await openEditor('percussion');
          const pick = (value) => {
            const tab = doc.querySelector(`#voice-editor-percussion input[name="kit-kind-percussion"][value="${value}"]`);
            tab.checked = true;
            tab.dispatchEvent(new window.Event('change'));
          };
          pick('low');
          const before = sounds();
          const commonBefore = common();
          const input = kit.querySelector('.ve-sample-match input[type="file"]');
          Object.defineProperty(input, 'files', { configurable: true, value: [new window.File([new Uint8Array(8)], 'kick.wav', { type: 'audio/wav' })] });
          input.dispatchEvent(new window.Event('change'));
          const answer = () => (doc.querySelector('#voice-editor-percussion .ve-sample-answer') || {}).textContent || '';
          if (!await waitUntil(() => /Trying the voices/.test(answer()), 4000)) {
            failures.push(`a kit match never started searching: ${JSON.stringify(answer())}`);
            continue;
          }
          pick(elsewhere);
          if (!await waitUntil(() => /alike|Nothing on this track/.test(answer()), 60000)) {
            failures.push(`a kit match never finished: ${JSON.stringify(answer())}`);
            continue;
          }
          const after = sounds();
          const moved = Object.keys({ ...before, ...after }).filter((kind) => kind !== 'low' && before[kind] !== after[kind]);
          if (moved.length) failures.push(`a Low match, with the ${elsewhere} tab opened while it ran, changed ${moved.join(', ')}`);
          const commonChanged = commonMoved(commonBefore, common());
          if (commonChanged.length) failures.push(`a Low match, with the ${elsewhere} tab opened while it ran, changed the whole kit's ${commonChanged.join(', ')}`);
        }
      } finally {
        window.OfflineAudioContext = undefined;
        delete globalThis.OfflineAudioContext;
      }
    }

    // (2) A second press of Record a note while the browser is still asking
    // for the microphone opened a second stream and orphaned the first:
    // neither Stop nor the four-second cap could reach it, so it listened on.
    {
      const streams = [];
      const hadDevices = Object.getOwnPropertyDescriptor(window.navigator, 'mediaDevices');
      const hadRecorder = [globalThis.MediaRecorder, window.MediaRecorder];
      Object.defineProperty(window.navigator, 'mediaDevices', { configurable: true, value: {
        getUserMedia: () => new Promise((resolve) => setTimeout(() => {
          const track = { live: true, stop() { this.live = false; } };
          streams.push(track);
          resolve({ getTracks: () => [track] });
        }, 200)),
      } });
      class RecorderStub {
        constructor() { this.state = 'inactive'; this.listeners = {}; this.mimeType = 'audio/webm'; }
        addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
        start() { this.state = 'recording'; }
        stop() {
          if (this.state !== 'recording') return;
          this.state = 'inactive';
          setTimeout(() => (this.listeners.stop || []).forEach((fn) => fn({})), 0);
        }
      }
      globalThis.MediaRecorder = RecorderStub;
      window.MediaRecorder = RecorderStub;
      try {
        const editor = await openEditor('melody');
        const more = editor.querySelector('.ve-more');
        if (more && more.getAttribute('aria-expanded') !== 'true') more.click();
        await waitUntil(() => editor.querySelector('.ve-sample-record'));
        const record = editor.querySelector('.ve-sample-record');
        record.click();
        await new Promise((resolve) => setTimeout(resolve, 40));
        record.click();
        await waitUntil(() => streams.length >= 1 && record.getAttribute('aria-pressed') === 'true', 3000);
        await new Promise((resolve) => setTimeout(resolve, 400));
        record.click(); // Stop recording
        await new Promise((resolve) => setTimeout(resolve, 4500)); // past the four-second cap
        const live = streams.filter((track) => track.live).length;
        if (live) failures.push(`two presses of Record a note during the permission prompt left ${live} of ${streams.length} microphone streams listening after Stop`);
      } finally {
        delete window.navigator.mediaDevices;
        if (hadDevices) Object.defineProperty(window.navigator, 'mediaDevices', hadDevices);
        [globalThis.MediaRecorder, window.MediaRecorder] = hadRecorder;
      }
    }

    // (3) Review follow-up: a running match belongs to the TRACK, not the
    // editor's DOM. Closing and reopening the editor rebuilds it; the match
    // carried on with no Stop button, and the new editor let a second match
    // start alongside it. The rebuilt editor must show the progress and a
    // Stop that reaches it, and refuse a second match while it runs.
    {
      let decodes = 0;
      class SlowOffline extends StubAudioContext {
        constructor(channels, length, sampleRate) { super(); this.length = length; this.sampleRate = sampleRate; }
        async decodeAudioData() {
          decodes += 1;
          const sr = 24000;
          const data = new Float32Array(sr);
          for (let i = 0; i < sr; i++) data[i] = Math.sin((2 * Math.PI * 220 * i) / sr) * Math.exp((-3 * i) / sr);
          return { numberOfChannels: 1, sampleRate: sr, getChannelData: () => data };
        }
        async startRendering() {
          await new Promise((resolve) => setTimeout(resolve, 25));
          const data = new Float32Array(this.length);
          return { getChannelData: () => data };
        }
      }
      globalThis.OfflineAudioContext = SlowOffline;
      window.OfflineAudioContext = SlowOffline;
      try {
        const q = (sel) => doc.querySelector(`#voice-editor-melody ${sel}`);
        const answer = () => (q('.ve-sample-answer') || {}).textContent || '';
        const feed = (input) => {
          Object.defineProperty(input, 'files', { configurable: true, value: [new window.File([new Uint8Array(8)], 'note.wav', { type: 'audio/wav' })] });
          input.dispatchEvent(new window.Event('change'));
        };
        await openEditor('melody');
        await waitUntil(() => q('.ve-sample-match input[type="file"]'));
        q('.ve-sample-choose').focus();
        feed(q('.ve-sample-match input[type="file"]'));
        if (!await waitUntil(() => /Trying the voices/.test(answer()), 6000)) {
          failures.push(`match ownership: the melody match never started searching: ${JSON.stringify(answer())}`);
        } else {
          // a11y: progress is silent (aria-busy) and focus moved to Stop, not lost on a disabled button.
          if (q('.ve-sample-answer').getAttribute('aria-busy') !== 'true') failures.push('a11y: the match answer is not aria-busy while the percent counts up');
          if (doc.activeElement !== q('.ve-sample-stop')) failures.push('a11y: pressing Match left focus off Stop (Choose and Record are disabled for the run)');
          const oldStop = q('.ve-sample-stop');
          doc.getElementById('voice-edit-toggle-melody').click(); // close
          await waitUntil(() => doc.getElementById('voice-editor-melody').hidden);
          await openEditor('melody'); // reopen: a rebuilt editor
          await waitUntil(() => q('.ve-sample-stop') && q('.ve-sample-stop') !== oldStop);
          const stop = q('.ve-sample-stop');
          if (!stop || stop === oldStop) failures.push('match ownership: reopening the editor did not rebuild it — the test proves nothing');
          else {
            if (stop.hidden) failures.push('match ownership: a rebuilt editor shows no Stop while its track\'s match runs');
            if (!q('.ve-sample-choose')?.disabled) failures.push('match ownership: a rebuilt editor offers Choose a sound file while its track\'s match runs');
            if (!await waitUntil(() => /Trying the voices/.test(answer()), 3000)) failures.push(`match ownership: a rebuilt editor does not show the running match's progress (${JSON.stringify(answer())})`);
            const was = decodes;
            feed(q('.ve-sample-match input[type="file"]'));
            await new Promise((resolve) => setTimeout(resolve, 100));
            if (decodes !== was) failures.push('match ownership: a second match started on the same track while one ran');
            const liveStop = q('.ve-sample-stop') || stop;
            liveStop.focus();
            if (doc.activeElement !== liveStop) failures.push('a11y: the running match\'s Stop would not take focus');
            liveStop.click();
            if (!await waitUntil(() => /stopped early|Nothing on this track|alike/.test(answer()) && q('.ve-sample-stop')?.hidden, 20000)) {
              failures.push(`match ownership: Stop in the rebuilt editor did not end the match (${JSON.stringify(answer())})`);
            } else if (doc.activeElement === doc.body) {
              failures.push(`a11y: after a match ended focus was left on the page body (choose ${q('.ve-sample-choose') ? (q('.ve-sample-choose').disabled ? 'disabled' : 'enabled') : 'absent'}, active ${doc.activeElement && doc.activeElement.tagName})`);
            }
          }
        }
        // Whatever happened, let the match end before the stub goes.
        await waitUntil(() => q('.ve-sample-stop')?.hidden && !q('.ve-sample-choose')?.disabled, 30000);
      } finally {
        window.OfflineAudioContext = undefined;
        delete globalThis.OfflineAudioContext;
      }
    }

    // UI review 2026-10-03, fixes 8, 9, 10 and 12 — the voice editor gets
    // layers. First open shows fewer controls than it did (the words, save
    // row and finder fold behind one "more"; the Off/Auto/On radios go, the
    // row's lamp being the one state control); the reset sits in the head
    // beside the engine chip; "more" reveals Save as my voice and is open by
    // default only at the expert level; the arp's Octaves and Gate are dials
    // whose change reaches the ENGINE. Measured on v0.0.206 with this same
    // counter: melody (Pluck) 80 controls on first open, arp (Soft pluck) 75.
    {
      const engine = window.__ambi4Engine;
      const levelSelect = doc.getElementById('rule-level');
      const setLevel = (level) => {
        levelSelect.value = level;
        levelSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
      };
      const shown = (el, root) => {
        for (let n = el; n && n !== root.parentNode; n = n.parentElement) if (n.hidden) return false;
        return true;
      };
      // Every control a person could reach: a knob counts once (its readout
      // button is part of it), every other button / input / select once.
      const visibleControls = (root) => Array.from(
        root.querySelectorAll('button, input, select, textarea, .knob'),
      ).filter((el) => !el.matches('.knob-value') && shown(el, root)).length;
      const freshOpen = async (track, voice) => {
        const select = doc.getElementById(`track-voice-${track}`);
        select.value = voice;
        select.dispatchEvent(new window.Event('change', { bubbles: true }));
        const editor = doc.getElementById(`voice-editor-${track}`);
        if (!editor.hidden) doc.getElementById(`voice-edit-toggle-${track}`).click();
        await waitUntil(() => editor.hidden);
        doc.getElementById(`voice-edit-toggle-${track}`).click();
        await waitUntil(() => !editor.hidden && editor.querySelectorAll('.patch-controls .knob-cell').length > 0);
        await new Promise((r) => setTimeout(r, 50));
        return editor;
      };
      const BEFORE = { melody: 80, arp: 75 };
      if (!levelSelect || !engine) {
        failures.push('editor layers: the Rules show select or the engine seam is missing');
      } else {
        const levelWas = levelSelect.value;
        setLevel('advanced');
        for (const [track, voice] of [['melody', 'pluck'], ['arp', 'softPluck']]) {
          const editor = await freshOpen(track, voice);
          const count = visibleControls(editor);
          console.log(`editor layers: ${track} first open shows ${count} controls (v0.0.206: ${BEFORE[track]})`);
          if (!(count < BEFORE[track])) failures.push(`editor layers: the ${track} editor opens on ${count} controls, not fewer than v0.0.206's ${BEFORE[track]}`);
          // Fix 12: no state radios in the head — the lamp is the one control.
          if (editor.querySelector('.track-state, input[name^="track-state-"]')) failures.push(`editor layers: the ${track} editor head still carries Off/Auto/On radios`);
          // Fix 8: the reset is in the head, straight after the engine chip.
          const reset = editor.querySelector('.ve-header .ve-reset');
          const chip = editor.querySelector('.ve-header .ve-engine');
          if (!reset) failures.push(`editor layers: the ${track} editor's reset is not in its head`);
          else if (!chip || chip.nextElementSibling !== reset) failures.push(`editor layers: the ${track} editor's reset does not sit beside the engine chip`);
          // Fix 9: Save as my voice is folded until more is pressed.
          const more = editor.querySelector('.ve-more');
          const save = editor.querySelector('.ve-save-voice');
          if (!more || !save) {
            failures.push(`editor layers: the ${track} editor has no "more" or no Save as my voice`);
          } else {
            if (shown(save, editor)) failures.push(`editor layers: Save as my voice shows on the ${track} editor's first open at the advanced level`);
            if (more.getAttribute('aria-expanded') !== 'false' || more.textContent !== 'more') failures.push(`editor layers: the ${track} "more" does not read as closed`);
            more.click();
            if (!shown(save, editor)) failures.push(`editor layers: pressing "more" on the ${track} editor did not reveal Save as my voice`);
            if (more.getAttribute('aria-expanded') !== 'true' || more.textContent !== 'less') failures.push(`editor layers: the ${track} "more" does not read as open after a press`);
            more.click(); // fold it back, so the next open starts from the level
          }
        }
        // At the expert level an editor opens with "more" already open, and a
        // level change reaches an editor that is already open.
        setLevel('expert');
        // (The arp's editor is the one still open — one editor at a time.)
        const arpOpen = doc.getElementById('voice-editor-arp');
        const openedSave = arpOpen.querySelector('.ve-save-voice');
        if (arpOpen.hidden || !openedSave || !shown(openedSave, arpOpen)) failures.push('editor layers: switching Rules show to expert did not open the already-open arp editor\'s "more"');
        const expertEditor = await freshOpen('melody', 'pluck');
        const expertSave = expertEditor.querySelector('.ve-save-voice');
        if (!expertSave || !shown(expertSave, expertEditor)) failures.push('editor layers: at the expert level the melody editor opens with Save as my voice folded');
        setLevel(levelWas);

        // Fix 10: the arp's Octaves and Gate are dials, and a change on them
        // reaches the ENGINE, not just the readout.
        const arpEditor = await freshOpen('arp', 'softPluck');
        const octaves = arpEditor.querySelector('#arp-octaves');
        const gate = arpEditor.querySelector('#arp-gate');
        if (!octaves || !octaves.matches('.knob-cell') || !octaves.querySelector('.knob')) {
          failures.push('editor layers: the arp\'s Octaves is not a dial');
        } else if (arpEditor.querySelector('input[type="range"]#arp-octaves, input[type="range"]#arp-gate')) {
          failures.push('editor layers: the arp still carries a native Octaves/Gate slider');
        } else {
          const arpWas = { ...engine.getParams().arp };
          const target = arpWas.octaves === 3 ? 1 : 3;
          typeIntoKnob(octaves, target);
          const landed = await waitUntil(() => engine.getParams().arp.octaves === target);
          if (!landed) failures.push(`editor layers: typing ${target} into the Octaves dial left the engine at ${engine.getParams().arp.octaves}`);
          if (engine.getParams().arp.mode !== 'manual') failures.push('editor layers: touching the Octaves dial did not take the arp over from Auto');
          if (octaves.querySelector('.knob-value').textContent.trim() !== String(target)) failures.push(`editor layers: the Octaves dial reads ${octaves.querySelector('.knob-value').textContent} after the engine took ${target}`);
          if (!gate || !gate.querySelector('.knob')) {
            failures.push('editor layers: the arp\'s Gate is not a dial');
          } else {
            typeIntoKnob(gate, '35');
            const gated = await waitUntil(() => Math.abs(engine.getParams().arp.gate - 0.35) < 1e-6);
            if (!gated) failures.push(`editor layers: typing 35 % into the Gate dial left the engine at ${engine.getParams().arp.gate}`);
          }
          // v0.0.217: Minimalism's Phase merged as a dial like its
          // neighbours; a typed value reaches the engine and the live line
          // under the dials names it, and 0 removes the copy (sparse).
          const phaseCell = arpEditor.querySelector('#arp-phase');
          const phaseLine = arpEditor.querySelector('#arp-phase-live');
          if (!phaseCell || !phaseCell.querySelector('.knob')) {
            failures.push('editor layers: the arp\'s Phase is not a dial');
          } else if (!phaseLine) {
            failures.push('editor layers: the arp\'s Phase has no live line');
          } else {
            typeIntoKnob(phaseCell, '2');
            const phased = await waitUntil(() => engine.getParams().arp.phase === 2);
            if (!phased) failures.push(`editor layers: typing 2 into the Phase dial left the engine at ${engine.getParams().arp.phase}`);
            if (!/^Phase: 2% slower copy/.test(phaseLine.textContent)) failures.push(`editor layers: the Phase line reads "${phaseLine.textContent}" after 2`);
            typeIntoKnob(phaseCell, '0');
            const off = await waitUntil(() => !(engine.getParams().arp.phase > 0));
            if (!off) failures.push(`editor layers: typing 0 into the Phase dial left the engine at ${engine.getParams().arp.phase}`);
            if (phaseLine.textContent !== 'Phase: off') failures.push(`editor layers: the Phase line reads "${phaseLine.textContent}" at 0`);
          }
          // v0.0.228: the Additive process is a dial beside Phase with a
          // live line of its own and a Shape select; a typed count and a
          // picked shape reach the ENGINE, and 0 removes it (sparse).
          const addCell = arpEditor.querySelector('#arp-additive');
          const addLine = arpEditor.querySelector('#arp-additive-live');
          const addShape = arpEditor.querySelector('select#arp-shape');
          if (!addCell || !addCell.querySelector('.knob')) {
            failures.push('editor layers: the arp\'s Additive is not a dial');
          } else if (!addLine || !addShape) {
            failures.push('editor layers: the arp\'s Additive has no live line or no Shape select');
          } else {
            const shapeShown = () => !(addShape.closest('.control') || addShape).hidden;
            if (shapeShown()) failures.push('editor layers: the Additive Shape shows while Additive is off');
            typeIntoKnob(addCell, '3');
            const added = await waitUntil(() => engine.getParams().arp.additive?.every === 3
              && engine.getParams().arp.additive.mode === 'grow');
            if (!added) failures.push(`editor layers: typing 3 into the Additive dial left the engine at ${JSON.stringify(engine.getParams().arp.additive)}`);
            if (!/^Additive: a note every 3 repetitions/.test(addLine.textContent)) failures.push(`editor layers: the Additive line reads "${addLine.textContent}" after 3`);
            if (!shapeShown()) failures.push('editor layers: the Additive Shape stays hidden once Additive is on');
            addShape.value = 'grow-shrink';
            addShape.dispatchEvent(new window.Event('change', { bubbles: true }));
            const shaped = await waitUntil(() => engine.getParams().arp.additive?.mode === 'grow-shrink'
              && engine.getParams().arp.additive.every === 3);
            if (!shaped) failures.push(`editor layers: picking Grow, then shrink left the engine at ${JSON.stringify(engine.getParams().arp.additive)}`);
            typeIntoKnob(addCell, '0');
            const addOff = await waitUntil(() => !('additive' in engine.getParams().arp));
            if (!addOff) failures.push(`editor layers: typing 0 into the Additive dial left the engine at ${JSON.stringify(engine.getParams().arp.additive)}`);
            if (addLine.textContent !== 'Additive: off') failures.push(`editor layers: the Additive line reads "${addLine.textContent}" at 0`);
          }
          engine.setParams({ arp: { mode: arpWas.mode, octaves: arpWas.octaves, gate: arpWas.gate, phase: arpWas.phase ?? null, additive: arpWas.additive ?? null } });
        }
      }
    }

    // UI review 2026-10-03, fix 18 — Advanced collapses to its Now. The tab
    // is three sections (Sound / Music / Presets), each a heading with ONE
    // "more" — rule-control.js's bindMore, the voice editor's own fold, so the
    // same .rule-more button reading more/less with aria-expanded. At the
    // default Rules show level a first visit shows fewer controls than with
    // every fold open (v0.0.222 showed them all: no folds at all); each "more"
    // reveals its own controls; a dial inside a fold still reaches the ENGINE;
    // "+ pool" (expert) opens every fold, as it opens every editor's; and the
    // tour never rings a control that is folded away.
    {
      const engine = window.__ambi4Engine;
      const panel = doc.getElementById('panel-advanced');
      const levelSelect = doc.getElementById('rule-level');
      const setLevel = (level) => {
        levelSelect.value = level;
        levelSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
      };
      const shown = (el) => {
        if (!el) return false;
        for (let n = el; n && n !== panel.parentNode; n = n.parentElement) if (n.hidden) return false;
        return true;
      };
      const visibleControls = () => Array.from(
        panel.querySelectorAll('button, input, select, textarea, .knob'),
      ).filter((el) => !el.matches('.knob-value') && shown(el)).length;
      const SECTIONS = {
        sound: ['repetition-dial'],
        music: ['timeSignature', 'structure'],
        presets: ['preset-save', 'preset-share', 'blank-slate', 'preset-copy'],
      };
      // Always on screen whatever the folds: each section's Now.
      const NOW = ['speed-dial-adv', 'track-voice-melody', 'voice-edit-toggle-pad', 'root', 'mode', 'preset-load'];
      if (!panel || !levelSelect || !engine) {
        failures.push('advanced sections: no Advanced panel, Rules show select or engine seam');
      } else {
        const levelWas = levelSelect.value;
        const tabWas = doc.querySelector('[role="tab"][aria-selected="true"]');
        doc.getElementById('tab-advanced').click();
        if (panel.hidden) failures.push('advanced sections: the Advanced tab did not open');
        for (const toggle of panel.querySelectorAll('.voice-edit-toggle[aria-expanded="true"]')) toggle.click();
        // Counted on a fixed scene: a drawn block structure shows its blocks
        // (tens of controls) and would make the count the draw's — so Drone.
        const structurePin = doc.getElementById('structure');
        const structurePinWas = structurePin ? structurePin.value : null;
        if (structurePin && structurePin.value !== 'drone') {
          structurePin.value = 'drone';
          structurePin.dispatchEvent(new window.Event('change', { bubbles: true }));
        }
        await new Promise((r) => setTimeout(r, 30));
        setLevel('advanced');
        const closedCount = visibleControls();
        const mores = {};
        for (const name of Object.keys(SECTIONS)) {
          const section = doc.getElementById(`adv-section-${name}`);
          const heading = section && section.querySelector('.adv-head .adv-title');
          const more = section && section.querySelector('.adv-head .rule-more');
          mores[name] = more;
          if (!section || !heading || !more) {
            failures.push(`advanced sections: no ${name} section with a heading and a "more" (the rule primitive's .rule-more)`);
            continue;
          }
          if (more.getAttribute('aria-expanded') !== 'false' || more.textContent !== 'more') failures.push(`advanced sections: ${name}'s "more" does not read as closed at the default level`);
          for (const id of SECTIONS[name]) {
            const el = doc.getElementById(id);
            if (!el) failures.push(`advanced sections: #${id} is gone — nothing may be removed`);
            else if (!section.contains(el)) failures.push(`advanced sections: #${id} is not in the ${name} section`);
            else if (shown(el)) failures.push(`advanced sections: #${id} shows before ${name}'s "more" is pressed`);
          }
        }
        for (const id of NOW) {
          if (!shown(doc.getElementById(id))) failures.push(`advanced sections: #${id} (a section's Now) is not on screen at the default level`);
        }
        // The drives' seam names the real "more" that opens a folded control.
        const foldMore = typeof window.__ambi4FoldMore === 'function' ? window.__ambi4FoldMore : null;
        if (!foldMore) failures.push('advanced sections: no window.__ambi4FoldMore seam for the browser drives');
        else {
          for (const [selector, want] of [['#structure', '#adv-more-music'], ['#preset-share', '#adv-more-presets'], ['#repetition-dial', '#adv-more-sound'], ['#root', null], ['#nothing-here', null]]) {
            if (foldMore(selector) !== want) failures.push(`advanced sections: __ambi4FoldMore('${selector}') reads ${foldMore(selector)}, not ${want}`);
          }
        }
        // Each "more" reveals its own controls, and only its own.
        for (const [name, more] of Object.entries(mores)) {
          if (!more) continue;
          more.click();
          if (more.getAttribute('aria-expanded') !== 'true' || more.textContent !== 'less') failures.push(`advanced sections: ${name}'s "more" does not read as open after a press`);
          for (const id of SECTIONS[name]) {
            if (!shown(doc.getElementById(id))) failures.push(`advanced sections: pressing ${name}'s "more" did not reveal #${id}`);
          }
          for (const [other, ids] of Object.entries(SECTIONS)) {
            if (other === name || !mores[other] || mores[other].getAttribute('aria-expanded') === 'true') continue;
            for (const id of ids) if (shown(doc.getElementById(id))) failures.push(`advanced sections: ${name}'s "more" revealed ${other}'s #${id}`);
          }
        }
        const openCount = visibleControls();
        console.log(`advanced sections: a first visit shows ${closedCount} controls; every fold open, ${openCount}`);
        if (!(closedCount < openCount) || openCount - closedCount < 10) failures.push(`advanced sections: the folds hide ${openCount - closedCount} controls (${closedCount} of ${openCount} shown) — fewer than ten`);
        // A dial inside a fold, used, reaches the ENGINE; so does a select.
        const reprise = doc.getElementById('repetition-dial');
        const repWas = engine.getParams().repetition;
        const repTo = Math.abs(repWas - 0.37) < 0.01 ? 0.61 : 0.37;
        if (!reprise || !typeIntoKnob(reprise, String(Math.round(repTo * 100)))) {
          failures.push('advanced sections: the folded Reprise dial has no typed readout');
        } else {
          const landed = await waitUntil(() => Math.abs(engine.getParams().repetition - repTo) < 0.006);
          if (!landed) failures.push(`advanced sections: typing ${Math.round(repTo * 100)} % into the folded Reprise dial left the engine at ${engine.getParams().repetition}`);
        }
        const structure = doc.getElementById('structure');
        if (structure) {
          const structWas = structure.value;
          const other = [...structure.options].map((o) => o.value).find((v) => v !== structWas && v !== 'custom');
          structure.value = other;
          structure.dispatchEvent(new window.Event('change', { bubbles: true }));
          if (engine.getParams().structure !== other) failures.push(`advanced sections: picking ${other} in the folded Structure left the engine at ${engine.getParams().structure}`);
          structure.value = structWas;
          structure.dispatchEvent(new window.Event('change', { bubbles: true }));
        }
        engine.setParams({ repetition: repWas });
        // Fold back by "less"; then "+ pool" opens every fold, and "what
        // plays" closes them again.
        for (const more of Object.values(mores)) if (more && more.getAttribute('aria-expanded') === 'true') more.click();
        if (visibleControls() !== closedCount) failures.push(`advanced sections: pressing "less" on every section did not return to the first visit's ${closedCount} controls (${visibleControls()})`);
        setLevel('expert');
        for (const [name, ids] of Object.entries(SECTIONS)) {
          for (const id of ids) if (!shown(doc.getElementById(id))) failures.push(`advanced sections: Rules show "+ pool" left ${name}'s #${id} folded`);
          if (mores[name] && mores[name].getAttribute('aria-expanded') !== 'true') failures.push(`advanced sections: at "+ pool" ${name}'s "more" does not read as open`);
        }
        setLevel('simple');
        for (const [name, ids] of Object.entries(SECTIONS)) {
          for (const id of ids) if (shown(doc.getElementById(id))) failures.push(`advanced sections: Rules show "what plays" left ${name}'s #${id} open`);
        }
        // The tour: every target is on screen once its step runs, with every
        // fold closed beforehand (Share sits in Presets' fold).
        setLevel('advanced');
        const steps = readTutorialSteps();
        const tourPanel = doc.getElementById('tutorial-panel');
        if (tourPanel.hidden) doc.getElementById('tutorial-toggle').click();
        const back = doc.getElementById('tutorial-prev');
        for (let guard = 0; !back.disabled && guard < 40; guard += 1) back.click();
        let foldedTargets = 0;
        for (const [index, step] of steps.entries()) {
          if (index > 0) doc.getElementById('tutorial-next').click();
          if (!step.target) continue;
          const target = doc.querySelector(step.target);
          if (target && panel.contains(target) && !shown(target)) {
            foldedTargets += 1;
            failures.push(`advanced sections: tour step ${index + 1} rings ${step.target}, which is folded away`);
          }
        }
        doc.getElementById('tutorial-close').click();
        console.log(`advanced sections: ${steps.filter((s) => s.tab === 'advanced').length} Advanced tour steps, ${foldedTargets} ringing a folded control`);
        if (structurePin && structurePin.value !== structurePinWas) {
          structurePin.value = structurePinWas;
          structurePin.dispatchEvent(new window.Event('change', { bubbles: true }));
        }
        setLevel(levelWas);
        if (tabWas) tabWas.click();
      }
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
              // v0.0.193: may it spread, and the unit its readout is printed in
              // — the format a loop derives. (Whether it OPENS as a span is
              // state a genre sets, so it is not pinned here.)
              spread: cell.querySelector('.knob') ? cell.querySelector('.knob').getAttribute('data-spread') : null,
              unit: cell.querySelector('.knob') ? readoutUnit(cell.querySelector('.knob').getAttribute('aria-valuetext')) : null,
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

    // v0.0.196 — the rule primitive: the melody editor's voice rule is one
  // .rule with three layers; the level select decides which open by default
  // (advanced = Now + Chance) and "more" opens the rest in place; the Chance
  // layer holds the knob; the When select and the pool Edit… keep their ids.
  {
    const editor = await openEditor('melody');
    const rule = editor && editor.querySelector('.rule[data-rule="voice"]');
    if (!rule) failures.push('the melody editor has no voice rule on the primitive');
    else {
      const layer = (name) => rule.querySelector(`.rule-layer[data-layer="${name}"]`);
      for (const name of ['now', 'chance', 'pool']) if (!layer(name)) failures.push(`the voice rule has no ${name} layer`);
      if (layer('chance') && layer('chance').hidden) failures.push('at the default level (advanced) the Chance layer is hidden');
      if (layer('pool') && !layer('pool').hidden) failures.push('at the default level (advanced) the Pool layer is open');
      if (!rule.querySelector('.rule-chance-slot .knob, .rule-chance-slot input[type="range"]')) failures.push('the Chance layer holds no dial');
      if (!rule.querySelector('#voice-rule-when-melody')) failures.push('the When select lost its id');
      if (!rule.querySelector('#voice-rule-pool-melody')) failures.push('the pool Edit… lost its id');
      const nowText = rule.querySelector('.rule-now-value') ? rule.querySelector('.rule-now-value').textContent : '';
      if (!nowText) failures.push('the Now layer names no voice');
      const more = rule.querySelector('.rule-more');
      if (more) { more.click(); if (layer('pool').hidden) failures.push('"more" did not open the Pool layer in place'); }
      const level = doc.getElementById('rule-level');
      if (!level) failures.push('no #rule-level select');
      else {
        level.value = 'simple';
        level.dispatchEvent(new window.Event('change', { bubbles: true }));
        if (!layer('chance').hidden) failures.push('level simple did not hide the Chance layer');
        level.value = 'expert';
        level.dispatchEvent(new window.Event('change', { bubbles: true }));
        if (layer('pool').hidden) failures.push('level expert did not open the Pool layer');
        level.value = 'advanced';
        level.dispatchEvent(new window.Event('change', { bubbles: true }));
      }
    }
  }

  // v0.0.203 — the bass groove rule on the primitive: Now is four pickers,
  // Chance a dial with When, Pool an inline list. A pick writes the ENGINE's
  // rule (not just the select) and holds it; Add what plays grows the pool.
  {
    const engine = window.__ambi4Engine;
    const editor = await openEditor('bass');
    const rule = editor && editor.querySelector('.rule[data-rule="groove"]');
    if (!rule) failures.push('the bass editor has no groove rule on the primitive');
    else {
      const layer = (name) => rule.querySelector(`.rule-layer[data-layer="${name}"]`);
      for (const name of ['now', 'chance', 'pool']) if (!layer(name)) failures.push(`the groove rule has no ${name} layer`);
      if (!rule.querySelector('.rule-chance-slot .knob, .rule-chance-slot input[type="range"]')) failures.push('the groove Chance layer holds no dial');
      if (!rule.querySelector('#groove-rule-when')) failures.push('the groove When select lost its id');
      if (!rule.querySelector('#groove-rule-pool')) failures.push('the groove pool Edit… lost its id');
      for (const field of ['feel', 'articulation', 'anchor', 'cells']) {
        if (!rule.querySelector(`#groove-now-${field}`)) failures.push(`the groove Now has no ${field} picker`);
      }
      const feel = rule.querySelector('#groove-now-feel');
      if (feel) {
        feel.value = 'staccato';
        feel.dispatchEvent(new window.Event('change', { bubbles: true }));
        const stored = engine.getParams().tracks.bass.grooveRule;
        if (!stored || !stored.now || stored.now.feel !== 'staccato') failures.push(`a feel pick did not reach the engine: ${JSON.stringify(stored)}`);
        else if (stored.chance !== 0) failures.push(`a feel pick should hold (Chance 0), engine has ${stored.chance}`);
        else if (!['articulation', 'anchor', 'cells'].every((f) => f in stored.now)) failures.push(`a pick should write all four choices as Now: ${JSON.stringify(stored.now)}`);
      }
      const edit = rule.querySelector('#groove-rule-pool');
      const panel = rule.querySelector('#groove-pool-panel');
      const add = rule.querySelector('#groove-pool-add');
      if (!panel || !add) failures.push('the groove pool has no inline panel or Add what plays');
      else {
        if (edit) edit.click();
        if (panel.hidden) failures.push('Edit… did not open the groove pool');
        add.click();
        const pool = engine.getParams().tracks.bass.grooveRule.pool;
        if (pool.length !== 1 || pool[0].feel !== 'staccato') failures.push(`Add what plays did not put the held groove in the engine's pool: ${JSON.stringify(pool)}`);
        const summary = rule.querySelector('.rule-pool-summary');
        if (summary && !/Staccato/.test(summary.textContent)) failures.push(`the pool summary does not name the groove: "${summary.textContent}"`);
      }
    }
  }

  // The kit's tab rules (variant schedule and fills) under the percussion
  // grid's tab strip, on the rule primitive. Hidden with one tab; with three,
  // a Variant and a Fill rule; the pool editor ticks a tab into the fill pool,
  // the typed Chance reaches the engine's fillRule, a held Variant hides the
  // Shuffle weights it supersedes, and Back to Auto clears the key again.
  {
    const engine = window.__ambi4Engine;
    const editor = await openEditor('percussion');
    const kitTabs = () => engine.getParams().tracks.percussion.sequencers.length;
    const host = editor && editor.querySelector('.seq-tab-rules');
    if (!host) failures.push('the percussion grid has no kit tab rules under its tab strip');
    else {
      const addTab = editor.querySelector('.seq-add');
      for (let i = 0; i < 3 && kitTabs() < 3 && addTab; i++) {
        addTab.click();
        await waitUntil(() => kitTabs() >= i + 2);
      }
      if (kitTabs() < 3) failures.push(`adding kit tabs left ${kitTabs()}`);
      if (host.hidden) failures.push('with three tabs the kit tab rules are still hidden');
      const variant = host.querySelector('.rule[data-rule="kit-variant"]');
      const fill = host.querySelector('.rule[data-rule="kit-fill"]');
      if (!variant || !fill) failures.push('the kit tab rules lack a Variant or a Fill rule');
      if (variant && !/Tab \d/.test(variant.querySelector('.rule-now-value').textContent)) failures.push(`the Variant's Now names no tab: ${JSON.stringify(variant.querySelector('.rule-now-value').textContent)}`);
      const poolEdit = doc.getElementById('kit-fill-pool');
      if (!poolEdit) failures.push('the Fill rule has no pool Edit…');
      else {
        poolEdit.click();
        const tick = doc.querySelector('#kit-fill-pool-editor .seq-tab-pool-row[data-tab="2"] input[type="checkbox"]');
        if (!tick) failures.push('the fill pool editor lists no Tab 3');
        else {
          tick.checked = true;
          tick.dispatchEvent(new window.Event('change', { bubbles: true }));
          const pooled = await waitUntil(() => {
            const rule = engine.getParams().tracks.percussion.fillRule;
            return rule && rule.pool.length === 1 && rule.pool[0].tab === 2;
          });
          if (!pooled) failures.push(`ticking Tab 3 left the engine's fill rule at ${JSON.stringify(engine.getParams().tracks.percussion.fillRule)}`);
        }
        const readout = fill && fill.querySelector('.rule-chance-slot .knob-value');
        if (!readout) failures.push('the Fill rule\'s Chance layer holds no dial readout');
        else {
          readout.click();
          const edit = fill.querySelector('.rule-chance-slot .knob-value-edit');
          if (!edit) failures.push('clicking the Fill chance readout did not open its typed editor');
          else {
            edit.value = '25';
            edit.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            const landed = await waitUntil(() => {
              const rule = engine.getParams().tracks.percussion.fillRule;
              return rule && Math.abs(rule.chance - 0.25) < 1e-9;
            });
            if (!landed) failures.push(`typing 25 into the Fill chance left ${JSON.stringify(engine.getParams().tracks.percussion.fillRule)}`);
          }
        }
      }
      const variantWhen = doc.getElementById('kit-variant-when');
      if (!variantWhen) failures.push('the Variant rule lost its When select id');
      else {
        variantWhen.value = 'section';
        variantWhen.dispatchEvent(new window.Event('change', { bubbles: true }));
        const ruled = await waitUntil(() => {
          const rule = engine.getParams().tracks.percussion.variantRule;
          return rule && rule.when === 'section' && rule.chance === null;
        });
        if (!ruled) failures.push(`the Variant's When left ${JSON.stringify(engine.getParams().tracks.percussion.variantRule)} (want when section, chance still Auto)`);
        const weightBox = editor.querySelector('.seq-weight');
        if (weightBox && weightBox.hidden) failures.push('an Auto variant rule hid the Shuffle weights it follows');
        const vReadout = variant.querySelector('.rule-chance-slot .knob-value');
        if (!vReadout) failures.push('the Variant rule\'s Chance layer holds no dial readout');
        else {
          vReadout.click();
          const edit = variant.querySelector('.rule-chance-slot .knob-value-edit');
          if (!edit) failures.push('clicking the Variant chance readout did not open its typed editor');
          else {
            edit.value = '0';
            edit.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            const held = await waitUntil(() => engine.getParams().tracks.percussion.variantRule?.chance === 0);
            if (!held) failures.push(`typing 0 into the Variant chance left ${JSON.stringify(engine.getParams().tracks.percussion.variantRule)}`);
            else if (weightBox && !weightBox.hidden) failures.push('a held Variant left the Shuffle weight box on screen, a control the engine now ignores');
          }
        }
        doc.getElementById('kit-variant-pool')?.click();
        const back = [...doc.querySelectorAll('#kit-variant-pool-editor button')].find((b) => /Back to Auto/.test(b.textContent));
        if (!back) failures.push('the Variant pool editor has no Back to Auto');
        else {
          back.click();
          const cleared = await waitUntil(() => !('variantRule' in engine.getParams().tracks.percussion));
          if (!cleared) failures.push('Back to Auto did not clear the engine\'s variant rule');
        }
      }
      // Leave the kit as the rest of the suite found it: one tab, no rules.
      engine.setParams({ tracks: { percussion: { fillRule: null, variantRule: null } } });
    }
  }

  // "Chord loop as voiced" — the chord loop's voicing as a rule on the
  // primitive, beside the chords: three layers, its own When (each time round /
  // section / piece), and every edit asserted at the ENGINE, not the readout.
  {
    const engine = window.__ambi4Engine;
    const host = doc.getElementById('hook-rule-host');
    const rule = host && host.querySelector('.rule[data-rule="hook"]');
    if (!rule) failures.push('the chord loop has no voicing rule on the primitive (#hook-rule-host .rule[data-rule="hook"])');
    else if (!engine) failures.push('no engine seam for the chord loop rule');
    else {
      const layer = (name) => rule.querySelector(`.rule-layer[data-layer="${name}"]`);
      for (const name of ['now', 'chance', 'pool']) if (!layer(name)) failures.push(`the voicing rule has no ${name} layer`);
      if (!rule.querySelector('.rule-chance-slot .knob, .rule-chance-slot input[type="range"]')) failures.push('the voicing rule\'s Chance layer holds no dial');
      const when = doc.getElementById('hook-rule-when');
      const whenValues = when ? [...when.options].map((o) => o.value).join(',') : '';
      if (whenValues !== 'pass,section,piece') failures.push(`the voicing rule's When offers ${JSON.stringify(whenValues)}, not pass,section,piece`);
      const before = engine.getParams().harmony;
      if ('voicing' in before || 'hookRule' in before) failures.push('a fresh boot already carries a voicing or loop rule — stored pieces would not be byte-identical');
      rule.querySelector('.rule-now-value').click();
      const inv = doc.getElementById('hook-voicing-inv-0');
      if (!inv) failures.push('opening Now did not show the per-chord voicing editor (#hook-voicing-inv-0)');
      else {
        inv.value = '1';
        inv.dispatchEvent(new window.Event('change', { bubbles: true }));
        const v = engine.getParams().harmony.voicing;
        if (!Array.isArray(v) || !v[0] || v[0].inversion !== 1) failures.push(`an inversion picked in Now did not reach the engine: ${JSON.stringify(v)}`);
        if (!/1st/.test(rule.querySelector('.rule-now-value').textContent)) failures.push('the Now readout does not name the inversion just set');
      }
      if (when) {
        when.value = 'section';
        when.dispatchEvent(new window.Event('change', { bubbles: true }));
        const r = engine.getParams().harmony.hookRule;
        if (!r || r.when !== 'section') failures.push(`the voicing rule's When did not reach the engine: ${JSON.stringify(r)}`);
      }
      const edit = doc.getElementById('hook-rule-pool');
      if (!edit) failures.push('the voicing rule\'s pool Edit… lost its id');
      else {
        edit.click();
        const add = doc.getElementById('hook-pool-add-now');
        if (!add) failures.push('the voicing pool editor has no Add the Now');
        else {
          add.click();
          const pool = engine.getParams().harmony.hookRule?.pool;
          if (!Array.isArray(pool) || pool.length !== 1 || pool[0].voicing[0].inversion !== 1) failures.push(`Add the Now did not reach the engine's pool: ${JSON.stringify(pool)}`);
          const remove = doc.querySelector('#hook-pool-editor .hook-pool-remove');
          if (remove) remove.click();
        }
        edit.click();
      }
      // Back to nothing: When to each time round with an empty pool and Auto
      // drops the rule, and The loop's own drops the voicing.
      if (when) {
        when.value = 'pass';
        when.dispatchEvent(new window.Event('change', { bubbles: true }));
      }
      doc.getElementById('hook-voicing-clear')?.click();
      const after = engine.getParams().harmony;
      if ('voicing' in after) failures.push('The loop\'s own did not clear the voicing at the engine');
      if ('hookRule' in after) failures.push(`a rule back at Auto, each time round, empty pool was not dropped: ${JSON.stringify(after.hookRule)}`);
      rule.querySelector('.rule-now-value').click();
    }
  }

  // The melody's motif as a rule: a second .rule on the primitive in the
  // melody editor. Now names the cell, Chance holds a dial, When offers the
  // motif's own moments (phrase / section / piece — a cell has no bar), and
  // the Pool editor opens in place and writes what it shows into the ENGINE.
  {
    const engine = window.__ambi4Engine;
    const editor = await openEditor('melody');
    const rule = editor && editor.querySelector('.rule[data-rule="motif"]');
    if (!rule) failures.push('the melody editor has no motif rule on the primitive');
    else {
      const layer = (name) => rule.querySelector(`.rule-layer[data-layer="${name}"]`);
      for (const name of ['now', 'chance', 'pool']) if (!layer(name)) failures.push(`the motif rule has no ${name} layer`);
      if (!rule.querySelector('.rule-chance-slot .knob, .rule-chance-slot input[type="range"]')) failures.push('the motif Chance layer holds no dial');
      const nowText = rule.querySelector('.rule-now-value') ? rule.querySelector('.rule-now-value').textContent : '';
      if (!nowText) failures.push('the motif Now layer says nothing');
      const when = rule.querySelector('#motif-rule-when');
      const whenValues = when ? [...when.options].map((o) => o.value).join(',') : '';
      if (whenValues !== 'phrase,section,piece') failures.push(`the motif When offers "${whenValues}", not phrase,section,piece`);
      if (when) {
        when.value = 'phrase';
        when.dispatchEvent(new window.Event('change', { bubbles: true }));
        const stored = engine.getParams().tracks.melody.motifRule;
        if (!stored || stored.when !== 'phrase') failures.push(`When "each phrase" left the engine's motif rule at ${JSON.stringify(stored)}`);
      }
      const edit = rule.querySelector('#motif-rule-pool');
      if (!edit) failures.push('the motif pool Edit… has no id');
      else {
        edit.click();
        const box = editor.querySelector('#motif-pool-editor');
        if (!box) failures.push('the motif Pool Edit… did not open its editor in place');
        else {
          const rows = [...box.querySelectorAll('.motif-pool-row')];
          if (rows.length !== 5) failures.push(`the motif pool editor shows ${rows.length} developments, not 5`);
          for (const row of rows) {
            if (row.dataset.op === 'repeat') continue;
            const input = row.querySelector('input');
            input.value = '0';
            input.dispatchEvent(new window.Event('change', { bubbles: true }));
          }
          const pool = engine.getParams().tracks.melody.motifRule && engine.getParams().tracks.melody.motifRule.pool;
          if (!Array.isArray(pool) || pool.length !== 1 || pool[0].id !== 'repeat') {
            failures.push(`zeroing every development but Repeat left the engine's pool at ${JSON.stringify(pool)}`);
          }
          const summary = rule.querySelector('.rule-pool-summary') ? rule.querySelector('.rule-pool-summary').textContent : '';
          if (!/^Repeat/.test(summary)) failures.push(`the motif pool summary reads "${summary}" after the edit`);
          const own = box.querySelector('.motif-pool-auto');
          if (own) own.click();
          const after = engine.getParams().tracks.melody.motifRule;
          if (!after || after.pool !== null) failures.push(`"Engine's own mix" left the pool at ${JSON.stringify(after && after.pool)}, not null`);
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
            // v0.0.193: the unit the slider's readout is printed in.
            unit: wrap.querySelector('.value-readout') ? readoutUnit(wrap.querySelector('.value-readout').textContent) : null,
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
      // v0.0.206: a fresh visit draws a genre, and a genre may ship its own
      // patch for the voice (Synthwave's Poly saw) — then the line describes
      // that, and the picker reads it as factory, not edited. Skip those.
      const enginePatches = window.__ambi4Engine && window.__ambi4Engine.getParams().patches;
      if (enginePatches && enginePatches[track] && enginePatches[track][select.value]) continue;
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
  })();

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
  await (async () => {
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
      // 2026-10-09 (owner): Surprise me reaches every stock genre, the
      // unlisted ones too — with two public genres it was a coin flip. Forty
      // draws from twelve genres, ten of them unlisted: a draw that never
      // leaves the public two fails; a drawn unlisted genre must be named by
      // the picker while it plays; and no draw repeats the genre in play.
      {
        const drawn = new Set();
        let previous = select.value;
        let repeated = 0;
        let unnamed = 0;
        for (let i = 0; i < 40; i++) {
          select.value = 'surprise';
          select.dispatchEvent(new window.Event('change', { bubbles: true }));
          const now = select.value;
          if (!now.startsWith('g:')) { unnamed += 1; continue; }
          if (now === previous) repeated += 1;
          drawn.add(now.slice(2));
          previous = now;
        }
        const hiddenDrawn = [...drawn].filter((slug) => HIDDEN.has(slug));
        if (!hiddenDrawn.length) failures.push(`Surprise me never left the listed genres in 40 draws (drew ${[...drawn].join(', ')})`);
        if (drawn.size < 5) failures.push(`Surprise me drew only ${drawn.size} distinct genres in 40 draws`);
        if (unnamed) failures.push(`${unnamed} Surprise me draws left the picker not naming the genre that plays`);
        if (repeated) failures.push(`${repeated} Surprise me draws landed on the genre already playing`);
      }
      // ui-review 2026-10-03 fix 13: favourites is the ☆ beside the picker,
      // not an action hiding among the genres.
      if (values().includes('favourites')) {
        failures.push('the genre list still carries a favourites entry — it is the ☆ button now');
      }
      const star = doc.getElementById('genre-favourites-toggle');
      if (!star || star.closest('.genre-row') !== select.closest('.genre-row')) {
        failures.push('there is no ☆ favourites button (#genre-favourites-toggle) beside the genre picker');
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
      const starButton = doc.getElementById('genre-favourites-toggle');
      const genreBefore = select.value;
      starButton?.click();
      const editor = doc.getElementById('genre-favourites');
      const boxes = editor
        ? Array.from(editor.querySelectorAll('.genre-fav-item input[type="checkbox"]'))
        : [];
      const hideOthers = doc.getElementById('genre-hide-others');
      if (!editor || editor.hidden) {
        failures.push('the ☆ button did not open the favourites editor');
      }
      if (select.value !== genreBefore) {
        failures.push(`opening favourites changed the genre pick ("${genreBefore}" → "${select.value}")`);
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
        if (!values().includes('surprise')) {
          failures.push('hide-non-favourites also pruned the Surprise me entry');
        }
        if (starButton && starButton.textContent !== '★') {
          failures.push(`the favourites button does not fill once a genre is a favourite (reads "${starButton.textContent}")`);
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
  })();
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
  await (async () => {
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
  })();

  // v0.0.178 — unit 10: the Rules panel shows the genre's essence, and an
  // edit reaches the ENGINE. Pin the genre first (a fresh visit draws a
  // random one). The Tempo dial's typed readout takes "lo-hi" — the same
  // click-to-type every dial has — so the test edits through the real
  // control, then Apply, then reads the engine's stored bpm, not the readout.
  await (async () => {
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
          // v0.0.198: the auto ladder (owner ruling 2026-09-25) — the Joins
          // at dial on the melody's line-up row. Unruled, it must show the
          // EFFECTIVE threshold (the registry floor), not a blank/zero dial;
          // editing it and pressing Apply must reach the engine's params
          // through the same path as every other line-up field.
          const melodyRow = doc.querySelector('#genre-rules-lineup-ui .rules-lineup-row[data-track="melody"]');
          const joinsCell = melodyRow && melodyRow.querySelector('.rules-dial[data-field="essence.perTrack.melody.autoThreshold"]');
          if (!joinsCell) {
            failures.push('the melody line-up row has no Joins at dial');
          } else {
            const floorPct = Math.round(engineModule.AUTO_THRESHOLDS.melody * 100);
            const readoutEl = joinsCell.querySelector('.knob-value');
            if (readoutEl && !readoutEl.textContent.includes(`${floorPct}%`)) {
              failures.push(`the unruled Joins at dial reads ${JSON.stringify(readoutEl.textContent)}, expected the floor ${floorPct}%`);
            }
            if (readoutEl) {
              readoutEl.click();
              const edit = joinsCell.querySelector('.knob-value-edit');
              if (!edit) {
                failures.push('clicking the Joins at readout did not open its typed editor');
              } else {
                edit.value = '0.9';
                edit.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
                doc.getElementById('genre-rules-apply').click();
                const landed = await waitUntil(() => engine.getParams().tracks.melody
                  && engine.getParams().tracks.melody.autoThreshold === 0.9);
                if (!landed) {
                  failures.push(`Apply with Joins at 90% left the engine at ${JSON.stringify(engine.getParams().tracks.melody && engine.getParams().tracks.melody.autoThreshold)}`);
                }
              }
            }
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
            const mineGroup = () => Array.from(doc.querySelectorAll('#genre-select optgroup')).find((g) => g.label === 'User');
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
                    // v0.0.198: Save as my genre carries the ruled auto-ladder threshold too.
                    const carriedMelody = decoded.g && decoded.g.essence && decoded.g.essence.instrumentation
                      && decoded.g.essence.instrumentation.perTrack && decoded.g.essence.instrumentation.perTrack.melody;
                    if (!carriedMelody || carriedMelody.autoThreshold !== 0.9) failures.push(`the carried genre lost its ruled Joins at threshold (${JSON.stringify(carriedMelody && carriedMelody.autoThreshold)})`);
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
  })();

  // ---- v23 fallback table is still the built-in six -------------------------
  // FALLBACK_TRACKS is the branch an engine bundle WITHOUT getTracks() boots
  // on, and an engine that can addTrack necessarily HAS getTracks() — so that
  // branch can never meet a seventh track and the table stays six forever. The
  // comparison is against the MODULE registry (built-ins), never the live
  // instance list, or adding a track in this harness would fail a test about
  // something else entirely.
  await (async () => {
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
  })();

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
  await (async () => {
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

        // v0.0.238: the key-to-ear delay is said, not hidden. The line is
        // always there (nothing appears or moves); off it invites, on it
        // reports what this browser can measure — here, a harness with no
        // output latency and no offline renderer, which it must say plainly.
        const latency = doc.getElementById('play-along-latency');
        const invite = latency ? latency.textContent : '';
        if (!latency || !/Press Keys/.test(invite)) failures.push(`the play-along latency line is missing or does not invite (${JSON.stringify(invite)})`);
        toggle.click();
        if (toggle.getAttribute('aria-pressed') !== 'true') {
          failures.push('clicking Play along did not arm it');
        }
        if (latency && !await waitUntil(() => latency.textContent !== invite)) {
          failures.push('arming the keys left the latency line on its invitation');
        } else if (latency && !/does not report its output delay|ms from key to ear/.test(latency.textContent)) {
          failures.push(`the armed latency line said ${JSON.stringify(latency.textContent)}`);
        }
        press('z');
        const sounded = readout.textContent;
        if (!/^[A-G]/.test(sounded)) {
          failures.push(`pressing z with Play along armed left the readout at "${sounded}"`);
        }
        release('z');

        // v0.0.240: the touch surface. Read at the ENGINE: the page's noteOn
        // and noteOff calls are wrapped, so a pad that lights but never
        // reaches the engine is caught. Velocity is the strike position (top
        // soft, bottom loud) or a real pressure; each pointer is its own note.
        {
          const engineRef = window.__ambi4Engine;
          const surface = doc.getElementById('play-along-pads');
          const calls = [];
          const realOn = engineRef.noteOn;
          const realOff = engineRef.noteOff;
          engineRef.noteOn = function (track, midi, velocity) { calls.push(['on', track, midi, velocity]); return realOn.apply(this, arguments); };
          engineRef.noteOff = function (track, midi) { calls.push(['off', track, midi]); return realOff.apply(this, arguments); };
          const pointer = (el, type, init) => {
            const event = new window.Event(type, { bubbles: true, cancelable: true });
            for (const [k, v] of Object.entries(init)) Object.defineProperty(event, k, { value: v });
            el.dispatchEvent(event);
          };
          try {
            const keys = surface ? [...surface.querySelectorAll('.play-along-pad')] : [];
            if (keys.length !== 13) {
              failures.push(`touch keys: ${keys.length} keys on the melody, not 13 (an octave and its top note)`);
            } else {
              const c = keys[0];
              c.getBoundingClientRect = () => ({ top: 0, height: 100, left: 0, width: 30, bottom: 100, right: 30 });
              pointer(c, 'pointerdown', { pointerId: 11, pointerType: 'touch', pressure: 0.5, clientY: 10 });
              pointer(keys[4], 'pointerdown', { pointerId: 12, pointerType: 'pen', pressure: 0.9, clientY: 0 });
              keys[4].getBoundingClientRect = c.getBoundingClientRect;
              const ons = calls.filter((x) => x[0] === 'on');
              if (ons.length !== 2) failures.push(`touch keys: two fingers made ${ons.length} notes at the engine`);
              else {
                if (!(ons[0][3] < 0.5)) failures.push(`touch keys: a strike near the top of a key played at ${ons[0][3]}, not softly`);
                if (Math.abs(ons[1][3] - (0.25 + 0.75 * 0.9)) > 1e-6) failures.push(`touch keys: a pen at pressure 0.9 played at ${ons[1][3]}, not from its pressure`);
                if (ons[1][2] - ons[0][2] !== 4) failures.push(`touch keys: the fifth key is ${ons[1][2] - ons[0][2]} semitones above the first, not 4`);
              }
              pointer(c, 'pointerup', { pointerId: 11 });
              pointer(keys[4], 'pointercancel', { pointerId: 12 });
              const offs = calls.filter((x) => x[0] === 'off');
              if (offs.length !== 2) failures.push(`touch keys: lifting two fingers sent ${offs.length} note-offs`);
            }
            // Review follow-up: letting go of everything (Keys off, a blur)
            // stopped the notes but left a held pad lit, and still holding
            // its note, until the finger lifted.
            if (keys.length === 13) {
              pointer(keys[2], 'pointerdown', { pointerId: 13, pointerType: 'touch', pressure: 0.5, clientY: 10 });
              if (!keys[2].classList.contains('play-along-pad-down')) failures.push('touch keys: a held key is not lit — the release check proves nothing');
              toggle.click(); // Keys off
              if (keys[2].classList.contains('play-along-pad-down')) failures.push('touch keys: Keys off left a held key lit');
              const offsBefore = calls.filter((x) => x[0] === 'off').length;
              pointer(keys[2], 'pointerup', { pointerId: 13 });
              if (calls.filter((x) => x[0] === 'off').length !== offsBefore) failures.push('touch keys: a key released by Keys off still held its note until the finger lifted');
              toggle.click(); // back on, as the rest of this block expects
            }
            // The kit: one pad per lane, each landing on its own lane.
            picker.value = 'percussion';
            picker.dispatchEvent(new window.Event('change', { bubbles: true }));
            const pads = [...surface.querySelectorAll('.play-along-pad')];
            const lanes = engineRef.getParams().tracks.percussion.lanes || [];
            if (!lanes.length || pads.length !== lanes.length) {
              failures.push(`drum pads: ${pads.length} pads for ${lanes.length} lanes`);
            } else {
              const landed = pads.map((pad) => Math.min(lanes.length - 1, Math.floor(((Number(pad.dataset.midi) % 12) * lanes.length) / 12)));
              if (landed.some((lane, i) => lane !== i)) failures.push(`drum pads: pads land on lanes ${landed.join(',')}, not one each in order`);
            }
            picker.value = 'melody';
            picker.dispatchEvent(new window.Event('change', { bubbles: true }));
          } finally {
            engineRef.noteOn = realOn;
            engineRef.noteOff = realOff;
          }
        }

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

        // Follow my chords: off by default, and while on the notes HELD on
        // the computer keys and on a MIDI keyboard reach the engine's harmony
        // as a chord degree. Read at the ENGINE (getChordFollow), not at the
        // button: a toggle that lights and never feeds the engine is the
        // failure this block exists for. The key is pinned to C major first,
        // since a fresh visit draws a random one.
        {
          const engineRef = window.__ambi4Engine;
          const follow = doc.getElementById('play-along-follow');
          const rootSelect = doc.getElementById('root');
          const modeSelect = doc.getElementById('mode');
          if (!follow) {
            failures.push('Follow my chords: no toggle (#play-along-follow) beside the play-along keys');
          } else if (typeof engineRef.getChordFollow !== 'function') {
            failures.push('Follow my chords: the engine has no getChordFollow seam');
          } else {
            const stored = () => engineRef.getChordFollow().follow;
            if (follow.getAttribute('aria-pressed') !== 'false') failures.push('Follow my chords boots pressed — it is off until asked for');
            if (follow.disabled) failures.push('Follow my chords is disabled with Keys armed');
            if (!doc.querySelector('#follow-chords-info button')) failures.push('Follow my chords has no ⓘ');
            if (rootSelect && modeSelect) {
              rootSelect.value = 'C';
              rootSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
              modeSelect.value = 'ionian';
              modeSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
            }
            // Off: held keys leave the harmony alone.
            for (const k of ['b', 'm', '.']) press(k);
            if (stored() !== null) failures.push(`Follow my chords OFF, three held keys still set the engine's follow degree (${stored()})`);
            for (const k of ['b', 'm', '.']) release(k);
            follow.click();
            if (follow.getAttribute('aria-pressed') !== 'true') failures.push('clicking Follow my chords did not switch it on');
            // G4 B4 D5 held: V of C major, degree 4.
            for (const k of ['b', 'm', '.']) press(k);
            if (stored() !== 4) failures.push(`holding G B D in C major left the engine's follow degree at ${stored()}, not 4 (V)`);
            for (const k of ['b', 'm', '.']) release(k);
            if (stored() !== null) failures.push(`letting go of every key left the follow degree at ${stored()} — the piece must carry on`);
            // A MIDI keyboard is the same hands: D F A is ii.
            if (typeof midiMock.input.onmidimessage === 'function') {
              for (const n of [62, 65, 69]) midiMock.input.onmidimessage({ data: new Uint8Array([0x90, n, 90]) });
              if (stored() !== 1) failures.push(`holding D F A on MIDI left the follow degree at ${stored()}, not 1 (ii)`);
              // Switching Follow off while the keys are still down lets go of the harmony.
              follow.click();
              if (stored() !== null) failures.push(`switching Follow my chords off with keys held left the follow degree at ${stored()}`);
              for (const n of [62, 65, 69]) midiMock.input.onmidimessage({ data: new Uint8Array([0x80, n, 0]) });
            } else {
              follow.click();
            }
            if (follow.getAttribute('aria-pressed') !== 'false') failures.push('clicking Follow my chords again did not switch it off');
          }
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
        // Follow my chords never runs without the keys.
        const followAfter = doc.getElementById('play-along-follow');
        if (followAfter && !followAfter.disabled) failures.push('Follow my chords is still live with Keys switched off');
      }
    }
  })();

  // ---- v29 share names, sending end ----------------------------------------
  // Copying a link must show the link's three-word name: in the reserved line
  // under the Share row, in the share note, and as the suggested preset name
  // while the name box is still empty. The expected name is computed here from
  // the copied fragment, so a page that shows A name but not THE name fails.
  await (async () => {
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
        // Review fix: a link carrying the Sync lead (v0.0.259) was stamped
        // schema 1, and a v0.0.254-258 build, which knows schema 3, swapped
        // the unknown voice for the melody's default in silence. It is
        // stamped 4, the first number those builds do not know.
        {
          const voiceSelect = doc.getElementById('track-voice-melody');
          const was = voiceSelect ? voiceSelect.value : null;
          if (!voiceSelect || !voiceSelect.querySelector('option[value="sync"]')) {
            failures.push('the melody voice select offers no Sync lead to stamp a link with');
          } else {
            voiceSelect.value = 'sync';
            voiceSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
            clipboard.text = '';
            shareButton.click();
            await waitUntil(() => clipboard.text.includes('#'));
            const synced = decodeCopiedLink();
            if (!synced || synced.v !== 4) failures.push(`a link carrying the Sync lead is stamped schema ${JSON.stringify(synced && synced.v)}, not 4 — a v0.0.254-258 build would drop the voice without a word`);
            voiceSelect.value = was;
            voiceSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
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
  })();

  // ---- v0.0.202 preset blocks, shown and taken over -----------------------
  // abab shows its own two blocks (not only Custom); the first edit turns the
  // structure Custom starting from exactly those blocks, with the edit — and
  // the ENGINE holds it, not just the DOM. A curve preset says it has none.
  await (async () => {
    const engine = window.__ambi4Engine;
    const select = doc.getElementById('structure');
    const builder = doc.getElementById('custom-structure-builder');
    const note = doc.getElementById('structure-blocks-note');
    if (!select || !builder || !note || !engine) {
      failures.push('preset blocks: the structure select, builder, note or engine seam is missing');
    } else {
      select.value = 'abab';
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
      const rows = () => doc.querySelectorAll('#structure-blocks .structure-block');
      if (builder.hidden) failures.push('preset blocks: ABAB chosen, but the blocks panel is hidden');
      if (rows().length !== 2) failures.push(`preset blocks: ABAB should show its 2 blocks, shows ${rows().length}`);
      if (!/ABAB's blocks/.test(note.textContent)) failures.push(`preset blocks: the note does not say whose blocks these are: ${JSON.stringify(note.textContent)}`);
      if (engine.getParams().structure !== 'abab') failures.push('preset blocks: showing the blocks must not change the structure');
      // UI review fix 11: the block's intensity is a dial (knob.js loads
      // here), typed through its readout as a person would.
      const intensity = rows()[1] && rows()[1].querySelector('.knob-cell.block-intensity-knob');
      if (!intensity) {
        failures.push('preset blocks: block 2 has no intensity dial');
      } else {
        if (rows()[1].querySelector('input[type="range"]')) failures.push('preset blocks: block 2 still carries a native intensity slider beside its dial');
        if (!typeIntoKnob(intensity, '90')) failures.push('preset blocks: the intensity dial has no typed readout');
        const p = engine.getParams();
        if (p.structure !== 'custom') failures.push(`preset blocks: an edit should take the structure over as Custom, engine has ${p.structure}`);
        if (select.value !== 'custom') failures.push('preset blocks: the select did not follow the takeover');
        const blocks = p.customStructure || [];
        if (blocks.length !== 2 || blocks[0].label !== 'A' || blocks[0].intensity !== 0.4 || blocks[1].label !== 'B' || blocks[1].intensity !== 0.9) {
          failures.push(`preset blocks: Custom should start from ABAB's blocks with the edit, engine has ${JSON.stringify(blocks)}`);
        }
      }
      select.value = 'waves';
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
      if (rows().length !== 0 && !doc.getElementById('structure-blocks').hidden) failures.push('preset blocks: Waves should show no blocks');
      if (!/16-bar swell/.test(note.textContent)) failures.push(`preset blocks: Waves should say it is a curve: ${JSON.stringify(note.textContent)}`);
    }
  })();

  // ---- v0.0.206 factory, edited and user ------------------------------------
  // His brief: good defaults, clarity when not on them, an easy way back.
  // A genre loads at FACTORY (its own shipped patches read as factory, not
  // edited); an edit shows under an Edited heading with Back to factory on the
  // row and beside the genre; a load clears the ENGINE's old edits (it merges
  // patches, so they used to sound on under a page that showed none) and
  // parks them under Edited; more than two changes ask first, listing them.
  await (async () => {
    const engine = window.__ambi4Engine;
    const genrePick = doc.getElementById('genre-select');
    const padSelect = doc.getElementById('track-voice-pad');
    const genreFactory = doc.getElementById('genre-factory');
    const loadSynthwave = async () => {
      genrePick.value = 'g:synthwave';
      genrePick.dispatchEvent(new window.Event('change', { bubbles: true }));
      await waitUntil(() => engine.getParams().genre === 'synthwave');
      await new Promise((r) => setTimeout(r, 80));
    };
    const typeInto = async (editor, field, value) => {
      const cell = editor.querySelector(`.patch-controls .knob-cell[data-field="${field}"]`);
      const readout = cell && cell.querySelector('.knob-value');
      if (!readout) return false;
      readout.click();
      const box = cell.querySelector('.knob-value-edit');
      if (!box) return false;
      box.value = String(value);
      box.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise((r) => setTimeout(r, 40));
      return true;
    };
    const near = (v, want) => (v && typeof v === 'object' ? Math.abs(v.min - want) < 0.05 : Math.abs(Number(v) - want) < 0.05);
    const padWarm = () => (engine.getParams().patches && engine.getParams().patches.pad && engine.getParams().patches.pad.warm) || {};
    if (!genrePick || !padSelect || !genreFactory || !engine || ![...genrePick.options].some((o) => o.value === 'g:synthwave')) {
      failures.push('factory: the genre picker, Synthwave, the pad picker, Back to factory or the engine seam is missing');
    } else {
      await loadSynthwave();
      for (const id of ['pad', 'arp', 'melody', 'bass', 'texture', 'percussion']) {
        const sel = doc.getElementById(`track-voice-${id}`);
        if (!sel) continue;
        if (!sel.querySelector('optgroup.stock-voices[label="Stock"]')) failures.push(`factory: ${id}'s picker has no Stock heading`);
        const live = sel.querySelector('.voice-live-option');
        if (live && live.selected && / · edited$/.test(live.textContent)) failures.push(`factory: factory Synthwave reads ${id} as edited ("${live.textContent}")`);
        const button = doc.getElementById(`track-factory-${id}`);
        if (button && !button.hidden) failures.push(`factory: ${id} offers Back to factory on a factory Synthwave`);
      }
      if (!genreFactory.hidden) failures.push('factory: Back to factory shows beside a factory Synthwave');

      padSelect.value = 'warm';
      padSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
      let editor = await openEditor('pad');
      await waitUntil(() => editor.querySelectorAll('.patch-controls .knob-cell[data-field="adsr.release"]').length === 1);
      if (!(await typeInto(editor, 'adsr.release', 2.5)) || !(await waitUntil(() => near(padWarm().adsr && padWarm().adsr.release, 2.5)))) {
        failures.push('factory: typing Release 2.5 on Warm did not reach the engine');
      } else {
        const edited = padSelect.querySelector('optgroup.edited-voices[label="Edited"] .voice-live-option');
        if (!edited || !edited.selected || edited.textContent !== 'Warm · edited') failures.push(`factory: an edited Warm is not shown selected under Edited (${edited ? JSON.stringify(edited.textContent) : 'absent'})`);
        const rowButton = doc.getElementById('track-factory-pad');
        if (!rowButton || rowButton.hidden) failures.push('factory: the pad row offers no Back to factory while Warm is edited');
        const genreOption = [...genrePick.options].find((o) => o.value === 'g:synthwave');
        if (!genreOption || !/ · edited$/.test(genreOption.textContent)) failures.push(`factory: the genre picker does not say Synthwave is edited (${genreOption && genreOption.textContent})`);
        if (genreFactory.hidden) failures.push('factory: no Back to factory beside the genre while a voice is edited');
        // One change: back at once, at the engine too.
        if (rowButton) rowButton.click();
        await new Promise((r) => setTimeout(r, 60));
        if (doc.getElementById('factory-confirm')) failures.push('factory: one change should not ask first');
        if (near(padWarm().adsr && padWarm().adsr.release, 2.5)) failures.push('factory: the row\'s Back to factory left Release 2.5 at the engine');
        if (rowButton && !rowButton.hidden) failures.push('factory: Back to factory still shows after going back');

        // A genre load clears the engine's edit and parks it under Edited.
        editor = await openEditor('pad');
        await typeInto(editor, 'adsr.release', 2.5);
        await waitUntil(() => near(padWarm().adsr && padWarm().adsr.release, 2.5));
        await loadSynthwave();
        if (near(padWarm().adsr && padWarm().adsr.release, 2.5)) failures.push('factory: a genre load left the old Release edit sounding at the engine');
        const draft = padSelect.querySelector('optgroup.edited-voices option[value="draft:warm"]');
        if (!draft) {
          failures.push('factory: the edit a genre load replaced is not parked under Edited');
        } else {
          padSelect.value = 'draft:warm';
          padSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
          if (!(await waitUntil(() => near(padWarm().adsr && padWarm().adsr.release, 2.5)))) failures.push('factory: picking the parked edit did not bring Release 2.5 back');
          // Picking Stock Warm plays factory and parks the edit again.
          padSelect.value = 'warm';
          padSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 60));
          if (near(padWarm().adsr && padWarm().adsr.release, 2.5)) failures.push('factory: picking Stock Warm kept the edit instead of the factory sound');
          if (!padSelect.querySelector('option[value="draft:warm"]')) failures.push('factory: picking Stock Warm lost the edit instead of parking it');
        }

        // Three changes: Back to factory beside the genre asks, and lists them.
        editor = await openEditor('pad');
        await typeInto(editor, 'adsr.release', 2.5);
        await typeInto(editor, 'adsr.attack', 0.9);
        await typeInto(editor, 'sends.delay', 0.7);
        await new Promise((r) => setTimeout(r, 60));
        genreFactory.click();
        // v0.0.207: Esc is Cancel — the dialog goes and nothing is undone.
        if (await waitUntil(() => doc.getElementById('factory-confirm'))) {
          doc.getElementById('factory-confirm').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          if (doc.getElementById('factory-confirm')) failures.push('factory: Esc did not cancel the confirmation');
          if (!near(padWarm().adsr && padWarm().adsr.release, 2.5)) failures.push('factory: Esc on the confirmation undid the changes');
          genreFactory.click();
        }
        const dialog = await waitUntil(() => doc.getElementById('factory-confirm'));
        if (!dialog) {
          failures.push('factory: three changes went back without asking');
        } else {
          const items = doc.querySelectorAll('#factory-confirm .factory-confirm-list li').length;
          const count = doc.querySelector('#factory-confirm .factory-confirm-count');
          if (items < 3 || !count || !/\d+ changes/.test(count.textContent)) failures.push(`factory: the confirmation does not count and list the changes (${items} listed, "${count && count.textContent}")`);
          doc.querySelector('#factory-confirm .factory-confirm-go').click();
          await new Promise((r) => setTimeout(r, 100));
          const warm = padWarm();
          if (near(warm.adsr && warm.adsr.release, 2.5) || near(warm.sends && warm.sends.delay, 0.7)) failures.push(`factory: Back to factory left edits at the engine (${JSON.stringify(warm)})`);
          if (!genreFactory.hidden) failures.push('factory: Back to factory still shows after the setup went back');
          if (engine.getParams().genre !== 'synthwave') failures.push('factory: Back to factory left Synthwave');
        }
      }
    }
  })();

  // ---- TODO "Factory, edited and your own" step 2: the leave-guard --------
  // Moving away from an EDITED voice asks first, in one dialog: Save changes
  // (a User voice) · Save as… · Revert to last save (a User voice whose save
  // differs from stock) · Reset to default (a stock voice) · Move on (parked
  // under Edited) · Keep editing (Cancel; Esc). Every path is asserted at the
  // ENGINE: a dialog that says Reset while the old patch plays is the failure
  // mode this repo keeps meeting. An unedited voice must move without asking.
  await (async () => {
    const engine = window.__ambi4Engine;
    const genrePick = doc.getElementById('genre-select');
    const padSelect = doc.getElementById('track-voice-pad');
    const forward = doc.getElementById('fast-forward');
    const guard = () => doc.getElementById('leave-guard');
    const settle = () => new Promise((r) => setTimeout(r, 60));
    const pick = async (select, value) => {
      select.value = value;
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
      await settle();
    };
    const typeInto = async (editor, field, value) => {
      const cell = editor.querySelector(`.patch-controls .knob-cell[data-field="${field}"]`);
      const readout = cell && cell.querySelector('.knob-value');
      if (!readout) return false;
      readout.click();
      const box = cell.querySelector('.knob-value-edit');
      if (!box) return false;
      box.value = String(value);
      box.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise((r) => setTimeout(r, 40));
      return true;
    };
    const release = (track, voice) => {
      const r = engine.getParams().patches?.[track]?.[voice]?.adsr?.release;
      return r && typeof r === 'object' ? r.min : Number(r);
    };
    const near = (a, b) => Math.abs(Number(a) - b) < 0.05;
    const voiceOf = (track) => engine.getParams().tracks[track].voice;
    const editPad = async (field, value) => {
      const editor = await openEditor('pad');
      await waitUntil(() => editor.querySelector(`.patch-controls .knob-cell[data-field="${field}"]`));
      return typeInto(editor, field, value);
    };
    const buttons = () => [...(guard()?.querySelectorAll('button') || [])].map((b) => b.textContent);
    if (!engine || !genrePick || !padSelect || !forward || ![...genrePick.options].some((o) => o.value === 'g:synthwave')) {
      failures.push('leave-guard: the engine seam, genre picker, pad picker, Next or Synthwave is missing');
    } else {
      await pick(genrePick, 'g:synthwave'); // an earlier block's edits move on (the harness answers)
      await waitUntil(() => engine.getParams().genre === 'synthwave');
      window.__leaveGuardManual = true;
      // Earlier blocks leave parked edits; clear them so "nothing parked" and
      // "parked" below are about this block's moves. Each draft is picked
      // (bringing it back) and put back to factory with the row's ↺ Factory.
      const backToFactory = async (track) => {
        const button = doc.getElementById(`track-factory-${track}`);
        if (!button || button.hidden) return;
        button.click();
        await settle();
        doc.querySelector('#factory-confirm .factory-confirm-go')?.click();
        await settle();
      };
      for (const track of ['pad', 'bass']) {
        const select = doc.getElementById(`track-voice-${track}`);
        for (let i = 0; i < 12; i += 1) {
          await backToFactory(track);
          const draft = select.querySelector('option[value^="draft:"]');
          if (!draft) break;
          await pick(select, draft.value);
        }
      }
      try {
        // An unedited voice moves at once.
        await pick(padSelect, 'warm');
        if (guard()) failures.push('leave-guard: picking a voice asked while nothing was edited');
        if (voiceOf('pad') !== 'warm') failures.push(`leave-guard: picking Warm on a factory pad left the engine on ${voiceOf('pad')}`);
        const stockVoices = (await import(pathToFileURL(join(repoRoot, 'src/scripts/engine-voices.js')).href)).VOICES;
        const factoryRelease = Number.isFinite(release('pad', 'warm')) ? release('pad', 'warm') : stockVoices.pad.warm.defaults.adsr.release;

        // Edited Warm → pick Glass: asks; the pick waits.
        if (!(await editPad('adsr.release', 2.5)) || !(await waitUntil(() => near(release('pad', 'warm'), 2.5)))) {
          failures.push('leave-guard: typing Release 2.5 on Warm did not reach the engine');
        }
        await pick(padSelect, 'glass');
        if (!guard()) {
          failures.push('leave-guard: leaving an edited Warm for Glass did not ask');
        } else {
          const b = buttons();
          for (const want of ['Save as…', 'Reset to default', 'Move on', 'Keep editing']) {
            if (!b.includes(want)) failures.push(`leave-guard: a stock voice's guard has no ${want} (${JSON.stringify(b)})`);
          }
          for (const not of ['Save changes', 'Revert to last save']) {
            if (b.includes(not)) failures.push(`leave-guard: a stock voice's guard offers ${not}, which only a User voice has`);
          }
          if (voiceOf('pad') !== 'warm') failures.push('leave-guard: the pick went ahead before the question was answered');
          // Keep editing: nothing moves, the edit keeps sounding.
          guard().querySelector('.leave-guard-cancel').click();
          await settle();
          if (guard()) failures.push('leave-guard: Keep editing did not close the dialog');
          if (voiceOf('pad') !== 'warm' || !near(release('pad', 'warm'), 2.5)) failures.push(`leave-guard: Keep editing did not leave the edit sounding (${voiceOf('pad')}, release ${release('pad', 'warm')})`);
          if (padSelect.value === 'glass') failures.push('leave-guard: Keep editing left the picker showing Glass');
        }
        // Esc is Keep editing.
        await pick(padSelect, 'glass');
        if (guard()) {
          guard().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          await settle();
          if (guard()) failures.push('leave-guard: Esc did not close the dialog');
          if (voiceOf('pad') !== 'warm' || !near(release('pad', 'warm'), 2.5)) failures.push('leave-guard: Esc moved on instead of cancelling');
        }

        // Closing the editor asks; Reset to default puts factory back at the engine.
        doc.getElementById('voice-edit-toggle-pad').click();
        await settle();
        if (!guard()) {
          failures.push('leave-guard: closing the editor on an edited Warm did not ask');
        } else {
          guard().querySelector('.leave-guard-reset').click();
          await settle();
          if (guard()) failures.push('leave-guard: Reset to default (one change) did not answer the guard');
          if (!near(release('pad', 'warm'), factoryRelease)) failures.push(`leave-guard: Reset to default left Release ${release('pad', 'warm')} at the engine, factory is ${factoryRelease}`);
          if (!doc.getElementById('voice-editor-pad').hidden) failures.push('leave-guard: the editor stayed open after Reset to default answered the close');
        }

        // Save as… makes a User voice and the pick goes ahead; nothing parks.
        await editPad('adsr.release', 2.5);
        await waitUntil(() => near(release('pad', 'warm'), 2.5));
        await pick(padSelect, 'glass');
        if (!guard()) {
          failures.push('leave-guard: the second edit of Warm did not ask on leaving');
        } else {
          guard().querySelector('.leave-guard-save-as').click();
          const box = guard().querySelector('.leave-guard-name-box');
          if (!box || box.closest('[hidden]')) failures.push('leave-guard: Save as… opened no name box');
          if (box) box.value = 'Guard pad';
          guard().querySelector('.leave-guard-save-as-go')?.click();
          await settle();
          if (guard()) failures.push('leave-guard: Save as… did not answer the guard');
          if (voiceOf('pad') !== 'glass') failures.push(`leave-guard: after Save as… the pick did not go ahead (engine on ${voiceOf('pad')})`);
          if (near(release('pad', 'warm'), 2.5)) failures.push('leave-guard: after Save as… stock Warm still carries the edit at the engine');
          if (padSelect.querySelector('option[value="draft:warm"]')) failures.push('leave-guard: a saved edit was parked under Edited as well');
        }
        const mineOption = [...padSelect.querySelectorAll('optgroup.my-voices option')].find((o) => o.textContent === 'Guard pad');
        if (!mineOption) {
          failures.push('leave-guard: Save as… did not list "Guard pad" under User');
        } else {
          await pick(padSelect, mineOption.value);
          if (guard()) failures.push('leave-guard: leaving an unedited Glass asked');
          if (voiceOf('pad') !== 'warm' || !near(release('pad', 'warm'), 2.5)) failures.push(`leave-guard: the saved User voice does not play its Release 2.5 (${voiceOf('pad')}, ${release('pad', 'warm')})`);

          // Save changes overwrites the User voice.
          await editPad('adsr.release', 3.5);
          await waitUntil(() => near(release('pad', 'warm'), 3.5));
          doc.getElementById('voice-edit-toggle-pad').click();
          await settle();
          if (!guard()) {
            failures.push('leave-guard: closing the editor on an edited User voice did not ask');
          } else {
            const b = buttons();
            for (const want of ['Save changes', 'Save as…', 'Revert to last save']) {
              if (!b.includes(want)) failures.push(`leave-guard: a User voice's guard has no ${want} (${JSON.stringify(b)})`);
            }
            if (b.includes('Reset to default')) failures.push('leave-guard: a User voice\'s guard offers Reset to default');
            guard().querySelector('.leave-guard-save').click();
            await settle();
            if (guard()) failures.push('leave-guard: Save changes did not answer the guard');
          }
          await pick(padSelect, 'glass');
          if (guard()) { failures.push('leave-guard: a saved User voice still asked on leaving'); guard().querySelector('.leave-guard-move').click(); }
          await pick(padSelect, mineOption.value);
          if (!near(release('pad', 'warm'), 3.5)) failures.push(`leave-guard: Save changes did not overwrite the User voice (Release ${release('pad', 'warm')}, want 3.5)`);

          // Revert to last save, past two changes, takes step 1's confirmation.
          await editPad('adsr.release', 1.0);
          await editPad('adsr.attack', 0.9);
          await editPad('sends.delay', 0.7);
          await waitUntil(() => near(release('pad', 'warm'), 1.0));
          doc.getElementById('voice-edit-toggle-pad').click();
          await settle();
          guard()?.querySelector('.leave-guard-revert')?.click();
          await settle();
          const confirm = doc.getElementById('factory-confirm');
          if (!confirm) {
            failures.push('leave-guard: Revert to last save on three changes did not ask with step 1\'s confirmation');
          } else {
            if (!/Revert to last save/.test(confirm.textContent)) failures.push(`leave-guard: the Revert confirmation does not say Revert ("${confirm.querySelector('.popover-title')?.textContent}")`);
            confirm.querySelector('.factory-confirm-go').click();
            await settle();
            if (guard()) failures.push('leave-guard: confirming Revert did not answer the guard');
          }
          if (!near(release('pad', 'warm'), 3.5)) failures.push(`leave-guard: Revert to last save left Release ${release('pad', 'warm')} at the engine, the save is 3.5`);

          // Move on: the pick goes ahead and the edit is parked under Edited.
          await editPad('adsr.release', 2.0);
          await waitUntil(() => near(release('pad', 'warm'), 2.0));
          await pick(padSelect, 'glass');
          guard()?.querySelector('.leave-guard-move')?.click();
          await settle();
          if (voiceOf('pad') !== 'glass') failures.push('leave-guard: Move on did not make the pick');
          if (!padSelect.querySelector('optgroup.edited-voices option[value="draft:warm"]')) failures.push('leave-guard: Move on did not park the edit under Edited');
        }

        // Next with two edited tracks asks ONCE, listing both.
        await editPad('adsr.release', 1.5);
        await waitUntil(() => near(release('pad', 'glass'), 1.5));
        const bassVoice = voiceOf('bass');
        const bassEditor = await openEditor('bass');
        await waitUntil(() => bassEditor.querySelector('.patch-controls .knob-cell[data-field="adsr.release"]'));
        await typeInto(bassEditor, 'adsr.release', 1.9);
        await waitUntil(() => near(release('bass', bassVoice), 1.9));
        forward.click();
        await settle();
        if (!guard()) {
          failures.push('leave-guard: Next with two edited voices did not ask');
        } else {
          const rows = [...guard().querySelectorAll('.leave-guard-row')].map((r) => r.dataset.track).sort();
          if (JSON.stringify(rows) !== JSON.stringify(['bass', 'pad'])) failures.push(`leave-guard: Next listed ${JSON.stringify(rows)}, want bass and pad in one dialog`);
          if (doc.querySelectorAll('#leave-guard').length !== 1) failures.push('leave-guard: Next opened more than one dialog');
          guard().querySelector('.leave-guard-cancel').click();
          await settle();
          if (!near(release('pad', 'glass'), 1.5) || !near(release('bass', bassVoice), 1.9)) failures.push('leave-guard: Keep editing on Next did not leave both edits sounding');
          forward.click();
          await settle();
          guard()?.querySelector('.leave-guard-move')?.click();
          await settle();
          if (near(release('pad', 'glass'), 1.5) || near(release('bass', bassVoice), 1.9)) failures.push('leave-guard: Move on through Next left an old edit sounding at the engine');
          if (!padSelect.querySelector('option[value="draft:glass"]')) failures.push('leave-guard: Next\'s Move on did not park the pad edit');
          if (!doc.getElementById('track-voice-bass').querySelector(`option[value="draft:${bassVoice}"]`)) failures.push('leave-guard: Next\'s Move on did not park the bass edit');
        }

        // A genre pick asks too; one Reset answers it and the load goes ahead.
        await pick(padSelect, 'warm');
        if (guard()) guard().querySelector('.leave-guard-move').click();
        await editPad('adsr.release', 2.5);
        await waitUntil(() => near(release('pad', 'warm'), 2.5));
        await pick(genrePick, 'g:synthwave');
        if (!guard()) {
          failures.push('leave-guard: picking a genre over an edited voice did not ask');
        } else {
          guard().querySelector('.leave-guard-reset').click();
          await settle();
          await waitUntil(() => !guard());
          if (guard()) failures.push('leave-guard: Reset to default did not answer the genre\'s guard');
          if (near(release('pad', 'warm'), 2.5)) failures.push('leave-guard: the genre load after Reset left the edit at the engine');
          if (engine.getParams().genre !== 'synthwave') failures.push('leave-guard: the genre did not load after the guard was answered');
        }
      } finally {
        guard()?.querySelector('.leave-guard-move')?.click();
        window.__leaveGuardManual = false;
      }
    }
  })();

  // ---- ui-review 2026-10-03 fix 13: a voice picker lists voices only -------
  // The pool has one door, the voice rule's Pool… (voice-rule-page drives it).
  for (const select of doc.querySelectorAll('select[id^="track-voice-"]')) {
    const action = [...select.options].find((o) => o.value === '__blend' || /Pool of voices/.test(o.textContent));
    if (action) failures.push(`${select.id} still offers "${action.textContent}" among its voices — the voice rule's Pool… is the one door`);
  }

  // ---- New… (TODO "Factory, edited and your own", step 3) ------------------
  // The last entry of every voice picker opens a chooser with four doors:
  // Instrument, Synth, Noise, Sample (honestly disabled). Synth → Subtractive
  // must put a plain open sawtooth into the ENGINE's patch for that track — not
  // just a label on the page.
  await (async () => {
    const engine = window.__ambi4Engine;
    const params = () => engine.getParams();
    const chooser = () => doc.getElementById('voice-new-chooser');
    // waitUntil answers true or false; these waits want what they found.
    const until = async (fn) => { let found = null; await waitUntil(() => (found = fn())); return found; };
    const openNew = async (track) => {
      const select = doc.getElementById(`track-voice-${track}`);
      select.value = '__new';
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
      return until(() => chooser() && chooser().dataset.track === track && chooser().querySelector('[data-door]'));
    };
    const door = (name) => chooser() && chooser().querySelector(`button[data-door="${name}"]`);
    for (const select of doc.querySelectorAll('select[id^="track-voice-"]')) {
      const last = select.options[select.options.length - 1];
      if (!last || last.value !== '__new' || last.textContent !== 'New…') {
        failures.push(`New…: ${select.id} does not end with New… (${last ? JSON.stringify(last.textContent) : 'empty'})`);
      }
    }
    const melody = doc.getElementById('track-voice-melody');
    if (!engine || !melody) {
      failures.push('New…: the engine seam or the melody picker is missing');
    } else if (!(await openNew('melody'))) {
      failures.push('New…: choosing New… on the melody picker opened no chooser');
    } else {
      if (melody.value === '__new') failures.push('New…: the picker was left reading New… instead of what plays');
      for (const name of ['instrument', 'synth', 'noise', 'sample']) {
        if (!door(name)) failures.push(`New…: the chooser has no ${name} door`);
      }
      const sample = door('sample');
      if (sample && (!sample.disabled || !/audio input/i.test(sample.textContent))) {
        failures.push(`New…: Sample should be disabled and say it comes with audio input ("${sample.textContent}")`);
      }
      if (door('noise') && !door('noise').disabled) failures.push('New…: Noise is offered on the melody, which has no noise voice');
      door('synth')?.click();
      const subtractive = await until(() => chooser() && chooser().querySelector('button[data-start="subtractive"]'));
      if (!subtractive) {
        failures.push('New…: the Synth door lists no Subtractive');
      } else {
        const additive = chooser().querySelector('button[data-start="additive"]');
        if (!additive || additive.disabled) failures.push('New…: Additive should be offered on the melody (Organ stab plays it)');
        subtractive.click();
        const landed = await until(() => {
          const p = params();
          const patch = p.patches && p.patches.melody && p.patches.melody.pluck;
          return p.tracks.melody.voice === 'pluck' && patch && patch.source && patch.source.shape1 === 2 ? patch : null;
        });
        if (!landed) {
          failures.push(`New…: Synth → Subtractive did not put a sawtooth on the melody at the engine (${JSON.stringify(params().patches && params().patches.melody)})`);
        } else {
          if (landed.source.shape2 !== null) failures.push(`New…: Subtractive left OSC 2 on (${landed.source.shape2})`);
          if (!landed.filter || landed.filter.cutoff !== 12000 || landed.filter.envAmount !== 0) failures.push(`New…: Subtractive's filter is not wide open (${JSON.stringify(landed.filter)})`);
          if (chooser()) failures.push('New…: the chooser stayed open after a pick');
          const live = melody.querySelector('optgroup.edited-voices .voice-live-option');
          if (!live || !live.selected || live.textContent !== 'New subtractive · edited') {
            failures.push(`New…: the picker does not read "New subtractive · edited" under Edited (${live ? JSON.stringify(live.textContent) : 'absent'})`);
          }
        }
      }
      // Instrument: headings by kind; a pick plays that voice at the engine.
      await openNew('melody');
      door('instrument')?.click();
      const list = await until(() => doc.getElementById('new-voice-instrument-melody'));
      if (!list) {
        failures.push('New…: the Instrument door shows no list');
      } else {
        const headings = [...list.querySelectorAll('optgroup')].map((g) => g.label);
        if (!headings.includes('Keys') || !headings.includes('Wind') || !headings.includes('Plucked')) failures.push(`New…: the Instrument list is not grouped by kind (${headings.join(', ')})`);
        list.value = 'flute';
        list.dispatchEvent(new window.Event('change', { bubbles: true }));
        if (!(await until(() => params().tracks.melody.voice === 'flute'))) failures.push('New…: Instrument → Flute did not reach the engine');
        if (melody.value !== 'flute') failures.push(`New…: after Instrument → Flute the picker reads ${melody.value}`);
      }
      // Noise on the texture: a colour lands on Coloured noise at the engine.
      if (await openNew('texture')) {
        door('noise')?.click();
        const white = await until(() => chooser() && chooser().querySelector('button[data-start="white"]'));
        if (!white || !chooser().querySelector('button[data-start="brown"]') || !chooser().querySelector('button[data-voice="wash"]')) {
          failures.push('New…: the texture\'s Noise door lacks White, Brown or its Wash texture');
        }
        white?.click();
        const tilt = await until(() => {
          const p = params();
          const s = p.patches && p.patches.texture && p.patches.texture.colour && p.patches.texture.colour.source;
          return p.tracks.texture.voice === 'colour' && s && s.tilt === 0.35 && s.gust === 0;
        });
        if (!tilt) failures.push('New…: Noise → White did not reach the engine as Coloured noise with its weather off');
      } else {
        failures.push('New…: no chooser on the texture picker');
      }
      // The kit has no synth engine: the door says so instead of doing nothing.
      if (await openNew('percussion')) {
        const synth = door('synth');
        if (!synth || !synth.disabled) failures.push('New…: Synth is offered on the kit, which has no host for it');
        chooser().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        if (chooser()) failures.push('New…: Esc did not close the chooser');
      }
    }
  })();

  // ---- factory PRESETS: factory, edited and back (ui-review 2026-10-03 fix 1)
  // The genre got "· edited" and Back to factory in v0.0.206; the twelve
  // presets a beginner actually sees did not — loading one cleared the genre
  // and the mark keyed on the genre. A loaded preset is now remembered
  // (settings.origin), its own patches are its factory voices, an edit reads
  // "· edited" with the same Back to factory beside the picker, and more than
  // two changes ask first, listing them. Engine values, never the readouts.
  await (async () => {
    const engine = window.__ambi4Engine;
    const genrePick = doc.getElementById('genre-select');
    const genreFactory = doc.getElementById('genre-factory');
    const presetsJson = JSON.parse(readFileSync(join(repoRoot, 'src/data/factory-presets.json'), 'utf8'));
    const first = presetsJson[0];
    const card = [...doc.querySelectorAll('#factory-preset-row .factory-preset')]
      .find((c) => c.querySelector('.factory-preset-name')?.textContent.startsWith(first.name));
    const lvl = (t) => engine.getParams().tracks[t].level;
    const want = (t) => first.params.tracks[t].level;
    const near = (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 0.005;
    const typeLevel = async (track, pct) => {
      const host = doc.getElementById(`track-level-${track}`);
      const readout = host && host.querySelector('.knob-value');
      if (!readout) return false;
      readout.click();
      const box = host.querySelector('.knob-value-edit');
      if (!box) return false;
      box.value = String(pct);
      box.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return waitUntil(() => near(lvl(track), pct / 100));
    };
    const pickedText = () => (genrePick.selectedOptions[0] ? genrePick.selectedOptions[0].textContent : '');
    if (!engine || !genrePick || !genreFactory || !card) {
      failures.push(`preset factory: the engine seam, the genre picker, Back to factory or the ${first.name} card is missing`);
    } else {
      card.click();
      await waitUntil(() => near(lvl('pad'), want('pad')) && near(lvl('bass'), want('bass')));
      await new Promise((r) => setTimeout(r, 120));
      if (!near(lvl('pad'), want('pad'))) failures.push(`preset factory: loading ${first.name} did not put its pad level at the engine`);
      if (/ · edited$/.test(pickedText())) failures.push(`preset factory: a freshly loaded ${first.name} reads as edited ("${pickedText()}")`);
      if (!pickedText().includes(first.name)) failures.push(`preset factory: the picker does not name the loaded preset (reads "${pickedText()}")`);
      if (!genreFactory.hidden) failures.push(`preset factory: Back to factory shows beside a freshly loaded ${first.name}`);
      for (const id of Object.keys(first.params.patches || {})) {
        const button = doc.getElementById(`track-factory-${id}`);
        if (button && !button.hidden) failures.push(`preset factory: ${id} offers ↺ Factory on a freshly loaded ${first.name} — its own patch is its factory`);
      }

      // One change: "· edited", and the way back beside it.
      if (!(await typeLevel('pad', 40))) {
        failures.push('preset factory: typing 40 into the pad level did not reach the engine');
      } else {
        await waitUntil(() => !genreFactory.hidden);
        if (!/ · edited$/.test(pickedText())) failures.push(`preset factory: an edited ${first.name} does not say so in the picker ("${pickedText()}")`);
        if (genreFactory.hidden) failures.push(`preset factory: no Back to factory while ${first.name} is edited`);
        if (!/ · edited/.test(card.textContent)) failures.push(`preset factory: the ${first.name} card does not say it is edited`);

        // Three changes: the confirmation counts and lists them by name.
        await typeLevel('bass', 25);
        await typeLevel('percussion', 90);
        await new Promise((r) => setTimeout(r, 120));
        genreFactory.click();
        const dialog = await waitUntil(() => doc.getElementById('factory-confirm'));
        if (!dialog) {
          failures.push('preset factory: three changes went back without asking');
        } else {
          const items = [...doc.querySelectorAll('#factory-confirm .factory-confirm-list li')].map((li) => li.textContent);
          const count = doc.querySelector('#factory-confirm .factory-confirm-count');
          if (items.length !== 3 || !count || !/3 changes/.test(count.textContent)) {
            failures.push(`preset factory: the confirmation should count and list exactly 3 changes (${items.length} listed: ${JSON.stringify(items)}, "${count && count.textContent}")`);
          }
          for (const name of ['Pad', 'Bass', 'Percussion']) {
            if (!items.some((line) => line.startsWith(name) && /Level/.test(line))) failures.push(`preset factory: the list does not name the ${name} level change (${JSON.stringify(items)})`);
          }
          doc.querySelector('#factory-confirm .factory-confirm-go').click();
          await waitUntil(() => near(lvl('pad'), want('pad')) && near(lvl('bass'), want('bass')) && near(lvl('percussion'), want('percussion')));
          await new Promise((r) => setTimeout(r, 120));
          for (const t of ['pad', 'bass', 'percussion']) {
            if (!near(lvl(t), want(t))) failures.push(`preset factory: Back to factory left ${t} level at ${JSON.stringify(lvl(t))} (the preset ships ${want(t)})`);
          }
          if (!genreFactory.hidden) failures.push('preset factory: Back to factory still shows after the preset went back');
          if (/ · edited/.test(pickedText()) || / · edited/.test(card.textContent)) failures.push('preset factory: "· edited" still shows after going back');
        }
      }

      // Every preset arrives at factory: a load must never read as an edit.
      for (const other of doc.querySelectorAll('#factory-preset-row .factory-preset')) {
        other.click();
        await new Promise((r) => setTimeout(r, 80));
        if (!genreFactory.hidden || / · edited/.test(pickedText())) {
          failures.push(`preset factory: a freshly loaded ${other.querySelector('.factory-preset-name')?.textContent} reads as edited ("${pickedText()}")`);
        }
      }
    }
  })();

  // ---- ui-review 2026-10-03 fix 19: the pro layer's keybindings ----------
  // 1–9 load the ☆ favourite genres, then the factory presets in order; [ and
  // ] step through the genre list (genre in play) or the presets; S / A pick
  // the tab; ? opens the sheet and Esc closes it. Every load is read back at
  // the ENGINE (its bpm and pad level for a preset, its genre slug for a
  // genre), never the picker's text. And the keys stand down where they
  // would steal from something else: a text field, a Ctrl/Meta chord, and
  // musical typing — whose number keys are notes.
  await (async () => {
    const engine = window.__ambi4Engine;
    const presetsJson = JSON.parse(readFileSync(join(repoRoot, 'src/data/factory-presets.json'), 'utf8'));
    const press = (k, target = doc.body, extra = {}) => {
      const event = new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra });
      target.dispatchEvent(event);
      return event;
    };
    const sig = () => {
      const p = engine.getParams();
      return `${p.bpm}|${p.tracks?.pad?.level}`;
    };
    const presetSig = (preset) => `${preset.params.bpm}|${preset.params.tracks.pad.level}`;
    const isPreset = (i) => sig() === presetSig(presetsJson[i]);
    const settle = () => new Promise((r) => setTimeout(r, 60));
    const favEditor = doc.getElementById('genre-favourites');
    const favBoxes = () => [...doc.querySelectorAll('#genre-favourites .genre-fav-item input[type="checkbox"]')];
    const setFavourites = (slugs) => {
      // Through the ☆ editor, as a person does it — the boxes write genrePrefs.
      if (favEditor?.hidden) doc.getElementById('genre-favourites-toggle')?.click();
      for (const box of favBoxes()) {
        const want = slugs.includes(box.value);
        if (box.checked !== want) {
          box.checked = want;
          box.dispatchEvent(new window.Event('change', { bubbles: true }));
        }
      }
      const hide = doc.getElementById('genre-hide-others');
      if (hide && hide.checked) {
        hide.checked = false;
        hide.dispatchEvent(new window.Event('change', { bubbles: true }));
      }
      doc.getElementById('genre-favourites-done')?.click();
    };
    const distinct = new Set(presetsJson.slice(0, 4).map(presetSig)).size === 4;
    if (!engine || !favEditor || !distinct) {
      failures.push(`keybindings: ${!engine ? 'no engine seam' : !favEditor ? 'no favourites editor' : 'the first four presets share a bpm and pad level, so the engine cannot tell them apart'}`);
    } else {
      setFavourites([]);
      doc.body.focus?.();
      // No favourites: the number keys are the factory presets in order.
      press('2');
      await waitUntil(() => isPreset(1));
      await settle();
      if (!isPreset(1)) failures.push(`keybindings: "2" with no favourites did not load ${presetsJson[1].name} at the engine (engine reads ${sig()}, want ${presetSig(presetsJson[1])})`);
      if (engine.getParams().genre) failures.push(`keybindings: a preset loaded by "2" left the engine on genre ${engine.getParams().genre}`);
      press(']');
      await waitUntil(() => isPreset(2));
      if (!isPreset(2)) failures.push(`keybindings: "]" after ${presetsJson[1].name} did not move on to ${presetsJson[2].name} (engine reads ${sig()})`);
      press('[');
      press('[');
      await waitUntil(() => isPreset(0));
      if (!isPreset(0)) failures.push(`keybindings: "[" twice from ${presetsJson[2].name} did not reach ${presetsJson[0].name} (engine reads ${sig()})`);

      // The tabs.
      const advanced = doc.getElementById('panel-advanced');
      const simple = doc.getElementById('panel-simple');
      press('a');
      if (!advanced || advanced.hidden) failures.push('keybindings: "A" did not open the Advanced tab');
      press('S');
      if (!simple || simple.hidden || !advanced.hidden) failures.push('keybindings: "S" did not bring the Simple tab back');

      // Never in a text field, never under a modifier.
      const nameBox = doc.getElementById('preset-name');
      if (nameBox) {
        press('3', nameBox);
        await settle();
        if (!isPreset(0)) failures.push(`keybindings: typing "3" into the preset name loaded a preset (engine reads ${sig()})`);
        press('a', nameBox);
        if (simple.hidden) failures.push('keybindings: typing "a" into the preset name switched tabs');
      }
      const chord = press('2', doc.body, { ctrlKey: true });
      press('2', doc.body, { metaKey: true });
      await settle();
      if (!isPreset(0)) failures.push(`keybindings: Ctrl/⌘-2 loaded a preset — a modifier chord belongs to the browser (engine reads ${sig()})`);
      if (chord.defaultPrevented) failures.push('keybindings: Ctrl-2 was swallowed (preventDefault) — the browser\'s own tab shortcut must survive');

      // Musical typing on: the number keys are notes, not presets.
      const typing = doc.getElementById('play-along-toggle');
      if (typing) {
        if (typing.getAttribute('aria-pressed') !== 'true') typing.click();
        press('1');
        press('4');
        await settle();
        if (!isPreset(0)) failures.push(`keybindings: with musical typing on, "4" still loaded a preset (engine reads ${sig()})`);
        press('a');
        if (simple.hidden) failures.push('keybindings: with musical typing on, "a" still switched tabs');
        if (typing.getAttribute('aria-pressed') === 'true') typing.click();
        doc.body.dispatchEvent(new window.KeyboardEvent('keyup', { key: '1', bubbles: true }));
        doc.body.dispatchEvent(new window.KeyboardEvent('keyup', { key: '4', bubbles: true }));
      } else {
        failures.push('keybindings: no musical typing toggle (#play-along-toggle) to test against');
      }

      // Favourites take the first numbers; with a genre in play ] walks the genre list.
      const picked = favBoxes().slice(0, 2).map((box) => box.value);
      if (picked.length === 2) {
        setFavourites(picked);
        // The slots follow the picker's order, which is not the editor's
        // (the editor groups by mood).
        const listed = [...doc.querySelectorAll('#genre-select option')].map((o) => o.value).filter((v) => v.startsWith('g:')).map((v) => v.slice(2));
        const slugs = listed.filter((slug) => picked.includes(slug));
        press('2');
        await waitUntil(() => engine.getParams().genre === slugs[1]);
        if (engine.getParams().genre !== slugs[1]) failures.push(`keybindings: with two favourites, "2" did not load the second (${slugs[1]}) at the engine (genre ${engine.getParams().genre})`);
        press('3');
        await waitUntil(() => isPreset(0));
        if (!isPreset(0)) failures.push(`keybindings: with two favourites, "3" did not fall through to the first preset, ${presetsJson[0].name} (engine reads ${sig()})`);
        press('1');
        await waitUntil(() => engine.getParams().genre === slugs[0]);
        const nextSlug = listed[(listed.indexOf(slugs[0]) + 1) % listed.length];
        press(']');
        await waitUntil(() => engine.getParams().genre === nextSlug);
        if (engine.getParams().genre !== nextSlug) failures.push(`keybindings: "]" from genre ${slugs[0]} did not move on to ${nextSlug} (engine genre ${engine.getParams().genre})`);
        setFavourites([]);
      }

      // ? opens the sheet (the visible door opens it too); Esc closes it.
      press('?');
      let sheet = doc.getElementById('shortcut-sheet');
      if (!sheet) {
        failures.push('keybindings: "?" did not open the shortcut sheet');
      } else {
        const rows = [...sheet.querySelectorAll('.shortcut-list dt')].map((dt) => dt.textContent);
        if (!rows.includes('1') || !rows.includes('9') || !rows.some((r) => r.includes(']'))) failures.push(`keybindings: the sheet does not list 1–9 and [ ] (${JSON.stringify(rows)})`);
        if (!sheet.contains(doc.activeElement)) failures.push('keybindings: the sheet opened without focus inside it');
        press('Escape', doc.activeElement || sheet);
        if (doc.getElementById('shortcut-sheet')) failures.push('keybindings: Esc did not close the shortcut sheet');
      }
      const door = doc.getElementById('shortcuts-open');
      if (!door || !door.closest('#tutorial-panel')) {
        failures.push('keybindings: no visible "Keyboard shortcuts" button (#shortcuts-open) in the tour panel');
      } else {
        door.click();
        sheet = doc.getElementById('shortcut-sheet');
        if (!sheet) failures.push('keybindings: the Keyboard shortcuts button did not open the sheet');
        sheet?.querySelector('.shortcut-sheet-close')?.click();
        if (doc.getElementById('shortcut-sheet')) failures.push('keybindings: Close did not close the shortcut sheet');
      }
    }
  })();

  // ---- Factory, edited and your own, step 3: HIDE -----------------------
  // His ruling: hide, never "use instead of factory". A hidden stock voice
  // leaves its picker but KEEPS PLAYING where it is in use (read at the
  // ENGINE), comes back under the picker's "Hidden…" entry, and only the
  // person's own items can be deleted there. A hidden genre leaves the list
  // and ] steps past it.
  await (async () => {
    const engine = window.__ambi4Engine;
    const select = doc.getElementById('track-voice-pad');
    const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));
    const pick = async (el, value) => {
      el.value = value;
      el.dispatchEvent(new window.Event('change', { bubbles: true }));
      await settle();
    };
    const values = (el) => [...el.options].map((o) => o.value);
    const view = () => doc.getElementById('hidden-view');
    const viewBoxes = () => [...(view()?.querySelectorAll('input[type="checkbox"]') || [])];
    const tick = (pred) => {
      for (const box of viewBoxes()) {
        const want = pred(box);
        if (box.checked !== want) {
          box.checked = want;
          box.dispatchEvent(new window.Event('change', { bubbles: true }));
        }
      }
    };
    if (!engine || !select) {
      failures.push('hide: no engine seam or pad picker');
    } else {
      await pick(select, 'glass');
      await waitUntil(() => engine.getParams().tracks.pad.voice === 'glass');
      const editor = await openEditor('pad');
      const more = editor.querySelector('.ve-more');
      if (more && more.getAttribute('aria-expanded') !== 'true') more.click();
      const hide = editor.querySelector('.ve-hide-voice');
      if (!hide || hide.hidden) {
        failures.push('hide: the pad editor\'s "more" fold has no visible "Hide this voice" (.ve-hide-voice)');
      } else {
        hide.click();
        await settle();
        // In play: still listed, still what the picker reads, still at the engine.
        if (!values(select).includes('glass') || select.value !== 'glass') failures.push(`hide: hiding the voice in play dropped it from its picker (reads ${select.value})`);
        if (engine.getParams().tracks.pad.voice !== 'glass') failures.push(`hide: hiding Glass changed what the pad plays at the engine (${engine.getParams().tracks.pad.voice})`);
        if (!hide.hidden) failures.push('hide: "Hide this voice" is still offered for a voice already hidden');
        // Persisted per device, like the favourites (consent was granted above).
        let stored = null;
        try { stored = JSON.parse(window.localStorage.getItem('ambi4:hidden')); } catch {}
        if (!stored || !Array.isArray(stored.voices) || !stored.voices.includes('pad/glass')) failures.push(`hide: hiding Glass did not persist under prefs 'hidden' (${JSON.stringify(stored)})`);
        const entry = () => select.querySelector('option[value="__hidden"]');
        if (!entry() || entry().textContent !== 'Hidden: 1 preset…') failures.push(`hide: the pad picker has no "Hidden: 1 preset…" entry (${JSON.stringify(entry()?.textContent)})`);
        if (entry() && select.lastElementChild !== entry()) failures.push('hide: the Hidden entry is not the picker\'s last');
        // Away from it: gone from the picker.
        await pick(select, 'warm');
        if (engine.getParams().tracks.pad.voice !== 'warm') failures.push('hide: picking Warm after hiding Glass did not reach the engine');
        if (values(select).includes('glass')) failures.push('hide: Glass, hidden and no longer in play, is still in the pad picker');
        // A setup naming it still plays it exactly: "2" loads Open Plan, whose
        // pad is Glass (no favourites are starred — the keybindings block above
        // clears them).
        const presetsJson = JSON.parse(readFileSync(join(repoRoot, 'src/data/factory-presets.json'), 'utf8'));
        if (presetsJson[1]?.params?.tracks?.pad?.voice !== 'glass') failures.push('hide: the second factory preset no longer plays Glass on the pad — pick another for this check');
        doc.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: '2', bubbles: true, cancelable: true }));
        const restored = await waitUntil(() => engine.getParams().tracks.pad.voice === 'glass');
        if (!restored) failures.push(`hide: a preset naming hidden Glass did not play it at the engine (${engine.getParams().tracks.pad.voice})`);
        else if (select.value !== 'glass') failures.push(`hide: a setup playing hidden Glass shows the picker as ${JSON.stringify(select.value)}`);
        await pick(select, 'warm');
        // A voice of your own, hidden too.
        const nameBox = editor.querySelector('.ve-voice-name');
        const save = editor.querySelector('.ve-save-voice');
        nameBox.value = 'Hide test';
        save.click();
        await settle();
        const ownOption = () => [...select.querySelectorAll('optgroup.my-voices option')].find((o) => o.textContent === 'Hide test');
        const ownHide = doc.querySelector('#voice-editor-pad .ve-hide-voice');
        if (!ownOption() || !ownHide || ownHide.hidden) {
          failures.push('hide: no own voice listed, or no "Hide this voice" for it');
        } else {
          ownHide.click();
          await settle();
          await pick(select, 'warm');
          if (ownOption()) failures.push('hide: a hidden own voice no longer in play is still under User');
          if (entry()?.textContent !== 'Hidden: 1 preset, 1 of yours…') failures.push(`hide: the entry reads ${JSON.stringify(entry()?.textContent)}, want "Hidden: 1 preset, 1 of yours…"`);
        }
        // The view.
        await pick(select, '__hidden');
        if (engine.getParams().tracks.pad.voice !== 'warm') failures.push('hide: choosing "Hidden…" changed the pad\'s voice at the engine');
        if (select.value === '__hidden') failures.push('hide: the picker was left reading "Hidden…"');
        if (!view()) {
          failures.push('hide: choosing "Hidden…" in the pad picker opened no Hidden view (#hidden-view)');
        } else {
          const del = view().querySelector('.hidden-view-delete');
          const unhide = view().querySelector('.hidden-view-unhide');
          const labels = [...view().querySelectorAll('.genre-fav-item')].map((row) => row.textContent);
          if (!labels.includes('Glass · Stock') || !labels.includes('Hide test · User')) failures.push(`hide: the view lists ${JSON.stringify(labels)}`);
          tick((box) => box.dataset.own !== 'true');
          if (!del || !del.disabled) failures.push('hide: Delete is live with a stock voice ticked');
          tick(() => true);
          if (!del || !del.disabled) failures.push('hide: Delete is live with a stock voice among the ticked');
          tick((box) => box.dataset.own === 'true');
          if (!del || del.disabled) failures.push('hide: Delete is not live with only your own voice ticked');
          tick((box) => box.dataset.own !== 'true');
          unhide.click();
          await settle();
          if (!values(select).includes('glass')) failures.push('hide: Unhide did not put Glass back in the pad picker');
          tick(() => true);
          view()?.querySelector('.hidden-view-delete')?.click();
          await settle();
          if (ownOption() || [...select.querySelectorAll('option')].some((o) => o.textContent === 'Hide test')) failures.push('hide: Delete left the own voice in the picker');
          if (view()) failures.push('hide: the Hidden view stayed open with nothing left in it');
          if (entry()) failures.push('hide: the "Hidden…" entry stayed with nothing hidden');
        }
      }

      // Genres: hide one, ] steps past it; the one in play stays listed.
      const genreSelect = doc.getElementById('genre-select');
      const star = doc.getElementById('genre-favourites-toggle');
      const listed = () => values(genreSelect).filter((v) => v.startsWith('g:')).map((v) => v.slice(2));
      const stock = listed().filter((slug) => !slug.startsWith('u-'));
      if (stock.length < 2) {
        failures.push(`hide: fewer than two stock genres listed (${stock.join(', ')})`);
      } else {
        const [keep, gone] = stock;
        await pick(genreSelect, `g:${gone}`);
        await waitUntil(() => engine.getParams().genre === gone);
        if (doc.getElementById('genre-favourites')?.hidden) star.click();
        const hideGenre = doc.getElementById('genre-hide-current');
        if (!hideGenre || hideGenre.hidden) {
          failures.push('hide: the ☆ panel offers no "Hide <genre>" (#genre-hide-current) for the genre in play');
        } else {
          hideGenre.click();
          doc.getElementById('genre-favourites-done')?.click();
          await settle();
          if (!listed().includes(gone) || genreSelect.value !== `g:${gone}`) failures.push(`hide: the hidden genre in play left the list (picker reads ${genreSelect.value})`);
          if (engine.getParams().genre !== gone) failures.push('hide: hiding the genre in play changed the engine\'s genre');
          await pick(genreSelect, `g:${keep}`);
          await waitUntil(() => engine.getParams().genre === keep);
          if (listed().includes(gone)) failures.push(`hide: hidden ${gone} is still in the genre list once another genre plays`);
          const genreEntry = genreSelect.querySelector('option[value="hidden"]');
          if (!genreEntry || genreEntry.textContent !== 'Hidden: 1 preset…') failures.push(`hide: the genre list has no "Hidden: 1 preset…" entry (${JSON.stringify(genreEntry?.textContent)})`);
          doc.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: ']', bubbles: true, cancelable: true }));
          await settle(250);
          if (engine.getParams().genre === gone) failures.push(`hide: "]" from ${keep} stepped onto hidden ${gone}`);
          // v0.0.227: Surprise me reaches unlisted genres (v0.0.226) but
          // never one the person hid.
          for (let i = 0; i < 30; i++) {
            await pick(genreSelect, 'surprise');
            if (engine.getParams().genre === gone) {
              failures.push(`hide: Surprise me drew ${gone}, which the person hid`);
              break;
            }
          }
          await pick(genreSelect, 'hidden');
          if (!view()) {
            failures.push('hide: "Hidden…" in the genre list opened no Hidden view');
          } else {
            if (view().querySelector('.hidden-view-delete') && !view().querySelector('.hidden-view-delete').hidden) failures.push('hide: Delete is offered with only stock genres hidden');
            tick(() => true);
            view().querySelector('.hidden-view-unhide').click();
            await settle();
            if (!listed().includes(gone)) failures.push(`hide: Unhide did not put ${gone} back in the genre list`);
            if (genreSelect.querySelector('option[value="hidden"]')) failures.push('hide: the genre list kept its "Hidden…" entry with nothing hidden');
          }
        }
      }
    }
  })();

  // ---- Pro layer: pins and saved layouts -------------------------------
  // Any dial can be pinned (P on the focused dial, or its right-click menu);
  // the pin is a second VIEW of one setting in a Pinned strip on Simple.
  // Asserted at the ENGINE and on the original dial's own readout, both ways
  // round, then unpin from the copy, then a saved layout recalled over
  // different pins. Nothing pinned, no strip.
  await (async () => {
    const engine = window.__ambi4Engine;
    const settle = () => new Promise((r) => setTimeout(r, 30));
    const press = (k, target) => {
      const event = new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return event;
    };
    const strip = doc.getElementById('pinned-strip');
    const original = doc.querySelector('#repetition-dial .knob');
    const readout = (knob) => knob?.querySelector('.knob-value')?.textContent;
    const mirrors = () => [...doc.querySelectorAll('#pinned-row .knob')];
    if (!engine || !strip || !original) {
      failures.push(`pins: ${!engine ? 'no engine seam' : !strip ? 'no Pinned strip (#pinned-strip)' : 'no Reprise dial (#repetition-dial .knob)'}`);
    } else {
      doc.getElementById('tab-advanced')?.click();
      if (!strip.hidden) failures.push('pins: the Pinned strip shows with nothing pinned and no layout saved');
      // Pin by keyboard.
      original.focus();
      press('p', original);
      await settle();
      let copy = mirrors()[0];
      if (strip.hidden || mirrors().length !== 1) {
        failures.push(`pins: P on the focused Reprise dial did not put one copy in the Pinned strip (strip hidden ${strip.hidden}, ${mirrors().length} copies)`);
      } else {
        if (!/Reprise/.test(copy.textContent)) failures.push(`pins: the pinned copy is not labelled Reprise (${JSON.stringify(copy.textContent)})`);
        // The copy moves the engine and the original.
        const before = engine.getParams().repetition;
        for (let i = 0; i < 5; i++) press('ArrowDown', copy);
        await settle();
        const after = engine.getParams().repetition;
        if (!(after < before)) failures.push(`pins: moving the pinned copy did not move the engine's repetition (${before} -> ${after})`);
        if (readout(original) !== readout(copy)) failures.push(`pins: the original Reprise dial reads ${readout(original)} after the pinned copy moved to ${readout(copy)}`);
        // And the original moves the copy.
        for (let i = 0; i < 3; i++) press('ArrowUp', original);
        await settle();
        if (readout(original) !== readout(copy)) failures.push(`pins: the pinned copy reads ${readout(copy)} after the original moved to ${readout(original)}`);
        if (engine.getParams().repetition <= after) failures.push('pins: moving the original after pinning did not reach the engine');
        // Unpin from the copy.
        copy.focus();
        press('p', copy);
        await settle();
        if (mirrors().length) failures.push('pins: P on the pinned copy did not unpin it');
        if (!strip.hidden) failures.push('pins: the strip stays shown after the last pin went');
        if (window.__ambi4Layout?.pins?.length) failures.push(`pins: the stored pins still hold ${JSON.stringify(window.__ambi4Layout.pins)}`);
      }
      // Pin by the dial's menu.
      original.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
      const item = doc.querySelector('#pin-menu .pin-menu-item');
      if (!item || item.textContent !== 'Pin to Simple') {
        failures.push(`pins: right-click on a dial did not offer Pin to Simple (${item ? JSON.stringify(item.textContent) : 'no menu'})`);
      } else {
        item.click();
        await settle();
        if (mirrors().length !== 1) failures.push('pins: Pin to Simple from the menu did not pin the dial');
      }
      // Saved layouts: save {Reprise, Advanced tab}; change the pins and the
      // tab; recall restores both.
      const other = [...doc.querySelectorAll('#panel-advanced .knob')].find((k) => k.__pinRecord && k !== original && !k.closest('#repetition-dial'));
      doc.getElementById('pinned-more')?.click();
      const name = doc.getElementById('layout-name');
      const select = doc.getElementById('layout-select');
      if (!other || !name || !select) {
        failures.push(`pins: ${!other ? 'no second Advanced dial to pin' : 'no layout name field or picker'}`);
      } else {
        name.value = 'Mix';
        doc.getElementById('layout-save')?.click();
        await settle();
        const savedKeys = JSON.stringify((window.__ambi4Layout?.saved?.Mix?.pins || []).map((pin) => pin.key));
        mirrors()[0]?.focus();
        press('p', doc.activeElement);
        other.focus();
        press('p', other);
        await settle();
        doc.getElementById('tab-simple')?.click();
        const changedKeys = JSON.stringify((window.__ambi4Layout?.pins || []).map((pin) => pin.key));
        if (changedKeys === savedKeys) failures.push('pins: changing the pins after saving a layout left them as saved — the recall test would prove nothing');
        select.value = 'Mix';
        select.dispatchEvent(new window.Event('change', { bubbles: true }));
        await settle();
        const recalled = JSON.stringify((window.__ambi4Layout?.pins || []).map((pin) => pin.key));
        if (recalled !== savedKeys) failures.push(`pins: recalling layout Mix gave pins ${recalled}, saved ${savedKeys}`);
        if (mirrors().length !== 1 || !/Reprise/.test(mirrors()[0].textContent)) failures.push('pins: after recalling Mix the strip does not show the one Reprise copy');
        if (doc.getElementById('panel-advanced').hidden) failures.push('pins: recalling Mix did not bring back its Advanced tab');
        // The recalled copy is live, not a picture.
        const was = engine.getParams().repetition;
        press('ArrowDown', mirrors()[0]);
        await settle();
        if (!(engine.getParams().repetition < was)) failures.push('pins: the recalled Reprise copy does not reach the engine');
        // Clean up: no pins, no layouts, Simple tab.
        doc.getElementById('layout-forget')?.click();
        mirrors()[0]?.focus();
        press('p', doc.activeElement);
        await settle();
        if (Object.keys(window.__ambi4Layout?.saved || {}).length) failures.push('pins: Forget did not remove the layout');
        if (!strip.hidden) failures.push('pins: the strip stays shown with no pins and no layouts');
      }
      doc.getElementById('tab-simple')?.click();
    }
  })();

  // Review follow-up: saved layout names were keys of a plain object, so
  // "__proto__" was silently not saved and "constructor" / "toString" got
  // past the twelve-layout cap (`name in {}` is true for both).
  {
    const nameBox = doc.getElementById('layout-name');
    const saveButton = doc.getElementById('layout-save');
    const store = () => window.__ambi4Layout?.saved || {};
    const count = () => Object.keys(store()).length;
    if (!nameBox || !saveButton || !window.__ambi4Layout) {
      failures.push('layout names: no layout name field, Save, or layout seam');
    } else {
      const startCount = count();
      const save = (n) => { nameBox.value = n; saveButton.click(); };
      save('__proto__');
      if (!Object.keys(store()).includes('__proto__')) failures.push('layout names: a layout named __proto__ was not saved');
      let stored = null;
      try { stored = JSON.parse(window.localStorage.getItem('ambi4:layout')); } catch {}
      if (stored && !Object.prototype.hasOwnProperty.call(stored.saved || {}, '__proto__')) failures.push('layout names: a layout named __proto__ did not reach storage');
      for (let i = count(); i < 12; i++) save(`L${i}`);
      const full = count();
      save('constructor');
      save('toString');
      if (count() !== full) failures.push(`layout names: constructor / toString got past the ${full}-layout cap (${count()} saved)`);
      if (Object.keys(store()).some((k) => k === 'constructor' || k === 'toString')) failures.push('layout names: constructor or toString was saved past the cap');
      // Clean up: no saved layouts left behind.
      const select = doc.getElementById('layout-select');
      for (const n of Object.keys(store())) {
        select.value = n;
        select.dispatchEvent(new window.Event('change', { bubbles: true }));
        doc.getElementById('layout-forget')?.click();
      }
      if (count() !== startCount && startCount === 0) failures.push(`layout names: ${count()} layouts left after forgetting them all`);
      doc.getElementById('tab-simple')?.click();
    }
  }

  // v0.0.241: chord length in BEATS reaches the engine from the Chord length
  // select, and picking a bar length clears it again.
  await (async () => {
    const engineRef = window.__ambi4Engine;
    const select = doc.getElementById('chordLength');
    const two = select && select.querySelector('option[value="beats:2"]');
    if (!two) {
      failures.push('chord length: the select offers no "2 beats"');
    } else {
      select.value = 'beats:2';
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
      if (engineRef.getParams().harmony.beats !== 2) failures.push(`chord length: "2 beats" left the engine on beats ${JSON.stringify(engineRef.getParams().harmony.beats)}`);
      select.value = '1';
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
      const h = engineRef.getParams().harmony;
      if (h.beats !== undefined && h.beats !== null) failures.push(`chord length: "1 bar" left beats ${h.beats} at the engine`);
      if (h.rhythm !== 1) failures.push(`chord length: "1 bar" set rhythm ${JSON.stringify(h.rhythm)}`);
    }
  })();

  // ---- The Create rebuild: two doors (his "indecipherably complex") ------
  // The progressive rule, counted: at first open the Create part of the panel
  // shows the Start row and the Write picker and NOTHING else; choosing Melody
  // opens exactly the melody row; and Strip a layer → Notes does at the
  // ENGINE what Zero notes did — every melodic grid empty and Manual, the drum
  // grid untouched. Visibility is the `hidden` attribute up the tree (the
  // page's [hidden] rule is !important), which is what jsdom can see.
  await (async () => {
    const engine = window.__ambi4Engine;
    const panel = doc.getElementById('play-along');
    const doors = doc.getElementById('create-doors');
    const writeSelect = doc.getElementById('create-write');
    const strip = doc.getElementById('create-strip');
    const stripGo = doc.getElementById('create-strip-go');
    const opener = doc.getElementById('play-along-open');
    if (!panel || !doors || !writeSelect || !strip || !stripGo || !opener || !engine) {
      failures.push(`create doors: missing ${[
        !doors && '#create-doors', !writeSelect && '#create-write', !strip && '#create-strip',
        !stripGo && '#create-strip-go', !opener && '#play-along-open', !engine && 'engine seam',
      ].filter(Boolean).join(', ')}`);
    } else {
      if (panel.hidden) opener.click();
      await new Promise((r) => setTimeout(r, 30));
      const shown = (el) => {
        for (let n = el; n && n !== panel; n = n.parentElement) if (n.hidden) return false;
        return true;
      };
      const visibleControls = () => Array.from(
        doors.querySelectorAll('button, select, input:not([type="file"]), textarea, label.secondary-button')
      ).filter(shown).map((el) => el.id || el.className);
      const firstOpen = visibleControls();
      const expected = ['create-blank', 'guided-start', 'create-seed', 'create-strip', 'create-strip-go', 'create-write'];
      if (panel.hidden) failures.push('create doors: the panel did not open');
      if (firstOpen.length !== expected.length || expected.some((id) => !firstOpen.includes(id))) {
        failures.push(`create doors: at first open exactly the Start row and the Write select should show (${expected.length} controls), showing ${firstOpen.length}: ${firstOpen.join(', ')}`);
      }
      if (!stripGo.disabled) failures.push('create doors: Strip should be disabled until a layer is chosen');

      writeSelect.value = 'melody';
      writeSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
      const melodyRow = ['compose-melody-text', 'compose-melody-track', 'compose-melody-write'];
      const afterMelody = visibleControls();
      const extra = afterMelody.filter((id) => !expected.includes(id));
      if (extra.length !== melodyRow.length || melodyRow.some((id) => !extra.includes(id))) {
        failures.push(`create doors: choosing Melody should show exactly the melody row (${melodyRow.join(', ')}), shows ${extra.join(', ') || 'nothing'}`);
      }

      // Put notes on the melody through the row just opened, so Strip has
      // something real to strip, and count the kit's steps to prove it stays.
      const seqsOf = (t) => (Array.isArray(t && t.sequencers) && t.sequencers.length ? t.sequencers : (t && t.sequencer ? [t.sequencer] : []));
      const onCount = (seq) => {
        const steps = seq && seq.steps;
        if (Array.isArray(steps)) return steps.filter((st) => st && st.on).length;
        if (steps && typeof steps === 'object') return Object.values(steps).reduce((n, lane) => n + (Array.isArray(lane) ? lane.filter((st) => st && st.on).length : 0), 0);
        return 0;
      };
      const melodyTrack = doc.getElementById('compose-melody-track');
      melodyTrack.value = 'melody';
      melodyTrack.dispatchEvent(new window.Event('change', { bubbles: true }));
      const box = doc.getElementById('compose-melody-text');
      box.value = 'C4 E4 G4 C5';
      box.dispatchEvent(new window.Event('input', { bubbles: true }));
      doc.getElementById('compose-melody-write').click();
      await waitUntil(() => seqsOf(engine.getParams().tracks.melody).some((q) => onCount(q) > 0));
      const before = engine.getParams();
      const melodyBefore = seqsOf(before.tracks.melody).reduce((n, q) => n + onCount(q), 0);
      const kitBefore = seqsOf(before.tracks.percussion).reduce((n, q) => n + onCount(q), 0);
      if (!melodyBefore) failures.push('create doors: Write it on the melody row put no notes on the melody at the engine');
      const fitWrap = doc.getElementById('create-harmonise-wrap');
      const chooseChords = () => {
        writeSelect.value = 'chords';
        writeSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
      };
      chooseChords();
      if (!fitWrap || !shown(fitWrap)) failures.push('create doors: with a tune on the melody, Write → Chords should offer Fit chords to the tune');

      strip.value = 'notes';
      strip.dispatchEvent(new window.Event('change', { bubbles: true }));
      if (stripGo.disabled) failures.push('create doors: Strip stayed disabled with Notes chosen');
      stripGo.click();
      await waitUntil(() => seqsOf(engine.getParams().tracks.melody).every((q) => onCount(q) === 0));
      const after = engine.getParams();
      const notStripped = [];
      for (const [id, t] of Object.entries(after.tracks || {})) {
        if (id === 'percussion' || !t.sequencer) continue;
        for (const q of seqsOf(t)) {
          if (onCount(q) || q.mode !== 'manual') notStripped.push(`${id} (${onCount(q)} on, ${q.mode})`);
        }
      }
      if (notStripped.length) failures.push(`create doors: Strip → Notes left melodic grids at the ENGINE: ${notStripped.join(', ')}`);
      const kitAfter = seqsOf(after.tracks.percussion).reduce((n, q) => n + onCount(q), 0);
      if (kitAfter !== kitBefore) failures.push(`create doors: Strip → Notes touched the drum grid (${kitBefore} → ${kitAfter} steps on)`);
      chooseChords();
      if (fitWrap && shown(fitWrap)) failures.push('create doors: with no tune left anywhere, Fit chords to the tune should be hidden');

      writeSelect.value = '';
      writeSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
      if (!panel.hidden) opener.click();
    }
  })();

  // ---- Start with ANY track (his "chords=pad … even texture") ---------------
  // Every Write door must be able to START its instrument from a Blank slate,
  // the way Write → Melody always could. Two could not: the Chords door wrote a
  // loop the pad never played (Blank slate switches the pad off and nothing in
  // the chords path switched it back on), and a MIDI file landed without the
  // hand-written flag, so it waited its track's staged turn (five bars on the
  // kit) where a typed line enters at once. Asserted at the ENGINE: the stored
  // seed, the pad's state, and the imported line's entry bar.
  {
    const engine = window.__ambi4Engine;
    const panel = doc.getElementById('play-along');
    const opener = doc.getElementById('play-along-open');
    const writeSelect = doc.getElementById('create-write');
    const blankButton = doc.getElementById('create-blank');
    const choose = (value) => {
      writeSelect.value = value;
      writeSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
    };
    if (!engine || !panel || !opener || !writeSelect || !blankButton) {
      failures.push('start with any track: the Create panel or the engine seam is missing');
    } else {
      if (panel.hidden) opener.click();
      await new Promise((r) => setTimeout(r, 30));

      // Chords → the pad, from a Blank slate.
      blankButton.click();
      await waitUntil(() => engine.getParams().tracks.pad.state === 'off');
      if (engine.getParams().tracks.pad.state !== 'off') {
        failures.push(`start with any track: Blank slate left the pad ${engine.getParams().tracks.pad.state}, so the chords test proves nothing`);
      }
      choose('chords');
      const chordsText = doc.getElementById('compose-chords-text');
      const chordsWrite = doc.getElementById('compose-chords-write');
      if (!chordsText || !chordsWrite) {
        failures.push('start with any track: Write → Chords has no typed-chords row (#compose-chords-text / #compose-chords-write)');
      } else {
        // Four degrees every scale has, pentatonic included (the seed law refuses
        // a whole loop if one chord is outside the scale).
        chordsText.value = 'I iv V I';
        chordsText.dispatchEvent(new window.Event('input', { bubbles: true }));
        chordsWrite.click();
        await waitUntil(() => engine.getParams().tracks.pad.state === 'on');
        const after = engine.getParams();
        const seed = after.harmony && after.harmony.seed;
        if (!Array.isArray(seed) || seed.length !== 4) {
          failures.push(`start with any track: typed chords I iv V I did not reach the engine as a four-chord loop: ${JSON.stringify(seed)} (tip: ${doc.getElementById('guided-tip')?.textContent})`);
        }
        if (after.tracks.pad.state !== 'on') {
          failures.push(`start with any track: chords written onto a Blank slate left the pad ${after.tracks.pad.state} — the loop is stored and silent`);
        }
      }

      // Fit chords to the tune switches the pad on too.
      blankButton.click();
      await waitUntil(() => engine.getParams().tracks.pad.state === 'off');
      choose('melody');
      const melodyTrack = doc.getElementById('compose-melody-track');
      melodyTrack.value = 'bass';
      melodyTrack.dispatchEvent(new window.Event('change', { bubbles: true }));
      const box = doc.getElementById('compose-melody-text');
      box.value = 'C3 F3 G3 C3';
      box.dispatchEvent(new window.Event('input', { bubbles: true }));
      doc.getElementById('compose-melody-write').click();
      choose('chords');
      const harmoniseTrack = doc.getElementById('compose-harmonise-track');
      harmoniseTrack.value = 'bass';
      doc.getElementById('compose-harmonise')?.click();
      await waitUntil(() => engine.getParams().tracks.pad.state === 'on');
      if (engine.getParams().tracks.pad.state !== 'on') {
        failures.push('start with any track: Fit chords to the tune on a Blank slate left the pad off — the fitted loop is silent');
      }

      // MIDI file → hand-written, so it enters at once.
      blankButton.click();
      await waitUntil(() => engine.getParams().tracks.bass.state === 'off');
      choose('midi');
      const midiInput = doc.getElementById('compose-midi');
      const midiTrack = doc.getElementById('compose-midi-track');
      midiTrack.value = 'bass';
      // Format 0, 96 ticks a beat, one D3 lasting a beat (D3: no earlier block writes it).
      const bytes = new Uint8Array([
        0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0, 0x60,
        0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 12,
        0x00, 0x90, 0x32, 0x64, 0x60, 0x80, 0x32, 0x00, 0x00, 0xff, 0x2f, 0x00,
      ]);
      const fakeFile = { name: 'line.mid', arrayBuffer: async () => bytes.buffer.slice(0) };
      Object.defineProperty(midiInput, 'files', { configurable: true, get: () => [fakeFile] });
      midiInput.dispatchEvent(new window.Event('change', { bubbles: true }));
      const imported = () => {
        const t = engine.getParams().tracks.bass;
        const seqs = Array.isArray(t.sequencers) && t.sequencers.length ? t.sequencers : [t.sequencer];
        return seqs[0] && Array.isArray(seqs[0].steps) && seqs[0].steps.some((st) => st && st.on && st.midi === 50) ? seqs[0] : null;
      };
      await waitUntil(() => imported() !== null, 3000);
      const seq = imported();
      if (!seq) {
        failures.push(`start with any track: the MIDI file never reached the bass grid at the engine (tip: ${doc.getElementById('guided-tip')?.textContent})`);
      } else {
        // getParams() does not echo `hand`; the engine's entry bar is what it
        // decides with, so that is what is asserted (1 = the bass's staged turn).
        const entry = typeof engine.entryBar === 'function' ? engine.entryBar('bass') : 'no entryBar';
        if (entry !== 0) failures.push(`start with any track: an imported bass line enters at bar ${entry}, not at once`);
      }
      Object.defineProperty(midiInput, 'files', { configurable: true, value: null });

      choose('');
      if (!panel.hidden) opener.click();
    }
  }

  // ---- A tune over the chords (compose entry point two, melody derived) ----
  // The mirror of Fit chords: from a Blank slate (melody OFF, grids empty),
  // type a loop, choose the melody, press Write a tune over these chords. At
  // the ENGINE: the melody is switched on, its stored sequencers are one bar
  // per chord, every downbeat note is a tone of that bar's chord, and the
  // line ends on a cadence. A press again is the next seed — another tune.
  {
    const engine = window.__ambi4Engine;
    const panel = doc.getElementById('play-along');
    const opener = doc.getElementById('play-along-open');
    const writeSelect = doc.getElementById('create-write');
    const blankButton = doc.getElementById('create-blank');
    const tuneButton = doc.getElementById('compose-tune');
    const tuneTrack = doc.getElementById('compose-tune-track');
    if (!engine || !panel || !opener || !writeSelect || !blankButton || !tuneButton || !tuneTrack) {
      failures.push(`tune over chords: missing ${[!tuneButton && '#compose-tune', !tuneTrack && '#compose-tune-track', !engine && 'engine seam'].filter(Boolean).join(', ') || 'the Create panel'}`);
    } else {
      const { SCALES, pitchClass } = await import(pathToFileURL(join(repoRoot, 'src/scripts/ambient-engine.js')).href);
      if (panel.hidden) opener.click();
      await new Promise((r) => setTimeout(r, 30));
      blankButton.click();
      await waitUntil(() => engine.getParams().tracks.melody.state === 'off');
      writeSelect.value = 'chords';
      writeSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
      const shown = (el) => {
        for (let n = el; n && n !== panel; n = n.parentElement) if (n.hidden) return false;
        return true;
      };
      if (!shown(tuneButton)) failures.push('tune over chords: Write → Chords does not show Write a tune over these chords');
      const chordsText = doc.getElementById('compose-chords-text');
      chordsText.value = 'I iv V I';
      chordsText.dispatchEvent(new window.Event('input', { bubbles: true }));
      doc.getElementById('compose-chords-write').click();
      await waitUntil(() => (engine.getParams().harmony?.seed || []).length === 4);
      tuneTrack.value = 'melody';
      tuneTrack.dispatchEvent(new window.Event('change', { bubbles: true }));
      const seqsOf = (t) => (Array.isArray(t && t.sequencers) && t.sequencers.length ? t.sequencers : (t && t.sequencer ? [t.sequencer] : []));
      const pitched = () => seqsOf(engine.getParams().tracks.melody).flatMap((q, bar) =>
        (Array.isArray(q.steps) ? q.steps : []).map((st, slot) => ({ st, slot, bar })).filter(({ st }) => st && st.on && Number.isFinite(st.midi)));
      if (pitched().length) failures.push('tune over chords: Blank slate left notes on the melody, so the test proves nothing');
      tuneButton.click();
      await waitUntil(() => pitched().length > 0, 3000);
      const p = engine.getParams();
      const melody = p.tracks.melody;
      const seqs = seqsOf(melody);
      const tip = doc.getElementById('guided-tip')?.textContent;
      if (!pitched().length) {
        failures.push(`tune over chords: no notes reached the melody's stored sequencers at the engine (tip: ${tip})`);
      } else {
        if (melody.state === 'off') failures.push('tune over chords: the melody carries the tune but was left off');
        if (seqs.length !== 4) failures.push(`tune over chords: a four-chord loop wrote ${seqs.length} bars, not 4`);
        const scale = SCALES[p.mode] || SCALES.ionian;
        const rootPc = pitchClass(p.root) ?? 0;
        const degrees = (p.harmony.seed || []).map((slot) => slot.degree);
        const pcIdx = (midi) => scale.indexOf((((midi - rootPc) % 12) + 12) % 12);
        const wrong = [];
        seqs.forEach((q, bar) => {
          const head = q.steps && q.steps[0];
          if (!head || !head.on) { wrong.push(`bar ${bar} has no downbeat`); return; }
          const d = degrees[bar % degrees.length];
          const tones = [0, 2, 4].map((k) => (d + k) % scale.length);
          if (!tones.includes(pcIdx(head.midi))) wrong.push(`bar ${bar} downbeat ${head.midi} not in chord ${d}`);
        });
        const offScale = pitched().filter(({ st }) => pcIdx(st.midi) < 0);
        if (offScale.length) wrong.push(`${offScale.length} notes off the ${p.root} ${p.mode} scale`);
        const lastNote = pitched().at(-1);
        if (lastNote && pcIdx(lastNote.st.midi) !== 0) wrong.push(`the loop (ending on I) ends on ${lastNote.st.midi}, not the tonic`);
        if (wrong.length) failures.push(`tune over chords: ${wrong.join('; ')}`);
        const first = JSON.stringify(seqs.map((q) => q.steps));
        tuneButton.click();
        await waitUntil(() => JSON.stringify(seqsOf(engine.getParams().tracks.melody).map((q) => q.steps)) !== first, 3000);
        if (JSON.stringify(seqsOf(engine.getParams().tracks.melody).map((q) => q.steps)) === first) {
          failures.push('tune over chords: pressing again wrote the same tune — the seed should advance');
        }
        // Review fix: under Chord length in BEATS (2 beats in 4/4 is two
        // chords a bar) the writer read one chord per bar — beat 3's note was
        // a tone of the chord that had already gone, and "I iv V I" wrote four
        // bars over a loop the engine plays in two. Asserted at the ENGINE.
        const lengthSelect = doc.getElementById('chordLength');
        const lengthWas = lengthSelect ? lengthSelect.value : null;
        if (!lengthSelect || !lengthSelect.querySelector('option[value="beats:2"]')) {
          failures.push('tune over chords: no "2 beats" chord length to test the beats case with');
        } else if (p.timeSignature !== '4/4') {
          failures.push(`tune over chords: the beats check assumes 4/4, the Blank slate is ${p.timeSignature}`);
        } else {
          lengthSelect.value = 'beats:2';
          lengthSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
          await waitUntil(() => engine.getParams().harmony?.beats === 2);
          const before = JSON.stringify(seqsOf(engine.getParams().tracks.melody).map((q) => q.steps));
          tuneButton.click();
          await waitUntil(() => JSON.stringify(seqsOf(engine.getParams().tracks.melody).map((q) => q.steps)) !== before, 3000);
          const beatSeqs = seqsOf(engine.getParams().tracks.melody);
          const beatWrong = [];
          if (beatSeqs.length !== 2) beatWrong.push(`a four-chord loop at two chords a bar wrote ${beatSeqs.length} bars, not 2`);
          beatSeqs.forEach((q, bar) => {
            [0, 8].forEach((slot, half) => {
              const st = q.steps && q.steps[slot];
              const d = degrees[(bar * 2 + half) % degrees.length];
              const tones = [0, 2, 4].map((k) => (d + k) % scale.length);
              if (!st || !st.on || !Number.isFinite(st.midi)) beatWrong.push(`bar ${bar} slot ${slot} is silent`);
              else if (!tones.includes(pcIdx(st.midi))) beatWrong.push(`bar ${bar} slot ${slot} plays ${st.midi}, not a tone of chord ${d}`);
            });
          });
          if (beatWrong.length) failures.push(`tune over chords (2 beats a chord): ${beatWrong.join('; ')}`);
          lengthSelect.value = lengthWas;
          lengthSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
        }
        // Review suspicion, 2026-10-23 evening: the writer assumed a bar a
        // chord whatever Chord length said, and capped the tune at eight bars.
        // Under Auto (the hook draws one OR two bars a chord) and One per
        // section (a chord per structure block) no written tune can follow the
        // loop, and a loop of four chords at four bars is sixteen bars, which
        // an eight-bar tune repeating halfway through cannot follow either. So
        // after writing, the ENGINE's chord length must be a fixed bar count
        // whose pass the tune's length is a whole number of, and every bar's
        // downbeat a tone of the chord the engine plays in that bar.
        const followsLoop = async (lengthValue, why) => {
          if (!lengthSelect || !lengthSelect.querySelector(`option[value="${lengthValue}"]`)) {
            failures.push(`tune over chords (${why}): no "${lengthValue}" chord length to test with`);
            return;
          }
          lengthSelect.value = lengthValue;
          lengthSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
          await waitUntil(() => String(engine.getParams().harmony?.rhythm) === lengthValue);
          const before = JSON.stringify(seqsOf(engine.getParams().tracks.melody).map((q) => q.steps));
          tuneButton.click();
          await waitUntil(() => JSON.stringify(seqsOf(engine.getParams().tracks.melody).map((q) => q.steps)) !== before, 3000);
          const params = engine.getParams();
          const rhythm = params.harmony?.rhythm;
          const got = seqsOf(params.tracks.melody);
          const bad = [];
          if (!Number.isInteger(rhythm)) {
            bad.push(`chord length is still ${JSON.stringify(rhythm)}, which no fixed tune can follow`);
          } else {
            const pass = degrees.length * rhythm;
            if (got.length % pass !== 0) bad.push(`the tune is ${got.length} bars over a ${pass}-bar chord pass, so it repeats out of step`);
            if (lengthSelect.value !== String(rhythm)) bad.push(`the Chord length menu shows ${lengthSelect.value} while the engine plays ${rhythm}`);
            got.forEach((q, bar) => {
              const st = q.steps && q.steps[0];
              const d = degrees[Math.floor(bar / rhythm) % degrees.length];
              const tones = [0, 2, 4].map((k) => (d + k) % scale.length);
              if (!st || !st.on || !Number.isFinite(st.midi)) bad.push(`bar ${bar} downbeat is silent`);
              else if (!tones.includes(pcIdx(st.midi))) bad.push(`bar ${bar} downbeat ${st.midi} is not a tone of chord ${d}`);
            });
          }
          const tipNow = doc.getElementById('guided-tip')?.textContent || '';
          if (lengthValue !== String(rhythm) && !/chord length/i.test(tipNow)) bad.push(`the chord length changed and the tip does not say so (${tipNow})`);
          if (bad.length) failures.push(`tune over chords (${why}): ${bad.join('; ')}`);
        };
        await followsLoop('auto', 'Chord length Auto');
        await followsLoop('section', 'One per section');
        await followsLoop('4', 'four chords at four bars, a sixteen-bar loop');
        if (lengthSelect) {
          lengthSelect.value = lengthWas;
          lengthSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
        }
        // The same suspicion's third case: a tune written onto a track that
        // SOUNDS as the texture (a user track on the texture voice set) took
        // the melody's register around middle C, not the texture's high band
        // (79-100, where the engine sings every texture note it chooses).
        {
          let texId = null;
          try {
            texId = engine.addTrack({ label: 'Tune texture', family: 'melodic', voiceSet: 'texture' })?.id ?? null;
          } catch (error) {
            failures.push(`tune onto a texture: addTrack refused a texture-voiced track (${error && error.message})`);
          }
          await new Promise((r) => setTimeout(r, 30));
          if (texId) {
            if (![...tuneTrack.options].some((o) => o.value === texId)) {
              failures.push('tune onto a texture: the texture-voiced track is not offered in the tune picker');
            } else {
              tuneTrack.value = texId;
              tuneTrack.dispatchEvent(new window.Event('change', { bubbles: true }));
              tuneButton.click();
              const texPitched = () => seqsOf(engine.getParams().tracks[texId]).flatMap((q) =>
                (Array.isArray(q.steps) ? q.steps : []).filter((st) => st && st.on && Number.isFinite(st.midi)).map((st) => st.midi));
              await waitUntil(() => texPitched().length > 0, 3000);
              const midis = texPitched();
              if (!midis.length) failures.push('tune onto a texture: nothing was written');
              else if (Math.min(...midis) < 79 || Math.max(...midis) > 100) {
                failures.push(`tune onto a texture: notes span ${Math.min(...midis)}-${Math.max(...midis)}, outside the texture's 79-100 band`);
              }
            }
            try { engine.removeTrack(texId); } catch {}
            tuneTrack.value = 'melody';
            tuneTrack.dispatchEvent(new window.Event('change', { bubbles: true }));
          }
        }
      }
      writeSelect.value = '';
      writeSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
      if (!panel.hidden) opener.click();
    }
  }

  // ---- v0.0.262 the two leftovers of "Start with ANY track" ----------------
  // (1) Tap a rhythm wrote onto the built-in kit and nowhere else: it now
  // names its kit in the same row, a user's own kit included, and the raw take
  // re-fits onto that kit. (2) Texture had no grid, so no Write door could
  // start it: Write → Melody now reaches it, the line it writes IS its grid,
  // and the voice editor shows that grid. Both asserted at the ENGINE.
  {
    const engine = window.__ambi4Engine;
    const panel = doc.getElementById('play-along');
    const opener = doc.getElementById('play-along-open');
    const writeSelect = doc.getElementById('create-write');
    const blankButton = doc.getElementById('create-blank');
    const choose = (value) => {
      writeSelect.value = value;
      writeSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
    };
    const seqsOf = (t) => (Array.isArray(t && t.sequencers) && t.sequencers.length ? t.sequencers : (t && t.sequencer ? [t.sequencer] : []));
    const hits = (seq) => {
      const steps = seq && seq.steps;
      if (!steps || typeof steps !== 'object' || Array.isArray(steps)) return 0;
      return Object.values(steps).reduce((n, lane) => n + (Array.isArray(lane) ? lane.filter((st) => st && st.on).length : 0), 0);
    };
    if (!engine || !panel || !opener || !writeSelect || !blankButton || typeof engine.addTrack !== 'function') {
      failures.push('start with any track (leftovers): the Create panel, the engine seam or addTrack is missing');
    } else {
      if (panel.hidden) opener.click();
      await new Promise((r) => setTimeout(r, 30));

      // (1) Tap onto a user kit.
      let kitId = null;
      try {
        kitId = engine.addTrack({ label: 'Tap kit', family: 'percussive' })?.id ?? null;
      } catch (error) {
        failures.push(`tap onto a user kit: addTrack refused a percussive track (${error && error.message})`);
      }
      await new Promise((r) => setTimeout(r, 30));
      choose('tap');
      const tapTrack = doc.getElementById('create-tap-track');
      const tapButton = doc.getElementById('create-tap');
      if (!tapTrack) {
        failures.push('tap onto a user kit: the Tap row has no kit picker (#create-tap-track) — Tap only ever writes the built-in kit');
      } else if (kitId) {
        const offered = Array.from(tapTrack.options).map((o) => o.value);
        if (offered[0] !== 'percussion') failures.push(`tap onto a user kit: the picker does not default to the built-in kit first (${offered.join(', ')})`);
        if (!offered.includes(kitId)) failures.push(`tap onto a user kit: the picker does not offer the user kit ${kitId} (${offered.join(', ')})`);
        if (offered.some((id) => ['melody', 'bass', 'arp', 'pad', 'texture'].includes(id))) {
          failures.push(`tap onto a user kit: the picker offers a tuned track (${offered.join(', ')})`);
        }
        const kitBefore = JSON.stringify(seqsOf(engine.getParams().tracks.percussion).map((q) => q.steps));
        tapTrack.value = kitId;
        tapTrack.dispatchEvent(new window.Event('change', { bubbles: true }));
        tapButton.click();
        const armed = engine.getCapture();
        if (!armed.armed || armed.track !== kitId) {
          failures.push(`tap onto a user kit: Tap armed ${armed.armed ? armed.track : 'nothing'}, not ${kitId}`);
        }
        for (let i = 0; i < 3; i++) {
          doc.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
          doc.body.dispatchEvent(new window.KeyboardEvent('keyup', { key: ' ', bubbles: true, cancelable: true }));
        }
        tapButton.click();
        const written = engine.getParams().tracks[kitId];
        const active = seqsOf(written)[0];
        if (!active || active.mode !== 'manual' || hits(active) < 1) {
          failures.push(`tap onto a user kit: the taps never reached ${kitId}'s stored grid at the engine (${active ? `${active.mode}, ${hits(active)} hits` : 'no sequencer'})`);
        }
        const kitAfter = JSON.stringify(seqsOf(engine.getParams().tracks.percussion).map((q) => q.steps));
        if (kitAfter !== kitBefore) failures.push('tap onto a user kit: the taps were written onto the built-in kit as well');
        // Re-fit lands the SAME take on the same kit.
        const raw = typeof engine.getLastTake === 'function' ? engine.getLastTake() : null;
        if (!raw || raw.track !== kitId) failures.push(`tap onto a user kit: the raw take is kept for ${raw ? raw.track : 'nothing'}, not ${kitId}`);
        doc.getElementById('create-refit')?.click();
        const refitted = seqsOf(engine.getParams().tracks[kitId])[0];
        if (!refitted || refitted.mode !== 'manual' || hits(refitted) < 1) failures.push('tap onto a user kit: Re-fit left the user kit without the take');
        if (JSON.stringify(seqsOf(engine.getParams().tracks.percussion).map((q) => q.steps)) !== kitBefore) {
          failures.push('tap onto a user kit: Re-fit wrote the take onto the built-in kit');
        }
        tapTrack.value = 'percussion';
        tapTrack.dispatchEvent(new window.Event('change', { bubbles: true }));
      }
      if (kitId && typeof engine.removeTrack === 'function') {
        try { engine.removeTrack(kitId); } catch {}
      }

      // (2) Write → Melody onto the texture, from a Blank slate.
      blankButton.click();
      await waitUntil(() => engine.getParams().tracks.texture.state === 'off');
      if ('sequencers' in engine.getParams().tracks.texture) {
        failures.push('melody onto texture: a Blank slate leaves the texture holding a grid');
      }
      choose('melody');
      const melodyTrack = doc.getElementById('compose-melody-track');
      const targets = Array.from(melodyTrack.options).map((o) => o.value);
      if (!targets.includes('texture')) {
        failures.push(`melody onto texture: Write → Melody does not offer the texture (${targets.join(', ')})`);
      } else {
        melodyTrack.value = 'texture';
        melodyTrack.dispatchEvent(new window.Event('change', { bubbles: true }));
        const box = doc.getElementById('compose-melody-text');
        box.value = 'C6 E6 G6';
        box.dispatchEvent(new window.Event('input', { bubbles: true }));
        doc.getElementById('compose-melody-write').click();
        await waitUntil(() => engine.getParams().tracks.texture.state !== 'off');
        const texture = engine.getParams().tracks.texture;
        if (texture.state === 'off') failures.push('melody onto texture: writing a line left the texture off');
        const seq = seqsOf(texture)[0];
        const pinned = seq && Array.isArray(seq.steps)
          ? [0, 4, 8].map((slot) => seq.steps[slot] && seq.steps[slot].on ? seq.steps[slot].midi : null) : [];
        if (!seq || seq.mode !== 'manual' || JSON.stringify(pinned) !== JSON.stringify([84, 88, 91])) {
          failures.push(`melody onto texture: the engine's texture grid is ${seq ? `${seq.mode}, beats ${JSON.stringify(pinned)}` : 'absent'}, not manual C6 E6 G6`);
        }
        const entry = typeof engine.entryBar === 'function' ? engine.entryBar('texture') : 'no entryBar';
        if (entry !== 0) failures.push(`melody onto texture: the written texture enters at bar ${entry}, not at once`);
        const editor = await openEditor('texture');
        if (!editor || !editor.querySelector('.seq')) failures.push('melody onto texture: the texture editor shows no step grid once it has one');
        const cells = editor ? editor.querySelectorAll('.seq .seq-cell-on') : [];
        if (editor && editor.querySelector('.seq') && !cells.length) failures.push('melody onto texture: the texture grid draws none of the written steps');
        blankButton.click();
        await waitUntil(() => !('sequencers' in engine.getParams().tracks.texture));
        if ('sequencers' in engine.getParams().tracks.texture) failures.push('melody onto texture: Blank slate did not take the texture grid away at the engine');
      }
      choose('');
      if (!panel.hidden) opener.click();
    }
  }

  // ---- one interaction model: today's controls, audited (v0.0.229-263) -------
  // The same job reads the same way everywhere. Every Create picker that
  // names where something is written carries the same visible "onto" (a
  // hidden label read as decoration, v0.0.194); the typed chords say "per
  // chord", since a chord can now last beats; each ⓘ is named by the title it
  // sits beside; and the match's Stop explains itself like its two siblings.
  {
    for (const id of ['compose-melody-track', 'compose-beat-track', 'compose-words-track', 'compose-midi-track', 'compose-tune-track', 'create-tap-track']) {
      const label = doc.querySelector(`label[for="${id}"]`);
      if (!label || label.classList.contains('visually-hidden') || label.textContent.trim() !== 'onto') {
        failures.push(`one model: #${id} has no visible "onto" label (${label ? JSON.stringify(label.textContent.trim()) + (label.classList.contains('visually-hidden') ? ', hidden' : '') : 'none'})`);
      }
    }
    const chordsText = doc.getElementById('compose-chords-text');
    if (!chordsText || !/per chord/.test(chordsText.placeholder) || /per bar/.test(chordsText.placeholder)) {
      failures.push(`one model: the typed-chords box says ${JSON.stringify(chordsText && chordsText.placeholder)} — a chord can last beats, not only a bar`);
    }
    const chordsWrite = doc.getElementById('compose-chords-write');
    const chordsDesc = chordsWrite && doc.getElementById(chordsWrite.getAttribute('aria-describedby') || '');
    if (!chordsDesc || /one per bar/.test(chordsDesc.textContent)) {
      failures.push(`one model: Write it on the chords row describes itself as ${JSON.stringify(chordsDesc && chordsDesc.textContent)}`);
    }
    for (const [slot, name] of [['create-info', 'Create'], ['follow-chords-info', 'Follow my chords'], ['musical-typing-info', 'Musical typing']]) {
      const btn = doc.querySelector(`#${slot} .info-button`);
      if (!btn || btn.getAttribute('aria-label') !== `About ${name}`) {
        failures.push(`one model: the ⓘ by ${name} is named ${JSON.stringify(btn && btn.getAttribute('aria-label'))}, not "About ${name}"`);
      }
    }
    const createBox = doc.querySelector('#create-info .info-box');
    if (!createBox || !/Write it makes them the chord loop/.test(createBox.textContent)) {
      failures.push('one model: the Create ⓘ still says Chords only opens the chord editor — the typed chords and Write it are missing');
    }
    const editor = await openEditor('melody');
    const more = editor.querySelector('.ve-more');
    if (more && more.getAttribute('aria-expanded') !== 'true') more.click();
    await waitUntil(() => editor.querySelector('.ve-sample-stop'));
    const stop = editor.querySelector('.ve-sample-stop');
    const stopDesc = stop && doc.getElementById(stop.getAttribute('aria-describedby') || '');
    if (!stopDesc || !/closest voice/.test(stopDesc.textContent)) {
      failures.push('one model: Match a sample’s Stop has no description, though Choose a sound file and Record a note beside it do');
    }
    for (const [cls, name] of [['.ve-sample-choose', 'Choose a sound file'], ['.ve-sample-record', 'Record a note']]) {
      const el = editor.querySelector(cls);
      if (!el || !el.getAttribute('aria-describedby') || !doc.getElementById(el.getAttribute('aria-describedby'))) {
        failures.push(`one model: ${name} has a tooltip but no accessible description (describe() ran before it had a parent)`);
      }
    }
  }

  // ---- v0.0.249 the Processor dial takes a span ------------------------------
  // Untouched it IS the whole Eco–Full span, which is the old Auto; a sideways
  // gesture (here its keyboard form, Shift+Left/Right) narrows the span the
  // governor may move inside, a collapsed span pins one tier, and the reset
  // goes back to Auto. Asserted at the GOVERNOR (window.__ambi4Governor), not
  // the readout — a dial drawing a value nobody received is the failure mode.
  await (async () => {
    const gov = window.__ambi4Governor;
    const knob = doc.querySelector('#processor-dial [role="slider"]');
    const readout = doc.getElementById('processor-readout');
    if (!gov || typeof gov.getRange !== 'function') {
      failures.push('the page exposes no range-aware governor (window.__ambi4Governor.getRange)');
    } else if (!knob) {
      failures.push('the Processor dial rendered no slider');
    } else {
      const press = (key, shiftKey = false) =>
        knob.dispatchEvent(new window.KeyboardEvent('keydown', { key, shiftKey, bubbles: true }));
      const state = () => ({ spec: gov.getTier(), range: gov.getRange(), auto: gov.getAuto() });
      const fresh = state();
      if (fresh.spec !== 'auto' || fresh.range.min !== 'eco' || fresh.range.max !== 'full' || !fresh.auto) {
        failures.push(`an untouched Processor dial did not hand the governor the full Eco–Full span (auto): ${JSON.stringify(fresh)}`);
      }
      if (!/min Eco, max Full/.test(knob.getAttribute('aria-valuetext') || '')) {
        failures.push(`an untouched Processor dial does not read as the Eco–Full span (${knob.getAttribute('aria-valuetext')})`);
      }
      press('ArrowLeft', true); // narrow: Eco–Full → Low–Med
      const narrowed = state();
      if (narrowed.spec !== 'low-med' || narrowed.range.min !== 'low' || narrowed.range.max !== 'med'
        || !['low', 'med'].includes(narrowed.auto)) {
        failures.push(`narrowing the Processor span did not hand the governor Low–Med, sensing inside it: ${JSON.stringify(narrowed)}`);
      }
      if (readout && !/^Low–Med \((low|med)\)/.test(readout.textContent)) {
        failures.push(`the Processor status does not say the span it is moving in: "${readout.textContent}"`);
      }
      press('ArrowLeft', true); // narrow past nothing: a single tier — a pin
      const pinned = state();
      if (pinned.auto !== null || pinned.range.min !== pinned.range.max || pinned.spec !== pinned.range.min) {
        failures.push(`collapsing the Processor span did not pin one tier at the governor: ${JSON.stringify(pinned)}`);
      }
      press('ArrowRight', true); // widen again from the pin
      const widened = state();
      if (widened.range.min === widened.range.max || widened.auto === null) {
        failures.push(`widening a pinned Processor dial did not give the governor a span again: ${JSON.stringify(widened)}`);
      }
      // The widened span holds the pinned tier, so the governor's tier does
      // not move and it emits nothing — the readout must still say the new
      // span. It used to keep the pin's name ("Low · 14 notes"), and the
      // narrowing check above failed whenever the sensed tier was already
      // inside the narrowed span (2026-10-23, seen once the run got faster).
      const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
      if (readout && widened.range.min !== widened.range.max
        && !readout.textContent.startsWith(`${cap(widened.range.min)}–${cap(widened.range.max)} (`)) {
        failures.push(`the Processor status did not follow a span that kept the governor's tier: "${readout.textContent}" for ${JSON.stringify(widened.range)}`);
      }
      press('Backspace'); // reset → the declared default, Eco–Full
      const reset = state();
      if (reset.spec !== 'auto' || reset.range.min !== 'eco' || reset.range.max !== 'full') {
        failures.push(`resetting the Processor dial did not go back to Auto (Eco–Full): ${JSON.stringify(reset)}`);
      }
    }
  })();

  // ---- v27 blank slate (fromMartin 25) --------------------------------------
  // Clicking Blank slate must leave every track OFF — the "all you" state.
  // Runs LAST: it rewrites the whole params object, so it must follow every
  // boot-state and fresh-visit-genre assertion.
  await (async () => {
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
      // The motif rule zeroed with every other rule: Chance 0, Pool empty.
      const motifRule = window.__ambi4Engine.getParams().tracks.melody.motifRule;
      if (!motifRule || motifRule.chance !== 0 || !Array.isArray(motifRule.pool) || motifRule.pool.length !== 0) {
        failures.push(`after Blank slate the melody's motif rule is ${JSON.stringify(motifRule)}, not Chance 0 with an empty pool`);
      }
    }
  })();

  // ---- v29 share names, receiving end --------------------------------------
  // A `#p=` link must announce itself by the SAME three words its sender saw.
  // Nothing in the first boot can show this — that page arrived with no
  // fragment — so this is a second, deliberately minimal boot of the same
  // bundle in a second jsdom, against a URL that carries a share link. It runs
  // LAST because it swaps the DOM globals the bundle reads.
  await (async () => {
    const payload = Buffer.from(JSON.stringify({ bpm: 71, reverb: 0.42, harmony: { beats: 5 } }), 'utf8').toString(
      'base64url'
    );
    const expected = shareNameModule.shareNameFor(`p=${payload}`, SHARE_POOL);
    const arrivalDom = new JSDOM(html, {
      url: `https://ambi4.work/#p=${payload}`,
      pretendToBeVisual: true,
      runScripts: 'outside-only',
    });
    const arrivalWindow = arrivalDom.window;
    answerLeaveGuardWithMoveOn(arrivalWindow);
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
        // Review follow-up: the link carries chord length 5 beats, which the
        // sanitiser keeps (1-8) and the engine plays, but the select listed
        // only 1-3 beats and so showed a BAR setting the engine did not have.
        const lengthSelect = arrivalDoc.getElementById('chordLength');
        const heldBeats = arrivalWindow.__ambi4Engine?.getParams().harmony.beats;
        if (heldBeats !== 5) failures.push(`a link carrying chord length 5 beats left the engine on ${JSON.stringify(heldBeats)} — the select check proves nothing`);
        else if (!lengthSelect || lengthSelect.value !== 'beats:5') {
          failures.push(`a link carrying chord length 5 beats shows the Chord length select as ${JSON.stringify(lengthSelect && lengthSelect.value)} (${JSON.stringify(lengthSelect?.selectedOptions?.[0]?.textContent)})`);
        } else if (!/^5 beats/.test(lengthSelect.selectedOptions[0].textContent)) {
          failures.push(`the 5-beat chord length is labelled ${JSON.stringify(lengthSelect.selectedOptions[0].textContent)}`);
        }
      }
    } catch (err) {
      failures.push(`booting on a #p= share link threw: ${err && err.stack ? err.stack : err}`);
    }
  })();

  // v0.0.182 (unit 8): a voice of the person's own survives a reload — the
  // storage format is what a fresh boot reads. Consent recorded, one voice
  // under prefs 'voices', and the pad picker lists it; picking it puts its
  // base and its patch at the engine.
  await (async () => {
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
    answerLeaveGuardWithMoveOn(reloadWindow);
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
      // Review suspicion, 2026-10-23 evening: a stored harmony.beats of `true`
      // went through Number(true) === 1 in the page's normaliser and became a
      // one-beat chord length. A kept preset carries one here.
      if (store && typeof store.setItem === 'function') {
        store.setItem('ambi4:presets', JSON.stringify([{ name: 'Beats true', params: { harmony: { rhythm: 2, beats: true } } }]));
      }
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
        // Two renders of one editor in the same tick (two picks, a pick and a
        // wander, a genre and a pick) used to BOTH build: each claimed the
        // slot, awaited the voices table, then appended its whole editor into
        // the one container — every control twice, every id twice — and the
        // first build, no longer the registered one, was never torn down, so
        // its listeners kept it alive after the next render detached it (the
        // bulk of this harness's ~3.5 GB, 2026-10-23). The later render wins;
        // the superseded one must build nothing.
        const padToggle = reloadDoc.getElementById('voice-edit-toggle-pad');
        const padEditor = reloadDoc.getElementById('voice-editor-pad');
        if (select && padToggle && padEditor) {
          if (padEditor.hidden) padToggle.click();
          const opened = await waitUntil(() => !padEditor.hidden && padEditor.querySelector('.patch-controls'));
          if (!opened) {
            failures.push('the reloaded page\'s pad editor never opened');
          } else {
            const pick = select.value;
            for (let i = 0; i < 2; i++) {
              select.value = pick;
              select.dispatchEvent(new reloadWindow.Event('change', { bubbles: true }));
            }
            await new Promise((r) => setTimeout(r, 300));
            const panels = padEditor.querySelectorAll('.patch-controls').length;
            const ids = Array.from(padEditor.querySelectorAll('[id]'), (el) => el.id);
            const twice = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
            if (panels !== 1 || twice.length) {
              failures.push(
                `two renders of the pad editor in one tick left ${panels} dial panels in it` +
                  (twice.length ? ` and ${twice.length} ids twice (${twice.slice(0, 3).join(', ')})` : '')
              );
            }
          }
        }
      }
      if (booted) {
        const reloadDoc = reloadWindow.document;
        const presetSelect = reloadDoc.getElementById('preset-load');
        const option = presetSelect && [...presetSelect.options].find((o) => o.textContent.trim() === 'Beats true');
        if (!option) {
          failures.push(`a kept preset is not listed after a reload (${JSON.stringify(presetSelect && [...presetSelect.options].map((o) => o.textContent))})`);
        } else {
          presetSelect.value = option.value;
          presetSelect.dispatchEvent(new reloadWindow.Event('change', { bubbles: true }));
          const harmony = await waitUntil(() => reloadWindow.__ambi4Engine.getParams().harmony.rhythm === 2)
            && reloadWindow.__ambi4Engine.getParams().harmony;
          if (!harmony) failures.push('loading a kept preset did not reach the engine (chord length 2 bars)');
          else if ('beats' in harmony) {
            failures.push(`a kept preset's harmony.beats of true became a chord length of ${JSON.stringify(harmony.beats)} beat(s), not dropped`);
          }
          const lengthSelect = reloadDoc.getElementById('chordLength');
          if (lengthSelect && lengthSelect.value !== '2') failures.push(`after harmony.beats true the Chord length menu shows ${lengthSelect.value}, not 2 bars`);
        }
      }
    } catch (err) {
      failures.push(`booting with a stored voice threw: ${err && err.stack ? err.stack : err}`);
    }
  })();

  // v0.0.183 (unit 9): a link whose pad is tagged with a voice of someone's
  // own arrives on a device that has never seen it: the sound plays (voice
  // and patch, as any link), and the name joins this visit's My voices.
  await (async () => {
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
    answerLeaveGuardWithMoveOn(voiceWindow);
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
          const more = melodyEditor.querySelector('.ve-more');
          if (more && more.getAttribute('aria-expanded') !== 'true') more.click();
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
  })();

  // v0.0.181 (unit 13): a link CARRYING a genre of someone's own arrives on a
  // device that has never seen it. The base rebuilds from the carried genre
  // (tempo 200, pad Off are its rules), the engine is tagged with it, and it
  // sits under My genres for this visit.
  await (async () => {
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
    answerLeaveGuardWithMoveOn(carryWindow);
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
        const group = Array.from(carryDoc.querySelectorAll('#genre-select optgroup')).find((g) => g.label === 'User');
        const entry = group && group.querySelector('option[value="g:u-carriedtest"]');
        if (!entry || entry.textContent !== 'Carried') failures.push('a carried genre is not listed under My genres for this visit');
      }
    } catch (err) {
      failures.push(`booting on a link carrying a genre threw: ${err && err.stack ? err.stack : err}`);
    }
  })();

  // iOS gesture environment (docs/dial-control-plane-plan.md section 10): the
  // surfaces that own a drag must say so in CSS, or Safari reads the drag as a
  // page scroll / back-swipe and cancels the pointer. Style TEXT is asserted
  // because jsdom does not cascade stylesheets from the page source.
  await (async () => {
    const pageSource = readFileSync(join(repoRoot, 'src/pages/index.astro'), 'utf8');
    const globalCss = readFileSync(join(repoRoot, 'src/styles/global.css'), 'utf8');
    const ruleBody = (src, selector) => {
      const m = new RegExp('(?:^|\\n)\\s*' + selector.replace(/[.]/g, '\\.') + '\\s*\\{([^}]*)\\}').exec(src);
      return m ? m[1] : '';
    };
    const cell = ruleBody(pageSource, '.seq-cell');
    for (const decl of [/touch-action:\s*none/, /user-select:\s*none/, /-webkit-touch-callout:\s*none/]) {
      if (!decl.test(cell)) failures.push(`.seq-cell owns a vertical drag but lacks ${decl} (iOS gesture spec)`);
    }
    if (!/overscroll-behavior-x:\s*none/.test(ruleBody(globalCss, 'html'))) {
      failures.push('global.css html rule lacks overscroll-behavior-x: none (iOS gesture spec)');
    }
    if (!/env\(safe-area-inset-left\)/.test(globalCss)) {
      failures.push('global.css never reads env(safe-area-inset-left) though the viewport is viewport-fit=cover');
    }
  })();

  // v0.0.249: the Processor span is the DEVICE's (it lives in settings.ui, which
  // no share link or preset carries — a laptop's budget is not a phone's), so
  // what has to round-trip is storage: a stored 'low-med' reaches the governor
  // on the next visit, a share link arriving on top does not clobber it, and a
  // change persists as the same string. The link also carries more modulation
  // connections (D10) than either tier of that span is budgeted for — the only
  // route by which edges reach the engine today, there being no socket UI —
  // and the page must say so in words near the dial.
  await (async () => {
    const edges = Array.from({ length: 20 }, (_, i) => ({ source: i % 2 ? 'lfo.1' : 'macro.1', destination: `pad:p${i}` }));
    const payload = Buffer.from(JSON.stringify({ bpm: 72, routing: edges, v: 2 }), 'utf8').toString('base64url');
    const procDom = new JSDOM(html, {
      url: `https://ambi4.work/#p=${payload}`,
      pretendToBeVisual: true,
      runScripts: 'outside-only',
    });
    const procWindow = procDom.window;
    answerLeaveGuardWithMoveOn(procWindow);
    const procContexts = new WeakMap();
    procWindow.HTMLCanvasElement.prototype.getContext = function getContext() {
      let ctx = procContexts.get(this);
      if (!ctx) {
        ctx = stubCanvasContext();
        ctx.canvas = this;
        procContexts.set(this, ctx);
      }
      return ctx;
    };
    procWindow.HTMLCanvasElement.prototype.toDataURL = () => 'data:,';
    procWindow.AudioContext = StubAudioContext;
    procWindow.OfflineAudioContext = undefined;
    procWindow.devicePixelRatio = 1;
    installClipboard(procWindow);
    for (const key of passthrough) {
      if (procWindow[key] !== undefined) globalThis[key] = procWindow[key];
    }
    globalThis.self = procWindow;
    for (const d of new Set([procWindow.document, globalThis.document])) if (d) d.cookie = 'ambi4-consent=granted';
    const stores = [...new Set([procWindow.localStorage, globalThis.localStorage])].filter((st) => st && typeof st.setItem === 'function');
    const storedSetup = { bpm: 90, ui: { processor: 'low-med' } };
    for (const store of stores) store.setItem('ambi4:generator', JSON.stringify(storedSetup));
    // The bundle's prefs module is shared across these boots (Node caches it
    // by URL), and its in-memory layer still holds the first boot's
    // pre-consent setup, which it reads BEFORE storage. Writing through that
    // same module with consent granted clears the shadow, as a real reload
    // would never have had one.
    const prefsChunk = readdirSync(join(distDir, '_astro')).find((f) => /^prefs\..*\.js$/.test(f));
    if (prefsChunk) {
      const prefsModule = await import(pathToFileURL(join(distDir, '_astro', prefsChunk)).href);
      prefsModule.prefs?.set?.('generator', storedSetup);
    }
    const storedSpec = () => {
      for (const store of stores) {
        try {
          const parsed = JSON.parse(store.getItem('ambi4:generator') || 'null');
          if (parsed && parsed.ui && parsed.ui.processor !== undefined) return parsed.ui.processor;
        } catch {}
      }
      return undefined;
    };
    try {
      await import(`${pathToFileURL(bundlePath).href}?processor-span`);
      const procDoc = procWindow.document;
      const booted = await waitUntil(() => {
        const el = procDoc.getElementById('generator-app');
        return Boolean(el) && !el.hidden;
      }, 8000);
      if (!booted) {
        failures.push('the page did not boot with a stored Processor span and a link carrying routing');
      } else {
        const gov = procWindow.__ambi4Governor;
        const engineRouting = procWindow.__ambi4Engine.getParams().routing;
        if (!gov || typeof gov.getRange !== 'function') {
          failures.push('the stored-span boot exposes no range-aware governor');
        } else {
          const range = gov.getRange();
          if (gov.getTier() !== 'low-med' || range.min !== 'low' || range.max !== 'med' || !['low', 'med'].includes(gov.getAuto())) {
            failures.push(`a stored Processor span 'low-med' did not reach the governor on the next visit (${gov.getTier()}, ${JSON.stringify(range)}, at ${gov.getAuto()})`);
          }
          const knob = procDoc.querySelector('#processor-dial [role="slider"]');
          if (!knob || !/min Low, max Med/.test(knob.getAttribute('aria-valuetext') || '')) {
            failures.push(`the Processor dial does not draw the stored Low–Med span (${knob && knob.getAttribute('aria-valuetext')})`);
          }
          // D10: twenty edges at the engine, over Low's 8 and Med's 16.
          if (!Array.isArray(engineRouting) || engineRouting.length !== 20) {
            failures.push(`a link carrying 20 routing edges left the engine holding ${engineRouting && engineRouting.length}`);
          }
          const status = gov.connectionStatus();
          if (status.count !== 20 || !status.over) {
            failures.push(`the governor was not told the engine's connections, or did not call them over budget: ${JSON.stringify(status)}`);
          }
          const warning = procDoc.getElementById('processor-warning');
          if (!warning || warning.hidden || !/20 modulation connections/.test(warning.textContent)
            || !/(Low|Med) is budgeted for/.test(warning.textContent)) {
            failures.push(`connections over the tier's budget are not said in words near the Processor dial ("${warning ? warning.textContent : '(no #processor-warning)'}", hidden ${warning && warning.hidden})`);
          }
          // Removing the edges takes the warning away (counted once a bar, and
          // by any snapshot load; here the count is reported directly).
          procWindow.__ambi4Engine.setParams({ routing: [] });
          gov.setConnections(procWindow.__ambi4Engine.getParams().routing.length);
          if (warning && !warning.hidden) failures.push('the connection warning stayed up after the edges were removed');
          // Persist: narrow the dial to a pin and read storage back.
          if (knob) {
            knob.dispatchEvent(new procWindow.KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true, bubbles: true }));
            const pin = gov.getTier();
            const persisted = await waitUntil(() => storedSpec() === pin, 3000);
            if (!persisted || gov.getAuto() !== null) {
              failures.push(`pinning the Processor dial did not persist the governor's spec (stored ${JSON.stringify(storedSpec())}, governor ${pin}, sensing at ${gov.getAuto()})`);
            }
          }
        }
      }
    } catch (err) {
      failures.push(`booting with a stored Processor span threw: ${err && err.stack ? err.stack : err}`);
    }
  })();

  // ---- 2026-10-23: Edit still opens every editor, late in a long session --
  // Reported: late in this run, clicking a track's Edit stopped opening its
  // editor, with no error. It was the harness, not the page: the second boots
  // above leave the bundle's globals on THEIR window (see adoptGlobals), so
  // the main page's Edit handler opened the other page's editor. Runs LAST,
  // after every section, as a person's long session of edits: the main
  // window adopted back, each track's Edit, clicked, must show
  // #voice-editor-<track> WITH its dials, and a second click must close it.
  // Without the adoptGlobals line it is red for five of six tracks.
  await (async () => {
    adoptGlobals(window);
    for (const track of REGISTRY_IDS) {
      const toggle = doc.getElementById(`voice-edit-toggle-${track}`);
      if (!toggle) { failures.push(`late Edit: no Edit button for ${track}`); continue; }
      let editor = doc.getElementById(`voice-editor-${track}`);
      if (editor && !editor.hidden) {
        toggle.click();
        await waitUntil(() => doc.getElementById(`voice-editor-${track}`)?.hidden, 1000);
      }
      toggle.click();
      const open = await waitUntil(() => {
        const el = doc.getElementById(`voice-editor-${track}`);
        return Boolean(el && !el.hidden && el.querySelector('.knob'));
      }, 2000);
      editor = doc.getElementById(`voice-editor-${track}`);
      if (!open) {
        failures.push(`late Edit: clicking ${track}'s Edit did not open its editor (editor ${editor ? (editor.hidden ? 'hidden' : 'shown') : 'missing'}, ${editor ? editor.querySelectorAll('.knob').length : 0} dials, aria-expanded ${toggle.getAttribute('aria-expanded')}, toggle ${toggle.isConnected ? 'connected' : 'detached'}${toggle.disabled ? ', disabled' : ''})`);
        continue;
      }
      toggle.click();
      const closed = await waitUntil(() => doc.getElementById(`voice-editor-${track}`)?.hidden, 2000);
      if (!closed) failures.push(`late Edit: a second click on ${track}'s Edit did not close its editor`);
    }
  })();

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
