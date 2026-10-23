/**
 * pulse-kernel.js — a band-limited pulse oscillator and a hard-sync pair,
 * sample by sample, with no Web Audio in it (docs/synthesis-programme.md § 2,
 * the "PWM, hard sync" row).
 *
 * Why this is a kernel and not an OscillatorNode: Web Audio has no oscillator
 * sync at all, and its only pulse is the fixed 50 % square — a pulse of any
 * other width needs a PeriodicWave per width, rebuilt whenever the width
 * moves. Here one phase accumulator runs inside an AudioWorkletProcessor (see
 * definePulseProcessor below), so the width and the sync ratio are plain
 * numbers it reads every sample — a-rate AudioParams, ready to be modulated.
 *
 * ONE CORE, TWO MODES. A MASTER phase m runs at the note's frequency and
 * wraps once a period. The sounding oscillator — the SLAVE — has the phase
 *
 *   s = frac(m · ratio)
 *
 * so it runs `ratio` times faster than the master and is forced back to zero
 * every time the master wraps: that IS hard sync, and because s is computed
 * from m rather than accumulated beside it, the reset lands exactly on the
 * master's period by construction. Mode 'pulse' is the same core at ratio 1,
 * where the slave is the master and nothing is reset early — a free-running
 * pulse. Mode 'sync' reads the ratio (1–8) and plays a saw or a pulse slave.
 *
 * The naive waveform is
 *
 *   saw    2s − 1
 *   pulse  +1 while s < width, −1 after it
 *
 * and every jump in it — the saw's wrap, the pulse's rising and falling
 * edges, and the sync reset (a jump of whatever height the slave was at) —
 * is an event with a height h and a time inside the sample. Each event is
 * smoothed with a two-sample PolyBLEP: the sample before it gains
 * h/2 · τ², the sample after it −h/2 · (1 − τ)², τ being how far the event
 * sits before the later sample (in samples). That residual is the difference
 * between a hard step and a band-limited one, to second order, so the energy
 * a naive step folds back below Nyquist as inharmonic grit is mostly gone. The
 * correction reaches one sample BACK, so the output runs one sample late
 * (21 µs at 48 kHz — the onset is the envelope's, and nothing can hear it).
 *
 * DC. A pulse of width w averages 2w − 1, and a synced slave whose ratio is
 * not whole averages something else again; both are known in closed form
 * from the current width and ratio, and subtracted every sample, so the output
 * is centred whatever the dials say — and stays centred while they move.
 *
 * Level: the output is half the DC-free wave, so a 50 % pulse is ±0.5, a saw
 * slave stays within ±0.625, and the narrowest pulse (5 %) peaks at 0.95.
 * tests/pwm-sync-smoke.mjs holds every corner under 1.
 *
 * Limits, so the BLEP has a sample either side of every edge to work with:
 * the master is clamped to a quarter of the sample rate, the slave's rate
 * (note × ratio) to a quarter as well — at a high note a large ratio is
 * capped, never aliased — and the pulse width to at least one slave step
 * from either end.
 *
 * SELF-CONTAINED ON PURPOSE, exactly as pluck-kernel.js is:
 * `createPulseOscillator` and `definePulseProcessor` reference nothing
 * outside their own bodies but `Math` and `Float32Array`, because the
 * worklet is built from their SOURCE TEXT (`fn.toString()`) and loaded from a
 * Blob URL. A helper hoisted out of either would be undefined in the worklet.
 */

/**
 * One oscillator. `options`:
 *   sampleRate  Hz
 *   mode        'pulse' (a free-running pulse) or 'sync' (a slave reset by
 *               the master at the note)
 *   slave       'saw' or 'pulse' — the synced oscillator's shape (mode 'sync');
 *               mode 'pulse' is always a pulse
 *   bandLimit   false for the NAIVE wave (no PolyBLEP) — the tests' control
 *   trace       true to record every sync reset's time, in samples, in
 *               `resets` (tests only; it grows without bound)
 *
 * Returns { next(freq, width, ratio), render(out, offset, count, freq, width,
 * ratio), master(), slave(), resets, count() }. `next` advances one sample
 * and returns it; the dials are read every call, so they may move per sample.
 */
