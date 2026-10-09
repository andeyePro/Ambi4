/**
 * The melody's motif and its development as rules — Reconstructible Ambi4,
 * "Melody motif and development as rules" (owner rulings 2026-09-25: ONE
 * logic for every rule, Now / Chance / Pool).
 *
 *   npm run build && node tests/motif-rule-smoke.mjs
 *
 * Now is `tracks.melody.motif` — the cell the piece opens on (shape, steps
 * from the chord root, onsets and lengths). Chance is `motifRule.chance` with
 * a When of phrase, section or piece — how likely a NEW cell is drawn; 0
 * holds, null is the old law. Pool is `motifRule.pool` — the developments
 * (developMotif's ops) a bar of the phrase may make, by weight or in turn;
 * null is the engine's own mix, empty states the cell plain. The suite gates
 * it at the engine: the sanitiser, the cell actually played (getResolved and
 * the note onsets), the hold across section changes, the redraw moments, the
 * development pool, and the recipe naming the opening cell. Byte-identity of
 * every stored piece is tests/audio-reference.mjs's job.
 */
import assert from 'node:assert/strict';

// Minimal AudioContext mock — the same thin shape auto-ladder-smoke.mjs uses:
// this suite reads 'bar' and 'note' events and getResolved() only.
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
const { TIME_SIGNATURES, sanitiseParams } = engineModule;
const { recipeToText, recipeFromText, RECIPE_FIELDS } = await import('../src/scripts/recipe.js');

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
 * A melody that plays every bar it can: On, Randomness 0 (no rests, no
 * ornaments, no timing nudge), swing 0, 4/4 at 120 bpm, the abab structure
 * (a new section every eight bars) and low repetition, so the old law draws a
 * new cell at almost every section change.
 */
const melodyPiece = (melody = {}, extra = {}) => ({
  bpm: 120,
  timeSignature: '4/4',
  structure: 'abab',
  complexity: 0.6,
  repetition: 0,
  swing: 0,
  ...extra,
  tracks: { melody: { state: 'on', randomness: 0, ...melody } },
});

/** Play `bars` bars; log every note and, per bar, the melody's resolved cell. */
async function play(params, seed, bars) {
  const engine = createEngine(params, { rng: seededRng(seed) });
  const notes = [];
  const barLog = [];
  engine.on('bar', (event) => {
    const resolved = engine.getResolved();
    barLog.push({ bar: event.bar, time: event.time, motif: resolved.tracks.melody.motif });
  });
  engine.on('note', (note) => notes.push(note));
  await engine.start();
  await advance(barSeconds(engine.getParams()) * (bars + 1));
  const recipe = engine.getRecipe();
  engine.stop();
  return { engine, notes, barLog, recipe };
}

const key = (cell) => (cell ? `${cell.steps.join(',')}|${cell.beats.join(',')}` : 'none');
// Only notes well inside the run: the scheduler's lookahead races the fast
// clock at the very end, so the last bar or two can differ between two runs
// for reasons that have nothing to do with the piece.
const stream = (notes, which, until) => notes
  .filter((note) => which(note.track) && note.time < until)
  .map((note) => `${note.track}:${note.midi}@${note.time.toFixed(4)}`)
  .join(' ');

/** The melody's onsets in beats from its bar's start, bar by bar. */
function melodyOnsets(notes, barLog, beatSeconds) {
  const out = new Map();
  for (const note of notes) {
    if (note.track !== 'melody') continue;
    let owner = null;
    for (const entry of barLog) if (entry.time <= note.time + 1e-9) owner = entry;
    if (!owner) continue;
    if (!out.has(owner.bar)) out.set(owner.bar, []);
    out.get(owner.bar).push(Math.round(((note.time - owner.time) / beatSeconds) * 1000) / 1000);
  }
  for (const list of out.values()) list.sort((a, b) => a - b);
  // The last two logged bars may be cut short by the end of the run.
  const last = Math.max(...barLog.map((entry) => entry.bar));
  for (const bar of [...out.keys()]) if (bar >= last - 1) out.delete(bar);
  return out;
}

const CELL = Object.freeze({ steps: [0, 4, 2], beats: [0, 1.5, 3], lengths: [1.5, 1.5, 1], shape: 'own' });

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---------------------------------------------------------------------------
// The schema: sparse, sanitised, melody only.
// ---------------------------------------------------------------------------

