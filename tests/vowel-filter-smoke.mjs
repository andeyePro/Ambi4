/**
 * The Vowel filter (v0.0.257) — run with:
 *   node tests/vowel-filter-smoke.mjs
 *
 * The design the 2026-09-25 deferral asked for (TODO "Unit 7"): a vowel is
 * three formants whose upper ones are not a function of the first, so the
 * filter is a bank of parallel band-passes at a u–o–a–e–i table, chosen by
 * its own row (patch.filter.vowel), never a reading of Cutoff in Hz. The laws:
 *
 *   - the registry says so honestly: 'vowel' in the type's domain, a row of
 *     its own sized to the table, and FILTER_TYPE_DIALS naming which dials
 *     each type listens to;
 *   - selecting Vowel builds the bank (an instrumented mock, voices-smoke
 *     style) at the table's formants with Q from Resonance, and the voice's
 *     own cutoff sweep lands on a biquad that reaches nothing;
 *   - the position moves F1/F2 along the table, geometrically between rows;
 *   - the level law: the formant gains sum to 1, so the bank never exceeds
 *     unity at any frequency, position or Q (computed on the exact Web Audio
 *     band-pass response), and is not needlessly quiet either;
 *   - every param's events stay in time order under the bank;
 *   - no stock voice ships a vowel filter (audio-reference stays frozen);
 *   - the words name the vowel in letters and print no Hz.
 */

import assert from 'node:assert/strict';
import { PARAM_REGISTRY, FILTER_TYPE_DIALS } from '../src/scripts/param-registry.js';
import {
  VOWELS, VOWEL_TABLE, VOWEL_HOME, FORMANT_LEVELS, formantsAt, formantQ, vowelBank,
  bankMagnitude, bandpassResponse, lawGrid, vowelName,
} from '../src/scripts/vowel-formants.js';
import { VOICES } from '../src/scripts/engine-voices.js';
import { describePatch } from '../src/scripts/patch-words.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}\n     ${error.message}`);
  }
}

// --------------------------------------------------------------------------
// A small instrumented AudioContext: the graph and every param's timeline.
// --------------------------------------------------------------------------

let created = [];
function makeParam(owner, name, value) {
  const line = { owner, name, events: [], end: -Infinity, bad: 0 };
  const push = (kind, start, end, v) => {
    if (start < line.end - 1e-9) line.bad += 1;
    line.events.push({ kind, start, end, v });
    line.end = Math.max(line.end, end);
  };
  return {
    isParam: true,
    value,
    line,
    setValueAtTime(v, t) { push('set', t, t, v); this.value = v; return this; },
    linearRampToValueAtTime(v, t) { push('linear', line.end === -Infinity ? 0 : line.end, t, v); return this; },
    exponentialRampToValueAtTime(v, t) { push('exp', line.end === -Infinity ? 0 : line.end, t, v); return this; },
    setTargetAtTime(v, t) { push('target', t, t, v); return this; },
    setValueCurveAtTime(c, t, d) { push('curve', t, t + d, c[0]); return this; },
    cancelScheduledValues(t) {
      line.events = line.events.filter((e) => e.start < t);
      line.end = line.events.reduce((m, e) => Math.max(m, Math.min(e.end, t)), -Infinity);
      return this;
    },
    cancelAndHoldAtTime(t) { return this.cancelScheduledValues(t); },
  };
}
function makeNode(kind) {
  const node = {
    kind, type: 'lowpass', outputs: [], buffer: null, curve: null, loop: false, onended: null,
    connect(target) { this.outputs.push(target); return target; },
    disconnect() {},
    start() {}, stop() {},
    setPeriodicWave() {},
  };
  for (const p of ['gain', 'frequency', 'Q', 'detune', 'pan', 'delayTime', 'playbackRate', 'offset']) {
    node[p] = makeParam(node, p, p === 'gain' ? 1 : p === 'Q' ? 1 : 440);
  }
  created.push(node);
  return node;
}
class MockContext {
  constructor() { this.currentTime = 0; this.sampleRate = 48000; this.destination = makeNode('destination'); }
  createGain() { return makeNode('gain'); }
  createOscillator() { return makeNode('oscillator'); }
  createBiquadFilter() { return makeNode('biquad'); }
  createStereoPanner() { return makeNode('panner'); }
  createDelay() { return makeNode('delay'); }
  createBufferSource() { return makeNode('bufferSource'); }
  createConstantSource() { return makeNode('constant'); }
  createWaveShaper() { return makeNode('shaper'); }
  createPeriodicWave() { return {}; }
  createBuffer(ch, len, sr) { const d = new Float32Array(len); return { length: len, sampleRate: sr, numberOfChannels: ch, getChannelData: () => d }; }
}

