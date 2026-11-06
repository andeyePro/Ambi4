/**
 * The whole app without a mouse, in a real browser, asserted at the ENGINE.
 *
 *   npm run build && .vibe/measure.sh local drive tests/keyboard-only-drive.mjs
 *
 * tests/flows-drive.mjs already sweeps the Tab ORDER and the shortcut sheet's
 * keys; this drive COMPLETES each flow by keyboard alone — page.keyboard only,
 * selects set the way a keyboard sets them — and after every action asks the
 * one question a Tab-order sweep cannot: where is focus NOW? Each of these was
 * found by that question (2026-10-30, browser bug hunt):
 *
 *  - Play by Enter: the button disabled itself while the engine started, and
 *    a disabled button drops focus to body — so the Space that should have
 *    been Finish did nothing.
 *  - A typed dial value (Enter on the readout, type, Enter) removed the input
 *    and left focus on body; so did Escape.
 *  - Enter in the chord-loop box rebuilt the box and left focus on body.
 *  - Forget layout hid itself under the focus.
 *  - Full screen moved the module under the focused ⛶ (focus to body), left
 *    Exit focusable at opacity 0 once the bar had slid away, and put focus on
 *    body again on exit.
 *  - Escape in the Add track form closed nothing; Enter in the preset-name and
 *    layout-name boxes saved nothing (Add track's own name box, and the genre
 *    rules' name box, both take Enter).
 *
 * Console errors and page errors during the drive fail it.
 *
 * Runs three times: the harness's Chromium, then Firefox and WebKit (see
 * ENGINES at the foot).
 */

