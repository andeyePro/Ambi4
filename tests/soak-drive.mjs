/**
 * Endurance and performance: fifteen minutes of a scripted life, measured.
 *
 *   npm run build && .vibe/measure.sh local drive tests/soak-drive.mjs
 *
 * Every other drive proves one thing in under a minute. None of them proves
 * what happens to a page that is left PLAYING while its owner keeps editing —
 * which is how Ambi4 is used: it sits in a tab for an afternoon. A listener
 * added per editor open and never removed, a timer never cleared, an audio
 * node built per note and never disconnected, all pass every one-minute drive
 * and show up only as a heap that will not stop climbing.
 *
 * So this launches its OWN Chromium (it needs --enable-precise-memory-info,
 * which the bridge's browser was not started with), boots the page three
 * times to measure a cold start, then plays for SOAK_SECONDS of real time
 * with one random edit every ACT_EVERY seconds — a dial drag, a genre pick, a
 * voice pick, a structure edit, an editor open or close, a share-link mint,
 * a pause and resume — and SAMPLES every SAMPLE_EVERY seconds, after a
 * forced GC so a figure is a floor and not a fluctuation:
 *
 *   - performance.memory.usedJSHeapSize
 *   - audio nodes: created, ended (sources) and collected, counted by
 *     wrapping BaseAudioContext.prototype.create* in an init script — the
 *     engine keeps no node registry, so this is the census it lacks
 *   - document.querySelectorAll('*').length
 *   - event listeners on window / document / body, via CDP
 *     DOMDebugger.getEventListeners — the count a leaked handler shows up in
 *   - long tasks (PerformanceObserver 'longtask'), matched against the
 *     gesture windows so "a long task during a drag" can be told from a GC
 *   - 'bar' and 'note' events from the engine, so starvation (running, not
 *     paused, no bar for a long time) is a number rather than silence
 *   - console errors and page errors
 *
 * RED on: any page/console error; note starvation; a post-GC heap whose
 * slope over the last 60 % of the run does not flatten; DOM growth that does
 * not plateau; listener counts on window/document that climb with the edits.
 * Long tasks are REPORTED, not red: this Mac runs several agents' browsers at
 * once and a 300 ms task under that load says nothing about the page.
 *
 * Numbers are returned in full. Read them; the thresholds are the floor,
 * not the finding.
 */

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// A file: URL — a bare absolute path cannot be resolved from a data: module.
// The bridge runs drives from its shot directory, where playwright is
// installed (the same resolution webkit-drive.mjs and churn-drive.mjs use).
const PLAYWRIGHT = pathToFileURL(join(process.cwd(), 'node_modules', 'playwright', 'index.mjs')).href;
const SOAK_SECONDS = 900;
const SAMPLE_EVERY = 10;
const ACT_EVERY = 20;
const STARVATION_SECONDS = 45;
const BOOT_RUNS = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const slope = (pts) => {
  // Least-squares slope of y against x, in y-units per x-unit.
  const n = pts.length; if (n < 3) return 0;
  const mx = pts.reduce((a, p) => a + p.x, 0) / n, my = pts.reduce((a, p) => a + p.y, 0) / n;
  let num = 0, den = 0;
  for (const p of pts) { num += (p.x - mx) * (p.y - my); den += (p.x - mx) ** 2; }
  return den ? num / den : 0;
};

