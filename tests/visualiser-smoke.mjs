/**
 * Smoke test for src/scripts/visualiser.js — run with:
 *   node tests/visualiser-smoke.mjs
 *
 * Drives initVisualiser() against a mock 2d canvas context and a fake
 * engine that emits note/bar/section/state/chord events, proving the render
 * path, event wiring, lamp overlay lifecycle, and destroy() never throw —
 * including in a bare environment with no window/document/ResizeObserver at
 * all.
 */

import assert from 'node:assert/strict';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// --------------------------------------------------------------------------
// Minimal 2d context + canvas mock
// --------------------------------------------------------------------------

// `propWrites`, if passed, collects every property NAME assigned on the 2d
// context (not just method calls) so tests can assert e.g. 'shadowBlur' is
// never touched during a normal frame. If `calls.texts` / `calls.fillStyles`
// are pre-seeded to arrays, every fillText()/fillStyle assignment is also
// recorded into them (opt-in, so unrelated tests pay no extra cost). If
// `calls.roundRects` is pre-seeded to an array, every filled rounded-rect
// path (the note blips drawn via roundRectPath — recognised as a path with
// exactly 4 arcTo() calls before its fill()) has its moveTo() point (the
// blip's top-left corner) pushed to it, in draw order — used to inspect the
// y position (and therefore de-overlap slot) the visualiser assigned notes.
// If `calls.rects` / `calls.arcs` are pre-seeded to arrays, every
// fillRect()/arc() call also has its geometry ({x,y,w,h} / {x,y,r}) pushed
// to them, in draw order — used by the repeat-mark geometry test.
function makeCtx2d(calls, propWrites) {
  const record = (name) => { calls[name] = (calls[name] || 0) + 1; };
  let fillStyleValue = '';
  let currentPath = null; // { moveTo: {x,y}|null, arcToCount } for the path since the last beginPath()
  const methods = {
    clearRect() { record('clearRect'); },
    fillRect(x, y, w, h) {
      record('fillRect');
      if (calls.rects) calls.rects.push({ x, y, w, h });
    },
    beginPath() { currentPath = { moveTo: null, arcToCount: 0 }; },
    moveTo(x, y) {
      if (currentPath && currentPath.moveTo === null) currentPath.moveTo = { x, y };
    },
    lineTo() {},
    arcTo() { if (currentPath) currentPath.arcToCount += 1; },
    closePath() {},
    stroke() { record('stroke'); },
    fill() {
      record('fill');
      if (calls.roundRects && currentPath && currentPath.arcToCount === 4 && currentPath.moveTo) {
        calls.roundRects.push(currentPath.moveTo);
      }
    },
    arc(x, y, r) {
      if (calls.arcs) calls.arcs.push({ x, y, r });
    },
    fillText(text) {
      record('fillText');
      calls.lastText = text;
      if (calls.texts) calls.texts.push(text);
    },
    setTransform() {},
    createLinearGradient() { return { addColorStop() {} }; },
  };
  const target = Object.assign({}, methods, { strokeStyle: '', lineWidth: 1, font: '', textAlign: '', textBaseline: '' });
  Object.defineProperty(target, 'fillStyle', {
    enumerable: true,
    get() { return fillStyleValue; },
    set(v) {
      fillStyleValue = v;
      if (calls.fillStyles) calls.fillStyles.push(v);
    },
  });
  if (!propWrites) return target;
  return new Proxy(target, {
    set(obj, prop, value) {
      propWrites.add(prop);
      obj[prop] = value;
      return true;
    },
  });
}

// --------------------------------------------------------------------------
// Minimal in-memory DOM node mock (for lamp-overlay tests only)
// --------------------------------------------------------------------------

