/**
 * The plucked string's kernel — src/scripts/pluck-kernel.js — measured.
 *
 *   node tests/pluck-smoke.mjs        (also discovered by tests/all.mjs)
 *
 * The kernel is pure JS, so every law here runs on the exact sample stream the
 * AudioWorklet produces in a browser, with no audio engine in the loop:
 *
 *   - pitch: the period, by autocorrelation with a parabolic refinement, is
 *     within ±5 cents of the note at 110, 440 and 880 Hz — at every brightness
 *     and damping corner, because the loop filter's phase delay is what a
 *     naive Karplus–Strong gets wrong and it moves with both;
 *   - damping: more damping is less ring — the RMS around 1 s falls, step by
 *     step, and the fundamental's measured T60 is within 25 % of the one the
 *     kernel solved for;
 *   - brightness: more brightness is a higher spectral centroid;
 *   - position: a pluck at the middle of the string cancels the even
 *     harmonics (the second harmonic far below the near-bridge pluck's);
 *   - bounded: every pluck peaks between 0.62 (its pre-roll normalised
 *     level) and 0.95 over a grid of every dial and pitch, and is finite;
 *   - deterministic: the same seed is the same pluck, sample for sample, and
 *     a different seed is a different one;
 *   - the WORKLET: pluckWorkletSource() is evaluated in a stand-in worklet
 *     scope and must register the processor, stay silent before `start`,
 *     play the kernel's own samples from the exact start frame, fall silent
 *     at `stop` and return false after it — so the source-text build that
 *     the browser loads is proven, not just the module Node imports.
 */
import assert from 'node:assert/strict';
import {
  createPluckString, pluckWorkletSource, PLUCK_PROCESSOR, pluckT60,
} from '../src/scripts/pluck-kernel.js';

const SR = 48000;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function render(options, seconds) {
  const s = createPluckString({ sampleRate: SR, seed: 11, ...options });
  const out = new Float32Array(Math.round(SR * seconds));
  s.render(out, 0, out.length);
  return { s, out };
}

/** Period in samples near the expected lag: autocorrelation, parabolic refine. */
function periodOf(x, freq, from = 0.1) {
  const expect = SR / freq;
  const lo = Math.floor(expect * 0.85);
  const hi = Math.ceil(expect * 1.15);
  const start = Math.round(from * SR);
  // Two one-pole lowpasses at twice the note first. A bright string's
  // autocorrelation peak is a few samples wide, so a parabola through the
  // three integer lags around it misses by a tenth of a sample — 5 cents at
  // 880 Hz — and the upper partials' own slight stretch (a real string's, and
  // this one's, inharmonicity) would pull the reading off the note. Filtered,
  // the period measured is the fundamental's, which is what the note IS.
  const k = Math.exp((-2 * Math.PI * 2 * freq) / SR);
  const a = new Float64Array(16384);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < a.length + 2048; i++) {
    const v = x[start - 2048 + i] || 0;
    s1 = (1 - k) * v + k * s1;
    s2 = (1 - k) * s1 + k * s2;
    if (i >= 2048) a[i - 2048] = s2;
  }
  // NORMALISED: a decaying string makes a raw autocorrelation favour the
  // shorter lag (the later copy is quieter), which reads as sharp. Dividing by
  // both windows' energy takes the decay out of the comparison.
  const ac = (lag) => {
    let sum = 0;
    let e1 = 0;
    let e2 = 0;
    for (let i = 0; i + lag < a.length; i++) {
      sum += a[i] * a[i + lag];
      e1 += a[i] * a[i];
      e2 += a[i + lag] * a[i + lag];
    }
    return sum / Math.sqrt(e1 * e2 || 1);
  };
  let best = lo;
  let top = -Infinity;
  for (let lag = lo; lag <= hi; lag++) {
    const v = ac(lag);
    if (v > top) { top = v; best = lag; }
  }
  const y0 = ac(best - 1);
  const y2 = ac(best + 1);
  return best + (0.5 * (y0 - y2)) / (y0 - 2 * top + y2);
}

const cents = (measured, wanted) => 1200 * Math.log2(measured / wanted);

function rms(x, from, to) {
  const a = Math.round(from * SR);
  const b = Math.round(to * SR);
  let sum = 0;
  for (let i = a; i < b; i++) sum += x[i] * x[i];
  return Math.sqrt(sum / (b - a));
}

/** Magnitude spectrum of a Hann-windowed slice, radix-2. */
function spectrum(x, from, size = 8192) {
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const start = Math.round(from * SR);
  for (let i = 0; i < size; i++) {
    re[i] = (x[start + i] || 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1)));
  }
  for (let i = 1, j = 0; i < size; i++) {
    let bit = size >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= size; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < size; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
        const vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
      }
    }
  }
  const mag = new Float64Array(size / 2);
  for (let i = 0; i < size / 2; i++) mag[i] = Math.hypot(re[i], im[i]);
  return mag;
}

