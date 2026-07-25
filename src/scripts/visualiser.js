/**
 * visualiser.js — canvas track visualiser for the ambient engine (v2, v14
 * track-order/lamp/chord addendum, v15 repeat-bracket addendum, v16
 * de-overlap addendum, v17 repeat-mark redraw).
 *
 * export function initVisualiser(canvas, engine) => { destroy(), setFps(fps),
 * getFps() }
 *
 * setFps/getFps (governor integration, see power.js's onTierChange):
 * setFps(fps) clamps to 1..60fps and re-caps the existing timestamp-gated
 * rAF loop (still scheduled every tick, frames just skip draws — same shape
 * as scope.js's createRafLoop); a missing/non-finite fps restores the 30fps
 * default. getFps() reads the current cap back. "Lowest wins": a
 * document.hidden/out-of-view pause always wins outright (the loop doesn't
 * run at all), and while prefers-reduced-motion is active the effective cap
 * is min(setFps() cap, the reduced-motion 2fps floor) rather than either one
 * unconditionally overriding the other.
 *
 * Six horizontal lanes (pad, arp, melody, bass, texture, percussion) show
 * scheduled notes scrolling right-to-left on a time axis (right edge = now +
 * a small lookahead), pitch mapped to vertical position, duration to blip
 * width, velocity to opacity/size. A soft per-track level glow comes from
 * `engine.getAnalysers()`. Section/bar events draw context lines; bar ticks
 * show the chord name (from a feature-detected 'chord' event) once one has
 * fired, with the section letter demoted to a secondary label.
 *
 * Each lane name is also an interactive "lamp": a real positioned <button>
 * overlaid above the canvas (not a canvas-only hit zone, for keyboard/AT
 * access), cycling that track's state auto → on → off via
 * `engine.setParams({ tracks: { [track]: { state } } })`. The overlay is
 * built by wrapping the canvas in a small position:relative host div on
 * init, and unwrapped back to the canvas's original DOM position on
 * destroy(). Lamp fills/labels are read from `engine.getParams()` and
 * refreshed on 'state'/'bar' events plus a light poll — never from inside
 * the rAF render loop.
 *
 * Piano-roll repeat brackets (v15, feature-detected on `engine.setLoopRegion`
 * / `engine.clearLoopRegion`): the top strip of the canvas (where chord
 * names render) gets its own overlay row of invisible-but-focusable per-bar
 * <button>s, using the same host-div technique as the lamps. Clicking a bar
 * sets a pending open-repeat mark; the next click to its right calls
 * `engine.setLoopRegion(startBar, endBar)`; clicking the resulting close
 * mark (or the open mark, mouse or keyboard) clears it via
 * `engine.clearLoopRegion()`; clicking the open mark before a close exists
 * cancels the pending mark; Esc on a ruler button also cancels a pending
 * mark. Active-loop state is read from loop info carried on 'bar' events
 * when present, falling back to the state produced by our own calls when the
 * engine doesn't (yet) echo it. Without both engine methods, no ruler
 * overlay is built and clicks do nothing. Ruler button positions are
 * recomputed on 'bar' events, resize/theme changes, and a light poll — like
 * the lamps, never from inside the rAF render loop; the repeat marks and
 * the dimming of bars outside an active loop are drawn every frame inside
 * draw(), since they move with the scroll. The marks themselves (v17) are
 * canvas-drawn barline+dot shapes, not font glyphs — see the REPEAT_BAR_ and
 * REPEAT_DOT_ constants and drawRepeatMark() below — sized to span the full
 * lane-stack height in the theme's --accent-warm colour, with the pending
 * open mark (no close yet) drawn at reduced alpha.
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

// Fallback values, used when the engine handle passed to initVisualiser()
// doesn't expose getTracks() (older engine) — see trackRegistryFromEngine()
// below for the registry-driven path.
const FALLBACK_TRACKS = ['pad', 'arp', 'melody', 'bass', 'texture', 'percussion'];

const FALLBACK_TRACK_LABELS = {
  pad: 'Pad',
  arp: 'Arp',
  melody: 'Melody',
  bass: 'Bass',
  texture: 'Texture',
  percussion: 'Percussion',
};

const FALLBACK_TRACK_FAMILY = {
  pad: 'melodic',
  arp: 'melodic',
  melody: 'melodic',
  bass: 'melodic',
  texture: 'melodic',
  percussion: 'percussive',
};

// Mix ratios (toward --text) used to derive a distinct fallback accent per
// lane from --link/--text, when the --track-<id> theme tokens are unset.
const LANE_ACCENT_RATIOS = [0.15, 0.32, 0.48, 0.64, 0.8, 0.95];

const HISTORY_SECONDS = 24;     // scrolled time visible left of "now"
const LOOKAHEAD_SECONDS = 0.5;  // small buffer right of "now" so scheduled-ahead notes don't clip
const WINDOW_SECONDS = HISTORY_SECONDS + LOOKAHEAD_SECONDS;
const MAX_NOTES_PER_TRACK = 400;
const MAX_MARKERS = 500;
const REDUCED_MOTION_FPS = 2;
const TARGET_FPS = 30; // setFps() default/reset value
const MIN_FPS = 1;
const MAX_FPS = 60;
// v14 05:4xZ: MAX_DPR=2 rendered soft under browser zoom on retina (effective
// dpr ~2.5-3). Raised to 3 — this canvas is small (device pixel count stays
// modest even at dpr 3), and the 30fps frame-rate cap (not backing-store
// size) carries the v9 thermal/perf budget, so this doesn't reopen that
// issue.
const MAX_DPR = 3;
const TOP_MARGIN = 16;
const MIN_LABEL_WIDTH = 36;
const MAX_LABEL_WIDTH = 74;
const MIN_BAR_TICK_SPACING_PX = 8;

// Fallback pitch ranges used until real notes widen them. Percussion (any
// track whose family is 'percussive') is positioned by `kind` (low/mid/high),
// not by this map. Keyed by id — a registry-supplied track not listed here
// simply gets no seeded range and widens from its first note instead (see
// pitchFrac()'s fallback).
const DEFAULT_MIDI_RANGE = {
  pad: [36, 72],
  arp: [55, 90],
  melody: [55, 85],
  bass: [24, 50],
  texture: [72, 100],
};

const PERCUSSION_KIND_ORDER = { low: 0, mid: 1, high: 2 };

// ---------------------------------------------------------------------------
// Track registry (engine.getTracks(), feature-detected)
// ---------------------------------------------------------------------------

/**
 * Validates and normalises whatever engine.getTracks() returned. Any entry
 * missing a non-empty string `id` invalidates the whole list (never a
 * partial/garbled lane set) — the caller falls back to the hardcoded
 * FALLBACK_* tables instead.
 */
