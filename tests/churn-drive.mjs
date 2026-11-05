/**
 * Churn: every repeatable edit, repeated, with the floor measured each time.
 *
 *   npm run build && .vibe/measure.sh local drive tests/churn-drive.mjs
 *
 * soak-drive.mjs is the afternoon in the tab: fifteen minutes, one edit every
 * twenty seconds. It cannot see a leak that costs a few kilobytes per editor
 * open, because fifteen minutes holds four opens. This is the other half: the
 * same edits done TWENTY times each in a row, with a forced GC and a reading
 * after every one — post-GC heap, element count, listeners on window and
 * document (CDP DOMDebugger.getEventListeners), live setInterval handles,
 * live engine subscriptions (engine.on wrapped to count what is never
 * off()'d), and the audio-node census from wrapping create*.
 *
 * The verdict is a slope per cycle, after the first few cycles have warmed
 * the caches: a DOM that gains elements every open-and-close, a document that
 * gains a listener every popover, an interval that is started per open and
 * cleared once, a subscription per editor that outlives it. Each of those is
 * RED. The heap slope is reported and is red only when it is unmistakable
 * (over 64 KB a cycle on a post-GC reading): a few KB a cycle is V8 noise.
 *
 * Every churn is read only after the piece has SETTLED: a cold start builds
 * ~2 MB of once-only audio state in its first ~15 s (noise buffers per colour,
 * the reverb impulse, voices of tracks that join late), and the first churn
 * read that as a leak of +165 KB a cycle. See settleHeap below. And the heap
 * is read WITHOUT the live AudioBuffers' samples: the engine's noise caches
 * fill once, lazily, whenever the piece first reaches a voice that needs one
 * (4.6 MB for the bed noise), and that step landing in a window read as a
 * +166 KB-a-cycle leak in the tabs churn. Live buffer bytes are reported per
 * churn as bufferMBDelta.
 *
 * Also checks the one gesture the soak logged as refusing: a vertical drag on
 * a track's Dynamics dial at Auto must take it off Auto in the ENGINE.
 */

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// The bridge runs drives from its shot directory, where playwright is installed
// (the same resolution webkit-drive.mjs uses).
const PLAYWRIGHT = pathToFileURL(join(process.cwd(), 'node_modules', 'playwright', 'index.mjs')).href;
const CYCLES = 18;
// Six tracks, so the editor churn needs six cycles before every editor has
// been built once; the slope is read after that. (The first reading of this
// drive called the editor a leak at +18 elements a cycle. It was its own
// warm-up: arp's and percussion's FIRST builds landed inside the window.)
const WARMUP = 6;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slope = (pts) => {
  const n = pts.length; if (n < 3) return 0;
  const mx = pts.reduce((a, p) => a + p.x, 0) / n, my = pts.reduce((a, p) => a + p.y, 0) / n;
  let num = 0, den = 0;
  for (const p of pts) { num += (p.x - mx) * (p.y - my); den += (p.x - mx) ** 2; }
  return den ? num / den : 0;
};

const INIT = () => {
  const S = { createdTotal: 0, collected: 0, intervals: 0, timeouts: 0, subs: 0, observed: 0, bufferBytes: 0 };
  window.__churn = S;
  let registry = null;
  try { registry = new FinalizationRegistry((held) => { S.collected += 1; S.bufferBytes -= (held && held.bytes) || 0; }); } catch {}
  const proto = window.BaseAudioContext && window.BaseAudioContext.prototype;
  if (proto) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (!/^create[A-Z]/.test(key) || typeof proto[key] !== 'function') continue;
      const orig = proto[key];
      proto[key] = function (...args) {
        const node = orig.apply(this, args);
        S.createdTotal += 1;
        // An AudioBuffer's samples count toward usedJSHeapSize: tally the
        // live ones, so the heap reading can be taken without them (below).
        const bytes = key === 'createBuffer' && node ? node.numberOfChannels * node.length * 4 : 0;
        S.bufferBytes += bytes;
        if (registry && node && typeof node === 'object') registry.register(node, { key, bytes });
        return node;
      };
    }
  }
  // ResizeObserver observations that are never released. An observer with a
  // live observation is held by the document, and it holds its target: a
  // detached canvas, and through it the whole detached editor it sat in.
  if (typeof window.ResizeObserver === 'function') {
    const RO = window.ResizeObserver;
    const targets = new WeakMap(); // observer -> Set of observed targets
    const count = () => { let n = 0; for (const set of allSets) n += set.size; S.observed = n; };
    const allSets = new Set();
    const obs = RO.prototype.observe, unobs = RO.prototype.unobserve, disc = RO.prototype.disconnect;
    RO.prototype.observe = function (t, o) { let set = targets.get(this); if (!set) { set = new Set(); targets.set(this, set); allSets.add(set); } set.add(t); count(); return obs.call(this, t, o); };
    RO.prototype.unobserve = function (t) { targets.get(this)?.delete(t); count(); return unobs.call(this, t); };
    RO.prototype.disconnect = function () { const set = targets.get(this); if (set) { set.clear(); allSets.delete(set); } count(); return disc.call(this); };
  }
  const live = new Set();
  const si = window.setInterval, ci = window.clearInterval;
  window.setInterval = function (...a) { const h = si.apply(this, a); live.add(h); S.intervals = live.size; return h; };
  window.clearInterval = function (h) { live.delete(h); S.intervals = live.size; return ci.call(this, h); };
};

