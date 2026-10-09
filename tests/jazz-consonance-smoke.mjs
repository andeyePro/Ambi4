/**
 * Acid Jazz and Bossa: the harmony stops clashing.
 * Run with:  node tests/jazz-consonance-smoke.mjs
 * Survey:    node tests/jazz-consonance-smoke.mjs --report acid-jazz bossa synthwave deep-house
 *            (VERBOSE=1 adds the modes drawn, the chords sounded and the commonest
 *            clashes named by chord degree, e.g. "X7  pad:3 < melody:11")
 *
 * The owner's verdicts: "Acid Jazz is dissonant throughout — all of it", and
 * Bossa "dissonant, same shape of problem". Nobody here can hear, so this suite
 * plays each genre through the real engine (mock AudioContext, 'note' and
 * 'chord' events) over twelve seeds and counts what dissonance IS:
 *
 *  - b9/bar: pairs of notes on DIFFERENT tracks sounding at once where the
 *    upper note is a semitone above the lower one's pitch class — a minor
 *    second, minor ninth or wider. A major seventh (the other direction) is
 *    the maj7 chord's own colour and is not counted.
 *  - foreign/bar: those of them where at least one note is not a tone of the
 *    chord the pad is voicing — the avoid-note clashes, as opposed to a maj7
 *    chord's root sounding over its own seventh.
 *  - tritones against the bass, the arp notes clamped at the engine's pitch
 *    ceiling, and the melody's chord-tone share.
 *
 * At v0.0.217 Acid Jazz measured 4.10 clashes per bar and Bossa 2.09, against
 * Synthwave's 0.76 (a genre he hears as fine; Deep House 1.10, Downtempo 0.92).
 * The melody was NOT the difference — its chord-tone share (61–65%) was the
 * same as Synthwave's (55%). The causes, all in the genre data:
 *
 *  1. Modes the grammar was not written for. Chord numerals are mode-relative,
 *     so "ii7 V13 Imaj9" is a ii–V–I only in ionian; Bossa also drew dorian,
 *     lydian and aeolian, and Acid Jazz mixolydian and aeolian. The diatonic
 *     ninth-stack then lands a minor ninth over the root (dorian ii, aeolian ii
 *     and v, ionian iii) and an 11 over a major third (mixolydian's i7).
 *  2. Acid Jazz's texture was the wash — whose pitch is a RANDOM scale degree,
 *     not a chord tone: 2.32 of its 4.10 clashes per bar.
 *  3. Bossa's extensionBias 0.9 compiled to complexity ~0.85, which gives the
 *     auto arp three octaves plus an octave doubling, and the engine CLAMPS the
 *     arp at midi 96 instead of folding it: 106 arp notes in twelve pieces were
 *     the tonic C7 whatever the chord (the 11 over every V7).
 *
 * GENRE_FILE overrides (ACID_JAZZ_FILE, BOSSA_FILE) point the suite at another
 * copy of a genre — that is how the red-proof against v0.0.217 is run.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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
globalThis.document = { hidden: true, addEventListener() {} };

const genreFile = (slug) => {
  const env = process.env[`${slug.toUpperCase().replace(/-/g, '_')}_FILE`];
  return env ? new URL(`file://${env}`) : new URL(`../src/data/genres/${slug}.json`, import.meta.url);
};
const loadGenre = (slug) => JSON.parse(readFileSync(genreFile(slug), 'utf8'));
const seededRng = (seed) => () => ((seed = (seed * 48271) % 2147483647) / 2147483647);

const SEEDS = Number(process.env.CONSONANCE_SEEDS) || 12;
const BARS = 24;
const TUNED = ['pad', 'melody', 'bass', 'arp', 'texture'];
/** The arp's pitch clamp in ambient-engine.js (schedulePulse): a note above it is SET to it. */
const ARP_CEILING = 96;

async function play(genre, seed) {
  const params = compileGenre(genre, { rng: seededRng(seed * 101) });
  const engine = engineModule.createEngine(params, { rng: seededRng(seed * 7) });
  const notes = [];
  const chords = [];
  engine.on('note', (n) => { if (TUNED.includes(n.track) && Number.isFinite(n.midi)) notes.push(n); });
  engine.on('chord', (c) => chords.push(c));
  await engine.start();
  const seconds = (60 / (params.bpm * params.speed)) * 4 * BARS;
  for (let t = 0; t < seconds; t += 0.5) {
    for (const ctx of liveContexts) ctx.currentTime += 0.5;
    await new Promise((resolve) => setTimeout(resolve, 4));
  }
  engine.stop();
  liveContexts.length = 0;
  return { params, notes, chords };
}

