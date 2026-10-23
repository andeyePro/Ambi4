/**
 * Match a sample — "here is a sound, give me the closest synth".
 *
 * A person hands the voice editor one recorded note (a file, or the
 * microphone). This module ANALYSES it — pitch, loudness over time, and the
 * shape of its spectrum at three moments — and then finds the voice and the
 * dial settings on this track whose own render measures closest. That is
 * analysis by synthesis: every candidate is actually played, offline, at the
 * sample's pitch, and measured with the same ruler as the sample, so "closest"
 * is a number rather than a guess from a lookup table.
 *
 * What it is not: sample playback. The recording is measured and dropped; the
 * only thing kept is a patch on a stock voice, which is the app's no-samples
 * rule (docs/synthesis-programme.md § 2) honoured — the sound you get is a
 * synth, made the same way every other sound in the app is made.
 *
 * Pure: no DOM, no audio, no imports. Rendering is INJECTED — the page passes a
 * `render(voiceId, patch, note)` that plays the shipped voice into an
 * OfflineAudioContext; `tests/sample-match-smoke.mjs` passes a small JS synth
 * so the search itself is provable in Node, and the real-voice proof lives in
 * tests/pending/sample-match-drive.mjs until the bridge returns.
 *
 * The ruler (`featureDistance`) is in decibels throughout: the loudness curve
 * at thirteen fixed times after the onset, and the level in thirty log-spaced
 * bands at three moments, each normalised to its own loudest point — so level,
 * gain and the room are not what is being compared, the SHAPE is.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Seconds after the onset at which the loudness curve is read. */
export const ENV_TIMES = Object.freeze([0, 0.01, 0.025, 0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 1, 1.5, 2, 3]);

/** Seconds after the onset at which the spectrum is read: strike, body, tail. */
export const SPEC_TIMES = Object.freeze([0.03, 0.25, 0.8]);

/** How much of a sample is looked at. Longer is the same note, ringing. */
export const MAX_SECONDS = 3.2;

/** The floor everything is clipped to, in dB below the loudest point. */
const FLOOR_DB = -60;

/** Thirty bands, log-spaced, the ruler for spectral shape. */
const BAND_COUNT = 30;
const BAND_LO = 40;
const BAND_HI = 11000;

/** YIN's search range: low E on a bass guitar's bottom string to a high whistle. */
const PITCH_LO = 30;
const PITCH_HI = 2000;

/** Below this YIN aperiodicity a sample counts as pitched. */
const PITCHED_BELOW = 0.35;

const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const toDb = (v) => (v > 0 ? Math.max(FLOOR_DB, 20 * Math.log10(v)) : FLOOR_DB);

// ---------------------------------------------------------------------------
// Signal helpers
// ---------------------------------------------------------------------------

/**
 * Mix any number of channels to one, as the decoder hands them over.
 * @param {Float32Array[]} channels
 */
export function mixDown(channels) {
  if (!channels || !channels.length) return new Float32Array(0);
  if (channels.length === 1) return Float32Array.from(channels[0]);
  const n = Math.min(...channels.map((c) => c.length));
  const out = new Float32Array(n);
  for (const c of channels) for (let i = 0; i < n; i++) out[i] += c[i] / channels.length;
  return out;
}

/** In-place iterative radix-2 FFT over separate real and imaginary arrays. */
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/** Power spectrum of a Hann-windowed frame starting at `from`. */
function powerSpectrum(x, from, size) {
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    const s = x[from + i] || 0;
    re[i] = s * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1)));
  }
  fft(re, im);
  const half = size / 2;
  const power = new Float64Array(half);
  for (let i = 0; i < half; i++) power[i] = re[i] * re[i] + im[i] * im[i];
  return power;
}

/** The largest power of two not above `n`. */
const pow2Below = (n) => 2 ** Math.floor(Math.log2(Math.max(2, n)));

/**
 * YIN (de Cheveigné & Kawahara, 2002) over one window: the fundamental and how
 * aperiodic the window is (0 = a perfect repeat, 1 = noise).
 */
