/**
 * engine-voices.js — the timbre library for the ambient generator.
 *
 * One `play(ctx, destination, note, patch)` function per voice, grouped by
 * track and exported as VOICES (see docs/engine-v2-contract.md). Each voice
 * builds its own throwaway node graph, schedules it entirely on the audio
 * clock, and tears itself down when the tail has finished, so a session that
 * runs for hours accumulates nothing.
 *
 * House rules every voice follows:
 *   - render DRY into `destination`; the engine owns reverb and delay sends
 *   - gain moves are exponential ramps or setTargetAtTime, never a step to zero
 *   - amplitude scales with velocity squared, which tracks perceived loudness
 *     far better than a linear scale
 *   - peak per-note gain stays at or below ~0.25, and voices within a track
 *     are loudness-matched so swapping a voice never jumps the mix
 *   - a patch can change the sound but never the level guarantees: nothing a
 *     patch sets adds gain, and resonance is paid for with a matching trim
 *
 * Pure module: no imports, and nothing touches an AudioContext until a voice is
 * played, so importing this outside a browser is safe.
 *
 * Layout:
 *   1. constants + pure helpers
 *   1b. waveform morphing (the continuous sine→triangle→saw→square dial)
 *   2. the per-note rig (node bookkeeping, envelopes, teardown, cancel)
 *   3. building blocks shared by several voices (FM, LFO, drum primitives)
 *   3b. the patch model, and every voice's published defaults
 *   4. voices: pad, bass, melody, texture, arp, percussion
 *   5. VOICES export
 */

// ---------------------------------------------------------------------------
// 1. Constants and pure helpers
// ---------------------------------------------------------------------------

/**
 * The floor every exponential ramp aims at. Web Audio cannot ramp
 * exponentially to zero, and anything below this is inaudible anyway.
 */
const SILENCE = 1e-4;

/** How long cancel() takes to fade a note out. Short, but not a click. */
const CANCEL_FADE = 0.05;

/**
 * Per-track reference peak at full velocity. These are the numbers that keep
 * the six tracks in balance with each other; individual patches trim around
 * them only to correct for spectral loudness (noisy timbres read louder than
 * sines at the same peak).
 */
const PEAK = {
  pad: 0.12,
  bass: 0.24,
  melody: 0.18,
  texture: 0.1,
  arp: 0.16,
  percussion: 0.22,
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const between = (lo, hi) => lo + Math.random() * (hi - lo);

/** Equal temperament, A4 = 440 Hz at MIDI 69. */
const midiToFreq = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

/** Percussion notes carry no pitch, so every patch needs a sane fallback. */
function freqOf(note, fallback) {
  if (Number.isFinite(note.freq) && note.freq > 0) return note.freq;
  if (Number.isFinite(note.midi)) return midiToFreq(note.midi);
  return fallback;
}

function velOf(note) {
  return clamp(Number.isFinite(note.velocity) ? note.velocity : 0.7, 0, 1);
}

function durOf(note, fallback) {
  return Number.isFinite(note.duration) && note.duration > 0 ? note.duration : fallback;
}

/**
 * A throttled tab can hand us a `when` that has already gone past; starting a
 * source in the past makes it jump in at full level, which clicks.
 */
function timeOf(ctx, note) {
  const when = Number.isFinite(note.when) ? note.when : ctx.currentTime;
  return Math.max(when, ctx.currentTime);
}

/** Velocity squared, floored so a velocity-0 note can still be ramped. */
function level(base, velocity) {
  return Math.max(base * velocity * velocity, SILENCE * 2);
}

/** 0.4–1 multiplier for cutoffs: harder notes are brighter, not just louder. */
const brightness = (velocity) => 0.4 + 0.6 * velocity;

/**
 * A bandpass only passes the slice of a noise source that falls inside its
 * band, so a burst asking for a given peak comes out far below it — a Q of 15
 * costs about 20 dB. This is the fraction that survives (crest factor included),
 * and its inverse is the makeup a noise layer needs to land where it was aimed.
 */
function noiseShare(freq, q, sampleRate) {
  const bandwidth = freq / Math.max(q, 0.5);
  return Math.min(1, 3 * Math.sqrt(bandwidth / (sampleRate * 0.5)));
}

/** Makeup gain for the above, capped so a narrow band never runs away. */
function noiseMakeup(freq, q, sampleRate) {
  return 1 / Math.max(noiseShare(freq, q, sampleRate), 1 / 6);
}

/**
 * Attack / hold / release, entirely in exponential ramps. Linear in decibels,
 * which is what a fade sounds like. Returns the time the tail has finished.
 */
function env(param, t0, { attack, hold, release, peak }) {
  const top = Math.max(peak, SILENCE * 2);
  const sustainEnd = t0 + attack + Math.max(hold, 0);
  param.setValueAtTime(SILENCE, t0);
  param.exponentialRampToValueAtTime(top, t0 + attack);
  param.setValueAtTime(top, sustainEnd);
  param.exponentialRampToValueAtTime(SILENCE, sustainEnd + release);
  return sustainEnd + release;
}

/** Struck-string shape: near-instant rise, exponential fall, no sustain. */
function hit(param, t0, { attack = 0.004, decay, peak }) {
  const top = Math.max(peak, SILENCE * 2);
  param.setValueAtTime(SILENCE, t0);
  param.exponentialRampToValueAtTime(top, t0 + attack);
  param.exponentialRampToValueAtTime(SILENCE, t0 + attack + decay);
  return t0 + attack + decay;
}

/**
 * Two seconds of noise per colour per context, generated once and looped by
 * every patch that needs it. Keyed weakly so a discarded context is collectable.
 */
const NOISE_CACHE = new WeakMap();

function noiseBuffer(ctx, colour) {
  let cache = NOISE_CACHE.get(ctx);
  if (!cache) {
    cache = {};
    NOISE_CACHE.set(ctx, cache);
  }
  if (cache[colour]) return cache[colour];

  const length = Math.max(Math.floor(ctx.sampleRate * 2), 1024);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    if (colour === 'pink') {
      // Paul Kellett's three-pole approximation: -3 dB/octave, which reads as
      // breath or air rather than the hiss of white noise.
      let b0 = 0;
      let b1 = 0;
      let b2 = 0;
      for (let i = 0; i < length; i++) {
        const white = Math.random() * 2 - 1;
        b0 = 0.99765 * b0 + white * 0.099046;
        b1 = 0.963 * b1 + white * 0.2965164;
        b2 = 0.57 * b2 + white * 1.0526913;
        data[i] = (b0 + b1 + b2 + white * 0.1848) * 0.22;
      }
    } else {
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    }
  }
  cache[colour] = buffer;
  return buffer;
}

// ---------------------------------------------------------------------------
// 1b. Waveform morphing — one continuous dial from sine to square
// ---------------------------------------------------------------------------

const OSC_TYPES = ['sine', 'triangle', 'sawtooth', 'square'];

/**
 * Fourier sine coefficients for the four canonical shapes, index = harmonic:
 * sine is its fundamental alone, triangle 1/n² on odd harmonics with
 * alternating sign, sawtooth 1/n on every harmonic, square 1/n on odd ones.
 * A fractional shape is a linear blend of the two shapes either side of it.
 */
const MORPH_HARMONICS = 32;
const MORPH_STEP = 1 / 16;   // dial resolution: 49 cached waves span the dial

const CANONICAL = [0, 1, 2, 3].map((shape) => {
  const b = new Float32Array(MORPH_HARMONICS + 1);
  for (let n = 1; n <= MORPH_HARMONICS; n++) {
    if (shape === 0) b[n] = n === 1 ? 1 : 0;
    else if (shape === 1) b[n] = n % 2 ? (n % 4 === 1 ? 1 : -1) / (n * n) : 0;
    else if (shape === 2) b[n] = 1 / n;
    else b[n] = n % 2 ? 1 / n : 0;
  }
  return b;
});

const WAVE_CACHE = new WeakMap();

/**
 * A PeriodicWave for any point on the sine(0)→triangle(1)→saw(2)→square(3)
 * dial. The blended coefficients are scaled so their RMS is the same at every
 * point — level loudness across the dial — while the browser's own peak
 * normalisation (left on) keeps the rendered wave in bounds. Quantised to
 * 1/16 of a shape and cached per context, so a swept dial reuses a small
 * fixed set of waves rather than building one per note.
 */
export function shapeWave(ctx, shape) {
  const s = Math.round(clamp(Number.isFinite(shape) ? shape : 0, 0, 3) / MORPH_STEP) * MORPH_STEP;
  let cache = WAVE_CACHE.get(ctx);
  if (!cache) {
    cache = new Map();
    WAVE_CACHE.set(ctx, cache);
  }
  const key = Math.round(s / MORPH_STEP);
  const hit = cache.get(key);
  if (hit) return hit;

  const lower = Math.min(Math.floor(s), 2);
  const blend = s - lower;
  const from = CANONICAL[lower];
  const to = CANONICAL[lower + 1];
  const imag = new Float32Array(MORPH_HARMONICS + 1);
  let power = 0;
  for (let n = 1; n <= MORPH_HARMONICS; n++) {
    imag[n] = from[n] * (1 - blend) + to[n] * blend;
    power += imag[n] * imag[n];
  }
  const norm = 1 / Math.sqrt(power);
  for (let n = 1; n <= MORPH_HARMONICS; n++) imag[n] *= norm;
  const wave = ctx.createPeriodicWave(new Float32Array(MORPH_HARMONICS + 1), imag);
  cache.set(key, wave);
  return wave;
}

/**
 * Give an oscillator its shape: a legacy type string as-is, an integer shape
 * as the native type it names (so 2.0 IS the browser's own sawtooth), and a
 * fractional shape as a morphed PeriodicWave.
 */
function applyShape(ctx, node, shape) {
  if (typeof shape !== 'number') {
    node.type = shape;
    return;
  }
  const s = Math.round(clamp(shape, 0, 3) / MORPH_STEP) * MORPH_STEP;
  if (Number.isInteger(s)) node.type = OSC_TYPES[s];
  else node.setPeriodicWave(shapeWave(ctx, s));
}

// ---------------------------------------------------------------------------
// 2. The per-note rig
// ---------------------------------------------------------------------------

/**
 * Bookkeeping for one note: every node a patch creates is registered here, and
 * the rig stops all sources at the end of the tail and disconnects the whole
 * graph once the last source has actually ended. Patches never call
 * start/stop/disconnect themselves.
 */
