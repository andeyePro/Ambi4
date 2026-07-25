/**
 * ambient-engine.js — procedural six-track ambient generator.
 *
 * Pure Web Audio API, no dependencies, no assets, no network. Import from an
 * Astro page's <script type="module"> and drive it with createEngine().
 *
 * Importing this module in a non-browser environment is safe: nothing touches
 * AudioContext until arm() or start() is called, and the voice library is
 * pulled in with a dynamic import from there (falling back to the built-in sine
 * voices below if it is missing).
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

/** Oscillator shapes a patch may ask a subtractive voice for. */
export const PATCH_OSC_TYPES = Object.freeze(['sine', 'triangle', 'sawtooth', 'square']);

export const PATCH_FILTER_TYPES = Object.freeze(['lowpass', 'highpass', 'bandpass', 'notch']);

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
  // Sparse by design: an absent track/voice/section/field means "voice default".
  patches: Object.freeze({}),
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
 * A number inside [lo, hi], or undefined when the value is not usable. Patch
 * fields are sparse, so an unusable field is dropped rather than defaulted —
 * defaulting here would silently overwrite the voice's own default.
 */
function patchNumber(value, lo, hi) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return undefined;
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? clamp(num, lo, hi) : undefined;
}

/**
 * Per-field coercion for the Patch schema. Every entry returns undefined for a
 * value it cannot use, which is what drops the field from the sanitised patch.
 */
/** v5 morph positions of the legacy oscillator names. */
const OSC_SHAPES = Object.freeze({ sine: 0, triangle: 1, sawtooth: 2, square: 3 });

const PATCH_SCHEMA = Object.freeze({
  source: Object.freeze({
    osc1: (v) => oneOf(v, PATCH_OSC_TYPES, undefined),
    // A null osc2 is meaningful: "single oscillator", not "unset".
    osc2: (v) => (v === null ? null : oneOf(v, PATCH_OSC_TYPES, undefined)),
    // v5 morph dial: 0 sine, 1 triangle, 2 sawtooth, 3 square; fractional legal.
    shape1: (v) => patchNumber(v, 0, 3),
    shape2: (v) => (v === null ? null : patchNumber(v, 0, 3)),
    mix: (v) => patchNumber(v, 0, 1),
    detune: (v) => patchNumber(v, 0, 50),
    octave: (v) => {
      const num = patchNumber(v, -1, 1);
      return num === undefined ? undefined : Math.round(num);
    },
  }),
  filter: Object.freeze({
    type: (v) => oneOf(v, PATCH_FILTER_TYPES, undefined),
    cutoff: (v) => patchNumber(v, 40, 12000),
    q: (v) => patchNumber(v, 0.1, 20),
    envAmount: (v) => patchNumber(v, 0, 1),
  }),
  adsr: Object.freeze({
    attack: (v) => patchNumber(v, 0.001, 8),
    decay: (v) => patchNumber(v, 0.001, 8),
    sustain: (v) => patchNumber(v, 0, 1),
    release: (v) => patchNumber(v, 0.01, 12),
  }),
  sends: Object.freeze({
    reverb: (v) => patchNumber(v, 0, 1),
    delay: (v) => patchNumber(v, 0, 1),
  }),
});

/** One patch, clamped and stripped of unknown keys. null when nothing survives. */
function sanitisePatch(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const [section, fields] of Object.entries(PATCH_SCHEMA)) {
    const raw = value[section];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const clean = {};
    for (const [key, coerce] of Object.entries(fields)) {
      if (!(key in raw)) continue;
      const coerced = coerce(raw[key]);
      if (coerced !== undefined) clean[key] = coerced;
    }
    if (section === 'source') {
      // Legacy osc strings double as morph positions so downstream consumers
      // can read either key; an explicit shape wins over the string it shadows.
      if (!('shape1' in clean) && typeof clean.osc1 === 'string') clean.shape1 = OSC_SHAPES[clean.osc1];
      if (!('shape2' in clean) && 'osc2' in clean) {
        clean.shape2 = clean.osc2 === null ? null : OSC_SHAPES[clean.osc2];
      }
    }
    if (Object.keys(clean).length) out[section] = clean;
  }
  return Object.keys(out).length ? out : null;
}