function centroid(x, from) {
  const mag = spectrum(x, from);
  let num = 0;
  let den = 0;
  for (let i = 1; i < mag.length; i++) {
    const hz = (i * SR) / (2 * mag.length);
    num += hz * mag[i];
    den += mag[i];
  }
  return num / den;
}

/** Peak magnitude within ±3 % of a frequency. */
function bandPeak(mag, hz) {
  const bin = (f) => Math.round((f * 2 * mag.length) / SR);
  let top = 0;
  for (let i = bin(hz * 0.97); i <= bin(hz * 1.03); i++) top = Math.max(top, mag[i]);
  return top;
}

test('pitch: within ±5 cents at 110, 440 and 880 Hz, at every brightness and damping corner', () => {
  const worst = [];
  for (const freq of [110, 440, 880]) {
    for (const brightness of [0, 0.5, 1]) {
      for (const damping of [0, 0.4, 0.8]) {
        for (const position of [0.05, 0.18, 0.5]) {
          const { out } = render({ freq, brightness, damping, position }, 0.6);
          const off = cents(SR / periodOf(out, freq, 0.05), freq);
          worst.push(Math.abs(off));
          assert.ok(Math.abs(off) <= 5,
            `${freq} Hz, brightness ${brightness}, damping ${damping}, position ${position}: ${off.toFixed(2)} cents`);
        }
      }
    }
  }
  console.log(`    worst tuning error ${Math.max(...worst).toFixed(2)} cents over ${worst.length} plucks`);
});

test('pitch: a string above F4 — the DelayNode floor — tunes too (1318.5 Hz, E6)', () => {
  const { out } = render({ freq: 1318.51, brightness: 0.7, damping: 0.3 }, 0.5);
  const off = cents(SR / periodOf(out, 1318.51, 0.05), 1318.51);
  assert.ok(Math.abs(off) <= 5, `E6: ${off.toFixed(2)} cents`);
});

test('damping: more damping decays faster — RMS at 1 s falls step by step', () => {
  for (const freq of [110, 440]) {
    const levels = [0, 0.25, 0.5, 0.75, 1].map((damping) => rms(render({ freq, damping, brightness: 0.6 }, 1.2).out, 0.95, 1.05));
    for (let i = 1; i < levels.length; i++) {
      assert.ok(levels[i] < levels[i - 1] * 0.8,
        `${freq} Hz: damping step ${i} did not shorten the ring (${levels.map((l) => l.toExponential(2)).join(' > ')})`);
    }
    console.log(`    ${freq} Hz RMS at 1 s, damping 0→1: ${levels.map((l) => l.toExponential(1)).join(', ')}`);
  }
});

test('damping: the fundamental rings for the T60 the kernel solved for (±25 %)', () => {
  for (const damping of [0.3, 0.6]) {
    const freq = 220;
    const { s, out } = render({ freq, damping, brightness: 0.8, position: 0.5 }, 3);
    // The fundamental's level at two times, from its own spectral peak.
    const t1 = 0.2;
    const t2 = Math.min(t1 + s.t60 / 3, 2.6);
    const a1 = bandPeak(spectrum(out, t1), freq);
    const a2 = bandPeak(spectrum(out, t2), freq);
    const dbPerSecond = (20 * Math.log10(a1 / a2)) / (t2 - t1);
    const measured = 60 / dbPerSecond;
    assert.ok(Math.abs(measured / s.t60 - 1) <= 0.25,
      `damping ${damping}: T60 ${measured.toFixed(2)} s measured, ${s.t60.toFixed(2)} s solved`);
  }
});

test('damping: the voice\'s pluckT60 is the law the kernel solves with', () => {
  for (const damping of [0, 0.25, 0.4, 0.6, 1]) {
    const { s } = render({ freq: 330, damping }, 0.01);
    assert.ok(Math.abs(s.t60 - pluckT60(damping)) < 1e-12, `damping ${damping}: ${s.t60} vs ${pluckT60(damping)}`);
  }
  assert.ok(Math.abs(pluckT60(0) - 8) < 1e-12 && Math.abs(pluckT60(1) - 0.2) < 1e-12, 'the dial no longer spans 8 s to 0.2 s');
});

test('brightness: more brightness raises the spectral centroid', () => {
  for (const freq of [110, 440]) {
    const c = [0, 0.33, 0.66, 1].map((brightness) => centroid(render({ freq, brightness, damping: 0.3 }, 0.6).out, 0.05));
    for (let i = 1; i < c.length; i++) {
      assert.ok(c[i] > c[i - 1] * 1.05, `${freq} Hz: centroid did not rise (${c.map((v) => v.toFixed(0)).join(' < ')} Hz)`);
    }
    console.log(`    ${freq} Hz centroid, brightness 0→1: ${c.map((v) => `${v.toFixed(0)} Hz`).join(', ')}`);
  }
});

