/**
 * The dial gesture, driven in a real browser against the built page.
 *
 *   npm run build && .vibe/measure.sh local drive tests/dial-drive.mjs
 *
 * knob-gesture.mjs proves the gesture logic against a mock DOM. This proves
 * the part a mock cannot: that a real pointer drag on a real dial in the real
 * page reaches the engine, that the readout says so, and that nothing between
 * the two silently drops the span. The owner's ask was "everything should be
 * spreadable with horizontal drag" — a dial that opens a span the page then
 * discards would pass every unit test and fail the ask.
 *
 * EVERY interaction re-reads its target's box immediately beforehand, after
 * scrolling it to the middle of the viewport. page.mouse works in VIEWPORT
 * coordinates, so a dial below the fold receives a drag delivered to nothing —
 * and "the dial did not move" looks identical to "the dial refused the
 * gesture". Both of this file's early false results came from exactly that.
 */

/**
 * One dial by aria-label, scrolled into view, with its box read after the
 * scroll. `scope` matters more than it looks: Volume exists TWICE (a Simple
 * view and an Advanced view of one value), and an unscoped lookup returns the
 * Simple one — which is inside a hidden panel while Advanced is showing, so
 * every gesture aimed at it lands on nothing and the dial reads as though it
 * refused to spread. Hidden elements are skipped for the same reason.
 */
const dialAt = (page, label, scope = '') =>
  page.evaluate(([name, sel]) => {
    const root = sel ? document.querySelector(sel) : document;
    const visible = (el) => {
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        if (n.hidden || n.getAttribute?.('aria-hidden') === 'true') return false;
        const cs = getComputedStyle(n);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      }
      return true;
    };
    const k = [...(root || document).querySelectorAll('.knob')]
      .find((el) => el.getAttribute('aria-label') === name && visible(el));
    if (!k) return null;
    k.scrollIntoView({ block: 'center' });
    const r = k.getBoundingClientRect();
    return {
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.width / 2),
      valuetext: k.getAttribute('aria-valuetext'),
      text: k.querySelector('.knob-value')?.textContent?.trim(),
    };
  }, [label, scope]);

const advancedLabels = (page) =>
  page.evaluate(() => [...document.querySelectorAll('#panel-advanced .knob')]
    .map((k) => k.getAttribute('aria-label')));

const confirmLine = (page) =>
  page.evaluate(() => document.getElementById('dial-confirm')?.textContent?.trim() || '');

