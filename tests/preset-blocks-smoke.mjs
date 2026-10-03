/**
 * v0.0.202 — preset blocks are shown and editable for every block preset
 * (owner brief 2026-09-25, "learn exactly how it is built and reconstruct it").
 *
 *   npm run build && node tests/preset-blocks-smoke.mjs
 *
 * abab and journey were blocks the engine kept to itself (PRESET_BLOCKS, not
 * exported, never in the recipe). Now the engine exports them, the recipe
 * names the blocks the piece plays, and a block preset keys its playhead on
 * its blocks — so taking abab over as Custom with the same blocks (what the
 * page does on the first edit) carries on from the bar it was on instead of
 * jumping back to bar zero of block one.
 */
import assert from 'node:assert/strict';

// Minimal AudioContext mock — the same thin shape voice-rule-smoke.mjs uses:
// enough surface for the engine's graph, no node-graph assertions here since
// this suite only reads 'bar' and 'note' events.
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
const { TIME_SIGNATURES, PRESET_BLOCKS } = engineModule;

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

test('PRESET_BLOCKS is exported and frozen, and structureBlocksFor copies it', () => {
  assert.ok(PRESET_BLOCKS && Array.isArray(PRESET_BLOCKS.abab) && Array.isArray(PRESET_BLOCKS.journey),
    'the engine must export the block presets');
  assert.ok(Object.isFrozen(PRESET_BLOCKS.abab) && Object.isFrozen(PRESET_BLOCKS.abab[0]),
    'a page that edits a copy must not be able to edit the preset itself');
  const copy = engineModule.structureBlocksFor('abab');
  assert.deepEqual(copy, PRESET_BLOCKS.abab.map((b) => ({ ...b })));
  copy[0].intensity = 0.99;
  assert.equal(PRESET_BLOCKS.abab[0].intensity, 0.4);
  assert.equal(engineModule.structureBlocksFor('drone'), null, 'drone is a curve, not blocks');
  assert.equal(engineModule.structureBlocksFor('waves'), null);
  assert.equal(engineModule.structureBlocksFor('build'), null);
});

test('the recipe names the blocks a block preset plays, and only then', () => {
  for (const structure of ['abab', 'journey']) {
    const engine = createEngine({ structure });
    assert.deepEqual(engine.getRecipe().customStructure, PRESET_BLOCKS[structure].map((b) => ({ ...b })),
      `${structure}: the recipe must name its blocks`);
  }
  // 'auto' at complexity 0.9 resolves to journey.
  const auto = createEngine({ structure: 'auto', complexity: 0.9 });
  assert.equal(auto.getRecipe().customStructure.length, PRESET_BLOCKS.journey.length,
    'auto playing journey names journey\'s blocks');
  const drone = createEngine({ structure: 'drone' });
  assert.equal(drone.getRecipe().customStructure, undefined, 'a curve preset names no blocks');
});

test('taking abab over as Custom with the same blocks keeps the playhead where it was', () => hiddenTab(async () => {
  const engine = createEngine({ structure: 'abab', bpm: 120 }, { rng: seededRng(7) });
  const sections = [];
  engine.on('bar', () => sections.push(engine.getResolved().section.label));
  await engine.start();
  const bar = barSeconds(engine.getParams());
  // Twelve bars in: block B (bars 8–15), four bars into it.
  await advance(bar * 12);
  const before = sections.length;
  assert.equal(sections[sections.length - 1], 'B', `expected to be in block B, log: ${sections.join('')}`);
  engine.setParams({ structure: 'custom', customStructure: engineModule.structureBlocksFor('abab') });
  await advance(bar * 3);
  const after = sections.slice(before);
  assert.ok(after.length >= 2, 'bars must keep coming after the takeover');
  assert.ok(after.every((label) => label === 'B'),
    `the takeover jumped the playhead: bars after it read ${after.join('')} (expected B until block B ends)`);
  engine.stop();
}));

let failures = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}\n     ${error.message}`);
  } finally {
    for (const made of builtEngines) if (made.running) made.stop();
    builtEngines.length = 0;
    liveContexts.length = 0;
  }
}
console.log(`${tests.length - failures}/${tests.length} passed`);
if (failures) process.exit(1);
