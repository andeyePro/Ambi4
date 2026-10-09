/**
 * Cinematic identity — run with:
 *   node tests/cinematic-identity-smoke.mjs          (the gate)
 *   node tests/cinematic-identity-smoke.mjs --table  (print every genre's numbers)
 *
 * The owner's verdict on Cinematic (TODO.md, "Cinematic does not sound
 * cinematic"): "it frankly sounds much more like most of the other Ambi4
 * tracks than anything you would call Cinematic" — the v0.0.29
 * blind-identification test failing for one genre. Nobody in this container
 * can hear, so this suite MEASURES what makes film-score ambient identifiable
 * and holds Cinematic apart from the other eleven genres on those measures:
 *
 *   span        the register the pitched lines cover: the 95th minus the
 *               5th percentile of every note on pad, bass, melody and arp, at
 *               the pitch it SOUNDS (the note's midi plus the playing patch's
 *               own octave switch, source.octave, which the voice applies on
 *               top of the generator's choice), weighted by how long it
 *               sounds. Film scoring lives on the spread.
 *   outer       the share of that sounding time spent in the outer registers
 *               — below C3 or from C5 up. A low pedal under high strings is
 *               hollow in the middle; a band voicing sits in it.
 *   barsPerChord  harmonic rhythm: bars per chord change, from the engine's
 *               own 'chord' stream. REPORTED, not held: the drone genres
 *               (ambient, minimalism, techno-tools) barely change chord at
 *               all, so "slower than every other genre" would mean "static",
 *               which a score is not. Cinematic is the slowest of the genres
 *               whose harmony actually moves.
 *   mediant     the share of chord changes whose root moves by a third (3, 4,
 *               8 or 9 semitones) — i–VI, i–III, I–iii, I–vi, the moves that
 *               read as film harmony against the fourth/fifth/step motion of
 *               song and dance genres.
 *   swell       the dynamic range of the form: the spread of section
 *               intensity the engine announces (max minus min). A long
 *               crescendo into a section is the gesture.
 *   lowPerc     the share of percussion hits on the LOW lane — booms
 *               (taiko/timpani) rather than a kit's hats and snares.
 *   melodyBeats the median melody note length in beats: a long-breathed solo
 *               line, not a riff.
 *
 * Each is measured over SEEDS compiles of every genre (the compile seed and
 * the engine seed both vary), on the same minimal AudioContext mock the other
 * engine suites use. "Near the pack" is exactly what the owner heard, so the
 * gate is that Cinematic's mean sits OUTSIDE the range the other eleven
 * genres' means cover, in the cinematic direction, on at least five of the
 * seven measures — and on each of span, outer, mediant, swell and lowPerc by
 * name, so a later change cannot trade one away for another.
 *
 * On the v0.0.220 file (before the voicing pass) it is apart on two of seven
 * (outer and swell, each by a hair) and inside the pack on span, mediant and
 * lowPerc — red, which is what this suite was written to catch.
 *
 * The clock: the engine's scheduler runs on setInterval; this suite captures
 * that interval and calls it by hand after every clock step, so a run is
 * deterministic and never races the machine's load (the trap energy-measure
 * documents).
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Minimal AudioContext mock (the genre-smoke shape: notes are read, not nodes)
// ---------------------------------------------------------------------------

function makeParam(value) {
  return {
    value,
    setValueAtTime(v) { this.value = v; return this; },
    linearRampToValueAtTime(v) { this.value = v; return this; },
    exponentialRampToValueAtTime(v) { this.value = v; return this; },
    setTargetAtTime(v) { this.value = v; return this; },
    setValueCurveAtTime() { return this; },
    cancelScheduledValues() { return this; },
    cancelAndHoldAtTime() { return this; },
  };
}

function makeNode(kind) {
  return {
    kind,
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
    connect() {},
    disconnect() {},
    start() {},
    stop() {},
  };
}

const liveContexts = [];
class MockAudioContext {
  constructor() {
    this.currentTime = 0;
    this.sampleRate = 48000;
    this.state = 'running';
    this.destination = makeNode('destination');
    liveContexts.push(this);
  }
  createGain() { return makeNode('gain'); }
  createOscillator() { return makeNode('oscillator'); }
  createBiquadFilter() { return makeNode('biquad'); }
  createStereoPanner() { return makeNode('panner'); }
  createPanner() { return makeNode('panner3d'); }
  createConvolver() { return makeNode('convolver'); }
  createDelay() { return makeNode('delay'); }
  createDynamicsCompressor() { return makeNode('compressor'); }
  createAnalyser() { return makeNode('analyser'); }
  createBufferSource() { return makeNode('buffersource'); }
  createConstantSource() { return makeNode('constantsource'); }
  createWaveShaper() { return makeNode('waveshaper'); }
  createChannelMerger() { return makeNode('merger'); }
  createChannelSplitter() { return makeNode('splitter'); }
  createPeriodicWave() { return { kind: 'periodicwave' }; }
  createBuffer(channels, length, sampleRate) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { numberOfChannels: channels, length, sampleRate, getChannelData: (i) => data[i] };
  }
  resume() { this.state = 'running'; return Promise.resolve(); }
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
  close() { return Promise.resolve(); }
}
globalThis.AudioContext = MockAudioContext;

// The scheduler's interval, captured so the suite can drive it by hand.
const intervals = new Map();
let nextIntervalId = 1;
globalThis.setInterval = (fn) => { const id = nextIntervalId++; intervals.set(id, fn); return id; };
globalThis.clearInterval = (id) => { intervals.delete(id); };

const engineModule = await import('../src/scripts/ambient-engine.js');
const { compileGenre } = await import('../src/scripts/genre-compiler.js');

const GENRE_DIR = new URL('../src/data/genres/', import.meta.url);
const GENRES = readdirSync(GENRE_DIR)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .map((name) => JSON.parse(readFileSync(new URL(name, GENRE_DIR), 'utf8')));

const seededRng = (seed) => () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
const SEEDS = Number(process.env.CINEMATIC_SEEDS) || 12;
const BARS = 48;
const SKIP = 7; // the staged entry: one track per bar until every track is in

const quantile = (values, q) => {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};
const weightedQuantile = (items, q) => {
  if (!items.length) return NaN;
  const sorted = [...items].sort((a, b) => a.v - b.v);
  const total = sorted.reduce((s, x) => s + x.w, 0);
  let run = 0;
  for (const x of sorted) {
    run += x.w;
    if (run >= total * q) return x.v;
  }
  return sorted[sorted.length - 1].v;
};
const NOTE_PCS = Object.freeze({ C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 });
const rootOf = (name) => {
  const m = /^([A-G])([#b]?)/.exec(String(name));
  if (!m) return 0;
  return NOTE_PCS[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
};
// The outer registers: below C3 (the cellos' and basses' pedal) and from C5 up
// (violins over the stave). A film voicing is hollow in the middle.
const LOW_EDGE = 48;
// The register is read off the four PITCHED lines. The texture track is left
// out for every genre alike: three of its voices do not sound at the midi
// they carry (colour and cloud have no oscillator at all, wash is a noise band
// with a 14% anchor tone clamped to 3 kHz), so counting them would measure
// note names nobody hears.
const PITCHED_LINES = Object.freeze(['pad', 'bass', 'melody', 'arp']);
const HIGH_EDGE = 72;
const mean = (values) => (values.length ? values.reduce((s, v) => s + v, 0) / values.length : NaN);

/** One compiled piece, played BARS bars, measured. */
async function measurePiece(genre, seed) {
  const params = compileGenre(genre, { rng: seededRng(seed * 7919 + 13) });
  globalThis.document = { hidden: true, addEventListener() {} };
  const engine = engineModule.createEngine(params, { rng: seededRng(seed * 104729 + 7) });
  const notes = [];
  const chords = [];
  const sections = [];
  let bars = 0;
  engine.on('note', (note) => notes.push({ ...note, bar: bars - 1 }));
  engine.on('chord', (chord) => chords.push(chord));
  engine.on('section', (section) => sections.push(section));
  engine.on('bar', () => { bars += 1; });
  await engine.start();
  const ctx = liveContexts[liveContexts.length - 1];
  let guard = 0;
  while (bars < BARS && guard++ < 20000) {
    ctx.currentTime += 0.25;
    for (const fn of [...intervals.values()]) fn();
  }
  engine.stop();
  intervals.clear();
  delete globalThis.document;

  const live = engine.getParams();
  const octaveOf = (track) => {
    const voice = live.tracks[track]?.voice;
    const octave = Number(live.patches?.[track]?.[voice]?.source?.octave);
    return Number.isFinite(octave) ? octave : 0;
  };
  const late = notes.filter((note) => note.bar >= SKIP && !note.live);
  const tuned = late.filter((note) => PITCHED_LINES.includes(note.track) && Number.isFinite(note.midi));
  // Every tuned note at the pitch it SOUNDS, weighted by how long it sounds:
  // a pedal held for eight bars is eight bars of register, not one note.
  const sounding = tuned.map((note) => ({ v: note.midi + 12 * octaveOf(note.track), w: Math.max(0.01, note.duration) }));
  const span = weightedQuantile(sounding, 0.95) - weightedQuantile(sounding, 0.05);
  const total = sounding.reduce((s, x) => s + x.w, 0);
  const outer = total ? sounding.filter((x) => x.v < LOW_EDGE || x.v >= HIGH_EDGE).reduce((s, x) => s + x.w, 0) / total : NaN;

  // Harmonic rhythm and root motion, from the chord stream after the entry.
  // The root is the one the chord's NAME carries (nameChord is handed the
  // degree's root), never the voicing's bottom note, which an inversion moves.
  const chordStream = chords.filter((chord) => chord.bar >= SKIP);
  let changes = 0;
  let thirds = 0;
  for (let i = 1; i < chordStream.length; i++) {
    const a = chordStream[i - 1];
    const b = chordStream[i];
    if (a.name === b.name) continue;
    changes += 1;
    const interval = (((rootOf(b.name) - rootOf(a.name)) % 12) + 12) % 12;
    if ([3, 4, 8, 9].includes(interval)) thirds += 1;
  }
  const barsPerChord = chordStream.length / Math.max(1, changes);
  const mediant = changes ? thirds / changes : 0;

  // The section intensity curve the engine announces (waves and build announce
  // every bar they move; the block presets once per block).
  const intensities = sections.map((section) => section.intensity);
  const swell = intensities.length ? Math.max(...intensities) - Math.min(...intensities) : 0;

  const perc = late.filter((note) => note.track === 'percussion');
  const lowPerc = perc.length ? perc.filter((note) => note.lane === 'low').length / perc.length : NaN;

  const beat = 60 / (live.bpm * live.speed);
  const melody = late.filter((note) => note.track === 'melody').map((note) => note.duration / beat);
  const melodyBeats = melody.length ? quantile(melody, 0.5) : NaN;

  return { span, outer, barsPerChord, mediant, swell, lowPerc, melodyBeats };
}

