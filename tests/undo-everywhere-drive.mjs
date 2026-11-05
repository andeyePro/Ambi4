/**
 * ⌘Z / ⇧⌘Z over EVERY mutating action, not the five tests/undo-drive.mjs picks.
 *
 *   npm run build && .vibe/measure.sh local drive tests/undo-everywhere-drive.mjs
 *
 * One protocol, applied to each action in a long list — a dial drag, a spread,
 * a typed value, a double-click reset, every main-panel select, a lamp, a
 * voice pick, an editor dial, a draft parked and brought back, a step tapped,
 * a lane added and removed, the resolution ladder, a structure block added /
 * relabelled / re-barred / moved / removed, progression text and chips, a
 * typed melody / beat / words / MIDI file, Energy, a genre pick, Next, Back,
 * a preset load, a factory preset, Blank slate, Add track / Remove track,
 * Back to factory:
 *
 *   1. deep snapshot = the PERSISTED settings tree (localStorage, minus the
 *      session-only ui / lastTake / genreKitClean) + the ENGINE's params;
 *   2. do the action; assert the snapshot moved (an action that moves neither
 *      the store nor the engine is itself a finding: a reload would lose it);
 *   3. ⌘Z; assert the snapshot is back EXACTLY — every differing path is
 *      listed, which is how a field the restore path drops shows up;
 *   4. ⇧⌘Z; assert the change is back exactly;
 *   5. ⌘Z again (so the next action starts where this one did), unless the
 *      action is a stepping stone the next one builds on.
 *
 * Plus two things that are not actions: a gesture that lands on the value it
 * started from must NOT leave an undo entry (the next ⌘Z would then "do
 * nothing" from the person's point of view), and no page error or console
 * error may fire anywhere in the run.
 *
 * The store is read rather than a page-internal `settings`, because the
 * store is what the next visit boots from — an undo that fixes the page but
 * not the store would be a lie the reload tells.
 */

const STORE_KEY = 'ambi4:generator';