function play(track, id, filter) {
  created = [];
  const ctx = new MockContext();
  const voice = VOICES[track][id];
  const patch = JSON.parse(JSON.stringify(voice.defaults));
  Object.assign(patch.filter, filter);
  voice.play(ctx, ctx.destination, { when: 0.1, freq: 220, midi: 57, velocity: 0.8, duration: 1.5, pan: 0 }, patch);
  return { ctx, nodes: created.slice() };
}

/** The formant band-passes: biquads of type bandpass fed by one gain, each into its own gain. */
function formantBank(nodes) {
  const banks = nodes.filter((n) => n.kind === 'gain'
    && n.outputs.length === 3
    && n.outputs.every((o) => o.kind === 'biquad' && o.type === 'bandpass'));
  return banks.map((input) => ({
    input,
    formants: input.outputs.map((bp) => ({
      freq: bp.frequency.value,
      Q: bp.Q.value,
      gain: bp.outputs[0].gain.value,
      sum: bp.outputs[0].outputs[0],
    })),
  }));
}

const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

// --------------------------------------------------------------------------

test('the registry offers vowel honestly: a type, a row of its own, and the dials each type listens to', () => {
  const type = PARAM_REGISTRY['patch.filter.type'];
  assert.ok(type.domain.includes('vowel'), 'patch.filter.type does not accept vowel');
  const row = PARAM_REGISTRY['patch.filter.vowel'];
  assert.ok(row, 'no patch.filter.vowel row');
  assert.equal(row.kind, 'number');
  assert.deepEqual([...row.domain], [0, VOWELS.length - 1], 'the vowel row is not sized to the table');
  assert.equal(row.unit, '', 'a vowel position has no unit — its readout is letters');
  assert.equal(VOWEL_TABLE.length, VOWELS.length);
  assert.deepEqual(Object.keys(FILTER_TYPE_DIALS).sort(), [...type.domain].sort(),
    'FILTER_TYPE_DIALS and the type domain disagree');
  for (const [t, dials] of Object.entries(FILTER_TYPE_DIALS)) {
    for (const d of dials) assert.ok(PARAM_REGISTRY[`patch.filter.${d}`], `${t} names filter.${d}, which has no row`);
  }
  assert.ok(!FILTER_TYPE_DIALS.vowel.includes('cutoff'), 'vowel still shows a Cutoff in Hz — the lie the deferral named');
  assert.ok(!FILTER_TYPE_DIALS.vowel.includes('envAmount'), 'vowel shows Env amount, which it does not read');
  for (const t of ['lowpass', 'highpass', 'bandpass', 'notch']) {
    assert.ok(!FILTER_TYPE_DIALS[t].includes('vowel'), `${t} shows a Vowel dial it does not read`);
  }
});

test('no stock voice ships a vowel filter, and none publishes a vowel default', () => {
  for (const [track, voices] of Object.entries(VOICES)) {
    for (const [id, voice] of Object.entries(voices)) {
      assert.notEqual(voice.defaults.filter.type, 'vowel', `${track}.${id} ships vowel`);
      assert.ok(!('vowel' in voice.defaults.filter), `${track}.${id} publishes filter.vowel`);
    }
  }
});

