/**
 * The recipe ratchet — TODO.md "Reconstructible Ambi4" § "Recipe schema and
 * round-trip gate". Run with:
 *   node tests/recipe-roundtrip.mjs
 *
 * For every stock genre and three seeds: compile, play 16 bars, take the
 * engine's OWN recipe (getRecipe()), build a Blank-slate-like base, apply the
 * recipe to a fresh engine at the SAME seed, play 16 bars again, and diff the
 * two note streams plus their per-bar resolved voices. Every difference is
 * classified by track and by which of pitch / onset / velocity / voice it is.
 *
 * This is a RATCHET, not a pass/fail gate on perfection: `tests/fixtures/
 * recipe-gaps.json` is the recorded set of divergences this repo currently
 * accepts. Absent, this run WRITES it (the baseline). Present, this run's
 * divergences must be a SUBSET of it — a genre that starts diverging on a
 * layer the fixture never recorded is red; a genre that stops diverging on
 * one the fixture did record is a tightening, printed but not failed. The
 * gap table this prints is the point: it lists, per genre, exactly what the
 * recipe schema still cannot rebuild — hook voicing, motif, bass groove, auto
 * arp, kit variant/fills, walks, the auto ladder, preset blocks — the eight
 * layers TODO.md's diagnosis names as still decided in secret.
 *
 * Reuses the MockAudioContext and fast-clock harness genre-smoke.mjs and
 * engine-smoke.mjs both already stand up; see those files for why each piece
 * of the mock exists.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// --------------------------------------------------------------------------
// Minimal AudioContext mock (copied from genre-smoke.mjs — this suite reads
// 'note'/'bar' events and getResolved(), never the node graph itself).
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
const { createEngine: rawCreateEngine, DEFAULT_PARAMS, setGenreTable, TRACK_ORDER } = engineModule;
const { compileGenre } = await import('../src/scripts/genre-compiler.js');
const { RECIPE_FIELDS, recipeFromParams, recipeToText, recipeFromText } = await import('../src/scripts/recipe.js');

const GENRE_DIR = new URL('../src/data/genres/', import.meta.url);
const GENRES = readdirSync(fileURLToPath(GENRE_DIR))
  .filter((name) => name.endsWith('.json'))
  .sort()
  .map((name) => JSON.parse(readFileSync(new URL(name, GENRE_DIR), 'utf8')));

const BARS = 16;
const SEEDS = [1, 2, 3];
const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/recipe-gaps.json', import.meta.url));

const seededRng = (seed) => () => ((seed = (seed * 48271) % 2147483647) / 2147483647);

const builtEngines = [];
function createEngine(...args) {
  const made = rawCreateEngine(...args);
  builtEngines.push(made);
  return made;
}

/** One bar of a compiled piece, in seconds. */
function barSeconds(params) {
  const beats = { '3/4': 3, '4/4': 4, '5/4': 5, '6/8': 3, '7/8': 3.5 }[params.timeSignature] ?? 4;
  return (60 / (params.bpm * params.speed)) * beats;
}

const FAST = { step: 0.5, sleep: 6 };

async function advance(seconds, { step = 0.08, sleep = 15 } = {}) {
  const steps = Math.ceil(seconds / step);
  for (let i = 0; i < steps; i++) {
    for (const ctx of liveContexts) ctx.currentTime += step;
    await new Promise((resolve) => setTimeout(resolve, sleep));
  }
}

/** Run `fn` with the tab reported hidden, which widens the engine's lookahead. */
async function hiddenTab(fn) {
  globalThis.document = { hidden: true, addEventListener() {} };
  try {
    return await fn();
  } finally {
    delete globalThis.document;
  }
}

/**
 * Subscribe to an engine's note/bar stream, and snapshot getResolved()'s
 * per-track voice at every bar — the "what the piece is actually sounding"
 * readout the recipe's NOW/voice field claims to reproduce.
 */
