/**
 * Transport, second sweep: pause and resume against the ENGINE, not the caption.
 *
 *   npm run build && .vibe/measure.sh local drive tests/transport2-drive.mjs
 *
 * transport-drive.mjs proves the one-key Play → Finish → Stop story from the
 * DOM, which is what its 2026-07-28 report was about. This one reads the
 * engine through window.__ambi4Engine (its documented test seam) and the
 * AudioContext behind its output analyser, because the faults in this area are
 * all of the kind a caption cannot show: a context left suspended under a
 * "playing" button, a pause that never fades, a resume that re-anchors.
 *
 * The v0.0.274/282 pause-fade is the specific target: pause() fades the mix
 * out for PAUSE_FADE before it suspends, and every edit that lands inside or
 * after that fade must leave the fade alone. Each probe is the sequence the
 * owner can make with two fingers — pause then play within the fade, pause
 * then turn Volume, pause then edit a voice — and the witness is always the
 * context's state and clock plus the engine's stored params.
 */

const BOOT_SETTLE = 400;

/** The engine, its context and the transport's own DOM, in one read. */
const snap = (page) =>
  page.evaluate(() => {
    const e = window.__ambi4Engine;
    const an = e && typeof e.getOutputAnalyser === 'function' ? e.getOutputAnalyser() : null;
    const ctx = an ? an.context : null;
    let rms = null;
    if (an && ctx) {
      const buf = new Float32Array(an.fftSize);
      an.getFloatTimeDomainData(buf);
      let s = 0;
      for (let i = 0; i < buf.length; i += 1) s += buf[i] * buf[i];
      rms = Math.sqrt(s / buf.length);
    }
    const p = e ? e.getParams() : null;
    const q = (sel) => document.querySelector(sel);
    return {
      running: e ? e.running : null,
      paused: e ? e.paused : null,
      volume: p ? p.volume : null,
      bpm: p ? p.bpm : null,
      ctxState: ctx ? ctx.state : null,
      t: ctx ? ctx.currentTime : null,
      rms,
      label: q('.play-toggle-label')?.textContent.trim(),
      pressed: q('#toggle-play')?.getAttribute('aria-pressed'),
      toggleDisabled: q('#toggle-play')?.disabled,
      pauseLabel: q('.pause-label')?.textContent.trim(),
      pausePressed: q('#pause-toggle')?.getAttribute('aria-pressed'),
      pauseDisabled: q('#pause-toggle')?.disabled,
      pauseGlyph: !q('.pause-glyph')?.hidden,
      resumeGlyph: !q('.resume-glyph')?.hidden,
      mediaState: (() => { try { return navigator.mediaSession.playbackState; } catch { return null; } })(),
    };
  });

/** Highest output RMS seen over `ms` — generative music has quiet beats, so one read can lie. */
const peakRms = async (page, ms) => {
  const t0 = Date.now();
  let peak = 0;
  while (Date.now() - t0 < ms) {
    const s = await snap(page);
    if (s.rms != null && s.rms > peak) peak = s.rms;
    await page.waitForTimeout(60);
  }
  return peak;
};

/** Does the audio clock move over `ms`? A suspended context's does not. */
const clockMoves = async (page, ms) => {
  const a = await snap(page);
  await page.waitForTimeout(ms);
  const b = await snap(page);
  return { moved: b.t - a.t, a: a.ctxState, b: b.ctxState };
};

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
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.width / 2), text: k.querySelector('.knob-value')?.textContent?.trim(), valuetext: k.getAttribute('aria-valuetext') };
  }, [label, scope]);

