/**
 * v0.0.195 — the voice rule, the first Now / Chance / Pool, gated at the ENGINE.
 *
 *   npm run build && node tests/voice-rule-smoke.mjs
 *
 * His report: Synthwave's melody kept moving to Organ stab and nothing could
 * hold it. The cause was wanderVoices: p = 0.25 × Randomness per bar over every
 * other bank voice, ephemeral, with the only hold a mini-knob nothing named.
 * Now every track may carry tracks[t].voiceRule = { chance, when, pool, order }
 * (owner ruling 2026-09-25): Chance 0 holds the pick for good, the pool is what
 * a redraw may pick from, and Next keeps a held rule. This suite asserts that at
 * the engine — the RESOLVED voice each bar, not a picker — and that a track
 * with no rule keeps the pre-v0.0.195 stream to the byte.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// Minimal AudioContext mock — enough surface for the engine's graph and for
// the voice library's nodes. Deliberately thinner than engine-smoke's: this
// suite reads 'note' events, never the node graph.
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

const { compileGenre } = await import('../src/scripts/genre-compiler.js');
const { setGenreTable, TIME_SIGNATURES } = engineModule;
const GENRE_DIR = new URL('../src/data/genres/', import.meta.url);
const GENRES = readdirSync(GENRE_DIR)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .map((name) => JSON.parse(readFileSync(new URL(name, GENRE_DIR), 'utf8')));
const synthwave = GENRES.find((g) => g.slug === 'synthwave');
assert.ok(synthwave, 'no synthwave genre file');
setGenreTable(GENRES);

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

/** Play `bars` bars and return the melody's resolved voice at every bar, plus its note count. */
async function play(params, seed, bars) {
  const engine = createEngine(params, { rng: seededRng(seed) });
  const voices = [];
  let melodyNotes = 0;
  engine.on('bar', () => voices.push(engine.getResolved().tracks.melody.voice));
  engine.on('note', (note) => { if (note.track === 'melody') melodyNotes += 1; });
  await engine.start();
  await advance(barSeconds(params) * (bars + 1));
  engine.stop();
  return { voices, melodyNotes, engine };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('sanitise: the rule is sparse, merges field by field, and null clears it', () => {
  const base = engineModule.sanitiseParams({ tracks: { melody: { voiceRule: { chance: 0, when: 'section', pool: ['keys', { id: 'tines', weight: 3 }, 'keys', 42], order: 'turn' } } } });
  const rule = base.tracks.melody.voiceRule;
  assert.deepEqual(rule, { chance: 0, when: 'section', pool: [{ id: 'keys', weight: 1 }, { id: 'tines', weight: 3 }], order: 'turn' });
  assert.equal('voiceRule' in engineModule.sanitiseParams({}).tracks.melody, false, 'a fresh track carries no rule key');
  const merged = engineModule.sanitiseParams({ tracks: { melody: { voiceRule: { chance: 0.5 } } } }, base);
  assert.equal(merged.tracks.melody.voiceRule.chance, 0.5);
  assert.equal(merged.tracks.melody.voiceRule.when, 'section', 'a partial rule keeps the rest');
  const cleared = engineModule.sanitiseParams({ tracks: { melody: { voiceRule: null } } }, base);
  assert.equal('voiceRule' in cleared.tracks.melody, false, 'null clears the rule');
  const follows = engineModule.sanitiseParams({ tracks: { melody: { voiceRule: { chance: null, pool: [] } } } });
  assert.equal(follows.tracks.melody.voiceRule.chance, null, 'null chance means follow Randomness');
});

test('Synthwave: melody at Chance 0 with Organ stab out of the pool plays Keys for 64 bars', () => hiddenTab(async () => {
  const params = compileGenre(synthwave, { rng: seededRng(11) });
  assert.equal(params.tracks.melody.voice, 'keys', 'the genre puts the melody on Keys');
  params.tracks.melody.state = 'on';
  params.tracks.melody.randomness = 1; // the old wander law would move it almost every bar
  params.tracks.melody.voiceRule = {
    chance: 0, when: 'bar', order: 'weight',
    pool: [{ id: 'keys', weight: 1 }, { id: 'tines', weight: 1 }, { id: 'bell', weight: 1 }],
  };
  const { voices, melodyNotes } = await play(params, 11, 64);
  assert.ok(voices.length >= 64, `only ${voices.length} bars played`);
  assert.ok(melodyNotes > 0, 'the melody never sounded');
  assert.ok(voices.every((v) => v === 'keys'), `the held melody moved: ${[...new Set(voices)].join(', ')}`);
}));

test('Synthwave: the same melody with no rule wanders at Randomness 1 (the old law still runs)', () => hiddenTab(async () => {
  const params = compileGenre(synthwave, { rng: seededRng(11) });
  params.tracks.melody.state = 'on';
  params.tracks.melody.randomness = 1;
  const { voices } = await play(params, 11, 64);
  assert.ok(new Set(voices).size > 1, 'with no rule and Randomness 1 the wander should have moved the melody at least once in 64 bars');
}));

test('Chance 1 each bar draws only from the pool, never Organ stab', () => hiddenTab(async () => {
  const params = compileGenre(synthwave, { rng: seededRng(5) });
  params.tracks.melody.state = 'on';
  params.tracks.melody.voiceRule = {
    chance: 1, when: 'bar', order: 'weight',
    pool: [{ id: 'keys', weight: 1 }, { id: 'tines', weight: 1 }],
  };
  const { voices } = await play(params, 5, 32);
  const seen = new Set(voices);
  assert.ok(seen.has('keys') && seen.has('tines'), `both pool voices should sound over 32 bars: ${[...seen]}`);
  assert.ok(![...seen].includes('stab'), 'Organ stab is out of the pool and must never sound');
  assert.ok([...seen].every((v) => v === 'keys' || v === 'tines'), `a voice outside the pool sounded: ${[...seen]}`);
}));

test('In turn steps down the pool in order, each bar', () => hiddenTab(async () => {
  const params = compileGenre(synthwave, { rng: seededRng(9) });
  params.tracks.melody.state = 'on';
  params.tracks.melody.voiceRule = {
    chance: 1, when: 'bar', order: 'turn',
    pool: [{ id: 'keys', weight: 1 }, { id: 'tines', weight: 1 }, { id: 'bell', weight: 1 }],
  };
  const { voices } = await play(params, 9, 12);
  const cycle = ['keys', 'tines', 'bell'];
  // The first bar's draw lands on the pool entry after Keys; from there the
  // sequence must walk the cycle with no skips and no repeats.
  for (let i = 1; i < Math.min(voices.length, 12); i++) {
    const expect = cycle[(cycle.indexOf(voices[i - 1]) + 1) % 3];
    assert.equal(voices[i], expect, `bar ${i}: after ${voices[i - 1]} came ${voices[i]}, not ${expect}`);
  }
}));

test('Next (a fresh compile at a new seed) keeps a held rule when the page carries it over', () => hiddenTab(async () => {
  // The page's applyGenre copies a Chance-0 rule and its pick onto the new
  // compile (v0.0.195); the engine's half is that the copied rule holds.
  const held = { chance: 0, when: 'bar', order: 'weight', pool: [{ id: 'keys', weight: 1 }, { id: 'tines', weight: 1 }] };
  for (const seed of [21, 22, 23]) {
    const params = compileGenre(synthwave, { rng: seededRng(seed) });
    params.tracks.melody.state = 'on';
    params.tracks.melody.randomness = 1;
    params.tracks.melody.voice = 'keys';
    params.tracks.melody.voiceRule = held;
    const { voices } = await play(params, seed, 16);
    assert.ok(voices.every((v) => v === 'keys'), `seed ${seed}: the held melody moved: ${[...new Set(voices)]}`);
  }
}));

test('a legacy blend (voiceWeights, no rule) still draws per section from its weights', () => hiddenTab(async () => {
  const params = compileGenre(synthwave, { rng: seededRng(3) });
  params.tracks.melody.state = 'on';
  params.tracks.melody.voiceWeights = { keys: 1, tines: 1 };
  const { voices } = await play(params, 3, 48);
  assert.ok([...new Set(voices)].every((v) => v === 'keys' || v === 'tines'), `a blend voice outside the weights sounded: ${[...new Set(voices)]}`);
}));

test('getParams: a rule reads back as set, and a track without one carries no key (stored pieces byte-equal)', () => {
  const engine = createEngine(compileGenre(synthwave, { rng: seededRng(2) }), { rng: seededRng(2) });
  assert.equal('voiceRule' in engine.getParams().tracks.melody, false);
  engine.setParams({ tracks: { melody: { voiceRule: { chance: 0, pool: ['keys'] } } } });
  assert.deepEqual(engine.getParams().tracks.melody.voiceRule, { chance: 0, when: 'bar', pool: [{ id: 'keys', weight: 1 }], order: 'weight' });
  assert.equal('voiceRule' in engine.getParams().tracks.bass, false);
});

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
