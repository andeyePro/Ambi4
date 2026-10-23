/**
 * The step rule — what value a stepped (sample-and-hold) source takes each
 * time it fires (TODO.md "Step rule in the fourth bay"; the six wire tokens
 * reserved 2026-08-12 in docs/dial-control-plane-plan.md § D7).
 *
 *   node tests/step-rule-smoke.mjs
 *
 * `params.stepRule` maps a walk key (pad:level) to one of the tokens. The
 * default, `absolute`, is never stored and is what every build has done: a
 * fresh value anywhere in the span. The others are relative to the value
 * the source is holding, by the track's own step (Drift rate x 0.15 of the
 * span, the step every walk takes): `walk` a random step either way,
 * reflected at the ends; `up` / `down` one step a fire, stopping at the end;
 * `pingpong` up to the top and back down, again and again; `cycle` up to the
 * top then back to the bottom. Sparse: a piece with no stepRule is untouched.
 */
import assert from 'node:assert/strict';

// Minimal AudioContext mock — the same thin shape voice-rule-smoke.mjs uses:
// enough surface for the engine's graph, no node-graph assertions here since
// this suite only reads 'bar' events.
// --------------------------------------------------------------------------

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

const engineModule = await import('../src/scripts/ambient-engine.js');
const { TIME_SIGNATURES } = engineModule;

