/**
 * ambient-engine.js — procedural four-track ambient generator.
 *
 * Pure Web Audio API, no dependencies, no assets, no network. Import from an
 * Astro page's <script type="module"> and drive it with createEngine().
 *
 * Importing this module in a non-browser environment is safe: nothing touches
 * AudioContext until start() is called.
 *
 * Layout of this file:
 *   1. music theory tables + pure helpers (unit-testable, no audio)
 *   2. parameter validation
 *   3. phrase / harmony generators (pure)
 *   4. audio graph construction
 *   5. per-track voices
 *   6. scheduler + public engine
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

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

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

export const DEFAULT_PARAMS = Object.freeze({
  speed: 1,
  complexity: 0.5,
  repetition: 0.5,
  root: 'C',
  mode: 'majorPentatonic',
  timeSignature: '4/4',
  bpm: 60,
  voices: 4,
  volume: 0.8,
});

const NUMERIC_RANGES = {
  speed: [0.25, 2],
  complexity: [0, 1],
  repetition: [0, 1],
  bpm: [40, 120],
  voices: [1, 4],
  volume: [0, 1],
};

/**
 * Merge `partial` over `base`, clamping numbers, rejecting unknown enum values
 * and silently ignoring unknown keys. Always returns a complete params object.
 */
export function sanitiseParams(partial, base = DEFAULT_PARAMS) {
  const out = { ...DEFAULT_PARAMS, ...(base && typeof base === 'object' ? base : null) };
  if (partial && typeof partial === 'object') {
    for (const key of Object.keys(partial)) {
      const value = partial[key];
      if (key in NUMERIC_RANGES) {
        const num = typeof value === 'number' ? value : Number(value);
        if (Number.isFinite(num)) {
          const [lo, hi] = NUMERIC_RANGES[key];
          out[key] = clamp(num, lo, hi);
        }
      } else if (key === 'root') {
        const root = normaliseRoot(value);
        if (root) out.root = root;
      } else if (key === 'mode') {
        if (typeof value === 'string' && value in SCALES) out.mode = value;
      } else if (key === 'timeSignature') {
        if (typeof value === 'string' && value in TIME_SIGNATURES) out.timeSignature = value;
      }
      // anything else: ignored
    }
  }
  // Re-clamp inherited values too, so a bad `base` can never leak through.
  for (const key of Object.keys(NUMERIC_RANGES)) {
    const num = Number(out[key]);
    const [lo, hi] = NUMERIC_RANGES[key];
    out[key] = Number.isFinite(num) ? clamp(num, lo, hi) : DEFAULT_PARAMS[key];
  }
  out.voices = Math.round(out.voices);
  out.root = normaliseRoot(out.root) ?? DEFAULT_PARAMS.root;
  if (!(out.mode in SCALES)) out.mode = DEFAULT_PARAMS.mode;
  if (!(out.timeSignature in TIME_SIGNATURES)) out.timeSignature = DEFAULT_PARAMS.timeSignature;
  return out;
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

// ---------------------------------------------------------------------------
// 4. Audio graph
// ---------------------------------------------------------------------------

const LOOKAHEAD = 0.12;      // seconds of audio scheduled ahead of the clock
const TICK_MS = 25;          // scheduler wake-up interval
const FADE_OUT = 0.5;        // stop() fade
const FADE_IN = 1.2;         // start() fade
const SILENCE = 0.0001;      // exponential ramps cannot reach zero
const MASTER_HEADROOM = 0.7; // keeps volume=1 comfortably clear of clipping

/**
 * Dry level and effect-send amounts per track. Tracks that sit further back in
 * the mix (texture, melody) get more reverb and delay; the sub bass gets almost
 * none so the low end stays defined.
 */
const TRACK_MIX = {
  pad: { level: 0.5, dry: 0.8, reverb: 0.45, delay: 0.1 },
  bass: { level: 0.55, dry: 1.0, reverb: 0.1, delay: 0.0 },
  melody: { level: 0.4, dry: 0.75, reverb: 0.5, delay: 0.3 },
  texture: { level: 0.3, dry: 0.6, reverb: 0.7, delay: 0.35 },
};

const TRACK_ORDER = ['pad', 'bass', 'melody', 'texture'];

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
    const dry = ctx.createGain();
    dry.gain.value = mix.dry;
    const reverbSend = ctx.createGain();
    reverbSend.gain.value = mix.reverb;
    const delaySend = ctx.createGain();
    delaySend.gain.value = mix.delay;
    input.connect(dry);
    dry.connect(master);
    input.connect(reverbSend);
    reverbSend.connect(convolver);
    if (mix.delay > 0) {
      input.connect(delaySend);
      delaySend.connect(delay);
    }
    tracks[name] = { input, dry, reverbSend, delaySend };
  }

  return { master, compressor, convolver, delay, feedback, tracks };
}

