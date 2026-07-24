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

const { VOICES } = await import('../src/scripts/engine-voices.js');

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
function playAndCheck(label, patch, note, { cancelAfter = false } = {}) {
  const ctx = new MockAudioContext();
  const destination = makeNode('gain');   // stands in for the engine's track bus
  created = [];
  startedSources = [];
  automation.length = 0;

  const handle = patch.play(ctx, destination, note);

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

  return { tail, sum, nodes: created.length, ctx };
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
      assert.equal(Object.keys(voice).sort().join(','), 'label,play',
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
