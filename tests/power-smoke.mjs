/**
 * Smoke test for src/scripts/power.js — run with:
 *   node tests/power-smoke.mjs
 *
 * Mocks PressureObserver, requestAnimationFrame, navigator (hardwareConcurrency
 * / deviceMemory / getBattery), document (hidden/visibilitychange), setTimeout/
 * clearTimeout and Date.now (a manual fake clock — advance-to-timestamp,
 * firing due timers in order) to drive createGovernor() deterministically:
 * bare-node import safety, the tier budget table, static-prior tier selection,
 * pressure-driven lowering + hysteresis, sustained-headroom-driven raising
 * (one step, gated by both a streak and the hysteresis window), battery-bias,
 * hidden-tab cadence, feature-absence paths, and destroy() cleanup.
 */

import assert from 'node:assert/strict';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// --------------------------------------------------------------------------
// Fake clock: overrides global setTimeout/clearTimeout/Date.now.
// --------------------------------------------------------------------------

function installFakeClock(startNow = 0) {
  let now = startNow;
  let nextId = 1;
  const timers = new Map(); // id -> { at, fn }
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const realDateNow = Date.now;

  globalThis.setTimeout = (fn, delay = 0) => {
    const id = nextId++;
    timers.set(id, { at: now + Math.max(0, delay), fn });
    return id;
  };
  globalThis.clearTimeout = (id) => {
    timers.delete(id);
  };
  Date.now = () => now;

  return {
    now: () => now,
    pendingCount: () => timers.size,
    // Fires every timer due at or before `target`, in `at` order, advancing
    // `now` to each fire time before invoking it (so Date.now() inside the
    // callback reads the moment it actually "fires").
    advanceTo(target) {
      for (;;) {
        let dueId = null;
        let dueAt = Infinity;
        for (const [id, t] of timers) {
          if (t.at <= target && t.at < dueAt) {
            dueAt = t.at;
            dueId = id;
          }
        }
        if (dueId === null) break;
        const entry = timers.get(dueId);
        timers.delete(dueId);
        now = dueAt;
        entry.fn();
      }
      now = target;
    },
    restore() {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
      Date.now = realDateNow;
    },
  };
}

// --------------------------------------------------------------------------
// Fake rAF: manual, two-call-per-measurement stepping (id1 registers id2).
// --------------------------------------------------------------------------

