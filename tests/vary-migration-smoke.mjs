/**
 * The Randomise row dissolved (D8, docs/dial-control-plane-plan.md) — the
 * decode-side shim that must live FOREVER, and the proof that a migrated
 * piece sounds the same to the byte.
 *
 *   node tests/vary-migration-smoke.mjs            check
 *   node tests/vary-migration-smoke.mjs --print    print this engine's render digests
 *
 * Until v0.0.275 every track carried `vary = { voice, volume, pitch, timing,
 * pan }`, each 0-1 or null ("follow this track's Randomness"). Those five
 * dials are now ordinary dials beside the things they affect:
 *
 *   vary.pan     -> tracks[t].pan, a spread on the Pan dial     (a -> {min:-a/2, max:a/2})
 *   vary.timing  -> tracks[t].timing, a spread on Timing        (a -> {min:-a,   max:a})
 *   vary.volume  -> tracks[t].dynamics                          (a -> a)
 *   vary.pitch   -> tracks[t].octaveWander                      (a -> a)
 *   vary.voice   -> tracks[t].voiceWander                       (a -> a)
 *   null         -> the dial's id in tracks[t].macroPatch, the Randomness macro patch
 *
 * Share links carrying `vary.*` never expire, so the engine's sanitiser
 * folds a `vary` block into those fields on EVERY read, forever. This suite
 * holds that with two schema-1 links frozen below as literal strings (one
 * minted the way a v0.0.271 build minted a whole-tree link of a factory
 * preset, one written by hand to hit null, numbers, a span and junk), and
 * with a render comparison: the digests in FROZEN were taken from the
 * v0.0.271 engine (92b3127) playing the vary form of each piece. This
 * engine must reproduce them twice — from the vary form (the shim) and
 * from the same piece written by hand in the NEW fields (the field map).
 *
 * The digest is not audio-reference's 3dp note hash. It is every note event
 * at full precision AND every value the engine handed the audio graph —
 * each node's kind, each panner's pan, each AudioParam ramp's target — up to
 * the twelfth bar, so per-track gain swing and per-note pan, which
 * audio-reference is blind to, are inside it. Ramp TIMES are left out: a few
 * are stamped from the mock clock, which races the scheduler.
 *
 * Red on the old code: the spread-dials module does not exist, the new
 * fields are dropped by the old sanitiser (so the new-field form plays the
 * defaults and misses FROZEN), and getParams still reports `vary`.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

function makeParam(value) {
  return {
    value,
    ramps: [],
    setValueAtTime(v, at) { this.ramps.push({ to: v, at }); this.value = v; return this; },
    linearRampToValueAtTime(v, at) { this.ramps.push({ to: v, at }); this.value = v; return this; },
    exponentialRampToValueAtTime(v, at) { this.ramps.push({ to: v, at }); this.value = v; return this; },
    setTargetAtTime(v, at) { this.ramps.push({ to: v, at }); this.value = v; return this; },
    setValueCurveAtTime() { return this; },
    cancelScheduledValues() { return this; },
    cancelAndHoldAtTime() { return this; },
  };
}

const PARAM_NAMES = ['gain', 'frequency', 'detune', 'Q', 'pan', 'delayTime', 'playbackRate', 'offset'];

function makeNode(kind) {
  const node = {
    kind,
    connections: [],
    type: 'sine',
    normalize: true,
    loop: false,
    buffer: null,
    curve: null,
    oversample: 'none',
    fftSize: 2048,
    smoothingTimeConstant: 0.8,
    threshold: makeParam(-24),
    knee: makeParam(30),
    ratio: makeParam(12),
    attack: makeParam(0.003),
    release: makeParam(0.25),
    get frequencyBinCount() { return this.fftSize / 2; },
    getByteTimeDomainData(array) { array.fill(128); },
    getByteFrequencyData(array) { array.fill(0); },
    getFloatTimeDomainData(array) { array.fill(0); },
    setPeriodicWave() {},
    connect(target) { this.connections.push(target); },
    disconnect() {},
    start(t = 0) { this.startedAt = t; },
    stop() {},
  };
  node.gain = makeParam(1);
  node.frequency = makeParam(440);
  node.detune = makeParam(0);
  node.Q = makeParam(1);
  node.pan = makeParam(0);
  node.delayTime = makeParam(0.25);
  node.playbackRate = makeParam(1);
  node.offset = makeParam(1);
  return node;
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
  track(node) { this.nodes.push(node); return node; }
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

// AMBI4_SRC points the suite at another tree's src/scripts (how FROZEN was
// taken from the v0.0.271 engine); unset, it is this tree's.
const SRC = process.env.AMBI4_SRC ? `file://${process.env.AMBI4_SRC.replace(/\/$/, '')}/` : new URL('../src/scripts/', import.meta.url).href;
const engineModule = await import(`${SRC}ambient-engine.js`);
const { createEngine, sanitiseParams, setGenreTable } = engineModule;
const { compileGenre } = await import(`${SRC}genre-compiler.js`);
const DATA = new URL('../data/', SRC);
const GENRES = readdirSync(new URL('genres/', DATA)).filter((n) => n.endsWith('.json')).sort()
  .map((n) => JSON.parse(readFileSync(new URL(`genres/${n}`, DATA), 'utf8')));
const PRESETS = JSON.parse(readFileSync(new URL('factory-presets.json', DATA), 'utf8'));
let spreadDials = null;
try {
  spreadDials = await import(`${SRC}spread-dials.js`);
} catch {
  spreadDials = null;
}

const PRINT = process.argv.includes('--print');
const seededRng = (seed) => () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
const PLAY_SEED = 20261024;
const BARS = 12;

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${name}\n      ${error.message.split('\n').join('\n      ')}`);
  }
}

// ---------------------------------------------------------------------------
// The links — frozen as literal strings, the way they sit in a chat window.
// ---------------------------------------------------------------------------

/** Base64url JSON with a `v` field: what every build since v0.0.35 mints. */
function decodeLink(link) {
  const value = link.slice(link.indexOf('#p=') + 3);
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const json = Buffer.from(base64 + '='.repeat((4 - (base64.length % 4)) % 4), 'base64').toString('utf8');
  const parsed = JSON.parse(json);
  const version = parsed.v;
  delete parsed.v;
  return { version, params: parsed };
}

