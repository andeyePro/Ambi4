/**
 * A voice of the person's own survives closing the tab (unit 8 of
 * docs/synthesis-programme.md, v0.0.182). PARKED in tests/pending until the
 * Mac test bridge key is restored (fromClaude 13); then:
 *
 *   npm run build && .vibe/measure.sh local drive tests/user-voice-drive.mjs
 *
 * page-boot proves save, pick and forget in one booted page and a second boot
 * reading the stored format; this proves the LIVE reload: consent given, a
 * dial moved by a real drag, Save as my voice, about:blank and back (a
 * fragment-only goto would not reboot - CLAUDE.md), and the voice is still in
 * the pad's picker and plays its patch at the engine.
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
  await page.click('#tab-advanced');
  await page.selectOption('#track-voice-pad', 'warm');
  await page.click('#voice-edit-toggle-pad');
  const dial = page.locator('#voice-editor-pad .patch-controls .knob-cell[data-field="adsr.release"] .knob');
  await dial.scrollIntoViewIfNeeded();
  const box = await dial.boundingBox();
  check('the Release dial renders', !!box, true);
  if (box) {
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx, cy - 40, { steps: 10 });
    await page.mouse.up();
  }
  const moved = await page.evaluate(() => window.__ambi4Engine.getParams().patches?.pad?.warm?.adsr?.release);
  check('a drag moved Release at the engine', moved, (v) => Number.isFinite(v) && Math.abs(v - 4.25) > 0.05);
  await page.fill('#voice-editor-pad .ve-voice-name', 'Long pad');
  await page.click('#voice-editor-pad .ve-save-voice');
  await page.waitForFunction(() => !!document.querySelector('#track-voice-pad optgroup.my-voices option'));
  const value = await page.evaluate(() => document.querySelector('#track-voice-pad optgroup.my-voices option').value);

  await page.goto('about:blank');
  await page.goto(origin);
  await page.waitForSelector('#generator-app:not([hidden])');
  await page.waitForTimeout(500);
  const listed = await page.evaluate(() => Array.from(document.querySelectorAll('#track-voice-pad optgroup.my-voices option')).map((o) => [o.value, o.textContent]));
  check('the voice survives the reload, in the picker', listed, (v) => Array.isArray(v) && v.length === 1 && v[0][0] === value && v[0][1] === 'Long pad');
  await page.selectOption('#track-voice-pad', 'glass');
  await page.selectOption('#track-voice-pad', value);
  await page.waitForFunction(() => window.__ambi4Engine.getParams().tracks.pad.voice === 'warm');
  const back = await page.evaluate(() => window.__ambi4Engine.getParams().patches?.pad?.warm?.adsr?.release);
  check('picking the reloaded voice plays its patch at the engine', back, (v) => Number.isFinite(v) && Math.abs(v - moved) < 1e-6);

  const failed = results.filter((r) => !r.ok);
  if (failed.length) throw new Error('user-voice: ' + failed.map((r) => `${r.name}: got ${JSON.stringify(r.got)}`).join('\n  '));
  return { results };
}
