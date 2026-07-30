/**
 * Genre compiler (v26) — src/data/genres/[slug].json → engine params.
 *
 * The genre files are GENERATIVE RULES, not presets: weighted enums, a chord
 * grammar with substitution rules, a groove grammar and a set of genre-defying
 * dials. This module is the one place that turns those rules into a params
 * object the engine already understands, so the engine never has to parse — or
 * ship — a note of genre data. It is pure: no DOM, no audio, no module state,
 * deterministic under the `rng` it is handed, and safe to import in Node.
 *
 * WHERE IT RUNS. Page-side, at the moment a listener picks a genre. The engine
 * takes the compiled params through its ordinary `setParams`, plus a `genre`
 * slug it carries as an inert tag (see ambient-engine.js § genre tag). That is
 * the whole engine-side contract: no genre table inside the engine, no genre
 * behaviour inside the engine, and a compiled params object that a share link
 * or a preset can hold without this module being present to read it back.
 *
 * THE DRAW ORDER is fixed, and every draw consumes exactly one rng() call
 * whether or not the genre declares anything usable for it — that is what makes
 * a seed reproduce a genre bar for bar, and what stops a genre with (say) one
 * time signature shifting every later draw in the stream:
 *
 *   1 time signature   2 mode        3 bpm            4 swing
 *   5 harmonic rhythm  6 structure   7 progression seed + one roll per token
 *
 * Everything else — instrumentation, levels, densities, the kit, the patches —
 * is a deterministic function of the data and those draws.
 *
 * WHAT MAPS ONTO WHAT
 *
 *   essence.bpm/swing            → params.bpm / params.swing (uniform draw)
 *   essence.timeSignatures       → params.timeSignature (weighted)
 *   essence.modes                → params.mode (weighted, SCALES-checked)
 *   essence.energyArc            → params.structure (weighted, STRUCTURES-checked)
 *   chordLanguage.harmonicRhythm → params.harmony.rhythm (weighted)
 *   chordLanguage grammar + subs → params.harmony.seed (the expanded chord
 *                                  loop, which the hook establishes from),
 *                                  params.repetition (loop LENGTH) and
 *                                  params.complexity (chord COLOUR) — see below
 *   chordLanguage.extensionBias  → params.complexity, blended with the colour
 *                                  the expanded progression actually asks for
 *   grooveGrammar                → the kit grid and the bass's params — below
 *   instrumentation.perTrack     → params.tracks[*].state/voice/level/randomness
 *   instrumentation.reverbTail   → params.reverbTail
 *   instrumentation.patches      → params.patches (pass-through; engine clamps)
 *   essence.dissonanceRange      → params.tracks[tuned].dissonance, as a RANGE
 *   essence.densityBias          → params.tracks[*].density on the five tracks
 *                                  that read one (bass, melody, texture, arp,
 *                                  percussion; the pad has no event rate)
 *   defiance                     → whatever each dial names, applied LAST
 *
 * THE PROGRESSION, AND WHAT SURVIVES THE TRIP. `expandProgression` is the real
 * thing: it draws a seed (a fallback-list seed is weighted twice — the director
 * put it there because it is load-bearing for recognisability), applies at most
 * one substitution rule per token at the rule's own probability, and parses the
 * result into mode-relative scale degrees under the v25 grammar vocabulary
 * rule (ordinal-1 = scale-degree index; case and 7/9/13/maj7/maj9 suffixes are
 * colour, and the engine's diatonic third-stack realises them).
 *
 * What reaches the engine is the expanded loop ITSELF, as `harmony.seed` — the
 * engine's hook establishes from those degrees instead of walking its own —
 * plus the two params that describe its shape:
 *
 *   repetition  the hook's loop LENGTH — buildHook draws
 *               round(4 + (1 - repetition) * 4) chords, so the compiled
 *               repetition is that inverted against the expanded seed's length
 *   complexity  the colour — buildChord adds the 7th at 0.35 and the 9th at
 *               0.7, so a grammar full of ninths compiles to a complexity that
 *               can actually voice them, and a triad grammar to one that cannot
 *
 * Both still matter with a seed present: complexity is the colour every slot's
 * own extension nudges from, and repetition still sets how often the loop
 * mutates and how long the recall cycle runs. The seed is an establishment,
 * not a freeze — the hook mutates, banks and recalls it as it does any loop.
 * A seed the engine cannot play in the mode it drew (a degree outside a
 * pentatonic) is dropped whole by the sanitiser, and that genre walks its own
 * loop from the shape params, exactly as it did before the seed existed.
 *
 * THE GROOVE GRAMMAR, AND THE TWO PATHS.
 *
 *   Kit path (fallbackLists.grooves present, eight of the twelve genres):
 *   every groove becomes a MANUAL percussion sequencer — low/mid/high masks
 *   written onto the sixteenth grid, one sequencer per groove with even
 *   transition weights, so the kit shuffles between the genre's own patterns.
 *   The bass needs no anchor instruction on this path: the engine locks the
 *   line to percussion's low lane by itself, which is exactly what the
 *   anchorPatterns describe.
 *
 *   Grammar path (no fallback kit — ambient, new age, minimalism, cinematic):
 *   percussion stays on `auto` and the grammar is GUIDANCE. anchorPatterns set
 *   the auto kit's density relative to four-on-the-floor (bounded, so a
 *   sixteenth-grid anchor cannot compile to a machine-gun), and nothing fakes a
 *   grid the director did not write.
 *
 *   Both paths: pocketMs → tracks.bass.vary.timing against the engine's own
 *   lay-back ceiling (BASS_POCKET seconds at vary.timing 1), syncopationCells →
 *   a small bass-density uplift (buildBassGroove only reaches for a second cell
 *   above density 0.6), and the declared articulation set → a bass-density
 *   nudge into the band whose articulation menu matches it (buildBassGroove
 *   offers holdOne/longShort below ~0.4 and the full menu above it).
 *
 * SIXTEEN-STEP MASKS IN ODD METRES — the question the v25 review left open,
 * decided here: TRUNCATE TO THE METRE PREFIX, exactly as the sequencer contract
 * already treats its own 20-slot lanes ("shorter metres use a prefix"). A mask
 * character maps to the slot of the same index, for as many slots as the metre
 * has; 3/4 and 6/8 play the mask's first twelve, 7/8 its first fourteen, 4/4
 * all sixteen, and 5/4 plays all sixteen and RESTS the last four slots of the
 * bar. Rests, not defaults: a mask written for 4/4 has nothing to say about a
 * fifth beat, and the engine's default step is `on`, so silence has to be
 * written explicitly or the bar sprouts hits the director never wrote. Not
 * chosen: rescaling the mask onto the metre (invents onsets between the
 * written ones and destroys the clave/backbeat placements that ARE the genre)
 * and wrapping it round (puts a downbeat kick on beat 4½ of a 7/8 bar).
 */

