/**
 * v0.0.198 — the auto ladder, per track (owner ruling 2026-09-25: every such
 * decision is a visible, editable rule).
 *
 *   npm run build && node tests/auto-ladder-smoke.mjs
 *
 * Today `AUTO_THRESHOLDS` (built from TRACK_REGISTRY's `autoThreshold`) is a
 * hardcoded constant deciding at which section energy an 'auto' track joins,
 * with no way for a person to see or set it. Now `tracks[t].autoThreshold`
 * (0..1, sparse) overrides that floor per track: `autoThresholdFor(name)`
 * returns the override when one is set, else the registry's own value. This
 * suite gates it at the engine — the RESOLVED `active` flag over real bars,
 * not just the sanitiser.
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
const { TIME_SIGNATURES, AUTO_THRESHOLDS } = engineModule;

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

/**
 * Play `bars` bars of a fixed 'waves' structure at zero complexity (so
 * energy is 0.55 × section intensity alone, which the waves preset keeps
 * inside [0.25, 0.75] — never enough on its own to cross a threshold of 1)
 * and return the melody's per-bar { bar, active, autoThreshold } log plus
 * its note count.
 */
async function playMelodyLadder(overrides, seed, bars) {
  const params = {
    structure: 'waves',
    complexity: 0,
    tracks: { melody: { state: 'auto', ...overrides } },
  };
  const engine = createEngine(params, { rng: seededRng(seed) });
  const log = [];
  let melodyNotes = 0;
  engine.on('bar', () => {
    const r = engine.getResolved();
    log.push({ bar: r.bar, active: r.tracks.melody.active, autoThreshold: r.tracks.melody.autoThreshold });
  });
  engine.on('note', (note) => { if (note.track === 'melody') melodyNotes += 1; });
  await engine.start();
  await advance(barSeconds(engine.getParams()) * (bars + 1));
  engine.stop();
  return { log, melodyNotes, engine };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---------------------------------------------------------------------------
// Sanitiser: sparse, round-trips byte-identical, null clears back to the floor.
// ---------------------------------------------------------------------------

test('sanitise: autoThreshold is sparse — absent by default, set explicitly, cleared by null', () => {
  const fresh = engineModule.sanitiseParams({});
  assert.equal('autoThreshold' in fresh.tracks.melody, false, 'a fresh track carries no override key');

  const set = engineModule.sanitiseParams({ tracks: { melody: { autoThreshold: 0.9 } } });
  assert.equal(set.tracks.melody.autoThreshold, 0.9);
  assert.equal('autoThreshold' in set.tracks.bass, false, 'only the named track gets the key');

  const clamped = engineModule.sanitiseParams({ tracks: { melody: { autoThreshold: 5 } } });
  assert.equal(clamped.tracks.melody.autoThreshold, 1, 'out-of-range clamps into 0..1');

  const cleared = engineModule.sanitiseParams({ tracks: { melody: { autoThreshold: null } } }, set);
  assert.equal('autoThreshold' in cleared.tracks.melody, false, 'null clears the override back to the floor');

  const inherited = engineModule.sanitiseParams({}, set);
  assert.equal(inherited.tracks.melody.autoThreshold, 0.9, 'omitting the key on a later call inherits the stored override');
});

test('getParams: unset reads back with no key; set reads back the exact value (stored pieces byte-equal)', () => {
  const engine = createEngine({}, { rng: seededRng(1) });
  assert.equal('autoThreshold' in engine.getParams().tracks.melody, false);
  engine.setParams({ tracks: { melody: { autoThreshold: 0.33 } } });
  assert.equal(engine.getParams().tracks.melody.autoThreshold, 0.33);
  assert.equal('autoThreshold' in engine.getParams().tracks.bass, false);
});

test('getResolved: unset is the registry constant; set is the override', () => {
  const engine = createEngine({}, { rng: seededRng(1) });
  assert.equal(engine.getResolved().tracks.melody.autoThreshold, AUTO_THRESHOLDS.melody,
    `unset must resolve to the floor (${AUTO_THRESHOLDS.melody})`);
  engine.setParams({ tracks: { melody: { autoThreshold: 0.77 } } });
  assert.equal(engine.getResolved().tracks.melody.autoThreshold, 0.77);
});

// ---------------------------------------------------------------------------
// The ladder itself, over real bars.
// ---------------------------------------------------------------------------

test('autoThreshold 1: the melody never joins on Auto over 24 bars, at any intensity below 1', () => hiddenTab(async () => {
  const { log, melodyNotes } = await playMelodyLadder({ autoThreshold: 1 }, 31, 24);
  assert.ok(log.length >= 24, `only ${log.length} bars logged`);
  assert.ok(log.every((entry) => entry.autoThreshold === 1), 'the resolved threshold must be the override throughout');
  assert.ok(log.every((entry) => entry.active === false),
    `the melody joined at bar(s) ${log.filter((e) => e.active).map((e) => e.bar).join(', ')}`);
  assert.equal(melodyNotes, 0, 'a track that never joins must never sound');
}));

test('autoThreshold 0: the melody sounds from its staged entry, before energy alone would earn it', () => hiddenTab(async () => {
  const { log, melodyNotes } = await playMelodyLadder({ autoThreshold: 0 }, 31, 24);
  const stageIndex = 2; // TRACK_REGISTRY: melody's staged-entry bar
  assert.ok(log.length >= 24, `only ${log.length} bars logged`);
  for (const entry of log) {
    if (entry.bar < stageIndex) {
      assert.equal(entry.active, false, `bar ${entry.bar}: staged entry must still hold the melody back`);
    } else {
      assert.equal(entry.active, true, `bar ${entry.bar}: threshold 0 must always join once staged`);
    }
  }
  assert.ok(melodyNotes > 0, 'the melody never sounded');
}));

test('unset: the melody follows the registry constant exactly as before v0.0.198', () => hiddenTab(async () => {
  const { log } = await playMelodyLadder({}, 31, 24);
  assert.ok(log.length >= 24, `only ${log.length} bars logged`);
  assert.ok(log.every((entry) => entry.autoThreshold === AUTO_THRESHOLDS.melody),
    'an unset override must resolve to the floor at every bar');
  // At complexity 0 and the waves preset's intensity range [0.25, 0.75],
  // energy = 0.55 × intensity ranges [0.1375, 0.4125] — straddling melody's
  // 0.24 floor, so some bars join and some do not. Both must appear, or this
  // run is not actually exercising the ladder.
  const joined = log.some((entry) => entry.bar >= 2 && entry.active);
  const held = log.some((entry) => entry.bar >= 2 && !entry.active);
  assert.ok(joined, 'the melody should join at least once as intensity rises');
  assert.ok(held, 'the melody should also sit out at least once while intensity is low');
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