/**
 * Attack / hold / release on a gain, entirely with exponential ramps so nothing
 * clicks. Returns the absolute time at which the envelope has finished, which
 * is when it is safe to stop the source nodes.
 */
function envelope(param, start, { attack, hold, release, peak }) {
  const top = Math.max(peak, SILENCE * 2);
  param.setValueAtTime(SILENCE, start);
  param.exponentialRampToValueAtTime(top, start + attack);
  param.setValueAtTime(top, start + attack + hold);
  param.exponentialRampToValueAtTime(SILENCE, start + attack + hold + release);
  return start + attack + hold + release;
}

// ---------------------------------------------------------------------------
// 5. Public engine
// ---------------------------------------------------------------------------

export function createEngine(initialParams) {
  let params = sanitiseParams(initialParams);

  let ctx = null;
  let graph = null;
  let isRunning = false;
  let tickTimer = null;
  let suspendTimer = null;

  // Scheduler state
  let nextPulseTime = 0;
  let pulseIndex = 0;
  let bar = null;              // tempo/metre snapshot, refreshed at each bar start
  let delayTarget = 0;

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

  const rng = Math.random;
  const scale = () => SCALES[params.mode];
  const trackEnabled = (name) => params.voices >= TRACK_ORDER.indexOf(name) + 1;

  // -- live parameter application -------------------------------------------

  function applyLevels(rampSeconds) {
    if (!graph) return;
    const now = ctx.currentTime;
    const target = Math.max(params.volume * MASTER_HEADROOM, SILENCE);
    graph.master.gain.cancelScheduledValues(now);
    graph.master.gain.setValueAtTime(Math.max(graph.master.gain.value, SILENCE), now);
    graph.master.gain.exponentialRampToValueAtTime(isRunning ? target : SILENCE, now + rampSeconds);

    for (const name of TRACK_ORDER) {
      const gain = graph.tracks[name].input.gain;
      const level = trackEnabled(name) ? TRACK_MIX[name].level : SILENCE;
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(Math.max(gain.value, SILENCE), now);
      gain.exponentialRampToValueAtTime(Math.max(level, SILENCE), now + rampSeconds);
    }

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

  // -- voices ----------------------------------------------------------------

  /**
   * Pad: two slightly detuned oscillators per note (sine + triangle) through a
   * lowpass, with multi-second attack and release so voicings cross-fade into
   * each other rather than arriving.
   */
  function playPad(midi, time, duration, level) {
    const bus = graph.tracks.pad.input;
    const amp = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = clamp(midiToFreq(midi) * 5, 400, 2600);
    filter.Q.value = 0.6;
    amp.connect(filter);
    filter.connect(bus);

    const attack = clamp(between(2, 5, rng), 0.5, duration * 0.5);
    const release = clamp(between(2, 5, rng), 1, 6);
    const hold = Math.max(0.1, duration - attack);
    const end = envelope(amp.gain, time, { attack, hold, release, peak: level });

    const detune = between(3, 9, rng);
    for (const [type, gainValue, cents] of [['sine', 0.65, -detune], ['triangle', 0.35, detune]]) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = midiToFreq(midi);
      osc.detune.value = cents;
      const mix = ctx.createGain();
      mix.gain.value = gainValue;
      osc.connect(mix);
      mix.connect(amp);
      osc.start(time);
      osc.stop(end + 0.05);
    }
  }

  function playChordVoicing(time, duration) {
    const degrees = buildChord(chordDegree, params.complexity);
    const maxNotes = params.complexity > 0.5 ? 4 : 3;
    const midis = [];
    let previous = -Infinity;
    for (const degree of degrees.slice(0, maxNotes)) {
      let midi = scaleDegreeToMidi(degree, scale(), pitchClass(params.root), 3);
      while (midi <= previous) midi += 12;
      previous = midi;
      midis.push(midi);
    }
    // Level per note shrinks as the voicing thickens, keeping the pad's total
    // contribution roughly constant.
    const level = 0.22 / Math.sqrt(midis.length);
    for (const midi of midis) playPad(midi, time, duration, level);
  }

  /** Bass: sub sine plus a whisper of triangle for definition on small speakers. */
  function playBass(midi, time, duration) {
    const bus = graph.tracks.bass.input;
    const amp = ctx.createGain();
    amp.connect(bus);
    const end = envelope(amp.gain, time, {
      attack: 0.25,
      hold: Math.max(0.1, duration - 0.25),
      release: 0.8,
      peak: 0.3,
    });
    for (const [type, gainValue] of [['sine', 1], ['triangle', 0.12]]) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = midiToFreq(midi);
      const mix = ctx.createGain();
      mix.gain.value = gainValue;
      osc.connect(mix);
      mix.connect(amp);
      osc.start(time);
      osc.stop(end + 0.05);
    }
  }

  function scheduleBass(time, barDuration) {
    const root = scaleDegreeToMidi(chordDegree, scale(), pitchClass(params.root), 2);
    const twoNotes = rng() < 0.35 + params.complexity * 0.3;
    if (!twoNotes) {
      playBass(root, time, barDuration * 0.9);
      return;
    }
    playBass(root, time, barDuration * 0.45);
    // Second note is usually the fifth above, snapped back into the mode.
    const second = rng() < 0.6
      ? quantiseToScale(root + 7, scale(), pitchClass(params.root))
      : root;
    playBass(second, time + barDuration * 0.5, barDuration * 0.45);
  }

  /**
   * Melody: two-operator FM bell. The modulator's own decaying envelope gives
   * the bright attack and mellow tail of a struck tone.
   */
  function playMelody(midi, time, duration, velocity) {
    const bus = graph.tracks.melody.input;
    const freq = midiToFreq(midi);
    const amp = ctx.createGain();
    amp.connect(bus);

    const carrier = ctx.createOscillator();
    carrier.type = 'sine';
    carrier.frequency.value = freq;
    carrier.connect(amp);

    const modulator = ctx.createOscillator();
    modulator.type = 'sine';
    modulator.frequency.value = freq * (rng() < 0.5 ? 2 : 3.5);
    const modDepth = ctx.createGain();
    const index = freq * (0.6 + params.complexity * 1.6);
    modDepth.gain.setValueAtTime(index, time);
    modDepth.gain.exponentialRampToValueAtTime(Math.max(index * 0.02, SILENCE), time + 0.6);
    modulator.connect(modDepth);
    modDepth.connect(carrier.frequency);

    const peak = 0.16 * velocity;
    const attack = 0.015;
    amp.gain.setValueAtTime(SILENCE, time);
    amp.gain.exponentialRampToValueAtTime(peak, time + attack);
    amp.gain.exponentialRampToValueAtTime(SILENCE, time + attack + duration);
    const end = time + attack + duration + 0.05;

    carrier.start(time);
    carrier.stop(end);
    modulator.start(time);
    modulator.stop(end);
  }

  /** Texture: high sparkle, randomly panned, long tail, mostly reverb. */
  function playTexture(time) {
    const bus = graph.tracks.texture.input;
    const degree = Math.floor(rng() * scale().length * 2);
    let midi = scaleDegreeToMidi(degree, scale(), pitchClass(params.root), 6);
    while (midi > 100) midi -= 12;
    while (midi < 79) midi += 12;

    const panner = ctx.createStereoPanner();
    panner.pan.value = between(-0.8, 0.8, rng);
    panner.connect(bus);

    const amp = ctx.createGain();
    amp.connect(panner);

    const decay = between(3, 6, rng);
    const peak = between(0.05, 0.11, rng);
    amp.gain.setValueAtTime(SILENCE, time);
    amp.gain.exponentialRampToValueAtTime(peak, time + 0.01);
    amp.gain.exponentialRampToValueAtTime(SILENCE, time + 0.01 + decay);
    const end = time + decay + 0.1;

    for (const [type, gainValue, ratio] of [['sine', 1, 1], ['triangle', 0.18, 2.01]]) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = midiToFreq(midi) * ratio;
      const mix = ctx.createGain();
      mix.gain.value = gainValue;
      osc.connect(mix);
      mix.connect(amp);
      osc.start(time);
      osc.stop(end);
    }
  }

  // -- scheduler -------------------------------------------------------------

  /**
   * Snapshot tempo and metre for the bar about to start, then schedule the
   * bar-level events (chord change, pad voicing, bass). bpm, speed, time
   * signature, root and mode are read here and nowhere else, which is what
   * quantises those changes to bar boundaries.
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

    if (chordBarsLeft <= 0) {
      chordDegree = chooseChord();
      // Slower harmonic rhythm when the listener wants repetition.
      chordBarsLeft = rng() < 0.5 + params.repetition * 0.2 ? 2 : 1;
      if (trackEnabled('pad')) {
        playChordVoicing(time, bar.duration * chordBarsLeft);
      }
    }
    chordBarsLeft -= 1;

    if (trackEnabled('bass')) scheduleBass(time, bar.duration);

    if (phraseBarsLeft <= 0) {
      currentPhrase = choosePhrase();
      phraseBarsLeft = currentPhrase.bars;
      phraseBarIndex = 0;
    } else {
      phraseBarIndex += 1;
    }
    phraseBarsLeft -= 1;
  }

  /** Schedule the events that fall inside one pulse of the current bar. */
  function schedulePulse(time, index) {
    const from = bar.starts[index];
    const to = from + bar.pulses[index];

    if (trackEnabled('melody') && currentPhrase) {
      for (const note of currentPhrase.notes) {
        if (note.bar !== phraseBarIndex || note.beat < from || note.beat >= to) continue;
        const at = time + (note.beat - from) * bar.secPerBeat;
        let midi = scaleDegreeToMidi(
          chordDegree + note.degree, scale(), pitchClass(params.root), 4,
        );
        // keep the melody in octaves 4–5
        while (midi > 83) midi -= 12;
        while (midi < 60) midi += 12;
        const duration = clamp(note.duration * bar.secPerBeat * 1.6, 0.6, 3);
        playMelody(midi, at, duration, note.velocity);
      }
    }

    if (trackEnabled('texture')) {
      const chance = 0.05 + params.complexity * 0.3;
      if (rng() < chance) {
        playTexture(time + rng() * bar.pulses[index] * bar.secPerBeat);
      }
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
    delayTarget = 0;
    nextPulseTime = ctx.currentTime + 0.15;
    if (!progression.length) {
      progression = generateProgression(scale().length, params.complexity, rng);
      progressionIndex = 0;
      chordDegree = progression[0];
    }
    applyLevels(FADE_IN);
    tickTimer = setInterval(tick, TICK_MS);
    tick();
  }

  function stop() {
    if (tickTimer !== null) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
    if (!isRunning) return;
    isRunning = false;
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
    return { ...params };
  }

  return {
    start,
    stop,
    get running() {
      return isRunning;
    },
    setParams,
    getParams,
  };
}

export default createEngine;
