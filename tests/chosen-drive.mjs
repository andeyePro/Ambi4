/**
 * The step grid shows what the ENGINE chose, not only what you typed.
 *
 *   npm run build && .vibe/measure.sh local drive tests/chosen-drive.mjs
 *
 * Step one of the agreed plan, and the thing every later step depends on:
 * "the app decides the chords, the rhythm and which notes get played, and
 * shows you none of it". In Auto the grid rendered only user-entered steps, so
 * the panel sat blank while the engine played a full pattern through it.
 *
 * The check has to open an editor for a track that is actually SOUNDING —
 * percussion is off in several genres, and an empty grid there proves nothing
 * either way. That mistake cost a debugging round, so the test states it.
 */
export default async function drive(page) {
  const results = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
  };

  await page.click('#tab-advanced');
  await page.waitForTimeout(300);

  // Bass: sequenced, and on in every genre that ships.
  const opened = await page.evaluate(() => {
    for (const row of document.querySelectorAll('.track-row')) {
      if (/bass/i.test(row.textContent || '')) {
        row.querySelector('.voice-edit-toggle')?.click();
        return true;
      }
    }
    return false;
  });
  check('the bass editor opened', opened, true);
  await page.waitForTimeout(500);

  const before = await page.evaluate(() => document.querySelectorAll('.seq-cell-chosen').length);
  check('nothing is marked as chosen before playing', before, 0);

  await page.click('#toggle-play');
  await page.waitForTimeout(7000);
  const during = await page.evaluate(() => ({
    chosen: document.querySelectorAll('.seq-cell-chosen').length,
    cells: document.querySelectorAll('.seq-cell').length,
  }));
  check('the grid marks steps the engine chose', during.chosen > 0, true);
  // A layer that lights every cell would be as uninformative as one that
  // lights none — the pattern has to be a pattern.
  check('and not every cell', during.chosen < during.cells, true);
  results.push({ name: 'chosen / cells', ok: true, got: `${during.chosen} / ${during.cells}`, want: '(informational)' });

  await page.click('#toggle-play');
  await page.waitForTimeout(400);

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'chosen-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n'),
    );
  }
  return { passed: results.length, notes: results.filter((r) => r.want === '(informational)').map((r) => `${r.name}: ${r.got}`) };
}
