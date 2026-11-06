/**
 * Firefox's engine: the checks that matter where Firefox differs, in a real
 * Gecko.
 *
 *   npm run build && .vibe/measure.sh local drive tests/firefox-drive.mjs
 *
 * Every other drive runs in Chromium, and webkit-drive in WebKit; nothing had
 * ever opened the app in Firefox. The difference that bit (2026-11-06):
 * Firefox has NO AudioParam.cancelAndHoldAtTime, so every hold the engine
 * makes takes its cancelScheduledValues fallback — the path no other drive
 * exercises. v0.0.294's reverb swap put an event inside a running value curve
 * on that path, which throws: two Reverb tail changes inside half a second
 * left a second reverb tail wired for the rest of the visit.
 *
 * Playwright's Firefox build (installed on the Mac test account beside its
 * WebKit) runs one desktop context. It asserts at the ENGINE
 * (window.__ambi4Engine) and at the AudioContext, captured by an init script:
 *   - boot with no console or page errors; the API facts (no cancelAndHold);
 *   - Play, Pause and Resume: running flag, context state, the FALLBACK taken;
 *   - the Reverb tail dial pressed in quick bursts while playing: no error,
 *     and once the fades are done exactly ONE convolver is still wired
 *     (every ConvolverNode the page makes is counted, and every full
 *     disconnect) — the leak the throw left is a second one;
 *   - Tempo by mouse drag, wheel and keyboard reaches the engine; an editor
 *     opens and its first dial reaches the engine;
 *   - a setting survives a reload from localStorage;
 *   - the three layout sweeps (Gecko's font metrics are its own).
 */

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// measure.sh runs a drive from the shot folder on the Mac test account, which
// holds the Playwright the harness imports and its browser builds.
const { firefox } = await import(pathToFileURL(join(process.cwd(), 'node_modules', 'playwright', 'index.mjs')).href);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs before the page's scripts: keeps every AudioContext, counts the two
 * ways a param is frozen, and counts convolvers made and fully disconnected.
 */
const INIT = () => {
  window.__wkCtxs = [];
  const AC = window.AudioContext;
  if (AC) {
    const Wrapped = function (...args) { const c = new AC(...args); window.__wkCtxs.push(c); return c; };
    Wrapped.prototype = AC.prototype;
    window.AudioContext = Wrapped;
  }
  window.__wkHold = { hold: 0, cancel: 0 };
  const P = window.AudioParam && window.AudioParam.prototype;
  if (P) {
    if (typeof P.cancelAndHoldAtTime === 'function') {
      const o = P.cancelAndHoldAtTime;
      P.cancelAndHoldAtTime = function (...a) { window.__wkHold.hold++; return o.apply(this, a); };
    }
    const oc = P.cancelScheduledValues;
    P.cancelScheduledValues = function (...a) { window.__wkHold.cancel++; return oc.apply(this, a); };
  }
  window.__ffConv = { made: 0, cut: 0 };
  const BAC = window.BaseAudioContext && window.BaseAudioContext.prototype;
  if (BAC && BAC.createConvolver) {
    const mk = BAC.createConvolver;
    BAC.createConvolver = function (...a) { const n = mk.apply(this, a); n.__ffCounted = true; window.__ffConv.made++; return n; };
  }
  const AN = window.AudioNode && window.AudioNode.prototype;
  if (AN) {
    const dc = AN.disconnect;
    AN.disconnect = function (...a) {
      if (this.__ffCounted && a.length === 0 && !this.__ffCut) { this.__ffCut = true; window.__ffConv.cut++; }
      return dc.apply(this, a);
    };
  }
};

// ---- the three layout sweeps (copied from webkit-drive / .vibe/measure.sh; a drive is shipped alone
// and cannot import them; keep them identical) --------------------------------

const OVERLAPS = () => {
  const leaves = [];
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('[hidden], [aria-hidden="true"]')) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) continue;
    const hasTextChild = [...el.children].some((c) => c.textContent.trim());
    if (hasTextChild) continue;
    const text = el.textContent.trim();
    if (!text) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const rects = [...el.getClientRects()].filter((q) => q.width >= 1 && q.height >= 1);
    const floating = cs.position === 'absolute' || cs.position === 'fixed';
    leaves.push({ el, r, rects: rects.length ? rects : [r], text: text.slice(0, 40), floating,
      sel: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : '') });
  }
  const out = [];
  for (let i = 0; i < leaves.length; i++) {
    for (let j = i + 1; j < leaves.length; j++) {
      const a = leaves[i], b = leaves[j];
      if (a.floating || b.floating) continue;
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      let ox = 0, oy = 0;
      for (const ra of a.rects) {
        for (const rb of b.rects) {
          const x = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
          const y = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
          if (x > 1 && y > 1 && x * y > ox * oy) { ox = x; oy = y; }
        }
      }
      if (ox > 1 && oy > 1) {
        out.push({ ox: +ox.toFixed(1), oy: +oy.toFixed(1),
          a: a.sel, aText: a.text, aRect: [Math.round(a.r.left), Math.round(a.r.top), Math.round(a.r.width), Math.round(a.r.height)],
          b: b.sel, bText: b.text, bRect: [Math.round(b.r.left), Math.round(b.r.top), Math.round(b.r.width), Math.round(b.r.height)] });
      }
    }
  }
  return out.sort((p, q) => q.ox * q.oy - p.ox * p.oy);
};

