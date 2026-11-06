/**
 * The engine's time and rhythm, against four faults a 2026-11-06 hunt found
 * — run with:
 *   node tests/rhythm-hunt-smoke.mjs
 *
 *  1. a mid-bar tempo change set the bar's length as if the WHOLE bar were at
 *     the new tempo: a speed-up piled the rest of the bar onto one time,
 *     some of it before the clock;
 *  2. grid notes on a mono track had a fixed floor (0.1 s melody, 0.08 s
 *     bass) longer than a slot at fast rungs, so a short gate slurred into
 *     the next onset;
 *  3. kit hits written on the grid were clamped to 90 % of their pulse, so a
 *     hit in the last tenth sounded early;
 *  4. Stop then Play kept the kit's pattern bank from the last performance;
 *  5. a repeat bracket's replays leaned the bass at the wrong chord (v0.0.310);
 *  6. the bass was SENT whole at the barline, so a mid-bar tempo change left
 *     the rest of its bar on the old tempo and a speed-up put its notes past
 *     the real barline (proto/bass-per-pulse; red on v0.0.311).
 *
 * The scheduler is ticked by hand (texture-grid-smoke's stand-in ticker), so
 * the results do not depend on how busy the machine is.
 */
// Minimal AudioContext mock — the same thin shape note-source-smoke.mjs uses.
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

export const engineModule = await import('../src/scripts/ambient-engine.js');
export const seededRng = (seed) => () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
const handTickers = new Set();
globalThis.Worker = class {
  constructor() { this.onmessage = null; handTickers.add(this); }
  postMessage() {}
  terminate() { handTickers.delete(this); }
};
globalThis.Blob = class { constructor() {} };
globalThis.URL.createObjectURL = () => 'blob:x';
globalThis.URL.revokeObjectURL = () => {};
export function reset() { liveContexts.length = 0; }
export function clock() { return liveContexts[liveContexts.length - 1]; }
export async function advance(seconds, { step = 0.05, onStep } = {}) {
  const steps = Math.ceil(seconds / step);
  for (let i = 0; i < steps; i++) {
    for (const ctx of liveContexts) if (ctx.state === 'running') ctx.currentTime += step;
    for (const ticker of [...handTickers]) ticker.onmessage?.({ data: 0 });
    if (onStep) await onStep(clock().currentTime);
    await new Promise((resolve) => setImmediate(resolve));
  }
}
export const ALL_ON = {
  pad: { state: 'on' }, bass: { state: 'on' }, melody: { state: 'on' },
  arp: { state: 'on' }, texture: { state: 'on' }, percussion: { state: 'on' },
};
export async function run(params, { seed = 1, seconds = 20, onStep, keep = false } = {}) {
  const engine = engineModule.createEngine(params, { rng: seededRng(seed) });
  const notes = []; const bars = []; const sections = []; const states = [];
  engine.on('note', (e) => notes.push({ ...e, at: clock().currentTime }));
  engine.on('bar', (e) => bars.push({ ...e, at: clock().currentTime }));
  engine.on('section', (e) => sections.push(e));
  engine.on('state', (e) => states.push(e));
  await engine.start();
  await advance(seconds, { onStep: onStep ? (t) => onStep(t, engine) : undefined });
  if (!keep) { try { engine.stop(); } catch {} liveContexts.length = 0; }
  return { engine, notes, bars, sections, states };
}