import {
  BASS_POCKET,
  HARMONY_RHYTHMS,
  HOOK_MAX_CHORDS,
  HOOK_MIN_CHORDS,
  PERCUSSION_LANES,
  SCALES,
  SEQUENCER_STEP_COUNT,
  STRUCTURES,
  TIME_SIGNATURES,
  TRACK_ORDER,
  TRACK_STATES,
  TUNED_TRACKS,
  sanitiseParams,
  sequencerStepsPerBar,
} from './ambient-engine.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const round3 = (v) => Math.round(v * 1000) / 1000;
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** A usable finite number, or `fallback` — the same reading the sanitiser does. */
function numberOr(value, fallback) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return fallback;
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : fallback;
}

/**
 * One weighted draw. ALWAYS consumes exactly one rng() call, including when
 * nothing in the list is usable — a genre that declares one time signature and
 * a genre that declares five must leave the stream in the same place, or the
 * draw order above would mean nothing. `allowed`, when given, is the engine's
 * own enum for the field: a value the engine could not accept is not a draw
 * this module gets to make.
 */
function weightedPick(list, rng, allowed = null) {
  const roll = rng();
  const pool = [];
  let total = 0;
  for (const entry of Array.isArray(list) ? list : []) {
    const value = isObject(entry) ? entry.value : entry;
    if (allowed && !allowed.includes(value)) continue;
    const weight = numberOr(isObject(entry) ? entry.weight : 1, 1);
    if (!(weight > 0)) continue;
    total += weight;
    pool.push({ value, weight });
  }
  if (!pool.length) return undefined;
  let r = roll * total;
  for (const entry of pool) {
    r -= entry.weight;
    if (r <= 0) return entry.value;
  }
  return pool[pool.length - 1].value;
}

