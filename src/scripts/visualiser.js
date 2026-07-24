/**
 * visualiser.js — canvas track visualiser for the ambient engine (v2).
 *
 * export function initVisualiser(canvas, engine) => { destroy() }
 *
 * Six horizontal lanes (pad, bass, melody, texture, arp, percussion) show
 * scheduled notes scrolling right-to-left on a time axis (right edge = now +
 * a small lookahead), pitch mapped to vertical position, duration to blip
 * width, velocity to opacity/size. A soft per-track level glow comes from
 * `engine.getAnalysers()`. Section/bar events draw context lines.
 *
 * This module is a pure, self-contained script: no imports, and nothing at
 * module-import time touches `window`/`document`/canvas APIs — every browser
 * global is read lazily inside a function, behind a `typeof`/try-catch guard,
 * so importing this file in a bare Node process is safe. Every access to the
 * `engine` object is similarly guarded: a missing/throwing engine method
 * degrades that one feature rather than throwing out of initVisualiser or
 * the render loop.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TRACKS = ['pad', 'bass', 'melody', 'texture', 'arp', 'percussion'];

const TRACK_LABELS = {
  pad: 'Pad',
  bass: 'Bass',
  melody: 'Melody',
  texture: 'Texture',
  arp: 'Arp',
  percussion: 'Percussion',
};

// Mix ratios (toward --text) used to derive a distinct accent per lane from
// --link/--text, per the visualiser contract.
const LANE_ACCENT_RATIOS = [0.15, 0.32, 0.48, 0.64, 0.8, 0.95];

const HISTORY_SECONDS = 24;     // scrolled time visible left of "now"
const LOOKAHEAD_SECONDS = 0.5;  // small buffer right of "now" so scheduled-ahead notes don't clip
const WINDOW_SECONDS = HISTORY_SECONDS + LOOKAHEAD_SECONDS;
const MAX_NOTES_PER_TRACK = 400;
const MAX_MARKERS = 500;
const REDUCED_MOTION_FPS = 2;
const TOP_MARGIN = 16;
const MIN_LABEL_WIDTH = 36;
const MAX_LABEL_WIDTH = 74;
const MIN_BAR_TICK_SPACING_PX = 8;

// Fallback pitch ranges used until real notes widen them. Percussion is
// positioned by `kind` (low/mid/high), not by this map.
const DEFAULT_MIDI_RANGE = {
  pad: [36, 72],
  bass: [24, 50],
  melody: [55, 85],
  texture: [72, 100],
  arp: [55, 90],
};

const PERCUSSION_KIND_ORDER = { low: 0, mid: 1, high: 2 };

const LABEL_FONT = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

// ---------------------------------------------------------------------------
// Colour helpers (no DOM required — pure string parsing/mixing)
// ---------------------------------------------------------------------------

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clampRange(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function hslToRgb(h, s, l) {
  const hue = ((h % 360) + 360) % 360;
  const sat = clamp01(s);
  const light = clamp01(l);
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = light - c / 2;
  let r1 = 0, g1 = 0, b1 = 0;
  if (hue < 60) { r1 = c; g1 = x; b1 = 0; }
  else if (hue < 120) { r1 = x; g1 = c; b1 = 0; }
  else if (hue < 180) { r1 = 0; g1 = c; b1 = x; }
  else if (hue < 240) { r1 = 0; g1 = x; b1 = c; }
  else if (hue < 300) { r1 = x; g1 = 0; b1 = c; }
  else { r1 = c; g1 = 0; b1 = x; }
  return { r: (r1 + m) * 255, g: (g1 + m) * 255, b: (b1 + m) * 255 };
}

/** Parse a CSS colour string (hex/rgb/hsl) into {r,g,b,a}; falls back on anything unrecognised. */
function parseColor(str, fallback) {
  if (typeof str !== 'string') return fallback;
  const s = str.trim();
  if (!s) return fallback;
  let m;
  if ((m = /^#([0-9a-f]{3})$/i.exec(s))) {
    const [r, g, b] = m[1].split('').map((c) => parseInt(c + c, 16));
    return { r, g, b, a: 1 };
  }
  if ((m = /^#([0-9a-f]{4})$/i.exec(s))) {
    const [r, g, b, a] = m[1].split('').map((c) => parseInt(c + c, 16));
    return { r, g, b, a: a / 255 };
  }
  if ((m = /^#([0-9a-f]{6})$/i.exec(s))) {
    const hex = m[1];
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
      a: 1,
    };
  }
  if ((m = /^#([0-9a-f]{8})$/i.exec(s))) {
    const hex = m[1];
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
      a: parseInt(hex.slice(6, 8), 16) / 255,
    };
  }
  if ((m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s))) {
    return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: m[4] !== undefined ? Number(m[4]) : 1 };
  }
  if ((m = /^hsla?\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s))) {
    const { r, g, b } = hslToRgb(Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100);
    return { r, g, b, a: m[4] !== undefined ? Number(m[4]) : 1 };
  }
  return fallback;
}

