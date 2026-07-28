/**
 * Frozen-reference audio comparison — run with:
 *
 *   node tests/audio-reference.mjs            check every config against the baseline
 *   node tests/audio-reference.mjs --update   rewrite the baseline from this engine
 *
 * ── What this is for ──────────────────────────────────────────────────────
 *
 * Every other suite in tests/ asks whether the engine is CORRECT. This one asks
 * whether it still sounds the SAME. It plays every shipped configuration — all
 * twelve factory presets and all twelve stock genres — from a fixed seed,
 * digests the notes it scheduled, and compares that digest against
 * `tests/audio-reference-baseline.json`, which is committed.
 *
 * So: ANY COMMIT THAT CHANGES HOW AN EXISTING PRESET OR GENRE SOUNDS MUST
 * REGENERATE THE BASELINE IN THE SAME COMMIT, AND THAT COMMIT'S MESSAGE MUST
 * SAY THE SOUND CHANGE WAS DELIBERATE. A baseline regenerated on its own, or in
 * a commit that does not mention it, is indistinguishable from an accident that
 * was papered over — which is the exact failure this file exists to prevent. If
 * you did not mean to change the sound and this suite says DRIFT, the finding is
 * in your diff, not in the baseline.
 *
 * ── What the digest can and cannot see ────────────────────────────────────
 *
 * The digest is of SCHEDULED NOTES, not of rendered audio. Under the mock
 * AudioContext nothing is synthesised: what is captured is which track played
 * which pitch, when, how loud and for how long. That means it is:
 *
 *  - SENSITIVE to: the generators, the chord/hook machinery, the groove and
 *    density draws, the auto-track ladder, the structure envelopes, tempo, the
 *    genre compiler's draws, every preset's params, and the rng call ORDER
 *    anywhere in the scheduling path.
 *  - BLIND to: timbre, the voice library, patches, filters, envelopes, reverb,
 *    delay, panning, per-track gain, the glue compressor, and the master fader.
 *    A change to any of those can transform how the piece sounds while this
 *    suite reports PASS on all 24 configs. Those changes need ears, not a hash.
 *
 * Quantisation is deliberate: beat position, velocity and duration are rounded
 * to 3 decimal places before hashing, so float noise below the audible floor
 * does not raise a false DRIFT. Anything that survives 3dp is a real change.
 *
 * ── The window ────────────────────────────────────────────────────────────
 *
 * A piece opens with the pad alone and admits one more track per bar, so bars
 * 0–5 are staged entry and say little about a config's character. The digest
 * covers BARS 6–13 — eight settled bars per config. All 24 configs fit that
 * window inside the runtime budget: 24 configs, ~13 s, against a ~120 s budget.
 * If the config set ever outgrows that, shorten the window (BAR_FROM/BAR_TO
 * below) rather than dropping configs — a config with no baseline is a config
 * nothing is guarding — and say in this header how many bars are covered.
 *
 * The baseline stores, per bar, the note count, the sounding track set, the
 * sha256 and the quantised tuples the sha256 was taken over. The HASH is what
 * PASS/DRIFT is decided on; the TUPLES are there so a failure can name the note
 * that moved and so `git diff` on the baseline reads as a musical change rather
 * than as a wall of changed hashes.
 *
 * ── Determinism ───────────────────────────────────────────────────────────
 *
 * Both halves are seeded: the genre compiler draws from `seededRng(COMPILE_SEED)`
 * and the engine plays from `seededRng(PLAY_SEED)`, the same discipline as
 * engine-smoke's note-for-note reproduction test. The mock clock races the
 * engine's real setInterval scheduler, so a loaded box buys fewer bars per mock
 * second — every run therefore waits for BARS (advanceUntil), never for seconds.
 * The baseline's `generated` field carries package.json's version, never a wall
 * clock, so a regenerated baseline diffs only where the sound actually moved.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

// --------------------------------------------------------------------------
// Minimal AudioContext mock — the same one energy-measure.mjs drives the engine
// with. It renders nothing; it records the graph and lets the engine's own
// 'note'/'bar' events carry every scheduling decision, which is all this suite
// reads.
// --------------------------------------------------------------------------

function makeParam(value) {
  return {
    value,
    ramps: [],
    setValueAtTime(v, at) { this.ramps.push({ to: v, at, kind: 'set' }); this.value = v; return this; },
    linearRampToValueAtTime(v, at) { this.ramps.push({ to: v, at, kind: 'linear' }); this.value = v; return this; },
    exponentialRampToValueAtTime(v, at) {
      assert.ok(v > 0, 'exponential ramps must never target zero');
      this.ramps.push({ to: v, at, kind: 'exponential' });
      this.value = v;
      return this;
    },
    setTargetAtTime(v, at) { this.ramps.push({ to: v, at, kind: 'target' }); this.value = v; return this; },
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
const { sanitiseParams, setGenreTable, TRACK_ORDER } = engineModule;
const { compileGenre } = await import('../src/scripts/genre-compiler.js');

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

/** The digest window: bars 0–5 are staged entry, so the window opens at 6. */
const BAR_FROM = 6;
const BAR_TO = 14;   // exclusive — eight bars, 6…13

