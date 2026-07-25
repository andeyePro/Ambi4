/**
 * Smoke test for src/scripts/engine-voices.js — run with:
 *   node tests/voices-smoke.mjs
 *
 * Drives every patch in the library against an instrumented AudioContext mock
 * and checks the things a listener would otherwise have to catch by ear:
 * clicks (ramps to zero, hard stops), leaks (nodes that outlive their note),
 * runaway level, and tails long enough to smear a fast arpeggio.
 *
 * The mock records the whole node graph per note, so loudness is checked by
 * walking every source-to-destination path and multiplying the gains along it.
 */

import assert from 'node:assert/strict';

// --------------------------------------------------------------------------
// Instrumented AudioContext mock
// --------------------------------------------------------------------------

/** Everything created since the last reset, so each note is measured alone. */
let created = [];
let startedSources = [];
const automation = [];

function makeParam(name, initial) {
  let current = initial;
  let written = false;
  const param = {
    isParam: true,
    name,
    // min/max cover every value the patch asks for; the constructor default
    // only counts while the patch has left the param alone.
    min: initial,
    max: initial,
    note(v) {
      assert.ok(Number.isFinite(v), `${name}: non-finite value ${v}`);
      if (!written) {
        written = true;
        this.min = v;
        this.max = v;
      }
      if (v < this.min) this.min = v;
      if (v > this.max) this.max = v;
      current = v;
    },
    get value() { return current; },
    set value(v) { this.note(v); },
    setValueAtTime(v, t) {
      checkTime(name, 'setValueAtTime', t);
      automation.push({ name, kind: 'set', value: v, time: t });
      this.note(v);
      return this;
    },
    linearRampToValueAtTime(v, t) {
      checkTime(name, 'linearRamp', t);
      automation.push({ name, kind: 'linear', value: v, time: t });
      this.note(v);
      return this;
    },
    exponentialRampToValueAtTime(v, t) {
      checkTime(name, 'exponentialRamp', t);
      assert.ok(v >= 9e-5, `${name}: exponential ramp to ${v} — must target >= ~1e-4`);
      automation.push({ name, kind: 'exponential', value: v, time: t });
      this.note(v);
      return this;
    },
    setTargetAtTime(v, t, constant) {
      checkTime(name, 'setTargetAtTime', t);
      assert.ok(Number.isFinite(constant) && constant > 0,
        `${name}: setTargetAtTime constant ${constant}`);
      automation.push({ name, kind: 'target', value: v, time: t });
      this.note(v);
      return this;
    },
    cancelScheduledValues(t) {
      checkTime(name, 'cancelScheduledValues', t);
      return this;
    },
  };
  return param;
}

function checkTime(name, op, t) {
  assert.ok(Number.isFinite(t) && t >= 0, `${name}.${op}: bad time ${t}`);
}

function makeNode(kind) {
  const node = {
    kind,
    outputs: [],
    disconnected: 0,
    gain: makeParam(`${kind}.gain`, 1),
    frequency: makeParam(`${kind}.frequency`, 440),
    detune: makeParam(`${kind}.detune`, 0),
    Q: makeParam(`${kind}.Q`, 1),
    pan: makeParam(`${kind}.pan`, 0),
    delayTime: makeParam(`${kind}.delayTime`, 0),
    playbackRate: makeParam(`${kind}.playbackRate`, 1),
    type: 'sine',
    loop: false,
    buffer: null,
    onended: null,
    periodicWave: null,
    setPeriodicWave(wave) {
      assert.ok(wave && wave.isPeriodicWave, `${kind}.setPeriodicWave: not a PeriodicWave`);
      this.periodicWave = wave;
      this.type = 'custom';
    },
    connect(target) {
      assert.ok(target, `${kind}.connect(undefined)`);
      this.outputs.push(target);
    },
    disconnect() { this.disconnected += 1; },
    start(t, offset) {
      assert.ok(this.startedAt === undefined, `${kind}: started twice`);
      assert.ok(Number.isFinite(t) && t >= 0, `${kind}.start: bad time ${t}`);
      if (offset !== undefined) {
        assert.ok(Number.isFinite(offset) && offset >= 0, `${kind}.start: bad offset ${offset}`);
      }
      this.startedAt = t;
      startedSources.push(this);
    },
    stop(t) {
      assert.ok(Number.isFinite(t), `${kind}.stop: bad time ${t}`);
      assert.ok(t >= this.startedAt, `${kind}.stop ${t} precedes start ${this.startedAt}`);
      this.stoppedAt = t;
    },
  };
  created.push(node);
  return node;
}

class MockAudioContext {
  constructor() {
    this.currentTime = 0;
    this.sampleRate = 48000;
    this.state = 'running';
    this.destination = makeNode('destination');
    this.buffersCreated = 0;
  }

  createGain() { return makeNode('gain'); }
  createOscillator() { return makeNode('oscillator'); }
  createBiquadFilter() { return makeNode('biquad'); }
  createStereoPanner() { return makeNode('panner'); }
  createDelay(max) {
    assert.ok(Number.isFinite(max) && max > 0, `createDelay: bad max ${max}`);
    return makeNode('delay');
  }

  createBufferSource() { return makeNode('bufferSource'); }

  createPeriodicWave(real, imag) {
    assert.ok(real instanceof Float32Array && imag instanceof Float32Array,
      'createPeriodicWave: coefficients must be Float32Arrays');
    assert.equal(real.length, imag.length, 'createPeriodicWave: array lengths differ');
    assert.ok(imag.length >= 2, 'createPeriodicWave: too few coefficients');
    for (const arr of [real, imag]) {
      for (const v of arr) assert.ok(Number.isFinite(v), 'createPeriodicWave: non-finite coefficient');
    }
    return { isPeriodicWave: true, real: Float32Array.from(real), imag: Float32Array.from(imag) };
  }

