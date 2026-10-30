/**
 * Layout states: the three geometry sweeps, run over every state the page can
 * be in, at every viewport that matters, in both themes.
 *
 *   npm run build && .vibe/measure.sh local drive tests/layout-states-drive.mjs
 *
 * `.vibe/measure.sh local overlaps [w h]` is the authority on layout, but it
 * measures ONE state at ONE viewport per run, and a sweep that has to be
 * invoked a hundred times by hand is a sweep that gets run once, on the
 * default page, in light mode, at 1280 wide. This drive is those hundred runs
 * in one: the same three sweeps (text-rect collisions, text overflowing its
 * own box, children painting past an overflow:hidden container), copied from
 * measure.sh so the two never disagree, run over
 *
 *   states     default page · Advanced tab · each track's editor open (six) ·
 *              the Timers popover · the Play-along popover · the guided tour on
 *              its first step · the full-screen bar
 *   viewports  1280×900 · 1024×768 · 768×1024 · 390×844 · 360×740
 *   themes     light · dark
 *
 * and three more checks the sweeps do not make: no horizontal page scroll (a
 * page wider than its viewport pans sideways under a thumb — at 390 wide the
 * genre row's processor readout measured the page at 468px, v0.0.284), tap
 * targets at least 24 px in both dimensions at the phone widths (WCAG 2.5.8)
 * for the PRIMARY controls — dials, tabs, buttons, selects, the track lamps —
 * and the version string present at the top and in the footer.
 *
 * Secondary targets smaller than 24 px (a dial's readout button, the step
 * sequencer's group dots, a chord chip's steppers, the oscilloscope's collapse
 * handle, the footer's inline links) are COUNTED and returned, not failed:
 * each is a design decision for the owner, not a regression, and a gate that
 * fails on a thousand of them is a gate nobody reads.
 *
 * One refinement on measure.sh's collision sweep: it skips a leaf whose OWN
 * position is absolute/fixed, so text INSIDE a popover (static leaves within
 * an absolutely positioned box) still "collides" with the page it is meant to
 * cover. Here a pair is compared only when both sides share the same nearest
 * floating ancestor — text inside one popover is still checked against other
 * text in that popover, but not against what is underneath it.
 *
 * States are entered and LEFT in one loaded page per theme × viewport (a
 * reload per state made the drive four and a half minutes long); every entry
 * and exit is verified against a marker, and a state that will not close is
 * reloaded away rather than leaking into the next sweep.
 *
 * Found red on v0.0.284: "Octave wander" and "Passing notes" (two feel dials
 * whose uppercase names are wider than the 84px cell, side by side) drew over
 * each other by 12px in every melody editor, and the phone widths scrolled
 * sideways. A collision is a fault whoever is on top; a fix lives in
 * index.astro's CSS, and the proof is this drive going green again.
 */

const VIEWPORTS = [[1280, 900], [1024, 768], [768, 1024], [390, 844], [360, 740]];
const THEMES = ['light', 'dark'];
const PHONE = (w) => w <= 390;
const TRACKS = ['pad', 'arp', 'melody', 'bass', 'texture', 'percussion'];

// Each state: how to reach it, how to tell it has been reached (a selector
// that must be visible), how to leave it, and how to tell it has been left.
const editorState = (track) => ({
  name: `editor-${track}`,
  enter: ['#tab-advanced', `#voice-edit-toggle-${track}`],
  reached: `#voice-editor-${track}:not([hidden])`,
  wait: 900,
  leave: [`#voice-edit-toggle-${track}`, '#tab-simple'],
  left: `#voice-editor-${track}[hidden]`,
});
const STATES = [
  { name: 'default', enter: [], reached: '#panel-simple:not([hidden])', leave: [], left: 'body' },
  { name: 'advanced', enter: ['#tab-advanced'], reached: '#panel-advanced:not([hidden])', leave: ['#tab-simple'], left: '#panel-advanced[hidden]' },
  ...TRACKS.map(editorState),
  { name: 'popover-timers', enter: ['#timers-toggle'], reached: '#timers-popover:not([hidden])', leave: ['Escape'], left: '#timers-popover[hidden]' },
  { name: 'popover-play-along', enter: ['#play-along-open'], reached: '#play-along:not([hidden])', leave: ['Escape'], left: '#play-along[hidden]' },
  { name: 'tour-step-1', enter: ['#tutorial-toggle'], reached: '#tutorial-panel:not([hidden])', wait: 700, leave: ['#tutorial-close', '#tab-simple'], left: '#tutorial-panel[hidden]' },
  { name: 'fullscreen', enter: ['#front-scope-fullscreen'], reached: '#fullscreen-bar', wait: 900, leave: ['Escape'], left: 'body' },
];

// Primary controls: a thumb must be able to land on these.
const PRIMARY = '.knob, [role="tab"], select, .secondary-button, .primary-button, .round-button, .track-lamp, .voice-edit-toggle, .play-toggle';

// ---- the three sweeps, as in .vibe/measure.sh ------------------------------

