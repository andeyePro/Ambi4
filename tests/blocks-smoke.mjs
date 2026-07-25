/**
 * Smoke test for src/scripts/blocks.js — run with:
 *   node tests/blocks-smoke.mjs
 *
 * Drives createBlockEditor() against a mock DOM (document/elements/events, the
 * established knobscope-smoke style) and a fake clock, plus the pure
 * fromParams()/toParams()/normaliseLayout() compilers with no DOM at all —
 * proving bare-Node import safety, palette→slot placement by pointer AND by
 * keyboard, the aria gridcell contract, the sequencer-param round trip across
 * ties/groups/velocity bands/probability ranges/multi-lane percussion, the
 * link-block mapping (same-lane forward → ties, otherwise → a shared group id),
 * repeat tiling, onChange debouncing, silent setValue and destroy cleanup with
 * zero timers left behind.
 */

import assert from 'node:assert/strict';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// --------------------------------------------------------------------------
// Mock DOM
// --------------------------------------------------------------------------

function mockElement(tag) {
  const listeners = new Map(); // type -> Set<fn>
  let textContentValue = '';
  const el = {
    tagName: tag,
    children: [],
    attributes: {},
    style: {},
    className: '',
    parentNode: null,
    value: '',
    focused: false,
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; },
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
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
    listenerTypes() { return [...listeners.keys()].filter((t) => listeners.get(t).size); },
    dispatch(type, evt = {}) {
      for (const fn of [...(listeners.get(type) || [])]) {
        fn({ type, preventDefault() {}, stopPropagation() {}, ...evt });
      }
    },
    focus() { this.focused = true; },
  };
  // Real `.textContent =` clears every child before the string becomes the
  // sole content — blocks.js rebuilds a slot's spans that way on every refresh.
  Object.defineProperty(el, 'textContent', {
    get() {
      if (this.children.length) return this.children.map((c) => c.textContent || '').join('');
      return textContentValue;
    },
    set(v) {
      this.children.length = 0;
      textContentValue = String(v);
    },
  });
  return el;
}

const docListeners = new Map();
const mockDocument = {
  createElement: (tag) => mockElement(tag),
  addEventListener(type, fn) {
    if (!docListeners.has(type)) docListeners.set(type, new Set());
    docListeners.get(type).add(fn);
  },
  removeEventListener(type, fn) { docListeners.get(type)?.delete(fn); },
  listenerCount(type) { return docListeners.get(type)?.size || 0; },
};

// --------------------------------------------------------------------------
// Fake clock (debounce)
// --------------------------------------------------------------------------

function installFakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, delay = 0) => {
    const id = nextId++;
    timers.set(id, { at: now + Math.max(0, delay), fn });
    return id;
  };
  globalThis.clearTimeout = (id) => { timers.delete(id); };
  return {
    pendingCount: () => timers.size,
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let dueId = null;
        let dueAt = Infinity;
        for (const [id, t] of timers) {
          if (t.at <= target && t.at < dueAt) { dueAt = t.at; dueId = id; }
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
    },
  };
}

// --------------------------------------------------------------------------
// Param fixtures (engine-shaped: every field explicit, 20 slots per lane)
// --------------------------------------------------------------------------

const DEFAULT_STEP = { on: true, prob: 1, vmin: 0.5, vmax: 0.9 };

function step(overrides = {}) {
  return { ...DEFAULT_STEP, ...overrides };
}

function lane(overrides = {}) {
  const slots = Array.from({ length: 20 }, () => step({ on: false }));
  for (const [index, value] of Object.entries(overrides)) slots[Number(index)] = value;
  return slots;
}

/** A melodic lane exercising every expressible field at once. */
function richLane() {
  return lane({
    0: step({ on: true, prob: 1, vmin: 0.5, vmax: 0.9 }),
    2: step({ on: true, prob: 0.4, vmin: 0.2, vmax: 0.7 }),
    4: step({ on: true, prob: { min: 0.2, max: 0.9 }, vmin: 0.5, vmax: 0.9, tie: true }),
    5: step({ on: false, prob: 1, vmin: 0.5, vmax: 0.9, tie: true }),
    8: step({ on: true, prob: 0.8, vmin: 0.5, vmax: 0.9, group: 2 }),
    9: step({ on: true, prob: 0.6, vmin: 0.5, vmax: 0.9, group: 2 }),
  });
}

function melodicSequencer() {
  return { mode: 'manual', weights: [1], steps: richLane() };
}

function percussionSequencer() {
  return {
    mode: 'manual',
    weights: [1, 0.5],
    steps: {
      low: lane({ 0: step({ on: true }), 8: step({ on: true, prob: 0.5, vmin: 0.4, vmax: 0.6 }) }),
      mid: lane({ 4: step({ on: true, group: 0 }), 12: step({ on: true, group: 0 }) }),
      high: lane({ 2: step({ on: true, tie: true }), 6: step({ on: true, prob: { min: 0.3, max: 0.8 }, vmin: 0.5, vmax: 0.9 }) }),
    },
  };
}