function makeFakeElement(tag) {
  const listeners = new Map();
  const node = {
    tagName: tag,
    style: {},
    dataset: {},
    children: [],
    parentNode: null,
    attrs: {},
    setAttribute(name, value) { node.attrs[name] = String(value); },
    getAttribute(name) { return node.attrs[name]; },
    appendChild(child) {
      child.parentNode = node;
      node.children.push(child);
      return child;
    },
    insertBefore(newChild, refChild) {
      newChild.parentNode = node;
      if (refChild == null) {
        node.children.push(newChild);
      } else {
        const idx = node.children.indexOf(refChild);
        node.children.splice(idx === -1 ? node.children.length : idx, 0, newChild);
      }
      return newChild;
    },
    removeChild(child) {
      const idx = node.children.indexOf(child);
      if (idx !== -1) node.children.splice(idx, 1);
      child.parentNode = null;
      return child;
    },
    remove() {
      if (node.parentNode) node.parentNode.removeChild(node);
    },
    get nextSibling() {
      if (!node.parentNode) return null;
      const idx = node.parentNode.children.indexOf(node);
      return node.parentNode.children[idx + 1] || null;
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatch(type, evt = {}) {
      for (const fn of listeners.get(type) || []) fn({ target: node, ...evt });
    },
    click() { node.dispatch('click'); },
  };
  return node;
}

// A canvas mock that also behaves like a DOM node (parentNode/appendChild/…)
// so it can be wrapped by the lamp overlay host.
function makeDomCanvas(calls, opts = {}) {
  const node = makeFakeElement('canvas');
  Object.assign(node, {
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
  });
  return node;
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

// Wraps makeEngine() with mock setLoopRegion/clearLoopRegion (v15 repeat
// brackets), recording every call so tests can assert on them.
function makeLoopEngine() {
  const engine = makeEngine();
  const calls = { setLoopRegion: [], clearLoopRegion: 0 };
  engine.setLoopRegion = (startBar, endBar) => { calls.setLoopRegion.push([startBar, endBar]); };
  engine.clearLoopRegion = () => { calls.clearLoopRegion += 1; };
  return { engine, calls };
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

test('caps devicePixelRatio backing-store sizing at 3 even when the browser reports higher', () => {
  const calls = {};
  const canvas = makeCanvas(calls);
  const engine = makeEngine();
  const prevWindow = globalThis.window;
  globalThis.window = { devicePixelRatio: 4 };
  try {
    const inst = initVisualiser(canvas, engine);
    assert.equal(canvas.width, 1800, 'backing store must clamp to dpr 3, not 4');
    assert.equal(canvas.height, 900);
    inst.destroy();
  } finally {
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
  }
});

test('passes devicePixelRatio through unclamped at 2.5 (browser zoom on retina)', () => {
  const calls = {};
  const canvas = makeCanvas(calls);
  const engine = makeEngine();
  const prevWindow = globalThis.window;
  globalThis.window = { devicePixelRatio: 2.5 };
  try {
    const inst = initVisualiser(canvas, engine);
    assert.equal(canvas.width, 1500, 'expected backing store at the full 2.5 ratio, not clamped');
    assert.equal(canvas.height, 750);
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
// v14: track order, lamp overlay, chord labels, colour token consumption
// --------------------------------------------------------------------------

test('lane order top-to-bottom is pad, arp, melody, bass, texture, percussion', () => {
  const calls = {};
  calls.texts = [];
  const canvas = makeCanvas(calls);
  const engine = makeEngine();
  const inst = initVisualiser(canvas, engine);
  engine.emit('state', { running: false }); // forces a synchronous static render

  const order = ['Pad', 'Arp', 'Melody', 'Bass', 'Texture', 'Percussion'];
  const positions = order.map((label) => calls.texts.indexOf(label));
  assert.ok(positions.every((p) => p !== -1), `expected all six lane labels, got: ${calls.texts.join(', ')}`);
  for (let i = 1; i < positions.length; i++) {
    assert.ok(positions[i] > positions[i - 1], 'lane labels must be drawn top-to-bottom in the new track order');
  }

  inst.destroy();
});

test('lamp overlay: wraps the canvas, creates six lamp buttons, cycles state via engine.setParams, and cleans up on destroy', () => {
  const prevDocument = globalThis.document;
  globalThis.document = { createElement: (tag) => makeFakeElement(tag) };
  try {
    const calls = {};
    const root = makeFakeElement('div');
    const canvas = makeDomCanvas(calls);
    root.appendChild(canvas);

    const engine = makeEngine();
    const setParamsCalls = [];
    let trackState = 'auto';
    engine.getParams = () => ({ tracks: { pad: { state: trackState } } });
    engine.setParams = (partial) => {
      setParamsCalls.push(partial);
      trackState = partial.tracks.pad.state;
    };

    const inst = initVisualiser(canvas, engine);

    assert.ok(canvas.parentNode, 'canvas must be wrapped in a lamp host div');
    const lampHost = canvas.parentNode;
    assert.equal(lampHost.parentNode, root, 'lamp host must be inserted where the canvas used to live');
    assert.equal(lampHost.children.length, 7, 'lamp host holds the canvas plus 6 lamp buttons');

    const padButton = lampHost.children.find((c) => c.tagName === 'button' && c.dataset.track === 'pad');
    assert.ok(padButton, 'expected a pad lamp button');
    assert.equal(padButton.getAttribute('aria-label'), 'Pad track: auto');
    assert.equal(padButton.getAttribute('aria-pressed'), 'mixed');

    padButton.click();
    assert.deepEqual(setParamsCalls, [{ tracks: { pad: { state: 'on' } } }]);
    assert.equal(padButton.getAttribute('aria-label'), 'Pad track: on');
    assert.equal(padButton.getAttribute('aria-pressed'), 'true');

    // Out-of-band state change (e.g. another UI control) is picked up via
    // getParams() on the next 'bar' event, not just via lamp clicks.
    trackState = 'off';
    engine.emit('bar', { bar: 1, beatsPerBar: 4, time: 1 });
    assert.equal(padButton.getAttribute('aria-label'), 'Pad track: off');
    assert.equal(padButton.getAttribute('aria-pressed'), 'false');

    inst.destroy();
    assert.equal(canvas.parentNode, root, 'canvas restored to its original parent on destroy');
    assert.ok(!root.children.includes(lampHost), 'lamp host removed from the DOM on destroy');

    inst.destroy(); // repeat destroy must be a no-op, not a throw
  } finally {
    if (prevDocument === undefined) delete globalThis.document;
    else globalThis.document = prevDocument;
  }
});

test('lamp overlay: never built when there is no document (bare Node / no DOM)', () => {
  const calls = {};
  const canvas = makeCanvas(calls); // plain object, no parentNode/DOM at all
  const engine = makeEngine();
  const inst = initVisualiser(canvas, engine);
  inst.destroy(); // must not throw despite there being nothing to unwrap
});

test('chord event drives bar-tick chord labels; falls back to the section label until one fires', () => {
  const calls = {};
  calls.texts = [];
  const canvas = makeCanvas(calls);
  const engine = makeEngine();
  engine.running = true;
  const inst = initVisualiser(canvas, engine);
  engine.emit('state', { running: true });
  engine.emit('section', { label: 'A', intensity: 0.4, bar: 0, time: 0 });
  engine.emit('bar', { bar: 0, beatsPerBar: 4, time: 0 });
  engine.emit('state', { running: false }); // forces a synchronous static render

  assert.ok(calls.texts.includes('A'), 'without a chord event, the section label keeps drawing as before');
  assert.ok(!calls.texts.includes('Cmaj7'), 'no chord text before any chord event has fired');

  calls.texts.length = 0;
  engine.emit('chord', { name: 'Cmaj7', bar: 0, time: 0 });
  engine.emit('state', { running: false });

  assert.ok(calls.texts.includes('Cmaj7'), 'chord name drawn at the bar tick once a chord event has fired');

  inst.destroy();
});

test('malformed chord events are dropped, not thrown', () => {
  const calls = {};
  const canvas = makeCanvas(calls);
  const engine = makeEngine();
  engine.running = true;
  const inst = initVisualiser(canvas, engine);
  engine.emit('state', { running: true });
  engine.emit('chord', null);
  engine.emit('chord', undefined);
  engine.emit('chord', { bar: 0, time: 0 }); // no name
  inst.destroy();
});

test('consumes --track-<id> CSS custom properties for lane accent colour', () => {
  const prevGetComputedStyle = globalThis.getComputedStyle;
  globalThis.getComputedStyle = () => ({
    getPropertyValue(name) {
      return name === '--track-pad' ? '#ff0000' : '';
    },
  });
  try {
    const calls = {};
    calls.fillStyles = [];
    const canvas = makeCanvas(calls);
    const engine = makeEngine();
    engine.running = true;
    const inst = initVisualiser(canvas, engine);
    engine.emit('state', { running: true });
    engine.emit('note', { track: 'pad', midi: 60, velocity: 0.8, time: 0, duration: 0.3 });
    engine.emit('state', { running: false }); // synchronous static render

    assert.ok(
      calls.fillStyles.some((v) => typeof v === 'string' && v.startsWith('rgba(255, 0, 0,')),
      'pad lane should render using the --track-pad custom property colour',
    );

    inst.destroy();
  } finally {
    if (prevGetComputedStyle === undefined) delete globalThis.getComputedStyle;
    else globalThis.getComputedStyle = prevGetComputedStyle;
  }
});

test('falls back to a derived accent colour when --track-<id> custom properties are unset', () => {
  const calls = {};
  calls.fillStyles = [];
  const canvas = makeCanvas(calls);
  const engine = makeEngine();
  engine.running = true;
  const inst = initVisualiser(canvas, engine);
  engine.emit('state', { running: true });
  engine.emit('note', { track: 'pad', midi: 60, velocity: 0.8, time: 0, duration: 0.3 });
  engine.emit('state', { running: false });

  assert.ok(calls.fillStyles.length > 0, 'expected at least one fillStyle assignment');
  assert.ok(
    !calls.fillStyles.some((v) => typeof v === 'string' && v.startsWith('rgba(255, 0, 0,')),
    'without a --track-pad custom property, the derived fallback accent must be used instead',
  );

  inst.destroy();
});

// --------------------------------------------------------------------------
// v15: piano-roll repeat brackets
// --------------------------------------------------------------------------

test('repeat brackets: no ruler overlay when the engine lacks setLoopRegion/clearLoopRegion (feature-gated)', () => {
  const prevDocument = globalThis.document;
  globalThis.document = { createElement: (tag) => makeFakeElement(tag) };
  try {
    const calls = {};
    const root = makeFakeElement('div');
    const canvas = makeDomCanvas(calls);
    root.appendChild(canvas);
    const engine = makeEngine(); // no setLoopRegion/clearLoopRegion

    const inst = initVisualiser(canvas, engine);
    const lampHost = canvas.parentNode;
    engine.emit('bar', { bar: 0, beatsPerBar: 4, time: 0 });

    assert.equal(lampHost.children.length, 7, 'only the canvas + 6 lamp buttons — no ruler hit targets built');
    const barButtons = lampHost.children.filter((c) => c.dataset.bar !== undefined);
    assert.equal(barButtons.length, 0);

    inst.destroy();
  } finally {
    if (prevDocument === undefined) delete globalThis.document;
    else globalThis.document = prevDocument;
  }
});

test('repeat brackets: builds per-bar ruler hit targets in the top strip when the engine supports loop methods', () => {
  const prevDocument = globalThis.document;
  globalThis.document = { createElement: (tag) => makeFakeElement(tag) };
  try {
    const calls = {};
    const root = makeFakeElement('div');
    const canvas = makeDomCanvas(calls);
    root.appendChild(canvas);
    const { engine } = makeLoopEngine();

    const inst = initVisualiser(canvas, engine);
    const lampHost = canvas.parentNode;

    engine.emit('bar', { bar: 0, beatsPerBar: 4, time: 0 });
    engine.advance(2);
    engine.emit('bar', { bar: 1, beatsPerBar: 4, time: 2 });

    const barButtons = lampHost.children.filter((c) => c.tagName === 'button' && c.dataset.bar !== undefined);
    assert.equal(barButtons.length, 2, 'expected one ruler hit-target per visible bar');
    const bar0 = barButtons.find((b) => b.dataset.bar === '0');
    const bar1 = barButtons.find((b) => b.dataset.bar === '1');
    assert.ok(bar0 && bar1);
    assert.equal(bar0.getAttribute('aria-label'), 'Set repeat start at bar 0');
    assert.equal(bar1.getAttribute('aria-label'), 'Set repeat start at bar 1');
    assert.equal(bar0.style.top, '0px');
    assert.equal(bar0.style.height, '16px', 'ruler row height matches the top strip (TOP_MARGIN) where chord names render');
    assert.ok(
      parseFloat(bar1.style.left) > parseFloat(bar0.style.left),
      'bar 1 hit target must sit to the right of bar 0',
    );

    inst.destroy();
  } finally {
    if (prevDocument === undefined) delete globalThis.document;
    else globalThis.document = prevDocument;
  }
});

test('repeat brackets: open -> close cycle calls engine.setLoopRegion; the close mark clears via engine.clearLoopRegion', () => {
  const prevDocument = globalThis.document;
  globalThis.document = { createElement: (tag) => makeFakeElement(tag) };
  try {
    const calls = {};
    const root = makeFakeElement('div');
    const canvas = makeDomCanvas(calls);
    root.appendChild(canvas);
    const { engine, calls: loopCalls } = makeLoopEngine();

    const inst = initVisualiser(canvas, engine);
    const lampHost = canvas.parentNode;
    const byBar = (n) => lampHost.children.find((c) => c.dataset.bar === String(n));

    engine.emit('bar', { bar: 0, beatsPerBar: 4, time: 0 });
    engine.advance(2);
    engine.emit('bar', { bar: 1, beatsPerBar: 4, time: 2 });
    engine.advance(2);
    engine.emit('bar', { bar: 2, beatsPerBar: 4, time: 4 });

    byBar(0).click(); // open mark at bar 0
    assert.equal(byBar(0).getAttribute('aria-label'), 'Cancel repeat start at bar 0');
    assert.equal(byBar(1).getAttribute('aria-label'), 'Set repeat end at bar 1');
    assert.equal(byBar(2).getAttribute('aria-label'), 'Set repeat end at bar 2');
    assert.equal(loopCalls.setLoopRegion.length, 0, 'a pending open must not call the engine yet');

    byBar(2).click(); // close mark, to the right of the open mark
    assert.deepEqual(loopCalls.setLoopRegion, [[0, 2]]);
    assert.equal(byBar(0).getAttribute('aria-label'), 'Clear repeat');
    assert.equal(byBar(2).getAttribute('aria-label'), 'Clear repeat');
    assert.equal(byBar(1).getAttribute('aria-label'), 'Set repeat start at bar 1', 'bars inside the loop are unaffected');

    byBar(2).click(); // close mark again
    assert.equal(loopCalls.clearLoopRegion, 1);
    assert.equal(byBar(0).getAttribute('aria-label'), 'Set repeat start at bar 0');
    assert.equal(byBar(2).getAttribute('aria-label'), 'Set repeat start at bar 2');

    inst.destroy();
  } finally {
    if (prevDocument === undefined) delete globalThis.document;
    else globalThis.document = prevDocument;
  }
});

test('repeat brackets: clicking the open mark again, or pressing Esc, cancels the pending mark without calling the engine', () => {
  const prevDocument = globalThis.document;
  globalThis.document = { createElement: (tag) => makeFakeElement(tag) };
  try {
    const calls = {};
    const root = makeFakeElement('div');
    const canvas = makeDomCanvas(calls);
    root.appendChild(canvas);
    const { engine, calls: loopCalls } = makeLoopEngine();

    const inst = initVisualiser(canvas, engine);
    const lampHost = canvas.parentNode;
    const byBar = (n) => lampHost.children.find((c) => c.dataset.bar === String(n));

    engine.emit('bar', { bar: 0, beatsPerBar: 4, time: 0 });
    engine.advance(2);
    engine.emit('bar', { bar: 1, beatsPerBar: 4, time: 2 });

    byBar(0).click();
    assert.equal(byBar(0).getAttribute('aria-label'), 'Cancel repeat start at bar 0');
    byBar(0).click(); // clicking the open mark again cancels it
    assert.equal(byBar(0).getAttribute('aria-label'), 'Set repeat start at bar 0');
    assert.equal(loopCalls.setLoopRegion.length, 0);

    byBar(1).click();
    assert.equal(byBar(1).getAttribute('aria-label'), 'Cancel repeat start at bar 1');
    byBar(1).dispatch('keydown', { key: 'Escape' });
    assert.equal(byBar(1).getAttribute('aria-label'), 'Set repeat start at bar 1');
    assert.equal(loopCalls.setLoopRegion.length, 0, 'Esc must cancel without ever calling the engine');

    inst.destroy();
  } finally {
    if (prevDocument === undefined) delete globalThis.document;
    else globalThis.document = prevDocument;
  }
});

test('repeat brackets: active loop (read from bar-event loop info) dims bars outside it and draws the repeat marks', () => {
  const calls = {};
  calls.arcs = [];
  const canvas = makeCanvas(calls);
  const { engine } = makeLoopEngine();
  engine.running = true;
  const inst = initVisualiser(canvas, engine);
  engine.emit('state', { running: true });

  engine.emit('bar', { bar: 0, beatsPerBar: 4, time: 0 });
  engine.advance(2);
  engine.emit('bar', { bar: 1, beatsPerBar: 4, time: 2, loop: { startBar: 0, endBar: 1 } });

  calls.fillRect = 0;
  calls.arcs.length = 0;
  engine.emit('state', { running: false }); // forces a synchronous static render

  assert.ok(calls.fillRect >= 1, 'expected at least one dimming rect for bars outside the active loop');
  // Each repeat mark draws a thick bar + thin bar (fillRect) and two dots (arc); an
  // active loop draws both the open and close marks, so at least 4 dots total.
  assert.ok(calls.arcs.length >= 4, `expected at least 4 repeat-dot arcs for open+close marks, got ${calls.arcs.length}`);

  inst.destroy();
});

test('repeat brackets: falls back to locally tracked state when bar events never carry loop info', () => {
  const prevDocument = globalThis.document;
  globalThis.document = { createElement: (tag) => makeFakeElement(tag) };
  try {
    const calls = {};
    calls.arcs = [];
    const root = makeFakeElement('div');
    const canvas = makeDomCanvas(calls);
    root.appendChild(canvas);
    const { engine } = makeLoopEngine();

    const inst = initVisualiser(canvas, engine);
    const lampHost = canvas.parentNode;
    const byBar = (n) => lampHost.children.find((c) => c.dataset.bar === String(n));

    engine.emit('bar', { bar: 0, beatsPerBar: 4, time: 0 }); // no `loop` field — engine hasn't landed that part yet
    engine.advance(2);
    engine.emit('bar', { bar: 1, beatsPerBar: 4, time: 2 });

    calls.arcs.length = 0;
    byBar(0).click();
    byBar(1).click(); // -> engine.setLoopRegion(0, 1); renders immediately off our own local state

    assert.ok(
      calls.arcs.length >= 4,
      'active loop must draw from locally tracked state when no bar event ever supplied loop info',
    );

    inst.destroy();
  } finally {
    if (prevDocument === undefined) delete globalThis.document;
    else globalThis.document = prevDocument;
  }
});

test('repeat brackets: malformed loop info on bar events is dropped, not thrown', () => {
  const calls = {};
  const canvas = makeCanvas(calls);
  const { engine } = makeLoopEngine();
  engine.running = true;
  const inst = initVisualiser(canvas, engine);
  engine.emit('state', { running: true });
  engine.emit('bar', { bar: 0, beatsPerBar: 4, time: 0, loop: 'nonsense' });
  engine.emit('bar', { bar: 1, beatsPerBar: 4, time: 1, loop: { startBar: 'x' } });
  engine.emit('bar', { bar: 2, beatsPerBar: 4, time: 2, loop: null }); // explicit "no active loop"
  inst.destroy();
});

test('repeat brackets: v17 mark geometry — open dots sit right of its bars, close dots sit left of its bars', () => {
  const calls = {};
  calls.rects = [];
  calls.arcs = [];
  const canvas = makeCanvas(calls);
  const { engine } = makeLoopEngine();
  engine.running = true;
  const inst = initVisualiser(canvas, engine);
  engine.emit('state', { running: true });

  engine.emit('bar', { bar: 0, beatsPerBar: 4, time: 0 });
  engine.advance(2);
  engine.emit('bar', { bar: 1, beatsPerBar: 4, time: 2, loop: { startBar: 0, endBar: 1 } });

  calls.rects.length = 0;
  calls.arcs.length = 0;
  engine.emit('state', { running: false }); // forces a synchronous static render

  // drawLoopMarkers draws the outside-loop dimming (fillRect, 0-2 rects) before
  // the open then close repeat marks, so the trailing 4 rects are always the
  // marks' thick+thin bars; arc() is only ever called for the marks' dots.
  // Loop dimming and per-lane level meters also call fillRect, at widths that
  // never coincide with the marks' fixed 5px thick bar — filtering on that
  // isolates the open mark's thick bar (drawn first) from the close mark's
  // (drawn second).
  const thickBars = calls.rects.filter((r) => r.w === 5);
  assert.equal(thickBars.length, 2, `expected 2 thick bars (open + close), got ${thickBars.length}`);
  assert.equal(calls.arcs.length, 4, `expected 4 dot arcs (2 per mark; arc() is only ever called for mark dots)`);

  const [openThick, closeThick] = thickBars;
  const [openDot, , closeDot] = calls.arcs;

  assert.ok(openDot.x > openThick.x, 'open mark: dots must sit to the right of its bars');
  assert.ok(closeDot.x < closeThick.x, 'close mark: dots must sit to the left of its bars');

  inst.destroy();
});

// --------------------------------------------------------------------------
// v16: piano-roll de-overlap (vertical offset slots)
// --------------------------------------------------------------------------

test('overlapping pad chord notes get distinct y slots', () => {
  const calls = {};
  calls.roundRects = [];
  const canvas = makeCanvas(calls);
  const engine = makeEngine();
  engine.running = true;
  const inst = initVisualiser(canvas, engine);
  engine.emit('state', { running: true });

  // A close-voiced triad, same onset/duration/velocity so blip size is
  // identical across all three — any y difference is purely the slot offset.
  for (const midi of [60, 63, 67]) {
    engine.emit('note', { track: 'pad', midi, velocity: 0.7, time: 0, duration: 0.4 });
  }
  engine.emit('state', { running: false }); // synchronous static render

  assert.equal(calls.roundRects.length, 3, 'expected one blip per chord note');
  const ys = calls.roundRects.map((p) => p.y);
  assert.equal(new Set(ys).size, 3, `expected three distinct y positions, got: ${ys.join(', ')}`);

  inst.destroy();
});

test('de-overlap slots are deterministic across frames (no jitter on re-render)', () => {
  const calls = {};
  calls.roundRects = [];
  const canvas = makeCanvas(calls);
  const engine = makeEngine();
  engine.running = true;
  const inst = initVisualiser(canvas, engine);
  engine.emit('state', { running: true });

  for (const midi of [60, 63, 67]) {
    engine.emit('note', { track: 'pad', midi, velocity: 0.7, time: 0, duration: 0.4 });
  }
  engine.emit('state', { running: false });
  const firstPass = calls.roundRects.map((p) => p.y);

  calls.roundRects.length = 0;
  engine.emit('state', { running: false }); // re-render without adding any notes
  const secondPass = calls.roundRects.map((p) => p.y);

  assert.deepEqual(secondPass, firstPass, 'the same notes must render at the same y across repeated frames');

  inst.destroy();
});

test('non-overlapping notes are unaffected by de-overlap (each renders at its plain pitch-mapped y)', () => {
  const soloCalls = {};
  soloCalls.roundRects = [];
  const soloEngine = makeEngine();
  soloEngine.running = true;
  const soloInst = initVisualiser(makeCanvas(soloCalls), soloEngine);
  soloEngine.emit('state', { running: true });
  soloEngine.emit('note', { track: 'pad', midi: 60, velocity: 0.7, time: 0, duration: 0.3 });
  soloEngine.emit('state', { running: false });
  const soloY = soloCalls.roundRects[0].y;
  soloInst.destroy();

  const calls = {};
  calls.roundRects = [];
  const canvas = makeCanvas(calls);
  const engine = makeEngine();
  engine.running = true;
  const inst = initVisualiser(canvas, engine);
  engine.emit('state', { running: true });
  // Same pitch as the solo note above, but with an earlier same-pitch note
  // whose interval doesn't overlap it — must not trigger any offset.
  engine.emit('note', { track: 'pad', midi: 60, velocity: 0.7, time: -1, duration: 0.3 });
  engine.emit('note', { track: 'pad', midi: 60, velocity: 0.7, time: 0, duration: 0.3 });
  engine.emit('state', { running: false });

  assert.equal(calls.roundRects.length, 2, 'expected both non-overlapping notes to be visible and drawn');
  assert.equal(calls.roundRects[0].y, soloY, 'the earlier, non-overlapping note renders at its unmodified pitch-mapped y');
  assert.equal(calls.roundRects[1].y, soloY, 'the later, non-overlapping note renders at its unmodified pitch-mapped y');

  inst.destroy();
});

test('percussion lanes are unaffected by de-overlap: same-kind overlapping hits still share one y', () => {
  const calls = {};
  calls.roundRects = [];
  const canvas = makeCanvas(calls);
  const engine = makeEngine();
  engine.running = true;
  const inst = initVisualiser(canvas, engine);
  engine.emit('state', { running: true });

  for (let i = 0; i < 3; i++) {
    engine.emit('note', { track: 'percussion', kind: 'mid', velocity: 0.7, time: 0, duration: 0.4 });
  }
  engine.emit('state', { running: false });

  assert.equal(calls.roundRects.length, 3, 'expected one blip per percussion hit');
  const ys = calls.roundRects.map((p) => p.y);
  assert.equal(new Set(ys).size, 1, `percussion hits of the same kind must share one y (no de-overlap), got: ${ys.join(', ')}`);

  inst.destroy();
});

// --------------------------------------------------------------------------
// v18: setFps/getFps (governor visualFps integration, see power.js header)
// --------------------------------------------------------------------------

function withMatchMedia(reducedMotionMatches, fn) {
  const prevWindow = globalThis.window;
  globalThis.window = {
    matchMedia(query) {
      return {
        matches: query.includes('reduced-motion') ? reducedMotionMatches : false,
        addEventListener() {},
        removeEventListener() {},
      };
    },
  };
  try {
    return fn();
  } finally {
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
  }
}

test('setFps/getFps: default cap is 30fps', () => {
  const inst = initVisualiser(makeCanvas({}), makeEngine());
  assert.equal(inst.getFps(), 30);
  inst.destroy();
});

test('setFps: clamps to 1..60; non-finite/absent input restores the 30fps default', () => {
  const inst = initVisualiser(makeCanvas({}), makeEngine());

  inst.setFps(15);
  assert.equal(inst.getFps(), 15);

  inst.setFps(NaN);
  assert.equal(inst.getFps(), 30, 'NaN restores the default');

  inst.setFps(15);
  inst.setFps(undefined);
  assert.equal(inst.getFps(), 30, 'absent/undefined input restores the default');

  inst.setFps(15);
  inst.setFps('30');
  assert.equal(inst.getFps(), 30, 'non-number input restores the default');

  inst.setFps(100);
  assert.equal(inst.getFps(), 60, 'clamps above range to 60');

  inst.setFps(0);
  assert.equal(inst.getFps(), 1, 'clamps at/below range to 1');

  inst.setFps(-5);
  assert.equal(inst.getFps(), 1, 'clamps negative input to 1');

  inst.destroy();
});

test('setFps(15) halves the draw count over a fixed simulated timestamp sequence', () => {
  const tsSequence = [0, 20, 40, 60, 80, 100, 120, 140];

  const drawCountFor = (configure) =>
    withMockRaf(({ stepFrame }) => {
      const calls = {};
      const canvas = makeCanvas(calls);
      const engine = makeEngine();
      engine.running = true;
      const inst = initVisualiser(canvas, engine);
      engine.emit('state', { running: true });
      if (configure) configure(inst);
      calls.clearRect = 0;
      for (const ts of tsSequence) stepFrame(ts);
      inst.destroy();
      return calls.clearRect;
    });

  const drawsDefault = drawCountFor();
  const drawsHalved = drawCountFor((inst) => inst.setFps(15));

  assert.equal(drawsDefault, 4, `expected 4 draws at the 30fps default over this sequence, got ${drawsDefault}`);
  assert.equal(drawsHalved, 2, `expected setFps(15) to halve the draw count to 2, got ${drawsHalved}`);
});

test('setFps: a mid-run change re-caps the loop without an extra or duplicate draw on the changing tick', () => {
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

    inst.setFps(15); // re-cap mid-run, no loop restart, no immediate extra draw
    assert.equal(calls.clearRect, 1, 'setFps() itself must not draw or schedule a frame');

    stepFrame(20); // inside the new 66.67ms/15fps budget
    assert.equal(calls.clearRect, 1, 'must respect the newly-set cap, not the old 30fps one');
    stepFrame(70); // past the new budget (measured from the last drawn frame at ts=0)
    assert.equal(calls.clearRect, 2, 'exactly one draw, not a stutter/skip or a double-draw');

    inst.destroy();
  });
});

test('setFps interacts correctly with the document.hidden pause: no draws while hidden, resumes honouring the cap', () => {
  withMockRaf(({ stepFrame, rafCbs }) => {
    const prevDocument = globalThis.document;
    const listeners = new Map();
    globalThis.document = {
      hidden: false,
      addEventListener(type, fn) { listeners.set(type, fn); },
      removeEventListener(type) { listeners.delete(type); },
    };
    try {
      const calls = {};
      const canvas = makeCanvas(calls);
      const engine = makeEngine();
      engine.running = true;
      const inst = initVisualiser(canvas, engine);
      engine.emit('state', { running: true });
      inst.setFps(15);

      assert.equal(rafCbs.size, 1, 'loop scheduled while visible');

      globalThis.document.hidden = true;
      listeners.get('visibilitychange')();
      assert.equal(rafCbs.size, 0, 'loop must stop entirely while hidden, regardless of the fps cap');

      globalThis.document.hidden = false;
      listeners.get('visibilitychange')();
      assert.equal(rafCbs.size, 1, 'loop resumes once visible again');

      calls.clearRect = 0;
      stepFrame(0);
      assert.equal(calls.clearRect, 1, 'first resumed tick always draws');
      stepFrame(40); // inside the 66.67ms/15fps budget
      assert.equal(calls.clearRect, 1, 'must respect setFps(15) after resuming from hidden');
      stepFrame(80); // past the 15fps budget
      assert.equal(calls.clearRect, 2);

      inst.destroy();
    } finally {
      if (prevDocument === undefined) delete globalThis.document;
      else globalThis.document = prevDocument;
    }
  });
});

test('reduced-motion "lowest wins": an explicit setFps() cap below the reduced-motion floor is respected, not raised', () => {
  withMatchMedia(true, () => {
    withMockRaf(({ stepFrame }) => {
      const calls = {};
      const canvas = makeCanvas(calls);
      const engine = makeEngine();
      engine.running = true;
      const inst = initVisualiser(canvas, engine);
      engine.emit('state', { running: true });
      inst.setFps(1); // below the reduced-motion 2fps floor

      calls.clearRect = 0;
      stepFrame(0); // first tick always draws
      assert.equal(calls.clearRect, 1);
      stepFrame(500); // reduced-motion's own 2fps/500ms budget has passed...
      assert.equal(calls.clearRect, 1, 'the lower setFps(1)/1000ms cap must still gate this frame');
      stepFrame(1000); // ...but the 1fps/1000ms budget has now passed
      assert.equal(calls.clearRect, 2);

      inst.destroy();
    });
  });
});

test('reduced-motion "lowest wins": reduced motion still throttles below a higher/default setFps() cap', () => {
  withMatchMedia(true, () => {
    withMockRaf(({ stepFrame }) => {
      const calls = {};
      const canvas = makeCanvas(calls);
      const engine = makeEngine();
      engine.running = true;
      const inst = initVisualiser(canvas, engine);
      engine.emit('state', { running: true });
      // No setFps() call — default 30fps cap, higher than the reduced-motion floor.

      calls.clearRect = 0;
      stepFrame(0);
      assert.equal(calls.clearRect, 1);
      stepFrame(40); // past the 30fps/33.3ms budget, but well inside the 2fps/500ms floor
      assert.equal(calls.clearRect, 1, 'reduced motion must still throttle below the default fps cap');
      stepFrame(500); // the 2fps/500ms floor has now passed
      assert.equal(calls.clearRect, 2);

      inst.destroy();
    });
  });
});

test('destroy() stays idempotent after a setFps() call', () => {
  const inst = initVisualiser(makeCanvas({}), makeEngine());
  inst.setFps(15);
  inst.destroy();
  inst.destroy(); // must still be a no-op, not throw
  assert.equal(inst.getFps(), 15, 'the handle keeps reporting its last fps cap after destroy');
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
