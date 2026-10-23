/**
 * A chord loop → a tune over it. Run with:
 *   node tests/tune-from-chords-smoke.mjs
 *
 * His compose brief, entry point two: "Play or type a chord sequence, melody
 * derived." The mirror of harmonise-smoke: that suite pins chords read out of
 * a tune, this one pins a tune written over chords. The rules it holds, each
 * of them documented at the top of src/scripts/tune-from-chords.js:
 * chord tones on the beats, stepwise in-scale tones between them, the
 * register, a cadence home at the end, determinism, and density scaling the
 * note count.
 */

import assert from 'node:assert/strict';
import { tuneFromChords, chordTones, chordBarsForTune } from '../src/scripts/tune-from-chords.js';

const IONIAN = [0, 2, 4, 5, 7, 9, 11];
const AEOLIAN = [0, 2, 3, 5, 7, 8, 10];
const PENTA = [0, 2, 4, 7, 9];
const MELODY = { low: 55, high: 79 };

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const pcIndex = (midi, scale, rootPc) => scale.indexOf((((midi - rootPc) % 12) + 12) % 12);
const indexOfMidi = (midi, scale, rootPc) => {
  // absolute scale index, so "one step" is countable
  const rel = midi - rootPc;
  const octave = Math.floor(rel / 12);
  return octave * scale.length + scale.indexOf(rel - octave * 12);
};

/** Many cases, so a rule is held across loops, scales, metres and densities. */
const CASES = [];
for (const [scale, rootPc] of [[IONIAN, 0], [AEOLIAN, 9], [IONIAN, 7], [PENTA, 2]]) {
  for (const chords of [[0, 5, 3, 4], [0, 3, 4, 0], [5, 3, 0, 4, 1, 4, 0, 0], [0], [4, 0]]) {
    for (const [beatsPerBar, pulseSlots, slotsPerBar] of [[4, [0, 4, 8, 12], 16], [3, [0, 4, 8], 12], [2, [0, 6], 12]]) {
      for (const density of [0, 0.3, 0.7, 1]) {
        for (const seed of [0, 1, 7]) {
          CASES.push({ scale, rootPc, chords: chords.map((d) => d % scale.length), beatsPerBar, pulseSlots, slotsPerBar, density, seed, register: MELODY });
        }
      }
    }
  }
}

test('chord length for a tune: a length no fixed tune can follow becomes one it can', () => {
  // Auto draws 1 or 2 bars a chord as it plays; a section is any length.
  assert.equal(chordBarsForTune(4, 'auto'), 1);
  assert.equal(chordBarsForTune(4, 'section'), 2);
  assert.equal(chordBarsForTune(8, 'section'), 1);
  assert.equal(chordBarsForTune(1, 'section'), 8);
  // A pass longer than eight bars is shortened to the longest that fits.
  assert.equal(chordBarsForTune(4, 4), 2);
  assert.equal(chordBarsForTune(3, 3), 2);
  assert.equal(chordBarsForTune(8, 16), 1);
  // A length that fits is left alone, a string from a select included.
  assert.equal(chordBarsForTune(4, 2), 2);
  assert.equal(chordBarsForTune(2, '4'), 4);
  assert.equal(chordBarsForTune(1, 8), 8);
  for (let count = 1; count <= 8; count++) {
    for (const rhythm of ['auto', 'section', ...Array.from({ length: 16 }, (_, i) => i + 1)]) {
      const per = chordBarsForTune(count, rhythm);
      assert.ok(Number.isInteger(per) && per >= 1 && count * per <= 8, `${count} chords at ${rhythm}: ${per}`);
    }
  }
});

test('every note on a beat is a tone of the chord in force', () => {
  for (const c of CASES) {
    const got = tuneFromChords(c);
    for (const note of got.notes) {
      if (!c.pulseSlots.includes(note.slot)) continue;
      const degree = c.chords[note.bar % c.chords.length];
      const tones = chordTones(degree, c.scale.length);
      assert.ok(tones.includes(pcIndex(note.midi, c.scale, c.rootPc)),
        `bar ${note.bar} slot ${note.slot} midi ${note.midi} is not in chord ${degree} (${JSON.stringify(c.chords)})`);
      assert.ok(['chord', 'cadence'].includes(note.role));
    }
  }
});

