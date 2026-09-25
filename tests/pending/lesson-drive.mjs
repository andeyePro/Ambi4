/**
 * The engine lessons, driven (unit 15 of docs/synthesis-programme.md,
 * v0.0.184). PARKED in tests/pending until the Mac test bridge key is
 * restored (fromClaude 13); then:
 *
 *   npm run build && .vibe/measure.sh local drive tests/lesson-drive.mjs
 *
 * page-boot proves the chapters open on their dials and step; this proves
 * the MOVES: for every chapter, press the chip, and for every step drag the
 * highlighted dial upward by a real pointer gesture and read the ENGINE's
 * stored value before and after — a lesson step that names a dial the drag
 * does not move would be teaching a control that does nothing.
 *
 * Traps honoured (CLAUDE.md): the genre is pinned; every dial is scrolled
 * into view and its box re-read before the drag; assertions read the engine.
 */
export default async function drive(page) {
  const results = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
  };
  await page.click('#consent-slot button:has-text("Save on this device")').catch(() => {});
  await page.waitForTimeout(200);
  await page.selectOption('#genre-select', 'g:synthwave');
  await page.waitForFunction(() => window.__ambi4Engine?.getParams().genre === 'synthwave');
  await page.click('#tab-advanced');

  const chapters = await page.evaluate(() => {
    // The chapters are a page literal; read them back through the tour's own
    // regex, exactly as tutorial-smoke does, from the shipped bundle's source.
    return fetch('/').then((r) => r.text()).then(async (html) => {
      const entry = html.match(/\/_astro\/index\.astro[^"']+\.js/);
      const js = entry ? await (await fetch(entry[0])).text() : '';
      const m = /LESSON_CHAPTERS=(\[.*?\}\]\}\])/.exec(js);
      return m ? new Function(`return ${m[1]}`)() : null;
    });
  });
  check('the chapters are readable from the shipped bundle', Array.isArray(chapters) && chapters.length, 5);
  if (!Array.isArray(chapters)) throw new Error('lesson-drive: no chapters');

  for (const chapter of chapters) {
    await page.selectOption(`#track-voice-${chapter.track}`, chapter.voice);
    const editor = page.locator(`#voice-editor-${chapter.track}`);
    if (await editor.isHidden()) await page.click(`#voice-edit-toggle-${chapter.track}`);
    await page.waitForSelector(`#voice-editor-${chapter.track}:not([hidden]) .patch-controls .knob-cell[data-field]`);
    await page.click(`#voice-editor-${chapter.track} .ve-header .ve-engine`);
    await page.waitForFunction((label) => document.getElementById('tutorial-title')?.textContent === label, chapter.label);
    for (const [i, step] of chapter.steps.entries()) {
      const field = /data-field="([^"]+)"/.exec(step.target)[1];
      const dial = page.locator(`#voice-editor-${chapter.track} ${step.target} .knob`);
      await dial.scrollIntoViewIfNeeded();
      const box = await dial.boundingBox();
      const read = () => page.evaluate(([t, f]) => {
        const [section, key] = f.split('.');
        const p = window.__ambi4Engine.getParams().patches?.[t];
        const voice = window.__ambi4Engine.getParams().tracks[t].voice;
        const v = p?.[voice]?.[section]?.[key];
        return v && typeof v === 'object' ? (v.min + v.max) / 2 : v;
      }, [chapter.track, field]);
      const before = await read();
      if (box) {
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        await page.mouse.move(cx, cy - 30, { steps: 8 });
        await page.mouse.up();
      }
      const after = await read();
      check(`"${chapter.label}" step ${i + 1}: dragging ${field} moves the engine's stored value`, { before, after }, ({ before: b, after: a }) => b !== a && (typeof a === 'number' || typeof a === 'string'));
      if (i < chapter.steps.length - 1) await page.click('#tutorial-next');
    }
    await page.click('#tutorial-close');
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length) throw new Error('lesson-drive: ' + failed.map((r) => `${r.name}: got ${JSON.stringify(r.got)}`).join('\n  '));
  return { results };
}
