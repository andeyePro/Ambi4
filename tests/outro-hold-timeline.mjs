/**
 * The outro's hold on the output gain, on Firefox's rules — run with:
 *   node tests/outro-hold-timeline.mjs
 *
 * Firefox has no cancelAndHoldAtTime. A ranged master Volume walks once a bar
 * on a 1.5 s exponential ramp, and at a fast tempo that ramp is still running
 * when the closing bar is planned. The v0.0.296 fallback cancelled from the
 * closing bar — which removes that ramp's end, so the gain fell back to the
 * ramp's start AT ONCE — and set a level read NOW at the bar: two steps of the
 * Volume's span (2026-11-06 audit). `holdOutputAt` (the function beginOutro
 * calls) re-ends the running ramp at the closing bar on the same curve.
 *
 * The AudioParam is a rule model: events sorted by time, set / linear /
 * exponential evaluated as the spec draws them, cancelScheduledValues(t)
 * removing every event at or after t, and `.value` the value last RENDERED
 * (a cancel this instant does not change it, as in a browser). The v0.0.296
 * fallback is reproduced here (its code is gone) and must FAIL the same
 * checks, or the model proves nothing.
 *
 * (A whole-engine version of this lived in engine-smoke for v0.0.297 and
 * flaked on when the mock clock reached the closing bar; this one is exact.)
 */
import assert from 'node:assert/strict';
import { holdOutputAt } from '../src/scripts/ambient-engine.js';

const SILENCE = 0.0001;

function param(initial) {
  const ev = [];
  const clock = { now: 0 };
  let frozen = null;
  const at = (t, list = ev) => {
    let v = initial;
    let vt = 0;
    for (const e of list) {
      if (e.t > t) {
        if (e.k === 'lin') return v + (e.v - v) * (t - vt) / (e.t - vt);
        if (e.k === 'exp') return v * Math.pow(e.v / v, (t - vt) / (e.t - vt));
        return v;
      }
      v = e.v;
      vt = e.t;
    }
    return v;
  };
  const push = (e) => { ev.push(e); ev.sort((a, b) => a.t - b.t); };
  return {
    ev, clock, at,
    get value() { return frozen && frozen.t === clock.now ? frozen.v : at(clock.now); },
    setValueAtTime(v, t) { push({ k: 'set', t, v }); },
    linearRampToValueAtTime(v, t) { push({ k: 'lin', t, v }); },
    exponentialRampToValueAtTime(v, t) { assert.ok(v > 0); push({ k: 'exp', t, v }); },
    setTargetAtTime() {},
    cancelScheduledValues(t) {
      if (!(frozen && frozen.t === clock.now)) frozen = { t: clock.now, v: at(clock.now) };
      for (let i = ev.length - 1; i >= 0; i--) if (ev[i].t >= t) ev.splice(i, 1);
    },
  };
}

/** applyLevels as the engine writes it: anchor now, exponential to v1. */
function volumeRamp(g, now, v1, seconds) {
  g.clock.now = now;
  const v0 = Math.max(g.value, SILENCE);
  g.cancelScheduledValues(now);
  g.setValueAtTime(v0, now);
  g.exponentialRampToValueAtTime(v1, now + seconds);
  return { t0: now, v0, t1: now + seconds, v1 };
}

/** The v0.0.296 fallback, reproduced so the model can be shown to catch it. */
function legacyHold(g, time) {
  g.cancelScheduledValues(time);
  g.setValueAtTime(Math.max(g.value, SILENCE), time);
}

/** Largest relative change the hold made over [now, time], and at `time`. */
function measure(hold, { bars }) {
  const g = param(SILENCE);
  let ramp = volumeRamp(g, 0, 0.5, 0.6); // the fade-in
  let now = 1;
  for (const [v1] of bars) { ramp = volumeRamp(g, now, v1, 1.5); now += 1.2; }
  const plannedAt = now - 1.2 + 1.1; // the closing bar is planned 1.1 s into the last ramp…
  const time = plannedAt + 0.1;      // …and lands 0.1 s later
  g.clock.now = plannedAt;
  const before = [...g.ev];
  hold(g, time, ramp);
  let worst = 0;
  for (let k = 0; k <= 40; k++) {
    const t = plannedAt + (time - plannedAt) * (k / 40);
    worst = Math.max(worst, Math.abs(g.at(t) - g.at(t, before)) / g.at(t, before));
  }
  const step = Math.abs(g.at(time + 1e-6) - g.at(time - 1e-6, before)) / g.at(time - 1e-6, before);
  return { worst, step };
}

const CASES = [
  { name: 'a rising Volume walk', bars: [[0.3], [0.6], [0.9]] },
  { name: 'a falling Volume walk', bars: [[0.9], [0.5], [0.2]] },
  { name: 'a steady Volume (no walk)', bars: [[0.5], [0.5]] },
];

let failures = 0;
const report = (ok, name, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n     ${detail}`}`);
};
for (const c of CASES) {
  const now = measure((g, time, ramp) => holdOutputAt(g, time, ramp), c);
  report(now.worst < 1e-6, `${c.name}: the outro changes nothing before the closing bar`, `moved ${(now.worst * 100).toFixed(2)}%`);
  report(now.step < 1e-6, `${c.name}: …and nothing AT it`, `stepped ${(now.step * 100).toFixed(2)}%`);
  if (c.bars.some(([v], i) => i && v !== c.bars[i - 1][0])) {
    const old = measure((g, time) => legacyHold(g, time), c);
    report(old.worst > 0.05 || old.step > 0.05, `${c.name}: the v0.0.296 fallback FAILS the same checks (the model bites)`,
      `old moved ${(old.worst * 100).toFixed(2)}%, stepped ${(old.step * 100).toFixed(2)}%`);
  }
}
{
  // A ramp already finished at the closing bar: held at its end value.
  const g = param(SILENCE);
  const ramp = volumeRamp(g, 0, 0.7, 0.5);
  g.clock.now = 2;
  holdOutputAt(g, 2.1, ramp);
  report(Math.abs(g.at(2.1 + 1e-6) - 0.7) < 1e-9, 'a finished ramp is held at its own end value', `got ${g.at(2.1 + 1e-6)}`);
}
{
  // No known ramp (a resume's decay wrote the level): the value read now.
  const g = param(0.42);
  g.clock.now = 3;
  holdOutputAt(g, 3.1, null);
  report(Math.abs(g.at(3.1 + 1e-6) - 0.42) < 1e-9, 'with no known ramp the level read now is held', `got ${g.at(3.1 + 1e-6)}`);
}
console.log(`\n${failures ? 'FAILED' : 'all green'}: ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
