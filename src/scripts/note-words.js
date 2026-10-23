/**
 * Why a note sounds — a 'note' event's `source` and `development`, in words.
 *
 * The grid's tooltip and aria-label say what each sounding note IS (its
 * `role` against the chord); this says WHY the app chose it. One phrase per
 * value of NOTE_SOURCES (ambient-engine.js), written from what the code that
 * emits each value actually does, so the grid never credits a note with a
 * reason it did not have. Pure: no DOM, no engine import.
 * tests/page-boot.mjs holds every NOTE_SOURCES value to an entry here.
 */
export const SOURCE_WORDS = Object.freeze({
  // pad
  voicing: 'the chord struck as it begins',
  breath: 'the chord re-struck halfway through the bar',
  closing: 'the closing chord of the final bar',
  // the safety floor, on every track that has one
  cover: 'a note added so the track is never silent',
  // bass
  'groove-root': 'the bass groove playing the chord’s root',
  'groove-fifth': 'the bass groove playing the chord’s fifth',
  'groove-octave': 'the bass groove playing the root an octave up',
  approach: 'leaning into the next chord',
  'owed-root': 'the root an emptied bass pattern still plays',
  // melody
  motif: 'from the motif',
  lean: 'a dissonant lean off the motif’s note',
  grace: 'an ornament leaning into the next note',
  cadence: 'a cadence, pulled onto a chord tone to end the phrase',
  // arp
  figure: 'a step of the arpeggio figure',
  phase: 'the phased copy of the figure',
  cell: 'a slot of the additive cell',
  double: 'an octave double beside a lead note',
  // texture
  drift: 'a drifting texture note',
  // hand-sequenced / hand-played
  step: 'from your step grid',
  live: 'played by hand',
});

/** The motif's developments (MOTIF_OPS), as the clause that follows the source. */
export const DEVELOPMENT_WORDS = Object.freeze({
  repeat: 'as first stated',
  transpose: 'transposed',
  displace: 'pushed later in the bar',
  invert: 'inverted',
  retrograde: 'played backwards',
});

/** Sources a melody bar's development applies to. */
const DEVELOPED = new Set(['motif', 'lean', 'grace', 'cadence']);

/** "from the motif, transposed" / "leaning into the next chord"; '' if unknown. */
export function whyWords(source, development = null) {
  const base = typeof source === 'string' ? SOURCE_WORDS[source] : null;
  if (!base) return '';
  const dev = typeof development === 'string' && DEVELOPED.has(source)
    ? DEVELOPMENT_WORDS[development] : null;
  return dev ? `${base}, ${dev}` : base;
}
