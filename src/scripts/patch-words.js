/**
 * What makes this sound — a voice's patch, in words.
 *
 * Unit 3 of docs/synthesis-programme.md (§ 4, layer 2): a line under the dials
 * of every voice editor, written from the LIVE patch object, so the instrument
 * is knowable (the transparency rule in the UX brief) and the vocabulary is
 * taught by use. "Two saws 6 cents apart. Low-pass at 3520 Hz, ringing,
 * opening fully with each note. Strikes in 6 ms, falls away over 1.1 s, fades
 * over 50 ms. Reverb 40%, echo 35%."
 *
 * Pure: no DOM, no audio, no engine import. `describePatch` is a function of
 * (engine class, patch, controls, detune mode) and nothing else, which is what
 * lets tests/patch-words-smoke.mjs hold its one law in Node: every number in
 * the sentence IS a patch value, printed by the formatter beside it. A word
 * that says 3520 Hz while the dial says 3600 is the same class of fault as a
 * readout that lies about its dial.
 *
 * Numbers use the editors' own display units (Hz, cents, ms/s, %, semitones,
 * octaves) and the same rounding, so the words and the readouts agree.
 * Ranges (a spread) print as `lo–hi`, the same en dash the ghost readout uses.
 */

const SHAPE_NAMES = ['sine', 'triangle', 'saw', 'square'];
const FILTER_WORDS = {
  lowpass: 'Low-pass',
  highpass: 'High-pass',
  bandpass: 'Band-pass',
  notch: 'Notch',
};

/** The editors' formatters, one per unit — exported so the test can share them. */
export const fmt = {
  hz: (v) => `${Math.round(v)} Hz`,
  sec: (v) => (v < 0.1 ? `${Math.round(v * 1000)} ms` : `${Math.round(v * 100) / 100} s`),
  pct: (v) => `${Math.round(v * 100)}%`,
  cents: (v) => `${Math.round(v)} cents`,
  semitones: (v) => `${Math.round(v)} semitones`,
  octaves: (v) => `${Math.round(v * 10) / 10} octaves`,
  plain: (v) => String(Math.round(v * 100) / 100),
  perBar: (v) => `${Math.round(v * 10) / 10} per bar`,
  times: (v) => `${Math.round(v * 100) / 100}×`,
};

const isRange = (v) => v && typeof v === 'object' && Number.isFinite(v.min) && Number.isFinite(v.max);

/** Every finite number a field holds: one for a value, two for a spread. */
export function numbersOf(v) {
  if (isRange(v)) return [v.min, v.max];
  return Number.isFinite(v) ? [v] : [];
}

/** A value or a spread through one formatter: "440 Hz" or "400–900 Hz". */
function show(v, f) {
  if (isRange(v)) {
    const [lo, hi] = [Math.min(v.min, v.max), Math.max(v.min, v.max)];
    if (lo === hi) return f(lo);
    const a = f(lo);
    const b = f(hi);
    // One unit for the pair when both ends share it: "400–900 Hz", "40–60%";
    // both kept when they differ ("6 ms–1.1 s").
    const unitA = a.replace(/^-?[\d.]+/, '');
    const unitB = b.replace(/^-?[\d.]+/, '');
    return unitA === unitB ? `${a.slice(0, a.length - unitA.length)}–${b}` : `${a}–${b}`;
  }
  return Number.isFinite(v) ? f(v) : '';
}

/** The middle of a spread, for the words that pick a band (dry / room / hall). */
function mid(v) {
  if (isRange(v)) return (v.min + v.max) / 2;
  return Number.isFinite(v) ? v : null;
}

const shapeWord = (v) => {
  const x = Math.max(0, Math.min(3, Number(v) || 0));
  const r = Math.round(x);
  if (Math.abs(x - r) < 0.25) return SHAPE_NAMES[r];
  return `${SHAPE_NAMES[Math.floor(x)]}-to-${SHAPE_NAMES[Math.ceil(x)]}`;
};

/** The v8 controls rule: true = every field, false = none, list = those. */
function allowed(controls, section, field) {
  if (!controls || typeof controls !== 'object') return true;
  const spec = controls[section];
  if (spec === undefined || spec === true) return true;
  if (spec === false) return false;
  return Array.isArray(spec) && spec.includes(field);
}

const has = (v) => v !== undefined && v !== null;

/** Join clause fragments into one sentence: "A, b, c." */
function sentence(parts) {
  const bits = parts.filter(Boolean);
  if (!bits.length) return '';
  const text = bits.join(', ');
  return `${text[0].toUpperCase()}${text.slice(1)}.`;
}

/**
 * @param {object} input
 * @param {string} [input.engineType] one of subtractive|fm|additive|physical|noise|hybrid
 * @param {object} input.patch the RESOLVED patch: source/filter/adsr/sends, values or {min,max}
 * @param {object|boolean} [input.controls] the voice's CONTROLS entry
 * @param {string|null} [input.detuneMode] 'pair' | 'stack' | 'scatter' | null
 * @returns {string} one to four short sentences, or '' when nothing applies
 */
