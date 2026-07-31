/**
 * Smoke test for src/scripts/genre-compiler.js — run with:
 *   node tests/genre-smoke.mjs
 *
 * Covers the compiler as a pure module (the draws, the chord grammar, the
 * groove grammar, the kit masks, the defiance overlay) and then drives the real
 * engine with every compiled genre against a minimal AudioContext mock, which
 * is the only assertion that proves a genre actually SOUNDS: params that
 * sanitise cleanly can still compile to a silent piece.
 *
 * Two things shape the playback half, exactly as they do in engine-smoke.mjs:
 *
 *  - Staged entry: a piece starts with the pad alone and lets one more track in
 *    per bar, in TRACK_ORDER, whatever the track states say — so a genre run has
 *    to clear six bars before every track it forces on can be heard.
 *  - The fast clock (`hiddenTab`): a hidden tab widens the engine's lookahead to
 *    2.5 s, which is what makes 0.5 s clock jumps safe. Genres run as slow as
 *    40 bpm, so a twelve-bar run is a minute of audio and needs it.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// --------------------------------------------------------------------------
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
const {
  sanitiseParams,
  sequencerStepsPerBar,
  setGenreTable,
  BASS_POCKET,
  DEFAULT_PARAMS,
  HARMONY_RHYTHMS,
  HOOK_MAX_CHORDS,
  PERCUSSION_LANES,
  SCALES,
  SEQUENCER_STEP_COUNT,
  STRUCTURES,
  TIME_SIGNATURES,
  TRACK_ORDER,
  TUNED_TRACKS,
} = engineModule;

const {
  compileGenre,
  expandProgression,
  maskToLane,
  parseChordToken,
} = await import('../src/scripts/genre-compiler.js');

/** Every genre file, in slug order — the set the whole suite runs over. */
const GENRE_DIR = new URL('../src/data/genres/', import.meta.url);
const GENRES = readdirSync(GENRE_DIR)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .map((name) => JSON.parse(readFileSync(new URL(name, GENRE_DIR), 'utf8')));

// Back to twelve at v0.0.63. New Age was DELETED at v0.0.61 and that was the
// wrong shape of fix: the owner asked for genres to be hidden from the public
// list, and deleting the file breaks every share link and stored preset that
// names one. All twelve files stay; four are simply never offered (see
// HIDDEN_GENRES in index.astro).
const GENRE_COUNT = 12;

const seededRng = (seed) => () => ((seed = (seed * 48271) % 2147483647) / 2147483647);

/** Draws the LAST usable option of every weighted list and the top of every range. */
const topRng = () => 0.999999;

const bySlug = (slug) => {
  const genre = GENRES.find((entry) => entry.slug === slug);
  assert.ok(genre, `no genre file for ${slug}`);
  return genre;
};

const builtEngines = [];

