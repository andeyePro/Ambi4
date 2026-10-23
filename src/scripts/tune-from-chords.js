/**
 * tune-from-chords.js — a chord loop → a melody that sits over it.
 *
 * His compose brief, entry point two: "Play or type a chord sequence, melody
 * derived." The mirror of harmonise.js (v0.0.155, Fit chords to the tune):
 * that one reads a tune and names the chords; this one reads the chords and
 * writes a tune. Pure, import-safe in Node (no DOM, no audio, no engine
 * import), tested in tests/tune-from-chords-smoke.mjs.
 *
 * The rules, each one a thing a person can check by looking at the grid:
 *
 *   1. CHORD TONES ON THE STRONG BEATS. Every note that starts on a beat (a
 *      pulse of the metre) is a tone of the chord in force — its root, third
 *      or fifth, built the way the engine builds a triad (scale steps 1-3-5).
 *      The downbeat of every bar always carries one.
 *   2. STEPWISE PASSING TONES BETWEEN. A note between the beats walks one scale
 *      step from the note before it, toward the next beat's note; when the
 *      next beat's note is the same pitch or one step away it becomes a
 *      neighbour note instead (a step out and back). Always in the scale.
 *   3. AN ARCH OVER EACH PHRASE. Phrases are four bars (the engine's own
 *      PHRASE_BARS). The beat notes aim at a target that starts low in the
 *      register, rises to a peak a little past the middle and falls again;
 *      the nearest chord tone to that target wins, with a cost on leaps wider
 *      than a third and on repeating the last pitch, so the line moves without
 *      leaping about.
 *   4. DENSITY FROM COMPLEXITY. At 0 a bar is a few beat notes, some beats
 *      held; at 1 every beat sounds and the gaps fill with passing tones down
 *      to sixteenths. Every rhythm decision draws its random number whatever
 *      the density, so for one seed a higher density never removes a note.
 *   5. A CADENCE AT THE END. The last bar lands on the key's tonic — when the
 *      last chord contains it (I, IV, VI in a major key) — or else on the
 *      last chord's own root, which keeps rule 1. It lands on a beat and is
 *      held to the end of the loop, nothing after it.
 *   6. THE TRACK'S REGISTER. Every note is inside [low, high], which the caller
 *      passes (a bass is not a melody). It must span at least an octave.
 *
 * Deterministic: the same chords, scale, root, metre, density and seed always
 * write the same notes. A different seed is a different tune over the same
 * chords — which is what pressing the button again offers.
 */