/** A uniform draw inside `[lo, hi]`, one rng() call whatever the range says. */
function betweenRange(range, rng) {
  const roll = rng();
  if (!Array.isArray(range) || range.length < 2) return undefined;
  const lo = numberOr(range[0], undefined);
  const hi = numberOr(range[1], undefined);
  if (lo === undefined || hi === undefined) return undefined;
  return lo <= hi ? lo + roll * (hi - lo) : hi + roll * (lo - hi);
}

// -- the chord grammar ------------------------------------------------------

/** Roman ordinals, case-insensitive: the v25 grammar's whole numeral vocabulary. */
const ROMAN_ORDINALS = Object.freeze({ i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7 });

const CHORD_TOKEN = /^([ivIV]+)(.*)$/;

/**
 * One chord symbol as the engine reads it. The numeral is a mode-relative
 * ordinal and `degree` is ordinal-1 — the scale-degree index every engine-side
 * consumer takes, wrapping octave-up by itself in the scales shorter than seven
 * notes. Case is the director's colour hint, not an instruction: the mode
 * decides whether a degree is major or minor, which is why the vocabulary bans
 * accidentals outright.
 */
export function parseChordToken(token) {
  const text = typeof token === 'string' ? token.trim() : '';
  const match = CHORD_TOKEN.exec(text);
  if (!match) return null;
  const ordinal = ROMAN_ORDINALS[match[1].toLowerCase()];
  if (ordinal === undefined) return null;
  return {
    token: text,
    degree: ordinal - 1,
    minor: match[1] === match[1].toLowerCase(),
    suffix: match[2],
  };
}

/**
 * How much chord colour a symbol is asking for, on the engine's own scale:
 * `buildChord` adds the seventh at complexity 0.35 and the ninth at 0.7, so a
 * ninth-or-higher symbol has to compile above the second threshold and a plain
 * triad below the first for the notation to mean what it says.
 */
function chordColour(suffix) {
  if (/(?:9|11|13)/.test(suffix)) return 0.8;
  if (/7/.test(suffix)) return 0.5;
  return 0.2;
}

/**
 * The seed pool. Grammar seeds weigh 1; a seed the genre ALSO names in
 * `fallbackLists.progressions` weighs 2, because that list exists to say "this
 * one is what keeps the genre recognisable" — and a fallback seed the grammar
 * does not carry joins the pool on its own.
 */
function seedPool(grammar, fallback) {
  const weights = new Map();
  for (const seed of Array.isArray(grammar) ? grammar : []) {
    if (typeof seed === 'string' && seed.trim()) weights.set(seed.trim(), 1);
  }
  for (const seed of Array.isArray(fallback) ? fallback : []) {
    if (typeof seed !== 'string' || !seed.trim()) continue;
    const key = seed.trim();
    weights.set(key, (weights.get(key) ?? 0) + 1);
  }
  return [...weights].map(([value, weight]) => ({ value, weight }));
}

/**
 * At most ONE substitution per token, taken from the first rule that both names
 * it and wins its own roll. A substitution is a colour swap, not a rewrite
 * loop: re-running the rules over their own output would let `V7 → V13` chase
 * `V13 → …` round a cycle, and no genre file means that.
 */
function substituteToken(token, rules, rng) {
  for (const rule of rules) {
    if (!isObject(rule) || rule.from !== token || typeof rule.to !== 'string') continue;
    if (rng() < numberOr(rule.prob, 0)) return rule.to;
  }
  return token;
}

/**
 * A genre's chord language, expanded once: a seed drawn from the pool, its
 * substitutions rolled, and the result parsed into degrees. Pure and
 * deterministic under `rng`; `compileGenre` calls it as draw 7, and hands the
 * parsed symbols on to the engine as `harmony.seed`.
 */
