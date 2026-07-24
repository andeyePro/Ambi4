/**
 * ambient-engine.js — procedural six-track ambient generator.
 *
 * Pure Web Audio API, no dependencies, no assets, no network. Import from an
 * Astro page's <script type="module"> and drive it with createEngine().
 *
 * Importing this module in a non-browser environment is safe: nothing touches
 * AudioContext until start() is called, and the voice library is pulled in with
 * a dynamic import from start() (falling back to the built-in sine voices below
 * if it is missing).
 *
 * Layout of this file:
 *   1. music theory tables + pure helpers (unit-testable, no audio)
 *   2. parameter validation
 *   3. phrase / harmony / structure / arp / percussion generators (pure)
 *   4. fallback voices + audio graph
 *   5. scheduler + public engine
 */

// ---------------------------------------------------------------------------
// 1. Music theory
// ---------------------------------------------------------------------------

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Flat spellings the UI might send; normalised to the sharp names above. */
const ENHARMONICS = {
  DB: 'C#', EB: 'D#', FB: 'E', GB: 'F#', AB: 'G#', BB: 'A#', 'E#': 'F', 'B#': 'C',
};

/** Semitone offsets from the root. */
export const SCALES = Object.freeze({
  majorPentatonic: [0, 2, 4, 7, 9],
  minorPentatonic: [0, 3, 5, 7, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  wholeTone: [0, 2, 4, 6, 8, 10],
});

/**
 * Pulse lengths per bar, measured in quarter notes. Compound and additive
 * metres are expressed as their felt pulses rather than raw denominators:
 * 6/8 is two dotted-quarter pulses, 7/8 is 2+2+3 eighths.
 */
export const TIME_SIGNATURES = Object.freeze({
  '3/4': [1, 1, 1],
  '4/4': [1, 1, 1, 1],
  '5/4': [1, 1, 1, 1, 1],
  '6/8': [1.5, 1.5],
  '7/8': [1, 1, 1.5],
});

/** Fixed track order — also the order auto-tracks switch themselves on in. */
export const TRACK_ORDER = Object.freeze(['pad', 'bass', 'melody', 'texture', 'arp', 'percussion']);

export const TRACK_STATES = Object.freeze(['off', 'auto', 'on']);

export const STRUCTURES = Object.freeze([
  'auto', 'drone', 'waves', 'build', 'abab', 'journey', 'custom',
]);

export const STRUCTURE_LABELS = Object.freeze(['A', 'B', 'C', 'D']);

export const ARP_PATTERNS = Object.freeze(['up', 'down', 'updown', 'random']);

/** Arp step length in quarter notes. */
export const ARP_RATES = Object.freeze({ '1/4': 1, '1/8': 0.5, '1/16': 0.25, '1/8T': 1 / 3 });

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const round3 = (v) => Math.round(v * 1000) / 1000;

/** Equal temperament, A4 = 440 Hz, MIDI 69. */
export function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** 'C' → 0, 'Bb' → 10. Returns 0 for anything unrecognised. */
export function pitchClass(name) {
  if (typeof name !== 'string') return 0;
  const key = name.trim().replace(/^([a-g])/i, (m) => m.toUpperCase());
  const normalised = ENHARMONICS[key.toUpperCase()] ?? key;
  const index = NOTE_NAMES.indexOf(normalised);
  return index < 0 ? 0 : index;
}

/** Canonical sharp spelling of a root name, or null if unrecognised. */
export function normaliseRoot(name) {
  if (typeof name !== 'string') return null;
  const key = name.trim().replace(/^([a-g])/i, (m) => m.toUpperCase());
  const normalised = ENHARMONICS[key.toUpperCase()] ?? key;
  return NOTE_NAMES.includes(normalised) ? normalised : null;
}

/**
 * Map a scale degree (any integer, negative or beyond one octave) onto a MIDI
 * note. `baseOctave` is scientific pitch notation, so degree 0 in octave 4 with
 * root C is middle C (60).
 */
export function scaleDegreeToMidi(degree, scale, rootPc = 0, baseOctave = 4) {
  const n = scale.length;
  const octaveShift = Math.floor(degree / n);
  const index = ((degree % n) + n) % n;
  return (baseOctave + 1) * 12 + rootPc + scale[index] + 12 * octaveShift;
}

/**
 * Snap an arbitrary MIDI note to the nearest member of the scale, keeping it in
 * the same octave region. Used to keep transposed/derived notes (a bass fifth,
 * a drifting texture note) inside the current mode.
 */
export function quantiseToScale(midi, scale, rootPc = 0) {
  const relative = midi - rootPc;
  const octave = Math.floor(relative / 12);
  const pc = relative - octave * 12;
  // scale[0] + 12 lets a note just below the octave snap upward instead of
  // being dragged all the way down to the flat seventh.
  const candidates = scale.concat([scale[0] + 12]);
  let best = candidates[0];
  for (const c of candidates) {
    if (Math.abs(c - pc) < Math.abs(best - pc)) best = c;
  }
  return rootPc + octave * 12 + best;
}

/** Total quarter-note beats in a bar of the given time signature. */
export function beatsPerBar(timeSignature) {
  const pulses = TIME_SIGNATURES[timeSignature] ?? TIME_SIGNATURES['4/4'];
  return pulses.reduce((a, b) => a + b, 0);
}

// ---------------------------------------------------------------------------
// 2. Parameters
// ---------------------------------------------------------------------------

const DEFAULT_TRACK_VOICES = Object.freeze({
  pad: 'warm',
  bass: 'sub',
  melody: 'pluck',
  texture: 'sparkle',
  arp: 'softPluck',
  percussion: 'soft',
});

const ARP_MODES = ['auto', 'manual'];
const ARP_STEP_COUNT = 16;

function defaultTracks() {
  const tracks = {};
  for (const name of TRACK_ORDER) tracks[name] = { state: 'auto', voice: DEFAULT_TRACK_VOICES[name] };
  return tracks;
}

function defaultArp() {
  return {
    mode: 'auto',
    pattern: 'up',
    rate: '1/8',
    octaves: 2,
    gate: 0.6,
    steps: new Array(ARP_STEP_COUNT).fill(true),
  };
}

function defaultCustomStructure() {
  return [
    { label: 'A', bars: 8, intensity: 0.4 },
    { label: 'B', bars: 8, intensity: 0.7 },
  ];
}

export const DEFAULT_PARAMS = Object.freeze({
  speed: 1,
  complexity: 0.5,
  repetition: 0.5,
  root: 'C',
  mode: 'majorPentatonic',
  timeSignature: '4/4',
  bpm: 60,
  volume: 0.8,
  structure: 'auto',
  customStructure: Object.freeze(defaultCustomStructure().map(Object.freeze)),
  arp: Object.freeze({ ...defaultArp(), steps: Object.freeze(new Array(ARP_STEP_COUNT).fill(true)) }),
  tracks: Object.freeze(
    Object.fromEntries(Object.entries(defaultTracks()).map(([k, v]) => [k, Object.freeze(v)])),
  ),
});

const NUMERIC_RANGES = {
  speed: [0.25, 2],
  complexity: [0, 1],
  repetition: [0, 1],
  bpm: [40, 120],
  volume: [0, 1],
};

function numberIn(value, range, fallback) {
  const num = typeof value === 'number' ? value : Number(value);
  if (value === undefined || value === null || value === '' || !Number.isFinite(num)) return fallback;
  return clamp(num, range[0], range[1]);
}

function oneOf(value, allowed, fallback) {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback;
}

/** 16 booleans; short arrays are padded with `true`, long ones truncated. */
function sanitiseSteps(value, base) {
  const source = Array.isArray(value) ? value : Array.isArray(base) ? base : null;
  const steps = new Array(ARP_STEP_COUNT);
  for (let i = 0; i < ARP_STEP_COUNT; i++) {
    steps[i] = source && i < source.length ? Boolean(source[i]) : true;
  }
  return steps;
}

function sanitiseArp(value, base) {
  const from = base && typeof base === 'object' ? base : DEFAULT_PARAMS.arp;
  const v = value && typeof value === 'object' ? value : null;
  const at = (key) => (v && key in v ? v[key] : undefined);
  return {
    mode: oneOf(at('mode'), ARP_MODES, oneOf(from.mode, ARP_MODES, 'auto')),
    pattern: oneOf(at('pattern'), ARP_PATTERNS, oneOf(from.pattern, ARP_PATTERNS, 'up')),
    rate: oneOf(at('rate'), Object.keys(ARP_RATES), oneOf(from.rate, Object.keys(ARP_RATES), '1/8')),
    octaves: Math.round(numberIn(at('octaves'), [1, 3], numberIn(from.octaves, [1, 3], 2))),
    gate: numberIn(at('gate'), [0.1, 1], numberIn(from.gate, [0.1, 1], 0.6)),
    steps: sanitiseSteps(at('steps'), from.steps),
  };
}

function sanitiseTracks(value, base) {
  const from = base && typeof base === 'object' ? base : DEFAULT_PARAMS.tracks;
  const v = value && typeof value === 'object' ? value : null;
  const tracks = {};
  for (const name of TRACK_ORDER) {
    const baseTrack = from[name] && typeof from[name] === 'object' ? from[name] : {};
    const partial = v && v[name] && typeof v[name] === 'object' ? v[name] : null;
    const voiceCandidate = partial && typeof partial.voice === 'string' && partial.voice.trim()
      ? partial.voice.trim()
      : typeof baseTrack.voice === 'string' && baseTrack.voice.trim()
        ? baseTrack.voice.trim()
        : DEFAULT_TRACK_VOICES[name];
    tracks[name] = {
      state: oneOf(partial && partial.state, TRACK_STATES,
        oneOf(baseTrack.state, TRACK_STATES, 'auto')),
      voice: voiceCandidate,
    };
  }
  return tracks;
}

/**
 * Custom structure blocks. Anything that is not a usable block is dropped; a
 * non-array keeps whatever the base had. An empty result is legal and makes
 * `structure: 'custom'` fall back to the auto preset at play time.
 */
function sanitiseCustomStructure(value, base) {
  const source = Array.isArray(value) ? value : Array.isArray(base) ? base : [];
  const blocks = [];
  for (const raw of source) {
    if (!raw || typeof raw !== 'object') continue;
    const label = typeof raw.label === 'string' ? raw.label.trim().toUpperCase() : '';
    if (!STRUCTURE_LABELS.includes(label)) continue;
    blocks.push({
      label,
      bars: Math.round(numberIn(raw.bars, [1, 32], 8)),
      intensity: numberIn(raw.intensity, [0, 1], 0.5),
    });
    if (blocks.length === 8) break;
  }
  return blocks;
}

/**
 * Merge `partial` over `base`, clamping numbers, rejecting unknown enum values
 * and silently ignoring unknown keys (including v1's `voices`). `arp`, `tracks`
 * and `customStructure` merge deeply. Always returns a complete, freshly
 * allocated params object.
 */
export function sanitiseParams(partial, base = DEFAULT_PARAMS) {
  const from = base && typeof base === 'object' ? base : DEFAULT_PARAMS;
  const p = partial && typeof partial === 'object' ? partial : null;
  const at = (key) => (p && key in p ? p[key] : undefined);

  const out = {};
  for (const key of Object.keys(NUMERIC_RANGES)) {
    const range = NUMERIC_RANGES[key];
    // Re-clamping the inherited value too means a bad `base` can never leak.
    out[key] = numberIn(at(key), range, numberIn(from[key], range, DEFAULT_PARAMS[key]));
  }
  out.root = normaliseRoot(at('root')) ?? normaliseRoot(from.root) ?? DEFAULT_PARAMS.root;
  out.mode = oneOf(at('mode'), Object.keys(SCALES), oneOf(from.mode, Object.keys(SCALES), DEFAULT_PARAMS.mode));
  out.timeSignature = oneOf(at('timeSignature'), Object.keys(TIME_SIGNATURES),
    oneOf(from.timeSignature, Object.keys(TIME_SIGNATURES), DEFAULT_PARAMS.timeSignature));
  out.structure = oneOf(at('structure'), STRUCTURES, oneOf(from.structure, STRUCTURES, 'auto'));
  out.customStructure = sanitiseCustomStructure(at('customStructure'), from.customStructure);
  out.arp = sanitiseArp(at('arp'), from.arp);
  out.tracks = sanitiseTracks(at('tracks'), from.tracks);
  return out;
}

/** Deep copy of a sanitised params object — what getParams() hands out. */
function copyParams(params) {
  return {
    ...params,
    customStructure: params.customStructure.map((block) => ({ ...block })),
    arp: { ...params.arp, steps: params.arp.steps.slice() },
    tracks: Object.fromEntries(TRACK_ORDER.map((name) => [name, { ...params.tracks[name] }])),
  };
}

// ---------------------------------------------------------------------------
// 3. Generators (pure — no audio, no shared state)
// ---------------------------------------------------------------------------

const pick = (arr, rng) => arr[Math.floor(rng() * arr.length) % arr.length];
const between = (lo, hi, rng) => lo + rng() * (hi - lo);

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Chord as scale degrees stacked in thirds from `degree`. Because the stack is
 * built in scale steps rather than semitones it stays diatonic in every mode,
 * including the pentatonics and whole tone (where "thirds" are wider and give
 * the open, quartal colour those scales are wanted for).
 * complexity adds the 7th, then the 9th.
 */
export function buildChord(degree, complexity = 0.5) {
  const steps = [0, 2, 4];
  if (complexity >= 0.35) steps.push(6);
  if (complexity >= 0.7) steps.push(8);
  return steps.map((s) => degree + s);
}

/**
 * Random walk to a related chord. Fourth/fifth-ish moves (±3, ±4 scale steps)
 * dominate; complexity opens up the wider, more surprising jumps.
 */
export function nextChordDegree(current, scaleLength, complexity = 0.5, rng = Math.random) {
  const moves = [3, -3, 4, -4, 1, -1];
  const weights = [3, 3, 2.5, 2.5, 2, 2];
  if (complexity > 0.4) {
    moves.push(2, -2);
    weights.push(1.5 * complexity, 1.5 * complexity);
  }
  if (complexity > 0.75) {
    moves.push(5, -5);
    weights.push(complexity, complexity);
  }
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  let move = moves[0];
  for (let i = 0; i < moves.length; i++) {
    r -= weights[i];
    if (r <= 0) { move = moves[i]; break; }
  }
  const next = (((current + move) % scaleLength) + scaleLength) % scaleLength;
  return next === current ? (next + 3) % scaleLength : next;
}

/** A four-chord loop, always starting on the tonic. */
export function generateProgression(scaleLength, complexity = 0.5, rng = Math.random) {
  const chords = [0];
  for (let i = 1; i < 4; i++) {
    chords.push(nextChordDegree(chords[i - 1], scaleLength, complexity, rng));
  }
  return chords;
}

/**
 * A melodic phrase of 1–2 bars. Note degrees are RELATIVE to the chord root
 * degree, so a stored phrase stays consonant when reused over a different
 * chord. Density runs from about one note per bar to six as complexity rises;
 * positions are drawn from beat starts first and only spill onto offbeats when
 * the phrase is dense or complex.
 */
export function generatePhrase({
  beatsPerBar: barBeats,
  bars = 1,
  complexity = 0.5,
  scaleLength = 5,
  rng = Math.random,
}) {
  const density = clamp(complexity, 0, 1);
  const notes = [];
  for (let bar = 0; bar < bars; bar++) {
    const downbeats = [];
    for (let b = 0; b < barBeats; b += 1) downbeats.push(b);
    const offbeats = [];
    for (let b = 0.5; b < barBeats; b += 1) offbeats.push(b);
    shuffle(downbeats, rng);
    shuffle(offbeats, rng);

    const wanted = 1 + Math.round(density * 5);
    const count = Math.max(1, Math.min(wanted, downbeats.length + offbeats.length));
    const chosen = [];
    while (chosen.length < count) {
      const preferOff = downbeats.length === 0 || (offbeats.length > 0 && rng() < density * 0.45);
      const source = preferOff && offbeats.length ? offbeats : downbeats;
      if (!source.length) break;
      chosen.push(source.pop());
    }
    chosen.sort((a, b) => a - b);

    let previous = null;
    for (const beat of chosen) {
      let degree;
      if (previous !== null && rng() < density * 0.55) {
        // passing tone: step to a neighbouring scale degree
        degree = previous + (rng() < 0.5 ? -1 : 1);
      } else {
        // chord tone (root / third / fifth of the stack), sometimes an octave up
        degree = pick([0, 2, 4], rng) + (rng() < 0.25 ? scaleLength : 0);
      }
      degree = Math.round(clamp(degree, -2, scaleLength * 2));
      previous = degree;
      notes.push({
        bar,
        beat,
        degree,
        duration: rng() < 0.3 ? 2 : 1,
        velocity: 0.55 + rng() * 0.35,
      });
    }
  }
  return { bars, notes };
}

// -- song structure ---------------------------------------------------------

const WAVES_PERIOD = 16;
const BUILD_BARS = 32;
const BUILD_RELEASE_BARS = 8;

const PRESET_BLOCKS = Object.freeze({
  abab: [
    { label: 'A', bars: 8, intensity: 0.4 },
    { label: 'B', bars: 8, intensity: 0.7 },
  ],
  journey: [
    { label: 'A', bars: 8, intensity: 0.35 },
    { label: 'A', bars: 8, intensity: 0.45 },
    { label: 'B', bars: 8, intensity: 0.65 },
    { label: 'A', bars: 8, intensity: 0.45 },
    { label: 'C', bars: 8, intensity: 0.8 },
    { label: 'B', bars: 8, intensity: 0.6 },
  ],
});

/**
 * Which preset actually plays. 'auto' picks from complexity; 'custom' with no
 * usable blocks degrades to that same auto choice rather than going silent.
 */
export function resolveStructure(structure, complexity = 0.5, customStructure = []) {
  const c = clamp(Number.isFinite(Number(complexity)) ? Number(complexity) : 0.5, 0, 1);
  const auto = c < 0.33 ? 'drone' : c < 0.55 ? 'waves' : c < 0.75 ? 'abab' : 'journey';
  if (structure === 'custom') {
    return Array.isArray(customStructure) && customStructure.length ? 'custom' : auto;
  }
  if (typeof structure !== 'string' || !STRUCTURES.includes(structure) || structure === 'auto') {
    return auto;
  }
  return structure;
}

/**
 * The section in force during `bar` (0-based, counted from the moment the
 * structure was last (re)started). Pure, so the sequencing is unit-testable.
 */
export function sectionAtBar(preset, bar, customStructure = []) {
  const index = Math.max(0, Math.floor(Number(bar) || 0));
  if (preset === 'drone') return { label: 'A', intensity: 0.35 };
  if (preset === 'waves') {
    const phase = (index % WAVES_PERIOD) / WAVES_PERIOD;
    return { label: 'A', intensity: round3(0.5 - 0.25 * Math.cos(2 * Math.PI * phase)) };
  }
  if (preset === 'build') {
    const b = index % (BUILD_BARS + BUILD_RELEASE_BARS);
    if (b < BUILD_BARS) {
      return { label: 'A', intensity: round3(0.2 + 0.65 * (b / (BUILD_BARS - 1))) };
    }
    const t = (b - BUILD_BARS + 1) / BUILD_RELEASE_BARS;
    return { label: 'B', intensity: round3(0.85 - 0.55 * t) };
  }
  const blocks = preset === 'custom' ? customStructure : PRESET_BLOCKS[preset];
  if (!Array.isArray(blocks) || !blocks.length) return { label: 'A', intensity: 0.35 };
  const total = blocks.reduce((sum, block) => sum + block.bars, 0);
  let pos = index % total;
  for (const block of blocks) {
    if (pos < block.bars) return { label: block.label, intensity: block.intensity };
    pos -= block.bars;
  }
  return { label: blocks[0].label, intensity: blocks[0].intensity };
}

/**
 * Which 'auto' tracks play at this section intensity and complexity. The
 * thresholds rise along TRACK_ORDER, so the active set is always a prefix of
 * it: pad first, arp and percussion last to join.
 */
const AUTO_THRESHOLDS = Object.freeze({
  pad: 0, bass: 0.12, melody: 0.3, texture: 0.45, arp: 0.62, percussion: 0.78,
});

export function autoActiveTracks(intensity = 0.5, complexity = 0.5) {
  const energy = 0.55 * clamp(Number(intensity) || 0, 0, 1) + 0.45 * clamp(Number(complexity) || 0, 0, 1);
  return TRACK_ORDER.filter((name) => energy >= AUTO_THRESHOLDS[name]);
}

// -- arpeggiator ------------------------------------------------------------

/** Pattern/rate/octaves/density the arp uses in `mode: 'auto'`. */
export function autoArpSettings(complexity = 0.5) {
  const c = clamp(Number(complexity) || 0, 0, 1);
  return {
    mode: 'auto',
    pattern: c < 0.35 ? 'up' : c < 0.65 ? 'updown' : c < 0.85 ? 'down' : 'random',
    rate: c < 0.3 ? '1/4' : c < 0.55 ? '1/8' : c < 0.8 ? '1/8T' : '1/16',
    octaves: c < 0.4 ? 1 : c < 0.75 ? 2 : 3,
    density: round3(0.3 + c * 0.55),
  };
}

/**
 * The note order the arp walks. 'random' returns the plain ascending pool and
 * the caller draws from it; 'updown' folds back without repeating the top and
 * bottom notes.
 */
export function buildArpSequence(chordMidis, pattern = 'up', octaves = 1) {
  const base = Array.from(new Set(chordMidis)).sort((a, b) => a - b);
  if (!base.length) return [];
  const span = clamp(Math.round(octaves) || 1, 1, 3);
  const pool = [];
  for (let o = 0; o < span; o++) {
    for (const midi of base) pool.push(midi + 12 * o);
  }
  if (pattern === 'down') return pool.slice().reverse();
  if (pattern === 'updown') {
    if (pool.length < 3) return pool.slice();
    return pool.concat(pool.slice(1, -1).reverse());
  }
  return pool;
}

/**
 * One bar of ambient percussion: a soft low pulse near the bar start, at most
 * one more low later in the bar, and a couple of mid/high accents. Never a
 * groove — the hit count is capped at five however dense things get.
 */
export function generatePercussionPattern({ pulses = [1, 1, 1, 1], density = 0.5, rng = Math.random } = {}) {
  const d = clamp(Number(density) || 0, 0, 1);
  const count = Array.isArray(pulses) && pulses.length ? pulses.length : 4;
  const hits = [];
  if (rng() < 0.55 + d * 0.4) {
    hits.push({ pulse: 0, offset: rng() * 0.05, kind: 'low', velocity: round3(0.55 + rng() * 0.25) });
  }
  if (count > 2 && rng() < d * 0.55) {
    hits.push({
      pulse: 1 + Math.floor(rng() * (count - 1)),
      offset: rng() * 0.05,
      kind: 'low',
      velocity: round3(0.35 + rng() * 0.2),
    });
  }
  const accents = Math.round(d * 3);
  for (let i = 0; i < accents; i++) {
    if (rng() > 0.35 + d * 0.5) continue;
    hits.push({
      pulse: Math.floor(rng() * count) % count,
      offset: rng() * 0.5,
      kind: rng() < 0.45 ? 'mid' : 'high',
      velocity: round3(0.25 + rng() * 0.35),
    });
  }
  hits.sort((a, b) => a.pulse - b.pulse || a.offset - b.offset);
  return hits;
}

// ---------------------------------------------------------------------------
// 4. Fallback voices + audio graph
// ---------------------------------------------------------------------------

const LOOKAHEAD = 0.12;      // seconds of audio scheduled ahead of the clock
const TICK_MS = 25;          // scheduler wake-up interval
const FADE_OUT = 0.5;        // stop() fade
const FADE_IN = 1.2;         // start() fade
const SILENCE = 0.0001;      // exponential ramps cannot reach zero
const MASTER_HEADROOM = 0.7; // keeps volume=1 comfortably clear of clipping

/** Pitches the fallback percussion voice uses for each hit kind. */
const PERCUSSION_TONES = { low: 72, mid: 220, high: 1500 };

/**
 * Minimal single-oscillator voice used when engine-voices.js cannot be loaded
 * (a bare Node import, a failed chunk fetch). Deliberately plain: it keeps the
 * engine audible and testable without pretending to be the real voice library.
 */
function fallbackVoice(config) {
  return {
    label: config.label,
    play(ctx, destination, note) {
      const freq = note.freq ?? PERCUSSION_TONES[note.kind] ?? 220;
      const when = Number.isFinite(note.when) ? note.when : ctx.currentTime;
      const duration = Math.max(0.05, note.duration || 0.3);
      const attack = Math.min(config.attack, duration * 0.5);
      const sustain = Math.max(attack, duration);
      const peak = Math.max(config.peak * clamp(note.velocity ?? 0.7, 0, 1), SILENCE * 2);
      const end = when + sustain + config.release;

      const panner = ctx.createStereoPanner();
      panner.pan.value = clamp(note.pan ?? 0, -1, 1);
      panner.connect(destination);

      const amp = ctx.createGain();
      amp.connect(panner);
      amp.gain.setValueAtTime(SILENCE, when);
      amp.gain.exponentialRampToValueAtTime(peak, when + attack);
      amp.gain.setValueAtTime(peak, when + sustain);
      amp.gain.exponentialRampToValueAtTime(SILENCE, end);

      const osc = ctx.createOscillator();
      osc.type = config.type;
      osc.frequency.setValueAtTime(freq, when);
      if (config.pitchDrop) {
        osc.frequency.exponentialRampToValueAtTime(
          Math.max(freq * config.pitchDrop, 20), when + sustain,
        );
      }
      osc.connect(amp);
      osc.onended = () => {
        osc.disconnect();
        amp.disconnect();
        panner.disconnect();
      };
      osc.start(when);
      osc.stop(end + 0.02);

      return { cancel() { osc.stop(ctx.currentTime); } };
    },
  };
}

export const FALLBACK_VOICES = Object.freeze({
  pad: { warm: fallbackVoice({ label: 'Warm', type: 'sine', peak: 0.22, attack: 1.5, release: 2.5 }) },
  bass: { sub: fallbackVoice({ label: 'Sub', type: 'sine', peak: 0.3, attack: 0.08, release: 0.6 }) },
  melody: { pluck: fallbackVoice({ label: 'Pluck', type: 'triangle', peak: 0.18, attack: 0.01, release: 0.5 }) },
  texture: { sparkle: fallbackVoice({ label: 'Sparkle', type: 'sine', peak: 0.1, attack: 0.01, release: 2 }) },
  arp: { softPluck: fallbackVoice({ label: 'Soft pluck', type: 'triangle', peak: 0.14, attack: 0.008, release: 0.35 }) },
  percussion: {
    soft: fallbackVoice({
      label: 'Soft kit', type: 'sine', peak: 0.24, attack: 0.004, release: 0.14, pitchDrop: 0.5,
    }),
  },
});

/**
 * Dry level, tone ceiling and effect-send amounts per track. Levels are lower
 * than v1's four-track set: six sources sum, so pad/bass keep the bulk of the
 * budget and the four decorative tracks each sit well under it. Worst case
 * (every track on, velocity 1) lands under unity before the master's 0.7
 * headroom and the glue compressor.
 */
const TRACK_MIX = {
  pad: { level: 0.36, dry: 0.8, reverb: 0.45, delay: 0.1, tone: 4000 },
  bass: { level: 0.44, dry: 1.0, reverb: 0.08, delay: 0.0, tone: 12000 },
  melody: { level: 0.28, dry: 0.75, reverb: 0.5, delay: 0.28, tone: 6000 },
  texture: { level: 0.2, dry: 0.6, reverb: 0.7, delay: 0.35, tone: 12000 },
  arp: { level: 0.2, dry: 0.7, reverb: 0.45, delay: 0.25, tone: 6500 },
  percussion: { level: 0.24, dry: 0.85, reverb: 0.3, delay: 0.12, tone: 9000 },
};

function audioContextCtor() {
  const g = globalThis;
  return g.AudioContext || g.webkitAudioContext || null;
}

/** True when this environment can actually make sound. */
export function isSupported() {
  return audioContextCtor() !== null;
}

/**
 * Procedural impulse response: stereo noise under an exponential decay, with a
 * few milliseconds of fade-in so the reverb blooms instead of cracking.
 */
function createImpulseResponse(ctx, seconds = 4, decay = 3.2) {
  const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  const fadeIn = Math.max(1, ctx.sampleRate * 0.01);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      const t = i / length;
      const envelope = Math.pow(1 - t, decay) * (1 - Math.exp(-i / fadeIn));
      data[i] = (Math.random() * 2 - 1) * envelope;
    }
  }
  return buffer;
}

