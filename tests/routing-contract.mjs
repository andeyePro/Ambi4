/**
 * Contract test for the routing and sampling wire format — run with:
 *   node tests/routing-contract.mjs
 *
 * A 2026-08 review found the routing and sampling sanitisers, which decide
 * exactly what a share link is allowed to carry, asserted almost nowhere:
 * v0.0.168's own test has "one slot" in its TITLE with no assertion of it in
 * its BODY, and the 64-edge cap, the refusal paths and the sampling honesty
 * ruling had no coverage at all. This suite drives `sanitiseParams` directly
 * for the storage-level laws, and a real engine against the same minimal
 * AudioContext mock `tests/engine-smoke.mjs` uses for the laws that are only
 * true in playback (hold, freeze, edge removal).
 *
 * Two traps this suite deliberately avoids, both of which have produced false
 * results in this repo before: every playback assertion reads the ENGINE's
 * own `getResolved()`/`getParams()`, never a UI readout that doesn't exist
 * here anyway; and every engine is built with a seeded rng so a run is
 * reproducible rather than drawing whatever genre/voice a fresh boot would.
 */

import assert from 'node:assert/strict';

// --------------------------------------------------------------------------
// Minimal AudioContext mock — the same shape as tests/engine-smoke.mjs's,
// trimmed to what a bare `level` walk/route needs: gain and nothing more of
// the graph is ever inspected here, only `getResolved()`/`getParams()`.
// --------------------------------------------------------------------------

function makeParam(value) {
  return {
    value,
    setValueAtTime(v) { this.value = v; return this; },
    linearRampToValueAtTime(v) { this.value = v; return this; },
    exponentialRampToValueAtTime(v) { this.value = v; return this; },
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
    disconnect(target) {
      this.disconnects.push(target ?? null);
      if (target) this.connections = this.connections.filter((n) => n !== target);
      else this.connections = [];
    },
    start(t = 0) { this.startedAt = t; },
    stop() {},
  };
}

class MockAudioContext {
  constructor() {
    this.currentTime = 0;
    this.sampleRate = 48000;
    this.state = 'running';
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
    return { numberOfChannels: channels, length, sampleRate, getChannelData: (i) => data[i] };
  }

  resume() { this.state = 'running'; return Promise.resolve(); }
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
}

const liveContexts = [];
globalThis.AudioContext = class extends MockAudioContext {
  constructor() {
    super();
    liveContexts.push(this);
  }
};

const engineModule = await import('../src/scripts/ambient-engine.js');
const { sanitiseParams, TRACK_ORDER } = engineModule;

const builtEngines = [];
function createEngine(...args) {
  const made = engineModule.createEngine(...args);
  builtEngines.push(made);
  return made;
}

/** Every track forced to one state, with the same settings applied to each —
 * copied from engine-smoke.mjs's helper of the same name. */
function tracksAll(state, common = {}) {
  return Object.fromEntries(TRACK_ORDER.map((name) => [name, { state, ...common }]));
}

const seededRng = (seed) => () => ((seed = (seed * 48271) % 2147483647) / 2147483647);

