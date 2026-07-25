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

/**
 * v8: melody and bass ship silent. The musicality rework has not passed the
 * subjective "catchy" gate yet, so the two tracks that carry the tune start
 * switched off rather than shipping a half-finished line to every listener.
 */
const DEFAULT_TRACK_STATES = Object.freeze({
  pad: 'auto',
  bass: 'off',
  melody: 'off',
  texture: 'auto',
  arp: 'auto',
  percussion: 'auto',
});

const ARP_MODES = ['auto', 'manual'];
const ARP_STEP_COUNT = 16;

export const SEQUENCER_MODES = Object.freeze(['auto', 'manual']);

/** Longest metre grid (5/4 = 20 sixteenths); shorter metres use a prefix. */
export const SEQUENCER_STEP_COUNT = 20;

/** Tracks with a pulse to sequence. pad and texture are sustained, so no grid. */
export const SEQUENCED_TRACKS = Object.freeze(['melody', 'bass', 'arp', 'percussion']);

export const PERCUSSION_LANES = Object.freeze(['low', 'mid', 'high']);

export const VARY_ASPECTS = Object.freeze(['voice', 'volume', 'pitch', 'timing', 'pan']);

const DEFAULT_TRACK_LEVEL = 0.8;
const DEFAULT_TRACK_RANDOMNESS = 0.5;

/** The step a legacy `arp.steps` boolean expands to, and every lane's default. */
const DEFAULT_STEP = Object.freeze({ on: true, prob: 1, vmin: 0.5, vmax: 0.9 });

/** Oscillator shapes a patch may ask a subtractive voice for. */
export const PATCH_OSC_TYPES = Object.freeze(['sine', 'triangle', 'sawtooth', 'square']);

export const PATCH_FILTER_TYPES = Object.freeze(['lowpass', 'highpass', 'bandpass', 'notch']);

/**
 * How many sequencer slots a metre uses, counted from slot 0. Every metre is
 * gridded in sixteenths, which reproduces the contract's table exactly:
 * 3/4→12, 4/4→16, 5/4→20, 6/8→12, 7/8→14.
 *
 * SPEC-CRITIC [6/8 grid] → ruling 4: 6/8 is carried in TIME_SIGNATURES as two
 * dotted-quarter pulses (3 quarter-note beats), so sixteenths give 12 slots —
 * the same 12 the contract asks for, and the same answer as counting the six
 * eighths and halving each. A 6/8 slot is therefore a semiquaver, NOT a triplet
 * subdivision of the dotted pulse, and no metre needs a special case.
 */
export function sequencerStepsPerBar(timeSignature) {
  return Math.round(beatsPerBar(timeSignature) * 4);
}

function defaultStepLane() {
  return Array.from({ length: SEQUENCER_STEP_COUNT }, () => ({ ...DEFAULT_STEP }));
}

function defaultSequencer(track) {
  if (track === 'percussion') {
    return {
      mode: 'auto',
      steps: Object.fromEntries(PERCUSSION_LANES.map((lane) => [lane, defaultStepLane()])),
    };
  }
  return { mode: 'auto', steps: defaultStepLane() };
}

/**
 * v11 default change: the two SUSTAINED tracks ship a small explicit voice
 * wander instead of following the randomness macro. A pad left on one timbre
 * for an hour is the single loudest complaint about auto, and 0.15 is roughly
 * one voice change every twenty-six bars — noticed over a session, invisible
 * over a phrase. Every other track (and every other aspect) still defaults to
 * null = "follow this track's randomness".
 */
const DEFAULT_VARY_VOICE = Object.freeze({ pad: 0.15, texture: 0.15 });

function defaultVary(track) {
  return Object.fromEntries(VARY_ASPECTS.map((aspect) => [
    aspect, aspect === 'voice' ? DEFAULT_VARY_VOICE[track] ?? null : null,
  ]));
}

function defaultTracks() {
  const tracks = {};
  for (const name of TRACK_ORDER) {
    const track = {
      state: DEFAULT_TRACK_STATES[name],
      voice: DEFAULT_TRACK_VOICES[name],
      level: DEFAULT_TRACK_LEVEL,
      randomness: DEFAULT_TRACK_RANDOMNESS,
      hold: false,
      vary: defaultVary(name),
    };
    if (SEQUENCED_TRACKS.includes(name)) track.sequencer = defaultSequencer(name);
    tracks[name] = track;
  }
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

/** Freeze a plain-object/array tree in place. DEFAULT_PARAMS is public API. */
function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value)) deepFreeze(entry);
  return value;
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
  tracks: deepFreeze(defaultTracks()),
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

/**
 * v7 RangeValue: a rangeable param accepts a plain number or `{ min, max }`.
 * Both bounds are clamped into [lo, hi] and swapped if they arrive reversed, so
 * `{ min: 0.9, max: 0.1 }` stores as `{ min: 0.1, max: 0.9 }`. An object needs
 * BOTH bounds usable — a half-written `{ min: 0.2 }` is rejected rather than
 * guessed at, so the caller's fallback (the inherited value, then the param
 * default) decides. Returns undefined for anything unusable, which makes
 * `sanitiseRangeValue(a, …) ?? sanitiseRangeValue(b, …) ?? fallback` the
 * standard call shape.
 */
export function sanitiseRangeValue(value, lo = 0, hi = 1) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const min = patchNumber(value.min, lo, hi);
    const max = patchNumber(value.max, lo, hi);
    if (min === undefined || max === undefined) return undefined;
    return min <= max ? { min, max } : { min: max, max: min };
  }
  return patchNumber(value, lo, hi);
}

const copyRangeValue = (v) => (v !== null && typeof v === 'object' ? { ...v } : v);

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

/**
 * One sequencer step. A bare boolean is the legacy `arp.steps` mask entry and
 * expands to a full-probability step in the default velocity band. vmin/vmax
 * swap rather than reject when they arrive reversed, matching RangeValue.
 */
function sanitiseStep(value, base) {
  const from = base && typeof base === 'object' && !Array.isArray(base) ? base : DEFAULT_STEP;
  const v = typeof value === 'boolean' ? { on: value }
    : value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  const at = (key) => (v && key in v ? v[key] : undefined);
  let vmin = numberIn(at('vmin'), [0, 1], numberIn(from.vmin, [0, 1], DEFAULT_STEP.vmin));
  let vmax = numberIn(at('vmax'), [0, 1], numberIn(from.vmax, [0, 1], DEFAULT_STEP.vmax));
  if (vmin > vmax) [vmin, vmax] = [vmax, vmin];
  return {
    on: v && 'on' in v ? Boolean(v.on) : Boolean(from.on),
    // prob is rangeable (v7): a range means the effective probability drifts.
    prob: sanitiseRangeValue(at('prob'), 0, 1)
      ?? sanitiseRangeValue(from.prob, 0, 1)
      ?? DEFAULT_STEP.prob,
    vmin,
    vmax,
  };
}

/** Exactly SEQUENCER_STEP_COUNT steps; short input keeps the base beyond it. */
function sanitiseStepLane(value, base) {
  const source = Array.isArray(value) ? value : null;
  const from = Array.isArray(base) ? base : null;
  const lane = new Array(SEQUENCER_STEP_COUNT);
  for (let i = 0; i < SEQUENCER_STEP_COUNT; i++) {
    lane[i] = sanitiseStep(
      source && i < source.length ? source[i] : undefined,
      from && i < from.length ? from[i] : DEFAULT_STEP,
    );
  }
  return lane;
}

function sanitiseSequencer(track, value, base) {
  const from = base && typeof base === 'object' ? base : null;
  const v = value && typeof value === 'object' ? value : null;
  const at = (key) => (v && key in v ? v[key] : undefined);
  const mode = oneOf(at('mode'), SEQUENCER_MODES,
    oneOf(from && from.mode, SEQUENCER_MODES, 'auto'));
  if (track !== 'percussion') {
    return { mode, steps: sanitiseStepLane(at('steps'), from ? from.steps : undefined) };
  }
  const rawLanes = at('steps');
  const baseLanes = from && from.steps && typeof from.steps === 'object' ? from.steps : null;
  const steps = {};
  for (const lane of PERCUSSION_LANES) {
    steps[lane] = sanitiseStepLane(
      rawLanes && typeof rawLanes === 'object' ? rawLanes[lane] : undefined,
      baseLanes ? baseLanes[lane] : undefined,
    );
  }
  return { mode, steps };
}

/**
 * Per-aspect randomisation targets. `null` is meaningful — "follow this track's
 * randomness macro" — so it is preserved rather than defaulted, and an explicit
 * number (including 0) overrides the macro for that aspect.
 */
