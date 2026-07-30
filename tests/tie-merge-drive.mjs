/**
 * A tie merges the boxes: two tied steps are ONE double-width box.
 *
 *   npm run build && .vibe/measure.sh local drive tests/tie-merge-drive.mjs
 *
 * His 105: "I don't like the tie implementation, it should merge two boxes
 * into one double width box, three into triple, etc. The current
 * implementation is very hard to see." Measured by box geometry — the head
 * cell's width against a plain cell's — because "double width" is a number,
 * not an impression. The absorbed step loses its box in all three rows
 * (cells, group dots, probability bars), which is honest: the engine drops
 * an absorbed step from the bar entirely.
 */

export default async function drive(page) {
  const results = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
  };

  await page.click('#consent-slot button:has-text("Save on this device")').catch(() => {});
  await page.waitForTimeout(200);
  await page.click('#tab-advanced');
  await page.waitForTimeout(300);

  const opened = await page.evaluate(() => {
    for (const row of document.querySelectorAll('.track-row')) {
      if (/bass/i.test(row.textContent || '')) {
        row.querySelector('.voice-edit-toggle')?.click();
        return true;
      }
    }
    return false;
  });
  check('the bass editor opened', opened, true);
  await page.waitForTimeout(600);

  // Scope every query to the bass editor; a closed editor is hidden, not
  // removed. Baseline: first two visible cells, equal width.
  const baseline = await page.evaluate(() => {
    const editor = document.getElementById('voice-editor-bass');
    const cells = editor ? [...editor.querySelectorAll('.seq-cell')] : [];
    if (cells.length < 3) return null;
    cells[0].scrollIntoView({ block: 'center' });
    const w = (el) => el.getBoundingClientRect().width;
    return { w0: Math.round(w(cells[0])), w1: Math.round(w(cells[1])), count: cells.length };
  });
  check('the bass grid renders', !!baseline, (v) => v === true);

  // Tie step 1 into step 2: focus cell 0, press T.
  await page.evaluate(() => {
    const editor = document.getElementById('voice-editor-bass');
    const cell = editor.querySelectorAll('.seq-cell')[0];
    cell.scrollIntoView({ block: 'center' });
    cell.tabIndex = 0;
    cell.focus();
  });
  await page.keyboard.press('t');
  await page.waitForTimeout(400);

  const tied = await page.evaluate(() => {
    const editor = document.getElementById('voice-editor-bass');
    const cells = [...editor.querySelectorAll('.seq-cell')];
    const w = (el) => Math.round(el.getBoundingClientRect().width);
    return {
      headWidth: w(cells[0]),
      absorbedHidden: cells[1].style.display === 'none',
      probHidden: [...editor.querySelectorAll('.seq-prob')][1]?.style.display === 'none',
      plainWidth: w(cells[2]),
    };
  });
  check('the absorbed step loses its box', tied.absorbedHidden, (v) => v === true);
  check('…and its probability bar', tied.probHidden, (v) => v === true);
  // One box spanning two columns: about twice a plain cell (plus the 3px gap).
  check('the head box is double width', tied.headWidth >= tied.plainWidth * 1.85, (v) => v === true);

  // Untie: T again on the (now wide) head — back to two boxes.
  await page.evaluate(() => {
    const editor = document.getElementById('voice-editor-bass');
    const cell = editor.querySelectorAll('.seq-cell')[0];
    cell.tabIndex = 0;
    cell.focus();
  });
  await page.keyboard.press('t');
  await page.waitForTimeout(400);
  const untied = await page.evaluate(() => {
    const editor = document.getElementById('voice-editor-bass');
    const cells = [...editor.querySelectorAll('.seq-cell')];
    const w = (el) => Math.round(el.getBoundingClientRect().width);
    return { headWidth: w(cells[0]), secondVisible: cells[1].style.display !== 'none', plainWidth: w(cells[2]) };
  });
  check('untying restores two boxes', untied.secondVisible && untied.headWidth <= untied.plainWidth * 1.15, (v) => v === true);

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'tie-merge-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n'),
    );
  }
  return { passed: results.length, notes: [] };
}