  createBuffer(channels, length, sampleRate) {
    this.buffersCreated += 1;
    assert.ok(length > 0 && sampleRate > 0, 'createBuffer: bad geometry');
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return {
      numberOfChannels: channels,
      length,
      sampleRate,
      getChannelData: (i) => data[i],
    };
  }
}

const { VOICES, shapeWave } = await import('../src/scripts/engine-voices.js');

// --------------------------------------------------------------------------
// Harness
// --------------------------------------------------------------------------

const PER_SOURCE_PEAK = 0.26;   // contract: peak per-note gain <= ~0.25
const SUM_PEAK = 1;             // worst case with every source at full tilt
const MAX_NODES = 90;

/**
 * How much of a noise source survives a bandpass — only the slice inside the
 * band, with a crest factor of 3 for the peaks of narrowband noise. Patches
 * apply the inverse as makeup gain, so the estimate has to be modelled here or
 * every grain looks 15 dB hotter than it sounds. Oscillator paths are left at
 * unity: a tone sitting on the centre frequency passes whole.
 */
function bandpassShare(node) {
  if (node.kind !== 'biquad' || node.type !== 'bandpass') return 1;
  const bandwidth = node.frequency.max / Math.max(node.Q.max, 0.5);
  return Math.min(1, 3 * Math.sqrt(bandwidth / 24000));
}

/** Multiply the gains along every path from `source` down to `destination`. */
function pathProducts(source, destination) {
  const results = [];
  const noisy = source.kind === 'bufferSource';
  const walk = (node, product, seen) => {
    for (const target of node.outputs) {
      if (target.isParam) continue;              // modulation, not signal
      if (target === destination) { results.push(product); continue; }
      if (seen.has(target)) continue;
      seen.add(target);
      const gain = target.kind === 'gain' ? Math.max(target.gain.max, 0) : 1;
      walk(target, product * gain * (noisy ? bandpassShare(target) : 1), seen);
      seen.delete(target);
    }
  };
  walk(source, 1, new Set([source]));
  return results;
}

/** Gain nodes that actually feed the output — the ones a step to zero clicks. */
function audibleGains(destination) {
  const audible = new Set();
  for (const node of created) {
    if (node.kind !== 'gain') continue;
    if (pathProducts(node, destination).length) audible.add(node);
  }
  return audible;
}

/**
 * Play one note and assert every structural guarantee the contract makes.
 * Returns the timing/level measurements so individual tests can go further.
 */
function playAndCheck(label, voice, note, { cancelAfter = false, patch } = {}) {
  const ctx = new MockAudioContext();
  const destination = makeNode('gain');   // stands in for the engine's track bus
  created = [];
  startedSources = [];
  automation.length = 0;

  const handle = voice.play(ctx, destination, note, patch);

  assert.ok(startedSources.length >= 1, `${label}: no source was started`);
  assert.ok(created.length <= MAX_NODES, `${label}: ${created.length} nodes for one note`);
  assert.ok(handle && typeof handle.cancel === 'function', `${label}: no cancel() returned`);

  for (const source of startedSources) {
    assert.ok(Number.isFinite(source.stoppedAt), `${label}: ${source.kind} was never stopped`);
    assert.equal(typeof source.onended, 'function', `${label}: ${source.kind} has no cleanup`);
    assert.ok(source.startedAt >= note.when - 1e-9,
      `${label}: ${source.kind} starts ${source.startedAt} before note.when ${note.when}`);
  }

  for (const gain of audibleGains(destination)) {
    assert.ok(gain.gain.min > 0,
      `${label}: an audible gain hit ${gain.gain.min} — that is a click`);
  }

  let sum = 0;
  for (const source of startedSources) {
    for (const product of pathProducts(source, destination)) {
      assert.ok(product <= PER_SOURCE_PEAK,
        `${label}: a source reaches the bus at ${product.toFixed(3)}`);
      sum += product;
    }
  }
  assert.ok(sum <= SUM_PEAK, `${label}: summed peak ${sum.toFixed(3)} is too hot`);

  const panner = created.find((n) => n.kind === 'panner');
  assert.ok(panner, `${label}: no StereoPanner`);
  assert.equal(panner.pan.max, Math.max(Math.min(note.pan ?? 0, 1), -1),
    `${label}: note.pan was not honoured`);

  if (cancelAfter) {
    ctx.currentTime = note.when + 0.05;
    handle.cancel();
    handle.cancel();   // a second cancel must be harmless
    for (const source of startedSources) {
      // A source scheduled to start after the cancel cannot be stopped before
      // it starts; it is silent either way, the output has already faded.
      const limit = Math.max(ctx.currentTime + 0.2, source.startedAt + 0.02);
      assert.ok(source.stoppedAt <= limit,
        `${label}: cancel left ${source.kind} running until ${source.stoppedAt}`);
    }
  }

  const tail = Math.max(...startedSources.map((s) => s.stoppedAt)) - note.when;

  // Fire the ended callbacks the way the browser would, then prove the note
  // disposed of every node it made.
  for (const source of startedSources) source.onended();
  const leaked = created.filter((n) => n !== destination && !n.disconnected);
  assert.equal(leaked.length, 0,
    `${label}: ${leaked.length} node(s) left connected (${leaked.map((n) => n.kind).join(', ')})`);

  return { tail, sum, nodes: created.length, ctx, events: automation.slice(), graph: created.slice() };
}

