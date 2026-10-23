/**
 * Smoke test for src/scripts/wav-export.js and src/scripts/wav-capture.js —
 * run with:
 *   node tests/wav-export-smoke.mjs
 *
 * Save as WAV is a real-time tap on the engine's output analyser, encoded to
 * 16-bit PCM here. The encoder is pure arithmetic, so every byte of the file
 * is provable in Node: the RIFF/fmt/data header field by field, the length,
 * the little-endian sample bytes, the clamp at and beyond ±1, and a round
 * trip through an independent-enough parser that walks chunks rather than
 * trusting offset 44. The tap is proved against a fake ScriptProcessor
 * context: a mono source still makes a stereo file, the cap stops it, and a
 * page with nothing to tap gets words rather than a throw. That a real
 * browser's AudioWorklet delivers the same samples is a browser proof.
 */

import assert from 'node:assert/strict';
import {
  WAV_HEADER_BYTES, floatToInt16, wavHeader, interleaveInt16, createWavWriter,
  encodeWav, parseWav, wavFileName,
} from '../src/scripts/wav-export.js';
import { wavCaptureProblem, startWavCapture } from '../src/scripts/wav-capture.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const ascii = (bytes, at) => String.fromCharCode(...bytes.subarray(at, at + 4));

test('the header carries every RIFF/fmt/data field, little-endian (stereo)', () => {
  const h = wavHeader({ sampleRate: 48000, channelCount: 2, frames: 1000 });
  const v = new DataView(h.buffer);
  assert.equal(h.length, 44);
  assert.equal(ascii(h, 0), 'RIFF');
  assert.equal(v.getUint32(4, true), 36 + 4000);
  assert.equal(ascii(h, 8), 'WAVE');
  assert.equal(ascii(h, 12), 'fmt ');
  assert.equal(v.getUint32(16, true), 16);
  assert.equal(v.getUint16(20, true), 1, 'integer PCM');
  assert.equal(v.getUint16(22, true), 2);
  assert.equal(v.getUint32(24, true), 48000);
  assert.equal(v.getUint32(28, true), 48000 * 4, 'byte rate');
  assert.equal(v.getUint16(32, true), 4, 'block align');
  assert.equal(v.getUint16(34, true), 16);
  assert.equal(ascii(h, 36), 'data');
  assert.equal(v.getUint32(40, true), 4000);
  // The bytes themselves, not just a DataView that agrees with itself.
  assert.deepEqual([...h.subarray(24, 28)], [0x80, 0xbb, 0x00, 0x00], '48000 little-endian');
});

test('the header is right for mono at 44.1 kHz too', () => {
  const v = new DataView(wavHeader({ sampleRate: 44100, channelCount: 1, frames: 7 }).buffer);
  assert.equal(v.getUint16(22, true), 1);
  assert.equal(v.getUint32(24, true), 44100);
  assert.equal(v.getUint32(28, true), 88200);
  assert.equal(v.getUint16(32, true), 2);
  assert.equal(v.getUint32(40, true), 14);
  assert.equal(v.getUint32(4, true), 50);
});

test('a bad format is refused, not written', () => {
  assert.throws(() => wavHeader({ sampleRate: 44100.5, channelCount: 2, frames: 1 }), RangeError);
  assert.throws(() => wavHeader({ sampleRate: 48000, channelCount: 0, frames: 1 }), RangeError);
  assert.throws(() => wavHeader({ sampleRate: 48000, channelCount: 2, frames: 2 ** 31 }), RangeError, 'over 4 GB');
});

test('sample conversion: 0, ±1, ±0.5, beyond range, NaN', () => {
  assert.equal(floatToInt16(0), 0);
  assert.equal(floatToInt16(1), 32767);
  assert.equal(floatToInt16(-1), -32768);
  assert.equal(floatToInt16(0.5), 16384);
  assert.equal(floatToInt16(-0.5), -16384);
  assert.equal(floatToInt16(1.0001), 32767, 'clamped, not wrapped');
  assert.equal(floatToInt16(7), 32767);
  assert.equal(floatToInt16(-3), -32768);
  assert.equal(floatToInt16(Infinity), 32767);
  assert.equal(floatToInt16(-Infinity), -32768);
  assert.equal(floatToInt16(NaN), 0, 'NaN is silence');
});

