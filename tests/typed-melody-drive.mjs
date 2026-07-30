/**
 * Typed melody: note names become PINNED steps on the melody grid.
 *
 *   npm run build && .vibe/measure.sh local drive tests/typed-melody-drive.mjs
 *
 * His compose list ("type in notes/chords/words"), first method landed: one
 * token per beat, a dash holds, a dot rests. Asserted at the ENGINE's stored
 * steps — pins, ties and the manual mode — because a melody the input drew
 * and the engine never received is this project's oldest failure class.
 */

export default async function drive(page) {
  const results = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
  };

  await page.click('#consent-slot button:has-text("Save on this device")').catch(() => {});
  await page.waitForTimeout(200);

  // Pin Synthwave (always 4/4) so "one token per beat" means four beats.
  await page.evaluate(() => {
    const sel = document.getElementById('genre-select');
    const opt = [...sel.options].find((o) => o.value === 'g:synthwave');
    if (opt) {
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  const pinned = await page
    .waitForFunction(() => window.__ambi4Engine?.getParams?.()?.genre === 'synthwave', { timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  check('Synthwave pinned (4/4)', pinned, (v) => v === true);

  await page.click('#play-along-open');
  await page.waitForTimeout(300);

  await page.fill('#compose-melody-text', 'C4 E4 G4 -');
  await page.click('#compose-melody-write');
  await page.waitForTimeout(400);

  const stored = await page.evaluate(() => {
    const seq = window.__ambi4Engine.getParams().tracks.melody.sequencers[0];
    const s = seq.steps;
    return {
      mode: seq.mode,
      pins: [s[0]?.midi ?? null, s[4]?.midi ?? null, s[8]?.midi ?? null],
      holdOn: [s[9]?.on, s[12]?.on, s[15]?.on],
      holdTied: [s[8]?.tie, s[11]?.tie, s[14]?.tie],
      afterOff: [s[16]?.on, s[17]?.on],
      tip: document.getElementById('guided-tip')?.textContent || '',
    };
  });
  check('the melody lane went manual', stored.mode, 'manual');
  check('the typed notes are PINNED at their beats', stored.pins, [60, 64, 67]);
  check('the dash holds the G through its beat and the next', stored.holdOn, [true, true, true]);
  check('…as one tied note', stored.holdTied, [true, true, true]);
  check('nothing plays past the phrase', stored.afterOff, [false, false]);
  check('the writer says what it wrote', /3 notes/.test(stored.tip), (v) => v === true);

  // Garbage is refused with a reason, and the engine keeps the melody.
  await page.fill('#compose-melody-text', 'xyz qq9');
  await page.click('#compose-melody-write');
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => ({
    pin0: window.__ambi4Engine.getParams().tracks.melody.sequencers[0].steps[0]?.midi ?? null,
    tip: document.getElementById('guided-tip')?.textContent || '',
  }));
  check('garbage leaves the engine untouched', after.pin0, 60);
  check('…and says why', /understood/.test(after.tip), (v) => v === true);

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'typed-melody-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n'),
    );
  }
  return { passed: results.length };
}