// Installed before any page script runs: the audio-node census, the long-task
// observer and the error log. Everything lives on window.__soak.
const INIT = () => {
  const S = { created: {}, createdTotal: 0, sources: 0, ended: 0, collected: 0, contexts: 0, longTasks: [], gestures: [], errors: [] };
  window.__soak = S;
  let registry = null;
  try { registry = new FinalizationRegistry(() => { S.collected += 1; }); } catch { /* no FinalizationRegistry: collected stays 0 */ }
  const track = (kind, node) => {
    S.created[kind] = (S.created[kind] || 0) + 1;
    S.createdTotal += 1;
    if (registry && node && typeof node === 'object') registry.register(node, kind);
    if (node && typeof node.start === 'function' && typeof node.addEventListener === 'function') {
      S.sources += 1;
      node.addEventListener('ended', () => { S.ended += 1; }, { once: true });
    }
    return node;
  };
  const proto = window.BaseAudioContext && window.BaseAudioContext.prototype;
  if (proto) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (!/^create[A-Z]/.test(key) || typeof proto[key] !== 'function') continue;
      const orig = proto[key];
      proto[key] = function (...args) { return track(key.slice(6), orig.apply(this, args)); };
    }
  }
  if (window.AudioWorkletNode) {
    const Orig = window.AudioWorkletNode;
    window.AudioWorkletNode = new Proxy(Orig, { construct(target, args, newTarget) { return track('AudioWorkletNode', Reflect.construct(target, args, newTarget)); } });
  }
  for (const name of ['AudioContext', 'webkitAudioContext']) {
    const Orig = window[name];
    if (!Orig) continue;
    window[name] = new Proxy(Orig, { construct(target, args, newTarget) { S.contexts += 1; return Reflect.construct(target, args, newTarget); } });
  }
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) S.longTasks.push({ start: Math.round(e.startTime), dur: Math.round(e.duration) });
    }).observe({ entryTypes: ['longtask'] });
  } catch { /* no longtask support */ }
};

// Everything a scripted edit might touch, scoped so a hidden duplicate (Volume
// exists on both tabs) is never the one that gets the gesture.
// `pick` re-reads the SAME dial after a gesture: Level and Randomness exist
// once per track, and a random re-read of "a visible Randomness" answered
// for a different track than the one dragged (the first run logged
// "Dynamics: Auto -> Auto" for exactly that reason).
const visibleKnob = (page, scope, label, pick = null) =>
  page.evaluate(([sel, name, index]) => {
    const root = sel ? document.querySelector(sel) : document;
    const visible = (el) => {
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        if (n.hidden || n.getAttribute?.('aria-hidden') === 'true') return false;
        const cs = getComputedStyle(n);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      }
      return true;
    };
    const all = [...(root || document).querySelectorAll('.knob')].filter((el) => visible(el) && (!name || el.getAttribute('aria-label') === name));
    const at = index === null ? Math.floor(Math.random() * all.length) : index;
    const k = all[at];
    if (!k) return null;
    k.scrollIntoView({ block: 'center' });
    const r = k.getBoundingClientRect();
    return { label: k.getAttribute('aria-label'), index: at, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.width / 2), valuetext: k.getAttribute('aria-valuetext') };
  }, [scope, label || null, pick]);

const openFoldFor = async (page, selector) => {
  const more = await page.evaluate((s) => (typeof window.__ambi4FoldMore === 'function' ? window.__ambi4FoldMore(s) : null), selector);
  if (more) {
    await page.click(more).catch(() => {});
    await page.waitForTimeout(150);
  }
};

const pickOption = (page, selector, filter) =>
  page.evaluate(([sel, src]) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    // eslint-disable-next-line no-new-func
    const ok = src ? new Function('v', 'return ' + src) : () => true;
    const opts = [...el.options].filter((o) => ok(o.value) && o.value !== el.value);
    const o = opts[Math.floor(Math.random() * opts.length)];
    if (!o) return null;
    el.value = o.value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return o.value;
  }, [selector, filter || '']);

const engineState = (page) =>
  page.evaluate(() => {
    const e = window.__ambi4Engine;
    if (!e) return null;
    const st = e.getStats ? e.getStats() : null;
    return { running: Boolean(e.running), paused: Boolean(e.paused), activeNotes: st ? st.total : null, bars: window.__soakBars || 0, notes: window.__soakNotes || 0 };
  });

// Hook the engine's own events. Installed after boot; left in place on
// purpose (removing it would be measuring a page nobody uses).
const hookEngine = (page) =>
  page.evaluate(() => {
    const e = window.__ambi4Engine;
    if (!e || window.__soakHooked) return false;
    window.__soakHooked = true;
    window.__soakBars = 0; window.__soakNotes = 0; window.__soakLastBarAt = performance.now();
    window.__soakFirstBarAt = null;
    e.on('bar', () => { window.__soakBars += 1; window.__soakLastBarAt = performance.now(); if (window.__soakFirstBarAt === null) window.__soakFirstBarAt = performance.now(); });
    e.on('note', () => { window.__soakNotes += 1; });
    return true;
  });

