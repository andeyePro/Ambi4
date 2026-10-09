/**
 * tests/wash-saw-render.mjs — the Ambient texture's saw, measured in Node.
 *
 *   node tests/wash-saw-render.mjs            (also discovered by tests/all.mjs)
 *   node tests/wash-saw-render.mjs --report   print every number, assert nothing
 *
 * The owner on Ambient (his 37 and 53, verbatim in the Q&A archive): "a noise
 * layer in it that always makes me think there's someone sawing", and the
 * genre verdict this closes: "the texture saws; keep the whistle, lose the
 * sweep". v0.0.80 stopped the wash's band CENTRE travelling, and v0.0.88 took
 * the noise out of `call`. What was still left in Ambient's own texture voice
 * (`texture/wash`) was a REPEAT, not a travel: both of its noise layers read
 * the shared two-second noise buffer on a loop, at playback rates 0.92 and
 * 1.07 — so the exact same noise figure, with every one of its little swells
 * and hollows, came round every 2.17 s and every 1.87 s for the whole note.
 * Coloured noise, which Ambient's voice wander can also land on, read the same
 * loop at rate 1: one figure, exactly every 2.00 s. A noise figure repeated at
 * a steady one-to-two-second stroke is a saw going back and forth; random
 * noise has no stroke at all.
 *
 * A saw is a measurement here, not a listen (nobody in this container can hear
 * it). The test asserts, on the body of a long held note:
 *
 *   - no stroke: the noise's own autocorrelation (the whistle's bins taken
 *     out, since a steady tone repeats at every one of its periods) stays near
 *     zero at every lag from 0.3 s to 3 s — the band that reads as a hand
 *     working a saw — and so does that of its 20 ms loudness, detrended
 *     against the note's own swell. Before the fix: wash 0.49 at 1.87 s,
 *     coloured noise 0.997 at 2.00 s. After: ~0.03.
 *   - no sweep: the centroid of half-second blocks travels under a third of
 *     an octave across the note (v0.0.80's guarantee, re-held here in Node:
 *     the pre-v0.0.80 wash measures 0.92 octaves, the current one ~0.09);
 *   - the whistle survives: the anchor sine at the note's own pitch still
 *     stands ~25 dB clear of the noise around it, as it did before.
 *
 * It renders the SHIPPED voice — `VOICES.texture.wash.play`, the function the
 * engine calls — through a small offline Web Audio graph evaluator defined
 * below (biquads to the spec's cookbook formulas, AudioParam automation, looped
 * buffer sources with playback rate, audio-rate modulation into params), so it
 * runs in Node with no browser and no Mac bridge. Math.random is seeded for
 * the render, so the numbers are reproducible run to run.
 */

import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT = process.argv.includes('--report');

// ---------------------------------------------------------------------------
// A minimal offline Web Audio graph evaluator (mono — channel 0 of every
// buffer, i.e. one ear; panning is ignored). Whole-buffer, pull-based, DAG
// only: none of the voices it is used for here has a feedback loop.
// ---------------------------------------------------------------------------

