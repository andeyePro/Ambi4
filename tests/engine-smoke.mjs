/**
 * Smoke test for src/scripts/ambient-engine.js — run with:
 *   node tests/engine-smoke.mjs
 *
 * Covers the pure music logic (scale quantisation, phrase generation, chord
 * building, structure sequencing, arp and percussion generators, parameter
 * validation) and drives the full engine against a minimal AudioContext mock to
 * prove the scheduler runs, the events fire and the transport is safe to call
 * repeatedly.
 *
 * The engine loads src/scripts/engine-voices.js with a dynamic import inside
 * start(), falling back to its own sine voices when that module is missing, so
 * this suite passes whether or not the voice library exists yet. Assertions
 * about what the engine plays therefore look at 'note' events rather than at
 * oscillator counts, which belong to whichever voice set happened to load.
 */

import assert from 'node:assert/strict';

// --------------------------------------------------------------------------
// Minimal AudioContext mock — enough surface for the engine's node graph and
// for a voice library's own nodes.
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
    setValueCurveAtTime() { return this; },
    cancelScheduledValues() { return this; },
    cancelAndHoldAtTime() { return this; },
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
    playbackRate: makeParam(1),
    offset: makeParam(1),
    threshold: makeParam(-24),
    knee: makeParam(30),
    ratio: makeParam(12),
    attack: makeParam(0.003),
    release: makeParam(0.25),
    type: 'sine',
    normalize: true,
    loop: false,
    buffer: null,
    curve: null,
    oversample: 'none',
    fftSize: 2048,
    smoothingTimeConstant: 0.8,
    get frequencyBinCount() { return this.fftSize / 2; },
    getByteTimeDomainData(array) { array.fill(128); },
    getByteFrequencyData(array) { array.fill(0); },
    getFloatTimeDomainData(array) { array.fill(0); },
    setPeriodicWave() {},
    connect() {},
    disconnect() {},
    start(t = 0) {
      oscillatorsStarted += 1;
      assert.ok(Number.isFinite(t) && t >= 0, `osc.start time must be finite: ${t}`);
      this.startedAt = t;
    },
    stop(t = 0) {
      assert.ok(Number.isFinite(t), `osc.stop time must be finite: ${t}`);
      if (typeof this.startedAt === 'number') {
        assert.ok(t >= this.startedAt, 'osc.stop must not precede osc.start');
      }
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
  createPanner() { return makeNode('panner3d'); }
  createConvolver() { return makeNode('convolver'); }
  createDelay() { return makeNode('delay'); }
  createDynamicsCompressor() { return makeNode('compressor'); }
  createAnalyser() { return makeNode('analyser'); }
  createBufferSource() { return makeNode('buffersource'); }
  createConstantSource() { return makeNode('constantsource'); }
  createWaveShaper() { return makeNode('waveshaper'); }
  createChannelMerger() { return makeNode('merger'); }
  createChannelSplitter() { return makeNode('splitter'); }
  createPeriodicWave() { return { kind: 'periodicwave' }; }

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
  generatePercussionPattern,
  nextChordDegree,
  buildChord,
  buildArpSequence,
  autoArpSettings,
  autoActiveTracks,
  resolveStructure,
  sectionAtBar,
  beatsPerBar,
  midiToFreq,
  pitchClass,
  isSupported,
  FALLBACK_VOICES,
  SCALES,
  TIME_SIGNATURES,
  TRACK_ORDER,
  ARP_RATES,
  ARP_PATTERNS,
  DEFAULT_PARAMS,
} = await import('../src/scripts/ambient-engine.js');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const seededRng = (seed) => () => ((seed = (seed * 48271) % 2147483647) / 2147483647);

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
  const rng = seededRng(7);
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
  const rng = seededRng(11);
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
// Song structure
// --------------------------------------------------------------------------

test('resolveStructure maps complexity in auto and degrades empty custom', () => {
  assert.equal(resolveStructure('auto', 0), 'drone');
  assert.equal(resolveStructure('auto', 0.32), 'drone');
  assert.equal(resolveStructure('auto', 0.33), 'waves');
  assert.equal(resolveStructure('auto', 0.54), 'waves');
  assert.equal(resolveStructure('auto', 0.55), 'abab');
  assert.equal(resolveStructure('auto', 0.74), 'abab');
  assert.equal(resolveStructure('auto', 0.75), 'journey');
  assert.equal(resolveStructure('auto', 1), 'journey');

  assert.equal(resolveStructure('drone', 1), 'drone');
  assert.equal(resolveStructure('journey', 0), 'journey');
  assert.equal(resolveStructure('nonsense', 0.6), 'abab');
  assert.equal(resolveStructure(undefined, 0.2), 'drone');

  assert.equal(resolveStructure('custom', 0.9, []), 'journey');
  assert.equal(resolveStructure('custom', 0.1, null), 'drone');
  assert.equal(resolveStructure('custom', 0.1, [{ label: 'A', bars: 4, intensity: 0.5 }]), 'custom');
});

