/**
 * Phone use, in a real headless Chromium with a TOUCH screen.
 *
 *   npm run build && .vibe/measure.sh local drive tests/mobile-touch-drive.mjs
 *
 * Every other drive uses the harness's desktop page: a 1280 px mouse. Nothing
 * before this one pressed a dial with a finger, so a dial that answered a
 * mouse and scrolled the page under a thumb — or a page that a phone had to
 * zoom OUT to fit — would have passed every gate. This drive opens its OWN
 * contexts (hasTouch, isMobile, a 3× screen) at two phone sizes and drives the
 * page with CDP touch events, which is how a real finger arrives in Chromium:
 * pointer events with pointerType 'touch', plus the browser's own
 * scroll / zoom / long-press gesture detection on top of them. Playwright's
 * touchscreen can tap but not swipe, hence CDP.
 *
 * Everything that can be asserted at the ENGINE is: window.__ambi4Engine is
 * the documented seam. Lookups never throw — a missing control is a RECORDED
 * failure, so one unreachable dial does not hide the rest of the run.
 *
 * What it found on v0.0.284: the processor readout ("Auto (med) · 22 notes ·
 * 30 fps", white-space: nowrap) did not fit the genre row below 560 px and
 * pushed the document to 468 px on a 390 px phone, so Chrome shrank the whole
 * page to 83 % to fit it — every dial, every button, every label smaller than
 * designed, on the device with the least room. `measure.sh overlaps` could not
 * see it: the span overflowed nothing of its own, it widened the page.
 */

const PHONES = [
  { name: 'iPhone 14', width: 390, height: 844, full: true },
  { name: 'small Android', width: 360, height: 740, full: false },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A finger: touchStart, N touchMoves, touchEnd. Coordinates in device px. */
async function swipe(cdp, x, y, dx, dy, steps = 8) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let s = 1; s <= steps; s++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: x + (dx * s) / steps, y: y + (dy * s) / steps }],
    });
    await sleep(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function tap(cdp, x, y, holdMs = 40) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await sleep(holdMs);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/**
 * The box of `sel` — or of the first VISIBLE .knob labelled `label` under
 * `sel` — after scrolling it to the middle of the viewport, re-read after the
 * scroll (the recorded trap: page coordinates move under a scroll). `x`/`y`
 * aim at the dial's face centre (a square at the top of the knob root).
 */
const boxOf = (page, sel, label) =>
  page.evaluate(([s, name]) => {
    const visible = (el) => {
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        if (n.hidden || n.getAttribute?.('aria-hidden') === 'true') return false;
        const cs = getComputedStyle(n);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      }
      return true;
    };
    let el;
    if (name) {
      const root = s ? document.querySelector(s) : document;
      el = [...(root || document).querySelectorAll('.knob')].find((k) => k.getAttribute('aria-label') === name && visible(k));
    } else {
      el = [...document.querySelectorAll(s)].find(visible);
    }
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    const knob = el.classList.contains('knob');
    return {
      x: r.left + r.width / 2,
      y: r.top + (knob ? r.width / 2 : r.height / 2),
      left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height,
      valuetext: el.getAttribute('aria-valuetext'),
      text: knob ? el.querySelector('.knob-value')?.textContent?.trim() : el.textContent.trim().slice(0, 40),
      scrollY: window.scrollY,
    };
  }, [sel, label]);

const engineJSON = (page) => page.evaluate(() => JSON.stringify(window.__ambi4Engine.getParams()));
const engineBpm = (page) => page.evaluate(() => window.__ambi4Engine.getParams().bpm);
const viewport = (page) => page.evaluate(() => ({
  vw: innerWidth, vh: innerHeight, sw: document.documentElement.scrollWidth,
  scale: visualViewport.scale, sy: window.scrollY,
}));

