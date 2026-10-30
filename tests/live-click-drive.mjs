/**
 * Clicks, measured on the LIVE engine in a real Web Audio implementation.
 *
 *   npm run build && .vibe/measure.sh local drive tests/live-click-drive.mjs
 *
 * The owner's law: nothing changes instantaneously while it is sounding. Until
 * now every proof of that ran against Node mocks (an AudioParam that records
 * what it was asked, not what it rendered) or rendered ONE voice offline.
 * Headless Chromium is a real renderer, and the page's engine runs in it: this
 * taps what leaves the engine (`getOutputAnalyser()` — post-fader,
 * post-limiter, the analyser passes its input straight through) with a
 * ScriptProcessor, so every sample the listener would hear is in a buffer, and
 * performs each transport and mix action the owner has reported a click on
 * WHILE the piece sounds.
 *
 * A click is a step in the sample stream and a step has a size. For each
 * action the stream from just before it to ~1.5 s after is measured for:
 *   - maxStep: the largest |x[n] − x[n−1]|;
 *   - lone: how many steps in the 5 ms around the worst one are within half
 *     of it. A noise transient (a pluck, a hit) is dozens; a discontinuity is
 *     one or two;
 *   - maxRmsJump: the largest relative change between adjacent 5 ms RMS
 *     windows — a level that moved by most of itself in 5 ms.
 * The gate is tuned from the piece ITSELF: a control stretch with no action
 * gives the stream's own 99th-percentile step and its own worst step (a
 * pluck's onset), and an action's worst step must sit under
 * max(4 × p99, 1.5 × controlMax) unless it is part of a burst. Every action's
 * numbers are reported, clean or not, so the chair sees the margins.
 *
 * Pinned: Ambient (g:ambient) with pad/bass/melody ON and the rest OFF, so the
 * control stretch is sustained material and a percussive hit cannot be
 * mistaken for a click.
 */

const TAP = async () => {
  const engine = window.__ambi4Engine;
  const a = engine.getOutputAnalyser();
  if (!a) return { error: 'no output analyser (engine not started?)' };
  const t = window.__clickTap;
  if (t && t.analyser === a && t.ctx.state !== 'closed') return { ok: true, reused: true, sr: t.ctx.sampleRate };
  if (t) { try { t.analyser.disconnect(t.node); t.node.disconnect(); } catch {} }
  const ctx = a.context;
  // An AudioWorklet, not a ScriptProcessor: a ScriptProcessor runs on the main
  // thread and DROPS buffers while it is blocked, and the actions measured here
  // (a genre compile, a localStorage write, a reverb impulse build) block it
  // for longer than one buffer — every such gap read as a step at the moment
  // of the action. The worklet copies on the audio thread and its messages
  // queue, so the stream is whole; `frame` lets the main thread prove it.
  const code = `
    class Tap extends AudioWorkletProcessor {
      constructor() { super(); this.on = false;
        this.port.onmessage = (e) => {
          if (e.data === 'start') { this.on = true; this.port.postMessage({ type: 'start', frame: currentFrame }); }
          else if (e.data === 'stop') { this.on = false; this.port.postMessage({ type: 'stop', frame: currentFrame }); }
          else if (e.data === 'mark') { this.port.postMessage({ type: 'mark', frame: currentFrame }); }
        }; }
      process(inputs) {
        const ch = inputs[0];
        if (this.on) {
          const n = ch && ch.length ? ch[0].length : 128;
          const mono = new Float32Array(n);
          if (ch && ch.length) for (const c of ch) for (let i = 0; i < n; i++) mono[i] += c[i] / ch.length;
          this.port.postMessage({ type: 'data', frame: currentFrame, data: mono }, [mono.buffer]);
        }
        return true;
      }
    }
    registerProcessor('ambi4-click-tap', Tap);`;
  if (!window.__clickTapModule || window.__clickTapModule.ctx !== ctx) {
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(url);
    window.__clickTapModule = { ctx, url };
  }
  const node = new AudioWorkletNode(ctx, 'ambi4-click-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  const sink = ctx.createGain();
  sink.gain.value = 0;
  a.connect(node);
  node.connect(sink);
  sink.connect(ctx.destination);
  const tap = { ctx, analyser: a, node, sink, chunks: [], frames: [], recording: false, startFrame: null, markFrame: null, gaps: 0, gapList: [], waiting: [] };
  node.port.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'data') {
      if (tap.startFrame === null && m.frame > 0) tap.startFrame = m.frame;
      const last = tap.frames.length ? tap.frames[tap.frames.length - 1] : null;
      if (last !== null && m.frame !== last.frame + last.n) { tap.gaps += 1; tap.gapList.push({ at: tap.chunks.reduce((a, c) => a + c.length, 0), expected: last.frame + last.n, got: m.frame }); }
      tap.frames.push({ frame: m.frame, n: m.data.length });
      tap.chunks.push(m.data);
    } else {
      if (m.type === 'mark') tap.markFrame = m.frame;
      const w = tap.waiting.splice(0);
      for (const r of w) r(m);
    }
  };
  tap.ask = (what) => new Promise((resolve) => { tap.waiting.push(resolve); node.port.postMessage(what); });
  window.__clickTap = tap;
  if (!window.__clickLogWired) {
    window.__clickLogWired = true;
    window.__clickLog = [];
    const log = (kind, info) => { if (window.__clickLog) window.__clickLog.push({ kind, ctxTime: +ctx.currentTime.toFixed(4), ...info }); };
    for (const type of ['note', 'bar', 'section', 'state']) {
      engine.on(type, (ev) => log(type, type === 'note' ? { track: ev.track, time: +ev.time.toFixed(4), dur: +ev.duration.toFixed(3) } : type === 'bar' ? { bar: ev.bar, time: +ev.time.toFixed(4) } : type === 'section' ? { label: ev.label, time: +ev.time.toFixed(4) } : { running: ev.running, paused: ev.paused, finished: ev.finished }));
    }
    const orig = engine.setParams;
    engine.setParams = (partial) => { log('setParams', { keys: Object.keys(partial || {}).join(','), volume: partial && partial.volume }); return orig(partial); };
  }
  return { ok: true, sr: ctx.sampleRate };
};