const OVERFLOWS = () => {
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('[hidden], [aria-hidden="true"]')) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) continue;
    if ([...el.children].some((c) => c.textContent.trim())) continue;
    const text = el.textContent.trim();
    if (!text) continue;
    if (cs.overflow !== 'visible' || cs.textOverflow === 'ellipsis') continue;
    const over = el.scrollWidth - el.clientWidth;
    if (over > 1 && el.clientWidth > 0) {
      out.push({ over, clientWidth: el.clientWidth, scrollWidth: el.scrollWidth, text: text.slice(0, 40),
        sel: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : '') });
    }
  }
  return out.sort((p, q) => q.over - p.over);
};

const CLIPPED = () => {
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('[hidden], [aria-hidden="true"]')) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) continue;
    if (cs.overflowX !== 'hidden' && cs.overflow !== 'hidden') continue;
    if (!el.textContent.trim()) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1) continue;
    let worst = 0;
    let victim = '';
    for (const child of el.querySelectorAll('*')) {
      if (!child.textContent.trim()) continue;
      const cr = child.getBoundingClientRect();
      if (cr.width < 1) continue;
      const past = Math.round(Math.max(cr.right - r.right, r.left - cr.left));
      if (past > worst) { worst = past; victim = child.textContent.trim().slice(0, 40); }
    }
    if (worst > 1) {
      out.push({ clippedBy: worst, victim, boxWidth: Math.round(r.width),
        sel: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : '') });
    }
  }
  return out.sort((p, q) => q.clippedBy - p.clippedBy);
};

const sweep = async (page) => ({
  collisions: await page.evaluate(`(${OVERLAPS.toString()})()`),
  overflows: await page.evaluate(`(${OVERFLOWS.toString()})()`),
  clipped: await page.evaluate(`(${CLIPPED.toString()})()`),
});

// ---- helpers ---------------------------------------------------------------

