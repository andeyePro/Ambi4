/**
 * v0.0.228 — the arp's ADDITIVE PROCESS (TODO "Minimalism needs a PROCESS
 * mechanism", the second process after v0.0.217's phase). Run with:
 *
 *   npm run build && node tests/arp-additive-smoke.mjs
 *
 * `arp.additive = { every, mode }` (sparse) is Philip Glass's additive
 * structure: the arp plays the first two notes of its figure, and after
 * `every` complete repetitions adds the next — 1-2, 1-2-3, 1-2-3-4, … — until
 * the whole figure sounds, then starts again ('grow') or takes the notes away
 * one at a time ('grow-shrink'). Nobody here can hear, so this suite MEASURES
 * it, each additive lead note carrying `cell` (its place in the growing cell)
 * and `cellLength` on its 'note' event:
 *
 *   - the pure planner and the engine's note stream both match an
 *     independently written reference of the process, slot for slot, over
 *     dozens of bars, in both shapes, and a cell never changes mid-repetition;
 *   - every cell position is the figure's own note at that place;
 *   - deterministic: the same process under every rng seed, and a whole
 *     piece with it on and off differs ONLY in the arp's pitches — no other
 *     track's note, and not the arp's rhythm, moves;
 *   - it coexists with phase: the copy phases against the cell;
 *   - sparse: no key by default, no cell when unset, no stock genre ships it.
 *
 * Red on the pre-v0.0.228 engine: no planArpAdditive, no additive key, no cell.
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
// at full probability, nothing humanised — so every grid slot sounds and the
// cell position of every lead note can be predicted exactly. Octaves 2 on a
// triad: a six-note figure, so the cell grows 2, 3, 4, 5, 6.
const BPM = 120;
const SEC_PER_BEAT = 60 / BPM;
const BEATS_PER_BAR = 4;
const SLOTS_PER_BAR = 8; // '1/8' in 4/4
const FULL_LANE = Array.from({ length: 20 }, () => ({ on: true, prob: 1, vmin: 0.7, vmax: 0.7 }));
const STILL = { voice: 0, volume: 0, pitch: 0, timing: 0, pan: 0 };

function fixture(arpExtra = {}, extra = {}) {
  const off = { state: 'off' };
  return {
    bpm: BPM,
    timeSignature: '4/4',
    swing: 0,
    complexity: 0,
    repetition: 1,
    structure: 'drone',
    arp: { mode: 'manual', pattern: 'up', rate: '1/8', octaves: 2, gate: 0.6, ...arpExtra },
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
  const notes = [];
  engine.on('bar', (event) => { barStarts[event.bar] = event.time; });
  engine.on('note', (note) => { if (!note.live) notes.push(note); });
  await engine.start();
  await advance(BEATS_PER_BAR * SEC_PER_BEAT * (bars + 1));
  engine.stop();
  const arp = notes.filter((n) => n.track === 'arp');
  return {
    engine,
    barStarts,
    notes,
    lead: arp.filter((n) => n.phase !== true).sort((a, b) => a.time - b.time),
    copy: arp.filter((n) => n.phase === true),
  };
}

/**
 * The reference the engine is held to, written independently of it: Glass's
 * additive process as a list of cells, each played `every` times in full.
 * grow: 2..L then 2 again; grow-shrink: 2..L..2 then up again.
 */