test('sanitise: motif and motifRule are sparse, melody-only, and null clears them', () => {
  const fresh = sanitiseParams({});
  assert.equal('motif' in fresh.tracks.melody, false, 'a fresh melody carries no motif key');
  assert.equal('motifRule' in fresh.tracks.melody, false, 'a fresh melody carries no motifRule key');

  const set = sanitiseParams({ tracks: {
    melody: { motif: CELL, motifRule: { chance: 0, when: 'phrase', pool: [{ id: 'invert', weight: 2 }], order: 'turn' } },
    bass: { motif: CELL, motifRule: { chance: 0 } },
  } });
  assert.deepEqual(set.tracks.melody.motif, { ...CELL });
  assert.deepEqual(set.tracks.melody.motifRule,
    { chance: 0, when: 'phrase', pool: [{ id: 'invert', weight: 2 }], order: 'turn' });
  assert.equal('motif' in set.tracks.bass, false, 'the bass has no motif to name');
  assert.equal('motifRule' in set.tracks.bass, false, 'the bass has no motif rule');

  const inherited = sanitiseParams({}, set);
  assert.deepEqual(inherited.tracks.melody.motif, { ...CELL }, 'an absent key inherits');
  const merged = sanitiseParams({ tracks: { melody: { motifRule: { chance: 0.5 } } } }, set);
  assert.deepEqual(merged.tracks.melody.motifRule,
    { chance: 0.5, when: 'phrase', pool: [{ id: 'invert', weight: 2 }], order: 'turn' }, 'a partial rule merges field by field');
  const cleared = sanitiseParams({ tracks: { melody: { motif: null, motifRule: null } } }, set);
  assert.equal('motif' in cleared.tracks.melody, false, 'motif: null clears');
  assert.equal('motifRule' in cleared.tracks.melody, false, 'motifRule: null clears');
});

test('sanitise: a cell is sorted, de-duplicated and clamped; a rule drops what it cannot use', () => {
  const p = sanitiseParams({ tracks: { melody: {
    motif: { steps: [9, 0, 99, 'x', 3], beats: [2, 0, 1, 1.5, 2], lengths: [1, 1, -4], shape: 'zigzag' },
    motifRule: { chance: 7, when: 'bar', pool: [{ id: 'repeat' }, { id: 'fly' }, { id: 'repeat', weight: 3 }, 'retrograde'], order: 'sideways' },
  } } });
  assert.deepEqual(p.tracks.melody.motif.beats, [0, 1, 2], 'sorted by onset, a non-number step dropped, a duplicate onset dropped');
  assert.deepEqual(p.tracks.melody.motif.steps, [0, 21, 9], 'steps follow their onsets and clamp to the step range');
  assert.deepEqual(p.tracks.melody.motif.lengths, [1, 1, 1], 'a bad length becomes the gap to the next onset (1 for the last)');
  assert.equal(p.tracks.melody.motif.shape, 'own', 'an unknown shape is the cell\'s own');
  const rule = p.tracks.melody.motifRule;
  assert.equal(rule.chance, 1);
  assert.equal(rule.when, 'section', 'a motif has no bar moment — it changes only at a phrase boundary');
  assert.equal(rule.order, 'weight');
  assert.deepEqual(rule.pool, [{ id: 'repeat', weight: 1 }, { id: 'retrograde', weight: 1 }], 'unknown and repeated ops are dropped');
  const auto = sanitiseParams({ tracks: { melody: { motifRule: { chance: null } } } });
  assert.equal(auto.tracks.melody.motifRule.pool, null, 'no pool is the engine\'s own mix (null), not an empty pool');
  assert.equal(auto.tracks.melody.motifRule.chance, null);
  const empty = sanitiseParams({ tracks: { melody: { motif: { steps: [], beats: [] } } } });
  assert.equal('motif' in empty.tracks.melody, false, 'a cell with no notes is no cell');
});

test('getParams hands the cell and the rule out as copies', () => {
  const engine = createEngine(melodyPiece({ motif: CELL, motifRule: { chance: 0, pool: [] } }), { rng: seededRng(3) });
  const out = engine.getParams();
  out.tracks.melody.motif.steps[0] = 11;
  out.tracks.melody.motifRule.pool.push({ id: 'invert', weight: 1 });
  const again = engine.getParams();
  assert.equal(again.tracks.melody.motif.steps[0], 0);
  assert.deepEqual(again.tracks.melody.motifRule.pool, []);
});