/** The engine's rng seed. Every config plays from the same one. */
const PLAY_SEED = 20260728;

/** The genre compiler's rng seed — it draws mode, metre, bpm, structure, kit. */
const COMPILE_SEED = 4242;

/** Hidden-tab clock: a 2.5 s lookahead is what makes 0.5 s jumps safe. */
const FAST = { step: 0.5, sleep: 4 };

/** Bar budget in mock seconds — a 40 bpm 6/8 genre needs a lot of them. */
const BAR_BUDGET_SECONDS = 400;

const ROOT = new URL('../', import.meta.url);
const GENRE_DIR = new URL('src/data/genres/', ROOT);
const BASELINE_PATH = new URL('audio-reference-baseline.json', import.meta.url);
const PACKAGE_PATH = new URL('package.json', ROOT);

const BASELINE_NOTE =
  'regenerate with --update ONLY in a commit whose message declares the sound change deliberately';

const seededRng = (seed) => () => ((seed = (seed * 48271) % 2147483647) / 2147483647);

const UPDATE = process.argv.includes('--update');

// --------------------------------------------------------------------------
// The config set: every factory preset, every stock genre
// --------------------------------------------------------------------------

/** Every genre file, in slug order — the same set genre-smoke.mjs runs over. */
const GENRES = readdirSync(GENRE_DIR)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .map((name) => JSON.parse(readFileSync(new URL(name, GENRE_DIR), 'utf8')));

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const isUsablePreset = (p) =>
  !!p && typeof p === 'object'
  && SLUG_RE.test(String(p.slug ?? ''))
  && typeof p.name === 'string'
  && !!p.params && typeof p.params === 'object';

/**
 * The preset set this build ships. Mirrors `resolveFactoryPresets()` in
 * src/data/factory-presets-fallback.js — that function cannot be called from
 * here because it resolves through `import.meta.glob`, which is Vite's, not
 * Node's. Same rule as the page: the JSON wholesale when every entry is usable,
 * the fallback module otherwise.
 */
function resolvePresets() {
  try {
    const list = JSON.parse(readFileSync(new URL('src/data/factory-presets.json', ROOT), 'utf8'));
    if (Array.isArray(list) && list.length && list.every(isUsablePreset)) return list;
  } catch {
    // absent or unparseable — the fallback module is the answer, as in the page
  }
  return null;
}

const presets = resolvePresets()
  ?? (await import('../src/data/factory-presets-fallback.js')).FACTORY_PRESETS_FALLBACK;

/**
 * A preset's params are PARTIAL — the page deep-merges them over its own
 * DEFAULTS. Here they are merged over the ENGINE's defaults by the engine's own
 * sanitiser, which is the same shape and the only merge a test can reach
 * honestly (the page's DEFAULTS live inside an Astro component). Where the two
 * default sets differ in a field the preset does not set, this digest guards
 * the engine's reading of the preset rather than the page's; every field a
 * preset actually specifies is identical either way.
 */
const CONFIGS = [
  ...presets.map((preset) => ({
    id: `preset:${preset.slug}`,
    params: sanitiseParams(preset.params),
  })),
  ...GENRES.map((genre) => ({
    id: `genre:${genre.slug}`,
    params: compileGenre(genre, { rng: seededRng(COMPILE_SEED) }),
  })),
].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

// --------------------------------------------------------------------------
// Playing and digesting
// --------------------------------------------------------------------------

/**
 * Play one config and digest bars BAR_FROM…BAR_TO-1.
 *
 * Per bar: the note count, the sounding track set (in TRACK_ORDER), the
 * quantised note tuples in the order the engine scheduled them, and a sha256
 * over those tuples. The HASH is what PASS/DRIFT is decided on; the tuple list
 * is what a failure report and a git diff of the baseline are read from.
 */
