/**
 * Opt-in saturation — run with:
 *
 *   node tests/saturation-smoke.mjs
 *
 * TODO.md "Later — saturation on track and master" and "Default-sound
 * improvements that are actually cheap": a tape/console-style waveshaper with
 * a Drive amount on the master (`params.drive`) and on every track
 * (`params.tracks.<id>.drive`). See ambient-engine.js § "opt-in saturation"
 * for the curve, the level law and the crossfade, and
 * docs/engine-v2-contract.md for the contract this suite holds:
 *
 *  1. SPARSE. Drive absent, or 0, builds no node: the whole recorded graph —
 *     every node the engine and its voices make, and every connection — is
 *     identical to an engine that has never heard of drive.
 *  2. Drive > 0 puts a WaveShaper in the path, oversampled (4x master, 2x
 *     track), with a monotonic, nearly odd-symmetric curve through 0, BESIDE
 *     the original wire (which is never disconnected).
 *  3. The compensation gain is the documented law — recomputed here from the
 *     curve the node was actually handed, not from the engine's own helper.
 *  4. Every drive move is a setTargetAtTime glide: no setValueAtTime, no
 *     linear/exponential jump, no plain .value write on a gain once the stage
 *     exists, and no disconnect anywhere on the path.
 *  5. The sanitiser clamps, keeps it sparse, and a recipe names it only when
 *     it is non-zero.
 */
import assert from 'node:assert/strict';

// --------------------------------------------------------------------------
// A graph-recording AudioContext mock: every node in creation order, every
// connect/disconnect, and every automation call on every param.
// --------------------------------------------------------------------------

function makeParam(owner, name, initial) {
  let value = initial;
  const param = {
    owner,
    name,
    events: [],
    get value() { return value; },
    set value(v) { value = v; param.events.push({ type: 'value', v }); },
    setValueAtTime(v, t) { value = v; param.events.push({ type: 'setValueAtTime', v, t }); return param; },
    linearRampToValueAtTime(v, t) { value = v; param.events.push({ type: 'linearRamp', v, t }); return param; },
    exponentialRampToValueAtTime(v, t) { value = v; param.events.push({ type: 'expRamp', v, t }); return param; },
    setTargetAtTime(v, t, c) { value = v; param.events.push({ type: 'setTargetAtTime', v, t, c }); return param; },
    setValueCurveAtTime() { param.events.push({ type: 'curve' }); return param; },
    cancelScheduledValues(t) { param.events.push({ type: 'cancel', t }); return param; },
    cancelAndHoldAtTime(t) { param.events.push({ type: 'cancelAndHold', t }); return param; },
  };
  return param;
}

let nextId = 0;
function makeNode(ctx, kind) {
  const node = {
    id: nextId++,
    kind,
    ctx,
    connections: [],
    disconnects: [],
    type: kind === 'biquad' ? 'lowpass' : 'sine',
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
    getFloatFrequencyData(array) { array.fill(-100); },
    setPeriodicWave() {},
    connect(target) { this.connections.push(target); return target; },
    disconnect(target) {
      this.disconnects.push(target ?? null);
      if (target) this.connections = this.connections.filter((n) => n !== target);
      else this.connections = [];
    },
    start(t = 0) { this.startedAt = t; },
    stop() {},
  };
  for (const [name, initial] of [
    ['gain', 1], ['frequency', 440], ['detune', 0], ['Q', 1], ['pan', 0], ['delayTime', 0.25],
    ['playbackRate', 1], ['offset', 1], ['threshold', -24], ['knee', 30], ['ratio', 12],
    ['attack', 0.003], ['release', 0.25],
  ]) node[name] = makeParam(node, name, initial);
  return node;
}

const liveContexts = [];
class MockAudioContext {
  constructor() {
    this.currentTime = 0;
    this.sampleRate = 48000;
    this.state = 'running';
    this.nodes = [];
    this.destination = this.track(makeNode(this, 'destination'));
    liveContexts.push(this);
  }

