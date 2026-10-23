/**
 * Note sources — every pitched note the engine generates says WHY it was
 * chosen: the mechanism that decided it, not what it turned out to be against
 * the chord (that is `role`, tests/note-role-smoke.mjs). TODO, "Engine
 * telemetry to support all of the above".
 *
 *   node tests/note-source-smoke.mjs
 *
 * The 'note' event gains `source`, one of NOTE_SOURCES for its track (see
 * docs/engine-v2-contract.md), and a melody note also names the development
 * its bar stated (`development`, one of MOTIF_OPS). Telemetry: each value is a
 * fact the planner already decided, so tests/audio-reference.mjs is unmoved.
 * The laws below tie a source to behaviour a listener could check, so a tag
 * that lied would fail here rather than mislead a piano roll.
 */
import assert from 'node:assert/strict';

// Minimal AudioContext mock — the same thin shape voice-rule-smoke.mjs uses:
// enough surface for the engine's graph, no node-graph assertions here since
// this suite only reads 'note' and 'bar' events.
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
const { TIME_SIGNATURES } = engineModule;

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
const { NOTE_SOURCES = {}, MOTIF_OPS } = engineModule;
const MELODY_FAMILY = ['motif', 'lean', 'grace', 'cadence'];

async function collect(extra = {}, { bars = 12, seed = 9091, during } = {}) {
  const engine = createEngine({
    bpm: 200, speed: 2, structure: 'drone', timeSignature: '4/4', complexity: 0.8, mode: 'dorian', root: 'D',
    swing: 0,
    tracks: {
      pad: { state: 'on' }, bass: { state: 'on' }, melody: { state: 'on' },
      arp: { state: 'on' }, texture: { state: 'on' }, percussion: { state: 'on' },
    },
    ...extra,
  }, { rng: seededRng(seed) });
  const notes = [];
  const barsSeen = [];
  engine.on('note', (e) => notes.push(e));
  engine.on('bar', (e) => barsSeen.push(e));
  await engine.start();
  if (during) during(engine);
  await advance(barSeconds({ bpm: 200 }) * bars, { step: 0.12, sleep: 4 });
  engine.stop();
  barsSeen.sort((a, b) => a.time - b.time);
  // Which bar a note belongs to, and its planned beat inside it.
  const barOf = (n) => {
    let found = null;
    for (const b of barsSeen) if (b.time <= n.time + 1e-6) found = b;
    return found;
  };
  const spb = barsSeen.length > 1 ? (barsSeen[1].time - barsSeen[0].time) / barsSeen[0].beatsPerBar : 0.15;
  return { notes, barsSeen, barOf, spb };
}

const allowed = (n) => {
  if (n.live) return NOTE_SOURCES.live || [];
  const own = NOTE_SOURCES[n.track] || NOTE_SOURCES.user || [];
  // Call and response: the arp may play the melody's bar, with its sources.
  return n.track === 'arp' && n.motif === true ? [...own, ...(NOTE_SOURCES.melody || [])] : own;
};

test('every generated pitched note names its source from the documented set', async () => {
  const { notes } = await collect();
  const pitched = notes.filter((n) => n.track !== 'percussion');
  assert.ok(pitched.length > 40, `${pitched.length} pitched notes`);
  const bad = pitched.filter((n) => !allowed(n).includes(n.source));
  assert.equal(bad.length, 0, `${bad.length} of ${pitched.length} notes carry no documented source: `
    + [...new Set(bad.map((n) => `${n.track}:${n.source}`))].join(', '));
  for (const n of notes.filter((x) => x.track === 'percussion')) assert.ok(!('source' in n), 'a drum hit carries a source');
  // It says something: every generated track shows more than one mechanism
  // over twelve bars somewhere (the melody and the bass at least).
  for (const track of ['melody', 'bass']) {
    const kinds = new Set(pitched.filter((n) => n.track === track).map((n) => n.source));
    assert.ok(kinds.size >= 2, `${track} only ever says ${[...kinds].join(', ')}`);
  }
});