function createRig(ctx, destination, note) {
  const nodes = [];
  const sources = [];
  let cleaned = false;
  let pending = 0;

  const out = ctx.createGain();
  out.gain.value = 1;
  const panner = ctx.createStereoPanner();
  panner.pan.value = clamp(Number.isFinite(note.pan) ? note.pan : 0, -1, 1);
  out.connect(panner);
  panner.connect(destination);
  nodes.push(out, panner);

  function keep(node) {
    nodes.push(node);
    return node;
  }

  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    for (const node of nodes) node.disconnect();
  }

  function entryFor(node) {
    return sources.find((s) => s.node === node);
  }

  const rig = {
    out,
    sampleRate: ctx.sampleRate,

    gain(value = 1) {
      const node = ctx.createGain();
      node.gain.value = value;
      return keep(node);
    },

    filter(type, frequency, q = 1) {
      const node = ctx.createBiquadFilter();
      node.type = type;
      node.frequency.value = Math.max(frequency, 10);
      node.Q.value = q;
      return keep(node);
    },

    panner(value) {
      const node = ctx.createStereoPanner();
      node.pan.value = clamp(value, -1, 1);
      return keep(node);
    },

    delay(seconds) {
      const node = ctx.createDelay(Math.max(seconds * 4, 0.2));
      node.delayTime.value = seconds;
      return keep(node);
    },

    /** `shape` is a legacy type string or a number on the morph dial. */
    osc(shape, frequency, start, detune = 0) {
      const node = ctx.createOscillator();
      applyShape(ctx, node, shape);
      node.frequency.value = Math.max(frequency, 0.01);
      if (detune) node.detune.value = detune;
      node.start(start);
      sources.push({ node, start, stop: null });
      return keep(node);
    },

    noise(start, { colour = 'white', rate = 1 } = {}) {
      const node = ctx.createBufferSource();
      node.buffer = noiseBuffer(ctx, colour);
      node.loop = true;
      node.playbackRate.value = rate;
      // A random read offset stops repeated bursts sounding like the same clip.
      node.start(start, Math.random() * 1.5);
      sources.push({ node, start, stop: null });
      return keep(node);
    },

    /** Retire one source early — used by grains and one-shot transients. */
    stopAt(node, time) {
      const entry = entryFor(node);
      if (entry) entry.stop = time;
    },

    /**
     * Close the note off: stop every source at the end of its tail, arm the
     * teardown, and hand back the contract's cancel handle.
     */
    finish(endTime) {
      for (const source of sources) {
        const at = Math.max(source.stop === null ? endTime : source.stop, source.start + 0.005);
        source.stopTime = at;
        source.node.stop(at);
      }
      pending = sources.length;
      for (const source of sources) {
        source.node.onended = () => {
          pending -= 1;
          if (pending <= 0) cleanup();
        };
      }
      if (!sources.length) cleanup();
      return { cancel };
    },
  };

  function cancel() {
    if (cleaned) return;
    const now = ctx.currentTime;
    const current = Math.max(out.gain.value, SILENCE);
    out.gain.cancelScheduledValues(now);
    out.gain.setValueAtTime(current, now);
    out.gain.exponentialRampToValueAtTime(SILENCE, now + CANCEL_FADE);

    const end = now + CANCEL_FADE + 0.01;
    for (const source of sources) {
      const at = Math.max(end, source.start + 0.005);
      if (source.stopTime !== undefined && source.stopTime <= at) continue;
      source.stopTime = at;
      source.node.stop(at);
    }
  }

  return rig;
}

// ---------------------------------------------------------------------------
// 3. Shared building blocks
// ---------------------------------------------------------------------------

/**
 * Two-operator FM: a sine modulator on the carrier's frequency, with its own
 * decaying index. The index envelope is what makes an FM tone bright on the
 * attack and mellow in the tail rather than buzzing all the way through.
 */
function fm(rig, carrier, { t, freq, ratio, index, decay, floor = 0.02 }) {
  const mod = rig.osc('sine', freq * ratio, t);
  const depth = rig.gain(Math.max(index, SILENCE));
  mod.connect(depth);
  depth.connect(carrier.frequency);
  depth.gain.setValueAtTime(Math.max(index, SILENCE), t);
  depth.gain.exponentialRampToValueAtTime(Math.max(index * floor, SILENCE), t + decay);
  return { mod, depth };
}

/** A low-frequency oscillator wired into an AudioParam. Returns the depth gain. */
function lfo(rig, param, { t, rate, depth }) {
  const osc = rig.osc('sine', rate, t);
  const amount = rig.gain(depth);
  osc.connect(amount);
  amount.connect(param);
  return amount;
}

/**
 * The pitched body of a drum: an oscillator whose frequency drops away as the
 * skin relaxes. The bend is most of what separates a kick from a tom.
 */
function membrane(rig, dest, {
  t, type = 'sine', from, to, bend, attack = 0.004, decay, peak, p = null, hold = 0, span = 1,
}) {
  // A drum's skin is the one oscillator a percussion patch can pick the shape
  // of, and the octave control moves the whole kit rather than one note.
  const shift = p ? Math.pow(2, p.source.octave) : 1;
  const osc = rig.osc(p ? p.source.shape1 : type, from * shift, t);
  const amp = rig.gain(SILENCE);
  osc.connect(amp);
  amp.connect(dest);
  osc.frequency.setValueAtTime(from * shift, t);
  osc.frequency.exponentialRampToValueAtTime(Math.max(to * shift, 20), t + bend);
  return struckEnv(amp.gain, t, { attack, decay, peak, hold, span }, p);
}

/**
 * Filtered noise burst: hats, slaps, ticks, mallet clicks, breath transients.
 * Pass `p` only where the burst IS the voice's amplitude envelope — a transient
 * layered under a tone keeps its own short shape, or the patch's attack would
 * swallow the very click it exists for.
 */
function noiseBurst(rig, dest, {
  t, colour = 'white', type = 'bandpass', freq, q = 1, decay, peak, attack = 0.002, rate = 1,
  p = null, hold = 0, span = 1,
}) {
  const source = rig.noise(t, { colour, rate });
  const filter = rig.filter(type, freq, q);
  const amp = rig.gain(SILENCE);
  source.connect(filter);
  filter.connect(amp);
  amp.connect(dest);
  const makeup = type === 'bandpass' ? noiseMakeup(freq, q, rig.sampleRate) : 1;
  const end = struckEnv(amp.gain, t, { attack, decay, peak: peak * makeup, hold, span }, p);
  rig.stopAt(source, end + 0.02);
  return end;
}

// ---------------------------------------------------------------------------
// 3b. The patch model
// ---------------------------------------------------------------------------

/**
 * A patch is the voice editor's view of a voice: the few controls a listener
 * can move without the voice stopping being that voice. Every voice publishes a
 * complete one as `defaults` — an honest description of what it already does,
 * so the editor opens on the sound you can hear rather than on a blank synth.
 *
 * Everything below is written so that no patch costs nothing: `patchFor()`
 * returns null and each helper falls through to the v2 path unchanged. That
 * matters because the engine only passes a patch for a voice the user has
 * actually edited, and an untouched voice must sound exactly as it did before
 * there was an editor at all.
 */

const FILTER_TYPES = ['lowpass', 'highpass', 'bandpass', 'notch'];
const OCTAVES = [-1, 0, 1];

const oneOf = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
const inRange = (value, lo, hi, fallback) => (
  Number.isFinite(value) ? clamp(value, lo, hi) : fallback
);
const part = (patch, key) => (patch[key] && typeof patch[key] === 'object' ? patch[key] : {});

/**
 * One oscillator slot from the two fields that can describe it: an explicit
 * shape number wins, then the legacy type string (sine→0, triangle→1,
 * sawtooth→2, square→3), then the voice's default. `null` in either field is
 * the single-oscillator setting for slot two. A patch may carry shapes,
 * strings, both, or neither — the engine's sanitiser is being upgraded in
 * step with this, but nothing here depends on which side lands first.
 */
function shapeOf(shape, osc, fallback, nullable) {
  if (nullable && shape === null) return null;
  if (Number.isFinite(shape)) return clamp(shape, 0, 3);
  const legacy = OSC_TYPES.indexOf(osc);
  if (legacy >= 0) return legacy;
  if (nullable && osc === null) return null;
  return fallback;
}

/**
 * Merge a partial patch over a voice's defaults and clamp every field to the
 * schema. The engine sanitises too, but a voice that trusts its caller is one
 * NaN away from a silent track for the rest of the session, so nothing here
 * believes a number until it has checked it.
 */
function patchFor(defaults, patch) {
  if (!patch || typeof patch !== 'object') return null;
  const source = part(patch, 'source');
  const filter = part(patch, 'filter');
  const shape = part(patch, 'adsr');
  const sends = part(patch, 'sends');
  const d = defaults;
  const shape1 = shapeOf(source.shape1, source.osc1, d.source.shape1, false);
  const shape2 = shapeOf(source.shape2, source.osc2, d.source.shape2, true);
  return {
    source: {
      shape1,
      shape2,
      // The strings ride along as the nearest canonical shapes, for anything
      // still reading the legacy fields off a sanitised patch.
      osc1: OSC_TYPES[clamp(Math.round(shape1), 0, 3)],
      osc2: shape2 === null ? null : OSC_TYPES[clamp(Math.round(shape2), 0, 3)],
      mix: inRange(source.mix, 0, 1, d.source.mix),
      detune: inRange(source.detune, 0, 50, d.source.detune),
      octave: oneOf(source.octave, OCTAVES, d.source.octave),
    },
    filter: {
      type: oneOf(filter.type, FILTER_TYPES, d.filter.type),
      cutoff: inRange(filter.cutoff, 40, 12000, d.filter.cutoff),
      q: inRange(filter.q, 0.1, 20, d.filter.q),
      envAmount: inRange(filter.envAmount, 0, 1, d.filter.envAmount),
    },
    adsr: {
      attack: inRange(shape.attack, 0.001, 8, d.adsr.attack),
      decay: inRange(shape.decay, 0.001, 8, d.adsr.decay),
      sustain: inRange(shape.sustain, 0, 1, d.adsr.sustain),
      release: inRange(shape.release, 0.01, 12, d.adsr.release),
    },
    // Carried for completeness only: the engine reads sends off the defaults
    // and drives its own per-track send gains with them.
    sends: {
      reverb: inRange(sends.reverb, 0, 1, d.sends.reverb),
      delay: inRange(sends.delay, 0, 1, d.sends.delay),
    },
  };
}

/** A frequency after the patch's octave shift; the identity without a patch. */
const shifted = (p, f) => (p ? f * Math.pow(2, p.source.octave) : f);

