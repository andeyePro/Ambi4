/**
 * The Vowel filter's formant table and its level law — the design the
 * 2026-09-25 deferral asked for (TODO "Unit 7"; docs/synthesis-programme.md
 * § 2, the Formant / vowel row).
 *
 * Why this is not one more biquad in the filter menu: a vowel is two (here
 * three) resonances whose second is NOT a function of the first — /u/ and /i/
 * have nearly the same F1 and F2s an octave and a half apart — so no single
 * cutoff in Hz can say which vowel you hear. The filter is therefore a bank
 * of parallel band-passes at a vowel table, chosen by a POSITION along
 * u–o–a–e–i (`patch.filter.vowel`, 0..4), with its own dial and its own words.
 *
 * Pure: no DOM, no audio graph, no engine import. engine-voices.js builds the
 * bank from `vowelBank()`, scope.js draws the same response, and
 * tests/vowel-filter-smoke.mjs holds the laws in Node.
 */

/** The positions' names, in dial order. Index = position. */
export const VOWELS = Object.freeze(['u', 'o', 'a', 'e', 'i']);

/**
 * F1, F2, F3 in Hz — Peterson & Barney (1952), adult male means, for the
 * vowels of "boot", "bought", "father", "bet" and "beet". The order walks F2
 * from the back of the mouth to the front, which is why a sweep along the dial
 * sounds like one mouth opening and closing rather than a jump between five.
 */
export const VOWEL_TABLE = Object.freeze([
  Object.freeze([300, 870, 2240]),   // u
  Object.freeze([570, 840, 2410]),   // o
  Object.freeze([730, 1090, 2440]),  // a
  Object.freeze([530, 1840, 2480]),  // e
  Object.freeze([270, 2290, 3010]),  // i
]);

/**
 * The formants' relative levels before the bank is normalised: F2 6 dB under
 * F1 and F3 12 dB under, the usual synthesis simplification of a voice's
 * falling spectral envelope.
 */
export const FORMANT_LEVELS = Object.freeze([1, 0.5, 0.25]);

/** Where a vowel dial rests when a patch has never set it: 'a', the middle. */
export const VOWEL_HOME = 2;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Position → the name the readout prints: 'a' on a letter, 'a~e' between. */
export function vowelName(position) {
  const v = clamp(Number.isFinite(position) ? position : VOWEL_HOME, 0, VOWELS.length - 1);
  const r = Math.round(v);
  if (Math.abs(v - r) < 0.05) return VOWELS[r];
  return `${VOWELS[Math.floor(v)]}~${VOWELS[Math.ceil(v)]}`;
}

/**
 * The formant frequencies at a position: between two table rows each formant
 * moves GEOMETRICALLY (equal ratios per step), which is how pitch-like
 * quantities are heard; on a whole position it is the table row exactly.
 */
export function formantsAt(position) {
  const top = VOWEL_TABLE.length - 1;
  const v = clamp(Number.isFinite(position) ? position : VOWEL_HOME, 0, top);
  const lo = Math.floor(v);
  const hi = Math.min(top, lo + 1);
  const t = v - lo;
  return VOWEL_TABLE[lo].map((f, k) => f * Math.pow(VOWEL_TABLE[hi][k] / f, t));
}

/**
 * The Resonance dial (0.1–20) read as formant Q. At the dial's usual 0.7 the
 * formants are ~4 wide — a vowel you can name — and at 20 they whistle; the
 * square root keeps the dial's log travel even.
 */
export function formantQ(q) {
  return 5 * Math.sqrt(clamp(Number.isFinite(q) ? q : 0.7, 0.1, 20));
}

/**
 * The complex response of one Web Audio band-pass (the spec's constant-0-dB-
 * peak biquad: b0 = α, b2 = −α, a0 = 1 + α, a1 = −2cos ω0, a2 = 1 − α, α =
 * sin ω0 / 2Q) at frequency f. Exact, not an approximation, so the level law
 * below is computed on the filter that actually plays.
 */
export function bandpassResponse(f, centre, Q, sampleRate) {
  const w0 = (2 * Math.PI * centre) / sampleRate;
  const alpha = Math.sin(w0) / (2 * Q);
  const a0 = 1 + alpha;
  const a1 = -2 * Math.cos(w0);
  const a2 = 1 - alpha;
  const w = (2 * Math.PI * f) / sampleRate;
  const c1 = Math.cos(w); const s1 = Math.sin(w);
  const c2 = Math.cos(2 * w); const s2 = Math.sin(2 * w);
  // numerator alpha (1 - z^-2), denominator a0 + a1 z^-1 + a2 z^-2, z^-1 = e^{-jw}
  const nr = alpha * (1 - c2); const ni = alpha * s2;
  const dr = a0 + a1 * c1 + a2 * c2; const di = -(a1 * s1 + a2 * s2);
  const den = dr * dr + di * di;
  return { re: (nr * dr + ni * di) / den, im: (ni * dr - nr * di) / den };
}

/** |Σ gain_k · H_k(f)| — the whole bank's magnitude at f. */
export function bankMagnitude(f, bank, sampleRate) {
  let re = 0; let im = 0;
  bank.freqs.forEach((centre, k) => {
    const h = bandpassResponse(f, centre, bank.Q, sampleRate);
    re += bank.gains[k] * h.re;
    im += bank.gains[k] * h.im;
  });
  return Math.hypot(re, im);
}

/** A dense log grid plus the centres — where a test or a trace samples the response. */
export function lawGrid(freqs, sampleRate, points = 240) {
  const lo = 40;
  const hi = Math.min(12000, sampleRate * 0.45);
  const grid = Array.from({ length: points }, (_, i) => lo * Math.pow(hi / lo, i / (points - 1)));
  return grid.concat(freqs);
}

const LEVEL_SUM = FORMANT_LEVELS.reduce((a, b) => a + b, 0);

/**
 * The bank a patch asks for: centres, one Q, and per-formant gains.
 *
 * The level law: the gains are FORMANT_LEVELS scaled to SUM TO 1. Each Web
 * Audio band-pass peaks at exactly 0 dB, so by the triangle inequality the
 * bank's response is at most 1 at every frequency, at any position and any
 * Q — nothing a patch sets adds gain (the house rule), and it holds under
 * the same accounting tests/voices-smoke.mjs applies to every voice: the
 * gains along every source-to-bus path, a filter counted as unity, summed.
 *
 * A tighter normalisation was tried first (scale so the bank's computed
 * PEAK response is exactly 1): it is ~4 dB louder at the vowel's peak, but
 * its parallel paths sum to as much as 1.6, and the call voices then failed
 * voices-smoke's concurrent-peak law (2.1 against 1). The provable law won;
 * what it costs is measured in tests/vowel-filter-smoke.mjs.
 */
export function vowelBank(position, q) {
  const freqs = formantsAt(position);
  return Object.freeze({
    freqs: Object.freeze(freqs),
    Q: formantQ(q),
    gains: Object.freeze(FORMANT_LEVELS.map((l) => l / LEVEL_SUM)),
  });
}