function mixColors(a, b, t) {
  const k = clamp01(t);
  return {
    r: a.r + (b.r - a.r) * k,
    g: a.g + (b.g - a.g) * k,
    b: a.b + (b.b - a.b) * k,
    a: a.a + (b.a - a.a) * k,
  };
}

function rgba(color, alpha) {
  return `rgba(${Math.round(color.r)}, ${Math.round(color.g)}, ${Math.round(color.b)}, ${clamp01(alpha)})`;
}

const FALLBACK_THEME = {
  text: { r: 46, g: 46, b: 51, a: 1 },
  secondary: { r: 90, g: 90, b: 95, a: 1 },
  border: { r: 238, g: 238, b: 238, a: 1 },
  link: { r: 0, g: 123, b: 255, a: 1 },
};

/** Reads --text/--secondary/--border/--link off the canvas and derives per-lane accents. */
function readTheme(canvas) {
  let computed = null;
  try {
    computed = getComputedStyle(canvas);
  } catch {
    computed = null;
  }
  const read = (name, fallback) => {
    if (!computed) return fallback;
    try {
      return parseColor(computed.getPropertyValue(name), fallback);
    } catch {
      return fallback;
    }
  };
  const text = read('--text', FALLBACK_THEME.text);
  const secondary = read('--secondary', FALLBACK_THEME.secondary);
  const border = read('--border', FALLBACK_THEME.border);
  const link = read('--link', FALLBACK_THEME.link);
  const laneAccents = TRACKS.map((_, i) => mixColors(link, text, LANE_ACCENT_RATIOS[i]));
  return { text, secondary, border, link, laneAccents };
}

// ---------------------------------------------------------------------------
// Canvas geometry helper (roundRect isn't universally available)
// ---------------------------------------------------------------------------

function roundRectPath(c, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  c.beginPath();
  c.moveTo(x + rr, y);
  c.lineTo(x + w - rr, y);
  c.arcTo(x + w, y, x + w, y + rr, rr);
  c.lineTo(x + w, y + h - rr);
  c.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  c.lineTo(x + rr, y + h);
  c.arcTo(x, y + h, x, y + h - rr, rr);
  c.lineTo(x, y + rr);
  c.arcTo(x, y, x + rr, y, rr);
  c.closePath();
}

// ---------------------------------------------------------------------------
// initVisualiser
// ---------------------------------------------------------------------------