function createEngine(...args) {
  const made = engineModule.createEngine(...args);
  builtEngines.push(made);
  return made;
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---------------------------------------------------------------------------
// 1. The compile pass
// ---------------------------------------------------------------------------

test('every genre file compiles, and carries its own slug', () => {
  assert.equal(GENRES.length, GENRE_COUNT, `expected ${GENRE_COUNT} genre files`);
  setGenreTable(GENRES);
  try {
    for (const genre of GENRES) {
      const params = compileGenre(genre, { rng: seededRng(11) });
      assert.equal(params.genre, genre.slug, `${genre.slug}: lost its tag`);
      assert.ok(Object.keys(SCALES).includes(params.mode), `${genre.slug}: ${params.mode}`);
      assert.ok(Object.keys(TIME_SIGNATURES).includes(params.timeSignature));
      assert.ok(STRUCTURES.includes(params.structure));
      for (const key of Object.keys(DEFAULT_PARAMS)) {
        assert.ok(key in params, `${genre.slug}: compiled params are missing ${key}`);
      }
    }
  } finally {
    setGenreTable(null);
  }
});

test('compiled params round-trip byte-clean through the sanitiser', () => {
  for (const genre of GENRES) {
    for (const seed of [1, 2, 3, 17, 99, 1234]) {
      const params = compileGenre(genre, { rng: seededRng(seed) });
      assert.equal(
        JSON.stringify(sanitiseParams(params)),
        JSON.stringify(params),
        `${genre.slug} @${seed}: the sanitiser changed the compiled params`,
      );
    }
  }
});

test('a seed replays a genre exactly; a different seed does not', () => {
  for (const genre of GENRES) {
    const first = JSON.stringify(compileGenre(genre, { rng: seededRng(4242) }));
    const again = JSON.stringify(compileGenre(genre, { rng: seededRng(4242) }));
    assert.equal(again, first, `${genre.slug}: the same seed compiled differently`);
    const other = JSON.stringify(compileGenre(genre, { rng: seededRng(777) }));
    assert.notEqual(other, first, `${genre.slug}: a different seed compiled identically`);
  }
});

test('every draw lands inside what the genre declared', () => {
  for (const genre of GENRES) {
    const essence = genre.essence;
    const modes = essence.modes.map((entry) => entry.value);
    const metres = essence.timeSignatures.map((entry) => entry.value);
    const arcs = essence.energyArc.map((entry) => entry.value);
    const rhythms = essence.chordLanguage.harmonicRhythm.map((entry) => entry.value);
    for (let seed = 1; seed <= 40; seed++) {
      const params = compileGenre(genre, { rng: seededRng(seed * 13) });
      assert.ok(modes.includes(params.mode), `${genre.slug}: mode ${params.mode}`);
      assert.ok(metres.includes(params.timeSignature), `${genre.slug}: metre ${params.timeSignature}`);
      assert.ok(arcs.includes(params.structure), `${genre.slug}: structure ${params.structure}`);
      assert.ok(rhythms.includes(params.harmony.rhythm), `${genre.slug}: rhythm ${params.harmony.rhythm}`);
      assert.ok(params.bpm >= essence.bpm[0] - 1e-6 && params.bpm <= essence.bpm[1] + 1e-6,
        `${genre.slug}: bpm ${params.bpm} outside ${essence.bpm}`);
      assert.ok(params.swing >= essence.swing[0] - 1e-6 && params.swing <= essence.swing[1] + 1e-6,
        `${genre.slug}: swing ${params.swing} outside ${essence.swing}`);
      assert.equal(params.reverbTail, essence.instrumentation.reverbTail,
        `${genre.slug}: reverb tail`);
    }
  }
});

test('the draw order is fixed: one rng call per draw, whatever a genre declares', () => {
  const count = (genre) => {
    let calls = 0;
    compileGenre(genre, { rng: () => { calls += 1; return 0.5; } });
    return calls;
  };
  // Six draws plus the progression seed; an empty genre has no substitution
  // rolls to make, so seven is the floor every compile shares.
  assert.equal(count({}), 7, 'an empty genre must still take every draw');
  assert.equal(count({ essence: { timeSignatures: [{ value: '4/4', weight: 1 }] } }), 7,
    'a single-option enum must consume its draw like any other');
  for (const genre of GENRES) {
    const rules = genre.essence.chordLanguage.substitutionRules.length;
    const calls = count(genre);
    assert.ok(calls >= 7 && calls <= 7 + rules * 8,
      `${genre.slug}: ${calls} draws is outside the fixed order plus its substitution rolls`);
  }
});

// ---------------------------------------------------------------------------
// 2. The chord grammar
// ---------------------------------------------------------------------------

test('kit softness (Energy 1c): below the midpoint velocities scale and hats thin; the low lane and everything at 0.5+ are untouched', () => {
  const genre = bySlug('techno-tools');
  const compile = (opts) => compileGenre(genre, { rng: seededRng(4242), ...opts });

  const plain = compile({});
  const atMid = compile({ kitComplexity: 0.5 });
  assert.equal(JSON.stringify(atMid), JSON.stringify(plain),
    'kitComplexity 0.5 must compile byte-identical to an unshaped compile');

  const soft = compile({ kitComplexity: 0 });
  const lanes = (params) => params.tracks.percussion.sequencers[0].steps;
  const on = (params, lane) => lanes(params)[lane].filter((s) => s.on === true);

  // The identity lane keeps every hit; the hats thin; every surviving hit is
  // quieter — and it is all IN the compiled lane, where the grid shows it.
  assert.equal(on(soft, 'low').length, on(plain, 'low').length, 'the low lane must never lose a hit');
  assert.ok(on(soft, 'high').length < on(plain, 'high').length, 'the high lane must thin at the bottom');
  assert.ok(on(soft, 'high').length >= 1, 'the first high hit always survives');
  assert.ok(on(soft, 'low')[0].vmax < on(plain, 'low')[0].vmax, 'soft kicks are quieter kicks');

  // The shaping is kit-only and draw-free: every non-percussion param is
  // identical, so the compile stream is untouched.
  const stripKit = (params) => {
    const copy = JSON.parse(JSON.stringify(params));
    delete copy.tracks.percussion;
    return JSON.stringify(copy);
  };
  assert.equal(stripKit(soft), stripKit(plain), 'kit softness must not move any other draw or param');

  // Energy 2a, the top: "possibly 8 or 16 to the floor if you started with 4."
  const inWindow = compile({ kitComplexity: 0.6 });
  assert.equal(JSON.stringify(inWindow), JSON.stringify(plain),
    'the identity window [0.5, 0.75) compiles exactly as authored');
  const doubled = compile({ kitComplexity: 0.8 });
  const flooded = compile({ kitComplexity: 0.95 });
  assert.equal(on(doubled, 'low').length, on(plain, 'low').length * 2,
    'from 0.75 the four on the floor become eight');
  assert.equal(on(flooded, 'low').length, 16, 'from 0.92 every slot of the bar kicks');
  const written = on(plain, 'low')[0].vmax;
  const inserted = lanes(doubled).low.filter((s) => s.on && s.vmax < written);
  assert.ok(inserted.length >= on(plain, 'low').length,
    'inserted hits sit under the written accents');
  assert.equal(stripKit(doubled), stripKit(plain), 'the doubling is kit-only too');

  // AUDIT FIX (finding 70): doubling requires the authored lane to BE an
  // even pulse — "8 or 16 to the floor IF you started with 4 to the floor".
  // lofi-beats' boom-bap kick is not one, and must survive the top intact.
  {
    const lofi = bySlug('lofi-beats');
    const shaped = compileGenre(lofi, { rng: seededRng(4242), kitComplexity: 0.85 });
    const plainLofi = compileGenre(lofi, { rng: seededRng(4242) });
    const low = (params, index) => params.tracks.percussion.sequencers[index].steps.low
      .map((s) => (s.on ? 'x' : '-')).join('');
    for (let g = 0; g < plainLofi.tracks.percussion.sequencers.length; g++) {
      if (!shaped.tracks.percussion.sequencers[g]) continue;
      assert.equal(low(shaped, g), low(plainLofi, g),
        `lofi groove ${g}: a non-even-pulse kick must never be doubled`);
    }
  }

  // Energy 2b: the FILL variant — one more sequencer from 0.75, visited by
  // weight, always handing straight back, crescendo on the last beat.
  const mains = plain.tracks.percussion.sequencers.length;
  assert.equal(inWindow.tracks.percussion.sequencers.length, mains,
    'no fill inside the identity window');
  const seqs = doubled.tracks.percussion.sequencers;
  assert.equal(seqs.length, mains + 1, 'from 0.75 the kit gains its fill tab');
  const fill = seqs[seqs.length - 1];
  assert.equal(fill.weights[seqs.length - 1], 0, 'the fill never repeats itself');
  assert.ok(seqs[0].weights[seqs.length - 1] > 0, 'the mains can visit the fill');
  const fullSeqs = flooded.tracks.percussion.sequencers;
  assert.ok(
    fullSeqs[0].weights[fullSeqs.length - 1] > seqs[0].weights[seqs.length - 1],
    'the fill comes oftener the higher the dial'
  );
  const midRun = fill.steps.mid.slice(12, 16).filter((s) => s.on);
  assert.ok(midRun.length >= 3, 'the fill runs on the mid lane into the barline');
  assert.ok(midRun[midRun.length - 1].vmax > midRun[0].vmax, 'and it crescendos');
});

test('chord tokens parse to mode-relative degrees, and junk is dropped', () => {
  assert.deepEqual(parseChordToken('I'), { token: 'I', degree: 0, minor: false, suffix: '' });
  assert.deepEqual(parseChordToken('vii'), { token: 'vii', degree: 6, minor: true, suffix: '' });
  assert.equal(parseChordToken('Imaj9').degree, 0);
  assert.equal(parseChordToken('Imaj9').suffix, 'maj9');
  assert.equal(parseChordToken('V13').degree, 4);
  assert.equal(parseChordToken('bII7'), null, 'accidentals are outside the vocabulary');
  assert.equal(parseChordToken(''), null);
  assert.equal(parseChordToken(42), null);
});

test('substitution rules fire at their own probability, at most once per token', () => {
  const genre = {
    essence: {
      chordLanguage: {
        progressionGrammar: ['I IV V'],
        substitutionRules: [
          { from: 'V', to: 'IV', prob: 1 },
          { from: 'IV', to: 'ii', prob: 1 },
        ],
      },
    },
  };
  const always = expandProgression(genre, () => 0);
  assert.deepEqual(always.tokens, ['I', 'ii', 'IV'],
    'each token takes one substitution; a rewritten token is not re-read');
  const never = expandProgression({
    essence: {
      chordLanguage: {
        progressionGrammar: ['I IV V'],
        substitutionRules: [{ from: 'V', to: 'IV', prob: 0 }],
      },
    },
  }, () => 0.5);
  assert.deepEqual(never.tokens, ['I', 'IV', 'V'], 'a probability-0 rule never fires');
});

test('a fallback-list seed is drawn about twice as often as a grammar-only one', () => {
  const genre = bySlug('deep-house');
  const counts = new Map();
  for (let seed = 1; seed <= 600; seed++) {
    const { seed: drawn } = expandProgression(genre, seededRng(seed * 7 + 1));
    counts.set(drawn, (counts.get(drawn) ?? 0) + 1);
  }
  const doubled = counts.get('i IV') ?? 0;          // in the grammar AND the fallback list
  const single = counts.get('i v IV v') ?? 0;       // grammar only
  assert.ok(doubled > single * 1.4,
    `a load-bearing seed drew ${doubled} against ${single} — it should weigh twice`);
});

test('the expanded progression sets the hook length and the chord colour', () => {
  // Nine-chord grammars ask for the colour buildChord only reaches at 0.7.
  const ninths = compileGenre({
    essence: {
      chordLanguage: {
        progressionGrammar: ['Imaj9 vi9 ii9 V13'], substitutionRules: [], extensionBias: 0.85,
      },
    },
  }, { rng: seededRng(5) });
  assert.ok(ninths.complexity >= 0.7, `ninth grammar compiled to ${ninths.complexity}`);
  const triads = compileGenre({
    essence: {
      chordLanguage: { progressionGrammar: ['i VII'], substitutionRules: [], extensionBias: 0.15 },
    },
  }, { rng: seededRng(5) });
  assert.ok(triads.complexity < 0.35, `triad grammar compiled to ${triads.complexity}`);

  // repetition is buildHook's law inverted: 4 chords is the tightest loop (1),
  // 8 the longest (0), and everything shorter than 4 pins at the tightest.
  const loop = (tokens) => compileGenre({
    essence: { chordLanguage: { progressionGrammar: [tokens], substitutionRules: [] } },
  }, { rng: seededRng(5) }).repetition;
  assert.equal(loop('i'), 1);
  assert.equal(loop('i VI III VII'), 1);
  assert.equal(loop('i VI III VII i VI'), 0.5);
  assert.equal(loop('i VI III VII i VI III VII'), 0);
});

test('the expanded progression reaches the engine as harmony.seed', () => {
  // The engine's slot shape: mode-relative degree, plus the colour NUDGE the
  // symbol asks for against the piece's own complexity (a ninth one step up, a
  // seventh exactly it, a plain triad one step down).
  const seedOf = (tokens, mode = 'ionian') => compileGenre({
    essence: {
      modes: [{ value: mode, weight: 1 }],
      chordLanguage: { progressionGrammar: [tokens], substitutionRules: [] },
    },
  }, { rng: seededRng(5) }).harmony.seed;

  assert.deepEqual(seedOf('I vi IV V7'), [
    { degree: 0, extension: -1 },
    { degree: 5, extension: -1 },
    { degree: 3, extension: -1 },
    { degree: 4, extension: 0 },
  ]);
  assert.deepEqual(seedOf('Imaj9 V13'), [
    { degree: 0, extension: 1 },
    { degree: 4, extension: 1 },
  ]);
  // A degree the drawn mode does not have takes the WHOLE seed with it: half a
  // progression is not the progression, and the engine walks its own loop from
  // the shape params instead — which is what every genre did before the seed.
  assert.equal(seedOf('i VI III VII', 'minorPentatonic'), null);
  assert.deepEqual(seedOf('i iv v', 'minorPentatonic'), [
    { degree: 0, extension: -1 },
    { degree: 3, extension: -1 },
    { degree: 4, extension: -1 },
  ]);
});

test('every genre emits the loop it expanded, or none at all', () => {
  for (const genre of GENRES) {
    for (const seed of [3, 41, 500, 7777]) {
      const params = compileGenre(genre, { rng: seededRng(seed) });
      // The same draw order the suite pins above: six fixed draws, then the
      // progression — so replaying the stream past the six re-expands exactly
      // the progression this compile used.
      const replay = seededRng(seed);
      for (let i = 0; i < 6; i++) replay();
      const { degrees } = expandProgression(genre, replay);
      const playable = degrees.length && degrees.length <= HOOK_MAX_CHORDS
        && degrees.every((degree) => degree < SCALES[params.mode].length);
      if (!playable) {
        assert.equal(params.harmony.seed, null,
          `${genre.slug} @${seed}: seeded a loop ${params.mode} cannot play`);
        continue;
      }
      assert.deepEqual(params.harmony.seed.map((slot) => slot.degree), degrees,
        `${genre.slug} @${seed}: the compiled seed is not the expanded progression`);
      for (const slot of params.harmony.seed) {
        assert.ok([-1, 0, 1].includes(slot.extension),
          `${genre.slug} @${seed}: extension ${slot.extension} is not a colour nudge`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 3. The groove grammar and the kit
// ---------------------------------------------------------------------------

test('a 16-step mask truncates to the metre prefix and rests everywhere else', () => {
  const mask = 'x---x---x---x--x';
  for (const metre of Object.keys(TIME_SIGNATURES)) {
    const lane = maskToLane(mask, metre);
    const slots = sequencerStepsPerBar(metre);
    assert.equal(lane.length, SEQUENCER_STEP_COUNT, `${metre}: lane length`);
    for (let i = 0; i < SEQUENCER_STEP_COUNT; i++) {
      const written = i < Math.min(slots, mask.length) && mask[i] === 'x';
      assert.equal(lane[i].on, written,
        `${metre}: slot ${i} should be ${written ? 'a hit' : 'a rest'}`);
    }
  }
  // 5/4 is the case the ruling exists for: the mask fills sixteen of its twenty
  // slots and the last four are RESTS, not the engine's `on` default.
  const wide = maskToLane('xxxxxxxxxxxxxxxx', '5/4');
  assert.ok(wide.slice(0, 16).every((step) => step.on), '5/4: the mask fills its first sixteen');
  assert.ok(wide.slice(16).every((step) => !step.on), '5/4: the slots past the mask must rest');
  // 7/8 keeps fourteen, 3/4 and 6/8 twelve.
  assert.equal(maskToLane('xxxxxxxxxxxxxxxx', '7/8').filter((step) => step.on).length, 14);
  assert.equal(maskToLane('xxxxxxxxxxxxxxxx', '6/8').filter((step) => step.on).length, 12);
  assert.equal(maskToLane('xxxxxxxxxxxxxxxx', '3/4').filter((step) => step.on).length, 12);
});

test('a fallback kit compiles to manual sequencers, one per groove', () => {
  for (const genre of GENRES) {
    const grooves = genre.fallbackLists && genre.fallbackLists.grooves;
    const params = compileGenre(genre, { rng: seededRng(23) });
    const percussion = params.tracks.percussion;
    if (!grooves) {
      assert.equal(percussion.sequencer.mode, 'auto',
        `${genre.slug}: a genre with no kit must stay on the auto path`);
      assert.equal(percussion.sequencers.length, 1);
      continue;
    }
    assert.equal(percussion.sequencers.length, grooves.length,
      `${genre.slug}: one sequencer per fallback groove`);
    for (const [i, sequencer] of percussion.sequencers.entries()) {
      assert.equal(sequencer.mode, 'manual', `${genre.slug}: groove ${i} must be manual`);
      assert.deepEqual(sequencer.weights, grooves.map(() => 1),
        `${genre.slug}: groove ${i} weights`);
      const slots = sequencerStepsPerBar(params.timeSignature);
      for (const lane of PERCUSSION_LANES) {
        const mask = grooves[i][lane] ?? '';
        const written = sequencer.steps[lane].map((step) => (step.on ? 'x' : '-')).join('');
        const expected = Array.from({ length: SEQUENCER_STEP_COUNT }, (unused, slot) => (
          slot < Math.min(slots, mask.length) && mask[slot] === 'x' ? 'x' : '-'
        )).join('');
        assert.equal(written, expected, `${genre.slug}: groove ${i} lane ${lane}`);
      }
    }
  }
});

test('a kit in an odd metre truncates rather than rescaling', () => {
  // The top-of-every-list rng picks lofi's 6/8, which is the only way a shipped
  // kit genre reaches a metre its masks were not written for.
  const params = compileGenre(bySlug('lofi-beats'), { rng: topRng });
  assert.equal(params.timeSignature, '6/8');
  const low = params.tracks.percussion.sequencer.steps.low;
  assert.equal(low.map((step) => (step.on ? 'x' : '-')).join(''), 'x------x--x---------');
  assert.ok(low.slice(12).every((step) => !step.on), 'past the metre, every slot rests');
});

test('the groove grammar sets the bass pocket against the engine\'s own ceiling', () => {
  const pocket = (slug) => compileGenre(bySlug(slug), { rng: seededRng(3) }).tracks.bass.vary.timing;
  // 0 ms means machine-tight, and four genres ask for exactly that.
  assert.equal(pocket('ambient'), 0);
  assert.equal(pocket('minimalism'), Math.round(1.5 / 1000 / BASS_POCKET * 1000) / 1000);
  // Lofi's 12–22 ms drag is most of the engine's 22 ms lay-back.
  assert.equal(pocket('lofi-beats'), Math.round(17 / 1000 / BASS_POCKET * 1000) / 1000);
  assert.ok(pocket('lofi-beats') > pocket('bossa'), 'lofi drags further behind than bossa');
});

test('densityBias reaches every track that reads one, and the pad none', () => {
  for (const genre of GENRES) {
    const params = compileGenre(genre, { rng: seededRng(31) });
    const bias = genre.essence.densityBias;
    assert.equal(params.tracks.pad.density, null, `${genre.slug}: the pad has no event rate`);
    for (const name of ['melody', 'texture', 'arp']) {
      assert.equal(params.tracks[name].density, bias, `${genre.slug}: ${name} density`);
    }
    // The bass and the kit are the two the groove grammar moves off the bias.
    for (const name of ['bass', 'percussion']) {
      const density = params.tracks[name].density;
      assert.ok(typeof density === 'number' && density >= 0 && density <= 2,
        `${genre.slug}: ${name} density ${density}`);
    }
    const hasKit = Boolean(genre.fallbackLists && genre.fallbackLists.grooves);
    if (hasKit) {
      assert.equal(params.tracks.percussion.density, bias,
        `${genre.slug}: a manual kit takes the bias unchanged`);
    }
  }
});

test('dissonanceRange ships as a drifting band on the tuned tracks', () => {
  for (const genre of GENRES) {
    const [lo, hi] = genre.essence.dissonanceRange;
    const params = compileGenre(genre, { rng: seededRng(37) });
    for (const name of TRACK_ORDER) {
      const track = params.tracks[name];
      if (!TUNED_TRACKS.includes(name)) {
        assert.equal(track.dissonance, undefined, `${genre.slug}: ${name} is not tuned`);
        continue;
      }
      if (lo === hi) assert.equal(track.dissonance, lo, `${genre.slug}: ${name} dissonance`);
      else assert.deepEqual(track.dissonance, { min: lo, max: hi }, `${genre.slug}: ${name}`);
    }
  }
});

test('instrumentation passes through: state, voice, level, randomness, patches', () => {
  for (const genre of GENRES) {
    const perTrack = genre.essence.instrumentation.perTrack;
    const params = compileGenre(genre, { rng: seededRng(41) });
    for (const [name, spec] of Object.entries(perTrack)) {
      const track = params.tracks[name];
      assert.equal(track.state, spec.state, `${genre.slug}: ${name} state`);
      assert.equal(track.voice, spec.voice, `${genre.slug}: ${name} voice`);
      assert.deepEqual(track.level, spec.level, `${genre.slug}: ${name} level`);
      assert.deepEqual(track.randomness, spec.randomness, `${genre.slug}: ${name} randomness`);
    }
    const patches = genre.essence.instrumentation.patches;
    if (!patches) {
      assert.deepEqual(params.patches, {}, `${genre.slug}: no patch bank was declared`);
      continue;
    }
    for (const [track, bank] of Object.entries(patches)) {
      for (const [voice, patch] of Object.entries(bank)) {
        const compiled = params.patches[track] && params.patches[track][voice];
        assert.ok(compiled, `${genre.slug}: lost the ${track}/${voice} patch`);
        for (const [section, fields] of Object.entries(patch)) {
          if (section === 'perKind') continue;
          for (const [field, value] of Object.entries(fields)) {
            assert.deepEqual(compiled[section][field], value,
              `${genre.slug}: ${track}/${voice} ${section}.${field}`);
          }
        }
      }
    }
  }
});

/**
 * v27 — the voicing rules the owner's blind-test complaint turned into
 * acceptance criteria: every genre names voices that exist, no two genres wear
 * the same front line, and no genre's bass is loud or loose enough to wander
 * over the bar.
 */
const { VOICES } = await import('../src/scripts/engine-voices.js');

test('v27: every voice a genre names exists in the library', () => {
  for (const genre of GENRES) {
    for (const [name, spec] of Object.entries(genre.essence.instrumentation.perTrack)) {
      assert.ok(VOICES[name] && VOICES[name][spec.voice],
        `${genre.slug}: ${name} names a voice the library does not have (${spec.voice})`);
    }
    const patches = genre.essence.instrumentation.patches;
    if (!patches) continue;
    for (const [track, bank] of Object.entries(patches)) {
      for (const voice of Object.keys(bank)) {
        assert.ok(VOICES[track] && VOICES[track][voice],
          `${genre.slug}: a patch is keyed to a voice that does not exist (${track}/${voice})`);
      }
    }
  }
});

test('v27: no two genres share the same pad/bass/melody line-up', () => {
  const seen = new Map();
  for (const genre of GENRES) {
    const t = genre.essence.instrumentation.perTrack;
    const key = [t.pad.voice, t.bass.voice, t.melody.voice].join('/');
    assert.ok(!seen.has(key),
      `${genre.slug} and ${seen.get(key)} both voice ${key} — a blind listener cannot tell them apart`);
    seen.set(key, genre.slug);
  }
});

test('v27: the bass is held back everywhere — level 0.55–0.68, randomness under 0.3', () => {
  for (const genre of GENRES) {
    const bass = genre.essence.instrumentation.perTrack.bass;
    const levels = typeof bass.level === 'number' ? [bass.level] : [bass.level.min, bass.level.max];
    for (const level of levels) {
      assert.ok(level >= 0.55 && level <= 0.68,
        `${genre.slug}: bass level ${level} is outside the 0.55–0.68 band`);
    }
    const rand = typeof bass.randomness === 'number'
      ? [bass.randomness]
      : [bass.randomness.min, bass.randomness.max];
    for (const value of rand) {
      assert.ok(value >= 0.1 && value <= 0.3,
        `${genre.slug}: bass randomness ${value} lets the riff wander`);
    }
  }
});

test('v27: the genres whose bass IS the hook compile that bass on and audible', () => {
  for (const slug of ['acid-jazz', 'deep-house', 'synthwave', 'techno-tools']) {
    const params = compileGenre(bySlug(slug), { rng: seededRng(7) });
    assert.equal(params.tracks.bass.state, 'on', `${slug}: its signature bass is not forced on`);
    assert.ok(params.tracks.bass.level >= 0.66,
      `${slug}: a signature bass at ${params.tracks.bass.level} is not the hook`);
  }
});

test('ambient compiles its bass off and its percussion beatless', () => {
  const params = compileGenre(bySlug('ambient'), { rng: seededRng(13) });
  assert.equal(params.tracks.bass.state, 'off', 'ambient ships bass off — the user ruling');
  assert.equal(params.tracks.percussion.state, 'off');
  assert.equal(params.tracks.pad.state, 'on');
  assert.equal(params.tracks.percussion.sequencer.mode, 'auto', 'ambient declares no kit');
  assert.equal(params.reverbTail, 4.5);
});

// ---------------------------------------------------------------------------
// 4. The defiance dials
// ---------------------------------------------------------------------------

test('every dial of every genre reaches both of its endpoints', () => {
  const read = (params, path) => path.split('.').reduce(
    (node, key) => (node === undefined || node === null ? undefined : node[key]), params,
  );
  for (const genre of GENRES) {
    for (const dial of genre.defiance) {
      const low = compileGenre(genre, { rng: seededRng(9), defiance: { [dial.param]: 0 } });
      const high = compileGenre(genre, { rng: seededRng(9), defiance: { [dial.param]: 1 } });
      const first = dial.range[0];
      const last = dial.range[dial.range.length - 1];
      if (typeof first === 'string') {
        assert.equal(read(low, dial.param), first, `${genre.slug}: ${dial.param} at 0`);
        assert.equal(read(high, dial.param), last, `${genre.slug}: ${dial.param} at 1`);
        continue;
      }
      assert.equal(read(low, dial.param), first, `${genre.slug}: ${dial.param} at 0`);
      assert.equal(read(high, dial.param), last, `${genre.slug}: ${dial.param} at 1`);
      const middle = read(
        compileGenre(genre, { rng: seededRng(9), defiance: { [dial.param]: 0.5 } }),
        dial.param,
      );
      assert.ok(middle >= Math.min(first, last) && middle <= Math.max(first, last),
        `${genre.slug}: ${dial.param} midpoint ${middle} left its range`);
    }
  }
});

test('a numeric dial on an enumerated param snaps to a value the engine takes', () => {
  const genre = bySlug('minimalism');   // harmony.rhythm, 8 → 1
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    const params = compileGenre(genre, { rng: seededRng(19), defiance: { 'harmony.rhythm': t } });
    assert.ok(HARMONY_RHYTHMS.includes(params.harmony.rhythm),
      `position ${t} compiled harmony.rhythm ${params.harmony.rhythm}`);
  }
  assert.equal(compileGenre(genre, { rng: seededRng(19), defiance: { 'harmony.rhythm': 0 } })
    .harmony.rhythm, 8);
  assert.equal(compileGenre(genre, { rng: seededRng(19), defiance: { 'harmony.rhythm': 1 } })
    .harmony.rhythm, 1);
});

test('the defiance overlay lands last, clamps its positions and ignores strangers', () => {
  const genre = bySlug('ambient');
  const plain = compileGenre(genre, { rng: seededRng(77) });
  const defied = compileGenre(genre, { rng: seededRng(77), defiance: { bpm: 1 } });
  assert.equal(defied.bpm, 108, 'the dial beats the genre\'s own bpm draw');
  assert.ok(plain.bpm <= 62, 'the undefied draw stays inside the genre band');
  // Everything the dial does not name is untouched, so an overlay is surgical.
  assert.equal(JSON.stringify({ ...defied, bpm: plain.bpm }), JSON.stringify(plain));

  const over = compileGenre(genre, { rng: seededRng(77), defiance: { bpm: 4 } });
  assert.equal(over.bpm, 108, 'a position past 1 clamps to the defiant end');
  const under = compileGenre(genre, { rng: seededRng(77), defiance: { bpm: -3 } });
  assert.equal(under.bpm, 62, 'a position below 0 clamps to the genre\'s own end');

  const stranger = compileGenre(genre, {
    rng: seededRng(77),
    defiance: { 'tracks.melody.level': 1, volume: 0, nonsense: 1, bpm: null },
  });
  assert.equal(JSON.stringify(stranger), JSON.stringify(plain),
    'a key that names no dial of this genre changes nothing');
});

test('a patch-path dial reaches into the genre\'s own patch bank', () => {
  const genre = bySlug('techno-tools');
  const dirty = compileGenre(genre, {
    rng: seededRng(5), defiance: { 'patches.bass.acid.source.fold': 1 },
  });
  assert.equal(dirty.patches.bass.acid.source.fold, 0.7);
  // The rest of the patch survives the overlay untouched.
  assert.equal(dirty.patches.bass.acid.filter.cutoff, 520);
  assert.equal(dirty.patches.bass.acid.adsr.decay, 0.12);
});

// ---------------------------------------------------------------------------
// 5. The engine, playing every genre
// ---------------------------------------------------------------------------

test('every genre plays: the tracks it forces on sound, the ones it kills stay silent',
  () => hiddenTab(async () => {
    for (const genre of GENRES) {
      const params = compileGenre(genre, { rng: seededRng(2026) });
      const forced = Object.entries(genre.essence.instrumentation.perTrack);
      // The per-bar generators are the ones a genre can be held to: the
      // melodic decorators are density draws and may sit a passage out.
      const owed = forced
        .filter(([name, spec]) => spec.state === 'on'
          && ['pad', 'bass', 'percussion', 'arp'].includes(name))
        .map(([name]) => name);
      const heard = new Set();
      // Up to three streams, and only as many as it takes: even a per-bar
      // generator draws its density, so ONE unlucky stream can leave a sparse
      // auto arp silent for twelve bars — which says nothing about whether the
      // genre plays it. The silence assertion below is not a lottery and is
      // therefore made on every run: a killed track that sounds even once is a
      // failure, and more runs only make that check stronger.
      for (let attempt = 0; attempt < 3; attempt++) {
        const engine = createEngine(params, { rng: seededRng(square(genre.slug) + attempt) });
        const log = record(engine);
        await engine.start();
        // Twelve bars: six for the staged entry, six for every track to speak.
        const seconds = barSeconds(params) * 13;
        await advance(seconds, FAST);
        engine.stop();

        const sounded = new Set(log.notes.map((note) => note.track));
        assert.ok(log.notes.length > 0, `${genre.slug}: silence over ${seconds.toFixed(0)} s`);
        assert.ok(log.bars.length >= 7, `${genre.slug}: only ${log.bars.length} bars`);
        for (const [name, spec] of forced) {
          if (spec.state === 'off') {
            assert.ok(!sounded.has(name), `${genre.slug}: ${name} is off and sounded anyway`);
          }
        }
        for (const name of sounded) heard.add(name);
        if (owed.every((name) => heard.has(name))) break;
      }
      for (const name of owed) {
        assert.ok(heard.has(name),
          `${genre.slug}: ${name} is on but never sounded (heard: ${[...heard]})`);
      }
    }
  }));

test('a compiled genre survives the engine round-trip and keeps its tag', () => hiddenTab(async () => {
  setGenreTable(GENRES);
  try {
    const params = compileGenre(bySlug('deep-house'), { rng: seededRng(64) });
    const engine = createEngine(params, { rng: seededRng(64) });
    await engine.start();
    const back = engine.getParams();
    assert.equal(back.genre, 'deep-house');
    assert.equal(JSON.stringify(back), JSON.stringify(params),
      'the engine changed the compiled params on the way in');
    engine.stop();
  } finally {
    setGenreTable(null);
  }
}));

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** One bar of a compiled piece, in seconds — how long a run has to be driven. */
function barSeconds(params) {
  const beats = { '3/4': 3, '4/4': 4, '5/4': 5, '6/8': 3, '7/8': 3.5 }[params.timeSignature] ?? 4;
  return (60 / (params.bpm * params.speed)) * beats;
}

/** A stable per-genre seed, so a failure names the same piece every run. */
function square(slug) {
  let hash = 7;
  for (const char of slug) hash = (hash * 31 + char.charCodeAt(0)) % 2147483647;
  return hash || 7;
}

const FAST = { step: 0.5, sleep: 6 };

async function advance(seconds, { step = 0.08, sleep = 15 } = {}) {
  const steps = Math.ceil(seconds / step);
  for (let i = 0; i < steps; i++) {
    for (const ctx of liveContexts) ctx.currentTime += step;
    await new Promise((resolve) => setTimeout(resolve, sleep));
  }
}

/** Run `fn` with the tab reported hidden, which widens the engine's lookahead. */
async function hiddenTab(fn) {
  globalThis.document = { hidden: true, addEventListener() {} };
  try {
    return await fn();
  } finally {
    delete globalThis.document;
  }
}

/** Subscribe to an engine's note/bar stream. */
function record(engine) {
  const notes = [];
  const bars = [];
  engine.on('note', (note) => notes.push(note));
  engine.on('bar', (bar) => bars.push(bar));
  return { notes, bars };
}

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
console.log(`\n${tests.length - failures}/${tests.length} passed`);
process.exit(failures ? 1 : 0);
