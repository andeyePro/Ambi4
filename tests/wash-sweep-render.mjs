/**
 * The Ambient wash holds its band still — the saw is gone, the bird is not.
 *
 *   npm run build && .vibe/measure.sh local drive tests/wash-sweep-render.mjs
 *
 * The owner on Ambient: "the whistling is fine, it's called 'call' so let it be
 * a bird sound not a sawing sound." Two things were moving in the wash voice
 * and only one of them is the bird. The Q wobble is the bird. The band CENTRE
 * was travelling from 320 Hz up past two octaves and back down over every
 * note, which is a filter sweep — and a filter sweep repeated forever is what
 * a saw sounds like.
 *
 * "It sounds better" is not a result anybody can check, and nobody in this
 * container can hear it anyway. A sweep is a measurement: it is the spectral
 * centroid of the signal moving over time. This renders one long note of the
 * shipped `texture/wash` voice offline, measures the centroid in successive
 * windows, and asserts the spread across the note is small — a held band —
 * while the note is still audible and still moving in the small way the Q
 * wobble makes it move.
 *
 * It measures the SHIPPED module, the same `VOICES.texture.wash.play` the
 * engine calls, which is why it runs in a browser rather than in Node.
 */

const PROBE = async (moduleUrl) => {
  const mod = await import(moduleUrl);
  const voice = mod.VOICES?.texture?.wash;
  if (!voice || typeof voice.play !== 'function') return { error: 'texture/wash not found' };
  const SR = 48000;
  const ctx = new OfflineAudioContext(1, SR * 8, SR);
  const bus = ctx.createGain();
  bus.gain.value = 1;
  bus.connect(ctx.destination);
  voice.play(ctx, bus, { time: 0.2, freq: 660, midi: 76, velocity: 0.9, duration: 6 }, null);
  const buffer = await ctx.startRendering();
  const data = buffer.getChannelData(0);

  // Spectral centroid by a plain Goertzel bank — a full FFT is not needed to
  // answer "did the middle of the spectrum move", and a bank of thirty-two
  // logarithmically-spaced probes is easier to read than one.
  const bands = [];
  for (let i = 0; i < 32; i++) bands.push(150 * Math.pow(2, i * (5 / 32)));

  const centroidAt = (start, len) => {
    let num = 0;
    let den = 0;
    for (const f of bands) {
      const w = 2 * Math.PI * f / SR;
      const coeff = 2 * Math.cos(w);
      let s1 = 0;
      let s2 = 0;
      for (let i = start; i < start + len && i < data.length; i++) {
        const s0 = data[i] + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
      const mag = Math.sqrt(Math.max(0, power));
      num += mag * f;
      den += mag;
    }
    return den > 0 ? num / den : 0;
  };

  const peak = data.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const windows = [];
  // Skip the attack: the amplitude envelope alone moves the measurable
  // spectrum while the note is fading in, and that is not a sweep.
  for (let s = 1.5; s < 5.5; s += 0.5) {
    windows.push(+centroidAt(Math.floor(s * SR), Math.floor(0.25 * SR)).toFixed(1));
  }
  const lo = Math.min(...windows);
  const hi = Math.max(...windows);
  return {
    peak: +peak.toFixed(4),
    windows,
    lo,
    hi,
    // Octaves travelled across the body of the note. The old sweep ran from
    // 320 Hz to roughly 1.4 kHz and back — well over two octaves.
    octaves: lo > 0 ? +(Math.log2(hi / lo)).toFixed(3) : null,
  };
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
  if (!moduleUrl) throw new Error('wash-sweep-render: could not find the engine-voices module URL');

  const row = await page.evaluate(
    ([fn, url]) => new Function(`return (${fn})`)()(url),
    [PROBE.toString(), moduleUrl],
  );
  if (row.error) throw new Error('wash-sweep-render: ' + row.error);

  const results = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
  };

  check('the voice still makes a sound', row.peak > 0.005, (v) => v === true);
  // Half an octave of drift across four seconds is the Q wobble breathing, not
  // a sweep. The band this replaced travelled well over two.
  check('the band no longer sweeps across the note', row.octaves < 0.5, (v) => v === true);
  // And it has not been frozen solid either — a completely static spectrum
  // would mean the Q wobble had gone with it, which is the bird.
  check('but it is not frozen — the Q wobble still breathes', row.octaves > 0.001, (v) => v === true);
  results.push({ name: 'centroid windows (Hz)', ok: true, got: row.windows, want: '(informational)' });
  results.push({ name: 'octaves travelled', ok: true, got: row.octaves, want: '(informational)' });

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'wash-sweep-render: ' + failed.length + ' failed\n' + JSON.stringify(row) + '\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n'),
    );
  }
  return { passed: results.length, notes: results.filter((r) => r.want === '(informational)').map((r) => `${r.name}: ${JSON.stringify(r.got)}`) };
}