const SWEEPS = (PRIMARY) => {
  const selOf = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
    (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 4).join('.') : '');
  const hiddenBy = (el) => el.closest('[hidden], [aria-hidden="true"]');
  const shown = (cs) => !(cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0);
  const floatRoot = (el) => {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const p = getComputedStyle(n).position;
      if (p === 'absolute' || p === 'fixed') return n;
    }
    return null;
  };

  const leaves = [];
  for (const el of document.querySelectorAll('body *')) {
    if (hiddenBy(el)) continue;
    const cs = getComputedStyle(el);
    if (!shown(cs)) continue;
    if ([...el.children].some((c) => c.textContent.trim())) continue;
    const text = el.textContent.trim();
    if (!text) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const rects = [...el.getClientRects()].filter((q) => q.width >= 1 && q.height >= 1);
    leaves.push({ el, r, rects: rects.length ? rects : [r], text: text.slice(0, 40), root: floatRoot(el), sel: selOf(el) });
  }
  // Sorted by top edge so each leaf is compared only with the leaves that
  // start before it ends: the all-pairs loop made 120 sweeps take four
  // minutes on a page with a few thousand text leaves.
  leaves.sort((p, q) => p.r.top - q.r.top);
  const collisions = [];
  for (let i = 0; i < leaves.length; i++) {
    for (let j = i + 1; j < leaves.length; j++) {
      const a = leaves[i], b = leaves[j];
      if (b.r.top >= a.r.bottom) break;
      if (a.root !== b.root) continue;
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
        collisions.push({ ox: +ox.toFixed(1), oy: +oy.toFixed(1), a: a.sel, aText: a.text, b: b.sel, bText: b.text,
          aRect: [Math.round(a.r.left), Math.round(a.r.top), Math.round(a.r.width), Math.round(a.r.height)],
          bRect: [Math.round(b.r.left), Math.round(b.r.top), Math.round(b.r.width), Math.round(b.r.height)] });
      }
    }
  }

  const overflows = [];
  for (const el of document.querySelectorAll('body *')) {
    if (hiddenBy(el)) continue;
    const cs = getComputedStyle(el);
    if (!shown(cs)) continue;
    if ([...el.children].some((c) => c.textContent.trim())) continue;
    const text = el.textContent.trim();
    if (!text) continue;
    if (cs.overflow !== 'visible' || cs.textOverflow === 'ellipsis') continue;
    const over = el.scrollWidth - el.clientWidth;
    if (over > 1 && el.clientWidth > 0) overflows.push({ over, clientWidth: el.clientWidth, text: text.slice(0, 40), sel: selOf(el) });
  }

  const clipped = [];
  for (const el of document.querySelectorAll('body *')) {
    if (hiddenBy(el)) continue;
    const cs = getComputedStyle(el);
    if (!shown(cs)) continue;
    if (cs.overflowX !== 'hidden' && cs.overflow !== 'hidden') continue;
    if (!el.textContent.trim()) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1) continue;
    let worst = 0, victim = '';
    for (const child of el.querySelectorAll('*')) {
      if (!child.textContent.trim()) continue;
      const cr = child.getBoundingClientRect();
      if (cr.width < 1) continue;
      const past = Math.round(Math.max(cr.right - r.right, r.left - cr.left));
      if (past > worst) { worst = past; victim = child.textContent.trim().slice(0, 40); }
    }
    if (worst > 1) clipped.push({ clippedBy: worst, victim, boxWidth: Math.round(r.width), sel: selOf(el) });
  }

  // Tap targets. 24×24 is WCAG 2.5.8's minimum; the painted box is what the
  // finger gets. Primary controls fail; everything else is counted.
  const small = [];
  const advisory = {};
  for (const el of document.querySelectorAll('button, [role="button"], [role="slider"], .knob, select, input, a[href], [role="tab"]')) {
    if (hiddenBy(el)) continue;
    const cs = getComputedStyle(el);
    if (!shown(cs) || cs.pointerEvents === 'none') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    if (r.width >= 24 && r.height >= 24) continue;
    const sel = selOf(el);
    if (el.matches(PRIMARY)) small.push({ w: Math.round(r.width), h: Math.round(r.height), sel, text: (el.getAttribute('aria-label') || el.textContent.trim()).slice(0, 40) });
    else {
      const key = sel.replace(/#[^.]*/, '').split('.').slice(0, 2).join('.');
      const prev = advisory[key] || { count: 0, minW: 999, minH: 999 };
      advisory[key] = { count: prev.count + 1, minW: Math.min(prev.minW, Math.round(r.width)), minH: Math.min(prev.minH, Math.round(r.height)) };
    }
  }

  return {
    collisions: collisions.sort((p, q) => q.ox * q.oy - p.ox * p.oy),
    overflows: overflows.sort((p, q) => q.over - p.over),
    clipped: clipped.sort((p, q) => q.clippedBy - p.clippedBy),
    small,
    advisory,
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    topVersion: document.querySelector('.top-version')?.textContent.trim() || '',
    footVersion: document.querySelector('.site-footer .build-stamp')?.textContent.trim() || '',
  };
};

