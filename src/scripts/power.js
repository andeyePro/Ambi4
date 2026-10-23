/**
 * power.js — v9/v14 power/thermal governor for the ambient generator.
 *
 * Pure JS, no imports, import-safe in bare node (nothing touches the DOM,
 * `navigator`, or any observer API until createGovernor() is called, and
 * every sensor inside that is feature-detected with a graceful absence
 * path). Owns quality-tier budgets and the 'auto' sensing heuristic; does
 * NOT touch the DOM itself — the page applies the emitted budget.
 *
 * ---------------------------------------------------------------------
 * Tier budget table (the contract other modules should treat as fixed):
 *
 *   tier   maxNotes  visualFps  scopeEnabled  reverbSeconds  textureDensityScale  maxConnections
 *   eco    8         15         false         1              0.5                  4
 *   low    14        24         true          2              0.75                 8
 *   med    22        30         true          4              1                    16
 *   full   Infinity  30         true          4              1                    32
 *
 * - maxNotes: engine.setPowerBudget({maxNotes}) — the only field the
 *   engine itself currently consumes (voice-steal oldest/quietest).
 * - visualFps / scopeEnabled / textureDensityScale: for the visualiser /
 *   scope / texture+arp density — the page applies these from onTierChange.
 * - maxConnections (dial-control-plane-plan D10): how many ACTIVE modulation
 *   connections (the engine's params.routing edges — lfo.1 / macro.1 into a
 *   dial) the tier is budgeted for. The governor never refuses an edge and
 *   never moves the tier because of one — the edges are the person's own
 *   choice — it only says so: setConnections(n) records the count, and the
 *   emitted budget carries `connections` and `connectionsOver` (n > the
 *   current tier's maxConnections) for the page to put into words. The
 *   numbers are a forward budget, NOT a measurement: today an edge costs a
 *   little arithmetic once a bar; the plan expects a node per connection
 *   once sources run at audio rate, and that is what the budget is sized for.
 * - reverbSeconds: budget field only. The engine has no reverb-length hook
 *   yet (v9 addendum flags this); the governor exposes the number anyway
 *   so a page/engine that grows one later needs no governor change —
 *   consumers must feature-detect before calling into the engine with it.
 *
 * ---------------------------------------------------------------------
 * 'auto' heuristic:
 *
 * - Static priors (hardwareConcurrency / deviceMemory): pick the STARTING
 *   tier the first time auto sensing begins (no history yet to prefer).
 * - PressureObserver('cpu'), feature-detected: 'serious'/'critical' states
 *   react IMMEDIATELY (not waiting for the periodic tick) by stepping the
 *   tier down one notch, subject to the hysteresis window below.
 * - rAF frame-time EMA: a lightweight sampler that takes at most one
 *   two-frame measurement window per periodic tick (≤1 per 2 s), smoothed
 *   with an EMA. Feeds a periodic decision (every 2 s while visible, every
 *   30 s while hidden — and the sampler itself does not run while hidden):
 *   a bad frame-time (or 'serious'/'critical' pressure still current) steps
 *   the tier down one notch; a GOOD reading increments a "sustained
 *   headroom" streak, and only once that streak has run for
 *   RAISE_STREAK_TICKS consecutive good ticks does the tier step up one
 *   notch — a single good sample never raises the tier on its own.
 * - getBattery() discharging, feature-detected: while discharging, a
 *   periodic tick can never count as "good" (blocks raising; does not by
 *   itself force a lower step).
 * - Hysteresis: whichever path (pressure-immediate or periodic) proposes a
 *   step, it is only applied if at least HYSTERESIS_MS has passed since the
 *   last tier change, and it is always exactly one tier at a time.
 *
 * RANGE (v0.0.249 — the Processor dial's span): sensing moves the tier only
 * INSIDE a declared [min, max] of TIER_ORDER. 'auto' IS the full range
 * eco..full, so the old behaviour is the default and is unchanged; a range
 * of one tier ('low', or 'low-low') pins it exactly as a manual tier always
 * did, with no sensing at all. A narrower span ('low-med') senses, but every
 * step — pressure, frame time, headroom — stops at its ends, and the
 * starting tier (the static prior, or the tier already applied) is clamped
 * into it. The spec is a string so it persists anywhere a tier name did:
 * 'auto' | <tier> | '<min>-<max>' (see parseTierSpec / tierSpec).
 *
 * ---------------------------------------------------------------------
 * Integration sketch (page agent, next wave — not wired here):
 *
 *   import { createGovernor } from './power.js';
 *   const governor = createGovernor({
 *     engine,
 *     onTierChange(budget) {
 *       // budget = { tier, maxNotes, visualFps, scopeEnabled,
 *       //            reverbSeconds, textureDensityScale }
 *       visualiser.setFps?.(budget.visualFps);
 *       scope.setEnabled?.(budget.scopeEnabled);
 *       texture.setDensityScale?.(budget.textureDensityScale);
 *       // reverbSeconds: only call an engine reverb-length hook once one
 *       // exists — feature-detect it, this budget field is forward-looking.
 *     },
 *   });
 *   processorDial.onInput = (spec) => governor.setTier(spec); // auto | eco | 'low-med' …
 *   processorDial.set(governor.getTier());                    // restore on load
 *   // live readout while in auto: governor.getAuto() / governor.stats()
 *   // teardown: governor.destroy();
 */

