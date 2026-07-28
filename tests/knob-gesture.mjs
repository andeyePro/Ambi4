/**
 * The v0.0.56 dial gesture contract — run with:
 *   node tests/knob-gesture.mjs
 *
 * This is the file the ladder asked for BEFORE the gesture rebuild rather than
 * after it: knobscope-smoke.mjs exercises click-to-toggle, double-click reset
 * and the inside/outside-face zone scheme, all three of which the rebuild
 * deletes, so the new behaviour needed somewhere to be specified that was not
 * "whatever the code now does".
 *
 * "Feels right on a phone" is not a gate. Axis lock, re-arm, nearest-end grab,
 * push-through, spread open/close and the reset tap are all decidable from a
 * pointer sequence, so they are decided here.
 *
 * The mock DOM carries getBoundingClientRect — without it knob.js cannot tell
 * the hub from the rim and every press degrades to plain single-value drag,
 * which would quietly pass half of these tests for the wrong reason.
 */

import assert from 'node:assert/strict';
import { createKnob } from '../src/scripts/knob.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// --------------------------------------------------------------------------
// Mock DOM
// --------------------------------------------------------------------------

// A 100×100 knob at the viewport origin: centre (50,50), face radius 31,
// hub radius 31 × 0.45 ≈ 13.95. Every coordinate below is in that frame.
const KNOB_RECT = { left: 0, top: 0, width: 100, height: 100 };

function mockElement(tag) {
  const listeners = new Map();
  let textContentValue = '';
  const el = {
    tagName: tag,
    children: [],
    attributes: {},
    style: {},
    className: '',
    parentNode: null,
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; },
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      child.parentNode = null;
    },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    listenerCount(type) { return listeners.get(type)?.size || 0; },
    dispatch(type, evt = {}) {
      for (const fn of [...(listeners.get(type) || [])]) {
        fn({ type, preventDefault() {}, stopPropagation() {}, ...evt });
      }
    },
    getBoundingClientRect() { return { ...KNOB_RECT, right: KNOB_RECT.left + KNOB_RECT.width, bottom: KNOB_RECT.top + KNOB_RECT.height }; },
    setPointerCapture() {},
    releasePointerCapture() {},
    focus() {},
    querySelector() { return null; },
  };
  Object.defineProperty(el, 'textContent', {
    get() {
      if (this.children.length) return this.children.map((c) => (c.nodeType === 3 ? c.textContent : c.textContent || '')).join('');
      return textContentValue;
    },
    set(v) { this.children.length = 0; textContentValue = String(v); },
  });
  return el;
}

globalThis.document = {
  createElement: (tag) => mockElement(tag),
  createElementNS: (_ns, tag) => mockElement(tag),
  createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
  addEventListener() {},
  removeEventListener() {},
};

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function makeKnob(overrides = {}) {
  const seen = [];
  const container = mockElement('div');
  const handle = createKnob(container, {
    label: 'Test',
    min: 0,
    max: 100,
    value: 50,
    onInput: (v) => seen.push(v),
    ...overrides,
  });
  return { handle, seen, el: handle.el };
}

/** Find a descendant by its data-role attribute. */
function byRole(el, role) {
  if (el.getAttribute && el.getAttribute('data-role') === role) return el;
  for (const child of el.children || []) {
    const found = byRole(child, role);
    if (found) return found;
  }
  return null;
}

const CENTRE = { x: 50, y: 50 };

/** Press, move through a list of offsets from the press point, release. */
function drag(el, from, offsets, opts = {}) {
  el.dispatch('pointerdown', { clientX: from.x, clientY: from.y, button: 0, pointerId: 1, ...opts });
  for (const [dx, dy] of offsets) {
    el.dispatch('pointermove', { clientX: from.x + dx, clientY: from.y + dy, pointerId: 1, ...opts });
  }
  const last = offsets.length ? offsets[offsets.length - 1] : [0, 0];
  el.dispatch('pointerup', { clientX: from.x + last[0], clientY: from.y + last[1], pointerId: 1, ...opts });
}

function tap(el, at) {
  el.dispatch('pointerdown', { clientX: at.x, clientY: at.y, button: 0, pointerId: 1 });
  el.dispatch('pointerup', { clientX: at.x, clientY: at.y, pointerId: 1 });
}

const last = (arr) => arr[arr.length - 1];

// --------------------------------------------------------------------------
// Axis lock
// --------------------------------------------------------------------------

test('nothing moves before the lock threshold', () => {
  const { el, seen } = makeKnob();
  // 5 px is inside LOCK_PX (6): a hand resting on the control is not a gesture.
  drag(el, CENTRE, [[0, -3], [0, -5]]);
  assert.equal(seen.length, 0);
});

