/**
 * Smoke test for src/scripts/visualiser.js — run with:
 *   node tests/visualiser-smoke.mjs
 *
 * Drives initVisualiser() against a mock 2d canvas context and a fake
 * engine that emits note/bar/section/state events, proving the render
 * path, event wiring and destroy() never throw — including in a bare
 * environment with no window/document/ResizeObserver at all.
 */

import assert from 'node:assert/strict';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// --------------------------------------------------------------------------
// Minimal 2d context + canvas mock
// --------------------------------------------------------------------------

// `propWrites`, if passed, collects every property NAME assigned on the 2d
// context (not just method calls) so tests can assert e.g. 'shadowBlur' is
// never touched during a normal frame.
function makeCtx2d(calls, propWrites) {
  const record = (name) => { calls[name] = (calls[name] || 0) + 1; };
  const base = {
    clearRect() { record('clearRect'); },
    fillRect() { record('fillRect'); },
    beginPath() {},
    moveTo() {},
    lineTo() {},
    arcTo() {},
    closePath() {},
    stroke() { record('stroke'); },
    fill() { record('fill'); },
    arc() {},
    fillText(text) { record('fillText'); calls.lastText = text; },
    setTransform() {},
    createLinearGradient() { return { addColorStop() {} }; },
  };
  if (!propWrites) return { ...base, fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: '', textBaseline: '' };
  return new Proxy(base, {
    set(target, prop, value) {
      propWrites.add(prop);
      target[prop] = value;
      return true;
    },
  });
}

