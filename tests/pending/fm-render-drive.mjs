/**
 * The FM section, measured from a REAL offline render (unit 4 of
 * docs/synthesis-programme.md). PARKED in tests/pending until the Mac test
 * bridge key is restored (fromClaude 13); then:
 *
 *   npm run build && .vibe/measure.sh local drive tests/fm-render-drive.mjs
 *
 * Node proves the graph (tests/voices-smoke.mjs: ratio moves the modulator,
 * depth scales the index, bite sets its decay, and the defaults rebuild the
 * shipped graph exactly). This proves the SOUND, the way the onset gate does:
 * render Bell through the shipped library with each dial moved, and measure.
 *
 *  - depth 2 raises the spectral centroid of the first 200 ms over depth 1;
 *    depth 0 lowers it to a near-sine (the carrier alone);
 *  - ratio 2 puts the first sideband at 2× the note (an FFT peak at f·ratio ±
 *    the note, resolved to the nearest bin), where ratio 3.47 puts it at 3.47×;
 *  - bite 0.1 leaves the 300–500 ms window darker than bite 2 does.
 *
 * FAILS ON v0.0.174 at every claim: the sanitiser drops `fm`, so no dial moves
 * and every rendered pair is identical.
 */
const PROBE = async (moduleUrl) => {
  const mod = await import(moduleUrl);
  const VOICES = mod.VOICES;
  const SR = 48000;
  const voice = VOICES.melody.bell;
  const NOTE = { when: 0.1, freq: 220, midi: 57, velocity: 0.9, duration: 1 };

  const render = async (fm) => {
    const ctx = new OfflineAudioContext(1, SR * 1.2, SR);
    const bus = ctx.createGain();
    bus.connect(ctx.destination);
    const patch = JSON.parse(JSON.stringify(voice.defaults));
    patch.fm = { ...patch.fm, ...fm };
    voice.play(ctx, bus, NOTE, patch);
    const buffer = await ctx.startRendering();
    return buffer.getChannelData(0);
  };

  // A plain DFT over a window: enough bins to resolve 220 Hz apart, cheap
  // enough to run a handful of times in a page.
  const spectrum = (data, fromSec, toSec) => {
    const from = Math.floor(fromSec * SR);
    const to = Math.min(Math.floor(toSec * SR), data.length);
    const n = 8192;
    const re = new Float64Array(n / 2);
    const im = new Float64Array(n / 2);
    const win = Math.min(n, to - from);
    for (let k = 0; k < n / 2; k++) {
      let sr = 0;
      let si = 0;
      const w = (2 * Math.PI * k) / n;
      for (let i = 0; i < win; i++) {
        const x = data[from + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / win));
        sr += x * Math.cos(w * i);
        si -= x * Math.sin(w * i);
      }
      re[k] = sr;
      im[k] = si;
    }
    const mag = new Float64Array(n / 2);
    for (let k = 0; k < n / 2; k++) mag[k] = Math.hypot(re[k], im[k]);
    return { mag, binHz: SR / n };
  };
  const centroid = ({ mag, binHz }) => {
    let num = 0;
    let den = 0;
    for (let k = 1; k < mag.length; k++) {
      num += k * binHz * mag[k];
      den += mag[k];
    }
    return den > 0 ? num / den : 0;
  };
  const peakNear = ({ mag, binHz }, hz, tolerance) => {
    let best = 0;
    let at = 0;
    for (let k = Math.floor((hz - tolerance) / binHz); k <= Math.ceil((hz + tolerance) / binHz); k++) {
      if (k > 0 && k < mag.length && mag[k] > best) { best = mag[k]; at = k * binHz; }
    }
    return { level: best, at };
  };
  const floorOf = ({ mag }) => {
    const sorted = Array.from(mag).sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * 0.5)];
  };

  const out = {};
  const d1 = await render({});
  const d2 = await render({ depth: 2 });
  const d0 = await render({ depth: 0 });
  out.centroidDepth1 = centroid(spectrum(d1, 0.1, 0.3));
  out.centroidDepth2 = centroid(spectrum(d2, 0.1, 0.3));
  out.centroidDepth0 = centroid(spectrum(d0, 0.1, 0.3));

  const r2 = await render({ ratio: 2, depth: 1.5 });
  const s2 = spectrum(r2, 0.1, 0.3);
  const s1 = spectrum(d1, 0.1, 0.3);
  // First sidebands sit at f ± f·ratio; the upper one is the clean test.
  out.sidebandRatio2 = peakNear(s2, 220 + 220 * 2, 30);
  out.sidebandRatio347 = peakNear(s1, 220 + 220 * 3.47, 30);
  out.floorRatio2 = floorOf(s2);
  out.floorRatio347 = floorOf(s1);
  // Where the OTHER ratio's sideband would be, in each render: it should not be there.
  out.crossRatio2 = peakNear(s2, 220 + 220 * 3.47, 30);
  out.crossRatio347 = peakNear(s1, 220 + 220 * 2, 30);

  const bShort = await render({ bite: 0.1 });
  const bLong = await render({ bite: 2 });
  out.centroidBiteShortLate = centroid(spectrum(bShort, 0.4, 0.6));
  out.centroidBiteLongLate = centroid(spectrum(bLong, 0.4, 0.6));
  return out;
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
  if (!moduleUrl) throw new Error('fm-render: could not find the engine-voices module URL');
  const m = await page.evaluate(
    ([fn, url]) => new Function(`return (${fn})`)()(url),
    [PROBE.toString(), moduleUrl],
  );
  const problems = [];
  if (!(m.centroidDepth2 > m.centroidDepth1 * 1.15)) {
    problems.push(`depth 2 did not brighten Bell: centroid ${m.centroidDepth1.toFixed(0)} → ${m.centroidDepth2.toFixed(0)} Hz`);
  }
  if (!(m.centroidDepth0 < m.centroidDepth1 * 0.8)) {
    problems.push(`depth 0 did not darken Bell to its carrier: centroid ${m.centroidDepth1.toFixed(0)} → ${m.centroidDepth0.toFixed(0)} Hz`);
  }
  if (!(m.sidebandRatio2.level > m.floorRatio2 * 20 && m.sidebandRatio2.level > m.crossRatio2.level * 3)) {
    problems.push(`ratio 2 put no sideband at 660 Hz (level ${m.sidebandRatio2.level.toFixed(2)}, floor ${m.floorRatio2.toFixed(2)}, the 3.47 slot ${m.crossRatio2.level.toFixed(2)})`);
  }
  if (!(m.sidebandRatio347.level > m.floorRatio347 * 20 && m.sidebandRatio347.level > m.crossRatio347.level * 3)) {
    problems.push(`the default ratio put no sideband at 983 Hz (level ${m.sidebandRatio347.level.toFixed(2)}, floor ${m.floorRatio347.toFixed(2)}, the 2× slot ${m.crossRatio347.level.toFixed(2)})`);
  }
  if (!(m.centroidBiteLongLate > m.centroidBiteShortLate * 1.15)) {
    problems.push(`bite 2 is not brighter than bite 0.1 at 400–600 ms: ${m.centroidBiteShortLate.toFixed(0)} vs ${m.centroidBiteLongLate.toFixed(0)} Hz`);
  }
  if (problems.length) throw new Error('fm-render: ' + problems.join('\n  '));
  return { moduleUrl, measured: m, asserted: 5 };
}
