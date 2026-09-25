/**
 * Smoke test for src/scripts/sound-finder.js — run with:
 *   node tests/sound-finder-smoke.mjs
 *
 * The sound-in-mind finder (docs/synthesis-programme.md § 4, layer 4) is a
 * TABLE: a word, a starting voice per voice set, the moves that carry it
 * there. This holds the table's referential integrity — every voice it names
 * exists and is of the engine the moves need, every dial it names is a
 * registry row that voice actually exposes, every direction is up or down,
 * every word has its opposite — and the lookup's own laws. What it cannot
 * hold is the CLAIM (that "bright" is brighter): that is measured in a
 * browser render, tests/pending/sound-finder-render-drive.mjs, parked until
 * the bridge key returns (fromClaude 13).
 */

import assert from 'node:assert/strict';
import { VOICES } from '../src/scripts/engine-voices.js';
import { PARAM_REGISTRY } from '../src/scripts/param-registry.js';
import { SOUND_WORDS, wordPairs, findSound, moveValue } from '../src/scripts/sound-finder.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/** The editor's own rule: a voice exposes a dial when its controls allow the section/field and it publishes the section. */
function exposes(voiceSet, voiceId, field) {
  const voice = VOICES[voiceSet] && VOICES[voiceSet][voiceId];
  if (!voice) return false;
  const [section, key] = field.split('.');
  const spec = voice.controls && voice.controls[section];
  const allowed = spec === undefined || spec === true || (Array.isArray(spec) && spec.includes(key));
  if (!allowed || spec === false) return false;
  const published = voice.defaults && voice.defaults[section];
  if (['fm', 'additive', 'modal'].includes(section)) return !!(published && key in published);
  if (section === 'source' && !['osc1', 'osc2', 'shape1', 'shape2', 'mix', 'detune', 'octave', 'pitch', 'noise', 'fold'].includes(key)) {
    return !!(published && key in published);
  }
  if (key === 'fold' || key === 'noise' || key === 'pitch') return !!(published && key in published);
  return true;
}

test('every word has its opposite in the table, and the pairs read as six', () => {
  const words = new Set(SOUND_WORDS.map((e) => e.word));
  for (const entry of SOUND_WORDS) {
    assert.ok(words.has(entry.opposite), `${entry.word}: opposite ${entry.opposite} is not a word`);
    assert.equal(SOUND_WORDS.find((e) => e.word === entry.opposite).opposite, entry.word, `${entry.word}: the opposite does not point back`);
    assert.ok(typeof entry.why === 'string' && entry.why.length >= 30 && /\.$/.test(entry.why), `${entry.word}: why must be a sentence`);
  }
  assert.equal(wordPairs().length, 6);
});

test('every voice the table names exists, and every dial it names is a registry row that voice exposes', () => {
  let rows = 0;
  for (const entry of SOUND_WORDS) {
    for (const [voiceSet, spec] of Object.entries(entry.sets)) {
      assert.ok(VOICES[voiceSet], `${entry.word}: ${voiceSet} is not a voice set`);
      assert.ok(VOICES[voiceSet][spec.voice], `${entry.word}: ${voiceSet}.${spec.voice} is not a voice`);
      assert.equal(spec.moves.length, 2, `${entry.word} on ${voiceSet}: two moves, one per hand`);
      for (const move of spec.moves) {
        assert.ok(PARAM_REGISTRY[`patch.${move.field}`], `${entry.word} on ${voiceSet}: ${move.field} is not a registry row`);
        assert.ok(exposes(voiceSet, spec.voice, move.field), `${entry.word} on ${voiceSet}: ${spec.voice} does not expose ${move.field} — the finder would name a dial the editor does not show`);
        assert.ok(['up', 'down'].includes(move.direction), `${entry.word} on ${voiceSet}: direction ${move.direction}`);
        assert.ok(typeof move.note === 'string' && move.note.length >= 6, `${entry.word} on ${voiceSet}: a move needs a note`);
        rows += 1;
      }
    }
  }
  assert.ok(rows >= 100, `${rows} moves — the table has thinned`);
});

test('every word speaks for every tuned set; a kit is spoken for by none', () => {
  for (const entry of SOUND_WORDS) {
    for (const set of ['pad', 'melody', 'bass', 'arp', 'texture']) {
      assert.ok(entry.sets[set], `${entry.word} has nothing for ${set}`);
    }
    assert.equal(entry.sets.percussion, undefined, `${entry.word}: a kit is not "${entry.word}" — the finder must say so rather than guess`);
  }
});

test('findSound: the voice most words agree on, every move on it, in the order the words were picked', () => {
  const found = findSound(['bright', 'glassy'], 'melody', { exposes: (v, f) => exposes('melody', v, f) });
  assert.equal(found.voice, 'bell', 'bright and glassy both say Bell on the melody');
  assert.deepEqual(found.moves.map((m) => m.field), ['fm.depth', 'fm.bite', 'fm.ratio'], 'a repeated dial is named once');
  assert.ok(found.why.includes('Brightness') && found.why.includes('Glass'), found.why);
  const tie = findSound(['plucky', 'warm'], 'melody', { exposes: (v, f) => exposes('melody', v, f) });
  assert.equal(tie.voice, 'pluck', 'a tie goes to the first word picked');
  assert.ok(tie.moves.every((m) => exposes('melody', 'pluck', m.field)), 'moves that Pluck cannot make are dropped');
});

test('findSound: a kit, or a word the table lacks, gets a plain sentence and no voice', () => {
  const kit = findSound(['bright'], 'percussion');
  assert.equal(kit.voice, null);
  assert.match(kit.why, /Nothing here is honestly bright on this track/);
  assert.equal(findSound(['nonsense'], 'pad').voice, null);
  assert.match(findSound([], 'pad').why, /Pick a word/);
});

test('moveValue: a third of the way to the end named, never past it, both ends of a span', () => {
  assert.equal(moveValue(0.3, 'up', [0, 1]), 0.3 + 0.7 / 3);
  assert.equal(moveValue(0.3, 'down', [0, 1]), 0.2);
  assert.equal(moveValue(1, 'up', [0, 1]), 1);
  assert.deepEqual(moveValue({ min: 0, max: 0.6 }, 'up', [0, 1]), { min: 1 / 3, max: 0.6 + 0.4 / 3 });
  assert.equal(moveValue(undefined, 'up', [40, 12000]), 40 + (12000 - 40) / 3, 'no value starts from the bottom');
});

test('MUTATION: a dial the voice does not expose is caught by the integrity check', () => {
  assert.ok(!exposes('pad', 'warm', 'fm.ratio'), 'Warm has no FM dials');
  assert.ok(exposes('melody', 'bell', 'fm.ratio'));
  assert.ok(!exposes('melody', 'bell', 'source.mix'), 'Bell hides Mix');
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