const REC = async (on) => {
  const t = window.__clickTap;
  if (on) { t.chunks = []; t.frames = []; t.startFrame = null; t.markFrame = null; t.gaps = 0; t.gapList = []; window.__clickLog = []; }
  const m = await t.ask(on ? 'start' : 'stop');
  return { frame: m.frame, state: t.ctx.state };
};

const MARK = async () => {
  const t = window.__clickTap;
  const m = await t.ask('mark');
  return { markFrame: m.frame, ctxTime: t.ctx.currentTime, state: t.ctx.state };
};

const ANALYSE = () => {
  const t = window.__clickTap;
  const sr = t.ctx.sampleRate;
  let n = 0;
  for (const c of t.chunks) n += c.length;
  const x = new Float32Array(n);
  let o = 0;
  for (const c of t.chunks) { x.set(c, o); o += c.length; }
  t.mark = Math.max(0, Math.min(n, (t.markFrame ?? t.startFrame) - t.startFrame));
  const from = Math.max(1, t.mark - Math.floor(sr * 0.05));
  const gapAt = new Set(t.gapList.map((g) => g.at));
  let worst = 0, where = from, peak = 0;
  const steps = [];
  for (let i = from; i < n; i++) {
    const d = gapAt.has(i) ? 0 : Math.abs(x[i] - x[i - 1]);
    steps.push(d);
    if (d > worst) { worst = d; where = i; }
    const v = Math.abs(x[i]);
    if (v > peak) peak = v;
  }
  const sorted = Float32Array.from(steps).sort();
  const p99 = sorted.length ? sorted[Math.floor(sorted.length * 0.99)] : 0;
  const p999 = sorted.length ? sorted[Math.floor(sorted.length * 0.999)] : 0;
  const half = Math.floor(sr * 0.0025);
  let lone = 0;
  for (let i = Math.max(1, where - half); i < Math.min(n, where + half); i++) {
    if (Math.abs(x[i] - x[i - 1]) > worst * 0.5) lone += 1;
  }
  // Adjacent 5 ms RMS windows, relative jump.
  const w = Math.floor(sr * 0.005);
  const rms = [];
  for (let s = from; s + w <= n; s += w) {
    let ss = 0;
    for (let i = s; i < s + w; i++) ss += x[i] * x[i];
    rms.push(Math.sqrt(ss / w));
  }
  let maxJump = 0, jumpAt = 0, jumpFrom = 0, jumpTo = 0;
  for (let k = 1; k < rms.length; k++) {
    const hi = Math.max(rms[k], rms[k - 1]);
    if (hi < 0.003) continue; // below −50 dBFS: silence, not a level
    const j = Math.abs(rms[k] - rms[k - 1]) / hi;
    if (j > maxJump) { maxJump = j; jumpAt = from + k * w; jumpFrom = rms[k - 1]; jumpTo = rms[k]; }
  }
  // Does the worst step recur a waveform period later (1–25 ms)? A saw's
  // wrap is a lone steep step every cycle; a discontinuity happens once.
  // ...and again a period after that: two steps of the same size at the SAME
  // lag is a waveform; a cut followed by a second cut is not.
  let periodic = null;
  {
    let best = 0, lag = 0;
    for (let i = where + Math.floor(sr * 0.001); i < Math.min(n, where + Math.floor(sr * 0.025)); i++) {
      const d = Math.abs(x[i] - x[i - 1]);
      if (d > best) { best = d; lag = i - where; }
    }
    let second = 0;
    for (let i = where + 2 * lag - 4; i <= where + 2 * lag + 4; i++) {
      if (i < 1 || i >= n) continue;
      second = Math.max(second, Math.abs(x[i] - x[i - 1]));
    }
    periodic = worst > 0 && lag > 0 ? +(Math.min(best, second) / worst).toFixed(3) : null;
  }
  const series = (centre) => {
    const out = [];
    for (let k = -8; k <= 8; k++) {
      const s0 = centre + k * w;
      if (s0 < 1 || s0 + w > n) { out.push(null); continue; }
      let ss = 0; for (let i = s0; i < s0 + w; i++) ss += x[i] * x[i];
      out.push(+Math.sqrt(ss / w).toFixed(4));
    }
    return out;
  };
  const levelBefore = (() => {
    const a = Math.max(1, t.mark - w * 10), b = t.mark;
    let ss = 0; for (let i = a; i < b; i++) ss += x[i] * x[i];
    return Math.sqrt(ss / Math.max(1, b - a));
  })();
  const levelAfter = (() => {
    const a = Math.min(n, t.mark + w * 100), b = Math.min(n, a + w * 10);
    let ss = 0; for (let i = a; i < b; i++) ss += x[i] * x[i];
    return Math.sqrt(ss / Math.max(1, b - a));
  })();
  const firstFrame = t.frames.length ? Math.min(...t.frames.map((f) => f.frame)) : 0;
  const lastEnd = t.frames.length ? Math.max(...t.frames.map((f) => f.frame + f.n)) : 0;
  const lost = Math.max(0, (lastEnd - firstFrame) - n);
  // Steepness: the step against the loudest sample within 25 ms of it. A
  // sine at 110 Hz moves 1.4% of its amplitude per sample; a pad with
  // harmonics to 2 kHz, a quarter; a cut moves most of it in one.
  let localPeak = 0;
  for (let i = Math.max(0, where - Math.floor(sr * 0.025)); i < Math.min(n, where + Math.floor(sr * 0.025)); i++) localPeak = Math.max(localPeak, Math.abs(x[i]));
  const markCtx = (t.markFrame ?? t.startFrame) / sr;
  const worstCtx = markCtx + (where - t.mark) / sr;
  const near = (window.__clickLog || []).filter((e) => e.kind === 'setParams' ? Math.abs(e.ctxTime - worstCtx) < 0.4 : Math.abs((e.time ?? e.ctxTime) - worstCtx) < 0.25);
  return {
    samples: n, sr, mark: t.mark, gaps: t.gaps, lost, gapList: t.gapList.slice(0, 5), worstCtx: +worstCtx.toFixed(4), near,
    localPeak: +localPeak.toFixed(4), steep: localPeak > 0 ? +(worst / localPeak).toFixed(3) : null,
    maxStep: +worst.toFixed(5), at: +((where - t.mark) / sr).toFixed(4), lone, periodic,
    stepSeries: series(where), jumpSeries: series(jumpAt),
    stepAtMark: +(where >= t.mark - 2 && where <= t.mark + Math.floor(sr * 0.03)),
    p99: +p99.toFixed(5), p999: +p999.toFixed(5), peak: +peak.toFixed(4),
    maxRmsJump: +maxJump.toFixed(3), jumpAt: +((jumpAt - t.mark) / sr).toFixed(4),
    jumpFrom: +jumpFrom.toFixed(4), jumpTo: +jumpTo.toFixed(4),
    levelBefore: +levelBefore.toFixed(4), levelAfter: +levelAfter.toFixed(4),
  };
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
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.width / 2), valuetext: k.getAttribute('aria-valuetext') };
  }, [label, scope]);

