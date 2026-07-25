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

/**
 * Semitone offsets from the root. v21 completes the diatonic set: ionian,
 * mixolydian and phrygian join the three modes that were already here, so the
 * plain major scale, its bVII-flavoured cousin and the bII-flavoured dark one
 * are all reachable. Everything downstream stacks chords in SCALE STEPS, so a
 * new table is all a new mode needs — the chords, the tune and the bass line
 * are diatonic to whatever is in here by construction.
 */
export const SCALES = Object.freeze({
  majorPentatonic: [0, 2, 4, 7, 9],
  minorPentatonic: [0, 3, 5, 7, 10],
  ionian: [0, 2, 4, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
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

/**
 * THE TRACK REGISTRY — one entry per track, and the single source of truth for
 * every fixed six-key table in this file. Track order, the sequenced set, the
 * tuned set, the mix table, the auto-activation ladder and the staged entry are
 * all views over this list rather than six literals that have to be kept in
 * step by hand.
 *
 * The shape is already the one v21's registry API needs (see
 * docs/engine-v2-contract.md, "Track-registry API"): a user track would be an
 * entry with `builtin: false` pushed on by addTrack() and dropped by
 * removeTrack(), with the derived views rebuilt around it. Neither exists yet —
 * this list is a constant, and every value in it is what it was before the
 * tables were folded together.
 *
 * Fields:
 *   id            stable key: what params.tracks, note events and patches use
 *   label         display name
 *   builtin       the six here are undeletable; a user track would be false
 *   colourToken   CSS custom property carrying this track's accent colour
 *   family        'melodic' = pitched and chord-following; 'percussive' = a kit
 *   sequenced     null = sustained, no step grid. A NUMBER = this track's place
 *                 in SEQUENCED_TRACKS, whose order is load-bearing: the Markov
 *                 sequencer pass draws one rng() per track in it. Test it
 *                 against null, never for truthiness — melody sits at 0.
 *   tuned         sounds a pitch, so a chord discipline means something to it
 *   mix           dry level, tone ceiling and DEFAULT effect sends (buildGraph)
 *   autoThreshold the energy at which an 'auto' track switches itself on
 *   stageIndex    the first bar this track may sound in (staged entry, ruling 7)
 */
const TRACK_REGISTRY = Object.freeze([
  {
    id: 'pad', displayOrder: 0, label: 'Pad', builtin: true, colourToken: '--track-pad', family: 'melodic',
    sequenced: null, tuned: true, stageIndex: 0, autoThreshold: 0,
    mix: Object.freeze({ level: 0.36, dry: 0.8, reverb: 0.45, delay: 0.1, tone: 4000 }),
  },
  {
    id: 'bass', displayOrder: 3, label: 'Bass', builtin: true, colourToken: '--track-bass', family: 'melodic',
    sequenced: 1, tuned: true, stageIndex: 1, autoThreshold: 0.1,
    mix: Object.freeze({ level: 0.44, dry: 1.0, reverb: 0.08, delay: 0.0, tone: 12000 }),
  },
  {
    id: 'melody', displayOrder: 2, label: 'Melody', builtin: true, colourToken: '--track-melody', family: 'melodic',
    sequenced: 0, tuned: true, stageIndex: 2, autoThreshold: 0.24,
    mix: Object.freeze({ level: 0.28, dry: 0.75, reverb: 0.5, delay: 0.28, tone: 6000 }),
  },
  {
    id: 'texture', displayOrder: 4, label: 'Texture', builtin: true, colourToken: '--track-texture', family: 'melodic',
    sequenced: null, tuned: true, stageIndex: 3, autoThreshold: 0.36,
    mix: Object.freeze({ level: 0.2, dry: 0.6, reverb: 0.7, delay: 0.35, tone: 12000 }),
  },
  {
    id: 'arp', displayOrder: 1, label: 'Arp', builtin: true, colourToken: '--track-arp', family: 'melodic',
    sequenced: 2, tuned: true, stageIndex: 4, autoThreshold: 0.48,
    mix: Object.freeze({ level: 0.2, dry: 0.7, reverb: 0.45, delay: 0.25, tone: 6500 }),
  },
  {
    id: 'percussion', displayOrder: 5, label: 'Percussion', builtin: true, colourToken: '--track-percussion',
    family: 'percussive',
    sequenced: 3, tuned: false, stageIndex: 5, autoThreshold: 0.6,
    mix: Object.freeze({ level: 0.24, dry: 0.85, reverb: 0.3, delay: 0.12, tone: 9000 }),
  },
].map((track) => Object.freeze(track)));

const TRACK_BY_ID = new Map(TRACK_REGISTRY.map((track) => [track.id, track]));

/** The public view of a track: identity and presentation, no engine internals. */
// Public view order is the DISPLAY order (user-decided: pad, arp, melody,
// bass, texture, percussion) — distinct from registry/engine order, which is
// staging + rng-draw order and must not change (byte-identity guarantee).
const TRACK_VIEWS = Object.freeze([...TRACK_REGISTRY]
  .sort((a, b) => a.displayOrder - b.displayOrder)
  .map((track) => Object.freeze({
  id: track.id,
  label: track.label,
  builtin: track.builtin,
  colourToken: track.colourToken,
  family: track.family,
})));

/**
 * The tracks this engine has, in order — what a lane-building consumer (track
 * rows, editors, visualiser lanes) should read instead of hardcoding six ids.
 * Frozen, and the same list on every call, so nothing can edit the registry
 * through it.
 */
export function getTracks() {
  return TRACK_VIEWS;
}

/**
 * The bar a track may first sound in; -1 for anything not in the registry.
 * `tracks` is the registry to answer from: the floor by default, an engine's
 * own list (floor + its user tracks) when one passes it.
 */
function stageIndexOf(name, tracks = TRACK_REGISTRY) {
  // The floor keeps its prebuilt index; any other list is searched as given.
  const track = tracks === TRACK_REGISTRY
    ? TRACK_BY_ID.get(name)
    : tracks.find((entry) => entry.id === name);
  return track ? track.stageIndex : -1;
}

/** The last bar of the staged entry: by then every track has had its turn. */
const MAX_STAGE_INDEX = Math.max(...TRACK_REGISTRY.map((track) => track.stageIndex));

/** Fixed track order — also the order auto-tracks switch themselves on in. */
export const TRACK_ORDER = Object.freeze(TRACK_REGISTRY.map((track) => track.id));

export const TRACK_STATES = Object.freeze(['off', 'auto', 'on']);

export const STRUCTURES = Object.freeze([
  'auto', 'drone', 'waves', 'build', 'abab', 'journey', 'custom',
]);

export const STRUCTURE_LABELS = Object.freeze(['A', 'B', 'C', 'D']);

export const ARP_PATTERNS = Object.freeze(['up', 'down', 'updown', 'random']);

/** Arp step length in quarter notes. */
export const ARP_RATES = Object.freeze({ '1/4': 1, '1/8': 0.5, '1/16': 0.25, '1/8T': 1 / 3 });

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** The subdivision swing is felt in: the eighth-note pair (v14). */
export const SWING_UNIT = 0.5;

/**
 * Where an onset lands once swing is applied. Each pair of `unit` beats is
 * re-timed so the point where its halves meet moves later — an even 50/50
 * split at swing 0, the classic long-short 75/25 at swing 1 — and everything
 * inside each half is stretched or squeezed with it, so a sixteenth between
 * two swung eighths keeps its place in the figure instead of colliding with
 * them. Pair starts (the downbeats) never move.
 */
export function swungBeat(beat, unit = SWING_UNIT, swing = 0) {
  const amount = clamp(Number(swing) || 0, 0, 1);
  if (amount <= 0 || !(unit > 0) || !Number.isFinite(beat)) return beat;
  const pair = unit * 2;
  const base = Math.floor(beat / pair) * pair;
  const phase = beat - base;
  const split = unit * (1 + amount * 0.5);
  if (phase <= unit) return base + phase * (split / unit);
  return base + split + (phase - unit) * ((pair - split) / (pair - unit));
}
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
 * v14: the melody passed the user's gate and ships on auto. The bass did not —
 * "a rhythm instrument, not a low-pitch random" — so it stays silent until the
 * groove rework below passes the same subjective test.
 */
const DEFAULT_TRACK_STATES = Object.freeze({
  pad: 'auto',
  bass: 'off',
  melody: 'auto',
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
export const SEQUENCED_TRACKS = Object.freeze(TRACK_REGISTRY
  .filter((track) => track.sequenced !== null)
  .sort((a, b) => a.sequenced - b.sequenced)
  .map((track) => track.id));

/**
 * The BUILT-IN percussion lanes. v21 made the kit dynamic — a lane is now an
 * entry in `tracks.percussion.lanes` with its own id — but these three are
 * undeletable, keep their ids forever, and are what every legacy `steps: {low,
 * mid, high}` grid and every stored perKind patch is keyed by.
 */
export const PERCUSSION_LANES = Object.freeze(['low', 'mid', 'high']);

/** The voice kinds a lane may sound through: what the drum voices synthesise. */
export const PERCUSSION_KINDS = Object.freeze(['low', 'mid', 'high']);

/** Lanes per kit, built-ins included. More than this is a UI accident. */
export const MAX_PERCUSSION_LANES = 8;

const PERCUSSION_LANE_LABELS = Object.freeze({ low: 'Low', mid: 'Mid', high: 'High' });

/** Tracks that sound a pitch, so a chord discipline means anything to them. */
export const TUNED_TRACKS = Object.freeze(TRACK_REGISTRY
  .filter((track) => track.tuned)
  .map((track) => track.id));

export const VARY_ASPECTS = Object.freeze(['voice', 'volume', 'pitch', 'timing', 'pan']);

const DEFAULT_TRACK_LEVEL = 0.8;

/**
 * v21: randomness ships as a RANGE — a gentle drift between 0.35 and 0.65
 * rather than a fixed 0.5. The v8 clarification gated this on the page's
 * capability probe accepting a RangeValue reply; it does, so the flip ships.
 * The migration rule is the sanitiser's usual one: only an ABSENT randomness
 * takes the new default, so every stored number stays the number it was.
 */
const DEFAULT_TRACK_RANDOMNESS = Object.freeze({ min: 0.35, max: 0.65 });

/** What an unreadable randomness resolves to — the default range's midpoint. */
const RANDOMNESS_FALLBACK = (DEFAULT_TRACK_RANDOMNESS.min + DEFAULT_TRACK_RANDOMNESS.max) / 2;

/**
 * v14 randomness 0 = HOLD, read on the STORED value rather than the resolved
 * one: a range that reaches zero on some bars would otherwise flicker in and
 * out of hold as its walk wandered. A number holds at 0; a range holds only
 * when its whole span is at zero, which this epsilon makes reachable from a
 * dial that cannot land on exactly 0 twice.
 */
const RANDOMNESS_HOLD_EPSILON = 0.001;

/**
 * v21 driftRate: how fast this track's RangeValue walks move, 0.02–1 scaling
 * the ±0.15/bar step every walk has taken so far. 1 is that step unchanged, so
 * a params object that never mentions the field sounds exactly as it did.
 */
const DEFAULT_TRACK_DRIFT_RATE = 1;
const DRIFT_RATE_RANGE = Object.freeze([0.02, 1]);

/**
 * v21 per-track swing and density. Both ship null, and null MEANS something:
 * swing null follows the global dial (under the same warp law), density null
 * takes whatever complexity asked for. An explicit number — 0 included —
 * overrides for that track alone, so a straight bass under a swung kit, or a
 * busy texture over a sparse everything-else, is one field each.
 */
const TRACK_SWING_RANGE = Object.freeze([0, 1]);
const TRACK_DENSITY_RANGE = Object.freeze([0, 2]);

/**
 * v14 dissonance: how far a tuned track may stray from the chord the group is
 * playing. 0 — the shipped value — is the strict chord discipline every
 * version so far has had; low values let passing and neighbour tones through;
 * high ones borrow from outside the mode altogether.
 */
const DEFAULT_TRACK_DISSONANCE = 0;

/**
 * v12 mono/legato. A monophonic track sounds one note at a time: the note in
 * progress is released the instant the next one starts, which is what turns a
 * generative line from an overlapping wash into something singable — and costs
 * fewer nodes, not more. `glide` 0–1 maps onto GLIDE_RANGE seconds of
 * portamento for the voices that can slur (a sustaining voice retunes; a
 * struck one re-strikes, because its attack IS the note).
 *
 * The two melodic lines ship mono; pad, texture, arp and percussion do not —
 * a chord and a drum kit are polyphonic by nature.
 */
const DEFAULT_TRACK_MONO = Object.freeze({ melody: true, bass: true });
const DEFAULT_TRACK_GLIDE = Object.freeze({ melody: 0.3, bass: 0.15 });
const GLIDE_RANGE = Object.freeze([0.02, 0.12]);

/** The step a legacy `arp.steps` boolean expands to, and every lane's default. */
const DEFAULT_STEP = Object.freeze({ on: true, prob: 1, vmin: 0.5, vmax: 0.9 });

/**
 * v21 per-step gate: how long a sequenced note sounds, as a fraction of the
 * grid step it starts on. It is OPTIONAL and absent by default — a step
 * without one keeps the gap-derived length every version so far has had — and
 * it may exceed 1, which overlaps the note into the step after it (legato on a
 * mono track, a genuine overlap on a polyphonic one).
 */
const STEP_GATE_RANGE = Object.freeze([0.1, 2]);

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

/** One sequencer slot, in beats — the sixteenth the grid above is counted in. */
export const SEQUENCER_STEP_BEATS = 0.25;

/**
 * How long a gated sequencer note sounds, in beats: the span it covers on the
 * grid — a tie merges slots, and the tie wins — scaled by its gate. A gate
 * above 1 therefore runs past the slots it was given, which is the legato case.
 */
function gatedSpan(note, gate, stepBeats) {
  return (note.slots ?? 1) * stepBeats * gate;
}

function defaultStepLane() {
  return Array.from({ length: SEQUENCER_STEP_COUNT }, () => ({ ...DEFAULT_STEP }));
}

function defaultSequencer(track) {
  if (track === 'percussion') {
    return {
      mode: 'auto',
      weights: [1],
      steps: Object.fromEntries(PERCUSSION_LANES.map((lane) => [lane, defaultStepLane()])),
    };
  }
  return { mode: 'auto', weights: [1], steps: defaultStepLane() };
}

/** The kit a fresh params object ships: the three built-ins, in their own order. */
function defaultPercussionLanes() {
  return PERCUSSION_LANES.map((id, order) => ({
    id, label: PERCUSSION_LANE_LABELS[id], kind: id, order,
  }));
}

/**
 * v11 default change: the two SUSTAINED tracks ship a small explicit voice
 * wander instead of following the randomness macro. A pad left on one timbre
 * for an hour is the single loudest complaint about auto, and 0.15 is roughly
 * one voice change every twenty-six bars — noticed over a session, invisible
 * over a phrase. Every other track (and every other aspect) still defaults to
 * null = "follow this track's randomness".
 */
const DEFAULT_VARY_VOICE = Object.freeze({
  pad: 0.15,
  texture: 0.15,
  // v12: the bass explicitly does NOT wander. Following the randomness macro
  // sent it onto the breath voice every few bars, whose pink-noise layer reads
  // as wind following each note — a fault, not a colour, at the bottom of the
  // mix. An explicit 0 beats the macro; a user who wants the wander can ask.
  bass: 0,
});

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
      randomness: { ...DEFAULT_TRACK_RANDOMNESS },
      driftRate: DEFAULT_TRACK_DRIFT_RATE,
      swing: null,
      density: null,
      hold: false,
      mono: DEFAULT_TRACK_MONO[name] === true,
      glide: DEFAULT_TRACK_GLIDE[name] ?? 0,
      vary: defaultVary(name),
    };
    if (TUNED_TRACKS.includes(name)) track.dissonance = DEFAULT_TRACK_DISSONANCE;
    if (name === 'percussion') track.lanes = defaultPercussionLanes();
    if (SEQUENCED_TRACKS.includes(name)) {
      // v14 Sequencer 2.0: a track owns a LIST of sequencers and picks between
      // them at each loop end; `sequencer` is the same object as `sequencers[0]`,
      // so every v6 caller still reads and writes the one it knows about.
      track.sequencers = [defaultSequencer(name)];
      track.sequencer = track.sequencers[0];
    }
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

/**
 * v21 reverbTail bounds, in seconds. 0.5 is a room, 6 is a cathedral; past
 * that the IR costs more than the effect is worth on a phone, which is the
 * same argument the power governor's tier cap makes from the other side.
 */
export const REVERB_TAIL_RANGE = Object.freeze([0.5, 6]);

/**
 * v21 harmonic rhythm: how many bars one chord of the hook holds. 'auto' is
 * the repetition-weighted one-or-two-bar draw every version so far has made;
 * a fixed number pins it, and the loop's PASS length follows from it — eight
 * chords at four bars each is a thirty-two bar pass.
 */
export const HARMONY_RHYTHMS = Object.freeze(['auto', 1, 2, 4, 8]);

/**
 * v21 padBreath: the depth of the pad's bar-phased swell, which is exactly
 * what the contour has always swung by. Shipping the old constant AS the
 * default is what keeps a params object that never mentions it sounding the
 * same; 0 is a flat sustain and 1 is as much dynamic as the voicing allows.
 */
const DEFAULT_PAD_BREATH = 0.28;

export const DEFAULT_PARAMS = Object.freeze({
  speed: 1,
  // v14: straight by default. The dial is global; per-track overrides are a
  // later param, so one value gives the whole rhythm section the same feel.
  swing: 0,
  complexity: 0.5,
  repetition: 0.5,
  root: 'C',
  mode: 'majorPentatonic',
  timeSignature: '4/4',
  bpm: 60,
  volume: 0.8,
  // v21: seconds of reverb tail. 4 is the length every version so far has
  // baked, so a params object that never mentions it sounds unchanged.
  reverbTail: 4,
  padBreath: DEFAULT_PAD_BREATH,
  harmony: Object.freeze({ rhythm: 'auto' }),
  structure: 'auto',
  customStructure: Object.freeze(defaultCustomStructure().map(Object.freeze)),
  arp: Object.freeze({ ...defaultArp(), steps: Object.freeze(new Array(ARP_STEP_COUNT).fill(true)) }),
  tracks: deepFreeze(defaultTracks()),
  // Sparse by design: an absent track/voice/section/field means "voice default".
  patches: Object.freeze({}),
});

const NUMERIC_RANGES = {
  speed: [0.25, 2],
  swing: [0, 1],
  complexity: [0, 1],
  repetition: [0, 1],
  // 20-220: spans commercially-proven extremes (Richter's Sleep ~<50 to
  // hardcore/thrash 200+); the speed multiplier reaches further either side.
  bpm: [20, 220],
  volume: [0, 1],
  reverbTail: REVERB_TAIL_RANGE,
  padBreath: [0, 1],
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
 * A param whose `null` is meaningful — "follow the global/derived value" —
 * rather than a missing one. An explicit null is kept, a usable number is
 * clamped, and anything else falls back to the stored value and then to null,
 * so an unrelated edit can never turn a follower into a fixed number.
 */
function nullableNumber(partial, base, key, range) {
  if (partial && key in partial && partial[key] === null) return null;
  const sent = patchNumber(partial ? partial[key] : undefined, range[0], range[1]);
  if (sent !== undefined) return sent;
  const stored = patchNumber(base ? base[key] : undefined, range[0], range[1]);
  return stored !== undefined ? stored : null;
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

/**
 * Whether a randomness value means HOLD. A NUMBER holds at 0 — the v14 rule,
 * unchanged. A RANGE holds when its top is at zero too (within
 * RANDOMNESS_HOLD_EPSILON), because a range that can reach any audible value at
 * all is asking to drift; only a span pinned at the bottom is asking to stop.
 * Read from the stored value, never the resolved one, so a hold is a state the
 * user set rather than a bar the walk happened to land on.
 */
export function randomnessIsHold(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'object') return value.max <= RANDOMNESS_HOLD_EPSILON;
  return value <= 0;
}

/**
 * One harmonic rhythm value: 'auto', or a bar count from HARMONY_RHYTHMS as a
 * NUMBER whichever form it arrived in — a `<select>` sends its options as
 * strings, and "4 bars" and 4 are the same musical instruction. Anything else
 * returns null, which lets the caller fall back to the stored value.
 */
function harmonyRhythm(value) {
  if (value === 'auto') return 'auto';
  const num = typeof value === 'number' ? value : Number(value);
  if (value === undefined || value === null || value === '' || !Number.isFinite(num)) return null;
  return HARMONY_RHYTHMS.includes(num) ? num : null;
}

function sanitiseHarmony(value, base) {
  const from = base && typeof base === 'object' ? base : DEFAULT_PARAMS.harmony;
  const v = value && typeof value === 'object' ? value : null;
  const sent = v && 'rhythm' in v ? harmonyRhythm(v.rhythm) : null;
  return { rhythm: sent ?? harmonyRhythm(from.rhythm) ?? 'auto' };
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
  const step = {
    on: v && 'on' in v ? Boolean(v.on) : Boolean(from.on),
    // prob is rangeable (v7): a range means the effective probability drifts.
    prob: sanitiseRangeValue(at('prob'), 0, 1)
      ?? sanitiseRangeValue(from.prob, 0, 1)
      ?? DEFAULT_STEP.prob,
    vmin,
    vmax,
  };
  // v14 tie/group are OPTIONAL fields: a step that never carried one does not
  // grow one, so the shipped grid stays exactly the four fields v6 defined.
  const tie = at('tie') !== undefined ? Boolean(at('tie')) : from.tie === true ? true : undefined;
  if (tie) step.tie = true;
  // v21 gate is optional the same way: a step that never carried one is still
  // the four fields v6 defined, and sending `null` (or rubbish) clears one
  // back to the gap-derived length rather than guessing at a number.
  const gate = at('gate') !== undefined
    ? patchNumber(at('gate'), STEP_GATE_RANGE[0], STEP_GATE_RANGE[1])
    : patchNumber(from.gate, STEP_GATE_RANGE[0], STEP_GATE_RANGE[1]);
  if (gate !== undefined) step.gate = gate;
  const group = at('group') !== undefined ? groupId(at('group')) : groupId(from.group);
  if (group !== null) step.group = group;
  return step;
}

/** A probability group's id: a non-negative integer, or null for "ungrouped". */
function groupId(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) && num >= 0 ? Math.round(num) : null;
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

function sanitiseSequencer(track, value, base, laneIds = PERCUSSION_LANES) {
  const from = base && typeof base === 'object' ? base : null;
  const v = value && typeof value === 'object' ? value : null;
  const at = (key) => (v && key in v ? v[key] : undefined);
  const mode = oneOf(at('mode'), SEQUENCER_MODES,
    oneOf(from && from.mode, SEQUENCER_MODES, 'auto'));
  const weights = sanitiseWeights(at('weights'), from ? from.weights : undefined);
  if (track !== 'percussion') {
    return { mode, weights, steps: sanitiseStepLane(at('steps'), from ? from.steps : undefined) };
  }
  const rawLanes = at('steps');
  const baseLanes = from && from.steps && typeof from.steps === 'object' ? from.steps : null;
  // v21: the grid's keys ARE the kit's lane ids, so an added lane arrives with
  // a full grid of its own and a removed one takes its grid with it. The
  // built-in ids never move, which is what keeps every legacy {low,mid,high}
  // grid readable forever.
  const steps = {};
  for (const lane of laneIds) {
    steps[lane] = sanitiseStepLane(
      rawLanes && typeof rawLanes === 'object' ? rawLanes[lane] : undefined,
      baseLanes ? baseLanes[lane] : undefined,
    );
  }
  return { mode, weights, steps };
}

/** A lane id: a non-empty trimmed string, capped so a UI cannot mint an essay. */
function laneId(value) {
  if (typeof value !== 'string') return null;
  return value.trim().slice(0, 32) || null;
}

/**
 * v21 dynamic percussion lanes. The kit is a LIST — the three built-ins plus
 * up to five user lanes — each naming the voice kind it sounds through, so a
 * lane called 'clap' can be struck by the same high voice the built-in 'high'
 * uses without any voice needing to know it exists.
 *
 * The built-ins are undeletable: a list that omits one gets it back with its
 * stored label, because every legacy grid and every stored perKind patch is
 * keyed to them. A built-in's label and position are editable; its kind is
 * not — the lane called 'low' IS the low voice, by definition.
 */
function sanitisePercussionLanes(value, base) {
  const stored = Array.isArray(base) && base.length ? base : defaultPercussionLanes();
  const source = Array.isArray(value) ? value : stored;
  const fallback = new Map(stored.map((lane) => [lane.id, lane]));
  const seen = new Map();
  for (const raw of source) {
    if (!raw || typeof raw !== 'object') continue;
    const id = laneId(raw.id);
    if (!id || seen.has(id)) continue;
    const from = fallback.get(id);
    const builtin = PERCUSSION_LANES.includes(id);
    const label = typeof raw.label === 'string' && raw.label.trim()
      ? raw.label.trim().slice(0, 32)
      : from ? from.label : PERCUSSION_LANE_LABELS[id] ?? id;
    seen.set(id, {
      id,
      label,
      kind: builtin ? id : oneOf(raw.kind, PERCUSSION_KINDS, from ? from.kind : 'mid'),
      order: Math.round(numberIn(raw.order, [0, MAX_PERCUSSION_LANES - 1], seen.size)),
    });
  }
  // A built-in the caller left out comes back BEHIND everything they did list,
  // so a deliberate reorder of the lanes they care about survives intact.
  let next = seen.size ? Math.max(...[...seen.values()].map((lane) => lane.order)) + 1 : 0;
  for (const id of PERCUSSION_LANES) {
    if (seen.has(id)) continue;
    const from = fallback.get(id);
    seen.set(id, {
      ...(from ?? { id, label: PERCUSSION_LANE_LABELS[id], kind: id }),
      order: next,
    });
    next += 1;
  }
  const lanes = [];
  let user = 0;
  for (const lane of [...seen.values()].sort((a, b) => a.order - b.order)) {
    // The cap counts the built-ins, which never lose their place: only user
    // lanes past the eighth are dropped.
    if (!PERCUSSION_LANES.includes(lane.id)) {
      if (PERCUSSION_LANES.length + user >= MAX_PERCUSSION_LANES) continue;
      user += 1;
    }
    lanes.push(lane);
  }
  return lanes.map((lane, order) => ({ ...lane, order }));
}

/**
 * One sequencer's transition weights: how likely each sequencer in the track's
 * list is to play next when this one reaches the end of its loop. Non-negative
 * numbers only; an all-zero or unusable set means "stay on this one", which is
 * the single-sequencer behaviour every earlier version had.
 */
function sanitiseWeights(value, base) {
  const source = Array.isArray(value) ? value : Array.isArray(base) ? base : [1];
  const weights = source.map((weight) => numberIn(weight, [0, 100], 0));
  return weights.length ? weights : [1];
}

/**
 * The track's sequencer LIST (v14). `sequencers` is authoritative; the singular
 * `sequencer` is accepted as input for slot 0 and emitted as an alias of it, so
 * a v6 caller that only knows about one sequencer keeps working unchanged.
 * Every sequencer's weight vector is padded/truncated to the list length, which
 * is what keeps the Markov pick total over the sequencers that exist.
 */
function sanitiseSequencerList(track, partial, base, laneIds = PERCUSSION_LANES) {
  const baseList = Array.isArray(base) ? base : [];
  const sent = partial && Array.isArray(partial.sequencers) ? partial.sequencers : null;
  const list = [];
  if (sent) {
    for (let i = 0; i < sent.length && i < MAX_SEQUENCERS; i++) {
      list.push(sanitiseSequencer(track, sent[i], baseList[i], laneIds));
    }
  } else {
    for (const stored of baseList.slice(0, MAX_SEQUENCERS)) {
      list.push(sanitiseSequencer(track, undefined, stored, laneIds));
    }
  }
  if (!list.length) list.push(sanitiseSequencer(track, undefined, baseList[0], laneIds));
  // The singular field writes into slot 0 unless the caller sent the whole list.
  const single = partial && 'sequencer' in partial ? partial.sequencer : undefined;
  if (!sent && single !== undefined) {
    list[0] = sanitiseSequencer(track, single, baseList[0], laneIds);
  }
  for (const sequencer of list) {
    // A sequencer the caller added without weights is reachable: an unmentioned
    // slot weighs 1, so "add a copy" is audible without a second edit.
    sequencer.weights = Array.from({ length: list.length },
      (unused, i) => (i < sequencer.weights.length ? sequencer.weights[i] : 1));
  }
  return list;
}

/** More than this many alternates per track is a UI accident, not a sequence. */
const MAX_SEQUENCERS = 8;

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

function sanitiseTracks(value, base, order = TRACK_ORDER) {
  const from = base && typeof base === 'object' ? base : DEFAULT_PARAMS.tracks;
  const v = value && typeof value === 'object' ? value : null;
  const tracks = {};
  for (const name of order) {
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
      // Migration: the v21 default range only ever reaches a track that has no
      // randomness of its own — an inherited number is re-clamped, not replaced.
      randomness: sanitiseRangeValue(partial && partial.randomness, 0, 1)
        ?? sanitiseRangeValue(baseTrack.randomness, 0, 1)
        ?? { ...DEFAULT_TRACK_RANDOMNESS },
      driftRate: numberIn(partial && partial.driftRate, DRIFT_RATE_RANGE,
        numberIn(baseTrack.driftRate, DRIFT_RATE_RANGE, DEFAULT_TRACK_DRIFT_RATE)),
      swing: nullableNumber(partial, baseTrack, 'swing', TRACK_SWING_RANGE),
      density: nullableNumber(partial, baseTrack, 'density', TRACK_DENSITY_RANGE),
      hold: partial && 'hold' in partial ? Boolean(partial.hold) : Boolean(baseTrack.hold),
      mono: partial && 'mono' in partial ? Boolean(partial.mono)
        : 'mono' in baseTrack ? Boolean(baseTrack.mono) : DEFAULT_TRACK_MONO[name] === true,
      glide: numberIn(partial && partial.glide, [0, 1],
        numberIn(baseTrack.glide, [0, 1], DEFAULT_TRACK_GLIDE[name] ?? 0)),
      vary: sanitiseVary(partial && partial.vary, baseTrack.vary),
    };
    if (TUNED_TRACKS.includes(name)) {
      track.dissonance = sanitiseRangeValue(partial && partial.dissonance, 0, 1)
        ?? sanitiseRangeValue(baseTrack.dissonance, 0, 1)
        ?? DEFAULT_TRACK_DISSONANCE;
    }
    if (name === 'percussion') {
      track.lanes = sanitisePercussionLanes(partial && partial.lanes, baseTrack.lanes);
    }
    if (SEQUENCED_TRACKS.includes(name)) {
      const storedList = Array.isArray(baseTrack.sequencers) ? baseTrack.sequencers
        : baseTrack.sequencer ? [baseTrack.sequencer] : undefined;
      track.sequencers = sanitiseSequencerList(name, partial, storedList,
        track.lanes ? track.lanes.map((lane) => lane.id) : undefined);
      track.sequencer = track.sequencers[0];
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
  const sentTrack = partial.tracks && typeof partial.tracks === 'object'
    && partial.tracks.arp && typeof partial.tracks.arp === 'object' ? partial.tracks.arp : null;
  const sentLane = Boolean(sentTrack && ((sentTrack.sequencer
    && typeof sentTrack.sequencer === 'object' && 'steps' in sentTrack.sequencer)
    || Array.isArray(sentTrack.sequencers)));
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
  const sentTrack = partial.tracks && typeof partial.tracks === 'object'
    && partial.tracks.percussion && typeof partial.tracks.percussion === 'object'
    ? partial.tracks.percussion : null;
  if (sentTrack && (sentTrack.sequencer || Array.isArray(sentTrack.sequencers))) return;
  tracks.percussion.sequencers[0] = sanitiseSequencer(
    'percussion', legacy, tracks.percussion.sequencers[0],
    tracks.percussion.lanes.map((lane) => lane.id),
  );
  tracks.percussion.sequencer = tracks.percussion.sequencers[0];
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
 *
 * The v7 rangeable fields take `number | { min, max }` — the range dials in the
 * voice editor write the object form, and the field's OWN bounds clamp both
 * ends. NOT rangeable, per v7: the shape morph dials, octave and filter type,
 * which are discrete or enum-like and take a single value engine-side —
 * percussion's v18 `pitch` is continuous, so unlike octave it IS rangeable.
 * `perKind` runs through the very same field table, so a kit override is
 * rangeable exactly where the common patch is.
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
    mix: (v) => sanitiseRangeValue(v, 0, 1),
    // Bipolar since v12: the dial detunes flat as readily as sharp, and the
    // octave switch reaches two either way. Defaults are unchanged, so every
    // stored patch keeps sounding exactly as it did.
    detune: (v) => sanitiseRangeValue(v, -50, 50),
    octave: (v) => {
      const num = patchNumber(v, -2, 2);
      return num === undefined ? undefined : Math.round(num);
    },
    // v18: the percussion kits tune in semitones instead of by the octave
    // switch — the same two octaves either way, but continuous and rangeable,
    // and `noise` is the level of their noise component (1 is the kit as it
    // was built). Both ride the same field table, so a perKind override takes
    // them exactly where the common patch does; the voices ignore either field
    // on a track that plays notes.
    pitch: (v) => sanitiseRangeValue(v, -24, 24),
    noise: (v) => sanitiseRangeValue(v, 0, 1),
    // v20 shape modifier: a wavefolder on the oscillator sources. 0 is bypass
    // — the voices add no node for it — and 1 folds the loudest peaks back on
    // themselves several times over. Rangeable like every other continuous
    // field, and resolved to a number per bar before any voice sees it.
    fold: (v) => sanitiseRangeValue(v, 0, 1),
    // v19 noise sculpting: the dials that turn the two texture noise voices
    // into one modular instrument. Every one is continuous and therefore
    // rangeable, and every one is resolved to a number before it reaches a
    // voice, exactly like the fields above. The table stays track-agnostic —
    // which voices HONOUR them is the voice library's `controls` to declare,
    // not the sanitiser's to police.
    tilt: (v) => sanitiseRangeValue(v, -1, 1),
    bandCentre: (v) => sanitiseRangeValue(v, 60, 8000),
    bandWidth: (v) => sanitiseRangeValue(v, 0.1, 4),
    sweepRate: (v) => sanitiseRangeValue(v, 0, 0.5),
    sweepDepth: (v) => sanitiseRangeValue(v, 0, 1),
    gust: (v) => sanitiseRangeValue(v, 0, 1),
    gustRate: (v) => sanitiseRangeValue(v, 0.02, 0.5),
    burst: (v) => sanitiseRangeValue(v, 0, 1),
    burstSharp: (v) => sanitiseRangeValue(v, 0, 1),
    swell: (v) => sanitiseRangeValue(v, 0, 1),
    // v19 call synthesis: the same deal for the pitched chirp primitive that
    // melody and texture both offer.
    glide: (v) => sanitiseRangeValue(v, -24, 24),
    glideCurve: (v) => sanitiseRangeValue(v, 0, 1),
    formant1: (v) => sanitiseRangeValue(v, 60, 8000),
    formant2: (v) => sanitiseRangeValue(v, 60, 8000),
    cadence: (v) => sanitiseRangeValue(v, 0.5, 8),
    irregular: (v) => sanitiseRangeValue(v, 0, 1),
  }),
  filter: Object.freeze({
    type: (v) => oneOf(v, PATCH_FILTER_TYPES, undefined),
    cutoff: (v) => sanitiseRangeValue(v, 40, 12000),
    q: (v) => sanitiseRangeValue(v, 0.1, 20),
    envAmount: (v) => sanitiseRangeValue(v, 0, 1),
  }),
  adsr: Object.freeze({
    attack: (v) => sanitiseRangeValue(v, 0.001, 8),
    decay: (v) => sanitiseRangeValue(v, 0.001, 8),
    sustain: (v) => sanitiseRangeValue(v, 0, 1),
    release: (v) => sanitiseRangeValue(v, 0.01, 12),
  }),
  sends: Object.freeze({
    reverb: (v) => sanitiseRangeValue(v, 0, 1),
    delay: (v) => sanitiseRangeValue(v, 0, 1),
  }),
});

/** The four Patch sections, clamped and stripped of unknown keys. */
function sanitisePatchSections(value) {
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
  return out;
}

/**
 * v14 kit editor, v21 lane keys: `perKind = { [laneId]: Patch }`, each a sparse
 * Patch that overrides the common one for percussion notes struck by that lane.
 * Sparse both ways — an absent lane, and an absent field inside one, both mean
 * "follow the common patch" — and never nested, so a perKind inside a perKind
 * is dropped like any other unknown key. Keys that name no lane of the current
 * kit are dropped too, which is what stops a removed lane's patch lingering.
 */
function sanitisePerKind(value, laneIds = PERCUSSION_LANES) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const kind of laneIds) {
    const raw = value[kind];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const patch = sanitisePatchSections(raw);
    if (Object.keys(patch).length) out[kind] = patch;
  }
  return Object.keys(out).length ? out : null;
}

/** One patch, clamped and stripped of unknown keys. null when nothing survives. */
function sanitisePatch(value, laneIds = PERCUSSION_LANES) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = sanitisePatchSections(value);
  const perKind = sanitisePerKind(value.perKind, laneIds);
  if (perKind) out.perKind = perKind;
  return Object.keys(out).length ? out : null;
}

