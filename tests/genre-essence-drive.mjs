/**
 * The genre's essence is on screen as CONTROLS, and a gesture on them reaches
 * the ENGINE (unit 10 of docs/synthesis-programme.md, v0.0.178). Promoted
 * from tests/pending on 2026-11-05, once the test bridge was back:
 *
 *   npm run build && .vibe/measure.sh local drive tests/genre-essence-drive.mjs
 *
 * page-boot already types into the Tempo readout and reads the engine; this
 * is the GESTURE half — a sideways drag on the Tempo dial opens a span, Apply
 * draws inside it — plus the weighted rows: a metre row set to 3/4 with the
 * others removed compiles to 3/4, at the engine, with the same dice.
 *
 * Traps this honours (CLAUDE.md): the genre is pinned first; the dial is
 * scrolled into view and its box re-read before the drag; the assertions read
 * the engine's stored value, not the readout.
 */
export default async function drive(page) {
  const results = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
  };
  await page.click('#consent-slot button:has-text("Save on this device")').catch(() => {});
  await page.waitForTimeout(200);

  await page.selectOption('#genre-select', 'g:synthwave');
  await page.waitForFunction(() => window.__ambi4Engine?.getParams().genre === 'synthwave');
  await page.click('#genre-rules-toggle');
  await page.waitForSelector('#genre-rules:not([hidden])');

  // The Tempo dial: drag sideways to open a span, then Apply.
  const dial = page.locator('#genre-rules-tempo-ui .rules-dial[data-field="essence.bpm"] .knob');
  await dial.scrollIntoViewIfNeeded();
  const box = await dial.boundingBox();
  check('the Tempo dial renders', !!box, true);
  if (box) {
    const readSpan = () => page.evaluate(() => {
      const el = document.querySelector('#genre-rules-tempo-ui .rules-dial[data-field="essence.bpm"] .knob-value');
      const nums = (el?.textContent || '').match(/\d+(\.\d+)?/g)?.map(Number) || [];
      return { text: el ? el.textContent : null, lo: nums[0], hi: nums.length > 1 ? nums[1] : nums[0] };
    });
    const spanBefore = await readSpan();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 60, cy, { steps: 12 });
    await page.mouse.up();
    await page.click('#genre-rules-apply');
    await page.waitForTimeout(300);
    const bpm = await page.evaluate(() => window.__ambi4Engine.getParams().bpm);
    const span = await readSpan();
    check('a sideways drag widened the tempo span', { before: spanBefore, after: span },
      ({ before: b, after: a }) => Number.isFinite(a.lo) && Number.isFinite(a.hi) && a.hi > a.lo && (a.hi - a.lo) > (b.hi - b.lo));
    check('Apply drew the ENGINE\'s bpm from inside the span', { bpm, span },
      ({ bpm: b, span: s }) => Number.isFinite(b) && b >= s.lo && b <= s.hi);
  }

  // The metre rows: keep one, set it to 3/4, remove the rest, Apply.
  const rows = page.locator('#genre-rules-metres-ui .rules-row');
  const count = await rows.count();
  check('synthwave declares one metre row', count, 1);
  await rows.first().locator('select').selectOption('3/4');
  await page.click('#genre-rules-apply');
  await page.waitForFunction(() => window.__ambi4Engine?.getParams().timeSignature === '3/4');
  check('a metre row set to 3/4 compiles to 3/4 at the engine', await page.evaluate(() => window.__ambi4Engine.getParams().timeSignature), '3/4');
  check('the Rules button says edited', await page.textContent('#genre-rules-toggle'), 'Rules · edited');

  await page.click('#genre-rules-reset');
  await page.waitForFunction(() => window.__ambi4Engine?.getParams().timeSignature === '4/4');
  check('back to the genre\'s rules restores 4/4', await page.evaluate(() => window.__ambi4Engine.getParams().timeSignature), '4/4');

  const failed = results.filter((r) => !r.ok);
  if (failed.length) throw new Error('genre-essence: ' + failed.map((r) => `${r.name}: got ${JSON.stringify(r.got)}`).join('\n  '));
  return { results };
}