export function yin(x, sampleRate, from = 0, size = 2048) {
  const maxLag = Math.min(Math.floor(sampleRate / PITCH_LO), Math.floor(size / 2));
  const minLag = Math.max(2, Math.floor(sampleRate / PITCH_HI));
  const half = size - maxLag;
  if (half < 32) return { freq: null, aperiodicity: 1 };
  const d = new Float64Array(maxLag + 1);
  for (let lag = 1; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i < half; i++) {
      const diff = (x[from + i] || 0) - (x[from + i + lag] || 0);
      sum += diff * diff;
    }
    d[lag] = sum;
  }
  // Cumulative mean normalised difference.
  const cmnd = new Float64Array(maxLag + 1);
  cmnd[0] = 1;
  let running = 0;
  for (let lag = 1; lag <= maxLag; lag++) {
    running += d[lag];
    cmnd[lag] = running > 0 ? (d[lag] * lag) / running : 1;
  }
  let best = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (cmnd[lag] < 0.15) {
      while (lag + 1 <= maxLag && cmnd[lag + 1] < cmnd[lag]) lag += 1;
      best = lag;
      break;
    }
  }
  if (best < 0) {
    let min = Infinity;
    for (let lag = minLag; lag <= maxLag; lag++) {
      if (cmnd[lag] < min) { min = cmnd[lag]; best = lag; }
    }
  }
  if (best <= 0) return { freq: null, aperiodicity: 1 };
  // Parabolic interpolation for a sub-sample lag.
  let lag = best;
  if (best > 1 && best < maxLag) {
    const a = cmnd[best - 1];
    const b = cmnd[best];
    const c = cmnd[best + 1];
    const denom = a - 2 * b + c;
    if (Math.abs(denom) > 1e-12) lag = best + (0.5 * (a - c)) / denom;
  }
  return { freq: sampleRate / lag, aperiodicity: clamp(cmnd[best], 0, 1) };
}

/** The strongest power within 3% of `hz`. */
function powerNear(power, binHz, hz) {
  const lo = Math.max(1, Math.floor((hz * 0.97) / binHz));
  const hi = Math.min(power.length - 1, Math.ceil((hz * 1.03) / binHz));
  let best = 0;
  for (let k = lo; k <= hi; k++) best = Math.max(best, power[k]);
  return best;
}

/**
 * The lowest spectral peak within 15 dB of the strongest one, refined to a
 * fraction of a bin. Null when nothing stands out.
 */
export function lowestStrongPeak(power, binHz) {
  let max = 0;
  const from = Math.max(2, Math.floor(PITCH_LO / binHz));
  const to = Math.min(power.length - 2, Math.ceil(PITCH_HI * 2 / binHz));
  for (let k = from; k <= to; k++) max = Math.max(max, power[k]);
  if (!(max > 0)) return null;
  for (let k = from; k <= to; k++) {
    const p = power[k];
    if (p < max * 0.0316 || p < power[k - 1] || p < power[k + 1]) continue;
    const a = Math.log(power[k - 1] + 1e-30);
    const b = Math.log(p + 1e-30);
    const c = Math.log(power[k + 1] + 1e-30);
    const denom = a - 2 * b + c;
    const shift = Math.abs(denom) > 1e-12 ? clamp((0.5 * (a - c)) / denom, -0.5, 0.5) : 0;
    const hz = (k + shift) * binHz;
    return hz >= PITCH_LO && hz <= PITCH_HI ? hz : null;
  }
  return null;
}

