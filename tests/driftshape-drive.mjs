/**
 * What a spread does between its two ends.
 *
 *   npm run build && .vibe/measure.sh local drive tests/driftshape-drive.mjs
 *
 * The owner's sentence, asking for the patching system: "so you can have a
 * voice crescendo when you want it to rather than just setting it to be a
 * random volume between min and max."
 *
 * Until v0.0.72 a spread meant exactly one thing — somewhere in here,
 * unpredictably — so a crescendo, one of the most ordinary things a musician
 * asks for, was unreachable. The engine side is proven in engine-smoke (a rise
 * climbs monotonically, a fall falls, a swell turns round); this proves the
 * control exists, offers the four shapes, and that choosing one REACHES the
 * engine rather than only the settings tree.
 */
export default async function drive(page) {
  const results = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
  };

  await page.click('#tab-advanced');
  await page.waitForTimeout(400);
  const opened = await page.evaluate(() => {
    for (const row of document.querySelectorAll('.track-row')) {
      if (/pad/i.test(row.textContent || '')) { row.querySelector('.voice-edit-toggle')?.click(); return true; }
    }
    return false;
  });
  check('the pad editor opened', opened, true);
  await page.waitForTimeout(600);

  const control = await page.evaluate(() => {
    const s = document.querySelector('.drift-shape select');
    return s ? { options: [...s.options].map((o) => o.textContent), value: s.value } : null;
  });
  check('the spread-shape control is offered', !!control, true);
  if (!control) throw new Error('driftshape-drive: no control to test');
  check('all four shapes are offered', control.options, ['Drift', 'Rise', 'Fall', 'Swell']);
  check('and it starts on the shape everything has always had', control.value, 'drift');

  await page.selectOption('.drift-shape select', 'rise');
  await page.waitForTimeout(500);
  // The load-bearing check: it has to reach the ENGINE. A control that only
  // writes the settings tree looks identical from the outside and does nothing.
  const inEngine = await page.evaluate(() =>
    window.__ambi4Engine?.getParams()?.tracks?.pad?.driftShape ?? null);
  check('choosing a shape reaches the engine', inEngine, 'rise');

  await page.selectOption('.drift-shape select', 'drift');
  await page.waitForTimeout(400);
  const back = await page.evaluate(() =>
    window.__ambi4Engine?.getParams()?.tracks?.pad?.driftShape ?? null);
  check('and it can be handed back', back, 'drift');

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'driftshape-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n'),
    );
  }
  return { passed: results.length };
}
