/**
 * v0.0.222 — Deep House and Lofi Beats: the melody each genre deserves.
 * Run with:  node tests/house-lofi-melody-smoke.mjs
 *
 * The owner's verdicts: Deep House — "bass and other tracks seem fine, just
 * let down by an annoying melody"; Lofi Beats — "also has a bad melody".
 * Nobody here can hear, so this suite plays each compiled genre through the
 * real engine (mock AudioContext, 'note' and 'chord' events) over twelve
 * seeds and measures the line the way a player would describe it:
 *
 *  - notes per bar, and the share of bars the melody sits out entirely;
 *  - SOUNDING: the share of the time a melody note is ringing (a mono note
 *    counts until the next onset). A line that never stops is a drone with
 *    pitches in it, not a part;
 *  - the median note length in beats, and the share of onsets less than half a
 *    beat after the one before (busy quaver runs);
 *  - the share of onsets off the beat;
 *  - the share of strong-beat notes (beats 1 and 3) that are not a tone of the
 *    chord under them;
 *  - how late a note near a beat lands (median, ms) — lofi's lazy pocket.
 *
 * What both genres played at v0.0.217, twelve seeds × 32 bars:
 *
 *  Deep House  3.4 notes a bar in 90% of bars, SOUNDING 79% of the time,
 *              median note a full beat, on the `stab` voice — a drawbar organ
 *              that sustains for the note's whole length and slurs (mono,
 *              glide) into the next: a held, sliding organ line over the
 *              whole vamp. Deep house's lead is the opposite — short chord
 *              stabs off the beat with long gaps between.
 *  Lofi Beats  4.5 notes a bar in 94% of bars, median note HALF a beat, 35%
 *              of onsets a quaver or less after the last — a busy noodle.
 *              Lofi's line is lazy: two or three long notes, behind the beat,
 *              lots of air.
 *
 * Both came from the same place: neither genre said anything about its
 * melody, so the engine built every cell from the genre's Complexity — high
 * for both, because their chords are ninths — which draws the busiest cells
 * it has (five notes, quaver gaps) and plays a development of it every bar.
 *
 * The fix is genre DATA (v0.0.222): each genre writes its own opening cells
 * (`fallbackLists.motifs`, one drawn per compile the way the kit's grooves
 * are its own), holds the cell for the piece (`motifRule.chance` 0) with a
 * development pool of the idiom's own moves, and thins the melody's share of
 * the density bias (`perTrack.melody.densityScale`) so it sits bars out. The
 * suite also proves the change reaches nothing but the melody: every other
 * compiled param is the one the genre compiled to without the new fields.
 *
 * MELODY_GENRE_DIR=<dir> points the playback checks at another copy of the
 * two genre files — that is how the red proof against v0.0.217 is run.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// --------------------------------------------------------------------------
// Minimal AudioContext mock — the same thin shape downtempo-lock-smoke.mjs
// uses: this suite reads 'note', 'bar' and 'chord' events only.
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
globalThis.document = { hidden: true, addEventListener() {} };

const engineModule = await import('../src/scripts/ambient-engine.js');
const { compileGenre } = await import('../src/scripts/genre-compiler.js');

const DIR = process.env.MELODY_GENRE_DIR
  ? new URL(`file://${process.env.MELODY_GENRE_DIR.replace(/\/?$/, '/')}`)
  : new URL('../src/data/genres/', import.meta.url);
const load = (slug) => JSON.parse(readFileSync(new URL(`${slug}.json`, DIR), 'utf8'));
const seededRng = (seed) => () => ((seed = (seed * 48271) % 2147483647) / 2147483647);

const SEEDS = 12;
const BARS = 32;

async function play(genre, seed) {
  const params = compileGenre(genre, { rng: seededRng(seed * 101) });
  const engine = engineModule.createEngine(params, { rng: seededRng(seed * 7) });
  const notes = [];
  const bars = [];
  const chords = [];
  engine.on('note', (n) => notes.push(n));
  engine.on('bar', (b) => bars.push(b));
  engine.on('chord', (c) => chords.push(c));
  await engine.start();
  const spb = 60 / (params.bpm * (params.speed || 1));
  const seconds = spb * 4 * BARS;
  for (let t = 0; t < seconds; t += 0.5) {
    for (const ctx of liveContexts) ctx.currentTime += 0.5;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  engine.stop();
  liveContexts.length = 0;
  return { params, notes, bars, chords, spb };
}

/** One piece's melody, measured from its first note to the last whole bar. */
function measure({ params, notes, bars, chords, spb }) {
  const out = {
    bars: 0, notes: 0, restBars: 0, sounding: 0, seconds: 0, short: 0, offbeat: 0,
    strong: 0, strongOff: 0, durations: [], midis: [], padMidis: [], lags: [], cell: null,
  };
  out.cell = params.tracks.melody.motif ? JSON.stringify(params.tracks.melody.motif) : null;
  const melody = notes.filter((n) => n.track === 'melody').sort((a, b) => a.time - b.time);
  if (!melody.length) return out;
  const barT = bars.map((b) => b.time);
  const lastBar = barT.length - 2; // stop() cuts the final bar short
  const where = (t) => {
    const i = barT.findLastIndex((x) => x <= t + 0.03);
    return i < 0 ? null : { bar: i, beat: (t - barT[i]) / spb };
  };
  const first = where(melody[0].time).bar;
  const line = melody.filter((n) => {
    const w = where(n.time);
    return w && w.bar >= first && w.bar < lastBar;
  });
  out.bars = lastBar - first;
  out.seconds = out.bars * (barT[1] - barT[0]);
  out.notes = line.length;
  const sounded = new Set(line.map((n) => where(n.time).bar));
  out.restBars = out.bars - sounded.size;
  out.padMidis = notes.filter((n) => n.track === 'pad').map((n) => n.midi);
  for (let i = 0; i < line.length; i++) {
    const note = line[i];
    const next = line[i + 1];
    const { beat } = where(note.time);
    out.midis.push(note.midi);
    out.durations.push(note.duration / spb);
    out.sounding += next ? Math.min(note.duration, next.time - note.time) : note.duration;
    if (next && (next.time - note.time) / spb <= 0.55) out.short += 1;
    if (Math.abs(beat - Math.round(beat)) > 0.15) out.offbeat += 1;
    else out.lags.push((beat - Math.round(beat)) * spb * 1000);
    if (Math.abs(beat) < 0.15 || Math.abs(beat - 2) < 0.15) {
      const chord = chords.filter((c) => c.time <= note.time + 0.03).pop();
      if (chord) {
        out.strong += 1;
        if (!chord.midis.some((m) => (m - note.midi) % 12 === 0)) out.strongOff += 1;
      }
    }
  }
  return out;
}

