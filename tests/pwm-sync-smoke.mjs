/**
 * The pulse and hard-sync oscillator's kernel — src/scripts/pulse-kernel.js —
 * measured.
 *
 *   node tests/pwm-sync-smoke.mjs        (also discovered by tests/all.mjs)
 *
 * The kernel is pure JS, so every law here runs on the exact sample stream the
 * AudioWorklet produces in a browser, with no audio engine in the loop:
 *
 *   - duty cycle: the fraction of each period a pulse spends high is the
 *     Width dial within ±1 % (absolute), at 5, 10, 25, 50, 75 and 95 %, and at
 *     a low and a middle note;
 *   - DC: the mean over whole periods is zero at every width, and for a
 *     synced slave at a ratio that is NOT whole — where the naive wave's own
 *     mean is far from zero, which the test also shows, so the subtraction is
 *     proven to be doing the work;
 *   - aliasing: at a high note, the PolyBLEP pulse and synced saw put far less
 *     energy into inharmonic bins (and into the top half of the band) than the
 *     naive waves the same kernel makes with `bandLimit: false`;
 *   - sync: every reset lands on the master's period, to a millionth of a
 *     sample, and the slave's phase after it is exactly the time since that
 *     reset times the ratio — reset to zero at the reset, not nearby; the
 *     output repeats at the MASTER's period (and every spectral line sits on a
 *     master harmonic) whatever the ratio; and the spectrum moves with the
 *     ratio — the centroid rises at every step from 1 to 8;
 *   - Width is read every sample: a sweep's duty follows it;
 *   - bounded and finite over a grid of every mode, shape, note, width and
 *     ratio; deterministic, sample for sample;
 *   - the WORKLET: pulseWorkletSource() evaluated in a stand-in worklet scope
 *     registers the processor with its three a-rate params, stays silent
 *     before `start`, plays the kernel's own samples from the exact start
 *     frame (a-rate params per sample included), falls silent at `stop`, and
 *     returns false after it.
 */
import assert from 'node:assert/strict';
import {
  createPulseOscillator, pulseWorkletSource, PULSE_PROCESSOR,
} from '../src/scripts/pulse-kernel.js';

const SR = 48000;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function run(options, seconds, { freq = 220, width = 0.5, ratio = 1 } = {}) {
  const osc = createPulseOscillator({ sampleRate: SR, ...options });
  const out = new Float64Array(Math.round(SR * seconds));
  for (let i = 0; i < out.length; i++) {
    out[i] = osc.next(
      typeof freq === 'function' ? freq(i) : freq,
      typeof width === 'function' ? width(i) : width,
      typeof ratio === 'function' ? ratio(i) : ratio,
    );
  }
  return { osc, out };
}

/** In-place radix-2 FFT; returns the power spectrum of bins 0..N/2. */
function powerSpectrum(x, window = true) {
  const N = x.length;
  assert.equal(N & (N - 1), 0, 'FFT length must be a power of two');
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    // 4-term Blackman–Harris: sidelobes at −92 dB, so a strong harmonic's
    // skirt cannot pass for an alias two bins along.
    const a = (2 * Math.PI * i) / (N - 1);
    const w = window ? 0.35875 - 0.48829 * Math.cos(a) + 0.14128 * Math.cos(2 * a) - 0.01168 * Math.cos(3 * a) : 1;
    re[i] = x[i] * w;
  }
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < N; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const ar = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
        const ai = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
        re[i + k + len / 2] = re[i + k] - ar;
        im[i + k + len / 2] = im[i + k] - ai;
        re[i + k] += ar;
        im[i + k] += ai;
      }
    }
  }
  const p = new Float64Array(N / 2 + 1);
  for (let k = 0; k <= N / 2; k++) p[k] = re[k] * re[k] + im[k] * im[k];
  return p;
}

/**
 * Share of the energy (DC excluded) in bins more than `guard` bins from every
 * harmonic of `freq` — at a non-integer period, every alias lands off the
 * harmonic series, so this is the folded-back energy.
 */
