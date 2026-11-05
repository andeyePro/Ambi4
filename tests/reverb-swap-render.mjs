/**
 * The reverb swap, rendered: does the wet level hold while one tail hands over
 * to another?
 *
 *   npm run build && .vibe/measure.sh local drive tests/reverb-swap-render.mjs
 *
 * A Reverb tail change (and a RANGED Reverb tail, once a bar) builds a new
 * convolver and crossfades the return from the old one to it. The new
 * convolver starts EMPTY — it has heard nothing yet — and the two tails are
 * uncorrelated noise, so their powers add. Until v0.0.294 both returns ramped
 * linearly over the same half-second: at the midpoint the sum was half the
 * power (-3 dB), and the old tail was gone before the new one had built, so
 * the reverb sagged under every swap (the 2026-10-30 click audit's open item).
 *
 * This renders it with the SHIPPED scheduling (`scheduleReverbSwap`, the
 * function the engine's swapReverb calls) and the shipped impulse builder,
 * through real ConvolverNodes in an OfflineAudioContext: steady noise into a
 * send bus, a settled 4 s tail, a swap at 6 s (the context suspends there, so
 * the new convolver is connected empty, as in the engine), and the wet RMS in
 * 200 ms windows (50 ms windows of reverberated noise wobble by ±3 dB on their
 * own, which read as a dip that is not one). It renders the v0.0.293 schedule beside it (two linear 0.5 s
 * ramps, reproduced here because that code is gone) so the improvement is a
 * measured number, not a claim. Also: a ranged tail swapping every two
 * seconds, 4 s ⇄ 2 s, eight times.
 *
 * RED when the shipped swap's deepest 200 ms window falls more than 1.5 dB
 * under the quieter of the two settled tails, or when it is not at least 2 dB
 * better than the old schedule.
 */