async function dragDial(page, label, dx, dy, scope = '') {
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

/** Click-to-type on a dial's readout: the keyboard path every dial has. */
async function typeDial(page, label, text, scope = '') {
  const d = await dialAt(page, label, scope);
  if (!d) return null;
  await page.evaluate(([name, sel]) => {
    const root = sel ? document.querySelector(sel) : document;
    const k = [...(root || document).querySelectorAll('.knob')].find((el) => el.getAttribute('aria-label') === name && el.getBoundingClientRect().width > 0);
    k?.querySelector('.knob-value')?.click();
  }, [label, scope]);
  await page.waitForTimeout(150);
  const input = await page.$('.knob-value-edit');
  if (!input) return null;
  await input.fill(text);
  await input.press('Enter');
  await page.waitForTimeout(300);
  return dialAt(page, label, scope);
}

export default async function drive(page) {
  const results = [];
  const notes = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
    return ok;
  };
  const note = (name, got) => notes.push(`${name}: ${JSON.stringify(got)}`);

  // Console errors and uncaught exceptions fail the drive — a transport that
  // throws and happens to land in the right state is still a fault.
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', (err) => errors.push('pageerror: ' + (err && err.message ? err.message : String(err))));

  // A fresh boot with the listeners attached. Same-URL goto is a reload here
  // (no fragment), but about:blank first removes all doubt.
  const url = page.url();
  await page.goto('about:blank');
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('#generator-app:not([hidden])', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(BOOT_SETTLE);
  await page.click('#consent-slot button:has-text("Save on this device")').catch(() => {});
  await page.waitForTimeout(200);

  // Pin a busy genre so the output has something to measure in every bar.
  await page.click('#tab-advanced').catch(() => {});
  await page.waitForTimeout(200);
  const pinned = await page.evaluate(() => {
    const sel = document.getElementById('genre-select');
    if (!sel) return null;
    const want = [...sel.options].map((o) => o.value).find((v) => /house|techno|drum|lofi|lo-fi/i.test(v)) || sel.options[1]?.value;
    if (!want) return null;
    sel.value = want;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return want;
  });
  note('genre', pinned);
  await page.waitForTimeout(300);
  // Stay on Advanced: the voice editors and the dB Volume live there, and a
  // dial on the hidden Simple panel takes a drag delivered to nothing.

  // ---- 1. Play: engine running, context running, keys say so --------------
  const idle = await snap(page);
  check('idle: Pause is disabled before anything plays', idle.pauseDisabled, true);
  await page.click('#toggle-play');
  await page.waitForFunction(() => window.__ambi4Engine?.running === true, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const playing = await snap(page);
  check('playing: engine running, not paused', [playing.running, playing.paused], [true, false]);
  check('playing: the context is running', playing.ctxState, 'running');
  check('playing: Finish pressed, Pause live and reading Pause', [playing.label, playing.pressed, playing.pauseDisabled, playing.pauseLabel, playing.pausePressed], ['Finish', 'true', false, 'Pause', 'false']);
  const heard = await peakRms(page, 1200);
  check('playing: the output carries signal', heard > 0.002, (v) => v === true);
  note('playing peak rms', heard);

  // ---- 2. Pause: fades, then suspends; the clock stops ----------------------
  await page.click('#pause-toggle');
  const justPaused = await snap(page);
  check('pause: the engine is held at once, still running', [justPaused.running, justPaused.paused], [true, true]);
  check('pause: the keys read Resume, pressed; Finish stays live', [justPaused.pauseLabel, justPaused.pausePressed, justPaused.label, justPaused.toggleDisabled, justPaused.pauseGlyph, justPaused.resumeGlyph], ['Resume', 'true', 'Finish', false, false, true]);
  await page.waitForTimeout(400);
  const held = await snap(page);
  check('pause: the context is suspended once the fade is done', held.ctxState, 'suspended');
  const frozen = await clockMoves(page, 400);
  check('pause: the audio clock stands still', frozen.moved, 0);
  check('pause: the last rendered block is (near) silence', held.rms != null && held.rms < 0.01, (v) => v === true);
  note('paused tail rms', held.rms);
  check('pause: mediaSession says paused', held.mediaState, 'paused');

  // ---- 3. Resume after a settled pause --------------------------------------
  await page.click('#pause-toggle');
  await page.waitForTimeout(500);
  const resumed = await snap(page);
  check('resume: engine running and not paused, context running', [resumed.running, resumed.paused, resumed.ctxState], [true, false, 'running']);
  check('resume: keys back to Pause / Finish', [resumed.pauseLabel, resumed.pausePressed, resumed.label], ['Pause', 'false', 'Finish']);
  const moving = await clockMoves(page, 300);
  check('resume: the audio clock moves again', moving.moved > 0.2, (v) => v === true);
  const heardAgain = await peakRms(page, 1500);
  check('resume: the output carries signal again', heardAgain > 0.002, (v) => v === true);
  note('resumed peak rms', heardAgain);

  // ---- 4. Pause then Resume INSIDE the fade (under 60 ms) --------------------
  // The suspend is armed on a timer behind the fade; resuming before it fires
  // must disarm it, or the context suspends under a playing transport.
  await page.evaluate(() => new Promise((resolve) => {
    const b = document.getElementById('pause-toggle');
    b.click();
    setTimeout(() => { b.click(); resolve(); }, 30);
  }));
  await page.waitForTimeout(400);
  const quick = await snap(page);
  check('quick resume (30 ms): engine playing, context running', [quick.running, quick.paused, quick.ctxState], [true, false, 'running']);
  check('quick resume (30 ms): keys agree', [quick.pauseLabel, quick.pausePressed], ['Pause', 'false']);
  const quickClock = await clockMoves(page, 300);
  check('quick resume (30 ms): the clock moves', quickClock.moved > 0.2, (v) => v === true);

  // The same, timed to land exactly as the suspend fires (the fade is 60 ms
  // and the timer 80 ms): a ctx.suspend() in flight when resume() reads
  // ctx.state === 'running' must still end with a running context.
  for (const gap of [75, 82, 90]) {
    await page.evaluate((ms) => new Promise((resolve) => {
      const b = document.getElementById('pause-toggle');
      b.click();
      setTimeout(() => { b.click(); resolve(); }, ms);
    }), gap);
    await page.waitForTimeout(500);
    const race = await snap(page);
    const raceClock = await clockMoves(page, 300);
    check(`resume at ${gap} ms: engine playing, context running, clock moving`, [race.running, race.paused, race.ctxState, raceClock.moved > 0.2], [true, false, 'running', true]);
    check(`resume at ${gap} ms: keys agree`, [race.pauseLabel, race.pausePressed], ['Pause', 'false']);
  }

  // ---- 5. Pause, turn Volume, resume ---------------------------------------
  await page.click('#pause-toggle');
  await page.waitForTimeout(300);
  const beforeVol = await snap(page);
  const vol0 = await dialAt(page, 'Volume');
  const vol1 = await dragDial(page, 'Volume', 0, 60);
  const afterVol = await snap(page);
  check('volume while paused: the dial moved', vol1 && vol1.text !== vol0.text, (v) => v === true);
  check('volume while paused: the engine received it', afterVol.volume !== beforeVol.volume, (v) => v === true);
  check('volume while paused: the context stays suspended', afterVol.ctxState, 'suspended');
  note('volume', { from: beforeVol.volume, to: afterVol.volume, dial: [vol0?.text, vol1?.text] });
  await page.click('#pause-toggle');
  await page.waitForTimeout(500);
  const afterVolResume = await snap(page);
  check('volume while paused: resume plays on', [afterVolResume.running, afterVolResume.paused, afterVolResume.ctxState], [true, false, 'running']);
  check('volume while paused: the value survived the resume', afterVolResume.volume, afterVol.volume);
  const heardVol = await peakRms(page, 1500);
  check('volume while paused: the output carries signal after resume', heardVol > 0.001, (v) => v === true);
  note('post-volume peak rms', heardVol);

  // ---- 6. Pause, open an editor, edit a dial, resume ------------------------
  await page.click('#pause-toggle');
  await page.waitForTimeout(300);
  const track = await page.evaluate(() => {
    for (const id of ['pad', 'arp', 'melody', 'bass', 'texture', 'percussion']) {
      const t = document.getElementById(`voice-edit-toggle-${id}`);
      if (t && !t.hidden && !t.disabled) { t.scrollIntoView({ block: 'center' }); return id; }
    }
    return null;
  });
  check('editor while paused: a voice editor is reachable', !!track, (v) => v === true);
  let editorLabel = null;
  if (track) {
    await page.click(`#voice-edit-toggle-${track}`);
    await page.waitForTimeout(500);
    const scope = `#voice-editor-${track}`;
    editorLabel = await page.evaluate((sel) => {
      const root = document.querySelector(sel);
      if (!root || root.hidden) return null;
      const k = [...root.querySelectorAll('.knob')].find((el) => {
        for (let n = el; n && n !== root; n = n.parentElement) if (n.hidden) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0;
      });
      return k ? k.getAttribute('aria-label') : null;
    }, scope);
    check('editor while paused: the editor opened with a dial', !!editorLabel, (v) => v === true);
    if (editorLabel) {
      const d0 = await dialAt(page, editorLabel, scope);
      const d1 = await dragDial(page, editorLabel, 0, -50, scope);
      check(`editor while paused: ${editorLabel} moved`, d1 && d1.text !== d0.text, (v) => v === true);
      note('editor dial', { track, label: editorLabel, from: d0?.text, to: d1?.text });
    }
    const stillHeld = await snap(page);
    check('editor while paused: the context stays suspended through the edit', [stillHeld.paused, stillHeld.ctxState], [true, 'suspended']);
  }
  await page.click('#pause-toggle');
  await page.waitForTimeout(500);
  const afterEdit = await snap(page);
  check('editor while paused: resume plays on', [afterEdit.running, afterEdit.paused, afterEdit.ctxState], [true, false, 'running']);
  const heardEdit = await peakRms(page, 1500);
  check('editor while paused: the output carries signal after resume', heardEdit > 0.001, (v) => v === true);
  note('post-edit peak rms', heardEdit);
  if (track) {
    await page.click(`#voice-edit-toggle-${track}`).catch(() => {});
    await page.waitForTimeout(200);
  }

  // ---- 7. Tempo reaches the engine while playing and while paused -----------
  const bpm0 = (await snap(page)).bpm;
  await dragDial(page, 'Tempo', 0, -40);
  const bpm1 = (await snap(page)).bpm;
  check('tempo: a drag while playing reaches the engine', bpm1 !== bpm0, (v) => v === true);
  await page.click('#pause-toggle');
  await page.waitForTimeout(250);
  await dragDial(page, 'Tempo', 0, 40);
  const bpm2 = (await snap(page)).bpm;
  check('tempo: a drag while paused reaches the engine', bpm2 !== bpm1, (v) => v === true);
  await page.click('#pause-toggle');
  await page.waitForTimeout(400);
  const typed = await typeDial(page, 'Tempo', '140');
  const bpm3 = (await snap(page)).bpm;
  check('tempo: a typed value reaches the engine', bpm3, 140);
  note('bpm', [bpm0, bpm1, bpm2, bpm3, typed?.text]);

  // ---- 8. Hidden tab: playing keeps playing; a paused piece stays paused ----
  const hide = (hidden) => page.evaluate((h) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
  await hide(true);
  await page.waitForTimeout(1200);
  const hiddenPlaying = await snap(page);
  const hiddenClock = await clockMoves(page, 400);
  check('hidden: a playing piece plays on', [hiddenPlaying.running, hiddenPlaying.paused, hiddenPlaying.ctxState, hiddenClock.moved > 0.3], [true, false, 'running', true]);
  await hide(false);
  await page.waitForTimeout(300);
  await page.click('#pause-toggle');
  await page.waitForTimeout(300);
  await hide(true);
  await page.waitForTimeout(300);
  await hide(false);
  await page.waitForTimeout(500);
  const pausedAfterVis = await snap(page);
  check('hidden→visible: a paused piece is NOT resumed by the visibility poke', [pausedAfterVis.paused, pausedAfterVis.ctxState, pausedAfterVis.pauseLabel], [true, 'suspended', 'Resume']);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForTimeout(300);
  const pausedAfterFocus = await snap(page);
  check('focus: a paused piece is NOT resumed by the focus poke', [pausedAfterFocus.paused, pausedAfterFocus.ctxState], [true, 'suspended']);

  // ---- 9. Finish while paused = stop; Play afterwards is a fresh start ------
  await page.click('#toggle-play');
  await page.waitForTimeout(300);
  const stoppedFromPause = await snap(page);
  check('finish while paused: stops outright', [stoppedFromPause.running, stoppedFromPause.paused, stoppedFromPause.label, stoppedFromPause.pauseDisabled, stoppedFromPause.pausePressed], [false, false, 'Play', true, 'false']);
  await page.click('#toggle-play');
  await page.waitForFunction(() => window.__ambi4Engine?.running === true, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1200);
  const restarted = await snap(page);
  check('play after a paused stop: running, context running', [restarted.running, restarted.paused, restarted.ctxState, restarted.label, restarted.pauseDisabled], [true, false, 'running', 'Finish', false]);
  const heardRestart = await peakRms(page, 3000);
  check('play after a paused stop: the output carries signal', heardRestart > 0.001, (v) => v === true);
  note('restart peak rms', heardRestart);

  // ---- 10. Rapid play/pause/stop/play ---------------------------------------
  await page.evaluate(() => new Promise((resolve) => {
    const pause = document.getElementById('pause-toggle');
    const play = document.getElementById('toggle-play');
    pause.click();                                   // hold
    setTimeout(() => play.click(), 40);              // Finish-while-paused = stop
    setTimeout(() => play.click(), 120);             // Play: a fresh start
    setTimeout(resolve, 200);
  }));
  await page.waitForTimeout(2500);
  const rapid = await snap(page);
  check('rapid pause/stop/play: ends playing with a running context', [rapid.running, rapid.paused, rapid.ctxState, rapid.label, rapid.pauseDisabled, rapid.toggleDisabled], [true, false, 'running', 'Finish', false, false]);
  const rapidClock = await clockMoves(page, 300);
  check('rapid pause/stop/play: the clock moves', rapidClock.moved > 0.2, (v) => v === true);

  // ---- 11. Finish: Pause goes dead during the outro; Stop cuts it -----------
  await page.click('#toggle-play');
  await page.waitForTimeout(300);
  const finishing = await snap(page);
  check('finishing: reads Stop, Pause disabled, engine still running', [finishing.label, finishing.pauseDisabled, finishing.running], ['Stop', true, true]);
  await page.click('#toggle-play');
  await page.waitForTimeout(300);
  const stopped = await snap(page);
  check('stopped: engine stopped, reads Play', [stopped.running, stopped.paused, stopped.label, stopped.pauseDisabled], [false, false, 'Play', true]);
  await page.waitForTimeout(1200);
  const idled = await snap(page);
  check('stopped: the context suspends itself after the fade', idled.ctxState, 'suspended');

  // ---- 12. A natural ending through the engine's own event ------------------
  // finish() with a short fade via the seam: the page is told by the 'state'
  // event alone, so this is the path a lock-screen or timer ending takes.
  await page.click('#toggle-play');
  await page.waitForFunction(() => window.__ambi4Engine?.running === true, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(800);
  const endedInTime = await page.evaluate(() => Promise.race([
    window.__ambi4Engine.finish({ fadeSeconds: 1 }).then(() => true),
    new Promise((r) => setTimeout(() => r(false), 25000)),
  ]));
  check('natural ending: finish() resolved', endedInTime, true);
  await page.waitForTimeout(300);
  const ended = await snap(page);
  check('natural ending: the page shows Play with Pause disabled', [ended.running, ended.label, ended.pauseDisabled, ended.pressed], [false, 'Play', true, 'false']);

  // ---- 13. The grid playhead holds where the music holds ---------------------
  // The step playhead is driven by wall-clock timers armed at each 'bar'
  // event. A pause freezes the audio clock but not those timers, so the white
  // step ran on to the end of the bar while the piece stood still, and after
  // the resume it sat there until the next barline — a readout saying the
  // music was somewhere it was not. Measured on the arp grid, which always has one.
  await page.click('#toggle-play');
  await page.waitForFunction(() => window.__ambi4Engine?.running === true, { timeout: 5000 }).catch(() => {});
  await page.evaluate(() => document.getElementById('voice-edit-toggle-arp')?.scrollIntoView({ block: 'center' }));
  await page.click('#voice-edit-toggle-arp');
  await page.waitForTimeout(2500);
  const playheadAt = () => page.evaluate(() => {
    const root = document.querySelector('#voice-editor-arp');
    const c = root && root.querySelector('.seq-cell-playing');
    if (!c) return -1;
    const row = c.parentElement;
    return [...row.querySelectorAll('.seq-cell')].indexOf(c);
  });
  const sweeping = [];
  for (let i = 0; i < 12; i += 1) { sweeping.push(await playheadAt()); await page.waitForTimeout(100); }
  check('grid playhead: sweeps while playing', new Set(sweeping.filter((v) => v >= 0)).size > 2, (v) => v === true);
  note('playhead sweep', sweeping);
  // Pause the moment the playhead is early in a bar, from inside the page so
  // no SSH round trip sits between the read and the click.
  const pausedAt = await page.evaluate(() => new Promise((resolve) => {
    const idx = () => {
      const root = document.querySelector('#voice-editor-arp');
      const c = root && root.querySelector('.seq-cell-playing');
      if (!c) return -1;
      return [...c.parentElement.querySelectorAll('.seq-cell')].indexOf(c);
    };
    const started = Date.now();
    const poll = () => {
      const i = idx();
      if ((i >= 1 && i <= 4) || Date.now() - started > 6000) {
        document.getElementById('pause-toggle').click();
        resolve(i);
        return;
      }
      setTimeout(poll, 8);
    };
    poll();
  }));
  const heldHead = [];
  for (let i = 0; i < 15; i += 1) { await page.waitForTimeout(200); heldHead.push(await playheadAt()); }
  const heldEngine = await snap(page);
  check('grid playhead: the engine is held and its clock stopped', [heldEngine.paused, heldEngine.ctxState], [true, 'suspended']);
  // The audio clock runs ~80 ms through the pause fade, which is under one
  // step at any tempo the grid shows, so one step of drift is honest.
  check('grid playhead: holds where the music holds (at most one step on from the pause)',
    heldHead.every((v) => v >= pausedAt && v <= pausedAt + 1), (v) => v === true);
  note('playhead while paused', { pausedAt, heldHead });
  await page.click('#pause-toggle');
  const afterHead = [];
  for (let i = 0; i < 15; i += 1) { await page.waitForTimeout(100); afterHead.push(await playheadAt()); }
  check('grid playhead: moves on again after the resume', new Set(afterHead.filter((v) => v >= 0)).size > 2, (v) => v === true);
  note('playhead after resume', afterHead);
  await page.click('#voice-edit-toggle-arp').catch(() => {});
  await page.click('#toggle-play');
  await page.waitForTimeout(200);
  await page.click('#toggle-play');
  await page.waitForTimeout(300);

  check('no console errors or uncaught exceptions', errors, []);

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'transport2-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n') +
      '\n  notes: ' + notes.join('; '),
    );
  }
  return { passed: results.length, notes };
}