function normaliseTrackRegistry(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const out = [];
  for (const entry of list) {
    if (!entry || typeof entry.id !== 'string' || !entry.id) return null;
    out.push({
      id: entry.id,
      label: typeof entry.label === 'string' && entry.label ? entry.label : entry.id,
      colourToken: typeof entry.colourToken === 'string' && entry.colourToken
        ? entry.colourToken
        : `--track-${entry.id}`,
      family: typeof entry.family === 'string' && entry.family ? entry.family : 'melodic',
    });
  }
  return out;
}

/** engine.getTracks(), feature-detected and validated; null if unavailable/malformed. */
function trackRegistryFromEngine(engine) {
  try {
    if (typeof engine?.getTracks === 'function') {
      return normaliseTrackRegistry(engine.getTracks());
    }
  } catch {
    // fall through to the caller's fallback
  }
  return null;
}

// Piano-roll de-overlap (v16 addendum): when two time-overlapping notes in
// the same (non-percussion) lane land within SLOT_COLLISION_FRAC of each
// other in normalised pitch space, they'd draw on top of one another. Give
// the later-added note the first free "slot" from this list — offsets in
// units of one blip-height `h` (h expressed as a fraction of the lane's
// inner height so the stack scales with lane size at draw time). The
// alternating +0/-0.5h/+0.5h/-1h pattern reads as a tidy vertical ladder
// once sorted (-1h, -0.5h, 0, +0.5h), each step wider than the collision
// threshold below so slotted notes never re-collide with each other.
const SLOT_OFFSET_STEPS = [0, -0.5, 0.5, -1];
const SLOT_OFFSET_UNIT_FRAC = 0.4; // one `h`, as a fraction of a lane's inner height
const SLOT_OFFSET_FRACS = SLOT_OFFSET_STEPS.map((s) => s * SLOT_OFFSET_UNIT_FRAC);
const SLOT_COLLISION_FRAC = 0.15; // pitch-frac distance under which time-overlapping notes are treated as colliding
const TIME_OVERLAP_EPS = 1e-6; // lets same-onset zero-duration notes still count as overlapping

const FONT_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const LABEL_FONT = `11px ${FONT_STACK}`;
// Smaller/secondary label used for the section letter once bar ticks carry
// the primary chord-name label (once a 'chord' event has ever fired).
const SECONDARY_FONT = `9px ${FONT_STACK}`;
// Repeat-mark geometry (v17 addendum): drawn as canvas rects/arcs rather than
// the 𝄆/𝄇 font glyphs used in v15 — glyph rendering was inconsistent across
// platforms. Sized to read clearly as musical repeat barlines at a glance,
// spanning the full lane-stack height. Open mark, left to right: thick bar,
// thin bar, two dots (stacked, at 1/3 and 2/3 of the span). Close mark is the
// mirror image: two dots, thin bar, thick bar.
const REPEAT_BAR_THICK_W = 5;
const REPEAT_BAR_THIN_W = 2;
const REPEAT_BAR_GAP = 3; // gap between the thick and thin bars
const REPEAT_DOT_GAP = 6; // gap from the thin bar to the near edge of the dot column
const REPEAT_DOT_RADIUS = 3.5;
const REPEAT_PENDING_ALPHA = 0.6; // alpha of the open mark while a close is still pending
const REPEAT_MARK_CULL_MARGIN = 30; // off-canvas margin before a mark is skipped, wide enough for its full span
const LOOP_DIM_ALPHA = 0.4; // alpha of the overlay dimming bars outside an active loop

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
  accentWarm: { r: 157, g: 84, b: 7, a: 1 }, // #9d5407, the --accent-warm fallback
};

/**
 * The mix-toward-text ratio for a lane's derived fallback accent. Uses the
 * hand-picked LANE_ACCENT_RATIOS table for the first six lanes (unchanged
 * from before the registry landed); a registry with more lanes than that
 * (user tracks) spreads any extra ones evenly across the same 0.15..0.95
 * span rather than reading past the table's end.
 */
function laneAccentRatio(idx, total) {
  if (idx < LANE_ACCENT_RATIOS.length) return LANE_ACCENT_RATIOS[idx];
  const lo = LANE_ACCENT_RATIOS[0];
  const hi = LANE_ACCENT_RATIOS[LANE_ACCENT_RATIOS.length - 1];
  return total > 1 ? lo + (hi - lo) * (idx / (total - 1)) : (lo + hi) / 2;
}

/**
 * Per-lane accent colour: prefers the theme's --track-<id> custom property
 * (colourToken — the registry's own token when engine.getTracks() supplied
 * one, else the same `--track-<id>` convention as before); falls back to a
 * derived mix of --link/--text when unset/unparseable.
 */
function laneAccentFor(track, idx, total, computed, link, text, colourToken) {
  const fallback = mixColors(link, text, laneAccentRatio(idx, total));
  if (!computed) return fallback;
  try {
    return parseColor(computed.getPropertyValue(colourToken || `--track-${track}`), fallback);
  } catch {
    return fallback;
  }
}

