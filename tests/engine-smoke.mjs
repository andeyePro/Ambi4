/**
 * Smoke test for src/scripts/ambient-engine.js — run with:
 *   node tests/engine-smoke.mjs
 *
 * Covers the pure music logic (scale quantisation, phrase generation, chord
 * building, parameter clamping) and drives the full engine against a minimal
 * AudioContext mock to prove the scheduler runs and the transport is safe to
 * call repeatedly.
 */

import assert from 'node:assert/strict';

// --------------------------------------------------------------------------
// Minimal AudioContext mock — enough surface for the engine's node graph.
// --------------------------------------------------------------------------

let nodesCreated = 0;
let oscillatorsStarted = 0;

function makeParam(value) {
  return {
    value,
    setValueAtTime(v) { this.value = v; return this; },
    linearRampToValueAtTime(v) { this.value = v; return this; },
    exponentialRampToValueAtTime(v) {
      assert.ok(v > 0, 'exponential ramps must never target zero');
      this.value = v;
      return this;
    },
    setTargetAtTime(v) { this.value = v; return this; },
    cancelScheduledValues() { return this; },
  };
}

function makeNode(kind) {
  nodesCreated += 1;
  const node = {
    kind,
    gain: makeParam(1),
    frequency: makeParam(440),
    detune: makeParam(0),
    Q: makeParam(1),
    pan: makeParam(0),
    delayTime: makeParam(0.25),
    threshold: makeParam(-24),
    knee: makeParam(30),
    ratio: makeParam(12),
    attack: makeParam(0.003),
    release: makeParam(0.25),
    type: 'sine',
    normalize: true,
    buffer: null,
    connect() {},
    disconnect() {},
    start(t) {
      oscillatorsStarted += 1;
      assert.ok(Number.isFinite(t) && t >= 0, `osc.start time must be finite: ${t}`);
      this.startedAt = t;
    },
    stop(t) {
      assert.ok(Number.isFinite(t), `osc.stop time must be finite: ${t}`);
      assert.ok(t >= this.startedAt, 'osc.stop must not precede osc.start');
    },
  };
  return node;
}

class MockAudioContext {
  constructor() {
    this.currentTime = 0;
    this.sampleRate = 48000;
    this.state = 'running';
    this.destination = makeNode('destination');
  }

  createGain() { return makeNode('gain'); }
  createOscillator() { return makeNode('oscillator'); }
  createBiquadFilter() { return makeNode('biquad'); }
  createStereoPanner() { return makeNode('panner'); }
  createConvolver() { return makeNode('convolver'); }
  createDelay() { return makeNode('delay'); }
  createDynamicsCompressor() { return makeNode('compressor'); }

  createBuffer(channels, length, sampleRate) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return {
      numberOfChannels: channels,
      length,
      sampleRate,
      getChannelData: (i) => data[i],
    };
  }

  resume() { this.state = 'running'; return Promise.resolve(); }
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
}

globalThis.AudioContext = MockAudioContext;

const {
  createEngine,
  sanitiseParams,
  quantiseToScale,
  scaleDegreeToMidi,
  generatePhrase,
  generateProgression,
  nextChordDegree,
  buildChord,
  beatsPerBar,
  midiToFreq,
  pitchClass,
  isSupported,
  SCALES,
  TIME_SIGNATURES,
  DEFAULT_PARAMS,
} = await import('../src/scripts/ambient-engine.js');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// --------------------------------------------------------------------------
// Pure music logic
// --------------------------------------------------------------------------

test('midiToFreq / pitchClass', () => {
  assert.equal(Math.round(midiToFreq(69)), 440);
  assert.equal(Math.round(midiToFreq(60)), 262);
  assert.equal(pitchClass('C'), 0);
  assert.equal(pitchClass('Bb'), 10);
  assert.equal(pitchClass('a#'), 10);
  assert.equal(pitchClass('nonsense'), 0);
});

test('scaleDegreeToMidi wraps octaves in both directions', () => {
  const penta = SCALES.majorPentatonic;
  assert.equal(scaleDegreeToMidi(0, penta, 0, 4), 60);
  assert.equal(scaleDegreeToMidi(5, penta, 0, 4), 72);
  assert.equal(scaleDegreeToMidi(-5, penta, 0, 4), 48);
  assert.equal(scaleDegreeToMidi(0, penta, 7, 2), 43);
});

test('quantiseToScale snaps to the nearest scale tone and is idempotent', () => {
  const dorian = SCALES.dorian;
  for (let midi = 48; midi < 84; midi++) {
    const q = quantiseToScale(midi, dorian, 2);
    const pc = ((q - 2) % 12 + 12) % 12;
    assert.ok(dorian.includes(pc), `${midi} → ${q} is outside the scale`);
    assert.ok(Math.abs(q - midi) <= 2, `${midi} → ${q} moved too far`);
    assert.equal(quantiseToScale(q, dorian, 2), q, 'in-scale notes must not move');
  }
});

