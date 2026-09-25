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
 * - `hint`     — what you will HEAR when you turn it, in one or two plain
 *                sentences (v0.0.172, docs/synthesis-programme.md § 3). Both
 *                editors read it as the dial's tooltip and accessible
 *                description, so a dial's domain and its words live in one
 *                row. Every row carries one; tests/registry-contract.mjs
 *                refuses a row without, and a bare label never ships.
 */

const OSC_TYPES = Object.freeze(['sine', 'triangle', 'sawtooth', 'square']);
const FILTER_TYPES = Object.freeze(['lowpass', 'highpass', 'bandpass', 'notch']);
// v0.0.177: the overtone tables a modal voice can ring with (unit 6).
const MATERIALS = Object.freeze(['metal', 'wood', 'glass', 'bell']);

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
  hint: '',
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
  hint: '',
  ...over,
});

/**
 * The voice-patch namespace — every field the engine's PATCH_SCHEMA
 * sanitises, one row each, domains identical to the sanitisers the schema
 * carried by hand (engine-smoke asserts the two never drift).
 */
export const PARAM_REGISTRY = Object.freeze({
  'patch.source.osc1': enumeration(OSC_TYPES, { hint: 'The waveform: a pure sine at the left, then triangle, saw and square, brighter and buzzier as it goes. Between two shapes is a blend of them.' }),
  'patch.source.osc2': enumeration(OSC_TYPES, { nullable: true, hint: 'A second waveform layered on the first; Mix sets how much of it you hear.' }),
  'patch.source.shape1': number(0, 3, { hint: 'The waveform: a pure sine at the left, then triangle, saw and square, brighter and buzzier as it goes. Between two shapes is a blend of them.' }),
  'patch.source.shape2': number(0, 3, { nullable: true, hint: 'A second waveform layered on the first; Mix sets how much of it you hear.' }),
  'patch.source.mix': number(0, 1, { hint: 'The balance between the two oscillators: all OSC 1 at the left, all OSC 2 at the right.' }),
  // Bipolar since v12; v0.0.158 made the value the exact osc1→osc2 gap on
  // pair voices, which is why the unit is honest cents.
  'patch.source.detune': number(-50, 50, { unit: 'ct', hint: 'How far apart the oscillators sit, in cents: none is one clean tone, a little is warmth, a lot beats and shimmers.' }),
  'patch.source.octave': number(-2, 2, { integer: true, unit: 'oct', hint: 'Which octave the voice plays in: down for weight, up for sparkle.' }),
  'patch.source.pitch': number(-24, 24, { unit: 'st', hint: 'Tunes the kit up or down in semitones: lower is heavier, higher is tighter.' }),
  'patch.source.noise': number(0, 1, { hint: 'How much noise rides on the drum: none is a pure tone, full is mostly snap and hiss.' }),
  'patch.source.fold': number(0, 1, { hint: 'Folds the wave back on itself as it grows: a little adds edge, a lot turns it snarling and metallic.' }),
  'patch.source.tilt': number(-1, 1, { hint: 'The colour of the noise bed: brown and rumbling at the left, flat white at the right.' }),
  'patch.source.bandCentre': number(60, 8000, { curve: 'log', unit: 'Hz', hint: 'Where the resonant band sits — the pitch you hear in the bed. Low is a rumble, high is a hiss.' }),
  'patch.source.bandWidth': number(0.1, 4, { hint: 'How wide that band is, in octaves. Narrow whistles at one pitch; wide is closer to open weather.' }),
  'patch.source.sweepRate': number(0, 0.5, { hint: 'How fast the band sweeps up and down. Off at the left; a slow breath a little way in.' }),
  'patch.source.sweepDepth': number(0, 1, { hint: 'How far that sweep travels. At zero the band holds still whatever the sweep rate says.' }),
  'patch.source.gust': number(0, 1, { hint: 'A slow random walk on level and brightness — the wind picking up and dying back.' }),
  'patch.source.gustRate': number(0.02, 0.5, { hint: 'How quickly those gusts come and go.' }),
  'patch.source.burst': number(0, 1, { hint: 'How many grains land per second: droplets at the bottom, a downpour at the top.' }),
  'patch.source.burstSharp': number(0, 1, { hint: 'The character of each grain — soft damp drops at the left, dry bright crackle at the right.' }),
  'patch.source.swell': number(0, 1, { hint: 'Stretches the attack into a crescendo — small is a gentle rise, full is storm-scale.' }),
  'patch.source.glide': number(-24, 24, { unit: 'st', hint: 'How far each call slides in pitch, in semitones. Negative falls, positive rises.' }),
  'patch.source.glideCurve': number(0, 1, { hint: 'The shape of that slide: even at the left, snapping to the target end at the right.' }),
  'patch.source.formant1': number(60, 8000, { curve: 'log', unit: 'Hz', hint: 'The lower of the two resonances that give the call its vowel — its body.' }),
  'patch.source.formant2': number(60, 8000, { curve: 'log', unit: 'Hz', hint: 'The upper resonance. Far above the first reads as a whistle; close to it, as a hoot.' }),
  'patch.source.cadence': number(0.5, 8, { hint: 'Calls per bar — a single long note at the left, chattering at the right.' }),
  'patch.source.irregular': number(0, 1, { hint: 'How unevenly those calls are spaced. Zero is metronomic; higher sounds like a living thing.' }),
  'patch.filter.type': enumeration(FILTER_TYPES, { hint: 'Which part of the sound gets through: low-pass keeps the bottom, high-pass the top, band-pass one slice, notch everything but one slice.' }),
  'patch.filter.cutoff': number(40, 12000, { curve: 'log', unit: 'Hz', hint: 'How much of the top end gets through: left is muffled and dark, right is open and bright.' }),
  'patch.filter.q': number(0.1, 20, { curve: 'log', hint: 'A peak at the cutoff: a little gives body, a lot rings and whistles.' }),
  'patch.filter.envAmount': number(0, 1, { hint: 'How far each note opens the filter as it starts: none is steady, full is a bright wah on every attack.' }),
  'patch.adsr.attack': number(0.001, 8, { curve: 'log', unit: 's', hint: 'How long a note takes to reach full: short is a strike, long is a swell.' }),
  'patch.adsr.decay': number(0.001, 8, { curve: 'log', unit: 's', hint: 'How quickly a note falls from its peak to the level it holds.' }),
  'patch.adsr.sustain': number(0, 1, { hint: 'The level a note holds while it lasts: none is a pluck, full is a held tone.' }),
  'patch.adsr.release': number(0.01, 12, { curve: 'log', unit: 's', hint: 'How long a note takes to fade once it ends: short stops dead, long rings on.' }),
  // v0.0.175 — the FM engine section (docs/synthesis-programme.md § 2, unit
  // 4). Read only by a voice whose defaults publish `fm` (bell, keys, tines,
  // sparkle, crystal); the others never grow the fields, which is the
  // disclosure rule. Ratio and bite take the voice's authored literal as
  // their default; depth is a MULTIPLIER over the voice's own velocity-scaled
  // index law (`f * (1.5 + 2.5 * v)` and the like), so 1 is the voice as
  // shipped and no flat field could have reproduced it.
  'patch.fm.ratio': number(0.25, 16, { curve: 'log', hint: 'How fast the modulator wobbles the carrier, as a multiple of the note: whole numbers sound harmonic and organ-like, in-between numbers ring like bells and metal.' }),
  'patch.fm.depth': number(0, 4, { hint: 'How hard the wobble drives the tone: none is a plain sine, 1 is the voice as shipped, more adds brightness and grit.' }),
  'patch.fm.bite': number(0.02, 4, { curve: 'log', unit: 's', hint: 'How long the brightness lasts after the note starts: short is a snap that mellows at once, long stays bright into the tail.' }),
  // v0.0.176 — the Additive engine section (docs/synthesis-programme.md § 2,
  // unit 5): drawbars. Read only by a voice whose defaults publish
  // `additive` (glass, stab), and only the partials that voice HAS — glass
  // is five sines, stab six — so the editor never shows a dial that moves
  // nothing. Each level is a MULTIPLIER over the voice's own partial table
  // (1 = as shipped); stretch is an OFFSET on the upper partials' ratios
  // (0 = as shipped), because glass's partials are already stretched and a
  // plain drawbar value would change the shipped sound.
  'patch.additive.p1': number(0, 2, { hint: 'The fundamental: the note itself. Lower it and the upper partials carry the tone.' }),
  'patch.additive.p2': number(0, 2, { hint: 'The second partial, an octave up: more of it is fuller and brighter.' }),
  'patch.additive.p3': number(0, 2, { hint: 'The third partial, an octave and a fifth up: the hollow, reedy colour.' }),
  'patch.additive.p4': number(0, 2, { hint: 'The fourth partial, two octaves up: adds shine without changing the pitch.' }),
  'patch.additive.p5': number(0, 2, { hint: 'The fifth partial, two octaves and a third up: a sweet, slightly major glint.' }),
  'patch.additive.p6': number(0, 2, { hint: 'The sixth partial, two octaves and a fifth up: thin and glassy.' }),
  'patch.additive.p7': number(0, 2, { hint: 'The seventh partial, a flat seventh two octaves up: the buzz in a brass tone.' }),
  'patch.additive.p8': number(0, 2, { hint: 'The eighth partial, three octaves up: pure top, air and edge.' }),
  'patch.additive.stretch': number(-0.1, 0.1, { hint: 'Pulls the upper partials off the harmonic series: at zero they sit in tune, to the right they go sharp and bell-like, to the left flat and dull.' }),
  // v0.0.177 — the Modal engine section (docs/synthesis-programme.md § 2,
  // unit 6): a struck object. Read only by a voice whose defaults publish
  // `modal` (chimes, marimba). Material picks the overtone table — the
  // voice's own table is its default, so metal on chimes and wood on marimba
  // are the literals. Hardness scales the mallet click and tilts the upper
  // partials (1 = as struck today); damping divides every partial's ring
  // (1 = as shipped). No size dial: the note sets the pitch.
  'patch.modal.material': enumeration(MATERIALS, { hint: 'What the struck object is made of: metal rings with the overtones of a tube, wood is short and hollow like a bar, glass is pure and high, bell is deep and clangorous.' }),
  'patch.modal.hardness': number(0, 2, { hint: 'How hard the mallet strikes: soft is dull with little click, hard is bright with a sharp click and stronger upper overtones.' }),
  'patch.modal.damping': number(0.25, 4, { curve: 'log', hint: 'How quickly the ring dies away: left rings on freely, right is choked as if a hand rests on it.' }),
  'patch.sends.reverb': number(0, 1, { hint: 'How much of this voice goes to the shared reverb: dry and close at the left, in a hall at the right.' }),
  'patch.sends.delay': number(0, 1, { hint: 'How much of this voice goes to the shared echo: none at the left, repeating in time at the right.' }),
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