const PROBE = async (moduleUrl) => {
  const mod = await import(moduleUrl);
  const SR = 48000;
  const LEVEL = 0.9;
  const legacy = (prev, next, time) => {
    next.setValueAtTime(0, time);
    next.linearRampToValueAtTime(LEVEL, time + 0.5);
    prev.cancelAndHoldAtTime(time);
    prev.linearRampToValueAtTime(0, time + 0.5);
  };
  const shipped = (prev, next, time, oldSeconds, outFrom) =>
    mod.scheduleReverbSwap(prev, next, { time, sampleRate: SR, level: LEVEL, outFrom, oldSeconds });

  // swaps: [{ at, seconds }]; the first tail is `first` seconds long.
  const render = async (scheme, first, swaps, total) => {
    const ctx = new OfflineAudioContext(2, Math.ceil(SR * total), SR);
    let seed = 7;
    const rng = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    // As long as the render, never looped: a looped 4 s buffer put the same
    // quiet patch under the tail every 4 s, which read as a 3 dB "dip" at the
    // same phase whether a swap was there or not.
    const noise = ctx.createBuffer(2, Math.ceil(SR * total), SR);
    for (let ch = 0; ch < 2; ch++) { const d = noise.getChannelData(ch); for (let i = 0; i < d.length; i++) d[i] = (rng() * 2 - 1) * 0.3; }
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const bus = ctx.createGain();
    src.connect(bus);
    const make = (seconds) => {
      const conv = ctx.createConvolver();
      conv.normalize = true;
      conv.buffer = mod.createImpulseResponse(ctx, seconds, undefined, rng);
      const ret = ctx.createGain();
      conv.connect(ret);
      ret.connect(ctx.destination);
      return { conv, ret, seconds };
    };
    let live = make(first);
    live.ret.gain.value = LEVEL;
    bus.connect(live.conv);
    let rise = null;
    for (const swap of swaps) {
      ctx.suspend(swap.at).then(() => {
        const next = make(swap.seconds);
        next.ret.gain.value = 0;
        bus.connect(next.conv);
        const time = ctx.currentTime;
        if (scheme === 'legacy') legacy(live.ret.gain, next.ret.gain, time);
        else {
          const outFrom = mod.reverbRiseValue(rise, time);
          rise = shipped(live.ret.gain, next.ret.gain, time, live.seconds, outFrom).rise;
        }
        live = next;
        ctx.resume();
      });
    }
    src.start(0);
    const out = await ctx.startRendering();
    const a = out.getChannelData(0);
    const b = out.getChannelData(1);
    const win = Math.round(SR * 0.2);
    const rms = [];
    for (let i = 0; i + win <= a.length; i += win) {
      let ss = 0;
      for (let j = i; j < i + win; j++) ss += (a[j] * a[j] + b[j] * b[j]) / 2;
      rms.push(Math.sqrt(ss / win));
    }
    return rms;
  };
  const mean = (xs) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
  const at = (t) => Math.round(t / 0.2);
  const db = (x) => 20 * Math.log10(Math.max(x, 1e-9));

  const out = {};
  // One swap, 4 s → 2 s at 6 s, and 2 s → 4 s.
  for (const [name, from, to] of [['4s->2s', 4, 2], ['2s->4s', 2, 4]]) {
    out[name] = {};
    for (const scheme of ['legacy', 'shipped']) {
      const rms = await render(scheme, from, [{ at: 6, seconds: to }], 16);
      const before = mean(rms.slice(at(4.4), at(5.8)));
      const after = mean(rms.slice(at(13.4), at(15.4)));
      const floor = Math.min(before, after);
      const during = rms.slice(at(6), at(11));
      const deepest = Math.min(...during);
      out[name][scheme] = {
        settledBeforeDb: +db(before).toFixed(2),
        settledAfterDb: +db(after).toFixed(2),
        dipDb: +(db(deepest) - db(floor)).toFixed(2),
        deepestAt: +(6 + during.indexOf(deepest) * 0.2).toFixed(2),
        // How far a settled stretch's own quietest window sits under its mean:
        // reverberated noise wobbles, and a dip is only a dip past that.
        trace: [5, 6, 6.4, 7, 7.6, 8, 8.2, 8.6, 9, 10, 12.2, 14].map((t) => [t, +(db(rms[at(t)]) - db(floor)).toFixed(2)]),
        settledWobbleDb: +(db(Math.min(...rms.slice(at(4.4), at(5.8)), ...rms.slice(at(13.4), at(15.4)))) - db(floor)).toFixed(2),
      };
    }
  }
  // A ranged tail: a swap every 2 s, alternating, eight times.
  out.ranged = {};
  for (const scheme of ['legacy', 'shipped']) {
    const swaps = Array.from({ length: 8 }, (unused, i) => ({ at: 6 + i * 2, seconds: i % 2 === 0 ? 2 : 4 }));
    const rms = await render(scheme, 4, swaps, 24);
    // The two tails settle 4 dB apart (a 2 s tail is quieter), so the floor
    // is the QUIETER one's settled level, from the single swaps above.
    const quieter = Math.pow(10, Math.min(out['4s->2s'].shipped.settledAfterDb, out['2s->4s'].shipped.settledBeforeDb) / 20);
    const during = rms.slice(at(6), at(22));
    out.ranged[scheme] = {
      floorDb: +db(quieter).toFixed(2),
      deepestDb: +(db(Math.min(...during)) - db(quieter)).toFixed(2),
    };
  }
  return out;
};

export default async function drive(page) {
  const moduleUrl = await page.evaluate(async () => {
    const html = await (await fetch('/')).text();
    const direct = html.match(/\/_astro\/ambient-engine\.[A-Za-z0-9_-]+\.js/);
    if (direct) return direct[0];
    const entry = html.match(/\/_astro\/index\.astro[^"']+\.js/);
    if (!entry) return null;
    const js = await (await fetch(entry[0])).text();
    const nested = js.match(/ambient-engine\.[A-Za-z0-9_-]+\.js/);
    return nested ? `/_astro/${nested[0]}` : null;
  });
  if (!moduleUrl) throw new Error('reverb-swap-render: could not find the engine module URL');
  const result = await page.evaluate(
    ([fn, url]) => new Function(`return (${fn})`)()(url),
    [PROBE.toString(), moduleUrl],
  );
  const failures = [];
  for (const name of ['4s->2s', '2s->4s']) {
    const { legacy, shipped } = result[name];
    if (shipped.dipDb < -1.5) failures.push(`${name}: the shipped swap dips ${shipped.dipDb} dB under the settled level (limit -1.5)`);
    if (shipped.dipDb - legacy.dipDb < 2) failures.push(`${name}: the shipped swap (${shipped.dipDb} dB) is not 2 dB better than the old schedule (${legacy.dipDb} dB)`);
  }
  if (result.ranged.shipped.deepestDb < -2) failures.push(`ranged: a tail swapping every 2 s sags to ${result.ranged.shipped.deepestDb} dB (limit -2)`);
  if (failures.length) throw new Error('reverb-swap-render:\n  ' + failures.join('\n  ') + '\n' + JSON.stringify(result, null, 1));
  return { moduleUrl, ...result };
}