export function describePatch({ engineType = '', patch, controls = true, detuneMode = null } = {}) {
  if (!patch || typeof patch !== 'object') return '';
  const src = patch.source || {};
  const flt = patch.filter || {};
  const env = patch.adsr || {};
  const snd = patch.sends || {};
  const can = (section, field) => allowed(controls, section, field) && has((patch[section] || {})[field]);
  const sentences = [];

  // ---- the source, by engine -------------------------------------------
  const source = [];
  const kit = has(src.pitch);
  const shape1 = has(src.shape1) ? src.shape1 : (typeof src.osc1 === 'string' ? SHAPE_NAMES.indexOf(src.osc1.replace('sawtooth', 'saw')) : null);
  const shape2 = has(src.shape2) ? src.shape2 : (typeof src.osc2 === 'string' ? SHAPE_NAMES.indexOf(src.osc2.replace('sawtooth', 'saw')) : null);
  const twoOsc = can('source', 'shape2') && shape2 !== null && shape2 >= 0;
  switch (engineType) {
    case 'fm': {
      const fm = patch.fm || {};
      const ratio = allowed(controls, 'fm', 'ratio') && has(fm.ratio) ? ` at ${show(fm.ratio, fmt.times)} the note` : '';
      source.push(`a sine carrier wobbled by a sine modulator (FM)${ratio}`);
      const depth = mid(fm.depth);
      if (allowed(controls, 'fm', 'depth') && depth !== null && Math.abs(depth - 1) > 0.005) {
        source.push(`driven ${show(fm.depth, fmt.times)}`);
      }
      if (allowed(controls, 'fm', 'bite') && has(fm.bite)) source.push(`bright for ${show(fm.bite, fmt.sec)}`);
      break;
    }
    case 'additive':
      source.push('partials summed at their own levels (additive)');
      break;
    case 'physical':
      source.push(kit ? 'a drum model: a bending skin over noise' : 'a struck-object model (modal)');
      break;
    case 'noise':
      source.push('sculpted noise');
      break;
    default: {
      if (kit) {
        source.push('a tuned drum body over noise');
      } else if (can('source', 'shape1') && shape1 !== null) {
        const a = shapeWord(mid(shape1));
        if (twoOsc) {
          const b = shapeWord(mid(shape2));
          source.push(a === b ? `two ${a}s` : `${a} and ${b}`);
        } else {
          source.push(`a ${a}`);
        }
      }
    }
  }
  if (twoOsc && can('source', 'mix') && engineType !== 'fm') {
    const m = mid(src.mix);
    if (m !== null) {
      source.push(m < 0.35 ? `mostly the first (mix ${show(src.mix, fmt.pct)})`
        : m > 0.65 ? `mostly the second (mix ${show(src.mix, fmt.pct)})`
          : `evenly mixed (${show(src.mix, fmt.pct)})`);
    }
  }
  if (can('source', 'detune') && (twoOsc || detuneMode === 'stack' || detuneMode === 'scatter')) {
    const word = detuneMode === 'pair' ? 'apart' : detuneMode === 'stack' ? 'spread' : 'scattered';
    source.push(`${show(src.detune, fmt.cents)} ${word}`);
  }
  if (can('source', 'octave')) {
    const o = mid(src.octave);
    if (o !== null && Math.round(o) !== 0) {
      source.push(`${Math.abs(Math.round(o)) === 1 ? 'an octave' : `${Math.abs(Math.round(o))} octaves`} ${o > 0 ? 'up' : 'down'}`);
    }
  }
  if (kit && can('source', 'pitch')) {
    const p = mid(src.pitch);
    if (p !== null && Math.round(p) !== 0) source.push(`tuned ${show(src.pitch, fmt.semitones)} ${p > 0 ? 'up' : 'down'}`.replace(/(-\d+) semitones/, (_, n) => `${n.slice(1)} semitones`));
  }
  if (kit && can('source', 'noise')) source.push(`noise ${show(src.noise, fmt.pct)}`);
  if (can('source', 'fold')) {
    const f = mid(src.fold);
    if (f !== null && f > 0.005) source.push(`folded ${show(src.fold, fmt.pct)}`);
  }
  // v19 sculpting, for the noise family
  if (can('source', 'tilt')) {
    const t = mid(src.tilt);
    if (t !== null) source.push(t <= -0.5 ? 'brown and rumbling' : t >= 0.5 ? 'flat and white' : 'pink between brown and white');
  }
  if (can('source', 'bandCentre')) source.push(`a band at ${show(src.bandCentre, fmt.hz)}`);
  if (can('source', 'bandWidth')) source.push(`${show(src.bandWidth, fmt.octaves)} wide`);
  if (can('source', 'burst')) {
    const b = mid(src.burst);
    if (b !== null && b > 0.005) source.push(`grains at ${show(src.burst, fmt.pct)}`);
  }
  // the call family
  if (can('source', 'glide')) {
    const g = mid(src.glide);
    if (g !== null && Math.round(g) !== 0) source.push(`each call sliding ${show(src.glide, fmt.semitones).replace(/^-/, '')} ${g > 0 ? 'up' : 'down'}`);
  }
  if (can('source', 'formant1') && can('source', 'formant2')) {
    source.push(`formants at ${show(src.formant1, fmt.hz)} and ${show(src.formant2, fmt.hz)}`);
  }
  if (can('source', 'cadence')) source.push(`${show(src.cadence, fmt.perBar)}`);
  if (source.length) sentences.push(sentence(source));

  // ---- the filter ---------------------------------------------------------
  const filter = [];
  if (can('filter', 'cutoff')) {
    const type = typeof flt.type === 'string' && FILTER_WORDS[flt.type] ? FILTER_WORDS[flt.type] : 'filter';
    filter.push(`${type} at ${show(flt.cutoff, fmt.hz)}`);
    if (can('filter', 'q')) {
      const q = mid(flt.q);
      if (q !== null && q >= 6) filter.push(`whistling (resonance ${show(flt.q, fmt.plain)})`);
      else if (q !== null && q >= 2) filter.push(`ringing (resonance ${show(flt.q, fmt.plain)})`);
    }
    if (can('filter', 'envAmount')) {
      const e = mid(flt.envAmount);
      if (e !== null && e >= 0.95) filter.push('opening fully with each note');
      else if (e !== null && e > 0.02) filter.push(`opening ${show(flt.envAmount, fmt.pct)} with each note`);
    }
  }
  if (filter.length) sentences.push(sentence(filter));

  // ---- the envelope -------------------------------------------------------
  const shape = [];
  if (can('adsr', 'attack')) {
    const a = mid(env.attack);
    if (a !== null) shape.push(a < 0.05 ? `strikes in ${show(env.attack, fmt.sec)}` : `rises over ${show(env.attack, fmt.sec)}`);
  }
  if (can('adsr', 'sustain') && can('adsr', 'decay')) {
    const s = mid(env.sustain);
    if (s !== null && s <= 0.02) shape.push(`falls away over ${show(env.decay, fmt.sec)}`);
    else if (s !== null && s >= 0.98) shape.push('holds while the note lasts');
    else if (s !== null) shape.push(`settles to ${show(env.sustain, fmt.pct)} over ${show(env.decay, fmt.sec)}`);
  }
  if (can('adsr', 'release')) shape.push(`fades over ${show(env.release, fmt.sec)}`);
  if (shape.length) sentences.push(sentence(shape));

  // ---- the sends ----------------------------------------------------------
  const sends = [];
  if (can('sends', 'reverb')) {
    const r = mid(snd.reverb);
    if (r !== null) sends.push(r < 0.15 ? `dry (reverb ${show(snd.reverb, fmt.pct)})` : r < 0.5 ? `in a room (reverb ${show(snd.reverb, fmt.pct)})` : `in a hall (reverb ${show(snd.reverb, fmt.pct)})`);
  }
  if (can('sends', 'delay')) {
    const d = mid(snd.delay);
    if (d !== null && d > 0.02) sends.push(`echo ${show(snd.delay, fmt.pct)}`);
  }
  if (sends.length) sentences.push(sentence(sends));

  return sentences.join(' ');
}

