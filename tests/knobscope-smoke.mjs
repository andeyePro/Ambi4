/**
 * Smoke test for src/scripts/knob.js + src/scripts/scope.js — run with:
 *   node tests/knobscope-smoke.mjs
 *
 * Drives createKnob() against a mock DOM (document/createElementNS/events)
 * and renderPatchWave()/attachLiveScope() against a mock 2d canvas context,
 * mock OfflineAudioContext and mock rAF — proving the aria contract, silent
 * set(), key/drag/dblclick interaction, destroy idempotence, the offline
 * audio-graph build (morphed PeriodicWave coefficients + filter config), the
 * math-model fallback, per-canvas render coalescing, and live-scope
 * subscribe/unsubscribe — including bare-Node import safety for both modules.
 */

import assert from 'node:assert/strict';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// --------------------------------------------------------------------------
// Mock DOM (for knob.js)
// --------------------------------------------------------------------------

function mockElement(tag) {
  const listeners = new Map(); // type -> Set<fn>
  return {
    tagName: tag,
    children: [],
    attributes: {},
    style: {},
    textContent: '',
    className: '',
    parentNode: null,
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; },
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      child.parentNode = null;
    },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    listenerCount(type) { return listeners.get(type)?.size || 0; },
    dispatch(type, evt = {}) {
      for (const fn of [...(listeners.get(type) || [])]) {
        fn({ type, preventDefault() {}, stopPropagation() {}, ...evt });
      }
    },
    setPointerCapture() {},
    releasePointerCapture() {},
    focus() {},
  };
}

const docListeners = new Map(); // document-level (visibilitychange etc.)
const mockDocument = {
  hidden: false,
  createElement: (tag) => mockElement(tag),
  createElementNS: (_ns, tag) => mockElement(tag),
  addEventListener(type, fn) {
    if (!docListeners.has(type)) docListeners.set(type, new Set());
    docListeners.get(type).add(fn);
  },
  removeEventListener(type, fn) { docListeners.get(type)?.delete(fn); },
};

// --------------------------------------------------------------------------
// Mock 2d canvas (for scope.js)
// --------------------------------------------------------------------------

function makeCtx2d(calls) {
  const record = (name) => { calls[name] = (calls[name] || 0) + 1; };
  return {
    clearRect() { record('clearRect'); },
    fillRect() { record('fillRect'); },
    beginPath() {},
    moveTo() {},
    lineTo(x, y) { record('lineTo'); calls.lastLineY = y; },
    stroke() { record('stroke'); },
    fill() { record('fill'); },
    setTransform() {},
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineJoin: '',
    lineCap: '',
    shadowColor: '',
    shadowBlur: 0,
  };
}

function makeCanvas(calls) {
  let ctx = null;
  return {
    width: 600,
    height: 300,
    clientWidth: 600,
    clientHeight: 300,
    getContext(kind) {
      if (kind !== '2d') return null;
      if (!ctx) ctx = makeCtx2d(calls);
      return ctx;
    },
    getBoundingClientRect() {
      return { width: 600, height: 300 };
    },
  };
}

// --------------------------------------------------------------------------
// Mock OfflineAudioContext
// --------------------------------------------------------------------------

function makeBuffer(length, sampleRate) {
  const data = new Float32Array(length);
  for (let i = 0; i < length; i++) data[i] = Math.sin((2 * Math.PI * i) / 200) * 0.5;
  return { length, sampleRate, getChannelData: () => data };
}

function makeOfflineClass({ manual = false, ctors, pending }) {
  const makeParam = (v = 0) => ({ value: v });
  return class MockOfflineAudioContext {
    constructor(channels, length, sampleRate) {
      this.channels = channels;
      this.length = length;
      this.sampleRate = sampleRate;
      this.destination = {};
      this.oscillators = [];
      this.gains = [];
      this.filters = [];
      ctors.push(this);
    }
    createPeriodicWave(real, imag, opts) {
      return { real, imag, opts };
    }
    createOscillator() {
      const osc = {
        type: 'sine',
        frequency: makeParam(),
        detune: makeParam(),
        wave: null,
        started: false,
        setPeriodicWave(w) { this.wave = w; },
        connect() {},
        start() { this.started = true; },
      };
      this.oscillators.push(osc);
      return osc;
    }
    createGain() {
      const gain = { gain: makeParam(1), connect() {} };
      this.gains.push(gain);
      return gain;
    }
    createBiquadFilter() {
      const filter = { type: 'lowpass', frequency: makeParam(), Q: makeParam(), connect() {} };
      this.filters.push(filter);
      return filter;
    }
    startRendering() {
      if (!manual) return Promise.resolve(makeBuffer(this.length, this.sampleRate));
      return new Promise((resolve) => {
        pending.push(() => resolve(makeBuffer(this.length, this.sampleRate)));
      });
    }
  };
}

