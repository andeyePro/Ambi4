/**
 * blocks.js — Scratch-inspired BLOCK EDITOR for step-sequencer patterns
 * (v16 addendum, "Block editor v1"). Binding scope: PATTERNS, not arbitrary
 * code — every block compiles to a field the sequencer schema already has.
 *
 *   export function createBlockEditor(container, { track, lanes, value,
 *     onChange, timeSignature?, sequencerIndex?, debounce? })
 *     => { el, destroy(), setValue(v), getValue() }
 *   export function fromParams(value, opts) => Layout   // params → blocks
 *   export function toParams(layout)       => value     // blocks → params
 *   export function normaliseLayout(layout) => Layout   // sugar expanded
 *
 * `lanes` accepts either the original plain id array (`['low','mid','high']`
 * — legacy callers, unaffected: multi-lane still renders bottom-up so a
 * caller handing the schema's low→mid→high order gets High at the top, same
 * as always) OR the v21 dynamic form `[{id, label}]` for arbitrary lane ids —
 * built-in or user-added (up to 8). The dynamic form renders in EXACTLY the
 * given order (the caller owns visual top-to-bottom placement; nothing is
 * reversed), and a lane's `label` (when given) replaces the capitalised-id
 * fallback everywhere a lane name is shown (row header, aria text, the link
 * block's lane picker).
 *
 * ## Block vocabulary (the palette, top to bottom)
 *
 * | block            | meaning                                   | compiles to        |
 * |------------------|-------------------------------------------|--------------------|
 * | Step             | this beat sounds                          | `step.on = true`   |
 * | Rest             | this beat is silent                       | `step.on = false`  |
 * | Tie to next      | hold through the following beat           | `step.tie = true`  |
 * | Tie to beat N…   | link this beat to beat N (of lane L)      | ties OR a group id |
 * | Chance           | firing probability, 0–100 %, optional     | `step.prob`        |
 * |                  | min–max (a drifting v7 RangeValue)        | (number/{min,max}) |
 * | Velocity         | loudness band for this beat               | `step.vmin/vmax`   |
 * | Gate             | how long the beat holds, 10–200 %         | `step.gate`         |
 * | Group            | colour-coded conditional-trig group       | `step.group` (int) |
 * | Repeat x beats   | tile the x beats under it across the bar  | (expanded, sugar)  |
 *
 * Step/Rest are a slot's PRIMARY block; the rest are modifiers that attach to
 * it. Dropping a modifier on a rest promotes it to a step — the engine skips
 * `on:false` slots before it reads prob/group at all, so a modifier on a rest
 * could never mean anything.
 *
 * Gate composes with Tie the way the engine reads it: a tie run (this slot's
 * `tie:true` through however many following slots the link/drag spans) plays
 * as ONE merged note, and Gate — wherever it sits in that run — scales that
 * whole merged span, not just its own slot's beat. The badge/aria text on a
 * tied+gated slot says so explicitly rather than implying a per-slot effect.
 *
 * ## The link block ("Tie to beat N of lane L") — mapping
 *
 * The schema has exactly two ways to relate two beats, and the link block
 * compiles to whichever one fits:
 *
 * - SAME lane, target AFTER the source (N > i): a real tie. `tie` is set on
 *   every slot from i to N-1, so the engine's mergeTies() walk yields ONE note
 *   spanning beats i…N. This is the "merge beats" gesture of v13/v14.
 * - Anything else (a different lane, or a backwards/self reference): a shared
 *   `group` id written onto BOTH endpoints (reusing an id either endpoint
 *   already carries, else the next free one). Group chains are how the schema
 *   expresses "this beat is conditional on that one".
 *
 * Cross-lane caveat, deliberate and documented: the engine evaluates a group's
 * chain PER LANE (percussion resets its `sounded` map for each of low/mid/high),
 * so a cross-lane link is audible only as each lane's own chain — the shared id
 * carries the user's intent and the shared group colour, not a cross-lane
 * conditional. Nothing in the param schema can express the latter, so the block
 * degrades rather than lying about it.
 *
 * ## Round-trip
 *
 * `toParams(fromParams(p))` deep-equals `p` for any schema-shaped params (the
 * exact `tracks[t].sequencer` object, a `tracks[t]` wrapper carrying
 * `sequencers[]`, or a bare lane array / lane map — getValue() returns whatever
 * form it was given, with every sibling field preserved verbatim).
 *
 * `fromParams(toParams(l))` deep-equals `normaliseLayout(l)`, and equals `l`
 * itself for canonical layouts — the sugar-free ones fromParams produces. The
 * two sugar blocks (link, repeat) expand at compile time and therefore do not
 * survive a reload: a link comes back as the ties or the group it compiled to,
 * a repeat as the beats it stamped. No sequencer field can hold them.
 *
 * ## Interaction
 *
 * Pointer: press a palette block and release over a slot (a plain click on a
 * slot places the currently selected block too). Keyboard, no pointer needed:
 * Tab to the palette, arrows/Tab to choose a block, Tab into the grid, arrows
 * to move (left/right along a lane, up/down between lanes, Home/End to the
 * lane ends), Enter or Space to place, Delete or Backspace to clear the slot.
 * The grid is one tab stop (roving tabindex); every slot is a labelled
 * gridcell whose aria-label reads its full meaning.
 *
 * onChange(params) is debounced (default 120 ms) and fires only for user
 * edits; setValue() re-renders silently and cancels any pending call. destroy()
 * removes the DOM, drops every listener and clears the debounce timer — zero
 * timers outstanding afterwards.
 *
 * No imports; import-safe in bare Node — nothing at module scope touches
 * document/window, and createBlockEditor() without a DOM still keeps state so
 * getValue()/setValue() work headlessly.
 */

/** Every lane carries all 20 slots (contract: persist all 20); metre gates how many RENDER. */
const SLOT_COUNT = 20;

const PERCUSSION_LANES = Object.freeze(['low', 'mid', 'high']);
const SINGLE_LANE = 'main';

/** v21: percussion (and any track) lanes are dynamic, built-in + user-added, capped. */
const MAX_LANES = 8;