/**
 * Re-balance a subtractive voice's oscillator layers under a patch.
 *
 * Layers declare the group they belong to ('b' is the osc2 group), their native
 * weight, their native detune in cents, and `spread` — where they sit in the
 * detune field, in units of the voice's default detune. Total weight is
 * conserved across the mix, so no mix setting can make a voice louder than it
 * already is, and at the voice's own default mix and detune the numbers come
 * back out exactly as they were written.
 */
function layersFor(p, layers) {
  if (!p) {
    return layers.map((l) => ({ type: l.type, ratio: l.ratio, gain: l.weight, cents: l.cents }));
  }
  const total = layers.reduce((sum, l) => sum + l.weight, 0);
  const b = layers.reduce((sum, l) => sum + (l.group === 'b' ? l.weight : 0), 0);
  const a = total - b;
  // No osc2 layer to cross into means mix has nothing to do: a voice built on
  // one oscillator must not be able to fade itself out.
  const mix = p.source.shape2 === null || b <= 0 ? 0 : p.source.mix;
  const scaleA = a > 0 ? (total * (1 - mix)) / a : 0;
  const scaleB = b > 0 ? (total * mix) / b : 0;
  return layers.map((l) => ({
    type: l.group === 'b' && p.source.shape2 !== null ? p.source.shape2 : p.source.shape1,
    ratio: l.ratio,
    gain: Math.max(l.weight * (l.group === 'b' ? scaleB : scaleA), SILENCE),
    cents: l.spread * p.source.detune,
  }));
}

/**
 * A resonant filter peaks at its cutoff, so a patch winding Q up would walk a
 * voice past the level it is supposed to hold. This is the trim that stops it:
 * unity at the voice's own Q, quieter above it, never louder.
 */
const qTrim = (q) => Math.min(1, 1 / Math.sqrt(Math.max(q, 1)));

/**
 * The voice's main filter. Without a patch it is exactly the filter the voice
 * asked for, and its own node is the output; with one it is the patch's
 * type/cutoff/Q, with the resonance trim spliced behind it.
 */
function mainFilter(rig, p, { type, freq, q = 1 }) {
  if (!p) {
    const node = rig.filter(type, freq, q);
    return { node, out: node };
  }
  const node = rig.filter(p.filter.type, p.filter.cutoff, p.filter.q);
  const trim = rig.gain(Math.min(1, qTrim(p.filter.q) / qTrim(q)));
  node.connect(trim);
  return { node, out: trim };
}

/**
 * A filter for a voice that has none of its own: `dest` untouched without a
 * patch, otherwise the input of a patch filter feeding `dest`.
 */
function insertFilter(rig, p, dest) {
  if (!p) return dest;
  const node = rig.filter(p.filter.type, p.filter.cutoff, p.filter.q);
  const trim = rig.gain(qTrim(p.filter.q));
  node.connect(trim);
  trim.connect(dest);
  return node;
}

/**
 * Maps a cutoff the voice wanted onto the patch's filter: the voice's sweep is
 * read as a ratio around its own nominal cutoff and re-applied around the
 * patch's, raised to envAmount — so envAmount 1 is the voice's own movement
 * transposed, and 0 is a filter that does not move at all.
 */
function cutoffAt(p, nominal) {
  if (!p) return (hz) => hz;
  const base = Math.max(nominal, 10);
  return (hz) => clamp(
    p.filter.cutoff * Math.pow(Math.max(hz, 10) / base, p.filter.envAmount), 20, 18000,
  );
}

/** How much of a voice's own filter movement survives the patch. */
const envDepth = (p) => (p ? p.filter.envAmount : 1);

/**
 * A patch's ADSR in the same all-exponential currency as env() and hit(): rise
 * to the peak, fall to the sustain level, hold there for the note, release.
 * Sustain 0 ends the note at the decay, the way a struck voice does, and `span`
 * lets one partial of a stack ring for its own fraction of the whole.
 */
function adsrEnv(param, t0, { hold = 0, peak }, adsr, span = 1) {
  const top = Math.max(peak, SILENCE * 2);
  const sustain = peak * adsr.sustain;
  const decayEnd = t0 + adsr.attack + Math.max(adsr.decay * span, 0.002);
  param.setValueAtTime(SILENCE, t0);
  param.exponentialRampToValueAtTime(top, t0 + adsr.attack);
  if (sustain <= SILENCE * 2) {
    param.exponentialRampToValueAtTime(SILENCE, decayEnd);
    return decayEnd;
  }
  param.exponentialRampToValueAtTime(sustain, decayEnd);
  const sustainEnd = Math.max(decayEnd, t0 + adsr.attack + Math.max(hold, 0));
  const release = Math.max(adsr.release * span, 0.01);
  param.setValueAtTime(sustain, sustainEnd);
  param.exponentialRampToValueAtTime(SILENCE, sustainEnd + release);
  return sustainEnd + release;
}

/** env() under a patch: the patch's ADSR replaces the voice's own shape. */
function sustainEnv(param, t0, base, p) {
  return p ? adsrEnv(param, t0, base, p.adsr) : env(param, t0, base);
}

/** hit() under a patch — the same, with `span` scaling a partial's ring. */
function struckEnv(param, t0, base, p) {
  return p ? adsrEnv(param, t0, base, p.adsr, base.span === undefined ? 1 : base.span) : hit(param, t0, base);
}

/**
 * What every voice sounds like today, in the schema's terms.
 *
 * Sources publish both a numeric shape1/shape2 (the morph dial, v5) and the
 * legacy osc1/osc2 strings they correspond to, per the contract's
 * compatibility note; the numbers are authoritative, the strings are for
 * readers that predate the dial.
 *
 * Cutoffs are the voice's own base cutoff evaluated at its fallback pitch and
 * velocity 0.7, so applying a voice's defaults reproduces it at that pitch;
 * ADSR times are its shape for a note of typical length. `envAmount` is 1 for a
 * voice whose filter moves and 0 for one whose filter sits still, and a voice
 * with no filter of its own publishes a wide-open lowpass — the nearest the
 * schema comes to saying "none". Sends are per-voice taste: pads and textures
 * sit back in the room, bass stays dry, arps and percussion in between.
 */
const DEFAULTS = {
  pad: {
    warm: {
      source: {
        osc1: 'sawtooth', osc2: 'triangle', shape1: 2, shape2: 1, mix: 0.52, detune: 8, octave: 0,
      },
      filter: { type: 'lowpass', cutoff: 440, q: 0.7, envAmount: 1 },
      adsr: { attack: 2.4, decay: 0.01, sustain: 1, release: 4.25 },
      sends: { reverb: 0.6, delay: 0.25 },
    },
    glass: {
      source: { osc1: 'sine', osc2: null, shape1: 0, shape2: null, mix: 0, detune: 4, octave: 0 },
      filter: { type: 'highpass', cutoff: 180, q: 0.5, envAmount: 0 },
      adsr: { attack: 2.1, decay: 0.01, sustain: 1, release: 5 },
      sends: { reverb: 0.7, delay: 0.35 },
    },
    strings: {
      source: {
        osc1: 'sawtooth', osc2: 'sawtooth', shape1: 2, shape2: 2, mix: 0.4, detune: 14, octave: 0,
      },
      filter: { type: 'lowpass', cutoff: 1080, q: 0.8, envAmount: 0 },
      adsr: { attack: 1.8, decay: 0.01, sustain: 1, release: 3.75 },
      sends: { reverb: 0.6, delay: 0.2 },
    },
    choir: {
      source: {
        osc1: 'sawtooth', osc2: 'sawtooth', shape1: 2, shape2: 2, mix: 0.5, detune: 9, octave: 0,
      },
      filter: { type: 'lowpass', cutoff: 1800, q: 0.5, envAmount: 1 },
      adsr: { attack: 2.1, decay: 0.01, sustain: 1, release: 4.25 },
      sends: { reverb: 0.7, delay: 0.25 },
    },
  },
  bass: {
    sub: {
      source: {
        osc1: 'sine', osc2: 'sine', shape1: 0, shape2: 0, mix: 0.118, detune: 0, octave: 0,
      },
      filter: { type: 'lowpass', cutoff: 228, q: 0.6, envAmount: 0 },
      adsr: { attack: 0.12, decay: 0.01, sustain: 1, release: 0.75 },
      sends: { reverb: 0.08, delay: 0 },
    },
    round: {
      source: {
        osc1: 'triangle', osc2: 'sine', shape1: 1, shape2: 0, mix: 0.333, detune: 0, octave: 0,
      },
      filter: { type: 'lowpass', cutoff: 585, q: 1.4, envAmount: 1 },
      adsr: { attack: 0.05, decay: 0.01, sustain: 1, release: 0.55 },
      sends: { reverb: 0.12, delay: 0.05 },
    },
    breath: {
      source: { osc1: 'sine', osc2: null, shape1: 0, shape2: null, mix: 0, detune: 0, octave: 0 },
      filter: { type: 'lowpass', cutoff: 12000, q: 0.7, envAmount: 0 },
      adsr: { attack: 0.18, decay: 0.01, sustain: 1, release: 0.9 },
      sends: { reverb: 0.18, delay: 0.05 },
    },
  },
  melody: {
    pluck: {
      source: {
        osc1: 'sawtooth', osc2: 'sawtooth', shape1: 2, shape2: 2, mix: 0.267, detune: 6, octave: 0,
      },
      filter: { type: 'lowpass', cutoff: 3520, q: 4, envAmount: 1 },
      adsr: { attack: 0.006, decay: 1.1, sustain: 0, release: 0.05 },
      sends: { reverb: 0.4, delay: 0.35 },
    },
    bell: {
      source: { osc1: 'sine', osc2: null, shape1: 0, shape2: null, mix: 0, detune: 6, octave: 0 },
      filter: { type: 'highpass', cutoff: 140, q: 0.6, envAmount: 0 },
      adsr: { attack: 0.005, decay: 2.4, sustain: 0, release: 0.05 },
      sends: { reverb: 0.55, delay: 0.4 },
    },
    flute: {
      source: { osc1: 'sine', osc2: null, shape1: 0, shape2: null, mix: 0, detune: 0, octave: 0 },
      filter: { type: 'lowpass', cutoff: 12000, q: 0.7, envAmount: 0 },
      adsr: { attack: 0.09, decay: 0.01, sustain: 1, release: 0.32 },
      sends: { reverb: 0.45, delay: 0.25 },
    },
    keys: {
      source: { osc1: 'sine', osc2: null, shape1: 0, shape2: null, mix: 0, detune: 0, octave: 0 },
      filter: { type: 'lowpass', cutoff: 4280, q: 0.7, envAmount: 0 },
      adsr: { attack: 0.004, decay: 1.7, sustain: 0, release: 0.05 },
      sends: { reverb: 0.35, delay: 0.3 },
    },
  },
  texture: {
    sparkle: {
      source: { osc1: 'sine', osc2: null, shape1: 0, shape2: null, mix: 0, detune: 0, octave: 0 },
      filter: { type: 'highpass', cutoff: 500, q: 0.6, envAmount: 0 },
      adsr: { attack: 0.02, decay: 1.5, sustain: 0, release: 0.05 },
      sends: { reverb: 0.8, delay: 0.5 },
    },
    grains: {
      source: { osc1: 'sine', osc2: null, shape1: 0, shape2: null, mix: 0, detune: 0, octave: 0 },
      filter: { type: 'lowpass', cutoff: 12000, q: 0.7, envAmount: 0 },
      adsr: { attack: 0.01, decay: 0.01, sustain: 1, release: 0.2 },
      sends: { reverb: 0.75, delay: 0.4 },
    },
    chimes: {
      source: { osc1: 'sine', osc2: null, shape1: 0, shape2: null, mix: 0, detune: 3, octave: 0 },
      filter: { type: 'highpass', cutoff: 250, q: 0.5, envAmount: 0 },
      adsr: { attack: 0.008, decay: 6.3, sustain: 0, release: 0.05 },
      sends: { reverb: 0.8, delay: 0.45 },
    },
    wash: {
      source: { osc1: 'sine', osc2: null, shape1: 0, shape2: null, mix: 0, detune: 0, octave: 0 },
      filter: { type: 'bandpass', cutoff: 320, q: 1.2, envAmount: 1 },
      adsr: { attack: 2.4, decay: 0.01, sustain: 1, release: 3.25 },
      sends: { reverb: 0.85, delay: 0.3 },
    },
  },
  arp: {
    softPluck: {
      source: {
        osc1: 'triangle', osc2: 'sine', shape1: 1, shape2: 0, mix: 0.167, detune: 0, octave: 0,
      },
      filter: { type: 'lowpass', cutoff: 2640, q: 1.6, envAmount: 1 },
      adsr: { attack: 0.006, decay: 0.47, sustain: 0, release: 0.05 },
      sends: { reverb: 0.35, delay: 0.4 },
    },
    crystal: {
      source: { osc1: 'sine', osc2: null, shape1: 0, shape2: null, mix: 0, detune: 0, octave: 0 },
      filter: { type: 'highpass', cutoff: 350, q: 0.7, envAmount: 0 },
      adsr: { attack: 0.003, decay: 0.525, sustain: 0, release: 0.05 },
      sends: { reverb: 0.45, delay: 0.5 },
    },
    marimba: {
      source: { osc1: 'sine', osc2: null, shape1: 0, shape2: null, mix: 0, detune: 0, octave: 0 },
      filter: { type: 'lowpass', cutoff: 3184, q: 0.8, envAmount: 0 },
      adsr: { attack: 0.003, decay: 0.53, sustain: 0, release: 0.05 },
      sends: { reverb: 0.3, delay: 0.35 },
    },
  },
  percussion: {
    soft: {
      source: { osc1: 'sine', osc2: null, shape1: 0, shape2: null, mix: 0, detune: 0, octave: 0 },
      filter: { type: 'lowpass', cutoff: 1390, q: 0.8, envAmount: 0 },
      adsr: { attack: 0.006, decay: 0.3, sustain: 0, release: 0.05 },
      sends: { reverb: 0.2, delay: 0.1 },
    },
    hand: {
      source: { osc1: 'sine', osc2: null, shape1: 0, shape2: null, mix: 0, detune: 0, octave: 0 },
      filter: { type: 'lowpass', cutoff: 12000, q: 0.7, envAmount: 0 },
      adsr: { attack: 0.004, decay: 0.15, sustain: 0, release: 0.05 },
      sends: { reverb: 0.25, delay: 0.12 },
    },
    tick: {
      source: { osc1: 'sine', osc2: null, shape1: 0, shape2: null, mix: 0, detune: 0, octave: 0 },
      filter: { type: 'lowpass', cutoff: 12000, q: 0.7, envAmount: 0 },
      adsr: { attack: 0.0015, decay: 0.035, sustain: 0, release: 0.05 },
      sends: { reverb: 0.3, delay: 0.2 },
    },
  },
};