/** v21: a percussion kit extended past the three built-ins with a user lane. */
function dynamicKitSequencer() {
  return {
    mode: 'manual',
    weights: [1],
    steps: {
      high: lane({ 2: step({ on: true, tie: true }) }),
      mid: lane({ 4: step({ on: true, group: 0 }) }),
      low: lane({ 0: step({ on: true }) }),
      toms: lane({ 8: step({ on: true, prob: 0.6 }) }),
    },
  };
}

const DYNAMIC_LANES_TOP_DOWN = [
  { id: 'high', label: 'High' },
  { id: 'mid', label: 'Mid' },
  { id: 'low', label: 'Low' },
  { id: 'toms', label: 'Toms' },
];

// Deliberately the SCHEMA (ascending) order, not the display order — proves
// the dynamic form renders exactly what it is given, unlike the legacy
// reversal below.
const DYNAMIC_LANES_ASCENDING = [
  { id: 'low', label: 'Low' },
  { id: 'mid', label: 'Mid' },
  { id: 'high', label: 'High' },
  { id: 'toms', label: 'Toms' },
];

let blocks;

// --------------------------------------------------------------------------
// Import safety + headless compile
// --------------------------------------------------------------------------

test('imports cleanly in bare Node (no document) and stays usable headlessly', async () => {
  assert.equal(typeof globalThis.document, 'undefined');
  blocks = await import('../src/scripts/blocks.js');
  assert.equal(typeof blocks.createBlockEditor, 'function');
  assert.equal(typeof blocks.default, 'function');
  assert.equal(typeof blocks.fromParams, 'function');
  assert.equal(typeof blocks.toParams, 'function');
  assert.equal(typeof blocks.normaliseLayout, 'function');

  // No DOM at call time → no rendering, but the state half still compiles.
  const headless = blocks.createBlockEditor(null, { track: 'melody', value: melodicSequencer() });
  assert.equal(headless.el, null);
  assert.deepEqual(headless.getValue(), melodicSequencer());
  headless.setValue({ mode: 'auto', weights: [1], steps: lane({ 3: step({ on: true }) }) });
  assert.equal(headless.getValue().steps[3].on, true);
  headless.destroy();
});

// --------------------------------------------------------------------------
// Pure compile: round trips
// --------------------------------------------------------------------------

test('round trip: melodic sequencer with ties, groups, bands and a prob range', () => {
  const params = melodicSequencer();
  const layout = blocks.fromParams(params, { track: 'melody' });
  assert.deepEqual(blocks.toParams(layout), params);
});

test('round trip: percussion, three lanes', () => {
  const params = percussionSequencer();
  const layout = blocks.fromParams(params, { track: 'percussion' });
  assert.equal(layout.lanes.length, 3);
  assert.deepEqual(layout.lanes.map((l) => l.id), ['low', 'mid', 'high']);
  assert.deepEqual(blocks.toParams(layout), params);
});

test('round trip: layout → params → layout is identity for canonical layouts', () => {
  for (const [track, params] of [['melody', melodicSequencer()], ['percussion', percussionSequencer()]]) {
    const layout = blocks.fromParams(params, { track });
    assert.deepEqual(blocks.fromParams(blocks.toParams(layout), { track }), layout);
  }
});

test('block decomposition: only non-default fields become modifier blocks', () => {
  const layout = blocks.fromParams(melodicSequencer(), { track: 'melody' });
  const slots = layout.lanes[0].slots;
  assert.deepEqual(slots[0], { kind: 'step', blocks: [] });
  assert.deepEqual(slots[1], { kind: 'rest', blocks: [] });
  assert.deepEqual(slots[2], {
    kind: 'step',
    blocks: [{ type: 'prob', value: 0.4 }, { type: 'band', vmin: 0.2, vmax: 0.7 }],
  });
  assert.deepEqual(slots[4], {
    kind: 'step',
    blocks: [{ type: 'tie' }, { type: 'prob', value: { min: 0.2, max: 0.9 } }],
  });
  assert.deepEqual(slots[8], {
    kind: 'step',
    blocks: [{ type: 'prob', value: 0.8 }, { type: 'group', id: 2 }],
  });
});

// --------------------------------------------------------------------------
// Gate/Length block (v21): step.gate, 0.1–2
// --------------------------------------------------------------------------

test('gate: round-trips and stays invisible at the default (1 = a full beat)', () => {
  const params = {
    mode: 'manual',
    weights: [1],
    steps: lane({ 0: step({ on: true, gate: 1.5 }), 1: step({ on: true, gate: 1 }) }),
  };
  const layout = blocks.fromParams(params, { track: 'melody' });
  assert.deepEqual(layout.lanes[0].slots[0], { kind: 'step', blocks: [{ type: 'gate', value: 1.5 }] });
  assert.deepEqual(layout.lanes[0].slots[1], { kind: 'step', blocks: [] }, 'the engine default carries no block');
  const out = blocks.toParams(layout);
  assert.equal(out.steps[0].gate, 1.5);
  assert.equal('gate' in out.steps[1], false);
});

