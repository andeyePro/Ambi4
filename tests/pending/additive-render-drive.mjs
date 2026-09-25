/**
 * The Additive section, measured from a REAL offline render (unit 5 of
 * docs/synthesis-programme.md). PARKED in tests/pending until the Mac test
 * bridge key is restored (fromClaude 13); then:
 *
 *   npm run build && .vibe/measure.sh local drive tests/additive-render-drive.mjs
 *
 * Node proves the graph (tests/voices-smoke.mjs). This proves the SOUND on
 * Organ stab, whose partials sit exactly on the harmonic series:
 *
 *  - p2 = 0 removes the octave partial: the FFT peak at 2f drops to the floor
 *    while the fundamental and the twelfth stay;
 *  - p3 = 2 doubles the twelfth's peak against the fundamental;
 *  - stretch +5% moves the octave's peak to 2f × 1.05 and the twelfth's to
 *    3f × 1.10.
 *
 * FAILS ON v0.0.175 at every claim: the sanitiser drops `additive`, so no bar
 * moves and every rendered pair is identical.
 */
const PROBE = async (moduleUrl) => {
  const mod = await import(moduleUrl);
  const voice = mod.VOICES.melody.stab;
  const SR = 48000;
  const F = 220;
  const NOTE = { when: 0.05, freq: F, midi: 57, velocity: 0.9, duration: 0.8 };
  const render = async (additive) => {
    const ctx = new OfflineAudioContext(1, SR, SR);
    const bus = ctx.createGain();
    bus.connect(ctx.destination);
    const patch = JSON.parse(JSON.stringify(voice.defaults));
    patch.additive = { ...patch.additive, ...additive };
    voice.play(ctx, bus, NOTE, patch);
    return (await ctx.startRendering()).getChannelData(0);
  };
  const spectrum = (data, fromSec, toSec) => {
    const from = Math.floor(fromSec * SR);
    const to = Math.min(Math.floor(toSec * SR), data.length);
    const n = 16384;
    const win = Math.min(n, to - from);
    const mag = new Float64Array(n / 2);
    for (let k = 0; k < n / 2; k++) {
      let sr = 0;
      let si = 0;
      const w = (2 * Math.PI * k) / n;
      for (let i = 0; i < win; i++) {
        const x = data[from + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / win));
        sr += x * Math.cos(w * i);
        si -= x * Math.sin(w * i);
      }
      mag[k] = Math.hypot(sr, si);
    }
    return { mag, binHz: SR / n };
  };
  const peakNear = ({ mag, binHz }, hz, tolerance) => {
    let best = 0;
    let at = 0;
    for (let k = Math.floor((hz - tolerance) / binHz); k <= Math.ceil((hz + tolerance) / binHz); k++) {
      if (k > 0 && k < mag.length && mag[k] > best) { best = mag[k]; at = k * binHz; }
    }
    return { level: best, at };
  };
  const floorOf = ({ mag }) => Array.from(mag).sort((a, b) => a - b)[Math.floor(mag.length / 2)];
  const out = {};
  const base = spectrum(await render({}), 0.2, 0.5);
  const noOctave = spectrum(await render({ p2: 0 }), 0.2, 0.5);
  const twelfth2 = spectrum(await render({ p3: 2 }), 0.2, 0.5);
  const stretched = spectrum(await render({ stretch: 0.05 }), 0.2, 0.5);
  out.floor = floorOf(base);
  out.base = { f1: peakNear(base, F, 8), f2: peakNear(base, 2 * F, 8), f3: peakNear(base, 3 * F, 8) };
  out.noOctave = { f1: peakNear(noOctave, F, 8), f2: peakNear(noOctave, 2 * F, 8), f3: peakNear(noOctave, 3 * F, 8) };
  out.twelfth2 = { f1: peakNear(twelfth2, F, 8), f3: peakNear(twelfth2, 3 * F, 8) };
  out.stretched = {
    f2at: peakNear(stretched, 2 * F * 1.05, 8), f2old: peakNear(stretched, 2 * F, 8),
    f3at: peakNear(stretched, 3 * F * 1.10, 8), f3old: peakNear(stretched, 3 * F, 8),
  };
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
  if (!moduleUrl) throw new Error('additive-render: could not find the engine-voices module URL');
  const m = await page.evaluate(
    ([fn, url]) => new Function(`return (${fn})`)()(url),
    [PROBE.toString(), moduleUrl],
  );
  const problems = [];
  if (!(m.base.f2.level > m.floor * 20)) problems.push(`the shipped stab has no octave partial to remove (level ${m.base.f2.level.toFixed(2)}, floor ${m.floor.toFixed(2)})`);
  if (!(m.noOctave.f2.level < m.base.f2.level * 0.05)) problems.push(`p2 0 did not remove the octave: ${m.base.f2.level.toFixed(2)} → ${m.noOctave.f2.level.toFixed(2)}`);
  if (!(Math.abs(m.noOctave.f1.level / m.base.f1.level - 1) < 0.1)) problems.push(`p2 0 moved the fundamental: ${m.base.f1.level.toFixed(2)} → ${m.noOctave.f1.level.toFixed(2)}`);
  const ratioBase = m.base.f3.level / m.base.f1.level;
  const ratioTwice = m.twelfth2.f3.level / m.twelfth2.f1.level;
  if (!(ratioTwice > ratioBase * 1.7 && ratioTwice < ratioBase * 2.3)) problems.push(`p3 2 did not double the twelfth against the fundamental: ${ratioBase.toFixed(3)} → ${ratioTwice.toFixed(3)}`);
  if (!(m.stretched.f2at.level > m.stretched.f2old.level * 3)) problems.push(`stretch +5% did not move the octave to ${(2 * 220 * 1.05).toFixed(0)} Hz (there ${m.stretched.f2at.level.toFixed(2)}, at 2f ${m.stretched.f2old.level.toFixed(2)})`);
  if (!(m.stretched.f3at.level > m.stretched.f3old.level * 3)) problems.push(`stretch +5% did not move the twelfth to ${(3 * 220 * 1.1).toFixed(0)} Hz`);
  if (problems.length) throw new Error('additive-render: ' + problems.join('\n  '));
  return { moduleUrl, measured: m, asserted: 6 };
}
