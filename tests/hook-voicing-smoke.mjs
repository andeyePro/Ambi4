/**
 * Reconstructible Ambi4, "Chord loop as voiced" — the hook's voicing as a
 * rule in the one Now / Chance / Pool shape (owner ruling 2026-09-25).
 *
 *   npm run build && node tests/hook-voicing-smoke.mjs
 *
 * NOW is `harmony.voicing` (per hook slot, inversion 0–2 and extension
 * -1/0/+1), CHANCE is `harmony.hookRule.chance` with a When of pass, section
 * or piece (0 holds the loop for good — no mutateHook, no recall; null
 * follows Repetition, the pre-rule hookMutationChance), POOL is
 * `harmony.hookRule.pool`, the alternative voicings a move picks from, by
 * weight or in turn (empty is the engine's own bankHook recall / mutation).
 * Gated at the engine, from the published 'chord' events — what the pad is
 * voicing — never only from the param the test wrote.
 */
import assert from 'node:assert/strict';

// Minimal AudioContext mock — the same thin shape voice-rule-smoke.mjs uses:
// enough surface for the engine's graph, no node-graph assertions here since
// this suite only reads 'bar' and 'note' events.
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
const { TIME_SIGNATURES, sanitiseParams } = engineModule;
const { recipeToText, recipeFromText } = await import('../src/scripts/recipe.js');

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

/**
 * A four-chord seeded loop, one chord per bar, so a loop pass is exactly four
 * bars and each bar's 'chord' event is one slot. Repetition 0 makes the
 * pre-rule law mutate on most passes — the movement the rule must be able to
 * stop. The chord event's midis are the pad's own voicing, so an inversion is
 * a different lowest note: the voicing is measured from what is published as
 * sounding, not from the param the test wrote.
 */
const LOOP = ['I', 'IV', 'V', 'vi'];
function loopParams(harmony = {}) {
  return {
    mode: 'ionian',
    root: 'C',
    structure: 'drone',
    complexity: 0.5,
    repetition: 0,
    harmony: { rhythm: 1, seed: LOOP, ...harmony },
  };
}

/** Play `bars` bars and return every bar's chord as a midi-list key, plus the engine. */
async function playChords(harmony, { seed = 7, bars = 24, during = null } = {}) {
  const params = loopParams(harmony);
  const engine = createEngine(params, { rng: seededRng(seed) });
  const chords = [];
  engine.on('chord', (chord) => { chords.push({ bar: chord.bar, key: chord.midis.join(',') }); });
  await engine.start();
  if (during) await during(engine);
  else await advance(barSeconds(engine.getParams()) * (bars + 1));
  engine.stop();
  return { chords: chords.slice(0, bars), engine };
}