test('gate: clamps to 0.1–2', () => {
  const params = {
    mode: 'manual',
    weights: [1],
    steps: lane({ 0: step({ on: true, gate: 5 }), 1: step({ on: true, gate: -3 }) }),
  };
  const layout = blocks.fromParams(params, { track: 'melody' });
  assert.equal(layout.lanes[0].slots[0].blocks[0].value, 2);
  assert.equal(layout.lanes[0].slots[1].blocks[0].value, 0.1);
});

test('metre: only the metre prefix renders, all 20 slots survive the round trip', () => {
  assert.equal(blocks.blockSlotsPerBar('3/4'), 12);
  assert.equal(blocks.blockSlotsPerBar('4/4'), 16);
  assert.equal(blocks.blockSlotsPerBar('5/4'), 20);
  assert.equal(blocks.blockSlotsPerBar('6/8'), 12);
  assert.equal(blocks.blockSlotsPerBar('7/8'), 14);
  assert.equal(blocks.blockSlotsPerBar('nonsense'), 16);

  const params = { mode: 'manual', weights: [1], steps: lane({ 17: step({ on: true, prob: 0.3 }) }) };
  const layout = blocks.fromParams(params, { track: 'bass', timeSignature: '7/8' });
  assert.equal(layout.visibleSlots, 14);
  assert.equal(layout.lanes[0].slots.length, 20);
  // Slot 17 is past the 7/8 prefix; it must still come back verbatim.
  assert.deepEqual(blocks.toParams(layout), params);
});

test('wrapper forms: track object, sequencer object and bare steps all round-trip', () => {
  const trackValue = {
    state: 'on',
    voice: 'soft',
    level: 0.8,
    sequencers: [percussionSequencer(), { mode: 'auto', weights: [1, 1], steps: percussionSequencer().steps }],
  };
  trackValue.sequencer = trackValue.sequencers[0];
  const layout = blocks.fromParams(trackValue, { track: 'percussion' });
  const out = blocks.toParams(layout);
  assert.deepEqual(out, trackValue);
  assert.deepEqual(out.sequencer, out.sequencers[0], 'the singular alias must follow slot 0');
  assert.equal(out.state, 'on', 'sibling track fields survive verbatim');

  // sequencerIndex picks which one is edited; the others are untouched.
  const second = blocks.fromParams(trackValue, { track: 'percussion', sequencerIndex: 1 });
  const editedSecond = blocks.toParams(second);
  assert.deepEqual(editedSecond, trackValue);

  // Bare lane array (melodic) and bare lane map (percussion).
  const bareLane = richLane();
  assert.deepEqual(blocks.toParams(blocks.fromParams(bareLane, { track: 'melody' })), bareLane);
  const bareMap = percussionSequencer().steps;
  assert.deepEqual(blocks.toParams(blocks.fromParams(bareMap, { track: 'percussion' })), bareMap);
});

test('missing/short lanes come back as rests, not as a sixteenth-note machine gun', () => {
  const layout = blocks.fromParams(undefined, { track: 'melody' });
  const compiled = blocks.toParams(layout);
  assert.equal(compiled.steps.length, 20);
  assert.ok(compiled.steps.every((s) => s.on === false));
  const short = blocks.fromParams({ mode: 'manual', steps: [true, false] }, { track: 'arp' });
  const shortOut = blocks.toParams(short);
  assert.deepEqual(shortOut.steps[0], step({ on: true }));
  assert.deepEqual(shortOut.steps[1], step({ on: false }));
  assert.deepEqual(shortOut.steps[19], step({ on: false }));
  assert.ok(!('weights' in shortOut), 'a value without weights does not grow one');
});

test('legacy shape stability: unaffected callers see no new fields leak into compiled params', () => {
  const params = melodicSequencer();
  const layout = blocks.fromParams(params, { track: 'melody' });
  assert.equal(layout.laneOrderGiven, false, 'no explicit lanes opt — legacy path');
  assert.deepEqual(layout.laneLabels, {});
  const out = blocks.toParams(layout);
  assert.deepEqual(Object.keys(out).sort(), ['mode', 'steps', 'weights']);
});

// --------------------------------------------------------------------------
// Dynamic lanes (v21): [{id, label}] — arbitrary ids, given-order rendering
// --------------------------------------------------------------------------

test('dynamic lanes: [{id,label}] round-trips arbitrary ids, canonical order = given order', () => {
  const params = dynamicKitSequencer();
  const layout = blocks.fromParams(params, { track: 'percussion', lanes: DYNAMIC_LANES_TOP_DOWN });
  assert.deepEqual(layout.lanes.map((l) => l.id), ['high', 'mid', 'low', 'toms']);
  assert.equal(layout.laneOrderGiven, true);
  assert.deepEqual(blocks.toParams(layout), params);
});

test('dynamic lanes: caps at 8 lanes and dedupes ids', () => {
  const tooMany = Array.from({ length: 11 }, (_, i) => ({ id: `lane${i % 9}`, label: `Lane ${i}` }));
  const layout = blocks.fromParams(undefined, { track: 'percussion', lanes: tooMany });
  assert.ok(layout.lanes.length <= 8, 'never more than 8 lanes');
  assert.equal(new Set(layout.lanes.map((l) => l.id)).size, layout.lanes.length, 'no duplicate ids');
});