class Param {
  constructor(ctx, value) {
    this.ctx = ctx;
    this._value = value;
    this.events = [];
    this.inputs = [];
    this.defaultValue = value;
  }
  get value() { return this._value; }
  set value(v) { this._value = v; }
  _push(e) { this.events.push(e); this.events.sort((a, b) => a.time - b.time); return this; }
  setValueAtTime(value, time) { return this._push({ type: 'set', value, time }); }
  linearRampToValueAtTime(value, time) { return this._push({ type: 'lin', value, time }); }
  exponentialRampToValueAtTime(value, time) { return this._push({ type: 'exp', value, time }); }
  setTargetAtTime(target, time, tc) { return this._push({ type: 'target', value: target, time, tc }); }
  setValueCurveAtTime(values, time, duration) {
    return this._push({ type: 'curve', values: Array.from(values), time, duration });
  }
  cancelScheduledValues(time) { this.events = this.events.filter((e) => e.time < time); return this; }
  cancelAndHoldAtTime(time) {
    const sr = this.ctx.sampleRate;
    const n = Math.max(1, Math.ceil(time * sr) + 1);
    const held = this._automation(n)[n - 1];
    this.events = this.events.filter((e) => e.time < time);
    return this.setValueAtTime(held, time);
  }
  _automation(N) {
    const sr = this.ctx.sampleRate;
    const out = new Float32Array(N);
    const ev = this.events;
    let curV = this._value;
    let curT = 0;
    let k = 0;
    let active = null;
    for (let i = 0; i < N; i++) {
      const t = i / sr;
      let v = null;
      while (k < ev.length) {
        const e = ev[k];
        if (e.type === 'lin' || e.type === 'exp') {
          if (active) { curV = valueOf(active, e.time > curT ? curT : curT); }
          if (t < e.time) {
            const span = e.time - curT;
            const x = span > 0 ? (t - curT) / span : 1;
            if (e.type === 'lin') v = curV + (e.value - curV) * x;
            else v = curV > 0 === e.value > 0 && curV !== 0 && e.value !== 0
              ? curV * Math.pow(e.value / curV, x) : curV;
            break;
          }
          curV = e.value; curT = e.time; active = null; k++;
          continue;
        }
        if (e.time > t) break;
        if (e.type === 'set') { curV = e.value; curT = e.time; active = null; }
        else if (e.type === 'target') {
          const v0 = active ? valueOf(active, e.time) : curV;
          active = { kind: 'target', T: e.time, v0, target: e.value, tc: e.tc };
          curV = v0; curT = e.time;
        } else if (e.type === 'curve') {
          active = { kind: 'curve', T: e.time, values: e.values, duration: e.duration };
          curT = e.time + e.duration; curV = e.values[e.values.length - 1];
        }
        k++;
      }
      if (v === null) v = active ? valueOf(active, t) : curV;
      out[i] = v;
    }
    return out;
  }
  render(N) {
    const out = this._automation(N);
    for (const node of this.inputs) {
      const sig = node.output(N);
      for (let i = 0; i < N; i++) out[i] += sig[i];
    }
    return out;
  }
}

function valueOf(active, t) {
  if (active.kind === 'target') {
    return active.target + (active.v0 - active.target) * Math.exp(-(t - active.T) / Math.max(active.tc, 1e-9));
  }
  const { values, T, duration } = active;
  if (t >= T + duration) return values[values.length - 1];
  const x = ((t - T) / duration) * (values.length - 1);
  const j = Math.floor(x);
  const f = x - j;
  return values[j] + ((values[j + 1] ?? values[j]) - values[j]) * f;
}

class Node {
  constructor(ctx) { this.ctx = ctx; this.inputs = []; this._out = null; this.onended = null; }
  connect(dest) {
    if (dest instanceof Param) dest.inputs.push(this);
    else dest.inputs.push(this);
    return dest;
  }
  disconnect() {}
  _in(N) {
    const sum = new Float32Array(N);
    for (const node of this.inputs) {
      const sig = node.output(N);
      for (let i = 0; i < N; i++) sum[i] += sig[i];
    }
    return sum;
  }
  output(N) {
    if (this._out) return this._out;
    if (this._busy) throw new Error('offline render: feedback loop in the graph');
    this._busy = true;
    this._out = this.process(N);
    this._busy = false;
    return this._out;
  }
  process(N) { return this._in(N); }
}

class Gain extends Node {
  constructor(ctx) { super(ctx); this.gain = new Param(ctx, 1); }
  process(N) {
    const x = this._in(N);
    const g = this.gain.render(N);
    for (let i = 0; i < N; i++) x[i] *= g[i];
    return x;
  }
}

class Scheduled extends Node {
  constructor(ctx) { super(ctx); this.startTime = Infinity; this.stopTime = Infinity; }
  start(when = 0, offset = 0) { this.startTime = when; this.offset = offset; }
  stop(when = 0) { this.stopTime = when; }
}