const PITCHED_NOTES = {
  pad: [
    { midi: 45, duration: 8 }, { midi: 60, duration: 6 }, { midi: 72, duration: 12 },
  ],
  bass: [
    { midi: 28, duration: 2 }, { midi: 41, duration: 1.5 }, { midi: 48, duration: 4 },
  ],
  melody: [
    { midi: 60, duration: 1 }, { midi: 72, duration: 0.4 }, { midi: 84, duration: 3 },
  ],
  texture: [
    { midi: 79, duration: 4 }, { midi: 91, duration: 2 }, { midi: 100, duration: 8 },
  ],
  arp: [
    { midi: 60, duration: 0.075 }, { midi: 72, duration: 0.3 }, { midi: 84, duration: 0.15 },
  ],
};

const EDGES = [
  { velocity: 0, pan: -1 },
  { velocity: 1, pan: 1 },
  { velocity: 0.5, pan: 0 },
  { velocity: 0.18, pan: 0.6 },
];

function notesFor(track) {
  const notes = [];
  if (track === 'percussion') {
    for (const kind of ['low', 'mid', 'high']) {
      for (const edge of EDGES) {
        notes.push({
          midi: null, freq: null, kind, duration: 0.25, when: 0.5, ...edge,
        });
      }
    }
    return notes;
  }
  for (const shape of PITCHED_NOTES[track]) {
    for (const edge of EDGES) {
      notes.push({ freq: null, kind: null, when: 0.5, ...shape, ...edge });
    }
  }
  return notes;
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// --------------------------------------------------------------------------
// Shape
// --------------------------------------------------------------------------

const EXPECTED = {
  pad: { warm: 'Warm', glass: 'Glass', strings: 'Strings', choir: 'Choir' },
  bass: { sub: 'Sub', round: 'Round', breath: 'Breath' },
  melody: { pluck: 'Pluck', bell: 'Bell', flute: 'Flute', keys: 'Keys' },
  texture: { sparkle: 'Sparkle', grains: 'Grains', chimes: 'Chimes', wash: 'Wash' },
  arp: { softPluck: 'Soft pluck', crystal: 'Crystal', marimba: 'Marimba' },
  percussion: { soft: 'Soft kit', hand: 'Hand drum', tick: 'Ticks' },
};

test('VOICES matches the contract exactly', () => {
  assert.deepEqual(Object.keys(VOICES), Object.keys(EXPECTED), 'track ids or order differ');
  for (const [track, patches] of Object.entries(EXPECTED)) {
    assert.deepEqual(Object.keys(VOICES[track]), Object.keys(patches),
      `${track}: voice ids or order differ`);
    for (const [id, label] of Object.entries(patches)) {
      const voice = VOICES[track][id];
      assert.equal(voice.label, label, `${track}.${id}: label`);
      assert.equal(typeof voice.play, 'function', `${track}.${id}: play`);
      assert.equal(Object.keys(voice).sort().join(','), 'defaults,label,play',
        `${track}.${id}: unexpected keys`);
    }
  }
});

test('importing the module touches no AudioContext', () => {
  // The import above ran before any global AudioContext existed; if the module
  // had constructed one at import time it would already have thrown.
  assert.equal(typeof globalThis.AudioContext, 'undefined');
});

// --------------------------------------------------------------------------
// Every patch, every edge
// --------------------------------------------------------------------------

for (const [track, patches] of Object.entries(EXPECTED)) {
  for (const id of Object.keys(patches)) {
    test(`${track}.${id} plays cleanly across the range`, () => {
      const patch = VOICES[track][id];
      for (const note of notesFor(track)) {
        const label = `${track}.${id} ${JSON.stringify(note)}`;
        // Twice: several patches make random choices about layer counts.
        playAndCheck(label, patch, note);
        playAndCheck(label, patch, note);
      }
    });

    test(`${track}.${id} cancels and cleans up`, () => {
      const patch = VOICES[track][id];
      for (const note of notesFor(track)) {
        playAndCheck(`${track}.${id} cancel`, patch, note, { cancelAfter: true });
      }
    });
  }
}

// --------------------------------------------------------------------------
// Musical constraints
// --------------------------------------------------------------------------

test('arp patches stay short enough to articulate 1/16 at 120 bpm', () => {
  const note = { midi: 72, freq: null, kind: null, when: 0.5, duration: 0.075, velocity: 0.9, pan: 0 };
  for (const id of Object.keys(VOICES.arp)) {
    const { tail } = playAndCheck(`arp.${id}`, VOICES.arp[id], note);
    assert.ok(tail <= 0.8, `arp.${id}: ${tail.toFixed(2)}s tail would smear a 0.125s step`);
  }
});

test('percussion tails are short and pads are long', () => {
  const hit = { midi: null, freq: null, kind: 'low', when: 0.5, duration: 0.25, velocity: 0.8, pan: 0 };
  for (const id of Object.keys(VOICES.percussion)) {
    const { tail } = playAndCheck(`percussion.${id}`, VOICES.percussion[id], hit);
    assert.ok(tail <= 1, `percussion.${id}: ${tail.toFixed(2)}s tail`);
  }
  const held = { midi: 57, freq: null, kind: null, when: 0.5, duration: 8, velocity: 0.7, pan: 0 };
  for (const id of Object.keys(VOICES.pad)) {
    const { tail } = playAndCheck(`pad.${id}`, VOICES.pad[id], held, {});
    assert.ok(tail >= held.duration + 3,
      `pad.${id}: tail ${tail.toFixed(2)}s leaves no release`);
    assert.ok(tail <= held.duration + 8, `pad.${id}: ${tail.toFixed(2)}s tail is runaway`);
  }
});

test('velocity 0 and velocity 1 differ in level, and 0 is near silent', () => {
  for (const [track, patches] of Object.entries(EXPECTED)) {
    for (const id of Object.keys(patches)) {
      const base = track === 'percussion'
        ? { midi: null, freq: null, kind: 'mid', duration: 0.25 }
        : { midi: 62, freq: null, kind: null, duration: 1.5 };
      const quiet = playAndCheck(`${track}.${id} v0`, VOICES[track][id],
        { ...base, when: 0.5, velocity: 0, pan: 0 });
      const loud = playAndCheck(`${track}.${id} v1`, VOICES[track][id],
        { ...base, when: 0.5, velocity: 1, pan: 0 });
      assert.ok(quiet.sum < loud.sum * 0.2,
        `${track}.${id}: velocity 0 is not quiet (${quiet.sum} vs ${loud.sum})`);
    }
  }
});

test('a note.freq overrides midi, and a missing when starts at the clock', () => {
  const ctx = new MockAudioContext();
  ctx.currentTime = 3;
  const destination = makeNode('gain');
  created = [];
  startedSources = [];
  const handle = VOICES.melody.bell.play(ctx, destination, {
    midi: 60, freq: 987.77, velocity: 0.8, duration: 1, when: undefined, pan: 0, kind: null,
  });
  assert.ok(startedSources.every((s) => s.startedAt >= 3), 'scheduled before the clock');
  const carrier = created.find((n) => n.kind === 'oscillator');
  assert.ok(Math.abs(carrier.frequency.max - 987.77) < 3500, 'freq was ignored');
  handle.cancel();
  for (const source of startedSources) source.onended();
});

test('a note scheduled in the past is pulled forward, not started late', () => {
  const ctx = new MockAudioContext();
  ctx.currentTime = 10;
  const destination = makeNode('gain');
  created = [];
  startedSources = [];
  VOICES.pad.warm.play(ctx, destination, {
    midi: 55, freq: null, velocity: 0.7, duration: 4, when: 2, pan: 0, kind: null,
  });
  assert.ok(startedSources.every((s) => s.startedAt >= 10), 'a source was started in the past');
  for (const source of startedSources) source.onended();
});

// --------------------------------------------------------------------------
// Sustained playing must not accumulate nodes
// --------------------------------------------------------------------------

test('a long run leaves nothing connected and reuses the noise buffers', () => {
  const ctx = new MockAudioContext();
  const destination = makeNode('gain');
  let live = 0;
  for (let round = 0; round < 12; round++) {
    for (const [track, patches] of Object.entries(EXPECTED)) {
      for (const id of Object.keys(patches)) {
        created = [];
        startedSources = [];
        const note = track === 'percussion'
          ? { midi: null, freq: null, kind: ['low', 'mid', 'high'][round % 3],
            duration: 0.25, when: round * 0.5, velocity: 0.6, pan: 0 }
          : { midi: 48 + round, freq: null, kind: null,
            duration: 1, when: round * 0.5, velocity: 0.6, pan: (round % 3) - 1 };
        const handle = VOICES[track][id].play(ctx, destination, note);
        if (round % 4 === 3) handle.cancel();
        for (const source of startedSources) source.onended();
        live += created.filter((n) => n !== destination && !n.disconnected).length;
      }
    }
  }
  assert.equal(live, 0, `${live} nodes survived their notes`);
  // White and pink, generated once each for the lifetime of the context.
  assert.ok(ctx.buffersCreated <= 2, `${ctx.buffersCreated} noise buffers built`);
});

// --------------------------------------------------------------------------
// Patches (v3): defaults, honouring, and the promise that no patch is v2
// --------------------------------------------------------------------------

const OSCS = ['sine', 'triangle', 'sawtooth', 'square'];
const FILTERS = ['lowpass', 'highpass', 'bandpass', 'notch'];

/** The Patch schema from the v3 addendum plus the v5 morph fields. */
const SCHEMA = {
  source: {
    osc1: { oneOf: OSCS },
    osc2: { oneOf: [...OSCS, null] },
    shape1: { range: [0, 3] },
    shape2: { range: [0, 3], orNull: true },
    mix: { range: [0, 1] },
    detune: { range: [0, 50] },
    octave: { oneOf: [-1, 0, 1] },
  },
  filter: {
    type: { oneOf: FILTERS },
    cutoff: { range: [40, 12000] },
    q: { range: [0.1, 20] },
    envAmount: { range: [0, 1] },
  },
  adsr: {
    attack: { range: [0.001, 8] },
    decay: { range: [0.001, 8] },
    sustain: { range: [0, 1] },
    release: { range: [0.01, 12] },
  },
  sends: {
    reverb: { range: [0, 1] },
    delay: { range: [0, 1] },
  },
};

/** Every corner of the schema at once, plus the awkward ends of it. */
const EXTREME = {
  source: { osc1: 'square', osc2: 'sawtooth', mix: 1, detune: 50, octave: 1 },
  filter: { type: 'lowpass', cutoff: 12000, q: 20, envAmount: 1 },
  adsr: { attack: 8, decay: 8, sustain: 1, release: 12 },
  sends: { reverb: 1, delay: 1 },
};

const EXTREMES = [
  EXTREME,
  {
    source: { osc1: 'sine', osc2: null, mix: 0, detune: 0, octave: -1 },
    filter: { type: 'highpass', cutoff: 40, q: 0.1, envAmount: 0 },
    adsr: { attack: 0.001, decay: 0.001, sustain: 0, release: 0.01 },
    sends: { reverb: 0, delay: 0 },
  },
  {
    source: { osc1: 'triangle', osc2: 'square', mix: 0.5, detune: 25, octave: 0 },
    filter: { type: 'bandpass', cutoff: 12000, q: 20, envAmount: 1 },
    adsr: { attack: 0.001, decay: 8, sustain: 1, release: 12 },
    sends: { reverb: 0.5, delay: 0.5 },
  },
  {
    source: { osc1: 'sawtooth', osc2: 'sine', mix: 0, detune: 50, octave: 1 },
    filter: { type: 'notch', cutoff: 40, q: 20, envAmount: 0.5 },
    adsr: { attack: 8, decay: 0.001, sustain: 0.5, release: 0.01 },
    sends: { reverb: 1, delay: 0 },
  },
];

/** Only one field set — everything else has to come from the voice's defaults. */
const PARTIALS = [
  { adsr: { attack: 0.001 } },
  { filter: { q: 20 } },
  { source: { octave: -1 } },
  { source: { shape1: 2.5 } },
  { source: { shape1: 0.25, shape2: 2.75 } },
  { sends: { reverb: 1 } },
  {},
];

/** What a buggy caller looks like. The engine sanitises; the voice checks anyway. */
const RUBBISH = [
  null,
  'lowpass',
  42,
  { source: 'nonsense', filter: null, adsr: undefined, sends: [] },
  { source: { osc1: 'moog', osc2: 7, shape1: 'loud', shape2: Infinity, mix: NaN, detune: -20, octave: 4 },
    filter: { type: '', cutoff: Infinity, q: -1, envAmount: 'a lot' },
    adsr: { attack: null, decay: -5, sustain: 12, release: NaN },
    sends: { reverb: 'wet', delay: null } },
];

function inRange(value, [lo, hi]) {
  return Number.isFinite(value) && value >= lo && value <= hi;
}

/**
 * Several voices make random choices — how many glints, how many grains, how
 * far a partial is detuned — so two runs of the same note are not the same
 * graph. Pin the stream and they are, which is the only way to attribute a
 * difference between two renders to the patch rather than to the dice.
 */
function withSeed(seed, fn) {
  const real = Math.random;
  let state = seed >>> 0;
  Math.random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  try {
    return fn();
  } finally {
    Math.random = real;
  }
}

test('every voice publishes a complete, in-range default patch', () => {
  for (const [track, patches] of Object.entries(EXPECTED)) {
    for (const id of Object.keys(patches)) {
      const { defaults } = VOICES[track][id];
      const where = `${track}.${id} defaults`;
      assert.ok(defaults && typeof defaults === 'object', `${where}: missing`);
      assert.deepEqual(Object.keys(defaults).sort(), ['adsr', 'filter', 'sends', 'source'],
        `${where}: wrong groups`);
      for (const [group, fields] of Object.entries(SCHEMA)) {
        assert.deepEqual(Object.keys(defaults[group]).sort(), Object.keys(fields).sort(),
          `${where}.${group}: wrong fields`);
        for (const [field, rule] of Object.entries(fields)) {
          const value = defaults[group][field];
          if (rule.oneOf) {
            assert.ok(rule.oneOf.includes(value),
              `${where}.${group}.${field}: ${JSON.stringify(value)} is not in the schema`);
          } else if (!(rule.orNull && value === null)) {
            assert.ok(inRange(value, rule.range),
              `${where}.${group}.${field}: ${value} is outside ${rule.range.join('–')}`);
          }
        }
      }
      // A voice with no second oscillator must not claim a blend of one.
      if (defaults.source.osc2 === null) {
        assert.equal(defaults.source.mix, 0, `${where}: osc2 is null but mix is not 0`);
      }
      // The numeric shapes and the legacy strings must describe the same sound.
      assert.equal(defaults.source.shape1, OSCS.indexOf(defaults.source.osc1),
        `${where}: shape1 and osc1 disagree`);
      assert.equal(defaults.source.shape2,
        defaults.source.osc2 === null ? null : OSCS.indexOf(defaults.source.osc2),
        `${where}: shape2 and osc2 disagree`);
    }
  }
});

test('defaults are frozen: the editor cannot corrupt the library', () => {
  const { defaults } = VOICES.pad.warm;
  assert.throws(() => { defaults.adsr.attack = 99; }, `pad.warm defaults are writable`);
  assert.equal(VOICES.pad.warm.defaults.adsr.attack, defaults.adsr.attack);
});

/**
 * Sends are the engine's to apply, not a voice's. No voice may quietly turn
 * itself up because a patch asked for reverb.
 */
test('a sends-only patch changes nothing a voice renders', () => {
  for (const [track, patches] of Object.entries(EXPECTED)) {
    for (const id of Object.keys(patches)) {
      const note = track === 'percussion'
        ? { midi: null, freq: null, kind: 'mid', duration: 0.25, when: 0.5, velocity: 0.7, pan: 0 }
        : { midi: 60, freq: null, kind: null, duration: 1.5, when: 0.5, velocity: 0.7, pan: 0 };
      const plain = withSeed(9, () => playAndCheck(`${track}.${id} defaults`, VOICES[track][id],
        note, { patch: VOICES[track][id].defaults }));
      const wet = withSeed(9, () => playAndCheck(`${track}.${id} sends`, VOICES[track][id], note,
        { patch: { ...VOICES[track][id].defaults, sends: { reverb: 1, delay: 1 } } }));
      assert.equal(wet.nodes, plain.nodes, `${track}.${id}: sends changed the node graph`);
      assert.ok(Math.abs(plain.sum - wet.sum) < 1e-12,
        `${track}.${id}: sends changed the dry level (${plain.sum} vs ${wet.sum})`);
    }
  }
});

for (const [track, patches] of Object.entries(EXPECTED)) {
  for (const id of Object.keys(patches)) {
    test(`${track}.${id} survives every patch the schema allows`, () => {
      const voice = VOICES[track][id];
      const all = [undefined, voice.defaults, ...PARTIALS, ...EXTREMES, ...RUBBISH];
      for (const note of notesFor(track)) {
        for (const patch of all) {
          playAndCheck(`${track}.${id} ${JSON.stringify(patch)}`, voice, note, { patch });
        }
      }
    });

    test(`${track}.${id} cancels cleanly mid-patch`, () => {
      const voice = VOICES[track][id];
      for (const patch of [EXTREME, PARTIALS[0], voice.defaults]) {
        for (const note of notesFor(track)) {
          playAndCheck(`${track}.${id} cancel`, voice, note, { patch, cancelAfter: true });
        }
      }
    });
  }
}

/** The amp envelope's rise: `set` to silence at the onset, ramp up to the top. */
function attackRamps(events) {
  return events
    .filter((e) => e.name === 'gain.gain' && e.kind === 'exponential' && e.value > 2e-4)
    .map((e) => e.time);
}

const rampAt = (events, time) => attackRamps(events).some((at) => Math.abs(at - time) < 1e-6);

/**
 * What each voice's own attack is for the note below — the v2 numbers, written
 * out so that routing the unpatched path through the patch defaults by mistake
 * shows up here rather than in someone's ears.
 */
const V2_ATTACK = {
  pad: { warm: 3.2, glass: 2.8, strings: 2.6, choir: 3.5 },
  bass: { sub: 0.12, round: 0.05, breath: 0.18 },
  melody: { pluck: 0.006, bell: 0.005, flute: 0.09, keys: 0.004 },
  texture: { sparkle: 0.02, grains: null, chimes: 0.008, wash: 3 },
  arp: { softPluck: 0.006, crystal: 0.003, marimba: 0.003 },
  percussion: { soft: 0.008, hand: 0.005, tick: 0.003 },
};

/** Long enough that every pad and wash hits the top of its own attack clamp. */
function attackNote(track) {
  if (track === 'percussion') {
    return { midi: null, freq: null, kind: 'low', duration: 0.25, when: 0.5, velocity: 0.8, pan: 0 };
  }
  const duration = track === 'pad' || track === 'texture' ? 12 : 1;
  return { midi: 60, freq: null, kind: null, duration, when: 0.5, velocity: 0.8, pan: 0 };
}

test('without a patch every voice keeps its own v2 envelope', () => {
  for (const [track, patches] of Object.entries(EXPECTED)) {
    for (const id of Object.keys(patches)) {
      const expected = V2_ATTACK[track][id];
      if (expected === null) continue;          // grains scatters; checked below
      const note = attackNote(track);
      const plain = playAndCheck(`${track}.${id} v2`, VOICES[track][id], note);
      assert.ok(rampAt(plain.events, note.when + expected),
        `${track}.${id}: no attack ramp at its own ${expected}s (saw ${attackRamps(plain.events)})`);
      // And where the published default is far enough from the voice's own
      // attack to be told apart from its other layers, the unpatched note must
      // not have quietly used it instead.
      const published = VOICES[track][id].defaults.adsr.attack;
      if (Math.abs(published - expected) > 0.05) {
        assert.ok(!rampAt(plain.events, note.when + published),
          `${track}.${id}: unpatched note used the default attack ${published}s`);
      }
    }
  }
});

test('grains leaves its cloud gain alone without a patch, and shapes it with one', () => {
  const note = { midi: 79, freq: null, kind: null, duration: 3, when: 0.5, velocity: 0.8, pan: 0 };
  const plain = playAndCheck('texture.grains v2', VOICES.texture.grains, note);
  const flat = plain.graph.filter((n) => n.kind === 'gain' && n.gain.min === 1 && n.gain.max === 1);
  assert.ok(flat.length >= 1, 'the cloud gain was enveloped without a patch');
  const shaped = playAndCheck('texture.grains patched', VOICES.texture.grains, note,
    { patch: { adsr: { attack: 0.001 } } });
  assert.ok(rampAt(shaped.events, note.when + 0.001), 'the cloud contour ignored the patch attack');
});

test('a patch moves the attack, and a partial patch moves only the attack', () => {
  for (const [track, patches] of Object.entries(EXPECTED)) {
    for (const id of Object.keys(patches)) {
      const note = attackNote(track);
      for (const attack of [0.001, 4]) {
        const run = playAndCheck(`${track}.${id} attack ${attack}`, VOICES[track][id], note,
          { patch: { adsr: { attack } } });
        assert.ok(rampAt(run.events, note.when + attack),
          `${track}.${id}: attack ${attack}s did not move the ramp (saw ${attackRamps(run.events)})`);
      }
      // The rest of the patch came from the defaults, so the voice's own attack
      // is gone — that is what "merged over the voice's own defaults" means.
      const partial = playAndCheck(`${track}.${id} partial`, VOICES[track][id], note,
        { patch: { adsr: { attack: 0.001 } } });
      const own = V2_ATTACK[track][id];
      if (own !== null && own > 0.01) {
        assert.ok(!rampAt(partial.events, note.when + own),
          `${track}.${id}: the patch attack did not replace the voice's own`);
      }
    }
  }
});

test('release caps the tail, and sustain 0 ends the note at the decay', () => {
  for (const [track, patches] of Object.entries(EXPECTED)) {
    for (const id of Object.keys(patches)) {
      const note = attackNote(track);
      const short = playAndCheck(`${track}.${id} short release`, VOICES[track][id], note, {
        patch: { adsr: { attack: 0.01, decay: 0.05, sustain: 0.5, release: 0.05 } },
      });
      const long = playAndCheck(`${track}.${id} long release`, VOICES[track][id], note, {
        patch: { adsr: { attack: 0.01, decay: 0.05, sustain: 0.5, release: 8 } },
      });
      // Grains is the exception: its cloud is a scatter of one-shots, so the
      // release can only hold an already-empty gain open.
      if (!(track === 'texture' && id === 'grains')) {
        assert.ok(long.tail > short.tail,
          `${track}.${id}: release does not lengthen the tail (${short.tail} vs ${long.tail})`);
      }
      assert.ok(short.tail <= note.duration + 1.5,
        `${track}.${id}: a 0.05s release still left a ${short.tail.toFixed(2)}s tail`);
    }
  }
});

test('a resonant patch is quieter, never louder, than a calm one', () => {
  for (const [track, patches] of Object.entries(EXPECTED)) {
    for (const id of Object.keys(patches)) {
      const note = attackNote(track);
      const calm = playAndCheck(`${track}.${id} q calm`, VOICES[track][id], note,
        { patch: { filter: { q: 0.7 } } });
      const rung = playAndCheck(`${track}.${id} q 20`, VOICES[track][id], note,
        { patch: { filter: { q: 20 } } });
      assert.ok(rung.sum <= calm.sum + 1e-9,
        `${track}.${id}: Q 20 reaches the bus at ${rung.sum.toFixed(3)} vs ${calm.sum.toFixed(3)}`);
    }
  }
});

test('an octave patch really moves the pitch', () => {
  for (const track of ['pad', 'bass', 'melody', 'texture', 'arp']) {
    for (const id of Object.keys(EXPECTED[track])) {
      const note = { midi: 60, freq: null, kind: null, duration: 1.5, when: 0.5, velocity: 0.8, pan: 0 };
      const tops = [];
      for (const octave of [-1, 0, 1]) {
        const run = withSeed(21, () => playAndCheck(`${track}.${id} octave ${octave}`,
          VOICES[track][id], note, { patch: { source: { octave } } }));
        // Grains has no oscillator to transpose: its pitch lives in the centre
        // frequency of the band each grain is filtered through. The patch's own
        // filter sits at its published cutoff and is not one of those bands.
        const oscs = run.graph.filter((n) => n.kind === 'oscillator');
        const bands = run.graph.filter((n) => n.kind === 'biquad'
          && n.frequency.max !== VOICES[track][id].defaults.filter.cutoff);
        const pitched = oscs.length ? oscs : bands;
        tops.push(Math.max(...pitched.map((n) => n.frequency.max)));
      }
      assert.ok(tops[0] < tops[1] && tops[1] < tops[2],
        `${track}.${id}: octave did nothing (${tops.join(', ')})`);
    }
  }
});

test('an inapplicable source field never silences a voice', () => {
  // The FM, partial and physical voices have no oscillator stack to re-type.
  const ignoring = [
    ['pad', 'glass'], ['melody', 'bell'], ['melody', 'flute'], ['melody', 'keys'],
    ['texture', 'sparkle'], ['texture', 'grains'], ['texture', 'chimes'],
    ['arp', 'crystal'], ['arp', 'marimba'],
    ['percussion', 'soft'], ['percussion', 'hand'], ['percussion', 'tick'],
  ];
  for (const [track, id] of ignoring) {
    const note = attackNote(track);
    const plain = playAndCheck(`${track}.${id} plain`, VOICES[track][id], note);
    for (const source of [{ osc1: 'square', osc2: 'sawtooth', mix: 1 }, { mix: 0 }, { osc2: null }]) {
      const run = playAndCheck(`${track}.${id} ${JSON.stringify(source)}`, VOICES[track][id], note,
        { patch: { source } });
      assert.ok(run.sum > plain.sum * 0.25,
        `${track}.${id}: an inapplicable source field gutted the voice`);
    }
  }
});

// --------------------------------------------------------------------------
// Waveform morphing (v5): the continuous shape dial
// --------------------------------------------------------------------------

const MORPH_NOTE = {
  midi: 60, freq: null, kind: null, duration: 1.5, when: 0.5, velocity: 0.8, pan: 0,
};

/** Every oscillator's effective waveform: a native type or its PeriodicWave. */
const oscShapes = (run) => run.graph
  .filter((n) => n.kind === 'oscillator')
  .map((n) => n.periodicWave ?? n.type);

const coeffsDiffer = (a, b) => {
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > 1e-6) return true;
  }
  return false;
};