async function digestConfig(config) {
  const engine = engineModule.createEngine(config.params, { rng: seededRng(PLAY_SEED) });
  const log = record(engine);
  try {
    await engine.start();
    const reached = await advanceUntil(() => log.bars.length > BAR_TO, BAR_BUDGET_SECONDS, FAST);
    assert.ok(reached,
      `${config.id}: only ${log.bars.length} bars inside the ${BAR_BUDGET_SECONDS} s budget `
      + `— ${BAR_TO + 1} are needed to close the window at bar ${BAR_TO - 1}`);
  } finally {
    if (engine.running) engine.stop();
  }

  const bars = [];
  let total = 0;
  for (let index = BAR_FROM; index < BAR_TO; index++) {
    const bar = log.bars[index];
    const next = log.bars[index + 1];
    assert.equal(bar.bar, index, `${config.id}: bar events are out of order at ${index}`);
    const span = next.time - bar.time;
    const secondsPerBeat = span / bar.beatsPerBar;
    const inBar = log.notes.filter((n) => n.time >= bar.time - 1e-9 && n.time < next.time - 1e-9);
    const tuples = inBar.map((n) => [
      n.track,
      round3((n.time - bar.time) / secondsPerBeat),
      n.midi === null || n.midi === undefined ? '-' : n.midi,
      round3(n.velocity),
      round3(n.duration),
    ].join(':'));
    const digest = tuples.join(';');
    total += inBar.length;
    bars.push({
      bar: index,
      notes: inBar.length,
      tracks: TRACK_ORDER.filter((name) => inBar.some((n) => n.track === name)).join(','),
      hash: createHash('sha256').update(digest).digest('hex'),
      digest,
    });
  }
  return { bars, total };
}

/** Fixed 3dp, so float noise below the audible floor cannot raise a DRIFT. */
const round3 = (value) => (Number.isFinite(value) ? value.toFixed(3) : String(value));

/** Subscribe to an engine's note/bar stream. */
function record(engine) {
  const notes = [];
  const bars = [];
  engine.on('note', (note) => notes.push(note));
  engine.on('bar', (bar) => bars.push(bar));
  return { notes, bars };
}

/**
 * Advance the mock clock until `ready()` holds, up to a `seconds` budget. The
 * scheduler is a real timer racing a mock clock, so a busy box buys fewer bars
 * per mock second — anything needing N bars waits for the bars, not the seconds.
 */