// --------------------------------------------------------------------------
// Knob tests
// --------------------------------------------------------------------------

let createKnob;
let scope;

test('knob: imports cleanly in bare Node (no document) and degrades inert', async () => {
  assert.equal(typeof globalThis.document, 'undefined');
  const mod = await import('../src/scripts/knob.js');
  createKnob = mod.createKnob;
  assert.equal(typeof createKnob, 'function');
  assert.equal(typeof mod.default, 'function');
  // No DOM at call time → inert handle rather than a throw.
  const inert = createKnob(null, { label: 'x', min: 0, max: 1, value: 0.5 });
  assert.equal(inert.el, null);
  inert.set(1);
  inert.destroy();
});

test('scope: imports cleanly in bare Node', async () => {
  scope = await import('../src/scripts/scope.js');
  assert.equal(typeof scope.renderPatchWave, 'function');
  assert.equal(typeof scope.attachLiveScope, 'function');
  // From here on the tests want a document mock.
  globalThis.document = mockDocument;
});

function makeTestKnob(overrides = {}) {
  const container = mockElement('div');
  const inputs = [];
  const knob = createKnob(container, {
    label: 'Cutoff',
    min: 0,
    max: 10,
    value: 5,
    step: 1,
    onInput: (v) => inputs.push(v),
    ...overrides,
  });
  return { container, knob, inputs };
}

test('knob: aria slider contract on the focusable root', () => {
  const { container, knob } = makeTestKnob();
  const el = knob.el;
  assert.equal(container.children[0], el);
  assert.equal(el.getAttribute('role'), 'slider');
  assert.equal(el.getAttribute('tabindex'), '0');
  assert.equal(el.getAttribute('aria-label'), 'Cutoff');
  assert.equal(el.getAttribute('aria-valuemin'), '0');
  assert.equal(el.getAttribute('aria-valuemax'), '10');
  assert.equal(el.getAttribute('aria-valuenow'), '5');
  assert.equal(el.getAttribute('aria-valuetext'), '5');
  knob.destroy();
});

test('knob: set() updates value + aria silently (no onInput)', () => {
  const { knob, inputs } = makeTestKnob();
  knob.set(3);
  assert.equal(knob.el.getAttribute('aria-valuenow'), '3');
  assert.equal(knob.el.getAttribute('aria-valuetext'), '3');
  assert.deepEqual(inputs, []);
  knob.set(99); // clamps
  assert.equal(knob.el.getAttribute('aria-valuenow'), '10');
  assert.deepEqual(inputs, []);
  knob.destroy();
});

test('knob: keyboard events fire onInput per change and clamp at ends', () => {
  const { knob, inputs } = makeTestKnob();
  const el = knob.el;
  el.dispatch('keydown', { key: 'ArrowUp' });     // 5 → 6
  el.dispatch('keydown', { key: 'PageUp' });      // 6 → 16 → clamps 10
  el.dispatch('keydown', { key: 'ArrowUp' });     // at max: no change, no onInput
  el.dispatch('keydown', { key: 'Home' });        // → 0
  el.dispatch('keydown', { key: 'ArrowDown' });   // at min: no change
  el.dispatch('keydown', { key: 'End' });         // → 10
  el.dispatch('keydown', { key: 'PageDown' });    // 10 → 0
  el.dispatch('keydown', { key: 'z' });           // unhandled key: ignored
  assert.deepEqual(inputs, [6, 10, 0, 10, 0]);
  assert.equal(el.getAttribute('aria-valuenow'), '0');
  knob.destroy();
});

test('knob: pointer drag and wheel adjust the value', () => {
  const { knob, inputs } = makeTestKnob({ step: undefined });
  const el = knob.el;
  el.dispatch('pointerdown', { button: 0, pointerId: 1, clientY: 200 });
  el.dispatch('pointermove', { clientY: 180 }); // 20 px up = +1 of a 0–10 range
  el.dispatch('pointerup', { pointerId: 1 });
  assert.equal(inputs.length, 1);
  assert.ok(Math.abs(inputs[0] - 6) < 1e-9, `expected ~6, got ${inputs[0]}`);
  el.dispatch('wheel', { deltaY: -3 }); // one small step up
  assert.equal(inputs.length, 2);
  assert.ok(inputs[1] > inputs[0]);
  knob.destroy();
});

test('knob: double-click resets to the INITIAL value and fires onInput', () => {
  const { knob, inputs } = makeTestKnob();
  knob.el.dispatch('keydown', { key: 'End' }); // → 10
  knob.el.dispatch('dblclick');
  assert.equal(knob.el.getAttribute('aria-valuenow'), '5');
  assert.deepEqual(inputs, [10, 5]);
  knob.el.dispatch('dblclick'); // already at initial: no extra onInput
  assert.deepEqual(inputs, [10, 5]);
  knob.destroy();
});