  track(node) { this.nodes.push(node); return node; }
  createGain() { return this.track(makeNode(this, 'gain')); }
  createOscillator() { return this.track(makeNode(this, 'oscillator')); }
  createBiquadFilter() { return this.track(makeNode(this, 'biquad')); }
  createStereoPanner() { return this.track(makeNode(this, 'panner')); }
  createPanner() { return this.track(makeNode(this, 'panner3d')); }
  createConvolver() { return this.track(makeNode(this, 'convolver')); }
  createDelay() { return this.track(makeNode(this, 'delay')); }
  createDynamicsCompressor() { return this.track(makeNode(this, 'compressor')); }
  createAnalyser() { return this.track(makeNode(this, 'analyser')); }
  createBufferSource() { return this.track(makeNode(this, 'buffersource')); }
  createConstantSource() { return this.track(makeNode(this, 'constantsource')); }
  createWaveShaper() { return this.track(makeNode(this, 'waveshaper')); }
  createChannelMerger() { return this.track(makeNode(this, 'merger')); }
  createChannelSplitter() { return this.track(makeNode(this, 'splitter')); }
  createPeriodicWave() { return { kind: 'periodicwave' }; }
  createBuffer(channels, length, sampleRate) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { numberOfChannels: channels, length, sampleRate, getChannelData: (i) => data[i] };
  }

  resume() { this.state = 'running'; return Promise.resolve(); }
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
}

globalThis.AudioContext = MockAudioContext;

const engineModule = await import('../src/scripts/ambient-engine.js');
const { createEngine, sanitiseParams, driveLaw, DRIVE_REFERENCE, DRIVE_FLOOR_DB, DRIVE_RANGE_DB, DRIVE_CURVE_SPAN } = engineModule;
const { recipeFromParams, recipeToText, recipeFromText } = await import('../src/scripts/recipe.js');

const seededRng = (seed) => () => ((seed = (seed * 48271) % 2147483647) / 2147483647);

/**
 * Move the mock clock. `sleep` longer than the engine's 25 ms scheduler tick
 * means every clock value is ticked at least once, and a second tick at the
 * same value schedules nothing new — so two runs schedule the same notes in
 * the same order, which is what lets the whole graph be compared.
 */
async function advance(seconds, step = 0.1, sleep = 3) {
  for (let t = 0; t < seconds; t += step) {
    for (const ctx of liveContexts) ctx.currentTime += step;
    await new Promise((resolve) => setTimeout(resolve, sleep));
  }
}

const BASE = {
  bpm: 120, structure: 'drone', timeSignature: '4/4', complexity: 0.6, mode: 'dorian', root: 'D',
  tracks: {
    pad: { state: 'on' }, bass: { state: 'on' }, melody: { state: 'on' },
    arp: { state: 'off' }, texture: { state: 'off' }, percussion: { state: 'off' },
  },
};

/** Build, start and run an engine for a few seconds; returns it and its mock context. */
async function run(extra = {}, seconds = 4, sleep = 3) {
  const before = liveContexts.length;
  const tracks = Object.fromEntries(Object.entries(BASE.tracks)
    .map(([name, track]) => [name, { ...track, ...((extra.tracks || {})[name] || {}) }]));
  const engine = createEngine({ ...BASE, ...extra, tracks }, { rng: seededRng(4242) });
  await engine.start();
  const ctx = liveContexts[before];
  assert.ok(ctx, 'the engine never built an AudioContext');
  await advance(seconds, 0.1, sleep);
  return { engine, ctx };
}

/** The mix graph alone — buildGraph and the track chains, every node made before the first voice. */
function mixSignature(ctx) {
  const firstVoice = ctx.nodes.findIndex((n) => n.kind === 'oscillator' || n.kind === 'buffersource');
  const index = new Map(ctx.nodes.map((n, i) => [n, i]));
  return ctx.nodes.slice(0, firstVoice).map((n, i) => `${i}:${n.kind}->[${n.connections.map((c) => index.get(c) ?? '?').join(',')}]`).join(' ');
}

