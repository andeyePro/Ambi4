/**
 * A melody → the chord loop that fits it. Run with:
 *   node tests/harmonise-smoke.mjs
 *
 * His compose brief, entry point one: "Play or type a melody, chords derived
 * algorithmically on request." This suite guards the derivation half — the
 * pure module that reads pinned steps and names a diatonic chord per bar.
 *
 * The rules it pins, so a tweak that silently changes them fails loudly:
 * on-beat notes decide, off-beat notes are free to pass; the loop prefers to
 * start and end at home; an empty bar carries the chord it is inside rather
 * than wandering; and the same melody always yields the same chords — there
 * is no draw anywhere in this.
 */

import assert from 'node:assert/strict';
import { deriveChords } from '../src/scripts/harmonise.js';

const IONIAN = [0, 2, 4, 5, 7, 9, 11];
const PENTA = [0, 2, 4, 7, 9];
const OPTS = { scale: IONIAN, rootPc: 0, pulseSlots: [0, 4, 8, 12] };
const note = (slot, midi) => ({ slot, midi });

// C major arpeggio and G major arpeggio, one bar each.
const BAR_I = [note(0, 60), note(4, 64), note(8, 67), note(12, 64)];
const BAR_V = [note(0, 67), note(4, 71), note(8, 74), note(12, 71)];

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('a C arpeggio then a G arpeggio reads I V', () => {
  const got = deriveChords([BAR_I, BAR_V], OPTS);
  assert.deepEqual(got.perBar, [0, 4]);
  assert.deepEqual(got.numerals, ['I', 'V']);
  assert.equal(got.pitched, 8);
});

test('off-beat passing notes do not derail the chord', () => {
  // C E G on the beats; D and F passing between them, off the pulse.
  const bar = [note(0, 60), note(2, 62), note(4, 64), note(6, 65), note(8, 67)];
  const got = deriveChords([bar], OPTS);
  assert.deepEqual(got.numerals, ['I']);
});

test('an ambiguous lone note falls toward home', () => {
  // A single G is the fifth of I and the root of V; the loop prefers home.
  const got = deriveChords([[note(0, 67)]], OPTS);
  assert.deepEqual(got.numerals, ['I']);
});

test('an empty bar carries the chord it is inside', () => {
  const got = deriveChords([BAR_I, [], BAR_V], OPTS);
  assert.deepEqual(got.perBar, [0, 0, 4]);
  assert.equal(got.emptyBars, 1);
});

test('a one-chord melody collapses to a one-chord loop', () => {
  const got = deriveChords([BAR_I, BAR_I, BAR_I, BAR_I], OPTS);
  assert.deepEqual(got.numerals, ['I']);
  assert.deepEqual(got.perBar, [0, 0, 0, 0]);
});

test('a repeating pair collapses to its period', () => {
  const got = deriveChords([BAR_I, BAR_V, BAR_I, BAR_V], OPTS);
  assert.deepEqual(got.numerals, ['I', 'V']);
});

test('notes outside the scale are chromatic passing notes, not chord evidence', () => {
  const withSharp = [...BAR_I, note(6, 66)]; // an F# in C major
  const got = deriveChords([withSharp], OPTS);
  assert.deepEqual(got.numerals, ['I']);
  assert.equal(got.pitched, 4, 'the F# is not counted as harmonic evidence');
});

test('a pentatonic scale yields degrees the scale actually has', () => {
  const got = deriveChords([[note(0, 60), note(4, 64), note(8, 67)]], {
    ...OPTS, scale: PENTA,
  });
  assert.ok(got.perBar.every((d) => d >= 0 && d < PENTA.length));
});

test('degrees never exceed what a roman numeral can say', () => {
  const chromatic = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const got = deriveChords([BAR_I], { ...OPTS, scale: chromatic });
  assert.ok(got.perBar.every((d) => d >= 0 && d < 7));
});

test('nothing pitched means null, not a guessed tonic', () => {
  assert.equal(deriveChords([[], []], OPTS), null);
  assert.equal(deriveChords([], OPTS), null);
});

test('the derivation is deterministic', () => {
  const bars = [BAR_I, BAR_V, [note(0, 65), note(4, 69), note(8, 72)]];
  const a = deriveChords(bars, OPTS);
  const b = deriveChords(bars, OPTS);
  assert.deepEqual(a, b);
});

test('the loop caps at eight chords, the engine seed law', () => {
  const bars = Array.from({ length: 12 }, (_, i) => (i % 2 ? BAR_V : BAR_I));
  const got = deriveChords(bars, OPTS, );
  assert.ok(got.perBar.length <= 8);
});

test('a minor-mode melody names its own tonic i', () => {
  const aeolian = [0, 2, 3, 5, 7, 8, 10];
  // A aeolian: A C E arpeggio with rootPc 9.
  const bar = [note(0, 57), note(4, 60), note(8, 64), note(12, 60)];
  const got = deriveChords([bar], { scale: aeolian, rootPc: 9, pulseSlots: [0, 4, 8, 12] });
  assert.deepEqual(got.perBar, [0]);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`ok  ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}\n  ${error.message}`);
  }
}
if (failed) {
  console.error(`harmonise-smoke: ${failed} of ${tests.length} failed`);
  process.exit(1);
}
console.log(`${tests.length}/${tests.length} passed`);
