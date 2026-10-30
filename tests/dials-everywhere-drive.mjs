/**
 * Every dial, everywhere, every gesture — and the ENGINE must agree each time.
 *
 *   npm run build && .vibe/measure.sh local drive tests/dials-everywhere-drive.mjs
 *
 * dial-drive.mjs proves the gesture on the main panel; spread-all-drive.mjs
 * proves the sideways gesture in the pad's editor. This one enumerates the
 * dials FROM THE DOM — Simple, Advanced (folds opened), every built-in
 * track's editor, and a melodic and a percussive track made through Add
 * track — so a dial added tomorrow is driven the day it lands, and puts each
 * one through the four things a person does to a dial:
 *
 *   1. a vertical drag      — the readout moves, and the engine's params
 *                             change (for a patch dial, the very field its
 *                             cell names in data-field);
 *   2. a sideways drag      — a spreadable dial draws a span and the engine
 *                             holds one; a single-valued dial refuses AND
 *                             says why under the dials (CLAUDE.md: a control
 *                             that cannot do what it advertises says so);
 *   3. a typed value        — click the readout, type, Enter: readout and
 *                             engine both move;
 *   4. a double-click       — the reset lands in the engine too; on the D8
 *                             dials (Pan, Timing, Dynamics, Octave wander,
 *                             Voice chance) it hands the dial back to Auto:
 *                             the track's macroPatch names it again.
 *
 * Where the dial's number IS the engine's number (Level, Randomness, Glide,
 * the D8 dials, and every linear patch field), the engine's stored value is
 * compared to aria-valuenow after each gesture — a readout drawing a value
 * the engine never received is the failure the owner has hit twice.
 *
 * Every ⓘ in each scope is pressed too: its box must show (docked in the
 * tutorial panel on a wide screen) and Esc must put it away.
 *
 * Dials it reports as "hidden, not reached" are hidden BY DESIGN on the
 * pinned Synthwave piece and stay informational: Vowel (shown only under a
 * vowel filter type), each track's Swing (hidden while the global Swing is
 * Universal), the kit's two rule Chances (shown only when the kit has two or
 * more tabs) and a one-oscillator voice's OSC 2 and Mix.
 *
 * Traps honoured (CLAUDE.md): about:blank before the real load so console
 * and page errors are caught from boot; genre pinned and VERIFIED at the
 * engine; every box re-read after scrollIntoView; editor queries scoped to
 * #voice-editor-<track>.
 */

/** Named-position dials: a span between two names means nothing, and they refuse in silence by design. */
const ENUM_DIALS = new Set(['Type', 'Processor']);

/** The dissolved Randomise row (v0.0.275): label -> engine field, Auto = patched. */
const D8 = new Map([
  ['Pan', 'pan'],
  ['Timing', 'timing'],
  ['Dynamics', 'dynamics'],
  ['Octave wander', 'octaveWander'],
]);

/**
 * Dials whose aria-valuenow IS the engine's stored number (no log map, no
 * display scale). Label -> path under tracks[<track>] ('t:') or under
 * patches[<track>][<voice>] ('p:' — the cell's data-field decides which).
 * Everything else is checked for "the engine changed", not for the number.
 */
const LINEAR_TRACK = new Map([
  ['Level', 'level'],
  ['Randomness', 'randomness'],
  ['Glide', 'glide'],
  ['Drift rate', 'driftRate'],
  ['Dissonance', 'dissonance'],
  ['Pan', 'pan'],
  ['Timing', 'timing'],
  ['Dynamics', 'dynamics'],
  ['Octave wander', 'octaveWander'],
  ['Passing notes', 'passingNotes'],
]);
const LOG_FIELDS = new Set(['filter.cutoff', 'adsr.attack', 'adsr.decay', 'adsr.release', 'fm.ratio', 'fm.bite', 'source.bandCentre', 'filter.type']);

const SCOPES_BUILTIN = ['pad', 'bass', 'melody', 'texture', 'arp', 'percussion'];