test('the bass: a groove tone is that tone, and the approach leans into the next bar', async () => {
  let approaches = 0;
  let aimed = 0;
  for (const seed of [9091, 31, 4242]) {
    const { notes, barOf, spb } = await collect({}, { seed });
    const bass = notes.filter((n) => n.track === 'bass' && !n.live);
    assert.ok(bass.length > 10, `${bass.length} bass notes`);
    for (const n of bass) {
      // A perfect fifth above the chord's root, by design (not the chord's
      // own fifth, which is diminished on a vii) — so the law is the interval.
      if (n.source === 'groove-root' || n.source === 'groove-octave') assert.equal(n.interval, 0, `${n.source} is ${n.interval} above the root`);
      if (n.source === 'groove-fifth') assert.equal(n.interval, 7, `groove-fifth is ${n.interval} above the root`);
    }
    for (const n of bass.filter((x) => x.source === 'approach')) {
      approaches += 1;
      const b = barOf(n);
      const inBar = bass.filter((x) => barOf(x) === b);
      assert.equal(inBar[inBar.length - 1], n, 'an approach is not the last bass note of its bar');
      const beat = (n.time - b.time) / spb;
      assert.ok(Math.abs(beat - Math.round(beat)) > 0.1, `an approach sits on beat ${beat.toFixed(2)}`);
      // Among this chord's root, fifth and octave it is the one nearest the
      // root the NEXT bar's groove lands on.
      const root = inBar.find((x) => x.source === 'groove-root');
      const next = bass.find((x) => x.time > b.time + b.beatsPerBar * spb - 1e-3 && x.source === 'groove-root');
      if (!root || !next) continue;
      const r = root.midi;
      const options = [r, r + 7, r + 12 <= 55 ? r + 12 : r - 12 >= 28 ? r - 12 : r];
      const best = Math.min(...options.map((m) => Math.abs(m - next.midi)));
      aimed += 1;
      assert.equal(Math.abs(n.midi - next.midi), best, `approach ${n.midi} is not the tone nearest the next root ${next.midi}`);
    }
  }
  assert.ok(approaches > 0 && aimed > 0, `${approaches} approaches named, ${aimed} checked against the next root`);
});

test('the melody: motif notes follow event.motif, name a development, and a cadence lands', async () => {
  const { notes, barOf } = await collect();
  const melody = notes.filter((n) => n.track === 'melody' && !n.live);
  assert.ok(melody.length > 10, `${melody.length} melody notes`);
  const sources = new Set(melody.map((n) => n.source));
  assert.ok(sources.has('motif') && sources.has('cadence'), `melody sources ${[...sources].join(', ')}`);
  for (const n of notes.filter((x) => MELODY_FAMILY.includes(x.source))) {
    assert.equal(n.motif, true, `a ${n.source} note is not motif-derived`);
    assert.ok(MOTIF_OPS.includes(n.development), `a ${n.source} note names development ${n.development}`);
  }
  for (const n of notes.filter((x) => !MELODY_FAMILY.includes(x.source))) {
    assert.ok(!('development' in n), `a ${n.track} ${n.source} note names a development`);
  }
  for (const n of notes.filter((x) => x.source === 'cadence')) {
    const inBar = notes.filter((x) => x.track === n.track && barOf(x) === barOf(n) && MELODY_FAMILY.includes(x.source));
    assert.equal(inBar[inBar.length - 1], n, 'a cadence is not the last note of its bar');
    assert.ok(!['passing', 'outside'].includes(n.role), `a cadence lands on a ${n.role}`);
  }
  // A grace note leans into a cell note a quarter-beat later.
  for (const g of melody.filter((x) => x.source === 'grace')) {
    assert.ok(melody.some((x) => x !== g && x.time > g.time && x.source !== 'grace'), 'a grace note leads nowhere');
  }
});