function encodeLink(params, v) {
  const json = JSON.stringify({ ...params, v });
  return `https://ambi4.work/#p=${Buffer.from(json, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

// Minted from the v0.0.271 tree: the Sketchbook factory preset, whole, as a
// schema-1 link (its `vary` blocks are that build's shipped preset data).
const LINK_SKETCHBOOK = 'https://ambi4.work/#p=eyJicG0iOjg4LCJyb290IjoiRiIsIm1vZGUiOiJseWRpYW4iLCJ0aW1lU2lnbmF0dXJlIjoiNS80Iiwic3dpbmciOjAuMTIsImNvbXBsZXhpdHkiOjAuNjgsInJlcGV0aXRpb24iOjAuMzUsInN0cnVjdHVyZSI6ImpvdXJuZXkiLCJ2b2x1bWUiOjAuNzgsInRyYWNrcyI6eyJwYWQiOnsic3RhdGUiOiJhdXRvIiwidm9pY2UiOiJjaG9pciIsImxldmVsIjowLjUsInJhbmRvbW5lc3MiOjAuNCwiZGlzc29uYW5jZSI6MC4xLCJ2YXJ5Ijp7InZvaWNlIjowLjI1LCJ2b2x1bWUiOm51bGwsInBpdGNoIjpudWxsLCJ0aW1pbmciOm51bGwsInBhbiI6MC40NX19LCJhcnAiOnsic3RhdGUiOiJhdXRvIiwidm9pY2UiOiJzb2Z0UGx1Y2siLCJsZXZlbCI6MC40NSwicmFuZG9tbmVzcyI6MC41NSwiZGlzc29uYW5jZSI6MC4wOCwidmFyeSI6eyJ2b2ljZSI6MC4yLCJ2b2x1bWUiOm51bGwsInBpdGNoIjpudWxsLCJ0aW1pbmciOm51bGwsInBhbiI6MC42fX0sIm1lbG9keSI6eyJzdGF0ZSI6Im9uIiwidm9pY2UiOiJmbHV0ZSIsImxldmVsIjowLjUsInJhbmRvbW5lc3MiOjAuNiwiZGlzc29uYW5jZSI6eyJtaW4iOjAuMSwibWF4IjowLjMyfSwiZ2xpZGUiOjAuMzUsInZhcnkiOnsidm9pY2UiOjAuMSwidm9sdW1lIjpudWxsLCJwaXRjaCI6MC41NSwidGltaW5nIjowLjQsInBhbiI6MC40fX0sImJhc3MiOnsic3RhdGUiOiJhdXRvIiwidm9pY2UiOiJzdWIiLCJsZXZlbCI6MC41LCJyYW5kb21uZXNzIjowLjMsImRpc3NvbmFuY2UiOjAsImdsaWRlIjowLjIsInZhcnkiOnsidm9pY2UiOjAsInZvbHVtZSI6MC4yNSwicGl0Y2giOm51bGwsInRpbWluZyI6bnVsbCwicGFuIjowfX0sInRleHR1cmUiOnsic3RhdGUiOiJhdXRvIiwidm9pY2UiOiJjaGltZXMiLCJsZXZlbCI6eyJtaW4iOjAuMjQsIm1heCI6MC40NH0sInJhbmRvbW5lc3MiOjAuNSwiZGlzc29uYW5jZSI6MC4xNSwidmFyeSI6eyJ2b2ljZSI6MC4yLCJ2b2x1bWUiOm51bGwsInBpdGNoIjpudWxsLCJ0aW1pbmciOm51bGwsInBhbiI6MC43fX0sInBlcmN1c3Npb24iOnsic3RhdGUiOiJhdXRvIiwidm9pY2UiOiJzb2Z0IiwibGV2ZWwiOjAuMzUsInJhbmRvbW5lc3MiOjAuNDUsInZhcnkiOnsidm9pY2UiOjAuMSwidm9sdW1lIjpudWxsLCJwaXRjaCI6bnVsbCwidGltaW5nIjowLjQsInBhbiI6MC40fX19LCJwYXRjaGVzIjp7Im1lbG9keSI6eyJmbHV0ZSI6eyJmaWx0ZXIiOnsidHlwZSI6Imxvd3Bhc3MiLCJjdXRvZmYiOjQyMDAsInEiOjAuOH0sImFkc3IiOnsiYXR0YWNrIjowLjEyLCJkZWNheSI6MC4wMSwic3VzdGFpbiI6MSwicmVsZWFzZSI6MC41fSwic2VuZHMiOnsicmV2ZXJiIjowLjU1LCJkZWxheSI6MC4zOH19fSwicGFkIjp7ImNob2lyIjp7InNvdXJjZSI6eyJtaXgiOjAuNTUsImRldHVuZSI6MTguNjY2NjY2NjY2NjY2NjY4fSwiZmlsdGVyIjp7InR5cGUiOiJsb3dwYXNzIiwiY3V0b2ZmIjoyMDAwLCJxIjowLjUsImVudkFtb3VudCI6MX0sImFkc3IiOnsiYXR0YWNrIjoxLjksImRlY2F5IjowLjAxLCJzdXN0YWluIjoxLCJyZWxlYXNlIjo0fSwic2VuZHMiOnsicmV2ZXJiIjowLjcsImRlbGF5IjowLjN9fX19LCJ2IjoxfQ';

// Written by hand: every built-in on, every shape of value a vary aspect could
// hold — explicit numbers, an explicit 0 beating the macro, null following it,
// a span on the three scalar aspects (which walk, exactly as before), and junk
// that must leave the default standing.
const LINK_HAND = 'https://ambi4.work/#p=eyJicG0iOjk2LCJyb290IjoiQSIsIm1vZGUiOiJhZW9saWFuIiwiY29tcGxleGl0eSI6MC42NSwic3RydWN0dXJlIjoid2F2ZXMiLCJ0cmFja3MiOnsicGFkIjp7InN0YXRlIjoib24iLCJyYW5kb21uZXNzIjowLjYsInZhcnkiOnsidm9pY2UiOjAuMiwidm9sdW1lIjowLjMsInBpdGNoIjowLjUsInRpbWluZyI6MC40LCJwYW4iOjAuNn19LCJiYXNzIjp7InN0YXRlIjoib24iLCJyYW5kb21uZXNzIjowLjUsInZhcnkiOnsidm9pY2UiOjAsInZvbHVtZSI6eyJtaW4iOjAuMiwibWF4IjowLjZ9LCJ0aW1pbmciOjAuNzUsInBhbiI6bnVsbH19LCJtZWxvZHkiOnsic3RhdGUiOiJvbiIsInJhbmRvbW5lc3MiOjAuNywidmFyeSI6eyJ2b2ljZSI6eyJtaW4iOjAuMSwibWF4IjowLjV9LCJ2b2x1bWUiOjAuOSwicGl0Y2giOjAuNywidGltaW5nIjowLjEsInBhbiI6MC4yNX19LCJ0ZXh0dXJlIjp7InN0YXRlIjoib24iLCJyYW5kb21uZXNzIjowLjgsInZhcnkiOnsidm9pY2UiOm51bGwsInZvbHVtZSI6bnVsbCwicGl0Y2giOnsibWluIjowLjIsIm1heCI6MC44fSwidGltaW5nIjowLCJwYW4iOjAuNjV9fSwiYXJwIjp7InN0YXRlIjoib24iLCJyYW5kb21uZXNzIjowLjQsInZhcnkiOnsidm9pY2UiOjAuMDUsInZvbHVtZSI6Im5vcGUiLCJwaXRjaCI6MC4zLCJ0aW1pbmciOjAuMTUsInBhbiI6MX19LCJwZXJjdXNzaW9uIjp7InN0YXRlIjoib24iLCJyYW5kb21uZXNzIjowLjUsInZhcnkiOnsidm9pY2UiOjAsInZvbHVtZSI6MC4zLCJ0aW1pbmciOjAuMzUsInBhbiI6MC4zNX19fSwidiI6MX0';

/**
 * LINK_HAND's piece, written by hand in the NEW fields — the field map
 * applied by a person, not by the shim, so a shim that is wrong in the same
 * way as its own test cannot pass. Note arp's junk `volume` ("nope") leaves
 * the default patch standing, and a bass `pitch` absent from the link leaves
 * octaveWander patched.
 */
const HAND_MIGRATED = {
  bpm: 96, root: 'A', mode: 'aeolian', complexity: 0.65, structure: 'waves',
  tracks: {
    pad: { state: 'on', randomness: 0.6, voiceWander: 0.2, dynamics: 0.3, octaveWander: 0.5,
      timing: { min: -0.4, max: 0.4 }, pan: { min: -0.3, max: 0.3 }, macroPatch: [] },
    bass: { state: 'on', randomness: 0.5, voiceWander: 0, dynamics: { min: 0.2, max: 0.6 },
      timing: { min: -0.75, max: 0.75 }, macroPatch: ['octaveWander', 'pan'] },
    melody: { state: 'on', randomness: 0.7, voiceWander: { min: 0.1, max: 0.5 }, dynamics: 0.9,
      octaveWander: 0.7, timing: { min: -0.1, max: 0.1 }, pan: { min: -0.125, max: 0.125 }, macroPatch: [] },
    texture: { state: 'on', randomness: 0.8, octaveWander: { min: 0.2, max: 0.8 }, timing: 0,
      pan: { min: -0.325, max: 0.325 }, macroPatch: ['dynamics', 'voiceWander'] },
    arp: { state: 'on', randomness: 0.4, voiceWander: 0.05, octaveWander: 0.3,
      timing: { min: -0.15, max: 0.15 }, pan: { min: -0.5, max: 0.5 }, macroPatch: ['dynamics'] },
    percussion: { state: 'on', randomness: 0.5, voiceWander: 0, dynamics: 0.3,
      timing: { min: -0.35, max: 0.35 }, pan: { min: -0.175, max: 0.175 }, macroPatch: ['octaveWander'] },
  },
};

/** Sketchbook's tracks in the new fields, by hand, likewise. */
function sketchbookMigrated() {
  const p = structuredClone(sketchbookOld.params);
  const write = {
    pad: { voiceWander: 0.25, pan: { min: -0.225, max: 0.225 }, macroPatch: ['dynamics', 'timing', 'octaveWander'] },
    arp: { voiceWander: 0.2, pan: { min: -0.3, max: 0.3 }, macroPatch: ['dynamics', 'timing', 'octaveWander'] },
    melody: { voiceWander: 0.1, octaveWander: 0.55, timing: { min: -0.4, max: 0.4 }, pan: { min: -0.2, max: 0.2 }, macroPatch: ['dynamics'] },
    bass: { voiceWander: 0, dynamics: 0.25, pan: 0, macroPatch: ['timing', 'octaveWander'] },
    texture: { voiceWander: 0.2, pan: { min: -0.35, max: 0.35 }, macroPatch: ['dynamics', 'timing', 'octaveWander'] },
    percussion: { voiceWander: 0.1, timing: { min: -0.4, max: 0.4 }, pan: { min: -0.2, max: 0.2 }, macroPatch: ['dynamics', 'octaveWander'] },
  };
  for (const [id, fields] of Object.entries(write)) {
    delete p.tracks[id].vary;
    Object.assign(p.tracks[id], fields);
  }
  return p;
}

/**
 * Render digests taken from the v0.0.271 engine (92b3127) playing the VARY
 * form of each piece — `AMBI4_SRC=<that tree>/src/scripts node
 * tests/vary-migration-smoke.mjs --print`, with one line added to that
 * tree: the `pan: full.pan` this build's note event carries (telemetry; it
 * moves nothing). A change that moves any of
 * them is a sound change for every stored piece of that shape.
 */
/**
 * The same, for every shipped config. Re-taken 2026-10-30 from the v0.0.274
 * tree (1e77217, plus the same pan line): v0.0.274's reverb swap holds the
 * outgoing return with cancelAndHoldAtTime, which this suite's mock does not
 * record as a ramp, so 16 graph digests moved with NO note moving — checked
 * by reverting that one hold to the old cancel-and-set in the v0.0.274 tree,
 * which reproduces the v0.0.271 digests exactly.
 */
const FROZEN_SHIPPED = Object.freeze({
  'preset:deep-focus': 'b749a807083936cbfe4886e762848e3445c2cc325b423512cab88554e71ebe7c',
  'preset:open-plan': '92c75ea30ec9eb1cca4cf10255c02a04463669d2b6253b91f2622dfa0c7af8b2',
  'preset:glass-office': 'b32284e253a13bc7f258a494e1d0ce40774d6817e8d3b86fa26fc6eb5dcb6753',
  'preset:long-read': 'e944770f69c9dca67e69af8494d556316bd716af8956d9075975ed9b92ced67b',
  'preset:first-light': 'fe066688e29768000c86e95f01b93265a1c59973874045584f0080f8330c639a',
  'preset:push': 'ef58a38bd04a040f693eda48654b1ed2588c86d548a3f1a9ad240f53df38022a',
  'preset:sketchbook': '88c397fd130feb8721ffd5a6e0dee27277ae2c529a6bebb0282f2ddcda8bb258',
  'preset:night-shift': 'ef4f0e8ece3cdf43418b2ef99b3b1e73021d089008e4c11f1a10b69ca9ce9377',
  'preset:wind-down': '3e24fdc1ebb6e367b2997cc7040e485f636755e4dc98fd86586e0ebbf8e13c79',
  'preset:breathe': '45f02b9253095834a481cb990ec389ef21d968a81d231cedcc54413116c6d866',
  'preset:far-rain': 'd86c7325f08872662adc0369965b03c4cb93014c90119998d4b2c4f8afcf7cb1',
  'preset:dawn-song': '1091192915970efe72b4dabad7ecbca8df73cd8adcdbb0c0cca2bf9618ae98c7',
  'genre:acid-jazz': 'd350597993c3ae29b9a4affed64ed08e6200898f005f8f5cb6c12b7a1fdf40a3',
  'genre:ambient': '4c12dc5d64cfff2019893a3d953011c52998ce0bfec2810d0f797a62a6ed5ba2',
  'genre:bossa': 'f8eab9e6766a116b7aa929b488b6b2d582ac898606be3b7ad37ca888cd447b52',
  'genre:cinematic': '5781d11a54bf9172d0491b2b36e6e14790ce868e83d96dfabd0b5c558e529524',
  'genre:deep-house': '534afa872ddb034e94c73b88ff99589d21a03fa39f70e41dec6a93fbe143cfea',
  // Re-taken v0.0.287: the chord-loop fold (18dfa1f) keeps Downtempo's own loop in
  // the minor-pentatonic draw this seed makes, where the engine used to walk an
  // unseeded loop of its own; audio-reference moved for the same one config.
  'genre:downtempo': 'fd30c4cb98d36c675d29d2fd9e3c8f7eaf29d5dfba0e38a46144e16a22f3f632',
  'genre:lofi-beats': 'dac0dd77aa0c06fa9842243aa7f9de0221f84d3f3ccb1b98f3435d09b4a0c255',
  'genre:minimalism': '71d3506c473c391b20cd7a6e61e2d87256b335be42a54fe89f7615ea5cfd2125',
  'genre:new-age': '32204bd68b0340382a9ca750d3868e12fb13ddb56ce282754bb650b0fc6f8ad3',
  'genre:soul-groove': 'be0d945759defed867ad70b06a309257ea767af9f1e366039a586bcb93c64a71',
  'genre:synthwave': '235ba88988292b94bea93a1062e44b5dfe88dda8e5b6536ee35b49280df05142',
  'genre:techno-tools': 'c89a204d8b1702fbfc53f21ba7c5471c4ee618dc2370c0d2ef4a6a83bba82a9f',
});

const FROZEN = {
  sketchbook: '88c397fd130feb8721ffd5a6e0dee27277ae2c529a6bebb0282f2ddcda8bb258',
  hand: '3776e8ae8fa344e0c98e38f77bdf7f3a7b6f052208089871555aa86d33436fd3',
};

// ---------------------------------------------------------------------------
// The render digest
// ---------------------------------------------------------------------------

const exact = (v) => (typeof v === 'number' ? (Object.is(v, -0) ? 0 : v) : v);

/**
 * The STATIC graph — the nodes built before the first bar (track inputs,
 * tone filters, sends, buses) — with every ramp scheduled to start before
 * the twelfth barline. Per-note voice nodes are left out: their count and
 * order depend on voice stealing against the mock clock, which races the
 * scheduler; what a note IS (pitch, velocity, time, length, pan) is in the
 * note list, exactly.
 */
function staticGraph(ctx, count, before) {
  return ctx.nodes.slice(0, count).map((node) => [
    node.kind,
    ...PARAM_NAMES.map((name) => node[name].ramps
      .filter((r) => !(Number(r.at) >= before))
      .map((r) => [exact(r.to), exact(r.at)])),
  ]);
}

async function renderDigest(params) {
  liveContexts.length = 0;
  globalThis.document = { hidden: true, addEventListener() {} };
  // The voice library draws its own small colours (LFO rates, noise seeds)
  // from Math.random; seeded here so the graph is a function of the piece.
  const realRandom = Math.random;
  Math.random = seededRng(7);
  const engine = createEngine(params, { rng: seededRng(PLAY_SEED) });
  const notes = [];
  const cuts = [];
  engine.on('note', (n) => notes.push([n.track, n.midi ?? null, exact(n.velocity), exact(n.time), exact(n.duration), exact(n.pan)]));
  engine.on('bar', (b) => {
    const ctx = liveContexts[0];
    cuts.push({ bar: b.bar, time: b.time, notes: notes.length, nodes: ctx ? ctx.nodes.length : 0 });
  });
  let graph = null;
  try {
    await engine.start();
    for (let i = 0; i < 4000 && cuts.length <= BARS; i++) {
      for (const ctx of liveContexts) ctx.currentTime += 0.5;
      await new Promise((resolve) => setTimeout(resolve, 3));
    }
    assert.ok(cuts.length > BARS, `only ${cuts.length} bars played`);
    // Read BEFORE stop(): the stop fade is stamped from the clock.
    graph = staticGraph(liveContexts[0], cuts[0].nodes, cuts[BARS].time);
  } finally {
    if (engine.running) engine.stop();
    delete globalThis.document;
    Math.random = realRandom;
  }
  const cut = cuts[BARS];
  const payload = JSON.stringify({ notes: notes.slice(0, cut.notes), graph });
  return { hash: createHash('sha256').update(payload).digest('hex'), notes: cut.notes };
}

const sketchbookOld = decodeLink(LINK_SKETCHBOOK);
const handOld = decodeLink(LINK_HAND);

/**
 * Every shipped config — the twelve factory presets (whose data carried
 * vary.* until this build and now carries the migrated fields) and the
 * twelve stock genres (whose compiler wrote the bass pocket as vary.timing
 * and now writes a Timing spread) — on the same full-precision digest.
 */
async function shippedDigests() {
  const out = {};
  setGenreTable(GENRES);
  try {
    for (const preset of PRESETS) out[`preset:${preset.slug}`] = (await renderDigest(preset.params)).hash;
    for (const genre of GENRES) {
      out[`genre:${genre.slug}`] = (await renderDigest(compileGenre(genre, { rng: seededRng(4242) }))).hash;
    }
  } finally {
    setGenreTable(null);
  }
  return out;
}

if (PRINT) {
  console.log(JSON.stringify(await shippedDigests(), null, 2));
  for (const [id, params] of [['sketchbook', sketchbookOld.params], ['hand', handOld.params]]) {
    const a = await renderDigest(params);
    const b = await renderDigest(params);
    console.log(`${id}: ${a.hash} (${a.notes} notes)${a.hash === b.hash ? '' : '  UNSTABLE: second run ' + b.hash}`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

await test('the frozen links are schema-1 links carrying vary.*', () => {
  assert.equal(sketchbookOld.version, 1);
  assert.equal(handOld.version, 1);
  assert.deepEqual(sketchbookOld.params.tracks.melody.vary, { voice: 0.1, volume: null, pitch: 0.55, timing: 0.4, pan: 0.4 });
  assert.equal(encodeLink(sketchbookOld.params, 1), LINK_SKETCHBOOK, 'the Sketchbook link round-trips through the encoder');
  assert.equal(encodeLink(handOld.params, 1), LINK_HAND, 'the hand link round-trips through the encoder');
});

await test('the spread-dials module exists and names the field map', () => {
  assert.ok(spreadDials, 'src/scripts/spread-dials.js did not import');
  assert.deepEqual({ ...spreadDials.VARY_TO_DIAL },
    { voice: 'voiceWander', volume: 'dynamics', pitch: 'octaveWander', timing: 'timing', pan: 'pan' });
  assert.deepEqual([...spreadDials.MACRO_DIALS], ['dynamics', 'timing', 'pan', 'octaveWander', 'voiceWander']);
});

await test('the engine stores the new fields and no longer reports vary', () => {
  const t = sanitiseParams({}).tracks;
  for (const [id, track] of Object.entries(t)) {
    assert.ok(!('vary' in track), `${id} still reports a vary block`);
    for (const field of ['pan', 'timing', 'dynamics', 'octaveWander', 'voiceWander']) {
      assert.ok(field in track, `${id} has no ${field}`);
    }
    assert.ok(Array.isArray(track.macroPatch), `${id} has no macroPatch`);
  }
  // The defaults are the old defaults, moved: every aspect followed the macro
  // except the pad/texture voice wander (0.15) and the bass's (0, v12).
  assert.deepEqual(t.melody.macroPatch, ['dynamics', 'timing', 'pan', 'octaveWander', 'voiceWander']);
  assert.deepEqual(t.pad.macroPatch, ['dynamics', 'timing', 'pan', 'octaveWander']);
  assert.equal(t.pad.voiceWander, 0.15);
  assert.equal(t.texture.voiceWander, 0.15);
  assert.equal(t.bass.voiceWander, 0);
  assert.deepEqual(t.bass.macroPatch, ['dynamics', 'timing', 'pan', 'octaveWander']);
});

await test('the hand-written schema-1 link decodes into the new fields, by the map', () => {
  const t = sanitiseParams(handOld.params).tracks;
  const want = sanitiseParams(HAND_MIGRATED).tracks;
  for (const id of Object.keys(HAND_MIGRATED.tracks)) {
    for (const field of ['pan', 'timing', 'dynamics', 'octaveWander', 'voiceWander', 'macroPatch']) {
      assert.deepEqual(t[id][field], want[id][field], `${id}.${field}`);
    }
  }
  // Spot checks against the map itself, not just against the hand copy.
  assert.deepEqual(t.pad.pan, { min: -0.3, max: 0.3 }, 'vary.pan 0.6 is a pan spread 0.6 wide');
  assert.deepEqual(t.bass.timing, { min: -0.75, max: 0.75 }, 'vary.timing 0.75 is a timing spread of ±0.75 (±18.75 ms)');
  assert.equal(t.texture.timing, 0, 'an explicit 0 is an explicit 0 — it beats the macro');
  assert.ok(!t.texture.macroPatch.includes('timing'));
  assert.ok(t.texture.macroPatch.includes('dynamics'), 'null follows the macro: a patch');
  assert.ok(t.arp.macroPatch.includes('dynamics'), 'junk leaves the default (patched) standing');
  assert.deepEqual(t.bass.dynamics, { min: 0.2, max: 0.6 }, 'a span on a scalar aspect stays a span');
});

await test('a stored vary folds under a partial, aspect by aspect, and new fields beat it', () => {
  const stored = sanitiseParams({ tracks: { melody: { vary: { pan: 0.6, timing: 0.2 } } } });
  const merged = sanitiseParams({ tracks: { melody: { vary: { timing: 0.9 } } } }, stored).tracks.melody;
  assert.deepEqual(merged.timing, { min: -0.9, max: 0.9 });
  assert.deepEqual(merged.pan, { min: -0.3, max: 0.3 }, 'an unmentioned aspect keeps its stored value');
  const both = sanitiseParams({ tracks: { melody: { vary: { pan: 1 }, pan: 0.25 } } }).tracks.melody;
  assert.equal(both.pan, 0.25, 'a new field sent beside a legacy aspect wins');
  assert.ok(!both.macroPatch.includes('pan'));
  const junk = sanitiseParams({ tracks: { melody: { vary: 'nope' } } }, stored).tracks.melody;
  assert.deepEqual(junk.pan, { min: -0.3, max: 0.3 }, 'a junk vary block leaves the stored fields alone');
  // A legacy BASE (a stored tree from before v0.0.275 handed in as the base).
  const legacyBase = { tracks: { melody: { vary: { volume: 0.4, pitch: null } } } };
  const fromBase = sanitiseParams({ bpm: 90 }, legacyBase).tracks.melody;
  assert.equal(fromBase.dynamics, 0.4);
  assert.ok(fromBase.macroPatch.includes('octaveWander'));
  // The lossy case, said out loud: a SPAN on pan or timing was an amount that
  // walked bar by bar; a spread's width is fixed, so it lands on its middle.
  const span = sanitiseParams({ tracks: { pad: { vary: { pan: { min: 0.2, max: 0.6 }, timing: { min: 0, max: 0.5 } } } } }).tracks.pad;
  assert.deepEqual(span.pan, { min: -0.2, max: 0.2 });
  assert.deepEqual(span.timing, { min: -0.25, max: 0.25 });
});

await test('a migrated piece sounds the same to the byte (render comparison)', async () => {
  for (const [id, oldParams, migrated] of [
    ['sketchbook', sketchbookOld.params, sketchbookMigrated()],
    ['hand', handOld.params, HAND_MIGRATED],
  ]) {
    const viaShim = await renderDigest(oldParams);
    assert.equal(viaShim.hash, FROZEN[id], `${id}: the vary form no longer renders as v0.0.271 rendered it`);
    const viaFields = await renderDigest(migrated);
    assert.equal(viaFields.hash, FROZEN[id], `${id}: the new-field form does not render as the vary form did`);
  }
});

await test('every shipped preset and genre renders as v0.0.271 rendered it', async () => {
  const fresh = await shippedDigests();
  const moved = Object.keys(FROZEN_SHIPPED).filter((id) => fresh[id] !== FROZEN_SHIPPED[id]);
  assert.deepEqual(Object.keys(fresh).sort(), Object.keys(FROZEN_SHIPPED).sort(), 'the shipped config set changed');
  assert.deepEqual(moved, [], `these render differently from v0.0.271: ${moved.join(', ')}`);
});

await test('the genre compiler writes the bass pocket as a timing spread, not vary', async () => {
  let pockets = 0;
  for (const genre of GENRES) {
    let s = 7;
    const compiled = compileGenre(genre, { rng: () => ((s = (s * 48271) % 2147483647) / 2147483647) });
    for (const [id, t] of Object.entries(compiled.tracks || {})) {
      assert.ok(!('vary' in t), `${genre.slug}: ${id} still carries vary`);
    }
    if (compiled.tracks && compiled.tracks.bass && compiled.tracks.bass.timing !== undefined) pockets += 1;
  }
  assert.ok(pockets > 0, 'no genre asked for a bass pocket at all');
});

await test('no shipped data carries vary any more', () => {
  for (const preset of PRESETS) {
    for (const [id, t] of Object.entries(preset.params.tracks || {})) {
      assert.ok(!('vary' in t), `${preset.slug}: ${id} still carries vary`);
    }
  }
});

// v0.0.275: spread-dials.js is imported by the page entry AND by the engine
// chunk the page loads dynamically. Rollup put it inside the entry, so the
// engine chunk imported the ENTRY back, and tests/voice-rule-page.mjs (which
// imports the bundle under a cache-busting query) ran the whole page twice:
// two Edit handlers, the second closing the editor the first had opened.
// astro.config.mjs gives it its own chunk; this holds that. Reads the BUILT
// bundle, so `npm run build` first (as for every page suite).
await test('no built chunk imports the page entry back', () => {
  const dir = new URL('../dist/_astro/', import.meta.url);
  let names;
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.js'));
  } catch {
    throw new Error('dist/_astro is missing — run npm run build first');
  }
  const entry = names.find((n) => n.startsWith('index.astro_astro_type_script'));
  assert.ok(entry, 'no index page entry chunk in dist/_astro');
  const back = names.filter((n) => n !== entry && readFileSync(new URL(n, dir), 'utf8').includes(entry));
  assert.deepEqual(back, [], `these chunks import the page entry back: ${back.join(', ')}`);
});

console.log(failures ? `\n${failures} failing` : '\nall green');
process.exit(failures ? 1 : 0);