function sanitiseVary(value, base) {
  const from = base && typeof base === 'object' ? base : null;
  const v = value && typeof value === 'object' ? value : null;
  const out = {};
  for (const aspect of VARY_ASPECTS) {
    const raw = v && aspect in v ? v[aspect] : undefined;
    if (raw === null) {
      out[aspect] = null;
      continue;
    }
    const cleaned = sanitiseRangeValue(raw, 0, 1);
    out[aspect] = cleaned !== undefined
      ? cleaned
      : sanitiseRangeValue(from ? from[aspect] : undefined, 0, 1) ?? null;
  }
  return out;
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
    const track = {
      state: oneOf(partial && partial.state, TRACK_STATES,
        oneOf(baseTrack.state, TRACK_STATES, DEFAULT_TRACK_STATES[name])),
      voice: voiceCandidate,
      level: sanitiseRangeValue(partial && partial.level, 0, 1)
        ?? sanitiseRangeValue(baseTrack.level, 0, 1)
        ?? DEFAULT_TRACK_LEVEL,
      randomness: sanitiseRangeValue(partial && partial.randomness, 0, 1)
        ?? sanitiseRangeValue(baseTrack.randomness, 0, 1)
        ?? DEFAULT_TRACK_RANDOMNESS,
      hold: partial && 'hold' in partial ? Boolean(partial.hold) : Boolean(baseTrack.hold),
      vary: sanitiseVary(partial && partial.vary, baseTrack.vary),
    };
    if (SEQUENCED_TRACKS.includes(name)) {
      track.sequencer = sanitiseSequencer(
        name, partial && partial.sequencer, baseTrack.sequencer,
      );
    }
    tracks[name] = track;
  }
  return tracks;
}

/**
 * The arp's step grid moved into `tracks.arp.sequencer` (v6 amendment), but the
 * legacy 16-boolean `arp.steps` mask stays a supported input: when a call sends
 * it and does NOT set the sequencer lane in the same call, the mask writes
 * through to the first 16 slots at full probability in the default band. Slots
 * 16–19 (5/4 only) are left alone — the legacy mask has nothing to say there.
 */
function bridgeLegacyArpSteps(partial, tracks, arp) {
  const sentMask = Boolean(partial && partial.arp && typeof partial.arp === 'object'
    && Array.isArray(partial.arp.steps));
  if (!sentMask) return;
  const sentLane = Boolean(partial.tracks && typeof partial.tracks === 'object'
    && partial.tracks.arp && typeof partial.tracks.arp === 'object'
    && partial.tracks.arp.sequencer && typeof partial.tracks.arp.sequencer === 'object'
    && 'steps' in partial.tracks.arp.sequencer);
  if (sentLane) return;
  const lane = tracks.arp.sequencer.steps;
  for (let i = 0; i < ARP_STEP_COUNT; i++) {
    lane[i] = { ...DEFAULT_STEP, on: arp.steps[i] };
  }
}

/**
 * `tracks.percussion.sequencer` is the authoritative home of the drum grid, but
 * the v6 shape put it at the top level as `percussion: { mode, steps }`. That
 * form is still accepted as INPUT and merged in; it is never emitted, and a
 * call that sets the authoritative path in the same breath wins outright.
 */
function bridgeLegacyPercussion(partial, tracks) {
  const legacy = partial && typeof partial === 'object' ? partial.percussion : undefined;
  if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) return;
  const sentAuthoritative = Boolean(partial.tracks && typeof partial.tracks === 'object'
    && partial.tracks.percussion && typeof partial.tracks.percussion === 'object'
    && partial.tracks.percussion.sequencer);
  if (sentAuthoritative) return;
  tracks.percussion.sequencer = sanitiseSequencer(
    'percussion', legacy, tracks.percussion.sequencer,
  );
}

/**
 * How many slots the arp lane uses in a bar (ruling 9a). Unlike the other
 * sequenced tracks the arp lane is indexed by arp step at the CURRENT rate, not
 * by sixteenth, so that it replaces the old 16-boolean mask one for one.
 */