function record(engine) {
  const notes = [];
  const bars = [];
  const resolvedByBar = [];
  engine.on('note', (note) => notes.push(note));
  engine.on('bar', (bar) => {
    bars.push(bar);
    const resolved = engine.getResolved();
    resolvedByBar.push({
      bar: bar.bar,
      voices: Object.fromEntries(TRACK_ORDER.map((t) => [t, resolved.tracks[t].voice])),
    });
  });
  const barOf = (note) => {
    let owner = null;
    for (const bar of bars) {
      if (bar.time > note.time + 1e-9) break;
      owner = bar;
    }
    return owner;
  };
  return { notes, bars, resolvedByBar, barOf };
}

const round2 = (v) => Math.round(v * 100) / 100;
const round4 = (v) => Math.round(v * 10000) / 10000;

/**
 * Blank-slate-like base: DEFAULT_PARAMS with every track off, randomness
 * zeroed, the arp cleared and manual, one held chord instead of a
 * progression, and every sequencer cleared and manual. Mirrors
 * buildBlankParams() in index.astro (v0.0.194/v0.0.195) for the silencing —
 * but deliberately does NOT reproduce its "his 96" step of writing an
 * explicit zeroed voiceRule ({chance:0, pool:[]}) onto every track.
 *
 * That step is correct for the real Blank-slate BUTTON, which replaces the
 * whole engine state in one go. It is wrong as the base a RECIPE gets
 * layered onto: voiceRule is sparse (setParams merges an absent key with
 * whatever the engine already has, rather than clearing it — see
 * sanitiseVoiceRule), so a base that already carries an explicit rule would
 * survive applyRecipe() for any track whose recipe has none, silently
 * replacing "no rule, the old wander" with "a rule, held" — a divergence this
 * test would wrongly blame on a secret decision layer rather than on its own
 * base. Leaving voiceRule unset here (DEFAULT_PARAMS's own tracks never set
 * it either) lets the recipe be the sole authority on it, sparse or not.
 */
function buildBlankParams() {
  const blank = JSON.parse(JSON.stringify(DEFAULT_PARAMS));
  blank.swing = 0;
  blank.complexity = 0;
  blank.repetition = 0;
  blank.arp.steps = blank.arp.steps.map(() => false);
  blank.arp.mode = 'manual';
  blank.harmony = { ...(blank.harmony || {}), seed: ['I'] };
  blank.reverbTail = 0.5;
  blank.patches = {};
  for (const track of TRACK_ORDER) {
    const t = blank.tracks[track];
    t.state = 'off';
    t.randomness = 0;
    if (t.sequencer) {
      t.sequencer.mode = 'manual';
      const clearLane = (lane) => lane.forEach((step) => { step.on = false; });
      if (Array.isArray(t.sequencer.steps)) clearLane(t.sequencer.steps);
      else Object.values(t.sequencer.steps).forEach(clearLane);
    }
  }
  return blank;
}

/** This run's note stream for one track, grouped by bar, sorted within it. */
function notesByBar(log, track) {
  const map = new Map();
  for (const note of log.notes) {
    if (note.track !== track) continue;
    const owner = log.barOf(note);
    if (!owner || owner.bar >= BARS) continue;
    if (!map.has(owner.bar)) map.set(owner.bar, []);
    map.get(owner.bar).push({
      midi: note.midi ?? null,
      kind: note.kind ?? null,
      lane: note.lane ?? null,
      velocity: round2(note.velocity),
      offset: round4(note.time - owner.time),
    });
  }
  for (const list of map.values()) list.sort((a, b) => a.offset - b.offset);
  return map;
}

/**
 * Every aspect (subset of pitch/onset/velocity/voice) on which `track`
 * diverges between the two recorded runs, over the first BARS bars.
 */
