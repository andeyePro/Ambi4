/**
 * engine-voices.js — the timbre library for the ambient generator.
 *
 * One `play(ctx, destination, note)` function per patch, grouped by track and
 * exported as VOICES (see docs/engine-v2-contract.md). Each patch builds its
 * own throwaway node graph, schedules it entirely on the audio clock, and tears
 * itself down when the tail has finished, so a session that runs for hours
 * accumulates nothing.
 *
 * House rules every patch follows:
 *   - render DRY into `destination`; the engine owns reverb and delay sends
 *   - gain moves are exponential ramps or setTargetAtTime, never a step to zero
 *   - amplitude scales with velocity squared, which tracks perceived loudness
 *     far better than a linear scale
 *   - peak per-note gain stays at or below ~0.25, and patches within a track
 *     are loudness-matched so swapping a voice never jumps the mix
 *
 * Pure module: no imports, and nothing touches an AudioContext until a patch is
 * played, so importing this outside a browser is safe.
 *
 * Layout:
 *   1. constants + pure helpers
 *   2. the per-note rig (node bookkeeping, envelopes, teardown, cancel)
 *   3. building blocks shared by several patches (FM, LFO, drum primitives)
 *   4. patches: pad, bass, melody, texture, arp, percussion
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

    osc(type, frequency, start, detune = 0) {
      const node = ctx.createOscillator();
      node.type = type;
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
function membrane(rig, dest, { t, type = 'sine', from, to, bend, attack = 0.004, decay, peak }) {
  const osc = rig.osc(type, from, t);
  const amp = rig.gain(SILENCE);
  osc.connect(amp);
  amp.connect(dest);
  osc.frequency.setValueAtTime(from, t);
  osc.frequency.exponentialRampToValueAtTime(Math.max(to, 20), t + bend);
  return hit(amp.gain, t, { attack, decay, peak });
}

/** Filtered noise burst: hats, slaps, ticks, mallet clicks, breath transients. */
function noiseBurst(rig, dest, {
  t, colour = 'white', type = 'bandpass', freq, q = 1, decay, peak, attack = 0.002, rate = 1,
}) {
  const source = rig.noise(t, { colour, rate });
  const filter = rig.filter(type, freq, q);
  const amp = rig.gain(SILENCE);
  source.connect(filter);
  filter.connect(amp);
  amp.connect(dest);
  const makeup = type === 'bandpass' ? noiseMakeup(freq, q, rig.sampleRate) : 1;
  const end = hit(amp.gain, t, { attack, decay, peak: peak * makeup });
  rig.stopAt(source, end + 0.02);
  return end;
}

// ---------------------------------------------------------------------------
// 4a. Pads — long attacks, long releases, movement in the filter
// ---------------------------------------------------------------------------

/** Warm: a detuned saw/triangle stack under a slowly opening lowpass. */
function padWarm(ctx, destination, note) {
  const rig = createRig(ctx, destination, note);
  const t = timeOf(ctx, note);
  const f = freqOf(note, 220);
  const v = velOf(note);
  const dur = durOf(note, 6);

  const attack = clamp(dur * 0.4, 1.6, 3.2);
  const release = between(3.5, 5);
  const hold = Math.max(0.3, dur - attack);

  const amp = rig.gain(SILENCE);
  const lowpass = rig.filter('lowpass', f * 2, 0.7);
  amp.connect(lowpass);
  lowpass.connect(rig.out);

  const open = clamp(f * (4 + 3 * v), 500, 4200);
  lowpass.frequency.setValueAtTime(Math.max(f * 1.5, 110), t);
  lowpass.frequency.exponentialRampToValueAtTime(open, t + attack * 1.3);
  lowpass.frequency.setTargetAtTime(Math.max(open * 0.45, 220), t + attack + hold, release * 0.5);
  // A held chord that never moves reads as synthetic; this is the slow breath.
  lfo(rig, lowpass.frequency, { t, rate: between(0.05, 0.11), depth: open * 0.16 });

  const layers = [
    ['sawtooth', 1, 0.26, -7],
    ['sawtooth', 1, 0.22, 8],
    ['triangle', 1, 0.3, 2],
    ['triangle', 0.5, 0.22, -3],
  ];
  for (const [type, ratio, mix, cents] of layers) {
    const osc = rig.osc(type, f * ratio, t, cents);
    const gain = rig.gain(mix);
    osc.connect(gain);
    gain.connect(amp);
  }

  const end = env(amp.gain, t, { attack, hold, release, peak: level(PEAK.pad, v) });
  return rig.finish(end + 0.05);
}