export function createPulseOscillator(options) {
  const o = options || {};
  const fin = (v) => typeof v === 'number' && v === v && v > -Infinity && v < Infinity;
  const sr = fin(o.sampleRate) ? Math.min(Math.max(o.sampleRate, 3000), 768000) : 48000;
  const sync = o.mode === 'sync';
  const pulseWave = !sync || o.slave === 'pulse';
  const smooth = o.bandLimit !== false;
  const trace = o.trace === true;
  const resets = [];

  let m = 0;          // master phase, [0, 1)
  let prev = 0;       // the previous sample, still open to a BLEP correction
  let prevDc = 0;     // and the DC it is to be centred by
  let n = 0;          // samples produced
  let ratioNow = 1;   // the last ratio used, for slave()

  const next = (freqIn, widthIn, ratioIn) => {
    const f = fin(freqIn) ? freqIn : 440;
    const dt = Math.min(Math.max(f / sr, 1e-7), 0.25);
    let r = sync && fin(ratioIn) ? Math.min(Math.max(ratioIn, 1), 8) : 1;
    // The slave may not outrun a quarter of the sample rate: past it, a step
    // a sample could fold right back down, and the BLEP has nowhere to go.
    if (r * dt > 0.25) r = Math.max(1, 0.25 / dt);
    ratioNow = r;
    const ds = r * dt;
    let w = 0.5;
    if (pulseWave) {
      w = fin(widthIn) ? Math.min(Math.max(widthIn, 0.05), 0.95) : 0.5;
      // Each half of the pulse at least one slave step long.
      if (w < ds) w = ds;
      if (w > 1 - ds) w = 1 - ds;
    }

    const wave = (s) => (pulseWave ? (s < w ? 1 : -1) : 2 * s - 1);
    let cur = 0;
    let before = 0;
    // An event `te` of the way through this sample (0 < te <= 1), height h.
    const event = (te, h) => {
      if (!smooth) return;
      const tau = 1 - te;
      before += (h / 2) * tau * tau;
      cur -= (h / 2) * (1 - tau) * (1 - tau);
    };
    // The slave's own edges while the master moves from m0 to m1 (no reset
    // between), over the slice of this sample that starts at `t0`. Slave
    // position u = m · r; a wrap is a whole number, a falling edge k + w.
    const edges = (m0, m1, t0, includeEnd) => {
      const u0 = m0 * r;
      const u1 = m1 * r;
      const at = (u) => t0 + (u / r - m0) / dt;
      for (let k = Math.floor(u0) + 1; k < u1 || (includeEnd && k === u1); k++) {
        // Saw: +1 drops to −1. Pulse: −1 rises to +1.
        event(at(k), pulseWave ? 2 : -2);
      }
      if (pulseWave) {
        for (let k = Math.floor(u0 - w) + 1; k + w < u1 || (includeEnd && k + w === u1); k++) {
          if (k + w > u0) event(at(k + w), -2);
        }
      }
    };

    const m1 = m + dt;
    if (m1 < 1) {
      edges(m, m1, 0, true);
      m = m1;
    } else {
      // The master wraps inside this sample, `tr` of the way through: the
      // slave runs to it, is reset to zero, and runs on from there.
      const tr = (1 - m) / dt;
      edges(m, 1, 0, false);
      if (sync) {
        // The slave's value just before the reset (the limit from below at
        // u = r: at a whole ratio that is the top of its last cycle).
        let f0 = r - Math.floor(r);
        if (f0 === 0) f0 = 1;
        const left = pulseWave ? (f0 <= w ? 1 : -1) : 2 * f0 - 1;
        const h = wave(0) - left;
        if (h !== 0) event(tr, h);
        if (trace) resets.push(n + tr);
      } else {
        // Ratio 1: the reset IS the pulse's own rising edge.
        event(tr, 2);
      }
      m = m1 - 1;
      // What is left of the sample, after the reset: edges in (0, m·r].
      const u1 = m * r;
      for (let k = 1; k < u1 || k === u1; k++) event(tr + (k / r) / dt, pulseWave ? 2 : -2);
      if (pulseWave) {
        for (let k = 0; k + w < u1 || k + w === u1; k++) event(tr + ((k + w) / r) / dt, -2);
      }
    }

    // The naive value at the end of the sample, plus its corrections.
    cur += wave(m * r - Math.floor(m * r));
    // DC over one master period, at this width and ratio: whole slave cycles
    // average 2w − 1 (pulse) or 0 (saw); the part-cycle the reset cuts off,
    // fr = frac(r), adds its own share.
    const whole = Math.floor(r);
    const fr = r - whole;
    const dc = pulseWave
      ? (whole * (2 * w - 1) + 2 * Math.min(fr, w) - fr) / r
      : (fr * fr - fr) / r;

    // The previous sample is complete now that this one's events have
    // reached back into it: it goes out, centred by its own DC, and this one
    // waits a sample for the next one's.
    const out = 0.5 * (prev + before - prevDc);
    prev = cur;
    prevDc = dc;
    n += 1;
    return out;
  };

  const render = (out, offset, count, freq, width, ratio) => {
    const end = offset + count;
    for (let i = offset; i < end; i++) out[i] = next(freq, width, ratio);
    return out;
  };

  return {
    next,
    render,
    resets,
    /** The master's phase now, [0, 1). */
    master: () => m,
    /** The slave's phase now: frac(master × ratio), by construction. */
    slave: () => m * ratioNow - Math.floor(m * ratioNow),
    /** Samples produced. */
    count: () => n,
  };
}

