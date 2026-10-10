/**
 * New… — categories and starting patches (TODO "Factory, edited and your own",
 * step 3, the New… half).
 *
 *   node tests/new-voice-smoke.mjs        (also discovered by tests/all.mjs)
 *
 * The chooser's Instrument door lists a track's voices grouped by what a
 * listener would call them, and its Synth and Noise doors put a STARTING PATCH
 * on the track, played by an existing voice of that track's own bank (its
 * host). This suite holds the data those doors stand on, at the voice library
 * and at the engine:
 *
 *   - every voice carries a category from the published list, and the list
 *     has a label for each;
 *   - every synthesis engine a person can start from has a starting patch;
 *     each host exists, IS that engine, and has a dial for every field the
 *     patch sets (a field no dial reaches would be a sound nobody can edit);
 *   - Subtractive's is a plain open sawtooth (his brief: "not a sine");
 *   - every starting patch survives the ENGINE's sanitiser unchanged, so what
 *     the chooser sends is exactly what plays;
 *   - every one renders through the shipped voice (the offline Web Audio
 *     evaluator wash-saw-render exports) to a finite, audible, bounded signal;
 *   - the noise colours measure as colours: white near flat, pink near
 *     -3 dB/octave, brown near -6, in that order.
 *
 * voices-smoke additionally plays each one through its click / leak / level
 * mock; this suite is the data contract and the measured colours.
 */
import assert from 'node:assert/strict';
import { renderNote } from './wash-saw-render.mjs';

const voicesModule = await import('../src/scripts/engine-voices.js');
const engineModule = await import('../src/scripts/ambient-engine.js');
const {
  VOICES, VOICE_CATEGORIES, CATEGORY_LABELS, STARTING_PATCHES, startingPatchFor,
} = voicesModule;

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('the module publishes categories and starting patches', () => {
  assert.ok(Array.isArray(VOICE_CATEGORIES) && VOICE_CATEGORIES.length, 'VOICE_CATEGORIES is missing');
  assert.ok(STARTING_PATCHES && typeof STARTING_PATCHES === 'object', 'STARTING_PATCHES is missing');
  assert.equal(typeof startingPatchFor, 'function', 'startingPatchFor is missing');
});

test('every voice has a category from the allowed list', () => {
  const allowed = new Set(VOICE_CATEGORIES || []);
  const missing = [];
  for (const [track, bank] of Object.entries(VOICES)) {
    for (const [id, voice] of Object.entries(bank)) {
      if (!allowed.has(voice.category)) missing.push(`${track}.${id} (${voice.category})`);
    }
  }
  assert.deepEqual(missing, [], `voices without an allowed category: ${missing.join(', ')}`);
  for (const category of VOICE_CATEGORIES || []) {
    assert.ok(typeof CATEGORY_LABELS?.[category] === 'string' && CATEGORY_LABELS[category],
      `category ${category} has no label`);
  }
});

test('every engine a person can start from has a starting patch', () => {
  const engines = new Set(Object.values(STARTING_PATCHES || {}).filter((e) => e.door === 'synth').map((e) => e.engine));
  for (const engine of ['subtractive', 'fm', 'additive', 'physical']) {
    assert.ok(engines.has(engine), `no Synth starting patch for ${engine}`);
  }
  for (const colour of ['white', 'pink', 'brown']) {
    assert.equal(STARTING_PATCHES?.[colour]?.door, 'noise', `no ${colour} noise starting patch`);
  }
});

const allowsField = (controls, section, field) => {
  const allowed = controls[section];
  return allowed === true || (Array.isArray(allowed) && allowed.includes(field));
};

test('each host exists, is that engine, and has a dial for every field the patch sets', () => {
  for (const [id, entry] of Object.entries(STARTING_PATCHES || {})) {
    assert.ok(Object.keys(entry.hosts).length, `${id}: no host on any track`);
    assert.ok(typeof entry.name === 'string' && entry.name && typeof entry.words === 'string' && entry.words,
      `${id}: no name or words for the chooser`);
    for (const [voiceSet, host] of Object.entries(entry.hosts)) {
      const voice = VOICES[voiceSet]?.[host];
      assert.ok(voice, `${id}: host ${voiceSet}.${host} does not exist`);
      assert.equal(voice.engineType, entry.engine, `${id}: host ${voiceSet}.${host} is ${voice.engineType}, not ${entry.engine}`);
      for (const [section, fields] of Object.entries(entry.patch)) {
        for (const field of Object.keys(fields)) {
          assert.ok(allowsField(voice.controls, section, field),
            `${id}: ${voiceSet}.${host} has no dial for ${section}.${field}`);
        }
      }
      const made = startingPatchFor(voiceSet, id);
      assert.equal(made?.voice, host, `${id}: startingPatchFor(${voiceSet}) does not name ${host}`);
      assert.deepEqual(made.patch, entry.patch, `${id}: startingPatchFor returns a different patch`);
      made.patch.sends.reverb = 0.99;
      assert.notEqual(entry.patch.sends.reverb, 0.99, `${id}: startingPatchFor hands out the shared object`);
    }
  }
  assert.equal(startingPatchFor('percussion', 'subtractive'), null, 'the kit has no subtractive host, and must say so');
  assert.equal(startingPatchFor('melody', 'nonsense'), null, 'an unknown id is null');
});