export const MEASURES = Object.freeze([
  // name, direction the cinematic end lies in (+1 higher, -1 lower)
  ['span', +1],
  ['outer', +1],
  ['barsPerChord', +1],
  ['mediant', +1],
  ['swell', +1],
  ['lowPerc', +1],
  ['melodyBeats', +1],
]);

async function measureGenre(genre) {
  const rows = [];
  for (let seed = 1; seed <= SEEDS; seed++) rows.push(await measurePiece(genre, seed));
  const out = {};
  for (const [name] of MEASURES) {
    // NaN (no percussion or no melody that run) is "no evidence", not zero.
    out[name] = mean(rows.map((row) => row[name]).filter(Number.isFinite));
  }
  return out;
}

const table = {};
for (const genre of GENRES) table[genre.slug] = await measureGenre(genre);

const fmt = (v) => (Number.isFinite(v) ? v.toFixed(2).padStart(7) : '    n/a');
const printTable = () => {
  console.log(`genre            ${MEASURES.map(([name]) => name.padStart(12)).join('')}`);
  for (const [slug, row] of Object.entries(table)) {
    console.log(`${slug.padEnd(17)}${MEASURES.map(([name]) => fmt(row[name]).padStart(12)).join('')}`);
  }
};
if (process.argv.includes('--table')) printTable();

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