test('a vertical drag past the threshold moves the value, not the spread', () => {
  const { el, seen } = makeKnob();
  drag(el, { x: 50, y: 90 }, [[0, -20], [0, -40]]);
  assert.ok(seen.length > 0, 'expected the drag to commit something');
  assert.equal(typeof last(seen), 'number', 'a vertical drag must stay single-valued');
  assert.ok(last(seen) > 50, `drag up should raise the value, got ${last(seen)}`);
});

test('a horizontal drag past the threshold opens a spread, not a value change', () => {
  const { el, seen } = makeKnob();
  drag(el, { x: 50, y: 90 }, [[20, 0], [40, 0]]);
  const v = last(seen);
  assert.equal(typeof v, 'object', `a horizontal drag must open a span, got ${JSON.stringify(v)}`);
  // Opened about the value it started from, so the midpoint is unchanged.
  assert.equal((v.min + v.max) / 2, 50, 'the span must open about the existing value');
  assert.ok(v.max > v.min, 'the span must have width');
});

test('the axis that wins is the larger of |dx| and |dy| at the moment of lock', () => {
  const { el, seen } = makeKnob();
  // Mostly sideways, slightly up: still a spread. The rejected diagonal scheme
  // would have moved both and made this ambiguous.
  drag(el, { x: 50, y: 90 }, [[10, -4], [40, -8]]);
  assert.equal(typeof last(seen), 'object');
});

test('the locked axis owns the rest of the gesture', () => {
  const { el, seen } = makeKnob();
  // Lock vertical, then swing hard sideways without returning to the origin:
  // the spread must never open.
  drag(el, { x: 50, y: 90 }, [[0, -20], [60, -22], [60, -40]]);
  assert.ok(seen.every((v) => typeof v === 'number'), 'a locked value axis must not start spreading');
});

test('returning to the origin re-arms the axis', () => {
  const { el, seen } = makeKnob();
  el.dispatch('pointerdown', { clientX: 50, clientY: 90, button: 0, pointerId: 1 });
  // Lock vertical …
  el.dispatch('pointermove', { clientX: 50, clientY: 70, pointerId: 1 });
  assert.equal(typeof last(seen), 'number');
  // … come back inside REARM_PX of where the press started …
  el.dispatch('pointermove', { clientX: 51, clientY: 88, pointerId: 1 });
  // … and go sideways: the gesture is allowed to change its mind.
  el.dispatch('pointermove', { clientX: 90, clientY: 88, pointerId: 1 });
  el.dispatch('pointerup', { clientX: 90, clientY: 88, pointerId: 1 });
  assert.equal(typeof last(seen), 'object', 'after re-arming, a sideways drag must spread');
});

// --------------------------------------------------------------------------
// Spread
// --------------------------------------------------------------------------

test('dragging left closes a spread back to a single value', () => {
  const { el, seen } = makeKnob({ value: { min: 30, max: 70 } });
  drag(el, { x: 50, y: 90 }, [[-30, 0], [-120, 0]]);
  assert.equal(typeof last(seen), 'number', 'narrowing past zero must collapse to a single value');
  assert.equal(last(seen), 50, 'the collapsed value is the midpoint the span had');
});

test('a spread cannot be pushed outside the knob bounds', () => {
  const { el, seen } = makeKnob({ value: 10 });
  drag(el, { x: 50, y: 90 }, [[20, 0], [400, 0]]);
  const v = last(seen);
  assert.equal(typeof v, 'object');
  assert.ok(v.min >= 0 && v.max <= 100, `span escaped its bounds: ${JSON.stringify(v)}`);
});

test('a dial already at its ceiling still opens a span, one-sided', () => {
  // The symmetric-only rule failed here in the worst possible way: silently.
  // A Volume or a Reprise sitting at 100% is exactly where someone reaches
  // for variation, and the gesture did nothing at all.
  const { el, seen } = makeKnob({ value: 100 });
  drag(el, { x: 50, y: 90 }, [[20, 0], [40, 0]]);
  const v = last(seen);
  assert.equal(typeof v, 'object', 'a dial at its ceiling must still be able to spread');
  assert.equal(v.max, 100);
  assert.ok(v.min < 100, 'the span must have width');
});

test('a dial at its floor opens a span the same way', () => {
  const { el, seen } = makeKnob({ value: 0 });
  drag(el, { x: 50, y: 90 }, [[20, 0], [40, 0]]);
  const v = last(seen);
  assert.equal(typeof v, 'object');
  assert.equal(v.min, 0);
  assert.ok(v.max > 0);
});