function inharmonicShare(p, freq, N, guard = 6) {
  const binHz = SR / N;
  let total = 0;
  let off = 0;
  for (let k = guard; k < p.length; k++) {
    const hz = k * binHz;
    const h = Math.round(hz / freq);
    const dist = Math.abs(hz - h * freq) / binHz;
    total += p[k];
    if (dist > guard) off += p[k];
  }
  return off / total;
}

const dB = (r) => 10 * Math.log10(r);

const centroid = (p) => {
  let num = 0;
  let den = 0;
  for (let k = 1; k < p.length; k++) { num += k * p[k]; den += p[k]; }
  return (num / den) * (SR / ((p.length - 1) * 2));
};

// --------------------------------------------------------------------------
// The pulse
// --------------------------------------------------------------------------

test('pulse: the duty cycle is the Width dial within ±1 %', () => {
  for (const freq of [110, 523.25]) {
    for (const width of [0.05, 0.1, 0.25, 0.5, 0.75, 0.95]) {
      const { out } = run({ mode: 'pulse' }, 1, { freq, width });
      let hi = -Infinity;
      let lo = Infinity;
      for (let i = 1000; i < out.length; i++) { hi = Math.max(hi, out[i]); lo = Math.min(lo, out[i]); }
      // Over whole periods only, from the threshold half-way between the two
      // levels — the BLEP's transition samples split either side of it.
      const period = SR / freq;
      const periods = Math.floor((out.length - 1000) / period);
      const n = Math.round(periods * period);
      let high = 0;
      for (let i = 1000; i < 1000 + n; i++) if (out[i] > (hi + lo) / 2) high += 1;
      const duty = high / n;
      assert.ok(Math.abs(duty - width) <= 0.01,
        `${freq} Hz at width ${width}: measured duty ${duty.toFixed(4)}`);
      // And the levels are the DC-free pulse's: high 1 − w, low −w (halved).
      assert.ok(Math.abs(hi - 0.5 * (2 - 2 * width)) < 0.02 && Math.abs(lo + width) < 0.02,
        `${freq} Hz at width ${width}: levels ${hi.toFixed(3)} / ${lo.toFixed(3)}`);
    }
  }
});

test('DC: the mean over whole periods is zero at every width, and at a synced slave\'s fractional ratio', () => {
  // 120 Hz is a 400-sample period: whole periods are exact.
  const freq = 120;
  const mean = (x, from, n) => { let s = 0; for (let i = from; i < from + n; i++) s += x[i]; return s / n; };
  for (const width of [0.05, 0.2, 0.5, 0.8, 0.95]) {
    const { out } = run({ mode: 'pulse' }, 0.5, { freq, width });
    const m = mean(out, 400, 400 * 50);
    assert.ok(Math.abs(m) < 1e-4, `pulse width ${width}: mean ${m}`);
  }
  for (const [slave, ratio, width] of [['saw', 1.5, 0.5], ['saw', 2.3, 0.5], ['pulse', 1.5, 0.3], ['pulse', 3.6, 0.7]]) {
    const { out } = run({ mode: 'sync', slave }, 0.5, { freq, width, ratio });
    const m = mean(out, 400, 400 * 50);
    assert.ok(Math.abs(m) < 1e-4, `sync ${slave} ×${ratio}: mean ${m}`);
  }
  // The control: the naive synced saw at ×1.5 averages (0.25 − 0.5)/1.5 —
  // the subtraction is what centres it. Rebuilt here without it.
  const naive = createPulseOscillator({ sampleRate: SR, mode: 'sync', slave: 'saw', trace: true });
  let s = 0;
  for (let i = 0; i < 400 * 50; i++) {
    naive.next(freq, 0.5, 1.5);
    const u = naive.slave();
    s += 0.5 * (2 * u - 1);
  }
  assert.ok(Math.abs(s / (400 * 50) - 0.5 * (-0.25 / 1.5)) < 2e-3, `the naive slave's own DC is ${s / 20000}, not −0.083`);
});