test('knob: destroy removes the node + listeners and is idempotent', () => {
  const { container, knob } = makeTestKnob();
  const el = knob.el;
  assert.equal(container.children.length, 1);
  assert.ok(el.listenerCount('keydown') > 0);
  knob.destroy();
  assert.equal(container.children.length, 0);
  assert.equal(el.listenerCount('keydown'), 0);
  assert.equal(el.listenerCount('pointerdown'), 0);
  assert.equal(el.listenerCount('wheel'), 0);
  knob.destroy(); // repeat destroy must be a no-op, not a throw
});

// --------------------------------------------------------------------------
// Scope tests — offline path
// --------------------------------------------------------------------------

const basePatch = (over = {}) => ({
  source: { shape1: 0, shape2: null, mix: 0.5, detune: 0, octave: 0, ...(over.source || {}) },
  filter: { type: 'highpass', cutoff: 1200, q: 5, ...(over.filter || {}) },
});

test('scope: offline path builds the graph — sine vs saw coefficients, filter config', async () => {
  const ctors = [];
  globalThis.OfflineAudioContext = makeOfflineClass({ ctors, pending: [] });
  try {
    const calls = {};
    const canvas = makeCanvas(calls);

    // shape 0 (sine): fundamental only
    await scope.renderPatchWave(canvas, basePatch(), { freq: 220 });
    assert.equal(ctors.length, 1);
    const sineCtx = ctors[0];
    assert.equal(sineCtx.oscillators.length, 1, 'shape2:null must build a single oscillator');
    const sineImag = sineCtx.oscillators[0].wave.imag;
    assert.ok(Math.abs(sineImag[1]) > 0.9, 'sine fundamental expected');
    assert.ok(Math.abs(sineImag[2]) < 1e-6, 'sine must have no 2nd harmonic');
    assert.ok(sineCtx.oscillators[0].started);

    // filter comes from the patch
    assert.equal(sineCtx.filters.length, 1);
    assert.equal(sineCtx.filters[0].type, 'highpass');
    assert.equal(sineCtx.filters[0].frequency.value, 1200);
    assert.equal(sineCtx.filters[0].Q.value, 5);

    // shape 2 (sawtooth) + shape2/detune: two oscillators, rich harmonics
    await scope.renderPatchWave(canvas, basePatch({ source: { shape1: 2, shape2: 3, detune: 7 } }));
    const sawCtx = ctors[ctors.length - 1];
    assert.equal(sawCtx.oscillators.length, 2);
    const sawImag = sawCtx.oscillators[0].wave.imag;
    assert.ok(Math.abs(sawImag[2]) > 1e-3, 'sawtooth must have a 2nd harmonic');
    assert.notDeepEqual([...sineImag], [...sawImag], 'coefficients must differ for shape 0 vs 2');
    assert.equal(sawCtx.oscillators[1].detune.value, 7, 'osc2 carries the detune');

    // legacy string names still map (square → odd harmonics only)
    await scope.renderPatchWave(canvas, basePatch({ source: { shape1: 'square' } }));
    const sqImag = ctors[ctors.length - 1].oscillators[0].wave.imag;
    assert.ok(Math.abs(sqImag[3]) > 1e-3, 'square must have a 3rd harmonic');
    assert.ok(Math.abs(sqImag[2]) < 1e-6, 'square must have no 2nd harmonic');

    assert.ok(calls.fillRect >= 1, 'expected background fills');
    assert.ok(calls.stroke >= 1, 'expected the trace to be stroked');
  } finally {
    delete globalThis.OfflineAudioContext;
  }
});

test('scope: fallback path draws without OfflineAudioContext', async () => {
  assert.equal(typeof globalThis.OfflineAudioContext, 'undefined');
  const calls = {};
  const canvas = makeCanvas(calls);
  await scope.renderPatchWave(canvas, basePatch({ filter: { type: 'lowpass', cutoff: 400, q: 1 } }));
  assert.ok(calls.fillRect >= 1, 'expected background fill');
  assert.ok(calls.stroke >= 1, 'expected grid + trace strokes');
  assert.ok(calls.lineTo >= 100, 'expected a many-point trace polyline');
  // Bad canvas degrades to a resolved promise, no throw.
  await scope.renderPatchWave({}, basePatch());
  await scope.renderPatchWave({ getContext: () => null }, basePatch());
});