export function arpLaneLength(timeSignature, rate) {
  const stepBeats = ARP_RATES[rate] ?? ARP_RATES['1/8'];
  return Math.min(
    SEQUENCER_STEP_COUNT,
    Math.max(1, Math.ceil(beatsPerBar(timeSignature) / stepBeats - 1e-6)),
  );
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
 * A number inside [lo, hi], or undefined when the value is not usable. Sparse
 * schemas (patches, range values) drop an unusable field rather than defaulting
 * it, because defaulting would silently overwrite an inherited value.
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
  bridgeLegacyArpSteps(p, out.tracks, out.arp);
  bridgeLegacyPercussion(p, out.tracks);
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

const copyStep = (step) => ({ ...step, prob: copyRangeValue(step.prob) });

const copyStepLane = (lane) => lane.map(copyStep);

function copySequencer(sequencer) {
  const steps = Array.isArray(sequencer.steps)
    ? copyStepLane(sequencer.steps)
    : Object.fromEntries(
      PERCUSSION_LANES.map((lane) => [lane, copyStepLane(sequencer.steps[lane])]),
    );
  return { mode: sequencer.mode, steps };
}

function copyTrack(track) {
  const out = {
    ...track,
    level: copyRangeValue(track.level),
    randomness: copyRangeValue(track.randomness),
    vary: Object.fromEntries(
      Object.entries(track.vary).map(([aspect, value]) => [aspect, copyRangeValue(value)]),
    ),
  };
  if (track.sequencer) out.sequencer = copySequencer(track.sequencer);
  return out;
}

/** Deep copy of a sanitised params object — what getParams() hands out. */
function copyParams(params) {
  return {
    ...params,
    customStructure: params.customStructure.map((block) => ({ ...block })),
    arp: { ...params.arp, steps: params.arp.steps.slice() },
    tracks: Object.fromEntries(TRACK_ORDER.map((name) => [name, copyTrack(params.tracks[name])])),
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

// -- the hook (v11) ---------------------------------------------------------
//
// The v2 harmony was memoryless: every chord change re-rolled the walk and
// overwrote the stored loop, so nothing ever came back and the ear had nothing
// to learn. The hook keeps ONE loop and treats it as material — it establishes
// early, mutates a little at a time, banks the shapes that stick and brings
// them back later. A variant is three parallel arrays, one entry per slot:
//
//   degrees     the chord roots, as scale degrees (mode-correct by construction)
//   inversions  0–2, how many chord tones are rotated an octave up (voicing)
//   extensions  -1/0/+1, a colour nudge on top of the piece's complexity

export const HOOK_MIN_CHORDS = 4;
export const HOOK_MAX_CHORDS = 8;

/**
 * Establish a hook from the same diatonic walk the engine has always used, so
 * it is in the mode whatever the mode is. Repetition sets the loop LENGTH: a
 * listener asking for repetition gets the tightest four-chord loop, one asking
 * for wander gets eight chords before anything comes round again.
 */
export function buildHook({
  scaleLength = 5, complexity = 0.5, repetition = 0.5, rng = Math.random,
} = {}) {
  const span = HOOK_MAX_CHORDS - HOOK_MIN_CHORDS;
  const length = clamp(
    Math.round(HOOK_MIN_CHORDS + (1 - clamp(repetition, 0, 1)) * span),
    HOOK_MIN_CHORDS, HOOK_MAX_CHORDS,
  );
  const degrees = [0];
  while (degrees.length < length) {
    degrees.push(nextChordDegree(degrees[degrees.length - 1], scaleLength, complexity, rng));
  }
  return { degrees, inversions: degrees.map(() => 0), extensions: degrees.map(() => 0) };
}

export function cloneHook(variant) {
  return {
    degrees: [...variant.degrees],
    inversions: [...variant.inversions],
    extensions: [...variant.extensions],
  };
}

/** A variant's identity — what the bank de-duplicates on. */
export function hookKey(variant) {
  return variant.degrees
    .map((degree, i) => `${degree}.${variant.inversions[i]}.${variant.extensions[i]}`)
    .join('|');
}

/**
 * How far a variant has travelled from a plain loop, per chord: rotated
 * voicings and colour nudges both count. Busy sections prefer the busy
 * variants, calm sections the plain ones.
 */
export function hookEnergy(variant) {
  let energy = 0;
  for (let i = 0; i < variant.degrees.length; i++) {
    if (variant.inversions[i] > 0) energy += 1;
    energy += Math.abs(variant.extensions[i]);
  }
  return energy / Math.max(1, variant.degrees.length);
}

/**
 * ONE bounded mutation, never more: a voicing swap, a single-chord
 * substitution, or an extension change. Slot 0 keeps its degree — the tonic
 * return is what makes a loop recognisable as a loop — but its voicing and
 * colour are fair game. Every mutation is audible: each branch changes the
 * slot it lands on.
 */
export function mutateHook(variant, {
  scaleLength = 5, complexity = 0.5, rng = Math.random,
} = {}) {
  const next = cloneHook(variant);
  const slot = Math.floor(rng() * next.degrees.length) % next.degrees.length;
  const roll = rng();
  if (roll < 0.35 || (slot === 0 && roll < 0.85)) {
    next.inversions[slot] = (next.inversions[slot] + 1) % 3;
  } else if (roll < 0.85) {
    next.degrees[slot] = nextChordDegree(next.degrees[slot], scaleLength, complexity, rng);
  } else {
    next.extensions[slot] = next.extensions[slot] >= 1 ? -1 : next.extensions[slot] + 1;
  }
  return next;
}

/**
 * One hook slot as the scale degrees to sound: the diatonic stack, coloured by
 * complexity plus the slot's own extension nudge, then rotated into its
 * inversion. Rotating by a whole scale length rather than by semitones is what
 * keeps an inverted voicing inside the mode.
 */
export function voiceHookChord(degree, colourAmount = 0.5, {
  inversion = 0, extension = 0, scaleLength = 5,
} = {}) {
  const stack = buildChord(degree, clamp(colourAmount + extension * 0.3, 0, 1));
  const rotation = ((inversion % stack.length) + stack.length) % stack.length;
  return stack
    .map((d, i) => (i < rotation ? d + scaleLength : d))
    .sort((a, b) => a - b);
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
  // vary.pitch (v6 amendment 2) raises the passing-note likelihood without
  // touching density; null keeps the complexity-derived value.
  passing = null,
  rng = Math.random,
}) {
  const density = clamp(complexity, 0, 1);
  const passingChance = passing === null || passing === undefined
    ? density * 0.55
    : clamp(passing, 0, 1);
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
      if (previous !== null && rng() < passingChance) {
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
const NOTE_RATE_WINDOW = 20;    // seconds of onset history behind getStats().notesPerMin
const NODES_PER_TRACK = 6;      // input, tone, dry, reverb send, delay send, analyser
const NODES_PER_NOTE = 6;       // sources + filter + amp + panner, averaged over the library
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
function createImpulseResponse(ctx, seconds = 4, decay = 3.2, rng = Math.random) {
  const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  const fadeIn = Math.max(1, ctx.sampleRate * 0.01);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      const t = i / length;
      const envelope = Math.pow(1 - t, decay) * (1 - Math.exp(-i / fadeIn));
      data[i] = (rng() * 2 - 1) * envelope;
    }
  }
  return buffer;
}

function buildGraph(ctx, rng = Math.random) {
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
  convolver.buffer = createImpulseResponse(ctx, 4, 3.2, rng);
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

/**
 * `options.rng` replaces Math.random for EVERY draw the engine makes, including
 * the reverb impulse response — a seeded generator makes a performance
 * reproducible bar for bar, which is what the property tests need.
 */
export function createEngine(initialParams, options = {}) {
  let params = sanitiseParams(initialParams);
  const rng = options && typeof options.rng === 'function' ? options.rng : Math.random;

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
  let currentBarNumber = 0;    // barIndex of the bar being scheduled (barIndex runs ahead)
  let currentBarTime = 0;      // ctx time of that bar's downbeat — the humanisation floor
  let delayTarget = 0;

  // Structure state
  let structureKey = '';
  let structureBar = 0;        // bars since this structure started
  let currentSection = { label: 'A', intensity: 0.35 };
  let sectionAnnounced = false;

  // Harmonic state — the v11 hook: one loop, mutated, banked, recalled.
  let hook = null;             // the variant currently sounding
  let hookIndex = 0;           // slot within the loop
  let hookFresh = false;       // the loop has been established but not yet sounded
  let hookPass = 0;            // completed loop passes since the hook was established
  let hookStable = 0;          // passes the current variant has survived unmutated
  let hookRecallAt = 0;        // the pass at which the next recall is due
  let hookBank = [];           // [{ key, variant, salience, pass }] — the ear-worms
  let hookSectionPending = false; // a section changed: re-pick a variant at the next pass
  let chordDegree = 0;
  let chordInversion = 0;
  let chordExtension = 0;
  let chordBarsLeft = 0;

  // Pad breathing (v11)
  let padSwellPhase = 0;       // position in the pad's four-bar dynamic contour
  let padRested = false;       // the chord span just gone was a rest

  // Melodic state
  let phraseBank = [];
  let currentPhrase = null;
  let phraseBarIndex = 0;
  let phraseBarsLeft = 0;

  // Realised bar plans (see planFor): every random draw a bar needs is made
  // once, at the barline, so hold can replay a bar identically.
  let melodyPlan = [];
  let texturePlan = [];
  let arpPlan = null;
  let percussionPlan = [];
  let arpCursor = 0;           // position in the note sequence
  let autoArpSteps = null;
  let percussionBank = [];
  let bankTimeSignature = null; // metre the phrase/percussion banks were made in

  // Randomisation state
  const walkPhases = new Map();     // `${track}:${param}` → walk position in [0, 1]
  const held = new Set();           // tracks whose bar plan is frozen right now
  const frozenPlans = new Map();    // plan key → the plan a held track replays
  const pendingRandomise = new Set(); // tracks to re-roll at the next barline
  // vary.voice wander: EPHEMERAL, so it never reaches params/getParams.
  const wanderedVoice = new Map();  // track → the voice id actually sounding

  // v9 cost accounting
  let maxNotes = Infinity;          // power budget: simultaneous sounding notes
  let statsStart = 0;               // ctx time the note-rate window started
  const noteTimes = new Map();      // track → recent note onsets (ctx seconds)

  const listeners = new Map();
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

  // -- randomisation core ----------------------------------------------------

  /**
   * One bounded random walk per (track, param), stepped once a bar. A range
   * value drifts coherently rather than jumping per note, which is the whole
   * point of the v7 dual dial: the listener hears a slow change of mind, not
   * noise. Reflecting at the ends keeps the walk inside [0, 1] without piling
   * probability mass up against a hard clamp.
   */
  const WALK_STEP = 0.15;

  function walk(track, param) {
    const key = `${track}:${param}`;
    let position = walkPhases.get(key);
    if (position === undefined) {
      position = rng();
      walkPhases.set(key, position);
    }
    return position;
  }

  function advanceWalks() {
    for (const [key, position] of walkPhases) {
      // SPEC-CRITIC [hold/prob] → ruling 5: hold freezes every draw the bar
      // makes, and the walk step is one of them. A held track's ranged params —
      // step probability included — therefore sit still until it is released.
      if (held.has(key.slice(0, key.indexOf(':')))) continue;
      let next = position + (rng() * 2 - 1) * WALK_STEP;
      if (next < 0) next = -next;
      if (next > 1) next = 2 - next;
      walkPhases.set(key, clamp(next, 0, 1));
    }
  }

  /**
   * A RangeValue as the number the schedulers (and, per ruling 9c, the voices)
   * actually consume. A plain number passes straight through and never opens a
   * walk, so a default params object makes no extra draws at all.
   */
  function resolveRange(track, param, rangeValue) {
    if (rangeValue === null || rangeValue === undefined) return null;
    if (typeof rangeValue !== 'object') return rangeValue;
    return rangeValue.min + (rangeValue.max - rangeValue.min) * walk(track, param);
  }

  /**
   * How much variation one aspect of one track wants, 0–1.
   *
   * SPEC-CRITIC [vary-off] → ruling 6/amendment 2: `null` means "follow this
   * track's randomness macro" and an explicit number OVERRIDES the macro — so
   * an explicit 0 is a real "leave this aspect alone", distinct from null, even
   * when randomness is high.
   */
  function varyAmount(track, aspect) {
    const config = params.tracks[track];
    const explicit = config.vary[aspect];
    const value = explicit === null || explicit === undefined
      ? resolveRange(track, 'randomness', config.randomness)
      : resolveRange(track, `vary.${aspect}`, explicit);
    return clamp(value ?? 0, 0, 1);
  }

  /** A track's randomness macro as a number, resolving a v7 range via its walk. */
  function trackRandomness(track) {
    const value = resolveRange(track, 'randomness', params.tracks[track].randomness);
    return clamp(value ?? DEFAULT_TRACK_RANDOMNESS, 0, 1);
  }

  /** Per-note velocity jitter: ±15 % of the note's own velocity at aspect 1. */
  function velocityJitter(track) {
    return 1 + varyAmount(track, 'volume') * between(-0.15, 0.15, rng);
  }

  const TIMING_SPREAD = 0.025;       // seconds of humanisation at vary.timing = 1
  const PAN_SPREAD = 0.5;            // extra stereo width at vary.pan = 1
  const VOICE_WANDER_CHANCE = 0.25;  // per-bar wander probability at vary.voice = 1
  const OCTAVE_WANDER_CHANCE = 0.18; // per-note register jump at vary.pitch = 1

  /**
   * Seconds to nudge one note off its grid position (v6 amendment 2). Drawn in
   * the bar plan, so a held bar keeps its feel, and clamped forward at dispatch
   * — that clamp is what stops a negative nudge breaching the lookahead.
   */
  function timingNudge(track) {
    return between(-TIMING_SPREAD, TIMING_SPREAD, rng) * varyAmount(track, 'timing');
  }

  /** Per-note stereo widening, added on top of a track's own placement. */
  function panSpread(track) {
    return between(-PAN_SPREAD, PAN_SPREAD, rng) * varyAmount(track, 'pan');
  }

  /**
   * Register wander: an occasional octave jump. Both draws are made whatever the
   * aspect amount is, so turning vary.pitch down changes the music without
   * shifting every later draw in the bar onto a different rng position.
   */
  function octaveWander(track) {
    const direction = rng() < 0.5 ? -1 : 1;
    return rng() < OCTAVE_WANDER_CHANCE * varyAmount(track, 'pitch') ? direction : 0;
  }

  /** A sequencer step's firing probability, resolving a v7 range via its walk. */
  function effectiveProb(track, param, prob) {
    return clamp(resolveRange(track, param, prob) ?? 1, 0, 1);
  }

  /** The sequencer lane(s) of a pulsed track, or null for pad/texture. */
  function sequencerFor(track) {
    return params.tracks[track].sequencer ?? null;
  }

  function isManual(track) {
    const sequencer = sequencerFor(track);
    return Boolean(sequencer && sequencer.mode === 'manual');
  }

  // -- hold / re-roll --------------------------------------------------------

  const planKey = (track, sub) => (sub === undefined ? track : `${track}#${sub}`);

  /**
   * A held track replays the bar plan it froze; every other track realises a
   * fresh one. The plan holds the DRAWS, never absolute pitch, so a frozen bar
   * still follows the progression, root and mode — harmony keeps advancing
   * underneath a hold (ruling 5).
   */
  function planFor(track, sub, realise) {
    if (!held.has(track)) return realise();
    const key = planKey(track, sub);
    let plan = frozenPlans.get(key);
    if (!plan) {
      plan = realise();
      frozenPlans.set(key, plan);
    }
    return plan;
  }

  function clearFrozen(track) {
    for (const key of [...frozenPlans.keys()]) {
      if (key === track || key.startsWith(`${track}#`)) frozenPlans.delete(key);
    }
  }

  /** Hold engages and releases on the barline, never mid-bar. */
  function applyHolds() {
    for (const name of TRACK_ORDER) {
      const wanted = params.tracks[name].hold === true;
      if (wanted === held.has(name)) continue;
      if (wanted) {
        held.add(name);
      } else {
        held.delete(name);
        clearFrozen(name);
      }
    }
  }

  /**
   * Re-roll the material of every track randomise() named, effective from this
   * bar. A held track drops its frozen plan and re-freezes on the new draw —
   * one re-roll, then still held (ruling 5).
   */
  function consumeRandomise() {
    if (!pendingRandomise.size) return;
    for (const name of pendingRandomise) {
      clearFrozen(name);
      switch (name) {
        case 'pad':
        case 'bass':
          // pad and bass share one harmony: re-rolling either writes a new hook
          // for both, which is what "new voicing seed" means here. The bank goes
          // with it — recalling the old ear-worm is precisely what a re-roll is
          // asking not to hear.
          hook = null;
          hookBank = [];
          chordBarsLeft = 0;
          break;
        case 'melody':
          phraseBank = [];
          currentPhrase = null;
          phraseBarsLeft = 0;
          phraseBarIndex = 0;
          break;
        case 'arp':
          autoArpSteps = null;
          arpCursor = 0;
          break;
        case 'percussion':
          percussionBank = [];
          break;
        default:
          // texture draws its whole bar afresh anyway: dropping the frozen
          // plan above is the entire re-roll.
          break;
      }
    }
    pendingRandomise.clear();
  }

  function randomise(track) {
    if (track === undefined || track === null) {
      for (const name of TRACK_ORDER) pendingRandomise.add(name);
      return;
    }
    // Stopped, or an unknown track name: nothing to do, and nothing to throw.
    if (typeof track === 'string' && TRACK_ORDER.includes(track)) pendingRandomise.add(track);
  }

  // -- track activity --------------------------------------------------------

  function sectionIntensity() {
    return currentSection ? currentSection.intensity : 0.5;
  }

  function isActive(name) {
    const state = params.tracks[name].state;
    if (state === 'off') return false;
    // The closing bar always gets its pad and bass, whatever the section
    // intensity would otherwise have decided — that is the resolution.
    if (outroStarted && (name === 'pad' || name === 'bass')) return true;
    // SPEC-CRITIC [staged-drone] → ruling 7: staged entry is a property of the
    // PIECE, not of the structure preset, so it is counted in barIndex and
    // never restarts when the structure changes mid-piece. Bar 0 is pad alone
    // under every preset (drone included) and every track state — a track
    // forced 'on' still waits its turn — with all six eligible by bar 5.
    if (currentBarNumber < TRACK_ORDER.indexOf(name)) return false;
    if (state === 'on') return true;
    return autoActiveTracks(sectionIntensity(), params.complexity).includes(name);
  }

  /** Effective harmonic colour: complexity, opened up by section intensity. */
  function colour() {
    return clamp(params.complexity * (0.6 + sectionIntensity() * 0.6), 0, 1);
  }

  // -- live parameter application -------------------------------------------

  /**
   * The v8 gain chain (SPEC-CRITIC [multiplier order] → ruling 2):
   *
   *   TRACK_MIX[t].level × clamp(level-drift × volume-walk, SILENCE, 1)
   *
   * The user's `level` and the vary.volume walk multiply INSIDE a clamp to 1,
   * so the tuned v5 mix is a ceiling that nothing can push past: that clamp is
   * the headroom guarantee, and MASTER_HEADROOM stays exactly as it was. The
   * walk is 2^(0.5·a·u) with u a reflected walk in [-2, 2], i.e. ±6 dB at
   * a = 1, centred on the configured level.
   */
  function trackGain(name) {
    const mix = TRACK_MIX[name].level;
    const level = resolveRange(name, 'level', params.tracks[name].level);
    const amount = varyAmount(name, 'volume');
    const swing = Math.pow(2, 0.5 * amount * (walk(name, 'volumeWalk') * 4 - 2));
    return mix * clamp(level * swing, SILENCE, 1);
  }

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
      const level = isActive(name) ? trackGain(name) : SILENCE;
      track.input.gain.setTargetAtTime(Math.max(level, SILENCE), time, constant);
      const brightness = clamp(TRACK_MIX[name].tone * (0.55 + intensity * 0.75), 300, 18000);
      track.tone.frequency.setTargetAtTime(brightness, time, constant);
    }
  }

  /** The patch the currently selected voice of `track` should be played with. */
  function patchFor(track) {
    const bank = params.patches[track];
    if (!bank) return undefined;
    return bank[effectiveVoice(track)];
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

  function voiceBank(track) {
    return voices && voices[track] && Object.keys(voices[track]).length
      ? voices[track]
      : FALLBACK_VOICES[track];
  }

  /**
   * The voice a track is ACTUALLY sounding: the user's choice, unless vary.voice
   * has wandered it. The wander is deliberately kept out of `params`, so
   * getParams() keeps reporting what the user selected (v6 amendment 2).
   */
  function effectiveVoice(track) {
    return wanderedVoice.get(track) ?? params.tracks[track].voice;
  }

  function voiceFor(track) {
    const bank = voiceBank(track);
    // A voice id the library does not know (stale localStorage, renamed voice)
    // falls back to that track's first voice rather than going silent.
    const chosen = bank[effectiveVoice(track)] ?? bank[Object.keys(bank)[0]];
    if (chosen && typeof chosen.play === 'function') return chosen;
    const spare = FALLBACK_VOICES[track][Object.keys(FALLBACK_VOICES[track])[0]];
    return spare ?? null;
  }

  /**
   * One wander draw per track per bar, p = 0.25 × vary.voice. Only new notes are
   * affected — the engine builds a voice per note, so the switch cannot click —
   * and the sends are re-applied because the new voice publishes its own.
   *
   * An 'off' track is not evaluated at all (the off state is absolute), and a
   * held track keeps the voice it froze on, in line with hold freezing the rest
   * of the bar's draws.
   */
  function wanderVoices(time) {
    let changed = false;
    for (const name of TRACK_ORDER) {
      if (params.tracks[name].state === 'off' || held.has(name)) continue;
      const amount = varyAmount(name, 'voice');
      if (amount <= 0) {
        if (wanderedVoice.delete(name)) changed = true;
        continue;
      }
      if (rng() >= VOICE_WANDER_CHANCE * amount) continue;
      const others = Object.keys(voiceBank(name)).filter((id) => id !== effectiveVoice(name));
      if (!others.length) continue;
      const next = pick(others, rng);
      if (next === params.tracks[name].voice) wanderedVoice.delete(name);
      else wanderedVoice.set(name, next);
      changed = true;
    }
    if (changed) applySends(0.4, time);
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
      if (!entry.handle) continue;
      try {
        entry.handle.cancel();
      } catch {
        // A note that will not cancel is still just one note.
      }
    }
    liveNotes.clear();
  }

  /** Notes whose audible span covers `at` — the polyphony the CPU pays for now. */
  function countSounding(at) {
    let count = 0;
    for (const entry of liveNotes) {
      if (entry.when <= at && entry.until > at) count += 1;
    }
    return count;
  }

  /**
   * v9 voice-steal: with a power budget in force, make room for the note about
   * to be scheduled by cancelling the quietest live one — the oldest of equals,
   * and an already-sounding note ahead of one the lookahead has merely queued.
   *
   * The budget counts every note that has not finished by `at`, queued ones
   * included, rather than only those already sounding: a bar is scheduled in
   * one burst and out of onset order (the bass claims the second half of the
   * bar before the melody claims its first beat), so counting onsets alone
   * would let a burst sail past the cap and land it on the audio thread anyway.
   *
   * A note whose voice published no cancel handle cannot be stolen, so a
   * library of un-cancellable voices degrades to "no budget", not to silence.
   */
  function stealForBudget(at) {
    if (!Number.isFinite(maxNotes)) return;
    // Lower sorts first: already sounding before queued, then quietest, then oldest.
    const rank = (entry) => [entry.when <= at ? 0 : 1, entry.velocity, entry.when];
    const worse = (a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      for (let i = 0; i < ra.length; i++) {
        if (ra[i] !== rb[i]) return ra[i] < rb[i];
      }
      return false;
    };
    let guard = 0;
    while (guard++ < 64) {
      let allocated = 0;
      let victim = null;
      for (const entry of liveNotes) {
        if (entry.until <= at) continue;
        allocated += 1;
        if (entry.handle && (!victim || worse(entry, victim))) victim = entry;
      }
      if (allocated < maxNotes || !victim) return;
      try {
        victim.handle.cancel();
      } catch {
        // Unstealable, but it is off the books either way.
      }
      liveNotes.delete(victim);
    }
  }

  /** Rolling per-track onset history behind getStats().notesPerMin. */
  function recordNote(track, when) {
    let times = noteTimes.get(track);
    if (!times) {
      times = [];
      noteTimes.set(track, times);
    }
    times.push(when);
    const from = when - NOTE_RATE_WINDOW;
    let stale = 0;
    while (stale < times.length && times[stale] < from) stale += 1;
    if (stale) times.splice(0, stale);
  }

  function playNote(track, note) {
    const midi = note.midi ?? null;
    // Timing humanisation can pull a note behind its grid position, so it is
    // floored at the current downbeat: a note dragged back over the barline
    // would land in a bar the scheduler has already dispatched. The lookahead
    // itself needs no clamp — the spread (±25 ms) is a fifth of LOOKAHEAD, so
    // a nudge can never reach behind the horizon the pulse was scheduled in.
    const wanted = Number.isFinite(note.when) ? note.when : (ctx ? ctx.currentTime : 0);
    const floor = currentBarTime;
    const full = {
      midi,
      freq: note.freq ?? (midi === null ? null : midiToFreq(midi)),
      velocity: clamp(Number(note.velocity) || 0.7, 0.01, 1),
      duration: Math.max(0.02, Number(note.duration) || 0.3),
      when: Math.max(wanted, floor),
      pan: clamp(Number(note.pan) || 0, -1, 1),
      kind: note.kind ?? null,
    };
    const voice = voiceFor(track);
    if (voice) {
      stealForBudget(full.when);
      try {
        const handle = voice.play(ctx, graph.tracks[track].input, full, patchFor(track));
        // Every note is booked, handle or not: the cost meters count them all.
        // A handle also lets stop() and the power budget hard-stop the note —
        // a suspended context would otherwise freeze its tail, which
        // resurrects, possibly in an old key, on the next start().
        pruneLiveNotes();
        liveNotes.add({
          track,
          handle: handle && typeof handle.cancel === 'function' ? handle : null,
          velocity: full.velocity,
          when: full.when,
          until: full.when + full.duration,
          end: full.when + full.duration + CANCEL_TAIL,
        });
      } catch {
        // A broken voice loses its note, not the whole performance.
      }
    }
    recordNote(track, full.when);
    emit('note', {
      track,
      midi: full.midi,
      kind: full.kind,
      velocity: full.velocity,
      time: full.when,
      duration: full.duration,
    });
  }

  // -- harmony: the hook -----------------------------------------------------

  const HOOK_BANK_SIZE = 6;         // ear-worms kept; the least salient is dropped
  const HOOK_RECALL_MIN = 4;        // loop passes between recalls, at repetition 1
  const HOOK_RECALL_SPAN = 4;       // extra passes the cycle can run to at repetition 0
  const HOOK_SNAPSHOT_EVERY = 3;    // passes between bank snapshots
  const HOOK_STABLE_TO_BANK = 2;    // passes unmutated that make a variant worth keeping
  const HOOK_HOT_INTENSITY = 0.7;   // section intensity that makes a pass worth keeping

  /** Establish the loop and arm the first recall cycle. */
  function establishHook() {
    hook = buildHook({
      scaleLength: scale().length,
      complexity: params.complexity,
      repetition: params.repetition,
      rng,
    });
    hookIndex = 0;
    hookFresh = true;
    hookPass = 0;
    hookStable = 0;
    hookBank = [];
    hookSectionPending = false;
    hookRecallAt = nextRecallPass();
  }

  /**
   * When the ear-worm comes back. High repetition makes the cycle exactly its
   * shortest, so a tight loop returns to its banked shapes predictably; low
   * repetition lets the cycle run out to eight passes.
   */
  function nextRecallPass() {
    const reach = 1 + Math.round(HOOK_RECALL_SPAN * (1 - params.repetition));
    return hookPass + HOOK_RECALL_MIN + (Math.floor(rng() * reach) % reach);
  }

  /** How often a completed pass ends in a mutation: rare when repetition is high. */
  function hookMutationChance() {
    return clamp(0.12 + (1 - params.repetition) * 0.63, 0, 0.85);
  }

  /**
   * A periodic snapshot, ranked by a deliberately crude salience: a variant
   * that has survived a few passes untouched is a shape the ear has had time to
   * learn, and one playing under a hot section is a shape the piece peaked on.
   * Either also earns a slot off-cycle. The snapshot is what keeps the bank
   * stocked — waiting for salience alone starves it at low repetition, where
   * mutation rarely lets a variant sit still for long.
   */
  function bankHook(intensity) {
    const hot = intensity >= HOOK_HOT_INTENSITY;
    const due = hookPass % HOOK_SNAPSHOT_EVERY === 0;
    if (!due && hookStable < HOOK_STABLE_TO_BANK && !hot) return;
    const salience = hookStable + (hot ? 2 : 0);
    const key = hookKey(hook);
    const known = hookBank.find((entry) => entry.key === key);
    if (known) {
      known.salience = Math.max(known.salience, salience);
      return;
    }
    hookBank.push({ key, variant: cloneHook(hook), salience });
    if (hookBank.length > HOOK_BANK_SIZE) {
      let worst = 0;
      for (let i = 1; i < hookBank.length; i++) {
        if (hookBank[i].salience < hookBank[worst].salience) worst = i;
      }
      hookBank.splice(worst, 1);
    }
  }

  /**
   * Bring a banked variant back. Salience is the base weight; section intensity
   * tilts the draw towards the busier, more extended variants as the piece
   * lifts, and back towards the plain ones as it settles. A recall of what is
   * already playing is not a return, so the current variant is never a
   * candidate: an empty field means no recall this pass.
   */
  function recallHook(intensity) {
    const playing = hookKey(hook);
    const candidates = hookBank.filter((entry) => entry.key !== playing);
    if (!candidates.length) return false;
    const weights = candidates.map((entry) => Math.max(0.05,
      0.5 + entry.salience * 0.25 + (intensity - 0.5) * 2 * hookEnergy(entry.variant)));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let r = rng() * total;
    let chosen = candidates[candidates.length - 1];
    for (let i = 0; i < candidates.length; i++) {
      r -= weights[i];
      if (r <= 0) { chosen = candidates[i]; break; }
    }
    hook = cloneHook(chosen.variant);
    hookStable = 0;
    return true;
  }

  /**
   * End of a loop pass: bank what deserves it, then decide what the next pass
   * plays — a section's pick, a recall, one mutation, or the same thing again.
   * At most one of those happens, so the loop never changes twice at once.
   */
  function completeHookPass(intensity) {
    hookPass += 1;
    bankHook(intensity);
    if (hookSectionPending && recallHook(intensity)) {
      hookSectionPending = false;
      hookRecallAt = nextRecallPass();
      return;
    }
    hookSectionPending = false;
    if (hookPass >= hookRecallAt && recallHook(intensity)) {
      hookRecallAt = nextRecallPass();
      return;
    }
    if (rng() < hookMutationChance()) {
      hook = mutateHook(hook, {
        scaleLength: scale().length,
        complexity: params.complexity,
        rng,
      });
      hookStable = 0;
      return;
    }
    hookStable += 1;
  }

  /**
   * Advance to the next chord of the hook and publish it as the harmonic frame
   * every track reads. A held track re-derives its frozen plan against whatever
   * this supplies, which is how hold keeps following the harmony (ruling 5).
   */
  function advanceHarmony(intensity) {
    if (!hook) establishHook();
    if (hookFresh) {
      hookFresh = false;
    } else {
      hookIndex += 1;
      if (hookIndex >= hook.degrees.length) {
        hookIndex = 0;
        completeHookPass(intensity);
      }
    }
    const n = scale().length;
    // The slot degree is taken modulo the CURRENT scale: a mode change mid-piece
    // shortens the scale under a loop that was written in a longer one.
    chordDegree = ((hook.degrees[hookIndex] % n) + n) % n;
    chordInversion = hook.inversions[hookIndex];
    chordExtension = hook.extensions[hookIndex];
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
      // vary.pitch buys extra stepwise motion on top of the complexity-derived
      // likelihood, which is the "note-choice spread" half of the macro.
      passing: clamp(params.complexity * 0.55 + varyAmount('melody', 'pitch') * 0.3, 0, 0.9),
      rng,
    });
    phraseBank.push(phrase);
    if (phraseBank.length > 8) phraseBank.shift();
    return phrase;
  }

  /** The current chord, voiced upward from `baseOctave` with no crossings. */
  function chordMidis(baseOctave, maxNotes) {
    const degrees = voiceHookChord(chordDegree, colour(), {
      inversion: chordInversion,
      extension: chordExtension,
      scaleLength: scale().length,
    }).slice(0, maxNotes);
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

  const PAD_REST_BASE = 0.06;      // chance a calm chord span is left silent
  const PAD_REST_SPAN = 0.2;       // ...plus this much at randomness 1
  const PAD_REATTACK_BASE = 0.12;  // chance of the half-bar breath
  const PAD_REATTACK_SPAN = 0.4;   // ...plus this much at randomness 1
  const PAD_REATTACK_LEVEL = 0.7;  // the breath sits under the downbeat attack
  const PAD_SWELL_BARS = 4;        // period of the pad's dynamic contour
  const PAD_SWELL_DEPTH = 0.28;    // velocity swing at section intensity 1

  /**
   * The pad's bar plan: how wide the voicing is, plus one velocity jitter per
   * possible note. Pitch is left to dispatch so a held pad still follows the
   * chord under it.
   *
   * v11 anti-monotony: the plan also carries this chord span's BREATHING — an
   * occasional half-bar re-attack, an occasional rest, and a swell factor. One
   * unbroken chord per one-or-two bars is what makes the pad feel like a held
   * key rather than a played instrument.
   */
  function planPad() {
    const intensity = sectionIntensity();
    const spread = trackRandomness('pad');
    return {
      maxNotes: colour() > 0.5 ? 4 : 3,
      jitters: Array.from({ length: 5 }, () => velocityJitter('pad')),
      nudges: Array.from({ length: 5 }, () => timingNudge('pad')),
      pans: Array.from({ length: 5 }, () => panSpread('pad')),
      // Rests thin out as the section lifts; re-attacks do the opposite.
      rest: rng() < (PAD_REST_BASE + spread * PAD_REST_SPAN) * (1 - intensity),
      reattack: rng() < (PAD_REATTACK_BASE + spread * PAD_REATTACK_SPAN) * (0.5 + intensity),
      // A smooth contour rather than a per-bar draw: the pad swells and settles
      // over four bars, and only as far as the section's intensity asks.
      swell: 1 + Math.sin(padSwellPhase * Math.PI * 2) * PAD_SWELL_DEPTH * intensity,
    };
  }

  function attackChord(time, duration, plan, level) {
    const midis = chordMidis(3, plan.maxNotes);
    // Velocity per note shrinks as the voicing thickens, keeping the pad's
    // total contribution roughly constant.
    const velocity = clamp(0.85 / Math.sqrt(midis.length), 0.15, 1)
      * clamp(plan.swell ?? 1, 0.4, 1.4) * level;
    midis.forEach((midi, i) => {
      const spread = midis.length > 1 ? (i / (midis.length - 1) - 0.5) * 0.5 : 0;
      playNote('pad', {
        midi,
        when: time + plan.nudges[i],
        duration,
        velocity: velocity * plan.jitters[i],
        pan: spread + plan.pans[i],
      });
    });
  }

  function playChordVoicing(time, duration, plan) {
    attackChord(time, duration, plan, 1);
    if (!plan.reattack) return;
    // The breath: the same voicing struck again, softer, half a bar in and
    // ringing to the end of the chord span.
    const half = bar.duration * 0.5;
    if (duration - half < 0.2) return;
    attackChord(time + half, duration - half, plan, PAD_REATTACK_LEVEL);
  }

  /** Which pulse of the current bar a beat position falls in. */
  function pulseAtBeat(beat) {
    let index = 0;
    for (let i = 0; i < bar.starts.length; i++) {
      if (bar.starts[i] <= beat + 1e-9) index = i;
    }
    return index;
  }

  /** A sixteenth slot that starts a felt pulse — where the harmony must land. */
  function isStrongBeat(beat) {
    return bar.starts.some((start) => Math.abs(start - beat) < 1e-9);
  }

  /**
   * Manual bass: the step grid decides WHEN, the chord still decides WHAT. The
   * v8 harmonic contract survives because only offbeat steps are ever allowed
   * the fifth — every strong beat voices the root of the current chord.
   */
  function planBassManual() {
    const lane = sequencerFor('bass').steps;
    const slots = sequencerStepsPerBar(params.timeSignature);
    const steps = [];
    for (let i = 0; i < slots; i++) {
      const step = lane[i];
      if (!step.on) continue;
      if (rng() >= effectiveProb('bass', `step.${i}`, step.prob)) continue;
      const beat = i / 4;
      steps.push({
        beat,
        fifth: !isStrongBeat(beat) && rng() < 0.35,
        velocity: between(step.vmin, step.vmax, rng) * velocityJitter('bass'),
        nudge: timingNudge('bass'),
      });
    }
    return { manual: true, steps };
  }

  function planBass() {
    if (isManual('bass')) return planBassManual();
    return {
      manual: false,
      twoNotes: rng() < 0.25 + params.complexity * 0.3 + sectionIntensity() * 0.2,
      fifth: rng() < 0.6,
      jitters: [velocityJitter('bass'), velocityJitter('bass')],
      nudges: [timingNudge('bass'), timingNudge('bass')],
    };
  }

  function scheduleBass(time, barDuration, plan) {
    const root = scaleDegreeToMidi(chordDegree, scale(), pitchClass(params.root), 2);
    const fifth = () => quantiseToScale(root + 7, scale(), pitchClass(params.root));
    if (plan.manual) {
      plan.steps.forEach((step, i) => {
        // A step rings until the next one, so a sparse grid still sustains.
        const next = i + 1 < plan.steps.length ? plan.steps[i + 1].beat : bar.beats;
        playNote('bass', {
          midi: step.fifth ? fifth() : root,
          when: time + step.beat * bar.secPerBeat + step.nudge,
          duration: Math.max(0.08, (next - step.beat) * bar.secPerBeat * 0.9),
          velocity: step.velocity,
        });
      });
      return;
    }
    if (!plan.twoNotes) {
      playNote('bass', {
        midi: root,
        when: time + plan.nudges[0],
        duration: barDuration * 0.9,
        velocity: 0.8 * plan.jitters[0],
      });
      return;
    }
    playNote('bass', {
      midi: root,
      when: time + plan.nudges[0],
      duration: barDuration * 0.45,
      velocity: 0.8 * plan.jitters[0],
    });
    // Second note is usually the fifth above, snapped back into the mode.
    playNote('bass', {
      midi: plan.fifth ? fifth() : root,
      when: time + barDuration * 0.5 + plan.nudges[1],
      duration: barDuration * 0.45,
      velocity: 0.7 * plan.jitters[1],
    });
  }

  /**
   * One bar of the current phrase, thinned and panned up front. Degrees stay
   * RELATIVE to the chord, so a held melody keeps tracking the progression.
   */
  /**
   * The degrees this bar of the phrase offers a manual grid, in phrase order.
   * A bar the phrase says nothing about borrows the whole phrase, and a phrase
   * that has gone silent falls back to the chord tones — the grid is about
   * rhythm, so it must never run out of notes to place.
   */
  function phraseDegrees() {
    if (!currentPhrase || !currentPhrase.notes.length) return [0, 2, 4];
    const thisBar = currentPhrase.notes.filter((note) => note.bar === phraseBarIndex);
    return (thisBar.length ? thisBar : currentPhrase.notes).map((note) => note.degree);
  }

  /** Manual melody: the grid gates when, the phrase still supplies the pitches. */
  function planMelodyManual() {
    const lane = sequencerFor('melody').steps;
    const slots = sequencerStepsPerBar(params.timeSignature);
    const degrees = phraseDegrees();
    const notes = [];
    let taken = 0;
    for (let i = 0; i < slots; i++) {
      const step = lane[i];
      if (!step.on) continue;
      if (rng() >= effectiveProb('melody', `step.${i}`, step.prob)) continue;
      notes.push({
        beat: i / 4,
        degree: degrees[taken++ % degrees.length],
        duration: 1,
        velocity: between(step.vmin, step.vmax, rng) * velocityJitter('melody'),
        pan: between(-0.25, 0.25, rng) + panSpread('melody'),
        octave: octaveWander('melody'),
        nudge: timingNudge('melody'),
      });
    }
    return notes;
  }

  function planMelody(intensity) {
    if (isManual('melody')) return planMelodyManual();
    if (!currentPhrase) return [];
    const notes = [];
    for (const note of currentPhrase.notes) {
      if (note.bar !== phraseBarIndex) continue;
      // Quieter sections thin the line out rather than muting it.
      if (rng() > 0.55 + intensity * 0.45) continue;
      notes.push({
        beat: note.beat,
        degree: note.degree,
        duration: note.duration,
        velocity: note.velocity * velocityJitter('melody'),
        pan: between(-0.25, 0.25, rng) + panSpread('melody'),
        octave: octaveWander('melody'),
        nudge: timingNudge('melody'),
      });
    }
    return notes;
  }

  /** Texture is pure drift: scale degrees rather than chord tones, one draw per pulse. */
  function planTexture(intensity) {
    const chance = clamp((0.05 + params.complexity * 0.3) * (0.5 + intensity), 0, 1);
    const events = [];
    for (let index = 0; index < bar.pulses.length; index++) {
      if (rng() >= chance) continue;
      events.push({
        pulse: index,
        degree: Math.floor(rng() * bar.scale.length * 2),
        offset: rng() * bar.pulses[index],
        duration: between(3, 6, rng),
        velocity: between(0.3, 0.6, rng) * velocityJitter('texture'),
        pan: between(-0.8, 0.8, rng) + panSpread('texture'),
        octave: octaveWander('texture'),
        nudge: timingNudge('texture'),
      });
    }
    return events;
  }

  /** Manual arp settings verbatim, or the complexity-derived auto ones. */
  function effectiveArp(intensity, needMask) {
    if (params.arp.mode === 'manual') return params.arp;
    const auto = autoArpSettings(params.complexity);
    const density = clamp(auto.density * (0.45 + intensity * 0.8), 0, 1);
    // The sequencer lane replaces the mask outright in manual mode, so there is
    // nothing to draw for and no rng to spend.
    if (!needMask) return { ...auto, gate: params.arp.gate, steps: null };
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

  /**
   * Grid positions for one bar of arpeggio. Swing-free by construction. Steps
   * carry an INDEX into the arp sequence rather than a MIDI note, and a gate in
   * beats rather than seconds, so a frozen plan re-derives against the current
   * chord and tempo when hold replays it.
   */
  function planArp(intensity) {
    // Ruling 9a: the arp lane is indexed by arp step within the bar at the
    // CURRENT rate — not by sixteenth like the other sequenced tracks — so it
    // replaces the old 16-boolean mask one slot for one slot.
    const manual = isManual('arp');
    const cfg = effectiveArp(intensity, !manual);
    const stepBeats = ARP_RATES[cfg.rate] ?? 0.5;
    const lane = manual ? sequencerFor('arp').steps : null;
    const laneLength = manual ? arpLaneLength(params.timeSignature, cfg.rate) : 0;
    const sequence = buildArpSequence(chordMidis(4, 4), cfg.pattern, cfg.octaves);
    if (!sequence.length) return null;
    const plan = { pattern: cfg.pattern, octaves: cfg.octaves, steps: [] };
    let steps = 0;
    // The step grid is bar-anchored: step 0 realigns to every barline. A phase
    // carried across bars rotates the pattern in any metre where a bar is not a
    // whole number of mask cycles (repro'd at 1/8T: offsets drifted 0, 12, 8,
    // 4). arpCursor is deliberately NOT reset, so the note sequence itself
    // stays continuous for melodic flow.
    for (let beat = 0; beat < bar.beats - 1e-6; beat += stepBeats) {
      const index = steps;
      steps += 1;
      let velocity;
      if (manual) {
        // Slots past the lane length belong to no arp step in this metre.
        if (index >= laneLength) continue;
        const step = lane[index];
        if (!step.on) continue;
        if (rng() >= effectiveProb('arp', `step.${index}`, step.prob)) continue;
        velocity = between(step.vmin, step.vmax, rng) * velocityJitter('arp');
      } else {
        const maskIndex = index % ARP_STEP_COUNT;
        if (!cfg.steps[maskIndex]) continue;
        const accent = maskIndex % 4 === 0;
        velocity = ((accent ? 0.62 : 0.45) * (0.6 + intensity * 0.55) + rng() * 0.08)
          * velocityJitter('arp');
      }
      const seqIndex = cfg.pattern === 'random'
        ? Math.floor(rng() * sequence.length) % sequence.length
        : (arpCursor + index) % sequence.length;
      plan.steps.push({
        beat,
        seqIndex,
        gateBeats: stepBeats * cfg.gate,
        velocity: clamp(velocity, 0.05, 1),
        pan: ((((index % 4)) - 1.5) / 1.5) * 0.3 + panSpread('arp'),
        octave: octaveWander('arp'),
        nudge: timingNudge('arp'),
      });
    }
    arpCursor = (arpCursor + steps) % sequence.length;
    return plan;
  }

  /** The MIDI notes a frozen or fresh arp plan points at, in the current chord. */
  function arpSequenceFor(plan) {
    return buildArpSequence(chordMidis(4, 4), plan.pattern, plan.octaves);
  }

  /**
   * The closing bar: a root-position tonic triad on the pad and the tonic in
   * the bass, sustained under the outro fade. Every other track is silent from
   * here — the ending resolves, it does not keep decorating.
   */
  function scheduleClosingBar(time) {
    chordDegree = 0;
    chordInversion = 0;
    chordExtension = 0;
    chordBarsLeft = 0;
    arpPlan = null;
    percussionPlan = [];
    melodyPlan = [];
    texturePlan = [];
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

  /**
   * Low-frequency content stays centred — the engine already pins the low lane
   * to the middle — so only mid and high hits take a stereo placement.
   */
  function percussionPan(kind) {
    return kind === 'low' ? 0 : between(-0.6, 0.6, rng) + panSpread('percussion');
  }

  /**
   * Manual percussion: three lanes on the sixteenth grid, each slot firing
   * against its own probability and velocity band, kind = lane.
   */
  function planPercussionManual() {
    const lanes = sequencerFor('percussion').steps;
    const slots = sequencerStepsPerBar(params.timeSignature);
    const hits = [];
    for (const lane of PERCUSSION_LANES) {
      for (let i = 0; i < slots; i++) {
        const step = lanes[lane][i];
        if (!step.on) continue;
        if (rng() >= effectiveProb('percussion', `step.${lane}.${i}`, step.prob)) continue;
        const beat = i / 4;
        const pulse = pulseAtBeat(beat);
        hits.push({
          pulse,
          offset: beat - bar.starts[pulse],
          kind: lane,
          velocity: between(step.vmin, step.vmax, rng) * velocityJitter('percussion'),
          pan: percussionPan(lane),
          nudge: timingNudge('percussion'),
        });
      }
    }
    hits.sort((a, b) => a.pulse - b.pulse || a.offset - b.offset);
    return hits;
  }

  /** Banked patterns are shared between bars, so the jitter is applied per bar. */
  function planPercussion(intensity) {
    if (isManual('percussion')) return planPercussionManual();
    return choosePercussion(intensity).map((hit) => ({
      ...hit,
      velocity: hit.velocity * velocityJitter('percussion'),
      pan: percussionPan(hit.kind),
      nudge: timingNudge('percussion'),
    }));
  }

  // -- scheduler -------------------------------------------------------------

  /**
   * Snapshot tempo, metre and section for the bar about to start, then schedule
   * the bar-level events (chord change, pad voicing, bass, arp and percussion
   * plans). bpm, speed, time signature, root, mode and structure are read here
   * and nowhere else, which is what quantises those changes to bar boundaries.
   */
  function beginBar(time) {
    currentBarNumber = barIndex;
    currentBarTime = time;
    if (params.timeSignature !== bankTimeSignature) {
      // Stored percussion patterns carry pulse indexes, and stored phrases
      // carry beat positions, from the metre they were made in; replayed in a
      // shorter metre their out-of-range events are silently dropped and the
      // track thins out. Start both banks afresh in the new metre. A frozen bar
      // plan is grid-bound the same way, so hold re-freezes in the new metre.
      bankTimeSignature = params.timeSignature;
      percussionBank = [];
      phraseBank = [];
      currentPhrase = null;
      phraseBarsLeft = 0;
      frozenPlans.clear();
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
      // A section change picks the hook variant that suits the new intensity —
      // at the next pass boundary, never mid-loop, so the loop stays a loop.
      if (changed) hookSectionPending = true;
      currentSection = section;
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

    // Hold, re-rolls and the drift walks all settle before anything is drawn,
    // so a bar is realised exactly once against a stable set of decisions.
    applyHolds();
    advanceWalks();
    consumeRandomise();
    wanderVoices(time);
    // Track gains are re-applied EVERY bar, not only when the section changes:
    // staged entry brings tracks in over the first six bars and the level and
    // volume walks step once a bar (just above), so a drone section would
    // otherwise freeze both at whatever bar 0 decided — leaving every track but
    // the pad silent for the whole piece.
    applyTracks(0.4, time);

    // The pad's dynamic contour runs off the bar clock, not off the chord
    // rhythm, so a two-bar chord still swells rather than sitting flat.
    padSwellPhase = (padSwellPhase + 1 / PAD_SWELL_BARS) % 1;

    if (chordBarsLeft <= 0) {
      // Harmony advances even under hold: a held track keeps following the hook,
      // it just stops re-drawing its own material (ruling 5).
      advanceHarmony(intensity);
      // Slower harmonic rhythm when the listener wants repetition.
      chordBarsLeft = rng() < 0.5 + params.repetition * 0.2 ? 2 : 1;
      if (isActive('pad')) {
        const plan = planFor('pad', undefined, planPad);
        // The no-two-consecutive-rests rule is enforced HERE rather than in the
        // plan, so a held pad whose frozen plan says "rest" breathes in and out
        // instead of going silent for the length of the hold.
        const resting = plan.rest && !padRested;
        padRested = resting;
        if (!resting) playChordVoicing(time, bar.duration * chordBarsLeft, plan);
      }
    }
    chordBarsLeft -= 1;

    if (isActive('bass')) {
      scheduleBass(time, bar.duration, planFor('bass', undefined, planBass));
    }

    if (phraseBarsLeft <= 0) {
      if (held.has('melody') && currentPhrase) {
        // A held melody loops the phrase it is on rather than drawing a new one.
        phraseBarsLeft = currentPhrase.bars;
        phraseBarIndex = 0;
      } else {
        currentPhrase = choosePhrase();
        phraseBarsLeft = currentPhrase.bars;
        phraseBarIndex = 0;
      }
    } else {
      phraseBarIndex += 1;
    }
    phraseBarsLeft -= 1;

    // Each bar of a multi-bar phrase freezes separately, so a held melody loops
    // at the phrase's own length instead of collapsing to one bar. A manual
    // grid has no such length — the lane IS the material and it is bar-anchored
    // — so it freezes as one plan that repeats every bar.
    melodyPlan = isActive('melody')
      ? planFor('melody', isManual('melody') ? undefined : phraseBarIndex,
        () => planMelody(intensity)) : [];
    texturePlan = isActive('texture')
      ? planFor('texture', undefined, () => planTexture(intensity)) : [];
    arpPlan = isActive('arp')
      ? planFor('arp', undefined, () => planArp(intensity)) : null;
    percussionPlan = isActive('percussion')
      ? planFor('percussion', undefined, () => planPercussion(intensity)) : [];

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

    if (isActive('melody')) {
      for (const note of melodyPlan) {
        if (note.beat < from || note.beat >= to) continue;
        const at = time + (note.beat - from) * bar.secPerBeat + (note.nudge ?? 0);
        let midi = scaleDegreeToMidi(
          chordDegree + note.degree, bar.scale, bar.rootPc, 4,
        );
        // keep the melody in octaves 4–5
        while (midi > 83) midi -= 12;
        while (midi < 60) midi += 12;
        // The register wander is applied AFTER the fold, or the fold would
        // simply undo it; the wider guard is the melody's absolute range.
        midi = clamp(midi + 12 * (note.octave ?? 0), 48, 95);
        playNote('melody', {
          midi,
          when: at,
          duration: clamp(note.duration * bar.secPerBeat * 1.6, 0.6, 3),
          velocity: note.velocity,
          pan: note.pan,
        });
      }
    }

    if (isActive('texture')) {
      for (const event of texturePlan) {
        if (event.pulse !== index) continue;
        let midi = scaleDegreeToMidi(event.degree, bar.scale, bar.rootPc, 6);
        while (midi > 100) midi -= 12;
        while (midi < 79) midi += 12;
        midi = clamp(midi + 12 * (event.octave ?? 0), 67, 108);
        playNote('texture', {
          midi,
          when: time + event.offset * bar.secPerBeat + (event.nudge ?? 0),
          duration: event.duration,
          velocity: event.velocity,
          pan: event.pan,
        });
      }
    }

    if (arpPlan) {
      const sequence = arpSequenceFor(arpPlan);
      for (const step of arpPlan.steps) {
        if (step.beat < from || step.beat >= to || !sequence.length) continue;
        const midi = sequence[step.seqIndex % sequence.length] + 12 * (step.octave ?? 0);
        playNote('arp', {
          midi: clamp(midi, 36, 96),
          when: time + (step.beat - from) * bar.secPerBeat + (step.nudge ?? 0),
          duration: Math.max(0.05, step.gateBeats * bar.secPerBeat),
          velocity: step.velocity,
          pan: step.pan,
        });
      }
    }

    for (const hit of percussionPlan) {
      if (hit.pulse !== index) continue;
      const offset = Math.min(hit.offset, length * 0.9);
      playNote('percussion', {
        midi: null,
        freq: null,
        kind: hit.kind,
        when: time + offset * bar.secPerBeat + (hit.nudge ?? 0),
        duration: hit.kind === 'low' ? 0.4 : hit.kind === 'mid' ? 0.22 : 0.14,
        velocity: hit.velocity,
        pan: hit.pan ?? 0,
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
      currentBarNumber = 0;
      currentBarTime = 0;
      structureBar = 0;
      structureKey = '';
      sectionAnnounced = false;
      arpCursor = 0;
      arpPlan = null;
      percussionPlan = [];
      melodyPlan = [];
      texturePlan = [];
      // A performance starts from a fresh set of decisions: no frozen bar from
      // the last run, and drift walks that begin wherever this run takes them.
      walkPhases.clear();
      frozenPlans.clear();
      held.clear();
      // The voice wander is ephemeral: a new performance starts on the voices
      // the user actually selected.
      wanderedVoice.clear();
      noteTimes.clear();
      statsStart = ctx.currentTime;
      delayTarget = 0;
      currentSection = sectionAtBar(
        resolveStructure(params.structure, params.complexity, params.customStructure),
        0,
        params.customStructure,
      );
      nextPulseTime = ctx.currentTime + 0.15;
      padSwellPhase = 0;
      padRested = false;
      // A performance opens on the hook's tonic. Establishing here rather than
      // at the first barline is also what resets a loop the last run left
      // mid-pass, and re-reads a mode or repetition changed while stopped.
      establishHook();
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
    wanderedVoice.clear();
    if (!isRunning) return;
    isRunning = false;
    emit('state', { running: false });
    if (!ctx || !graph) return;
    applyLevels(FADE_OUT);
    scheduleSuspend(FADE_OUT + 0.2);
  }

  /**
   * A sequencer edit — mode switch or step change, in either the authoritative
   * or the legacy shape — invalidates the bar plan a hold is replaying, so the
   * edit is audible on the next bar instead of waiting for the hold to lift.
   */
  function invalidateEditedPlans(partial) {
    if (!partial || typeof partial !== 'object') return;
    const tracks = partial.tracks && typeof partial.tracks === 'object' ? partial.tracks : null;
    for (const name of SEQUENCED_TRACKS) {
      const track = tracks && tracks[name] && typeof tracks[name] === 'object' ? tracks[name] : null;
      if (track && 'sequencer' in track) clearFrozen(name);
    }
    if (partial.arp && typeof partial.arp === 'object' && 'steps' in partial.arp) clearFrozen('arp');
    if (partial.percussion && typeof partial.percussion === 'object') clearFrozen('percussion');
  }

  /** An explicit voice choice ends any wander on that track, at once. */
  function clearWanderedVoices(partial) {
    const tracks = partial && typeof partial === 'object' && partial.tracks
      && typeof partial.tracks === 'object' ? partial.tracks : null;
    if (!tracks) return;
    for (const name of TRACK_ORDER) {
      const track = tracks[name] && typeof tracks[name] === 'object' ? tracks[name] : null;
      if (track && 'voice' in track) wanderedVoice.delete(name);
    }
  }

  function setParams(partial) {
    params = sanitiseParams(partial, params);
    invalidateEditedPlans(partial);
    clearWanderedVoices(partial);
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

  /**
   * v9 cost meters. `activeNotes` counts notes actually sounding right now (not
   * the scheduled-but-silent ones the lookahead has already queued);
   * `notesPerMin` is a rolling rate over the last NOTE_RATE_WINDOW seconds,
   * extrapolated while the run is younger than the window; `nodesEstimate` is a
   * coarse proxy for the UI's cost meter — the fixed per-track chain plus an
   * averaged per-note node count, NOT a census (voices build what they need).
   * `total` is an alias of `totalActiveNotes` for the power governor's naming.
   */
  function getStats() {
    pruneLiveNotes();
    const at = ctx ? ctx.currentTime : 0;
    const span = clamp(at - statsStart, 1, NOTE_RATE_WINDOW);
    const perTrack = {};
    for (const name of TRACK_ORDER) {
      perTrack[name] = { activeNotes: 0, nodesEstimate: 0, notesPerMin: 0 };
    }
    let totalActiveNotes = 0;
    for (const entry of liveNotes) {
      if (entry.when > at || entry.until <= at) continue;
      perTrack[entry.track].activeNotes += 1;
      totalActiveNotes += 1;
    }
    for (const name of TRACK_ORDER) {
      const times = noteTimes.get(name);
      const recent = times ? times.filter((when) => when > at - NOTE_RATE_WINDOW).length : 0;
      perTrack[name].notesPerMin = round3((recent * 60) / span);
      perTrack[name].nodesEstimate = ctx
        ? NODES_PER_TRACK + perTrack[name].activeNotes * NODES_PER_NOTE
        : 0;
    }
    return { perTrack, totalActiveNotes, total: totalActiveNotes };
  }

  /**
   * Cap the simultaneous polyphony (v9 power governor). Anything unusable —
   * no argument, a missing or non-finite maxNotes — means "no cap", so a page
   * that cannot read the governor's sensors never starves the music.
   */
  function setPowerBudget(budget) {
    const wanted = budget && typeof budget === 'object' ? budget.maxNotes : undefined;
    const num = typeof wanted === 'number' ? wanted : Number(wanted);
    maxNotes = wanted !== undefined && wanted !== null && Number.isFinite(num)
      ? Math.max(1, Math.floor(num))
      : Infinity;
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
    randomise,
    setParams,
    getParams,
    getAnalysers,
    getStats,
    setPowerBudget,
    on,
    now,
  };
}

export default createEngine;