export default async function drive(page) {
  const results = [];
  const errors = [];
  let current = 'boot';
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
    return ok;
  };
  const note = (name, got) => results.push({ name, ok: true, got, want: '(informational)' });

  // ---- a fresh load with the error listeners already attached -------------
  const url = page.url();
  page.on('pageerror', (e) => errors.push(`[${current}] pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${current}] console: ${m.text()}`); });
  await page.goto('about:blank');
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('#generator-app:not([hidden])', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(400);
  await page.click('#consent-slot button:has-text("Save on this device")').catch(() => {});
  await page.waitForTimeout(200);

  // Pin the genre through the UI and verify it at the engine (spread-all's
  // history: a pin that does not take must fail loudly, never pass through).
  await page.evaluate(() => {
    const sel = document.getElementById('genre-select');
    const opt = [...sel.options].find((o) => o.value === 'g:synthwave');
    if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  const pinned = await page.waitForFunction(() => window.__ambi4Engine?.getParams?.()?.tracks?.pad?.voice === 'polysaw', { timeout: 5000 }).then(() => true).catch(() => false);
  if (!pinned) throw new Error('dials-everywhere-drive: the Synthwave pin did not apply');
  // The power governor clips what the engine is sent (Reverb tail at Low);
  // pin Full so a clipped value is never mistaken for a dropped one.
  await page.evaluate(() => { try { window.__ambi4Governor?.setTier?.('full'); } catch {} });
  await page.waitForTimeout(300);

  // ---- in-page helpers -----------------------------------------------------
  await page.evaluate(() => {
    const engine = window.__ambi4Engine;
    const vis = (el) => {
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        if (n.hidden || n.getAttribute?.('aria-hidden') === 'true') return false;
        const cs = getComputedStyle(n);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      }
      return true;
    };
    const isSpan = (v) => (v && typeof v === 'object' && !Array.isArray(v) && Number.isFinite(v.min) && Number.isFinite(v.max) && v.min < v.max)
      || (Array.isArray(v) && v.length === 2 && Number.isFinite(v[0]) && Number.isFinite(v[1]) && v[0] < v[1]);
    const holdsSpan = (v) => isSpan(v) || Boolean(v && typeof v === 'object' && Object.values(v).some(holdsSpan));
    const diffPaths = (a, b, path = '', out = []) => {
      if (Object.is(a, b)) return out;
      const objA = a && typeof a === 'object';
      const objB = b && typeof b === 'object';
      if (!objA || !objB || Array.isArray(a) !== Array.isArray(b) || isSpan(b)) {
        if (JSON.stringify(a) !== JSON.stringify(b)) out.push([path, b]);
        return out;
      }
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffPaths(a[k], b[k], `${path}.${k}`, out);
      return out;
    };
    const inScope = (scope) => {
      const root = scope === 'main' ? document.getElementById('panel-advanced') : document.querySelector(scope);
      if (!root) return [];
      return [...root.querySelectorAll('.knob')].filter((k) => vis(k) && (scope !== 'main' || !k.closest('[id^="voice-editor-"]')));
    };
    const keyed = (scope) => {
      const count = new Map();
      return inScope(scope).map((k) => {
        const label = k.getAttribute('aria-label') || '?';
        const n = (count.get(label) || 0) + 1;
        count.set(label, n);
        return { k, label, n, key: `${label}#${n}` };
      });
    };
    const find = (scope, key) => keyed(scope).find((d) => d.key === key)?.k || null;
    const state = (k) => {
      const r = k.getBoundingClientRect();
      return {
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.width / 2),
        w: Math.round(r.width),
        now: Number(k.getAttribute('aria-valuenow')),
        min: Number(k.getAttribute('aria-valuemin')),
        max: Number(k.getAttribute('aria-valuemax')),
        valuetext: k.getAttribute('aria-valuetext') || '',
        text: k.querySelector('.knob-value')?.textContent?.trim() || '',
        spread: k.dataset.spread,
        field: k.closest('[data-field]')?.dataset.field || null,
        zeroed: k.getAttribute('data-zeroed'),
        where: k.closest('[id]')?.id || '',
      };
    };
    window.__dd = {
      keys: (scope) => keyed(scope).map((d) => ({ key: d.key, label: d.label, field: d.k.closest('[data-field]')?.dataset.field || null, spread: d.k.dataset.spread })),
      hiddenLabels: (scope) => {
        const root = scope === 'main' ? document.getElementById('panel-advanced') : document.querySelector(scope);
        return root ? [...root.querySelectorAll('.knob')].filter((k) => !vis(k) && (scope !== 'main' || !k.closest('[id^="voice-editor-"]'))).map((k) => k.getAttribute('aria-label')) : [];
      },
      at: (scope, key) => {
        const k = find(scope, key);
        if (!k) return null;
        k.scrollIntoView({ block: 'center' });
        return state(k);
      },
      clickValue: (scope, key) => {
        const k = find(scope, key);
        const v = k?.querySelector('.knob-value');
        if (!v) return null;
        k.scrollIntoView({ block: 'center' });
        v.click();
        const input = k.querySelector('input.knob-value-edit');
        return input ? input.value : null;
      },
      editing: (scope, key) => !!find(scope, key)?.querySelector('input.knob-value-edit'),
      snap: () => { window.__dd.before = structuredClone(engine.getParams()); },
      diff: () => diffPaths(window.__dd.before, engine.getParams()).map(([p, v]) => [p, v, holdsSpan(v)]),
      track: (t) => structuredClone(engine.getParams().tracks[t]),
      patchField: (t, field) => {
        const p = engine.getParams();
        const voice = p.tracks[t]?.voice;
        return field.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), p.patches?.[t]?.[voice]);
      },
      confirm: () => document.getElementById('dial-confirm')?.textContent?.trim() || '',
      clearConfirm: () => { const el = document.getElementById('dial-confirm'); if (el) el.textContent = ''; },
      confirmSeen: () => {
        const el = document.getElementById('dial-confirm');
        if (!el || !vis(el)) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      },
      unfold: (scope) => {
        const root = scope === 'main' ? document.getElementById('panel-advanced') : document.querySelector(scope);
        if (!root) return 0;
        let n = 0;
        const sel = scope === 'main' ? '[id^="adv-more-"]:not([id^="adv-more-box-"])' : 'button.rule-more, button.ve-more';
        for (const b of root.querySelectorAll(sel)) {
          if (b.getAttribute('aria-expanded') === 'true') continue;
          if (!vis(b)) continue;
          b.click();
          n += 1;
        }
        return n;
      },
      infos: (scope) => {
        const root = scope === 'main' ? document.getElementById('panel-advanced') : document.querySelector(scope);
        // Main leaves the editors' ⓘ to the editors' own sweep, as it does their dials.
        return root ? [...root.querySelectorAll('button.info-button')].filter((b) => vis(b) && (scope !== 'main' || !b.closest('[id^="voice-editor-"]'))).map((b) => b.getAttribute('aria-label')) : [];
      },
      pressInfo: (scope, label, nth) => {
        const root = scope === 'main' ? document.getElementById('panel-advanced') : document.querySelector(scope);
        // Resolved by label at press time: an earlier ⓘ can add or hide others.
        const b = [...root.querySelectorAll('button.info-button')].filter((x) => vis(x) && x.getAttribute('aria-label') === label && (scope !== 'main' || !x.closest('[id^="voice-editor-"]')))[nth];
        if (!b) return null;
        b.scrollIntoView({ block: 'center' });
        b.focus(); // a pointer click focuses the button; Esc is read from the ⓘ's own wrap
        b.click();
        const box = document.getElementById(b.getAttribute('aria-controls') === 'tutorial-panel' ? 'tutorial-info-slot' : b.getAttribute('aria-controls'));
        const shown = box ? box.querySelector('.info-box') || box : null;
        const wide = !window.matchMedia('(max-width: 1100px)').matches;
        return {
          label: b.getAttribute('aria-label'),
          expanded: b.getAttribute('aria-expanded'),
          visible: !!shown && vis(shown) && shown.getBoundingClientRect().height > 0,
          docked: !!document.querySelector('#tutorial-info-slot .info-box-docked') && !document.getElementById('tutorial-panel')?.hidden,
          wide,
          text: (shown?.textContent || '').trim().slice(0, 40),
        };
      },
      infoOpen: () => !!document.querySelector('.info-box:not([hidden])') && [...document.querySelectorAll('.info-box')].some((b) => vis(b)),
    };
  });

  const dd = (fn, ...args) => page.evaluate(([f, a]) => window.__dd[f](...a), [fn, args]);
  const settle = async (ms = 260) => page.waitForTimeout(ms);
  /** Wait for the engine to differ from the snapshot (Complexity and Energy commit on a 120 ms debounce). */
  const diffSoon = async () => {
    let d = [];
    for (let i = 0; i < 6; i += 1) {
      d = await dd('diff');
      if (d.length) return d;
      await page.waitForTimeout(120);
    }
    return d;
  };

  async function drag(scope, key, dx, dy) {
    const d = await dd('at', scope, key);
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
    await settle();
    return dd('at', scope, key);
  }
  async function dblclick(scope, key) {
    const d = await dd('at', scope, key);
    if (!d) return null;
    await page.mouse.dblclick(d.x, d.y);
    await settle();
    return dd('at', scope, key);
  }
  async function typeValue(scope, key, text) {
    const prefilled = await dd('clickValue', scope, key);
    if (prefilled === null) return null;
    // No Ctrl+A: on a Mac Chromium that is "caret to line start", which
    // de-selects the pre-selected text and PREPENDS the typed digits.
    await page.keyboard.type(String(text));
    await page.keyboard.press('Enter');
    await settle();
    return { prefilled, after: await dd('at', scope, key) };
  }

  const drifting = (s) => /drifting/.test(s?.valuetext || '');
  const near = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 1e-6;
  const engineOf = async (scope, label, field, track) => {
    if (field) return LOG_FIELDS.has(field) ? undefined : dd('patchField', track, field);
    if (track && LINEAR_TRACK.has(label)) {
      const t = await dd('track', track);
      const v = t[LINEAR_TRACK.get(label)];
      return v === undefined && label === 'Passing notes' ? 0 : v;
    }
    return undefined;
  };
  /** The dial's number against the engine's: a scalar equals aria-valuenow; a span's min does. */
  const agree = (s, engine) => {
    if (engine === undefined) return true;
    if (engine === null) return !drifting(s) && near(s.now, 0);
    if (typeof engine === 'object') {
      // A collapsed span (min === max) reads as a single value, by design (v16).
      if (near(engine.min, engine.max)) return !drifting(s) && near(s.now, engine.min);
      return drifting(s) && near(s.now, engine.min);
    }
    return !drifting(s) && near(s.now, engine);
  };

  const counts = { dials: 0, dragged: 0, spread: 0, refused: 0, typed: 0, reset: 0, infos: 0, hiddenSkipped: [] };
  const deaf = []; // vertical drag changed nothing at the engine
  const liars = []; // readout and engine disagree
  const silentRefusals = [];
  const spanLost = [];
  const typedLost = [];
  const resetLost = [];

  async function testDial(scope, track, { key, label, field, spread }) {
    current = `${scope} ${key}`;
    counts.dials += 1;
    const start = await dd('at', scope, key);
    if (!start) return;
    const isEnum = ENUM_DIALS.has(label);

    // 1. vertical drag — up unless the dial is already at its top.
    await dd('snap');
    // 90 px is 45 % of the sweep: enough to move a 3-position dial (Octave
    // -1..1) past its rounding point after the 6 px axis lock is spent.
    const dy = start.now >= start.max - 1e-9 ? 90 : -90;
    const moved = await drag(scope, key, 0, dy);
    if (!moved) return;
    const d1 = await diffSoon();
    counts.dragged += 1;
    // A user track's patch object is made on its first edit, so the diff may
    // name the whole patch rather than the field inside it.
    const fieldHit = !field || d1.some(([p]) => {
      const rel = p.replace(/^\.patches\.[^.]+(\.[^.]+)?/, '').replace(/^\./, '');
      return rel === '' || field === rel || field.startsWith(`${rel}.`) || rel.startsWith(`${field}.`);
    });
    if (!d1.length || !fieldHit) deaf.push(`${scope} ${key}: text ${JSON.stringify(start.text)} -> ${JSON.stringify(moved.text)}, engine changed ${d1.length ? JSON.stringify(d1.map(([p]) => p)).slice(0, 160) : 'nothing'}`);
    const e1 = await engineOf(scope, label, field, track);
    if (!agree(moved, e1)) liars.push(`${scope} ${key} after a drag: dial ${JSON.stringify(moved.text)} now=${moved.now}, engine ${JSON.stringify(e1)}`);

    // 2. sideways drag.
    await dd('clearConfirm');
    await dd('snap');
    const wide = await drag(scope, key, 70, 0);
    if (!wide) return;
    if (spread === 'yes') {
      const d2 = await diffSoon();
      if (!drifting(wide)) spanLost.push(`${scope} ${key}: claims data-spread=yes but drew no span (${wide.valuetext})`);
      else if (!d2.some(([, , span]) => span)) spanLost.push(`${scope} ${key}: drew ${JSON.stringify(wide.text)} but the engine holds no span (changed ${JSON.stringify(d2.map(([p]) => p)).slice(0, 160)})`);
      else counts.spread += 1;
      const e2 = await engineOf(scope, label, field, track);
      if (!agree(wide, e2)) liars.push(`${scope} ${key} after a spread: dial ${JSON.stringify(wide.text)} now=${wide.now}, engine ${JSON.stringify(e2)}`);
    } else {
      if (drifting(wide)) spanLost.push(`${scope} ${key}: data-spread=no yet it drew a span`);
      const said = await dd('confirm');
      const seen = await dd('confirmSeen');
      if (!isEnum && !(said && seen)) silentRefusals.push(`${scope} ${key}: refused the sideways drag ${said ? 'but the line is not visible' : 'in silence'} (${JSON.stringify(said)})`);
      counts.refused += 1;
    }

    // 3. a typed value: the readout's own number, scaled, through the click-to-type input.
    await dd('snap');
    const typed = await typeValue(scope, key, '0');
    if (typed) {
      const n = parseFloat((/-?[\d.]+/.exec(typed.prefilled || '') || ['NaN'])[0]);
      const first = typed.after;
      // "0" went in above; if it left the readout where it was, try a second number.
      let final = first;
      if (first && first.text === wide.text) {
        const alt = Number.isFinite(n) && n !== 0 ? +(n * 1.5).toFixed(3) : 5;
        const again = await typeValue(scope, key, alt);
        final = again?.after || first;
      }
      const d3 = await diffSoon();
      counts.typed += 1;
      const stillEditing = await dd('editing', scope, key);
      if (stillEditing) typedLost.push(`${scope} ${key}: the typed input did not close on Enter`);
      if (!d3.length || (final && final.text === wide.text)) typedLost.push(`${scope} ${key}: typed into ${JSON.stringify(typed.prefilled)}; readout ${JSON.stringify(wide.text)} -> ${JSON.stringify(final?.text)}, engine changed ${d3.length ? JSON.stringify(d3.map(([p]) => p)).slice(0, 120) : 'nothing'}`);
      const e3 = await engineOf(scope, label, field, track);
      if (final && !agree(final, e3)) liars.push(`${scope} ${key} after typing: dial ${JSON.stringify(final.text)} now=${final.now}, engine ${JSON.stringify(e3)}`);
    }

    // 4. double-click: the reset reaches the engine; a D8 dial goes back to Auto.
    await dd('snap');
    const reset = await dblclick(scope, key);
    const d4 = await diffSoon();
    counts.reset += 1;
    if (reset && !d4.length && reset.text !== (typed?.after?.text ?? wide.text)) resetLost.push(`${scope} ${key}: the readout reset to ${JSON.stringify(reset.text)} but the engine did not move`);
    const e4 = await engineOf(scope, label, field, track);
    if (reset && !D8.has(label) && !agree(reset, e4)) liars.push(`${scope} ${key} after a reset: dial ${JSON.stringify(reset.text)} now=${reset.now}, engine ${JSON.stringify(e4)}`);
    if (track && D8.has(label) && reset) {
      const t = await dd('track', track);
      const id = D8.get(label);
      const auto = /Auto/.test(reset.text) && Array.isArray(t.macroPatch) && t.macroPatch.includes(id) && t[id] === 0;
      if (!auto) resetLost.push(`${scope} ${key}: a double-click should hand the dial back to Auto; readout ${JSON.stringify(reset.text)}, macroPatch ${JSON.stringify(t.macroPatch)}, ${id}=${JSON.stringify(t[id])}`);
    }
    if (track && label === 'Voice chance' && reset) {
      const t = await dd('track', track);
      const auto = /Auto/.test(reset.text) && t.macroPatch?.includes('voiceWander') && (t.voiceRule ? t.voiceRule.chance === null : true);
      if (!auto) resetLost.push(`${scope} ${key}: a double-click should return Voice chance to Auto; readout ${JSON.stringify(reset.text)}, macroPatch ${JSON.stringify(t.macroPatch)}, chance ${JSON.stringify(t.voiceRule?.chance)}`);
    }
  }

  async function sweepScope(scope, track) {
    current = `${scope} (open)`;
    // Folds nest (an editor's more holds a rule's more): open until none is left.
    for (let pass = 0; pass < 4; pass += 1) {
      const opened = await dd('unfold', scope);
      await settle(250);
      if (!opened) break;
    }
    const seen = new Set();
    for (let guard = 0; guard < 200; guard += 1) {
      const next = (await dd('keys', scope)).find((d) => !seen.has(d.key));
      if (!next) break;
      seen.add(next.key);
      await testDial(scope, track, next);
    }
    const hidden = await dd('hiddenLabels', scope);
    if (hidden.length) counts.hiddenSkipped.push(`${scope}: ${hidden.join(', ')}`);
    // every ⓘ in the scope
    const infos = await dd('infos', scope);
    for (let i = 0; i < infos.length; i += 1) {
      current = `${scope} ⓘ ${infos[i]}`;
      const nth = infos.slice(0, i).filter((l) => l === infos[i]).length;
      const r = await dd('pressInfo', scope, infos[i], nth);
      await settle(200);
      const open = await dd('infoOpen');
      counts.infos += 1;
      if (!r || !open) check(`${scope} ⓘ "${infos[i]}" opens its box`, r, (v) => !!v && open);
      if (r && r.wide && !r.docked) check(`${scope} ⓘ "${infos[i]}" docks in the tutorial panel on a wide screen`, r, (v) => v.docked);
      await page.keyboard.press('Escape');
      await settle(150);
      const closed = !(await dd('infoOpen'));
      if (!closed) check(`${scope} ⓘ "${infos[i]}" closes on Esc`, closed, true);
    }
    return seen.size;
  }

  async function openEditor(track) {
    const open = await page.evaluate((id) => {
      const e = document.getElementById(`voice-editor-${id}`);
      if (e && !e.hidden) return true;
      document.getElementById(`voice-edit-toggle-${id}`)?.click();
      return false;
    }, track);
    if (!open) await page.waitForFunction((id) => { const e = document.getElementById(`voice-editor-${id}`); return !!e && !e.hidden && !!e.querySelector('.knob'); }, track, { timeout: 5000 }).catch(() => {});
    await settle(400);
    return page.evaluate((id) => { const e = document.getElementById(`voice-editor-${id}`); return !!e && !e.hidden; }, track);
  }

  // ---- Simple -----------------------------------------------------------------
  await page.click('#tab-simple');
  await settle(400);
  const simpleN = await sweepScope('#panel-simple', null);
  check('Simple has its dials', simpleN >= 3, (v) => v === true);

  // ---- Advanced, main panel ---------------------------------------------------
  await page.click('#tab-advanced');
  await settle(400);
  const mainN = await sweepScope('main', null);
  check('Advanced has its main dials (folds opened)', mainN >= 20, (v) => v === true);

  // ---- every built-in editor --------------------------------------------------
  const perEditor = {};
  for (const track of SCOPES_BUILTIN) {
    check(`the ${track} editor opens`, await openEditor(track), true);
    perEditor[track] = await sweepScope(`#voice-editor-${track}`, track);
    check(`the ${track} editor has its dials`, perEditor[track] >= 12, (v) => v === true);
  }

  // ---- tracks the user creates: one of each family ----------------------------
  for (const [fam, name] of [['melodic', 'Lead'], ['percussive', 'Hits']]) {
    current = `add track ${fam}`;
    const made = await page.evaluate(async ([fam, name]) => {
      const btn = document.getElementById('add-track');
      if (!btn) return { id: null, why: 'no Add track button' };
      const before = Object.keys(window.__ambi4Engine.getParams().tracks);
      btn.scrollIntoView({ block: 'center' });
      btn.click();
      await new Promise((r) => setTimeout(r, 150));
      document.getElementById('add-track-name').value = name;
      const radio = document.querySelector(`input[name="add-track-family"][value="${fam}"]`);
      if (radio) radio.click();
      document.getElementById('add-track-form').requestSubmit();
      await new Promise((r) => setTimeout(r, 600));
      const after = Object.keys(window.__ambi4Engine.getParams().tracks);
      return { id: after.find((id) => !before.includes(id)) || null, why: document.getElementById('add-track-error')?.textContent || '' };
    }, [fam, name]);
    check(`Add track makes a ${fam} track`, !!made.id, (v) => v === true);
    if (!made.id) continue;
    check(`the ${made.id} editor opens`, await openEditor(made.id), true);
    const labels = (await dd('keys', `#voice-editor-${made.id}`)).map((d) => d.label);
    if (fam === 'melodic') check('a melodic user track has all five D8 dials', ['Pan', 'Timing', 'Dynamics', 'Octave wander', 'Passing notes'].filter((l) => !labels.includes(l)), []);
    else check('a percussive user track shows Timing and Dynamics but no Pan, Octave wander or Passing notes', { has: ['Timing', 'Dynamics'].filter((l) => labels.includes(l)), not: ['Pan', 'Octave wander', 'Passing notes'].filter((l) => labels.includes(l)) }, { has: ['Timing', 'Dynamics'], not: [] });
    perEditor[made.id] = await sweepScope(`#voice-editor-${made.id}`, made.id);
    check(`the ${made.id} editor has its dials`, perEditor[made.id] >= 10, (v) => v === true);
  }

  // ---- D8 Auto on a patched SPREAD dial: a vertical turn keeps Auto ----------
  current = 'D8 patched centre';
  {
    const scope = '#voice-editor-melody';
    await openEditor('melody');
    await dd('unfold', scope);
    await settle(200);
    await dblclick(scope, 'Pan#1'); // back to Auto
    const t0 = await dd('track', 'melody');
    check('melody Pan starts patched to Randomness (Auto)', t0.macroPatch?.includes('pan') && t0.pan === 0, (v) => v === true);
    const turned = await drag(scope, 'Pan#1', 0, -30);
    const t1 = await dd('track', 'melody');
    check('a vertical turn on a patched Pan moves its centre and keeps the spread with Randomness', { text: turned?.text, patched: t1.macroPatch?.includes('pan'), pan: t1.pan }, (v) => /Auto/.test(v.text) && v.patched === true && typeof v.pan === 'number' && v.pan > 0);
    const spreadOut = await drag(scope, 'Pan#1', 60, 0);
    const t2 = await dd('track', 'melody');
    check('a sideways drag on it takes the spread over from Randomness', { text: spreadOut?.text, patched: t2.macroPatch?.includes('pan'), span: t2.pan && typeof t2.pan === 'object' }, (v) => !/Auto/.test(v.text) && v.patched === false && v.span === true);
    await dblclick(scope, 'Pan#1');
    // Dynamics is a scalar: ANY turn is its own value.
    await dblclick(scope, 'Dynamics#1');
    const dyn = await drag(scope, 'Dynamics#1', 0, -40);
    const t3 = await dd('track', 'melody');
    check('a turn on a patched Dynamics unpatches it and stores the number', { text: dyn?.text, patched: t3.macroPatch?.includes('dynamics'), dyn: t3.dynamics }, (v) => !/Auto/.test(v.text) && v.patched === false && near(v.dyn, dyn.now));
    await dblclick(scope, 'Dynamics#1');
    // Voice chance: Auto -> a number -> Auto, at the rule.
    await dblclick(scope, 'Voice chance#1');
    const vc = await drag(scope, 'Voice chance#1', 0, -40);
    const t4 = await dd('track', 'melody');
    check('Voice chance turned from Auto stores the rule chance and unpatches voiceWander', { text: vc?.text, patched: t4.macroPatch?.includes('voiceWander'), chance: t4.voiceRule?.chance, wander: t4.voiceWander }, (v) => !/Auto/.test(v.text) && v.patched === false && typeof v.chance === 'number' && near(v.chance, v.wander));
    await dblclick(scope, 'Voice chance#1');
  }

  // ---- the ledger -------------------------------------------------------------
  current = 'ledger';
  check('every dial answers a vertical drag at the engine', deaf, []);
  check('no readout disagrees with the engine', liars, []);
  check('every spreadable dial puts its span in the engine', spanLost, []);
  check('every single-valued dial says why it will not spread', silentRefusals, []);
  check('a typed value reaches the readout and the engine', typedLost, []);
  check('a double-click reset reaches the engine', resetLost, []);
  check('no page or console errors during the sweep', errors, []);
  note('dials tried', counts.dials);
  note('per scope', { simple: simpleN, main: mainN, ...perEditor });
  note('gestures', { dragged: counts.dragged, spread: counts.spread, refused: counts.refused, typed: counts.typed, reset: counts.reset, infos: counts.infos });
  note('hidden dials not reached', counts.hiddenSkipped);

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'dials-everywhere-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got, null, 1).slice(0, 4000)}\n      want ${JSON.stringify(r.want)}`).join('\n') +
      '\n  counts ' + JSON.stringify(counts),
    );
  }
  return { passed: results.length, notes: results.filter((r) => r.want === '(informational)').map((r) => `${r.name}: ${JSON.stringify(r.got)}`) };
}
