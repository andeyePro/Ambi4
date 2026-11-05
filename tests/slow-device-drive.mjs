/**
 * A slow phone on a slow network, in a real browser.
 *
 *   npm run build && .vibe/measure.sh local drive tests/slow-device-drive.mjs
 *
 * Everything the page does happens in the reader's own browser, and the
 * reader is as likely to be on a four-year-old phone on a train as on the
 * Mac this is built on. CDP throttles the tab (4x and 6x CPU, Slow 3G:
 * 400 ms latency, 400 kbps) and the drive measures what a listener would
 * meet: how long the boot takes and what it waited for, whether the
 * fallback paragraph shows when it should not, whether the Processor
 * readout names the tier the governor actually holds, whether the scheduler
 * starves with six tracks sounding and whether anything says so, whether a
 * dial drag's last pointer event still reaches the engine, whether the
 * ticker's setInterval fallback keeps the bars coming with no Worker, and
 * whether the tour's ring and the popovers land where they claim once a
 * slow layout has settled.
 *
 * Timings are reported as a table (informational rows); faults are
 * assertions.
 */

const SLOW_3G = {
  offline: false,
  latency: 400,
  downloadThroughput: (400 * 1000) / 8,
  uploadThroughput: (400 * 1000) / 8,
};
const UNTHROTTLED = { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };

const settle = async (page, ms = 400) => {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.waitForTimeout(ms);
};

