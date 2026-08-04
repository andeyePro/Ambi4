/**
 * Words → syllables → a metre → notes. Pure: no DOM, no audio, no state, and
 * safe to import in Node, which is how `tests/lyrics-smoke.mjs` drives it.
 *
 * WHY IT EXISTS. His item 96 named "words" as the third compose method and left
 * which words open; his 116 (2026-08-04) settled it: "c) lyrics that you enter -
 * like a poem - and the system determines the meter, so can, for example,
 * generate a melody based on the chosen chord sequence." So this module does
 * exactly the two things that sentence asks for and nothing else: it reads the
 * METRE out of typed words, and it lays those syllables onto a bar so the
 * stresses fall where the metre's pulses are. What note each syllable SINGS is
 * the caller's business, because that comes from the chord sequence, which lives
 * in the engine.
 *
 * WHAT IT IS HONEST ABOUT. English stress cannot be computed exactly without a
 * pronouncing dictionary, and shipping one is a megabyte the page will not pay
 * for. This is a heuristic — vowel groups for syllables, a function-word list
 * and a prefix rule for stress — and it is wrong sometimes. That is acceptable
 * here for one reason: the result is ORDINARY EDITABLE STEPS, so a stress in the
 * wrong place is a step the user drags, exactly like every other thing this app
 * decides. Nothing about it is hidden: `scan()` reports the syllables and the
 * stresses it found, and the page shows them.
 */

/** Words that carry no stress of their own in ordinary English speech. */
const FUNCTION_WORDS = new Set([
  'a', 'an', 'the', 'and', 'but', 'or', 'nor', 'for', 'yet', 'so',
  'of', 'to', 'in', 'on', 'at', 'by', 'up', 'as', 'is', 'am', 'are', 'was', 'were',
  'be', 'been', 'being', 'do', 'does', 'did', 'has', 'have', 'had',
  'it', 'its', 'he', 'she', 'we', 'they', 'you', 'i', 'me', 'him', 'her', 'them', 'us',
  'my', 'your', 'his', 'their', 'our', 'this', 'that', 'these', 'those',
  'with', 'from', 'into', 'onto', 'than', 'then', 'if', 'not', 'no',
  'will', 'would', 'can', 'could', 'shall', 'should', 'may', 'might', 'must',
]);

/**
 * Prefixes that take the stress off the first syllable — "before", "begin",
 * "return", "delay". Not exhaustive and does not pretend to be.
 */
const WEAK_PREFIXES = ['be', 'de', 're', 'in', 'un', 'ex', 'con', 'com', 'pro', 'per', 'to', 'a'];

/** Endings whose stress sits on the syllable BEFORE them: cre-A-tion. */
const PENULT_ENDINGS = ['tion', 'sion', 'cion', 'ic', 'ical', 'ity', 'ify', 'ious', 'eous', 'ial'];

const VOWELS = 'aeiouy';

