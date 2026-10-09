/**
 * The arp FOLDS into its range; it never caps. Run with:
 *
 *   npm run build && node tests/arp-range-smoke.mjs
 *
 * At high Complexity the auto arp walks three octaves of its chord, a step can
 * wander an octave, and from 0.85 every note gains a doubling an octave up.
 * The top of that reaches past MIDI 96, the arp's ceiling. Up to v0.0.220 the
 * ceiling was a clamp, so every note above it LANDED ON 96 — the same pitch
 * whatever the chord: measured in Bossa, the tonic C sounded over every V7, an
 * eleventh against the chord. The melody has always folded by octaves instead
 * ("clamping would land the note on the band edge, which is not necessarily a
 * note of the scale"); the arp now does the same, and a doubled octave that
 * folds onto its own note is dropped rather than struck twice.
 *
 * Measured here over every stock genre, several compile and play seeds, at
 * Complexity 0.95 with the arp forced on in auto:
 *
 *   - every arp note sits inside 36…96;
 *   - every arp note's PITCH CLASS belongs to its chord — the chord the engine
 *     published for that bar, plus the pitch classes the arp itself played
 *     below the top octaves under the same chord (the arp voices up to four
 *     chord tones where the published pad voicing may carry three);
 *   - no note is struck twice at the same instant at the same pitch.
 *
 * Red on the v0.0.220 engine: notes pile onto 96 with a pitch class foreign
 * to the chord under them.
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

const ARP_LOW = 36;
const ARP_HIGH = 96;
/** Below this the arp is playing its figure's own register, never a fold. */
const FIGURE_TOP = 84;
const BARS = 14;
const COMPLEXITY = 0.95;
const COMPILE_SEEDS = [4242, 17, 9001];
const PLAY_SEEDS = [20260728, 31337];

const dir = new URL('../src/data/genres/', import.meta.url);
const GENRES = readdirSync(dir).filter((n) => n.endsWith('.json')).sort()
  .map((n) => JSON.parse(readFileSync(new URL(n, dir), 'utf8')));
assert.ok(GENRES.length >= 12, `only ${GENRES.length} genre files`);

const pc = (midi) => ((Math.round(midi) % 12) + 12) % 12;

async function playOne(genre, compileSeed, playSeed) {
  const compiled = compileGenre(genre, { rng: seededRng(compileSeed) });
  const params = {
    ...compiled,
    complexity: COMPLEXITY,
    arp: { ...compiled.arp, mode: 'auto' },
    tracks: { ...compiled.tracks, arp: { ...compiled.tracks.arp, state: 'on' } },
  };
  const engine = engineModule.createEngine(params, { rng: seededRng(playSeed) });
  const chords = [];
  const arp = [];
  let bars = 0;
  engine.on('chord', (c) => chords.push(c));
  engine.on('bar', () => { bars += 1; });
  engine.on('note', (n) => { if (n.track === 'arp' && !n.live) arp.push(n); });
  try {
    await engine.start();
    await advanceUntil(() => bars >= BARS, 600);
  } finally {
    engine.stop();
    liveContexts.length = 0;
  }
  return { chords: chords.sort((a, b) => a.time - b.time), arp, bars };
}

/** Index of the chord in force at `time` (small humanising nudges allowed). */
function chordAt(chords, time) {
  let at = -1;
  for (let i = 0; i < chords.length; i++) {
    if (chords[i].time <= time + 0.06) at = i; else break;
  }
  return at;
}

const KEYS = ['notes', 'atCap', 'foreign', 'foreignAtCap', 'outOfRange', 'struckTwice'];
const totals = Object.fromEntries(KEYS.map((k) => [k, 0]));
const examples = [];

setGenreTable(GENRES);
await hiddenTab(async () => {
  for (const genre of GENRES) {
    const per = Object.fromEntries(KEYS.map((k) => [k, 0]));
    for (const compileSeed of COMPILE_SEEDS) {
      for (const playSeed of PLAY_SEEDS) {
        const { chords, arp, bars } = await playOne(genre, compileSeed, playSeed);
        assert.ok(bars >= BARS, `${genre.slug}: only ${bars} bars played`);
        assert.ok(arp.length > 0, `${genre.slug} ${compileSeed}/${playSeed}: the arp played nothing`);
        // The figure's own pitch classes, per chord: the chord as published,
        // plus the low notes the arp played while that chord was in force.
        const allowed = chords.map((c) => new Set(c.midis.map(pc)));
        for (const note of arp) {
          const i = chordAt(chords, note.time);
          if (i >= 0 && note.midi < FIGURE_TOP) allowed[i].add(pc(note.midi));
        }
        const seen = new Set();
        for (const note of arp) {
          per.notes += 1;
          if (note.midi < ARP_LOW || note.midi > ARP_HIGH) per.outOfRange += 1;
          if (note.midi === ARP_HIGH) per.atCap += 1;
          const key = `${note.time.toFixed(6)}:${note.midi}`;
          if (seen.has(key)) per.struckTwice += 1;
          seen.add(key);
          const i = chordAt(chords, note.time);
          if (i < 0) continue;
          // A phase copy pushed past the barline is the previous chord's note.
          const ok = allowed[i].has(pc(note.midi))
            || (note.phase === true && i > 0 && allowed[i - 1].has(pc(note.midi)));
          if (ok) continue;
          per.foreign += 1;
          if (note.midi === ARP_HIGH) per.foreignAtCap += 1;
          if (examples.length < 6) {
            examples.push(`${genre.slug} ${compileSeed}/${playSeed}: midi ${note.midi} over `
              + `${chords[i].name} (chord pcs ${[...allowed[i]].sort((a, b) => a - b).join(',')})`);
          }
        }
      }
    }
    for (const k of KEYS) totals[k] += per[k];
    console.log(`  ${genre.slug.padEnd(14)} arp notes ${String(per.notes).padStart(5)}`
      + `  at 96 ${String(per.atCap).padStart(4)}`
      + `  foreign ${String(per.foreign).padStart(4)} (at 96: ${per.foreignAtCap})`
      + `  out of range ${per.outOfRange}  struck twice ${per.struckTwice}`);
  }
});
setGenreTable(null);

console.log(`  TOTAL          arp notes ${totals.notes}  at 96 ${totals.atCap}  foreign ${totals.foreign}`
  + ` (at 96: ${totals.foreignAtCap})  out of range ${totals.outOfRange}  struck twice ${totals.struckTwice}`);
for (const line of examples) console.log(`     e.g. ${line}`);

let red = 0;
const check = (ok, name) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) red += 1;
};
check(totals.notes > 1000, `the arp played enough to measure (${totals.notes} notes)`);
check(totals.outOfRange === 0, 'every arp note sits inside 36…96');
check(totals.foreign === 0, 'every arp note’s pitch class belongs to its chord: nothing piles onto the cap');
check(totals.struckTwice === 0, 'no arp pitch is struck twice at one instant (a fold never doubles a note)');
process.exit(red ? 1 : 0);
