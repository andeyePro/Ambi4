/**
 * scope.js — phosphor-style oscilloscope views for the voice editor (v5).
 *
 * export function renderPatchWave(canvas, patch, { freq = 220 })
 *   Static trace: renders ~2 cycles of the patch's oscillator mix
 *   (shape1/shape2 morphable Fourier shapes, mix/detune/octave applied)
 *   through the patch filter — NO ADSR — via OfflineAudioContext when
 *   available. Concurrent calls per canvas coalesce (latest wins); returns a
 *   promise that resolves once the canvas shows a trace for the latest call.
 *   Fallback without OfflineAudioContext: the same waveform is synthesised
 *   mathematically (Fourier series per oscillator, each harmonic scaled by a
 *   second-order approximation of the filter magnitude), so the trace still
 *   responds to every control qualitatively.
 *
 * export function attachLiveScope(canvas, analyser) => { destroy() }
 *   rAF time-domain trace (getFloatTimeDomainData, byte fallback) with a
 *   simple rising-edge trigger; pauses while document.hidden.
 *
 * export function attachMultiScope(canvas, engine, { tracks, legendContainer,
 *   onSelectionChange } = {}) => { destroy(), setTracks(ids) }
 *   One phosphor trace per selected track (default: all six, canonical UI
 *   order pad/arp/melody/bass/texture/percussion), sharing one graticule and
 *   one rAF loop. Analysers come from engine.getAnalysers(), lazily
 *   re-fetched on the engine's 'state' event and on tab-visible again (never
 *   polled per frame) — the same lazy-refetch/identity-compare shape the
 *   page uses for its single live scope. Each track gets its own auto-gain
 *   (same law as attachLiveScope) and its own reused sample buffer, so a
 *   quiet pad and a loud arp both read; a track under the silence floor
 *   draws no trace at all. Trace colour: getComputedStyle(canvas)
 *   --track-<id>, falling back to an evenly-spaced hue per track.
 *   setTracks(ids) narrows/reorders the drawn set (draw/z-order follows the
 *   given order); unknown ids are dropped.
 *
 *   Legend: without opts.legendContainer, a small canvas-drawn legend
 *   (colour swatch + id) runs along the bottom — labelling only, not
 *   interactive. With opts.legendContainer (a DOM element), the canvas
 *   legend is skipped and a DOM legend renders into it instead: one real
 *   <button> per track (all six, fixed canonical order), each an id label
 *   + a colour-swatch dot, aria-pressed reflecting whether that track is
 *   currently drawn. Interaction: a single click toggles that track's trace
 *   on/off; a double-click SOLOS it (every other track off); a second
 *   double-click on the already-soloed track restores the selection that
 *   was active just before it was soloed (soloing a different track while
 *   one is already soloed does not overwrite that remembered selection —
 *   only a plain single-click toggle clears it, since the user has then
 *   manually changed the set). Click/dblclick are disambiguated by delaying
 *   the single-click toggle ~250ms (MULTISCOPE_LEGEND_CLICK_DELAY_MS) behind
 *   a setTimeout: a second click on the same button within that window
 *   cancels the pending toggle so the following native dblclick event can
 *   solo cleanly, with no toggle-then-correct flicker. Every legend-driven
 *   change (toggle or solo, never a programmatic setTracks() call) fires
 *   opts.onSelectionChange(ids) with the new drawn-track id array, for the
 *   caller to persist. setTracks(ids) stays silent (no callback) and syncs
 *   the legend's aria-pressed/colours either way.
 *
 * All three live-drawing exports are devicePixelRatio-aware (capped, see
 * MAX_DPR) and redraw on size changes (ResizeObserver, device-pixel-
 * content-box where supported). Colours come from --scope-bg / --scope-grid
 * / --scope-trace with amber fallbacks.
 *
 * Shape numbers follow the v5 contract: 0 sine, 1 triangle, 2 sawtooth,
 * 3 square; fractional values interpolate the Fourier coefficients (the same
 * morph the voices use, reimplemented locally — this module imports nothing).
 * Legacy string osc names ('sine'…'square') are accepted everywhere.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HARMONICS = 24;
const GRID_COLS = 8;
const GRID_ROWS = 4;
const TRACE_HEIGHT = 0.42; // fraction of canvas height for full amplitude
const OFFLINE_SR = 44100;
const FALLBACK_SAMPLES = 512;
const FILTER_TYPES = ['lowpass', 'highpass', 'bandpass', 'notch'];
const SHAPE_NAMES = { sine: 0, triangle: 1, sawtooth: 2, square: 3 };
const TARGET_FPS = 30;
const FRAME_INTERVAL_MS = 1000 / TARGET_FPS;
// v14 05:4xZ: MAX_DPR=2 rendered soft under browser zoom on retina (effective
// dpr ~2.5-3). Raised to 3 — this canvas is small (device pixel count stays
// modest even at dpr 3), and the 30fps frame-rate cap (not backing-store
// size) carries the v9 thermal/perf budget, so this doesn't reopen that
// issue.
const MAX_DPR = 3;
const GLOW_ALPHA = 0.25;
const GLOW_LINE_WIDTH = 6;
const DIM_ALPHA = 0.35; // trace alpha multiplier while the silence floor is showing

// -- live-scope auto-gain -----------------------------------------------
// Real per-track analyser signal peaks at ~0.02-0.1 (the static renderPatchWave
// path normalises to full scale; raw analyser data does not), so the live trace
// needs its own adaptive gain or a correctly-playing pad reads as a flat line.
const LIVE_FFT_SIZE = 8192; // longer window: near-DC slow pads still show motion
const SILENCE_FLOOR = 0.002; // below this smoothed peak, never amplify noise
const GAIN_MAX = 40; // cap so near-silent noise can't be blown up into a fake signal
const GAIN_ATTACK_MS = 50; // time constant: rise to a louder signal quickly
const GAIN_DECAY_HALF_LIFE_MS = 2000; // half-life: fall back down slowly (no pumping)
const SCROLL_STEP_SAMPLES = 37; // untriggered-window nudge per drawn frame
const READOUT_FONT = '10px monospace';
const READOUT_ALPHA = 0.55;
const READOUT_PAD = 6;

// -- multi-scope (attachMultiScope) --------------------------------------
// Canonical UI track order — v13/v14 contract: "Track order everywhere:
// pad, arp, melody, bass, texture, percussion." (Distinct from the engine's
// own fixed pad/bass/melody/texture/arp/percussion param order.)
const MULTISCOPE_ALL_TRACKS = ['pad', 'arp', 'melody', 'bass', 'texture', 'percussion'];
const MULTISCOPE_LEGEND_FONT = '10px monospace';
const MULTISCOPE_LEGEND_ALPHA = 0.85;
const MULTISCOPE_LEGEND_PAD = 4;
const MULTISCOPE_LEGEND_SWATCH = 7;
const MULTISCOPE_LEGEND_GAP = 12;
// DOM legend (opts.legendContainer) click/dblclick disambiguation window —
// see the attachMultiScope doc comment above for the full rationale.
const MULTISCOPE_LEGEND_CLICK_DELAY_MS = 250;

const FALLBACK_BG = '#161009';
const FALLBACK_GRID = 'rgba(245, 182, 66, 0.16)';
const FALLBACK_TRACE = '#f5b642';

// ---------------------------------------------------------------------------
// Patch sanitising + waveform maths (local reimplementation of the morph)
// ---------------------------------------------------------------------------

function clampRange(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function inRange(v, lo, hi, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? clampRange(n, lo, hi) : fallback;
}

/** Accepts a shape number 0–3, a legacy osc string, or garbage (→ fallback). */
function shapeNumber(v, fallback) {
  if (typeof v === 'string' && v in SHAPE_NAMES) return SHAPE_NAMES[v];
  const n = Number(v);
  return Number.isFinite(n) ? clampRange(n, 0, 3) : fallback;
}