test('dynamic lanes: a bare string still works inside a [{id,label}] array (mixed form counts as dynamic)', () => {
  const layout = blocks.fromParams(dynamicKitSequencer(), {
    track: 'percussion',
    lanes: ['high', { id: 'mid', label: 'Mid' }, 'low', 'toms'],
  });
  assert.equal(layout.laneOrderGiven, true);
  assert.deepEqual(layout.lanes.map((l) => l.id), ['high', 'mid', 'low', 'toms']);
});

// --------------------------------------------------------------------------
// Pure compile: sugar (link + repeat)
// --------------------------------------------------------------------------

function blankLayout(track = 'melody', options = {}) {
  return blocks.fromParams(undefined, { track, ...options });
}

test('link block: same lane, forwards → a tie run spanning the two beats', () => {
  const layout = blankLayout();
  layout.lanes[0].slots[2] = { kind: 'step', blocks: [{ type: 'link', lane: 'main', index: 5 }] };
  const out = blocks.toParams(layout);
  for (let i = 2; i < 5; i++) assert.equal(out.steps[i].tie, true, `slot ${i} must be tied`);
  assert.equal(out.steps[5].tie, undefined, 'the target beat itself is not tied onwards');
  assert.equal(out.steps[1].tie, undefined);
});

test('link block: backwards on the same lane → a shared group id on both beats', () => {
  const layout = blankLayout();
  layout.lanes[0].slots[6] = { kind: 'step', blocks: [{ type: 'link', lane: 'main', index: 2 }] };
  const out = blocks.toParams(layout);
  assert.equal(out.steps[6].group, 0);
  assert.equal(out.steps[2].group, 0);
  assert.equal(out.steps[6].tie, undefined, 'a backwards link is a chain, not a tie');
});

test('link block: cross-lane → a shared group id, allocated above every existing one', () => {
  const layout = blocks.fromParams(percussionSequencer(), { track: 'percussion' });
  // The fixture already uses group 0 on the mid lane, so the new id must be 1.
  const high = layout.lanes.find((l) => l.id === 'high');
  high.slots[6].blocks.push({ type: 'link', lane: 'low', index: 8 });
  const out = blocks.toParams(layout);
  assert.equal(out.steps.high[6].group, 1);
  assert.equal(out.steps.low[8].group, 1);
  assert.equal(out.steps.mid[4].group, 0, 'existing groups are left alone');
  assert.equal(out.steps.high[6].tie, undefined);
});

test('link block: an out-of-range or self target is dropped, never guessed at', () => {
  const layout = blankLayout();
  layout.lanes[0].slots[3] = { kind: 'step', blocks: [{ type: 'link', lane: 'main', index: 99 }] };
  layout.lanes[0].slots[4] = { kind: 'step', blocks: [{ type: 'link', lane: 'main', index: 4 }] };
  const out = blocks.toParams(layout);
  assert.equal(out.steps[3].tie, undefined);
  assert.equal(out.steps[3].group, undefined);
  assert.equal(out.steps[4].group, undefined);
});

test('repeat block: tiles its beats across the rest of the bar, sugar stripped from copies', () => {
  const layout = blankLayout();
  layout.lanes[0].slots[0] = { kind: 'step', blocks: [{ type: 'repeat', beats: 4 }] };
  layout.lanes[0].slots[2] = { kind: 'step', blocks: [{ type: 'prob', value: 0.5 }] };
  const out = blocks.toParams(layout);
  for (const start of [0, 4, 8, 12]) {
    assert.equal(out.steps[start].on, true, `beat ${start} carries the tile's first step`);
    assert.equal(out.steps[start + 2].on, true);
    assert.equal(out.steps[start + 2].prob, 0.5);
    assert.equal(out.steps[start + 1].on, false);
  }
  assert.equal(out.steps[16].on, false, 'nothing is stamped past the metre prefix');
  assert.equal(out.steps[19].on, false);
});

test('normaliseLayout: sugar-free layouts are unchanged; sugar expands and does not survive', () => {
  const canonical = blocks.fromParams(melodicSequencer(), { track: 'melody' });
  assert.deepEqual(blocks.normaliseLayout(canonical), canonical);

  const sugared = blankLayout();
  sugared.lanes[0].slots[1] = { kind: 'step', blocks: [{ type: 'link', lane: 'main', index: 3 }] };
  const normalised = blocks.normaliseLayout(sugared);
  assert.equal(findType(normalised.lanes[0].slots[1], 'link'), null, 'the link is consumed');
  assert.ok(findType(normalised.lanes[0].slots[1], 'tie'));
  assert.deepEqual(blocks.normaliseLayout(normalised), normalised, 'normalise is idempotent');
  // The sugared layout itself is not mutated by compiling it.
  assert.ok(findType(sugared.lanes[0].slots[1], 'link'));
});

function findType(slot, type) {
  return slot.blocks.find((b) => b.type === type) || null;
}