test('the downbeat of every bar carries a note', () => {
  for (const c of CASES) {
    const got = tuneFromChords(c);
    for (let bar = 0; bar < got.bars; bar++) {
      assert.ok(got.notes.some((n) => n.bar === bar && n.slot === 0), `bar ${bar} has no downbeat`);
    }
  }
});

test('notes between the beats are in the scale and one step from the note before', () => {
  let between = 0;
  for (const c of CASES) {
    const got = tuneFromChords(c);
    got.notes.forEach((note, i) => {
      assert.ok(pcIndex(note.midi, c.scale, c.rootPc) >= 0, `midi ${note.midi} is off the scale`);
      if (c.pulseSlots.includes(note.slot)) return;
      between += 1;
      assert.ok(i > 0, 'a line never opens on a passing tone');
      const step = indexOfMidi(note.midi, c.scale, c.rootPc) - indexOfMidi(got.notes[i - 1].midi, c.scale, c.rootPc);
      assert.equal(Math.abs(step), 1, `passing tone ${note.midi} is ${step} steps from ${got.notes[i - 1].midi}`);
      assert.ok(['passing', 'neighbour'].includes(note.role));
    });
  }
  assert.ok(between > 100, `the cases exercised only ${between} passing tones`);
});

test('every note is inside the register, for a bass register too', () => {
  for (const c of CASES) {
    for (const register of [MELODY, { low: 28, high: 55 }, { low: 60, high: 72 }]) {
      const got = tuneFromChords({ ...c, register });
      for (const note of got.notes) {
        assert.ok(note.midi >= register.low && note.midi <= register.high, `${note.midi} outside ${register.low}-${register.high}`);
      }
    }
  }
});

test('the loop ends on a cadence: the tonic when the last chord holds it, held to the end', () => {
  for (const c of CASES) {
    const got = tuneFromChords(c);
    const last = got.notes[got.notes.length - 1];
    assert.equal(last.role, 'cadence');
    assert.equal(last.bar, got.bars - 1);
    assert.ok(c.pulseSlots.includes(last.slot), 'the cadence lands on a beat');
    assert.equal(last.slot + last.length, c.slotsPerBar, 'the cadence is held to the end of the bar');
    const finalChord = c.chords[(got.bars - 1) % c.chords.length];
    const tones = chordTones(finalChord, c.scale.length);
    const expected = tones.includes(0) ? 0 : finalChord;
    assert.equal(pcIndex(last.midi, c.scale, c.rootPc), expected);
  }
  // I vi IV V in C: the last chord is V, which has no C — it lands on G.
  const ending = tuneFromChords({ chords: [0, 5, 3, 4], scale: IONIAN, rootPc: 0, density: 0.5, register: MELODY });
  assert.equal(ending.notes.at(-1).midi % 12, 7);
  // I IV V I: home.
  const home = tuneFromChords({ chords: [0, 3, 4, 0], scale: IONIAN, rootPc: 0, density: 0.5, register: MELODY });
  assert.equal(home.notes.at(-1).midi % 12, 0);
});

test('the same loop and seed always write the same tune; another seed, another tune', () => {
  const a = tuneFromChords({ chords: [0, 5, 3, 4], scale: IONIAN, rootPc: 0, density: 0.6, seed: 3, register: MELODY });
  const b = tuneFromChords({ chords: [0, 5, 3, 4], scale: IONIAN, rootPc: 0, density: 0.6, seed: 3, register: MELODY });
  assert.deepEqual(a, b);
  const seeds = new Set();
  for (let seed = 0; seed < 8; seed++) {
    seeds.add(JSON.stringify(tuneFromChords({ chords: [0, 5, 3, 4], scale: IONIAN, rootPc: 0, density: 0.6, seed, register: MELODY }).notes));
  }
  assert.ok(seeds.size >= 4, `eight seeds wrote only ${seeds.size} different tunes`);
});

test('density scales the note count, and never removes a note for one seed', () => {
  let low = 0;
  let high = 0;
  for (const c of CASES) {
    let previous = -1;
    for (const density of [0, 0.25, 0.5, 0.75, 1]) {
      const count = tuneFromChords({ ...c, density }).notes.length;
      assert.ok(count >= previous, `density ${density} wrote ${count} < ${previous}`);
      previous = count;
    }
    low += tuneFromChords({ ...c, density: 0 }).notes.length;
    high += tuneFromChords({ ...c, density: 1 }).notes.length;
  }
  assert.ok(high >= 2.5 * low, `density 1 wrote ${high} notes against ${low} at density 0`);
});

