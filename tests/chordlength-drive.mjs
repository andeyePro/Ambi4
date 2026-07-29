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
 * BEATS are absent and stay absent until the harmony frame is sub-bar —
 * harmony advances once per bar and every instrument plans a whole bar against
 * one chord, so a sub-bar chord is a scheduler change, not a list entry. The
 * tooltip says so rather than leaving the omission to be discovered.
 */

export default async function drive(page) {
  const results = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
  };
  await page.click('#consent-slot button:has-text("Save on this device")').catch(() => {});
  await page.click('#tab-advanced'); await page.waitForTimeout(400);
  const opts = await page.evaluate(() => [...document.querySelectorAll('#chordLength option')].map(o => [o.value, o.textContent]));
  check('the list offers every whole bar count plus the two named options', opts.length, 18);
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
  const failed = results.filter(r=>!r.ok);
  if (failed.length) throw new Error('chordlen: '+failed.map(r=>`${r.name}: got ${JSON.stringify(r.got)} want ${JSON.stringify(r.want)}`).join(' | '));
  return { passed: results.length };
}
