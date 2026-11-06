/**
 * The reverb swap's automation timeline obeys the Web Audio event rules —
 * with AND without cancelAndHoldAtTime.
 *
 *   node tests/reverb-swap-timeline.mjs
 *
 * Firefox has no cancelAndHoldAtTime, so scheduleReverbSwap falls back to
 * cancelScheduledValues + setValueAtTime. Since v0.0.294 a return fades in on
 * a setValueCurveAtTime curve, and the spec makes any event placed inside a
 * running curve throw NotSupportedError. cancelScheduledValues(time) only
 * removes events that START at or after `time`, so a second Reverb tail change
 * inside the half-second fade-in (two arrow presses, a short drag: the settle
 * wait is 200 ms) threw part-way through swapReverb, after the new return was
 * already wired and fading up — a second reverb tail for the rest of the visit.
 * tests/reverb-swap-render.mjs renders in Chromium, which has
 * cancelAndHoldAtTime, so it never took this path.
 *
 * The AudioParam here is a rule model of each browser: it throws where a
 * browser throws and evaluates the value the timeline gives, so each swap is
 * also checked to hold the outgoing return at the value it HAS — no step.
 * Without cancelAndHoldAtTime it is FIREFOX's rules, measured in Firefox 132
 * (tests/firefox-drive.mjs): cancelScheduledValues cannot remove a value
 * curve that has already started, from any time, so the first fix (cancel
 * from the curve's start) still threw there; the rise is ramps now.
 */
import assert from 'node:assert/strict';
import { scheduleReverbSwap, reverbRiseValue } from '../src/scripts/ambient-engine.js';

const LEVEL = 0.9;

function specParam(initial, { hold }) {
  const ev = [];
  const inCurve = (t) => ev.some((e) => e.kind === 'curve' && t >= e.t && t < e.t + e.d);
  const p = {
    ev,
    now: 0, // the context's currentTime, set by the driver before each swap
    defaultValue: initial,
    setValueAtTime(v, t) {
      if (inCurve(t)) throw new Error(`NotSupportedError: setValueAtTime(${t.toFixed(4)}) inside a curve`);
      ev.push({ kind: 'set', t, v });
      ev.sort((a, b) => a.t - b.t);
    },
    linearRampToValueAtTime(v, t) {
      if (inCurve(t)) throw new Error(`NotSupportedError: linearRamp(${t.toFixed(4)}) inside a curve`);
      ev.push({ kind: 'lin', t, v });
      ev.sort((a, b) => a.t - b.t);
    },
    setValueCurveAtTime(c, t, d) {
      if (inCurve(t) || ev.some((e) => e.t > t && e.t < t + d)) {
        throw new Error(`NotSupportedError: curve at ${t.toFixed(4)} overlaps an event`);
      }
      ev.push({ kind: 'curve', t, d, c: Float32Array.from(c) });
      ev.sort((a, b) => a.t - b.t);
    },
    cancelScheduledValues(t) {
      for (let i = ev.length - 1; i >= 0; i--) {
        if (ev[i].t < t) continue;
        // Firefox: a curve already under way survives any cancel.
        if (!hold && ev[i].kind === 'curve' && ev[i].t <= p.now) continue;
        ev.splice(i, 1);
      }
    },
    /** The value the timeline gives at `t` (set and curve events only). */
    at(t) {
      let v = initial;
      let vt = 0;
      for (const e of ev) {
        if (e.t > t) {
          if (e.kind === 'lin') v += (e.v - v) * (t - vt) / (e.t - vt);
          break;
        }
        vt = e.t;
        if (e.kind === 'set' || e.kind === 'lin') v = e.v;
        else {
          const x = (t - e.t) / e.d;
          if (x >= 1) v = e.c[e.c.length - 1];
          else {
            const k = x * (e.c.length - 1);
            const i = Math.floor(k);
            v = e.c[i] + (e.c[Math.min(i + 1, e.c.length - 1)] - e.c[i]) * (k - i);
          }
        }
      }
      return v;
    },
  };
  if (hold) {
    p.cancelAndHoldAtTime = (t) => {
      const v = p.at(t);
      // Truncate a curve running at t; drop everything after.
      for (let i = ev.length - 1; i >= 0; i--) {
        const e = ev[i];
        if (e.t >= t) ev.splice(i, 1);
        else if (e.kind === 'curve' && t < e.t + e.d) ev.splice(i, 1);
      }
      ev.push({ kind: 'set', t, v });
      ev.sort((a, b) => a.t - b.t);
    };
  }
  return p;
}

/** Drive the engine's swapReverb sequence: a swap every `gap` seconds. */
function burst({ hold, gap, swaps }) {
  let live = specParam(LEVEL, { hold });
  let rise = null;
  const steps = [];
  for (let i = 0; i < swaps; i++) {
    const time = 1 + i * gap;
    const next = specParam(0, { hold });
    live.now = time;
    next.now = time;
    const before = live.at(time);
    const outFrom = reverbRiseValue(rise, time);
    const swap = scheduleReverbSwap(live, next, {
      time, sampleRate: 48000, level: LEVEL, outFrom, oldSeconds: 3,
    });
    steps.push({ time, before, after: live.at(time + 1e-6), outFrom });
    live = next;
    rise = swap.rise;
  }
  return steps;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

for (const hold of [false, true]) {
  const who = hold ? 'with cancelAndHoldAtTime (Chromium, WebKit)' : 'without cancelAndHoldAtTime (Firefox)';
  for (const gap of [0.2, 0.25, 0.4, 0.6, 2]) {
    test(`${who}: swaps ${gap * 1000} ms apart schedule without throwing`, () => {
      assert.doesNotThrow(() => burst({ hold, gap, swaps: 6 }));
    });
    test(`${who}: swaps ${gap * 1000} ms apart hold the outgoing return at the value it has`, () => {
      for (const s of burst({ hold, gap, swaps: 6 })) {
        assert.ok(Math.abs(s.after - s.before) < 0.02,
          `swap at ${s.time}s stepped the outgoing return ${s.before.toFixed(3)} → ${s.after.toFixed(3)}`);
      }
    });
  }
}

let failures = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}\n     ${e.message}`);
  }
}
console.log(`\n${tests.length - failures}/${tests.length} passed`);
process.exit(failures ? 1 : 0);
