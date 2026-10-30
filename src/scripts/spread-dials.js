/**
 * The dissolved Randomise row (D8, docs/dial-control-plane-plan.md) — the
 * one table both the engine and the page read, so the field map, the
 * Randomness macro patch and the decode-side shim exist in exactly one place.
 *
 * Until v0.0.275 every track carried `vary = { voice, volume, pitch, timing,
 * pan }`: five 0-1 amounts (or null, "follow this track's Randomness") on a
 * row of their own — a second randomness system beside the min-max spread
 * every dial already had. They are now ordinary dials beside the thing each
 * one affects:
 *
 *   vary.pan     -> `pan`           a spread on the Pan dial. The spread IS
 *                                   the per-note scatter: notes land between
 *                                   its two ends. a -> { min: -a/2, max: a/2 }
 *                                   (the old law was ±0.5·a about the
 *                                   track's own placement).
 *   vary.timing  -> `timing`        a spread on the Timing dial, in units of
 *                                   TIMING_SPREAD (25 ms). Its width is the
 *                                   humanisation, its centre a steady push or
 *                                   drag. a -> { min: -a, max: a }.
 *   vary.volume  -> `dynamics`      how much the track's loudness breathes: a
 *                                   slow ±6 dB swing around Level and a ±15 %
 *                                   accent jitter on every note. a -> a.
 *   vary.pitch   -> `octaveWander`  the occasional octave jump — all the
 *                                   pitch aspect ever did at the engine (the
 *                                   `passing` argument it was meant to feed in
 *                                   generatePhrase was never wired). a -> a.
 *   vary.voice   -> `voiceWander`   the voice wander law the voice rule's
 *                                   Chance falls back to. a -> a.
 *   (new)        -> `passingNotes`  the Passing notes dial: in-mode passing and
 *                                   neighbour tones, drawn after Dissonance.
 *   null         -> the dial's id in `macroPatch` — the track's Randomness
 *                   macro patched to that dial (its width or amount IS the
 *                   macro's value), the D8 replacement for the Auto detent.
 *
 * Every mapping is exact in floating point (halving and doubling are), so a
 * migrated piece renders to the byte: tests/vary-migration-smoke.mjs.
 *
 * The one lossy case: a SPAN on vary.pan or vary.timing was an amount that
 * walked bar by bar; a spread's width is fixed, so it lands on its middle.
 * A span on the three scalar aspects stays a span and walks exactly as
 * before — under the same walk keys, which is why DIAL_WALK_KEY keeps the
 * old spellings: walk keys are wire (walkHold, sampling, routing name them),
 * and serialised keys never rename.
 *
 * PURE MODULE: no DOM, no audio, no imports.
 */

/** The legacy aspects, in their v6 order — the shim's input vocabulary. */
export const VARY_ASPECTS = Object.freeze(['voice', 'volume', 'pitch', 'timing', 'pan']);

/** Legacy aspect -> the field it became. */
export const VARY_TO_DIAL = Object.freeze({
  voice: 'voiceWander',
  volume: 'dynamics',
  pitch: 'octaveWander',
  timing: 'timing',
  pan: 'pan',
});

/** The dials the Randomness macro can be patched to, in canonical order. */
export const MACRO_DIALS = Object.freeze(['dynamics', 'timing', 'pan', 'octaveWander', 'voiceWander']);

/** Every dissolved field and its stored domain. */
export const DIAL_DOMAIN = Object.freeze({
  pan: Object.freeze([-1, 1]),
  timing: Object.freeze([-1, 1]),
  dynamics: Object.freeze([0, 1]),
  octaveWander: Object.freeze([0, 1]),
  voiceWander: Object.freeze([0, 1]),
  passingNotes: Object.freeze([0, 1]),
});

/**
 * The walk key a SPANNED scalar dial walks under. The three that came from
 * vary keep their old spelling (see the header); pan and timing do not walk
 * at all — their spread is drawn per note.
 */
export const DIAL_WALK_KEY = Object.freeze({
  dynamics: 'vary.volume',
  octaveWander: 'vary.pitch',
  voiceWander: 'vary.voice',
  passingNotes: 'passingNotes',
});

