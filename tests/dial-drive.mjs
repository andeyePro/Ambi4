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
 */

const readout = (page, dialId) =>
  page.evaluate((id) => {
    const knob = document.getElementById(id)?.closest('.knob')
      || document.querySelector(`#${id}`)?.parentElement?.querySelector('.knob');
    const root = knob || [...document.querySelectorAll('.knob')].find((k) => k.getAttribute('aria-label'));
    return root ? {
      valuetext: root.getAttribute('aria-valuetext'),
      zeroed: root.getAttribute('data-zeroed'),
      text: root.querySelector('.knob-value')?.textContent?.trim(),
    } : null;
  }, dialId);

/** Every dial on the Advanced tab, by its aria-label. */
const dials = (page) =>
  page.evaluate(() => [...document.querySelectorAll('#panel-advanced .knob')].map((k) => ({
    label: k.getAttribute('aria-label'),
    valuetext: k.getAttribute('aria-valuetext'),
    text: k.querySelector('.knob-value')?.textContent?.trim(),
    box: (() => { const r = k.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.width / 2, w: r.width }; })(),
  })));

export default async function drive(page) {
  const results = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
  };

  // Grant storage consent first: the spread-survives-a-reload check below is
  // only meaningful once persistence is switched on, and clicking it is what a
  // user does.
  await page.click('#consent-slot button:has-text("Save on this device")').catch(() => {});
  await page.waitForTimeout(200);
  await page.click('#tab-advanced');
  await page.waitForTimeout(400);

  const before = await dials(page);
  check('the Advanced tab has its seven main dials', before.length >= 7, (v) => v === true);

  const tempo = before.find((d) => d.label === 'Tempo');
  check('Tempo is present and single-valued to start', tempo && !/drifting/.test(tempo.valuetext || ''), (v) => v === true);
  if (!tempo) throw new Error('dial-drive: no Tempo dial to drag');

  // A real horizontal drag across the face: down on the centre, out past the
  // lock threshold, release. Stepped, because one giant move would arrive as a
  // single pointermove and never exercise the lock at all.
  const { x, y } = tempo.box;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let dx = 4; dx <= 60; dx += 8) await page.mouse.move(x + dx, y);
  await page.mouse.up();
  await page.waitForTimeout(300);

  const afterSpread = (await dials(page)).find((d) => d.label === 'Tempo');
  check('a horizontal drag opened a span on Tempo', /drifting/.test(afterSpread.valuetext || ''), (v) => v === true);
  check('the readout shows both ends', /–/.test(afterSpread.text || ''), (v) => v === true);
  results.push({ name: 'Tempo reads', ok: true, got: afterSpread.text, want: '(informational)' });

  // The same gesture backwards must close it again.
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let dx = 4; dx <= 120; dx += 8) await page.mouse.move(x - dx, y);
  await page.mouse.up();
  await page.waitForTimeout(300);
  const afterClose = (await dials(page)).find((d) => d.label === 'Tempo');
  check('dragging back closes the span', !/drifting/.test(afterClose.valuetext || ''), (v) => v === true);

  // A vertical drag must move the value and NOT open a span.
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let dy = 4; dy <= 60; dy += 8) await page.mouse.move(x, y - dy);
  await page.mouse.up();
  await page.waitForTimeout(300);
  const afterVertical = (await dials(page)).find((d) => d.label === 'Tempo');
  check('a vertical drag does not open a span', !/drifting/.test(afterVertical.valuetext || ''), (v) => v === true);
  check('a vertical drag changed the value', afterVertical.text !== afterClose.text, (v) => v === true);

  // A tap on the centre hub resets it.
  await page.mouse.click(x, y);
  await page.waitForTimeout(300);
  const afterTap = (await dials(page)).find((d) => d.label === 'Tempo');
  check('a tap on the hub resets the dial', afterTap.text !== afterVertical.text, (v) => v === true);
  results.push({ name: 'Tempo after reset', ok: true, got: afterTap.text, want: '(informational)' });

  // Every main dial must answer the same gesture — that is the whole point of
  // the consistency rule. Anything that ignores it is named here rather than
  // averaged away.
  const deaf = [];
  for (const dial of (await dials(page)).slice(0, 7)) {
    const b = dial.box;
    await page.mouse.move(b.x, b.y);
    await page.mouse.down();
    for (let dx = 4; dx <= 60; dx += 8) await page.mouse.move(b.x + dx, b.y);
    await page.mouse.up();
    await page.waitForTimeout(150);
    const now = (await dials(page)).find((d) => d.label === dial.label);
    if (!/drifting/.test(now.valuetext || '')) deaf.push(dial.label);
  }
  check('every main dial spreads', deaf, []);

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
    // Every global dial that was just spread, by the settings key it writes.
    // Named individually rather than counted, so a failure says WHICH one
    // dropped its span.
    const missing = ['bpm', 'complexity', 'repetition', 'volume', 'swing', 'reverbTail']
      .filter((key) => !isSpan(stored[key]));
    check('every spread global dial persisted its span', missing, []);
    // Variation writes per-track randomness rather than a global key, so it
    // is checked where it actually lands.
    check('the per-track spread persisted too', isSpan(stored.tracks?.pad?.randomness), (v) => v === true);
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'dial-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n'),
    );
  }
  return { passed: results.length, notes: results.filter((r) => r.want === '(informational)').map((r) => `${r.name}: ${r.got}`) };
}
