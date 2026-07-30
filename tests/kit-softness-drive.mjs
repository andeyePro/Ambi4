/**
 * Energy stage 1c: below the midpoint the GENRE's kit softens — visibly, in
 * the grid, by recompiling the kit at the dial's value (same seed). Never a
 * hidden note-on multiplier.
 *
 *   npm run build && .vibe/measure.sh local drive tests/kit-softness-drive.mjs
 *
 * His rulings built here: "a kit can arrive very gently" (velocities scale
 * down, hats thin) and "0% would remove the acid articulation if 4 to the
 * floor is genre-defining" (the LOW lane never loses a hit). And the
 * boundary rule: the first hand edit to the grid stands the follow down for
 * good — the user's data wins over the dial.
 */

export default async function drive(page) {
  const results = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
  };

  await page.click('#consent-slot button:has-text("Save on this device")').catch(() => {});
  await page.waitForTimeout(200);

  await page.evaluate(() => {
    const sel = document.getElementById('genre-select');
    const opt = [...sel.options].find((o) => o.value === 'g:techno-tools');
    if (opt) {
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  const pinned = await page
    .waitForFunction(() => window.__ambi4Engine?.getParams?.()?.genre === 'techno-tools', { timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  check('Techno Tools pinned at the engine', pinned, (v) => v === true);

  const kitView = () =>
    page.evaluate(() => {
      const seqs = window.__ambi4Engine.getParams().tracks.percussion.sequencers || [];
      const lanes = seqs[0]?.steps || {};
      const stat = (lane) => {
        const on = (lanes[lane] || []).filter((s) => s.on === true);
        return { on: on.length, vmax: on[0]?.vmax ?? null };
      };
      return { low: stat('low'), mid: stat('mid'), high: stat('high') };
    });

  async function dragEnergy(dy) {
    const box = await page.evaluate(() => {
      const slot = document.getElementById('energy-dial');
      const k = slot?.querySelector('.knob');
      if (!k) return null;
      k.scrollIntoView({ block: 'center' });
      const r = k.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.width / 2) };
    });
    if (!box) return false;
    await page.mouse.move(box.x, box.y);
    await page.mouse.down();
    for (let i = 1; i <= 14; i++) await page.mouse.move(box.x, box.y + Math.round((dy / 14) * i));
    await page.mouse.up();
    await page.waitForTimeout(500); // past the 120ms complexity debounce
    return true;
  }

  await page.click('#tab-simple');
  await page.waitForTimeout(300);
  const before = await kitView();
  check('the genre kit is playing full', before.low.on >= 4 && before.high.on >= before.low.on, (v) => v === true);

  // Energy to the floor: a big downward drag.
  check('Energy dragged to the bottom', await dragEnergy(400), true);
  const soft = await kitView();
  check('the LOW lane keeps every hit — the genre identity', soft.low.on, before.low.on);
  check('the high lane thinned', soft.high.on < before.high.on, (v) => v === true);
  check('the kicks softened (velocity down, visibly stored)', soft.low.vmax < before.low.vmax, (v) => v === true);

  // And back up: the ladder is reversible while the kit is untouched.
  check('Energy dragged back up', await dragEnergy(-400), true);
  const loud = await kitView();
  check('full Energy restores the genre kit', loud.high.on, before.high.on);
  check('…and its velocities', loud.low.vmax, before.low.vmax);

  // Hand edit: toggle one kit step, then move Energy — the follow must stand
  // down and leave the user's grid alone.
  await dragEnergy(-100); // make sure we are at a known top-ish value first
  await page.click('#tab-advanced');
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    for (const row of document.querySelectorAll('.track-row')) {
      if (/percussion|drum/i.test(row.textContent || '')) {
        row.querySelector('.voice-edit-toggle')?.click();
        return;
      }
    }
  });
  await page.waitForTimeout(600);
  const toggled = await page.evaluate(() => {
    const editor = document.getElementById('voice-editor-percussion');
    const cell = editor?.querySelector('.seq-cell');
    if (!cell) return false;
    cell.scrollIntoView({ block: 'center' });
    cell.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0 }));
    cell.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    return true;
  });
  check('a kit step was hand-toggled', toggled, true);
  await page.waitForTimeout(300);
  const edited = await kitView();

  await page.click('#tab-simple');
  await page.waitForTimeout(300);
  await dragEnergy(400);
  const after = await kitView();
  check('after a hand edit the dial leaves the kit alone', after, edited);

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'kit-softness-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n'),
    );
  }
  return { passed: results.length };
}
