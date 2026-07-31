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

  createWaveShaper() {
    const node = makeNode('shaper');
    let curve = null;
    let oversample = 'none';
    Object.defineProperty(node, 'curve', {
      get: () => curve,
      set(value) {
        assert.ok(value instanceof Float32Array, 'shaper.curve: must be a Float32Array');
        assert.ok(value.length >= 2, 'shaper.curve: too few points');
        // A shaping curve reaching far past ±1 is a gain stage wearing a
        // shaper's hat; the exact peak is checked against the stack it was
        // drawn for in the v20 fold tests below.
        for (const v of value) {
          assert.ok(Number.isFinite(v), 'shaper.curve: non-finite point');
          assert.ok(Math.abs(v) <= 1.5, `shaper.curve: ${v} is a long way outside ±1`);
        }
        curve = value;
      },
    });
    Object.defineProperty(node, 'oversample', {
      get: () => oversample,
      set(value) {
        assert.ok(['none', '2x', '4x'].includes(value), `shaper.oversample: ${value}`);
        oversample = value;
      },
    });
    return node;
  }

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

  // AUDIT FIX (tests-honesty): the loudness law is about what sounds
  // TOGETHER. The old static sum added every source a note ever starts,
  // which over-counted sequential one-shots — the call's chirps never
  // overlap by design, yet their whole phrase was summed as one instant.
  // The law is now the maximum CONCURRENT sum: at every moment some source
  // is playing, add up exactly the sources sounding then.
  let sum = 0;
  const active = [];
  for (const source of startedSources) {
    let contribution = 0;
    for (const product of pathProducts(source, destination)) {
      assert.ok(product <= PER_SOURCE_PEAK,
        `${label}: a source reaches the bus at ${product.toFixed(3)}`);
      contribution += product;
    }
    active.push({ from: source.startedAt, to: source.stoppedAt, contribution });
  }
  for (const { from } of active) {
    let atOnce = 0;
    for (const other of active) {
      if (other.from <= from + 1e-9 && from < other.to - 1e-9) atOnce += other.contribution;
    }
    if (atOnce > sum) sum = atOnce;
  }
  assert.ok(sum <= SUM_PEAK, `${label}: concurrent peak ${sum.toFixed(3)} is too hot`);

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
  pad: {
    warm: 'Warm', glass: 'Glass', strings: 'Strings', choir: 'Choir', polysaw: 'Poly saw',
  },
  bass: {
    sub: 'Sub', round: 'Round', breath: 'Breath',
    fingered: 'Fingered', sawbass: 'Saw bass', acid: 'Squelch', upright: 'Upright',
  },
  melody: {
    pluck: 'Pluck', bell: 'Bell', flute: 'Flute', keys: 'Keys', call: 'Call',
    tines: 'Tines', nylon: 'Nylon guitar', tape: 'Worn keys', stab: 'Organ stab',
  },
  texture: {
    sparkle: 'Sparkle', grains: 'Grains', chimes: 'Chimes', wash: 'Wash',
    colour: 'Coloured noise', cloud: 'Grain cloud', call: 'Call',
  },
  arp: {
    softPluck: 'Soft pluck', crystal: 'Crystal', marimba: 'Marimba', muted: 'Muted comp',
  },
  percussion: {
    soft: 'Soft kit', hand: 'Hand drum', tick: 'Ticks', dust: 'Worn kit',
  },
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
      assert.equal(Object.keys(voice).sort().join(','), 'controls,defaults,engineType,label,play',
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

/**
 * v18: a kit is tuned in semitones instead of by the octave switch, and its
 * noise component has a level of its own — so percussion publishes `pitch`
 * and `noise` where every other track publishes `octave`.
 */
const PERCUSSION_SOURCE = {
  osc1: { oneOf: OSCS },
  osc2: { oneOf: [...OSCS, null] },
  shape1: { range: [0, 3] },
  shape2: { range: [0, 3], orNull: true },
  mix: { range: [0, 1] },
  detune: { range: [0, 50] },
  pitch: { range: [-24, 24] },
  noise: { range: [0, 1] },
};

/**
 * v19: the two field families the sculpting surface adds. They ride on TOP of
 * the ordinary source schema — an octave switch and the morph fields stay
 * published either way — and a voice carries one family, the other, or
 * neither, never both.
 */
const SCULPT_SOURCE = {
  tilt: { range: [-1, 1] },
  bandCentre: { range: [60, 8000] },
  bandWidth: { range: [0.1, 4] },
  sweepRate: { range: [0, 0.5] },
  sweepDepth: { range: [0, 1] },
  gust: { range: [0, 1] },
  gustRate: { range: [0.02, 0.5] },
  burst: { range: [0, 1] },
  burstSharp: { range: [0, 1] },
  swell: { range: [0, 1] },
};

const CALL_SOURCE = {
  glide: { range: [-24, 24] },
  glideCurve: { range: [0, 1] },
  formant1: { range: [60, 8000] },
  formant2: { range: [60, 8000] },
  cadence: { range: [0.5, 8] },
  irregular: { range: [0, 1] },
};

/**
 * v20: the shape modifiers. One field so far, and it rides on top of the
 * ordinary source schema exactly as the v19 families do — but on a different
 * set of voices, the oscillator stacks.
 */
const FOLD_SOURCE = {
  fold: { range: [0, 1] },
};

/** Which voices carry which v19 family — the "only on the right voices" rule. */
const SCULPT_VOICES = [['texture', 'colour'], ['texture', 'cloud']];
const CALL_VOICES = [['melody', 'call'], ['texture', 'call']];
/** …and which carry the v20 modifiers: the oscillator-stack voices. */
const FOLD_VOICES = [
  ['pad', 'warm'], ['pad', 'strings'], ['pad', 'choir'], ['pad', 'polysaw'],
  ['bass', 'sub'], ['bass', 'round'], ['bass', 'breath'],
  ['bass', 'fingered'], ['bass', 'sawbass'], ['bass', 'acid'], ['bass', 'upright'],
  ['melody', 'pluck'], ['melody', 'nylon'], ['melody', 'tape'],
  ['arp', 'softPluck'], ['arp', 'muted'],
];
const carries = (list, track, id) => list.some(([t, i]) => t === track && i === id);

function schemaFor(track, id) {
  if (track === 'percussion') return { ...SCHEMA, source: PERCUSSION_SOURCE };
  const source = { ...SCHEMA.source };
  if (carries(SCULPT_VOICES, track, id)) Object.assign(source, SCULPT_SOURCE);
  if (carries(CALL_VOICES, track, id)) Object.assign(source, CALL_SOURCE);
  if (carries(FOLD_VOICES, track, id)) Object.assign(source, FOLD_SOURCE);
  return { ...SCHEMA, source };
}

/** Every corner of the schema at once, plus the awkward ends of it. */
const EXTREME = {
  source: { osc1: 'square', osc2: 'sawtooth', mix: 1, detune: 50, octave: 1, fold: 1 },
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
    source: { osc1: 'triangle', osc2: 'square', mix: 0.5, detune: 25, octave: 0, fold: 0.5 },
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
  // v20, and the defensive case: `fold` arriving with nothing beside it, which
  // is what a sanitiser that has just learned the field sends.
  { source: { fold: 1 } },
  { sends: { reverb: 1 } },
  {},
];

/** What a buggy caller looks like. The engine sanitises; the voice checks anyway. */
const RUBBISH = [
  null,
  'lowpass',
  42,
  { source: 'nonsense', filter: null, adsr: undefined, sends: [] },
  { source: { osc1: 'moog', osc2: 7, shape1: 'loud', shape2: Infinity, mix: NaN, detune: -20,
    octave: 4, fold: 'lots' },
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
      for (const [group, fields] of Object.entries(schemaFor(track, id))) {
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
  pad: {
    warm: 3.2, glass: 2.8, strings: 2.6, choir: 3.5,
    // v27: the one pad whose attack is a fraction of the note rather than
    // seconds of it — clamped at 1.4 for the 12 s note attackNote() plays.
    polysaw: 1.4,
  },
  bass: {
    sub: 0.12, round: 0.05, breath: 0.18,
    fingered: 0.008, sawbass: 0.012, acid: 0.006, upright: 0.012,
  },
  melody: {
    pluck: 0.006, bell: 0.005, flute: 0.09, keys: 0.004, call: 0.006,
    tines: 0.005, nylon: 0.005, tape: 0.006, stab: 0.006,
  },
  // v19: the three new voices have no v2 past to keep, so their unpatched
  // envelope IS their published default — which is what these numbers say.
  texture: {
    sparkle: 0.02, grains: null, chimes: 0.008, wash: 3, colour: 2.6, cloud: 1.2, call: 0.008,
  },
  arp: {
    softPluck: 0.006, crystal: 0.003, marimba: 0.003, muted: 0.004,
  },
  percussion: {
    soft: 0.008, hand: 0.005, tick: 0.003, dust: 0.008,
  },
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

test('audit: a kit\'s own defaults as a patch keep its character — the hat stays a hat', () => {
  // The audit's flagship voices finding: a percussion voice publishes ONE
  // filter and ONE adsr but plays three kinds, and applying the kit's own
  // defaults as a patch (which ANY dial nudge or Reset to default does) used
  // to swap each kind's authored character for the kit-wide one — the soft
  // kit's 6.75 kHz highpass hat went behind the mid's 1.39 kHz lowpass and
  // vanished (~32 dB down). A patch now RE-TUNES rather than replaces.
  for (const id of ['soft', 'dust', 'hand', 'tick']) {
    const voice = VOICES.percussion[id];
    for (const kind of ['low', 'mid', 'high']) {
      const note = { midi: 36, freq: 80, kind, lane: kind, duration: 0.3, when: 0.5, velocity: 0.9, pan: 0 };
      const bare = withSeed(41, () => playAndCheck(`percussion.${id}/${kind} bare`, voice, note));
      const patched = withSeed(41, () => playAndCheck(`percussion.${id}/${kind} own defaults`,
        voice, note, { patch: voice.defaults }));
      // The FILTERS a kind builds are its character: same types, and each
      // cutoff within a hair of where the voice authored it (the dial has not
      // moved, so the re-tune ratio is 1).
      // A SUPERSET, not an identity: percHand-style kits legitimately add the
      // kit-wide patch filter across the output (its own comment says so).
      // What must never happen is one of the KIND's own filters disappearing
      // or moving — that is the vanishing hat.
      const shape = (run) => biquads(run).map((n) => `${n.type}@${Math.round(n.frequency.max)}`).sort();
      const bareShape = shape(bare);
      const patchedShape = shape(patched);
      for (const filter of bareShape) {
        assert.ok(patchedShape.includes(filter),
          `percussion.${id}/${kind}: its own defaults as a patch lost or moved ${filter} `
          + `(built ${patchedShape.join(', ')})`);
      }
      // And it still reaches the bus at a comparable level — a kind filtered
      // into near-silence is the failure this test exists for.
      assert.ok(patched.sum > bare.sum * 0.5 && patched.sum < bare.sum * 2.5,
        `percussion.${id}/${kind}: level moved from ${bare.sum.toFixed(4)} to ${patched.sum.toFixed(4)} `
        + 'under its own defaults');
    }
  }
});

test('audit: a layer that declares its own waveform keeps it while the shape dial is untouched', () => {
  // The hand drum's ring is a triangle and sawbass's sub-octave is a sine,
  // inside groups whose other layers are not — one blanket assignment from
  // the shape dial used to overwrite both under ANY patch, so the voices'
  // own published defaults could not reproduce them.
  const hand = { midi: 36, freq: 80, kind: 'low', lane: 'low', duration: 0.3, when: 0.5, velocity: 0.9, pan: 0 };
  const handBare = withSeed(42, () => playAndCheck('percussion.hand bare', VOICES.percussion.hand, hand));
  const handPatched = withSeed(42, () => playAndCheck('percussion.hand own defaults',
    VOICES.percussion.hand, hand, { patch: VOICES.percussion.hand.defaults }));
  assert.deepEqual(oscShapes(handPatched).sort(), oscShapes(handBare).sort(),
    'the hand drum\'s triangle ring became a sine under its own defaults');

  const bassNote = { midi: 33, freq: 55, kind: null, duration: 1, when: 0.5, velocity: 0.8, pan: 0 };
  const sawBare = withSeed(42, () => playAndCheck('bass.sawbass bare', VOICES.bass.sawbass, bassNote));
  const sawPatched = withSeed(42, () => playAndCheck('bass.sawbass own defaults',
    VOICES.bass.sawbass, bassNote, { patch: VOICES.bass.sawbass.defaults }));
  assert.deepEqual(oscShapes(sawPatched).sort(), oscShapes(sawBare).sort(),
    'sawbass\'s sine sub-octave became a sawtooth under its own defaults');
});

test('release caps the tail, and sustain 0 ends the note at the decay', () => {
  for (const [track, patches] of Object.entries(EXPECTED)) {
    for (const id of Object.keys(patches)) {
      const note = attackNote(track);
      // source.irregular = 0 pins the call's humanised chirp timing, whose
      // random jitter otherwise swamps the release difference this test
      // measures (it flickered red/green run to run); every other voice
      // simply ignores the field.
      const short = playAndCheck(`${track}.${id} short release`, VOICES[track][id], note, {
        patch: { source: { irregular: 0 }, adsr: { attack: 0.01, decay: 0.05, sustain: 0.5, release: 0.05 } },
      });
      const long = playAndCheck(`${track}.${id} long release`, VOICES[track][id], note, {
        patch: { source: { irregular: 0 }, adsr: { attack: 0.01, decay: 0.05, sustain: 0.5, release: 8 } },
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
        // Control-rate oscillators (wash's Q wobble) are not pitch and must
        // not stand in for it; a voice whose only oscillator is one of those
        // is measured on its bands like a voice with no oscillator at all.
        const oscs = run.graph.filter((n) => n.kind === 'oscillator' && n.frequency.max >= 20);
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
    // v19: two voices with no oscillator at all, and a call whose one
    // oscillator answers shape1 but has nothing to blend against.
    ['texture', 'colour'], ['texture', 'cloud'], ['texture', 'call'], ['melody', 'call'],
    ['arp', 'crystal'], ['arp', 'marimba'],
    ['percussion', 'soft'], ['percussion', 'hand'], ['percussion', 'tick'],
    // v27: an FM pair and an additive drawbar stack, plus the new kit.
    ['melody', 'tines'], ['melody', 'stab'], ['percussion', 'dust'],
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
// v20 (1) — the triangle→saw segment is a PEAK SKEW, not a crossfade
// --------------------------------------------------------------------------

const MORPH_HARMONICS = 32;
/** Where the peak sits at the top of the segment, per the contract's "~99 %". */
const SKEW_MAX = 0.99;
/** The peak position the dial asks for at a point on the triangle→saw segment. */
const skewAt = (shape) => 0.5 + (SKEW_MAX - 0.5) * (shape - 1);

/**
 * The closed form, transcribed from the maths and not from the implementation:
 * a triangle whose peak sits `a` of the way through its rise has
 *
 *     b_n = (−1)^(n+1) · 2·sin(nπa) / (n²π²·a·(1−a))
 *
 * and every wave on the dial is normalised to unit coefficient power.
 */
function skewReference(a) {
  const b = new Float32Array(MORPH_HARMONICS + 1);
  let power = 0;
  for (let n = 1; n <= MORPH_HARMONICS; n++) {
    b[n] = ((n % 2 ? 1 : -1) * 2 * Math.sin(n * Math.PI * a))
      / (n * n * Math.PI * Math.PI * a * (1 - a));
    power += b[n] * b[n];
  }
  const norm = 1 / Math.sqrt(power);
  for (let n = 1; n <= MORPH_HARMONICS; n++) b[n] *= norm;
  return b;
}

/** Unit-power coefficients of a canonical shape, for an exact integer check. */
function canonicalReference(shape) {
  const b = new Float32Array(MORPH_HARMONICS + 1);
  let power = 0;
  for (let n = 1; n <= MORPH_HARMONICS; n++) {
    if (shape === 0) b[n] = n === 1 ? 1 : 0;
    else if (shape === 1) b[n] = n % 2 ? (n % 4 === 1 ? 1 : -1) / (n * n) : 0;
    else if (shape === 2) b[n] = 1 / n;
    else b[n] = n % 2 ? 1 / n : 0;
    power += b[n] * b[n];
  }
  const norm = 1 / Math.sqrt(power);
  for (let n = 1; n <= MORPH_HARMONICS; n++) b[n] *= norm;
  return b;
}

const assertCoeffs = (actual, expected, tolerance, what) => {
  for (let n = 1; n <= MORPH_HARMONICS; n++) {
    assert.ok(Math.abs(actual[n] - expected[n]) <= tolerance,
      `${what}: harmonic ${n} is ${actual[n]}, expected ${expected[n]}`);
  }
};

/** Each harmonic as a fraction of the fundamental — normalisation-independent. */
const ratios = (imag, upTo) => Array.from({ length: upTo }, (_, i) => imag[i + 1] / imag[1]);

test('v20 skew: the triangle→saw segment matches the closed form at every stop', () => {
  const ctx = new MockAudioContext();
  for (const shape of [1.0625, 1.25, 1.5, 1.75, 1.9375]) {
    assertCoeffs(shapeWave(ctx, shape).imag, skewReference(skewAt(shape)), 2e-6,
      `shape ${shape} (peak at ${(skewAt(shape) * 100).toFixed(1)} %)`);
  }
});

test('v20 skew: a = 0.5 is the symmetric triangle, exactly', () => {
  const ctx = new MockAudioContext();
  const half = skewReference(0.5);
  assertCoeffs(half, canonicalReference(1), 1e-6, 'the skew family at a = 0.5');
  assertCoeffs(shapeWave(ctx, 1).imag, half, 1e-6, 'the bottom of the segment');
  for (let n = 2; n <= MORPH_HARMONICS; n += 2) {
    assert.ok(Math.abs(half[n]) < 1e-9, `a = 0.5 has an even harmonic at ${n}`);
  }
});

test('v20 skew: a → 0.99 is the sawtooth spectrum within tolerance', () => {
  const near = ratios(skewReference(SKEW_MAX), 8);
  near.forEach((value, i) => {
    const n = i + 1;
    assert.ok(Math.abs(value - 1 / n) <= 0.02 / n,
      `a = ${SKEW_MAX}: harmonic ${n} is ${value.toFixed(5)} of the fundamental, `
      + `saw wants ${(1 / n).toFixed(5)}`);
  });
});

test('v20 skew: the peak travels — even harmonics fill in from nothing to the saw\'s', () => {
  const ctx = new MockAudioContext();
  const evenPower = (imag) => {
    let sum = 0;
    for (let n = 2; n <= MORPH_HARMONICS; n += 2) sum += imag[n] * imag[n];
    return sum;
  };
  let previous = -1;
  for (let s = 1; s <= 2.0001; s += 1 / 16) {
    const power = evenPower(shapeWave(ctx, Math.min(s, 2)).imag);
    assert.ok(power >= previous - 1e-12,
      `even-harmonic energy fell back at shape ${s.toFixed(4)} (${power} after ${previous})`);
    previous = power;
  }
  assert.ok(evenPower(shapeWave(ctx, 1).imag) < 1e-9, 'the triangle end is not even-harmonic free');
  assert.ok(evenPower(shapeWave(ctx, 1.5).imag) > 0.05, 'mid-segment skew grew no even harmonics');
});

test('v20 skew: the integer stops are untouched — canonical spectra, native types', () => {
  const ctx = new MockAudioContext();
  for (const shape of [0, 1, 2, 3]) {
    assertCoeffs(shapeWave(ctx, shape).imag, canonicalReference(shape), 1e-6, `shape ${shape}`);
  }
  // …and a patch parked on one still gets the browser's own oscillator, so a
  // pre-v20 patch schedules exactly the sources it always did.
  for (const [shape, type] of [[1, 'triangle'], [2, 'sawtooth']]) {
    const run = withSeed(33, () => playAndCheck(`pad.warm shape ${shape}`, VOICES.pad.warm,
      MORPH_NOTE, { patch: { source: { shape1: shape, shape2: shape } } }));
    assert.equal(run.graph.filter((n) => n.kind === 'oscillator' && n.periodicWave).length, 0,
      `shape ${shape} built a PeriodicWave instead of the native ${type}`);
  }
});

test('v20 skew: the outer two segments are still the linear crossfade', () => {
  const ctx = new MockAudioContext();
  // The crossfade is struck on the RAW canonical spectra and normalised after,
  // so the reference has to be built the same way round.
  const raw = (shape, n) => {
    if (shape === 0) return n === 1 ? 1 : 0;
    if (shape === 1) return n % 2 ? (n % 4 === 1 ? 1 : -1) / (n * n) : 0;
    if (shape === 2) return 1 / n;
    return n % 2 ? 1 / n : 0;
  };
  for (const [shape, lower] of [[0.5, 0], [2.5, 2]]) {
    const blended = new Float32Array(MORPH_HARMONICS + 1);
    for (let n = 1; n <= MORPH_HARMONICS; n++) {
      blended[n] = (raw(lower, n) + raw(lower + 1, n)) / 2;
    }
    assert.deepEqual(ratios(shapeWave(ctx, shape).imag, 8).map((v) => v.toFixed(5)),
      ratios(blended, 8).map((v) => v.toFixed(5)),
      `shape ${shape} is no longer the crossfade of its neighbours`);
  }
});

// --------------------------------------------------------------------------
// v20 (2) — source.fold: the wavefolder on the oscillator stacks
// --------------------------------------------------------------------------

const FOLD_NOTE = MORPH_NOTE;
/** The dial's own resolution: below half a step, `fold` is off. */
const FOLD_STEP = 1 / 32;

const shapersOf = (run) => run.graph.filter((n) => n.kind === 'shaper');

/** The gain nodes feeding a shaper, and the peak they sum to in the worst case. */
function stackPeakInto(run, shaper) {
  return run.graph
    .filter((n) => n.kind === 'gain' && n.outputs.includes(shaper))
    .reduce((sum, n) => sum + n.gain.max, 0);
}

/** The curve read as a function, the way a WaveShaper reads it. */
function throughCurve(curve, x) {
  const at = ((Math.max(-1, Math.min(1, x)) + 1) / 2) * (curve.length - 1);
  const i = Math.floor(at);
  const j = Math.min(i + 1, curve.length - 1);
  return curve[i] + (curve[j] - curve[i]) * (at - i);
}

/** In and out RMS and peak for a reference sine of amplitude `peak`. */
function foldResponse(curve, peak) {
  const samples = 2048;
  let power = 0;
  let out = 0;
  for (let i = 0; i < samples; i++) {
    const y = throughCurve(curve, peak * Math.sin((2 * Math.PI * (i + 0.5)) / samples));
    power += y * y;
    out = Math.max(out, Math.abs(y));
  }
  return { rms: Math.sqrt(power / samples) / (peak / Math.SQRT2), peak: out / peak };
}

const foldPatch = (voice, fold) => ({ ...voice.defaults, source: { ...voice.defaults.source, fold } });

test('v20 fold: 0 is a true bypass — no node, and the unfolded graph', () => {
  for (const [track, id] of FOLD_VOICES) {
    const voice = VOICES[track][id];
    const plain = withSeed(77, () => playAndCheck(`${track}.${id} defaults`, voice, FOLD_NOTE,
      { patch: voice.defaults }));
    const zero = withSeed(77, () => playAndCheck(`${track}.${id} fold 0`, voice, FOLD_NOTE,
      { patch: foldPatch(voice, 0) }));
    assert.equal(shapersOf(plain).length, 0, `${track}.${id}: the defaults built a wavefolder`);
    assert.equal(shapersOf(zero).length, 0, `${track}.${id}: fold 0 built a wavefolder`);
    assert.equal(renderSignature(zero), renderSignature(plain),
      `${track}.${id}: fold 0 is not the graph the voice has always had`);
    // Below half a step the dial is off, not nearly off.
    const nearly = withSeed(77, () => playAndCheck(`${track}.${id} fold 0.01`, voice, FOLD_NOTE,
      { patch: foldPatch(voice, FOLD_STEP / 3) }));
    assert.equal(shapersOf(nearly).length, 0, `${track}.${id}: a dial short of one step built a node`);
  }
});

test('v20 fold: 1 builds one 2× oversampled shaper between the stack and the amp', () => {
  for (const [track, id] of FOLD_VOICES) {
    const voice = VOICES[track][id];
    const run = withSeed(77, () => playAndCheck(`${track}.${id} fold 1`, voice, FOLD_NOTE,
      { patch: foldPatch(voice, 1) }));
    const shapers = shapersOf(run);
    assert.equal(shapers.length, 1, `${track}.${id}: ${shapers.length} wavefolders for one note`);
    const [shaper] = shapers;
    assert.equal(shaper.oversample, '2x', `${track}.${id}: wavefolder is not 2× oversampled`);
    assert.ok(shaper.curve instanceof Float32Array && shaper.curve.length >= 256,
      `${track}.${id}: wavefolder has no usable curve`);
    assert.ok(stackPeakInto(run, shaper) > 0,
      `${track}.${id}: nothing from the oscillator stack reaches the wavefolder`);
    assert.equal(shaper.outputs.length, 1, `${track}.${id}: the wavefolder fans out`);
    // In series, not in parallel: nothing that feeds the folder may also reach
    // the bus behind it, or half the stack would arrive unfolded.
    const [target] = shaper.outputs;
    for (const gain of run.graph.filter((n) => n.outputs.includes(shaper))) {
      assert.ok(!gain.outputs.includes(target),
        `${track}.${id}: a layer bypasses the wavefolder into the bus behind it`);
    }
  }
});

test('v20 fold: the curve holds the stack\'s level — RMS in band, peak never above', () => {
  for (const [track, id] of FOLD_VOICES) {
    const voice = VOICES[track][id];
    for (const fold of [FOLD_STEP, 0.25, 0.5, 0.75, 1]) {
      const run = withSeed(77, () => playAndCheck(`${track}.${id} fold ${fold}`, voice, FOLD_NOTE,
        { patch: foldPatch(voice, fold) }));
      const [shaper] = shapersOf(run);
      const worst = stackPeakInto(run, shaper);
      const where = `${track}.${id} fold ${fold}`;
      // 0 to −1.2 dB at the peak the curve is drawn for: the folder never adds
      // gain, and never drops more than a hair — the same band the morph dial's
      // RMS normalisation holds. (−1.08 dB is the design figure at fold 1; the
      // rest is the curve being drawn for a peak quantised a shade downwards.)
      const design = foldResponse(shaper.curve, Math.min(worst, 1));
      assert.ok(design.rms >= 0.87 && design.rms <= 1.001,
        `${where}: level moved to ${(20 * Math.log10(design.rms)).toFixed(2)} dB`);
      assert.ok(design.peak <= 1.001,
        `${where}: the folder reaches ${design.peak.toFixed(3)}× the stack's peak`);
      // A stack whose layers COULD sum past full scale (bass.round's tone and
      // its octave reach 1.05 on the instants they line up) drives the curve
      // past the ±1 a WaveShaper's input domain has, and those instants sit on
      // the far side of the fold. Still no gain, and still under 2 dB.
      const bound = foldResponse(shaper.curve, worst);
      assert.ok(bound.rms >= 0.8 && bound.rms <= 1.001,
        `${where}: at the stack's worst-case peak, level moved to `
        + `${(20 * Math.log10(bound.rms)).toFixed(2)} dB`);
    }
  }
});

test('v20 fold: the dial folds — harmonics appear, and go on appearing', () => {
  // bass.sub is two sines: whatever comes out above the second harmonic is the
  // folder's work and nothing else's.
  const voice = VOICES.bass.sub;
  const harmonicsAt = (fold) => {
    const run = withSeed(77, () => playAndCheck(`bass.sub fold ${fold}`, voice,
      { midi: 40, freq: null, kind: null, duration: 1.5, when: 0.5, velocity: 0.8, pan: 0 },
      { patch: foldPatch(voice, fold) }));
    const [shaper] = shapersOf(run);
    const peak = stackPeakInto(run, shaper);
    const samples = 4096;
    let fundamental = 0;
    let rest = 0;
    for (let i = 0; i < samples; i++) {
      const phase = (2 * Math.PI * i) / samples;
      const y = throughCurve(shaper.curve, peak * Math.sin(phase));
      fundamental += (y * Math.sin(phase) * 2) / samples;
      rest += y * y;
    }
    return (rest / samples - (fundamental * fundamental) / 2) / (rest / samples);
  };
  const gentle = harmonicsAt(0.25);
  const full = harmonicsAt(1);
  assert.ok(gentle > 0 && gentle < 0.05, `a quarter-fold is not gentle (${gentle.toFixed(4)})`);
  assert.ok(full > 0.4, `a full fold left the tone nearly pure (${full.toFixed(4)})`);
  assert.ok(full > gentle * 8, 'the dial barely moved between a quarter fold and a full one');
});

test('v20 fold: curves are quantised to 1/32 and shared, not rebuilt per note', () => {
  const voice = VOICES.pad.warm;
  const curveAt = (fold) => shapersOf(withSeed(77, () => playAndCheck(`pad.warm fold ${fold}`,
    voice, FOLD_NOTE, { patch: foldPatch(voice, fold) })))[0].curve;
  const half = curveAt(0.5);
  assert.equal(curveAt(0.5), half, 'a second note at the same fold rebuilt the curve');
  assert.equal(curveAt(0.5 + FOLD_STEP / 4), half, 'a sub-step nudge is a different curve');
  assert.notEqual(curveAt(0.5 + FOLD_STEP), half, 'the next step reused the wrong curve');
});

test('v20 fold: a voice with no fold dial ignores the field entirely', () => {
  for (const [track, patches] of Object.entries(EXPECTED)) {
    for (const id of Object.keys(patches)) {
      if (carries(FOLD_VOICES, track, id)) continue;
      const voice = VOICES[track][id];
      const note = honestyNoteFor(track);
      const plain = withSeed(88, () => playAndCheck(`${track}.${id} defaults`, voice, note,
        { patch: voice.defaults }));
      const asked = withSeed(88, () => playAndCheck(`${track}.${id} fold 1`, voice, note,
        { patch: { ...voice.defaults, source: { ...voice.defaults.source, fold: 1 } } }));
      assert.equal(shapersOf(asked).length, 0, `${track}.${id}: built a wavefolder it never declared`);
      assert.equal(renderSignature(asked), renderSignature(plain),
        `${track}.${id}: an undeclared fold moved the graph`);
      assert.equal(voice.defaults.source.fold, undefined,
        `${track}.${id}: publishes a fold dial it does not honour`);
    }
  }
});

// --------------------------------------------------------------------------
// Voice control metadata (v8): controls declares which patch fields a voice
// actually honours, so the editor can hide the rest instead of greying them.
// --------------------------------------------------------------------------

const SOURCE_FIELDS = ['shape1', 'shape2', 'mix', 'detune', 'octave'];
/** v18: the kits swap the octave switch for semitones and a noise level. */
const PERCUSSION_SOURCE_FIELDS = ['shape1', 'shape2', 'mix', 'detune', 'pitch', 'noise'];
const FILTER_FIELDS = ['type', 'cutoff', 'q', 'envAmount'];

/** v19: the sculpting and call families are additions, not replacements. */
const SCULPT_FIELDS = Object.keys(SCULPT_SOURCE);
const CALL_FIELDS = Object.keys(CALL_SOURCE);
/** v20: so are the modifiers. */
const FOLD_FIELDS = Object.keys(FOLD_SOURCE);

function sourceFieldsFor(track, id) {
  if (track === 'percussion') return PERCUSSION_SOURCE_FIELDS;
  const fields = [...SOURCE_FIELDS];
  if (carries(SCULPT_VOICES, track, id)) fields.push(...SCULPT_FIELDS);
  if (carries(CALL_VOICES, track, id)) fields.push(...CALL_FIELDS);
  if (carries(FOLD_VOICES, track, id)) fields.push(...FOLD_FIELDS);
  return fields;
}

/** true|false|string[] against the field list its group is allowed to name. */
function checkControlShape(where, value, allowed) {
  if (typeof value === 'boolean') return;
  assert.ok(Array.isArray(value), `${where}: ${JSON.stringify(value)} is not true/false/an array`);
  assert.equal(new Set(value).size, value.length, `${where}: duplicate fields`);
  for (const field of value) {
    assert.ok(allowed.includes(field), `${where}: ${field} is not one of ${allowed.join(',')}`);
  }
}

const controlsApplies = (declared, field) => (
  declared === true || (Array.isArray(declared) && declared.includes(field))
);

test('controls: schema shape, and every applicable field exists in defaults', () => {
  for (const [track, patches] of Object.entries(EXPECTED)) {
    for (const id of Object.keys(patches)) {
      const { controls, defaults } = VOICES[track][id];
      const where = `${track}.${id} controls`;
      assert.ok(controls && typeof controls === 'object', `${where}: missing`);
      assert.deepEqual(Object.keys(controls).sort(), ['adsr', 'filter', 'sends', 'source'],
        `${where}: wrong groups`);
      const sourceFields = sourceFieldsFor(track, id);
      checkControlShape(`${where}.source`, controls.source, sourceFields);
      checkControlShape(`${where}.filter`, controls.filter, FILTER_FIELDS);
      assert.equal(controls.adsr, true, `${where}.adsr: every voice's own envelope honours a patch`);
      assert.equal(controls.sends, true, `${where}.sends: the engine applies sends outside play()`);
      for (const [group, fields] of [['source', sourceFields], ['filter', FILTER_FIELDS]]) {
        const declared = controls[group];
        const named = declared === true ? fields : (declared || []);
        for (const field of named) {
          assert.ok(field in defaults[group], `${where}.${group}.${field}: not a key in defaults.${group}`);
        }
      }
    }
  }
});

/**
 * envAmount only bends a voice's own filter sweep — cutoffAt()'s exponent or
 * envDepth()'s LFO/formant scale — and both are read only by the six voices
 * whose defaults already publish envAmount: 1 (the ones with a filter that
 * moves at all). Everywhere else envAmount is accepted and ignored, so this
 * is a straight data-consistency check on the ruling, not a runtime probe.
 */
test('controls: filter includes envAmount iff the voice publishes envAmount: 1', () => {
  for (const [track, patches] of Object.entries(EXPECTED)) {
    for (const id of Object.keys(patches)) {
      const { controls, defaults } = VOICES[track][id];
      const declaresEnvAmount = controlsApplies(controls.filter, 'envAmount');
      const publishesMover = defaults.filter.envAmount === 1;
      assert.equal(declaresEnvAmount, publishesMover,
        `${track}.${id}: envAmount in controls.filter (${declaresEnvAmount}) disagrees `
        + `with defaults.filter.envAmount === 1 (${publishesMover})`);
    }
  }
});

/** A signature of the whole scheduled graph, sensitive to node kind, type/
 * PeriodicWave, and every automated param's observed range — so a field with
 * genuinely zero effect cannot look different by accident, and one that truly
 * moves the sound cannot look the same by accident. */
function graphSignature(run) {
  const r = (v) => Math.round(v * 1e4) / 1e4;
  return run.graph.map((n) => [
    n.kind,
    n.type,
    n.periodicWave ? `wave(${Array.from(n.periodicWave.imag).map(r).join(',')})` : '',
    r(n.frequency.min), r(n.frequency.max),
    r(n.gain.min), r(n.gain.max),
    r(n.detune.min), r(n.detune.max),
    r(n.Q.min), r(n.Q.max),
    r(n.delayTime.min), r(n.delayTime.max),
  ].join(':')).join('|');
}

/** The v19/v20 fields that are a plain 0–1 amount, so they share a wild value. */
const UNIT_FIELDS = [
  'sweepDepth', 'gust', 'burst', 'burstSharp', 'swell', 'glideCurve', 'irregular', 'fold',
];

function wildSourceValue(field, base) {
  if (field === 'shape1' || field === 'shape2') return base === 0 ? 2 : 0;
  if (field === 'mix') return base > 0.5 ? 0 : 1;
  if (field === 'detune') return base > 25 ? 0 : 50;
  if (field === 'pitch') return base > 0 ? -12 : 12;
  if (field === 'noise') return base > 0.5 ? 0 : 1;
  if (UNIT_FIELDS.includes(field)) return base > 0.5 ? 0 : 1;
  if (field === 'tilt') return base > 0 ? -1 : 1;
  if (field === 'bandCentre' || field === 'formant1' || field === 'formant2') {
    return base > 1000 ? 120 : 5000;
  }
  if (field === 'bandWidth') return base > 2 ? 0.2 : 3.6;
  if (field === 'sweepRate') return base > 0.25 ? 0.02 : 0.45;
  if (field === 'gustRate') return base > 0.25 ? 0.03 : 0.45;
  if (field === 'glide') return base > 0 ? -24 : 24;
  if (field === 'cadence') return base > 4 ? 0.5 : 8;
  return base === 1 ? -1 : 1; // octave
}

function wildFilterValue(field, base) {
  if (field === 'type') return base === 'lowpass' ? 'highpass' : 'lowpass';
  if (field === 'cutoff') return base > 6000 ? 60 : 11000;
  if (field === 'q') return base > 10 ? 0.2 : 18;
  return base === 1 ? 0 : 1; // envAmount
}

function honestyNoteFor(track) {
  if (track === 'percussion') {
    // 'low' is the one note.kind every percussion voice strikes a membrane
    // for; 'mid'/'high' vary per voice, so this is the kind that exercises
    // source at all — the point of this test is the honesty of the claim,
    // not a survey of every kind.
    return { midi: null, freq: null, kind: 'low', duration: 0.25, when: 0.5, velocity: 0.8, pan: 0 };
  }
  return attackNote(track);
}

/**
 * For every field named in the schema, plays the voice's own defaults against
 * the same patch with just that one field pushed to a wild, far-from-default
 * value, and checks the scheduled graph moved iff `controls` says it should.
 *
 * The comparison is renderSignature(), not graphSignature(): the latter sees
 * only each param's observed min and max, which is blind to a field that
 * reshapes the path BETWEEN them — v19's glideCurve moves the midpoint of a
 * chirp's sweep without touching either end of it, and that is an audible
 * change to the sound with an inaudible effect on a min/max pair. The whole
 * schedule catches it, and stays exactly as strict for the fields a voice is
 * supposed to ignore: an unread field schedules nothing differently at all.
 */
function checkFieldHonesty(track, id, group, fields, wildValueFor) {
  const voice = VOICES[track][id];
  const note = honestyNoteFor(track);
  const seed = 1901;
  const base = withSeed(seed, () => playAndCheck(`${track}.${id} base`, voice, note,
    { patch: voice.defaults }));
  for (const field of fields) {
    const value = voice.defaults[group][field];
    if (value === null) continue; // no wild variant of "no second oscillator"
    const wild = wildValueFor(field, value);
    const varied = withSeed(seed, () => playAndCheck(`${track}.${id} ${group}.${field}=${wild}`, voice,
      note, { patch: { ...voice.defaults, [group]: { ...voice.defaults[group], [field]: wild } } }));
    const identical = renderSignature(base) === renderSignature(varied);
    const applies = controlsApplies(voice.controls[group], field);
    if (applies) {
      assert.ok(!identical,
        `${track}.${id}: controls.${group} claims ${field} applies, but the graph did not move`);
    } else {
      assert.ok(identical,
        `${track}.${id}: controls.${group} claims ${field} is inapplicable, but the graph moved`);
    }
  }
}

for (const [track, patches] of Object.entries(EXPECTED)) {
  for (const id of Object.keys(patches)) {
    test(`controls honesty: ${track}.${id} source`, () => {
      checkFieldHonesty(track, id, 'source', sourceFieldsFor(track, id), wildSourceValue);
    });
    test(`controls honesty: ${track}.${id} filter`, () => {
      checkFieldHonesty(track, id, 'filter', FILTER_FIELDS, wildFilterValue);
    });
  }
}

// --------------------------------------------------------------------------
// v18 — percussion source.pitch / source.noise
// --------------------------------------------------------------------------

const PERCUSSION_KINDS = ['low', 'mid', 'high'];

const percussionNote = (kind, velocity = 0.8) => ({
  midi: null, freq: null, kind, duration: 0.25, when: 0.5, velocity, pan: 0,
});

/** The graph AND the whole automation schedule: one note, written out in full. */
function renderSignature(run) {
  const r = (v) => Math.round(v * 1e6) / 1e6;
  const events = run.events.map((e) => `${e.name}/${e.kind}/${r(e.value)}/${r(e.time)}`).join(';');
  return `${graphSignature(run)}||${events}`;
}

/**
 * FNV-1a of the above, with the length alongside it so a collision would have
 * to match both. Short enough to read in a failure message and to store here.
 */
function renderHash(run) {
  const text = renderSignature(run);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(16).padStart(8, '0')}:${text.length}`;
}

/**
 * Recorded from the library as it stood BEFORE source.pitch and source.noise
 * existed. Adding controls is not allowed to move the sound of a kit nobody
 * has edited, and a hash is the only way to say that without hand-waving.
 */
const PERCUSSION_GOLDEN = {
  'soft.low.v0.35': 'f8b0599c:634', 'soft.low.v0.8': 'cfbcf5b3:633',
  'soft.mid.v0.35': 'e4d162ab:641', 'soft.mid.v0.8': 'e143306c:640',
  'soft.high.v0.35': 'e81555b1:386', 'soft.high.v0.8': 'fd948224:384',
  'hand.low.v0.35': 'c12d05e0:853', 'hand.low.v0.8': '2de49603:853',
  'hand.mid.v0.35': '742f36dc:596', 'hand.mid.v0.8': '9b92f4a5:596',
  'hand.high.v0.35': 'aa4ce86e:598', 'hand.high.v0.8': '1f77ea74:597',
  'tick.low.v0.35': 'f384190c:589', 'tick.low.v0.8': 'ea55a535:589',
  'tick.mid.v0.35': '1ac7a7d6:337', 'tick.mid.v0.8': '12f67e10:337',
  'tick.high.v0.35': '5aaa56c9:338', 'tick.high.v0.8': '35d9ea30:338',
};

test('v18: an unpatched percussion note renders exactly the pre-v18 graph', () => {
  // The three kits that existed at v18. A kit added later (v27's dust) has no
  // pre-v18 render to hold to, and inventing a golden for it here would only
  // pin today's code to itself.
  for (const id of ['soft', 'hand', 'tick']) {
    for (const kind of PERCUSSION_KINDS) {
      for (const velocity of [0.35, 0.8]) {
        const key = `${id}.${kind}.v${velocity}`;
        const run = withSeed(4711, () => playAndCheck(key, VOICES.percussion[id],
          percussionNote(kind, velocity)));
        assert.equal(renderHash(run), PERCUSSION_GOLDEN[key],
          `${key}: an unpatched percussion note no longer renders what it did`);
      }
    }
  }
});

test('v18: percussion publishes pitch and noise in place of the octave switch', () => {
  for (const id of Object.keys(VOICES.percussion)) {
    const { defaults, controls } = VOICES.percussion[id];
    assert.equal(defaults.source.octave, undefined,
      `percussion.${id}: still publishes an octave switch`);
    assert.equal(defaults.source.pitch, 0,
      `percussion.${id}: the default pitch must be the kit as it was built`);
    assert.equal(defaults.source.noise, 1,
      `percussion.${id}: the default noise must be the level the kit was balanced at`);
    assert.ok(Array.isArray(controls.source), `percussion.${id}: controls.source must be a subset`);
    assert.ok(controls.source.includes('pitch'), `percussion.${id}: controls omit pitch`);
    assert.ok(controls.source.includes('noise'), `percussion.${id}: controls omit noise`);
    assert.ok(!controls.source.includes('octave'), `percussion.${id}: controls still offer octave`);
  }
  // And no melodic voice grew the kit's controls by accident.
  for (const [track, patches] of Object.entries(EXPECTED)) {
    if (track === 'percussion') continue;
    for (const id of Object.keys(patches)) {
      const { defaults } = VOICES[track][id];
      assert.equal(defaults.source.pitch, undefined, `${track}.${id}: took the kit's pitch field`);
      assert.equal(defaults.source.noise, undefined, `${track}.${id}: took the kit's noise field`);
      assert.ok('octave' in defaults.source, `${track}.${id}: lost its octave switch`);
    }
  }
});

/** The membrane oscillators of a percussion note, highest scheduled frequency. */
function membraneTop(run) {
  const oscs = run.graph.filter((n) => n.kind === 'oscillator');
  assert.ok(oscs.length > 0, 'this note struck no membrane to measure');
  return Math.max(...oscs.map((n) => n.frequency.max));
}

test('v18: source.pitch transposes a kit by semitones, to ±24 at the extremes', () => {
  // 'low' is the one kind every kit strikes a membrane for, so it is the kind
  // with an oscillator whose frequency the transposition can be read off.
  for (const id of Object.keys(VOICES.percussion)) {
    const note = percussionNote('low');
    const base = withSeed(88, () => playAndCheck(`percussion.${id} pitch 0`, VOICES.percussion[id],
      note, { patch: { source: { pitch: 0 } } }));
    const reference = membraneTop(base);
    for (const pitch of [-24, -12, -7, -0.5, 3.5, 12, 24]) {
      const run = withSeed(88, () => playAndCheck(`percussion.${id} pitch ${pitch}`,
        VOICES.percussion[id], note, { patch: { source: { pitch } } }));
      const ratio = membraneTop(run) / reference;
      assert.ok(Math.abs(ratio - Math.pow(2, pitch / 12)) < 1e-9,
        `percussion.${id}: pitch ${pitch} moved the skin by ×${ratio.toFixed(6)}, `
        + `not ×${Math.pow(2, pitch / 12).toFixed(6)}`);
    }
    // Beyond the ends the dial clamps rather than running away.
    for (const [asked, capped] of [[99, 24], [-99, -24]]) {
      const run = withSeed(88, () => playAndCheck(`percussion.${id} pitch ${asked}`,
        VOICES.percussion[id], note, { patch: { source: { pitch: asked } } }));
      assert.ok(Math.abs(membraneTop(run) / reference - Math.pow(2, capped / 12)) < 1e-9,
        `percussion.${id}: pitch ${asked} was not clamped to ${capped}`);
    }
  }
});

test('v18: a legacy octave patch still tunes a kit, as pitch ×12', () => {
  for (const id of Object.keys(VOICES.percussion)) {
    for (const kind of PERCUSSION_KINDS) {
      const note = percussionNote(kind);
      for (const octave of [-2, -1, 1, 2]) {
        const legacy = withSeed(88, () => playAndCheck(`percussion.${id} octave ${octave}`,
          VOICES.percussion[id], note, { patch: { source: { octave } } }));
        const semitones = withSeed(88, () => playAndCheck(`percussion.${id} pitch ${octave * 12}`,
          VOICES.percussion[id], note, { patch: { source: { pitch: octave * 12 } } }));
        assert.equal(renderHash(legacy), renderHash(semitones),
          `percussion.${id}/${kind}: a stored octave ${octave} no longer renders as ${octave * 12} semitones`);
      }
      // An explicit pitch wins over a legacy octave sitting beside it.
      const both = withSeed(88, () => playAndCheck(`percussion.${id} both`, VOICES.percussion[id],
        note, { patch: { source: { octave: -2, pitch: 5 } } }));
      const alone = withSeed(88, () => playAndCheck(`percussion.${id} pitch 5`,
        VOICES.percussion[id], note, { patch: { source: { pitch: 5 } } }));
      assert.equal(renderHash(both), renderHash(alone),
        `percussion.${id}/${kind}: a legacy octave overrode an explicit pitch`);
    }
  }
});

test('v18: source.noise silences the noise layers and leaves the membrane sounding', () => {
  for (const id of Object.keys(VOICES.percussion)) {
    const note = percussionNote('low');
    const full = withSeed(88, () => playAndCheck(`percussion.${id} noise 1`, VOICES.percussion[id],
      note, { patch: { source: { noise: 1 } } }));
    const silent = withSeed(88, () => playAndCheck(`percussion.${id} noise 0`, VOICES.percussion[id],
      note, { patch: { source: { noise: 0 } } }));
    const noiseSources = (run) => run.graph.filter((n) => n.kind === 'bufferSource').length;
    assert.ok(noiseSources(full) >= 1, `percussion.${id}: 'low' has no noise layer to silence`);
    assert.equal(noiseSources(silent), 0,
      `percussion.${id}: noise 0 still scheduled a noise source`);
    // The drum itself is untouched: same oscillators, same frequencies, same
    // level — only the noise went away.
    assert.equal(membraneTop(silent), membraneTop(full),
      `percussion.${id}: silencing the noise moved the membrane`);
    assert.equal(silent.graph.filter((n) => n.kind === 'oscillator').length,
      full.graph.filter((n) => n.kind === 'oscillator').length,
      `percussion.${id}: silencing the noise cost the drum an oscillator`);
    assert.ok(silent.sum > 0, `percussion.${id}: noise 0 silenced the whole drum`);
    // And in between, the layer scales rather than switching.
    const half = withSeed(88, () => playAndCheck(`percussion.${id} noise 0.5`,
      VOICES.percussion[id], note, { patch: { source: { noise: 0.5 } } }));
    assert.equal(noiseSources(half), noiseSources(full),
      `percussion.${id}: a half-noise kit dropped a layer`);
    assert.ok(half.sum < full.sum && half.sum > silent.sum,
      `percussion.${id}: noise 0.5 (${half.sum}) does not sit between 0 (${silent.sum}) `
      + `and 1 (${full.sum})`);
  }
});

/**
 * Turned right down, a kind whose entire sound is noise has nothing left to
 * play. That is the honest answer for a hat, but it must be a CLEAN silence:
 * no source scheduled, no node left connected waiting for an ended callback
 * that will never come.
 */
test('v18: noise 0 on a noise-only instrument is silent and tears down at once', () => {
  const ctx = new MockAudioContext();
  const destination = makeNode('gain');
  for (const [id, kind] of [['soft', 'high'], ['tick', 'mid'], ['tick', 'high']]) {
    created = [];
    startedSources = [];
    const where = `percussion.${id}/${kind}`;
    const handle = VOICES.percussion[id].play(ctx, destination, percussionNote(kind),
      { source: { noise: 0 } });
    assert.equal(startedSources.length, 0, `${where}: noise 0 still scheduled a source`);
    assert.ok(handle && typeof handle.cancel === 'function', `${where}: no cancel() returned`);
    const leaked = created.filter((n) => n !== destination && !n.disconnected);
    assert.equal(leaked.length, 0,
      `${where}: ${leaked.length} node(s) left connected with nothing to end them`);
    handle.cancel();   // and cancelling a note that is already gone is harmless
  }
});

test('v18: noise 1 is the kit as built — the dial only ever takes noise away', () => {
  for (const id of Object.keys(VOICES.percussion)) {
    for (const kind of PERCUSSION_KINDS) {
      const note = percussionNote(kind);
      const defaults = withSeed(88, () => playAndCheck(`percussion.${id} defaults`,
        VOICES.percussion[id], note, { patch: VOICES.percussion[id].defaults }));
      const asked = withSeed(88, () => playAndCheck(`percussion.${id} noise 1`,
        VOICES.percussion[id], note, {
          patch: { ...VOICES.percussion[id].defaults, source: { noise: 1 } },
        }));
      assert.equal(renderHash(asked), renderHash(defaults),
        `percussion.${id}/${kind}: noise 1 is not the published default level`);
    }
  }
});

// --------------------------------------------------------------------------
// v19 — the parametric noise-sculpting surface, and the call primitive
// --------------------------------------------------------------------------

/** A texture note long enough for a bed to reach the top of its own attack. */
const bedNote = (duration = 8, velocity = 0.8) => ({
  midi: 79, freq: null, kind: null, duration, when: 0.5, velocity, pan: 0,
});

/** A patch of one voice's defaults with `source` fields overridden. */
const sculpt = (track, id, source) => ({
  ...VOICES[track][id].defaults,
  source: { ...VOICES[track][id].defaults.source, ...source },
});

/** The grain ceiling the voices impose so a density dial cannot outgrow the budget. */
const BURST_CAP = 14;

const biquads = (run) => run.graph.filter((n) => n.kind === 'biquad');
const noiseSources = (run) => run.graph.filter((n) => n.kind === 'bufferSource');
const oscillators = (run) => run.graph.filter((n) => n.kind === 'oscillator');

test('v19: the sculpting fields land only on the voices that declare them', () => {
  for (const [track, patches] of Object.entries(EXPECTED)) {
    for (const id of Object.keys(patches)) {
      const { defaults, controls } = VOICES[track][id];
      const sculpts = carries(SCULPT_VOICES, track, id);
      const calls = carries(CALL_VOICES, track, id);
      // `source: true` means "every field this voice publishes", so a voice
      // that publishes no sculpting fields cannot be offering their dials.
      const offers = (field) => field in defaults.source && controlsApplies(controls.source, field);
      for (const field of SCULPT_FIELDS) {
        assert.equal(field in defaults.source, sculpts,
          `${track}.${id}: defaults.source.${field} present is ${field in defaults.source}, `
          + `but the voice ${sculpts ? 'does' : 'does not'} sculpt`);
        assert.equal(offers(field), sculpts,
          `${track}.${id}: controls.source disagrees with the library over ${field}`);
      }
      for (const field of CALL_FIELDS) {
        assert.equal(field in defaults.source, calls,
          `${track}.${id}: defaults.source.${field} present is ${field in defaults.source}, `
          + `but the voice ${calls ? 'is' : 'is not'} a call`);
        assert.equal(offers(field), calls,
          `${track}.${id}: controls.source disagrees with the library over ${field}`);
      }
      // No voice carries both families, and a sculpting voice keeps the
      // ordinary tuning switch rather than growing a kit's semitones.
      assert.ok(!(sculpts && calls), `${track}.${id}: claims both v19 families`);
      if (sculpts || calls) {
        assert.ok('octave' in defaults.source, `${track}.${id}: lost its octave switch`);
        assert.equal(defaults.source.pitch, undefined, `${track}.${id}: took a kit's pitch`);
      }
    }
  }
});

test('v19: the new voices are noise and hybrid, and the mix defaults are unobtrusive', () => {
  assert.equal(VOICES.texture.colour.engineType, 'noise');
  assert.equal(VOICES.texture.cloud.engineType, 'noise');
  // v0.0.88 (his ruling) deleted the breath: one engine, formant-filtered.
  assert.equal(VOICES.melody.call.engineType, 'subtractive');
  assert.equal(VOICES.texture.call.engineType, 'subtractive');
  // Unobtrusive means: at its own defaults, a new voice reaches the bus no
  // harder than the LOUDEST voice already on its track, so a listener trying
  // one out never gets a jump in the mix for their trouble.
  const NEW = { texture: ['colour', 'cloud', 'call'], melody: ['call'] };
  for (const [track, added] of Object.entries(NEW)) {
    const note = track === 'melody' ? attackNote('melody') : bedNote(6);
    const level = (id) => withSeed(70, () => playAndCheck(`${track}.${id}`,
      VOICES[track][id], note)).sum;
    const existing = Object.keys(VOICES[track]).filter((id) => !added.includes(id));
    const loudest = Math.max(...existing.map(level));
    for (const id of added) {
      assert.ok(level(id) <= loudest * 1.1,
        `${track}.${id} reaches the bus at ${level(id).toFixed(3)} where the loudest voice `
        + `already on the track reaches ${loudest.toFixed(3)} — that is a jump on switching voice`);
    }
  }
});

test('v19: tilt extremes shape the bed into measurably different spectra', () => {
  for (const id of ['colour', 'cloud']) {
    const dark = withSeed(51, () => playAndCheck(`texture.${id} tilt -1`, VOICES.texture[id],
      bedNote(), { patch: sculpt('texture', id, { tilt: -1 }) }));
    const bright = withSeed(51, () => playAndCheck(`texture.${id} tilt 1`, VOICES.texture[id],
      bedNote(), { patch: sculpt('texture', id, { tilt: 1 }) }));
    const config = (run) => biquads(run).map((n) => `${n.type}@${Math.round(n.frequency.max)}`);
    assert.notDeepEqual(config(dark), config(bright),
      `texture.${id}: both ends of the tilt dial configured the same filters`);
    // The dial's shape: one end lowpasses low, the other highpasses high.
    const lows = biquads(dark).filter((n) => n.type === 'lowpass');
    const highs = biquads(bright).filter((n) => n.type === 'highpass');
    assert.ok(lows.length >= 1, `texture.${id}: tilt -1 built no lowpass`);
    assert.ok(highs.length >= 1, `texture.${id}: tilt +1 built no highpass`);
    assert.ok(Math.min(...lows.map((n) => n.frequency.max)) < 200,
      `texture.${id}: tilt -1 left the bed bright`);
    assert.ok(Math.max(...highs.map((n) => n.frequency.max)) > 4000,
      `texture.${id}: tilt +1 left the bed dark`);
    // And the middle of the dial is transparent, not a third colour.
    const flat = withSeed(51, () => playAndCheck(`texture.${id} tilt 0`, VOICES.texture[id],
      bedNote(), { patch: sculpt('texture', id, { tilt: 0 }) }));
    const corner = biquads(flat).filter((n) => n.type === 'highpass' || n.type === 'lowpass');
    assert.ok(corner.some((n) => n.frequency.max <= 25),
      `texture.${id}: tilt 0 is not a transparent middle`);
  }
});

test('v19: bandCentre and bandWidth place and open the band', () => {
  for (const id of ['colour', 'cloud']) {
    for (const [low, high] of [[120, 5000], [400, 2000]]) {
      const under = withSeed(52, () => playAndCheck(`texture.${id} centre ${low}`,
        VOICES.texture[id], bedNote(), { patch: sculpt('texture', id, { bandCentre: low }) }));
      const over = withSeed(52, () => playAndCheck(`texture.${id} centre ${high}`,
        VOICES.texture[id], bedNote(), { patch: sculpt('texture', id, { bandCentre: high }) }));
      const top = (run) => Math.max(...biquads(run)
        .filter((n) => n.type === 'bandpass').map((n) => n.frequency.max));
      assert.ok(top(under) < top(over),
        `texture.${id}: bandCentre ${low} did not sit below ${high}`);
    }
    // A narrow band is a resonance, a wide one is a bed: Q falls as it opens.
    const qOf = (width) => {
      const run = withSeed(52, () => playAndCheck(`texture.${id} width ${width}`,
        VOICES.texture[id], bedNote(), { patch: sculpt('texture', id, { bandWidth: width }) }));
      return Math.max(...biquads(run).filter((n) => n.type === 'bandpass').map((n) => n.Q.max));
    };
    assert.ok(qOf(0.1) > qOf(1) && qOf(1) > qOf(4),
      `texture.${id}: bandWidth does not open the band (${qOf(0.1)}, ${qOf(1)}, ${qOf(4)})`);
  }
});

test('v19: the sweep moves the band, and its depth sets how far', () => {
  const centre = 800;
  const spread = (depth) => {
    const run = withSeed(53, () => playAndCheck(`texture.colour sweep ${depth}`,
      VOICES.texture.colour, bedNote(12), {
        patch: sculpt('texture', 'colour', {
          bandCentre: centre, sweepRate: 0.4, sweepDepth: depth, gust: 0, swell: 0,
        }),
      }));
    const band = biquads(run).find((n) => n.type === 'bandpass');
    return band.frequency.max / band.frequency.min;
  };
  assert.ok(Math.abs(spread(0) - 1) < 1e-9, 'sweepDepth 0 still moved the band');
  assert.ok(spread(0.3) > 1.2, `sweepDepth 0.3 barely moved the band (×${spread(0.3).toFixed(2)})`);
  assert.ok(spread(1) > spread(0.3), 'sweepDepth 1 does not sweep further than 0.3');
});

test('v19: gust walks the bed and never adds gain to it', () => {
  const run = (gust) => withSeed(54, () => playAndCheck(`texture.colour gust ${gust}`,
    VOICES.texture.colour, bedNote(12), {
      patch: sculpt('texture', 'colour', { gust, sweepDepth: 0, sweepRate: 0, swell: 0 }),
    }));
  const calm = run(0);
  const gusty = run(1);
  const band = (r) => biquads(r).find((n) => n.type === 'bandpass');
  assert.ok(Math.abs(band(calm).frequency.max / band(calm).frequency.min - 1) < 1e-9,
    'gust 0 still wandered the brightness');
  assert.ok(band(gusty).frequency.max / band(gusty).frequency.min > 1.2,
    'gust 1 did not wander the brightness');
  // The level dial-safety rule: gusts duck the bed, they never lift it.
  assert.ok(gusty.sum <= calm.sum + 1e-9,
    `gust made the bed louder (${gusty.sum.toFixed(4)} vs ${calm.sum.toFixed(4)})`);
});

test('v19: burst density scales the grains scheduled, and burstSharp tightens them', () => {
  for (const [id, floor] of [['colour', 0], ['cloud', 1]]) {
    const counts = [0, 0.15, 0.4, 1].map((burst) => {
      const run = withSeed(55, () => playAndCheck(`texture.${id} burst ${burst}`,
        VOICES.texture[id], bedNote(6), { patch: sculpt('texture', id, { burst }) }));
      // colour's bed is a noise source too; the grains are the rest of them.
      return noiseSources(run).length - (id === 'colour' ? 1 : 0);
    });
    assert.equal(counts[0], floor, `texture.${id}: burst 0 scheduled ${counts[0]} grains`);
    for (let i = 1; i < counts.length; i++) {
      assert.ok(counts[i] > counts[i - 1],
        `texture.${id}: burst density is not monotonic (${counts.join(', ')})`);
    }
    assert.ok(counts[counts.length - 1] <= BURST_CAP,
      `texture.${id}: burst 1 scheduled ${counts[counts.length - 1]} grains, over the cap`);

    // Sharper grains are shorter and brighter: the same count, tighter.
    const grainsAt = (burstSharp) => withSeed(55, () => playAndCheck(
      `texture.${id} sharp ${burstSharp}`, VOICES.texture[id], bedNote(6),
      { patch: sculpt('texture', id, { burst: 0.6, burstSharp }) },
    ));
    const soft = grainsAt(0);
    const sharp = grainsAt(1);
    assert.equal(noiseSources(sharp).length, noiseSources(soft).length,
      `texture.${id}: burstSharp changed the grain COUNT`);
    assert.ok(sharp.tail < soft.tail || sharp.tail === soft.tail,
      `texture.${id}: sharper grains ran longer than soft ones`);
    const top = (run) => Math.max(...biquads(run).filter((n) => n.type === 'bandpass')
      .map((n) => n.frequency.max));
    assert.ok(top(sharp) > top(soft), `texture.${id}: burstSharp did not brighten the grains`);
  }
});

/**
 * How long the BED's own attack ramp is. A sculpting voice schedules grain
 * envelopes as well as its own, and a grain landing early would otherwise be
 * read as the attack — so this takes the ramp that climbs highest, which is
 * the one carrying the whole voice rather than one droplet of it.
 */
function attackLength(run, when) {
  const rises = run.events.filter((e) => e.name === 'gain.gain'
    && e.kind === 'exponential' && e.value > 2e-4 && e.time > when);
  assert.ok(rises.length > 0, 'no attack ramp was scheduled at all');
  const top = Math.max(...rises.map((e) => e.value));
  return Math.min(...rises.filter((e) => e.value === top).map((e) => e.time)) - when;
}

test('v19: swell stretches the attack automation and starts the band below its centre', () => {
  for (const id of ['colour', 'cloud']) {
    const note = bedNote(12);
    const lengths = [0, 0.5, 1].map((swell) => {
      const run = withSeed(56, () => playAndCheck(`texture.${id} swell ${swell}`,
        VOICES.texture[id], note, {
          patch: sculpt('texture', id, { swell, burst: 0.5, gust: 0, sweepDepth: 0 }),
        }));
      return { swell, run, attack: attackLength(run, note.when) };
    });
    for (let i = 1; i < lengths.length; i++) {
      assert.ok(lengths[i].attack > lengths[i - 1].attack * 1.2,
        `texture.${id}: swell ${lengths[i].swell} did not lengthen the attack `
        + `(${lengths.map((l) => l.attack.toFixed(3)).join(', ')})`);
    }
    // swell 0 is the identity: the attack is exactly what the ADSR asked for.
    assert.ok(Math.abs(lengths[0].attack - VOICES.texture[id].defaults.adsr.attack) < 1e-6,
      `texture.${id}: swell 0 is not the patch's own attack`);
    // The band starts below its centre and opens as the crescendo rises: for
    // the bed that is its own band, for the cloud it is the grains that fall
    // inside the (now much longer) attack.
    const floor = (run) => Math.min(...biquads(run)
      .filter((n) => n.type === 'bandpass').map((n) => n.frequency.min));
    assert.ok(floor(lengths[2].run) < floor(lengths[0].run) * 0.9,
      `texture.${id}: a crescendo did not start below its own band centre `
      + `(${floor(lengths[2].run).toFixed(1)} vs ${floor(lengths[0].run).toFixed(1)})`);
  }
});

test('v19: a sculpting voice stays inside its steady node budget at every dial', () => {
  // Everything that can add a steady node, all at once, with the grains off.
  const heavy = {
    tilt: 1, bandCentre: 8000, bandWidth: 0.1, sweepRate: 0.5, sweepDepth: 1,
    gust: 1, gustRate: 0.5, burst: 0, burstSharp: 1, swell: 1,
  };
  for (const id of ['colour', 'cloud']) {
    const run = withSeed(57, () => playAndCheck(`texture.${id} heavy`, VOICES.texture[id],
      bedNote(12), { patch: sculpt('texture', id, heavy) }));
    const grains = noiseSources(run).length - (id === 'colour' ? 1 : 0);
    assert.equal(grains, id === 'cloud' ? 1 : 0, `texture.${id}: burst 0 still scheduled grains`);
    // Minus the rig's own output gain and panner, which every voice pays.
    assert.ok(run.nodes - 2 - grains * 4 <= 8,
      `texture.${id}: ${run.nodes - 2} steady nodes, over the budget of 8`);
    assert.equal(oscillators(run).length, 0,
      `texture.${id}: a noise voice built an oscillator to modulate with`);
  }
});

test('v19: call glides from the note to its interval, along the curve it is given', () => {
  const note = { midi: 69, freq: 440, kind: null, duration: 2, when: 0.5, velocity: 0.8, pan: 0 };
  for (const [track, id] of CALL_VOICES) {
    for (const glide of [-24, -7, 12, 24]) {
      const run = withSeed(58, () => playAndCheck(`${track}.${id} glide ${glide}`,
        VOICES[track][id], note, {
          patch: sculpt(track, id, { glide, cadence: 1, irregular: 0, octave: 0 }),
        }));
      const oscs = oscillators(run);
      assert.equal(oscs.length, 1, `${track}.${id}: cadence 1 built ${oscs.length} chirps`);
      const to = 440 * Math.pow(2, glide / 12);
      const [lo, hi] = glide > 0 ? [440, to] : [to, 440];
      assert.ok(Math.abs(oscs[0].frequency.min - lo) < 0.5,
        `${track}.${id}: glide ${glide} started/ended at ${oscs[0].frequency.min}, not ${lo}`);
      assert.ok(Math.abs(oscs[0].frequency.max - hi) < 0.5,
        `${track}.${id}: glide ${glide} started/ended at ${oscs[0].frequency.max}, not ${hi}`);
    }
    // The curve moves the halfway pitch between those fixed endpoints.
    const midAt = (glideCurve) => {
      const run = withSeed(58, () => playAndCheck(`${track}.${id} curve ${glideCurve}`,
        VOICES[track][id], note, {
          patch: sculpt(track, id, { glide: 12, glideCurve, cadence: 1, irregular: 0, octave: 0 }),
        }));
      const sweep = run.events.filter((e) => e.name === 'oscillator.frequency');
      return sweep[sweep.length - 2].value;
    };
    assert.ok(midAt(0) < midAt(0.5) && midAt(0.5) < midAt(1),
      `${track}.${id}: glideCurve does not bend the sweep (${midAt(0)}, ${midAt(0.5)}, ${midAt(1)})`);
    assert.ok(midAt(0) > 440 && midAt(1) < 880,
      `${track}.${id}: a bent sweep left its own endpoints`);
  }
});

test('v19: cadence counts the calls in a note, and irregular unsettles them', () => {
  for (const [track, id] of CALL_VOICES) {
    for (const [duration, cadence, expected] of [
      [2, 1, 1], [2, 2, 2], [2, 3, 3], [4, 2, 4], [4, 3, 6], [1, 4, 2], [12, 8, 6],
    ]) {
      const note = {
        midi: 69, freq: 440, kind: null, duration, when: 0.5, velocity: 0.8, pan: 0,
      };
      const run = withSeed(59, () => playAndCheck(`${track}.${id} cadence ${cadence}`,
        VOICES[track][id], note, { patch: sculpt(track, id, { cadence, irregular: 0 }) }));
      assert.equal(oscillators(run).length, expected,
        `${track}.${id}: ${cadence} calls/bar over ${duration}s gave `
        + `${oscillators(run).length} chirps, not ${expected}`);
    }
    // Regular calls are evenly spaced and identically pitched; irregular ones
    // are neither, and the count is untouched either way.
    const note = { midi: 69, freq: 440, kind: null, duration: 4, when: 0.5, velocity: 0.8, pan: 0 };
    const starts = (irregular) => {
      const run = withSeed(60, () => playAndCheck(`${track}.${id} irregular ${irregular}`,
        VOICES[track][id], note, {
          patch: sculpt(track, id, { cadence: 3, irregular, glide: 12 }),
        }));
      return oscillators(run).map((n) => ({ at: n.startedAt, from: n.frequency.min }));
    };
    const strict = starts(0);
    const loose = starts(1);
    assert.equal(loose.length, strict.length, `${track}.${id}: irregular changed the call count`);
    assert.equal(new Set(strict.map((c) => c.from.toFixed(4))).size, 1,
      `${track}.${id}: irregular 0 still scattered the starting pitch`);
    assert.ok(new Set(loose.map((c) => c.from.toFixed(4))).size > 1,
      `${track}.${id}: irregular 1 did not scatter the starting pitch`);
    const gaps = (calls) => calls.slice(1).map((c, i) => c.at - calls[i].at);
    assert.ok(new Set(gaps(strict).map((g) => g.toFixed(4))).size === 1,
      `${track}.${id}: irregular 0 did not space the calls evenly`);
    assert.ok(new Set(gaps(loose).map((g) => g.toFixed(4))).size > 1,
      `${track}.${id}: irregular 1 did not unsettle the timing`);
  }
});

test('v19/v0.0.88: a call is a chirp through two formants it can move — the breath left by ruling', () => {
  const note = { midi: 69, freq: 440, kind: null, duration: 2, when: 0.5, velocity: 0.8, pan: 0 };
  for (const [track, id] of CALL_VOICES) {
    const run = withSeed(61, () => playAndCheck(`${track}.${id} formants`, VOICES[track][id],
      note, { patch: sculpt(track, id, { formant1: 700, formant2: 2600, cadence: 2 }) }));
    const bands = biquads(run).filter((n) => n.type === 'bandpass');
    assert.equal(bands.length, 2, `${track}.${id}: ${bands.length} formants, not 2`);
    const centres = bands.map((n) => Math.round(n.frequency.max)).sort((a, b) => a - b);
    assert.deepEqual(centres, [700, 2600].sort((a, b) => a - b),
      `${track}.${id}: the formant dials did not reach the filters`);
    // A formant is a resonance of the body, so the octave switch moves the
    // pitch the call sweeps from and leaves the formants where they were set.
    for (const octave of [-2, 2]) {
      const shifted = withSeed(61, () => playAndCheck(`${track}.${id} octave ${octave}`,
        VOICES[track][id], note, {
          patch: sculpt(track, id, { formant1: 700, formant2: 2600, cadence: 2, octave }),
        }));
      assert.deepEqual(
        biquads(shifted).filter((n) => n.type === 'bandpass')
          .map((n) => Math.round(n.frequency.max)).sort((a, b) => a - b),
        centres,
        `${track}.${id}: the octave switch dragged the formants with it`,
      );
      assert.notEqual(oscillators(shifted)[0].frequency.min, oscillators(run)[0].frequency.min,
        `${track}.${id}: the octave switch did not move the call's own pitch`);
    }
    // v0.0.88, his ruling verbatim: "please just delete the noise from the
    // Call instrument and be done with it." The chirp is the whole voice —
    // and a breath quietly returning would be the regression to catch.
    assert.ok(oscillators(run).length >= 1, `${track}.${id}: no chirp oscillator`);
    assert.equal(noiseSources(run).length, 0,
      `${track}.${id}: a noise source is back in the call — v0.0.88 deleted it by ruling`);
    const reaches = oscillators(run)[0].outputs.some((g) => g.outputs.some((f) => bands.includes(f)));
    assert.ok(reaches, `${track}.${id}: the chirp bypassed the formant pair`);
  }
});

/**
 * Every voice that existed before v19, and the hash of one unpatched note of
 * it — graph AND automation schedule, the same renderHash the v18 percussion
 * table uses.
 *
 * The numbers were taken from a differential run: the v19 library rendered
 * side by side with a copy of the module with every v19 addition stripped back
 * out, over 12 notes × 7 patches for all 21 voices, and every pair came back
 * identical. This table is what stops that drifting later — the sculpting
 * surface shares patchFor() with the whole library, and a field added to the
 * wrong side of `sculpted(defaults)` would be silent here and audible on air.
 */
const PRE_V19_GOLDEN = {
  'pad.warm': '57ade4cc:897',
  'pad.glass': '52aea4af:1797',
  'pad.strings': 'e88e44c0:1667',
  'pad.choir': '2e46116b:1392',
  'bass.sub': '248b2680:461',
  'bass.round': 'fa1614d8:547',
  'bass.breath': 'bf2bc38e:722',
  'melody.pluck': '89c34a44:769',
  'melody.bell': 'ab468f77:698',
  'melody.flute': '36f71c12:834',
  'melody.keys': '8415b5a6:715',
  'texture.sparkle': '1f776706:811',
  'texture.grains': 'ac0db90c:1875',
  'texture.chimes': '08d42b19:1212',
  // Re-pinned 2026-07-31: v0.0.80 retuned the wash DELIBERATELY (his "the
  // Ambient wash stops sawing") and this table was never moved with it.
  'texture.wash': '65183cb9:675',
  'arp.softPluck': 'd1490ebf:534',
  'arp.crystal': '16f5c50d:705',
  'arp.marimba': '336b527f:993',
  // These three are the same seed, note and velocity the v18 table already
  // pins from BEFORE v18 landed, and they still hash to the same values —
  // which is the cross-check that this table and that one agree.
  'percussion.soft': 'cfbcf5b3:633',
  'percussion.hand': '2de49603:853',
  'percussion.tick': 'ea55a535:589',
};

test('v19: every voice that predates the surface renders exactly what it did', () => {
  for (const [key, expected] of Object.entries(PRE_V19_GOLDEN)) {
    const [track, id] = key.split('.');
    const note = honestyNoteFor(track);
    const run = withSeed(4711, () => playAndCheck(key, VOICES[track][id], note));
    assert.equal(renderHash(run), expected, `${key}: an unpatched note no longer renders what it did`);
  }
});

test('v19: every new voice survives both ends of every new dial at once', () => {
  const ends = {
    tilt: [-1, 1], bandCentre: [60, 8000], bandWidth: [0.1, 4], sweepRate: [0, 0.5],
    sweepDepth: [0, 1], gust: [0, 1], gustRate: [0.02, 0.5], burst: [0, 1],
    burstSharp: [0, 1], swell: [0, 1], glide: [-24, 24], glideCurve: [0, 1],
    formant1: [60, 8000], formant2: [60, 8000], cadence: [0.5, 8], irregular: [0, 1],
  };
  for (const [track, id] of [...SCULPT_VOICES, ...CALL_VOICES]) {
    const fields = Object.keys(VOICES[track][id].defaults.source).filter((f) => f in ends);
    for (const corner of [0, 1]) {
      const source = Object.fromEntries(fields.map((f) => [f, ends[f][corner]]));
      for (const note of notesFor(track)) {
        playAndCheck(`${track}.${id} corner ${corner}`, VOICES[track][id], note,
          { patch: sculpt(track, id, source) });
        playAndCheck(`${track}.${id} corner ${corner} cancel`, VOICES[track][id], note,
          { patch: sculpt(track, id, source), cancelAfter: true });
      }
    }
    // And one dial at each end while the rest stay at the voice's own values —
    // the combination a listener actually makes when sculpting.
    for (const field of fields) {
      for (const value of ends[field]) {
        for (const note of notesFor(track)) {
          playAndCheck(`${track}.${id} ${field}=${value}`, VOICES[track][id], note,
            { patch: sculpt(track, id, { [field]: value }) });
        }
      }
    }
  }
});

// --------------------------------------------------------------------------
// v18 — engineType: the synthesis class the selector shows as "custom [engine]"
// --------------------------------------------------------------------------

const ENGINE_CLASSES = ['subtractive', 'fm', 'noise', 'physical', 'hybrid'];

test('v18: every voice declares an engineType from the contract\'s five classes', () => {
  let declared = 0;
  for (const [track, patches] of Object.entries(EXPECTED)) {
    for (const id of Object.keys(patches)) {
      const { engineType } = VOICES[track][id];
      assert.equal(typeof engineType, 'string', `${track}.${id}: engineType is not a string`);
      assert.ok(ENGINE_CLASSES.includes(engineType),
        `${track}.${id}: engineType ${JSON.stringify(engineType)} is not one of `
        + ENGINE_CLASSES.join('|'));
      declared += 1;
    }
  }
  // 21 at v18, plus v19's colour, cloud and the two readings of call, plus
  // v27's eleven signature voices.
  assert.equal(declared, 36, `${declared} voices carry an engineType, not 36`);
});

// --------------------------------------------------------------------------
// v27 — the signature voices: a genre has to be nameable from one bar
// --------------------------------------------------------------------------

/** Every voice v27 added, by track. */
const V27 = {
  pad: ['polysaw'],
  bass: ['fingered', 'sawbass', 'acid', 'upright'],
  melody: ['tines', 'nylon', 'tape', 'stab'],
  arp: ['muted'],
  percussion: ['dust'],
};

test('v27: the new voices are no louder than the loudest already on their track', () => {
  for (const [track, added] of Object.entries(V27)) {
    const note = attackNote(track);
    const level = (id) => withSeed(70, () => playAndCheck(`${track}.${id}`,
      VOICES[track][id], note)).sum;
    const existing = Object.keys(VOICES[track]).filter((id) => !added.includes(id));
    const loudest = Math.max(...existing.map(level));
    for (const id of added) {
      assert.ok(level(id) <= loudest * 1.1,
        `${track}.${id} reaches the bus at ${level(id).toFixed(3)} where the loudest voice `
        + `already on the track reaches ${loudest.toFixed(3)} — that is a jump on switching voice`);
    }
  }
});

test('v27: every new voice renders a different graph from its track neighbours', () => {
  // Two voices on a track that hash the same are the same voice under two
  // names — which is the samey-genres complaint this wave exists to answer.
  for (const [track, added] of Object.entries(V27)) {
    const note = honestyNoteFor(track);
    const hashes = new Map();
    for (const id of Object.keys(VOICES[track])) {
      const run = withSeed(4711, () => playAndCheck(`${track}.${id}`, VOICES[track][id], note));
      hashes.set(id, renderHash(run));
    }
    for (const id of added) {
      for (const [other, hash] of hashes) {
        if (other === id) continue;
        assert.notEqual(hashes.get(id), hash, `${track}.${id} renders exactly like ${track}.${other}`);
      }
    }
  }
});

test('v27: the bass voices that should stop, stop — short tails, and one struck', () => {
  // The owner's complaint was a bass that wanders on over the bar. A note
  // asked for 0.25 s must be finished inside a beat at 120 bpm.
  const note = { midi: 40, freq: null, kind: null, when: 0.5, duration: 0.25, velocity: 0.9, pan: 0 };
  for (const id of ['fingered', 'acid']) {
    const { tail } = playAndCheck(`bass.${id}`, VOICES.bass[id], note);
    assert.ok(tail <= 0.5, `bass.${id}: ${tail.toFixed(2)}s tail on a 0.25s note`);
  }
  // Upright is struck, so it publishes sustain 0 and rings out on its own
  // decay rather than holding — which is what a plucked string does.
  assert.equal(VOICES.bass.upright.defaults.adsr.sustain, 0, 'bass.upright is not struck');
});


// --------------------------------------------------------------------------
// v12 — mono/legato: retarget pathway (if wired) and safe fallback
//
// The v12 addendum specs the BEHAVIOUR (retarget without a second envelope
// attack) but leaves the legatoFrom wire shape unpinned — engine-voices.js is
// free to invent it. This suite can only discover it by trying the most
// natural extensions of the existing note/patch/handle contract and watching
// what the mock records; if none of the tried shapes changes behaviour, the
// pathway is either not wired yet or uses a shape this suite did not guess,
// and the test skips cleanly rather than asserting something it cannot
// actually observe. See the final report for the exact shapes tried.
// --------------------------------------------------------------------------

function freqOf(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

/** Try play()ing note2 as a legato continuation of handle1, several plausible ways. */
function tryLegatoShapes(voice, ctx, destination, note1Handle, note2Base) {
  const attempts = [
    // The confirmed v12 shape (read from the landed engine/voices source once
    // it existed to read): note.legatoFrom = { handle, glide, freq }, where
    // `handle` is whatever the previous play() call returned. A voice that
    // supports it returns `{ ...cancel/etc, legato: true }`; one that does not
    // just falls through to an ordinary fresh note.
    () => voice.play(ctx, destination, {
      ...note2Base,
      legatoFrom: { handle: note1Handle, glide: 0.05, freq: freqOf(note2Base.midi) },
    }),
    // Earlier guesses, kept as harmless fallbacks in case a different voice
    // reads a different shape.
    () => voice.play(ctx, destination, { ...note2Base, legatoFrom: note1Handle }),
    () => voice.play(ctx, destination, { ...note2Base, legato: true }, undefined, note1Handle),
    () => (typeof note1Handle.retarget === 'function' ? note1Handle.retarget(note2Base) : undefined),
    () => (typeof note1Handle.glideTo === 'function' ? note1Handle.glideTo(note2Base) : undefined),
  ];
  for (const attempt of attempts) {
    try {
      const result = attempt();
      if (result !== undefined) return result;
    } catch {
      // that shape is not what this voice/engine expects — try the next one
    }
  }
  return voice.play(ctx, destination, note2Base); // last resort: a plain retrigger
}

test('v12 legato: melody.pluck/flute retargets pitch on an abutting note rather than reattacking (if wired)', () => {
  const ids = ['pluck', 'flute'].filter((id) => VOICES.melody[id]);
  assert.ok(ids.length > 0, 'neither melody.pluck nor melody.flute exists to test');
  let tried = 0;
  for (const id of ids) {
    const voice = VOICES.melody[id];
    const ctx = new MockAudioContext();
    const destination = makeNode('gain');
    created = []; startedSources = []; automation.length = 0;

    const note1 = { midi: 60, freq: null, kind: null, when: 0.5, duration: 0.4, velocity: 0.8, pan: 0 };
    const handle1 = voice.play(ctx, destination, note1);
    const sourcesBefore = startedSources.length;
    const autoBefore = automation.length;

    ctx.currentTime = 0.9;
    const note2 = {
      midi: 64, freq: null, kind: null, when: 0.9, duration: 0.4, velocity: 0.8, pan: 0, glide: 0.5,
    };
    const handle2 = tryLegatoShapes(voice, ctx, destination, handle1, note2);

    const newSources = startedSources.length - sourcesBefore;
    const freqWrites = automation.slice(autoBefore)
      .filter((a) => a.name.includes('frequency') && Math.abs(a.value - freqOf(64)) < 3);
    const freshAttack = automation.slice(autoBefore)
      .some((a) => a.name.includes('gain') && a.value < 0.03
        && (a.kind === 'set' || a.kind === 'linear' || a.kind === 'exponential'));
    const confirmed = handle2 && handle2.legato === true;

    if (!confirmed && (newSources > 0 || !freqWrites.length)) {
      console.log(`SKIP v12 legato (melody.${id}): no retarget pathway detected via `
        + 'note.legatoFrom={handle,glide,freq} or the earlier guessed shapes — '
        + `this voice may simply not support legato (contract only requires one that does)`);
    } else {
      tried += 1;
      assert.equal(newSources, 0, `melody.${id}: a confirmed legato retarget still started a new source`);
      assert.ok(!freshAttack,
        `melody.${id}: a legato-retargeted note still shows a fresh envelope attack from near-zero`);
    }
    for (const source of startedSources) source.onended?.();
  }
  if (!tried) console.log('SKIP v12 legato: no candidate voice exposed a detectable retarget pathway');
});

test('v12 legato: a non-oscillator voice falls back to a plain retrigger without throwing', () => {
  const candidates = [
    ['percussion', 'soft'], ['texture', 'grains'], ['texture', 'wash'], ['arp', 'crystal'],
  ].filter(([track, id]) => VOICES[track] && VOICES[track][id]);
  assert.ok(candidates.length > 0, 'no candidate non-oscillator voices found to test');
  for (const [track, id] of candidates) {
    const voice = VOICES[track][id];
    const ctx = new MockAudioContext();
    const destination = makeNode('gain');
    created = []; startedSources = []; automation.length = 0;
    const note1 = track === 'percussion'
      ? { midi: null, freq: null, kind: 'low', when: 0.5, duration: 0.25, velocity: 0.8, pan: 0 }
      : { midi: 60, freq: null, kind: null, when: 0.5, duration: 1, velocity: 0.8, pan: 0 };
    const handle1 = voice.play(ctx, destination, note1);
    const note2 = {
      ...note1, when: note1.when + note1.duration, legatoFrom: handle1, legato: true, glide: 0.3,
    };
    ctx.currentTime = note2.when;
    assert.doesNotThrow(() => tryLegatoShapes(voice, ctx, destination, handle1, note2),
      `${track}.${id}: a legato hint on a non-oscillator voice must not throw`);
    assert.ok(startedSources.length >= 1, `${track}.${id}: the fallback retrigger produced no source`);
    for (const source of startedSources) source.onended?.();
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
