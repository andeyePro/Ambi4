/**
 * Smoke test for src/scripts/sample-match.js — run with:
 *   node tests/sample-match-smoke.mjs
 *
 * "Match a sample" analyses one recorded note and searches this track's
 * voices for the closest synth: every candidate is rendered at the sample's
 * pitch and measured with the same ruler. Rendering is injected, so here a
 * small JS synth stands in for the Web Audio voices — which lets Node prove
 * the parts that are maths: the FFT, the pitch tracker, the ruler's laws, and
 * that the search really does pick the right voice and walk its dials towards
 * the sample rather than away. That the SHIPPED voices match their own renders
 * is a browser proof, tests/pending/sample-match-drive.mjs.
 */

import assert from 'node:assert/strict';
import { VOICES } from '../src/scripts/engine-voices.js';
import { PARAM_REGISTRY } from '../src/scripts/param-registry.js';
import {
  fft, yin, noteOf, mixDown, analyseSample, featureDistance, similarity,
  toPosition, fromPosition, searchFieldsFor, matchSample, describeMatch, NEVER_SEARCHED,
} from '../src/scripts/sample-match.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const SR = 24000;

// A seeded PRNG, so the noise voice is the same noise every run.
function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The stand-in voice library: harmonics through a one-pole-ish lowpass law,
 * under a linear attack and exponential decay to a sustain, released after the
 * note. `noise` swaps the harmonics for seeded white noise.
 */
function toySynth(kind, patch, note, seconds = 3.2) {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  const { attack, decay, sustain, release } = patch.adsr;
  const cutoff = patch.filter.cutoff;
  const f = note.freq;
  const rand = prng(7);
  const partials = [];
  for (let k = 1; f * k < SR / 2 && k <= 40; k++) {
    const roll = 1 / (1 + (f * k / cutoff) ** 4);
    partials.push({ w: 2 * Math.PI * f * k, a: (kind === 'pad' ? 1 / (k * k) : 1 / k) * roll });
  }
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let e;
    if (t < attack) e = t / attack;
    else e = sustain + (1 - sustain) * Math.exp(-(t - attack) / decay);
    if (t > note.duration) e *= Math.exp(-(t - note.duration) / release);
    let s = 0;
    if (kind === 'noise') s = rand() * 2 - 1;
    else for (const p of partials) s += p.a * Math.sin(p.w * t);
    out[i] = 0.2 * e * s;
  }
  return out;
}

const ROWS = {
  'adsr.attack': PARAM_REGISTRY['patch.adsr.attack'],
  'adsr.decay': PARAM_REGISTRY['patch.adsr.decay'],
  'adsr.sustain': PARAM_REGISTRY['patch.adsr.sustain'],
  'adsr.release': PARAM_REGISTRY['patch.adsr.release'],
  'filter.cutoff': PARAM_REGISTRY['patch.filter.cutoff'],
};
const toyFields = Object.entries(ROWS).map(([field, row]) => ({ field, kind: 'number', domain: row.domain, curve: row.curve || 'linear', integer: !!row.integer }));
const TOY = {
  pluck: { adsr: { attack: 0.01, decay: 0.6, sustain: 0, release: 0.3 }, filter: { cutoff: 1500 } },
  pad: { adsr: { attack: 1.2, decay: 1, sustain: 0.8, release: 2 }, filter: { cutoff: 900 } },
  noise: { adsr: { attack: 0.3, decay: 1, sustain: 0.6, release: 1 }, filter: { cutoff: 4000 } },
};
const candidates = Object.entries(TOY).map(([id, defaults]) => ({ id, label: id, defaults, fields: toyFields }));
const render = async (id, patch, note) => ({ samples: toySynth(id, patch, note), sampleRate: SR });

test('fft: a sine lands in its own bin', () => {
  const n = 1024;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * 37 * i) / n);
  fft(re, im);
  let best = 0;
  for (let k = 1; k < n / 2; k++) if (re[k] ** 2 + im[k] ** 2 > re[best] ** 2 + im[best] ** 2) best = k;
  assert.equal(best, 37);
});

