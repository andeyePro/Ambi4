/**
 * cmd-z undoes the last thing you did, whatever it was.
 *
 *   npm run build && .vibe/measure.sh local drive tests/undo-drive.mjs
 *
 * His ask, verbatim: "cmd-z undoes the last user input, whatever it was —
 * including Next. Not the setup-only stack Back uses; a single universal undo
 * over every input, unlimited within a session. Back stays as the coarse
 * control."
 *
 * The four properties that make it a real undo rather than a demo:
 *
 *  1. it undoes a DIAL, which the Back button deliberately does not;
 *  2. it undoes a NEXT — the whole-setup gesture — through the same key;
 *  3. one drag is ONE entry, not two hundred: the undo watches the persist
 *     funnel, which already debounces, so a drag coalesces for free. A stack
 *     that needed forty presses to undo one drag would be unusable;
 *  4. it does not fire inside a text field, where the browser's own undo is
 *     the one the person is actually looking at.
 *
 * Redo is checked too. An undo with no redo makes an accidental cmd-z
 * unrecoverable, which is the same trap the single-click dial reset was.
 */

const state = (page) =>
  page.evaluate(() => {
    const p = window.__ambi4Engine.getParams();
    return { bpm: JSON.stringify(p.bpm), root: p.root, mode: p.mode, level: JSON.stringify(p.tracks.pad.level) };
  });

const undo = async (page, times = 1) => {
  for (let i = 0; i < times; i++) {
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(450);
  }
};

export default async function drive(page) {
  const results = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
  };

  await page.click('#consent-slot button:has-text("Save on this device")').catch(() => {});
  await page.waitForTimeout(200);
  await page.click('#tab-advanced');
  await page.waitForTimeout(600);

  const start = await state(page);

  // 1. A select. Ordinary, committed, and nothing to do with Next.
  await page.selectOption('#root', 'F');
  await page.waitForTimeout(600);
  const rooted = await state(page);
  check('the key actually changed', rooted.root !== start.root, (v) => v === true);
  await undo(page);
  check('cmd-z put the key back', (await state(page)).root, start.root);

  // 2. A DIAL — the case Back explicitly refuses, and the reason this exists.
  const dial = await page.evaluate(() => {
    const k = [...document.querySelectorAll('#panel-advanced .knob')]
      .find((el) => el.getAttribute('aria-label') === 'Tempo');
    if (!k) return null;
    k.scrollIntoView({ block: 'center' });
    const r = k.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.width / 2) };
  });
  check('the Tempo dial is on screen', !!dial, (v) => v === true);
  const beforeDrag = await state(page);
  await page.mouse.move(dial.x, dial.y);
  await page.mouse.down();
  // Forty moves: this is the coalescing test as much as the undo test.
  for (let i = 1; i <= 40; i++) await page.mouse.move(dial.x, dial.y - i * 2);
  await page.mouse.up();
  await page.waitForTimeout(700);
  const dragged = await state(page);
  check('the drag moved the tempo', dragged.bpm !== beforeDrag.bpm, (v) => v === true);
  await undo(page);
  check('ONE cmd-z undoes a whole drag', (await state(page)).bpm, beforeDrag.bpm);

  // 3. Redo brings it back.
  await page.keyboard.press('Control+Shift+z');
  await page.waitForTimeout(500);
  check('and redo returns it', (await state(page)).bpm, dragged.bpm);
  await undo(page);

  // 4. Next — the whole-setup gesture Back was built for — undone by the same key.
  const beforeNext = await state(page);
  await page.click('#fast-forward');
  await page.waitForTimeout(1200);
  const nexted = await state(page);
  check('Next replaced the setup', JSON.stringify(nexted) !== JSON.stringify(beforeNext), (v) => v === true);
  await undo(page);
  check('cmd-z undoes a Next too', await state(page), beforeNext);

  // 5. Inside a text field, the browser's own undo wins and ours stays out.
  const beforeTyping = await state(page);
  await page.fill('#preset-name', 'undo test');
  await page.click('#preset-name');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(400);
  check('typing in a field does not trigger the app undo', await state(page), beforeTyping);

  // 6. The floor. Undoing past the beginning says so rather than throwing.
  await undo(page, 12);
  check('undoing past the start leaves a usable page', await page.evaluate(() =>
    !!document.getElementById('generator-app') && !document.getElementById('generator-app').hidden),
  (v) => v === true);

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'undo-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n'),
    );
  }
  return { passed: results.length };
}
