/**
 * The parameter registry — phase 1 of the modulation-routing programme
 * (docs/dial-control-plane-plan.md § Build sequence; unblocked by the owner's
 * 137 ruling, 2026-08-13: the graph is free at launch).
 *
 * ONE declarative table, keyed by dotted path, that both the engine sanitiser
 * and the page read — so a dial's domain, its curve, its unit and whether a
 * span is legal on it exist in exactly one place. Until now the engine's
 * PATCH_SCHEMA, the page's knob literals and the boot-time capability probes
 * each carried their own copy of these facts, and the probes existed largely
 * to ask the engine questions this table now answers statically.
 *
 * The registry is DATA: no functions, no DOM, no audio. The engine derives
 * its sanitisers from it (see buildPatchSchema in ambient-engine.js); the
 * page derives dial specs from it as phase 2 lands. Rows are frozen — a
 * consumer that wants to vary one copies it.
 *
 * Row fields:
 * - `kind`     — 'number' | 'enum'
 * - `domain`   — [lo, hi] for numbers; the legal values array for enums
 * - `nullable` — null is a MEANINGFUL stored value (osc2/shape2: "single
 *                oscillator"), not an absence
 * - `integer`  — stored value rounds to whole steps (octave — a span keeps
 *                fractional ENDS meaningless, so ends round too)
 * - `rangeable`— a {min,max} span is legal here. Derived, not asserted, by
 *                everything downstream: enums are the only false today (D9)
 * - `curve`    — 'linear' | 'log', the UI's mapping hint
 * - `unit`     — display unit ('' | 'ct' | 'st' | 'oct' | 'Hz' | 's')
 * - `scope`    — where in the D7 inheritance chain the parameter lives
 *                (every patch field is 'voice' today; track/bus/master rows
 *                join the table as their phases land)
 * - `sampling` — when a stepped modulation source fires for this parameter
 *                ('bar' is the walk every build has had; the four legal
 *                values are reserved below)
 */

const OSC_TYPES = Object.freeze(['sine', 'triangle', 'sawtooth', 'square']);
const FILTER_TYPES = Object.freeze(['lowpass', 'highpass', 'bandpass', 'notch']);

/**
 * D7's reserved wire vocabulary, verbatim from the plan (2026-08-12). These
 * are the spellings a serialised graph edge, sampling field or step rule will
 * use; they live in code now so the registry build and the doc cannot drift.
 * `inst` and `random` are ruled out by name in the plan — do not add them.
 */
export const RESERVED_TOKENS = Object.freeze({
  pathLevels: Object.freeze(['dial', 'voice', 'instrument', 'track', 'bus', 'master']),
  modulationSources: Object.freeze(['env', 'lfo', 'macro']),
  utilityModules: Object.freeze(['sh', 'mix', 'mul', 'slew']),
  sampling: Object.freeze(['note', 'bar', 'chord', 'section']),
  stepRules: Object.freeze(['absolute', 'walk', 'up', 'down', 'pingpong', 'cycle']),
});

const number = (lo, hi, over = {}) => Object.freeze({
  kind: 'number',
  domain: Object.freeze([lo, hi]),
  nullable: false,
  integer: false,
  rangeable: true,
  curve: 'linear',
  unit: '',
  scope: 'voice',
  sampling: 'bar',
  ...over,
});

const enumeration = (values, over = {}) => Object.freeze({
  kind: 'enum',
  domain: values,
  nullable: false,
  integer: false,
  // D9: only enumerations and identity fields are genuinely non-rangeable.
  rangeable: false,
  curve: 'linear',
  unit: '',
  scope: 'voice',
  sampling: 'bar',
  ...over,
});

/**
 * The voice-patch namespace — every field the engine's PATCH_SCHEMA
 * sanitises, one row each, domains identical to the sanitisers the schema
 * carried by hand (engine-smoke asserts the two never drift).
 */
export const PARAM_REGISTRY = Object.freeze({
  'patch.source.osc1': enumeration(OSC_TYPES),
  'patch.source.osc2': enumeration(OSC_TYPES, { nullable: true }),
  'patch.source.shape1': number(0, 3),
  'patch.source.shape2': number(0, 3, { nullable: true }),
  'patch.source.mix': number(0, 1),
  // Bipolar since v12; v0.0.158 made the value the exact osc1→osc2 gap on
  // pair voices, which is why the unit is honest cents.
  'patch.source.detune': number(-50, 50, { unit: 'ct' }),
  'patch.source.octave': number(-2, 2, { integer: true, unit: 'oct' }),
  'patch.source.pitch': number(-24, 24, { unit: 'st' }),
  'patch.source.noise': number(0, 1),
  'patch.source.fold': number(0, 1),
  'patch.source.tilt': number(-1, 1),
  'patch.source.bandCentre': number(60, 8000, { curve: 'log', unit: 'Hz' }),
  'patch.source.bandWidth': number(0.1, 4),
  'patch.source.sweepRate': number(0, 0.5),
  'patch.source.sweepDepth': number(0, 1),
  'patch.source.gust': number(0, 1),
  'patch.source.gustRate': number(0.02, 0.5),
  'patch.source.burst': number(0, 1),
  'patch.source.burstSharp': number(0, 1),
  'patch.source.swell': number(0, 1),
  'patch.source.glide': number(-24, 24, { unit: 'st' }),
  'patch.source.glideCurve': number(0, 1),
  'patch.source.formant1': number(60, 8000, { curve: 'log', unit: 'Hz' }),
  'patch.source.formant2': number(60, 8000, { curve: 'log', unit: 'Hz' }),
  'patch.source.cadence': number(0.5, 8),
  'patch.source.irregular': number(0, 1),
  'patch.filter.type': enumeration(FILTER_TYPES),
  'patch.filter.cutoff': number(40, 12000, { curve: 'log', unit: 'Hz' }),
  'patch.filter.q': number(0.1, 20, { curve: 'log' }),
  'patch.filter.envAmount': number(0, 1),
  'patch.adsr.attack': number(0.001, 8, { curve: 'log', unit: 's' }),
  'patch.adsr.decay': number(0.001, 8, { curve: 'log', unit: 's' }),
  'patch.adsr.sustain': number(0, 1),
  'patch.adsr.release': number(0.01, 12, { curve: 'log', unit: 's' }),
  'patch.sends.reverb': number(0, 1),
  'patch.sends.delay': number(0, 1),
});

/** The rows of one patch section, as [field, row] pairs in table order. */
export function patchSectionRows(section) {
  const prefix = `patch.${section}.`;
  const rows = [];
  for (const [path, row] of Object.entries(PARAM_REGISTRY)) {
    if (path.startsWith(prefix)) rows.push([path.slice(prefix.length), row]);
  }
  return rows;
}

/** The patch section names the registry knows, in first-appearance order. */
export function patchSections() {
  const seen = [];
  for (const path of Object.keys(PARAM_REGISTRY)) {
    const [, section] = path.split('.');
    if (!seen.includes(section)) seen.push(section);
  }
  return seen;
}

/** One row by dotted path, or null — never throws on an unknown path. */
export function paramRow(path) {
  return Object.prototype.hasOwnProperty.call(PARAM_REGISTRY, path)
    ? PARAM_REGISTRY[path]
    : null;
}

/** D9 as a question: may this path carry a {min,max} span? Unknown → false. */
export function isRangeable(path) {
  const row = paramRow(path);
  return Boolean(row && row.rangeable);
}
