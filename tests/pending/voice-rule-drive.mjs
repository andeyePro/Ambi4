/**
 * v0.0.195 — the voice rule: the first Now / Chance / Pool (his report:
 * Synthwave's melody kept moving to Organ stab and nothing could stop it).
 * PARKED in tests/pending until the Mac test bridge key is restored
 * (fromClaude 13); then:
 *
 *   npm run build && .vibe/measure.sh local drive tests/pending/voice-rule-drive.mjs
 *
 * tests/voice-rule-smoke.mjs proves the rule at the engine directly; this is
 * the real-browser half — the Voice chance KNOB (keyboard, per knob.js's own
 * key handling: Home goes to min, End to max, ArrowUp/Down step by 1 — see
 * tests/dial-drive.mjs for the same gesture model against a real dial), the
 * Pool editor's buttons, and the picker's live "· drawn" option, read back at
 * the ENGINE's own getParams()/getResolved() rather than the readout alone.
 *
 * Traps this honours (CLAUDE.md): Synthwave is pinned before anything that
 * depends on its melody voice or bpm; every dial/button is scrolled into
 * view before interacting with it; the Melody editor is scoped
 * (#voice-editor-melody) rather than matching the first `.knob` on the page.
 *
 * The knob's raw scale (see src/pages/index.astro's VARY_KEYS/appendVoiceRuleControls):
 * raw 0 is the Auto detent (chance: null, follows Randomness), raw 1 reads
 * "Hold" (chance: 0 — the rule this suite holds throughout the steady-voice
 * check), raw 21 is the top of the scale (chance: 1). Home then one ArrowUp
 * reaches raw 1 exactly; End reaches raw 21.
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

  /** ms per bar at the engine's CURRENT bpm/timeSignature — never assumed. */
  const barMsFor = () => page.evaluate(() => {
    const p = window.__ambi4Engine.getParams();
    const raw = p.bpm;
    const bpm = typeof raw === 'number' && Number.isFinite(raw)
      ? raw
      : (raw && Number.isFinite(raw.min) && Number.isFinite(raw.max) ? (raw.min + raw.max) / 2 : 94);
    const sig = typeof p.timeSignature === 'string' ? p.timeSignature : '4/4';
    const beats = parseInt(sig.split('/')[0], 10) || 4;
    return (60000 / bpm) * beats;
  });

  await page.click('#tab-advanced');
  await page.waitForTimeout(300);
  await page.click('#voice-edit-toggle-melody');
  await page.waitForSelector('#voice-editor-melody .vary-row');
  await page.waitForTimeout(300);

  const voiceKnob = () => page.locator('#voice-editor-melody .vary-row .knob[aria-label="Voice chance"]');
  check('the Randomise row has a Voice chance knob', await voiceKnob().count(), 1);

  // ---- Layout: the When select and Pool button sit BESIDE the knob, on
  // the same row, and never overlap the next vary-knob cell (Volume). ----
  const rowShape = await page.evaluate(() => {
    // .vary-knob cells in DOM order: [0] the Voice chance knob itself,
    // [1] appendVoiceRuleControls' own wrap (When + Pool — also classed
    // vary-knob, so it is NOT "the next cell"), [2] the Volume knob.
    const cells = [...document.querySelectorAll('#voice-editor-melody .vary-row .vary-knob')];
    const voice = cells[0]?.getBoundingClientRect();
    const when = document.querySelector('#voice-editor-melody .voice-rule-when')?.getBoundingClientRect();
    const pool = document.querySelector('#voice-editor-melody .voice-rule-pool')?.getBoundingClientRect();
    const next = cells[2]?.getBoundingClientRect(); // the Volume knob's cell
    return { voice, when, pool, next };
  });
  const sameRow = (a, b) => !!a && !!b && a.top < b.bottom && a.bottom > b.top;
  check('the When selector sits on the Voice chance knob\'s own row', sameRow(rowShape.voice, rowShape.when), (v) => v === true);
  check('…so does the Pool button', sameRow(rowShape.voice, rowShape.pool), (v) => v === true);
  const overlaps = (a, b) => !!a && !!b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  check('the voice-rule controls do not paint over the next knob cell', overlaps(rowShape.pool, rowShape.next), (v) => v === false);

  await voiceKnob().scrollIntoViewIfNeeded();
  await voiceKnob().focus();
  await page.keyboard.press('Home');
  await page.waitForTimeout(320);
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(320);

  const held = await page.evaluate(() => ({
    chance: window.__ambi4Engine.getParams().tracks.melody.voiceRule?.chance ?? null,
    readout: [...document.querySelectorAll('#voice-editor-melody .vary-row .knob')]
      .find((k) => k.getAttribute('aria-label') === 'Voice chance')
      ?.querySelector('.knob-value')?.textContent?.trim(),
  }));
  check('Home then one ArrowUp holds the voice at the ENGINE (chance 0)', held.chance, 0);
  check('…and the readout says Hold', held.readout, 'Hold');

  // ---- Steady over 8 bars: Chance 0 means the voice never redraws --------
  await page.evaluate(() => {
    window.__voiceLog = [];
    window.__ambi4Engine.on('bar', () => {
      window.__voiceLog.push(window.__ambi4Engine.getResolved().tracks.melody.voice);
    });
  });
  await page.click('#toggle-play');
  const barMs = await barMsFor();
  await page
    .waitForFunction(() => window.__voiceLog && window.__voiceLog.length >= 8, { timeout: Math.ceil(barMs * 8 * 1.6) + 6000 })
    .catch(() => {});
  const voices8 = await page.evaluate(() => window.__voiceLog.slice());
  check('8 bars actually elapsed', voices8.length >= 8, (v) => v === true);
  check('the resolved melody voice stayed keys the whole time', voices8.every((v) => v === 'keys'), (v) => v === true);
  results.push({ name: 'voices over 8 bars', ok: true, got: voices8, want: '(informational)' });

  // ---- Next: a held rule (and the pick under it) survives it -------------
  await page.click('#fast-forward');
  await page.waitForTimeout(500);
  const afterNext = await page.evaluate(() => ({
    chance: window.__ambi4Engine.getParams().tracks.melody.voiceRule?.chance ?? null,
    voice: window.__ambi4Engine.getResolved().tracks.melody.voice,
  }));
  check('Next keeps the held rule (chance still 0)', afterNext.chance, 0);
  check('…and the voice under it (still keys)', afterNext.voice, 'keys');

  await page.click('#toggle-play').catch(() => {});
  await page.waitForTimeout(300);

  // ---- Pool editor: remove Organ stab, choose In turn, Done ---------------
  await page.click('#voice-rule-pool-melody');
  await page.waitForSelector('#voice-blend-editor');
  await page.waitForTimeout(250);

  // Organ stab's option value in the melody voice bank is 'stab' (see
  // src/pages/index.astro's melody voice map — 'stab' -> 'Organ stab'); the
  // Pool editor's row carries it as data-voice.
  const stabRow = page.locator('#voice-blend-editor .blend-row[data-voice="stab"]');
  check('Organ stab is in the pool to start with', await stabRow.count(), 1);
  await stabRow.locator('.blend-remove').click();
  await page.waitForTimeout(150);
  check('…and is gone from the editor once removed', await page.locator('#voice-blend-editor .blend-row[data-voice="stab"]').count(), 0);

  await page.check('#voice-blend-editor input[name="blend-order-melody"][value="turn"]');
  await page.waitForTimeout(150);
  await page.click('#voice-blend-editor .blend-actions button:text-is("Done")');
  await page.waitForTimeout(400);

  const pooled = await page.evaluate(() => {
    const rule = window.__ambi4Engine.getParams().tracks.melody.voiceRule;
    return { pool: (rule?.pool || []).map((p) => p.id), order: rule?.order ?? null };
  });
  check('the ENGINE\'s pool no longer has Organ stab', pooled.pool.includes('stab'), false);
  check('…and draws In turn', pooled.order, 'turn');

  // ---- Raise Voice chance again via the knob: the picker names the draw --
  await voiceKnob().scrollIntoViewIfNeeded();
  await voiceKnob().focus();
  await page.keyboard.press('End');
  await page.waitForTimeout(320);
  const raised = await page.evaluate(() => window.__ambi4Engine.getParams().tracks.melody.voiceRule?.chance ?? null);
  check('the knob raised Voice chance off Hold', raised > 0, (v) => v === true);
  const live = await page.evaluate(() => document.querySelector('#track-voice-melody .voice-live-option')?.textContent || '');
  check('…and the picker\'s live option says so', /·\s*drawn/.test(live), (v) => v === true);

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'voice-rule-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n'),
    );
  }
  return { passed: results.length, notes: results.filter((r) => r.want === '(informational)').map((r) => `${r.name}: ${JSON.stringify(r.got)}`) };
}