const median = (list) => {
  const sorted = [...list].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN;
};

async function survey(slug) {
  const genre = load(slug);
  const sum = {
    bars: 0, notes: 0, restBars: 0, sounding: 0, seconds: 0, short: 0, offbeat: 0,
    strong: 0, strongOff: 0, durations: [], midis: [], padMidis: [], lags: [], cells: new Set(),
  };
  for (let seed = 1; seed <= SEEDS; seed++) {
    const m = measure(await play(genre, seed));
    for (const k of ['bars', 'notes', 'restBars', 'sounding', 'seconds', 'short', 'offbeat', 'strong', 'strongOff']) sum[k] += m[k];
    for (const k of ['durations', 'midis', 'padMidis', 'lags']) sum[k].push(...m[k]);
    if (m.cell) sum.cells.add(m.cell);
  }
  const s = {
    perBar: sum.notes / sum.bars,
    rest: sum.restBars / sum.bars,
    sounding: sum.sounding / sum.seconds,
    duration: median(sum.durations),
    short: sum.short / sum.notes,
    offbeat: sum.offbeat / sum.notes,
    strongOff: sum.strongOff / sum.strong,
    melodyMedian: median(sum.midis),
    padMedian: median(sum.padMidis),
    lag: median(sum.lags),
    cells: sum.cells.size,
    notes: sum.notes,
    bars: sum.bars,
  };
  const pct = (x) => `${(100 * x).toFixed(0)}%`;
  console.log(`     ${slug}: ${s.notes} notes over ${s.bars} bars — ${s.perBar.toFixed(2)} a bar, `
    + `rests ${pct(s.rest)} of bars, sounding ${pct(s.sounding)}, median note ${s.duration.toFixed(2)} beats, `
    + `quaver runs ${pct(s.short)}, off the beat ${pct(s.offbeat)}, strong-beat non-chord ${pct(s.strongOff)}, `
    + `register ${s.melodyMedian} over a pad at ${s.padMedian}, on-beat notes land ${s.lag.toFixed(0)} ms late (median), ${s.cells} opening cells named`);
  return s;
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const results = {};

test('Deep House: offbeat stabs with air between them, not a held organ line', async () => {
  const s = results['deep-house'] = await survey('deep-house');
  assert.ok(s.notes > 150, `too little played to judge (${s.notes} notes)`);
  assert.ok(s.perBar <= 2.2, `${s.perBar.toFixed(2)} notes a bar — a stab part plays two or so`);
  assert.ok(s.sounding <= 0.35, `the melody rings ${(100 * s.sounding).toFixed(0)}% of the time — a held line, not stabs`);
  assert.ok(s.duration <= 0.6, `median note ${s.duration.toFixed(2)} beats — a stab is short`);
  assert.ok(s.offbeat >= 0.75, `only ${(100 * s.offbeat).toFixed(0)}% of onsets are off the beat`);
  assert.ok(s.rest >= 0.2, `the melody sits out only ${(100 * s.rest).toFixed(0)}% of bars`);
  assert.ok(s.strongOff <= 0.12, `${(100 * s.strongOff).toFixed(0)}% of strong-beat notes are off the chord`);
  assert.ok(s.cells >= 4, `only ${s.cells} distinct opening cells across ${SEEDS} seeds`);
});

test('Lofi Beats: a lazy line — few, long, mostly chord tones, with room around it', async () => {
  const s = results['lofi-beats'] = await survey('lofi-beats');
  assert.ok(s.notes > 150, `too little played to judge (${s.notes} notes)`);
  assert.ok(s.perBar <= 3, `${s.perBar.toFixed(2)} notes a bar — a lazy line plays two or three`);
  assert.ok(s.duration >= 1, `median note ${s.duration.toFixed(2)} beats — the line is a run of quavers`);
  assert.ok(s.short <= 0.25, `${(100 * s.short).toFixed(0)}% of onsets follow the last by a quaver or less`);
  assert.ok(s.rest >= 0.2, `the melody sits out only ${(100 * s.rest).toFixed(0)}% of bars`);
  assert.ok(s.strongOff <= 0.12, `${(100 * s.strongOff).toFixed(0)}% of strong-beat notes are off the chord`);
  // Behind the beat: the genre's cells sit a few hundredths of a beat late,
  // the melody's half of the lay-back pocketMs gives the bass.
  assert.ok(s.lag >= 15 && s.lag <= 60, `on-beat notes land ${s.lag.toFixed(0)} ms from the beat — lazy is 15–60 ms late`);
  assert.ok(s.melodyMedian > s.padMedian && s.melodyMedian <= s.padMedian + 12,
    `the line's median ${s.melodyMedian} should sit within an octave above the pad's ${s.padMedian}`);
  assert.ok(s.cells >= 4, `only ${s.cells} distinct opening cells across ${SEEDS} seeds`);
});

// The change reaches the melody and nothing else: compiled without the three
// new fields, each genre is the params it compiles to with them, melody aside.
// Read from the repo's own files, not MELODY_GENRE_DIR — this is the compiler's
// contract, not a measurement.
test('the new fields move the melody only — the bass and every other param compile as before', () => {
  for (const slug of ['deep-house', 'lofi-beats']) {
    const genre = JSON.parse(readFileSync(new URL(`../src/data/genres/${slug}.json`, import.meta.url), 'utf8'));
    const stripped = JSON.parse(JSON.stringify(genre));
    delete stripped.fallbackLists.motifs;
    const melodySpec = stripped.essence.instrumentation.perTrack.melody;
    delete melodySpec.densityScale;
    delete melodySpec.motifRule;
    assert.ok(Array.isArray(genre.fallbackLists.motifs) && genre.fallbackLists.motifs.length >= 4,
      `${slug} writes its own opening cells`);
    for (let seed = 1; seed <= SEEDS; seed++) {
      const withFields = compileGenre(genre, { rng: seededRng(seed * 101) });
      const without = compileGenre(stripped, { rng: seededRng(seed * 101) });
      assert.notDeepEqual(withFields.tracks.melody, without.tracks.melody, `${slug}: the melody moved`);
      delete withFields.tracks.melody;
      delete without.tracks.melody;
      assert.deepEqual(withFields, without, `${slug} seed ${seed}: something besides the melody moved`);
    }
  }
});

test('densityScale is the track\'s share of the bias; a genre without the new fields compiles as it did', () => {
  const genre = JSON.parse(readFileSync(new URL('../src/data/genres/deep-house.json', import.meta.url), 'utf8'));
  const params = compileGenre(genre, { rng: seededRng(5) });
  const bias = genre.essence.densityBias;
  assert.equal(params.tracks.melody.density, bias * genre.essence.instrumentation.perTrack.melody.densityScale);
  assert.equal(params.tracks.melody.motifRule.chance, 0, 'the drawn cell holds for the piece');
  assert.ok(genre.fallbackLists.motifs.some((cell) => JSON.stringify(cell.beats) === JSON.stringify(params.tracks.melody.motif.beats)),
    'the opening cell is one of the genre\'s own');
  // A person's Now (perTrack.melody.motif) wins over the genre's list.
  const mine = { steps: [0, 2], beats: [0, 2], lengths: [1, 1], shape: 'own' };
  const ruled = JSON.parse(JSON.stringify(genre));
  ruled.essence.instrumentation.perTrack.melody.motif = mine;
  assert.deepEqual(compileGenre(ruled, { rng: seededRng(5) }).tracks.melody.motif.beats, mine.beats);
  const ambient = JSON.parse(readFileSync(new URL('../src/data/genres/ambient.json', import.meta.url), 'utf8'));
  const plain = compileGenre(ambient, { rng: seededRng(5) });
  assert.equal(plain.tracks.melody.motif, undefined, 'no list, no cell');
  assert.equal(plain.tracks.melody.density, ambient.essence.densityBias, 'no scale, the bias as before');
});

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
