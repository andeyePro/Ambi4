/**
 * Every voice schedules each AudioParam's events in time order — run with:
 *   node tests/automation-order-smoke.mjs
 *
 * Web Audio keeps one timeline per AudioParam, sorted by time. A ramp is
 * drawn from the event BEFORE it, so code that schedules a ramp ending at
 * 3.17 s and then a setTargetAtTime starting at 2.75 s on the same param
 * has not written "open the filter, then let it fall": it has written a
 * timeline where the fall starts first and the ramp is measured from the fall.
 * What that sounds like is up to the implementation. Found 2026-10-23 by
 * rendering Warm on a second Web Audio engine (node-web-audio-api): the pad's
 * opening sweep ended at attack x 1.3 while its release target began at
 * attack + hold, so any note shorter than 1.3 x its attack (a one-bar chord at
 * 60-90 bpm is) put the two out of order — and that engine rendered the pad as
 * exact silence for three seconds, then a step. Chrome draws the same
 * timeline differently; neither is the sweep the code describes.
 *
 * The law, checked for every voice in the library, as shipped and under its
 * own published patch, at note lengths from a tick to a long pad, on every
 * kind of drum: an event never starts before an earlier-scheduled event on
 * the same param has finished. cancelScheduledValues(t) clears the timeline
 * from t, as it does in the API.
 */

import assert from 'node:assert/strict';

const timelines = [];

function makeParam(owner, name, value) {
  const line = { owner, name, end: -Infinity, events: [], bad: [] };
  timelines.push(line);
  const push = (kind, start, end) => {
    if (start < line.end - 1e-9) line.bad.push({ kind, start, previousEnd: line.end, last: line.events.at(-1) });
    line.events.push({ kind, start, end });
    line.end = Math.max(line.end, end);
  };
  return {
    value,
    defaultValue: value,
    setValueAtTime(v, t) { push('setValue', t, t); this.value = v; return this; },
    linearRampToValueAtTime(v, t) { push('linearRamp', line.end === -Infinity ? 0 : line.end, t); return this; },
    exponentialRampToValueAtTime(v, t) { push('exponentialRamp', line.end === -Infinity ? 0 : line.end, t); return this; },
    setTargetAtTime(v, t) { push('setTarget', t, t); return this; },
    setValueCurveAtTime(curve, t, d) { push('setValueCurve', t, t + d); return this; },
    cancelScheduledValues(t) {
      line.events = line.events.filter((e) => e.start < t);
      line.end = line.events.reduce((m, e) => Math.max(m, Math.min(e.end, t)), -Infinity);
      return this;
    },
    cancelAndHoldAtTime(t) { return this.cancelScheduledValues(t); },
  };
}

function makeNode(ctx, kind) {
  const node = {
    kind,
    context: ctx,
    type: 'sine',
    buffer: null,
    curve: null,
    loop: false,
    oversample: 'none',
    normalize: true,
    connect(target) { return target; },
    disconnect() {},
    start() {},
    stop() {},
    setPeriodicWave() {},
    addEventListener() {},
    removeEventListener() {},
    set onended(fn) {},
  };
  for (const [p, v] of [['gain', 1], ['frequency', 440], ['detune', 0], ['Q', 1], ['pan', 0], ['delayTime', 0], ['playbackRate', 1], ['offset', 1], ['threshold', -24], ['knee', 30], ['ratio', 12], ['attack', 0.003], ['release', 0.25]]) {
    node[p] = makeParam(kind, p, v);
  }
  return node;
}

class MockAudioContext {
  constructor() {
    this.currentTime = 0;
    this.sampleRate = 48000;
    this.state = 'running';
    this.destination = makeNode(this, 'destination');
  }
  createGain() { return makeNode(this, 'gain'); }
  createOscillator() { return makeNode(this, 'oscillator'); }
  createBiquadFilter() { return makeNode(this, 'biquad'); }
  createStereoPanner() { return makeNode(this, 'panner'); }
  createConvolver() { return makeNode(this, 'convolver'); }
  createDelay() { return makeNode(this, 'delay'); }
  createDynamicsCompressor() { return makeNode(this, 'compressor'); }
  createBufferSource() { return makeNode(this, 'buffersource'); }
  createConstantSource() { return makeNode(this, 'constantsource'); }
  createWaveShaper() { return makeNode(this, 'waveshaper'); }
  createChannelMerger() { return makeNode(this, 'merger'); }
  createChannelSplitter() { return makeNode(this, 'splitter'); }
  createPeriodicWave() { return { kind: 'periodicwave' }; }
  createBuffer(channels, length, sampleRate) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { numberOfChannels: channels, length, sampleRate, duration: length / sampleRate, getChannelData: (i) => data[i] };
  }
}

const { VOICES } = await import('../src/scripts/engine-voices.js');

// Seeded, so a failure names the same note every run.
let seed = 0x0a17;
const realRandom = Math.random;
Math.random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);

const DURATIONS = [0.08, 0.25, 0.6, 1.2, 2.7, 4, 8];
const failures = [];
let notes = 0;
for (const [set, voices] of Object.entries(VOICES)) {
  for (const [id, voice] of Object.entries(voices)) {
    const kinds = set === 'percussion' ? ['low', 'mid', 'high'] : [undefined];
    for (const patch of [null, voice.defaults]) {
      for (const duration of DURATIONS) {
        for (const kind of kinds) {
          timelines.length = 0;
          const ctx = new MockAudioContext();
          const note = { when: 0.05, freq: 220, midi: 57, velocity: 0.9, duration, ...(kind ? { kind } : {}) };
          try {
            voice.play(ctx, ctx.destination, note, patch ? JSON.parse(JSON.stringify(patch)) : null);
          } catch (error) {
            failures.push(`${set}/${id}${kind ? `:${kind}` : ''} ${duration}s: play threw ${error.message}`);
            continue;
          }
          notes += 1;
          for (const line of timelines) {
            for (const b of line.bad) {
              failures.push(`${set}/${id}${kind ? `:${kind}` : ''} (${patch ? 'patched' : 'as shipped'}) ${duration}s: ${line.owner}.${line.name} ${b.kind} at ${b.start.toFixed(3)} s before the previous event ends at ${b.previousEnd.toFixed(3)} s (${b.last ? b.last.kind : '?'})`);
            }
          }
        }
      }
    }
  }
}
Math.random = realRandom;

// MUTATION: the law must see the Warm defect it was written for.
{
  timelines.length = 0;
  const p = makeParam('biquad', 'frequency', 440);
  p.setValueAtTime(330, 0.05);
  p.exponentialRampToValueAtTime(1474, 3.17);
  p.setTargetAtTime(663, 2.75, 2);
  assert.equal(timelines[0].bad.length, 1, 'the order law did not see a target scheduled inside a ramp');
}

const unique = [...new Set(failures.map((f) => f.replace(/ \d+(\.\d+)?s:/, ':')))];
if (failures.length) {
  console.error(`automation-order FAILED — ${failures.length} out-of-order events (${unique.length} distinct), ${notes} notes played:`);
  for (const f of failures.slice(0, 40)) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`automation-order ok — ${notes} notes, every param's events in time order`);