export default async function drive(page) {
  const url = page.url();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + (e && e.message ? e.message : String(e))));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  const findings = [];
  const swept = [];
  const seen = new Set();
  const advisory = {};
  const note = (where, kind, detail) => {
    // One line per distinct fault per state: the same collision in both
    // themes is one fault to fix, and the list should say so once.
    const key = kind + '|' + where.replace(/^(light|dark) /, '') + '|' + JSON.stringify(detail);
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ where, kind, detail });
  };

  const fresh = async () => {
    // Fragment-only navigation does not reload, so about:blank first.
    await page.goto('about:blank');
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForSelector('#generator-app:not([hidden])', { timeout: 20000 }).catch(() => {});
    await page.click('#consent-slot button:has-text("Save on this device")', { timeout: 1500 }).catch(() => {});
    await page.waitForTimeout(200);
  };
  const act = async (step) => {
    if (step === 'Escape') { await page.keyboard.press('Escape'); return true; }
    await page.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: 'center' }), step);
    return page.click(step, { timeout: 5000 }).then(() => true).catch(() => false);
  };
  const visible = (sel) => page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }, sel);

  for (const theme of THEMES) {
    await page.emulateMedia({ colorScheme: theme });
    for (const [w, h] of VIEWPORTS) {
      await page.setViewportSize({ width: w, height: h });
      await fresh();
      for (const state of STATES) {
        const where = `${theme} ${w}x${h} ${state.name}`;
        let reached = true;
        for (const step of state.enter) {
          if (!(await act(step))) { reached = false; note(where, 'unreachable', { click: step }); break; }
          await page.waitForTimeout(250);
        }
        await page.waitForTimeout(state.wait || 500);
        if (reached && !(await visible(state.reached))) { reached = false; note(where, 'unreachable', { expected: state.reached }); }

        if (reached) {
          const r = await page.evaluate(`(${SWEEPS.toString()})(${JSON.stringify(PRIMARY)})`);
          swept.push({ where, collisions: r.collisions.length, overflows: r.overflows.length, clipped: r.clipped.length, small: r.small.length, scrollWidth: r.scrollWidth });
          for (const c of r.collisions) note(where, 'collision', c);
          for (const o of r.overflows) note(where, 'overflow', o);
          for (const c of r.clipped) note(where, 'clipped', c);
          if (r.scrollWidth > r.innerWidth + 1) note(where, 'horizontal-scroll', { scrollWidth: r.scrollWidth, innerWidth: r.innerWidth });
          if (PHONE(w)) {
            for (const s of r.small) note(where, 'tap-target', s);
            for (const [k, v] of Object.entries(r.advisory)) {
              const prev = advisory[k] || { count: 0, minW: 999, minH: 999 };
              advisory[k] = { count: Math.max(prev.count, v.count), minW: Math.min(prev.minW, v.minW), minH: Math.min(prev.minH, v.minH) };
            }
          }
          if (!/^v\d+\.\d+\.\d+$/.test(r.topVersion)) note(where, 'version', { top: r.topVersion });
          if (!/^v\d+\.\d+\.\d+ /.test(r.footVersion)) note(where, 'version', { footer: r.footVersion });
        }

        // Leave. Headless Chromium keeps the WINDOW full-screen after the
        // document leaves it and refuses the next setViewportSize until it is
        // restored, so full screen is left by the API as well as the key.
        for (const step of state.leave) { await act(step); await page.waitForTimeout(250); }
        await page.evaluate(() => document.fullscreenElement && document.exitFullscreen()).catch(() => {});
        await page.waitForTimeout(300);
        const closed = state.left === 'body' || await page.evaluate((s) => !!document.querySelector(s), state.left);
        if (!closed) { note(where, 'stuck', { expected: state.left }); await fresh(); }
      }
    }
  }

  const pageErrors = errors.filter((e) => !/favicon|net::ERR_|Failed to load resource/.test(e));

  if (findings.length || pageErrors.length) {
    const byKind = {};
    for (const f of findings) byKind[f.kind] = (byKind[f.kind] || 0) + 1;
    throw new Error(
      `layout-states-drive: ${findings.length} findings (${JSON.stringify(byKind)}) over ${swept.length} sweeps` +
      (pageErrors.length ? `, ${pageErrors.length} page errors` : '') + '\n' +
      findings.slice(0, 60).map((f) => `  ✗ [${f.kind}] ${f.where}: ${JSON.stringify(f.detail)}`).join('\n') +
      (findings.length > 60 ? `\n  … and ${findings.length - 60} more` : '') +
      (pageErrors.length ? '\n' + pageErrors.slice(0, 10).map((e) => '  ! ' + e).join('\n') : '') +
      '\n  secondary targets under 24px (advisory): ' + JSON.stringify(advisory),
    );
  }
  return { passed: swept.length, states: STATES.length, viewports: VIEWPORTS.length, themes: THEMES.length,
    notes: ['secondary targets under 24px at phone widths (advisory, not failed): ' + JSON.stringify(advisory)] };
}