test('Subtractive starts on a plain open sawtooth, not a sine', () => {
  const { source, filter } = STARTING_PATCHES.subtractive.patch;
  assert.equal(source.shape1, 2, 'osc 1 is not the sawtooth (shape 2)');
  assert.equal(source.shape2, null, 'osc 2 is not off');
  assert.equal(source.detune, 0, 'there is a detune');
  assert.equal(source.fold, 0, 'there is fold');
  assert.equal(filter.type, 'lowpass');
  assert.equal(filter.cutoff, 12000, 'the filter is not wide open');
  assert.equal(filter.envAmount, 0, 'the filter moves');
});

test('every starting patch survives the engine sanitiser unchanged', () => {
  assert.ok(Object.keys(STARTING_PATCHES || {}).length, 'no starting patches to check');
  for (const [id, entry] of Object.entries(STARTING_PATCHES || {})) {
    for (const [voiceSet, host] of Object.entries(entry.hosts)) {
      const engine = engineModule.createEngine({});
      engine.setParams({ patches: { [voiceSet]: { [host]: structuredClone(entry.patch) } } });
      const stored = engine.getParams().patches?.[voiceSet]?.[host];
      assert.deepEqual(stored, entry.patch, `${id} on ${voiceSet}.${host}: the engine stored ${JSON.stringify(stored)}`);
    }
  }
});

const hz = (midi) => 440 * Math.pow(2, (midi - 69) / 12);
const NOTE_FOR = { pad: 60, bass: 41, melody: 72, arp: 72, texture: 84 };

function peakOf(data) {
  let peak = 0;
  for (let i = 0; i < data.length; i++) {
    assert.ok(Number.isFinite(data[i]), 'a non-finite sample');
    peak = Math.max(peak, Math.abs(data[i]));
  }
  return peak;
}

test('every starting patch renders through its host: finite, audible, bounded', () => {
  assert.ok(Object.keys(STARTING_PATCHES || {}).length, 'no starting patches to check');
  for (const [id, entry] of Object.entries(STARTING_PATCHES || {})) {
    for (const [voiceSet, host] of Object.entries(entry.hosts)) {
      const midi = NOTE_FOR[voiceSet];
      const note = { time: 0.05, when: 0.05, freq: hz(midi), midi, velocity: 0.7, duration: 1.5, pan: 0 };
      const { data } = renderNote(VOICES[voiceSet][host], note, { seconds: 2.5, sampleRate: 24000, patch: entry.patch });
      const peak = peakOf(data);
      assert.ok(peak > 0.003, `${id} on ${voiceSet}.${host}: silent (peak ${peak})`);
      assert.ok(peak < 1, `${id} on ${voiceSet}.${host}: peak ${peak} clips`);
    }
  }
});

// The colours, measured: the slope of octave-band power across 125 Hz-8 kHz,
// least squares, over the held body of a long note. Pink noise falls 3 dB per
// octave and brown 6; white is flat.
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang); const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1; let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k]; const ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}
function octaveSlope(data, sr, from, to) {
  const size = 4096;
  const power = new Float64Array(size / 2);
  for (let s = Math.floor(from * sr); s + size < to * sr; s += size) {
    const re = new Float64Array(size);
    const im = new Float64Array(size);
    for (let i = 0; i < size; i++) re[i] = data[s + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (size - 1)));
    fft(re, im);
    for (let k = 0; k < size / 2; k++) power[k] += re[k] * re[k] + im[k] * im[k];
  }
  const points = [];
  for (let f = 125; f <= 8000; f *= 2) {
    const lo = Math.round(f / Math.SQRT2 / sr * size);
    const hi = Math.round(f * Math.SQRT2 / sr * size);
    let sum = 0;
    for (let k = lo; k < hi; k++) sum += power[k];
    points.push([Math.log2(f), 10 * Math.log10(sum / (hi - lo) + 1e-30)]);
  }
  const mx = points.reduce((a, p) => a + p[0], 0) / points.length;
  const my = points.reduce((a, p) => a + p[1], 0) / points.length;
  let num = 0; let den = 0;
  for (const [x, y] of points) { num += (x - mx) * (y - my); den += (x - mx) ** 2; }
  return num / den;
}

test('the noise colours measure as white, pink and brown', () => {
  const slopes = {};
  for (const colour of ['white', 'pink', 'brown']) {
    const note = { time: 0.1, when: 0.1, freq: hz(72), midi: 72, velocity: 0.5, duration: 5, pan: 0 };
    const { data, sampleRate } = renderNote(VOICES.texture.colour, note, {
      seconds: 6, seed: 7, patch: STARTING_PATCHES[colour].patch,
    });
    slopes[colour] = octaveSlope(data, sampleRate, 1.5, 5);
  }
  const shown = JSON.stringify(Object.fromEntries(Object.entries(slopes).map(([k, v]) => [k, +v.toFixed(2)])));
  assert.ok(Math.abs(slopes.white) < 1.5, `white is not flat: ${shown}`);
  assert.ok(slopes.pink < -1.5 && slopes.pink > -4.5, `pink is not near -3 dB/oct: ${shown}`);
  assert.ok(slopes.brown < -4.5 && slopes.brown > -8, `brown is not near -6 dB/oct: ${shown}`);
  assert.ok(slopes.white > slopes.pink && slopes.pink > slopes.brown, `the colours are out of order: ${shown}`);
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
console.log(`\nnew-voice-smoke: ${tests.length - failures}/${tests.length} passed`);
process.exit(failures ? 1 : 0);
