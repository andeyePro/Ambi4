/**
 * The edges of the sound-shaping controls, driven in a real browser.
 *
 *   npm run build && .vibe/measure.sh local drive tests/sound-edges-drive.mjs
 *
 * The existing drives prove each control's happy path. This one pushes the
 * same controls to their edges — typed values past the scale, rapid repeated
 * edits while the piece is sounding, a reload, the keyboard route out of a
 * dialog — and asserts the ENGINE's stored value against the readout after
 * every gesture, because a readout that says one thing while the engine holds
 * another is the failure this repo keeps meeting.
 *
 * Three of its checks were red on v0.0.284 and are what it was written for:
 *
 *  - The sleep timer's custom minutes said "up to 720" (the ⓘ and the input's
 *    own max) and then took any number: 99999 minutes counted down from
 *    1666:39:00.
 *  - Pressing a timer preset (or Set alarm, or Cancel) hid the row the pressed
 *    button was in. swapTimerRow meant to move focus to the row that replaced
 *    it, but only did so once document.activeElement had already fallen to
 *    <body> — which Chromium does a frame LATER, not synchronously — so focus
 *    was lost, and Escape (listened for on the popover) no longer closed it.
 *  - Clearing the genre tag ("No genre") changes no sound and asks nothing,
 *    as its handler says. But the voices the genre compiled were then read
 *    against the STOCK voice instead of the genre's own patch, so every one
 *    of them read as "edited", and the next genre pick put up the leave-guard
 *    for "5 edited voices" nobody had touched. The genre a setup grew from is
 *    still in settings.origin; the baseline now reads it when the tag is off.
 *
 * Traps honoured: about:blank before a reload (a same-URL goto does not
 * re-boot); the genre pinned before anything that depends on the draw; every
 * box re-read after a scrollIntoView; console errors and pageerrors fail the
 * drive.
 */

const sleep = (page, ms) => page.waitForTimeout(ms);

const centre = (page, slotId) =>
  page.evaluate((id) => {
    const slot = document.getElementById(id);
    const k = slot?.querySelector('.knob') || slot;
    if (!k) return null;
    k.scrollIntoView({ block: 'center' });
    const r = k.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }, slotId);

async function dragDial(page, slotId, dx, dy, steps = 12) {
  const c = await centre(page, slotId);
  if (!c) return false;
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(c.x + Math.round((dx * i) / steps), c.y + Math.round((dy * i) / steps));
  }
  await page.mouse.up();
  await sleep(page, 350);
  return true;
}

/** Click-to-type: open the readout's editor, type, Enter. */
async function typeInto(page, slotId, text) {
  const ok = await page.evaluate((id) => {
    const v = document.getElementById(id)?.querySelector('.knob-value');
    if (!v) return false;
    v.scrollIntoView({ block: 'center' });
    v.click();
    return true;
  }, slotId);
  if (!ok) return false;
  await sleep(page, 100);
  const has = await page.evaluate((id) => {
    const i = document.getElementById(id)?.querySelector('input.knob-value-edit');
    if (!i) return false;
    i.focus();
    i.select();
    return true;
  }, slotId);
  if (!has) return false;
  await page.keyboard.type(String(text));
  await page.keyboard.press('Enter');
  await sleep(page, 350);
  return true;
}

const readout = (page, slotId) =>
  page.evaluate((id) => document.getElementById(id)?.querySelector('.knob')?.getAttribute('aria-valuetext') ?? null, slotId);

const numberIn = (text) => {
  const m = /-?[\d.]+/.exec(text || '');
  return m ? Number(m[0]) : NaN;
};

const engine = (page) =>
  page.evaluate(() => {
    const p = window.__ambi4Engine.getParams();
    return {
      bpm: p.bpm,
      bpmSpan: p.spans?.bpm ?? null,
      reverbTail: p.reverbTail,
      drive: p.drive ?? 0,
      root: p.root,
      mode: p.mode,
      genre: p.genre,
      landing: p.tempoLanding,
    };
  });

const openFoldFor = async (page, selector) => {
  const more = await page.evaluate((s) => (typeof window.__ambi4FoldMore === 'function' ? window.__ambi4FoldMore(s) : null), selector);
  if (more) {
    await page.click(more);
    await sleep(page, 150);
  }
};

