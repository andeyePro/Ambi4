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

  // The untie must reach the ENGINE, not just the boxes. The engine's step
  // sanitiser MERGES against the stored step, so a client-side `delete tie`
  // silently keeps the note tied there — the page has to send null. This
  // check found that live: the boxes split while the engine played on tied.
  const tieAtEngine = await page.evaluate(() => {
    const seq = window.__ambi4Engine.getParams().tracks.bass.sequencer;
    const steps = Array.isArray(seq.steps) ? seq.steps : Object.values(seq.steps)[0];
    return steps[0].tie === true;
  });
  check('…and the ENGINE untied too', tieAtEngine, (v) => v === false);

  // v0.0.93 (his 89/105): notes on top, groups + probability at the bottom.
  const order = await page.evaluate(() => {
    const editor = document.getElementById('voice-editor-bass');
    const cell = editor.querySelector('.seq-cell');
    const dot = editor.querySelector('.seq-dot-cell');
    const prob = editor.querySelector('.seq-prob');
    if (!cell || !dot || !prob) return null;
    const top = (el) => el.getBoundingClientRect().top;
    return { dotBelowCells: top(dot) > top(cell), probBelowCells: top(prob) > top(cell) };
  });
  check('group dots sit BELOW the cells, beside probability', !!order && order.dotBelowCells && order.probBelowCells, (v) => v === true);

  // v0.0.94 (his 89): mass edit, asserted at the ENGINE's stored lane.
  // The stored lane can outrun the visible bar (fixed-length lane, metre
  // decides what is in play): mass edit acts on the VISIBLE steps, so the
  // assertions read exactly that many.
  const visibleN = await page.evaluate(() =>
    document.getElementById('voice-editor-bass').querySelectorAll('.seq-cell').length);
  const laneAtEngine = () => page.evaluate((n) => {
    const seq = window.__ambi4Engine.getParams().tracks.bass.sequencer;
    const steps = Array.isArray(seq.steps) ? seq.steps : Object.values(seq.steps)[0];
    return steps.slice(0, n).map((st) => st.on === true);
  }, visibleN);
  const massClick = async (label) => {
    await page.evaluate((text) => {
      const editor = document.getElementById('voice-editor-bass');
      [...editor.querySelectorAll('.seq-mass-action')]
        .find((b) => b.textContent === text)?.click();
    }, label);
    await page.waitForTimeout(400);
  };
  await massClick('Fill');
  const filled = await laneAtEngine();
  check('Fill turns every ENGINE step on', filled.every(Boolean), (v) => v === true);
  await massClick('Every 2nd');
  const alternating = await laneAtEngine();
  check('Every 2nd is the alternating pulse at the ENGINE', alternating.every((on, i) => on === (i % 2 === 0)), (v) => v === true);
  await massClick('Clear');
  const cleared = await laneAtEngine();
  check('Clear turns every ENGINE step off', cleared.every((on) => !on), (v) => v === true);

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'tie-merge-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n'),
    );
  }
  return { passed: results.length, notes: [] };
}
