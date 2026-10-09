/**
 * v0.0.216 — the walk as a rule (TODO.md "Reconstructible Ambi4", the
 * `walks` secret layer: "the live position inside every min-max walk").
 *
 *   node tests/walk-seed-smoke.mjs
 *
 * Every spread (min/max) dial walks inside its span on a bounded random walk
 * per track:param. Until now that walk drew from the piece's own rng, so a
 * rebuild at any other seed wandered somewhere else and the recipe could not
 * say where a dial stood. Now:
 *   - tracks[t].walkSeed puts a track's walks on their own seeded path, the
 *     next step decided by where the walk stands (seededWalkDraw), so the
 *     same seed walks the same path at ANY rng seed;
 *   - the recipe's `walks` names every live position, and applyRecipe lands
 *     them at the next barline, so a rebuild picks the walk up where it was;
 *   - tracks[t].walkHold holds named walks still.
 * Unset, nothing moves: an unseeded walk still draws from the piece rng.
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
const { recipeToText, recipeFromText } = await import('../src/scripts/recipe.js');

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

const BARS = 12;
const SEEDS = { pad: 101, bass: 202, melody: 303 };

/** A piece with several spread dials on three tracks, each track's walks seeded (or not). */
function spreadParams({ seeded = true } = {}) {
  const track = (name, extra) => ({
    state: 'on',
    level: { min: 0.3, max: 0.9 },
    randomness: { min: 0.2, max: 0.7 },
    ...(seeded ? { walkSeed: SEEDS[name] } : {}),
    ...extra,
  });
  return {
    bpm: 120,
    structure: 'drone',
    tracks: {
      pad: track('pad'),
      bass: track('bass', { density: { min: 0.3, max: 0.8 } }),
      melody: track('melody', { density: { min: 0.2, max: 0.9 } }),
    },
  };
}

/**
 * Bar-by-bar snapshots of the recipe's walk positions. The 'bar' event fires
 * BEFORE that bar's walks step, so snapshot k is the state the walks ENTER
 * bar k with — the positions bar k-1 played.
 */
function recordWalks(engine) {
  const bars = [];
  engine.on('bar', () => bars.push({ ...(engine.getRecipe().walks || {}) }));
  return bars;
}

const SEEDED_KEY = /^(pad|bass|melody):/;

test('walkSeed and walkHold are sparse, sanitised params', () => {
  const plain = createEngine({});
  for (const [name, track] of Object.entries(plain.getParams().tracks)) {
    assert.equal('walkSeed' in track, false, `${name}: an unset walk seed must not be stored`);
    assert.equal('walkHold' in track, false, `${name}: an unset walk hold must not be stored`);
  }
  const engine = createEngine({ tracks: { pad: { walkSeed: 12345.7, walkHold: ['level', 'level', 'bad key!', 7] } } });
  assert.equal(engine.getParams().tracks.pad.walkSeed, 12345, 'the seed is a whole number');
  assert.deepEqual(engine.getParams().tracks.pad.walkHold, ['level'], 'the hold list is deduplicated and checked');
  engine.setParams({ tracks: { pad: { level: 0.5 } } });
  assert.equal(engine.getParams().tracks.pad.walkSeed, 12345, 'absence inherits the stored seed');
  engine.setParams({ tracks: { pad: { walkSeed: null, walkHold: [] } } });
  assert.equal('walkSeed' in engine.getParams().tracks.pad, false, 'null clears the seed');
  assert.equal('walkHold' in engine.getParams().tracks.pad, false, 'an empty list clears the hold');
  const recipe = createEngine({ tracks: { pad: { walkSeed: 9, walkHold: ['level'] } } }).getRecipe();
  assert.equal(recipe.tracks.pad.walkSeed, 9, 'the recipe names the seed');
  assert.deepEqual(recipe.tracks.pad.walkHold, ['level'], 'the recipe names the hold');
});

