/**
 * Smoke test for src/scripts/knob.js + src/scripts/scope.js — run with:
 *   node tests/knobscope-smoke.mjs
 *
 * Drives createKnob() against a mock DOM (document/createElementNS/events)
 * and renderPatchWave()/attachLiveScope()/attachMultiScope() against a mock
 * 2d canvas context, mock OfflineAudioContext, mock engine, and mock rAF —
 * proving the aria contract, silent set(), key/drag/dblclick interaction,
 * destroy idempotence, the offline audio-graph build (morphed PeriodicWave
 * coefficients + filter config), the math-model fallback, per-canvas render
 * coalescing, live-scope subscribe/unsubscribe, and multi-scope per-track
 * traces/colours/gain/legend/perf discipline — including bare-Node import
 * safety for both modules.
 */

import assert from 'node:assert/strict';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// --------------------------------------------------------------------------
// Mock DOM (for knob.js)
// --------------------------------------------------------------------------

function mockElement(tag) {
  const listeners = new Map(); // type -> Set<fn>
  let textContentValue = '';
  const el = {
    tagName: tag,
    children: [],
    attributes: {},
    style: {},
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
  // Real elements' `.textContent` setter clears every child (including text
  // nodes) before the new string becomes the sole content — knob.js's v12
  // glyph readout relies on that (setValueText re-renders from scratch each
  // call). A plain stored field wouldn't replicate the "clears children"
  // half of that contract, so this is a real accessor.
  Object.defineProperty(el, 'textContent', {
    get() {
      if (this.children.length) {
        return this.children.map((c) => (c.nodeType === 3 ? c.textContent : c.textContent || '')).join('');
      }
      return textContentValue;
    },
    set(v) {
      this.children.length = 0;
      textContentValue = String(v);
    },
  });
  return el;
}

function mockTextNode(text) {
  return { nodeType: 3, textContent: String(text) };
}

const docListeners = new Map(); // document-level (visibilitychange etc.)
const mockDocument = {
  hidden: false,
  createElement: (tag) => mockElement(tag),
  createElementNS: (_ns, tag) => mockElement(tag),
  createTextNode: (text) => mockTextNode(text),
  addEventListener(type, fn) {
    if (!docListeners.has(type)) docListeners.set(type, new Set());
    docListeners.get(type).add(fn);
  },
  removeEventListener(type, fn) { docListeners.get(type)?.delete(fn); },
};

// --------------------------------------------------------------------------
// Mock 2d canvas (for scope.js)
// --------------------------------------------------------------------------

// Matches scope.js's private FALLBACK_TRACE (getComputedStyle is undefined in
// bare Node, so drawScope always falls back to this amber literal here).
const TRACE_COLOR = '#f5b642';

// `propWrites`, if passed, collects every property NAME assigned on the 2d
// context (not just method calls) so tests can assert e.g. 'shadowBlur' is
// never touched during a normal frame.
function makeCtx2d(calls, propWrites) {
  const record = (name) => { calls[name] = (calls[name] || 0) + 1; };
  // Every moveTo/lineTo issued while strokeStyle is the trace colour is the
  // actual waveform path (grid lines stroke in the grid colour); tests reset
  // this between frames to inspect one frame's drawn Y-span in isolation.
  // `pointsByColor` is the generalised form for multi-scope tests, keyed by
  // whatever strokeStyle was active — lets a test tell N distinct trace
  // colours apart from each other and from the grid colour.
  const base = {
    clearRect() { record('clearRect'); },
    fillRect(x, y, w, h) {
      record('fillRect');
      (calls.fillRects ||= []).push({ x, y, w, h, style: this.fillStyle });
    },
    beginPath() {},
    moveTo(x, y) {
      if (this.strokeStyle === TRACE_COLOR) (calls.tracePoints ||= []).push(y);
      ((calls.pointsByColor ||= {})[this.strokeStyle] ||= []).push(y);
    },
    lineTo(x, y) {
      record('lineTo');
      calls.lastLineY = y;
      if (this.strokeStyle === TRACE_COLOR) (calls.tracePoints ||= []).push(y);
      ((calls.pointsByColor ||= {})[this.strokeStyle] ||= []).push(y);
    },
    stroke() { record('stroke'); },
    fill() { record('fill'); },
    setTransform() {},
    measureText(text) { return { width: String(text).length * 6 }; },
    fillText(text) { record('fillText'); (calls.fillTexts ||= []).push(text); },
  };
  if (!propWrites) {
    return {
      ...base,
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      lineJoin: '',
      lineCap: '',
      shadowColor: '',
      shadowBlur: 0,
      font: '',
      textAlign: '',
      textBaseline: '',
    };
  }
  return new Proxy(base, {
    set(target, prop, value) {
      propWrites.add(prop);
      target[prop] = value;
      return true;
    },
  });
}

function makeCanvas(calls, opts = {}) {
  let ctx = null;
  return {
    width: 600,
    height: 300,
    clientWidth: 600,
    clientHeight: 300,
    getContext(kind) {
      if (kind !== '2d') return null;
      if (!ctx) ctx = makeCtx2d(calls, opts.propWrites);
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
// Knob tests — v7 dual min/max range mode
// --------------------------------------------------------------------------

// A click = pointerdown + pointerup at (nearly) the same spot, fast.
function clickKnob(el, x = 50, y = 50) {
  el.dispatch('pointerdown', { button: 0, pointerId: 1, clientX: x, clientY: y });
  el.dispatch('pointerup', { pointerId: 1, clientX: x, clientY: y });
}

test('knob v7: number-only knob ignores clicks as mode toggles', () => {
  const { knob, inputs } = makeTestKnob(); // no allowRange
  clickKnob(knob.el);
  assert.equal(knob.el.getAttribute('aria-valuetext'), '5', 'must stay in single mode');
  assert.equal(knob.el.getAttribute('aria-valuenow'), '5');
  assert.deepEqual(inputs, [], 'a click on a number-only knob must not emit');
  knob.destroy();
});

test('knob v7: allowRange click toggles single ↔ range, preserving values; drags never toggle', () => {
  const { knob, inputs } = makeTestKnob({ allowRange: true });
  const el = knob.el;
  clickKnob(el); // split: min=max=value
  assert.deepEqual(inputs, [{ min: 5, max: 5 }]);
  assert.equal(el.getAttribute('aria-valuetext'), '5 (range collapsed)', 'min===max reads as a collapsed range');
  el.dispatch('keydown', { key: 'End', shiftKey: true }); // max → 10
  assert.deepEqual(inputs[1], { min: 5, max: 10 });
  clickKnob(el); // merge: (5+10)/2 = 7.5 → step 1 quantises to 8
  assert.equal(inputs[2], 8);
  assert.equal(el.getAttribute('aria-valuetext'), '8');
  // A real drag (>5 px between down and up) must NOT toggle the mode.
  el.dispatch('pointerdown', { button: 0, pointerId: 1, clientX: 40, clientY: 200 });
  el.dispatch('pointermove', { clientY: 150 });
  el.dispatch('pointerup', { pointerId: 1, clientX: 40, clientY: 150 });
  assert.ok(
    !el.getAttribute('aria-valuetext').includes('drifting'),
    'a drag must never toggle into range mode'
  );
  assert.equal(typeof inputs[inputs.length - 1], 'number');
  knob.destroy();
});

test('knob v7: {min,max} initial value renders range mode', () => {
  const { knob, inputs } = makeTestKnob({ allowRange: true, value: { min: 2, max: 8 } });
  const el = knob.el;
  assert.equal(el.getAttribute('aria-valuenow'), '2');
  assert.equal(el.getAttribute('aria-valuetext'), 'min 2, max 8, drifting');
  assert.equal(el.children[2].textContent, '2 – 8', 'readout shows "min – max"');
  assert.deepEqual(inputs, []);
  knob.destroy();
});

test('knob v7: plain arrows move min, Shift-arrows move max', () => {
  const { knob, inputs } = makeTestKnob({ allowRange: true, value: { min: 4, max: 6 } });
  const el = knob.el;
  el.dispatch('keydown', { key: 'ArrowUp' });                 // min 4 → 5
  el.dispatch('keydown', { key: 'ArrowUp', shiftKey: true }); // max 6 → 7
  assert.deepEqual(inputs, [{ min: 5, max: 6 }, { min: 5, max: 7 }]);
  el.dispatch('keydown', { key: 'ArrowUp' }); // min 5 → 6
  el.dispatch('keydown', { key: 'ArrowUp' }); // min 6 → 7 (meets max exactly, no push needed)
  assert.deepEqual(inputs.slice(2), [{ min: 6, max: 7 }, { min: 7, max: 7 }]);
  el.dispatch('keydown', { key: 'ArrowDown' });                 // min 7 → 6
  el.dispatch('keydown', { key: 'ArrowDown', shiftKey: true }); // max 7 → 6
  assert.deepEqual(inputs.slice(4), [{ min: 6, max: 7 }, { min: 6, max: 6 }]);
  assert.equal(el.getAttribute('aria-valuetext'), '6 (range collapsed)');
  knob.destroy();
});

test('knob v16: keyed push-through — min past max carries max up, max past min carries min down', () => {
  const { knob, inputs } = makeTestKnob({ allowRange: true, value: { min: 4, max: 6 } });
  const el = knob.el;
  el.dispatch('keydown', { key: 'ArrowUp' }); // min 4 → 5 (max stays 6)
  el.dispatch('keydown', { key: 'ArrowUp' }); // min 5 → 6: meets max exactly, range collapses
  el.dispatch('keydown', { key: 'ArrowUp' }); // min 6 → 7: PAST max(6) — pushes max up to 7 too
  assert.deepEqual(inputs, [{ min: 5, max: 6 }, { min: 6, max: 6 }, { min: 7, max: 7 }]);
  el.dispatch('keydown', { key: 'ArrowUp' }); // min 7 → 8: still collapsed — pushes max to 8 again
  assert.deepEqual(inputs[3], { min: 8, max: 8 }, 'min pushing past max must carry max along, not clamp');
  assert.equal(el.getAttribute('aria-valuetext'), '8 (range collapsed)');
  el.dispatch('keydown', { key: 'ArrowDown', shiftKey: true }); // max 8 → 7: PAST min(8) — pushes min to 7
  assert.deepEqual(inputs[4], { min: 7, max: 7 }, 'max pushing past min must carry min along, not clamp');
  el.dispatch('keydown', { key: 'ArrowDown', shiftKey: true }); // max 7 → 6: still below min(7) — pushes min to 6
  assert.deepEqual(inputs[5], { min: 6, max: 6 });
  el.dispatch('keydown', { key: 'ArrowDown' }); // min 6 → 5: below max(6), no push — ordinary move
  assert.deepEqual(inputs[6], { min: 5, max: 6 });
  assert.equal(el.getAttribute('aria-valuetext'), 'min 5, max 6, drifting');
  knob.destroy();
});

test('knob v7: onInput payload is a number in single mode, {min,max} in range mode', () => {
  const { knob, inputs } = makeTestKnob({ allowRange: true });
  const el = knob.el;
  el.dispatch('keydown', { key: 'ArrowUp' }); // single: 5 → 6
  assert.equal(typeof inputs[0], 'number');
  assert.equal(inputs[0], 6);
  clickKnob(el); // → range
  assert.deepEqual(inputs[1], { min: 6, max: 6 });
  el.dispatch('wheel', { deltaY: -3, shiftKey: true }); // Shift-wheel edits max
  assert.deepEqual(inputs[2], { min: 6, max: 7 });
  el.dispatch('wheel', { deltaY: -3 }); // plain wheel edits min — clamps at max
  assert.deepEqual(inputs[3], { min: 7, max: 7 });
  knob.destroy();
});

test('knob v7: set({min,max}) and set(number) switch mode silently', () => {
  const { knob, inputs } = makeTestKnob({ allowRange: true });
  knob.set({ min: 2, max: 8 });
  assert.equal(knob.el.getAttribute('aria-valuetext'), 'min 2, max 8, drifting');
  assert.equal(knob.el.getAttribute('aria-valuenow'), '2');
  assert.deepEqual(inputs, [], 'set() must not emit');
  knob.set(4);
  assert.equal(knob.el.getAttribute('aria-valuetext'), '4');
  assert.equal(knob.el.getAttribute('aria-valuenow'), '4');
  assert.deepEqual(inputs, []);
  knob.destroy();
});

test('knob v7: dblclick restores the INITIAL value AND mode', () => {
  // Numeric initial toggled into range → dblclick returns to single 5.
  const a = makeTestKnob({ allowRange: true });
  clickKnob(a.knob.el);
  a.knob.el.dispatch('keydown', { key: 'End', shiftKey: true }); // max → 10
  a.knob.el.dispatch('dblclick');
  assert.equal(a.knob.el.getAttribute('aria-valuetext'), '5');
  assert.equal(a.inputs[a.inputs.length - 1], 5);
  a.knob.destroy();
  // Range initial merged to single → dblclick returns to range {2,8}.
  const b = makeTestKnob({ allowRange: true, value: { min: 2, max: 8 } });
  clickKnob(b.knob.el); // merge → (2+8)/2 = 5
  assert.equal(b.inputs[0], 5);
  b.knob.el.dispatch('dblclick');
  assert.deepEqual(b.inputs[1], { min: 2, max: 8 });
  assert.equal(b.knob.el.getAttribute('aria-valuetext'), 'min 2, max 8, drifting');
  b.knob.el.dispatch('dblclick'); // already at initial form: no extra onInput
  assert.equal(b.inputs.length, 2);
  b.knob.destroy();
});

test('knob v7: aria-valuetext + readout apply the format fn to both ends', () => {
  const { knob } = makeTestKnob({
    allowRange: true,
    value: { min: 2, max: 8 },
    format: (v) => `${v}Hz`,
  });
  assert.equal(knob.el.getAttribute('aria-valuetext'), 'min 2Hz, max 8Hz, drifting');
  assert.equal(knob.el.children[2].textContent, '2Hz – 8Hz');
  knob.destroy();
});

test('knob v7: rangeDefault splits a numeric initial into min=max=value', () => {
  const { knob, inputs } = makeTestKnob({ allowRange: true, rangeDefault: true });
  assert.equal(knob.el.getAttribute('aria-valuetext'), '5 (range collapsed)');
  assert.equal(knob.el.children[2].textContent, '5 – 5');
  assert.deepEqual(inputs, []);
  // dblclick restores the range form (rangeDefault IS the initial mode).
  knob.el.dispatch('keydown', { key: 'End', shiftKey: true });
  knob.el.dispatch('dblclick');
  assert.equal(knob.el.getAttribute('aria-valuetext'), '5 (range collapsed)');
  knob.destroy();
});

// --------------------------------------------------------------------------
// Knob tests — v12 declared defaultValue + glyphs
// --------------------------------------------------------------------------

test('knob v12: defaultValue overrides dblclick reset target (single mode)', () => {
  const { knob, inputs } = makeTestKnob({ value: 5, defaultValue: 2 });
  knob.el.dispatch('keydown', { key: 'End' }); // → 10
  knob.el.dispatch('dblclick');
  assert.equal(knob.el.getAttribute('aria-valuenow'), '2', 'must reset to defaultValue, not initial 5');
  assert.deepEqual(inputs, [10, 2]);
  knob.el.dispatch('dblclick'); // already at default: no extra onInput
  assert.deepEqual(inputs, [10, 2]);
  knob.destroy();
});

test('knob v12: defaultValue as {min,max} switches mode+values on dblclick', () => {
  const { knob, inputs } = makeTestKnob({ allowRange: true, value: 5, defaultValue: { min: 1, max: 3 } });
  knob.el.dispatch('keydown', { key: 'End' }); // single → 10
  knob.el.dispatch('dblclick');
  assert.equal(knob.el.getAttribute('aria-valuetext'), 'min 1, max 3, drifting');
  assert.deepEqual(inputs[inputs.length - 1], { min: 1, max: 3 });
  knob.destroy();
});

test('knob v12: a scalar defaultValue collapses a range-mode knob back to single', () => {
  const { knob, inputs } = makeTestKnob({ allowRange: true, value: { min: 2, max: 8 }, defaultValue: 4 });
  knob.el.dispatch('keydown', { key: 'ArrowUp', shiftKey: true }); // max 8 → 9, still range
  knob.el.dispatch('dblclick');
  assert.equal(knob.el.getAttribute('aria-valuetext'), '4');
  assert.equal(inputs[inputs.length - 1], 4);
  knob.destroy();
});

test('knob v12: omitted defaultValue keeps the pre-v12 initial-value/mode reset', () => {
  const { knob, inputs } = makeTestKnob({ allowRange: true, value: { min: 2, max: 8 } });
  knob.el.dispatch('keydown', { key: 'ArrowUp' }); // still range, min moves
  knob.el.dispatch('dblclick');
  assert.equal(knob.el.getAttribute('aria-valuetext'), 'min 2, max 8, drifting');
  assert.deepEqual(inputs[inputs.length - 1], { min: 2, max: 8 });
  knob.destroy();
});

test('knob v12: markGlyphs draws a glyph group at a matching major mark, plain ticks elsewhere', () => {
  const container = mockElement('div');
  const knob = createKnob(container, {
    label: 'Shape',
    min: 0,
    max: 3,
    value: 0,
    marks: [0, 1, 2, 3],
    markGlyphs: { '0': '<path d="M0 0"/>', '2': '<path d="M2 2"/>' },
  });
  const svg = knob.el.children[0];
  const ticksGroup = svg.children.find((c) => c.tagName === 'g' && !c.attributes.transform);
  const glyphNodes = ticksGroup.children.filter((c) => c.tagName === 'g' && c.attributes.transform);
  assert.equal(glyphNodes.length, 2, 'exactly the two marks with a markGlyphs entry get a glyph <g>');
  assert.ok(glyphNodes.every((g) => typeof g.innerHTML === 'string' && g.innerHTML.startsWith('<path')));
  const lineTicks = ticksGroup.children.filter((c) => c.tagName === 'line');
  // 25 minor ticks + 2 plain major ticks (marks 1 and 3, which have no glyph)
  assert.equal(lineTicks.length, 25 + 2);
  knob.destroy();
});

test('knob v12: glyph(value) prepends a no-text glyph span; readout text is unchanged', () => {
  const { knob } = makeTestKnob({
    min: 0,
    max: 3,
    value: 1,
    step: null,
    format: (v) => `v${Math.round(v)}`,
    glyph: (v) => `<svg><path d="glyph-${Math.round(v)}"/></svg>`,
  });
  const valueEl = knob.el.children[2];
  assert.equal(valueEl.children.length, 2, 'a glyph span plus the text node');
  const glyphSpan = valueEl.children[0];
  assert.equal(glyphSpan.className, 'knob-value-glyph');
  assert.ok(glyphSpan.innerHTML.includes('glyph-1'));
  const textNode = valueEl.children[1];
  assert.equal(textNode.textContent, 'v1');
  assert.equal(knob.el.getAttribute('aria-valuetext'), 'v1', 'aria-valuetext is unaffected by the glyph');
  knob.destroy();
});

test('knob v12: glyph returning null draws no glyph span, just the text node', () => {
  const { knob } = makeTestKnob({ value: 5, glyph: () => null });
  const valueEl = knob.el.children[2];
  assert.equal(valueEl.children.length, 1);
  assert.equal(valueEl.children[0].textContent, '5');
  knob.destroy();
});

test('knob v12: a throwing glyph() degrades to text-only, never breaks the knob', () => {
  const { knob } = makeTestKnob({
    value: 5,
    glyph: () => {
      throw new Error('boom');
    },
  });
  const valueEl = knob.el.children[2];
  assert.equal(valueEl.children.length, 1);
  assert.equal(valueEl.children[0].textContent, '5');
  knob.destroy();
});

// --------------------------------------------------------------------------
// Knob tests — v14 range-zone drag + click-to-type
// --------------------------------------------------------------------------

// A square 100×100 face, top-left at the origin — matches how pointerDeg /
// pointerFaceZone read rect.width as the SVG's (square) pixel side. Centre
// is (50,50); FACE_R=31 viewBox units → a 31px face radius at this scale.
const SQUARE_RECT = { left: 0, top: 0, width: 100, height: 100 };

test('knob v14: pointerdown INSIDE the face drags min, OUTSIDE the face drags max', () => {
  const inside = makeTestKnob({ allowRange: true, step: undefined, value: { min: 4, max: 6 } });
  inside.knob.el.getBoundingClientRect = () => SQUARE_RECT;
  // 10px above centre = distance 10 < the 31px face radius → inside → min.
  inside.knob.el.dispatch('pointerdown', { button: 0, pointerId: 1, clientX: 50, clientY: 40 });
  inside.knob.el.dispatch('pointermove', { clientY: 20 }); // 20px further up = +1 over a 0–10 range
  inside.knob.el.dispatch('pointerup', { pointerId: 1 });
  assert.deepEqual(inside.inputs[inside.inputs.length - 1], { min: 5, max: 6 }, 'inside-face drag must move min only');
  inside.knob.destroy();

  const outside = makeTestKnob({ allowRange: true, step: undefined, value: { min: 4, max: 6 } });
  outside.knob.el.getBoundingClientRect = () => SQUARE_RECT;
  // 45px above centre = distance 45 > the 31px face radius, and >12° from
  // the current max-thumb angle, so this is a zone grab, not a near grab.
  outside.knob.el.dispatch('pointerdown', { button: 0, pointerId: 1, clientX: 50, clientY: 5 });
  outside.knob.el.dispatch('pointermove', { clientY: -15 }); // 20px further up = +1
  outside.knob.el.dispatch('pointerup', { pointerId: 1 });
  assert.deepEqual(outside.inputs[outside.inputs.length - 1], { min: 4, max: 7 }, 'outside-face drag must move max only');
  outside.knob.destroy();
});

test('knob v16: dragging min past max pushes max along (collapses, then both move together)', () => {
  const { knob, inputs } = makeTestKnob({ allowRange: true, step: undefined, value: { min: 4, max: 6 } });
  knob.el.getBoundingClientRect = () => SQUARE_RECT;
  // Inside the face → drags min. clientY=40 is inside (distance 10 < 31px face radius).
  knob.el.dispatch('pointerdown', { button: 0, pointerId: 1, clientX: 50, clientY: 40 });
  knob.el.dispatch('pointermove', { clientY: 0 }); // 40px up = +2: min 4 → 6, meets max exactly
  assert.deepEqual(inputs[inputs.length - 1], { min: 6, max: 6 }, 'reaching max exactly collapses the range');
  knob.el.dispatch('pointermove', { clientY: -40 }); // another 40px up = +2: min PAST max — pushes it
  assert.deepEqual(inputs[inputs.length - 1], { min: 8, max: 8 }, 'dragging min past max must carry max along, not clamp at 6');
  knob.el.dispatch('pointermove', { clientY: -80 }); // both keep moving together while collapsed
  assert.deepEqual(inputs[inputs.length - 1], { min: 10, max: 10 });
  knob.el.dispatch('pointerup', { pointerId: 1 });
  knob.destroy();
});

test('knob v16: dragging max past min pushes min along (collapses, then both move together)', () => {
  const { knob, inputs } = makeTestKnob({ allowRange: true, step: undefined, value: { min: 4, max: 6 } });
  knob.el.getBoundingClientRect = () => SQUARE_RECT;
  // Outside the face → drags max. clientY=5 is outside (distance 45 > 31px face radius).
  knob.el.dispatch('pointerdown', { button: 0, pointerId: 1, clientX: 50, clientY: 5 });
  knob.el.dispatch('pointermove', { clientY: 45 }); // 40px down = −2: max 6 → 4, meets min exactly
  assert.deepEqual(inputs[inputs.length - 1], { min: 4, max: 4 }, 'reaching min exactly collapses the range');
  knob.el.dispatch('pointermove', { clientY: 85 }); // another 40px down = −2: max PAST min — pushes it
  assert.deepEqual(inputs[inputs.length - 1], { min: 2, max: 2 }, 'dragging max past min must carry min along, not clamp at 4');
  knob.el.dispatch('pointerup', { pointerId: 1 });
  knob.destroy();
});

test('knob v14: Shift remains a secondary max alias when face geometry is unavailable', () => {
  // No getBoundingClientRect override on this knob's root — pointerFaceZone
  // and pointerDeg both degrade to null, so Shift is the only way in.
  const { knob, inputs } = makeTestKnob({ allowRange: true, step: undefined, value: { min: 4, max: 6 } });
  const el = knob.el;
  el.dispatch('pointerdown', { button: 0, pointerId: 1, clientX: 50, clientY: 100, shiftKey: true });
  el.dispatch('pointermove', { clientY: 80 }); // 20px up = +1
  el.dispatch('pointerup', { pointerId: 1 });
  assert.deepEqual(inputs[inputs.length - 1], { min: 4, max: 7 }, 'Shift-held drag must still move max');
  knob.destroy();
});

test('knob v14: the readout is a focusable button; click swaps it for a pre-filled input', () => {
  const { knob } = makeTestKnob({ value: 5, min: 0, max: 10, step: 1 });
  const valueEl = knob.el.children[2];
  assert.equal(valueEl.tagName, 'button');
  valueEl.dispatch('click');
  assert.equal(valueEl.style.display, 'none', 'the readout button must hide while editing');
  const input = knob.el.children[3];
  assert.equal(input.tagName, 'input');
  assert.equal(input.value, '5', 'single mode pre-fills the plain current value');
  knob.destroy();
});

test('knob v14: Enter commits a typed value through the clamp path and fires onInput', () => {
  const { knob, inputs } = makeTestKnob({ value: 5, min: 0, max: 10, step: 1 });
  const valueEl = knob.el.children[2];
  valueEl.dispatch('click');
  const input = knob.el.children[3];
  input.value = '99'; // out of range — must clamp through the normal commit path
  input.dispatch('keydown', { key: 'Enter' });
  assert.equal(knob.el.getAttribute('aria-valuenow'), '10', 'must clamp at max like any other commit');
  assert.deepEqual(inputs, [10]);
  assert.equal(valueEl.style.display, '', 'the readout button must reappear after commit');
  assert.equal(knob.el.children.length, 3, 'the input must be removed after commit');
  knob.destroy();
});

test('knob v14: blur commits exactly like Enter', () => {
  const { knob, inputs } = makeTestKnob({ value: 5, min: 0, max: 10, step: 1 });
  const valueEl = knob.el.children[2];
  valueEl.dispatch('click');
  const input = knob.el.children[3];
  input.value = '7';
  input.dispatch('blur');
  assert.equal(knob.el.getAttribute('aria-valuenow'), '7');
  assert.deepEqual(inputs, [7]);
  knob.destroy();
});

test('knob v14: Esc cancels the edit without committing or emitting', () => {
  const { knob, inputs } = makeTestKnob({ value: 5, min: 0, max: 10, step: 1 });
  const valueEl = knob.el.children[2];
  valueEl.dispatch('click');
  const input = knob.el.children[3];
  input.value = '9';
  input.dispatch('keydown', { key: 'Escape' });
  assert.equal(knob.el.getAttribute('aria-valuenow'), '5', 'value must be unchanged');
  assert.deepEqual(inputs, [], 'Esc must not fire onInput');
  assert.equal(valueEl.style.display, '', 'the readout button must reappear after cancel');
  assert.equal(knob.el.children.length, 3, 'the input must be removed after cancel');
  knob.destroy();
});

test('knob v14: range text parse accepts "a-b" and "a to b", order-independent, both thumbs', () => {
  const { knob, inputs } = makeTestKnob({
    allowRange: true,
    step: undefined,
    min: 0,
    max: 1,
    value: { min: 0.1, max: 0.9 },
  });
  const valueEl = knob.el.children[2];
  valueEl.dispatch('click');
  let input = knob.el.children[3];
  assert.equal(input.value, '0.1-0.9', 'range mode pre-fills "min-max"');
  input.value = '0.2-0.7';
  input.dispatch('keydown', { key: 'Enter' });
  assert.equal(knob.el.getAttribute('aria-valuetext'), 'min 0.2, max 0.7, drifting');
  assert.deepEqual(inputs[inputs.length - 1], { min: 0.2, max: 0.7 });

  valueEl.dispatch('click');
  input = knob.el.children[3];
  input.value = '0.9 to 0.3'; // reversed order — must sort into min/max
  input.dispatch('keydown', { key: 'Enter' });
  assert.equal(knob.el.getAttribute('aria-valuetext'), 'min 0.3, max 0.9, drifting');
  assert.deepEqual(inputs[inputs.length - 1], { min: 0.3, max: 0.9 });
  knob.destroy();
});

test('knob v14: a lone number in range mode sets the ACTIVE thumb only', () => {
  const { knob, inputs } = makeTestKnob({
    allowRange: true,
    step: undefined,
    min: 0,
    max: 10,
    value: { min: 2, max: 8 },
  });
  const valueEl = knob.el.children[2];
  // Default active thumb is min.
  valueEl.dispatch('click');
  let input = knob.el.children[3];
  input.value = '3';
  input.dispatch('keydown', { key: 'Enter' });
  assert.deepEqual(inputs[inputs.length - 1], { min: 3, max: 8 }, 'a lone number must move min only, by default');

  // Shift-arrow moves max, making max the active thumb (the exact nudge
  // amount doesn't matter here — the typed edit below overwrites it).
  knob.el.dispatch('keydown', { key: 'ArrowUp', shiftKey: true });
  valueEl.dispatch('click');
  input = knob.el.children[3];
  input.value = '6';
  input.dispatch('keydown', { key: 'Enter' });
  assert.deepEqual(inputs[inputs.length - 1], { min: 3, max: 6 }, 'active thumb switched to max must be the one moved');
  knob.destroy();
});

test('knob v16: a typed lone number past the other thumb pushes it along, never swaps', () => {
  const { knob, inputs } = makeTestKnob({
    allowRange: true,
    step: undefined,
    min: 0,
    max: 10,
    value: { min: 2, max: 8 },
  });
  const el = knob.el;
  const valueEl = el.children[2];
  // Active thumb is min by default: typing a value ABOVE the current max
  // must push max along, not swap min/max or clamp at the old max.
  valueEl.dispatch('click');
  let input = el.children[3];
  input.value = '9';
  input.dispatch('keydown', { key: 'Enter' });
  assert.deepEqual(inputs[inputs.length - 1], { min: 9, max: 9 }, 'typed min > max must push max, not swap');
  assert.equal(el.getAttribute('aria-valuetext'), '9 (range collapsed)');

  // Switch active thumb to max, then type a value BELOW the current min.
  el.dispatch('keydown', { key: 'ArrowDown', shiftKey: true }); // max active, still collapsed
  valueEl.dispatch('click');
  input = el.children[3];
  input.value = '5';
  input.dispatch('keydown', { key: 'Enter' });
  assert.deepEqual(inputs[inputs.length - 1], { min: 5, max: 5 }, 'typed max < min must push min, not swap');
  knob.destroy();
});

test('knob v14: unparsable typed text is discarded silently, value unchanged', () => {
  const { knob, inputs } = makeTestKnob({ value: 5, min: 0, max: 10, step: 1 });
  const valueEl = knob.el.children[2];
  valueEl.dispatch('click');
  const input = knob.el.children[3];
  input.value = 'banana';
  input.dispatch('keydown', { key: 'Enter' });
  assert.equal(knob.el.getAttribute('aria-valuenow'), '5');
  assert.deepEqual(inputs, []);
  knob.destroy();
});

test('knob v14: the readout is keyboard-reachable — Enter/Space open the editor with no pointer', () => {
  const { knob } = makeTestKnob({ value: 5, min: 0, max: 10, step: 1 });
  const valueEl = knob.el.children[2];
  valueEl.dispatch('keydown', { key: 'Enter' });
  assert.equal(knob.el.children.length, 4, 'Enter on the readout must open the editor');
  assert.equal(knob.el.children[3].value, '5');
  knob.el.children[3].dispatch('keydown', { key: 'Escape' });
  assert.equal(knob.el.children.length, 3);

  valueEl.dispatch('keydown', { key: ' ' });
  assert.equal(knob.el.children.length, 4, 'Space on the readout must also open the editor');
  knob.destroy();
});

test('knob v14: a readout click never collides with the face click-to-toggle-mode gesture', () => {
  const { knob, inputs } = makeTestKnob({ allowRange: true, value: 5 });
  const valueEl = knob.el.children[2];
  valueEl.dispatch('click');
  assert.equal(knob.el.getAttribute('aria-valuetext'), '5', 'a readout click must open the editor, never toggle range mode');
  assert.deepEqual(inputs, []);
  knob.destroy();

  // In a real DOM, pointerdown/pointerup on the readout button bubble up to
  // the root — where the face's click-to-toggle-mode logic lives. Simulate
  // that bubbling explicitly (the mock never bubbles on its own) by putting
  // the readout as `target` on a root-dispatched click-shaped pointer pair,
  // and assert onPointerDown's e.target guard suppresses the toggle.
  const { knob: knob2, inputs: inputs2 } = makeTestKnob({ allowRange: true, value: 5 });
  const valueEl2 = knob2.el.children[2];
  knob2.el.dispatch('pointerdown', { button: 0, pointerId: 1, clientX: 10, clientY: 10, target: valueEl2 });
  knob2.el.dispatch('pointerup', { pointerId: 1, clientX: 10, clientY: 10, target: valueEl2 });
  assert.equal(knob2.el.getAttribute('aria-valuetext'), '5', 'a bubbled readout pointerdown must not drive the face drag/toggle logic');
  assert.deepEqual(inputs2, []);
  knob2.destroy();
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
  const stepFrame = (ts = 0) => {
    const frames = [...rafCbs.values()];
    rafCbs.clear();
    for (const cb of frames) cb(ts);
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

test('scope: live scope caps at 30fps — a tick 10ms later is skipped, a tick past the budget draws', () => {
  withMockRaf(({ stepFrame }) => {
    const calls = {};
    const canvas = makeCanvas(calls);
    const live = scope.attachLiveScope(canvas, makeAnalyser());

    stepFrame(0); // first scheduled tick always draws
    assert.ok(calls.stroke > 0, 'expected a drawn frame');
    const afterFirst = calls.stroke;
    stepFrame(10); // 10ms later — inside the ~33.3ms/30fps budget
    assert.equal(calls.stroke, afterFirst, 'must skip a frame inside the 30fps budget');
    stepFrame(40); // past the budget — draws again
    assert.ok(calls.stroke > afterFirst, 'must draw once the budget has elapsed');

    live.destroy();
  });
});

test('scope: live scope never sets shadowBlur/shadowColor during a normal frame', () => {
  withMockRaf(({ stepFrame }) => {
    const calls = {};
    const propWrites = new Set();
    const canvas = makeCanvas(calls, { propWrites });
    const live = scope.attachLiveScope(canvas, makeAnalyser());
    stepFrame(0);
    live.destroy();
    assert.ok(!propWrites.has('shadowBlur'), 'live scope must never set ctx.shadowBlur');
    assert.ok(!propWrites.has('shadowColor'), 'live scope must never set ctx.shadowColor');
  });
});

test('scope: caps devicePixelRatio backing-store sizing at 3 even when the browser reports higher', () => {
  const calls = {};
  const canvas = makeCanvas(calls);
  const prevWindow = globalThis.window;
  globalThis.window = { devicePixelRatio: 4 };
  try {
    scope.attachLiveScope(canvas, makeAnalyser()).destroy();
    assert.equal(canvas.width, 1800, 'backing store must clamp to dpr 3, not 4');
    assert.equal(canvas.height, 900);
  } finally {
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
  }
});

test('scope: passes devicePixelRatio through unclamped at 2.5 (browser zoom on retina)', () => {
  const calls = {};
  const canvas = makeCanvas(calls);
  const prevWindow = globalThis.window;
  globalThis.window = { devicePixelRatio: 2.5 };
  try {
    scope.attachLiveScope(canvas, makeAnalyser()).destroy();
    assert.equal(canvas.width, 1500, 'expected backing store at the full 2.5 ratio, not clamped');
    assert.equal(canvas.height, 750);
  } finally {
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
  }
});

test('scope: IntersectionObserver stops the live-scope loop when fully out of view, resumes on re-entry', () => {
  withMockRaf(({ rafCbs }) => {
    let ioCallback = null;
    const prevIO = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = class {
      constructor(cb) { ioCallback = cb; }
      observe() {}
      disconnect() {}
    };
    try {
      const calls = {};
      const canvas = makeCanvas(calls);
      const live = scope.attachLiveScope(canvas, makeAnalyser());
      assert.equal(rafCbs.size, 1, 'a frame must be scheduled while in view');

      ioCallback([{ isIntersecting: false }]);
      assert.equal(rafCbs.size, 0, 'scrolling fully out of view must stop the loop');

      ioCallback([{ isIntersecting: true }]);
      assert.equal(rafCbs.size, 1, 'scrolling back into view must resume the loop');

      live.destroy();
    } finally {
      if (prevIO === undefined) delete globalThis.IntersectionObserver;
      else globalThis.IntersectionObserver = prevIO;
    }
  });
});

// --------------------------------------------------------------------------
// Scope tests — live scope auto-gain (v9 flatline fix)
// --------------------------------------------------------------------------

// A configurable float analyser: `sample(i, len)` generates each buffer
// value; `fftSize` starts small like a real analyser default so the
// LIVE_FFT_SIZE bump-up on attach is exercised too.
function makeCustomAnalyser({ fftSize = 128, sample }) {
  return {
    fftSize,
    getFloatTimeDomainData(buf) {
      for (let i = 0; i < buf.length; i++) buf[i] = sample(i, buf.length);
    },
  };
}

const parseGain = (label) => Number(/×([\d.]+)/.exec(label)?.[1]);

test('scope: live scope auto-gain amplifies a real ~0.03-peak track signal to a visible trace', () => {
  withMockRaf(({ stepFrame }) => {
    const calls = {};
    const canvas = makeCanvas(calls);
    const analyser = makeCustomAnalyser({ sample: (i) => Math.sin(i / 4) * 0.03 });
    const live = scope.attachLiveScope(canvas, analyser);

    calls.tracePoints = [];
    stepFrame(0);
    const span = Math.max(...calls.tracePoints) - Math.min(...calls.tracePoints);
    assert.ok(
      span >= 0.4 * canvas.height,
      `expected the amplified trace to span >=40% of the ${canvas.height}px trace height, got ${span}`
    );
    assert.ok(!calls.fillTexts[0].includes('silent'), 'a real signal must not read as silent');

    live.destroy();
  });
});

test('scope: live scope stays flat under the silence floor — never amplifies noise into a fake signal', () => {
  withMockRaf(({ stepFrame }) => {
    const calls = {};
    const canvas = makeCanvas(calls);
    // Peak ~0.0005, well under the 0.002 SILENCE_FLOOR.
    const analyser = makeCustomAnalyser({ sample: (i) => Math.sin(i * 1.7) * 0.0005 });
    const live = scope.attachLiveScope(canvas, analyser);

    calls.tracePoints = [];
    stepFrame(0);
    const mid = canvas.height / 2;
    assert.ok(
      calls.tracePoints.every((y) => y === mid),
      'sub-floor noise must draw a flat line at the centre, never an amplified squiggle'
    );
    assert.equal(calls.fillTexts[0], 'silent');
    assert.ok(calls.stroke >= 1, 'the flat line itself must still be drawn (dim state), not skipped');

    live.destroy();
  });
});

test('scope: live scope auto-gain approaches a step change smoothly across frames, not in one jump', () => {
  withMockRaf(({ stepFrame }) => {
    const calls = {};
    const canvas = makeCanvas(calls);
    let amplitude = 0.1;
    const analyser = makeCustomAnalyser({ sample: (i) => Math.sin(i / 4) * amplitude });
    const live = scope.attachLiveScope(canvas, analyser);

    stepFrame(0); // establishes the initial running peak (first frame always snaps)
    const gain1 = parseGain(calls.fillTexts[0]);

    amplitude = 0.01; // signal gets quieter → target gain (1/peak) rises toward 100, capped at 40
    stepFrame(200); // dt = 200ms
    const gain2 = parseGain(calls.fillTexts[1]);
    stepFrame(400); // dt = 200ms
    const gain3 = parseGain(calls.fillTexts[2]);

    assert.ok(gain2 > gain1, `expected gain to rise after the step (${gain1} -> ${gain2})`);
    assert.ok(gain3 > gain2, `expected gain to keep rising smoothly (${gain2} -> ${gain3})`);
    assert.ok(gain3 < 40, 'must not have already reached the cap in two 200ms steps');

    live.destroy();
  });
});

test('scope: live scope falls back to an untriggered scrolling window when no edge is found', () => {
  withMockRaf(({ stepFrame }) => {
    const calls = {};
    const canvas = makeCanvas(calls);
    // Always positive (no −→+ zero crossing anywhere): a slow near-DC pad
    // that varies gently with index so different scroll offsets read
    // visibly different samples.
    const analyser = makeCustomAnalyser({
      sample: (i, len) => 0.05 + 0.03 * Math.sin(i / (len * 4)),
    });
    const live = scope.attachLiveScope(canvas, analyser);

    calls.tracePoints = [];
    stepFrame(0);
    const frame1 = [...calls.tracePoints];
    assert.ok(frame1.length > 0, 'expected a drawn trace even with no trigger edge');

    calls.tracePoints = [];
    stepFrame(33);
    const frame2 = [...calls.tracePoints];

    assert.notDeepEqual(frame1, frame2, 'an untriggered pad must still visibly scroll frame to frame');

    live.destroy();
  });
});

test('scope: live scope draws a tiny gain readout — dB while playing, "silent" at the floor', () => {
  withMockRaf(({ stepFrame }) => {
    const calls = {};
    const canvas = makeCanvas(calls);
    const analyser = makeCustomAnalyser({ sample: (i) => Math.sin(i / 4) * 0.05 });
    const live = scope.attachLiveScope(canvas, analyser);
    stepFrame(0);
    assert.match(calls.fillTexts[0], /^×[\d.]+ \(-?[\d.]+ dB\)$/);
    live.destroy();
  });
});

// --------------------------------------------------------------------------
// Scope tests — attachMultiScope
// --------------------------------------------------------------------------

const MULTI_TRACKS = ['pad', 'arp', 'melody', 'bass', 'texture', 'percussion'];
const FALLBACK_GRID_COLOR = 'rgba(245, 182, 66, 0.16)'; // matches scope.js's private FALLBACK_GRID

function makeMockEngine({ running = true, analysers = {} } = {}) {
  const listeners = new Map();
  return {
    running,
    getAnalysers() { return analysers; },
    on(type, cb) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(cb);
      return () => listeners.get(type)?.delete(cb);
    },
    emit(type, payload) {
      for (const cb of [...(listeners.get(type) || [])]) cb(payload);
    },
    listenerCount(type) { return listeners.get(type)?.size || 0; },
  };
}

function traceColorsDrawn(calls) {
  return Object.keys(calls.pointsByColor || {}).filter((c) => c !== FALLBACK_GRID_COLOR);
}

test('multiScope: draws one trace per selected track, each in its own colour (fallback hues)', () => {
  withMockRaf(({ stepFrame }) => {
    const calls = {};
    const canvas = makeCanvas(calls);
    const analysers = Object.fromEntries(MULTI_TRACKS.map((t) => [t, makeCustomAnalyser({ sample: (i) => Math.sin(i / 4) * 0.05 })]));
    const engine = makeMockEngine({ analysers });
    const live = scope.attachMultiScope(canvas, engine);
    assert.equal(typeof live.destroy, 'function');
    assert.equal(typeof live.setTracks, 'function');

    stepFrame(0);
    const colors = traceColorsDrawn(calls);
    assert.equal(colors.length, 6, `expected 6 distinct trace colours, got ${colors.length}: ${colors}`);
    assert.equal(new Set(colors).size, 6, 'fallback hues must be distinct per track');
    assert.deepEqual(calls.fillTexts, MULTI_TRACKS, 'legend must label every selected track, in order');

    live.destroy();
  });
});

test('multiScope: a silent track draws no trace, but stays in the legend', () => {
  withMockRaf(({ stepFrame }) => {
    const calls = {};
    const canvas = makeCanvas(calls);
    const analysers = {
      pad: makeCustomAnalyser({ sample: (i) => Math.sin(i / 4) * 0.05 }), // loud
      arp: makeCustomAnalyser({ sample: (i) => Math.sin(i * 1.7) * 0.0005 }), // sub-floor
    };
    const engine = makeMockEngine({ analysers });
    const live = scope.attachMultiScope(canvas, engine, { tracks: ['pad', 'arp'] });

    stepFrame(0);
    const colors = traceColorsDrawn(calls);
    assert.equal(colors.length, 1, 'only the loud track draws a trace');
    assert.deepEqual(calls.fillTexts, ['pad', 'arp'], 'the silent track still gets a legend label');

    live.destroy();
  });
});

test('multiScope: setTracks() narrows the drawn + legend set', () => {
  withMockRaf(({ stepFrame }) => {
    const calls = {};
    const canvas = makeCanvas(calls);
    const analysers = Object.fromEntries(MULTI_TRACKS.map((t) => [t, makeCustomAnalyser({ sample: (i) => Math.sin(i / 4) * 0.05 })]));
    const engine = makeMockEngine({ analysers });
    const live = scope.attachMultiScope(canvas, engine);

    stepFrame(0);
    assert.equal(traceColorsDrawn(calls).length, 6);

    live.setTracks(['bass', 'melody']);
    calls.pointsByColor = {};
    calls.fillTexts = [];
    stepFrame(40); // past the 30fps budget, so this tick actually draws
    assert.equal(traceColorsDrawn(calls).length, 2, 'narrowed selection must draw only 2 traces');
    assert.deepEqual(calls.fillTexts, ['bass', 'melody']);

    // Unknown ids are dropped silently, known order preserved.
    live.setTracks(['percussion', 'not-a-track', 'pad']);
    calls.pointsByColor = {};
    calls.fillTexts = [];
    stepFrame(80);
    assert.equal(traceColorsDrawn(calls).length, 2);
    assert.deepEqual(calls.fillTexts, ['percussion', 'pad']);

    live.destroy();
  });
});

test('multiScope: per-trace auto-gain is independent — a quiet track still reads as a visible trace', () => {
  withMockRaf(({ stepFrame }) => {
    const calls = {};
    const canvas = makeCanvas(calls);
    const analysers = {
      pad: makeCustomAnalyser({ sample: (i) => Math.sin(i / 4) * 0.3 }), // loud
      arp: makeCustomAnalyser({ sample: (i) => Math.sin(i / 4) * 0.03 }), // quiet, above floor
    };
    const engine = makeMockEngine({ analysers });
    const live = scope.attachMultiScope(canvas, engine, { tracks: ['pad', 'arp'] });

    stepFrame(0);
    const byColor = calls.pointsByColor;
    const spans = Object.entries(byColor)
      .filter(([color]) => color !== FALLBACK_GRID_COLOR)
      .map(([, ys]) => Math.max(...ys) - Math.min(...ys));
    assert.equal(spans.length, 2);
    for (const span of spans) {
      assert.ok(
        span >= 0.3 * canvas.height,
        `expected both the loud and the quiet-but-audible track to read as a visible trace, got span ${span}`
      );
    }

    live.destroy();
  });
});

test('multiScope: draws the shared graticule exactly once per frame regardless of track count', () => {
  withMockRaf(({ stepFrame }) => {
    const calls = {};
    const canvas = makeCanvas(calls);
    const analysers = Object.fromEntries(MULTI_TRACKS.map((t) => [t, makeCustomAnalyser({ sample: (i) => Math.sin(i / 4) * 0.05 })]));
    const engine = makeMockEngine({ analysers });
    const live = scope.attachMultiScope(canvas, engine);
    stepFrame(0);
    const backgroundFills = calls.fillRects.filter((r) => r.w === canvas.width && r.h === canvas.height);
    assert.equal(backgroundFills.length, 1, 'exactly one background fill (the shared graticule), not one per track');
    live.destroy();
  });
});

test('multiScope: analysers are re-fetched on the engine "state" event, not polled every frame', () => {
  withMockRaf(({ stepFrame }) => {
    const calls = {};
    const canvas = makeCanvas(calls);
    const engine = makeMockEngine({ running: false, analysers: {} });
    const live = scope.attachMultiScope(canvas, engine);

    stepFrame(0);
    assert.equal(traceColorsDrawn(calls).length, 0, 'not running yet: no analysers, no traces');

    // Engine starts; analysers become available; only a 'state' event (or
    // tab-visible-again) makes attachMultiScope pick them up.
    engine.running = true;
    engine.getAnalysers = () => ({ pad: makeCustomAnalyser({ sample: (i) => Math.sin(i / 4) * 0.05 }) });
    calls.pointsByColor = {};
    stepFrame(33);
    assert.equal(traceColorsDrawn(calls).length, 0, 'must not pick up the new analyser without a state event');

    engine.emit('state', { running: true });
    calls.pointsByColor = {};
    stepFrame(66);
    assert.equal(traceColorsDrawn(calls).length, 1, 'the state event must trigger the re-fetch');

    live.destroy();
    assert.equal(engine.listenerCount('state'), 0, 'destroy must unsubscribe from the engine');
  });
});

test('multiScope: identity change (context rebuild) is picked up on tab-visible-again', () => {
  withMockRaf(({ stepFrame }) => {
    const calls = {};
    const canvas = makeCanvas(calls);
    const analyserA = makeCustomAnalyser({ sample: (i) => Math.sin(i / 4) * 0.05 });
    const engine = makeMockEngine({ analysers: { pad: analyserA } });
    const live = scope.attachMultiScope(canvas, engine, { tracks: ['pad'] });
    stepFrame(0);
    assert.equal(traceColorsDrawn(calls).length, 1);

    // A context rebuild swaps analyser identity without a 'state' event.
    const analyserB = makeCustomAnalyser({ sample: () => 0 }); // silent replacement
    engine.getAnalysers = () => ({ pad: analyserB });
    mockDocument.hidden = true;
    for (const cb of [...(docListeners.get('visibilitychange') || [])]) cb();
    mockDocument.hidden = false;
    for (const cb of [...(docListeners.get('visibilitychange') || [])]) cb();
    calls.pointsByColor = {};
    stepFrame(33);
    assert.equal(traceColorsDrawn(calls).length, 0, 'must have switched to the new (silent) analyser');

    live.destroy();
  });
});

test('multiScope: pauses when hidden and via IntersectionObserver, like the single live scope', () => {
  withMockRaf(({ rafCbs }) => {
    let ioCallback = null;
    const prevIO = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = class {
      constructor(cb) { ioCallback = cb; }
      observe() {}
      disconnect() {}
    };
    try {
      const calls = {};
      const canvas = makeCanvas(calls);
      const engine = makeMockEngine({ analysers: { pad: makeCustomAnalyser({ sample: (i) => Math.sin(i / 4) * 0.05 }) } });
      const live = scope.attachMultiScope(canvas, engine);
      assert.equal(rafCbs.size, 1, 'a frame must be scheduled');

      ioCallback([{ isIntersecting: false }]);
      assert.equal(rafCbs.size, 0, 'scrolling out of view must stop the loop');
      ioCallback([{ isIntersecting: true }]);
      assert.equal(rafCbs.size, 1, 'scrolling back into view must resume the loop');

      mockDocument.hidden = true;
      for (const cb of [...(docListeners.get('visibilitychange') || [])]) cb();
      assert.equal(rafCbs.size, 0, 'hidden document must pause the loop');
      mockDocument.hidden = false;
      for (const cb of [...(docListeners.get('visibilitychange') || [])]) cb();
      assert.equal(rafCbs.size, 1, 'visible again must resume the loop');

      live.destroy();
      assert.equal(rafCbs.size, 0, 'destroy must cancel the pending frame');
    } finally {
      if (prevIO === undefined) delete globalThis.IntersectionObserver;
      else globalThis.IntersectionObserver = prevIO;
    }
  });
});

test('multiScope: caps at 30fps like the single live scope', () => {
  withMockRaf(({ stepFrame }) => {
    const calls = {};
    const canvas = makeCanvas(calls);
    const engine = makeMockEngine({ analysers: { pad: makeCustomAnalyser({ sample: (i) => Math.sin(i / 4) * 0.05 }) } });
    const live = scope.attachMultiScope(canvas, engine);

    stepFrame(0);
    const afterFirst = calls.stroke;
    stepFrame(10); // inside the ~33.3ms/30fps budget
    assert.equal(calls.stroke, afterFirst, 'must skip a frame inside the 30fps budget');
    stepFrame(40); // past the budget
    assert.ok(calls.stroke > afterFirst, 'must draw once the budget has elapsed');

    live.destroy();
  });
});

test('multiScope: reuses one sample buffer per track across frames (no per-frame allocation)', () => {
  withMockRaf(({ stepFrame }) => {
    const calls = {};
    const canvas = makeCanvas(calls);
    let padBufs = new Set();
    let arpBufs = new Set();
    const padAnalyser = {
      fftSize: 8192,
      getFloatTimeDomainData(buf) {
        padBufs.add(buf);
        for (let i = 0; i < buf.length; i++) buf[i] = Math.sin(i / 4) * 0.05;
      },
    };
    const arpAnalyser = {
      fftSize: 8192,
      getFloatTimeDomainData(buf) {
        arpBufs.add(buf);
        for (let i = 0; i < buf.length; i++) buf[i] = Math.sin(i / 3) * 0.05;
      },
    };
    const engine = makeMockEngine({ analysers: { pad: padAnalyser, arp: arpAnalyser } });
    const live = scope.attachMultiScope(canvas, engine, { tracks: ['pad', 'arp'] });
    stepFrame(0);
    stepFrame(33);
    stepFrame(66);
    assert.equal(padBufs.size, 1, 'pad must reuse the same buffer instance every frame');
    assert.equal(arpBufs.size, 1, 'arp must reuse the same buffer instance every frame');
    assert.notEqual([...padBufs][0], [...arpBufs][0], 'each track must own its own buffer');
    live.destroy();
  });
});

test('multiScope: never sets shadowBlur/shadowColor during a normal frame', () => {
  withMockRaf(({ stepFrame }) => {
    const calls = {};
    const propWrites = new Set();
    const canvas = makeCanvas(calls, { propWrites });
    const engine = makeMockEngine({ analysers: { pad: makeCustomAnalyser({ sample: (i) => Math.sin(i / 4) * 0.05 }) } });
    const live = scope.attachMultiScope(canvas, engine);
    stepFrame(0);
    live.destroy();
    assert.ok(!propWrites.has('shadowBlur'), 'multi-scope must never set ctx.shadowBlur');
    assert.ok(!propWrites.has('shadowColor'), 'multi-scope must never set ctx.shadowColor');
  });
});

test('multiScope: caps devicePixelRatio backing-store sizing at 3 like the single live scope', () => {
  const calls = {};
  const canvas = makeCanvas(calls);
  const engine = makeMockEngine({ analysers: {} });
  const prevWindow = globalThis.window;
  globalThis.window = { devicePixelRatio: 4 };
  try {
    scope.attachMultiScope(canvas, engine).destroy();
    assert.equal(canvas.width, 1800, 'backing store must clamp to dpr 3, not 4');
    assert.equal(canvas.height, 900);
  } finally {
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
  }
});

test('multiScope: degenerate inputs return inert handles, never throw', () => {
  const calls = {};
  const canvas = makeCanvas(calls);
  const engine = makeMockEngine();
  scope.attachMultiScope(null, engine).destroy();
  scope.attachMultiScope(canvas, null).destroy();
  const inert = scope.attachMultiScope({}, engine);
  inert.setTracks(['pad']);
  inert.destroy();
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