test('the position walks the table: exact on a letter, geometric between, F1/F2 moving as the table says', () => {
  VOWEL_TABLE.forEach((row, i) => assert.deepEqual(formantsAt(i), [...row], `position ${i} is not ${VOWELS[i]}`));
  const between = formantsAt(2.5);
  between.forEach((f, k) => assert.ok(close(f, Math.sqrt(VOWEL_TABLE[2][k] * VOWEL_TABLE[3][k])), `F${k + 1} at a~e is not the geometric mean`));
  // Between two rows every formant lies between its two ends.
  for (let i = 0; i < VOWEL_TABLE.length - 1; i += 1) {
    for (let k = 0; k < 3; k += 1) {
      const [a, b] = [VOWEL_TABLE[i][k], VOWEL_TABLE[i + 1][k]];
      const f = formantsAt(i + 0.3)[k];
      assert.ok(f >= Math.min(a, b) - 1e-9 && f <= Math.max(a, b) + 1e-9, `F${k + 1} leaves its segment`);
    }
  }
  // u → i: F2 rises from the back of the mouth to the front.
  assert.ok(formantsAt(4)[1] > formantsAt(0)[1] * 2.5, 'F2 does not travel from u to i');
  assert.equal(formantsAt(-3)[0], VOWEL_TABLE[0][0], 'below u is not clamped to u');
  assert.equal(formantsAt(99)[0], VOWEL_TABLE[4][0], 'above i is not clamped to i');
  assert.deepEqual(formantsAt(NaN), [...VOWEL_TABLE[VOWEL_HOME]], 'a missing position is not a');
  assert.equal(vowelName(0), 'u'); assert.equal(vowelName(2), 'a'); assert.equal(vowelName(2.5), 'a~e');
});

test('selecting vowel builds the formant bank on a subtractive voice', () => {
  for (const [track, id] of [['pad', 'warm'], ['bass', 'sawbass'], ['melody', 'pluck'], ['arp', 'softPluck']]) {
    for (const position of [0, 1, 2, 3, 4, 1.5]) {
      const q = 2;
      const { nodes } = play(track, id, { type: 'vowel', vowel: position, q });
      const banks = formantBank(nodes);
      assert.equal(banks.length, 1, `${track}.${id}: expected one formant bank, found ${banks.length}`);
      const { formants } = banks[0];
      const want = formantsAt(position);
      formants.forEach((f, k) => {
        assert.ok(close(f.freq, want[k], 1e-6), `${track}.${id} @${position}: F${k + 1} ${f.freq} != ${want[k]}`);
        assert.ok(close(f.Q, formantQ(q)), `${track}.${id}: formant Q ${f.Q} is not Resonance's`);
      });
      // Parallel: three separate paths re-joining one node.
      assert.equal(new Set(formants.map((f) => f.sum)).size, 1, `${track}.${id}: the formants do not sum into one node`);
      const gains = formants.reduce((a, f) => a + f.gain, 0);
      assert.ok(close(gains, 1), `${track}.${id}: the bank's gains sum to ${gains}, not 1`);
      // The voice's own cutoff sweep is scheduled on a biquad that reaches nothing.
      const held = nodes.filter((n) => n.kind === 'biquad' && n.outputs.length === 0);
      assert.ok(held.length >= 1, `${track}.${id}: the sweep's param has no inert home`);
      assert.ok(!nodes.some((n) => n.kind === 'biquad' && n.type === 'lowpass' && n.outputs.length > 0
        && track === 'pad'), `${track}.${id}: the authored low-pass still sounds under vowel`);
    }
  }
  // A different type builds no bank at all.
  assert.equal(formantBank(play('pad', 'warm', { type: 'lowpass' }).nodes).length, 0, 'low-pass built a bank');
});

test('Resonance is the formants\' Q, monotonic across its dial', () => {
  let last = 0;
  for (const q of [0.1, 0.3, 0.7, 1, 2, 5, 10, 20]) {
    const Q = formantQ(q);
    assert.ok(Q > last, `formantQ is not monotonic at ${q}`);
    last = Q;
  }
  assert.ok(formantQ(0.7) > 3 && formantQ(0.7) < 6, 'the usual Resonance does not give a nameable vowel width');
});

