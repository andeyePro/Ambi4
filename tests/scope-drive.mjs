/**
 * Universal | Per instrument, driven in a real browser.
 *
 *   npm run build && .vibe/measure.sh local drive tests/scope-drive.mjs
 *
 * The control is a readout as much as an input, and both halves of that need
 * proving: clicking it must actually rewrite every applicable track, and
 * moving ONE track's own dial off its detent must move the control to Per
 * instrument by itself. A control that claims a scope it does not have is
 * worse than no control.
 *
 * Also asserts what the owner explicitly asked for on 2026-07-27: "shows both
 * options with the current one selected — never a single button that states its
 * state and swaps label."
 */

const scopeState = (page, dialId) =>
  page.evaluate((id) => {
    const cell = document.getElementById(id);
    const grp = cell && cell.querySelector('.segmented.dial-scope');
    if (!grp) return null;
    return {
      options: [...grp.querySelectorAll('label')].map((l) => l.textContent),
      checked: grp.querySelector('input:checked')?.value ?? null,
      role: grp.getAttribute('role'),
    };
  }, dialId);

const trackValues = (page, key) =>
  page.evaluate((k) => {
    try {
      const raw = localStorage.getItem('ambi4:generator');
      const o = raw ? JSON.parse(raw) : null;
      if (!o || !o.tracks) return null;
      return Object.fromEntries(Object.entries(o.tracks).map(([id, t]) => [id, t[k] ?? null]));
    } catch { return null; }
  }, key);

export default async function drive(page) {
  const results = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
  };

  await page.click('#consent-slot button:has-text("Save on this device")').catch(() => {});
  await page.waitForTimeout(200);
  await page.click('#tab-advanced');
  await page.waitForTimeout(400);

  const swing = await scopeState(page, 'dial-swing');
  check('the Swing dial has a scope control', !!swing, (v) => v === true);
  if (!swing) throw new Error('scope-drive: no scope control under the Swing dial');

  check('both options are shown, not one button that swaps label',
    swing.options, ['Universal', 'Per instrument']);
  check('it is a radiogroup, so a screen reader hears a choice', swing.role, 'radiogroup');
  check('a fresh install reads Universal', swing.checked, 'universal');

  // Switching to Per instrument must write a real value into every applicable
  // track — otherwise the label is a lie and the per-track dials stay inert.
  // The radio itself is visually hidden (the .segmented pattern), so the LABEL
  // is the target — which is also what a user clicks.
  await page.click('label[for="scope-swing-per"]');
  await page.waitForTimeout(700);
  const perValues = await trackValues(page, 'swing');
  check('storage was reachable', !!perValues, (v) => v === true);
  if (perValues) {
    const seeded = Object.entries(perValues).filter(([, v]) => typeof v === 'number');
    check('Per instrument seeded at least two tracks', seeded.length >= 2, (v) => v === true);
    results.push({ name: 'seeded', ok: true, got: Object.fromEntries(seeded), want: '(informational)' });
  }

  // And back. Universal must clear them, which is the direction that changes
  // the sound and so must not be a no-op.
  await page.click('label[for="scope-swing-universal"]');
  await page.waitForTimeout(700);
  const uniValues = await trackValues(page, 'swing');
  if (uniValues) {
    const stillSet = Object.entries(uniValues).filter(([, v]) => typeof v === 'number');
    check('Universal cleared every track back to follow', stillSet.map(([k]) => k), []);
  }

  // The readout half: move one track's own Swing dial off its detent and the
  // control must notice without being told.
  //
  // Only a SEQUENCED track carries a Swing dial (a tuned one gets Density
  // instead), so every editor is opened until one turns up rather than
  // assuming the first. Opening the wrong one and reporting "skipped" is how a
  // contract goes untested while the suite still reads green.
  let keyed = false;
  const editorCount = await page.evaluate(() => document.querySelectorAll('.voice-edit-toggle').length);
  for (let i = 0; i < editorCount && !keyed; i++) {
    await page.evaluate((n) => {
      const btns = [...document.querySelectorAll('.voice-edit-toggle')];
      btns.forEach((b, j) => { if (j !== n && b.getAttribute('aria-expanded') === 'true') b.click(); });
      btns[n]?.click();
    }, i);
    await page.waitForTimeout(350);
    keyed = await page.evaluate(() => {
      const knob = document.querySelector('.track-swing-knob .knob');
      if (!knob) return false;
      knob.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      return true;
    });
  }
  check('a per-track Swing dial exists to test the readout with', keyed, true);
  if (keyed) {
    await page.waitForTimeout(400);
    const after = await scopeState(page, 'dial-swing');
    check('moving one track off its detent flips the control to Per instrument',
      after.checked, 'per');
  }

  // ---- v0.0.70: the point of the control is to REMOVE dials ----------------
  // "Universal | Per Instrument was supposed to clear up the interface — with
  // Swing set to Universal, the Swing dial can disappear from each track."
  // Adding a switch was only ever half of it; taking the per-track copies away
  // when they are all following the global one is the half that clears up the
  // interface, and it is most of the time.
  const visibleSwing = () => page.evaluate(() =>
    [...document.querySelectorAll('.track-swing-knob')].filter((el) => !el.hidden).length);

  await page.click('label[for="scope-swing-universal"]');
  await page.waitForTimeout(500);
  check('Universal hides the per-track Swing dials', await visibleSwing(), 0);

  await page.click('label[for="scope-swing-per"]');
  await page.waitForTimeout(500);
  check('and Per instrument brings them back', await visibleSwing() > 0, true);

  await page.click('label[for="scope-swing-universal"]');
  await page.waitForTimeout(500);
  check('and it survives switching back', await visibleSwing(), 0);

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'scope-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n'),
    );
  }
  return { passed: results.length, notes: results.filter((r) => r.want === '(informational)').map((r) => `${r.name}: ${JSON.stringify(r.got)}`) };
}