/**
 * The numbers `describePatch` is allowed to print for this patch, each already
 * pushed through the formatter it would use — the test's side of the law.
 */
export function printableNumbers(patch) {
  const out = new Set();
  const add = (v, f) => {
    for (const n of numbersOf(v)) {
      const m = /-?\d+(?:\.\d+)?/.exec(f(n));
      if (m) out.add(m[0].replace(/^-/, ''));
    }
  };
  const src = (patch && patch.source) || {};
  const flt = (patch && patch.filter) || {};
  const env = (patch && patch.adsr) || {};
  const snd = (patch && patch.sends) || {};
  const fmp = (patch && patch.fm) || {};
  add(fmp.ratio, fmt.times); add(fmp.depth, fmt.times); add(fmp.bite, fmt.sec);
  add(src.mix, fmt.pct); add(src.detune, fmt.cents); add(src.octave, fmt.plain); add(src.pitch, fmt.semitones);
  add(src.noise, fmt.pct); add(src.fold, fmt.pct); add(src.bandCentre, fmt.hz); add(src.bandWidth, fmt.octaves);
  add(src.burst, fmt.pct); add(src.glide, fmt.semitones); add(src.formant1, fmt.hz); add(src.formant2, fmt.hz);
  add(src.cadence, fmt.perBar);
  add(flt.cutoff, fmt.hz); add(flt.q, fmt.plain); add(flt.envAmount, fmt.pct);
  add(env.attack, fmt.sec); add(env.decay, fmt.sec); add(env.sustain, fmt.pct); add(env.release, fmt.sec);
  add(snd.reverb, fmt.pct); add(snd.delay, fmt.pct);
  return out;
}
