/**
 * The MIDI-file reader — run with:
 *   node tests/midi-file-smoke.mjs
 *
 * Files are BUILT here rather than committed as binaries: a hand-built file is
 * a readable statement of what the parser is being asked to survive (running
 * status, a note-on at velocity 0 as a note-off, a missing note-off, meta
 * events of lengths we skip, a chunk that is not a track), and a committed .mid
 * is an opaque blob nobody can review.
 */

import assert from 'node:assert/strict';
import { parseMidiFile, notesToBars } from '../src/scripts/midi-file.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// -- the smallest possible SMF writer, for building fixtures ----------------

const varint = (value) => {
  const out = [value & 0x7f];
  let v = value >> 7;
  while (v > 0) {
    out.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return out;
};
const uint = (value, count) => {
  const out = [];
  for (let i = count - 1; i >= 0; i--) out.push((value >> (i * 8)) & 0xff);
  return out;
};
const chunk = (id, body) => [...id.split('').map((c) => c.charCodeAt(0)), ...uint(body.length, 4), ...body];
const header = (format, tracks, division) => chunk('MThd', [...uint(format, 2), ...uint(tracks, 2), ...uint(division, 2)]);
const trackChunk = (events) => chunk('MTrk', [...events, ...varint(0), 0xff, 0x2f, 0x00]);

// -- the cases ---------------------------------------------------------------

test('a plain format-0 file: two notes, in beats, with velocity', () => {
  const D = 480;
  const events = [
    ...varint(0), 0x90, 60, 100, // C4 on at tick 0
    ...varint(D), 0x80, 60, 0, //   off a beat later
    ...varint(0), 0x90, 64, 64, //  E4 on at beat 1
    ...varint(D * 2), 0x80, 64, 0, // off at beat 3
  ];
  const file = parseMidiFile(new Uint8Array([...header(0, 1, D), ...trackChunk(events)]));
  assert.equal(file.format, 0);
  assert.equal(file.division, D);
  assert.equal(file.notes.length, 2);
  assert.deepEqual(file.notes.map((n) => [n.midi, n.start, n.end]), [[60, 0, 1], [64, 1, 3]]);
  assert.ok(Math.abs(file.notes[0].velocity - 100 / 127) < 1e-9, 'velocity is 0–1');
  assert.deepEqual(file.skipped, []);
});

test('running status, and a note-on at velocity 0 as a note-off — both ordinary, both in the spec', () => {
  const D = 96;
  const events = [
    ...varint(0), 0x90, 60, 90, //        status given once…
    ...varint(D), 60, 0, //               …then running status, velocity 0 = off
    ...varint(0), 62, 90, //              on again, still running status
    ...varint(D), 62, 0,
  ];
  const file = parseMidiFile(new Uint8Array([...header(0, 1, D), ...trackChunk(events)]));
  assert.equal(file.notes.length, 2);
  assert.deepEqual(file.notes.map((n) => n.midi), [60, 62]);
  assert.deepEqual(file.notes.map((n) => [n.start, n.end]), [[0, 1], [1, 2]]);
});

test('tempo and time signature are reported; a note left open ends with its track', () => {
  const D = 240;
  const events = [
    ...varint(0), 0xff, 0x51, 0x03, ...uint(500000, 3), // 120 bpm
    ...varint(0), 0xff, 0x58, 0x04, 3, 2, 24, 8, //        3/4
    ...varint(0), 0xff, 0x03, 0x04, 0x4c, 0x65, 0x61, 0x64, // track name "Lead"
    ...varint(0), 0x90, 67, 80, //                          on, never turned off
    ...varint(D * 3), 0xb0, 0x07, 100, //                   a control change we skip
  ];
  const file = parseMidiFile(new Uint8Array([...header(1, 1, D), ...trackChunk(events)]));
  assert.equal(file.tempoBpm, 120);
  assert.equal(file.timeSignature, '3/4');
  assert.equal(file.tracks[0].name, 'Lead');
  assert.equal(file.notes.length, 1, 'a note with no note-off must not be lost');
  assert.equal(file.notes[0].end, 3, 'it ends where its track ends');
});

test('several tracks merge in time order, and channels are reported per track', () => {
  const D = 100;
  const one = [...varint(D), 0x90, 60, 100, ...varint(D), 0x80, 60, 0];
  const two = [...varint(0), 0x92, 48, 100, ...varint(D), 0x82, 48, 0]; // channel 3
  const file = parseMidiFile(new Uint8Array([
    ...header(1, 2, D), ...trackChunk(one), ...trackChunk(two),
  ]));
  assert.deepEqual(file.notes.map((n) => n.midi), [48, 60], 'merged in time order');
  assert.deepEqual(file.tracks[0].channels, [0]);
  assert.deepEqual(file.tracks[1].channels, [2]);
});

test('a chunk that is not a track is skipped and NAMED, not silently eaten', () => {
  const D = 480;
  const junk = chunk('XFIR', [1, 2, 3, 4]);
  const events = [...varint(0), 0x90, 60, 100, ...varint(D), 0x80, 60, 0];
  const file = parseMidiFile(new Uint8Array([...header(1, 2, D), ...junk, ...trackChunk(events)]));
  assert.equal(file.notes.length, 1);
  assert.equal(file.skipped.length, 1);
  assert.match(file.skipped[0], /XFIR/);
});

test('the two file kinds we refuse, we refuse with a reason a musician can act on', () => {
  const format2 = new Uint8Array([...header(2, 1, 480), ...trackChunk([])]);
  assert.throws(() => parseMidiFile(format2), /format 2/i);
  // SMPTE division: high bit set.
  const smpte = new Uint8Array([...header(0, 1, 0xe728), ...trackChunk([])]);
  assert.throws(() => parseMidiFile(smpte), /SMPTE|timecode/i);
  assert.throws(() => parseMidiFile(new Uint8Array([1, 2, 3, 4])), /not a MIDI file/i);
});

test('notesToBars quantises onto the caller\'s own grid, and says what it could not fit', () => {
  const notes = [
    { midi: 60, start: 0, end: 0.25, velocity: 0.8 },
    { midi: 62, start: 0.5, end: 0.75, velocity: 0.8 },
    { midi: 64, start: 4, end: 4.5, velocity: 0.8 }, // next bar in 4/4
    { midi: 67, start: 0.02, end: 0.2, velocity: 0.8 }, // same slot as the C: a chord
  ];
  const fitted = notesToBars(notes, { stepBeats: 0.25, slotsPerBar: 16, maxBars: 8 });
  assert.equal(fitted.bars.length, 2, 'four beats to a bar at sixteenths');
  assert.deepEqual(fitted.bars[0].map((s) => [s.slot, s.midi]), [[0, 67], [2, 62]],
    'a chord collapses to its highest note, in the slot it landed on');
  assert.equal(fitted.collapsed, 1, 'and says how many notes that dropped');
  assert.deepEqual(fitted.bars[1].map((s) => [s.slot, s.midi]), [[0, 64]]);
  assert.equal(fitted.written, 3);

  // The grid's resolution is the caller's: the same notes at quavers land on
  // half as many slots, which is the whole point of his ×2/÷2 ladder.
  const coarse = notesToBars(notes, { stepBeats: 0.5, slotsPerBar: 8, maxBars: 8 });
  assert.deepEqual(coarse.bars[0].map((s) => s.slot), [0, 1]);

  // Past the cap is reported, never truncated silently.
  const long = notesToBars([{ midi: 60, start: 0, end: 1 }, { midi: 62, start: 40, end: 41 }],
    { stepBeats: 0.25, slotsPerBar: 16, maxBars: 2 });
  assert.equal(long.written, 1);
  assert.equal(long.dropped, 1);

  // A gate carries the note's real length: a note held two slots is gate 2.
  const held = notesToBars([{ midi: 60, start: 0, end: 0.5 }], { stepBeats: 0.25, slotsPerBar: 16 });
  assert.equal(held.bars[0][0].gate, 2);
});

test('an empty file parses to nothing rather than throwing', () => {
  const file = parseMidiFile(new Uint8Array([...header(0, 1, 480), ...trackChunk([])]));
  assert.deepEqual(file.notes, []);
  const fitted = notesToBars(file.notes, {});
  assert.deepEqual(fitted.bars, []);
  assert.equal(fitted.written, 0);
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
