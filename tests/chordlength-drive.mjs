/**
 * Chord length: every whole bar count, plus one chord per section.
 *
 *   npm run build && .vibe/measure.sh local drive tests/chordlength-drive.mjs
 *
 * His note was "chord length still has no custom option in beats, bars or
 * sections". The old list was Auto/1/2/4/8, which left 3, 5, 6 and 12 bars
 * unreachable for no musical reason — a whitelist was the wrong SHAPE for a
 * bar count rather than a deliberate restriction.
 *
 * The select is built from the ENGINE's own HARMONY_RHYTHMS, so this also
 * proves the two cannot drift: a hand-kept copy of an engine list is exactly
 * how a control comes to offer a value the engine then silently drops.
 *
 * BEATS: v0.0.241 made the harmony frame sub-bar (`harmony.beats`, a field
 * of its own beside `harmony.rhythm`), and the page lists 1, 2 and 3 beats
 * after the bar counts as `beats:<n>` options. They are asserted BY VALUE
 * below — a bare count went stale the day they landed (got 21 want 18) and
 * would equally have passed a list that swapped a bar count for a beat.
 */

// UI review fix 18: Advanced folds its sections (Sound / Music / Presets) behind
// a "more". Before a pointer touches a folded control, press the REAL "more"
// that opens it; the page names it (window.__ambi4FoldMore — drives load as
// data: URLs and cannot import a shared helper, so the shared half is there).
const openFoldFor = async (page, selector) => {
  const more = await page.evaluate((s) => (typeof window.__ambi4FoldMore === 'function' ? window.__ambi4FoldMore(s) : null), selector);
  if (more) {
    await page.click(more);
    await page.waitForTimeout(150);
  }
};

export default async function drive(page) {
  const results = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
  };
  await page.click('#consent-slot button:has-text("Save on this device")').catch(() => {});
  await page.click('#tab-advanced'); await page.waitForTimeout(400);
  await openFoldFor(page, '#chordLength');
  const opts = await page.evaluate(() => [...document.querySelectorAll('#chordLength option')].map(o => [o.value, o.textContent]));
  // Auto, One per section, 1..16 bars (HARMONY_RHYTHMS), then 1..3 beats.
  const want = ['auto', 'section', ...Array.from({ length: 16 }, (_, i) => String(i + 1)), 'beats:1', 'beats:2', 'beats:3'];
  check('the list offers the two named options, every whole bar count, then 1-3 beats, in that order',
    opts.map((o) => o[0]), want);
  check('the beat options are labelled in beats',
    opts.filter((o) => o[0].startsWith('beats:')).map((o) => o[1]), ['1 beat', '2 beats', '3 beats']);
  check('and includes the ones the old whitelist could not reach',
    opts.map(o=>o[0]).filter(v=>['3','5','6','12'].includes(v)), ['3','5','6','12']);
  check('One per section is offered', opts.find(o=>o[0]==='section')?.[1], 'One per section');
  await page.selectOption('#chordLength', '5');
  await page.waitForTimeout(300);
  check('a five-bar chord reaches the engine',
    await page.evaluate(()=>window.__ambi4Engine.getParams().harmony.rhythm), 5);
  await page.selectOption('#chordLength', 'section');
  await page.waitForTimeout(300);
  check('and so does one per section',
    await page.evaluate(()=>window.__ambi4Engine.getParams().harmony.rhythm), 'section');
  await page.selectOption('#chordLength', 'beats:2');
  await page.waitForTimeout(300);
  check('a two-beat chord reaches the engine as harmony.beats',
    await page.evaluate(()=>window.__ambi4Engine.getParams().harmony.beats), 2);
  await page.selectOption('#chordLength', '4');
  await page.waitForTimeout(300);
  check('and picking a bar count clears it again',
    await page.evaluate(()=>{ const h = window.__ambi4Engine.getParams().harmony; return [h.rhythm, h.beats ?? null]; }), [4, null]);
  const failed = results.filter(r=>!r.ok);
  if (failed.length) throw new Error('chordlen: '+failed.map(r=>`${r.name}: got ${JSON.stringify(r.got)} want ${JSON.stringify(r.want)}`).join(' | '));
  return { passed: results.length };
}
