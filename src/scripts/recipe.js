/**
 * The recipe — TODO.md "Reconstructible Ambi4" § "Recipe schema and
 * round-trip gate". A recipe is the subset of the engine's params that the
 * owner should be able to read, copy by hand and rebuild from a Blank slate:
 * one canonical, ordered list of fields (`RECIPE_FIELDS`), a way to lift them
 * out of a params object (`recipeFromParams`), and a plain-text form a person
 * could follow with a pen (`recipeToText` / `recipeFromText`).
 *
 * PURE MODULE: no DOM, no audio, no import of ambient-engine.js. The track
 * list, which tracks are tuned/sequenced, and the vary aspects are therefore
 * copied here as literals rather than imported — the same shape param-
 * registry.js already keeps for the patch namespace. A drift between this
 * copy and the engine's own tables is what tests/recipe-roundtrip.mjs (which
 * imports both) would catch, not a design goal of this file.
 *
 * What a recipe is NOT: it is not every field getParams() returns. Fields
 * left out on purpose — spans, sampling, routing, lfo1, macro1, userTracks,
 * genre, volume, speed, tempoLanding, customStructure, per-track swing/hold/
 * mono/glide/driftRate/driftShape/driftBars/voiceWeights/lanes/stepBeats —
 * are either UI/session state, superseded by the voice rule, or outside the
 * eight decision layers the "Reconstructible Ambi4" diagnosis names. Adding
 * one is a deliberate edit to this file, not an omission to silently patch.
 */

/** Registry order (ambient-engine.js TRACK_ORDER) — pad, bass, melody, texture, arp, percussion. */
const TRACK_ORDER = Object.freeze(['pad', 'bass', 'melody', 'texture', 'arp', 'percussion']);

/** Tracks a chord discipline means something to (ambient-engine.js TUNED_TRACKS). */
const TUNED_TRACKS = Object.freeze(['pad', 'bass', 'melody', 'texture', 'arp']);

/** Tracks with a step grid of their own (ambient-engine.js SEQUENCED_TRACKS, membership only). */
const SEQUENCED_TRACKS = Object.freeze(['melody', 'bass', 'arp', 'percussion']);

/** ambient-engine.js VARY_ASPECTS. */
const VARY_ASPECTS = Object.freeze(['voice', 'volume', 'pitch', 'timing', 'pan']);

const trackLabel = (track) => track[0].toUpperCase() + track.slice(1);

/** The recipe rows for one track's fields, in the order they read best. */
function trackFields(track) {
  const label = trackLabel(track);
  // Labels never contain ": " — recipeToText/recipeFromText use it as the
  // ONE label/value delimiter per line, so a label that carried its own
  // colon (e.g. "Pad: state") would make "Pad: state: on" unparsable.
  const rows = [
    { path: `tracks.${track}.state`, label: `${label} state`, kind: 'enum' },
    { path: `tracks.${track}.voice`, label: `${label} voice`, kind: 'enum' },
    { path: `tracks.${track}.voiceRule`, label: `${label} voice rule`, kind: 'voiceRule' },
    { path: `tracks.${track}.level`, label: `${label} level`, kind: 'range' },
    { path: `tracks.${track}.randomness`, label: `${label} randomness`, kind: 'range' },
    // v0.0.200: the auto ladder is a rule — the energy at which the track joins on Auto.
    { path: `tracks.${track}.autoThreshold`, label: `${label} joins at`, kind: 'number' },
  ];
  if (TUNED_TRACKS.includes(track)) {
    rows.push({ path: `tracks.${track}.dissonance`, label: `${label} dissonance`, kind: 'range' });
  }
  rows.push({ path: `tracks.${track}.density`, label: `${label} density`, kind: 'range' });
  for (const aspect of VARY_ASPECTS) {
    rows.push({ path: `tracks.${track}.vary.${aspect}`, label: `${label} vary ${aspect}`, kind: 'range' });
  }
  if (SEQUENCED_TRACKS.includes(track)) {
    rows.push({ path: `tracks.${track}.sequencers`, label: `${label} sequencers`, kind: 'sequencers' });
    rows.push({ path: `tracks.${track}.sequencerAdvance`, label: `${label} sequencer advance`, kind: 'enum' });
  }
  return rows;
}