test('the pad: voicing and breath are chord tones; the breath is struck half a bar in', async () => {
  let breaths = 0;
  for (const seed of [9091, 31, 4242, 77]) {
    const { notes, barOf, spb } = await collect({}, { seed });
    const pad = notes.filter((n) => n.track === 'pad');
    for (const n of pad.filter((x) => x.source === 'voicing' || x.source === 'breath')) {
      assert.ok(!['passing', 'outside'].includes(n.role), `a pad ${n.source} note is ${n.role}`);
    }
    for (const n of pad.filter((x) => x.source === 'breath')) {
      breaths += 1;
      const b = barOf(n);
      const beat = (n.time - b.time) / spb;
      assert.ok(Math.abs(beat - b.beatsPerBar / 2) < 0.25, `a breath at beat ${beat.toFixed(2)} of ${b.beatsPerBar}`);
    }
  }
  assert.ok(breaths > 0, 'no pad breath was ever named');
});

test('under chords in beats, the bass approach into a mid-bar change says approach', async () => {
  // The same piece with and without beats: under beats there are more
  // approach notes, because every mid-bar change gets one as well.
  const plain = (await collect({ complexity: 0.9 }, { bars: 24 })).notes.filter((n) => n.track === 'bass' && n.source === 'approach').length;
  const beats = (await collect({ complexity: 0.9, harmony: { beats: 2 } }, { bars: 24 })).notes.filter((n) => n.track === 'bass' && n.source === 'approach').length;
  assert.ok(beats > plain, `approach notes: ${beats} under beats 2 against ${plain} without — the mid-bar ones are not named`);
});

test('the arp: phase copies say phase, additive slots say cell, doubles sit on a lead note', async () => {
  const phased = await collect({ arp: { phase: 1.5 } });
  const arp = phased.notes.filter((n) => n.track === 'arp' && n.motif !== true);
  assert.ok(arp.some((n) => n.phase === true), 'no phase copy played');
  for (const n of arp) assert.equal(n.source === 'phase', n.phase === true, `phase ${n.phase} but source ${n.source}`);
  // Doubling starts at complexity 0.85, above collect()'s 0.8, so the law
  // gets a piece of its own where it can fire (the merge found it vacuous).
  const busy = await collect({ complexity: 0.97 });
  const busyArp = busy.notes.filter((n) => n.track === 'arp' && n.motif !== true);
  const doubles = busyArp.filter((n) => n.source === 'double');
  assert.ok(doubles.length > 0, 'no arp double at complexity 0.97 — the double law checked nothing');
  for (const d of doubles) {
    assert.ok(busyArp.some((n) => n !== d && Math.abs(n.time - d.time) < 1e-6 && ['figure', 'cell', 'step'].includes(n.source)),
      'a double sits on no lead note');
  }
  const additive = await collect({ arp: { mode: 'manual', additive: { every: 2 } },
    tracks: { pad: { state: 'off' }, bass: { state: 'off' }, melody: { state: 'off' }, texture: { state: 'off' }, percussion: { state: 'off' },
      arp: { state: 'on', sequencers: [{ mode: 'manual', hand: true, steps: Array.from({ length: 16 }, () => ({ on: true })) }] } } });
  const lead = additive.notes.filter((n) => n.track === 'arp');
  assert.ok(lead.some((n) => Number.isInteger(n.cell)), 'no additive cell note played');
  for (const n of lead) assert.equal(n.source === 'cell', Number.isInteger(n.cell), `cell ${n.cell} but source ${n.source}`);
});

test('play-along notes say live, and the generated ones beside them do not', async () => {
  const { notes } = await collect({}, { bars: 3, during: (engine) => engine.noteOn('melody', 62, 0.8) });
  const live = notes.filter((n) => n.live);
  assert.ok(live.length >= 1, 'the live note never arrived');
  for (const n of live) assert.equal(n.source, 'live');
  for (const n of notes.filter((x) => !x.live)) assert.notEqual(n.source, 'live');
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
