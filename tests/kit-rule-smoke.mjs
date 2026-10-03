/**
 * The kit's variant schedule and fills as rules — "Reconstructible Ambi4",
 * TODO.md. Gated at the ENGINE.
 *
 *   npm run build && node tests/kit-rule-smoke.mjs
 *
 * Until now which kit tab played each bar was a Markov walk over the tabs'
 * weights, and the Energy fill (kitFillVariant) was one more tab with a solved
 * weight — numbers nobody could read as a rule. Now the percussion track may
 * carry `variantRule` and `fillRule`, each { chance, when, pool, order } over
 * the step grid's tabs (ambient-engine.js sanitiseTabRule). This suite asserts
 * the RESOLVED tab each bar (getResolved().tracks.percussion.sequencer), that
 * a piece with no rule — or a variant rule whose chance is null — keeps the
 * old stream to the byte, that the recipe names the schedule, and that the
 * compiler's own bank reads back as the documented fill rate.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// Minimal AudioContext mock — enough surface for the engine's graph and for
// the voice library's nodes. Deliberately thinner than engine-smoke's: this
// suite reads 'note' events, never the node graph.
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
const { setGenreTable, TIME_SIGNATURES } = engineModule;
const GENRE_DIR = new URL('../src/data/genres/', import.meta.url);
const GENRES = readdirSync(GENRE_DIR)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .map((name) => JSON.parse(readFileSync(new URL(name, GENRE_DIR), 'utf8')));
setGenreTable(GENRES);

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

const { kitBankRules } = await import('../src/scripts/genre-compiler.js');
const { recipeToText, recipeFromText } = await import('../src/scripts/recipe.js');
const acidJazz = GENRES.find((g) => g.slug === 'acid-jazz');
assert.ok(acidJazz, 'no acid-jazz genre file');

/** Acid jazz's kit at Energy 0.75: three grooves and the fill — four tabs. */
function kitPiece(seed = 7, kitComplexity = 0.75) {
  const params = compileGenre(acidJazz, { rng: seededRng(seed), kitComplexity });
  assert.equal(params.tracks.percussion.sequencers.length, 4, 'acid jazz at 0.75 compiles three grooves and a fill');
  params.tracks.percussion.state = 'on';
  return params;
}

