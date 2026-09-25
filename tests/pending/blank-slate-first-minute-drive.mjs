/**
 * v0.0.194 — the Blank slate first minute (his report: "I tried blank slate
 * and then entering a melody and got nothing"). PARKED in tests/pending until
 * the Mac test bridge key is restored (fromClaude 13); then:
 *
 *   npm run build && .vibe/measure.sh local drive tests/pending/blank-slate-first-minute-drive.mjs
 *
 * tests/blank-slate-sounds.mjs already proves this in jsdom with a fake
 * AudioContext; this is the real-browser half — a real pointer tap on a real
 * grid cell, a real click on Write it, and the engine's own 'bar'/'note'
 * events read back, rather than a synthetic setParams call standing in for
 * the gesture.
 *
 * Traps this honours (CLAUDE.md): about:blank is never needed here (no
 * fragment-only nav); every pointer target is scrolled into view and its box
 * re-read before the click; assertions read the ENGINE's stored params and
 * getResolved(), never just the readout; the Create popover is CLOSED before
 * a click on the tab strip, which v0.0.157 put in its shadow (the trap
 * typed-melody-drive.mjs documents at its own tab-advanced click).
 *
 * Blank slate resets bpm/timeSignature to DEFAULTS (60 bpm, 4/4 — see
 * src/pages/index.astro's `timeSignature: '4/4', bpm: 60`), so every wait
 * below is sized off an exact 4-second bar rather than a guess.
 */

const BAR_MS = 4000; // 60 bpm, 4/4, after any Blank slate