/**
 * The AudioWorkletProcessor, as a function the worklet scope CALLS with the
 * oscillator factory — the same shape as definePluckProcessor. Three a-rate
 * AudioParams, read per sample (a block of one value when unautomated):
 *
 *   frequency  Hz, the note (a glide moves it)
 *   width      0.05–0.95, the pulse's duty cycle
 *   ratio      1–8, the synced slave's frequency over the note
 *
 * processorOptions: { mode, slave, start, stop } — start and stop in context
 * seconds; a { stop } message on the port moves the stop (the voice sends one
 * with every stop its rig schedules). Silent before `start`, the oscillator
 * after it, silent again from `stop`, and `process` returns false once `stop`
 * has passed. The voice's
 * envelope owns onset and release, so this never fades.
 */
export function definePulseProcessor(factory) {
  /* global AudioWorkletProcessor, registerProcessor, currentTime, sampleRate */
  class PulseOscillatorProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
      return [
        { name: 'frequency', defaultValue: 440, minValue: 1, maxValue: 20000, automationRate: 'a-rate' },
        { name: 'width', defaultValue: 0.5, minValue: 0.05, maxValue: 0.95, automationRate: 'a-rate' },
        { name: 'ratio', defaultValue: 1, minValue: 1, maxValue: 8, automationRate: 'a-rate' },
      ];
    }

    constructor(init) {
      super();
      const o = (init && init.processorOptions) || {};
      this.o = o;
      this.start = typeof o.start === 'number' ? o.start : 0;
      this.stop = typeof o.stop === 'number' ? o.stop : Infinity;
      this.osc = null;
      // The voice moves `stop` after construction — a legato glide holds the
      // note longer, a cancel ends it sooner — by posting { stop } here.
      if (this.port) {
        this.port.onmessage = (event) => {
          const data = event && event.data;
          if (data && typeof data.stop === 'number' && data.stop === data.stop) this.stop = data.stop;
        };
      }
    }

    process(inputs, outputs, parameters) {
      const out = outputs[0] && outputs[0][0];
      if (!out) return currentTime < this.stop;
      const p = parameters || {};
      const fq = p.frequency || [440];
      const wd = p.width || [0.5];
      const rt = p.ratio || [1];
      const block = out.length;
      // In FRAMES, not seconds: currentTime + i / sampleRate can land a
      // rounding error either side of `start` and slip the onset a sample.
      const frame0 = Math.round(currentTime * sampleRate);
      const startFrame = Math.round(this.start * sampleRate);
      const stopFrame = this.stop === Infinity ? Infinity : Math.round(this.stop * sampleRate);
      for (let i = 0; i < block; i++) {
        const frame = frame0 + i;
        if (frame < startFrame || frame >= stopFrame) { out[i] = 0; continue; }
        if (!this.osc) this.osc = factory({ sampleRate, mode: this.o.mode, slave: this.o.slave });
        out[i] = this.osc.next(
          fq.length > 1 ? fq[i] : fq[0],
          wd.length > 1 ? wd[i] : wd[0],
          rt.length > 1 ? rt[i] : rt[0],
        );
      }
      for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
      return currentTime < this.stop;
    }
  }
  registerProcessor('ambi4-pulse-osc', PulseOscillatorProcessor);
}

/** The processor's registered name, for the voices that instantiate it. */
export const PULSE_PROCESSOR = 'ambi4-pulse-osc';

/**
 * The worklet module's source text: the factory and the processor, joined so
 * the processor receives the factory as its argument. Loaded through a Blob
 * URL by engine-voices.js, as the plucked string's is.
 */
export function pulseWorkletSource() {
  return `(${definePulseProcessor.toString()})(${createPulseOscillator.toString()});\n`;
}