test('position: a pluck at the middle cancels the even harmonics', () => {
  const freq = 220;
  const near = spectrum(render({ freq, position: 0.08, brightness: 0.9, damping: 0.3 }, 0.6).out, 0.05);
  const mid = spectrum(render({ freq, position: 0.5, brightness: 0.9, damping: 0.3 }, 0.6).out, 0.05);
  const ratio = (mag) => bandPeak(mag, 2 * freq) / bandPeak(mag, freq);
  assert.ok(ratio(mid) < ratio(near) * 0.25,
    `2nd/1st harmonic: middle ${ratio(mid).toFixed(3)}, near the bridge ${ratio(near).toFixed(3)}`);
});

test('bounded: every pluck leaves at 0.62, and |y| <= 0.95 and finite over every dial and pitch', () => {
  let top = 0;
  for (const freq of [55, 110, 440, 880, 1760, 3000]) {
    for (const brightness of [0, 0.5, 1]) {
      for (const damping of [0, 1]) {
        for (const position of [0.05, 0.25, 0.5]) {
          for (const velocity of [0, 1]) {
            for (const seed of [1, 2, 3]) {
              const { out } = render({ freq, brightness, damping, position, velocity, seed }, 0.4);
              let own = 0;
              for (const v of out) {
                assert.ok(Number.isFinite(v), `${freq} Hz: non-finite sample`);
                if (Math.abs(v) > own) own = Math.abs(v);
              }
              // Normalised by pre-roll: every pluck leaves at 0.62, so swapping
              // a dial never jumps the level — and nothing climbs past ±0.95,
              // the bound the voice's makeup is sized against.
              assert.ok(own >= 0.619 && own <= 0.95,
                `${freq} Hz b${brightness} d${damping} p${position} v${velocity}: peak ${own.toFixed(3)}`);
              if (own > top) top = own;
            }
          }
        }
      }
    }
  }
  assert.ok(top <= 0.95, `peak ${top}`);
  console.log(`    peak over the grid ${top.toFixed(3)}`);
});

test('bounded: rubbish options give a sane string, never NaN', () => {
  for (const options of [{}, { freq: NaN }, { freq: -5, damping: 9, brightness: -3, position: 7 }, { sampleRate: 0 }, null]) {
    const s = createPluckString(options);
    const out = new Float32Array(2000);
    s.render(out, 0, out.length);
    assert.ok(out.every(Number.isFinite), `${JSON.stringify(options)}: non-finite output`);
  }
});

test('deterministic: the same seed is the same pluck; another seed is another', () => {
  const a = render({ freq: 330, seed: 42 }, 0.3).out;
  const b = render({ freq: 330, seed: 42 }, 0.3).out;
  const c = render({ freq: 330, seed: 43 }, 0.3).out;
  assert.deepEqual(a, b, 'the same seed rendered differently');
  assert.ok(a.some((v, i) => v !== c[i]), 'a different seed rendered the same pluck');
});

test('the worklet source registers a processor that plays the kernel from the exact start frame', () => {
  const registered = {};
  class AudioWorkletProcessor {}
  const scope = { currentTime: 0, sampleRate: SR };
  // The source text is evaluated as the worklet scope would: its free names
  // are the scope's globals. `currentTime` is read live through a getter.
  // eslint-disable-next-line no-new-func
  const run = new Function('AudioWorkletProcessor', 'registerProcessor', 'scope', `
    with (scope) { ${pluckWorkletSource()} }
  `);
  run(AudioWorkletProcessor, (name, cls) => { registered[name] = cls; }, scope);
  const Processor = registered[PLUCK_PROCESSOR];
  assert.equal(typeof Processor, 'function', `no processor registered as ${PLUCK_PROCESSOR}`);

  const options = { freq: 440, damping: 0.4, brightness: 0.5, position: 0.18, velocity: 0.8, seed: 5 };
  const startFrame = 200;
  const stopFrame = 128 * 30 + 17;
  const node = new Processor({ processorOptions: { ...options, start: startFrame / SR, stop: stopFrame / SR } });
  const got = [];
  let alive = true;
  let lastReturn = true;
  for (let block = 0; block < 40; block++) {
    scope.currentTime = (block * 128) / SR;
    const outputs = [[new Float32Array(128), new Float32Array(128)]];
    lastReturn = node.process([[]], outputs);
    if (block * 128 < stopFrame) assert.equal(lastReturn, true, `block ${block}: returned false before stop`);
    got.push(...outputs[0][0]);
    assert.deepEqual(outputs[0][1], outputs[0][0], 'the second channel is not the first');
    alive = lastReturn;
  }
  assert.equal(alive, false, 'process() never returned false after stop');
  const want = new Float32Array(stopFrame - startFrame);
  createPluckString({ sampleRate: SR, ...options }).render(want, 0, want.length);
  for (let i = 0; i < startFrame; i++) assert.equal(got[i], 0, `frame ${i}: sound before start`);
  for (let i = startFrame; i < stopFrame; i++) {
    assert.ok(Math.abs(got[i] - want[i - startFrame]) < 1e-6, `frame ${i}: ${got[i]} is not the kernel's ${want[i - startFrame]}`);
  }
  for (let i = stopFrame; i < got.length; i++) assert.equal(got[i], 0, `frame ${i}: sound after stop`);
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