/** Sixteenths per bar by metre — the engine's sequencerStepsPerBar() table. */
const METRE_SLOTS = Object.freeze({ '3/4': 12, '4/4': 16, '5/4': 20, '6/8': 12, '7/8': 14 });
const DEFAULT_METRE = '4/4';

/** The engine's DEFAULT_STEP: what an unadorned block compiles to. */
const DEFAULT_PROB = 1;
const DEFAULT_VMIN = 0.5;
const DEFAULT_VMAX = 0.9;
const DEFAULT_GATE = 1;
const GATE_MIN = 0.1;
const GATE_MAX = 2;

const DEFAULT_DEBOUNCE_MS = 120;
const TARGET_PX = 44;

/** Canonical order of the modifier blocks inside a slot (round-trip stability). */
const BLOCK_ORDER = Object.freeze(['tie', 'prob', 'band', 'gate', 'group', 'link', 'repeat']);

export const BLOCK_TYPES = Object.freeze(['step', 'rest', ...BLOCK_ORDER]);

const PALETTE = Object.freeze([
  { type: 'step', label: 'Step', hint: 'This beat sounds' },
  { type: 'rest', label: 'Rest', hint: 'This beat is silent' },
  { type: 'tie', label: 'Tie to next', hint: 'Hold through the next beat' },
  { type: 'link', label: 'Tie to beat…', hint: 'Link this beat to another' },
  { type: 'prob', label: 'Chance', hint: 'How likely this beat fires' },
  { type: 'band', label: 'Velocity', hint: 'How hard this beat plays' },
  { type: 'gate', label: 'Gate', hint: 'How long this beat holds, 10–200%' },
  { type: 'group', label: 'Group', hint: 'Chain beats: each needs the last' },
  { type: 'repeat', label: 'Repeat x beats', hint: 'Tile these beats across the bar' },
]);

/**
 * Group colours reuse the six per-track identity tokens: they are the only six
 * hues in the theme already contrast-checked (AA) against --panel in BOTH
 * themes, and a group id is exactly the kind of "one of a handful of distinct
 * things" they were picked for.
 */
const GROUP_TOKENS = Object.freeze([
  ['--track-pad', '#5d4419'],
  ['--track-arp', '#296065'],
  ['--track-melody', '#4a1d11'],
  ['--track-bass', '#51702e'],
  ['--track-texture', '#964a96'],
  ['--track-percussion', '#2b3a50'],
]);

const PANEL = 'var(--panel, #f2ead9)';
const PANEL_EDGE = 'var(--panel-edge, #7a5b3a)';
const PANEL_INSET = 'var(--panel-inset, rgba(255, 255, 255, 0.65))';
const ACCENT_WARM = 'var(--accent-warm, #9d5407)';
const TEXT_COLOR = 'var(--text, #2b2620)';
const SECONDARY_COLOR = 'var(--secondary, #6b5f4e)';
const BORDER_COLOR = 'var(--border, #e3dac6)';
const LABEL_FONT =
  'var(--label-font, "Futura", "Avenir Next", "Century Gothic", "Trebuchet MS", sans-serif)';

// --------------------------------------------------------------------------
// Small pure helpers
// --------------------------------------------------------------------------

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function clampNumber(value, lo, hi, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return n < lo ? lo : n > hi ? hi : n;
}

function clampInt(value, lo, hi, fallback) {
  return Math.round(clampNumber(value, lo, hi, fallback));
}

/** A step `prob`: a number, or a v7 {min,max} range that drifts. */
function sanitiseProb(value) {
  if (isPlainObject(value)) {
    const min = clampNumber(value.min, 0, 1, DEFAULT_PROB);
    const max = clampNumber(value.max, 0, 1, DEFAULT_PROB);
    return min <= max ? { min, max } : { min: max, max: min };
  }
  return clampNumber(value, 0, 1, DEFAULT_PROB);
}

function cloneProb(value) {
  return isPlainObject(value) ? { min: value.min, max: value.max } : value;
}

/** A step `gate`: 0.1–2, how long the beat holds relative to a full beat. */
function sanitiseGate(value) {
  return clampNumber(value, GATE_MIN, GATE_MAX, DEFAULT_GATE);
}

function probEquals(a, b) {
  if (isPlainObject(a) || isPlainObject(b)) {
    return isPlainObject(a) && isPlainObject(b) && a.min === b.min && a.max === b.max;
  }
  return a === b;
}

/** Params are plain JSON; a structural clone keeps unknown sibling fields intact. */
function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function pct(v) {
  return Math.round(v * 100);
}