// Count engine subscriptions that are never released. Installed once the
// engine exists; the page calls engine.on through the property, so a wrapped
// property counts every subscription made after this point.
const wrapEngine = (page) =>
  page.evaluate(() => {
    const e = window.__ambi4Engine;
    if (!e || e.__churnWrapped) return false;
    const on = e.on;
    e.on = function (type, cb) {
      window.__churn.subs += 1;
      const off = on.call(this, type, cb);
      let done = false;
      return () => { if (!done) { done = true; window.__churn.subs -= 1; } return off(); };
    };
    e.__churnWrapped = true;
    return true;
  });

const openFoldFor = async (page, selector) => {
  const more = await page.evaluate((s) => (typeof window.__ambi4FoldMore === 'function' ? window.__ambi4FoldMore(s) : null), selector);
  if (more) { await page.click(more).catch(() => {}); await page.waitForTimeout(120); }
};

const select = (page, sel, value) =>
  page.evaluate(([s, v]) => { const el = document.querySelector(s); if (!el) return false; el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); return el.value === v; }, [sel, value]);

const knobAt = (page, scope, label) =>
  page.evaluate(([sel, name]) => {
    const visible = (el) => {
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        if (n.hidden || n.getAttribute?.('aria-hidden') === 'true') return false;
        const cs = getComputedStyle(n);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      }
      return true;
    };
    const k = [...document.querySelectorAll(`${sel} .knob`)].find((el) => el.getAttribute('aria-label') === name && visible(el));
    if (!k) return null;
    k.scrollIntoView({ block: 'center' });
    const r = k.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.width / 2), valuetext: k.getAttribute('aria-valuetext') };
  }, [scope, label]);