test('sectionAtBar sequences every preset', () => {
  // drone — one section, never changes
  for (const b of [0, 1, 7, 99]) {
    assert.deepEqual(sectionAtBar('drone', b), { label: 'A', intensity: 0.35 });
  }

  // waves — 16-bar sine between 0.25 and 0.75
  const wave = [];
  for (let b = 0; b < 32; b++) wave.push(sectionAtBar('waves', b).intensity);
  assert.equal(Math.min(...wave), 0.25);
  assert.equal(Math.max(...wave), 0.75);
  assert.equal(wave[0], 0.25);
  assert.equal(wave[8], 0.75);
  for (let b = 0; b < 16; b++) assert.equal(wave[b], wave[b + 16], 'waves must repeat every 16 bars');

  // build — 32-bar rise to 0.85, 8-bar release to 0.3, then repeat
  assert.deepEqual(sectionAtBar('build', 0), { label: 'A', intensity: 0.2 });
  assert.equal(sectionAtBar('build', 31).intensity, 0.85);
  for (let b = 1; b < 32; b++) {
    assert.ok(sectionAtBar('build', b).intensity >= sectionAtBar('build', b - 1).intensity,
      `build must not dip at bar ${b}`);
  }
  assert.equal(sectionAtBar('build', 32).label, 'B');
  assert.equal(sectionAtBar('build', 39).intensity, 0.3);
  assert.deepEqual(sectionAtBar('build', 40), sectionAtBar('build', 0));

  // abab — 8 bars each, alternating
  for (let b = 0; b < 8; b++) assert.deepEqual(sectionAtBar('abab', b), { label: 'A', intensity: 0.4 });
  for (let b = 8; b < 16; b++) assert.deepEqual(sectionAtBar('abab', b), { label: 'B', intensity: 0.7 });
  assert.deepEqual(sectionAtBar('abab', 16), sectionAtBar('abab', 0));

  // journey — six 8-bar blocks, looping
  const journey = [0, 8, 16, 24, 32, 40].map((b) => sectionAtBar('journey', b));
  assert.deepEqual(journey.map((s) => s.label), ['A', 'A', 'B', 'A', 'C', 'B']);
  assert.deepEqual(journey.map((s) => s.intensity), [0.35, 0.45, 0.65, 0.45, 0.8, 0.6]);
  assert.deepEqual(sectionAtBar('journey', 48), sectionAtBar('journey', 0));
  assert.deepEqual(sectionAtBar('journey', 7), sectionAtBar('journey', 0));

  // custom — honours the block list and loops
  const blocks = [
    { label: 'A', bars: 2, intensity: 0.2 },
    { label: 'C', bars: 3, intensity: 0.9 },
  ];
  const labels = [];
  for (let b = 0; b < 10; b++) labels.push(sectionAtBar('custom', b, blocks).label);
  assert.deepEqual(labels, ['A', 'A', 'C', 'C', 'C', 'A', 'A', 'C', 'C', 'C']);
  assert.equal(sectionAtBar('custom', 4, blocks).intensity, 0.9);
  assert.deepEqual(sectionAtBar('custom', 0, []), { label: 'A', intensity: 0.35 });
});

test('autoActiveTracks activates in track order, arp and percussion last', () => {
  assert.deepEqual(autoActiveTracks(0, 0), ['pad']);
  assert.deepEqual(autoActiveTracks(1, 1), [...TRACK_ORDER]);

  let previous = 0;
  for (let intensity = 0; intensity <= 1.0001; intensity += 0.05) {
    for (let complexity = 0; complexity <= 1.0001; complexity += 0.05) {
      const active = autoActiveTracks(intensity, complexity);
      // always a prefix of the fixed order
      assert.deepEqual(active, TRACK_ORDER.slice(0, active.length),
        `not a prefix at ${intensity}/${complexity}: ${active}`);
      assert.ok(active.includes('pad'), 'pad is always available to auto');
      if (active.includes('percussion')) assert.ok(active.includes('arp'));
      if (active.includes('arp')) assert.ok(active.includes('texture'));
    }
  }
  // monotone in energy
  for (const c of [0, 0.25, 0.5, 0.75, 1]) {
    previous = 0;
    for (let i = 0; i <= 1.0001; i += 0.1) {
      const n = autoActiveTracks(i, c).length;
      assert.ok(n >= previous, `track count dropped as intensity rose (complexity ${c})`);
      previous = n;
    }
  }
});

// --------------------------------------------------------------------------
// Arpeggiator + percussion generators
// --------------------------------------------------------------------------