/**
 * The box of `sel` — or of the first VISIBLE .knob labelled `label` under
 * `sel` — after scrolling it to the middle of the viewport and re-reading it
 * (the recorded trap: page.mouse and the touchscreen are viewport-relative).
 * For a knob `x`/`y` aim at the dial's face centre.
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
    };
  }, [sel, label]);

const engineJSON = (page) => page.evaluate(() => JSON.stringify(window.__ambi4Engine.getParams()));
const engineBpm = (page) => page.evaluate(() => window.__ambi4Engine.getParams().bpm);
const settingsNow = (page) =>
  page.evaluate(() => {
    const p = window.__ambi4Engine.getParams();
    return JSON.stringify({
      bpm: p.bpm, root: p.root, mode: p.mode, structure: p.structure, complexity: p.complexity, harmony: p.harmony,
      levels: Object.fromEntries(Object.keys(p.tracks).map((k) => [k, p.tracks[k].level])),
    });
  });
const audio = (page) => page.evaluate(() => ({
  running: window.__ambi4Engine.running,
  paused: window.__ambi4Engine.paused,
  ctx: window.__wkCtxs.map((c) => c.state),
  out: window.__ambi4Engine.getOutputInfo(),
  hold: { ...window.__wkHold },
  pressed: document.getElementById('toggle-play').getAttribute('aria-pressed'),
}));
const fits = (page) => page.evaluate(() => ({ vw: innerWidth, sw: document.documentElement.scrollWidth, scale: visualViewport.scale }));
const openFoldFor = async (page, selector) => {
  const more = await page.evaluate((s) => (typeof window.__ambi4FoldMore === 'function' ? window.__ambi4FoldMore(s) : null), selector);
  if (more) { await page.click(more); await page.waitForTimeout(150); }
};
const untilEngine = async (page, pred, ms = 5000) => {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    last = await audio(page);
    if (pred(last)) return last;
    await sleep(100);
  }
  return last;
};

const convolvers = (page) => page.evaluate(() => ({ ...window.__ffConv }));

export default async function drive(harnessPage) {
  const results = [];
  const notes = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
  };
  const url = harnessPage.url();

  let browser;
  try {
    browser = await firefox.launch({ firefoxUserPrefs: { 'media.autoplay.default': 0, 'media.autoplay.block-webaudio': false } });
  } catch (err) {
    throw new Error('firefox-drive: Firefox could not launch on the Mac test account (playwright install firefox): ' + (err && err.message ? err.message.split('\n').slice(0, 6).join(' | ') : String(err)));
  }
  notes.push({ firefox: browser.version() });

  try {
    const P = '[firefox]';
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addInitScript(INIT);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push('pageerror: ' + (e && e.message ? e.message : String(e))));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    const pressSel = async (sel) => { const b = await boxOf(page, sel); if (!b) return false; await page.waitForTimeout(80); await page.mouse.click(b.x, b.y); return true; };

    // ---- boot -------------------------------------------------------------
    await page.goto('about:blank');
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    const booted = await page.waitForSelector('#generator-app:not([hidden])', { timeout: 20000 }).then(() => true).catch(() => false);
    await page.waitForTimeout(600);
    check(`${P} the page boots`, booted, true);
    if (booted) {
      const env = await page.evaluate(() => ({
        AudioContext: typeof AudioContext, cancelAndHold: typeof AudioParam.prototype.cancelAndHoldAtTime,
        curve: typeof AudioParam.prototype.setValueCurveAtTime,
      }));
      notes.push({ P, env });
      check(`${P} Firefox has AudioContext and value curves, and NO cancelAndHoldAtTime (the fallback is live here)`, [env.AudioContext, env.curve, env.cancelAndHold], ['function', 'function', 'undefined']);
      await pressSel('#consent-slot button');
      await page.waitForTimeout(300);
      const s0 = await sweep(page);
      check(`${P} no text collisions on the default page`, s0.collisions.slice(0, 5), []);
      check(`${P} no text overflow on the default page`, s0.overflows.slice(0, 5), []);
      check(`${P} nothing clipped on the default page`, s0.clipped.slice(0, 5), []);

      // ---- transport ------------------------------------------------------
      check(`${P} Play is pressable`, await pressSel('#toggle-play'), true);
      const a1 = await untilEngine(page, (a) => a.running && a.ctx.at(-1) === 'running');
      check(`${P} Play flips the engine's running flag and the context runs`, [a1.running, a1.ctx.at(-1)], [true, 'running']);
      check(`${P} one AudioContext`, a1.ctx.length, 1);
      await page.waitForTimeout(1500);
      const c0 = a1.hold.cancel;
      check(`${P} Pause is pressable`, await pressSel('#pause-toggle'), true);
      const a2 = await untilEngine(page, (a) => a.paused && a.ctx.at(-1) === 'suspended', 6000);
      check(`${P} Pause holds the engine and the context suspends`, [a2.paused, a2.running, a2.ctx.at(-1)], [true, true, 'suspended']);
      check(`${P} …via the cancelScheduledValues fallback`, a2.hold.cancel > c0, (v) => v === true);
      check(`${P} Resume is pressable`, await pressSel('#pause-toggle'), true);
      const a3 = await untilEngine(page, (a) => !a.paused && a.ctx.at(-1) === 'running', 6000);
      check(`${P} Resume un-holds the engine and the context runs again`, [a3.paused, a3.running, a3.ctx.at(-1)], [false, true, 'running']);

      // ---- the Reverb tail in quick bursts (the v0.0.294 throw) ------------
      await pressSel('#tab-advanced');
      await page.waitForTimeout(400);
      const ADV = '#panel-advanced';
      await openFoldFor(page, '#panel-advanced .knob[aria-label="Reverb tail"]');
      const rt = await boxOf(page, ADV, 'Reverb tail');
      check(`${P} the Reverb tail dial is reachable`, !!rt, (v) => v === true);
      if (rt) {
        await page.evaluate(() => [...document.querySelectorAll('#panel-advanced .knob')].find((k) => k.getAttribute('aria-label') === 'Reverb tail').focus());
        const tails = [];
        // Two presses 250-350 ms apart, five times over: each second press
        // lands after the 200 ms settle and inside the 0.5 s fade-in.
        for (let i = 0; i < 5; i++) {
          await page.keyboard.press('ArrowUp');
          await sleep(300);
          await page.keyboard.press('ArrowUp');
          await sleep(300);
          tails.push(await page.evaluate(() => [window.__ambi4Engine.getParams().reverbTail, [...document.querySelectorAll('#panel-advanced .knob')].find((k) => k.getAttribute('aria-label') === 'Reverb tail')?.getAttribute('aria-valuetext')]));
        }
        // Every outgoing fade lasts at most 2 s and is retired by its own
        // timer; a leaked tail never is. Poll rather than guess the wait.
        let cv = await convolvers(page);
        const t0 = Date.now();
        while (cv.made - cv.cut > 1 && Date.now() - t0 < 8000) { await sleep(250); cv = await convolvers(page); }
        cv.settledMs = Date.now() - t0;
        notes.push({ P, reverb: { tails, cv } });
        check(`${P} the Reverb tail presses reached the ENGINE`, new Set(tails.map((t) => String(t[0]))).size > 1, (v) => v === true);
        check(`${P} …and once every fade is done exactly ONE convolver is still wired`, cv.made - cv.cut, 1);
        check(`${P} …with no error on the way`, errors.filter((e) => /NotSupported|curve/i.test(e)), []);
      }

      // ---- dials ------------------------------------------------------------
      const dragDial = async (scope, label, dx, dy) => {
        const d = await boxOf(page, scope, label);
        if (!d) return null;
        await page.waitForTimeout(80);
        await page.mouse.move(d.x, d.y);
        await page.mouse.down();
        const steps = Math.max(Math.abs(dx), Math.abs(dy));
        for (let t = 4; t <= steps; t += 8) {
          const f = t / steps;
          await page.mouse.move(d.x + Math.round(dx * f), d.y + Math.round(dy * f));
        }
        await page.mouse.up();
        await page.waitForTimeout(320);
        return d;
      };
      const bpm0 = await engineBpm(page);
      check(`${P} Tempo is reachable on the Advanced tab`, !!(await dragDial(ADV, 'Tempo', 0, 60)), (v) => v === true);
      const bpm1 = await engineBpm(page);
      check(`${P} a vertical mouse drag on Tempo reached the ENGINE`, JSON.stringify(bpm1) !== JSON.stringify(bpm0), (v) => v === true);
      const t3 = await boxOf(page, ADV, 'Tempo');
      await page.mouse.move(t3.x, t3.y);
      for (let i = 0; i < 10; i++) { await page.mouse.wheel(0, -120); await sleep(30); }
      await page.waitForTimeout(400);
      const bpm2 = await engineBpm(page);
      check(`${P} a wheel over Tempo reached the ENGINE`, JSON.stringify(bpm2) !== JSON.stringify(bpm1), (v) => v === true);
      await page.evaluate(() => [...document.querySelectorAll('#panel-advanced .knob')].find((k) => k.getAttribute('aria-label') === 'Tempo').focus());
      for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowUp');
      await page.waitForTimeout(400);
      const bpm3 = await engineBpm(page);
      check(`${P} ArrowUp on a focused Tempo reached the ENGINE`, JSON.stringify(bpm3) !== JSON.stringify(bpm2), (v) => v === true);
      notes.push({ P, tempo: { bpm0, bpm1, bpm2, bpm3 } });

      // ---- an editor ----------------------------------------------------------
      const track = await page.evaluate(() => document.querySelector('.track-row')?.dataset.track || null);
      check(`${P} there is a track row`, !!track, (v) => v === true);
      if (track) {
        check(`${P} Edit is pressable`, await pressSel(`.track-row[data-track="${track}"] .voice-edit-toggle`), true);
        await page.waitForTimeout(500);
        const scope = `#voice-editor-${track}`;
        const open = await page.evaluate((s) => { const e = document.querySelector(s); return !!e && !e.hidden; }, scope);
        check(`${P} the ${track} editor opens`, open, true);
        if (open) {
          const sE = await sweep(page);
          check(`${P} no text collisions with the ${track} editor open`, sE.collisions.slice(0, 5), []);
          check(`${P} no text overflow with the ${track} editor open`, sE.overflows.slice(0, 5), []);
          check(`${P} nothing clipped with the ${track} editor open`, sE.clipped.slice(0, 5), []);
          const label = await page.evaluate((s) => {
            const k = [...document.querySelectorAll(`${s} .knob`)].find((el) => !el.closest('[hidden]') && el.getClientRects().length);
            return k ? k.getAttribute('aria-label') : null;
          }, scope);
          check(`${P} the editor has a dial`, !!label, (v) => v === true);
          if (label) {
            const e0 = await engineJSON(page);
            await dragDial(scope, label, 0, -80);
            const e1 = await engineJSON(page);
            check(`${P} the editor's ${label} dial reached the ENGINE`, e1 !== e0, (v) => v === true);
          }
        }
      }

      // ---- storage --------------------------------------------------------------
      await page.selectOption('#root', 'G').catch(() => {});
      await page.waitForTimeout(800);
      const stored = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem('ambi4:generator') || '{}').root ?? null; } catch { return null; } });
      check(`${P} a change lands in localStorage`, stored, 'G');
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForSelector('#generator-app:not([hidden])', { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(800);
      check(`${P} …and the ENGINE has it after a reload`, await page.evaluate(() => window.__ambi4Engine.getParams().root), 'G');
    }
    check(`${P} no console errors or page errors`, errors, []);
    await ctx.close();
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'firefox-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n') +
      '\n  notes ' + JSON.stringify(notes),
    );
  }
  return { passed: results.length, notes };
}