// ---------------------------------------------------------------------------
// The checks. Each was red on v0.0.305.
// ---------------------------------------------------------------------------
import assert from 'node:assert/strict';
const QUIET = { timing: 0, pan: 0, dynamics: 0, octaveWander: 0, voiceWander: 0, macroPatch: [] };
const R = seededRng(777);
const randomLane = (slots) => Array.from({ length: slots }, () => {
  const s = { on: R() < 0.6, prob: R() < 0.5 ? 1 : 0, vmin: 0.6, vmax: 0.8 };
  if (R() < 0.25) s.tie = true;
  if (R() < 0.4) s.gate = [0.25, 0.5, 0.9, 1][Math.floor(R() * 4)];
  return s;
});
const uniqueBars = (bars) => [...new Map(bars.map((b) => [b.time, b])).values()].sort((a, b) => a.time - b.time);
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('a mid-bar tempo change piles no notes onto one time and schedules none in the past', async () => {
  let pile = 0;
  let past = 0;
  for (const [from, to] of [[60, 120], [60, 240]]) for (const seed of [1, 2]) for (const sig of ['4/4', '6/8']) for (const at of [6.6, 7.3]) {
    let changed = false;
    let cAt = 0;
    const r = await run({ bpm: from, timeSignature: sig, complexity: 0.9, structure: 'drone', tracks: ALL_ON }, {
      seed, seconds: 12, onStep: (t, e) => { if (!changed && t >= at) { changed = true; cAt = t; e.setParams({ bpm: to }); } },
    });
    const bars = uniqueBars(r.bars);
    const bi = bars.findIndex((b, i) => b.time <= cAt && (bars[i + 1]?.time ?? 1e9) > cAt);
    const b = bars[bi];
    if (b) {
      const falseCeil = b.time + b.beatsPerBar * 60 / to - 1e-4;
      pile += r.notes.filter((n) => Math.abs(n.time - falseCeil) < 1e-6).length;
    }
    past += r.notes.filter((n) => n.time < n.at - 1e-9).length;
  }
  assert.equal(pile, 0, `${pile} notes clamped to a barline that the tempo change had moved`);
  assert.equal(past, 0, `${past} notes scheduled before the clock`);
});

test('a mid-bar tempo change leaves no bass note of that bar at or past the next barline', async () => {
  // The bass is planned at the barline and, until proto/bass-per-pulse, was
  // sent there too: every note timed at the tempo the bar started in. A
  // speed-up mid-bar moves the barline earlier (the pulses after it run at
  // the new tempo) and the rest of the bass then sounded past it — on top of
  // the next bar's own bass. Each note is now sent by its own pulse.
  let late = 0;
  let after = 0;
  const cases = [];
  for (const [from, to] of [[60, 120], [60, 240]]) for (const sig of ['4/4', '6/8']) for (const seed of [1, 2]) for (const at of [6.6, 7.3]) {
    reset();
    const engine = engineModule.createEngine({
      bpm: from, timeSignature: sig, complexity: 0.9, structure: 'drone',
      tracks: { ...ALL_ON, bass: { state: 'on' } },
    }, { rng: seededRng(seed) });
    const bars = [];
    const bass = [];
    engine.on('bar', (e) => bars.push(e));
    // Each bass note belongs to the bar whose event came before it: planned
    // in that bar's beginBar, sent there (old) or by one of its pulses (new).
    engine.on('note', (e) => { if (e.track === 'bass') bass.push({ ...e, of: bars.length - 1 }); });
    let changedAt = null;
    await engine.start();
    await advance(14, { onStep: (t) => { if (changedAt === null && t >= at) { changedAt = t; engine.setParams({ bpm: to }); } } });
    engine.stop();
    const bi = bars.findIndex((b, i) => b.time <= changedAt && (bars[i + 1]?.time ?? Infinity) > changedAt);
    assert.ok(bi >= 0 && bars[bi + 1], `${from}->${to} ${sig} seed ${seed}: the change fell inside a bar`);
    const barline = bars[bi + 1].time;
    const mine = bass.filter((n) => n.of === bi);
    after += mine.filter((n) => n.time > changedAt).length;
    const past = mine.filter((n) => n.time >= barline - 1e-9);
    late += past.length;
    if (past.length) cases.push(`${from}->${to} ${sig} seed ${seed} @${at}: ${past.length} past ${barline.toFixed(3)} (${past.map((n) => n.time.toFixed(3)).join(' ')})`);
  }
  assert.ok(after >= 8, `the bars the tempo changed in should still have bass to come (${after} notes)`);
  assert.equal(late, 0, `${late} bass notes at or past the moved barline:\n${cases.join('\n')}`);
});