test('autoArpSettings gets slower, narrower and sparser as complexity falls', () => {
  const speedOrder = ['1/4', '1/8', '1/8T', '1/16'];
  let lastRate = -1;
  let lastOctaves = 0;
  let lastDensity = -1;
  for (let c = 0; c <= 1.0001; c += 0.05) {
    const cfg = autoArpSettings(c);
    assert.ok(ARP_PATTERNS.includes(cfg.pattern));
    assert.ok(cfg.rate in ARP_RATES);
    assert.ok(cfg.octaves >= 1 && cfg.octaves <= 3);
    assert.ok(cfg.density > 0 && cfg.density <= 1);
    const rateIndex = speedOrder.indexOf(cfg.rate);
    assert.ok(rateIndex >= lastRate, `rate slowed down at complexity ${c}`);
    assert.ok(cfg.octaves >= lastOctaves, `octaves narrowed at complexity ${c}`);
    assert.ok(cfg.density >= lastDensity, `density thinned at complexity ${c}`);
    lastRate = rateIndex;
    lastOctaves = cfg.octaves;
    lastDensity = cfg.density;
  }
  assert.equal(autoArpSettings(0).rate, '1/4');
  assert.equal(autoArpSettings(0).octaves, 1);
  assert.equal(autoArpSettings(1).rate, '1/16');
  assert.equal(autoArpSettings(1).octaves, 3);
  assert.equal(autoArpSettings(1).pattern, 'random');
});

test('buildArpSequence covers every pattern and octave span', () => {
  const chord = [60, 64, 67];
  assert.deepEqual(buildArpSequence(chord, 'up', 1), [60, 64, 67]);
  assert.deepEqual(buildArpSequence(chord, 'up', 2), [60, 64, 67, 72, 76, 79]);
  assert.deepEqual(buildArpSequence(chord, 'down', 2), [79, 76, 72, 67, 64, 60]);

  const updown = buildArpSequence(chord, 'updown', 2);
  assert.equal(updown.length, 10, 'updown folds back without repeating the turnarounds');
  assert.deepEqual(updown.slice(0, 6), [60, 64, 67, 72, 76, 79]);
  assert.deepEqual(updown.slice(6), [76, 72, 67, 64]);

  const random = buildArpSequence(chord, 'random', 3);
  assert.equal(random.length, 9);
  assert.deepEqual([...random].sort((a, b) => a - b), random, 'random pool stays the ascending pool');

  assert.deepEqual(buildArpSequence([], 'up', 2), []);
  assert.deepEqual(buildArpSequence([60, 60, 64], 'up', 1), [60, 64], 'duplicates collapse');
  assert.equal(buildArpSequence(chord, 'up', 9).length, 9, 'octaves clamp to 3');
  assert.deepEqual(buildArpSequence([60, 64], 'updown', 1), [60, 64], 'two-note chords do not fold');
});

test('generatePercussionPattern stays sparse and well formed', () => {
  const rng = seededRng(23);
  for (const sig of Object.keys(TIME_SIGNATURES)) {
    const pulses = TIME_SIGNATURES[sig];
    for (const density of [0, 0.25, 0.5, 0.75, 1]) {
      for (let i = 0; i < 60; i++) {
        const hits = generatePercussionPattern({ pulses, density, rng });
        assert.ok(hits.length <= 5, `${sig} @${density}: ${hits.length} hits is a groove, not ambience`);
        if (density === 0) assert.ok(hits.length <= 1, 'silent settings must stay near-silent');
        let last = -1;
        for (const hit of hits) {
          assert.ok(['low', 'mid', 'high'].includes(hit.kind), `bad kind ${hit.kind}`);
          assert.ok(Number.isInteger(hit.pulse) && hit.pulse >= 0 && hit.pulse < pulses.length,
            `pulse ${hit.pulse} outside the bar`);
          assert.ok(hit.offset >= 0 && hit.offset < 0.9, `offset ${hit.offset} outside its pulse`);
          assert.ok(hit.velocity > 0 && hit.velocity <= 1);
          assert.ok(hit.pulse >= last, 'hits must come out in time order');
          last = hit.pulse;
        }
        const lows = hits.filter((h) => h.kind === 'low');
        assert.ok(lows.length <= 2, 'at most two low pulses per bar');
        if (lows.length) assert.ok(lows[0].pulse === 0 || lows.length === 1 || lows[1].pulse > 0);
      }
    }
  }

  const mean = (density) => {
    const local = seededRng(5);
    let total = 0;
    for (let i = 0; i < 300; i++) {
      total += generatePercussionPattern({ pulses: [1, 1, 1, 1], density, rng: local }).length;
    }
    return total / 300;
  };
  const quiet = mean(0);
  const busy = mean(1);
  assert.ok(quiet < 0.8, `quiet average ${quiet}`);
  assert.ok(busy > quiet, `busy average ${busy} should exceed quiet ${quiet}`);
  assert.ok(busy < 4.5, `busy average ${busy} is drum-machine territory`);
});

// --------------------------------------------------------------------------
// Fallback voices
// --------------------------------------------------------------------------

