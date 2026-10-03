/**
 * v0.0.203 — the bass groove as a rule (TODO.md "Reconstructible Ambi4":
 * "Bass groove as rules — buildBassGroove feel, articulation, anchor lock and
 * the syncopation cell drawn").
 *
 *   npm run build && node tests/groove-rule-smoke.mjs
 *
 * Until now buildBassGroove drew its four choices in secret, once per
 * statement of the groove, and nothing could name, hold or rebuild them.
 * `tracks.bass.grooveRule = { now, chance, when, pool, order }` is the same
 * Now / Chance / Pool logic the voice rule shipped: Now the four choices
 * playing, Chance null = the engine's own law (redrawn at every restatement),
 * 0 = hold, above 0 = the odds of a pool redraw at each When. Sparse: no rule
 * is the old stream to the byte (tests/audio-reference.mjs holds that line
 * for stored pieces; this suite holds it for an Auto rule too).
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
const { TIME_SIGNATURES, buildBassGroove, BASS_CELL_NAMES } = engineModule;
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

/**
 * A generated bass over a kit, under the 'waves' structure — whose intensity
 * moves every bar, so the engine's own law restates (and redraws) the groove
 * as the energy band moves. That is what makes "held" mean something here.
 */
function grooveParams(bassExtra = {}) {
  return {
    structure: 'waves',
    complexity: 0.6,
    tracks: {
      bass: { state: 'on', ...bassExtra },
      percussion: { state: 'on' },
    },
  };
}

/** Play `bars` bars; log the resolved groove and the bass notes per bar. */
async function play(params, seed, bars, { onBar } = {}) {
  const engine = createEngine(params, { rng: seededRng(seed) });
  const grooves = [];
  const notes = [];
  engine.on('bar', (bar) => {
    const r = engine.getResolved();
    grooves.push({ bar: bar.bar, groove: r.tracks.bass.groove ? JSON.stringify(r.tracks.bass.groove) : null });
    if (onBar) onBar(engine, bar);
  });
  engine.on('note', (note) => {
    if (note.track === 'bass') notes.push(`${note.midi}@${note.time.toFixed(5)}:${note.velocity.toFixed(4)}`);
  });
  await engine.start();
  await advance(barSeconds(engine.getParams()) * (bars + 1));
  engine.stop();
  return { engine, grooves, notes };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const NOW = { feel: 'staccato', articulation: 'shortLong', anchor: 'kick', cells: ['straddle'] };

// ---------------------------------------------------------------------------
// The schema: sparse, bass-only, sanitised, carried by getParams.
// ---------------------------------------------------------------------------

test('sanitise: grooveRule is sparse, bass-only, and cleaned field by field', () => {
  const fresh = engineModule.sanitiseParams({});
  assert.equal('grooveRule' in fresh.tracks.bass, false, 'a fresh bass carries no rule');

  const other = engineModule.sanitiseParams({ tracks: { melody: { grooveRule: { chance: 0 } } } });
  assert.equal('grooveRule' in other.tracks.melody, false, 'only the bass has a groove rule');

  const set = engineModule.sanitiseParams({ tracks: { bass: { grooveRule: {
    now: { feel: 'held', articulation: 'nope', anchor: 'own', cells: ['and', 'bogus', 'push', 'pickup'] },
    chance: 7, when: 'whenever', order: 'turn',
    pool: [{ feel: 'mixed', weight: -2 }, { nothing: true }, 'x', { cells: [], weight: 3 }],
  } } } });
  assert.deepEqual(set.tracks.bass.grooveRule, {
    now: { feel: 'held', anchor: 'own', cells: ['and', 'push'] },
    chance: 1,
    when: 'section',
    pool: [{ feel: 'mixed', weight: 1 }, { cells: [], weight: 3 }],
    order: 'turn',
  });

  const merged = engineModule.sanitiseParams({ tracks: { bass: { grooveRule: { chance: 0 } } } }, set);
  assert.deepEqual(merged.tracks.bass.grooveRule.now, set.tracks.bass.grooveRule.now, 'a partial rule merges with the stored one');
  assert.equal(merged.tracks.bass.grooveRule.chance, 0);

  const cleared = engineModule.sanitiseParams({ tracks: { bass: { grooveRule: null } } }, set);
  assert.equal('grooveRule' in cleared.tracks.bass, false, 'null clears the rule');
});

test('getParams: carries the rule as a deep copy (a share link or preset holds it exactly)', () => {
  const rule = { now: NOW, chance: 0.25, when: 'bar', pool: [{ ...NOW, weight: 2 }], order: 'weight' };
  const engine = createEngine({ tracks: { bass: { grooveRule: rule } } }, { rng: seededRng(1) });
  const out = engine.getParams();
  assert.deepEqual(out.tracks.bass.grooveRule, rule);
  out.tracks.bass.grooveRule.now.cells.push('push');
  out.tracks.bass.grooveRule.pool[0].feel = 'held';
  assert.deepEqual(engine.getParams().tracks.bass.grooveRule, rule, 'getParams must not hand out live references');
  const unset = createEngine({}, { rng: seededRng(1) }).getParams();
  assert.equal('grooveRule' in unset.tracks.bass, false, 'an unset rule reads back with no key');
});

// ---------------------------------------------------------------------------
// buildBassGroove: the choice replaces the draw, and nothing else moves.
// ---------------------------------------------------------------------------

test('buildBassGroove: a choice names feel, articulation, anchor and cells; the realised choice comes back', () => {
  const opts = { starts: [0, 1, 2, 3], beats: 4, intensity: 0.7, complexity: 0.7, lowLane: [0, 2] };
  for (let seed = 1; seed <= 40; seed++) {
    const drawn = buildBassGroove({ ...opts, rng: seededRng(seed) });
    assert.ok(drawn.choice, 'the groove reports the choice it realised');
    assert.equal(drawn.feel, drawn.choice.feel);
    // Feeding the realised choice back at the same seed is the same groove, to the byte.
    const again = buildBassGroove({ ...opts, rng: seededRng(seed), choice: drawn.choice });
    assert.deepEqual(again, drawn, `seed ${seed}: the realised choice replays byte-identical`);
    const forced = buildBassGroove({ ...opts, rng: seededRng(seed), choice: NOW });
    assert.equal(forced.choice.feel, 'staccato');
    assert.equal(forced.choice.articulation, 'shortLong');
    assert.ok(forced.choice.cells.every((cell) => cell === 'straddle'), 'every hung cell is the named figure');
  }
  assert.deepEqual([...BASS_CELL_NAMES], ['and', 'push', 'pickup', 'straddle']);
});

test('buildBassGroove: anchor own ignores the kick; cells [] hangs no syncopation', () => {
  const opts = { starts: [0, 1, 2, 3], beats: 4, intensity: 1, complexity: 1, lowLane: [0, 2, 2.5] };
  let lockedOffPulse = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const kick = buildBassGroove({ ...opts, rng: seededRng(seed), choice: { anchor: 'kick', cells: [] } });
    const own = buildBassGroove({ ...opts, rng: seededRng(seed), choice: { anchor: 'own', cells: [] } });
    if (kick.steps.some((step) => step.beat === 2.5)) lockedOffPulse += 1;
    assert.ok(!own.steps.some((step) => step.beat === 2.5), `seed ${seed}: an own anchor never takes the kick's off-pulse onset`);
    assert.deepEqual(own.choice.cells, []);
    assert.ok(own.steps.every((step) => Number.isInteger(step.beat)), `seed ${seed}: no cell means no off-pulse note`);
  }
  assert.ok(lockedOffPulse > 20, `the kick lock should take the 2.5 onset most of the time (took ${lockedOffPulse}/40)`);
});