test('interleaving writes L R L R as little-endian bytes', () => {
  const bytes = interleaveInt16([Float32Array.of(1, 0), Float32Array.of(-1, 2)]);
  assert.deepEqual([...bytes], [0xff, 0x7f, 0x00, 0x80, 0x00, 0x00, 0xff, 0x7f]);
});

test('a whole file is header plus frames × channels × 2 bytes', () => {
  const n = 1234;
  const stereo = encodeWav({ sampleRate: 48000, channels: [new Float32Array(n), new Float32Array(n)] });
  assert.equal(stereo.length, WAV_HEADER_BYTES + n * 4);
  const mono = encodeWav({ sampleRate: 22050, channels: [new Float32Array(n)] });
  assert.equal(mono.length, WAV_HEADER_BYTES + n * 2);
  const empty = encodeWav({ sampleRate: 48000, channels: [new Float32Array(0), new Float32Array(0)] });
  assert.equal(empty.length, 44);
  assert.equal(new DataView(empty.buffer).getUint32(40, true), 0);
});

test('round trip: what goes in comes back within two 16-bit steps (positive full scale is 32767, read back over 32768)', () => {
  const n = 4800;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    L[i] = 0.8 * Math.sin((2 * Math.PI * 440 * i) / 48000);
    R[i] = 1.5 * Math.sin((2 * Math.PI * 220 * i) / 48000); // over full scale: must clamp
  }
  const back = parseWav(encodeWav({ sampleRate: 48000, channels: [L, R] }));
  assert.equal(back.sampleRate, 48000);
  assert.equal(back.channelCount, 2);
  assert.equal(back.bitsPerSample, 16);
  assert.equal(back.frames, n);
  for (let i = 0; i < n; i++) {
    assert.ok(Math.abs(back.channels[0][i] - L[i]) <= 2 / 32768, `L[${i}]`);
    const want = Math.max(-1, Math.min(1, R[i]));
    assert.ok(Math.abs(back.channels[1][i] - want) <= 2 / 32768, `R[${i}] ${back.channels[1][i]} vs ${want}`);
  }
});

test('the writer in chunks makes the same bytes as one call, and stops at its cap', () => {
  const n = 1000;
  const L = Float32Array.from({ length: n }, (_, i) => Math.sin(i / 7));
  const R = Float32Array.from({ length: n }, (_, i) => Math.cos(i / 5));
  const whole = encodeWav({ sampleRate: 48000, channels: [L, R] });
  const w = createWavWriter({ sampleRate: 48000, channelCount: 2 });
  for (let at = 0; at < n; at += 128) w.push([L.subarray(at, at + 128), R.subarray(at, at + 128)]);
  const { parts, byteLength, frames } = w.finish();
  const joined = new Uint8Array(byteLength);
  let o = 0;
  for (const p of parts) { joined.set(p, o); o += p.length; }
  assert.equal(frames, n);
  assert.deepEqual(joined, whole);

  const capped = createWavWriter({ sampleRate: 48000, channelCount: 2, maxFrames: 300 });
  assert.equal(capped.push([L.subarray(0, 256), R.subarray(0, 256)]), 256);
  assert.equal(capped.full, false);
  assert.equal(capped.push([L.subarray(256, 512), R.subarray(256, 512)]), 44, 'only the room left');
  assert.equal(capped.full, true);
  assert.equal(capped.push([L.subarray(512, 768), R.subarray(512, 768)]), 0);
  assert.equal(capped.finish().byteLength, 44 + 300 * 4);
  assert.throws(() => capped.push([L]), RangeError, 'a mono chunk into a stereo file');
});

test('the parser walks chunks, so an extra chunk before data still reads', () => {
  const plain = encodeWav({ sampleRate: 8000, channels: [Float32Array.of(0.25, -0.25)] });
  const list = new Uint8Array([0x4c, 0x49, 0x53, 0x54, 3, 0, 0, 0, 1, 2, 3, 0]); // "LIST", odd size + pad
  const withList = new Uint8Array(plain.length + list.length);
  withList.set(plain.subarray(0, 36));
  withList.set(list, 36);
  withList.set(plain.subarray(36), 36 + list.length);
  const back = parseWav(withList);
  assert.equal(back.frames, 2);
  assert.equal(back.channels[0][0], 8192 / 32768);
  assert.throws(() => parseWav(new Uint8Array(12)), /not a RIFF/);
});