test('level law: the bank never exceeds unity, at any position, Q or frequency — and is not needlessly quiet', () => {
  assert.ok(close(vowelBank(2, 1).gains.reduce((a, b) => a + b, 0), 1), 'gains do not sum to 1');
  for (const sr of [44100, 48000]) {
    for (let pos = 0; pos <= 4; pos += 0.25) {
      for (const q of [0.1, 0.7, 2, 8, 20]) {
        const bank = vowelBank(pos, q);
        let peak = 0;
        for (const f of lawGrid(bank.freqs, sr, 600)) peak = Math.max(peak, bankMagnitude(f, bank, sr));
        assert.ok(peak <= 1 + 1e-9, `vowel ${pos} q ${q} @${sr}: peak response ${peak.toFixed(4)} > 1`);
        // F1 alone carries 1/1.75 of the bank: the vowel's own peak is at
        // least that, so choosing Vowel costs at most ~5 dB at the peak.
        assert.ok(peak >= FORMANT_LEVELS[0] / FORMANT_LEVELS.reduce((a, b) => a + b, 0) - 1e-6,
          `vowel ${pos} q ${q}: peak ${peak.toFixed(3)} is quieter than F1 alone`);
      }
    }
  }
  // The band-pass the law is computed on IS the spec's: 0 dB at its centre.
  for (const f of [100, 730, 3010]) {
    const h = bandpassResponse(f, f, 4, 48000);
    assert.ok(close(Math.hypot(h.re, h.im), 1, 1e-9), `band-pass at ${f} Hz is not 0 dB at its centre`);
  }
});

test('the formants\' peaks land on the table: the response at F1/F2 beats the dip between them', () => {
  for (let i = 0; i < VOWELS.length; i += 1) {
    const bank = vowelBank(i, 2);
    const [f1, f2] = bank.freqs;
    if (f2 / f1 < 1.8) continue; // o's formants are a fifth apart and merge — measured in the render check
    const dip = bankMagnitude(Math.sqrt(f1 * f2), bank, 48000);
    assert.ok(bankMagnitude(f1, bank, 48000) > dip * 1.5, `${VOWELS[i]}: no peak at F1`);
    assert.ok(bankMagnitude(f2, bank, 48000) > dip, `${VOWELS[i]}: no peak at F2`);
  }
});

test('every param\'s automation stays in time order under the bank', () => {
  for (const [track, voices] of Object.entries(VOICES)) {
    for (const id of Object.keys(voices)) {
      const { nodes } = play(track, id, { type: 'vowel', vowel: 3.2, q: 4 });
      for (const n of nodes) {
        for (const p of ['gain', 'frequency', 'Q', 'detune', 'playbackRate', 'pan']) {
          assert.equal(n[p].line.bad, 0, `${track}.${id}: ${n.kind}.${p} has an event before the previous one ends`);
        }
      }
      // The formants themselves hold still for the note: no scheduled events.
      for (const bank of formantBank(nodes)) {
        for (const bp of bank.input.outputs) {
          assert.equal(bp.frequency.line.events.length, 0, `${track}.${id}: a formant frequency moves mid-note`);
        }
      }
    }
  }
});

test('the words name the vowel in letters, and print no Hz for it', () => {
  const patch = JSON.parse(JSON.stringify(VOICES.pad.warm.defaults));
  patch.filter = { ...patch.filter, type: 'vowel', vowel: 2, q: 3 };
  const said = describePatch({ engineType: 'subtractive', patch, controls: true });
  assert.ok(/vowel filter on ‘a’/i.test(said), `words: ${said}`);
  assert.ok(!/Hz/.test(said.split('.').find((s) => /vowel/i.test(s))), `the vowel sentence prints Hz: ${said}`);
  assert.ok(!/opening/.test(said), `the words claim the vowel opens with each note: ${said}`);
  patch.filter.vowel = { min: 1, max: 3 };
  assert.ok(/from ‘o’ to ‘e’/.test(describePatch({ patch })), 'a spread does not name its ends');
  patch.filter.vowel = 2.5;
  assert.ok(/between ‘a’ and ‘e’/.test(describePatch({ patch })), 'a blend is not named');
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed) process.exit(1);