const drag = async (page, k, dx, dy) => {
  await page.mouse.move(k.x, k.y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(k.x + Math.round((dx / 12) * i), k.y + Math.round((dy / 12) * i));
  await page.mouse.up();
  await page.waitForTimeout(250);
};

export default async function drive(bridgePage) {
  const url = bridgePage.url();
  const { chromium } = await import(PLAYWRIGHT);
  const browser = await chromium.launch({ args: ['--enable-precise-memory-info', '--autoplay-policy=no-user-gesture-required'] });
  const results = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
  };
  const errors = [];
  const series = {};
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await page.addInitScript(INIT);
    page.on('pageerror', (err) => errors.push('pageerror: ' + String(err && err.message || err)));
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push('console: ' + msg.text()); });
    await page.goto('about:blank');
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForSelector('#generator-app:not([hidden])', { timeout: 20000 });
    await page.click('#consent-slot button:has-text("Save on this device")').catch(() => {});
    await page.waitForTimeout(200);
    check('engine.on could be wrapped for subscription counting', await wrapEngine(page), true);
    // A fresh visit draws a random genre: pin it, so every cycle churns the same page.
    await select(page, '#genre-select', 'g:synthwave');
    await page.waitForTimeout(400);
    await page.click('#toggle-play');
    await page.waitForTimeout(800);
    await page.click('#tab-advanced');
    await page.waitForTimeout(400);

    const cdp = await context.newCDPSession(page);
    const listenerCount = async (expr) => {
      const { result } = await cdp.send('Runtime.evaluate', { expression: expr, objectGroup: 'churn' });
      const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
      return listeners.length;
    };
    const sample = async () => {
      await cdp.send('HeapProfiler.collectGarbage').catch(() => {});
      await sleep(250);
      const s = await page.evaluate(() => ({
        // The heap WITHOUT the live AudioBuffers' samples. The engine fills
        // its noise caches once, lazily, the first time a voice asks for a
        // colour (engine-voices noiseBuffer: 768 KB per short colour, 4.6 MB
        // for the twelve-second bed) — whenever the piece happens to reach
        // that voice. Inside a window that is one step of up to 4.6 MB, and
        // on 2026-11-05 it read as the TABS churn leaking +166 KB a cycle.
        // Live buffers are still counted, separately, as bufferMB.
        heap: performance.memory.usedJSHeapSize - window.__churn.bufferBytes,
        rawHeap: performance.memory.usedJSHeapSize,
        bufferMB: +(window.__churn.bufferBytes / 1048576).toFixed(2),
        dom: document.querySelectorAll('*').length,
        intervals: window.__churn.intervals,
        subs: window.__churn.subs,
        observed: window.__churn.observed,
        liveNodes: window.__churn.createdTotal - window.__churn.collected,
        activeNotes: window.__ambi4Engine.getStats().total,
      }));
      s.win = await listenerCount('window');
      s.doc = await listenerCount('document');
      await cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'churn' }).catch(() => {});
      return s;
    };

    const tracks = await page.evaluate(() => Object.keys(window.__ambi4Engine.getParams().tracks));
    // Build every editor once before anything is measured, so a first build
    // (hundreds of elements, by design) never reads as growth.
    for (const t of tracks) {
      await page.evaluate((id) => document.getElementById('voice-edit-toggle-' + id)?.click(), t);
      await page.waitForTimeout(200);
      await page.evaluate((id) => { const ed = document.getElementById('voice-editor-' + id); if (ed && !ed.hidden) document.getElementById('voice-edit-toggle-' + id)?.click(); }, t);
      await page.waitForTimeout(200);
    }
    // Let the PIECE settle before the first churn is read. A piece that has
    // just started is still building what it builds once: each noise colour's
    // two-second stereo buffer (engine-voices noiseBuffer, cached per colour,
    // 768 KB apiece at 48 kHz), the reverb's impulse, the first voices of the
    // tracks that join later. That is ~2 MB of post-GC heap over the first
    // ~15 s of play with NOTHING being clicked — and the editor churn, which
    // runs first, read it as +165 KB a cycle (the genre churn, +64 to +91). Measured on 2026-11-05
    // (v0.0.290): idle cycles from a cold start climbed 62-115 KB a cycle and
    // then flattened; editor cycles AFTER that read 13.6 and 5.8 KB a cycle,
    // the same as idle. So: play, with a forced GC each second, until the
    // floor stops climbing (at least minSecs, at most 60 s), then churn.
    const settleHeap = async (minSecs = 20) => {
      const ys = [];
      const t0 = Date.now();
      for (;;) {
        await page.waitForTimeout(1000);
        await cdp.send('HeapProfiler.collectGarbage').catch(() => {});
        ys.push({ x: ys.length, y: await page.evaluate(() => performance.memory.usedJSHeapSize - window.__churn.bufferBytes) });
        const secs = (Date.now() - t0) / 1000;
        const recent = ys.slice(-15);
        if (secs >= minSecs && recent.length === 15 && slope(recent) < 24 * 1024) return { settled: true, secs: Math.round(secs), kbPerSecond: +(slope(recent) / 1024).toFixed(1) };
        if (secs >= 60) return { settled: false, secs: Math.round(secs), kbPerSecond: +(slope(recent) / 1024).toFixed(1) };
      }
    };
    // The genre churn alternates two genres, and the second one's first
    // minute builds its own once-only state the same way (measured: +62 KB a
    // cycle over its first 24 switches, then 15 and 13). So both are played
    // to a settled floor before anything is read, ending on synthwave, where
    // every churn starts.
    const settle = { synthwave: await settleHeap() };
    await select(page, '#genre-select', 'g:techno-tools');
    settle.technoTools = await settleHeap();
    await select(page, '#genre-select', 'g:synthwave');
    settle.backToSynthwave = await settleHeap(10);
    results.push({ name: 'the piece settled before the churn was read', ok: true, got: settle, want: '(informational)' });

    const CHURN = {
      editor: async (i) => {
        const t = tracks[i % tracks.length];
        await page.evaluate((id) => document.getElementById('voice-edit-toggle-' + id)?.click(), t);
        await page.waitForTimeout(250);
        await page.evaluate((id) => { const ed = document.getElementById('voice-editor-' + id); if (ed && !ed.hidden) document.getElementById('voice-edit-toggle-' + id)?.click(); }, t);
        await page.waitForTimeout(250);
      },
      genre: async (i) => {
        await select(page, '#genre-select', i % 2 ? 'g:techno-tools' : 'g:synthwave');
        await page.waitForTimeout(400);
      },
      voice: async (i) => {
        const opts = await page.evaluate(() => [...document.querySelectorAll('#track-voice-pad option')].map((o) => o.value).filter((v) => v && !v.startsWith('__')));
        await select(page, '#track-voice-pad', opts[i % opts.length]);
        await page.waitForTimeout(350);
      },
      share: async () => {
        await page.evaluate(() => { navigator.clipboard.writeText = () => Promise.resolve(); });
        await openFoldFor(page, '#preset-share');
        await page.evaluate(() => document.getElementById('preset-share')?.click());
        await page.waitForTimeout(350);
      },
      structure: async (i) => {
        await openFoldFor(page, '#structure');
        if (i === 0) { await select(page, '#structure', 'custom'); await page.waitForTimeout(200); }
        await page.evaluate(() => document.getElementById('add-structure-block')?.click());
        await page.waitForTimeout(150);
        await page.evaluate(() => { const blocks = document.querySelectorAll('.structure-block'); blocks[blocks.length - 1]?.querySelector('.block-remove')?.click(); });
        await page.waitForTimeout(150);
      },
      pause: async () => {
        await page.evaluate(() => document.getElementById('pause-toggle')?.click());
        await page.waitForTimeout(300);
        await page.evaluate(() => document.getElementById('pause-toggle')?.click());
        await page.waitForTimeout(300);
      },
      tabs: async () => {
        await page.click('#tab-simple'); await page.waitForTimeout(150);
        await page.click('#tab-advanced'); await page.waitForTimeout(150);
      },
      create: async () => {
        await page.click('#play-along-open'); await page.waitForTimeout(200);
        await page.keyboard.press('Escape'); await page.waitForTimeout(200);
      },
      dial: async (i) => {
        const k = await knobAt(page, '#panel-advanced', 'Tempo');
        if (!k) return;
        await drag(page, k, 0, i % 2 ? 40 : -40);
      },
    };

    for (const [name, fn] of Object.entries(CHURN)) {
      const pts = [];
      for (let i = 0; i < CYCLES; i++) {
        await fn(i);
        const s = await sample();
        pts.push({ i, ...s });
      }
      series[name] = pts;
      const tail = pts.filter((p) => p.i >= WARMUP);
      const sl = (k) => slope(tail.map((p) => ({ x: p.i, y: p[k] })));
      const delta = (k) => tail[tail.length - 1][k] - tail[0][k];
      const row = { name, heapKBPerCycle: +(sl('heap') / 1024).toFixed(1), heapDeltaMB: +(delta('heap') / 1048576).toFixed(2), rawHeapKBPerCycle: +(sl('rawHeap') / 1024).toFixed(1), bufferMBDelta: +delta('bufferMB').toFixed(2), domPerCycle: +sl('dom').toFixed(2), domDelta: delta('dom'), winDelta: delta('win'), docDelta: delta('doc'), intervalsDelta: delta('intervals'), subsDelta: delta('subs'), observedDelta: delta('observed'), liveNodesPerCycle: +sl('liveNodes').toFixed(1), end: tail[tail.length - 1] };
      results.push({ name: `churn ${name}`, ok: true, got: row, want: '(informational)' });
      check(`${name}: the DOM does not grow per cycle`, row.domPerCycle, (v) => v <= 1);
      check(`${name}: window/document listeners do not grow per cycle`, { win: row.winDelta, doc: row.docDelta }, (v) => v.win <= 1 && v.doc <= 1);
      check(`${name}: no interval is left running per cycle`, row.intervalsDelta, (v) => v <= 0);
      check(`${name}: no engine subscription is left behind per cycle`, row.subsDelta, (v) => v <= 1);
      check(`${name}: no ResizeObserver observation is left behind per cycle`, row.observedDelta, (v) => v <= 1);
      check(`${name}: the post-GC heap does not climb unmistakably`, row.heapKBPerCycle, (v) => v < 64);
    }

    // The gesture the soak logged as "Dynamics: Auto -> Auto".
    await page.evaluate(() => document.getElementById('voice-edit-toggle-bass')?.click());
    await page.waitForTimeout(300);
    const before = await page.evaluate(() => window.__ambi4Engine.getParams().tracks.bass.dynamics ?? null);
    const k = await knobAt(page, '#voice-editor-bass', 'Dynamics');
    check('the bass editor shows a Dynamics dial', !!k, true);
    if (k) {
      await drag(page, k, 0, -50);
      const after = await page.evaluate(() => window.__ambi4Engine.getParams().tracks.bass.dynamics ?? null);
      const read = await knobAt(page, '#voice-editor-bass', 'Dynamics');
      results.push({ name: 'Dynamics before/after a 50 px upward drag', ok: true, got: { before, after, valuetext: { before: k.valuetext, after: read && read.valuetext } }, want: '(informational)' });
      check('a vertical drag on Dynamics at Auto reaches the ENGINE', JSON.stringify(after) !== JSON.stringify(before), true);
    }

    check('no page or console errors during the churn', errors, (v) => v.length === 0);
  } finally {
    await browser.close().catch(() => {});
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error('churn-drive: ' + failed.length + ' failed\n'
      + failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n')
      + '\n' + results.filter((r) => r.want === '(informational)').map((r) => `${r.name}: ${JSON.stringify(r.got)}`).join('\n'));
  }
  return { passed: results.length, notes: results.filter((r) => r.want === '(informational)').map((r) => `${r.name}: ${JSON.stringify(r.got)}`) };
}