test('the file name is sortable and has no colons', () => {
  assert.equal(wavFileName(new Date('2026-10-23T14:05:09.123Z')), 'ambi4-2026-10-23T14-05-09.wav');
});

// ---- the tap -------------------------------------------------------------

function fakeContext({ state = 'running', sampleRate = 48000, scriptProcessor = true } = {}) {
  const ctx = {
    state, sampleRate,
    destination: { name: 'destination' },
    processors: [],
    createGain() {
      return { gain: { value: 1 }, connections: [], connect(n) { this.connections.push(n); }, disconnect() { this.connections = []; } };
    },
  };
  if (scriptProcessor) {
    ctx.createScriptProcessor = (size, inputs, outputs) => {
      const p = { size, inputs, outputs, onaudioprocess: null, connections: [], connect(n) { this.connections.push(n); }, disconnect() { this.connections = []; } };
      ctx.processors.push(p);
      return p;
    };
  }
  const node = { context: ctx, connections: [], connect(n) { this.connections.push(n); }, disconnect(n) { this.connections = this.connections.filter((c) => c !== n); } };
  return { ctx, node };
}

const bufferOf = (...channels) => ({ numberOfChannels: channels.length, getChannelData: (c) => channels[c] });

test('with nothing to tap, the page gets words, not a throw', async () => {
  const none = {};
  assert.match(wavCaptureProblem(null, none), /neither AudioWorklet nor ScriptProcessor/);
  assert.match(wavCaptureProblem(null, { ScriptProcessorNode: function () {} }), /Press Play first/);
  const { node } = fakeContext({ scriptProcessor: false });
  assert.match(wavCaptureProblem(node, none), /neither AudioWorklet nor ScriptProcessor/);
  const paused = fakeContext({ state: 'suspended' });
  assert.match(wavCaptureProblem(paused.node, none), /Press Play first/);
  assert.equal(wavCaptureProblem(fakeContext().node, none), null);
  await assert.rejects(startWavCapture(null, { g: none }), /neither AudioWorklet/);
});

test('the ScriptProcessor tap: mono in makes stereo out, the cap fires once, stop unhooks', async () => {
  const { ctx, node } = fakeContext({ sampleRate: 1000 });
  let full = 0;
  let last = 0;
  const cap = await startWavCapture(node, { maxSeconds: 0.5, g: {}, onFull: () => { full += 1; }, onProgress: (s) => { last = s; } });
  assert.equal(cap.mode, 'script-processor');
  const proc = ctx.processors[0];
  assert.ok(node.connections.includes(proc), 'the analyser feeds the tap');
  assert.equal(proc.connections[0].gain.value, 0, 'the tap reaches the destination only through silence');
  assert.equal(proc.connections[0].connections[0], ctx.destination);
  proc.onaudioprocess({ inputBuffer: bufferOf(new Float32Array(300).fill(0.5)) });
  assert.equal(last, 0.3);
  proc.onaudioprocess({ inputBuffer: bufferOf(new Float32Array(300).fill(-0.5), new Float32Array(300).fill(0.25)) });
  proc.onaudioprocess({ inputBuffer: bufferOf(new Float32Array(300)) });
  assert.equal(full, 1, 'onFull once');
  const done = await cap.stop();
  assert.equal(done.frames, 500);
  assert.equal(await cap.stop(), done, 'stop twice is one stop');
  assert.ok(!node.connections.includes(proc), 'unhooked');
  assert.equal(proc.onaudioprocess, null);
  const joined = new Uint8Array(done.byteLength);
  let o = 0;
  for (const p of done.parts) { joined.set(p, o); o += p.length; }
  const back = parseWav(joined);
  assert.equal(back.channelCount, 2);
  assert.equal(back.sampleRate, 1000);
  assert.equal(back.channels[1][0], back.channels[0][0], 'mono upmixed to both sides');
  assert.equal(back.channels[0][300], -16384 / 32768);
  assert.equal(back.channels[1][300], floatToInt16(0.25) / 32768);
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