export function expandProgression(genreJson, rng = Math.random) {
  const genre = isObject(genreJson) ? genreJson : {};
  const essence = isObject(genre.essence) ? genre.essence : {};
  const language = isObject(essence.chordLanguage) ? essence.chordLanguage : {};
  const fallback = isObject(genre.fallbackLists) ? genre.fallbackLists.progressions : null;
  const seed = weightedPick(seedPool(language.progressionGrammar, fallback), rng) ?? 'I';
  const rules = (Array.isArray(language.substitutionRules) ? language.substitutionRules : [])
    .filter(isObject);
  const tokens = String(seed).split(/\s+/).filter(Boolean)
    .map((token) => substituteToken(token, rules, rng));
  const chords = tokens.map(parseChordToken).filter(Boolean);
  const colour = chords.length
    ? chords.reduce((sum, chord) => sum + chordColour(chord.suffix), 0) / chords.length
    : chordColour('');
  return {
    seed,
    tokens,
    chords,
    degrees: chords.map((chord) => chord.degree),
    colour: round3(colour),
  };
}

// -- the groove grammar -----------------------------------------------------

/** What a mask character means. Anything else is a rest, including a space. */
const MASK_HIT = /[xX]/;

/**
 * The velocity band each built-in lane's steps are written in. A kit only reads
 * as a kit when the hats sit under the kick, and the genre's own track level
 * moves the whole kit rather than the balance inside it.
 */
const KIT_VELOCITIES = Object.freeze({
  low: Object.freeze({ vmin: 0.6, vmax: 0.95 }),
  mid: Object.freeze({ vmin: 0.5, vmax: 0.85 }),
  high: Object.freeze({ vmin: 0.35, vmax: 0.7 }),
});

const DEFAULT_KIT_VELOCITY = Object.freeze({ vmin: 0.5, vmax: 0.9 });

/**
 * A 16-step genre mask as a full 20-slot sequencer lane, in the metre it will
 * be played in — the odd-metre ruling in this file's header, in code. Slots the
 * metre does not have, and slots past the end of the mask, are written OFF
 * rather than left at the engine's `on` default.
 */
export function maskToLane(mask, timeSignature = '4/4', band = DEFAULT_KIT_VELOCITY) {
  const text = typeof mask === 'string' ? mask : '';
  const slots = Math.min(sequencerStepsPerBar(timeSignature), SEQUENCER_STEP_COUNT);
  const lane = new Array(SEQUENCER_STEP_COUNT);
  for (let i = 0; i < SEQUENCER_STEP_COUNT; i++) {
    lane[i] = {
      on: i < slots && i < text.length && MASK_HIT.test(text[i]),
      prob: 1,
      vmin: band.vmin,
      vmax: band.vmax,
    };
  }
  return lane;
}

/** How many hits a mask states, counted only where the metre can play them. */
function maskHits(mask, timeSignature) {
  const text = typeof mask === 'string' ? mask : '';
  const slots = Math.min(sequencerStepsPerBar(timeSignature), SEQUENCER_STEP_COUNT);
  let hits = 0;
  for (let i = 0; i < slots && i < text.length; i++) if (MASK_HIT.test(text[i])) hits += 1;
  return hits;
}

/**
 * Energy stage 1c — the kit-softness ladder, applied AT COMPILE so the grid
 * shows exactly what plays (the owner's no-secrets rule forbids a hidden
 * note-on multiplier). Below the midpoint the whole kit's velocity band
 * scales down (soft kicks are real kicks — his "a kit can arrive very
 * gently") and the high then mid lanes thin on an even, deterministic stride;
 * the LOW lane never loses a hit, because four-to-the-floor is the genre's
 * identity ("0% would remove the acid articulation IF 4 to the floor is
 * genre-defining" — the floor stays). No rng is consumed, so the compile's
 * draw stream is untouched at any value. At 0.5 and above every factor is
 * exactly 1 and the kit is byte-identical to an unshaped compile.
 */