test('fallback voices cover every track and schedule cleanly', () => {
  const ctx = new MockAudioContext();
  const destination = makeNode('gain');
  for (const track of TRACK_ORDER) {
    const bank = FALLBACK_VOICES[track];
    assert.ok(bank && Object.keys(bank).length, `no fallback voice for ${track}`);
    for (const [id, voice] of Object.entries(bank)) {
      assert.equal(typeof voice.label, 'string');
      assert.equal(typeof voice.play, 'function', `${track}.${id} has no play()`);
      const before = oscillatorsStarted;
      const note = track === 'percussion'
        ? { midi: null, freq: null, velocity: 0.8, duration: 0.2, when: 1.5, pan: 0, kind: 'low' }
        : { midi: 64, freq: midiToFreq(64), velocity: 0.6, duration: 1, when: 1.5, pan: -0.4, kind: null };
      const handle = voice.play(ctx, destination, note);
      assert.ok(oscillatorsStarted > before, `${track}.${id} started no oscillator`);
      assert.equal(typeof handle.cancel, 'function');
      ctx.currentTime = note.when + 0.1;   // cancel mid-note, as a hard stop would
      handle.cancel();
      ctx.currentTime = 0;
    }
  }
  // A percussion note with no pitch information still resolves a tone.
  for (const kind of ['low', 'mid', 'high']) {
    FALLBACK_VOICES.percussion.soft.play(ctx, destination, {
      midi: null, freq: null, velocity: 1, duration: 0.1, when: 2, pan: 0, kind,
    });
  }
});

// --------------------------------------------------------------------------
// Parameter validation
// --------------------------------------------------------------------------

test('sanitiseParams clamps, validates and ignores unknown keys', () => {
  assert.deepEqual(sanitiseParams(), { ...DEFAULT_PARAMS });
  assert.deepEqual(sanitiseParams(null), { ...DEFAULT_PARAMS });

  const clamped = sanitiseParams({
    speed: 99, complexity: -3, repetition: 4, bpm: 5, volume: 12,
  });
  assert.equal(clamped.speed, 2);
  assert.equal(clamped.complexity, 0);
  assert.equal(clamped.repetition, 1);
  assert.equal(clamped.bpm, 40);
  assert.equal(clamped.volume, 1);

  const low = sanitiseParams({ speed: 0, bpm: 999 });
  assert.equal(low.speed, 0.25);
  assert.equal(low.bpm, 120);

  assert.equal(sanitiseParams({ speed: 'oops' }).speed, DEFAULT_PARAMS.speed);
  assert.equal(sanitiseParams({ speed: NaN }).speed, DEFAULT_PARAMS.speed);
  assert.equal(sanitiseParams({ mode: 'klingon' }).mode, DEFAULT_PARAMS.mode);
  assert.equal(sanitiseParams({ mode: 'lydian' }).mode, 'lydian');
  assert.equal(sanitiseParams({ timeSignature: '11/16' }).timeSignature, '4/4');
  assert.equal(sanitiseParams({ timeSignature: '7/8' }).timeSignature, '7/8');
  assert.equal(sanitiseParams({ root: 'Eb' }).root, 'D#');
  assert.equal(sanitiseParams({ root: 'H' }).root, 'C');
  assert.equal(sanitiseParams({ nonsense: true }).nonsense, undefined);

  // v1's voices param is now just another unknown key
  assert.equal('voices' in sanitiseParams({ voices: 3 }), false);

  const merged = sanitiseParams({ bpm: 90 }, sanitiseParams({ mode: 'aeolian' }));
  assert.equal(merged.bpm, 90);
  assert.equal(merged.mode, 'aeolian');

  // a corrupt base cannot leak through
  const rescued = sanitiseParams({}, { bpm: 9999, mode: 'klingon', volume: 'x' });
  assert.equal(rescued.bpm, 120);
  assert.equal(rescued.mode, DEFAULT_PARAMS.mode);
  assert.equal(rescued.volume, DEFAULT_PARAMS.volume);
});

test('sanitiseParams validates structure and custom blocks', () => {
  assert.equal(sanitiseParams({ structure: 'journey' }).structure, 'journey');
  assert.equal(sanitiseParams({ structure: 'nope' }).structure, 'auto');
  assert.equal(sanitiseParams({ structure: 7 }).structure, 'auto');
  assert.equal(sanitiseParams({ structure: 'custom' }).structure, 'custom');

  const blocks = sanitiseParams({
    customStructure: [
      { label: 'a', bars: 99, intensity: 5 },
      { label: 'D', bars: 0, intensity: -1 },
      { label: 'E', bars: 4, intensity: 0.5 },   // label out of A–D → dropped
      'nope',                                    // not an object → dropped
      null,
      { bars: 4 },                               // no label → dropped
      { label: 'B', bars: 3.6, intensity: 0.42 },
    ],
  }).customStructure;
  assert.deepEqual(blocks, [
    { label: 'A', bars: 32, intensity: 1 },
    { label: 'D', bars: 1, intensity: 0 },
    { label: 'B', bars: 4, intensity: 0.42 },
  ]);

  // at most 8 blocks survive
  const many = sanitiseParams({
    customStructure: Array.from({ length: 12 }, () => ({ label: 'C', bars: 2, intensity: 0.5 })),
  }).customStructure;
  assert.equal(many.length, 8);

  // missing fields take block defaults
  assert.deepEqual(sanitiseParams({ customStructure: [{ label: 'C' }] }).customStructure,
    [{ label: 'C', bars: 8, intensity: 0.5 }]);

  // an empty or all-invalid array is legal and falls back to auto at play time
  assert.deepEqual(sanitiseParams({ customStructure: [] }).customStructure, []);
  assert.deepEqual(sanitiseParams({ customStructure: [{ label: 'Z' }] }).customStructure, []);
  assert.equal(resolveStructure('custom', 0.5,
    sanitiseParams({ structure: 'custom', customStructure: [] }).customStructure), 'waves');

  // a non-array leaves the base list alone
  const base = sanitiseParams({ customStructure: [{ label: 'B', bars: 5, intensity: 0.6 }] });
  assert.deepEqual(sanitiseParams({ customStructure: 'nope' }, base).customStructure,
    [{ label: 'B', bars: 5, intensity: 0.6 }]);
});