function divergentAspects(track, originalLog, rebuiltLog) {
  const aspects = new Set();
  const a = notesByBar(originalLog, track);
  const b = notesByBar(rebuiltLog, track);
  for (let bar = 0; bar < BARS; bar++) {
    const aNotes = a.get(bar) ?? [];
    const bNotes = b.get(bar) ?? [];
    if (aNotes.length !== bNotes.length) {
      aspects.add('onset');
      continue;
    }
    for (let i = 0; i < aNotes.length; i++) {
      const an = aNotes[i];
      const bn = bNotes[i];
      if (an.midi !== bn.midi || an.kind !== bn.kind || an.lane !== bn.lane) aspects.add('pitch');
      if (Math.abs(an.velocity - bn.velocity) > 1e-9) aspects.add('velocity');
      if (Math.abs(an.offset - bn.offset) > 1e-6) aspects.add('onset');
    }
  }
  for (let bar = 0; bar < BARS; bar++) {
    const av = originalLog.resolvedByBar[bar]?.voices[track];
    const bv = rebuiltLog.resolvedByBar[bar]?.voices[track];
    if (av !== undefined && bv !== undefined && av !== bv) aspects.add('voice');
  }
  return aspects;
}

async function playOriginal(params, engineSeed) {
  const engine = createEngine(params, { rng: seededRng(engineSeed) });
  const log = record(engine);
  await engine.start();
  await advance(barSeconds(params) * BARS, FAST);
  engine.stop();
  return { engine, log };
}

async function playRebuilt(recipe, engineSeed) {
  const engine = createEngine(buildBlankParams(), { rng: seededRng(engineSeed) });
  engine.applyRecipe(recipe);
  const effective = engine.getParams();
  const log = record(engine);
  await engine.start();
  await advance(barSeconds(effective) * BARS, FAST);
  engine.stop();
  return { engine, log };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---------------------------------------------------------------------------
// 1. Pure round-trip: recipeToText(recipeFromParams(params)) then back.
// ---------------------------------------------------------------------------

test('recipeToText / recipeFromText round-trip on three compiled genres', () => {
  setGenreTable(GENRES);
  try {
    const cases = [
      ['synthwave', 5],
      ['ambient', 41],
      ['techno-tools', 4242],
    ];
    for (const [slug, seed] of cases) {
      const genre = GENRES.find((g) => g.slug === slug);
      assert.ok(genre, `no genre file for ${slug}`);
      const params = compileGenre(genre, { rng: seededRng(seed) });
      const recipe = recipeFromParams(params);
      const text = recipeToText(recipe);
      assert.ok(text.length > 0, `${slug}: recipeToText produced nothing`);
      // Every non-blank line is "Label: value" and names a real field.
      const byLabel = new Map(RECIPE_FIELDS.map((row) => [row.label, row]));
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        const sep = line.indexOf(': ');
        assert.ok(sep > 0, `${slug}: unparsable line "${line}"`);
        assert.ok(byLabel.has(line.slice(0, sep)), `${slug}: unknown label in "${line}"`);
      }
      const back = recipeFromText(text);
      assert.deepEqual(back, recipe, `${slug} @${seed}: recipe did not round-trip through text`);
    }
  } finally {
    setGenreTable(null);
  }
});

test('recipeFromParams only ever names fields RECIPE_FIELDS declares, in canonical order', () => {
  const paths = RECIPE_FIELDS.map((row) => row.path);
  assert.equal(new Set(paths).size, paths.length, 'RECIPE_FIELDS has a duplicate path');
  const genre = GENRES.find((g) => g.slug === 'ambient');
  const params = compileGenre(genre, { rng: seededRng(9) });
  const recipe = recipeFromParams(params);
  // Every leaf the recipe carries must trace back to a declared path.
  const flatten = (node, prefix, out) => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) {
      out.push(prefix);
      return out;
    }
    for (const [key, value] of Object.entries(node)) flatten(value, prefix ? `${prefix}.${key}` : key, out);
    return out;
  };
  const leaves = flatten(recipe, '', []);
  for (const leaf of leaves) {
    assert.ok(paths.some((p) => leaf === p || leaf.startsWith(`${p}.`)),
      `recipe carries a leaf "${leaf}" no RECIPE_FIELDS row declares`);
  }
});