const seededRng = (seed) => () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
const builtEngines = [];
function createEngine(...args) {
  const made = engineModule.createEngine(...args);
  builtEngines.push(made);
  return made;
}
function barSeconds(params) {
  const beats = (TIME_SIGNATURES[params.timeSignature] || TIME_SIGNATURES['4/4']).beats || 4;
  return (60 / (params.bpm || 90)) * beats;
}
async function advance(seconds, { step = 0.5, sleep = 6 } = {}) {
  const steps = Math.ceil(seconds / step);
  for (let i = 0; i < steps; i++) {
    for (const ctx of liveContexts) ctx.currentTime += step;
    await new Promise((resolve) => setTimeout(resolve, sleep));
  }
}
async function hiddenTab(fn) {
  globalThis.document = { hidden: true, addEventListener() {} };
  try { return await fn(); } finally { delete globalThis.document; }
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/** Per-pass held positions (0..1 inside the span) of pad:level under a rule. */
async function heldValues(rule, { bars = 40, rate = 1 } = {}) {
  const engine = createEngine({
    bpm: 240, speed: 2, structure: 'drone', timeSignature: '4/4',
    tracks: {
      pad: { state: 'on', level: { min: 0, max: 1 }, randomness: 0.5, driftShape: 'step', driftBars: 1, driftRate: rate },
      bass: { state: 'off' }, melody: { state: 'off' }, texture: { state: 'off' }, arp: { state: 'off' }, percussion: { state: 'off' },
    },
    ...(rule ? { stepRule: { 'pad:level': rule } } : {}),
  }, { rng: seededRng(4242) });
  const seen = [];
  engine.on('bar', () => seen.push(engine.getResolved().tracks.pad.level));
  await engine.start();
  await advance(barSeconds({ bpm: 240 }) * bars / 2, { step: 0.12, sleep: 4 });
  engine.stop();
  return seen.slice(2);
}
const diffs = (v) => v.slice(1).map((x, i) => +(x - v[i]).toFixed(6));
const STEP = 0.15;

test('sanitiser: the five non-default tokens are kept, absolute and junk are not stored', () => {
  const engine = createEngine({ stepRule: { 'pad:level': 'pingpong', 'bass:level': 'absolute', 'melody:level': 'random', 'nonsense': 'up', 'arp:level': 'cycle' } });
  assert.deepEqual(engine.getParams().stepRule, { 'pad:level': 'pingpong', 'arp:level': 'cycle' });
  assert.deepEqual(createEngine({}).getParams().stepRule, {}, 'absent is empty');
});

test('the tokens are exactly the reserved six', () => {
  assert.deepEqual([...engineModule.STEP_RULES], [...engineModule.RESERVED_TOKENS.stepRules]);
});

test('absolute (no rule) still jumps anywhere: some steps are far bigger than one walk step', async () => {
  const d = diffs(await heldValues(null));
  assert.ok(d.some((x) => Math.abs(x) > STEP * 1.5), `no big jump in ${d}`);
});

test('walk: every change is at most one step, and it goes both ways', async () => {
  const v = await heldValues('walk');
  const d = diffs(v).filter((x) => x !== 0);
  assert.ok(d.length >= 5, `only ${d.length} changes`);
  for (const x of d) assert.ok(Math.abs(x) <= STEP + 1e-6, `a walk step of ${x}`);
  assert.ok(d.some((x) => x > 0) && d.some((x) => x < 0), `one-way walk ${d}`);
});

test('up: climbs by exactly one step and stops at the top', async () => {
  const v = await heldValues('up');
  const d = diffs(v);
  for (const x of d) assert.ok(x === 0 || Math.abs(x - STEP) < 1e-6 || v.at(-1) === 1, `an up step of ${x}`);
  assert.ok(d.every((x) => x >= 0), 'up never falls');
  assert.equal(v.at(-1), 1, `ends at the top (${v.at(-1)})`);
});

test('down: the mirror — falls and stops at the bottom', async () => {
  const v = await heldValues('down');
  assert.ok(diffs(v).every((x) => x <= 0), 'down never rises');
  assert.equal(v.at(-1), 0);
});

test('pingpong: reaches both ends and turns at each', async () => {
  const v = await heldValues('pingpong', { bars: 60 });
  assert.ok(v.includes(1) && v.includes(0), `ends not both reached: ${v}`);
  for (const x of diffs(v)) assert.ok(Math.abs(x) <= STEP + 1e-6, `a pingpong jump of ${x}`);
});

test('cycle: climbs, and the only falls are a return to the bottom', async () => {
  const v = await heldValues('cycle', { bars: 60 });
  const d = diffs(v);
  const falls = d.map((x, i) => [x, v[i + 1]]).filter(([x]) => x < 0);
  assert.ok(falls.length >= 1, 'never came round');
  for (const [, after] of falls) assert.equal(after, 0, 'a cycle fall lands on the bottom');
  // A rise is one step, or a shorter one that lands exactly on the top.
  d.forEach((x, i) => assert.ok(x <= 0 || Math.abs(x - STEP) < 1e-6 || v[i + 1] === 1, `a cycle rise of ${x}`));
});

test('Drift rate sets the step size', async () => {
  const d = diffs(await heldValues('up', { rate: 0.5 })).filter((x) => x > 0);
  assert.ok(d.length && d.slice(0, -1).every((x) => Math.abs(x - STEP * 0.5) < 1e-6), `steps ${d}`);
});

test('a rule on a continuous shape changes nothing', async () => {
  const run = async (rule) => {
    const engine = createEngine({
      bpm: 240, speed: 2, structure: 'drone',
      tracks: { pad: { state: 'on', level: { min: 0, max: 1 }, randomness: 0.5, driftShape: 'cycle', driftBars: 4 } },
      ...(rule ? { stepRule: { 'pad:level': rule } } : {}),
    }, { rng: seededRng(77) });
    const seen = [];
    engine.on('bar', () => seen.push(engine.getResolved().tracks.pad.level));
    await engine.start();
    await advance(4, { step: 0.12, sleep: 4 });
    engine.stop();
    return seen;
  };
  // The clock is simulated in steps, so under load one run can see a bar
  // more than the other; compare the bars both saw.
  const a = await run('pingpong');
  const b = await run(null);
  const n = Math.min(a.length, b.length);
  assert.ok(n >= 4, `only ${n} bars`);
  assert.deepEqual(a.slice(0, n), b.slice(0, n));
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
