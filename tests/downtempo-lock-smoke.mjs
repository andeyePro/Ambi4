/**
 * v0.0.203 — Downtempo: the bass and the kit land as ONE rhythm section.
 * Run with:  node tests/downtempo-lock-smoke.mjs
 *
 * The owner's verdict: the bass is "fine until the drums enter, and they seem
 * to be clashing with each other". Nobody here can hear, so this suite plays
 * the compiled genre through the real engine (mock AudioContext, 'note'
 * events), takes every bass onset after the kick's first hit, and counts the
 * collisions against the kick (percussion lane `low`) and snare (`mid`):
 *
 *  - FLAM: a bass onset 12–60 ms from its nearest kick or snare hit. Two
 *    onsets that close are heard as one smeared hit, not two notes. The cause
 *    was the genre's own `pocketMs: [8, 22]` — a 9–21 ms lay-back behind every
 *    drum hit the line shares a step with. At v0.0.202 this was ~36% of the
 *    bass's notes (413 of 1146 over twelve seeds).
 *  - KICK DOUBLED: the share of kick steps the bass also plays. The line's
 *    groove is built once per section against ONE bar's kick, but the kit
 *    shuffles between its grooves every bar, and the three grooves had three
 *    different kick lanes, mostly off the pulse the bass locks to. At v0.0.202
 *    the bass was with 57% of the kicks.
 *  - BASS UNDER THE SNARE: a bass note on a snare step that carries no kick —
 *    the line competing with the backbeat. 24% of the bass's notes at
 *    v0.0.202; the genre's dense articulation menu kept the line busy on
 *    exactly the off-kick pulses the snare owns.
 *
 * Swing was ruled out: both the bass and the kit read the same global swing
 * (both lanes land at 0.57 for a 0.5 off-beat at swing 0.29), so it cannot be
 * applied to one and not the other.
 *
 * DOWNTEMPO_FILE=<path> points the suite at another copy of the genre — that
 * is how the red-proof against the v0.0.202 file is run.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// --------------------------------------------------------------------------
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

const FILE = process.env.DOWNTEMPO_FILE
  ? new URL(`file://${process.env.DOWNTEMPO_FILE}`)
  : new URL('../src/data/genres/downtempo.json', import.meta.url);
const genre = JSON.parse(readFileSync(FILE, 'utf8'));
const seededRng = (seed) => () => ((seed = (seed * 48271) % 2147483647) / 2147483647);

/** Seeds per Energy position, and how long each piece is driven. */
const SEEDS = 6;
const BARS = 22;
/** Two onsets closer than this fuse into one hit; the kit's own humanisation is ±7.5 ms. */
const FUSE = 0.012;
/** Beyond this they are two notes, whatever else they are. */
const FLAM_MAX = 0.06;

/** Undo the engine's eighth-pair swing, so an onset can be named by its sixteenth. */
function unswing(beat, swing) {
  const base = Math.floor(beat);
  const phase = beat - base;
  const split = 0.5 * (1 + swing * 0.5);
  return phase <= split
    ? base + phase * (0.5 / split)
    : base + 0.5 + (phase - split) * (0.5 / (1 - split));
}

async function play(seed, kitComplexity) {
  const params = compileGenre(genre, { rng: seededRng(seed * 101), kitComplexity });
  const engine = engineModule.createEngine(params, { rng: seededRng(seed * 7) });
  const notes = [];
  const bars = [];
  engine.on('note', (n) => notes.push(n));
  engine.on('bar', (b) => bars.push(b));
  await engine.start();
  const spb = 60 / (params.bpm * params.speed);
  const seconds = spb * 4 * BARS;
  for (let t = 0; t < seconds; t += 0.5) {
    for (const ctx of liveContexts) ctx.currentTime += 0.5;
    await new Promise((resolve) => setTimeout(resolve, 6));
  }
  engine.stop();
  liveContexts.length = 0;
  return { params, notes, bars, spb };
}

