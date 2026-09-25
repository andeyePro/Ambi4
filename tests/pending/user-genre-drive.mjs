/**
 * A genre of the person's own survives closing the tab (unit 12 of
 * docs/synthesis-programme.md, v0.0.180). PARKED in tests/pending until the
 * Mac test bridge key is restored (fromClaude 13); then:
 *
 *   npm run build && .vibe/measure.sh local drive tests/user-genre-drive.mjs
 *
 * page-boot proves the save, the picker, the engine tag and a fresh draw in
 * one booted page; this proves the RELOAD — the whole reason a genre lives
 * under prefs rather than in the setup: consent given, save, go to
 * about:blank (a fragment-only navigation would not reboot — CLAUDE.md), come
 * back, and the genre is still in the picker, still draws with its ruled pad
 * Off, and Forget removes it for good.
 */
export default async function drive(page) {
  const results = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
  };
  const origin = page.url().replace(/#.*$/, '');
  await page.click('#consent-slot button:has-text("Save on this device")').catch(() => {});
  await page.waitForTimeout(200);

  await page.selectOption('#genre-select', 'g:synthwave');
  await page.waitForFunction(() => window.__ambi4Engine?.getParams().genre === 'synthwave');
  await page.click('#genre-rules-toggle');
  await page.waitForSelector('#genre-rules:not([hidden])');
  const padState = page.locator('#genre-rules-lineup-ui .rules-lineup-row[data-track="pad"] select').first();
  await padState.selectOption('off');
  await page.click('#genre-rules-apply');
  await page.waitForFunction(() => window.__ambi4Engine?.getParams().tracks?.pad?.state === 'off');
  await page.fill('#genre-rules-name', 'Night pads');
  await page.click('#genre-rules-save');
  await page.waitForFunction(() => Array.from(document.querySelectorAll('#genre-select optgroup')).some((g) => g.label === 'My genres'));
  const slug = await page.evaluate(() => window.__ambi4Engine.getParams().genre);
  check('the saved genre is the current genre', slug, (v) => typeof v === 'string' && v.startsWith('u-'));

  // The reload: a real navigation away and back.
  await page.goto('about:blank');
  await page.goto(origin);
  await page.waitForSelector('#generator-app:not([hidden])');
  await page.waitForTimeout(500);
  const listed = await page.evaluate(() => {
    const group = Array.from(document.querySelectorAll('#genre-select optgroup')).find((g) => g.label === 'My genres');
    return group ? Array.from(group.querySelectorAll('option')).map((o) => [o.value, o.textContent]) : null;
  });
  check('the genre survives the reload, in the picker', listed, (v) => Array.isArray(v) && v.length === 1 && v[0][0] === `g:${slug}` && v[0][1] === 'Night pads');
  await page.selectOption('#genre-select', `g:${slug}`);
  await page.waitForFunction((s) => window.__ambi4Engine?.getParams().genre === s, slug);
  check('a draw from the reloaded genre keeps the pad Off', await page.evaluate(() => window.__ambi4Engine.getParams().tracks?.pad?.state), 'off');

  await page.click('#genre-rules-toggle');
  await page.waitForSelector('#genre-rules:not([hidden])');
  await page.click('#genre-rules-forget');
  await page.waitForFunction(() => !Array.from(document.querySelectorAll('#genre-select optgroup')).some((g) => g.label === 'My genres'));
  await page.goto('about:blank');
  await page.goto(origin);
  await page.waitForSelector('#generator-app:not([hidden])');
  await page.waitForTimeout(500);
  check('a forgotten genre stays forgotten after a reload', await page.evaluate(() => Array.from(document.querySelectorAll('#genre-select optgroup')).some((g) => g.label === 'My genres')), false);

  const failed = results.filter((r) => !r.ok);
  if (failed.length) throw new Error('user-genre: ' + failed.map((r) => `${r.name}: got ${JSON.stringify(r.got)}`).join('\n  '));
  return { results };
}