test('aliasing: PolyBLEP puts far less energy off the harmonic series than the naive wave', () => {
  // A high note with a period that is not a whole number of samples, so
  // every alias lands between the harmonics.
  const N = 16384;
  const cases = [
    ['pulse 30 %', { mode: 'pulse' }, { freq: 1863.7, width: 0.3 }],
    ['pulse 50 %', { mode: 'pulse' }, { freq: 2489.0, width: 0.5 }],
    ['sync saw ×2.6', { mode: 'sync', slave: 'saw' }, { freq: 1244.5, ratio: 2.6 }],
  ];
  for (const [name, options, dials] of cases) {
    const blep = run(options, (N + 2000) / SR, dials).out.subarray(2000, 2000 + N);
    const naive = run({ ...options, bandLimit: false }, (N + 2000) / SR, dials).out.subarray(2000, 2000 + N);
    const pb = powerSpectrum(blep);
    const pn = powerSpectrum(naive);
    const offB = inharmonicShare(pb, dials.freq, N);
    const offN = inharmonicShare(pn, dials.freq, N);
    assert.ok(dB(offN / offB) >= 10,
      `${name}: inharmonic share ${dB(offB).toFixed(1)} dB (BLEP) vs ${dB(offN).toFixed(1)} dB (naive) — under 10 dB better`);
    // Energy in the top half of the band — where a naive step's folded
    // harmonics pile up — is lower too.
    const top = (p) => { let t = 0; let a = 0; for (let k = 1; k < p.length; k++) { a += p[k]; if (k >= p.length / 2) t += p[k]; } return t / a; };
    assert.ok(top(pb) < top(pn), `${name}: the top half holds ${top(pb)} (BLEP) vs ${top(pn)} (naive)`);
  }
});

test('Width is read every sample: a sweep\'s duty follows it', () => {
  const freq = 120;
  const n = SR;
  const width = (i) => 0.1 + 0.8 * (i / n);
  const { out } = run({ mode: 'pulse' }, 1, { freq, width });
  for (const at of [0.1, 0.5, 0.9]) {
    const from = Math.round(at * n) - 200;
    let high = 0;
    for (let i = from; i < from + 400; i++) if (out[i] > 0.5 - width(i)) high += 1;
    const want = width(from + 200);
    assert.ok(Math.abs(high / 400 - want) < 0.02, `at ${at * 100}% through the sweep the duty is ${(high / 400).toFixed(3)}, the dial ${want.toFixed(3)}`);
  }
});

// --------------------------------------------------------------------------
// Hard sync
// --------------------------------------------------------------------------

test('sync: every reset lands on the master period, and the slave restarts from zero at it', () => {
  for (const [freq, ratio, slave] of [[200, 2.7, 'saw'], [261.63, 3.3, 'saw'], [98, 5.5, 'pulse'], [440, 1.25, 'pulse']]) {
    const period = SR / freq;
    const osc = createPulseOscillator({ sampleRate: SR, mode: 'sync', slave, trace: true });
    let seen = 0;
    for (let i = 0; i < SR / 2; i++) {
      osc.next(freq, 0.4, ratio);
      if (osc.resets.length > seen) {
        seen = osc.resets.length;
        const at = osc.resets[seen - 1];
        assert.ok(Math.abs(at - seen * period) < 1e-6 * seen,
          `${freq} Hz ×${ratio}: reset ${seen} at ${at}, the master period puts it at ${seen * period}`);
        // The phase at reset: after this sample the slave has run for exactly
        // the time since the reset, at its own rate — it restarted from zero.
        const since = i + 1 - at;
        const want = (since * freq * ratio) / SR;
        assert.ok(Math.abs(osc.slave() - (want - Math.floor(want))) < 1e-9,
          `${freq} Hz ×${ratio}: slave phase ${osc.slave()} after the reset, ${want} expected`);
      }
    }
    // (A reset due on the very last sample may fall either side of it.)
    assert.ok(Math.abs(seen - (SR / 2) / period) <= 1, `${freq} Hz: ${seen} resets in half a second`);
  }
});