/** The published defaults are reference data; nobody gets to edit them in place. */
for (const track of Object.values(DEFAULTS)) {
  for (const patch of Object.values(track)) {
    for (const group of Object.values(patch)) Object.freeze(group);
    Object.freeze(patch);
  }
  Object.freeze(track);
}
Object.freeze(DEFAULTS);

// ---------------------------------------------------------------------------
// 4a. Pads — long attacks, long releases, movement in the filter
// ---------------------------------------------------------------------------

/** Warm: a detuned saw/triangle stack under a slowly opening lowpass. */
function padWarm(ctx, destination, note, patch) {
  const rig = createRig(ctx, destination, note);
  const p = patchFor(DEFAULTS.pad.warm, patch);
  const t = timeOf(ctx, note);
  const f = shifted(p, freqOf(note, 220));
  const v = velOf(note);
  const dur = durOf(note, 6);

  const attack = p ? p.adsr.attack : clamp(dur * 0.4, 1.6, 3.2);
  const release = p ? p.adsr.release : between(3.5, 5);
  const hold = Math.max(0.3, dur - attack);

  const amp = rig.gain(SILENCE);
  const { node: lowpass, out: filtered } = mainFilter(rig, p, { type: 'lowpass', freq: f * 2, q: 0.7 });
  amp.connect(lowpass);
  filtered.connect(rig.out);

  const at = cutoffAt(p, f * 2);
  const open = clamp(f * (4 + 3 * v), 500, 4200);
  lowpass.frequency.setValueAtTime(at(Math.max(f * 1.5, 110)), t);
  lowpass.frequency.exponentialRampToValueAtTime(at(open), t + attack * 1.3);
  lowpass.frequency.setTargetAtTime(at(Math.max(open * 0.45, 220)), t + attack + hold, release * 0.5);
  // A held chord that never moves reads as synthetic; this is the slow breath.
  lfo(rig, lowpass.frequency, {
    t, rate: between(0.05, 0.11), depth: at(open) * 0.16 * envDepth(p),
  });

  const layers = layersFor(p, [
    { type: 'sawtooth', group: 'a', ratio: 1, weight: 0.26, cents: -7, spread: -0.875 },
    { type: 'sawtooth', group: 'a', ratio: 1, weight: 0.22, cents: 8, spread: 1 },
    { type: 'triangle', group: 'b', ratio: 1, weight: 0.3, cents: 2, spread: 0.25 },
    { type: 'triangle', group: 'b', ratio: 0.5, weight: 0.22, cents: -3, spread: -0.375 },
  ]);
  for (const layer of layers) {
    const osc = rig.osc(layer.type, f * layer.ratio, t, layer.cents);
    const gain = rig.gain(layer.gain);
    osc.connect(gain);
    gain.connect(amp);
  }

  const end = sustainEnv(amp.gain, t, { attack, hold, release, peak: level(PEAK.pad, v) }, p);
  return rig.finish(end + 0.05);
}

/** Glass: additive sine partials that fade in out of step, with FM shimmer. */
function padGlass(ctx, destination, note, patch) {
  const rig = createRig(ctx, destination, note);
  const p = patchFor(DEFAULTS.pad.glass, patch);
  const t = timeOf(ctx, note);
  const f = shifted(p, freqOf(note, 220));
  const v = velOf(note);
  const dur = durOf(note, 6);

  const attack = p ? p.adsr.attack : clamp(dur * 0.35, 1.5, 2.8);
  const release = p ? p.adsr.release : between(4, 6);
  const hold = Math.max(0.3, dur - attack);

  const amp = rig.gain(SILENCE);
  const { node: highpass, out: filtered } = mainFilter(rig, p, { type: 'highpass', freq: 180, q: 0.5 });
  amp.connect(highpass);
  filtered.connect(rig.out);

  // Slightly stretched partials: harmonic enough to be a chord tone, detuned
  // enough to ring like struck glass. The patch's detune is that scatter — the
  // stack is additive, so osc types and mix have nothing to bite on here.
  const jitter = p ? p.source.detune : 4;
  const partials = [[1, 0.4], [2, 0.2], [3.01, 0.14], [4.98, 0.09], [6.97, 0.05]];
  partials.forEach(([ratio, mix], i) => {
    const start = t + i * 0.28;
    const osc = rig.osc('sine', f * ratio, start, between(-jitter, jitter));
    const gain = rig.gain(SILENCE);
    osc.connect(gain);
    gain.connect(amp);
    // Each partial arrives in its own time, so the pad assembles rather than
    // starts; the tremolo keeps the upper ones alive underneath.
    gain.gain.setValueAtTime(SILENCE, start);
    gain.gain.exponentialRampToValueAtTime(mix, start + attack * 0.7);
    if (i > 0) lfo(rig, gain.gain, { t: start, rate: between(0.08, 0.22), depth: mix * 0.35 });
  });

  const carrier = rig.osc('sine', f, t);
  const carrierGain = rig.gain(0.12);
  carrier.connect(carrierGain);
  carrierGain.connect(amp);
  const shimmer = fm(rig, carrier, {
    t, freq: f, ratio: 3.5, index: f * (0.1 + 0.2 * v), decay: attack, floor: 0.5,
  });
  lfo(rig, shimmer.depth.gain, { t, rate: 0.07, depth: f * 0.08 });

  const end = sustainEnv(amp.gain, t, {
    attack, hold, release, peak: level(PEAK.pad * 1.05, v),
  }, p);
  return rig.finish(end + 0.05);
}