test('scope: concurrent renders per canvas coalesce — latest wins', async () => {
  const ctors = [];
  const pending = [];
  globalThis.OfflineAudioContext = makeOfflineClass({ manual: true, ctors, pending });
  try {
    const calls = {};
    const canvas = makeCanvas(calls);
    const p1 = scope.renderPatchWave(canvas, basePatch({ filter: { cutoff: 100 } }));
    const p2 = scope.renderPatchWave(canvas, basePatch({ filter: { cutoff: 200 } }));
    const p3 = scope.renderPatchWave(canvas, basePatch({ filter: { cutoff: 300 } }));
    assert.equal(ctors.length, 1, 'only the first render starts while busy');
    assert.equal(ctors[0].filters[0].frequency.value, 100);

    pending.shift()(); // finish render 1
    await p1;
    assert.equal(ctors.length, 2, 'intermediate patch (200) must be skipped');
    assert.equal(ctors[1].filters[0].frequency.value, 300, 'latest patch wins');

    pending.shift()(); // finish render 2
    await Promise.all([p2, p3]);
    assert.equal(ctors.length, 2);
    assert.ok(calls.stroke >= 2, 'both completed renders drew');
  } finally {
    delete globalThis.OfflineAudioContext;
  }
});

// --------------------------------------------------------------------------
// Scope tests — live scope
// --------------------------------------------------------------------------

function makeAnalyser({ float = true } = {}) {
  const analyser = {
    fftSize: 128,
    getByteTimeDomainData(buf) {
      for (let i = 0; i < buf.length; i++) buf[i] = 128 + Math.round(Math.sin(i / 4) * 100);
    },
  };
  if (float) {
    analyser.getFloatTimeDomainData = (buf) => {
      for (let i = 0; i < buf.length; i++) buf[i] = Math.sin(i / 4) * 0.8;
    };
  }
  return analyser;
}

function withMockRaf(fn) {
  const rafCbs = new Map();
  let nextId = 1;
  globalThis.requestAnimationFrame = (cb) => {
    const id = nextId++;
    rafCbs.set(id, cb);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => { rafCbs.delete(id); };
  const stepFrame = () => {
    const frames = [...rafCbs.values()];
    rafCbs.clear();
    for (const cb of frames) cb(0);
  };
  try {
    return fn({ rafCbs, stepFrame });
  } finally {
    delete globalThis.requestAnimationFrame;
    delete globalThis.cancelAnimationFrame;
  }
}

test('scope: live scope subscribes (rAF + visibility) and unsubscribes on destroy', () => {
  withMockRaf(({ rafCbs, stepFrame }) => {
    const calls = {};
    const canvas = makeCanvas(calls);
    const before = docListeners.get('visibilitychange')?.size || 0;

    const live = scope.attachLiveScope(canvas, makeAnalyser());
    assert.equal(typeof live.destroy, 'function');
    assert.equal(rafCbs.size, 1, 'a frame must be scheduled');
    assert.equal((docListeners.get('visibilitychange')?.size || 0), before + 1);

    stepFrame();
    assert.ok(calls.stroke >= 1, 'expected a drawn trace');
    assert.equal(rafCbs.size, 1, 'loop must reschedule itself');

    live.destroy();
    assert.equal(rafCbs.size, 0, 'destroy must cancel the pending frame');
    assert.equal((docListeners.get('visibilitychange')?.size || 0), before);
    live.destroy(); // idempotent
  });
});

test('scope: live scope works via the byte fallback and pauses when hidden', () => {
  withMockRaf(({ rafCbs, stepFrame }) => {
    const calls = {};
    const canvas = makeCanvas(calls);
    const live = scope.attachLiveScope(canvas, makeAnalyser({ float: false }));
    stepFrame();
    assert.ok(calls.stroke >= 1, 'byte-only analyser must still draw');

    mockDocument.hidden = true;
    try {
      stepFrame(); // loop sees hidden and stops rescheduling
      assert.equal(rafCbs.size, 0, 'hidden document must pause the loop');
      for (const cb of [...(docListeners.get('visibilitychange') || [])]) cb();
      mockDocument.hidden = false;
      for (const cb of [...(docListeners.get('visibilitychange') || [])]) cb();
      assert.equal(rafCbs.size, 1, 'visible again must resume the loop');
    } finally {
      mockDocument.hidden = false;
    }
    live.destroy();

    // Degenerate inputs return inert handles, never throw.
    scope.attachLiveScope(canvas, null).destroy();
    scope.attachLiveScope(null, makeAnalyser()).destroy();
    scope.attachLiveScope(canvas, {}).destroy();
  });
});

// --------------------------------------------------------------------------
// Runner
// --------------------------------------------------------------------------

let failures = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}\n     ${error.stack || error.message}`);
  }
}
console.log(`\n${tests.length - failures}/${tests.length} passed`);
process.exit(failures ? 1 : 0);