export default async function drive(page) {
  const results = [];
  const timings = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
    return ok;
  };
  const info = (name, got) => results.push({ name, ok: true, got, want: '(informational)' });

  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + (e && e.message ? e.message : String(e))));

  const url = page.url();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  // The harness has already loaded the page once, so every chunk is in the
  // memory cache and a throttled network would throttle nothing: the first
  // probe measured a 271 ms "Slow 3G" boot with every resource at 0 bytes.
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });

  // Prove the CPU throttle bites before trusting any timing under it: the
  // same busy loop at 1x and at 4x. Chrome's rate is approximate, so only a
  // clear slowdown is asserted.
  const spin = () => page.evaluate(() => {
    const t0 = performance.now();
    let x = 0;
    for (let i = 0; i < 3e6; i++) x += Math.sqrt(i);
    return { ms: Math.round(performance.now() - t0), x: x > 0 };
  });
  const spin1 = await spin();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const spin4 = await spin();
  info('CPU throttle proof (same loop at 1x and 4x, ms)', { at1x: spin1.ms, at4x: spin4.ms });
  check('the 4x CPU throttle really slows the tab', spin4.ms > spin1.ms * 2, (v) => v === true);

  // A slow phone also REPORTS fewer cores and less memory, which is what the
  // governor's starting tier is read from; the Mac's 12 cores would start it
  // at full and hide any honesty question. Four and four is a mid-range
  // Android of a few years ago.
  await page.addInitScript(() => {
    try { Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 4 }); } catch {}
    try { Object.defineProperty(navigator, 'deviceMemory', { get: () => 4 }); } catch {}
  });

  // ---- A. boot at 4x CPU on Slow 3G -----------------------------------------
  await cdp.send('Network.emulateNetworkConditions', SLOW_3G);
  await page.goto('about:blank');
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'commit', timeout: 120000 });
  const tCommit = Date.now() - t0;
  await page.waitForSelector('#generator-app:not([hidden])', { timeout: 120000 }).catch(() => {});
  const tApp = Date.now() - t0;
  const bootState = await page.evaluate(() => ({
    app: !document.getElementById('generator-app').hidden,
    unavailable: !document.getElementById('generator-unavailable').hidden,
    unavailableText: document.getElementById('generator-unavailable').textContent.trim().slice(0, 120),
    engine: typeof window.__ambi4Engine,
    governor: typeof window.__ambi4Governor,
  }));
  check('4x/Slow 3G: #generator-app becomes visible', bootState.app, true);
  check('4x/Slow 3G: the fallback paragraph stays hidden', bootState.unavailable, false);
  check('4x/Slow 3G: the engine seam is present', bootState.engine, 'object');
  timings.push({ phase: '4x + Slow 3G', step: 'navigation committed', ms: tCommit });
  timings.push({ phase: '4x + Slow 3G', step: '#generator-app visible', ms: tApp });

  const resources = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const res = performance.getEntriesByType('resource').map((r) => ({
      name: r.name.replace(/^.*\/\/[^/]+/, ''),
      type: r.initiatorType,
      bytes: r.transferSize,
      start: Math.round(r.startTime),
      end: Math.round(r.responseEnd),
    })).sort((a, b) => a.start - b.start);
    // How many of the fetches could only START once an earlier one had
    // finished: a dynamic import awaited in sequence costs one network round
    // trip each, and on a 400 ms link the round trips, not the bytes, are
    // the boot.
    let serial = 0;
    for (let i = 1; i < res.length; i++) if (res[i].start >= res[i - 1].end - 5) serial++;
    return {
      domContentLoaded: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
      load: nav ? Math.round(nav.loadEventEnd) : null,
      htmlBytes: nav ? nav.transferSize : null,
      totalBytes: res.reduce((s, r) => s + (r.bytes || 0), 0),
      serialRoundTrips: serial,
      resources: res,
    };
  });
  info('4x/Slow 3G: what the boot fetched', resources);
  // The boot's modules must be fetched TOGETHER once the entry script has
  // run, not as a chain: on dev before the fix the chain was thirteen serial
  // round trips (css → entry → engine → prefs → genre-compiler → visualiser →
  // knob → rule-control → scope → patch-words → sound-finder → sample-match →
  // power), eleven seconds of a 24.9 s boot on this link. css → entry → the
  // batch is three; a little slack for the entry's own static chunks.
  check('4x/Slow 3G: the boot-path chunks are fetched in parallel, not as a chain (serial round trips ≤ 5)', resources.serialRoundTrips, (v) => v <= 5);
  timings.push({ phase: '4x + Slow 3G', step: 'DOMContentLoaded', ms: resources.domContentLoaded });
  timings.push({ phase: '4x + Slow 3G', step: 'load event', ms: resources.load });

  await page.click('#consent-slot button:has-text("Save on this device")', { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(300);

  // Play: time from the click to the first 'bar' the engine schedules.
  await page.evaluate(() => {
    const e = window.__ambi4Engine;
    window.__slowBars = [];
    window.__slowT0 = performance.now();
    e.on('bar', (ev) => {
      const now = typeof e.now === 'function' ? e.now() : null;
      window.__slowBars.push({ bar: ev.bar, time: ev.time, ctxNow: now, lead: now == null ? null : ev.time - now, wall: performance.now() });
    });
  });
  const tPlay0 = Date.now();
  await page.click('#toggle-play');
  await page.waitForFunction(() => window.__slowBars.length > 0, { timeout: 30000 }).catch(() => {});
  const tFirstBar = Date.now() - tPlay0;
  const firstBar = await page.evaluate(() => window.__slowBars[0] || null);
  check('4x/Slow 3G: Play produces a first bar', !!firstBar, (v) => v === true);
  timings.push({ phase: '4x + Slow 3G', step: 'Play → first bar scheduled', ms: tFirstBar });
  timings.push({ phase: '4x + Slow 3G', step: 'navigation → playing (sum)', ms: tApp + tFirstBar });
  const playState = await page.evaluate(() => ({
    label: document.querySelector('.play-toggle-label')?.textContent.trim(),
    pressed: document.getElementById('toggle-play').getAttribute('aria-pressed'),
    readout: document.getElementById('processor-readout')?.textContent,
    stats: window.__ambi4Governor?.stats?.() || null,
  }));
  check('4x/Slow 3G: the transport reads Finish while playing', playState.label, 'Finish');
  info('4x/Slow 3G: processor readout at play', { readout: playState.readout, tier: playState.stats?.tier, mode: playState.stats?.mode, sensors: playState.stats?.sensors });
  // A 4-core / 4 GB device starts the span at Low (power.js staticPriorTier),
  // and the readout must say which tier is in force, not just "Auto".
  check('4x/Slow 3G: a 4-core/4 GB device starts at the Low tier', playState.stats?.tier, 'low');
  check('4x/Slow 3G: the readout names that tier', /\(low\)/.test(playState.readout || ''), (v) => v === true);

  // ---- B. six tracks at 6x: tier honesty and starvation ---------------------
  await cdp.send('Network.emulateNetworkConditions', UNTHROTTLED);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
  const trackLevels = await page.evaluate(() => {
    const p = window.__ambi4Engine.getParams();
    return Object.fromEntries(Object.entries(p.tracks || {}).map(([k, v]) => [k, v.level]));
  });
  info('6x: track levels in force', trackLevels);
  const samples = [];
  const sampleEvery = 2000;
  const sampleFor = 24000;
  const tS0 = Date.now();
  while (Date.now() - tS0 < sampleFor) {
    await page.waitForTimeout(sampleEvery);
    const s = await page.evaluate(() => {
      const bars = window.__slowBars;
      const g = window.__ambi4Governor;
      const st = g?.stats?.();
      const readout = document.getElementById('processor-readout')?.textContent || '';
      const m = /\(([a-z]+)\)/.exec(readout);
      return {
        t: Math.round(performance.now() - window.__slowT0),
        bars: bars.length,
        lastLead: bars.length ? bars[bars.length - 1].lead : null,
        minLead: bars.reduce((m, b) => (b.lead != null && (m == null || b.lead < m) ? b.lead : m), null),
        readout,
        readoutTier: m ? m[1] : readout.split(' ')[0],
        tier: st?.tier,
        mode: st?.mode,
        auto: g?.getAuto?.(),
        frameEma: st?.sensors?.frameEmaMs == null ? null : Math.round(st.sensors.frameEmaMs),
        pressure: st?.sensors?.pressureState,
        active: window.__ambi4Engine.getStats().total,
        warning: document.getElementById('processor-warning')?.hidden === false,
        status: document.getElementById('transport-status')?.textContent?.trim() || '',
      };
    });
    samples.push(s);
  }
  info('6x: tier / starvation samples', samples);
  const disagree = samples.filter((s) => s.tier && s.readoutTier && s.tier !== s.readoutTier && s.readoutTier.toLowerCase() !== s.tier);
  check('6x: the Processor readout names the tier the governor holds, every sample', disagree.map((s) => [s.t, s.readout, s.tier]), []);
  const barGaps = await page.evaluate(() => {
    const b = window.__slowBars;
    const gaps = [];
    for (let i = 1; i < b.length; i++) gaps.push(Math.round(b[i].wall - b[i - 1].wall));
    return { count: b.length, gaps, minLead: b.reduce((m, x) => (x.lead != null && (m == null || x.lead < m) ? x.lead : m), null), bpm: window.__ambi4Engine.getParams().bpm };
  });
  info('6x: bar cadence (wall-clock gaps ms, min scheduling lead s)', barGaps);
  const barsDuring = samples[samples.length - 1].bars - (samples[0]?.bars ?? 0);
  check('6x: bars keep coming while six tracks play', barsDuring > 0, (v) => v === true);
  check('6x: the scheduler never fell behind the audio clock (min lead ≥ 0)', barGaps.minLead == null || barGaps.minLead >= -0.01, (v) => v === true);
  const tierDropped = samples.some((s, i) => i > 0 && s.tier !== samples[i - 1].tier);
  info('6x: did the governor move the tier during the window', { tierDropped, tiers: [...new Set(samples.map((s) => s.tier))] });

  // Harsher still: 20x, the main thread of a phone that is also doing
  // something else. Does the scheduler fall behind the audio clock (a bar
  // scheduled after its own start time is a gap the listener hears), and
  // does the page say anything when it does?
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 20 });
  const harshStart = await page.evaluate(() => window.__slowBars.length);
  await page.waitForTimeout(12000);
  const harsh = await page.evaluate((from) => {
    const b = window.__slowBars.slice(from);
    const g = window.__ambi4Governor?.stats?.();
    const gaps = [];
    for (let i = 1; i < b.length; i++) gaps.push(Math.round(b[i].wall - b[i - 1].wall));
    return {
      bars: b.length,
      gaps,
      leads: b.map((x) => x.lead == null ? null : Math.round(x.lead * 1000) / 1000),
      minLead: b.reduce((m, x) => (x.lead != null && (m == null || x.lead < m) ? x.lead : m), null),
      readout: document.getElementById('processor-readout')?.textContent,
      tier: g?.tier,
      frameEma: g?.sensors?.frameEmaMs == null ? null : Math.round(g.sensors.frameEmaMs),
      status: document.getElementById('transport-status')?.textContent?.trim() || '',
      warning: document.getElementById('processor-warning')?.hidden === false,
    };
  }, harshStart);
  info('20x: bars, scheduling lead and what the page says', harsh);
  // The engine keeps its own record of the starvation this drive measures
  // from outside (getStats().late), and the governor reads it as a sensor
  // (stats().sensors.schedulerLate): a bar this drive saw go out late must
  // be a bar the engine counted, or the governor is blind to it.
  const lateRecord = await page.evaluate(() => ({
    engine: window.__ambi4Engine.getStats().late || null,
    governor: window.__ambi4Governor?.stats?.().sensors?.schedulerLate,
  }));
  info('20x: the engine\'s own late-pulse record', lateRecord);
  check('the engine publishes getStats().late {count, worstSeconds, lastAt}', lateRecord.engine && ['count', 'worstSeconds', 'lastAt'].every((k) => Number.isFinite(lateRecord.engine[k])), (v) => v === true);
  check('the governor reads the late count as a sensor', Number.isFinite(lateRecord.governor), (v) => v === true);
  const sawLate = harsh.minLead != null && harsh.minLead < -0.005;
  check('a bar this drive saw scheduled late is one the engine counted', !sawLate || (lateRecord.engine && lateRecord.engine.count >= 1), (v) => v === true);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
  await page.waitForTimeout(1000);

  // ---- C. a dial drag under 6x still reaches the engine ----------------------
  await page.click('#tab-advanced');
  await settle(page, 500);
  const dial = await page.evaluate(() => {
    const k = [...document.querySelectorAll('#panel-advanced .knob')].find((el) => el.getAttribute('aria-label') === 'Tempo');
    if (!k) return null;
    k.scrollIntoView({ block: 'center' });
    const r = k.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.width / 2), text: k.querySelector('.knob-value')?.textContent.trim() };
  });
  check('6x: the Advanced Tempo dial is reachable', !!dial, (v) => v === true);
  let drag = null;
  if (dial) {
    const before = await page.evaluate(() => window.__ambi4Engine.getParams().bpm);
    await page.mouse.move(dial.x, dial.y);
    await page.mouse.down();
    for (let t = 4; t <= 80; t += 4) await page.mouse.move(dial.x, dial.y - t);
    await page.mouse.up();
    await settle(page, 500);
    drag = await page.evaluate(() => {
      const k = [...document.querySelectorAll('#panel-advanced .knob')].find((el) => el.getAttribute('aria-label') === 'Tempo');
      return {
        readout: k.querySelector('.knob-value')?.textContent.trim(),
        valuenow: k.getAttribute('aria-valuenow'),
        bpm: window.__ambi4Engine.getParams().bpm,
      };
    });
    info('6x: Tempo drag', { before, ...drag });
    check('6x: the drag changed the engine tempo', drag.bpm !== before, (v) => v === true);
    const shown = parseFloat(String(drag.readout).replace(/[^\d.–-]/g, ''));
    check('6x: the Tempo readout equals the engine bpm after the drag', Math.abs(shown - drag.bpm) < 0.51, (v) => v === true);
  }

  // ---- D. the ticker's setInterval fallback keeps bars coming ---------------
  await page.click('#toggle-play'); // Finish
  await page.waitForTimeout(300);
  await page.click('#toggle-play'); // Stop now
  await page.waitForFunction(() => document.querySelector('.play-toggle-label').textContent.trim() === 'Play', { timeout: 15000 }).catch(() => {});
  const noWorker = await page.evaluate(async () => {
    const saved = window.Worker;
    window.Worker = undefined;
    window.__slowBars.length = 0;
    const n0 = 0;
    document.getElementById('toggle-play').click();
    const t0 = performance.now();
    await new Promise((r) => {
      const tick = () => (window.__slowBars.length > n0 + 1 || performance.now() - t0 > 12000 ? r() : setTimeout(tick, 100));
      tick();
    });
    window.Worker = saved;
    return { bars: window.__slowBars.length, ms: Math.round(performance.now() - t0), label: document.querySelector('.play-toggle-label').textContent.trim() };
  });
  info('6x, no Worker: bars via the setInterval fallback', noWorker);
  check('6x, no Worker: the setInterval ticker still schedules bars', noWorker.bars >= 2, (v) => v === true);

  // ---- E. tour ring and popovers after a slow layout settles -----------------
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.click('#tutorial-toggle');
  await settle(page, 500);
  const tourRects = [];
  for (let i = 0; i < 9; i++) {
    const rect = await page.evaluate(() => {
      const panel = document.getElementById('tutorial-panel');
      const target = document.querySelector('.tutorial-highlight');
      const step = document.getElementById('tutorial-progress')?.textContent.trim();
      if (!target) return { step, target: null };
      target.scrollIntoView({ block: 'center' });
      return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
        const t = target.getBoundingClientRect();
        const p = panel.getBoundingClientRect();
        const cs = getComputedStyle(target);
        const visible = cs.display !== 'none' && cs.visibility !== 'hidden' && t.width > 0 && t.height > 0;
        const overlap = Math.max(0, Math.min(t.right, p.right) - Math.max(t.left, p.left)) * Math.max(0, Math.min(t.bottom, p.bottom) - Math.max(t.top, p.top));
        resolve({ step, target: target.id || target.className, visible, inView: t.top >= 0 && t.bottom <= innerHeight, overlapWithPanel: Math.round(overlap), t: [Math.round(t.left), Math.round(t.top), Math.round(t.width), Math.round(t.height)] });
      })));
    });
    tourRects.push(rect);
    const last = await page.evaluate(() => document.getElementById('tutorial-next').disabled);
    if (last) break;
    await page.click('#tutorial-next');
    await settle(page, 500);
  }
  info('6x: tour steps (rects after settle)', tourRects);
  check('6x: every tour step with a target rings a visible element', tourRects.filter((r) => r.target && !r.visible).map((r) => r.step), []);
  check('6x: the tour panel never covers the element it rings', tourRects.filter((r) => r.overlapWithPanel > 0).map((r) => [r.step, r.target, r.overlapWithPanel]), []);
  await page.click('#tutorial-toggle');
  await settle(page, 300);

  const pops = [];
  for (const [toggleId, popId] of [['timers-toggle', 'timers-popover'], ['play-along-open', 'play-along']]) {
    await page.evaluate((id) => document.getElementById(id)?.scrollIntoView({ block: 'center' }), toggleId);
    await page.click(`#${toggleId}`);
    await settle(page, 400);
    const box = await page.evaluate((id) => {
      const el = document.getElementById(id);
      if (!el || el.hidden) return null;
      const r = el.getBoundingClientRect();
      return { id, left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), vw: innerWidth, vh: innerHeight };
    }, popId);
    pops.push(box);
    await page.keyboard.press('Escape');
    await settle(page, 200);
  }
  info('6x: popover boxes', pops);
  check('6x: both popovers open on screen', pops.map((b) => b && b.left >= 0 && b.right <= b.vw && b.top >= 0), [true, true]);

  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await cdp.send('Network.emulateNetworkConditions', UNTHROTTLED);

  check('no console errors or page errors during the run', errors, []);

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'slow-device-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n') +
      '\n  timings ' + JSON.stringify(timings) +
      '\n  info ' + JSON.stringify(results.filter((r) => r.want === '(informational)').map((r) => [r.name, r.got])),
    );
  }
  return { passed: results.length, timings, notes: results.filter((r) => r.want === '(informational)').map((r) => ({ [r.name]: r.got })) };
}