test('yin: sines and saws from 55 Hz to 880 Hz, within 1%', () => {
  for (const freq of [55, 110, 220, 440, 880]) {
    for (const kind of ['sine', 'saw']) {
      const x = new Float32Array(4096);
      for (let i = 0; i < x.length; i++) {
        const ph = (freq * i) / SR;
        x[i] = kind === 'sine' ? Math.sin(2 * Math.PI * ph) : 2 * (ph - Math.floor(ph + 0.5));
      }
      const r = yin(x, SR, 0, 2048);
      assert.ok(Math.abs(r.freq / freq - 1) < 0.01, `${kind} ${freq} Hz read as ${r.freq}`);
      assert.ok(r.aperiodicity < 0.1, `${kind} ${freq} Hz aperiodicity ${r.aperiodicity}`);
    }
  }
});

test('noteOf names A4 and middle C', () => {
  assert.equal(noteOf(440).name, 'A4');
  assert.equal(noteOf(261.63).name, 'C4');
  assert.equal(noteOf(0), null);
});

test('mixDown averages channels', () => {
  const m = mixDown([Float32Array.from([1, 0]), Float32Array.from([0, 1])]);
  assert.deepEqual([...m], [0.5, 0.5]);
});

test('analyseSample: pitch, onset and envelope of a plucked note after silence', () => {
  const x = toySynth('pluck', TOY.pluck, { freq: 196, duration: 0.5 });
  const padded = new Float32Array(x.length + SR / 4);
  padded.set(x, SR / 4);
  const a = analyseSample(padded, SR);
  assert.ok(a.pitched, 'a plucked saw is pitched');
  assert.equal(a.note.name, 'G3');
  assert.ok(Math.abs(a.onset - 0.25) < 0.02, `onset ${a.onset}`);
  assert.ok(a.attack < 0.05, `a pluck peaks at once (${a.attack})`);
  assert.ok(a.env[0] > -30 && a.env[a.env.length - 1] < -30, `falls away: ${a.env}`);
  assert.equal(a.spec.length, 3);
});

test('analyseSample: a swell has a long attack, noise is unpitched and flat', () => {
  const pad = analyseSample(toySynth('pad', TOY.pad, { freq: 220, duration: 2.5 }), SR);
  assert.ok(pad.attack > 0.8, `pad attack ${pad.attack}`);
  assert.ok(pad.sustain > 0.6, `pad holds (${pad.sustain})`);
  const noise = analyseSample(toySynth('noise', TOY.noise, { freq: 220, duration: 2.5 }), SR);
  assert.equal(noise.pitched, false);
  assert.ok(noise.flatness > pad.flatness * 5, `noise flatness ${noise.flatness} vs pad ${pad.flatness}`);
});

test('analyseSample: silence is null, not a crash', () => {
  assert.equal(analyseSample(new Float32Array(SR), SR), null);
  assert.equal(analyseSample(new Float32Array(0), SR), null);
});

test('the ruler: zero on itself, symmetric, level-blind, and orders near before far', () => {
  const note = { freq: 220, duration: 0.6 };
  const a = analyseSample(toySynth('pluck', TOY.pluck, note), SR);
  const quiet = analyseSample(toySynth('pluck', TOY.pluck, note).map((s) => s * 0.1), SR);
  const near = analyseSample(toySynth('pluck', { ...TOY.pluck, adsr: { ...TOY.pluck.adsr, decay: 0.5 } }, note), SR);
  const far = analyseSample(toySynth('pad', TOY.pad, note), SR);
  assert.equal(featureDistance(a, a), 0);
  assert.ok(featureDistance(a, quiet) < 0.5, 'a quieter copy is the same sound');
  assert.equal(featureDistance(a, far), featureDistance(far, a));
  assert.ok(featureDistance(a, near) < featureDistance(a, far));
  assert.equal(similarity(0), 100);
  assert.ok(similarity(30) < similarity(5));
});

test('dial positions honour the log curve and round-trip', () => {
  const row = PARAM_REGISTRY['patch.filter.cutoff'];
  assert.ok(Math.abs(toPosition(Math.sqrt(40 * 12000), row) - 0.5) < 1e-9, 'geometric middle is half way on a log dial');
  for (const v of [40, 300, 2500, 12000]) assert.ok(Math.abs(fromPosition(toPosition(v, row), row) / v - 1) < 1e-3);
  const oct = PARAM_REGISTRY['patch.source.octave'];
  assert.equal(fromPosition(0.6, oct), 0, 'an integer row rounds');
});