/** Strings: a five-voice sawtooth ensemble through a two-tap modulated chorus. */
function padStrings(ctx, destination, note, patch) {
  const rig = createRig(ctx, destination, note);
  const p = patchFor(DEFAULTS.pad.strings, patch);
  const t = timeOf(ctx, note);
  const f = shifted(p, freqOf(note, 220));
  const v = velOf(note);
  const dur = durOf(note, 6);

  const attack = p ? p.adsr.attack : clamp(dur * 0.3, 1.5, 2.6);
  const release = p ? p.adsr.release : between(3, 4.5);
  const hold = Math.max(0.3, dur - attack);

  const amp = rig.gain(SILENCE);
  const { node: lowpass, out: filtered } = mainFilter(rig, p, {
    type: 'lowpass', freq: clamp(f * 6 * brightness(v), 700, 5000), q: 0.8,
  });
  amp.connect(lowpass);

  const dry = rig.gain(0.6);
  filtered.connect(dry);
  dry.connect(rig.out);

  // Two short delays with independent slow modulation: the classic ensemble
  // effect, and the only width a mono oscillator stack can get.
  for (const [time, rate, mix] of [[0.0121, 0.61, 0.35], [0.0193, 0.43, 0.32]]) {
    const delay = rig.delay(time);
    const gain = rig.gain(mix);
    filtered.connect(delay);
    delay.connect(gain);
    gain.connect(rig.out);
    lfo(rig, delay.delayTime, { t, rate, depth: 0.0028 });
  }

  // The outer pair of the ensemble is the osc2 group: widening the mix pushes
  // the section outwards rather than adding a second instrument.
  const layers = layersFor(p, [
    { type: 'sawtooth', group: 'b', ratio: 1, weight: 0.2, cents: -14, spread: -1 },
    { type: 'sawtooth', group: 'a', ratio: 1, weight: 0.2, cents: -7, spread: -0.5 },
    { type: 'sawtooth', group: 'a', ratio: 1, weight: 0.2, cents: 0, spread: 0 },
    { type: 'sawtooth', group: 'a', ratio: 1, weight: 0.2, cents: 7, spread: 0.5 },
    { type: 'sawtooth', group: 'b', ratio: 1, weight: 0.2, cents: 14, spread: 1 },
  ]);
  for (const layer of layers) {
    const osc = rig.osc(layer.type, f * layer.ratio, t, layer.cents + between(-2, 2));
    const gain = rig.gain(layer.gain);
    osc.connect(gain);
    gain.connect(amp);
    // Individual drift keeps the unison from locking into a static beat.
    lfo(rig, osc.detune, { t, rate: between(0.09, 0.3), depth: between(1.5, 4) });
  }

  const end = sustainEnv(amp.gain, t, {
    attack, hold, release, peak: level(PEAK.pad * 0.9, v),
  }, p);
  return rig.finish(end + 0.05);
}

/** Choir: saw and breath through two bandpass formants that drift ooh → aah. */
function padChoir(ctx, destination, note, patch) {
  const rig = createRig(ctx, destination, note);
  const p = patchFor(DEFAULTS.pad.choir, patch);
  const t = timeOf(ctx, note);
  const f = shifted(p, freqOf(note, 220));
  const v = velOf(note);
  const dur = durOf(note, 6);

  const attack = p ? p.adsr.attack : clamp(dur * 0.35, 1.8, 3.5);
  const release = p ? p.adsr.release : between(3.5, 5);
  const hold = Math.max(0.3, dur - attack);

  const amp = rig.gain(SILENCE);
  const { node: tame, out: filtered } = mainFilter(rig, p, {
    type: 'lowpass', freq: clamp(f * 8, 1800, 4000), q: 0.5,
  });
  amp.connect(tame);
  filtered.connect(rig.out);

  const source = rig.gain(1);
  // /u/ on entry, opening towards /a/ as the note settles: the vowel change is
  // what makes filtered saw read as voices rather than as a filter sweep. The
  // vowel is this voice's filter movement, so envAmount is how far it travels.
  const formants = [[320, 730, 8, 1], [800, 1090, 9, 0.55]];
  for (const [from, to, q, mix] of formants) {
    const band = rig.filter('bandpass', from, q);
    const gain = rig.gain(mix);
    source.connect(band);
    band.connect(gain);
    gain.connect(amp);
    band.frequency.setValueAtTime(from, t);
    band.frequency.setTargetAtTime(from + (to - from) * envDepth(p), t + attack * 0.4, attack * 0.7);
    lfo(rig, band.frequency, { t, rate: between(0.11, 0.2), depth: from * 0.06 * envDepth(p) });
  }

  const layers = layersFor(p, [
    { type: 'sawtooth', group: 'a', ratio: 1, weight: 0.34, cents: -9, spread: -1 },
    { type: 'sawtooth', group: 'b', ratio: 1, weight: 0.34, cents: 5, spread: 0.5556 },
  ]);
  for (const layer of layers) {
    const osc = rig.osc(layer.type, f * layer.ratio, t, layer.cents);
    const gain = rig.gain(layer.gain);
    osc.connect(gain);
    gain.connect(source);
    // Vibrato arrives late, the way a held sung note does.
    const depth = lfo(rig, osc.detune, { t, rate: between(4.4, 5.2), depth: 1 });
    depth.gain.setValueAtTime(0, t);
    depth.gain.setTargetAtTime(between(5, 8), t + 1, 0.9);
  }

  const breath = rig.noise(t, { colour: 'pink' });
  const breathBand = rig.filter('bandpass', clamp(f * 4, 400, 3000), 1.2);
  const breathGain = rig.gain(0.1);
  breath.connect(breathBand);
  breathBand.connect(breathGain);
  breathGain.connect(source);

  const end = sustainEnv(amp.gain, t, {
    attack, hold, release, peak: level(PEAK.pad * 1.1, v),
  }, p);
  return rig.finish(end + 0.05);
}

// ---------------------------------------------------------------------------
// 4b. Bass — one clean fundamental, nothing detuned down there
// ---------------------------------------------------------------------------

/** Sub: a single sine with a whisper of second harmonic for small speakers. */
function bassSub(ctx, destination, note, patch) {
  const rig = createRig(ctx, destination, note);
  const p = patchFor(DEFAULTS.bass.sub, patch);
  const t = timeOf(ctx, note);
  const f = shifted(p, freqOf(note, 65));
  const v = velOf(note);
  const dur = durOf(note, 2);

  const amp = rig.gain(SILENCE);
  const { node: lowpass, out: filtered } = mainFilter(rig, p, {
    type: 'lowpass', freq: clamp(f * 3.5, 90, 260), q: 0.6,
  });
  amp.connect(lowpass);
  filtered.connect(rig.out);

  const attack = p ? p.adsr.attack : 0.12;
  const release = p ? p.adsr.release : 0.75;
  const hold = Math.max(0.1, dur - attack);

  // Untuned unison would beat against itself at these frequencies, so the only
  // colour is a fixed octave partial well below the fundamental's level — and
  // the patch's detune, if asked for, goes on that partial alone.
  const layers = layersFor(p, [
    { type: 'sine', group: 'a', ratio: 1, weight: 0.9, cents: 0, spread: 0 },
    { type: 'sine', group: 'b', ratio: 2, weight: 0.12, cents: 0, spread: 1 },
  ]);
  for (const layer of layers) {
    const osc = rig.osc(layer.type, f * layer.ratio, t, layer.cents);
    const gain = rig.gain(layer.gain);
    osc.connect(gain);
    gain.connect(amp);
  }

  const end = sustainEnv(amp.gain, t, { attack, hold, release, peak: level(PEAK.bass, v) }, p);
  return rig.finish(end + 0.05);
}

/** Round: triangle body with a soft filter fall — plucked, but with no edge. */
function bassRound(ctx, destination, note, patch) {
  const rig = createRig(ctx, destination, note);
  const p = patchFor(DEFAULTS.bass.round, patch);
  const t = timeOf(ctx, note);
  const f = shifted(p, freqOf(note, 65));
  const v = velOf(note);
  const dur = durOf(note, 2);

  const amp = rig.gain(SILENCE);
  const { node: lowpass, out: filtered } = mainFilter(rig, p, { type: 'lowpass', freq: f * 9, q: 1.4 });
  amp.connect(lowpass);
  filtered.connect(rig.out);

  const at = cutoffAt(p, f * 9);
  lowpass.frequency.setValueAtTime(at(clamp(f * (6 + 8 * v), 120, 2400)), t);
  lowpass.frequency.exponentialRampToValueAtTime(at(Math.max(f * 2.2, 80)), t + 0.4);

  const layers = layersFor(p, [
    { type: 'triangle', group: 'a', ratio: 1, weight: 0.7, cents: 0, spread: 0 },
    { type: 'sine', group: 'b', ratio: 1, weight: 0.35, cents: 0, spread: 1 },
  ]);
  for (const layer of layers) {
    const osc = rig.osc(layer.type, f * layer.ratio, t, layer.cents);
    const gain = rig.gain(layer.gain);
    osc.connect(gain);
    gain.connect(amp);
  }

  const attack = p ? p.adsr.attack : 0.05;
  const release = p ? p.adsr.release : 0.55;
  const hold = Math.max(0.1, dur - attack);
  const end = sustainEnv(amp.gain, t, {
    attack, hold, release, peak: level(PEAK.bass * 0.95, v),
  }, p);
  return rig.finish(end + 0.05);
}

/** Breath: a clean fundamental with a slow band of air swelling over it. */
function bassBreath(ctx, destination, note, patch) {
  const rig = createRig(ctx, destination, note);
  const p = patchFor(DEFAULTS.bass.breath, patch);
  const t = timeOf(ctx, note);
  const f = shifted(p, freqOf(note, 65));
  const v = velOf(note);
  const dur = durOf(note, 2);

  const amp = rig.gain(SILENCE);
  // No filter of its own: the patch's, if there is one, goes on the way out.
  amp.connect(insertFilter(rig, p, rig.out));

  const attack = p ? p.adsr.attack : 0.18;
  const release = p ? p.adsr.release : 0.9;
  const hold = Math.max(0.1, dur - attack);

  const [tone] = layersFor(p, [
    { type: 'sine', group: 'a', ratio: 1, weight: 0.85, cents: 0, spread: 0 },
  ]);
  const osc = rig.osc(tone.type, f * tone.ratio, t, tone.cents);
  const oscGain = rig.gain(tone.gain);
  osc.connect(oscGain);
  oscGain.connect(amp);

  const air = rig.noise(t, { colour: 'pink' });
  const band = rig.filter('bandpass', clamp(f * 4, 150, 900), 2.5);
  // Highpassing the noise above the fundamental keeps the bottom end clean;
  // low-frequency noise under a bass note is just mud.
  const clear = rig.filter('highpass', Math.max(f * 1.6, 90), 0.7);
  const airGain = rig.gain(SILENCE);
  air.connect(band);
  band.connect(clear);
  clear.connect(airGain);
  airGain.connect(amp);
  env(airGain.gain, t, {
    attack: attack * 2.5,
    hold: Math.max(0.05, hold - attack * 1.5),
    release,
    peak: 0.12 + 0.1 * v,
  });
  lfo(rig, band.frequency, { t, rate: 0.23, depth: f * 0.5 });

  const end = sustainEnv(amp.gain, t, {
    attack, hold, release, peak: level(PEAK.bass * 0.95, v),
  }, p);
  return rig.finish(end + 0.05);
}