/** Per-note pan scatter at macro 1 (the old vary.pan law): ±0.5. */
export const PAN_SPREAD = 0.5;
/** Seconds of humanisation at timing half-width 1 (the old vary.timing law). */
export const TIMING_SPREAD = 0.025;

/**
 * Which dials a track's editor shows: only the ones that act on it. The
 * Randomise row showed all five everywhere, and on a bass Pan and Pitch did
 * nothing at all — the bass is centred and never wanders an octave.
 */
export function spreadDialsFor(track, family = null) {
  const builtin = {
    pad: ['pan', 'timing', 'dynamics'],
    bass: ['timing', 'dynamics'],
    melody: ['pan', 'timing', 'dynamics', 'octaveWander', 'passingNotes'],
    texture: ['pan', 'timing', 'dynamics', 'octaveWander', 'passingNotes'],
    arp: ['pan', 'timing', 'dynamics', 'octaveWander'],
    percussion: ['pan', 'timing', 'dynamics'],
  };
  if (builtin[track]) return builtin[track];
  // A user kit's hits are placed by the built-in kit's pan law (percussionPan),
  // so a Pan dial on one would move nothing; a user line has every dial.
  return family === 'percussive'
    ? ['timing', 'dynamics']
    : ['pan', 'timing', 'dynamics', 'octaveWander', 'passingNotes'];
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** A legacy aspect amount, clamped: a number, a {min,max} span, or undefined (junk). */
function legacyAmount(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return clamp01(raw);
  if (isPlainObject(raw) && Number.isFinite(raw.min) && Number.isFinite(raw.max)) {
    let min = clamp01(raw.min);
    let max = clamp01(raw.max);
    if (min > max) [min, max] = [max, min];
    return { min, max };
  }
  return undefined;
}

/** One legacy amount as the value of the dial it became. */
export function dialValueFromVary(dial, amount) {
  if (dial === 'pan' || dial === 'timing') {
    const a = isPlainObject(amount) ? (amount.min + amount.max) / 2 : amount;
    if (a === 0) return 0;
    return dial === 'pan' ? { min: -0.5 * a, max: 0.5 * a } : { min: -a, max: a };
  }
  return isPlainObject(amount) ? { min: amount.min, max: amount.max } : amount;
}

/** A macroPatch list, cleaned: known ids only, once each, canonical order. */
export function cleanMacroPatch(list) {
  if (!Array.isArray(list)) return undefined;
  return MACRO_DIALS.filter((id) => list.includes(id));
}

/**
 * THE SHIM — fold a legacy `vary` block into the new fields. Writes each
 * aspect the block names into `target` (null -> patched, a number or span ->
 * the dial's value and unpatched; junk -> left as it was, which is what the
 * old sanitiser did with junk), and returns the macroPatch list that results.
 * Aspects the block does not name are untouched, so a partial folds aspect
 * by aspect exactly as a partial vary merged. Lives forever: share links
 * carrying vary.* never expire.
 */
export function foldLegacyVary(vary, target, macroPatch) {
  const list = new Set(cleanMacroPatch(macroPatch) || []);
  if (!isPlainObject(vary)) return MACRO_DIALS.filter((id) => list.has(id));
  for (const aspect of VARY_ASPECTS) {
    if (!(aspect in vary)) continue;
    const dial = VARY_TO_DIAL[aspect];
    const raw = vary[aspect];
    if (raw === null) {
      list.add(dial);
      continue;
    }
    const amount = legacyAmount(raw);
    if (amount === undefined) continue;
    target[dial] = dialValueFromVary(dial, amount);
    list.delete(dial);
  }
  return MACRO_DIALS.filter((id) => list.has(id));
}

/** A spread dial's value as its centre and full width (a number has width 0). */
export function spreadOf(value) {
  if (isPlainObject(value)) return { centre: (value.min + value.max) / 2, width: value.max - value.min };
  return { centre: typeof value === 'number' ? value : 0, width: 0 };
}
