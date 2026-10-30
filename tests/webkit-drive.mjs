/**
 * Safari's engine: the same checks the other drives make, in a real WebKit.
 *
 *   npm run build && .vibe/measure.sh local drive tests/webkit-drive.mjs
 *
 * Every other drive runs in the harness's headless Chromium, and nothing the
 * owner's iPhone does was ever measured here: Playwright's WebKit build is
 * installed on the Mac test account, so this drive opens the SAME page in it
 * — a 1280 px desktop context and an iPhone one (390×844, touch, 3×, the
 * iPhone Safari user agent, under which Playwright's WebKit removes
 * Element.requestFullscreen exactly as iOS does) — and asserts at the ENGINE
 * (window.__ambi4Engine, the documented seam) and at the AudioContext itself
 * (captured by an init script before the page can make one).
 *
 * What it covers, per context: boot with no console/page errors; Play flips
 * the engine's running flag AND the context's state to 'running' (WebKit's
 * resume() semantics are the ones the RESUME_TIMEOUT_MS race exists for); the
 * pause fade and resume take the cancelAndHoldAtTime path, never the
 * cancelScheduledValues fallback (WebKit has had cancelAndHoldAtTime since
 * Safari 14.1 — the fallback anchors at a value read NOW and is wrong for a
 * future time); dials by mouse, by wheel, by keyboard and by a real finger
 * reach the engine; editors open and their dials answer; popovers open on
 * screen; a share link round-trips at the engine; settings survive a reload
 * from localStorage; the full-screen stage uses the native API on the
 * desktop and the pinned 100dvh fallback on the phone (the CSS the phone
 * fixes rely on — 100dvh, overscroll-behavior — must be supported AND
 * applied); and the three layout sweeps from .vibe/measure.sh (collisions,
 * overflows, clipped) run on the default page and one open editor, because
 * WebKit's font metrics are not Chromium's and a caption that fits there can
 * collide here.
 *
 * Playwright's WebKit touchscreen can tap but not swipe (no CDP), so the
 * finger here TAPS: Play, tabs, Edit, popovers, Exit, and a dial's hub (the
 * touch reset) — each asserted at the engine or the DOM, never by screenshot.
 */

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// measure.sh runs a drive from the shot folder on the Mac test account, the
// one that holds the Playwright the harness itself imports (and the WebKit
// build beside it), so the same install is resolved from the working
// directory rather than spelt out here.
const { webkit } = await import(pathToFileURL(join(process.cwd(), 'node_modules', 'playwright', 'index.mjs')).href);

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1';

const CONTEXTS = [
  { name: 'desktop', width: 1280, height: 900, touch: false, options: { viewport: { width: 1280, height: 900 } } },
  { name: 'iPhone', width: 390, height: 844, touch: true, options: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3, userAgent: IPHONE_UA } },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs in the page before any of its scripts: keeps every AudioContext the
 * page makes (its state is the one WebKit fact no engine flag can stand in
 * for), counts the two ways a param can be frozen, and logs what kind of
 * pointer each press arrived as.
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
  window.__wkRecorders = [];
  const MR = window.MediaRecorder;
  if (typeof MR === 'function') {
    const WrappedMR = function (...args) { const r = new MR(...args); window.__wkRecorders.push(r); return r; };
    WrappedMR.prototype = MR.prototype;
    WrappedMR.isTypeSupported = MR.isTypeSupported ? MR.isTypeSupported.bind(MR) : undefined;
    window.MediaRecorder = WrappedMR;
  }
  window.__wkPointers = [];
  document.addEventListener('pointerdown', (e) => {
    const k = e.target && e.target.closest ? e.target.closest('.knob') : null;
    window.__wkPointers.push({ type: e.pointerType, knob: k ? k.getAttribute('aria-label') : null });
  }, true);
};