/** Play `bars` bars: the kit's tab and fill flag at each bar, its notes, and the engine. */
async function playKit(params, seed, bars) {
  const engine = createEngine(params, { rng: seededRng(seed) });
  const tabs = [];
  const fills = [];
  const notes = [];
  // The 'bar' event fires before the bar's tab is chosen, so the tab is read
  // at the NEXT bar's event (and once after the run for the last one).
  let first = true;
  engine.on('bar', () => {
    if (!first) {
      const kit = engine.getResolved().tracks.percussion;
      tabs.push(kit.sequencer);
      fills.push(kit.fill === true);
    }
    first = false;
  });
  engine.on('note', (note) => {
    if (note.track === 'percussion') notes.push({ time: note.time, text: `${note.lane ?? note.kind}@${note.time.toFixed(4)}:${(note.velocity ?? 0).toFixed(3)}` });
  });
  await engine.start();
  await advance(barSeconds(params) * (bars + 1));
  engine.stop();
  return { tabs, fills, notes, engine };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('sanitise: sparse, field-by-field merge, null clears, pools held to the tabs, fill chance never null', () => {
  const params = kitPiece();
  const base = engineModule.sanitiseParams({ tracks: { percussion: {
    sequencers: params.tracks.percussion.sequencers,
    variantRule: { chance: 0.5, when: 'section', pool: [0, { tab: 2, weight: 3 }, 0, 9, -1, 'x'], order: 'turn' },
    fillRule: { chance: null, pool: [3] },
  } } });
  assert.deepEqual(base.tracks.percussion.variantRule, { chance: 0.5, when: 'section', pool: [{ tab: 0, weight: 1 }, { tab: 2, weight: 3 }], order: 'turn' });
  assert.deepEqual(base.tracks.percussion.fillRule, { chance: 0, when: 'bar', pool: [{ tab: 3, weight: 1 }], order: 'weight' }, 'a fill has no "follows" — null chance is no fills');
  const fresh = engineModule.sanitiseParams({});
  assert.equal('variantRule' in fresh.tracks.percussion, false, 'a fresh kit carries no variant rule key');
  assert.equal('fillRule' in fresh.tracks.percussion, false, 'a fresh kit carries no fill rule key');
  const merged = engineModule.sanitiseParams({ tracks: { percussion: { variantRule: { chance: 0 } } } }, base);
  assert.equal(merged.tracks.percussion.variantRule.chance, 0);
  assert.equal(merged.tracks.percussion.variantRule.order, 'turn', 'a partial rule keeps the rest');
  const cleared = engineModule.sanitiseParams({ tracks: { percussion: { fillRule: null } } }, base);
  assert.equal('fillRule' in cleared.tracks.percussion, false, 'null clears the fill rule');
  const shrunk = engineModule.sanitiseParams({ tracks: { percussion: { sequencers: params.tracks.percussion.sequencers.slice(0, 2) } } }, base);
  assert.deepEqual(shrunk.tracks.percussion.variantRule.pool, [{ tab: 0, weight: 1 }], 'a tab the list lost leaves the pool');
  assert.deepEqual(shrunk.tracks.percussion.fillRule.pool, [], 'the fill tab went with the list');
  const follows = engineModule.sanitiseParams({ tracks: { percussion: { variantRule: { chance: null } } } });
  assert.equal(follows.tracks.percussion.variantRule.chance, null, 'a null variant chance follows the tabs');
  const melody = engineModule.sanitiseParams({ tracks: { melody: { variantRule: { chance: 0 }, fillRule: { chance: 1 } } } });
  assert.equal('variantRule' in melody.tracks.melody, false, 'only a kit takes tab rules');
});

test('no rule, and a variant rule whose chance is null, play the old kit stream to the byte', () => hiddenTab(async () => {
  const plain = await playKit(kitPiece(), 7, 24);
  const named = kitPiece();
  named.tracks.percussion.variantRule = { chance: null, when: 'bar', pool: [], order: 'weight' };
  const followed = await playKit(named, 7, 24);
  assert.ok(plain.notes.length > 0, 'the kit never sounded');
  assert.ok(new Set(plain.tabs).size > 1, 'the unruled kit should move between its tabs over 24 bars');
  // The mock clock runs a bar more or less at the end; compare the first 20.
  const cutoff = barSeconds(named) * 20;
  const upTo = (notes) => notes.filter((note) => note.time < cutoff).map((note) => note.text);
  assert.deepEqual(followed.tabs.slice(0, 20), plain.tabs.slice(0, 20), 'a null-chance variant rule moved the tab schedule');
  assert.deepEqual(upTo(followed.notes), upTo(plain.notes), 'a null-chance variant rule moved the kit stream');
  assert.equal('variantRule' in plain.engine.getParams().tracks.percussion, false, 'getParams invents no rule');
}));

test('Chance 0 holds the first tab for 40 bars, whatever the weights say', () => hiddenTab(async () => {
  const params = kitPiece(3);
  params.tracks.percussion.variantRule = { chance: 0, when: 'bar', pool: [{ tab: 1, weight: 1 }, { tab: 2, weight: 1 }], order: 'weight' };
  const { tabs, notes } = await playKit(params, 3, 40);
  assert.ok(notes.length > 0, 'the kit never sounded');
  assert.ok(tabs.length >= 40, `only ${tabs.length} bars played`);
  assert.ok(tabs.every((tab) => tab === 0), `the held kit moved: ${[...new Set(tabs)]}`);
}));

test('a pool of one tab at Chance 1 plays that tab and nothing else after the first bar', () => hiddenTab(async () => {
  const params = kitPiece(5);
  params.tracks.percussion.variantRule = { chance: 1, when: 'bar', pool: [{ tab: 2, weight: 1 }], order: 'weight' };
  const { tabs } = await playKit(params, 5, 24);
  // The kit joins a few bars in (staged entry) on its first tab; from its
  // first draw on, only the pool's tab may play.
  const from = tabs.indexOf(2);
  assert.ok(from >= 0 && from < 10, `the pool's tab never played: ${tabs.join(' ')}`);
  assert.ok(tabs.slice(from).every((tab) => tab === 2), `a tab outside the pool played: ${tabs.join(' ')}`);
}));

test('In turn walks the pool in order, each bar', () => hiddenTab(async () => {
  const params = kitPiece(9);
  params.tracks.percussion.variantRule = { chance: 1, when: 'bar', pool: [{ tab: 2, weight: 1 }, { tab: 0, weight: 1 }, { tab: 1, weight: 1 }], order: 'turn' };
  const { tabs } = await playKit(params, 9, 16);
  const cycle = [2, 0, 1];
  let checked = 0;
  // The kit joins a few bars in (staged entry) on its first tab; the walk
  // starts at its first move.
  const from = tabs.findIndex((tab) => tab !== tabs[0]);
  assert.ok(from > 0 && from < 10, `the kit never moved: ${tabs.join(' ')}`);
  for (let i = from; i < tabs.length; i++) {
    assert.equal(tabs[i], cycle[(cycle.indexOf(tabs[i - 1]) + 1) % 3], `bar ${i}: after tab ${tabs[i - 1]} came ${tabs[i]}`);
    checked += 1;
  }
  assert.ok(checked >= 8, `only ${checked} steps of the walk were checked: ${tabs.join(' ')}`);
}));

test('a fill at Chance 1 each bar plays one bar and hands back to the tab it interrupted', () => hiddenTab(async () => {
  const params = kitPiece(11);
  params.tracks.percussion.variantRule = { chance: 0, when: 'bar', pool: [], order: 'weight' };
  params.tracks.percussion.fillRule = { chance: 1, when: 'bar', pool: [{ tab: 3, weight: 1 }], order: 'weight' };
  const { tabs, fills } = await playKit(params, 11, 24);
  const fillBars = tabs.filter((tab) => tab === 3).length;
  assert.ok(fillBars >= 8, `the fill should play every other bar: ${tabs.join(' ')}`);
  for (let i = 1; i < tabs.length; i++) {
    assert.ok(!(tabs[i] === 3 && tabs[i - 1] === 3), `the fill played two bars running at bar ${i}: ${tabs.join(' ')}`);
    if (tabs[i - 1] === 3) assert.equal(tabs[i], 0, `the fill at bar ${i - 1} handed back to tab ${tabs[i]}, not the held tab 0`);
    assert.equal(fills[i], tabs[i] === 3, `bar ${i}: getResolved's fill flag disagrees with the tab`);
  }
}));

test('a fill tab never plays as a variant, even when the variant pool and the weights name it', () => hiddenTab(async () => {
  const params = kitPiece(13);
  params.tracks.percussion.variantRule = { chance: 1, when: 'bar', pool: [0, 1, 3].map((tab) => ({ tab, weight: 1 })), order: 'weight' };
  params.tracks.percussion.fillRule = { chance: 0, when: 'bar', pool: [{ tab: 3, weight: 1 }], order: 'weight' };
  const { tabs } = await playKit(params, 13, 32);
  assert.ok(!tabs.includes(3), `the fill tab played as a variant: ${tabs.join(' ')}`);
  assert.ok(tabs.includes(1), 'the pool tab 1 never played');
  const unruled = kitPiece(13);
  unruled.tracks.percussion.fillRule = { chance: 0, when: 'bar', pool: [{ tab: 3, weight: 1 }], order: 'weight' };
  const weighted = await playKit(unruled, 13, 32);
  assert.ok(!weighted.tabs.includes(3), `the tabs' own weights landed on the fill tab: ${weighted.tabs.join(' ')}`);
}));

test('a fill each section lands only on the last bar of a section', () => hiddenTab(async () => {
  const params = kitPiece(17);
  params.structure = 'abab';
  params.tracks.percussion.variantRule = { chance: 0, when: 'bar', pool: [], order: 'weight' };
  params.tracks.percussion.fillRule = { chance: 1, when: 'section', pool: [{ tab: 3, weight: 1 }], order: 'weight' };
  const engine = createEngine(params, { rng: seededRng(17) });
  const sections = [];
  const tabs = [];
  let first = true;
  engine.on('section', ({ bar }) => sections.push(bar));
  engine.on('bar', () => {
    if (!first) tabs.push(engine.getResolved().tracks.percussion.sequencer);
    first = false;
  });
  await engine.start();
  await advance(barSeconds(params) * 41);
  engine.stop();
  const fillAt = tabs.map((tab, i) => (tab === 3 ? i : -1)).filter((i) => i >= 0);
  assert.ok(sections.length >= 3, `too few sections in 40 bars: ${sections}`);
  assert.ok(fillAt.length >= 1, `no section-end fill in 40 bars: ${tabs.join(' ')}`);
  for (const bar of fillAt) {
    assert.ok(sections.includes(bar + 1), `a section fill played at bar ${bar}, which is not the last bar of a section (sections start at ${sections})`);
  }
}));

test('kitBankRules reads the compiled bank back as rules: 20% fill at 0.75, 50% at full, mains evenly', () => {
  for (const [kc, rate] of [[0.75, 0.2], [1, 0.5]]) {
    const params = compileGenre(acidJazz, { rng: seededRng(4), kitComplexity: kc });
    const { variantRule, fillRule } = kitBankRules(params.tracks.percussion.sequencers, params.tracks.percussion.sequencerAdvance);
    assert.ok(fillRule, `no fill rule read from the ${kc} bank`);
    assert.ok(Math.abs(fillRule.chance - rate) < 0.005, `fill chance at ${kc} is ${fillRule.chance}, not ${rate}`);
    assert.deepEqual(fillRule.pool.map((entry) => entry.tab), [3]);
    assert.deepEqual(variantRule.pool.map((entry) => entry.tab), [0, 1, 2]);
    assert.ok(variantRule.pool.every((entry) => entry.weight === variantRule.pool[0].weight), 'the mains are evenly weighted');
    assert.equal(variantRule.chance, 1);
  }
  const plain = compileGenre(acidJazz, { rng: seededRng(4) });
  const { fillRule } = kitBankRules(plain.tracks.percussion.sequencers);
  assert.equal(fillRule, null, 'an authored kit (no Energy fill) reads no fill');
  assert.deepEqual(kitBankRules([plain.tracks.percussion.sequencers[0]]), { variantRule: null, fillRule: null });
});

test('the derived rules visit the fill at the rate the weights did (0.75: one bar in five)', () => hiddenTab(async () => {
  const params = kitPiece(19);
  const derived = kitBankRules(params.tracks.percussion.sequencers);
  params.tracks.percussion.variantRule = derived.variantRule;
  params.tracks.percussion.fillRule = derived.fillRule;
  const { tabs } = await playKit(params, 19, 240);
  const sounding = tabs.slice(4);
  // A fill can only start on a bar after a non-fill bar, so the visit rate
  // per eligible bar is fills / (bars - fills).
  const fillsSeen = sounding.filter((tab) => tab === 3).length;
  const rate = fillsSeen / (sounding.length - fillsSeen);
  assert.ok(rate > 0.13 && rate < 0.27, `fill visit rate ${rate.toFixed(3)} over ${sounding.length} bars, not ~0.2`);
}));

test('the recipe names the schedule: a null-chance rule by default, the set rules verbatim, and text round-trips', () => {
  const unset = createEngine(kitPiece(), { rng: seededRng(1) });
  const recipe = unset.getRecipe();
  assert.deepEqual(recipe.tracks.percussion.variantRule, { chance: null, when: 'bar', pool: [], order: 'weight' });
  assert.ok(recipe.tracks.percussion.sequencers.every((seq) => Array.isArray(seq.weights)), 'the recipe carries the weights the null chance points at');
  assert.equal(recipe.tracks.percussion.sequencers[0].weights.length, 4);
  const ruled = createEngine(kitPiece(), { rng: seededRng(1) });
  ruled.setParams({ tracks: { percussion: {
    variantRule: { chance: 0.25, when: 'section', pool: [{ tab: 0, weight: 2 }, { tab: 2, weight: 1 }], order: 'turn' },
    fillRule: { chance: 0.5, when: 'section', pool: [{ tab: 3, weight: 1 }], order: 'weight' },
  } } });
  const named = ruled.getRecipe();
  assert.deepEqual(named.tracks.percussion.fillRule, { chance: 0.5, when: 'section', pool: [{ tab: 3, weight: 1 }], order: 'weight' });
  const text = recipeToText(named);
  assert.ok(text.includes('Percussion variant rule: chance 0.25 when section order turn pool 1:2,3:1'), `the variant rule's line: ${text.split('\n').filter((l) => l.includes('rule')).join(' | ')}`);
  assert.ok(text.includes('Percussion fill rule: chance 0.5 when section order weight pool 4:1'));
  assert.ok(recipeToText(recipe).includes('Percussion variant rule: chance weights when bar order weight pool empty'));
  assert.deepEqual(recipeFromText(text), named, 'text round trip');
  const rebuilt = createEngine(engineModule.sanitiseParams({}), { rng: seededRng(1) });
  rebuilt.applyRecipe(recipeFromText(text));
  assert.deepEqual(rebuilt.getParams().tracks.percussion.variantRule, named.tracks.percussion.variantRule);
  assert.deepEqual(rebuilt.getParams().tracks.percussion.fillRule, named.tracks.percussion.fillRule);
});

test('a genre file (Save as my genre) carries the kit rules through the compiler', () => {
  const genre = structuredClone(acidJazz);
  genre.essence.instrumentation = genre.essence.instrumentation || {};
  genre.essence.instrumentation.perTrack = { ...(genre.essence.instrumentation.perTrack || {}), percussion: { variantRule: { chance: 0, when: 'bar', pool: [], order: 'weight' }, fillRule: { chance: 0.3, when: 'section', pool: [{ tab: 2, weight: 1 }] } } };
  const params = compileGenre(genre, { rng: seededRng(2) });
  assert.deepEqual(params.tracks.percussion.variantRule, { chance: 0, when: 'bar', pool: [], order: 'weight' });
  assert.deepEqual(params.tracks.percussion.fillRule, { chance: 0.3, when: 'section', pool: [{ tab: 2, weight: 1 }], order: 'weight' });
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
