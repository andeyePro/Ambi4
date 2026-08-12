/**
 * harmonise.js — a melody's pinned steps → the diatonic chord loop that fits.
 *
 * His compose brief, entry point one: "Play or type a melody, chords derived
 * algorithmically on request." This is the derivation: pure, deterministic,
 * import-safe in Node (no DOM, no audio), tested in tests/harmonise-smoke.mjs.
 *
 * How it decides, in one paragraph. Each bar's notes are mapped onto the
 * current scale; notes off the scale are chromatic passing notes and carry no
 * harmonic evidence. A note ON a beat weighs more than one between beats, and
 * the downbeat most of all, because that is where an ear hears the chord
 * change. Every diatonic triad (built the way the engine builds them — scale
 * steps 1-3-5) is scored per bar, and one pass of dynamic programming picks
 * the loop: fourth/fifth root motion is worth a little, sitting still costs a
 * little, an empty bar CARRIES its chord rather than wandering, and the loop
 * prefers to start and end at home. No randomness anywhere: the same melody
 * always yields the same chords, which is what lets a person argue with it.
 */

/** Upper case throughout — the engine's mode decides major/minor, not the case. */
const NUMERALS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

const SAME_CHORD_PENALTY = -0.4;
const CADENTIAL_MOTION_BONUS = 0.3;   // root moves a fourth or fifth
const EMPTY_BAR_CARRY_BONUS = 0.3;    // an empty bar keeps its chord
const HOME_START_BONUS = 0.5;
const HOME_END_BONUS = 0.5;
const DOMINANT_END_BONUS = 0.2;
const OFFBEAT_WEIGHT = 1;
const ONBEAT_WEIGHT = 2;
const DOWNBEAT_WEIGHT = 3;
const NONCHORD_ONBEAT_PENALTY = 0.5;  // per weight unit, on-beat notes only
const DOWNBEAT_ROOT_BONUS = 0.75;

/** The triad on a degree, as scale indices — steps 1, 3 and 5 of the scale. */
function chordToneIndices(degree, scaleLength) {
  return [0, 2, 4].map((step) => (degree + step) % scaleLength);
}

/**
 * Derive a chord loop from bars of pinned steps.
 *
 * @param bars   Array of bars; each bar an array of { slot, midi }.
 * @param scale  Semitone offsets from the root (the engine's SCALES entry).
 * @param rootPc Pitch class of the key's root (0 = C).
 * @param pulseSlots Slots where the metre's beats start, for this grid.
 * @param maxChords The engine's seed cap (HOOK_MAX_CHORDS is 8).
 * @returns { perBar, numerals, emptyBars, pitched } — or null when nothing
 *          in the bars carries a pitch the scale knows.
 */
export function deriveChords(bars, { scale, rootPc = 0, pulseSlots = [], maxChords = 8 }) {
  if (!Array.isArray(bars) || !bars.length || !Array.isArray(scale) || !scale.length) return null;
  const considered = bars.slice(0, Math.max(1, maxChords));
  const scaleIndexOf = new Map(scale.map((semi, index) => [((semi % 12) + 12) % 12, index]));
  const beats = new Set(pulseSlots);

  // Each bar reduced to { degree, weight, downbeat } notes the scale knows.
  let pitched = 0;
  const barNotes = considered.map((bar) => {
    const notes = [];
    for (const step of Array.isArray(bar) ? bar : []) {
      if (!step || !Number.isFinite(step.midi)) continue;
      const pc = ((Math.round(step.midi) - rootPc) % 12 + 12) % 12;
      const degree = scaleIndexOf.get(pc);
      if (degree === undefined) continue; // chromatic: no harmonic evidence
      const downbeat = step.slot === 0;
      const weight = downbeat ? DOWNBEAT_WEIGHT : beats.has(step.slot) ? ONBEAT_WEIGHT : OFFBEAT_WEIGHT;
      notes.push({ degree, weight, onbeat: downbeat || beats.has(step.slot), downbeat });
      pitched += 1;
    }
    return notes;
  });
  if (!pitched) return null;

  // Chords a roman numeral can say: at most seven, whatever the scale's size.
  const candidates = Math.min(scale.length, NUMERALS.length);
  const tones = Array.from({ length: candidates }, (_, d) =>
    new Set(chordToneIndices(d, scale.length)));

  const fitScore = (notes, d) => {
    let score = 0;
    for (const n of notes) {
      if (tones[d].has(n.degree)) {
        score += n.weight;
        if (n.downbeat && n.degree === d % scale.length) score += DOWNBEAT_ROOT_BONUS;
      } else if (n.onbeat) {
        score -= NONCHORD_ONBEAT_PENALTY * n.weight;
      }
    }
    return score;
  };

  const transition = (from, to, nextBarEmpty) => {
    if (nextBarEmpty) return to === from ? EMPTY_BAR_CARRY_BONUS : 0;
    if (to === from) return SAME_CHORD_PENALTY;
    if (scale.length === 7
      && (to === (from + 3) % 7 || to === (from + 4) % 7)) return CADENTIAL_MOTION_BONUS;
    return 0;
  };

  // Viterbi over bars. Ties break toward the LOWER degree (strict >), so the
  // result is stable rather than an accident of iteration order.
  const nBars = barNotes.length;
  let best = Array.from({ length: candidates }, (_, d) =>
    fitScore(barNotes[0], d) + (d === 0 ? HOME_START_BONUS : 0));
  const back = [];
  for (let bar = 1; bar < nBars; bar += 1) {
    const empty = barNotes[bar].length === 0;
    const next = new Array(candidates);
    const from = new Array(candidates);
    for (let d = 0; d < candidates; d += 1) {
      const fit = fitScore(barNotes[bar], d);
      let bestPrev = 0;
      let bestScore = -Infinity;
      for (let p = 0; p < candidates; p += 1) {
        const score = best[p] + transition(p, d, empty);
        if (score > bestScore) { bestScore = score; bestPrev = p; }
      }
      next[d] = bestScore + fit;
      from[d] = bestPrev;
    }
    best = next;
    back.push(from);
  }

  let last = 0;
  let lastScore = -Infinity;
  for (let d = 0; d < candidates; d += 1) {
    const end = best[d]
      + (d === 0 ? HOME_END_BONUS : 0)
      + (d === 4 && candidates > 4 ? DOMINANT_END_BONUS : 0);
    if (end > lastScore) { lastScore = end; last = d; }
  }
  const perBar = [last];
  for (let bar = nBars - 1; bar >= 1; bar -= 1) {
    perBar.unshift(back[bar - 1][perBar[0]]);
  }

  // The loop is the melody's smallest repeating period: four bars of the same
  // chord are ONE chord, and I V I V is I V.
  let period = perBar.length;
  for (let p = 1; p < perBar.length; p += 1) {
    if (perBar.length % p !== 0) continue;
    if (perBar.every((d, i) => d === perBar[i % p])) { period = p; break; }
  }
  const numerals = perBar.slice(0, period).map((d) => NUMERALS[d]);

  const emptyBars = barNotes.filter((notes) => !notes.length).length;
  return { perBar, numerals, emptyBars, pitched };
}