/**
 * THE CANONICAL FIELD LIST — one row per field a recipe carries, in the order
 * a reader should meet them: the piece as a whole, its harmony, then every
 * track (registry order), then the arp's own auto/manual behaviour, then the
 * patch bank. `recipeToText` and the Recipe sheet (TODO.md, not yet built)
 * both walk this list to decide what a person sees and in what order.
 */
export const RECIPE_FIELDS = Object.freeze([
  { path: 'bpm', label: 'Tempo', kind: 'number' },
  { path: 'timeSignature', label: 'Time signature', kind: 'enum' },
  { path: 'root', label: 'Key', kind: 'enum' },
  { path: 'mode', label: 'Mode', kind: 'enum' },
  { path: 'swing', label: 'Swing', kind: 'number' },
  { path: 'structure', label: 'Structure', kind: 'enum' },
  { path: 'complexity', label: 'Complexity', kind: 'number' },
  { path: 'repetition', label: 'Repetition', kind: 'number' },
  { path: 'reverbTail', label: 'Reverb tail', kind: 'number' },
  { path: 'harmony.seed', label: 'Chord loop', kind: 'json' },
  { path: 'harmony.rhythm', label: 'Harmonic rhythm', kind: 'enum' },
  ...TRACK_ORDER.flatMap(trackFields),
  { path: 'arp.mode', label: 'Arp mode', kind: 'enum' },
  { path: 'arp.pattern', label: 'Arp pattern', kind: 'enum' },
  { path: 'arp.rate', label: 'Arp rate', kind: 'enum' },
  { path: 'arp.octaves', label: 'Arp octaves', kind: 'number' },
  { path: 'arp.steps', label: 'Arp steps', kind: 'json' },
  { path: 'patches', label: 'Patches', kind: 'json' },
].map(Object.freeze));

/** A dotted path read out of a plain object tree; undefined for anything absent. */
function getPath(obj, path) {
  let node = obj;
  for (const part of path.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = node[part];
  }
  return node;
}

/** A dotted path written into a plain object tree, building the nodes it needs. */
function setPath(obj, path, value) {
  const parts = path.split('.');
  let node = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!node[part] || typeof node[part] !== 'object') node[part] = {};
    node = node[part];
  }
  node[parts[parts.length - 1]] = value;
}

const cloneValue = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/**
 * A track's `sequencers` list, reduced to what the recipe names — mode, the
 * step grid, and `hand` when a person wrote it. The transition WEIGHTS
 * between alternates (a kit's fill, a groove's alternate bar) are deliberately
 * left out: they are a probability the compiler and the kit-variant machinery
 * both write, not yet a rule this schema has a place for (see the "Kit
 * variant schedule and fills as rules" item in TODO.md). Recording the grids
 * but not the odds of switching between them is exactly the kind of gap this
 * unit exists to surface, not to paper over.
 */
function liftSequencers(list) {
  if (!Array.isArray(list)) return undefined;
  return list.map((sequencer) => {
    const lifted = { mode: sequencer.mode, steps: cloneValue(sequencer.steps) };
    if (sequencer.hand === true) lifted.hand = true;
    return lifted;
  });
}

/**
 * The recipe of a params object: RECIPE_FIELDS walked in canonical order, each
 * field's value copied from `params` at its path and written into the recipe
 * at the SAME path — a recipe is therefore shaped exactly like a params
 * partial, and `applyRecipe` can hand one straight to `setParams`. A field
 * absent from `params` (an untuned track's dissonance, a track with no voice
 * rule set) is left out rather than written as null or a default: the recipe
 * only ever says what the piece actually decided.
 */
export function recipeFromParams(params) {
  const recipe = {};
  for (const row of RECIPE_FIELDS) {
    const value = getPath(params, row.path);
    if (value === undefined) continue;
    const lifted = row.kind === 'sequencers' ? liftSequencers(value) : cloneValue(value);
    if (lifted === undefined) continue;
    setPath(recipe, row.path, lifted);
  }
  return recipe;
}

// ---------------------------------------------------------------------------
// Text form — one line per field, in RECIPE_FIELDS order. Round-trip is the
// contract: recipeFromText(recipeToText(r)) must deep-equal r for every
// recipe recipeFromParams can produce, which is what tests/recipe-roundtrip.mjs
// pins for three compiled genres.
// ---------------------------------------------------------------------------

/** bpm and reverbTail print their unit; every other number is bare. */
const NUMBER_UNIT = Object.freeze({ bpm: 'bpm', reverbTail: 's' });

function formatNumber(path, value) {
  const unit = NUMBER_UNIT[path];
  return unit ? `${value} ${unit}` : String(value);
}

