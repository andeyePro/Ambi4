#!/usr/bin/env node
/**
 * Builds the animated Ambi4 logo: public/logo/ambi4-logo.svg (CSS-animated, no
 * JavaScript), public/logo/ambi4-mark.svg (static, favicon-sized) and
 * public/logo/ambi4-card.svg (the static 1200x630 social card; ambi4-card.png
 * is it rasterised). The logo is for andeye.com's advert for Ambi4, not the
 * app's own header; public/logo/preview.html shows it at 512, 128 and 32 px.
 *
 *   node scripts/build-logo.mjs
 *
 * The dial is the app's own range dial, taken from src/scripts/knob.js rather
 * than redrawn by eye: the same 100x100 face geometry (RING_R 36, FACE_R 31,
 * the 25 minor + 5 quartile ticks round a 270 degree sweep from -135), the same
 * dark-theme tokens from src/styles/global.css, and the same parts in the same
 * paint order — range arc, ring, face, min pointer (engraved), hub, live
 * pointer, max thumb. Widths are the knob's GRIP widths (POINTER_W_DRAG,
 * MAX_POINTER_W_DRAG, ARC_W_DRAG), which is the look the owner's rough shows.
 *
 * The face is the Synthwave oscilloscope (src/scripts/scope.js: --scope-bg,
 * --scope-grid, a glow underlay at 0.25 under each trace), clipped to the face
 * circle. One period of each trace is computed from the voice it draws:
 *   purple --track-bass       sawbass: saw + sine sub-octave + second saw
 *                             through a resonant 2-pole lowpass (Q 1.8)
 *   green  --track-percussion soft kit: the membrane's sine body
 *   orange --track-melody     keys: a ratio-1 FM pair
 * All three scroll at ONE speed (a scope has one time axis), each by exactly
 * one of its own periods per iteration, and every duration divides the 12 s
 * master loop, so the loop point is invisible.
 *
 * frameSvg(t) evaluates the same keyframes in JS and emits a static SVG of the
 * pose at time t, so the animation can be checked without a browser.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MASTER_S = 12;

// knob.js geometry
const CX = 50;
const CY = 50;
const RING_R = 36;
const FACE_R = 31;
const TICK_IN = 41;
const TICK_OUT = 46;
const TICK_MAJOR_IN = 39.5;
const TICK_MAJOR_OUT = 48;
const START_DEG = -135;
const SWEEP_DEG = 270;
const MINOR_TICKS = 25;
const HUB_R = +(FACE_R * 0.45).toFixed(2);

// global.css dark theme (the rough is the dark theme)
const C = {
  backdrop: '#25231f', // the rough logo's background, sampled from it
  ring: '#96703a',
  pointer: '#ffb454', // --knob-pointer
  tick: '#8c7f6a',
  tickMajor: '#e6dfd1',
  accent: '#f0a942', // --accent-warm, the max thumb
  live: '#f2e8d5', // --knob-live default
  hub: 'rgba(242,232,213,.22)',
  scopeBg: '#0b0f0a',
  scopeGrid: '#232b1c',
  bass: '#a676ce',
  perc: '#6acf67',
  melody: '#c97354',
};

const EASE_DIAL = [0.65, 0, 0.35, 1];
const EASE_LIVE = [0.4, 0, 0.2, 1];

/** Keyframes as [percent, absolute degrees]; each segment eases with `ease`. */
export const TRACKS = {
  min: { ease: EASE_DIAL, keys: [[0, -15], [42, -15], [52, -55], [86, -55], [96, -15], [100, -15]] },
  max: { ease: EASE_DIAL, keys: [[0, 95], [16, 95], [26, 125], [63, 125], [73, 95], [100, 95]] },
  live: {
    ease: EASE_LIVE,
    keys: [
      [0, 22], [8, 22], [16, 70], [22, 70], [30, 108], [37, 108], [45, 40], [50, 40],
      [58, -30], [65, -30], [73, 50], [78, 50], [85, 10], [88, 10], [96, 22], [100, 22],
    ],
  },
};

// Scope: one time axis, so one scroll speed for every trace.
const SPEED = 26 / 3; // user units per second
const X0 = 16; // path start: the face spans 19..81, and the glow cap must start outside it
export const TRACES = [
  // Painted back to front: the busy melody under the kick under the bass.
  { id: 'e', colour: C.melody, period: 6.5, samples: 13, amp: 2.2, mid: 50.5, width: 0.7, wave: keysFm },
  { id: 'k', colour: C.perc, period: 13, samples: 26, amp: 5, mid: 50, width: 0.9, wave: (x) => Math.sin(x) },
  { id: 'b', colour: C.bass, period: 26, samples: 104, amp: 11, mid: 51, width: 1, wave: sawbass },
].map((t) => ({ ...t, dur: t.period / SPEED }));