test('sync: the output repeats at the master\'s period, and every spectral line is a master harmonic', () => {
  // 200 Hz = 240 samples; 4800 samples = 20 periods = bins exactly 10 Hz apart.
  const freq = 200;
  for (const ratio of [1.5, 2.7, 4.3, 7.1]) {
    const { out } = run({ mode: 'sync', slave: 'saw' }, 1, { freq, ratio });
    let worst = 0;
    for (let i = 2400; i < 2400 + 4800; i++) worst = Math.max(worst, Math.abs(out[i + 240] - out[i]));
    assert.ok(worst < 1e-4, `×${ratio}: the output differs by ${worst} one master period apart`);
    // Not periodic at the slave's own period: the reset is what sets it.
    const slaveLag = Math.round(240 / ratio);
    let diff = 0;
    for (let i = 2400; i < 2400 + 4800; i++) diff = Math.max(diff, Math.abs(out[i + slaveLag] - out[i]));
    assert.ok(diff > 0.1, `×${ratio}: the output also repeats at the slave's period (${diff})`);
    // Rectangular DFT over the 20 periods: all energy on bins 20k.
    const x = out.subarray(2400, 2400 + 4800);
    let on = 0;
    let all = 0;
    for (let k = 1; k <= 2400; k++) {
      let re = 0;
      let im = 0;
      if (k % 20 !== 0 && k % 7 !== 0) continue; // the harmonic bins, and a sample of the rest
      for (let i = 0; i < 4800; i++) { re += x[i] * Math.cos((2 * Math.PI * k * i) / 4800); im -= x[i] * Math.sin((2 * Math.PI * k * i) / 4800); }
      const pw = re * re + im * im;
      all += pw;
      if (k % 20 === 0) on += pw;
    }
    assert.ok(on / all > 0.9999, `×${ratio}: ${(1 - on / all) * 100}% of the energy is off the master's harmonics`);
  }
});

test('sync: the spectrum moves with the ratio — the centroid rises at every step', () => {
  const N = 16384;
  let last = 0;
  const seen = [];
  for (const ratio of [1, 1.5, 2, 3, 5, 8]) {
    const { out } = run({ mode: 'sync', slave: 'saw' }, (N + 2000) / SR, { freq: 110, ratio });
    const c = centroid(powerSpectrum(out.subarray(2000, 2000 + N)));
    seen.push(`×${ratio}: ${Math.round(c)} Hz`);
    assert.ok(c > last * 1.05, `the centroid does not rise with the ratio: ${seen.join(', ')}`);
    last = c;
  }
  // And ratio 1 IS the plain saw: the sync costs nothing when it does nothing.
  const one = run({ mode: 'sync', slave: 'saw' }, 0.2, { freq: 110, ratio: 1 }).out;
  for (let i = 1000; i < one.length; i++) {
    const phase = (i * 110) / SR; // output sample i is the phase at i (see the kernel header)
    const naive = 0.5 * (2 * (phase - Math.floor(phase)) - 1);
    const nearEdge = Math.abs(phase - Math.round(phase)) * (SR / 110) < 2.5;
    if (!nearEdge) assert.ok(Math.abs(one[i] - naive) < 1e-6, `sample ${i}: ratio 1 is not a saw (${one[i]} vs ${naive})`);
  }
});

// --------------------------------------------------------------------------
// Bounds, determinism, the worklet
// --------------------------------------------------------------------------

test('bounded and finite over every mode, shape, note, width and ratio', () => {
  let worst = 0;
  for (const mode of ['pulse', 'sync']) {
    for (const slave of ['saw', 'pulse']) {
      for (const freq of [20, 55, 220, 880, 3520, 9000, 30000]) {
        for (const width of [0.05, 0.3, 0.5, 0.95, -1, 2, NaN]) {
          for (const ratio of [1, 1.01, 2.5, 7.99, 8, 50, NaN]) {
            const { out } = run({ mode, slave }, 0.05, { freq, width, ratio });
            for (const v of out) {
              assert.ok(Number.isFinite(v), `${mode}/${slave} ${freq} Hz w${width} ×${ratio}: non-finite`);
              if (Math.abs(v) > worst) worst = Math.abs(v);
            }
          }
        }
      }
    }
  }
  assert.ok(worst <= 1, `peak ${worst}`);
});