function installFakeRaf() {
  const cbs = new Map();
  let nextId = 1;
  const hadRaf = 'requestAnimationFrame' in globalThis;
  const hadCaf = 'cancelAnimationFrame' in globalThis;
  const realRaf = globalThis.requestAnimationFrame;
  const realCaf = globalThis.cancelAnimationFrame;

  globalThis.requestAnimationFrame = (cb) => {
    const id = nextId++;
    cbs.set(id, cb);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => {
    cbs.delete(id);
  };

  return {
    pendingCount: () => cbs.size,
    stepFrame(ts) {
      const pending = [...cbs.entries()];
      cbs.clear();
      for (const [, cb] of pending) cb(ts);
    },
    restore() {
      if (hadRaf) globalThis.requestAnimationFrame = realRaf;
      else delete globalThis.requestAnimationFrame;
      if (hadCaf) globalThis.cancelAnimationFrame = realCaf;
      else delete globalThis.cancelAnimationFrame;
    },
  };
}

/** One periodic eval tick: fire the due timer, then complete its rAF measurement. */
function tick(clock, raf, targetNow, frameDeltaMs) {
  clock.advanceTo(targetNow);
  if (raf.pendingCount() > 0) {
    raf.stepFrame(0);
    raf.stepFrame(frameDeltaMs);
  }
}

function installFakeNavigator({ hardwareConcurrency, deviceMemory, getBattery } = {}) {
  const had = 'navigator' in globalThis;
  const real = globalThis.navigator;
  globalThis.navigator = { hardwareConcurrency, deviceMemory, getBattery };
  return () => {
    if (had) globalThis.navigator = real;
    else delete globalThis.navigator;
  };
}

function makeMockBattery(chargingInitially) {
  const listeners = new Set();
  return {
    charging: chargingInitially,
    addEventListener(type, fn) {
      if (type === 'chargingchange') listeners.add(fn);
    },
    removeEventListener(type, fn) {
      if (type === 'chargingchange') listeners.delete(fn);
    },
    listenerCount: () => listeners.size,
    setCharging(v) {
      this.charging = v;
      for (const fn of listeners) fn();
    },
  };
}

function installMockPressureObserver() {
  const had = 'PressureObserver' in globalThis;
  const real = globalThis.PressureObserver;
  const instances = [];
  class MockPressureObserver {
    constructor(cb) {
      this.cb = cb;
      this.observedSource = null;
      this.disconnected = false;
      instances.push(this);
    }
    observe(source) {
      this.observedSource = source;
      return Promise.resolve();
    }
    disconnect() {
      this.disconnected = true;
    }
  }
  globalThis.PressureObserver = MockPressureObserver;
  return {
    instances,
    latest: () => instances[instances.length - 1],
    restore() {
      if (had) globalThis.PressureObserver = real;
      else delete globalThis.PressureObserver;
    },
  };
}

function installMockDocument(hidden = false) {
  const had = 'document' in globalThis;
  const real = globalThis.document;
  const listeners = new Set();
  globalThis.document = {
    hidden,
    addEventListener(type, fn) {
      if (type === 'visibilitychange') listeners.add(fn);
    },
    removeEventListener(type, fn) {
      if (type === 'visibilitychange') listeners.delete(fn);
    },
  };
  return {
    listenerCount: () => listeners.size,
    setHidden(v) {
      globalThis.document.hidden = v;
      for (const fn of listeners) fn();
    },
    restore() {
      if (had) globalThis.document = real;
      else delete globalThis.document;
    },
  };
}

// --------------------------------------------------------------------------
// Bare-node import.
// --------------------------------------------------------------------------

let power;

test('imports cleanly in bare Node (no document/navigator/PressureObserver/rAF) and cleans up its own timer', async () => {
  assert.equal(typeof globalThis.document, 'undefined');
  assert.equal(typeof globalThis.navigator, 'undefined');
  assert.equal(typeof globalThis.PressureObserver, 'undefined');
  assert.equal(typeof globalThis.requestAnimationFrame, 'undefined');

  power = await import('../src/scripts/power.js');
  assert.equal(typeof power.createGovernor, 'function');
  assert.equal(typeof power.default, 'function');
  assert.deepEqual(power.TIER_ORDER, ['eco', 'low', 'med', 'full']);

  const scheduled = [];
  const cleared = [];
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, delay) => {
    const id = realSetTimeout(fn, delay);
    scheduled.push(id);
    return id;
  };
  globalThis.clearTimeout = (id) => {
    cleared.push(id);
    realClearTimeout(id);
  };

  const g = power.createGovernor();
  assert.equal(g.getTier(), 'auto');
  assert.ok(power.TIER_ORDER.includes(g.getAuto()));
  const s = g.stats();
  assert.equal(s.mode, 'auto');
  assert.equal(s.tier, g.getAuto());

  g.destroy();
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;

  assert.equal(scheduled.length, 1, 'exactly one periodic timer was scheduled');
  assert.deepEqual(cleared, scheduled, 'destroy() cleared it — no leaked real timer');

  // Calls after destroy() are inert, not throws.
  g.setTier('full');
  assert.equal(g.getTier(), 'auto', 'setTier() after destroy is a no-op');
});

// --------------------------------------------------------------------------
// Tier budget table (manual mode).
// --------------------------------------------------------------------------

