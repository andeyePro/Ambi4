/**
 * Follow my chords — the notes a person HOLDS on a keyboard choose the
 * piece's harmony (TODO "Derive a chord sequence from a played MIDI
 * keyboard", the live half; v0.0.155's deriveChordsFromTrack is the
 * after-the-fact half).
 *
 * Pure: a set of held MIDI notes plus the piece's root and mode in, the best
 * fitting diatonic chord DEGREE out — in the engine's own mode-relative
 * degrees (0 is the tonic), the same numbers the hook's loop is written in.
 * The chord on degree d is the one the engine builds there: scale steps d,
 * d+2, d+4 (the triad) and d+6 (the seventh), taken round the mode, so a
 * pentatonic or a whole-tone piece is scored against the chords it actually
 * plays rather than against a major-key idea of them.
 *
 * The rules, each its own number below so a test can name it:
 *  - every distinct held pitch class scores against each degree: a triad
 *    tone +1, the seventh +SEVENTH, another note of the mode PASSING (it is
 *    not that chord), a note off the mode OUTSIDE (it fits no chord here);
 *  - the LOWEST held note is the bass: when it is the degree's root, +ROOT;
 *    so an inversion still names its chord, but a bass breaks a near tie;
 *  - a lone held note is the degree it is the root of, when it is in the
 *    mode — the plain "play a C, get a C chord" a beginner expects;
 *  - ties go to the CURRENT chord, so a held set two chords share never
 *    yanks the harmony away from what is sounding; otherwise to the lowest
 *    degree, so the answer is deterministic;
 *  - a set that fits nothing — no triad tone of the best degree held, or a
 *    best score that is not above zero — holds the current chord (returns
 *    `current`, which may be null: "nothing to follow").
 */
//
// No imports, on purpose: the page loads the engine dynamically (so a browser
// that cannot run it still boots), and this module must not drag the engine
// into the page's first bundle. The caller passes the mode as its semitone
// list — SCALES[mode] from the engine — and the root as a pitch class or a
// note name.

export const FOLLOW_WEIGHTS = Object.freeze({
  TRIAD: 1,
  SEVENTH: 0.6,
  PASSING: -0.5,
  OUTSIDE: -1,
  ROOT: 0.75,
});

const mod = (value, n) => ((value % n) + n) % n;

function scaleFor(mode) {
  return Array.isArray(mode) && mode.length && mode.every(Number.isInteger) ? mode : null;
}

const LETTERS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function rootPcOf(root) {
  if (Number.isInteger(root)) return mod(root, 12);
  const match = typeof root === 'string' ? /^\s*([A-Ga-g])([#b♯♭]?)/.exec(root) : null;
  if (!match) return 0;
  const shift = match[2] === '#' || match[2] === '♯' ? 1 : match[2] ? -1 : 0;
  return mod(LETTERS[match[1].toUpperCase()] + shift, 12);
}

/** The held notes as clean, distinct MIDI numbers, lowest first. */
function cleanHeld(held) {
  const out = new Set();
  for (const value of held ? [...held] : []) {
    const midi = Math.round(Number(value));
    if (Number.isFinite(midi) && midi >= 0 && midi <= 127) out.add(midi);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * The chord tones of degree `d` as pitch classes relative to the root:
 * { triad: Set, seventh: number }.
 */
export function degreeTones(scale, d) {
  const n = scale.length;
  return {
    triad: new Set([scale[mod(d, n)], scale[mod(d + 2, n)], scale[mod(d + 4, n)]]),
    seventh: scale[mod(d + 6, n)],
    root: scale[mod(d, n)],
  };
}

/**
 * `mode` is the mode's semitone list (the engine's SCALES[mode]).
 *
 * Score every degree of the mode against the held notes. Returns one entry
 * per degree, { degree, score, triadHits }, in degree order. Pure.
 */
export function scoreDegrees(held, { root = 'C', mode } = {}) {
  const scale = scaleFor(mode);
  const notes = cleanHeld(held);
  if (!scale || !scale.length || !notes.length) return [];
  const rootPc = rootPcOf(root);
  const inMode = new Set(scale);
  const pcs = [...new Set(notes.map((midi) => mod(midi - rootPc, 12)))];
  const bass = mod(notes[0] - rootPc, 12);
  const W = FOLLOW_WEIGHTS;
  return scale.map((_, degree) => {
    const tones = degreeTones(scale, degree);
    let score = 0;
    let triadHits = 0;
    for (const pc of pcs) {
      if (tones.triad.has(pc)) {
        score += W.TRIAD;
        triadHits += 1;
      } else if (pc === tones.seventh) score += W.SEVENTH;
      else if (inMode.has(pc)) score += W.PASSING;
      else score += W.OUTSIDE;
    }
    if (bass === tones.root) score += W.ROOT;
    return { degree, score, triadHits };
  });
}

/**
 * The degree the held notes ask for, or `current` when they fit nothing.
 * `current` is the chord now sounding (a degree, or null) — it wins ties.
 */
export function followDegree(held, { root = 'C', mode, current = null } = {}) {
  const scale = scaleFor(mode);
  const notes = cleanHeld(held);
  const hold = Number.isInteger(current) ? current : null;
  if (!scale || !scale.length || !notes.length) return hold;
  const rootPc = rootPcOf(root);
  const pcs = new Set(notes.map((midi) => mod(midi - rootPc, 12)));
  // A lone note: the degree it is the root of, when the mode has it. (The
  // whole-tone mode's triads are shared three ways; this is what makes one
  // finger still mean one chord there.)
  if (pcs.size === 1) {
    const index = scale.indexOf([...pcs][0]);
    return index >= 0 ? index : hold;
  }
  const scores = scoreDegrees(notes, { root: rootPc, mode: scale });
  let best = -Infinity;
  for (const entry of scores) best = Math.max(best, entry.score);
  const top = scores.filter((entry) => Math.abs(entry.score - best) < 1e-9);
  if (!(best > 0) || top.every((entry) => entry.triadHits === 0)) return hold;
  if (hold !== null && top.some((entry) => entry.degree === mod(hold, scale.length))) {
    return mod(hold, scale.length);
  }
  return top[0].degree;
}

export default followDegree;