function kitSoftness(kitComplexity) {
  const c = numberOr(kitComplexity, undefined);
  if (c === undefined || c >= 0.5) return null;
  const x = clamp(c, 0, 0.5);
  return {
    velocity: 0.6 + 0.8 * x, // 0.6 at the bottom, 1 at the midpoint
    keep: { low: 1, mid: 0.55 + 0.9 * x, high: 0.35 + 1.3 * x },
  };
}

/**
 * Energy stage 2a — the TOP of the dial (his brief, verbatim: "possibly 8 or
 * 16 to the floor if you started with 4 to the floor"). From 0.75 the LOW
 * lane doubles — a hit midway between each neighbouring pair — and from 0.92
 * it fills every slot the metre plays. Inserted hits sit a shade under the
 * written ones so the authored accents stay the accents. Deterministic, no
 * rng; the identity window [0.5, 0.75) stays exactly as authored.
 */
function kitFloorDouble(steps, kitComplexity, slots) {
  const c = numberOr(kitComplexity, undefined);
  if (c === undefined || c < 0.75) return;
  const onSlots = [];
  for (let i = 0; i < slots; i++) if (steps[i].on) onSlots.push(i);
  if (!onSlots.length) return;
  const insert = (slot, from) => {
    if (slot < 0 || slot >= slots || steps[slot].on) return;
    steps[slot] = {
      ...steps[slot],
      on: true,
      vmin: round3(clamp(steps[from].vmin * 0.85, 0.05, 1)),
      vmax: round3(clamp(steps[from].vmax * 0.85, 0.05, 1)),
    };
  };
  // 8-to-the-floor: midway between each written pair (wrapping to the bar).
  for (let k = 0; k < onSlots.length; k++) {
    const here = onSlots[k];
    const next = k + 1 < onSlots.length ? onSlots[k + 1] : onSlots[0] + slots;
    const mid = here + Math.round((next - here) / 2);
    if (mid > here && mid < next) insert(mid % slots, here);
  }
  if (c >= 0.92) {
    // 16-to-the-floor: every slot the metre plays.
    for (let i = 0; i < slots; i++) insert(i, onSlots[0]);
  }
}

/** Keep hit k of a lane on an even stride at rate r — the first hit always survives. */
const keepHit = (k, r) => k === 0 || Math.floor((k + 1) * r) > Math.floor(k * r);

/**
 * Energy stage 2b — the genre kit's FILL, as its own weighted sequencer. The
 * Markov tab machinery already knows how to visit a variant at loop end, so
 * from 0.75 the compiled kit gains one more sequencer: the first groove with
 * its last beat cleared for a crescendo run on the mid lane. The weights say
 * how often it is visited — rising with the dial — and the fill always hands
 * straight back. Honest by construction: it is a TAB in the grid the user
 * can open, edit or silence, not an improvisation over their data.
 */
function kitFillVariant(main, kitComplexity, slots) {
  const c = numberOr(kitComplexity, undefined);
  if (c === undefined || c < 0.75 || !main) return null;
  const fill = {
    mode: 'manual',
    weights: [],
    steps: Object.fromEntries(Object.entries(main.steps).map(([lane, steps]) => [
      lane,
      steps.map((step) => ({ ...step })),
    ])),
  };
  const lastBeat = Math.max(0, slots - 4);
  for (const lane of ['mid', 'high']) {
    const steps = fill.steps[lane];
    if (!steps) continue;
    for (let i = lastBeat; i < slots; i++) steps[i] = { ...steps[i], on: false };
  }
  const run = fill.steps.mid || fill.steps.high;
  if (run) {
    for (let k = 0; k < Math.min(4, slots - lastBeat); k++) {
      const i = lastBeat + k;
      run[i] = { ...run[i], on: true, vmin: round3(0.35 + k * 0.12), vmax: round3(0.5 + k * 0.12) };
    }
  }
  return fill;
}