export default async function drive(page) {
  const results = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
  };

  /** Drag `label` by (dx, dy) in steps, so the axis lock is actually exercised. */
  async function dragDial(label, dx, dy, scope = '') {
    const d = await dialAt(page, label, scope);
    if (!d) return null;
    await page.mouse.move(d.x, d.y);
    await page.mouse.down();
    const steps = Math.max(Math.abs(dx), Math.abs(dy));
    for (let t = 4; t <= steps; t += 8) {
      const f = t / steps;
      await page.mouse.move(d.x + Math.round(dx * f), d.y + Math.round(dy * f));
    }
    await page.mouse.up();
    await page.waitForTimeout(320);
    return dialAt(page, label, scope);
  }

  const spread = (d) => /drifting/.test(d?.valuetext || '');

  await page.click('#consent-slot button:has-text("Save on this device")').catch(() => {});
  await page.waitForTimeout(200);
  await page.click('#tab-advanced');
  await page.waitForTimeout(400);

  const labels = await advancedLabels(page);
  check('the Advanced tab has its seven main dials', labels.length >= 7, (v) => v === true);

  const ADV = '#panel-advanced';
  const tempo0 = await dialAt(page, 'Tempo', ADV);
  check('Tempo is present and single-valued to start', tempo0 && !spread(tempo0), (v) => v === true);

  const opened = await dragDial('Tempo', 60, 0, ADV);
  check('a horizontal drag opened a span on Tempo', spread(opened), (v) => v === true);
  check('the readout shows both ends', /–/.test(opened.text || ''), (v) => v === true);
  results.push({ name: 'Tempo reads', ok: true, got: opened.text, want: '(informational)' });

  const closed = await dragDial('Tempo', -140, 0, ADV);
  check('dragging back closes the span', !spread(closed), (v) => v === true);

  const raised = await dragDial('Tempo', 0, -60, ADV);
  check('a vertical drag does not open a span', !spread(raised), (v) => v === true);
  check('a vertical drag changed the value', raised.text !== closed.text, (v) => v === true);

  // v0.0.63: a single click on the INNER CIRCLE is the zero button. Anywhere
  // else on the face is still inert, which is what keeps the reflex available
  // to someone whose dial is stuck from being destructive.
  const rim = await dialAt(page, 'Tempo', ADV);
  await page.mouse.click(rim.x + 40, rim.y);
  await page.waitForTimeout(320);
  const tapped = await dialAt(page, 'Tempo', ADV);
  check('a single click away from the centre changes nothing', tapped.text, raised.text);

  const beforeTap = await dialAt(page, 'Tempo', ADV);
  await page.mouse.click(beforeTap.x, beforeTap.y);
  await page.waitForTimeout(320);
  const zeroed = await page.evaluate(() => {
    const k = [...document.querySelectorAll('#panel-advanced .knob')]
      .find((el) => el.getAttribute('aria-label') === 'Tempo');
    return { zeroed: k.getAttribute('data-zeroed'), text: k.querySelector('.knob-value')?.textContent?.trim() };
  });
  check('a click on the inner circle zeroes the dial', zeroed.zeroed, 'true');
  results.push({ name: 'Tempo at zero', ok: true, got: zeroed.text, want: '(informational)' });

  // A double-click is the reset.
  await page.mouse.dblclick(beforeTap.x, beforeTap.y);
  await page.waitForTimeout(320);
  const reset = await dialAt(page, 'Tempo', ADV);
  check('a double-click resets the dial', reset.text !== raised.text, (v) => v === true);
  results.push({ name: 'Tempo after reset', ok: true, got: reset.text, want: '(informational)' });

  // Every main dial must answer the same gesture — that is the whole point of
  // the consistency rule. Anything that ignores it is NAMED, not averaged away.
  const deaf = [];
  for (const label of labels.slice(0, 7)) {
    const after = await dragDial(label, 60, 0, ADV);
    if (!spread(after)) deaf.push(label);
  }
  check('every main dial spreads', deaf, []);

  // ---- the Simple tab teaches the gesture, once -------------------------
  // Two owner instructions meet here: "everything should be spreadable with
  // horizontal drag" (28 Jul) and "give a message" on Simple (27 Jul). The
  // gesture works and Simple explains it the first time, which is the only
  // reading that honours both. Energy is the target because it is Simple's own
  // dial — Volume is a second view of an Advanced dial already dragged above.
  await page.click('#tab-simple');
  await page.waitForTimeout(400);
  // Energy is a view of the same bpm the Advanced Tempo drags above have
  // already spread, so it arrives here ALREADY drifting — and widening an
  // existing full-range span emits nothing, because nothing changed. Tap the
  // hub first so the spread below is genuinely new. Without this the test
  // asserted a state it had not caused, and passed for the wrong reason.
  const e0 = await dialAt(page, 'Energy');
  await page.mouse.dblclick(e0.x, e0.y);
  await page.waitForTimeout(320);
  const settled = await dialAt(page, 'Energy');
  check('the reset tap cleared the inherited spread', !spread(settled), (v) => v === true);
  await page.evaluate(() => { document.getElementById('dial-confirm').textContent = ''; });
  const energy = await dragDial('Energy', 60, 0);
  check('a Simple dial spreads like every other', spread(energy), (v) => v === true);
  const taught = await confirmLine(page);
  check('and says what just happened', /range to drift between/.test(taught), (v) => v === true);

  await page.evaluate(() => { document.getElementById('dial-confirm').textContent = ''; });
  await dragDial('Energy', 40, 0);
  const second = await confirmLine(page);
  check('but only once — a line on every drag is noise', /range to drift between/.test(second), (v) => v === false);

  // A spread that does not survive a reload is a setting the user loses
  // without being told. The share link is the same JSON tree, so checking the
  // stored tree covers both.
  await page.waitForTimeout(800); // persistSettings is throttled
  const stored = await page.evaluate(() => {
    try {
      const raw = localStorage.getItem('ambi4:generator');
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  });
  const isSpan = (v) => !!v && typeof v === 'object' && Number.isFinite(v.min) && Number.isFinite(v.max);
  check('storage consent took effect', !!stored, (v) => v === true);
  if (stored) {
    const missing = ['bpm', 'complexity', 'repetition', 'volume', 'swing', 'reverbTail']
      .filter((key) => !isSpan(stored[key]));
    check('every spread global dial persisted its span', missing, []);
    check('the per-track spread persisted too', isSpan(stored.tracks?.pad?.randomness), (v) => v === true);
  }

  // ---- the dial says whether it is still following you ------------------
  // The owner's report: "far too often I set the dial as I want it then move
  // to go elsewhere and I've ruined it." A pointer capture that outlives the
  // gesture is invisible unless the dial looks different while held.
  const grip = await dialAt(page, 'Energy');
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  await page.mouse.move(grip.x, grip.y - 20);
  const held = await page.evaluate(() => {
    const k = [...document.querySelectorAll('.knob')].find((el) => el.getAttribute('aria-label') === 'Energy');
    const line = k.querySelector('[data-role="pointer"]');
    return { flag: k.getAttribute('data-dragging'), width: line && +line.getAttribute('stroke-width') };
  });
  await page.mouse.up();
  await page.waitForTimeout(150);
  const let_go = await page.evaluate(() => {
    const k = [...document.querySelectorAll('.knob')].find((el) => el.getAttribute('aria-label') === 'Energy');
    const line = k.querySelector('[data-role="pointer"]');
    return { flag: k.getAttribute('data-dragging'), width: line && +line.getAttribute('stroke-width') };
  });
  check('the dial flags itself while a drag is live', held.flag, 'true');
  check('and stops flagging the moment you let go', let_go.flag, 'false');
  check('the indicator is at least twice as thick while held',
    held.width >= let_go.width * 2, (v) => v === true);
  results.push({ name: 'pointer width held/released', ok: true, got: [held.width, let_go.width], want: '(informational)' });

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'dial-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n'),
    );
  }
  return { passed: results.length, notes: results.filter((r) => r.want === '(informational)').map((r) => `${r.name}: ${r.got}`) };
}