/** Field-level merge of two already-sanitised section maps. */
function mergeSections(from, patch) {
  const out = {};
  for (const section of Object.keys(PATCH_SCHEMA)) {
    const merged = { ...(from?.[section] ?? {}), ...(patch?.[section] ?? {}) };
    if (Object.keys(merged).length) out[section] = merged;
  }
  return out;
}

/** Field-level merge of `incoming` over `base`; an unusable patch keeps `base`. */
function mergePatch(base, incoming, laneIds = PERCUSSION_LANES) {
  const from = sanitisePatch(base, laneIds);
  if (incoming === undefined) return from;
  const patch = sanitisePatch(incoming, laneIds);
  if (!patch) return from;
  if (!from) return patch;
  const out = mergeSections(from, patch);
  // Overrides merge per kind, so editing one dial of one instrument leaves the
  // rest of that instrument — and every other instrument — where it was.
  const kinds = new Set([
    ...Object.keys(from.perKind ?? {}),
    ...Object.keys(patch.perKind ?? {}),
  ]);
  if (kinds.size) {
    out.perKind = {};
    for (const kind of kinds) {
      out.perKind[kind] = mergeSections(from.perKind?.[kind], patch.perKind?.[kind]);
    }
  }
  return out;
}

/**
 * `{ [track]: { [voiceId]: Patch } }`, merged deeply over the base. Unknown
 * track names are dropped; unknown voice ids are kept, because the engine
 * cannot know which ids the (lazily loaded) voice library offers.
 */
