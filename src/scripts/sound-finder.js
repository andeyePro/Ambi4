/**
 * The sound-in-mind finder — unit 16 of docs/synthesis-programme.md (§ 4,
 * layer 4). A person picks WORDS, not methods: bright or dark, plucky or
 * sustained, clean or gritty, warm or glassy, thick or thin, still or moving.
 * The finder answers with a starting voice on the track they are on, the
 * engine it is, and the dial moves that carry it there — and says why in a
 * line. It is a lookup, not an AI: every row below is a claim a person can
 * check by ear and the render suite can check by measurement.
 *
 * Pure: no DOM, no audio, no engine import. `tests/sound-finder-smoke.mjs`
 * holds the table's referential integrity in Node — every voice named exists
 * and is of the engine claimed, every dial named is a registry row the voice
 * exposes, every direction is up or down — and the measured proof (bright
 * moves the spectral centroid up, plucky shortens attack-to-peak, sustained
 * raises the RMS at one second, moving raises the RMS modulation) lives in
 * tests/pending/sound-finder-render-drive.mjs until the bridge key returns.
 *
 * Shape: one entry per WORD; `sets` maps a voice set to the starting voice and
 * the moves there. A word missing a set has nothing honest to say for that
 * track (a kit is not "glassy"), and the finder says so rather than guessing.
 */

const up = (field, note) => ({ field, direction: 'up', note });
const down = (field, note) => ({ field, direction: 'down', note });