export const TIER_ORDER = Object.freeze(['eco', 'low', 'med', 'full']);

export const TIER_BUDGETS = Object.freeze({
  eco: Object.freeze({ maxNotes: 8, visualFps: 15, scopeEnabled: false, reverbSeconds: 1, textureDensityScale: 0.5, maxConnections: 4 }),
  low: Object.freeze({ maxNotes: 14, visualFps: 24, scopeEnabled: true, reverbSeconds: 2, textureDensityScale: 0.75, maxConnections: 8 }),
  med: Object.freeze({ maxNotes: 22, visualFps: 30, scopeEnabled: true, reverbSeconds: 4, textureDensityScale: 1, maxConnections: 16 }),
  full: Object.freeze({ maxNotes: Infinity, visualFps: 30, scopeEnabled: true, reverbSeconds: 4, textureDensityScale: 1, maxConnections: 32 }),
});

/**
 * The governor's whole input as one string: 'auto' (eco..full), a single tier
 * (a pin), or '<min>-<max>' (a span). Returns { min, max } tier names, or null
 * for anything else — never a guess, so a corrupt stored value falls back to
 * whatever the caller's default is rather than to an arbitrary tier.
 */
export function parseTierSpec(spec) {
  if (spec === 'auto') return { min: TIER_ORDER[0], max: TIER_ORDER[TIER_ORDER.length - 1] };
  if (typeof spec !== 'string') return null;
  if (TIER_ORDER.includes(spec)) return { min: spec, max: spec };
  const m = /^([a-z]+)-([a-z]+)$/.exec(spec);
  if (!m || !TIER_ORDER.includes(m[1]) || !TIER_ORDER.includes(m[2])) return null;
  const a = TIER_ORDER.indexOf(m[1]);
  const b = TIER_ORDER.indexOf(m[2]);
  return { min: TIER_ORDER[Math.min(a, b)], max: TIER_ORDER[Math.max(a, b)] };
}

/** The canonical spec for a [min, max] of tiers: the full range is 'auto', a
 * collapsed one is the bare tier, anything else '<min>-<max>'. */
export function tierSpec(min, max) {
  const a = TIER_ORDER.indexOf(min);
  const b = TIER_ORDER.indexOf(max);
  if (a < 0 || b < 0) return null;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  if (lo === hi) return TIER_ORDER[lo];
  if (lo === 0 && hi === TIER_ORDER.length - 1) return 'auto';
  return `${TIER_ORDER[lo]}-${TIER_ORDER[hi]}`;
}

const VISIBLE_EVAL_MS = 2000;
const HIDDEN_EVAL_MS = 30000;
const HYSTERESIS_MS = 10000;
const RAISE_STREAK_TICKS = 3;
const FRAME_EMA_ALPHA = 0.3;
const BAD_FRAME_MS = 40; // ~<25 fps
const GOOD_FRAME_MS = 20; // ~>50 fps
const PRESSURE_BAD = new Set(['serious', 'critical']);

