#!/usr/bin/env node
/**
 * The animated logo (public/logo/ambi4-logo.svg, built by scripts/build-logo.mjs).
 *
 *   node tests/logo-smoke.mjs
 *
 * Asserts: the committed file is exactly what the generator writes; it parses
 * as SVG; it is small; it carries no script; it honours reduced motion; every
 * animation duration divides the master loop; and the loop point is seamless —
 * every keyframe track ends where it starts, each scope trace scrolls by
 * exactly one of its own periods over a path that really repeats at that
 * period, and the frozen frame at t = 0 equals the frame at the loop end once
 * those whole-period scrolls are accounted for. A pixel comparison of the two
 * frames needs a rasteriser, which is not a dependency of this repo; it was
 * done with @resvg/resvg-js outside it when the logo was built.
 */
import { readFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import {
  buildSvg, frameSvg, cardSvg, tracePath, evalTrack, evalSpan, TRACKS, TRACES, MASTER_S,
} from '../scripts/build-logo.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUDGET_GZIP = 6 * 1024; // the owner's ceiling, for logo + favicon together
const BUDGET_RAW = 16 * 1024;

let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) failures++;
};

const svg = readFileSync(join(ROOT, 'public/logo/ambi4-logo.svg'), 'utf8');
const mark = readFileSync(join(ROOT, 'public/logo/ambi4-mark.svg'), 'utf8');
const card = readFileSync(join(ROOT, 'public/logo/ambi4-card.svg'), 'utf8');
check(card === cardSvg(), 'ambi4-card.svg is exactly what scripts/build-logo.mjs writes');
check(existsSync(join(ROOT, 'public/logo/ambi4-card.png')), 'the social card PNG is committed');
const preview = readFileSync(join(ROOT, 'public/logo/preview.html'), 'utf8');
for (const px of [512, 128, 32]) {
  check(preview.includes(`src="ambi4-logo.svg" width="${px}" height="${px}"`), `preview.html shows the logo at ${px} px`);
}

check(svg === buildSvg(), 'ambi4-logo.svg is exactly what scripts/build-logo.mjs writes (rebuild it)');
check(mark === buildSvg({ mark: true }), 'ambi4-mark.svg is exactly what scripts/build-logo.mjs writes');

const { window } = new JSDOM('');
for (const [name, text] of [['logo', svg], ['mark', mark]]) {
  const doc = new window.DOMParser().parseFromString(text, 'image/svg+xml');
  check(
    doc.documentElement.nodeName === 'svg' && !doc.getElementsByTagName('parsererror').length,
    `${name} parses as SVG`,
  );
  check(!/<script|\son\w+=|javascript:/i.test(text), `${name} has no script, handler or javascript: URL`);
  check(/aria-label="Ambi4"/.test(text) && /<title>Ambi4<\/title>/.test(text), `${name} is named "Ambi4"`);
}

const gz = gzipSync(svg, { level: 9 }).length;
const gzMark = gzipSync(mark, { level: 9 }).length;
check(svg.length <= BUDGET_RAW, `raw ${svg.length} B <= ${BUDGET_RAW} B`);
check(gz + gzMark < BUDGET_GZIP, `gzip logo ${gz} B + favicon ${gzMark} B < ${BUDGET_GZIP} B`);
check(!/<image|data:|<video|<foreignObject/i.test(svg + mark + card), 'vector only: no embedded raster, video or HTML');
for (const [name, text] of [['mark', mark], ['card', card]]) {
  check(!/<style|animation/.test(text), `the ${name} is static (no CSS animation)`);
}

