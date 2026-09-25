/**
 * Smoke test for src/scripts/patch-words.js — run with:
 *   node tests/patch-words-smoke.mjs
 *
 * "What makes this sound" is the line under every voice editor's dials, written
 * from the live patch (docs/synthesis-programme.md § 4, layer 2). One law
 * holds it: every number the sentence prints IS a value of the patch it
 * describes, printed by the formatter the editor uses for that unit. A line
 * that says 3520 Hz while the dial says 3600 is a readout lying about its
 * dial, so the law is checked on every stock voice, on a spread, and after a
 * change — and a mutation check proves the checker bites.
 */

import assert from 'node:assert/strict';
import { VOICES } from '../src/scripts/engine-voices.js';
import { describePatch, printableNumbers, fmt } from '../src/scripts/patch-words.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const NUMBER = /-?\d+(?:\.\d+)?/g;

/** Every number printed in a sentence, as strings, sign dropped. */
const printed = (text) => (text.match(NUMBER) || []).map((n) => n.replace(/^-/, ''));

const deepClone = (v) => JSON.parse(JSON.stringify(v));

function describeVoice(track, id, patch = null) {
  const voice = VOICES[track][id];
  return describePatch({
    engineType: voice.engineType,
    patch: patch || voice.defaults,
    controls: voice.controls,
    detuneMode: voice.detuneMode || null,
  });
}

test('every stock voice gets a sentence, and every number in it is a patch value', () => {
  let voices = 0;
  for (const [track, bank] of Object.entries(VOICES)) {
    for (const id of Object.keys(bank)) {
      const text = describeVoice(track, id);
      assert.ok(typeof text === 'string' && text.length >= 20, `${track}.${id}: no sentence (${JSON.stringify(text)})`);
      assert.ok(text.length <= 360, `${track}.${id}: ${text.length} chars is too long to read under the dials`);
      assert.ok(/\.$/.test(text), `${track}.${id}: does not end as a sentence: ${text}`);
      assert.ok(!/[<>`]/.test(text), `${track}.${id}: markup in the words`);
      const allowed = printableNumbers(VOICES[track][id].defaults);
      for (const n of printed(text)) {
        assert.ok(allowed.has(n),
          `${track}.${id}: the sentence prints ${n}, which is no value of the patch — "${text}"`);
      }
      voices += 1;
    }
  }
  assert.equal(voices, 36, `${voices} voices described, not 36`);
});

test('the engine class opens the sentence in its own words', () => {
  assert.match(describeVoice('melody', 'bell'), /^A sine carrier wobbled by a sine modulator \(FM\) at 3\.47× the note, bright for 0\.8 s/);
  assert.match(describeVoice('melody', 'stab'), /^6 partials summed at their own levels \(additive\)/);
  assert.match(describeVoice('pad', 'glass'), /^Two engines: 5 partials summed/);
  assert.match(describeVoice('texture', 'chimes'), /^A struck-object model \(modal, metal\)/);
  assert.match(describeVoice('arp', 'marimba'), /\(modal, wood\)/);
  assert.match(describeVoice('texture', 'colour'), /^Sculpted noise/);
  assert.match(describeVoice('pad', 'warm'), /^Saw and triangle/);
  assert.match(describeVoice('melody', 'pluck'), /^Two saws/);
});

test('the words follow the patch: a moved dial moves the number, and only that number', () => {
  const before = describeVoice('melody', 'pluck');
  assert.match(before, /Low-pass at 3520 Hz/);
  const patch = deepClone(VOICES.melody.pluck.defaults);
  patch.filter.cutoff = 900;
  const after = describeVoice('melody', 'pluck', patch);
  assert.match(after, /Low-pass at 900 Hz/);
  assert.doesNotMatch(after, /3520/);
  assert.equal(before.replace('3520 Hz', '900 Hz'), after, 'only the cutoff number may change');
});

test('the drawbars are described only when moved, and stretch as a signed percentage', () => {
  const patch = deepClone(VOICES.melody.stab.defaults);
  patch.additive.p2 = 0.5;
  patch.additive.stretch = 0.03;
  const text = describeVoice('melody', 'stab', patch);
  assert.match(text, /partial 2 at 0\.5×/);
  assert.match(text, /stretched \+3% per partial/);
  const allowed = printableNumbers(patch);
  for (const n of printed(text)) assert.ok(allowed.has(n), `${n} is not a patch value: ${text}`);
});

test('a struck voice names its material, and hardness and damping only when moved', () => {
  const patch = deepClone(VOICES.texture.chimes.defaults);
  patch.modal.material = 'bell';
  patch.modal.damping = 2;
  const text = describeVoice('texture', 'chimes', patch);
  assert.match(text, /\(modal, bell\), damped 2×/);
  assert.doesNotMatch(text, /struck .* as hard/);
  const allowed = printableNumbers(patch);
  for (const n of printed(text)) assert.ok(allowed.has(n), `${n} is not a patch value: ${text}`);
});

test('a spread prints as its two ends, both of them patch values', () => {
  const patch = deepClone(VOICES.pad.warm.defaults);
  patch.filter.cutoff = { min: 400, max: 900 };
  const text = describeVoice('pad', 'warm', patch);
  assert.match(text, /Low-pass at 400–900 Hz/);
  const allowed = printableNumbers(patch);
  for (const n of printed(text)) assert.ok(allowed.has(n), `${n} is not a patch value: ${text}`);
});

test('units print the way the editors print them', () => {
  assert.equal(fmt.sec(0.006), '6 ms');
  assert.equal(fmt.sec(1.1), '1.1 s');
  assert.equal(fmt.hz(3520.4), '3520 Hz');
  assert.equal(fmt.pct(0.267), '27%');
  assert.equal(fmt.cents(6), '6 cents');
});

test('a kit voice describes its drum, its noise and its tuning, not an oscillator stack', () => {
  const text = describeVoice('percussion', 'soft');
  assert.match(text, /drum|skin/i);
  assert.match(text, /noise \d+%/);
  const patch = deepClone(VOICES.percussion.soft.defaults);
  patch.source.pitch = -5;
  assert.match(describeVoice('percussion', 'soft', patch), /tuned 5 semitones down/);
});

test('a field the voice hides is not described (the controls rule)', () => {
  // Bell exposes detune and octave from source, nothing else — so no mix, no
  // shape words, however the patch reads.
  const text = describeVoice('melody', 'bell');
  assert.doesNotMatch(text, /mix/);
  assert.doesNotMatch(text, /saw|triangle|square/);
  // A patch with no controls at all: everything applies.
  const bare = describePatch({ engineType: 'subtractive', patch: VOICES.pad.warm.defaults, controls: true, detuneMode: 'stack' });
  assert.match(bare, /spread/);
  assert.equal(describePatch({ patch: null }), '');
});

test('MUTATION: the number law bites — a formatter that rounds differently is caught', () => {
  // Print cutoff through a different rounding than the patch holds and the
  // allowed set no longer contains it: the checker must refuse the sentence.
  const patch = deepClone(VOICES.melody.pluck.defaults);
  patch.filter.cutoff = 3520.6;
  const text = describeVoice('melody', 'pluck', patch);
  const allowed = printableNumbers(patch);
  assert.ok(printed(text).every((n) => allowed.has(n)), 'sanity: the honest sentence passes');
  const lying = text.replace('3521 Hz', '3520 Hz');
  assert.notEqual(lying, text, 'the mutation must actually change the sentence');
  assert.ok(!printed(lying).every((n) => allowed.has(n)), 'the checker let a wrong number through');
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
