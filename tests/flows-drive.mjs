/**
 * The UI flows, walked in a real browser: the guided tour, every popover, the
 * shortcut sheet and its keys, Add track, the tabs, the ⓘ dock, the line under
 * the dials, pins and layouts, and a Tab-order sweep of both tabs.
 *
 *   npm run build && .vibe/measure.sh local drive tests/flows-drive.mjs
 *
 * What it holds, and why each is here rather than in page-boot:
 *
 *  - The tour's targets are checked VISIBLE at the moment their step shows,
 *    not merely present. tests/tutorial-smoke.mjs and page-boot resolve each
 *    selector to exactly one element, and both passed while step 6 rang
 *    `#play-along` — the Create POPOVER, hidden until its icon is pressed — so
 *    a first-time visitor saw the words "the orange piano icon" and a ring
 *    around nothing. A hidden element resolves; it does not show.
 *  - Esc on the ? button closes the tour it opened, the way Esc on an ⓘ
 *    closes the box it opened (v0.0.207). Opening the tour leaves focus on
 *    the ?; a keyboard user pressing Esc there got nothing.
 *  - Every popover: opens with focus inside, Esc closes and returns focus to
 *    its toggle, an outside press closes it, the toggle toggles.
 *  - The keys in the shortcut sheet each do what the sheet says, asserted at
 *    the ENGINE (a preset key changes the engine's tracks) or at the tab
 *    strip, and the sheet opens from ? and from a focused dial.
 *  - Add track: cancel, an empty name is refused with a reason, a melodic and
 *    a percussive track land IN THE ENGINE with a row and an editor each.
 *  - The line under the dials speaks inside the VISIBLE tab (v0.0.26x), and
 *    goes home when Simple is back — one element, never two.
 *  - A docked ⓘ box goes home on a tab change and on a narrowing (v0.0.273).
 *  - Tab order: every stop is visible (a visually hidden radio counts when its
 *    label is visible — that is the segmented control's own pattern), and
 *    every visible control is a stop.
 *
 * Console errors and page errors during the whole drive fail it.
 */

