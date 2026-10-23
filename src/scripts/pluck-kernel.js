/**
 * pluck-kernel.js — the plucked string's DSP, sample by sample, with no Web
 * Audio in it (docs/synthesis-programme.md § 2, the physical-modelling row).
 *
 * A Karplus–Strong string: a delay line one period long, filled with a burst of
 * noise, read back through a loop that loses a little energy and a little top
 * end every time round. What comes out is a pitched, decaying, string-like tone
 * whose brightness falls as it rings — the defining sound of a plucked string.
 *
 * Why this is a kernel and not a DelayNode graph: a Web Audio feedback loop
 * through a DelayNode cannot be shorter than one 128-sample render quantum, so
 * at 48 kHz nothing above ~375 Hz could be modelled. Here the loop runs one
 * sample at a time inside an AudioWorkletProcessor (see pluckWorkletSource
 * below), so the string can be as short as two samples.
 *
 * The loop, per sample:
 *
 *   y[n] = x[n] + loss · LP( AP( y[n − M] ) )
 *
 *   x     the excitation: seeded white noise, darkened by a one-pole lowpass
 *         (brightness and velocity open it), with its DC taken out, combed by
 *         the pluck POSITION (a pluck at 1/k of the string cancels every k-th
 *         harmonic: e[n] − e[n − position·period]), and scaled — by playing
 *         the first periods once and reading their peak — so every pluck
 *         leaves at a peak of 0.62 and never passes ±0.95
 *   M     the integer part of the loop delay
 *   AP    a first-order allpass for the fractional part — unity gain at every
 *         frequency, so it tunes without damping the top notes the way linear
 *         interpolation would
 *   LP    the one-pole loop filter, (1 − a)·x + a·y[n − 1]: unity at DC, and a
 *         little darker every pass. BRIGHTNESS sets `a`, through a corner
 *         placed between the 8th and the 200th harmonic of the note.
 *   loss  the per-period gain that sets how long the fundamental rings —
 *         DAMPING maps to a T60 between 8 s and 0.2 s, and the loss is solved
 *         from it so the fundamental falls 60 dB in exactly that time
 *
 * Tuning is exact at the fundamental: the loop filter's own phase delay at the
 * note's frequency is measured and subtracted, and the allpass coefficient is
 * solved by bisection so ITS phase delay at that frequency makes up the rest.
 * tests/pluck-smoke.mjs measures the period at 110, 440 and 880 Hz.
 *
 * SELF-CONTAINED ON PURPOSE. `createPluckString` and `definePluckProcessor`
 * reference nothing outside their own bodies but `Math` and `Float32Array`,
 * because the worklet is built from their SOURCE TEXT (`fn.toString()`) and
 * loaded from a Blob URL. That is what lets dev, the production build and
 * Node all run these exact bytes with no public/ file and no bundler plugin:
 * a minifier renames identifiers, but it renames them consistently inside a
 * function, and the factory is handed to the processor as an argument rather
 * than by name. Keep it that way — a helper hoisted out of either function
 * would be undefined inside the worklet.
 */

/**
 * One string. `options`:
 *   sampleRate  Hz
 *   freq        the note, Hz (clamped so the loop is at least two samples)
 *   damping     0–1: 0 rings ~8 s at the fundamental, 1 is choked (~0.2 s)
 *   brightness  0–1: 0 a thumb on a dark string, 1 a pick on a bright one
 *   position    0.05–0.5 of the string's length from the bridge
 *   velocity    0–1: harder is brighter in the excitation (not louder — the
 *               voice's envelope owns the level)
 *   seed        integer: the same seed is the same pluck, sample for sample
 *
 * Returns { render(out, offset, count), next(), period, loss, coefficient,
 * allpass, t60 }. `render` writes `count` samples into `out` from `offset`.
 */