// --------------------------------------------------------------------------
// DOM: build, aria, placement
// --------------------------------------------------------------------------

test('DOM mock installs', () => {
  globalThis.document = mockDocument;
});

function makeEditor(overrides = {}) {
  const container = mockElement('div');
  const changes = [];
  const editor = blocks.createBlockEditor(container, {
    track: 'melody',
    value: { mode: 'manual', weights: [1], steps: lane() },
    onChange: (params) => changes.push(params),
    ...overrides,
  });
  return { container, editor, changes };
}

function paletteButton(editor, type) {
  const palette = editor.el.children.find((child) => child.className === 'block-palette');
  return palette.children.find((child) => child.getAttribute
    && child.getAttribute('data-block') === type);
}

function rows(editor) {
  const grid = editor.el.children.find((child) => child.className === 'block-lanes');
  return grid.children;
}

function slotCell(editor, rowIndex, slotIndex) {
  // Child 0 of a row is the rowheader.
  return rows(editor)[rowIndex].children[slotIndex + 1];
}

test('DOM: palette, grid and aria contract', () => {
  const { container, editor } = makeEditor();
  assert.equal(container.children[0], editor.el);
  const grid = editor.el.children.find((child) => child.className === 'block-lanes');
  assert.equal(grid.getAttribute('role'), 'grid');
  assert.equal(grid.getAttribute('aria-label'), 'Melody block sequence');
  const row = rows(editor)[0];
  assert.equal(row.getAttribute('role'), 'row');
  assert.equal(row.children[0].getAttribute('role'), 'rowheader');
  assert.equal(row.children.length, 1 + 16, '4/4 renders sixteen slots plus the row header');

  const cell = slotCell(editor, 0, 0);
  assert.equal(cell.getAttribute('role'), 'gridcell');
  assert.equal(cell.getAttribute('aria-label'), 'Beat 1: rest');
  assert.equal(cell.style.minWidth, '44px');
  assert.equal(cell.style.minHeight, '44px');

  const palette = editor.el.children.find((child) => child.className === 'block-palette');
  assert.equal(palette.getAttribute('role'), 'toolbar');
  const stepButton = paletteButton(editor, 'step');
  assert.equal(stepButton.getAttribute('aria-pressed'), 'true', 'Step is selected by default');
  assert.equal(stepButton.style.minHeight, '44px');
  assert.equal(paletteButton(editor, 'group').getAttribute('aria-pressed'), 'false');
  editor.destroy();
});

test('DOM: roving tabindex — the grid is one tab stop', () => {
  const { editor } = makeEditor();
  assert.equal(slotCell(editor, 0, 0).getAttribute('tabindex'), '0');
  assert.equal(slotCell(editor, 0, 1).getAttribute('tabindex'), '-1');
  slotCell(editor, 0, 0).dispatch('keydown', { key: 'ArrowRight' });
  assert.equal(slotCell(editor, 0, 0).getAttribute('tabindex'), '-1');
  assert.equal(slotCell(editor, 0, 1).getAttribute('tabindex'), '0');
  assert.equal(slotCell(editor, 0, 1).focused, true);
  editor.destroy();
});

test('DOM: pointer placement — press a palette block, release over a slot', () => {
  const { editor } = makeEditor();
  paletteButton(editor, 'step').dispatch('pointerdown', { button: 0, pointerId: 1 });
  slotCell(editor, 0, 3).dispatch('pointerenter');
  slotCell(editor, 0, 3).dispatch('pointerup', { pointerId: 1 });
  assert.equal(editor.getValue().steps[3].on, true);
  assert.equal(slotCell(editor, 0, 3).getAttribute('aria-label'), 'Beat 4: step');

  // A plain click on a slot places whatever is currently selected.
  slotCell(editor, 0, 5).dispatch('pointerup', { pointerId: 2 });
  assert.equal(editor.getValue().steps[5].on, true);

  // A drag released away from the grid places nothing.
  paletteButton(editor, 'rest').dispatch('pointerdown', { button: 0, pointerId: 3 });
  for (const fn of docListeners.get('pointerup')) fn({ type: 'pointerup' });
  assert.equal(editor.getValue().steps[3].on, true, 'the cancelled drag left beat 4 alone');
  editor.destroy();
});

test('DOM: keyboard placement — select, arrow, Enter to place, Delete to remove', () => {
  const { editor } = makeEditor();
  paletteButton(editor, 'step').dispatch('click');
  slotCell(editor, 0, 0).dispatch('keydown', { key: 'End' });
  slotCell(editor, 0, 15).dispatch('keydown', { key: 'Enter' });
  assert.equal(editor.getValue().steps[15].on, true);

  paletteButton(editor, 'tie').dispatch('click');
  slotCell(editor, 0, 15).dispatch('keydown', { key: ' ' });
  assert.equal(editor.getValue().steps[15].tie, true);
  assert.equal(
    slotCell(editor, 0, 15).getAttribute('aria-label'),
    'Beat 16: step, tied into the next beat',
  );
  // Placing a tie twice toggles it back off.
  slotCell(editor, 0, 15).dispatch('keydown', { key: 'Enter' });
  assert.equal(editor.getValue().steps[15].tie, undefined);

  slotCell(editor, 0, 15).dispatch('keydown', { key: 'Delete' });
  assert.equal(editor.getValue().steps[15].on, false);
  assert.equal(slotCell(editor, 0, 15).getAttribute('aria-label'), 'Beat 16: rest');

  slotCell(editor, 0, 15).dispatch('keydown', { key: 'Home' });
  assert.equal(slotCell(editor, 0, 0).getAttribute('tabindex'), '0');
  editor.destroy();
});