function referenceCells(length, every, mode, count) {
  const first = Math.min(2, length);
  const up = [];
  for (let k = first; k <= length; k++) up.push(k);
  const cycle = mode === 'grow-shrink' && up.length > 1
    ? up.concat(up.slice(1, -1).reverse())
    : up;
  const out = [];
  for (let c = 0; out.length < count; c = (c + 1) % cycle.length) {
    for (let r = 0; r < every && out.length < count; r++) {
      for (let p = 0; p < cycle[c] && out.length < count; p++) out.push({ pos: p, len: cycle[c] });
    }
  }
  return out;
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---------------------------------------------------------------------------
// The param: sparse, clamped, cleared, carried by a partial.
// ---------------------------------------------------------------------------

test('sanitise: arp.additive is sparse — absent by default, set, clamped, cleared by 0 or null', () => {
  const fresh = engineModule.sanitiseParams({});
  assert.equal('additive' in fresh.arp, false, 'the default arp carries no additive key');
  assert.equal('additive' in engineModule.DEFAULT_PARAMS.arp, false);
  const set = engineModule.sanitiseParams({ arp: { additive: { every: 4, mode: 'grow-shrink' } } });
  assert.deepEqual(set.arp.additive, { every: 4, mode: 'grow-shrink' });
  assert.deepEqual(engineModule.sanitiseParams({ arp: { additive: 3 } }).arp.additive, { every: 3, mode: 'grow' },
    'a bare number is { every }');
  assert.equal(engineModule.sanitiseParams({ arp: { additive: { every: 99 } } }).arp.additive.every,
    engineModule.ARP_ADDITIVE_MAX);
  assert.equal(engineModule.sanitiseParams({ arp: { additive: { every: 2.6 } } }).arp.additive.every, 3,
    'repetitions are whole');
  for (const clear of [0, null, { every: 0 }, { every: null }]) {
    assert.equal('additive' in engineModule.sanitiseParams({ arp: { additive: clear } }, set).arp, false,
      `${JSON.stringify(clear)} clears it`);
  }
  assert.deepEqual(engineModule.sanitiseParams({ arp: { pattern: 'down' } }, set).arp.additive, set.arp.additive,
    'a partial that does not mention it keeps it');
  assert.deepEqual(engineModule.sanitiseParams({ arp: { additive: { every: 2 } } }, set).arp.additive,
    { every: 2, mode: 'grow-shrink' }, 'naming every keeps the mode');
  assert.deepEqual(engineModule.sanitiseParams({ arp: { additive: { mode: 'grow' } } }, set).arp.additive,
    { every: 4, mode: 'grow' }, 'naming the mode keeps every');
  assert.deepEqual(engineModule.sanitiseParams({ arp: { additive: { every: 'lots', mode: 'sideways' } } }, set).arp.additive,
    set.arp.additive, 'nonsense keeps what was there');
  assert.equal('additive' in engineModule.sanitiseParams({ arp: { additive: { mode: 'grow' } } }).arp, false,
    'a mode with no every and nothing stored is still off');
  // It comes after phase in the key order, so an arp without either
  // serialises exactly as it did before either existed.
  const keys = Object.keys(engineModule.sanitiseParams({ arp: { phase: 2, additive: 2 } }).arp);
  assert.deepEqual(keys.slice(-2), ['phase', 'additive']);
});

// ---------------------------------------------------------------------------
// The pure planner against the independent reference.
// ---------------------------------------------------------------------------

test('planArpAdditive: the exact growing cell sequence, bar after bar, in both shapes', () => {
  for (const mode of ['grow', 'grow-shrink']) {
    for (const [length, every, slots] of [[5, 2, 8], [6, 3, 7], [3, 1, 6], [4, 4, 12], [2, 2, 8], [1, 3, 4]]) {
      const bars = 40;
      const got = [];
      let state = null;
      for (let b = 0; b < bars; b++) {
        const planned = engineModule.planArpAdditive(state, slots, length, every, mode);
        for (let i = 0; i < slots; i++) got.push({ pos: planned.pos[i], len: planned.stage[i] });
        state = planned.next;
      }
      assert.deepEqual(got, referenceCells(length, every, mode, bars * slots),
        `${mode} L=${length} every=${every} slots=${slots}`);
    }
  }
  // The brief's own example: figure 1-2-3-4-5, one repetition each.
  const cells = [];
  let run = [];
  const planned = engineModule.planArpAdditive(null, 2 + 3 + 4 + 5 + 2, 5, 1, 'grow');
  for (let i = 0; i < planned.pos.length; i++) {
    if (planned.pos[i] === 0 && run.length) { cells.push(run.join('-')); run = []; }
    run.push(planned.pos[i] + 1);
  }
  cells.push(run.join('-'));
  assert.deepEqual(cells, ['1-2', '1-2-3', '1-2-3-4', '1-2-3-4-5', '1-2']);
});

test('planArpAdditive: a stage only changes at a cell boundary, after exactly `every` repetitions', () => {
  const planned = engineModule.planArpAdditive(null, 400, 6, 3, 'grow-shrink');
  for (let i = 1; i < 400; i++) {
    if (planned.stage[i] !== planned.stage[i - 1]) {
      assert.equal(planned.pos[i], 0, `slot ${i}: the cell changed mid-repetition`);
      assert.equal(planned.pos[i - 1], planned.stage[i - 1] - 1, `slot ${i}: the last cell was cut short`);
      let reps = 0;
      for (let j = i - 1; j >= 0 && planned.stage[j] === planned.stage[i - 1]; j--) reps += planned.pos[j] === 0 ? 1 : 0;
      assert.equal(reps, 3, `slot ${i}: ${reps} repetitions of the ${planned.stage[i - 1]}-cell, not 3`);
    }
  }
});

// ---------------------------------------------------------------------------
// The process in the engine's own note stream.
// ---------------------------------------------------------------------------

test('unset: no lead note carries a cell, and the arp walks its whole figure', () => hiddenTab(async () => {
  const { barStarts, lead } = await play(fixture(), 6);
  assert.ok(lead.length >= 6 * SLOTS_PER_BAR - 8, `the lead played only ${lead.length} notes`);
  assert.ok(lead.every((n) => !('cell' in n)), 'a note with no additive process carries no cell');
  const firstBar = lead.filter((n) => n.time < barStarts[1] - 1e-6);
  assert.equal(new Set(firstBar.map((n) => n.midi)).size, 6, 'the plain arp plays all six figure notes in a bar');
}));

const BARS = 24;

test('grow: the lead plays the exact growing cell over many bars, every note the figure’s note at that place', () => hiddenTab(async () => {
  const { barStarts, lead } = await play(fixture({ additive: { every: 2 } }), BARS);
  const counted = lead.filter((n) => n.time < barStarts[BARS - 1] - 1e-6);
  assert.ok(counted.length >= (BARS - 1) * SLOTS_PER_BAR,
    `only ${counted.length} lead notes in ${BARS - 1} bars`);
  const expected = referenceCells(6, 2, 'grow', counted.length);
  assert.deepEqual(counted.map((n) => ({ pos: n.cell, len: n.cellLength })), expected,
    'the cell sequence differs from Glass’s additive process');
  // The cell IS the figure's opening: in each bar, cell position p always
  // sounds the same pitch, rising with p (pattern up) — and the full figure
  // is six different pitches.
  for (let b = 0; b < BARS - 1; b++) {
    const inBar = counted.filter((n) => n.time >= barStarts[b] - 1e-6 && n.time < barStarts[b + 1] - 1e-6);
    const at = new Map();
    for (const n of inBar) {
      if (at.has(n.cell)) assert.equal(n.midi, at.get(n.cell), `bar ${b}: cell ${n.cell} changed pitch`);
      at.set(n.cell, n.midi);
    }
    const order = [...at.keys()].sort((x, y) => x - y);
    for (let i = 1; i < order.length; i++) {
      assert.ok(at.get(order[i]) > at.get(order[i - 1]), `bar ${b}: the cell does not climb the figure`);
    }
  }
  // Read out loud: the cell each bar opens on.
  const opens = [];
  for (let b = 0; b < BARS - 1; b++) {
    const first = counted.find((n) => n.time >= barStarts[b] - 1e-6);
    opens.push(first.cellLength);
  }
  console.log(`     cell length at each downbeat: ${opens.join(' ')}`);
}));

test('grow-shrink: the cell climbs to the full figure and comes back down one note at a time', () => hiddenTab(async () => {
  const { barStarts, lead } = await play(fixture({ additive: { every: 1, mode: 'grow-shrink' } }), 16);
  const counted = lead.filter((n) => n.time < barStarts[15] - 1e-6);
  assert.deepEqual(counted.map((n) => ({ pos: n.cell, len: n.cellLength })),
    referenceCells(6, 1, 'grow-shrink', counted.length));
  const lengths = counted.map((n) => n.cellLength).filter((len, i, all) => i === 0 || len !== all[i - 1]);
  assert.deepEqual(lengths.slice(0, 11), [2, 3, 4, 5, 6, 5, 4, 3, 2, 3, 4]);
}));

test('deterministic: the same cell sequence under every rng seed, and no other draw moves', () => hiddenTab(async () => {
  const runs = [];
  for (const seed of [1, 7, 99, 12345]) {
    const { lead } = await play(fixture({ additive: { every: 2 } }), 10, seed);
    // The first nine bars, so a scheduler-lookahead note at the end of one
    // run and not another cannot count as a difference.
    assert.ok(lead.length >= 9 * SLOTS_PER_BAR, `seed ${seed}: only ${lead.length} lead notes`);
    lead.length = 9 * SLOTS_PER_BAR;
    // Cell and cell length only: the CHORDS are drawn, so the pitches a
    // seed lands on differ — the process laid over them must not.
    runs.push(lead.map((n) => `${n.cell}/${n.cellLength}`).join(' '));
  }
  for (let i = 1; i < runs.length; i++) assert.equal(runs[i], runs[0], `seed run ${i} heard a different process`);
  // A full piece — every track playing, the arp on AUTO with its random mask
  // — with and without the process, from the same seed: every other track's
  // note stream to the byte, and the arp's rhythm, velocity and pan too. Only
  // the arp's pitches may move, because only they are what the process is.
  const dir = new URL('../src/data/genres/', import.meta.url);
  const minimalism = JSON.parse(readFileSync(new URL('minimalism.json', dir), 'utf8'));
  const base = compileGenre(minimalism, { rng: seededRng(5) });
  delete base.arp.phase;
  // A steady piece at the fixture tempo, so sixteen bars are sixteen bars
  // and the arp is not waiting on a build's entry.
  base.structure = 'drone';
  base.bpm = BPM;
  for (const t of ['pad', 'bass', 'melody', 'percussion']) base.tracks[t] = { ...base.tracks[t], state: 'on' };
  const without = await play(base, 16, 21);
  const withAdd = await play({ ...base, arp: { ...base.arp, additive: { every: 2, mode: 'grow-shrink' } } }, 16, 21);
  // Up to bar 14's downbeat in both runs: past it, how far the scheduler's
  // lookahead reached before stop() is wall-clock, not the engine.
  const cut = Math.min(without.barStarts[14], withAdd.barStarts[14]);
  assert.equal(without.barStarts[14], withAdd.barStarts[14], 'the bar clock moved');
  const strip = (notes) => notes.filter((n) => n.track !== 'arp' && n.time < cut).map((n) => JSON.stringify(n));
  assert.ok(strip(without.notes).length > 20, 'the piece played too few other notes to prove anything');
  assert.deepEqual(strip(withAdd.notes), strip(without.notes), 'turning additive on moved another track');
  const arpShape = (notes) => notes.filter((n) => n.track === 'arp' && n.time < cut)
    .map((n) => `${n.time.toFixed(9)}/${n.velocity.toFixed(9)}/${n.duration.toFixed(9)}`);
  assert.ok(arpShape(without.notes).length > 10,
    `the arp played ${arpShape(without.notes).length} notes, too few to prove anything`);
  assert.deepEqual(arpShape(withAdd.notes), arpShape(without.notes), 'the arp’s rhythm moved');
  assert.ok(withAdd.lead.every((n) => Number.isInteger(n.cell)), 'every auto-arp lead note has a cell');
}));

test('with phase: the copy phases against the CELL, never reaching outside it', () => hiddenTab(async () => {
  const { barStarts, lead, copy } = await play(fixture({ additive: { every: 2 }, phase: 2 }), 16);
  assert.ok(copy.length > lead.length * 0.8, `phase is on and only ${copy.length} copies played`);
  // Every copy sounds a note of the cell its lead note belongs to: the
  // pitches that lead's cell positions sound in that bar (the chord changes
  // at barlines, so the figure is read bar by bar).
  const barOf = (t) => barStarts.filter((s) => s !== undefined && s <= t + 1e-9).length - 1;
  let checked = 0;
  for (const c of copy) {
    const owner = lead.filter((n) => n.time <= c.time + 1e-9).pop();
    const bar = barOf(owner.time);
    if (barOf(c.time) !== bar || bar >= 15) continue;
    const allowed = [...new Set(lead.filter((n) => barOf(n.time) === bar && n.cellLength >= owner.cellLength
      && n.cell < owner.cellLength).map((n) => n.midi))];
    if (allowed.length < owner.cellLength) continue;
    checked += 1;
    assert.ok(allowed.includes(c.midi),
      `a copy at ${c.time.toFixed(3)} played ${c.midi}, outside the ${owner.cellLength}-note cell ${allowed}`);
  }
  assert.ok(checked > copy.length / 2, `only ${checked} of ${copy.length} copies could be checked`);
}));

test('getResolved reports the cell; setParams null stops the process at the next bar', () => hiddenTab(async () => {
  const engine = createEngine(fixture({ additive: { every: 2 } }), { rng: seededRng(3) });
  let cells = 0;
  engine.on('note', (note) => { if (Number.isInteger(note.cell)) cells += 1; });
  await engine.start();
  await advance(BEATS_PER_BAR * SEC_PER_BEAT * 4);
  const live = engine.getResolved().arpAdditive;
  assert.ok(live && live.every === 2 && live.mode === 'grow', `arpAdditive readout: ${JSON.stringify(live)}`);
  assert.ok(Number.isInteger(live.cell) && live.cell >= 2 && live.cell <= 6 && live.figure === 6
    && live.repetition >= 1 && live.repetition <= 2, `arpAdditive readout incomplete: ${JSON.stringify(live)}`);
  engine.setParams({ arp: { additive: null } });
  assert.equal(engine.getResolved().arpAdditive, null);
  await advance(BEATS_PER_BAR * SEC_PER_BEAT * 2);
  const before = cells;
  await advance(BEATS_PER_BAR * SEC_PER_BEAT * 3);
  engine.stop();
  assert.ok(before > 0);
  assert.equal(cells, before, 'cell notes kept coming after additive was cleared');
}));

test('genres: no stock genre compiles an additive process; process.arpAdditive does, with no draw', () => {
  const dir = new URL('../src/data/genres/', import.meta.url);
  const genres = readdirSync(dir).filter((n) => n.endsWith('.json')).sort()
    .map((n) => JSON.parse(readFileSync(new URL(n, dir), 'utf8')));
  for (const genre of genres) {
    const compiled = compileGenre(genre, { rng: seededRng(11) });
    assert.equal('additive' in compiled.arp, false, `${genre.slug} must not grow an additive key`);
  }
  const minimalism = genres.find((g) => g.slug === 'minimalism');
  const withAdd = JSON.parse(JSON.stringify(minimalism));
  withAdd.essence.process = { arpAdditive: { every: 4, mode: 'grow-shrink' } };
  const without = JSON.parse(JSON.stringify(minimalism));
  delete without.essence.process;
  const a = compileGenre(withAdd, { rng: seededRng(5) });
  const b = compileGenre(without, { rng: seededRng(5) });
  assert.deepEqual(a.arp.additive, { every: 4, mode: 'grow-shrink' });
  delete a.arp.additive;
  assert.deepEqual(a, b, 'the process field must not move any other compiled value');
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
    liveContexts.length = 0;
  }
}
console.log(`${tests.length - failures}/${tests.length} passed`);
if (failures) process.exit(1);