// ---------------------------------------------------------------------------
// The engine: Auto is the old law, Hold holds, Now edits land at the next bar.
// ---------------------------------------------------------------------------

test('unset and an empty Auto rule play the SAME stream (sparse: stored pieces unmoved)', () => hiddenTab(async () => {
  const a = await play(grooveParams(), 5, 24);
  const b = await play(grooveParams({ grooveRule: { chance: null } }), 5, 24);
  assert.ok(a.notes.length > 30, `the bass should play (${a.notes.length} notes)`);
  assert.deepEqual(b.notes, a.notes);
  const distinct = new Set(a.grooves.map((g) => g.groove).filter(Boolean));
  assert.ok(distinct.size >= 2, `under the engine's own law the groove should be redrawn at least once over 24 waves bars (saw ${distinct.size})`);
}));

test('Chance 0 holds Now for good, across every restatement', () => hiddenTab(async () => {
  const { grooves, notes } = await play(grooveParams({ grooveRule: { now: NOW, chance: 0 } }), 5, 24);
  assert.ok(notes.length > 30);
  const played = grooves.map((g) => g.groove).filter(Boolean);
  assert.ok(played.length >= 20, `the groove should be read on most bars (${played.length})`);
  for (const g of played) {
    const choice = JSON.parse(g);
    assert.equal(choice.feel, NOW.feel);
    assert.equal(choice.articulation, NOW.articulation);
    assert.equal(choice.anchor, NOW.anchor);
    assert.ok(choice.cells.every((cell) => cell === 'straddle'));
  }
}));

test('Auto with a Now: the piece OPENS on Now, then the engine redraws as it always did', () => hiddenTab(async () => {
  const { grooves } = await play(grooveParams({ grooveRule: { now: { feel: 'held', articulation: 'even' }, chance: null } }), 5, 24);
  const played = grooves.map((g) => g.groove).filter(Boolean).map((g) => JSON.parse(g));
  assert.equal(played[0].feel, 'held');
  assert.equal(played[0].articulation, 'even');
  assert.ok(played.some((c) => c.feel !== 'held' || c.articulation !== 'even'), 'Auto lets the engine redraw after the opening');
}));