test('beatsPerBar matches the felt pulse of each metre', () => {
  assert.equal(beatsPerBar('3/4'), 3);
  assert.equal(beatsPerBar('4/4'), 4);
  assert.equal(beatsPerBar('5/4'), 5);
  assert.equal(beatsPerBar('6/8'), 3);    // two dotted-quarter pulses
  assert.equal(beatsPerBar('7/8'), 3.5);  // 2+2+3 eighths
  assert.equal(beatsPerBar('nope'), 4);
});

test('buildChord adds extensions as complexity rises', () => {
  assert.deepEqual(buildChord(0, 0), [0, 2, 4]);
  assert.deepEqual(buildChord(1, 0.5), [1, 3, 5, 7]);
  assert.deepEqual(buildChord(2, 1), [2, 4, 6, 8, 10]);
});

test('nextChordDegree stays in range and always moves', () => {
  let seed = 1;
  const rng = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (const mode of Object.keys(SCALES)) {
    const n = SCALES[mode].length;
    let degree = 0;
    for (let i = 0; i < 200; i++) {
      const next = nextChordDegree(degree, n, i / 200, rng);
      assert.ok(Number.isInteger(next) && next >= 0 && next < n, `${mode}: ${next}`);
      assert.notEqual(next, degree, 'a chord change must change chord');
      degree = next;
    }
  }
});

test('generateProgression returns four tonic-rooted degrees', () => {
  const prog = generateProgression(5, 0.5, () => 0.42);
  assert.equal(prog.length, 4);
  assert.equal(prog[0], 0);
  prog.forEach((d) => assert.ok(d >= 0 && d < 5));
});

test('generatePhrase density, placement and range', () => {
  let seed = 7;
  const rng = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
  for (const sig of Object.keys(TIME_SIGNATURES)) {
    const bpb = beatsPerBar(sig);
    for (const complexity of [0, 0.25, 0.5, 0.75, 1]) {
      for (const bars of [1, 2]) {
        const phrase = generatePhrase({
          beatsPerBar: bpb, bars, complexity, scaleLength: 5, rng,
        });
        assert.equal(phrase.bars, bars);
        assert.ok(phrase.notes.length >= bars, `${sig} @${complexity}: too few notes`);
        for (let b = 0; b < bars; b++) {
          const inBar = phrase.notes.filter((n) => n.bar === b);
          assert.ok(inBar.length >= 1 && inBar.length <= 6,
            `${sig} @${complexity}: ${inBar.length} notes in a bar`);
        }
        for (const note of phrase.notes) {
          assert.ok(note.beat >= 0 && note.beat < bpb, `beat ${note.beat} outside bar`);
          assert.ok(Number.isInteger(note.degree) && note.degree >= -2 && note.degree <= 10,
            `degree ${note.degree} out of range`);
          assert.ok(note.velocity > 0 && note.velocity <= 1);
          assert.ok(note.duration > 0);
        }
        // low complexity must not be denser than high complexity, on average
        const unique = new Set(phrase.notes.map((n) => `${n.bar}:${n.beat}`));
        assert.equal(unique.size, phrase.notes.length, 'two notes share one slot');
      }
    }
  }
});

test('generatePhrase density scales with complexity', () => {
  let seed = 11;
  const rng = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
  const count = (complexity) => {
    let total = 0;
    for (let i = 0; i < 50; i++) {
      total += generatePhrase({ beatsPerBar: 4, bars: 1, complexity, rng }).notes.length;
    }
    return total / 50;
  };
  const sparse = count(0);
  const dense = count(1);
  assert.ok(sparse < 2, `sparse average ${sparse}`);
  assert.ok(dense > 4, `dense average ${dense}`);
});

// --------------------------------------------------------------------------
// Parameter validation
// --------------------------------------------------------------------------

