/**
 * Accessibility, measured — in a real headless Chromium against the built page.
 *
 *   npm run build && .vibe/measure.sh local drive tests/a11y-drive.mjs
 *
 * Nobody in this container can hear a screen reader, so this file measures
 * what one would be handed, scene by scene (the default page, Advanced, a
 * melodic editor, a percussive editor, the Create popover, the Timers popover
 * and the guided tour), in BOTH themes:
 *
 *   1. every interactive or focusable element has an accessible name — read
 *      from Chromium's OWN accessibility tree (CDP Accessibility.getFullAXTree),
 *      not from a re-implementation of the name algorithm;
 *   2. every dial carries aria-valuenow/min/max/valuetext, the valuetext says
 *      what the visible readout says, and aria-valuenow is the engine's stored
 *      number after a drag and after a keyboard reset — a readout drawing a
 *      value the engine never received is the fault the owner has hit twice;
 *   3. text contrast: for every visible text leaf, its colour against the
 *      effective background (walked up with alpha blending), below 4.5:1 for
 *      normal text and 3:1 for large/bold text; the worst twenty are listed
 *      with selectors and the :root token each colour came from, and anything
 *      under 3:1 fails;
 *   4. focus-visible: every keyboard-reachable control shows a focus
 *      indicator — its outline, box-shadow, border, background or colour (or
 *      its label's, for a visually-hidden radio) differs from its unfocused
 *      computed style;
 *   5. no duplicate ids;
 *   6. live regions: the line under the dials (sayUnderDials) is an aria-live
 *      region and a refusal lands IN it; the page's status lines are live;
 *   7. prefers-reduced-motion: every CSS animation the page declares is
 *      silenced under the media query, and the canvas animations slow down
 *      (paint calls per second on each canvas, measured with and without the
 *      preference);
 *   8. the page at 200% zoom (a 640px viewport, and CSS zoom 2 at 1280) does
 *      not scroll sideways and no visible element paints past the right edge.
 *
 * Traps honoured (CLAUDE.md): about:blank before the real load; genre pinned
 * and verified at the engine; every box re-read after scrollIntoView; editor
 * queries scoped to #voice-editor-<track>; page and console errors fail the run.
 */

/** Dials whose aria-valuenow IS an engine number: label -> getter path. */
const ENGINE_OF = {
  main: { Volume: { path: 'volume', via: 'dB' }, Swing: 'swing', 'Reverb tail': 'reverbTail', Complexity: 'complexity', Reprise: 'repetition' },
  track: { Level: 'level', Randomness: 'randomness', Glide: 'glide', 'Drift rate': 'driftRate', Dissonance: 'dissonance', Pan: 'pan', Timing: 'timing', Dynamics: 'dynamics', 'Octave wander': 'octaveWander' },
};