test('sanitiseParams merges arp deeply and clamps every field', () => {
  const arp = sanitiseParams({}).arp;
  assert.deepEqual(arp, {
    mode: 'auto', pattern: 'up', rate: '1/8', octaves: 2, gate: 0.6,
    steps: new Array(16).fill(true),
  });

  const wild = sanitiseParams({
    arp: { mode: 'sideways', pattern: 'spiral', rate: '1/3', octaves: 9, gate: 0, steps: 'nope' },
  }).arp;
  assert.deepEqual(wild, {
    mode: 'auto', pattern: 'up', rate: '1/8', octaves: 3, gate: 0.1,
    steps: new Array(16).fill(true),
  });

  const manual = sanitiseParams({
    arp: { mode: 'manual', pattern: 'updown', rate: '1/8T', octaves: 1.4, gate: 0.85 },
  });
  assert.equal(manual.arp.mode, 'manual');
  assert.equal(manual.arp.pattern, 'updown');
  assert.equal(manual.arp.rate, '1/8T');
  assert.equal(manual.arp.octaves, 1);
  assert.equal(manual.arp.gate, 0.85);

  // partial update keeps the rest of the arp block
  const patched = sanitiseParams({ arp: { rate: '1/16' } }, manual);
  assert.equal(patched.arp.rate, '1/16');
  assert.equal(patched.arp.mode, 'manual');
  assert.equal(patched.arp.pattern, 'updown');
  assert.equal(patched.arp.gate, 0.85);

  // steps normalise to exactly 16 booleans
  const short = sanitiseParams({ arp: { steps: [0, 1, 'yes'] } }).arp.steps;
  assert.equal(short.length, 16);
  assert.deepEqual(short.slice(0, 3), [false, true, true]);
  assert.deepEqual(short.slice(3), new Array(13).fill(true));
  const long = sanitiseParams({ arp: { steps: new Array(40).fill(false) } }).arp.steps;
  assert.equal(long.length, 16);
  assert.ok(long.every((s) => s === false));
});

test('sanitiseParams merges tracks deeply and rejects bad states', () => {
  const tracks = sanitiseParams({}).tracks;
  assert.deepEqual(Object.keys(tracks), [...TRACK_ORDER]);
  for (const name of TRACK_ORDER) assert.equal(tracks[name].state, 'auto');
  assert.equal(tracks.arp.voice, 'softPluck');
  assert.equal(tracks.percussion.voice, 'soft');

  const set = sanitiseParams({
    tracks: {
      pad: { state: 'off' },
      bass: { voice: 'round' },
      melody: { state: 'sideways' },
      texture: { state: 'on', voice: '  chimes  ' },
      nonsense: { state: 'on' },
    },
  }).tracks;
  assert.equal(set.pad.state, 'off');
  assert.equal(set.pad.voice, 'warm', 'a state-only update keeps the voice');
  assert.equal(set.bass.voice, 'round');
  assert.equal(set.bass.state, 'auto');
  assert.equal(set.melody.state, 'auto', 'an unknown state falls back');
  assert.equal(set.texture.state, 'on');
  assert.equal(set.texture.voice, 'chimes');
  assert.equal('nonsense' in set, false);

  // partial updates merge over the previous track block
  const next = sanitiseParams({ tracks: { pad: { voice: 'glass' } } }, sanitiseParams({
    tracks: { pad: { state: 'on', voice: 'choir' } },
  }));
  assert.equal(next.tracks.pad.state, 'on');
  assert.equal(next.tracks.pad.voice, 'glass');

  // an unknown voice id is kept as-is; the engine resolves it at play time
  assert.equal(sanitiseParams({ tracks: { arp: { voice: 'ghost' } } }).tracks.arp.voice, 'ghost');
  assert.equal(sanitiseParams({ tracks: { arp: { voice: '   ' } } }).tracks.arp.voice, 'softPluck');
  assert.equal(sanitiseParams({ tracks: { arp: { voice: 42 } } }).tracks.arp.voice, 'softPluck');
});

// --------------------------------------------------------------------------
// Engine lifecycle against the mock
// --------------------------------------------------------------------------

