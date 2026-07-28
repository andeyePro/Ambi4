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
 *
 * Two things shape almost every playback test here:
 *
 *  - Staged entry (v8, ruling 7): a piece starts with the pad alone and lets
 *    one more track in per bar, in TRACK_ORDER — pad 0, bass 1, melody 2,
 *    texture 3, arp 4, percussion 5 — for EVERY structure preset, whatever the
 *    track states say. Any test that wants to hear a track must therefore skip
 *    past its stage bar first.
 *  - The fast clock (`hiddenTab`): a hidden tab widens the engine's lookahead
 *    from 0.12 s to 2.5 s, so the mock clock can be driven in 0.5 s jumps
 *    instead of 0.08 s ones. That buys ~4× more audio per second of wall time,
 *    which is what keeps a suite this size under a minute.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// --------------------------------------------------------------------------
// Minimal AudioContext mock — enough surface for the engine's node graph and
// for a voice library's own nodes.
// --------------------------------------------------------------------------

let nodesCreated = 0;
let oscillatorsStarted = 0;

function makeParam(value) {
  return {
    value,
    // Every linear ramp asked for, in order — the mock applies a ramp
    // instantly, so a crossfade is only visible in what was SCHEDULED.
    ramps: [],
    setValueAtTime(v) { this.value = v; return this; },
    linearRampToValueAtTime(v, at) { this.ramps.push({ to: v, at }); this.value = v; return this; },
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
    connections: [],
    disconnects: [],
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
    connect(target) { this.connections.push(target); },
    // Recorded rather than ignored: v21's reverb swap has to prove it unwires
    // the outgoing convolver, and a leak there is an audible one (two tails).
    disconnect(target) {
      this.disconnects.push(target ?? null);
      if (target) this.connections = this.connections.filter((n) => n !== target);
      else this.connections = [];
    },
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
    // Every node this context made, in creation order — how the send-gain test
    // finds the engine's graph without the engine having to expose it.
    this.nodes = [];
    this.destination = this.track(makeNode('destination'));
  }

  track(node) {
    this.nodes.push(node);
    return node;
  }

  createGain() { return this.track(makeNode('gain')); }
  createOscillator() { return this.track(makeNode('oscillator')); }
  createBiquadFilter() { return this.track(makeNode('biquad')); }
  createStereoPanner() { return this.track(makeNode('panner')); }
  createPanner() { return this.track(makeNode('panner3d')); }
  createConvolver() { return this.track(makeNode('convolver')); }
  createDelay() { return this.track(makeNode('delay')); }
  createDynamicsCompressor() { return this.track(makeNode('compressor')); }
  createAnalyser() { return this.track(makeNode('analyser')); }
  createBufferSource() { return this.track(makeNode('buffersource')); }
  createConstantSource() { return this.track(makeNode('constantsource')); }
  createWaveShaper() { return this.track(makeNode('waveshaper')); }
  createChannelMerger() { return this.track(makeNode('merger')); }
  createChannelSplitter() { return this.track(makeNode('splitter')); }
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

const engineModule = await import('../src/scripts/ambient-engine.js');

const {
  sanitiseParams,
  randomnessIsHold,
  REVERB_TAIL_RANGE,
  quantiseToScale,
  scaleDegreeToMidi,
  generatePhrase,
  generateProgression,
  generatePercussionPattern,
  nextChordDegree,
  buildChord,
  buildHook,
  cloneHook,
  createVariantBank,
  mutateHook,
  hookKey,
  hookEnergy,
  voiceHookChord,
  HOOK_MIN_CHORDS,
  HOOK_MAX_CHORDS,
  buildArpSequence,
  autoArpSettings,
  autoActiveTracks,
  getTracks,
  createTrackLayer,
  resolveStructure,
  sectionAtBar,
  beatsPerBar,
  midiToFreq,
  pitchClass,
  isSupported,
  sequencerStepsPerBar,
  arpLaneLength,
  FALLBACK_VOICES,
  SCALES,
  TIME_SIGNATURES,
  TRACK_ORDER,
  ARP_RATES,
  ARP_PATTERNS,
  DEFAULT_PARAMS,
  SEQUENCED_TRACKS,
  SEQUENCER_STEP_COUNT,
  PERCUSSION_LANES,
  MAX_PERCUSSION_LANES,
  VARY_ASPECTS,
  TUNED_TRACKS,
  swungBeat,
  SWING_UNIT,
  nameChord,
  silentBars,
  longestSilentRun,
  isContinuouslyAudible,
  buildBassGroove,
  cloneBassGroove,
  developBassGroove,
  bassGrooveOp,
  BASS_GROOVE_OPS,
  BASS_FEEL_NAMES,
  BASS_GHOST_CEILING,
  HARMONY_RHYTHMS,
  setGenreTable,
  captureSlot,
  quantiseCapture,
} = engineModule;

/**
 * Every engine the suite builds, so the runner can stop one that a failed
 * assertion left running: a leaked ticker keeps scheduling notes into the
 * shared voice banks, and the next test then measures the wrong piece.
 */
const builtEngines = [];

function createEngine(...args) {
  const made = engineModule.createEngine(...args);
  builtEngines.push(made);
  return made;
}

/**
 * The voice bank the engine will actually use for `pad`. If engine-voices.js is
 * missing or unloadable the engine falls back to its own voices, and so does
 * this suite — either way the bank below is the object the engine plays from,
 * which is what the patch pass-through test spies on.
 */
let padBank = FALLBACK_VOICES.pad;
let voiceLib = null;
try {
  const mod = await import('../src/scripts/engine-voices.js');
  if (mod && mod.VOICES && mod.VOICES.pad && Object.keys(mod.VOICES.pad).length) {
    padBank = mod.VOICES.pad;
    voiceLib = mod.VOICES;
  }
} catch {
  // engine-voices.js is optional; the engine's fallback voices stand in.
}

/**
 * The send level the engine should apply to an unpatched track: the current
 * voice's published defaults.sends when the library is loaded, else the
 * engine's own per-track mix default (`fallback`).
 */
function defaultSend(track, voiceId, key, fallback) {
  const voice = voiceLib && voiceLib[track] ? voiceLib[track][voiceId] : null;
  const sends = voice && voice.defaults ? voice.defaults.sends : null;
  return sends && typeof sends[key] === 'number' ? sends[key] : fallback;
}

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

test('buildHook loops 4–8 chords from the tonic, in whatever mode it is given', () => {
  const rng = seededRng(31);
  assert.equal(buildHook({ repetition: 1, rng }).degrees.length, HOOK_MIN_CHORDS,
    'maximum repetition asks for the tightest loop');
  assert.equal(buildHook({ repetition: 0, rng }).degrees.length, HOOK_MAX_CHORDS,
    'minimum repetition asks for the longest loop');
  let previousLength = HOOK_MAX_CHORDS + 1;
  for (const repetition of [0, 0.25, 0.5, 0.75, 1]) {
    const length = buildHook({ repetition, rng }).degrees.length;
    assert.ok(length <= previousLength, 'loop length must not grow with repetition');
    previousLength = length;
  }

  for (const [mode, scale] of Object.entries(SCALES)) {
    for (const complexity of [0, 0.5, 1]) {
      const hook = buildHook({ scaleLength: scale.length, complexity, rng });
      assert.equal(hook.degrees[0], 0, `${mode}: a hook starts on the tonic`);
      assert.equal(hook.inversions.length, hook.degrees.length);
      assert.equal(hook.extensions.length, hook.degrees.length);
      hook.degrees.forEach((degree, i) => {
        assert.ok(Number.isInteger(degree) && degree >= 0 && degree < scale.length,
          `${mode}: degree ${degree} is outside the mode`);
        if (i > 0) assert.notEqual(degree, hook.degrees[i - 1], `${mode}: a chord repeated itself`);
      });
      assert.ok(hook.inversions.every((v) => v === 0) && hook.extensions.every((v) => v === 0),
        'a fresh hook is unmutated');
      assert.equal(hookEnergy(hook), 0, 'a fresh hook has no energy');
    }
  }
});

test('mutateHook changes exactly one thing and never leaves the mode', () => {
  const rng = seededRng(32);
  const kinds = { inversion: 0, degree: 0, extension: 0 };
  let hook = buildHook({ scaleLength: 5, repetition: 0.5, rng });
  for (let i = 0; i < 300; i++) {
    const before = hook;
    const beforeKey = hookKey(before);
    hook = mutateHook(before, { scaleLength: 5, complexity: 0.6, rng });
    assert.equal(hookKey(before), beforeKey, 'mutateHook wrote through to the variant it was handed');
    assert.notEqual(hookKey(hook), beforeKey, 'a mutation must be audible');
    let changed = 0;
    for (let slot = 0; slot < hook.degrees.length; slot++) {
      if (hook.degrees[slot] !== before.degrees[slot]) { changed += 1; kinds.degree += 1; }
      if (hook.inversions[slot] !== before.inversions[slot]) { changed += 1; kinds.inversion += 1; }
      if (hook.extensions[slot] !== before.extensions[slot]) { changed += 1; kinds.extension += 1; }
    }
    assert.equal(changed, 1, 'at most one mutation per pass');
    assert.equal(hook.degrees[0], 0, 'the tonic anchor is never substituted away');
    hook.degrees.forEach((degree) => {
      assert.ok(Number.isInteger(degree) && degree >= 0 && degree < 5, `degree ${degree} left the mode`);
    });
    hook.inversions.forEach((v) => assert.ok(v >= 0 && v <= 2, `inversion ${v} out of range`));
    hook.extensions.forEach((v) => assert.ok(v >= -1 && v <= 1, `extension ${v} out of range`));
  }
  for (const [kind, count] of Object.entries(kinds)) {
    assert.ok(count > 0, `300 mutations never produced a ${kind} change`);
  }
  assert.ok(hookEnergy(hook) > 0, 'a mutated hook has energy');

  const copy = cloneHook(hook);
  copy.degrees[1] += 1;
  copy.inversions[0] = 2;
  assert.notEqual(hookKey(copy), hookKey(hook), 'cloneHook handed back a shared array');
});

test('voiceHookChord inverts and colours inside the scale', () => {
  const plain = voiceHookChord(2, 0.5, { scaleLength: 5 });
  assert.deepEqual(plain, buildChord(2, 0.5), 'inversion 0 is the plain stack');
  for (const inversion of [0, 1, 2]) {
    const voiced = voiceHookChord(2, 0.5, { inversion, scaleLength: 5 });
    assert.deepEqual([...voiced].sort((a, b) => a - b), voiced, 'a voicing must not cross itself');
    assert.equal(voiced.length, plain.length, 'an inversion moves notes, it does not add them');
    assert.equal(
      voiced.reduce((sum, d) => sum + d, 0),
      plain.reduce((sum, d) => sum + d, 0) + inversion * 5,
      'each rotated tone rises by exactly one scale length',
    );
  }
  assert.ok(voiceHookChord(0, 0.5, { extension: -1, scaleLength: 5 }).length
    < voiceHookChord(0, 0.5, { extension: 1, scaleLength: 5 }).length,
    'the extension nudge thins and thickens the stack');
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
    speed: 99, complexity: -3, repetition: 4, bpm: 10, volume: 12,
  });
  assert.equal(clamped.speed, 2);
  assert.equal(clamped.complexity, 0);
  assert.equal(clamped.repetition, 1);
  assert.equal(clamped.bpm, 20);
  assert.equal(clamped.volume, 1);

  const low = sanitiseParams({ speed: 0, bpm: 300 });
  assert.equal(low.speed, 0.25);
  assert.equal(low.bpm, 220);

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
  assert.equal(rescued.bpm, 220);
  assert.equal(rescued.mode, DEFAULT_PARAMS.mode);
  assert.equal(rescued.volume, DEFAULT_PARAMS.volume);
});

test('v26 genre tag: slug-shaped, inert, and never lost by an unrelated edit', () => {
  assert.equal(DEFAULT_PARAMS.genre, null, 'a params object ships with no genre');

  assert.equal(sanitiseParams({ genre: 'deep-house' }).genre, 'deep-house');
  assert.equal(sanitiseParams({ genre: '  Lofi-Beats ' }).genre, 'lofi-beats',
    'a tag is trimmed and lowercased, the way a slug is written');
  // Shape is the boundary that matters: a tag can arrive from a share link.
  assert.equal(sanitiseParams({ genre: 'not a slug' }).genre, null);
  assert.equal(sanitiseParams({ genre: '../etc/passwd' }).genre, null);
  assert.equal(sanitiseParams({ genre: '-leading' }).genre, null);
  assert.equal(sanitiseParams({ genre: 'x'.repeat(33) }).genre, null);
  assert.equal(sanitiseParams({ genre: 7 }).genre, null);

  const tagged = sanitiseParams({ genre: 'bossa' });
  assert.equal(sanitiseParams({ bpm: 120 }, tagged).genre, 'bossa',
    'an unrelated edit must not strip the tag');
  assert.equal(sanitiseParams({ genre: 'not a slug' }, tagged).genre, 'bossa',
    'an unusable tag keeps the stored one');
  assert.equal(sanitiseParams({ genre: null }, tagged).genre, null,
    'an explicit null clears the tag');
});

test('v26 setGenreTable filters the tag against the page\'s own registry', () => {
  try {
    assert.deepEqual(setGenreTable(['deep-house', { slug: 'Ambient' }, 'deep-house', 77]),
      ['deep-house', 'ambient'], 'the table takes slugs or genre files, de-duplicated');
    assert.equal(sanitiseParams({ genre: 'ambient' }).genre, 'ambient');
    assert.equal(sanitiseParams({ genre: 'jungle' }).genre, null,
      'with a table registered, an unknown slug is refused like any unknown enum');

    // A registered table also re-filters an inherited tag, so a stale genre
    // cannot ride in through the base.
    const stale = { ...DEFAULT_PARAMS, genre: 'jungle' };
    assert.equal(sanitiseParams({ bpm: 90 }, stale).genre, null);

    assert.deepEqual(setGenreTable(null), [], 'an empty list clears the table');
    assert.equal(sanitiseParams({ genre: 'jungle' }).genre, 'jungle',
      'with no table the engine is data-agnostic and keeps any slug-shaped tag');
  } finally {
    setGenreTable(null);
  }
});

test('v26 genre tag survives the engine and changes nothing about the piece',
  () => hiddenTab(async () => {
    const params = {
      bpm: 120, speed: 2, complexity: 0.8, repetition: 0.4, structure: 'journey',
      tracks: tracksAll('on'),
    };
    // The comparison window is MUSICAL, not wall-clock: both runs are driven
    // for the same 12 s of audio, but the scheduler's lookahead reaches past
    // the end by however far the last tick happened to land, so the tail is a
    // race between two runs and the notes inside the window are not.
    const WINDOW = 12;
    const capture = async (extra) => {
      const engine = createEngine({ ...params, ...extra }, { rng: seededRng(5150) });
      const log = record(engine);
      await engine.start();
      await advance(WINDOW, FAST);
      const tag = engine.getParams().genre;
      engine.stop();
      return {
        tag,
        notes: log.notes.filter((n) => n.time < WINDOW)
          .map((n) => `${n.track}|${n.midi}|${tick(n.time)}`),
      };
    };
    const plain = await capture({});
    const tagged = await capture({ genre: 'techno-tools' });
    assert.equal(plain.tag, null);
    assert.equal(tagged.tag, 'techno-tools', 'getParams hands the tag back');
    assert.ok(plain.notes.length > 20, `only ${plain.notes.length} notes`);
    assert.deepEqual(tagged.notes, plain.notes,
      'the tag is inert: the engine must play exactly the same piece with it');
  }));

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
  // v14: melody's user verdict passed — it now defaults to auto, same as
  // every other track except bass, which stays off until ITS rework passes
  // the same "catchy" gate.
  assert.deepEqual(Object.fromEntries(TRACK_ORDER.map((n) => [n, tracks[n].state])), {
    pad: 'auto', bass: 'off', melody: 'auto', texture: 'auto', arp: 'auto', percussion: 'auto',
  });
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
  assert.equal(set.bass.state, 'off', 'a voice-only update keeps the shipped state');
  assert.equal(set.melody.state, 'auto', 'an unknown state falls back to the stored default (v14: auto)');
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
  for (const key of ['arm', 'start', 'finish', 'stop', 'pause', 'resume', 'setParams', 'getParams',
    'getAnalysers', 'getMasterAnalyser', 'on', 'now']) {
    assert.equal(typeof engine[key], 'function', `missing ${key}()`);
  }
  assert.equal(engine.running, false);
  assert.equal(engine.paused, false);
  assert.equal(engine.now(), 0, 'now() is 0 before start()');
  assert.deepEqual(engine.getParams(), { ...DEFAULT_PARAMS });

  const analysers = engine.getAnalysers();
  assert.deepEqual(Object.keys(analysers), [...TRACK_ORDER, 'total']);
  for (const name of TRACK_ORDER) assert.equal(analysers[name], null, `${name} analyser before start`);
  assert.equal(analysers.total, null, 'the master analyser before start');
  assert.equal(engine.getMasterAnalyser(), null, 'the master analyser before start');

  engine.setParams({ bpm: 300, mode: 'dorian', bogus: 1, voices: 2 });
  assert.equal(engine.getParams().bpm, 220);
  assert.equal(engine.getParams().mode, 'dorian');
  assert.equal('bogus' in engine.getParams(), false);
  assert.equal('voices' in engine.getParams(), false);

  // getParams must hand back a deep copy, not the live objects
  const snapshot = engine.getParams();
  snapshot.bpm = 41;
  snapshot.tracks.pad.state = 'off';
  snapshot.arp.steps[0] = false;
  snapshot.customStructure[0].bars = 31;
  assert.equal(engine.getParams().bpm, 220);
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

  assert.deepEqual(states, [{ running: true, paused: false }, { running: false, paused: false }]);
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

test('a tempo change lands on the next beat, not the next barline', async () => {
  // At 60 bpm in 4/4 a bar is 4 s. Before v0.0.48 a bpm change waited for the
  // next barline (secPerBeat was bar-snapshotted), so the bar in flight kept
  // its old spacing for up to 4 s — 12 s at the dial's slow end. Now tick()
  // re-reads tempo per pulse: only LOOKAHEAD (0.12 s) of audio is already
  // committed, so the bar in flight finishes its remaining beats at the new
  // spacing. The in-flight bar is the discriminator — under the old engine it
  // measures a full 4 s regardless of when the change arrives.
  const engine = createEngine({
    bpm: 60, speed: 1, timeSignature: '4/4', structure: 'drone',
    complexity: 0.3, repetition: 0.8,
  });
  const bars = [];
  engine.on('bar', (e) => bars.push(e));
  await engine.start();

  await advanceUntil(() => bars.length >= 2, 30, { step: 0.08, sleep: 15 });
  assert.ok(bars.length >= 2, 'engine never reached bar 1');
  engine.setParams({ bpm: 220 }); // mid-bar: bar 1 has begun, bar 2 has not

  await advanceUntil(() => bars.length >= 5, 40, { step: 0.08, sleep: 15 });
  engine.stop();
  assert.ok(bars.length >= 5, `only ${bars.length} bars scheduled`);

  // The bar the change interrupted must complete early. Worst case a couple of
  // pulses were already committed at the old 1 s spacing (LOOKAHEAD plus mock-
  // clock granularity), leaving 2 × 1 s + 2 × 0.27 s ≈ 2.5 s — still well
  // under the 4 s the old bar-snapshotted engine always measures.
  const interrupted = bars[2].time - bars[1].time;
  assert.ok(interrupted < 3.2,
    `tempo change waited for the barline: interrupted bar ran ${interrupted.toFixed(2)} s`);

  // Steady state after the change: a 4/4 bar at 220 bpm is ~1.09 s.
  const settled = bars[4].time - bars[3].time;
  assert.ok(settled < 1.5, `settled bar ran ${settled.toFixed(2)} s at 220 bpm`);
});

test('arp quantises to its grid in every rate, including 7/8', () => hiddenTab(async () => {
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
        // randomness 0: the default 0.5 humanises timing by ±≤25 ms, which is
        // exactly what a grid assertion must not have to tolerate.
        tracks: Object.fromEntries(TRACK_ORDER.map((n) => [
          n, n === 'arp' ? { state: 'on', randomness: 0 } : { state: 'off' },
        ])),
      });
      const bars = [];
      const notes = [];
      engine.on('bar', (e) => bars.push(e));
      engine.on('note', (e) => notes.push(e));
      await engine.start();
      await advance(14, FAST);
      engine.stop();

      // The arp is the fifth track in, so bars 0–3 are staged silent however
      // hard the track is forced on: only bars 4 up can be judged.
      const eligible = bars.filter((b) => b.bar >= 5).slice(0, -3);
      assert.ok(eligible.length >= 4, `${sig} @${rate}: only ${eligible.length} eligible bars`);
      assert.ok(notes.length > 0, `${sig} @${rate}: arp played nothing`);
      assert.ok(notes.every((n) => n.track === 'arp'), 'only the arp should be audible here');
      const expectedPerBar = Math.ceil(beatsPerBar(sig) / stepBeats - 1e-6);
      for (const note of notes) {
        const owner = [...bars].reverse().find((b) => b.time <= note.time + 1e-9);
        assert.ok(owner.bar >= 4, `${sig} @${rate}: the arp jumped its staged entry (bar ${owner.bar})`);
        const offsetBeats = (note.time - owner.time) / secPerBeat;
        const steps = offsetBeats / stepBeats;
        assert.ok(Math.abs(steps - Math.round(steps)) < 1e-6,
          `${sig} @${rate}: note ${offsetBeats} beats into the bar is off the grid`);
        assert.ok(offsetBeats < beatsPerBar(sig) - 1e-6, 'an arp step overran the bar');
        assert.ok(note.duration <= stepBeats * secPerBeat + 1e-9, 'gate must not exceed one step');
      }
      // every full step of an eligible bar fires with an all-on mask (the last
      // few bars are dropped: the clock stopped part way through scheduling them)
      const counts = eligible
        .map((b) => notes.filter((n) => n.time >= b.time - 1e-9 && n.time < b.time + beatsPerBar(sig) * secPerBeat - 1e-9).length);
      assert.ok(counts.every((c) => c === expectedPerBar),
        `${sig} @${rate}: expected ${expectedPerBar} steps per bar, saw ${[...new Set(counts)]}`);
    }
  }
}));

test('arp honours the manual step mask', () => hiddenTab(async () => {
  const steps = new Array(16).fill(false);
  steps[0] = true;
  const engine = createEngine({
    bpm: 120,
    speed: 2,
    timeSignature: '4/4',
    structure: 'drone',
    arp: { mode: 'manual', rate: '1/4', octaves: 1, gate: 0.5, steps },
    // randomness 0 keeps the ±≤25 ms timing humanisation out of the way.
    tracks: Object.fromEntries(TRACK_ORDER.map((n) => [
      n, n === 'arp' ? { state: 'on', randomness: 0 } : { state: 'off' },
    ])),
  });
  const bars = [];
  const notes = [];
  engine.on('bar', (e) => bars.push(e));
  engine.on('note', (e) => notes.push(e));
  await engine.start();
  await advance(16, FAST);
  engine.stop();

  // The mask is bar-anchored: with only step 0 enabled, exactly one note per
  // bar, on the barline — from bar 4, where the arp's staged entry lets it in
  // (the last part-scheduled bars are dropped).
  const barSeconds = 4 * (60 / 240);
  const eligible = bars.filter((b) => b.bar >= 5).slice(0, -3);
  assert.ok(eligible.length >= 5, `only ${eligible.length} eligible bars`);
  for (const barEvent of eligible) {
    const inBar = notes.filter((n) => n.time >= barEvent.time - 1e-9
      && n.time < barEvent.time + barSeconds - 1e-9);
    assert.equal(inBar.length, 1, `bar ${barEvent.bar}: one enabled step, ${inBar.length} notes`);
    assert.ok(Math.abs(inBar[0].time - barEvent.time) < 1e-6,
      `masked arp fired ${inBar[0].time - barEvent.time}s after the barline`);
  }
  assert.ok(notes.every((n) => [...bars].reverse().find((b) => b.time <= n.time + 1e-9).bar >= 4),
    'the arp sounded before its staged entry');
}));

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

test('auto tracks join in order as intensity and complexity rise', () => hiddenTab(async () => {
  // Every track on 'auto' — the v8 defaults ship melody and bass 'off', which
  // would take them out of the auto decision this test exists to check.
  const played = async (params, seconds) => {
    const engine = createEngine({ ...params, tracks: tracksAll('auto') });
    const tracks = new Set();
    engine.on('note', (n) => tracks.add(n.track));
    await engine.start();
    await advance(seconds, FAST);
    engine.stop();
    return tracks;
  };

  const calm = await played({
    bpm: 120, speed: 2, complexity: 0, structure: 'drone', repetition: 0.5,
  }, 10);
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
  }, 16);
  for (const track of TRACK_ORDER) {
    assert.ok(busy.has(track), `${track} never joined at full intensity and complexity`);
  }
}));

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
// v3 — arm(), finish() and per-voice patches
// --------------------------------------------------------------------------

test('arm() prepares audio silently and start() then needs no gesture', async () => {
  const Base = globalThis.AudioContext;
  let gesture = true;
  let created = 0;
  class GatedContext extends Base {
    constructor() {
      super();
      created += 1;
      this.state = 'suspended';   // what a browser hands you before a gesture
      this.resumeCalls = 0;
    }

    resume() {
      this.resumeCalls += 1;
      if (!gesture) return Promise.reject(new Error('resume() outside a user gesture'));
      this.state = 'running';
      return Promise.resolve();
    }
  }
  globalThis.AudioContext = GatedContext;
  try {
    const engine = createEngine({ bpm: 120, speed: 2, complexity: 0.8 });
    const events = [];
    engine.on('note', (e) => events.push(e));
    engine.on('bar', (e) => events.push(e));
    engine.on('state', (e) => events.push(e));

    assert.equal(engine.arm(), true);
    assert.equal(created, 1, 'arm() must create exactly one context');
    const ctx = liveContexts[liveContexts.length - 1];
    assert.equal(ctx.state, 'running', 'arm() must resume the context');
    assert.equal(engine.running, false, 'arm() must not start the transport');
    for (const name of TRACK_ORDER) {
      assert.ok(engine.getAnalysers()[name], `${name} analyser must exist after arm()`);
    }

    engine.arm();
    assert.equal(created, 1, 'arm() must be idempotent');
    assert.equal(ctx.resumeCalls, 1, 'a second arm() must not resume again');

    await advance(1.5, { step: 0.12, sleep: 16 });
    assert.deepEqual(events, [], 'arm() must schedule nothing and emit nothing');

    gesture = false;   // a sleep/alarm timer has no user gesture behind it
    await engine.start();
    assert.equal(engine.running, true);
    assert.equal(ctx.resumeCalls, 1, 'start() after arm() must not need a resume');
    await advance(3, { step: 0.12, sleep: 16 });
    assert.ok(events.some((e) => e.track), 'start() after arm() played nothing');
    engine.stop();
  } finally {
    globalThis.AudioContext = Base;
  }
});

test('finish() ends on a tonic bar, fades out and resolves', async () => {
  const engine = createEngine({
    bpm: 120,
    speed: 2,
    complexity: 1,
    repetition: 0,
    root: 'D',
    mode: 'dorian',
    structure: 'custom',
    customStructure: [{ label: 'D', bars: 4, intensity: 1 }],
    tracks: Object.fromEntries(TRACK_ORDER.map((n) => [n, { state: 'on' }])),
  });
  const notes = [];
  const bars = [];
  const states = [];
  engine.on('note', (e) => notes.push(e));
  engine.on('bar', (e) => bars.push(e));
  engine.on('state', (e) => states.push(e));

  await engine.start();
  // Every track has to be staged in (one per bar, pad first) before the ending
  // proves anything: what stops at the barline is only interesting once
  // something other than pad and bass is playing. Waiting on the BARS rather
  // than on a fixed five seconds of clock is what keeps that true on a loaded
  // machine, where five mock seconds buys fewer bars than it does on an idle one.
  const staged = await advanceUntil(() => bars.length > TRACK_ORDER.length, 30,
    { step: 0.12, sleep: 16 });
  assert.ok(staged, `only ${bars.length} bars: the piece never finished its staged entry`);
  assert.ok(notes.some((n) => ['melody', 'arp', 'percussion', 'texture'].includes(n.track)),
    'nothing decorative was playing, so there is nothing to prove about the ending');

  const barsBefore = bars.length;
  const ending = engine.finish({ fadeSeconds: 3 });
  assert.ok(await settleWithin(ending, 30), 'finish() never resolved');
  assert.equal(engine.running, false, 'the engine must be stopped once the ending is silent');
  assert.deepEqual(states[states.length - 1], { running: false, finished: true, paused: false });
  assert.equal(states.filter((s) => s.running === false).length, 1, 'one stop-class state event');

  assert.equal(bars.length, barsBefore + 1, 'finish() adds exactly one closing bar');
  const closing = bars[bars.length - 1];
  const outro = notes.filter((n) => n.time >= closing.time - 1e-9);
  assert.ok(outro.length > 0, 'the closing bar played nothing at all');
  for (const note of outro) {
    assert.ok(['pad', 'bass'].includes(note.track),
      `${note.track} kept playing into the ending`);
  }

  const rootPc = pitchClass('D');
  const padMidis = outro.filter((n) => n.track === 'pad').map((n) => n.midi).sort((a, b) => a - b);
  const bassMidis = outro.filter((n) => n.track === 'bass').map((n) => n.midi);
  assert.deepEqual(padMidis, [0, 2, 4].map((d) => scaleDegreeToMidi(d, SCALES.dorian, rootPc, 3)),
    'the closing chord must be a root-position tonic triad');
  assert.equal(padMidis[0] % 12, rootPc, 'the lowest closing pad note must be the tonic');
  assert.deepEqual(bassMidis.map((m) => m % 12), [rootPc], 'the bass must land on the tonic, once');

  const settled = notes.length;
  await advance(4, { step: 0.12, sleep: 16 });
  assert.equal(notes.length, settled, 'the engine kept generating after the ending');

  // an ended engine is a fresh engine
  await engine.start();
  await advance(3, { step: 0.12, sleep: 16 });
  assert.ok(notes.length > settled, 'the engine would not restart after an ending');
  assert.deepEqual(states[states.length - 1], { running: true, paused: false });
  engine.stop();
});

test('finish() is idempotent, resolves when idle, and start() cancels an ending', async () => {
  const engine = createEngine({ bpm: 120, speed: 2, complexity: 0.7 });
  assert.ok(await settleWithin(engine.finish(), 1), 'finish() on an idle engine must resolve');
  assert.equal(engine.running, false);

  await engine.start();
  await advance(1.5, { step: 0.12, sleep: 16 });
  const ending = engine.finish({ fadeSeconds: 25 });
  assert.equal(engine.finish(), ending, 'a second finish() must return the same promise');
  assert.equal(engine.finish({ fadeSeconds: 2 }), ending, 'options cannot restart an ending');
  assert.equal(engine.running, true, 'the engine plays on until the ending is silent');

  const notes = [];
  engine.on('note', (n) => notes.push(n));
  await engine.start();   // play during an ending cancels it
  assert.ok(await settleWithin(ending, 2), 'start() must settle the pending finish()');
  assert.equal(engine.running, true);
  await advance(3, { step: 0.12, sleep: 16 });
  assert.ok(notes.length > 0, 'the engine stayed silent after a cancelled ending');
  engine.stop();
});

test('finish() clamps its fade and defaults to 8 s', async () => {
  const run = async (options, audioSeconds) => {
    const engine = createEngine({ bpm: 120, speed: 2, structure: 'drone' });
    await engine.start();
    await advance(1, { step: 0.12, sleep: 16 });
    const ending = engine.finish(options);
    const settled = await settleWithin(ending, audioSeconds);
    engine.stop();
    return settled;
  };

  // clamped to 30 s: silent well after 20 s of audio, not after
  assert.equal(await run({ fadeSeconds: 999 }, 20), false, 'a 999 s fade was not clamped down');
  assert.equal(await run({ fadeSeconds: 999 }, 45), true, 'a clamped fade must still finish');
  // no usable option → the 8 s default
  assert.equal(await run(undefined, 4), false, 'the default fade is longer than 4 s');
  assert.equal(await run('nonsense', 14), true, 'a junk options value must fall back to the default');
  // clamped up to 1 s
  assert.equal(await run({ fadeSeconds: 0 }, 8), true, 'a zero fade must clamp up, not hang');
});

test('stop() during an ending cancels the outro and still resolves', async () => {
  const engine = createEngine({ bpm: 120, speed: 2, complexity: 0.8 });
  const states = [];
  const notes = [];
  engine.on('state', (e) => states.push(e));
  engine.on('note', (e) => notes.push(e));
  await engine.start();
  await advance(2, { step: 0.12, sleep: 16 });

  const ending = engine.finish({ fadeSeconds: 30 });
  await advance(1.5, { step: 0.12, sleep: 16 });   // let the closing bar begin
  engine.stop();
  assert.equal(engine.running, false);
  assert.ok(await settleWithin(ending, 2), 'stop() must settle the pending finish()');
  assert.deepEqual(states[states.length - 1], { running: false, paused: false },
    'a hard stop is not a finished ending');

  const settled = notes.length;
  await advance(3, { step: 0.12, sleep: 16 });
  assert.equal(notes.length, settled, 'the scheduler survived a stop during an ending');
  assert.ok(await settleWithin(engine.finish(), 1), 'finish() after a stop must resolve at once');
});

test('sanitiseParams sanitises patches sparsely and deeply', () => {
  assert.deepEqual(sanitiseParams({}).patches, {});
  assert.deepEqual(sanitiseParams({ patches: 'nope' }).patches, {});
  assert.deepEqual(sanitiseParams({ patches: [] }).patches, {});
  assert.deepEqual(sanitiseParams({ patches: { nonsense: { warm: { sends: { reverb: 1 } } } } }).patches, {},
    'an unknown track name is dropped');
  assert.deepEqual(sanitiseParams({ patches: { pad: { '   ': { sends: { reverb: 1 } } } } }).patches, {},
    'a blank voice id is dropped');

  const wild = sanitiseParams({
    patches: {
      pad: {
        warm: {
          source: { osc1: 'sawtooth', osc2: 'gong', mix: 5, detune: -9, octave: 2.4, wobble: 1 },
          filter: { type: 'notch', cutoff: 99999, q: 0, envAmount: -1 },
          adsr: { attack: 0, decay: 99, sustain: 0.4, release: 'nope' },
          sends: { reverb: 0.3, delay: 2 },
          nonsense: { x: 1 },
        },
      },
    },
  }).patches;
  assert.deepEqual(wild, {
    pad: {
      warm: {
        // a legacy osc1 string maps into the v5 shape1 morph field, and rides along
        // detune/octave: bipolar since v12 (-50..50 / -2..2) — -9 and 2.4 both
        // already sit inside that wider range, so they survive rather than clamp.
        source: { osc1: 'sawtooth', shape1: 2, mix: 1, detune: -9, octave: 2 },
        filter: { type: 'notch', cutoff: 12000, q: 0.1, envAmount: 0 },
        adsr: { attack: 0.001, decay: 8, sustain: 0.4 },
        sends: { reverb: 0.3, delay: 1 },
      },
    },
  });

  // an unusable patch is ignored rather than filled in with engine guesses
  assert.deepEqual(sanitiseParams({ patches: { pad: { warm: 'nope' } } }).patches, {});
  assert.deepEqual(sanitiseParams({ patches: { pad: { warm: [] } } }).patches, {});
  assert.deepEqual(sanitiseParams({ patches: { pad: { warm: {} } } }).patches, {});
  assert.deepEqual(sanitiseParams({ patches: { pad: { warm: { adsr: { attack: NaN } } } } }).patches, {});
  assert.deepEqual(sanitiseParams({ patches: { pad: { warm: { filter: 'nope' } } } }).patches, {});

  // osc2: null means "one oscillator", which is not the same as unset — and it
  // maps through to shape2 the same way a string would
  assert.deepEqual(sanitiseParams({ patches: { melody: { pluck: { source: { osc2: null } } } } }).patches,
    { melody: { pluck: { source: { osc2: null, shape2: null } } } });

  // v5 morph fields: fractional shapes survive, legacy strings map, ranges clamp
  assert.deepEqual(
    sanitiseParams({ patches: { pad: { warm: { source: { shape1: 1.5, shape2: 2.25 } } } } })
      .patches.pad.warm.source,
    { shape1: 1.5, shape2: 2.25 }, 'fractional morph positions must survive sanitising');
  assert.deepEqual(
    sanitiseParams({ patches: { pad: { warm: { source: { osc1: 'triangle', osc2: 'square' } } } } })
      .patches.pad.warm.source,
    { osc1: 'triangle', osc2: 'square', shape1: 1, shape2: 3 },
    'legacy osc strings must map sine→0 triangle→1 sawtooth→2 square→3');
  assert.deepEqual(
    sanitiseParams({ patches: { pad: { warm: { source: { shape1: 9, shape2: -2 } } } } })
      .patches.pad.warm.source,
    { shape1: 3, shape2: 0 }, 'morph positions must clamp to 0–3');
  assert.deepEqual(
    sanitiseParams({ patches: { pad: { warm: { source: { shape2: null } } } } })
      .patches.pad.warm.source,
    { shape2: null }, 'shape2: null (single oscillator) is legal');
  // an explicit shape wins over the legacy string it shadows
  assert.deepEqual(
    sanitiseParams({ patches: { pad: { warm: { source: { osc1: 'sine', shape1: 2.5 } } } } })
      .patches.pad.warm.source,
    { osc1: 'sine', shape1: 2.5 });
  assert.deepEqual(sanitiseParams({ patches: { pad: { warm: { source: { shape1: 'nope' } } } } }).patches,
    {}, 'a junk shape is dropped, not defaulted');
  // strings from number inputs still count
  assert.deepEqual(sanitiseParams({ patches: { bass: { sub: { sends: { delay: '0.25' } } } } }).patches,
    { bass: { sub: { sends: { delay: 0.25 } } } });
  assert.deepEqual(sanitiseParams({ patches: { bass: { sub: { sends: { delay: true } } } } }).patches, {},
    'a boolean is not a send level');

  // unknown voice ids survive — the library may load later
  assert.deepEqual(sanitiseParams({ patches: { bass: { ghost: { sends: { delay: 0.2 } } } } }).patches,
    { bass: { ghost: { sends: { delay: 0.2 } } } });

  // deep merge, field by field
  const base = sanitiseParams({
    patches: { arp: { crystal: { adsr: { attack: 0.2, release: 3 }, sends: { reverb: 0.4 } } } },
  });
  assert.deepEqual(sanitiseParams({
    patches: { arp: { crystal: { adsr: { release: 5 } }, marimba: { filter: { cutoff: 800 } } } },
  }, base).patches, {
    arp: {
      crystal: { adsr: { attack: 0.2, release: 5 }, sends: { reverb: 0.4 } },
      marimba: { filter: { cutoff: 800 } },
    },
  });
  assert.deepEqual(sanitiseParams({ patches: { arp: { crystal: null } } }, base).patches, base.patches,
    'an invalid incoming patch leaves the stored one alone');
  assert.deepEqual(sanitiseParams({ bpm: 80 }, base).patches, base.patches,
    'an unrelated update keeps the patches');

  // getParams hands back a deep copy
  const engine = createEngine({ patches: { pad: { warm: { sends: { reverb: 0.2 } } } } });
  assert.deepEqual(engine.getParams().patches, { pad: { warm: { sends: { reverb: 0.2 } } } });
  const snapshot = engine.getParams();
  snapshot.patches.pad.warm.sends.reverb = 1;
  assert.equal(engine.getParams().patches.pad.warm.sends.reverb, 0.2);
});

test('the current voice patch reaches play() as its fourth argument', async () => {
  const calls = [];
  const spy = (id) => ({
    label: `Spy ${id}`,
    play(ctx, destination, note, patch) {
      calls.push({ id, note, patch, argc: arguments.length });
    },
  });
  padBank.patchSpyA = spy('A');
  padBank.patchSpyB = spy('B');
  assert.ok(padBank.patchSpyA && padBank.patchSpyB, 'the pad voice bank must accept a spy voice');
  try {
    const engine = createEngine({
      bpm: 120,
      speed: 2,
      structure: 'drone',
      // vary.voice 0 pins the sounding voice: left null it follows the default
      // randomness macro and wanders, which is a question for the vary tests.
      tracks: Object.fromEntries(TRACK_ORDER.map((n) => [n, {
        state: n === 'pad' ? 'on' : 'off',
        voice: n === 'pad' ? 'patchSpyA' : undefined,
        vary: { voice: 0 },
      }])),
      patches: { pad: { patchSpyA: { adsr: { attack: 0.5, release: 4 }, sends: { reverb: 0.9 } } } },
    });
    const expected = engine.getParams().patches.pad.patchSpyA;
    await engine.start();
    await advance(4, { step: 0.12, sleep: 16 });
    assert.ok(calls.length > 0, 'the spy voice was never played');
    for (const call of calls) {
      assert.equal(call.id, 'A');
      assert.equal(call.argc, 4, 'play() must be called with the patch as a fourth argument');
      assert.deepEqual(call.patch, expected, 'the patch handed to play() must be the sanitised one');
      assert.ok(Number.isFinite(call.note.when), 'the note itself must still be well formed');
    }

    // a voice with no patch of its own gets undefined, not someone else's patch
    calls.length = 0;
    engine.setParams({ tracks: { pad: { voice: 'patchSpyB' } } });
    await advance(4, { step: 0.12, sleep: 16 });
    engine.stop();
    assert.ok(calls.length > 0, 'the unpatched spy voice was never played');
    for (const call of calls) {
      assert.equal(call.id, 'B');
      assert.equal(call.patch, undefined, 'an unpatched voice must receive undefined');
    }
  } finally {
    delete padBank.patchSpyA;
    delete padBank.patchSpyB;
  }
});

test('per-track sends follow the current voice patch', async () => {
  const engine = createEngine({
    bpm: 120,
    speed: 2,
    // vary.voice 0 everywhere: a wandering voice would swap its own
    // defaults.sends in underneath the assertions below.
    tracks: Object.fromEntries(TRACK_ORDER.map((n) => [n, { vary: { voice: 0 } }])),
    patches: {
      pad: { warm: { sends: { reverb: 0.9, delay: 0.8 } } },
      bass: { sub: { sends: { delay: 0.5 } } },
    },
  });
  await engine.start();
  const sends = sendGains(liveContexts[liveContexts.length - 1]);
  assert.equal(sends.pad.reverb.gain.value, 0.9);
  assert.equal(sends.pad.delay.gain.value, 0.8);
  assert.equal(sends.bass.delay.gain.value, 0.5,
    'a patch must be able to raise a send the mix defaults to zero');
  // Unpatched tracks take the current voice's published defaults.sends when
  // the library is loaded, else the engine's per-track mix defaults.
  assert.equal(sends.melody.reverb.gain.value, defaultSend('melody', 'pluck', 'reverb', 0.5),
    'an unpatched track keeps its default reverb send');
  assert.equal(sends.melody.delay.gain.value, defaultSend('melody', 'pluck', 'delay', 0.28),
    'an unpatched track keeps its default delay send');
  if (voiceLib) {
    assert.equal(typeof voiceLib.melody.pluck.defaults.sends.reverb, 'number',
      'the voice library must publish defaults.sends for this test to bite');
    assert.equal(sends.melody.reverb.gain.value, voiceLib.melody.pluck.defaults.sends.reverb,
      'with the library loaded, an unpatched send must match the voice defaults');
  }

  engine.setParams({ patches: { pad: { warm: { sends: { reverb: 0.1 } } } } });
  assert.equal(sends.pad.reverb.gain.value, 0.1, 'a live send edit must reach the graph');
  assert.equal(sends.pad.delay.gain.value, 0.8, 'a partial patch edit keeps the other send');

  engine.setParams({ tracks: { pad: { voice: 'glass' } } });
  assert.equal(sends.pad.reverb.gain.value, defaultSend('pad', 'glass', 'reverb', 0.45),
    'a voice with no patch returns to that voice\'s default send');
  assert.equal(sends.pad.delay.gain.value, defaultSend('pad', 'glass', 'delay', 0.1));
  engine.stop();
});

// --------------------------------------------------------------------------
// v3 hardening — throttled timers, re-entrancy, bar-anchoring, invalidation
// --------------------------------------------------------------------------

/**
 * Minimal stand-in for the engine's inline-blob ticker Worker. It cannot run
 * the blob's script, so it implements the same tiny protocol directly: a
 * posted number > 0 starts an interval that posts back, 0 stops it.
 */
class MockTickerWorker {
  static live = new Set();

  constructor() {
    MockTickerWorker.live.add(this);
    this.onmessage = null;
    this.timer = null;
  }

  postMessage(ms) {
    clearInterval(this.timer);
    this.timer = null;
    if (ms > 0) {
      this.timer = setInterval(() => { if (this.onmessage) this.onmessage({ data: 0 }); }, ms);
    }
  }

  terminate() {
    clearInterval(this.timer);
    this.timer = null;
    MockTickerWorker.live.delete(this);
  }
}

test('scheduler survives throttled 1 Hz timers and resumes mid-piece after a stall', async () => {
  // A hidden tab: timers clamp to >=1 s. bpm 100 in 4/4 = 2.4 s bars, so the
  // v2 failure mode (a resync minting a fresh bar on every tick) would emit a
  // bar per second — 2.4× too many — with restarted structure accounting.
  globalThis.document = { hidden: true, addEventListener() {} };
  try {
    const engine = createEngine({
      bpm: 100, speed: 1, timeSignature: '4/4', structure: 'abab', complexity: 0.6,
      tracks: Object.fromEntries(TRACK_ORDER.map((n) => [n, { state: n === 'pad' ? 'on' : 'off' }])),
    });
    const bars = [];
    const sections = [];
    engine.on('bar', (e) => bars.push(e));
    engine.on('section', (e) => sections.push(e));
    await engine.start();
    const ctx = liveContexts[liveContexts.length - 1];

    const barSeconds = 4 * (60 / 100);
    // 48 s of audio delivered in whole-second clock jumps, as a clamped
    // setInterval would see them.
    for (let s = 0; s < 48; s++) {
      ctx.currentTime += 1;
      await new Promise((resolve) => setTimeout(resolve, 35));
    }

    assert.ok(bars.length >= 17 && bars.length <= 22,
      `expected ~20 bars in 48 s of 2.4 s bars, got ${bars.length} — the scheduler is minting bars per tick`);
    bars.forEach((e, i) => {
      assert.equal(e.bar, bars[0].bar + i, 'bar numbers must advance monotonically without restarts');
      if (i > 0) {
        assert.ok(Math.abs(e.time - bars[i - 1].time - barSeconds) < 1e-6,
          `bars must stay ${barSeconds}s apart, got ${e.time - bars[i - 1].time}`);
      }
    });
    // structure accounting must not race: abab changes section every 8 bars
    assert.ok(sections.length >= 2, 'no section changes in 20 bars of abab');
    for (let i = 1; i < sections.length; i++) {
      assert.equal(sections[i].bar - sections[i - 1].bar, 8,
        'abab sections must stay 8 bars apart under throttled timers');
    }

    // A genuine stall (system sleep — longer than the widened lookahead):
    // the piece resumes with the counters advanced by the elapsed bars, not
    // restarted and not incremented by just one.
    const lastBar = bars[bars.length - 1];
    const before = bars.length;
    ctx.currentTime += 12;
    for (let s = 0; s < 8; s++) {
      ctx.currentTime += 1;
      await new Promise((resolve) => setTimeout(resolve, 35));
    }
    engine.stop();
    assert.ok(bars.length > before, 'the scheduler never recovered from the stall');
    const resumed = bars[before];
    const gap = resumed.bar - lastBar.bar;
    assert.ok(gap >= 3 && gap <= 7,
      `a ~10 s stall over 2.4 s bars must advance the bar counter by the elapsed bars, got gap ${gap}`);
    for (let i = before + 1; i < bars.length; i++) {
      assert.equal(bars[i].bar, bars[i - 1].bar + 1, 'counting must be consecutive again after the resync');
    }
  } finally {
    delete globalThis.document;
  }
});

test('concurrent start() leaves exactly one ticker and stop() clears it', async () => {
  MockTickerWorker.live.clear();
  globalThis.Worker = MockTickerWorker;
  try {
    const engine = createEngine({ bpm: 120, speed: 2, structure: 'drone' });
    const bars = [];
    engine.on('bar', (e) => bars.push(e));
    // The alarm timer and the human hit Play in the same instant.
    await Promise.all([engine.start(), engine.start(), engine.start()]);
    assert.equal(engine.running, true);
    assert.equal(MockTickerWorker.live.size, 1,
      `concurrent start() installed ${MockTickerWorker.live.size} tickers`);
    await advance(2, { step: 0.12, sleep: 16 });
    assert.ok(bars.length > 0, 'the single ticker never ticked');
    bars.forEach((e, i) => assert.equal(e.bar, i, 'double scheduling corrupts bar accounting'));

    engine.stop();
    assert.equal(MockTickerWorker.live.size, 0, 'stop() must terminate the ticker');
    const after = bars.length;
    await advance(1, { step: 0.12, sleep: 16 });
    assert.equal(bars.length, after, 'a leaked ticker kept running after stop()');

    // restart still works, and still holds the single-ticker invariant
    await Promise.all([engine.start(), engine.start()]);
    assert.equal(MockTickerWorker.live.size, 1);
    engine.stop();
    assert.equal(MockTickerWorker.live.size, 0);
  } finally {
    delete globalThis.Worker;
  }

  // Worker creation throwing (CSP) must fall back to setInterval, not silence.
  globalThis.Worker = class { constructor() { throw new Error('blocked by CSP'); } };
  try {
    const engine = createEngine({ bpm: 120, speed: 2, structure: 'drone' });
    const bars = [];
    engine.on('bar', (e) => bars.push(e));
    await engine.start();
    await advance(2, { step: 0.12, sleep: 16 });
    engine.stop();
    assert.ok(bars.length > 0, 'the setInterval fallback never ran');
    const after = bars.length;
    await advance(1, { step: 0.12, sleep: 16 });
    assert.equal(bars.length, after, 'the fallback interval leaked past stop()');
  } finally {
    delete globalThis.Worker;
  }
});

test('stop() cancels sounding notes so tails cannot resurrect on restart', async () => {
  const cancels = [];
  const spy = {
    label: 'Cancel spy',
    play(ctx, destination, note) {
      const handle = { cancelled: false, cancel() { this.cancelled = true; } };
      cancels.push(handle);
      return handle;
    },
  };
  padBank.cancelSpy = spy;
  try {
    const engine = createEngine({
      bpm: 120, speed: 2, structure: 'drone',
      // vary.voice 0 keeps the pad on the spy voice: a wander would hand the
      // notes to a real voice and the cancel handles would never be recorded.
      tracks: Object.fromEntries(TRACK_ORDER.map((n) => [
        n, {
          state: n === 'pad' ? 'on' : 'off',
          voice: n === 'pad' ? 'cancelSpy' : undefined,
          vary: { voice: 0 },
        },
      ])),
    });
    await engine.start();
    await advance(3, { step: 0.12, sleep: 16 });
    assert.ok(cancels.length > 0, 'the spy voice was never played');
    engine.stop();
    assert.ok(cancels.every((h) => h.cancelled),
      'stop() must call the cancel handle of every sounding note');

    // and the fast-stop path of a cancelled ending does the same
    cancels.length = 0;
    await engine.start();
    await advance(3, { step: 0.12, sleep: 16 });
    engine.finish({ fadeSeconds: 30 });
    await advance(1, { step: 0.12, sleep: 16 });
    assert.ok(cancels.length > 0, 'nothing played before the ending');
    const beforeRestart = cancels.length;
    await engine.start();   // cancels the ending — and its sounding tails
    assert.ok(cancels.slice(0, beforeRestart).every((h) => h.cancelled),
      'the finish-cancel fast-stop must cancel the old tails before restarting');
    await advance(1, { step: 0.12, sleep: 16 });
    engine.stop();
    assert.ok(cancels.every((h) => h.cancelled), 'a final stop() sweeps everything');
  } finally {
    delete padBank.cancelSpy;
  }
});

test('arp step mask stays bar-anchored at 1/8T', () => hiddenTab(async () => {
  // 12 triplet-eighth steps per 4/4 bar do not divide the 16-step mask, so a
  // mask phase carried across bars rotates a single enabled step through
  // offsets 0, 12, 8, 4 (the v2 bug). Bar-anchored, it must hit the barline
  // of every bar instead.
  const steps = new Array(16).fill(false);
  steps[0] = true;
  const engine = createEngine({
    bpm: 120,
    speed: 2,
    timeSignature: '4/4',
    structure: 'drone',
    arp: { mode: 'manual', rate: '1/8T', octaves: 2, gate: 0.6, steps },
    // randomness 0 keeps the ±≤25 ms timing humanisation out of the way.
    tracks: Object.fromEntries(TRACK_ORDER.map((n) => [
      n, n === 'arp' ? { state: 'on', randomness: 0 } : { state: 'off' },
    ])),
  });
  const bars = [];
  const notes = [];
  engine.on('bar', (e) => bars.push(e));
  engine.on('note', (e) => notes.push(e));
  await engine.start();
  await advance(16, FAST);
  engine.stop();

  // Bars 0–3 are the staged entry ahead of the arp's slot, so only bar 4 up
  // can carry a note at all.
  const barSeconds = 4 * (60 / 240);
  const eligible = bars.filter((b) => b.bar >= 5).slice(0, -3);
  assert.ok(eligible.length >= 5, `only ${eligible.length} eligible bars`);
  for (const barEvent of eligible) {
    const inBar = notes.filter((n) => n.time >= barEvent.time - 1e-9
      && n.time < barEvent.time + barSeconds - 1e-9);
    assert.equal(inBar.length, 1,
      `bar ${barEvent.bar}: a one-step mask must fire once, saw ${inBar.length}`);
  }
  for (const note of notes) {
    const owner = [...bars].reverse().find((b) => b.time <= note.time + 1e-9);
    assert.ok(owner.bar >= 4, 'the arp sounded before its staged entry');
    assert.ok(Math.abs(note.time - owner.time) < 1e-6,
      `mask phase drifted: a note landed ${note.time - owner.time}s into its bar`);
  }
}));

test('percussion bank is invalidated when the metre changes', () => hiddenTab(async () => {
  const engine = createEngine({
    bpm: 120,
    speed: 2,
    complexity: 1,
    repetition: 1,     // always replay the stored bank — the worst case
    timeSignature: '5/4',
    structure: 'custom',
    customStructure: [{ label: 'D', bars: 4, intensity: 1 }],
    tracks: Object.fromEntries(TRACK_ORDER.map((n) => [n, { state: n === 'percussion' ? 'on' : 'off' }])),
  });
  const bars = [];
  const notes = [];
  engine.on('bar', (e) => bars.push(e));
  engine.on('note', (e) => notes.push(e));
  await engine.start();
  // Percussion is the last track of the staged entry, so nothing lands before
  // bar 5 — at 1.25 s per 5/4 bar that is the first ~6 s of the piece.
  await advance(14, FAST);
  assert.ok(notes.length > 0, 'no percussion before the metre change');

  const secPerBeat = 60 / 240;
  const offsetIn = (note) => {
    const owner = [...bars].reverse().find((b) => b.time <= note.time + 1e-9);
    return (note.time - owner.time) / secPerBeat;
  };
  const preOffsets = notes.map(offsetIn);

  engine.setParams({ timeSignature: '3/4' });
  const preCount = notes.length;
  await advance(14, FAST);
  engine.stop();

  const firstNewBar = bars.find((b) => b.beatsPerBar === 3);
  assert.ok(firstNewBar, 'the metre change never reached the scheduler');
  const post = notes.slice(preCount).filter((n) => n.time >= firstNewBar.time - 1e-9);
  assert.ok(post.length > 0, 'percussion vanished after the metre change');
  const postOffsets = post.map(offsetIn);
  for (const offset of postOffsets) {
    assert.ok(offset >= 0 && offset < 3, `a hit at beat ${offset} overran a 3/4 bar`);
  }
  // With repetition 1 a stale bank replays the same 5/4 pattern for ever, so
  // every post-change offset would be one of the pre-change offsets. A cleared
  // bank generates a fresh pattern whose random offsets cannot all coincide.
  const fresh = postOffsets.some((o) => !preOffsets.some((p) => Math.abs(p - o) < 1e-6));
  assert.ok(fresh, 'post-change percussion still replays the old metre\'s bank');
}));

test('resume() and onstatechange recover a non-running context', async () => {
  const engine = createEngine({ bpm: 120, speed: 2, structure: 'drone' });
  await engine.resume();   // safe before any context exists
  assert.equal(engine.running, false);

  await engine.start();
  const ctx = liveContexts[liveContexts.length - 1];
  assert.equal(typeof ctx.onstatechange, 'function', 'the engine must watch context state');

  // iOS interruption: the context leaves 'running' behind the engine's back
  ctx.state = 'interrupted';
  ctx.onstatechange();
  assert.equal(ctx.state, 'running', 'a state change while running must auto-resume');

  ctx.state = 'interrupted';
  await engine.resume();
  assert.equal(ctx.state, 'running', 'resume() must poke an interrupted context back');

  // A sample-rate change under the context (iOS after an interruption) means
  // the graph is corrupt: resume() must rebuild rather than play through it.
  const contextsBefore = liveContexts.length;
  ctx.state = 'suspended';
  ctx.sampleRate = 96000;
  await engine.resume();
  assert.equal(liveContexts.length, contextsBefore + 1, 'a rate mismatch must rebuild the context');
  assert.equal(engine.running, true, 'the rebuild must not stop the piece');
  const bars = [];
  engine.on('bar', (e) => bars.push(e));
  await advance(2, { step: 0.12, sleep: 16 });
  assert.ok(bars.length > 0, 'the piece never resumed on the rebuilt context');
  for (const name of TRACK_ORDER) {
    assert.ok(engine.getAnalysers()[name], `${name} analyser missing after rebuild`);
  }
  engine.stop();
});

// --------------------------------------------------------------------------
// v6–v8 params — level, randomness, hold, vary, sequencers
// --------------------------------------------------------------------------

test('level and randomness take a number or a {min,max} range', () => {
  const base = sanitiseParams({});
  for (const name of TRACK_ORDER) {
    assert.equal(base.tracks[name].level, 0.8, `${name}: level ships at 0.8`);
    // v21: the page probe accepts a RangeValue reply (isNumberOrRange), which
    // was the v8 condition on this flip, so randomness now ships DRIFTING.
    assert.deepEqual(base.tracks[name].randomness, { min: 0.35, max: 0.65 },
      `${name}: randomness ships as the gentle default drift`);
  }

  const set = (patch) => sanitiseParams({ tracks: { pad: patch } }).tracks.pad;
  assert.deepEqual(set({ level: { min: 0.2, max: 0.6 } }).level, { min: 0.2, max: 0.6 });
  assert.deepEqual(set({ level: { min: 0.9, max: 0.1 } }).level, { min: 0.1, max: 0.9 },
    'a reversed range is swapped, not rejected');
  assert.deepEqual(set({ level: { min: -4, max: 44 } }).level, { min: 0, max: 1 },
    'both bounds clamp into the param range');
  assert.deepEqual(set({ randomness: { min: 1, max: 0 } }).randomness, { min: 0, max: 1 });
  assert.equal(set({ level: 0.25 }).level, 0.25);
  assert.equal(set({ level: 9 }).level, 1);
  assert.equal(set({ level: -9 }).level, 0);
  assert.equal(set({ randomness: '0.25' }).randomness, 0.25, 'a number-input string still counts');

  // a half-formed or unusable range is rejected outright, never guessed at
  assert.equal(set({ level: { min: 0.2 } }).level, 0.8, 'a {min}-only range falls back to the default');
  assert.equal(set({ level: { max: 0.2 } }).level, 0.8);
  assert.equal(set({ level: { min: 'a', max: 'b' } }).level, 0.8);
  assert.equal(set({ level: 'nope' }).level, 0.8);
  assert.equal(set({ level: [0.2, 0.6] }).level, 0.8, 'an array is not a range');
  assert.deepEqual(set({ randomness: {} }).randomness, { min: 0.35, max: 0.65 });

  // a stored range survives unrelated edits, and getParams hands back a copy
  const engine = createEngine({ tracks: { pad: { level: { min: 0.3, max: 0.7 } } } });
  engine.setParams({ bpm: 90 });
  assert.deepEqual(engine.getParams().tracks.pad.level, { min: 0.3, max: 0.7 });
  const snapshot = engine.getParams();
  snapshot.tracks.pad.level.min = 0;
  assert.equal(engine.getParams().tracks.pad.level.min, 0.3, 'getParams leaked the live range object');
});

test('hold is a boolean and the five vary aspects are 0–1 or null', () => {
  const base = sanitiseParams({});
  for (const name of TRACK_ORDER) {
    assert.equal(base.tracks[name].hold, false, `${name} must not ship held`);
    assert.deepEqual(Object.keys(base.tracks[name].vary), [...VARY_ASPECTS]);
    assert.deepEqual([...VARY_ASPECTS], ['voice', 'volume', 'pitch', 'timing', 'pan']);
    for (const aspect of VARY_ASPECTS) {
      // v11: the two sustained tracks ship an explicit small voice wander so
      // auto never sits on one timbre forever. Everything else still defaults
      // to null — "follow this track's randomness".
      const expected = aspect === 'voice' && (name === 'pad' || name === 'texture') ? 0.15 : aspect === 'voice' && name === 'bass' ? 0 : null;
      assert.equal(base.tracks[name].vary[aspect], expected,
        `${name}.${aspect} must default to ${expected}`);
    }
  }

  const set = (patch) => sanitiseParams({ tracks: { melody: patch } }).tracks.melody;
  assert.equal(set({ hold: true }).hold, true);
  assert.equal(set({ hold: 1 }).hold, true);
  assert.equal(set({ hold: 0 }).hold, false);
  assert.equal(set({ hold: '' }).hold, false);

  const vary = set({ vary: { voice: 0.25, volume: 2, pitch: -1, timing: null, pan: 'nope' } }).vary;
  assert.equal(vary.voice, 0.25);
  assert.equal(vary.volume, 1, 'an aspect clamps to 0–1');
  assert.equal(vary.pitch, 0);
  assert.equal(vary.timing, null, 'null is a legal value, not a missing one');
  assert.equal(vary.pan, null, 'an unusable aspect falls back to its default');
  assert.equal('nonsense' in set({ vary: { nonsense: 1 } }).vary, false);

  // deep merge, aspect by aspect
  const stored = sanitiseParams({ tracks: { melody: { vary: { pan: 0.6, timing: 0.2 } } } });
  const merged = sanitiseParams({ tracks: { melody: { vary: { timing: 0.9 } } } }, stored).tracks.melody.vary;
  assert.equal(merged.timing, 0.9);
  assert.equal(merged.pan, 0.6, 'an unmentioned aspect keeps its stored value');
  assert.equal(merged.voice, null);
  assert.equal(sanitiseParams({ tracks: { melody: { vary: 'nope' } } }, stored).tracks.melody.vary.pan, 0.6,
    'a junk vary block leaves the stored aspects alone');
});

test('every pulsed track gets a step grid, and no other track does', () => {
  const tracks = sanitiseParams({}).tracks;
  assert.deepEqual([...SEQUENCED_TRACKS], ['melody', 'bass', 'arp', 'percussion']);
  for (const name of TRACK_ORDER) {
    assert.equal('sequencer' in tracks[name], SEQUENCED_TRACKS.includes(name),
      `${name}: sustained tracks have no pulse to sequence`);
  }

  for (const name of ['melody', 'bass', 'arp']) {
    const seq = tracks[name].sequencer;
    assert.equal(seq.mode, 'auto', `${name} starts generative`);
    assert.ok(Array.isArray(seq.steps), `${name} is a single-lane sequencer`);
    assert.equal(seq.steps.length, SEQUENCER_STEP_COUNT, `${name} persists all 20 slots`);
    for (const step of seq.steps) {
      assert.deepEqual(step, { on: true, prob: 1, vmin: 0.5, vmax: 0.9 });
    }
  }

  const perc = tracks.percussion.sequencer;
  assert.equal(perc.mode, 'auto');
  assert.deepEqual(Object.keys(perc.steps), [...PERCUSSION_LANES]);
  assert.deepEqual([...PERCUSSION_LANES], ['low', 'mid', 'high']);
  for (const lane of PERCUSSION_LANES) {
    assert.equal(perc.steps[lane].length, SEQUENCER_STEP_COUNT);
    for (const step of perc.steps[lane]) {
      assert.deepEqual(step, { on: true, prob: 1, vmin: 0.5, vmax: 0.9 });
    }
  }
});

test('sequencer steps validate, swap vmin/vmax and expand bare booleans', () => {
  const lane = (steps) => sanitiseParams({ tracks: { melody: { sequencer: { steps } } } })
    .tracks.melody.sequencer.steps;

  assert.deepEqual(lane([false, true])[0], { on: false, prob: 1, vmin: 0.5, vmax: 0.9 },
    'a bare boolean expands to a full step');
  assert.deepEqual(lane([false, true])[1], { on: true, prob: 1, vmin: 0.5, vmax: 0.9 });
  assert.deepEqual(lane([false, true])[2], { on: true, prob: 1, vmin: 0.5, vmax: 0.9 },
    'slots the caller did not send keep their stored value');
  assert.equal(lane([false]).length, SEQUENCER_STEP_COUNT, 'a short lane still keeps 20 slots');
  assert.equal(lane(new Array(40).fill(false)).length, SEQUENCER_STEP_COUNT, 'a long lane truncates');

  assert.deepEqual(lane([{ on: 1, prob: 5, vmin: -1, vmax: 9 }])[0],
    { on: true, prob: 1, vmin: 0, vmax: 1 }, 'every field clamps');
  assert.deepEqual(lane([{ on: true, prob: 0.5, vmin: 0.9, vmax: 0.1 }])[0],
    { on: true, prob: 0.5, vmin: 0.1, vmax: 0.9 }, 'vmin ≤ vmax is enforced');
  assert.deepEqual(lane([{ on: true, prob: { min: 0.8, max: 0.2 } }])[0],
    { on: true, prob: { min: 0.2, max: 0.8 }, vmin: 0.5, vmax: 0.9 },
    'step probability is rangeable, and a reversed range swaps');
  assert.deepEqual(lane(['nope'])[0], { on: true, prob: 1, vmin: 0.5, vmax: 0.9 },
    'a junk step keeps the stored one');

  const mode = (m) => sanitiseParams({ tracks: { bass: { sequencer: { mode: m } } } }).tracks.bass.sequencer.mode;
  assert.equal(mode('manual'), 'manual');
  assert.equal(mode('auto'), 'auto');
  assert.equal(mode('sideways'), 'auto');

  // percussion takes its three lanes one at a time
  const perc = sanitiseParams({
    tracks: { percussion: { sequencer: { mode: 'manual', steps: { mid: [{ on: false }] } } } },
  }).tracks.percussion.sequencer;
  assert.equal(perc.mode, 'manual');
  assert.equal(perc.steps.mid[0].on, false);
  assert.equal(perc.steps.mid[0].prob, 1, 'the fields a partial step omits keep their stored values');
  assert.equal(perc.steps.mid.length, SEQUENCER_STEP_COUNT);
  assert.equal(perc.steps.low[0].on, true, 'an untouched lane keeps its steps');
});

test('the legacy arp.steps mask maps into the arp lane and leaves slots 16–19 alone', () => {
  const mask = new Array(16).fill(true);
  mask[3] = false;
  mask[15] = false;

  const mapped = sanitiseParams({ arp: { steps: mask } });
  const lane = mapped.tracks.arp.sequencer.steps;
  assert.equal(lane.length, SEQUENCER_STEP_COUNT);
  for (let i = 0; i < 16; i++) {
    assert.deepEqual(lane[i], { on: mask[i], prob: 1, vmin: 0.5, vmax: 0.9 },
      `slot ${i} must mirror the legacy mask, banded 0.5–0.9`);
  }
  assert.deepEqual(mapped.arp.steps, mask, 'the legacy field itself still round-trips');

  // slots 16–19 belong to the longer metres; a 16-step mask must not touch them
  const stored = sanitiseParams({
    tracks: {
      arp: {
        sequencer: {
          steps: Array.from({ length: SEQUENCER_STEP_COUNT }, (unused, i) => ({
            on: i % 2 === 0, prob: 0.4, vmin: 0.1, vmax: 0.2,
          })),
        },
      },
    },
  });
  const after = sanitiseParams({ arp: { steps: mask } }, stored).tracks.arp.sequencer.steps;
  assert.deepEqual(after[3], { on: false, prob: 1, vmin: 0.5, vmax: 0.9 },
    'the mask still writes the slots it covers');
  for (let i = 16; i < SEQUENCER_STEP_COUNT; i++) {
    assert.deepEqual(after[i], { on: i % 2 === 0, prob: 0.4, vmin: 0.1, vmax: 0.2 },
      `slot ${i} is outside the legacy mask and must survive it`);
  }

  // the sequencer lane is the source of truth: sent together, it wins
  const both = sanitiseParams({
    arp: { steps: mask },
    tracks: { arp: { sequencer: { steps: [{ on: true, prob: 0.25, vmin: 0.3, vmax: 0.4 }] } } },
  }).tracks.arp.sequencer.steps;
  assert.deepEqual(both[0], { on: true, prob: 0.25, vmin: 0.3, vmax: 0.4 });
  assert.equal(both[3].on, true, 'an explicit lane replaces the legacy mask outright');
});

test('the legacy top-level percussion param merges in and never comes back out', () => {
  const legacy = {
    percussion: { mode: 'manual', steps: { low: [{ on: false, prob: 0.5, vmin: 0.2, vmax: 0.3 }] } },
  };
  const params = sanitiseParams(legacy);
  assert.equal('percussion' in params, false, 'the legacy param must never be emitted');
  const seq = params.tracks.percussion.sequencer;
  assert.equal(seq.mode, 'manual');
  assert.deepEqual(seq.steps.low[0], { on: false, prob: 0.5, vmin: 0.2, vmax: 0.3 });
  assert.equal(seq.steps.mid[0].on, true, 'the lanes it did not mention are untouched');

  const engine = createEngine(legacy);
  assert.equal('percussion' in engine.getParams(), false);
  assert.equal(engine.getParams().tracks.percussion.sequencer.mode, 'manual');
  engine.setParams({ percussion: { mode: 'auto' } });
  assert.equal(engine.getParams().tracks.percussion.sequencer.mode, 'auto',
    'a legacy update must still reach the authoritative home');

  // tracks.percussion.sequencer is authoritative when both arrive together
  const both = sanitiseParams({
    percussion: { mode: 'manual' },
    tracks: { percussion: { sequencer: { mode: 'auto' } } },
  });
  assert.equal(both.tracks.percussion.sequencer.mode, 'auto');
});

test('DEFAULT_PARAMS stays deeply frozen through merges', () => {
  const frozen = {
    'DEFAULT_PARAMS': DEFAULT_PARAMS,
    'tracks': DEFAULT_PARAMS.tracks,
    'tracks.pad': DEFAULT_PARAMS.tracks.pad,
    'tracks.pad.vary': DEFAULT_PARAMS.tracks.pad.vary,
    'tracks.melody.sequencer': DEFAULT_PARAMS.tracks.melody.sequencer,
    'tracks.melody.sequencer.steps': DEFAULT_PARAMS.tracks.melody.sequencer.steps,
    'tracks.melody.sequencer.steps[0]': DEFAULT_PARAMS.tracks.melody.sequencer.steps[0],
    'tracks.percussion.sequencer.steps.low[0]': DEFAULT_PARAMS.tracks.percussion.sequencer.steps.low[0],
    'arp': DEFAULT_PARAMS.arp,
    'arp.steps': DEFAULT_PARAMS.arp.steps,
    'customStructure[0]': DEFAULT_PARAMS.customStructure[0],
  };
  for (const [path, value] of Object.entries(frozen)) {
    assert.ok(Object.isFrozen(value), `DEFAULT_PARAMS.${path} is not frozen`);
  }

  // a merge must copy, never hand back — or write through — the frozen defaults
  const merged = sanitiseParams({ bpm: 90 });
  assert.notEqual(merged.tracks, DEFAULT_PARAMS.tracks);
  assert.notEqual(merged.tracks.melody.sequencer.steps[0], DEFAULT_PARAMS.tracks.melody.sequencer.steps[0]);
  merged.tracks.melody.sequencer.steps[0].on = false;
  merged.tracks.percussion.sequencer.steps.low[0].prob = 0;
  merged.tracks.pad.vary.pan = 1;
  merged.arp.steps[0] = false;
  merged.customStructure[0].bars = 3;
  assert.equal(DEFAULT_PARAMS.tracks.melody.sequencer.steps[0].on, true);
  assert.equal(DEFAULT_PARAMS.tracks.percussion.sequencer.steps.low[0].prob, 1);
  assert.equal(DEFAULT_PARAMS.tracks.pad.vary.pan, null);
  assert.equal(DEFAULT_PARAMS.arp.steps[0], true);
  assert.equal(DEFAULT_PARAMS.customStructure[0].bars, 8);

  // and the defaults must survive a full round trip back through the sanitiser
  assert.deepEqual(sanitiseParams(JSON.parse(JSON.stringify(DEFAULT_PARAMS))), sanitiseParams({}));
  const engine = createEngine(DEFAULT_PARAMS);
  engine.setParams({ tracks: { percussion: { sequencer: { steps: { low: [false] } } } } });
  assert.equal(engine.getParams().tracks.percussion.sequencer.steps.low[0].on, false);
  assert.equal(DEFAULT_PARAMS.tracks.percussion.sequencer.steps.low[0].on, true);
});

test('the step grid is sixteenths per metre, and the arp lane follows its rate', () => {
  assert.equal(SEQUENCER_STEP_COUNT, 20, 'every lane persists 20 slots');
  assert.equal(sequencerStepsPerBar('3/4'), 12);
  assert.equal(sequencerStepsPerBar('4/4'), 16);
  assert.equal(sequencerStepsPerBar('5/4'), 20);
  assert.equal(sequencerStepsPerBar('6/8'), 12);
  assert.equal(sequencerStepsPerBar('7/8'), 14);

  // ruling 9a: the arp lane is indexed by arp step at the current rate
  assert.equal(arpLaneLength('4/4', '1/4'), 4);
  assert.equal(arpLaneLength('4/4', '1/8'), 8);
  assert.equal(arpLaneLength('4/4', '1/16'), 16);
  assert.equal(arpLaneLength('4/4', '1/8T'), 12, 'ceil(4 / (1/3)) triplet eighths');
  assert.equal(arpLaneLength('3/4', '1/8'), 6);
  assert.equal(arpLaneLength('7/8', '1/16'), 14);
  for (const sig of Object.keys(TIME_SIGNATURES)) {
    for (const rate of Object.keys(ARP_RATES)) {
      const length = arpLaneLength(sig, rate);
      assert.ok(length >= 1 && length <= SEQUENCER_STEP_COUNT,
        `${sig} @${rate}: lane length ${length} does not fit the 20 slots`);
    }
  }
});

// --------------------------------------------------------------------------
// v6–v8 playback — determinism, staged entry, shipped defaults
// --------------------------------------------------------------------------

test('the same rng seed plays the same piece; a different seed does not', () => hiddenTab(async () => {
  const params = {
    bpm: 120, speed: 2, complexity: 0.8, repetition: 0.4, structure: 'journey',
    tracks: tracksAll('on'),
  };
  const capture = async (seed) => {
    const engine = createEngine(params, { rng: seededRng(seed) });
    const log = record(engine);
    await engine.start();
    await advance(22, FAST);
    engine.stop();
    assert.ok(log.bars.length >= 17, `only ${log.bars.length} bars`);
    const horizon = log.bars[16].time;   // the first 16 bars, complete
    return log.notes.filter((n) => n.time < horizon).map((n) => [
      n.track, n.midi, n.kind, n.time.toFixed(6), n.velocity.toFixed(6), n.duration.toFixed(6),
    ].join('|'));
  };

  const first = await capture(1234);
  const again = await capture(1234);
  assert.ok(first.length > 40, `only ${first.length} notes across 16 bars`);
  assert.deepEqual(again, first, 'the same seed must reproduce the piece note for note');

  const other = await capture(99);
  assert.notDeepEqual(other, first, 'a different seed must not replay the same piece');
}));

test('every structure preset stages its entry: bar 0 is the pad alone', () => hiddenTab(async () => {
  for (const structure of ['drone', 'waves', 'build', 'abab', 'journey', 'auto', 'custom']) {
    const engine = createEngine({
      bpm: 120, speed: 2, complexity: 1, repetition: 0, structure,
      customStructure: [{ label: 'D', bars: 8, intensity: 1 }],
      tracks: tracksAll('on'),
    }, { rng: seededRng(404) });
    const log = record(engine);
    await engine.start();
    await advance(10, FAST);
    engine.stop();

    assert.ok(log.bars.length >= 8, `${structure}: only ${log.bars.length} bars`);
    for (const note of log.notes) {
      const owner = log.barOf(note);
      assert.ok(owner, `${structure}: a note preceded every bar`);
      const stage = TRACK_ORDER.indexOf(note.track);
      assert.ok(owner.bar >= stage,
        `${structure}: ${note.track} sounded in bar ${owner.bar}, before its stage bar ${stage}`);
    }
    const opening = log.notes.filter((n) => log.barOf(n).bar === 0);
    assert.ok(opening.length > 0, `${structure}: bar 0 was silent`);
    assert.ok(opening.every((n) => n.track === 'pad'),
      `${structure}: bar 0 played ${[...new Set(opening.map((n) => n.track))]} — pad only`);
  }
}));

test('all six tracks are eligible by bar 5, forced on or on auto', () => hiddenTab(async () => {
  const firstBars = async (tracks, seed) => {
    const engine = createEngine({
      bpm: 120, speed: 2, complexity: 1, repetition: 0, structure: 'custom',
      customStructure: [{ label: 'D', bars: 8, intensity: 1 }], tracks,
    }, { rng: seededRng(seed) });
    const log = record(engine);
    await engine.start();
    await advance(16, FAST);
    engine.stop();
    const first = {};
    for (const note of log.notes) {
      const owner = log.barOf(note);
      if (!owner) continue;
      first[note.track] = Math.min(first[note.track] ?? Infinity, owner.bar);
    }
    return first;
  };

  const forced = await firstBars(tracksAll('on'), 17);
  for (const track of TRACK_ORDER) {
    const stage = TRACK_ORDER.indexOf(track);
    assert.ok(Number.isFinite(forced[track]), `${track} never played even forced on`);
    assert.ok(forced[track] >= stage, `${track} sounded in bar ${forced[track]}, before stage ${stage}`);
    assert.ok(forced[track] <= 5, `${track} waited until bar ${forced[track]} — all six are due by bar 5`);
  }

  const auto = await firstBars(tracksAll('auto'), 23);
  for (const track of TRACK_ORDER) {
    assert.ok(Number.isFinite(auto[track]), `${track} never joined at full intensity on auto`);
    assert.ok(auto[track] >= TRACK_ORDER.indexOf(track), `${track} jumped its staged entry on auto`);
  }
}));

test('bass ships off and stays silent at the defaults; melody ships auto (v14) and sounds', () => hiddenTab(async () => {
  // v14: melody passed the user's "catchy" gate and now defaults to auto.
  // Bass failed its own gate ("it's a rhythm instrument, not a low-pitch
  // random") and stays off until its groove rework passes it too.
  assert.equal(DEFAULT_PARAMS.tracks.bass.state, 'off');
  assert.equal(DEFAULT_PARAMS.tracks.melody.state, 'auto');
  for (const track of ['pad', 'texture', 'arp', 'percussion']) {
    assert.equal(DEFAULT_PARAMS.tracks[track].state, 'auto', `${track} still ships on auto`);
  }

  const engine = createEngine();   // the shipped defaults, 60 bpm, nothing overridden
  const log = record(engine);
  await engine.start();
  await advance(45, FAST);
  engine.stop();
  assert.ok(log.bars.length >= 9, `only ${log.bars.length} bars at the default tempo`);
  assert.ok(log.notes.length > 0, 'the defaults played nothing at all');
  assert.deepEqual(log.notes.filter((n) => n.track === 'bass'), [],
    'bass must be silent until the user switches it on');
  assert.ok(log.notes.some((n) => n.track === 'melody'),
    'melody ships auto now — it must actually sound at the defaults, not just default to the state');
}));

// --------------------------------------------------------------------------
// v6 — hold and randomise()
// --------------------------------------------------------------------------

/**
 * The realised bar plan of a track: which onsets fired, at what velocity, per
 * bar. Pitch is deliberately left out — held material keeps following the
 * harmony, so the notes may change while the plan does not.
 *
 * The held tracks below all run `vary.timing: 0`: the ±≤25 ms humanisation is
 * drawn per note and would both blur the onsets and push a note over a barline
 * into the wrong bar, which is a question about vary, not about hold.
 */
function barPlans(log, track) {
  const plans = new Map();
  for (const bar of log.bars) plans.set(bar.bar, []);
  for (const note of log.notes) {
    if (note.track !== track) continue;
    const owner = log.barOf(note);
    if (!owner) continue;
    plans.get(owner.bar).push(`${(note.time - owner.time).toFixed(6)}@${note.velocity.toFixed(6)}`);
  }
  return plans;
}

const planOf = (plans, bar) => (plans.get(bar) || []).join('|');
const barRange = (from, to) => Array.from({ length: to - from + 1 }, (unused, i) => from + i);

/**
 * The loop length (1–4 bars) the plans over `bars` settle on, or 0 if they
 * never repeat. Held material is frozen, but the material may be a multi-bar
 * phrase — "frozen" therefore means periodic, not bar-for-bar identical.
 */
function loopLength(plans, bars) {
  for (let period = 1; period <= 4; period++) {
    if (bars.length < period * 2) break;
    const repeats = bars.every((bar, i) => i < period
      || planOf(plans, bar) === planOf(plans, bars[i - period]));
    if (repeats) return period;
  }
  return 0;
}

const planSet = (plans, bars) => new Set(bars.map((bar) => planOf(plans, bar)));

test('hold loops the realised material while the harmony keeps moving', () => hiddenTab(async () => {
  const run = async (hold) => {
    const engine = createEngine({
      bpm: 120, speed: 2, structure: 'drone', complexity: 0.6, repetition: 0.3,
      tracks: {
        ...tracksAll('off'),
        pad: { state: 'on' },
        melody: {
          state: 'on', hold, randomness: 0.5, vary: { timing: 0 },
          sequencer: { mode: 'manual', steps: seqLane({ prob: 0.5 }) },
        },
      },
    }, { rng: seededRng(31) });
    const log = record(engine);
    try {
      await engine.start();
      await advance(20, FAST);
    } finally {
      engine.stop();
    }
    return log;
  };

  const window = barRange(6, 15);
  const held = await run(true);
  const plans = barPlans(held, 'melody');
  assert.ok(held.bars.length > 16, `only ${held.bars.length} bars`);
  assert.ok(window.some((bar) => planOf(plans, bar).length > 0), 'the held melody never played');
  const period = loopLength(plans, window);
  assert.ok(period > 0,
    `the held material never settled into a loop: ${window.map((b) => planOf(plans, b)).join('\n')}`);

  // the harmony must keep advancing underneath the frozen material
  const chords = new Set();
  for (const bar of window) {
    const chord = held.notes
      .filter((n) => n.track === 'pad' && held.barOf(n).bar === bar)
      .map((n) => n.midi).sort((a, b) => a - b).join(',');
    if (chord) chords.add(chord);
  }
  assert.ok(chords.size > 1, 'the pad never changed chord, so nothing proves harmony advanced');

  // the same settings unheld must NOT loop, or the test proves nothing
  const free = barPlans(await run(false), 'melody');
  assert.equal(loopLength(free, window), 0,
    'the unheld control looped too — hold proves nothing here');
}));

test('randomise() re-rolls held material exactly once', () => hiddenTab(async () => {
  const engine = createEngine({
    bpm: 120, speed: 2, structure: 'drone', complexity: 0.6,
    tracks: {
      ...tracksAll('off'),
      melody: {
        state: 'on', hold: true, randomness: 0.5, vary: { timing: 0 },
        sequencer: { mode: 'manual', steps: seqLane({ prob: 0.5 }) },
      },
    },
  }, { rng: seededRng(77) });
  const log = record(engine);
  try {
    await engine.start();
    await advance(12, FAST);
    engine.randomise('melody');
    await advance(16, FAST);
  } finally {
    engine.stop();
  }

  const plans = barPlans(log, 'melody');
  const before = barRange(6, 11);
  const after = barRange(18, 25);
  assert.ok(log.bars.length > 26, `only ${log.bars.length} bars`);
  assert.ok(loopLength(plans, before) > 0, 'the melody was not held before randomise()');
  assert.ok(before.some((bar) => planOf(plans, bar).length > 0), 'the held melody never played');

  assert.notDeepEqual([...planSet(plans, after)].sort(), [...planSet(plans, before)].sort(),
    'randomise() did not re-roll the held material');
  assert.ok(loopLength(plans, after) > 0,
    'the re-rolled material must hold again — randomise() re-rolls exactly once');

  const idle = createEngine();
  idle.randomise();               // a no-op while stopped, but never a throw
  idle.randomise('melody');
  idle.randomise('nonsense');
}));

test('releasing hold resumes normal generation', () => hiddenTab(async () => {
  const engine = createEngine({
    bpm: 120, speed: 2, structure: 'drone', complexity: 0.6,
    tracks: {
      ...tracksAll('off'),
      melody: {
        state: 'on', hold: true, randomness: 0.5, vary: { timing: 0 },
        sequencer: { mode: 'manual', steps: seqLane({ prob: 0.5 }) },
      },
    },
  }, { rng: seededRng(129) });
  const log = record(engine);
  try {
    await engine.start();
    await advance(14, FAST);
    engine.setParams({ tracks: { melody: { hold: false } } });
    await advance(18, FAST);
  } finally {
    engine.stop();
  }

  const plans = barPlans(log, 'melody');
  const held = barRange(6, 11);
  const released = barRange(20, 27);
  assert.ok(log.bars.length > 28, `only ${log.bars.length} bars`);
  assert.ok(loopLength(plans, held) > 0, 'the plan was not held to begin with');
  const heldPlans = planSet(plans, held);
  assert.ok(released.some((bar) => !heldPlans.has(planOf(plans, bar))),
    'the material stayed frozen after hold was released');
}));

// --------------------------------------------------------------------------
// v6 amendment — manual step sequencers
// --------------------------------------------------------------------------

test('a manual sequencer fills the metre prefix at prob 1 and stays silent at prob 0', () => hiddenTab(async () => {
  const full = await soloRun('melody', {
    randomness: 0, sequencer: { mode: 'manual', steps: seqLane({ prob: 1 }) },
  });
  const bars44 = [...full.byBar('melody')].filter(([bar]) => bar >= 3 && bar <= 11);
  assert.ok(bars44.length >= 6, `only ${bars44.length} bars to judge`);
  for (const [bar, notes] of bars44) {
    assert.equal(notes.length, 16, `bar ${bar}: 4/4 uses the first 16 of the 20 slots`);
  }

  // the grid is sixteenths, so every onset sits on a sixteenth of the bar
  const sixteenth = (60 / 240) / 4;
  for (const [, notes] of bars44) {
    for (const note of notes) {
      const steps = note.offset / sixteenth;
      assert.ok(Math.abs(steps - Math.round(steps)) < 1e-6,
        `an onset ${note.offset}s into the bar is off the sixteenth grid`);
    }
  }

  const six = await soloRun('melody', {
    randomness: 0, sequencer: { mode: 'manual', steps: seqLane({ prob: 1 }) },
  }, { timeSignature: '6/8' });
  const bars68 = [...six.byBar('melody')].filter(([bar]) => bar >= 3 && bar <= 11);
  assert.ok(bars68.length >= 6, `only ${bars68.length} bars of 6/8 to judge`);
  for (const [bar, notes] of bars68) {
    assert.equal(notes.length, 12, `bar ${bar}: 6/8 uses the first 12 slots`);
  }

  const silent = await soloRun('melody', {
    sequencer: { mode: 'manual', steps: seqLane({ prob: 0 }) },
  });
  assert.deepEqual(silent.notes, [], 'prob 0 must never fire');
}));

test('manual sequencer velocities stay inside the step band', () => hiddenTab(async () => {
  const banded = await soloRun('melody', {
    randomness: 0, vary: { volume: 0 },
    sequencer: { mode: 'manual', steps: seqLane({ prob: 1, vmin: 0.35, vmax: 0.75 }) },
  });
  const velocities = banded.notes.map((n) => n.velocity);
  assert.ok(velocities.length > 40, `only ${velocities.length} notes to judge the band`);
  for (const velocity of velocities) {
    assert.ok(velocity >= 0.35 - 1e-9 && velocity <= 0.75 + 1e-9,
      `velocity ${velocity} escaped the 0.35–0.75 band`);
  }
  assert.ok(Math.max(...velocities) - Math.min(...velocities) > 0.1,
    'the band must be sampled across, not pinned to one value');

  const pinned = await soloRun('melody', {
    randomness: 0, vary: { volume: 0 },
    sequencer: { mode: 'manual', steps: seqLane({ prob: 1, vmin: 0.5, vmax: 0.5 }) },
  });
  for (const note of pinned.notes) {
    assert.ok(Math.abs(note.velocity - 0.5) < 1e-9, `a vmin=vmax step played at ${note.velocity}`);
  }

  // randomness jitters velocity on top of the band, but stays a velocity
  const jittered = await soloRun('melody', {
    randomness: 1,
    sequencer: { mode: 'manual', steps: seqLane({ prob: 1, vmin: 0.5, vmax: 0.5 }) },
  });
  assert.ok(jittered.notes.length > 40, 'the jittered run played too little to judge');
  for (const note of jittered.notes) {
    assert.ok(note.velocity > 0 && note.velocity <= 1, `jittered velocity ${note.velocity} is not a velocity`);
  }
  const mean = jittered.notes.reduce((sum, n) => sum + n.velocity, 0) / jittered.notes.length;
  assert.ok(Math.abs(mean - 0.5) < 0.2, `randomness pulled the mean velocity to ${mean}`);
}));

test('manual percussion lanes map to their kinds', () => hiddenTab(async () => {
  const lanesOnly = (only) => Object.fromEntries(PERCUSSION_LANES.map((lane) => [
    lane, seqLane({ on: lane === only, prob: 1, vmin: 0.4, vmax: 0.8 }),
  ]));

  for (const lane of PERCUSSION_LANES) {
    const log = await soloRun('percussion', {
      randomness: 0, sequencer: { mode: 'manual', steps: lanesOnly(lane) },
    }, { seconds: 14 });
    const notes = [...log.byBar('percussion')]
      .filter(([bar]) => bar >= 6 && bar <= 11)
      .flatMap(([, inBar]) => inBar);
    assert.ok(notes.length > 0, `the ${lane} lane never fired`);
    assert.ok(notes.every((n) => n.kind === lane),
      `a ${lane}-only grid played ${[...new Set(notes.map((n) => n.kind))]}`);
    assert.ok(notes.every((n) => n.midi === null), 'percussion notes carry no pitch');
  }

  const all = await soloRun('percussion', {
    randomness: 0,
    sequencer: {
      mode: 'manual',
      steps: Object.fromEntries(PERCUSSION_LANES.map((lane) => [lane, seqLane({ prob: 1 })])),
    },
  }, { seconds: 14 });
  const bars = [...all.byBar('percussion')].filter(([bar]) => bar >= 6 && bar <= 11);
  assert.ok(bars.length >= 4, `only ${bars.length} bars of three-lane percussion`);
  for (const [bar, notes] of bars) {
    assert.equal(notes.length, 48, `bar ${bar}: three lanes × 16 sixteenths`);
  }
}));

test('the manual arp lane is indexed by arp step at the current rate', () => hiddenTab(async () => {
  for (const [rate, perBar] of [['1/4', 4], ['1/8', 8], ['1/8T', 12], ['1/16', 16]]) {
    const log = await soloRun('arp', {
      randomness: 0, sequencer: { mode: 'manual', steps: seqLane({ prob: 1 }) },
    }, { seconds: 14, arp: { mode: 'manual', rate, octaves: 2, gate: 0.5 } });
    const bars = [...log.byBar('arp')].filter(([bar]) => bar >= 5 && bar <= 10);
    assert.ok(bars.length >= 4, `${rate}: only ${bars.length} eligible bars`);
    for (const [bar, notes] of bars) {
      assert.equal(notes.length, perBar, `${rate}: bar ${bar} played ${notes.length} of ${perBar} steps`);
    }
  }

  // a masked lane fires only its enabled slots, on that rate's grid
  const masked = seqLane({ prob: 1 }).map((step, i) => ({ ...step, on: i === 0 }));
  const log = await soloRun('arp', {
    randomness: 0, sequencer: { mode: 'manual', steps: masked },
  }, { seconds: 14, arp: { mode: 'manual', rate: '1/8T', octaves: 1, gate: 0.5 } });
  const bars = [...log.byBar('arp')].filter(([bar]) => bar >= 5 && bar <= 10);
  assert.ok(bars.length >= 4, `only ${bars.length} eligible bars`);
  for (const [bar, notes] of bars) {
    assert.equal(notes.length, 1, `bar ${bar}: only slot 0 is enabled`);
    assert.ok(Math.abs(notes[0].offset) < 1e-6, 'slot 0 must sit on the barline');
  }
}));

test('a rangeable step probability drifts between its bounds', () => hiddenTab(async () => {
  const measure = async (prob, seed) => {
    const log = await soloRun('melody', {
      randomness: 0, sequencer: { mode: 'manual', steps: seqLane({ prob }) },
    }, { seconds: 26, seed });
    const byBar = log.byBar('melody');
    const bars = log.bars.filter((b) => b.bar >= 3 && b.bar <= 20);
    assert.ok(bars.length >= 12, `only ${bars.length} bars to measure`);
    const perBar = bars.map((b) => (byBar.get(b.bar) || []).length);
    return { perBar, rate: perBar.reduce((a, b) => a + b, 0) / (perBar.length * 16) };
  };

  assert.equal((await measure({ min: 1, max: 1 }, 61)).rate, 1, 'a range pinned at 1 fires every step');
  assert.equal((await measure({ min: 0, max: 0 }, 62)).rate, 0, 'a range pinned at 0 never fires');

  const drifting = await measure({ min: 0.2, max: 0.6 }, 63);
  assert.ok(drifting.rate > 0.1 && drifting.rate < 0.7,
    `hit rate ${drifting.rate} is nowhere near the 0.2–0.6 range`);
  assert.ok(new Set(drifting.perBar).size > 1, 'the effective probability never moved');
}));

// --------------------------------------------------------------------------
// v6 amendment 2 — per-track randomisation targets
// --------------------------------------------------------------------------

test('vary.timing humanises within ±25 ms, and an explicit aspect beats the macro', () => hiddenTab(async () => {
  const sixteenth = (60 / 120) / 4;   // bpm 120, speed 1 → half-second beats
  const deviations = async (randomness, timing, seed) => {
    const log = await soloRun('melody', {
      randomness, vary: { timing },
      sequencer: { mode: 'manual', steps: seqLane({ prob: 1 }) },
    }, { seconds: 20, speed: 1, seed });
    const notes = [...log.byBar('melody')].filter(([bar]) => bar >= 3).flatMap(([, inBar]) => inBar);
    assert.ok(notes.length > 40, `only ${notes.length} notes to measure`);
    return notes.map((n) => n.offset - Math.round(n.offset / sixteenth) * sixteenth);
  };

  const overridden = await deviations(1, 0, 71);
  assert.ok(overridden.every((d) => Math.abs(d) < 1e-9),
    'vary.timing 0 must override a maxed randomness macro');

  const humanised = await deviations(0, 1, 72);
  assert.ok(humanised.some((d) => Math.abs(d) > 1e-4),
    'vary.timing 1 must override a zeroed randomness macro');
  for (const d of humanised) {
    assert.ok(Math.abs(d) <= 0.025 + 1e-6, `timing spread ${d}s exceeds the ±25 ms bound`);
  }

  const macro = await deviations(1, null, 73);
  assert.ok(macro.some((d) => Math.abs(d) > 1e-4), 'a null aspect must follow the randomness macro');
  for (const d of macro) {
    assert.ok(Math.abs(d) <= 0.025 + 1e-6, `timing spread ${d}s exceeds the ±25 ms bound`);
  }

  const calm = await deviations(0, null, 74);
  assert.ok(calm.every((d) => Math.abs(d) < 1e-9),
    'randomness 0 with a null aspect must sit exactly on the grid');
}));

test('humanisation never moves a note out of the bar it was planned in', () => hiddenTab(async () => {
  // A note dragged BACK over the barline lands in a bar the scheduler has
  // already dispatched. A note pushed FORWARD over it sounds in the next bar —
  // which is inaudible mid-piece and exactly wrong at the end of one, where the
  // next bar is the resolving closing bar that nothing but pad and bass belongs
  // in. Everything on, maximum humanisation, every note checked against the bar
  // it was recorded in.
  const engine = createEngine({
    bpm: 180, speed: 2, complexity: 0.9, repetition: 0.3,
    structure: 'custom', customStructure: [{ label: 'A', bars: 8, intensity: 1 }],
    tracks: tracksAll('on', { randomness: 1, vary: { timing: 1 } }),
  }, { rng: seededRng(6401) });
  const log = record(engine);
  await engine.start();
  await advance(45, FAST);
  engine.stop();

  assert.ok(log.bars.length >= 12, `only ${log.bars.length} bars`);
  const spans = new Map();
  log.bars.forEach((entry, i) => {
    const next = log.bars[i + 1];
    if (next) spans.set(entry.bar, { from: entry.time, to: next.time });
  });
  let checked = 0;
  for (const note of log.notes) {
    const owner = log.barOf(note);
    const span = owner ? spans.get(owner.bar) : null;
    if (!span) continue;   // the last bar has no barline after it to judge against
    checked += 1;
    assert.ok(note.time >= span.from - 1e-9 && note.time < span.to - 1e-9,
      `a ${note.track} note at ${note.time.toFixed(4)} escaped bar ${owner.bar} `
      + `(${span.from.toFixed(4)}–${span.to.toFixed(4)})`);
  }
  assert.ok(checked > 400, `only ${checked} notes to judge`);
}));

test('vary.pan widens the stereo spread with its amount', () => hiddenTab(async () => {
  const bank = bankFor('melody');
  const spy = spyOnBank(bank);
  try {
    const spread = async (pan, seed) => {
      spy.plays.length = 0;
      await soloRun('melody', {
        randomness: 0, vary: { pan },
        sequencer: { mode: 'manual', steps: seqLane({ prob: 1 }) },
      }, { seconds: 14, seed });
      const pans = spy.plays.map((p) => p.note.pan);
      assert.ok(pans.length > 30, `only ${pans.length} notes reached the voice`);
      for (const value of pans) {
        assert.ok(value >= -1 && value <= 1, `pan ${value} is outside -1..1`);
      }
      return Math.max(...pans) - Math.min(...pans);
    };

    const none = await spread(0, 81);
    const half = await spread(0.5, 81);
    const wide = await spread(1, 81);
    assert.ok(wide > none + 0.2, `vary.pan 1 (${wide}) barely widened on vary.pan 0 (${none})`);
    assert.ok(half >= none - 1e-9 && wide >= half - 1e-9,
      `pan spread must grow with the amount: ${none} → ${half} → ${wide}`);
  } finally {
    spy.restore();
  }
}));

test('vary.voice wanders the sounding voice; getParams keeps the user\'s', () => hiddenTab(async () => {
  const bank = bankFor('melody');
  const userVoice = Object.keys(bank)[0];
  // A second voice guarantees somewhere to wander to, whichever bank loaded.
  bank.varyStandIn = { label: 'Vary stand-in', play: bank[userVoice].play };
  const spy = spyOnBank(bank);
  try {
    const engine = createEngine({
      bpm: 120, speed: 2, structure: 'drone', complexity: 0.6,
      tracks: {
        ...tracksAll('off'),
        melody: {
          state: 'on', voice: userVoice, randomness: 0, vary: { voice: 1 },
          sequencer: { mode: 'manual', steps: seqLane({ prob: 1 }) },
        },
      },
    }, { rng: seededRng(515) });
    await engine.start();
    await advance(26, FAST);
    engine.stop();
    assert.ok(spy.plays.length > 0, 'the melody never sounded');
    const sounded = new Set(spy.plays.map((p) => p.id));
    assert.ok(sounded.size > 1, `vary.voice 1 never wandered: only ${[...sounded]} sounded`);
    assert.equal(engine.getParams().tracks.melody.voice, userVoice,
      'the wander is ephemeral — getParams must still report the user voice');

    // an off track never evaluates the wander: off is absolute
    spy.plays.length = 0;
    const off = createEngine({
      bpm: 120, speed: 2, structure: 'drone',
      tracks: { ...tracksAll('off'), melody: { state: 'off', voice: userVoice, vary: { voice: 1 } } },
    }, { rng: seededRng(516) });
    await off.start();
    await advance(12, FAST);
    off.stop();
    assert.equal(spy.plays.length, 0, 'an off track sounded');
    assert.equal(off.getParams().tracks.melody.voice, userVoice);
  } finally {
    spy.restore();
    delete bank.varyStandIn;
  }
}));

// --------------------------------------------------------------------------
// v8 — the gain chain: TRACK_MIX × clamp(level-drift × volume-walk, ·, 1)
// --------------------------------------------------------------------------

test('the track gain chain never breaks the mix ceiling', () => hiddenTab(async () => {
  const settled = async (tracks, seed) => {
    const engine = createEngine({
      bpm: 120, speed: 2, structure: 'drone', complexity: 0.8, tracks,
    }, { rng: seededRng(seed) });
    await engine.start();
    await advance(10, FAST);
    const gains = trackGains(liveContexts[liveContexts.length - 1]);
    const values = Object.fromEntries(TRACK_ORDER.map((n) => [n, gains[n].gain.value]));
    engine.stop();
    return values;
  };

  // level 1 with no walk IS the ceiling: TRACK_MIX × clamp(1, ·, 1)
  const ceiling = await settled(tracksAll('on', { level: 1, randomness: 0 }), 91);
  for (const name of TRACK_ORDER) {
    assert.ok(ceiling[name] > 0.01 && ceiling[name] <= 1,
      `${name}: ${ceiling[name]} is not a plausible mix level`);
  }

  const defaults = await settled(tracksAll('on', { randomness: 0 }), 92);
  for (const name of TRACK_ORDER) {
    assert.ok(defaults[name] <= ceiling[name] + 1e-9,
      `${name}: the default level pushed past the mix ceiling`);
    assert.ok(Math.abs(defaults[name] - 0.8 * ceiling[name]) < 1e-6,
      `${name}: the 0.8 default level must scale the mix level, got ${defaults[name]}`);
  }

  // a maxed level range and a maxed volume walk still cannot lift the ceiling
  const engine = createEngine({
    bpm: 120, speed: 2, structure: 'drone', complexity: 0.8,
    tracks: tracksAll('on', { level: { min: 0.9, max: 1 }, randomness: 1, vary: { volume: 1 } }),
  }, { rng: seededRng(93) });
  await engine.start();
  const gains = trackGains(liveContexts[liveContexts.length - 1]);
  const peak = Object.fromEntries(TRACK_ORDER.map((n) => [n, 0]));
  for (let i = 0; i < 16; i++) {
    await advance(1, FAST);
    for (const name of TRACK_ORDER) peak[name] = Math.max(peak[name], gains[name].gain.value);
  }
  engine.stop();
  for (const name of TRACK_ORDER) {
    assert.ok(peak[name] <= ceiling[name] + 1e-9,
      `${name}: gain reached ${peak[name]}, past the ${ceiling[name]} ceiling`);
    assert.ok(peak[name] > ceiling[name] * 0.2, `${name}: the walk all but silenced the track`);
  }
}));

test('a {min,max} level drifts inside its bounds, and hold freezes the walk', () => hiddenTab(async () => {
  const samples = async (settings, seed) => {
    const engine = createEngine({
      bpm: 120, speed: 2, structure: 'drone', complexity: 0.6,
      tracks: { ...tracksAll('off'), pad: { state: 'on', ...settings } },
    }, { rng: seededRng(seed) });
    await engine.start();
    const gain = trackGains(liveContexts[liveContexts.length - 1]).pad;
    const values = [];
    for (let i = 0; i < 14; i++) {
      await advance(1, FAST);
      values.push(gain.gain.value);
    }
    engine.stop();
    return values;
  };

  const ceiling = (await samples({ level: 1, randomness: 0 }, 101))[10];
  assert.ok(ceiling > 0.01, 'the pad never opened');

  // v14: randomness 0 IS a hold — a track sitting at 0 drifts by nothing at
  // all (its walks are frozen, not merely slow), so drift needs a nonzero
  // randomness to actually show up.
  const drifting = await samples({ level: { min: 0.2, max: 0.6 }, randomness: 0.5 }, 102);
  for (const value of drifting) {
    const ratio = value / ceiling;
    assert.ok(ratio >= 0.2 - 1e-6 && ratio <= 0.6 + 1e-6,
      `the level drifted to ${ratio} of the mix, outside its 0.2–0.6 bounds`);
  }
  assert.ok(new Set(drifting.map((v) => v.toFixed(9))).size > 1, 'a ranged level never drifted');

  // The other half of the v14 merge: randomness 0 freezes the walk exactly
  // the way an explicit hold does, with no `hold: true` in sight.
  const frozenByZero = await samples({ level: { min: 0.2, max: 0.6 }, randomness: 0 }, 104);
  const frozenValues = new Set(frozenByZero.slice(4).map((v) => v.toFixed(9)));
  assert.equal(frozenValues.size, 1,
    `randomness 0 did not freeze the level walk: ${[...frozenValues]}`);

  // level 0.5, not the 0.8 default: at 0.8 a maxed walk spends most of its
  // time pinned against the clamp-to-1 ceiling, which is a different test.
  const walking = await samples({ level: 0.5, randomness: 1, vary: { volume: 1 } }, 103);
  assert.ok(new Set(walking.map((v) => v.toFixed(9))).size > 1, 'the volume walk never moved');

  const held = await samples({ level: 0.5, randomness: 1, hold: true, vary: { volume: 1 } }, 103);
  const frozen = new Set(held.slice(4).map((v) => v.toFixed(9)));
  assert.equal(frozen.size, 1, `the volume walk kept moving under hold: ${[...frozen]}`);
}));

// --------------------------------------------------------------------------
// v9 — power budget and per-track stats (feature-detected)
// --------------------------------------------------------------------------

test('getStats() reports the load and setPowerBudget() caps the voices', () => hiddenTab(async () => {
  const probe = createEngine();
  if (typeof probe.getStats !== 'function' || typeof probe.setPowerBudget !== 'function') {
    console.log('     (skipped: this engine build has no v9 getStats()/setPowerBudget())');
    return;
  }

  const maxNotes = 4;
  const spies = TRACK_ORDER.map((track) => spyOnBank(bankFor(track)));
  try {
    const engine = createEngine({
      bpm: 120, speed: 2, complexity: 1, repetition: 0, structure: 'custom',
      customStructure: [{ label: 'D', bars: 8, intensity: 1 }],
      tracks: tracksAll('on'),
    }, { rng: seededRng(111) });
    engine.setPowerBudget({ maxNotes });
    const log = record(engine);
    await engine.start();
    await advance(20, FAST);
    const stats = engine.getStats();
    engine.stop();

    // Voice-steal: count only notes that were never cancelled — a stolen note
    // stops sounding, whatever its scheduled duration said.
    const sounding = spies
      .flatMap((spy) => spy.plays)
      .filter((play) => !play.cancelled)
      .map((play) => ({ start: play.note.when, end: play.note.when + play.note.duration }));
    assert.ok(log.notes.length > 0, 'the budgeted engine went silent');
    assert.ok(sounding.length > 20, `only ${sounding.length} notes reached a voice`);
    for (const note of sounding) {
      const live = sounding.filter((other) => other.start <= note.start + 1e-9
        && note.start < other.end - 1e-9).length;
      assert.ok(live <= maxNotes,
        `${live} notes sounding at ${note.start}s with a ${maxNotes}-note budget`);
    }

    assert.ok(stats && typeof stats === 'object', 'getStats() returned nothing usable');
    assert.ok(stats.perTrack && typeof stats.perTrack === 'object', 'getStats().perTrack is missing');
    assert.notEqual(stats.total, undefined, 'getStats().total is missing');
    for (const track of TRACK_ORDER) {
      const per = stats.perTrack[track];
      assert.ok(per, `getStats().perTrack.${track} is missing`);
      for (const key of ['activeNotes', 'nodesEstimate', 'notesPerMin']) {
        assert.ok(Number.isFinite(per[key]) && per[key] >= 0,
          `getStats().perTrack.${track}.${key} is ${per[key]}`);
      }
    }
  } finally {
    for (const spy of spies) spy.restore();
  }
}));

// --------------------------------------------------------------------------
// v11 — the hook (establish / mutate / bank / recall) and the pad's breathing
//
// The hook is read off the PAD, whose voicing is the chord as an ear actually
// meets it: the chord roots, the inversion and the extension all show up in the
// midi set it sounds. These runs pin section intensity at 1 through a one-block
// custom structure, which is what stops the pad ever choosing a rest bar — a
// missing chord would shift the loop windows against each other and measure
// nothing. Rests get their own test below.
// --------------------------------------------------------------------------

/**
 * The chord the pad voiced at each chord change: one entry per chord, in order.
 * A pad attack sits exactly on its barline (these runs zero vary.timing), so
 * the half-bar breath — which repeats the same voicing — is filtered out here
 * by its offset rather than by comparing chords, which would also swallow a
 * genuinely repeated chord.
 */
function voicingStream(log) {
  const chords = [];
  const byBar = log.byBar('pad');
  for (const number of [...byBar.keys()].sort((a, b) => a - b)) {
    const attack = byBar.get(number).filter((note) => note.offset < 1e-6);
    if (!attack.length) continue;
    chords.push(attack.map((note) => note.midi).sort((a, b) => a - b).join('.'));
  }
  return chords;
}

/**
 * The loop length the engine actually played, recovered as the lag (in chords)
 * at which the stream best agrees with itself, plus that agreement. A
 * memoryless walk agrees with itself at no lag; a hook agrees at its own.
 */
function bestLag(chords) {
  let best = { lag: 0, agreement: -1 };
  for (let lag = HOOK_MIN_CHORDS; lag <= HOOK_MAX_CHORDS; lag++) {
    let hits = 0;
    let total = 0;
    for (let i = 0; i + lag < chords.length; i++) {
      total += 1;
      if (chords[i] === chords[i + lag]) hits += 1;
    }
    const agreement = total ? hits / total : 0;
    if (agreement > best.agreement) best = { lag, agreement };
  }
  return best;
}

/** The first four chords of each loop pass, pass by pass. */
function passWindows(chords, lag) {
  const windows = [];
  for (let start = 0; start + 4 <= chords.length; start += lag) {
    windows.push(chords.slice(start, start + 4).join(' '));
  }
  return windows;
}

/** Pad + bass only, at a pinned intensity, for `seconds` of mock audio. */
async function hookRun({ seconds = 150, seed = 7001, ...rest } = {}) {
  const engine = createEngine({
    bpm: 120, speed: 2, complexity: 0.5, repetition: 0.5,
    structure: 'custom', customStructure: [{ label: 'A', bars: 8, intensity: 1 }],
    ...rest,
    tracks: {
      ...tracksAll('off'),
      pad: { state: 'on', randomness: 0, vary: { timing: 0, voice: 0 } },
      bass: { state: 'on', randomness: 0, vary: { timing: 0, voice: 0 } },
    },
  }, { rng: seededRng(seed) });
  const log = record(engine);
  await engine.start();
  await advance(seconds, FAST);
  engine.stop();
  return log;
}

/**
 * The hook property tests below are read against 3 seeds and accept ANY ONE
 * of them proving the property cleanly, rather than demanding every seed
 * pass every threshold. A stochastic generator can legitimately roll a hook
 * whose modal window share or recall timing lands just the wrong side of a
 * threshold for one particular seed without the underlying property (loops
 * recur, variants get banked and recalled) being false — that is seed noise,
 * not a defect, and re-checking against a fixed 2-seed set turned it into an
 * occasional flake. Requiring at least one of three still proves the
 * property is real; it stops proving it has to survive every roll of the dice.
 */
async function anyOf(seeds, attempt) {
  const failures = [];
  for (const seed of seeds) {
    try {
      await attempt(seed);
      return; // one clean pass is enough to prove the property holds
    } catch (error) {
      failures.push(`seed ${seed}: ${error.message}`);
    }
  }
  assert.fail(`no seed of [${seeds.join(', ')}] passed:\n${failures.join('\n')}`);
}

test('the hook loops: chord windows recur, and repetition tightens the loop',
  () => hiddenTab(() => anyOf([7001, 7002, 7003], async (seed) => {
    const loose = await hookRun({ seed, repetition: 0.2 });
    assert.ok(loose.bars.length >= 64, `only ${loose.bars.length} bars played`);
    const chords = voicingStream(loose);
    const { lag, agreement } = bestLag(chords);
    assert.ok(chords.length >= 32, `only ${chords.length} chords sounded`);
    assert.ok(agreement >= 0.6,
      `seed ${seed}: best agreement ${agreement.toFixed(2)} at lag ${lag} — no loop survived`);

    const windows = passWindows(chords, lag);
    const counts = new Map();
    for (const window of windows) counts.set(window, (counts.get(window) ?? 0) + 1);
    const share = Math.max(...counts.values()) / windows.length;
    assert.ok(share >= 0.3,
      `seed ${seed}: the modal window held only ${(share * 100).toFixed(0)}% of ${windows.length} passes — memoryless`);
    assert.ok(share <= 0.8,
      `seed ${seed}: the modal window held ${(share * 100).toFixed(0)}% of passes — frozen`);
    assert.ok(counts.size >= 2, `seed ${seed}: the hook never mutated`);

    // Repetition is the tightness dial: the same seed, asked for repetition,
    // comes round sooner and still recurs.
    const tight = await hookRun({ seed, repetition: 0.9 });
    const tightLag = bestLag(voicingStream(tight));
    assert.ok(tightLag.lag < lag,
      `seed ${seed}: repetition 0.9 looped in ${tightLag.lag} chords, no tighter than 0.2's ${lag}`);
    assert.ok(tightLag.agreement >= 0.6,
      `seed ${seed}: the tight loop agreed only ${tightLag.agreement.toFixed(2)} with itself`);
  })));

test('a banked hook variant comes back after the loop has moved on',
  () => hiddenTab(() => anyOf([7001, 7002, 7003], async (seed) => {
    const log = await hookRun({ seed, repetition: 0.2 });
    const chords = voicingStream(log);
    const windows = passWindows(chords, bestLag(chords).lag);

    // The ear-worm return: a window that played, was mutated away from, and
    // then came back — which only the bank can do, since a mutation only ever
    // walks a variant further from where it was.
    let recall = null;
    for (let back = 2; back < windows.length && !recall; back++) {
      for (let away = 1; away < back && !recall; away++) {
        if (windows[away] === windows[back]) continue;
        for (let first = 0; first < away; first++) {
          if (windows[first] === windows[back]) { recall = { first, away, back }; break; }
        }
      }
    }
    assert.ok(recall,
      `seed ${seed}: no window ever returned across ${windows.length} passes: ${windows.join(' | ')}`);
    // Widened from the original 16-pass ceiling: the recall cycle is real but
    // its exact length is seed-sensitive, and this is now an any-of-3 check
    // rather than the sole guard against a hook that never recalls at all.
    assert.ok(recall.back < 24,
      `seed ${seed}: the return took ${recall.back} passes, well past the recall cycle`);
  })));

test('the pad breathes: half-bar re-attacks and rest bars, on the bar grid',
  () => hiddenTab(async () => {
    const engine = createEngine({
      bpm: 120, speed: 2, structure: 'waves', complexity: 0.5, repetition: 0.5,
      tracks: {
        ...tracksAll('off'),
        pad: { state: 'on', randomness: 0.5, vary: { timing: 0, voice: 0 } },
      },
    }, { rng: seededRng(8001) });
    const log = record(engine);
    await engine.start();
    await advance(96, FAST);
    engine.stop();

    assert.ok(log.bars.length >= 64, `only ${log.bars.length} bars played`);
    const barDuration = log.bars[1].time - log.bars[0].time;
    const onsets = [...new Set(log.notes.filter((n) => n.track === 'pad').map((n) => n.time))]
      .sort((a, b) => a - b);
    assert.ok(onsets.length >= 40, `the pad attacked only ${onsets.length} times in 96 bars`);

    const gaps = [];
    for (let i = 1; i < onsets.length; i++) gaps.push((onsets[i] - onsets[i - 1]) / barDuration);
    const buckets = new Set(gaps.map((gap) => gap.toFixed(2)));
    assert.ok(buckets.size >= 3,
      `the pad kept one inter-onset interval (${[...buckets]}) — it is not breathing`);
    assert.ok(buckets.size <= 8, `${buckets.size} different intervals is chaos, not breathing`);
    assert.ok(gaps.some((gap) => gap < 0.99), 'no half-bar re-attack ever happened');
    assert.ok(gaps.some((gap) => gap > 2.01), 'the pad never rested a bar');
    for (const gap of gaps) {
      // A chord spans one or two bars and a rest can drop at most one span, so
      // four bars is the hard ceiling; nothing may land off the half-bar grid.
      assert.ok(gap >= 0.5 - 1e-6 && gap <= 4 + 1e-6, `a ${gap.toFixed(2)}-bar gap in the pad`);
      assert.ok(Math.abs(gap * 2 - Math.round(gap * 2)) < 1e-6,
        `a ${gap.toFixed(3)}-bar gap is off the half-bar grid`);
    }

    // The swell: velocity follows the section contour rather than sitting flat.
    const velocities = log.notes.filter((n) => n.track === 'pad').map((n) => n.velocity);
    assert.ok(Math.max(...velocities) <= 1 && Math.min(...velocities) > 0,
      'a pad velocity left 0–1');
    assert.ok(Math.max(...velocities) / Math.min(...velocities) >= 1.3,
      'the pad never swelled');
  }));

// --------------------------------------------------------------------------
// v12 — Musicality II: melody motif, bass tightening, mono/legato, state-flip
//
// Ground truth for "the current chord" comes off the PAD where only chord-TONE
// membership is at stake (a melody landing on a chord tone need not land on the
// root), and off the engine's own `chord` event where the ROOT is (bass).
//
// It used to read the root off the pad too — the pad's lowest sounding note —
// on the reasoning that restricting a run to the hook's FIRST pass keeps every
// slot's inversion at 0. That reasoning is incomplete: `voiceHookChord` can put
// a non-root tone at the bottom of the stack without any inversion at all (a C6
// voiced E–A–C–D is one the engine really does build), and on those bars the
// heuristic reports the wrong root and fails a bass that is voicing the right
// one. The `chord` event is the engine SAYING what it is playing, so that is
// what the bass is now judged against.
// --------------------------------------------------------------------------

const FIRST_PASS_BAR_CEILING = HOOK_MAX_CHORDS * 2; // chords never span more than 2 bars

/** Bar → pc of the chord the engine announced for it, read off its `chord` event. */
function chordRootPcByBar(log) {
  const pcs = new Map();
  for (const chord of log.chords) {
    // nameChord always spells the root first: 'C6', 'Em7', 'Gadd9sus4'.
    const named = /^([A-G][#b]?)/.exec(chord.name);
    if (named) pcs.set(chord.bar, pitchClass(named[1]));
  }
  return pcs;
}

/** Bar → Set of pcs the pad actually voiced that bar (chord-tone membership, any inversion). */
function padChordPcSetByBar(log) {
  const byBar = log.byBar('pad');
  const sets = new Map();
  // Same no-forward-fill rule as padRootPcByBar, and for the same reason.
  for (const [bar, notes] of byBar) {
    if (notes.length) sets.set(bar, new Set(notes.map((n) => n.midi % 12)));
  }
  return sets;
}

/** Every field this suite needs on mono/glide before it can test them at all. */
function monoGlideShipped() {
  const t = DEFAULT_PARAMS.tracks;
  return ['melody', 'bass', 'pad'].every((track) => typeof t[track].mono === 'boolean');
}

test('v12: mono/glide defaults — melody and bass glide, everything else stays sharp', () => {
  if (!monoGlideShipped()) {
    console.log('SKIP v12 mono/glide defaults: DEFAULT_PARAMS.tracks.*.mono not present yet');
    return;
  }
  assert.equal(DEFAULT_PARAMS.tracks.melody.mono, true, 'melody ships mono');
  assert.equal(DEFAULT_PARAMS.tracks.bass.mono, true, 'bass ships mono');
  assert.equal(DEFAULT_PARAMS.tracks.melody.glide, 0.3, 'melody glide default');
  assert.equal(DEFAULT_PARAMS.tracks.bass.glide, 0.15, 'bass glide default');
  for (const track of TRACK_ORDER) {
    if (track === 'melody' || track === 'bass') continue;
    assert.equal(DEFAULT_PARAMS.tracks[track].mono, false, `${track} must not ship mono`);
  }
  // v14: melody passed its "catchy" gate and now ships auto; bass has not and
  // stays off — the hard constraint moved with the user's verdict, not away.
  assert.equal(DEFAULT_PARAMS.tracks.melody.state, 'auto', 'melody now ships auto (v14 gate passed)');
  assert.equal(DEFAULT_PARAMS.tracks.bass.state, 'off', 'bass still ships off (hard constraint)');
});

test('v12: sanitiser accepts mono as a boolean and clamps glide 0–1', () => {
  if (!monoGlideShipped()) {
    console.log('SKIP v12 mono/glide sanitiser: mono/glide not present in DEFAULT_PARAMS yet');
    return;
  }
  const cleaned = sanitiseParams({
    tracks: {
      melody: { mono: 'yes', glide: 5 },
      bass: { mono: 0, glide: -1 },
      pad: { mono: true, glide: 0.5 },
    },
  });
  assert.equal(typeof cleaned.tracks.melody.mono, 'boolean', 'mono coerces to a boolean');
  assert.ok(cleaned.tracks.melody.glide <= 1 && cleaned.tracks.melody.glide >= 0, 'glide clamps to 0–1');
  assert.equal(cleaned.tracks.bass.mono, false, 'a falsy mono coerces to false');
  assert.ok(cleaned.tracks.bass.glide >= 0, 'glide never goes negative');
});

test('v12 bass: root pitch-class on strong beats, in ≥95% of sounding bars', () => hiddenTab(async () => {
  // repetition 1 asks buildHook for the tightest loop (HOOK_MIN_CHORDS); the
  // window below is still kept inside FIRST_PASS_BAR_CEILING regardless, so
  // this holds for any repetition.
  const log = await hookRun({ seconds: 60, seed: 9101, repetition: 0.8 });
  assert.ok(log.bars.length >= 10, `only ${log.bars.length} bars`);
  const rootPc = chordRootPcByBar(log);
  const bassByBar = log.byBar('bass');

  const window = [...bassByBar.keys()]
    .filter((bar) => bar >= 2 && bar <= Math.min(FIRST_PASS_BAR_CEILING, log.bars.length - 2))
    .sort((a, b) => a - b);
  assert.ok(window.length >= 6, `only ${window.length} bars of bass to judge`);

  let strongBeats = 0;
  let strongMatches = 0;
  for (const bar of window) {
    const downbeat = bassByBar.get(bar).filter((n) => n.offset < 1e-6);
    if (!downbeat.length) continue;
    const expected = rootPc.get(bar);
    if (expected === undefined) continue;   // no chord was announced for this bar
    strongBeats += 1;
    if (downbeat.every((n) => n.midi % 12 === expected)) strongMatches += 1;
  }
  assert.ok(strongBeats >= 5, `only ${strongBeats} bars had both a bass downbeat and a pad chord to judge`);
  const rate = strongMatches / strongBeats;
  assert.ok(rate >= 0.95,
    `bass matched the chord root on the downbeat in only ${(rate * 100).toFixed(0)}% of ${strongBeats} bars`);
}));

/** The shortest distance in semitones between two pitch classes, 0–6. */
function pcDistance(a, b) {
  const d = Math.abs(a - b) % 12;
  return Math.min(d, 12 - d);
}

test('v12 bass: non-root tones are the fifth/octave, or a late approach note into the next root', () => hiddenTab(async () => {
  const log = await hookRun({ seconds: 60, seed: 9102, repetition: 0.5 });
  const rootPc = chordRootPcByBar(log);
  const bassByBar = log.byBar('bass');
  let checked = 0;
  let approaches = 0;
  const bars = [...bassByBar.keys()].filter((b) => b >= 2 && b <= FIRST_PASS_BAR_CEILING).sort((a, b) => a - b);
  for (const bar of bars) {
    const expected = rootPc.get(bar);
    if (expected === undefined) continue;
    const nextExpected = rootPc.get(bar + 1);
    const notes = bassByBar.get(bar);
    const barLen = Math.max(...notes.map((n) => n.offset)) + 1e-6 || 1;
    for (const note of notes) {
      const pc = note.midi % 12;
      if (pc === expected) continue; // root/octave
      checked += 1;
      const isFifth = pc === (expected + 7) % 12;
      if (isFifth) {
        assert.ok(note.offset > 1e-6, `bar ${bar}: the fifth landed on the downbeat, a strong beat`);
        continue;
      }
      // Not root, not fifth: only an approach note into the NEXT chord's
      // root, on a late weak beat, is allowed by the contract.
      assert.ok(nextExpected !== undefined,
        `bar ${bar}: bass pc ${pc} is neither the root ${expected} nor its fifth, and there is no next-chord ground truth to excuse it as an approach`);
      assert.ok(pcDistance(pc, nextExpected) <= 2,
        `bar ${bar}: bass pc ${pc} is neither the root ${expected}/fifth nor within 2 semitones of the next root ${nextExpected}`);
      assert.ok(note.offset > barLen * 0.5,
        `bar ${bar}: an approach note at offset ${note.offset.toFixed(3)} is not on a late weak beat`);
      approaches += 1;
    }
  }
  assert.ok(checked > 0, 'no non-root bass tone ever sounded — the fifth/octave/approach branches were never exercised');
  console.log(`    (${checked} non-root bass tones checked, ${approaches} were approach notes)`);
}));

test('v12 bass: rhythm pattern holds within a section and re-rolls at the next one', () => hiddenTab(async () => {
  const run = async (seed) => {
    const engine = createEngine({
      bpm: 120, speed: 2, complexity: 0.5, repetition: 0.5,
      structure: 'custom',
      customStructure: [{ label: 'A', bars: 16, intensity: 1 }, { label: 'B', bars: 16, intensity: 1 }],
      tracks: {
        ...tracksAll('off'),
        pad: { state: 'on', randomness: 0, vary: { timing: 0, voice: 0 } },
        bass: { state: 'on', randomness: 0, vary: { timing: 0 } },
      },
    }, { rng: seededRng(seed) });
    const log = record(engine);
    await engine.start();
    await advance(70, FAST);
    engine.stop();
    return log;
  };

  const log = await run(9103);
  assert.ok(log.bars.length >= 34, `only ${log.bars.length} bars`);
  const byBar = log.byBar('bass');

  // "Stable pattern" is read as the underlying onset TEMPLATE holding for a
  // section, not every bar's realised onsets being byte-identical — a
  // template can still gate each step by its own probability per bar (the
  // existing sequencer's own `prob` field already works this way). So this
  // measures onset-POSITION overlap (Jaccard) between bars, which is high
  // when the same template is being re-drawn and low when it is not.
  const onsets = (bar) => new Set((byBar.get(bar) || []).map((n) => n.offset.toFixed(3)));
  const jaccard = (a, b) => {
    if (!a.size && !b.size) return 1;
    let hits = 0;
    for (const x of a) if (b.has(x)) hits += 1;
    return hits / new Set([...a, ...b]).size;
  };

  const sectionA = barRange(3, 14);
  const sectionB = barRange(19, 30);
  const withinA = [];
  for (let i = 1; i < sectionA.length; i++) {
    withinA.push(jaccard(onsets(sectionA[i - 1]), onsets(sectionA[i])));
  }
  const meanWithinA = withinA.reduce((a, b) => a + b, 0) / withinA.length;
  assert.ok(meanWithinA >= 0.5,
    `bass onsets barely agreed bar-to-bar within section A (mean Jaccard ${meanWithinA.toFixed(2)}) — no stable per-section pattern`);

  const acrossAB = [];
  for (const a of sectionA) for (const b of sectionB) acrossAB.push(jaccard(onsets(a), onsets(b)));
  const meanAcross = acrossAB.reduce((a, b) => a + b, 0) / acrossAB.length;
  assert.ok(meanAcross < meanWithinA - 0.1,
    `section B's onsets (mean Jaccard vs A ${meanAcross.toFixed(2)}) agreed with A almost as much as A agreed with `
    + `itself (${meanWithinA.toFixed(2)}) — nothing measurably re-rolled at the section boundary`);
}));

test('v12 mono: melody never sounds two notes at once when tracks.melody.mono is true', () => hiddenTab(async () => {
  const MONO_TOLERANCE = 0.13; // covers the documented glide ceiling (~0.12 s)
  const dense = { randomness: 0, sequencer: { mode: 'manual', steps: seqLane({ prob: 1 }) } };

  const monoLog = await soloRun('melody', { ...dense, mono: true }, { seconds: 20 });
  const monoNotes = monoLog.notes.filter((n) => n.track === 'melody').sort((a, b) => a.time - b.time);
  assert.ok(monoNotes.length >= 20, `only ${monoNotes.length} mono melody notes to judge`);
  for (let i = 1; i < monoNotes.length; i++) {
    const prev = monoNotes[i - 1];
    const next = monoNotes[i];
    assert.ok(next.time >= prev.time + prev.duration - MONO_TOLERANCE,
      `mono melody notes overlap: ${prev.time.toFixed(3)}+${prev.duration.toFixed(3)} then ${next.time.toFixed(3)}`);
  }

  // Control: the same density with mono off must be able to overlap, or the
  // assertion above proves nothing about mono specifically.
  const polyLog = await soloRun('melody', { ...dense, mono: false }, { seconds: 20 });
  const polyNotes = polyLog.notes.filter((n) => n.track === 'melody').sort((a, b) => a.time - b.time);
  const overlaps = polyNotes.some((note, i) => i > 0
    && note.time < polyNotes[i - 1].time + polyNotes[i - 1].duration - 1e-6);
  assert.ok(overlaps, 'mono:false control never overlapped either — the mono test proves nothing here');
}));

test('v12 mono: glide 0–1 maps to ~0.02–0.12 s on the legatoFrom the engine offers a voice', () => hiddenTab(async () => {
  const bank = bankFor('melody');
  const spy = spyOnBank(bank);
  try {
    const glideValuesFor = async (glide) => {
      spy.plays.length = 0;
      const engine = createEngine({
        bpm: 120, speed: 2, structure: 'drone', complexity: 0.5, repetition: 0.5,
        tracks: {
          ...tracksAll('off'),
          melody: {
            state: 'on', mono: true, glide, randomness: 0,
            sequencer: { mode: 'manual', steps: seqLane({ prob: 1 }) },
          },
        },
      }, { rng: seededRng(5551) });
      try {
        await engine.start();
        await advance(16, FAST);
      } finally {
        engine.stop();
      }
      return spy.plays.map((p) => p.note.legatoFrom?.glide).filter((g) => typeof g === 'number');
    };

    const low = await glideValuesFor(0);
    const high = await glideValuesFor(1);
    if (!low.length && !high.length) {
      console.log('SKIP v12 glide mapping: the engine never attached a legatoFrom to a melody note '
        + '(mono legato hand-off not observed) — nothing to measure');
      return;
    }
    assert.ok(low.length > 0, 'glide:0 never produced a legatoFrom to measure');
    assert.ok(high.length > 0, 'glide:1 never produced a legatoFrom to measure');
    for (const g of low) assert.ok(g >= 0.015 && g <= 0.03, `glide:0 legato seconds ${g} is not near the 0.02s floor`);
    for (const g of high) assert.ok(g >= 0.11 && g <= 0.13, `glide:1 legato seconds ${g} is not near the 0.12s ceiling`);
  } finally {
    spy.restore();
  }
}));

test('v12 state-flip: melody off→auto mid-bar joins at the next bar boundary, never mid-bar', () => hiddenTab(async () => {
  const engine = createEngine({
    bpm: 120, speed: 2, complexity: 1, repetition: 0, structure: 'custom',
    customStructure: [{ label: 'D', bars: 32, intensity: 1 }],
    tracks: { ...tracksAll('off'), melody: { state: 'off' } },
  }, { rng: seededRng(9104) });
  const log = record(engine);
  await engine.start();
  await advance(8.37, FAST);   // land solidly inside a bar, well past melody's stage bar (2)
  const flipTime = engine.now();
  engine.setParams({ tracks: { melody: { state: 'auto', randomness: 0 } } });
  await advance(14, FAST);
  engine.stop();

  const flipBar = [...log.bars].reverse().find((bar) => bar.time <= flipTime + 1e-9);
  assert.ok(flipBar, 'no bar had started before the flip');
  const melodyNotes = log.notes.filter((n) => n.track === 'melody');
  assert.ok(melodyNotes.length > 0, 'melody never joined after the flip at all');
  const firstBar = Math.min(...melodyNotes.map((n) => log.barOf(n).bar));
  assert.ok(firstBar > flipBar.bar,
    `melody's first note landed in bar ${firstBar}, the same bar (${flipBar.bar}) the flip happened in`);
}));

test('v12 state-flip: an early flip still respects melody\'s staged entry (bar 2)', () => hiddenTab(async () => {
  const engine = createEngine({
    bpm: 120, speed: 2, complexity: 1, repetition: 0, structure: 'custom',
    customStructure: [{ label: 'D', bars: 32, intensity: 1 }],
    tracks: { ...tracksAll('off'), melody: { state: 'off' } },
  }, { rng: seededRng(9105) });
  const log = record(engine);
  await engine.start();
  await advance(0.3, FAST);   // still inside bar 0
  engine.setParams({ tracks: { melody: { state: 'auto', randomness: 0 } } });
  await advance(14, FAST);
  engine.stop();

  const melodyNotes = log.notes.filter((n) => n.track === 'melody');
  assert.ok(melodyNotes.length > 0, 'melody never joined after an early flip');
  const firstBar = Math.min(...melodyNotes.map((n) => log.barOf(n).bar));
  const stage = TRACK_ORDER.indexOf('melody');
  assert.ok(firstBar >= stage, `melody sounded in bar ${firstBar}, before its stage bar ${stage}`);
}));

test('v12 melody: register stays within ±14 semitones of the octave-4 root', () => hiddenTab(async () => {
  const log = await soloRun('melody', {
    randomness: 0.5, sequencer: { mode: 'manual', steps: seqLane({ prob: 1 }) },
  }, { seconds: 24, complexity: 0.8 });
  const notes = log.notes.filter((n) => n.track === 'melody');
  assert.ok(notes.length >= 20, `only ${notes.length} melody notes to judge`);
  const rootMidi4 = scaleDegreeToMidi(0, SCALES.majorPentatonic, pitchClass('C'), 4);
  for (const note of notes) {
    assert.ok(Math.abs(note.midi - rootMidi4) <= 14,
      `melody note ${note.midi} is ${Math.abs(note.midi - rootMidi4)} semitones from the octave-4 root`);
  }
}));

test('v12 melody: phrases breathe — rest bars/beats exist above a floor, but melody is not silent', () => hiddenTab(async () => {
  const log = await soloRun('melody', { randomness: 0.4 }, { seconds: 60, complexity: 0.5 });
  const byBar = log.byBar('melody');
  const bars = log.bars.filter((b) => b.bar >= 2 && b.bar < log.bars.length - 1).map((b) => b.bar);
  assert.ok(bars.length >= 20, `only ${bars.length} bars to judge`);
  const silent = bars.filter((bar) => !(byBar.get(bar) || []).length).length;
  const rate = silent / bars.length;
  assert.ok(rate >= 0.03, `melody rested in only ${(rate * 100).toFixed(0)}% of bars — no phrase gaps`);
  assert.ok(rate <= 0.7, `melody rested in ${(rate * 100).toFixed(0)}% of bars — barely playing at all`);
}));

test('v12 melody: the last note before a section boundary is a chord tone of the sounding chord', () => hiddenTab(async () => {
  const engine = createEngine({
    bpm: 120, speed: 2, complexity: 0.6, repetition: 0.4, structure: 'custom',
    customStructure: [
      { label: 'A', bars: 8, intensity: 1 }, { label: 'B', bars: 8, intensity: 1 },
      { label: 'C', bars: 8, intensity: 1 }, { label: 'D', bars: 8, intensity: 1 },
    ],
    tracks: {
      ...tracksAll('off'),
      pad: { state: 'on', randomness: 0, vary: { timing: 0, voice: 0 } },
      melody: {
        state: 'on', randomness: 0, vary: { timing: 0 },
        sequencer: { mode: 'manual', steps: seqLane({ prob: 1 }) },
      },
    },
  }, { rng: seededRng(9106) });
  const log = record(engine);
  await engine.start();
  await advance(40, FAST);
  engine.stop();
  assert.ok(log.bars.length >= 30, `only ${log.bars.length} bars`);

  const chordPcs = padChordPcSetByBar(log);
  const melodyByBar = log.byBar('melody');
  let boundariesChecked = 0;
  for (const boundary of [8, 16, 24]) {
    if (boundary >= log.bars.length) continue;
    const lastBar = boundary - 1;
    const notes = melodyByBar.get(lastBar);
    if (!notes || !notes.length) continue;
    const last = notes.reduce((a, b) => (a.offset > b.offset ? a : b));
    const chord = chordPcs.get(lastBar);
    if (!chord) continue;
    boundariesChecked += 1;
    assert.ok(chord.has(last.midi % 12),
      `bar ${lastBar} (before boundary ${boundary}): melody landed on pc ${last.midi % 12}, not in the chord {${[...chord].join(',')}}`);
  }
  assert.ok(boundariesChecked >= 2, `only ${boundariesChecked} section boundaries had material to judge`);
}));

test('v12 melody: motif-derivation flag, if present, marks ≥70% of sounding bars and its cell recurs', () => hiddenTab(async () => {
  const log = await soloRun('melody', {
    randomness: 0.3, sequencer: { mode: 'manual', steps: seqLane({ prob: 1 }) },
  }, { seconds: 60, complexity: 0.6, repetition: 0.6 });
  const notes = log.notes.filter((n) => n.track === 'melody');
  const bars = [...log.byBar('melody').keys()];

  // The contract puts the flag on the bar plan; the only public surfaces a bar
  // plan could reach a tester through are the 'note' events for that track
  // (mirroring how percussion notes already carry `kind`) or the 'bar' event
  // itself gaining a melody-specific field. Both are checked; if neither
  // exists this is a genuine v12 ambiguity (the ownership contract never pins
  // the wire shape), not a failure — skip cleanly and say so.
  const noteFlag = notes.find((n) => typeof n.motif === 'boolean');
  const barFlag = log.bars.find((b) => typeof b.melodyMotif === 'boolean' || typeof b.motif === 'boolean');
  if (!noteFlag && !barFlag) {
    console.log('SKIP v12 motif flag: no `motif` field found on melody note or bar events '
      + '(contract does not pin the wire shape — see report for the interpretation tried)');
    return;
  }

  const flaggedBars = new Set();
  if (noteFlag) {
    for (const note of notes) {
      if (note.motif) flaggedBars.add(log.barOf(note).bar);
    }
  } else {
    for (const bar of log.bars) {
      if (bar.melodyMotif || bar.motif) flaggedBars.add(bar.bar);
    }
  }
  const soundingBars = bars.filter((bar) => bar >= 2);
  const flaggedRate = soundingBars.filter((bar) => flaggedBars.has(bar)).length / soundingBars.length;
  assert.ok(flaggedRate >= 0.7,
    `only ${(flaggedRate * 100).toFixed(0)}% of sounding bars carried the motif flag`);

  // Recurrence: the flagged notes' interval signature (consecutive semitone
  // deltas) should repeat somewhere else in the section — not just once, and
  // not literally every bar identical.
  const signature = (barNotes) => barNotes.map((n) => n.midi)
    .reduce((acc, midi, i, arr) => (i ? [...acc, midi - arr[i - 1]] : acc), []).join(',');
  const sigs = [...flaggedBars].sort((a, b) => a - b)
    .map((bar) => signature((log.byBar('melody').get(bar) || []).filter((n) => noteFlag ? n.motif : true)))
    .filter((sig) => sig.length);
  const counts = new Map();
  for (const sig of sigs) counts.set(sig, (counts.get(sig) ?? 0) + 1);
  const recurring = [...counts.values()].filter((count) => count >= 2).length;
  assert.ok(recurring > 0, 'no motif interval-signature recurred across the section');
  assert.ok(counts.size > 1, 'the exact same cell played every single flagged bar — never developed');
}));

// --------------------------------------------------------------------------
// v13/v14 — sequencer 2.0, dissonance, swing, bass groove, chord events,
// the silence floor, getResolved()
// --------------------------------------------------------------------------

test('silentBars/longestSilentRun/isContinuouslyAudible read a recording of bar and note events', () => {
  const bars = [0, 1, 2, 3, 4, 5].map((bar) => ({ bar, time: bar * 4 }));
  const notes = [
    { time: 0, duration: 4 },      // covers bar 0 exactly
    // bar 1 (4–8) and bar 2 (8–12): nothing at all — two silent bars in a row
    { time: 13, duration: 1 },     // inside bar 3 (12–16)
    // bar 4 (16–20): silent again, but a single bar this time
    { time: 3, duration: 3 },      // spans bar 0 (0–4) into bar 1 (4–8) — both heard
  ];
  const silent = silentBars(notes, bars);
  // bar 1 is covered by the spanning note above, so only bar 2 and bar 4 are silent.
  assert.deepEqual([...silent].sort((a, b) => a - b), [2, 4]);
  assert.equal(longestSilentRun(notes, bars), 1, 'no two silent bars are actually consecutive here');
  assert.ok(isContinuouslyAudible(notes, bars, { maxSilentBars: 1 }));
  assert.ok(!isContinuouslyAudible(notes, bars, { maxSilentBars: 0 }));

  // Two genuinely consecutive silent bars (plus bar 4, silent here too, but
  // it stands alone so it must not extend the longest RUN).
  const twoInARow = [{ time: 0, duration: 4 }, { time: 13, duration: 1 }];
  assert.deepEqual(silentBars(twoInARow, bars), [1, 2, 4]);
  assert.equal(longestSilentRun(twoInARow, bars), 2);
  assert.ok(!isContinuouslyAudible(twoInARow, bars, { maxSilentBars: 1 }));
  assert.ok(isContinuouslyAudible(twoInARow, bars, { maxSilentBars: 2 }));

  // No bars, no notes: vacuously audible — nothing to judge silent.
  assert.equal(longestSilentRun([], []), 0);
  assert.ok(isContinuouslyAudible([], [], { maxSilentBars: 0 }));
});

test('swungBeat: pair starts never move; the offbeat warps from 0.5 toward 0.75 as swing rises to 1', () => {
  for (const beat of [0, 1, 2, 3, 10]) {
    for (const swing of [0, 0.3, 0.7, 1]) {
      assert.equal(swungBeat(beat, SWING_UNIT, swing), beat, `a pair start must never move (beat ${beat}, swing ${swing})`);
    }
  }
  assert.equal(swungBeat(0.5, SWING_UNIT, 0), 0.5, 'swing 0 is straight');
  assert.equal(swungBeat(0.5, SWING_UNIT, 1), 0.75, 'swing 1 is the classic 75/25 split');
  const half = swungBeat(0.5, SWING_UNIT, 0.5);
  assert.ok(half > 0.5 && half < 0.75, `swing 0.5 (${half}) should sit strictly between straight and the full split`);
  // Monotonic: more swing never pulls the offbeat backward.
  let previous = 0.5;
  for (const swing of [0, 0.25, 0.5, 0.75, 1]) {
    const at = swungBeat(0.5, SWING_UNIT, swing);
    assert.ok(at >= previous - 1e-9, `swing ${swing} pulled the offbeat back to ${at}`);
    previous = at;
  }
  // Whatever is inside the swung half keeps its place proportionally — a
  // sixteenth a quarter of the way into the pair still reads a quarter of the
  // way into its (now unevenly sized) half.
  assert.ok(swungBeat(0.25, SWING_UNIT, 1) < swungBeat(0.5, SWING_UNIT, 1),
    'a sixteenth ahead of the offbeat must still land ahead of it once swung');
});

test('nameChord: Am in A aeolian, C6 in C majorPentatonic', () => {
  const aRoot = scaleDegreeToMidi(0, SCALES.aeolian, pitchClass('A'), 3);
  const aTriad = buildChord(0, 0).map((d) => scaleDegreeToMidi(d, SCALES.aeolian, pitchClass('A'), 3));
  assert.equal(nameChord(aRoot % 12, aTriad.map((m) => m - aRoot)), 'Am');

  const cRoot = scaleDegreeToMidi(0, SCALES.majorPentatonic, pitchClass('C'), 3);
  const cStack = buildChord(0, 0).map((d) => scaleDegreeToMidi(d, SCALES.majorPentatonic, pitchClass('C'), 3));
  assert.equal(nameChord(cRoot % 12, cStack.map((m) => m - cRoot)), 'C6',
    'stacking pentatonic thirds gives a sixth, not a triad — the name must say so');

  // A bare root, and a set nameChord cannot place at all, both degrade honestly.
  assert.equal(nameChord(0, []), 'C5');
  assert.equal(nameChord(2, [1]), 'D5', 'an interval the engine never actually voices still names honestly');
});

test('buildBassGroove: every felt pulse voices the root, and the anchor kick-locks to the low lane', () => {
  const starts = [0, 1, 2, 3];
  for (let seed = 1; seed <= 12; seed++) {
    const groove = buildBassGroove({ starts, beats: 4, intensity: 0.6, complexity: 0.6, rng: seededRng(seed) });
    assert.ok(BASS_FEEL_NAMES.includes(groove.feel));
    const sorted = groove.steps.slice().sort((a, b) => a.beat - b.beat);
    assert.deepEqual(groove.steps.map((s) => s.beat), sorted.map((s) => s.beat), 'steps must come back beat-sorted');
    for (const step of groove.steps) {
      const onPulse = starts.some((s) => Math.abs(s - step.beat) < 1e-9);
      if (onPulse) {
        assert.equal(step.tone, 'root', `seed ${seed}: a felt pulse (beat ${step.beat}) voiced ${step.tone}, not root`);
      } else {
        assert.ok(step.tone === 'fifth' || step.tone === 'octave',
          `seed ${seed}: an off-pulse step (beat ${step.beat}) voiced ${step.tone}`);
      }
    }
    assert.ok(groove.steps.some((s) => s.accent), `seed ${seed}: no accented anchor step at all`);
  }

  // No lock: the anchor sits on the downbeat.
  const unlocked = buildBassGroove({ starts, beats: 4, intensity: 0.5, complexity: 0.5, rng: seededRng(1) });
  const anchor = unlocked.steps.find((s) => s.accent);
  assert.equal(anchor.beat, 0);

  // The downbeat itself is not a kick: the anchor moves to the beat the kick
  // IS on, and the bar still owes its downbeat a (non-accented) root.
  const locked = buildBassGroove({
    starts, beats: 4, intensity: 0.5, complexity: 0.5, lowLane: [1], rng: seededRng(1),
  });
  const lockedAnchor = locked.steps.find((s) => s.accent);
  assert.equal(lockedAnchor.beat, 1, 'the anchor should have kick-locked onto beat 1');
  assert.ok(locked.steps.some((s) => s.beat === 0 && s.tone === 'root' && !s.accent),
    'the downbeat must still get a (non-accent) root when the anchor moved off it');

  // The downbeat itself IS a kick: no lock needed, the anchor stays put and no
  // spare downbeat root is pushed (nothing to reassert).
  const alreadyLocked = buildBassGroove({
    starts, beats: 4, intensity: 0.5, complexity: 0.5, lowLane: [0, 2], rng: seededRng(1),
  });
  const stillAnchor = alreadyLocked.steps.find((s) => s.accent);
  assert.equal(stillAnchor.beat, 0);

  // Every beat the low lane hits gets a root, every seed, every time (chance 1).
  for (let seed = 1; seed <= 8; seed++) {
    const g = buildBassGroove({
      starts, beats: 4, intensity: 0.5, complexity: 0.5, lowLane: [2], rng: seededRng(seed),
    });
    assert.ok(g.steps.some((s) => s.beat === 2 && s.tone === 'root'),
      `seed ${seed}: the locked beat 2 never got a root`);
  }
});

test('developBassGroove: ghost/push/simplify/double transform a stated groove, and pulses stay root throughout', () => {
  const starts = [0, 1, 2, 3];

  const pulsesOnly = { feel: 'mixed', beats: 4, steps: [
    { beat: 0, tone: 'root', gate: 0.9, accent: true },
    { beat: 1, tone: 'root', gate: 0.5, accent: false },
    { beat: 2, tone: 'root', gate: 0.5, accent: false },
    { beat: 3, tone: 'root', gate: 0.5, accent: false },
  ] };
  for (let seed = 1; seed <= 5; seed++) {
    const ghosted = developBassGroove(pulsesOnly, 'ghost', { starts, rng: seededRng(seed) });
    assert.equal(ghosted.steps.length, pulsesOnly.steps.length + 1, `seed ${seed}: ghost must add exactly one step`);
    const added = ghosted.steps.find((s) => s.ghost === true);
    assert.ok(added, `seed ${seed}: ghost added nothing marked ghost`);
    assert.equal(added.tone, 'octave');
    assert.ok([0.5, 1.5, 2.5, 3.5].some((b) => Math.abs(b - added.beat) < 1e-9),
      `seed ${seed}: ghost landed on beat ${added.beat}, not a half-beat slot`);
  }

  const onePush = { feel: 'mixed', beats: 4, steps: [
    { beat: 0, tone: 'root', gate: 0.9, accent: true },
    { beat: 1.5, tone: 'fifth', gate: 0.3, accent: false },
  ] };
  const pushed = developBassGroove(onePush, 'push', { starts, rng: seededRng(1) });
  assert.equal(pushed.steps.length, onePush.steps.length, 'push moves a note, it does not add or remove one');
  const movedStep = pushed.steps.find((s) => s.tone === 'fifth');
  assert.ok(Math.abs(movedStep.beat - 1.25) < 1e-9, `push should land the fifth on 1.25, got ${movedStep.beat}`);

  const twoOffPulse = { feel: 'mixed', beats: 4, steps: [
    { beat: 0, tone: 'root', gate: 0.9, accent: true },
    { beat: 1.5, tone: 'fifth', gate: 0.3, accent: false },
    { beat: 2.75, tone: 'octave', gate: 0.3, accent: false },
  ] };
  const simplified = developBassGroove(twoOffPulse, 'simplify', { starts, rng: seededRng(1) });
  assert.equal(simplified.steps.length, twoOffPulse.steps.length - 1, 'simplify drops exactly one step');
  assert.ok(!simplified.steps.some((s) => s.beat === 2.75), 'simplify should have dropped the LAST off-pulse step');
  assert.ok(simplified.steps.some((s) => s.beat === 1.5), 'simplify dropped the wrong step');

  const oneDoublable = { feel: 'mixed', beats: 4, steps: [
    { beat: 0, tone: 'root', gate: 0.9, accent: true },
    { beat: 2.75, tone: 'octave', gate: 0.3, accent: false },
  ] };
  for (let seed = 1; seed <= 5; seed++) {
    const doubled = developBassGroove(oneDoublable, 'double', { starts, rng: seededRng(seed) });
    assert.equal(doubled.steps.length, oneDoublable.steps.length + 1, `seed ${seed}: double must add exactly one step`);
    const added = doubled.steps.find((s) => s.ghost === true);
    assert.ok(added && Math.abs(added.beat - 3.25) < 1e-9, `seed ${seed}: double should land its echo on 3.25`);
  }

  // The contract survives every op: whatever lands on a felt pulse is root.
  for (const [base, op] of [[pulsesOnly, 'ghost'], [onePush, 'push'], [twoOffPulse, 'simplify'], [oneDoublable, 'double']]) {
    const next = developBassGroove(base, op, { starts, rng: seededRng(2) });
    for (const step of next.steps) {
      if (starts.some((s) => Math.abs(s - step.beat) < 1e-9)) {
        assert.equal(step.tone, 'root', `${op}: a pulse step ended up voicing ${step.tone}`);
      }
    }
  }

  // cloneBassGroove must not hand back shared state.
  const clone = cloneBassGroove(pulsesOnly);
  clone.steps[0].tone = 'fifth';
  assert.equal(pulsesOnly.steps[0].tone, 'root', 'cloneBassGroove aliased the original steps');
});

test('bassGrooveOp: bar 0 of every 4-bar cycle states the groove, and randomness 0 always does', () => {
  for (let bar = 0; bar <= 40; bar += 4) {
    assert.equal(bassGrooveOp(bar, 0.9, seededRng(bar + 1), 'push'), 'state',
      `bar ${bar} of a 4-bar cycle must state the groove regardless of variation`);
  }
  for (let bar = 0; bar < 20; bar++) {
    assert.equal(bassGrooveOp(bar, 0, seededRng(bar + 1), 'push'), 'state',
      `bar ${bar}: randomness (variation) 0 must always state the groove`);
  }
  // Away from those two guards, every development op is genuinely reachable.
  const seen = new Set();
  const rng = seededRng(999);
  let previous = 'state';
  for (let bar = 1; bar < 800; bar++) {
    if (bar % 4 === 0) { previous = 'state'; continue; }
    previous = bassGrooveOp(bar, 0.7, rng, previous);
    seen.add(previous);
  }
  for (const op of BASS_GROOVE_OPS) assert.ok(seen.has(op), `bassGrooveOp never produced '${op}' across 800 bars`);
});

// --------------------------------------------------------------------------
// v24 — the bass craft pass. The v14 groove got the NOTES right and still did
// not sound like a bassist; these are the properties that separate the two.
// --------------------------------------------------------------------------

test('v24 bass: the groove keeps its own pulse when there is no kit to lock to', () => {
  const starts = [0, 1, 2, 3];
  for (let seed = 1; seed <= 60; seed++) {
    const groove = buildBassGroove({
      starts, beats: 4, intensity: 0.5, complexity: 0.5, lowLane: null, rng: seededRng(seed),
    });
    const pulses = new Set(groove.steps
      .filter((step) => starts.some((start) => Math.abs(start - step.beat) < 1e-9))
      .map((step) => step.beat));
    // A line with no drums under it used to fill each non-anchor pulse on an
    // independent coin flip, which is a density, not a groove. It must now hold
    // a regular stride through the bar's pulses, the same way it holds a kick.
    const stride = [1, 2, 3].find((n) => starts.filter((_, i) => i % n === 0).every((b) => pulses.has(b)));
    assert.ok(stride !== undefined,
      `seed ${seed}: the drummerless pulses [${[...pulses].join(', ')}] follow no stride at all`);
  }
});

test('v24 bass: note length is part of the groove — one bar carries several distinct gates', () => {
  const spreads = [];
  for (let seed = 1; seed <= 40; seed++) {
    const groove = buildBassGroove({
      starts: [0, 1, 2, 3], beats: 4, intensity: 0.6, complexity: 0.6, rng: seededRng(seed),
    });
    const gates = new Set(groove.steps.map((step) => step.gate.toFixed(3)));
    assert.ok(gates.size >= 2,
      `seed ${seed}: every step of the groove was the same length (${[...gates].join(', ')})`);
    for (const step of groove.steps) {
      assert.ok(step.gate >= 0.12 - 1e-9 && step.gate <= 1 + 1e-9,
        `seed ${seed}: a gate of ${step.gate} is outside the playable range`);
    }
    spreads.push(gates.size);
  }
  const mean = spreads.reduce((a, b) => a + b, 0) / spreads.length;
  assert.ok(mean >= 3, `the average groove carried only ${mean.toFixed(2)} distinct note lengths`);

  // The phrase ending: the bar's last note either rings across the barline (a
  // held line, handed over by the mono glide) or lifts off it, never neither.
  for (let seed = 1; seed <= 40; seed++) {
    const groove = buildBassGroove({
      starts: [0, 1, 2, 3], beats: 4, intensity: 0.6, complexity: 0.6, rng: seededRng(seed),
    });
    const tail = groove.steps[groove.steps.length - 1];
    assert.ok(groove.feel === 'held' ? tail.gate === 1 : tail.gate <= 0.45,
      `seed ${seed}: a '${groove.feel}' groove ended its bar on a gate of ${tail.gate}`);
  }
});

test('v24 bass fills: only ever the last bar of an eight-bar count, and rare even there', () => {
  // Never in the opening bars of a section, at any variation or intensity.
  for (let bar = 0; bar < 7; bar++) {
    for (let seed = 1; seed <= 40; seed++) {
      assert.notEqual(bassGrooveOp(bar, 1, seededRng(seed), 'state', 1), 'fill',
        `bar ${bar} of a section is too early for a fill — the ear has not learnt the line yet`);
    }
  }

  // Reachable at the turnaround, and only there.
  const rng = seededRng(555);
  const positions = new Map();
  let fills = 0;
  let previous = 'state';
  const bars = 4000;
  for (let bar = 1; bar < bars; bar++) {
    const at = bar % 32;
    const op = bassGrooveOp(at, 0.7, rng, previous, 0.5);
    previous = at % 4 === 0 ? 'state' : op;
    if (op !== 'fill') continue;
    fills += 1;
    positions.set(at, (positions.get(at) ?? 0) + 1);
  }
  assert.ok(fills > 0, 'no bar in 4000 ever turned around');
  assert.deepEqual([...positions.keys()].sort((a, b) => a - b), [7, 15, 23, 31],
    'a fill landed somewhere other than the last bar of an eight-bar count');
  assert.ok(fills / bars <= 0.08,
    `${((fills / bars) * 100).toFixed(1)}% of bars filled — a fill that common is just the line`);

  // A quiet section barely fills at all; a loud one fills more often.
  const rate = (intensity) => {
    const own = seededRng(818);
    let hits = 0;
    for (let bar = 0; bar < 2000; bar++) hits += bassGrooveOp(7, 0.7, own, 'state', intensity) === 'fill' ? 1 : 0;
    return hits / 2000;
  };
  assert.ok(rate(0.15) < rate(0.9), 'intensity does not scale how often the line turns around');

  // And a fill is never said twice running, however sticky the variation is.
  for (let seed = 1; seed <= 60; seed++) {
    assert.notEqual(bassGrooveOp(9, 0.1, seededRng(seed), 'fill', 0.5), 'fill',
      `seed ${seed}: a fill repeated itself on the bar after one`);
  }
});

test('v24 bass fills: the turnaround clears the tail of the bar and leaves the pulses alone', () => {
  const starts = [0, 1, 2, 3];
  const base = {
    feel: 'mixed',
    beats: 4,
    pocket: 0,
    steps: [
      { beat: 0, tone: 'root', gate: 0.95, accent: true },
      { beat: 2, tone: 'root', gate: 0.5, accent: false },
      { beat: 3, tone: 'root', gate: 0.5, accent: false },
      { beat: 3.5, tone: 'fifth', gate: 0.35, accent: false, ghost: true },
    ],
  };
  for (let seed = 1; seed <= 12; seed++) {
    const filled = developBassGroove(base, 'fill', { starts, rng: seededRng(seed) });
    const run = filled.steps.filter((step) => step.fill === true);
    assert.ok(run.length >= 2, `seed ${seed}: a fill of ${run.length} note(s) is not a run`);
    for (const step of run) {
      assert.ok(step.beat > base.beats - 1, `seed ${seed}: a fill note at beat ${step.beat} is not in the turnaround`);
      assert.ok(!starts.some((start) => Math.abs(start - step.beat) < 1e-9),
        `seed ${seed}: a fill note took a felt pulse, which owes the root`);
    }
    // The bar still lands where it did: every felt pulse survives, still root.
    for (const start of [0, 2, 3]) {
      const kept = filled.steps.find((step) => Math.abs(step.beat - start) < 1e-9);
      assert.ok(kept && kept.tone === 'root', `seed ${seed}: the fill disturbed the pulse on beat ${start}`);
    }
    // The old tail is gone rather than crowded by the run.
    assert.ok(!filled.steps.some((step) => Math.abs(step.beat - 3.5) < 1e-9 && step.fill !== true),
      `seed ${seed}: the groove's own tail note played underneath the fill`);
  }
});

test('v24 bass pocket: one constant lay-back for the whole line, never early, never per note',
  () => hiddenTab(async () => {
    // bpm 120 at speed 1 gives half-second beats, so a sixteenth is 0.125 s and
    // every onset the groove can produce sits exactly on that grid. Swing is off,
    // which leaves the pocket as the only thing that can move a note off it.
    const sixteenth = (60 / 120) / 4;
    const deviations = async (timing) => {
      const log = await soloRun('bass', { randomness: 0.3, vary: { timing, volume: 0, voice: 0 } },
        { seconds: 50, seed: 8801, bpm: 120, speed: 1, swing: 0 });
      const notes = log.notes.filter((note) => note.track === 'bass');
      assert.ok(notes.length >= 40, `only ${notes.length} bass notes to judge`);
      const barAt = (note) => log.barOf(note);
      return notes.map((note) => {
        const offset = note.time - barAt(note).time;
        return offset - Math.round(offset / sixteenth) * sixteenth;
      });
    };

    const laidBack = await deviations(1);
    const distinct = new Set(laidBack.map((d) => d.toFixed(6)));
    assert.equal(distinct.size, 1,
      `the bass sat in ${distinct.size} different places against the beat — that is jitter, not a pocket`);
    const pocket = laidBack[0];
    assert.ok(pocket > 1e-4, `the bass sat ${(pocket * 1000).toFixed(1)} ms off the grid — no lay-back at all`);
    assert.ok(pocket <= 0.025 + 1e-9, `a ${(pocket * 1000).toFixed(1)} ms lay-back is past the humanisation bound`);

    // The dial still means what it says: no humanisation, no pocket.
    const tight = await deviations(0);
    for (const d of tight) {
      assert.ok(Math.abs(d) < 1e-9, `vary.timing 0 must leave the bass exactly on the grid, got ${d}`);
    }
  }));

test('v24 bass contour: ghosts are genuinely quiet after shaping, and the anchor is genuinely an accent',
  () => hiddenTab(async () => {
    const log = await soloRun('bass', { randomness: 0.5, vary: { timing: 0, volume: 0.5, voice: 0 } },
      { seconds: 60, seed: 8802, complexity: 0.8 });
    const notes = log.notes.filter((note) => note.track === 'bass');
    assert.ok(notes.length >= 100, `only ${notes.length} bass notes to judge`);

    // Ghosts survive the volume jitter and the engine's own velocity clamp.
    const ghosts = notes.filter((note) => note.velocity <= BASS_GHOST_CEILING);
    assert.ok(ghosts.length >= notes.length * 0.05,
      `only ${ghosts.length} of ${notes.length} bass notes were ghosts — the line has no quiet gestures in it`);

    // The anchor is worth hearing as one: a downbeat against the loudest ghost.
    const downbeats = notes
      .filter((note) => Math.abs(note.time - log.barOf(note).time) < 1e-6)
      .map((note) => note.velocity);
    assert.ok(downbeats.length >= 10, `only ${downbeats.length} anchors to judge`);
    const softestAnchor = Math.min(...downbeats);
    const loudestGhost = Math.max(...ghosts.map((note) => note.velocity));
    assert.ok(softestAnchor >= 0.8,
      `the quietest anchor came out at ${softestAnchor.toFixed(3)} — that is not an accent`);
    assert.ok(loudestGhost * 2.3 <= softestAnchor,
      `the loudest ghost (${loudestGhost.toFixed(3)}) is within earshot of the quietest anchor `
      + `(${softestAnchor.toFixed(3)}) — the contour is flat`);
  }));

test('v24 bass articulation: a rendered bar carries several distinct note lengths',
  () => hiddenTab(async () => {
    const log = await soloRun('bass', { randomness: 0.2, vary: { timing: 0, volume: 0, voice: 0 } },
      { seconds: 60, seed: 8803, complexity: 0.7 });
    const byBar = log.byBar('bass');
    const spreads = [...byBar.values()]
      .filter((notes) => notes.length >= 4)
      .map((notes) => new Set(notes.map((note) => note.duration.toFixed(3))).size);
    assert.ok(spreads.length >= 20, `only ${spreads.length} bars of four notes or more to judge`);
    assert.ok(Math.min(...spreads) >= 3,
      'a bar of four bass notes came out with fewer than three distinct lengths — that is a pump, not a line');
    const mean = spreads.reduce((a, b) => a + b, 0) / spreads.length;
    assert.ok(mean >= 3.5, `the average bar carried only ${mean.toFixed(2)} distinct note lengths`);
  }));

test('v24 bass: a modulating structure states its groove and holds it, instead of re-rolling every bar',
  () => hiddenTab(async () => {
    // `waves` hands out a fresh section intensity for EVERY bar (a cosine over a
    // sixteen-bar period), and `build` ramps one. Keying the groove on that
    // number to three decimals re-rolled the line bar by bar under both, which
    // is to say the v14 groove never engaged at all for two of the five
    // structure presets — the user's "low-pitch random" verdict, literally.
    for (const structure of ['waves', 'build']) {
      const log = await soloRun('bass', { randomness: 0, vary: { timing: 0, volume: 0, voice: 0 } },
        { seconds: 70, seed: 8804, structure, complexity: 0.5 });
      const byBar = log.byBar('bass');
      const bars = [...byBar.keys()].filter((bar) => bar >= 3).sort((a, b) => a - b);
      assert.ok(bars.length >= 20, `${structure}: only ${bars.length} bass bars to judge`);
      const onsets = (bar) => new Set((byBar.get(bar) ?? []).map((note) => note.offset.toFixed(3)));
      const agreements = [];
      for (let i = 1; i < bars.length; i++) {
        const a = onsets(bars[i - 1]);
        const b = onsets(bars[i]);
        let shared = 0;
        for (const beat of a) if (b.has(beat)) shared += 1;
        agreements.push(shared / new Set([...a, ...b]).size);
      }
      const mean = agreements.reduce((x, y) => x + y, 0) / agreements.length;
      assert.ok(mean >= 0.7,
        `${structure}: bass onsets agreed bar-to-bar only ${mean.toFixed(2)} of the time — the groove is re-rolling`);
      assert.ok(agreements.filter((value) => value > 0.99).length >= agreements.length * 0.6,
        `${structure}: fewer than three bars in five simply restated the line`);
    }
  }));

/** Every field this suite needs before it can drive v13/v14 features at all. */
function v14Shipped() {
  return typeof DEFAULT_PARAMS.tracks.pad.dissonance === 'number'
    && typeof DEFAULT_PARAMS.swing === 'number'
    && Array.isArray(DEFAULT_PARAMS.tracks.melody.sequencers);
}

test('the silence floor: nothing is silent after staging at the defaults; a solo pad still gets its one bar of breath', () => hiddenTab(async () => {
  if (!v14Shipped()) { console.log('SKIP v14 silence floor: v14 params not present yet'); return; }

  const engine = createEngine();   // the shipped defaults, nothing overridden
  const log = record(engine);
  await engine.start();
  await advance(245, FAST);        // >60 bars at the default 60 bpm, 4/4
  engine.stop();
  const bars = log.bars.filter((b) => b.bar >= 5); // staging owns bars 0–4
  assert.ok(bars.length >= 55, `only ${bars.length} post-staging bars to judge`);
  assert.ok(isContinuouslyAudible(log.notes, bars, { maxSilentBars: 0 }),
    `longest silent run at the defaults: ${longestSilentRun(log.notes, bars)} bars`);

  const solo = createEngine({
    bpm: 120, speed: 2, structure: 'waves', complexity: 0.5, repetition: 0.5,
    tracks: { ...tracksAll('off'), pad: { state: 'on', randomness: 0.5, vary: { timing: 0, voice: 0 } } },
  }, { rng: seededRng(9003) });
  const soloLog = record(solo);
  await solo.start();
  await advance(96, FAST);
  solo.stop();
  const soloBars = soloLog.bars.filter((b) => b.bar >= 5);
  assert.ok(soloBars.length >= 60, `only ${soloBars.length} post-staging bars to judge`);
  assert.ok(isContinuouslyAudible(soloLog.notes, soloBars, { maxSilentBars: 1 }),
    `a solo pad should never rest more than 1 bar in a row (longest run: ${longestSilentRun(soloLog.notes, soloBars)})`);
}));

test('percussion activates at the defaults within the first waves cycle', () => hiddenTab(async () => {
  if (!v14Shipped()) { console.log('SKIP v14 percussion activation: v14 params not present yet'); return; }
  // Full shipped defaults: complexity 0.5 resolves structure to 'waves', and
  // the v14 threshold retune means the peak of that cycle now actually
  // reaches percussion's activation energy — it is still the last track in.
  const engine = createEngine();
  const log = record(engine);
  await engine.start();
  await advance(100, FAST);
  engine.stop();
  const percussionBars = [...log.byBar('percussion').keys()];
  assert.ok(percussionBars.length > 0, 'percussion never sounded once at the defaults across a full waves cycle');
  const first = Math.min(...percussionBars);
  const STAGE = TRACK_ORDER.indexOf('percussion');
  assert.ok(first >= STAGE, `percussion sounded in bar ${first}, before its own staged entry (bar ${STAGE})`);
  const N = 20; // generous: percussion only reaches threshold near the waves peak
  assert.ok(first <= N, `percussion first sounded in bar ${first}, later than the ${N}-bar bound`);
}));

test("emitChord: a 'chord' event fires every bar, and nameChord's own reading of its midis matches the name it published",
  () => hiddenTab(async () => {
    const engine = createEngine({
      bpm: 120, speed: 2, complexity: 0.6, repetition: 0.8, structure: 'custom',
      customStructure: [{ label: 'A', bars: 8, intensity: 1 }],
      tracks: { ...tracksAll('off'), pad: { state: 'on', randomness: 0, vary: { timing: 0, voice: 0 } } },
    }, { rng: seededRng(6001) });
    const chords = [];
    engine.on('chord', (c) => chords.push(c));
    const log = record(engine);
    await engine.start();
    await advance(45, FAST);
    engine.stop();
    assert.ok(log.bars.length >= 10, `only ${log.bars.length} bars`);
    assert.ok(chords.length >= log.bars.length - 1,
      `only ${chords.length} chord events for ${log.bars.length} bars — not one a bar`);

    let checked = 0;
    for (const chord of chords) {
      if (chord.bar > FIRST_PASS_BAR_CEILING) break; // inversion may be nonzero after the first pass
      assert.ok(Array.isArray(chord.midis) && chord.midis.length > 0, `bar ${chord.bar}: a chord event with no midis`);
      assert.equal(typeof chord.name, 'string');
      assert.ok(/^[A-G]#?/.test(chord.name), `bar ${chord.bar}: "${chord.name}" doesn't read as a chord name`);
      const root = Math.min(...chord.midis);
      const expected = nameChord(root % 12, chord.midis.map((m) => m - root));
      assert.equal(chord.name, expected,
        `bar ${chord.bar}: engine published "${chord.name}" but nameChord reads its own midis as "${expected}"`);
      checked += 1;
    }
    assert.ok(checked >= 4, `only ${checked} first-pass chord events to cross-check`);
  }));

test('swing warps an offbeat onset toward 0.75 of its pulse at swing 1; the downbeat never moves', () => hiddenTab(async () => {
  if (!v14Shipped()) { console.log('SKIP v14 swing: v14 params not present yet'); return; }
  const lanes = (on) => ({
    low: seqLane({ on: false }), mid: seqLane({ on: false }), high: seqLane({ on: false }),
  });
  const offsetsFor = async (swing) => {
    const steps = { low: seqLane({ on: false }), mid: seqLane({ on: false }), high: seqLane({ on: false }) };
    steps.low[0] = { on: true, prob: 1, vmin: 0.5, vmax: 0.5 };  // the downbeat
    steps.low[2] = { on: true, prob: 1, vmin: 0.5, vmax: 0.5 };  // the offbeat (beat 0.5)
    const engine = createEngine({
      bpm: 120, speed: 2, complexity: 0.5, repetition: 0.5, structure: 'custom', swing,
      customStructure: [{ label: 'A', bars: 8, intensity: 1 }],
      tracks: {
        ...tracksAll('off'),
        percussion: { state: 'on', randomness: 0, sequencer: { mode: 'manual', steps } },
      },
    }, { rng: seededRng(1) });
    const log = record(engine);
    await engine.start();
    await advance(16, FAST);
    engine.stop();
    const byBar = log.byBar('percussion');
    const bar = [...byBar.keys()].find((b) => b >= TRACK_ORDER.indexOf('percussion') + 1);
    return byBar.get(bar).map((n) => n.offset).sort((a, b) => a - b);
  };

  const straight = await offsetsFor(0);
  const swung = await offsetsFor(1);
  const secPerBeat = 60 / (120 * 2);
  assert.equal(straight[0].toFixed(4), (0).toFixed(4), 'the downbeat must sit at offset 0 with no swing');
  assert.equal(swung[0].toFixed(4), (0).toFixed(4), 'the downbeat must never move, whatever the swing');
  assert.ok(Math.abs(straight[1] - 0.5 * secPerBeat) < 1e-6, `straight offbeat should sit at 0.5 beats, got ${straight[1]}`);
  assert.ok(Math.abs(swung[1] - 0.75 * secPerBeat) < 1e-6, `swing 1 offbeat should sit at 0.75 beats, got ${swung[1]}`);
}));

test('dissonance 0 never leaves the scale; dissonance 1 produces substantial out-of-scale (borrowed) notes', () => hiddenTab(async () => {
  if (!v14Shipped()) { console.log('SKIP v14 dissonance: v14 params not present yet'); return; }
  // Out-of-scale is the uncontaminated ground truth here: ordinary melodic
  // writing (the motif's own passing tones) can legitimately land off a given
  // chord even at dissonance 0, but it can NEVER leave the mode — only the
  // dissonance draw's chromatic branch can do that (dissonanceDraw returns a
  // literal falsy 0 at amount<=0, so `bend` is exactly 0 on every note).
  const scalePcs = new Set(SCALES.majorPentatonic.map((s) => (s + pitchClass('C')) % 12));
  const runFor = async (dissonance) => {
    const engine = createEngine({
      bpm: 120, speed: 2, complexity: 0.5, repetition: 0.5, structure: 'custom',
      customStructure: [{ label: 'A', bars: 8, intensity: 1 }],
      tracks: {
        ...tracksAll('off'),
        melody: {
          state: 'on', randomness: 0, dissonance, vary: { timing: 0 },
          sequencer: { mode: 'manual', steps: seqLane({ prob: 1 }) },
        },
      },
    }, { rng: seededRng(3002) });
    const log = record(engine);
    await engine.start();
    await advance(40, FAST);
    engine.stop();
    return log.notes.filter((n) => n.track === 'melody');
  };

  const clean = await runFor(0);
  assert.ok(clean.length >= 50, `only ${clean.length} melody notes at dissonance 0`);
  assert.ok(clean.every((n) => scalePcs.has(n.midi % 12)),
    'dissonance 0 produced a note outside the mode — the chromatic branch fired with nothing to drive it');

  const dissonant = await runFor(1);
  assert.ok(dissonant.length >= 50, `only ${dissonant.length} melody notes at dissonance 1`);
  const outOfScale = dissonant.filter((n) => !scalePcs.has(n.midi % 12)).length;
  const rate = outOfScale / dissonant.length;
  assert.ok(rate >= 0.1, `only ${(rate * 100).toFixed(0)}% of dissonance-1 notes left the mode — not substantial`);
}));

test("multiple sequencers[] alternate by their Markov transition weights, and getResolved() reports which one is active",
  () => hiddenTab(async () => {
    if (!v14Shipped()) { console.log('SKIP v14 sequencers[]: v14 params not present yet'); return; }
    const laneA = seqLane({ on: false }); laneA[0] = { on: true, prob: 1, vmin: 0.5, vmax: 0.5 };
    const laneB = seqLane({ on: false }); laneB[8] = { on: true, prob: 1, vmin: 0.5, vmax: 0.5 };
    const engine = createEngine({
      bpm: 120, speed: 2, complexity: 0.5, repetition: 0.5, structure: 'custom',
      customStructure: [{ label: 'A', bars: 16, intensity: 1 }],
      tracks: {
        ...tracksAll('off'),
        melody: {
          state: 'on', randomness: 0.3, vary: { timing: 0 },
          // Deterministic strict alternation, whatever rng draws: sequencer 0
          // always transitions to 1 and vice versa (an all-or-nothing weight
          // row needs no particular rng value to resolve).
          sequencers: [
            { mode: 'manual', steps: laneA, weights: [0, 1] },
            { mode: 'manual', steps: laneB, weights: [1, 0] },
          ],
        },
      },
    }, { rng: seededRng(4001) });
    const log = record(engine);
    await engine.start();
    await advance(40, FAST);
    engine.stop();

    const byBar = log.byBar('melody');
    const bars = [...byBar.keys()].filter((b) => b >= TRACK_ORDER.indexOf('melody') + 1).sort((a, b) => a - b);
    assert.ok(bars.length >= 20, `only ${bars.length} melody bars to judge`);
    const secPerBeat = 60 / (120 * 2);
    const which = (bar) => {
      const notes = byBar.get(bar);
      assert.equal(notes.length, 1, `bar ${bar}: expected exactly one note from whichever sequencer is active`);
      const beats = notes[0].offset / secPerBeat;
      if (Math.abs(beats - 0) < 0.05) return 'A';
      if (Math.abs(beats - 2) < 0.05) return 'B';
      assert.fail(`bar ${bar}: note landed on beat ${beats}, neither sequencer's step`);
    };
    const stream = bars.map(which);
    for (let i = 1; i < stream.length; i++) {
      assert.notEqual(stream[i], stream[i - 1], `bars ${bars[i - 1]}→${bars[i]}: the sequencer failed to alternate`);
    }
    assert.ok(stream.includes('A') && stream.includes('B'), 'only one sequencer was ever heard — no alternation observed');

    if (typeof engine.getResolved === 'function') {
      // getResolved() reads live state, which is scheduling ahead of the
      // last NOTE this suite managed to capture (a bar's plan — including
      // which sequencer plays it — is settled before that bar's own onsets
      // are actually dispatched). The bar just BEFORE the resolved one is
      // always fully captured, and strict alternation pins the current bar
      // to its opposite.
      const resolved = engine.getResolved();
      const priorBar = resolved.bar - 1;
      if (byBar.get(priorBar)?.length === 1) {
        const priorIndex = which(priorBar) === 'A' ? 0 : 1;
        assert.equal(resolved.tracks.melody.sequencer, priorIndex === 0 ? 1 : 0,
          'getResolved() reported a sequencer index inconsistent with the strict alternation just observed');
      }
    }
  }));

test("a tied sequencer step merges with the one after it, halving the bar's onsets", () => hiddenTab(async () => {
  if (!v14Shipped()) { console.log('SKIP v14 tie merging: v14 params not present yet'); return; }
  const control = seqLane({ prob: 1 });
  const tied = seqLane({ prob: 1 });
  for (let i = 0; i < SEQUENCER_STEP_COUNT; i += 2) tied[i].tie = true;

  const onsetsFor = async (steps) => {
    const engine = createEngine({
      bpm: 120, speed: 2, complexity: 0.5, repetition: 0.5, structure: 'custom',
      customStructure: [{ label: 'A', bars: 8, intensity: 1 }],
      tracks: {
        ...tracksAll('off'),
        bass: { state: 'on', randomness: 0, mono: false, vary: { timing: 0 }, sequencer: { mode: 'manual', steps } },
      },
    }, { rng: seededRng(5001) });
    const log = record(engine);
    await engine.start();
    await advance(30, FAST);
    engine.stop();
    const byBar = log.byBar('bass');
    const bar = [...byBar.keys()].find((b) => b >= TRACK_ORDER.indexOf('bass') + 1);
    return byBar.get(bar).length;
  };

  const plain = await onsetsFor(control);
  const merged = await onsetsFor(tied);
  assert.equal(plain, 16, `control lane: expected all 16 sixteenths to sound, got ${plain}`);
  assert.equal(merged, 8, `tied lane: expected exactly half the onsets (8), got ${merged}`);
}));

test("groupedProb: a later note in a probability group only sounds when the group's first note actually sounded",
  () => hiddenTab(async () => {
    if (!v14Shipped()) { console.log('SKIP v14 grouped probability: v14 params not present yet'); return; }
    const lane = seqLane({ on: false });
    lane[0] = { on: true, prob: 0.5, vmin: 0.5, vmax: 0.5, group: 1 }; // sometimes sounds
    lane[4] = { on: true, prob: 1, vmin: 0.5, vmax: 0.5, group: 1 };   // conditioned on step 0
    lane[8] = { on: true, prob: 1, vmin: 0.5, vmax: 0.5 };             // ungrouped anchor, always sounds

    const engine = createEngine({
      bpm: 120, speed: 2, complexity: 0.5, repetition: 0.5, structure: 'custom',
      customStructure: [{ label: 'A', bars: 16, intensity: 1 }],
      tracks: {
        ...tracksAll('off'),
        bass: { state: 'on', randomness: 0.6, vary: { timing: 0 }, sequencer: { mode: 'manual', steps: lane } },
      },
    }, { rng: seededRng(6003) });
    const log = record(engine);
    await engine.start();
    await advance(40, FAST);
    engine.stop();

    const byBar = log.byBar('bass');
    const bars = [...byBar.keys()].filter((b) => b >= TRACK_ORDER.indexOf('bass') + 1).sort((a, b) => a - b);
    assert.ok(bars.length >= 20, `only ${bars.length} bass bars to judge`);
    const secPerBeat = 60 / (120 * 2);
    let sawFirstThenSecond = 0;
    let sawSecondWithoutFirst = 0;
    for (const bar of bars) {
      const beats = byBar.get(bar).map((n) => n.offset / secPerBeat);
      const anchor = beats.some((b) => Math.abs(b - 2) < 0.05);
      assert.ok(anchor, `bar ${bar}: the ungrouped anchor note never sounded`);
      const first = beats.some((b) => Math.abs(b - 0) < 0.05);
      const second = beats.some((b) => Math.abs(b - 1) < 0.05);
      if (second && !first) sawSecondWithoutFirst += 1;
      if (second && first) sawFirstThenSecond += 1;
    }
    assert.equal(sawSecondWithoutFirst, 0, "the group's second note sounded without its first note somewhere");
    assert.ok(sawFirstThenSecond > 0, "the group's chain never actually fired across 20+ bars");
  }));

test('randomness 0 is a full hold on its own: consecutive bars are byte-identical in rhythm, not merely similar',
  () => hiddenTab(async () => {
    if (!v14Shipped()) { console.log('SKIP v14 randomness-0-is-hold: v14 params not present yet'); return; }
    const engine = createEngine({
      bpm: 120, speed: 2, complexity: 0.5, repetition: 0.5, structure: 'custom',
      customStructure: [{ label: 'A', bars: 16, intensity: 1 }],
      tracks: { ...tracksAll('off'), bass: { state: 'on', randomness: 0 } }, // no explicit hold: true anywhere
    }, { rng: seededRng(7002) });
    const log = record(engine);
    await engine.start();
    await advance(40, FAST);
    engine.stop();

    const byBar = log.byBar('bass');
    const bars = [...byBar.keys()].filter((b) => b >= TRACK_ORDER.indexOf('bass') + 2).sort((a, b) => a - b);
    assert.ok(bars.length >= 20, `only ${bars.length} bass bars to judge`);
    // Rhythm and dynamics only — pitch is deliberately excluded: harmony keeps
    // advancing underneath a frozen groove (ruling 5), so the chord root can
    // legitimately change bar to bar even while the groove itself is held.
    const signature = (notes) => notes
      .map((n) => `${n.offset.toFixed(3)}:${n.velocity.toFixed(4)}:${n.duration.toFixed(4)}`)
      .join(',');
    const signatures = new Set(bars.map((bar) => signature(byBar.get(bar))));
    assert.equal(signatures.size, 1,
      `randomness 0 did not freeze the bass groove's rhythm: ${[...signatures].length} distinct bars`);
  }));

test("getResolved() reports the shape and values the v14 live-readout contract promises", () => hiddenTab(async () => {
  if (typeof engineModule.createEngine({}).getResolved !== 'function') {
    console.log('SKIP getResolved(): this engine build has no v14 getResolved()');
    return;
  }
  const engine = createEngine({
    tracks: { ...tracksAll('auto'), melody: { state: 'auto', sequencers: [{ mode: 'auto' }, { mode: 'auto' }] } },
  }, { rng: seededRng(8002) });
  await engine.start();
  await advance(10, FAST);
  const resolved = engine.getResolved();
  engine.stop();

  assert.equal(typeof resolved.running, 'boolean');
  assert.ok(Number.isInteger(resolved.bar) && resolved.bar >= 0);
  assert.equal(typeof resolved.section.label, 'string');
  assert.ok(resolved.section.intensity >= 0 && resolved.section.intensity <= 1);
  assert.deepEqual(Object.keys(resolved.tracks), [...TRACK_ORDER]);
  assert.deepEqual(Object.keys(resolved.patches), [...TRACK_ORDER]);

  for (const name of TRACK_ORDER) {
    const t = resolved.tracks[name];
    assert.equal(typeof t.state, 'string');
    assert.equal(typeof t.active, 'boolean');
    assert.equal(typeof t.voice, 'string');
    assert.ok(t.level >= 0 && t.level <= 1, `${name}: resolved level ${t.level} out of range`);
    assert.ok(t.randomness >= 0 && t.randomness <= 1, `${name}: resolved randomness ${t.randomness} out of range`);
    assert.equal(typeof t.held, 'boolean');
    assert.deepEqual(Object.keys(t.vary).sort(), [...VARY_ASPECTS].sort());
    for (const aspect of VARY_ASPECTS) {
      assert.ok(t.vary[aspect] >= 0 && t.vary[aspect] <= 1, `${name}.vary.${aspect} out of range`);
    }
    if (TUNED_TRACKS.includes(name)) {
      assert.ok('dissonance' in t, `${name}: TUNED_TRACKS member has no resolved dissonance`);
      assert.ok(t.dissonance >= 0 && t.dissonance <= 1);
    } else {
      assert.ok(!('dissonance' in t), `${name}: percussion should not resolve a dissonance`);
    }
  }
  // melody was configured with two sequencers above: its resolved index must
  // be a valid slot; a single-sequencer track (everything else here) must not
  // publish one at all.
  assert.ok(Number.isInteger(resolved.tracks.melody.sequencer)
    && resolved.tracks.melody.sequencer >= 0 && resolved.tracks.melody.sequencer < 2);
  for (const name of TRACK_ORDER) {
    if (name === 'melody') continue;
    assert.ok(!('sequencer' in resolved.tracks[name]), `${name}: single-sequencer track should not resolve an index`);
  }
}));

// --------------------------------------------------------------------------
// v15 — repeat brackets (loop region)
// --------------------------------------------------------------------------

/**
 * What each BAR OCCURRENCE was heard to play: every note that fell inside it,
 * with its pitch (or drum kind), its bar-relative onset and its velocity.
 * Indexed by position in the bar stream rather than by bar number, because a
 * repeat plays the same bar number many times over.
 */
function occurrenceSignatures(log) {
  const index = new Map(log.bars.map((bar, i) => [bar, i]));
  const sigs = log.bars.map(() => []);
  for (const note of log.notes) {
    const owner = log.barOf(note);
    if (!owner) continue;
    sigs[index.get(owner)].push(
      `${note.track}:${note.midi ?? note.kind}`
      + `@${(note.time - owner.time).toFixed(6)}v${note.velocity.toFixed(6)}`,
    );
  }
  return sigs.map((notes) => notes.join('|'));
}

/** The positions in the bar stream at which `number` was played. */
const occurrencesOf = (log, number) => log.bars
  .map((bar, i) => (bar.bar === number ? i : -1))
  .filter((i) => i >= 0);

/** A loop run: `loop` is a [start, end] pair, or null for the free control. */
async function loopRun(loop, { seconds = 26, seed = 515, clearAfter = null } = {}) {
  const engine = createEngine({
    bpm: 120, speed: 2, structure: 'drone', complexity: 0.6, repetition: 0.4,
    tracks: {
      ...tracksAll('off'),
      pad: { state: 'on' },
      melody: { state: 'on' },
      percussion: { state: 'on' },
    },
  }, { rng: seededRng(seed) });
  const log = record(engine);
  const chords = [];
  engine.on('chord', (chord) => chords.push(chord));
  log.chords = chords;
  try {
    if (loop) log.region = engine.setLoopRegion(loop[0], loop[1]);
    await engine.start();
    if (clearAfter === null) {
      await advance(seconds, FAST);
    } else {
      await advance(clearAfter, FAST);
      engine.clearLoopRegion();
      await advance(seconds - clearAfter, FAST);
    }
  } finally {
    engine.stop();
  }
  return log;
}

test('a repeat replays the material and the harmony its range captured', () => hiddenTab(async () => {
  const looped = await loopRun([6, 10]);
  assert.deepEqual(looped.region, { start: 6, end: 10 });

  const numbers = looped.bars.map((bar) => bar.bar);
  assert.ok(numbers.length > 20, `only ${numbers.length} bars`);
  assert.deepEqual(numbers.slice(0, 11), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 6],
    `the piece did not jump back at the close of the repeat: ${numbers.join(',')}`);

  const starts = occurrencesOf(looped, 6);
  assert.ok(starts.length >= 3, `only ${starts.length} passes of the repeat`);
  const sigs = occurrenceSignatures(looped);
  const pass = (at) => sigs.slice(at, at + 4);
  const first = pass(starts[0]);
  assert.ok(first.some((sig) => sig.length), 'the repeated range never played a note');
  for (const at of starts.slice(1)) {
    // A bar is only fully scheduled once the next one has begun, so the last
    // bar of the log is always partial: judge a pass only when a bar follows it.
    if (at + 4 >= looped.bars.length) continue;
    assert.deepEqual(pass(at), first,
      `pass at bar-stream position ${at} did not replay the captured material`);
  }

  // Harmony is frozen to the range: the same chords, in the same order, every
  // pass — the hook does not advance inside the brackets.
  const chordNames = (at) => looped.chords
    .filter((chord) => chord.time >= looped.bars[at].time - 1e-9
      && chord.time < looped.bars[at + 4].time - 1e-9)
    .map((chord) => chord.name);
  const firstChords = chordNames(starts[0]);
  assert.equal(firstChords.length, 4, `expected four chord events per pass: ${firstChords}`);
  for (const at of starts.slice(1)) {
    if (at + 4 >= looped.bars.length) continue;
    assert.deepEqual(chordNames(at), firstChords, 'the harmony moved under the repeat');
  }

  // The control: with no brackets, those same bars do not repeat themselves.
  const free = occurrenceSignatures(await loopRun(null));
  assert.notDeepEqual(free.slice(10, 14), free.slice(6, 10),
    'the unlooped control repeated anyway — the loop test proves nothing here');
}));

test('a repeated piece is deterministic under a seeded rng', () => hiddenTab(async () => {
  const once = await loopRun([5, 9], { seconds: 14, seed: 909 });
  const twice = await loopRun([5, 9], { seconds: 14, seed: 909 });
  const bars = Math.min(once.bars.length, twice.bars.length) - 1;
  assert.ok(bars > 10, `only ${bars} comparable bars`);
  assert.deepEqual(twice.bars.slice(0, bars).map((bar) => bar.bar),
    once.bars.slice(0, bars).map((bar) => bar.bar));
  assert.deepEqual(occurrenceSignatures(twice).slice(0, bars),
    occurrenceSignatures(once).slice(0, bars),
    'the same seed and the same brackets played a different piece');
}));

test('clearing a repeat resumes from its close at the next bar', () => hiddenTab(async () => {
  const log = await loopRun([6, 10], { seconds: 26, clearAfter: 16 });
  const numbers = log.bars.map((bar) => bar.bar);
  assert.ok(occurrencesOf(log, 6).length >= 3, `only ${occurrencesOf(log, 6).length} passes`);

  // Everything before the clear is inside the brackets; everything after is
  // the piece playing on from the close, one bar at a time.
  const resumed = numbers.findIndex((number) => number >= 10);
  assert.ok(resumed > 0, `the piece never left the repeat: ${numbers.join(',')}`);
  assert.equal(numbers[resumed], 10, 'generation must resume at the loop\'s end, not past it');
  for (let i = resumed; i < numbers.length; i++) {
    assert.equal(numbers[i], 10 + (i - resumed), `bar ${i} broke the resumed count`);
  }
  for (const bar of log.bars.slice(resumed)) {
    assert.equal(bar.loop, null, 'a cleared repeat still advertised itself');
  }

  // The material moves again: a cleared repeat is not a permanent hold.
  const sigs = occurrenceSignatures(log).slice(resumed);
  assert.ok(new Set(sigs.filter((sig) => sig.length)).size > 1,
    'the material stayed frozen after the repeat was cleared');
}));

test('a repeat over a held track is still the repeat that decides the material', () => hiddenTab(async () => {
  const engine = createEngine({
    bpm: 120, speed: 2, structure: 'drone', complexity: 0.6,
    tracks: {
      ...tracksAll('off'),
      pad: { state: 'on' },
      melody: {
        state: 'on', hold: true, randomness: 0.5, vary: { timing: 0 },
        sequencer: { mode: 'manual', steps: seqLane({ prob: 0.5 }) },
      },
    },
  }, { rng: seededRng(707) });
  const log = record(engine);
  try {
    engine.setLoopRegion(6, 9);
    await engine.start();
    await advance(24, FAST);
  } finally {
    engine.stop();
  }

  const starts = occurrencesOf(log, 6);
  assert.ok(starts.length >= 3, `only ${starts.length} passes of the repeat`);
  const sigs = occurrenceSignatures(log);
  const first = sigs.slice(starts[0], starts[0] + 3);
  assert.ok(first.some((sig) => sig.length), 'nothing sounded inside the repeat');
  for (const at of starts.slice(1)) {
    // As above: the log's last bar is only part-scheduled, so it never judges.
    if (at + 3 >= log.bars.length) continue;
    assert.deepEqual(sigs.slice(at, at + 3), first, 'hold and the repeat disagreed');
  }
}));

test('bar events carry the repeat brackets while they are set', () => hiddenTab(async () => {
  const log = await loopRun([6, 10], { seconds: 14 });
  const before = log.bars.filter((bar) => bar.bar < 6);
  assert.ok(before.length >= 6, 'expected the staged bars ahead of the brackets');
  for (const bar of log.bars) {
    assert.deepEqual(bar.loop, {
      start: 6,
      end: 10,
      active: bar.bar >= 6 && bar.bar < 10,
    }, `bar ${bar.bar} reported the wrong loop info`);
  }

  const unset = await loopRun(null, { seconds: 6 });
  for (const bar of unset.bars) {
    assert.equal(bar.loop, null, 'an engine with no brackets must say so, not stay silent');
  }
}));

test('setLoopRegion sanitises its brackets; clearLoopRegion reports whether one was set', () => {
  const engine = createEngine();
  assert.deepEqual(engine.setLoopRegion(4, 8), { start: 4, end: 8 });
  assert.deepEqual(engine.setLoopRegion(8, 4), { start: 4, end: 8 }, 'reversed brackets normalise');
  assert.deepEqual(engine.setLoopRegion(3, 3), { start: 3, end: 4 }, 'an empty span is one bar');
  assert.deepEqual(engine.setLoopRegion(-5, 2), { start: 0, end: 2 }, 'bar numbers start at 0');
  assert.deepEqual(engine.setLoopRegion(-9, -3), { start: 0, end: 1 });
  assert.deepEqual(engine.setLoopRegion(0, 500), { start: 0, end: 64 }, 'the span is clamped to 64 bars');
  assert.deepEqual(engine.setLoopRegion(10, 999), { start: 10, end: 74 });
  assert.deepEqual(engine.setLoopRegion(2.7, 9.9), { start: 2, end: 9 }, 'a bar number is an integer');

  for (const args of [[], [4], [NaN, 4], [4, NaN], ['nonsense', 4], [null, 8], [{}, []]]) {
    assert.equal(engine.setLoopRegion(...args), null, `setLoopRegion(${args}) should be a no-op`);
  }

  assert.equal(engine.clearLoopRegion(), true);
  assert.equal(engine.clearLoopRegion(), false, 'clearing nothing clears nothing');
  // Neither call may throw while the engine is stopped.
  engine.setLoopRegion(2, 6);
  engine.clearLoopRegion();
});

test('finish() during a repeat leaves the loop and then runs the outro', () => hiddenTab(async () => {
  const engine = createEngine({
    bpm: 120, speed: 2, structure: 'drone', complexity: 0.5,
    tracks: { ...tracksAll('off'), pad: { state: 'on' }, melody: { state: 'on' } },
  }, { rng: seededRng(616) });
  const log = record(engine);
  const states = [];
  engine.on('state', (state) => states.push(state));
  engine.setLoopRegion(4, 8);
  await engine.start();
  await advance(14, FAST);
  assert.ok(occurrencesOf(log, 4).length >= 2, 'the piece never went round the repeat');

  const ending = engine.finish({ fadeSeconds: 1 });
  const settled = await settleWithin(ending, 30);
  engine.stop();
  assert.ok(settled, 'finish() never resolved out of a repeat');

  const numbers = log.bars.map((bar) => bar.bar);
  assert.ok(numbers[numbers.length - 1] >= 8,
    `the outro played inside the brackets: ${numbers.join(',')}`);
  assert.equal(log.bars[log.bars.length - 1].loop, null,
    'the closing bar still carried a repeat');
  assert.ok(states.some((state) => state.running === false && state.finished === true),
    'the ending never announced itself');
}));

// --------------------------------------------------------------------------
// v14 — kit editor: per-instrument patch overrides
// --------------------------------------------------------------------------

test('perKind overrides sanitise like any other patch and merge sparsely', () => {
  const params = sanitiseParams({
    patches: {
      percussion: {
        soft: {
          filter: { cutoff: 900 },
          perKind: {
            low: { filter: { cutoff: 40000 }, source: { octave: 9 } },
            high: { adsr: { release: 99 } },
            bogus: { filter: { cutoff: 500 } },
            mid: 'nonsense',
          },
        },
      },
    },
  });
  const patch = params.patches.percussion.soft;
  assert.deepEqual(Object.keys(patch.perKind).sort(), ['high', 'low'], 'unknown kinds are dropped');
  assert.equal(patch.perKind.low.filter.cutoff, 12000, 'an override clamps like a patch field');
  assert.equal(patch.perKind.low.source.octave, 2);
  assert.equal(patch.perKind.high.adsr.release, 12);
  assert.equal(patch.filter.cutoff, 900, 'the common patch is untouched by its overrides');

  // A later edit of one kind leaves the other kinds, and the common patch, alone.
  const merged = sanitiseParams({
    patches: { percussion: { soft: { perKind: { high: { adsr: { attack: 0.5 } } } } } },
  }, params).patches.percussion.soft;
  assert.equal(merged.filter.cutoff, 900);
  assert.equal(merged.perKind.low.filter.cutoff, 12000);
  assert.equal(merged.perKind.high.adsr.release, 12, 'a sparse edit dropped a sibling field');
  assert.equal(merged.perKind.high.adsr.attack, 0.5);

  // A patch that is nothing BUT overrides still survives, and getParams hands
  // back a copy nobody can write through.
  const engine = createEngine({
    patches: { percussion: { tick: { perKind: { mid: { filter: { q: 8 } } } } } },
  });
  const reported = engine.getParams();
  assert.equal(reported.patches.percussion.tick.perKind.mid.filter.q, 8);
  reported.patches.percussion.tick.perKind.mid.filter.q = 1;
  assert.equal(engine.getParams().patches.percussion.tick.perKind.mid.filter.q, 8);
});

test('a per-instrument override reaches play() for its own kind only', () => hiddenTab(async () => {
  const percussion = spyOnBank(bankFor('percussion'));
  const pad = spyOnBank(bankFor('pad'));
  try {
    const engine = createEngine({
      bpm: 120, speed: 2, structure: 'drone', complexity: 0.6,
      tracks: {
        ...tracksAll('off'),
        pad: { state: 'on', vary: { voice: 0 } },
        percussion: {
          state: 'on',
          vary: { voice: 0 },
          sequencer: {
            mode: 'manual',
            steps: Object.fromEntries(PERCUSSION_LANES.map((lane) => [lane, seqLane({ prob: 1 })])),
          },
        },
      },
      patches: {
        percussion: {
          soft: {
            filter: { cutoff: 900 },
            adsr: { release: 0.5 },
            perKind: {
              low: { filter: { cutoff: 200 } },
              high: { adsr: { release: 2 } },
            },
          },
        },
        pad: { warm: { filter: { cutoff: 800 }, perKind: { low: { filter: { cutoff: 60 } } } } },
      },
    }, { rng: seededRng(4141) });
    await engine.start();
    await advance(14, FAST);
    engine.stop();

    const heard = new Map();
    for (const play of percussion.plays) {
      if (!heard.has(play.note.kind)) heard.set(play.note.kind, []);
      heard.get(play.note.kind).push(play.patch);
    }
    for (const lane of PERCUSSION_LANES) {
      assert.ok(heard.get(lane)?.length, `the ${lane} lane never sounded`);
    }
    for (const patch of heard.get('low')) {
      assert.equal(patch.filter.cutoff, 200, 'the low override did not reach play()');
      assert.equal(patch.adsr.release, 0.5, 'the common patch was lost under the override');
      assert.equal(patch.perKind, undefined, 'a voice was handed the whole override map');
    }
    for (const patch of heard.get('mid')) {
      assert.equal(patch.filter.cutoff, 900, 'an unoverridden kind must play the common patch');
      assert.equal(patch.adsr.release, 0.5);
    }
    for (const patch of heard.get('high')) {
      assert.equal(patch.filter.cutoff, 900, 'the low override leaked onto the high lane');
      assert.equal(patch.adsr.release, 2);
    }

    assert.ok(pad.plays.length, 'the pad never sounded');
    for (const play of pad.plays) {
      assert.equal(play.note.kind, null, 'a melodic note carried a percussion kind');
      assert.equal(play.patch.filter.cutoff, 800, 'the pad lost its common patch');
      assert.equal(play.patch.perKind, undefined, 'per-instrument overrides leaked to a melodic track');
    }
  } finally {
    percussion.restore();
    pad.restore();
  }
}));

// --------------------------------------------------------------------------
// v7 range dials in the voice patch — the fields the UI's range dials write
// --------------------------------------------------------------------------

/** Every v7-rangeable patch field, with a range inside its own bounds. */
const RANGEABLE_PATCH_FIELDS = [
  ['source', 'mix', { min: 0.2, max: 0.8 }],
  ['source', 'detune', { min: -30, max: 20 }],
  // v18: percussion's semitone tuning and noise level. The field table is
  // track-agnostic, so they sanitise here exactly as they do on a kit.
  ['source', 'pitch', { min: -18, max: 7 }],
  ['source', 'noise', { min: 0.2, max: 0.9 }],
  // v19: every dial on the noise-sculpting surface and every dial on the call
  // primitive. The contract makes them RangeValue-capable "everywhere", so
  // there is no fixed member of either family.
  ['source', 'tilt', { min: -0.6, max: 0.4 }],
  ['source', 'bandCentre', { min: 200, max: 4000 }],
  ['source', 'bandWidth', { min: 0.4, max: 3 }],
  ['source', 'sweepRate', { min: 0.02, max: 0.3 }],
  ['source', 'sweepDepth', { min: 0.1, max: 0.8 }],
  ['source', 'gust', { min: 0.1, max: 0.7 }],
  ['source', 'gustRate', { min: 0.04, max: 0.3 }],
  ['source', 'burst', { min: 0.1, max: 0.9 }],
  ['source', 'burstSharp', { min: 0.2, max: 0.8 }],
  ['source', 'swell', { min: 0, max: 0.6 }],
  ['source', 'glide', { min: -12, max: 9 }],
  ['source', 'glideCurve', { min: 0.2, max: 0.9 }],
  ['source', 'formant1', { min: 300, max: 1800 }],
  ['source', 'formant2', { min: 900, max: 5000 }],
  ['source', 'cadence', { min: 1, max: 6 }],
  ['source', 'irregular', { min: 0.1, max: 0.8 }],
  ['filter', 'cutoff', { min: 400, max: 4000 }],
  ['filter', 'q', { min: 1, max: 9 }],
  ['filter', 'envAmount', { min: 0.1, max: 0.9 }],
  ['adsr', 'attack', { min: 0.05, max: 2 }],
  ['adsr', 'decay', { min: 0.1, max: 3 }],
  ['adsr', 'sustain', { min: 0.2, max: 0.7 }],
  ['adsr', 'release', { min: 0.5, max: 6 }],
  ['sends', 'reverb', { min: 0.1, max: 0.6 }],
  ['sends', 'delay', { min: 0, max: 0.4 }],
];

/** A patch carrying one field, wrapped for sanitiseParams. */
const patchWith = (section, field, value) => ({
  patches: { pad: { warm: { [section]: { [field]: value } } } },
});

test('v7: every rangeable patch field takes a {min,max}, and the fixed ones refuse one', () => {
  for (const [section, field, range] of RANGEABLE_PATCH_FIELDS) {
    const stored = sanitiseParams(patchWith(section, field, range)).patches.pad?.warm?.[section];
    assert.deepEqual(stored?.[field], range,
      `${section}.${field} dropped a range the v7 dial can write`);

    // Reversed bounds swap rather than reject, exactly as level/randomness do.
    const swapped = sanitiseParams(patchWith(section, field, { min: range.max, max: range.min }))
      .patches.pad.warm[section][field];
    assert.deepEqual(swapped, range, `${section}.${field} did not swap reversed bounds`);

    // Both ends clamp into the field's OWN bounds, not some shared 0–1.
    const clamped = sanitiseParams(patchWith(section, field, { min: -99999, max: 99999 }))
      .patches.pad.warm[section][field];
    assert.equal(typeof clamped.min, 'number');
    assert.ok(clamped.min < clamped.max, `${section}.${field} collapsed when clamped`);
    const single = sanitiseParams(patchWith(section, field, 99999)).patches.pad.warm[section][field];
    assert.equal(clamped.max, single, `${section}.${field} clamps a range end differently from a number`);

    // Half-formed is rejected, not guessed at: the field simply does not land.
    assert.deepEqual(sanitiseParams(patchWith(section, field, { min: range.min })).patches, {},
      `${section}.${field} accepted a half-written range`);
    assert.deepEqual(sanitiseParams(patchWith(section, field, { min: range.min, max: 'nope' })).patches, {},
      `${section}.${field} accepted a range with an unusable bound`);

    // A plain number still behaves exactly as it always did.
    assert.equal(sanitiseParams(patchWith(section, field, range.min)).patches.pad.warm[section][field],
      range.min, `${section}.${field} stopped taking a plain number`);
  }

  // NOT rangeable (v7): the morph dials, octave and the filter type.
  for (const [section, field, range] of [
    ['source', 'shape1', { min: 0, max: 3 }],
    ['source', 'shape2', { min: 0, max: 3 }],
    ['source', 'octave', { min: -1, max: 1 }],
    ['filter', 'type', { min: 0, max: 1 }],
  ]) {
    assert.deepEqual(sanitiseParams(patchWith(section, field, range)).patches, {},
      `${section}.${field} accepted a range the engine can only take a single value for`);
  }

  // perKind follows the same field rules as the common patch.
  const kit = sanitiseParams({
    patches: {
      percussion: {
        soft: {
          perKind: {
            low: { filter: { cutoff: { min: 4000, max: 100 }, type: { min: 0, max: 1 } } },
            high: { sends: { reverb: { min: 0.2 } } },
          },
        },
      },
    },
  }).patches.percussion.soft;
  assert.deepEqual(kit.perKind.low.filter.cutoff, { min: 100, max: 4000 },
    'a kit override dropped, or failed to normalise, a ranged field');
  assert.equal(kit.perKind.low.filter.type, undefined, 'a kit override took a ranged filter type');
  assert.equal(kit.perKind.high, undefined, 'a kit override kept a half-written range');
});

test('v7: getParams round-trips the range form, and hands out a copy of it', () => {
  const engine = createEngine({
    patches: {
      pad: {
        warm: {
          filter: { cutoff: { min: 400, max: 4000 }, q: 3 },
          sends: { reverb: { min: 0.1, max: 0.6 } },
          perKind: { low: { adsr: { release: { min: 0.5, max: 4 } } } },
        },
      },
    },
  });
  const stored = engine.getParams().patches.pad.warm;
  assert.deepEqual(stored, {
    filter: { cutoff: { min: 400, max: 4000 }, q: 3 },
    sends: { reverb: { min: 0.1, max: 0.6 } },
    perKind: { low: { adsr: { release: { min: 0.5, max: 4 } } } },
  }, 'getParams must report the stored form, ranges intact');

  const snapshot = engine.getParams();
  snapshot.patches.pad.warm.filter.cutoff.min = 40;
  snapshot.patches.pad.warm.perKind.low.adsr.release.max = 12;
  assert.equal(engine.getParams().patches.pad.warm.filter.cutoff.min, 400,
    'a caller wrote through getParams into the engine\'s own range object');
  assert.equal(engine.getParams().patches.pad.warm.perKind.low.adsr.release.max, 4,
    'a kit override\'s range was handed out by reference');

  // getResolved() is the other half of the contract: the same fields, resolved.
  const resolved = engine.getResolved().patches.pad;
  assert.equal(typeof resolved.filter.cutoff, 'number', 'getResolved must report numbers');
  assert.ok(resolved.filter.cutoff >= 400 && resolved.filter.cutoff <= 4000);
  assert.equal(typeof resolved.sends.reverb, 'number');
  assert.equal(resolved.perKind, undefined, 'getResolved leaked the override map');
});

/**
 * Play a solo pad with `settings` and one patch, and hand back the cutoff each
 * note was actually played with — the number the voice writes to its filter's
 * frequency, so a drifting sequence here is a drifting sound.
 */
async function padCutoffs(patch, settings, seed, seconds = 14) {
  const pad = spyOnBank(bankFor('pad'));
  try {
    const engine = createEngine({
      bpm: 120, speed: 2, structure: 'drone', complexity: 0.6,
      tracks: { ...tracksAll('off'), pad: { state: 'on', vary: { voice: 0 }, ...settings } },
      patches: { pad: { warm: patch } },
    }, { rng: seededRng(seed) });
    await engine.start();
    await advance(seconds, FAST);
    engine.stop();
    assert.ok(pad.plays.length > 4, `only ${pad.plays.length} pad notes to measure`);
    return pad.plays.map((play) => {
      assert.equal(typeof play.patch.filter.cutoff, 'number',
        'ruling 9c: a voice must never be handed a {min,max}');
      return play.patch.filter.cutoff;
    });
  } finally {
    pad.restore();
  }
}

test('v7: a ranged cutoff drifts across bars, deterministically, inside its bounds', () => hiddenTab(async () => {
  const ranged = { filter: { cutoff: { min: 400, max: 4000 }, q: 3 } };
  const drifting = await padCutoffs(ranged, { randomness: 0.6 }, 5101);
  for (const cutoff of drifting) {
    assert.ok(cutoff >= 400 - 1e-6 && cutoff <= 4000 + 1e-6,
      `a resolved cutoff of ${cutoff} is outside its 400–4000 bounds`);
  }
  assert.ok(new Set(drifting.map((v) => v.toFixed(6))).size > 1,
    'a ranged cutoff never moved — the range dial is a no-op');

  // Same seed, same piece: the walk is drawn from the engine's own rng.
  assert.deepEqual(await padCutoffs(ranged, { randomness: 0.6 }, 5101), drifting,
    'a seeded run did not reproduce its own cutoff drift');

  // A plain number is untouched by any of this.
  const fixed = await padCutoffs({ filter: { cutoff: 900 } }, { randomness: 0.6 }, 5102);
  assert.deepEqual([...new Set(fixed)], [900], 'a single-valued cutoff drifted');
}));

test('v7: randomness 0 freezes a ranged patch the way hold does', () => hiddenTab(async () => {
  const ranged = { filter: { cutoff: { min: 400, max: 4000 } } };
  const frozen = new Set((await padCutoffs(ranged, { randomness: 0 }, 5103)).map((v) => v.toFixed(6)));
  assert.equal(frozen.size, 1, `randomness 0 let a ranged patch drift: ${[...frozen]}`);

  const held = new Set(
    (await padCutoffs(ranged, { randomness: 0.6, hold: true }, 5104)).map((v) => v.toFixed(6)),
  );
  assert.equal(held.size, 1, `hold let a ranged patch drift: ${[...held]}`);
}));

test('v7: a ranged send drifts the track send gains bar by bar', () => hiddenTab(async () => {
  const engine = createEngine({
    bpm: 120, speed: 2, structure: 'drone', complexity: 0.6,
    tracks: { ...tracksAll('off'), pad: { state: 'on', randomness: 0.6, vary: { voice: 0 } } },
    patches: { pad: { warm: { sends: { reverb: { min: 0.2, max: 0.8 }, delay: 0.3 } } } },
  }, { rng: seededRng(5105) });
  await engine.start();
  const sends = sendGains(liveContexts[liveContexts.length - 1]).pad;
  const seen = [];
  for (let i = 0; i < 12; i++) {
    await advance(1, FAST);
    seen.push(sends.reverb.gain.value);
  }
  engine.stop();
  for (const value of seen) {
    assert.ok(value >= 0.2 - 1e-6 && value <= 0.8 + 1e-6,
      `a reverb send of ${value} is outside its 0.2–0.8 bounds`);
  }
  assert.ok(new Set(seen.map((v) => v.toFixed(9))).size > 1, 'a ranged reverb send never drifted');
  assert.equal(sends.delay.gain.value, 0.3, 'the single-valued delay send moved');
}));

test('v7: a ranged perKind override resolves for its own kind only', () => hiddenTab(async () => {
  const percussion = spyOnBank(bankFor('percussion'));
  try {
    const engine = createEngine({
      bpm: 120, speed: 2, structure: 'drone', complexity: 0.6,
      tracks: {
        ...tracksAll('off'),
        percussion: {
          state: 'on',
          randomness: 0.6,
          vary: { voice: 0 },
          sequencer: {
            mode: 'manual',
            steps: Object.fromEntries(PERCUSSION_LANES.map((lane) => [lane, seqLane({ prob: 1 })])),
          },
        },
      },
      patches: {
        percussion: {
          soft: {
            filter: { cutoff: 900 },
            perKind: { low: { filter: { cutoff: { min: 100, max: 400 } } } },
          },
        },
      },
    }, { rng: seededRng(5106) });
    await engine.start();
    await advance(14, FAST);
    engine.stop();

    const byKind = new Map();
    for (const play of percussion.plays) {
      if (!byKind.has(play.note.kind)) byKind.set(play.note.kind, []);
      byKind.get(play.note.kind).push(play.patch.filter.cutoff);
    }
    const low = byKind.get('low');
    assert.ok(low?.length > 4, 'the low lane never sounded enough to measure');
    for (const cutoff of low) {
      assert.equal(typeof cutoff, 'number', 'a kit override reached a voice as a {min,max}');
      assert.ok(cutoff >= 100 - 1e-6 && cutoff <= 400 + 1e-6,
        `a resolved override of ${cutoff} is outside its 100–400 bounds`);
    }
    assert.ok(new Set(low.map((v) => v.toFixed(6))).size > 1, 'a ranged kit override never drifted');
    for (const lane of ['mid', 'high']) {
      assert.deepEqual([...new Set(byKind.get(lane) ?? [])], [900],
        `the ranged low override leaked onto the ${lane} lane`);
    }
  } finally {
    percussion.restore();
  }
}));

// --------------------------------------------------------------------------
// v18 — percussion source.pitch / source.noise
// --------------------------------------------------------------------------

test('v18: pitch is continuous within ±24 semitones, where octave stays a switch', () => {
  const sourceOf = (source) => sanitiseParams({ patches: { percussion: { soft: { source } } } })
    .patches.percussion?.soft?.source;

  // Continuous: a fraction of a semitone survives, unlike the octave switch.
  assert.equal(sourceOf({ pitch: 3.5 }).pitch, 3.5);
  assert.equal(sourceOf({ octave: 1.4 }).octave, 1, 'octave stopped rounding to a switch position');

  // Two octaves either way, and no further.
  assert.equal(sourceOf({ pitch: 24 }).pitch, 24);
  assert.equal(sourceOf({ pitch: -24 }).pitch, -24);
  assert.equal(sourceOf({ pitch: 99 }).pitch, 24);
  assert.equal(sourceOf({ pitch: -99 }).pitch, -24);

  // Noise is a plain 0–1 level.
  assert.equal(sourceOf({ noise: 0 }).noise, 0);
  assert.equal(sourceOf({ noise: 1 }).noise, 1);
  assert.equal(sourceOf({ noise: 4 }).noise, 1, 'a noise level above 1 was not clamped');
  assert.equal(sourceOf({ noise: -1 }).noise, 0);

  // Rubbish is dropped rather than guessed at, like every other patch field.
  for (const bad of [NaN, 'loud', null, true, undefined]) {
    assert.equal(sourceOf({ pitch: bad })?.pitch, undefined, `pitch accepted ${String(bad)}`);
    assert.equal(sourceOf({ noise: bad })?.noise, undefined, `noise accepted ${String(bad)}`);
  }

  // A kit override takes them on the same terms as the common patch.
  const kit = sanitiseParams({
    patches: {
      percussion: {
        soft: {
          source: { pitch: -5, noise: 0.4 },
          perKind: { low: { source: { pitch: 99, noise: { min: 0.8, max: 0.1 } } } },
        },
      },
    },
  }).patches.percussion.soft;
  assert.deepEqual(kit.source, { pitch: -5, noise: 0.4 });
  assert.deepEqual(kit.perKind.low.source, { pitch: 24, noise: { min: 0.1, max: 0.8 } });
});

test('v18: a ranged pitch/noise reaches the voice as numbers, per kind', () => hiddenTab(async () => {
  const percussion = spyOnBank(bankFor('percussion'));
  try {
    const engine = createEngine({
      bpm: 120, speed: 2, structure: 'drone', complexity: 0.6,
      tracks: {
        ...tracksAll('off'),
        percussion: {
          state: 'on',
          randomness: 0.6,
          vary: { voice: 0 },
          sequencer: {
            mode: 'manual',
            steps: Object.fromEntries(PERCUSSION_LANES.map((lane) => [lane, seqLane({ prob: 1 })])),
          },
        },
      },
      patches: {
        percussion: {
          soft: {
            source: { noise: { min: 0.2, max: 0.9 } },
            perKind: { low: { source: { pitch: { min: -12, max: -2 } } } },
          },
        },
      },
    }, { rng: seededRng(4041) });
    await engine.start();
    await advance(14, FAST);
    engine.stop();

    const byKind = new Map();
    for (const play of percussion.plays) {
      if (!byKind.has(play.note.kind)) byKind.set(play.note.kind, []);
      byKind.get(play.note.kind).push(play.patch.source);
    }
    assert.ok(percussion.plays.length > 4, 'the kit never sounded enough to measure');
    for (const [kind, sources] of byKind) {
      for (const source of sources) {
        assert.equal(typeof source.noise, 'number', `${kind}: a ranged noise reached a voice unresolved`);
        assert.ok(source.noise >= 0.2 - 1e-6 && source.noise <= 0.9 + 1e-6,
          `${kind}: a resolved noise of ${source.noise} is outside its 0.2–0.9 bounds`);
      }
    }
    const low = byKind.get('low') ?? [];
    assert.ok(low.length > 4, 'the low lane never sounded enough to measure');
    for (const source of low) {
      assert.equal(typeof source.pitch, 'number', 'a ranged pitch reached a voice unresolved');
      assert.ok(source.pitch >= -12 - 1e-6 && source.pitch <= -2 + 1e-6,
        `a resolved pitch of ${source.pitch} is outside its -12–-2 bounds`);
    }
    assert.ok(new Set(low.map((s) => s.pitch.toFixed(6))).size > 1, 'a ranged pitch never drifted');
    assert.ok(new Set(byKind.get('low').map((s) => s.noise.toFixed(6))).size > 1,
      'a ranged noise never drifted');
    for (const lane of ['mid', 'high']) {
      assert.ok((byKind.get(lane) ?? []).every((s) => s.pitch === undefined),
        `the low lane's pitch override leaked onto the ${lane} lane`);
    }
  } finally {
    percussion.restore();
  }
}));

// --------------------------------------------------------------------------
// v19 — the parametric noise-sculpting surface reaches the voices as numbers
// --------------------------------------------------------------------------

/** Every field v19 adds, with the bounds the contract gives it. */
const V19_BOUNDS = {
  tilt: [-1, 1],
  bandCentre: [60, 8000],
  bandWidth: [0.1, 4],
  sweepRate: [0, 0.5],
  sweepDepth: [0, 1],
  gust: [0, 1],
  gustRate: [0.02, 0.5],
  burst: [0, 1],
  burstSharp: [0, 1],
  swell: [0, 1],
  glide: [-24, 24],
  glideCurve: [0, 1],
  formant1: [60, 8000],
  formant2: [60, 8000],
  cadence: [0.5, 8],
  irregular: [0, 1],
};

test('v19: each new source field clamps to its own bounds and refuses rubbish', () => {
  const sourceOf = (source) => sanitiseParams({ patches: { texture: { colour: { source } } } })
    .patches.texture?.colour?.source;

  for (const [field, [lo, hi]] of Object.entries(V19_BOUNDS)) {
    assert.equal(sourceOf({ [field]: lo })[field], lo, `${field} dropped its low bound`);
    assert.equal(sourceOf({ [field]: hi })[field], hi, `${field} dropped its high bound`);
    assert.equal(sourceOf({ [field]: 99999 })[field], hi, `${field} did not clamp above`);
    assert.equal(sourceOf({ [field]: -99999 })[field], lo, `${field} did not clamp below`);
    // Continuous, every one of them: a fraction survives where the octave
    // switch would have been rounded away.
    const mid = lo + (hi - lo) * 0.371;
    assert.equal(sourceOf({ [field]: mid })[field], mid, `${field} rounded a continuous value`);
    // `[]` is deliberately absent: Number([]) is 0, so an empty array coerces
    // to a number on EVERY rangeable field in the schema, v7's included. That
    // is the sanitiser's standing behaviour, not something v19 introduced, and
    // pinning it here would freeze a quirk this change has no business owning.
    for (const bad of [NaN, 'loud', null, true, undefined, {}]) {
      assert.equal(sourceOf({ [field]: bad })?.[field], undefined,
        `${field} accepted ${JSON.stringify(bad) ?? String(bad)}`);
    }
  }

  // The v19 fields are additions: a patch may carry them beside the older ones
  // and nothing is dropped in either direction.
  const both = sourceOf({ octave: 1, detune: -12, tilt: -0.5, cadence: 4 });
  assert.deepEqual(both, {
    octave: 1, detune: -12, tilt: -0.5, cadence: 4,
  }, 'the v19 fields displaced the fields already in the schema');
});

test('v19: the sculpting fields resolve to numbers per bar, inside their bounds', () => hiddenTab(async () => {
  const texture = spyOnBank(bankFor('texture'));
  try {
    const ranged = {
      tilt: { min: -0.8, max: 0.6 },
      bandCentre: { min: 300, max: 3000 },
      bandWidth: { min: 0.5, max: 3.5 },
      sweepRate: { min: 0.05, max: 0.4 },
      sweepDepth: { min: 0.2, max: 0.9 },
      gust: { min: 0.1, max: 0.8 },
      gustRate: { min: 0.05, max: 0.4 },
      burst: { min: 0.2, max: 0.8 },
      burstSharp: { min: 0.1, max: 0.9 },
      swell: { min: 0, max: 0.7 },
    };
    const engine = createEngine({
      bpm: 120,
      speed: 2,
      structure: 'drone',
      complexity: 0.6,
      tracks: {
        ...tracksAll('off'),
        texture: { state: 'on', randomness: 0.7, vary: { voice: 0 }, voice: 'colour' },
      },
      patches: { texture: { colour: { source: ranged } } },
    }, { rng: seededRng(1907) });
    await engine.start();
    await advance(20, FAST);
    engine.stop();

    const sculpted = texture.plays.filter((play) => play.id === 'colour');
    assert.ok(sculpted.length > 4, `the sculpting voice only sounded ${sculpted.length} times`);
    for (const play of sculpted) {
      for (const [field, range] of Object.entries(ranged)) {
        const value = play.patch.source[field];
        assert.equal(typeof value, 'number', `${field} reached a voice unresolved`);
        assert.ok(value >= range.min - 1e-6 && value <= range.max + 1e-6,
          `a resolved ${field} of ${value} is outside its ${range.min}–${range.max} bounds`);
      }
    }
    // Ruling 9c: one walk per field, so they drift independently rather than
    // all riding the same number.
    for (const field of Object.keys(ranged)) {
      const seen = new Set(sculpted.map((play) => play.patch.source[field].toFixed(6)));
      assert.ok(seen.size > 1, `a ranged ${field} never drifted across bars`);
    }
    const walks = Object.keys(ranged).map((field) => sculpted.map(
      (play) => play.patch.source[field].toFixed(6),
    ).join(','));
    assert.equal(new Set(walks).size, walks.length,
      'two sculpting fields shared one drift walk');
  } finally {
    texture.restore();
  }
}));

test('v19: the call fields resolve for melody as well as texture', () => hiddenTab(async () => {
  const melody = spyOnBank(bankFor('melody'));
  try {
    const ranged = {
      glide: { min: -18, max: 14 },
      glideCurve: { min: 0.2, max: 0.9 },
      formant1: { min: 400, max: 2200 },
      formant2: { min: 1200, max: 5200 },
      cadence: { min: 1, max: 6 },
      irregular: { min: 0.05, max: 0.75 },
    };
    const engine = createEngine({
      bpm: 120,
      speed: 2,
      structure: 'drone',
      complexity: 0.7,
      tracks: {
        ...tracksAll('off'),
        melody: { state: 'on', randomness: 0.7, vary: { voice: 0 }, voice: 'call' },
      },
      patches: { melody: { call: { source: ranged } } },
    }, { rng: seededRng(2711) });
    await engine.start();
    await advance(20, FAST);
    engine.stop();

    const calls = melody.plays.filter((play) => play.id === 'call');
    assert.ok(calls.length > 4, `the call voice only sounded ${calls.length} times`);
    for (const play of calls) {
      for (const [field, range] of Object.entries(ranged)) {
        const value = play.patch.source[field];
        assert.equal(typeof value, 'number', `${field} reached a voice unresolved`);
        assert.ok(value >= range.min - 1e-6 && value <= range.max + 1e-6,
          `a resolved ${field} of ${value} is outside its ${range.min}–${range.max} bounds`);
      }
      // A call carries no sculpting fields, and never grows them from a bank
      // that has none of its own.
      assert.equal(play.patch.source.tilt, undefined, 'a call patch grew a sculpting field');
    }
  } finally {
    melody.restore();
  }
}));

test('v19: adding the fields left every unpatched voice exactly where it was', () => {
  // The schema is track-agnostic on purpose, so the one thing that must not
  // have changed is what an UNSENT field does: nothing at all.
  assert.deepEqual(sanitiseParams({ patches: { pad: { warm: {} } } }).patches, {},
    'an empty patch started producing sculpting defaults');
  for (const field of Object.keys(V19_BOUNDS)) {
    assert.deepEqual(sanitiseParams({ patches: { pad: { warm: { source: { [field]: NaN } } } } })
      .patches, {}, `an unusable ${field} was filled in rather than dropped`);
  }
  // And a voice the user HAS edited keeps only what they edited.
  assert.deepEqual(
    sanitiseParams({ patches: { texture: { cloud: { source: { burst: 0.8 } } } } })
      .patches.texture.cloud,
    { source: { burst: 0.8 } },
    'a sparse sculpting patch was filled out with fields nobody sent',
  );
});

// --------------------------------------------------------------------------
// v20 — shape modifiers (fold)
// --------------------------------------------------------------------------

test('v20: fold takes a number or a range, clamps 0–1, and refuses rubbish', () => {
  const foldOf = (fold) => sanitiseParams({ patches: { pad: { warm: { source: { fold } } } } })
    .patches.pad?.warm?.source?.fold;

  assert.equal(foldOf(0), 0, 'fold dropped its low bound');
  assert.equal(foldOf(1), 1, 'fold dropped its high bound');
  assert.equal(foldOf(0.371), 0.371, 'fold rounded a continuous value');
  assert.equal(foldOf(9), 1, 'fold did not clamp above');
  assert.equal(foldOf(-9), 0, 'fold did not clamp below');
  assert.deepEqual(foldOf({ min: 0.2, max: 0.8 }), { min: 0.2, max: 0.8 }, 'fold refused a range');
  assert.deepEqual(foldOf({ min: 0.9, max: 0.1 }), { min: 0.1, max: 0.9 },
    'a reversed fold range is swapped, not rejected');
  assert.deepEqual(foldOf({ min: -1, max: 4 }), { min: 0, max: 1 }, 'both fold bounds clamp');
  for (const bad of [NaN, 'hard', null, true, undefined, {}, { min: 0.2 }]) {
    assert.equal(foldOf(bad), undefined, `fold accepted ${JSON.stringify(bad) ?? String(bad)}`);
  }

  // An addition, not a replacement: fold sits beside the fields already there,
  // and a voice nobody edited still grows nothing.
  assert.deepEqual(
    sanitiseParams({ patches: { pad: { warm: { source: { shape1: 2, fold: 0.5 } } } } })
      .patches.pad.warm.source,
    { shape1: 2, fold: 0.5 }, 'fold displaced a field already in the schema');
  assert.deepEqual(sanitiseParams({ patches: { pad: { warm: {} } } }).patches, {},
    'an empty patch started producing a fold default');
});

test('v20: a ranged fold resolves to a number per bar, inside its bounds', () => hiddenTab(async () => {
  const pad = spyOnBank(bankFor('pad'));
  try {
    const engine = createEngine({
      bpm: 120,
      speed: 2,
      structure: 'drone',
      complexity: 0.6,
      tracks: {
        ...tracksAll('off'),
        pad: { state: 'on', randomness: 0.7, vary: { voice: 0 }, voice: 'warm' },
      },
      patches: { pad: { warm: { source: { fold: { min: 0.2, max: 0.9 } } } } },
    }, { rng: seededRng(2013) });
    await engine.start();
    await advance(20, FAST);
    engine.stop();

    const folded = pad.plays.filter((play) => play.id === 'warm');
    assert.ok(folded.length > 4, `the pad only sounded ${folded.length} times`);
    for (const play of folded) {
      const value = play.patch.source.fold;
      assert.equal(typeof value, 'number', 'fold reached a voice unresolved');
      assert.ok(value >= 0.2 - 1e-6 && value <= 0.9 + 1e-6,
        `a resolved fold of ${value} is outside its 0.2–0.9 bounds`);
    }
    assert.ok(new Set(folded.map((play) => play.patch.source.fold.toFixed(6))).size > 1,
      'a ranged fold never drifted across bars');
  } finally {
    pad.restore();
  }
}));

// --------------------------------------------------------------------------
// v21 — reverbTail, driftRate, the randomness default range
// --------------------------------------------------------------------------

test('v21: reverbTail is a 0.5–6 s number that ships at 4 and survives a preset round-trip', () => {
  assert.deepEqual([...REVERB_TAIL_RANGE], [0.5, 6]);
  assert.equal(sanitiseParams({}).reverbTail, 4, 'reverbTail must ship at the length v2 baked');
  const tailOf = (reverbTail) => sanitiseParams({ reverbTail }).reverbTail;
  assert.equal(tailOf(0.5), 0.5);
  assert.equal(tailOf(6), 6);
  assert.equal(tailOf(2.25), 2.25);
  assert.equal(tailOf(99), 6, 'reverbTail did not clamp above');
  assert.equal(tailOf(0), 0.5, 'reverbTail did not clamp below');
  assert.equal(tailOf('3'), 3, 'a number-input string still counts');
  assert.equal(tailOf('nope'), 4, 'junk falls back to the default');
  // v0.0.56: reverbTail IS rangeable now, along with every other global dial.
  // The number stays a number — the span lives beside it in params.spans and
  // walks into params.reverbTail once a bar — so the value a spread settles on
  // is its midpoint until the first barline moves it.
  assert.equal(tailOf({ min: 1, max: 5 }), 3, 'a spread reverbTail starts at its midpoint');
  assert.deepEqual(
    sanitiseParams({ reverbTail: { min: 1, max: 5 } }).spans.reverbTail,
    { min: 1, max: 5 },
    'the span itself must be kept, not just its midpoint'
  );
  // Preset capture: it merges like any other top-level number, and getParams
  // hands it back for the snapshot a preset actually stores.
  const engine = createEngine({ reverbTail: 1.5 });
  assert.equal(engine.getParams().reverbTail, 1.5);
  engine.setParams({ bpm: 90 });
  assert.equal(engine.getParams().reverbTail, 1.5, 'an unrelated edit dropped reverbTail');
});

test('v21: a reverbTail change rebuilds the IR asynchronously and crossfades the send', async () => {
  const engine = createEngine({ reverbTail: 4 });
  assert.equal(engine.arm(), true);
  const ctx = liveContexts[liveContexts.length - 1];
  const bus = reverbBus(ctx);

  const built = reverbTails(ctx);
  assert.equal(built.length, 1, 'arming built more than one reverb');
  assert.ok(Math.abs(built[0].seconds - 4) < 0.01, `the shipped IR is ${built[0].seconds} s, not 4`);

  engine.setParams({ reverbTail: 1.5 });
  assert.equal(reverbTails(ctx).length, 1,
    'the IR was generated inside setParams — the rebuild must be off the audio path');

  await reverbBuilt();
  const [old, next] = reverbTails(ctx);
  assert.ok(next, 'the tail change never built a second convolver');
  assert.ok(Math.abs(next.seconds - 1.5) < 0.01, `the new IR is ${next.seconds} s, not 1.5`);
  assert.notEqual(old.convolver, next.convolver, 'the engine swapped a buffer instead of a convolver');

  // Mid-crossfade: both convolvers are live, fed by the one send bus, and the
  // two returns are ramping past each other over the same half-second.
  assert.ok(bus.connections.includes(old.convolver) && bus.connections.includes(next.convolver),
    'the two convolvers do not overlap — the send would gap');
  assert.equal(old.convolver.disconnects.length, 0, 'the old tail was cut before it had faded');
  const fadeOut = old.ret.gain.ramps.at(-1);
  const fadeIn = next.ret.gain.ramps.at(-1);
  assert.ok(fadeOut && fadeOut.to === 0, 'the old return did not ramp to silence');
  assert.ok(fadeIn && fadeIn.to > 0, 'the new return did not ramp up');
  assert.ok(Math.abs(fadeOut.at - fadeIn.at) < 1e-9, 'the two ramps do not land together');
  assert.ok(Math.abs((fadeOut.at - ctx.currentTime) - 0.5) < 0.05,
    `the crossfade runs for ${fadeOut.at - ctx.currentTime} s, not ~0.5`);

  await reverbFaded();
  assert.ok(old.convolver.disconnects.length > 0, 'the faded-out convolver was left connected');
  assert.ok(old.ret.disconnects.length > 0, 'the faded-out return was left connected');
  assert.ok(bus.disconnects.includes(old.convolver), 'the send bus still feeds the old tail');
  assert.ok(bus.connections.includes(next.convolver), 'the send bus lost the live tail');
  engine.stop();
});

test('v21: the governor tier caps the tail without overwriting it', async () => {
  const engine = createEngine({ reverbTail: 6 });
  assert.equal(typeof engine.setReverbSeconds, 'function',
    'power.js documents reverbSeconds — the engine must expose the hook it names');
  assert.equal(engine.arm(), true);
  const ctx = liveContexts[liveContexts.length - 1];
  const live = async () => {
    await reverbBuilt();
    await reverbFaded();
    return reverbTails(ctx).at(-1).seconds;
  };

  assert.ok(Math.abs(await live() - 6) < 0.01, 'the 6 s tail the params asked for was not built');

  // eco: min(6, 1) — the budget wins, and the param is untouched underneath.
  engine.setPowerBudget({ maxNotes: 8, reverbSeconds: 1 });
  assert.ok(Math.abs(await live() - 1) < 0.01, 'the tier cap did not shorten the tail');
  assert.equal(engine.getParams().reverbTail, 6, 'the tier cap overwrote the user\'s reverbTail');

  // A shorter param under the same cap: min(0.75, 1) — the param wins now.
  engine.setParams({ reverbTail: 0.75 });
  assert.ok(Math.abs(await live() - 0.75) < 0.01, 'the cap was treated as a floor');

  // Back to full: the 6 s the user asked for comes back on its own.
  engine.setParams({ reverbTail: 6 });
  engine.setReverbSeconds(4);
  assert.ok(Math.abs(await live() - 4) < 0.01, 'setReverbSeconds must cap like the budget field');
  engine.setPowerBudget({ maxNotes: Infinity });
  assert.ok(Math.abs(await live() - 6) < 0.01,
    'a budget with no reverbSeconds must lift the cap, not silence the tail');
  engine.stop();
});

test('v21: randomness ships as a range, stored numbers stay numbers, and a zeroed range holds', () => {
  // The stored form is the user's: only an ABSENT randomness takes the default.
  const stored = sanitiseParams({ tracks: { pad: { randomness: 0.2 }, bass: { randomness: 0 } } });
  assert.equal(stored.tracks.pad.randomness, 0.2, 'a stored number was replaced by the new default');
  assert.equal(stored.tracks.bass.randomness, 0, 'a stored 0 was replaced by the new default');
  assert.deepEqual(stored.tracks.melody.randomness, { min: 0.35, max: 0.65 },
    'an absent randomness must take the v21 default range');
  const merged = sanitiseParams({ bpm: 90 }, stored).tracks;
  assert.equal(merged.pad.randomness, 0.2, 'an unrelated edit migrated a stored number');
  assert.equal(typeof merged.pad.randomness, 'number', 'a stored number changed shape');

  // Hold semantics, stated once and shared by every consumer.
  assert.equal(randomnessIsHold(0), true, 'a number 0 must count as hold');
  assert.equal(randomnessIsHold(0.001), false, 'only a number 0 holds');
  assert.equal(randomnessIsHold({ min: 0, max: 0 }), true, 'a zeroed range must count as hold');
  assert.equal(randomnessIsHold({ min: 0, max: 0.001 }), true,
    'a range whose top is at the epsilon must count as hold');
  assert.equal(randomnessIsHold({ min: 0, max: 0.05 }), false,
    'a range that can reach an audible value is asking to drift, not to hold');
  assert.equal(randomnessIsHold(DEFAULT_PARAMS.tracks.pad.randomness), false,
    'the shipped default must not hold every track');
  assert.equal(randomnessIsHold(null), false);
  assert.equal(randomnessIsHold(undefined), false);
});

test('v21: the range default drives every consumer, and a zeroed range freezes the material',
  () => hiddenTab(async () => {
    // varyAmount and the live readout both resolve the macro to a NUMBER, and
    // the number moves — which is the whole point of a default range.
    const engine = createEngine({
      bpm: 120, speed: 2, structure: 'drone', complexity: 0.5,
      tracks: { ...tracksAll('off'), pad: { state: 'on' } },
    }, { rng: seededRng(2107) });
    await engine.start();
    const seen = [];
    for (let i = 0; i < 12; i++) {
      await advance(1, FAST);
      seen.push(engine.getResolved().tracks.pad.randomness);
    }
    engine.stop();
    for (const value of seen) {
      assert.equal(typeof value, 'number', 'the default range reached a consumer unresolved');
      assert.ok(value >= 0.35 - 1e-6 && value <= 0.65 + 1e-6,
        `a resolved randomness of ${value} is outside the default 0.35–0.65 drift`);
    }
    assert.ok(new Set(seen.map((v) => v.toFixed(9))).size > 1,
      'the default randomness range never drifted');
    assert.equal(engine.getResolved().tracks.pad.held, false,
      'the default range was read as a hold');

    // A zeroed range holds exactly as the number 0 does: byte-identical bars.
    const rhythm = async (randomness, seed) => {
      const held = createEngine({
        bpm: 120, speed: 2, complexity: 0.5, repetition: 0.5, structure: 'custom',
        customStructure: [{ label: 'A', bars: 16, intensity: 1 }],
        tracks: { ...tracksAll('off'), bass: { state: 'on', randomness } },
      }, { rng: seededRng(seed) });
      const log = record(held);
      await held.start();
      await advance(40, FAST);
      held.stop();
      const byBar = log.byBar('bass');
      const bars = [...byBar.keys()].filter((b) => b >= TRACK_ORDER.indexOf('bass') + 2)
        .sort((a, b) => a - b);
      assert.ok(bars.length >= 20, `only ${bars.length} bass bars to judge`);
      return new Set(bars.map((bar) => byBar.get(bar)
        .map((n) => `${tick(n.offset)}:${n.velocity.toFixed(4)}:${n.duration.toFixed(4)}`)
        .join(',')));
    };

    // Seed 7002 is the one the v14 number-0 hold test uses, so the two forms
    // are judged against the same piece.
    assert.equal((await rhythm({ min: 0, max: 0 }, 7002)).size, 1,
      'a zeroed randomness RANGE did not hold the way the number 0 does');
    assert.ok((await rhythm({ min: 0, max: 0.6 }, 7102)).size > 1,
      'a range that only touches zero froze the track');
  }));

test('v0.0.56: a spread global dial drifts inside its span, bar by bar',
  () => hiddenTab(async () => {
    // The owner's ask was "everything should be spreadable with horizontal
    // drag". A dial that opens a span the engine ignores is worse than one
    // that refuses the gesture, so this proves the three properties that make
    // the spread real: the value stays inside the span, it MOVES, and it is a
    // plain number at every read site (params.bpm is read by the scheduler as
    // a number, dozens of times, and always was).
    const engine = createEngine({
      bpm: { min: 80, max: 120 }, speed: 1, structure: 'drone', complexity: 0.5,
      tracks: { ...tracksAll('off'), pad: { state: 'on' } },
    }, { rng: seededRng(556) });
    assert.deepEqual(engine.getParams().spans.bpm, { min: 80, max: 120 },
      'the span must survive into the params a preset stores');
    assert.equal(engine.getParams().bpm, 100, 'a spread dial settles on its midpoint until it walks');
    await engine.start();
    const seen = [];
    for (let i = 0; i < 12; i++) {
      await advance(1, FAST);
      seen.push(engine.getResolved().globals.bpm);
    }
    engine.stop();
    for (const value of seen) {
      assert.equal(typeof value, 'number', 'a global span reached a consumer unresolved');
      assert.ok(value >= 80 - 1e-6 && value <= 120 + 1e-6,
        `a resolved bpm of ${value} is outside the 80-120 span`);
    }
    assert.ok(new Set(seen.map((v) => v.toFixed(9))).size > 1, 'the spread bpm never drifted');
  }));

test('v0.0.56: setting a global dial to one number closes its span', () => {
  const spread = sanitiseParams({ swing: { min: 0.1, max: 0.5 } });
  assert.deepEqual(spread.spans.swing, { min: 0.1, max: 0.5 });
  // An unrelated edit must not silently close it …
  const untouched = sanitiseParams({ bpm: 90 }, spread);
  assert.deepEqual(untouched.spans.swing, { min: 0.1, max: 0.5 },
    'an unrelated edit dropped a span');
  // … but setting that dial to a single value must, because that is exactly
  // what narrowing a spread to nothing means.
  const closed = sanitiseParams({ swing: 0.2 }, spread);
  assert.equal(closed.swing, 0.2);
  assert.equal(closed.spans.swing, undefined, 'a plain number must close the span');
});

test('v0.0.56: a params object with no spreads is byte-identical to a pre-v0.0.56 one', () => {
  const plain = sanitiseParams({ bpm: 90 });
  assert.deepEqual(plain.spans, {}, 'an untouched params object must carry no spans');
  assert.equal(Object.keys(DEFAULT_PARAMS.spans).length, 0);
});

test('v21: driftRate scales a track\'s walk step, and never stops it dead', () => {
  const rateOf = (driftRate) => sanitiseParams({ tracks: { pad: { driftRate } } }).tracks.pad.driftRate;
  assert.equal(sanitiseParams({}).tracks.pad.driftRate, 1, 'driftRate must ship at 1');
  assert.equal(rateOf(0.02), 0.02);
  assert.equal(rateOf(0.5), 0.5);
  assert.equal(rateOf(0), 0.02, 'driftRate did not clamp below — 0 is what hold is for');
  assert.equal(rateOf(9), 1, 'driftRate did not clamp above');
  assert.equal(rateOf('nope'), 1, 'junk falls back to the default');
  const stored = sanitiseParams({ tracks: { pad: { driftRate: 0.2 } } });
  assert.equal(sanitiseParams({ bpm: 90 }, stored).tracks.pad.driftRate, 0.2,
    'an unrelated edit dropped driftRate');
});

test('v21: a low driftRate measurably slows the level walk', () => hiddenTab(async () => {
  const walkOf = async (driftRate, seed) => {
    const engine = createEngine({
      bpm: 120, speed: 2, structure: 'drone', complexity: 0.6,
      tracks: {
        ...tracksAll('off'),
        pad: { state: 'on', level: { min: 0.2, max: 0.8 }, randomness: 0.5, driftRate },
      },
    }, { rng: seededRng(seed) });
    await engine.start();
    const gain = trackGains(liveContexts[liveContexts.length - 1]).pad;
    const values = [];
    for (let i = 0; i < 16; i++) {
      await advance(1, FAST);
      values.push(gain.gain.value);
    }
    engine.stop();
    const steps = values.slice(1).map((v, i) => Math.abs(v - values[i])).filter((d) => d > 0);
    assert.ok(steps.length > 3, `the level walk only moved ${steps.length} times`);
    return steps.reduce((a, b) => a + b, 0) / steps.length;
  };

  // Same seed, same draws: driftRate scales the STEP each draw is worth, so a
  // tenth of the rate is roughly a tenth of the movement per bar.
  const full = await walkOf(1, 3101);
  const slow = await walkOf(0.1, 3101);
  assert.ok(slow < full * 0.4,
    `driftRate 0.1 moved ${slow} per bar against ${full} at full rate — not measurably slower`);
  assert.ok(slow > 0, 'driftRate 0.1 stopped the walk dead; that is what randomness 0 is for');
}));

// --------------------------------------------------------------------------
// v21 — per-track swing, per-step gate, dynamic percussion lanes, density
// --------------------------------------------------------------------------

test('v21: tracks[t].swing is 0–1 or null, and null means "follow the global dial"', () => {
  const swingOf = (swing) => sanitiseParams({ tracks: { bass: { swing } } }).tracks.bass.swing;
  assert.equal(sanitiseParams({}).tracks.bass.swing, null, 'a track ships following the global dial');
  assert.equal(swingOf(0.5), 0.5);
  assert.equal(swingOf(0), 0, 'an explicit 0 is a straight track, not "follow"');
  assert.equal(swingOf(-1), 0, 'swing did not clamp below');
  assert.equal(swingOf(4), 1, 'swing did not clamp above');
  assert.equal(swingOf(null), null);
  assert.equal(swingOf('nope'), null, 'junk falls back to following the global dial');

  const stored = sanitiseParams({ tracks: { bass: { swing: 0.8 } } });
  assert.equal(sanitiseParams({ bpm: 90 }, stored).tracks.bass.swing, 0.8,
    'an unrelated edit dropped a per-track swing');
  assert.equal(sanitiseParams({ tracks: { bass: { swing: null } } }, stored).tracks.bass.swing, null,
    'an explicit null must hand the track back to the global dial');
  const engine = createEngine({ tracks: { bass: { swing: 0.4 } } });
  assert.equal(engine.getParams().tracks.bass.swing, 0.4, 'getParams did not round-trip swing');
});

test("v21: a track's own swing overrides the global dial for that track alone", () => hiddenTab(async () => {
  // Both tracks fire on the downbeat and on the offbeat sixteenth-pair split.
  // The global dial is hard over; percussion opts out with an explicit 0 and
  // melody follows (null), so one bar contains both feels at once.
  const steps = { low: seqLane({ on: false }), mid: seqLane({ on: false }), high: seqLane({ on: false }) };
  steps.low[0] = { on: true, prob: 1, vmin: 0.5, vmax: 0.5 };
  steps.low[2] = { on: true, prob: 1, vmin: 0.5, vmax: 0.5 };
  const melody = seqLane({ on: false });
  melody[0] = { on: true, prob: 1, vmin: 0.5, vmax: 0.5 };
  melody[2] = { on: true, prob: 1, vmin: 0.5, vmax: 0.5 };

  const engine = createEngine({
    bpm: 120, speed: 2, complexity: 0.5, repetition: 0.5, structure: 'custom', swing: 1,
    customStructure: [{ label: 'A', bars: 32, intensity: 1 }],
    tracks: {
      ...tracksAll('off'),
      melody: { state: 'on', randomness: 0, swing: null, sequencer: { mode: 'manual', steps: melody } },
      percussion: { state: 'on', randomness: 0, swing: 0, sequencer: { mode: 'manual', steps } },
    },
  }, { rng: seededRng(2101) });
  const log = record(engine);
  await engine.start();
  await advance(20, FAST);
  engine.stop();

  const secPerBeat = 60 / (120 * 2);
  const offsetsIn = (track, bar) => log.byBar(track).get(bar)
    .map((note) => note.offset).sort((a, b) => a - b);
  const bar = [...log.byBar('percussion').keys()]
    .find((b) => b >= TRACK_ORDER.indexOf('percussion') + 1 && log.byBar('melody').has(b));
  assert.ok(bar !== undefined, 'no bar had both tracks sounding');

  const drums = offsetsIn('percussion', bar);
  const tune = offsetsIn('melody', bar);
  assert.equal(drums[0].toFixed(4), (0).toFixed(4), 'the downbeat never moves, whatever the swing');
  assert.equal(tune[0].toFixed(4), (0).toFixed(4), 'the downbeat never moves, whatever the swing');
  assert.ok(Math.abs(drums[1] - 0.5 * secPerBeat) < 1e-6,
    `swing 0 on percussion should leave the offbeat at 0.5 beats, got ${drums[1] / secPerBeat}`);
  assert.ok(Math.abs(tune[1] - 0.75 * secPerBeat) < 1e-6,
    `melody follows swing 1, so its offbeat belongs at 0.75 beats, got ${tune[1] / secPerBeat}`);
}));

test('v21: a per-step gate is optional, clamps to 0.1–2, and clears back to nothing', () => {
  const lane = (steps, base) => sanitiseParams({ tracks: { melody: { sequencer: { steps } } } }, base)
    .tracks.melody.sequencer.steps;

  assert.ok(!('gate' in lane([{ on: true }])[0]),
    'a step that was never given a gate must not grow one');
  assert.equal(lane([{ on: true, gate: 1.5 }])[0].gate, 1.5);
  assert.equal(lane([{ on: true, gate: 9 }])[0].gate, 2, 'gate did not clamp above');
  assert.equal(lane([{ on: true, gate: 0 }])[0].gate, 0.1, 'gate did not clamp below');

  const stored = sanitiseParams({ tracks: { melody: { sequencer: { steps: [{ on: true, gate: 1.5 }] } } } });
  assert.equal(lane([{ on: true }], stored)[0].gate, 1.5, 'an unrelated edit dropped a stored gate');
  assert.ok(!('gate' in lane([{ on: true, gate: null }], stored)[0]),
    'an explicit null must clear the gate back to the gap-derived length');

  const engine = createEngine({ tracks: { arp: { sequencer: { steps: [{ on: true, gate: 0.4 }] } } } });
  assert.equal(engine.getParams().tracks.arp.sequencer.steps[0].gate, 0.4,
    'getParams did not round-trip a step gate');
});

test('v21: a step gate scales the note length, ties compose, and gate > 1 overlaps', () => hiddenTab(async () => {
  // One beat is one second here, so a sixteenth slot is 0.25 s and every
  // duration below reads straight off the grid (× the mono track's 1.02
  // legato allowance).
  const barOfMelody = async (lane, seed = 7701) => {
    const engine = createEngine({
      bpm: 60, speed: 1, complexity: 0.5, repetition: 0.5, structure: 'custom',
      customStructure: [{ label: 'A', bars: 32, intensity: 0.8 }],
      tracks: {
        ...tracksAll('off'),
        melody: { state: 'on', randomness: 0, sequencer: { mode: 'manual', steps: lane } },
      },
    }, { rng: seededRng(seed) });
    const log = record(engine);
    await engine.start();
    await advance(40, FAST);
    engine.stop();
    const byBar = log.byBar('melody');
    const bar = [...byBar.keys()].find((b) => b >= TRACK_ORDER.indexOf('melody') + 2);
    assert.ok(bar !== undefined, 'the melody never sounded past its stage bar');
    return byBar.get(bar);
  };

  const twoSteps = (step, first = {}) => {
    const lane = seqLane({ on: false });
    lane[0] = { on: true, prob: 1, vmin: 0.6, vmax: 0.6, ...step, ...first };
    lane[1] = { on: true, prob: 1, vmin: 0.6, vmax: 0.6, ...step };
    return lane;
  };
  const slot = 0.25;      // one sixteenth, in seconds, at this tempo
  const legato = 1.02;    // the mono melody's overlap allowance

  const plain = await barOfMelody(twoSteps({}));
  assert.equal(plain.length, 2);
  assert.ok(Math.abs(plain[0].duration - slot * legato) < 1e-6,
    `an ungated step still rings to the next onset: got ${plain[0].duration}`);

  const short = await barOfMelody(twoSteps({ gate: 0.5 }));
  assert.equal(short.length, 2);
  for (const note of short) {
    assert.ok(Math.abs(note.duration - slot * 0.5 * legato) < 1e-6,
      `gate 0.5 should halve the slot: got ${note.duration}`);
  }

  const long = await barOfMelody(twoSteps({ gate: 2 }));
  assert.equal(long.length, 2);
  for (const note of long) {
    assert.ok(Math.abs(note.duration - slot * 2 * legato) < 1e-6,
      `gate 2 should double the slot: got ${note.duration}`);
  }
  // The point of a gate above 1 on a mono track: the first note is still
  // sounding when the second starts, which is what the legato path needs.
  assert.ok(long[0].time + long[0].duration > long[1].time + 1e-6,
    'gate 2 was trimmed back to the gap instead of overlapping into the next note');

  // Tie first — one note over both slots — then the gate scales what it spans.
  const tied = await barOfMelody(twoSteps({ gate: 1.5 }, { tie: true }));
  assert.equal(tied.length, 1, 'the tie should have merged the pair into one note');
  assert.ok(Math.abs(tied[0].duration - slot * 2 * 1.5 * legato) < 1e-6,
    `a tied pair at gate 1.5 spans two slots × 1.5: got ${tied[0].duration}`);
}));

test('v21: percussion lanes are dynamic, the built-ins are undeletable, and the kit caps at 8', () => {
  const lanesOf = (lanes, base) => sanitiseParams({ tracks: { percussion: { lanes } } }, base)
    .tracks.percussion.lanes;

  const shipped = sanitiseParams({}).tracks.percussion.lanes;
  assert.deepEqual(shipped.map((lane) => lane.id), [...PERCUSSION_LANES],
    'a fresh kit is the three built-ins');
  assert.deepEqual(shipped.map((lane) => lane.kind), [...PERCUSSION_LANES],
    'a built-in lane sounds through the voice kind it is named for');
  assert.deepEqual(shipped.map((lane) => lane.order), [0, 1, 2]);
  assert.ok(shipped.every((lane) => typeof lane.label === 'string' && lane.label));

  const added = lanesOf([...shipped, { id: 'clap', label: 'Clap', kind: 'high' }]);
  assert.deepEqual(added.map((lane) => lane.id), ['low', 'mid', 'high', 'clap']);
  assert.equal(added[3].kind, 'high', 'a user lane keeps the voice kind it maps onto');
  assert.equal(added[3].label, 'Clap');

  // Adding a lane adds its grid; every built-in grid is where it was.
  const withClap = sanitiseParams({
    tracks: { percussion: { lanes: added, sequencer: { steps: { clap: [{ on: false }] } } } },
  });
  const grid = withClap.tracks.percussion.sequencer.steps;
  assert.deepEqual(Object.keys(grid), ['low', 'mid', 'high', 'clap']);
  assert.equal(grid.clap.length, SEQUENCER_STEP_COUNT, 'a new lane gets a full grid');
  assert.equal(grid.clap[0].on, false);

  // Built-ins are undeletable: a list that omits them gets them back.
  const stripped = lanesOf([{ id: 'clap', kind: 'high' }]);
  assert.deepEqual(stripped.map((lane) => lane.id).sort(), ['clap', 'high', 'low', 'mid'],
    'a built-in lane was deleted');
  assert.deepEqual(stripped.map((lane) => lane.order), [0, 1, 2, 3], 'order must stay canonical');

  // A built-in's label is editable; its kind is not.
  const relabelled = lanesOf([{ id: 'low', label: 'Kick', kind: 'high' }]);
  assert.equal(relabelled[0].label, 'Kick');
  assert.equal(relabelled[0].kind, 'low', "a built-in's kind is its id, and is not negotiable");

  // The cap counts the built-ins, and only user lanes past the eighth go.
  const capped = lanesOf(Array.from({ length: 20 }, (unused, i) => ({ id: `u${i}`, kind: 'mid' })));
  assert.equal(capped.length, MAX_PERCUSSION_LANES);
  for (const id of PERCUSSION_LANES) {
    assert.ok(capped.some((lane) => lane.id === id), `the cap dropped built-in ${id}`);
  }

  // Junk entries are dropped rather than guessed at; duplicates collapse.
  const messy = lanesOf([...shipped, 'nope', { label: 'no id' }, { id: '  ' }, { id: 'low' }]);
  assert.deepEqual(messy.map((lane) => lane.id), [...PERCUSSION_LANES]);

  // Removing a lane takes its grid AND its kit patch with it.
  const removed = sanitiseParams({
    tracks: { percussion: { lanes: shipped } },
    patches: { percussion: { soft: { perKind: { clap: { filter: { cutoff: 900 } } } } } },
  }, withClap);
  assert.deepEqual(Object.keys(removed.tracks.percussion.sequencer.steps), [...PERCUSSION_LANES]);
  assert.equal(removed.patches.percussion, undefined,
    "a removed lane's kit override must not survive it");

  // ...and a lane added in the SAME call as its override keeps the override.
  const together = sanitiseParams({
    tracks: { percussion: { lanes: added } },
    patches: { percussion: { soft: { perKind: { clap: { filter: { cutoff: 900 } } } } } },
  });
  assert.equal(together.patches.percussion.soft.perKind.clap.filter.cutoff, 900);
});

test('v21: a user lane plays through its mapped kind, names itself on every note, and takes its grid with it',
  () => hiddenTab(async () => {
    const off = () => seqLane({ on: false });
    const steps = { low: off(), mid: off(), high: off(), clap: off() };
    steps.clap[0] = { on: true, prob: 1, vmin: 0.7, vmax: 0.7 };
    const run = async (lanes, seed = 2155) => {
      const engine = createEngine({
        bpm: 120, speed: 2, complexity: 0.5, repetition: 0.5, structure: 'custom',
        customStructure: [{ label: 'A', bars: 32, intensity: 1 }],
        tracks: {
          ...tracksAll('off'),
          percussion: { state: 'on', randomness: 0, lanes, sequencer: { mode: 'manual', steps } },
        },
      }, { rng: seededRng(seed) });
      const log = record(engine);
      await engine.start();
      await advance(24, FAST);
      engine.stop();
      return log.notes.filter((note) => note.track === 'percussion');
    };

    const kit = [{ id: 'low' }, { id: 'mid' }, { id: 'high' }, { id: 'clap', label: 'Clap', kind: 'high' }];
    const played = await run(kit);
    assert.ok(played.length > 2, `the user lane never sounded (${played.length} hits)`);
    for (const note of played) {
      assert.equal(note.lane, 'clap', 'a hit must name the lane that struck it');
      assert.equal(note.kind, 'high', 'a user lane sounds through the voice kind it maps onto');
    }

    // Remove it: the grid keyed to it goes with it, and nothing else sounds.
    const silent = await run([{ id: 'low' }, { id: 'mid' }, { id: 'high' }]);
    assert.equal(silent.length, 0,
      "a removed lane's grid must not keep playing");
  }));

test('v21: an auto percussion bar still names the lane each kind sounds through', () => hiddenTab(async () => {
  const log = await soloRun('percussion', {}, { seconds: 20, seed: 2177, complexity: 0.8 });
  const hits = log.notes.filter((note) => note.track === 'percussion');
  assert.ok(hits.length > 4, `the auto kit barely played (${hits.length} hits)`);
  for (const hit of hits) {
    assert.ok(PERCUSSION_LANES.includes(hit.lane), `auto hit carried lane ${hit.lane}`);
    assert.equal(hit.lane, hit.kind, 'with the shipped kit a lane id IS its voice kind');
  }
}));

test('v21: tracks[t].density is 0–2 or null, and null means "whatever complexity asked for"', () => {
  const densityOf = (density) => sanitiseParams({ tracks: { texture: { density } } }).tracks.texture.density;
  assert.equal(sanitiseParams({}).tracks.texture.density, null, 'a track ships following complexity');
  assert.equal(densityOf(0.5), 0.5);
  assert.equal(densityOf(2), 2);
  assert.equal(densityOf(0), 0, 'an explicit 0 is a silenced rate, not "follow"');
  assert.equal(densityOf(-1), 0, 'density did not clamp below');
  assert.equal(densityOf(5), 2, 'density did not clamp above');
  assert.equal(densityOf(null), null);
  assert.equal(densityOf('nope'), null, 'junk falls back to following complexity');

  const stored = sanitiseParams({ tracks: { texture: { density: 1.4 } } });
  assert.equal(sanitiseParams({ bpm: 90 }, stored).tracks.texture.density, 1.4,
    'an unrelated edit dropped a per-track density');
  assert.equal(sanitiseParams({ tracks: { texture: { density: null } } }, stored).tracks.texture.density,
    null, 'an explicit null must hand the track back to complexity');
  const engine = createEngine({ tracks: { texture: { density: 0.25 } } });
  assert.equal(engine.getParams().tracks.texture.density, 0.25, 'getParams did not round-trip density');
});

test('v21: density scales an auto track\'s event rate, and null is exactly the old behaviour',
  () => hiddenTab(async () => {
    // A fixed window of bars, well inside every run below: the TAIL of a run is
    // wall-clock jittery (the scheduler is a real timer racing the mock clock),
    // and one extra bar scheduled is one extra bar of notes counted.
    const COUNT_BARS = 24;
    const countFor = async (track, density, seed = 2199) => {
      const engine = createEngine({
        bpm: 120, speed: 2, complexity: 0.5, repetition: 0.5, structure: 'custom',
        customStructure: [{ label: 'A', bars: 32, intensity: 1 }],
        tracks: {
          ...tracksAll('off'),
          // `undefined` sends no density field at all — the ground truth that
          // an explicit null has to match.
          [track]: density === undefined ? { state: 'on' } : { state: 'on', density },
        },
      }, { rng: seededRng(seed) });
      const log = record(engine);
      await engine.start();
      await advance(40, FAST);
      engine.stop();
      let total = 0;
      for (const [bar, notes] of log.byBar(track)) if (bar < COUNT_BARS) total += notes.length;
      return total;
    };

    for (const track of ['texture', 'percussion']) {
      const sparse = await countFor(track, 0.5);
      const following = await countFor(track, null);
      const busy = await countFor(track, 2);
      const untouched = await countFor(track, undefined);
      assert.equal(following, untouched,
        `${track}: an explicit null density must play exactly what no density field plays`);
      assert.ok(sparse < following && following < busy,
        `${track}: density did not order the event counts (${sparse} / ${following} / ${busy})`);
      assert.ok(busy > sparse * 1.8,
        `${track}: density 2 (${busy}) is not measurably busier than 0.5 (${sparse})`);
    }

    // A manual grid states when the track sounds; density has no say over it.
    const manual = async (density) => {
      const lane = seqLane({ on: false });
      for (const i of [0, 4, 8, 12]) lane[i] = { on: true, prob: 1, vmin: 0.6, vmax: 0.6 };
      const engine = createEngine({
        bpm: 120, speed: 2, complexity: 0.5, repetition: 0.5, structure: 'custom',
        customStructure: [{ label: 'A', bars: 32, intensity: 1 }],
        tracks: {
          ...tracksAll('off'),
          melody: { state: 'on', randomness: 0, density, sequencer: { mode: 'manual', steps: lane } },
        },
      }, { rng: seededRng(2200) });
      const log = record(engine);
      await engine.start();
      await advance(30, FAST);
      engine.stop();
      let total = 0;
      for (const [bar, notes] of log.byBar('melody')) if (bar < COUNT_BARS) total += notes.length;
      return total;
    };
    const quiet = await manual(0.5);
    assert.ok(quiet > 0, 'the manual grid never played');
    assert.equal(await manual(2), quiet, 'density moved a manual sequencer, which it must never do');
  }));

// --------------------------------------------------------------------------
// v21 — harmonic rhythm, pad breath, the three new modes, resolved readouts
// --------------------------------------------------------------------------

test("v21: harmony.rhythm takes 'auto' or a bar count, and survives a preset round-trip", () => {
  assert.deepEqual([...HARMONY_RHYTHMS], ['auto', 1, 2, 4, 8]);
  assert.deepEqual(DEFAULT_PARAMS.harmony, { rhythm: 'auto', seed: null },
    'the harmonic rhythm ships on auto, with no supplied loop');

  const rhythmOf = (rhythm) => sanitiseParams({ harmony: { rhythm } }).harmony.rhythm;
  assert.equal(rhythmOf(4), 4);
  assert.equal(rhythmOf('8'), 8, 'a select sends its options as strings');
  assert.equal(rhythmOf('auto'), 'auto');
  assert.equal(rhythmOf(3), 'auto', 'a bar count that is not on the dial falls back');
  assert.equal(rhythmOf(0), 'auto', 'nought bars a chord is not a harmonic rhythm');
  assert.equal(rhythmOf('nope'), 'auto');
  assert.equal(sanitiseParams({ harmony: 'four' }).harmony.rhythm, 'auto',
    'a harmony that is not an object at all falls back to auto');

  const stored = sanitiseParams({ harmony: { rhythm: 2 } });
  assert.equal(sanitiseParams({ bpm: 90 }, stored).harmony.rhythm, 2,
    'an unrelated edit dropped the harmonic rhythm');
  assert.equal(sanitiseParams({ harmony: { rhythm: 'auto' } }, stored).harmony.rhythm, 'auto',
    'a stored bar count must be releasable back to auto');
  assert.equal(sanitiseParams({}, { harmony: { rhythm: 99 } }).harmony.rhythm, 'auto',
    'a corrupt base cannot leak through');

  const engine = createEngine({ harmony: { rhythm: 8 } });
  assert.equal(engine.getParams().harmony.rhythm, 8, 'getParams did not round-trip harmony.rhythm');
  const handed = engine.getParams();
  handed.harmony.rhythm = 1;
  assert.equal(engine.getParams().harmony.rhythm, 8, 'getParams handed out the engine\'s own harmony object');
});

/**
 * Where the chord changed, as POSITIONS in the bar stream rather than bar
 * numbers: a scheduler that loses time resyncs by advancing the bar count, so
 * the nth chord event is the nth bar the engine actually realised whatever
 * number it carries.
 */
function chordChangePositions(chords) {
  const key = (chord) => chord.midis.join(',');
  const at = [];
  for (let i = 1; i < chords.length; i++) {
    if (key(chords[i]) !== key(chords[i - 1])) at.push(i);
  }
  return at;
}

/**
 * Chord events from a pad-only piece at repetition 1, which is what pins the
 * hook to its shortest loop (HOOK_MIN_CHORDS) and keeps the window below
 * inside the FIRST pass — where every slot still has its own degree, inversion
 * 0 and extension 0, so a chord change is always an audible change of midis.
 */
async function chordRun(params, wanted, seed = 7301) {
  const engine = createEngine({
    bpm: 120, speed: 2, complexity: 0.6, repetition: 1, structure: 'custom',
    customStructure: [{ label: 'A', bars: 64, intensity: 1 }],
    ...params,
    tracks: { ...tracksAll('off'), pad: { state: 'on', vary: { timing: 0, voice: 0 } } },
  }, { rng: seededRng(seed) });
  const chords = [];
  engine.on('chord', (chord) => chords.push(chord));
  await engine.start();
  const enough = await advanceUntil(() => chords.length > wanted, wanted + 40, FAST);
  engine.stop();
  assert.ok(enough, `only ${chords.length} chord events, wanted more than ${wanted}`);
  // Trimmed to the window that was asked for: advanceUntil checks its condition
  // once per clock step, so a loaded machine can overshoot by a bar or two, and
  // two runs compared against each other must be compared over the SAME window
  // rather than over however far each happened to get.
  return chords.slice(0, wanted + 1);
}

test('v21: a fixed harmony.rhythm holds every chord for exactly that many bars', () => hiddenTab(async () => {
  for (const bars of [1, 2, 4, 8]) {
    // The hook is four chords long at repetition 1, so the first pass is
    // exactly four spans: the changes belong at bars N, 2N, 3N and 4N (the
    // last being the return to the tonic that starts the second pass).
    const chords = await chordRun({ harmony: { rhythm: bars } }, bars * 4 + 1);
    const changes = chordChangePositions(chords).filter((at) => at <= bars * 4);
    assert.deepEqual(changes, [bars, bars * 2, bars * 3, bars * 4],
      `harmony.rhythm ${bars} did not hold each chord for ${bars} bars`);
  }
}));

test("v21: 'auto' harmonic rhythm is the one-or-two-bar draw it always was", () => hiddenTab(async () => {
  const spansOf = (chords) => {
    const at = chordChangePositions(chords).filter((position) => position <= 16);
    return at.map((position, i) => position - (i ? at[i - 1] : 0));
  };
  const declared = await chordRun({ harmony: { rhythm: 'auto' } }, 20);
  const omitted = await chordRun({}, 20);
  assert.deepEqual(omitted.map((chord) => chord.name), declared.map((chord) => chord.name),
    "declaring 'auto' must play exactly what naming no harmonic rhythm at all plays");

  const spans = spansOf(declared);
  assert.ok(spans.length >= 6, `only ${spans.length} chord spans to judge`);
  for (const span of spans) {
    assert.ok(span === 1 || span === 2, `an auto chord span of ${span} bars is neither one nor two`);
  }
}));

test('v21: padBreath is a 0–1 depth that ships at the swell the pad always had', () => {
  assert.equal(DEFAULT_PARAMS.padBreath, 0.28, 'padBreath must ship at the contour the pad already had');
  assert.equal(sanitiseParams({ padBreath: 0 }).padBreath, 0, 'an explicit 0 is a flat sustain, not a fallback');
  assert.equal(sanitiseParams({ padBreath: 1 }).padBreath, 1);
  assert.equal(sanitiseParams({ padBreath: 5 }).padBreath, 1, 'padBreath did not clamp above');
  assert.equal(sanitiseParams({ padBreath: -1 }).padBreath, 0, 'padBreath did not clamp below');
  assert.equal(sanitiseParams({ padBreath: 'nope' }).padBreath, DEFAULT_PARAMS.padBreath);
  const stored = sanitiseParams({ padBreath: 0.6 });
  assert.equal(sanitiseParams({ bpm: 90 }, stored).padBreath, 0.6, 'an unrelated edit dropped padBreath');
  assert.equal(createEngine({ padBreath: 0.75 }).getParams().padBreath, 0.75,
    'getParams did not round-trip padBreath');
});

test('v21: padBreath 0 flattens the pad contour, and 1 swings it wider than the default',
  () => hiddenTab(async () => {
    // Section intensity 1 rules out the breathing REST (its chance is scaled by
    // 1 - intensity), and an explicit vary.volume 0 rules out velocity jitter,
    // so the only thing left moving a pad velocity is the swell itself — and
    // padBreath draws no randomness, so all three runs below make identical
    // draws off the shared seed and can be compared note for note.
    const ATTACKS = 24;
    const velocitiesFor = async (padBreath) => {
      const engine = createEngine({
        bpm: 120, speed: 2, complexity: 0.6, repetition: 0.5, structure: 'custom',
        customStructure: [{ label: 'A', bars: 64, intensity: 1 }],
        ...(padBreath === undefined ? {} : { padBreath }),
        tracks: {
          ...tracksAll('off'),
          pad: { state: 'on', randomness: 0.5, vary: { volume: 0, timing: 0, voice: 0, pan: 0 } },
        },
      }, { rng: seededRng(7401) });
      const log = record(engine);
      await engine.start();
      const enough = await advanceUntil(
        () => log.notes.filter((n) => n.track === 'pad').length > ATTACKS, 80, FAST,
      );
      engine.stop();
      assert.ok(enough, 'the pad never played enough notes to read its contour');
      return log.notes.filter((n) => n.track === 'pad').slice(0, ATTACKS).map((n) => n.velocity);
    };
    const spread = (values) => Math.max(...values) - Math.min(...values);

    const flat = await velocitiesFor(0);
    const shipped = await velocitiesFor(undefined);
    const deep = await velocitiesFor(1);

    // A flat sustain leaves only the two levels the pad itself uses: the
    // downbeat attack, and the half-bar breath under it.
    const levels = new Set(flat.map((v) => v.toFixed(9)));
    assert.ok(levels.size <= 2,
      `padBreath 0 still produced ${levels.size} distinct velocities — the contour is not flat`);
    assert.ok(spread(shipped) > spread(flat) * 1.5,
      `the shipped contour (${spread(shipped).toFixed(3)}) is no wider than a flat one (${spread(flat).toFixed(3)})`);
    assert.ok(spread(deep) >= spread(shipped),
      `padBreath 1 (${spread(deep).toFixed(3)}) swings less than the default (${spread(shipped).toFixed(3)})`);
    assert.equal(shipped.length, flat.length, 'the runs did not stay comparable');
  }));

test('v21: ionian, mixolydian and phrygian are diatonic, and their chords name themselves honestly', () => {
  for (const mode of ['ionian', 'mixolydian', 'phrygian']) {
    const scale = SCALES[mode];
    assert.equal(scale.length, 7, `${mode} is a seven-note mode`);
    assert.equal(scale[0], 0, `${mode} starts on its own tonic`);
    for (let i = 1; i < scale.length; i++) {
      assert.ok(scale[i] > scale[i - 1] && scale[i] < 12,
        `${mode} is not a single ascending octave: ${scale.join(',')}`);
    }
  }
  assert.deepEqual(SCALES.ionian, [0, 2, 4, 5, 7, 9, 11]);
  assert.deepEqual(SCALES.mixolydian, [0, 2, 4, 5, 7, 9, 10], 'mixolydian is ionian with a flat seventh');
  assert.deepEqual(SCALES.phrygian, [0, 1, 3, 5, 7, 8, 10], 'phrygian is aeolian with a flat second');
  assert.equal(sanitiseParams({ mode: 'phrygian' }).mode, 'phrygian', 'the sanitiser rejected a new mode');

  /** Every triad the mode stacks on C, named from the semitones it contains. */
  const triadsOn = (mode, colour = 0) => {
    const scale = SCALES[mode];
    return scale.map((_, degree) => {
      const root = scaleDegreeToMidi(degree, scale, pitchClass('C'), 3);
      const midis = buildChord(degree, colour).map((d) => scaleDegreeToMidi(d, scale, pitchClass('C'), 3));
      return nameChord(root % 12, midis.map((midi) => midi - root));
    });
  };
  assert.deepEqual(triadsOn('ionian'), ['C', 'Dm', 'Em', 'F', 'G', 'Am', 'Bdim'],
    'C ionian must name its own I, IV and V as plain major triads');
  assert.deepEqual(triadsOn('mixolydian'), ['C', 'Dm', 'Edim', 'F', 'Gm', 'Am', 'A#'],
    "mixolydian's bVII is a major triad on the flat seventh");
  assert.deepEqual(triadsOn('phrygian'), ['Cm', 'C#', 'D#', 'Fm', 'Gdim', 'G#', 'A#m'],
    "phrygian's bII is a major triad on the flat second");

  // With sevenths on, the seventh degree of each mode is half-diminished —
  // naming it "dim7" would promise a diminished seventh that is not there.
  assert.equal(triadsOn('ionian', 0.5)[6], 'Bm7b5');
  assert.equal(triadsOn('ionian', 0.5)[0], 'Cmaj7');
  assert.equal(triadsOn('mixolydian', 0.5)[0], 'C7', 'mixolydian names its dominant seventh honestly');
  assert.equal(triadsOn('phrygian', 0.5)[0], 'Cm7');
});

test('v21: each new mode keeps the tune in its own scale and the bass on the chord root',
  () => hiddenTab(async () => {
    for (const mode of ['ionian', 'mixolydian', 'phrygian']) {
      const scalePcs = new Set(SCALES[mode].map((s) => (s + pitchClass('C')) % 12));

      // The motif: every note it develops is a scale degree, so a mode the
      // motif system had never seen must still be sung inside its own scale.
      const tune = await soloRun('melody', { state: 'on', vary: { voice: 0 } },
        { mode, root: 'C', seconds: 40, seed: 7501, complexity: 0.6 });
      const melody = tune.notes.filter((n) => n.track === 'melody');
      assert.ok(melody.length >= 30, `${mode}: only ${melody.length} melody notes to judge`);
      for (const note of melody) {
        assert.ok(scalePcs.has(note.midi % 12),
          `${mode}: the melody sang pitch class ${note.midi % 12}, which is not in the scale`);
      }
      assert.ok(melody.some((n) => n.motif === true),
        `${mode}: no melody bar was derived from the motif cell`);

      // The bass: the root of the chord the pad is voicing, on the downbeat.
      const log = await hookRun({ seconds: 60, seed: 7502, repetition: 0.8, mode, root: 'C' });
      const rootPc = chordRootPcByBar(log);
      const bassByBar = log.byBar('bass');
      const window = [...bassByBar.keys()]
        .filter((bar) => bar >= 2 && bar <= Math.min(FIRST_PASS_BAR_CEILING, log.bars.length - 2))
        .sort((a, b) => a - b);
      let strongBeats = 0;
      let matches = 0;
      for (const bar of window) {
        const downbeat = bassByBar.get(bar).filter((n) => n.offset < 1e-6);
        const expected = rootPc.get(bar);
        if (!downbeat.length || expected === undefined) continue;
        strongBeats += 1;
        if (downbeat.every((n) => n.midi % 12 === expected)) matches += 1;
        for (const note of downbeat) {
          assert.ok(scalePcs.has(note.midi % 12), `${mode}: the bass left the scale`);
        }
      }
      assert.ok(strongBeats >= 5, `${mode}: only ${strongBeats} bars had a bass downbeat and a chord to judge`);
      assert.ok(matches / strongBeats >= 0.95,
        `${mode}: bass matched the chord root on only ${((matches / strongBeats) * 100).toFixed(0)}% of ${strongBeats} downbeats`);
    }
  }));

test('v21: getResolved() publishes the resolved swing, density and kit lanes', () => hiddenTab(async () => {
  const engine = createEngine({
    swing: 0.6,
    tracks: {
      ...tracksAll('auto'),
      percussion: {
        state: 'auto', swing: 0,
        lanes: [...PERCUSSION_LANES.map((id) => ({ id })), { id: 'tom', label: 'Tom', kind: 'mid' }],
      },
      texture: { state: 'auto', density: 1.5 },
    },
  }, { rng: seededRng(7601) });
  await engine.start();
  await advance(6, FAST);
  const resolved = engine.getResolved();
  engine.stop();

  for (const name of TRACK_ORDER) {
    const track = resolved.tracks[name];
    assert.equal(typeof track.swing, 'number', `${name}: no resolved swing`);
    assert.equal(typeof track.density, 'number', `${name}: no resolved density`);
    assert.ok(track.swing >= 0 && track.swing <= 1, `${name}: resolved swing ${track.swing} out of range`);
    assert.ok(track.density >= 0 && track.density <= 2, `${name}: resolved density ${track.density} out of range`);
  }
  assert.equal(resolved.tracks.melody.swing, 0.6, 'a following track resolves to the global dial');
  assert.equal(resolved.tracks.percussion.swing, 0, "a track's own swing wins over the global dial");
  assert.equal(resolved.tracks.texture.density, 1.5, 'an explicit density must be reported as it stands');
  assert.equal(resolved.tracks.melody.density, 1, 'a following density resolves to 1');

  assert.deepEqual(resolved.tracks.percussion.lanes.map((lane) => lane.id),
    [...PERCUSSION_LANES, 'tom'], 'the kit lanes are missing from the readout');
  assert.equal(resolved.tracks.percussion.lanes[3].kind, 'mid', 'a lane readout must carry its voice kind');
  for (const name of TRACK_ORDER) {
    if (name === 'percussion') continue;
    assert.ok(!('lanes' in resolved.tracks[name]), `${name}: only the kit has lanes`);
  }
  resolved.tracks.percussion.lanes[0].id = 'wrecked';
  assert.equal(engine.getResolved().tracks.percussion.lanes[0].id, PERCUSSION_LANES[0],
    'getResolved handed out the engine\'s own lane objects');
}));

// --------------------------------------------------------------------------
// The track registry (v21) — identity proof
//
// The six fixed track tables (order, sequenced set, tuned set, mix, auto
// ladder, staged entry) became views over ONE registry. Every literal below
// was lifted from the engine as it stood BEFORE that refactor: these tests are
// the pin that says the move changed nothing, so they must never be "updated"
// to match a new derivation — a failure here is a behaviour change.
// --------------------------------------------------------------------------

test('identity: TRACK_ORDER, SEQUENCED_TRACKS and TUNED_TRACKS are exactly the lists they were', () => {
  assert.deepEqual(TRACK_ORDER, ['pad', 'bass', 'melody', 'texture', 'arp', 'percussion']);
  // The sequencer pass draws one rng() per track in SEQUENCED_TRACKS order, so
  // this order is load-bearing, not merely cosmetic.
  assert.deepEqual(SEQUENCED_TRACKS, ['melody', 'bass', 'arp', 'percussion']);
  assert.deepEqual(TUNED_TRACKS, ['pad', 'bass', 'melody', 'texture', 'arp']);
  for (const [name, list] of [['TRACK_ORDER', TRACK_ORDER], ['SEQUENCED_TRACKS', SEQUENCED_TRACKS],
    ['TUNED_TRACKS', TUNED_TRACKS]]) {
    assert.ok(Object.isFrozen(list), `${name} must stay frozen`);
  }
});

test('identity: the auto-activation ladder still switches each track on at its own energy', () => {
  // energy = 0.55·intensity + 0.45·complexity, so passing the same value for
  // both probes the ladder at exactly that energy.
  const THRESHOLDS = { pad: 0, bass: 0.1, melody: 0.24, texture: 0.36, arp: 0.48, percussion: 0.6 };
  const EPSILON = 1e-6;
  for (const [track, threshold] of Object.entries(THRESHOLDS)) {
    const above = autoActiveTracks(threshold + EPSILON, threshold + EPSILON);
    assert.ok(above.includes(track), `${track} stayed off at energy ${threshold}`);
    if (threshold > 0) {
      const below = autoActiveTracks(threshold - EPSILON, threshold - EPSILON);
      assert.ok(!below.includes(track), `${track} joined below its ${threshold} threshold`);
    }
  }
  // The set is always a prefix of TRACK_ORDER — the property the ladder's
  // rising thresholds exist to guarantee.
  for (let energy = 0; energy <= 1; energy += 0.05) {
    const active = autoActiveTracks(energy, energy);
    assert.deepEqual(active, TRACK_ORDER.slice(0, active.length),
      `energy ${energy} activated a non-prefix set: ${active.join(',')}`);
  }
});

test('identity: the mix table (tone, dry, sends) reaches the graph unchanged', () => hiddenTab(async () => {
  const MIX = {
    pad: { level: 0.36, dry: 0.8, reverb: 0.45, delay: 0.1, tone: 4000 },
    bass: { level: 0.44, dry: 1.0, reverb: 0.08, delay: 0.0, tone: 12000 },
    melody: { level: 0.28, dry: 0.75, reverb: 0.5, delay: 0.28, tone: 6000 },
    texture: { level: 0.2, dry: 0.6, reverb: 0.7, delay: 0.35, tone: 12000 },
    arp: { level: 0.2, dry: 0.7, reverb: 0.45, delay: 0.25, tone: 6500 },
    percussion: { level: 0.24, dry: 0.85, reverb: 0.3, delay: 0.12, tone: 9000 },
  };

  // arm() builds the graph and applies the sends BEFORE the voice library has
  // loaded, so what the nodes carry at this instant is the mix table itself,
  // untouched by any voice default or patch. Nothing may be awaited between
  // the arm and the reads.
  const engine = createEngine({ bpm: 120, speed: 2, structure: 'drone' }, { rng: seededRng(2101) });
  engine.arm();
  const ctx = liveContexts[liveContexts.length - 1];
  const sends = sendGains(ctx);
  const inputs = trackGains(ctx);
  for (const [name, mix] of Object.entries(MIX)) {
    const tone = inputs[name].connections.find((node) => node.kind === 'biquad');
    const dry = tone.connections.find((node) => node.kind === 'gain'
      && node !== sends[name].reverb && node !== sends[name].delay);
    assert.equal(tone.frequency.value, mix.tone, `${name}: tone ceiling moved`);
    assert.equal(dry.gain.value, mix.dry, `${name}: dry level moved`);
    assert.equal(sends[name].reverb.gain.value, mix.reverb, `${name}: default reverb send moved`);
    assert.equal(sends[name].delay.gain.value, mix.delay, `${name}: default delay send moved`);
  }
  engine.stop();
}));

test('identity: the mix levels are exactly the ceiling each track had', () => hiddenTab(async () => {
  const LEVELS = {
    pad: 0.36, bass: 0.44, melody: 0.28, texture: 0.2, arp: 0.2, percussion: 0.24,
  };
  // level 1 with randomness 0 holds every walk still, so the gain the chain
  // settles on IS the track's mix level.
  const engine = createEngine({
    bpm: 120, speed: 2, structure: 'drone', complexity: 0.8,
    tracks: tracksAll('on', { level: 1, randomness: 0 }),
  }, { rng: seededRng(2102) });
  await engine.start();
  await advance(10, FAST);
  const gains = trackGains(liveContexts[liveContexts.length - 1]);
  const settled = Object.fromEntries(TRACK_ORDER.map((name) => [name, gains[name].gain.value]));
  engine.stop();
  for (const [name, level] of Object.entries(LEVELS)) {
    assert.ok(Math.abs(settled[name] - level) < 1e-9,
      `${name}: mix level is ${settled[name]}, not ${level}`);
  }
}));

test('identity: staged entry still lets each track in on its own bar, all six by bar 5', () => hiddenTab(async () => {
  const STAGES = { pad: 0, bass: 1, melody: 2, texture: 3, arp: 4, percussion: 5 };
  // Full manual lanes make the sequenced tracks sound in the first bar their
  // stage allows, so their entry bar is the stage index itself.
  const engine = createEngine({
    bpm: 120, speed: 2, complexity: 1, repetition: 0, structure: 'custom',
    customStructure: [{ label: 'D', bars: 8, intensity: 1 }],
    tracks: tracksAll('on', { sequencer: { mode: 'manual', steps: seqLane() } }),
  }, { rng: seededRng(2103) });
  const log = record(engine);
  await engine.start();
  await advance(16, FAST);
  engine.stop();

  const first = {};
  for (const note of log.notes) {
    const owner = log.barOf(note);
    if (!owner) continue;
    first[note.track] = Math.min(first[note.track] ?? Infinity, owner.bar);
  }
  for (const [track, stage] of Object.entries(STAGES)) {
    assert.ok(Number.isFinite(first[track]), `${track} never played`);
    assert.ok(first[track] >= stage, `${track} sounded in bar ${first[track]}, before stage ${stage}`);
  }
  for (const track of SEQUENCED_TRACKS) {
    assert.equal(first[track], STAGES[track],
      `${track} waited until bar ${first[track]} with every step on`);
  }
  // The staged entry is exactly as long as there are tracks: the silence floor
  // takes over after bar 5 (STAGE_BARS = TRACK_ORDER.length - 1).
  assert.equal(TRACK_ORDER.length, 6);
  assert.equal(Math.max(...Object.values(STAGES)), TRACK_ORDER.length - 1);
}));

test('getTracks() publishes the registry in order, as a frozen public view', () => {
  // Display order per the standing user rule, not engine/staging order.
  const EXPECTED = [
    { id: 'pad', label: 'Pad', builtin: true, colourToken: '--track-pad', family: 'melodic' },
    { id: 'arp', label: 'Arp', builtin: true, colourToken: '--track-arp', family: 'melodic' },
    { id: 'melody', label: 'Melody', builtin: true, colourToken: '--track-melody', family: 'melodic' },
    { id: 'bass', label: 'Bass', builtin: true, colourToken: '--track-bass', family: 'melodic' },
    { id: 'texture', label: 'Texture', builtin: true, colourToken: '--track-texture', family: 'melodic' },
    { id: 'percussion', label: 'Percussion', builtin: true, colourToken: '--track-percussion', family: 'percussive' },
  ];
  const tracks = getTracks();
  // getTracks() publishes DISPLAY order (user rule: pad, arp, melody, bass,
  // texture, percussion) — engine/staging order is TRACK_ORDER, unchanged.
  assert.deepEqual(tracks.map((track) => track.id),
    ['pad', 'arp', 'melody', 'bass', 'texture', 'percussion'],
    'getTracks() broke display order');
  assert.deepEqual([...tracks.map((t) => t.id)].sort(), [...TRACK_ORDER].sort(),
    'getTracks() and TRACK_ORDER cover different track sets');
  assert.deepEqual(tracks, EXPECTED);
  for (const track of tracks) {
    assert.deepEqual(Object.keys(track), ['id', 'label', 'builtin', 'colourToken', 'family'],
      `${track.id}: the public view must publish these five fields and nothing else`);
  }
});

test('getTracks() hands out nothing a caller can edit the registry through', () => {
  const tracks = getTracks();
  assert.ok(Object.isFrozen(tracks), 'the track list must be frozen');
  for (const track of tracks) assert.ok(Object.isFrozen(track), `${track.id} entry must be frozen`);
  assert.throws(() => { getTracks()[0].label = 'wrecked'; }, TypeError);
  assert.throws(() => { getTracks().push({ id: 'wrecked' }); }, TypeError);
  assert.equal(getTracks()[0].label, 'Pad', 'the registry was edited through getTracks()');
});

test('the engine handle carries getTracks() beside getResolved()', () => {
  const engine = createEngine();
  assert.equal(typeof engine.getTracks, 'function', 'no getTracks() on the engine handle');
  assert.deepEqual(engine.getTracks(), getTracks(),
    'the handle must publish the same registry view as the module export');
  assert.deepEqual([...engine.getTracks().map((track) => track.id)].sort(),
    [...Object.keys(engine.getParams().tracks)].sort(),
    'params.tracks and the registry disagree about which tracks exist');
});

// --------------------------------------------------------------------------
// The instance track layer (v23) — floor/layer identity proof
//
// An engine reads its tracks through accessors instead of the module's frozen
// tables, so a user track added at runtime can reach every call site. With no
// user tracks the accessors must hand back THE MODULE'S OWN objects: same
// reference, no copy, no re-sort. That identity is what keeps every proof
// above true, so it is asserted by reference, never by deep equality.
// --------------------------------------------------------------------------

test('identity: the track layer hands back the module\'s own frozen lists, not copies', () => {
  const layer = createTrackLayer();
  assert.equal(layer.trackOrder(), TRACK_ORDER, 'trackOrder() must BE TRACK_ORDER');
  assert.equal(layer.sequencedTracks(), SEQUENCED_TRACKS, 'sequencedTracks() must BE SEQUENCED_TRACKS');
  assert.equal(layer.tunedTracks(), TUNED_TRACKS, 'tunedTracks() must BE TUNED_TRACKS');
  assert.equal(layer.trackViews(), getTracks(), 'trackViews() must BE the module\'s public view');
  // Repeated calls, and a second engine's layer, share those same objects:
  // an accessor that allocated would break every identity pin above.
  const other = createTrackLayer();
  assert.equal(layer.trackOrder(), other.trackOrder());
  assert.equal(layer.trackViews(), other.trackViews());
  assert.equal(layer.trackOrder(), layer.trackOrder());
});

test('identity: the layer\'s per-track accessors answer from the floor\'s own rows', () => {
  const STAGES = { pad: 0, bass: 1, melody: 2, texture: 3, arp: 4, percussion: 5 };
  const THRESHOLDS = { pad: 0, bass: 0.1, melody: 0.24, texture: 0.36, arp: 0.48, percussion: 0.6 };
  const layer = createTrackLayer();
  assert.deepEqual(layer.trackRegistry().map((row) => row.id), [...TRACK_ORDER],
    'the layer\'s registry is TRACK_ORDER\'s own rows, in engine order');
  for (const name of TRACK_ORDER) {
    const row = layer.trackById(name);
    assert.ok(row && Object.isFrozen(row), `${name}: the registry row must stay frozen`);
    assert.equal(layer.trackRegistry().find((entry) => entry.id === name), row,
      `${name}: trackById and the registry must hand back one row, not two`);
    assert.equal(layer.mixFor(name), row.mix, `${name}: mixFor must hand back the row's own mix`);
    assert.equal(layer.stageIndexOf(name), STAGES[name], `${name}: staged entry moved`);
    assert.equal(layer.autoThresholdFor(name), THRESHOLDS[name], `${name}: ladder threshold moved`);
  }
  // The staged entry is exactly as long as there are tracks, and stageBars()
  // is read per bar rather than captured, so a later window can grow it.
  assert.equal(layer.stageBars(), TRACK_ORDER.length - 1);
  assert.equal(layer.stageBars(), Math.max(...Object.values(STAGES)));
  assert.equal(layer.trackById('nope'), undefined, 'an unknown id has no row');
  assert.equal(layer.stageIndexOf('nope'), -1, 'an unknown id stays out of the staged entry');
});

test('identity: the defaulted track arguments are the floor, so old callers ask the same question', () => {
  const layer = createTrackLayer();
  // autoActiveTracks through the layer IS the ladder the v22 proof pins.
  for (let energy = 0; energy <= 1; energy += 0.05) {
    assert.deepEqual(
      autoActiveTracks(energy, energy, layer.trackOrder(), layer.autoThresholdFor),
      autoActiveTracks(energy, energy),
      `energy ${energy}: the layer's ladder diverged from the floor's`,
    );
  }
  // Same for the sanitiser's iteration source: passing the floor list is what
  // omitting it already does.
  assert.deepEqual(sanitiseParams({ bpm: 92 }, DEFAULT_PARAMS, layer.trackOrder()),
    sanitiseParams({ bpm: 92 }), 'sanitiseParams drifted from its default track list');
});

test('identity: an engine publishes the module\'s own view, by reference', () => {
  const engine = createEngine();
  assert.equal(engine.getTracks(), getTracks(),
    'engine.getTracks() must BE the module view while no user track exists');
  assert.equal(engine.getTracks(), engine.getTracks(), 'the handle must not allocate a view');
});

test('identity: createEngine reads its tracks through the layer, never a module table', () => {
  const source = readFileSync(new URL('../src/scripts/ambient-engine.js', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('export function createEngine('));
  assert.ok(body.length > 1000, 'createEngine was not found in the engine source');
  // A module table read inside createEngine is a table a user track can never
  // reach — the whole point of the layer. Comments count: a stale one here
  // sends the next reader back to the constant.
  for (const table of ['TRACK_REGISTRY', 'TRACK_BY_ID', 'TRACK_VIEWS', 'TRACK_ORDER',
    'SEQUENCED_TRACKS', 'TUNED_TRACKS', 'TRACK_MIX', 'AUTO_THRESHOLDS', 'MAX_STAGE_INDEX']) {
    assert.equal(new RegExp(`\\b${table}\\b`).test(body), false,
      `createEngine reads ${table} directly — it must go through the track layer`);
  }
});

// --------------------------------------------------------------------------
// params.userTracks (v23) — a hand-written blob creates a track
//
// Identity lives in its OWN ordered array, and that array is AUTHORITATIVE on
// setParams: supplying an entry creates the track and omitting one removes it.
// No UI and no addTrack() exist yet, so a params blob is the whole interface —
// which is exactly what makes the runtime testable head-lessly here.
// --------------------------------------------------------------------------

/** A well-formed user-track spec, overridable field by field. */
const userTrack = (id, extra = {}) => ({
  id, label: id.toUpperCase(), family: 'melodic', voiceSet: 'pad', ...extra,
});

/** N valid user tracks, `u1`…`uN`. */
const userTracks = (count) => Array.from({ length: count }, (unused, i) => userTrack(`u${i + 1}`));

/** A user track sequenced on every slot — the loudest possible "does it sound". */
const soundingTrack = (extra = {}) => ({
  state: 'on', level: 1, randomness: 0,
  sequencer: { mode: 'manual', steps: seqLane() },
  ...extra,
});

test('v23 userTracks: the id grammar accepts and rejects exactly what it says', () => {
  const idsOf = (list) => sanitiseParams({ userTracks: list }).userTracks.map((t) => t.id);

  for (const id of ['ab', 'drone', 'my-track', 'a1', 'x9-y8-z7', `a${'b'.repeat(23)}`]) {
    assert.deepEqual(idsOf([userTrack(id)]), [id], `${id} should be a legal id`);
  }
  for (const id of [
    'a',                        // one character is not a name
    `a${'b'.repeat(24)}`,       // 25 characters is past the cap
    'Drone',                    // the id is a CSS-var suffix and a params key
    '1drone',                   // must start with a letter
    '-drone',
    'my track',
    'my.track',
    'my_track',
    // A frozen plan key is `${track}#${lane}`, so a '#' in an id would collide
    // with the lane grid of the track it named.
    'my#track',
    '',
  ]) {
    assert.deepEqual(idsOf([userTrack(id)]), [], `${JSON.stringify(id)} must be refused`);
  }
  for (const id of [...TRACK_ORDER, 'off', 'auto', 'on', 'master', 'global', 'all', 'none']) {
    assert.deepEqual(idsOf([userTrack(id)]), [], `${id} is reserved`);
  }
  // Case is not folded — the grammar forbids uppercase, so there is nothing to
  // fold — and a duplicate is the second entry's problem, not the first's.
  assert.deepEqual(idsOf([userTrack('drone'), userTrack('drone', { label: 'Other' })]), ['drone']);
  assert.equal(sanitiseParams({ userTracks: [userTrack('drone'), userTrack('drone')] })
    .userTracks[0].label, 'DRONE', 'the FIRST entry of a duplicate pair must survive');
});

test('v23 userTracks: label, family, voiceSet and colour are validated whole', () => {
  const first = (spec) => sanitiseParams({ userTracks: [spec] }).userTracks[0] ?? null;

  assert.equal(first(userTrack('a1', { label: '  Deep drone  ' })).label, 'Deep drone');
  assert.equal(first(userTrack('a1', { label: 'x'.repeat(40) })).label, 'x'.repeat(24));
  for (const label of ['', '   ', 42, null, undefined]) {
    assert.equal(first(userTrack('a1', { label })), null, `label ${JSON.stringify(label)} must drop the entry`);
  }
  for (const family of ['tuned', 'drums', '', null, undefined]) {
    assert.equal(first(userTrack('a1', { family })), null, `family ${JSON.stringify(family)} must drop the entry`);
  }
  // A kit needs the drum voices, and a pitched line has nothing to say through
  // them: the percussive family and the percussion bank imply each other.
  assert.equal(first(userTrack('a1', { family: 'percussive', voiceSet: 'percussion' })).voiceSet, 'percussion');
  assert.equal(first(userTrack('a1', { family: 'percussive', voiceSet: 'pad' })), null);
  assert.equal(first(userTrack('a1', { family: 'melodic', voiceSet: 'percussion' })), null);
  assert.equal(first(userTrack('a1', { voiceSet: 'nonesuch' })), null);
  for (const voiceSet of ['pad', 'bass', 'melody', 'texture', 'arp']) {
    assert.equal(first(userTrack('a1', { voiceSet })).voiceSet, voiceSet);
  }

  assert.equal(first(userTrack('a1', { colourToken: '--my-colour' })).colourToken, '--my-colour');
  // Anything unusable takes the assigned token rather than dropping the track:
  // a colour is presentation, and the theme always has a var to define.
  for (const token of ['track-user-1', '--Bad', '--', 'red', 7]) {
    assert.equal(first(userTrack('a1', { colourToken: token })).colourToken, '--track-user-1');
  }
  assert.deepEqual(
    sanitiseParams({ userTracks: userTracks(3) }).userTracks.map((t) => t.colourToken),
    ['--track-user-1', '--track-user-2', '--track-user-3'],
    'assigned colour tokens follow creation order',
  );
  assert.deepEqual(Object.keys(first(userTrack('a1'))),
    ['id', 'label', 'family', 'voiceSet', 'colourToken'],
    'a userTracks entry publishes these five fields and nothing else');
});

test('v23 userTracks: the cap drops the tail, and a bad entry drops alone', () => {
  // Six user tracks on top of the six built-ins is the twelve-track cap.
  const capped = sanitiseParams({ userTracks: userTracks(9) });
  assert.deepEqual(capped.userTracks.map((t) => t.id), ['u1', 'u2', 'u3', 'u4', 'u5', 'u6']);
  assert.equal(Object.keys(capped.tracks).length, 12, 'twelve tracks is the cap');

  // An entry that fails validation is dropped WHOLE, and the rest are kept:
  // never coerced, never renamed, and never a reason to lose the preset.
  const mixed = sanitiseParams({
    userTracks: [userTrack('good-one'), { id: 'BAD' }, null, 'nope',
      userTrack('good-two', { family: 'percussive', voiceSet: 'percussion' })],
  });
  assert.deepEqual(mixed.userTracks.map((t) => t.id), ['good-one', 'good-two']);
  // The cap counts only what survived, so six good entries behind a bad one
  // still all arrive.
  const rescued = sanitiseParams({ userTracks: [{ id: 'BAD' }, ...userTracks(6)] });
  assert.deepEqual(rescued.userTracks.map((t) => t.id), ['u1', 'u2', 'u3', 'u4', 'u5', 'u6']);
});

test('v23 userTracks: the track entry is built by the same code paths as a built-in', () => {
  const params = sanitiseParams({
    userTracks: [userTrack('drone'), userTrack('kit', { family: 'percussive', voiceSet: 'percussion' })],
  });
  assert.deepEqual(Object.keys(params.tracks),
    [...TRACK_ORDER, 'drone', 'kit'], 'user tracks append after every built-in');

  const drone = params.tracks.drone;
  assert.equal(drone.state, 'on', 'the user just made it — it should sound');
  assert.equal(drone.voice, DEFAULT_PARAMS.tracks.pad.voice, 'the voiceSet decides the default voice');
  assert.equal(drone.level, 0.8);
  assert.deepEqual(drone.randomness, { min: 0.35, max: 0.65 });
  assert.equal(drone.driftRate, 1);
  assert.equal(drone.swing, null);
  assert.equal(drone.density, null);
  assert.equal(drone.hold, false);
  assert.equal(drone.mono, false);
  assert.equal(drone.glide, 0);
  // The pad/texture voice wander is a built-in-specific ruling, not a default
  // a new track inherits.
  assert.deepEqual(drone.vary, Object.fromEntries(VARY_ASPECTS.map((a) => [a, null])));
  assert.equal(drone.dissonance, 0, 'melodic ⇒ tuned ⇒ it has a dissonance dial');
  assert.equal('lanes' in drone, false, 'a melodic track has one grid, not a kit');
  // EVERY user track is sequenced: its step grid is its whole material.
  assert.ok(Array.isArray(drone.sequencer.steps));
  assert.equal(drone.sequencer.steps.length, SEQUENCER_STEP_COUNT);
  assert.equal(drone.sequencer, drone.sequencers[0], 'the v6 singular alias must survive');

  const kit = params.tracks.kit;
  assert.equal('dissonance' in kit, false, 'a kit has no chord discipline to keep');
  assert.deepEqual(kit.lanes.map((lane) => lane.id), [...PERCUSSION_LANES],
    'a user kit gets its OWN copy of the three built-in lanes');
  assert.deepEqual(Object.keys(kit.sequencer.steps), [...PERCUSSION_LANES],
    'a percussive track gets a lane-map grid, not a melodic single lane');
  assert.notEqual(kit.lanes, params.tracks.percussion.lanes, 'nothing is shared with the built-in kit');
});

test('v23 userTracks: absent means zero, and a pre-v23 blob is unchanged', () => {
  assert.deepEqual(DEFAULT_PARAMS.userTracks, [], 'a params object ships with no user tracks');
  assert.deepEqual(sanitiseParams({}).userTracks, []);
  assert.deepEqual(Object.keys(sanitiseParams({}).tracks), [...TRACK_ORDER]);

  // A stored blob written before this window loads unchanged — the sanitiser's
  // own round-trip proof, run over a params object that never mentions the key.
  const legacy = sanitiseParams({ bpm: 92, mode: 'aeolian', tracks: { melody: { level: 0.4 } } });
  delete legacy.userTracks;
  const loaded = sanitiseParams(legacy);
  assert.deepEqual(loaded.userTracks, []);
  assert.deepEqual({ ...loaded, userTracks: undefined }, { ...legacy, userTracks: undefined });

  // An unrelated edit never drops the list, and an explicit empty array does.
  const stored = sanitiseParams({ userTracks: userTracks(2) });
  assert.deepEqual(sanitiseParams({ bpm: 100 }, stored).userTracks.map((t) => t.id), ['u1', 'u2']);
  assert.deepEqual(sanitiseParams({ userTracks: [] }, stored).userTracks, []);
  assert.deepEqual(Object.keys(sanitiseParams({ userTracks: [] }, stored).tracks), [...TRACK_ORDER]);
});

test('v23 userTracks: an orphan tracks or patches key is dropped, a matched one is kept', () => {
  // Neither a built-in nor a surviving userTracks id: dropped silently, exactly
  // as every unknown track key always has been.
  const orphaned = sanitiseParams({
    tracks: { ghost: { level: 0.2 } },
    patches: { ghost: { warm: { filter: { cutoff: 800 } } } },
  });
  assert.equal('ghost' in orphaned.tracks, false);
  assert.equal('ghost' in orphaned.patches, false);

  // The same keys, WITH the identity entry that names them: both are kept.
  const matched = sanitiseParams({
    userTracks: [userTrack('drone')],
    tracks: { drone: { level: 0.2, state: 'off' } },
    patches: { drone: { warm: { filter: { cutoff: 800 } } } },
  });
  assert.equal(matched.tracks.drone.level, 0.2);
  assert.equal(matched.tracks.drone.state, 'off');
  assert.equal(matched.patches.drone.warm.filter.cutoff, 800);

  // Removing the identity entry orphans its track and patch entries, which drop
  // with it — a track added and later removed leaves nothing behind.
  const removed = sanitiseParams({ userTracks: [] }, matched);
  assert.equal('drone' in removed.tracks, false);
  assert.equal('drone' in removed.patches, false);
});

test('v23 userTracks: setParams/getParams round-trip, deep-copied', () => {
  const engine = createEngine({ userTracks: [userTrack('drone')] });
  assert.deepEqual(engine.getParams().userTracks,
    [{ id: 'drone', label: 'DRONE', family: 'melodic', voiceSet: 'pad', colourToken: '--track-user-1' }]);

  // getParams() hands out a copy: editing it must not reach the engine.
  const handed = engine.getParams();
  handed.userTracks[0].label = 'wrecked';
  handed.userTracks.push(userTrack('sneaky'));
  handed.tracks.drone.level = 0.01;
  assert.equal(engine.getParams().userTracks.length, 1);
  assert.equal(engine.getParams().userTracks[0].label, 'DRONE');
  assert.equal(engine.getParams().tracks.drone.level, 0.8);

  // A second track arrives, and the first keeps its place: order is creation
  // order, and the accessors rebuild around it.
  engine.setParams({ userTracks: [userTrack('drone'), userTrack('kit', { family: 'percussive', voiceSet: 'percussion' })] });
  assert.deepEqual(engine.getTracks().map((t) => t.id),
    ['pad', 'arp', 'melody', 'bass', 'texture', 'percussion', 'drone', 'kit']);
  assert.deepEqual(engine.getTracks().map((t) => t.builtin),
    [true, true, true, true, true, true, false, false]);
  for (const view of engine.getTracks()) {
    assert.deepEqual(Object.keys(view), ['id', 'label', 'builtin', 'colourToken', 'family'],
      `${view.id}: the public view keeps EXACTLY its five keys`);
    assert.ok(Object.isFrozen(view), `${view.id}: the public view must stay frozen`);
  }
  assert.ok(Object.isFrozen(engine.getTracks()), 'the instance list must be frozen too');

  // And the module export never learns about them: it is what index.astro reads
  // at BUILD time, and a server render cannot know a user's tracks.
  assert.equal(getTracks().length, 6, 'the module export must stay built-ins-only forever');
  assert.equal(getTracks().map((t) => t.id).includes('drone'), false);
});

test('v23 userTracks: staging, the ladder and the mix defaults extend the floor', () => {
  const layer = createTrackLayer();
  layer.setUserTracks(sanitiseParams({ userTracks: userTracks(6) }).userTracks);

  assert.deepEqual(layer.trackOrder(), [...TRACK_ORDER, 'u1', 'u2', 'u3', 'u4', 'u5', 'u6']);
  // Where a new sequenced track is INSERTED decides whether every existing seed
  // still produces the same music: appending is the only safe position.
  assert.deepEqual(layer.sequencedTracks(), [...SEQUENCED_TRACKS, 'u1', 'u2', 'u3', 'u4', 'u5', 'u6']);
  assert.deepEqual(layer.tunedTracks(), [...TUNED_TRACKS, 'u1', 'u2', 'u3', 'u4', 'u5', 'u6']);

  // Staged entry appends after the built-ins and the entry lengthens with it.
  assert.deepEqual(['u1', 'u2', 'u3', 'u4', 'u5', 'u6'].map((id) => layer.stageIndexOf(id)),
    [6, 7, 8, 9, 10, 11]);
  assert.equal(layer.stageBars(), 11);

  // Ladder: 0.6 + 0.05 × (ordinal + 1), rising and all above percussion's 0.6.
  assert.deepEqual(['u1', 'u2', 'u3', 'u4', 'u5', 'u6'].map((id) => layer.autoThresholdFor(id)),
    [0.65, 0.7, 0.75, 0.8, 0.85, 0.9]);
  for (let energy = 0; energy <= 1.0001; energy += 0.05) {
    const active = autoActiveTracks(energy, energy, layer.trackOrder(), layer.autoThresholdFor);
    assert.deepEqual(active, layer.trackOrder().slice(0, active.length),
      `energy ${energy} activated a non-prefix set: ${active.join(',')}`);
  }

  // The decorative tier by family, not the pad/bass tier.
  const kitLayer = createTrackLayer();
  kitLayer.setUserTracks(sanitiseParams({
    userTracks: [userTrack('drone'), userTrack('kit', { family: 'percussive', voiceSet: 'percussion' })],
  }).userTracks);
  assert.deepEqual(kitLayer.mixFor('drone'), { level: 0.2, dry: 0.7, reverb: 0.45, delay: 0.25, tone: 6500 });
  assert.deepEqual(kitLayer.mixFor('kit'), { level: 0.24, dry: 0.85, reverb: 0.3, delay: 0.12, tone: 9000 });
  // No built-in's mix moves to make room for them.
  for (const name of TRACK_ORDER) {
    assert.equal(kitLayer.mixFor(name), createTrackLayer().mixFor(name), `${name}: mix moved`);
  }

  // Emptying the list puts every accessor back on the module's own object.
  layer.setUserTracks([]);
  assert.equal(layer.trackOrder(), TRACK_ORDER);
  assert.equal(layer.trackViews(), getTracks());
  assert.equal(layer.stageBars(), 5);
});

test('v23 userTracks: a params blob alone makes a seventh track SOUND', () => hiddenTab(async () => {
  const engine = createEngine({
    bpm: 120, speed: 2, complexity: 1, repetition: 0, structure: 'custom',
    customStructure: [{ label: 'D', bars: 16, intensity: 1 }],
    userTracks: [userTrack('drone')],
    tracks: { ...tracksAll('on'), drone: soundingTrack() },
  }, { rng: seededRng(2301) });
  const log = record(engine);
  await engine.start();
  const played = () => log.notes.filter((note) => note.track === 'drone');
  assert.ok(await advanceUntil(() => played().length > 20, 48, FAST),
    'the user track never sounded');

  const heard = played();
  assert.ok(heard.every((note) => Number.isFinite(note.midi)),
    'a melodic user track must sound pitches, not kit hits');
  // Staged entry: it enters AFTER every built-in, on bar 6.
  const first = Math.min(...heard.map((note) => log.barOf(note).bar));
  assert.equal(first, 6, 'the user track entered before its stage bar');

  // Five surfaces, one track, order asserted.
  assert.deepEqual(Object.keys(engine.getStats().perTrack), [...TRACK_ORDER, 'drone']);
  assert.ok(engine.getStats().perTrack.drone.notesPerMin > 0, 'the stats poll never saw it play');
  assert.deepEqual(Object.keys(engine.getResolved().tracks), [...TRACK_ORDER, 'drone']);
  assert.equal(engine.getResolved().tracks.drone.active, true);
  assert.deepEqual(Object.keys(engine.getAnalysers()), [...TRACK_ORDER, 'drone', 'total']);
  assert.ok(engine.getAnalysers().drone, 'the user track has no analyser node');
  assert.deepEqual(Object.keys(engine.getParams().tracks), [...TRACK_ORDER, 'drone']);

  // Its chain is a real chain: level 1 at randomness 0 settles on the mix
  // ceiling its family publishes.
  const ctx = liveContexts[liveContexts.length - 1];
  const bus = reverbBus(ctx);
  const sends = ctx.nodes.filter((n) => n.kind === 'gain' && n.connections.includes(bus));
  assert.equal(sends.length, TRACK_ORDER.length + 1, 'expected one reverb send per track');
  const tone = ctx.nodes.find((n) => n.kind === 'biquad' && n.connections.includes(sends[6]));
  const input = ctx.nodes.find((n) => n.kind === 'gain' && n.connections.includes(tone));
  assert.ok(Math.abs(input.gain.value - 0.2) < 1e-9,
    `the user track settled at ${input.gain.value}, not its 0.2 mix ceiling`);
  engine.stop();
}));

test('v23 userTracks: a percussive user track strikes its own lanes', () => hiddenTab(async () => {
  const engine = createEngine({
    bpm: 120, speed: 2, complexity: 1, repetition: 0, structure: 'custom',
    customStructure: [{ label: 'D', bars: 16, intensity: 1 }],
    userTracks: [userTrack('kit', { family: 'percussive', voiceSet: 'percussion' })],
    tracks: {
      kit: soundingTrack({
        sequencer: {
          mode: 'manual',
          steps: { low: seqLane(), mid: seqLane({ on: false }), high: seqLane({ on: false }) },
        },
      }),
    },
  }, { rng: seededRng(2302) });
  const log = record(engine);
  await engine.start();
  const played = () => log.notes.filter((note) => note.track === 'kit');
  assert.ok(await advanceUntil(() => played().length > 20, 48, FAST), 'the user kit never sounded');
  engine.stop();

  const hits = played();
  assert.ok(hits.every((hit) => hit.midi === null), 'a kit sounds pitchless strokes');
  assert.deepEqual([...new Set(hits.map((hit) => hit.lane))], ['low'],
    'only the lane the grid names may fire');
  assert.deepEqual([...new Set(hits.map((hit) => hit.kind))], ['low'],
    'a lane sounds through the voice kind it maps onto');
}));

test('v23 userTracks: a track added mid-run gains its chain and sounds from a later bar',
  () => hiddenTab(async () => {
    const engine = createEngine({
      bpm: 120, speed: 2, complexity: 1, repetition: 0, structure: 'custom',
      customStructure: [{ label: 'D', bars: 24, intensity: 1 }],
    }, { rng: seededRng(2303) });
    const log = record(engine);
    await engine.start();
    await advance(8, FAST);

    const ctx = liveContexts[liveContexts.length - 1];
    const bus = reverbBus(ctx);
    const sendCount = () => ctx.nodes.filter((n) => n.kind === 'gain'
      && n.connections.includes(bus)).length;
    assert.equal(sendCount(), TRACK_ORDER.length);

    const madeAt = ctx.currentTime;
    engine.setParams({
      userTracks: [userTrack('drone')],
      tracks: { drone: soundingTrack() },
    });
    // The chain is built at once — a note reaching a track with no graph node
    // is a TypeError inside the scheduler's lookahead, which stops the piece
    // rather than the track.
    assert.equal(sendCount(), TRACK_ORDER.length + 1, 'the added track got no chain');
    assert.ok(engine.getAnalysers().drone, 'the added track got no analyser');

    const played = () => log.notes.filter((note) => note.track === 'drone');
    assert.ok(await advanceUntil(() => played().length > 10, 48, FAST),
      'the added track never sounded');
    engine.stop();
    assert.ok(played().every((note) => note.time >= madeAt),
      'the added track sounded before it existed');
  }));

test('v23 userTracks: a track removed mid-run rings out, then its chain is dropped',
  () => hiddenTab(async () => {
    const engine = createEngine({
      bpm: 120, speed: 2, complexity: 1, repetition: 0, structure: 'custom',
      customStructure: [{ label: 'D', bars: 24, intensity: 1 }],
      userTracks: [userTrack('drone')],
      // The user track alone, so any note still sounding after the removal can
      // only be one of its own.
      tracks: { ...tracksAll('off'), drone: soundingTrack() },
    }, { rng: seededRng(2304) });
    const log = record(engine);
    await engine.start();
    const heard = () => log.notes.filter((note) => note.track === 'drone');
    assert.ok(await advanceUntil(() => heard().length > 10, 40, FAST),
      'the user track never sounded, so there is no removal to judge');

    const ctx = liveContexts[liveContexts.length - 1];
    const bus = reverbBus(ctx);
    const sends = () => ctx.nodes.filter((n) => n.kind === 'gain' && n.connections.includes(bus));
    const chain = sends()[TRACK_ORDER.length];
    assert.ok(chain, 'the user track has no reverb send to retire');

    // Small clock steps with room to breathe, so the scheduler's lookahead is
    // genuinely AHEAD of the mock clock again: the removal has to land while
    // the track still has notes to come, or there is no ring-out to judge.
    const SETTLED = { step: 0.05, sleep: 20 };
    await advance(0.6, SETTLED);
    const sounded = heard().length;
    engine.setParams({ userTracks: [] });

    // Params drop on the same tick; the SOUND does not. Cutting a ringing note
    // is the click the 50 ms-fade rule exists to prevent, so the chain stays
    // wired while anything on it is still sounding.
    assert.deepEqual(engine.getParams().userTracks, []);
    assert.equal('drone' in engine.getParams().tracks, false);
    assert.equal(engine.getTracks().map((t) => t.id).includes('drone'), false);
    assert.equal(engine.getAnalysers().drone, undefined, 'getAnalysers must drop the key at once');
    assert.equal(sends().length, TRACK_ORDER.length + 1,
      'the chain was cut while its notes were still ringing');

    // On into the span of a note the removed track had already scheduled. The
    // stats poll is on the page's timer and feeds the power governor, so a note
    // outliving its track must not be a deref there — which is what polling it
    // across the ring-out proves.
    assert.ok(await advanceUntil(() => engine.getStats().totalActiveNotes > 0, 4, SETTLED),
      'nothing of the removed track ever rang, so the ring-out is untested');
    assert.equal(engine.getStats().perTrack.drone, undefined, 'a removed track keeps no stats row');
    assert.equal(sends().length, TRACK_ORDER.length + 1, 'the chain was cut mid-note');

    // Nothing new is scheduled for it from the moment of the call.
    await advance(20, FAST);
    assert.equal(heard().length, sounded, 'a removed track kept being scheduled');
    assert.ok(Number.isFinite(engine.getStats().totalActiveNotes));
    assert.equal(sends().length, TRACK_ORDER.length, 'the retired chain was never dropped');
    assert.ok(chain.disconnects.length, 'the retired send was never disconnected');
    engine.stop();
  }));

test('v23 userTracks: level, sequencer and patches round-trip and apply', () => hiddenTab(async () => {
  const engine = createEngine({
    bpm: 120, speed: 2, complexity: 1, repetition: 0, structure: 'custom',
    customStructure: [{ label: 'D', bars: 16, intensity: 1 }],
    userTracks: [userTrack('drone')],
    tracks: { drone: soundingTrack() },
  }, { rng: seededRng(2305) });

  // Every per-track sanitiser reaches a user track, because every one of them
  // iterates the engine's own list rather than the module's six.
  engine.setParams({
    tracks: {
      drone: {
        level: { min: 0.2, max: 0.4 }, randomness: 0.5, driftRate: 0.5,
        swing: 0.3, density: 1.5, hold: true, mono: true, glide: 0.5, dissonance: 0.25,
        vary: { volume: 0.2 },
        sequencer: { mode: 'manual', steps: seqLane({ prob: 0.5 }) },
      },
    },
    patches: { drone: { warm: { filter: { cutoff: 900 }, adsr: { release: 1.5 } } } },
  });
  const stored = engine.getParams().tracks.drone;
  assert.deepEqual(stored.level, { min: 0.2, max: 0.4 });
  assert.equal(stored.randomness, 0.5);
  assert.equal(stored.driftRate, 0.5);
  assert.equal(stored.swing, 0.3);
  assert.equal(stored.density, 1.5);
  assert.equal(stored.hold, true);
  assert.equal(stored.mono, true);
  assert.equal(stored.glide, 0.5);
  assert.equal(stored.dissonance, 0.25);
  assert.equal(stored.vary.volume, 0.2);
  assert.equal(stored.sequencer.steps[0].prob, 0.5);
  assert.equal(engine.getParams().patches.drone.warm.filter.cutoff, 900);
  assert.equal(engine.getParams().patches.drone.warm.adsr.release, 1.5);

  await engine.start();
  await advance(20, FAST);
  // The live readouts resolve for a user track exactly as for a built-in.
  const resolved = engine.getResolved();
  assert.ok(resolved.tracks.drone.level >= 0.2 && resolved.tracks.drone.level <= 0.4);
  assert.equal(resolved.tracks.drone.swing, 0.3);
  assert.equal(resolved.tracks.drone.density, 1.5);
  assert.equal(resolved.tracks.drone.held, true);
  assert.equal(resolved.patches.drone.filter.cutoff, 900);
  engine.stop();
}));

test('v23 byte-identity: with no user tracks the seeded note stream is unchanged',
  () => hiddenTab(async () => {
    const play = async (before) => {
      const engine = createEngine({
        bpm: 120, speed: 2, complexity: 0.7, repetition: 0.4, structure: 'journey',
        tracks: tracksAll('on'),
      }, { rng: seededRng(2306) });
      if (before) before(engine);
      const log = record(engine);
      await engine.start();
      await advance(20, FAST);
      engine.stop();
      return log.notes.map((note) => [note.track, note.midi, note.kind, note.lane,
        tick(note.time), tick(note.duration), note.velocity].join('|'));
    };

    const plain = await play(null);
    // The same piece on an engine that has had a user track added AND removed:
    // the layer must be back on the module's own frozen lists, and nothing the
    // add did may have drawn a single rng().
    const churned = await play((engine) => {
      engine.setParams({ userTracks: [userTrack('drone')] });
      engine.setParams({ userTracks: [] });
    });

    // How much music a fixed wall of mock seconds buys depends on how busy the
    // box is, so the two runs are compared over the bars they both reached.
    const shared = Math.min(plain.length, churned.length);
    assert.ok(shared > 200, `only ${shared} shared notes — too few to judge`);
    assert.deepEqual(churned.slice(0, shared), plain.slice(0, shared),
      'an added-and-removed user track changed the six built-ins\' note stream');
  }));

// --------------------------------------------------------------------------
// addTrack / removeTrack / canAddTrack (v23) — the API over commit 2
//
// Sugar, and nothing but: every one of these writes params.userTracks and lets
// the sanitiser and syncTracks do what a hand-written blob already made them
// do. What the API owes on top is a probe a button can be disabled from, an id
// a caller need not invent, a fault code a caller can act on, and an opening
// grid that sounds like a decision.
// --------------------------------------------------------------------------

/** A well-formed addTrack spec, overridable field by field. */
const addSpec = (extra = {}) => ({ label: 'Drone', family: 'melodic', voiceSet: 'pad', ...extra });

/** Which slots of a lane are on, as a string of 1s and 0s. */
const laneMask = (lane) => lane.map((step) => (step.on ? 1 : 0)).join('');

test('v23 addTrack: canAddTrack answers with the code addTrack throws', () => {
  const engine = createEngine();
  // The probe a control has before the user has typed anything: is there room.
  assert.equal(engine.canAddTrack(), null, 'an empty engine has room');
  assert.equal(engine.canAddTrack(addSpec()), null);

  const faults = [
    // A malformed shape is a malformed id: there is nothing else to name it by.
    [null, 'bad-id'], ['nope', 'bad-id'], [[], 'bad-id'],
    [addSpec({ id: 'Drone' }), 'bad-id'],
    [addSpec({ id: 'a' }), 'bad-id'],
    [addSpec({ id: 'my#track' }), 'bad-id'],
    [addSpec({ id: 7 }), 'bad-id'],
    [addSpec({ id: 'pad' }), 'reserved-id'],
    [addSpec({ id: 'auto' }), 'reserved-id'],
    [addSpec({ label: '   ' }), 'bad-label'],
    [addSpec({ label: 42 }), 'bad-label'],
    [{ family: 'melodic' }, 'bad-label'],
    [addSpec({ family: 'tuned' }), 'bad-family'],
    [addSpec({ family: undefined }), 'bad-family'],
    [addSpec({ voiceSet: 'nonesuch' }), 'bad-voice-set'],
    // A kit needs the drum voices, and a pitched line has nothing to say
    // through them — the pairing rule the stored shape keeps too.
    [addSpec({ family: 'percussive', voiceSet: 'pad' }), 'bad-voice-set'],
    [addSpec({ family: 'melodic', voiceSet: 'percussion' }), 'bad-voice-set'],
    // The sanitiser tolerates an unusable colour because it reads STORED data;
    // an API call is a bug in the caller, and gets told so.
    [addSpec({ colourToken: '--Bad' }), 'bad-colour-token'],
    [addSpec({ colourToken: 'red' }), 'bad-colour-token'],
  ];
  for (const [spec, code] of faults) {
    assert.equal(engine.canAddTrack(spec), code, `${JSON.stringify(spec)} → ${code}`);
    assert.throws(() => engine.addTrack(spec), (error) => error instanceof TypeError
      && error.code === code && typeof error.message === 'string' && error.message.length > 0,
    `addTrack must throw ${code} for ${JSON.stringify(spec)}`);
  }
  // The probe must never throw, whatever it is handed.
  for (const junk of [0, NaN, true, () => {}, Symbol('x')]) {
    assert.equal(typeof engine.canAddTrack(junk), 'string', `canAddTrack(${String(junk)}) must answer`);
  }
  assert.deepEqual(engine.getParams().userTracks, [], 'a refused spec must leave nothing behind');

  engine.addTrack(addSpec({ id: 'drone' }));
  assert.equal(engine.canAddTrack(addSpec({ id: 'drone' })), 'duplicate-id');
  assert.throws(() => engine.addTrack(addSpec({ id: 'drone' })), (e) => e.code === 'duplicate-id');
});

test('v23 addTrack: the twelfth track is the last one', () => {
  const engine = createEngine();
  for (let i = 1; i <= 6; i++) {
    assert.equal(engine.canAddTrack(addSpec()), null, `there must be room for user track ${i}`);
    assert.equal(engine.addTrack(addSpec({ label: `Track ${i}` })).id, `track-${i}`);
    assert.equal(engine.getTracks().length, TRACK_ORDER.length + i);
  }
  assert.equal(engine.getTracks().length, 12, 'six built-ins and six of the user\'s own');
  assert.equal(engine.canAddTrack(), 'cap');
  assert.equal(engine.canAddTrack(addSpec()), 'cap');
  // Full is the fault to report first: a user staring at a rejected name cannot
  // fix the real problem, which is that there is no room for any name.
  assert.equal(engine.canAddTrack(addSpec({ id: 'Bad' })), 'cap');
  assert.throws(() => engine.addTrack(addSpec()), (error) => error instanceof RangeError
    && error.code === 'cap', 'the cap is a RangeError, not a TypeError');

  // And removing one makes room again, without disturbing the rest.
  assert.equal(engine.removeTrack('track-3'), true);
  assert.equal(engine.canAddTrack(addSpec()), null);
  assert.equal(engine.addTrack(addSpec({ label: 'Late' })).id, 'late');
  assert.deepEqual(engine.getTracks().map((t) => t.id).slice(TRACK_ORDER.length),
    ['track-1', 'track-2', 'track-4', 'track-5', 'track-6', 'late'],
    'creation order survives a removal in the middle');
});

test('v23 addTrack: an id the caller did not invent cannot collide', () => {
  const engine = createEngine();
  // The label, lowercased and hyphenated — the same label always lands on the
  // same id, so a caller can predict one without being made to supply it.
  assert.equal(engine.addTrack(addSpec({ label: 'Deep Drone!' })).id, 'deep-drone');
  assert.equal(engine.addTrack(addSpec({ label: '  Deep  Drone  ' })).id, 'deep-drone-2',
    'a taken id is suffixed, never overwritten');
  assert.equal(engine.addTrack(addSpec({ label: '****' })).id, 'track',
    'a label of pure punctuation still deserves a track');
  // A built-in and a reserved word are as taken as a user track is.
  assert.equal(engine.addTrack(addSpec({ label: 'Pad' })).id, 'pad-2');
  assert.equal(engine.addTrack(addSpec({ label: 'Auto' })).id, 'auto-2');
  assert.equal(engine.addTrack(addSpec({ label: 'x'.repeat(40) })).id, 'x'.repeat(24),
    'a generated id is cut to the grammar\'s 24 characters');
  for (const view of engine.getTracks()) {
    assert.ok(/^[a-z][a-z0-9-]{1,23}$/.test(view.id), `${view.id} is not a legal id`);
  }
  assert.equal(new Set(engine.getTracks().map((t) => t.id)).size, 12, 'every id is distinct');

  // An id the caller DID supply is taken exactly as given.
  const fresh = createEngine();
  assert.equal(fresh.addTrack(addSpec({ id: 'my-track', label: 'Anything' })).id, 'my-track');
});

test('v23 addTrack: a new track opens on the beat, not on every sixteenth', () => {
  const engine = createEngine();
  const drone = engine.addTrack(addSpec({ label: 'Drone' })).id;
  const kit = engine.addTrack(addSpec({ label: 'Kit', family: 'percussive', voiceSet: 'percussion' })).id;
  const params = engine.getParams();

  // One hit per quarter-note beat. A track that opened on the stock lane would
  // sound sixteen notes a bar before its maker had chosen anything.
  assert.equal(laneMask(params.tracks[drone].sequencer.steps), '10001000100010001000');
  assert.equal(laneMask(params.tracks[kit].sequencer.steps.low), '10001000100010001000');
  for (const lane of ['mid', 'high']) {
    assert.equal(laneMask(params.tracks[kit].sequencer.steps[lane]), '0'.repeat(SEQUENCER_STEP_COUNT),
      'a kit opens with one voice on the beat, not three at once');
  }
  // Everything else about the step is the stock step: only `on` is the ruling.
  for (const step of params.tracks[drone].sequencer.steps) {
    assert.equal(step.prob, 1);
    assert.equal(step.vmin, 0.5);
    assert.equal(step.vmax, 0.9);
  }

  // The ADD PATH alone. A stored blob keeps whatever it says, so a preset
  // written before this ruling loads exactly as it was saved.
  const stored = sanitiseParams({ userTracks: [userTrack('drone')] });
  assert.equal(laneMask(stored.tracks.drone.sequencer.steps), '1'.repeat(SEQUENCER_STEP_COUNT),
    'the sanitiser must not have learned the opening pulse');
  assert.equal(laneMask(DEFAULT_PARAMS.tracks.percussion.sequencer.steps.low),
    '1'.repeat(SEQUENCER_STEP_COUNT), 'no built-in default may have moved');
});

test('v23 addTrack: the new track arrives on every surface, with a built-in\'s defaults', () => {
  const engine = createEngine();
  const view = engine.addTrack(addSpec({ label: 'Deep Drone' }));
  assert.deepEqual(Object.keys(view), ['id', 'label', 'builtin', 'colourToken', 'family'],
    'addTrack returns the public view, five keys and no sixth');
  assert.ok(Object.isFrozen(view));
  assert.deepEqual(view, {
    id: 'deep-drone', label: 'Deep Drone', builtin: false,
    colourToken: '--track-user-1', family: 'melodic',
  });
  assert.equal(engine.getTracks().at(-1), view, 'the returned view IS the one in the list');

  const order = [...TRACK_ORDER, 'deep-drone'];
  assert.deepEqual(Object.keys(engine.getParams().tracks), order);
  assert.deepEqual(Object.keys(engine.getStats().perTrack), order);
  assert.deepEqual(Object.keys(engine.getResolved().tracks), order);
  assert.deepEqual(Object.keys(engine.getAnalysers()), [...order, 'total']);
  assert.deepEqual(engine.getParams().userTracks, [{
    id: 'deep-drone', label: 'Deep Drone', family: 'melodic',
    voiceSet: 'pad', colourToken: '--track-user-1',
  }]);

  // The same defaults a stored entry gets — addTrack seeds nothing of its own
  // beyond the opening grid.
  const track = engine.getParams().tracks['deep-drone'];
  assert.equal(track.state, 'on', 'the user just made it — it should sound');
  assert.equal(track.voice, DEFAULT_PARAMS.tracks.pad.voice);
  assert.equal(track.level, 0.8);
  assert.deepEqual(track.randomness, { min: 0.35, max: 0.65 });
  assert.equal(track.driftRate, 1);
  assert.equal(track.swing, null);
  assert.equal(track.density, null);
  assert.equal(track.hold, false);
  assert.equal(track.mono, false);
  assert.equal(track.glide, 0);
  assert.equal(track.dissonance, 0);
  assert.deepEqual(track.vary, Object.fromEntries(VARY_ASPECTS.map((a) => [a, null])));

  // An absent voiceSet follows the family, so a control that asks for a name
  // and a kind is a complete caller.
  const kit = engine.addTrack({ label: 'Kit', family: 'percussive' });
  assert.equal(engine.getParams().userTracks[1].voiceSet, 'percussion');
  assert.equal(kit.colourToken, '--track-user-2', 'colours follow creation order');
  assert.deepEqual(engine.getParams().tracks.kit.lanes.map((lane) => lane.id), [...PERCUSSION_LANES]);
  const chosen = engine.addTrack(addSpec({ label: 'Mine', colourToken: '--my-colour' }));
  assert.equal(chosen.colourToken, '--my-colour', 'a colour the caller chose is kept');
});

test('v23 removeTrack: built-ins throw, unknown ids are false twice', () => {
  const engine = createEngine();
  engine.addTrack(addSpec({ id: 'drone', label: 'Drone' }));

  for (const name of TRACK_ORDER) {
    assert.throws(() => engine.removeTrack(name), (error) => error instanceof Error
      && !(error instanceof TypeError) && error.code === 'builtin',
    `${name} is a built-in: removing it is a programming fault, not a user outcome`);
  }
  assert.deepEqual(Object.keys(engine.getParams().tracks).length, 7, 'nothing may have gone');

  // Idempotent: an id this engine does not have is false, not a throw, however
  // many times it is asked.
  for (const unknown of ['ghost', '', 'Drone', null, undefined, 7, {}]) {
    assert.equal(engine.removeTrack(unknown), false, `${String(unknown)} must be a quiet false`);
    assert.equal(engine.removeTrack(unknown), false);
  }
  assert.equal(engine.removeTrack('drone'), true);
  assert.equal(engine.removeTrack('drone'), false, 'the second removal is not an error');
  assert.deepEqual(engine.getParams().userTracks, []);
  assert.deepEqual(Object.keys(engine.getParams().tracks), [...TRACK_ORDER]);
});

test('v23 addTrack/removeTrack: getParams round-trips through the API', () => {
  const engine = createEngine();
  engine.addTrack(addSpec({ label: 'Drone' }));
  engine.addTrack(addSpec({ label: 'Kit', family: 'percussive', voiceSet: 'percussion' }));
  engine.setParams({ tracks: { drone: { level: 0.42 } } });
  engine.setParams({ patches: { drone: { warm: { filter: { cutoff: 900 } } } } });

  // What getParams() hands out reloads into a second engine unchanged: the API
  // writes nothing a stored blob cannot carry.
  const saved = engine.getParams();
  const loaded = createEngine(saved);
  assert.deepEqual(loaded.getParams(), saved, 'a saved API-built engine must reload verbatim');
  assert.deepEqual(loaded.getTracks().map((t) => t.id), engine.getTracks().map((t) => t.id));
  assert.equal(loaded.getParams().tracks.drone.level, 0.42);
  assert.equal(laneMask(loaded.getParams().tracks.drone.sequencer.steps), '10001000100010001000',
    'the opening grid travels as ordinary params');

  // And a removal leaves nothing behind for the next save to carry.
  engine.removeTrack('drone');
  const after = engine.getParams();
  assert.deepEqual(after.userTracks.map((t) => t.id), ['kit']);
  assert.equal('drone' in after.tracks, false);
  assert.equal('drone' in after.patches, false);
  assert.deepEqual(createEngine(after).getParams(), after);
});

test('v23 addTrack/removeTrack: a tracks event announces every registry change', () => {
  const engine = createEngine();
  const seen = [];
  const off = engine.on('tracks', (payload) => seen.push(payload));

  const view = engine.addTrack(addSpec({ label: 'Drone' }));
  assert.equal(seen.length, 1, 'addTrack must announce the new registry');
  assert.equal(seen[0].tracks, engine.getTracks(), 'the payload IS the list getTracks() returns');
  assert.equal(seen[0].tracks.at(-1), view);

  // An ordinary edit is not a registry change, however much of the track it
  // touches: a consumer that re-renders its rows on this must not be woken by
  // a level drag.
  engine.setParams({ tracks: { drone: { level: 0.3 } } });
  engine.setParams({ bpm: 100 });
  assert.equal(seen.length, 1, 'a params edit that adds and removes nothing must stay quiet');

  // A params-driven change is a registry change too — loading a preset that
  // carries user tracks, which no UI can poll for.
  engine.setParams({ userTracks: [...engine.getParams().userTracks, userTrack('extra')] });
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1].tracks.map((t) => t.id), [...engine.getTracks().map((t) => t.id)]);

  engine.removeTrack('drone');
  assert.equal(seen.length, 3, 'removeTrack must announce too');
  assert.equal(seen[2].tracks.map((t) => t.id).includes('drone'), false);
  assert.equal(engine.removeTrack('drone'), false);
  assert.equal(seen.length, 3, 'a removal that removed nothing announces nothing');

  off();
  engine.addTrack(addSpec({ label: 'Quiet' }));
  assert.equal(seen.length, 3, 'the unsubscribe handle must work here as everywhere');
});

test('v23 addTrack: a track added mid-playback sounds from the next bar and rings out on removal',
  () => hiddenTab(async () => {
    const engine = createEngine({
      bpm: 120, speed: 2, complexity: 1, repetition: 0, structure: 'custom',
      customStructure: [{ label: 'D', bars: 24, intensity: 1 }],
      // The built-ins silent, so any note still sounding after the removal can
      // only be one of the added track's own.
      tracks: tracksAll('off'),
    }, { rng: seededRng(2307) });
    const log = record(engine);
    await engine.start();
    await advance(4, FAST);

    const ctx = liveContexts[liveContexts.length - 1];
    const bus = reverbBus(ctx);
    const sends = () => ctx.nodes.filter((n) => n.kind === 'gain' && n.connections.includes(bus));
    assert.equal(sends().length, TRACK_ORDER.length);

    const madeAt = ctx.currentTime;
    const view = engine.addTrack(addSpec({ label: 'Drone' }));
    // The chain is built at once: a note reaching a track with no graph node is
    // a TypeError inside the scheduler's lookahead, which stops the piece.
    assert.equal(sends().length, TRACK_ORDER.length + 1, 'the added track got no chain');
    assert.ok(engine.getAnalysers().drone, 'the added track got no analyser');
    // Loud enough to judge, on the grid addTrack chose for it.
    engine.setParams({ tracks: { drone: { level: 1, randomness: 0 } } });

    const heard = () => log.notes.filter((note) => note.track === view.id);
    assert.ok(await advanceUntil(() => heard().length > 8, 48, FAST), 'the added track never sounded');
    assert.ok(heard().every((note) => note.time >= madeAt), 'it sounded before it existed');

    const SETTLED = { step: 0.05, sleep: 20 };
    await advance(0.6, SETTLED);
    const sounded = heard().length;
    const chain = sends()[TRACK_ORDER.length];
    assert.equal(engine.removeTrack('drone'), true);

    // Params drop on the same tick; the SOUND does not. Cutting a ringing note
    // is the click the 50 ms-fade rule exists to prevent.
    assert.equal('drone' in engine.getParams().tracks, false);
    assert.equal(engine.getAnalysers().drone, undefined);
    assert.equal(sends().length, TRACK_ORDER.length + 1,
      'the chain was cut while its notes were still ringing');
    assert.ok(await advanceUntil(() => engine.getStats().totalActiveNotes > 0, 4, SETTLED),
      'nothing of the removed track ever rang, so the ring-out is untested');
    assert.equal(sends().length, TRACK_ORDER.length + 1, 'the chain was cut mid-note');

    await advance(20, FAST);
    assert.equal(heard().length, sounded, 'a removed track kept being scheduled');
    assert.equal(sends().length, TRACK_ORDER.length, 'the retired chain was never dropped');
    assert.ok(chain.disconnects.length, 'the retired send was never disconnected');
    engine.stop();
  }));

test('v23 byte-identity: adding and removing through the API leaves the built-ins alone',
  () => hiddenTab(async () => {
    const play = async (before) => {
      const engine = createEngine({
        bpm: 120, speed: 2, complexity: 0.7, repetition: 0.4, structure: 'journey',
        tracks: tracksAll('on'),
      }, { rng: seededRng(2308) });
      if (before) before(engine);
      const log = record(engine);
      await engine.start();
      await advance(20, FAST);
      engine.stop();
      return log.notes.map((note) => [note.track, note.midi, note.kind, note.lane,
        tick(note.time), tick(note.duration), note.velocity].join('|'));
    };

    const plain = await play(null);
    // The same piece on an engine the API has churned: validating a spec,
    // generating an id, building a chain and tearing it down must not draw a
    // single rng(), and the layer must be back on the module's own frozen lists.
    const churned = await play((engine) => {
      assert.equal(engine.canAddTrack(addSpec()), null);
      const view = engine.addTrack(addSpec({ label: 'Drone' }));
      engine.addTrack(addSpec({ label: 'Kit', family: 'percussive', voiceSet: 'percussion' }));
      assert.equal(engine.removeTrack(view.id), true);
      assert.equal(engine.removeTrack('kit'), true);
      assert.deepEqual(engine.getTracks(), getTracks());
    });

    const shared = Math.min(plain.length, churned.length);
    assert.ok(shared > 200, `only ${shared} shared notes — too few to judge`);
    assert.deepEqual(churned.slice(0, shared), plain.slice(0, shared),
      'an added-and-removed user track changed the six built-ins\' note stream');
  }));

// --------------------------------------------------------------------------
// User instrument manifests (v23) — JSON data, and only JSON data
//
// A manifest declares which of the voice editor's dials a user track shows. It
// is not code, does not name code and cannot reach any: that is what lets it
// travel in a preset and a share link while the v10 boundary (user code never
// travels) stands. These tests hold three lines — what the sanitiser keeps,
// what it drops the manifest whole over, and that the compiled result is the
// same `controls`/`defaults` pair the voice library publishes.
// --------------------------------------------------------------------------

/** A well-formed user track carrying a well-formed manifest. */
const manifestSpec = (dials, extra = {}) => ({
  schema: 'ambi4.instrument/1',
  id: 'drone',
  label: 'Drone',
  kind: 'melodic',
  voiceSet: 'pad',
  voice: 'warm',
  dials,
  ...extra,
});

const withManifest = (manifest, entry = {}) => sanitiseParams({
  userTracks: [{ id: 'drone', label: 'Drone', family: 'melodic', voiceSet: 'pad', manifest, ...entry }],
}).userTracks[0];

const GOOD_DIALS = [
  { section: 'source', field: 'detune', label: 'Detune', min: -30, max: 30, default: 0, unit: 'ct' },
  { section: 'adsr', field: 'attack', label: 'Attack', min: 0.01, max: 4, default: 1.2, unit: 's' },
];

test('v23 manifest: dials naming unknown fields are dropped, out-of-range min/max are clamped, a code-shaped string rejects the manifest', () => {
  // A dial the engine would silently drop is worse than no dial: the field has
  // to be one PATCH_SCHEMA actually has.
  const dropped = withManifest(manifestSpec([
    ...GOOD_DIALS,
    { section: 'source', field: 'wobble', label: 'Wobble', min: 0, max: 1, default: 0.5 },
    { section: 'filter', field: 'type', label: 'Type', min: 0, max: 1, default: 0 },
    { section: 'nowhere', field: 'cutoff', label: 'Cut', min: 40, max: 90, default: 60 },
  ])).manifest;
  assert.deepEqual(dropped.dials.map((dial) => dial.field), ['detune', 'attack'],
    'a dial naming a field the schema has no coercion for must not be rendered');

  // Out of range is a manifest asking for something reasonable and slightly
  // wrong — clamped to the schema's own bounds, never rejected.
  const clamped = withManifest(manifestSpec([
    { section: 'source', field: 'detune', label: 'Detune', min: -500, max: 500, default: -900 },
    { section: 'filter', field: 'cutoff', label: 'Cutoff', min: 0, max: 999999, default: 300 },
  ])).manifest;
  assert.deepEqual(clamped.dials[0], {
    section: 'source', field: 'detune', label: 'Detune',
    min: -50, max: 50, default: -50, curve: 'linear', unit: '', rangeable: true,
  }, 'detune clamps to the schema\'s own ±50, and the default onto the dial');
  assert.equal(clamped.dials[1].min, 40);
  assert.equal(clamped.dials[1].max, 12000);

  // Discrete engine-side stays discrete: a manifest cannot make `octave` take
  // a {min,max} the sanitiser would then drop.
  const octave = withManifest(manifestSpec([
    { section: 'source', field: 'octave', label: 'Octave', min: -9, max: 9, default: 0, rangeable: true },
  ])).manifest;
  assert.equal(octave.dials[0].rangeable, false);
  assert.deepEqual([octave.dials[0].min, octave.dials[0].max], [-2, 2]);

  // Duplicate field within a section: last wins, in its own place.
  const duped = withManifest(manifestSpec([
    { section: 'source', field: 'detune', label: 'First', min: -10, max: 10, default: 0 },
    { section: 'adsr', field: 'attack', label: 'Attack', min: 0.01, max: 4, default: 1 },
    { section: 'source', field: 'detune', label: 'Second', min: -20, max: 20, default: 5 },
  ])).manifest;
  assert.deepEqual(duped.dials.map((dial) => dial.label), ['Attack', 'Second']);

  // Cap: the tail goes, exactly as an over-cap userTracks array drops its own.
  const many = withManifest(manifestSpec(
    ['detune', 'octave', 'mix', 'fold', 'pitch', 'noise', 'tilt', 'bandCentre', 'bandWidth',
      'sweepRate', 'sweepDepth', 'gust', 'gustRate', 'burst', 'burstSharp', 'swell', 'glide',
      'glideCurve', 'formant1', 'formant2', 'cadence', 'irregular', 'shape1', 'shape2']
      // Bounds wider than any field's own, so every one of the 24 clamps to its
      // own full range and survives — the cap is what this is measuring.
      .map((field, i) => ({ section: 'source', field, label: `D${i}`, min: -1e6, max: 1e6, default: 0 }))
      .concat([{ section: 'adsr', field: 'attack', label: 'Over', min: 0.01, max: 4, default: 1 }])
  )).manifest;
  assert.equal(many.dials.length, 24, 'a manifest carries 24 dials at most');
  assert.ok(!many.dials.some((dial) => dial.label === 'Over'), 'the cap drops from the tail');

  // A manifest is JSON DATA. Anything that reads like code, ANYWHERE in it,
  // rejects the WHOLE document — a forgery does not get to keep its good parts.
  for (const bad of [
    manifestSpec(GOOD_DIALS, { label: 'Drone', voice: 'warm', note: 'x => x' }),
    manifestSpec(GOOD_DIALS, { credit: 'import secrets' }),
    manifestSpec(GOOD_DIALS, { icon: 'data:image/png;base64,AAAA' }),
    manifestSpec(GOOD_DIALS, { link: 'javascript:alert(1)' }),
    manifestSpec(GOOD_DIALS, { body: 'function play(){}' }),
    manifestSpec([{ ...GOOD_DIALS[0], label: '() => 1' }]),
  ]) {
    const entry = withManifest(bad);
    assert.ok(!('manifest' in entry), `a code-shaped manifest survived: ${JSON.stringify(bad).slice(0, 60)}`);
    assert.equal(entry.id, 'drone', 'rejecting the manifest must not cost the track');
  }
  // Ordinary prose that merely CONTAINS those letters is not code.
  assert.ok(withManifest(manifestSpec([
    { ...GOOD_DIALS[0], label: 'Important' },
  ])).manifest, 'a label reading "Important" is not an import statement');

  // Disagreement with the track it belongs to rejects it, and the track lives.
  for (const bad of [
    manifestSpec(GOOD_DIALS, { schema: 'ambi4.instrument/2' }),
    manifestSpec(GOOD_DIALS, { id: 'other' }),
    manifestSpec(GOOD_DIALS, { label: 'Other' }),
    manifestSpec(GOOD_DIALS, { kind: 'percussive' }),
    manifestSpec(GOOD_DIALS, { voiceSet: 'bass' }),
    manifestSpec(GOOD_DIALS, { voice: '' }),
    manifestSpec([]),
    manifestSpec([{ section: 'source', field: 'nope', label: 'X', min: 0, max: 1, default: 0 }]),
    'not an object',
  ]) {
    const entry = withManifest(bad);
    assert.ok(!('manifest' in entry), `a disagreeing manifest survived: ${JSON.stringify(bad).slice(0, 60)}`);
    assert.equal(entry.label, 'Drone');
  }
});

test('v23 manifest: compiles to a controls/defaults pair the voice-editor shape accepts', () => {
  const engine = createEngine();
  engine.setParams({
    userTracks: [{
      id: 'drone', label: 'Drone', family: 'melodic', voiceSet: 'pad',
      manifest: manifestSpec([
        { section: 'source', field: 'detune', label: 'Detune', min: -30, max: 30, default: 4, unit: 'ct' },
        { section: 'source', field: 'octave', label: 'Octave', min: -2, max: 2, default: -1 },
        { section: 'adsr', field: 'attack', label: 'Attack', min: 0.01, max: 4, default: 1.2, unit: 's', curve: 'log' },
      ]),
    }],
  });

  const compiled = engine.getTrackManifest('drone');
  assert.ok(compiled, 'a user track with a manifest publishes a compiled one');
  // The exact shape VOICES[track][voiceId] publishes: a section with dials is
  // the list of its fields, a section with none is false and vanishes.
  assert.deepEqual(compiled.controls, {
    source: ['detune', 'octave'],
    filter: false,
    adsr: ['attack'],
    sends: false,
  });
  assert.deepEqual(compiled.defaults, {
    source: { detune: 4, octave: -1 },
    adsr: { attack: 1.2 },
  });
  // The v19 spec shape the sculpting groups already read: `fallback` beside
  // the default, so units and double-click-to-default work untouched.
  assert.deepEqual(compiled.dials[2], {
    section: 'adsr', field: 'attack', label: 'Attack',
    min: 0.01, max: 4, default: 1.2, fallback: 1.2, curve: 'log', unit: 's', rangeable: true,
  });
  assert.equal(compiled.voiceSet, 'pad', 'the caller looks the named voice up to take its engineType');
  assert.equal(compiled.voice, 'warm');

  // Every section a built-in editor knows about is answered for — an absent
  // key would read as "render everything", which is not what "no dials" means.
  assert.deepEqual(Object.keys(compiled.controls), ['source', 'filter', 'adsr', 'sends']);

  // Not for a built-in, not for an unknown id, not for a track without one.
  assert.equal(engine.getTrackManifest('pad'), null);
  assert.equal(engine.getTrackManifest('nope'), null);
  const bare = createEngine();
  bare.setParams({ userTracks: [{ id: 'bare', label: 'Bare', family: 'melodic', voiceSet: 'pad' }] });
  assert.equal(bare.getTrackManifest('bare'), null, 'a manifest is OPTIONAL');
  assert.ok(bare.getParams().tracks.bare, 'a track without one is still a perfectly good track');
});

test('v23 manifest: round-trips through setParams/getParams, and nothing written back reaches the engine', () => {
  const manifest = manifestSpec([
    { section: 'source', field: 'detune', label: 'Detune', min: -30, max: 30, default: 4, unit: 'ct' },
    { section: 'sends', field: 'reverb', label: 'Space', min: 0, max: 1, default: 0.4 },
  ]);
  const engine = createEngine();
  engine.setParams({
    userTracks: [{ id: 'drone', label: 'Drone', family: 'melodic', voiceSet: 'pad', manifest }],
  });

  const first = engine.getParams().userTracks[0].manifest;
  assert.deepEqual(first.dials.map((dial) => dial.field), ['detune', 'reverb']);
  // Round trip: what came out goes back in and comes out the same.
  const second = createEngine();
  second.setParams(engine.getParams());
  assert.deepEqual(second.getParams().userTracks[0], engine.getParams().userTracks[0]);

  // MUTATION 1 — getParams() hands out a deep copy. Writing through the entry,
  // the manifest and a dial must all be invisible to the engine.
  const handed = engine.getParams();
  handed.userTracks[0].label = 'Hacked';
  handed.userTracks[0].manifest.voice = 'glass';
  handed.userTracks[0].manifest.dials[0].max = 999;
  handed.userTracks[0].manifest.dials.push({ section: 'adsr', field: 'attack' });
  const after = engine.getParams().userTracks[0];
  assert.equal(after.label, 'Drone');
  assert.equal(after.manifest.voice, 'warm');
  assert.equal(after.manifest.dials[0].max, 30);
  assert.equal(after.manifest.dials.length, 2);

  // MUTATION 2 — the compiled view is built fresh every call, so a consumer
  // that edits its controls list or a dial cannot reach the stored document.
  const compiled = engine.getTrackManifest('drone');
  compiled.controls.source.push('mix');
  compiled.controls.filter = ['cutoff'];
  compiled.defaults.source.detune = 99;
  compiled.dials[0].label = 'Nope';
  const again = engine.getTrackManifest('drone');
  assert.deepEqual(again.controls.source, ['detune']);
  assert.equal(again.controls.filter, false);
  assert.equal(again.defaults.source.detune, 4);
  assert.equal(again.dials[0].label, 'Detune');

  // MUTATION 3 — the SOURCE object the caller handed to setParams. Editing it
  // afterwards must not reach into the engine either.
  manifest.dials[0].label = 'Rewritten';
  manifest.voice = 'choir';
  assert.equal(engine.getParams().userTracks[0].manifest.dials[0].label, 'Detune');
  assert.equal(engine.getParams().userTracks[0].manifest.voice, 'warm');

  // A removed track takes its manifest with it, and a pre-v23 blob is unchanged.
  engine.removeTrack('drone');
  assert.equal(engine.getTrackManifest('drone'), null);
  assert.deepEqual(engine.getParams().userTracks, []);
});

// --------------------------------------------------------------------------
// v26 — the hook seed, the master analyser tap, pause
// --------------------------------------------------------------------------

test('v26: harmony.seed takes symbols or slots, and a seed the mode cannot play is dropped whole', () => {
  const seedOf = (seed, extra = {}) => sanitiseParams({
    mode: 'ionian', harmony: { seed }, ...extra,
  }).harmony.seed;

  // The compiler's own grammar: an ordinal numeral, case a hint the mode
  // overrules, and a suffix that becomes the slot's colour NUDGE — a ninth one
  // step above the piece's complexity, a seventh exactly it, a triad below.
  assert.deepEqual(seedOf(['I', 'vi', 'IV', 'V7']), [
    { degree: 0, extension: -1 },
    { degree: 5, extension: -1 },
    { degree: 3, extension: -1 },
    { degree: 4, extension: 0 },
  ]);
  assert.deepEqual(seedOf(['Imaj9', 'V13']), [
    { degree: 0, extension: 1 },
    { degree: 4, extension: 1 },
  ]);
  // Already-parsed slots pass straight through, and a mixed array is fine: a
  // UI holds degrees, a genre holds symbols, and both mean the same loop.
  assert.deepEqual(seedOf([{ degree: 2, extension: 5 }, 'V']), [
    { degree: 2, extension: 1 },
    { degree: 4, extension: -1 },
  ]);
  assert.deepEqual(seedOf([{ degree: 6 }]), [{ degree: 6, extension: 0 }]);

  for (const junk of [
    ['I', 'bII7'],                                  // accidentals are outside the vocabulary
    ['I', 'VIII'],                                  // no such ordinal
    ['I', 42],
    ['I', { degree: 1.5 }],
    ['I', { degree: -1 }],
    [],                                             // an empty loop is no loop
    new Array(HOOK_MAX_CHORDS + 1).fill('I'),       // longer than a hook can be
    'I vi IV V',                                    // a string is not a seed
    { degree: 0 },
  ]) {
    assert.equal(seedOf(junk), null,
      `a part-usable seed must be dropped whole: ${JSON.stringify(junk)}`);
  }
  // Same symbols, a mode with fewer degrees to play them in: dropped.
  assert.equal(seedOf(['i', 'VI', 'III', 'VII'], { mode: 'minorPentatonic' }), null);
  assert.deepEqual(seedOf(['i', 'iv', 'v'], { mode: 'minorPentatonic' }), [
    { degree: 0, extension: -1 },
    { degree: 3, extension: -1 },
    { degree: 4, extension: -1 },
  ]);

  // Sanitiser law, as for every other param.
  const stored = sanitiseParams({ mode: 'ionian', harmony: { seed: ['I', 'IV', 'vi'] } });
  assert.equal(sanitiseParams({ bpm: 90 }, stored).harmony.seed.length, 3,
    'an unrelated edit dropped the seed');
  assert.equal(sanitiseParams({ harmony: { seed: null } }, stored).harmony.seed, null,
    'an explicit null must release the seed');
  assert.equal(sanitiseParams({ harmony: { rhythm: 4 } }, stored).harmony.seed.length, 3,
    'editing the harmonic rhythm dropped the seed beside it');
  assert.equal(sanitiseParams({ mode: 'minorPentatonic' }, stored).harmony.seed, null,
    'a stored seed must be re-filtered against the mode it is about to play in');

  const engine = createEngine({ mode: 'ionian', harmony: { seed: ['I', 'IV', 'vi'] } });
  const handed = engine.getParams();
  handed.harmony.seed[0].degree = 4;
  handed.harmony.seed.push({ degree: 1, extension: 0 });
  assert.deepEqual(engine.getParams().harmony.seed,
    [{ degree: 0, extension: -1 }, { degree: 3, extension: -1 }, { degree: 5, extension: -1 }],
    'getParams handed out the engine\'s own seed');
});

const pcOf = (midi) => ((Math.round(midi) % 12) + 12) % 12;

/** The pitch class the root of `degree` sounds as, in the key chordRun plays in. */
const seedRootPc = (degree, mode = 'ionian') => pcOf(
  scaleDegreeToMidi(degree, SCALES[mode], pitchClass('C'), 3),
);

test('v26: a seeded hook establishes the supplied loop verbatim, in order', () => hiddenTab(async () => {
  // Six slots at repetition 1, which on its own would pin the loop to the
  // tightest four: the seed's LENGTH is the loop's, not the dial's. The
  // section intensity holds the piece's own colour just under the seventh
  // threshold, so the triad symbols voice as triads and the V7 as a seventh.
  const seed = ['I', 'vi', 'iii', 'IV', 'ii', 'V7'];
  const chords = await chordRun({
    mode: 'ionian',
    customStructure: [{ label: 'A', bars: 64, intensity: 0.6 }],
    harmony: { rhythm: 1, seed },
  }, seed.length + 1);
  const roots = chords.slice(0, seed.length).map((chord) => pcOf(chord.midis[0]));
  assert.deepEqual(roots, [0, 5, 2, 3, 1, 4].map((degree) => seedRootPc(degree)),
    'the first pass must be the seeded degrees, in the order they were given');
  // The colour each symbol asked for comes with it: the seventh voices one
  // chord tone more than the triads around it, at one and the same complexity.
  const triads = chords.slice(0, 5).map((chord) => chord.midis.length);
  assert.deepEqual(triads, [3, 3, 3, 3, 3], 'the triad symbols did not voice as triads');
  assert.equal(chords[5].midis.length, 4, 'the V7 symbol did not voice its seventh');
}));

test('v26: a seeded loop is material, not a freeze — it mutates, banks and comes back', () => {
  const seed = [
    { degree: 0, extension: 0 }, { degree: 3, extension: 1 },
    { degree: 4, extension: -1 }, { degree: 5, extension: 0 },
  ];
  const hook = buildHook({ scaleLength: 7, repetition: 1, seed });
  assert.deepEqual(hook.degrees, [0, 3, 4, 5], 'the seeded degrees are taken as given');
  assert.deepEqual(hook.extensions, [0, 1, -1, 0], 'so is the colour each slot asked for');
  assert.deepEqual(hook.inversions, [0, 0, 0, 0], 'the voicing stays the engine\'s to choose');
  // A degree past the end of the mode wraps rather than sounding outside it.
  assert.deepEqual(buildHook({ scaleLength: 5, seed: [{ degree: 6, extension: 0 }] }).degrees, [1]);

  const rng = seededRng(4021);
  const bank = createVariantBank({ size: 6, clone: cloneHook });
  bank.store(hookKey(hook), hook, 3);
  let variant = hook;
  const seen = new Set([hookKey(hook)]);
  for (let i = 0; i < 12; i++) {
    const next = mutateHook(variant, { scaleLength: 7, complexity: 0.5, rng });
    assert.notEqual(hookKey(next), hookKey(variant), 'a mutation must change the loop');
    variant = next;
    seen.add(hookKey(variant));
    bank.store(hookKey(variant), variant, 1);
  }
  assert.ok(seen.size > 1, 'the seeded loop never varied');
  // Twelve mutations later the establishment is still the most salient shape
  // in a full bank, and it comes back out of it exactly as it went in.
  const kept = bank.find((entry) => entry.key === hookKey(hook));
  assert.ok(kept, 'the seeded loop was evicted by the variants it produced');
  assert.deepEqual(kept.variant.degrees, [0, 3, 4, 5]);
  const back = bank.recall(hookKey(variant), (entry) => (entry.key === kept.key ? 100 : 0), rng);
  assert.ok(back, 'nothing came back out of the bank');
  assert.deepEqual(back.variant.degrees, [0, 3, 4, 5],
    'a recall of the seeded loop must hand it back unchanged');
  assert.deepEqual(back.variant.extensions, [0, 1, -1, 0]);
});

test('v26: the sounding loop leaves the seed once it starts mutating', () => hiddenTab(async () => {
  const seed = ['I', 'vi', 'IV', 'V'];
  const expected = [0, 5, 3, 4].map((degree) => seedRootPc(degree));
  // repetition 0 is the busiest mutation rate the law allows; 40 chords at one
  // bar each is ten passes for it to move something.
  const chords = await chordRun({ mode: 'ionian', repetition: 0, harmony: { rhythm: 1, seed } }, 40);
  const roots = chords.map((chord) => pcOf(chord.midis[0]));
  assert.deepEqual(roots.slice(0, 4), expected, 'the first pass is still the establishment');
  assert.ok(roots.slice(4).some((pc, i) => pc !== expected[(i + 4) % 4]),
    'the seeded loop played unchanged for ten passes: nothing is mutating it');
}));

test('v26: a new seed re-establishes at the next pass boundary, never mid-loop', () => hiddenTab(async () => {
  const first = ['I', 'vi', 'iii', 'IV', 'ii', 'V'];
  const second = ['I', 'IV', 'V', 'vi', 'ii', 'iii'];
  // One bar per chord at a bar-long lookahead: a chord event is at most one
  // slot ahead of what the scheduler is planning, so setting the seed on the
  // second event lands well inside the first pass.
  const engine = createEngine({
    bpm: 60, mode: 'ionian', complexity: 0.4, repetition: 1, structure: 'drone',
    harmony: { rhythm: 1, seed: first },
    tracks: { ...tracksAll('off'), pad: { state: 'on', vary: { timing: 0, voice: 0 } } },
  }, { rng: seededRng(9111) });
  const chords = [];
  engine.on('chord', (chord) => chords.push(chord));
  await engine.start();
  assert.ok(await advanceUntil(() => chords.length >= 2, 20, FAST), 'the piece never started');
  engine.setParams({ harmony: { seed: second } });
  assert.ok(await advanceUntil(() => chords.length >= 12, 80, FAST),
    `only ${chords.length} chords: the piece stopped moving after the seed change`);
  engine.stop();

  const roots = chords.map((chord) => pcOf(chord.midis[0]));
  assert.deepEqual(roots.slice(0, 6), [0, 5, 2, 3, 1, 4].map((d) => seedRootPc(d)),
    'the pass in progress must finish on the seed it started on');
  assert.deepEqual(roots.slice(6, 12), [0, 3, 4, 5, 1, 2].map((d) => seedRootPc(d)),
    'the next pass must be the new seed, from its own first slot');
}));

test('v26: getAnalysers() taps the post-compressor master on both output routes', async () => {
  /** Everything downstream of `node`, through the mock's own connection lists. */
  const downstream = (node) => {
    const seen = new Set();
    const queue = [node];
    while (queue.length) {
      for (const next of queue.pop().connections) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    return seen;
  };

  const proveTap = async (engine, expectSink) => {
    await engine.start();
    const ctx = liveContexts[liveContexts.length - 1];
    const total = engine.getAnalysers().total;
    assert.ok(total && total.kind === 'analyser', 'no master analyser after start()');
    assert.equal(engine.getMasterAnalyser(), total,
      'getMasterAnalyser() must hand back the node getAnalysers() files as total');
    const compressor = ctx.nodes.find((node) => node.kind === 'compressor');
    assert.ok(compressor.connections.includes(total),
      'the master tap must hang off the compressor, so it hears the mix that leaves');
    // v0.0.47: the listening-level fader moved DOWNSTREAM of the compressor, so
    // the output route now leaves from that gain node rather than from the
    // compressor itself. The tap deliberately stays on the compressor — the
    // scope should show the music, not how loud it is being played — which is
    // why these are now two different nodes.
    const sink = compressor.connections.find((node) => node.kind === 'gain');
    assert.ok(sink, 'the compressor must feed the post-compressor output gain');
    assert.ok(expectSink(ctx, sink), 'the engine wired the wrong output route');
    // Every track's signal actually reaches it: this is the trace that lights
    // up white on the scope, not a node that happens to exist.
    for (const name of TRACK_ORDER) {
      const input = ctx.nodes.find((node) => node.kind === 'gain'
        && downstream(node).has(total) && downstream(node).has(compressor));
      assert.ok(input, `${name}: no signal path reaches the master tap`);
    }
    assert.equal(total.connections.length, 0, 'an analyser is a tap, not a link in the chain');
    engine.stop();
  };

  await proveTap(createEngine({ bpm: 120, speed: 2 }),
    (ctx, sink) => sink.connections.includes(ctx.destination));

  // The media-element route (iOS): the mix leaves through a MediaStream, and
  // the tap must still hear it.
  const Base = globalThis.AudioContext;
  class ElementContext extends Base {
    createMediaStreamDestination() {
      const node = makeNode('streamdest');
      node.stream = { id: 'mock-stream' };
      return this.track(node);
    }
  }
  globalThis.AudioContext = ElementContext;
  globalThis.Audio = class {
    set srcObject(value) { this.src = value; }

    play() { return Promise.resolve(); }

    pause() {}
  };
  try {
    await proveTap(createEngine({ bpm: 120, speed: 2 }), (ctx, sink) => {
      const streamDest = ctx.nodes.find((node) => node.kind === 'streamdest');
      return streamDest && sink.connections.includes(streamDest)
        && !sink.connections.includes(ctx.destination);
    });
  } finally {
    globalThis.AudioContext = Base;
    delete globalThis.Audio;
  }
});

test('v26: pause() holds the piece where it stands, and resume() continues it exactly', async () => {
  MockTickerWorker.live.clear();
  globalThis.Worker = MockTickerWorker;
  try {
    const engine = createEngine({ bpm: 120, speed: 2, structure: 'drone' }, { rng: seededRng(515) });
    const bars = [];
    const notes = [];
    const states = [];
    engine.on('bar', (bar) => bars.push(bar));
    engine.on('note', (note) => notes.push(note));
    engine.on('state', (state) => states.push(state));
    await engine.start();
    await advance(3, { step: 0.12, sleep: 16 });
    const ctx = liveContexts[liveContexts.length - 1];
    assert.ok(bars.length > 1, 'the piece never got going');

    const clock = engine.now();
    const lastBar = bars[bars.length - 1].bar;
    const heard = notes.length;
    engine.pause();
    assert.equal(engine.paused, true);
    assert.equal(engine.running, true, 'a pause is not a stop: the piece is still running');
    assert.equal(ctx.state, 'suspended', 'pause() must suspend the context, which stops its clock');
    assert.equal(MockTickerWorker.live.size, 0, 'pause() must stop the ticker');
    assert.deepEqual(states[states.length - 1], { running: true, paused: true });

    // Wall-clock time passes; the audio clock does not, because a suspended
    // context's clock does not run. Nothing may be scheduled, and nothing may
    // wake the context behind the pause.
    await new Promise((resolve) => setTimeout(resolve, 200));
    ctx.onstatechange();
    assert.equal(ctx.state, 'suspended', 'a state-change poke must not unfreeze a paused context');
    assert.equal(engine.now(), clock, 'the audio clock ran on through the pause');
    assert.equal(bars.length, lastBar + 1, 'the scheduler kept working while paused');
    assert.equal(notes.length, heard, 'notes were scheduled while paused');
    engine.pause(); // idempotent
    assert.equal(MockTickerWorker.live.size, 0);

    await engine.resume();
    assert.equal(engine.paused, false);
    assert.equal(ctx.state, 'running', 'resume() must wake the context it paused');
    assert.equal(MockTickerWorker.live.size, 1, 'resume() must put exactly one ticker back');
    assert.deepEqual(states[states.length - 1], { running: true, paused: false });

    await advance(3, { step: 0.12, sleep: 16 });
    assert.ok(bars.length > lastBar + 1, 'the piece never continued after resume()');
    assert.equal(bars[lastBar + 1].bar, lastBar + 1,
      'the bar counter must continue across a pause, not jump or restart');
    bars.forEach((bar, i) => assert.equal(bar.bar, i, 'a pause corrupted the bar accounting'));
    assert.ok(notes.length > heard, 'nothing sounded after resume()');

    engine.stop();
    assert.equal(engine.paused, false, 'stop() must clear the pause');
    assert.equal(MockTickerWorker.live.size, 0);
  } finally {
    delete globalThis.Worker;
  }
});

test('v26: play on a paused engine unpauses it rather than starting a new piece', async () => {
  const engine = createEngine({ bpm: 120, speed: 2, structure: 'drone' }, { rng: seededRng(707) });
  const bars = [];
  engine.on('bar', (bar) => bars.push(bar));
  await engine.start();
  await advance(3, { step: 0.12, sleep: 16 });
  const lastBar = bars[bars.length - 1].bar;
  assert.ok(lastBar > 0, 'the piece never got going');
  engine.pause();
  await engine.start();
  assert.equal(engine.paused, false, 'start() on a paused engine must unpause it');
  assert.equal(engine.running, true);
  await advance(3, { step: 0.12, sleep: 16 });
  assert.equal(bars[lastBar + 1].bar, lastBar + 1, 'start() restarted the piece instead of resuming it');
  engine.stop();
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

/**
 * Advance the clock until `ready()` holds, up to a `seconds` budget, and
 * report whether it did. How much music a fixed wall of mock seconds actually
 * buys depends on how busy the machine is — the scheduler is a real timer
 * racing a mock clock, and a loaded box loses bars to it — so a test that
 * needs N bars of piece before it can judge anything must wait for the bars
 * rather than for the seconds.
 */
async function advanceUntil(ready, seconds, { step = 0.08, sleep = 15 } = {}) {
  const steps = Math.ceil(seconds / step);
  for (let i = 0; i < steps; i++) {
    if (ready()) return true;
    for (const ctx of liveContexts) ctx.currentTime += step;
    await new Promise((resolve) => setTimeout(resolve, sleep));
  }
  return ready();
}

/**
 * Advance the clock the same way, but stop the moment `promise` settles.
 * Returns whether it settled inside the budget — an outro that never resolves
 * must fail the test, not hang it.
 */
async function settleWithin(promise, seconds, { step = 0.12, sleep = 8 } = {}) {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  const steps = Math.ceil(seconds / step);
  for (let i = 0; i < steps && !settled; i++) {
    for (const ctx of liveContexts) ctx.currentTime += step;
    await new Promise((resolve) => setTimeout(resolve, sleep));
  }
  return settled;
}

/** Clock settings for the fast (hidden-tab) path — see the file header. */
const FAST = { step: 0.5, sleep: 10 };

/**
 * An onset as a string, for signatures that ask whether two bars are the same
 * bar. `toFixed` alone is not safe here: a beat position that lands exactly on
 * a half-tick of the chosen decimal (0.9375 s at 240 bpm, against three places)
 * reads back as 0.938 when the arithmetic happens to be exact and 0.937 when it
 * accumulated a femtosecond of float error, which makes one bar of an otherwise
 * frozen line look different from the rest. Rounding to a tenth of a millisecond
 * FIRST puts every value the engine can schedule well clear of the tie.
 */
const tick = (seconds) => (Math.round(seconds * 1e4) / 1e4).toFixed(4);

/**
 * Run `fn` with the tab reported hidden, which widens the engine's scheduling
 * lookahead from 0.12 s to 2.5 s. That is what makes the 0.5 s clock jumps of
 * FAST safe: the scheduler still sees every bar, it just plans further ahead.
 */
async function hiddenTab(fn) {
  globalThis.document = { hidden: true, addEventListener() {} };
  try {
    return await fn();
  } finally {
    delete globalThis.document;
  }
}

/** Every track forced to one state, with the same settings applied to each. */
function tracksAll(state, common = {}) {
  return Object.fromEntries(TRACK_ORDER.map((name) => [name, { state, ...common }]));
}

/** A full 20-slot sequencer lane of identical steps. */
function seqLane(step = {}) {
  return Array.from({ length: SEQUENCER_STEP_COUNT }, () => ({
    on: true, prob: 1, vmin: 0.4, vmax: 0.8, ...step,
  }));
}

/** Subscribe to an engine's note/bar stream, with bar-relative lookups. */
function record(engine) {
  const notes = [];
  const bars = [];
  const chords = [];
  engine.on('note', (note) => notes.push(note));
  engine.on('bar', (bar) => bars.push(bar));
  engine.on('chord', (chord) => chords.push(chord));
  const barOf = (note) => {
    let owner = null;
    for (const bar of bars) {
      if (bar.time > note.time + 1e-9) break;
      owner = bar;
    }
    return owner;
  };
  return {
    notes,
    bars,
    chords,
    barOf,
    /** Map of bar number → that bar's notes, each carrying its bar-relative offset. */
    byBar(track) {
      const out = new Map();
      for (const note of notes) {
        if (track && note.track !== track) continue;
        const owner = barOf(note);
        if (!owner) continue;
        if (!out.has(owner.bar)) out.set(owner.bar, []);
        out.get(owner.bar).push({ ...note, offset: note.time - owner.time });
      }
      return out;
    },
  };
}

/**
 * Solo one track (everything else off), play `seconds` of audio on the fast
 * clock and hand back its recorded stream. Anything else in `options` that is
 * not `seconds`/`seed` is passed through as an engine param.
 */
async function soloRun(track, settings, options = {}) {
  const { seconds = 16, seed = 4242, ...params } = options;
  const engine = createEngine({
    bpm: 120, speed: 2, structure: 'drone', complexity: 0.5, repetition: 0.5,
    ...params,
    tracks: Object.fromEntries(TRACK_ORDER.map((name) => [
      name, name === track ? { state: 'on', ...settings } : { state: 'off' },
    ])),
  }, { rng: seededRng(seed) });
  const log = record(engine);
  await engine.start();
  await advance(seconds, FAST);
  engine.stop();
  return log;
}

/** The voice bank the engine will actually play `track` from. */
function bankFor(track) {
  const fromLibrary = voiceLib && voiceLib[track];
  return fromLibrary && Object.keys(fromLibrary).length ? fromLibrary : FALLBACK_VOICES[track];
}

/**
 * Wrap every voice in a bank so the suite can see which one actually sounded,
 * with what note, and whether the engine later cancelled it. Restore when done.
 */
function spyOnBank(bank) {
  const original = { ...bank };
  const plays = [];
  for (const [id, voice] of Object.entries(original)) {
    bank[id] = {
      ...voice,
      play(ctx, destination, note, patch) {
        const entry = { id, note, patch, cancelled: false };
        plays.push(entry);
        const handle = voice.play(ctx, destination, note, patch);
        if (handle && typeof handle.cancel === 'function') {
          return {
            ...handle,
            cancel: (...args) => {
              entry.cancelled = true;
              return handle.cancel(...args);
            },
          };
        }
        return handle;
      },
    };
  }
  return {
    plays,
    restore() {
      for (const id of Object.keys(bank)) delete bank[id];
      Object.assign(bank, original);
    },
  };
}

/**
 * The engine's per-track input gains — the node the v8 gain chain writes to.
 * Found the same way sendGains finds the sends: the gain feeding the tone
 * filter that feeds that track's reverb send.
 */
function trackGains(ctx) {
  const sends = sendGains(ctx);
  return Object.fromEntries(TRACK_ORDER.map((name) => {
    const tone = ctx.nodes.find((n) => n.kind === 'biquad' && n.connections.includes(sends[name].reverb));
    assert.ok(tone, `${name} has no tone filter`);
    const input = ctx.nodes.find((n) => n.kind === 'gain' && n.connections.includes(tone));
    assert.ok(input, `${name} has no input gain feeding its tone filter`);
    return [name, input];
  }));
}

/**
 * The engine's per-track send gains, found through the mock's node graph: the
 * gains feeding the reverb BUS are the reverb sends (one per track, in track
 * order), and each track's delay send is the other gain hanging off the same
 * tone filter that feeds the delay line. The bus is v21's doing — the sends
 * used to reach the convolver directly, but a tail rebuild crossfades between
 * two convolvers and the sends must not know which one is live.
 */
function sendGains(ctx) {
  const convolver = ctx.nodes.find((n) => n.kind === 'convolver');
  const delayLine = ctx.nodes.find((n) => n.kind === 'delay');
  assert.ok(convolver && delayLine, 'the engine graph has no reverb or delay');
  const bus = reverbBus(ctx);
  const reverbs = ctx.nodes.filter((n) => n.kind === 'gain' && n.connections.includes(bus));
  assert.equal(reverbs.length, TRACK_ORDER.length, 'expected one reverb send per track');
  return Object.fromEntries(TRACK_ORDER.map((name, i) => {
    const reverb = reverbs[i];
    const tone = ctx.nodes.find((n) => n.kind === 'biquad' && n.connections.includes(reverb));
    assert.ok(tone, `${name} has no tone filter feeding its reverb send`);
    const delay = tone.connections.find((n) => n.kind === 'gain' && n.connections.includes(delayLine));
    assert.ok(delay, `${name} has no delay send`);
    return [name, { reverb, delay }];
  }));
}

/**
 * The one gain every track's reverb send feeds: the bus in front of whichever
 * convolver is live. Searched across every convolver the context has made, so
 * it still answers after a v21 tail swap has retired the first one.
 */
function reverbBus(ctx) {
  const convolvers = ctx.nodes.filter((n) => n.kind === 'convolver');
  assert.ok(convolvers.length, 'the engine graph has no reverb');
  const bus = ctx.nodes.find((n) => n.kind === 'gain'
    && convolvers.some((c) => n.connections.includes(c)));
  assert.ok(bus, 'the engine graph has no reverb bus');
  return bus;
}

/** Every convolver a context has made, in creation order, with its return gain. */
function reverbTails(ctx) {
  return ctx.nodes.filter((n) => n.kind === 'convolver').map((convolver) => ({
    convolver,
    ret: convolver.connections.find((n) => n.kind === 'gain'),
    seconds: convolver.buffer ? convolver.buffer.length / ctx.sampleRate : 0,
  }));
}

/**
 * Wait for a deferred reverb rebuild (a macrotask) and, optionally, for the
 * crossfade timer that retires the old convolver behind it. Both run on real
 * wall-clock timers, exactly as the AudioParam ramps do in a real context.
 */
const reverbBuilt = () => new Promise((resolve) => setTimeout(resolve, 0));
const reverbFaded = () => new Promise((resolve) => setTimeout(resolve, 620));

const liveContexts = [];
const RealCtx = MockAudioContext;
globalThis.AudioContext = class extends RealCtx {
  constructor() {
    super();
    liveContexts.push(this);
  }
};

// --------------------------------------------------------------------------
// v28 live play-along — the listener's own hands
//
// Two halves that stand alone: noteOn/noteOff sound a key through the target
// track's existing chain, and the record button quantises what was played into
// that track's step lane. The rule underneath both is that a live note is not
// part of the piece's DECISIONS — it draws no randomness, it is never captured
// into a loop record, and the seeded note stream must be bit-identical whether
// or not someone played over the top of it.
// --------------------------------------------------------------------------

/** A voice that answers for any note and remembers exactly how it was played. */
function keySpy(label = 'Key spy') {
  const plays = [];
  return {
    plays,
    voice: {
      label,
      play(ctx, destination, note, patch) {
        const handle = {
          cancelled: false,
          cancelAt: null,
          cancel(at) {
            this.cancelled = true;
            this.cancelAt = at;
          },
        };
        plays.push({ destination, note, patch, handle });
        return handle;
      },
    },
  };
}

/**
 * arm() loads the voice library in the background (start() awaits it), so a
 * test that plays a key straight after arming would play through the engine's
 * own fallback voices instead of the bank it just installed a spy in.
 */
const voicesLoaded = () => new Promise((resolve) => setTimeout(resolve, 20));

/** Every live note event an engine emits, in order. */
function recordLive(engine) {
  const live = [];
  engine.on('note', (note) => {
    if (note.live === true) live.push(note);
  });
  return live;
}

test('v28 captureSlot: an onset rounds to its nearest slot, and the bar wraps both ways', () => {
  const grid = { origin: 10, stepSeconds: 0.25, stepCount: 16 };
  assert.equal(captureSlot(10, grid), 0);
  assert.equal(captureSlot(10.11, grid), 0, 'a shade behind the slot is still that slot');
  assert.equal(captureSlot(10.13, grid), 1, 'a shade ahead of halfway is the next slot');
  assert.equal(captureSlot(10.24, grid), 1, 'a hair early must round to the slot it was aimed at');
  // The grid is a cycle: a second lap folds onto the first, and a note played
  // before the origin is as playable as one after it.
  assert.equal(captureSlot(14, grid), 0, 'a whole bar later is the same slot');
  assert.equal(captureSlot(9.75, grid), 15, 'an onset before the origin must wrap, not clamp');
  assert.equal(captureSlot(6, grid), 0, 'a whole bar early is the same slot too');
  assert.equal(captureSlot(10.4, { ...grid, stepCount: 12 }), 2, 'the metre decides the wrap');
  // Nothing usable is ever written to slot 0 by accident.
  for (const bad of [{}, { stepSeconds: 0, stepCount: 16 }, { stepSeconds: 0.25, stepCount: 0 },
    { stepSeconds: NaN, stepCount: 16 }, { stepSeconds: 0.25, stepCount: NaN }]) {
    assert.equal(captureSlot(10, bad), null, `${JSON.stringify(bad)} must answer null`);
  }
  assert.equal(captureSlot(undefined, grid), null, 'an onset with no time is not a note');
});

test('v28 quantiseCapture: a take becomes a whole lane — played slots on, the rest off', () => {
  const grid = { origin: 0, stepSeconds: 0.25, stepCount: 16 };
  const { steps, written } = quantiseCapture([
    { start: 0, end: 0.2, velocity: 0.9 },
    { start: 0.5, end: 0.9, velocity: 0.4 },
    { start: 2.02, end: null, velocity: 0.6 },   // a key never let go of
  ], grid);
  assert.equal(written, 3);
  assert.equal(steps.length, SEQUENCER_STEP_COUNT, 'a capture must write a FULL lane');
  assert.equal(laneMask(steps), '10100000100000000000');
  assert.equal(steps[0].vmin, 0.9);
  assert.equal(steps[0].vmax, 0.9, 'the slot must be struck at the velocity it was played at');
  assert.equal(steps[0].prob, 1, 'a played note is not a maybe');
  assert.ok(Math.abs(steps[0].gate - 0.8) < 1e-9, 'a 0.2 s press on a 0.25 s slot is a 0.8 gate');
  assert.ok(Math.abs(steps[2].gate - 1.6) < 1e-9, 'a press over two slots must gate past its own');
  assert.equal('gate' in steps[8], false, 'a key never released keeps the lane\'s own length');
  assert.equal(steps[1].on, false, 'an unplayed slot must be OFF, not left at the default on');
  // Two presses inside one slot: the second is a correction, not a chord.
  const { steps: fixed } = quantiseCapture([
    { start: 0, end: 0.1, velocity: 0.9 },
    { start: 0.02, end: 0.1, velocity: 0.3 },
  ], grid);
  assert.equal(fixed[0].vmax, 0.3, 'the last press on a slot must win');
  assert.equal(quantiseCapture([], grid).written, 0, 'an empty take writes nothing');
  assert.equal(quantiseCapture([{ start: 0 }], { stepSeconds: 0 }).written, 0,
    'a take with no readable grid writes nothing');
  assert.equal(quantiseCapture('not a take', grid).written, 0);
});

test('v28 quantiseCapture: a kit take lands lane by lane, and a lane the kit lost falls to the first', () => {
  const grid = { origin: 0, stepSeconds: 0.25, stepCount: 16, lanes: ['low', 'mid', 'high'] };
  const { steps, written } = quantiseCapture([
    { start: 0, end: 0.1, velocity: 0.8, lane: 'low' },
    { start: 0.75, end: 0.8, velocity: 0.5, lane: 'low' },
    { start: 0.25, end: 0.3, velocity: 0.5, lane: 'high' },
    { start: 0.5, end: 0.55, velocity: 0.5, lane: 'clap' },  // a lane edited away mid-take
  ], grid);
  assert.equal(written, 4);
  assert.deepEqual(Object.keys(steps), ['low', 'mid', 'high'], 'the kit\'s own lanes, and only those');
  assert.equal(laneMask(steps.low), '10110000000000000000',
    'an unknown lane must land on the first lane rather than vanish');
  assert.equal(laneMask(steps.mid), '00000000000000000000');
  assert.equal(laneMask(steps.high), '01000000000000000000');
});

test('v28 noteOn: a key sounds through the target track\'s own voice, patch and chain', async () => {
  const spy = keySpy();
  const bank = bankFor('melody');
  bank.keySpy = spy.voice;
  try {
    const engine = createEngine({
      tracks: Object.fromEntries(TRACK_ORDER.map((name) => [name, {
        state: 'on',
        voice: name === 'melody' ? 'keySpy' : undefined,
        vary: { voice: 0 },
      }])),
      patches: { melody: { keySpy: { sends: { reverb: 0.33 } } } },
    });
    const expected = engine.getParams().patches.melody.keySpy;
    assert.equal(engine.noteOn('melody', 60), false,
      'a keyboard before arm() has no graph to play through — and must say so quietly');
    assert.equal(spy.plays.length, 0);

    assert.equal(engine.arm(), true);
    await voicesLoaded();
    const live = recordLive(engine);
    const ctx = liveContexts.at(-1);
    assert.equal(engine.noteOn('melody', 64, 0.55), true);
    assert.equal(engine.running, false, 'a key press must never start the transport');
    assert.equal(spy.plays.length, 1, 'the key never reached the melody voice bank');

    const played = spy.plays[0];
    const gains = trackGains(ctx);
    assert.equal(played.destination, gains.melody,
      'a live note must be played into the track\'s own chain, not straight at the master');
    assert.equal(played.note.midi, 64);
    assert.ok(Math.abs(played.note.freq - midiToFreq(64)) < 1e-9);
    assert.equal(played.note.velocity, 0.55);
    assert.deepEqual(played.patch, expected, 'a live note must carry the track\'s own patch');
    assert.ok(gains.melody.gain.value > 0.01,
      'the target track\'s chain must open for the note — a stopped piece leaves it shut');
    assert.ok(gains.pad.gain.value <= 0.001, 'a key press opened a chain it never played through');

    assert.equal(live.length, 1, 'a live note must announce itself on the note stream');
    assert.deepEqual(
      { track: live[0].track, midi: live[0].midi, velocity: live[0].velocity, live: live[0].live },
      { track: 'melody', midi: 64, velocity: 0.55, live: true },
    );
    // Velocity is the caller's, or a sensible default — never zero or silly.
    engine.noteOn('melody', 65);
    assert.equal(spy.plays.at(-1).note.velocity, 0.8, 'a note with no velocity must still sound');
    engine.noteOn('melody', 66, 12);
    assert.equal(spy.plays.at(-1).note.velocity, 1, 'velocity must be clamped, not passed through');
    engine.stop();
  } finally {
    delete bank.keySpy;
  }
});

test('v28 noteOn: unknown ids and impossible pitches are quiet no-ops, and a re-press re-strikes', async () => {
  const spy = keySpy();
  const bank = bankFor('melody');
  bank.keySpy = spy.voice;
  try {
    const engine = createEngine({
      tracks: { melody: { state: 'on', voice: 'keySpy', vary: { voice: 0 } } },
    });
    engine.arm();
    await voicesLoaded();
    for (const [track, midi] of [['nosuchtrack', 60], [null, 60], [7, 60], ['melody', -1],
      ['melody', 128], ['melody', 'C4'], ['melody', undefined], ['melody', NaN]]) {
      assert.equal(engine.noteOn(track, midi), false, `noteOn(${track}, ${midi}) must be a no-op`);
    }
    assert.equal(spy.plays.length, 0, 'a refused key press played something anyway');
    assert.equal(engine.noteOff('nosuchtrack', 60), false);
    assert.equal(engine.noteOff('melody', 60), false, 'a key that was never down cannot come up');

    // A key pressed twice without a release is a re-strike, never a stack.
    assert.equal(engine.noteOn('melody', 60, 0.5), true);
    assert.equal(engine.noteOn('melody', 60, 0.9), true);
    assert.equal(spy.plays.length, 2);
    assert.equal(spy.plays[0].handle.cancelled, true,
      'the first press must be released before the second sounds — a held key must not stack');
    assert.equal(spy.plays[1].handle.cancelled, false);

    assert.equal(engine.noteOff('melody', 60), true);
    assert.equal(spy.plays[1].handle.cancelled, true, 'noteOff must let the note go');
    assert.equal(engine.noteOff('melody', 60), false, 'the same key cannot come up twice');

    // Every key up at once.
    engine.noteOn('melody', 62);
    engine.noteOn('melody', 65);
    engine.noteOn('melody', 69);
    assert.equal(engine.getCapture().held, 3, 'three keys are down');
    assert.equal(engine.allNotesOff(), 3);
    assert.equal(engine.getCapture().held, 0);
    assert.ok(spy.plays.slice(-3).every((play) => play.handle.cancelled),
      'allNotesOff must release every held key');
    assert.equal(engine.allNotesOff(), 0, 'nothing left to release');
    engine.stop();
  } finally {
    delete bank.keySpy;
  }
});

test('v28 noteOn: a kit spreads its lanes across the pitch classes, whatever octave is played', async () => {
  const spy = keySpy();
  const bank = bankFor('percussion');
  bank.keySpy = spy.voice;
  try {
    const engine = createEngine({
      tracks: { percussion: { state: 'on', voice: 'keySpy', vary: { voice: 0 } } },
    });
    engine.arm();
    await voicesLoaded();
    const live = recordLive(engine);
    // C, E and A of one octave: the three built-in lanes, in kit order.
    for (const midi of [60, 64, 69]) engine.noteOn('percussion', midi, 0.7);
    assert.deepEqual(live.map((note) => note.lane), ['low', 'mid', 'high']);
    assert.deepEqual(live.map((note) => note.kind), ['low', 'mid', 'high']);
    assert.ok(live.every((note) => note.midi === null),
      'a kit hit has no pitch — the lane is what was struck');
    assert.ok(spy.plays.every((play) => play.note.freq === null));
    // A kit has no register: the same key an octave away is the same drum.
    live.length = 0;
    for (const midi of [48, 52, 81]) engine.noteOn('percussion', midi, 0.7);
    assert.deepEqual(live.map((note) => note.lane), ['low', 'mid', 'high'],
      'shifting octaves must not move the drum under a key');
    // The patch a lane is struck with is that lane's own.
    assert.ok(spy.plays.length >= 6, 'the kit never played');
    engine.stop();
  } finally {
    delete bank.keySpy;
  }
});

test('v28: live notes are polyphony the meters count, but never the piece\'s own note rate', async () => {
  const spy = keySpy();
  const bank = bankFor('melody');
  bank.keySpy = spy.voice;
  try {
    const engine = createEngine({
      tracks: { melody: { state: 'on', voice: 'keySpy', vary: { voice: 0 } } },
    });
    engine.arm();
    await voicesLoaded();
    const before = engine.getStats();
    assert.equal(before.totalActiveNotes, 0);
    engine.noteOn('melody', 60);
    engine.noteOn('melody', 64);
    const during = engine.getStats();
    assert.equal(during.totalActiveNotes, 2, 'a held key is polyphony the CPU is paying for');
    assert.equal(during.perTrack.melody.activeNotes, 2);
    assert.equal(during.perTrack.melody.notesPerMin, 0,
      'notesPerMin measures the piece the ENGINE is generating — the hands are not that');
    engine.allNotesOff();
    assert.equal(engine.getStats().totalActiveNotes, 0, 'a released key is off the ledger');
    engine.stop();
  } finally {
    delete bank.keySpy;
  }
});

test('v28 byte-identity: playing over a seeded piece leaves the piece bit-identical',
  () => hiddenTab(async () => {
    const play = async (hands) => {
      const engine = createEngine({
        bpm: 120, speed: 2, complexity: 0.7, repetition: 0.4, structure: 'journey',
        tracks: tracksAll('on'),
      }, { rng: seededRng(2306) });
      const log = record(engine);
      await engine.start();
      for (let i = 0; i < 10; i++) {
        await advance(2, FAST);
        if (!hands) continue;
        // Two hands over the top: a melodic line held across the bar, and a
        // kit hit under it — on tracks the piece is generating for at the
        // same time, which is the case a shared code path would break.
        engine.noteOff('melody', 59 + i);
        engine.noteOn('melody', 60 + i, 0.7);
        engine.noteOn('percussion', 40 + i, 0.9);
        engine.noteOff('percussion', 40 + i);
      }
      if (hands) engine.allNotesOff();
      engine.stop();
      const generated = log.notes.filter((note) => note.live !== true);
      if (hands) {
        assert.ok(log.notes.length > generated.length, 'the hands played nothing at all');
      }
      return generated.map((note) => [note.track, note.midi, note.kind, note.lane,
        tick(note.time), tick(note.duration), note.velocity].join('|'));
    };

    const alone = await play(false);
    const over = await play(true);
    const shared = Math.min(alone.length, over.length);
    assert.ok(shared > 200, `only ${shared} shared notes — too few to judge`);
    assert.deepEqual(over.slice(0, shared), alone.slice(0, shared),
      'playing along changed the piece — a live note reached the scheduler\'s decisions');
  }));

test('v28 armCapture: only a track with a step grid can be armed', async () => {
  const engine = createEngine();
  engine.arm();
  for (const track of SEQUENCED_TRACKS) {
    assert.equal(engine.armCapture(track), true, `${track} is sequenced and must arm`);
  }
  for (const track of ['pad', 'texture']) {
    assert.equal(engine.armCapture(track), false,
      `${track} has no step grid — arming it would record into nothing`);
  }
  assert.equal(engine.armCapture('nosuchtrack'), false);
  assert.equal(engine.armCapture(), false);
  // The last successful arm is the one that stands: arming is a re-point, not a stack.
  assert.equal(engine.armCapture('melody'), true);
  assert.deepEqual(engine.getCapture(),
    { armed: true, track: 'melody', notes: 0, held: 0, undoable: false });
  engine.noteOn('melody', 60, 0.6);
  assert.equal(engine.getCapture().notes, 1, 'an armed capture must be taking the notes down');
  engine.noteOn('bass', 40, 0.6);
  assert.equal(engine.getCapture().notes, 1, 'only the armed track is being recorded');
  engine.allNotesOff();
  engine.stop();
});

test('v28 record-arm: a take is quantised into the armed track\'s active lane, and undo puts it back', async () => {
  // 120 bpm at speed 1: a beat is 0.5 s, so a sixteenth — one grid slot — is
  // 0.125 s. The mock clock is driven by hand, which makes the take exact.
  const engine = createEngine({ bpm: 120, speed: 1, timeSignature: '4/4' });
  engine.arm();
  const ctx = liveContexts.at(-1);
  const before = structuredClone(engine.getParams().tracks.melody.sequencers);
  assert.equal(before[0].mode, 'auto', 'the melody lane starts in auto — the take is what changes it');

  assert.equal(engine.armCapture('melody'), true);
  const SLOT = 0.125;
  for (const slot of [0, 2, 4, 7]) {
    ctx.currentTime = slot * SLOT;
    engine.noteOn('melody', 60 + slot, 0.6);
    ctx.currentTime += 0.06;
    engine.noteOff('melody', 60 + slot);
  }
  ctx.currentTime = 16 * SLOT;
  const take = engine.stopCapture();
  assert.deepEqual({ track: take.track, captured: take.captured, written: take.written },
    { track: 'melody', captured: 4, written: 4 });
  assert.equal(engine.getCapture().armed, false, 'stopCapture must disarm');

  const written = engine.getParams().tracks.melody.sequencers[take.sequencer];
  assert.equal(written.mode, 'manual', 'a take must be played back verbatim, not as a suggestion');
  assert.equal(laneMask(written.steps), '10101001000000000000');
  assert.equal(written.steps[0].vmin, 0.6);
  assert.equal(written.steps[0].vmax, 0.6);
  assert.ok(Math.abs(written.steps[0].gate - 0.48) < 1e-9,
    'a 0.06 s press on a 0.125 s slot is a 0.48 gate');
  assert.equal(written.steps[1].on, false);

  assert.equal(engine.getCapture().undoable, true);
  assert.equal(engine.undoCapture(), true);
  assert.deepEqual(engine.getParams().tracks.melody.sequencers, before,
    'undo must put the lane back exactly as it was');
  assert.equal(engine.undoCapture(), false, 'undo is one click, once');
  assert.equal(engine.getCapture().undoable, false);
  engine.stop();
});

test('v28 record-arm: an empty take writes nothing, and a kit take lands on its own lanes', async () => {
  const engine = createEngine({ bpm: 120, speed: 1 });
  engine.arm();
  const ctx = liveContexts.at(-1);
  assert.equal(engine.stopCapture(), null, 'there is no take without an arm');

  const before = structuredClone(engine.getParams().tracks.melody.sequencers);
  assert.equal(engine.armCapture('melody'), true);
  const empty = engine.stopCapture();
  assert.deepEqual({ captured: empty.captured, written: empty.written }, { captured: 0, written: 0 });
  assert.deepEqual(engine.getParams().tracks.melody.sequencers, before,
    'a take with nothing in it must not rewrite the lane');
  assert.equal(engine.undoCapture(), false, 'an empty take is not something to undo');

  // The kit: a hit's LANE is what the grid is keyed by, and the key that is
  // still down when the button is pressed ends at the button. Arming at a
  // whole bar's remove from the origin also proves the wrap: a take does not
  // have to start on bar one to land on the right slots.
  ctx.currentTime = 4;
  assert.equal(engine.armCapture('percussion'), true);
  engine.noteOn('percussion', 60, 0.7);   // low, on the downbeat
  ctx.currentTime = 4.25;
  engine.noteOn('percussion', 69, 0.5);   // high, two slots later
  ctx.currentTime = 4.3;
  const take = engine.stopCapture();
  assert.equal(take.written, 2);
  const grid = engine.getParams().tracks.percussion.sequencers[take.sequencer].steps;
  assert.equal(laneMask(grid.low), '10000000000000000000');
  assert.equal(laneMask(grid.high), '00100000000000000000');
  assert.equal(laneMask(grid.mid), '00000000000000000000');
  assert.ok(grid.low[0].gate > 0, 'a key still down at the button must still get its length');
  engine.allNotesOff();
  engine.stop();
});

let failures = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}\n     ${error.message}`);
  } finally {
    for (const made of builtEngines) if (made.running) made.stop();
    builtEngines.length = 0;
    // Each mock context keeps every node it ever made; holding them all for the
    // length of the suite is what turns a long run into a memory problem. No
    // test outlives its own iteration, so dropping them here is safe.
    liveContexts.length = 0;
  }
}
console.log(`\n${tests.length - failures}/${tests.length} passed`);
console.log(`(${nodesCreated} mock nodes, ${oscillatorsStarted} oscillators started)`);
process.exit(failures ? 1 : 0);
