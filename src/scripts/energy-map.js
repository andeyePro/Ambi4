/**
 * The Energy dial's mapping — ONE copy, imported by the page and by
 * tests/energy-measure.mjs.
 *
 * Before this module the knot table lived only inside index.astro, and the
 * measurement suite kept its own copy. The copy went stale at v0.0.71 (the
 * knots were widened and the tempo coupling removed) and the suite went on
 * measuring a mapping nobody shipped. A table both sides import cannot drift.
 *
 * v0.0.71: Energy no longer touches tempo. Owner: "Personally I don't think
 * Tempo and Energy should be conflated. [...] in most modern western genres
 * you don't want to vary the tempo, but you definitely do want to vary the
 * energy." Energy is how much is going on; tempo is a property of the piece.
 *
 * Tempo was doing most of the work, though, so the knots were widened to span
 * 0.04 to 1.00 rather than 0.10 to 0.95, with a steeper lower half — the
 * structure thresholds and the auto-track ladder are what Energy has left,
 * and it has to cross more of them. Moving a knot CHANGES THE SHIPPED SOUND
 * away from the default, so the frozen audio reference moves with it.
 *
 * Pure arithmetic, no imports: safe to load in Node.
 */

/** The dial's default travel — complexity 0.42, the shipped default sound. */
export const ENERGY_DEFAULT = 0.35;

/** Energy → complexity, as [energy, complexity] knots, interpolated linearly. */
export const ENERGY_COMPLEXITY_KNOTS = Object.freeze([
  [0.0, 0.04], [0.2, 0.28], [0.35, 0.42], [0.55, 0.62], [0.8, 0.85], [1.0, 1.0],
].map((knot) => Object.freeze(knot)));

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** Energy → complexity, piecewise-linear through ENERGY_COMPLEXITY_KNOTS. */
export function complexityFromEnergy(e) {
  const knots = ENERGY_COMPLEXITY_KNOTS;
  const x = clamp01(e);
  for (let i = 1; i < knots.length; i++) {
    const [x1, y1] = knots[i - 1];
    const [x2, y2] = knots[i];
    if (x <= x2) return y1 + ((x - x1) / (x2 - x1)) * (y2 - y1);
  }
  return knots[knots.length - 1][1];
}

/**
 * The inverse, so the Energy dial reads back from the thing it drives. Takes
 * a scalar complexity; the page resolves a span to its midpoint first.
 */
export function energyFromComplexity(c) {
  const knots = ENERGY_COMPLEXITY_KNOTS;
  const y = clamp01(c);
  if (y <= knots[0][1]) return knots[0][0];
  for (let i = 1; i < knots.length; i++) {
    const [x1, y1] = knots[i - 1];
    const [x2, y2] = knots[i];
    if (y <= y2) return y2 === y1 ? x1 : x1 + ((y - y1) / (y2 - y1)) * (x2 - x1);
  }
  return knots[knots.length - 1][0];
}