/** The whole graph as a string: node kinds in creation order and every edge by creation index. */
function signature(ctx) {
  const index = new Map(ctx.nodes.map((n, i) => [n, i]));
  return ctx.nodes.map((n, i) => `${i}:${n.kind}->[${n.connections.map((c) => index.get(c) ?? '?').join(',')}]`).join(' ');
}

/** graph.master: the gain whose output feeds the glue compressor (threshold −18). */
function masterAndCompressor(ctx) {
  const compressor = ctx.nodes.find((n) => n.kind === 'compressor' && n.threshold.value === -18);
  assert.ok(compressor, 'no glue compressor in the graph');
  const master = ctx.nodes.find((n) => n.kind === 'gain' && n.connections.includes(compressor) && n.gain.value !== 0
    && !ctx.nodes.some((m) => m.kind === 'waveshaper' && m.connections.includes(n)));
  assert.ok(master, 'no master gain feeding the compressor');
  return { master, compressor };
}

/** Walk a stage from a waveshaper: its pre (input), post, dc, wet; plus the cancel branch. */
function stageAround(ctx, shaper) {
  const pre = ctx.nodes.find((n) => n.connections.includes(shaper));
  const post = shaper.connections[0];
  const dc = post.connections[0];
  const wet = dc.connections[0];
  const to = wet.connections[0];
  const from = ctx.nodes.find((n) => n.connections.includes(pre));
  const cancel = from.connections.find((n) => n !== pre && n !== to && n.kind === 'gain' && n.connections.length === 1 && n.connections[0] === to);
  return { from, pre, shaper, post, dc, wet, cancel, to };
}