function capitalise(text) {
  const s = String(text);
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

export function blockSlotsPerBar(timeSignature) {
  return METRE_SLOTS[timeSignature] || METRE_SLOTS[DEFAULT_METRE];
}

// --------------------------------------------------------------------------
// Blocks within a slot
// --------------------------------------------------------------------------

function findBlock(slot, type) {
  if (!slot || !Array.isArray(slot.blocks)) return null;
  return slot.blocks.find((block) => block && block.type === type) || null;
}

function cloneBlock(block) {
  if (block.type === 'prob') return { type: 'prob', value: cloneProb(block.value) };
  if (block.type === 'band') return { type: 'band', vmin: block.vmin, vmax: block.vmax };
  if (block.type === 'gate') return { type: 'gate', value: block.value };
  if (block.type === 'group') return { type: 'group', id: block.id };
  if (block.type === 'link') return { type: 'link', lane: block.lane, index: block.index };
  if (block.type === 'repeat') return { type: 'repeat', beats: block.beats };
  return { type: block.type };
}

function sortBlocks(blocks) {
  blocks.sort((a, b) => BLOCK_ORDER.indexOf(a.type) - BLOCK_ORDER.indexOf(b.type));
  return blocks;
}

/** Attach (or replace) one modifier, keeping the canonical order. */
function setBlock(slot, block) {
  slot.blocks = slot.blocks.filter((existing) => existing.type !== block.type);
  slot.blocks.push(cloneBlock(block));
  sortBlocks(slot.blocks);
}

function removeBlock(slot, type) {
  slot.blocks = slot.blocks.filter((block) => block.type !== type);
}

function cloneSlot(slot) {
  return { kind: slot.kind, blocks: slot.blocks.map(cloneBlock) };
}

function emptySlot() {
  return { kind: 'rest', blocks: [] };
}

function cloneLane(lane) {
  return { id: lane.id, slots: lane.slots.map(cloneSlot) };
}

function cloneLayout(layout) {
  return {
    track: layout.track,
    mode: layout.mode,
    weights: layout.weights.slice(),
    timeSignature: layout.timeSignature,
    visibleSlots: layout.visibleSlots,
    laneForm: layout.laneForm,
    laneLabels: { ...layout.laneLabels },
    laneOrderGiven: layout.laneOrderGiven,
    lanes: layout.lanes.map(cloneLane),
    source: { form: layout.source.form, index: layout.source.index, original: cloneJson(layout.source.original) },
  };
}

// --------------------------------------------------------------------------
// params → blocks
// --------------------------------------------------------------------------

/**
 * Where the sequencer being edited lives inside `value`:
 * - 'track'     — a tracks[t] object carrying `sequencers[]` and/or `sequencer`
 * - 'sequencer' — the { mode, weights, steps } object itself
 * - 'steps'     — a bare lane array (melodic) or lane map (percussion)
 */
function unwrapValue(value, index) {
  if (isPlainObject(value) && (Array.isArray(value.sequencers) || isPlainObject(value.sequencer))) {
    const list = Array.isArray(value.sequencers) ? value.sequencers : null;
    const sequencer = list ? list[index] : index === 0 ? value.sequencer : null;
    return { form: 'track', sequencer: isPlainObject(sequencer) ? sequencer : null, original: value };
  }
  if (isPlainObject(value) && 'steps' in value) {
    return { form: 'sequencer', sequencer: value, original: value };
  }
  if (Array.isArray(value) || isPlainObject(value)) {
    return { form: 'steps', sequencer: { steps: value }, original: value };
  }
  return { form: 'sequencer', sequencer: null, original: undefined };
}

/**
 * `opts.lanes` in the original (legacy) form is a plain id array — still
 * accepted verbatim, still renders bottom-up (see displayOrder()) so the
 * existing low→mid→high caller keeps getting High at the top unchanged.
 * The v21 dynamic form is `[{id, label?}]`: arbitrary ids, an optional
 * display label per lane, and the caller's own order is what renders — a
 * mix of the two forms in one array still counts as dynamic. Either form
 * dedupes ids and caps at MAX_LANES.
 */
function normaliseLaneSpec(optLanes) {
  if (!Array.isArray(optLanes) || !optLanes.length) return null;
  const ids = [];
  const labels = {};
  let dynamic = false;
  for (const item of optLanes) {
    if (ids.length >= MAX_LANES) break;
    let id = null;
    if (isPlainObject(item) && item.id != null) {
      dynamic = true;
      id = String(item.id);
      if (id && typeof item.label === 'string' && item.label) labels[id] = item.label;
    } else if (item != null) {
      id = String(item);
    }
    if (!id || ids.includes(id)) continue;
    ids.push(id);
  }
  return ids.length ? { ids, labels, dynamic } : null;
}

function resolveLanes(optLanes, track, steps) {
  const spec = normaliseLaneSpec(optLanes);
  if (spec) {
    return {
      ids: spec.ids,
      labels: spec.labels,
      form: spec.ids.length > 1 || spec.ids[0] !== SINGLE_LANE ? 'map' : 'single',
      orderGiven: spec.dynamic,
    };
  }
  if (Array.isArray(steps)) return { ids: [SINGLE_LANE], labels: {}, form: 'single', orderGiven: false };
  if (isPlainObject(steps)) {
    const ids = Object.keys(steps).filter((key) => Array.isArray(steps[key]));
    if (ids.length) return { ids, labels: {}, form: 'map', orderGiven: false };
  }
  if (track === 'percussion') return { ids: PERCUSSION_LANES.slice(), labels: {}, form: 'map', orderGiven: false };
  return { ids: [SINGLE_LANE], labels: {}, form: 'single', orderGiven: false };
}

/**
 * One param step → one slot. A step whose fields are all at the engine's
 * defaults yields a bare Step/Rest block, which is what keeps the canvas
 * readable and the layout round-trip exact.
 */
function slotFromStep(step) {
  if (typeof step === 'boolean') return { kind: step ? 'step' : 'rest', blocks: [] };
  if (!isPlainObject(step)) return emptySlot();
  const slot = { kind: step.on === false ? 'rest' : 'step', blocks: [] };
  const prob = sanitiseProb('prob' in step ? step.prob : DEFAULT_PROB);
  if (!probEquals(prob, DEFAULT_PROB)) slot.blocks.push({ type: 'prob', value: prob });
  let vmin = clampNumber(step.vmin, 0, 1, DEFAULT_VMIN);
  let vmax = clampNumber(step.vmax, 0, 1, DEFAULT_VMAX);
  if (vmin > vmax) [vmin, vmax] = [vmax, vmin];
  if (vmin !== DEFAULT_VMIN || vmax !== DEFAULT_VMAX) slot.blocks.push({ type: 'band', vmin, vmax });
  const gate = sanitiseGate('gate' in step ? step.gate : DEFAULT_GATE);
  if (gate !== DEFAULT_GATE) slot.blocks.push({ type: 'gate', value: gate });
  if (step.tie === true) slot.blocks.push({ type: 'tie' });
  if (Number.isFinite(step.group) && step.group >= 0) {
    slot.blocks.push({ type: 'group', id: Math.round(step.group) });
  }
  sortBlocks(slot.blocks);
  return slot;
}

/** One slot → one param step, in the engine's own field order. */
function compileSlot(slot) {
  const prob = findBlock(slot, 'prob');
  const band = findBlock(slot, 'band');
  const gate = findBlock(slot, 'gate');
  const group = findBlock(slot, 'group');
  const step = {
    on: slot.kind === 'step',
    prob: prob ? cloneProb(prob.value) : DEFAULT_PROB,
    vmin: band ? band.vmin : DEFAULT_VMIN,
    vmax: band ? band.vmax : DEFAULT_VMAX,
  };
  if (gate) step.gate = gate.value;
  if (findBlock(slot, 'tie')) step.tie = true;
  if (group) step.group = group.id;
  return step;
}

/**
 * Rebuild the block layout from sequencer params. Absent lanes (and slots
 * beyond a short lane) come back as rests: a block canvas with nothing on it
 * must be silent, not a sixteenth-note machine gun.
 */
export function fromParams(value, options) {
  const opts = options || {};
  const index = Number.isInteger(opts.sequencerIndex) && opts.sequencerIndex >= 0
    ? opts.sequencerIndex : 0;
  const { form, sequencer, original } = unwrapValue(value, index);
  const track = typeof opts.track === 'string' && opts.track ? opts.track : 'melody';
  const timeSignature = opts.timeSignature in METRE_SLOTS ? opts.timeSignature : DEFAULT_METRE;
  const steps = sequencer ? sequencer.steps : null;
  const { ids, labels: laneLabels, form: laneForm, orderGiven: laneOrderGiven } =
    resolveLanes(opts.lanes, track, steps);

  const lanes = ids.map((id) => {
    const source = laneForm === 'map'
      ? (isPlainObject(steps) ? steps[id] : null)
      : (Array.isArray(steps) ? steps : null);
    const slots = new Array(SLOT_COUNT);
    for (let i = 0; i < SLOT_COUNT; i++) {
      slots[i] = source && i < source.length ? slotFromStep(source[i]) : emptySlot();
    }
    return { id, slots };
  });

  const weights = sequencer && Array.isArray(sequencer.weights) && sequencer.weights.length
    ? sequencer.weights.map((w) => clampNumber(w, 0, 100, 0))
    : [1];

  return {
    track,
    // A block canvas is inherently a manual pattern, but an 'auto' sequencer
    // keeps its mode through a pure compile — only a user EDIT flips it.
    mode: sequencer && sequencer.mode === 'auto' ? 'auto' : 'manual',
    weights,
    timeSignature,
    visibleSlots: blockSlotsPerBar(timeSignature),
    laneForm,
    laneLabels,
    laneOrderGiven,
    lanes,
    source: { form, index, original: cloneJson(original) },
  };
}

// --------------------------------------------------------------------------
// blocks → params
// --------------------------------------------------------------------------

function maxGroupId(layout) {
  let max = -1;
  for (const lane of layout.lanes) {
    for (const slot of lane.slots) {
      const group = findBlock(slot, 'group');
      if (group && group.id > max) max = group.id;
    }
  }
  return max;
}

/**
 * Expand the two sugar blocks — Repeat (tiles its beats across the rest of the
 * lane) and the link block (ties or a shared group id, per the mapping in the
 * module header) — leaving a canonical layout that maps 1:1 onto the schema.
 * A sugar-free layout comes back unchanged (a deep copy).
 */
export function normaliseLayout(layout) {
  const out = cloneLayout(layout);
  const visible = out.visibleSlots;

  for (const lane of out.lanes) {
    for (let i = 0; i < visible; i++) {
      const repeat = findBlock(lane.slots[i], 'repeat');
      if (!repeat) continue;
      removeBlock(lane.slots[i], 'repeat');
      const beats = clampInt(repeat.beats, 1, visible, 4);
      const body = [];
      for (let k = 0; k < beats && i + k < visible; k++) body.push(cloneSlot(lane.slots[i + k]));
      if (!body.length) continue;
      // Copies carry the pattern, not the sugar: a stamped link would point at
      // beats the copy never had, and a stamped repeat would tile for ever.
      for (const slot of body) {
        slot.blocks = slot.blocks.filter((block) => block.type !== 'link' && block.type !== 'repeat');
      }
      for (let start = i + body.length; start < visible; start += body.length) {
        for (let k = 0; k < body.length && start + k < visible; k++) {
          lane.slots[start + k] = cloneSlot(body[k]);
        }
      }
      i += body.length - 1;
    }
  }

  let nextGroup = maxGroupId(out) + 1;
  for (const lane of out.lanes) {
    for (let i = 0; i < visible; i++) {
      const link = findBlock(lane.slots[i], 'link');
      if (!link) continue;
      removeBlock(lane.slots[i], 'link');
      const target = out.lanes.find((candidate) => candidate.id === link.lane) || lane;
      const at = Math.round(Number(link.index));
      // An unresolvable link is dropped, not guessed at.
      if (!Number.isFinite(at) || at < 0 || at >= visible) continue;
      if (target === lane && at === i) continue;
      if (target === lane && at > i) {
        for (let k = i; k < at; k++) setBlock(lane.slots[k], { type: 'tie' });
        continue;
      }
      const existing = findBlock(lane.slots[i], 'group') || findBlock(target.slots[at], 'group');
      const id = existing ? existing.id : nextGroup++;
      setBlock(lane.slots[i], { type: 'group', id });
      setBlock(target.slots[at], { type: 'group', id });
    }
  }

  return out;
}

/** Put the compiled sequencer back into whatever wrapper the value arrived in. */
function rewrap(source, sequencer) {
  if (source.form === 'steps') return sequencer.steps;
  if (source.form === 'track') {
    const out = isPlainObject(source.original) ? cloneJson(source.original) : {};
    if (Array.isArray(out.sequencers)) {
      out.sequencers[source.index] = sequencer;
      if ('sequencer' in out && source.index === 0) out.sequencer = out.sequencers[0];
    } else {
      out.sequencer = sequencer;
    }
    return out;
  }
  const out = isPlainObject(source.original) ? cloneJson(source.original) : {};
  const hadWeights = isPlainObject(source.original) && 'weights' in source.original;
  out.mode = sequencer.mode;
  if (hadWeights) out.weights = sequencer.weights;
  else delete out.weights;
  out.steps = sequencer.steps;
  return out;
}

/** Compile a block layout to the sequencer param shape it came from. */
export function toParams(layout) {
  const norm = normaliseLayout(layout);
  const steps = norm.laneForm === 'map'
    ? Object.fromEntries(norm.lanes.map((lane) => [lane.id, lane.slots.map(compileSlot)]))
    : norm.lanes[0].slots.map(compileSlot);
  return rewrap(norm.source, { mode: norm.mode, weights: norm.weights.slice(), steps });
}

// --------------------------------------------------------------------------
// Descriptions (aria + badges)
// --------------------------------------------------------------------------

function laneLabel(id, labels) {
  if (labels && typeof labels[id] === 'string' && labels[id]) return labels[id];
  return id === SINGLE_LANE ? '' : capitalise(id);
}

function describeSlot(layout, laneId, index, slot) {
  const parts = [slot.kind === 'step' ? 'step' : 'rest'];
  const prob = findBlock(slot, 'prob');
  if (prob) {
    parts.push(isPlainObject(prob.value)
      ? `chance ${pct(prob.value.min)} to ${pct(prob.value.max)} per cent, drifting`
      : `chance ${pct(prob.value)} per cent`);
  }
  const band = findBlock(slot, 'band');
  if (band) parts.push(`velocity ${pct(band.vmin)} to ${pct(band.vmax)} per cent`);
  const tie = findBlock(slot, 'tie');
  if (tie) parts.push('tied into the next beat');
  const gate = findBlock(slot, 'gate');
  if (gate) {
    // Composition with the engine's own merge rule: a tie run plays as ONE
    // note, so a gate sat anywhere in that run scales the WHOLE merged span,
    // not just this slot's own beat — say so, rather than implying otherwise.
    parts.push(tie
      ? `gate ${pct(gate.value)} per cent, scaling the tied span`
      : `gate ${pct(gate.value)} per cent`);
  }
  const group = findBlock(slot, 'group');
  if (group) parts.push(`group ${group.id}`);
  const link = findBlock(slot, 'link');
  if (link) {
    const where = layout.lanes.length > 1 ? ` of ${laneLabel(link.lane, layout.laneLabels)} lane` : '';
    parts.push(`tied to beat ${Math.round(link.index) + 1}${where}`);
  }
  const repeat = findBlock(slot, 'repeat');
  if (repeat) parts.push(`repeats every ${repeat.beats} beats`);
  const head = layout.lanes.length > 1
    ? `Beat ${index + 1}, ${laneLabel(laneId, layout.laneLabels)} lane`
    : `Beat ${index + 1}`;
  return `${head}: ${parts.join(', ')}`;
}

function badgesFor(slot) {
  const badges = [];
  const prob = findBlock(slot, 'prob');
  if (prob) {
    badges.push({
      text: isPlainObject(prob.value)
        ? `${pct(prob.value.min)}–${pct(prob.value.max)}%`
        : `${pct(prob.value)}%`,
      color: ACCENT_WARM,
    });
  }
  const band = findBlock(slot, 'band');
  if (band) badges.push({ text: `v${pct(band.vmin)}–${pct(band.vmax)}`, color: SECONDARY_COLOR });
  const gate = findBlock(slot, 'gate');
  if (gate) badges.push({ text: `⏱${gate.value.toFixed(1)}×`, color: ACCENT_WARM });
  if (findBlock(slot, 'tie')) badges.push({ text: '⌐tie', color: SECONDARY_COLOR });
  const group = findBlock(slot, 'group');
  if (group) badges.push({ text: `G${group.id}`, color: groupColour(group.id) });
  const link = findBlock(slot, 'link');
  if (link) badges.push({ text: `→${Math.round(link.index) + 1}`, color: ACCENT_WARM });
  const repeat = findBlock(slot, 'repeat');
  if (repeat) badges.push({ text: `⟳${repeat.beats}`, color: ACCENT_WARM });
  return badges;
}

function groupColour(id) {
  const [token, fallback] = GROUP_TOKENS[Math.abs(Math.round(id)) % GROUP_TOKENS.length];
  return `var(${token}, ${fallback})`;
}

// --------------------------------------------------------------------------
// The editor
// --------------------------------------------------------------------------

export function createBlockEditor(container, options) {
  const opts = options || {};
  const onChange = typeof opts.onChange === 'function' ? opts.onChange : null;
  const debounceMs = Number.isFinite(opts.debounce) && opts.debounce >= 0
    ? opts.debounce : DEFAULT_DEBOUNCE_MS;

  let layout = fromParams(opts.value, opts);

  function getValue() {
    return toParams(layout);
  }

  const hasDom = typeof document !== 'undefined'
    && Boolean(container)
    && typeof container.appendChild === 'function';

  if (!hasDom) {
    // No DOM (bare Node, or no container) — the state half still works, so a
    // caller can compile without rendering rather than having to guard.
    return {
      el: null,
      getValue,
      setValue(value) { layout = fromParams(value, opts); },
      destroy() {},
    };
  }

  const accent = `var(--track-${layout.track}, ${ACCENT_WARM})`;
  const listeners = []; // [node, type, fn, opts]
  const slotEls = []; // [laneIndex][slotIndex]
  let paletteButtons = [];
  let focusLane = 0;
  let focusSlot = 0;
  let selectedType = 'step';
  let dragType = null;
  let pendingChange = null;
  let destroyed = false;

  const settings = {
    prob: 0.75,
    probMax: null,
    vmin: DEFAULT_VMIN,
    vmax: DEFAULT_VMAX,
    gate: DEFAULT_GATE,
    group: 1,
    linkLane: layout.lanes[0].id,
    linkBeat: 1,
    repeatBeats: 4,
  };

  function listen(node, type, fn, listenOpts) {
    node.addEventListener(type, fn, listenOpts);
    listeners.push([node, type, fn, listenOpts]);
  }

  function el(tag, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function textSpan(className, text, color, size) {
    const span = el('span', className);
    span.textContent = text;
    if (color) span.style.color = color;
    if (size) span.style.fontSize = size;
    return span;
  }

  // -- root ----------------------------------------------------------------

  const root = el('div', 'block-editor');
  root.setAttribute('data-track', layout.track);
  root.style.display = 'flex';
  root.style.gap = '12px';
  root.style.alignItems = 'flex-start';
  root.style.flexWrap = 'wrap';
  root.style.fontFamily = LABEL_FONT;
  root.style.color = TEXT_COLOR;
  root.style.background = PANEL;
  root.style.border = `1px solid ${BORDER_COLOR}`;
  root.style.borderLeft = `4px solid ${accent}`;
  root.style.borderRadius = '8px';
  root.style.padding = '10px';

  // -- palette -------------------------------------------------------------

  const palette = el('div', 'block-palette');
  palette.setAttribute('role', 'toolbar');
  palette.setAttribute('aria-label', 'Block palette');
  palette.setAttribute('aria-orientation', 'vertical');
  palette.style.display = 'flex';
  palette.style.flexDirection = 'column';
  palette.style.gap = '6px';
  palette.style.minWidth = '150px';
  root.appendChild(palette);

  paletteButtons = PALETTE.map((item) => {
    const button = el('button', 'block-palette-item');
    button.setAttribute('type', 'button');
    button.setAttribute('data-block', item.type);
    button.setAttribute('aria-pressed', 'false');
    button.style.display = 'block';
    button.style.width = '100%';
    button.style.minHeight = `${TARGET_PX}px`;
    button.style.padding = '6px 10px';
    button.style.textAlign = 'left';
    button.style.cursor = 'grab';
    button.style.touchAction = 'none';
    button.style.borderRadius = '6px';
    button.style.border = `1px solid ${PANEL_EDGE}`;
    button.style.background = PANEL_INSET;
    button.style.color = TEXT_COLOR;
    button.style.font = 'inherit';
    button.appendChild(textSpan('block-palette-label', item.label));
    const hint = textSpan('block-palette-hint', item.hint, SECONDARY_COLOR, '0.75em');
    hint.style.display = 'block';
    button.appendChild(hint);
    listen(button, 'click', () => selectType(item.type));
    listen(button, 'pointerdown', () => {
      selectType(item.type);
      dragType = item.type;
    });
    palette.appendChild(button);
    return button;
  });

  const settingsEl = el('div', 'block-settings');
  settingsEl.style.display = 'flex';
  settingsEl.style.flexDirection = 'column';
  settingsEl.style.gap = '4px';
  settingsEl.style.marginTop = '4px';
  settingsEl.style.fontSize = '0.8em';
  settingsEl.style.color = SECONDARY_COLOR;
  palette.appendChild(settingsEl);

  function numberField(label, value, min, max, stepSize, onCommit) {
    const wrap = el('label', 'block-setting');
    wrap.style.display = 'flex';
    wrap.style.justifyContent = 'space-between';
    wrap.style.gap = '6px';
    wrap.style.alignItems = 'center';
    wrap.appendChild(textSpan('block-setting-label', label));
    const input = el('input', 'block-setting-input');
    input.setAttribute('type', 'number');
    input.setAttribute('min', String(min));
    input.setAttribute('max', String(max));
    input.setAttribute('step', String(stepSize));
    input.setAttribute('aria-label', label);
    input.value = value === null ? '' : String(value);
    input.style.width = '5.5em';
    input.style.minHeight = `${TARGET_PX}px`;
    input.style.font = 'inherit';
    listen(input, 'input', () => onCommit(input.value));
    listen(input, 'change', () => onCommit(input.value));
    wrap.appendChild(input);
    settingsEl.appendChild(wrap);
    return input;
  }

  function selectField(label, value, choices, onCommit) {
    const wrap = el('label', 'block-setting');
    wrap.style.display = 'flex';
    wrap.style.justifyContent = 'space-between';
    wrap.style.gap = '6px';
    wrap.style.alignItems = 'center';
    wrap.appendChild(textSpan('block-setting-label', label));
    const select = el('select', 'block-setting-input');
    select.setAttribute('aria-label', label);
    select.style.minHeight = `${TARGET_PX}px`;
    select.style.font = 'inherit';
    for (const choice of choices) {
      const option = el('option');
      option.setAttribute('value', choice);
      option.value = choice;
      option.textContent = laneLabel(choice, layout.laneLabels) || choice;
      select.appendChild(option);
    }
    select.value = value;
    listen(select, 'change', () => onCommit(select.value));
    wrap.appendChild(select);
    settingsEl.appendChild(wrap);
    return select;
  }

  function renderSettings() {
    settingsEl.textContent = '';
    if (selectedType === 'prob') {
      numberField('Chance %', pct(settings.prob), 0, 100, 1, (raw) => {
        settings.prob = clampNumber(Number(raw) / 100, 0, 1, settings.prob);
      });
      numberField('to % (optional)', settings.probMax === null ? null : pct(settings.probMax),
        0, 100, 1, (raw) => {
          settings.probMax = String(raw).trim() === ''
            ? null : clampNumber(Number(raw) / 100, 0, 1, settings.prob);
        });
      return;
    }
    if (selectedType === 'band') {
      numberField('Softest %', pct(settings.vmin), 0, 100, 1, (raw) => {
        settings.vmin = clampNumber(Number(raw) / 100, 0, 1, settings.vmin);
      });
      numberField('Loudest %', pct(settings.vmax), 0, 100, 1, (raw) => {
        settings.vmax = clampNumber(Number(raw) / 100, 0, 1, settings.vmax);
      });
      return;
    }
    if (selectedType === 'gate') {
      // A small value stepper: native number input, 0.1 increments across
      // the full 10–200% range, keyboard-editable (type, or arrow up/down).
      numberField('Gate ×', settings.gate, GATE_MIN, GATE_MAX, 0.1, (raw) => {
        settings.gate = sanitiseGate(raw);
      });
      return;
    }
    if (selectedType === 'group') {
      numberField('Group', settings.group, 0, 11, 1, (raw) => {
        settings.group = clampInt(raw, 0, 11, settings.group);
      });
      return;
    }
    if (selectedType === 'link') {
      if (layout.lanes.length > 1) {
        selectField('Lane', settings.linkLane, layout.lanes.map((lane) => lane.id), (raw) => {
          settings.linkLane = raw;
        });
      }
      numberField('Beat', settings.linkBeat, 1, layout.visibleSlots, 1, (raw) => {
        settings.linkBeat = clampInt(raw, 1, layout.visibleSlots, settings.linkBeat);
      });
      return;
    }
    if (selectedType === 'repeat') {
      numberField('Beats', settings.repeatBeats, 1, layout.visibleSlots, 1, (raw) => {
        settings.repeatBeats = clampInt(raw, 1, layout.visibleSlots, settings.repeatBeats);
      });
      return;
    }
    const item = PALETTE.find((entry) => entry.type === selectedType);
    settingsEl.appendChild(textSpan('block-setting-hint', item ? item.hint : ''));
  }

  function selectType(type) {
    if (!BLOCK_TYPES.includes(type)) return;
    selectedType = type;
    for (const button of paletteButtons) {
      const pressed = button.getAttribute('data-block') === type;
      button.setAttribute('aria-pressed', pressed ? 'true' : 'false');
      button.style.background = pressed ? accent : PANEL_INSET;
      button.style.color = pressed ? PANEL : TEXT_COLOR;
    }
    renderSettings();
  }

  // -- grid ----------------------------------------------------------------

  const gridEl = el('div', 'block-lanes');
  gridEl.setAttribute('role', 'grid');
  gridEl.setAttribute('aria-label', `${capitalise(layout.track)} block sequence`);
  gridEl.style.display = 'flex';
  gridEl.style.flexDirection = 'column';
  gridEl.style.gap = '4px';
  root.appendChild(gridEl);

  /**
   * Percussion renders HIGH at the top and LOW at the bottom everywhere lanes
   * appear (v14), so the display order is the reverse of the schema order the
   * params use — that is the legacy `lanes` id-array behaviour and stays
   * exactly as it was. A v21 dynamic `[{id, label}]` spec instead renders in
   * EXACTLY the order given: the caller (which now names its own lanes) owns
   * top-to-bottom placement, nothing is reversed underneath it.
   */
  function displayOrder() {
    const order = layout.lanes.map((lane, index) => index);
    if (layout.lanes.length > 1 && !layout.laneOrderGiven) order.reverse();
    return order;
  }

  function buildGrid() {
    // Grid listeners belong to nodes about to be discarded.
    for (let i = listeners.length - 1; i >= 0; i--) {
      const [node] = listeners[i];
      if (node.className === 'block-slot') {
        node.removeEventListener(listeners[i][1], listeners[i][2]);
        listeners.splice(i, 1);
      }
    }
    gridEl.textContent = '';
    slotEls.length = 0;
    for (const lane of layout.lanes) slotEls.push(new Array(layout.visibleSlots));

    for (const laneIndex of displayOrder()) {
      const lane = layout.lanes[laneIndex];
      const row = el('div', 'block-lane');
      row.setAttribute('role', 'row');
      row.style.display = 'flex';
      row.style.alignItems = 'stretch';
      row.style.gap = '4px';
      const name = el('span', 'block-lane-name');
      name.setAttribute('role', 'rowheader');
      name.textContent = laneLabel(lane.id, layout.laneLabels) || capitalise(layout.track);
      name.style.minWidth = '64px';
      name.style.alignSelf = 'center';
      name.style.color = SECONDARY_COLOR;
      row.appendChild(name);

      for (let i = 0; i < layout.visibleSlots; i++) {
        const cell = el('div', 'block-slot');
        cell.setAttribute('role', 'gridcell');
        cell.setAttribute('tabindex', '-1');
        cell.style.minWidth = `${TARGET_PX}px`;
        cell.style.minHeight = `${TARGET_PX}px`;
        cell.style.display = 'flex';
        cell.style.flexDirection = 'column';
        cell.style.alignItems = 'center';
        cell.style.justifyContent = 'center';
        cell.style.gap = '1px';
        cell.style.borderRadius = '6px';
        cell.style.cursor = 'pointer';
        cell.style.touchAction = 'none';
        cell.style.userSelect = 'none';
        cell.style.fontSize = '0.72em';
        listen(cell, 'pointerup', () => onSlotPointerUp(laneIndex, i));
        listen(cell, 'pointerenter', () => {
          if (dragType) cell.style.outline = `2px solid ${ACCENT_WARM}`;
        });
        listen(cell, 'pointerleave', () => { cell.style.outline = 'none'; });
        listen(cell, 'keydown', (event) => onSlotKeyDown(event, laneIndex, i));
        listen(cell, 'focus', () => {
          focusLane = laneIndex;
          focusSlot = i;
          setRovingTabindex();
        });
        slotEls[laneIndex][i] = cell;
        row.appendChild(cell);
      }
      gridEl.appendChild(row);
    }
    if (focusLane >= layout.lanes.length) focusLane = 0;
    if (focusSlot >= layout.visibleSlots) focusSlot = 0;
    refreshAllSlots();
    setRovingTabindex();
  }

  function setRovingTabindex() {
    for (let li = 0; li < slotEls.length; li++) {
      for (let si = 0; si < slotEls[li].length; si++) {
        const cell = slotEls[li][si];
        if (cell) cell.setAttribute('tabindex', li === focusLane && si === focusSlot ? '0' : '-1');
      }
    }
  }

  function refreshSlot(laneIndex, slotIndex) {
    const cell = slotEls[laneIndex] && slotEls[laneIndex][slotIndex];
    if (!cell) return;
    const lane = layout.lanes[laneIndex];
    const slot = lane.slots[slotIndex];
    const isStep = slot.kind === 'step';
    cell.setAttribute('aria-label', describeSlot(layout, lane.id, slotIndex, slot));
    cell.style.background = isStep ? accent : PANEL_INSET;
    cell.style.color = isStep ? PANEL : SECONDARY_COLOR;
    cell.style.border = `1px solid ${isStep ? accent : PANEL_EDGE}`;
    cell.textContent = '';
    cell.appendChild(textSpan('block-slot-beat', String(slotIndex + 1), null, '0.85em'));
    cell.appendChild(textSpan('block-slot-kind', isStep ? 'Step' : 'Rest'));
    for (const badge of badgesFor(slot)) {
      const node = textSpan('block-slot-badge', badge.text, badge.color, '0.85em');
      node.style.background = PANEL;
      node.style.borderRadius = '3px';
      node.style.padding = '0 2px';
      cell.appendChild(node);
    }
    const gate = findBlock(slot, 'gate');
    if (gate) {
      // A width-fraction bar of the gate value against its own 0.1–2 range
      // (so a full-width bar reads as the longest a beat can hold, not as
      // "the whole cell" — the value badge above still carries the number).
      const bar = el('span', 'block-slot-gate-bar');
      bar.style.display = 'block';
      bar.style.alignSelf = 'stretch';
      bar.style.height = '3px';
      bar.style.width = `${Math.round((gate.value / GATE_MAX) * 100)}%`;
      bar.style.background = isStep ? PANEL : ACCENT_WARM;
      bar.style.borderRadius = '2px';
      cell.appendChild(bar);
    }
  }

  function refreshAllSlots() {
    for (let li = 0; li < layout.lanes.length; li++) {
      for (let si = 0; si < layout.visibleSlots; si++) refreshSlot(li, si);
    }
  }

  // -- editing -------------------------------------------------------------

  function scheduleChange() {
    if (!onChange) return;
    if (pendingChange !== null) clearTimeout(pendingChange);
    pendingChange = setTimeout(() => {
      pendingChange = null;
      onChange(getValue());
    }, debounceMs);
  }

  /** Place the selected block on a slot. Returns true if anything changed. */
  function placeBlock(laneIndex, slotIndex, type) {
    const lane = layout.lanes[laneIndex];
    const slot = lane.slots[slotIndex];
    if (!slot) return false;
    if (type === 'step' || type === 'rest') {
      slot.kind = type;
    } else if (type === 'tie') {
      if (findBlock(slot, 'tie')) removeBlock(slot, 'tie');
      else setBlock(slot, { type: 'tie' });
      if (slot.kind === 'rest') slot.kind = 'step';
    } else {
      // A modifier only means anything on a sounding beat: the engine skips
      // `on:false` slots before it ever reads prob/group.
      if (slot.kind === 'rest') slot.kind = 'step';
      if (type === 'prob') {
        const value = settings.probMax === null
          ? settings.prob
          : sanitiseProb({ min: settings.prob, max: settings.probMax });
        setBlock(slot, { type: 'prob', value });
      } else if (type === 'band') {
        const vmin = Math.min(settings.vmin, settings.vmax);
        const vmax = Math.max(settings.vmin, settings.vmax);
        setBlock(slot, { type: 'band', vmin, vmax });
      } else if (type === 'gate') {
        setBlock(slot, { type: 'gate', value: sanitiseGate(settings.gate) });
      } else if (type === 'group') {
        setBlock(slot, { type: 'group', id: settings.group });
      } else if (type === 'link') {
        const link = { type: 'link', lane: settings.linkLane, index: settings.linkBeat - 1 };
        const current = findBlock(slot, 'link');
        if (current && current.lane === link.lane && current.index === link.index) {
          removeBlock(slot, 'link');
        } else {
          setBlock(slot, link);
        }
      } else if (type === 'repeat') {
        setBlock(slot, { type: 'repeat', beats: settings.repeatBeats });
      } else {
        return false;
      }
    }
    layout.mode = 'manual';
    refreshSlot(laneIndex, slotIndex);
    scheduleChange();
    return true;
  }

  function clearSlot(laneIndex, slotIndex) {
    layout.lanes[laneIndex].slots[slotIndex] = emptySlot();
    layout.mode = 'manual';
    refreshSlot(laneIndex, slotIndex);
    scheduleChange();
  }

  function onSlotPointerUp(laneIndex, slotIndex) {
    const type = dragType || selectedType;
    dragType = null;
    const cell = slotEls[laneIndex][slotIndex];
    if (cell) cell.style.outline = 'none';
    placeBlock(laneIndex, slotIndex, type);
  }

  function moveFocus(laneIndex, slotIndex) {
    const lanes = layout.lanes.length;
    const nextLane = Math.max(0, Math.min(lanes - 1, laneIndex));
    const nextSlot = Math.max(0, Math.min(layout.visibleSlots - 1, slotIndex));
    focusLane = nextLane;
    focusSlot = nextSlot;
    setRovingTabindex();
    const cell = slotEls[nextLane][nextSlot];
    if (cell && typeof cell.focus === 'function') cell.focus();
  }

  function onSlotKeyDown(event, laneIndex, slotIndex) {
    const key = event.key;
    // Up/down walk the DISPLAYED order, which for percussion is high at the
    // top — so a step DOWN the screen is a step DOWN the lane list.
    const down = layout.lanes.length > 1 ? -1 : 1;
    if (key === 'ArrowRight') moveFocus(laneIndex, slotIndex + 1);
    else if (key === 'ArrowLeft') moveFocus(laneIndex, slotIndex - 1);
    else if (key === 'ArrowDown') moveFocus(laneIndex + down, slotIndex);
    else if (key === 'ArrowUp') moveFocus(laneIndex - down, slotIndex);
    else if (key === 'Home') moveFocus(laneIndex, 0);
    else if (key === 'End') moveFocus(laneIndex, layout.visibleSlots - 1);
    else if (key === 'Enter' || key === ' ' || key === 'Spacebar') {
      placeBlock(laneIndex, slotIndex, selectedType);
    } else if (key === 'Delete' || key === 'Backspace') {
      clearSlot(laneIndex, slotIndex);
    } else {
      return;
    }
    if (typeof event.preventDefault === 'function') event.preventDefault();
  }

  // A drag released anywhere but a slot is a cancelled drag, not a placement.
  const onDocumentPointerUp = () => { dragType = null; };
  if (typeof document.addEventListener === 'function') {
    listen(document, 'pointerup', onDocumentPointerUp);
  }

  selectType(selectedType);
  buildGrid();
  container.appendChild(root);

  return {
    el: root,

    getValue,

    /** Re-render from params. Silent: no onChange, and any pending one is dropped. */
    setValue(value) {
      if (destroyed) return;
      if (pendingChange !== null) {
        clearTimeout(pendingChange);
        pendingChange = null;
      }
      const previous = layout;
      layout = fromParams(value, opts);
      const sameShape = previous.lanes.length === layout.lanes.length
        && previous.visibleSlots === layout.visibleSlots
        && previous.lanes.every((lane, index) => lane.id === layout.lanes[index].id);
      if (sameShape) refreshAllSlots();
      else buildGrid();
      renderSettings();
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      dragType = null;
      if (pendingChange !== null) {
        clearTimeout(pendingChange);
        pendingChange = null;
      }
      for (const [node, type, fn, listenOpts] of listeners) {
        try {
          node.removeEventListener(type, fn, listenOpts);
        } catch {
          // ignore
        }
      }
      listeners.length = 0;
      slotEls.length = 0;
      paletteButtons = [];
      try {
        if (typeof root.remove === 'function') root.remove();
        else if (root.parentNode) root.parentNode.removeChild(root);
      } catch {
        // ignore
      }
    },
  };
}

export default createBlockEditor;