async function driveIn(page, { TAB = 'Tab', label = '' } = {}) {
  const results = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name: label + name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
    return ok;
  };
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + (e && e.message)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });

  const navs = [];
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) navs.push(f.url().slice(0, 80)); });
  const url = page.url();
  try {
    await run();
  } catch (err) {
    const failedSoFar = results.filter((r) => !r.ok).map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n');
    throw new Error(`${err && err.message} — after check "${results[results.length - 1]?.name}", navigations: ${JSON.stringify(navs)}\nfailed so far:\n${failedSoFar}`);
  }
  async function run() {
  await page.goto('about:blank');
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('#generator-app:not([hidden])', { timeout: 20000 });
  await page.click('#consent-slot button:has-text("Save on this device")').catch(() => {});
  await page.waitForTimeout(300);
  // A fresh visit draws a RANDOM genre: pin the first listed one.
  await page.evaluate(() => {
    const s = document.getElementById('genre-select');
    if (s && s.options.length > 1) { s.value = s.options[1].value; s.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await page.waitForTimeout(600);

  const focusId = () => page.evaluate(() => (document.activeElement && document.activeElement !== document.body ? (document.activeElement.id || document.activeElement.className || document.activeElement.tagName) : 'BODY'));
  const focusEl = (sel) => page.evaluate((s) => { const el = document.querySelector(s); if (!el) return false; el.scrollIntoView({ block: 'center' }); el.focus(); return document.activeElement === el; }, sel);
  const openFoldFor = async (selector) => {
    const more = await page.evaluate((s) => (typeof window.__ambi4FoldMore === 'function' ? window.__ambi4FoldMore(s) : null), selector);
    if (more) { await page.click(more); await page.waitForTimeout(150); }
  };
  const params = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__ambi4Engine.getParams())));
  const bpm = async () => (await params()).bpm;
  const activeTab = () => page.evaluate(() => document.querySelector('[role="tab"][aria-selected="true"]')?.id);
  const tabTo = async (predicateSrc, limit = 120) => {
    for (let i = 0; i < limit; i++) {
      await page.keyboard.press(TAB);
      if (await page.evaluate(predicateSrc)) return i + 1;
    }
    return -1;
  };

  // ---- 1. Transport: Play, Pause, Resume, Finish, Stop ------------------
  check('Play is focusable', await focusEl('#toggle-play'), true);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(900);
  check('Enter on Play starts the ENGINE', await page.evaluate(() => window.__ambi4Engine.running), true);
  check('…and focus stays on the Play key (it disabled itself while starting)', await focusId(), 'toggle-play');
  await page.keyboard.press(' ');
  await page.waitForTimeout(400);
  check('Space on the same key, unmoved, is Finish (the label reads Stop)', await page.evaluate(() => document.querySelector('.play-toggle-label').textContent.trim()), 'Stop');
  await page.keyboard.press(' ');
  await page.waitForTimeout(900);
  check('Space again stops the ENGINE', await page.evaluate(() => ({ running: window.__ambi4Engine.running, label: document.querySelector('.play-toggle-label').textContent.trim(), focus: document.activeElement?.id })), { running: false, label: 'Play', focus: 'toggle-play' });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(900);
  await focusEl('#pause-toggle');
  await page.keyboard.press(' ');
  await page.waitForTimeout(400);
  check('Space on Pause pauses', await page.evaluate(() => ({ pressed: document.getElementById('pause-toggle').getAttribute('aria-pressed'), paused: !!window.__ambi4Engine.paused, focus: document.activeElement?.id })), { pressed: 'true', paused: true, focus: 'pause-toggle' });
  await page.keyboard.press(' ');
  await page.waitForTimeout(400);
  check('Space again resumes', await page.evaluate(() => ({ pressed: document.getElementById('pause-toggle').getAttribute('aria-pressed'), running: window.__ambi4Engine.running })), { pressed: 'false', running: true });
  await page.evaluate(() => window.__ambi4Engine.stop());
  await page.waitForTimeout(600);

  // ---- 2. A main dial by keys, and a typed value through the readout -----
  const focusTempo = () => page.evaluate(() => { const k = [...document.querySelectorAll('#panel-simple .knob')].find((el) => el.getAttribute('aria-label') === 'Tempo'); if (!k) return false; k.scrollIntoView({ block: 'center' }); k.focus(); return document.activeElement === k; });
  check('the Simple Tempo dial is focusable', await focusTempo(), true);
  const bpm0 = await bpm();
  await page.keyboard.press('PageUp');
  await page.waitForTimeout(250);
  check('PageUp raises the ENGINE tempo', (await bpm()) > bpm0, (v) => v === true);
  await page.keyboard.press('End');
  await page.waitForTimeout(250);
  check('End is the top of the range at the ENGINE', await bpm(), 220);
  await page.keyboard.press('Home');
  await page.waitForTimeout(250);
  check('Home is the bottom', await bpm(), 20);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(250);
  check('Backspace is the default, focus still on the dial', { bpm: await bpm(), focus: await page.evaluate(() => document.activeElement?.getAttribute('aria-label')) }, { bpm: 60, focus: 'Tempo' });
  await page.keyboard.press(TAB);
  check('Tab from the dial lands on its readout button', await page.evaluate(() => document.activeElement?.classList.contains('knob-value')), true);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  check('Enter on the readout opens the typed box, selected', await page.evaluate(() => { const el = document.activeElement; return { edit: el.classList.contains('knob-value-edit'), selected: el.selectionEnd > el.selectionStart }; }), { edit: true, selected: true });
  await page.keyboard.type('95');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  check('a typed value reaches the ENGINE', await bpm(), 95);
  check('…and Enter hands focus back to the readout, not body', await page.evaluate(() => document.activeElement?.classList.contains('knob-value') && document.activeElement.closest('.knob')?.getAttribute('aria-label') === 'Tempo'), true);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  const tracksBefore = await page.evaluate(() => JSON.stringify(window.__ambi4Engine.getParams().tracks));
  await page.keyboard.type('s1a');
  await page.waitForTimeout(300);
  check('letters typed into the box are typing, not shortcuts', { tab: await activeTab(), tracksMoved: (await page.evaluate(() => JSON.stringify(window.__ambi4Engine.getParams().tracks))) !== tracksBefore, value: await page.evaluate(() => document.activeElement?.value) }, { tab: 'tab-simple', tracksMoved: false, value: 's1a' });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check('Escape cancels the typing, keeps the value, returns to the readout', { bpm: await bpm(), onReadout: await page.evaluate(() => document.activeElement?.classList.contains('knob-value')) }, { bpm: 95, onReadout: true });

  // ---- 3. Every editor: Enter opens, Tab enters, Escape closes and returns --
  await page.click('#tab-advanced');
  await page.waitForTimeout(300);
  const toggles = await page.evaluate(() => [...document.querySelectorAll('[id^="voice-edit-toggle-"]')].filter((b) => !b.closest('[hidden]')).map((b) => b.id));
  check('the Advanced tab lists editors', toggles.length >= 5, (v) => v === true);
  for (const id of toggles) {
    const track = id.slice('voice-edit-toggle-'.length);
    await focusEl('#' + id);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(450);
    await page.keyboard.press(TAB);
    const opened = await page.evaluate((t) => { const ed = document.getElementById('voice-editor-' + t); return { shown: !!ed && !ed.hidden, inside: !!ed && ed.contains(document.activeElement) }; }, track);
    check(`${track}: Enter opens the editor and Tab enters it`, opened, { shown: true, inside: true });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    check(`${track}: Escape closes it and returns focus to Edit`, await page.evaluate((t) => ({ hidden: !!document.getElementById('voice-editor-' + t)?.hidden, focus: document.activeElement?.id }), track), { hidden: true, focus: id });
  }
  // An editor dial by arrows, at the engine.
  await focusEl('#voice-edit-toggle-pad');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(450);
  const padBefore = JSON.stringify((await params()).tracks.pad);
  check('the pad editor has a focusable dial', await page.evaluate(() => { const k = document.querySelector('#voice-editor-pad .knob'); if (!k) return false; k.scrollIntoView({ block: 'center' }); k.focus(); return document.activeElement === k; }), true);
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(300);
  check('ArrowUp on an editor dial moves the ENGINE', JSON.stringify((await params()).tracks.pad) !== padBefore, (v) => v === true);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(200);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // ---- 4. The chord-loop box ---------------------------------------------
  await openFoldFor('#progression-row');
  check('the chord-loop box is focusable', await focusEl('.progression-input'), true);
  await page.keyboard.press('Meta+a');
  await page.keyboard.press('Control+a');
  await page.evaluate(() => document.activeElement.select());
  await page.keyboard.type('i VI III VII');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  check('Enter commits the loop to the ENGINE', await page.evaluate(() => (window.__ambi4Engine.getParams().harmony?.seed || []).length), 4);
  check('…and focus stays in the (rebuilt) box', await page.evaluate(() => document.activeElement?.classList.contains('progression-input')), true);
  const tracksBefore2 = await page.evaluate(() => JSON.stringify(window.__ambi4Engine.getParams().tracks));
  await page.keyboard.press('End');
  await page.keyboard.type(' s1');
  await page.waitForTimeout(200);
  check('typing in the box fires no shortcut', { tab: await activeTab(), tracksMoved: (await page.evaluate(() => JSON.stringify(window.__ambi4Engine.getParams().tracks))) !== tracksBefore2 }, { tab: 'tab-advanced', tracksMoved: false });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check('Escape puts the playing loop back in the box', await page.evaluate(() => /^i vi iii vii$/i.test(document.querySelector('.progression-input')?.value || '')), true);
  check('the box is focusable again after Escape', await focusEl('.progression-input'), true);
  await page.keyboard.press(TAB);
  // Enter is pressed ONLY on the button: on a missed Tab it would follow
  // whatever link had focus and navigate the page away.
  if (check('Tab reaches "Let the app choose"', await page.evaluate(() => document.activeElement?.classList.contains('progression-clear')), true)) {
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    check('Enter on it hands the loop back at the ENGINE, focus in the box', { seed: await page.evaluate(() => window.__ambi4Engine.getParams().harmony?.seed ?? null), focusInBox: await page.evaluate(() => document.activeElement?.classList.contains('progression-input')) }, { seed: null, focusInBox: true });
  }

  // ---- 5. Structure ----------------------------------------------------
  // (Re-pinned: on a build where the chord-loop box drops focus, the letters
  // above went to the document as shortcuts and the tab is no longer this one.)
  if ((await activeTab()) !== 'tab-advanced') { await page.click('#tab-advanced'); await page.waitForTimeout(300); }
  await openFoldFor('#structure');
  await focusEl('#structure');
  await page.selectOption('#structure', 'custom');
  await page.waitForTimeout(400);
  check('custom structure shows blocks with keyboard-reachable track lamps', await page.evaluate(() => ({ blocks: document.querySelectorAll('.structure-block').length > 0, lamp: (document.querySelector('.structure-block .block-track')?.tabIndex ?? -1) >= 0 })), { blocks: true, lamp: true });
  await focusEl('.structure-block .block-track');
  const lamp0 = await page.evaluate(() => document.querySelector('.structure-block .block-track')?.dataset.state);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  check('Enter cycles a block lamp and keeps focus on it', await page.evaluate((s0) => ({ moved: document.querySelector('.structure-block .block-track')?.dataset.state !== s0, focus: document.activeElement?.classList.contains('block-track') }), lamp0), { moved: true, focus: true });
  const blocks0 = await page.evaluate(() => document.querySelectorAll('.structure-block').length);
  await focusEl('#add-structure-block');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  check('Enter on Add block adds one, focus kept', { added: (await page.evaluate(() => document.querySelectorAll('.structure-block').length)) - blocks0, focus: await focusId() }, { added: 1, focus: 'add-structure-block' });
  await page.selectOption('#structure', await page.evaluate(() => document.querySelector('#structure option:not([value="custom"])')?.value));
  await page.waitForTimeout(300);

  // ---- 6. The sequencer grid ---------------------------------------------
  await focusEl('#voice-edit-toggle-bass');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  const hops = await tabTo(() => document.activeElement?.classList.contains('seq-cell') && !!document.activeElement.closest('#voice-editor-bass'), 80);
  check('Tab reaches the bass grid from its Edit', hops > 0, (v) => v === true);
  const idx = await page.evaluate(() => [...document.querySelectorAll('#voice-editor-bass .seq-cell')].indexOf(document.activeElement));
  const on0 = await page.evaluate((i) => window.__ambi4Engine.getParams().tracks.bass.sequencer.steps[i]?.on, idx);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  check('Enter toggles the step at the ENGINE, focus kept on the cell', await page.evaluate((i) => ({ on: window.__ambi4Engine.getParams().tracks.bass.sequencer.steps[i]?.on, onCell: document.activeElement?.classList.contains('seq-cell') }), idx), { on: !on0, onCell: true });
  await page.keyboard.press('ArrowRight');
  const idx2 = await page.evaluate(() => [...document.querySelectorAll('#voice-editor-bass .seq-cell')].indexOf(document.activeElement));
  check('ArrowRight moves to the next step', idx2, idx + 1);
  await page.keyboard.press('p');
  await page.waitForTimeout(200);
  check('P opens the note box (and pins no dial)', await page.evaluate(() => ({ box: document.activeElement?.classList.contains('seq-pitch-input'), pins: window.__ambi4Layout.pins.length })), { box: true, pins: 0 });
  await page.keyboard.type('D4');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  check('the typed note lands at the ENGINE and focus returns to the cell', await page.evaluate((i) => ({ midi: window.__ambi4Engine.getParams().tracks.bass.sequencer.steps[i]?.midi, onCell: document.activeElement?.classList.contains('seq-cell') }), idx2), { midi: 62, onCell: true });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check('Escape from a cell closes the editor onto its Edit', await page.evaluate(() => ({ hidden: document.getElementById('voice-editor-bass').hidden, focus: document.activeElement?.id })), { hidden: true, focus: 'voice-edit-toggle-bass' });

  // ---- 7. Create: doors, words, Blank slate, Escape ----------------------
  await focusEl('#play-along-open');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  check('Enter opens Create with focus inside', await page.evaluate(() => !document.getElementById('play-along').hidden && document.getElementById('play-along').contains(document.activeElement)), true);
  const firstStop = await focusId();
  let wrapped = false;
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press(TAB);
    const inside = await page.evaluate(() => document.getElementById('play-along').contains(document.activeElement));
    if (!inside) break;
    if ((await focusId()) === firstStop) { wrapped = true; break; }
  }
  check('Tab cycles inside Create and never leaks out', wrapped, true);
  await focusEl('#create-write');
  await page.selectOption('#create-write', 'words');
  await page.waitForTimeout(400);
  check('the Words door opens its box, focus still on the door', await page.evaluate(() => { const t = document.getElementById('compose-words-text'); return { shown: !!t && !t.closest('[hidden]') && t.offsetParent !== null, focus: document.activeElement?.id }; }), { shown: true, focus: 'create-write' });
  await focusEl('#compose-words-text');
  await page.keyboard.type('sa la la 1 ? p');
  await page.waitForTimeout(200);
  check('typing words fires no shortcut', { tab: await activeTab(), sheet: await page.evaluate(() => !!document.getElementById('shortcut-sheet')), value: await page.evaluate(() => document.getElementById('compose-words-text').value) }, { tab: 'tab-advanced', sheet: false, value: 'sa la la 1 ? p' });
  const melodyBefore = await page.evaluate(() => JSON.stringify(window.__ambi4Engine.getParams().tracks.melody));
  await focusEl('#compose-words-write');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(900);
  check('Enter on Sing it writes the words into the ENGINE, focus kept', { changed: (await page.evaluate(() => JSON.stringify(window.__ambi4Engine.getParams().tracks.melody))) !== melodyBefore, focus: await focusId() }, { changed: true, focus: 'compose-words-write' });
  await focusEl('#create-blank');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
  check('Enter on Blank slate turns every track off at the ENGINE, focus kept', { allOff: await page.evaluate(() => Object.values(window.__ambi4Engine.getParams().tracks).every((t) => t.state === 'off')), focus: await focusId() }, { allOff: true, focus: 'create-blank' });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check('Escape closes Create onto its button', await page.evaluate(() => ({ hidden: document.getElementById('play-along').hidden, focus: document.activeElement?.id })), { hidden: true, focus: 'play-along-open' });

  // ---- 8. Add track ------------------------------------------------------
  await focusEl('#add-track');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
  check('Enter on Add track opens the form with focus in its name box', await page.evaluate(() => ({ hidden: document.getElementById('add-track-form').hidden, focus: document.activeElement?.id })), { hidden: false, focus: 'add-track-name' });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  check('Escape closes the Add track form onto its button', await page.evaluate(() => ({ hidden: document.getElementById('add-track-form').hidden, focus: document.activeElement?.id })), { hidden: true, focus: 'add-track' });
  if (!(await page.evaluate(() => document.getElementById('add-track-form').hidden))) await page.click('#add-track-form button:has-text("Cancel")');
  await focusEl('#add-track');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  check('Escape in the form closes it', await page.evaluate(() => ({ hidden: document.getElementById('add-track-form').hidden, focus: document.activeElement?.id })), { hidden: true, focus: 'add-track' });
  if (!(await page.evaluate(() => document.getElementById('add-track-form').hidden))) await page.click('#add-track-form button:has-text("Cancel")');
  await focusEl('#add-track');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
  await page.keyboard.type('Keys track');
  await page.keyboard.press(TAB);
  await page.keyboard.press('ArrowRight');
  const before = await page.evaluate(() => Object.keys(window.__ambi4Engine.getParams().tracks));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
  const made = await page.evaluate((b) => { const t = window.__ambi4Engine.getParams().tracks; const added = Object.keys(t).filter((k) => !b.includes(k)); return { added: added.length, lanes: Array.isArray(t[added[0]]?.lanes), focus: document.activeElement?.id === `track-lamp-${added[0]}` }; }, before);
  check('name, Tab, ArrowRight to percussive, Enter: a kit track lands in the ENGINE with focus on its lamp', made, { added: 1, lanes: true, focus: true });

  // ---- 9. Presets and the share link -------------------------------------
  await openFoldFor('#preset-save');
  await focusEl('#preset-name');
  await page.keyboard.type('Keys preset');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  check('Enter in the preset-name box saves, as Add track\'s name box does', await page.evaluate(() => [...document.querySelectorAll('#preset-load option')].some((o) => o.textContent === 'Keys preset')), true);
  await page.evaluate(() => { document.getElementById('preset-name').value = 'Keys preset'; });
  await focusEl('#preset-save');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  check('Enter on Save keeps one entry and focus', { count: await page.evaluate(() => [...document.querySelectorAll('#preset-load option')].filter((o) => o.textContent === 'Keys preset').length), focus: await focusId() }, { count: 1, focus: 'preset-save' });
  const savedBpm = await bpm();
  await page.evaluate(() => window.__ambi4Engine.setParams({ bpm: 61 }));
  await focusEl('#preset-load');
  await page.selectOption('#preset-load', await page.evaluate(() => [...document.querySelectorAll('#preset-load option')].find((o) => o.textContent === 'Keys preset')?.value));
  await page.waitForTimeout(600);
  check('choosing it in the list loads the ENGINE, focus on the list', { bpm: await bpm(), focus: await focusId() }, { bpm: savedBpm, focus: 'preset-load' });
  await focusEl('#preset-delete');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  check('Enter on Delete removes it, focus kept', { gone: await page.evaluate(() => ![...document.querySelectorAll('#preset-load option')].some((o) => o.textContent === 'Keys preset')), focus: await focusId() }, { gone: true, focus: 'preset-delete' });
  await page.evaluate(() => { window.__copied = null; navigator.clipboard.writeText = (t) => { window.__copied = t; return Promise.resolve(); }; });
  await openFoldFor('#preset-share');
  await focusEl('#preset-share');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(700);
  check('Enter on Share mints a link, focus kept', { link: await page.evaluate(() => typeof window.__copied === 'string' && /#/.test(window.__copied)), focus: await focusId() }, { link: true, focus: 'preset-share' });

  // ---- 10. The tour --------------------------------------------------------
  await page.click('#tab-simple');
  await page.waitForTimeout(200);
  await focusEl('#tutorial-toggle');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  const p0 = await page.evaluate(() => document.getElementById('tutorial-progress').textContent);
  await focusEl('#tutorial-next');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  check('Enter opens the tour, Enter on Next advances it, focus kept', { open: await page.evaluate(() => !document.getElementById('tutorial-panel').hidden), moved: (await page.evaluate(() => document.getElementById('tutorial-progress').textContent)) !== p0, focus: await focusId() }, { open: true, moved: true, focus: 'tutorial-next' });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check('Escape closes the tour onto ?', await page.evaluate(() => ({ hidden: document.getElementById('tutorial-panel').hidden, focus: document.activeElement?.id })), { hidden: true, focus: 'tutorial-toggle' });

  // ---- 11. Pins and layouts ----------------------------------------------
  await focusTempo();
  await page.keyboard.press('p');
  await page.waitForTimeout(300);
  check('P pins the focused dial, focus kept', { pins: await page.evaluate(() => window.__ambi4Layout.pins.length), focus: await page.evaluate(() => document.activeElement?.getAttribute('aria-label')) }, { pins: 1, focus: 'Tempo' });
  await focusEl('#pinned-more');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  check('Enter on layouts opens the layout row', await page.evaluate(() => !document.getElementById('pinned-layouts').hidden), true);
  await focusEl('#layout-name');
  await page.keyboard.type('Keys layout');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  check('Enter in the layout-name box saves the layout', await page.evaluate(() => Object.keys(window.__ambi4Layout.saved)), ['Keys layout']);
  if (!(await page.evaluate(() => Object.keys(window.__ambi4Layout.saved).length))) { await page.evaluate(() => { document.getElementById('layout-name').value = 'Keys layout'; }); await page.click('#layout-save'); await page.waitForTimeout(300); }
  await focusEl('#layout-forget');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  check('Enter on Forget drops it and does NOT drop focus to body', { saved: await page.evaluate(() => Object.keys(window.__ambi4Layout.saved)), focus: await focusId() }, (v) => v.saved.length === 0 && v.focus !== 'BODY');
  await page.evaluate(() => document.querySelector('#pinned-row .knob')?.focus());
  await page.keyboard.press('p');
  await page.waitForTimeout(300);
  check('P on the mirror unpins, focus on the original', { pins: await page.evaluate(() => window.__ambi4Layout.pins.length), focus: await page.evaluate(() => document.activeElement?.getAttribute('aria-label')) }, { pins: 0, focus: 'Tempo' });

  // ---- 12. Timers ----------------------------------------------------------
  await focusEl('#timers-toggle');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  check('Enter opens Timers with focus inside', await page.evaluate(() => document.getElementById('timers-popover').contains(document.activeElement)), true);
  await focusEl('#timers-popover .sleep-preset');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  check('Enter on a sleep preset arms it, focus on Cancel', await page.evaluate(() => ({ active: !document.getElementById('sleep-active').hidden, focus: document.activeElement?.id })), { active: true, focus: 'sleep-cancel' });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  check('Enter on Cancel stands it down, focus kept in the popover', await page.evaluate(() => ({ active: !document.getElementById('sleep-active').hidden, inside: document.getElementById('timers-popover').contains(document.activeElement) })), { active: false, inside: true });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check('Escape closes Timers onto its button', await page.evaluate(() => ({ hidden: document.getElementById('timers-popover').hidden, focus: document.activeElement?.id })), { hidden: true, focus: 'timers-toggle' });

  // ---- 13. Full screen ---------------------------------------------------
  check('the scope ⛶ is focusable', await focusEl('#front-scope-fullscreen'), true);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(700);
  check('Enter enters full screen', await page.evaluate(() => document.fullscreenElement?.id || null), 'fullscreen-stage');
  check('…with focus in the full-screen bar, not on body', await page.evaluate(() => !!document.activeElement?.closest('#fullscreen-bar')), true);
  await page.waitForTimeout(2800);
  check('the bar slides away after a beat', await page.evaluate(() => document.getElementById('fullscreen-bar').dataset.collapsed !== undefined), true);
  await page.evaluate(() => document.querySelector('.scope-legend-track')?.focus());
  await page.evaluate(() => document.getElementById('fullscreen-exit').focus());
  await page.waitForTimeout(500);
  check('keyboard focus on Exit brings the bar back (it was focusable at opacity 0)', await page.evaluate(() => ({ collapsed: document.getElementById('fullscreen-bar').dataset.collapsed !== undefined, opacity: getComputedStyle(document.querySelector('.fullscreen-actions')).opacity })), { collapsed: false, opacity: '1' });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
  check('Enter on Exit leaves full screen and returns focus to the ⛶', await page.evaluate(() => ({ fs: !!document.fullscreenElement, stageHidden: document.getElementById('fullscreen-stage').hidden, focus: document.activeElement?.id })), { fs: false, stageHidden: true, focus: 'front-scope-fullscreen' });

  check('no console errors or page errors during the drive', errors, []);
  }

  return results;
}

// 2026-11-06: the same flows in Firefox and WebKit too. Focus is where the
// engines differ most — what Tab reaches, what a disabled or removed element
// does with focus, Escape in a select — and the drive asks "where is focus
// NOW" after every action. WebKit on a Mac tabs to form fields only unless
// full keyboard access is on, which is Option+Tab, the key a Safari keyboard
// user presses; Firefox is told the same (accessibility.tabfocus 7, macOS's
// own default is form fields only). Both green on v0.0.300 (84 + 84).
const ENGINES = [
  { name: 'firefox', label: '[firefox] ', TAB: 'Tab', launch: (pw) => pw.firefox.launch({ firefoxUserPrefs: { 'media.autoplay.default': 0, 'media.autoplay.block-webaudio': false, 'accessibility.tabfocus': 7 } }) },
  { name: 'webkit', label: '[webkit] ', TAB: 'Alt+Tab', launch: (pw) => pw.webkit.launch() },
];

export default async function drive(page) {
  const url = page.url();
  const results = await driveIn(page);
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  // measure.sh runs a drive from the shot folder, which holds the Playwright
  // the harness imports and its Firefox and WebKit builds.
  const pw = await import(pathToFileURL(join(process.cwd(), 'node_modules', 'playwright', 'index.mjs')).href);
  for (const E of ENGINES) {
    let browser;
    try {
      browser = await E.launch(pw);
    } catch (err) {
      results.push({ name: `${E.label}the browser launches (npx playwright install ${E.name})`, ok: false, got: String(err && err.message).split('\n')[0], want: 'a browser' });
      continue;
    }
    try {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const p = await ctx.newPage();
      await p.goto('about:blank');
      await p.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
      await p.waitForSelector('#generator-app:not([hidden])', { timeout: 20000 });
      await p.waitForTimeout(800);
      results.push(...(await driveIn(p, { TAB: E.TAB, label: E.label })));
    } finally {
      await browser.close();
    }
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'keyboard-only-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n'),
    );
  }
  return { passed: results.length };
}