/** The genre's fallback kit as manual sequencers — one per groove, evenly weighted. */
function compileKit(grooves, timeSignature, kitComplexity) {
  const list = (Array.isArray(grooves) ? grooves : []).filter(isObject);
  if (!list.length) return null;
  const softness = kitSoftness(kitComplexity);
  const slots = Math.min(sequencerStepsPerBar(timeSignature), SEQUENCER_STEP_COUNT);
  const compiled = list.map((groove) => ({
    mode: 'manual',
    weights: list.map(() => 1),
    steps: Object.fromEntries(PERCUSSION_LANES.map((lane) => {
      const steps = maskToLane(groove[lane], timeSignature, KIT_VELOCITIES[lane] ?? DEFAULT_KIT_VELOCITY);
      if (lane === 'low') {
        kitFloorDouble(steps, kitComplexity, slots);
      }
      if (!softness) return [lane, steps];
      const rate = softness.keep[lane] ?? 1;
      let hit = 0;
      for (const step of steps) {
        if (!step.on) continue;
        if (!keepHit(hit, rate)) step.on = false;
        hit += 1;
        step.vmin = round3(clamp(step.vmin * softness.velocity, 0.05, 1));
        step.vmax = round3(clamp(step.vmax * softness.velocity, 0.05, 1));
      }
      return [lane, steps];
    })),
  }));
  const fill = kitFillVariant(compiled[0], kitComplexity, slots);
  if (fill) {
    const c = clamp(numberOr(kitComplexity, 0.75), 0.75, 1);
    // Visit rate rises with the dial: ~1 bar in 5 at 0.75, ~1 in 2 at full.
    const fillWeight = round3(0.25 + (c - 0.75) * 3);
    for (const sequencer of compiled) sequencer.weights = [...compiled.map(() => 1), fillWeight];
    fill.weights = [...compiled.map(() => 1), 0]; // the fill always hands back
    compiled.push(fill);
  }
  return compiled;
}

/** The articulations that live BELOW buildBassGroove's density band boundary. */
const SPARSE_ARTICULATIONS = Object.freeze(['holdOne', 'longShort']);

/**
 * How the groove grammar moves the bass's density off the genre's own bias.
 * Both factors are levers the engine really has: `buildBassGroove` picks its
 * articulation menu by density band, and only reaches for a second syncopation
 * cell above density 0.6.
 */
function bassDensityDrive(groove) {
  const articulation = (Array.isArray(groove.articulation) ? groove.articulation : [])
    .filter((name) => typeof name === 'string');
  const sparse = articulation.length
    && articulation.every((name) => SPARSE_ARTICULATIONS.includes(name));
  const cells = (Array.isArray(groove.syncopationCells) ? groove.syncopationCells : [])
    .filter((cell) => typeof cell === 'string' && cell.trim()).length;
  return (sparse ? 0.8 : 1.1) * (1 + Math.min(cells, 3) * 0.1);
}

/**
 * How the anchor patterns move the AUTO kit's density, on the grammar path
 * only: the genre's mean anchor hit-rate against four-on-the-floor, bounded
 * either side so a sixteenth-grid anchor (minimalism's pulse) cannot compile
 * into a machine-gun and a one-hit drone anchor cannot silence the kit.
 */
function percussionDensityDrive(groove, timeSignature) {
  const anchors = (Array.isArray(groove.anchorPatterns) ? groove.anchorPatterns : [])
    .filter((mask) => typeof mask === 'string' && mask.trim());
  if (!anchors.length) return 1;
  const mean = anchors.reduce((sum, mask) => sum + maskHits(mask, timeSignature), 0) / anchors.length;
  return clamp(mean / 4, 0.5, 1.5);
}

/**
 * The genre's pocket as the engine's own lay-back dial. `BASS_POCKET` seconds
 * is what vary.timing 1 buys, so a genre asking for the full 22 ms gets 1 and a
 * genre asking for none gets a machine-tight line — which is what a 0 ms pocket
 * means in every one of the four straight genres that declares one.
 */
function pocketToTiming(pocketMs) {
  if (!Array.isArray(pocketMs) || pocketMs.length < 2) return null;
  const lo = numberOr(pocketMs[0], undefined);
  const hi = numberOr(pocketMs[1], undefined);
  if (lo === undefined || hi === undefined) return null;
  return round3(clamp((lo + hi) / 2 / 1000 / BASS_POCKET, 0, 1));
}