export default async function drive(page) {
  const results = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
  };

  await page.click('#consent-slot button:has-text("Save on this device")').catch(() => {});
  await page.waitForTimeout(200);

  const panelHidden = () => page.evaluate(() => document.getElementById('play-along')?.hidden !== false);
  const openPanel = async () => { if (await panelHidden()) { await page.click('#play-along-open'); await page.waitForTimeout(250); } };
  const closePanel = async () => { if (!(await panelHidden())) { await page.click('#play-along-open'); await page.waitForTimeout(150); } };

  // ---- Scenario 1: Blank slate, tap the Bass grid, Play -------------------
  await openPanel();
  await page.click('#create-blank');
  await page.waitForTimeout(400);

  await closePanel();
  await page.click('#tab-advanced');
  await page.waitForTimeout(300);
  await page.click('#voice-edit-toggle-bass');
  await page.waitForSelector('#voice-editor-bass .seq-cell');
  await page.waitForTimeout(300);

  const cells = page.locator('#voice-editor-bass .seq-cell');
  for (const i of [0, 4, 8, 12]) {
    const cell = cells.nth(i);
    await cell.scrollIntoViewIfNeeded();
    await cell.click();
    await page.waitForTimeout(150);
  }

  const tapped = await page.evaluate(() => {
    const t = window.__ambi4Engine.getParams().tracks.bass;
    const row = document.querySelector('.track-row[data-track="bass"]');
    const lamp = document.getElementById('track-lamp-bass');
    return {
      state: t.state,
      hand: t.sequencers?.[0]?.hand === true,
      rowState: row?.dataset.trackState || null,
      lampLabel: lamp?.getAttribute('aria-label') || '',
    };
  });
  check('a step tapped on the silent Bass grid switches it ON at the ENGINE', tapped.state, 'on');
  check('…marked hand-written (enters at once, not on its staged turn)', tapped.hand, true);
  check('the row lamp/state control reflects it in the DOM', tapped.rowState, 'on');
  check('…and its accessible label says On', /state:\s*On\b/.test(tapped.lampLabel), (v) => v === true);

  await page.evaluate(() => {
    window.__bassNotes = [];
    window.__ambi4Engine.on('note', (e) => { if (e.track === 'bass') window.__bassNotes.push(e.midi); });
  });
  await page.click('#toggle-play');
  const gotBassNote = await page
    .waitForFunction(() => window.__bassNotes && window.__bassNotes.length > 0, { timeout: BAR_MS + 3000 })
    .then(() => true)
    .catch(() => false);
  check('a tapped Bass step actually sounds within one bar of Play', gotBassNote, (v) => v === true);
  await page.click('#toggle-play').catch(() => {});
  await page.waitForTimeout(300);

  // ---- Scenario 2: Blank slate again, type onto Bass, Write it ------------
  await openPanel();
  await page.click('#create-blank');
  await page.waitForTimeout(400);

  // The picker's "onto" label must be VISIBLE (v0.0.194: it used to be
  // invisible, so nobody could tell Write it would land on their chosen
  // track). Read the computed style, not just the class list.
  const labelShape = await page.evaluate(() => {
    const label = document.querySelector('label[for="compose-melody-track"]');
    if (!label) return null;
    const cs = getComputedStyle(label);
    const r = label.getBoundingClientRect();
    return {
      hiddenClass: label.classList.contains('visually-hidden'),
      display: cs.display,
      visibility: cs.visibility,
      width: r.width,
      height: r.height,
      text: label.textContent.trim(),
    };
  });
  check('the "onto" picker label exists and names itself', labelShape?.text, 'onto');
  check('…is not the visually-hidden class', labelShape?.hiddenClass, false);
  check('…is not display:none / visibility:hidden', labelShape && labelShape.display !== 'none' && labelShape.visibility !== 'hidden', (v) => v === true);
  check('…and actually occupies screen space', labelShape && labelShape.width > 0 && labelShape.height > 0, (v) => v === true);

  // Layout: the row holding the picker must not have wrapped taller than the
  // button that sits beside it (≤ 1.5× the button's own height).
  const rowShape = await page.evaluate(() => {
    const row = document.querySelector('.create-melody-row');
    const btn = document.getElementById('compose-melody-write');
    if (!row || !btn) return null;
    return { rowH: row.getBoundingClientRect().height, btnH: btn.getBoundingClientRect().height };
  });
  check('the Create row holding the picker did not wrap taller than its own button',
    rowShape && rowShape.rowH <= rowShape.btnH * 1.5, (v) => v === true);

  await page.fill('#compose-melody-text', 'C2 - G2 A2');
  await page.selectOption('#compose-melody-track', 'bass');
  await page.waitForTimeout(150);

  await page.evaluate(() => {
    window.__bassNotes2 = [];
    window.__ambi4Engine.on('note', (e) => { if (e.track === 'bass') window.__bassNotes2.push(e.midi); });
  });
  const runningBefore = await page.evaluate(() => window.__ambi4Engine.running === true);
  check('nothing is playing before Write it', runningBefore, false);

  await page.click('#compose-melody-write');
  await page.waitForTimeout(400);

  const wrote = await page.evaluate(() => ({
    running: window.__ambi4Engine.running === true,
    tip: document.getElementById('guided-tip')?.textContent || '',
  }));
  check('Write it starts the piece on its own — no Play needed', wrote.running, true);
  check('the tip says it is playing now', /playing now/i.test(wrote.tip), (v) => v === true);

  const gotBassNote2 = await page
    .waitForFunction(() => window.__bassNotes2 && window.__bassNotes2.length > 0, { timeout: BAR_MS + 3000 })
    .then(() => true)
    .catch(() => false);
  check('the typed Bass line actually sounds within one bar', gotBassNote2, (v) => v === true);

  await page.hover('#compose-melody-write');
  await page.waitForTimeout(250);
  const tooltip = await page.evaluate(() => document.querySelector('.ui-tooltip')?.textContent || '');
  check('Write it\'s tooltip names the instrument the picker points at (bass)', /bass/i.test(tooltip), (v) => v === true);

  await page.click('#toggle-play').catch(() => {});
  await page.waitForTimeout(300);

  // ---- Scenario 3: a track switched on with an EMPTY grid stays staged ----
  await openPanel();
  await page.click('#create-blank');
  await page.waitForTimeout(400);
  await closePanel();
  await page.click('#tab-advanced');
  await page.waitForTimeout(300);

  // The lamp cycles Off -> Auto -> On; Blank slate leaves every track Off.
  await page.click('#track-lamp-melody');
  await page.waitForTimeout(150);
  await page.click('#track-lamp-melody');
  await page.waitForTimeout(200);
  const melodyOn = await page.evaluate(() => window.__ambi4Engine.getParams().tracks.melody.state);
  check('Melody was switched On via its lamp, with an empty grid', melodyOn, 'on');

  await page.evaluate(() => {
    window.__bars = [];
    window.__ambi4Engine.on('bar', (e) => { window.__bars.push(e.bar); });
  });
  await page.click('#toggle-play');

  const sawNoticeEarly = await page
    .waitForFunction(() => (document.getElementById('transport-status')?.textContent || '').includes('Melody enters in'), { timeout: BAR_MS })
    .then(() => true)
    .catch(() => false);
  check('during bar 0 the transport line says Melody is still to enter', sawNoticeEarly, (v) => v === true);

  await page.waitForFunction(() => window.__bars.includes(2), { timeout: BAR_MS * 3 + 4000 }).catch(() => {});
  await page.waitForTimeout(200);
  const afterBar2 = await page.evaluate(() => document.getElementById('transport-status')?.textContent || '');
  check('by bar 2 the staged notice for Melody is gone', /Melody enters in/.test(afterBar2), (v) => v === false);

  await page.click('#toggle-play').catch(() => {});
  await page.waitForTimeout(200);

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'blank-slate-first-minute-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n'),
    );
  }
  return { passed: results.length };
}