/** Field-level merge of `incoming` over `base`; an unusable patch keeps `base`. */
function mergePatch(base, incoming) {
  const from = sanitisePatch(base);
  if (incoming === undefined) return from;
  const patch = sanitisePatch(incoming);
  if (!patch) return from;
  if (!from) return patch;
  const out = {};
  for (const section of Object.keys(PATCH_SCHEMA)) {
    const merged = { ...(from[section] ?? {}), ...(patch[section] ?? {}) };
    if (Object.keys(merged).length) out[section] = merged;
  }
  return out;
}

/**
 * `{ [track]: { [voiceId]: Patch } }`, merged deeply over the base. Unknown
 * track names are dropped; unknown voice ids are kept, because the engine
 * cannot know which ids the (lazily loaded) voice library offers.
 */
function sanitisePatches(value, base) {
  const from = base && typeof base === 'object' && !Array.isArray(base) ? base : {};
  const v = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  const out = {};
  for (const track of TRACK_ORDER) {
    const baseBank = from[track] && typeof from[track] === 'object' && !Array.isArray(from[track])
      ? from[track]
      : null;
    const partialBank = v && v[track] && typeof v[track] === 'object' && !Array.isArray(v[track])
      ? v[track]
      : null;
    const ids = new Set([
      ...(baseBank ? Object.keys(baseBank) : []),
      ...(partialBank ? Object.keys(partialBank) : []),
    ]);
    const bank = {};
    for (const id of ids) {
      if (!id.trim()) continue;
      const merged = mergePatch(
        baseBank ? baseBank[id] : undefined,
        partialBank && id in partialBank ? partialBank[id] : undefined,
      );
      if (merged) bank[id] = merged;
    }
    if (Object.keys(bank).length) out[track] = bank;
  }
  return out;
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
  out.patches = sanitisePatches(at('patches'), from.patches);
  return out;
}

function copyPatches(patches) {
  const out = {};
  for (const [track, bank] of Object.entries(patches)) {
    const copy = {};
    for (const [id, patch] of Object.entries(bank)) {
      copy[id] = Object.fromEntries(
        Object.entries(patch).map(([section, fields]) => [section, { ...fields }]),
      );
    }
    out[track] = copy;
  }
  return out;
}