test('a shape patch audibly changes the waveform: pad.warm sine vs saw', () => {
  const sine = withSeed(33, () => playAndCheck('pad.warm shape 0', VOICES.pad.warm, MORPH_NOTE,
    { patch: { source: { shape1: 0, shape2: 0 } } }));
  const saw = withSeed(33, () => playAndCheck('pad.warm shape 2', VOICES.pad.warm, MORPH_NOTE,
    { patch: { source: { shape1: 2, shape2: 2 } } }));
  // Four saw layers at shape 2 and none at shape 0 — this is the regression
  // this wave exists for: the dial MUST reach the scheduled sources.
  const saws = (run) => oscShapes(run).filter((s) => s === 'sawtooth').length;
  assert.ok(saws(saw) >= 4, `shape 2 built only ${saws(saw)} sawtooth oscillators`);
  assert.equal(saws(sine), 0, 'shape 0 still built sawtooth oscillators');
  assert.notDeepEqual(oscShapes(sine), oscShapes(saw),
    'shape 0 and shape 2 scheduled identical oscillators');
});

test('integer shapes are the native types: 2.0 sounds like sawtooth', () => {
  for (const [shape, type] of [[0, 'sine'], [1, 'triangle'], [2, 'sawtooth'], [3, 'square']]) {
    const run = withSeed(33, () => playAndCheck(`pad.warm shape ${shape}`, VOICES.pad.warm,
      MORPH_NOTE, { patch: { source: { shape1: shape, shape2: shape } } }));
    assert.ok(oscShapes(run).filter((s) => s === type).length >= 4,
      `shape ${shape} did not schedule native ${type} oscillators`);
  }
});