// ---------------------------------------------------------------------------
// 4c. Melody
// ---------------------------------------------------------------------------

/** Pluck: a resonant filter falling fast across a saw pair, with a string tick. */
function melodyPluck(ctx, destination, note, patch) {
  const rig = createRig(ctx, destination, note);
  const p = patchFor(DEFAULTS.melody.pluck, patch);
  const t = timeOf(ctx, note);
  const f = shifted(p, freqOf(note, 440));
  const v = velOf(note);
  const dur = durOf(note, 1);

  const amp = rig.gain(SILENCE);
  const { node: lowpass, out: filtered } = mainFilter(rig, p, { type: 'lowpass', freq: f * 8, q: 4 });
  amp.connect(lowpass);
  filtered.connect(rig.out);

  // The whole character is here: a resonant cutoff dropping from bright to
  // near the fundamental in a quarter of a second.
  const at = cutoffAt(p, f * 8);
  lowpass.frequency.setValueAtTime(at(clamp(f * (5 + 12 * v), 300, 9000)), t);
  lowpass.frequency.exponentialRampToValueAtTime(at(Math.max(f * 1.8, 120)), t + 0.28);

  const layers = layersFor(p, [
    { type: 'sawtooth', group: 'a', ratio: 1, weight: 0.55, cents: 0, spread: 0 },
    { type: 'sawtooth', group: 'b', ratio: 1, weight: 0.2, cents: 6, spread: 1 },
  ]);
  for (const layer of layers) {
    const osc = rig.osc(layer.type, f * layer.ratio, t, layer.cents);
    const gain = rig.gain(layer.gain);
    osc.connect(gain);
    gain.connect(amp);
  }

  // The string tick sits outside the amp envelope — routed through it, the
  // 6 ms attack would swallow the very transient that sells the pluck.
  noiseBurst(rig, lowpass, {
    t, freq: clamp(f * 3, 200, 6000), q: 1, decay: 0.014, peak: 0.08 * v, attack: 0.001,
  });

  const decay = clamp(dur * 0.9 + 0.2, 0.35, 1.8);
  const end = struckEnv(amp.gain, t, {
    attack: 0.006, decay, hold: dur, peak: level(PEAK.melody, v),
  }, p);
  return rig.finish(end + 0.05);
}

/** Bell: inharmonic two-operator FM with a long, slowly beating shimmer. */
function melodyBell(ctx, destination, note, patch) {
  const rig = createRig(ctx, destination, note);
  // Two-operator FM: the carrier is a sine by definition, so osc types and mix
  // have nothing to act on. Detune moves the beating partial, octave the pitch.
  const p = patchFor(DEFAULTS.melody.bell, patch);
  const t = timeOf(ctx, note);
  const f = shifted(p, freqOf(note, 440));
  const v = velOf(note);
  const dur = durOf(note, 1);

  const amp = rig.gain(SILENCE);
  const { node: highpass, out: filtered } = mainFilter(rig, p, {
    type: 'highpass', freq: 140, q: 0.6,
  });
  amp.connect(highpass);
  filtered.connect(rig.out);

  const carrier = rig.osc('sine', f, t);
  const carrierGain = rig.gain(0.7);
  carrier.connect(carrierGain);
  carrierGain.connect(amp);
  // A non-integer ratio puts the partials off the harmonic series, which is
  // what a bell is; the index decay turns the clang into a hum.
  fm(rig, carrier, { t, freq: f, ratio: 3.47, index: f * (1.5 + 2.5 * v), decay: 0.8 });

  // A second, slightly detuned partial gives the tail a slow beat.
  const partial = rig.osc('sine', f * 2.76, t, p ? p.source.detune : 6);
  const partialGain = rig.gain(SILENCE);
  partial.connect(partialGain);
  partialGain.connect(amp);
  struckEnv(partialGain.gain, t, {
    attack: 0.005, decay: clamp(dur, 0.8, 2.5), hold: dur, span: 0.5, peak: 0.16,
  }, p);

  const decay = clamp(dur * 1.6 + 0.8, 1.8, 5);
  const end = struckEnv(amp.gain, t, {
    attack: 0.005, decay, hold: dur, peak: level(PEAK.melody * 0.95, v),
  }, p);
  return rig.finish(end + 0.05);
}

/** Flute: near-sine tone with breath noise and vibrato that arrives late. */
function melodyFlute(ctx, destination, note, patch) {
  const rig = createRig(ctx, destination, note);
  // A blown tone with its octave and its breath: nothing here is an oscillator
  // stack, so osc types, mix and detune have no meaning. Octave does.
  const p = patchFor(DEFAULTS.melody.flute, patch);
  const t = timeOf(ctx, note);
  const f = shifted(p, freqOf(note, 440));
  const v = velOf(note);
  const dur = durOf(note, 1);

  const amp = rig.gain(SILENCE);
  amp.connect(insertFilter(rig, p, rig.out));

  const attack = p ? p.adsr.attack : 0.09;
  const release = p ? p.adsr.release : 0.32;
  const hold = Math.max(0.06, dur - attack);

  const osc = rig.osc('sine', f, t);
  const oscGain = rig.gain(0.8);
  osc.connect(oscGain);
  oscGain.connect(amp);
  const octave = rig.osc('sine', f * 2, t);
  const octaveGain = rig.gain(Math.max(0.07 * v, SILENCE));
  octave.connect(octaveGain);
  octaveGain.connect(amp);

  // Silent at the onset, easing in over the first half second: vibrato on the
  // attack sounds like a synth, vibrato on the sustain sounds like a player.
  const vibrato = lfo(rig, osc.detune, { t, rate: 5.1, depth: 1 });
  vibrato.connect(octave.detune);
  vibrato.gain.setValueAtTime(0, t);
  vibrato.gain.setTargetAtTime(9, t + Math.min(0.45, dur * 0.4), 0.35);

  const air = rig.noise(t, { colour: 'pink' });
  const band = rig.filter('bandpass', clamp(f * 2.2, 300, 6000), 2.2);
  const airGain = rig.gain(SILENCE);
  air.connect(band);
  band.connect(airGain);
  airGain.connect(amp);
  // Breath peaks with the onset and settles back, as it does on a real blow.
  const breathPeak = Math.max(0.1 + 0.12 * v, SILENCE * 2);
  const breathSustain = Math.max(0.035 + 0.05 * v, SILENCE * 2);
  airGain.gain.setValueAtTime(SILENCE, t);
  airGain.gain.exponentialRampToValueAtTime(breathPeak, t + attack * 0.6);
  airGain.gain.exponentialRampToValueAtTime(breathSustain, t + attack + Math.min(0.25, hold * 0.5));
  airGain.gain.setValueAtTime(breathSustain, t + attack + hold);
  airGain.gain.exponentialRampToValueAtTime(SILENCE, t + attack + hold + release);

  const end = sustainEnv(amp.gain, t, {
    attack, hold, release, peak: level(PEAK.melody * 1.05, v),
  }, p);
  return rig.finish(end + 0.05);
}

/** Keys: electric-piano tine — sine carrier, self-ratio FM, velocity brightness. */
function melodyKeys(ctx, destination, note, patch) {
  const rig = createRig(ctx, destination, note);
  // FM again: sine carrier, sine modulator, so only octave applies from source.
  const p = patchFor(DEFAULTS.melody.keys, patch);
  const t = timeOf(ctx, note);
  const f = shifted(p, freqOf(note, 440));
  const v = velOf(note);
  const dur = durOf(note, 1);

  const amp = rig.gain(SILENCE);
  const { node: lowpass, out: filtered } = mainFilter(rig, p, {
    type: 'lowpass', freq: clamp(f * 6 + 2000 * brightness(v), 900, 9000), q: 0.7,
  });
  amp.connect(lowpass);
  filtered.connect(rig.out);

  const carrier = rig.osc('sine', f, t);
  const carrierGain = rig.gain(0.75);
  carrier.connect(carrierGain);
  carrierGain.connect(amp);
  // Ratio 1 keeps the added partials harmonic; the index scales with velocity,
  // so playing harder adds harmonics rather than just volume.
  fm(rig, carrier, { t, freq: f, ratio: 1, index: f * (0.5 + 2.2 * v * v), decay: 0.3 });

  // The tine itself: a short, high, quiet ping over the body of the note.
  const tine = rig.osc('sine', f * 4.02, t);
  const tineGain = rig.gain(SILENCE);
  tine.connect(tineGain);
  tineGain.connect(amp);
  struckEnv(tineGain.gain, t, {
    attack: 0.002, decay: 0.22, hold: dur, span: 0.13, peak: Math.max(0.14 * v * v, SILENCE * 2),
  }, p);

  const decay = clamp(dur * 1.3 + 0.4, 0.8, 3.2);
  const end = struckEnv(amp.gain, t, {
    attack: 0.004, decay, hold: dur, peak: level(PEAK.melody, v),
  }, p);
  return rig.finish(end + 0.05);
}

// ---------------------------------------------------------------------------
// 4d. Texture
// ---------------------------------------------------------------------------

/** Sparkle: two or three high FM glints, staggered, each with a long fade. */
function textureSparkle(ctx, destination, note, patch) {
  const rig = createRig(ctx, destination, note);
  // FM glints: sine carriers, so source is octave only.
  const p = patchFor(DEFAULTS.texture.sparkle, patch);
  const t = timeOf(ctx, note);
  const base = shifted(p, freqOf(note, 1568));
  const v = velOf(note);
  const dur = durOf(note, 3);

  const amp = rig.gain(1);
  const { node: highpass, out: filtered } = mainFilter(rig, p, {
    type: 'highpass', freq: 500, q: 0.6,
  });
  amp.connect(highpass);
  filtered.connect(rig.out);

  const glints = Math.random() < 0.5 ? 2 : 3;
  let end = t;
  for (let i = 0; i < glints; i++) {
    const at = t + i * between(0.08, 0.26);
    const freq = clamp(base * (i === 0 ? 1 : between(1.4, 2.1)), 400, 6000);
    const carrier = rig.osc('sine', freq, at);
    const gain = rig.gain(SILENCE);
    carrier.connect(gain);
    gain.connect(amp);
    // A high modulator ratio scatters energy into a thin band of upper
    // partials: a glint rather than a note.
    fm(rig, carrier, { t: at, freq, ratio: 7.1, index: freq * (0.8 + 1.4 * v), decay: 0.3 });
    const spread = between(0.8, 1.2);
    const decay = clamp(dur * 0.5, 1.1, 2.4) * spread;
    const done = struckEnv(gain.gain, at, {
      attack: 0.02, decay, hold: dur, span: spread,
      peak: level(PEAK.texture, v) * (i === 0 ? 1 : 0.55),
    }, p);
    if (done > end) end = done;
  }
  return rig.finish(end + 0.05);
}