/** Sine-series coefficient b_n for the pure canonical shapes. */
function pureCoefficient(shape, n) {
  switch (shape) {
    case 0: // sine
      return n === 1 ? 1 : 0;
    case 1: // triangle
      return n % 2 ? ((8 / (Math.PI * Math.PI)) * (n % 4 === 1 ? 1 : -1)) / (n * n) : 0;
    case 2: // sawtooth
      return ((2 / Math.PI) * (n % 2 ? 1 : -1)) / n;
    case 3: // square
      return n % 2 ? 4 / Math.PI / n : 0;
    default:
      return 0;
  }
}

/**
 * Interpolated Fourier coefficients for a fractional shape, normalised so
 * Σb² = 1 (constant RMS — loudness doesn't jump across the dial). Index 0 is
 * the unused DC term, matching createPeriodicWave's imag layout.
 */
function shapeCoefficients(shape) {
  const lo = Math.floor(shape);
  const hi = Math.min(3, lo + 1);
  const t = shape - lo;
  const coeffs = new Float32Array(HARMONICS + 1);
  let sum = 0;
  for (let n = 1; n <= HARMONICS; n++) {
    const b = (1 - t) * pureCoefficient(lo, n) + t * pureCoefficient(hi, n);
    coeffs[n] = b;
    sum += b * b;
  }
  if (sum > 0) {
    const scale = 1 / Math.sqrt(sum);
    for (let n = 1; n <= HARMONICS; n++) coeffs[n] *= scale;
  }
  return coeffs;
}

/** Pulls the fields the scope needs out of a (possibly partial) patch. */
function sanitisePatch(patch) {
  const source = (patch && patch.source) || {};
  const filter = (patch && patch.filter) || {};
  const shape2Raw = source.shape2 !== undefined ? source.shape2 : source.osc2;
  return {
    source: {
      shape1: shapeNumber(source.shape1 !== undefined ? source.shape1 : source.osc1, 0),
      shape2: shape2Raw == null ? null : shapeNumber(shape2Raw, null),
      mix: inRange(source.mix, 0, 1, 0.5),
      detune: inRange(source.detune, 0, 50, 0),
      octave: inRange(source.octave, -1, 1, 0),
    },
    filter: {
      type: FILTER_TYPES.includes(filter.type) ? filter.type : 'lowpass',
      cutoff: inRange(filter.cutoff, 40, 12000, 12000),
      q: inRange(filter.q, 0.1, 20, 0.7),
    },
  };
}

/** Second-order filter magnitude approximation at frequency f. */
function filterMagnitude(filter, f) {
  const r = f / filter.cutoff;
  const denom = Math.sqrt((1 - r * r) * (1 - r * r) + (r / filter.q) * (r / filter.q));
  let mag;
  switch (filter.type) {
    case 'highpass':
      mag = (r * r) / denom;
      break;
    case 'bandpass':
      mag = r / filter.q / denom;
      break;
    case 'notch':
      mag = Math.abs(1 - r * r) / denom;
      break;
    default: // lowpass
      mag = 1 / denom;
      break;
  }
  return Number.isFinite(mag) ? Math.min(mag, 4) : 0;
}