/** parseFloat tolerates ("96 bpm" → 96) a unit this same file appended. */
function parseNumberText(text) {
  return parseFloat(text.trim());
}

/** enum values are the engine's own strings, except harmony.rhythm's bar counts. */
const INTEGER_TEXT = /^-?\d+(?:\.\d+)?$/;
function parseEnumText(text) {
  const trimmed = text.trim();
  return INTEGER_TEXT.test(trimmed) ? Number(trimmed) : trimmed;
}

/** RangeValue: a plain number, a {min,max} span, or null ("follows the macro"). */
function formatRange(value) {
  if (value === null) return 'auto';
  if (value && typeof value === 'object') return `${value.min} to ${value.max}`;
  return String(value);
}

function parseRangeText(text) {
  const trimmed = text.trim();
  if (trimmed === 'auto') return null;
  const sep = trimmed.indexOf(' to ');
  if (sep === -1) return Number(trimmed);
  return {
    min: Number(trimmed.slice(0, sep)),
    max: Number(trimmed.slice(sep + 4)),
  };
}

/**
 * The voice rule as a sentence: "chance <n|hold> when <bar|section|piece>
 * order <weight|turn> pool <id:weight,...|empty>", or "none" when the track
 * carries no rule at all (the pre-v0.0.195 wander/blend, unaffected).
 */
function formatVoiceRule(rule) {
  if (!rule) return 'none';
  const chance = rule.chance === null ? 'hold' : String(rule.chance);
  const pool = rule.pool && rule.pool.length
    ? rule.pool.map((entry) => `${entry.id}:${entry.weight}`).join(',')
    : 'empty';
  return `chance ${chance} when ${rule.when} order ${rule.order} pool ${pool}`;
}

const VOICE_RULE_TEXT = /^chance (\S+) when (\S+) order (\S+) pool (.+)$/;

function parseVoiceRuleText(text) {
  const trimmed = text.trim();
  if (trimmed === 'none') return null;
  const match = VOICE_RULE_TEXT.exec(trimmed);
  if (!match) throw new Error(`recipeFromText: unreadable voice rule "${text}"`);
  const [, chanceText, when, order, poolText] = match;
  const pool = poolText === 'empty' ? [] : poolText.split(',').map((entry) => {
    const at = entry.lastIndexOf(':');
    return { id: entry.slice(0, at), weight: Number(entry.slice(at + 1)) };
  });
  return { chance: chanceText === 'hold' ? null : Number(chanceText), when, order, pool };
}

function formatValue(row, value) {
  switch (row.kind) {
    case 'number': return formatNumber(row.path, value);
    case 'enum': return String(value);
    case 'range': return formatRange(value);
    case 'voiceRule': return formatVoiceRule(value);
    // 'sequencers' and 'json': structured data too shapeless for prose — a
    // person reads it as a data line, the way they would in a JSON preset.
    default: return JSON.stringify(value);
  }
}

function parseValue(row, text) {
  switch (row.kind) {
    case 'number': return parseNumberText(text);
    case 'enum': return parseEnumText(text);
    case 'range': return parseRangeText(text);
    case 'voiceRule': return parseVoiceRuleText(text);
    default: return JSON.parse(text);
  }
}

/** The recipe as text: one "Label: value" line per present field, in order. */
export function recipeToText(recipe) {
  const lines = [];
  for (const row of RECIPE_FIELDS) {
    const value = getPath(recipe, row.path);
    if (value === undefined) continue;
    lines.push(`${row.label}: ${formatValue(row, value)}`);
  }
  return lines.join('\n');
}

/**
 * The inverse of recipeToText. Lines are matched by their label, not their
 * position, so reordering or a blank line between them changes nothing; a
 * line naming a label RECIPE_FIELDS does not have is skipped rather than
 * thrown at, which is what lets a person annotate a printed sheet.
 */
export function recipeFromText(text) {
  const byLabel = new Map(RECIPE_FIELDS.map((row) => [row.label, row]));
  const recipe = {};
  for (const rawLine of String(text).split('\n')) {
    if (!rawLine.trim()) continue;
    const sep = rawLine.indexOf(': ');
    if (sep === -1) continue;
    const row = byLabel.get(rawLine.slice(0, sep));
    if (!row) continue;
    setPath(recipe, row.path, parseValue(row, rawLine.slice(sep + 2)));
  }
  return recipe;
}
