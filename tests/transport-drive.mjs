/**
 * Transport state machine, driven in a real browser.
 *
 * Run through the geometry bridge — it needs a rendered page with a live
 * AudioContext, which no mock-DOM smoke test can provide:
 *
 *   npm run build && .vibe/measure.sh local drive tests/transport-drive.mjs
 *
 * What it proves, in the owner's words from 2026-07-28: "The Stop button is
 * supposed to swap the Finish icon for the Stop icon, it is also supposed to
 * stop the playback immediately, which it does not do." Both halves are
 * checked here because both were true — the caption changed and nothing else
 * did.
 *
 * Exits non-zero (throws) on the first failed assertion, so a regression is a
 * failed command rather than a paragraph a reader has to compare by eye.
 */

const state = (page) =>
  page.evaluate(() => ({
    label: document.querySelector('.play-toggle-label').textContent.trim(),
    playGlyph: !document.querySelector('.play-glyph').hidden,
    finishGlyph: !document.querySelector('.finish-glyph').hidden,
    stopGlyph: !document.querySelector('.stop-glyph').hidden,
    disabled: document.getElementById('toggle-play').disabled,
    // The engine is not on `window`, so the honest external witness for
    // "is sound being made" is the transport's own pressed state plus the
    // Pause key's availability, both written from `engine.running`.
    pressed: document.getElementById('toggle-play').getAttribute('aria-pressed'),
    pauseDisabled: document.getElementById('pause-toggle').disabled,
  }));

export default async function drive(page) {
  const results = [];
  const check = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want });
    return ok;
  };

  const idle = await state(page);
  check('idle: reads Play with the ▶ glyph', [idle.label, idle.playGlyph, idle.finishGlyph, idle.stopGlyph], ['Play', true, false, false]);

  await page.click('#toggle-play');
  await page.waitForTimeout(1500);
  const playing = await state(page);
  check('playing: reads Finish with the 𝄂 glyph', [playing.label, playing.playGlyph, playing.finishGlyph, playing.stopGlyph], ['Finish', false, true, false]);
  check('playing: the key is pressed and Pause is live', [playing.pressed, playing.pauseDisabled], ['true', false]);

  // First press of Finish: the outro starts. The caption becomes Stop and the
  // key MUST stay enabled — a disabled key is the other way this gesture used
  // to die.
  await page.click('#toggle-play');
  await page.waitForTimeout(400);
  const finishing = await state(page);
  check('finishing: reads Stop with the ■ glyph', [finishing.label, finishing.playGlyph, finishing.finishGlyph, finishing.stopGlyph], ['Stop', false, false, true]);
  check('finishing: the key stays enabled', finishing.disabled, false);

  // Second press: the outro is cut short NOW. The outro is ~8 s of fade, so
  // anything under a second is proof the press did it rather than the fade
  // running its course.
  const t0 = Date.now();
  await page.click('#toggle-play');
  await page.waitForFunction(
    () => document.querySelector('.play-toggle-label').textContent.trim() === 'Play',
    { timeout: 3000 },
  ).catch(() => {});
  const elapsed = Date.now() - t0;
  const stopped = await state(page);
  check('stopped: back to Play with the ▶ glyph', [stopped.label, stopped.playGlyph, stopped.finishGlyph, stopped.stopGlyph], ['Play', true, false, false]);
  check('stopped: immediately, not after the 8 s outro', elapsed < 2000, true);
  results.push({ name: 'stop latency (ms)', ok: true, got: elapsed, want: '< 2000' });

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'transport-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n'),
    );
  }
  return { passed: results.length, checks: results.map((r) => r.name) };
}