export default async function drive(page) {
  const results = [];
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + (e && e.message)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
    return ok;
  };

  const url = page.url();
  await page.goto('about:blank');
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('#generator-app:not([hidden])', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(400);
  await page.click('#consent-slot button:has-text("Save on this device")').catch(() => {});
  await page.waitForTimeout(200);

  // Pin the genre: a fresh visit draws a random one.
  await page.evaluate(() => {
    const sel = document.getElementById('genre-select');
    const opt = [...sel.options].find((o) => o.value === 'g:synthwave');
    if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  const pinned = await page.waitForFunction(() => window.__ambi4Engine?.getParams?.()?.tracks?.pad?.voice === 'polysaw', { timeout: 5000 }).then(() => true).catch(() => false);
  if (!pinned) throw new Error('undo-everywhere-drive: the Synthwave pin did not apply');
  await page.evaluate(() => { try { window.__ambi4Governor?.setTier?.('full'); } catch {} });
  await page.selectOption('#timeSignature', '4/4').catch(() => {});
  await page.waitForTimeout(400);
  await page.click('#tab-advanced');
  await page.waitForTimeout(500);

  // ---- in-page helpers -----------------------------------------------------
  await page.evaluate((STORE_KEY) => {
    const engine = window.__ambi4Engine;
    const vis = (el) => {
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        if (n.hidden || n.getAttribute?.('aria-hidden') === 'true') return false;
        const cs = getComputedStyle(n);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      }
      return true;
    };
    const lastKey = (path) => path.slice(path.lastIndexOf('.') + 1);
    const diffPaths = (a, b, path = '', out = []) => {
      if (Object.is(a, b)) return out;
      // An empty object and an absent key say the same thing (no overrides).
      const empty = (v) => v === undefined || (v && typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);
      if (empty(a) && empty(b)) return out;
      // Sparse fields: null (and a step's tie: false) say "none", as absence does.
      const none = (v) => v === undefined || v === null || (lastKey(path) === 'tie' && v === false);
      if (none(a) && none(b)) return out;
      const objA = a && typeof a === 'object';
      const objB = b && typeof b === 'object';
      if (!objA || !objB || Array.isArray(a) !== Array.isArray(b)) {
        // A trailing '?' marks a key present on one side only.
        if (JSON.stringify(a) !== JSON.stringify(b)) out.push((path || '(root)') + (a === undefined || b === undefined ? '?' : ''));
        return out;
      }
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (out.length > 40) break;
        diffPaths(a[k], b[k], `${path}.${k}`, out);
      }
      return out;
    };
    const knobsIn = (scope) => {
      const root = scope === 'main' ? document.getElementById('panel-advanced') : document.querySelector(scope);
      if (!root) return [];
      return [...root.querySelectorAll('.knob')].filter((k) => vis(k) && (scope !== 'main' || !k.closest('[id^="voice-editor-"]')));
    };
    const findKnob = (scope, label, nth = 0) => knobsIn(scope).filter((k) => k.getAttribute('aria-label') === label)[nth] || null;
    window.__ue = {
      snap: () => {
        let s = null;
        try { s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch {}
        s = s && typeof s === 'object' ? s : {};
        delete s.ui; delete s.lastTake; delete s.genreKitClean;
        const e = structuredClone(engine.getParams());
        // Two known, harmless representation gaps, normalised rather than
        // reported every run:
        //  * Breath is written to settings when the pad row builds, without a
        //    persist, so the store can lack it while the engine holds the
        //    very value the control will write — absent there means "the
        //    engine's own".
        //  * tempoLanding says where the NEXT tempo change lands (beat for
        //    Simple, bar for Advanced); it is which dial moved last, not part
        //    of the piece.
        if (s.tracks?.pad && s.tracks.pad.padBreath === undefined && typeof e.padBreath === 'number') s.tracks.pad.padBreath = e.padBreath;
        delete e.tempoLanding;
        delete s.tempoLanding;
        return { s, e };
      },
      // Representation-only gaps, reported as notes rather than failures:
      //  * the engine's copy of a patch after Back to factory carries the
      //    voice's defaults written out (sendPatch of the factory patch),
      //    after a load only the stored fields — the same sound;
      //  * settings.spans.<key> (the spread's shape) is filled in by the load
      //    path's normaliser for a span the gesture path never named.
      diff: (a, b) => {
        // A field written out on one side only, INSIDE an existing patch or span,
        // is write-out noise. A whole track's or voice's entry appearing is not:
        // a new track's first edit creates .patches.<id> and is the change itself.
        const benign = (p) => p.endsWith('?') && (p.startsWith('.spans.') || (p.startsWith('.patches.') && p.split('.').length > 4));
        const s = diffPaths(a.s, b.s);
        const e = diffPaths(a.e, b.e);
        return { s: s.filter((p) => !benign(p)), e: e.filter((p) => !benign(p)), notes: [...s, ...e].filter(benign) };
      },
      blur: () => { try { document.activeElement?.blur?.(); } catch {} },
      knob: (scope, label, nth) => {
        const k = findKnob(scope, label, nth);
        if (!k) return null;
        k.scrollIntoView({ block: 'center' });
        const r = k.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.width / 2), now: Number(k.getAttribute('aria-valuenow')), valuetext: k.getAttribute('aria-valuetext') || '' };
      },
      knobLabels: (scope) => knobsIn(scope).map((k) => k.getAttribute('aria-label')),
      clickValue: (scope, label, nth) => {
        const k = findKnob(scope, label, nth);
        const v = k?.querySelector('.knob-value');
        if (!v) return null;
        k.scrollIntoView({ block: 'center' });
        v.click();
        return !!k.querySelector('input.knob-value-edit');
      },
      unfold: () => {
        let n = 0;
        for (const b of document.querySelectorAll('#panel-advanced [id^="adv-more-"]:not([id^="adv-more-box-"])')) {
          if (b.getAttribute('aria-expanded') === 'true' || !vis(b)) continue;
          b.click(); n += 1;
        }
        return n;
      },
      click: (sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        el.scrollIntoView({ block: 'center' });
        el.click();
        return true;
      },
      exists: (sel) => !!document.querySelector(sel),
      set: (sel, value) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        el.scrollIntoView({ block: 'center' });
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      },
      openEditor: (t) => {
        const ed = document.getElementById(`voice-editor-${t}`);
        if (!ed || ed.hidden) document.getElementById(`voice-edit-toggle-${t}`)?.click();
        const box = document.getElementById(`ve-more-box-${t}`);
        if (box && box.hidden) document.getElementById(`ve-more-${t}`)?.click();
        return !!document.getElementById(`voice-editor-${t}`);
      },
      editorOpen: (t) => { const ed = document.getElementById(`voice-editor-${t}`); return !!ed && !ed.hidden && !!ed.querySelector('.knob'); },
      tracks: () => Object.keys(engine.getParams().tracks),
      store: () => { try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { return null; } },
    };
  }, STORE_KEY);

  const ue = (fn, ...args) => page.evaluate(([f, a]) => window.__ue[f](...a), [fn, args]);
  const settle = (ms = 750) => page.waitForTimeout(ms);
  const snap = () => ue('snap');
  const diff = (a, b) => ue('diff', a, b);

  async function drag(scope, label, dx, dy, nth = 0, again = true) {
    const d = await ue('knob', scope, label, nth);
    if (!d) return null;
    await page.mouse.move(d.x, d.y);
    await page.mouse.down();
    const steps = Math.max(Math.abs(dx), Math.abs(dy));
    for (let t = 4; t <= steps; t += 6) {
      const f = t / steps;
      await page.mouse.move(d.x + Math.round(dx * f), d.y + Math.round(dy * f));
    }
    await page.mouse.move(d.x + dx, d.y + dy);
    await page.mouse.up();
    const after = await ue('knob', scope, label, nth);
    // A dial already at its top does not move on an upward drag (since
    // v0.0.289 a drag from the hub is vertical and no longer swings to the
    // angle it crosses — Reprise sits at its top on some draws). The other
    // way, once, so the action is a real change.
    if (again && dx === 0 && after && after.valuetext === d.valuetext) return drag(scope, label, dx, -dy, nth, false);
    return after;
  }
  // A select's pick must differ from what the draw already chose, or the action
  // "changes nothing" on the draws that happened to land there.
  async function otherOption(sel, preferred) {
    return page.evaluate(([sel, preferred]) => {
      const el = document.querySelector(sel);
      if (!el) return preferred;
      if (el.value !== preferred) return preferred;
      return [...el.options].find((o) => !o.disabled && o.value !== el.value)?.value ?? preferred;
    }, [sel, preferred]);
  }
  async function dblclick(scope, label, nth = 0) {
    const d = await ue('knob', scope, label, nth);
    if (!d) return null;
    await page.mouse.dblclick(d.x, d.y);
    return true;
  }
  async function typeValue(scope, label, text, nth = 0) {
    const editing = await ue('clickValue', scope, label, nth);
    if (!editing) return false;
    await page.keyboard.type(String(text));
    await page.keyboard.press('Enter');
    return true;
  }
  const undo = async () => { await ue('blur'); await page.keyboard.press('Control+z'); await settle(650); };
  const redo = async () => { await ue('blur'); await page.keyboard.press('Control+Shift+z'); await settle(650); };

  const findings = [];
  const skipped = [];
  const guardsAnswered = [];
  const notes = [];
  let exercised = 0;

  /**
   * The protocol. `run` performs the action and returns false to say the
   * control was not there (recorded as skipped, never as green).
   */
  async function action(name, run, { keep = false, wait = 750 } = {}) {
    const before = await snap();
    let ran;
    try { ran = await run(); } catch (e) { findings.push(`${name}: the action threw: ${e && e.message}`); return; }
    if (ran === false) { skipped.push(name); return; }
    await settle(wait);
    // A pick or load that would replace an edited voice asks first; Move on
    // (park the edit under Edited) is part of the same gesture.
    const guarded = await page.evaluate(() => { const g = document.getElementById('leave-guard'); const b = g && !g.hidden ? g.querySelector('.leave-guard-move') : null; if (!b) return false; b.click(); return true; });
    if (guarded) { guardsAnswered.push(name); await settle(wait); }
    await ue('blur');
    const after = await snap();
    const moved = await diff(before, after);
    exercised += 1;
    if (!moved.s.length && !moved.e.length) {
      findings.push(`${name}: changed nothing (store and engine both unmoved)`);
      return;
    }
    if (!moved.s.length) findings.push(`${name}: moved the ENGINE (${moved.e.slice(0, 6).join(', ')}) but not the store — a reload loses it and ⌘Z cannot see it`);
    await undo();
    const restored = await snap();
    const left = await diff(before, restored);
    if (left.s.length || left.e.length) {
      findings.push(`${name}: ⌘Z did not restore — store ${JSON.stringify(left.s.slice(0, 8))} engine ${JSON.stringify(left.e.slice(0, 8))}`);
    }
    await redo();
    const redone = await snap();
    const gap = await diff(after, redone);
    if (gap.notes.length) notes.push(`${name}: ⇧⌘Z representation-only ${JSON.stringify(gap.notes.slice(0, 4))}`);
    if (gap.s.length || gap.e.length) {
      findings.push(`${name}: ⇧⌘Z diverged — store ${JSON.stringify(gap.s.slice(0, 8))} engine ${JSON.stringify(gap.e.slice(0, 8))}`);
    }
    if (!keep) {
      await undo();
      const back = await snap();
      const again = await diff(before, back);
      if (again.s.length || again.e.length) findings.push(`${name}: the second ⌘Z (after redo) left — store ${JSON.stringify(again.s.slice(0, 8))} engine ${JSON.stringify(again.e.slice(0, 8))}`);
    }
  }

  await ue('unfold');
  await settle(300);

  // ---- main-panel dials ----------------------------------------------------
  for (const label of ['Tempo', 'Complexity', 'Variation', 'Volume', 'Reprise', 'Swing', 'Reverb tail', 'Drive', 'Loop chance']) {
    await action(`main dial ${label}: drag`, async () => (await drag('main', label, 0, -40)) !== null);
  }
  await action('main dial Level (pad): drag', async () => (await drag('main', 'Level', 0, -30)) !== null);
  await action('main dial Randomness (pad): drag', async () => (await drag('main', 'Randomness', 0, -30)) !== null);
  await action('main dial Tempo: spread (horizontal drag)', async () => (await drag('main', 'Tempo', 70, 0)) !== null);
  await action('main dial Tempo: typed value', async () => {
    // aria-valuenow is the dial's 0-1 position, not bpm: read the engine's bpm
    // and type a different one, or a draw already at 95 "changes nothing".
    const bpm = await page.evaluate(() => { const b = window.__ambi4Engine.getParams().bpm; return typeof b === 'number' ? b : (b?.min + b?.max) / 2; });
    return typeValue('main', 'Tempo', Math.round(bpm) === 95 ? 97 : 95);
  });
  await action('main dial Tempo: drag (kept for the reset)', async () => (await drag('main', 'Tempo', 0, -40)) !== null, { keep: true });
  await action('main dial Tempo: double-click reset', async () => dblclick('main', 'Tempo'));

  // ---- a gesture that lands where it started leaves no entry ---------------
  {
    const before = await snap();
    await page.selectOption('#root', 'F');
    await settle();
    const after = await snap();
    // A commit that lands on the value it started from: open Tempo's
    // type-in (pre-filled with the current whole-number bpm) and press Enter
    // without typing. (A plain tap is NOT a no-op — a tap on the hub zeroes
    // the dial, by design, D2 — and arrow keys can snap to the step grid.)
    const typing = await ue('clickValue', 'main', 'Tempo', 0);
    check('Tempo opens its type-in', typing, true);
    await page.keyboard.press('Enter');
    await settle();
    const still = await snap();
    const nudged = await diff(after, still);
    check('a commit that lands on its own value changes nothing', [...nudged.s, ...nudged.e], (v) => v.length === 0);
    await undo();
    const restored = await snap();
    const left = await diff(before, restored);
    check('…and leaves no undo entry: one ⌘Z undoes the key change before it', [...left.s, ...left.e], (v) => v.length === 0);
    await redo();
    await undo();
  }

  // ---- main-panel selects and radios ---------------------------------------
  await action('select Key (#root)', async () => { await page.selectOption('#root', await otherOption('#root', 'G')); return true; });
  await action('select Scale (#mode)', async () => { await page.selectOption('#mode', await otherOption('#mode', 'dorian')); return true; });
  await action('select Time signature', async () => { await page.selectOption('#timeSignature', await otherOption('#timeSignature', '3/4')); return true; });
  await action('select Chord length', async () => {
    const other = await page.evaluate(() => { const s = document.getElementById('chordLength'); return s ? [...s.options].map((o) => o.value).find((v) => v !== s.value && !s.querySelector(`option[value="${v}"]`).disabled) : null; });
    if (!other) return false;
    await page.selectOption('#chordLength', other);
    return true;
  });
  await action('select Loop rule When', async () => (await ue('exists', '#hook-rule-when')) ? page.selectOption('#hook-rule-when', 'section').then(() => true) : false);
  await action('radio Complexity scope: flip Universal / Per instrument', async () => page.evaluate(() => {
    const off = ['universal', 'per'].map((v) => document.getElementById(`scope-complexity-${v}`)).find((r) => r && !r.checked);
    const label = off && document.querySelector(`label[for="${off.id}"]`);
    if (!label) return false;
    label.scrollIntoView({ block: 'center' });
    label.click();
    return true;
  }));

  // ---- track row: lamp, voice pick ----------------------------------------
  await action('lamp: pad state cycle', async () => ue('click', '#track-lamp-pad'));
  await action('voice pick: pad → glass', async () => { await page.selectOption('#track-voice-pad', 'glass'); return true; });

  // ---- voice editor: dial, spread, typed, reset, drafts ---------------------
  await ue('openEditor', 'pad');
  await page.waitForFunction(() => window.__ue.editorOpen('pad'), { timeout: 5000 }).catch(() => {});
  await settle(300);
  const padLabels = await ue('knobLabels', '#voice-editor-pad');
  const padKnob = padLabels.find((l) => /cutoff/i.test(l)) || padLabels.find((l) => /release|attack|decay/i.test(l)) || padLabels[0];
  await action(`editor dial ${padKnob}: drag`, async () => (await drag('#voice-editor-pad', padKnob, 0, -40)) !== null);
  await action(`editor dial ${padKnob}: spread`, async () => (await drag('#voice-editor-pad', padKnob, 60, 0)) !== null);
  await action(`editor dial ${padKnob}: drag (kept for the reset)`, async () => (await drag('#voice-editor-pad', padKnob, 0, -40)) !== null, { keep: true });
  await action(`editor dial ${padKnob}: double-click reset`, async () => dblclick('#voice-editor-pad', padKnob));
  // A sequencer-side editor control: the pad has none, so the next block uses melody.

  // Drafts: edit the pad's patch (kept), pick another voice (parks the edit
  // under Edited), bring it back from Edited, Back to factory.
  await action(`editor dial ${padKnob}: drag (kept, becomes a draft)`, async () => (await drag('#voice-editor-pad', padKnob, 0, -50)) !== null, { keep: true });
  await action('voice pick with an edited patch: pad → strings (parks a draft)', async () => { await page.selectOption('#track-voice-pad', 'strings'); return true; }, { keep: true });
  const draftOption = await page.evaluate(() => [...document.getElementById('track-voice-pad').options].map((o) => o.value).find((v) => /draft|edited/i.test(v)) || null);
  check('the parked edit is offered under Edited', draftOption, (v) => typeof v === 'string');
  if (draftOption) {
    await action('voice pick from Edited: brings the draft back', async () => { await page.selectOption('#track-voice-pad', draftOption); return true; }, { keep: true });
  }
  await action('Back to factory (pad)', async () => {
    const shown = await page.evaluate(() => { const b = document.getElementById('track-factory-pad'); return !!b && !b.hidden && !b.disabled; });
    if (!shown) return false;
    await ue('click', '#track-factory-pad');
    await settle(300);
    await page.evaluate(() => document.querySelector('#factory-confirm .factory-confirm-go')?.click());
    return true;
  });

  // ---- voice save / forget (the library is not settings; what IS settings must round-trip)
  await action('save voice as my own (pad)', async () => {
    const ok = await page.evaluate(() => {
      const ed = document.getElementById('voice-editor-pad');
      const name = ed?.querySelector('.ve-voice-name');
      const btn = ed?.querySelector('.ve-save-voice');
      if (!name || !btn) return false;
      name.value = 'Undo me voice';
      btn.click();
      return true;
    });
    return ok;
  }, { keep: true });
  await action('forget my voice (pad)', async () => page.evaluate(() => { const b = document.querySelector('#voice-editor-pad .ve-forget-voice'); if (!b || b.hidden || b.disabled) return false; b.click(); return true; }));

  // ---- sequencer: melody -----------------------------------------------------
  await ue('openEditor', 'melody');
  await page.waitForFunction(() => window.__ue.editorOpen('melody'), { timeout: 5000 }).catch(() => {});
  await settle(300);
  await action('sequencer: Manual mode (melody)', async () => ue('click', 'label[for="seq-mode-melody-manual"]'), { keep: true });
  const tapCell = async (n) => {
    const box = await page.evaluate((n) => {
      const c = document.querySelectorAll('#voice-editor-melody .seq-cell')[n];
      if (!c) return null;
      c.scrollIntoView({ block: 'center' });
      const r = c.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    }, n);
    if (!box) return false;
    await page.mouse.click(box.x, box.y);
    return true;
  };
  await action('sequencer: tap a step (melody)', async () => tapCell(2));
  await action('sequencer: pitch input (melody)', async () => page.evaluate(() => {
    const cell = document.querySelector('#voice-editor-melody .seq-cell');
    if (!cell) return false;
    cell.click();
    const input = document.querySelector('#voice-editor-melody .seq-pitch-input');
    if (!input) { cell.click(); return false; }
    input.value = 'E5';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }));
  await action('sequencer: add a lane/bar (melody)', async () => ue('click', '#voice-editor-melody .seq-add'), { keep: true });
  await action('sequencer: remove the last lane (melody)', async () => page.evaluate(() => { const b = [...document.querySelectorAll('#voice-editor-melody .seq-lane-remove')].pop(); if (!b || b.disabled) return false; b.click(); return true; }));
  await action('sequencer: resolution finer (melody)', async () => page.evaluate(() => { const b = [...document.querySelectorAll('#voice-editor-melody .seq-res-step')].find((x) => !x.disabled && /finer|\+|×2/i.test(x.textContent + (x.getAttribute('aria-label') || ''))) || [...document.querySelectorAll('#voice-editor-melody .seq-res-step')].find((x) => !x.disabled); if (!b) return false; b.click(); return true; }));
  await action('sequencer: triplet (melody)', async () => page.evaluate(() => { const b = document.querySelector('#voice-editor-melody .seq-res-triplet'); if (!b || b.disabled) return false; b.click(); return true; }));
  await action('sequencer: Auto mode again (melody)', async () => ue('click', 'label[for="seq-mode-melody-auto"]'));

  // ---- arp mode -------------------------------------------------------------
  await ue('openEditor', 'arp');
  await page.waitForFunction(() => window.__ue.editorOpen('arp'), { timeout: 5000 }).catch(() => {});
  await settle(300);
  await action('arp: Manual mode', async () => (await ue('exists', '#arp-mode-manual')) ? ue('click', 'label[for="arp-mode-manual"]') : false);

  // ---- structure ------------------------------------------------------------
  await action('structure: select Custom', async () => { await page.selectOption('#structure', 'custom'); return true; }, { keep: true });
  await action('structure: add a block', async () => page.evaluate(() => { const b = document.getElementById('add-structure-block'); if (!b || b.disabled) return false; b.scrollIntoView({ block: 'center' }); b.click(); return true; }));
  await action('structure: bars of block 1', async () => page.evaluate(() => { const i = document.querySelector('.structure-block input[type="number"]'); if (!i) return false; i.value = String(Number(i.value) === 7 ? 5 : 7); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); return true; }));
  await action('structure: relabel block 1', async () => page.evaluate(() => { const s = document.querySelector('.structure-block select'); if (!s) return false; const other = [...s.options].find((o) => o.value !== s.value); if (!other) return false; s.value = other.value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; }));
  await action('structure: title of block 1', async () => page.evaluate(() => { const i = document.querySelector('.structure-block .block-title'); if (!i) return false; i.value = 'Undo title'; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); return true; }));
  await action('structure: track state in block 1', async () => page.evaluate(() => { const b = document.querySelector('.structure-block .block-track'); if (!b) return false; b.click(); return true; }));
  await action('structure: block intensity dial', async () => (await drag('main', 'Block 1 intensity', 0, -30)) !== null);
  await action('structure: move block 1 down', async () => page.evaluate(() => { const b = document.querySelector('.structure-block .block-move:nth-of-type(2)') || document.querySelector('.structure-block .block-move'); if (!b || b.disabled) return false; b.click(); return true; }));
  await action('structure: remove block 1', async () => page.evaluate(() => { const b = document.querySelector('.structure-block .block-remove'); if (!b || b.disabled) return false; b.click(); return true; }));

  // ---- progression ------------------------------------------------------------
  await action('progression: typed text', async () => {
    if (!(await ue('exists', '#progression-row .progression-input'))) return false;
    await page.evaluate(() => document.getElementById('progression-row')?.scrollIntoView({ block: 'center' }));
    const now = await page.evaluate(() => document.querySelector('#progression-row .progression-input').value.trim());
    await page.fill('#progression-row .progression-input', now === 'I V vi IV' ? 'I IV V I' : 'I V vi IV');
    await page.evaluate(() => document.querySelector('#progression-row .progression-input').dispatchEvent(new Event('change', { bubbles: true })));
    return true;
  }, { keep: true });
  await action('progression: chord chip step', async () => ue('click', '#progression-chords .chord-chip:first-child .chord-chip-step'));
  await action('progression: chord chip colour', async () => ue('click', '#progression-chords .chord-chip:first-child .chord-chip-colour'));
  await action('progression: chord chip add', async () => ue('click', '#progression-chords .chord-chip-add'));
  await action('progression: chord chip drop', async () => ue('click', '#progression-chords .chord-chip:first-child .chord-chip-drop'));
  await action('progression: clear', async () => page.evaluate(() => { const b = document.querySelector('#progression-row .progression-clear'); if (!b || b.disabled) return false; b.click(); return true; }));

  // ---- Create panel: typed melody / beat / words / MIDI ------------------------
  const openCreate = async (write) => {
    const open = await page.evaluate(() => { const p = document.getElementById('play-along-panel') || document.getElementById('play-along'); return !!p && !p.hidden; });
    if (!open) { await ue('click', '#play-along-open'); await settle(400); }
    if (!(await ue('exists', '#create-write'))) return false;
    await page.selectOption('#create-write', write);
    await settle(300);
    return true;
  };
  await action('Create: typed melody write', async () => {
    if (!(await openCreate('melody'))) return false;
    await page.fill('#compose-melody-text', 'C4 E4 G4 -');
    await ue('click', '#compose-melody-write');
    return true;
  }, { wait: 1000 });
  await action('Create: typed beat write', async () => {
    if (!(await openCreate('beat'))) return false;
    const ok = await page.evaluate(() => { const b = document.getElementById('compose-beat-text'); if (!b) return false; b.value = 'K H s H KH H S H'; b.dispatchEvent(new Event('input', { bubbles: true })); return true; });
    if (!ok) return false;
    await ue('click', '#compose-beat-write');
    return true;
  }, { wait: 1000 });
  await action('Create: words write', async () => {
    if (!(await openCreate('words'))) return false;
    const ok = await page.evaluate(() => { const b = document.getElementById('compose-words-text'); if (!b) return false; b.value = 'undo every thing you did'; b.dispatchEvent(new Event('input', { bubbles: true })); return true; });
    if (!ok) return false;
    await ue('click', '#compose-words-write');
    return true;
  }, { wait: 1000 });
  await action('Create: MIDI import', async () => {
    if (!(await openCreate('midi'))) return false;
    return page.evaluate(async () => {
      const input = document.getElementById('compose-midi');
      if (!input) return false;
      const D = 96;
      const uint = (n, bytes) => { const out = []; for (let i = bytes - 1; i >= 0; i -= 1) out.push((n >> (8 * i)) & 0xff); return out; };
      const varint = (n) => { const out = [n & 0x7f]; n >>= 7; while (n > 0) { out.unshift((n & 0x7f) | 0x80); n >>= 7; } return out; };
      const chunk = (tag, body) => [...tag].map((c) => c.charCodeAt(0)).concat(uint(body.length, 4), body);
      const events = [
        ...varint(0), 0x90, 60, 100, ...varint(D), 0x80, 60, 0,
        ...varint(0), 0x90, 62, 100, ...varint(D), 0x80, 62, 0,
        ...varint(0), 0x90, 64, 100, ...varint(D), 0x80, 64, 0,
        ...varint(D), 0x90, 67, 100, ...varint(D), 0x80, 67, 0,
      ];
      const bytes = new Uint8Array([
        ...chunk('MThd', [...uint(1, 2), ...uint(1, 2), ...uint(D, 2)]),
        ...chunk('MTrk', [...events, ...varint(0), 0xff, 0x2f, 0x00]),
      ]);
      const file = new File([bytes], 'phrase.mid', { type: 'audio/midi' });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    });
  }, { wait: 1300 });
  await page.evaluate(() => { const p = document.getElementById('play-along-panel') || document.getElementById('play-along'); if (p && !p.hidden) document.getElementById('play-along-open')?.click(); });
  await settle(300);

  // ---- Simple tab: Energy and friends ----------------------------------------
  await page.click('#tab-simple');
  await settle(400);
  for (const [id, label] of [['energy-dial', 'Energy'], ['speed-dial', 'Tempo'], ['randomness-dial', 'Variation'], ['volume-dial', 'Volume']]) {
    await action(`Simple dial ${label}: drag`, async () => {
      const ok = await page.evaluate((id) => { const k = document.querySelector(`#${id} .knob`); if (!k) return null; k.scrollIntoView({ block: 'center' }); const r = k.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.width / 2) }; }, id);
      if (!ok) return false;
      await page.mouse.move(ok.x, ok.y);
      await page.mouse.down();
      for (let i = 4; i <= 40; i += 6) await page.mouse.move(ok.x, ok.y + i);
      await page.mouse.up();
      return true;
    });
  }

  // ---- whole-setup gestures ---------------------------------------------------
  await action('genre pick: Ambient', async () => {
    const value = await page.evaluate(() => [...document.getElementById('genre-select').options].map((o) => o.value).find((v) => v.startsWith('g:') && v !== 'g:synthwave') || null);
    if (!value) return false;
    await page.selectOption('#genre-select', value);
    return true;
  }, { wait: 1200 });
  await action('Next (#fast-forward)', async () => { await ue('click', '#fast-forward'); return true; }, { wait: 1300, keep: true });
  await action('Back (#rewind)', async () => page.evaluate(() => { const b = document.getElementById('rewind'); if (!b || b.disabled) return false; b.click(); return true; }), { wait: 1300 });

  await page.click('#tab-advanced');
  await settle(400);

  // ---- presets, factory presets, blank slate ------------------------------------
  await page.evaluate(() => { document.getElementById('preset-name').value = 'Undo everywhere'; });
  await ue('click', '#preset-save');
  await settle(400);
  await page.selectOption('#root', 'A');
  await settle(800);
  await action('preset load (own)', async () => {
    const value = await page.evaluate(() => [...document.getElementById('preset-load').options].find((o) => o.textContent === 'Undo everywhere')?.value || null);
    if (!value) return false;
    await page.selectOption('#preset-load', value);
    return true;
  }, { wait: 1000 });
  await action('factory preset card', async () => page.evaluate(() => { const c = document.querySelector('#factory-preset-row .factory-preset'); if (!c) return false; c.scrollIntoView({ block: 'center' }); c.click(); return true; }), { wait: 1200 });
  await action('Blank slate', async () => ue('click', '#blank-slate'), { wait: 1200 });

  // ---- Add track / Remove track ----------------------------------------------------
  let addedId = null;
  await action('Add track', async () => {
    const before = await ue('tracks');
    await page.evaluate(() => document.getElementById('add-track')?.scrollIntoView({ block: 'center' }));
    await ue('click', '#add-track');
    await settle(200);
    if (!(await ue('exists', '#add-track-name'))) return false;
    await page.fill('#add-track-name', 'Undo me');
    await page.keyboard.press('Enter');
    await settle(700);
    const after = await ue('tracks');
    addedId = after.find((id) => !before.includes(id)) || null;
    return !!addedId;
  }, { keep: true, wait: 900 });
  check('Add track made a track', addedId, (v) => typeof v === 'string');
  if (addedId) {
    await ue('openEditor', addedId);
    const open = await page.waitForFunction((t) => window.__ue.editorOpen(t), addedId, { timeout: 8000 }).then(() => true).catch(() => false);
    await settle(500);
    const labels = open ? await ue('knobLabels', `#voice-editor-${addedId}`) : [];
    const label = labels.find((l) => /cutoff|release|attack/i.test(l)) || labels[0];
    await action(`new track: editor dial ${label} (kept — a draft to lose on Remove)`, async () => {
      if (!label) return false;
      // Arrow keys, not a drag: this late in the run a pointer drag at the dial's
      // centre landed on nothing (store and engine unmoved), while the same drag
      // on a fresh page moves this dial both ways (440 -> 1374 / 415 Hz, probed
      // 2026-10-31). The keys reach the dial wherever it sits on screen.
      const focused = await page.evaluate(([scope, l]) => {
        const k = [...document.querySelectorAll(`${scope} [role="slider"]`)].find((x) => x.getAttribute('aria-label') === l);
        if (!k) return false;
        k.scrollIntoView({ block: 'center' });
        k.focus();
        return document.activeElement === k;
      }, [`#voice-editor-${addedId}`, label]);
      if (!focused) return false;
      for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowUp');
      return true;
    }, { keep: true });
    await action('Remove track', async () => page.evaluate((id) => { const b = document.getElementById(`track-remove-${id}`); if (!b) return false; b.scrollIntoView({ block: 'center' }); b.click(); return true; }, addedId), { wait: 1200 });
  }

  // ---- report ---------------------------------------------------------------------
  const bundle = await page.evaluate(() => [...document.scripts].map((x) => x.src).find((x) => /index\.astro/.test(x))?.split('/').pop() || '?');
  const unique = [...new Set(errors)];
  check('no page or console errors during the run', unique, (v) => v.length === 0);
  check('every action round-trips through ⌘Z and ⇧⌘Z', findings, (v) => v.length === 0);
  check('enough actions were actually exercised', exercised, (v) => v >= 40);

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'undo-everywhere-drive: ' + failed.length + ' failed [' + bundle + '] (' + exercised + ' actions exercised, skipped: ' + JSON.stringify(skipped) + ')\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got, null, 1)}\n      want ${JSON.stringify(r.want)}`).join('\n'),
    );
  }
  return { bundle, passed: results.length, exercised, skipped, guardsAnswered, notes };
}