function measure({ params, notes, bars, spb }) {
  const lane = (name) => notes.filter((n) => n.track === 'percussion' && n.lane === name);
  const kick = lane('low');
  if (!kick.length) return null;
  const barT = bars.map((b) => b.time);
  const step = (t) => {
    const i = barT.findLastIndex((x) => x <= t + 0.03);
    return i < 0 ? null : { bar: i, at: Math.round(unswing((t - barT[i]) / spb, params.swing) * 4) };
  };
  const key = (s) => `${s.bar}:${s.at}`;
  const lastBar = barT.length - 2; // stop() cuts the final bar short
  const firstKick = kick[0].time - 1e-6;
  const inRange = (n) => n.time >= firstKick && step(n.time) && step(n.time).bar < lastBar;
  const K = kick.filter(inRange);
  const S = lane('mid').filter(inRange);
  const B = notes.filter((n) => n.track === 'bass').filter(inRange);
  const kickSteps = new Set(K.map((n) => key(step(n.time))));
  const snareSteps = new Set(S.map((n) => key(step(n.time))));
  const bassSteps = new Set(B.map((n) => key(step(n.time))));
  const drums = [...K, ...S];
  const out = { bass: B.length, kicks: kickSteps.size, kickWithBass: 0, flams: 0, underSnare: 0, examples: [] };
  for (const note of B) {
    const gap = drums.reduce((m, d) => Math.min(m, Math.abs(d.time - note.time)), Infinity);
    if (gap >= FUSE && gap < FLAM_MAX) {
      out.flams += 1;
      if (out.examples.length < 3) out.examples.push(`${(gap * 1000).toFixed(0)} ms`);
    }
    const k = key(step(note.time));
    if (snareSteps.has(k) && !kickSteps.has(k)) out.underSnare += 1;
  }
  for (const k of kickSteps) if (bassSteps.has(k)) out.kickWithBass += 1;
  return out;
}

globalThis.document = { hidden: true, addEventListener() {} };

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('v0.0.203 every Downtempo groove shares one kick lane (the bass groove locks to one bar of it per section)', () => {
  const lows = new Set(genre.fallbackLists.grooves.map((g) => g.low));
  assert.equal(lows.size, 1,
    `the kit shuffles bar by bar between ${lows.size} different kick lanes (${[...lows].join(', ')}), `
    + 'so a bass groove locked to one of them is wrong in the others');
  const pocket = genre.essence.grooveGrammar.pocketMs;
  assert.ok(pocket[1] < FUSE * 1000,
    `pocketMs ${JSON.stringify(pocket)} lays the bass up to ${pocket[1]} ms behind the kit — a flam`);
});

for (const kitComplexity of [undefined, 0.3, 0.9]) {
  test(`v0.0.203 Downtempo bass vs kit, Energy ${kitComplexity ?? 'default'}: no flams, kicks doubled${kitComplexity === undefined ? ', the snare left alone' : ''}`, async () => {
    const sum = { bass: 0, kicks: 0, kickWithBass: 0, flams: 0, underSnare: 0, examples: [] };
    for (let seed = 1; seed <= SEEDS; seed++) {
      const m = measure(await play(seed, kitComplexity));
      if (!m) continue;
      for (const k of ['bass', 'kicks', 'kickWithBass', 'flams', 'underSnare']) sum[k] += m[k];
      if (m.examples.length) sum.examples.push(`seed ${seed}: ${m.examples.join(', ')}`);
    }
    const pct = (a, b) => `${((100 * a) / b).toFixed(0)}%`;
    console.log(`     ${sum.bass} bass notes, ${sum.kicks} kicks: flams ${sum.flams}, `
      + `kicks doubled ${pct(sum.kickWithBass, sum.kicks)}, under the snare ${pct(sum.underSnare, sum.bass)}`);
    assert.ok(sum.bass > 100 && sum.kicks > 50, `too little played to judge (${sum.bass} bass, ${sum.kicks} kicks)`);
    assert.equal(sum.flams, 0,
      `${sum.flams} of ${sum.bass} bass notes flam a kick or snare hit (${sum.examples.slice(0, 3).join('; ')})`);
    assert.ok(sum.kickWithBass / sum.kicks >= 0.65,
      `the bass doubles only ${pct(sum.kickWithBass, sum.kicks)} of the kicks`);
    // The snare share is held at the genre's own Energy only. Low Energy thins
    // the kit (fewer kicks to stand on) and high Energy adds the fill bar, whose
    // snare run meets the bass's own turnaround — that is a fill answering a
    // fill, not the line fighting the backbeat. Both are reported above.
    if (kitComplexity === undefined) {
      assert.ok(sum.underSnare / sum.bass <= 0.2,
        `${pct(sum.underSnare, sum.bass)} of the bass's notes sit under a kickless snare hit`);
    }
  });
}

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