async function advanceUntil(ready, seconds, { step, sleep }) {
  const steps = Math.ceil(seconds / step);
  for (let i = 0; i < steps; i++) {
    if (ready()) return true;
    for (const ctx of liveContexts) ctx.currentTime += step;
    await new Promise((resolve) => setTimeout(resolve, sleep));
  }
  return ready();
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

// --------------------------------------------------------------------------
// Comparison and reporting
// --------------------------------------------------------------------------

/** The first bar-by-bar difference between a baseline entry and a fresh digest. */
function compare(base, fresh) {
  const drifted = [];
  for (const bar of fresh.bars) {
    const was = base.bars.find((b) => b.bar === bar.bar);
    if (!was || was.hash !== bar.hash) drifted.push({ bar, was });
  }
  return drifted;
}

/** A one-line account of the first note that moved inside a drifted bar. */
function firstDifferingNote({ bar, was }) {
  if (!was) return `bar ${bar.bar} is not in the baseline at all`;
  const before = was.digest ? was.digest.split(';').filter(Boolean) : [];
  const after = bar.digest ? bar.digest.split(';').filter(Boolean) : [];
  const limit = Math.max(before.length, after.length);
  for (let i = 0; i < limit; i++) {
    if (before[i] === after[i]) continue;
    return `bar ${bar.bar} note ${i + 1}: ${describe(before[i])} → ${describe(after[i])}`;
  }
  return `bar ${bar.bar}: the notes are identical but the hash is not — a baseline written by `
    + 'a different digest version; regenerate with --update';
}

/** track:beat:midi:velocity:duration → prose. */
function describe(tuple) {
  if (!tuple) return 'nothing';
  const [track, beat, midi, velocity, duration] = tuple.split(':');
  return `${track} at beat ${beat}, midi ${midi}, vel ${velocity}, ${duration} beats`;
}

// --------------------------------------------------------------------------
// Run
// --------------------------------------------------------------------------

const started = Date.now();

// The engine consults the genre table to decide whether a params object's
// `genre` tag names a genre it ships; registered for the whole run so a
// compiled genre plays exactly as it does in the browser. Inert for presets,
// whose tag is null.
setGenreTable(GENRES);

const fresh = new Map();
let failures = 0;

await hiddenTab(async () => {
  for (const config of CONFIGS) {
    try {
      fresh.set(config.id, await digestConfig(config));
    } catch (error) {
      failures += 1;
      console.error(`ERROR ${config.id}\n      ${error.message}`);
    } finally {
      liveContexts.length = 0;
    }
  }
});

setGenreTable(null);

const version = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8')).version;

let baseline = null;
try {
  baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
} catch {
  baseline = null;
}

if (UPDATE) {
  if (failures) {
    console.error('\nrefusing to write a baseline while a config failed to play — fix that first');
    process.exit(1);
  }
  const next = {
    header: {
      generated: version,
      note: BASELINE_NOTE,
    },
    window: { firstBar: BAR_FROM, lastBar: BAR_TO - 1 },
    seeds: { play: PLAY_SEED, genreCompile: COMPILE_SEED },
    configs: Object.fromEntries([...fresh].map(([id, entry]) => [id, { bars: entry.bars }])),
  };

  // What moved, so an --update is never a silent rewrite.
  const oldConfigs = baseline?.configs ?? {};
  const added = [...fresh.keys()].filter((id) => !(id in oldConfigs));
  const removed = Object.keys(oldConfigs).filter((id) => !fresh.has(id));
  const changed = [...fresh].filter(([id, entry]) => oldConfigs[id]
    && compare(oldConfigs[id], entry).length);

  writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);

  console.log(`baseline written: ${CONFIGS.length} configs, bars ${BAR_FROM}–${BAR_TO - 1}, `
    + `generated ${version}`);
  if (!baseline) console.log('  (no previous baseline — everything is new)');
  for (const id of added) console.log(`  ADDED    ${id}`);
  for (const id of removed) console.log(`  REMOVED  ${id}`);
  for (const [id, entry] of changed) {
    const drifted = compare(oldConfigs[id], entry);
    console.log(`  CHANGED  ${id} — bars ${drifted.map((d) => d.bar.bar).join(', ')}`);
    console.log(`           ${firstDifferingNote(drifted[0])}`);
  }
  if (baseline && !added.length && !removed.length && !changed.length) {
    console.log('  no config changed — the baseline was already current');
  }
  console.log(`\n${((Date.now() - started) / 1000).toFixed(1)} s`);
  process.exit(0);
}

if (!baseline || !baseline.configs) {
  console.error('no baseline at tests/audio-reference-baseline.json — create it with:\n'
    + '  node tests/audio-reference.mjs --update');
  process.exit(1);
}

let drift = 0;
for (const [id, entry] of fresh) {
  const base = baseline.configs[id];
  if (!base) {
    drift += 1;
    console.log(`NEW   ${id.padEnd(26)} not in the baseline — regenerate with --update `
      + 'if this config is meant to exist');
    continue;
  }
  const drifted = compare(base, entry);
  if (!drifted.length) {
    console.log(`PASS  ${id.padEnd(26)} ${entry.bars.length} bars, ${entry.total} notes`);
    continue;
  }
  drift += 1;
  console.log(`DRIFT ${id.padEnd(26)} bars ${drifted.map((d) => d.bar.bar).join(', ')} differ`);
  console.log(`      ${firstDifferingNote(drifted[0])}`);
}

for (const id of Object.keys(baseline.configs)) {
  if (fresh.has(id)) continue;
  drift += 1;
  console.log(`GONE  ${id.padEnd(26)} in the baseline but no longer a shipped config`);
}

const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n${fresh.size - drift}/${CONFIGS.length} configs unchanged against baseline `
  + `${baseline.header?.generated ?? '(unversioned)'}${failures ? `, ${failures} failed to play` : ''}`
  + ` — ${seconds} s`);
if (drift || failures) {
  console.log('\nIf the sound change was deliberate, regenerate the baseline IN THE SAME COMMIT:\n'
    + '  node tests/audio-reference.mjs --update\n'
    + 'and say so in the commit message. If it was not, the finding is in your diff.');
}
process.exit(drift || failures ? 1 : 0);