test('the width the gesture asked for survives being pushed off a bound', () => {
  // 40 px of travel on a 200 px full-spread scale over a 0–100 range is a
  // half-width of 20, so a width of 40 either way.
  const centred = makeKnob({ value: 50 });
  drag(centred.el, { x: 50, y: 90 }, [[20, 0], [40, 0]]);
  const a = last(centred.seen);
  const atCeiling = makeKnob({ value: 100 });
  drag(atCeiling.el, { x: 50, y: 90 }, [[20, 0], [40, 0]]);
  const b = last(atCeiling.seen);
  assert.equal(b.max - b.min, a.max - a.min, 'a span at a bound must keep the width, not half of it');
});

test('an enumeration ignores the horizontal axis entirely', () => {
  const { el, seen } = makeKnob({ allowRange: false, step: 1, max: 3, value: 1 });
  drag(el, { x: 50, y: 90 }, [[20, 0], [60, 0]]);
  assert.equal(seen.length, 0, 'a non-rangeable dial must not open a span');
});

test('spreadable is the default — a caller opts out, never in', () => {
  const { el, seen } = makeKnob(); // no allowRange passed at all
  drag(el, { x: 50, y: 90 }, [[20, 0], [40, 0]]);
  assert.equal(typeof last(seen), 'object', 'every dial spreads unless it says otherwise');
});

// --------------------------------------------------------------------------
// Which end a press grabs
// --------------------------------------------------------------------------

test('a press on the rim grabs the nearer end and moves it alone', () => {
  // Span 20–80 on a 0–100 dial over a 270° sweep: min sits at -81°, max at
  // +81°. A press on the right-hand rim is unambiguously nearer max.
  const { el, seen } = makeKnob({ value: { min: 20, max: 80 } });
  drag(el, { x: 90, y: 50 }, [[0, -20], [0, -40]]);
  const v = last(seen);
  assert.equal(typeof v, 'object');
  assert.equal(v.min, 20, 'the far end must not move');
  assert.ok(v.max > 80 || v.max === 100, `the near end should have risen, got ${v.max}`);
});

test('a press on the far rim grabs the other end', () => {
  const { el, seen } = makeKnob({ value: { min: 20, max: 80 } });
  drag(el, { x: 10, y: 50 }, [[0, -20], [0, -40]]);
  const v = last(seen);
  assert.equal(typeof v, 'object');
  assert.equal(v.max, 80, 'the far end must not move');
  assert.ok(v.min > 20, `the near end should have risen, got ${v.min}`);
});

test('a press on the hub moves both ends together, keeping the width', () => {
  const { el, seen } = makeKnob({ value: { min: 20, max: 40 } });
  drag(el, CENTRE, [[0, -20], [0, -40]]);
  const v = last(seen);
  assert.equal(typeof v, 'object');
  assert.equal(v.max - v.min, 20, 'the width must survive a hub drag');
  assert.ok(v.min > 20, 'the whole span should have moved up');
});

test('a span moved by the hub stops at the bound instead of being squashed', () => {
  const { el, seen } = makeKnob({ value: { min: 70, max: 90 } });
  drag(el, CENTRE, [[0, -20], [0, -400]]);
  const v = last(seen);
  assert.equal(v.max, 100);
  assert.equal(v.max - v.min, 20, 'the width must survive hitting the ceiling');
});

test('one end pushed past the other carries it along rather than wedging', () => {
  const { el, seen } = makeKnob({ value: { min: 20, max: 80 } });
  // Grab min (left rim) and drive it hard upward, past max.
  drag(el, { x: 10, y: 50 }, [[0, -20], [0, -400]]);
  const v = last(seen);
  assert.ok(v.min <= v.max, 'the ends must never invert');
  assert.equal(v.min, v.max, 'pushed all the way, the span collapses and travels together');
});

// --------------------------------------------------------------------------
// Tap to reset
// --------------------------------------------------------------------------

test('a tap on the hub resets to the declared default', () => {
  const { el, seen } = makeKnob({ value: 20, defaultValue: 60 });
  tap(el, CENTRE);
  assert.equal(last(seen), 60);
});

test('a tap on the hub resets the spread too', () => {
  const { el, seen } = makeKnob({ value: { min: 10, max: 90 }, defaultValue: 60 });
  tap(el, CENTRE);
  assert.equal(last(seen), 60, 'the reset must collapse a span, not just move it');
});

test('a tap outside the hub does nothing', () => {
  const { el, seen } = makeKnob({ value: 20, defaultValue: 60 });
  tap(el, { x: 90, y: 50 });
  assert.equal(seen.length, 0, 'an ordinary tap on the face must be inert, never destructive');
});