async function advance(seconds, { step = 0.12, sleep = 16 } = {}) {
  const steps = Math.ceil(seconds / step);
  for (let i = 0; i < steps; i++) {
    for (const ctx of liveContexts) ctx.currentTime += step;
    await new Promise((resolve) => setTimeout(resolve, sleep));
  }
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// --------------------------------------------------------------------------
// 1. D4 — one slot per destination
// --------------------------------------------------------------------------

test('D4: several edges naming the same destination collapse to exactly one, and it is the LAST one', () => {
  // Forward order: macro then lfo — lfo must survive.
  const forward = sanitiseParams({
    routing: [
      { source: 'macro.1', destination: 'pad:level' },
      { source: 'lfo.1', destination: 'pad:level' },
    ],
  });
  assert.equal(forward.routing.length, 1,
    `D4: two edges to the same destination must collapse to 1, got ${forward.routing.length}`);
  assert.equal(forward.routing[0].source, 'lfo.1',
    `D4: the LAST edge naming a destination must win — got source '${forward.routing[0].source}', wanted 'lfo.1'`);

  // Reverse order proves it is genuinely "last written", not e.g. alphabetic
  // or a hard-coded source preference — swapping the order flips the winner.
  const reverse = sanitiseParams({
    routing: [
      { source: 'lfo.1', destination: 'pad:level' },
      { source: 'macro.1', destination: 'pad:level' },
    ],
  });
  assert.equal(reverse.routing.length, 1,
    `D4: two edges to the same destination must collapse to 1, got ${reverse.routing.length}`);
  assert.equal(reverse.routing[0].source, 'macro.1',
    `D4: reversing the edge order must flip the winner — got source '${reverse.routing[0].source}', wanted 'macro.1'`);

  // Several destinations, some duplicated, some not: each destination keeps
  // its own last-writer independently of the others.
  const mixed = sanitiseParams({
    routing: [
      { source: 'macro.1', destination: 'pad:level' },
      { source: 'lfo.1', destination: 'bass:level' },
      { source: 'lfo.1', destination: 'pad:level' },
      { source: 'macro.1', destination: 'bass:level' },
    ],
  });
  const byDest = Object.fromEntries(mixed.routing.map((e) => [e.destination, e.source]));
  assert.deepEqual(byDest, { 'pad:level': 'lfo.1', 'bass:level': 'macro.1' },
    `D4: each destination must independently keep its OWN last writer — got ${JSON.stringify(byDest)}`);
});

test('D4: the ENGINE plays the law of the LAST edge, not the first — closes the v0.0.168 title/body gap', async () => {
  // v0.0.168's own test named "one slot" but never proved a second edge to
  // the same destination actually loses. Here macro.1 is listed FIRST and
  // lfo.1 SECOND for the same destination: if the sanitiser (or the engine
  // reading it) ever regressed to "first wins", this is periodic instead of
  // pinned at the macro value below and the test catches it either way.
  const LEVEL = { min: 0.2, max: 0.8 };
  const engine = createEngine({
    bpm: 240, speed: 2, complexity: 0.5, structure: 'drone', timeSignature: '4/4',
    tracks: { ...tracksAll('off'), pad: { state: 'on', level: { ...LEVEL }, randomness: 0.5 } },
    routing: [
      { source: 'macro.1', destination: 'pad:level' },
      { source: 'lfo.1', destination: 'pad:level' },
    ],
    lfo1: { bars: 4 }, macro1: 0.75,
  }, { rng: seededRng(9001) });

  assert.equal(engine.getParams().routing.length, 1, 'the stored edge list must hold exactly one entry');
  assert.equal(engine.getParams().routing[0].source, 'lfo.1', 'the stored survivor must be the LAST edge (lfo.1)');

  const perBar = [];
  engine.on('bar', () => perBar.push(engine.getResolved().tracks.pad.level));
  await engine.start();
  await advance(20);
  engine.stop();

  assert.ok(perBar.length >= 10, `only ${perBar.length} bars played`);
  const macroValue = LEVEL.min + (LEVEL.max - LEVEL.min) * 0.75;
  const steady = perBar.slice(1);
  assert.ok(steady.some((v) => Math.abs(v - macroValue) > 1e-6),
    'the level sat at the MACRO value the whole time — the first edge (macro.1) is winning, not the last (lfo.1)');
  assert.ok(new Set(steady.map((v) => v.toFixed(6))).size > 1,
    'the level never moved at all — an lfo.1 route must be periodic, not a single held value');
});

// --------------------------------------------------------------------------
// 2. The 64-edge cap
// --------------------------------------------------------------------------

test('the 64-edge cap truncates the raw list silently — the survivors are exactly the first 64', () => {
  const edges = Array.from({ length: 100 }, (_, i) => ({
    source: i % 2 === 0 ? 'macro.1' : 'lfo.1',
    destination: `t${i}:level`,
  }));
  const out = sanitiseParams({ routing: edges });
  assert.equal(out.routing.length, 64,
    `the routing cap must store exactly 64 edges out of 100 offered, got ${out.routing.length}`);
  const survivorDests = out.routing.map((e) => e.destination).sort((a, b) => {
    const ai = Number(a.match(/^t(\d+):/)[1]);
    const bi = Number(b.match(/^t(\d+):/)[1]);
    return ai - bi;
  });
  const wantDests = Array.from({ length: 64 }, (_, i) => `t${i}:level`);
  assert.deepEqual(survivorDests, wantDests,
    `the surviving edges must be the FIRST 64 offered (t0..t63) — got ${JSON.stringify(survivorDests)}`);
});

// --------------------------------------------------------------------------
// 3. Refusals: dropped, and dropped alone
// --------------------------------------------------------------------------

test('routing refusals: unknown source namespace, malformed/non-string/missing destination — dropped without harming neighbours', () => {
  const out = sanitiseParams({
    routing: [
      { source: 'env.1', destination: 'pad:volume' },       // unknown source namespace (envelopes aren't wired yet)
      { source: 'macro.1', destination: 123 },               // non-string destination
      { source: 'macro.1', destination: ['pad', 'level'] },  // non-string destination (array)
      { source: 'macro.1', destination: 'nocolon' },         // malformed: fails the walk-key grammar
      { destination: 'pad:pan' },                            // missing source field entirely
      { source: 'macro.1' },                                 // missing destination field entirely
      null,                                                  // not an object at all
      'oops',                                                // not an object at all
      42,                                                    // not an object at all
      { source: 'macro.1', destination: 'pad:level' },       // the one good edge, sharing the list with all of the above
    ],
  });
  assert.equal(out.routing.length, 1,
    `every malformed edge must be dropped, leaving only the good one; got ${JSON.stringify(out.routing)}`);
  assert.deepEqual(out.routing[0], { source: 'macro.1', destination: 'pad:level' },
    'the one good edge must survive unchanged despite nine malformed neighbours in the same array');
});

test('a non-array `routing` value refuses the whole set, clearing what was stored — not a crash, not a partial keep', () => {
  const withRouting = sanitiseParams({ routing: [{ source: 'macro.1', destination: 'pad:level' }] });
  assert.equal(withRouting.routing.length, 1, 'setup: the base must actually be carrying a stored edge');

  const cleared = sanitiseParams({ routing: 'not-an-array' }, withRouting);
  assert.deepEqual(cleared.routing, [],
    `a non-array routing value must refuse to the empty set (not throw, not keep the old edges); got ${JSON.stringify(cleared.routing)}`);
});

// --------------------------------------------------------------------------
// 4. The sampling sanitiser's stated law
// --------------------------------------------------------------------------

test('sampling: chord and section are stored, bar is the default and is never itself stored, an ungrammatical key is dropped', () => {
  const stored = sanitiseParams({ sampling: { 'pad:level': 'chord', 'pad:pan': 'section' } });
  assert.deepEqual(stored.sampling, { 'pad:level': 'chord', 'pad:pan': 'section' },
    'chord and section must be stored verbatim, keyed exactly like the walks');

  const explicitBar = sanitiseParams({ sampling: { 'pad:level': 'bar' } });
  assert.equal(explicitBar.sampling['pad:level'], undefined,
    'an explicit "bar" must never be STORED as a token — bar is the unstored default, not a literal on the wire');

  const ungrammatical = sanitiseParams({ sampling: { 'bad key': 'chord' } });
  assert.equal(ungrammatical.sampling['bad key'], undefined,
    'a sampling key that fails the walk-key grammar (a space, here) must be dropped');
});

test('sampling: "note" is REFUSED at the sanitiser rather than accepted-and-played-as-bar — the honesty ruling', () => {
  const out = sanitiseParams({ sampling: { 'pad:level': 'note' } });
  assert.equal(out.sampling['pad:level'], undefined,
    '"note" must not be stored at all: the per-note resolution path does not exist yet, so no stored token may claim it does');
});

test('sampling: a refused "note" key actually PLAYS as ordinary bar cadence, proving the refusal has no silent side channel', async () => {
  // If some other code path still honoured 'note' as a synonym for chord or
  // section (holding the value across the whole chord/section rather than
  // stepping it every bar), that would be exactly the lie the sanitiser is
  // supposed to prevent. Prove the played behaviour matches ordinary
  // (unsampled) bar-cadenced walking: a value change on a bar whose index is
  // NOT congruent to 1 mod the 4-bar chord length the chord/section gate
  // would have required.
  const LEVEL = { min: 0.2, max: 0.8 };
  const engine = createEngine({
    bpm: 240, speed: 2, complexity: 0.5, structure: 'abab', timeSignature: '4/4',
    harmony: { rhythm: 4 },
    tracks: { ...tracksAll('off'), pad: { state: 'on', level: { ...LEVEL }, randomness: 0.5 } },
    sampling: { 'pad:level': 'note' },
  }, { rng: seededRng(6712) });
  const perBar = [];
  engine.on('bar', () => perBar.push(engine.getResolved().tracks.pad.level));
  await engine.start();
  await advance(26);
  engine.stop();

  assert.ok(perBar.length >= 17, `only ${perBar.length} bars played`);
  let offGridChange = false;
  for (let i = 1; i < perBar.length; i++) {
    if (perBar[i].toFixed(6) !== perBar[i - 1].toFixed(6) && i % 4 !== 1) offGridChange = true;
  }
  assert.ok(offGridChange,
    'a refused "note" sampling must fall all the way back to plain bar cadence — every observed change sat on the chord grid, which is what a smuggled chord/section hold would look like');
});

// --------------------------------------------------------------------------
// 5. A routed dial under hold and freeze
// --------------------------------------------------------------------------

test('an established route PINS under hold, exactly as an ordinary walk pins — later source edits have no effect', async () => {
  const LEVEL = { min: 0.2, max: 0.8 };
  const want = LEVEL.min + (LEVEL.max - LEVEL.min) * 0.75;
  const engine = createEngine({
    bpm: 240, speed: 2, complexity: 0.5, structure: 'drone', timeSignature: '4/4',
    tracks: { ...tracksAll('off'), pad: { state: 'on', level: { ...LEVEL }, randomness: 0.5, hold: false } },
    routing: [{ source: 'macro.1', destination: 'pad:level' }], macro1: 0.75,
  }, { rng: seededRng(4201) });

  const perBar = [];
  let held = false;
  let macroEdited = false;
  engine.on('bar', () => {
    perBar.push(engine.getResolved().tracks.pad.level);
    if (!held && perBar.length === 4) {
      engine.setParams({ tracks: { pad: { hold: true } } });
      held = true;
    }
    if (held && !macroEdited && perBar.length === 8) {
      engine.setParams({ macro1: 0.1 });
      macroEdited = true;
    }
  });
  await engine.start();
  await advance(20);
  engine.stop();

  assert.ok(perBar.length >= 12, `only ${perBar.length} bars played`);
  // Index 0 is the one-event lag documented in the v0.0.167/168 tests: the
  // 'bar' event fires BEFORE that bar's own routing step, so the very first
  // event still reads the pre-routing walk. From index 1 the route is live.
  for (const [i, v] of perBar.slice(1, 4).entries()) {
    assert.ok(Math.abs(v - want) < 1e-9,
      `bar-event ${i + 1}: before hold engaged the level must equal the macro's own ${want}, got ${v}`);
  }
  // From the bar hold takes effect onward, the level must sit at whatever it
  // was pinned at (the macro's value at the moment hold engaged) — including
  // AFTER macro1 was edited to 0.1 (want-at-0.1 would be 0.26), because hold
  // pins the routed position exactly as it pins a plain walk.
  for (const [i, v] of perBar.slice(4).entries()) {
    assert.ok(Math.abs(v - want) < 1e-9,
      `bar-event ${i + 4}: a held routed dial must stay pinned at its established value ${want} — got ${v} (macro1 was edited mid-hold to 0.1, which would read ${(LEVEL.min + (LEVEL.max - LEVEL.min) * 0.1).toFixed(3)} if the pin failed)`);
  }
});

test('the asymmetry the review flagged: an edge added WHILE its track is held or frozen never gets a stored position at all, and the dial falls through to its own internal walk', async () => {
  // Unlike an established route (previous test), a route that has NEVER had
  // an unheld bar to be sampled on has no entry in `routedPositions` — the
  // per-bar loop that would create one (`advanceRouting`) is gated by the
  // exact same `held`/`isFrozenTrack` check that hold and freeze use to pin
  // an ordinary walk. So the dial does not "pin at the source's value"; it
  // falls all the way through to the plain internal walk, which is an
  // unrelated random draw — not a frozen copy of macro1. This is the honest
  // behaviour, not the behaviour one might expect from "hold pins a route".
  const LEVEL = { min: 0.2, max: 0.8 };
  const macroValue = LEVEL.min + (LEVEL.max - LEVEL.min) * 0.75;

  async function run(trackExtra, seed) {
    const engine = createEngine({
      bpm: 240, speed: 2, complexity: 0.5, structure: 'drone', timeSignature: '4/4',
      tracks: { ...tracksAll('off'), pad: { state: 'on', level: { ...LEVEL }, randomness: 0.5, ...trackExtra } },
      routing: [{ source: 'macro.1', destination: 'pad:level' }], macro1: 0.75,
    }, { rng: seededRng(seed) });
    const perBar = [];
    engine.on('bar', () => perBar.push(engine.getResolved().tracks.pad.level));
    await engine.start();
    await advance(14);
    engine.stop();
    return perBar;
  }

  const heldFromBirth = await run({ hold: true }, 5301);
  assert.ok(heldFromBirth.length >= 8, `only ${heldFromBirth.length} bars played (held case)`);
  assert.ok(heldFromBirth.every((v) => Math.abs(v - macroValue) > 1e-6),
    `a route added while already held must NEVER read the macro's value (${macroValue}) — got ${JSON.stringify(heldFromBirth.slice(0, 3))}`);
  assert.equal(new Set(heldFromBirth.map((v) => v.toFixed(9))).size, 1,
    'a held track still pins SOMETHING steady (its own internal walk draw) — it must not be silently drifting either');

  // randomness pinned at 0 is a FREEZE (randomnessIsHold), the other gate
  // advanceRouting shares with a plain walk's hold check.
  const frozenFromBirth = await run({ randomness: 0 }, 5302);
  assert.ok(frozenFromBirth.length >= 8, `only ${frozenFromBirth.length} bars played (frozen case)`);
  assert.ok(frozenFromBirth.every((v) => Math.abs(v - macroValue) > 1e-6),
    `a route added to an already-frozen track must NEVER read the macro's value (${macroValue}) — got ${JSON.stringify(frozenFromBirth.slice(0, 3))}`);
  assert.equal(new Set(frozenFromBirth.map((v) => v.toFixed(9))).size, 1,
    'a frozen track still pins SOMETHING steady (its own internal walk draw) — it must not be silently drifting either');
});

// --------------------------------------------------------------------------
// 6. Edge removal
// --------------------------------------------------------------------------

test('clearing params.routing returns the dial to its own walk, and it stops following its old source entirely', async () => {
  const LEVEL = { min: 0.2, max: 0.8 };
  const routedValue = LEVEL.min + (LEVEL.max - LEVEL.min) * 0.75;
  const zeroMacroValue = LEVEL.min; // what it WOULD read if still (mis)routed after macro1 -> 0
  const engine = createEngine({
    bpm: 240, speed: 2, complexity: 0.5, structure: 'drone', timeSignature: '4/4',
    tracks: { ...tracksAll('off'), pad: { state: 'on', level: { ...LEVEL }, randomness: 0.5 } },
    routing: [{ source: 'macro.1', destination: 'pad:level' }], macro1: 0.75,
  }, { rng: seededRng(7701) });

  const perBar = [];
  let cleared = false;
  engine.on('bar', () => {
    perBar.push(engine.getResolved().tracks.pad.level);
    if (!cleared && perBar.length === 4) {
      // Clear the edge AND move the source in the same edit: if removal were
      // a no-op the level would track macro1's new value (0.2) instead of
      // falling back to its own walk.
      engine.setParams({ routing: [], macro1: 0 });
      cleared = true;
    }
  });
  await engine.start();
  await advance(18);
  engine.stop();

  assert.deepEqual(engine.getParams().routing, [], 'the stored routing list must be empty after clearing it');
  // Index 0 is the same one-event lag noted above — the route is not live
  // until index 1.
  for (const [i, v] of perBar.slice(1, 4).entries()) {
    assert.ok(Math.abs(v - routedValue) < 1e-9,
      `bar-event ${i + 1}: before removal the level must equal the macro's own ${routedValue}, got ${v}`);
  }
  for (const [i, v] of perBar.slice(4).entries()) {
    assert.ok(Math.abs(v - routedValue) > 1e-6,
      `bar-event ${i + 4}: after removing the edge the dial must stop tracking its old source (${routedValue}) — got ${v}`);
    assert.ok(Math.abs(v - zeroMacroValue) > 1e-6,
      `bar-event ${i + 4}: after removal the dial must not be silently STILL routed to macro1's new value (${zeroMacroValue}) either — it must be its own independent walk`);
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
  } finally {
    for (const made of builtEngines) if (made.running) made.stop();
    builtEngines.length = 0;
    liveContexts.length = 0;
  }
}
console.log(`\n${tests.length - failures}/${tests.length} passed`);
process.exit(failures ? 1 : 0);
