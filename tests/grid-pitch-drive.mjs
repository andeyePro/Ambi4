/**
 * Grid pitch editing: P types a step's own note, Alt+drag nudges it, and the
 * ENGINE stores the pin.
 *
 *   npm run build && .vibe/measure.sh local drive tests/grid-pitch-drive.mjs
 *
 * Closes the v0.0.75 gap ("pitch is a READOUT, not editable") through the
 * v0.0.109 schema. Asserted at the engine's stored steps — the readout
 * drawing a note the engine never received is this repo's oldest failure.
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
    const opt = [...sel.options].find((o) => o.value === 'g:synthwave');
    if (opt) {
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  const pinnedGenre = await page
    .waitForFunction(() => window.__ambi4Engine?.getParams?.()?.genre === 'synthwave', { timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  check('Synthwave pinned', pinnedGenre, (v) => v === true);

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

  const enginePin = (slot) =>
    page.evaluate((idx) => {
      const s = window.__ambi4Engine.getParams().tracks.bass.sequencer.steps[idx];
      return s && Number.isFinite(s.midi) ? s.midi : null;
    }, slot);

  const focusCell = (slot) =>
    page.evaluate((idx) => {
      const editor = document.getElementById('voice-editor-bass');
      const cell = editor.querySelectorAll('.seq-cell')[idx];
      cell.scrollIntoView({ block: 'center' });
      cell.tabIndex = 0;
      cell.focus();
      return true;
    }, slot);

  // P types the note; the engine stores it; the cell says so.
  await focusCell(0);
  await page.keyboard.press('p');
  await page.waitForTimeout(200);
  const inputThere = await page.evaluate(
    () => !!document.querySelector('#voice-editor-bass .seq-pitch-input')
  );
  check('P opens the in-place note input', inputThere, true);
  // Typed with an ASCII '#': the parser takes either spelling.
  await page.fill('#voice-editor-bass .seq-pitch-input', 'C#5');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  check('the ENGINE stores the typed pin', await enginePin(0), 73);
  const shown = await page.evaluate(() => {
    const editor = document.getElementById('voice-editor-bass');
    const cell = editor.querySelectorAll('.seq-cell')[0];
    return {
      label: cell.querySelector('.seq-pin')?.textContent || null,
      aria: cell.getAttribute('aria-label') || '',
    };
  });
  // ONE spelling on screen: the typographic sharp the piano roll and the
  // pitch readout already use (typing accepts either — see below).
  check('the pin is visible on the cell', shown.label, 'C\u266F5');
  check('…and spoken', /pinned to C\u266F5/.test(shown.aria), (v) => v === true);

  // Alt+drag nudges by semitones from the default anchor (C4 = 60).
  const box = await page.evaluate(() => {
    const editor = document.getElementById('voice-editor-bass');
    const cell = editor.querySelectorAll('.seq-cell')[2];
    cell.scrollIntoView({ block: 'center' });
    const r = cell.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  });
  await page.keyboard.down('Alt');
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(box.x, box.y - i * 4);
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await page.waitForTimeout(400);
  const nudged = await enginePin(2);
  check('Alt+drag pins by semitones (up = higher)', nudged !== null && nudged > 60, (v) => v === true);

  // An empty entry clears the pin — and the CLEAR reaches the engine too.
  await focusCell(0);
  await page.keyboard.press('p');
  await page.waitForTimeout(200);
  await page.fill('#voice-editor-bass .seq-pitch-input', '');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  check('an empty entry clears the pin at the ENGINE', await enginePin(0), null);

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'grid-pitch-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n'),
    );
  }
  return { passed: results.length };
}