const pickGenre = async (page, value) => {
  await page.evaluate((v) => {
    const sel = document.getElementById('genre-select');
    sel.value = v;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  await sleep(page, 700);
};

const pinGenre = async (page, slug) => {
  await pickGenre(page, `g:${slug}`);
  return page
    .waitForFunction((s) => window.__ambi4Engine?.getParams?.()?.genre === s, slug, { timeout: 5000 })
    .then(() => true)
    .catch(() => false);
};

const timers = (page) =>
  page.evaluate(() => ({
    hidden: document.getElementById('timers-popover').hidden,
    focusInside: document.getElementById('timers-popover').contains(document.activeElement),
    sleepChip: document.getElementById('sleep-chip').textContent,
    countdown: document.getElementById('sleep-countdown').textContent,
  }));

const leaveGuard = (page) =>
  page.evaluate(() => {
    const g = document.getElementById('leave-guard');
    return g ? g.querySelector('#leave-guard-title')?.textContent || 'open' : null;
  });

export default async function drive(page) {
  const results = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
    return ok;
  };
  const note = (name, got) => results.push({ name, ok: true, got, want: '(informational)' });

  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + (e && e.message ? e.message : String(e))));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  const url = page.url();
  await page.goto('about:blank');
  await page.goto(url);
  await page.waitForFunction(() => !!window.__ambi4Engine, { timeout: 15000 });
  await page.click('#consent-slot button:has-text("Save on this device")').catch(() => {});
  await sleep(page, 300);

  check('Synthwave pinned at the engine', await pinGenre(page, 'synthwave'), true);

  // ---- Advanced > Sound: Reverb tail and Drive -----------------------------
  await page.click('#tab-advanced');
  await sleep(page, 400);
  await openFoldFor(page, '#reverb-tail-dial .knob');
  check('the Sound fold shows Reverb tail and Drive', await page.evaluate(() => ({
    reverb: !!document.querySelector('#reverb-tail-dial .knob')?.offsetParent,
    drive: !!document.querySelector('#drive-dial .knob')?.offsetParent,
  })), { reverb: true, drive: true });

  check('Reverb tail typed 3.5 reaches the ENGINE', await typeInto(page, 'reverb-tail-dial', '3.5') && (await engine(page)).reverbTail, 3.5);
  check('…and the readout agrees', await readout(page, 'reverb-tail-dial'), '3.5 s');
  await typeInto(page, 'reverb-tail-dial', '0');
  check('Reverb tail typed 0 lands on the 0.5 s floor, engine and readout', [(await engine(page)).reverbTail, await readout(page, 'reverb-tail-dial')], [0.5, '0.5 s']);
  await typeInto(page, 'reverb-tail-dial', '6');
  const atSix = (await engine(page)).reverbTail;
  await typeInto(page, 'reverb-tail-dial', '99');
  check('Reverb tail typed 99 clamps to the 6 s top (the readout)', await readout(page, 'reverb-tail-dial'), '6 s');
  check('…and the engine holds what a typed 6 gives it (the Processor cap applies to both)', (await engine(page)).reverbTail, atSix);
  note('engine tail at a 6 s dial (the Processor cap on this machine)', atSix);
  const rc = await centre(page, 'reverb-tail-dial');
  await page.mouse.dblclick(rc.x, rc.y);
  await sleep(page, 350);
  check('a double-click resets Reverb tail to the shipped 4 s', await readout(page, 'reverb-tail-dial'), '4 s');
  check('…and the engine followed (within the cap)', (await engine(page)).reverbTail, Math.min(4, atSix));

  await dragDial(page, 'drive-dial', 0, -60);
  const driveText = await readout(page, 'drive-dial');
  check('a drag on Drive moved it off Off', /%$/.test(driveText || ''), true);
  check('…and the ENGINE holds the percentage shown', Math.round((await engine(page)).drive * 100), numberIn(driveText));
  await typeInto(page, 'drive-dial', '150');
  check('Drive typed 150 clamps to 100% at the engine and the readout', [(await engine(page)).drive, await readout(page, 'drive-dial')], [1, '100%']);
  await typeInto(page, 'drive-dial', '0');
  check('Drive typed 0 is Off at both', [(await engine(page)).drive, await readout(page, 'drive-dial')], [0, 'Off']);
  await dragDial(page, 'drive-dial', 90, 0);
  check('a sideways drag on Drive is refused and SAYS why', await page.evaluate(() => document.getElementById('dial-confirm')?.textContent || ''), (t) => /Drive holds one steady value/.test(t));
  check('…and no drive reached the engine from it', (await engine(page)).drive, 0);

  // ---- Simple Tempo: typed extremes, reset, rapid drags while sounding -----
  await page.click('#tab-simple');
  await sleep(page, 300);
  await typeInto(page, 'speed-dial', '999');
  check('Tempo typed 999 clamps to 220 at the engine and the readout', [(await engine(page)).bpm, await readout(page, 'speed-dial')], [220, '220 bpm']);
  await typeInto(page, 'speed-dial', '5');
  check('Tempo typed 5 clamps to 20', [(await engine(page)).bpm, await readout(page, 'speed-dial')], [20, '20 bpm']);
  await typeInto(page, 'speed-dial', 'abc');
  check('Tempo typed junk changes nothing', [(await engine(page)).bpm, await readout(page, 'speed-dial')], [20, '20 bpm']);
  const tc = await centre(page, 'speed-dial');
  await page.mouse.dblclick(tc.x, tc.y);
  await sleep(page, 350);
  const afterReset = await engine(page);
  check('a double-click reset puts the engine where the readout says', `${afterReset.bpm} bpm`, await readout(page, 'speed-dial'));
  note('Tempo after reset (the dial’s declared default, not the genre’s draw)', afterReset.bpm);
  await dragDial(page, 'speed-dial', 0, -80);
  await page.evaluate(() => document.querySelector('#speed-dial .knob')?.focus());
  await page.keyboard.press('Backspace');
  await sleep(page, 350);
  check('Backspace resets to the same place as the double-click', (await engine(page)).bpm, afterReset.bpm);

  await page.click('#toggle-play');
  await sleep(page, 1500);
  for (let i = 0; i < 8; i++) await dragDial(page, 'speed-dial', 0, i % 2 ? 40 : -60, 5);
  const rapid = await engine(page);
  check('eight quick Tempo drags while sounding: engine and readout agree', `${rapid.bpm} bpm`, await readout(page, 'speed-dial'));
  check('…Simple landed its change on the beat', rapid.landing, 'beat');
  check('…and the Advanced view reads the same', await readout(page, 'speed-dial-adv'), `${rapid.bpm} bpm`);

  // ---- Reverb tail dragged repeatedly while sounding (v0.0.274 debounce) ---
  await page.click('#tab-advanced');
  await sleep(page, 300);
  await openFoldFor(page, '#reverb-tail-dial .knob');
  // Every reverbTail the page sends is logged, so a mismatch below says what
  // the engine was actually told rather than only that the two disagree.
  await page.evaluate(() => {
    const e = window.__ambi4Engine;
    if (e.__rtWrapped) return;
    const real = e.setParams.bind(e);
    window.__rtLog = [];
    e.setParams = (p) => { if (p && 'reverbTail' in p) window.__rtLog.push(p.reverbTail); return real(p); };
    e.__rtWrapped = true;
  });
  for (let i = 0; i < 6; i++) await dragDial(page, 'reverb-tail-dial', 0, i % 2 ? 50 : -50, 6);
  const tailText = await readout(page, 'reverb-tail-dial');
  const tailWant = Math.min(numberIn(tailText), atSix);
  const tailSettled = await page
    .waitForFunction((w) => Math.abs(window.__ambi4Engine.getParams().reverbTail - w) < 1e-9, tailWant, { timeout: 1500 })
    .then(() => true)
    .catch(() => false);
  const tailEngine = (await engine(page)).reverbTail;
  check('six quick Reverb drags while sounding: the engine holds the readout (or its cap)',
    tailSettled ? tailEngine : { engine: tailEngine, readout: tailText, sent: await page.evaluate(() => window.__rtLog.slice(-12)) },
    tailWant);

  // ---- Key and scale pickers while sounding, then a reload -----------------
  await page.selectOption('#root', 'F#');
  await page.selectOption('#mode', 'dorian');
  await sleep(page, 400);
  check('Key and Scale picked while sounding reach the engine', (({ root, mode }) => ({ root, mode }))(await engine(page)), { root: 'F#', mode: 'dorian' });
  const beforeReload = await engine(page);
  await page.goto('about:blank');
  await page.goto(url);
  await page.waitForFunction(() => !!window.__ambi4Engine, { timeout: 15000 });
  await sleep(page, 600);
  const afterReload = await engine(page);
  check('a reload keeps key, scale, tempo and reverb tail', [afterReload.root, afterReload.mode, afterReload.bpm, afterReload.reverbTail], [beforeReload.root, beforeReload.mode, beforeReload.bpm, beforeReload.reverbTail]);
  check('…and the pickers read what the engine holds', await page.evaluate(() => [document.getElementById('root').value, document.getElementById('mode').value]), [afterReload.root, afterReload.mode]);

  // ---- Timers popover: the advertised cap, and Escape after a press --------
  await page.click('#timers-toggle');
  await sleep(page, 250);
  check('the Timers popover opens with focus inside it', await timers(page), (t) => t.hidden === false && t.focusInside === true);
  await page.fill('#sleep-custom', '99999');
  await page.click('#sleep-start');
  await sleep(page, 300);
  const huge = await timers(page);
  check('a custom sleep of 99999 minutes is held to the advertised 720 (12 h)', huge.sleepChip, '12:00:00');
  check('…and focus stayed inside the dialog after Start', huge.focusInside, true);
  await page.click('#sleep-cancel');
  await sleep(page, 250);
  check('Cancel keeps focus inside the dialog too', (await timers(page)).focusInside, true);
  await page.click('.sleep-preset[data-minutes="15"]');
  await sleep(page, 250);
  const after15 = await timers(page);
  check('15 min starts the countdown', after15.sleepChip, '15:00');
  check('…with focus still inside the dialog', after15.focusInside, true);
  await page.keyboard.press('Escape');
  await sleep(page, 250);
  check('Escape closes the Timers popover after a preset was pressed', (await timers(page)).hidden, true);
  check('…and the countdown is still running', (await timers(page)).sleepChip, (t) => /^1[45]:\d\d$/.test(t));
  // (Open it only if Escape did close it — on a build where it did not, a
  // toggle press here would close it and hide the Cancel this needs.)
  await page.evaluate(() => { if (document.getElementById('timers-popover').hidden) document.getElementById('timers-toggle').click(); });
  await sleep(page, 250);
  await page.click('#sleep-cancel');
  await sleep(page, 200);
  await page.keyboard.press('Escape');
  await sleep(page, 200);
  check('Escape closes it after Cancel as well', (await timers(page)).hidden, true);

  // ---- Clearing the genre tag must not turn the genre’s voices into edits -
  check('Synthwave pinned again', await pinGenre(page, 'synthwave'), true);
  await pickGenre(page, '');
  check('No genre clears the tag at the engine', (await engine(page)).genre, null);
  check('…and asks nothing', await leaveGuard(page), null);
  await pickGenre(page, 'g:techno-tools');
  const guard = await leaveGuard(page);
  check('the next genre pick does not ask to keep voices nobody edited', guard, null);
  if (guard) await page.keyboard.press('Escape');
  await sleep(page, 300);
  check('…and the genre took', (await engine(page)).genre, 'techno-tools');
  check('…with the picker agreeing', await page.evaluate(() => document.getElementById('genre-select').value), 'g:techno-tools');
  check('…and both Tempo views reading the engine’s new bpm', await page.evaluate(() => [
    document.querySelector('#speed-dial .knob')?.getAttribute('aria-valuetext'),
    document.querySelector('#speed-dial-adv .knob')?.getAttribute('aria-valuetext'),
  ]), (v) => v[0] === v[1] && numberIn(v[0]) > 0);
  check('…which is the bpm the engine holds', numberIn(await readout(page, 'speed-dial')), (await engine(page)).bpm);

  // ---- The resolution ladder past both ends, while sounding ----------------
  await page.click('#toggle-play');
  await sleep(page, 1200);
  await page.click('#tab-advanced');
  await sleep(page, 300);
  await page.click('#voice-edit-toggle-bass');
  await sleep(page, 600);
  const press = async (label, n) => {
    for (let i = 0; i < n; i++) {
      await page.evaluate((l) => {
        const editor = document.getElementById('voice-editor-bass');
        [...editor.querySelectorAll('.seq-res-step')].find((b) => b.textContent === l)?.click();
      }, label);
      await sleep(page, 120);
    }
  };
  const ladder = () => page.evaluate(() => {
    const editor = document.getElementById('voice-editor-bass');
    const seq = window.__ambi4Engine.getParams().tracks.bass.sequencer;
    const lane = Array.isArray(seq?.steps) ? seq.steps.length : Object.keys(seq?.steps || {}).length;
    return { cells: editor.querySelectorAll('.seq-cell').length, lane };
  });
  await press('÷2', 8);
  check('eight ÷2 presses stop at the bottom rung: 64 cells, an 80-slot lane', await ladder(), { cells: 64, lane: 80 });
  await press('×2', 8);
  check('eight ×2 presses stop at the top rung: 4 cells, a 5-slot lane', await ladder(), { cells: 4, lane: 5 });

  check('no console errors or page errors during the drive', errors, []);

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'sound-edges-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n'),
    );
  }
  return {
    passed: results.length,
    notes: results.filter((r) => r.want === '(informational)').map((r) => `${r.name}: ${JSON.stringify(r.got)}`),
  };
}
