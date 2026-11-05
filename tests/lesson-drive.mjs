/**
 * The engine lessons, driven (unit 15 of docs/synthesis-programme.md,
 * v0.0.184). Promoted from tests/pending on 2026-11-05, once the test
 * bridge was back:
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
    // The chapters are a page literal; read them back from the shipped
    // bundle's source. The minifier renames LESSON_CHAPTERS and turns its
    // quotes into backticks, so anchor on the first chapter's own opening.
    return fetch('/').then((r) => r.text()).then(async (html) => {
      const entry = html.match(/\/_astro\/index\.astro[^"']+\.js/);
      const js = entry ? await (await fetch(entry[0])).text() : '';
      const m = /=(\[\{engine:[`"']subtractive[`"'][\s\S]*?\}\]\}\])[,;]/.exec(js);
      return m ? new Function(`return ${m[1]}`)() : null;
    });
  });
  check('the chapters are readable from the shipped bundle', Array.isArray(chapters) && chapters.length, 5);
  if (!Array.isArray(chapters)) throw new Error('lesson-drive: no chapters');

  for (const chapter of chapters) {
    // Each chapter runs under its own stage label, so a chapter that cannot
    // be reached fails as a named check and the rest still run.
    let stage = 'pick the voice';
    try {
      await page.selectOption(`#track-voice-${chapter.track}`, chapter.voice);
      // Leaving a voice an earlier chapter edited (the melody's Bell, before
      // Additive's Organ stab) puts up the leave-guard first; Move on answers.
      await page.waitForFunction(([t, v]) => window.__ambi4Engine.getParams().tracks[t]?.voice === v
        || document.getElementById('leave-guard'), [chapter.track, chapter.voice], { timeout: 10000 });
      if (await page.locator('#leave-guard .leave-guard-move').count()) await page.click('#leave-guard .leave-guard-move');
      await page.waitForFunction(([t, v]) => window.__ambi4Engine.getParams().tracks[t]?.voice === v,
        [chapter.track, chapter.voice], { timeout: 10000 });
      stage = 'open the editor';
      const editor = page.locator(`#voice-editor-${chapter.track}`);
      if (await editor.isHidden()) await page.click(`#voice-edit-toggle-${chapter.track}`);
      await page.waitForSelector(`#voice-editor-${chapter.track}:not([hidden]) .patch-controls .knob-cell[data-field]`, { timeout: 10000 });
      stage = 'press the engine chip';
      await page.click(`#voice-editor-${chapter.track} .ve-header .ve-engine`, { timeout: 10000 });
      await page.waitForFunction((label) => document.getElementById('tutorial-title')?.textContent === label, chapter.label, { timeout: 10000 });
      for (const [i, step] of chapter.steps.entries()) {
        stage = `step ${i + 1}`;
        const field = /data-field="([^"]+)"/.exec(step.target)[1];
        const dial = page.locator(`#voice-editor-${chapter.track} ${step.target} .knob`);
        // The step's own highlight unfolds a dial kept behind "more"; wait for
        // it, then centre it (the tour panel may sit over the fold's edge).
        await dial.waitFor({ state: 'visible', timeout: 10000 });
        await dial.evaluate((el) => el.scrollIntoView({ block: 'center' }));
        // Press the FACE's centre, the hub: a press there drags vertically
        // throughout. The .knob box also holds the label and readout, so its
        // own centre lands in the annulus, where a fine pointer's drag follows
        // the ANGLE — and straight up is twelve o'clock, the middle of the
        // scale, which is exactly where Hardness and Damping already sit.
        const face = await dial.evaluate((el) => {
          const r = el.querySelector('svg')?.getBoundingClientRect();
          return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
        });
        const read = () => page.evaluate(([t, f]) => {
          const [section, key] = f.split('.');
          const p = window.__ambi4Engine.getParams().patches?.[t];
          const voice = window.__ambi4Engine.getParams().tracks[t].voice;
          const v = p?.[voice]?.[section]?.[key];
          return v && typeof v === 'object' ? (v.min + v.max) / 2 : v;
        }, [chapter.track, field]);
        // An untouched voice stores no patch, so the engine has nothing to
        // read before the first drag: then the value to move AWAY from is the
        // one the dial showed (the voice's default). The stored value after
        // must differ from it, not merely exist.
        const before = await read();
        const shown = await dial.evaluate((el) => ({
          now: Number(el.getAttribute('aria-valuenow')),
          min: Number(el.getAttribute('aria-valuemin')),
          max: Number(el.getAttribute('aria-valuemax')),
          text: (el.getAttribute('aria-valuetext') || '').toLowerCase(),
        }));
        check(`"${chapter.label}" step ${i + 1}: the ${field} dial has a face to press`, !!face, true);
        if (face) {
          // Toward the side with room: a dial already at its top (Env amount
          // ships at 1) cannot move up. Fifty pixels is a quarter of the
          // dial's travel, enough to step an enumeration (Material) by one.
          const dy = shown.now > (shown.min + shown.max) / 2 ? 50 : -50;
          await page.mouse.move(face.x, face.y);
          await page.mouse.down();
          await page.mouse.move(face.x, face.y + dy, { steps: 10 });
          await page.mouse.up();
        }
        const after = await read();
        const moved = (b, a) => {
          if (typeof a !== 'number' && typeof a !== 'string') return false;
          if (b !== undefined) return a !== b;
          return typeof a === 'number' ? Math.abs(a - shown.now) > 1e-6 : !shown.text.startsWith(a.toLowerCase());
        };
        check(`"${chapter.label}" step ${i + 1}: dragging ${field} moves the engine's stored value`, { before, shown, after }, ({ before: b, after: a }) => moved(b, a));
        if (i < chapter.steps.length - 1) await page.click('#tutorial-next');
      }
    } catch (err) {
      const where = await page.evaluate((t) => ({
        engineVoice: window.__ambi4Engine.getParams().tracks[t]?.voice,
        selectValue: document.getElementById(`track-voice-${t}`)?.value,
        title: document.getElementById('tutorial-title')?.textContent,
      }), chapter.track).catch(() => null);
      check(`"${chapter.label}" reached (${stage})`, { error: String(err.message).split('\n')[0], where }, () => false);
    }
    await page.click('#tutorial-close').catch(() => {});
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length) throw new Error('lesson-drive: ' + failed.map((r) => `${r.name}: got ${JSON.stringify(r.got)}`).join('\n  '));
  return { results };
}