test('setTier(tier) applies the documented budget table and feature-detects engine.setPowerBudget', () => {
  for (const tier of power.TIER_ORDER) {
    const calls = [];
    const engine = { setPowerBudget: (b) => calls.push(b) };
    const changes = [];
    const g = power.createGovernor({ engine, onTierChange: (b) => changes.push(b) });

    g.setTier(tier);

    assert.equal(g.getTier(), tier);
    assert.equal(g.getAuto(), null, 'manual mode → getAuto() is null');

    const expected = power.TIER_BUDGETS[tier];
    const last = changes[changes.length - 1];
    assert.equal(last.tier, tier);
    assert.equal(last.maxNotes, expected.maxNotes);
    assert.equal(last.visualFps, expected.visualFps);
    assert.equal(last.scopeEnabled, expected.scopeEnabled);
    assert.equal(last.reverbSeconds, expected.reverbSeconds);
    assert.equal(last.textureDensityScale, expected.textureDensityScale);

    const lastCall = calls[calls.length - 1];
    assert.equal(lastCall.maxNotes, expected.maxNotes);

    g.destroy();
  }
});

test('setTier() is silent (no error) with an engine lacking setPowerBudget, and with no engine/onTierChange at all', () => {
  const g1 = power.createGovernor({ engine: {} });
  g1.setTier('low');
  g1.destroy();

  const g2 = power.createGovernor({});
  g2.setTier('low');
  g2.destroy();
});

test('re-selecting the same manual tier does not re-emit onTierChange', () => {
  const changes = [];
  const g = power.createGovernor({ onTierChange: (b) => changes.push(b) });
  g.setTier('med');
  const countAfterFirst = changes.length;
  g.setTier('med');
  assert.equal(changes.length, countAfterFirst, 'no duplicate emit for an unchanged tier');
  g.destroy();
});

// --------------------------------------------------------------------------
// Static priors pick the starting auto tier.
// --------------------------------------------------------------------------

test('static hardwareConcurrency/deviceMemory priors pick the starting auto tier', () => {
  const cases = [
    [{ hardwareConcurrency: 1, deviceMemory: 1 }, 'eco'],
    [{ hardwareConcurrency: 3, deviceMemory: 16 }, 'low'],
    [{ hardwareConcurrency: 6, deviceMemory: 16 }, 'med'],
    [{ hardwareConcurrency: 16, deviceMemory: 16 }, 'full'],
  ];
  for (const [nav, expectedTier] of cases) {
    const restoreNav = installFakeNavigator(nav);
    const changes = [];
    const g = power.createGovernor({ onTierChange: (b) => changes.push(b) });
    assert.equal(g.getAuto(), expectedTier, JSON.stringify(nav));
    assert.equal(changes[0].tier, expectedTier);
    g.destroy();
    restoreNav();
  }
});

// --------------------------------------------------------------------------
// Auto lowers on synthetic PressureObserver pressure, with hysteresis.
// --------------------------------------------------------------------------

test('auto: PressureObserver serious/critical lowers the tier immediately, one step, gated by 10s hysteresis', () => {
  const restoreNav = installFakeNavigator({ hardwareConcurrency: 16, deviceMemory: 16 }); // starts 'full'
  const pressure = installMockPressureObserver();
  const clock = installFakeClock(0);
  // rAF is mocked but deliberately never stepped in this test: the periodic
  // eval's frame measurement then just sits pending forever, so it cannot
  // itself decide anything — every tier change below is attributable solely
  // to the PressureObserver-driven immediate path being exercised.
  const raf = installFakeRaf();
  const changes = [];
  const g = power.createGovernor({ onTierChange: (b) => changes.push(b) });

  const obs = pressure.latest();
  assert.equal(obs.observedSource, 'cpu');
  assert.equal(g.getAuto(), 'full');

  // Within the hysteresis window of the initial apply (t=0): no drop yet.
  obs.cb([{ state: 'critical' }]);
  assert.equal(g.getAuto(), 'full', 'still within hysteresis of the initial application');
  obs.cb([{ state: 'nominal' }]); // clear it back down before the window elapses

  // Past the window: a critical reading drops the tier right away — no need
  // to wait for the next periodic tick — exactly one step, not straight to eco.
  clock.advanceTo(10_000);
  obs.cb([{ state: 'critical' }]);
  assert.equal(g.getAuto(), 'med');
  const changesAfterFirstDrop = changes.length;

  // A second critical event moments later must not drop again.
  obs.cb([{ state: 'critical' }]);
  assert.equal(g.getAuto(), 'med', 'hysteresis blocks a second drop inside the window');
  assert.equal(changes.length, changesAfterFirstDrop, 'no extra emit while blocked');

  // Once the window has passed again, it can drop one more step.
  clock.advanceTo(20_000);
  obs.cb([{ state: 'serious' }]);
  assert.equal(g.getAuto(), 'low');

  g.destroy();
  raf.restore();
  clock.restore();
  pressure.restore();
  restoreNav();
});