/** Grains: a scatter of tiny enveloped noise bursts through resonant bands. */
function textureGrains(ctx, destination, note, patch) {
  const rig = createRig(ctx, destination, note);
  // A cloud of noise: no oscillators to re-type, so source is octave only, and
  // the patch's ADSR shapes the cloud rather than each grain inside it.
  const p = patchFor(DEFAULTS.texture.grains, patch);
  const t = timeOf(ctx, note);
  const base = shifted(p, freqOf(note, 880));
  const v = velOf(note);
  const dur = durOf(note, 2.5);

  const amp = rig.gain(1);
  amp.connect(insertFilter(rig, p, rig.out));

  const count = 6 + Math.floor(Math.random() * 4);
  const spread = clamp(dur, 0.8, 3.5);
  let end = t;
  for (let i = 0; i < count; i++) {
    const at = t + (i / count) * spread + between(0, spread / count);
    const ratio = [1, 1.5, 2, 3, 4][Math.floor(Math.random() * 5)];
    // Each grain gets its own narrow band and its own place in the field, so
    // the cloud has width even before the engine's reverb.
    const panner = rig.panner(between(-0.35, 0.35));
    panner.connect(amp);
    const done = noiseBurst(rig, panner, {
      t: at,
      freq: clamp(base * ratio, 200, 9000),
      q: 8 + Math.random() * 8,
      decay: between(0.05, 0.14),
      peak: level(PEAK.texture * 0.85, v) * between(0.6, 1),
      attack: 0.012,
    });
    if (done > end) end = done;
  }

  if (p) {
    // Unity at the top, so the contour only ever shapes the cloud — the grains
    // already carry the velocity.
    const contour = adsrEnv(amp.gain, t, { hold: spread, peak: 1 }, p.adsr);
    end = Math.max(end, contour);
  }
  return rig.finish(end + 0.05);
}

/** Chimes: tubular-bell partial stack with a mallet tick and a very long tail. */
function textureChimes(ctx, destination, note, patch) {
  const rig = createRig(ctx, destination, note);
  // A partial stack, so detune is the scatter between the tubes and source
  // otherwise has nothing to say.
  const p = patchFor(DEFAULTS.texture.chimes, patch);
  const t = timeOf(ctx, note);
  const f = clamp(shifted(p, freqOf(note, 880)), 200, 2200);
  const v = velOf(note);
  const dur = durOf(note, 4);

  const amp = rig.gain(1);
  const { node: highpass, out: filtered } = mainFilter(rig, p, {
    type: 'highpass', freq: 250, q: 0.5,
  });
  amp.connect(highpass);
  filtered.connect(rig.out);

  // Ratios from a struck tube: nothing here is a harmonic of anything else,
  // which is why the stack shimmers instead of fusing into one pitch.
  const partials = [[1, 0.42, 1], [2.76, 0.26, 0.7], [5.4, 0.16, 0.45], [8.93, 0.09, 0.28]];
  const life = clamp(dur * 1.2 + 1.5, 3, 7);
  const jitter = p ? p.source.detune : 3;
  let end = t;
  for (const [ratio, mix, span] of partials) {
    const osc = rig.osc('sine', f * ratio, t, between(-jitter, jitter));
    const gain = rig.gain(SILENCE);
    osc.connect(gain);
    gain.connect(amp);
    const done = struckEnv(gain.gain, t, {
      attack: 0.008, decay: life * span, hold: dur, span,
      peak: level(PEAK.texture, v) * mix * 2.4,
    }, p);
    if (done > end) end = done;
  }

  noiseBurst(rig, amp, {
    t, freq: clamp(f * 4, 800, 9000), q: 1.5, decay: 0.02, peak: 0.05 * v, attack: 0.001,
  });

  return rig.finish(end + 0.05);
}

/** Wash: pink noise swelling through a bandpass that sweeps up and back down. */
function textureWash(ctx, destination, note, patch) {
  const rig = createRig(ctx, destination, note);
  const p = patchFor(DEFAULTS.texture.wash, patch);
  const t = timeOf(ctx, note);
  const f = clamp(shifted(p, freqOf(note, 660)), 120, 3000);
  const v = velOf(note);
  const dur = durOf(note, 6);

  const amp = rig.gain(SILENCE);
  amp.connect(rig.out);

  const attack = p ? p.adsr.attack : clamp(dur * 0.4, 1.2, 3);
  const release = p ? p.adsr.release : between(2.5, 4);
  const hold = Math.max(0.3, dur - attack);

  // The sweeping band is this voice's filter, so the patch takes it over.
  const { node: band, out: filtered } = mainFilter(rig, p, {
    type: 'bandpass', freq: 320, q: 1.2,
  });
  filtered.connect(amp);
  const at = cutoffAt(p, 320);
  const top = clamp(f * 2.4 * brightness(v), 600, 5000);
  band.frequency.setValueAtTime(at(320), t);
  band.frequency.exponentialRampToValueAtTime(at(top), t + attack + hold * 0.4);
  band.frequency.exponentialRampToValueAtTime(at(420), t + attack + hold + release);
  lfo(rig, band.Q, { t, rate: 0.06, depth: 0.5 * envDepth(p) });

  // Two layers at slightly different playback rates decorrelate, which is what
  // makes a noise swell feel wide rather than flat. The makeup gain only makes
  // sense for a band: anything wider passes the noise whole already.
  const q = p ? p.filter.q : 1.2;
  const makeup = (p ? p.filter.type : 'bandpass') === 'bandpass'
    ? noiseMakeup(Math.sqrt(at(320) * at(top)), q, rig.sampleRate)
    : 1;
  for (const rate of [0.92, 1.07]) {
    const noise = rig.noise(t, { colour: 'pink', rate });
    const gain = rig.gain(0.5 * makeup);
    noise.connect(gain);
    gain.connect(band);
  }

  // A faint sine keeps the wash anchored to the current harmony.
  const [anchor] = layersFor(p, [
    { type: 'sine', group: 'a', ratio: 1, weight: 0.14, cents: 0, spread: 0 },
  ]);
  const tone = rig.osc(anchor.type, f * anchor.ratio, t, anchor.cents);
  const toneGain = rig.gain(anchor.gain);
  tone.connect(toneGain);
  toneGain.connect(amp);

  const end = sustainEnv(amp.gain, t, {
    attack, hold, release, peak: level(PEAK.texture * 1.6, v),
  }, p);
  return rig.finish(end + 0.05);
}

// ---------------------------------------------------------------------------
// 4e. Arpeggiator — short tails, so 1/16 at 120 bpm still articulates
// ---------------------------------------------------------------------------

/** Soft pluck: triangle with a quick filter fall and no bite at all. */
function arpSoftPluck(ctx, destination, note, patch) {
  const rig = createRig(ctx, destination, note);
  const p = patchFor(DEFAULTS.arp.softPluck, patch);
  const t = timeOf(ctx, note);
  const f = shifted(p, freqOf(note, 440));
  const v = velOf(note);
  const dur = durOf(note, 0.25);

  const amp = rig.gain(SILENCE);
  const { node: lowpass, out: filtered } = mainFilter(rig, p, {
    type: 'lowpass', freq: f * 6, q: 1.6,
  });
  amp.connect(lowpass);
  filtered.connect(rig.out);

  const at = cutoffAt(p, f * 6);
  lowpass.frequency.setValueAtTime(at(clamp(f * (4 + 6 * v), 300, 7000)), t);
  lowpass.frequency.exponentialRampToValueAtTime(at(Math.max(f * 2, 150)), t + 0.12);

  const layers = layersFor(p, [
    { type: 'triangle', group: 'a', ratio: 1, weight: 0.6, cents: 0, spread: 0 },
    { type: 'sine', group: 'b', ratio: 2, weight: 0.12, cents: 0, spread: 1 },
  ]);
  for (const layer of layers) {
    const osc = rig.osc(layer.type, f * layer.ratio, t, layer.cents);
    const gain = rig.gain(layer.gain);
    osc.connect(gain);
    gain.connect(amp);
  }

  const decay = clamp(dur * 1.4 + 0.12, 0.16, 0.5);
  const end = struckEnv(amp.gain, t, {
    attack: 0.006, decay, hold: dur, peak: level(PEAK.arp, v),
  }, p);
  return rig.finish(end + 0.03);
}

/** Crystal: glassy FM ping, bright and short, with a highpassed tail. */
function arpCrystal(ctx, destination, note, patch) {
  const rig = createRig(ctx, destination, note);
  // FM ping: sine carrier, so source offers octave and nothing else.
  const p = patchFor(DEFAULTS.arp.crystal, patch);
  const t = timeOf(ctx, note);
  const f = shifted(p, freqOf(note, 440));
  const v = velOf(note);
  const dur = durOf(note, 0.25);

  const amp = rig.gain(SILENCE);
  const { node: highpass, out: filtered } = mainFilter(rig, p, {
    type: 'highpass', freq: 350, q: 0.7,
  });
  amp.connect(highpass);
  filtered.connect(rig.out);

  const carrier = rig.osc('sine', f, t);
  const carrierGain = rig.gain(0.65);
  carrier.connect(carrierGain);
  carrierGain.connect(amp);
  fm(rig, carrier, { t, freq: f, ratio: 2.01, index: f * (1 + 2 * v), decay: 0.09 });

  const partial = rig.osc('sine', f * 4.01, t);
  const partialGain = rig.gain(SILENCE);
  partial.connect(partialGain);
  partialGain.connect(amp);
  struckEnv(partialGain.gain, t, {
    attack: 0.002, decay: 0.1, hold: dur, span: 0.2, peak: Math.max(0.12 * v, SILENCE * 2),
  }, p);

  const decay = clamp(dur * 1.5 + 0.15, 0.2, 0.55);
  const end = struckEnv(amp.gain, t, {
    attack: 0.003, decay, hold: dur, peak: level(PEAK.arp * 0.9, v),
  }, p);
  return rig.finish(end + 0.03);
}