function makeCanvas(calls, opts = {}) {
  const listeners = new Map();
  return {
    width: 600,
    height: 300,
    clientWidth: 600,
    clientHeight: 300,
    getContext(kind) {
      if (kind !== '2d') return null;
      return makeCtx2d(calls, opts.propWrites);
    },
    getBoundingClientRect() {
      return { width: 600, height: 300 };
    },
    addEventListener(type, fn) {
      listeners.set(type, fn);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
  };
}

function makeAnalyser(level) {
  return {
    fftSize: 32,
    getByteTimeDomainData(buf) {
      for (let i = 0; i < buf.length; i++) {
        buf[i] = 128 + Math.round(Math.sin(i) * 127 * level);
      }
    },
  };
}

function makeEngine() {
  const handlers = new Map();
  let time = 0;
  return {
    running: false,
    on(type, cb) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(cb);
      return () => handlers.get(type).delete(cb);
    },
    emit(type, evt) {
      for (const cb of handlers.get(type) || []) cb(evt);
    },
    now() { return time; },
    advance(dt) { time += dt; },
    getAnalysers() {
      return {
        pad: makeAnalyser(0.2),
        bass: makeAnalyser(0.1),
        melody: null,
        texture: null,
        arp: null,
        percussion: null,
      };
    },
  };
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

let initVisualiser;

test('module imports cleanly and exposes initVisualiser', async () => {
  const mod = await import('../src/scripts/visualiser.js');
  initVisualiser = mod.initVisualiser;
  assert.equal(typeof initVisualiser, 'function');
  assert.equal(typeof mod.default, 'function');
});

test('degrades gracefully with no canvas / no 2d context', () => {
  assert.equal(typeof initVisualiser({}, makeEngine()).destroy, 'function');
  const badCanvas = { getContext: () => null };
  assert.equal(typeof initVisualiser(badCanvas, makeEngine()).destroy, 'function');
});

test('init, event flow and destroy never throw', () => {
  const calls = {};
  const canvas = makeCanvas(calls);
  const engine = makeEngine();

  const inst = initVisualiser(canvas, engine);
  assert.equal(typeof inst.destroy, 'function');

  // A static frame should have been drawn at init (idle, not running).
  assert.ok(calls.clearRect >= 1, 'expected an initial static render');

  // Bring the engine up and feed it events across all six tracks.
  engine.running = true;
  engine.emit('state', { running: true });

  engine.emit('section', { label: 'A', intensity: 0.4, bar: 0, time: 0 });
  engine.emit('bar', { bar: 0, beatsPerBar: 4, time: 0 });

  const tracks = ['pad', 'bass', 'melody', 'texture', 'arp', 'percussion'];
  for (const track of tracks) {
    engine.emit('note', {
      track,
      midi: track === 'percussion' ? null : 60,
      kind: track === 'percussion' ? 'mid' : null,
      velocity: 0.7,
      time: engine.now(),
      duration: 0.5,
    });
  }

  // Malformed / unknown events must be dropped, not thrown.
  engine.emit('note', { track: 'not-a-track', velocity: 1, time: 0, duration: 1 });
  engine.emit('note', null);
  engine.emit('section', null);
  engine.emit('bar', undefined);

  engine.advance(1.5);
  engine.emit('bar', { bar: 1, beatsPerBar: 4, time: 1.5 });

  engine.running = false;
  engine.emit('state', { running: false });

  inst.destroy();
  inst.destroy(); // repeat destroy must be a no-op, not a throw
});

test('runs with no window/document/ResizeObserver at all (bare Node)', () => {
  const calls = {};
  const canvas = makeCanvas(calls);
  const engine = makeEngine();
  engine.running = true;

  const inst = initVisualiser(canvas, engine);
  engine.emit('state', { running: true });
  engine.emit('note', { track: 'pad', midi: 64, velocity: 0.9, time: 0, duration: 1 });
  inst.destroy();

  assert.ok(calls.clearRect >= 1, 'expected at least one render pass');
});

test('re-resizes when devicePixelRatio changes between frames', () => {
  const calls = {};
  const canvas = makeCanvas(calls);
  const engine = makeEngine();
  const prevWindow = globalThis.window;
  globalThis.window = { devicePixelRatio: 1 };
  try {
    const inst = initVisualiser(canvas, engine);
    assert.equal(canvas.width, 600, 'expected 1:1 backing store at dpr 1');

    // Zoom / different-DPI screen: dpr changes without a CSS-box resize.
    globalThis.window.devicePixelRatio = 2;
    engine.emit('state', { running: false }); // forces a static renderFrame()
    assert.equal(canvas.width, 1200, 'expected backing store rescaled on dpr change');
    assert.equal(canvas.height, 600);

    inst.destroy();
  } finally {
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
  }
});

// --------------------------------------------------------------------------
// rAF mock with explicit timestamps (for frame-rate-cap / IO gating tests)
// --------------------------------------------------------------------------

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

test('30fps frame-rate cap: a tick 10ms later is skipped, a tick past the budget draws', () => {
  withMockRaf(({ stepFrame }) => {
    const calls = {};
    const canvas = makeCanvas(calls);
    const engine = makeEngine();
    engine.running = true;
    const inst = initVisualiser(canvas, engine);
    engine.emit('state', { running: true });

    calls.clearRect = 0;
    stepFrame(0); // first scheduled tick always draws
    assert.equal(calls.clearRect, 1);
    stepFrame(10); // 10ms later — inside the ~33.3ms/30fps budget
    assert.equal(calls.clearRect, 1, 'must skip a frame inside the 30fps budget');
    stepFrame(40); // past the budget — draws again
    assert.equal(calls.clearRect, 2);

    inst.destroy();
  });
});

test('never sets shadowBlur/shadowColor during a normal frame', () => {
  const calls = {};
  const propWrites = new Set();
  const canvas = makeCanvas(calls, { propWrites });
  const engine = makeEngine();
  engine.running = true;
  const inst = initVisualiser(canvas, engine);
  engine.emit('state', { running: true });
  for (const track of ['pad', 'bass', 'melody', 'texture', 'arp', 'percussion']) {
    engine.emit('note', { track, midi: 60, velocity: 0.8, time: 0, duration: 0.3 });
  }
  inst.destroy();
  assert.ok(!propWrites.has('shadowBlur'), 'visualiser must never set ctx.shadowBlur');
  assert.ok(!propWrites.has('shadowColor'), 'visualiser must never set ctx.shadowColor');
});

test('caps devicePixelRatio backing-store sizing at 2 even when the browser reports higher', () => {
  const calls = {};
  const canvas = makeCanvas(calls);
  const engine = makeEngine();
  const prevWindow = globalThis.window;
  globalThis.window = { devicePixelRatio: 4 };
  try {
    const inst = initVisualiser(canvas, engine);
    assert.equal(canvas.width, 1200, 'backing store must clamp to dpr 2, not 4');
    assert.equal(canvas.height, 600);
    inst.destroy();
  } finally {
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
  }
});

test('IntersectionObserver: stops the rAF loop when fully out of view, resumes on re-entry', () => {
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
      const engine = makeEngine();
      engine.running = true;
      const inst = initVisualiser(canvas, engine);
      engine.emit('state', { running: true });
      assert.equal(rafCbs.size, 1, 'a frame must be scheduled while in view');

      ioCallback([{ isIntersecting: false }]);
      assert.equal(rafCbs.size, 0, 'scrolling fully out of view must stop the loop');

      ioCallback([{ isIntersecting: true }]);
      assert.equal(rafCbs.size, 1, 'scrolling back into view must resume the loop');

      inst.destroy();
    } finally {
      if (prevIO === undefined) delete globalThis.IntersectionObserver;
      else globalThis.IntersectionObserver = prevIO;
    }
  });
});

test('observes device-pixel-content-box, falling back to plain observe', () => {
  const observeCalls = [];
  const prevRO = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    observe(_target, opts) {
      observeCalls.push(opts);
      if (opts) throw new TypeError('box option not supported');
    }
    disconnect() {}
  };
  try {
    const inst = initVisualiser(makeCanvas({}), makeEngine());
    inst.destroy();
  } finally {
    if (prevRO === undefined) delete globalThis.ResizeObserver;
    else globalThis.ResizeObserver = prevRO;
  }
  assert.deepEqual(observeCalls, [{ box: 'device-pixel-content-box' }, undefined]);
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