// ---------------------------------------------------------------- waveforms

/**
 * sawbass over ONE period of its sub-octave (x in radians of the sub): the
 * engine's three layers — saw at ratio 1 (0.4), sine at ratio 0.5 (0.28), a
 * second saw (0.32, its 7 cent detune frozen here as a phase offset) — through
 * a 2-pole lowpass at 4.5x the note with the patch's Q 1.8.
 */
function sawbass(x) {
  const Q = 1.8;
  const fc = 4.5; // in harmonics of the saw
  let y = 0;
  const add = (n, a, ph) => {
    const r = n / 2 / fc; // n is a harmonic of the sub; the saw is n/2
    const re = 1 - r * r;
    const im = r / Q;
    const mag = 1 / Math.hypot(re, im);
    y += a * mag * Math.sin(n * x + ph - Math.atan2(im, re));
  };
  add(1, 0.28, 0);
  for (let k = 1; k <= 14; k++) {
    const a = ((2 / Math.PI) * (k % 2 ? 1 : -1)) / k;
    add(2 * k, 0.4 * a, 0);
    add(2 * k, 0.32 * a, k * 0.3);
  }
  return y;
}

/** keys: a ratio-1 FM pair, carrier phase-modulated by its own frequency. */
function keysFm(x) {
  return Math.sin(x + 1.7 * Math.sin(x));
}

// ---------------------------------------------------------------- helpers

export function num(n, d = 2) {
  let s = (+n.toFixed(d)).toString();
  if (s === '-0') s = '0';
  return s.replace(/^(-?)0\./, '$1.');
}

function polar(r, deg) {
  const a = (deg * Math.PI) / 180;
  return [CX + r * Math.sin(a), CY - r * Math.cos(a)];
}

function line(r1, r2, deg) {
  const [a, b] = polar(r1, deg);
  const [c, d] = polar(r2, deg);
  return `M${num(a)} ${num(b)}L${num(c)} ${num(d)}`;
}

/** Joins numbers SVG-path style: a separator only where the sign doesn't give one. */
function pairs(list) {
  let out = '';
  for (const v of list) {
    const s = num(v, 3);
    out += out && !s.startsWith('-') && !(s.startsWith('.') && /\.\d*$/.test(out)) ? ' ' + s : s;
  }
  return out;
}

/** Trace path: whole periods covering the face plus one scroll period. */
export function tracePath(tr) {
  const n = Math.ceil((84 + tr.period - X0) / tr.period);
  const ys = [];
  let peak = 0;
  for (let i = 0; i < tr.samples; i++) peak = Math.max(peak, Math.abs(tr.wave((2 * Math.PI * i) / tr.samples)));
  for (let i = 0; i < tr.samples; i++) {
    ys.push(+(tr.mid - (tr.amp * tr.wave((2 * Math.PI * i) / tr.samples)) / peak).toFixed(1));
  }
  const dx = tr.period / tr.samples;
  // Relative steps between ROUNDED absolutes: one period's steps sum to exactly
  // zero, so the repeated period never drifts and the seam is exact.
  const steps = [];
  for (let i = 1; i <= tr.samples; i++) {
    steps.push(dx, Math.round((ys[i % tr.samples] - ys[i - 1]) * 10) / 10);
  }
  const one = pairs(steps);
  return { d: `M${X0} ${num(ys[0], 1)}l${Array(n).fill(one).join(' ')}`, periods: n, dx, ys };
}

function cubicBezier([x1, y1, x2, y2]) {
  const bx = (t) => 3 * x1 * t * (1 - t) ** 2 + 3 * x2 * t * t * (1 - t) + t ** 3;
  const by = (t) => 3 * y1 * t * (1 - t) ** 2 + 3 * y2 * t * t * (1 - t) + t ** 3;
  return (x) => {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (bx(mid) < x) lo = mid;
      else hi = mid;
    }
    return by((lo + hi) / 2);
  };
}

/** A track's value at percent p (0..100), as CSS would compute it. */
export function evalTrack(track, p) {
  const k = track.keys;
  const e = cubicBezier(track.ease);
  for (let i = 0; i < k.length - 1; i++) {
    const [p0, v0] = k[i];
    const [p1, v1] = k[i + 1];
    if (p >= p0 && p <= p1) return v0 + (v1 - v0) * e((p - p0) / (p1 - p0));
  }
  return k[k.length - 1][1];
}

const ARC_PER_DEG = (2 * Math.PI * RING_R) / 360;
const unionPcts = () =>
  [...new Set([...TRACKS.min.keys, ...TRACKS.max.keys].map(([p]) => p))].sort((a, b) => a - b);