const ROOTS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const DEG = ['1', 'b9', '9', 'b3', '3', '11', '#11', '5', 'b13', '13', 'b7', '7'];
const pc = (m) => ((Math.round(m) % 12) + 12) % 12;

/**
 * Upper-over-lower interval class of two simultaneous pitches: 'b9' when the
 * upper note is a semitone above the lower one's pitch class (a minor second,
 * minor ninth or wider — the interval jazz harmony calls an avoid note), 'tt'
 * for a tritone. A major seventh (the lower note a semitone ABOVE the upper's
 * class) is the maj7 chord's own colour and is NOT counted.
 */
function clashOf(a, b) {
  const [lo, hi] = a.midi <= b.midi ? [a, b] : [b, a];
  const d = pc(hi.midi - lo.midi);
  return d === 1 && hi.midi !== lo.midi ? 'b9' : d === 6 ? 'tt' : null;
}

export function measure({ notes, chords }) {
  const out = {
    bars: 0, chords: 0, padB9: 0, notes: 0, inChord: 0, avoid: 0,
    b9: { 'melody|pad': 0, 'bass|pad': 0, 'arp|pad': 0, 'bass|melody': 0, other: 0, total: 0 },
    ttBass: 0, foreignB9: 0, ceiling: 0, names: new Map(), pairs: {}, examples: {},
  };
  if (chords.length < 3) return out;
  const start = chords[0].time;
  const end = chords[chords.length - 1].time; // the last bar is cut short by stop()
  out.bars = chords.length - 1;
  const chordAt = (t) => {
    let c = null;
    for (const ch of chords) { if (ch.time <= t + 0.02) c = ch; else break; }
    return c;
  };
  for (const ch of chords.slice(0, -1)) {
    out.chords += 1;
    out.names.set(ch.name, (out.names.get(ch.name) ?? 0) + 1);
    for (let i = 0; i < ch.midis.length; i++) {
      for (let j = i + 1; j < ch.midis.length; j++) {
        if (clashOf({ midi: ch.midis[i] }, { midi: ch.midis[j] }) === 'b9') out.padB9 += 1;
      }
    }
  }
  const live = notes.filter((n) => n.time >= start - 0.05 && n.time < end);
  for (const n of live) {
    const ch = chordAt(n.time);
    if (!ch) continue;
    const set = new Set(ch.midis.map(pc));
    if (n.track === 'arp' && n.midi >= ARP_CEILING && !set.has(pc(n.midi))) out.ceiling += 1;
    if (n.track !== 'melody') continue;
    out.notes += 1;
    const p = pc(n.midi);
    if (set.has(p)) out.inChord += 1;
    else if (set.has(pc(p - 1))) out.avoid += 1;
  }
  const sorted = live.slice().sort((a, b) => a.time - b.time);
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    const aEnd = a.time + a.duration;
    for (let j = i + 1; j < sorted.length && sorted[j].time < aEnd - 0.01; j++) {
      const b = sorted[j];
      if (a.track === b.track) continue;
      if (b.time + b.duration <= a.time + 0.01) continue;
      const kind = clashOf(a, b);
      if (!kind) continue;
      const pair = [a.track, b.track].sort().join('|');
      if (kind === 'b9') {
        const at = chordAt(Math.max(a.time, b.time));
        const tones = at ? new Set(at.midis.map(pc)) : new Set();
        if (!tones.has(pc(a.midi)) || !tones.has(pc(b.midi))) out.foreignB9 += 1;
        out.b9.total += 1;
        out.b9[pair in out.b9 ? pair : 'other'] += 1;
        out.pairs[pair] = (out.pairs[pair] ?? 0) + 1;
        if (process.env.VERBOSE) {
          const ch = chordAt(Math.max(a.time, b.time));
          const root = ch ? pc(ROOTS.indexOf(ch.name.replace(/^([A-G]#?).*$/, '$1'))) : 0;
          const [lo, hi] = a.midi <= b.midi ? [a, b] : [b, a];
          const deg = (m) => DEG[pc(m - root)];
          const key = `${ch ? ch.name.replace(/^[A-G]#?/, 'X') : '?'}  ${lo.track}:${deg(lo.midi)} < ${hi.track}:${deg(hi.midi)}`;
          out.examples[key] = (out.examples[key] ?? 0) + 1;
        }
      } else if (pair.includes('bass')) out.ttBass += 1;
    }
  }
  return out;
}

export async function survey(genre, seeds = SEEDS) {
  const sum = {
    bars: 0, chords: 0, padB9: 0, notes: 0, inChord: 0, avoid: 0, ttBass: 0, foreignB9: 0, ceiling: 0,
    b9: { 'melody|pad': 0, 'bass|pad': 0, 'arp|pad': 0, 'bass|melody': 0, other: 0, total: 0 },
    names: new Map(), modes: new Map(), pairs: {}, examples: {},
  };
  for (let seed = 1; seed <= seeds; seed++) {
    const run = await play(genre, seed);
    const m = measure(run);
    sum.complexity = (sum.complexity ?? 0) + run.params.complexity / seeds;
    sum.modes.set(run.params.mode, (sum.modes.get(run.params.mode) ?? 0) + 1);
    for (const k of ['bars', 'chords', 'padB9', 'notes', 'inChord', 'avoid', 'ttBass', 'foreignB9', 'ceiling']) sum[k] += m[k];
    for (const k of Object.keys(sum.b9)) sum.b9[k] += m.b9[k];
    for (const [k, v] of Object.entries(m.examples)) sum.examples[k] = (sum.examples[k] ?? 0) + v;
    for (const [k, v] of Object.entries(m.pairs)) sum.pairs[k] = (sum.pairs[k] ?? 0) + v;
    for (const [name, count] of m.names) sum.names.set(name, (sum.names.get(name) ?? 0) + count);
  }
  return sum;
}

export function summarise(s) {
  const per = (x) => (x / Math.max(1, s.bars)).toFixed(2);
  const pct = (x) => `${((100 * x) / Math.max(1, s.notes)).toFixed(0)}%`;
  return {
    bars: s.bars,
    'b9/bar': per(s.b9.total),
    'foreign/bar': per(s.foreignB9),
    'tex/bar': per(Object.entries(s.pairs).filter(([k]) => k.includes('texture')).reduce((x, [, v]) => x + v, 0)),
    'mel×pad': per(s.b9['melody|pad']),
    'bass×pad': per(s.b9['bass|pad']),
    'arp×pad': per(s.b9['arp|pad']),
    'bass×mel': per(s.b9['bass|melody']),
    'padB9/chord': (s.padB9 / Math.max(1, s.chords)).toFixed(2),
    'mel/bar': per(s.notes),
    'mel inChord': pct(s.inChord),
    'mel avoid': pct(s.avoid),
    'tt×bass/bar': per(s.ttBass),
    'arp@ceiling': s.ceiling,
  };
}

if (process.argv.includes('--report')) {
  const slugs = process.argv.slice(process.argv.indexOf('--report') + 1);
  const rows = {};
  for (const slug of slugs) {
    const s = await survey(loadGenre(slug));
    rows[slug] = summarise(s);
    if (process.env.VERBOSE) {
      console.log(slug, s.complexity.toFixed(3), Object.fromEntries(s.modes), s.pairs, [...s.names].sort((a, b) => b[1] - a[1]).slice(0, 14));
      console.log(Object.entries(s.examples).sort((a, b) => b[1] - a[1]).slice(0, 25));
    }
  }
  console.table(rows);
  process.exit(0);
}

// --------------------------------------------------------------------------
// The assertions.
// --------------------------------------------------------------------------

const { SCALES } = engineModule;
const { parseChordToken } = await import('../src/scripts/genre-compiler.js');

/**
 * Every chord the genre can write, in every mode it can draw, stacked the way
 * buildChord stacks it (thirds in scale steps, up to the ninth): the ninth must
 * be a MAJOR ninth. A minor ninth over the root is the avoid note jazz voicing
 * never sounds — and the engine sounds it, because the stack is diatonic. In
 * dorian that is ii (and vi); in aeolian ii and v; in ionian iii and vii.
 */
function flatNinths(genre) {
  const language = genre.essence.chordLanguage;
  const tokens = new Set(language.progressionGrammar.flatMap((seed) => seed.split(/\s+/)));
  for (const rule of language.substitutionRules ?? []) tokens.add(rule.to);
  const found = [];
  for (const { value: mode } of genre.essence.modes) {
    const scale = SCALES[mode];
    for (const token of tokens) {
      const chord = parseChordToken(token);
      if (!chord) continue;
      const at = (step) => {
        const i = chord.degree + step;
        return scale[i % scale.length] + 12 * Math.floor(i / scale.length);
      };
      if (pc(at(8) - at(0)) === 1) found.push(`${token} in ${mode}`);
    }
  }
  return found;
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const acid = loadGenre('acid-jazz');
const bossa = loadGenre('bossa');

for (const [slug, genre] of [['acid-jazz', acid], ['bossa', bossa]]) {
  test(`${slug}: every mode it draws is seven-note, and no chord it writes carries a minor ninth`, () => {
    const short = genre.essence.modes.filter(({ value }) => SCALES[value].length !== 7);
    assert.deepEqual(short.map(({ value }) => value), [], 'a jazz grammar of 7ths and 9ths needs a diatonic scale');
    const bad = flatNinths(genre);
    assert.deepEqual(bad, [], `these chords stack a b9 over their own root: ${bad.join(', ')}`);
  });
}

let reference = null;
async function synthwave() {
  if (!reference) reference = await survey(loadGenre('synthwave'));
  return reference;
}

const report = (slug, s) => console.log(`     ${slug}: ${JSON.stringify(summarise(s))}`);
const perBar = (x, s) => x / Math.max(1, s.bars);

test('acid-jazz: minor-second/ninth clashes fall to the level of a genre he hears as fine', async () => {
  const ref = await synthwave();
  const s = await survey(acid);
  report('synthwave', ref);
  report('acid-jazz', s);
  const texture = Object.entries(s.pairs).filter(([k]) => k.includes('texture')).reduce((x, [, v]) => x + v, 0);
  assert.ok(s.bars > 200, `too little played to judge (${s.bars} bars)`);
  // v0.0.217: 4.10 per bar, 2.32 of them the wash's random scale-degree whistle.
  assert.equal(texture, 0, `${texture} clashes still come from the texture track`);
  assert.ok(perBar(s.b9.total, s) <= 1.2, `${perBar(s.b9.total, s).toFixed(2)} b9 clashes per bar (v0.0.217: 4.10)`);
  assert.ok(perBar(s.foreignB9, s) <= perBar(ref.foreignB9, ref) * 1.3,
    `${perBar(s.foreignB9, s).toFixed(2)} avoid-note clashes per bar against synthwave's ${perBar(ref.foreignB9, ref).toFixed(2)}`);
});

test('bossa: clashes, tritones against the bass and the arp ceiling all fall', async () => {
  const ref = await synthwave();
  const s = await survey(bossa);
  report('bossa', s);
  assert.ok(s.bars > 200, `too little played to judge (${s.bars} bars)`);
  assert.ok(perBar(s.b9.total, s) <= 1.5, `${perBar(s.b9.total, s).toFixed(2)} b9 clashes per bar (v0.0.217: 2.09)`);
  assert.ok(perBar(s.foreignB9, s) <= perBar(ref.foreignB9, ref) * 1.3,
    `${perBar(s.foreignB9, s).toFixed(2)} avoid-note clashes per bar against synthwave's ${perBar(ref.foreignB9, ref).toFixed(2)}`);
  assert.ok(perBar(s.ttBass, s) <= 0.2,
    `${perBar(s.ttBass, s).toFixed(2)} tritones against the bass per bar (v0.0.217: 0.74)`);
  // Complexity at or above 0.75 gives the auto arp three octaves, and the
  // engine CLAMPS the arp at midi 96 rather than folding it — so the top of
  // a run is the same pitch whatever the chord. v0.0.217: 106 such notes.
  assert.ok(s.ceiling <= 10, `${s.ceiling} arp notes clamped onto a pitch outside their chord`);
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