test('sanitiseParams clamps, validates and ignores unknown keys', () => {
  assert.deepEqual(sanitiseParams(), { ...DEFAULT_PARAMS });
  assert.deepEqual(sanitiseParams(null), { ...DEFAULT_PARAMS });

  const clamped = sanitiseParams({
    speed: 99, complexity: -3, repetition: 4, bpm: 5, voices: 9, volume: 12,
  });
  assert.equal(clamped.speed, 2);
  assert.equal(clamped.complexity, 0);
  assert.equal(clamped.repetition, 1);
  assert.equal(clamped.bpm, 40);
  assert.equal(clamped.voices, 4);
  assert.equal(clamped.volume, 1);

  const low = sanitiseParams({ speed: 0, bpm: 999, voices: 0 });
  assert.equal(low.speed, 0.25);
  assert.equal(low.bpm, 120);
  assert.equal(low.voices, 1);

  assert.equal(sanitiseParams({ voices: 2.6 }).voices, 3);
  assert.equal(sanitiseParams({ speed: 'oops' }).speed, DEFAULT_PARAMS.speed);
  assert.equal(sanitiseParams({ speed: NaN }).speed, DEFAULT_PARAMS.speed);
  assert.equal(sanitiseParams({ mode: 'klingon' }).mode, DEFAULT_PARAMS.mode);
  assert.equal(sanitiseParams({ mode: 'lydian' }).mode, 'lydian');
  assert.equal(sanitiseParams({ timeSignature: '11/16' }).timeSignature, '4/4');
  assert.equal(sanitiseParams({ timeSignature: '7/8' }).timeSignature, '7/8');
  assert.equal(sanitiseParams({ root: 'Eb' }).root, 'D#');
  assert.equal(sanitiseParams({ root: 'H' }).root, 'C');
  assert.equal(sanitiseParams({ nonsense: true }).nonsense, undefined);

  const merged = sanitiseParams({ bpm: 90 }, sanitiseParams({ mode: 'aeolian' }));
  assert.equal(merged.bpm, 90);
  assert.equal(merged.mode, 'aeolian');
});

// --------------------------------------------------------------------------
// Engine lifecycle against the mock
// --------------------------------------------------------------------------

test('engine exposes the documented API and defaults', () => {
  const engine = createEngine();
  assert.equal(typeof engine.start, 'function');
  assert.equal(typeof engine.stop, 'function');
  assert.equal(typeof engine.setParams, 'function');
  assert.equal(typeof engine.getParams, 'function');
  assert.equal(engine.running, false);
  assert.deepEqual(engine.getParams(), { ...DEFAULT_PARAMS });

  engine.setParams({ bpm: 200, mode: 'dorian', bogus: 1 });
  assert.equal(engine.getParams().bpm, 120);
  assert.equal(engine.getParams().mode, 'dorian');
  assert.equal('bogus' in engine.getParams(), false);

  // getParams must hand back a copy, not the live object
  const snapshot = engine.getParams();
  snapshot.bpm = 41;
  assert.equal(engine.getParams().bpm, 120);

  engine.stop(); // safe before start
  assert.equal(engine.running, false);
  assert.ok(isSupported());
});

test('engine schedules audio across every mode and metre', async () => {
  const engine = createEngine({ bpm: 120, speed: 2, complexity: 0.9, voices: 4 });
  await engine.start();
  assert.equal(engine.running, true);
  const nodesAtStart = nodesCreated;
  const oscsAtStart = oscillatorsStarted;

  // Drive the mock clock forward the way the browser's audio clock would,
  // letting the real setInterval scheduler run against it.
  for (const sig of Object.keys(TIME_SIGNATURES)) {
    for (const mode of Object.keys(SCALES)) {
      engine.setParams({ timeSignature: sig, mode, root: 'F#' });
      await advance(0.5);
    }
  }
  assert.ok(nodesCreated > nodesAtStart, 'no audio nodes were created');
  assert.ok(oscillatorsStarted > oscsAtStart, 'no oscillators were started');

  await engine.start(); // repeat start is a no-op
  assert.equal(engine.running, true);

  engine.stop();
  assert.equal(engine.running, false);
  engine.stop(); // repeat stop is safe
  const afterStop = oscillatorsStarted;
  await advance(0.5);
  assert.equal(oscillatorsStarted, afterStop, 'scheduler kept running after stop');

  await engine.start(); // restart after stop
  assert.equal(engine.running, true);
  await advance(0.3);
  engine.stop();
});

test('engine survives extreme parameter combinations', async () => {
  const engine = createEngine();
  await engine.start();
  const combos = [
    { bpm: 40, speed: 0.25, complexity: 0, repetition: 1, voices: 1, volume: 0 },
    { bpm: 120, speed: 2, complexity: 1, repetition: 0, voices: 4, volume: 1 },
    { bpm: 60, speed: 1, complexity: 0.5, repetition: 0.5, voices: 2, volume: 0.5 },
    { bpm: 95, speed: 1.7, complexity: 0.8, repetition: 0.2, voices: 3, timeSignature: '5/4' },
  ];
  for (const combo of combos) {
    engine.setParams(combo);
    await advance(0.8);
  }
  engine.stop();
});

// --------------------------------------------------------------------------
// Runner
// --------------------------------------------------------------------------

/**
 * Advance every live mock clock by `seconds` in small steps, yielding to the
 * event loop so the engine's setInterval scheduler gets to run.
 */
async function advance(seconds) {
  const steps = Math.ceil(seconds / 0.08);
  for (let i = 0; i < steps; i++) {
    for (const ctx of liveContexts) ctx.currentTime += 0.08;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

const liveContexts = [];
const RealCtx = MockAudioContext;
globalThis.AudioContext = class extends RealCtx {
  constructor() {
    super();
    liveContexts.push(this);
  }
};

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