// -- the defiance dials -----------------------------------------------------

/**
 * Params whose numbers are an ENUM rather than a range: an interpolated dial
 * position has to land on one of them or the sanitiser drops it back to the
 * stored value. Only the harmonic rhythm is one today.
 */
const SNAP_TO = Object.freeze({
  'harmony.rhythm': HARMONY_RHYTHMS.filter((value) => typeof value === 'number'),
});

const nearest = (values, target) => values.reduce(
  (best, value) => (Math.abs(value - target) < Math.abs(best - target) ? value : best),
  values[0],
);

/**
 * What a dial reads at position `t` (0 = the genre's own end, 1 = the defiant
 * one). A string range is a list of states and lands on whichever the position
 * is nearest; a numeric range interpolates between its ends.
 */
function dialValue(dial, t) {
  const range = Array.isArray(dial.range) ? dial.range : null;
  if (!range || range.length < 2) return undefined;
  if (range.every((value) => typeof value === 'string')) {
    return range[clamp(Math.round(t * (range.length - 1)), 0, range.length - 1)];
  }
  const lo = numberOr(range[0], undefined);
  const hi = numberOr(range[range.length - 1], undefined);
  if (lo === undefined || hi === undefined) return undefined;
  const value = lo + t * (hi - lo);
  const snap = SNAP_TO[dial.param];
  return snap && snap.length ? nearest(snap, value) : round3(value);
}

/** Write `value` at a dotted params path, minting the objects on the way down. */
function setPath(target, path, value) {
  const keys = String(path).split('.').filter(Boolean);
  if (!keys.length) return;
  let node = target;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!isObject(node[keys[i]])) node[keys[i]] = {};
    node = node[keys[i]];
  }
  node[keys[keys.length - 1]] = value;
}

/**
 * The defiance overlay, applied LAST and only through the dials the genre
 * actually declares: `defiance` is keyed by a dial's `param` path and carries
 * its POSITION, 0–1, which is what a slider hands over. A key that names no
 * dial of this genre is ignored — a genre's escape hatches are its own.
 */
function applyDefiance(partial, dials, positions) {
  if (!isObject(positions)) return;
  for (const dial of Array.isArray(dials) ? dials : []) {
    if (!isObject(dial) || typeof dial.param !== 'string') continue;
    if (!Object.prototype.hasOwnProperty.call(positions, dial.param)) continue;
    const t = numberOr(positions[dial.param], undefined);
    if (t === undefined) continue;
    const value = dialValue(dial, clamp(t, 0, 1));
    if (value === undefined) continue;
    setPath(partial, dial.param, value);
  }
}

// -- the compiler ------------------------------------------------------------

/** The tracks that read a density; the pad has no event rate to scale. */
const DENSITY_TRACKS = Object.freeze(['bass', 'melody', 'texture', 'arp', 'percussion']);

/**
 * One genre, compiled into a full params object — sanitiser-clean, so it can go
 * straight into `createEngine()` / `setParams()`, be stored, or be shared.
 *
 * `rng` is the seed the draws come from (deterministic: the same rng replays
 * the same genre), and `defiance` is a map of dial `param` path → position 0–1,
 * overlaid after everything the genre itself asked for.
 */