check(
  /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)\s*\{\s*\*\s*\{\s*animation\s*:\s*none\s*!important/.test(svg),
  'reduced motion switches every animation off',
);
check(!/<animate|<set\b|requestAnimationFrame/.test(svg), 'motion is CSS animation only (no SMIL, no JS)');

// Every animation duration divides the master loop.
const masterMs = MASTER_S * 1000;
const durations = [...svg.matchAll(/animation:\s*[\w-]+\s+([\d.]+)s/g)].map((m) => +m[1]);
check(durations.length >= 6, `found ${durations.length} animations`);
for (const d of durations) {
  const ms = Math.round(d * 1000);
  check(Math.abs(d * 1000 - ms) < 1e-6 && masterMs % ms === 0, `${d}s divides the ${MASTER_S}s master loop`);
}

// First paint: animated parts carry a class, never a transform of their own,
// so the attributes alone draw the start pose.
check(!/class="[^"]*"[^>]*\stransform=|\stransform="[^"]*"[^>]*class=/.test(svg), 'no animated element has its own transform attribute');

// Keyframed tracks end where they start.
for (const [name, track] of Object.entries(TRACKS)) {
  const k = track.keys;
  check(k[0][0] === 0 && k[k.length - 1][0] === 100 && k[0][1] === k[k.length - 1][1], `${name} track returns to its start pose`);
}
const spans = [...svg.matchAll(/stroke-dasharray:([\d.]+) 300/g)].map((m) => m[1]);
check(spans.length > 2 && spans[0] === spans[spans.length - 1], 'span arc returns to its start length');

// The live pointer stays inside the span, throughout.
let inside = true;
for (let p = 0; p <= 100; p += 0.05) {
  const lo = evalTrack(TRACKS.min, p);
  const hi = evalTrack(TRACKS.max, p);
  const v = evalTrack(TRACKS.live, p);
  if (!(v >= lo + 2 && v <= hi - 2)) inside = false;
}
check(inside, 'live pointer stays inside the min-max span at every instant');
check(Math.abs(evalSpan(50) - (evalTrack(TRACKS.max, 50) - evalTrack(TRACKS.min, 50)) * ((2 * Math.PI * 36) / 360)) < 1e-9, 'arc length is the span');

// Each trace: a path that repeats exactly at its period, covering the face
// (19..81, plus the glow) before AND after scrolling by one period.
for (const tr of TRACES) {
  const { d } = tracePath(tr);
  check(svg.includes(`d="${d}"`), `trace ${tr.id} is in the file`);
  const nums = d.slice(1).split(/l/)[1].match(/-?(?:\d+\.?\d*|\.\d+)/g).map(Number);
  const start = d.match(/^M([\d.]+) ([\d.]+)/);
  let x = +start[1];
  let y = +start[2];
  const pts = [[x, y]];
  for (let i = 0; i < nums.length; i += 2) {
    x += nums[i];
    y += nums[i + 1];
    pts.push([+x.toFixed(6), +y.toFixed(6)]);
  }
  const k = tr.samples; // one period of steps
  let periodic = true;
  for (let i = 0; i + k < pts.length; i++) {
    if (Math.abs(pts[i + k][1] - pts[i][1]) > 1e-6 || Math.abs(pts[i + k][0] - pts[i][0] - tr.period) > 1e-6) periodic = false;
  }
  check(periodic, `trace ${tr.id} repeats exactly every ${tr.period} units`);
  check(pts[0][0] <= 17.5 && pts[pts.length - 1][0] - tr.period >= 82.5, `trace ${tr.id} covers the face before and after one period of scroll`);
  check(svg.includes(`@keyframes ${tr.id}{to{transform:translateX(-${tr.period}px)}}`), `trace ${tr.id} scrolls by exactly one period`);
}

// Frame 0 against the loop end: identical but for whole-period scrolls.
const f0 = frameSvg(0);
const fEnd = frameSvg(MASTER_S);
const norm = (s) => s.replace(/translate\((-?[\d.]+) 0\)/g, 'translate(SCROLL)');
check(norm(f0) === norm(fEnd), 'frame at t=0 equals the frame at the loop end (scroll aside)');
const t0 = [...f0.matchAll(/translate\((-?[\d.]+) 0\)/g)].map((m) => +m[1]);
const tEnd = [...fEnd.matchAll(/translate\((-?[\d.]+) 0\)/g)].map((m) => +m[1]);
check(
  t0.every((v) => v === 0) && tEnd.every((v, i) => Math.abs(v + TRACES[i].period) < 1e-9),
  `loop-end scrolls are whole periods (${tEnd.join(', ')})`,
);
check(frameSvg(6) !== f0, 'mid-loop frame differs (it does move)');

if (failures) {
  console.log(`\nlogo-smoke: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\nlogo-smoke: all green');