// ---- the three sweeps, copied from .vibe/measure.sh (a drive is a data: URL
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
    browser = await webkit.launch();
  } catch (err) {
    throw new Error('webkit-drive: WebKit could not launch on the Mac test account: ' + (err && err.message ? err.message.split('\n').slice(0, 6).join(' | ') : String(err)));
  }
  notes.push({ webkit: browser.version() });

  try {
    for (const C of CONTEXTS) {
      const P = `[${C.name}]`;
      const ctx = await browser.newContext(C.options);
      await ctx.addInitScript(INIT);
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push('pageerror: ' + (e && e.message ? e.message : String(e))));
      page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
      // A press: the finger on the phone, the mouse on the desktop.
      const press = async (b) => (C.touch ? page.touchscreen.tap(b.x, b.y) : page.mouse.click(b.x, b.y));
      const pressSel = async (sel) => { const b = await boxOf(page, sel); if (!b) return false; await page.waitForTimeout(80); await press(b); return true; };

      // ---- boot ------------------------------------------------------------
      await page.goto('about:blank');
      await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
      const booted = await page.waitForSelector('#generator-app:not([hidden])', { timeout: 20000 }).then(() => true).catch(() => false);
      await page.waitForTimeout(600);
      check(`${P} the page boots`, booted, true);
      if (!booted) { check(`${P} boot errors`, errors, []); await ctx.close(); continue; }
      const env = await page.evaluate(() => ({
        ua: navigator.userAgent.includes('iPhone') ? 'iPhone' : 'Mac',
        AudioContext: typeof AudioContext, cancelAndHold: typeof AudioParam.prototype.cancelAndHoldAtTime,
        dvh: CSS.supports('height', '100dvh'), overscroll: CSS.supports('overscroll-behavior', 'contain'),
        requestFullscreen: typeof Element.prototype.requestFullscreen, exitFullscreen: typeof document.exitFullscreen,
        touchAction: CSS.supports('touch-action', 'none'), audioSession: typeof navigator.audioSession,
      }));
      notes.push({ P, env });
      check(`${P} WebKit has the APIs the engine relies on (AudioContext, cancelAndHoldAtTime)`, [env.AudioContext, env.cancelAndHold], ['function', 'function']);
      check(`${P} WebKit supports the CSS the phone fixes rely on (100dvh, overscroll-behavior, touch-action)`, [env.dvh, env.overscroll, env.touchAction], [true, true, true]);
      const v0 = await fits(page);
      check(`${P} the page lays out at the viewport's width (nothing wider, no zoom-out)`, [v0.vw, v0.sw <= v0.vw, v0.scale], [C.width, true, 1]);

      // ---- layout sweeps on the default page --------------------------------
      const s0 = await sweep(page);
      notes.push({ P, defaultSweep: { collisions: s0.collisions.length, overflows: s0.overflows.length, clipped: s0.clipped.length } });
      check(`${P} no text collisions on the default page`, s0.collisions.slice(0, 5), []);
      check(`${P} no text overflow on the default page`, s0.overflows.slice(0, 5), []);
      check(`${P} nothing clipped on the default page`, s0.clipped.slice(0, 5), []);

      // consent, by press
      await pressSel('#consent-slot button');
      await page.waitForTimeout(300);

      // ---- Play: the engine's flag AND the context's state ------------------
      const a0 = await audio(page);
      check(`${P} before Play the engine is not running`, a0.running, false);
      check(`${P} Play is pressable`, await pressSel('#toggle-play'), true);
      const a1 = await untilEngine(page, (a) => a.running && a.ctx.at(-1) === 'running');
      notes.push({ P, play: a1 });
      check(`${P} Play flips the engine's running flag`, a1.running, true);
      check(`${P} …and the AudioContext is 'running' (resume() settled, not left pending)`, a1.ctx.at(-1), 'running');
      check(`${P} …and the Play key reads pressed`, a1.pressed, 'true');
      check(`${P} one AudioContext, not a rebuild`, a1.ctx.length, 1);
      // iOS gets the media-element sink (mute switch, lock-screen controls);
      // everything else the direct route. The UA decides, and WebKit's
      // <audio srcObject> must actually play() — a rejected play() silently
      // rewires to direct, which getOutputInfo would show.
      check(`${P} the output route is the one this platform needs`, a1.out && a1.out.mode, C.touch ? 'element' : 'direct');
      // Safari 17+: the engine asks for the 'playback' audio session so iOS
      // plays through the mute switch. WebKit has the object; it must be set.
      if (env.audioSession === 'object') {
        check(`${P} the audio session was switched to 'playback' for the mute switch`, await page.evaluate(() => navigator.audioSession.type), 'playback');
      }
      const knobCss = await page.evaluate(() => {
        const k = document.querySelector('.knob');
        const cs = getComputedStyle(k);
        // -webkit-touch-callout is not in WebKit's computed style; noted, not asserted.
        return { touchAction: cs.touchAction, userSelect: cs.webkitUserSelect || cs.userSelect, callout: cs.getPropertyValue('-webkit-touch-callout') };
      });
      notes.push({ P, knobCss });
      check(`${P} a dial refuses WebKit's own gestures (touch-action none, no text selection)`, [knobCss.touchAction, knobCss.userSelect], ['none', 'none']);

      // ---- pause fade / resume: the hold path, never the fallback ----------
      await page.waitForTimeout(700);
      const h0 = (await audio(page)).hold;
      check(`${P} Pause is pressable`, await pressSel('#pause-toggle'), true);
      const a2 = await untilEngine(page, (a) => a.paused && a.ctx.at(-1) === 'suspended', 3000);
      notes.push({ P, pause: a2 });
      check(`${P} Pause holds the engine (paused, still running)`, [a2.paused, a2.running], [true, true]);
      check(`${P} …and the context suspends once the fade is done`, a2.ctx.at(-1), 'suspended');
      check(`${P} …via cancelAndHoldAtTime (the fallback was not taken)`, a2.hold.hold > h0.hold, (v) => v === true);
      await page.waitForTimeout(400);
      check(`${P} Resume is pressable`, await pressSel('#pause-toggle'), true);
      const a3 = await untilEngine(page, (a) => !a.paused && a.ctx.at(-1) === 'running', 3000);
      notes.push({ P, resume: a3 });
      check(`${P} Resume un-holds the engine`, [a3.paused, a3.running], [false, true]);
      check(`${P} …and the context runs again`, a3.ctx.at(-1), 'running');
      check(`${P} …via cancelAndHoldAtTime again`, a3.hold.hold > a2.hold.hold, (v) => v === true);
      check(`${P} …still on the same AudioContext`, a3.ctx.length, 1);

      // ---- dials: mouse, wheel, keyboard, finger -----------------------------
      await pressSel('#tab-advanced');
      await page.waitForTimeout(400);
      const ADV = '#panel-advanced';
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
      const t1 = await dragDial(ADV, 'Tempo', 0, 60);
      check(`${P} Tempo is reachable on the Advanced tab`, !!t1, (v) => v === true);
      const bpm1 = await engineBpm(page);
      check(`${P} a vertical mouse drag on Tempo reached the ENGINE`, JSON.stringify(bpm1) !== JSON.stringify(bpm0), (v) => v === true);
      await dragDial(ADV, 'Tempo', 70, 0);
      await page.waitForTimeout(800); // persistSettings is throttled
      const span = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem('ambi4:generator') || '{}').bpm ?? null; } catch { return null; } });
      check(`${P} a sideways drag opened a span (stored tree holds {min,max})`, span && typeof span === 'object' && span.max > span.min, (v) => v === true);
      const t2 = await boxOf(page, ADV, 'Tempo');
      await page.mouse.dblclick(t2.x + 22, t2.y);
      await page.waitForTimeout(400);
      const bpm3 = await engineBpm(page);
      check(`${P} a double-click on Tempo reset the span (ENGINE holds one value)`, typeof bpm3 === 'number', (v) => v === true);
      // wheel (a desktop thing: mobile WebKit has no wheel)
      let bpm4 = bpm3;
      if (!C.touch) {
        const t3 = await boxOf(page, ADV, 'Tempo');
        await page.mouse.move(t3.x, t3.y);
        // Ten notches: the Advanced Tempo dial steps 0.001 of its log scale
        // per notch, under a quarter of a bpm, and one notch rounds away in
        // EVERY browser (reported, not this drive's fault to hide).
        for (let i = 0; i < 10; i++) { await page.mouse.wheel(0, -120); await sleep(30); }
        await page.waitForTimeout(400);
        bpm4 = await engineBpm(page);
        check(`${P} a wheel over Tempo reached the ENGINE`, JSON.stringify(bpm4) !== JSON.stringify(bpm3), (v) => v === true);
      }
      // keyboard
      await page.evaluate(() => [...document.querySelectorAll('#panel-advanced .knob')].find((k) => k.getAttribute('aria-label') === 'Tempo').focus());
      for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowUp'); // see the wheel note
      await page.waitForTimeout(400);
      const bpm5 = await engineBpm(page);
      check(`${P} ArrowUp on a focused Tempo reached the ENGINE`, JSON.stringify(bpm5) !== JSON.stringify(bpm4), (v) => v === true);
      notes.push({ P, tempo: { bpm0, bpm1, span, bpm3, bpm4, bpm5 } });
      if (C.touch) {
        // A finger on the hub ZEROES the dial (the owner's hub-tap rule of
        // 2026-07-27; the reset is the double-tap). Tempo is off its floor
        // after the drags above, so the zero is visible at the engine.
        const d = await boxOf(page, ADV, 'Tempo');
        await page.waitForTimeout(80);
        const before = await engineBpm(page);
        await page.touchscreen.tap(d.x, d.y);
        await page.waitForTimeout(400);
        const after = await engineBpm(page);
        const seen = await page.evaluate(() => window.__wkPointers.filter((p) => p.knob === 'Tempo').map((p) => p.type));
        notes.push({ P, touchReset: { before, after, seen } });
        check(`${P} the finger arrived at the dial as a touch pointer`, seen.includes('touch'), (v) => v === true);
        check(`${P} a finger tap on Tempo's hub zeroed it at the ENGINE (20 bpm, the floor)`, [before !== 20, after], [true, 20]);
      }

      // ---- an editor opens, its dials answer, the layout holds ---------------
      const track = await page.evaluate(() => document.querySelector('.track-row')?.dataset.track || null);
      check(`${P} there is a track row`, !!track, (v) => v === true);
      if (track) {
        const scope = `#voice-editor-${track}`;
        check(`${P} Edit is pressable`, await pressSel(`.track-row[data-track="${track}"] .voice-edit-toggle`), true);
        await page.waitForTimeout(500);
        const open = await page.evaluate((s) => { const e = document.querySelector(s); return !!e && !e.hidden; }, scope);
        check(`${P} the ${track} editor opens`, open, true);
        if (open) {
          const vE = await fits(page);
          check(`${P} the open editor does not widen the page`, vE.sw <= vE.vw, (v) => v === true);
          const sE = await sweep(page);
          notes.push({ P, editorSweep: { collisions: sE.collisions.length, overflows: sE.overflows.length, clipped: sE.clipped.length } });
          check(`${P} no text collisions with the ${track} editor open`, sE.collisions.slice(0, 5), []);
          check(`${P} no text overflow with the ${track} editor open`, sE.overflows.slice(0, 5), []);
          check(`${P} nothing clipped with the ${track} editor open`, sE.clipped.slice(0, 5), []);
          const label = await page.evaluate((s) => {
            const visible = (el) => !el.closest('[hidden]') && el.getClientRects().length > 0;
            return [...document.querySelectorAll(`${s} .knob`)].filter(visible).map((k) => k.getAttribute('aria-label'))[0] || null;
          }, scope);
          check(`${P} the editor has a dial`, !!label, (v) => v === true);
          if (label) {
            const e0 = await engineJSON(page);
            const d0 = await boxOf(page, scope, label);
            await dragDial(scope, label, 0, -80);
            let e1 = await engineJSON(page);
            let d1 = await boxOf(page, scope, label);
            if (e1 === e0 && d1 && d1.valuetext === d0.valuetext) {
              await dragDial(scope, label, 0, 80); // at the top already
              e1 = await engineJSON(page);
              d1 = await boxOf(page, scope, label);
            }
            notes.push({ P, editorDial: { label, from: d0 && d0.valuetext, to: d1 && d1.valuetext } });
            check(`${P} the editor's ${label} dial moved its readout`, d1 && d1.valuetext !== d0.valuetext, (v) => v === true);
            check(`${P} …and the ENGINE received it`, e1 !== e0, (v) => v === true);
          }
          await pressSel(`.track-row[data-track="${track}"] .voice-edit-toggle`);
          await page.waitForTimeout(350);
          if (await page.evaluate(() => !!document.getElementById('leave-guard'))) {
            await pressSel('#leave-guard .leave-guard-move');
            await page.waitForTimeout(350);
          }
          check(`${P} the editor closes again`, await page.evaluate((s) => { const e = document.querySelector(s); return !e || e.hidden; }, scope), true);
        }
      }

      // ---- popovers open on screen ------------------------------------------
      for (const [toggleId, popId] of [['timers-toggle', 'timers-popover'], ['play-along-open', 'play-along']]) {
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(150);
        const pressed = await pressSel(`#${toggleId}`);
        await page.waitForTimeout(400);
        const box = await page.evaluate((id) => {
          const el = document.getElementById(id);
          if (!el || el.hidden) return null;
          const r = el.getBoundingClientRect();
          return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), vw: innerWidth, sw: document.documentElement.scrollWidth };
        }, popId);
        notes.push({ P, popover: { popId, box } });
        check(`${P} #${popId} opens`, pressed && !!box, (v) => v === true);
        if (box) {
          check(`${P} #${popId} is inside the screen's width`, box.left >= 0 && box.right <= box.vw && box.sw <= box.vw, (v) => v === true);
          if (C.touch && popId === 'play-along') {
            // A shorter phone: the popover is position:fixed below 560 px and
            // caps itself at calc(100dvh - 100px) — the dvh must RESOLVE in
            // WebKit, and whatever hangs below the screen must scroll itself.
            await page.setViewportSize({ width: C.width, height: 640 });
            await page.waitForTimeout(400);
            const short = await page.evaluate(() => {
              const p = document.getElementById('play-along');
              const r = p.getBoundingClientRect();
              const cs = getComputedStyle(p);
              return { bottom: Math.round(r.bottom), vh: innerHeight, maxH: cs.maxHeight, overflowY: cs.overflowY, scrollable: p.scrollHeight > p.clientHeight + 1 && /auto|scroll/.test(cs.overflowY) };
            });
            notes.push({ P, shortPhone: short });
            check(`${P} on a 640 px phone the Create popover's max-height resolved (100dvh is a number here)`, /^\d+(\.\d+)?px$/.test(short.maxH) && parseFloat(short.maxH) <= 640, (v) => v === true);
            check(`${P} …and its bottom is reachable (fits, or scrolls itself)`, short.bottom <= short.vh || short.scrollable, (v) => v === true);
            await page.setViewportSize({ width: C.width, height: C.height });
            await page.waitForTimeout(300);
            // The Words input under a software keyboard: WebKit shrinks the
            // viewport; the input must keep focus and its text.
            await page.selectOption('#create-write', 'words').catch(() => {});
            await page.waitForTimeout(300);
            const words = await boxOf(page, '#compose-words-text');
            check(`${P} the Words input is reachable`, !!words, (v) => v === true);
            if (words) {
              await page.waitForTimeout(80);
              await page.touchscreen.tap(words.x, words.y);
              await page.waitForTimeout(300);
              check(`${P} a tap focuses the Words input`, await page.evaluate(() => document.activeElement && document.activeElement.id), 'compose-words-text');
              await page.keyboard.type('moon river');
              await page.setViewportSize({ width: C.width, height: 400 });
              await page.waitForTimeout(400);
              const shrunk = await page.evaluate(() => {
                const el = document.getElementById('compose-words-text');
                return { focused: document.activeElement === el, value: el.value, sw: document.documentElement.scrollWidth, vw: innerWidth };
              });
              check(`${P} with the keyboard up the Words input keeps focus and its text`, [shrunk.focused, shrunk.value], [true, 'moon river']);
              check(`${P} …and the layout is still no wider than the phone`, shrunk.sw <= shrunk.vw, (v) => v === true);
              await page.setViewportSize({ width: C.width, height: C.height });
              await page.waitForTimeout(300);
            }
          }
          await page.keyboard.press('Escape');
          await page.waitForTimeout(300);
          let closed = await page.evaluate((id) => document.getElementById(id).hidden, popId);
          if (!closed) { await pressSel(`#${toggleId}`); await page.waitForTimeout(300); closed = await page.evaluate((id) => document.getElementById(id).hidden, popId); }
          check(`${P} #${popId} closes again`, closed, true);
        }
      }

      // ---- localStorage persistence across a reload --------------------------
      await pressSel('#tab-advanced');
      await page.waitForTimeout(300);
      await page.selectOption('#root', 'G');
      await page.waitForTimeout(900);
      const stored = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem('ambi4:generator') || '{}').root ?? null; } catch (e) { return 'ERR ' + e.message; } });
      check(`${P} a change lands in localStorage`, stored, 'G');
      await page.goto('about:blank');
      await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
      await page.waitForSelector('#generator-app:not([hidden])', { timeout: 20000 });
      await page.waitForTimeout(800);
      check(`${P} …and the ENGINE has it after a reload`, await page.evaluate(() => window.__ambi4Engine.getParams().root), 'G');
      check(`${P} …and the consent choice is remembered (no consent button)`, await page.evaluate(() => !document.querySelector('#consent-slot button')), true);

      // ---- share link round trip at the engine --------------------------------
      await pressSel('#tab-advanced');
      await page.waitForTimeout(300);
      await page.selectOption('#root', 'F');
      await page.selectOption('#mode', 'dorian');
      await page.waitForTimeout(600);
      const edited = await settingsNow(page);
      await page.evaluate(() => {
        window.__copied = null;
        navigator.clipboard.writeText = (text) => { window.__copied = text; return Promise.resolve(); };
      });
      await openFoldFor(page, '#preset-share');
      await pressSel('#preset-share');
      await page.waitForTimeout(800);
      const link = await page.evaluate(() => window.__copied);
      check(`${P} Share produced a link`, !!link, (v) => v === true);
      if (link) {
        check(`${P} the link is short enough to paste anywhere`, link.length < 2400, (v) => v === true);
        const localLink = await page.evaluate((u) => location.origin + location.pathname + new URL(u).hash, link);
        await page.goto('about:blank');
        await page.goto(localLink);
        await page.waitForTimeout(2500);
        check(`${P} the share link round-trips at the ENGINE`, await settingsNow(page), edited);
        const note = await page.evaluate(() => document.getElementById('share-note')?.textContent || '');
        check(`${P} …and the base was rebuilt, not substituted`, !/could not be rebuilt/.test(note), (v) => v === true);
      }

      // ---- full screen: native on the desktop, the pinned 100dvh stage on iOS -
      await page.evaluate(() => window.scrollTo(0, 0));
      check(`${P} the full-screen button is pressable`, await pressSel('#front-scope-fullscreen'), true);
      await page.waitForTimeout(1000);
      const fs = await page.evaluate(() => {
        const stage = document.getElementById('fullscreen-stage');
        const cs = getComputedStyle(stage);
        const exit = document.getElementById('fullscreen-exit')?.getBoundingClientRect();
        return {
          shown: !!stage && !stage.hidden,
          native: document.fullscreenElement === stage,
          pseudo: stage.dataset.pseudo !== undefined,
          rootFlag: document.documentElement.dataset.pseudoFullscreen !== undefined,
          position: cs.position, height: Math.round(stage.getBoundingClientRect().height), width: Math.round(stage.getBoundingClientRect().width),
          overscroll: cs.overscrollBehaviorY || cs.overscrollBehavior, bodyOverflow: getComputedStyle(document.body).overflow,
          exit: exit ? [Math.round(exit.left), Math.round(exit.top), Math.round(exit.right), Math.round(exit.bottom)] : null,
          vw: innerWidth, vh: innerHeight,
        };
      });
      notes.push({ P, fullscreen: fs });
      check(`${P} full screen opens`, fs.shown, true);
      if (fs.shown) {
        if (C.touch) {
          check(`${P} with no requestFullscreen (iPhone) the stage is the pinned fallback`, [fs.native, fs.pseudo, fs.rootFlag], [false, true, true]);
          check(`${P} …fixed over the whole viewport (100dvh applied)`, [fs.position, fs.width, fs.height], ['fixed', fs.vw, fs.vh]);
          check(`${P} …with overscroll contained and the page behind it not scrolling`, [fs.overscroll, fs.bodyOverflow], ['contain', 'hidden']);
        } else {
          check(`${P} the native Fullscreen API took the stage`, [fs.native, fs.pseudo], [true, false]);
        }
        check(`${P} …and the Exit button is on screen`, fs.exit && fs.exit[0] >= 0 && fs.exit[1] >= 0 && fs.exit[2] <= fs.vw && fs.exit[3] <= fs.vh, (v) => v === true);
        if (C.touch) {
          const exit = await boxOf(page, '#fullscreen-exit');
          if (exit) await page.touchscreen.tap(exit.x, exit.y);
        } else {
          await page.keyboard.press('Escape');
        }
        await page.waitForTimeout(800);
        const after = await page.evaluate(() => ({
          hidden: document.getElementById('fullscreen-stage').hidden,
          native: !!document.fullscreenElement,
          pseudo: document.getElementById('fullscreen-stage').dataset.pseudo !== undefined,
          rootFlag: document.documentElement.dataset.pseudoFullscreen !== undefined,
          scopeBack: !!document.querySelector('#fullscreen-slots .front-scope, #fullscreen-slots [id]') === false,
        }));
        check(`${P} …and ${C.touch ? 'Exit by finger' : 'Escape'} leaves it cleanly`, [after.hidden, after.native, after.pseudo, after.rootFlag], [true, false, false, false]);
      }

      const fin = await fits(page);
      check(`${P} the page is still no wider than the viewport at the end`, fin.sw <= fin.vw && fin.vw === C.width, (v) => v === true);
      check(`${P} no console errors or page errors`, errors, []);
      await ctx.close();
    }

    // ---- the record button, under the dev unlock (hidden pre-launch) ---------
    // Safari's MediaRecorder writes audio/mp4, not WebM. The file the page
    // hands the user must be named for the container it actually holds, or
    // nothing on the phone will open it.
    for (const C of CONTEXTS) {
      const P = `[${C.name} record]`;
      const ctx = await browser.newContext(C.options);
      await ctx.addInitScript(INIT);
      await ctx.addInitScript(() => { try { localStorage.setItem('ambi4:dev', '1'); } catch {} });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push('pageerror: ' + (e && e.message ? e.message : String(e))));
      page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
      const press = async (b) => (C.touch ? page.touchscreen.tap(b.x, b.y) : page.mouse.click(b.x, b.y));
      const pressSel = async (sel) => { const b = await boxOf(page, sel); if (!b) return false; await page.waitForTimeout(80); await press(b); return true; };
      await page.goto('about:blank');
      await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
      await page.waitForSelector('#generator-app:not([hidden])', { timeout: 20000 });
      await page.waitForTimeout(600);
      await pressSel('#consent-slot button');
      await page.waitForTimeout(300);
      await pressSel('#toggle-play');
      await untilEngine(page, (a) => a.running && a.ctx.at(-1) === 'running');
      await page.waitForTimeout(600);
      const rec = await page.evaluate(() => { const b = document.getElementById('record-toggle'); return b ? { hidden: b.hidden || !b.getClientRects().length, disabled: b.disabled } : null; });
      notes.push({ P, recordButton: rec });
      check(`${P} the record button is reachable under the dev unlock`, rec && !rec.hidden && !rec.disabled, (v) => v === true);
      if (rec && !rec.hidden && !rec.disabled) {
        await pressSel('#record-toggle');
        await page.waitForTimeout(1500);
        const mime = await page.evaluate(() => { const r = window.__wkRecorders.at(-1); return r ? { mimeType: r.mimeType, state: r.state } : null; });
        const download = page.waitForEvent('download', { timeout: 8000 }).then((d) => d.suggestedFilename()).catch((e) => 'NO DOWNLOAD: ' + e.message.split('\n')[0]);
        await pressSel('#record-toggle');
        const filename = await download;
        notes.push({ P, record: { mime, filename } });
        check(`${P} recording started (MediaRecorder recording)`, mime && mime.state, 'recording');
        check(`${P} stopping it hands the user a file`, typeof filename === 'string' && !filename.startsWith('NO DOWNLOAD'), (v) => v === true);
        if (mime && typeof filename === 'string') {
          const container = /mp4|aac|m4a/i.test(mime.mimeType) ? 'mp4' : /ogg/i.test(mime.mimeType) ? 'ogg' : /webm/i.test(mime.mimeType) ? 'webm' : mime.mimeType || 'unknown';
          const ext = (filename.match(/\.([a-z0-9]+)$/i) || [])[1] || '';
          const matches = container === 'mp4' ? /^(m4a|mp4)$/i.test(ext) : container === 'unknown' ? true : container === ext.toLowerCase();
          check(`${P} the file is named for the container WebKit actually wrote (${mime.mimeType || 'no mimeType'})`, { ext, container, matches }, (v) => v.matches === true);
        }
      }
      // The WAV tap (OfflineAudioContext-free: a capture off the output
      // analyser) is the other download; WebKit must hand over a .wav too.
      const wav = await page.evaluate(() => { const b = document.getElementById('wav-save'); return b ? { hidden: b.hidden || !b.getClientRects().length, disabled: b.disabled } : null; });
      check(`${P} the Save-as-WAV button is reachable under the dev unlock`, wav && !wav.hidden && !wav.disabled, (v) => v === true);
      if (wav && !wav.hidden && !wav.disabled) {
        await pressSel('#wav-save');
        await page.waitForTimeout(1500);
        const wavDownload = page.waitForEvent('download', { timeout: 8000 }).then((d) => d.suggestedFilename()).catch((e) => 'NO DOWNLOAD: ' + e.message.split('\n')[0]);
        await pressSel('#wav-save');
        const wavName = await wavDownload;
        const wavSaid = await page.evaluate(() => document.getElementById('wav-status')?.textContent || '');
        notes.push({ P, wav: { wavName, wavSaid } });
        check(`${P} stopping the WAV tap hands the user a .wav`, /\.wav$/i.test(wavName), (v) => v === true);
        check(`${P} …and says so`, /^Saved /.test(wavSaid), (v) => v === true);
      }
      check(`${P} no console errors or page errors`, errors, []);
      await ctx.close();
    }
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'webkit-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n') +
      '\n  notes ' + JSON.stringify(notes),
    );
  }
  return { passed: results.length, notes };
}