test('a repeat bracket replays its bass exactly', async () => {
  // The bass's approach note read the frozen hook position afresh on each
  // replay (it leaned at the wrong chord), and a loop opening mid-chord
  // replayed its first bar with no pad at all.
  let bassDiffer = 0;
  let cases = 0;
  // The hunt's own matrix (7 of 90 replays differed on v0.0.309).
  for (const rhythm of ['auto', 2, 3]) for (const seed of [1, 2, 3, 4, 5]) for (const [s0, e0] of [[2, 4], [3, 6], [1, 2]]) for (const sig of ['4/4', '4/4+3/4']) {
    let set = false;
    const r = await run({ bpm: 140, timeSignature: sig, complexity: 0.8, structure: 'abab', harmony: { rhythm }, tracks: ALL_ON }, {
      seed, seconds: 36, onStep: (t, en) => { if (!set) { set = true; en.setLoopRegion(s0, e0); } },
    });
    const bars = r.bars.sort((a, b) => a.time - b.time);
    const passes = [];
    for (let i = 0; i < bars.length; i++) if (bars[i].bar === s0) passes.push(i);
    if (passes.length < 2) continue;
    cases += 1;
    const notesIn = (pi, track) => {
      const out = [];
      for (let k = 0; k < e0 - s0; k++) {
        const b = bars[pi + k];
        const nb = bars[pi + k + 1];
        if (!nb) return null;
        for (const n of r.notes) if (n.track === track && n.time >= b.time - 1e-6 && n.time < nb.time - 1e-6) out.push(`${k}|${n.midi}|${(n.time - b.time).toFixed(3)}`);
      }
      return out.sort().join(',');
    };
    // The FIRST traversal against its first replay: the approach note was
    // re-aimed on the replay.
    const b1 = notesIn(passes[0], 'bass');
    const b2 = notesIn(passes[1], 'bass');
    if (b1 !== null && b2 !== null && b1 !== b2) bassDiffer += 1;
    // Where the FIRST pass opened with a pad sounding (struck, or ringing in
    // from before the loop), the replay does too. (A pad the plan rests is
    // silent on both.)
    // (a strike may land up to a humanising nudge after the downbeat)
    const soundingAt = (bar) => r.notes.some((n) => n.track === 'pad' && n.time <= bar.time + 0.08 && n.time + n.duration > bar.time + 0.1);
    // (Not asserted since v0.0.310: re-striking a chord already under way
    // would add an onset the first pass did not have — the owner's call.)
    void soundingAt;
  }
  assert.ok(cases > 0, 'no loop came round twice — the case was not reached');
  assert.equal(bassDiffer, 0, `${bassDiffer} of ${cases} replays played a different bass`);
});

test('grid notes on a mono track never overlap the next onset at fast rungs (short gates stay short)', async () => {
  const { ALL_STEP_RESOLUTIONS, laneSlotsFor } = engineModule;
  let overlaps = 0;
  const fine = ALL_STEP_RESOLUTIONS.filter((sb) => sb <= 0.125);
  for (const sig of ['4/4', '6/8', '2/2']) for (const sb of fine) {
    const slots = laneSlotsFor(sb);
    const tracks = {
      pad: { state: 'off' }, arp: { state: 'off' }, texture: { state: 'off' }, percussion: { state: 'off' },
      melody: { state: 'on', mono: true, stepBeats: sb, ...QUIET, sequencers: [{ mode: 'manual', hand: true, steps: randomLane(slots) }] },
      bass: { state: 'on', mono: true, stepBeats: sb, ...QUIET, sequencers: [{ mode: 'manual', hand: true, steps: randomLane(slots) }] },
    };
    const r = await run({ bpm: 100, timeSignature: sig, swing: 0, complexity: 0.5, structure: 'drone', tracks }, { seed: 1, seconds: 10 });
    for (const track of ['melody', 'bass']) {
      const tn = r.notes.filter((n) => n.track === track).sort((a, b) => a.time - b.time);
      for (let i = 0; i + 1 < tn.length; i++) {
        const ov = tn[i].time + tn[i].duration - tn[i + 1].time;
        if (ov > 0.03 * tn[i].duration && ov > 1e-4) overlaps += 1;
      }
    }
  }
  assert.equal(overlaps, 0, `${overlaps} grid notes ran into the next onset`);
});

