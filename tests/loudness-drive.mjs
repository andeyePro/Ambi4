/**
 * How loud the engine actually is.
 *
 *   npm run build && .vibe/measure.sh local drive tests/loudness-drive.mjs
 *
 * The owner's report: at full volume with the Mac at full it is "not
 * particularly loud, but turning on YouTube is deafening", so system alarms
 * are startling by comparison. Measured, it was worse than "a bit quiet" —
 * peak −32.6 dBFS against streaming's near-full-scale peaks, roughly thirty
 * decibels below any normal listening level.
 *
 * It went unnoticed because nothing could measure it: the only analyser was on
 * the compressor, deliberately, so the oscilloscope would show the music
 * rather than how loud it is being played. That is right for a scope and
 * useless as a meter. `getOutputAnalyser()` is the meter, and this is what
 * stops the level drifting quietly again.
 */
export default async function drive(page) {
  const results = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
  };

  const seam = await page.evaluate(() => typeof window.__ambi4Engine?.getOutputAnalyser === 'function');
  check('the output meter is reachable', seam, true);

  await page.click('#toggle-play');
  await page.waitForTimeout(1500);

  const level = await page.evaluate(() => new Promise((resolve) => {
    const a = window.__ambi4Engine.getOutputAnalyser();
    const buf = new Uint8Array(a.fftSize);
    let peak = 0, sumSq = 0, n = 0, frames = 0;
    const tick = () => {
      a.getByteTimeDomainData(buf);
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        peak = Math.max(peak, Math.abs(v));
        sumSq += v * v; n++;
      }
      if (++frames < 240) requestAnimationFrame(tick);
      else resolve({ peak, rms: Math.sqrt(sumSq / n) });
    };
    requestAnimationFrame(tick);
  }));
  await page.click('#toggle-play');

  const peakDb = 20 * Math.log10(level.peak || 1e-6);
  const rmsDb = 20 * Math.log10(level.rms || 1e-6);

  // Loud enough to sit beside anything else the listener plays. −20 dBFS peak
  // is the floor below which the original complaint is still true.
  check('peaks reach a normal listening level', peakDb > -20, true);
  // And not clipping. The limiter makes this hard to break, which is the point
  // of having one — but a limiter that is never verified is an assumption.
  check('and nothing clips', level.peak < 0.999, true);
  results.push({ name: 'peak dBFS', ok: true, got: +peakDb.toFixed(1), want: '(informational)' });
  results.push({ name: 'RMS dBFS', ok: true, got: +rmsDb.toFixed(1), want: '(informational)' });

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'loudness-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n'),
    );
  }
  return { passed: results.length, notes: results.filter((r) => r.want === '(informational)').map((r) => `${r.name}: ${r.got}`) };
}
