/**
 * Every grid gesture, twice over: did the ENGINE get it, and does the GRID show
 * it — without a rebuild?
 *
 *   npm run build && .vibe/measure.sh local drive tests/gesture-integrity-drive.mjs
 *
 * WHY IT EXISTS. His 119: "there's a view bug, you need to go out and in to see
 * the wide boxes." The cause (v0.0.144) was that the sideways TIE DRAG updated
 * the cells and never redrew the merged boxes, while the keyboard shortcut for
 * the same edit went through a path that did. The tie drive had only ever pressed
 * the key, so the gesture a person actually uses was the untested one — and every
 * other pointer gesture in this grid had the same shape of risk.
 *
 * So this drive performs each POINTER gesture with real pointer events and holds
 * both halves of the contract at once: the engine's stored step must change, and
 * the DOM must say so immediately. Nothing here re-renders on purpose; that is
 * the point.
 */

export default async function drive(page) {
  const results = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
  };

  await page.click('#consent-slot button:has-text("Save on this device")').catch(() => {});
  await page.waitForTimeout(200);
  await page.selectOption('#time-signature', '4/4').catch(() => {});
  await page.waitForTimeout(300);
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

  /**
   * One gesture, in the browser: pointer down on a cell, a few moves, pointer up.
   * `from` and `to` are fractions of the cell (0,0 is its top-left) so a caller
   * can aim at the upper half (velocity), the lower half (note length) or
   * sideways (tie) without knowing any pixel sizes.
   */
  const gesture = async (index, from, to, { alt = false } = {}) => page.evaluate(
    async ([i, a, b, altKey]) => {
      const editor = document.getElementById('voice-editor-bass');
      const cells = [...editor.querySelectorAll('.seq-cell')];
      const cell = cells[i];
      cell.scrollIntoView({ block: 'center' });
      await new Promise((r) => setTimeout(r, 80));
      // Re-read AFTER scrolling: page.mouse-style coordinates move under it,
      // which is one of this repo's recorded browser-test traps.
      const box = cell.getBoundingClientRect();
      const at = (f) => ({ clientX: box.left + box.width * f[0], clientY: box.top + box.height * f[1] });
      const send = (type, point, extra = {}) => cell.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 7, altKey, ...point, ...extra,
      }));
      send('pointerdown', at(a));
      const steps = 6;
      for (let s = 1; s <= steps; s++) {
        const f = [a[0] + (b[0] - a[0]) * (s / steps), a[1] + (b[1] - a[1]) * (s / steps)];
        send('pointermove', at(f));
        await new Promise((r) => setTimeout(r, 25));
      }
      send('pointerup', at(b));
      await new Promise((r) => setTimeout(r, 250));
      return true;
    }, [index, from, to, alt],
  );

  const read = (index) => page.evaluate((i) => {
    const editor = document.getElementById('voice-editor-bass');
    const cells = [...editor.querySelectorAll('.seq-cell')];
    const cell = cells[i];
    const live = window.__ambi4Engine.getParams().tracks.bass.sequencer.steps;
    const step = Array.isArray(live) ? live[i] : Object.values(live)[0][i];
    const band = cell.querySelector('.seq-band');
    return {
      engine: {
        on: step.on === true,
        tie: step.tie === true,
        gate: step.gate ?? null,
        midi: step.midi ?? null,
        vmin: +Number(step.vmin).toFixed(3),
        vmax: +Number(step.vmax).toFixed(3),
      },
      dom: {
        on: cell.classList.contains('seq-cell-on'),
        tie: cell.classList.contains('seq-cell-tie'),
        legato: cell.classList.contains('seq-cell-legato'),
        width: Math.round(cell.getBoundingClientRect().width),
        bandWidth: band ? Math.round(band.getBoundingClientRect().width) : null,
        pin: cell.querySelector('.seq-pin')?.textContent || null,
      },
    };
  }, index);

  // Start from a lane that is empty and untied, so each gesture below is the
  // only thing that could have caused what it asserts.
  // Reset through the UI's own Clear button, not by writing to the engine: the
  // PAGE holds the lane the gestures read, and a cell absorbed by an earlier
  // tie is display:none — undraggable, and indistinguishable from a gesture
  // that did nothing. (That is how this drive found that Clear left its ties
  // behind, fixed in v0.0.150.)
  const reset = async () => {
    await page.evaluate(async () => {
      const editor = document.getElementById('voice-editor-bass');
      const clear = [...editor.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Clear');
      clear?.click();
      await new Promise((r) => setTimeout(r, 350));
    });
    const hidden = await page.evaluate(() => {
      const editor = document.getElementById('voice-editor-bass');
      return [...editor.querySelectorAll('.seq-cell')].filter((c) => c.style.display === 'none').length;
    });
    check('a cleared lane hides no cells — every step is reachable again', hidden, 0);
  };

  // ---- 1. the velocity band: a drag in the UPPER half ----------------------
  await reset();
  await gesture(2, [0.5, 0.15], [0.5, 0.45]);
  const band = await read(2);
  check('a drag in the upper half switches the step on at the ENGINE', band.engine.on, true);
  check('…gives it a velocity band', band.engine.vmax > band.engine.vmin, (v) => v === true);
  check('…and the cell shows it, with no rebuild', band.dom.on, true);

  // ---- 2. the note length: a drag in the LOWER half ------------------------
  await reset();
  await gesture(3, [0.5, 0.8], [0.5, 0.05]);
  const gated = await read(3);
  check('a drag in the lower half sets a gate at the ENGINE',
    Number.isFinite(gated.engine.gate), (v) => v === true);
  check('…longer than one step, since it was dragged upward', gated.engine.gate > 1, (v) => v === true);
  check('…and the cell marks the overhang immediately', gated.dom.legato, true);

  // ---- 3. the tie: a SIDEWAYS drag ----------------------------------------
  await reset();
  const plain = await read(9);
  await gesture(5, [0.5, 0.5], [3.2, 0.5]);
  const tied = await read(5);
  check('a sideways drag ties at the ENGINE', tied.engine.tie, true);
  check('…and the box is wider there and then', tied.dom.width >= plain.dom.width * 2, (v) => v === true);

  // ---- 4. the pitch: ALT + a vertical drag ---------------------------------
  await reset();
  // A decisive drag: the gesture is only claimed once the pointer has moved
  // further than a tap, and a couple of pixels either side of that threshold is
  // not what this test is about.
  await gesture(6, [0.5, 0.9], [0.5, 0.05], { alt: true });
  const pitched = await read(6);
  check('alt+drag pins a note at the ENGINE', Number.isFinite(pitched.engine.midi), (v) => v === true);
  check('…and the cell prints the note name at once', !!pitched.dom.pin, (v) => v === true);

  // ---- 5. the probability group: a dot press -------------------------------
  await reset();
  const grouped = await page.evaluate(async () => {
    const editor = document.getElementById('voice-editor-bass');
    const host = [...editor.querySelectorAll('.seq-dot-cell')][4];
    const dots = [...host.children];
    const before = dots.length;
    dots[dots.length - 1].click();
    await new Promise((r) => setTimeout(r, 300));
    const live = window.__ambi4Engine.getParams().tracks.bass.sequencer.steps;
    const step = Array.isArray(live) ? live[4] : Object.values(live)[0][4];
    const after = [...editor.querySelectorAll('.seq-dot-cell')][4].children;
    return {
      group: Number.isFinite(step.group) ? step.group : null,
      dotsBefore: before,
      dotsAfter: after.length,
      filled: [...after].map((d) => d.classList.contains('seq-dot-on')),
    };
  });
  check('pressing the empty dot puts the step in a group at the ENGINE', grouped.group, 0);
  check('…and a new empty dot appears immediately', grouped.dotsAfter, grouped.dotsBefore + 1);
  check('…with the group it joined filled in', grouped.filled[0], true);

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'gesture-integrity-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n'),
    );
  }
  return { passed: results.length };
}
