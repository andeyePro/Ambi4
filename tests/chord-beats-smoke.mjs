/**
 * Chord length in BEATS — `harmony.beats` (TODO "Chord length in BEATS"). Run:
 *
 *   node tests/chord-beats-smoke.mjs
 *
 * Harmony used to advance once per BAR: every track planned a whole bar
 * against one chord. `harmony.beats` (sparse, opt-in) makes the frame sub-bar:
 * the barline starts a chord and the hook advances again every `beats` beats
 * inside it, and every pitched scheduler reads the chord in force AT ITS
 * NOTE'S BEAT. Nobody here can hear, so this suite measures it off the
 * engine's own 'chord' and 'note' events:
 *
 *   - beats 2 in 4/4 announces two chords a bar, at beats 1 and 3, and they
 *     differ (a four-root loop);
 *   - every pad note is a tone of the chord in force, every chord is struck in
 *     full, and no pad note rings past the next chord's onset;
 *   - every bass note is the root or fifth of ITS chord, and the bass note on a
 *     chord change is the root at least three times in four; every melody
 *     note of a held root-cell is the root of its own chord; every arp note is
 *     a tone of its own chord;
 *   - the remainder rule: the barline restarts the grid (3 in 4/4 is 0 and 3);
 *   - beats >= the bar is rhythm 1, note for note;
 *   - absent is the pre-feature engine to the byte (digests taken on v0.0.238);
 *   - the bass approach leans into a MID-BAR change as it does into a barline
 *     (red on v0.0.241, which leaned only into the next bar's first chord);
 *   - sampling 'chord' under the field is bar sampling, value for value — a
 *     walk is one number a bar, so it cannot step at a mid-bar chord (a pin
 *     of v0.0.241's behaviour, not a change).
 *
 * Red on the pre-feature engine: no HARMONY_BEATS_MAX, no beats key, one chord
 * event a bar.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// --------------------------------------------------------------------------
// Minimal AudioContext mock — the thin shape auto-ladder-smoke.mjs uses; this
// suite reads 'bar', 'note' and 'chord' events only.
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

const seededRng = (seed) => () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
const builtEngines = [];
function createEngine(...args) {
  const made = engineModule.createEngine(...args);
  builtEngines.push(made);
  return made;
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


const BPM = 120;
const SEC_PER_BEAT = 60 / BPM;
const STILL = { voice: 0, volume: 0, pitch: 0, timing: 0, pan: 0 };
const BARS = 12;

// A named melody cell of chord ROOTS (degree 0, relative to the chord) held
// by its rule — Chance 0, an empty pool states it plain — so every melody note
// is the root of the chord it is planned against, and nothing else.
const ROOT_CELL = { steps: [0, 0, 0, 0], beats: [0, 1, 2, 3], lengths: [0.9, 0.9, 0.9, 0.9] };

/**
 * The fixture: pad, bass, melody and arp, nothing humanised, no dissonance,
 * a four-chord loop with four different roots, held (repetition 1) so the
 * hook does not mutate under the test. `harmony` merges over it.
 */
function fixture(harmony = {}, extra = {}) {
  const on = (more = {}) => ({ state: 'on', randomness: 0, vary: STILL, dissonance: 0, ...more });
  return {
    bpm: BPM,
    timeSignature: '4/4',
    swing: 0,
    complexity: 0,
    repetition: 1,
    root: 'C',
    mode: 'ionian',
    structure: 'drone',
    harmony: { seed: ['I', 'IV', 'V', 'vi'], rhythm: 1, ...harmony },
    arp: { mode: 'manual', pattern: 'up', rate: '1/8', octaves: 1, gate: 0.6 },
    tracks: {
      pad: on(),
      bass: on(),
      melody: on({ motif: ROOT_CELL, motifRule: { chance: 0, when: 'phrase', pool: [], order: 'weight' } }),
      arp: on({
        sequencers: [{ mode: 'manual', hand: true,
          steps: Array.from({ length: 16 }, () => ({ on: true, prob: 1, vmin: 0.6, vmax: 0.6 })) }],
      }),
      texture: { state: 'off' },
      percussion: { state: 'off' },
    },
    ...extra,
  };
}