const cinematic = table.cinematic;
const others = Object.entries(table).filter(([slug]) => slug !== 'cinematic').map(([, row]) => row);
const verdicts = MEASURES.map(([name, direction]) => {
  const pack = others.map((row) => row[name]).filter(Number.isFinite);
  const edge = direction > 0 ? Math.max(...pack) : Math.min(...pack);
  const value = cinematic[name];
  const apart = Number.isFinite(value) && (direction > 0 ? value > edge : value < edge);
  return { name, value, edge, apart };
});
for (const v of verdicts) {
  console.log(`${v.apart ? 'apart' : 'pack '} ${v.name.padEnd(13)} cinematic ${fmt(v.value)}  pack edge ${fmt(v.edge)}`);
}

let failures = 0;
const check = (label, fn) => {
  try {
    fn();
    console.log(`ok   ${label}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${label}\n     ${error.message}`);
  }
};

check(`Cinematic stands outside the other genres on at least five of the ${MEASURES.length} measures`, () => {
  const apart = verdicts.filter((v) => v.apart).map((v) => v.name);
  assert.ok(apart.length >= 5, `apart only on [${apart.join(', ')}]`);
});

// The five that carry the film-score reading most directly are each held on
// their own, so a later change cannot trade one away for another.
for (const name of ['span', 'outer', 'mediant', 'swell', 'lowPerc']) {
  check(`Cinematic is outside the pack on ${name}`, () => {
    const v = verdicts.find((entry) => entry.name === name);
    assert.ok(v.apart, `${name}: cinematic ${fmt(v.value)} against the pack's edge ${fmt(v.edge)}`);
  });
}

check('Cinematic stays hidden: it is in HIDDEN_GENRES until the owner unhides it (he rejected it)', () => {
  const page = readFileSync(new URL('../src/pages/index.astro', import.meta.url), 'utf8');
  // HIDDEN_GENRES is every genre NOT on the public allow-list.
  const match = /PUBLIC_GENRE_SLUGS\s*=\s*new Set\(\[([^\]]*)\]/.exec(page);
  assert.ok(match, 'PUBLIC_GENRE_SLUGS not found in index.astro');
  assert.ok(/HIDDEN_GENRES\s*=\s*new Set\(\s*GENRES[^;]*!PUBLIC_GENRE_SLUGS\.has/.test(page), 'HIDDEN_GENRES is no longer the complement of the public list');
  assert.ok(!/['"]cinematic['"]/.test(match[1]), `cinematic is public: ${match[1]}`);
});

console.log(`\n${failures ? 'FAILED' : 'passed'} (${SEEDS} seeds × ${GENRES.length} genres × ${BARS} bars)`);
process.exit(failures ? 1 : 0);
