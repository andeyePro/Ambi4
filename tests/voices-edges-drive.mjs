/**
 * The voice editor's edges, driven in a real browser against the built page:
 * drafts (edit, move away, come back, save, revert, forget), the Voice chance
 * dial, the Edited list across a reload, an edit while playing, a genre pick
 * over an edit, and a track of the person's own — every write asserted at the
 * ENGINE, never just the readout.
 *
 *   npm run build && .vibe/measure.sh local drive tests/voices-edges-drive.mjs
 *
 * page-boot proves the leave-guard's buttons in jsdom; voice-blend-drive the
 * pool. This is the sequence coverage neither has, and it was RED on dev
 * (2026-10-30) for two things it found:
 *
 *  - "Move on" after picking another voice PARKED the edit in the picker but
 *    left it in the engine's patch bank, so a later draw or wander onto that
 *    voice played the parked edit (the Next / genre path reset it; the pick
 *    path did not).
 *  - a removed track of the person's own kept its drafts and patches in the
 *    page's settings, and a new track given the same name inherited a "Warm ·
 *    edited" it never had.
 *
 * Traps (CLAUDE.md): about:blank before every reload, the genre pinned, every
 * query scoped to #voice-editor-<track>, console and page errors fail the run.
 */

export default async function drive(page) {
  const results = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
  };
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + (e && e.message ? e.message : String(e))));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  const settle = (ms = 300) => page.waitForTimeout(ms);
  const near = (v, want) => Math.abs(Number(v) - want) < 0.05;

  const boot = async () => {
    await page.waitForSelector('#generator-app:not([hidden])', { timeout: 20000 }).catch(() => {});
    await settle(1200);
    await page.click('#consent-slot button:has-text("Save on this device")').catch(() => {});
    await settle(200);
    await page.click('#tab-advanced');
    await settle();
  };
  const reload = async () => {
    const url = page.url();
    await settle(500); // past the 250 ms persist debounce
    await page.goto('about:blank');
    await page.goto(url);
    await boot();
  };
  const P = () => page.evaluate(() => window.__ambi4Engine.getParams());
  const running = () => page.evaluate(() => { const r = window.__ambi4Engine.running; return Boolean(typeof r === 'function' ? r() : r); });
  // Stop rings out (a stop is a fade, never a cut), so a play pressed before
  // the fade ends toggles the wrong way: wait for the engine's own word.
  const untilRunning = (want) => page.waitForFunction((w) => { const r = window.__ambi4Engine.running; return Boolean(typeof r === 'function' ? r() : r) === w; }, want, { timeout: 15000 }).then(() => true).catch(() => false);
  const patchAt = async (track, voice, field) => {
    const [s, f] = field.split('.');
    return (await P()).patches?.[track]?.[voice]?.[s]?.[f] ?? null;
  };
  const pick = async (track, value) => {
    await page.evaluate(([t, v]) => {
      const s = document.getElementById(`track-voice-${t}`);
      s.value = v;
      s.dispatchEvent(new Event('change', { bubbles: true }));
    }, [track, value]);
    await settle(250);
  };
  const guardButtons = () => page.evaluate(() => {
    const g = document.getElementById('leave-guard');
    return g ? [...g.querySelectorAll('button')].map((b) => b.className.replace('secondary-button ', '')) : null;
  });
  const guardClick = async (cls) => { await page.click(`#leave-guard .${cls}`, { timeout: 5000 }); await settle(250); };
  const openEditor = async (track) => {
    await page.evaluate((t) => {
      const ed = document.getElementById(`voice-editor-${t}`);
      if (!ed || ed.hidden) document.getElementById(`voice-edit-toggle-${t}`)?.click();
    }, track);
    return page.waitForFunction((t) => {
      const el = document.getElementById(`voice-editor-${t}`);
      return !!(el && !el.hidden && el.querySelector('.patch-controls .knob-cell[data-field="adsr.release"]'));
    }, track, { timeout: 8000 }).then(() => true).catch(() => false);
  };
  const editorHidden = (track) => page.evaluate((t) => document.getElementById(`voice-editor-${t}`)?.hidden ?? null, track);
  // Type into a dial's readout, the editor's own path (page-boot's typeInto).
  const typeInto = async (track, field, value) => page.evaluate(([t, f, v]) => {
    const editor = document.getElementById(`voice-editor-${t}`);
    const cell = editor?.querySelector(`.patch-controls .knob-cell[data-field="${f}"]`);
    const readout = cell?.querySelector('.knob-value');
    if (!readout) return false;
    readout.click();
    const box = cell.querySelector('.knob-value-edit');
    if (!box) return false;
    box.value = String(v);
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  }, [track, field, value]).then(async (ok) => { await settle(200); return ok; });
  const picker = (track) => page.evaluate((t) => {
    const s = document.getElementById(`track-voice-${t}`);
    if (!s) return null;
    const group = (label) => {
      const g = [...s.querySelectorAll('optgroup')].find((x) => x.label === label);
      return g ? [...g.querySelectorAll('option')].map((o) => o.value) : [];
    };
    return {
      selectedText: s.selectedOptions[0]?.textContent ?? null,
      edited: group('Edited'),
      user: group('User'),
      factoryShown: !(document.getElementById(`track-factory-${t}`)?.hidden ?? true),
    };
  }, track);
  const chanceKnob = (track) => page.evaluate((t) => {
    const k = [...document.querySelectorAll(`#voice-editor-${t} .knob`)].find((el) => el.getAttribute('aria-label') === 'Voice chance');
    if (!k) return null;
    k.scrollIntoView({ block: 'center' });
    const r = k.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), vt: k.getAttribute('aria-valuetext'), h: r.height };
  }, track);
  const dragChance = async (track, dy) => {
    const b = await chanceKnob(track);
    if (!b || !b.h) return false;
    await page.mouse.move(b.x, b.y);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) await page.mouse.move(b.x, b.y + Math.round((dy / 12) * i));
    await page.mouse.up();
    await settle(350);
    return true;
  };
  const keyChance = async (track, key) => {
    await page.evaluate(([t, k]) => {
      const el = [...document.querySelectorAll(`#voice-editor-${t} .knob`)].find((x) => x.getAttribute('aria-label') === 'Voice chance');
      el.focus();
      el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    }, [track, key]);
    await settle(300);
  };

  await boot();
  // Pin the genre: a fresh visit draws a random one, and the pad's factory
  // sound (what "parked" and "reset" are measured against) depends on it.
  await page.evaluate(() => {
    const sel = document.getElementById('genre-select');
    sel.value = 'g:synthwave';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const pinned = await page.waitForFunction(() => window.__ambi4Engine?.getParams?.()?.genre === 'synthwave', { timeout: 8000 }).then(() => true).catch(() => false);
  check('Synthwave pinned at the engine', pinned, true);
  await settle(300);
  await page.evaluate(() => document.getElementById('leave-guard')?.querySelector('.leave-guard-move')?.click());

  // ---- 1. An edit reaches the engine and the picker says so -----------------
  await pick('pad', 'warm');
  check('picking Warm on a factory pad asks nothing', await guardButtons(), null);
  check('the pad editor opens', await openEditor('pad'), true);
  check('Release typed as 2.5', await typeInto('pad', 'adsr.release', 2.5), true);
  check('…reaches the ENGINE', near(await patchAt('pad', 'warm', 'adsr.release'), 2.5), true);
  let pk = await picker('pad');
  check('…and the picker reads "Warm · edited" with ↺ Factory shown', [pk.selectedText, pk.factoryShown], ['Warm · edited', true]);

  // ---- 2. Keep editing on an editor close leaves the edit sounding ------------
  await page.evaluate(() => document.getElementById('voice-edit-toggle-pad').click());
  await settle(250);
  check('closing the editor on an edited voice asks', Array.isArray(await guardButtons()), true);
  await guardClick('leave-guard-cancel');
  check('Keep editing: no dialog, editor still open, edit still at the engine',
    [await guardButtons(), await editorHidden('pad'), near(await patchAt('pad', 'warm', 'adsr.release'), 2.5)], [null, false, true]);

  // ---- 3. Pick another voice, Move on: parked in the picker AND out of the engine
  await pick('pad', 'glass');
  check('leaving edited Warm for Glass asks', Array.isArray(await guardButtons()), true);
  await guardClick('leave-guard-move');
  pk = await picker('pad');
  check('Move on: the engine plays Glass', (await P()).tracks.pad.voice, 'glass');
  check('…the edit is parked under Edited', pk.edited, ['draft:warm']);
  // The finding: parked means "one pick away", not "still in the engine's
  // bank" — a draw onto Warm would otherwise play the edit the picker calls
  // parked. The engine's Warm must be back at its factory release.
  check('…and the ENGINE no longer carries the parked edit on Warm', await patchAt('pad', 'warm', 'adsr.release'),
    (v) => v === null || !near(v, 2.5));

  // ---- 4. Reload: the draft survives; picking it brings the edit back --------
  await reload();
  pk = await picker('pad');
  check('after a reload the draft is still listed', pk.edited, ['draft:warm']);
  check('…and the engine still plays Glass', (await P()).tracks.pad.voice, 'glass');
  await pick('pad', 'draft:warm');
  check('picking the draft asks nothing (Glass was not edited)', await guardButtons(), null);
  pk = await picker('pad');
  check('the draft pick restores Warm with Release 2.5 at the ENGINE',
    [(await P()).tracks.pad.voice, near(await patchAt('pad', 'warm', 'adsr.release'), 2.5)], ['warm', true]);
  check('…reads "Warm · edited" and the draft entry is gone', [pk.selectedText, pk.edited], ['Warm · edited', ['__live']]);

  // ---- 5. The same voice picked under Stock parks and resets -----------------
  await pick('pad', 'warm');
  check('picking Warm under Stock while Warm is edited asks', Array.isArray(await guardButtons()), true);
  await guardClick('leave-guard-move');
  pk = await picker('pad');
  check('Stock Warm plays the factory sound at the ENGINE', near(await patchAt('pad', 'warm', 'adsr.release'), 2.5), false);
  check('…with the edit parked', pk.edited, ['draft:warm']);
  await pick('pad', 'draft:warm');
  check('…and one pick brings it back', near(await patchAt('pad', 'warm', 'adsr.release'), 2.5), true);

  // ---- 6. A sounding edit survives a reload at the engine --------------------
  await reload();
  pk = await picker('pad');
  check('after a reload the sounding edit is at the ENGINE and in the picker',
    [near(await patchAt('pad', 'warm', 'adsr.release'), 2.5), pk.selectedText, pk.factoryShown], [true, 'Warm · edited', true]);

  // ---- 7. The Voice chance dial ---------------------------------------------
  check('the pad editor opens again', await openEditor('pad'), true);
  check('Voice chance dragged to the bottom', await dragChance('pad', 400), true);
  let rule = (await P()).tracks.pad.voiceRule;
  check('…is the Auto detent: chance null at the ENGINE, "Auto" on the dial', [rule && 'chance' in rule ? rule.chance : 'absent', (await chanceKnob('pad')).vt], [null, 'Auto']);
  await keyChance('pad', 'ArrowUp');
  rule = (await P()).tracks.pad.voiceRule;
  check('one step up is Hold: chance 0 at the ENGINE', [rule?.chance, (await chanceKnob('pad')).vt], [0, 'Hold']);
  check('Voice chance dragged up', await dragChance('pad', -40), true);
  rule = (await P()).tracks.pad.voiceRule;
  check('…a chance above 0 at the ENGINE, with a pool to draw from', [typeof rule?.chance === 'number' && rule.chance > 0, (rule?.pool || []).length > 1], [true, true]);
  const chanceSet = rule?.chance;
  const whenSet = await page.evaluate(() => {
    const w = document.getElementById('voice-rule-when-pad');
    if (!w) return null;
    w.value = 'section';
    w.dispatchEvent(new Event('change', { bubbles: true }));
    return window.__ambi4Engine.getParams().tracks.pad.voiceRule?.when ?? null;
  });
  check('When → each section reaches the ENGINE', whenSet, 'section');
  await reload();
  rule = (await P()).tracks.pad.voiceRule;
  check('chance and When survive a reload at the ENGINE', [rule?.chance, rule?.when], [chanceSet, 'section']);
  // Hold the pick again before anything plays: with a chance above 0 the
  // draw lands the pad on another voice, and an editor opened then edits
  // THAT voice (the trap this drive met on its first run: "Choir · drawn").
  check('the pad editor opens to hold the voice', await openEditor('pad'), true);
  await dragChance('pad', 400);
  await keyChance('pad', 'ArrowUp');
  check('Voice chance back at Hold: chance 0 at the ENGINE', (await P()).tracks.pad.voiceRule?.chance, 0);

  // ---- 8. An edit while playing reaches the engine without a fault -----------
  check('the pad editor opens once more', await openEditor('pad'), true);
  await page.evaluate(() => document.getElementById('toggle-play').click());
  await settle(2500);
  const errorsBefore = errors.length;
  check('Cutoff typed while playing', await typeInto('pad', 'filter.cutoff', 900), true);
  await settle(600);
  const cutoff = await patchAt('pad', 'warm', 'filter.cutoff');
  check('…reaches the ENGINE while the piece runs', cutoff && typeof cutoff === 'object' ? near(cutoff.min, 900) || near(cutoff.max, 900) : near(cutoff, 900), true);
  check('…the transport stays running', await running(), true);
  check('…and nothing threw', errors.length - errorsBefore, 0);
  await page.evaluate(() => document.getElementById('toggle-play').click());
  check('stop rings out and the engine stops', await untilRunning(false), true);

  // ---- 9. Save voice, edit, Revert to last save, Forget while playing --------
  await page.evaluate(() => { const box = document.getElementById('ve-more-box-pad'); if (box && box.hidden) document.getElementById('ve-more-pad')?.click(); });
  await settle(200);
  await page.evaluate(() => {
    const ed = document.getElementById('voice-editor-pad');
    ed.querySelector('.ve-voice-name').value = '';
    ed.querySelector('.ve-save-voice').click();
  });
  await settle(200);
  pk = await picker('pad');
  check('Save voice with no name saves nothing', pk.user, []);
  await page.evaluate(() => {
    const ed = document.getElementById('voice-editor-pad');
    ed.querySelector('.ve-voice-name').value = 'Edges pad';
    ed.querySelector('.ve-save-voice').click();
  });
  await settle(300);
  pk = await picker('pad');
  check('Save voice lists it under User and the picker reads its name', [pk.user.length, pk.selectedText, pk.factoryShown], [1, 'Edges pad', false]);
  const savedRelease = await patchAt('pad', 'warm', 'adsr.release');
  check('Release typed as 3.5 on the User voice', await typeInto('pad', 'adsr.release', 3.5), true);
  check('…reaches the ENGINE and reads "Edges pad · edited"', [near(await patchAt('pad', 'warm', 'adsr.release'), 3.5), (await picker('pad')).selectedText], [true, 'Edges pad · edited']);
  await page.evaluate(() => document.getElementById('voice-edit-toggle-pad').click());
  await settle(250);
  const userGuard = await guardButtons();
  check('closing on an edited User voice offers Save changes and Revert, not Reset',
    [userGuard?.includes('leave-guard-save'), userGuard?.includes('leave-guard-revert'), userGuard?.includes('leave-guard-reset')], [true, true, false]);
  await guardClick('leave-guard-revert');
  await page.evaluate(() => document.querySelector('#factory-confirm .factory-confirm-go')?.click());
  await settle(300);
  check('Revert to last save puts the save back at the ENGINE and closes the editor',
    [near(await patchAt('pad', 'warm', 'adsr.release'), savedRelease), await editorHidden('pad'), await guardButtons()], [true, true, null]);
  check('the pad editor opens for Forget', await openEditor('pad'), true);
  await page.evaluate(() => { const box = document.getElementById('ve-more-box-pad'); if (box && box.hidden) document.getElementById('ve-more-pad')?.click(); });
  await page.evaluate(() => document.getElementById('toggle-play').click());
  check('playing again before Forget', await untilRunning(true), true);
  await settle(800);
  await page.evaluate(() => document.querySelector('#voice-editor-pad .ve-forget-voice')?.click());
  await settle(300);
  pk = await picker('pad');
  check('Forget while playing: gone from User, Warm plays on with its dials, transport running',
    [pk.user, (await P()).tracks.pad.voice, near(await patchAt('pad', 'warm', 'adsr.release'), savedRelease), await running()],
    [[], 'warm', true, true]);
  await page.evaluate(() => document.getElementById('toggle-play').click());
  await untilRunning(false);

  // ---- 10. A genre pick over an edited voice ---------------------------------
  await page.evaluate(() => {
    const sel = document.getElementById('genre-select');
    sel.value = 'g:techno-tools';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle(300);
  check('a genre pick over an edited Warm asks', Array.isArray(await guardButtons()), true);
  await guardClick('leave-guard-move');
  const loaded = await page.waitForFunction(() => window.__ambi4Engine?.getParams?.()?.genre === 'techno-tools', { timeout: 8000 }).then(() => true).catch(() => false);
  pk = await picker('pad');
  check('Move on loads the genre, parks the edit, and the ENGINE carries no edit on Warm',
    [loaded, pk.edited.includes('draft:warm'), await patchAt('pad', 'warm', 'adsr.release')], [true, true, null]);

  // ---- 11. A track of the person's own ---------------------------------------
  const addTrack = async () => {
    const out = await page.evaluate(() => {
      const btn = document.getElementById('add-track');
      if (!btn) return 'no Add track';
      btn.click();
      const name = document.getElementById('add-track-name');
      const form = document.getElementById('add-track-form');
      if (!name || !form) return 'no form';
      name.value = 'Edges track';
      form.requestSubmit();
      return document.getElementById('add-track-error')?.textContent || 'ok';
    });
    await settle(600);
    return out;
  };
  check('Add track: Edges track', await addTrack(), 'ok');
  let p = await P();
  const tid = (p.userTracks || []).slice(-1)[0]?.id ?? null;
  check('…the engine lists it', typeof tid, 'string');
  if (tid) {
    const base = p.tracks[tid].voice;
    check('its editor opens', await openEditor(tid), true);
    check('Release typed as 1.7 on it', await typeInto(tid, 'adsr.release', 1.7), true);
    check('…reaches the ENGINE under its own id', near(await patchAt(tid, base, 'adsr.release'), 1.7), true);
    check('its Voice chance dragged up', await dragChance(tid, -60), true);
    const r = (await P()).tracks[tid].voiceRule;
    check('…reaches the ENGINE as its voice rule', typeof r?.chance === 'number' && r.chance > 0 && (r.pool || []).length > 1, true);
    const other = await page.evaluate(([id, b]) => [...document.querySelectorAll(`#track-voice-${id} optgroup.stock-voices option`)].map((o) => o.value).find((x) => x !== b), [tid, base]);
    await pick(tid, other);
    check('leaving its edited voice asks', Array.isArray(await guardButtons()), true);
    await guardClick('leave-guard-move');
    pk = await picker(tid);
    check('Move on parks it under Edited on that track', pk.edited, [`draft:${base}`]);
    await reload();
    p = await P();
    pk = await picker(tid);
    check('after a reload the track, its pick and its draft are all back', [(p.userTracks || []).map((t) => t.id).includes(tid), p.tracks[tid]?.voice, pk?.edited], [true, other, [`draft:${base}`]]);
    // Remove it; a new track with the same name must not inherit its drafts.
    await page.evaluate((id) => document.getElementById(`track-remove-${id}`)?.click(), tid);
    await settle(800);
    p = await P();
    check('Remove takes it out of the engine and the page', [(p.userTracks || []).length, await page.evaluate((id) => !!document.getElementById(`track-voice-${id}`), tid)], [0, false]);
    check('Add track again with the same name', await addTrack(), 'ok');
    p = await P();
    const tid2 = (p.userTracks || []).slice(-1)[0]?.id ?? null;
    check('…lands the same id', tid2, tid);
    pk = await picker(tid2);
    check('a new track of the same name starts clean: no Edited group, no stored patch', [pk?.edited, p.patches?.[tid2] ?? null], [[], null]);
    await reload();
    p = await P();
    pk = await picker(tid2);
    check('…and stays clean across a reload', [pk?.edited, p.patches?.[tid2] ?? null], [[], null]);
  }

  check('no console errors or page errors during the drive', errors, []);

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'voices-edges-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n'),
    );
  }
  return { passed: results.length };
}