test('a Now edit mid-piece is heard from the next bar, not mid-bar', () => hiddenTab(async () => {
  const at = 6;
  let editedAt = null;
  const { grooves } = await play(grooveParams({ grooveRule: { now: { feel: 'held' }, chance: 0 } }), 7, 12, {
    onBar: (engine, bar) => {
      if (bar.bar === at) {
        engine.setParams({ tracks: { bass: { grooveRule: { now: { feel: 'staccato', articulation: 'longShort' } } } } });
        editedAt = bar.bar;
      }
    },
  });
  assert.equal(editedAt, at);
  const after = grooves.filter((g) => g.bar > at + 1 && g.groove).map((g) => JSON.parse(g.groove));
  assert.ok(after.length >= 3);
  for (const c of after) {
    assert.equal(c.feel, 'staccato');
    assert.equal(c.articulation, 'longShort');
  }
  const before = grooves.filter((g) => g.bar < at && g.groove).map((g) => JSON.parse(g.groove));
  assert.ok(before.every((c) => c.feel === 'held'), 'before the edit the held Now plays');
}));

test('Chance 1 each bar, Pool in turn: the groove walks the pool in order', () => hiddenTab(async () => {
  const pool = [
    { feel: 'held', articulation: 'even', anchor: 'kick', cells: ['and'], weight: 1 },
    { feel: 'staccato', articulation: 'holdOne', anchor: 'own', cells: ['push'], weight: 1 },
  ];
  const { grooves } = await play(grooveParams({ grooveRule: { chance: 1, when: 'bar', order: 'turn', pool } }), 9, 10);
  const feels = grooves.map((g) => g.groove).filter(Boolean).map((g) => JSON.parse(g).feel);
  assert.ok(feels.length >= 6);
  for (let i = 1; i < feels.length; i++) assert.notEqual(feels[i], feels[i - 1], `bar ${i}: in turn alternates (${feels.join(' ')})`);
}));

test('Chance 0 with an empty Pool spends no draw and changes nothing it holds (the Blank slate rule)', () => hiddenTab(async () => {
  const a = await play(grooveParams({ grooveRule: { now: NOW, chance: 0, pool: [] } }), 3, 12);
  const b = await play(grooveParams({ grooveRule: { now: NOW, chance: 0, pool: [{ feel: 'held', weight: 1 }] } }), 3, 12);
  assert.deepEqual(b.notes, a.notes, 'a held rule never consults its pool');
}));

// ---------------------------------------------------------------------------
// The recipe names the groove: Now is the realised opening, and it rebuilds.
// ---------------------------------------------------------------------------

test('getRecipe names the groove rule with the realised opening as Now; a rebuild at ANOTHER seed opens on it', () => hiddenTab(async () => {
  const original = await play(grooveParams(), 11, 6);
  const recipe = original.engine.getRecipe();
  const rule = recipe.tracks.bass.grooveRule;
  assert.ok(rule, 'the recipe names the groove rule');
  assert.equal(rule.chance, null, 'no rule set is the engine law: Chance auto');
  assert.ok(rule.now && rule.now.feel && rule.now.articulation && rule.now.anchor && Array.isArray(rule.now.cells),
    `Now names all four choices: ${JSON.stringify(rule.now)}`);
  const firstOriginal = original.grooves.find((g) => g.groove).groove;
  assert.deepEqual(JSON.parse(firstOriginal), rule.now, 'Now is the groove the piece opened on');

  const rebuilt = await play({ ...grooveParams(), ...recipe }, 9999, 2);
  const firstRebuilt = rebuilt.grooves.find((g) => g.groove).groove;
  assert.deepEqual(JSON.parse(firstRebuilt), rule.now, 'a different seed opens on the same groove');
}));

test('recipe text: the groove rule round-trips through recipeToText / recipeFromText', () => {
  const rules = [
    { now: NOW, chance: 0.5, when: 'bar', pool: [{ ...NOW, weight: 2 }, { feel: 'held', cells: [], weight: 1 }], order: 'turn' },
    { chance: null, when: 'section', pool: [], order: 'weight' },
    { now: { feel: 'mixed', articulation: 'even', anchor: 'own', cells: [] }, chance: 0, when: 'piece', pool: [], order: 'weight' },
  ];
  for (const rule of rules) {
    const recipe = { tracks: { bass: { grooveRule: rule } } };
    const text = recipeToText(recipe);
    assert.match(text, /^Bass groove rule: now /m);
    assert.deepEqual(recipeFromText(text), recipe, text);
  }
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