class Oscillator extends Scheduled {
  constructor(ctx) {
    super(ctx);
    this.type = 'sine';
    this.frequency = new Param(ctx, 440);
    this.detune = new Param(ctx, 0);
    this.wave = null;
  }
  setPeriodicWave(wave) { this.type = 'custom'; this.wave = wave; }
  process(N) {
    const sr = this.ctx.sampleRate;
    const f = this.frequency.render(N);
    const d = this.detune.render(N);
    const out = new Float32Array(N);
    const a = Math.max(0, Math.ceil(this.startTime * sr));
    const b = Math.min(N, Math.ceil(this.stopTime * sr));
    let phase = 0;
    for (let i = a; i < b; i++) {
      const hz = f[i] * Math.pow(2, d[i] / 1200);
      const p = phase - Math.floor(phase);
      let s;
      switch (this.type) {
        case 'sine': s = Math.sin(2 * Math.PI * p); break;
        case 'square': s = p < 0.5 ? 1 : -1; break;
        case 'sawtooth': s = 2 * p - 1; break;
        case 'triangle': s = p < 0.25 ? 4 * p : p < 0.75 ? 2 - 4 * p : 4 * p - 4; break;
        default: {
          s = 0;
          const im = this.wave.imag;
          for (let n = 1; n < im.length && n * hz < sr / 2; n++) s += im[n] * Math.sin(2 * Math.PI * n * p);
          s *= this.wave.norm;
        }
      }
      out[i] = s;
      phase += hz / sr;
    }
    return out;
  }
}

class BufferSource extends Scheduled {
  constructor(ctx) {
    super(ctx);
    this.buffer = null;
    this.loop = false;
    this.playbackRate = new Param(ctx, 1);
    this.detune = new Param(ctx, 0);
  }
  process(N) {
    const sr = this.ctx.sampleRate;
    const out = new Float32Array(N);
    if (!this.buffer) return out;
    const data = this.buffer.getChannelData(0);
    const len = data.length;
    const ratio = this.buffer.sampleRate / sr;
    const rate = this.playbackRate.render(N);
    const a = Math.max(0, Math.ceil(this.startTime * sr));
    const b = Math.min(N, Math.ceil(this.stopTime * sr));
    let pos = (this.offset || 0) * this.buffer.sampleRate;
    for (let i = a; i < b; i++) {
      if (this.loop) pos = ((pos % len) + len) % len;
      else if (pos >= len) break;
      const j = Math.floor(pos);
      const fr = pos - j;
      out[i] = data[j] + ((data[(j + 1) % len]) - data[j]) * fr;
      pos += rate[i] * ratio;
    }
    return out;
  }
}

class Biquad extends Node {
  constructor(ctx) {
    super(ctx);
    this.type = 'lowpass';
    this.frequency = new Param(ctx, 350);
    this.Q = new Param(ctx, 1);
    this.gain = new Param(ctx, 0);
    this.detune = new Param(ctx, 0);
  }
  process(N) {
    const sr = this.ctx.sampleRate;
    const x = this._in(N);
    const F = this.frequency.render(N);
    const Qa = this.Q.render(N);
    const G = this.gain.render(N);
    const D = this.detune.render(N);
    const out = new Float32Array(N);
    let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
    let key = NaN; let b0 = 0; let b1 = 0; let b2 = 0; let a1 = 0; let a2 = 0;
    for (let i = 0; i < N; i++) {
      const f0 = Math.min(Math.max(F[i] * Math.pow(2, D[i] / 1200), 1), sr / 2 - 1);
      const k2 = f0 * 1e6 + Qa[i] * 1e3 + G[i];
      if (k2 !== key) {
        key = k2;
        const w0 = 2 * Math.PI * f0 / sr;
        const cw = Math.cos(w0);
        const sw = Math.sin(w0);
        const Q = Qa[i];
        const A = Math.pow(10, G[i] / 40);
        let c;
        switch (this.type) {
          case 'lowpass': { const al = sw / (2 * Math.pow(10, Q / 20)); c = [(1 - cw) / 2, 1 - cw, (1 - cw) / 2, 1 + al, -2 * cw, 1 - al]; break; }
          case 'highpass': { const al = sw / (2 * Math.pow(10, Q / 20)); c = [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2, 1 + al, -2 * cw, 1 - al]; break; }
          case 'bandpass': { const al = sw / (2 * Math.max(Q, 1e-4)); c = [al, 0, -al, 1 + al, -2 * cw, 1 - al]; break; }
          case 'notch': { const al = sw / (2 * Math.max(Q, 1e-4)); c = [1, -2 * cw, 1, 1 + al, -2 * cw, 1 - al]; break; }
          case 'allpass': { const al = sw / (2 * Math.max(Q, 1e-4)); c = [1 - al, -2 * cw, 1 + al, 1 + al, -2 * cw, 1 - al]; break; }
          case 'peaking': { const al = sw / (2 * Math.max(Q, 1e-4)); c = [1 + al * A, -2 * cw, 1 - al * A, 1 + al / A, -2 * cw, 1 - al / A]; break; }
          case 'lowshelf': {
            const al = sw / 2 * Math.SQRT2; const s = 2 * Math.sqrt(A) * al;
            c = [A * ((A + 1) - (A - 1) * cw + s), 2 * A * ((A - 1) - (A + 1) * cw), A * ((A + 1) - (A - 1) * cw - s),
              (A + 1) + (A - 1) * cw + s, -2 * ((A - 1) + (A + 1) * cw), (A + 1) + (A - 1) * cw - s];
            break;
          }
          case 'highshelf': {
            const al = sw / 2 * Math.SQRT2; const s = 2 * Math.sqrt(A) * al;
            c = [A * ((A + 1) + (A - 1) * cw + s), -2 * A * ((A - 1) + (A + 1) * cw), A * ((A + 1) + (A - 1) * cw - s),
              (A + 1) - (A - 1) * cw + s, 2 * ((A - 1) - (A + 1) * cw), (A + 1) - (A - 1) * cw - s];
            break;
          }
          default: throw new Error('offline render: biquad type ' + this.type);
        }
        b0 = c[0] / c[3]; b1 = c[1] / c[3]; b2 = c[2] / c[3]; a1 = c[4] / c[3]; a2 = c[5] / c[3];
      }
      const y = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x[i]; y2 = y1; y1 = y;
      out[i] = y;
    }
    return out;
  }
}