// ---------------------------------------------------------------------------
// Now: the cell the piece opens on.
// ---------------------------------------------------------------------------

test('Now: a named cell is the one the piece opens on, and the resolved readout says so', () => hiddenTab(async () => {
  const { barLog } = await play(melodyPiece({ motif: CELL }), 7, 4);
  const first = barLog.find((entry) => entry.motif);
  assert.ok(first, 'getResolved().tracks.melody.motif never reported a cell');
  assert.equal(key(first.motif), key(CELL), `the piece opened on ${key(first.motif)}, not the named cell`);
}));

test('Now: naming the cell the seed would have drawn replays the piece to the byte; another cell moves the melody', () => hiddenTab(async () => {
  const plain = await play(melodyPiece(), 21, 12);
  const opened = plain.recipe.tracks && plain.recipe.tracks.melody && plain.recipe.tracks.melody.motif;
  assert.ok(opened, 'getRecipe() did not name the cell the piece opened on');
  const same = await play(melodyPiece({ motif: opened }), 21, 12);
  assert.equal(stream(same.notes, () => true, 20), stream(plain.notes, () => true, 20),
    'naming the drawn cell must cost no draw: the whole piece replays');
  const other = await play(melodyPiece({ motif: { ...CELL, steps: [7, 3, 5] } }), 21, 12);
  assert.notEqual(stream(other.notes, (t) => t === 'melody', 20), stream(plain.notes, (t) => t === 'melody', 20),
    'a different named cell must change what the melody plays');
}));

// ---------------------------------------------------------------------------
// Chance: 0 holds, 1 redraws at its When, null is the old law.
// ---------------------------------------------------------------------------

test('Chance 0 holds the named cell for 40 bars across five section changes', () => hiddenTab(async () => {
  const held = await play(melodyPiece({ motif: CELL, motifRule: { chance: 0 } }), 5, 40);
  const cells = new Set(held.barLog.filter((e) => e.motif).map((e) => key(e.motif)));
  assert.deepEqual([...cells], [key(CELL)], `a held cell changed: ${[...cells].join(' / ')}`);
  // Not vacuous: the same piece without the rule leaves the named cell.
  const free = await play(melodyPiece({ motif: CELL }), 5, 40);
  const freeCells = new Set(free.barLog.filter((e) => e.motif).map((e) => key(e.motif)));
  assert.ok(freeCells.size > 1, 'without a rule the old law should have drawn a new cell at some section');
}));

test('Chance 1 each phrase draws a new cell at (nearly) every phrase; each section only at sections', () => hiddenTab(async () => {
  const changesOf = (log) => {
    let last = null;
    const at = [];
    for (const entry of log) {
      if (!entry.motif) continue;
      const k = key(entry.motif);
      if (last !== null && k !== last) at.push(entry.bar);
      last = k;
    }
    return at;
  };
  const phrase = await play(melodyPiece({ motif: CELL, motifRule: { chance: 1, when: 'phrase' } }), 9, 33);
  const phraseChanges = changesOf(phrase.barLog);
  assert.ok(phraseChanges.length >= 5, `chance 1 each phrase changed the cell only at bars ${phraseChanges.join(', ')}`);
  const section = await play(melodyPiece({ motif: CELL, motifRule: { chance: 1, when: 'section' } }), 9, 33);
  const sectionChanges = changesOf(section.barLog);
  assert.ok(sectionChanges.length >= 1, 'chance 1 each section never changed the cell');
  assert.ok(sectionChanges.length < phraseChanges.length,
    `each section (${sectionChanges.join(', ')}) should change less often than each phrase (${phraseChanges.join(', ')})`);
}));

test('When piece at Chance 1: the piece opens on a fresh cell instead of the named one, then holds it', () => hiddenTab(async () => {
  const { barLog } = await play(melodyPiece({ motif: CELL, motifRule: { chance: 1, when: 'piece' } }), 13, 24);
  const cells = barLog.filter((e) => e.motif).map((e) => key(e.motif));
  assert.ok(cells.length > 0, 'no cell reported');
  assert.notEqual(cells[0], key(CELL), 'a once-per-piece redraw at chance 1 must replace the named cell at the start');
  assert.equal(new Set(cells).size, 1, `after its one draw a piece rule holds the cell: ${[...new Set(cells)].join(' / ')}`);
}));