test('DOM: parameterised blocks read the palette settings', () => {
  const { editor } = makeEditor();
  const settingsInputs = (label) => {
    const palette = editor.el.children.find((child) => child.className === 'block-palette');
    const settings = palette.children.find((child) => child.className === 'block-settings');
    const field = settings.children.find((child) => child.children[0].textContent === label);
    return field.children[1];
  };

  paletteButton(editor, 'prob').dispatch('click');
  const chance = settingsInputs('Chance %');
  chance.value = '40';
  chance.dispatch('input');
  const chanceMax = settingsInputs('to % (optional)');
  chanceMax.value = '90';
  chanceMax.dispatch('input');
  slotCell(editor, 0, 2).dispatch('keydown', { key: 'ArrowLeft' }); // move focus, no placement
  slotCell(editor, 0, 2).dispatch('pointerup', {});
  assert.deepEqual(editor.getValue().steps[2].prob, { min: 0.4, max: 0.9 });
  assert.equal(
    slotCell(editor, 0, 2).getAttribute('aria-label'),
    'Beat 3: step, chance 40 to 90 per cent, drifting',
  );

  paletteButton(editor, 'band').dispatch('click');
  const soft = settingsInputs('Softest %');
  soft.value = '20';
  soft.dispatch('input');
  slotCell(editor, 0, 2).dispatch('pointerup', {});
  assert.equal(editor.getValue().steps[2].vmin, 0.2);
  assert.equal(editor.getValue().steps[2].vmax, 0.9);

  paletteButton(editor, 'group').dispatch('click');
  const group = settingsInputs('Group');
  group.value = '3';
  group.dispatch('change');
  slotCell(editor, 0, 2).dispatch('pointerup', {});
  assert.equal(editor.getValue().steps[2].group, 3);
  assert.match(slotCell(editor, 0, 2).getAttribute('aria-label'), /group 3$/);
  // Group badges are colour-coded off the six track identity tokens.
  const badge = slotCell(editor, 0, 2).children.find((child) => child.textContent === 'G3');
  assert.equal(badge.style.color, 'var(--track-bass, #51702e)');
  editor.destroy();
});

test('DOM: a modifier dropped on a rest promotes it to a step', () => {
  const { editor } = makeEditor();
  paletteButton(editor, 'band').dispatch('click');
  assert.equal(editor.getValue().steps[7].on, false);
  slotCell(editor, 0, 7).dispatch('pointerup', {});
  assert.equal(editor.getValue().steps[7].on, true);
  editor.destroy();
});

test('DOM: Gate block — palette stepper places, edits and round-trips; badge and width-fraction bar', () => {
  const { editor } = makeEditor();
  const gateInput = () => {
    const palette = editor.el.children.find((c) => c.className === 'block-palette');
    const settingsEl = palette.children.find((c) => c.className === 'block-settings');
    const field = settingsEl.children.find((c) => c.children[0].textContent === 'Gate ×');
    return field.children[1];
  };

  paletteButton(editor, 'gate').dispatch('click');
  assert.equal(gateInput().getAttribute('min'), '0.1');
  assert.equal(gateInput().getAttribute('max'), '2');
  gateInput().value = '1.7';
  gateInput().dispatch('input');
  slotCell(editor, 0, 4).dispatch('pointerup', {});

  assert.equal(editor.getValue().steps[4].gate, 1.7);
  assert.equal(editor.getValue().steps[4].on, true, 'a modifier on a rest promotes it to a step');
  assert.equal(slotCell(editor, 0, 4).getAttribute('aria-label'), 'Beat 5: step, gate 170 per cent');
  const badge = slotCell(editor, 0, 4).children.find((c) => c.textContent === '⏱1.7×');
  assert.ok(badge, 'the badge carries the numeric multiplier');
  const bar = slotCell(editor, 0, 4).children.find((c) => c.className === 'block-slot-gate-bar');
  assert.equal(bar.style.width, '85%', 'width-fraction of the 0.1-2 range (1.7/2)');

  // Editing the stepper again re-places with the new value (keyboard-editable, not one-shot).
  gateInput().value = '0.4';
  gateInput().dispatch('input');
  slotCell(editor, 0, 4).dispatch('pointerup', {});
  assert.equal(editor.getValue().steps[4].gate, 0.4);
  editor.destroy();
});