export function createPluckString(options) {
  const o = options || {};
  const num = (v, lo, hi, fallback) => (
    typeof v === 'number' && v === v && v > -Infinity && v < Infinity
      ? (v < lo ? lo : v > hi ? hi : v)
      : fallback
  );
  const sr = num(o.sampleRate, 3000, 768000, 48000);
  const freq = num(o.freq, 20, sr / 4, 440);
  const damping = num(o.damping, 0, 1, 0.4);
  const brightness = num(o.brightness, 0, 1, 0.5);
  const position = num(o.position, 0.05, 0.5, 0.18);
  const velocity = num(o.velocity, 0, 1, 0.7);
  let seed = (typeof o.seed === 'number' && o.seed === o.seed ? Math.floor(o.seed) : 1) >>> 0;

  // mulberry32: small, fast, and the same stream on every engine.
  const random = () => {
    seed = (seed + 0x6D2B79F5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const w0 = (2 * Math.PI * freq) / sr;
  const period = sr / freq;

  // -- the loop filter. Its corner is set in HARMONICS of the note, not in
  // hertz: the loop runs once per period, so a corner at the k-th harmonic
  // darkens a 110 Hz string and an 880 Hz one by the same amount per period,
  // and the timbre holds across the keyboard. Brightness 0 puts the corner at
  // the 8th harmonic (a thumb on an old string), 1 at the 200th (a pick).
  const corner = 8 * Math.pow(200 / 8, brightness);
  const a = Math.exp(-Math.min(corner * w0, 30));
  // Its magnitude and phase delay at the fundamental, for the loss and tuning.
  const lpRe = 1 - a * Math.cos(w0);
  const lpIm = a * Math.sin(w0);
  const lpMag = (1 - a) / Math.sqrt(lpRe * lpRe + lpIm * lpIm);
  const lpDelay = Math.atan2(lpIm, lpRe) / w0;

  // -- the loss: the fundamental falls 60 dB in t60 seconds.
  const t60 = 8 * Math.pow(0.2 / 8, damping);
  const perPeriod = Math.pow(10, -3 / (t60 * freq));
  const loss = Math.min(perPeriod / lpMag, 0.99995);

  // -- the delay: integer M plus an allpass for what is left, keeping the
  // allpass's own delay in [0.5, 1.5) where a first-order section behaves.
  const rest = period - lpDelay;
  const M = Math.max(1, Math.floor(rest - 0.5));
  const want = rest - M;
  const apDelay = (eta) => {
    // A(z) = (eta + z^-1) / (1 + eta z^-1), phase delay at w0.
    const nRe = eta + Math.cos(w0);
    const nIm = -Math.sin(w0);
    const dRe = 1 + eta * Math.cos(w0);
    const dIm = -eta * Math.sin(w0);
    const phase = Math.atan2(nIm, nRe) - Math.atan2(dIm, dRe);
    return -phase / w0;
  };
  // Phase delay falls as eta rises; bisect on eta in (-0.95, 0.95).
  let lo = -0.95;
  let hi = 0.95;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (apDelay(mid) > want) lo = mid; else hi = mid;
  }
  const eta = (lo + hi) / 2;

  // -- the excitation: one period of seeded noise, darkened, DC-free, combed.
  const burst = Math.max(2, Math.round(period));
  const excite = 0.05 + 0.85 * (1 - brightness * (0.55 + 0.45 * velocity));
  const raw = new Float32Array(burst);
  let state = 0;
  let mean = 0;
  for (let i = 0; i < burst; i++) {
    state = (1 - excite) * (random() * 2 - 1) + excite * state;
    raw[i] = state;
    mean += state;
  }
  mean /= burst;
  const gap = Math.max(1, Math.round(position * period));
  const exc = new Float32Array(burst + gap);
  let peak = 0;
  for (let i = 0; i < exc.length; i++) {
    const now = i < burst ? raw[i] - mean : 0;
    const back = i - gap >= 0 && i - gap < burst ? raw[i - gap] - mean : 0;
    exc[i] = now - back;
    const m = exc[i] < 0 ? -exc[i] : exc[i];
    if (m > peak) peak = m;
  }
  const scale = peak > 0 ? 1 / peak : 0;
  for (let i = 0; i < exc.length; i++) exc[i] *= scale;

  const line = new Float32Array(M);
  let at = 0;
  let n = 0;
  let apIn = 0;
  let apOut = 0;
  let lp = 0;

  const next = () => {
    const x = n < exc.length ? exc[n] : 0;
    n += 1;
    const v = line[at];
    const ap = eta * v + apIn - eta * apOut;
    apIn = v;
    apOut = ap;
    lp = (1 - a) * ap + a * lp;
    const y = x + loss * lp;
    line[at] = y;
    at += 1;
    if (at >= M) at = 0;
    return y;
  };

  // NORMALISE BY PRE-ROLL. Where the string peaks depends on how the comb's
  // tail overlaps the loop's first return, which no closed form gives cheaply.
  // So the first stretch is played once — the excitation, then eight trips
  // round the loop — its peak read, the state wiped, and the excitation
  // rescaled so that peak is PEAK_TARGET. The system is linear, so this is
  // exactly the same pluck at a known level: every note leaves at the same
  // peak, whatever its dials. The target leaves headroom because a bright,
  // barely damped string can PEAK higher later than it did at first — the
  // allpass's slight dispersion walks the harmonics' phases, and their sum
  // realigns — by up to 1.5x on pluck-smoke's grid, whose worst is 0.93.
  const PEAK_TARGET = 0.62;
  let pre = 0;
  for (let i = exc.length + 8 * M + 8; i > 0; i--) {
    const y = next();
    const m = y < 0 ? -y : y;
    if (m > pre) pre = m;
  }
  line.fill(0);
  at = 0;
  n = 0;
  apIn = 0;
  apOut = 0;
  lp = 0;
  if (pre > 0) {
    const k = PEAK_TARGET / pre;
    for (let i = 0; i < exc.length; i++) exc[i] *= k;
  }

  const render = (out, offset, count) => {
    const end = offset + count;
    for (let i = offset; i < end; i++) out[i] = next();
    return out;
  };

  return {
    next, render, period, loss, coefficient: a, allpass: eta, t60, delay: M,
  };
}

/**
 * The AudioWorkletProcessor, as a function the worklet scope CALLS with the
 * string factory. It reads nothing from outside its own body: the processor
 * class is declared inside, against the worklet global scope's
 * AudioWorkletProcessor / registerProcessor / currentTime / sampleRate.
 *
 * One processor per note. processorOptions: { freq, damping, brightness,
 * position, velocity, seed, start, stop } — `start` and `stop` in context
 * seconds. Silent before `start` (the pluck lands on the exact sample), the
 * string after it, silent again from `stop`, and `process` returns false once
 * `stop` has passed so the node can be collected. The voice's own envelope
 * owns onset and release, so this never has to fade.
 */
export function definePluckProcessor(factory) {
  /* global AudioWorkletProcessor, registerProcessor, currentTime, sampleRate */
  class PluckStringProcessor extends AudioWorkletProcessor {
    constructor(init) {
      super();
      const o = (init && init.processorOptions) || {};
      this.o = o;
      this.start = typeof o.start === 'number' ? o.start : 0;
      this.stop = typeof o.stop === 'number' ? o.stop : Infinity;
      this.string = null;
    }

    process(inputs, outputs) {
      const out = outputs[0] && outputs[0][0];
      if (!out) return currentTime < this.stop;
      const block = out.length;
      for (let i = 0; i < block; i++) {
        const t = currentTime + i / sampleRate;
        if (t < this.start || t >= this.stop) { out[i] = 0; continue; }
        if (!this.string) {
          this.string = factory({
            sampleRate,
            freq: this.o.freq,
            damping: this.o.damping,
            brightness: this.o.brightness,
            position: this.o.position,
            velocity: this.o.velocity,
            seed: this.o.seed,
          });
        }
        out[i] = this.string.next();
      }
      for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
      return currentTime < this.stop;
    }
  }
  registerProcessor('ambi4-pluck-string', PluckStringProcessor);
}

/**
 * The T60 a damping dial means, in seconds — the same law createPluckString
 * applies inside itself (it cannot call this: see the header). The voice uses
 * it to know how long the string can ring; pluck-smoke holds the two equal.
 */
export const pluckT60 = (damping) => 8 * Math.pow(0.2 / 8, Math.min(Math.max(Number.isFinite(damping) ? damping : 0.4, 0), 1));

/** The processor's registered name, for the voice that instantiates it. */
export const PLUCK_PROCESSOR = 'ambi4-pluck-string';

/**
 * The worklet module's source text: the factory and the processor, joined so
 * the processor receives the factory as its argument. Loaded through a Blob
 * URL by engine-voices.js — see the module header for why.
 */
export function pluckWorkletSource() {
  return `(${definePluckProcessor.toString()})(${createPluckString.toString()});\n`;
}