function buildGraph(ctx) {
  const master = ctx.createGain();
  master.gain.value = SILENCE;

  // Gentle glue compressor — a safety net against unlucky note pile-ups, not
  // the thing doing the mixing.
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -18;
  compressor.knee.value = 24;
  compressor.ratio.value = 3;
  compressor.attack.value = 0.02;
  compressor.release.value = 0.3;
  master.connect(compressor);
  compressor.connect(ctx.destination);

  const convolver = ctx.createConvolver();
  convolver.normalize = true;
  convolver.buffer = createImpulseResponse(ctx);
  const reverbReturn = ctx.createGain();
  reverbReturn.gain.value = 0.9;
  convolver.connect(reverbReturn);
  reverbReturn.connect(master);

  // Dotted-eighth feedback delay; delayTime is retuned to tempo at bar starts.
  const delay = ctx.createDelay(2);
  delay.delayTime.value = 0.75;
  const feedback = ctx.createGain();
  feedback.gain.value = 0.3;
  const delayTone = ctx.createBiquadFilter();
  delayTone.type = 'lowpass';
  delayTone.frequency.value = 2600;
  const delayReturn = ctx.createGain();
  delayReturn.gain.value = 0.5;
  delay.connect(delayTone);
  delayTone.connect(feedback);
  feedback.connect(delay);
  delayTone.connect(delayReturn);
  delayReturn.connect(master);

  const tracks = {};
  for (const name of TRACK_ORDER) {
    const mix = TRACK_MIX[name];
    const input = ctx.createGain();
    input.gain.value = SILENCE;
    // Section intensity opens and closes this filter — the "brightness" the
    // structure asks for, applied engine-side because voices own their timbre.
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = mix.tone;
    tone.Q.value = 0.4;
    const dry = ctx.createGain();
    dry.gain.value = mix.dry;
    const reverbSend = ctx.createGain();
    reverbSend.gain.value = mix.reverb;
    const delaySend = ctx.createGain();
    delaySend.gain.value = mix.delay;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.75;

    input.connect(tone);
    tone.connect(dry);
    dry.connect(master);
    tone.connect(reverbSend);
    reverbSend.connect(convolver);
    if (mix.delay > 0) {
      tone.connect(delaySend);
      delaySend.connect(delay);
    }
    tone.connect(analyser);
    tracks[name] = { input, tone, dry, reverbSend, delaySend, analyser };
  }

  return { master, compressor, convolver, delay, feedback, tracks };
}