/** Strip a word down to the letters a syllable count can look at. */
export function cleanWord(word) {
  return String(word ?? '').toLowerCase().replace(/[^a-z']/g, '');
}

/**
 * How many syllables a word has, by vowel groups with the usual corrections.
 * Wrong on some words (every heuristic is); never returns less than one for a
 * word with a letter in it.
 */
export function syllableCount(word) {
  const w = cleanWord(word).replace(/'/g, '');
  if (!w) return 0;
  let count = 0;
  let previousWasVowel = false;
  for (let i = 0; i < w.length; i++) {
    const isVowel = VOWELS.includes(w[i]);
    if (isVowel && !previousWasVowel) count += 1;
    previousWasVowel = isVowel;
  }
  // A silent final e ("time", "made") is not a syllable of its own — but "the"
  // and "she" are, and a word ending -le after a consonant gains one back
  // ("table", "little").
  if (w.length > 3 && w.endsWith('e') && !VOWELS.includes(w[w.length - 2])) count -= 1;
  if (/[^aeiouy]le$/.test(w)) count += 1;
  // -ed is a syllable only after t or d ("wanted", "landed"), not otherwise.
  if (/[^td]ed$/.test(w) && count > 1) count -= 1;
  // -ion after a vowel is its own syllable: cre-a-tion, sit-u-a-tion. The vowel
  // group scan reads "ea" and "io" as one each and comes up one short.
  // TWO vowels in a row before it, not one: cre-A-tion and sit-u-A-tion split
  // the hiatus, while NA-tion and QUES-tion do not.
  if (/[aeiou]{2}ti?on$/.test(w) || /[aeiou]{2}sion$/.test(w)) count += 1;
  // A word whose vowels run out before its consonants do: rhy-thm, al-go-rithm.
  if (/thms?$/.test(w)) count += 1;
  return Math.max(1, count);
}

/**
 * Which syllable of a word is stressed, as an index. A one-syllable function
 * word is UNSTRESSED (index -1) — that is what makes "the" different from "sky"
 * and is most of what gives a line its rhythm.
 */
export function stressIndex(word) {
  const w = cleanWord(word);
  if (!w) return -1;
  const count = syllableCount(w);
  if (count === 1) return FUNCTION_WORDS.has(w) ? -1 : 0;
  for (const ending of PENULT_ENDINGS) {
    if (w.endsWith(ending)) return Math.max(0, count - 2);
  }
  for (const prefix of WEAK_PREFIXES) {
    if (!w.startsWith(prefix) || count < 2) continue;
    // The prefix has to be followed by a CONSONANT to be a prefix at all:
    // "be-fore" and "de-lay" are, but "beau-ti-ful" only looks like one, and
    // reading it as be+autiful put the stress on its second syllable.
    if (VOWELS.includes(w[prefix.length] ?? '')) continue;
    // A bare "a-" is a prefix in a two-syllable word (a-bout, a-lone, a-gain)
    // and an accident in a longer one (AL-go-rithm, AL-pha-bet).
    if (prefix === 'a' && count > 2) continue;
    return 1;
  }
  return 0;
}

/**
 * Read the metre out of a line: one entry per syllable, in order, each saying
 * which word it came from and whether it is stressed.
 */
export function scanLine(line) {
  const words = String(line ?? '').split(/[\s—–-]+/).map(cleanWord).filter(Boolean);
  const syllables = [];
  for (const word of words) {
    const count = syllableCount(word);
    const stress = stressIndex(word);
    for (let i = 0; i < count; i++) {
      syllables.push({ word, index: i, of: count, stressed: i === stress });
    }
  }
  return { words, syllables };
}

/** Every line of a typed poem, blank lines dropped. */
export function scan(text) {
  const lines = String(text ?? '').split(/[\n\r]+/).map((l) => l.trim()).filter(Boolean);
  return lines.map((line) => ({ line, ...scanLine(line) }));
}

/**
 * The metre a scan implies, in the app's own vocabulary.
 *
 * A poem's foot is the distance from one stress to the next. Two syllables a
 * foot is duple (iambic/trochaic — 4/4 and its relatives), three is triple
 * (anapaestic/dactylic — 6/8 and 12/8), which is the one musical decision the
 * words can honestly make on their own. Anything less regular than that gets
 * 4/4 and says so, rather than inventing a metre nobody typed.
 */
export function metreOfScan(scanned) {
  const gaps = [];
  for (const line of scanned) {
    let last = -1;
    line.syllables.forEach((syllable, i) => {
      if (!syllable.stressed) return;
      if (last >= 0) gaps.push(i - last);
      last = i;
    });
  }
  if (!gaps.length) return { foot: 2, timeSignature: '4/4', confident: false };
  const counts = new Map();
  for (const gap of gaps) counts.set(gap, (counts.get(gap) ?? 0) + 1);
  let foot = 2;
  let best = 0;
  for (const [gap, n] of counts) {
    if (n > best || (n === best && gap < foot)) { foot = gap; best = n; }
  }
  const share = best / gaps.length;
  if (foot === 3 && share >= 0.5) return { foot: 3, timeSignature: '6/8', confident: true };
  return { foot: 2, timeSignature: '4/4', confident: share >= 0.5 };
}

/**
 * Syllables → grid slots, so the STRESSES land on the metre's pulses.
 *
 * `pulseSlots` is where the bar's felt beats are (the caller has them from the
 * engine's own metre table), `slotsPerBar` how many slots a bar plays, and
 * `slotsPerSyllable` how much room each syllable gets between the pulses.
 *
 * Returns one entry per syllable with the bar and slot it lands on, plus
 * `stressed` so the caller can voice it differently — a stressed syllable is
 * where a chord tone belongs.
 */
export function layOut(scanned, { pulseSlots, slotsPerBar, maxBars = 8, slotsPerSyllable = 1 }) {
  const placed = [];
  let bar = 0;
  let slot = 0;
  let pulseAt = 0;
  const nextPulse = (from) => {
    for (const p of pulseSlots) if (p >= from) return p;
    return null;
  };
  for (const line of scanned) {
    // A new line starts a new bar: a poem's line break is a musical phrase.
    if (slot > 0) { bar += 1; slot = 0; pulseAt = 0; }
    for (const syllable of line.syllables) {
      if (bar >= maxBars) return { placed, dropped: true };
      if (syllable.stressed) {
        // Push the stress to the next pulse it can reach.
        const target = nextPulse(slot);
        if (target === null) { bar += 1; slot = 0; pulseAt = 0; }
        else slot = target;
      }
      if (slot >= slotsPerBar) { bar += 1; slot -= slotsPerBar; }
      if (bar >= maxBars) return { placed, dropped: true };
      placed.push({ ...syllable, bar, slot });
      slot += slotsPerSyllable;
      pulseAt += 1;
    }
  }
  return { placed, dropped: false };
}

export default { scan, scanLine, scanUnit: syllableCount, metreOfScan, layOut };
