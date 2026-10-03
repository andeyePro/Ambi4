/**
 * The voice blend: weights reach the ENGINE, sections draw from them, and an
 * explicit pick ends the blend (v0.0.163 — his 128, option a). Opened from the
 * voice rule's Pool… since ui-review fix 13 removed the picker's entry.
 *
 *   npm run build && .vibe/measure.sh local drive tests/voice-blend-drive.mjs
 *
 * Asserts the engine's stored voiceWeights and the resolved (drawn) voice —
 * never just the select's label — and the round-trip through a real reload.
 */

export default async function drive(page) {
  const results = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
  };

  await page.click('#consent-slot button:has-text("Save on this device")').catch(() => {});
  await page.waitForTimeout(300);
  await page.click('#tab-advanced');
  await page.waitForTimeout(300);

  // ui-review 2026-10-03 fix 13: the picker no longer carries a "Pool of
  // voices…" entry; the pool's one door is the voice rule's Pool… button in
  // the track's editor, which opens the same dialog.
  const hasEntry = await page.evaluate(() =>
    [...document.getElementById('track-voice-pad').options].some((o) => o.value === '__blend'));
  check('the pad select lists voices only (no Pool of voices… entry)', hasEntry, false);

  // Open it the way a person does: Edit, then the voice rule's Pool….
  await page.evaluate(() => {
    const editor = document.getElementById('voice-editor-pad');
    if (!editor || editor.hidden) document.getElementById('voice-edit-toggle-pad')?.click();
  });
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const pool = document.getElementById('voice-rule-pool-pad');
    pool?.scrollIntoView({ block: 'center' });
    pool?.click();
  });
  await page.waitForTimeout(300);
  const dialogOpen = await page.evaluate(() => !!document.getElementById('voice-blend-editor'));
  check('the blend dialog opens', dialogOpen, true);

  // Warm 1 / Glass 1, everything else 0, Done. ZEROING FIRST matters: the
  // dialog seeds the CURRENT voice at weight 1, and a fresh visit draws a
  // RANDOM genre — a draw that lands the pad on Polysaw would otherwise ride
  // into the blend and fail the exact-weights assert on the draw (the repo's
  // own pin-the-genre trap, met here as pin-the-weights).
  await page.evaluate(() => {
    const set = (el, v) => {
      el.value = String(v);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    // v0.0.195: a Pool weight runs 1–10 and a voice leaves the pool by its
    // remove button (a 0 weight clamps back to 1), so remove every row that
    // is not Warm or Glass, re-reading the list after each (it re-renders).
    for (let guard = 0; guard < 20; guard++) {
      const row = [...document.querySelectorAll('#voice-blend-editor .blend-remove')]
        .find((b) => !/blend-weight-pad-(warm|glass)$/.test(b.closest('.blend-row')?.querySelector('input')?.id || ''));
      if (!row) break;
      row.click();
    }
    for (const id of ['warm', 'glass']) {
      const input = document.getElementById(`blend-weight-pad-${id}`);
      if (input) set(input, 1);
    }
  });
  await page.click('#voice-blend-editor button:has-text("Done")');
  await page.waitForTimeout(400);

  const stored = await page.evaluate(() => {
    const p = window.__ambi4Engine.getParams();
    // v0.0.195: the Pool editor writes the voice RULE (voiceWeights is the
    // legacy blend it replaced) — the pool and its weights live there.
    const poolOf = (rule) => (rule && Array.isArray(rule.pool) ? Object.fromEntries(rule.pool.map((e) => [e.id, e.weight])) : null);
    return { weights: poolOf(p.tracks.pad.voiceRule), chance: p.tracks.pad.voiceRule?.chance ?? null, voice: p.tracks.pad.voice };
  });
  check('the ENGINE stores the pool and its weights', stored.weights, { warm: 1, glass: 1 });
  check('…with a chance to draw from it', stored.chance, (v) => v === null || v > 0);
  check('…and keeps the configured voice untouched', typeof stored.voice, 'string');

  // Play a bar: the resolved (drawn) voice must come from the pool, and the
  // select's live option must say blend.
  await page.evaluate(() => {
    // Chance null follows Randomness — a coin toss per bar — so pin it to 1
    // for this check: every bar must then draw from the pool.
    const rule = window.__ambi4Engine.getParams().tracks.pad.voiceRule;
    window.__ambi4Engine.setParams({ tracks: { pad: { state: 'on', voiceRule: { ...rule, chance: 1, when: 'bar' } } } });
    document.getElementById('toggle-play').click();
  });
  await page.waitForTimeout(7000);
  const live = await page.evaluate(() => ({
    resolved: window.__ambi4Engine.getResolved().tracks.pad.voice,
    rule: window.__ambi4Engine.getParams().tracks.pad.voiceRule ?? null,
    configured: window.__ambi4Engine.getParams().tracks.pad.voice,
    label: document.querySelector('#track-voice-pad .voice-live-option')?.textContent ?? null,
  }));
  await page.evaluate(() => document.getElementById('toggle-play').click());
  check('the drawn voice comes from the pool', { resolved: live.resolved, configured: live.configured, rule: live.rule }, (v) => ['warm', 'glass'].includes(v.resolved));
  check('the select names the drawn voice and the state', /· drawn$/.test(live.label || ''), (v) => v === true);

  // A REAL reload: the blend survives to the engine.
  const url = page.url();
  await page.goto('about:blank');
  await page.goto(url);
  await page.waitForTimeout(2000);
  await page.click('#consent-slot button:has-text("Save on this device")').catch(() => {});
  await page.waitForTimeout(300);
  const reloaded = await page.evaluate(() => {
    const poolOf = (rule) => (rule && Array.isArray(rule.pool) ? Object.fromEntries(rule.pool.map((e) => [e.id, e.weight])) : null);
    return poolOf(window.__ambi4Engine.getParams().tracks.pad.voiceRule);
  });
  check('the pool survives a reload at the ENGINE', reloaded, { warm: 1, glass: 1 });

  // An explicit voice pick ends the blend, as the live option promises.
  await page.click('#tab-advanced').catch(() => {});
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const select = document.getElementById('track-voice-pad');
    const plain = [...select.querySelectorAll('optgroup.stock-voices option')][0];
    select.value = plain.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(300);
  const cleared = await page.evaluate(() => ({
    chance: window.__ambi4Engine.getParams().tracks.pad.voiceRule?.chance ?? null,
    liveOption: document.querySelector('#track-voice-pad .voice-live-option')?.textContent ?? null,
  }));
  // v0.0.195 (his ruling): an explicit pick HOLDS — Chance 0, pool kept.
  check('an explicit pick holds the voice at the ENGINE (Chance 0)', cleared.chance, 0);
  check('…and the drawn label goes with it', /drawn|blend/.test(cleared.liveOption || ''), (v) => v === false);

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'voice-blend-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n'),
    );
  }
  return { passed: results.length };
}
