/**
 * Note roles — every pitched note the engine plays says what it is against
 * the chord under it (TODO, "Engine telemetry": see and edit how individual
 * notes are selected from the current chord).
 *
 *   node tests/note-role-smoke.mjs
 *
 * The 'note' event gains `role` (root / third / fifth / sixth / seventh /
 * ninth / eleventh for a chord tone, `passing` for a scale tone outside the
 * chord, `outside` for a note off the scale) and `interval` (semitones above
 * the chord's root, 0-11). Drum notes carry neither. It is telemetry: it reads
 * the harmony frame and draws nothing, so tests/audio-reference.mjs is
 * unmoved by it.
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

async function collect(extra = {}) {
  const engine = createEngine({
    bpm: 200, speed: 2, structure: 'drone', timeSignature: '4/4', complexity: 0.8, mode: 'dorian', root: 'D',
    tracks: {
      pad: { state: 'on' }, bass: { state: 'on' }, melody: { state: 'on' },
      arp: { state: 'on' }, texture: { state: 'off' }, percussion: { state: 'on' },
    },
    ...extra,
  }, { rng: seededRng(9091) });
  const notes = [];
  engine.on('note', (e) => notes.push(e));
  await engine.start();
  await advance(barSeconds({ bpm: 200 }) * 6, { step: 0.12, sleep: 4 });
  engine.stop();
  return notes;
}

const ROLES = ['root', 'third', 'fifth', 'sixth', 'seventh', 'ninth', 'eleventh', 'passing', 'outside'];

test('every pitched note has a role and an interval; drums have neither', async () => {
  const notes = await collect();
  const pitched = notes.filter((n) => n.track !== 'percussion');
  const drums = notes.filter((n) => n.track === 'percussion');
  assert.ok(pitched.length > 20 && drums.length > 5, `pitched ${pitched.length}, drums ${drums.length}`);
  for (const n of pitched) {
    assert.ok(ROLES.includes(n.role), `${n.track} ${n.midi}: role ${n.role}`);
    assert.ok(Number.isInteger(n.interval) && n.interval >= 0 && n.interval < 12, `interval ${n.interval}`);
    if (n.role === 'root') assert.equal(n.interval, 0);
  }
  for (const n of drums) assert.ok(!('role' in n) && !('interval' in n), 'a drum note carries a role');
});

test('the pad plays the chord: every pad note is a chord tone', async () => {
  const pad = (await collect()).filter((n) => n.track === 'pad');
  assert.ok(pad.length > 3, `${pad.length} pad notes`);
  for (const n of pad) assert.ok(n.role && !['passing', 'outside'].includes(n.role), `a pad note is ${n.role} (interval ${n.interval})`);
});

test('a scale tone outside the chord reads passing, never outside', async () => {
  const notes = await collect();
  // Dorian on D: D E F G A B C. An "outside" note must be off that scale.
  const dorian = new Set([2, 4, 5, 7, 9, 11, 0]);
  const pitched = notes.filter((x) => x.track !== 'percussion');
  assert.ok(pitched.length && pitched.every((n) => typeof n.role === 'string'), 'notes carry no role to check');
  for (const n of pitched) {
    const inScale = dorian.has(((n.midi % 12) + 12) % 12);
    if (n.role === 'outside') assert.ok(!inScale, `midi ${n.midi} is in D dorian but read outside`);
    if (n.role === 'passing') assert.ok(inScale, `midi ${n.midi} is off D dorian but read passing`);
  }
});

test('the roles say something: a busy piece has more than one kind', async () => {
  const kinds = new Set((await collect()).filter((n) => n.track === 'melody' || n.track === 'arp').map((n) => n.role));
  assert.ok(kinds.size >= 3, `only ${[...kinds].join(', ')}`);
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