test('searchFieldsFor: real voices — the dials they show, never the room or the octave', () => {
  const bell = VOICES.melody.bell;
  const fields = searchFieldsFor(bell.defaults, PARAM_REGISTRY).map((f) => f.field);
  assert.ok(fields.includes('fm.depth') && fields.includes('adsr.decay'), fields.join(','));
  for (const never of NEVER_SEARCHED) assert.ok(!fields.includes(never), `${never} is not searched`);
  const marimba = searchFieldsFor(VOICES.arp.marimba.defaults, PARAM_REGISTRY);
  const material = marimba.find((f) => f.field === 'modal.material');
  assert.ok(material && material.kind === 'enum', 'a modal material is tried as a choice');
  const none = searchFieldsFor(bell.defaults, PARAM_REGISTRY, (f) => f.startsWith('adsr.'));
  assert.ok(none.every((f) => f.field.startsWith('adsr.')), 'exposes() narrows the search');
});

test('matchSample: picks the voice that made the sample, and walks its dials towards it', async () => {
  const truth = { adsr: { attack: 0.003, decay: 0.22, sustain: 0, release: 0.3 }, filter: { cutoff: 3200 } };
  const target = analyseSample(toySynth('pluck', truth, { freq: 330, duration: 0.4 }), SR);
  let calls = 0;
  const result = await matchSample(target, { candidates, render, budget: 120, onProgress: () => { calls += 1; } });
  assert.equal(result.best.id, 'pluck');
  assert.ok(result.renders <= 120 && calls === result.renders, `renders ${result.renders}`);
  assert.ok(result.best.distance < result.best.start * 0.6, `searched ${result.best.start} -> ${result.best.distance}`);
  // The tail is shorter than the default's: the search may shorten Decay or
  // the held note length (a one-shot does not say how long it was held, so
  // both are honest ways to the same fade) — but it must go that way.
  const decay = result.best.patch.adsr.decay;
  assert.ok(decay < 0.6 || result.best.held < target.held, `tail not shortened: decay ${decay}, held ${result.best.held}`);
  assert.ok(!('_note' in result.best.patch), 'the note-length pseudo-dial never reaches the patch');
  assert.equal(result.note.freq, target.freq, 'rendered at the sample\'s own pitch');
});

test('matchSample: a noise sample finds the noise voice; a swell finds the pad', async () => {
  const noise = analyseSample(toySynth('noise', { ...TOY.noise, adsr: { ...TOY.noise.adsr, attack: 0.1 } }, { freq: 220, duration: 1 }), SR);
  assert.equal((await matchSample(noise, { candidates, render, budget: 30 })).best.id, 'noise');
  const swell = analyseSample(toySynth('pad', { ...TOY.pad, adsr: { ...TOY.pad.adsr, attack: 0.8 } }, { freq: 150, duration: 2 }), SR);
  assert.equal((await matchSample(swell, { candidates, render, budget: 30 })).best.id, 'pad');
});

test('matchSample: deterministic, and cancellable', async () => {
  const target = analyseSample(toySynth('pluck', TOY.pluck, { freq: 260, duration: 0.5 }), SR);
  const a = await matchSample(target, { candidates, render, budget: 40 });
  const b = await matchSample(target, { candidates, render, budget: 40 });
  assert.deepEqual(a.best.patch, b.best.patch);
  let n = 0;
  const stopped = await matchSample(target, { candidates, render, budget: 200, onProgress: () => { n += 1; }, cancelled: () => n >= 5 });
  assert.ok(stopped.renders <= 6, `stopped after ${stopped.renders}`);
});

test('describeMatch says what was heard, what it became, and the runner-up', async () => {
  const target = analyseSample(toySynth('pluck', { ...TOY.pluck, adsr: { ...TOY.pluck.adsr, decay: 0.3 } }, { freq: 440, duration: 0.4 }), SR);
  const result = await matchSample(target, { candidates, render, budget: 60 });
  const line = describeMatch(target, result, (f) => f.split('.')[1]);
  assert.match(line, /^Heard A4\. Closest: pluck, \d+% alike/);
  assert.match(line, /next: /);
  assert.equal(describeMatch(target, { best: null }), 'Nothing on this track measured close to that sample.');
});

let failures = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}\n     ${error.message}`);
  }
}
console.log(`\n${tests.length - failures}/${tests.length} passed`);
process.exit(failures ? 1 : 0);