/** Deep copy of a sanitised params object — what getParams() hands out. */
function copyParams(params) {
  return {
    ...params,
    customStructure: params.customStructure.map((block) => ({ ...block })),
    arp: { ...params.arp, steps: params.arp.steps.slice() },
    tracks: Object.fromEntries(TRACK_ORDER.map((name) => [name, { ...params.tracks[name] }])),
    patches: copyPatches(params.patches),
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

const LOOKAHEAD = 0.12;         // seconds of audio scheduled ahead of the clock (visible tab)
const LOOKAHEAD_HIDDEN = 2.5;   // hidden tabs clamp timers to >=1 s, so stay well ahead
const RESYNC_GAP = 1.5;         // behind by more than any timer clamp explains → resync
const TICK_MS = 25;             // scheduler wake-up interval
const RESUME_TIMEOUT_MS = 2000; // Safari can leave ctx.resume() pending forever
const CANCEL_TAIL = 12.5;       // max patch release (12 s) + margin; live-note prune window
const FADE_OUT = 0.5;        // stop() fade
const FADE_IN = 1.2;         // start() fade
const FINISH_FADE = 8;       // finish() default outro fade
const FINISH_FADE_RANGE = [1, 30];
const FINISH_TAIL = 0.6;     // reverb/delay allowance after the outro fade
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

      return {
        cancel() {
          // Click-free hard stop: ~50 ms fade from wherever the envelope is,
          // never stopping before the note was due to start.
          const at = Math.max(ctx.currentTime, when);
          amp.gain.cancelScheduledValues(at);
          amp.gain.setTargetAtTime(SILENCE, at, 0.015);
          osc.stop(at + 0.06);
        },
      };
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
 * Dry level, tone ceiling and DEFAULT effect-send amounts per track — the send
 * levels a voice gets when no patch names its own. Levels are lower
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
  // The compressor's output route (ctx.destination, or a media element via a
  // MediaStreamDestination on iOS) is wired by the engine, not here.

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
    // Both sends are always wired: a patch can raise either from zero, so the
    // send level — not the connection — is what decides audibility.
    tone.connect(delaySend);
    delaySend.connect(delay);
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
  let starting = false;        // start() is between its first await and running
  let ticker = null;           // { stop() } — Worker-backed, or setInterval fallback
  let suspendTimer = null;
  let ctxSampleRate = 0;       // hardware rate at context creation (iOS can change it)
  let idleSuspended = false;   // the engine suspended the context itself to save power
  let output = null;           // { mode: 'element', streamDest, el } | { mode: 'direct' }
  const liveNotes = new Set(); // { handle, end } cancel handles for sounding notes

  // Graceful ending state
  let finishRequest = null;    // { promise, resolve, fadeSeconds } while finishing
  let outroStarted = false;    // the closing bar has begun and the fade is running
  let outroScheduled = false;  // the closing bar is fully scheduled: stop generating
  let finishDeadline = 0;      // ctx time at which the outro is silent
  let finishTimer = null;

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
  let arpCursor = 0;           // position in the note sequence
  let autoArpSteps = null;
  let percussionPlan = [];
  let percussionBank = [];
  let bankTimeSignature = null; // metre the phrase/percussion banks were made in

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
    // The closing bar always gets its pad and bass, whatever the section
    // intensity would otherwise have decided — that is the resolution.
    if (outroStarted && (name === 'pad' || name === 'bass')) return true;
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

  /** The patch the currently selected voice of `track` should be played with. */
  function patchFor(track) {
    const bank = params.patches[track];
    if (!bank) return undefined;
    return bank[params.tracks[track].voice];
  }

  /**
   * Per-track reverb and delay send levels: the current voice's user patch
   * when it names one, else that voice's published `defaults.sends`, else the
   * track's mix default (the fallback voices publish no defaults). Ramped,
   * never jumped, so editing a send while the piece plays does not click.
   */
  function applySends(rampSeconds, when = null) {
    if (!ctx || !graph) return;
    const time = when ?? ctx.currentTime;
    const constant = Math.max(rampSeconds / 3, 0.02);
    for (const name of TRACK_ORDER) {
      const patchSends = patchFor(name)?.sends;
      const voice = voiceFor(name);
      const voiceSends = voice && voice.defaults ? voice.defaults.sends : null;
      const reverb = typeof patchSends?.reverb === 'number' ? patchSends.reverb
        : typeof voiceSends?.reverb === 'number' ? voiceSends.reverb
          : TRACK_MIX[name].reverb;
      const delay = typeof patchSends?.delay === 'number' ? patchSends.delay
        : typeof voiceSends?.delay === 'number' ? voiceSends.delay
          : TRACK_MIX[name].delay;
      graph.tracks[name].reverbSend.gain.setTargetAtTime(reverb, time, constant);
      graph.tracks[name].delaySend.gain.setTargetAtTime(delay, time, constant);
    }
  }

  function applyLevels(rampSeconds) {
    if (!ctx || !graph) return;
    const now = ctx.currentTime;
    const target = Math.max(params.volume * MASTER_HEADROOM, SILENCE);
    // The outro fade owns the master gain until it is done; a volume change or
    // a parameter edit mid-ending must not pull the level back up.
    if (!outroStarted) {
      graph.master.gain.cancelScheduledValues(now);
      graph.master.gain.setValueAtTime(Math.max(graph.master.gain.value, SILENCE), now);
      graph.master.gain.exponentialRampToValueAtTime(isRunning ? target : SILENCE, now + rampSeconds);
    }

    applyTracks(rampSeconds);
    applySends(rampSeconds);

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

  function pruneLiveNotes() {
    const now = ctx ? ctx.currentTime : Infinity;
    for (const entry of liveNotes) {
      if (entry.end <= now) liveNotes.delete(entry);
    }
  }

  /** Hard-stop every sounding note. The voices' cancel fades are click-free. */
  function cancelLiveNotes() {
    for (const entry of liveNotes) {
      try {
        entry.handle.cancel();
      } catch {
        // A note that will not cancel is still just one note.
      }
    }
    liveNotes.clear();
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
        const handle = voice.play(ctx, graph.tracks[track].input, full, patchFor(track));
        if (handle && typeof handle.cancel === 'function') {
          // Keep the hard-stop handle so stop() can cancel sounding notes:
          // a suspended context would otherwise freeze their tails, which
          // resurrect — possibly in an old key — on the next start().
          pruneLiveNotes();
          liveNotes.add({ handle, end: full.when + full.duration + CANCEL_TAIL });
        }
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
    // The 16-step mask is bar-anchored: step 0 realigns to every barline. A
    // mask phase carried across bars rotates the pattern in any metre where a
    // bar is not a whole number of mask cycles (repro'd at 1/8T: offsets
    // drifted 0, 12, 8, 4). arpCursor is deliberately NOT reset, so the note
    // sequence itself stays continuous for melodic flow.
    for (let beat = 0; beat < bar.beats - 1e-6; beat += stepBeats) {
      const maskIndex = steps % ARP_STEP_COUNT;
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
    arpCursor = (arpCursor + steps) % sequence.length;
    return plan;
  }

  /**
   * The closing bar: a root-position tonic triad on the pad and the tonic in
   * the bass, sustained under the outro fade. Every other track is silent from
   * here — the ending resolves, it does not keep decorating.
   */
  function scheduleClosingBar(time) {
    chordDegree = 0;
    chordBarsLeft = 0;
    arpPlan = [];
    percussionPlan = [];
    currentPhrase = null;
    phraseBarsLeft = 0;
    const rootPc = pitchClass(params.root);
    const hold = Math.max(bar.duration, finishRequest ? finishRequest.fadeSeconds : FINISH_FADE);

    if (isActive('pad')) {
      const midis = [0, 2, 4].map((degree) => scaleDegreeToMidi(degree, scale(), rootPc, 3));
      const velocity = clamp(0.85 / Math.sqrt(midis.length), 0.15, 1);
      midis.forEach((midi, i) => {
        const spread = (i / (midis.length - 1) - 0.5) * 0.5;
        playNote('pad', { midi, when: time, duration: hold, velocity, pan: spread });
      });
    }
    if (isActive('bass')) {
      playNote('bass', {
        midi: scaleDegreeToMidi(0, scale(), rootPc, 2),
        when: time,
        duration: hold,
        velocity: 0.75,
      });
    }
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
    if (params.timeSignature !== bankTimeSignature) {
      // Stored percussion patterns carry pulse indexes, and stored phrases
      // carry beat positions, from the metre they were made in; replayed in a
      // shorter metre their out-of-range events are silently dropped and the
      // track thins out. Start both banks afresh in the new metre.
      bankTimeSignature = params.timeSignature;
      percussionBank = [];
      phraseBank = [];
      currentPhrase = null;
      phraseBarsLeft = 0;
    }
    const pulses = TIME_SIGNATURES[params.timeSignature];
    const secPerBeat = 60 / clamp(params.bpm * params.speed, 10, 400);
    const starts = [];
    let acc = 0;
    for (const p of pulses) {
      starts.push(acc);
      acc += p;
    }
    bar = {
      pulses,
      starts,
      beats: acc,
      secPerBeat,
      duration: acc * secPerBeat,
      // Snapshot the harmonic frame too: pulse-level scheduling reads these
      // instead of the live params, which is what actually quantises root and
      // mode changes to bar boundaries.
      scale: SCALES[params.mode],
      rootPc: pitchClass(params.root),
    };

    retuneDelay(time, secPerBeat);

    const preset = resolveStructure(params.structure, params.complexity, params.customStructure);
    // Keyed on block count + labels only: dragging a block's intensity (or
    // bars) slider is an in-place edit of the playing structure, not a new
    // structure that should reset playback to bar 0 of block 1.
    const key = preset === 'custom'
      ? `custom:${params.customStructure.length}:${params.customStructure.map((b) => b.label).join('')}`
      : preset;
    if (key !== structureKey) {
      // A new structure starts from its own bar zero rather than mid-cycle.
      structureKey = key;
      structureBar = 0;
    } else if (preset === 'custom') {
      // A bars edit may have shrunk the cycle; keep the position inside it.
      const total = params.customStructure.reduce((sum, block) => sum + block.bars, 0);
      if (total > 0) structureBar %= total;
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

    if (finishRequest && !outroStarted) {
      beginOutro(time);
      scheduleClosingBar(time);
      barIndex += 1;
      structureBar += 1;
      return;
    }

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
    // Melody, texture, arp and percussion all live at pulse level, and the
    // closing bar wants none of them.
    if (outroStarted) return;
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
          chordDegree + note.degree, bar.scale, bar.rootPc, 4,
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
        const degree = Math.floor(rng() * bar.scale.length * 2);
        let midi = scaleDegreeToMidi(degree, bar.scale, bar.rootPc, 6);
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
    if (!ctx || !isRunning || outroScheduled) return;
    // Hidden tabs clamp timers (setInterval to >=1 s; Chrome's intensive
    // throttling far harder), so the horizon widens while hidden. Events fire
    // early there, which is fine — the visualiser is off while hidden.
    const hidden = typeof document !== 'undefined' && document.hidden === true;
    const horizon = ctx.currentTime + (hidden ? LOOKAHEAD_HIDDEN : LOOKAHEAD);
    // Behind by more than any timer clamp explains (system sleep, a frozen
    // tab): resume MID-PIECE by advancing the bar/structure accounting by the
    // wall-clock bars that elapsed, then continue from a fresh barline —
    // never by minting a new bar per tick, which shreds the music into
    // downbeat fragments and races the structure.
    if (nextPulseTime < ctx.currentTime - RESYNC_GAP) {
      if (bar) {
        const missed = Math.floor((ctx.currentTime - nextPulseTime) / bar.duration);
        barIndex += missed;
        structureBar += missed;
      }
      nextPulseTime = ctx.currentTime + 0.05;
      pulseIndex = 0;
    }
    // The guard stops a pathological clock (a suspended tab resuming with a
    // large jump) from scheduling an unbounded burst in one pass.
    let guard = 0;
    while (nextPulseTime < horizon && guard++ < 64) {
      if (pulseIndex === 0) beginBar(nextPulseTime);
      schedulePulse(nextPulseTime, pulseIndex);
      nextPulseTime += bar.pulses[pulseIndex] * bar.secPerBeat;
      pulseIndex += 1;
      if (pulseIndex >= bar.pulses.length) {
        pulseIndex = 0;
        if (outroStarted) {
          // The closing bar is complete: generation ends here and only the
          // fade is left to run.
          outroScheduled = true;
          stopScheduler();
          break;
        }
      }
    }
  }

  // -- transport -------------------------------------------------------------

  /**
   * The scheduler clock. Worker timers are exempt from background-tab
   * throttling (a page-level setInterval clamps to >=1 s in hidden tabs, and
   * to once a minute under Chrome's intensive throttling), so the tick lives
   * in an inline-blob Worker wherever one can be created, with a plain
   * setInterval as the fallback.
   */
  function createTicker() {
    try {
      if (typeof Worker === 'function' && typeof Blob === 'function'
        && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
        const src = 'let t=null;onmessage=(e)=>{clearInterval(t);t=null;if(e.data>0)t=setInterval(()=>postMessage(0),e.data)};';
        const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
        const worker = new Worker(url);
        worker.onmessage = () => tick();
        worker.postMessage(TICK_MS);
        return {
          stop() {
            try { worker.terminate(); } catch { /* already dead is fine */ }
            try { URL.revokeObjectURL(url); } catch { /* best effort */ }
          },
        };
      }
    } catch {
      // Worker creation can be blocked (CSP worker-src); the interval still works.
    }
    const id = setInterval(tick, TICK_MS);
    return { stop() { clearInterval(id); } };
  }

  function startScheduler() {
    stopScheduler(); // defensive: there must never be two tickers
    ticker = createTicker();
  }

  function stopScheduler() {
    if (ticker !== null) {
      ticker.stop();
      ticker = null;
    }
  }

  function clearSuspend() {
    if (suspendTimer !== null) {
      clearTimeout(suspendTimer);
      suspendTimer = null;
    }
  }

  function scheduleSuspend(afterSeconds) {
    clearSuspend();
    suspendTimer = setTimeout(() => {
      suspendTimer = null;
      // A start() during the fade cancels this timer, so reaching here means we
      // are still stopped.
      if (!isRunning && ctx && ctx.state === 'running') {
        // Any tails still pending (an outro's closing pad) are inaudible now —
        // the master is at silence — and a suspended context would only freeze
        // them for the next start() to resurrect.
        cancelLiveNotes();
        idleSuspended = true;
        const suspended = ctx.suspend();
        if (suspended && typeof suspended.catch === 'function') suspended.catch(() => {});
        if (output && output.mode === 'element') {
          try { output.el.pause(); } catch { /* an unplayable sink can't pause */ }
        }
      }
    }, afterSeconds * 1000);
  }

  /** Resolve the pending finish() promise and forget the outro. Emits nothing. */
  function settleFinish() {
    if (finishTimer !== null) {
      clearInterval(finishTimer);
      finishTimer = null;
    }
    outroStarted = false;
    outroScheduled = false;
    if (!finishRequest) return;
    const { resolve } = finishRequest;
    finishRequest = null;
    resolve();
  }

  /** Start the master fade as the closing bar begins, and arm its completion. */
  function beginOutro(time) {
    outroStarted = true;
    const fade = finishRequest.fadeSeconds;
    const gain = graph.master.gain;
    gain.cancelScheduledValues(time);
    gain.setValueAtTime(Math.max(gain.value, SILENCE), time);
    gain.exponentialRampToValueAtTime(SILENCE, time + fade);
    // Pad and bass may have been an inactive auto track a moment ago.
    applyTracks(0.6, time);
    finishDeadline = time + fade + FINISH_TAIL;
    if (finishTimer === null) finishTimer = setInterval(checkOutro, TICK_MS);
  }

  /**
   * The outro is timed off the audio clock rather than a wall-clock timeout, so
   * it lands with the fade it actually scheduled however the tab is throttled.
   */
  function checkOutro() {
    if (!finishRequest || !ctx || !outroStarted) return;
    if (ctx.currentTime < finishDeadline) return;
    isRunning = false;
    stopScheduler();
    emit('state', { running: false, finished: true });
    settleFinish();
    applyLevels(0.2);
    scheduleSuspend(FADE_OUT + 0.2);
  }

  /**
   * Route the mix to the speakers. Where a media-element sink is available the
   * whole mix goes through a MediaStreamDestination into an <audio> element —
   * iOS's hardware mute switch silences a bare AudioContext but not media
   * elements, and the element enables lock-screen MediaSession control.
   * Exactly one of the two routes is ever connected.
   */
  function wireOutput() {
    try {
      if (typeof Audio === 'function' && typeof ctx.createMediaStreamDestination === 'function') {
        const streamDest = ctx.createMediaStreamDestination();
        const el = new Audio();
        el.srcObject = streamDest.stream;
        graph.compressor.connect(streamDest);
        return { mode: 'element', streamDest, el };
      }
    } catch {
      // Any failure along the element route means the plain destination route.
    }
    graph.compressor.connect(ctx.destination);
    return { mode: 'direct' };
  }

  /** A sink element that will not play() is a silent engine: rewire direct. */
  function fallbackToDirect() {
    if (!output || output.mode !== 'element' || !ctx || !graph) return;
    try { graph.compressor.disconnect(output.streamDest); } catch { /* already detached */ }
    try { output.el.pause(); } catch { /* never played */ }
    try { graph.compressor.connect(ctx.destination); } catch { /* context is gone */ }
    output = { mode: 'direct' };
  }

  function playOutputElement() {
    if (!output || output.mode !== 'element') return;
    try {
      const played = output.el.play();
      if (played && typeof played.then === 'function') {
        played.catch(() => fallbackToDirect());
      }
    } catch {
      fallbackToDirect();
    }
  }

  /** Ask iOS to play through the mute switch (Safari 17+; harmless elsewhere). */
  function requestPlaybackAudioSession() {
    try {
      if (typeof navigator !== 'undefined' && navigator.audioSession) {
        navigator.audioSession.type = 'playback';
      }
    } catch {
      // The session type is an optimisation, never a requirement.
    }
  }

  /**
   * iOS fires 'interrupted' (phone call, Siri, another app) and auto-suspends
   * without telling the app; a running engine must claw the context back or
   * sit silent forever with running=true.
   */
  function handleStateChange() {
    if (!ctx || !isRunning || ctx.state === 'running') return;
    try {
      const resumed = ctx.resume();
      if (resumed && typeof resumed.catch === 'function') resumed.catch(() => {});
    } catch {
      // The next resume()/start() poke gets another chance.
    }
  }

  /**
   * resume() can pend forever on Safari; race it against a timeout and let the
   * caller decide from ctx.state. Calls ctx.resume() synchronously.
   */
  function resumeWithTimeout() {
    let resumed = null;
    try {
      resumed = ctx.resume();
    } catch {
      return Promise.resolve();
    }
    if (!resumed || typeof resumed.then !== 'function') return Promise.resolve();
    return new Promise((resolve) => {
      let timer = setTimeout(() => { timer = null; resolve(); }, RESUME_TIMEOUT_MS);
      const settle = () => {
        if (timer !== null) clearTimeout(timer);
        resolve();
      };
      resumed.then(settle, settle);
    });
  }

  /** Create the context, graph and output route once. False without Web Audio. */
  function ensureContext() {
    const Ctor = audioContextCtor();
    if (!Ctor) return false;
    if (!ctx) {
      ctx = new Ctor();
      ctxSampleRate = ctx.sampleRate;
      graph = buildGraph(ctx);
      output = wireOutput();
      try { ctx.onstatechange = handleStateChange; } catch { /* read-only mock */ }
      applySends(0.02);
    }
    return true;
  }

  /**
   * After an iOS interruption the hardware sample rate can change under the
   * context; resuming it would play through a corrupt graph (noise buffers and
   * the reverb IR are baked at the old rate). Tear down and start over.
   */
  function rebuildContext() {
    liveNotes.clear(); // handles into the dead context; close() ends their audio
    const old = ctx;
    ctx = null;
    graph = null;
    output = null;
    delayTarget = 0;
    if (old) {
      try { old.onstatechange = null; } catch { /* best effort */ }
      try {
        const closed = typeof old.close === 'function' ? old.close() : null;
        if (closed && typeof closed.catch === 'function') closed.catch(() => {});
      } catch {
        // A context that will not close is abandoned to the GC.
      }
    }
    if (!ensureContext()) return;
    if (isRunning) {
      // Same piece, fresh clock: re-anchor the scheduler and fade back in.
      nextPulseTime = ctx.currentTime + 0.15;
      pulseIndex = 0;
      applyLevels(FADE_IN);
      playOutputElement();
    }
  }

  /**
   * Create and resume the AudioContext without making a sound. Call it from a
   * user gesture so a later start() — from a timer, an alarm — is allowed to
   * play. Idempotent, and safe to call where Web Audio does not exist.
   */
  function arm() {
    if (!ensureContext()) return false;
    // Nothing may re-suspend a context the caller just armed.
    clearSuspend();
    idleSuspended = false;
    if (ctx.state !== 'running') {
      requestPlaybackAudioSession();
      resumeWithTimeout(); // fire and forget: arm() stays synchronous
    }
    // The arming gesture is the one chance to unlock the media-element sink
    // for a later gestureless start() (a sleep timer, an alarm).
    playOutputElement();
    if (!voices) {
      loadVoices().then((loaded) => {
        voices = voices ?? loaded;
        // Send defaults come from the voice library; re-apply now it is here.
        if (ctx && graph) applySends(0.2);
      });
    }
    return true;
  }

  /**
   * Idempotent poke for a context that went non-running behind our back (iOS
   * interruption, auto-suspend, tab restore). Safe before arm()/start(); never
   * wakes a context the engine suspended itself to save power.
   */
  async function resume() {
    if (!ctx || idleSuspended) return;
    playOutputElement();
    if (ctx.state !== 'running') {
      requestPlaybackAudioSession();
      await resumeWithTimeout();
    }
    if (!ctx) return;
    if (isRunning && (ctx.state !== 'running' || ctx.sampleRate !== ctxSampleRate)) {
      rebuildContext();
    }
  }

  async function start() {
    // Play during an ending cancels it and begins again from the top. This is
    // a fast stop, so the outro's sounding tails must be cancelled too — they
    // would otherwise carry (in a possibly stale key) into the fresh start.
    if (finishRequest) {
      settleFinish();
      isRunning = false;
      stopScheduler();
      cancelLiveNotes();
    }
    // `starting` closes the re-entrancy window the awaits below open: without
    // it, a concurrent start() (alarm timer + human) installs two tickers and
    // leaks the first forever.
    if (isRunning || starting) return;
    const Ctor = audioContextCtor();
    if (!Ctor) throw new Error('ambient-engine: Web Audio API is not available in this environment');
    starting = true;
    try {
      if (!voices) voices = await loadVoices();
      if (isRunning || !ensureContext()) return;
      clearSuspend();
      idleSuspended = false;
      // Unless arm() already did it, this must be reached from a user gesture
      // for browsers to allow audio. Anything non-running — 'suspended' or
      // iOS's 'interrupted' — gets the same timeboxed poke.
      if (ctx.state !== 'running') {
        requestPlaybackAudioSession();
        await resumeWithTimeout();
        if (isRunning || !ctx) return;
      }
      if (ctx.state !== 'running' || ctx.sampleRate !== ctxSampleRate) {
        // Stuck, or back at a different hardware rate: rebuild rather than
        // play a corrupt graph. Still not running afterwards? Proceed anyway —
        // scheduling against a suspended clock is safe, and onstatechange or a
        // resume() poke will unstick it at the next user signal.
        rebuildContext();
        if (ctx.state !== 'running') {
          requestPlaybackAudioSession();
          await resumeWithTimeout();
          if (isRunning || !ctx) return;
        }
      }
      playOutputElement();

      isRunning = true;
      phraseBarsLeft = 0;
      chordBarsLeft = 0;
      pulseIndex = 0;
      barIndex = 0;
      structureBar = 0;
      structureKey = '';
      sectionAnnounced = false;
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
      startScheduler();
      tick();
      emit('state', { running: true });
    } finally {
      starting = false;
    }
  }

  /**
   * Graceful ending: the bar in progress finishes, one closing bar resolves to
   * the tonic, and the master fades out under it. Resolves when silent.
   */
  function finish(options) {
    if (finishRequest) return finishRequest.promise;
    if (!isRunning) return Promise.resolve();
    const fadeSeconds = numberIn(
      options && typeof options === 'object' ? options.fadeSeconds : undefined,
      FINISH_FADE_RANGE,
      FINISH_FADE,
    );
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    finishRequest = { promise, resolve, fadeSeconds };
    outroStarted = false;
    outroScheduled = false;
    return promise;
  }

  function stop() {
    stopScheduler();
    // A stop during an ending cuts the outro short but still keeps its promise.
    settleFinish();
    // Cancel every sounding note (each voice's ~50 ms cancel fade is
    // click-free): the context is about to be suspended, and frozen tails —
    // pads hold and release for many seconds — would otherwise resurrect, in
    // whatever key they were played in, on the next start().
    cancelLiveNotes();
    if (!isRunning) return;
    isRunning = false;
    emit('state', { running: false });
    if (!ctx || !graph) return;
    applyLevels(FADE_OUT);
    scheduleSuspend(FADE_OUT + 0.2);
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

  // Going hidden widens the scheduling horizon; ticking right away closes the
  // gap between the narrow visible lookahead and the first (possibly clamped)
  // hidden timer fire. Firing on return-to-visible is harmless.
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', () => {
      if (isRunning && ctx && !outroScheduled) tick();
    });
  }

  return {
    arm,
    start,
    finish,
    stop,
    resume,
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