function safeNav(prop) {
  try {
    return typeof navigator !== 'undefined' ? navigator[prop] : undefined;
  } catch {
    return undefined;
  }
}

function isHiddenDoc() {
  try {
    return typeof document !== 'undefined' && !!document.hidden;
  } catch {
    return false;
  }
}

/** Starting auto tier when there is no sensing history yet. */
function staticPriorTier() {
  const hc = safeNav('hardwareConcurrency');
  const mem = safeNav('deviceMemory');
  const hcVal = Number.isFinite(hc) ? hc : 4;
  const memVal = Number.isFinite(mem) ? mem : 4;
  if (hcVal <= 2 || memVal <= 2) return 'eco';
  if (hcVal <= 4 || memVal <= 4) return 'low';
  if (hcVal <= 8 || memVal <= 8) return 'med';
  return 'full';
}

/**
 * createGovernor({ engine, onTierChange }) → { setTier, setRange, getTier,
 * getRange, getAuto, setConnections, connectionStatus, stats, destroy }. See file header for the tier table and auto heuristic.
 */
export function createGovernor({ engine, onTierChange } = {}) {
  let destroyed = false;
  let requestedTier = null; // canonical spec: 'auto' | tier | '<min>-<max>'
  let rangeLo = 0; // TIER_ORDER index bounds the tier may move inside
  let rangeHi = TIER_ORDER.length - 1;
  let connections = 0; // active modulation edges, as last reported by the page
  let currentTier = null; // 'eco'|'low'|'med'|'full' — currently applied
  let lastChangeAt = 0;

  let sensing = false;
  let evalTimer = null;
  const rafIds = new Set();

  let pressureObserver = null;
  let pressureState = 'nominal';

  let batteryObj = null;
  let onBatteryChange = null;
  let batteryDischarging = false;

  let visListenerAttached = false;

  let frameEma = null;
  let headroomStreak = 0;

  function budgetFor(tier) {
    return {
      ...TIER_BUDGETS[tier],
      tier,
      connections,
      connectionsOver: connections > TIER_BUDGETS[tier].maxConnections,
    };
  }

  function emit() {
    const budget = budgetFor(currentTier);
    if (engine && typeof engine.setPowerBudget === 'function') {
      try {
        engine.setPowerBudget({ maxNotes: budget.maxNotes });
      } catch {
        // engine misbehaving must not break the governor
      }
    }
    if (typeof onTierChange === 'function') {
      try {
        onTierChange(budget);
      } catch {
        // consumer misbehaving must not break the governor
      }
    }
  }

  function applyTier(tier) {
    if (tier === currentTier) return false;
    currentTier = tier;
    lastChangeAt = Date.now();
    emit();
    return true;
  }

  function hysteresisOk() {
    return Date.now() - lastChangeAt >= HYSTERESIS_MS;
  }

  /** Only ever inside the declared range — sensing cannot leave [min, max]. */
  function stepTier(direction) {
    const idx = TIER_ORDER.indexOf(currentTier);
    const nextIdx = Math.max(rangeLo, Math.min(rangeHi, idx + direction));
    if (nextIdx === idx) return false;
    return applyTier(TIER_ORDER[nextIdx]);
  }

  function isBadSignal() {
    if (PRESSURE_BAD.has(pressureState)) return true;
    if (frameEma != null && frameEma >= BAD_FRAME_MS) return true;
    return false;
  }

  function isGoodSignal() {
    if (PRESSURE_BAD.has(pressureState)) return false;
    if (batteryDischarging) return false;
    if (frameEma != null && frameEma > GOOD_FRAME_MS) return false;
    return true;
  }

  /** Immediate reaction to a PressureObserver callback (not tick-gated). */
  function atFloor() {
    return TIER_ORDER.indexOf(currentTier) <= rangeLo;
  }

  function atCeiling() {
    return TIER_ORDER.indexOf(currentTier) >= rangeHi;
  }

  function maybeReactToPressure() {
    if (!sensing || destroyed) return;
    if (PRESSURE_BAD.has(pressureState) && !atFloor() && hysteresisOk()) {
      headroomStreak = 0;
      stepTier(-1);
    }
  }

  /** Periodic sustained-headroom decision (and frame-time-driven lowering). */
  function decideTierStep() {
    if (!sensing || destroyed) return;
    if (isBadSignal()) {
      headroomStreak = 0;
      if (!atFloor() && hysteresisOk()) stepTier(-1);
      return;
    }
    if (isGoodSignal()) {
      headroomStreak += 1;
      if (headroomStreak >= RAISE_STREAK_TICKS && !atCeiling() && hysteresisOk()) {
        headroomStreak = 0;
        stepTier(1);
      }
    } else {
      headroomStreak = 0;
    }
  }

  // AUDIT FIX: a frame delta straddling a tab-hide (or a debugger pause, or a
  // laptop sleep) can be seconds long — feeding that raw into the EMA poisoned
  // it and walked the quality tier down to eco on a machine that was never
  // struggling. Anything past this bound is not a rendering measurement.
  const MAX_PLAUSIBLE_FRAME_MS = 250;

  function updateFrameEma(dt) {
    if (!(dt > 0) || dt > MAX_PLAUSIBLE_FRAME_MS) return;
    frameEma = frameEma == null ? dt : frameEma + (dt - frameEma) * FRAME_EMA_ALPHA;
  }

  function measureFrame(done) {
    if (typeof requestAnimationFrame !== 'function') {
      done(null);
      return;
    }
    let t0 = null;
    const id1 = requestAnimationFrame((ts) => {
      rafIds.delete(id1);
      t0 = ts;
      const id2 = requestAnimationFrame((ts2) => {
        rafIds.delete(id2);
        done(ts2 - t0);
      });
      rafIds.add(id2);
    });
    rafIds.add(id1);
  }

  function cancelPendingFrames() {
    if (typeof cancelAnimationFrame === 'function') {
      for (const id of rafIds) {
        try {
          cancelAnimationFrame(id);
        } catch {
          // ignore
        }
      }
    }
    rafIds.clear();
  }

  function scheduleNextEval(delay) {
    evalTimer = setTimeout(runEval, delay);
  }

  function runEval() {
    evalTimer = null;
    if (destroyed || !sensing) return;
    const hidden = isHiddenDoc();
    if (!hidden) {
      measureFrame((dt) => {
        if (destroyed || !sensing) return;
        updateFrameEma(dt);
        decideTierStep();
      });
    }
    scheduleNextEval(hidden ? HIDDEN_EVAL_MS : VISIBLE_EVAL_MS);
  }

  function onVisibilityChange() {
    if (!sensing) return;
    if (evalTimer != null) {
      clearTimeout(evalTimer);
      evalTimer = null;
    }
    scheduleNextEval(isHiddenDoc() ? HIDDEN_EVAL_MS : VISIBLE_EVAL_MS);
  }

  function attachVisibilityListener() {
    if (visListenerAttached) return;
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
    document.addEventListener('visibilitychange', onVisibilityChange);
    visListenerAttached = true;
  }

  function removeVisibilityListener() {
    if (!visListenerAttached) return;
    if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
    visListenerAttached = false;
  }

  function startPressureObserver() {
    if (typeof PressureObserver !== 'function') return;
    try {
      pressureObserver = new PressureObserver((records) => {
        if (destroyed) return;
        const latest = records && records.length ? records[records.length - 1] : null;
        if (latest && latest.state) pressureState = latest.state;
        maybeReactToPressure();
      });
      const result = pressureObserver.observe('cpu');
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      pressureObserver = null;
    }
  }

  function stopPressureObserver() {
    if (pressureObserver) {
      try {
        if (typeof pressureObserver.disconnect === 'function') pressureObserver.disconnect();
        else if (typeof pressureObserver.unobserve === 'function') pressureObserver.unobserve('cpu');
      } catch {
        // ignore
      }
    }
    pressureObserver = null;
    pressureState = 'nominal';
  }

  function startBatteryWatch() {
    if (typeof navigator === 'undefined' || typeof navigator.getBattery !== 'function') return;
    // `sensing` flips false synchronously the moment stopSensing() runs, so
    // checking it here after the promise settles is enough to drop a stale
    // resolution from a since-stopped watch — no separate cancel token needed.
    Promise.resolve(navigator.getBattery())
      .then((battery) => {
        if (destroyed || !sensing || !battery) return;
        batteryObj = battery;
        batteryDischarging = !battery.charging;
        onBatteryChange = () => {
          batteryDischarging = !battery.charging;
        };
        if (typeof battery.addEventListener === 'function') {
          battery.addEventListener('chargingchange', onBatteryChange);
        }
      })
      .catch(() => {});
  }

  function stopBatteryWatch() {
    if (batteryObj && onBatteryChange && typeof batteryObj.removeEventListener === 'function') {
      try {
        batteryObj.removeEventListener('chargingchange', onBatteryChange);
      } catch {
        // ignore
      }
    }
    batteryObj = null;
    onBatteryChange = null;
    batteryDischarging = false;
  }

  function startSensing() {
    if (sensing) return;
    sensing = true;
    headroomStreak = 0;
    attachVisibilityListener();
    startPressureObserver();
    startBatteryWatch();
    scheduleNextEval(isHiddenDoc() ? HIDDEN_EVAL_MS : VISIBLE_EVAL_MS);
  }

  function stopSensing() {
    if (!sensing) return;
    sensing = false;
    if (evalTimer != null) {
      clearTimeout(evalTimer);
      evalTimer = null;
    }
    cancelPendingFrames();
    stopPressureObserver();
    stopBatteryWatch();
    removeVisibilityListener();
    frameEma = null;
    headroomStreak = 0;
  }

  /**
   * setTier(spec): 'auto' | tier | '<min>-<max>'. An unparseable spec is
   * ignored (the governor keeps what it had). A one-tier range pins; any
   * wider one senses inside it, starting from the tier already applied (or
   * the static prior) clamped into the span.
   */
  function setTier(spec) {
    if (destroyed) return;
    const range = parseTierSpec(spec);
    if (!range) return;
    const lo = TIER_ORDER.indexOf(range.min);
    const hi = TIER_ORDER.indexOf(range.max);
    requestedTier = tierSpec(range.min, range.max);
    rangeLo = lo;
    rangeHi = hi;
    if (lo === hi) {
      stopSensing();
      applyTier(TIER_ORDER[lo]);
      return;
    }
    startSensing();
    const from = TIER_ORDER.indexOf(currentTier ?? staticPriorTier());
    applyTier(TIER_ORDER[Math.max(lo, Math.min(hi, from))]);
  }

  /** setRange(min, max) — the same input as setTier('<min>-<max>'). */
  function setRange(min, max) {
    const spec = tierSpec(min, max);
    if (spec) setTier(spec);
  }

  function getTier() {
    return requestedTier;
  }

  function getRange() {
    return { min: TIER_ORDER[rangeLo], max: TIER_ORDER[rangeHi] };
  }

  /** The applied tier while the governor is sensing (any span), else null. */
  function getAuto() {
    return sensing ? currentTier : null;
  }

  /**
   * D10: the page reports how many active modulation connections the engine
   * holds. Re-emits only when the count changes, so a caller may report
   * every bar without churning the consumers.
   */
  function setConnections(n) {
    if (destroyed) return;
    const next = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    if (next === connections) return;
    connections = next;
    if (currentTier) emit();
  }

  /** { count, budget, tier, over } against the tier applied right now. */
  function connectionStatus() {
    const budget = currentTier ? TIER_BUDGETS[currentTier].maxConnections : null;
    return { count: connections, budget, tier: currentTier, over: budget != null && connections > budget };
  }

  function stats() {
    return {
      tier: currentTier,
      mode: sensing ? 'auto' : 'manual',
      requestedTier,
      range: getRange(),
      connections: connectionStatus(),
      budget: currentTier ? budgetFor(currentTier) : null,
      sensors: {
        pressureState,
        frameEmaMs: frameEma,
        batteryDischarging,
        hardwareConcurrency: safeNav('hardwareConcurrency') ?? null,
        deviceMemory: safeNav('deviceMemory') ?? null,
      },
      headroomStreak,
      lastChangeAt,
    };
  }

  function destroy() {
    if (destroyed) return;
    stopSensing();
    destroyed = true;
  }

  setTier('auto'); // sensible ready-to-go default; page may setTier() again from a saved pref

  return { setTier, setRange, getTier, getRange, getAuto, setConnections, connectionStatus, stats, destroy };
}

export default createGovernor;
