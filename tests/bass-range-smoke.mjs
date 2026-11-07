/**
 * The bass stays inside its documented register. Run with:
 *
 *   npm run build && node tests/bass-range-smoke.mjs
 *
 * BASS_RANGE is MIDI 28–55 (E1–G3; docs/engine-v2-contract.md, Register). Up
 * to v0.0.311 the line placed its chord root at octave 2 WITHOUT folding and
 * its fifth was always root + 7, so a high degree in a high key — the key of B
 * worst — reached past G3: about 4–6 % of bass notes across the stock genres,
 * up to MIDI 64 (proto/bass-in-range). The root now folds into the range and
 * the fifth drops a fourth below the root when root + 7 would leave it.
 *
 * Measured here: every stock genre (src/data/genres) × all twelve roots, the
 * bass forced on, twelve bars each — every generated bass note inside 28…55.
 * A grid note with a pinned pitch would be exempt (a stated pitch plays as
 * stated); no stock genre pins one, so none is set aside here.
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
const { setGenreTable } = engineModule;

const seededRng = (seed) => () => ((seed = (seed * 48271) % 2147483647) / 2147483647);

async function hiddenTab(fn) {
  globalThis.document = { hidden: true, addEventListener() {} };
  try { return await fn(); } finally { delete globalThis.document; }
}

async function advanceUntil(ready, seconds, { step = 0.5, sleep = 4 } = {}) {
  const steps = Math.ceil(seconds / step);
  for (let i = 0; i < steps; i++) {
    if (ready()) return true;
    for (const ctx of liveContexts) ctx.currentTime += step;
    await new Promise((resolve) => setTimeout(resolve, sleep));
  }
  return ready();
}


const BASS_LOW = 28;
const BASS_HIGH = 55;
const BARS = 12;
const ROOTS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const dir = new URL('../src/data/genres/', import.meta.url);
const GENRES = readdirSync(dir).filter((n) => n.endsWith('.json')).sort()
  .map((n) => JSON.parse(readFileSync(new URL(n, dir), 'utf8')));
assert.ok(GENRES.length >= 12, `only ${GENRES.length} genre files`);

async function playOne(genre, root, seed) {
  const compiled = compileGenre(genre, { rng: seededRng(seed) });
  const params = {
    ...compiled,
    root,
    tracks: { ...compiled.tracks, bass: { ...compiled.tracks.bass, state: 'on' } },
  };
  const engine = engineModule.createEngine(params, { rng: seededRng(seed + 1) });
  const bass = [];
  let bars = 0;
  engine.on('bar', () => { bars += 1; });
  engine.on('note', (n) => { if (n.track === 'bass' && !n.live) bass.push(n); });
  try {
    await engine.start();
    await advanceUntil(() => bars >= BARS, 600);
  } finally {
    engine.stop();
    liveContexts.length = 0;
  }
  return { bass, bars };
}

let notes = 0;
let out = 0;
const examples = [];
setGenreTable(GENRES);
await hiddenTab(async () => {
  for (const genre of GENRES) {
    let perNotes = 0;
    let perOut = 0;
    for (const [i, root] of ROOTS.entries()) {
      const { bass, bars } = await playOne(genre, root, 4242 + i);
      assert.ok(bars >= BARS, `${genre.slug} in ${root}: only ${bars} bars played`);
      for (const note of bass) {
        perNotes += 1;
        if (note.midi < BASS_LOW || note.midi > BASS_HIGH) {
          perOut += 1;
          if (examples.length < 8) examples.push(`${genre.slug} in ${root}: midi ${note.midi} (${note.source})`);
        }
      }
    }
    notes += perNotes;
    out += perOut;
    console.log(`  ${genre.slug.padEnd(14)} bass notes ${String(perNotes).padStart(5)}  out of range ${perOut}`);
  }
});
setGenreTable(null);
console.log(`  TOTAL          bass notes ${notes}  out of range ${out}`);
for (const line of examples) console.log(`     e.g. ${line}`);

let red = 0;
const check = (ok, name) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) red += 1;
};
check(notes > 1000, `the bass played enough to measure (${notes} notes)`);
check(out === 0, `every bass note sits inside ${BASS_LOW}…${BASS_HIGH} (E1–G3)`);
process.exit(red ? 1 : 0);