class Panner extends Node {
  constructor(ctx) { super(ctx); this.pan = new Param(ctx, 0); }
}

class Delay extends Node {
  constructor(ctx) { super(ctx); this.delayTime = new Param(ctx, 0); }
  process(N) {
    const x = this._in(N);
    const d = this.delayTime.render(N);
    const sr = this.ctx.sampleRate;
    const out = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const p = i - d[i] * sr;
      const j = Math.floor(p);
      if (j < 0) continue;
      const fr = p - j;
      out[i] = x[j] + ((x[j + 1] ?? x[j]) - x[j]) * fr;
    }
    return out;
  }
}

class Shaper extends Node {
  constructor(ctx) { super(ctx); this.curve = null; this.oversample = 'none'; }
  process(N) {
    const x = this._in(N);
    if (!this.curve) return x;
    const c = this.curve;
    const n = c.length;
    for (let i = 0; i < N; i++) {
      const v = (Math.max(-1, Math.min(1, x[i])) + 1) / 2 * (n - 1);
      const j = Math.min(Math.floor(v), n - 2);
      x[i] = c[j] + (c[j + 1] - c[j]) * (v - j);
    }
    return x;
  }
}

class Constant extends Scheduled {
  constructor(ctx) { super(ctx); this.offset = new Param(ctx, 1); }
  start(when = 0) { this.startTime = when; }
  process(N) {
    const sr = this.ctx.sampleRate;
    const o = this.offset.render(N);
    const out = new Float32Array(N);
    const a = Math.max(0, Math.ceil(this.startTime * sr));
    const b = Math.min(N, Math.ceil(this.stopTime * sr));
    for (let i = a; i < b; i++) out[i] = o[i];
    return out;
  }
}

class OfflineContext {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.currentTime = 0;
    this.destination = new Node(this);
  }
  createGain() { return new Gain(this); }
  createOscillator() { return new Oscillator(this); }
  createBufferSource() { return new BufferSource(this); }
  createBiquadFilter() { return new Biquad(this); }
  createStereoPanner() { return new Panner(this); }
  createDelay() { return new Delay(this); }
  createWaveShaper() { return new Shaper(this); }
  createConstantSource() { return new Constant(this); }
  createPeriodicWave(real, imag) {
    let peak = 0;
    for (let k = 0; k < 256; k++) {
      let s = 0;
      for (let n = 1; n < imag.length; n++) s += imag[n] * Math.sin(2 * Math.PI * n * k / 256);
      peak = Math.max(peak, Math.abs(s));
    }
    return { real, imag, norm: peak > 0 ? 1 / peak : 1 };
  }
  createBuffer(channels, length, sampleRate) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return {
      numberOfChannels: channels, length, sampleRate, duration: length / sampleRate,
      getChannelData: (c) => data[c],
    };
  }
  render(seconds) { return this.destination.output(Math.ceil(seconds * this.sampleRate)); }
}