// ---------------------------------------------------------------------------
// 2. The ratchet: compile, play, recipe, rebuild from Blank slate, replay.
// ---------------------------------------------------------------------------

test('the recipe ratchet: every stock genre, three seeds, played 16 bars each way',
  () => hiddenTab(async () => {
    setGenreTable(GENRES);
    const gapTable = {};
    try {
      for (const genre of GENRES) {
        const genreLayers = new Set();
        for (const seed of SEEDS) {
          const params = compileGenre(genre, { rng: seededRng(seed) });
          const engineSeed = seed * 97 + 13; // decorrelated from the compile draws
          const { engine: originalEngine, log: originalLog } = await playOriginal(params, engineSeed);
          const recipe = originalEngine.getRecipe();
          const { log: rebuiltLog } = await playRebuilt(recipe, engineSeed);
          for (const track of TRACK_ORDER) {
            for (const aspect of divergentAspects(track, originalLog, rebuiltLog)) {
              genreLayers.add(`${track}:${aspect}`);
            }
          }
        }
        gapTable[genre.slug] = [...genreLayers].sort();
      }
    } finally {
      setGenreTable(null);
    }

    console.log('\nRecipe ratchet — divergent layers per genre (rebuilt from its own recipe onto Blank slate):');
    for (const slug of Object.keys(gapTable).sort()) {
      const layers = gapTable[slug];
      console.log(layers.length
        ? `  ${slug}: ${layers.join(', ')}`
        : `  ${slug}: rebuilds byte-identical from its recipe over ${BARS} bars`);
    }

    if (!existsSync(FIXTURE_PATH)) {
      writeFileSync(FIXTURE_PATH, `${JSON.stringify(gapTable, null, 2)}\n`);
      console.log(`\n(no fixture found — wrote ${FIXTURE_PATH} as the ratchet baseline)`);
      return;
    }

    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
    const tightened = [];
    for (const slug of Object.keys(gapTable)) {
      const current = new Set(gapTable[slug]);
      const baseline = new Set(fixture[slug] ?? []);
      const grew = [...current].filter((layer) => !baseline.has(layer));
      assert.equal(grew.length, 0,
        `${slug}: diverges on ${grew.join(', ')}, which the ratchet fixture never recorded`);
      const healed = [...baseline].filter((layer) => !current.has(layer));
      if (healed.length) tightened.push(`${slug}: ${healed.join(', ')}`);
    }
    if (tightened.length) {
      console.log(`\nratchet can tighten: ${tightened.join('; ')}`);
    }
  }));

// ---------------------------------------------------------------------------
// The secret-layers table — the honest ratchet.
//
// A same-seed replay reproduces every layer, so the stream diff above says
// nothing about which decisions the recipe NAMES and which it merely re-rolls.
// This table asks, per layer, whether the recipe carries the realised choice
// (so a rebuild at ANY seed would keep it): a layer moves from secret to named
// as its rule ships, and may never move back. Pinned in
// tests/fixtures/recipe-secret-layers.json.
// ---------------------------------------------------------------------------