export const SOUND_WORDS = Object.freeze([
  {
    word: 'bright', opposite: 'dark',
    why: 'Brightness is top end: a filter open, an FM depth up, hard mallets.',
    sets: {
      pad: { voice: 'glass', moves: [up('filter.cutoff', 'open the top end'), up('additive.p4', 'more of the high partials')] },
      melody: { voice: 'bell', moves: [up('fm.depth', 'drive the wobble harder'), up('fm.bite', 'keep it bright longer')] },
      bass: { voice: 'sawbass', moves: [up('filter.cutoff', 'open the filter'), up('filter.envAmount', 'let each note open it further')] },
      arp: { voice: 'crystal', moves: [up('fm.depth', 'more overtones'), up('filter.cutoff', 'and let them through')] },
      texture: { voice: 'sparkle', moves: [up('fm.depth', 'more sparkle'), up('filter.cutoff', 'and let it through')] },
    },
  },
  {
    word: 'dark', opposite: 'bright',
    why: 'Darkness is the top end taken away: a low cutoff, a soft strike, little FM.',
    sets: {
      pad: { voice: 'warm', moves: [down('filter.cutoff', 'close the filter'), down('filter.envAmount', 'and keep it closed')] },
      melody: { voice: 'tape', moves: [down('filter.cutoff', 'close the filter'), up('adsr.attack', 'soften the start')] },
      bass: { voice: 'sub', moves: [down('filter.cutoff', 'keep only the weight'), down('source.detune', 'one clean tone')] },
      arp: { voice: 'marimba', moves: [down('modal.hardness', 'a soft mallet'), down('filter.cutoff', 'muffle the rest')] },
      texture: { voice: 'colour', moves: [down('source.tilt', 'brown and rumbling'), down('source.bandCentre', 'the band low')] },
    },
  },
  {
    word: 'plucky', opposite: 'sustained',
    why: 'A pluck is a fast attack and no sustain: the note falls away as soon as it lands.',
    sets: {
      pad: { voice: 'warm', moves: [down('adsr.attack', 'strike, do not swell'), down('adsr.sustain', 'let it fall away')] },
      melody: { voice: 'pluck', moves: [down('adsr.decay', 'shorter'), down('adsr.release', 'and stop dead')] },
      bass: { voice: 'fingered', moves: [down('adsr.decay', 'shorter'), down('adsr.release', 'and stop dead')] },
      arp: { voice: 'softPluck', moves: [down('adsr.decay', 'shorter'), up('filter.envAmount', 'a bright pick on the front')] },
      texture: { voice: 'chimes', moves: [up('modal.damping', 'choke the ring'), up('modal.hardness', 'a sharper strike')] },
    },
  },
  {
    word: 'sustained', opposite: 'plucky',
    why: 'A sustained sound holds while the note lasts and takes its time to fade.',
    sets: {
      pad: { voice: 'strings', moves: [up('adsr.sustain', 'hold the note'), up('adsr.release', 'and let it linger')] },
      melody: { voice: 'flute', moves: [up('adsr.attack', 'ease in'), up('adsr.release', 'and ease out')] },
      bass: { voice: 'round', moves: [up('adsr.sustain', 'hold the note'), up('adsr.release', 'and let it ring on')] },
      arp: { voice: 'crystal', moves: [up('adsr.release', 'let each note ring into the next'), down('fm.bite', 'and mellow the attack')] },
      texture: { voice: 'wash', moves: [up('adsr.attack', 'swell in'), up('adsr.release', 'and fade slowly')] },
    },
  },
  {
    word: 'clean', opposite: 'gritty',
    why: 'Clean is one tone with nothing folding or beating against it.',
    sets: {
      pad: { voice: 'glass', moves: [down('source.detune', 'partials in tune'), down('filter.q', 'no ring at the cutoff')] },
      melody: { voice: 'keys', moves: [down('fm.depth', 'fewer overtones'), down('filter.q', 'no ring')] },
      bass: { voice: 'sub', moves: [down('source.fold', 'no folding'), down('filter.q', 'no ring')] },
      arp: { voice: 'softPluck', moves: [down('source.fold', 'no folding'), down('source.detune', 'one tone')] },
      texture: { voice: 'sparkle', moves: [down('fm.depth', 'plainer'), down('filter.q', 'no ring')] },
    },
  },
  {
    word: 'gritty', opposite: 'clean',
    why: 'Grit is a wave folded back on itself, a filter ringing, an FM driven hard.',
    sets: {
      pad: { voice: 'polysaw', moves: [up('source.fold', 'fold the wave'), up('filter.q', 'and ring the filter')] },
      melody: { voice: 'tines', moves: [up('fm.depth', 'drive the wobble'), up('filter.q', 'and ring the filter')] },
      bass: { voice: 'acid', moves: [up('source.fold', 'fold it'), up('filter.q', 'squelch')] },
      arp: { voice: 'muted', moves: [up('source.fold', 'fold the chop'), up('filter.q', 'and ring it')] },
      texture: { voice: 'grains', moves: [up('filter.q', 'ring the band'), down('adsr.attack', 'and let each grain hit hard')] },
    },
  },
  {
    word: 'warm', opposite: 'glassy',
    why: 'Warmth is a low-passed saw with a little detune, or wood struck softly.',
    sets: {
      pad: { voice: 'warm', moves: [up('source.detune', 'a little beating'), down('filter.cutoff', 'and no top end')] },
      melody: { voice: 'nylon', moves: [down('filter.cutoff', 'round it off'), up('adsr.release', 'and let it breathe')] },
      bass: { voice: 'round', moves: [down('filter.cutoff', 'round it off'), up('source.detune', 'a little width')] },
      arp: { voice: 'marimba', moves: [down('modal.hardness', 'a soft mallet'), down('modal.damping', 'and let the wood ring')] },
      texture: { voice: 'colour', moves: [down('source.tilt', 'towards brown'), down('source.bandWidth', 'a narrow, purring band')] },
    },
  },
  {
    word: 'glassy', opposite: 'warm',
    why: 'Glass is stretched partials, high and pure, or an FM bell with little drive.',
    sets: {
      pad: { voice: 'glass', moves: [up('additive.stretch', 'stretch the partials'), up('filter.cutoff', 'and let them through')] },
      melody: { voice: 'bell', moves: [up('fm.ratio', 'an inharmonic ratio'), down('fm.depth', 'kept pure')] },
      bass: { voice: 'upright', moves: [up('filter.cutoff', 'open it'), down('source.detune', 'one clean string')] },
      arp: { voice: 'crystal', moves: [up('fm.ratio', 'an inharmonic ratio'), up('adsr.release', 'and let it ring')] },
      texture: { voice: 'chimes', moves: [down('modal.damping', 'let the tubes ring'), up('filter.cutoff', 'and let the top through')] },
    },
  },
  {
    word: 'thick', opposite: 'thin',
    why: 'Thickness is more sound at once: detuned layers, a folded wave, a fuller stack.',
    sets: {
      pad: { voice: 'polysaw', moves: [up('source.detune', 'spread the stack'), up('source.mix', 'both oscillators')] },
      melody: { voice: 'stab', moves: [up('additive.p2', 'more octave'), up('additive.p3', 'more twelfth')] },
      bass: { voice: 'sawbass', moves: [up('source.detune', 'two saws apart'), up('source.fold', 'and a little fold')] },
      arp: { voice: 'muted', moves: [up('source.mix', 'both oscillators'), up('source.detune', 'and spread them')] },
      texture: { voice: 'wash', moves: [up('adsr.sustain', 'hold it'), up('adsr.release', 'and let it wash on')] },
    },
  },
  {
    word: 'thin', opposite: 'thick',
    why: 'Thin is one voice, in tune, with the bottom taken away.',
    sets: {
      pad: { voice: 'glass', moves: [down('additive.p1', 'less fundamental'), up('filter.cutoff', 'more top')] },
      melody: { voice: 'bell', moves: [down('fm.depth', 'a purer tone'), up('filter.cutoff', 'and thinner')] },
      bass: { voice: 'upright', moves: [down('source.detune', 'one string'), up('filter.cutoff', 'and less weight')] },
      arp: { voice: 'crystal', moves: [down('fm.depth', 'a purer tone'), down('adsr.sustain', 'and shorter')] },
      texture: { voice: 'colour', moves: [down('source.bandWidth', 'a narrow band'), up('source.bandCentre', 'sat high')] },
    },
  },
  {
    word: 'still', opposite: 'moving',
    why: 'Still is a sound that does not move inside itself: no sweep, no gust, no drift.',
    sets: {
      pad: { voice: 'warm', moves: [down('filter.envAmount', 'a filter that holds'), down('source.detune', 'no beating')] },
      melody: { voice: 'keys', moves: [down('fm.bite', 'no bright flash'), down('filter.q', 'no ring')] },
      bass: { voice: 'sub', moves: [down('filter.q', 'no ring at the cutoff'), down('source.detune', 'no beating')] },
      arp: { voice: 'softPluck', moves: [down('filter.envAmount', 'no wah'), down('source.detune', 'no beating')] },
      texture: { voice: 'colour', moves: [down('source.sweepDepth', 'no sweep'), down('source.gust', 'no gusts')] },
    },
  },
  {
    word: 'moving', opposite: 'still',
    why: 'Moving is a sound that changes as it sounds: a filter opening, a band sweeping, gusts.',
    sets: {
      pad: { voice: 'warm', moves: [up('filter.envAmount', 'a filter that opens on each note'), up('source.detune', 'and beats')] },
      melody: { voice: 'tines', moves: [up('fm.bite', 'a bright flash that fades'), up('fm.depth', 'and drive it harder')] },
      bass: { voice: 'acid', moves: [up('filter.envAmount', 'a filter that opens on each note'), up('filter.q', 'and squelches')] },
      arp: { voice: 'softPluck', moves: [up('filter.envAmount', 'a wah on each note'), up('source.detune', 'and beating')] },
      texture: { voice: 'colour', moves: [up('source.sweepDepth', 'a band that sweeps'), up('source.gust', 'and gusts')] },
    },
  },
]);