function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Render one note of a shipped voice, Math.random seeded for the duration. */
function renderNote(voice, note, { seconds, sampleRate = 48000, seed = 7, patch = null }) {
  const real = Math.random;
  Math.random = seeded(seed);
  try {
    const ctx = new OfflineContext(sampleRate);
    voice.play(ctx, ctx.destination, note, patch);
    return { data: ctx.render(seconds), sampleRate };
  } finally {
    Math.random = real;
  }
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang); const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1; let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k]; const ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

/** Power spectrum of a Hann-windowed frame (length a power of two). */
function spectrum(data, start, size) {
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (size - 1));
    re[i] = (data[start + i] ?? 0) * w;
  }
  fft(re, im);
  const p = new Float64Array(size / 2);
  for (let k = 0; k < size / 2; k++) p[k] = re[k] * re[k] + im[k] * im[k];
  return p;
}

/** Loudness (dB) and spectral centroid (log2 Hz) tracks in hop-sized frames. */
function tracks(data, sr, from, to, { frame = 1024, hop = 960 } = {}) {
  const loud = [];
  const cent = [];
  for (let s = Math.floor(from * sr); s + frame <= Math.floor(to * sr); s += hop) {
    const p = spectrum(data, s, frame);
    let num = 0; let den = 0;
    for (let k = 1; k < p.length; k++) {
      const hz = k * sr / frame;
      if (hz < 100 || hz > 12000) continue;
      num += p[k] * hz; den += p[k];
    }
    loud.push(10 * Math.log10(den + 1e-20));
    cent.push(Math.log2(den > 0 ? num / den : 1));
  }
  return { loud, cent, frameSec: hop / sr };
}

/** Subtract a centred moving average: removes the note's own swell and fade. */
function detrend(xs, width) {
  const half = Math.floor(width / 2);
  return xs.map((x, i) => {
    let s = 0; let n = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(xs.length - 1, i + half); j++) { s += xs[j]; n++; }
    return x - s / n;
  });
}

/** The strongest normalised autocorrelation between two lags, and where. */
function strongestRepeat(xs, frameSec, lo, hi) {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const z = xs.map((x) => x - mean);
  let best = { r: -1, lag: null };
  for (let L = Math.round(lo / frameSec); L <= Math.round(hi / frameSec) && L < z.length - 10; L++) {
    let num = 0; let da = 0; let db = 0;
    for (let i = 0; i + L < z.length; i++) { num += z[i] * z[i + L]; da += z[i] * z[i]; db += z[i + L] * z[i + L]; }
    const r = num / Math.sqrt(da * db || 1);
    if (r > best.r) best = { r, lag: L * frameSec };
  }
  return { r: +best.r.toFixed(3), lag: best.lag === null ? null : +best.lag.toFixed(3) };
}

/** How far the tone at `hz` stands above the noise floor around it (dB). */
function tonalProminence(data, sr, from, to, hz) {
  const size = 16384;
  const acc = new Float64Array(size / 2);
  let frames = 0;
  for (let s = Math.floor(from * sr); s + size <= Math.floor(to * sr); s += size / 2) {
    const p = spectrum(data, s, size);
    for (let k = 0; k < p.length; k++) acc[k] += p[k];
    frames++;
  }
  const bin = Math.round(hz * size / sr);
  let peak = 0;
  for (let k = bin - 2; k <= bin + 2; k++) peak = Math.max(peak, acc[k]);
  // The floor: median of the bins a third of an octave either side, the tone's
  // own skirt (±8 bins) left out.
  const side = [];
  const lo = Math.round(bin / Math.pow(2, 1 / 3));
  const hi = Math.round(bin * Math.pow(2, 1 / 3));
  for (let k = lo; k <= hi; k++) if (Math.abs(k - bin) > 8) side.push(acc[k]);
  side.sort((a, b) => a - b);
  const floor = side[Math.floor(side.length / 2)] || 1e-30;
  return frames ? +(10 * Math.log10(peak / floor)).toFixed(1) : null;
}