/** A small seeded PRNG (mulberry32), so no draw anywhere reaches Math.random. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hash the inputs that define "the same loop" into the PRNG's seed. */
function hashSeed(parts) {
  let h = 2166136261 >>> 0;
  for (const ch of JSON.stringify(parts)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

export const PHRASE_BARS = 4;
export const MAX_BARS = 8;

/** Triad tones on a degree, as scale indices mod the scale's length. */
export function chordTones(degree, scaleLength) {
  return [0, 2, 4].map((step) => (((degree + step) % scaleLength) + scaleLength) % scaleLength);
}

/** Absolute scale index → MIDI. Index 0 is the root in MIDI octave 0 (C-1 = 0). */
function indexToMidi(index, scale, rootPc) {
  const n = scale.length;
  const octave = Math.floor(index / n);
  return rootPc + 12 * octave + scale[((index % n) + n) % n];
}

/** Where the arch aims, 0..1 of the register, at position t (0..1) of a phrase. */
function archAt(t) {
  // Starts at 0.3, peaks ~0.8 at t≈0.6, falls back to ~0.2 at the phrase end.
  const rise = Math.sin(Math.PI * Math.min(1, t / 1.2));
  return 0.3 + 0.5 * rise - 0.1 * t;
}

/**
 * Write a tune over a chord loop.
 *
 * @param chords       The loop as scale degrees (0 = I), one per chord.
 * @param scale        Semitone offsets from the root (the engine's SCALES entry).
 * @param rootPc       Pitch class of the key's root (0 = C).
 * @param bars         How many bars to write (1..8). Default: one pass of the loop.
 * @param beatsPerBar  Beats in a bar (the metre's pulses).
 * @param slotsPerBar  Grid slots per bar (default beatsPerBar × 4).
 * @param pulseSlots   Slot where each beat starts (default evenly spaced).
 * @param barsPerChord How many bars each chord lasts (harmony.rhythm), default 1.
 * @param density      0..1 — the piece's Complexity.
 * @param seed         Any integer; a different seed is a different tune.
 * @param register     { low, high } MIDI bounds, at least an octave apart.
 * @returns { notes: [{ bar, slot, length, midi, role }], bars } where role is
 *          'chord' (on a beat), 'passing', 'neighbour' or 'cadence'; or null
 *          when the inputs cannot make a tune.
 */
export function tuneFromChords({
  chords,
  scale,
  rootPc = 0,
  bars,
  beatsPerBar = 4,
  slotsPerBar,
  pulseSlots,
  barsPerChord = 1,
  density = 0.5,
  seed = 0,
  register = { low: 55, high: 79 },
} = {}) {
  if (!Array.isArray(scale) || scale.length < 2) return null;
  const loop = Array.isArray(chords) && chords.length
    ? chords.map((d) => (Number.isFinite(d) ? Math.round(d) : 0))
    : [0];
  const n = scale.length;
  const per = Math.max(1, Math.round(Number(barsPerChord) || 1));
  const beats = Math.max(1, Math.round(Number(beatsPerBar) || 4));
  const slots = Math.max(beats, Math.round(Number(slotsPerBar) || beats * 4));
  let pulses = Array.isArray(pulseSlots) && pulseSlots.length
    ? [...new Set(pulseSlots.map((s) => Math.round(s)).filter((s) => s >= 0 && s < slots))].sort((a, b) => a - b)
    : Array.from({ length: beats }, (_, i) => Math.round((i * slots) / beats));
  if (pulses[0] !== 0) pulses = [0, ...pulses];
  const barCount = Math.max(1, Math.min(MAX_BARS, Math.round(Number(bars) || loop.length * per)));
  const dens = Math.max(0, Math.min(1, Number(density) || 0));
  const low = Math.round(Number(register?.low));
  const high = Math.round(Number(register?.high));
  if (!Number.isFinite(low) || !Number.isFinite(high) || high - low < 12) return null;

  const rng = mulberry32(hashSeed([loop, scale, rootPc, barCount, slots, pulses, per, Math.round(seed) || 0]));
  const chordAt = (bar) => loop[Math.floor(bar / per) % loop.length];

  // Every scale index whose pitch lies in the register, low to high.
  const inRegister = [];
  for (let i = -n * 2; i < n * 12; i++) {
    const m = indexToMidi(i, scale, rootPc);
    if (m >= low && m <= high) inRegister.push(i);
  }
  const loIdx = inRegister[0];
  const hiIdx = inRegister[inRegister.length - 1];
  const midiOf = (i) => indexToMidi(i, scale, rootPc);

  // ---- pass 1: the RHYTHM. Which slots start a note. Draws are made for every
  // decision whatever the density, so the rhythm is monotone in density.
  const onsets = []; // { bar, slot, strong }
  for (let bar = 0; bar < barCount; bar++) {
    const last = bar === barCount - 1;
    const cadenceAt = pulses.length >= 2 ? pulses[Math.floor(pulses.length / 2)] : 0;
    for (let p = 0; p < pulses.length; p++) {
      const start = pulses[p];
      const end = p + 1 < pulses.length ? pulses[p + 1] : slots;
      const beatDraw = rng();
      const halfDraw = rng();
      const quarterDraws = [rng(), rng()];
      if (last && start > cadenceAt) continue; // the cadence holds to the end
      const strong = start === 0 || (last && start === cadenceAt) || beatDraw < 0.35 + 0.65 * dens;
      if (strong) onsets.push({ bar, slot: start, strong: true });
      if (last && start === cadenceAt) continue;
      // Between this beat and the next: passing tones.
      const span = end - start;
      if (span >= 2 && halfDraw < 0.9 * dens) {
        const mid = start + Math.floor(span / 2);
        onsets.push({ bar, slot: mid, strong: false });
        if (span >= 4) {
          if (quarterDraws[0] < 1.6 * (dens - 0.55)) onsets.push({ bar, slot: start + Math.floor(span / 4), strong: false });
          if (quarterDraws[1] < 1.6 * (dens - 0.55)) onsets.push({ bar, slot: start + Math.floor((3 * span) / 4), strong: false });
        }
      }
    }
  }
  onsets.sort((a, b) => a.bar - b.bar || a.slot - b.slot);
  // A passing tone needs a note before it; one straight after the downbeat of a
  // held beat is fine, but no line may OPEN on a passing tone.
  while (onsets.length && !onsets[0].strong) onsets.shift();

  // ---- pass 2: the BEAT notes — chord tones along the arch.
  const posInPhrase = (bar, slot) => {
    const phraseStart = Math.floor(bar / PHRASE_BARS) * PHRASE_BARS;
    const phraseLen = Math.min(PHRASE_BARS, barCount - phraseStart);
    return ((bar - phraseStart) + slot / slots) / phraseLen;
  };
  const strongIdx = onsets.map(() => null);
  let prev = null;
  const finalStrong = onsets.reduce((k, o, i) => (o.strong ? i : k), -1);
  onsets.forEach((o, i) => {
    if (!o.strong) return;
    const degree = chordAt(o.bar);
    let pcs = chordTones(degree, n);
    const isCadence = i === finalStrong;
    if (isCadence) {
      // The tonic when the last chord holds it, else the chord's own root.
      pcs = pcs.includes(0) ? [0] : [((degree % n) + n) % n];
    }
    const t = isCadence ? 1 : posInPhrase(o.bar, o.slot);
    const target = loIdx + archAt(t) * (hiIdx - loIdx);
    const jitter = rng();
    let best = null;
    let bestCost = Infinity;
    for (const c of inRegister) {
      if (!pcs.includes(((c % n) + n) % n)) continue;
      let cost = 0.7 * Math.abs(c - target);
      if (prev !== null) {
        const leap = Math.abs(c - prev);
        cost += 0.5 * Math.max(0, leap - 2);   // a third or less is free; leaps cost
        if (leap === 0) cost += 1.2;           // a repeated pitch is a line standing still
        if (leap > n) cost += 4;               // no leap past an octave
      }
      // A little seeded colour so two seeds over one loop differ.
      cost += 0.8 * Math.abs(Math.sin((c + 1) * 12.9898 + jitter * 78.233));
      if (cost < bestCost) { bestCost = cost; best = c; }
    }
    strongIdx[i] = best;
    prev = best;
  });

  // ---- pass 3: the PASSING tones — a step at a time toward the next beat note.
  const idx = strongIdx.slice();
  for (let i = 0; i < onsets.length; i++) {
    if (onsets[i].strong) continue;
    const before = idx[i - 1];
    let nextStrong = null;
    for (let j = i + 1; j < onsets.length; j++) if (onsets[j].strong) { nextStrong = idx[j]; break; }
    const goal = nextStrong === null ? before : nextStrong;
    let step;
    if (Math.abs(goal - before) >= 2) step = Math.sign(goal - before);
    else {
      // Neighbour note: out a step (away from the goal when there is one) and back.
      const anchor = onsets[i - 1]?.strong ? before : idx[i - 2] ?? before;
      if (before !== anchor) step = Math.sign(anchor - before);
      else step = goal > before ? -1 : 1;
    }
    let v = before + step;
    if (v > hiIdx) v = before - 1;
    if (v < loIdx) v = before + 1;
    idx[i] = v;
  }

  // ---- notes, each lasting until the next onset (or the end of its bar).
  const notes = onsets.map((o, i) => {
    const next = onsets[i + 1];
    const end = next && next.bar === o.bar ? next.slot : slots;
    let role = o.strong ? 'chord' : 'passing';
    if (!o.strong) {
      const before = idx[i - 1];
      let nextStrong = null;
      for (let j = i + 1; j < onsets.length; j++) if (onsets[j].strong) { nextStrong = idx[j]; break; }
      const goal = nextStrong === null ? before : nextStrong;
      const towards = Math.sign(idx[i] - before) === Math.sign(goal - before) && goal !== before;
      role = towards ? 'passing' : 'neighbour';
    }
    if (i === finalStrong) role = 'cadence';
    return { bar: o.bar, slot: o.slot, length: end - o.slot, midi: midiOf(idx[i]), role };
  });

  return { notes, bars: barCount, slotsPerBar: slots, pulseSlots: pulses };
}