function normalise(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  if (peak > 0) {
    for (let i = 0; i < samples.length; i++) samples[i] /= peak;
  }
  return samples;
}

// ---------------------------------------------------------------------------
// Offline render path
// ---------------------------------------------------------------------------

function offlineContextClass() {
  try {
    if (typeof OfflineAudioContext === 'function') return OfflineAudioContext;
  } catch {
    // fall through
  }
  try {
    if (typeof webkitOfflineAudioContext === 'function') return webkitOfflineAudioContext;
  } catch {
    // fall through
  }
  return null;
}

function addOscillator(ctx, destination, shape, freq, detuneCents, gainValue) {
  const osc = ctx.createOscillator();
  const imag = shapeCoefficients(shape);
  try {
    const wave = ctx.createPeriodicWave(new Float32Array(imag.length), imag, {
      disableNormalization: true, // we RMS-normalised the coefficients ourselves
    });
    osc.setPeriodicWave(wave);
  } catch {
    // PeriodicWave unavailable: nearest canonical type still shows something
    try {
      osc.type = ['sine', 'triangle', 'sawtooth', 'square'][Math.round(shape)] || 'sine';
    } catch {
      // ignore
    }
  }
  osc.frequency.value = freq;
  if (osc.detune && typeof osc.detune === 'object') osc.detune.value = detuneCents;
  else osc.frequency.value = freq * Math.pow(2, detuneCents / 1200);
  const gain = ctx.createGain();
  gain.gain.value = gainValue;
  osc.connect(gain);
  gain.connect(destination);
  osc.start(0);
}

/** Renders the patch offline and returns ~2 phase-aligned cycles, or null. */
async function offlineRenderSamples(patch, freq) {
  const AC = offlineContextClass();
  if (!AC) return null;
  const fBase = freq * Math.pow(2, patch.source.octave);
  const period = OFFLINE_SR / fBase;
  const windowLen = Math.max(4, Math.round(period * 2));
  // A few thousand samples: enough cycles that the biquad's startup
  // transient has died down before the drawn window at the end.
  const length = Math.max(2048, Math.ceil(period * 10));
  const ctx = new AC(1, length, OFFLINE_SR);

  const filter = ctx.createBiquadFilter();
  try {
    filter.type = patch.filter.type;
  } catch {
    // ignore — default lowpass
  }
  filter.frequency.value = patch.filter.cutoff;
  filter.Q.value = patch.filter.q;
  filter.connect(ctx.destination);

  const single = patch.source.shape2 === null;
  const mix = single ? 0 : patch.source.mix;
  addOscillator(ctx, filter, patch.source.shape1, fBase, 0, 1 - mix);
  if (!single && mix > 0) {
    addOscillator(ctx, filter, patch.source.shape2, fBase, patch.source.detune, mix);
  }

  const buffer = await ctx.startRendering();
  const data = buffer.getChannelData(0);
  if (!data || data.length < windowLen) return null;
  // Start on a whole-period boundary so the trace phase is stable per patch.
  const start = clampRange(
    Math.round(Math.floor((data.length - windowLen) / period) * period),
    0,
    data.length - windowLen
  );
  const out = new Float32Array(windowLen);
  for (let i = 0; i < windowLen; i++) out[i] = data[start + i];
  return out;
}

// ---------------------------------------------------------------------------
// Math-model fallback (no OfflineAudioContext)
// ---------------------------------------------------------------------------