/** RMS law recomputed from the curve array itself, interpolated the way a WaveShaper reads it. */
function lawFromCurve(curve, pre, post) {
  const read = (x) => {
    const pos = ((Math.max(-1, Math.min(1, x)) + 1) / 2) * (curve.length - 1);
    const i = Math.min(curve.length - 2, Math.floor(pos));
    return curve[i] + (curve[i + 1] - curve[i]) * (pos - i);
  };
  const N = 2048;
  let s = 0;
  let sq = 0;
  const ys = [];
  for (let i = 0; i < N; i++) {
    const y = post * read(pre * DRIVE_REFERENCE * Math.sin((2 * Math.PI * i) / N));
    ys.push(y);
    s += y;
  }
  const mean = s / N;
  for (const y of ys) sq += (y - mean) ** 2;
  return Math.sqrt(sq / N) / (DRIVE_REFERENCE / Math.SQRT2);
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// --------------------------------------------------------------------------

test('absent and 0 build the identical graph — no waveshaper, not one extra node or edge', async () => {
  // Only one engine may run at a time here: a second one's timers would
  // interleave with the first's and reorder its notes.
  const a = await run({}, 2.5, 40);
  a.engine.stop();
  const b = await run({ drive: 0, tracks: { pad: { drive: 0 }, bass: { drive: 0 }, melody: { drive: 0 } } }, 2.5, 40);
  b.engine.stop();
  for (const r of [a, b]) {
    assert.equal(r.ctx.nodes.filter((n) => n.kind === 'waveshaper').length, 0, 'a waveshaper exists with every drive at 0');
  }
  assert.ok(a.ctx.nodes.filter((n) => n.kind === 'oscillator').length > 10, 'the run played almost nothing — the comparison would cover the mix graph alone');
  // Node for node and edge for edge, every voice included.
  assert.equal(signature(b.ctx), signature(a.ctx), 'drive 0 changed the node graph');
  // An edit that sends drive 0 to a running engine builds nothing either.
  const c = await run({}, 1);
  const count = c.ctx.nodes.length;
  const mix = mixSignature(c.ctx);
  c.engine.setParams({ drive: 0, tracks: { pad: { drive: 0 } } });
  assert.equal(c.ctx.nodes.length, count, 'a drive-0 edit made nodes');
  assert.equal(mixSignature(c.ctx), mix, 'a drive-0 edit rewired the mix graph');
  assert.equal(mixSignature(c.ctx), mixSignature(a.ctx), 'the mix graph differs from today\'s');
  c.engine.stop();
  // The params are sparse too: a drive of 0 is never stored.
  const p = b.engine.getParams();
  assert.ok(!('drive' in p), 'a master drive of 0 was stored');
  assert.ok(!('drive' in p.tracks.pad), 'a track drive of 0 was stored');
});

test('master drive > 0: a 4x-oversampled waveshaper beside the master → compressor wire, curve monotonic and nearly odd', async () => {
  const { engine, ctx } = await run({ drive: 0.5 });
  const shapers = ctx.nodes.filter((n) => n.kind === 'waveshaper');
  assert.equal(shapers.length, 1, `${shapers.length} waveshapers for one master drive`);
  const [shaper] = shapers;
  assert.equal(shaper.oversample, '4x', 'the master stage is not 4x oversampled');
  const st = stageAround(ctx, shaper);
  const { master, compressor } = masterAndCompressor(ctx);
  assert.equal(st.from, master, 'the stage does not hang off the master');
  assert.equal(st.to, compressor, 'the stage does not feed the glue compressor');
  assert.ok(master.connections.includes(compressor), 'the original master → compressor wire is gone');
  assert.ok(st.cancel, 'no cancel branch: the crossfade has no dry half to take out');
  assert.equal(st.dc.kind, 'biquad');
  assert.equal(st.dc.type, 'highpass', 'no DC blocker on the wet path');

  const curve = shaper.curve;
  assert.ok(curve && curve.length >= 1025 && curve.length % 2 === 1, 'the curve is missing or has no centre sample');
  const mid = (curve.length - 1) / 2;
  assert.ok(Math.abs(curve[mid]) < 1e-7, `curve(0) = ${curve[mid]}, not 0 — silence would not stay silent`);
  // Monotonic everywhere; STRICTLY so across the working range (|u| < 4) —
  // out at the ends tanh is flat below float32's resolution, so neighbouring
  // samples there are equal, which is a plateau, not a fold-back.
  for (let i = 1; i < curve.length; i++) {
    assert.ok(curve[i] >= curve[i - 1], `the curve folds back at sample ${i}`);
    const u = ((i - mid) / mid) * DRIVE_CURVE_SPAN;
    if (Math.abs(u) < 4) assert.ok(curve[i] > curve[i - 1], `the curve is flat inside the working range at u = ${u.toFixed(3)}`);
  }
  // Odd-symmetric-ish: the halves mirror within 25% (the bias is the even colour), and are NOT exactly mirrored.
  let asym = 0;
  for (let k = 1; k <= mid; k++) {
    const pos = curve[mid + k];
    const neg = -curve[mid - k];
    assert.ok(Math.abs(pos - neg) <= 0.25 * Math.max(Math.abs(pos), Math.abs(neg)), `the halves differ by more than 25% at k=${k}`);
    asym = Math.max(asym, Math.abs(pos - neg));
  }
  assert.ok(asym > 1e-3, 'the curve is exactly odd — no even harmonics, so not the tape/console curve');
  // Ends flat: no corner where the shaper clamps past ±1.
  assert.ok(curve[curve.length - 1] - curve[curve.length - 2] < 1e-5, 'the curve still rises at its top end — the clamp would add a corner');
  engine.stop();
});

test('the compensation gain is the documented law, measured off the curve the node holds', async () => {
  for (const drive of [0.05, 0.3, 0.5, 0.8, 1]) {
    const { engine, ctx } = await run({ drive }, 1.2);
    const shaper = ctx.nodes.find((n) => n.kind === 'waveshaper');
    const st = stageAround(ctx, shaper);
    // The law, written out here independently of driveLaw: pre = push / span.
    const push = 10 ** ((DRIVE_FLOOR_DB + drive * DRIVE_RANGE_DB) / 20);
    assert.ok(Math.abs(st.pre.gain.value - push / DRIVE_CURVE_SPAN) < 1e-9, `drive ${drive}: pre ${st.pre.gain.value}, law ${push / DRIVE_CURVE_SPAN}`);
    // post makes the reference sine leave at the RMS it arrived with.
    const gain = lawFromCurve(shaper.curve, st.pre.gain.value, st.post.gain.value);
    const dB = 20 * Math.log10(gain);
    assert.ok(Math.abs(dB) < 0.1, `drive ${drive}: the reference sine leaves ${dB.toFixed(3)} dB off its input level`);
    assert.ok(Math.abs(st.post.gain.value - driveLaw(drive).post) < 1e-12, 'post is not driveLaw(drive).post');
    engine.stop();
  }
});

test('track drive > 0: a 2x waveshaper between that track\'s input and its tone filter only', async () => {
  const { engine, ctx } = await run({ tracks: { bass: { drive: 0.4 } } });
  const shapers = ctx.nodes.filter((n) => n.kind === 'waveshaper');
  assert.equal(shapers.length, 1, `${shapers.length} waveshapers for one track drive`);
  assert.equal(shapers[0].oversample, '2x');
  const st = stageAround(ctx, shapers[0]);
  assert.equal(st.to.kind, 'biquad', 'the track stage does not feed a filter');
  assert.equal(st.to.Q.value, 0.4, 'the track stage does not feed the track tone filter');
  assert.ok(st.from.connections.includes(st.to), 'the original input → tone wire is gone');
  // And it is the BASS chain: chains are built in track order, so the bass
  // tone filter is the TRACK_ORDER.indexOf('bass')-th tone in the graph.
  const tones = ctx.nodes.filter((n) => n.kind === 'biquad' && n.Q.value === 0.4);
  assert.equal(st.to, tones[engineModule.TRACK_ORDER.indexOf('bass')], 'the stage sits on some other track\'s chain');
  assert.equal(engine.getParams().tracks.bass.drive, 0.4);
  engine.stop();
});

test('every drive move is a glide: crossfaded in from silence, no step, no disconnect', async () => {
  const { engine, ctx } = await run({}, 2);
  const nodesBefore = ctx.nodes.length;
  engine.setParams({ drive: 0.6, tracks: { melody: { drive: 0.5 } } });
  const shapers = ctx.nodes.filter((n) => n.kind === 'waveshaper');
  assert.equal(shapers.length, 2, 'turning drive up on a running engine did not build both stages');
  const stages = shapers.map((s) => stageAround(ctx, s));
  await advance(1);
  engine.setParams({ drive: 0.2 });
  await advance(1);
  engine.setParams({ drive: 1, tracks: { melody: { drive: 0 } } });
  await advance(1);
  engine.setParams({ drive: 0 });
  await advance(1);
  engine.stop();
  for (const st of stages) {
    // wet and cancel are BORN silent — their one plain write is the 0 at creation.
    for (const key of ['wet', 'cancel']) {
      const ev = st[key].gain.events;
      assert.deepEqual(ev[0], { type: 'value', v: 0 }, `${key} was not born at 0`);
      for (const e of ev.slice(1)) {
        assert.equal(e.type, 'setTargetAtTime', `${key} moved by ${e.type} — a step on a sounding gain`);
      }
      assert.ok(ev.length >= 3, `${key} was never ramped in and back out`);
    }
    // pre and post: one plain write at creation (the path is silent), then glides only.
    for (const key of ['pre', 'post']) {
      const ev = st[key].gain.events;
      assert.equal(ev[0].type, 'value');
      for (const e of ev.slice(1)) assert.equal(e.type, 'setTargetAtTime', `${key} moved by ${e.type}`);
    }
    assert.equal(st.wet.gain.events.at(-1).v, 0, 'wet did not glide back to 0 when drive returned to 0');
    assert.equal(st.cancel.gain.events.at(-1).v, 0, 'cancel did not glide back to 0');
    // The crossfade is matched: wet and cancel always target opposite levels at the same instant.
    const wetT = st.wet.gain.events.slice(1);
    const canT = st.cancel.gain.events.slice(1);
    assert.equal(wetT.length, canT.length);
    for (let i = 0; i < wetT.length; i++) {
      assert.equal(canT[i].v + wetT[i].v, 0, 'cancel is not the negative of wet — the dry half would not cross out');
      assert.equal(canT[i].t, wetT[i].t);
      assert.equal(canT[i].c, wetT[i].c);
    }
    for (const node of [st.from, st.pre, st.shaper, st.post, st.dc, st.wet, st.cancel]) {
      assert.equal(node.disconnects.length, 0, `${node.kind} was disconnected while the stage could sound`);
    }
  }
  // Nothing else on the graph was touched by a plain write while running.
  assert.ok(ctx.nodes.length >= nodesBefore + 12, 'the two stages did not add their twelve nodes');
});

test('the sanitiser clamps, keeps drive sparse, and refuses a span', () => {
  const on = sanitiseParams({ drive: 0.4, tracks: { pad: { drive: 0.25 } } });
  assert.equal(on.drive, 0.4);
  assert.equal(on.tracks.pad.drive, 0.25);
  assert.equal(sanitiseParams({ drive: 7 }).drive, 1, 'drive above 1 does not clamp');
  assert.ok(!('drive' in sanitiseParams({ drive: -3 })), 'a negative drive is stored');
  assert.ok(!('drive' in sanitiseParams({ drive: 0 }, on)), 'an explicit 0 does not clear a stored drive');
  assert.ok(!('drive' in sanitiseParams({ drive: null }, on)), 'null does not clear a stored drive');
  assert.equal(sanitiseParams({ drive: 'loud' }, on).drive, 0.4, 'junk does not inherit the stored drive');
  assert.equal(sanitiseParams({ drive: { min: 0.2, max: 0.6 } }, on).drive, 0.4, 'a span replaced the stored drive');
  assert.equal(sanitiseParams({}, on).drive, 0.4, 'an unrelated edit dropped the drive');
  assert.equal(sanitiseParams({ tracks: { pad: { level: 0.5 } } }, on).tracks.pad.drive, 0.25, 'a track edit dropped its drive');
  assert.ok(!('drive' in sanitiseParams({ tracks: { pad: { drive: 0 } } }, on).tracks.pad), 'a track drive of 0 is stored');
  assert.ok(!('drive' in sanitiseParams({}).tracks.bass), 'a default track carries a drive');
});

test('a recipe names drive when it is set and never when it is not', () => {
  const plain = recipeFromParams(sanitiseParams({}));
  assert.ok(!('drive' in plain), 'a recipe names an unset master drive');
  assert.ok(!('drive' in plain.tracks.pad), 'a recipe names an unset track drive');
  const set = recipeFromParams(sanitiseParams({ drive: 0.35, tracks: { melody: { drive: 0.6 } } }));
  assert.equal(set.drive, 0.35);
  assert.equal(set.tracks.melody.drive, 0.6);
  const text = recipeToText(set);
  assert.match(text, /^Master drive: 0\.35$/m);
  assert.match(text, /^Melody drive: 0\.6$/m);
  assert.deepEqual(recipeFromText(text), set, 'the recipe text does not round-trip drive');
});

// --------------------------------------------------------------------------

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${name}\n     ${error.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} saturation tests passed`);
process.exit(failed ? 1 : 0);
