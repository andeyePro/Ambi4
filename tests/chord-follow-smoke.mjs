/**
 * Follow my chords — the held keys choose the harmony.
 *
 *   node tests/chord-follow-smoke.mjs
 *
 * Two halves. The pure mapper (src/scripts/chord-follow.js): held MIDI notes
 * plus the piece's root and mode in, the best-fitting diatonic chord degree
 * out. And the engine law (engine.setChordFollow): a follow degree lands at
 * the NEXT chord boundary and not before, holds while it is set, and
 * clearing it lets the hook's own progression carry on.
 */
import assert from 'node:assert/strict';
import { followDegree, scoreDegrees, degreeTones } from '../src/scripts/chord-follow.js';

// Minimal AudioContext mock — the same thin shape voice-rule-smoke.mjs uses:
// enough surface for the engine's graph, no node-graph assertions here since
// this suite only reads 'bar' events.
// --------------------------------------------------------------------------

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
  return {
    kind,
    connections: [],
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
    disconnect(target) {
      if (target) this.connections = this.connections.filter((n) => n !== target);
      else this.connections = [];
    },
    start(t = 0) {
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
}

const liveContexts = [];

class MockAudioContext {
  constructor() {
    this.currentTime = 0;
    this.sampleRate = 48000;
    this.state = 'running';
    this.nodes = [];
    this.destination = this.track(makeNode('destination'));
    liveContexts.push(this);
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
    return { numberOfChannels: channels, length, sampleRate, getChannelData: (i) => data[i] };
  }

  resume() { this.state = 'running'; return Promise.resolve(); }
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
}

globalThis.AudioContext = MockAudioContext;

const engineModule = await import('../src/scripts/ambient-engine.js');
const { TIME_SIGNATURES, SCALES } = engineModule;

const seededRng = (seed) => () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
const builtEngines = [];
function createEngine(...args) {
  const made = engineModule.createEngine(...args);
  builtEngines.push(made);
  return made;
}
function barSeconds(params) {
  const beats = (TIME_SIGNATURES[params.timeSignature] || TIME_SIGNATURES['4/4']).beats || 4;
  return (60 / (params.bpm || 90)) * beats;
}
async function advance(seconds, { step = 0.5, sleep = 6 } = {}) {
  const steps = Math.ceil(seconds / step);
  for (let i = 0; i < steps; i++) {
    for (const ctx of liveContexts) ctx.currentTime += step;
    await new Promise((resolve) => setTimeout(resolve, sleep));
  }
}
async function hiddenTab(fn) {
  globalThis.document = { hidden: true, addEventListener() {} };
  try { return await fn(); } finally { delete globalThis.document; }
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---- the mapper ------------------------------------------------------------

const C_MAJOR = { root: 'C', mode: [0, 2, 4, 5, 7, 9, 11] };
const at = (opts, ...notes) => followDegree(notes, { ...C_MAJOR, ...opts });

test('root-position triads name their degree (C major: I ii iii IV V vi vii)', () => {
  const triads = [[60, 64, 67], [62, 65, 69], [64, 67, 71], [65, 69, 72], [67, 71, 74], [69, 72, 76], [71, 74, 77]];
  triads.forEach((notes, degree) => assert.equal(at({}, ...notes), degree, `${notes} -> ${degree}`));
});

test('inversions still name their chord', () => {
  assert.equal(at({}, 64, 67, 72), 0, 'C/E is I');
  assert.equal(at({}, 67, 72, 76), 0, 'C/G is I');
  assert.equal(at({}, 62, 67, 71), 4, 'G/D is V');
  assert.equal(at({}, 65, 69, 74), 1, 'Dm/F is ii');
});

test('sevenths name their degree, not the triad a third above', () => {
  assert.equal(at({}, 67, 71, 74, 77), 4, 'G7 is V');
  assert.equal(at({}, 62, 65, 69, 72), 1, 'Dm7 is ii');
  assert.equal(at({}, 60, 64, 67, 71), 0, 'Cmaj7 is I');
  assert.equal(at({}, 57, 60, 64, 67), 5, 'Am7 is vi');
});

test('a lone note is the degree it is the root of; a lone note off the mode holds', () => {
  for (let d = 0; d < 7; d++) assert.equal(at({}, 60 + C_MAJOR.mode[d]), d, `degree ${d}`);
  assert.equal(at({}, 48 + 7), 4, 'any octave');
  assert.equal(at({ current: 3 }, 61), 3, 'C# alone holds the current chord');
  assert.equal(at({}, 61), null, 'with nothing sounding, nothing to follow');
});

test('out-of-scale notes count against, and a set that fits nothing holds', () => {
  // C E G + F#: still I, but scored lower than plain C E G.
  assert.equal(at({}, 60, 64, 66, 67), 0);
  const clean = scoreDegrees([60, 64, 67], C_MAJOR)[0].score;
  const dirty = scoreDegrees([60, 64, 66, 67], C_MAJOR)[0].score;
  assert.ok(dirty < clean, `an outside note did not count against (${dirty} vs ${clean})`);
  assert.equal(at({ current: 2 }, 61, 63, 66), 2, 'C# D# F# fits nothing in C major: hold');
  assert.equal(at({ current: 5 }, 61, 66), 5);
});

test('ties go to the current chord', () => {
  // G4 with E5 above: I (C E G) and iii (E G B) both hold both notes, and
  // neither root is in the bass — a tie.
  const tie = scoreDegrees([67, 76], C_MAJOR);
  assert.equal(tie[0].score, tie[2].score, 'G E should tie I and iii');
  assert.equal(at({ current: 0 }, 67, 76), 0);
  assert.equal(at({ current: 2 }, 67, 76), 2);
  assert.equal(at({}, 67, 76), 0, 'no current: the lowest degree');
  // ... and a tie the current chord is NOT in does not stick to it.
  assert.equal(at({ current: 6 }, 67, 76), 0);
});

test('the root and the mode are honoured (A dorian, F# major)', () => {
  const dorian = { root: 'A', mode: SCALES.dorian };
  assert.equal(followDegree([57, 60, 64], dorian), 0, 'Am in A dorian');
  assert.equal(followDegree([62, 66, 69], dorian), 3, 'D major is IV in A dorian');
  assert.equal(followDegree([66, 70, 73], { root: 'F#', mode: SCALES.ionian }), 0);
  assert.equal(followDegree([66, 70, 73], { root: 6, mode: SCALES.ionian }), 0, 'a root as a pitch class');
});

test('every mode in SCALES: each degree\'s own chord, root in the bass, names that degree', () => {
  for (const [name, scale] of Object.entries(SCALES)) {
    for (let d = 0; d < scale.length; d++) {
      const tones = degreeTones(scale, d);
      const rootMidi = 48 + 2 + tones.root; // root D
      const notes = [rootMidi, ...[...tones.triad].filter((pc) => pc !== tones.root).map((pc) => 60 + 2 + pc)];
      assert.equal(followDegree(notes, { root: 'D', mode: scale }), d, `${name} degree ${d}: ${notes}`);
      // And a held set it fits never moves away from it.
      assert.equal(followDegree(notes, { root: 'D', mode: scale, current: d }), d, `${name} degree ${d} held`);
      // Each scale degree alone is its own chord.
      assert.equal(followDegree([62 + scale[d]], { root: 'D', mode: scale }), d, `${name} lone degree ${d}`);
    }
  }
});

test('junk in: nothing held or no mode holds the current chord', () => {
  assert.equal(followDegree([], { ...C_MAJOR, current: 4 }), 4);
  assert.equal(followDegree(null, { ...C_MAJOR, current: 1 }), 1);
  assert.equal(followDegree([60, 64, 67], { root: 'C', mode: undefined, current: 3 }), 3);
  assert.equal(followDegree(['x', 999, -3], { ...C_MAJOR, current: 2 }), 2);
});

// ---- the engine law --------------------------------------------------------

const PARAMS = {
  bpm: 120, structure: 'drone', timeSignature: '4/4', complexity: 0.5, mode: 'ionian', root: 'C',
  harmony: { rhythm: 1 },
  tracks: {
    pad: { state: 'on' }, bass: { state: 'on' }, melody: { state: 'off' },
    arp: { state: 'off' }, texture: { state: 'off' }, percussion: { state: 'off' },
  },
};
const BAR = 2; // seconds: 4 beats at 120

/**
 * Run a piece for `bars`, calling `at(engine, seconds)` every step, and
 * return [{ bar, time, beat, degree }] — one per chord the engine voiced, the
 * degree read from the engine at the moment it emits the chord.
 */
async function chords(bars, at = () => {}, extra = {}) {
  liveContexts.length = 0;
  const engine = createEngine({ ...PARAMS, ...extra }, { rng: seededRng(4242) });
  const out = [];
  engine.on('chord', (e) => out.push({ bar: e.bar, time: e.time, beat: e.beat ?? 0, degree: engine.getChordFollow().degree }));
  await engine.start();
  const step = 0.05;
  for (let t = 0; t < bars * BAR; t += step) {
    at(engine, liveContexts[0].currentTime);
    for (const ctx of liveContexts) ctx.currentTime += step;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  engine.stop();
  return out;
}

test('setChordFollow is sanitised and getChordFollow reports it', () => {
  const engine = createEngine(PARAMS, { rng: seededRng(1) });
  assert.equal(engine.getChordFollow().follow, null, 'absent by default');
  assert.equal(engine.setChordFollow(3.4), 3);
  assert.equal(engine.getChordFollow().follow, 3);
  assert.equal(engine.setChordFollow('2'), null, 'a string is not a degree');
  assert.equal(engine.setChordFollow(4), 4);
  assert.equal(engine.setChordFollow(NaN), null);
  assert.equal(engine.setChordFollow(4), 4);
  assert.equal(engine.setChordFollow(null), null);
});

test('a follow degree lands at the next barline, not before, holds while set, and letting go carries on', async () => {
  const reference = await chords(10);
  // A degree the reference never plays in bars 3-6, so a landing is
  // unmistakable.
  const playing = new Set(reference.filter((c) => c.bar >= 3 && c.bar <= 6).map((c) => c.degree));
  const follow = [0, 1, 2, 3, 4, 5, 6].find((d) => !playing.has(d));
  assert.ok(follow !== undefined, 'the reference plays every degree in four bars');
  const setAt = 3.5 * BAR; // the middle of bar 3
  const clearAt = 6.5 * BAR;
  let setTime = null;
  const followed = await chords(10, (engine, now) => {
    if (setTime === null && now >= setAt) { engine.setChordFollow(follow); setTime = now; }
    if (now >= clearAt && engine.getChordFollow().follow !== null) engine.setChordFollow(null);
  });
  const byBar = (list, bar) => list.find((c) => c.bar === bar);
  for (let bar = 0; bar <= 3; bar++) {
    assert.equal(byBar(followed, bar).degree, byBar(reference, bar).degree, `bar ${bar} (already sounding or past) changed`);
  }
  for (let bar = 4; bar <= 6; bar++) {
    assert.equal(byBar(followed, bar).degree, follow, `bar ${bar} did not follow`);
    assert.ok(byBar(followed, bar).time >= setTime, 'a follow landed before it was asked for');
  }
  // Released: bar 7 onward is the hook again, on its own clock.
  for (let bar = 7; bar <= 9; bar++) {
    assert.equal(byBar(followed, bar).degree, byBar(reference, bar).degree, `bar ${bar}: the progression did not carry on`);
  }
});

test('under harmony.beats every chord of the next bar follows, none of the sounding one', async () => {
  const extra = { harmony: { beats: 2 } };
  const reference = await chords(6, () => {}, extra);
  const playing = new Set(reference.filter((c) => c.bar >= 2 && c.bar <= 4).map((c) => c.degree));
  const follow = [0, 1, 2, 3, 4, 5, 6].find((d) => !playing.has(d));
  assert.ok(follow !== undefined, 'the reference plays every degree');
  let set = false;
  const followed = await chords(6, (engine, now) => {
    if (!set && now >= 2.3 * BAR) { engine.setChordFollow(follow); set = true; }
  }, extra);
  const bar2 = followed.filter((c) => c.bar === 2);
  const ref2 = reference.filter((c) => c.bar === 2);
  assert.equal(bar2.length, 2, `${bar2.length} chords in bar 2`);
  assert.deepEqual(bar2.map((c) => c.degree), ref2.map((c) => c.degree), 'the sounding bar moved');
  const later = followed.filter((x) => x.bar >= 3);
  assert.ok(later.length >= 4, `${later.length} later chords`);
  for (const c of later) assert.equal(c.degree, follow, `bar ${c.bar} beat ${c.beat}`);
});

test('absent, the engine is untouched: the same seed voices the same chords', async () => {
  const a = await chords(6);
  const b = await chords(6, (engine) => engine.setChordFollow(null));
  assert.ok(a.length >= 5, `${a.length} chords`);
  assert.deepEqual(b.map((c) => c.degree), a.map((c) => c.degree));
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