const INTERACTIVE_ROLES = new Set(['button', 'slider', 'textbox', 'combobox', 'checkbox', 'radio', 'tab', 'link', 'switch', 'spinbutton', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'listbox', 'searchbox', 'tabpanel', 'dialog', 'option']);

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
  const notes = [];

  const url = page.url();
  page.on('pageerror', (e) => errors.push(`[${current}] pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${current}] console: ${m.text()}`); });

  // Canvas paint counter for check 7, installed before any load so the scope
  // and the visualiser are counted from their first frame.
  await page.addInitScript(() => {
    const counts = new Map();
    const bump = (ctx) => {
      const c = ctx && ctx.canvas;
      const key = c ? (c.id || c.className || 'canvas') : 'offscreen';
      counts.set(key, (counts.get(key) || 0) + 1);
    };
    for (const m of ['clearRect', 'fillRect', 'stroke', 'fill', 'drawImage', 'putImageData', 'fillText']) {
      const orig = CanvasRenderingContext2D.prototype[m];
      if (typeof orig !== 'function') continue;
      CanvasRenderingContext2D.prototype[m] = function (...a) { bump(this); return orig.apply(this, a); };
    }
    window.__a11yPaints = () => Object.fromEntries(counts);
    window.__a11yPaintsReset = () => counts.clear();
  });

  const load = async () => {
    await page.goto('about:blank');
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForSelector('#generator-app:not([hidden])', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(400);
    await page.click('#consent-slot button:has-text("Save on this device")').catch(() => {});
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      const sel = document.getElementById('genre-select');
      const opt = [...sel.options].find((o) => o.value === 'g:synthwave');
      if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
    });
    const pinned = await page.waitForFunction(() => window.__ambi4Engine?.getParams?.()?.tracks?.pad?.voice === 'polysaw', { timeout: 5000 }).then(() => true).catch(() => false);
    if (!pinned) throw new Error('a11y-drive: the Synthwave pin did not apply');
    await page.evaluate(() => { try { window.__ambi4Governor?.setTier?.('full'); } catch {} });
    await page.waitForTimeout(300);
    await installHelpers();
  };

  // ---- in-page helpers -----------------------------------------------------
  const installHelpers = () => page.evaluate(() => {
    const vis = (el) => {
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        if (n.hidden || n.getAttribute?.('aria-hidden') === 'true') return false;
        const cs = getComputedStyle(n);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      }
      return true;
    };
    const selOf = (el) => {
      const own = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : '');
      if (el.id) return own;
      const anc = el.parentElement?.closest('[id]');
      return (anc ? `#${anc.id} ` : '') + own;
    };
    const parse = (s) => {
      const m = /rgba?\(([^)]+)\)/.exec(s || '');
      if (!m) return s === 'transparent' || !s ? [0, 0, 0, 0] : null;
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
    };
    const over = (top, bot) => {
      const a = top[3] + bot[3] * (1 - top[3]);
      if (a === 0) return [0, 0, 0, 0];
      return [0, 1, 2].map((i) => (top[i] * top[3] + bot[i] * bot[3] * (1 - top[3])) / a).concat([a]);
    };
    const lum = (c) => {
      const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    };
    const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
    const hex = (c) => '#' + [0, 1, 2].map((i) => Math.round(c[i]).toString(16).padStart(2, '0')).join('');

    // The :root tokens, resolved for the active theme, so a failing colour can
    // be named by the variable that set it.
    const tokens = () => {
      const names = new Set();
      for (const sheet of document.styleSheets) {
        let rules; try { rules = sheet.cssRules; } catch { continue; }
        const walk = (list) => { for (const r of list) { if (r.cssRules) walk(r.cssRules); if (r.selectorText && /:root/.test(r.selectorText)) for (const p of r.style) if (p.startsWith('--')) names.add(p); } };
        walk(rules);
      }
      const cs = getComputedStyle(document.documentElement);
      const probe = document.createElement('div');
      document.body.appendChild(probe);
      const out = [];
      for (const n of names) {
        const raw = cs.getPropertyValue(n).trim();
        if (!raw) continue;
        probe.style.color = '';
        probe.style.color = raw;
        if (!probe.style.color) continue;
        const c = parse(getComputedStyle(probe).color);
        if (c) out.push([n, c]);
      }
      probe.remove();
      return out;
    };
    const tokenFor = (c, toks) => {
      const hit = toks.find(([, t]) => Math.abs(t[0] - c[0]) < 1.5 && Math.abs(t[1] - c[1]) < 1.5 && Math.abs(t[2] - c[2]) < 1.5);
      return hit ? hit[0] : '';
    };

    const root = (scope) => (scope ? document.querySelector(scope) : document.body);

    window.__a11y = {
      open: (scope) => { const r = root(scope); return !!r && vis(r); },

      dupIds: () => {
        const m = new Map();
        for (const e of document.querySelectorAll('[id]')) m.set(e.id, (m.get(e.id) || 0) + 1);
        return [...m].filter(([, v]) => v > 1).map(([k, v]) => `${k} x${v}`);
      },

      // (1) tag every candidate so the AX tree's nodes can be mapped back.
      tagCandidates: (scope) => {
        const r = root(scope);
        let n = 0;
        for (const el of document.querySelectorAll('[data-a11y-idx]')) el.removeAttribute('data-a11y-idx');
        for (const el of r.querySelectorAll('button, [role], input, select, textarea, a[href], [tabindex], summary')) {
          if (!vis(el)) continue;
          el.setAttribute('data-a11y-idx', String(n++));
        }
        return n;
      },
      describe: (idx) => {
        const el = document.querySelector(`[data-a11y-idx="${idx}"]`);
        if (!el) return null;
        return { sel: selOf(el), role: el.getAttribute('role') || el.tagName.toLowerCase(), text: (el.textContent || '').trim().slice(0, 30), title: el.getAttribute('title') || '', tabindex: el.getAttribute('tabindex') };
      },

      // (2) dials in a scope.
      dials: (scope, exclEditors) => {
        const r = root(scope);
        const count = new Map();
        return [...r.querySelectorAll('.knob')].filter((k) => vis(k) && !(exclEditors && k.closest('[id^="voice-editor-"]'))).map((k) => {
          const label = k.getAttribute('aria-label') || '?';
          const n = (count.get(label) || 0) + 1; count.set(label, n);
          return { key: `${label}#${n}`, label, field: k.closest('[data-field]')?.dataset.field || null, where: k.closest('[id]')?.id || '' };
        });
      },
      dialState: (scope, key, exclEditors, scroll) => {
        const r = root(scope);
        const count = new Map();
        let k = null;
        for (const el of r.querySelectorAll('.knob')) {
          if (!vis(el) || (exclEditors && el.closest('[id^="voice-editor-"]'))) continue;
          const label = el.getAttribute('aria-label') || '?';
          const n = (count.get(label) || 0) + 1; count.set(label, n);
          if (`${label}#${n}` === key) { k = el; break; }
        }
        if (!k) return null;
        if (scroll) k.scrollIntoView({ block: 'center' });
        const rect = k.getBoundingClientRect();
        return {
          x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.width / 2),
          role: k.getAttribute('role'), tabindex: k.getAttribute('tabindex'),
          now: k.getAttribute('aria-valuenow'), min: k.getAttribute('aria-valuemin'), max: k.getAttribute('aria-valuemax'),
          valuetext: k.getAttribute('aria-valuetext'), text: k.querySelector('.knob-value')?.textContent?.trim() || '',
          focused: document.activeElement === k,
        };
      },
      focusDial: (scope, key, exclEditors) => {
        const s = window.__a11y.dialState(scope, key, exclEditors, true);
        if (!s) return false;
        const count = new Map();
        for (const el of root(scope).querySelectorAll('.knob')) {
          if (!vis(el) || (exclEditors && el.closest('[id^="voice-editor-"]'))) continue;
          const label = el.getAttribute('aria-label') || '?';
          const n = (count.get(label) || 0) + 1; count.set(label, n);
          if (`${label}#${n}` === key) { el.focus(); return document.activeElement === el; }
        }
        return false;
      },
      engine: (path, track) => {
        const p = window.__ambi4Engine.getParams();
        const o = track ? p.tracks[track] : p;
        return o ? o[path] : undefined;
      },
      unfold: (scope) => {
        const r = root(scope);
        let n = 0;
        const sel = scope === '#panel-advanced' ? '[id^="adv-more-"]:not([id^="adv-more-box-"])' : 'button.rule-more, button.ve-more';
        for (const b of r.querySelectorAll(sel)) {
          if (b.getAttribute('aria-expanded') === 'true' || !vis(b)) continue;
          b.click(); n += 1;
        }
        return n;
      },

      // (3) contrast sweep.
      contrast: (scope) => {
        const r = root(scope);
        const toks = tokens();
        const out = [];
        let leaves = 0, uncertain = 0;
        for (const el of r.querySelectorAll('*')) {
          if (el.closest('[hidden], [aria-hidden="true"]')) continue;
          if (['SCRIPT', 'STYLE', 'SVG', 'OPTION', 'TEMPLATE'].includes(el.tagName)) continue;
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) continue;
          const ownText = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
          if (!ownText) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width < 2 || rect.height < 2) continue;
          if (!vis(el)) continue;
          leaves += 1;
          let fg = parse(cs.color);
          if (!fg || fg[3] === 0) continue;
          // Compose the background from the outside in.
          const chain = [];
          for (let n = el; n; n = n.parentElement) chain.push(n);
          chain.reverse();
          let bg = [255, 255, 255, 1];
          if (cs.colorScheme && /dark/.test(getComputedStyle(document.documentElement).colorScheme)) bg = [0, 0, 0, 1];
          let image = false;
          let opacity = 1;
          for (const n of chain) {
            const s = n === el ? cs : getComputedStyle(n);
            opacity *= +s.opacity || 1;
            const c = parse(s.backgroundColor);
            if (c && c[3] > 0) bg = over([c[0], c[1], c[2], c[3] * (+s.opacity || 1)], bg);
            if (s.backgroundImage && s.backgroundImage !== 'none') {
              // A gradient's stops are known: their mean, blended over what
              // is beneath, is the face the text sits on (approximate — a
              // steep gradient's ends differ from its mean). A url() image is
              // not readable from here and leaves the result uncertain.
              const stops = [...s.backgroundImage.matchAll(/rgba?\([^)]+\)/g)].map((m) => parse(m[0])).filter(Boolean);
              if (/gradient\(/.test(s.backgroundImage) && stops.length) {
                const mean = [0, 1, 2, 3].map((i) => stops.reduce((t, q) => t + q[i], 0) / stops.length);
                bg = over([mean[0], mean[1], mean[2], mean[3] * (+s.opacity || 1)], bg);
              } else image = true;
            }
          }
          fg = over([fg[0], fg[1], fg[2], fg[3] * opacity], bg);
          const size = parseFloat(cs.fontSize);
          const weight = parseInt(cs.fontWeight, 10) || 400;
          const large = size >= 24 || (size >= 18.66 && weight >= 700);
          const need = large ? 3 : 4.5;
          const rt = ratio(fg, bg);
          const disabled = !!(el.closest(':disabled, [aria-disabled="true"], [disabled]'));
          if (image) uncertain += 1;
          if (rt < need && !image) {
            out.push({ sel: selOf(el), text: ownText.slice(0, 32), ratio: +rt.toFixed(2), need, fg: hex(fg), bg: hex(bg), fgToken: tokenFor(fg, toks), bgToken: tokenFor(bg, toks), size: +size.toFixed(1), weight, image, disabled });
          }
        }
        out.sort((a, b) => a.ratio - b.ratio);
        return { leaves, uncertain, fails: out };
      },

      // (4) focus-visible: Chromium shows :focus-visible on a scripted
      // focus() once the last interaction was a key press, which the drive
      // guarantees with a Tab before calling this.
      focusSweep: (scope, cap) => {
        const r = root(scope);
        const sig = (el) => {
          if (!el) return '';
          const s = getComputedStyle(el);
          return [s.outlineStyle, s.outlineWidth, s.outlineColor, s.boxShadow, s.borderColor, s.backgroundColor, s.color, s.textDecorationLine, s.filter, s.transform].join('|');
        };
        const partners = (el) => {
          const list = [el, el.parentElement, el.nextElementSibling];
          if (el.id) for (const l of document.querySelectorAll(`label[for="${CSS.escape(el.id)}"]`)) list.push(l);
          return list.filter(Boolean);
        };
        const missing = [];
        const unfocusable = [];
        let tested = 0;
        let focusVisible = 0;
        const candidates = [...r.querySelectorAll('button, [role], input, select, textarea, a[href], [tabindex], summary')]
          .filter((el) => vis(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true' && el.tabIndex >= 0 && !el.closest('[inert]'));
        const seen = new Map(); // one per selector shape, so a 64-step grid counts once
        for (const el of candidates) {
          const shape = selOf(el).replace(/#[^ .]+/g, '#*') + '|' + (el.getAttribute('aria-label') || '').slice(0, 8);
          if (seen.has(shape) && seen.get(shape) >= 3) continue;
          seen.set(shape, (seen.get(shape) || 0) + 1);
          if (tested >= cap) break;
          const before = partners(el).map(sig);
          el.focus({ preventScroll: true });
          if (document.activeElement !== el) { unfocusable.push(selOf(el)); continue; }
          tested += 1;
          const fv = el.matches(':focus-visible');
          if (fv) focusVisible += 1;
          const after = partners(el).map(sig);
          const changed = after.some((s, i) => s !== before[i]);
          if (!changed) missing.push({ sel: selOf(el), fv, label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30) });
          el.blur();
        }
        return { tested, candidates: candidates.length, missing, unfocusable, focusVisible };
      },

      // (6) live regions.
      live: () => {
        const liveOf = (el) => {
          for (let n = el; n && n !== document.body; n = n.parentElement) {
            const l = n.getAttribute('aria-live');
            if (l && l !== 'off') return l;
            const role = n.getAttribute('role');
            if (role === 'status' || role === 'log') return 'polite';
            if (role === 'alert') return 'assertive';
          }
          return null;
        };
        const el = document.getElementById('dial-confirm');
        const statusIds = ['transport-status', 'record-status', 'wav-status', 'processor-warning', 'genre-rules-error', 'guided-tip'];
        return {
          dialConfirmLive: el ? liveOf(el) : 'missing',
          dialConfirmText: el?.textContent?.trim() || '',
          statuses: statusIds.map((id) => [id, document.getElementById(id) ? liveOf(document.getElementById(id)) : 'missing']),
        };
      },

      // (7) animations declared by the page, and whether a reduced-motion
      // rule silences each.
      animations: () => {
        const declared = new Map();
        const silenced = new Set();
        const walk = (list, inReduce) => {
          for (const r of list) {
            if (r.cssRules && !r.selectorText && !(r instanceof CSSKeyframesRule)) {
              const cond = r.conditionText || r.media?.mediaText || '';
              walk(r.cssRules, inReduce || /prefers-reduced-motion:\s*reduce/.test(cond));
              continue;
            }
            if (!r.style || !r.selectorText) continue;
            const an = r.style.animationName;
            const dur = r.style.animationDuration;
            if (an && an !== 'none') {
              if (inReduce) silenced.add(r.selectorText);
              else declared.set(r.selectorText, `${an} ${dur}`);
            } else if (inReduce && (an === 'none' || (dur && /^0s?$/.test(dur)))) silenced.add(r.selectorText);
          }
        };
        for (const sheet of document.styleSheets) { let rules; try { rules = sheet.cssRules; } catch { continue; } walk(rules, false); }
        return { declared: [...declared].map(([s, a]) => ({ selector: s, animation: a, silenced: silenced.has(s) })), reduce: matchMedia('(prefers-reduced-motion: reduce)').matches };
      },

      // (8) sideways overflow.
      overflow: () => {
        const se = document.scrollingElement;
        const vw = window.innerWidth;
        const past = [];
        for (const el of document.querySelectorAll('body *')) {
          if (!vis(el)) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width < 2 || rect.height < 2) continue;
          if (rect.right > vw + 1 && !el.closest('[style*="overflow"], .popover, [role="dialog"]')) past.push({ sel: selOf(el), right: Math.round(rect.right), vw });
        }
        past.sort((a, b) => b.right - a.right);
        return { scrollWidth: se.scrollWidth, clientWidth: se.clientWidth, past: past.slice(0, 12), count: past.length, zoom: document.documentElement.style.zoom || '' };
      },
      setZoom: (z) => { document.documentElement.style.zoom = z; },
    };
  });

  const a = (fn, ...args) => page.evaluate(([f, x]) => window.__a11y[f](...x), [fn, args]);
  const settle = (ms = 260) => page.waitForTimeout(ms);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Accessibility.enable').catch(() => {});
  await cdp.send('DOM.enable').catch(() => {});

  // ---- (1) names, from Chromium's AX tree ----------------------------------
  async function namesIn(scope, label) {
    const n = await a('tagCandidates', scope);
    const { nodes } = await cdp.send('Accessibility.getFullAXTree');
    const nameless = [];
    for (const node of nodes) {
      if (node.ignored) continue;
      const role = node.role?.value;
      const focusable = (node.properties || []).some((p) => p.name === 'focusable' && p.value?.value === true);
      if (!INTERACTIVE_ROLES.has(role) && !focusable) continue;
      const name = (node.name?.value || '').trim();
      if (name) continue;
      if (!node.backendDOMNodeId) continue;
      let attrs;
      try { attrs = (await cdp.send('DOM.describeNode', { backendNodeId: node.backendDOMNodeId })).node.attributes || []; } catch { continue; }
      const i = attrs.indexOf('data-a11y-idx');
      if (i < 0) continue; // not in this scene's scope, or not visible
      const d = await a('describe', attrs[i + 1]);
      if (d) nameless.push({ axRole: role, ...d });
    }
    note(`[${label}] interactive elements tagged`, n);
    check(`[${label}] every interactive element has an accessible name`, nameless, []);
    return nameless;
  }

  // ---- (2) dial contract -----------------------------------------------------
  const drifting = (s) => /drifting/.test(s?.valuetext || '');
  const near = (p, q) => Number.isFinite(p) && Number.isFinite(q) && Math.abs(p - q) < 1e-6;
  async function drag(scope, key, excl, dx, dy) {
    const d = await a('dialState', scope, key, excl, true);
    if (!d) return null;
    await page.mouse.move(d.x, d.y);
    await page.mouse.down();
    const steps = Math.max(Math.abs(dx), Math.abs(dy));
    for (let t = 4; t <= steps; t += 6) { const f = t / steps; await page.mouse.move(d.x + Math.round(dx * f), d.y + Math.round(dy * f)); }
    await page.mouse.move(d.x + dx, d.y + dy);
    await page.mouse.up();
    await settle();
    return a('dialState', scope, key, excl, false);
  }
  const textAgrees = (s) => {
    if (!s.valuetext) return false;
    if (/–/.test(s.text)) {
      const [lo, hi] = s.text.split('–').map((x) => x.trim());
      if (lo === hi) return s.valuetext === `${lo} (range collapsed)`; // v16: a collapsed span reads as one value, by design
      return s.valuetext === `min ${lo}, max ${hi}, drifting` || s.valuetext.startsWith(`min ${lo}, max ${hi}, now `);
    }
    return s.valuetext === s.text || s.valuetext === `${s.text} (range collapsed)`;
  };
  const engineAgrees = (s, v, via) => {
    if (v === undefined) return true;
    if (via === 'dB') {
      // The Advanced Volume reads in dB and the engine stores linear gain; the
      // Simple Volume reads a percentage of the dial's travel. Only the dB
      // readout can be checked against the engine's number: within half a dB.
      const m = /(-?\d+(?:\.\d+)?) dB/.exec(s.valuetext || '');
      if (!m) return true;
      return Number.isFinite(v) && v > 0 && Math.abs(20 * Math.log10(v) - Number(m[1])) <= 0.5;
    }
    if (v === null) return !drifting(s) && near(Number(s.now), 0);
    if (typeof v === 'object') return near(v.min, v.max) ? near(Number(s.now), v.min) : (drifting(s) && near(Number(s.now), v.min));
    return !drifting(s) && near(Number(s.now), v);
  };
  async function dialsIn(scope, label, excl, track) {
    const list = await a('dials', scope, excl);
    const contract = [];
    const textLies = [];
    const engineLies = [];
    let probed = 0;
    for (const d of list) {
      const s = await a('dialState', scope, d.key, excl, false);
      if (!s) continue;
      if (s.role !== 'slider' || s.tabindex === null || s.now === null || s.min === null || s.max === null || !s.valuetext || Number(s.now) < Number(s.min) - 1e-9 || Number(s.now) > Number(s.max) + 1e-9) contract.push({ key: d.key, ...s });
      if (!textAgrees(s)) textLies.push({ key: d.key, text: s.text, valuetext: s.valuetext });
    }
    check(`[${label}] every dial carries role=slider, tabindex, aria-valuenow/min/max within range and a valuetext (${list.length} dials)`, contract, []);
    check(`[${label}] every dial's aria-valuetext says what its readout says`, textLies, []);
    // Drag and reset the dials whose number is the engine's number.
    const map = track ? ENGINE_OF.track : ENGINE_OF.main;
    for (const d of list) {
      const spec = map[d.label];
      if (!spec || d.field) continue;
      const path = typeof spec === 'string' ? spec : spec.path;
      const via = typeof spec === 'string' ? undefined : spec.via;
      probed += 1;
      const dragged = await drag(scope, d.key, excl, 0, -40);
      if (!dragged) continue;
      let v = await a('engine', path, track || null);
      if (!engineAgrees(dragged, v, via)) engineLies.push({ key: d.key, at: 'drag', now: dragged.now, valuetext: dragged.valuetext, engine: v });
      if (!textAgrees(dragged)) textLies.push({ key: d.key, at: 'drag', text: dragged.text, valuetext: dragged.valuetext });
      // Keyboard reset: Backspace with the dial focused (knob.js's documented route).
      const focused = await a('focusDial', scope, d.key, excl);
      if (!focused) { engineLies.push({ key: d.key, at: 'focus', why: 'dial did not take focus' }); continue; }
      await page.keyboard.press('Backspace');
      await settle(320);
      const reset = await a('dialState', scope, d.key, excl, false);
      v = await a('engine', path, track || null);
      if (!engineAgrees(reset, v, via)) engineLies.push({ key: d.key, at: 'reset', now: reset.now, valuetext: reset.valuetext, engine: v });
      if (!textAgrees(reset)) textLies.push({ key: d.key, at: 'reset', text: reset.text, valuetext: reset.valuetext });
      if (reset.now === dragged.now && reset.valuetext === dragged.valuetext) engineLies.push({ key: d.key, at: 'reset', why: 'Backspace did not reset the dial', now: reset.now });
    }
    check(`[${label}] aria-valuenow is the engine's number after a drag and after a Backspace reset (${probed} dials probed)`, engineLies, []);
  }

  // ---- (3) contrast ----------------------------------------------------------
  const worst = { light: [], dark: [] };
  async function contrastIn(scope, label, theme) {
    const r = await a('contrast', scope);
    const hard = r.fails.filter((f) => f.ratio < 3 && !f.disabled);
    const soft = r.fails.filter((f) => f.ratio >= 3 && !f.disabled);
    for (const f of r.fails) worst[theme].push({ scene: label, ...f });
    note(`[${label}/${theme}] text leaves measured`, `${r.leaves} (${r.uncertain} over a background-image, approximate)`);
    check(`[${label}/${theme}] no text below 3:1 contrast`, hard.map((f) => `${f.sel} "${f.text}" ${f.ratio}:1 (${f.fg} on ${f.bg}${f.fgToken ? ', ' + f.fgToken : ''}${f.bgToken ? ' on ' + f.bgToken : ''})`), []);
    note(`[${label}/${theme}] text between 3:1 and its AA threshold (needs ruling)`, soft.length);
  }

  // ---- (4) focus-visible -----------------------------------------------------
  async function focusIn(scope, label, theme) {
    await page.keyboard.press('Tab'); // keyboard modality, so :focus-visible applies to the scripted focus() calls
    const r = await a('focusSweep', scope, 220);
    check(`[${label}/${theme}] every focusable control shows a focus indicator (${r.tested} of ${r.candidates} tested, ${r.focusVisible} matched :focus-visible)`, r.missing, []);
    if (r.tested && !r.focusVisible) check(`[${label}/${theme}] the scripted focus() calls matched :focus-visible at all`, r.focusVisible, (v) => v > 0);
    if (r.unfocusable.length) note(`[${label}/${theme}] focus() refused by`, r.unfocusable.slice(0, 10));
  }

  // ---- scenes ----------------------------------------------------------------
  const openEditor = async (track) => {
    await page.evaluate((t) => {
      const ed = document.getElementById(`voice-editor-${t}`);
      if (!ed || ed.hidden) document.getElementById(`voice-edit-toggle-${t}`)?.click();
    }, track);
    const ok = await page.waitForFunction((t) => {
      const el = document.getElementById(`voice-editor-${t}`);
      return !!(el && !el.hidden && el.querySelector('.patch-controls .knob-cell[data-field]'));
    }, track, { timeout: 8000 }).then(() => true).catch(() => false);
    await settle(300);
    return ok;
  };
  const closeEditor = (track) => page.evaluate((t) => {
    const ed = document.getElementById(`voice-editor-${t}`);
    if (ed && !ed.hidden) document.getElementById(`voice-edit-toggle-${t}`)?.click();
  }, track);
  const openPopover = async (toggle, pop) => {
    await page.evaluate((id) => document.getElementById(id)?.scrollIntoView({ block: 'center' }), toggle);
    const hidden = await page.evaluate((id) => document.getElementById(id)?.hidden ?? true, pop);
    if (hidden) { await page.click(`#${toggle}`); await settle(300); }
    return page.evaluate((id) => { const el = document.getElementById(id); return !!el && !el.hidden; }, pop);
  };

  const SCENES = [
    { id: 'simple', scope: '#generator-app', excl: true, open: async () => { await page.click('#tab-simple').catch(() => {}); await settle(300); return true; } },
    { id: 'advanced', scope: '#panel-advanced', excl: true, open: async () => { await page.click('#tab-advanced'); await settle(300); await a('unfold', '#panel-advanced'); await settle(300); return true; } },
    { id: 'editor-pad', scope: '#voice-editor-pad', track: 'pad', open: async () => { const ok = await openEditor('pad'); await a('unfold', '#voice-editor-pad'); await settle(300); return ok; }, close: () => closeEditor('pad') },
    { id: 'editor-percussion', scope: '#voice-editor-percussion', track: 'percussion', open: async () => { const ok = await openEditor('percussion'); await a('unfold', '#voice-editor-percussion'); await settle(300); return ok; }, close: () => closeEditor('percussion') },
    { id: 'create', scope: '#play-along', open: () => openPopover('play-along-open', 'play-along'), close: async () => { await page.keyboard.press('Escape'); await settle(200); } },
    { id: 'timers', scope: '#timers-popover', open: () => openPopover('timers-toggle', 'timers-popover'), close: async () => { await page.keyboard.press('Escape'); await settle(200); } },
    { id: 'tour', scope: '#tutorial-panel', open: async () => { const hidden = await page.evaluate(() => document.getElementById('tutorial-panel')?.hidden ?? true); if (hidden) { await page.click('#tutorial-toggle'); await settle(400); } return page.evaluate(() => !document.getElementById('tutorial-panel')?.hidden); }, close: async () => { await page.click('#tutorial-close').catch(() => {}); await settle(200); } },
  ];

  await load();
  current = 'ids';
  check('no duplicate ids on the booted page', await a('dupIds'), []);

  // Self-checks: a planted nameless button and a planted button with no focus
  // style must be caught, or a clean sweep proves nothing.
  current = 'selfcheck';
  await page.evaluate(() => {
    const host = document.getElementById('generator-app');
    const b1 = document.createElement('button'); b1.type = 'button'; b1.id = 'a11y-plant-nameless'; b1.textContent = '';
    b1.style.cssText = 'width:20px;height:20px';
    const b2 = document.createElement('button'); b2.type = 'button'; b2.id = 'a11y-plant-nofocus'; b2.textContent = 'planted';
    b2.style.cssText = 'outline:none;box-shadow:none';
    host.prepend(b1, b2);
  });
  const planted = await namesIn('#generator-app', 'selfcheck');
  results.pop(); // the planted button is MEANT to be nameless; keep the sweep's verdict as a self-check instead
  check('the name sweep catches a planted nameless button', planted.some((d) => d.sel.includes('a11y-plant-nameless')), true);
  await page.keyboard.press('Tab');
  const fs = await a('focusSweep', '#generator-app', 400);
  check('the focus sweep catches a planted button with no focus style', fs.missing.some((d) => d.sel.includes('a11y-plant-nofocus')), true);
  await page.evaluate(() => { for (const id of ['a11y-plant-nameless', 'a11y-plant-nofocus']) document.getElementById(id)?.remove(); });

  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme });
    await settle(300);
    check(`the ${theme} theme is in force`, await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches), theme === 'dark');
    for (const sc of SCENES) {
      current = `${sc.id}/${theme}`;
      const opened = await sc.open();
      if (!check(`[${sc.id}/${theme}] the scene opens`, opened, true)) continue;
      if (theme === 'light') {
        await namesIn(sc.scope, sc.id);
        if (['simple', 'advanced', 'editor-pad', 'editor-percussion'].includes(sc.id)) await dialsIn(sc.scope, sc.id, !!sc.excl, sc.track || null);
      }
      await contrastIn(sc.scope, sc.id, theme);
      await focusIn(sc.scope, sc.id, theme);
      if (sc.close) await sc.close();
    }
    current = `ids/${theme}`;
    check(`no duplicate ids after every scene (${theme})`, await a('dupIds'), []);
  }
  await page.emulateMedia({ colorScheme: 'light' });

  // Worst twenty per theme, for the report.
  for (const theme of ['light', 'dark']) {
    const seen = new Set();
    const list = worst[theme].filter((f) => { const k = f.sel + f.text; if (seen.has(k)) return false; seen.add(k); return true; }).sort((p, q) => p.ratio - q.ratio).slice(0, 20);
    notes.push({ [`worst-contrast-${theme}`]: list.map((f) => `${f.ratio}:1 (need ${f.need}) ${f.scene} ${f.sel} "${f.text}" ${f.fg}${f.fgToken ? '=' + f.fgToken : ''} on ${f.bg}${f.bgToken ? '=' + f.bgToken : ''} ${f.size}px/${f.weight}${f.image ? ' [over image]' : ''}${f.disabled ? ' [disabled]' : ''}`) });
  }

  // ---- (6) live regions -------------------------------------------------------
  current = 'live';
  await page.click('#tab-advanced'); await settle(200);
  await openEditor('pad');
  await a('unfold', '#voice-editor-pad'); await settle(200);
  const before = await a('live');
  check('the line under the dials is an aria-live region', before.dialConfirmLive, 'polite');
  check('the status lines are live regions', before.statuses.filter(([, l]) => !l).map(([id]) => id), []);
  // A refusal: a sideways drag on Drift rate, which is single-valued by contract and says so.
  const refused = await drag('#voice-editor-pad', 'Drift rate#1', false, 70, 0);
  const after = await a('live');
  check('a refusal is spoken in the live region (Drift rate sideways)', !!refused && !drifting(refused) && after.dialConfirmText.length > 0, true);
  note('refusal text', after.dialConfirmText);
  await closeEditor('pad');

  // ---- (7) reduced motion ------------------------------------------------------
  current = 'motion';
  const paintsFor = async (reduce) => {
    await page.emulateMedia({ reducedMotion: reduce ? 'reduce' : 'no-preference' });
    await load();
    // The scope and the visualiser only draw while the piece plays; a
    // headless Chromium has a silent output and plays happily into it.
    await page.click('#toggle-play');
    await page.waitForFunction(() => document.getElementById('toggle-play')?.getAttribute('aria-pressed') === 'true', { timeout: 8000 }).catch(() => {});
    await page.evaluate(() => document.getElementById('front-scope')?.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(1500);
    await page.evaluate(() => window.__a11yPaintsReset());
    await page.waitForTimeout(2000);
    const p = await page.evaluate(() => window.__a11yPaints());
    const playing = await page.evaluate(() => document.getElementById('toggle-play')?.getAttribute('aria-pressed'));
    const anim = await a('animations');
    await page.click('#toggle-play').catch(() => {});
    await page.waitForTimeout(300);
    return { paints: p, anim, playing };
  };
  const normal = await paintsFor(false);
  const reduced = await paintsFor(true);
  check('reduced motion is emulated', reduced.anim.reduce, true);
  const unsilenced = reduced.anim.declared.filter((d) => !d.silenced).map((d) => `${d.selector}: ${d.animation}`);
  check('every CSS animation the page declares is silenced under prefers-reduced-motion', unsilenced, []);
  check('the piece plays for the canvas measurement', normal.playing, 'true');
  note('canvas paints in 2 s, normal', normal.paints);
  note('canvas paints in 2 s, reduced', reduced.paints);
  for (const id of Object.keys(normal.paints)) {
    const n = normal.paints[id] || 0; const r = reduced.paints[id] || 0;
    if (n >= 20) check(`the ${id} canvas slows under prefers-reduced-motion (${n} -> ${r} paints in 2 s)`, r <= n / 2, true);
  }
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  // ---- (8) 200% zoom -----------------------------------------------------------
  current = 'zoom';
  await load();
  for (const tab of ['simple', 'advanced']) {
    await page.click(`#tab-${tab}`); await settle(200);
    if (tab === 'advanced') { await a('unfold', '#panel-advanced'); await settle(200); }
    await page.setViewportSize({ width: 640, height: 450 });
    await settle(500);
    const o1 = await a('overflow');
    check(`[${tab}] no sideways scroll at a 640px viewport (200% of 1280)`, o1.scrollWidth <= o1.clientWidth + 1, true);
    check(`[${tab}] nothing paints past the right edge at 640px`, o1.past, []);
    await page.setViewportSize({ width: 1280, height: 900 });
    await a('setZoom', '2');
    await settle(500);
    const o2 = await a('overflow');
    check(`[${tab}] no sideways scroll at CSS zoom 2`, o2.scrollWidth <= o2.clientWidth + 1, true);
    check(`[${tab}] nothing paints past the right edge at CSS zoom 2`, o2.past, []);
    await a('setZoom', '');
    await settle(200);
  }

  // ---- verdict -----------------------------------------------------------------
  const failed = results.filter((r) => !r.ok);
  if (errors.length) failed.push({ name: 'no console or page errors', got: errors.slice(0, 12), want: [] });
  if (failed.length) {
    throw new Error(
      'a11y-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n') +
      '\n' + JSON.stringify(results.filter((r) => r.want === '(informational)').map((r) => [r.name, r.got]).concat(notes), null, 1),
    );
  }
  return { passed: results.length, notes: results.filter((r) => r.want === '(informational)').map((r) => [r.name, r.got]).concat(notes) };
}