/** MIDI note number and a readable name for a frequency. */
export function noteOf(freq) {
  if (!(freq > 0)) return null;
  const midi = Math.round(69 + 12 * Math.log2(freq / 440));
  const cents = Math.round(100 * (69 + 12 * Math.log2(freq / 440) - midi));
  return { midi, cents, name: `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}` };
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/**
 * Measure one recorded note. Returns null for silence.
 *
 * @param {Float32Array} input mono samples
 * @param {number} sampleRate
 * @returns {null | {
 *   sampleRate: number, onset: number, length: number, held: number,
 *   peakDb: number, env: number[], spec: (number[]|null)[], centroid: (number|null)[],
 *   flatness: number, freq: number|null, pitched: boolean, span: number, aperiodicity: number,
 *   attack: number, decay: number, sustain: number, note: object|null,
 * }}
 */
export function analyseSample(input, sampleRate) {
  if (!input || !input.length || !(sampleRate > 0)) return null;
  let peak = 0;
  for (let i = 0; i < input.length; i++) peak = Math.max(peak, Math.abs(input[i]));
  if (!(peak > 1e-5)) return null;

  // Loudness every 5 ms over a 20 ms window.
  const hop = Math.max(1, Math.round(sampleRate * 0.005));
  const win = Math.max(hop, Math.round(sampleRate * 0.02));
  const frames = [];
  for (let start = 0; start + 1 < input.length; start += hop) {
    let sum = 0;
    const end = Math.min(input.length, start + win);
    for (let i = start; i < end; i++) sum += input[i] * input[i];
    frames.push(Math.sqrt(sum / Math.max(1, end - start)));
  }
  const maxRms = Math.max(...frames);
  // The onset: the first frame within 26 dB of the loudest.
  let onsetFrame = frames.findIndex((r) => r >= maxRms * 0.05);
  if (onsetFrame < 0) onsetFrame = 0;
  // Back up while the level is still rising out of the floor, so a slow swell
  // is measured from where it starts, not from where it got loud.
  while (onsetFrame > 0 && frames[onsetFrame - 1] >= maxRms * 0.01) onsetFrame -= 1;
  const onset = (onsetFrame * hop) / sampleRate;
  const end = Math.min(input.length, Math.round((onset + MAX_SECONDS) * sampleRate));
  const x = input.subarray(Math.round(onset * sampleRate), end);
  const frameAt = (sec) => (onset + sec) * sampleRate / hop;
  const rmsAt = (sec) => {
    const f = frameAt(sec);
    if (f >= frames.length - 1) return 0;
    const i = Math.floor(f);
    const frac = f - i;
    return frames[i] * (1 - frac) + frames[i + 1] * frac;
  };
  // A point past the end of the recording is UNKNOWN, not silent: null, and
  // the ruler skips it. Counted as silence, a slow pad whose file stops
  // 3.1 s after its onset was charged 26 dB for a tail nobody had measured.
  const known = (input.length - 1) / sampleRate - onset - 0.01;
  // Later points are read as an AVERAGE over a window that grows with the
  // time (15% either side): two detuned oscillators beat, and a point read
  // at one instant lands on a peak or a trough of the beat by chance — which
  // made the ruler jump when a pitch moved by a tenth of a hertz.
  const smoothAt = (t) => {
    const half = t * 0.15;
    if (half < 0.006) return rmsAt(t);
    let sum = 0;
    const n = 9;
    for (let k = 0; k < n; k++) sum += rmsAt(Math.max(0, t - half + (2 * half * k) / (n - 1))) ** 2;
    return Math.sqrt(sum / n);
  };
  const env = ENV_TIMES.map((t) => (t > known ? null : +(toDb(smoothAt(t) / maxRms)).toFixed(2)));

  // Sounding length: last frame within 30 dB of the peak; "held" is the last
  // within 12 dB — the nearest a one-shot recording comes to a note length.
  let lastLoud = onsetFrame;
  let lastHeld = onsetFrame;
  for (let i = onsetFrame; i < frames.length; i++) {
    if (frames[i] >= maxRms * 0.0316) lastLoud = i;
    if (frames[i] >= maxRms * 0.25) lastHeld = i;
  }
  const length = Math.min(MAX_SECONDS, ((lastLoud - onsetFrame) * hop) / sampleRate);
  const held = clamp(((lastHeld - onsetFrame) * hop) / sampleRate, 0.05, MAX_SECONDS);
  let peakFrame = onsetFrame;
  for (let i = onsetFrame; i < frames.length; i++) if (frames[i] > frames[peakFrame]) peakFrame = i;
  const attack = ((peakFrame - onsetFrame) * hop) / sampleRate;
  const sustain = maxRms > 0 ? rmsAt(Math.min(held * 0.6, MAX_SECONDS)) / maxRms : 0;
  // Decay: from the peak until the level has fallen 1/e of the way from the
  // peak towards the sustain it settles at (an exponential's time constant).
  const decayTo = maxRms * (sustain + (1 - sustain) / Math.E);
  let decayFrame = peakFrame;
  while (decayFrame < frames.length - 1 && frames[decayFrame] > decayTo) decayFrame += 1;
  const decay = Math.max(0.005, ((decayFrame - peakFrame) * hop) / sampleRate);

  // The spectrum at strike, body and tail.
  const size = pow2Below(sampleRate * 0.085);
  const nyquist = sampleRate / 2;
  const hi = Math.min(BAND_HI, nyquist * 0.95);
  const edges = Array.from({ length: BAND_COUNT + 1 }, (_, i) => BAND_LO * (hi / BAND_LO) ** (i / BAND_COUNT));
  const binHz = sampleRate / size;
  const spec = [];
  const centroid = [];
  let flatness = 0;
  let bodyPower = null;
  for (const t of SPEC_TIMES) {
    const from = Math.round(t * sampleRate - size / 2);
    const start = Math.max(0, from);
    if (start + size / 4 > x.length || toDb(rmsAt(t) / maxRms) < -45) {
      spec.push(null);
      centroid.push(null);
      continue;
    }
    // Three overlapping frames averaged, for the same reason as the
    // envelope's windows: one frame catches a beat at one phase.
    const power = powerSpectrum(x, start, size);
    for (const offset of [-size / 2, size / 2]) {
      const at = Math.round(start + offset);
      if (at < 0 || at + size / 2 > x.length) continue;
      const more = powerSpectrum(x, at, size);
      for (let k = 0; k < power.length; k++) power[k] += more[k];
    }
    if (!bodyPower || t === SPEC_TIMES[1]) bodyPower = power;
    const bands = new Array(BAND_COUNT).fill(0);
    let num = 0;
    let den = 0;
    for (let k = 1; k < power.length; k++) {
      const hz = k * binHz;
      num += hz * power[k];
      den += power[k];
      if (hz < edges[0] || hz >= edges[BAND_COUNT]) continue;
      let b = Math.floor((BAND_COUNT * Math.log(hz / BAND_LO)) / Math.log(hi / BAND_LO));
      b = clamp(b, 0, BAND_COUNT - 1);
      bands[b] += power[k];
    }
    const top = Math.max(...bands);
    spec.push(bands.map((p) => +(top > 0 ? Math.max(FLOOR_DB, 10 * Math.log10(p / top)) : FLOOR_DB).toFixed(2)));
    centroid.push(den > 0 ? +(num / den).toFixed(1) : null);
    if (t === SPEC_TIMES[1] || flatness === 0) {
      // Spectral flatness (geometric over arithmetic mean) up to the band top:
      // near 0 is tonal, near 1 is noise.
      let logSum = 0;
      let sum = 0;
      let count = 0;
      for (let k = 1; k < power.length && k * binHz < hi; k++) {
        logSum += Math.log(power[k] + 1e-20);
        sum += power[k];
        count += 1;
      }
      flatness = count && sum > 0 ? Math.exp(logSum / count) / (sum / count) : 0;
    }
  }

  // Pitch: YIN over the body, where a note has settled after its strike.
  const yinSize = pow2Below(Math.min(sampleRate * 0.09, Math.max(256, x.length * 0.5)));
  const reads = [];
  for (const t of [0.06, 0.12, 0.2, 0.3]) {
    const from = Math.round(t * sampleRate);
    if (from + yinSize > x.length) continue;
    if (toDb(rmsAt(t) / maxRms) < -40) continue;
    reads.push(yin(x, sampleRate, from, yinSize));
  }
  if (!reads.length && x.length >= yinSize) reads.push(yin(x, sampleRate, 0, yinSize));
  const good = reads.filter((r) => r.freq && r.aperiodicity < PITCHED_BELOW);
  const aperiodicity = reads.length ? Math.min(...reads.map((r) => r.aperiodicity)) : 1;
  let freq = null;
  if (good.length) {
    const sorted = good.map((r) => r.freq).sort((a, b) => a - b);
    freq = sorted[Math.floor(sorted.length / 2)];
  }
  // YIN reads a PERIOD, and an inharmonic tone (a bell, an FM ratio of 3.47)
  // has none, so it can land an octave or more below the note a person hears
  // — measured on the shipped Bell: G4 read as G3, which rendered every
  // candidate an octave off. The spectrum knows better: the lowest strong
  // peak is the pitch of a struck or rung object. So a YIN reading with almost
  // nothing at its own frequency yields to that peak, and a tonal sample YIN
  // could not read at all (flatness low, no period) takes the peak too.
  const peak0 = bodyPower ? lowestStrongPeak(bodyPower, sampleRate / size) : null;
  if (peak0) {
    if (freq !== null && freq < peak0 * 0.97 && powerNear(bodyPower, sampleRate / size, freq) < 0.01 * powerNear(bodyPower, sampleRate / size, peak0)) {
      freq = peak0;
    } else if (freq === null && flatness < 0.05) {
      freq = peak0;
    }
  }
  const pitched = freq !== null;

  return {
    sampleRate,
    onset: +onset.toFixed(4),
    length: +length.toFixed(3),
    held: +held.toFixed(3),
    peakDb: +toDb(peak).toFixed(2),
    env,
    spec,
    centroid,
    flatness: +flatness.toFixed(4),
    freq: freq ? +freq.toFixed(2) : null,
    pitched,
    span: +Math.max(0.05, Math.min(MAX_SECONDS, known)).toFixed(3),
    aperiodicity: +aperiodicity.toFixed(3),
    attack: +attack.toFixed(3),
    decay: +decay.toFixed(3),
    sustain: +sustain.toFixed(3),
    note: pitched ? noteOf(freq) : null,
  };
}

// ---------------------------------------------------------------------------
// The ruler
// ---------------------------------------------------------------------------

/** A frame heard in one measurement and silent in the other costs this, in dB. */
const MISSING_FRAME_DB = 24;

/**
 * How far apart two analyses are, in mean decibels — loudness shape plus
 * spectral shape. 0 is identical. Symmetric.
 */
export function featureDistance(a, b) {
  if (!a || !b) return Infinity;
  let envSum = 0;
  let envCount = 0;
  for (let i = 0; i < ENV_TIMES.length; i++) {
    const x = a.env[i];
    const y = b.env[i];
    if (x === null || y === null || x === undefined || y === undefined) continue;
    if (x <= FLOOR_DB && y <= FLOOR_DB) continue;
    // The early points decide attack, which the ear weighs heavily; they
    // count double.
    const w = ENV_TIMES[i] <= 0.05 ? 2 : 1;
    envSum += w * Math.abs(x - y);
    envCount += w;
  }
  const envDist = envCount ? envSum / envCount : 0;
  let specSum = 0;
  let specCount = 0;
  for (let f = 0; f < SPEC_TIMES.length; f++) {
    const x = a.spec[f];
    const y = b.spec[f];
    if (!x && !y) continue;
    if (!x || !y) { specSum += MISSING_FRAME_DB; specCount += 1; continue; }
    let sum = 0;
    let count = 0;
    for (let k = 0; k < x.length; k++) {
      if (x[k] <= FLOOR_DB && y[k] <= FLOOR_DB) continue;
      sum += Math.abs(x[k] - y[k]);
      count += 1;
    }
    specSum += count ? sum / count : 0;
    specCount += 1;
  }
  const specDist = specCount ? specSum / specCount : 0;
  return +(envDist + 0.8 * specDist).toFixed(3);
}

/** Distance as a percentage a person can read: 100 is the same measurement. */
export function similarity(distance) {
  if (!Number.isFinite(distance)) return 0;
  return Math.round(100 * Math.exp(-distance / 15));
}

// ---------------------------------------------------------------------------
// The search
// ---------------------------------------------------------------------------

/**
 * Dials the search never turns: the room (the sample's own room is not the
 * voice's), the octave (it would move the pitch away from the sample's), and
 * a kit's tuning. Everything else a voice exposes is fair game.
 */
export const NEVER_SEARCHED = Object.freeze(['sends.reverb', 'sends.delay', 'source.octave', 'source.pitch', 'source.osc1', 'source.osc2']);

/** The searched note length (see matchSample): a rendering condition, not a dial. */
const HELD_FIELD = Object.freeze({ field: '_note.held', kind: 'number', domain: [0.05, MAX_SECONDS], curve: 'log', integer: false });

const getPath = (obj, field) => {
  const [section, key] = field.split('.');
  return obj && obj[section] ? obj[section][key] : undefined;
};
const setPath = (obj, field, value) => {
  const [section, key] = field.split('.');
  if (!obj[section] || typeof obj[section] !== 'object') obj[section] = {};
  obj[section][key] = value;
};
const clone = (o) => JSON.parse(JSON.stringify(o));

/** A registry row's dial position (0..1) for a value, honouring a log curve. */
export function toPosition(value, row) {
  const [lo, hi] = row.domain;
  const v = clamp(value, lo, hi);
  if (row.curve === 'log' && lo > 0) return Math.log(v / lo) / Math.log(hi / lo);
  return hi === lo ? 0 : (v - lo) / (hi - lo);
}

/** The value at a dial position, the inverse of toPosition. */
export function fromPosition(pos, row) {
  const [lo, hi] = row.domain;
  const p = clamp(pos, 0, 1);
  let v = row.curve === 'log' && lo > 0 ? lo * (hi / lo) ** p : lo + p * (hi - lo);
  if (row.integer) v = Math.round(v);
  return +v.toPrecision(4);
}

/**
 * Which registry rows a voice's search may turn. `exposes(field)` is the
 * editor's own test (does this voice show that dial?), `registry` the
 * PARAM_REGISTRY. Numbers only, plus enums with few values (a modal material).
 * `allow` lifts a NEVER_SEARCHED field back in: a drum's tuning is part of
 * the sound being matched, where a pitched voice's octave is not.
 */
export function searchFieldsFor(defaults, registry, exposes = () => true, { allow = [] } = {}) {
  const fields = [];
  for (const [path, row] of Object.entries(registry || {})) {
    if (!path.startsWith('patch.')) continue;
    const field = path.slice('patch.'.length);
    if (field.split('.').length !== 2) continue;
    if (NEVER_SEARCHED.includes(field) && !allow.includes(field)) continue;
    const current = getPath(defaults, field);
    if (current === undefined || current === null) continue;
    if (!exposes(field)) continue;
    if (row.kind === 'number' && Number.isFinite(current)) {
      fields.push({ field, kind: 'number', domain: row.domain, curve: row.curve || 'linear', integer: !!row.integer });
    } else if (row.kind === 'enum' && Array.isArray(row.domain) && row.domain.length <= 6 && field !== 'filter.type') {
      fields.push({ field, kind: 'enum', domain: row.domain.filter((v) => v !== null) });
    }
  }
  return fields;
}

/**
 * Find the voice and dial settings that measure closest to a sample.
 *
 * @param {object} target an analyseSample() result
 * @param {object} opts
 * @param {{id: string, label?: string, defaults: object, fields: object[]}[]} opts.candidates
 * @param {(id: string, patch: object, note: object, seconds: number) => Promise<{samples: Float32Array, sampleRate: number}>} opts.render
 *   plays `note` on voice `id` with `patch`, `seconds` long (renders may be
 *   longer; nothing past `seconds` is compared)
 * @param {number} [opts.budget=600] total renders, defaults included
 * @param {number} [opts.fallbackFreq=220] pitch for an unpitched sample
 * @param {(done: number, budget: number) => void} [opts.onProgress]
 * @param {() => boolean} [opts.cancelled]
 * @param {number} [opts.goodEnough=0.5] stop once a match is within this
 *   many dB (after every voice has been heard as shipped); 0 never stops early
 * @param {boolean} [opts.octaves=true] false for a sound with no pitch to be
 *   an octave out from (a drum): each voice is then tried on the note alone
 */
export async function matchSample(target, opts) {
  const { candidates, render } = opts;
  const budget = Math.max(candidates.length * 6, opts.budget ?? 600);
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  const userCancelled = typeof opts.cancelled === 'function' ? opts.cancelled : () => false;
  // Good enough is good enough: once every voice has been heard as shipped,
  // a match within `goodEnough` dB (0.5 by default — 97 % alike) ends the
  // search, so a phone does not spend its remaining renders polishing a
  // match nobody could tell from the sample. Stage 1 always completes, so the
  // ranking of the voices is never cut short.
  const goodEnough = Number.isFinite(opts.goodEnough) ? opts.goodEnough : 0.5;
  let bestSoFar = Infinity;
  let rankingDone = false;
  let earlyStop = false;
  const cancelled = () => {
    if (userCancelled()) return true;
    if (rankingDone && bestSoFar <= goodEnough) { earlyStop = true; return true; }
    return false;
  };
  // The note every candidate plays: the sample's own pitch and length, a
  // hair after zero so no voice starts on the render's first sample. `when`
  // and `midi` are the engine's note shape (engine-v2-contract).
  const freq = target.freq || opts.fallbackFreq || 220;
  const note = {
    when: 0.02,
    freq,
    midi: noteOf(freq).midi,
    duration: target.held,
    velocity: 0.8,
  };
  // Nothing past the end of the sample is compared (its points are null), so
  // nothing past it is rendered: a one-second file costs a third of the work.
  const renderSeconds = +Math.min(MAX_SECONDS, note.when + (target.span ?? MAX_SECONDS) + 0.25).toFixed(3);
  let used = 0;
  // A one-shot recording does not say how long its note was HELD — a pad
  // released at 0.8 s and one released at 1.5 s are both just "a pad that
  // fades". So the held length is searched alongside the envelope, as a
  // rendering condition rather than a dial: `_note.held` rides in the trial
  // patch and is stripped before the voice sees it.
  const measure = async (id, patch) => {
    used += 1;
    onProgress(used, budget);
    const { _note, ...voicePatch } = patch;
    const played = _note
      ? { ...note, duration: _note.held, freq: note.freq * 2 ** (_note.shift / 12), midi: note.midi + _note.shift }
      : note;
    const out = await render(id, voicePatch, played, renderSeconds);
    const d = featureDistance(target, analyseSample(out.samples, out.sampleRate));
    if (d < bestSoFar) bestSoFar = d;
    return d;
  };

  // One coordinate-descent walk over `fields` of one candidate, coarse steps
  // first, until `allowance` renders are spent or no step helps.
  const descend = async (fin, fields, steps, allowance, { evolve = false } = {}) => {
    await coordinate(fin, fields, steps, allowance);
    if (evolve) await mutate(fin, fields.filter((x) => x.kind === 'number'), allowance);
  };
  const coordinate = async (fin, fields, steps, allowance) => {
    // Enums first, exhaustively: a material is a different object, not a step.
    for (const f of fields.filter((x) => x.kind === 'enum')) {
      for (const value of f.domain) {
        if (used >= allowance || cancelled()) return;
        if (value === getPath(fin.patch, f.field)) continue;
        const trial = clone(fin.patch);
        setPath(trial, f.field, value);
        const d = await measure(fin.cand.id, trial);
        if (d < fin.distance) { fin.distance = d; fin.patch = trial; }
      }
    }
    const numbers = fields.filter((x) => x.kind === 'number');
    for (const step of steps) {
      let improved = true;
      while (improved && used < allowance && !cancelled()) {
        improved = false;
        for (const f of numbers) {
          if (used >= allowance || cancelled()) return;
          const here = toPosition(getPath(fin.patch, f.field), f);
          for (const dir of [1, -1]) {
            if (used >= allowance) return;
            const pos = here + dir * step;
            if (pos < -1e-9 || pos > 1 + 1e-9) continue;
            const value = fromPosition(pos, f);
            if (value === getPath(fin.patch, f.field)) continue;
            const trial = clone(fin.patch);
            setPath(trial, f.field, value);
            const d = await measure(fin.cand.id, trial);
            if (d < fin.distance - 1e-6) {
              fin.distance = d;
              fin.patch = trial;
              improved = true;
              break;
            }
          }
        }
      }
    }
  };

  // What coordinate steps leave on the table: dials that only help when they
  // move TOGETHER (a longer attack wants a longer held note; a darker filter
  // wants more drive). A (1+1) evolution strategy — nudge two or three dials
  // at once by a random amount, keep it if it measures closer, widen the
  // nudges after a success and narrow them after a miss — spends the rest of
  // the allowance there. Seeded, so the same sample gives the same answer.
  const mutate = async (fin, numbers, allowance) => {
    if (!numbers.length) return;
    const rng = seededRandom(0x5a11 + fin.cand.id.length);
    let sigma = 0.08;
    while (used < allowance && !cancelled()) {
      const trial = clone(fin.patch);
      const count = Math.min(numbers.length, 2 + Math.floor(rng() * 2));
      for (let n = 0; n < count; n++) {
        const f = numbers[Math.floor(rng() * numbers.length)];
        // Box-Muller: one normal draw.
        const g = Math.sqrt(-2 * Math.log(rng() + 1e-12)) * Math.cos(2 * Math.PI * rng());
        setPath(trial, f.field, fromPosition(toPosition(getPath(trial, f.field), f) + sigma * g, f));
      }
      const d = await measure(fin.cand.id, trial);
      if (d < fin.distance - 1e-6) {
        fin.distance = d;
        fin.patch = trial;
        sigma = Math.min(0.3, sigma * 1.6);
      } else {
        sigma = Math.max(0.01, sigma * 0.88);
      }
    }
  };

  // Stage 1: every voice as shipped, on the note and an octave either side.
  // The pitch a person hears and the note a voice was GIVEN can differ by an
  // octave: Warm's lower layer makes its waveform repeat an octave below its
  // note, so a Warm A3 reads as A2. Measured, the octave cannot be left to the
  // dial search either — at the wrong octave the search bends the timbre to
  // fit (Warm reached 70% on A2 with Fold and Detune wrenched, against 79% for
  // the untouched true patch on A3). So each octave is its own contender.
  //
  // And each octave is tried twice: with the envelope the voice ships with,
  // and with the envelope MEASURED from the sample (attack, decay, sustain).
  // A Warm pad ships with a 2.4 s swell; started there, the search for a 0.6 s
  // sample settled at 0.25 s with Detune wrenched to compensate (70%), while
  // the measured start sits next to the true patch (90%).
  const measuredEnv = (cand) => {
    const patch = clone(cand.defaults);
    const set = (field, value) => {
      const f = (cand.fields || []).find((x) => x.field === field);
      if (f && Number.isFinite(value)) setPath(patch, field, fromPosition(toPosition(value, f), f));
    };
    set('adsr.attack', Math.max(0.001, target.attack));
    set('adsr.decay', target.decay);
    set('adsr.sustain', target.sustain);
    return patch;
  };
  const arms = [];
  for (const cand of candidates) {
    const starts = [clone(cand.defaults)];
    const fitted = measuredEnv(cand);
    if (JSON.stringify(fitted) !== JSON.stringify(starts[0])) starts.push(fitted);
    for (const shift of opts.octaves === false ? [0] : [0, 12, -12]) {
      for (const startPatch of starts) {
        if (userCancelled()) break;
        const patch = { ...clone(startPatch), _note: { held: note.duration, shift } };
        arms.push({ cand, patch, start: await measure(cand.id, patch) });
      }
    }
  }
  arms.forEach((a) => { a.distance = a.start; });
  rankingDone = true;

  const ordered = (cand) => {
    const fields = cand.fields || [];
    const env = fields.filter((f) => f.field.startsWith('adsr.'));
    const rest = fields.filter((f) => !f.field.startsWith('adsr.'));
    return { env: [HELD_FIELD, ...env], all: [HELD_FIELD, ...env, ...rest] };
  };
  const pool = budget - used;

  // Stage 2: fit every contender's held length and envelope — how a note
  // starts and fades is the loudest difference between two sounds and the
  // cheapest to change — then keep each voice's best octave.
  const envEnd = Math.min(budget, used + Math.floor(pool * 0.3));
  for (let i = 0; i < arms.length; i++) {
    const allowance = used + Math.floor((envEnd - used) / (arms.length - i));
    await descend(arms[i], ordered(arms[i].cand).env, [0.25], allowance);
  }
  // `start` stays what the voice measured as shipped on the sample's own note.
  const byVoice = new Map();
  for (const arm of arms) {
    const kept = byVoice.get(arm.cand.id);
    if (!kept || arm.distance < kept.distance) byVoice.set(arm.cand.id, arm);
  }
  const scored = [...byVoice.values()].map((arm) => ({
    ...arm,
    start: arms.find((x) => x.cand.id === arm.cand.id).start,
  }));

  // Stage 3: rounds of successive halving. Every voice still in the running
  // gets an equal share of the round's renders to turn ALL its dials, then
  // the weaker half drops out and the steps get finer. A fixed shortlist from
  // the defaults was measured to fail: a Warm pad sample ranked Warm fourth of
  // five AS SHIPPED, so its filter was never turned and Poly saw won.
  let alive = scored.slice().sort((a, b) => a.distance - b.distance);
  const ROUNDS = [[0.25, 0.35], [0.12, 0.2], [0.06, 0.1], [0.03, 0.05]];
  for (const [step, share] of ROUNDS) {
    if (cancelled() || used >= budget) break;
    const roundEnd = Math.min(budget, used + Math.floor(pool * share));
    for (let i = 0; i < alive.length; i++) {
      const allowance = used + Math.floor((roundEnd - used) / (alive.length - i));
      await descend(alive[i], ordered(alive[i].cand).all, [step], allowance, { evolve: true });
    }
    alive.sort((a, b) => a.distance - b.distance);
    alive = alive.slice(0, Math.max(1, Math.ceil(alive.length / 2)));
  }
  // Whatever the rounds left unspent goes to the leader.
  if (alive[0] && used < budget && !cancelled()) await descend(alive[0], ordered(alive[0].cand).all, [0.06, 0.03], budget, { evolve: true });

  scored.sort((a, b) => a.distance - b.distance);
  const best = scored[0] || null;
  const ranked = scored.map((s) => ({
    id: s.cand.id,
    label: s.cand.label || s.cand.id,
    distance: s.distance,
    similarity: similarity(s.distance),
    start: s.start,
  }));
  if (!best) return { best: null, ranked, renders: used, note, stoppedEarly: false };
  const { _note: held, ...bestPatch } = best.patch;
  const moves = [];
  for (const f of best.cand.fields || []) {
    const was = getPath(best.cand.defaults, f.field);
    const now = getPath(best.patch, f.field);
    if (was === now) continue;
    if (f.kind === 'enum') moves.push({ field: f.field, from: was, to: now, direction: 'set' });
    else moves.push({ field: f.field, from: was, to: now, direction: now > was ? 'up' : 'down' });
  }
  return {
    best: {
      id: best.cand.id,
      label: best.cand.label || best.cand.id,
      patch: bestPatch,
      held: held ? held.held : note.duration,
      shift: held ? held.shift : 0,
      distance: best.distance,
      similarity: similarity(best.distance),
      start: best.start,
      moves,
    },
    ranked,
    renders: used,
    note,
    // true when the search ended on goodEnough rather than its budget
    stoppedEarly: earlyStop && !userCancelled(),
  };
}

/**
 * Run `fn` with Math.random replaced by a fixed-seed generator, then restore
 * it. Several voices draw random phases, detunes and grain times as they
 * build a note; measured, that alone put Grains and Cloud at under 20% alike
 * TO THEMSELVES, which no search can see through. A voice builds its whole
 * graph synchronously inside play(), so seeding that call is enough: every
 * candidate is the same note every time it is rendered.
 */
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export function withSeededRandom(fn, seed = 0x5eed) {
  const real = Math.random;
  Math.random = seededRandom(seed);
  try {
    return fn();
  } finally {
    Math.random = real;
  }
}

/**
 * One line for a person: what was heard and what it became.
 * `nameOf(field)` turns 'adsr.attack' into the dial's label.
 */
const moveSize = (m) => (m.direction === 'set' ? Infinity : Math.abs(Math.log(Math.abs(m.to) + 1e-3) - Math.log(Math.abs(m.from) + 1e-3)));

export function describeMatch(target, result, nameOf = (f) => f) {
  if (!result || !result.best) return 'Nothing on this track measured close to that sample.';
  const heard = target.pitched && target.note ? `Heard ${target.note.name}` : 'Heard an unpitched sound';
  const b = result.best;
  const moved = b.moves
    .slice()
    .sort((x, y) => moveSize(y) - moveSize(x))
    .slice(0, 3)
    .map((m) => (m.direction === 'set' ? `${nameOf(m.field)} ${m.to}` : `${nameOf(m.field)} ${m.direction === 'up' ? '↑' : '↓'}`));
  const runnerUp = result.ranked[1];
  return `${heard}. Closest: ${b.label}, ${b.similarity}% alike${moved.length ? ` after ${moved.join(', ')}` : ' as it ships'}${runnerUp ? ` (next: ${runnerUp.label}, ${runnerUp.similarity}%)` : ''}.`;
}
