/**
 * The texture's OPT-IN step grid (v0.0.262, the "Start with ANY track"
 * leftover): texture was the one tuned track with no grid, so no Write door
 * could start it. It now takes a grid exactly when one is written to it.
 *
 *   node tests/texture-grid-smoke.mjs
 *
 * The laws:
 *   - ABSENT is today: a piece with no texture grid plays the identical note
 *     stream to the engine before the grid existed, for fixed seeds. The
 *     digests below were frozen from dev (v0.0.259) by running this file with
 *     TEXTURE_GRID_FREEZE=1 TEXTURE_GRID_ENGINE=<path to that engine> —
 *     texture is NOT in SEQUENCED_TRACKS, whose order is the Markov pass's
 *     draw order, so the grid cannot move a single draw of a gridless piece.
 *   - a grid stored under AUTO is inert: the same stream as no grid.
 *   - a grid under MANUAL is the whole texture: it plays exactly its steps —
 *     the typed note where a step pins one, a chord tone in the texture's band
 *     where it does not — and nothing drifts in between.
 *   - the grid is sparse: getParams() shows no key until one is written, and
 *     null takes it away again.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// Minimal AudioContext mock — the same thin shape note-source-smoke.mjs uses.
function makeParam(value) {
  return {
    value,
    setValueAtTime(v) { this.value = v; return this; },
    linearRampToValueAtTime(v) { this.value = v; return this; },
    exponentialRampToValueAtTime(v) {
      assert.ok(v > 0, 'exponential ramps must never target zero');
      this.value = v;
      return this;
    },
    setTargetAtTime(v) { this.value = v; return this; },
    setValueCurveAtTime() { return this; },
    cancelScheduledValues() { return this; },
    cancelAndHoldAtTime() { return this; },
  };
}

function makeNode(kind) {
  return {
    kind,
    connections: [],
    gain: makeParam(1),
    frequency: makeParam(440),
    detune: makeParam(0),
    Q: makeParam(1),
    pan: makeParam(0),
    delayTime: makeParam(0.25),
    playbackRate: makeParam(1),
    offset: makeParam(1),
    threshold: makeParam(-24),
    knee: makeParam(30),
    ratio: makeParam(12),
    attack: makeParam(0.003),
    release: makeParam(0.25),
    type: 'sine',
    normalize: true,
    loop: false,
    buffer: null,
    curve: null,
    oversample: 'none',
    fftSize: 2048,
    smoothingTimeConstant: 0.8,
    get frequencyBinCount() { return this.fftSize / 2; },
    getByteTimeDomainData(array) { array.fill(128); },
    getByteFrequencyData(array) { array.fill(0); },
    getFloatTimeDomainData(array) { array.fill(0); },
    setPeriodicWave() {},
    connect(target) { this.connections.push(target); },
    disconnect(target) {
      if (target) this.connections = this.connections.filter((n) => n !== target);
      else this.connections = [];
    },
    start(t = 0) {
      assert.ok(Number.isFinite(t) && t >= 0, `osc.start time must be finite: ${t}`);
      this.startedAt = t;
    },
    stop(t = 0) {
      assert.ok(Number.isFinite(t), `osc.stop time must be finite: ${t}`);
      if (typeof this.startedAt === 'number') {
        assert.ok(t >= this.startedAt, 'osc.stop must not precede osc.start');
      }
    },
  };
}

const liveContexts = [];

class MockAudioContext {
  constructor() {
    this.currentTime = 0;
    this.sampleRate = 48000;
    this.state = 'running';
    this.nodes = [];
    this.destination = this.track(makeNode('destination'));
    liveContexts.push(this);
  }

  track(node) {
    this.nodes.push(node);
    return node;
  }

  createGain() { return this.track(makeNode('gain')); }
  createOscillator() { return this.track(makeNode('oscillator')); }
  createBiquadFilter() { return this.track(makeNode('biquad')); }
  createStereoPanner() { return this.track(makeNode('panner')); }
  createPanner() { return this.track(makeNode('panner3d')); }
  createConvolver() { return this.track(makeNode('convolver')); }
  createDelay() { return this.track(makeNode('delay')); }
  createDynamicsCompressor() { return this.track(makeNode('compressor')); }
  createAnalyser() { return this.track(makeNode('analyser')); }
  createBufferSource() { return this.track(makeNode('buffersource')); }
  createConstantSource() { return this.track(makeNode('constantsource')); }
  createWaveShaper() { return this.track(makeNode('waveshaper')); }
  createChannelMerger() { return this.track(makeNode('merger')); }
  createChannelSplitter() { return this.track(makeNode('splitter')); }
  createPeriodicWave() { return { kind: 'periodicwave' }; }

  createBuffer(channels, length, sampleRate) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { numberOfChannels: channels, length, sampleRate, getChannelData: (i) => data[i] };
  }

  resume() { this.state = 'running'; return Promise.resolve(); }
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
}

globalThis.AudioContext = MockAudioContext;

const enginePath = process.env.TEXTURE_GRID_ENGINE || '../src/scripts/ambient-engine.js';
const engineModule = await import(enginePath);
const { TIME_SIGNATURES } = engineModule;

const seededRng = (seed) => () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
function barSeconds(bpm, timeSignature = '4/4') {
  const beats = (TIME_SIGNATURES[timeSignature] || TIME_SIGNATURES['4/4']).beats || 4;
  return (60 / bpm) * beats;
}
async function advance(seconds, { step = 0.12, sleep = 4 } = {}) {
  const steps = Math.ceil(seconds / step);
  for (let i = 0; i < steps; i++) {
    for (const ctx of liveContexts) ctx.currentTime += step;
    await new Promise((resolve) => setTimeout(resolve, sleep));
  }
}

const ALL_ON = {
  pad: { state: 'on' }, bass: { state: 'on' }, melody: { state: 'on' },
  arp: { state: 'on' }, texture: { state: 'on' }, percussion: { state: 'on' },
};

async function collect(tracks = {}, { bars = 10, seed = 9091, complexity = 0.8 } = {}) {
  const merged = Object.fromEntries(Object.entries(ALL_ON).map(([id, t]) => [id, { ...t, ...(tracks[id] || {}) }]));
  const engine = engineModule.createEngine({
    bpm: 200, speed: 2, structure: 'drone', timeSignature: '4/4', complexity, mode: 'dorian', root: 'D',
    swing: 0, tracks: merged,
  }, { rng: seededRng(seed) });
  const notes = [];
  const barsSeen = [];
  engine.on('note', (e) => notes.push(e));
  engine.on('bar', (e) => barsSeen.push(e));
  await engine.start();
  await advance(barSeconds(200) * bars);
  engine.stop();
  barsSeen.sort((a, b) => a.time - b.time);
  // The stop lands wherever the real timers put it, so only the bars well
  // inside the run are compared: everything before the last two bars began.
  const cutoff = barsSeen.length > 2 ? barsSeen[barsSeen.length - 2].time : Infinity;
  const settled = notes.filter((n) => n.time < cutoff - 1e-6).sort((a, b) => a.time - b.time
    || String(a.track).localeCompare(String(b.track)) || (a.midi ?? 0) - (b.midi ?? 0));
  return { engine, notes, barsSeen, settled };
}

const digest = (notes) => createHash('sha256').update(JSON.stringify(notes.map((n) => [
  n.track, n.midi ?? null, n.kind ?? null, Number(n.time).toFixed(6),
  Number(n.duration).toFixed(6), Number(n.velocity).toFixed(6),
]))).digest('hex').slice(0, 24);

const SEEDS = [9091, 31, 4242];
const COMPLEXITIES = [0.8, 0.45];

if (process.env.TEXTURE_GRID_FREEZE) {
  const out = {};
  for (const c of COMPLEXITIES) {
    for (const seed of SEEDS) {
      const { settled } = await collect({}, { seed, complexity: c });
      out[`${c}:${seed}`] = digest(settled);
    }
  }
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

// Frozen from dev v0.0.259, before the grid existed (see the header).
const FROZEN = Object.freeze({
  '0.8:9091': 'c42423e9e0194211b64535c1',
  '0.8:31': '264f14adafdd3fb559c6aa52',
  '0.8:4242': '3468b48670b6e8a752f83fb3',
  '0.45:9091': 'd2527479e079c57f0fa11c91',
  '0.45:31': '36411c2c3af7059ccca25064',
  '0.45:4242': '482bbc5add3257416c9c2e0f',
});

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const lane = (on, extra = () => ({})) => Array.from({ length: 20 }, (unused, i) => ({
  on: on(i), prob: 1, vmin: 0.7, vmax: 0.7, ...extra(i),
}));
const STEPS = [0, 6, 12];
const PINS = { 0: 84, 6: 88, 12: 91 };
const gridOf = (mode, { pinned = true } = {}) => [{
  mode, hand: true, weights: [1],
  steps: lane((i) => STEPS.includes(i), (i) => (pinned && PINS[i] ? { midi: PINS[i] } : {})),
}];

test('ABSENT: no texture grid is the identical note stream to dev, for fixed seeds', async () => {
  for (const c of COMPLEXITIES) {
    for (const seed of SEEDS) {
      const { notes, settled, engine } = await collect({}, { seed, complexity: c });
      assert.ok(notes.some((n) => n.track === 'texture'), `seed ${seed}: the texture never drifted`);
      assert.equal(digest(settled), FROZEN[`${c}:${seed}`], `complexity ${c} seed ${seed}: the stream moved`);
      assert.ok(!('sequencers' in engine.getParams().tracks.texture), 'a gridless texture reads back a grid');
    }
  }
});

test('AUTO: a grid stored under auto is inert — the same stream as no grid', async () => {
  for (const seed of SEEDS) {
    const { settled, engine } = await collect({ texture: { sequencers: gridOf('auto') } }, { seed });
    assert.equal(engine.getParams().tracks.texture.sequencers.length, 1, 'the auto grid was not stored');
    assert.equal(digest(settled), FROZEN[`0.8:${seed}`], `seed ${seed}: an auto grid moved the stream`);
  }
});

test('MANUAL: a written texture line plays exactly its steps, its typed notes verbatim', async () => {
  for (const seed of SEEDS) {
    const { notes, barsSeen } = await collect({ texture: { sequencers: gridOf('manual') } }, { seed });
    const texture = notes.filter((n) => n.track === 'texture' && !n.live);
    assert.ok(texture.length >= 3 * 6, `seed ${seed}: only ${texture.length} texture notes`);
    assert.equal(texture.filter((n) => n.source !== 'step').length, 0,
      `seed ${seed}: texture sources ${[...new Set(texture.map((n) => n.source))].join(', ')}`);
    const spb = (barsSeen[1].time - barsSeen[0].time) / 4;
    const byBar = new Map();
    for (const n of texture) {
      let b = null;
      for (const x of barsSeen) if (x.time <= n.time + 1e-6) b = x;
      const at = (n.time - b.time) / spb / 0.25;
      const slot = Math.round(at);
      assert.ok(Math.abs(at - slot) < 0.45, `a texture note off the grid at slot ${at.toFixed(2)}`);
      assert.ok(STEPS.includes(slot), `a texture note on slot ${slot}, not a written step`);
      assert.equal(n.midi, PINS[slot], `slot ${slot} played ${n.midi}, written ${PINS[slot]}`);
      if (!byBar.has(b)) byBar.set(b, []);
      byBar.get(b).push(slot);
    }
    for (const [b, slots] of byBar) {
      // The last bar seen may be cut off by the stop; every full one is exact.
      if (b === barsSeen[barsSeen.length - 1]) continue;
      assert.deepEqual(slots.sort((x, y) => x - y), STEPS, `bar at ${b.time.toFixed(2)} played slots ${slots}`);
    }
  }
});

test('MANUAL, unpinned: the pitch comes from the harmony, in the texture band', async () => {
  const { notes } = await collect({ texture: { sequencers: gridOf('manual', { pinned: false }), dissonance: 0 } });
  const texture = notes.filter((n) => n.track === 'texture' && !n.live);
  assert.ok(texture.length >= 18, `${texture.length} texture notes`);
  for (const n of texture) {
    assert.ok(n.midi >= 67 && n.midi <= 108, `texture note ${n.midi} outside its band`);
    assert.equal(n.source, 'step');
  }
});

test('MANUAL, two bars chained: the texture plays its bars in order', async () => {
  const bar = (midi) => ({ mode: 'manual', hand: true, weights: [1, 1],
    steps: lane((i) => i === 0, () => ({ midi })) });
  const { notes } = await collect({ texture: { sequencers: [bar(84), bar(96)], sequencerAdvance: 'chain' } }, { bars: 8 });
  const texture = notes.filter((n) => n.track === 'texture');
  assert.ok(texture.length >= 6, `${texture.length} notes`);
  texture.forEach((n, i) => assert.equal(n.midi, i % 2 === 0 ? 84 : 96, `bar ${i} played ${n.midi}`));
});

test('the grid is sparse: written by setParams, read back, and null takes it away', async () => {
  const engine = engineModule.createEngine({}, { rng: seededRng(5) });
  assert.ok(!('sequencers' in engine.getParams().tracks.texture), 'a fresh engine ships a texture grid');
  engine.setParams({ tracks: { texture: { sequencers: gridOf('manual') } } });
  const stored = engine.getParams().tracks.texture;
  assert.equal(stored.sequencers.length, 1);
  assert.equal(stored.sequencers[0].mode, 'manual');
  assert.equal(stored.sequencers[0].steps[6].midi, 88);
  assert.ok(stored.sequencer && stored.sequencer.steps[6].midi === 88, 'no singular alias');
  // An unrelated edit keeps it.
  engine.setParams({ tracks: { texture: { level: 0.5 } } });
  assert.equal(engine.getParams().tracks.texture.sequencers.length, 1, 'an unrelated edit dropped the grid');
  engine.setParams({ tracks: { texture: { sequencers: null } } });
  assert.ok(!('sequencers' in engine.getParams().tracks.texture), 'null did not take the grid away');
  // Not in the draw-order list, and the export says which tracks opt in.
  assert.ok(!engineModule.SEQUENCED_TRACKS.includes('texture'), 'texture joined SEQUENCED_TRACKS');
  assert.deepEqual([...(engineModule.OPT_GRID_TRACKS || [])], ['texture']);
  assert.ok(engineModule.NOTE_SOURCES.texture.includes('step'));
});

test('a hand-written texture line switched on from silence enters at once', async () => {
  const off = Object.fromEntries(Object.keys(ALL_ON).map((id) => [id, { state: 'off' }]));
  const { notes, barsSeen } = await collect({ ...off, texture: { state: 'on', sequencers: gridOf('manual') } }, { bars: 3 });
  const first = notes.find((n) => n.track === 'texture');
  assert.ok(first, 'the written texture never sounded');
  assert.ok(first.time < barsSeen[0].time + barSeconds(200, '4/4') / 2 + 0.01,
    `the written texture waited: first note ${first.time.toFixed(2)}, first bar ${barsSeen[0].time.toFixed(2)}`);
});

let failures = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}\n     ${error.message}`);
  }
}
console.log(`\n${tests.length - failures}/${tests.length} passed`);
process.exit(failures ? 1 : 0);