/**
 * The span arc's dash length. Its keyframes are the union of the min and max
 * keyframes, and min and max never move in the same segment, so the span is a
 * linear function of whichever one is moving and the shared easing keeps the
 * arc's far end glued to the max thumb exactly.
 */
export function evalSpan(p) {
  return (evalTrack(TRACKS.max, p) - evalTrack(TRACKS.min, p)) * ARC_PER_DEG;
}

// ---------------------------------------------------------------- document

const bez = (e) => `cubic-bezier(${e.map((v) => num(v)).join(',')})`;

function css() {
  const kf = (name, track, prop) =>
    `@keyframes ${name}{${track.keys
      .map(([p, v]) => `${p}%{${prop(v)}}`)
      .join('')}}`;
  const rel = (track) => ({ ...track, keys: track.keys.map(([p, v]) => [p, v - track.keys[0][1]]) });
  const rot = (v) => `transform:rotate(${num(v)}deg)`;
  const spanTrack = { ease: EASE_DIAL, keys: unionPcts().map((p) => [p, evalSpan(p)]) };
  return (
    `.m,.x,.l{transform-origin:50px 50px}` +
    // The timing function on the element applies to every keyframe interval.
    `.m,.r{animation:m ${MASTER_S}s ${bez(EASE_DIAL)} infinite}.r{animation-name:r}` +
    `.x{animation:x ${MASTER_S}s ${bez(EASE_DIAL)} infinite}.l{animation:l ${MASTER_S}s ${bez(EASE_LIVE)} infinite}` +
    TRACES.map((t) => `.${t.id}{animation:${t.id} ${num(t.dur, 3)}s linear infinite}`).join('') +
    kf('m', rel(TRACKS.min), rot) +
    kf('x', rel(TRACKS.max), rot) +
    kf('l', rel(TRACKS.live), rot) +
    kf('r', spanTrack, (v) => `stroke-dasharray:${num(v)} 300`) +
    TRACES.map((t) => `@keyframes ${t.id}{to{transform:translateX(-${num(t.period)}px)}}`).join('') +
    `@media(prefers-reduced-motion:reduce){*{animation:none!important}}`
  );
}

/**
 * The whole document. With `t` null it is the animated logo (static pose in the
 * attributes, motion in CSS); with a number it is the frozen frame at t
 * seconds, no CSS. `loopEnd` makes t = MASTER_S read as the END of every
 * iteration (scroll at one full period, keyframes at 100%) rather than wrapping
 * to 0, so comparing it with t = 0 actually tests the seam.
 */