test('a rule of Chance auto and Pool auto is the old law, to the byte', () => hiddenTab(async () => {
  const plain = await play(melodyPiece(), 17, 20);
  const ruled = await play(melodyPiece({ motifRule: { chance: null, pool: null } }), 17, 20);
  assert.equal(stream(ruled.notes, () => true, 34), stream(plain.notes, () => true, 34));
}));

// ---------------------------------------------------------------------------
// Pool: what each bar of a phrase does with the cell.
// ---------------------------------------------------------------------------

test('Pool empty: every bar states the cell plain — its onsets, bar after bar', () => hiddenTab(async () => {
  const params = melodyPiece({ motif: CELL, motifRule: { chance: 0, pool: [] } });
  const { notes, barLog } = await play(params, 4, 16);
  const onsets = melodyOnsets(notes, barLog, 60 / params.bpm);
  assert.ok(onsets.size >= 8, `the melody played only ${onsets.size} bars`);
  for (const [bar, list] of onsets) {
    assert.deepEqual(list, [...CELL.beats], `bar ${bar}: onsets ${list.join(',')} are not the plain cell`);
  }
}));

test('Pool in turn [displace, repeat]: bars 1 and 3 of each phrase are pushed later, bars 0 and 2 are not', () => hiddenTab(async () => {
  const params = melodyPiece({
    motif: CELL,
    motifRule: { chance: 0, pool: [{ id: 'displace', weight: 1 }, { id: 'repeat', weight: 1 }], order: 'turn' },
  });
  const { notes, barLog } = await play(params, 4, 16);
  const onsets = melodyOnsets(notes, barLog, 60 / params.bpm);
  const first = Math.min(...onsets.keys());
  let checked = 0;
  for (const [bar, list] of onsets) {
    const phraseBar = (bar - first) % 4;
    if (phraseBar === 1 || phraseBar === 3) {
      assert.ok(list[0] > 0, `bar ${bar} (phrase bar ${phraseBar}) should be displaced, onsets ${list.join(',')}`);
    } else {
      assert.deepEqual(list, [...CELL.beats], `bar ${bar} (phrase bar ${phraseBar}) should be the plain cell`);
    }
    checked += 1;
  }
  assert.ok(checked >= 8, `only ${checked} melody bars checked`);
}));

// ---------------------------------------------------------------------------
// The recipe names it, and a rebuild at ANOTHER seed opens on the same cell.
// ---------------------------------------------------------------------------

test('recipe: the opening cell and the rule are named, round-trip through text, and rebuild at another seed', () => hiddenTab(async () => {
  const rule = { chance: 0, when: 'section', pool: [{ id: 'transpose', weight: 2.5 }, { id: 'invert', weight: 1 }], order: 'weight' };
  const original = await play(melodyPiece({ motifRule: rule }), 31, 6);
  const recipe = original.recipe;
  const opened = original.barLog.find((e) => e.motif).motif;
  assert.equal(key(recipe.tracks.melody.motif), key(opened), 'the recipe must name the cell the piece opened on');
  assert.deepEqual(recipe.tracks.melody.motifRule, rule);
  assert.ok(RECIPE_FIELDS.some((row) => row.path === 'tracks.melody.motif'), 'RECIPE_FIELDS has no motif row');
  const text = recipeToText(recipe);
  assert.match(text, /^Melody motif: \S+ steps [-\d,]+ beats [\d.,]+ lengths [\d.,]+$/m);
  assert.match(text, /^Melody motif rule: chance 0 when section order weight pool transpose:2.5,invert:1$/m);
  assert.deepEqual(recipeFromText(text), recipe, 'the recipe did not round-trip through its text');
  const auto = recipeFromText('Melody motif rule: chance auto when phrase order turn pool auto');
  assert.deepEqual(auto.tracks.melody.motifRule, { chance: null, when: 'phrase', pool: null, order: 'turn' });
  const rebuilt = await play(melodyPiece({ motif: recipe.tracks.melody.motif, motifRule: recipe.tracks.melody.motifRule }), 977, 6);
  const rebuiltOpened = rebuilt.barLog.find((e) => e.motif).motif;
  assert.equal(key(rebuiltOpened), key(opened), 'a rebuild at another seed must open on the named cell');
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
