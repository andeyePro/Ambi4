/**
 * The mix goes STRAIGHT to the speakers everywhere but iOS.
 *
 *   npm run build && .vibe/measure.sh local drive tests/latency-drive.mjs
 *
 * The owner (a percussionist, three times in one night): musical-typing
 * latency is "intolerable". The engine routed EVERY platform's mix through a
 * MediaStream → <audio> element — an iOS-only need (only iOS's hardware mute
 * switch silences a bare AudioContext) that adds the media pipeline's own
 * buffering, over and above the audio context's, on machines that never
 * needed it. v0.0.91 gates the element sink to iOS.
 *
 * This asserts the route on a desktop browser is DIRECT and reports the
 * context's own latency figures — the honest floor a browser instrument
 * stands on, which no scheduling change can go below.
 */

export default async function drive(page) {
  const results = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
  };

  await page.click('#consent-slot button:has-text("Save on this device")').catch(() => {});
  await page.waitForTimeout(300);

  // Arm the engine via the Create door's keys — a user gesture, no music.
  await page.click('#play-along-open');
  await page.waitForTimeout(250);
  await page.click('#play-along-toggle');
  await page.waitForTimeout(400);

  const info = await page.evaluate(() => window.__ambi4Engine.getOutputInfo());
  check('the engine reports its output route', !!info, (v) => v === true);
  check('desktop output is DIRECT — no media-element hop', info?.mode, 'direct');
  results.push({
    name: 'context latency (ms)',
    ok: true,
    got: info ? {
      base: info.baseLatency != null ? Math.round(info.baseLatency * 1000 * 10) / 10 : null,
      output: info.outputLatency != null ? Math.round(info.outputLatency * 1000 * 10) / 10 : null,
      sampleRate: info.sampleRate,
    } : null,
    want: '(informational)',
  });

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'latency-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n'),
    );
  }
  return { passed: results.length, notes: results.filter((r) => r.want === '(informational)').map((r) => `${r.name}: ${JSON.stringify(r.got)}`) };
}