export function buildSvg({ t = null, mark = false } = {}) {
  const frame = t !== null;
  const pct = frame ? (t >= MASTER_S ? 100 : ((t % MASTER_S) / MASTER_S) * 100) : 0;
  const phase = (dur) => (t >= MASTER_S ? 1 : (t % dur) / dur);
  const m0 = TRACKS.min.keys[0][1];
  const x0 = TRACKS.max.keys[0][1];
  const l0 = TRACKS.live.keys[0][1];
  const anim = (cls, delta) =>
    frame ? (Math.abs(delta) > 1e-9 ? ` transform="rotate(${num(delta, 3)} 50 50)"` : '') : ` class="${cls}"`;
  const dM = frame ? evalTrack(TRACKS.min, pct) - m0 : 0;
  const dX = frame ? evalTrack(TRACKS.max, pct) - x0 : 0;
  const dL = frame ? evalTrack(TRACKS.live, pct) - l0 : 0;
  const span = frame ? evalSpan(pct) : evalSpan(0);

  let minor = '';
  for (let i = 0; i < MINOR_TICKS; i++) minor += line(TICK_IN, TICK_OUT, START_DEG + (SWEEP_DEG * i) / (MINOR_TICKS - 1));
  let major = '';
  for (let i = 0; i < 5; i++) major += line(TICK_MAJOR_IN, TICK_MAJOR_OUT, START_DEG + (SWEEP_DEG * i) / 4);

  const grid = [19, 34.5, 50, 65.5, 81].map((x) => `M${x} 19V81`).join('') + [34.5, 50, 65.5].map((y) => `M19 ${y}H81`).join('');

  const traces = (mark ? TRACES.slice(0, 1) : TRACES)
    .map((tr) => {
      const { d } = tracePath(tr);
      const move = frame ? ` transform="translate(${num(-tr.period * phase(tr.dur), 3)} 0)"` : ` class="${tr.id}"`;
      const glow = mark ? '' : `<use href="#p${tr.id}" stroke-width="${num(tr.width * 2.8)}" opacity=".25"/>`;
      return `<g stroke="${tr.colour}" stroke-width="${num(tr.width)}"${move}>${glow}<path id="p${tr.id}" d="${d}"/></g>`;
    })
    .join('');

  // Full circle from the top, clockwise; the dash IS the span.
  const arc = `M50 14A36 36 0 1 1 50 86A36 36 0 1 1 50 14`;
  const dash = num(span);

  const body =
    `<path d="M0 0H100V100H0z" fill="${C.backdrop}"/>` +
    `<g fill="none" stroke-linecap="round">` +
    (mark ? '' : `<path d="${minor}" stroke="${C.tick}"/>`) +
    `<path d="${major}" stroke="${C.tickMajor}" stroke-width="1.8"/>` +
    `<g transform="rotate(${m0} 50 50)"><g${anim('m', dM)}><path${frame || mark ? '' : ' class="r"'} d="${arc}" stroke="${C.pointer}" stroke-opacity=".5" stroke-width="11" stroke-linecap="butt" stroke-dasharray="${dash} 300"/></g></g>` +
    `<circle cx="50" cy="50" r="36" stroke="${C.ring}" stroke-width="2.5"/>` +
    `</g>` +
    `<circle cx="50" cy="50" r="31" fill="${C.scopeBg}"/>` +
    `<g clip-path="url(#f)" fill="none" stroke-linejoin="round" stroke-linecap="round">` +
    (mark ? '' : `<path d="${grid}" stroke="${C.scopeGrid}" stroke-width=".5"/>`) +
    traces +
    `</g>` +
    `<circle cx="50" cy="50" r="31" fill="url(#v)" stroke="rgba(0,0,0,.35)" stroke-width=".75"/>` +
    // Glass: a faint sheen over the top half of the screen.
    `<ellipse cx="50" cy="34" rx="27" ry="16" fill="url(#g)"/>` +
    `<g fill="none" stroke-linecap="round">` +
    `<g transform="rotate(${m0} 50 50)"><g${anim('m', dM)}><path d="M50 42.9V23.9" stroke="rgba(0,0,0,.45)" stroke-width="6.2"/><path d="M50 42V23" stroke="${C.pointer}" stroke-width="5.2"/></g></g>` +
    `<circle cx="50" cy="50" r="${HUB_R}" stroke="${C.hub}"/>` +
    `<g transform="rotate(${l0} 50 50)"><path${anim('l', dL)} d="M50 50V14" stroke="${C.live}" stroke-width="1.1"/></g>` +
    `<g transform="rotate(${x0} 50 50)"><g${anim('x', dX)}><path d="M50 9V19" stroke="rgba(0,0,0,.35)" stroke-width="5.2"/><path d="M50 9V19" stroke="${C.accent}" stroke-width="4.4"/></g></g>` +
    `</g>`;

  const defs =
    `<defs><clipPath id="f"><circle cx="50" cy="50" r="31"/></clipPath>` +
    `<radialGradient id="v"><stop offset=".62" stop-opacity="0"/><stop offset="1" stop-opacity=".55"/></radialGradient>` +
    `<linearGradient id="g" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".07"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>`;
  const style = frame || mark ? '' : `<style>${css()}</style>`;
  const size = mark ? 64 : 256;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}" role="img" aria-label="Ambi4">` +
    `<title>Ambi4</title>${style}${defs}${body}</svg>\n`
  );
}

export function frameSvg(t) {
  return buildSvg({ t });
}

/**
 * Social card, 1200x630: the static pose (frame 0) centred on the rough's
 * background. Static SVG; rasterise it to PNG with any SVG renderer, e.g.
 * @resvg/resvg-js (deliberately not a dependency of this repo).
 */
export function cardSvg() {
  const dial = frameSvg(0).trim().replace(/width="\d+" height="\d+"/, 'x="345" y="30" width="510" height="570"');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630" role="img" aria-label="Ambi4">` +
    `<rect width="1200" height="630" fill="${C.backdrop}"/>${dial}</svg>\n`
  );
}

// ---------------------------------------------------------------- CLI

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const out = join(root, 'public', 'logo');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'ambi4-logo.svg'), buildSvg());
  writeFileSync(join(out, 'ambi4-mark.svg'), buildSvg({ mark: true }));
  writeFileSync(join(out, 'ambi4-card.svg'), cardSvg());
  const frames = process.argv.indexOf('--frames');
  if (frames > 0) {
    const dir = process.argv[frames + 1];
    mkdirSync(dir, { recursive: true });
    for (const f of (process.argv[frames + 2] || '0,3,6,9,12').split(',')) {
      writeFileSync(join(dir, `frame-${f}.svg`), frameSvg(+f));
    }
  }
  console.log('wrote public/logo/ambi4-logo.svg, ambi4-mark.svg and ambi4-card.svg');
}