/** A dotted path read out of the recipe's tree; undefined when absent. */
const at = (obj, path) => path.split('.').reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), obj);
const anyTrack = (recipe, field) => TRACK_ORDER.some((track) => at(recipe, `tracks.${track}.${field}`) !== undefined);
const SECRET_LAYERS = [
  ['hookVoicing', 'chord voicing per hook slot and hook mutation (mutateHook, bankHook)',
    (recipe) => at(recipe, 'harmony.voicing') !== undefined || at(recipe, 'harmony.hookRule') !== undefined],
  ['motif', 'melody motif shape, rhythm, leap and development (buildMotif, developMotif)',
    (recipe) => at(recipe, 'tracks.melody.motif') !== undefined || at(recipe, 'tracks.melody.motifRule') !== undefined],
  ['bassGroove', 'bass feel, articulation, anchor lock, syncopation cell drawn (buildBassGroove)',
    (recipe) => at(recipe, 'tracks.bass.groove') !== undefined || at(recipe, 'tracks.bass.grooveRule') !== undefined],
  ['arpAuto', 'arp pattern, rate, octaves under auto (autoArpSettings)',
    (recipe, resolved) => Boolean(resolved.arp) && (!resolved.arp.auto
      || (at(recipe, 'arp.pattern') === resolved.arp.pattern && at(recipe, 'arp.rate') === resolved.arp.rate && at(recipe, 'arp.octaves') === resolved.arp.octaves))],
  ['kitVariant', 'which kit variant plays when, and fills (kitFillVariant, bank switching)',
    (recipe) => at(recipe, 'tracks.percussion.variantRule') !== undefined || at(recipe, 'tracks.percussion.fillRule') !== undefined],
  ['walks', 'the live position inside every min-max walk',
    (recipe) => at(recipe, 'walks') !== undefined || anyTrack(recipe, 'walkSeed')],
  ['autoLadder', 'the intensity at which an auto track joins (AUTO_THRESHOLDS)',
    (recipe) => anyTrack(recipe, 'autoThreshold')],
  ['presetBlocks', 'the bar-by-bar blocks of abab / journey / waves (PRESET_BLOCKS)',
    (recipe) => at(recipe, 'structure') === 'custom' || at(recipe, 'customStructure') !== undefined],
  ['voiceRule', 'the voice a track sounds, and when it may move (voiceRule, v0.0.195)',
    (recipe) => anyTrack(recipe, 'voiceRule')],
];

test('the secret-layers table: a layer named by the recipe never goes secret again', () => hiddenTab(async () => {
  setGenreTable(GENRES);
  const fixturePath = new URL('./fixtures/recipe-secret-layers.json', import.meta.url);
  const params = compileGenre(GENRES.find((g) => g.slug === 'synthwave'), { rng: seededRng(11) });
  // A rule set on purpose, so the table can show a NAMED layer beside the secret ones.
  params.tracks.melody.voiceRule = { chance: 0, when: 'bar', pool: [{ id: 'keys', weight: 1 }], order: 'weight' };
  const engine = createEngine(params, { rng: seededRng(11) });
  await engine.start();
  await advance(barSeconds(params) * 2, { step: 0.5, sleep: 6 });
  const recipe = engine.getRecipe();
  const resolved = engine.getResolved();
  engine.stop();
  const table = {};
  for (const [id, what, named] of SECRET_LAYERS) table[id] = Boolean(named(recipe, resolved));
  console.log('\nsecret layers (named by the recipe = true):');
  for (const [id, what] of SECRET_LAYERS) console.log(`  ${table[id] ? 'named ' : 'SECRET'}  ${id} — ${what}`);
  const fs = await import('node:fs');
  if (!fs.existsSync(fixturePath)) {
    fs.writeFileSync(fixturePath, JSON.stringify(table, null, 2) + '\n');
    console.log(`secret-layers fixture written: ${fixturePath.pathname}`);
    return;
  }
  const pinned = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const regressed = Object.keys(pinned).filter((id) => pinned[id] === true && table[id] !== true);
  assert.deepEqual(regressed, [], `layers the recipe named before and no longer does: ${regressed.join(', ')}`);
  const tightened = Object.keys(table).filter((id) => table[id] === true && pinned[id] !== true);
  if (tightened.length) console.log(`ratchet can tighten: ${tightened.join(', ')} are named now — update the fixture in the same commit`);
}));

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let failures = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}\n     ${error.stack || error.message}`);
  } finally {
    for (const made of builtEngines) if (made.running) made.stop();
    builtEngines.length = 0;
    liveContexts.length = 0;
  }
}
console.log(`\n${tests.length - failures}/${tests.length} passed`);
process.exit(failures ? 1 : 0);