/**
 * The waveform's own autocorrelation, by FFT, across a band of lags: does the
 * signal itself come round again? Unrepeated noise sits near zero at every
 * lag; a looped buffer read at rate r sits near its share of the mix at the
 * lag (buffer length / r). A steady tone correlates with itself at every
 * whole number of its periods, which would read as a "repeat" at any lag, so
 * the bins within 3% of each `tones` frequency — the whistle — are taken out
 * of the spectrum first: this asks about the noise alone.
 */
function waveformRepeat(data, sr, from, to, lo, hi, tones = []) {
  const a = Math.floor(from * sr);
  const n = Math.floor(to * sr) - a;
  let size = 1;
  while (size < 2 * n) size <<= 1;
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let i = 0; i < n; i++) re[i] = data[a + i];
  fft(re, im);
  for (let k = 0; k < size; k++) {
    const hz = (k <= size / 2 ? k : size - k) * sr / size;
    const tonal = tones.some((f) => Math.abs(hz - f) < f * 0.03);
    re[k] = tonal ? 0 : re[k] * re[k] + im[k] * im[k];
    im[k] = 0;
  }
  // Inverse by a second forward transform: the power spectrum is real and even.
  fft(re, im);
  const r0 = re[0] / size;
  let best = { r: -1, lag: null };
  for (let L = Math.round(lo * sr); L <= Math.round(hi * sr) && L < n; L++) {
    // Normalised for the shrinking overlap, so a long lag is not penalised.
    const r = (re[L] / size) / (r0 * (n - L) / n);
    if (r > best.r) best = { r, lag: L / sr };
  }
  return { r: +best.r.toFixed(3), lag: best.lag === null ? null : +best.lag.toFixed(3) };
}

/**
 * How far the centroid travels across the body, in octaves: the centroid of
 * each half-second block (long enough that the noise's own frame-to-frame
 * jitter averages out, short enough to follow a sweep), highest less lowest.
 */
function centroidTravel(data, sr, from, to, block = 0.5) {
  const size = 4096;
  const cents = [];
  for (let b = from; b + block <= to + 1e-9; b += block) {
    const acc = new Float64Array(size / 2);
    for (let s = Math.floor(b * sr); s + size <= Math.floor((b + block) * sr); s += size / 2) {
      const p = spectrum(data, s, size);
      for (let k = 0; k < p.length; k++) acc[k] += p[k];
    }
    let num = 0; let den = 0;
    for (let k = 1; k < acc.length; k++) {
      const hz = k * sr / size;
      if (hz < 100 || hz > 12000) continue;
      num += acc[k] * hz; den += acc[k];
    }
    cents.push(den > 0 ? Math.log2(num / den) : 0);
  }
  return +(Math.max(...cents) - Math.min(...cents)).toFixed(3);
}

/**
 * Measure one note. `body` is the stretch of the note between the end of its
 * swell and the start of its fade — the stretch where nothing in the score
 * moves, so anything that repeats or travels there is the voice's own doing.
 */
export function measureBed(voice, note, { body, seconds, seed, tones = [] }) {
  const { data, sampleRate: sr } = renderNote(voice, note, { seconds, seed });
  let peak = 0;
  for (const v of data) peak = Math.max(peak, Math.abs(v));
  const { loud, frameSec } = tracks(data, sr, body[0], body[1]);
  // One second either side: slower than any stroke, faster than the swell.
  const loudD = detrend(loud, Math.round(1 / frameSec));
  return {
    peak: +peak.toFixed(4),
    waveformRepeat: waveformRepeat(data, sr, body[0], body[1], 0.3, 3, tones),
    loudnessRepeat: strongestRepeat(loudD, frameSec, 0.3, 3),
    centroidTravelOct: centroidTravel(data, sr, body[0], body[1]),
    whistleDb: tones.length ? tonalProminence(data, sr, body[0], body[1], tones[0]) : null,
  };
}