const openFoldFor = async (page, selector) => {
  const more = await page.evaluate((s) => (typeof window.__ambi4FoldMore === 'function' ? window.__ambi4FoldMore(s) : null), selector);
  if (more) { await page.click(more); await page.waitForTimeout(150); }
};

export default async function drive(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + (e && e.message ? e.message : String(e))));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  const results = [];
  const rows = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
  };

  // A fresh boot: about:blank first, or a same-document navigation re-boots nothing.
  const url = page.url();
  await page.goto('about:blank');
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('#generator-app:not([hidden])', { timeout: 20000 });
  await page.click('#consent-slot button:has-text("Save on this device")').catch(() => {});
  await page.waitForTimeout(300);

  // Pin the setup: a sustained genre, three tracks on, the rest off.
  const pinned = await page.evaluate(() => {
    const sel = document.getElementById('genre-select');
    const opt = [...sel.options].find((o) => /^g:/.test(o.value) && /ambient/i.test(o.textContent)) || [...sel.options].find((o) => /^g:/.test(o.value));
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return opt.value;
  });
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const e = window.__ambi4Engine;
    e.setParams({ bpm: 70, complexity: 0.5, volume: 0.8, reverbTail: 2, drive: 0,
      tracks: { pad: { state: 'on', voice: 'warm' }, bass: { state: 'on', voice: 'sub' }, melody: { state: 'on', voice: 'flute' }, texture: { state: 'off' }, arp: { state: 'off' }, percussion: { state: 'off' } } });
  });
  // The track rows live on the Advanced tab; a dial in a hidden panel takes no drag.
  await page.click('#tab-advanced');
  await page.waitForTimeout(300);
  // The page's lamps mirror engine state through their own path; set them so
  // the lamp click below starts from a known state.
  await page.evaluate(() => {
    for (const id of ['texture', 'arp', 'percussion']) {
      const lamp = document.getElementById('track-lamp-' + id);
      for (let i = 0; i < 3 && !/state: Off/.test(lamp.getAttribute('aria-label') || ''); i++) lamp.click();
    }
    for (const id of ['pad', 'bass', 'melody']) {
      const lamp = document.getElementById('track-lamp-' + id);
      for (let i = 0; i < 3 && !/state: On/.test(lamp.getAttribute('aria-label') || ''); i++) lamp.click();
    }
  });
  const states = await page.evaluate(() => { const p = window.__ambi4Engine.getParams(); return Object.fromEntries(Object.entries(p.tracks).map(([k, v]) => [k, v.state])); });
  check('tracks pinned: pad/bass/melody on, rest off', [states.pad, states.bass, states.melody, states.texture, states.arp, states.percussion], ['on', 'on', 'on', 'off', 'off', 'off']);

  await page.click('#toggle-play');
  await page.waitForTimeout(2500);
  const tapped = await page.evaluate(TAP);
  check('the output is tapped', tapped.ok, true);
  const SR = tapped.sr;
  await page.evaluate(REC, true); await page.waitForTimeout(100); await page.evaluate(REC, false);

  const measure = async (name, act, { settle = 1500, lead = 300 } = {}) => {
    await page.evaluate(REC, true);
    await page.waitForTimeout(lead);
    const mark = await page.evaluate(MARK);
    const extra = await act();
    await page.waitForTimeout(settle);
    await page.evaluate(REC, false);
    const m = await page.evaluate(ANALYSE);
    rows.push({ name, ...m, ctxState: mark.state, extra });
    return m;
  };

  // ---- control: the piece itself, no action ---------------------------------
  const ctrl = await measure('control (no action)', async () => null, { settle: 3000 });
  // A click is a LONE step (not a transient's burst, not a waveform's
  // periodic wrap) that is far steeper than the stream's own 99th percentile.
  const gateFor = (m) => 4 * Math.max(ctrl.p99, m.p99, 0.001);
  const judge = (m) => m.lone >= 6 || (m.periodic !== null && m.periodic >= 0.55) || m.maxStep <= gateFor(m) || (m.steep !== null && m.steep < 0.3);
  const gate = gateFor(ctrl);
  rows.push({ name: '— click gate —', gate: +gate.toFixed(5), from: { p99: ctrl.p99, max: ctrl.maxStep, lone: ctrl.lone } });
  check('control stretch is sounding (RMS > −40 dBFS)', ctrl.levelBefore > 0.01 || ctrl.levelAfter > 0.01, true);

  const drag = async (label, dx, dy, scope = '', { ms = 25 } = {}) => {
    if (scope) await openFoldFor(page, `${scope} .knob[aria-label="${label}"]`);
    const d = await dialAt(page, label, scope);
    if (!d) return { missing: label };
    await page.mouse.move(d.x, d.y);
    await page.mouse.down();
    const steps = Math.max(Math.abs(dx), Math.abs(dy));
    for (let t = 4; t <= steps; t += 6) {
      const f = t / steps;
      await page.mouse.move(d.x + Math.round(dx * f), d.y + Math.round(dy * f));
      await page.waitForTimeout(ms);
    }
    await page.mouse.up();
    const after = await dialAt(page, label, scope);
    return { from: d.valuetext, to: after && after.valuetext };
  };
  const engineVal = (expr) => page.evaluate((e) => { const p = window.__ambi4Engine.getParams(); return new Function('p', 'return ' + e)(p); }, expr);

  // ---- transport ---------------------------------------------------------------
  const pauseM = await measure('pause', async () => { await page.click('#pause-toggle'); return null; }, { settle: 600 });
  const resumeM = await measure('resume', async () => { await page.click('#pause-toggle'); return null; });
  check('pause/resume: the engine reports paused then running', await page.evaluate(() => window.__ambi4Engine.running && !window.__ambi4Engine.paused), true);

  // The ending, while the level is still healthy: Finish (outro) mid-note,
  // then Stop mid-outro, then Play again for the rest of the sweep.
  await page.waitForTimeout(1200);
  const finishM = await measure('Finish (outro) mid-note', async () => { await page.click('#toggle-play'); return null; }, { settle: 2000 });
  const stopM = await measure('Stop mid-outro', async () => { await page.click('#toggle-play'); return null; }, { settle: 800 });
  check('stopped: the engine is not running', await page.evaluate(() => window.__ambi4Engine.running), false);
  await page.click('#toggle-play');
  await page.waitForTimeout(2500);
  const retapped = await page.evaluate(TAP);
  check('the output is tapped again after the restart', retapped.ok, true);
  rows.push({ name: 'retap after restart', ...retapped });
  const ctrl2 = await measure('control 2 (after restart, no action)', async () => null, { settle: 2500 });

  // ---- mix dials (Simple tab) ----------------------------------------------------
  await page.click('#tab-simple').catch(() => {});
  await page.waitForTimeout(200);
  const volDown = await measure('master Volume drag (down)', () => drag('Volume', 0, 60, '#panel-simple'));
  const volUp = await measure('master Volume drag (up)', () => drag('Volume', 0, -60, '#panel-simple'));
  rows.push({ name: 'engine volume after drags', volume: await engineVal('p.volume') });
  const energyM = await measure('Energy drag', () => drag('Energy', 0, -50, '#panel-simple'));
  rows.push({ name: 'engine complexity after Energy drag', complexity: await engineVal('p.complexity') });
  // Energy hands every hand-set lamp back to Auto (its hint says so); the
  // sustained lineup is restored so the rest of the sweep measures the same
  // material as the control.
  await page.evaluate(() => window.__ambi4Engine.setParams({ tracks: { pad: { state: 'on' }, bass: { state: 'on' }, melody: { state: 'on' }, texture: { state: 'off' }, arp: { state: 'off' }, percussion: { state: 'off' } } }));
  await page.waitForTimeout(1500);
  const tempoM = await measure('Tempo drag', () => drag('Tempo', 0, -50, '#panel-simple'), { settle: 2500 });
  rows.push({ name: 'engine bpm after Tempo drag', bpm: await engineVal('p.bpm') });
  const volRestore = await measure('Volume set back to 0.8 (setParams)', () => page.evaluate(() => { window.__ambi4Engine.setParams({ volume: 0.8 }); return null; }));

  // ---- Drive and Reverb tail (Advanced, behind the Sound "more") -------------------
  await page.click('#tab-advanced').catch(() => {});
  await page.waitForTimeout(300);
  const driveOn = await measure('Drive on (drag up)', () => drag('Drive', 0, -50, '#panel-advanced'));
  rows.push({ name: 'engine drive after drag', drive: await engineVal('p.drive') });
  const driveOff = await measure('Drive off (drag down to 0)', () => drag('Drive', 0, 120, '#panel-advanced'));
  rows.push({ name: 'engine drive after off', drive: await engineVal('p.drive') });
  const reverbM = await measure('Reverb tail drag', () => drag('Reverb tail', 0, -60, '#panel-advanced', { ms: 60 }), { settle: 2500 });
  rows.push({ name: 'engine reverbTail after drag', reverbTail: await engineVal('p.reverbTail') });

  // ---- tracks -----------------------------------------------------------------------
  const voiceM = await measure('voice pick on pad while it sounds', () => page.evaluate(async () => {
    const e = window.__ambi4Engine;
    const sel = document.getElementById('track-voice-pad');
    const sounding = e.getResolved().tracks.pad.voice;
    const opt = [...sel.options].find((o) => !o.disabled && o.value !== sounding && ['choir', 'strings', 'glass', 'warm'].includes(o.value));
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    return { from: sounding, to: opt.value, engine: e.getParams().tracks.pad.voice, dialog: !!document.querySelector('dialog[open]') };
  }), { settle: 2000 });
  check('voice pick: the engine received the new pad voice', voiceM && rows[rows.length - 1].extra.engine === rows[rows.length - 1].extra.to, true);
  const lampProbe = async (clicks) => page.evaluate(async (n) => {
    const lamp = document.getElementById('track-lamp-pad');
    const before = lamp.getAttribute('aria-label');
    for (let i = 0; i < n; i++) { lamp.click(); await new Promise((r) => setTimeout(r, 120)); }
    return { before, after: lamp.getAttribute('aria-label'), engine: window.__ambi4Engine.getParams().tracks.pad.state, dialog: !!document.querySelector('dialog[open]') };
  }, clicks);
  // Energy sends every hand-set lamp back to Auto (its hint says so), so the
  // lamp is put to On first and the measured press is the one to Off.
  await page.evaluate(async () => {
    const lamp = document.getElementById('track-lamp-pad');
    for (let i = 0; i < 3 && !/state: On/.test(lamp.getAttribute('aria-label') || ''); i++) { lamp.click(); await new Promise((r) => setTimeout(r, 120)); }
  });
  await page.waitForTimeout(1500);
  const muteM = await measure('mute pad (lamp → Off)', () => lampProbe(1), { settle: 3000 });
  check('lamp: one press took the pad from On to Off in the engine', rows[rows.length - 1].extra.engine, 'off');
  const unmuteM = await measure('unmute pad (lamp → Auto → On)', () => lampProbe(2), { settle: 2500 });
  check('lamp: two presses took the pad back to On in the engine', rows[rows.length - 1].extra.engine, 'on');

  for (const id of ['pad', 'bass', 'melody']) {
    const before = await engineVal(`p.tracks.${id}.level`);
    await measure(`Level dial drag: ${id}`, async () => {
      const r = await drag('Level', 0, 40, `.track-row[data-track="${id}"]`);
      return { ...r, engineBefore: before, engine: await engineVal(`p.tracks.${id}.level`) };
    });
    check(`Level drag on ${id} reached the engine`, rows[rows.length - 1].extra.engine !== before, true);
    await page.evaluate(([id, v]) => window.__ambi4Engine.setParams({ tracks: { [id]: { level: v } } }), [id, before]);
    await page.waitForTimeout(400);
  }

  const genreM = await measure('genre switch while playing', () => page.evaluate(() => {
    const sel = document.getElementById('genre-select');
    const cur = sel.value;
    const opt = [...sel.options].find((o) => /^g:/.test(o.value) && o.value !== cur && /lo-?fi|chill|downtempo/i.test(o.textContent)) || [...sel.options].find((o) => /^g:/.test(o.value) && o.value !== cur);
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return { from: cur, to: opt.value, running: window.__ambi4Engine.running };
  }), { settle: 2500 });

  // ---- add / remove a user track -----------------------------------------------------
  const addM = await measure('Add track while playing', () => page.evaluate(() => {
    const btn = document.getElementById('add-track');
    if (!btn) return { missing: 'add-track' };
    btn.click();
    const form = document.getElementById('add-track-form');
    const name = document.getElementById('add-track-name');
    if (name) name.value = 'Probe';
    form.requestSubmit();
    const p = window.__ambi4Engine.getParams();
    return { userTracks: (p.userTracks || []).map((t) => t.id) };
  }), { settle: 2000 });
  const removeM = await measure('Remove track while playing', () => page.evaluate(() => {
    const p = window.__ambi4Engine.getParams();
    const id = (p.userTracks || [])[0]?.id;
    const btn = id ? document.getElementById('track-remove-' + id) : null;
    if (btn) btn.click(); else if (id) window.__ambi4Engine.removeTrack(id);
    return { removed: id, left: (window.__ambi4Engine.getParams().userTracks || []).length };
  }), { settle: 2000 });

  // ---- resolution ×2 / ÷2 in an open editor -------------------------------------------
  const resM = await measure('Resolution ÷2 then ×2 (melody editor)', () => page.evaluate(async () => {
    const edit = document.getElementById('voice-edit-toggle-melody');
    if (edit && edit.getAttribute('aria-expanded') !== 'true') edit.click();
    await new Promise((r) => setTimeout(r, 500));
    const editor = document.getElementById('voice-editor-melody');
    const more = typeof window.__ambi4FoldMore === 'function' ? window.__ambi4FoldMore('#voice-editor-melody .seq-res-step') : null;
    if (more) { document.querySelector(more)?.click(); await new Promise((r) => setTimeout(r, 300)); }
    const hid = (el) => { const out = []; for (let n = el; n && n !== document.body; n = n.parentElement) { if (n.hidden) out.push((n.id || n.className || n.tagName) + ':hidden'); } return out; };
    const btns = editor ? [...editor.querySelectorAll('.seq-res-step')] : [];
    const finer = btns.find((b) => b.textContent.trim() === '÷2');
    const coarser = btns.find((b) => b.textContent.trim() === '×2');
    const seen = { editor: !!editor, more, buttons: btns.map((b) => b.textContent.trim() + (hid(b).length ? '(' + hid(b).join(',') + ')' : '')), stepBeatsBefore: window.__ambi4Engine.getParams().tracks.melody.stepBeats ?? null };
    if (finer) finer.click();
    await new Promise((r) => setTimeout(r, 500));
    if (coarser) coarser.click();
    seen.stepBeatsAfter = window.__ambi4Engine.getParams().tracks.melody.stepBeats ?? null;
    return seen;
  }), { settle: 2500 });

  await page.click('#toggle-play');
  await page.waitForTimeout(300);

  // ---- the gate ----------------------------------------------------------------------
  for (const r of rows) {
    if (typeof r.maxStep !== 'number' || /control/.test(r.name)) continue;
    check(`no click: ${r.name} (step ${r.maxStep} at ${r.at}s, lone ${r.lone}, periodic ${r.periodic}, steep ${r.steep}, gate ${gateFor(r).toFixed(4)})`, judge(r), true);
  }
  check('the tap never lost a buffer (no frames missing from any recording)', rows.filter((r) => typeof r.lost === 'number' && r.lost > 0).map((r) => `${r.name}: ${r.lost}`), []);
  check('no page errors or console errors', errors, []);

  const detail = rows.filter((r) => typeof r.maxStep === 'number').map((r) => ({ name: r.name, worstCtx: r.worstCtx, gapList: r.gapList, near: r.near, stepSeries: r.stepSeries, jumpSeries: r.jumpSeries }));
  const failed = results.filter((r) => !r.ok);
  const table = rows.map((r) => typeof r.maxStep === 'number'
    ? `${r.name.padEnd(44)} lost ${r.lost} step ${String(r.maxStep).padEnd(8)} at ${String(r.at).padEnd(8)} lone ${String(r.lone).padEnd(4)} per ${String(r.periodic).padEnd(6)} steep ${String(r.steep).padEnd(6)} rmsJump ${String(r.maxRmsJump).padEnd(6)} (${r.jumpFrom}→${r.jumpTo} at ${r.jumpAt}s) level ${r.levelBefore}→${r.levelAfter} p99 ${r.p99}${r.extra ? ' ' + JSON.stringify(r.extra) : ''}`
    : `${r.name}: ${JSON.stringify(r)}`);
  if (failed.length) {
    throw new Error(
      'live-click-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n') +
      '\n\n' + table.join('\n') + '\n\nDETAIL ' + JSON.stringify(detail),
    );
  }
  return { passed: results.length, gate: +gate.toFixed(5), table, detail };
}