/** The word pairs, for a picker: [['bright', 'dark'], ...] in table order. */
export function wordPairs() {
  const seen = new Set();
  const pairs = [];
  for (const entry of SOUND_WORDS) {
    if (seen.has(entry.word) || seen.has(entry.opposite)) continue;
    seen.add(entry.word);
    seen.add(entry.opposite);
    pairs.push([entry.word, entry.opposite]);
  }
  return pairs;
}

/**
 * What the table says for these words on this voice set: the starting voice
 * the most words agree on, and every move the chosen words ask for on it (a
 * word whose voice was not chosen still contributes the moves that exist on
 * the chosen voice's dials — that is what `exposes` is for). `exposes(voice,
 * field)` is the caller's knowledge of which dials a voice has; without it,
 * every move is offered.
 */
export function findSound(words, voiceSet, { exposes = null } = {}) {
  const chosen = [...new Set((Array.isArray(words) ? words : []).map((w) => String(w).toLowerCase()))];
  const entries = chosen.map((word) => SOUND_WORDS.find((entry) => entry.word === word)).filter(Boolean);
  const applicable = entries.filter((entry) => entry.sets && entry.sets[voiceSet]);
  if (!applicable.length) {
    return { voice: null, moves: [], why: chosen.length ? `Nothing here is honestly ${chosen.join(' and ')} on this track.` : 'Pick a word or two.', words: chosen };
  }
  const votes = new Map();
  for (const entry of applicable) {
    const voice = entry.sets[voiceSet].voice;
    votes.set(voice, (votes.get(voice) || 0) + 1);
  }
  // The voice most words agree on; a tie goes to the first word picked.
  let voice = applicable[0].sets[voiceSet].voice;
  for (const [candidate, count] of votes) if (count > votes.get(voice)) voice = candidate;
  const moves = [];
  for (const entry of applicable) {
    for (const move of entry.sets[voiceSet].moves) {
      if (exposes && !exposes(voice, move.field)) continue;
      if (moves.some((m) => m.field === move.field)) continue;
      moves.push({ ...move, word: entry.word });
    }
  }
  const why = applicable.map((entry) => entry.why).join(' ');
  return { voice, moves, why, words: chosen };
}

/**
 * Apply a move to a value inside a domain: a third of the way towards the
 * end the direction names, never past it. A span moves both ends.
 */
export function moveValue(value, direction, [lo, hi]) {
  const step = (v) => {
    const n = Number.isFinite(v) ? v : lo;
    return direction === 'up' ? Math.min(hi, n + (hi - n) / 3) : Math.max(lo, n - (n - lo) / 3);
  };
  if (value && typeof value === 'object' && Number.isFinite(value.min) && Number.isFinite(value.max)) {
    return { min: step(value.min), max: step(value.max) };
  }
  return step(value);
}