test('DOM: tie + gate composition — the aria label says the gate scales the whole tied span', () => {
  const { editor } = makeEditor({
    value: {
      mode: 'manual',
      weights: [1],
      steps: lane({
        2: step({ on: true, tie: true, gate: 1.5 }),
        5: step({ on: true, gate: 0.5 }), // gate alone, no tie — plain phrasing
      }),
    },
  });
  assert.equal(
    slotCell(editor, 0, 2).getAttribute('aria-label'),
    'Beat 3: step, tied into the next beat, gate 150 per cent, scaling the tied span',
  );
  assert.equal(
    slotCell(editor, 0, 5).getAttribute('aria-label'),
    'Beat 6: step, gate 50 per cent',
  );
  editor.destroy();
});

test('tie + gate composition: the compiled output carries gate on the slot it was placed on, ties across the run', () => {
  const layout = blankLayout();
  // Same-lane forward link (0 -> 3) is sugar for a tie run across 0,1,2; the
  // gate rides on the run's SOUNDING (starting) slot, which is where the
  // engine reads the note it schedules from.
  layout.lanes[0].slots[0] = {
    kind: 'step',
    blocks: [{ type: 'link', lane: 'main', index: 3 }, { type: 'gate', value: 1.8 }],
  };
  const compiled = blocks.toParams(layout);
  for (let i = 0; i < 3; i++) assert.equal(compiled.steps[i].tie, true, `slot ${i} ties into the run`);
  assert.equal(compiled.steps[0].gate, 1.8, 'the gate rides on the run-starting slot');
  assert.equal(compiled.steps[1].gate, undefined, 'interior tied filler slots carry no gate of their own');
  assert.equal(compiled.steps[3].tie, undefined, 'the target beat is not itself tied');
});

test('DOM: percussion renders three lanes, High at the top, Low at the bottom', () => {
  const { editor } = makeEditor({
    track: 'percussion',
    value: percussionSequencer(),
  });
  const laneRows = rows(editor);
  assert.equal(laneRows.length, 3);
  assert.deepEqual(laneRows.map((row) => row.children[0].textContent), ['High', 'Mid', 'Low']);
  assert.equal(slotCell(editor, 0, 2).getAttribute('aria-label'),
    'Beat 3, High lane: step, tied into the next beat');
  // ArrowDown moves down the SCREEN: High → Mid.
  slotCell(editor, 0, 2).dispatch('keydown', { key: 'ArrowDown' });
  assert.equal(slotCell(editor, 1, 2).getAttribute('tabindex'), '0');
  slotCell(editor, 1, 2).dispatch('keydown', { key: 'ArrowUp' });
  assert.equal(slotCell(editor, 0, 2).getAttribute('tabindex'), '0');
  editor.destroy();
});

test('DOM: legacy plain-string lanes array still reverses — the real page caller relies on this', () => {
  // index.astro hands blocks.js the schema's own low→mid→high order (a plain
  // string array, the pre-v21 API) and depends on blocks.js putting High on
  // top underneath it. This must not regress.
  const { editor } = makeEditor({
    track: 'percussion',
    value: percussionSequencer(),
    lanes: ['low', 'mid', 'high'],
  });
  const laneRows = rows(editor);
  assert.deepEqual(laneRows.map((row) => row.children[0].textContent), ['High', 'Mid', 'Low']);
  editor.destroy();
});

test('DOM: dynamic [{id,label}] lanes render in EXACTLY the given order — nothing reversed', () => {
  const { editor } = makeEditor({
    track: 'percussion',
    value: dynamicKitSequencer(),
    lanes: DYNAMIC_LANES_ASCENDING, // low, mid, high, toms — the schema order, not the display order
  });
  const laneRows = rows(editor);
  assert.equal(laneRows.length, 4);
  assert.deepEqual(laneRows.map((row) => row.children[0].textContent), ['Low', 'Mid', 'High', 'Toms']);
  editor.destroy();
});

test('DOM: dynamic lane labels override the capitalised-id fallback (row header, aria, link picker)', () => {
  const { editor } = makeEditor({
    track: 'percussion',
    value: dynamicKitSequencer(),
    lanes: [
      { id: 'high', label: 'High' },
      { id: 'toms', label: 'Floor Toms' },
    ],
  });
  const laneRows = rows(editor);
  assert.deepEqual(laneRows.map((row) => row.children[0].textContent), ['High', 'Floor Toms']);
  assert.equal(
    slotCell(editor, 1, 0).getAttribute('aria-label'),
    'Beat 1, Floor Toms lane: rest',
  );
  editor.destroy();
});

test('DOM: editing a lane writes into that lane only', () => {
  const { editor } = makeEditor({ track: 'percussion', value: percussionSequencer() });
  paletteButton(editor, 'step').dispatch('click');
  slotCell(editor, 2, 4).dispatch('pointerup', {}); // row 2 = Low lane
  const out = editor.getValue();
  assert.equal(out.steps.low[4].on, true);
  assert.equal(out.steps.high[4].on, false);
  assert.equal(out.steps.mid[4].on, true, 'the mid lane fixture is untouched');
  editor.destroy();
});

// --------------------------------------------------------------------------
// onChange, setValue, destroy
// --------------------------------------------------------------------------