function mathModelSamples(patch, freq) {
  const fBase = freq * Math.pow(2, patch.source.octave);
  const single = patch.source.shape2 === null;
  const mix = single ? 0 : patch.source.mix;
  const f2 = fBase * Math.pow(2, patch.source.detune / 1200);

  // Pre-scale each harmonic by the filter magnitude at its own frequency, so
  // the summed series IS the filtered steady-state waveform.
  const c1 = shapeCoefficients(patch.source.shape1);
  const amp1 = new Float32Array(HARMONICS + 1);
  for (let n = 1; n <= HARMONICS; n++) {
    amp1[n] = (1 - mix) * c1[n] * filterMagnitude(patch.filter, n * fBase);
  }
  let amp2 = null;
  if (!single && mix > 0) {
    const c2 = shapeCoefficients(patch.source.shape2);
    amp2 = new Float32Array(HARMONICS + 1);
    for (let n = 1; n <= HARMONICS; n++) {
      amp2[n] = mix * c2[n] * filterMagnitude(patch.filter, n * f2);
    }
  }

  const out = new Float32Array(FALLBACK_SAMPLES);
  const cycles = 2;
  for (let i = 0; i < FALLBACK_SAMPLES; i++) {
    const t = (i / FALLBACK_SAMPLES) * (cycles / fBase);
    let s = 0;
    for (let n = 1; n <= HARMONICS; n++) {
      if (amp1[n]) s += amp1[n] * Math.sin(2 * Math.PI * n * fBase * t);
      if (amp2 && amp2[n]) s += amp2[n] * Math.sin(2 * Math.PI * n * f2 * t);
    }
    out[i] = s;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

function cssColor(canvas, name, fallback) {
  try {
    const v = getComputedStyle(canvas).getPropertyValue(name);
    const s = typeof v === 'string' ? v.trim() : '';
    return s || fallback;
  } catch {
    return fallback;
  }
}

function currentDpr() {
  try {
    const raw = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    return Math.min(MAX_DPR, raw);
  } catch {
    return 1;
  }
}

/** Sizes the backing store to CSS px × dpr; returns the CSS-px draw size. */
function fitCanvas(canvas, ctx) {
  const dpr = currentDpr();
  let w = 0;
  let h = 0;
  try {
    const rect = canvas.getBoundingClientRect();
    w = Math.round(rect.width);
    h = Math.round(rect.height);
  } catch {
    // fall through to the DOM-less fallbacks
  }
  w = Math.max(1, w || canvas.clientWidth || canvas.width || 300);
  h = Math.max(1, h || canvas.clientHeight || canvas.height || 120);
  const bw = Math.round(w * dpr);
  const bh = Math.round(h * dpr);
  if (canvas.width !== bw) canvas.width = bw;
  if (canvas.height !== bh) canvas.height = bh;
  if (typeof ctx.setTransform === 'function') ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h, dpr };
}

// -- device-pixel snapping (crisp hairlines/text at any dpr) ---------------
//
// Coordinates are in CSS px but the canvas transform scales by `dpr`, so a
// coordinate that isn't a whole number of device pixels renders as a
// blurred antialiased edge. snapPixel rounds a CSS coordinate onto the
// device-pixel grid; snapHairline additionally offsets by half a device
// pixel so a 1-CSS-px-wide stroke centres on a single device pixel row
// instead of straddling two.

function snapPixel(v, dpr) {
  return Math.round(v * dpr) / dpr;
}

function snapHairline(v, dpr) {
  return snapPixel(v, dpr) + 0.5 / dpr;
}

/** Reads the three scope CSS vars once; callers on a per-frame loop cache this. */
function readScopeColors(canvas) {
  return {
    bg: cssColor(canvas, '--scope-bg', FALLBACK_BG),
    grid: cssColor(canvas, '--scope-grid', FALLBACK_GRID),
    trace: cssColor(canvas, '--scope-trace', FALLBACK_TRACE),
  };
}

/**
 * Backing-store fit + background fill + 8×4 graticule — the part every
 * scope frame shares, whether it draws zero, one, or several traces on top.
 */
function drawGraticule(canvas, ctx, colors) {
  const { w, h, dpr } = fitCanvas(canvas, ctx);
  const { bg, grid } = colors;

  // Defensive: a caller (the live-scope gain readout) may leave globalAlpha
  // non-1 after its own draw; every frame must start from a known state.
  ctx.globalAlpha = 1;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = grid;
  ctx.lineWidth = 1;
  for (let i = 0; i <= GRID_COLS; i++) {
    const x = snapHairline((w * i) / GRID_COLS, dpr);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let j = 0; j <= GRID_ROWS; j++) {
    const y = snapHairline((h * j) / GRID_ROWS, dpr);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  return { w, h, dpr };
}

/**
 * Strokes one trace (glow underlay + main line) in `color` over whatever is
 * already on the canvas. No-ops on too-short/missing sample sets, so a
 * caller can skip past a silent track just by not calling this.
 */
function strokeTraceLine(ctx, samples, w, h, color, dimFactor) {
  if (!samples || samples.length < 2) return;

  ctx.strokeStyle = color;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  const mid = h / 2;
  const amp = h * TRACE_HEIGHT;
  const strokeTrace = () => {
    ctx.beginPath();
    for (let i = 0; i < samples.length; i++) {
      const x = (w * i) / (samples.length - 1);
      const y = mid - clampRange(samples[i], -1.2, 1.2) * amp;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  };

  // Phosphor glow without per-frame shadowBlur: shadowBlur forces the canvas
  // backend to rasterise a soft-mask blur on every draw call; a wide,
  // low-alpha underlay stroke of the same trace is two ordinary path
  // strokes instead, at a fraction of the cost, same look.
  ctx.globalAlpha = GLOW_ALPHA * dimFactor;
  ctx.lineWidth = GLOW_LINE_WIDTH;
  strokeTrace();

  ctx.globalAlpha = dimFactor;
  ctx.lineWidth = 2;
  strokeTrace();
  ctx.globalAlpha = 1;
}

/**
 * `colors`, if supplied, skips the getComputedStyle reads (attachLiveScope
 * passes its cached theme colours in on every frame; renderPatchWave's
 * one-shot static render reads fresh each call).
 */
function drawScope(canvas, ctx, samples, colors, opts) {
  const resolved = colors || readScopeColors(canvas);
  const { w, h, dpr } = drawGraticule(canvas, ctx, resolved);
  const dimFactor = opts && opts.dim ? DIM_ALPHA : 1;
  strokeTraceLine(ctx, samples, w, h, resolved.trace, dimFactor);
  return { w, h, dpr };
}

/** Tiny corner readout of the current auto-gain; no-ops without fillText (bare Node). */
function drawGainReadout(ctx, w, h, label, color, dpr = 1) {
  if (typeof ctx.fillText !== 'function') return;
  try {
    ctx.font = READOUT_FONT;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.globalAlpha = READOUT_ALPHA;
    ctx.fillStyle = color;
    ctx.fillText(label, snapPixel(w - READOUT_PAD, dpr), snapPixel(h - READOUT_PAD, dpr));
    ctx.globalAlpha = 1;
  } catch {
    // a readout failure must never break the trace draw
  }
}

/** measureText, if the canvas supports it; a monospace-width guess otherwise. */
function textWidthEstimate(ctx, text) {
  try {
    if (typeof ctx.measureText === 'function') {
      const m = ctx.measureText(text);
      if (m && typeof m.width === 'number' && m.width > 0) return m.width;
    }
  } catch {
    // fall through to the estimate
  }
  return text.length * 6;
}

/**
 * Small canvas-drawn legend row along the bottom: a colour swatch + id per
 * entry, left to right. Labelling only — non-interactive, the caller's page
 * owns track selection UI. No-ops without fillText (bare Node).
 */
function drawMultiScopeLegend(ctx, w, h, entries, dpr) {
  if (!entries.length || typeof ctx.fillText !== 'function') return;
  try {
    ctx.font = MULTISCOPE_LEGEND_FONT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    const y = snapPixel(h - MULTISCOPE_LEGEND_PAD, dpr);
    let x = MULTISCOPE_LEGEND_PAD;
    for (const { id, color } of entries) {
      ctx.globalAlpha = MULTISCOPE_LEGEND_ALPHA;
      ctx.fillStyle = color;
      ctx.fillRect(
        snapPixel(x, dpr),
        snapPixel(y - MULTISCOPE_LEGEND_SWATCH, dpr),
        MULTISCOPE_LEGEND_SWATCH,
        MULTISCOPE_LEGEND_SWATCH
      );
      x += MULTISCOPE_LEGEND_SWATCH + 4;
      ctx.fillText(id, snapPixel(x, dpr), y);
      x += textWidthEstimate(ctx, id) + MULTISCOPE_LEGEND_GAP;
    }
    ctx.globalAlpha = 1;
  } catch {
    ctx.globalAlpha = 1;
  }
}

function observeResize(canvas, callback) {
  try {
    if (typeof ResizeObserver !== 'function') return null;
    const ro = new ResizeObserver(callback);
    try {
      // device-pixel-content-box also fires on devicePixelRatio changes
      ro.observe(canvas, { box: 'device-pixel-content-box' });
    } catch {
      ro.observe(canvas);
    }
    return ro;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// renderPatchWave — coalesced static trace
// ---------------------------------------------------------------------------

const patchJobs = new WeakMap(); // canvas -> { busy, queued, waiters, last, ro }
const liveCanvases = new WeakSet(); // canvases currently owned by a live scope

async function renderOnce(canvas, patch, opts) {
  const p = sanitisePatch(patch);
  const freq = inRange(opts && opts.freq, 20, 4000, 220);
  let samples = null;
  try {
    samples = await offlineRenderSamples(p, freq);
  } catch {
    samples = null;
  }
  if (!samples) {
    try {
      samples = mathModelSamples(p, freq);
    } catch {
      samples = null;
    }
  }
  try {
    let ctx = null;
    try {
      ctx = canvas.getContext('2d');
    } catch {
      ctx = null;
    }
    if (ctx) drawScope(canvas, ctx, samples ? normalise(samples) : null);
  } catch {
    // a draw failure must not reject the caller's promise chain
  }
}

async function pumpJobs(canvas, job) {
  job.busy = true;
  while (job.queued) {
    const { patch, opts } = job.queued;
    job.queued = null;
    const waiters = job.waiters;
    job.waiters = [];
    await renderOnce(canvas, patch, opts);
    for (const resolve of waiters) resolve();
  }
  job.busy = false;
}

export function renderPatchWave(canvas, patch, opts) {
  if (!canvas || typeof canvas.getContext !== 'function') return Promise.resolve();
  let job = patchJobs.get(canvas);
  if (!job) {
    job = { busy: false, queued: null, waiters: [], last: null, ro: null };
    patchJobs.set(canvas, job);
    job.ro = observeResize(canvas, () => {
      if (liveCanvases.has(canvas) || !job.last) return;
      renderPatchWave(canvas, job.last.patch, job.last.opts);
    });
  }
  job.last = { patch, opts };
  return new Promise((resolve) => {
    job.queued = { patch, opts };
    job.waiters.push(resolve);
    if (!job.busy) pumpJobs(canvas, job);
  });
}

// ---------------------------------------------------------------------------
// Shared live-trace state, auto-gain, and rAF-loop lifecycle
// (attachLiveScope and attachMultiScope both build on these.)
// ---------------------------------------------------------------------------

/** Per-analyser scratch: sample buffers + auto-gain + trigger-scroll state. */
function createTraceState() {
  return { floatBuf: null, byteBuf: null, gainPeak: 0, lastGainTs: null, scrollOffset: 0 };
}

// A longer time-domain window means a slow, near-DC-per-buffer pad still has
// somewhere for the trigger/scroll to find motion in. Only ever grow an
// analyser's fftSize — never shrink one a caller deliberately set higher.
function bumpFftSize(analyser) {
  try {
    if (typeof analyser.fftSize === 'number' && analyser.fftSize < LIVE_FFT_SIZE) {
      analyser.fftSize = LIVE_FFT_SIZE;
    }
  } catch {
    // analyser rejected the resize (e.g. a stub/mock) — keep its current fftSize
  }
}

/** Reads one frame of time-domain samples into `state`'s reused buffer(s). */
function readAnalyserSamples(analyser, state) {
  const useFloat = typeof analyser.getFloatTimeDomainData === 'function';
  const useByte = !useFloat && typeof analyser.getByteTimeDomainData === 'function';
  if (!useFloat && !useByte) return null;
  const size = analyser.fftSize || (analyser.frequencyBinCount ? analyser.frequencyBinCount * 2 : 1024);
  if (useFloat) {
    if (!state.floatBuf || state.floatBuf.length !== size) state.floatBuf = new Float32Array(size);
    analyser.getFloatTimeDomainData(state.floatBuf);
    return state.floatBuf;
  }
  if (!state.byteBuf || state.byteBuf.length !== size) state.byteBuf = new Uint8Array(size);
  analyser.getByteTimeDomainData(state.byteBuf);
  if (!state.floatBuf || state.floatBuf.length !== size) state.floatBuf = new Float32Array(size);
  for (let i = 0; i < size; i++) state.floatBuf[i] = (state.byteBuf[i] - 128) / 128;
  return state.floatBuf;
}

function bufferPeak(data) {
  let peak = 0;
  for (let i = 0; i < data.length; i++) {
    const a = Math.abs(data[i]);
    if (a > peak) peak = a;
  }
  return peak;
}

/** One-pole attack / half-life decay of `state.gainPeak` towards `target`. */
function updateGainPeak(state, target, ts) {
  if (state.lastGainTs === null) {
    state.gainPeak = target;
    state.lastGainTs = typeof ts === 'number' ? ts : 0;
    return;
  }
  const dt = typeof ts === 'number' ? Math.max(0, ts - state.lastGainTs) : 0;
  if (typeof ts === 'number') state.lastGainTs = ts;
  if (target >= state.gainPeak) {
    const alpha = 1 - Math.exp(-dt / GAIN_ATTACK_MS);
    state.gainPeak += (target - state.gainPeak) * alpha;
  } else {
    const decay = Math.pow(0.5, dt / GAIN_DECAY_HALF_LIFE_MS);
    state.gainPeak = target + (state.gainPeak - target) * decay;
  }
}

function scaleWindow(win, factor) {
  if (factor === 1) return win;
  const out = new Float32Array(win.length);
  for (let i = 0; i < win.length; i++) out[i] = win[i] * factor;
  return out;
}

/**
 * Rising-edge trigger: start the trace at a −→+ zero crossing. Slow pads are
 * near-DC across a single buffer and may have no edge at all in the search
 * window — falling back to a fixed start then looks frozen frame to frame
 * even though fresh data IS arriving, because the same window position gets
 * redrawn every time. Instead, walk `state.scrollOffset` forward each frame
 * so the trace still visibly scrolls.
 */
function triggeredWindow(state, data) {
  const windowLen = Math.max(2, Math.floor(data.length / 2));
  const searchEnd = data.length - windowLen;
  for (let i = 1; i < searchEnd; i++) {
    if (data[i - 1] <= 0 && data[i] > 0) {
      return data.subarray ? data.subarray(i, i + windowLen) : data;
    }
  }
  const maxStart = Math.max(0, data.length - windowLen);
  if (maxStart > 0) state.scrollOffset = (state.scrollOffset + SCROLL_STEP_SAMPLES) % (maxStart + 1);
  const start = Math.min(state.scrollOffset, maxStart);
  return data.subarray ? data.subarray(start, start + windowLen) : data;
}

function isDocumentHidden() {
  try {
    return typeof document !== 'undefined' && !!document.hidden;
  } catch {
    return false;
  }
}

/**
 * Shared rAF-loop lifecycle: 30fps cap (timestamp-gated, still scheduled
 * every tick so it never falls out of sync with the compositor),
 * IntersectionObserver viewport gating, document.hidden pause, and a
 * resize-triggered redraw while paused/no-rAF so a frozen frame stays
 * current. `onVisible`, if supplied, fires when the tab becomes visible
 * again, before the loop resumes — attachMultiScope hangs its "identity
 * changed without a 'state' event" analyser re-fetch off this.
 */
function createRafLoop(canvas, drawFrame, { onVisible } = {}) {
  let destroyed = false;
  let rafId = null;
  let inView = true; // no IO support → this axis never pauses the loop
  let intersectionObserver = null;

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

  function ensureLoop() {
    if (destroyed || rafId !== null || isDocumentHidden() || !inView) return;
    const reqAF = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null;
    if (!reqAF) {
      drawFrame(); // no rAF (bare Node): single static frame
      return;
    }
    let lastFrameTs = -Infinity;
    const loop = (ts) => {
      if (destroyed || isDocumentHidden() || !inView) {
        rafId = null;
        return;
      }
      if (ts - lastFrameTs >= FRAME_INTERVAL_MS) {
        lastFrameTs = ts;
        drawFrame(ts);
      }
      rafId = reqAF(loop);
    };
    rafId = reqAF(loop);
  }

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

  function onVisibilityChange() {
    if (isDocumentHidden()) {
      stopLoop();
      return;
    }
    if (typeof onVisible === 'function') {
      try {
        onVisible();
      } catch {
        // ignore
      }
    }
    ensureLoop();
  }
  try {
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
  } catch {
    // ignore
  }

  const ro = observeResize(canvas, () => {
    if (!destroyed && rafId === null) {
      try {
        drawFrame();
      } catch {
        // ignore
      }
    }
  });

  return {
    start: ensureLoop,
    stop() {
      if (destroyed) return;
      destroyed = true;
      stopLoop();
      try {
        if (ro) ro.disconnect();
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
      try {
        if (intersectionObserver) intersectionObserver.disconnect();
      } catch {
        // ignore
      }
    },
  };
}

// ---------------------------------------------------------------------------
// attachLiveScope — rAF time-domain trace
// ---------------------------------------------------------------------------

export function attachLiveScope(canvas, analyser) {
  if (!canvas || typeof canvas.getContext !== 'function' || !analyser) {
    return { destroy() {} };
  }
  let ctx = null;
  try {
    ctx = canvas.getContext('2d');
  } catch {
    ctx = null;
  }
  if (!ctx) return { destroy() {} };

  const useFloat = typeof analyser.getFloatTimeDomainData === 'function';
  const useByte = typeof analyser.getByteTimeDomainData === 'function';
  if (!useFloat && !useByte) return { destroy() {} };

  bumpFftSize(analyser);

  let destroyed = false;
  const trace = createTraceState();

  liveCanvases.add(canvas);

  // -- theme colours: read once, refresh only on an actual theme flip -----
  // (drawScope used to call getComputedStyle 3x per frame at up to 30fps;
  // caching turns that into 1x per attach + 1x per prefers-color-scheme flip.)
  let themeColors = readScopeColors(canvas);
  let themeMedia = null;
  function onThemeChange() {
    themeColors = readScopeColors(canvas);
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

  function drawFrame(ts) {
    try {
      const data = readAnalyserSamples(analyser, trace);
      updateGainPeak(trace, bufferPeak(data), ts);
      const silent = trace.gainPeak < SILENCE_FLOOR;
      const gain = silent ? 0 : Math.min(GAIN_MAX, 1 / trace.gainPeak);
      const window = triggeredWindow(trace, data);
      const size = drawScope(canvas, ctx, scaleWindow(window, gain), themeColors, { dim: silent });
      if (size) {
        const label = silent ? 'silent' : `×${gain.toFixed(1)} (${(20 * Math.log10(gain)).toFixed(1)} dB)`;
        drawGainReadout(ctx, size.w, size.h, label, themeColors.trace, size.dpr);
      }
    } catch {
      // never let a draw error kill the loop
    }
  }

  const loop = createRafLoop(canvas, drawFrame);
  loop.start();

  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      loop.stop();
      liveCanvases.delete(canvas);
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
    },
  };
}

// ---------------------------------------------------------------------------
// attachMultiScope — one phosphor trace per track, engine-driven
// ---------------------------------------------------------------------------

function fallbackTrackHue(id) {
  const i = MULTISCOPE_ALL_TRACKS.indexOf(id);
  return Math.round((360 * (i < 0 ? 0 : i)) / MULTISCOPE_ALL_TRACKS.length);
}

function trackColor(canvas, id) {
  return cssColor(canvas, `--track-${id}`, `hsl(${fallbackTrackHue(id)}, 70%, 55%)`);
}

function isDomElement(el) {
  return !!el && typeof el.appendChild === 'function' && typeof el.removeChild === 'function';
}

/** Filters/dedupes a requested track list to known ids, in caller order; falls back to all six. */
function normaliseTracks(ids) {
  if (!Array.isArray(ids)) return [...MULTISCOPE_ALL_TRACKS];
  const seen = new Set();
  const out = [];
  for (const id of ids) {
    if (typeof id === 'string' && MULTISCOPE_ALL_TRACKS.includes(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

export function attachMultiScope(canvas, engine, opts) {
  const inert = { destroy() {}, setTracks() {} };
  if (!canvas || typeof canvas.getContext !== 'function' || !engine) return inert;
  let ctx = null;
  try {
    ctx = canvas.getContext('2d');
  } catch {
    ctx = null;
  }
  if (!ctx) return inert;

  let destroyed = false;
  let selected = normaliseTracks(opts && opts.tracks);
  const trackStates = new Map(); // track id -> createTraceState() + { analyser }

  liveCanvases.add(canvas);

  function getTrackState(id) {
    let st = trackStates.get(id);
    if (!st) {
      st = { analyser: null, ...createTraceState() };
      trackStates.set(id, st);
    }
    return st;
  }

  // -- theme + per-track colours: cache, refresh only on an actual theme flip --
  let themeColors = readScopeColors(canvas);
  let trackColors = new Map();
  function refreshColors() {
    themeColors = readScopeColors(canvas);
    trackColors = new Map(MULTISCOPE_ALL_TRACKS.map((id) => [id, trackColor(canvas, id)]));
    syncLegend();
  }

  // -- DOM legend (opts.legendContainer) — see the doc comment above -------
  const legendContainer = opts && isDomElement(opts.legendContainer) ? opts.legendContainer : null;
  const onSelectionChange =
    opts && typeof opts.onSelectionChange === 'function' ? opts.onSelectionChange : null;
  const legendButtons = new Map(); // track id -> { btn, dot, onClick, onDblClick }
  let pendingClickId = null;
  let pendingClickTimer = null;
  let preSoloSelection = null; // selection to restore on the soloed track's second dblclick

  function syncLegend() {
    if (!legendContainer) return;
    try {
      for (const [id, { btn, dot }] of legendButtons) {
        btn.setAttribute('aria-pressed', selected.includes(id) ? 'true' : 'false');
        dot.style.backgroundColor = trackColors.get(id) || themeColors.trace;
      }
    } catch {
      // a legend sync failure must never break the trace loop
    }
  }

  /** setTracks()'s path: updates the drawn set + legend, no callback (caller-driven, not user-driven). */
  function applySelectionSilently(next) {
    selected = normaliseTracks(next);
    syncLegend();
  }

  /** Legend-driven path (click/dblclick): updates the set, legend, AND fires onSelectionChange. */
  function applySelectionFromLegend(next) {
    applySelectionSilently(next);
    if (onSelectionChange) {
      try {
        onSelectionChange([...selected]);
      } catch {
        // a consumer callback failure must never break the trace loop
      }
    }
  }

  function toggleTrack(id) {
    preSoloSelection = null; // a manual toggle supersedes any pending solo-restore
    const idx = selected.indexOf(id);
    applySelectionFromLegend(idx >= 0 ? selected.filter((t) => t !== id) : [...selected, id]);
  }

  function soloTrack(id) {
    const alreadySoloedOnId = preSoloSelection !== null && selected.length === 1 && selected[0] === id;
    if (alreadySoloedOnId) {
      applySelectionFromLegend(preSoloSelection);
      preSoloSelection = null;
      return;
    }
    if (preSoloSelection === null) preSoloSelection = [...selected];
    applySelectionFromLegend([id]);
  }

  function clearPendingClick() {
    if (pendingClickTimer !== null) {
      try {
        clearTimeout(pendingClickTimer);
      } catch {
        // ignore
      }
    }
    pendingClickTimer = null;
    pendingClickId = null;
  }

  // Click vs dblclick disambiguation: a plain click's toggle is delayed
  // MULTISCOPE_LEGEND_CLICK_DELAY_MS behind a timer; a second click on the
  // SAME button within that window cancels the pending toggle (so no
  // toggle-then-correct flicker) and lets the native dblclick event solo.
  function onLegendClick(id) {
    if (pendingClickTimer !== null && pendingClickId === id) {
      clearPendingClick();
      return;
    }
    clearPendingClick();
    pendingClickId = id;
    pendingClickTimer = setTimeout(() => {
      pendingClickTimer = null;
      pendingClickId = null;
      toggleTrack(id);
    }, MULTISCOPE_LEGEND_CLICK_DELAY_MS);
  }

  function onLegendDblClick(id) {
    clearPendingClick();
    soloTrack(id);
  }

  function buildLegend() {
    if (!legendContainer) return;
    try {
      legendContainer.textContent = '';
      legendButtons.clear();
      for (const id of MULTISCOPE_ALL_TRACKS) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'scope-legend-track';
        btn.setAttribute('aria-pressed', selected.includes(id) ? 'true' : 'false');
        const dot = document.createElement('span');
        dot.className = 'scope-legend-dot';
        dot.style.backgroundColor = trackColors.get(id) || themeColors.trace;
        const label = document.createElement('span');
        label.className = 'scope-legend-label';
        label.textContent = id;
        btn.appendChild(dot);
        btn.appendChild(label);
        const onClick = () => onLegendClick(id);
        const onDblClick = () => onLegendDblClick(id);
        btn.addEventListener('click', onClick);
        btn.addEventListener('dblclick', onDblClick);
        legendContainer.appendChild(btn);
        legendButtons.set(id, { btn, dot, onClick, onDblClick });
      }
    } catch {
      // a legend build failure must never break the trace loop
    }
  }

  function destroyLegend() {
    clearPendingClick();
    if (!legendContainer) return;
    try {
      for (const { btn, onClick, onDblClick } of legendButtons.values()) {
        btn.removeEventListener('click', onClick);
        btn.removeEventListener('dblclick', onDblClick);
      }
      legendContainer.textContent = '';
    } catch {
      // ignore
    }
    legendButtons.clear();
  }

  refreshColors();
  buildLegend();
  let themeMedia = null;
  function onThemeChange() {
    refreshColors();
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

  // -- analyser identity: lazily re-fetched, never polled per frame -------
  // Mirrors the page's own single-scope pattern: re-fetch engine.getAnalysers()
  // on the engine's 'state' event, and again when the tab becomes visible
  // (a context rebuild — e.g. iOS interrupt recovery — can swap analyser
  // node identity without ever emitting 'state').
  function refreshAnalysers() {
    let analysers = null;
    try {
      if (engine.running && typeof engine.getAnalysers === 'function') {
        analysers = engine.getAnalysers() || null;
      }
    } catch {
      analysers = null;
    }
    for (const id of MULTISCOPE_ALL_TRACKS) {
      const st = getTrackState(id);
      const next = (analysers && analysers[id]) || null;
      if (next !== st.analyser) {
        st.analyser = next;
        st.floatBuf = null;
        st.byteBuf = null;
        st.gainPeak = 0;
        st.lastGainTs = null;
        st.scrollOffset = 0;
        if (next) bumpFftSize(next);
      }
    }
  }
  refreshAnalysers();

  let unsubState = null;
  try {
    if (typeof engine.on === 'function') {
      unsubState = engine.on('state', () => refreshAnalysers());
    }
  } catch {
    unsubState = null;
  }

  function drawFrame(ts) {
    try {
      const { w, h, dpr } = drawGraticule(canvas, ctx, themeColors);
      for (const id of selected) {
        const st = getTrackState(id);
        const analyser = st.analyser;
        if (!analyser) continue;
        const data = readAnalyserSamples(analyser, st);
        if (!data) continue;
        updateGainPeak(st, bufferPeak(data), ts);
        if (st.gainPeak < SILENCE_FLOOR) continue; // silent: draw nothing, no flat-line clutter
        const gain = Math.min(GAIN_MAX, 1 / st.gainPeak);
        const windowSamples = triggeredWindow(st, data);
        const color = trackColors.get(id) || themeColors.trace;
        strokeTraceLine(ctx, scaleWindow(windowSamples, gain), w, h, color, 1);
      }
      if (!legendContainer) {
        const legendEntries = selected.map((id) => ({ id, color: trackColors.get(id) || themeColors.trace }));
        drawMultiScopeLegend(ctx, w, h, legendEntries, dpr);
      }
    } catch {
      // never let a draw error kill the loop
    }
  }

  const loop = createRafLoop(canvas, drawFrame, { onVisible: refreshAnalysers });
  loop.start();

  return {
    setTracks(ids) {
      preSoloSelection = null; // a programmatic set supersedes any pending solo-restore
      applySelectionSilently(ids);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      loop.stop();
      liveCanvases.delete(canvas);
      destroyLegend();
      try {
        if (unsubState) unsubState();
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
    },
  };
}