export default async function drive(harnessPage) {
  const results = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
  };
  const url = harnessPage.url();
  const browser = harnessPage.context().browser();
  const notes = [];

  // The desktop page's track rows — the phone's must be the SAME controls
  // (TODO.md, closed 2026-10-30: Swing and Density live on the editor's dials
  // at every width; the row is lamp, voice, Level, Randomness, Edit).
  const desktopRows = await harnessPage.evaluate(() => [...document.querySelectorAll('.track-row')]
    .map((r) => [r.dataset.track, ...[...r.querySelectorAll('.knob')].map((k) => k.getAttribute('aria-label')), r.querySelector('.voice-edit-toggle') ? 'Edit' : '-'].join('/')));

  for (const phone of PHONES) {
    const P = `[${phone.width}×${phone.height}]`;
    const ctx = await browser.newContext({
      viewport: { width: phone.width, height: phone.height },
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 3,
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push('pageerror: ' + (e && e.message ? e.message : String(e))));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    await page.goto('about:blank');
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForSelector('#generator-app:not([hidden])', { timeout: 20000 });
    await page.waitForTimeout(600);
    const cdp = await ctx.newCDPSession(page);

    // ---- 1. the page fits the phone ---------------------------------------
    // innerWidth IS the phone's width when the page fits. When something is
    // wider, mobile Chromium lays the page out at that width and shrinks it
    // to fit the screen — innerWidth then reads the wider layout, and every
    // touch target below is smaller than designed. `k` keeps the finger
    // honest either way: CDP touch points are in screen px.
    const v0 = await viewport(page);
    const k = phone.width / v0.vw;
    const at = (b) => [b.x * k, b.y * k];
    check(`${P} the page lays out at the phone's width (nothing wider, no zoom-out)`, [v0.vw, v0.sw], [phone.width, phone.width]);
    check(`${P} the viewport meta is the mobile one`, await page.evaluate(() => document.querySelector('meta[name=viewport]')?.content || ''), (s) => /width=device-width/.test(s) && /initial-scale=1/.test(s));

    // Consent, by finger.
    const consent = await boxOf(page, '#consent-slot button');
    if (consent) { await tap(cdp, ...at(consent)); await page.waitForTimeout(300); }

    // ---- 2. Play and the transport, without scrolling ---------------------
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
    const transport = await page.evaluate(() => {
      const pick = (id) => { const r = document.getElementById(id)?.getBoundingClientRect(); return r ? [Math.round(r.top), Math.round(r.bottom), Math.round(r.right)] : null; };
      return { vh: innerHeight, vw: innerWidth, play: pick('toggle-play'), pause: pick('pause-toggle'), create: pick('play-along-open'), tabs: pick('tab-advanced') };
    });
    notes.push({ P, transport });
    check(`${P} Play is on screen at the top of the page`, transport.play && transport.play[0] >= 0 && transport.play[1] <= transport.vh && transport.play[2] <= transport.vw, (v) => v === true);
    check(`${P} …and so is Pause`, transport.pause && transport.pause[1] <= transport.vh && transport.pause[2] <= transport.vw, (v) => v === true);
    check(`${P} …and the Create door`, transport.create && transport.create[1] <= transport.vh && transport.create[2] <= transport.vw, (v) => v === true);

    // ---- 3. the track rows are the same controls as on a desktop ----------
    const phoneRows = await page.evaluate(() => [...document.querySelectorAll('.track-row')]
      .map((r) => [r.dataset.track, ...[...r.querySelectorAll('.knob')].map((k) => k.getAttribute('aria-label')), r.querySelector('.voice-edit-toggle') ? 'Edit' : '-'].join('/')));
    check(`${P} a track row is the same controls as on a desktop (Level, Randomness, Edit)`, phoneRows, desktopRows);

    // ---- 4. a finger on an Advanced dial ----------------------------------
    const tabA = await boxOf(page, '#tab-advanced');
    if (tabA) { await tap(cdp, ...at(tabA)); await page.waitForTimeout(400); }
    const ADV = '#panel-advanced';
    const bpm0 = await engineBpm(page);
    let t = await boxOf(page, ADV, 'Tempo');
    check(`${P} the Advanced tab opened by touch and Tempo is reachable`, !!t, (v) => v === true);
    if (t) {
      await page.waitForTimeout(200);
      const before = await viewport(page);
      // A dial already at the top cannot go up: push it down first.
      await swipe(cdp, ...at(t), 0, 60);
      await page.waitForTimeout(350);
      const after = await viewport(page);
      const bpm1 = await engineBpm(page);
      check(`${P} a vertical finger-drag on Tempo reached the ENGINE`, JSON.stringify(bpm1) !== JSON.stringify(bpm0), (v) => v === true);
      check(`${P} …and the page did not scroll under it`, Math.abs(after.sy - before.sy) < 2, (v) => v === true);
      check(`${P} …nor zoom`, after.scale, before.scale);
      check(`${P} the dial's touch-action is none`, await page.evaluate(() => getComputedStyle([...document.querySelectorAll('#panel-advanced .knob')].find((e) => e.getAttribute('aria-label') === 'Tempo')).touchAction), 'none');

      // Sideways opens a span, at the engine.
      t = await boxOf(page, ADV, 'Tempo');
      await page.waitForTimeout(150);
      await swipe(cdp, ...at(t), 70, 0);
      await page.waitForTimeout(350);
      const bpm2 = await engineBpm(page);
      check(`${P} a sideways finger-drag opened a span at the ENGINE`, bpm2 && typeof bpm2 === 'object' && bpm2.max > bpm2.min, (v) => v === true);
      const swept = await viewport(page);
      check(`${P} …without the horizontal swipe scrolling or zooming the page`, [Math.abs(swept.sy - after.sy) < 2, swept.scale], [true, after.scale]);

      // A double-tap is the reset (double-click on a mouse). It must reach the
      // dial AND must not be read by the browser as a zoom.
      t = await boxOf(page, ADV, 'Tempo');
      await page.waitForTimeout(150);
      const [tx, ty] = at(t);
      await tap(cdp, tx + 22 * k, ty); // away from the hub: a hub tap zeroes
      await sleep(90);
      await tap(cdp, tx + 22 * k, ty);
      await page.waitForTimeout(400);
      const bpm3 = await engineBpm(page);
      const dbl = await viewport(page);
      notes.push({ P, tempo: { bpm0, bpm1, bpm2, bpm3 } });
      check(`${P} a double-tap on Tempo reset the span (ENGINE holds one value again)`, typeof bpm3 === 'number', (v) => v === true);
      check(`${P} …and the double-tap did not zoom the page`, dbl.scale, 1);
    }

    // ---- 5. long-press: the pin menu, and nothing else --------------------
    t = await boxOf(page, ADV, 'Tempo');
    if (t) {
      await page.waitForTimeout(150);
      const held0 = await engineBpm(page);
      const [tx, ty] = at(t);
      await tap(cdp, tx, ty, 750); // held still on the HUB for 0.75 s
      await page.waitForTimeout(300);
      const menu = await page.evaluate(() => {
        const m = [...document.querySelectorAll('[role=menu], .pin-menu')].find((e) => !e.hidden && e.getClientRects().length);
        if (!m) return null;
        const r = m.getBoundingClientRect();
        return { left: Math.round(r.left), right: Math.round(r.right), bottom: Math.round(r.bottom), vw: innerWidth, vh: innerHeight, items: m.querySelectorAll('button,[role=menuitem]').length };
      });
      const held1 = await engineBpm(page);
      notes.push({ P, longPress: { menu, held0, held1 } });
      check(`${P} a long-press on a dial opens its pin menu`, !!menu, (v) => v === true);
      check(`${P} …and the hold is NOT a hub tap: the dial was not zeroed`, JSON.stringify(held1), JSON.stringify(held0));
      if (menu) {
        check(`${P} …the menu is inside the screen`, menu.left >= 0 && menu.right <= menu.vw && menu.bottom <= menu.vh, (v) => v === true);
        // Tap outside closes it.
        await tap(cdp, 8, Math.max(8, (t.top - 40) * k));
        await page.waitForTimeout(250);
        check(`${P} …and a tap elsewhere closes it`, await page.evaluate(() => ![...document.querySelectorAll('[role=menu], .pin-menu')].some((e) => !e.hidden && e.getClientRects().length)), true);
      }
    }

    // ---- 6. every editor opens, every dial in it answers a finger ----------
    const tracks = await page.evaluate(() => [...document.querySelectorAll('.track-row')].map((r) => r.dataset.track));
    const deaf = [];
    const unopened = [];
    const widened = [];
    for (const track of tracks) {
      const toggle = await boxOf(page, `.track-row[data-track="${track}"] .voice-edit-toggle`);
      if (!toggle) { unopened.push(track + ' (no Edit)'); continue; }
      await page.waitForTimeout(100);
      await tap(cdp, ...at(toggle));
      await page.waitForTimeout(500);
      const open = await page.evaluate((id) => { const e = document.getElementById(`voice-editor-${id}`); return !!e && !e.hidden; }, track);
      if (!open) { unopened.push(track); continue; }
      const vp = await viewport(page);
      if (vp.sw > vp.vw) widened.push(`${track}: ${vp.sw}px`);
      if (!phone.full) {
        await tap(cdp, ...at(await boxOf(page, `.track-row[data-track="${track}"] .voice-edit-toggle`)));
        await page.waitForTimeout(250);
        continue;
      }
      const scope = `#voice-editor-${track}`;
      const labels = await page.evaluate((s) => {
        const visible = (el) => !el.closest('[hidden]') && el.getClientRects().length > 0;
        return [...document.querySelectorAll(`${s} .knob`)].filter(visible).map((kn) => kn.getAttribute('aria-label'));
      }, scope);
      const seen = new Set();
      for (const label of labels) {
        if (seen.has(label)) continue; // the same name twice (per-lane dials): one is enough
        seen.add(label);
        const d = await boxOf(page, scope, label);
        if (!d) { deaf.push(`${track}/${label} (unreachable)`); continue; }
        await page.waitForTimeout(80);
        const sy = await page.evaluate(() => window.scrollY);
        const e0 = await engineJSON(page);
        await swipe(cdp, ...at(d), 0, -40, 6);
        await page.waitForTimeout(250);
        let d1 = await boxOf(page, scope, label);
        let e1 = await engineJSON(page);
        if (d1 && d1.valuetext === d.valuetext) {
          // at the top already — the other way, then
          await swipe(cdp, ...at(d1), 0, 40, 6);
          await page.waitForTimeout(250);
          d1 = await boxOf(page, scope, label);
          e1 = await engineJSON(page);
        }
        const sy1 = await page.evaluate(() => window.scrollY);
        if (Math.abs(sy1 - sy) > 2) deaf.push(`${track}/${label} (page scrolled ${sy1 - sy}px instead)`);
        else if (!d1 || d1.valuetext === d.valuetext) deaf.push(`${track}/${label} (readout did not move: ${d && d.valuetext})`);
        else if (e1 === e0) deaf.push(`${track}/${label} (readout moved, ENGINE did not)`);
      }
      // close it again, by finger
      const close = await boxOf(page, `.track-row[data-track="${track}"] .voice-edit-toggle`);
      if (close) { await tap(cdp, ...at(close)); await page.waitForTimeout(250); }
    }
    check(`${P} every track's editor opens by touch`, unopened, []);
    check(`${P} no open editor widens the page past the phone`, widened, []);
    if (phone.full) check(`${P} every editor dial answers a finger, at the ENGINE, without scrolling the page`, deaf, []);

    // ---- 7. popovers: fit the screen, close on a tap outside --------------
    const openPop = async (toggleSel, popSel) => {
      const b = await boxOf(page, toggleSel);
      if (!b) return { missing: toggleSel };
      await page.waitForTimeout(100);
      await tap(cdp, ...at(b));
      await page.waitForTimeout(400);
      return page.evaluate((s) => {
        const p = document.querySelector(s);
        if (!p || p.hidden) return { open: false };
        const r = p.getBoundingClientRect();
        const cs = getComputedStyle(p);
        return { open: true, left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), vw: innerWidth, vh: innerHeight, pos: cs.position, overflowY: cs.overflowY, maxH: cs.maxHeight, sw: document.documentElement.scrollWidth };
      }, popSel);
    };
    const create = await openPop('#play-along-open', '#play-along');
    notes.push({ P, create });
    check(`${P} the Create popover opens by touch`, create.open, true);
    if (create.open) {
      check(`${P} …and sits inside the screen's width`, create.left >= 0 && create.right <= create.vw && create.sw <= create.vw, (v) => v === true);
      check(`${P} …and can be scrolled when taller than the screen`, create.bottom <= create.vh || /auto|scroll/.test(create.overflowY), (v) => v === true);
      // The words input, by finger; then the keyboard comes up (the viewport
      // loses half its height) and the input must still be the focused,
      // reachable thing.
      const write = await boxOf(page, '#compose-words-write');
      if (write) { await tap(cdp, ...at(write)); await page.waitForTimeout(300); }
      const words = await boxOf(page, '#compose-words-text');
      check(`${P} the Words input is reachable`, !!words, (v) => v === true);
      if (words) {
        await page.waitForTimeout(100);
        await tap(cdp, ...at(words));
        await page.waitForTimeout(300);
        const focused = await page.evaluate(() => document.activeElement && document.activeElement.id);
        check(`${P} a tap focuses the Words input`, focused, 'compose-words-text');
        await page.keyboard.type('moon river');
        await page.setViewportSize({ width: phone.width, height: 400 });
        await page.waitForTimeout(400);
        const shrunk = await page.evaluate(() => {
          const el = document.getElementById('compose-words-text');
          const r = el.getBoundingClientRect();
          return { focused: document.activeElement === el, value: el.value, sw: document.documentElement.scrollWidth, vw: innerWidth, vh: innerHeight, top: Math.round(r.top), bottom: Math.round(r.bottom) };
        });
        notes.push({ P, keyboard: shrunk });
        check(`${P} with the keyboard up the Words input keeps focus and its text`, [shrunk.focused, shrunk.value], [true, 'moon river']);
        check(`${P} …and the layout is still no wider than the phone`, shrunk.sw <= shrunk.vw, (v) => v === true);
        await page.setViewportSize({ width: phone.width, height: phone.height });
        await page.waitForTimeout(300);
      }
      // A tap OUTSIDE the popover closes it. Above it is the header.
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(100);
      const outside = await page.evaluate(() => {
        const p = document.getElementById('play-along');
        const r = p.getBoundingClientRect();
        // the first point in the top strip that is not inside the popover
        for (let y = 4; y < r.top; y += 4) {
          const hit = document.elementFromPoint(innerWidth / 2, y);
          if (hit && !p.contains(hit) && !hit.closest('#play-along-open')) return [innerWidth / 2, y];
        }
        return null;
      });
      if (outside) {
        await tap(cdp, outside[0] * k, outside[1] * k);
        await page.waitForTimeout(300);
      }
      check(`${P} a tap outside the Create popover closes it`, await page.evaluate(() => document.getElementById('play-along').hidden), true);
    }

    // ---- 8. an ⓘ on a narrow screen: under its button, on screen ----------
    const infoBtn = await boxOf(page, '#panel-advanced .info-button, .info-button');
    if (infoBtn) {
      await page.waitForTimeout(100);
      await tap(cdp, ...at(infoBtn));
      await page.waitForTimeout(350);
      const box = await page.evaluate(() => {
        const b = [...document.querySelectorAll('.info-box')].find((e) => !e.hidden && e.getClientRects().length);
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { left: Math.round(r.left), right: Math.round(r.right), vw: innerWidth, docked: !!b.closest('#tutorial-panel'), sw: document.documentElement.scrollWidth };
      });
      notes.push({ P, infoBox: box });
      check(`${P} an ⓘ opens its box by touch`, !!box, (v) => v === true);
      if (box) {
        check(`${P} …beside the ⓘ, not docked (the panel is for wide screens)`, box.docked, false);
        check(`${P} …inside the screen's width`, box.left >= 0 && box.right <= box.vw && box.sw <= box.vw, (v) => v === true);
        await tap(cdp, ...at(infoBtn));
        await page.waitForTimeout(250);
        check(`${P} …and a second tap closes it`, await page.evaluate(() => ![...document.querySelectorAll('.info-box')].some((e) => !e.hidden && e.getClientRects().length)), true);
      }
    } else {
      check(`${P} an ⓘ is reachable`, false, true);
    }

    // ---- 9. full screen: the bar's buttons are on screen and work ----------
    const fsBtn = await boxOf(page, '#front-scope-fullscreen');
    if (fsBtn) {
      await page.waitForTimeout(100);
      await tap(cdp, ...at(fsBtn));
      await page.waitForTimeout(600);
      const fs = await page.evaluate(() => {
        const stage = document.getElementById('fullscreen-stage');
        const exit = document.getElementById('fullscreen-exit');
        const r = exit?.getBoundingClientRect();
        return { shown: !!stage && !stage.hidden, exit: r ? [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)] : null, vw: innerWidth, vh: innerHeight, native: !!document.fullscreenElement };
      });
      notes.push({ P, fullscreen: fs });
      check(`${P} full screen opens by touch`, fs.shown, true);
      if (fs.shown) {
        check(`${P} …its Exit button is on screen`, fs.exit && fs.exit[0] >= 0 && fs.exit[1] >= 0 && fs.exit[2] <= fs.vw && fs.exit[3] <= fs.vh, (v) => v === true);
        const exit = await boxOf(page, '#fullscreen-exit');
        if (exit) { await tap(cdp, ...at(exit)); await page.waitForTimeout(500); }
        check(`${P} …and Exit, by touch, leaves it`, await page.evaluate(() => document.getElementById('fullscreen-stage').hidden), true);
      }
    } else {
      check(`${P} the full-screen button is reachable`, false, true);
    }

    // ---- 10. Play, by finger ----------------------------------------------
    const play = await boxOf(page, '#toggle-play');
    if (play) {
      await page.waitForTimeout(100);
      await tap(cdp, ...at(play));
      await page.waitForTimeout(900);
      const playing = await page.evaluate(() => ({ pressed: document.getElementById('toggle-play').getAttribute('aria-pressed'), running: !!window.__ambi4Engine.isPlaying?.() || !!window.__ambi4Engine.isRunning?.() || document.getElementById('toggle-play').getAttribute('aria-pressed') === 'true' }));
      notes.push({ P, playing });
      check(`${P} Play starts the engine by touch`, playing.running, true);
    }

    const fin = await viewport(page);
    check(`${P} the page is still no wider than the phone at the end`, fin.sw <= fin.vw && fin.vw === phone.width, (v) => v === true);
    check(`${P} no console errors or page errors`, errors, []);
    await ctx.close();
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'mobile-touch-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n') +
      '\n  notes ' + JSON.stringify(notes),
    );
  }
  return { passed: results.length, notes };
}
