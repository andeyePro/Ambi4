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
 * Both are devicePixelRatio-aware and redraw on size changes
 * (ResizeObserver, device-pixel-content-box where supported). Colours come
 * from --scope-bg / --scope-grid / --scope-trace with amber fallbacks.
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
const MAX_DPR = 2; // retina laptops report 2, but browser zoom can push higher
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
  return { w, h };
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
 * `colors`, if supplied, skips the getComputedStyle reads (attachLiveScope
 * passes its cached theme colours in on every frame; renderPatchWave's
 * one-shot static render reads fresh each call).
 */
function drawScope(canvas, ctx, samples, colors, opts) {
  const { w, h } = fitCanvas(canvas, ctx);
  const resolved = colors || readScopeColors(canvas);
  const { bg, grid, trace } = resolved;
  const dimFactor = opts && opts.dim ? DIM_ALPHA : 1;

  // Defensive: a caller (the live-scope gain readout) may leave globalAlpha
  // non-1 after its own draw; every frame must start from a known state.
  ctx.globalAlpha = 1;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // 8×4 graticule
  ctx.strokeStyle = grid;
  ctx.lineWidth = 1;
  for (let i = 0; i <= GRID_COLS; i++) {
    const x = (w * i) / GRID_COLS;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let j = 0; j <= GRID_ROWS; j++) {
    const y = (h * j) / GRID_ROWS;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  if (!samples || samples.length < 2) return { w, h };

  ctx.strokeStyle = trace;
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

  return { w, h };
}

/** Tiny corner readout of the current auto-gain; no-ops without fillText (bare Node). */
function drawGainReadout(ctx, w, h, label, color) {
  if (typeof ctx.fillText !== 'function') return;
  try {
    ctx.font = READOUT_FONT;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.globalAlpha = READOUT_ALPHA;
    ctx.fillStyle = color;
    ctx.fillText(label, w - READOUT_PAD, h - READOUT_PAD);
    ctx.globalAlpha = 1;
  } catch {
    // a readout failure must never break the trace draw
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

  // A longer time-domain window means a slow, near-DC-per-buffer pad still
  // has somewhere for the trigger/scroll to find motion in. Only ever grow
  // it — never shrink an fftSize a caller deliberately set higher.
  try {
    if (typeof analyser.fftSize === 'number' && analyser.fftSize < LIVE_FFT_SIZE) {
      analyser.fftSize = LIVE_FFT_SIZE;
    }
  } catch {
    // analyser rejected the resize (e.g. a stub/mock) — keep its current fftSize
  }

  let destroyed = false;
  let rafId = null;
  let floatBuf = null;
  let byteBuf = null;

  liveCanvases.add(canvas);

  function isHidden() {
    try {
      return typeof document !== 'undefined' && !!document.hidden;
    } catch {
      return false;
    }
  }

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

  function readSamples() {
    const size = analyser.fftSize || (analyser.frequencyBinCount ? analyser.frequencyBinCount * 2 : 1024);
    if (useFloat) {
      if (!floatBuf || floatBuf.length !== size) floatBuf = new Float32Array(size);
      analyser.getFloatTimeDomainData(floatBuf);
      return floatBuf;
    }
    if (!byteBuf || byteBuf.length !== size) byteBuf = new Uint8Array(size);
    analyser.getByteTimeDomainData(byteBuf);
    if (!floatBuf || floatBuf.length !== size) floatBuf = new Float32Array(size);
    for (let i = 0; i < size; i++) floatBuf[i] = (byteBuf[i] - 128) / 128;
    return floatBuf;
  }

  let scrollOffset = 0; // untriggered fallback: nudges the window each drawn frame

  /**
   * Rising-edge trigger: start the trace at a −→+ zero crossing. Slow pads
   * are near-DC across a single buffer and may have no edge at all in the
   * search window — falling back to a fixed start (old behaviour) then
   * looks frozen frame to frame even though fresh data IS arriving, because
   * the same window position gets redrawn every time. Instead, walk the
   * start position forward each frame so the trace still visibly scrolls.
   */
  function triggeredWindow(data) {
    const windowLen = Math.max(2, Math.floor(data.length / 2));
    const searchEnd = data.length - windowLen;
    for (let i = 1; i < searchEnd; i++) {
      if (data[i - 1] <= 0 && data[i] > 0) {
        return data.subarray ? data.subarray(i, i + windowLen) : data;
      }
    }
    const maxStart = Math.max(0, data.length - windowLen);
    if (maxStart > 0) scrollOffset = (scrollOffset + SCROLL_STEP_SAMPLES) % (maxStart + 1);
    const start = Math.min(scrollOffset, maxStart);
    return data.subarray ? data.subarray(start, start + windowLen) : data;
  }

  // -- auto-gain: smoothed running peak, fast attack / slow decay ---------

  let gainPeak = 0;
  let lastGainTs = null;

  function bufferPeak(data) {
    let peak = 0;
    for (let i = 0; i < data.length; i++) {
      const a = Math.abs(data[i]);
      if (a > peak) peak = a;
    }
    return peak;
  }

  /** One-pole attack / half-life decay towards `target`, driven by rAF `ts`. */
  function updateGainPeak(target, ts) {
    if (lastGainTs === null) {
      gainPeak = target;
      lastGainTs = typeof ts === 'number' ? ts : 0;
      return;
    }
    const dt = typeof ts === 'number' ? Math.max(0, ts - lastGainTs) : 0;
    if (typeof ts === 'number') lastGainTs = ts;
    if (target >= gainPeak) {
      const alpha = 1 - Math.exp(-dt / GAIN_ATTACK_MS);
      gainPeak += (target - gainPeak) * alpha;
    } else {
      const decay = Math.pow(0.5, dt / GAIN_DECAY_HALF_LIFE_MS);
      gainPeak = target + (gainPeak - target) * decay;
    }
  }

  function scaleWindow(win, factor) {
    if (factor === 1) return win;
    const out = new Float32Array(win.length);
    for (let i = 0; i < win.length; i++) out[i] = win[i] * factor;
    return out;
  }

  function drawFrame(ts) {
    try {
      const data = readSamples();
      updateGainPeak(bufferPeak(data), ts);
      const silent = gainPeak < SILENCE_FLOOR;
      const gain = silent ? 0 : Math.min(GAIN_MAX, 1 / gainPeak);
      const window = triggeredWindow(data);
      const size = drawScope(canvas, ctx, scaleWindow(window, gain), themeColors, { dim: silent });
      if (size) {
        const label = silent ? 'silent' : `×${gain.toFixed(1)} (${(20 * Math.log10(gain)).toFixed(1)} dB)`;
        drawGainReadout(ctx, size.w, size.h, label, themeColors.trace);
      }
    } catch {
      // never let a draw error kill the loop
    }
  }

  // -- viewport gating (IntersectionObserver) ------------------------------

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

  function ensureLoop() {
    if (destroyed || rafId !== null || isHidden() || !inView) return;
    const reqAF = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null;
    if (!reqAF) {
      drawFrame(); // no rAF (bare Node): single static frame
      return;
    }
    let lastFrameTs = -Infinity;
    const loop = (ts) => {
      if (destroyed || isHidden() || !inView) {
        rafId = null;
        return;
      }
      if (ts - lastFrameTs >= FRAME_INTERVAL_MS) {
        // Timestamp-gated: still scheduled every rAF tick (skip frames, not
        // timers), so we never fall out of sync with the compositor.
        lastFrameTs = ts;
        drawFrame(ts);
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

  function onVisibilityChange() {
    if (isHidden()) stopLoop();
    else ensureLoop();
  }
  try {
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
  } catch {
    // ignore
  }

  const ro = observeResize(canvas, () => {
    if (!destroyed && rafId === null) drawFrame(); // paused/no-rAF: keep the frame fresh
  });

  ensureLoop();

  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stopLoop();
      liveCanvases.delete(canvas);
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