/** Marimba: fundamental plus the bar's 4:1 overtone over a woody mallet tick. */
function arpMarimba(ctx, destination, note, patch) {
  const rig = createRig(ctx, destination, note);
  // A struck bar and its overtones: a partial stack, so source is octave only.
  const p = patchFor(DEFAULTS.arp.marimba, patch);
  const t = timeOf(ctx, note);
  const f = shifted(p, freqOf(note, 440));
  const v = velOf(note);
  const dur = durOf(note, 0.25);

  const amp = rig.gain(1);
  const { node: lowpass, out: filtered } = mainFilter(rig, p, {
    type: 'lowpass', freq: clamp(f * 5 + 1200 * brightness(v), 800, 7000), q: 0.8,
  });
  amp.connect(lowpass);
  filtered.connect(rig.out);

  // Low bars ring longer than high ones, as they do on the instrument.
  const life = clamp(dur * 1.4 + 0.18, 0.18, 0.6) * clamp(Math.pow(440 / f, 0.35), 0.7, 1.5);
  const peak = level(PEAK.arp * 0.85, v);
  let end = t;
  for (const [ratio, mix, span] of [[1, 1, 1], [4, 0.22, 0.35], [9.2, 0.07, 0.18]]) {
    const osc = rig.osc('sine', f * ratio, t);
    const gain = rig.gain(SILENCE);
    osc.connect(gain);
    gain.connect(amp);
    const done = struckEnv(gain.gain, t, {
      attack: 0.003, decay: life * span, hold: dur, span, peak: peak * mix,
    }, p);
    if (done > end) end = done;
  }

  noiseBurst(rig, amp, {
    t, freq: clamp(f * 3.5, 700, 4000), q: 1.2, decay: 0.008, peak: 0.07 * v, attack: 0.001,
  });

  return rig.finish(end + 0.03);
}

// ---------------------------------------------------------------------------
// 4f. Percussion — note.kind selects the drum; midi and freq are null
// ---------------------------------------------------------------------------

const KIND_TRIM = { low: 1, mid: 0.85, high: 0.5 };

function kindOf(note) {
  return note.kind === 'low' || note.kind === 'high' ? note.kind : 'mid';
}

/** Soft kit: muffled kick, warm tom, brushed hat. Nothing with a transient edge. */
function percSoft(ctx, destination, note, patch) {
  const rig = createRig(ctx, destination, note);
  // A kit has one filter control for three drums: whichever damp the struck
  // kind uses is the one the patch takes over.
  const p = patchFor(DEFAULTS.percussion.soft, patch);
  const t = timeOf(ctx, note);
  const v = velOf(note);
  const dur = durOf(note, 0.25);
  const kind = kindOf(note);
  const peak = level(PEAK.percussion * KIND_TRIM[kind], v);

  const amp = rig.gain(1);
  amp.connect(rig.out);
  let end = t;

  if (kind === 'low') {
    const { node: damp, out: damped } = mainFilter(rig, p, {
      type: 'lowpass', freq: 180 + 120 * v, q: 0.7,
    });
    damped.connect(amp);
    end = membrane(rig, damp, {
      t, from: 110, to: 44, bend: 0.09, attack: 0.008, decay: 0.36, peak, p, hold: dur,
    });
    // A little low thud under the tone: the beater, not the skin.
    noiseBurst(rig, damp, {
      t, colour: 'pink', type: 'lowpass', freq: 140, q: 0.7, decay: 0.05, peak: peak * 0.35,
      p, hold: dur, span: 0.14,
    });
  } else if (kind === 'mid') {
    const { node: damp, out: damped } = mainFilter(rig, p, {
      type: 'lowpass', freq: 900 + 700 * v, q: 0.8,
    });
    damped.connect(amp);
    end = membrane(rig, damp, {
      t, from: 190, to: 118, bend: 0.12, attack: 0.006, decay: 0.3, peak, p, hold: dur,
    });
    noiseBurst(rig, damp, {
      t, colour: 'pink', freq: 420, q: 1.6, decay: 0.11, peak: peak * 0.3, attack: 0.004,
      p, hold: dur, span: 0.37,
    });
  } else {
    const { node: air, out: aired } = mainFilter(rig, p, {
      type: 'highpass', freq: 5000 + 2500 * v, q: 0.7,
    });
    aired.connect(amp);
    end = noiseBurst(rig, air, {
      t, freq: 9000, q: 1.2, decay: 0.075, peak, attack: 0.004, p, hold: dur,
    });
  }

  return rig.finish(end + 0.03);
}

/** Hand drum: dum with a real pitch drop, an open slap, and a finger tick. */
function percHand(ctx, destination, note, patch) {
  const rig = createRig(ctx, destination, note);
  const p = patchFor(DEFAULTS.percussion.hand, patch);
  const t = timeOf(ctx, note);
  const v = velOf(note);
  const dur = durOf(note, 0.25);
  const kind = kindOf(note);
  const peak = level(PEAK.percussion * KIND_TRIM[kind], v);

  const amp = rig.gain(1);
  // The drum's own bands are its character; a patch filter sits across the kit.
  amp.connect(insertFilter(rig, p, rig.out));
  let end = t;

  if (kind === 'low') {
    // The wide, fast bend is the hand-drum signature: a struck head detunes
    // hard and then settles.
    end = membrane(rig, amp, {
      t, from: 165, to: 72, bend: 0.075, attack: 0.005, decay: 0.45, peak, p, hold: dur,
    });
    const ring = membrane(rig, amp, {
      t, type: 'triangle', from: 264, to: 170, bend: 0.06, attack: 0.004, decay: 0.1,
      peak: peak * 0.22, p, hold: dur, span: 0.22,
    });
    if (ring > end) end = ring;
    noiseBurst(rig, amp, {
      t, colour: 'pink', freq: 900, q: 1.4, decay: 0.03, peak: peak * 0.18, attack: 0.002,
      p, hold: dur, span: 0.067,
    });
  } else if (kind === 'mid') {
    end = membrane(rig, amp, {
      t, from: 320, to: 205, bend: 0.05, attack: 0.004, decay: 0.15, peak, p, hold: dur,
    });
    const slap = noiseBurst(rig, amp, {
      t, freq: 1800 + 900 * v, q: 1.3, decay: 0.08, peak: peak * 0.55, attack: 0.002,
      p, hold: dur, span: 0.53,
    });
    if (slap > end) end = slap;
  } else {
    end = noiseBurst(rig, amp, {
      t, freq: 3400 + 1800 * v, q: 2.6, decay: 0.05, peak, attack: 0.0015, p, hold: dur,
    });
    const tick = membrane(rig, amp, {
      t, from: 900, to: 700, bend: 0.02, attack: 0.002, decay: 0.03, peak: peak * 0.3,
      p, hold: dur, span: 0.6,
    });
    if (tick > end) end = tick;
  }

  return rig.finish(end + 0.03);
}

/** Ticks: the minimal kit — filtered clicks, barely more than punctuation. */
function percTick(ctx, destination, note, patch) {
  const rig = createRig(ctx, destination, note);
  const p = patchFor(DEFAULTS.percussion.tick, patch);
  const t = timeOf(ctx, note);
  const v = velOf(note);
  const dur = durOf(note, 0.25);
  const kind = kindOf(note);
  const peak = level(PEAK.percussion * KIND_TRIM[kind] * 0.8, v);

  const amp = rig.gain(1);
  amp.connect(insertFilter(rig, p, rig.out));
  let end = t;

  if (kind === 'low') {
    end = noiseBurst(rig, amp, {
      t, colour: 'pink', type: 'lowpass', freq: 240, q: 0.8, decay: 0.05, peak, attack: 0.003,
      p, hold: dur,
    });
    const body = membrane(rig, amp, {
      t, from: 96, to: 70, bend: 0.03, attack: 0.004, decay: 0.07, peak: peak * 0.7,
      p, hold: dur, span: 1.4,
    });
    if (body > end) end = body;
  } else if (kind === 'mid') {
    end = noiseBurst(rig, amp, {
      t, freq: 1100 + 700 * v, q: 6, decay: 0.035, peak, attack: 0.0015, p, hold: dur,
    });
  } else {
    end = noiseBurst(rig, amp, {
      t, type: 'highpass', freq: 7000 + 2000 * v, q: 0.8, decay: 0.022, peak, attack: 0.001,
      p, hold: dur,
    });
  }

  return rig.finish(end + 0.03);
}

// ---------------------------------------------------------------------------
// 5. The library
// ---------------------------------------------------------------------------

export const VOICES = {
  pad: {
    warm: { label: 'Warm', play: padWarm, defaults: DEFAULTS.pad.warm },
    glass: { label: 'Glass', play: padGlass, defaults: DEFAULTS.pad.glass },
    strings: { label: 'Strings', play: padStrings, defaults: DEFAULTS.pad.strings },
    choir: { label: 'Choir', play: padChoir, defaults: DEFAULTS.pad.choir },
  },
  bass: {
    sub: { label: 'Sub', play: bassSub, defaults: DEFAULTS.bass.sub },
    round: { label: 'Round', play: bassRound, defaults: DEFAULTS.bass.round },
    breath: { label: 'Breath', play: bassBreath, defaults: DEFAULTS.bass.breath },
  },
  melody: {
    pluck: { label: 'Pluck', play: melodyPluck, defaults: DEFAULTS.melody.pluck },
    bell: { label: 'Bell', play: melodyBell, defaults: DEFAULTS.melody.bell },
    flute: { label: 'Flute', play: melodyFlute, defaults: DEFAULTS.melody.flute },
    keys: { label: 'Keys', play: melodyKeys, defaults: DEFAULTS.melody.keys },
  },
  texture: {
    sparkle: { label: 'Sparkle', play: textureSparkle, defaults: DEFAULTS.texture.sparkle },
    grains: { label: 'Grains', play: textureGrains, defaults: DEFAULTS.texture.grains },
    chimes: { label: 'Chimes', play: textureChimes, defaults: DEFAULTS.texture.chimes },
    wash: { label: 'Wash', play: textureWash, defaults: DEFAULTS.texture.wash },
  },
  arp: {
    softPluck: { label: 'Soft pluck', play: arpSoftPluck, defaults: DEFAULTS.arp.softPluck },
    crystal: { label: 'Crystal', play: arpCrystal, defaults: DEFAULTS.arp.crystal },
    marimba: { label: 'Marimba', play: arpMarimba, defaults: DEFAULTS.arp.marimba },
  },
  percussion: {
    soft: { label: 'Soft kit', play: percSoft, defaults: DEFAULTS.percussion.soft },
    hand: { label: 'Hand drum', play: percHand, defaults: DEFAULTS.percussion.hand },
    tick: { label: 'Ticks', play: percTick, defaults: DEFAULTS.percussion.tick },
  },
};