export function initVisualiser(canvas, engine) {
  if (!canvas || typeof canvas.getContext !== 'function') {
    return { destroy() {} };
  }

  let ctx2d;
  try {
    ctx2d = canvas.getContext('2d');
  } catch {
    ctx2d = null;
  }
  if (!ctx2d) return { destroy() {} };

  let destroyed = false;
  let theme = readTheme(canvas);

  // -- per-track state --------------------------------------------------
  const notesByTrack = new Map(TRACKS.map((t) => [t, []]));
  const barTicks = [];    // { time, bar }
  const sectionMarks = []; // { time, label, bar }
  const midiRange = {};
  for (const t of TRACKS) {
    if (DEFAULT_MIDI_RANGE[t]) {
      midiRange[t] = { min: DEFAULT_MIDI_RANGE[t][0], max: DEFAULT_MIDI_RANGE[t][1] };
    }
  }

  let analysers = null;
  const analyserBuffers = new Map(); // track -> Uint8Array
  const levels = new Map(TRACKS.map((t) => [t, 0]));

  let running = false;
  let rafId = null;
  let dpr = 1;
  let cssWidth = 0;
  let cssHeight = 0;

  const unsubs = [];

  // -- engine wiring (defensive: never throw) ----------------------------

  function safeOn(type, handler) {
    try {
      if (typeof engine?.on === 'function') {
        const off = engine.on(type, handler);
        if (typeof off === 'function') unsubs.push(off);
      }
    } catch {
      // engine doesn't support this event type; that feature just degrades
    }
  }

  function engineNow() {
    try {
      if (typeof engine?.now === 'function') {
        const t = engine.now();
        if (typeof t === 'number' && Number.isFinite(t)) return t;
      }
    } catch {
      // fall through
    }
    return 0;
  }

  function refreshAnalysers() {
    try {
      if (typeof engine?.getAnalysers === 'function') {
        const a = engine.getAnalysers();
        if (a && typeof a === 'object') analysers = a;
      }
    } catch {
      analysers = null;
    }
  }

  function computeLevel(track) {
    try {
      const analyser = analysers && analysers[track];
      if (!analyser || typeof analyser.getByteTimeDomainData !== 'function') return 0;
      const size = analyser.fftSize || (analyser.frequencyBinCount ? analyser.frequencyBinCount * 2 : 256);
      let buf = analyserBuffers.get(track);
      if (!buf || buf.length !== size) {
        buf = new Uint8Array(size);
        analyserBuffers.set(track, buf);
      }
      analyser.getByteTimeDomainData(buf);
      let sumSquares = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sumSquares += v * v;
      }
      const rms = Math.sqrt(sumSquares / buf.length);
      return clamp01(rms * 3.2); // headroom so a quiet ambient signal still registers visibly
    } catch {
      return 0;
    }
  }

  function updateLevels() {
    for (const track of TRACKS) levels.set(track, computeLevel(track));
  }

  // -- event handlers ------------------------------------------------------

  function onNote(evt) {
    try {
      if (!evt || typeof evt.track !== 'string') return;
      const list = notesByTrack.get(evt.track);
      if (!list) return; // unknown track id; ignore defensively
      const note = {
        time: typeof evt.time === 'number' ? evt.time : 0,
        duration: typeof evt.duration === 'number' ? Math.max(0, evt.duration) : 0.2,
        velocity: clamp01(typeof evt.velocity === 'number' ? evt.velocity : 0.6),
        midi: typeof evt.midi === 'number' ? evt.midi : null,
        kind: typeof evt.kind === 'string' ? evt.kind : null,
      };
      if (note.midi !== null && midiRange[evt.track]) {
        const r = midiRange[evt.track];
        if (note.midi < r.min) r.min = note.midi;
        if (note.midi > r.max) r.max = note.midi;
      }
      list.push(note);
      if (list.length > MAX_NOTES_PER_TRACK) list.shift();
    } catch {
      // malformed event; drop it rather than let it kill the subscription
    }
  }

  function onBar(evt) {
    try {
      if (!evt) return;
      barTicks.push({ time: typeof evt.time === 'number' ? evt.time : 0, bar: evt.bar });
      if (barTicks.length > MAX_MARKERS) barTicks.shift();
    } catch {
      // ignore malformed event
    }
  }

  function onSection(evt) {
    try {
      if (!evt) return;
      sectionMarks.push({
        time: typeof evt.time === 'number' ? evt.time : 0,
        label: evt.label != null ? String(evt.label) : '',
        bar: evt.bar,
      });
      if (sectionMarks.length > MAX_MARKERS) sectionMarks.shift();
    } catch {
      // ignore malformed event
    }
  }

  function onState(evt) {
    let nowRunning = false;
    try {
      nowRunning = !!(evt && evt.running);
    } catch {
      nowRunning = false;
    }
    running = nowRunning;
    if (running) {
      refreshAnalysers();
      ensureLoop();
    } else {
      stopLoop();
      renderFrame();
    }
  }

  safeOn('note', onNote);
  safeOn('bar', onBar);
  safeOn('section', onSection);
  safeOn('state', onState);

  // -- reduced motion --------------------------------------------------

  let reducedMotion = false;
  let reducedMotionMedia = null;
  try {
    reducedMotionMedia = window.matchMedia('(prefers-reduced-motion: reduce)');
    reducedMotion = !!reducedMotionMedia.matches;
  } catch {
    reducedMotionMedia = null;
    reducedMotion = false;
  }
  function onReducedMotionChange(e) {
    try {
      reducedMotion = !!e.matches;
    } catch {
      // ignore
    }
    renderFrame();
  }
  try {
    if (reducedMotionMedia) {
      if (typeof reducedMotionMedia.addEventListener === 'function') {
        reducedMotionMedia.addEventListener('change', onReducedMotionChange);
      } else if (typeof reducedMotionMedia.addListener === 'function') {
        reducedMotionMedia.addListener(onReducedMotionChange); // older Safari
      }
    }
  } catch {
    // ignore
  }

  // -- theme flips -------------------------------------------------------

  let themeMedia = null;
  function onThemeChange() {
    theme = readTheme(canvas);
    renderFrame();
  }
  try {
    themeMedia = window.matchMedia('(prefers-color-scheme: dark)');
    if (typeof themeMedia.addEventListener === 'function') {
      themeMedia.addEventListener('change', onThemeChange);
    } else if (typeof themeMedia.addListener === 'function') {
      themeMedia.addListener(onThemeChange);
    }
  } catch {
    themeMedia = null;
  }

  // -- sizing --------------------------------------------------------------

  let resizeObserver = null;

  function resize() {
    try {
      const rect = canvas.getBoundingClientRect();
      dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
      cssWidth = Math.max(1, Math.round(rect.width) || canvas.clientWidth || canvas.width || 300);
      cssHeight = Math.max(1, Math.round(rect.height) || canvas.clientHeight || canvas.height || 150);
      canvas.width = Math.round(cssWidth * dpr);
      canvas.height = Math.round(cssHeight * dpr);
      if (typeof ctx2d.setTransform === 'function') ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    } catch {
      cssWidth = canvas.width || 300;
      cssHeight = canvas.height || 150;
      dpr = 1;
    }
    renderFrame();
  }

  try {
    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(() => resize());
      resizeObserver.observe(canvas);
    }
  } catch {
    resizeObserver = null;
  }

  // -- visibility gating -----------------------------------------------

  function isHidden() {
    try {
      return typeof document !== 'undefined' && !!document.hidden;
    } catch {
      return false;
    }
  }

  function onVisibilityChange() {
    if (isHidden()) {
      stopLoop();
    } else {
      ensureLoop();
    }
  }
  try {
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
  } catch {
    // ignore
  }

  // -- render loop -----------------------------------------------------

  function ensureLoop() {
    if (destroyed || rafId !== null || !running || isHidden()) return;
    const reqAF = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null;
    if (!reqAF) {
      renderFrame();
      return;
    }
    let lastReducedFrame = 0;
    const loop = (ts) => {
      if (destroyed || !running || isHidden()) {
        rafId = null;
        return;
      }
      if (reducedMotion) {
        if (ts - lastReducedFrame >= 1000 / REDUCED_MOTION_FPS) {
          lastReducedFrame = ts;
          renderFrame();
        }
      } else {
        renderFrame();
      }
      rafId = reqAF(loop);
    };
    rafId = reqAF(loop);
  }

  function stopLoop() {
    if (rafId !== null) {
      try {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
      } catch {
        // ignore
      }
      rafId = null;
    }
  }

  // -- time <-> pixel mapping -------------------------------------------

  function fracForTime(t, nowCtx) {
    return 1 - (nowCtx + LOOKAHEAD_SECONDS - t) / WINDOW_SECONDS;
  }

  function cull(nowCtx) {
    const cutoff = nowCtx - HISTORY_SECONDS - 2;
    for (const list of notesByTrack.values()) {
      while (list.length && list[0].time + list[0].duration < cutoff) list.shift();
    }
    while (barTicks.length && barTicks[0].time < cutoff) barTicks.shift();
    while (sectionMarks.length && sectionMarks[0].time < cutoff) sectionMarks.shift();
  }

  function pitchY(track, note, innerTop, innerH) {
    if (track === 'percussion') {
      const idx = PERCUSSION_KIND_ORDER[note.kind] ?? 1;
      const frac = 1 - idx / 2; // low → bottom, high → top
      return innerTop + frac * innerH;
    }
    if (note.midi === null) return innerTop + innerH / 2;
    const range = midiRange[track] || { min: note.midi - 12, max: note.midi + 12 };
    const span = Math.max(1, range.max - range.min);
    const frac = clamp01((note.midi - range.min) / span);
    return innerTop + (1 - frac) * innerH; // higher pitch → higher on screen
  }

  // -- drawing -----------------------------------------------------------

  function drawLaneFrame(top, bottom, x0, w) {
    ctx2d.strokeStyle = rgba(theme.border, 1);
    ctx2d.lineWidth = 1;
    ctx2d.beginPath();
    ctx2d.moveTo(x0, bottom + 0.5);
    ctx2d.lineTo(x0 + w, bottom + 0.5);
    ctx2d.stroke();
  }

  function drawLevelMeter(track, top, bottom, labelWidth) {
    const level = levels.get(track) || 0;
    if (level <= 0.01) return;
    const accent = theme.laneAccents[TRACKS.indexOf(track)];
    try {
      const grad = ctx2d.createLinearGradient(0, 0, labelWidth, 0);
      grad.addColorStop(0, rgba(accent, clamp01(level * 0.55)));
      grad.addColorStop(1, rgba(accent, 0));
      ctx2d.fillStyle = grad;
    } catch {
      ctx2d.fillStyle = rgba(accent, clamp01(level * 0.3));
    }
    ctx2d.fillRect(0, top, labelWidth, bottom - top);
  }

  function drawLaneLabel(track, top, bottom) {
    const level = levels.get(track) || 0;
    const alpha = clamp01(0.55 + level * 0.45);
    ctx2d.fillStyle = rgba(theme.text, alpha);
    ctx2d.font = LABEL_FONT;
    ctx2d.textBaseline = 'middle';
    ctx2d.textAlign = 'left';
    ctx2d.fillText(TRACK_LABELS[track] || track, 8, top + (bottom - top) / 2);
  }

  function drawNotes(track, top, bottom, nowCtx, x0, w, accent) {
    const list = notesByTrack.get(track);
    if (!list || !list.length) return;
    const laneH = bottom - top;
    const pad = Math.max(2, laneH * 0.12);
    const innerTop = top + pad;
    const innerH = Math.max(1, bottom - pad - innerTop);

    for (const note of list) {
      const frac = fracForTime(note.time, nowCtx);
      const x = x0 + frac * w;
      const blipW = Math.max(2, (note.duration / WINDOW_SECONDS) * w);
      if (x + blipW < x0 - 2 || x > x0 + w + 2) continue;

      const y = pitchY(track, note, innerTop, innerH);
      const size = clampRange(4 + note.velocity * (innerH * 0.5), 3, innerH);
      const alpha = clamp01(0.35 + note.velocity * 0.65);

      const bx = Math.max(x0, x);
      const bw = Math.min(blipW - (bx - x), x0 + w - bx);
      if (bw <= 0) continue;

      ctx2d.fillStyle = rgba(accent, alpha);
      roundRectPath(ctx2d, bx, y - size / 2, bw, size, Math.min(3, size / 2));
      ctx2d.fill();
    }
  }

  function drawCurrentNotesOnly(track, top, bottom, nowCtx, x0, w, accent) {
    const list = notesByTrack.get(track);
    if (!list || !list.length) return;
    const laneH = bottom - top;
    const pad = Math.max(2, laneH * 0.12);
    const innerTop = top + pad;
    const innerH = Math.max(1, bottom - pad - innerTop);

    let recent = list.filter((n) => n.time <= nowCtx && nowCtx <= n.time + n.duration + 0.05);
    if (!recent.length) recent = list.slice(-3).filter((n) => nowCtx - n.time < 3);
    if (!recent.length) return;

    const cx = x0 + w / 2;
    recent.forEach((note, idx) => {
      const y = pitchY(track, note, innerTop, innerH);
      const offset = (idx - (recent.length - 1) / 2) * 14;
      const px = clampRange(cx + offset, x0 + 6, x0 + w - 6);
      const alpha = clamp01(0.4 + note.velocity * 0.6);
      ctx2d.fillStyle = rgba(accent, alpha);
      ctx2d.beginPath();
      ctx2d.arc(px, y, 5, 0, Math.PI * 2);
      ctx2d.fill();
    });
  }

  function drawTimeMarkers(nowCtx, x0, w, height) {
    let lastX = -Infinity;
    ctx2d.strokeStyle = rgba(theme.border, 0.9);
    ctx2d.lineWidth = 1;
    for (const tick of barTicks) {
      const x = x0 + fracForTime(tick.time, nowCtx) * w;
      if (x < x0 - 4 || x > x0 + w + 4) continue;
      if (x - lastX < MIN_BAR_TICK_SPACING_PX) continue;
      lastX = x;
      ctx2d.beginPath();
      ctx2d.moveTo(x + 0.5, TOP_MARGIN);
      ctx2d.lineTo(x + 0.5, height);
      ctx2d.stroke();
    }

    ctx2d.font = LABEL_FONT;
    ctx2d.textAlign = 'left';
    ctx2d.textBaseline = 'alphabetic';
    for (const mark of sectionMarks) {
      const x = x0 + fracForTime(mark.time, nowCtx) * w;
      if (x < x0 - 40 || x > x0 + w + 40) continue;
      ctx2d.strokeStyle = rgba(theme.link, 0.55);
      ctx2d.lineWidth = 1.5;
      ctx2d.beginPath();
      ctx2d.moveTo(x + 0.5, 0);
      ctx2d.lineTo(x + 0.5, height);
      ctx2d.stroke();
      if (mark.label) {
        ctx2d.fillStyle = rgba(theme.text, 0.85);
        ctx2d.fillText(mark.label, clampRange(x + 4, x0, x0 + w - 20), 12);
      }
    }
  }

  function drawCurrentSectionLabel(nowCtx, x0) {
    if (!sectionMarks.length) return;
    let current = sectionMarks[sectionMarks.length - 1];
    for (let i = sectionMarks.length - 1; i >= 0; i--) {
      if (sectionMarks[i].time <= nowCtx) {
        current = sectionMarks[i];
        break;
      }
    }
    if (!current || !current.label) return;
    ctx2d.fillStyle = rgba(theme.text, 0.85);
    ctx2d.font = LABEL_FONT;
    ctx2d.textAlign = 'left';
    ctx2d.textBaseline = 'alphabetic';
    ctx2d.fillText(`Section ${current.label}`, x0, 12);
  }

  function draw() {
    const width = cssWidth;
    const height = cssHeight;
    if (!width || !height) return;

    updateLevels();

    ctx2d.clearRect(0, 0, width, height);

    const nowCtx = engineNow();
    cull(nowCtx);

    const labelWidth = clampRange(width * 0.22, MIN_LABEL_WIDTH, MAX_LABEL_WIDTH);
    const x0 = labelWidth;
    const w = Math.max(1, width - labelWidth);
    const usableHeight = Math.max(1, height - TOP_MARGIN);
    const laneHeight = usableHeight / TRACKS.length;
    const laneGap = Math.min(4, laneHeight * 0.08);

    if (reducedMotion) {
      drawCurrentSectionLabel(nowCtx, x0);
    } else {
      drawTimeMarkers(nowCtx, x0, w, height);
    }

    TRACKS.forEach((track, i) => {
      const top = TOP_MARGIN + i * laneHeight;
      const bottom = top + laneHeight - laneGap;
      const accent = theme.laneAccents[i];

      drawLaneFrame(top, bottom, x0, w);
      if (reducedMotion) {
        drawCurrentNotesOnly(track, top, bottom, nowCtx, x0, w, accent);
      } else {
        drawNotes(track, top, bottom, nowCtx, x0, w, accent);
      }
      drawLevelMeter(track, top, bottom, labelWidth);
      drawLaneLabel(track, top, bottom);
    });
  }

  function renderFrame() {
    if (destroyed) return;
    try {
      draw();
    } catch {
      // a draw-time error must never kill the rAF loop or escape initVisualiser
    }
  }

  // -- boot ----------------------------------------------------------------

  try {
    running = !!engine?.running;
  } catch {
    running = false;
  }
  refreshAnalysers();
  resize(); // also renders the first frame
  if (running) ensureLoop();

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    stopLoop();
    for (const off of unsubs) {
      try {
        off();
      } catch {
        // ignore
      }
    }
    unsubs.length = 0;
    try {
      if (resizeObserver) resizeObserver.disconnect();
    } catch {
      // ignore
    }
    try {
      if (reducedMotionMedia) {
        if (typeof reducedMotionMedia.removeEventListener === 'function') {
          reducedMotionMedia.removeEventListener('change', onReducedMotionChange);
        } else if (typeof reducedMotionMedia.removeListener === 'function') {
          reducedMotionMedia.removeListener(onReducedMotionChange);
        }
      }
    } catch {
      // ignore
    }
    try {
      if (themeMedia) {
        if (typeof themeMedia.removeEventListener === 'function') {
          themeMedia.removeEventListener('change', onThemeChange);
        } else if (typeof themeMedia.removeListener === 'function') {
          themeMedia.removeListener(onThemeChange);
        }
      }
    } catch {
      // ignore
    }
    try {
      if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
    } catch {
      // ignore
    }
  }

  return { destroy };
}

export default initVisualiser;
