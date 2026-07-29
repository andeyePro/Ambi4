/**
 * The call voice is a bird — it does not saw.
 *
 *   npm run build && .vibe/measure.sh local drive tests/call-breath-render.mjs
 *
 * The owner, twice: a noise layer "always makes me think there's someone
 * sawing", and (2026-07-29, item 85) "I heard the sawing again in Synthwave,
 * and saw that Texture was set to Call; I have now picked Call again and hear
 * the sawing." So the saw is `call` itself — specifically the TEXTURE reading
 * of it, which was designed "slow, low and falling": a glide of −9 semitones
 * through formants at 620 and 1400 Hz, repeated every 1⅓ seconds. A low
 * resonance falling and dying, over and over, is acoustically a saw stroke;
 * a whistle that RISES, up where small birds live, is a bird. That is a
 * measurable distinction, not a taste:
 *
 *   - per chirp, the spectral centroid's travel from the chirp's first half
 *     to its second — negative is a saw stroke, positive is a bird;
 *   - the centroid's resting height — 600-odd Hz is sawing wood, well over a
 *     kilohertz is a whistle.
 *
 * This renders one long note of the SHIPPED `texture/call` voice offline with
 * `irregular: 0` (chirps land at exact, known times) and asserts both. On the
 * pre-fix voice the chirps sat at 662 Hz — sawing-wood territory, and the
 * check that fails on that build. (The centroid SLOPE measured mildly
 * positive even pre-fix — the tone's fall was masked by the breath's higher
 * formant taking over as the tone died — so the height is the fail-first
 * evidence and the rise assertions are guards.) The bird measures ~1130 Hz,
 * rising ~0.2 octaves per call.
 *
 * The breath layer is also held under the whistle now (its narrow-band makeup
 * could reach 6×, putting the noise at ~2× the tone it sits beside); the
 * top-three-band share is reported informationally, though the glide itself
 * spreads the comb so it is not asserted — the slope and height are what the
 * ear files under "saw".
 */

const PROBE = async (moduleUrl) => {
  const mod = await import(moduleUrl);
  const voice = mod.VOICES?.texture?.call;
  if (!voice || typeof voice.play !== 'function') return { error: 'texture/call not found' };
  const SR = 48000;
  const ctx = new OfflineAudioContext(1, SR * 8, SR);
  const bus = ctx.createGain();
  bus.gain.value = 1;
  bus.connect(ctx.destination);
  // irregular: 0 pins the phrase: cadence 1.5 against the 2 s reference bar
  // gives chirps every 4/3 s from 0.2 s, each 0.733 s long. Everything else is
  // the shipped default.
  voice.play(
    ctx, bus,
    { time: 0.2, freq: 660, midi: 76, velocity: 0.9, duration: 6 },
    { source: { irregular: 0 } },
  );
  const buffer = await ctx.startRendering();
  const data = buffer.getChannelData(0);
  const peak = data.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

  // ~13 log-spaced probes per octave, 150 Hz – 7 kHz.
  const bands = [];
  for (let i = 0; i < 72; i++) bands.push(150 * Math.pow(2, i * (5.55 / 72)));
  const magsAt = (start, len) => bands.map((f) => {
    const w = (2 * Math.PI * f) / SR;
    const coeff = 2 * Math.cos(w);
    let s1 = 0;
    let s2 = 0;
    for (let i = start; i < start + len && i < data.length; i++) {
      const s0 = data[i] + coeff * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2));
  });
  const centroidOf = (mags) => {
    let num = 0;
    let den = 0;
    mags.forEach((m, i) => { num += m * bands[i]; den += m; });
    return den > 0 ? num / den : 0;
  };

  const spacing = 4 / 3;
  const chirpLen = spacing * 0.55;
  const slopes = [];
  const centres = [];
  const shares = [];
  for (let i = 0; i < 4; i++) {
    const at = 0.2 + i * spacing;
    const early = magsAt(Math.floor((at + chirpLen * 0.08) * SR), Math.floor(chirpLen * 0.30 * SR));
    const late = magsAt(Math.floor((at + chirpLen * 0.55) * SR), Math.floor(chirpLen * 0.30 * SR));
    const cE = centroidOf(early);
    const cL = centroidOf(late);
    if (cE > 0 && cL > 0) {
      slopes.push(+Math.log2(cL / cE).toFixed(3));
      centres.push(+((cE + cL) / 2).toFixed(0));
    }
    const whole = magsAt(Math.floor((at + chirpLen * 0.1) * SR), Math.floor(chirpLen * 0.7 * SR));
    const sum = whole.reduce((a, b) => a + b, 0);
    const top3 = [...whole].sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0);
    shares.push(sum > 0 ? +(top3 / sum).toFixed(3) : 0);
  }
  const meanSlope = +(slopes.reduce((a, b) => a + b, 0) / slopes.length).toFixed(3);
  const meanCentre = +(centres.reduce((a, b) => a + b, 0) / centres.length).toFixed(0);
  return { peak: +peak.toFixed(4), slopes, centres, meanSlope, meanCentre, shares };
};

export default async function drive(page) {
  const moduleUrl = await page.evaluate(async () => {
    const html = await (await fetch('/')).text();
    const direct = html.match(/\/_astro\/engine-voices\.[A-Za-z0-9_-]+\.js/);
    if (direct) return direct[0];
    const entry = html.match(/\/_astro\/index\.astro[^"']+\.js/);
    if (!entry) return null;
    const js = await (await fetch(entry[0])).text();
    const nested = js.match(/engine-voices\.[A-Za-z0-9_-]+\.js/);
    return nested ? `/_astro/${nested[0]}` : null;
  });
  if (!moduleUrl) throw new Error('call-breath-render: could not find the engine-voices module URL');

  const row = await page.evaluate(
    ([fn, url]) => new Function(`return (${fn})`)()(url),
    [PROBE.toString(), moduleUrl],
  );
  if (row.error) throw new Error('call-breath-render: ' + row.error);

  const results = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
  };

  check('the voice still makes a sound', row.peak > 0.005, (v) => v === true);
  // Pre-fix: −0.71 octaves per chirp. A bird rises.
  check('each call rises — a bird, not a saw stroke', row.meanSlope > 0.1, (v) => v === true);
  // Pre-fix: ~600 Hz. A whistle lives above a kilohertz.
  check('and it sits up where a whistle lives', row.meanCentre > 1000, (v) => v === true);
  // But it is still the slow, settled texture reading, not melody's quick
  // bright bird an octave up.
  check('while staying the low, slow reading of the pair', row.meanCentre < 3200, (v) => v === true);
  results.push({ name: 'per-chirp centroid slopes (oct)', ok: true, got: row.slopes, want: '(informational)' });
  results.push({ name: 'per-chirp centres (Hz)', ok: true, got: row.centres, want: '(informational)' });
  results.push({ name: 'top-three-band shares', ok: true, got: row.shares, want: '(informational)' });

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'call-breath-render: ' + failed.length + ' failed\n' + JSON.stringify(row) + '\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n'),
    );
  }
  return { passed: results.length, notes: results.filter((r) => r.want === '(informational)').map((r) => `${r.name}: ${JSON.stringify(r.got)}`) };
}