test('a kit hit written in the last tenth of a pulse sounds on its slot, not early', async () => {
  const { laneSlotsFor } = engineModule;
  let off = 0;
  for (const sig of ['6/8', '7/8', '2/2']) for (const sb of [0.125, 1 / 16]) {
    const slots = laneSlotsFor(sb);
    const kit = { low: randomLane(slots), mid: randomLane(slots), high: randomLane(slots) };
    const tracks = {
      pad: { state: 'off' }, bass: { state: 'off' }, melody: { state: 'off' }, arp: { state: 'off' }, texture: { state: 'off' },
      percussion: { state: 'on', stepBeats: sb, ...QUIET, sequencers: [{ mode: 'manual', hand: true, steps: kit }] },
    };
    const r = await run({ bpm: 100, timeSignature: sig, swing: 0, complexity: 0.5, structure: 'drone', tracks }, { seed: 2, seconds: 10 });
    const bars = uniqueBars(r.bars);
    const spb = 60 / 100;
    for (let bi = 0; bi + 1 < bars.length; bi++) {
      for (const n of r.notes.filter((x) => x.track === 'percussion' && x.time >= bars[bi].time - 1e-6 && x.time < bars[bi + 1].time - 1e-6)) {
        const x = (n.time - bars[bi].time) / spb / sb;
        if (Math.abs(x - Math.round(x)) > 1e-4) off += 1;
      }
    }
  }
  assert.equal(off, 0, `${off} grid hits off their slot`);
});

test('Stop then Play opens a new kit bank, not a pattern from the last performance', async () => {
  let same = 0;
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    const P = { bpm: 120, timeSignature: '4/4', complexity: 0.7, repetition: 0.9, structure: 'drone', tracks: { pad: { state: 'off' }, melody: { state: 'off' }, bass: { state: 'off' }, arp: { state: 'off' }, texture: { state: 'off' }, percussion: { state: 'on', ...QUIET } } };
    const r = await run(P, { seed, seconds: 30, keep: true });
    const pat = (notes, bars) => bars.map((b, i) => notes.filter((n) => n.time >= b.time && n.time < (bars[i + 1]?.time ?? b.time + 2)).map((n) => n.kind + (n.time - b.time).toFixed(3)).join(' '));
    const first = new Set(pat(r.notes, r.bars.sort((a, b) => a.time - b.time)));
    r.engine.stop();
    const n0 = r.notes.length;
    const b0 = r.bars.length;
    await advance(2);
    await r.engine.start();
    await advance(12);
    const p2 = pat(r.notes.slice(n0), r.bars.slice(b0).sort((a, b) => a.time - b.time));
    const fi = p2.findIndex((x) => x);
    if (fi >= 0 && first.has(p2[fi])) same += 1;
    r.engine.stop();
    reset();
  }
  assert.equal(same, 0, `${same} of 10 restarts opened on the previous performance's pattern`);
});

let failures = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`FAIL ${name}\n     ${String(e.message).split('\n')[0]}`);
  }
}
console.log(`\n${tests.length - failures}/${tests.length} passed`);
process.exit(failures ? 1 : 0);