async function play(params, bars = BARS, seed = 11) {
  const engine = createEngine(params, { rng: seededRng(seed) });
  const notes = [];
  const chords = [];
  const barStarts = [];
  engine.on('bar', (event) => { barStarts[event.bar] = event.time; });
  engine.on('note', (note) => { if (!note.live) notes.push(note); });
  engine.on('chord', (chord) => chords.push(chord));
  await engine.start();
  await advance(4 * SEC_PER_BEAT * (bars + 1));
  engine.stop();
  // Only the bars wholly scheduled before stop(): how far the scheduler got
  // past them depends on timer interleaving, so the tail is not evidence.
  const end = barStarts[0] + bars * 4 * SEC_PER_BEAT * (params.timeSignature === '3/4' ? 0.75 : 1) - 1e-6;
  chords.sort((a, b) => a.time - b.time);
  return {
    engine,
    bars,
    notes: notes.filter((n) => n.time < end),
    chords: chords.filter((c) => c.time < end),
    barStarts: barStarts.slice(0, bars),
  };
}

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const rootPcOf = (chord) => NAMES.indexOf(/^[A-G]#?/.exec(chord.name)[0]);
const pcs = (chord) => new Set(chord.midis.map((m) => ((m % 12) + 12) % 12));
const pc = (midi) => ((midi % 12) + 12) % 12;

/** The chord in force when a note sounds: the last chord event at or before it. */
function chordAt(chords, time) {
  let found = null;
  for (const chord of chords) {
    if (chord.time <= time + 1e-6) found = chord;
    else break;
  }
  return found;
}

/** A stable fingerprint of everything the piece played and announced. */
function digest({ notes, chords }) {
  const r = (x) => Math.round(x * 1e4);
  const lines = [
    ...notes.map((n) => `n ${n.track} ${n.midi} ${n.kind ?? ''} ${r(n.time)} ${r(n.duration)} ${r(n.velocity)}`),
    ...chords.map((c) => `c ${c.name} ${c.midis.join(',')} ${c.bar} ${r(c.time)}${c.beat === undefined ? '' : ` ${c.beat}`}`),
  ];
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---------------------------------------------------------------------------
// The field: sparse, clamped, cleared, junk-proof, carried by a partial.
// ---------------------------------------------------------------------------

test('sanitise: harmony.beats is sparse — absent by default, rounded, clamped, null clears, junk keeps', () => {
  const { sanitiseParams, DEFAULT_PARAMS, HARMONY_BEATS_MAX } = engineModule;
  assert.equal(HARMONY_BEATS_MAX, 8);
  assert.equal('beats' in sanitiseParams({}).harmony, false, 'no beats key by default');
  assert.equal('beats' in DEFAULT_PARAMS.harmony, false);
  const set = sanitiseParams({ harmony: { beats: 2 } });
  assert.equal(set.harmony.beats, 2);
  assert.equal(sanitiseParams({ harmony: { beats: '3' } }).harmony.beats, 3, 'a select sends strings');
  assert.equal(sanitiseParams({ harmony: { beats: 2.6 } }).harmony.beats, 3, 'beats are whole');
  assert.equal(sanitiseParams({ harmony: { beats: 0 } }).harmony.beats, 1, 'clamped up to 1');
  assert.equal(sanitiseParams({ harmony: { beats: 99 } }).harmony.beats, HARMONY_BEATS_MAX, 'clamped down');
  assert.equal(sanitiseParams({ harmony: { rhythm: 4 } }, set).harmony.beats, 2, 'absent inherits');
  for (const junk of ['lots', '', true, {}, [2], NaN]) {
    assert.equal(sanitiseParams({ harmony: { beats: junk } }, set).harmony.beats, 2,
      `${JSON.stringify(junk)} keeps the stored value`);
    assert.equal('beats' in sanitiseParams({ harmony: { beats: junk } }).harmony, false,
      `${JSON.stringify(junk)} with nothing stored is still absent`);
  }
  assert.equal('beats' in sanitiseParams({ harmony: { beats: null } }, set).harmony, false, 'null clears');
});

test('recipe: harmony.beats is named when set, absent when not, and survives the text round trip', async () => {
  const recipe = await import('../src/scripts/recipe.js');
  const withBeats = engineModule.sanitiseParams({ harmony: { beats: 2 } });
  const r = recipe.recipeFromParams(withBeats);
  assert.equal(r.harmony.beats, 2);
  assert.deepEqual(recipe.recipeFromText(recipe.recipeToText(r)), r);
  assert.match(recipe.recipeToText(r), /^Chord length in beats: 2$/m);
  assert.equal('beats' in recipe.recipeFromParams(engineModule.sanitiseParams({})).harmony, false);
});

// ---------------------------------------------------------------------------
// The harmony frame goes sub-bar.
// ---------------------------------------------------------------------------

test('beats 2 in 4/4: two chords a bar, at beats 1 and 3, each a different chord of the loop', () => hiddenTab(async () => {
  const { chords, barStarts } = await play(fixture({ beats: 2 }));
  const full = barStarts.length;
  assert.equal(full, BARS, `only ${full} bars played`);
  let changes = 0;
  for (let b = 0; b < full; b++) {
    const inBar = chords.filter((c) => c.bar === b);
    assert.deepEqual(inBar.map((c) => c.beat), [0, 2], `bar ${b}: chord beats ${JSON.stringify(inBar.map((c) => c.beat))}`);
    assert.ok(Math.abs(inBar[0].time - barStarts[b]) < 1e-6, `bar ${b}: the first chord is on the downbeat`);
    assert.ok(Math.abs(inBar[1].time - (barStarts[b] + 2 * SEC_PER_BEAT)) < 1e-6, `bar ${b}: the second is on beat 3`);
    if (rootPcOf(inBar[0]) !== rootPcOf(inBar[1])) changes += 1;
  }
  // The loop's four roots are all different, so every half-bar moves.
  assert.equal(changes, full, `${changes}/${full} bars changed chord mid-bar`);
  // And the loop runs at the chord rate: two bars play the whole four-chord loop.
  const roots = chords.slice(0, 8).map(rootPcOf);
  assert.deepEqual(roots.slice(0, 4), roots.slice(4, 8), 'the loop repeats every two bars');
  assert.equal(new Set(roots.slice(0, 4)).size, 4);
}));

test('beats 2: the pad voices EACH chord, only its tones, and lets go as the next one strikes', () => hiddenTab(async () => {
  const { chords, notes } = await play(fixture({ beats: 2 }));
  const pad = notes.filter((n) => n.track === 'pad');
  assert.ok(pad.length >= 2 * 3 * (BARS - 1), `only ${pad.length} pad notes`);
  const struck = new Map();
  for (const note of pad) {
    const chord = chordAt(chords, note.time);
    assert.ok(chord, `a pad note at ${note.time} before any chord`);
    assert.ok(pcs(chord).has(pc(note.midi)),
      `pad ${note.midi} at ${note.time.toFixed(3)} is not a tone of ${chord.name}`);
    const next = chords.find((c) => c.time > chord.time + 1e-6);
    if (next) {
      assert.ok(note.time + note.duration <= next.time + 1e-6,
        `pad ${note.midi} rings past the change to ${next.name} (${(note.time + note.duration).toFixed(3)} > ${next.time.toFixed(3)})`);
    }
    struck.set(chord.time, (struck.get(chord.time) ?? new Set()).add(pc(note.midi)));
  }
  // Every chord the frame announced was actually struck, with its full pitch set.
  const announced = chords.filter((c) => c.time < pad[pad.length - 1].time + 1e-6);
  for (const chord of announced) {
    assert.deepEqual([...(struck.get(chord.time) ?? [])].sort(), [...pcs(chord)].sort(),
      `${chord.name} at bar ${chord.bar} beat ${chord.beat}: the pad struck ${[...(struck.get(chord.time) ?? [])]}`);
  }
}));

test('beats 2: bass, melody and arp are each judged against the chord of THEIR half-bar', () => hiddenTab(async () => {
  const { chords, notes } = await play(fixture({ beats: 2 }));
  const of = (track) => notes.filter((n) => n.track === track);
  // Bass: every note is the root or the fifth of the chord in force, and the
  // note that lands with a chord change is its root at least most of the time.
  const bass = of('bass');
  assert.ok(bass.length >= BARS, `only ${bass.length} bass notes`);
  let onChange = 0;
  let rootOnChange = 0;
  for (const note of bass) {
    const chord = chordAt(chords, note.time);
    const root = rootPcOf(chord);
    assert.ok([root, (root + 7) % 12].includes(pc(note.midi)),
      `bass ${note.midi} at ${note.time.toFixed(3)} dur ${note.duration} is neither root nor fifth of ${chord.name} (chord t=${chord.time} bar ${chord.bar} beat ${chord.beat}; next chords ${chords.filter((c) => Math.abs(c.time - note.time) < 2.5).map((c) => c.name + '@' + c.time.toFixed(3) + '/' + c.bar).join(' ')})`);
    if (note.time - chord.time < 0.05) {
      onChange += 1;
      if (pc(note.midi) === root) rootOnChange += 1;
    }
  }
  assert.ok(onChange >= BARS, `only ${onChange} bass notes land with a chord change`);
  assert.ok(rootOnChange / onChange >= 0.75, `only ${rootOnChange}/${onChange} chord-change bass notes are the root`);
  // Melody: a cell of chord roots, so each note IS the root of its own chord.
  const melody = of('melody');
  // (The staged entry brings the melody in a few bars late.)
  assert.ok(melody.length >= 2 * BARS, `only ${melody.length} melody notes`);
  const secondHalf = melody.filter((n) => chordAt(chords, n.time).beat === 2);
  assert.ok(secondHalf.length >= BARS / 2, `only ${secondHalf.length} melody notes in a second half-bar`);
  for (const note of melody) {
    const chord = chordAt(chords, note.time);
    assert.equal(pc(note.midi), rootPcOf(chord),
      `melody ${note.midi} at beat ${chord.beat} of bar ${chord.bar} is not the root of ${chord.name}`);
  }
  // Arp: every note of the figure is a tone of the chord in force.
  const arp = of('arp');
  assert.ok(arp.length >= 6 * BARS, `only ${arp.length} arp notes`);
  for (const note of arp) {
    const chord = chordAt(chords, note.time);
    assert.ok(pcs(chord).has(pc(note.midi)),
      `arp ${note.midi} at beat ${chord.beat} of bar ${chord.bar} is not a tone of ${chord.name}`);
  }
}));

test('a length that does not divide the bar: 3 beats in 4/4 is chords at 1 and 4; 2 beats in 3/4 at 1 and 3', () => hiddenTab(async () => {
  for (const [ts, beats, want] of [['4/4', 3, [0, 3]], ['3/4', 2, [0, 2]], ['4/4', 1, [0, 1, 2, 3]], ['4/4', 6, [0]]]) {
    const { chords, barStarts } = await play(fixture({ beats }, { timeSignature: ts }), 6);
    assert.equal(barStarts.length, 6);
    for (let b = 0; b < barStarts.length; b++) {
      assert.deepEqual(chords.filter((c) => c.bar === b).map((c) => c.beat), want,
        `${ts}, beats ${beats}, bar ${b}`);
    }
  }
}));

test('beats as long as the bar is one chord a bar — note for note what rhythm 1 plays', () => hiddenTab(async () => {
  const a = await play(fixture({ beats: 4 }));
  const b = await play(fixture({ rhythm: 1 }));
  const strip = ({ notes, chords }) => ({ notes, chords: chords.map(({ beat, ...rest }) => rest) });
  assert.equal(digest(strip(a)), digest(strip(b)));
}));

// ---------------------------------------------------------------------------
// Absent is today's engine, to the byte. The digests were taken on the
// v0.0.238 engine, before harmony.beats existed (see the commit message).
// ---------------------------------------------------------------------------

const TODAY = {
  strict: '4b180bf2c1726e85d0c3d6dda0251531c820500d510191c1ea5e5114345dbb59',
  loose: 'e3a39118683c0c6e02e70bde21b5e30b886cc45bef2dc3dd9eaecc0a4c295e93',
};

function loose() {
  // Humanised, dissonant, auto rhythm, a full band: the paths a strict fixture skips.
  const params = fixture({ rhythm: 'auto', seed: null });
  params.complexity = 0.7;
  params.repetition = 0.4;
  for (const name of ['pad', 'bass', 'melody', 'arp']) {
    params.tracks[name] = { state: 'on', randomness: 0.6, dissonance: 0.3 };
  }
  params.tracks.texture = { state: 'on' };
  params.tracks.percussion = { state: 'on' };
  params.arp = { mode: 'auto' };
  return params;
}

test('absent: the note stream and chord events are identical to the engine before harmony.beats', () => hiddenTab(async () => {
  const strict = digest(await play(fixture()));
  const wide = digest(await play(loose(), 16, 5));
  if (process.argv.includes('--print')) console.log(JSON.stringify({ strict, loose: wide }));
  assert.equal(strict, TODAY.strict, 'the strict fixture moved');
  assert.equal(wide, TODAY.loose, 'the loose fixture moved');
  // And an explicit null is absent.
  assert.equal(digest(await play(fixture({ beats: null }))), strict);
}));

test('beats 2 under a full, humanised band: still two chords a bar, every pad note on its chord', () => hiddenTab(async () => {
  const params = loose();
  params.harmony.beats = 2;
  const { chords, notes, barStarts } = await play(params, 16, 5);
  for (let b = 0; b < barStarts.length; b++) {
    assert.deepEqual(chords.filter((c) => c.bar === b).map((c) => c.beat), [0, 2], `bar ${b}`);
  }
  // Humanised timing nudges a pad note either side of its chord's onset, so
  // each is judged against the chord nearest its own start.
  const pad = notes.filter((n) => n.track === 'pad');
  assert.ok(pad.length > 16, `only ${pad.length} pad notes`);
  for (const note of pad) {
    const chord = chords.reduce((best, c) => (Math.abs(c.time - note.time) < Math.abs(best.time - note.time) ? c : best));
    assert.ok(pcs(chord).has(pc(note.midi)), `pad ${note.midi} is not a tone of ${chord.name}`);
  }
}));

// ---------------------------------------------------------------------------
// The bass approach leans into a MID-BAR change too (follow-up to v0.0.241).
// ---------------------------------------------------------------------------

/** The bass tones the engine offers on a chord of C ionian: root (octave 2), fifth, octave. */
function bassOptions(chord) {
  const root = 36 + rootPcOf(chord);
  return [root, root + 7, root + 12 <= 55 ? root + 12 : root - 12 >= 28 ? root - 12 : root];
}
const nearest = (options, to) => options.reduce((best, m) => (Math.abs(m - to) < Math.abs(best - to) ? m : best));

test('beats 2: the last off-beat bass note before beat 3 leans to the option nearest the coming chord\'s root', () => hiddenTab(async () => {
  let checked = 0;
  // Complexity and seed chosen so the groove HAS an off-beat (beat 1.75)
  // before the change; at complexity 0 it plays only on the beat, where the
  // law is that nothing is touched.
  for (const [complexity, seed] of [[0.5, 11], [0.9, 11]]) {
    const params = fixture({ beats: 2 });
    params.complexity = complexity;
    const { chords, notes, barStarts } = await play(params, BARS, seed);
    const bass = notes.filter((n) => n.track === 'bass');
    for (let b = 0; b < barStarts.length; b++) {
      const [from, into] = chords.filter((c) => c.bar === b);
      if (!into || rootPcOf(from) === rootPcOf(into)) continue;
      const before = bass.filter((n) => n.time >= from.time - 1e-6 && n.time < into.time - 1e-6);
      const lead = before[before.length - 1];
      if (!lead) continue;
      const beat = (lead.time - barStarts[b]) / SEC_PER_BEAT;
      if (Math.abs(beat - Math.round(beat)) < 1e-6) continue; // a strong beat: never re-pitched
      const want = nearest(bassOptions(from), 36 + rootPcOf(into));
      assert.equal(lead.midi, want,
        `bar ${b} (cx ${complexity}): bass ${lead.midi} at beat ${beat + 1} into ${into.name} should be ${want}, the ${from.name} tone nearest ${into.name}'s root`);
      checked += 1;
    }
  }
  assert.ok(checked >= BARS, `only ${checked} mid-bar approach notes were judged`);
}));

// ---------------------------------------------------------------------------
// sampling: 'chord' under harmony.beats is bar resolution, by construction.
// ---------------------------------------------------------------------------

test('beats 2: a chord-sampled walk steps once a bar — value for value what bar sampling does', () => hiddenTab(async () => {
  // A walk is ONE number per (track, param) per bar — resolved once and read
  // by every note of the bar — so it cannot step at a mid-bar chord. Under
  // harmony.beats every bar starts a chord, so 'chord' sampling is 'bar'.
  // rhythm 4 is there to prove beats governs: alone it would hold the walk four bars.
  const run = async (sampling) => {
    const params = fixture({ beats: 2, rhythm: 4 });
    params.tracks.pad = { ...params.tracks.pad, randomness: 0.5, level: { min: 0.2, max: 0.8 } };
    params.sampling = sampling;
    const engine = createEngine(params, { rng: seededRng(6711) });
    const perBar = [];
    engine.on('bar', () => perBar.push(engine.getResolved().tracks.pad.level));
    await engine.start();
    await advance(4 * SEC_PER_BEAT * (BARS + 1));
    engine.stop();
    return perBar.slice(0, BARS);
  };
  const chorded = await run({ 'pad:level': 'chord' });
  const barred = await run({});
  assert.equal(chorded.length, BARS);
  assert.deepEqual(chorded, barred, 'chord sampling under harmony.beats is not bar sampling');
  let changes = 0;
  for (let i = 1; i < chorded.length; i++) if (chorded[i] !== chorded[i - 1]) changes += 1;
  assert.ok(changes >= BARS - 3, `the chord-sampled level moved on only ${changes} of ${BARS - 1} bars`);
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