test('a fractional shape is a PeriodicWave distinct from both neighbours', () => {
  const run = withSeed(33, () => playAndCheck('pad.warm shape 1.5', VOICES.pad.warm, MORPH_NOTE,
    { patch: { source: { shape1: 1.5, shape2: 1.5 } } }));
  const morphed = run.graph.filter((n) => n.kind === 'oscillator' && n.periodicWave);
  assert.ok(morphed.length >= 4, `only ${morphed.length} oscillators were morphed`);
  const wave = morphed[0].periodicWave;
  assert.equal(wave, shapeWave(run.ctx, 1.5), 'the scheduled wave is not the cached 1.5 wave');
  for (const osc of morphed) {
    assert.equal(osc.periodicWave, wave, 'layers of one shape rebuilt the wave');
  }
  assert.ok(coeffsDiffer(wave.imag, shapeWave(run.ctx, 1).imag), '1.5 collapsed to triangle');
  assert.ok(coeffsDiffer(wave.imag, shapeWave(run.ctx, 2).imag), '1.5 collapsed to sawtooth');
});

test('the dial\'s integer stops match their canonical spectra', () => {
  const ctx = new MockAudioContext();
  const sine = shapeWave(ctx, 0).imag;
  const tri = shapeWave(ctx, 1).imag;
  const saw = shapeWave(ctx, 2).imag;
  const square = shapeWave(ctx, 3).imag;
  assert.ok(sine[1] > 0.999 && Math.abs(sine[2]) < 1e-6 && Math.abs(sine[3]) < 1e-6,
    'shape 0 is not a pure sine');
  assert.ok(Math.abs(tri[2]) < 1e-6 && Math.abs(tri[3] / tri[1] + 1 / 9) < 1e-6,
    'shape 1 is not 1/n² odd alternating');
  assert.ok(Math.abs(saw[2] / saw[1] - 1 / 2) < 1e-6 && Math.abs(saw[3] / saw[1] - 1 / 3) < 1e-6,
    'shape 2 is not 1/n');
  assert.ok(Math.abs(square[2]) < 1e-6 && Math.abs(square[3] / square[1] - 1 / 3) < 1e-6,
    'shape 3 is not 1/n odd');
});