/** Glass: additive sine partials that fade in out of step, with FM shimmer. */
function padGlass(ctx, destination, note) {
  const rig = createRig(ctx, destination, note);
  const t = timeOf(ctx, note);
  const f = freqOf(note, 220);
  const v = velOf(note);
  const dur = durOf(note, 6);

  const attack = clamp(dur * 0.35, 1.5, 2.8);
  const release = between(4, 6);
  const hold = Math.max(0.3, dur - attack);

  const amp = rig.gain(SILENCE);
  const highpass = rig.filter('highpass', 180, 0.5);
  amp.connect(highpass);
  highpass.connect(rig.out);

  // Slightly stretched partials: harmonic enough to be a chord tone, detuned
  // enough to ring like struck glass.
  const partials = [[1, 0.4], [2, 0.2], [3.01, 0.14], [4.98, 0.09], [6.97, 0.05]];
  partials.forEach(([ratio, mix], i) => {
    const start = t + i * 0.28;
    const osc = rig.osc('sine', f * ratio, start, between(-4, 4));
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

  const end = env(amp.gain, t, { attack, hold, release, peak: level(PEAK.pad * 1.05, v) });
  return rig.finish(end + 0.05);
}

/** Strings: a five-voice sawtooth ensemble through a two-tap modulated chorus. */
function padStrings(ctx, destination, note) {
  const rig = createRig(ctx, destination, note);
  const t = timeOf(ctx, note);
  const f = freqOf(note, 220);
  const v = velOf(note);
  const dur = durOf(note, 6);

  const attack = clamp(dur * 0.3, 1.5, 2.6);
  const release = between(3, 4.5);
  const hold = Math.max(0.3, dur - attack);

  const amp = rig.gain(SILENCE);
  const lowpass = rig.filter('lowpass', clamp(f * 6 * brightness(v), 700, 5000), 0.8);
  amp.connect(lowpass);

  const dry = rig.gain(0.6);
  lowpass.connect(dry);
  dry.connect(rig.out);

  // Two short delays with independent slow modulation: the classic ensemble
  // effect, and the only width a mono oscillator stack can get.
  for (const [time, rate, mix] of [[0.0121, 0.61, 0.35], [0.0193, 0.43, 0.32]]) {
    const delay = rig.delay(time);
    const gain = rig.gain(mix);
    lowpass.connect(delay);
    delay.connect(gain);
    gain.connect(rig.out);
    lfo(rig, delay.delayTime, { t, rate, depth: 0.0028 });
  }

  for (const cents of [-14, -7, 0, 7, 14]) {
    const osc = rig.osc('sawtooth', f, t, cents + between(-2, 2));
    const gain = rig.gain(0.2);
    osc.connect(gain);
    gain.connect(amp);
    // Individual drift keeps the unison from locking into a static beat.
    lfo(rig, osc.detune, { t, rate: between(0.09, 0.3), depth: between(1.5, 4) });
  }

  const end = env(amp.gain, t, { attack, hold, release, peak: level(PEAK.pad * 0.9, v) });
  return rig.finish(end + 0.05);
}

/** Choir: saw and breath through two bandpass formants that drift ooh → aah. */
function padChoir(ctx, destination, note) {
  const rig = createRig(ctx, destination, note);
  const t = timeOf(ctx, note);
  const f = freqOf(note, 220);
  const v = velOf(note);
  const dur = durOf(note, 6);

  const attack = clamp(dur * 0.35, 1.8, 3.5);
  const release = between(3.5, 5);
  const hold = Math.max(0.3, dur - attack);

  const amp = rig.gain(SILENCE);
  const tame = rig.filter('lowpass', clamp(f * 8, 1800, 4000), 0.5);
  amp.connect(tame);
  tame.connect(rig.out);

  const source = rig.gain(1);
  // /u/ on entry, opening towards /a/ as the note settles: the vowel change is
  // what makes filtered saw read as voices rather than as a filter sweep.
  const formants = [[320, 730, 8, 1], [800, 1090, 9, 0.55]];
  for (const [from, to, q, mix] of formants) {
    const band = rig.filter('bandpass', from, q);
    const gain = rig.gain(mix);
    source.connect(band);
    band.connect(gain);
    gain.connect(amp);
    band.frequency.setValueAtTime(from, t);
    band.frequency.setTargetAtTime(to, t + attack * 0.4, attack * 0.7);
    lfo(rig, band.frequency, { t, rate: between(0.11, 0.2), depth: from * 0.06 });
  }

  for (const cents of [-9, 5]) {
    const osc = rig.osc('sawtooth', f, t, cents);
    const gain = rig.gain(0.34);
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

  const end = env(amp.gain, t, { attack, hold, release, peak: level(PEAK.pad * 1.1, v) });
  return rig.finish(end + 0.05);
}

// ---------------------------------------------------------------------------
// 4b. Bass — one clean fundamental, nothing detuned down there
// ---------------------------------------------------------------------------

/** Sub: a single sine with a whisper of second harmonic for small speakers. */
function bassSub(ctx, destination, note) {
  const rig = createRig(ctx, destination, note);
  const t = timeOf(ctx, note);
  const f = freqOf(note, 65);
  const v = velOf(note);
  const dur = durOf(note, 2);

  const amp = rig.gain(SILENCE);
  const lowpass = rig.filter('lowpass', clamp(f * 3.5, 90, 260), 0.6);
  amp.connect(lowpass);
  lowpass.connect(rig.out);

  const attack = 0.12;
  const release = 0.75;
  const hold = Math.max(0.1, dur - attack);

  // Untuned unison would beat against itself at these frequencies, so the only
  // colour is a fixed octave partial well below the fundamental's level.
  for (const [ratio, mix] of [[1, 0.9], [2, 0.12]]) {
    const osc = rig.osc('sine', f * ratio, t);
    const gain = rig.gain(mix);
    osc.connect(gain);
    gain.connect(amp);
  }

  const end = env(amp.gain, t, { attack, hold, release, peak: level(PEAK.bass, v) });
  return rig.finish(end + 0.05);
}

/** Round: triangle body with a soft filter fall — plucked, but with no edge. */
function bassRound(ctx, destination, note) {
  const rig = createRig(ctx, destination, note);
  const t = timeOf(ctx, note);
  const f = freqOf(note, 65);
  const v = velOf(note);
  const dur = durOf(note, 2);

  const amp = rig.gain(SILENCE);
  const lowpass = rig.filter('lowpass', f * 9, 1.4);
  amp.connect(lowpass);
  lowpass.connect(rig.out);

  lowpass.frequency.setValueAtTime(clamp(f * (6 + 8 * v), 120, 2400), t);
  lowpass.frequency.exponentialRampToValueAtTime(Math.max(f * 2.2, 80), t + 0.4);

  for (const [type, ratio, mix] of [['triangle', 1, 0.7], ['sine', 1, 0.35]]) {
    const osc = rig.osc(type, f * ratio, t);
    const gain = rig.gain(mix);
    osc.connect(gain);
    gain.connect(amp);
  }

  const attack = 0.05;
  const release = 0.55;
  const hold = Math.max(0.1, dur - attack);
  const end = env(amp.gain, t, { attack, hold, release, peak: level(PEAK.bass * 0.95, v) });
  return rig.finish(end + 0.05);
}

/** Breath: a clean fundamental with a slow band of air swelling over it. */
function bassBreath(ctx, destination, note) {
  const rig = createRig(ctx, destination, note);
  const t = timeOf(ctx, note);
  const f = freqOf(note, 65);
  const v = velOf(note);
  const dur = durOf(note, 2);

  const amp = rig.gain(SILENCE);
  amp.connect(rig.out);

  const attack = 0.18;
  const release = 0.9;
  const hold = Math.max(0.1, dur - attack);

  const osc = rig.osc('sine', f, t);
  const oscGain = rig.gain(0.85);
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

  const end = env(amp.gain, t, { attack, hold, release, peak: level(PEAK.bass * 0.95, v) });
  return rig.finish(end + 0.05);
}

// ---------------------------------------------------------------------------
// 4c. Melody
// ---------------------------------------------------------------------------

/** Pluck: a resonant filter falling fast across a saw pair, with a string tick. */
function melodyPluck(ctx, destination, note) {
  const rig = createRig(ctx, destination, note);
  const t = timeOf(ctx, note);
  const f = freqOf(note, 440);
  const v = velOf(note);
  const dur = durOf(note, 1);

  const amp = rig.gain(SILENCE);
  const lowpass = rig.filter('lowpass', f * 8, 4);
  amp.connect(lowpass);
  lowpass.connect(rig.out);

  // The whole character is here: a resonant cutoff dropping from bright to
  // near the fundamental in a quarter of a second.
  lowpass.frequency.setValueAtTime(clamp(f * (5 + 12 * v), 300, 9000), t);
  lowpass.frequency.exponentialRampToValueAtTime(Math.max(f * 1.8, 120), t + 0.28);

  for (const [mix, cents] of [[0.55, 0], [0.2, 6]]) {
    const osc = rig.osc('sawtooth', f, t, cents);
    const gain = rig.gain(mix);
    osc.connect(gain);
    gain.connect(amp);
  }

  // The string tick sits outside the amp envelope — routed through it, the
  // 6 ms attack would swallow the very transient that sells the pluck.
  noiseBurst(rig, lowpass, {
    t, freq: clamp(f * 3, 200, 6000), q: 1, decay: 0.014, peak: 0.08 * v, attack: 0.001,
  });

  const decay = clamp(dur * 0.9 + 0.2, 0.35, 1.8);
  const end = hit(amp.gain, t, { attack: 0.006, decay, peak: level(PEAK.melody, v) });
  return rig.finish(end + 0.05);
}

/** Bell: inharmonic two-operator FM with a long, slowly beating shimmer. */
function melodyBell(ctx, destination, note) {
  const rig = createRig(ctx, destination, note);
  const t = timeOf(ctx, note);
  const f = freqOf(note, 440);
  const v = velOf(note);
  const dur = durOf(note, 1);

  const amp = rig.gain(SILENCE);
  const highpass = rig.filter('highpass', 140, 0.6);
  amp.connect(highpass);
  highpass.connect(rig.out);

  const carrier = rig.osc('sine', f, t);
  const carrierGain = rig.gain(0.7);
  carrier.connect(carrierGain);
  carrierGain.connect(amp);
  // A non-integer ratio puts the partials off the harmonic series, which is
  // what a bell is; the index decay turns the clang into a hum.
  fm(rig, carrier, { t, freq: f, ratio: 3.47, index: f * (1.5 + 2.5 * v), decay: 0.8 });

  // A second, slightly detuned partial gives the tail a slow beat.
  const partial = rig.osc('sine', f * 2.76, t, 6);
  const partialGain = rig.gain(SILENCE);
  partial.connect(partialGain);
  partialGain.connect(amp);
  hit(partialGain.gain, t, { attack: 0.005, decay: clamp(dur, 0.8, 2.5), peak: 0.16 });

  const decay = clamp(dur * 1.6 + 0.8, 1.8, 5);
  const end = hit(amp.gain, t, { attack: 0.005, decay, peak: level(PEAK.melody * 0.95, v) });
  return rig.finish(end + 0.05);
}

/** Flute: near-sine tone with breath noise and vibrato that arrives late. */
function melodyFlute(ctx, destination, note) {
  const rig = createRig(ctx, destination, note);
  const t = timeOf(ctx, note);
  const f = freqOf(note, 440);
  const v = velOf(note);
  const dur = durOf(note, 1);

  const amp = rig.gain(SILENCE);
  amp.connect(rig.out);

  const attack = 0.09;
  const release = 0.32;
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

  const end = env(amp.gain, t, { attack, hold, release, peak: level(PEAK.melody * 1.05, v) });
  return rig.finish(end + 0.05);
}

/** Keys: electric-piano tine — sine carrier, self-ratio FM, velocity brightness. */
function melodyKeys(ctx, destination, note) {
  const rig = createRig(ctx, destination, note);
  const t = timeOf(ctx, note);
  const f = freqOf(note, 440);
  const v = velOf(note);
  const dur = durOf(note, 1);

  const amp = rig.gain(SILENCE);
  const lowpass = rig.filter('lowpass', clamp(f * 6 + 2000 * brightness(v), 900, 9000), 0.7);
  amp.connect(lowpass);
  lowpass.connect(rig.out);

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
  hit(tineGain.gain, t, { attack: 0.002, decay: 0.22, peak: Math.max(0.14 * v * v, SILENCE * 2) });

  const decay = clamp(dur * 1.3 + 0.4, 0.8, 3.2);
  const end = hit(amp.gain, t, { attack: 0.004, decay, peak: level(PEAK.melody, v) });
  return rig.finish(end + 0.05);
}

// ---------------------------------------------------------------------------
// 4d. Texture
// ---------------------------------------------------------------------------

/** Sparkle: two or three high FM glints, staggered, each with a long fade. */
function textureSparkle(ctx, destination, note) {
  const rig = createRig(ctx, destination, note);
  const t = timeOf(ctx, note);
  const base = freqOf(note, 1568);
  const v = velOf(note);
  const dur = durOf(note, 3);

  const amp = rig.gain(1);
  const highpass = rig.filter('highpass', 500, 0.6);
  amp.connect(highpass);
  highpass.connect(rig.out);

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
    const decay = clamp(dur * 0.5, 1.1, 2.4) * between(0.8, 1.2);
    const done = hit(gain.gain, at, {
      attack: 0.02, decay, peak: level(PEAK.texture, v) * (i === 0 ? 1 : 0.55),
    });
    if (done > end) end = done;
  }
  return rig.finish(end + 0.05);
}

/** Grains: a scatter of tiny enveloped noise bursts through resonant bands. */
function textureGrains(ctx, destination, note) {
  const rig = createRig(ctx, destination, note);
  const t = timeOf(ctx, note);
  const base = freqOf(note, 880);
  const v = velOf(note);
  const dur = durOf(note, 2.5);

  const amp = rig.gain(1);
  amp.connect(rig.out);

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
  return rig.finish(end + 0.05);
}

/** Chimes: tubular-bell partial stack with a mallet tick and a very long tail. */
function textureChimes(ctx, destination, note) {
  const rig = createRig(ctx, destination, note);
  const t = timeOf(ctx, note);
  const f = clamp(freqOf(note, 880), 200, 2200);
  const v = velOf(note);
  const dur = durOf(note, 4);

  const amp = rig.gain(1);
  const highpass = rig.filter('highpass', 250, 0.5);
  amp.connect(highpass);
  highpass.connect(rig.out);

  // Ratios from a struck tube: nothing here is a harmonic of anything else,
  // which is why the stack shimmers instead of fusing into one pitch.
  const partials = [[1, 0.42, 1], [2.76, 0.26, 0.7], [5.4, 0.16, 0.45], [8.93, 0.09, 0.28]];
  const life = clamp(dur * 1.2 + 1.5, 3, 7);
  let end = t;
  for (const [ratio, mix, span] of partials) {
    const osc = rig.osc('sine', f * ratio, t, between(-3, 3));
    const gain = rig.gain(SILENCE);
    osc.connect(gain);
    gain.connect(amp);
    const done = hit(gain.gain, t, {
      attack: 0.008, decay: life * span, peak: level(PEAK.texture, v) * mix * 2.4,
    });
    if (done > end) end = done;
  }

  noiseBurst(rig, amp, {
    t, freq: clamp(f * 4, 800, 9000), q: 1.5, decay: 0.02, peak: 0.05 * v, attack: 0.001,
  });

  return rig.finish(end + 0.05);
}

/** Wash: pink noise swelling through a bandpass that sweeps up and back down. */
function textureWash(ctx, destination, note) {
  const rig = createRig(ctx, destination, note);
  const t = timeOf(ctx, note);
  const f = clamp(freqOf(note, 660), 120, 3000);
  const v = velOf(note);
  const dur = durOf(note, 6);

  const amp = rig.gain(SILENCE);
  amp.connect(rig.out);

  const attack = clamp(dur * 0.4, 1.2, 3);
  const release = between(2.5, 4);
  const hold = Math.max(0.3, dur - attack);

  const band = rig.filter('bandpass', 320, 1.2);
  band.connect(amp);
  const top = clamp(f * 2.4 * brightness(v), 600, 5000);
  band.frequency.setValueAtTime(320, t);
  band.frequency.exponentialRampToValueAtTime(top, t + attack + hold * 0.4);
  band.frequency.exponentialRampToValueAtTime(420, t + attack + hold + release);
  lfo(rig, band.Q, { t, rate: 0.06, depth: 0.5 });

  // Two layers at slightly different playback rates decorrelate, which is what
  // makes a noise swell feel wide rather than flat.
  const makeup = noiseMakeup(Math.sqrt(320 * top), 1.2, rig.sampleRate);
  for (const rate of [0.92, 1.07]) {
    const noise = rig.noise(t, { colour: 'pink', rate });
    const gain = rig.gain(0.5 * makeup);
    noise.connect(gain);
    gain.connect(band);
  }

  // A faint sine keeps the wash anchored to the current harmony.
  const tone = rig.osc('sine', f, t);
  const toneGain = rig.gain(0.14);
  tone.connect(toneGain);
  toneGain.connect(amp);

  const end = env(amp.gain, t, { attack, hold, release, peak: level(PEAK.texture * 1.6, v) });
  return rig.finish(end + 0.05);
}

// ---------------------------------------------------------------------------
// 4e. Arpeggiator — short tails, so 1/16 at 120 bpm still articulates
// ---------------------------------------------------------------------------

/** Soft pluck: triangle with a quick filter fall and no bite at all. */
function arpSoftPluck(ctx, destination, note) {
  const rig = createRig(ctx, destination, note);
  const t = timeOf(ctx, note);
  const f = freqOf(note, 440);
  const v = velOf(note);
  const dur = durOf(note, 0.25);

  const amp = rig.gain(SILENCE);
  const lowpass = rig.filter('lowpass', f * 6, 1.6);
  amp.connect(lowpass);
  lowpass.connect(rig.out);

  lowpass.frequency.setValueAtTime(clamp(f * (4 + 6 * v), 300, 7000), t);
  lowpass.frequency.exponentialRampToValueAtTime(Math.max(f * 2, 150), t + 0.12);

  for (const [type, ratio, mix] of [['triangle', 1, 0.6], ['sine', 2, 0.12]]) {
    const osc = rig.osc(type, f * ratio, t);
    const gain = rig.gain(mix);
    osc.connect(gain);
    gain.connect(amp);
  }

  const decay = clamp(dur * 1.4 + 0.12, 0.16, 0.5);
  const end = hit(amp.gain, t, { attack: 0.006, decay, peak: level(PEAK.arp, v) });
  return rig.finish(end + 0.03);
}

/** Crystal: glassy FM ping, bright and short, with a highpassed tail. */
function arpCrystal(ctx, destination, note) {
  const rig = createRig(ctx, destination, note);
  const t = timeOf(ctx, note);
  const f = freqOf(note, 440);
  const v = velOf(note);
  const dur = durOf(note, 0.25);

  const amp = rig.gain(SILENCE);
  const highpass = rig.filter('highpass', 350, 0.7);
  amp.connect(highpass);
  highpass.connect(rig.out);

  const carrier = rig.osc('sine', f, t);
  const carrierGain = rig.gain(0.65);
  carrier.connect(carrierGain);
  carrierGain.connect(amp);
  fm(rig, carrier, { t, freq: f, ratio: 2.01, index: f * (1 + 2 * v), decay: 0.09 });

  const partial = rig.osc('sine', f * 4.01, t);
  const partialGain = rig.gain(SILENCE);
  partial.connect(partialGain);
  partialGain.connect(amp);
  hit(partialGain.gain, t, { attack: 0.002, decay: 0.1, peak: Math.max(0.12 * v, SILENCE * 2) });

  const decay = clamp(dur * 1.5 + 0.15, 0.2, 0.55);
  const end = hit(amp.gain, t, { attack: 0.003, decay, peak: level(PEAK.arp * 0.9, v) });
  return rig.finish(end + 0.03);
}

/** Marimba: fundamental plus the bar's 4:1 overtone over a woody mallet tick. */
function arpMarimba(ctx, destination, note) {
  const rig = createRig(ctx, destination, note);
  const t = timeOf(ctx, note);
  const f = freqOf(note, 440);
  const v = velOf(note);
  const dur = durOf(note, 0.25);

  const amp = rig.gain(1);
  const lowpass = rig.filter('lowpass', clamp(f * 5 + 1200 * brightness(v), 800, 7000), 0.8);
  amp.connect(lowpass);
  lowpass.connect(rig.out);

  // Low bars ring longer than high ones, as they do on the instrument.
  const life = clamp(dur * 1.4 + 0.18, 0.18, 0.6) * clamp(Math.pow(440 / f, 0.35), 0.7, 1.5);
  const peak = level(PEAK.arp * 0.85, v);
  let end = t;
  for (const [ratio, mix, span] of [[1, 1, 1], [4, 0.22, 0.35], [9.2, 0.07, 0.18]]) {
    const osc = rig.osc('sine', f * ratio, t);
    const gain = rig.gain(SILENCE);
    osc.connect(gain);
    gain.connect(amp);
    const done = hit(gain.gain, t, { attack: 0.003, decay: life * span, peak: peak * mix });
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
function percSoft(ctx, destination, note) {
  const rig = createRig(ctx, destination, note);
  const t = timeOf(ctx, note);
  const v = velOf(note);
  const kind = kindOf(note);
  const peak = level(PEAK.percussion * KIND_TRIM[kind], v);

  const amp = rig.gain(1);
  amp.connect(rig.out);
  let end = t;

  if (kind === 'low') {
    const damp = rig.filter('lowpass', 180 + 120 * v, 0.7);
    damp.connect(amp);
    end = membrane(rig, damp, {
      t, from: 110, to: 44, bend: 0.09, attack: 0.008, decay: 0.36, peak,
    });
    // A little low thud under the tone: the beater, not the skin.
    noiseBurst(rig, damp, {
      t, colour: 'pink', type: 'lowpass', freq: 140, q: 0.7, decay: 0.05, peak: peak * 0.35,
    });
  } else if (kind === 'mid') {
    const damp = rig.filter('lowpass', 900 + 700 * v, 0.8);
    damp.connect(amp);
    end = membrane(rig, damp, {
      t, from: 190, to: 118, bend: 0.12, attack: 0.006, decay: 0.3, peak,
    });
    noiseBurst(rig, damp, {
      t, colour: 'pink', freq: 420, q: 1.6, decay: 0.11, peak: peak * 0.3, attack: 0.004,
    });
  } else {
    const air = rig.filter('highpass', 5000 + 2500 * v, 0.7);
    air.connect(amp);
    end = noiseBurst(rig, air, {
      t, freq: 9000, q: 1.2, decay: 0.075, peak, attack: 0.004,
    });
  }

  return rig.finish(end + 0.03);
}

/** Hand drum: dum with a real pitch drop, an open slap, and a finger tick. */
function percHand(ctx, destination, note) {
  const rig = createRig(ctx, destination, note);
  const t = timeOf(ctx, note);
  const v = velOf(note);
  const kind = kindOf(note);
  const peak = level(PEAK.percussion * KIND_TRIM[kind], v);

  const amp = rig.gain(1);
  amp.connect(rig.out);
  let end = t;

  if (kind === 'low') {
    // The wide, fast bend is the hand-drum signature: a struck head detunes
    // hard and then settles.
    end = membrane(rig, amp, {
      t, from: 165, to: 72, bend: 0.075, attack: 0.005, decay: 0.45, peak,
    });
    const ring = membrane(rig, amp, {
      t, type: 'triangle', from: 264, to: 170, bend: 0.06, attack: 0.004, decay: 0.1,
      peak: peak * 0.22,
    });
    if (ring > end) end = ring;
    noiseBurst(rig, amp, {
      t, colour: 'pink', freq: 900, q: 1.4, decay: 0.03, peak: peak * 0.18, attack: 0.002,
    });
  } else if (kind === 'mid') {
    end = membrane(rig, amp, {
      t, from: 320, to: 205, bend: 0.05, attack: 0.004, decay: 0.15, peak,
    });
    const slap = noiseBurst(rig, amp, {
      t, freq: 1800 + 900 * v, q: 1.3, decay: 0.08, peak: peak * 0.55, attack: 0.002,
    });
    if (slap > end) end = slap;
  } else {
    end = noiseBurst(rig, amp, {
      t, freq: 3400 + 1800 * v, q: 2.6, decay: 0.05, peak, attack: 0.0015,
    });
    const tick = membrane(rig, amp, {
      t, from: 900, to: 700, bend: 0.02, attack: 0.002, decay: 0.03, peak: peak * 0.3,
    });
    if (tick > end) end = tick;
  }

  return rig.finish(end + 0.03);
}

/** Ticks: the minimal kit — filtered clicks, barely more than punctuation. */
function percTick(ctx, destination, note) {
  const rig = createRig(ctx, destination, note);
  const t = timeOf(ctx, note);
  const v = velOf(note);
  const kind = kindOf(note);
  const peak = level(PEAK.percussion * KIND_TRIM[kind] * 0.8, v);

  const amp = rig.gain(1);
  amp.connect(rig.out);
  let end = t;

  if (kind === 'low') {
    end = noiseBurst(rig, amp, {
      t, colour: 'pink', type: 'lowpass', freq: 240, q: 0.8, decay: 0.05, peak, attack: 0.003,
    });
    const body = membrane(rig, amp, {
      t, from: 96, to: 70, bend: 0.03, attack: 0.004, decay: 0.07, peak: peak * 0.7,
    });
    if (body > end) end = body;
  } else if (kind === 'mid') {
    end = noiseBurst(rig, amp, {
      t, freq: 1100 + 700 * v, q: 6, decay: 0.035, peak, attack: 0.0015,
    });
  } else {
    end = noiseBurst(rig, amp, {
      t, type: 'highpass', freq: 7000 + 2000 * v, q: 0.8, decay: 0.022, peak, attack: 0.001,
    });
  }

  return rig.finish(end + 0.03);
}

// ---------------------------------------------------------------------------
// 5. The library
// ---------------------------------------------------------------------------

export const VOICES = {
  pad: {
    warm: { label: 'Warm', play: padWarm },
    glass: { label: 'Glass', play: padGlass },
    strings: { label: 'Strings', play: padStrings },
    choir: { label: 'Choir', play: padChoir },
  },
  bass: {
    sub: { label: 'Sub', play: bassSub },
    round: { label: 'Round', play: bassRound },
    breath: { label: 'Breath', play: bassBreath },
  },
  melody: {
    pluck: { label: 'Pluck', play: melodyPluck },
    bell: { label: 'Bell', play: melodyBell },
    flute: { label: 'Flute', play: melodyFlute },
    keys: { label: 'Keys', play: melodyKeys },
  },
  texture: {
    sparkle: { label: 'Sparkle', play: textureSparkle },
    grains: { label: 'Grains', play: textureGrains },
    chimes: { label: 'Chimes', play: textureChimes },
    wash: { label: 'Wash', play: textureWash },
  },
  arp: {
    softPluck: { label: 'Soft pluck', play: arpSoftPluck },
    crystal: { label: 'Crystal', play: arpCrystal },
    marimba: { label: 'Marimba', play: arpMarimba },
  },
  percussion: {
    soft: { label: 'Soft kit', play: percSoft },
    hand: { label: 'Hand drum', play: percHand },
    tick: { label: 'Ticks', play: percTick },
  },
};