export function compileGenre(genreJson, { rng = Math.random, defiance = {}, kitComplexity } = {}) {
  const genre = isObject(genreJson) ? genreJson : {};
  const essence = isObject(genre.essence) ? genre.essence : {};
  const language = isObject(essence.chordLanguage) ? essence.chordLanguage : {};
  const groove = isObject(essence.grooveGrammar) ? essence.grooveGrammar : {};
  const instrumentation = isObject(essence.instrumentation) ? essence.instrumentation : {};
  const perTrack = isObject(instrumentation.perTrack) ? instrumentation.perTrack : {};
  const fallbacks = isObject(genre.fallbackLists) ? genre.fallbackLists : {};

  // The draws, in the order the header fixes.
  const timeSignature = weightedPick(essence.timeSignatures, rng, Object.keys(TIME_SIGNATURES));
  const mode = weightedPick(essence.modes, rng, Object.keys(SCALES));
  const bpm = betweenRange(essence.bpm, rng);
  const swing = betweenRange(essence.swing, rng);
  const rhythm = weightedPick(language.harmonicRhythm, rng, HARMONY_RHYTHMS);
  const structure = weightedPick(essence.energyArc, rng, STRUCTURES);
  const progression = expandProgression(genre, rng);

  const metre = timeSignature ?? '4/4';
  const partial = {};
  if (typeof genre.slug === 'string') partial.genre = genre.slug;
  if (timeSignature) partial.timeSignature = timeSignature;
  if (mode) partial.mode = mode;
  if (bpm !== undefined) partial.bpm = round3(bpm);
  if (swing !== undefined) partial.swing = round3(swing);
  if (structure) partial.structure = structure;
  // The expanded loop itself, in the engine's own hook-seed grammar: the
  // symbols that parsed, in the order the grammar wrote them.
  partial.harmony = {
    rhythm: rhythm ?? 'auto',
    seed: progression.chords.map((chord) => chord.token),
  };

  // The hook's loop length, inverted out of buildHook's own law, and the colour
  // the expanded grammar is asking the chord stack for.
  const length = clamp(progression.chords.length || HOOK_MIN_CHORDS, HOOK_MIN_CHORDS, HOOK_MAX_CHORDS);
  partial.repetition = round3(clamp(
    1 - (length - HOOK_MIN_CHORDS) / (HOOK_MAX_CHORDS - HOOK_MIN_CHORDS), 0, 1,
  ));
  partial.complexity = round3(clamp(
    (numberOr(language.extensionBias, 0.5) + progression.colour) / 2, 0, 1,
  ));

  const reverbTail = numberOr(instrumentation.reverbTail, undefined);
  if (reverbTail !== undefined) partial.reverbTail = reverbTail;
  if (isObject(instrumentation.patches)) partial.patches = instrumentation.patches;

  // Dissonance ships as the genre's RANGE, so the tuned tracks drift inside the
  // band the director set rather than sitting on one value of it forever.
  const range = Array.isArray(essence.dissonanceRange) ? essence.dissonanceRange : null;
  const lo = range ? numberOr(range[0], undefined) : undefined;
  const hi = range ? numberOr(range[1], undefined) : undefined;
  const dissonance = lo === undefined || hi === undefined ? undefined
    : lo === hi ? lo : { min: Math.min(lo, hi), max: Math.max(lo, hi) };

  const kit = compileKit(fallbacks.grooves, metre, kitComplexity);
  const bias = clamp(numberOr(essence.densityBias, 1), 0, 2);
  const bassDrive = bassDensityDrive(groove);
  const percussionDrive = kit ? 1 : percussionDensityDrive(groove, metre);
  const timing = pocketToTiming(groove.pocketMs);

  const tracks = {};
  for (const name of TRACK_ORDER) {
    const spec = isObject(perTrack[name]) ? perTrack[name] : null;
    const track = {};
    if (spec) {
      if (TRACK_STATES.includes(spec.state)) track.state = spec.state;
      if (typeof spec.voice === 'string' && spec.voice.trim()) track.voice = spec.voice.trim();
      // level and randomness take number OR { min, max } — the sanitiser reads
      // both, and clamping them here would only hide a bad file.
      if (spec.level !== undefined) track.level = spec.level;
      if (spec.randomness !== undefined) track.randomness = spec.randomness;
    }
    if (dissonance !== undefined && TUNED_TRACKS.includes(name)) track.dissonance = dissonance;
    if (DENSITY_TRACKS.includes(name)) {
      const drive = name === 'bass' ? bassDrive : name === 'percussion' ? percussionDrive : 1;
      track.density = round3(clamp(bias * drive, 0, 2));
    }
    if (name === 'bass' && timing !== null) track.vary = { timing };
    if (name === 'percussion' && kit) track.sequencers = kit;
    if (Object.keys(track).length) tracks[name] = track;
  }
  if (Object.keys(tracks).length) partial.tracks = tracks;

  applyDefiance(partial, genre.defiance, defiance);
  return sanitiseParams(partial);
}