function sanitisePatches(value, base, laneIds = PERCUSSION_LANES, order = TRACK_ORDER) {
  const from = base && typeof base === 'object' && !Array.isArray(base) ? base : {};
  const v = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  const out = {};
  for (const track of order) {
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
        laneIds,
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
 *
 * `order` is the track list the per-track sections are built from — the floor's
 * six by default, an engine's own list when it passes one.
 */
export function sanitiseParams(partial, base = DEFAULT_PARAMS, order = TRACK_ORDER) {
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
  out.harmony = sanitiseHarmony(at('harmony'), from.harmony);
  out.structure = oneOf(at('structure'), STRUCTURES, oneOf(from.structure, STRUCTURES, 'auto'));
  out.customStructure = sanitiseCustomStructure(at('customStructure'), from.customStructure);
  out.arp = sanitiseArp(at('arp'), from.arp);
  out.tracks = sanitiseTracks(at('tracks'), from.tracks, order);
  bridgeLegacyArpSteps(p, out.tracks, out.arp);
  bridgeLegacyPercussion(p, out.tracks);
  // Lanes are settled before the patches that key off them, so adding a lane
  // and its kit override in ONE call keeps the override.
  out.patches = sanitisePatches(at('patches'), from.patches,
    out.tracks.percussion.lanes.map((lane) => lane.id), order);
  return out;
}

/** A patch nobody can write through to the engine's own copy. */
function copyPatch(patch) {
  const out = {};
  for (const [section, fields] of Object.entries(patch)) {
    out[section] = section === 'perKind'
      ? Object.fromEntries(Object.entries(fields).map(([kind, sections]) => [kind, copyPatch(sections)]))
      // A rangeable field may hold a `{ min, max }` object, which a spread of
      // the section alone would hand out by reference.
      : Object.fromEntries(
        Object.entries(fields).map(([field, value]) => [field, copyRangeValue(value)]),
      );
  }
  return out;
}

function copyPatches(patches) {
  const out = {};
  for (const [track, bank] of Object.entries(patches)) {
    const copy = {};
    for (const [id, patch] of Object.entries(bank)) copy[id] = copyPatch(patch);
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
      Object.keys(sequencer.steps).map((lane) => [lane, copyStepLane(sequencer.steps[lane])]),
    );
  return { mode: sequencer.mode, weights: sequencer.weights.slice(), steps };
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
  if ('dissonance' in track) out.dissonance = copyRangeValue(track.dissonance);
  if (track.lanes) out.lanes = track.lanes.map((lane) => ({ ...lane }));
  if (track.sequencers) {
    out.sequencers = track.sequencers.map(copySequencer);
    // The alias survives the copy: the caller edits one object, not two.
    out.sequencer = out.sequencers[0];
  }
  return out;
}

/** Deep copy of a sanitised params object — what getParams() hands out. */
function copyParams(params, order = TRACK_ORDER) {
  return {
    ...params,
    harmony: { ...params.harmony },
    customStructure: params.customStructure.map((block) => ({ ...block })),
    arp: { ...params.arp, steps: params.arp.steps.slice() },
    tracks: Object.fromEntries(order.map((name) => [name, copyTrack(params.tracks[name])])),
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

/**
 * The memory both the hook and the melody's motif are built on. It keeps a
 * handful of variants, ranked by a deliberately crude salience — how long a
 * shape survived untouched, how hot the section it played under — and draws
 * one back on request. De-duplicating on a caller-supplied key is what stops
 * one shape filling every slot; a `key` is a variant's identity, so storing
 * the same shape twice only ever raises its salience.
 *
 * v12 generalises this out of the v11 hook rather than giving the motif a
 * second, parallel implementation: the ear-worm mechanism is the same
 * mechanism whether what returns is a chord loop or a tune.
 */
export function createVariantBank({ size = 6, clone = (variant) => variant } = {}) {
  let entries = [];
  return {
    get entries() { return entries; },
    get length() { return entries.length; },
    clear() { entries = []; },

    /** Keep `variant` under `key`, dropping the least salient once full. */
    store(key, variant, salience, extra = null) {
      const known = entries.find((entry) => entry.key === key);
      if (known) {
        known.salience = Math.max(known.salience, salience);
        if (extra) Object.assign(known, extra);
        return known;
      }
      const entry = { ...(extra ?? {}), key, variant: clone(variant), salience };
      entries.push(entry);
      if (entries.length > size) {
        let worst = 0;
        for (let i = 1; i < entries.length; i++) {
          if (entries[i].salience < entries[worst].salience) worst = i;
        }
        entries.splice(worst, 1);
      }
      return entry;
    },

    find(predicate) {
      return entries.find(predicate) ?? null;
    },

    /**
     * A weighted draw over everything except what is playing now — recalling
     * the shape already sounding is not a return, so an empty field means no
     * recall this time and the caller carries on.
     */
    recall(currentKey, weight, rng = Math.random) {
      const candidates = entries.filter((entry) => entry.key !== currentKey);
      if (!candidates.length) return null;
      const weights = candidates.map((entry) => Math.max(0.05, weight(entry)));
      const total = weights.reduce((sum, value) => sum + value, 0);
      let r = rng() * total;
      let chosen = candidates[candidates.length - 1];
      for (let i = 0; i < candidates.length; i++) {
        r -= weights[i];
        if (r <= 0) { chosen = candidates[i]; break; }
      }
      return chosen;
    },
  };
}

export const HOOK_MIN_CHORDS = 4;
export const HOOK_MAX_CHORDS = 8;

const HOOK_BANK_SIZE = 6;         // ear-worms kept; the least salient is dropped
const HOOK_RECALL_MIN = 4;        // loop passes between recalls, at repetition 1
const HOOK_RECALL_SPAN = 4;       // extra passes the cycle can run to at repetition 0
const HOOK_SNAPSHOT_EVERY = 3;    // passes between bank snapshots
const HOOK_STABLE_TO_BANK = 2;    // passes unmutated that make a variant worth keeping
const HOOK_HOT_INTENSITY = 0.7;   // section intensity that makes a pass worth keeping

const MOTIF_BANK_SIZE = 6;        // cells kept, ranked the same way hooks are
const PHRASE_BARS = 4;            // bars per melodic phrase: statement, two developments, cadence
const MELODY_BAND = 14;           // semitones either side of the octave-4 root the tune may use

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
 * An honest name for a chord, from the semitones it actually contains (v14,
 * for the visualiser's bar labels). `rootPc` is the chord's own root pitch
 * class, `semitones` the intervals above it — so the name describes what the
 * ear meets, not what the stack was called when it was built. That matters in
 * the pentatonics and whole tone, where a diatonic "third" is nothing of the
 * kind: stacking scale steps in majorPentatonic gives a sixth chord, and this
 * says so rather than calling it a triad.
 *
 * Only the qualities the engine can actually produce are named; anything else
 * degrades to the root name plus the intervals it could not place, which is
 * still true.
 */
export function nameChord(rootPc, semitones) {
  const root = NOTE_NAMES[((Math.round(rootPc) % 12) + 12) % 12];
  const set = new Set((Array.isArray(semitones) ? semitones : [])
    .map((s) => ((Math.round(s) % 12) + 12) % 12));
  set.delete(0);
  if (!set.size) return `${root}5`;

  const third = set.has(3) ? 'min' : set.has(4) ? 'maj' : null;
  const fifth = set.has(7) ? 'perfect' : set.has(6) ? 'dim' : set.has(8) ? 'aug' : null;
  const seventh = set.has(10) ? 'min' : set.has(11) ? 'maj' : null;
  const sixth = set.has(9) && !seventh;
  const ninth = set.has(2);

  let quality = '';
  // A diminished triad carrying a MINOR seventh is half-diminished, and the
  // seventh degree of every seven-note mode makes one: calling it "dim7" would
  // promise a diminished seventh that is not in the chord, so it reads m7b5.
  if (third === 'min') quality = fifth === 'dim' && seventh !== 'min' ? 'dim' : 'm';
  else if (third === 'maj') quality = fifth === 'aug' ? 'aug' : '';
  else if (set.has(5)) quality = 'sus4';
  else if (ninth) quality = 'sus2';
  else if (set.has(9)) quality = 'm';           // a bare root+sixth reads as its relative minor 7 shape
  else quality = '5';

  let extension = '';
  if (seventh === 'maj') extension = quality === 'm' ? 'maj7' : 'maj7';
  else if (seventh === 'min') extension = '7';
  else if (sixth && quality !== 'sus2' && quality !== 'sus4') extension = '6';
  if (ninth && seventh) extension = seventh === 'maj' ? 'maj9' : '9';
  else if (ninth && !extension && quality !== 'sus2') extension = 'add9';

  // A named fifth that the quality has not already accounted for.
  const tail = fifth === 'dim' && quality !== 'dim' ? 'b5' : fifth === 'aug' && third !== 'maj' ? '#5' : '';
  // A suspension takes its extension in front of it, the way it is written: D9sus4.
  return quality.startsWith('sus')
    ? `${root}${extension}${quality}${tail}`
    : `${root}${quality}${extension}${tail}`;
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

// -- the motif (v12) --------------------------------------------------------
//
// A tune is not a stream of well-chosen notes, it is one small idea heard
// again. The motif is that idea: a 3–5 note cell with a fixed rhythm and a
// fixed contour, stated at the top of every phrase and DEVELOPED rather than
// re-rolled — repeated, moved onto another tone of the chord under it, pushed
// off the beat, turned upside down, run backwards. The rhythm is what survives
// every one of those, which is what makes the cell recognisable after it has
// been transposed and inverted.
//
// Degrees are scale steps RELATIVE to the chord root, exactly as phrases have
// always been, so a cell stays consonant wherever the hook takes it.

export const MOTIF_MIN_NOTES = 3;
export const MOTIF_MAX_NOTES = 5;

/** The developments a motif can undergo. `repeat` is the statement itself. */
export const MOTIF_OPS = Object.freeze([
  'repeat', 'transpose', 'displace', 'invert', 'retrograde',
]);

/** Onset spacings a cell is built from, opened up by complexity. */
const MOTIF_GAPS = Object.freeze([
  [1, 1, 1.5, 2],        // calm: crotchets and longer
  [0.5, 1, 1, 1.5],      // middling: a quaver pair inside a walking line
  [0.5, 0.5, 0.75, 1],   // busy: quavers, with the occasional dotted lean
]);

/**
 * Build a cell. Contour comes from one of four shapes so the line has a
 * direction rather than a wander; intervals are scale STEPS, and at most one
 * of them is a leap — stepwise motion is what makes a tune hummable, and a
 * single leap is what stops it being a scale.
 */
export function buildMotif({
  beatsPerBar: barBeats = 4,
  complexity = 0.5,
  scaleLength = 5,
  rng = Math.random,
} = {}) {
  const c = clamp(complexity, 0, 1);
  const wanted = clamp(
    Math.round(MOTIF_MIN_NOTES + c * (MOTIF_MAX_NOTES - MOTIF_MIN_NOTES)),
    MOTIF_MIN_NOTES, MOTIF_MAX_NOTES,
  );
  const gaps = MOTIF_GAPS[c < 0.35 ? 0 : c < 0.7 ? 1 : 2];

  const beats = [0];
  let at = 0;
  for (let i = 1; i < wanted; i++) {
    at += pick(gaps, rng);
    if (at > barBeats - 0.25 + 1e-9) break;
    beats.push(at);
  }
  const count = beats.length;
  const lengths = beats.map((beat, i) => (i + 1 < count
    ? beats[i + 1] - beat
    : clamp(barBeats - beat, 0.5, 2)));

  const shape = pick(['rise', 'fall', 'arch', 'dip'], rng);
  const turn = Math.max(1, Math.floor(count / 2));
  // One leap per cell at most, and only sometimes: a cell of pure steps is a
  // perfectly good tune, a cell of pure leaps is a fanfare nobody can sing.
  const leapAt = rng() < 0.7 ? 1 + (Math.floor(rng() * Math.max(1, count - 1)) % Math.max(1, count - 1)) : -1;
  const steps = [0];
  for (let i = 1; i < count; i++) {
    const up = shape === 'rise' ? 1
      : shape === 'fall' ? -1
        : shape === 'arch' ? (i <= turn ? 1 : -1)
          : (i <= turn ? -1 : 1);
    const size = i === leapAt ? (rng() < 0.35 ? 3 : 2) : 1;
    steps.push(clamp(steps[i - 1] + up * size, -scaleLength, scaleLength * 2));
  }

  return { steps, beats, lengths, shape };
}

export function cloneMotif(motif) {
  return {
    steps: [...motif.steps],
    beats: [...motif.beats],
    lengths: [...motif.lengths],
    shape: motif.shape,
  };
}

/** A cell's identity — pitch shape and rhythm together, which is what an ear keeps. */
export function motifKey(motif) {
  return `${motif.steps.join(',')}|${motif.beats.join(',')}`;
}

/** The chord tone nearest a scale degree, in any octave. Where a phrase lands. */
export function nearestChordTone(degree, scaleLength = 5) {
  let best = 0;
  let distance = Infinity;
  for (let octave = -2; octave <= 2; octave++) {
    for (const tone of [0, 2, 4]) {
      const candidate = tone + octave * scaleLength;
      const away = Math.abs(candidate - degree);
      // A tie resolves towards the home octave: a cadence has two equally near
      // chord tones about as often as not, and the one that keeps the line
      // where it has been singing beats the one an octave away.
      if (away < distance || (away === distance && Math.abs(candidate) < Math.abs(best))) {
        distance = away;
        best = candidate;
      }
    }
  }
  return best;
}

/**
 * One development of a cell. Every branch keeps the rhythm except `displace`,
 * which keeps everything BUT the rhythm's position — between them the ear can
 * always find the cell again.
 *
 * - repeat      the statement, untouched
 * - transpose   the whole cell onto another tone of the chord under it
 * - displace    the same cell, pushed later in the bar
 * - invert      the contour mirrored about its first note
 * - retrograde  the pitches run backwards over the same rhythm
 */
export function developMotif(motif, op, {
  beatsPerBar: barBeats = 4, scaleLength = 5, rng = Math.random,
} = {}) {
  const cell = cloneMotif(motif);
  if (op === 'transpose') {
    const shift = pick([2, 4, -scaleLength, scaleLength, 2, 4], rng);
    cell.steps = cell.steps.map((step) => step + shift);
    return cell;
  }
  if (op === 'displace') {
    const by = pick([0.5, 1, 0.5], rng);
    const beats = [];
    const steps = [];
    const lengths = [];
    for (let i = 0; i < cell.beats.length; i++) {
      const beat = cell.beats[i] + by;
      if (beat > barBeats - 0.25 + 1e-9) break;
      beats.push(beat);
      steps.push(cell.steps[i]);
      lengths.push(Math.min(cell.lengths[i], barBeats - beat));
    }
    // A displacement that pushed everything off the end is no development at
    // all; the statement is better than silence.
    if (beats.length < 2) return cell;
    cell.beats = beats;
    cell.steps = steps;
    cell.lengths = lengths;
    return cell;
  }
  if (op === 'invert') {
    const pivot = cell.steps[0];
    cell.steps = cell.steps.map((step) => 2 * pivot - step);
    return cell;
  }
  if (op === 'retrograde') {
    cell.steps = [...cell.steps].reverse();
    return cell;
  }
  return cell;
}

// -- the bass groove (v14, craft pass v24) -----------------------------------
//
// The v12 bass drew a bar of rhythm from a density and repeated it. The user's
// verdict on that was blunt: "it's a rhythm instrument, not a low-pitch
// random". So the bass now has a GROOVE — an anchor pulse that never moves,
// one or two syncopation cells that give the section its feel, and a note
// length per step (a bassist's staccato/held mix is half of what makes a line
// recognisable). The groove is stated once per section and DEVELOPED bar to
// bar the way the melody's motif is, rather than re-rolled.
//
// v24 (the second failed verdict, "still definitely the weakest link") is a
// FEEL pass on top of that. The notes were already right; what was missing was
// everything a bassist does between the notes:
//
//  - POCKET.  Timing was the generic ±25 ms per-note humanisation, drawn
//    independently for every note, which reads as drunk rather than deep. A
//    bassist picks ONE relationship to the beat and keeps it all night, so the
//    groove now carries a single lay-back constant every note of the section
//    shares.
//  - ARTICULATION.  The gate table was per ROLE (anchor/pulse/offbeat), so
//    every pulse in a bar was the same length; on a mono track that makes the
//    whole spine either slur or re-strike as one. Grooves now carry an
//    articulation cycle, so which notes ring into the next and which stop short
//    is part of the line's identity.
//  - CONTOUR.  The ghost velocity was 0.42 against a 0.74 pulse — five decibels,
//    which is a slightly quiet note, not a ghost. Ghosts are 0.25 now and the
//    anchor accent is worth hearing.
//  - FILLS.  There were none. A line that never turns around is a loop.
//  - INTERNAL PULSE.  With no kit playing, every non-anchor pulse was an
//    independent coin flip. The bass now supplies its own anchor grid on the
//    same terms it locks to a kick, so a drummerless line still has a spine.
//
// The harmonic contract is untouched: every felt pulse takes the root; the
// fifth and the octave only ever appear between the pulses.

/** Note lengths a groove is built from: the gate a step's span is played at. */
const BASS_FEELS = Object.freeze({
  // Short, springy notes with air between them — the most obviously "played" feel.
  staccato: { anchor: 0.55, pulse: 0.45, offbeat: 0.35 },
  // Long notes that lean into each other; the anchor carries the bar.
  held: { anchor: 0.98, pulse: 0.9, offbeat: 0.6 },
  // A held anchor answered by short offbeats — the classic bass-line shape.
  mixed: { anchor: 0.95, pulse: 0.5, offbeat: 0.35 },
});

export const BASS_FEEL_NAMES = Object.freeze(Object.keys(BASS_FEELS));

/**
 * How a groove spreads its note lengths ACROSS the bar: a multiplier cycle
 * applied to the pulse spine, step by step, on top of the feel's own gate.
 *
 * This is the half of articulation the v14 table could not express. A gate is
 * only ever a fraction of the span to the next note, and on the shipped mono
 * bass a note that reaches the next onset is slurred into it while anything
 * shorter is re-struck and cut at that onset — so a bar whose steps all carry
 * one gate has exactly one articulation, however that gate is tuned. Cycling
 * the multiplier is what makes "long, short, long, short" a thing the line can
 * say, and saying the same one every bar is what makes it the line's identity.
 */
const BASS_ARTICULATIONS = Object.freeze({
  even: [1],                        // the pump: every pulse the same length
  longShort: [1.8, 0.5],            // the dotted lean — ring, clip, ring, clip
  shortLong: [0.5, 1.8],            // the same lean the other way up
  holdOne: [2, 0.55, 0.75, 0.55],   // hold the anchor, clip everything under it
});

export const BASS_ARTICULATION_NAMES = Object.freeze(Object.keys(BASS_ARTICULATIONS));

/**
 * What each role of note is played at. The gaps between these are the contour:
 * an accent nobody can hear is not an accent, and a ghost note is a bassist's
 * quietest gesture — felt through the fingers, barely present in the mix.
 */
const BASS_VELOCITIES = Object.freeze({
  accent: 0.92,
  pulse: 0.68,
  offbeat: 0.58,
  ghost: 0.25,
  fill: 0.74,
});

/** Where a ghost's velocity has to sit for it to read as one, after shaping. */
export const BASS_GHOST_CEILING = 0.34;

/**
 * The bass's lay-back, in seconds behind the grid at vary.timing 1. A rhythm
 * section is heard as one instrument when the bass sits in a CONSISTENT
 * relationship to the kick — a fraction behind it, all night — so this is a
 * per-groove constant rather than a per-note draw, and it never runs early.
 */
const BASS_POCKET = 0.022;

/** The shortest note the bass will play, and the shortest bass line worth one. */
const BASS_MIN_NOTE = 0.06;

/**
 * The register the line lives in: E1 to G3. An octave pop off a high chord root
 * would otherwise land in the tune's own register, where it stops sounding like
 * a bass at all.
 */
const BASS_RANGE = Object.freeze({ low: 28, high: 55 });

/** The turnaround: which bar of a section may carry a fill, and how often. */
const BASS_FILL_CYCLE = 8;
const BASS_FILL_CHANCE = 0.7;

/**
 * One groove's pocket: the seconds every note of the line sits behind its grid
 * position. `amount` is the track's timing vary — at 0 the bass is machine-tight
 * (the user asked for no humanisation and gets none), and everywhere above it
 * the line leans back by a groove-constant few milliseconds.
 */
export function bassPocketSeconds(amount = 0, rng = Math.random) {
  const depth = clamp(Number(amount) || 0, 0, 1);
  return clamp(BASS_POCKET * depth * (0.6 + rng() * 0.8), 0, BASS_POCKET);
}

/**
 * Offbeat placements a groove syncopates on, as a fraction of the pulse that
 * carries them. Every cell is a real rhythmic figure rather than a random
 * offbeat: the "and" of the beat, the push into the next one, the two-note
 * pickup.
 */
const BASS_CELLS = Object.freeze([
  [0.5],            // the and
  [0.75],           // the push, late into the next pulse
  [0.5, 0.75],      // a two-note pickup
  [0.25, 0.75],     // a syncopated pair straddling the beat
]);

/**
 * The runs a fill is drawn from: beats BEFORE the barline, paired with the tone
 * each takes. Every placement is off the pulse, so the root discipline survives
 * a fill intact, and the last note of the run is the one scheduleBass re-pitches
 * towards the chord ahead — which is what turns a run into an approach.
 */
const BASS_FILLS = Object.freeze([
  { before: [0.5, 0.25], tones: ['fifth', 'octave'] },
  { before: [0.75, 0.5, 0.25], tones: ['root', 'fifth', 'octave'] },
  { before: [0.75, 0.5, 0.25], tones: ['octave', 'fifth', 'octave'] },
  { before: [0.5, 0.25], tones: ['octave', 'fifth'] },
]);

export const BASS_GROOVE_OPS = Object.freeze([
  'state', 'ghost', 'push', 'simplify', 'double', 'fill',
]);

/**
 * A groove for the section that is starting. `starts` are the bar's felt
 * pulses; `lowLane` (optional) are the beats percussion's low lane is hitting,
 * which the groove locks onto where it can — a bass and a kick that agree on
 * their onsets are heard as one instrument, which is the whole point of a
 * rhythm section.
 */
export function buildBassGroove({
  starts = [0, 1, 2, 3], beats = 4, intensity = 0.5, complexity = 0.5,
  lowLane = null, densityScale = 1, timingVary = 0, rng = Math.random,
} = {}) {
  // v21 densityScale (0–2) is the track's own density param: it multiplies the
  // rate the groove was going to have, and 1 leaves it exactly where it was.
  const scale = Number.isFinite(Number(densityScale)) ? clamp(Number(densityScale), 0, 2) : 1;
  const density = clamp(
    (0.2 + clamp(intensity, 0, 1) * 0.5 + clamp(complexity, 0, 1) * 0.3) * scale, 0, 1,
  );
  const feelName = pick(
    density < 0.45 ? ['held', 'mixed'] : density < 0.75 ? ['mixed', 'staccato', 'held'] : ['staccato', 'mixed'],
    rng,
  );
  const gates = BASS_FEELS[feelName];
  const articulation = BASS_ARTICULATIONS[pick(
    density < 0.4 ? ['holdOne', 'longShort'] : ['longShort', 'shortLong', 'holdOne', 'even'], rng,
  )];
  const pocket = bassPocketSeconds(timingVary, rng);

  // v24: the anchor grid the groove is built against. With a kit playing it is
  // the kick's own onsets, which is what makes the two read as one instrument;
  // with no kit it is a stride through the bar's felt pulses, drawn once. Either
  // way the line has a spine it keeps, instead of an independent coin flip on
  // every beat, which is what a drummerless bass used to be.
  const locked = Array.isArray(lowLane) && lowLane.length ? lowLane : null;
  const stride = density > 0.66 ? 1 : density > 0.4 ? 2 : 2 + Math.floor(rng() * 2);
  const anchors = locked ?? starts.filter((_, i) => i % stride === 0);
  const near = (beat) => anchors.some((hit) => Math.abs(hit - beat) < 0.13);

  // The anchor: root, accented, the thing the ear counts from. It sits on the
  // downbeat unless the kick does not — a groove whose first low hit is the
  // second pulse anchors there instead, which is what locking to the low lane
  // means when the pattern is not four-on-the-floor.
  const anchorAt = !near(starts[0] ?? 0)
    ? starts.find((start) => near(start)) ?? starts[0] ?? 0
    : starts[0] ?? 0;
  const steps = [{ beat: anchorAt, tone: 'root', gate: gates.anchor, accent: true }];
  if (anchorAt !== (starts[0] ?? 0)) {
    // The bar still owes its downbeat a root; it just is not the accent.
    steps.push({ beat: starts[0] ?? 0, tone: 'root', gate: gates.pulse, accent: false });
  }

  for (let i = 1; i < starts.length; i++) {
    // v14: when percussion is playing, its low lane IS the bass's grid — every
    // pulse the kick lands on is taken, so the two are heard as one instrument.
    // Away from the anchor grid it is a density draw, and a thinner one than
    // v14's: a pulse the line DOESN'T take is where a bass line breathes, and
    // the shipped bass took nearly all of them.
    const chance = near(starts[i]) ? 1 : density * 0.55;
    if (rng() < chance) {
      steps.push({ beat: starts[i], tone: 'root', gate: gates.pulse, accent: false });
    }
  }

  // The articulation cycle runs over the pulse spine in the order it is played,
  // so the same step of the line is the same length every bar it is stated.
  const spine = sortGroove(steps);
  spine.forEach((step, i) => {
    step.gate = clamp(step.gate * articulation[i % articulation.length], 0.12, 1);
  });

  // Syncopation: one cell, hung off a pulse, plus a second when the section is
  // busy enough to carry it. Off-pulse notes are where the fifth and octave
  // live, so the root discipline survives every one of them.
  const cells = 1 + (density > 0.6 && rng() < density ? 1 : 0);
  for (let c = 0; c < cells; c++) {
    const cell = pick(BASS_CELLS, rng);
    const pulse = starts[1 + (Math.floor(rng() * Math.max(1, starts.length - 1)) % Math.max(1, starts.length - 1))]
      ?? starts[0];
    for (const offset of cell) {
      const beat = pulse + offset;
      if (beat >= beats - 1e-9) continue;
      if (spine.some((step) => Math.abs(step.beat - beat) < 1e-9)) continue;
      spine.push({
        beat,
        tone: rng() < 0.65 ? 'fifth' : 'octave',
        gate: gates.offbeat,
        accent: false,
        ghost: rng() < 0.4,
      });
    }
  }

  // The phrase ending. Whatever the line's last note of the bar is, it commits
  // to one of the two things a bassist does into a change: a held groove rings
  // across the barline and lets the mono glide carry the root over, anything
  // shorter lifts off it so the next downbeat lands in air. Doing neither is
  // what made every bar of the shipped line the same shape as the one before.
  const sorted = sortGroove(spine);
  const tail = sorted[sorted.length - 1];
  if (tail) tail.gate = feelName === 'held' ? 1 : Math.min(tail.gate ?? 0.9, 0.45);

  return { feel: feelName, beats, pocket, steps: sorted };
}

const sortGroove = (steps) => steps.slice().sort((a, b) => a.beat - b.beat);

export function cloneBassGroove(groove) {
  return {
    feel: groove.feel,
    beats: groove.beats,
    pocket: groove.pocket ?? 0,
    steps: groove.steps.map((step) => ({ ...step })),
  };
}

/**
 * One development of a stated groove — the same idea, said slightly
 * differently. `state` is the groove itself, which is what most bars play; the
 * rest are the variations a bassist reaches for without changing the line:
 *
 * - ghost      a quiet extra note in a gap
 * - push       one off-pulse note anticipated by a semiquaver
 * - simplify   the last off-pulse note dropped
 * - double     an off-pulse note repeated an eighth later
 * - fill       the turnaround: the bar's last quarter cleared for a short run
 *              into whatever comes next (v24)
 *
 * `starts` is passed so every branch can re-assert the harmonic contract: a
 * step that lands on a felt pulse is the root, whatever it was before.
 */
export function developBassGroove(groove, op, {
  starts = [0, 1, 2, 3], rng = Math.random,
} = {}) {
  const next = cloneBassGroove(groove);
  const beats = next.beats;
  const onPulse = (beat) => starts.some((start) => Math.abs(start - beat) < 1e-9);
  const offPulse = next.steps.filter((step) => !onPulse(step.beat));
  const taken = (beat) => next.steps.some((step) => Math.abs(step.beat - beat) < 1e-9);

  if (op === 'ghost') {
    const slots = [];
    for (let beat = 0.5; beat < beats - 1e-9; beat += 0.5) {
      if (!onPulse(beat) && !taken(beat)) slots.push(beat);
    }
    if (slots.length) {
      const beat = pick(slots, rng);
      next.steps.push({ beat, tone: 'octave', gate: 0.3, accent: false, ghost: true });
    }
  } else if (op === 'push' && offPulse.length) {
    const step = pick(offPulse, rng);
    const to = step.beat - 0.25;
    if (to > 0 && !onPulse(to) && !taken(to)) step.beat = to;
  } else if (op === 'simplify' && offPulse.length) {
    const last = offPulse[offPulse.length - 1];
    next.steps = next.steps.filter((step) => step !== last);
  } else if (op === 'double' && offPulse.length) {
    const step = pick(offPulse, rng);
    const beat = step.beat + 0.5;
    if (beat < beats - 1e-9 && !onPulse(beat) && !taken(beat)) {
      next.steps.push({ ...step, beat, gate: 0.3, accent: false, ghost: true });
    }
  } else if (op === 'fill') {
    // The turnaround. Everything the groove had in the bar's last quarter is
    // cleared — a fill REPLACES the tail of the line rather than crowding it —
    // and the felt pulses are left alone, so the bar still lands where it did.
    const run = pick(BASS_FILLS, rng);
    const from = beats - Math.max(...run.before);
    next.steps = next.steps.filter((step) => onPulse(step.beat) || step.beat < from - 1e-9);
    run.before.forEach((before, i) => {
      const beat = beats - before;
      if (beat <= 0 || onPulse(beat) || taken(beat)) return;
      next.steps.push({
        beat, tone: run.tones[i] ?? 'octave', gate: 0.45, accent: false, fill: true,
      });
    });
  }

  // The contract, re-asserted after every branch: felt pulses voice the root.
  for (const step of next.steps) if (onPulse(step.beat)) step.tone = 'root';
  next.steps = sortGroove(next.steps);
  return next;
}

/**
 * Which development a bar of the groove states. Bar 0 of every four-bar cycle
 * is the groove itself — a line nobody ever hears plain is not a groove — and
 * `variation` (the bass's randomness) decides how far the others stray:
 * whether the bar varies at all, which way, and whether it simply says again
 * what the bar before said, because a development stated twice is the one the
 * ear actually catches.
 *
 * All four draws are made whatever the variation is — the rule the register
 * wander already follows: the dial changes the LINE, not the position every
 * later draw in the bar takes in the stream. At variation 0 the groove is
 * stated every bar, so a frozen bass is frozen bar for bar.
 *
 * v24 adds the turnaround. A fill only ever lands on the last bar of an
 * eight-bar count, which is also why it can never fall in the opening bars of a
 * section: the ear has to have learnt the line before a fill can be heard as
 * leaving it. `intensity` scales how often, so a quiet section barely fills at
 * all, and a fill is never said twice running.
 */
export function bassGrooveOp(
  barInCycle, variation = 0.5, rng = Math.random, previousOp = 'state', intensity = 0.5,
) {
  const roll = rng();
  const again = rng();
  const choice = rng();
  const turnaround = rng();
  if (barInCycle % 4 === 0 || variation <= 0) return 'state';
  if (barInCycle % BASS_FILL_CYCLE === BASS_FILL_CYCLE - 1
    && turnaround < clamp(intensity, 0, 1) * BASS_FILL_CHANCE) return 'fill';
  if (previousOp !== 'state' && previousOp !== 'fill'
    && again < 0.25 + (1 - variation) * 0.45) return previousOp;
  if (roll >= variation * 0.6) return 'state';
  const weights = [
    ['ghost', 1.2],
    ['push', 0.8],
    ['simplify', 0.7],
    ['double', 0.6],
  ];
  const total = weights.reduce((sum, [, weight]) => sum + weight, 0);
  let r = choice * total;
  for (const [op, weight] of weights) {
    r -= weight;
    if (r <= 0) return op;
  }
  return 'state';
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
/**
 * v14 retune: at the shipped defaults the old ladder never reached percussion
 * at all — complexity 0.5 under `waves` tops out at energy 0.64, short of the
 * 0.78 it used to ask for — so the kit the user likes best simply never
 * arrived. The top of the ladder is pulled down to fit inside the range the
 * defaults actually cover, and the rest is spread evenly beneath it. The order
 * is unchanged: pad first, percussion still last in.
 */
const AUTO_THRESHOLDS = Object.freeze(Object.fromEntries(
  TRACK_REGISTRY.map((track) => [track.id, track.autoThreshold]),
));

/** A track's place on the ladder, from the floor's own table. */
const floorAutoThreshold = (name) => AUTO_THRESHOLDS[name];

/**
 * `tracks` and `thresholdFor` default to the floor, so every existing caller
 * asks the same question of the same six; an engine passes its own list and
 * its own threshold accessor so a user track can join the ladder.
 */
export function autoActiveTracks(intensity = 0.5, complexity = 0.5,
  tracks = TRACK_ORDER, thresholdFor = floorAutoThreshold) {
  const energy = 0.55 * clamp(Number(intensity) || 0, 0, 1) + 0.45 * clamp(Number(complexity) || 0, 0, 1);
  return tracks.filter((name) => energy >= thresholdFor(name));
}

// -- the silence floor (v14) ------------------------------------------------
//
// The defect the user reported: at the shipped defaults the piece can fall
// silent for whole bars at a time — the pad takes one of its v11 breathing
// rests while the texture happens to be below its activation threshold, and
// nothing at all is left sounding. The engine's own guard is in beginBar; the
// two predicates below are the same question asked of a RECORDING, so the
// property can be checked from outside without reaching into engine state.

/**
 * How many bars of the log a note is audible in. `notes` are 'note' events
 * ({ time, duration }); `bars` are 'bar' events ({ bar, time }). The final bar
 * is not judged: nothing has told us when it ends.
 */
export function silentBars(notes, bars) {
  const list = Array.isArray(bars) ? bars.filter((b) => b && Number.isFinite(b.time)) : [];
  const sounds = Array.isArray(notes) ? notes.filter((n) => n && Number.isFinite(n.time)) : [];
  const silent = [];
  for (let i = 0; i + 1 < list.length; i++) {
    const from = list[i].time;
    const to = list[i + 1].time;
    const heard = sounds.some((note) => note.time < to - 1e-9
      && note.time + Math.max(0, Number(note.duration) || 0) > from + 1e-9);
    if (!heard) silent.push(list[i].bar ?? i);
  }
  return silent;
}

/** The longest stretch of consecutive silent bars in a recording. */
export function longestSilentRun(notes, bars) {
  const silent = new Set(silentBars(notes, bars));
  let longest = 0;
  let run = 0;
  const list = Array.isArray(bars) ? bars : [];
  for (let i = 0; i + 1 < list.length; i++) {
    if (silent.has(list[i].bar ?? i)) {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  return longest;
}

/**
 * The property the v14 defect asks for: a piece that never falls audibly
 * silent. `maxSilentBars` is the tolerance — 0 for "something is always
 * sounding", 1 for the single bar of breath a solo pad is allowed.
 */
export function isContinuouslyAudible(notes, bars, { maxSilentBars = 0 } = {}) {
  return longestSilentRun(notes, bars) <= Math.max(0, maxSilentBars);
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
 * levels a voice gets when no patch names its own. The numbers live in the
 * registry; this is the by-id view of them. Levels are lower than v1's
 * four-track set: six sources sum, so pad/bass keep the bulk of the budget and
 * the four decorative tracks each sit well under it. Worst case (every track
 * on, velocity 1) lands under unity before the master's 0.7 headroom and the
 * glue compressor.
 */
const TRACK_MIX = Object.freeze(Object.fromEntries(
  TRACK_REGISTRY.map((track) => [track.id, track.mix]),
));

/** A track's mix row, from the floor's own table. */
const floorMix = (name) => TRACK_MIX[name];

/**
 * The instance track layer (v23). Every derived table above is a module
 * constant, frozen at import and unreachable from a running engine, so an
 * engine reads its tracks through THESE accessors instead — one indirection
 * that a user track added at runtime can reach, where a captured constant
 * would have frozen it out.
 *
 * With no user tracks (all this window ships) each accessor hands back the
 * module's own frozen object: `trackOrder() === TRACK_ORDER`,
 * `trackViews() === TRACK_VIEWS`. That identity is load-bearing, not an
 * optimisation — nothing copies, re-sorts or allocates, so the v22 identity
 * proofs and `engine.getTracks() === getTracks()` hold exactly as they did.
 */
export function createTrackLayer() {
  const trackRegistry = () => TRACK_REGISTRY;
  return {
    trackRegistry,
    trackOrder: () => TRACK_ORDER,
    sequencedTracks: () => SEQUENCED_TRACKS,
    tunedTracks: () => TUNED_TRACKS,
    trackViews: () => TRACK_VIEWS,
    trackById: (id) => TRACK_BY_ID.get(id),
    mixFor: floorMix,
    autoThresholdFor: floorAutoThreshold,
    // The module helper, asked about this engine's registry rather than the
    // floor's — the shadowing is deliberate: every call site inside
    // createEngine reads the layer's answer, not the module's.
    stageIndexOf: (id) => stageIndexOf(id, trackRegistry()),
    stageBars: () => MAX_STAGE_INDEX,
  };
}

function audioContextCtor() {
  const g = globalThis;
  return g.AudioContext || g.webkitAudioContext || null;
}

/** True when this environment can actually make sound. */
export function isSupported() {
  return audioContextCtor() !== null;
}

/** How long a reverb tail swap takes to crossfade (v21). */
const REVERB_CROSSFADE = 0.5;
const REVERB_DECAY = 3.2;
const REVERB_RETURN_LEVEL = 0.9;

/**
 * Procedural impulse response: stereo noise under an exponential decay, with a
 * few milliseconds of fade-in so the reverb blooms instead of cracking.
 */
function createImpulseResponse(ctx, seconds = 4, decay = REVERB_DECAY, rng = Math.random) {
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

function buildGraph(ctx, tracks = TRACK_ORDER, mixFor = floorMix, rng = Math.random) {
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

  // v21: the track sends feed a BUS rather than the convolver itself, so a
  // reverbTail rebuild can crossfade to a second convolver without touching —
  // or momentarily silencing — a single send.
  const reverbBus = ctx.createGain();
  reverbBus.gain.value = 1;
  const convolver = ctx.createConvolver();
  convolver.normalize = true;
  convolver.buffer = createImpulseResponse(ctx, DEFAULT_PARAMS.reverbTail, REVERB_DECAY, rng);
  const reverbReturn = ctx.createGain();
  reverbReturn.gain.value = REVERB_RETURN_LEVEL;
  reverbBus.connect(convolver);
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

  const nodes = {};
  for (const name of tracks) {
    const mix = mixFor(name);
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
    reverbSend.connect(reverbBus);
    // Both sends are always wired: a patch can raise either from zero, so the
    // send level — not the connection — is what decides audibility.
    tone.connect(delaySend);
    delaySend.connect(delay);
    tone.connect(analyser);
    nodes[name] = { input, tone, dry, reverbSend, delaySend, analyser };
  }

  // `convolver`, `reverbReturn` and `reverbSeconds` are the LIVE tail: a swap
  // replaces all three, which is why nothing else holds a reference to them.
  return {
    master, compressor, reverbBus, convolver, reverbReturn,
    reverbSeconds: DEFAULT_PARAMS.reverbTail, delay, feedback, tracks: nodes,
  };
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
  // v23: this engine's own view of its tracks. Nothing below reads a module
  // track table directly — every one of them is a floor an added track has to
  // be able to stand on top of.
  const {
    trackOrder, sequencedTracks, trackViews,
    mixFor, autoThresholdFor, stageIndexOf, stageBars,
  } = createTrackLayer();

  let params = sanitiseParams(initialParams, DEFAULT_PARAMS, trackOrder());
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

  // v21 reverbTail. `reverbBudget` is the governor's cap (Infinity = uncapped);
  // `reverbTarget` is the tail the live or in-flight IR is for; `reverbFade` is
  // the outgoing convolver waiting for its crossfade to finish.
  let reverbBudget = Infinity;
  let reverbTarget = null;
  let reverbBuildTimer = null;
  let reverbFade = null;
  let reverbFadeTimer = null;
  // v12 mono: the note each monophonic track currently has sounding, so the
  // next one can either slur into it or replace it.
  const monoNotes = new Map(); // track → { entry, handle, freq, until, voice }

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

  // Repeat brackets (v15): the bar range the piece is looping over, and the
  // realised decisions of every bar in it — captured on the first traversal,
  // replayed verbatim on every later pass.
  let loopRegion = null;            // { start, end } — end exclusive
  const loopCapture = new Map();    // bar number → that bar's captured decisions
  let loopRecord = null;            // the record the bar being scheduled reads/writes

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
  const hookBank = createVariantBank({ size: HOOK_BANK_SIZE, clone: cloneHook });
  let hookSectionPending = false; // a section changed: re-pick a variant at the next pass
  let chordDegree = 0;
  let chordInversion = 0;
  let chordExtension = 0;
  let chordBarsLeft = 0;

  // Pad breathing (v11)
  let padSwellPhase = 0;       // position in the pad's four-bar dynamic contour
  let padRested = false;       // the chord span just gone was a rest

  // The v14 silence floor: tracks promoted for one bar to cover a gap, how
  // many bars have now passed with nothing audible, and the end of the last
  // note the engine scheduled (how far the piece is covered to).
  const promoted = new Set();
  let silentRun = 0;
  let lastNoteEnd = 0;

  // Melodic state — the v12 motif: one cell per section, developed bar by bar,
  // banked and recalled through the same machinery as the hook.
  let motif = null;              // the cell every melody bar is a development of
  let motifPhrase = 0;           // phrases the current cell has been heard through
  let motifSalience = 0;         // phrases it has survived without being replaced
  let motifSectionPending = false; // a section changed: re-pick a cell at the next phrase
  let motifPending = null;       // a cell the hook's recall asked the melody to bring back
  let phraseBar = 0;             // bar within the current phrase
  const motifBank = createVariantBank({ size: MOTIF_BANK_SIZE, clone: cloneMotif });

  // The bass's per-section groove, drawn once per section rather than per bar,
  // and the bar count it is developed against.
  let bassGroove = null;
  let bassGrooveKey = '';
  let bassGrooveBar = 0;
  let bassGrooveOpLast = 'state';
  // The line's lay-back: ONE constant every bass note of the section shares
  // (v24). Null until the groove — or, on a manual grid, the first bar — draws it.
  let bassPocket = null;

  // Realised bar plans (see planFor): every random draw a bar needs is made
  // once, at the barline, so hold can replay a bar identically.
  let melodyPlan = { motifDerived: false, notes: [] };
  let melodyShift = 0;         // the bar's octave transposition into the register band
  let responder = null;        // the instrument answering the melody this bar (v14)
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
  const activeSequencer = new Map();  // track → index into tracks[t].sequencers
  // vary.voice wander: EPHEMERAL, so it never reaches params/getParams.
  const wanderedVoice = new Map();  // track → the voice id actually sounding
  // Per-kind patch merges (v14 kit), by `${track}:${voice}:${kind}`.
  const kindPatches = new Map();
  // The same merges with every v7 range resolved to a number, thrown away each
  // bar so a ranged patch drifts instead of freezing at its first resolution.
  const resolvedPatches = new Map();

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

  /** v21: this track's walk step, driftRate scaling the ±0.15/bar default. */
  function walkStep(track) {
    const config = params.tracks[track];
    const rate = config && typeof config.driftRate === 'number'
      ? config.driftRate : DEFAULT_TRACK_DRIFT_RATE;
    return WALK_STEP * clamp(rate, DRIFT_RATE_RANGE[0], DRIFT_RATE_RANGE[1]);
  }

  function advanceWalks() {
    // v14 random/hold merge: randomness 0 IS a hold, so a track sitting at 0
    // drifts by nothing at all.
    const frozen = new Set(trackOrder().filter(isFrozenTrack));
    for (const [key, position] of walkPhases) {
      // SPEC-CRITIC [hold/prob] → ruling 5: hold freezes every draw the bar
      // makes, and the walk step is one of them. A held track's ranged params —
      // step probability included — therefore sit still until it is released.
      const track = key.slice(0, key.indexOf(':'));
      if (held.has(track) || frozen.has(track)) continue;
      let next = position + (rng() * 2 - 1) * walkStep(track);
      if (next < 0) next = -next;
      if (next > 1) next = 2 - next;
      walkPhases.set(key, clamp(next, 0, 1));
    }
    // Every patch resolution the last bar handed out was taken against the walk
    // positions this loop has just moved, so none of them survives the barline.
    // A frozen track's re-resolution lands on the same numbers, which is what
    // makes randomness 0 hold a ranged patch still as well as a ranged plan.
    resolvedPatches.clear();
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
    return clamp(value ?? RANDOMNESS_FALLBACK, 0, 1);
  }

  /**
   * v14: randomness 0 means HOLD — the material loops exactly, nothing drifts
   * and nothing re-rolls. The `hold` param stays a separate switch (the UI
   * drives both from the one dial), so this is the half of the merge the
   * engine owes: at 0 a track's own generators stop varying, whether or not
   * anything set hold.
   *
   * v21: read from the STORED value (randomnessIsHold), not the resolved one.
   * The default randomness is a range now, and a range whose walk dipped to
   * zero for one bar is a quiet bar, not a hold — only a span pinned at the
   * bottom freezes the track.
   */
  function isFrozenTrack(track) {
    return randomnessIsHold(params.tracks[track].randomness);
  }

  /** A track's dissonance (v14): how far it may stray from the group chord. */
  function trackDissonance(track) {
    const config = params.tracks[track];
    if (!config || config.dissonance === undefined) return 0;
    return clamp(resolveRange(track, 'dissonance', config.dissonance) ?? 0, 0, 1);
  }

  /**
   * v21 per-track swing: the track's own amount, or the global dial when it is
   * following (null). Read once per bar into the bar snapshot, exactly as the
   * global one is, so a change of feel lands on a barline.
   */
  function trackSwing(track) {
    const own = params.tracks[track].swing;
    return clamp(own === null || own === undefined ? params.swing : own, 0, 1);
  }

  /**
   * v21 per-track density: the multiplier on this track's own event rate, 1
   * while it follows complexity (null). Every AUTO planner draws against it; a
   * manual grid never does, because a sequenced bar is the user's own
   * statement of when the track sounds.
   */
  function trackDensity(track) {
    const value = params.tracks[track].density;
    return value === null || value === undefined ? 1 : value;
  }

  /** The kit as it currently stands: the lane list the drum grid is keyed by. */
  function percussionLanes() {
    return params.tracks.percussion.lanes ?? [];
  }

  /** The lane an auto-generated hit of `kind` sounds through: the first mapped to it. */
  function laneForKind(kind) {
    const lane = percussionLanes().find((entry) => entry.kind === kind);
    return lane ? lane.id : kind;
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

  /**
   * One dissonance decision for one note (v14). Returns 0 for the strict
   * chord discipline every earlier version had, `{ chromatic: false, dir }`
   * for a passing/neighbour tone still inside the mode, or
   * `{ chromatic: true, dir }` for a borrowed tone from outside it — the
   * higher the dial, the more often, and the more often borrowed.
   *
   * Nothing is drawn at dissonance 0, so the shipped defaults spend no
   * randomness on a feature they are not using.
   */
  function dissonanceDraw(track) {
    const amount = trackDissonance(track);
    if (amount <= 0) return 0;
    if (rng() >= amount * 0.45) return 0;
    const dir = rng() < 0.5 ? -1 : 1;
    return { chromatic: rng() < amount * 0.7, dir };
  }

  /** A sequencer step's firing probability, resolving a v7 range via its walk. */
  function effectiveProb(track, param, prob) {
    return clamp(resolveRange(track, param, prob) ?? 1, 0, 1);
  }

  /**
   * The sequencer a pulsed track is CURRENTLY playing, or null for pad and
   * texture. With one sequencer this is the one the v6 param always was; with
   * several (v14) it is whichever the Markov walk last landed on.
   */
  function sequencerFor(track) {
    const list = params.tracks[track].sequencers;
    if (!list || !list.length) return params.tracks[track].sequencer ?? null;
    const at = clamp(activeSequencer.get(track) ?? 0, 0, list.length - 1);
    return list[at];
  }

  /**
   * End of a loop: which of the track's sequencers plays the next bar. The
   * current one's weights are the transition row of a small Markov chain, so a
   * user can make one sequence lead reliably into another, or let a set of
   * variations shuffle. A single sequencer (or an all-zero row) never moves,
   * and never draws.
   */
  function advanceSequencers() {
    for (const track of sequencedTracks()) {
      const list = params.tracks[track].sequencers;
      if (!list || list.length < 2) continue;
      if (held.has(track) || isFrozenTrack(track)) continue;
      const from = clamp(activeSequencer.get(track) ?? 0, 0, list.length - 1);
      const weights = list[from].weights;
      const total = weights.reduce((sum, weight) => sum + Math.max(0, weight), 0);
      if (total <= 0) continue;
      let r = rng() * total;
      let next = from;
      for (let i = 0; i < weights.length; i++) {
        r -= Math.max(0, weights[i]);
        if (r <= 0) { next = i; break; }
      }
      if (next !== from) clearFrozen(track);
      activeSequencer.set(track, next);
    }
  }

  /**
   * A step's effective probability inside its group (v14 conditional trigs):
   * within a group, a step only has its own chance if the group's previous
   * step actually sounded. Break the chain and the rest of the group stays
   * quiet until the group starts again on the next bar.
   */
  function groupedProb(sounded, step, prob) {
    if (step.group === undefined) return prob;
    return sounded.get(step.group) === false ? 0 : prob;
  }

  /**
   * Ties (v14): a step marked `tie` merges with the step after it — ONE note
   * spanning both. The absorbed step is dropped from the bar, so the note in
   * front of it simply runs on to whatever comes next.
   */
  function mergeTies(notes, lane, slots) {
    if (!notes.some((note) => lane[note.index] && lane[note.index].tie === true)) return notes;
    const merged = [];
    let i = 0;
    while (i < notes.length) {
      const note = notes[i];
      let end = note.index;
      while (end + 1 < slots && lane[end].tie === true) end += 1;
      // How many grid slots the merged note covers, for the tracks whose note
      // length is its own field rather than the gap to the next onset.
      note.slots = end - note.index + 1;
      merged.push(note);
      i += 1;
      while (i < notes.length && notes[i].index <= end) i += 1;
    }
    return merged;
  }

  function isManual(track) {
    const sequencer = sequencerFor(track);
    return Boolean(sequencer && sequencer.mode === 'manual');
  }

  // -- repeat brackets -------------------------------------------------------

  /** The longest span a pair of brackets may enclose (v15). */
  const MAX_LOOP_BARS = 64;

  /**
   * One decision of the bar being scheduled, taken once and replayed on every
   * later pass of a repeat that encloses it. Outside a loop — and on the first
   * traversal of one — this is just `realise()`, so nothing about the ordinary
   * path changes.
   */
  function once(key, realise) {
    if (!loopRecord) return realise();
    if (key in loopRecord) return loopRecord[key];
    const value = realise();
    loopRecord[key] = value;
    return value;
  }

  /**
   * The record for the bar about to be scheduled: null outside the loop (or
   * with no loop set), a fresh one on the range's first traversal, and the
   * captured one on every pass after that.
   */
  function loopRecordFor(number) {
    if (!loopRegion || number < loopRegion.start || number >= loopRegion.end) return null;
    let record = loopCapture.get(number);
    if (!record) {
      record = {};
      loopCapture.set(number, record);
    }
    return record;
  }

  /**
   * `setLoopRegion(4, 8)` is the pair of brackets 𝄆4 … 8𝄇: bars 4–7 play, and
   * the bar that would have been 8 is bar 4 again. Reversed brackets are
   * normalised rather than rejected, an empty span becomes the single bar it
   * was drawn around, and an over-long one is clamped — a repeat is a
   * performance gesture, and the engine would rather play a sane range than
   * ignore the click. Returns the range it actually took, or null.
   */
  function setLoopRegion(startBar, endBar) {
    // Anything that is not a bar number — null, '', a boolean, a shape — is a
    // caller mistake, and a mistake must not move brackets that are already set.
    const barNumber = (value) => (value === null || value === undefined || value === ''
      || typeof value === 'boolean' ? NaN : Math.floor(Number(value)));
    const from = barNumber(startBar);
    const to = barNumber(endBar);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
    const start = Math.max(0, Math.min(from, to));
    let end = Math.max(start + 1, Math.max(0, Math.max(from, to)));
    if (end - start > MAX_LOOP_BARS) end = start + MAX_LOOP_BARS;
    // Re-setting the range that is already playing keeps its captured material:
    // the brackets did not move, so nothing about the repeat should change.
    if (loopRegion && loopRegion.start === start && loopRegion.end === end) {
      return { start, end };
    }
    loopRegion = { start, end };
    loopCapture.clear();
    loopRecord = null;
    return { start, end };
  }

  /**
   * Release the repeat. The piece plays on from the close of the brackets —
   * the next bar is the one after the range, not another pass of it — so
   * clearing mid-loop resumes the piece where the repeat interrupted it
   * instead of replaying the bars it has already been round.
   */
  function clearLoopRegion() {
    if (!loopRegion) return false;
    const { start, end } = loopRegion;
    loopRegion = null;
    loopCapture.clear();
    loopRecord = null;
    if (isRunning && barIndex > start && barIndex < end) {
      structureBar += end - barIndex;
      barIndex = end;
    }
    return true;
  }

  // -- hold / re-roll --------------------------------------------------------

  const planKey = (track, sub) => (sub === undefined ? track : `${track}#${sub}`);

  /**
   * A held track replays the bar plan it froze; every other track realises a
   * fresh one. The plan holds the DRAWS, never absolute pitch, so a frozen bar
   * still follows the progression, root and mode — harmony keeps advancing
   * underneath a hold (ruling 5).
   *
   * A repeat is a positional hold laid over the top: inside the brackets the
   * plan a bar realised is the plan that bar keeps, whatever hold says.
   */
  function planFor(track, sub, realise) {
    return once(`plan:${track}`, () => {
      if (!held.has(track)) return realise();
      const key = planKey(track, sub);
      let plan = frozenPlans.get(key);
      if (!plan) {
        plan = realise();
        frozenPlans.set(key, plan);
      }
      return plan;
    });
  }

  function clearFrozen(track) {
    for (const key of [...frozenPlans.keys()]) {
      if (key === track || key.startsWith(`${track}#`)) frozenPlans.delete(key);
    }
  }

  /** Hold engages and releases on the barline, never mid-bar. */
  function applyHolds() {
    for (const name of trackOrder()) {
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
          hookBank.clear();
          chordBarsLeft = 0;
          // The bass's own re-roll is its rhythm; the pattern is redrawn for
          // the section it is in.
          bassGroove = null;
          bassGrooveKey = '';
          bassGrooveBar = 0;
          bassGrooveOpLast = 'state';
          bassPocket = null;
          break;
        case 'melody':
          motifBank.clear();
          motif = null;
          motifPending = null;
          motifPhrase = 0;
          phraseBar = 0;
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
      for (const name of trackOrder()) pendingRandomise.add(name);
      return;
    }
    // Stopped, or an unknown track name: nothing to do, and nothing to throw.
    if (typeof track === 'string' && trackOrder().includes(track)) pendingRandomise.add(track);
  }

  // -- track activity --------------------------------------------------------

  function sectionIntensity() {
    return currentSection ? currentSection.intensity : 0.5;
  }

  function isActive(name) {
    const state = params.tracks[name].state;
    if (state === 'off') return false;
    // The silence floor promoted this track for the bar being scheduled: it is
    // covering a gap nothing else would have filled.
    if (promoted.has(name)) return true;
    // The closing bar always gets its pad and bass, whatever the section
    // intensity would otherwise have decided — that is the resolution.
    if (outroStarted && (name === 'pad' || name === 'bass')) return true;
    // SPEC-CRITIC [staged-drone] → ruling 7: staged entry is a property of the
    // PIECE, not of the structure preset, so it is counted in barIndex and
    // never restarts when the structure changes mid-piece. Bar 0 is pad alone
    // under every preset (drone included) and every track state — a track
    // forced 'on' still waits its turn — with all six eligible by bar 5.
    if (currentBarNumber < stageIndexOf(name)) return false;
    if (state === 'on') return true;
    return autoActiveTracks(sectionIntensity(), params.complexity,
      trackOrder(), autoThresholdFor).includes(name);
  }

  /** Effective harmonic colour: complexity, opened up by section intensity. */
  function colour() {
    return clamp(params.complexity * (0.6 + sectionIntensity() * 0.6), 0, 1);
  }

  // -- live parameter application -------------------------------------------

  /**
   * The v8 gain chain (SPEC-CRITIC [multiplier order] → ruling 2):
   *
   *   mixFor(t).level × clamp(level-drift × volume-walk, SILENCE, 1)
   *
   * The user's `level` and the vary.volume walk multiply INSIDE a clamp to 1,
   * so the tuned v5 mix is a ceiling that nothing can push past: that clamp is
   * the headroom guarantee, and MASTER_HEADROOM stays exactly as it was. The
   * walk is 2^(0.5·a·u) with u a reflected walk in [-2, 2], i.e. ±6 dB at
   * a = 1, centred on the configured level.
   */
  function trackGain(name) {
    const mix = mixFor(name).level;
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
    for (const name of trackOrder()) {
      const track = graph.tracks[name];
      // A track switched off stops SCHEDULING; what is already sounding rings
      // out on its own release rather than being pulled out from under the
      // listener. Muting therefore waits until the tail is gone, which the next
      // bar's pass picks up — nothing here ever cancels a live note.
      const level = isActive(name) ? trackGain(name)
        : hasSoundingNotes(name, time) ? null : SILENCE;
      if (level !== null) {
        track.input.gain.setTargetAtTime(Math.max(level, SILENCE), time, constant);
      }
      const brightness = clamp(mixFor(name).tone * (0.55 + intensity * 0.75), 300, 18000);
      track.tone.frequency.setTargetAtTime(brightness, time, constant);
    }
  }

  /**
   * Every v7 RangeValue in a patch as the number ruling 9c promises the voices:
   * one drift walk per (track, voice, field), so a ranged cutoff and a ranged
   * reverb send on the same voice wander independently while a note's own draws
   * leave both alone. A patch of plain numbers is returned unchanged and opens
   * no walk at all — the shipped defaults cost nothing.
   */
  function resolvePatchRanges(track, voiceId, patch) {
    let out = null;
    for (const section of Object.keys(PATCH_SCHEMA)) {
      const fields = patch[section];
      if (!fields) continue;
      for (const [field, value] of Object.entries(fields)) {
        if (!value || typeof value !== 'object') continue;
        if (!out) out = { ...patch };
        if (out[section] === fields) out[section] = { ...fields };
        out[section][field] = resolveRange(track, `patch.${voiceId}.${section}.${field}`, value);
      }
    }
    return out ?? patch;
  }

  /**
   * The patch the currently selected voice of `track` should be played with,
   * for a note struck by `lane` (v14 kit editor; v21 keys the overrides by lane
   * id rather than voice kind, which for the three built-ins is the same
   * string). A percussion note whose lane names a per-instrument override is
   * played with that override merged over the common patch; every other note —
   * every note of a melodic track included, since only percussion carries a
   * lane — is played with the common patch alone, with the overrides stripped
   * so they can never reach a voice they were not written for.
   *
   * What comes back is always NUMBERS (ruling 9c): a ranged field is resolved
   * through its walk here, so nothing downstream — play(), applySends,
   * getResolved — ever meets a `{ min, max }`.
   *
   * Two caches sit behind this because it is on the per-note path. The MERGED
   * patch is cached per (track, voice, kind) and only setParams() drops it —
   * the voice is in the key, so a wander needs no invalidation of its own. The
   * RESOLVED patch is cached under the same key but thrown away every bar,
   * which is what stops a ranged patch freezing on the first note that read it.
   */
  function patchFor(track, lane = null) {
    const bank = params.patches[track];
    if (!bank) return undefined;
    const voiceId = effectiveVoice(track);
    const common = bank[voiceId];
    if (!common) return undefined;
    const key = `${track}:${voiceId}:${lane ?? ''}`;
    const cached = resolvedPatches.get(key);
    if (cached) return cached;
    let merged = kindPatches.get(key);
    if (!merged) {
      merged = common.perKind
        ? mergeSections(common, lane === null ? null : common.perKind[lane])
        : common;
      kindPatches.set(key, merged);
    }
    const resolved = resolvePatchRanges(track, voiceId, merged);
    resolvedPatches.set(key, resolved);
    return resolved;
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
    for (const name of trackOrder()) {
      const patchSends = patchFor(name)?.sends;
      const voice = voiceFor(name);
      const voiceSends = voice && voice.defaults ? voice.defaults.sends : null;
      const reverb = typeof patchSends?.reverb === 'number' ? patchSends.reverb
        : typeof voiceSends?.reverb === 'number' ? voiceSends.reverb
          : mixFor(name).reverb;
      const delay = typeof patchSends?.delay === 'number' ? patchSends.delay
        : typeof voiceSends?.delay === 'number' ? voiceSends.delay
          : mixFor(name).delay;
      graph.tracks[name].reverbSend.gain.setTargetAtTime(reverb, time, constant);
      graph.tracks[name].delaySend.gain.setTargetAtTime(delay, time, constant);
    }
  }

  // -- reverb tail (v21) -----------------------------------------------------

  /**
   * The tail actually built: what the user asked for, capped by whatever the
   * power governor's tier allows. The two COMPOSE rather than override — an eco
   * tier shortens a 6 s hall to 1 s, and going back to full restores the 6 s
   * without the user touching the dial.
   */
  function effectiveReverbSeconds() {
    return clamp(Math.min(params.reverbTail, reverbBudget),
      REVERB_TAIL_RANGE[0], REVERB_TAIL_RANGE[1]);
  }

  /**
   * Rebuild the impulse response for the current effective tail, if it differs
   * from the one already live or in flight.
   *
   * The build is deferred by a macrotask rather than run here: an IR is
   * sampleRate × seconds × 2 samples of noise to generate, and the callers are
   * a parameter edit and a governor tier change — neither of which can afford
   * to block, and the second of which arrives on the frame-timing path the
   * governor is trying to protect. Nothing is disturbed while it runs: the old
   * convolver keeps rendering until the new one has crossfaded in.
   */
  function ensureReverbTail() {
    if (!ctx || !graph) return;
    const wanted = effectiveReverbSeconds();
    if (reverbTarget !== null && Math.abs(wanted - reverbTarget) < 1e-6) return;
    reverbTarget = wanted;
    if (reverbBuildTimer !== null) clearTimeout(reverbBuildTimer);
    reverbBuildTimer = setTimeout(() => {
      reverbBuildTimer = null;
      if (!ctx || !graph || reverbTarget === null) return;
      const seconds = reverbTarget;
      swapReverb(createImpulseResponse(ctx, seconds, REVERB_DECAY), seconds);
    }, 0);
  }

  /**
   * Crossfade the reverb return from the live convolver to a new one over
   * REVERB_CROSSFADE seconds. Both hang off the same send bus for the duration,
   * so the tail changes character without the sends ever passing through
   * silence — swapping `convolver.buffer` in place, by contrast, cuts whatever
   * is ringing dead.
   */
  function swapReverb(buffer, seconds) {
    endReverbFade();      // a change mid-crossfade lands the previous one first
    const next = ctx.createConvolver();
    next.normalize = true;
    next.buffer = buffer;
    const nextReturn = ctx.createGain();
    nextReturn.gain.value = 0;
    next.connect(nextReturn);
    nextReturn.connect(graph.master);
    graph.reverbBus.connect(next);

    const time = ctx.currentTime;
    const previous = graph.reverbReturn;
    const level = REVERB_RETURN_LEVEL;
    nextReturn.gain.setValueAtTime(0, time);
    nextReturn.gain.linearRampToValueAtTime(level, time + REVERB_CROSSFADE);
    previous.gain.cancelScheduledValues(time);
    previous.gain.setValueAtTime(previous.gain.value, time);
    // Linear, not exponential: this ramp ends at true zero, which an
    // exponential one cannot reach.
    previous.gain.linearRampToValueAtTime(0, time + REVERB_CROSSFADE);

    reverbFade = { convolver: graph.convolver, ret: previous };
    graph.convolver = next;
    graph.reverbReturn = nextReturn;
    graph.reverbSeconds = seconds;
    reverbFadeTimer = setTimeout(endReverbFade, REVERB_CROSSFADE * 1000);
  }

  /**
   * Unwire the outgoing tail once it is silent. Called early only by a second
   * swap, whose own fade then starts from the same silence — so an early call
   * is never audible either.
   */
  function endReverbFade() {
    if (reverbFadeTimer !== null) {
      clearTimeout(reverbFadeTimer);
      reverbFadeTimer = null;
    }
    if (!reverbFade) return;
    const { convolver, ret } = reverbFade;
    reverbFade = null;
    try { graph?.reverbBus.disconnect(convolver); } catch { /* already gone */ }
    try { convolver.disconnect(); } catch { /* already gone */ }
    try { ret.disconnect(); } catch { /* already gone */ }
  }

  /** Forget every reverb node — the context that owned them has gone. */
  function resetReverbState() {
    if (reverbBuildTimer !== null) clearTimeout(reverbBuildTimer);
    if (reverbFadeTimer !== null) clearTimeout(reverbFadeTimer);
    reverbBuildTimer = null;
    reverbFadeTimer = null;
    reverbFade = null;
    reverbTarget = null;
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
    for (const name of trackOrder()) {
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
    monoNotes.clear();
  }

  /** Whether a track still has a note ringing (tail included) at `at`. */
  function hasSoundingNotes(track, at) {
    for (const entry of liveNotes) {
      if (entry.track === track && entry.end > at) return true;
    }
    return false;
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

  /** Whether a track sounds one note at a time (v12). */
  const isMono = (track) => params.tracks[track].mono === true;

  /** A track's portamento, in seconds: the 0–1 param across GLIDE_RANGE. */
  function glideSeconds(track) {
    const amount = clamp(Number(params.tracks[track].glide) || 0, 0, 1);
    return GLIDE_RANGE[0] + (GLIDE_RANGE[1] - GLIDE_RANGE[0]) * amount;
  }

  /**
   * Release the note a mono track is replacing, AT the new onset rather than
   * now: the lookahead schedules a bar before it sounds, so cancelling on the
   * spot would leave a hole where the rest of the previous note should be.
   */
  function releaseMono(previous, at) {
    // Same trim as a legato handover: the note stops here, whatever span it
    // was scheduled with.
    if (previous.note) {
      previous.note.duration = Math.max(0.02, at - previous.note.when);
    }
    if (previous.handle) {
      try {
        previous.handle.cancel(at);
      } catch {
        // A note that will not cancel is still just one note.
      }
    }
    liveNotes.delete(previous.entry);
  }

  function playNote(track, note) {
    const midi = note.midi ?? null;
    // Timing humanisation moves a note off its grid position in both
    // directions, and a note belongs to the bar it was planned in, so it is
    // held inside that bar at both ends. Behind: a note dragged back over the
    // barline would land in a bar the scheduler has already dispatched. Ahead:
    // a note on the bar's last subdivision, pushed forward, sounds in the NEXT
    // bar — which is inaudible in the middle of a piece and is exactly wrong at
    // the end of one, where the bar that follows is the resolving closing bar
    // and nothing but pad and bass belongs in it. The lookahead itself needs no
    // clamp — the spread (±25 ms) is a fifth of LOOKAHEAD, so a nudge can never
    // reach behind the horizon the pulse was scheduled in.
    const wanted = Number.isFinite(note.when) ? note.when : (ctx ? ctx.currentTime : 0);
    const floor = currentBarTime;
    // A hair inside the barline, not on it: a note landing exactly on the next
    // downbeat is that bar's note as far as anything reading the stream knows.
    const ceiling = bar ? floor + bar.duration - 1e-4 : Infinity;
    const full = {
      midi,
      freq: note.freq ?? (midi === null ? null : midiToFreq(midi)),
      velocity: clamp(Number(note.velocity) || 0.7, 0.01, 1),
      duration: Math.max(0.02, Number(note.duration) || 0.3),
      when: clamp(wanted, floor, Math.max(floor, ceiling)),
      pan: clamp(Number(note.pan) || 0, -1, 1),
      kind: note.kind ?? null,
      // v21: which lane of the kit struck this. Null for every melodic track,
      // and equal to `kind` for the three built-in drum lanes.
      lane: note.lane ?? null,
    };
    const voice = voiceFor(track);
    if (voice) {
      stealForBudget(full.when);
      // v12 mono: one sounding note per track. The note in progress is offered
      // to the voice as `legatoFrom` — a sustaining voice slurs into it and
      // says so, anything else re-strikes and the engine releases the old note
      // at the new onset. Either way the track never stacks.
      const mono = midi !== null && isMono(track);
      const previous = mono ? monoNotes.get(track) : null;
      const reachable = previous && previous.until >= full.when - 1e-6
        && previous.voice === effectiveVoice(track);
      if (reachable) {
        full.legatoFrom = {
          freq: previous.freq,
          handle: previous.handle,
          glide: glideSeconds(track),
        };
      }
      try {
        const handle = voice.play(ctx, graph.tracks[track].input, full,
          patchFor(track, full.lane ?? full.kind));
        const cancellable = handle && typeof handle.cancel === 'function' ? handle : null;
        pruneLiveNotes();
        if (reachable && handle && handle.legato === true) {
          // The voice took the sounding note over: nothing was born, so the
          // note already on the books simply rings on at the new pitch.
          previous.entry.until = full.when + full.duration;
          previous.entry.end = previous.entry.until + CANCEL_TAIL;
          previous.entry.velocity = full.velocity;
          previous.entry.handle = cancellable ?? previous.entry.handle;
          previous.handle = previous.entry.handle;
          previous.freq = full.freq;
          previous.until = previous.entry.until;
          liveNotes.add(previous.entry);
          // The note that was sounding is over AS A NOTE at the handover, even
          // though the sound carries on: trimming the span it was scheduled
          // with keeps anything counting concurrent notes (the power budget's
          // ledger, the cost meters) honest about a mono track sounding one.
          previous.note.duration = Math.max(0.02, full.when - previous.note.when);
          previous.note = full;
        } else {
          if (previous) releaseMono(previous, full.when);
          // Every note is booked, handle or not: the cost meters count them
          // all. A handle also lets stop() and the power budget hard-stop the
          // note — a suspended context would otherwise freeze its tail, which
          // resurrects, possibly in an old key, on the next start().
          const entry = {
            track,
            handle: cancellable,
            velocity: full.velocity,
            when: full.when,
            until: full.when + full.duration,
            end: full.when + full.duration + CANCEL_TAIL,
          };
          liveNotes.add(entry);
          if (mono) {
            monoNotes.set(track, {
              entry,
              note: full,
              handle: cancellable,
              freq: full.freq,
              until: entry.until,
              voice: effectiveVoice(track),
            });
          }
        }
      } catch {
        // A broken voice loses its note, not the whole performance.
      }
    }
    recordNote(track, full.when);
    if (full.when + full.duration > lastNoteEnd) lastNoteEnd = full.when + full.duration;
    const event = {
      track,
      midi: full.midi,
      kind: full.kind,
      lane: full.lane,
      velocity: full.velocity,
      time: full.when,
      duration: full.duration,
    };
    // The motif-derivation flag rides on the notes it describes, which is the
    // only place outside the engine it could honestly be observed.
    if (typeof note.motif === 'boolean') event.motif = note.motif;
    emit('note', event);
  }

  // -- harmony: the hook -----------------------------------------------------

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
    hookBank.clear();
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
    hookBank.store(hookKey(hook), hook, hookStable + (hot ? 2 : 0));
  }

  /**
   * Bring a banked variant back. Salience is the base weight; section intensity
   * tilts the draw towards the busier, more extended variants as the piece
   * lifts, and back towards the plain ones as it settles. A recall of what is
   * already playing is not a return, so the current variant is never a
   * candidate: an empty field means no recall this pass.
   */
  function recallHook(intensity) {
    const chosen = hookBank.recall(hookKey(hook), (entry) => (
      0.5 + entry.salience * 0.25 + (intensity - 0.5) * 2 * hookEnergy(entry.variant)
    ), rng);
    if (!chosen) return false;
    hook = cloneHook(chosen.variant);
    hookStable = 0;
    // Joint recall (v12): a motif banked against this exact hook variant comes
    // back with it, so the tune and the chords that carried it return together
    // rather than as two unrelated returns. The melody adopts it at its next
    // phrase boundary — mid-phrase would break the cell it is in the middle of.
    const paired = motifBank.find((entry) => entry.hookKey === chosen.key);
    if (paired) motifPending = cloneMotif(paired.variant);
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
   * How many bars the chord starting now holds (v21). 'auto' is the original
   * draw — two bars the more often the more repetition was asked for — and a
   * fixed harmony.rhythm is taken at its word, which is what makes the hook's
   * pass length its chord count times this.
   */
  function chordSpanBars() {
    const rhythm = params.harmony.rhythm;
    if (rhythm !== 'auto') return rhythm;
    return rng() < 0.5 + params.repetition * 0.2 ? 2 : 1;
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

  // -- the melody's motif ----------------------------------------------------

  /** Write a fresh cell for the section that is starting. */
  function establishMotif() {
    motif = buildMotif({
      beatsPerBar: beatsPerBar(params.timeSignature),
      complexity: params.complexity,
      scaleLength: scale().length,
      rng,
    });
    motifSalience = 0;
  }

  function adoptMotif(cell) {
    motif = cloneMotif(cell);
    motifSalience = 0;
  }

  /**
   * Keep the cell that is playing, ranked the way a hook variant is: phrases
   * survived, plus a bonus for having carried a hot section. The hook variant
   * it was heard against rides along, which is what lets a hook recall bring
   * its tune back with it.
   */
  function bankMotif(intensity) {
    if (!motif) return;
    const hot = intensity >= HOOK_HOT_INTENSITY;
    if (motifPhrase % HOOK_SNAPSHOT_EVERY !== 0 && motifSalience < HOOK_STABLE_TO_BANK && !hot) return;
    motifBank.store(motifKey(motif), motif, motifSalience + (hot ? 2 : 0), {
      hookKey: hook ? hookKey(hook) : '',
    });
  }

  /** Bring a banked cell back, favouring the busy ones as the piece lifts. */
  function recallMotif(intensity) {
    const chosen = motifBank.recall(motif ? motifKey(motif) : '', (entry) => (
      0.5 + entry.salience * 0.25 + (intensity - 0.5) * entry.variant.steps.length * 0.2
    ), rng);
    if (!chosen) return false;
    adoptMotif(chosen.variant);
    return true;
  }

  /**
   * End of a phrase: bank what deserves it, then decide what the next phrase
   * sings — the tune a hook recall asked for, a new cell for a new section, or
   * the same cell again. At most one of those, so the melody never changes
   * identity twice in a row.
   */
  function completeMelodyPhrase(intensity) {
    motifPhrase += 1;
    bankMotif(intensity);
    if (motifPending) {
      adoptMotif(motifPending);
      motifPending = null;
      motifSectionPending = false;
      return;
    }
    if (motifSectionPending) {
      motifSectionPending = false;
      // A section wants its own idea: a banked one if the ear has heard it
      // before, otherwise something new.
      if (!(rng() < params.repetition && recallMotif(intensity))) establishMotif();
      return;
    }
    motifSalience += 1;
  }

  /**
   * The phrase clock, stepped once a bar. An 'off' melody costs nothing: no
   * cell, no draws, no development running silently in the background.
   */
  function advanceMelodyPhrase(intensity) {
    if (params.tracks.melody.state === 'off') return;
    if (!motif) {
      establishMotif();
      phraseBar = 0;
      return;
    }
    // A held melody loops the phrase it is on rather than moving the cell on.
    if (held.has('melody')) {
      phraseBar = (phraseBar + 1) % PHRASE_BARS;
      return;
    }
    phraseBar += 1;
    if (phraseBar >= PHRASE_BARS) {
      phraseBar = 0;
      completeMelodyPhrase(intensity);
    }
  }

  /**
   * Publish the chord the bar is built on (v14), for the visualiser's bar
   * labels. The midis are the pad's own voicing so the label names what is
   * actually sounding, and the name is derived from those semitones rather
   * than from the degree the stack was built from.
   */
  function emitChord(barNumber, time) {
    const midis = chordMidis(3, colour() > 0.5 ? 4 : 3);
    if (!midis.length) return;
    const rootMidi = scaleDegreeToMidi(chordDegree, scale(), pitchClass(params.root), 3);
    emit('chord', {
      name: nameChord(rootMidi % 12, midis.map((midi) => midi - rootMidi)),
      midis,
      bar: barNumber,
      time,
    });
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
      // Rests thin out as the section lifts; re-attacks do the opposite. Both
      // draws are made whatever the spread is, but at randomness 0 — the hold
      // position of the dial — the pad simply keeps playing what it played.
      rest: rng() < (PAD_REST_BASE + spread * PAD_REST_SPAN) * (1 - intensity) && spread > 0,
      reattack: rng() < (PAD_REATTACK_BASE + spread * PAD_REATTACK_SPAN) * (0.5 + intensity)
        && spread > 0,
      // A smooth contour rather than a per-bar draw: the pad swells and settles
      // over four bars, as deep as padBreath asks and only as far as the
      // section's intensity carries it. padBreath 0 is a flat sustain.
      swell: 1 + Math.sin(padSwellPhase * Math.PI * 2) * params.padBreath * intensity,
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

  // -- the silence floor -----------------------------------------------------

  // Bars 0–4 belong to the staged entry; the floor takes over after it. Read
  // through stageBars() at each bar rather than captured here: a track added
  // or removed while the piece plays lengthens or shortens the entry, and a
  // value captured at closure build would be stale from that moment on.

  /** One bar of breath is music; two in a row is the defect. */
  const SILENCE_TOLERANCE_BARS = 1;

  /** A gap is covered by the wash first, then the chord, then whatever plays. */
  const COVER_ORDER = Object.freeze(['texture', 'pad', 'arp', 'melody', 'bass', 'percussion']);

  /**
   * Whether the bar starting at `time` will be heard at all: something already
   * sounding rings through at least its first quarter, or one of the plans
   * just realised has a note in it.
   */
  function barWillSound(time) {
    if (lastNoteEnd > time + bar.duration * 0.25) return true;
    return Boolean(melodyPlan.notes.length || texturePlan.length
      || (arpPlan && arpPlan.steps.length) || percussionPlan.length);
  }

  /**
   * The tracks that could cover a silent bar. A track the user is sequencing
   * by hand is never one of them: a grid of steps at probability 0 is silence
   * somebody ASKED for, and the floor exists to catch the silence nobody did.
   */
  function coverCandidates() {
    return COVER_ORDER.filter((name) => params.tracks[name].state !== 'off'
      && currentBarNumber >= stageIndexOf(name)
      && !isManual(name));
  }

  /** A cover note: soft, on the chord, and drawn from no randomness at all. */
  function playCover(track, time) {
    const rootPc = pitchClass(params.root);
    if (track === 'pad') {
      // The pad's own voicing, a shade under its usual level — the rest it was
      // taking becomes a quieter re-entry rather than a hole.
      attackChord(time, bar.duration * (Math.max(0, chordBarsLeft) + 1), {
        maxNotes: 3,
        jitters: [1, 1, 1, 1, 1],
        nudges: [0, 0, 0, 0, 0],
        pans: [0, 0, 0, 0, 0],
        swell: 1,
      }, 0.8);
      return;
    }
    if (track === 'percussion') {
      playNote('percussion', {
        midi: null, freq: null, kind: 'low', lane: laneForKind('low'),
        when: time, duration: 0.4, velocity: 0.45,
      });
      return;
    }
    const octave = track === 'texture' ? 6 : track === 'bass' ? 2 : 4;
    const midi = scaleDegreeToMidi(chordDegree, scale(), rootPc, octave);
    playNote(track, {
      midi,
      when: time,
      duration: bar.duration * (track === 'texture' ? 1.5 : 0.9),
      velocity: track === 'texture' ? 0.32 : track === 'bass' ? 0.6 : 0.4,
      pan: 0,
    });
  }

  /**
   * The floor itself, run once every bar after the staged entry: if nothing at
   * all would be heard, something is made to play. A piece with only ONE track
   * in it keeps a single bar of breath (SILENCE_TOLERANCE_BARS), because with
   * nothing else playing that breath IS the piece — a solo pad or a solo
   * melody must still be allowed to phrase. The moment a second track exists
   * it covers the gap instead, and the piece never falls silent at all.
   */
  function coverSilence(time) {
    if (currentBarNumber < stageBars() || outroStarted) return;
    // Which track (if any) covers this bar is a decision like any other: a
    // repeat that covered a gap on its first traversal covers it every pass.
    const cover = once('cover', () => {
      if (barWillSound(time)) {
        silentRun = 0;
        return null;
      }
      silentRun += 1;
      const candidates = coverCandidates();
      const chosen = candidates[0];
      if (!chosen) return null;
      if (candidates.length < 2 && silentRun <= SILENCE_TOLERANCE_BARS) return null;
      silentRun = 0;
      return chosen;
    });
    if (!cover) return;
    promoted.add(cover);
    // The promoted track may have been muted a moment ago; open its gain from
    // the note's own onset so the cover is actually audible.
    applyTracks(0.15, time);
    playCover(cover, time);
  }

  /**
   * A beat position as the swung bar reads it (v14), in the feel of the track
   * asking (v21). Without a track it is the global amount — what the bar as a
   * whole is swung by.
   */
  const swung = (beat, track = null) => swungBeat(
    beat, SWING_UNIT, track === null ? bar.swing : bar.swings[track] ?? bar.swing,
  );

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
    const sounded = new Map();
    let steps = [];
    for (let i = 0; i < slots; i++) {
      const step = lane[i];
      if (!step.on) continue;
      const prob = groupedProb(sounded, step, effectiveProb('bass', `step.${i}`, step.prob));
      const fires = rng() < prob;
      if (step.group !== undefined) sounded.set(step.group, fires);
      if (!fires) continue;
      const beat = i / 4;
      steps.push({
        index: i,
        beat,
        fifth: !isStrongBeat(beat) && rng() < 0.35,
        // v21: undefined here means "ring until the next step", the length
        // every manual bass grid before it had.
        gate: step.gate,
        velocity: between(step.vmin, step.vmax, rng) * velocityJitter('bass'),
        nudge: bassPocketFor(),
      });
    }
    steps = mergeTies(steps, lane, slots);
    return { manual: true, steps };
  }

  /**
   * The bass's pocket: how far behind the grid the whole line sits, in seconds
   * (v24). One constant per section, NOT a per-note draw — the generic timing
   * humanisation every other track uses scatters a note either side of the beat
   * independently, and a bass scattered that way reads as unsteady rather than
   * deep. An auto line takes the groove's own pocket; a manual grid, which has
   * no groove, draws its own on the same terms.
   */
  function bassPocketFor() {
    if (bassPocket === null) bassPocket = bassPocketSeconds(varyAmount('bass', 'timing'), rng);
    return bassPocket;
  }

  /**
   * The bass's groove for the section it is in (v14, replacing the v12
   * pattern). Drawn ONCE per section: a bass line that re-rolls its rhythm
   * every bar is a random walk, not a groove. Every felt pulse it plays on
   * takes the root — the v8 harmonic contract — and the fifth and the octave
   * are only ever allowed between the pulses.
   *
   * When percussion is playing, the groove is handed the low lane's onsets
   * from the bar just gone and locks onto them where it can.
   *
   * v24: the key BANDS the section intensity instead of reading it to three
   * decimals. `waves` and `build` hand out a fresh intensity for every bar (a
   * cosine and a ramp), so a three-decimal key re-rolled the groove bar by bar
   * under both of them — which is to say the v14 groove never engaged at all
   * for two of the five structure presets, and the user's "low-pitch random"
   * verdict was literally correct there. A quarter-wide band re-states the line
   * when the section's energy has actually moved, and holds it in between.
   */
  function ensureBassGroove() {
    const key = [
      currentSection.label, bassIntensityBand(), params.timeSignature,
      round3(params.complexity), round3(trackDensity('bass')),
    ].join(':');
    if (bassGroove && bassGrooveKey === key) return bassGroove;
    // The four- and eight-bar counts the groove is developed against belong to
    // the SECTION, not to one statement of the line: a swell that restates the
    // groove mid-section must not also restart the turnaround clock, or a
    // modulating structure would never reach a fill.
    if (!bassGrooveKey.startsWith(`${currentSection.label}:`)) {
      bassGrooveBar = 0;
      bassGrooveOpLast = 'state';
    }
    bassGrooveKey = key;
    bassGroove = buildBassGroove({
      starts: bar.starts,
      beats: bar.beats,
      intensity: sectionIntensity(),
      complexity: params.complexity,
      lowLane: percussionLowBeats(),
      densityScale: trackDensity('bass'),
      timingVary: varyAmount('bass', 'timing'),
      rng,
    });
    bassPocket = bassGroove.pocket;
    return bassGroove;
  }

  /** The section's energy, to the nearest quarter — the groove's own resolution. */
  function bassIntensityBand() {
    return Math.round(clamp(sectionIntensity(), 0, 1) * 4) / 4;
  }

  /** Where percussion's low lane last landed, in beats — the groove's anchor grid. */
  function percussionLowBeats() {
    if (!isActive('percussion') || !percussionPlan.length) return null;
    const beats = [];
    for (const hit of percussionPlan) {
      if (hit.kind !== 'low') continue;
      beats.push((bar.starts[hit.pulse] ?? 0) + (hit.offset ?? 0));
    }
    return beats.length ? beats : null;
  }

  function planBass() {
    if (isManual('bass')) return planBassManual();
    const groove = ensureBassGroove();
    // The groove is stated, then developed — the same relationship the melody
    // has with its motif. randomness 0 states it every bar and draws nothing.
    const op = bassGrooveOp(bassGrooveBar, trackRandomness('bass'), rng,
      bassGrooveOpLast, sectionIntensity());
    bassGrooveOpLast = op;
    const shape = op === 'state' ? groove
      : developBassGroove(groove, op, { starts: bar.starts, rng });
    const pocket = bassPocketFor();
    return {
      manual: false,
      op,
      steps: shape.steps.map((step) => ({
        beat: step.beat,
        tone: step.tone,
        // The gate is what makes it sound played rather than held: a staccato
        // groove leaves air between its notes, a sustained one does not.
        gate: step.gate ?? 0.9,
        ghost: step.ghost === true,
        fill: step.fill === true,
        velocity: clamp(
          (step.ghost ? BASS_VELOCITIES.ghost
            : step.accent ? BASS_VELOCITIES.accent
              : step.fill ? BASS_VELOCITIES.fill
                : step.tone === 'root' ? BASS_VELOCITIES.pulse : BASS_VELOCITIES.offbeat)
          * velocityJitter('bass'),
          0.05, 1,
        ),
        // Every note of the line leans back by the same amount: the pocket is
        // the groove's, not the note's.
        nudge: pocket,
      })),
    };
  }

  /**
   * The chord the hook turns to next, or null at a pass boundary where a
   * mutation or a recall may still rewrite it. Only a known next chord earns
   * an approach note: a leading tone into the wrong chord is a wrong note.
   */
  function nextChordAhead() {
    if (!hook || hookFresh) return null;
    const at = hookIndex + 1;
    if (at >= hook.degrees.length) return null;
    const n = scale().length;
    return ((hook.degrees[at] % n) + n) % n;
  }

  function scheduleBass(time, barDuration, plan) {
    const rootPc = pitchClass(params.root);
    const root = scaleDegreeToMidi(chordDegree, scale(), rootPc, 2);
    // A perfect fifth above the root, NOT the scale's fifth degree: in a
    // pentatonic or whole-tone mode the fifth degree is not seven semitones up,
    // and what a bass line wants under a chord is the chord's own fifth
    // reinforcing the root, not a melodic scale tone.
    const fifth = root + 7;
    if (plan.manual) {
      plan.steps.forEach((step, i) => {
        // A step rings until the next one, so a sparse grid still sustains —
        // unless the step names its own gate, which is the length outright.
        const next = i + 1 < plan.steps.length ? plan.steps[i + 1].beat : bar.beats;
        const at = swung(step.beat, 'bass');
        const gated = step.gate !== undefined
          ? gatedSpan(step, step.gate, SEQUENCER_STEP_BEATS) * bar.secPerBeat
          : (swung(next, 'bass') - at) * bar.secPerBeat * 0.9;
        playNote('bass', {
          midi: step.fifth ? fifth : root,
          when: time + at * bar.secPerBeat + step.nudge,
          duration: Math.max(0.08, gated),
          velocity: step.velocity,
        });
      });
      return;
    }

    // v24: the octave pop keeps the line in the bass's own register. Off a high
    // chord root, root + 12 lands in the tune's octave and stops reading as a
    // bass at all, so it drops instead — and if THAT is below the bottom of the
    // range it stays on the root, which is always in it.
    const octave = root + 12 <= BASS_RANGE.high ? root + 12
      : root - 12 >= BASS_RANGE.low ? root - 12 : root;
    const midiOf = (tone) => (tone === 'fifth' ? fifth : tone === 'octave' ? octave : root);
    const events = plan.steps.map((step) => ({ ...step, midi: midiOf(step.tone) }));

    // The approach: on a bar that turns to a new chord, the last off-beat note
    // leans towards where the harmony is going — the chord tone available here
    // that is nearest the root the next bar lands on. It RE-PITCHES a note the
    // pattern was already going to play rather than adding one, so the section
    // keeps its rhythm, and it only ever takes an off-beat, so every felt pulse
    // still voices the root.
    const last = events[events.length - 1];
    const target = chordBarsLeft <= 0 && last && !isStrongBeat(last.beat)
      ? nextChordAhead() : null;
    if (target !== null) {
      const to = scaleDegreeToMidi(target, scale(), rootPc, 2);
      const options = [root, fifth, octave];
      last.midi = options.reduce(
        (best, midi) => (Math.abs(midi - to) < Math.abs(best - to) ? midi : best),
      );
    }

    // A held step slurs into the next one on a mono track; anything shorter
    // stops where its gate says and leaves the gap the groove asked for.
    const legato = params.tracks.bass.mono ? 1.02 : 0.95;
    events.forEach((event, i) => {
      const next = i + 1 < events.length ? events[i + 1].beat : bar.beats;
      const gate = clamp(event.gate ?? 0.9, 0.12, 1);
      const at = swung(event.beat, 'bass');
      const span = (swung(next, 'bass') - at) * bar.secPerBeat;
      // The floor is the shortest note worth playing, NOT a flat 0.1 s: a fixed
      // floor is longer than a clipped sixteenth at anything above a slow tempo,
      // so every short note in the line came out the same length whatever its
      // gate said, and the staccato/held mix the groove had chosen never reached
      // the ear. Capped at the span so it can never stretch a note past its slot.
      const floor = Math.min(BASS_MIN_NOTE, span * 0.6);
      playNote('bass', {
        midi: event.midi,
        when: time + at * bar.secPerBeat + event.nudge,
        duration: Math.max(floor, span * (gate >= 0.95 ? legato : gate)),
        velocity: event.velocity,
      });
    });
    if (!events.length) {
      // A pattern that emptied itself still owes the bar its root — in the
      // line's own pocket, like every other note it plays.
      playNote('bass', {
        midi: root,
        when: time + bassPocketFor(),
        duration: barDuration * 0.95,
        velocity: 0.8,
      });
    }
  }

  /**
   * The degrees a manual grid draws on: this bar's development of the cell, so
   * a user-sequenced rhythm still hears the tune argue with itself. A melody
   * with no cell yet falls back to the chord tones — the grid is about rhythm,
   * so it must never run out of notes to place.
   */
  function manualDegrees() {
    if (!motif || !motif.steps.length) return [0, 2, 4];
    return developMotif(motif, phraseOp(), {
      beatsPerBar: beatsPerBar(params.timeSignature),
      scaleLength: scale().length,
      rng,
    }).steps;
  }

  /** Manual melody: the grid gates when, the motif still supplies the pitches. */
  function planMelodyManual() {
    const lane = sequencerFor('melody').steps;
    const slots = sequencerStepsPerBar(params.timeSignature);
    const degrees = manualDegrees();
    const sounded = new Map();
    let notes = [];
    let taken = 0;
    for (let i = 0; i < slots; i++) {
      const step = lane[i];
      if (!step.on) continue;
      const prob = groupedProb(sounded, step, effectiveProb('melody', `step.${i}`, step.prob));
      const fires = rng() < prob;
      if (step.group !== undefined) sounded.set(step.group, fires);
      if (!fires) continue;
      const stray = dissonanceDraw('melody');
      const degree = degrees[taken++ % degrees.length];
      notes.push({
        index: i,
        beat: i / 4,
        degree: stray && !stray.chromatic ? degree + stray.dir : degree,
        bend: stray && stray.chromatic ? stray.dir : 0,
        duration: 1,
        gate: step.gate,
        velocity: between(step.vmin, step.vmax, rng) * velocityJitter('melody'),
        pan: between(-0.25, 0.25, rng) + panSpread('melody'),
        octave: octaveWander('melody'),
        nudge: timingNudge('melody'),
      });
    }
    notes = mergeTies(notes, lane, slots);
    for (const note of notes) {
      // A gated step is exactly as long as it says: the tie has already merged
      // the slots, and the gate scales the span they add up to. Without one, a
      // tied note is one note over both slots and lasts as long as it spans.
      if (note.gate !== undefined) {
        note.duration = gatedSpan(note, note.gate, SEQUENCER_STEP_BEATS);
      } else if (note.slots > 1) {
        note.duration = Math.max(note.duration, note.slots * SEQUENCER_STEP_BEATS);
      }
    }
    // The cadence rule applies whoever owns the rhythm: the last note of a
    // phrase, or of a section, lands on a chord tone.
    const last = notes[notes.length - 1];
    if (last && (phraseBar === PHRASE_BARS - 1 || sectionEndsThisBar())) {
      last.degree = nearestChordTone(last.degree, scale().length);
      last.octave = 0;
    }
    // The pitches came off the cell even though the rhythm is the user's grid.
    return { motifDerived: Boolean(motif) && notes.length > 0, notes };
  }

  /**
   * Which development this bar of the phrase states. Bar 0 is always the
   * statement — a listener cannot learn a cell that never comes back plain —
   * and the last bar of a phrase stays close to it so the cadence is
   * recognisable. The middle is where the piece argues with itself, and
   * repetition decides how hard.
   */
  function phraseOp() {
    if (phraseBar === 0) return 'repeat';
    const wander = 1 - params.repetition;
    if (phraseBar === PHRASE_BARS - 1) return rng() < 0.55 + params.repetition * 0.3 ? 'repeat' : 'transpose';
    const weights = [
      ['repeat', 0.5 + params.repetition * 0.9],
      ['transpose', 1.1],
      ['displace', 0.3 + wander * 0.5],
      ['invert', (0.12 + wander * 0.5) * (0.4 + params.complexity)],
      ['retrograde', (0.1 + wander * 0.45) * (0.4 + params.complexity)],
    ];
    const total = weights.reduce((sum, [, weight]) => sum + weight, 0);
    let r = rng() * total;
    for (const [op, weight] of weights) {
      r -= weight;
      if (r <= 0) return op;
    }
    return 'repeat';
  }

  /** Whether the bar being planned is the last of its section. */
  function sectionEndsThisBar() {
    const preset = resolveStructure(params.structure, params.complexity, params.customStructure);
    const next = sectionAtBar(preset, structureBar + 1, params.customStructure);
    return next.label !== currentSection.label;
  }

  const emptyMelodyPlan = () => ({ motifDerived: false, notes: [] });

  /**
   * Call and response (v14): every other phrase, the bar that answers the
   * statement is played by ANOTHER instrument — the same cell, the same
   * rhythm, a different voice, so the tune sounds like two players trading
   * rather than one player talking. Deliberately subtle: one bar in eight, and
   * only in auto, with both instruments already sounding and neither being
   * hand-sequenced (a user's own grid is not the engine's to reassign).
   */
  function responderTrack() {
    if (params.tracks.melody.state !== 'auto' || !isActive('melody') || isManual('melody')) return null;
    if (phraseBar !== PHRASE_BARS - 1 || motifPhrase % 2 === 0) return null;
    if (params.tracks.arp.state === 'off' || !isActive('arp') || isManual('arp')) return null;
    return 'arp';
  }

  /**
   * One octave transposition for the WHOLE bar, chosen so the cell sits inside
   * the register band. Folding note by note would keep every note in range and
   * destroy the tune doing it: a rising cell whose top note wrapped would come
   * out as a rising pair and a plunge. Moving the cell bodily keeps its
   * contour, which is the half of a motif an ear actually remembers.
   */
  function melodyOctave(plan) {
    if (!plan.notes.length) return 0;
    const centre = scaleDegreeToMidi(0, bar.scale, bar.rootPc, 4);
    let lo = Infinity;
    let hi = -Infinity;
    for (const note of plan.notes) {
      const midi = scaleDegreeToMidi(chordDegree + note.degree, bar.scale, bar.rootPc, 4);
      if (midi < lo) lo = midi;
      if (midi > hi) hi = midi;
    }
    let best = 0;
    let cost = Infinity;
    for (let shift = -3; shift <= 3; shift++) {
      // How far outside the band the cell would hang, either end.
      const over = Math.max(0, centre - MELODY_BAND - (lo + shift * 12))
        + Math.max(0, (hi + shift * 12) - centre - MELODY_BAND);
      // Ties go to the smaller move, and to staying put over moving at all.
      if (over < cost || (over === cost && Math.abs(shift) < Math.abs(best))) {
        cost = over;
        best = shift;
      }
    }
    return best;
  }

  /**
   * One bar of the melody: a development of the cell, with its own breathing.
   * Degrees stay RELATIVE to the chord, so a held bar keeps tracking the hook
   * and a transposition genuinely lands on the chord under it.
   */
  function planMelody(intensity) {
    if (isManual('melody')) return planMelodyManual();
    if (!motif) return emptyMelodyPlan();
    const barBeats = beatsPerBar(params.timeSignature);
    const scaleLength = scale().length;
    const op = phraseOp();
    const spread = trackRandomness('melody');
    // v21 density thins or thickens the line the only two ways a motif can
    // stand: bars it sits out, and ornaments over the bars it plays.
    const density = trackDensity('melody');
    // Phrase breathing: a bar the melody sits out. Only ever mid-phrase — the
    // statement and the cadence are the two bars the phrase is made of.
    const resting = phraseBar > 0 && phraseBar < PHRASE_BARS - 1
      && rng() < clamp((0.1 + spread * 0.18) * (1 - intensity * 0.6) / Math.max(density, 0.05), 0, 1)
      && spread > 0;
    if (resting) return emptyMelodyPlan();

    const cell = developMotif(motif, op, { beatsPerBar: barBeats, scaleLength, rng });
    // A calm section shortens the cell from its tail rather than punching holes
    // through it: the head of a motif is what makes the motif recognisable.
    const keep = intensity >= 0.5 || cell.beats.length <= 3
      ? cell.beats.length
      : cell.beats.length - 1;
    const cadence = phraseBar === PHRASE_BARS - 1 || sectionEndsThisBar();
    // At randomness 0 the bar is a hold: the cell is stated undecorated.
    const ornamentChance = spread > 0
      ? clamp(params.complexity * 0.3 * (0.4 + spread) * density, 0, 1) : 0;
    // vary.pitch moves the WHOLE cell an octave, once per bar, never one note
    // of it: a register jump inside a motif is heard as a wrong note, because
    // the contour is most of what the ear is holding on to.
    const octave = octaveWander('melody');

    const notes = [];
    for (let i = 0; i < keep; i++) {
      const beat = cell.beats[i];
      const last = i === keep - 1;
      // A cadence lands on a chord tone: that is what makes an ending sound
      // like one, whether it ends a phrase or a section.
      const degree = last && cadence ? nearestChordTone(cell.steps[i], scaleLength) : cell.steps[i];
      const room = i === 0 ? beat : beat - cell.beats[i - 1];
      if (i > 0 && room >= 0.5 && rng() < ornamentChance) {
        // A grace note leaning into the beat. Ornament, not motif: it decorates
        // the cell without displacing any of it.
        notes.push({
          beat: beat - 0.25,
          degree: degree + (rng() < 0.5 ? -1 : 1),
          duration: 0.25,
          velocity: 0.4 * velocityJitter('melody'),
          pan: between(-0.25, 0.25, rng) + panSpread('melody'),
          octave: 0,
          nudge: timingNudge('melody'),
        });
      }
      // Dissonance (v14): a note may lean off the chord — a step inside the
      // mode at low settings, a borrowed semitone at high ones. Never the
      // cadence note, which is what tells the ear the phrase has landed.
      const stray = last && cadence ? 0 : dissonanceDraw('melody');
      notes.push({
        beat,
        degree: stray && !stray.chromatic ? degree + stray.dir : degree,
        bend: stray && stray.chromatic ? stray.dir : 0,
        // The head of the cell is accented every time it comes round: the ear
        // has to be told where the idea starts.
        duration: last && cadence ? Math.max(cell.lengths[i], 1) : cell.lengths[i],
        velocity: (i === 0 ? 0.78 : 0.6) * (0.75 + intensity * 0.3) * velocityJitter('melody'),
        pan: between(-0.25, 0.25, rng) + panSpread('melody'),
        nudge: timingNudge('melody'),
      });
    }
    return { motifDerived: notes.length > 0, notes, octave };
  }

  /** Texture is pure drift: scale degrees rather than chord tones, one draw per pulse. */
  function planTexture(intensity) {
    const chance = clamp(
      (0.05 + params.complexity * 0.3) * (0.5 + intensity) * trackDensity('texture'), 0, 1,
    );
    const events = [];
    for (let index = 0; index < bar.pulses.length; index++) {
      if (rng() >= chance) continue;
      const stray = dissonanceDraw('texture');
      events.push({
        pulse: index,
        degree: Math.floor(rng() * bar.scale.length * 2) + (stray && !stray.chromatic ? stray.dir : 0),
        bend: stray && stray.chromatic ? stray.dir : 0,
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
    const density = clamp(auto.density * (0.45 + intensity * 0.8) * trackDensity('arp'), 0, 1);
    // The sequencer lane replaces the mask outright in manual mode, so there is
    // nothing to draw for and no rng to spend.
    if (!needMask) return { ...auto, gate: params.arp.gate, steps: null };
    // Repetition decides how often the auto step mask is rewritten — unless the
    // arp is sitting at randomness 0, where the mask it has is the mask it keeps.
    const reroll = rng() > params.repetition && !isFrozenTrack('arp');
    if (!autoArpSteps || reroll) {
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
    const sounded = new Map();
    // The step grid is bar-anchored: step 0 realigns to every barline. A phase
    // carried across bars rotates the pattern in any metre where a bar is not a
    // whole number of mask cycles (repro'd at 1/8T: offsets drifted 0, 12, 8,
    // 4). arpCursor is deliberately NOT reset, so the note sequence itself
    // stays continuous for melodic flow.
    for (let beat = 0; beat < bar.beats - 1e-6; beat += stepBeats) {
      const index = steps;
      steps += 1;
      let velocity;
      let gate;
      if (manual) {
        // Slots past the lane length belong to no arp step in this metre.
        if (index >= laneLength) continue;
        const step = lane[index];
        if (!step.on) continue;
        gate = step.gate;
        const prob = groupedProb(sounded, step, effectiveProb('arp', `step.${index}`, step.prob));
        const fires = rng() < prob;
        if (step.group !== undefined) sounded.set(step.group, fires);
        if (!fires) continue;
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
        index,
        beat,
        seqIndex,
        gate,
        gateBeats: stepBeats * (gate ?? cfg.gate),
        velocity: clamp(velocity, 0.05, 1),
        pan: ((((index % 4)) - 1.5) / 1.5) * 0.3 + panSpread('arp'),
        octave: octaveWander('arp'),
        nudge: timingNudge('arp'),
      });
    }
    if (manual) {
      // A tied arp step holds through the slot it merges with instead of
      // re-plucking it, so the gate grows by exactly the slots it swallowed —
      // or, where the step names its own gate, that gate scales the whole
      // merged span, tie first.
      plan.steps = mergeTies(plan.steps, lane, laneLength);
      for (const step of plan.steps) {
        if (step.gate !== undefined) {
          step.gateBeats = gatedSpan(step, step.gate, stepBeats);
        } else if (step.slots > 1) {
          step.gateBeats = stepBeats * (step.slots - 1 + cfg.gate);
        }
      }
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
    melodyPlan = emptyMelodyPlan();
    responder = null;
    texturePlan = [];
    motif = null;
    phraseBar = 0;
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
    const density = clamp(
      (0.15 + intensity * params.complexity * 1.2) * trackDensity('percussion'), 0, 1,
    );
    // At randomness 0 the bank never grows past the pattern in it, so reusing
    // it is a literal loop of the bar that is already playing.
    const reuse = rng() < params.repetition || isFrozenTrack('percussion');
    if (percussionBank.length && reuse) return pick(percussionBank, rng);
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
   * Manual percussion: the kit's lanes on the sixteenth grid, each slot firing
   * against its own probability and velocity band. v21: a hit carries the lane
   * that struck it AND the voice kind that lane maps onto, so a user lane
   * sounds through a real drum voice while still being identifiable downstream.
   */
  function planPercussionManual() {
    const lanes = sequencerFor('percussion').steps;
    const slots = sequencerStepsPerBar(params.timeSignature);
    const hits = [];
    for (const lane of percussionLanes()) {
      const steps = lanes[lane.id];
      if (!steps) continue;
      const sounded = new Map();
      let laneHits = [];
      for (let i = 0; i < slots; i++) {
        const step = steps[i];
        if (!step.on) continue;
        const prob = groupedProb(sounded, step,
          effectiveProb('percussion', `step.${lane.id}.${i}`, step.prob));
        const fires = rng() < prob;
        if (step.group !== undefined) sounded.set(step.group, fires);
        if (!fires) continue;
        const beat = i / 4;
        const pulse = pulseAtBeat(beat);
        laneHits.push({
          index: i,
          pulse,
          offset: beat - bar.starts[pulse],
          lane: lane.id,
          kind: lane.kind,
          velocity: between(step.vmin, step.vmax, rng) * velocityJitter('percussion'),
          pan: percussionPan(lane.kind),
          nudge: timingNudge('percussion'),
        });
      }
      // A tie on a drum lane swallows the hit it merges with: one longer stroke.
      laneHits = mergeTies(laneHits, steps, slots);
      for (const hit of laneHits) hits.push(hit);
    }
    hits.sort((a, b) => a.pulse - b.pulse || a.offset - b.offset);
    return hits;
  }

  /** Banked patterns are shared between bars, so the jitter is applied per bar. */
  function planPercussion(intensity) {
    if (isManual('percussion')) return planPercussionManual();
    return choosePercussion(intensity).map((hit) => ({
      ...hit,
      // The generator thinks in voice kinds; the kit answers with the lane
      // that plays that kind, so an auto bar is labelled like a manual one.
      lane: laneForKind(hit.kind),
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
    // The close of a repeat: the bar that would have followed it is the bar
    // the open bracket points at, and the piece plays the range again.
    if (loopRegion && barIndex >= loopRegion.end) barIndex = loopRegion.start;
    loopRecord = loopRecordFor(barIndex);
    const replaying = Boolean(loopRecord && loopRecord.captured);
    currentBarNumber = barIndex;
    currentBarTime = time;
    if (params.timeSignature !== bankTimeSignature) {
      // Stored percussion patterns carry pulse indexes, and motif cells and
      // bass patterns carry beat positions, from the metre they were made in;
      // replayed in a shorter metre their out-of-range events are silently
      // dropped and the track thins out. Start them all afresh in the new
      // metre. A frozen bar plan is grid-bound the same way, so hold re-freezes
      // in the new metre.
      bankTimeSignature = params.timeSignature;
      percussionBank = [];
      motifBank.clear();
      motif = null;
      motifPending = null;
      phraseBar = 0;
      bassGroove = null;
      bassGrooveKey = '';
      bassGrooveBar = 0;
      bassGrooveOpLast = 'state';
      bassPocket = null;
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
      // Swing is read here and nowhere else, so a change of feel lands on a
      // barline like every other timing decision. v21 snapshots the per-track
      // amounts alongside it: same warp law, one resolved value per track.
      swing: clamp(params.swing, 0, 1),
      swings: Object.fromEntries(trackOrder().map((name) => [name, trackSwing(name)])),
    };

    retuneDelay(time, secPerBeat);

    // A repeated bar is the same bar of the structure it was the first time
    // round, so the section — and every activity decision the section drives —
    // repeats with the material rather than sliding out from under it.
    structureBar = once('structureBar', () => structureBar);

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

    // v15: every bar says where the brackets are and whether the playhead is
    // inside them, so a piano roll can draw them without tracking the
    // transport itself. Explicitly null with none set — a roll that drew the
    // brackets must learn that they are gone.
    emit('bar', {
      bar: barIndex,
      beatsPerBar: bar.beats,
      time,
      loop: loopRegion ? {
        start: loopRegion.start,
        end: loopRegion.end,
        active: barIndex >= loopRegion.start && barIndex < loopRegion.end,
      } : null,
    });
    // The opening section is always announced, so a listener that subscribes
    // before start() learns where the piece begins.
    const changed = section.label !== currentSection.label
      || section.intensity !== currentSection.intensity;
    if (changed || !sectionAnnounced) {
      sectionAnnounced = true;
      // A section change picks the hook variant that suits the new intensity —
      // at the next pass boundary, never mid-loop, so the loop stays a loop —
      // and, in the same spirit, its own motif at the next phrase boundary.
      if (changed) {
        hookSectionPending = true;
        if (section.label !== currentSection.label) motifSectionPending = true;
      }
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
      emitChord(barIndex, time);
      barIndex += 1;
      structureBar += 1;
      return;
    }

    // A promotion lasts one bar: whatever covered the last gap goes back to
    // whatever its own state says before this bar's activity is decided.
    promoted.clear();
    // Hold, re-rolls and the drift walks all settle before anything is drawn,
    // so a bar is realised exactly once against a stable set of decisions.
    applyHolds();
    advanceWalks();
    // A lane's loop is the bar, so the Markov pick between a track's several
    // sequencers happens here, before anything reads one.
    advanceSequencers();
    consumeRandomise();
    wanderVoices(time);
    // Track gains are re-applied EVERY bar, not only when the section changes:
    // staged entry brings tracks in over the first six bars and the level and
    // volume walks step once a bar (just above), so a drone section would
    // otherwise freeze both at whatever bar 0 decided — leaving every track but
    // the pad silent for the whole piece.
    applyTracks(0.4, time);
    // The sends follow for the same reason: a ranged reverb/delay in the voice
    // patch resolves through the walk that has just stepped, and the send gains
    // are the only place that resolution can be heard. Ramped, as ever, so the
    // bar-by-bar drift glides instead of stepping.
    applySends(0.4, time);

    // The pad's dynamic contour runs off the bar clock, not off the chord
    // rhythm, so a two-bar chord still swells rather than sitting flat.
    padSwellPhase = (padSwellPhase + 1 / PAD_SWELL_BARS) % 1;

    // The chord frame of the bar, which under a repeat is the frame that bar
    // sounded on the first traversal: inside the brackets the hook does not
    // advance at all, so the range's harmony is frozen with its material.
    const frame = once('harmony', () => {
      // Harmony advances even under hold: a held track keeps following the hook,
      // it just stops re-drawing its own material (ruling 5).
      const fresh = chordBarsLeft <= 0;
      if (fresh) advanceHarmony(intensity);
      return {
        fresh,
        degree: chordDegree,
        inversion: chordInversion,
        extension: chordExtension,
        // Read only where a span actually begins, so a bar mid-chord costs
        // nothing — and, under 'auto', draws no randomness either.
        span: fresh ? chordSpanBars() : 0,
      };
    });
    // Every bar of a repeat re-reads its captured frame, not just the ones a
    // chord change lands on: a range whose first bar sits mid-chord would
    // otherwise inherit the chord of the range's LAST bar on the way round.
    chordDegree = frame.degree;
    chordInversion = frame.inversion;
    chordExtension = frame.extension;
    if (frame.fresh) {
      chordBarsLeft = frame.span;
      if (isActive('pad')) {
        const plan = planFor('pad', undefined, planPad);
        // The no-two-consecutive-rests rule is enforced HERE rather than in the
        // plan, so a held pad whose frozen plan says "rest" breathes in and out
        // instead of going silent for the length of the hold.
        const resting = once('padRest', () => plan.rest && !padRested);
        padRested = resting;
        if (!resting) playChordVoicing(time, bar.duration * chordBarsLeft, plan);
      }
    }
    chordBarsLeft -= 1;

    if (isActive('bass')) {
      scheduleBass(time, bar.duration, planFor('bass', undefined, planBass));
      // The groove's own clock: bar 0 of every four-bar cycle states it plain.
      if (!replaying) bassGrooveBar += 1;
    }

    // A repeated bar sings the phrase it sang before, so the phrase clock —
    // and the cell it would develop or replace — stands still inside the
    // brackets rather than evolving where nothing can be heard of it.
    if (!replaying) advanceMelodyPhrase(intensity);

    // Each bar of the phrase freezes separately, so a held melody loops at the
    // phrase's own length instead of collapsing to one bar. A manual grid has
    // no such length — the lane IS the material and it is bar-anchored — so it
    // freezes as one plan that repeats every bar.
    melodyPlan = isActive('melody')
      ? planFor('melody', isManual('melody') ? undefined : phraseBar,
        () => planMelody(intensity)) : emptyMelodyPlan();
    melodyShift = melodyOctave(melodyPlan);
    // The answering instrument takes the melody's bar; it does not also play
    // its own, or the answer arrives underneath an arpeggio of itself.
    responder = melodyPlan.notes.length ? once('responder', responderTrack) : null;
    texturePlan = isActive('texture')
      ? planFor('texture', undefined, () => planTexture(intensity)) : [];
    arpPlan = isActive('arp') && responder !== 'arp'
      ? planFor('arp', undefined, () => planArp(intensity)) : null;
    percussionPlan = isActive('percussion')
      ? planFor('percussion', undefined, () => planPercussion(intensity)) : [];

    // Everything is planned: if the bar would pass in silence, cover it.
    coverSilence(time);
    emitChord(barIndex, time);

    // The bar is fully realised: every later pass of a repeat replays it.
    if (loopRecord) loopRecord.captured = true;
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
      // v12 register band: ±14 semitones around the root in octave 4. A tune
      // that wanders octaves is a texture; a tune that stays inside a singer's
      // range is a tune.
      const centre = scaleDegreeToMidi(0, bar.scale, bar.rootPc, 4);
      // Monophonic notes are trimmed to the gap before the next one: a mono
      // line that let its notes run past each other would spend its life
      // cutting itself off. Polyphonic melody keeps the wash it always had.
      const mono = params.tracks.melody.mono === true;
      const overlap = mono ? 1.02 : 1.6;
      for (const note of melodyPlan.notes) {
        if (note.beat < from || note.beat >= to) continue;
        // A gated step asked for its length outright, overlap included, so it
        // is exempt: that is how a gate above 1 reaches the mono track's
        // legato instead of being trimmed back to the gap in front of it.
        const gap = mono && note.gate === undefined
          ? melodyPlan.notes.reduce(
            (room, other) => (other.beat > note.beat + 1e-9
              ? Math.min(room, other.beat - note.beat) : room),
            bar.beats - note.beat,
          )
          : Infinity;
        const at = time + (swung(note.beat, 'melody') - from) * bar.secPerBeat + (note.nudge ?? 0);
        let midi = scaleDegreeToMidi(
          chordDegree + note.degree, bar.scale, bar.rootPc, 4,
        ) + 12 * (melodyShift + (melodyPlan.octave ?? 0) + (note.octave ?? 0))
          + (note.bend ?? 0);
        // The band is a last guard behind the bar's own transposition, and it
        // FOLDS by octaves rather than clamping: clamping would land the note
        // on the band edge, which is not necessarily a note of the scale.
        while (midi > centre + MELODY_BAND) midi -= 12;
        while (midi < centre - MELODY_BAND) midi += 12;
        playNote(responder ?? 'melody', {
          midi,
          when: at,
          duration: clamp(Math.min(note.duration, gap) * bar.secPerBeat * overlap, 0.1, 3),
          velocity: note.velocity,
          pan: note.pan,
          motif: melodyPlan.motifDerived === true,
        });
      }
    }

    if (isActive('texture')) {
      for (const event of texturePlan) {
        if (event.pulse !== index) continue;
        let midi = scaleDegreeToMidi(event.degree, bar.scale, bar.rootPc, 6);
        while (midi > 100) midi -= 12;
        while (midi < 79) midi += 12;
        midi = clamp(midi + 12 * (event.octave ?? 0) + (event.bend ?? 0), 67, 108);
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
          when: time + (swung(step.beat, 'arp') - from) * bar.secPerBeat + (step.nudge ?? 0),
          duration: Math.max(0.05, step.gateBeats * bar.secPerBeat),
          velocity: step.velocity,
          pan: step.pan,
        });
      }
    }

    for (const hit of percussionPlan) {
      if (hit.pulse !== index) continue;
      const offset = Math.min(hit.offset, length * 0.9);
      // Swing is felt across the bar, so the hit is swung at its ABSOLUTE
      // position and then read back as an offset inside its own pulse.
      const swingOffset = swung(from + offset, 'percussion') - from;
      playNote('percussion', {
        midi: null,
        freq: null,
        kind: hit.kind,
        lane: hit.lane ?? hit.kind,
        when: time + swingOffset * bar.secPerBeat + (hit.nudge ?? 0),
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
      graph = buildGraph(ctx, trackOrder(), mixFor);
      output = wireOutput();
      try { ctx.onstatechange = handleStateChange; } catch { /* read-only mock */ }
      applySends(0.02);
      // The graph is built with the default tail; anything else the params (or
      // the governor) ask for is a rebuild, which this schedules if needed.
      reverbTarget = graph.reverbSeconds;
      ensureReverbTail();
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
    resetReverbState();
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
      melodyPlan = emptyMelodyPlan();
      responder = null;
      texturePlan = [];
      motif = null;
      motifPending = null;
      motifPhrase = 0;
      motifSalience = 0;
      motifSectionPending = false;
      phraseBar = 0;
      motifBank.clear();
      bassGroove = null;
      bassGrooveKey = '';
      bassGrooveBar = 0;
      bassGrooveOpLast = 'state';
      bassPocket = null;
      monoNotes.clear();
      // A performance starts from a fresh set of decisions: no frozen bar from
      // the last run, and drift walks that begin wherever this run takes them.
      walkPhases.clear();
      resolvedPatches.clear();
      frozenPlans.clear();
      held.clear();
      // Brackets the user drew stay drawn, but they enclose bar numbers this
      // performance has not reached yet: nothing captured is worth keeping.
      loopCapture.clear();
      loopRecord = null;
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
      promoted.clear();
      silentRun = 0;
      lastNoteEnd = 0;
      activeSequencer.clear();
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
    // An ending leaves the repeat first: the piece plays on from the close of
    // the brackets and then resolves, rather than fading out mid-loop.
    clearLoopRegion();
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
    for (const name of sequencedTracks()) {
      const track = tracks && tracks[name] && typeof tracks[name] === 'object' ? tracks[name] : null;
      if (track && ('sequencer' in track || 'sequencers' in track)) clearFrozen(name);
    }
    if (partial.arp && typeof partial.arp === 'object' && 'steps' in partial.arp) clearFrozen('arp');
    if (partial.percussion && typeof partial.percussion === 'object') clearFrozen('percussion');
  }

  /** An explicit voice choice ends any wander on that track, at once. */
  function clearWanderedVoices(partial) {
    const tracks = partial && typeof partial === 'object' && partial.tracks
      && typeof partial.tracks === 'object' ? partial.tracks : null;
    if (!tracks) return;
    for (const name of trackOrder()) {
      const track = tracks[name] && typeof tracks[name] === 'object' ? tracks[name] : null;
      if (track && 'voice' in track) wanderedVoice.delete(name);
    }
  }

  function setParams(partial) {
    params = sanitiseParams(partial, params, trackOrder());
    kindPatches.clear();
    resolvedPatches.clear();
    invalidateEditedPlans(partial);
    clearWanderedVoices(partial);
    if (ctx && graph) applyLevels(0.15);
    ensureReverbTail();
  }

  function getParams() {
    return copyParams(params, trackOrder());
  }

  /**
   * v14 live readouts: the numbers the engine is ACTUALLY playing right now,
   * for dials that show a drifting value. Every RangeValue is resolved through
   * its current walk position, the voice is the one sounding (wander included,
   * which is what lets an editor follow it), and the patch is the resolved one
   * that voice is being played with. Cheap enough to poll a few times a second
   * — it reads state, allocates a small object and draws no randomness.
   */
  function getResolved() {
    const tracks = {};
    for (const name of trackOrder()) {
      const config = params.tracks[name];
      const resolved = {
        state: config.state,
        active: isActive(name),
        voice: effectiveVoice(name),
        level: resolveRange(name, 'level', config.level),
        randomness: trackRandomness(name),
        // v21 followers, resolved: the feel this track is actually swung by
        // (its own, or the global dial it follows) and the multiplier its
        // event rate is actually taking (1 while it follows complexity).
        swing: trackSwing(name),
        density: trackDensity(name),
        held: held.has(name) || isFrozenTrack(name),
        vary: Object.fromEntries(VARY_ASPECTS.map((aspect) => [aspect, varyAmount(name, aspect)])),
      };
      if (config.dissonance !== undefined) resolved.dissonance = trackDissonance(name);
      // The kit as the grid is currently keyed: a dynamic lane list is the one
      // readout a percussion UI cannot derive from anything else.
      if (config.lanes) resolved.lanes = config.lanes.map((lane) => ({ ...lane }));
      if (config.sequencers && config.sequencers.length > 1) {
        resolved.sequencer = clamp(activeSequencer.get(name) ?? 0, 0, config.sequencers.length - 1);
      }
      tracks[name] = resolved;
    }
    const patches = {};
    for (const name of trackOrder()) {
      const patch = patchFor(name);
      patches[name] = patch ? copyPatch(patch) : null;
    }
    return {
      running: isRunning,
      bar: currentBarNumber,
      section: { label: currentSection.label, intensity: currentSection.intensity },
      tracks,
      patches,
    };
  }

  function getAnalysers() {
    return Object.fromEntries(
      trackOrder().map((name) => [name, graph ? graph.tracks[name].analyser : null]),
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
    for (const name of trackOrder()) {
      perTrack[name] = { activeNotes: 0, nodesEstimate: 0, notesPerMin: 0 };
    }
    let totalActiveNotes = 0;
    for (const entry of liveNotes) {
      if (entry.when > at || entry.until <= at) continue;
      perTrack[entry.track].activeNotes += 1;
      totalActiveNotes += 1;
    }
    for (const name of trackOrder()) {
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
   * Cap the simultaneous polyphony (v9 power governor), and the reverb tail
   * with it. Anything unusable — no argument, a missing or non-finite field —
   * means "no cap" for that field, so a page that cannot read the governor's
   * sensors never starves the music. `reverbSeconds` is read
   * FEATURE-TOLERANTLY: a governor too old to publish one leaves the tail
   * uncapped rather than silencing it.
   */
  function setPowerBudget(budget) {
    const wanted = budget && typeof budget === 'object' ? budget.maxNotes : undefined;
    const num = typeof wanted === 'number' ? wanted : Number(wanted);
    maxNotes = wanted !== undefined && wanted !== null && Number.isFinite(num)
      ? Math.max(1, Math.floor(num))
      : Infinity;
    setReverbSeconds(budget && typeof budget === 'object' ? budget.reverbSeconds : undefined);
  }

  /**
   * The governor's reverb cap on its own — power.js documents `reverbSeconds`
   * as a tier budget field, and this is the hook it names. It CAPS rather than
   * sets: the tail the listener gets is min(params.reverbTail, this), so a
   * tier change never overwrites what the user asked for. Anything unusable
   * lifts the cap.
   */
  function setReverbSeconds(seconds) {
    const num = typeof seconds === 'number' ? seconds : Number(seconds);
    reverbBudget = seconds !== undefined && seconds !== null && seconds !== ''
      && Number.isFinite(num) ? num : Infinity;
    ensureReverbTail();
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
    setLoopRegion,
    clearLoopRegion,
    setParams,
    getParams,
    getResolved,
    getTracks: trackViews,
    getAnalysers,
    getStats,
    setPowerBudget,
    setReverbSeconds,
    // Post-master mix as a MediaStream (what the listener hears), for
    // page-side MediaRecorder. Null on the direct-output route or pre-start.
    getOutputStream() {
      return output && output.mode === 'element' && output.streamDest
        ? output.streamDest.stream
        : null;
    },
    on,
    now,
  };
}

export default createEngine;
