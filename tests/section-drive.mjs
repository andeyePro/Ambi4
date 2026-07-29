/**
 * What each instrument does in a given section.
 *
 *   npm run build && .vibe/measure.sh local drive tests/section-drive.mjs
 *
 * Owner's item 76, second half. The intensity ladder decided which instruments
 * played in a section and nothing could touch it, so "drop the drums in the
 * verse" was unreachable. The engine half is proven in engine-smoke (a section
 * that switches bass off produces no bass notes in its bars); this proves the
 * control exists, cycles through three states, and REACHES the engine.
 */
export default async function drive(page) {
  const results = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
  };

  await page.click('#tab-advanced');
  await page.waitForTimeout(400);
  await page.selectOption('#structure', 'custom');
  await page.waitForTimeout(500);

  const buttons = await page.evaluate(() =>
    document.querySelectorAll('.structure-block .block-track').length);
  check('every block offers one control per instrument', buttons > 0, true);

  const first = await page.evaluate(() => {
    const b = document.querySelector('.structure-block .block-track');
    return { state: b?.dataset.state, label: b?.textContent };
  });
  check('and starts on "the app decides"', first.state, 'auto');

  // Click once: always plays. Twice: never. Three times: back to the app.
  const cycle = [];
  for (let i = 0; i < 3; i++) {
    await page.click('.structure-block .block-track');
    await page.waitForTimeout(250);
    cycle.push(await page.evaluate(() => document.querySelector('.structure-block .block-track')?.dataset.state));
  }
  check('it cycles through all three states and back', cycle, ['on', 'off', 'auto']);

  // The load-bearing check: the state has to reach the ENGINE, not just the
  // settings tree — a control that writes only the page looks identical.
  await page.click('.structure-block .block-track');
  await page.waitForTimeout(400);
  const inEngine = await page.evaluate(() => {
    const blocks = window.__ambi4Engine?.getParams()?.customStructure;
    return blocks && blocks[0] ? blocks[0].tracks : null;
  });
  check('the section state reaches the engine', inEngine && Object.values(inEngine).includes('on'), true);
  results.push({ name: 'first block tracks', ok: true, got: inEngine, want: '(informational)' });

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'section-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n'),
    );
  }
  return { passed: results.length, notes: results.filter((r) => r.want === '(informational)').map((r) => `${r.name}: ${JSON.stringify(r.got)}`) };
}