test('a seeded walk is the same at a different rng seed, bar for bar', () => hiddenTab(async () => {
  const a = createEngine(spreadParams(), { rng: seededRng(11) });
  const b = createEngine(spreadParams(), { rng: seededRng(99) });
  const barsA = recordWalks(a);
  const barsB = recordWalks(b);
  await a.start();
  await b.start();
  await advance(barSeconds(a.getParams()) * BARS);
  a.stop();
  b.stop();
  const n = Math.min(barsA.length, barsB.length);
  assert.ok(n >= BARS - 2, `both pieces must play bars (${barsA.length}, ${barsB.length})`);
  let compared = 0;
  let moved = 0;
  for (let i = 0; i < n; i++) {
    for (const key of Object.keys(barsA[i]).filter((k) => SEEDED_KEY.test(k))) {
      if (!(key in barsB[i])) continue;
      assert.equal(barsB[i][key], barsA[i][key], `bar ${i} ${key}: the seeded walk differs between rng seeds`);
      compared += 1;
      if (i > 0 && key in barsA[i - 1] && barsA[i - 1][key] !== barsA[i][key]) moved += 1;
    }
  }
  assert.ok(compared >= 6 * (n - 1), `too few walk positions compared (${compared}) to prove anything`);
  assert.ok(moved >= 6, `the walks must actually move bar to bar (moved ${moved})`);
  // The control: the same piece UNSEEDED wanders differently at the two rng
  // seeds, so the equality above is the seed's doing, not a constant.
  const c = createEngine(spreadParams({ seeded: false }), { rng: seededRng(11) });
  const d = createEngine(spreadParams({ seeded: false }), { rng: seededRng(99) });
  const barsC = recordWalks(c);
  const barsD = recordWalks(d);
  await c.start();
  await d.start();
  await advance(barSeconds(c.getParams()) * 4);
  c.stop();
  d.stop();
  const last = Math.min(barsC.length, barsD.length) - 1;
  const differs = Object.keys(barsC[last]).some((k) => k in barsD[last] && barsC[last][k] !== barsD[last][k]);
  assert.ok(differs, 'an unseeded walk must differ between rng seeds (the control)');
}));