test('engine exposes the documented API and defaults', () => {
  const engine = createEngine();
  for (const key of ['start', 'stop', 'setParams', 'getParams', 'getAnalysers', 'on', 'now']) {
    assert.equal(typeof engine[key], 'function', `missing ${key}()`);
  }
  assert.equal(engine.running, false);
  assert.equal(engine.now(), 0, 'now() is 0 before start()');
  assert.deepEqual(engine.getParams(), { ...DEFAULT_PARAMS });

  const analysers = engine.getAnalysers();
  assert.deepEqual(Object.keys(analysers), [...TRACK_ORDER]);
  for (const name of TRACK_ORDER) assert.equal(analysers[name], null, `${name} analyser before start`);

  engine.setParams({ bpm: 200, mode: 'dorian', bogus: 1, voices: 2 });
  assert.equal(engine.getParams().bpm, 120);
  assert.equal(engine.getParams().mode, 'dorian');
  assert.equal('bogus' in engine.getParams(), false);
  assert.equal('voices' in engine.getParams(), false);

  // getParams must hand back a deep copy, not the live objects
  const snapshot = engine.getParams();
  snapshot.bpm = 41;
  snapshot.tracks.pad.state = 'off';
  snapshot.arp.steps[0] = false;
  snapshot.customStructure[0].bars = 31;
  assert.equal(engine.getParams().bpm, 120);
  assert.equal(engine.getParams().tracks.pad.state, 'auto');
  assert.equal(engine.getParams().arp.steps[0], true);
  assert.equal(engine.getParams().customStructure[0].bars, 8);

  engine.stop(); // safe before start
  assert.equal(engine.running, false);
  assert.ok(isSupported());
});

test('engine schedules audio across every mode and metre', async () => {
  const engine = createEngine({ bpm: 120, speed: 2, complexity: 0.9 });
  const notes = [];
  engine.on('note', (n) => notes.push(n));
  await engine.start();
  assert.equal(engine.running, true);
  assert.ok(Number.isFinite(engine.now()), 'now() must report the audio clock once started');

  const analysers = engine.getAnalysers();
  for (const name of TRACK_ORDER) assert.ok(analysers[name], `${name} analyser after start`);

  // Drive the mock clock forward the way the browser's audio clock would,
  // letting the real setInterval scheduler run against it.
  for (const sig of Object.keys(TIME_SIGNATURES)) {
    for (const mode of Object.keys(SCALES)) {
      engine.setParams({ timeSignature: sig, mode, root: 'F#' });
      await advance(0.5);
    }
  }
  assert.ok(engine.now() > 0, 'now() tracks the audio clock');
  assert.ok(notes.length > 0, 'no notes were scheduled');
  for (const note of notes) {
    assert.ok(TRACK_ORDER.includes(note.track), `unknown track ${note.track}`);
    assert.ok(Number.isFinite(note.time) && note.time >= 0);
    assert.ok(note.duration > 0);
    assert.ok(note.velocity > 0 && note.velocity <= 1);
    if (note.track === 'percussion') {
      assert.equal(note.midi, null);
      assert.ok(['low', 'mid', 'high'].includes(note.kind));
    } else {
      assert.equal(note.kind, null);
      assert.ok(Number.isInteger(note.midi) && note.midi > 0 && note.midi < 128);
    }
  }

  await engine.start(); // repeat start is a no-op
  assert.equal(engine.running, true);

  engine.stop();
  assert.equal(engine.running, false);
  engine.stop(); // repeat stop is safe
  const afterStop = notes.length;
  await advance(0.5);
  assert.equal(notes.length, afterStop, 'scheduler kept running after stop');

  await engine.start(); // restart after stop
  assert.equal(engine.running, true);
  await advance(0.3);
  engine.stop();
});

test('engine survives extreme parameter combinations', async () => {
  const engine = createEngine();
  await engine.start();
  const combos = [
    { bpm: 40, speed: 0.25, complexity: 0, repetition: 1, volume: 0, structure: 'drone' },
    {
      bpm: 120, speed: 2, complexity: 1, repetition: 0, volume: 1, structure: 'build',
      tracks: Object.fromEntries(TRACK_ORDER.map((n) => [n, { state: 'on' }])),
    },
    {
      bpm: 60, speed: 1, complexity: 0.5, repetition: 0.5, volume: 0.5, structure: 'custom',
      customStructure: [{ label: 'A', bars: 1, intensity: 0 }, { label: 'D', bars: 1, intensity: 1 }],
      arp: { mode: 'manual', rate: '1/16', octaves: 3, gate: 1, steps: new Array(16).fill(true) },
    },
    {
      bpm: 95, speed: 1.7, complexity: 0.8, repetition: 0.2, timeSignature: '5/4',
      structure: 'custom', customStructure: [],
      tracks: Object.fromEntries(TRACK_ORDER.map((n) => [n, { state: 'off', voice: 'ghost' }])),
    },
    { timeSignature: '7/8', arp: { mode: 'manual', rate: '1/8T' }, structure: 'journey' },
  ];
  for (const combo of combos) {
    engine.setParams(combo);
    await advance(0.8);
  }
  engine.stop();
});

