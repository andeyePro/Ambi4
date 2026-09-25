/**
 * The Modal section, measured from a REAL offline render (unit 6 of
 * docs/synthesis-programme.md). PARKED in tests/pending until the Mac test
 * bridge key is restored (fromClaude 13); then:
 *
 *   npm run build && .vibe/measure.sh local drive tests/modal-render-drive.mjs
 *
 * Node proves the graph (tests/voices-smoke.mjs). This proves the SOUND on
 * Chimes at A4:
 *
 *  - material wood puts spectral peaks at 4f and 9.2f where metal had 2.76f
 *    and 5.4f (each render's peaks present, the other's absent);
 *  - damping 2 roughly halves the fundamental's ring: the time its envelope
 *    takes to fall 20 dB below its peak;
 *  - hardness 2 raises the spectral centroid of the first 100 ms.
 *
 * FAILS ON v0.0.176 at every claim: the sanitiser drops `modal`, so no dial
 * moves and every rendered pair is identical.
 */
const PROBE = async (moduleUrl) => {
  const mod = await import(moduleUrl);
  const voice = mod.VOICES.texture.chimes;
  const SR = 48000;
  const F = 440;
  const NOTE = { when: 0.05, freq: F, midi: 69, velocity: 0.9, duration: 0.5 };
  const render = async (modal) => {
    const ctx = new OfflineAudioContext(1, SR * 4, SR);
    const bus = ctx.createGain();
    bus.connect(ctx.destination);
    const patch = JSON.parse(JSON.stringify(voice.defaults));
    patch.modal = { ...patch.modal, ...modal };
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
    for (let k = Math.floor((hz - tolerance) / binHz); k <= Math.ceil((hz + tolerance) / binHz); k++) {
      if (k > 0 && k < mag.length && mag[k] > best) best = mag[k];
    }
    return best;
  };
  const centroid = ({ mag, binHz }) => {
    let num = 0;
    let den = 0;
    for (let k = 1; k < mag.length; k++) { num += k * binHz * mag[k]; den += mag[k]; }
    return den > 0 ? num / den : 0;
  };
  // Envelope of |x| in 10 ms blocks; the time it falls 20 dB below its peak.
  const ringTime = (data) => {
    const block = Math.floor(SR / 100);
    const env = [];
    for (let i = 0; i + block <= data.length; i += block) {
      let peak = 0;
      for (let j = i; j < i + block; j++) peak = Math.max(peak, Math.abs(data[j]));
      env.push(peak);
    }
    const top = Math.max(...env);
    const at = env.indexOf(top);
    for (let i = at; i < env.length; i++) if (env[i] < top * 0.1) return (i - at) / 100;
    return (env.length - at) / 100;
  };
  const out = {};
  const metal = await render({});
  const wood = await render({ material: 'wood' });
  const sm = spectrum(metal, 0.1, 0.44);
  const sw = spectrum(wood, 0.1, 0.44);
  out.metal = { own276: peakNear(sm, F * 2.76, 12), own54: peakNear(sm, F * 5.4, 12), wood4: peakNear(sm, F * 4, 12), wood92: peakNear(sm, F * 9.2, 12) };
  out.wood = { own4: peakNear(sw, F * 4, 12), own92: peakNear(sw, F * 9.2, 12), metal276: peakNear(sw, F * 2.76, 12), metal54: peakNear(sw, F * 5.4, 12) };
  out.ringBase = ringTime(metal);
  out.ringDamped = ringTime(await render({ damping: 2 }));
  out.centroidBase = centroid(spectrum(metal, 0.05, 0.15));
  out.centroidHard = centroid(spectrum(await render({ hardness: 2 }), 0.05, 0.15));
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
  if (!moduleUrl) throw new Error('modal-render: could not find the engine-voices module URL');
  const m = await page.evaluate(
    ([fn, url]) => new Function(`return (${fn})`)()(url),
    [PROBE.toString(), moduleUrl],
  );
  const problems = [];
  if (!(m.metal.own276 > m.metal.wood4 * 3 && m.metal.own54 > m.metal.wood92 * 3)) problems.push(`metal does not ring at 2.76f and 5.4f over the wood slots (${JSON.stringify(m.metal)})`);
  if (!(m.wood.own4 > m.wood.metal276 * 3 && m.wood.own92 > m.wood.metal54 * 3)) problems.push(`wood does not ring at 4f and 9.2f over the metal slots (${JSON.stringify(m.wood)})`);
  if (!(m.ringDamped < m.ringBase * 0.7)) problems.push(`damping 2 did not shorten the ring: ${m.ringBase.toFixed(2)} s → ${m.ringDamped.toFixed(2)} s`);
  if (!(m.centroidHard > m.centroidBase * 1.1)) problems.push(`hardness 2 did not brighten the strike: centroid ${m.centroidBase.toFixed(0)} → ${m.centroidHard.toFixed(0)} Hz`);
  if (problems.length) throw new Error('modal-render: ' + problems.join('\n  '));
  return { moduleUrl, measured: m, asserted: 4 };
}