test('a rebuild from the recipe at another rng seed walks on along the same path', () => hiddenTab(async () => {
  const CAPTURE = 5;
  const a = createEngine(spreadParams(), { rng: seededRng(11) });
  const barsA = recordWalks(a);
  let recipe = null;
  a.on('bar', () => { if (barsA.length === CAPTURE + 1 && !recipe) recipe = a.getRecipe(); });
  await a.start();
  await advance(barSeconds(a.getParams()) * (CAPTURE + 2));
  assert.ok(recipe, 'the capture bar must have played');
  assert.ok(recipe.walks && Object.keys(recipe.walks).length >= 6, 'the recipe names the walk positions');
  assert.deepEqual(recipe.walks, Object.fromEntries(
    Object.entries(barsA[CAPTURE]).filter(([k]) => k in recipe.walks)), 'the recipe names the live positions');
  // The pen form: the recipe as text, and back, loses nothing.
  const written = recipeFromText(recipeToText(recipe));
  assert.deepEqual(written, recipe, 'the recipe (walk seeds and positions included) round-trips through text');
  assert.match(recipeToText(recipe), /^Pad walk seed: 101$/m);
  assert.match(recipeToText(recipe), /^Walk positions: \{"pad:level":/m);
  // A Blank-slate engine (no params of the piece at all) at a different rng
  // seed, rebuilt from the written recipe alone.
  const b = createEngine({}, { rng: seededRng(4242) });
  b.applyRecipe(written);
  const barsB = recordWalks(b);
  await b.start();
  await advance(barSeconds(a.getParams()) * 6);
  a.stop();
  b.stop();
  const keys = Object.keys(recipe.walks).filter((k) => SEEDED_KEY.test(k));
  // Entering bar 0 the rebuild's positions are the recipe's (queued, read as
  // live); bar 0 plays them; from there each bar of the rebuild is the next
  // bar of the original: snapshot i+1 of the rebuild is snapshot CAPTURE+i.
  for (const key of keys) assert.equal(barsB[0][key], recipe.walks[key], `${key}: queued position reads as live`);
  const span = Math.min(barsB.length - 1, barsA.length - CAPTURE);
  assert.ok(span >= 4, `enough bars to compare (${span})`);
  let moved = 0;
  for (let i = 0; i < span; i++) {
    for (const key of keys) {
      assert.equal(barsB[i + 1][key], barsA[CAPTURE + i][key],
        `rebuilt snapshot ${i + 1} ${key}: expected the original's snapshot ${CAPTURE + i}`);
      if (i > 0 && barsA[CAPTURE + i][key] !== barsA[CAPTURE + i - 1][key]) moved += 1;
    }
  }
  assert.ok(moved >= keys.length, `the rebuilt walks must move, not just start right (moved ${moved})`);
}));

test('applyRecipe lands walk positions at a barline, not mid-bar', () => hiddenTab(async () => {
  const engine = createEngine(spreadParams(), { rng: seededRng(3) });
  const resolvedLevels = [];
  engine.on('bar', () => resolvedLevels.push(engine.getResolved().tracks.pad.level));
  await engine.start();
  const bar = barSeconds(engine.getParams());
  await advance(bar * 2.5);
  const before = engine.getResolved().tracks.pad.level;
  engine.applyRecipe({ walks: { 'pad:level': 0.123 } });
  assert.equal(engine.getResolved().tracks.pad.level, before, 'mid-bar, the sounding level must not jump');
  assert.equal(engine.getRecipe().walks['pad:level'], 0.123, 'a queued position reads back as the live one');
  const count = resolvedLevels.length;
  await advance(bar * 2.5);
  assert.ok(resolvedLevels.length >= count + 2, 'two barlines must pass');
  // Event count+0 fires before the next bar's walks step: still the old bar.
  // Event count+1 reads what that bar played: the recipe's position.
  assert.equal(resolvedLevels[count], before, 'the bar already scheduled keeps its level');
  assert.ok(Math.abs(resolvedLevels[count + 1] - (0.3 + (0.9 - 0.3) * 0.123)) < 1e-12,
    `the next bar plays the recipe's position (got ${resolvedLevels[count + 1]})`);
  engine.stop();
}));

test('a held walk stands still while the rest of the track walks', () => hiddenTab(async () => {
  const params = spreadParams();
  params.tracks.bass.walkHold = ['level'];
  const engine = createEngine(params, { rng: seededRng(5) });
  const bars = recordWalks(engine);
  await engine.start();
  await advance(barSeconds(engine.getParams()) * 8);
  engine.stop();
  const held = bars.map((b) => b['bass:level']).filter((v) => v !== undefined);
  const free = bars.map((b) => b['bass:randomness']).filter((v) => v !== undefined);
  assert.ok(held.length >= 6 && free.length >= 6, 'both walks must be read');
  assert.equal(new Set(held).size, 1, `bass:level is held, yet it moved: ${held.join(', ')}`);
  assert.ok(new Set(free).size > 1, 'bass:randomness is not held and must walk');
}));

test('an unseeded piece is untouched: its walks still draw from the piece rng', () => hiddenTab(async () => {
  // Two builds at the SAME rng seed, one before any of this existed in
  // spirit: no walkSeed, no walkHold — the positions must match exactly,
  // and the recipe still names them (the secret layer is named).
  const a = createEngine(spreadParams({ seeded: false }), { rng: seededRng(8) });
  const b = createEngine(spreadParams({ seeded: false }), { rng: seededRng(8) });
  const barsA = recordWalks(a);
  const barsB = recordWalks(b);
  await a.start();
  await b.start();
  await advance(barSeconds(a.getParams()) * 4);
  a.stop();
  b.stop();
  const n = Math.min(barsA.length, barsB.length);
  assert.ok(n >= 4, `both pieces must play bars (${n})`);
  assert.deepEqual(barsB.slice(0, n), barsA.slice(0, n));
  assert.ok(Object.keys(barsA[barsA.length - 1]).length >= 6, 'the recipe names an unseeded piece\'s walks too');
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