test('engine emits bar, section and note events in sane time order', async () => {
  const engine = createEngine({
    bpm: 120, speed: 2, timeSignature: '3/4', complexity: 0.6, structure: 'abab', repetition: 0.5,
  });
  const bars = [];
  const sections = [];
  const notes = [];
  const states = [];
  const offBar = engine.on('bar', (e) => bars.push(e));
  engine.on('section', (e) => sections.push(e));
  engine.on('note', (e) => notes.push(e));
  engine.on('state', (e) => states.push(e));
  engine.on('note', () => { throw new Error('a broken listener must not stop the engine'); });

  await engine.start();
  await advance(14, { step: 0.12, sleep: 16 });
  engine.stop();

  assert.deepEqual(states, [{ running: true }, { running: false }]);
  assert.ok(bars.length >= 16, `only ${bars.length} bars in 14 s`);
  bars.forEach((e, i) => {
    assert.equal(e.bar, i, 'bar numbers must count up from zero without gaps');
    assert.equal(e.beatsPerBar, 3);
    assert.ok(Number.isFinite(e.time));
    if (i > 0) assert.ok(e.time > bars[i - 1].time, 'bar times must increase');
  });

  // abab: a section change every 8 bars, alternating labels and intensities
  assert.ok(sections.length >= 2, 'no section events');
  assert.equal(sections[0].bar, 0);
  assert.deepEqual(sections.map((s) => s.label).slice(0, 3), ['A', 'B', 'A'].slice(0, sections.length));
  for (const section of sections) {
    assert.ok(section.intensity >= 0 && section.intensity <= 1);
    const owner = bars.find((b) => b.bar === section.bar);
    assert.ok(owner, 'a section must land on a bar the engine announced');
    assert.equal(section.time, owner.time, 'sections change on bar boundaries only');
  }
  for (let i = 1; i < sections.length; i++) {
    assert.equal(sections[i].bar - sections[i - 1].bar, 8, 'abab blocks are 8 bars');
    assert.notEqual(sections[i].label, sections[i - 1].label);
  }
  assert.equal(sections[0].intensity, 0.4);
  assert.equal(sections[1].intensity, 0.7);

  // notes never precede the bar they belong to, and stay within a bar of it
  const barDuration = 3 * (60 / 240);
  assert.ok(notes.length > 0);
  for (const note of notes) {
    const owner = [...bars].reverse().find((b) => b.time <= note.time + 1e-9);
    assert.ok(owner, `note at ${note.time} precedes every bar`);
    assert.ok(note.time < owner.time + barDuration + 1e-6,
      'a note must be scheduled inside the bar that scheduled it');
  }

  // unsubscribing stops delivery
  const before = bars.length;
  offBar();
  await engine.start();
  await advance(1);
  engine.stop();
  assert.equal(bars.length, before, 'unsubscribed listener still fired');
});

test('arp quantises to its grid in every rate, including 7/8', async () => {
  const secPerBeat = 60 / 240; // bpm 120 × speed 2
  for (const [rate, stepBeats] of Object.entries(ARP_RATES)) {
    for (const sig of ['4/4', '7/8']) {
      const engine = createEngine({
        bpm: 120,
        speed: 2,
        timeSignature: sig,
        structure: 'drone',
        repetition: 0,
        arp: { mode: 'manual', rate, octaves: 2, gate: 0.6, steps: new Array(16).fill(true) },
        tracks: Object.fromEntries(TRACK_ORDER.map((n) => [n, { state: n === 'arp' ? 'on' : 'off' }])),
      });
      const bars = [];
      const notes = [];
      engine.on('bar', (e) => bars.push(e));
      engine.on('note', (e) => notes.push(e));
      await engine.start();
      await advance(4, { step: 0.12, sleep: 16 });
      engine.stop();

      assert.ok(notes.length > 0, `${sig} @${rate}: arp played nothing`);
      assert.ok(notes.every((n) => n.track === 'arp'), 'only the arp should be audible here');
      const expectedPerBar = Math.ceil(beatsPerBar(sig) / stepBeats - 1e-6);
      for (const note of notes) {
        const owner = [...bars].reverse().find((b) => b.time <= note.time + 1e-9);
        const offsetBeats = (note.time - owner.time) / secPerBeat;
        const steps = offsetBeats / stepBeats;
        assert.ok(Math.abs(steps - Math.round(steps)) < 1e-6,
          `${sig} @${rate}: note ${offsetBeats} beats into the bar is off the grid`);
        assert.ok(offsetBeats < beatsPerBar(sig) - 1e-6, 'an arp step overran the bar');
        assert.ok(note.duration <= stepBeats * secPerBeat + 1e-9, 'gate must not exceed one step');
      }
      // every full step of the bar fires with an all-on mask (the final bar is
      // dropped: the clock stopped part way through scheduling it)
      const counts = bars
        .slice(0, -1)
        .map((b) => notes.filter((n) => n.time >= b.time - 1e-9 && n.time < b.time + beatsPerBar(sig) * secPerBeat - 1e-9).length);
      assert.ok(counts.every((c) => c === expectedPerBar),
        `${sig} @${rate}: expected ${expectedPerBar} steps per bar, saw ${[...new Set(counts)]}`);
    }
  }
});