test('setTier(concrete) tears down the PressureObserver; re-entering auto reattaches a fresh one', () => {
  const pressure = installMockPressureObserver();
  const g = power.createGovernor();
  const first = pressure.latest();
  assert.equal(first.disconnected, false);

  g.setTier('low');
  assert.equal(first.disconnected, true, 'leaving auto disconnects the observer');

  g.setTier('auto');
  const second = pressure.latest();
  assert.notEqual(second, first);
  assert.equal(second.disconnected, false);

  g.destroy();
  pressure.restore();
});

// --------------------------------------------------------------------------
// Auto raises only after sustained headroom (frame-time EMA), hysteresis-gated.
// --------------------------------------------------------------------------

test('auto: sustained good frame times raise the tier exactly one step once past the hysteresis window', () => {
  const restoreNav = installFakeNavigator({ hardwareConcurrency: 1, deviceMemory: 1 }); // starts 'eco'
  const clock = installFakeClock(0);
  const raf = installFakeRaf();
  const changes = [];
  const g = power.createGovernor({ onTierChange: (b) => changes.push(b) });

  assert.equal(g.getAuto(), 'eco');
  const baseline = changes.length;

  // Good (well under the 20ms "good" threshold) ticks every 2s. A single
  // good tick, or even three at <10s total elapsed, must not raise yet.
  tick(clock, raf, 2_000, 8);
  assert.equal(g.getAuto(), 'eco');
  tick(clock, raf, 4_000, 8);
  assert.equal(g.getAuto(), 'eco');
  tick(clock, raf, 6_000, 8);
  assert.equal(g.getAuto(), 'eco', 'streak satisfied but hysteresis window (10s) has not elapsed');
  assert.equal(changes.length, baseline, 'no emit yet');

  tick(clock, raf, 8_000, 8);
  assert.equal(g.getAuto(), 'eco');

  // At 10s total elapsed since the last change, both the streak and the
  // hysteresis window are satisfied — raises exactly one step.
  tick(clock, raf, 10_000, 8);
  assert.equal(g.getAuto(), 'low');
  assert.equal(changes.length, baseline + 1, 'exactly one raise emitted');

  // Immediately after, more good ticks must not raise a second step inside
  // the new hysteresis window.
  tick(clock, raf, 12_000, 8);
  assert.equal(g.getAuto(), 'low', 'one step at a time');

  g.destroy();
  raf.restore();
  clock.restore();
  restoreNav();
});

test('auto: a bad frame-time reading lowers the tier even without PressureObserver support', () => {
  const restoreNav = installFakeNavigator({ hardwareConcurrency: 16, deviceMemory: 16 }); // starts 'full'
  assert.equal(typeof globalThis.PressureObserver, 'undefined');
  const clock = installFakeClock(0);
  const raf = installFakeRaf();
  const g = power.createGovernor();

  assert.equal(g.getAuto(), 'full');
  // Clear the initial-apply hysteresis window with harmless good ticks first
  // (every boundary consumed via tick(), so nothing is left pending/stale).
  for (let t = 2_000; t <= 8_000; t += 2_000) tick(clock, raf, t, 8);
  assert.equal(g.getAuto(), 'full');

  // A dramatic stall (~5fps): the EMA is smoothed (alpha 0.3), so a single
  // mild bad sample wouldn't cross the threshold from a good baseline — this
  // one does, in one tick, same as a real dropped-frames stutter would.
  tick(clock, raf, 10_000, 200);
  assert.equal(g.getAuto(), 'med');

  g.destroy();
  raf.restore();
  clock.restore();
  restoreNav();
});

