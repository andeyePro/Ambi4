/**
 * Play-along actually plays: a key pressed after Enable reaches the ENGINE.
 *
 *   npm run build && .vibe/measure.sh local drive tests/play-along-drive.mjs
 *
 * The owner (2026-07-29): "play-along hasn't worked since some time after my
 * asking for the latency to be improved." The break was v0.0.40 making the
 * panel a popover: the popover carries role="dialog", and the instrument's
 * own typing guard treats ANY dialog as "someone is typing — do not play".
 * Enabling play-along leaves focus on the Enable button INSIDE that dialog,
 * so every note key was swallowed by the panel that exists to make them work;
 * closing the popover disarms by design, so there was no state left in which
 * a key made a sound.
 *
 * The test asserts at the engine seam, not the DOM: `noteOn`/`noteOff` are
 * wrapped and counted, because a readout drawing a note the engine never
 * received is the failure mode this repo has already met twice. It also
 * asserts the guard SURVIVES where it is right: keys pressed while the track
 * select has focus must still not play.
 */

export default async function drive(page) {
  const results = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
  };

  await page.click('#consent-slot button:has-text("Save on this device")').catch(() => {});
  await page.waitForTimeout(200);

  // Count at the seam. The page's closure re-reads engine.noteOn at call
  // time, so wrapping the method on the seam object sees every real call.
  await page.evaluate(() => {
    const e = window.__ambi4Engine;
    window.__pa = { on: [], off: [] };
    const on = e.noteOn.bind(e);
    const off = e.noteOff.bind(e);
    e.noteOn = (track, midi, velocity) => { window.__pa.on.push([track, midi]); return on(track, midi, velocity); };
    e.noteOff = (track, midi) => { window.__pa.off.push([track, midi]); return off(track, midi); };
  });

  // Open the popover and enable the keys — the exact two clicks a user makes.
  await page.click('#play-along-open');
  await page.waitForTimeout(250);
  const panelOpen = await page.evaluate(() => !document.getElementById('play-along').hidden);
  check('the play-along popover opens', panelOpen, (v) => v === true);

  await page.click('#play-along-toggle');
  await page.waitForTimeout(250);
  const armed = await page.evaluate(() =>
    document.getElementById('play-along-toggle').getAttribute('aria-pressed'));
  check('Enable arms the keys', armed, 'true');

  // Focus is now on the Enable button, inside the popover — the state every
  // user is in the moment they enable. Press a note.
  await page.keyboard.down('z');
  await page.waitForTimeout(200);
  await page.keyboard.up('z');
  await page.waitForTimeout(200);
  const afterZ = await page.evaluate(() => ({
    on: window.__pa.on.length,
    off: window.__pa.off.length,
    readout: document.getElementById('play-along-readout').textContent,
  }));
  check('the key reaches the ENGINE (noteOn)', afterZ.on > 0, (v) => v === true);
  check('and releases it (noteOff)', afterZ.off > 0, (v) => v === true);
  results.push({ name: 'readout after z', ok: true, got: afterZ.readout, want: '(informational)' });

  // A second note, upper row, still with the popover focused somewhere.
  await page.keyboard.down('q');
  await page.waitForTimeout(150);
  await page.keyboard.up('q');
  await page.waitForTimeout(150);
  const afterQ = await page.evaluate(() => window.__pa.on.length);
  check('a second key plays too', afterQ > afterZ.on, (v) => v === true);

  // The guard survives where it is right: the track select has focus — that
  // is someone choosing, not playing.
  const beforeSelect = await page.evaluate(() => window.__pa.on.length);
  await page.focus('#play-along-track');
  await page.keyboard.down('z');
  await page.waitForTimeout(150);
  await page.keyboard.up('z');
  await page.waitForTimeout(150);
  const afterSelect = await page.evaluate(() => window.__pa.on.length);
  check('keys in the track select still do not play', afterSelect === beforeSelect, (v) => v === true);

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'play-along-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n'),
    );
  }
  return { passed: results.length, notes: results.filter((r) => r.want === '(informational)').map((r) => `${r.name}: ${JSON.stringify(r.got)}`) };
}