export default async function drive(page) {
  const results = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
  };
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + (e && e.message)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  // A fresh boot, so boot-time errors are seen too. about:blank first: a
  // same-URL goto is a same-document navigation and re-boots nothing.
  const url = page.url();
  await page.goto('about:blank');
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('#generator-app:not([hidden])', { timeout: 20000 });
  await page.click('#consent-slot button:has-text("Save on this device")').catch(() => {});
  await page.waitForTimeout(300);

  const activeTab = () => page.evaluate(() => document.querySelector('[role="tab"][aria-selected="true"]')?.id);
  const focusId = () => page.evaluate(() => document.activeElement?.id || '');

  // ---- 1. The guided tour ---------------------------------------------
  await page.click('#tutorial-toggle');
  await page.waitForTimeout(300);
  check('? opens the tour', await page.evaluate(() => !document.getElementById('tutorial-panel').hidden), true);
  for (let i = 0; i < 20; i++) {
    if (await page.evaluate(() => document.getElementById('tutorial-prev').disabled)) break;
    await page.click('#tutorial-prev');
    await page.waitForTimeout(100);
  }
  check('Back is disabled on step 1', await page.evaluate(() => document.getElementById('tutorial-prev').disabled), true);
  let steps = 0;
  for (let i = 0; i < 20; i++) {
    const st = await page.evaluate(() => {
      const hl = document.querySelector('.tutorial-highlight');
      const r = hl ? hl.getBoundingClientRect() : null;
      return {
        progress: document.getElementById('tutorial-progress').textContent,
        text: document.getElementById('tutorial-step-text').textContent.trim().length,
        tab: document.querySelector('[role="tab"][aria-selected="true"]')?.id,
        rings: document.querySelectorAll('.tutorial-highlight').length,
        hl: hl ? (hl.id || hl.className) : null,
        visible: hl ? (!hl.closest('[hidden]') && hl.offsetParent !== null && r.width > 0 && r.height > 0) : null,
        nextDisabled: document.getElementById('tutorial-next').disabled,
      };
    });
    steps += 1;
    check(`step ${st.progress} has copy`, st.text > 20, (v) => v === true);
    check(`step ${st.progress} rings at most one element`, st.rings <= 1, (v) => v === true);
    if (st.rings) check(`step ${st.progress} rings a VISIBLE element (${st.hl})`, st.visible, true);
    if (st.nextDisabled) break;
    await page.click('#tutorial-next');
    await page.waitForTimeout(250);
  }
  check('the tour has its steps', steps >= 8 && steps <= 14, (v) => v === true);
  check('the last step has no ring and Next is disabled', await page.evaluate(() => document.querySelectorAll('.tutorial-highlight').length === 0 && document.getElementById('tutorial-next').disabled), true);
  await page.click('#tutorial-prev');
  await page.waitForTimeout(200);
  check('Back from the last step rings again', await page.evaluate(() => document.querySelectorAll('.tutorial-highlight').length), 1);
  await page.click('#tutorial-close');
  await page.waitForTimeout(200);
  check('closing the tour leaves no panel, no ring, focus on ?', await page.evaluate(() => ({
    hidden: document.getElementById('tutorial-panel').hidden,
    rings: document.querySelectorAll('.tutorial-highlight').length,
    focus: document.activeElement?.id,
    expanded: document.getElementById('tutorial-toggle').getAttribute('aria-expanded'),
  })), { hidden: true, rings: 0, focus: 'tutorial-toggle', expanded: 'false' });
  // Esc inside the panel closes it.
  await page.click('#tutorial-toggle');
  await page.waitForTimeout(200);
  await page.focus('#tutorial-close');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check('Esc inside the tour closes it', await page.evaluate(() => document.getElementById('tutorial-panel').hidden), true);
  // Esc on the ? that opened it closes it too (focus is left there by the click).
  await page.click('#tutorial-toggle');
  await page.waitForTimeout(200);
  check('clicking ? leaves focus on ?', await focusId(), 'tutorial-toggle');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check('Esc on the ? closes the tour it opened', await page.evaluate(() => ({
    hidden: document.getElementById('tutorial-panel').hidden,
    expanded: document.getElementById('tutorial-toggle').getAttribute('aria-expanded'),
    rings: document.querySelectorAll('.tutorial-highlight').length,
  })), { hidden: true, expanded: 'false', rings: 0 });
  if (!(await page.evaluate(() => document.getElementById('tutorial-panel').hidden))) {
    await page.click('#tutorial-close');
    await page.waitForTimeout(200);
  }

  // ---- 2. Every popover -----------------------------------------------
  await page.click('#tab-simple');
  await page.waitForTimeout(200);
  for (const [tog, pop] of [['timers-toggle', 'timers-popover'], ['play-along-open', 'play-along'], ['genre-favourites-toggle', 'genre-favourites'], ['genre-rules-toggle', 'genre-rules']]) {
    const shown = await page.evaluate((id) => { const el = document.getElementById(id); return !!el && !el.closest('[hidden]') && el.offsetParent !== null; }, tog);
    if (!shown) { results.push({ name: `${pop}: toggle not shown (no genre in play?) — skipped`, ok: true }); continue; }
    await page.evaluate((id) => document.getElementById(id).scrollIntoView({ block: 'center' }), tog);
    await page.click('#' + tog);
    await page.waitForTimeout(250);
    check(`${pop} opens with focus inside`, await page.evaluate(({ p, t }) => ({
      hidden: document.getElementById(p).hidden,
      expanded: document.getElementById(t).getAttribute('aria-expanded'),
      inside: document.getElementById(p).contains(document.activeElement),
    }), { p: pop, t: tog }), { hidden: false, expanded: 'true', inside: true });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    check(`${pop}: Esc closes and returns focus`, await page.evaluate(({ p, t }) => ({
      hidden: document.getElementById(p).hidden,
      expanded: document.getElementById(t).getAttribute('aria-expanded'),
      focus: document.activeElement?.id,
    }), { p: pop, t: tog }), { hidden: true, expanded: 'false', focus: tog });
    await page.click('#' + tog);
    await page.waitForTimeout(250);
    await page.mouse.click(5, 5);
    await page.waitForTimeout(200);
    check(`${pop}: an outside press closes it`, await page.evaluate((p) => document.getElementById(p).hidden, pop), true);
    await page.click('#' + tog);
    await page.waitForTimeout(200);
    await page.click('#' + tog);
    await page.waitForTimeout(200);
    check(`${pop}: the toggle toggles`, await page.evaluate((p) => document.getElementById(p).hidden, pop), true);
  }

  // ---- 3. The shortcut sheet and its keys ------------------------------
  await page.focus('#toggle-play');
  await page.keyboard.press('?');
  await page.waitForTimeout(200);
  const sheet = await page.evaluate(() => ({
    open: !!document.getElementById('shortcut-sheet'),
    inside: !!document.getElementById('shortcut-sheet')?.contains(document.activeElement),
    keys: [...document.querySelectorAll('#shortcut-sheet dt')].map((d) => d.textContent),
  }));
  check('? opens the shortcut sheet with focus inside', sheet.open && sheet.inside, (v) => v === true);
  check('the sheet lists the number keys and the letter keys', sheet.keys.includes('1') && sheet.keys.includes('S  A') && sheet.keys.includes('P'), (v) => v === true);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check('Esc closes the sheet and returns focus', await page.evaluate(() => ({ open: !!document.getElementById('shortcut-sheet'), focus: document.activeElement?.id })), { open: false, focus: 'toggle-play' });
  await page.evaluate(() => document.querySelector('#panel-simple .knob')?.focus());
  await page.keyboard.press('?');
  await page.waitForTimeout(200);
  check('? works from a focused dial', await page.evaluate(() => !!document.getElementById('shortcut-sheet')), true);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  await page.focus('#toggle-play');
  await page.keyboard.press('a');
  await page.waitForTimeout(200);
  check('A switches to Advanced', await activeTab(), 'tab-advanced');
  await page.keyboard.press('s');
  await page.waitForTimeout(200);
  check('S switches to Simple', await activeTab(), 'tab-simple');
  const engineTracks = () => page.evaluate(() => JSON.stringify(window.__ambi4Engine.getParams().tracks));
  const beforeOne = await engineTracks();
  await page.keyboard.press('1');
  await page.waitForTimeout(700);
  const afterOne = await page.evaluate(() => ({ say: document.getElementById('dial-confirm').textContent }));
  check('1 loads the first slot into the ENGINE', (await engineTracks()) !== beforeOne, (v) => v === true);
  check('…and says which', afterOne.say.length > 0, (v) => v === true);
  const beforeStep = await engineTracks();
  await page.keyboard.press(']');
  await page.waitForTimeout(700);
  check('] steps to the next genre or preset in the ENGINE', (await engineTracks()) !== beforeStep, (v) => v === true);
  // P pins the focused dial; P again unpins it.
  await page.evaluate(() => [...document.querySelectorAll('#panel-simple .knob')].find((el) => el.getAttribute('aria-label') === 'Tempo')?.focus());
  await page.keyboard.press('p');
  await page.waitForTimeout(300);
  check('P pins the focused dial to the strip', await page.evaluate(() => ({ strip: !document.getElementById('pinned-strip').hidden, mirrors: document.querySelectorAll('#pinned-row .knob').length, stored: window.__ambi4Layout.pins.length })), { strip: true, mirrors: 1, stored: 1 });
  // A pin is a second view: the mirror's value is the dial's.
  await page.keyboard.press('p');
  await page.waitForTimeout(300);
  check('P again unpins it', await page.evaluate(() => ({ mirrors: document.querySelectorAll('#pinned-row .knob').length, stored: window.__ambi4Layout.pins.length })), { mirrors: 0, stored: 0 });

  // ---- 4. Layouts -------------------------------------------------------
  await page.evaluate(() => [...document.querySelectorAll('#panel-simple .knob')].find((el) => el.getAttribute('aria-label') === 'Tempo')?.focus());
  await page.keyboard.press('p');
  await page.waitForTimeout(300);
  await page.click('#pinned-more');
  await page.fill('#layout-name', 'Flows layout');
  await page.click('#layout-save');
  await page.waitForTimeout(300);
  check('Save layout stores it and lists it', await page.evaluate(() => ({ stored: Object.keys(window.__ambi4Layout.saved), shown: document.getElementById('layout-select').value, forget: !document.getElementById('layout-forget').hidden })), { stored: ['Flows layout'], shown: 'Flows layout', forget: true });
  await page.evaluate(() => document.querySelector('#pinned-row .knob')?.focus());
  await page.keyboard.press('p');
  await page.waitForTimeout(300);
  check('unpinning leaves the strip for its layouts', await page.evaluate(() => ({ pins: window.__ambi4Layout.pins.length, strip: !document.getElementById('pinned-strip').hidden })), { pins: 0, strip: true });
  if (await page.evaluate(() => document.getElementById('pinned-layouts').hidden)) await page.click('#pinned-more');
  await page.selectOption('#layout-select', 'Flows layout');
  await page.waitForTimeout(400);
  check('recalling the layout brings the pin back', await page.evaluate(() => ({ pins: window.__ambi4Layout.pins.length, mirrors: document.querySelectorAll('#pinned-row .knob').length })), { pins: 1, mirrors: 1 });
  await page.click('#layout-forget');
  await page.waitForTimeout(300);
  check('Forget drops it', await page.evaluate(() => ({ stored: Object.keys(window.__ambi4Layout.saved), disabled: document.getElementById('layout-select').disabled })), { stored: [], disabled: true });
  await page.evaluate(() => document.querySelector('#pinned-row .knob')?.focus());
  await page.keyboard.press('p');
  await page.waitForTimeout(300);

  // ---- 5. Tabs by keyboard ---------------------------------------------
  await page.focus('#tab-simple');
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(200);
  check('ArrowRight on the tab strip activates and focuses Advanced', await page.evaluate(() => ({ sel: document.querySelector('[role="tab"][aria-selected="true"]')?.id, focus: document.activeElement?.id, simpleHidden: document.getElementById('panel-simple').hidden, advHidden: document.getElementById('panel-advanced').hidden })), { sel: 'tab-advanced', focus: 'tab-advanced', simpleHidden: true, advHidden: false });
  await page.keyboard.press('Home');
  await page.waitForTimeout(200);
  check('Home goes to Simple', await activeTab(), 'tab-simple');
  check('only the active tab is in the Tab order', await page.evaluate(() => [...document.querySelectorAll('[role="tab"]')].map((t) => t.tabIndex)), [0, -1]);

  // ---- 6. The line under the dials follows the visible tab -------------
  await page.click('#tab-advanced');
  await page.waitForTimeout(200);
  await page.click('#voice-edit-toggle-pad');
  await page.waitForTimeout(400);
  await page.evaluate(() => document.querySelector('#voice-editor-pad .knob')?.focus());
  await page.keyboard.press('Control+Shift+z');
  await page.waitForTimeout(200);
  check('a refusal on Advanced is written INTO the visible panel, by the section touched', await page.evaluate(() => {
    const el = document.getElementById('dial-confirm');
    return { said: el.textContent, inVisible: document.querySelector('[role="tabpanel"]:not([hidden])').contains(el), after: el.previousElementSibling?.id, tall: el.getBoundingClientRect().height > 0 };
  }), { said: 'Nothing to redo.', inVisible: true, after: 'voice-editor-pad', tall: true });
  await page.click('#voice-edit-toggle-pad');
  await page.click('#tab-simple');
  await page.waitForTimeout(200);
  await page.evaluate(() => document.body.focus());
  await page.keyboard.press('Control+Shift+z');
  await page.waitForTimeout(200);
  check('…and goes home under the Simple dials, one element', await page.evaluate(() => {
    const el = document.getElementById('dial-confirm');
    return { home: el.parentElement?.classList.contains('sliders-module'), count: document.querySelectorAll('#dial-confirm').length };
  }), { home: true, count: 1 });

  // ---- 7. Add track -----------------------------------------------------
  await page.click('#tab-advanced');
  await page.waitForTimeout(200);
  await page.evaluate(() => document.getElementById('add-track')?.scrollIntoView({ block: 'center' }));
  await page.click('#add-track');
  await page.waitForTimeout(200);
  check('Add track opens its form with the name focused', await page.evaluate(() => ({ hidden: document.getElementById('add-track-form').hidden, focus: document.activeElement?.id, expanded: document.getElementById('add-track').getAttribute('aria-expanded') })), { hidden: false, focus: 'add-track-name', expanded: 'true' });
  await page.click('#add-track-form button:has-text("Cancel")');
  await page.waitForTimeout(200);
  check('Cancel closes it and returns focus', await page.evaluate(() => ({ hidden: document.getElementById('add-track-form').hidden, focus: document.activeElement?.id })), { hidden: true, focus: 'add-track' });
  const tracksBefore = await page.evaluate(() => Object.keys(window.__ambi4Engine.getParams().tracks));
  await page.click('#add-track');
  await page.fill('#add-track-name', '   ');
  await page.click('#add-track-form button:has-text("Create")');
  await page.waitForTimeout(300);
  check('an empty name is refused with a reason, nothing added', await page.evaluate((before) => ({ err: document.getElementById('add-track-error').textContent, open: !document.getElementById('add-track-form').hidden, added: Object.keys(window.__ambi4Engine.getParams().tracks).length - before.length }), tracksBefore), { err: 'Give the track a name.', open: true, added: 0 });
  await page.fill('#add-track-name', 'Flows melodic');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  const melodic = await page.evaluate((before) => {
    const t = window.__ambi4Engine.getParams().tracks;
    const added = Object.keys(t).filter((k) => !before.includes(k));
    const id = added[0];
    return { count: added.length, row: !!document.querySelector(`.track-row[data-track="${id}"]`), edit: !!document.getElementById(`voice-edit-toggle-${id}`), voice: typeof t[id]?.voice === 'string' && t[id].voice.length > 0, formHidden: document.getElementById('add-track-form').hidden, focus: document.activeElement?.id === `track-lamp-${id}`, id };
  }, tracksBefore);
  check('Enter creates a melodic track IN THE ENGINE with a row, an Edit and a voice', { count: melodic.count, row: melodic.row, edit: melodic.edit, voice: melodic.voice, formHidden: melodic.formHidden, focus: melodic.focus }, { count: 1, row: true, edit: true, voice: true, formHidden: true, focus: true });
  await page.click('#add-track');
  await page.fill('#add-track-name', 'Flows perc');
  await page.check('#add-track-form input[value="percussive"]');
  await page.click('#add-track-form button:has-text("Create")');
  await page.waitForTimeout(500);
  const perc = await page.evaluate((before) => {
    const t = window.__ambi4Engine.getParams().tracks;
    const added = Object.keys(t).filter((k) => !before.includes(k));
    const id = added[1];
    return { count: added.length, lanes: Array.isArray(t[id]?.lanes) && t[id].lanes.length > 0, id, note: document.getElementById('add-track-note').textContent };
  }, tracksBefore);
  check('a percussive track lands with kit lanes', { count: perc.count, lanes: perc.lanes }, { count: 2, lanes: true });
  check('the note counts down', /4 of your own left/.test(perc.note), (v) => v === true);
  await page.click(`#voice-edit-toggle-${perc.id}`);
  await page.waitForTimeout(400);
  check('its editor opens with dials', await page.evaluate((id) => { const ed = document.getElementById(`voice-editor-${id}`); return !!ed && !ed.hidden && ed.querySelectorAll('.knob').length > 0; }, perc.id), true);
  await page.click(`#voice-edit-toggle-${perc.id}`);
  await page.waitForTimeout(200);

  // ---- 8. The ⓘ dock lets go on a tab change and a narrowing -----------
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.waitForTimeout(300);
  await page.click('#tab-advanced');
  await page.waitForTimeout(200);
  const infoBtn = await page.evaluate(() => {
    const b = [...document.querySelectorAll('#panel-advanced .info-button')].find((x) => x.offsetParent !== null);
    if (!b) return null;
    b.scrollIntoView({ block: 'center' });
    if (!b.id) b.id = 'flows-info-btn';
    return '#' + b.id;
  });
  check('Advanced has an ⓘ to dock', !!infoBtn, (v) => v === true);
  if (infoBtn) {
    const dockState = () => page.evaluate(() => ({ shown: !document.getElementById('tutorial-panel').hidden, info: document.getElementById('tutorial-panel').classList.contains('info-mode'), boxes: document.getElementById('tutorial-info-slot').children.length }));
    await page.click(infoBtn);
    await page.waitForTimeout(300);
    check('at 1400px an ⓘ docks in the panel', await dockState(), { shown: true, info: true, boxes: 1 });
    await page.click('#tab-simple');
    await page.waitForTimeout(300);
    check('a tab change releases the dock', await dockState(), { shown: false, info: false, boxes: 0 });
    await page.click('#tab-advanced');
    await page.waitForTimeout(200);
    await page.click(infoBtn);
    await page.waitForTimeout(300);
    check('…it docks again', (await dockState()).info, true);
    await page.setViewportSize({ width: 900, height: 900 });
    await page.waitForTimeout(400);
    check('narrowing past the dock width releases it', await dockState(), { shown: false, info: false, boxes: 0 });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(300);
  }

  // ---- 9. Tab order, both tabs -----------------------------------------
  const sweepTab = async (tabId) => {
    await page.click('#' + tabId);
    await page.waitForTimeout(300);
    await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector('a.site-title')?.focus(); });
    const seen = [];
    const faults = [];
    const readActive = () => page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return { body: true };
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const keyOf = (e) => (e.id ? '#' + e.id : e.tagName.toLowerCase() + '.' + String(e.className).split(' ').slice(0, 2).join('.')) + '|' + (e.getAttribute('aria-label') || e.textContent.trim().slice(0, 20));
      let clipped = false;
      for (let a = el.parentElement; a; a = a.parentElement) {
        const acs = getComputedStyle(a);
        if (acs.overflow === 'hidden' || acs.overflowX === 'hidden' || acs.overflowY === 'hidden') {
          const ar = a.getBoundingClientRect();
          if (r.right <= ar.left || r.left >= ar.right || r.bottom <= ar.top || r.top >= ar.bottom) { clipped = true; break; }
        }
      }
      // A radio hidden under its visible label is the segmented control's
      // pattern (focus-visible paints the label); the LABEL has to be shown.
      let labelShown = false;
      if (el.tagName === 'INPUT' && (el.type === 'radio' || el.type === 'checkbox')) {
        const label = (el.id && document.querySelector(`label[for="${el.id}"]`)) || el.closest('label') || (el.nextElementSibling?.tagName === 'LABEL' ? el.nextElementSibling : null);
        if (label) { const lr = label.getBoundingClientRect(); labelShown = lr.width > 0 && lr.height > 0 && +getComputedStyle(label).opacity > 0; }
      }
      const invisible = r.width === 0 || r.height === 0 || +cs.opacity === 0 || cs.visibility === 'hidden';
      return { key: keyOf(el), invisible, labelShown, clipped, hiddenAnc: !!el.closest('[hidden]'), offTop: r.top + window.scrollY < -50, offSide: r.left < -100 || r.left > window.innerWidth };
    });
    let info = await readActive();
    for (let i = 0; i < 1200 && !info.body; i++) {
      seen.push(info.key);
      if ((info.invisible && !info.labelShown) || info.clipped || info.hiddenAnc || info.offTop || info.offSide) faults.push(info);
      await page.keyboard.press('Tab');
      info = await readActive();
    }
    const unreached = await page.evaluate((seenKeys) => {
      const set = new Set(seenKeys);
      const out = [];
      for (const el of document.querySelectorAll('button, [href], input, select, textarea, [tabindex]')) {
        if (el.disabled || el.closest('[hidden]') || el.tabIndex < 0) continue;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        if (r.width === 0 || r.height === 0 || cs.visibility === 'hidden' || +cs.opacity === 0) continue;
        const key = (el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + String(el.className).split(' ').slice(0, 2).join('.')) + '|' + (el.getAttribute('aria-label') || el.textContent.trim().slice(0, 20));
        if (!set.has(key)) out.push(key);
      }
      return out;
    }, seen);
    return { stops: seen.length, faults, unreached };
  };
  for (const tab of ['tab-simple', 'tab-advanced']) {
    const sweep = await sweepTab(tab);
    check(`${tab}: Tab reaches controls`, sweep.stops > 20, (v) => v === true);
    check(`${tab}: no Tab stop is invisible, clipped or off the page`, sweep.faults.map((f) => f.key), []);
    check(`${tab}: every visible control is a Tab stop`, sweep.unreached, []);
  }

  check('no console errors or page errors during the drive', errors, []);

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'flows-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n'),
    );
  }
  return { passed: results.length };
}