// ---------------------------------------------------------------------------
// 5. Public engine
// ---------------------------------------------------------------------------

let voicesPromise = null;

/**
 * The voice library, or the fallback set if it is unavailable. Cached across
 * engines; the import is deliberately inside a function so importing this
 * module stays side-effect free.
 */
function loadVoices() {
  if (!voicesPromise) {
    voicesPromise = import('./engine-voices.js')
      .then((mod) => (mod && mod.VOICES && typeof mod.VOICES === 'object' ? mod.VOICES : FALLBACK_VOICES))
      .catch(() => FALLBACK_VOICES);
  }
  return voicesPromise;
}

export function createEngine(initialParams) {
  let params = sanitiseParams(initialParams);

  let ctx = null;
  let graph = null;
  let voices = null;
  let isRunning = false;
  let tickTimer = null;
  let suspendTimer = null;

  // Scheduler state
  let nextPulseTime = 0;
  let pulseIndex = 0;
  let bar = null;              // tempo/metre snapshot, refreshed at each bar start
  let barIndex = 0;            // bars since start(), for events
  let delayTarget = 0;

  // Structure state
  let structureKey = '';
  let structureBar = 0;        // bars since this structure started
  let currentSection = { label: 'A', intensity: 0.35 };
  let sectionAnnounced = false;

  // Harmonic state
  let progression = [];
  let progressionIndex = 0;
  let chordDegree = 0;
  let chordBarsLeft = 0;

  // Melodic state
  let phraseBank = [];
  let currentPhrase = null;
  let phraseBarIndex = 0;
  let phraseBarsLeft = 0;

  // Arp + percussion state
  let arpPlan = [];
  let arpStep = 0;             // position in the 16-step mask, continuous across bars
  let arpCursor = 0;           // position in the note sequence
  let autoArpSteps = null;
  let percussionPlan = [];
  let percussionBank = [];

  const listeners = new Map();
  const rng = Math.random;
  const scale = () => SCALES[params.mode];

  // -- events ----------------------------------------------------------------

  function on(type, callback) {
    if (typeof type !== 'string' || typeof callback !== 'function') return () => {};
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(callback);
    return () => {
      const set = listeners.get(type);
      if (set) set.delete(callback);
    };
  }

  function emit(type, payload) {
    const set = listeners.get(type);
    if (!set || !set.size) return;
    for (const callback of [...set]) {
      try {
        callback(payload);
      } catch {
        // A faulty listener must never take the scheduler down with it.
      }
    }
  }

  // -- track activity --------------------------------------------------------

  function sectionIntensity() {
    return currentSection ? currentSection.intensity : 0.5;
  }

  function isActive(name) {
    const state = params.tracks[name].state;
    if (state === 'on') return true;
    if (state === 'off') return false;
    return autoActiveTracks(sectionIntensity(), params.complexity).includes(name);
  }

  /** Effective harmonic colour: complexity, opened up by section intensity. */
  function colour() {
    return clamp(params.complexity * (0.6 + sectionIntensity() * 0.6), 0, 1);
  }

  // -- live parameter application -------------------------------------------

  /**
   * Track gains and brightness. Written with setTargetAtTime so it can be
   * scheduled at a future bar boundary without cancelling the master fade or
   * jumping from whatever value the ramp happens to be passing through.
   */
  function applyTracks(rampSeconds, when = null) {
    if (!ctx || !graph) return;
    const time = when ?? ctx.currentTime;
    const intensity = sectionIntensity();
    const constant = Math.max(rampSeconds / 3, 0.02);
    for (const name of TRACK_ORDER) {
      const track = graph.tracks[name];
      const level = isActive(name) ? TRACK_MIX[name].level : SILENCE;
      track.input.gain.setTargetAtTime(Math.max(level, SILENCE), time, constant);
      const brightness = clamp(TRACK_MIX[name].tone * (0.55 + intensity * 0.75), 300, 18000);
      track.tone.frequency.setTargetAtTime(brightness, time, constant);
    }
  }

  function applyLevels(rampSeconds) {
    if (!ctx || !graph) return;
    const now = ctx.currentTime;
    const target = Math.max(params.volume * MASTER_HEADROOM, SILENCE);
    graph.master.gain.cancelScheduledValues(now);
    graph.master.gain.setValueAtTime(Math.max(graph.master.gain.value, SILENCE), now);
    graph.master.gain.exponentialRampToValueAtTime(isRunning ? target : SILENCE, now + rampSeconds);

    applyTracks(rampSeconds);

    // Feedback rises a little with complexity but never past the safe ceiling.
    const feedback = 0.18 + params.complexity * 0.17;
    graph.feedback.gain.setTargetAtTime(clamp(feedback, 0, 0.35), now, 0.2);
  }

  function retuneDelay(time, secPerBeat) {
    const wanted = clamp(secPerBeat * 0.75, 0.05, 2);
    if (Math.abs(wanted - delayTarget) < 0.005) return;
    delayTarget = wanted;
    // setTargetAtTime glides rather than jumps: a delay-line jump would pitch-
    // shift whatever is still echoing.
    graph.delay.delayTime.setTargetAtTime(wanted, time, 0.25);
  }

  // -- note dispatch ---------------------------------------------------------

  function voiceFor(track) {
    const wanted = params.tracks[track].voice;
    const bank = voices && voices[track] && Object.keys(voices[track]).length
      ? voices[track]
      : FALLBACK_VOICES[track];
    // A voice id the library does not know (stale localStorage, renamed voice)
    // falls back to that track's first voice rather than going silent.
    const chosen = bank[wanted] ?? bank[Object.keys(bank)[0]];
    if (chosen && typeof chosen.play === 'function') return chosen;
    const spare = FALLBACK_VOICES[track][Object.keys(FALLBACK_VOICES[track])[0]];
    return spare ?? null;
  }

  function playNote(track, note) {
    const midi = note.midi ?? null;
    const full = {
      midi,
      freq: note.freq ?? (midi === null ? null : midiToFreq(midi)),
      velocity: clamp(Number(note.velocity) || 0.7, 0.01, 1),
      duration: Math.max(0.02, Number(note.duration) || 0.3),
      when: note.when,
      pan: clamp(Number(note.pan) || 0, -1, 1),
      kind: note.kind ?? null,
    };
    const voice = voiceFor(track);
    if (voice) {
      try {
        voice.play(ctx, graph.tracks[track].input, full);
      } catch {
        // A broken voice loses its note, not the whole performance.
      }
    }
    emit('note', {
      track,
      midi: full.midi,
      kind: full.kind,
      velocity: full.velocity,
      time: full.when,
      duration: full.duration,
    });
  }

  // -- harmony / phrase choice ----------------------------------------------

  function chooseChord() {
    const n = scale().length;
    if (!progression.length) {
      progression = generateProgression(n, params.complexity, rng);
      progressionIndex = 0;
      return progression[0];
    }
    progressionIndex = (progressionIndex + 1) % progression.length;
    if (rng() < params.repetition) {
      // reuse the stored loop
      return progression[progressionIndex] % n;
    }
    // wander, and let the wandering slowly rewrite the loop
    const fresh = nextChordDegree(chordDegree, n, params.complexity, rng);
    progression[progressionIndex] = fresh;
    return fresh;
  }

  function choosePhrase() {
    const bars = rng() < 0.5 || params.complexity < 0.3 ? 1 : 2;
    if (phraseBank.length && rng() < params.repetition) {
      const stored = pick(phraseBank, rng);
      if (rng() < params.complexity * 0.4) {
        // transpose the stored phrase within the scale for gentle variation
        const shift = pick([-2, -1, 1, 2], rng);
        return {
          bars: stored.bars,
          notes: stored.notes.map((n) => ({ ...n, degree: n.degree + shift })),
        };
      }
      return stored;
    }
    const phrase = generatePhrase({
      beatsPerBar: beatsPerBar(params.timeSignature),
      bars,
      complexity: params.complexity,
      scaleLength: scale().length,
      rng,
    });
    phraseBank.push(phrase);
    if (phraseBank.length > 8) phraseBank.shift();
    return phrase;
  }

  /** The current chord, voiced upward from `baseOctave` with no crossings. */
  function chordMidis(baseOctave, maxNotes) {
    const degrees = buildChord(chordDegree, colour()).slice(0, maxNotes);
    const midis = [];
    let previous = -Infinity;
    for (const degree of degrees) {
      let midi = scaleDegreeToMidi(degree, scale(), pitchClass(params.root), baseOctave);
      while (midi <= previous) midi += 12;
      previous = midi;
      midis.push(midi);
    }
    return midis;
  }

  // -- per-track bar planning ------------------------------------------------

  function playChordVoicing(time, duration) {
    const midis = chordMidis(3, colour() > 0.5 ? 4 : 3);
    // Velocity per note shrinks as the voicing thickens, keeping the pad's
    // total contribution roughly constant.
    const velocity = clamp(0.85 / Math.sqrt(midis.length), 0.15, 1);
    midis.forEach((midi, i) => {
      const spread = midis.length > 1 ? (i / (midis.length - 1) - 0.5) * 0.5 : 0;
      playNote('pad', { midi, when: time, duration, velocity, pan: spread });
    });
  }

  function scheduleBass(time, barDuration) {
    const root = scaleDegreeToMidi(chordDegree, scale(), pitchClass(params.root), 2);
    const twoNotes = rng() < 0.25 + params.complexity * 0.3 + sectionIntensity() * 0.2;
    if (!twoNotes) {
      playNote('bass', { midi: root, when: time, duration: barDuration * 0.9, velocity: 0.8 });
      return;
    }
    playNote('bass', { midi: root, when: time, duration: barDuration * 0.45, velocity: 0.8 });
    // Second note is usually the fifth above, snapped back into the mode.
    const second = rng() < 0.6
      ? quantiseToScale(root + 7, scale(), pitchClass(params.root))
      : root;
    playNote('bass', {
      midi: second,
      when: time + barDuration * 0.5,
      duration: barDuration * 0.45,
      velocity: 0.7,
    });
  }

  /** Manual arp settings verbatim, or the complexity-derived auto ones. */
  function effectiveArp(intensity) {
    if (params.arp.mode === 'manual') return params.arp;
    const auto = autoArpSettings(params.complexity);
    const density = clamp(auto.density * (0.45 + intensity * 0.8), 0, 1);
    // Repetition decides how often the auto step mask is rewritten.
    if (!autoArpSteps || rng() > params.repetition) {
      autoArpSteps = new Array(ARP_STEP_COUNT);
      for (let i = 0; i < ARP_STEP_COUNT; i++) {
        const weight = i % 4 === 0 ? 0.35 : i % 2 === 0 ? 0.15 : 0;
        autoArpSteps[i] = rng() < clamp(density + weight, 0, 1);
      }
    }
    return { ...auto, gate: params.arp.gate, steps: autoArpSteps };
  }

  /** Grid positions for one bar of arpeggio. Swing-free by construction. */
  function planArp(intensity) {
    const cfg = effectiveArp(intensity);
    const stepBeats = ARP_RATES[cfg.rate] ?? 0.5;
    const sequence = buildArpSequence(chordMidis(4, 4), cfg.pattern, cfg.octaves);
    if (!sequence.length) return [];
    const plan = [];
    let steps = 0;
    for (let beat = 0; beat < bar.beats - 1e-6; beat += stepBeats) {
      const maskIndex = (arpStep + steps) % ARP_STEP_COUNT;
      steps += 1;
      if (!cfg.steps[maskIndex]) continue;
      const midi = cfg.pattern === 'random'
        ? sequence[Math.floor(rng() * sequence.length) % sequence.length]
        : sequence[(arpCursor + steps - 1) % sequence.length];
      const accent = maskIndex % 4 === 0;
      plan.push({
        beat,
        midi: Math.min(midi, 96),
        duration: Math.max(0.05, stepBeats * cfg.gate * bar.secPerBeat),
        velocity: clamp((accent ? 0.62 : 0.45) * (0.6 + intensity * 0.55) + rng() * 0.08, 0.05, 1),
        pan: (((maskIndex % 4) - 1.5) / 1.5) * 0.3,
      });
    }
    arpStep = (arpStep + steps) % ARP_STEP_COUNT;
    arpCursor = (arpCursor + steps) % sequence.length;
    return plan;
  }

  function choosePercussion(intensity) {
    const density = clamp(0.15 + intensity * params.complexity * 1.2, 0, 1);
    if (percussionBank.length && rng() < params.repetition) return pick(percussionBank, rng);
    const pattern = generatePercussionPattern({ pulses: bar.pulses, density, rng });
    percussionBank.push(pattern);
    if (percussionBank.length > 6) percussionBank.shift();
    return pattern;
  }

  // -- scheduler -------------------------------------------------------------

  /**
   * Snapshot tempo, metre and section for the bar about to start, then schedule
   * the bar-level events (chord change, pad voicing, bass, arp and percussion
   * plans). bpm, speed, time signature, root, mode and structure are read here
   * and nowhere else, which is what quantises those changes to bar boundaries.
   */
  function beginBar(time) {
    const pulses = TIME_SIGNATURES[params.timeSignature];
    const secPerBeat = 60 / clamp(params.bpm * params.speed, 10, 400);
    const starts = [];
    let acc = 0;
    for (const p of pulses) {
      starts.push(acc);
      acc += p;
    }
    bar = { pulses, starts, beats: acc, secPerBeat, duration: acc * secPerBeat };

    retuneDelay(time, secPerBeat);

    const preset = resolveStructure(params.structure, params.complexity, params.customStructure);
    const key = preset === 'custom'
      ? `custom:${params.customStructure.map((b) => `${b.label}${b.bars}${b.intensity}`).join(',')}`
      : preset;
    if (key !== structureKey) {
      // A new structure starts from its own bar zero rather than mid-cycle.
      structureKey = key;
      structureBar = 0;
    }
    const section = sectionAtBar(preset, structureBar, params.customStructure);

    emit('bar', { bar: barIndex, beatsPerBar: bar.beats, time });
    // The opening section is always announced, so a listener that subscribes
    // before start() learns where the piece begins.
    const changed = section.label !== currentSection.label
      || section.intensity !== currentSection.intensity;
    if (changed || !sectionAnnounced) {
      sectionAnnounced = true;
      currentSection = section;
      applyTracks(0.4, time);
      emit('section', {
        label: section.label,
        intensity: section.intensity,
        bar: barIndex,
        time,
      });
    }
    const intensity = sectionIntensity();

    if (chordBarsLeft <= 0) {
      chordDegree = chooseChord();
      // Slower harmonic rhythm when the listener wants repetition.
      chordBarsLeft = rng() < 0.5 + params.repetition * 0.2 ? 2 : 1;
      if (isActive('pad')) playChordVoicing(time, bar.duration * chordBarsLeft);
    }
    chordBarsLeft -= 1;

    if (isActive('bass')) scheduleBass(time, bar.duration);

    if (phraseBarsLeft <= 0) {
      currentPhrase = choosePhrase();
      phraseBarsLeft = currentPhrase.bars;
      phraseBarIndex = 0;
    } else {
      phraseBarIndex += 1;
    }
    phraseBarsLeft -= 1;

    arpPlan = isActive('arp') ? planArp(intensity) : [];
    percussionPlan = isActive('percussion') ? choosePercussion(intensity) : [];

    barIndex += 1;
    structureBar += 1;
  }

  /** Schedule the events that fall inside one pulse of the current bar. */
  function schedulePulse(time, index) {
    const from = bar.starts[index];
    const length = bar.pulses[index];
    const to = from + length;
    const intensity = sectionIntensity();

    if (currentPhrase && isActive('melody')) {
      for (const note of currentPhrase.notes) {
        if (note.bar !== phraseBarIndex || note.beat < from || note.beat >= to) continue;
        // Quieter sections thin the line out rather than muting it.
        if (rng() > 0.55 + intensity * 0.45) continue;
        const at = time + (note.beat - from) * bar.secPerBeat;
        let midi = scaleDegreeToMidi(
          chordDegree + note.degree, scale(), pitchClass(params.root), 4,
        );
        // keep the melody in octaves 4–5
        while (midi > 83) midi -= 12;
        while (midi < 60) midi += 12;
        playNote('melody', {
          midi,
          when: at,
          duration: clamp(note.duration * bar.secPerBeat * 1.6, 0.6, 3),
          velocity: note.velocity,
          pan: between(-0.25, 0.25, rng),
        });
      }
    }

    if (isActive('texture')) {
      const chance = clamp((0.05 + params.complexity * 0.3) * (0.5 + intensity), 0, 1);
      if (rng() < chance) {
        const degree = Math.floor(rng() * scale().length * 2);
        let midi = scaleDegreeToMidi(degree, scale(), pitchClass(params.root), 6);
        while (midi > 100) midi -= 12;
        while (midi < 79) midi += 12;
        playNote('texture', {
          midi,
          when: time + rng() * length * bar.secPerBeat,
          duration: between(3, 6, rng),
          velocity: between(0.3, 0.6, rng),
          pan: between(-0.8, 0.8, rng),
        });
      }
    }

    for (const step of arpPlan) {
      if (step.beat < from || step.beat >= to) continue;
      playNote('arp', {
        midi: step.midi,
        when: time + (step.beat - from) * bar.secPerBeat,
        duration: step.duration,
        velocity: step.velocity,
        pan: step.pan,
      });
    }

    for (const hit of percussionPlan) {
      if (hit.pulse !== index) continue;
      const offset = Math.min(hit.offset, length * 0.9);
      playNote('percussion', {
        midi: null,
        freq: null,
        kind: hit.kind,
        when: time + offset * bar.secPerBeat,
        duration: hit.kind === 'low' ? 0.4 : hit.kind === 'mid' ? 0.22 : 0.14,
        velocity: hit.velocity,
        pan: hit.kind === 'low' ? 0 : between(-0.6, 0.6, rng),
      });
    }
  }

  function tick() {
    if (!ctx || !isRunning) return;
    // A throttled or suspended tab can leave the scheduler well behind the
    // audio clock. Resync to a fresh bar rather than dumping every missed event
    // into the present.
    if (nextPulseTime < ctx.currentTime - 0.25) {
      nextPulseTime = ctx.currentTime + 0.05;
      pulseIndex = 0;
    }
    const horizon = ctx.currentTime + LOOKAHEAD;
    // The guard stops a pathological clock (a suspended tab resuming with a
    // large jump) from scheduling an unbounded burst in one pass.
    let guard = 0;
    while (nextPulseTime < horizon && guard++ < 64) {
      if (pulseIndex === 0) beginBar(nextPulseTime);
      schedulePulse(nextPulseTime, pulseIndex);
      nextPulseTime += bar.pulses[pulseIndex] * bar.secPerBeat;
      pulseIndex += 1;
      if (pulseIndex >= bar.pulses.length) pulseIndex = 0;
    }
  }

  // -- transport -------------------------------------------------------------

  async function start() {
    if (isRunning) return;
    const Ctor = audioContextCtor();
    if (!Ctor) throw new Error('ambient-engine: Web Audio API is not available in this environment');

    if (!voices) voices = await loadVoices();
    if (!ctx) {
      ctx = new Ctor();
      graph = buildGraph(ctx);
    }
    if (suspendTimer !== null) {
      clearTimeout(suspendTimer);
      suspendTimer = null;
    }
    // Must be reached from a user gesture for browsers to allow audio.
    if (ctx.state === 'suspended') await ctx.resume();

    isRunning = true;
    phraseBarsLeft = 0;
    chordBarsLeft = 0;
    pulseIndex = 0;
    barIndex = 0;
    structureBar = 0;
    structureKey = '';
    sectionAnnounced = false;
    arpStep = 0;
    arpCursor = 0;
    arpPlan = [];
    percussionPlan = [];
    delayTarget = 0;
    currentSection = sectionAtBar(
      resolveStructure(params.structure, params.complexity, params.customStructure),
      0,
      params.customStructure,
    );
    nextPulseTime = ctx.currentTime + 0.15;
    if (!progression.length) {
      progression = generateProgression(scale().length, params.complexity, rng);
      progressionIndex = 0;
      chordDegree = progression[0];
    }
    applyLevels(FADE_IN);
    tickTimer = setInterval(tick, TICK_MS);
    tick();
    emit('state', { running: true });
  }

  function stop() {
    if (tickTimer !== null) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
    if (!isRunning) return;
    isRunning = false;
    emit('state', { running: false });
    if (!ctx || !graph) return;
    applyLevels(FADE_OUT);
    suspendTimer = setTimeout(() => {
      suspendTimer = null;
      // A start() during the fade cancels this timer, so reaching here means we
      // are still stopped.
      if (!isRunning && ctx && ctx.state === 'running') ctx.suspend();
    }, (FADE_OUT + 0.2) * 1000);
  }

  function setParams(partial) {
    params = sanitiseParams(partial, params);
    if (ctx && graph) applyLevels(0.15);
  }

  function getParams() {
    return copyParams(params);
  }

  function getAnalysers() {
    return Object.fromEntries(
      TRACK_ORDER.map((name) => [name, graph ? graph.tracks[name].analyser : null]),
    );
  }

  function now() {
    return ctx ? ctx.currentTime : 0;
  }

  return {
    start,
    stop,
    get running() {
      return isRunning;
    },
    setParams,
    getParams,
    getAnalysers,
    on,
    now,
  };
}

export default createEngine;