export { renderNote };

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

const MAIN = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (MAIN) {
  const { VOICES } = await import(pathToFileURL(join(HERE, '../src/scripts/engine-voices.js')).href);
  const results = [];
  const check = (name, ok, got) => results.push({ name, ok, got });

  // Ambient plays texture notes at MIDI 79-100 (ambient-engine.js, the texture
  // pass: `while (midi < 79) midi += 12`), velocity 0.3-0.6, 3-6 s long. One
  // note from the middle of that and one from the top, held long enough that
  // the body — from the end of the 2.4 s swell to the start of the fade — is
  // eight seconds of steady sound: a stroke at any rate a saw is worked at
  // comes round several times in it.
  const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const held = (midi, velocity) => ({ time: 0.1, freq: hz(midi), midi, velocity, duration: 11 });
  const cases = [
    { voice: 'wash', name: 'wash, middle of the Ambient register', note: held(88, 0.45), seed: 7 },
    { voice: 'wash', name: 'wash, same note, another draw', note: held(88, 0.45), seed: 1234 },
    { voice: 'wash', name: 'wash, top of the register', note: held(98, 0.6), seed: 99 },
    // Coloured noise is in Ambient's texture bank too (the voice wander,
    // vary.voice 0.15, can land on it) and read the same loop at rate 1 — the
    // purest form of the fault: one two-second figure, over and over.
    { voice: 'colour', name: 'coloured noise, Ambient register', note: held(88, 0.45), seed: 7 },
  ];

  for (const c of cases) {
    const voice = VOICES?.texture?.[c.voice];
    if (!voice || typeof voice.play !== 'function') {
      check(`${c.name}: texture/${c.voice} exists`, false, null);
      continue;
    }
    const tones = c.voice === 'wash' ? [c.note.freq] : [];
    const m = measureBed(voice, c.note, { body: [3, 11], seconds: 15, seed: c.seed, tones });
    if (REPORT) console.log(c.name, JSON.stringify(m));
    check(`${c.name}: still sounds`, m.peak > 0.003, m.peak);
    // THE STROKE. The looped two-second buffer measured ~0.4 here for the
    // wash (its 0.92-rate layer coming round at 2.17 s; the 1.07-rate layer,
    // at 1.87 s, is the other half of the mix) and 0.997 for coloured noise
    // (exactly 2.00 s). Unrepeated noise measures ~0.01.
    check(`${c.name}: no stroke — the noise does not come round again (0.3-3 s)`, m.waveformRepeat.r < 0.1, m.waveformRepeat);
    // The same, as the ear's coarser view of it: 20 ms loudness, detrended
    // against the note's own swell. Coloured noise measured 0.998.
    check(`${c.name}: no stroke — loudness does not repeat (0.3-3 s)`, m.loudnessRepeat.r < 0.3, m.loudnessRepeat);
    if (c.voice === 'wash') {
      // THE SWEEP. v0.0.80's guarantee, re-held in Node: the band centre used
      // to travel 320 Hz -> f x 2.4 and back on every note, which measures
      // 0.92 octaves of block-centroid travel on the pre-v0.0.80 voice. It
      // holds now (~0.09: the slow Q breath and nothing else).
      check(`${c.name}: no sweep — the centroid travels under a third of an octave`, m.centroidTravelOct < 0.33, m.centroidTravelOct);
      // THE WHISTLE: the anchor sine at the note's own pitch, standing clear
      // of the noise band it sits in (~25 dB before and after the fix).
      check(`${c.name}: the whistle survives — a tonal peak at the note`, m.whistleDb !== null && m.whistleDb > 15, m.whistleDb);
    }
  }

  for (const r of results) console.log(`${r.ok ? '  ok' : '  ✗ '} ${r.name}  ${JSON.stringify(r.got)}`);
  const failed = results.filter((r) => !r.ok);
  if (REPORT) process.exit(0);
  if (failed.length) {
    console.error(`wash-saw-render: ${failed.length} of ${results.length} failed`);
    process.exit(1);
  }
  console.log(`wash-saw-render: ${results.length}/${results.length} passed`);
}
