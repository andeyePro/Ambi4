/**
 * Provenance as evidence, beside the AI-free claim rather than instead of it.
 *
 *   npm run build && .vibe/measure.sh local drive tests/provenance-drive.mjs
 *
 * TODO's wording: "a piece that is one of our genres plus a human's edits is a
 * different object from one that arrived as an opaque blob, and until v0.0.62
 * the two were indistinguishable on arrival. The pledge item can now be
 * evidence-backed rather than self-declared."
 *
 * Nothing here decides whether a piece is AI-free — CONTRIBUTING.md is
 * explicit that the label is a claim a person signs about the MUSIC, not a
 * fact about the source. What this proves is that the evidence a reviewer
 * would need is present, current, and travels with the submission: what it
 * grew from, whether that base can be rebuilt from two numbers, and how many
 * fields the person actually moved.
 */

export default async function drive(page) {
  const results = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
  };

  await page.click('#consent-slot button:has-text("Save on this device")').catch(() => {});
  await page.click('#tab-advanced');
  await page.waitForTimeout(800);

  const first = await page.evaluate(() =>
    document.getElementById('preset-provenance')?.textContent || '');
  check('the panel says what this grew from before anything is touched',
    /style exactly as the app compiled it|blank slate|no record of what it grew from/.test(first),
    (v) => v === true);
  check('and does not claim any of it is the listener\'s yet',
    /nothing of yours in it yet|nothing changed yet|no record/.test(first), (v) => v === true);

  await page.selectOption('#root', 'F');
  await page.waitForTimeout(700);
  const after = await page.evaluate(() =>
    document.getElementById('preset-provenance')?.textContent || '');
  // The load-bearing one: a line that was right when the panel opened and
  // wrong ever after would be worse than no line at all.
  check('it follows the edit', after !== first, (v) => v === true);
  check('and counts what actually moved', /1 setting changed by you/.test(after), (v) => v === true);

  // The same evidence has to travel with the submission, not just sit on screen.
  await page.evaluate(() => {
    window.__opened = [];
    window.open = (u) => { window.__opened.push(u); return null; };
    document.getElementById('preset-submit').click();
  });
  await page.waitForTimeout(700);
  const prov = await page.evaluate(() => {
    const url = window.__opened.pop() || '';
    const m = /[?&]message=([^&]*)/.exec(url);
    try { return JSON.parse(decodeURIComponent(m ? m[1] : '')).provenance || null; } catch { return null; }
  });
  check('the submission carries the provenance block', !!prov, (v) => v === true);
  check('naming the style it grew from', typeof prov.from, 'string');
  check('with the two numbers that rebuild it',
    typeof prov.id === 'string' && Number.isFinite(prov.seed), (v) => v === true);
  check('and saying the base IS rebuildable here', prov.rebuildable, (v) => v === true);
  check('and how many fields the person moved', prov.changed, 1);
  results.push({ name: 'provenance block', ok: true, got: prov, want: '(informational)' });

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'provenance-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  \u2717 ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n'),
    );
  }
  return { passed: results.length, notes: results.filter((r) => r.want === '(informational)').map((r) => `${r.name}: ${JSON.stringify(r.got)}`) };
}