test('onChange: debounced — a burst of edits yields ONE call with the final params', () => {
  const clock = installFakeClock();
  try {
    const { editor, changes } = makeEditor({ debounce: 100 });
    paletteButton(editor, 'step').dispatch('click');
    slotCell(editor, 0, 0).dispatch('pointerup', {});
    slotCell(editor, 0, 1).dispatch('pointerup', {});
    clock.advance(80);
    assert.equal(changes.length, 0, 'nothing fires before the window closes');
    slotCell(editor, 0, 2).dispatch('pointerup', {});
    clock.advance(80);
    assert.equal(changes.length, 0, 'each edit restarts the window');
    clock.advance(40);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].steps[0].on, true);
    assert.equal(changes[0].steps[2].on, true);
    assert.equal(changes[0].mode, 'manual');
    assert.equal(clock.pendingCount(), 0);
    editor.destroy();
  } finally {
    clock.restore();
  }
});

test('onChange: a user edit flips an auto sequencer to manual; a pure compile does not', () => {
  const auto = { mode: 'auto', weights: [1], steps: lane({ 1: step({ on: true }) }) };
  assert.equal(blocks.toParams(blocks.fromParams(auto, { track: 'bass' })).mode, 'auto');
  const clock = installFakeClock();
  try {
    const { editor } = makeEditor({ track: 'bass', value: auto });
    assert.equal(editor.getValue().mode, 'auto');
    slotCell(editor, 0, 0).dispatch('pointerup', {});
    assert.equal(editor.getValue().mode, 'manual');
    editor.destroy();
  } finally {
    clock.restore();
  }
});

test('setValue: re-renders silently and drops a pending onChange', () => {
  const clock = installFakeClock();
  try {
    const { editor, changes } = makeEditor({ debounce: 100 });
    paletteButton(editor, 'step').dispatch('click');
    slotCell(editor, 0, 0).dispatch('pointerup', {});
    assert.equal(clock.pendingCount(), 1);
    editor.setValue({ mode: 'manual', weights: [1], steps: lane({ 9: step({ on: true, prob: 0.25 }) }) });
    assert.equal(clock.pendingCount(), 0, 'the superseded change is cancelled');
    clock.advance(500);
    assert.deepEqual(changes, [], 'setValue never calls onChange');
    assert.equal(editor.getValue().steps[0].on, false);
    assert.equal(editor.getValue().steps[9].prob, 0.25);
    assert.equal(slotCell(editor, 0, 9).getAttribute('aria-label'), 'Beat 10: step, chance 25 per cent');
    editor.destroy();
  } finally {
    clock.restore();
  }
});

test('setValue: same shape refreshes in place, a new lane shape rebuilds the grid', () => {
  const { editor } = makeEditor();
  const cellBefore = slotCell(editor, 0, 0);
  editor.setValue({ mode: 'manual', weights: [1], steps: lane({ 0: step({ on: true }) }) });
  assert.equal(rows(editor).length, 1);
  assert.equal(slotCell(editor, 0, 0), cellBefore, 'an unchanged shape keeps its cells');
  assert.equal(cellBefore.getAttribute('aria-label'), 'Beat 1: step');

  // Handed a lane map, the grid follows the DATA rather than rendering nothing.
  editor.setValue(percussionSequencer());
  assert.equal(rows(editor).length, 3);
  assert.notEqual(slotCell(editor, 0, 0), cellBefore, 'the old cells are discarded');
  assert.deepEqual(cellBefore.listenerTypes(), [], 'and their listeners with them');
  editor.destroy();
});

test('getValue: hands back a deep copy — mutating it cannot reach the editor', () => {
  const { editor } = makeEditor();
  const first = editor.getValue();
  first.steps[0].on = true;
  first.steps[0].prob = 0.1;
  assert.equal(editor.getValue().steps[0].on, false);
  assert.equal(editor.getValue().steps[0].prob, 1);
  editor.destroy();
});

test('destroy: removes the node, drops every listener, leaves zero timers, and repeats safely', () => {
  const clock = installFakeClock();
  try {
    const { container, editor, changes } = makeEditor({ debounce: 100 });
    const cell = slotCell(editor, 0, 0);
    const button = paletteButton(editor, 'step');
    const docBefore = mockDocument.listenerCount('pointerup');
    slotCell(editor, 0, 0).dispatch('pointerup', {}); // leaves a debounce pending
    assert.equal(clock.pendingCount(), 1);

    editor.destroy();
    assert.equal(container.children.length, 0);
    assert.deepEqual(cell.listenerTypes(), []);
    assert.deepEqual(button.listenerTypes(), []);
    assert.equal(mockDocument.listenerCount('pointerup'), docBefore - 1);
    assert.equal(clock.pendingCount(), 0, 'zero timers when destroyed');
    clock.advance(1000);
    assert.deepEqual(changes, [], 'the pending change never lands after destroy');

    editor.destroy(); // idempotent
    editor.setValue({ mode: 'manual', weights: [1], steps: lane() }); // inert, must not throw
  } finally {
    clock.restore();
  }
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