test('deterministic: the same dials are the same samples', () => {
  const dials = { freq: (i) => 300 + i / 100, width: (i) => 0.5 + 0.4 * Math.sin(i / 900), ratio: (i) => 2 + Math.sin(i / 3000) };
  for (const options of [{ mode: 'pulse' }, { mode: 'sync', slave: 'saw' }, { mode: 'sync', slave: 'pulse' }]) {
    const a = run(options, 0.3, dials).out;
    const b = run(options, 0.3, dials).out;
    assert.deepEqual(a, b, `${JSON.stringify(options)}: two runs differ`);
  }
});

test('the worklet source registers a processor that plays the kernel from the exact start frame', () => {
  const registered = {};
  class AudioWorkletProcessor {}
  const scope = { currentTime: 0, sampleRate: SR };
  // eslint-disable-next-line no-new-func
  const load = new Function('AudioWorkletProcessor', 'registerProcessor', 'scope', `
    with (scope) { ${pulseWorkletSource()} }
  `);
  load(AudioWorkletProcessor, (name, cls) => { registered[name] = cls; }, scope);
  const Processor = registered[PULSE_PROCESSOR];
  assert.equal(typeof Processor, 'function', `no processor registered as ${PULSE_PROCESSOR}`);
  const params = Processor.parameterDescriptors;
  assert.deepEqual(params.map((p) => p.name), ['frequency', 'width', 'ratio']);
  for (const p of params) assert.equal(p.automationRate, 'a-rate', `${p.name} is not a-rate`);

  for (const [mode, slave] of [['pulse', null], ['sync', 'saw'], ['sync', 'pulse']]) {
    const startFrame = 300;
    const stopFrame = 128 * 30 + 17;
    const node = new Processor({ processorOptions: { mode, slave, start: startFrame / SR, stop: stopFrame / SR } });
    const got = [];
    let alive = true;
    // A-rate width on even blocks, a single value on odd ones.
    const widthAt = (frame) => 0.3 + 0.4 * (frame / (128 * 40));
    for (let block = 0; block < 40; block++) {
      scope.currentTime = (block * 128) / SR;
      const outputs = [[new Float32Array(128), new Float32Array(128)]];
      const width = block % 2 === 0
        ? Float32Array.from({ length: 128 }, (_, i) => widthAt(block * 128 + i))
        : new Float32Array([widthAt(block * 128)]);
      const ret = node.process([[]], outputs, { frequency: new Float32Array([330]), width, ratio: new Float32Array([2.4]) });
      if (block * 128 < stopFrame) assert.equal(ret, true, `block ${block}: returned false before stop`);
      got.push(...outputs[0][0]);
      assert.deepEqual(outputs[0][1], outputs[0][0], 'the second channel is not the first');
      alive = ret;
    }
    assert.equal(alive, false, 'process() never returned false after stop');
    const kernel = createPulseOscillator({ sampleRate: SR, mode, slave });
    for (let i = 0; i < startFrame; i++) assert.equal(got[i], 0, `${mode}: frame ${i}: sound before start`);
    for (let i = startFrame; i < stopFrame; i++) {
      const block = Math.floor(i / 128);
      const w = block % 2 === 0 ? widthAt(i) : widthAt(block * 128);
      const want = Math.fround(kernel.next(330, Math.fround(w), Math.fround(2.4)));
      assert.ok(Math.abs(got[i] - want) < 1e-6, `${mode}: frame ${i}: ${got[i]} is not the kernel's ${want}`);
    }
    for (let i = stopFrame; i < got.length; i++) assert.equal(got[i], 0, `${mode}: frame ${i}: sound after stop`);
  }
});

let failures = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}\n     ${error.message}`);
  }
}
console.log(`\n${tests.length - failures}/${tests.length} passed`);
process.exit(failures ? 1 : 0);
