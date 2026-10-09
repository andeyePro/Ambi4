/**
 * v0.0.217 — the arp's PHASE PROCESS (TODO "Minimalism needs a PROCESS
 * mechanism, not a voicing pass"). Run with:
 *
 *   npm run build && node tests/arp-phase-smoke.mjs
 *
 * `arp.phase` (percent, sparse) makes the arp play its figure twice: the lead,
 * and a copy running that many percent slower — Reich's Piano Phase. The
 * owner cannot be asked to listen for it and nobody here can hear, so this
 * suite MEASURES the process in the note stream, the copy carrying
 * `phase: true` on its 'note' events:
 *
 *   - every lead note has a copy, `offset` late, where offset is the lag
 *     (phase% × beats played so far) wrapped at one step — so the onset gap
 *     GROWS bar by bar and WRAPS, predicted to the microsecond;
 *   - each wrap moves the copy one note further behind in the figure (its
 *     pitch is the lead's pitch `shift` steps earlier), and after the whole
 *     figure it is back in UNISON — the process goes out of phase and back;
 *   - a copy pushed past the barline still sounds, in the next bar;
 *   - sparse: no key by default, no copy unless asked, every other genre
 *     compiles without one, Minimalism with one; a mono arp has no copy.
 *
 * Red on the pre-v0.0.217 engine: it has no copy at all (and no phase key).
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// --------------------------------------------------------------------------
// Minimal AudioContext mock — the thin shape auto-ladder-smoke.mjs uses; this
// suite reads 'bar' and 'note' events only.
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
const { compileGenre } = await import('../src/scripts/genre-compiler.js');

const seededRng = (seed) => () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
const builtEngines = [];
function createEngine(...args) {
  const made = engineModule.createEngine(...args);
  builtEngines.push(made);
  return made;
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

// The fixture: the arp alone, a hand-written MANUAL lane with every eighth on
// at full probability, nothing humanised — so the lead is an exact grid and
// every number below can be predicted rather than estimated.
const BPM = 120;
const SEC_PER_BEAT = 60 / BPM;
const STEP_BEATS = 0.5; // '1/8'
const STEP_SEC = STEP_BEATS * SEC_PER_BEAT;
const BEATS_PER_BAR = 4;
const FULL_LANE = Array.from({ length: 20 }, () => ({ on: true, prob: 1, vmin: 0.7, vmax: 0.7 }));
const STILL = { voice: 0, volume: 0, pitch: 0, timing: 0, pan: 0 };

function fixture(phase, extra = {}) {
  const off = { state: 'off' };
  return {
    bpm: BPM,
    timeSignature: '4/4',
    swing: 0,
    complexity: 0,
    repetition: 1,
    structure: 'drone',
    arp: { mode: 'manual', pattern: 'up', rate: '1/8', octaves: 1, gate: 0.6, ...(phase === undefined ? {} : { phase }) },
    tracks: {
      pad: off, bass: off, melody: off, texture: off, percussion: off,
      arp: {
        state: 'on',
        randomness: 0,
        vary: STILL,
        sequencers: [{ mode: 'manual', hand: true, steps: FULL_LANE }],
        ...extra,
      },
    },
  };
}

async function play(params, bars, seed = 7) {
  const engine = createEngine(params, { rng: seededRng(seed) });
  const barStarts = [];
  const lead = [];
  const copy = [];
  engine.on('bar', (event) => { barStarts[event.bar] = event.time; });
  engine.on('note', (note) => {
    if (note.track !== 'arp' || note.live) return;
    (note.phase === true ? copy : lead).push(note);
  });
  await engine.start();
  await advance(BEATS_PER_BAR * SEC_PER_BEAT * (bars + 1));
  engine.stop();
  return { engine, barStarts, lead, copy };
}

/** Which bar a time falls in, and the beat inside it. */
function locate(barStarts, time) {
  for (let b = barStarts.length - 1; b >= 0; b--) {
    if (barStarts[b] !== undefined && time >= barStarts[b] - 1e-6) {
      return { bar: b, beat: (time - barStarts[b]) / SEC_PER_BEAT };
    }
  }
  return null;
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---------------------------------------------------------------------------
// The param: sparse, clamped, cleared by null, carried by a partial.
// ---------------------------------------------------------------------------

test('sanitise: arp.phase is sparse — absent by default, set, clamped, cleared by 0 or null', () => {
  const fresh = engineModule.sanitiseParams({});
  assert.equal('phase' in fresh.arp, false, 'the default arp carries no phase key');
  assert.equal('phase' in engineModule.DEFAULT_PARAMS.arp, false);
  const set = engineModule.sanitiseParams({ arp: { phase: 1.5 } });
  assert.equal(set.arp.phase, 1.5);
  assert.equal(engineModule.sanitiseParams({ arp: { phase: 99 } }).arp.phase, engineModule.ARP_PHASE_MAX);
  assert.equal(engineModule.sanitiseParams({ arp: { phase: 0.01 } }).arp.phase, 0.1, 'a sliver clamps up to the floor');
  assert.equal('phase' in engineModule.sanitiseParams({ arp: { phase: 0 } }, set).arp, false, '0 clears it');
  assert.equal('phase' in engineModule.sanitiseParams({ arp: { phase: null } }, set).arp, false, 'null clears it');
  assert.equal(engineModule.sanitiseParams({ arp: { pattern: 'down' } }, set).arp.phase, 1.5,
    'a partial that does not mention it keeps it');
  assert.equal(engineModule.sanitiseParams({ arp: { phase: 'fast' } }, set).arp.phase, 1.5,
    'a non-number keeps what was there');
});

test('genres: Minimalism compiles a phase copy; every other genre compiles exactly the arp it did', () => {
  const dir = new URL('../src/data/genres/', import.meta.url);
  const genres = readdirSync(dir).filter((n) => n.endsWith('.json')).sort()
    .map((n) => JSON.parse(readFileSync(new URL(n, dir), 'utf8')));
  assert.ok(genres.length >= 12, `only ${genres.length} genre files`);
  for (const genre of genres) {
    const compiled = compileGenre(genre, { rng: seededRng(11) });
    if (genre.slug === 'minimalism') {
      assert.equal(compiled.arp.phase, genre.essence.process.arpPhase, 'Minimalism must compile its phase');
    } else {
      assert.equal('phase' in compiled.arp, false, `${genre.slug} must not grow a phase key`);
    }
  }
  // No draw: the compile of Minimalism with and without the process is the
  // same piece in every other respect.
  const minimalism = genres.find((g) => g.slug === 'minimalism');
  const without = JSON.parse(JSON.stringify(minimalism));
  delete without.essence.process;
  const a = compileGenre(minimalism, { rng: seededRng(5) });
  const b = compileGenre(without, { rng: seededRng(5) });
  delete a.arp.phase;
  assert.deepEqual(a, b, 'the process field must not move any other compiled value');
});

// ---------------------------------------------------------------------------
// The process itself, measured in the note stream.
// ---------------------------------------------------------------------------

test('unset: no copy is ever played', () => hiddenTab(async () => {
  const { lead, copy } = await play(fixture(undefined), 8);
  assert.ok(lead.length >= 8 * 8 - 8, `the lead played only ${lead.length} notes`);
  assert.equal(copy.length, 0, 'an arp with no phase must play no copy');
}));

const PHASE = 2; // percent — a lag of 0.08 beats a bar: a wrap every 6.25 bars
const BARS = 24; // the figure (3 notes) is 1.5 beats: back in unison at 18.75 bars

test('the copy’s onset gap grows bar by bar, wraps at a step, and every lead note has one', () => hiddenTab(async () => {
  const { barStarts, lead, copy } = await play(fixture(PHASE), BARS);
  assert.ok(copy.length > 0, 'phase is set and no copy was played at all');
  const copyTimes = copy.map((n) => n.time);
  const perBar = new Map();
  let checked = 0;
  for (const note of lead) {
    const at = locate(barStarts, note.time);
    if (!at || at.bar >= BARS - 1) continue;
    const lag = (PHASE / 100) * (at.bar * BEATS_PER_BAR + at.beat);
    const offsetBeats = lag % STEP_BEATS;
    const expected = note.time + offsetBeats * SEC_PER_BEAT;
    const match = copyTimes.find((t) => Math.abs(t - expected) < 1e-6);
    assert.ok(match !== undefined,
      `bar ${at.bar} beat ${at.beat.toFixed(2)}: no copy at +${(offsetBeats * SEC_PER_BEAT * 1000).toFixed(2)} ms`);
    if (!perBar.has(at.bar)) perBar.set(at.bar, offsetBeats);
    checked += 1;
  }
  assert.ok(checked >= (BARS - 2) * 8, `only ${checked} lead notes were checked`);
  // The gap at each bar's downbeat, in ms: rising by 0.08 beats (40 ms) a bar,
  // then wrapping back near zero — the number that IS the process.
  const gaps = [...perBar.keys()].sort((x, y) => x - y).map((bar) => perBar.get(bar) * SEC_PER_BEAT * 1000);
  let rises = 0;
  let wraps = 0;
  for (let i = 1; i < gaps.length; i++) {
    if (gaps[i] > gaps[i - 1]) rises += 1;
    else wraps += 1;
  }
  assert.ok(rises >= 15, `the gap rose only ${rises} times: ${gaps.map((g) => g.toFixed(0)).join(' ')}`);
  assert.ok(wraps >= 3, `the gap wrapped only ${wraps} times: ${gaps.map((g) => g.toFixed(0)).join(' ')}`);
  console.log(`     downbeat gap ms by bar: ${gaps.map((g) => g.toFixed(0)).join(' ')}`);
}));

test('each wrap puts the copy one note further behind, and after the whole figure it is back in unison', () => hiddenTab(async () => {
  const { barStarts, lead, copy } = await play(fixture(PHASE), BARS);
  const byTime = new Map(copy.map((n) => [Math.round(n.time * 1e6), n]));
  const leadByBar = new Map();
  for (const note of lead) {
    const at = locate(barStarts, note.time);
    if (!at) continue;
    if (!leadByBar.has(at.bar)) leadByBar.set(at.bar, []);
    leadByBar.get(at.bar).push({ ...note, slot: Math.round(at.beat / STEP_BEATS), beat: at.beat });
  }
  const shiftsSeen = [];
  let pitchChecks = 0;
  for (let bar = 0; bar < BARS - 1; bar++) {
    const notes = (leadByBar.get(bar) ?? []).sort((x, y) => x.slot - y.slot);
    if (notes.length !== 8) continue;
    const figure = new Set(notes.map((n) => n.midi)).size;
    // The lead walks the figure: its pitches repeat every `figure` slots.
    if (!notes.every((n, i) => i < figure || n.midi === notes[i - figure].midi)) continue;
    for (const note of notes) {
      const lag = (PHASE / 100) * (bar * BEATS_PER_BAR + note.beat);
      const wrapped = lag % (figure * STEP_BEATS);
      const shift = Math.floor(wrapped / STEP_BEATS + 1e-9) % figure;
      const offset = wrapped - Math.floor(wrapped / STEP_BEATS + 1e-9) * STEP_BEATS;
      const twin = byTime.get(Math.round((note.time + offset * SEC_PER_BEAT) * 1e6));
      assert.ok(twin, `bar ${bar} slot ${note.slot}: copy missing`);
      // The note the lead played `shift` slots earlier, read off the lead's
      // own period inside this bar.
      let source = note.slot - shift;
      while (source < 0) source += figure;
      assert.equal(twin.midi, notes[source].midi,
        `bar ${bar} slot ${note.slot}: the copy, ${shift} behind, must play the lead's slot-${source} note`);
      pitchChecks += 1;
      if (note.slot === 0) shiftsSeen.push(shift);
    }
  }
  assert.ok(pitchChecks >= 8 * 12, `only ${pitchChecks} copy pitches checked`);
  // Out of phase one note at a time, all the way round, and back to unison.
  const order = shiftsSeen.filter((s, i) => i === 0 || s !== shiftsSeen[i - 1]);
  assert.deepEqual(order.slice(0, 4), [0, 1, 2, 0],
    `the copy should go 0 → 1 → 2 notes behind and back to unison; went ${order.join(' → ')}`);
  console.log(`     notes behind at each downbeat: ${shiftsSeen.join(' ')}`);
}));

test('a copy pushed past the barline sounds early in the next bar instead of being lost or clamped', () => hiddenTab(async () => {
  // Quarter steps in 7/8: the last step starts half a beat before the
  // barline, so once the lag passes half a beat its copy belongs to the NEXT
  // bar. (On an eighth grid in 4/4 no copy ever crosses — the last step ends
  // at the barline and the offset is always less than a step.)
  const params = fixture(PHASE);
  params.timeSignature = '7/8';
  params.arp.rate = '1/4';
  const { barStarts, lead, copy } = await play(params, 20);
  const beatsPerBar = (barStarts[2] - barStarts[1]) / SEC_PER_BEAT;
  assert.ok(Math.abs(beatsPerBar - 3.5) < 1e-6, `7/8 bar is ${beatsPerBar} beats`);
  let carried = 0;
  let checked = 0;
  for (const note of lead) {
    const at = locate(barStarts, note.time);
    if (!at || at.bar >= 19) continue;
    const lag = (PHASE / 100) * (at.bar * beatsPerBar + at.beat);
    const expected = note.time + (lag % 1) * SEC_PER_BEAT;
    checked += 1;
    if (expected >= barStarts[at.bar + 1] - 1e-6) carried += 1;
    assert.ok(copy.some((c) => Math.abs(c.time - expected) < 1e-6),
      `bar ${at.bar} beat ${at.beat.toFixed(2)}: its copy belongs at ${expected.toFixed(4)} s`);
  }
  assert.ok(checked >= 19 * 4, `only ${checked} lead notes checked`);
  assert.ok(carried >= 3, `only ${carried} copies crossed a barline, so this proved little`);
}));

test('a mono arp has room for one note, so it plays no copy', () => hiddenTab(async () => {
  const { lead, copy } = await play(fixture(PHASE, { mono: true }), 6);
  assert.ok(lead.length > 0);
  assert.equal(copy.length, 0, 'a copy on a mono arp would cut the lead it follows');
}));

test('getResolved reports where the process stands; setParams 0 stops the copy at the next bar', () => hiddenTab(async () => {
  const engine = createEngine(fixture(PHASE), { rng: seededRng(3) });
  let copies = 0;
  engine.on('note', (note) => { if (note.phase === true) copies += 1; });
  await engine.start();
  await advance(BEATS_PER_BAR * SEC_PER_BEAT * 4);
  const live = engine.getResolved().arpPhase;
  assert.ok(live && live.percent === PHASE, 'arpPhase must report the percent');
  assert.ok(live.lagBeats > 0 && Number.isFinite(live.steps) && live.figure === 3,
    `arpPhase readout incomplete: ${JSON.stringify(live)}`);
  engine.setParams({ arp: { phase: 0 } });
  assert.equal(engine.getResolved().arpPhase, null);
  await advance(BEATS_PER_BAR * SEC_PER_BEAT * 2);
  const before = copies;
  await advance(BEATS_PER_BAR * SEC_PER_BEAT * 3);
  engine.stop();
  assert.ok(before > 0);
  assert.equal(copies, before, 'copies kept coming after phase was set to 0');
}));

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
    liveContexts.length = 0;
  }
}
console.log(`${tests.length - failures}/${tests.length} passed`);
if (failures) process.exit(1);