test('the line arches: the middle of a phrase sits higher than its ends', () => {
  let wins = 0;
  let total = 0;
  for (let seed = 0; seed < 20; seed++) {
    const got = tuneFromChords({ chords: [0, 5, 3, 4], scale: IONIAN, rootPc: 0, density: 0.6, seed, register: MELODY });
    const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
    const first = mean(got.notes.filter((n) => n.bar === 0).map((n) => n.midi));
    const middle = mean(got.notes.filter((n) => n.bar === 2).map((n) => n.midi));
    const last = mean(got.notes.filter((n) => n.bar === 3).map((n) => n.midi));
    total += 1;
    if (middle > first && middle > last) wins += 1;
  }
  assert.ok(wins >= 0.8 * total, `only ${wins}/${total} phrases arched`);
});

test('bars per chord stretches the loop; bars are capped at eight', () => {
  const got = tuneFromChords({ chords: [0, 4], scale: IONIAN, rootPc: 0, barsPerChord: 2, density: 0.5, register: MELODY });
  assert.equal(got.bars, 4);
  for (const note of got.notes.filter((n) => n.slot === 0)) {
    const degree = [0, 4][Math.floor(note.bar / 2) % 2];
    assert.ok(chordTones(degree, 7).includes(pcIndex(note.midi, IONIAN, 0)));
  }
  assert.equal(tuneFromChords({ chords: [0, 1, 2, 3, 4, 5, 6, 0], barsPerChord: 4, scale: IONIAN, register: MELODY }).bars, 8);
});

// Review fix (v0.0.251-263): under Chord length in BEATS the engine's hook
// advances inside the bar (2 beats in 4/4 is two chords a bar), and the writer
// used to read one chord per bar — so beat 3's note was a tone of the chord
// that had already gone, and a four-chord loop wrote four bars over a loop
// the engine plays in two.
test('chord length in beats: each beat note fits the chord in force inside the bar', () => {
  for (const [starts, chords, wantBars] of [
    [[0, 8], [0, 5, 3, 4], 2], [[0, 8], [0, 3, 4], 3], [[0, 12], [5, 3, 0], 3], [[0, 4, 8, 12], [0, 3, 4, 0], 1],
  ]) {
    for (const density of [0, 0.5, 1]) {
      for (const seed of [0, 1, 7]) {
        const got = tuneFromChords({ chords, scale: IONIAN, rootPc: 0, pulseSlots: [0, 4, 8, 12], slotsPerBar: 16,
          chordStarts: starts, density, seed, register: MELODY });
        assert.equal(got.bars, wantBars, `${JSON.stringify(chords)} at ${JSON.stringify(starts)}: ${got.bars} bars`);
        const inForce = (bar, slot) => {
          let seg = 0;
          while (seg + 1 < starts.length && starts[seg + 1] <= slot) seg += 1;
          return chords[(bar * starts.length + seg) % chords.length];
        };
        for (const note of got.notes) {
          if (![0, 4, 8, 12].includes(note.slot)) continue;
          const degree = inForce(note.bar, note.slot);
          assert.ok(chordTones(degree, 7).includes(pcIndex(note.midi, IONIAN, 0)),
            `bar ${note.bar} slot ${note.slot} midi ${note.midi} is not in chord ${degree} (${JSON.stringify(chords)} at ${JSON.stringify(starts)})`);
        }
        // Every chord change carries a note, as every downbeat does.
        for (let bar = 0; bar < got.bars; bar++) {
          for (const slot of starts) {
            assert.ok(got.notes.some((n) => n.bar === bar && n.slot === slot), `no note at bar ${bar} slot ${slot}`);
          }
        }
        const last = got.notes.at(-1);
        assert.equal(last.role, 'cadence');
        assert.equal(last.slot, starts.at(-1), 'the cadence lands on the loop\'s last chord');
      }
    }
  }
});

test('inputs it cannot honour return null rather than a wrong tune', () => {
  assert.equal(tuneFromChords({ chords: [0], scale: [], register: MELODY }), null);
  assert.equal(tuneFromChords({ chords: [0], scale: IONIAN, register: { low: 60, high: 66 } }), null);
  // An empty loop is the tonic chord, not a crash.
  assert.ok(tuneFromChords({ chords: [], scale: IONIAN, register: MELODY }).notes.length > 0);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}\n     ${error.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