// --------------------------------------------------------------------------
// Battery discharging bias blocks raising until it recovers.
// --------------------------------------------------------------------------

/**
 * Battery watching is the only async seam in the module (getBattery() is a
 * promise) — poll a handful of real microtask turns for it to settle. Faked
 * timers don't touch microtask scheduling, so plain awaits are enough.
 */
async function waitFor(predicate, maxTurns = 20) {
  for (let i = 0; i < maxTurns; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('waitFor: condition never became true');
}

test('auto: a discharging battery blocks raising; recovers once it stops discharging', async () => {
  const battery = makeMockBattery(false); // charging: false → discharging
  const restoreNav = installFakeNavigator({
    hardwareConcurrency: 1,
    deviceMemory: 1,
    getBattery: () => Promise.resolve(battery),
  });
  const clock = installFakeClock(0);
  const raf = installFakeRaf();
  const g = power.createGovernor();
  assert.equal(g.getAuto(), 'eco');

  await waitFor(() => battery.listenerCount() === 1);

  for (let t = 2_000; t <= 12_000; t += 2_000) tick(clock, raf, t, 8);
  assert.equal(g.getAuto(), 'eco', 'discharging battery blocks the raise despite good frames');

  battery.setCharging(true);
  for (let t = 14_000; t <= 24_000; t += 2_000) tick(clock, raf, t, 8);
  assert.equal(g.getAuto(), 'low', 'raises once the battery is no longer discharging');

  g.destroy();
  assert.equal(battery.listenerCount(), 0, 'destroy() removes the chargingchange listener');
  raf.restore();
  clock.restore();
  restoreNav();
});

// --------------------------------------------------------------------------
// Hidden-tab cadence: no frame sampling while hidden, slow 30s check.
// --------------------------------------------------------------------------

test('auto: hidden tab drops to a 30s eval cadence and skips frame sampling; resumes at 2s when visible', () => {
  const doc = installMockDocument(true); // starts hidden
  const clock = installFakeClock(0);
  const raf = installFakeRaf();
  const g = power.createGovernor();

  assert.equal(doc.listenerCount(), 1, 'visibilitychange listener attached');

  clock.advanceTo(30_000);
  assert.equal(raf.pendingCount(), 0, 'no frame sampling while hidden');
  assert.equal(clock.pendingCount(), 1, 'the slow 30s check rescheduled itself');

  doc.setHidden(false);
  clock.advanceTo(32_000); // 2s after the visibility flip, not 30s
  assert.equal(raf.pendingCount(), 1, 'frame sampling resumes once visible');

  g.destroy();
  assert.equal(doc.listenerCount(), 0, 'destroy() removes the visibilitychange listener');
  raf.restore();
  clock.restore();
  doc.restore();
});

// --------------------------------------------------------------------------
// destroy() cleanup.
// --------------------------------------------------------------------------

test('destroy() clears the pending timer and any in-flight rAF ids, and is idempotent', () => {
  const restoreNav = installFakeNavigator({ hardwareConcurrency: 16, deviceMemory: 16 });
  const clock = installFakeClock(0);
  const raf = installFakeRaf();
  const g = power.createGovernor();

  clock.advanceTo(2_000); // fires the periodic tick → one pending rAF id, one pending timer
  assert.equal(raf.pendingCount(), 1);
  assert.equal(clock.pendingCount(), 1);

  g.destroy();
  assert.equal(raf.pendingCount(), 0, 'in-flight rAF measurement id was cancelled');
  assert.equal(clock.pendingCount(), 0, 'periodic timer was cleared');

  g.destroy(); // idempotent, no throw
  g.setTier('full'); // inert after destroy

  raf.restore();
  clock.restore();
  restoreNav();
});

// --------------------------------------------------------------------------
// Runner
// --------------------------------------------------------------------------

let failures = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}\n     ${error.stack || error.message}`);
  }
}
console.log(`\n${tests.length - failures}/${tests.length} passed`);
process.exit(failures ? 1 : 0);