/** Reads --text/--secondary/--border/--link/--accent-warm off the canvas and derives per-lane accents. */
function readTheme(canvas, tracks, colourTokens) {
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
  const accentWarm = read('--accent-warm', FALLBACK_THEME.accentWarm);
  const laneAccents = tracks.map((t, i) => laneAccentFor(t, i, tracks.length, computed, link, text, colourTokens[t]));
  return { text, secondary, border, link, accentWarm, laneAccents };
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

  // -- track registry (engine.getTracks(), feature-detected at init) ------
  //
  // Lane count/order/labels/colours all derive from this list. A registry
  // with more/fewer/different tracks than the historical six (a future user
  // track) just means a different-length TRACKS array here — nothing below
  // this point hardcodes "six".
  const registryTracks = trackRegistryFromEngine(engine);
  const TRACKS = registryTracks ? registryTracks.map((t) => t.id) : FALLBACK_TRACKS;
  const TRACK_LABELS = registryTracks
    ? Object.fromEntries(registryTracks.map((t) => [t.id, t.label]))
    : FALLBACK_TRACK_LABELS;
  const TRACK_COLOUR_TOKENS = registryTracks
    ? Object.fromEntries(registryTracks.map((t) => [t.id, t.colourToken]))
    : Object.fromEntries(FALLBACK_TRACKS.map((id) => [id, `--track-${id}`]));
  const TRACK_FAMILY = registryTracks
    ? Object.fromEntries(registryTracks.map((t) => [t.id, t.family]))
    : FALLBACK_TRACK_FAMILY;

  /** family === 'percussive' for this track, with the literal id kept as a fallback if family data is missing. */
  function isPercussiveTrack(track) {
    return TRACK_FAMILY[track] === 'percussive' || track === 'percussion';
  }

  let destroyed = false;
  let theme = readTheme(canvas, TRACKS, TRACK_COLOUR_TOKENS);

  // -- per-track state --------------------------------------------------
  const notesByTrack = new Map(TRACKS.map((t) => [t, []]));
  const barTicks = [];    // { time, bar }
  const sectionMarks = []; // { time, label, bar }
  const chordMarks = [];  // { time, bar, name } — from the feature-detected 'chord' event
  let hasChordEvents = false; // once true, chord names take over as the primary bar-tick label

  // -- repeat-bracket state (v15) -----------------------------------------
  let pendingOpenBar = null;  // bar clicked to open, awaiting a close click
  let activeLoop = null;      // { start, end } | null — synced from bar events'
                               // loop info when present, else tracked from our
                               // own setLoopRegion/clearLoopRegion calls
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
  let currentFps = TARGET_FPS; // setFps()'s current cap; read fresh each rAF tick, no loop restart needed

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

  function loopFeatureAvailable() {
    try {
      return typeof engine?.setLoopRegion === 'function' && typeof engine?.clearLoopRegion === 'function';
    } catch {
      return false;
    }
  }

  /**
   * Normalises the optional loop info a 'bar' event may carry (parallel
   * engine pass, feature-detected). Returns null when the event carries no
   * loop info at all (older engine — caller should keep tracking locally),
   * `{ active: false }` when the engine explicitly reports no active loop
   * (evt.loop === null), or `{ active: true, start, end }` when it reports
   * one. Accepts either startBar/endBar or start/end field names.
   */
  function loopInfoFromBarEvent(evt) {
    try {
      if (!evt || !('loop' in evt)) return null;
      const loop = evt.loop;
      if (loop === null || loop === undefined) return { active: false };
      if (typeof loop === 'object') {
        const start = typeof loop.startBar === 'number' ? loop.startBar : (typeof loop.start === 'number' ? loop.start : null);
        const end = typeof loop.endBar === 'number' ? loop.endBar : (typeof loop.end === 'number' ? loop.end : null);
        if (start !== null && end !== null) return { active: true, start, end };
        return { active: false };
      }
    } catch {
      // fall through
    }
    return null;
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

  /** Normalised (0..1) pitch position within a lane's known midi range; percussion isn't mapped this way. */
  function pitchFrac(track, midi) {
    if (midi === null) return 0.5;
    const range = midiRange[track] || { min: midi - 12, max: midi + 12 };
    const span = Math.max(1, range.max - range.min);
    return clamp01((midi - range.min) / span);
  }

  /** A note's vertical position in normalised (top=0) frac-space, including its already-assigned slot offset. */
  function notePosFrac(track, note) {
    return (1 - pitchFrac(track, note.midi)) + SLOT_OFFSET_FRACS[note.slot || 0];
  }

  /**
   * Assigns `note.slot` (an index into SLOT_OFFSET_FRACS) once, at add time —
   * not per frame, and not from draw order. Scans the lane's still-live
   * notes for ones that time-overlap the new note, then walks candidate
   * slots in order [0, 1, 2, 3] (offsets +0, -0.5h, +0.5h, -1h) picking the
   * first whose resulting position doesn't collide (within
   * SLOT_COLLISION_FRAC) with any time-overlapping note's ACTUAL position
   * (base pitch + that note's own already-assigned offset) — not just its
   * base pitch — so a three-note chord where only adjacent pairs are close
   * still ends up as a fully separated stack. Earlier notes' slots are never
   * revisited, so the scroll never jitters. Percussion lanes have fixed
   * low/mid/high heights and are left at slot 0 (no offset).
   */
  function assignSlot(track, note, list) {
    note.slot = 0;
    if (isPercussiveTrack(track) || !list || !list.length) return;
    const overlapping = list.filter(
      (other) =>
        other.time < note.time + note.duration + TIME_OVERLAP_EPS &&
        note.time < other.time + other.duration + TIME_OVERLAP_EPS,
    );
    if (!overlapping.length) return;
    const basePos = 1 - pitchFrac(track, note.midi);
    for (let s = 0; s < SLOT_OFFSET_FRACS.length; s++) {
      const candidatePos = basePos + SLOT_OFFSET_FRACS[s];
      const collides = overlapping.some((other) => Math.abs(candidatePos - notePosFrac(track, other)) < SLOT_COLLISION_FRAC);
      if (!collides) {
        note.slot = s;
        return;
      }
    }
    // Degrade gracefully for >4-note clusters: hash by pitch identity rather
    // than draw order, still deterministic per note.
    note.slot = (note.midi !== null ? Math.abs(note.midi) : 0) % SLOT_OFFSET_FRACS.length;
  }

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
        slot: 0,
      };
      if (note.midi !== null && midiRange[evt.track]) {
        const r = midiRange[evt.track];
        if (note.midi < r.min) r.min = note.midi;
        if (note.midi > r.max) r.max = note.midi;
      }
      assignSlot(evt.track, note, list);
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
      if (loopFeatureAvailable()) {
        const info = loopInfoFromBarEvent(evt);
        if (info) activeLoop = info.active ? { start: info.start, end: info.end } : null;
      }
    } catch {
      // ignore malformed event
    }
    refreshLampStates(); // event-driven lamp refresh, outside the rAF loop
    updateRulerOverlay(); // event-driven ruler-button refresh, outside the rAF loop
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

  function onChord(evt) {
    try {
      if (!evt) return;
      hasChordEvents = true;
      chordMarks.push({
        time: typeof evt.time === 'number' ? evt.time : 0,
        bar: evt.bar,
        name: evt.name != null ? String(evt.name) : '',
      });
      if (chordMarks.length > MAX_MARKERS) chordMarks.shift();
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
    refreshLampStates();
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
  safeOn('chord', onChord);
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
    theme = readTheme(canvas, TRACKS, TRACK_COLOUR_TOKENS);
    positionLamps(); // lamp label colour follows the per-track theme tokens too
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
  let resizing = false;

  function currentDpr() {
    try {
      const raw = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
      return Math.min(MAX_DPR, raw);
    } catch {
      return 1;
    }
  }

  function resize() {
    resizing = true;
    try {
      const rect = canvas.getBoundingClientRect();
      dpr = currentDpr();
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
    positionLamps();
    renderFrame();
    resizing = false;
  }

  try {
    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(() => resize());
      // device-pixel-content-box also fires when devicePixelRatio changes
      // (zoom, moving to a different-DPI screen) without a CSS-box resize.
      try {
        resizeObserver.observe(canvas, { box: 'device-pixel-content-box' });
      } catch {
        resizeObserver.observe(canvas);
      }
    }
  } catch {
    resizeObserver = null;
  }

  // -- device-pixel snapping (crisp hairlines/text at any dpr) -------------
  //
  // Coordinates here are in CSS px but the canvas transform scales by `dpr`,
  // so a coordinate that isn't a whole number of device pixels renders as a
  // blurred antialiased edge. snapPixel rounds a CSS coordinate onto the
  // device-pixel grid; snapHairline additionally offsets by half a device
  // pixel so a 1-CSS-px-wide stroke centres on a single device pixel row
  // instead of straddling two (the classic canvas hairline trick, made
  // dpr-aware instead of assuming dpr===1).

  function snapPixel(v) {
    return Math.round(v * dpr) / dpr;
  }

  function snapHairline(v) {
    return snapPixel(v) + 0.5 / dpr;
  }

  // -- geometry shared between the canvas draw and the lamp overlay --------

  function computeGeometry() {
    const width = cssWidth;
    const labelWidth = clampRange(width * 0.22, MIN_LABEL_WIDTH, MAX_LABEL_WIDTH);
    return { labelWidth, x0: labelWidth, w: Math.max(1, width - labelWidth) };
  }

  // -- lamp overlay: per-lane state buttons ---------------------------------
  //
  // Each lane name is a real <button> (not a canvas hit zone) so it's
  // keyboard/AT operable, overlaid above the canvas by wrapping the canvas
  // in a small position:relative host div. All DOM work here happens
  // outside the rAF render loop (init, resize, theme flips, and the
  // 'state'/'bar' events + a light poll below) — never from inside draw().

  let lampHost = null;
  let lampParent = null;
  let lampNextSibling = null;
  const lampButtons = new Map(); // track -> { btn, bulb, text }
  const lampState = new Map(TRACKS.map((t) => [t, 'auto']));
  let lampPollId = null;

  const LAMP_FILL = { auto: '#8a8a8a', on: '#ffffff', off: '#000000' };
  const LAMP_ARIA_PRESSED = { auto: 'mixed', on: 'true', off: 'false' };
  const LAMP_CYCLE = { auto: 'on', on: 'off', off: 'auto' };

  function setupLampHost() {
    try {
      if (typeof document === 'undefined' || typeof document.createElement !== 'function') return;
      if (!canvas.parentNode || typeof canvas.parentNode.insertBefore !== 'function') return;
      const host = document.createElement('div');
      host.style.position = 'relative';
      lampParent = canvas.parentNode;
      lampNextSibling = canvas.nextSibling;
      lampParent.insertBefore(host, canvas);
      host.appendChild(canvas);
      lampHost = host;
    } catch {
      lampHost = null;
      lampParent = null;
      lampNextSibling = null;
    }
  }

  function createLampButtons() {
    if (!lampHost) return;
    try {
      for (const track of TRACKS) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.dataset.track = track;
        btn.style.position = 'absolute';
        btn.style.left = '0px';
        btn.style.display = 'flex';
        btn.style.alignItems = 'center';
        btn.style.gap = '4px';
        btn.style.padding = '0 6px';
        btn.style.margin = '0';
        btn.style.border = 'none';
        btn.style.background = 'transparent';
        btn.style.cursor = 'pointer';
        btn.style.font = LABEL_FONT;
        btn.style.textAlign = 'left';

        const bulb = document.createElement('span');
        bulb.setAttribute('aria-hidden', 'true');
        bulb.style.display = 'inline-block';
        bulb.style.width = '9px';
        bulb.style.height = '9px';
        bulb.style.borderRadius = '50%';
        bulb.style.border = '1px solid currentColor';
        bulb.style.flex = '0 0 auto';

        const text = document.createElement('span');
        text.textContent = TRACK_LABELS[track] || track;
        text.style.whiteSpace = 'nowrap';
        text.style.overflow = 'hidden';
        text.style.textOverflow = 'ellipsis';

        btn.appendChild(bulb);
        btn.appendChild(text);
        btn.addEventListener('click', () => onLampClick(track));

        lampHost.appendChild(btn);
        lampButtons.set(track, { btn, bulb, text });
      }
    } catch {
      // partial DOM support; whatever lamps got created still work, the
      // rest just fall back to having no interactive overlay
    }
  }

  function teardownLampHost() {
    try {
      if (lampPollId !== null && typeof clearInterval === 'function') clearInterval(lampPollId);
    } catch {
      // ignore
    }
    lampPollId = null;
    try {
      if (rulerPollId !== null && typeof clearInterval === 'function') clearInterval(rulerPollId);
    } catch {
      // ignore
    }
    rulerPollId = null;
    try {
      if (lampHost && lampParent) {
        lampParent.insertBefore(canvas, lampNextSibling || null);
        if (typeof lampHost.remove === 'function') lampHost.remove();
      }
    } catch {
      // ignore — best-effort DOM cleanup
    } finally {
      lampHost = null;
      lampParent = null;
      lampNextSibling = null;
      lampButtons.clear();
      rulerButtons.clear();
    }
  }

  function positionLamps() {
    if (!lampHost) return;
    try {
      const { labelWidth } = computeGeometry();
      const usableHeight = Math.max(1, cssHeight - TOP_MARGIN);
      const laneHeight = usableHeight / TRACKS.length;
      const laneGap = Math.min(4, laneHeight * 0.08);
      TRACKS.forEach((track, i) => {
        const entry = lampButtons.get(track);
        if (!entry) return;
        const top = TOP_MARGIN + i * laneHeight;
        const bottom = top + laneHeight - laneGap;
        entry.btn.style.top = `${top}px`;
        entry.btn.style.width = `${labelWidth}px`;
        entry.btn.style.height = `${Math.max(0, bottom - top)}px`;
        entry.btn.style.color = rgba(theme.laneAccents[i], 1);
      });
    } catch {
      // best-effort; the canvas-drawn lane still functions without it
    }
    updateRulerOverlay();
  }

  function applyLampState(track, state) {
    const entry = lampButtons.get(track);
    if (!entry) return;
    const safe = state === 'on' || state === 'off' ? state : 'auto';
    entry.bulb.style.background = LAMP_FILL[safe];
    entry.btn.setAttribute('aria-pressed', LAMP_ARIA_PRESSED[safe]);
    entry.btn.setAttribute('aria-label', `${TRACK_LABELS[track] || track} track: ${safe}`);
  }

  function readTrackState(track) {
    try {
      if (typeof engine?.getParams === 'function') {
        const params = engine.getParams();
        const s = params && params.tracks && params.tracks[track] && params.tracks[track].state;
        if (s === 'auto' || s === 'on' || s === 'off') return s;
      }
    } catch {
      // fall through to the last locally-known state
    }
    return lampState.get(track) || 'auto';
  }

  function refreshLampStates() {
    if (!lampHost) return;
    for (const track of TRACKS) {
      const state = readTrackState(track);
      lampState.set(track, state);
      applyLampState(track, state);
    }
  }

  function onLampClick(track) {
    const current = readTrackState(track);
    const next = LAMP_CYCLE[current] || 'auto';
    lampState.set(track, next);
    applyLampState(track, next);
    try {
      if (typeof engine?.setParams === 'function') {
        engine.setParams({ tracks: { [track]: { state: next } } });
      }
    } catch {
      // engine rejected the update; the lamp still reflects the click locally
    }
  }

  // -- repeat-bracket ruler overlay: per-bar hit targets (v15) -------------
  //
  // A second row of real <button>s, invisible (no rendered content, so
  // there's nothing to draw over the canvas's own bracket glyphs) but
  // keyboard-reachable, overlaid on the top strip (0..TOP_MARGIN, same band
  // where chord names render) using the same lampHost technique as the lane
  // lamps. Unlike the lamps (one fixed button per track), bar positions
  // scroll, so the set of buttons and their x positions are rebuilt from the
  // currently-visible `barTicks` on 'bar' events, resize/theme changes, and
  // a light poll — all outside the rAF render loop.

  const rulerButtons = new Map(); // bar -> { btn }
  let rulerPollId = null;

  function callSetLoopRegion(startBar, endBar) {
    pendingOpenBar = null;
    activeLoop = { start: startBar, end: endBar };
    try {
      if (typeof engine?.setLoopRegion === 'function') engine.setLoopRegion(startBar, endBar);
    } catch {
      // engine rejected it; the overlay still reflects the click locally
    }
    updateRulerOverlay();
    renderFrame();
  }

  function callClearLoopRegion() {
    activeLoop = null;
    try {
      if (typeof engine?.clearLoopRegion === 'function') engine.clearLoopRegion();
    } catch {
      // engine rejected it; the overlay still reflects the click locally
    }
    updateRulerOverlay();
    renderFrame();
  }

  function cancelPendingOpen() {
    if (pendingOpenBar === null) return;
    pendingOpenBar = null;
    updateRulerOverlay();
    renderFrame();
  }

  function onRulerBarClick(bar) {
    if (!loopFeatureAvailable()) return;
    if (activeLoop) {
      if (bar === activeLoop.start || bar === activeLoop.end) {
        callClearLoopRegion();
      } else {
        // Redefining bounds while a loop is active: start a fresh pending
        // mark (the prior loop keeps looping in the engine until a new
        // setLoopRegion call replaces it — no implicit clear here).
        activeLoop = null;
        pendingOpenBar = bar;
        updateRulerOverlay();
        renderFrame();
      }
      return;
    }
    if (pendingOpenBar !== null) {
      if (bar === pendingOpenBar) {
        cancelPendingOpen();
      } else if (bar > pendingOpenBar) {
        callSetLoopRegion(pendingOpenBar, bar);
      } else {
        pendingOpenBar = bar; // clicked left of the pending mark: move it here
        updateRulerOverlay();
        renderFrame();
      }
      return;
    }
    pendingOpenBar = bar;
    updateRulerOverlay();
    renderFrame();
  }

  function onRulerKeydown(e) {
    try {
      if (e && e.key === 'Escape') cancelPendingOpen();
    } catch {
      // ignore
    }
  }

  function rulerButtonLabel(bar) {
    if (activeLoop && (bar === activeLoop.start || bar === activeLoop.end)) {
      return 'Clear repeat';
    }
    if (pendingOpenBar !== null && bar === pendingOpenBar) {
      return `Cancel repeat start at bar ${bar}`;
    }
    if (pendingOpenBar !== null && bar > pendingOpenBar) {
      return `Set repeat end at bar ${bar}`;
    }
    return `Set repeat start at bar ${bar}`;
  }

  function ensureRulerButton(bar) {
    let entry = rulerButtons.get(bar);
    if (entry) return entry;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.bar = String(bar);
    btn.style.position = 'absolute';
    btn.style.top = '0px';
    btn.style.margin = '0';
    btn.style.padding = '0';
    btn.style.border = 'none';
    btn.style.background = 'transparent';
    btn.style.cursor = 'pointer';
    btn.addEventListener('click', () => onRulerBarClick(bar));
    btn.addEventListener('keydown', onRulerKeydown);
    lampHost.appendChild(btn);
    entry = { btn };
    rulerButtons.set(bar, entry);
    return entry;
  }

  function updateRulerOverlay() {
    if (!lampHost) return;
    if (!loopFeatureAvailable()) {
      if (rulerButtons.size) {
        for (const entry of rulerButtons.values()) {
          try { entry.btn.remove(); } catch { /* ignore */ }
        }
        rulerButtons.clear();
      }
      return;
    }
    try {
      const nowCtx = engineNow();
      const { x0, w } = computeGeometry();
      const visible = [];
      let lastX = -Infinity;
      for (const tick of barTicks) {
        const x = x0 + fracForTime(tick.time, nowCtx) * w;
        if (x < x0 - 4 || x > x0 + w + 4) continue;
        if (x - lastX < MIN_BAR_TICK_SPACING_PX) continue;
        lastX = x;
        visible.push({ bar: tick.bar, x });
      }

      const visibleBars = new Set(visible.map((v) => v.bar));
      for (const [bar, entry] of rulerButtons) {
        if (!visibleBars.has(bar)) {
          try { entry.btn.remove(); } catch { /* ignore */ }
          rulerButtons.delete(bar);
        }
      }

      visible.forEach(({ bar, x }, i) => {
        const entry = ensureRulerButton(bar);
        const nextX = i + 1 < visible.length ? visible[i + 1].x : x0 + w;
        const width = Math.max(MIN_BAR_TICK_SPACING_PX, nextX - x);
        entry.btn.style.left = `${clampRange(x - width / 2, 0, cssWidth)}px`;
        entry.btn.style.width = `${width}px`;
        entry.btn.style.height = `${TOP_MARGIN}px`;
        entry.btn.setAttribute('aria-label', rulerButtonLabel(bar));
      });
    } catch {
      // best-effort; the canvas-drawn brackets still function without it
    }
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

  // -- viewport gating (IntersectionObserver) -----------------------------

  let inView = true; // no IO support → this axis never pauses the loop
  let intersectionObserver = null;

  function onIntersect(entries) {
    try {
      const entry = entries && entries[entries.length - 1];
      inView = entry ? !!entry.isIntersecting : true;
    } catch {
      inView = true;
    }
    if (inView) ensureLoop();
    else stopLoop();
  }

  try {
    if (typeof IntersectionObserver === 'function') {
      intersectionObserver = new IntersectionObserver(onIntersect, { threshold: 0 });
      intersectionObserver.observe(canvas);
    }
  } catch {
    intersectionObserver = null;
  }

  // -- render loop -----------------------------------------------------

  function ensureLoop() {
    if (destroyed || rafId !== null || !running || isHidden() || !inView) return;
    const reqAF = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null;
    if (!reqAF) {
      renderFrame();
      return;
    }
    let lastFrameTs = -Infinity;
    const loop = (ts) => {
      if (destroyed || !running || isHidden() || !inView) {
        rafId = null;
        return;
      }
      // "Lowest wins": reduced-motion caps at REDUCED_MOTION_FPS, but an
      // explicit setFps() cap below that (e.g. 1fps) must not be raised back
      // up to REDUCED_MOTION_FPS just because reduced-motion is also active.
      const effectiveFps = reducedMotion ? Math.min(currentFps, REDUCED_MOTION_FPS) : currentFps;
      if (ts - lastFrameTs >= 1000 / effectiveFps) {
        // Timestamp-gated: still scheduled every rAF tick (skip frames, not
        // timers), so we never fall out of sync with the browser's compositor.
        lastFrameTs = ts;
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

  /**
   * Governor integration point (power.js's onTierChange calls
   * visualiser.setFps?.(budget.visualFps)). Clamps to 1..60; a missing or
   * non-finite value restores the TARGET_FPS default. Only mutates the cap
   * the already-running rAF loop reads each tick — never restarts the loop
   * or schedules an extra frame, so a mid-run change can't stutter or
   * double-draw.
   */
  function setFps(fps) {
    currentFps = typeof fps === 'number' && Number.isFinite(fps) ? clampRange(fps, MIN_FPS, MAX_FPS) : TARGET_FPS;
  }

  function getFps() {
    return currentFps;
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
    while (chordMarks.length && chordMarks[0].time < cutoff) chordMarks.shift();
  }

  /** Chord name for a specific bar tick: exact bar match first, else the latest chord at/before its time. */
  function chordNameForBarTick(tick) {
    for (let i = chordMarks.length - 1; i >= 0; i--) {
      if (chordMarks[i].bar === tick.bar) return chordMarks[i].name;
    }
    for (let i = chordMarks.length - 1; i >= 0; i--) {
      if (chordMarks[i].time <= tick.time) return chordMarks[i].name;
    }
    return null;
  }

  /** Chord name currently sounding at a point in time (reduced-motion static label). */
  function chordNameAtTime(t) {
    for (let i = chordMarks.length - 1; i >= 0; i--) {
      if (chordMarks[i].time <= t) return chordMarks[i].name;
    }
    return null;
  }

  function pitchY(track, note, innerTop, innerH) {
    if (isPercussiveTrack(track)) {
      const idx = PERCUSSION_KIND_ORDER[note.kind] ?? 1;
      const frac = 1 - idx / 2; // low → bottom, high → top
      return innerTop + frac * innerH;
    }
    const frac = pitchFrac(track, note.midi);
    let y = innerTop + (1 - frac) * innerH; // higher pitch → higher on screen
    const slot = note.slot || 0;
    if (slot) y += SLOT_OFFSET_FRACS[slot] * innerH; // de-overlap offset (v16), assigned once at add time
    return clampRange(y, innerTop, innerTop + innerH);
  }

  // -- drawing -----------------------------------------------------------

  function drawLaneFrame(top, bottom, x0, w) {
    ctx2d.strokeStyle = rgba(theme.border, 1);
    ctx2d.lineWidth = 1;
    const y = snapHairline(bottom);
    ctx2d.beginPath();
    ctx2d.moveTo(x0, y);
    ctx2d.lineTo(x0 + w, y);
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
    if (lampHost) return; // the DOM lamp button already renders the (interactive) label
    const level = levels.get(track) || 0;
    const alpha = clamp01(0.55 + level * 0.45);
    ctx2d.fillStyle = rgba(theme.text, alpha);
    ctx2d.font = LABEL_FONT;
    ctx2d.textBaseline = 'middle';
    ctx2d.textAlign = 'left';
    ctx2d.fillText(TRACK_LABELS[track] || track, snapPixel(8), snapPixel(top + (bottom - top) / 2));
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
    ctx2d.font = LABEL_FONT;
    ctx2d.textAlign = 'left';
    ctx2d.textBaseline = 'alphabetic';
    for (const tick of barTicks) {
      const x = x0 + fracForTime(tick.time, nowCtx) * w;
      if (x < x0 - 4 || x > x0 + w + 4) continue;
      if (x - lastX < MIN_BAR_TICK_SPACING_PX) continue;
      lastX = x;
      const xSnap = snapHairline(x);
      ctx2d.strokeStyle = rgba(theme.border, 0.9);
      ctx2d.lineWidth = 1;
      ctx2d.beginPath();
      ctx2d.moveTo(xSnap, TOP_MARGIN);
      ctx2d.lineTo(xSnap, height);
      ctx2d.stroke();

      // Once a 'chord' event has ever fired, the chord name becomes the
      // primary per-bar label (replacing the section letter here).
      if (hasChordEvents) {
        const chordName = chordNameForBarTick(tick);
        if (chordName) {
          ctx2d.font = LABEL_FONT;
          ctx2d.fillStyle = rgba(theme.text, 0.9);
          ctx2d.fillText(chordName, snapPixel(clampRange(x + 3, x0, x0 + w - 4)), snapPixel(12));
        }
      }
    }

    ctx2d.textAlign = 'left';
    ctx2d.textBaseline = 'alphabetic';
    for (const mark of sectionMarks) {
      const x = x0 + fracForTime(mark.time, nowCtx) * w;
      if (x < x0 - 40 || x > x0 + w + 40) continue;
      const xSnap = snapHairline(x);
      ctx2d.strokeStyle = rgba(theme.link, 0.55);
      ctx2d.lineWidth = 1.5;
      ctx2d.beginPath();
      ctx2d.moveTo(xSnap, 0);
      ctx2d.lineTo(xSnap, height);
      ctx2d.stroke();
      if (mark.label) {
        if (hasChordEvents) {
          // Chord names now carry the primary billing; the section letter
          // demotes to a smaller, secondary label near the bottom.
          ctx2d.font = SECONDARY_FONT;
          ctx2d.fillStyle = rgba(theme.secondary, 0.75);
          ctx2d.fillText(mark.label, snapPixel(clampRange(x + 4, x0, x0 + w - 20)), snapPixel(height - 4));
        } else {
          ctx2d.font = LABEL_FONT;
          ctx2d.fillStyle = rgba(theme.text, 0.85);
          ctx2d.fillText(mark.label, snapPixel(clampRange(x + 4, x0, x0 + w - 20)), snapPixel(12));
        }
      }
    }
  }

  function drawCurrentSectionLabel(nowCtx, x0) {
    const chordName = hasChordEvents ? chordNameAtTime(nowCtx) : null;
    if (chordName) {
      ctx2d.fillStyle = rgba(theme.text, 0.9);
      ctx2d.font = LABEL_FONT;
      ctx2d.textAlign = 'left';
      ctx2d.textBaseline = 'alphabetic';
      ctx2d.fillText(chordName, snapPixel(x0), snapPixel(12));
    }

    if (!sectionMarks.length) return;
    let current = sectionMarks[sectionMarks.length - 1];
    for (let i = sectionMarks.length - 1; i >= 0; i--) {
      if (sectionMarks[i].time <= nowCtx) {
        current = sectionMarks[i];
        break;
      }
    }
    if (!current || !current.label) return;
    if (chordName) {
      ctx2d.fillStyle = rgba(theme.secondary, 0.75);
      ctx2d.font = SECONDARY_FONT;
      ctx2d.textAlign = 'left';
      ctx2d.textBaseline = 'alphabetic';
      ctx2d.fillText(`Section ${current.label}`, snapPixel(x0), snapPixel(24));
      return;
    }
    ctx2d.fillStyle = rgba(theme.text, 0.85);
    ctx2d.font = LABEL_FONT;
    ctx2d.textAlign = 'left';
    ctx2d.textBaseline = 'alphabetic';
    ctx2d.fillText(`Section ${current.label}`, snapPixel(x0), snapPixel(12));
  }

  /** Time of the most recent recorded tick for a given bar number, or null if it's scrolled out of `barTicks`. */
  function findBarTickTime(bar) {
    for (let i = barTicks.length - 1; i >= 0; i--) {
      if (barTicks[i].bar === bar) return barTicks[i].time;
    }
    return null;
  }

  /** Dims the lane area outside an active loop's bar range with a flat low-alpha overlay. */
  function drawLoopDimming(nowCtx, x0, w, height) {
    if (!activeLoop) return;
    const startTime = findBarTickTime(activeLoop.start);
    const endTime = findBarTickTime(activeLoop.end);
    const xStart = startTime !== null ? x0 + fracForTime(startTime, nowCtx) * w : x0;
    const xEnd = endTime !== null ? x0 + fracForTime(endTime, nowCtx) * w : x0 + w;
    ctx2d.fillStyle = rgba(theme.border, LOOP_DIM_ALPHA);
    const leftW = clampRange(xStart - x0, 0, w);
    if (leftW > 0) ctx2d.fillRect(x0, TOP_MARGIN, leftW, height - TOP_MARGIN);
    const rightX = clampRange(xEnd, x0, x0 + w);
    const rightW = clampRange(x0 + w - rightX, 0, w);
    if (rightW > 0) ctx2d.fillRect(rightX, TOP_MARGIN, rightW, height - TOP_MARGIN);
  }

  /**
   * Draws one repeat mark — a thick+thin barline pair plus two stacked dots —
   * spanning the full lane-stack height (`top`..`bottom`). `mirrored` false
   * draws the open mark (thick bar at `x`, thin bar and dots extending
   * rightward, so dot x > bar x); `mirrored` true draws the close mark, the
   * mirror image (thick bar's trailing edge at `x`, thin bar and dots
   * extending leftward, so dot x < bar x).
   */
  function drawRepeatMark(x, mirrored, alpha, top, bottom) {
    const span = bottom - top;
    const thickX = mirrored ? x - REPEAT_BAR_THICK_W : x;
    ctx2d.fillStyle = rgba(theme.accentWarm, alpha);
    ctx2d.fillRect(snapPixel(thickX), snapPixel(top), REPEAT_BAR_THICK_W, span);
    const thinX = mirrored
      ? thickX - REPEAT_BAR_GAP - REPEAT_BAR_THIN_W
      : thickX + REPEAT_BAR_THICK_W + REPEAT_BAR_GAP;
    ctx2d.fillRect(snapPixel(thinX), snapPixel(top), REPEAT_BAR_THIN_W, span);
    const dotX = mirrored
      ? thinX - REPEAT_DOT_GAP - REPEAT_DOT_RADIUS
      : thinX + REPEAT_BAR_THIN_W + REPEAT_DOT_GAP + REPEAT_DOT_RADIUS;
    [1 / 3, 2 / 3].forEach((frac) => {
      ctx2d.beginPath();
      ctx2d.arc(snapPixel(dotX), snapPixel(top + span * frac), REPEAT_DOT_RADIUS, 0, Math.PI * 2);
      ctx2d.fill();
    });
  }

  function drawLoopBracket(mirrored, time, nowCtx, x0, w, top, bottom, alpha) {
    if (time === null) return;
    const x = x0 + fracForTime(time, nowCtx) * w;
    if (x < x0 - REPEAT_MARK_CULL_MARGIN || x > x0 + w + REPEAT_MARK_CULL_MARGIN) return;
    drawRepeatMark(x, mirrored, alpha, top, bottom);
  }

  /** Repeat marks (barline+dots) + outside-loop dimming (v15/v17); gated on engine support for the whole feature. */
  function drawLoopMarkers(nowCtx, x0, w, height) {
    if (!loopFeatureAvailable()) return;
    const top = TOP_MARGIN;
    if (activeLoop) {
      drawLoopDimming(nowCtx, x0, w, height);
      drawLoopBracket(false, findBarTickTime(activeLoop.start), nowCtx, x0, w, top, height, 1);
      drawLoopBracket(true, findBarTickTime(activeLoop.end), nowCtx, x0, w, top, height, 1);
    } else if (pendingOpenBar !== null) {
      drawLoopBracket(false, findBarTickTime(pendingOpenBar), nowCtx, x0, w, top, height, REPEAT_PENDING_ALPHA);
    }
  }

  function draw() {
    const width = cssWidth;
    const height = cssHeight;
    if (!width || !height) return;

    updateLevels();

    ctx2d.clearRect(0, 0, width, height);

    const nowCtx = engineNow();
    cull(nowCtx);

    const { labelWidth, x0, w } = computeGeometry();
    const usableHeight = Math.max(1, height - TOP_MARGIN);
    const laneHeight = usableHeight / TRACKS.length;
    const laneGap = Math.min(4, laneHeight * 0.08);

    if (reducedMotion) {
      drawCurrentSectionLabel(nowCtx, x0);
    } else {
      drawTimeMarkers(nowCtx, x0, w, height);
    }
    drawLoopMarkers(nowCtx, x0, w, height);

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
    // Belt-and-braces DPR staleness check: browsers that lack
    // device-pixel-content-box won't fire the ResizeObserver on zoom/screen
    // moves, so compare once per rendered frame. `resizing` guards against
    // recursion (resize() calls back into renderFrame()).
    if (!resizing && currentDpr() !== dpr) {
      resize(); // renders at the fresh ratio
      return;
    }
    try {
      draw();
    } catch {
      // a draw-time error must never kill the rAF loop or escape initVisualiser
    }
  }

  // -- boot ----------------------------------------------------------------

  setupLampHost();
  createLampButtons();
  try {
    if (lampHost && typeof setInterval === 'function') {
      lampPollId = setInterval(refreshLampStates, 1000); // light poll fallback, outside the rAF loop
    }
  } catch {
    lampPollId = null;
  }
  try {
    // Bars scroll continuously, so the ruler overlay needs a tighter poll
    // than the lamps' to track the visible bar range between 'bar' events.
    if (lampHost && typeof setInterval === 'function') {
      rulerPollId = setInterval(updateRulerOverlay, 250);
    }
  } catch {
    rulerPollId = null;
  }

  try {
    running = !!engine?.running;
  } catch {
    running = false;
  }
  refreshAnalysers();
  resize(); // also renders the first frame and positions the lamp overlay
  refreshLampStates();
  updateRulerOverlay();
  if (running) ensureLoop();

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    stopLoop();
    teardownLampHost();
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
      if (intersectionObserver) intersectionObserver.disconnect();
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

  return { destroy, setFps, getFps };
}

export default initVisualiser;