test('arp honours the manual step mask', async () => {
  const steps = new Array(16).fill(false);
  steps[0] = true;
  const engine = createEngine({
    bpm: 120,
    speed: 2,
    timeSignature: '4/4',
    structure: 'drone',
    arp: { mode: 'manual', rate: '1/4', octaves: 1, gate: 0.5, steps },
    tracks: Object.fromEntries(TRACK_ORDER.map((n) => [n, { state: n === 'arp' ? 'on' : 'off' }])),
  });
  const bars = [];
  const notes = [];
  engine.on('bar', (e) => bars.push(e));
  engine.on('note', (e) => notes.push(e));
  await engine.start();
  await advance(9, { step: 0.12, sleep: 16 });
  engine.stop();

  // 1/4 in 4/4 = four steps a bar, so the single enabled step comes round once
  // every four bars.
  assert.ok(bars.length >= 8, `only ${bars.length} bars`);
  assert.ok(notes.length >= 1, 'the enabled step never fired');
  assert.ok(notes.length <= Math.ceil(bars.length / 4) + 1,
    `mask ignored: ${notes.length} notes across ${bars.length} bars`);
});

test('percussion stays sparse when it plays', async () => {
  const engine = createEngine({
    bpm: 120,
    speed: 2,
    complexity: 1,
    repetition: 0,
    structure: 'custom',
    customStructure: [{ label: 'D', bars: 4, intensity: 1 }],
    tracks: Object.fromEntries(TRACK_ORDER.map((n) => [n, { state: n === 'percussion' ? 'on' : 'off' }])),
  });
  const bars = [];
  const notes = [];
  engine.on('bar', (e) => bars.push(e));
  engine.on('note', (e) => notes.push(e));
  await engine.start();
  await advance(10, { step: 0.12, sleep: 16 });
  engine.stop();

  assert.ok(bars.length >= 8, `only ${bars.length} bars`);
  assert.ok(notes.length > 0, 'percussion never played at full density');
  assert.ok(notes.every((n) => n.track === 'percussion' && n.midi === null));
  const barLength = 4 * (60 / 240);
  for (const barEvent of bars) {
    const inBar = notes.filter((n) => n.time >= barEvent.time - 1e-9 && n.time < barEvent.time + barLength - 1e-9);
    assert.ok(inBar.length <= 5, `bar ${barEvent.bar} had ${inBar.length} hits — that is a groove`);
  }
  const kinds = new Set(notes.map((n) => n.kind));
  assert.ok([...kinds].every((k) => ['low', 'mid', 'high'].includes(k)));
  const lows = notes.filter((n) => n.kind === 'low');
  assert.ok(lows.length > 0, 'no low pulse at all');
  // low pulses cluster at bar starts
  const nearStart = lows.filter((n) => {
    const owner = [...bars].reverse().find((b) => b.time <= n.time + 1e-9);
    return n.time - owner.time < 0.05;
  });
  assert.ok(nearStart.length >= lows.length / 2, 'low pulses should sit near bar starts');
});

test('auto tracks join in order as intensity and complexity rise', async () => {
  const played = async (params, seconds) => {
    const engine = createEngine(params);
    const tracks = new Set();
    engine.on('note', (n) => tracks.add(n.track));
    await engine.start();
    await advance(seconds, { step: 0.12, sleep: 16 });
    engine.stop();
    return tracks;
  };

  const calm = await played({
    bpm: 120, speed: 2, complexity: 0, structure: 'drone', repetition: 0.5,
  }, 6);
  assert.ok(calm.size > 0, 'the calmest setting played nothing at all');
  for (const track of calm) {
    assert.ok(['pad', 'bass'].includes(track), `${track} should not be active at complexity 0`);
  }

  const busy = await played({
    bpm: 120,
    speed: 2,
    complexity: 1,
    repetition: 0,
    structure: 'custom',
    customStructure: [{ label: 'D', bars: 8, intensity: 1 }],
  }, 12);
  for (const track of TRACK_ORDER) {
    assert.ok(busy.has(track), `${track} never joined at full intensity and complexity`);
  }
});

test('an unknown voice id falls back instead of going silent', async () => {
  const engine = createEngine({
    bpm: 120,
    speed: 2,
    complexity: 1,
    structure: 'custom',
    customStructure: [{ label: 'D', bars: 4, intensity: 1 }],
    tracks: Object.fromEntries(TRACK_ORDER.map((n) => [n, { state: 'on', voice: 'no-such-voice' }])),
  });
  const notes = [];
  engine.on('note', (n) => notes.push(n));
  await engine.start();
  await advance(4, { step: 0.12, sleep: 16 });
  engine.stop();
  assert.ok(notes.length > 0, 'an unknown voice id silenced the engine');
});

// --------------------------------------------------------------------------
// Runner
// --------------------------------------------------------------------------

/**
 * Advance every live mock clock by `seconds` in small steps, yielding to the
 * event loop so the engine's setInterval scheduler gets to run. Steps stay well
 * under the scheduler's resync threshold so bar counting is not disturbed.
 */
async function advance(seconds, { step = 0.08, sleep = 15 } = {}) {
  const steps = Math.ceil(seconds / step);
  for (let i = 0; i < steps; i++) {
    for (const ctx of liveContexts) ctx.currentTime += step;
    await new Promise((resolve) => setTimeout(resolve, sleep));
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
console.log(`(${nodesCreated} mock nodes, ${oscillatorsStarted} oscillators started)`);
process.exit(failures ? 1 : 0);