test('the reset has no timing requirement', () => {
  // The whole point of replacing double-click: a slow press still resets.
  const { el, seen } = makeKnob({ value: 20, defaultValue: 60 });
  el.dispatch('pointerdown', { clientX: 50, clientY: 50, button: 0, pointerId: 1 });
  el.dispatch('pointerup', { clientX: 51, clientY: 51, pointerId: 1 });
  assert.equal(last(seen), 60);
});

test('a drag that starts on the hub is a drag, not a reset', () => {
  const { el, seen } = makeKnob({ value: 20, defaultValue: 60 });
  drag(el, CENTRE, [[0, -20], [0, -40]]);
  assert.notEqual(last(seen), 60, 'travel past the tap slop must rule out the reset');
});

test('double-click is gone', () => {
  const { el, seen } = makeKnob({ value: 20, defaultValue: 60 });
  el.dispatch('dblclick', {});
  assert.equal(seen.length, 0, 'nothing may still be listening for dblclick');
  assert.equal(el.listenerCount('dblclick'), 0);
});

// --------------------------------------------------------------------------
// Keyboard
// --------------------------------------------------------------------------

test('Shift+Right widens the spread, Shift+Left narrows it', () => {
  const { el, seen } = makeKnob({ value: 50, step: 1 });
  el.dispatch('keydown', { key: 'ArrowRight', shiftKey: true });
  const opened = last(seen);
  assert.equal(typeof opened, 'object', 'a keyboard user must be able to CREATE a span');
  assert.equal((opened.min + opened.max) / 2, 50);
  el.dispatch('keydown', { key: 'ArrowLeft', shiftKey: true });
  assert.equal(typeof last(seen), 'number', 'narrowing past zero collapses it again');
});

test('Backspace resets to the default', () => {
  const { el, seen } = makeKnob({ value: 20, defaultValue: 60 });
  el.dispatch('keydown', { key: 'Backspace' });
  assert.equal(last(seen), 60);
});

test('Delete resets to the default', () => {
  const { el, seen } = makeKnob({ value: 20, defaultValue: 60 });
  el.dispatch('keydown', { key: 'Delete' });
  assert.equal(last(seen), 60);
});

test('plain arrows still move the value', () => {
  const { el, seen } = makeKnob({ value: 50, step: 1 });
  el.dispatch('keydown', { key: 'ArrowUp' });
  assert.equal(last(seen), 51);
  el.dispatch('keydown', { key: 'ArrowDown' });
  assert.equal(last(seen), 50);
});

// --------------------------------------------------------------------------
// Display states
// --------------------------------------------------------------------------

test('a dial at its minimum with no spread reads as zeroed', () => {
  const { el } = makeKnob({ value: 0 });
  assert.equal(el.getAttribute('data-zeroed'), 'true');
});

test('a dial anywhere else does not', () => {
  const { el } = makeKnob({ value: 1 });
  assert.equal(el.getAttribute('data-zeroed'), 'false');
});

test('a spread sitting at the minimum is not zeroed — it is drifting', () => {
  const { el } = makeKnob({ value: { min: 0, max: 20 } });
  assert.equal(el.getAttribute('data-zeroed'), 'false');
});

test('the zeroed look follows the value', () => {
  const { handle, el } = makeKnob({ value: 0 });
  assert.equal(el.getAttribute('data-zeroed'), 'true');
  handle.set(40);
  assert.equal(el.getAttribute('data-zeroed'), 'false');
  handle.set(0);
  assert.equal(el.getAttribute('data-zeroed'), 'true');
});

test('the live pointer shows only inside a span', () => {
  const { handle, el } = makeKnob({ value: 50 });
  const live = byRole(el, 'live-pointer');
  assert.ok(live, 'the live pointer element must exist');
  handle.setLive(50);
  assert.equal(live.style.display, 'none', 'in single mode the main pointer already is the live value');
  handle.set({ min: 20, max: 80 });
  handle.setLive(60);
  assert.notEqual(live.style.display, 'none');
});

test('the live pointer is clamped into the span and never commits', () => {
  const { handle, el, seen } = makeKnob({ value: { min: 20, max: 80 } });
  const live = byRole(el, 'live-pointer');
  handle.setLive(999);
  assert.equal(seen.length, 0, 'setLive is display-only — it must never fire onInput');
  const t = live.getAttribute('transform');
  assert.ok(/rotate\(/.test(t), `expected a rotation, got ${t}`);
  handle.setLive(null);
  assert.equal(live.style.display, 'none');
});

test('the centre hub is drawn', () => {
  const { el } = makeKnob();
  assert.ok(byRole(el, 'hub'), 'the reset/whole-control target must be visible, not invisible');
});

// --------------------------------------------------------------------------

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}\n     ${err.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