export default async function drive(bridgePage) {
  const url = bridgePage.url();
  const { chromium } = await import(PLAYWRIGHT);
  const browser = await chromium.launch({ args: ['--enable-precise-memory-info', '--autoplay-policy=no-user-gesture-required'] });
  const out = { boot: [], bootMedians: null, samples: [], actions: [], findings: [], warnings: [], errors: [] };
  const findings = out.findings;
  let context = null;
  let page = null;
  const errors = out.errors;

  const freshPage = async () => {
    if (context) await context.close().catch(() => {});
    context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
    page = await context.newPage();
    await page.addInitScript(INIT);
    page.on('pageerror', (err) => errors.push({ kind: 'pageerror', at: Date.now(), text: String(err && err.message || err) }));
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push({ kind: 'console', at: Date.now(), text: msg.text() }); });
    return page;
  };

  try {
    // ---- cold boot, three times ------------------------------------------
    for (let run = 0; run < BOOT_RUNS; run++) {
      await freshPage();
      await page.goto('about:blank');
      const t0 = Date.now();
      await page.goto(url, { waitUntil: 'commit', timeout: 45000 });
      await page.waitForSelector('#generator-app:not([hidden])', { timeout: 30000 });
      const tApp = Date.now() - t0;
      await page.waitForFunction(() => !!window.__ambi4Engine, null, { timeout: 30000 });
      const tEngine = Date.now() - t0;
      await page.click('#consent-slot button:has-text("Save on this device")').catch(() => {});
      await page.waitForTimeout(200);
      await hookEngine(page);
      const tPlay = Date.now();
      await page.click('#toggle-play');
      await page.waitForFunction(() => window.__soakFirstBarAt !== null, null, { timeout: 30000 }).catch(() => {});
      const firstBar = await page.evaluate(() => window.__soakFirstBarAt);
      const tBar = firstBar === null ? null : Date.now() - tPlay;
      const nav = await page.evaluate(() => {
        const n = performance.getEntriesByType('navigation')[0];
        return n ? { domContentLoaded: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd) } : null;
      });
      out.boot.push({ run: run + 1, msToAppVisible: tApp, msToEngine: tEngine, msPlayToFirstBar: tBar, nav });
      if (tBar === null) findings.push(`boot run ${run + 1}: no 'bar' event within 30 s of Play`);
    }
    out.bootMedians = {
      msToAppVisible: median(out.boot.map((b) => b.msToAppVisible)),
      msToEngine: median(out.boot.map((b) => b.msToEngine)),
      msPlayToFirstBar: median(out.boot.filter((b) => b.msPlayToFirstBar !== null).map((b) => b.msPlayToFirstBar)),
    };

    // ---- the soak, on the third page, already playing --------------------
    const cdp = await context.newCDPSession(page);
    await cdp.send('HeapProfiler.enable').catch(() => {});
    const listenerCount = async (expr) => {
      const { result } = await cdp.send('Runtime.evaluate', { expression: expr, objectGroup: 'soak' });
      if (!result || !result.objectId) return null;
      const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
      const byType = {};
      for (const l of listeners) byType[l.type] = (byType[l.type] || 0) + 1;
      return { total: listeners.length, byType };
    };
    const sample = async (label) => {
      await cdp.send('HeapProfiler.collectGarbage').catch(() => {});
      await sleep(300); // let FinalizationRegistry callbacks run
      const inPage = await page.evaluate(() => {
        const S = window.__soak;
        const m = performance.memory;
        return {
          heap: m ? m.usedJSHeapSize : null, heapTotal: m ? m.totalJSHeapSize : null,
          dom: document.querySelectorAll('*').length,
          // The voice editors are built on open and emptied on close, so the
          // raw count swings by ~1,500-2,000 with whichever are open at the
          // sample (the first full run called that a leak: +927 over the
          // tail, ending with two editors open). Growth is judged on the
          // rest of the page; the editors' own churn is churn-drive's job.
          domOutsideEditors: document.querySelectorAll('*').length
            - [...document.querySelectorAll('[id^="voice-editor-"]')].reduce((n, ed) => n + ed.querySelectorAll('*').length, 0),
          editorsOpen: [...document.querySelectorAll('[id^="voice-editor-"]')].filter((ed) => !ed.hidden).length,
          nodesCreated: S.createdTotal, sources: S.sources, ended: S.ended, collected: S.collected, contexts: S.contexts,
          longTasks: S.longTasks.splice(0),
          openEditors: [...document.querySelectorAll('[id^=voice-editor-]')].filter((e) => !e.hidden).length,
          sinceLastBarMs: Math.round(performance.now() - (window.__soakLastBarAt || 0)),
          now: performance.now(),
        };
      });
      const st = await engineState(page);
      const win = await listenerCount('window');
      const doc = await listenerCount('document');
      const body = await listenerCount('document.body');
      await cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'soak' }).catch(() => {});
      const s = { t: Math.round((Date.now() - soakStart) / 1000), label, ...inPage, ...st, listeners: { window: win && win.total, document: doc && doc.total, body: body && body.total }, listenerTypes: { window: win && win.byType, document: doc && doc.byType } };
      s.liveNodesEstimate = s.nodesCreated - s.collected;
      s.liveSources = s.sources - s.ended;
      out.samples.push(s);
      return s;
    };

    const gesture = async (name, fn) => {
      const start = await page.evaluate(() => performance.now());
      let detail = null;
      let err = null;
      try { detail = await fn(); } catch (e) { err = String(e && e.message || e); }
      const end = await page.evaluate(() => performance.now());
      await page.evaluate(([n, a, b]) => { window.__soak.gestures.push({ name: n, start: a, end: b }); }, [name, start, end]);
      out.actions.push({ t: Math.round((Date.now() - soakStart) / 1000), name, detail, err, ms: Math.round(end - start) });
    };

    const ADV = '#panel-advanced';
    let structureBlocks = 0;
    const ACTIONS = {
      dial: () => gesture('dial', async () => {
        const d = await visibleKnob(page, ADV);
        if (!d) return 'no visible dial';
        const dy = (Math.random() < 0.5 ? -1 : 1) * (30 + Math.floor(Math.random() * 40));
        await page.mouse.move(d.x, d.y);
        await page.mouse.down();
        for (let i = 1; i <= 12; i++) await page.mouse.move(d.x, d.y + Math.round((dy / 12) * i));
        await page.mouse.up();
        await page.waitForTimeout(300);
        const after = await visibleKnob(page, ADV, d.label, d.index);
        return `${d.label}: ${d.valuetext} -> ${after && after.valuetext}`;
      }),
      genre: () => gesture('genre', async () => pickOption(page, '#genre-select', "v && v !== 'surprise'")),
      voice: () => gesture('voice', async () => {
        const tracks = await page.evaluate(() => Object.keys(window.__ambi4Engine.getParams().tracks));
        const t = tracks[Math.floor(Math.random() * tracks.length)];
        const v = await pickOption(page, `#track-voice-${t}`, "v && !v.startsWith('__')");
        return `${t} -> ${v}`;
      }),
      structure: () => gesture('structure', async () => {
        await openFoldFor(page, '#structure');
        const cur = await page.evaluate(() => document.getElementById('structure')?.value);
        if (cur !== 'custom') {
          await page.evaluate(() => { const s = document.getElementById('structure'); s.value = 'custom'; s.dispatchEvent(new Event('change', { bubbles: true })); });
          await page.waitForTimeout(200);
          structureBlocks = await page.evaluate(() => document.querySelectorAll('.structure-block').length);
          return 'structure -> custom (' + structureBlocks + ' blocks)';
        }
        if (structureBlocks >= 6 || (structureBlocks > 1 && Math.random() < 0.5)) {
          await page.evaluate(() => document.querySelector('.structure-block:nth-child(1) .block-remove')?.click());
        } else {
          await page.evaluate(() => document.getElementById('add-structure-block')?.click());
        }
        await page.waitForTimeout(200);
        structureBlocks = await page.evaluate(() => document.querySelectorAll('.structure-block').length);
        return 'blocks now ' + structureBlocks;
      }),
      editor: () => gesture('editor', async () => {
        const open = await page.evaluate(() => [...document.querySelectorAll('[id^=voice-editor-]')].filter((e) => !e.hidden).map((e) => e.id.replace('voice-editor-', '')));
        const tracks = await page.evaluate(() => Object.keys(window.__ambi4Engine.getParams().tracks));
        const t = open.length >= 2 ? open[0] : tracks[Math.floor(Math.random() * tracks.length)];
        await page.evaluate((id) => document.getElementById('voice-edit-toggle-' + id)?.click(), t);
        await page.waitForTimeout(300);
        const nowOpen = await page.evaluate((id) => !(document.getElementById('voice-editor-' + id)?.hidden ?? true), t);
        return `${t} editor ${nowOpen ? 'opened' : 'closed'}`;
      }),
      share: () => gesture('share', async () => {
        await page.evaluate(() => { window.__copied = null; navigator.clipboard.writeText = (text) => { window.__copied = text; return Promise.resolve(); }; });
        await openFoldFor(page, '#preset-share');
        await page.evaluate(() => document.getElementById('preset-share')?.click());
        await page.waitForTimeout(500);
        const link = await page.evaluate(() => window.__copied);
        return link ? `link ${link.length} chars` : 'no link captured';
      }),
      pause: () => gesture('pause', async () => {
        await page.evaluate(() => document.getElementById('pause-toggle')?.click());
        await page.waitForTimeout(400);
        const st = await engineState(page);
        return st.paused ? 'paused' : 'resumed';
      }),
    };
    const names = Object.keys(ACTIONS);

    await page.click('#tab-advanced');
    await page.waitForTimeout(500);
    const soakStart = Date.now();
    await sample('start');
    let lastSample = Date.now();
    let lastAct = Date.now();
    let lastBarSeen = Date.now();
    let lastBars = 0;
    let pausedSince = null;
    while (Date.now() - soakStart < SOAK_SECONDS * 1000) {
      await sleep(500);
      const now = Date.now();
      if (now - lastAct >= ACT_EVERY * 1000) {
        lastAct = now;
        const st = await engineState(page);
        if (st && st.paused) {
          // Never leave it paused for more than one cycle: a paused engine
          // emits no bars, and starvation must mean something.
          await ACTIONS.pause();
          pausedSince = null;
        } else if (st && !st.running) {
          await gesture('play', async () => { await page.click('#toggle-play'); await page.waitForTimeout(400); return 'pressed Play'; });
        } else {
          const name = names[Math.floor(Math.random() * names.length)];
          await ACTIONS[name]();
          if (name === 'pause') pausedSince = now;
        }
      }
      if (now - lastSample >= SAMPLE_EVERY * 1000) {
        lastSample = now;
        const s = await sample();
        if (s.bars > lastBars) { lastBars = s.bars; lastBarSeen = now; }
        else if (s.running && !s.paused && now - lastBarSeen > STARVATION_SECONDS * 1000) {
          findings.push(`note starvation at t=${s.t}s: running, not paused, no 'bar' for ${Math.round((now - lastBarSeen) / 1000)} s (bars=${s.bars})`);
          lastBarSeen = now;
        }
        if (s.contexts > 1) findings.push(`t=${s.t}s: ${s.contexts} AudioContexts constructed (want 1)`);
      }
    }
    await sample('end');

    // ---- the verdict -------------------------------------------------------
    const S = out.samples;
    const tail = S.filter((s) => s.t >= SOAK_SECONDS * 0.4);
    const head = S.filter((s) => s.t < SOAK_SECONDS * 0.4);
    const kbps = slope(tail.map((s) => ({ x: s.t, y: s.heap / 1024 })));
    const heapGrowthMB = (tail[tail.length - 1].heap - tail[0].heap) / 1048576;
    const domGrowth = tail[tail.length - 1].domOutsideEditors - tail[0].domOutsideEditors;
    const domSlope = slope(tail.map((s) => ({ x: s.t, y: s.domOutsideEditors })));
    const lis = (k) => tail.map((s) => s.listeners[k] ?? 0);
    const listenerGrowth = { window: lis('window').at(-1) - lis('window')[0], document: lis('document').at(-1) - lis('document')[0], body: lis('body').at(-1) - lis('body')[0] };
    const nodeSlope = slope(tail.map((s) => ({ x: s.t, y: s.liveNodesEstimate })));
    const liveSourcesEnd = S[S.length - 1].liveSources;
    const long = [];
    const gestures = await page.evaluate(() => window.__soak.gestures);
    for (const s of S) for (const lt of s.longTasks || []) {
      const g = gestures.find((x) => lt.start <= x.end + 50 && lt.start + lt.dur >= x.start - 50);
      long.push({ at: s.t, dur: lt.dur, during: g ? g.name : null });
    }
    out.summary = {
      soakSeconds: SOAK_SECONDS, samples: S.length, actions: out.actions.length,
      heapStartMB: +(S[0].heap / 1048576).toFixed(2), heapEndMB: +(S.at(-1).heap / 1048576).toFixed(2),
      heapTailSlopeKBps: +kbps.toFixed(2), heapTailGrowthMB: +heapGrowthMB.toFixed(2),
      domStart: S[0].dom, domEnd: S.at(-1).dom, editorsOpenEnd: S.at(-1).editorsOpen,
      domOutsideEditorsStart: S[0].domOutsideEditors, domOutsideEditorsEnd: S.at(-1).domOutsideEditors,
      domTailGrowth: domGrowth, domTailSlopePerS: +domSlope.toFixed(3),
      listenersStart: S[0].listeners, listenersEnd: S.at(-1).listeners, listenerTailGrowth: listenerGrowth,
      nodesCreated: S.at(-1).nodesCreated, sources: S.at(-1).sources, ended: S.at(-1).ended, collected: S.at(-1).collected,
      liveNodesEstimateEnd: S.at(-1).liveNodesEstimate, liveNodesTailSlopePerS: +nodeSlope.toFixed(3), liveSourcesEnd,
      bars: S.at(-1).bars, notes: S.at(-1).notes, maxGapBetweenBarsMs: Math.max(...S.map((s) => s.sinceLastBarMs)),
      longTasks: long.length, longTasksOver200: long.filter((l) => l.dur > 200), longTasksDuringGesture: long.filter((l) => l.during),
      errors: errors.length,
    };
    if (errors.length) findings.push(`${errors.length} page/console error(s): ` + errors.slice(0, 5).map((e) => e.kind + ': ' + e.text.slice(0, 200)).join(' | '));
    if (kbps > 15 && heapGrowthMB > 8) findings.push(`heap leak: post-GC heap climbs ${kbps.toFixed(1)} KB/s over the last 60 % (+${heapGrowthMB.toFixed(1)} MB), no plateau`);
    if (domSlope > 0.5 && domGrowth > 500) findings.push(`DOM growth outside the voice editors: +${domGrowth} elements over the last 60 % (${domSlope.toFixed(2)}/s), no plateau`);
    for (const k of Object.keys(listenerGrowth)) if (listenerGrowth[k] > 20) findings.push(`listener leak: ${k} gained ${listenerGrowth[k]} listeners over the last 60 % of the run`);
    if (nodeSlope > 2 && S.at(-1).collected > 0) findings.push(`audio-node leak: live (created − collected) nodes climb ${nodeSlope.toFixed(2)}/s over the last 60 %`);
    for (const l of long.filter((x) => x.dur > 200 && x.during)) out.warnings.push(`long task ${l.dur} ms during '${l.during}' at t=${l.at}s`);
    for (const l of long.filter((x) => x.dur > 200 && !x.during)) out.warnings.push(`long task ${l.dur} ms (no gesture) at t=${l.at}s`);
  } finally {
    await browser.close().catch(() => {});
  }

  if (findings.length) {
    throw new Error('soak-drive: ' + findings.length + ' finding(s)\n' + findings.map((f) => '  ✗ ' + f).join('\n')
      + '\nsummary ' + JSON.stringify(out.summary) + '\nboot ' + JSON.stringify(out.boot)
      + '\nsamples ' + JSON.stringify(out.samples.map((s) => [s.t, s.heap, s.dom, s.listeners.window, s.listeners.document, s.liveNodesEstimate, s.liveSources, s.bars, s.activeNotes]))
      + '\nactions ' + JSON.stringify(out.actions));
  }
  return out;
}