test('coefficient RMS stays level across the dial', () => {
  const ctx = new MockAudioContext();
  const rmsOf = (imag) => {
    let sum = 0;
    for (const v of imag) sum += v * v;
    return Math.sqrt(sum / (imag.length - 1));
  };
  const values = [];
  for (let s = 0; s <= 3.0001; s += 0.5) values.push(rmsOf(shapeWave(ctx, s).imag));
  const hi = Math.max(...values);
  const lo = Math.min(...values);
  assert.ok(hi / lo < 1.02,
    `coefficient RMS drifts across the dial (${values.map((v) => v.toFixed(4)).join(', ')})`);
});

test('morphed waves are cached per context and quantised to 1/16', () => {
  const ctx = new MockAudioContext();
  const wave = shapeWave(ctx, 1.5);
  assert.equal(shapeWave(ctx, 1.5), wave, 'the same shape rebuilt its wave');
  assert.equal(shapeWave(ctx, 1.51), wave, 'a sub-1/16 nudge is a different wave');
  assert.notEqual(shapeWave(ctx, 1.5625), wave, 'the next 1/16 step reused the wrong wave');
  assert.notEqual(shapeWave(new MockAudioContext(), 1.5), wave, 'waves leaked across contexts');
});

test('legacy osc strings still work, and an explicit shape number wins', () => {
  const legacy = withSeed(33, () => playAndCheck('pad.warm legacy strings', VOICES.pad.warm,
    MORPH_NOTE, { patch: { source: { osc1: 'sawtooth', osc2: 'sawtooth' } } }));
  assert.ok(oscShapes(legacy).filter((s) => s === 'sawtooth').length >= 4,
    "the legacy 'sawtooth' string no longer reaches the oscillators");
  const wins = withSeed(33, () => playAndCheck('pad.warm shape beats string', VOICES.pad.warm,
    MORPH_NOTE, { patch: { source: { osc1: 'sawtooth', shape1: 0, osc2: 'sawtooth', shape2: 0 } } }));
  assert.equal(oscShapes(wins).filter((s) => s === 'sawtooth').length, 0,
    'a legacy string overrode an explicit shape number');
});

test('shape2: null is the single-oscillator setting, even against an osc2 string', () => {
  const plain = withSeed(33, () => playAndCheck('pad.warm plain', VOICES.pad.warm, MORPH_NOTE));
  for (const source of [{ shape2: null, mix: 1 }, { shape2: null, osc2: 'triangle', mix: 1 }]) {
    const run = withSeed(33, () => playAndCheck(`pad.warm ${JSON.stringify(source)}`,
      VOICES.pad.warm, MORPH_NOTE, { patch: { source } }));
    assert.ok(run.sum > plain.sum * 0.5, 'mix 1 with no second shape faded the voice');
    assert.equal(oscShapes(run).filter((s) => s === 'triangle').length, 0,
      'a null shape2 left second-oscillator layers behind');
  }
});

// --------------------------------------------------------------------------
// Runner
// --------------------------------------------------------------------------

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