/** Does the chord at bar b always equal the one a loop length later? */
function periodic(chords, period = LOOP.length) {
  for (let i = period; i < chords.length; i++) {
    if (chords[i].key !== chords[i - period].key) return false;
  }
  return true;
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---------------------------------------------------------------------------
// Sanitiser: sparse, clamped, null clears, absent and junk keep the stored.
// ---------------------------------------------------------------------------

test('sanitise: voicing and hookRule are sparse, clamped, cleared by null, kept when absent or junk', () => {
  const fresh = sanitiseParams({});
  assert.equal('voicing' in fresh.harmony, false, 'a fresh harmony carries no voicing key');
  assert.equal('hookRule' in fresh.harmony, false, 'a fresh harmony carries no hookRule key');

  const set = sanitiseParams({ harmony: {
    voicing: [{ inversion: 5, extension: -3 }, { inversion: 1.4, extension: 0.6 }],
    hookRule: { chance: 2, when: 'bogus', order: 'turn', pool: [{ voicing: [{ inversion: 2, extension: 1 }], weight: 3 }, 'junk'] },
  } });
  assert.deepEqual(set.harmony.voicing, [{ inversion: 2, extension: -1 }, { inversion: 1, extension: 1 }]);
  assert.deepEqual(set.harmony.hookRule, {
    chance: 1, when: 'pass', order: 'turn',
    pool: [{ voicing: [{ inversion: 2, extension: 1 }], weight: 3 }],
  });

  const kept = sanitiseParams({ harmony: { rhythm: 2 } }, set);
  assert.deepEqual(kept.harmony.voicing, set.harmony.voicing, 'absent keeps the stored voicing');
  assert.deepEqual(kept.harmony.hookRule, set.harmony.hookRule, 'absent keeps the stored rule');

  const junk = sanitiseParams({ harmony: { voicing: 'loud', hookRule: 'often' } }, set);
  assert.deepEqual(junk.harmony.voicing, set.harmony.voicing, 'an unusable voicing keeps the stored one');
  assert.deepEqual(junk.harmony.hookRule, set.harmony.hookRule, 'an unusable rule keeps the stored one');

  const tooLong = sanitiseParams({ harmony: { voicing: new Array(9).fill({ inversion: 1, extension: 0 }) } });
  assert.equal('voicing' in tooLong.harmony, false, 'more slots than a loop can have is refused, not truncated');

  const cleared = sanitiseParams({ harmony: { voicing: null, hookRule: null } }, set);
  assert.equal('voicing' in cleared.harmony, false, 'null clears the voicing');
  assert.equal('hookRule' in cleared.harmony, false, 'null clears the rule');

  const nullChance = sanitiseParams({ harmony: { hookRule: { chance: null } } });
  assert.equal(nullChance.harmony.hookRule.chance, null, 'a null chance is kept: it follows Repetition');
});

test('getParams carries both, as copies (a share link reads them back exactly)', () => {
  const engine = createEngine(loopParams({
    voicing: [{ inversion: 1, extension: 0 }],
    hookRule: { chance: 0.5, when: 'section', order: 'weight', pool: [{ voicing: [{ inversion: 2, extension: 1 }], weight: 2 }] },
  }), { rng: seededRng(1) });
  const p = engine.getParams();
  assert.deepEqual(p.harmony.voicing, [{ inversion: 1, extension: 0 }]);
  assert.equal(p.harmony.hookRule.when, 'section');
  p.harmony.voicing[0].inversion = 2;
  p.harmony.hookRule.pool[0].voicing[0].inversion = 0;
  const again = engine.getParams();
  assert.equal(again.harmony.voicing[0].inversion, 1, 'getParams must not hand out the live voicing');
  assert.equal(again.harmony.hookRule.pool[0].voicing[0].inversion, 2, 'getParams must not hand out the live pool');
  const unset = createEngine({}, { rng: seededRng(1) }).getParams();
  assert.equal('voicing' in unset.harmony, false);
  assert.equal('hookRule' in unset.harmony, false);
});

// ---------------------------------------------------------------------------
// The rule, heard: measured from the published chord, over real bars.
// ---------------------------------------------------------------------------

test('control: with no rule, repetition 0 moves the loop (so periodicity below is a real hold)', () => hiddenTab(async () => {
  const { chords } = await playChords({}, { bars: 24 });
  assert.ok(chords.length >= 24, `only ${chords.length} chords`);
  assert.equal(periodic(chords), false, 'the pre-rule loop never moved in 24 bars — this control proves nothing');
}));

test('Chance 0 holds the loop for good: 24 bars, every pass identical', () => hiddenTab(async () => {
  const { chords } = await playChords({ hookRule: { chance: 0 } }, { bars: 24 });
  assert.ok(chords.length >= 24, `only ${chords.length} chords`);
  assert.ok(periodic(chords), `the held loop moved: ${chords.map((c) => c.key).join(' / ')}`);
}));

test('Now: a voicing is what sounds — every slot inverted, and held at Chance 0', () => hiddenTab(async () => {
  const root = await playChords({ hookRule: { chance: 0 } }, { bars: 8 });
  const inverted = await playChords({
    voicing: LOOP.map(() => ({ inversion: 1, extension: 0 })),
    hookRule: { chance: 0 },
  }, { bars: 8 });
  assert.ok(periodic(inverted.chords), 'the voiced loop moved under Chance 0');
  for (let i = 0; i < 8; i++) {
    const a = root.chords[i].key.split(',').map(Number);
    const b = inverted.chords[i].key.split(',').map(Number);
    assert.notEqual(b[0] % 12, a[0] % 12, `bar ${i}: first inversion must put a different note in the bass (${a} vs ${b})`);
  }
}));

test('Now: a changed voicing lands at the pass boundary, never mid-loop', () => hiddenTab(async () => {
  let changeAt = -1;
  const { chords } = await playChords({ hookRule: { chance: 0 } }, {
    during: async (engine) => {
      const bar = barSeconds(engine.getParams());
      await advance(bar * 5.5); // into the second pass, mid-loop
      changeAt = engine.getResolved().bar;
      engine.setParams({ harmony: { voicing: LOOP.map(() => ({ inversion: 2, extension: 0 })) } });
      await advance(bar * 8);
    },
  });
  const firstChanged = chords.findIndex((c, i) => i >= LOOP.length && c.key !== chords[i - LOOP.length].key);
  assert.ok(firstChanged > changeAt, `the voicing changed at bar ${firstChanged}, before or at the edit (bar ${changeAt})`);
  assert.equal(firstChanged % LOOP.length, 0, `the voicing changed at bar ${firstChanged}, mid-loop`);
}));

test('Pool, in turn, at every pass: the loop alternates exactly between the two voicings', () => hiddenTab(async () => {
  const a = LOOP.map(() => ({ inversion: 1, extension: 0 }));
  const b = LOOP.map(() => ({ inversion: 2, extension: 0 }));
  const { chords } = await playChords({
    hookRule: { chance: 1, when: 'pass', order: 'turn', pool: [{ voicing: a, weight: 1 }, { voicing: b, weight: 1 }] },
  }, { bars: 20 });
  const pass = (k) => chords.slice(k * 4, k * 4 + 4).map((c) => c.key).join(' ');
  // Pass 0 is the loop as established; from pass 1 the pool alternates a, b, a, b.
  assert.equal(pass(1), pass(3), 'passes 1 and 3 must both be the first pool entry');
  assert.equal(pass(2), pass(4), 'passes 2 and 4 must both be the second pool entry');
  assert.notEqual(pass(1), pass(2), 'the two pool voicings must sound different');
  assert.notEqual(pass(0), pass(1), 'the first move must leave the established voicing');
}));

test('When section: a drone never changes section, so even Chance 1 never moves the loop', () => hiddenTab(async () => {
  const { chords } = await playChords({ hookRule: { chance: 1, when: 'section' } }, { bars: 20 });
  assert.ok(periodic(chords), 'a section-timed rule moved the loop without a section change');
}));

test('unset is the pre-rule hook to the byte: explicit nulls play the same stream as nothing', () => hiddenTab(async () => {
  const plain = await playChords({}, { bars: 16, seed: 21 });
  const nulls = await playChords({ voicing: null, hookRule: null }, { bars: 16, seed: 21 });
  assert.deepEqual(nulls.chords, plain.chords);
}));

// ---------------------------------------------------------------------------
// The recipe names it — the secret-layers row "hookVoicing".
// ---------------------------------------------------------------------------

test('recipe: an unset voicing is named as established; a set rule rides; text round-trips', () => hiddenTab(async () => {
  const { engine } = await playChords({}, { bars: 12 });
  const recipe = engine.getRecipe();
  assert.deepEqual(recipe.harmony.voicing, [
    { inversion: 0, extension: -1 }, { inversion: 0, extension: -1 }, { inversion: 0, extension: -1 }, { inversion: 0, extension: -1 },
  ], 'the established loop: root position, plain triads (no suffix on the numerals)');

  const ruled = createEngine(loopParams({
    voicing: [{ inversion: 1, extension: 1 }, { inversion: 2, extension: 0 }],
    hookRule: { chance: 0.25, when: 'pass', order: 'turn', pool: [{ voicing: [{ inversion: 2, extension: -1 }], weight: 1.5 }] },
  }), { rng: seededRng(3) });
  const named = ruled.getRecipe();
  assert.deepEqual(named.harmony.voicing, [{ inversion: 1, extension: 1 }, { inversion: 2, extension: 0 }]);
  const text = recipeToText(named);
  assert.match(text, /^Chord voicing: 1st\+ 2nd$/m);
  assert.match(text, /^Chord loop rule: chance 0\.25 when pass order turn pool 2nd- x1\.5$/m);
  assert.deepEqual(recipeFromText(text), named, 'the recipe did not round-trip through text');
  const nullChance = recipeFromText('Chord loop rule: chance auto when piece order weight pool empty');
  assert.deepEqual(nullChance.harmony.hookRule, { chance: null, when: 'piece', order: 'weight', pool: [] });
}));

test('recipe rebuild: applying the named voicing to a fresh engine replays the same chords', () => hiddenTab(async () => {
  const first = await playChords({}, { bars: 16, seed: 5 });
  const recipe = first.engine.getRecipe();
  const params = loopParams({});
  const rebuilt = createEngine(params, { rng: seededRng(5) });
  rebuilt.applyRecipe({ harmony: recipe.harmony });
  const chords = [];
  rebuilt.on('chord', (c) => chords.push({ bar: c.bar, key: c.midis.join(',') }));
  await rebuilt.start();
  await advance(barSeconds(rebuilt.getParams()) * 17);
  rebuilt.stop();
  assert.deepEqual(chords.slice(0, 16), first.chords, 'a rebuild from the named Now must replay the loop');
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
