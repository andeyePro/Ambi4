/**
 * knob.js — 1970s hi-fi rotary knob control, rendered with SVG (v5 contract
 * plus the v7 dual-range addendum).
 *
 * export function createKnob(container, { label, min, max, value, step?, marks?,
 *   format?, onInput, allowRange?, rangeDefault?, defaultValue?, ghostValue? }) =>
 *   { el, set(value), setGhost(value), destroy() }
 *
 * 270° sweep (-135°..+135°) with a tick ring (minor ticks plus major marks at
 * `marks` values, or quartiles by default), an engraved pointer line on a
 * circular face, the label below and a formatted value readout beneath that.
 * All colours come from the theme tokens (--knob-face, --knob-ring,
 * --knob-pointer, --tick, --tick-major, --accent-warm, --label-font,
 * --secondary) with sensible fallbacks, so the knob renders before the theme
 * lands.
 *
 * ONE GESTURE MODEL (v0.0.56) — every dial on the page answers to the same
 * four things, because the owner's consistency principle is that a control
 * which ignores a gesture teaches the user that the gesture does nothing
 * anywhere:
 *
 *   drag up / down     the value
 *   drag left / right  the SPREAD — how far the value drifts either side
 *   tap the centre     back to the default
 *   type in the readout  an exact value, or "a-b" for a span
 *
 * Axis lock ("Scheme A", chosen by the owner on 2026-07-27 after an A/B rig):
 * nothing moves until the pointer has travelled LOCK_PX from where it went
 * down; the larger of |dx| and |dy| at that moment wins and owns the rest of
 * the gesture. Bring the pointer back inside REARM_PX of the origin and the
 * axis re-arms, so one press can change its mind without being released. A
 * diagonal never moves both at once — that was trialled and rejected: a
 * diagonal band is a knife-edge that ordinary drift falls out of.
 *
 * WHERE the press lands decides WHAT the vertical drag moves, which is what
 * makes an asymmetric span reachable at all:
 *
 *   centre hub (inner HUB_FRACTION of the face)   both ends together, width kept
 *   anywhere else                                 the nearer end alone, by sweep angle
 *
 * No small targets: "nearer end" is a half-plane test on the ring, so it works
 * with a thumb. A moving end PUSHES the other rather than blocking against it
 * (v16 semantics), so a span can never be wedged.
 *
 * A press that never travels further than TAP_SLOP_PX is a TAP, not a drag.
 * A tap on the centre hub resets to the DECLARED DEFAULT. There is no timing
 * requirement and no double-click anywhere: the owner's ruling on 2026-07-27
 * was that people with motor-control difficulty cannot rely on a double-click
 * being read as one, and that a single and a double click doing different
 * things is a trap. A tap outside the hub does nothing at all — it used to
 * toggle range mode, which is now what a horizontal drag expresses.
 *
 * Wheel (non-passive, small steps) and the full keyboard are unchanged in
 * spirit: arrows ±step on the active end, PgUp/PgDn ±10 steps, Home/End to
 * the bounds — plus Shift+Left/Right to narrow and widen the spread (the
 * keyboard equivalent of the horizontal drag, without which a keyboard user
 * could not create a span at all) and Backspace/Delete to reset, which is the
 * keyboard's tap-the-centre. `step` is optional — without it the knob is
 * continuous and keys move by (max-min)/200. The value readout below the knob
 * is a second, independent focusable control — click or Enter/Space to type an
 * exact value (see "v14 click-to-type" below).
 *
 * ZEROED STATE: a dial sitting at its own minimum with no spread draws its
 * pointer in muted grey with a hollow centre, so "off" is legible across a
 * panel at a glance instead of needing every readout to be read.
 *
 * LIVE POINTER: `handle.setLive(v)` marks where inside a span the value
 * actually is at this moment. A span whose behaviour is invisible is a
 * control with no feedback, so any caller that spreads a dial should feed the
 * resolved value back.
 *
 * `defaultValue` (number | {min,max}, optional): the value/mode a reset
 * restores. When omitted, reset falls back to the pre-v12 behaviour of
 * restoring the INITIAL value/mode the knob was constructed with. A range
 * `defaultValue` collapses a scalar `value` on reset (and vice versa) exactly
 * like the initial-value case already did.
 *
 * Range mode: `value` accepts number | {min,max}. With `allowRange` (the
 * default — pass `allowRange: false` for an enumeration, or for the one
 * dial ruled to stay single (Tempo on Simple); pair it with `onRangeRefused`
 * there so the refusal explains itself — a span
 * between two named positions would mean nothing), a horizontal drag opens,
 * widens, narrows and finally closes a span about the value it started from.
 * Range mode draws the engraved inner pointer for min, a short accent pointer
 * riding the ring for max, and tints the arc between them with --accent-warm
 * at low alpha. v16 push-through survives the rebuild: the moving end PUSHES
 * the other along instead of clamping against it — dragging/keying/typing min
 * past the current max carries max up with it (the span collapses to zero
 * width, then both move together); max past min carries min down likewise.
 * Only the knob's own [min,max] bounds ever stop an end. The knob stays ONE
 * tab stop: PgUp/PgDn/Home/End act on the last-edited end (default min) and
 * aria-valuetext reads "min X, max Y, drifting" — except when the ends have
 * collapsed onto each other (value === valueMax), which reads "X (range
 * collapsed)" instead, since "min X, max X, drifting" describes a spread that
 * no longer exists. onInput emits a number in single mode and {min,max} in
 * range mode; set() accepts both and switches mode to match silently;
 * `rangeDefault` starts a plain numeric value split (min=max=value).
 *
 * KNOWN GAP, deliberately still open: `role="slider"` with one
 * `aria-valuenow` is the wrong contract for two thumbs, and aria-valuetext is
 * a description rather than a fix. A real dual-thumb contract needs two
 * focusable elements, which changes the tab order of every panel on the page
 * — filed rather than smuggled in behind a gesture change.
 *
 * v14 click-to-type: the value readout is itself a focusable <button>
 * (a separate DOM node from the face, so its click never reaches the face's
 * own gesture handling above). Click, Enter or Space swaps it
 * for a themed text input pre-filled with the current value ("min-max",
 * hyphen-joined, in range mode). Enter or blur commits through the SAME
 * quantise/clamp path as drag/wheel/keys and fires onInput; Escape cancels
 * without committing. Parse grammar: "a-b" or "a to b" sets both thumbs
 * (range mode only, order-independent); a lone number sets the ACTIVE thumb
 * only in range mode (the last-edited one — same target as
 * PgUp/PgDn/Home/End) or the whole value in single mode — through the same
 * push-through commit/commitMax path as drag/wheel/keys, so a typed min
 * greater than the current max PUSHES max along (never swaps the two).
 * Unparsable text is discarded silently, leaving the value unchanged. The
 * input is keyboard reachable with no pointer required.
 *
 * The value scale is strictly linear between min and max. Log-feel (e.g. a
 * filter-cutoff dial) is the CALLER's job: pass a mapped domain (such as
 * min=log2(40), max=log2(12000)) and unmap in `format`/`onInput`.
 *
 * v12 glyph options (both optional, both trusted page-authored inline SVG
 * markup — never end-user input):
 *   `markGlyphs`: { [String(markValue)]: svgMarkup } — draws that markup in
 *     place of the plain tick line at a major mark (e.g. a waveform icon at
 *     the shape dial's canonical 0/1/2/3 marks). Marks without an entry keep
 *     the ordinary tick.
 *   `glyph(value, valueMax?)`: returns svgMarkup | null, rendered ahead of
 *     the text in the value readout (e.g. a shape icon, or a pair for a
 *     fractional morph). The glyph node carries no text of its own, so the
 *     readout's `.textContent` is unchanged from the no-glyph case.
 *
 * v14-kit-editor ghost pointer: `opts.ghostValue` (number | {min,max} | null,
 * optional) renders a secondary, MUTED pointer at that position — a thin arc
 * instead when the ghost is a range — drawn behind the live pointer(s), and
 * updated after construction via `handle.setGhost(v)` (same three shapes;
 * null hides it). This is what the kit editor uses to show the per-lane
 * "common" patch value underneath a dial that may carry a per-instrument
 * override, replacing the old text-readout fake of that idea. The ghost is
 * clamped to the knob's own [min,max] and drawn at face value — it is never
 * quantised to `step`, since the common value it mirrors was set on a
 * DIFFERENT knob instance (the Common tab's) that may not share this knob's
 * step grid.
 *
 * The ghost is DISPLAY-ONLY: no pointerdown/click handling is attached to
 * it, even though the original kit-editor sketch (v14 addendum) described
 * "clicking the ghost reverts that dial to follow common". Deliberate
 * choice: the ghost pointer sits inside the same face/ring geometry the v14
 * range-mode drag zones already use to disambiguate min vs max, so hit-
 * testing a second thin target there would either steal an existing drag
 * gesture or need a carved-out dead zone — fragile, and unreachable by
 * keyboard/AT either way. The kit editor instead gets a real "Follow common"
 * button per overridden dial (a normal, keyboard-reachable, focus-visible
 * control) that performs the same revert; the ghost pointer stays a pure
 * readout of where "common" currently sits.
 *
 * v20 shape-dial note: knob.js renders whatever `glyph`/`markGlyphs` markup
 * a caller hands it — it does no waveform maths itself. If a caller draws a
 * shape-dial mini-waveform (or reuses scope.js's trace), the triangle→saw
 * dial segment (values 1..2) must be synthesised with scope.js's closed-form
 * skewed-triangle family (peak rise-fraction d = SHAPE_SKEW_MIN..MAX = 0.5
 * to 0.99, b_n(d) = 2·sin(nπd) / (π²·n²·d·(1-d))), not a linear crossfade of
 * the triangle/saw coefficient sets — see scope.js's shapeCoefficients() for
 * the implementation these constants are shared with.
 *
 * No imports; import-safe in bare Node — every DOM access happens inside
 * createKnob(), nothing at module scope touches document/window.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

const START_DEG = -135;
const SWEEP_DEG = 270;
const MINOR_TICKS = 25;
const DRAG_RANGE_PX = 200; // pixels of vertical travel for the full sweep
const SPREAD_RANGE_PX = 200; // pixels of horizontal travel for the full spread

// v0.0.56 gesture thresholds. See the "one gesture model" note in the module
// header for why each exists.
const LOCK_PX = 6; // travel from the press origin before an axis locks …
const REARM_PX = 4; //  … and the radius the pointer must return inside to re-arm
const TAP_SLOP_PX = 6; // a press that never travels further than this is a tap
const HUB_FRACTION = 0.45; // centre hub radius, as a fraction of the face radius

// viewBox geometry (100×100 face area; label/value live in HTML below it)
const CX = 50;
const CY = 50;
const RING_R = 36;
const FACE_R = 31;
const TICK_IN = 41;
const TICK_OUT = 46;
const TICK_MAJOR_IN = 39.5;
const TICK_MAJOR_OUT = 48;

// Theme tokens with fallbacks (walnut/cream defaults until the theme lands).
const FACE_FILL = 'var(--knob-face, #4a4038)';
const RING_STROKE = 'var(--knob-ring, #8d8578)';
const POINTER_STROKE = 'var(--knob-pointer, #f2e8d5)';
const TICK_STROKE = 'var(--tick, var(--secondary, #8a8378))';
const TICK_MAJOR_STROKE = 'var(--tick-major, var(--text, #6b6257))';
const ACCENT_WARM = 'var(--accent-warm, #c98a4b)';
const GHOST_STROKE = 'var(--knob-ghost, rgba(242, 232, 213, 0.45))';
const HUB_STROKE = 'var(--knob-hub, rgba(242, 232, 213, 0.22))';
const LIVE_STROKE = 'var(--knob-live, #f2e8d5)';
// The zeroed dial: pointer and hub both drop to a muted grey, so "this one is
// off" is readable across a whole panel without reading a single number.
const ZERO_POINTER_STROKE = 'var(--knob-zero, rgba(242, 232, 213, 0.34))';
const ZERO_HUB_STROKE = 'var(--knob-zero, rgba(242, 232, 213, 0.34))';
const LABEL_COLOR = 'var(--secondary, #5a5a5f)';
const VALUE_COLOR = 'var(--text, #2e2e33)';
const LABEL_FONT =
  'var(--label-font, "Futura", "Avenir Next", "Century Gothic", "Trebuchet MS", sans-serif)';

function toFinite(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Default readout: 2 significant figures, without exponent noise for 0. */
function defaultFormat(v) {
  if (!Number.isFinite(v)) return String(v);
  if (v === 0) return '0';
  return String(Number(v.toPrecision(2)));
}

function polar(r, deg) {
  const rad = (deg * Math.PI) / 180;
  return {
    x: +(CX + r * Math.sin(rad)).toFixed(2),
    y: +(CY - r * Math.cos(rad)).toFixed(2),
  };
}

export function createKnob(container, options) {
  if (typeof document === 'undefined') {
    // No DOM (bare Node) — degrade to an inert handle rather than throw.
    return { el: null, set() {}, setGhost() {}, destroy() {} };
  }

  const opts = options || {};
  const label = opts.label != null ? String(opts.label) : '';
  const min = toFinite(opts.min, 0);
  let max = toFinite(opts.max, min + 1);
  if (max <= min) max = min + 1;
  const range = max - min;
  const step = Number.isFinite(opts.step) && opts.step > 0 ? opts.step : null;
  const keyStep = step || range / 200;
  const wheelStep = step || range / 100;
  const onInput = typeof opts.onInput === 'function' ? opts.onInput : null;
  // Called (once per gesture) when a spread gesture lands on a dial with
  // allowRange:false — so the page can SAY why nothing happened instead of
  // silently refusing. v0.0.102: the owner's Tempo ruling ("the one dial that
  // shouldn't be variable") makes Simple's Tempo the first non-enum refuser,
  // and a silent refusal there would teach that sideways does nothing anywhere.
  const onRangeRefused = typeof opts.onRangeRefused === 'function' ? opts.onRangeRefused : null;
  const format = typeof opts.format === 'function' ? opts.format : null;
  // v0.0.56: spreadable is the DEFAULT. The owner's ruling is that every dial
  // must answer to the same gestures — a dial that ignores a horizontal drag
  // teaches the user that horizontal drags do nothing, on every other dial
  // too. Opting out (`allowRange: false`) is for enumerations only, where a
  // span between two named positions would not mean anything.
  const allowRange = opts.allowRange !== false;
  const rangeDefault = !!opts.rangeDefault;

  function fmt(v) {
    if (format) {
      try {
        return String(format(v));
      } catch {
        return defaultFormat(v);
      }
    }
    return defaultFormat(v);
  }

  function quantise(v) {
    let x = Number(v);
    if (!Number.isFinite(x)) return value;
    if (step) x = min + Math.round((x - min) / step) * step;
    if (x < min) x = min;
    else if (x > max) x = max;
    return +x.toPrecision(12);
  }

  // In range mode `value` is the min thumb and `valueMax` the max thumb; in
  // single mode `value` is the whole state (valueMax just trails it).
  let mode = 'single';
  let value;
  let valueMax;
  if (opts.value != null && typeof opts.value === 'object') {
    const a = quantise(toFinite(opts.value.min, (min + max) / 2));
    const b = quantise(toFinite(opts.value.max, (min + max) / 2));
    mode = 'range';
    value = Math.min(a, b);
    valueMax = Math.max(a, b);
  } else {
    value = quantise(toFinite(opts.value, (min + max) / 2));
    valueMax = value;
    if (rangeDefault) mode = 'range';
  }
  const initialMode = mode;
  const initialValue = value;
  const initialValueMax = valueMax;

  // v12: the dblclick reset target defaults to the initial value/mode, but a
  // declared `defaultValue` overrides it — this is what lets a voice-patch
  // knob reset to the VOICE's default (not just whatever the patch happened
  // to load with).
  let resetMode = initialMode;
  let resetValue = initialValue;
  let resetValueMax = initialValueMax;
  if (opts.defaultValue != null) {
    if (typeof opts.defaultValue === 'object') {
      const a = quantise(toFinite(opts.defaultValue.min, (min + max) / 2));
      const b = quantise(toFinite(opts.defaultValue.max, (min + max) / 2));
      resetMode = 'range';
      resetValue = Math.min(a, b);
      resetValueMax = Math.max(a, b);
    } else {
      resetValue = quantise(toFinite(opts.defaultValue, (min + max) / 2));
      resetValueMax = resetValue;
      resetMode = 'single';
    }
  }

  let activeThumb = 'min'; // last-edited thumb; target of PgUp/PgDn/Home/End

  // -- build the DOM -------------------------------------------------------

  const root = document.createElement('div');
  root.className = 'knob';
  root.setAttribute('role', 'slider');
  root.setAttribute('tabindex', '0');
  if (label) root.setAttribute('aria-label', label);
  root.setAttribute('aria-valuemin', String(min));
  root.setAttribute('aria-valuemax', String(max));
  root.style.display = 'inline-flex';
  root.style.flexDirection = 'column';
  root.style.alignItems = 'center';
  root.style.width = 'var(--knob-size, 72px)';
  root.style.cursor = 'grab';
  root.style.touchAction = 'none';
  root.style.userSelect = 'none';
  root.style.webkitUserSelect = 'none';

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.display = 'block';
  svg.style.width = '100%';

  function tickLine(inR, outR, deg, stroke, width) {
    const a = polar(inR, deg);
    const b = polar(outR, deg);
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', String(a.x));
    line.setAttribute('y1', String(a.y));
    line.setAttribute('x2', String(b.x));
    line.setAttribute('y2', String(b.y));
    line.setAttribute('stroke-width', String(width));
    line.setAttribute('stroke-linecap', 'round');
    line.style.stroke = stroke;
    return line;
  }

  const ticks = document.createElementNS(SVG_NS, 'g');
  for (let i = 0; i < MINOR_TICKS; i++) {
    const deg = START_DEG + (SWEEP_DEG * i) / (MINOR_TICKS - 1);
    ticks.appendChild(tickLine(TICK_IN, TICK_OUT, deg, TICK_STROKE, 1));
  }
  // Major marks at supplied values, or quartiles of the range.
  let markValues = Array.isArray(opts.marks)
    ? opts.marks.map(Number).filter((v) => Number.isFinite(v) && v >= min && v <= max)
    : [];
  if (!markValues.length) {
    markValues = [min, min + range * 0.25, min + range * 0.5, min + range * 0.75, max];
  }
  // v12: a caller may supply a small glyph (trusted, page-authored inline
  // SVG markup) to draw at a major mark instead of the plain tick line —
  // used for the shape dial's sine/triangle/saw/square icons. Keyed by
  // String(markValue); marks without an entry keep the plain tick.
  const markGlyphs = opts.markGlyphs && typeof opts.markGlyphs === 'object' ? opts.markGlyphs : null;
  for (const mv of markValues) {
    const deg = START_DEG + (SWEEP_DEG * (mv - min)) / range;
    const glyphMarkup = markGlyphs ? markGlyphs[String(mv)] : null;
    if (glyphMarkup) {
      const p = polar(TICK_MAJOR_OUT + 4, deg);
      const g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('transform', `translate(${p.x} ${p.y})`);
      g.style.color = TICK_MAJOR_STROKE;
      g.innerHTML = glyphMarkup;
      ticks.appendChild(g);
    } else {
      ticks.appendChild(tickLine(TICK_MAJOR_IN, TICK_MAJOR_OUT, deg, TICK_MAJOR_STROKE, 1.8));
    }
  }
  svg.appendChild(ticks);

  // Range tint: an arc riding the ring between the min and max angles,
  // recomputed in updateView(). Hidden in single mode.
  // v0.0.60 (owner, 2026-07-28): "fill the arc between the indicators with a
  // 50% opaque version of the indicator's line colour". It was a thin accent
  // rule at 35% before, which read as a third mark rather than as the region
  // the value lives in. Wide and in the pointer's own colour, it reads as one
  // span with two ends.
  const rangeArc = document.createElementNS(SVG_NS, 'path');
  rangeArc.setAttribute('stroke-width', '4');
  rangeArc.setAttribute('stroke-linecap', 'butt');
  rangeArc.style.fill = 'none';
  rangeArc.style.stroke = POINTER_STROKE;
  rangeArc.style.opacity = '0.5';
  svg.appendChild(rangeArc);

  const ring = document.createElementNS(SVG_NS, 'circle');
  ring.setAttribute('cx', String(CX));
  ring.setAttribute('cy', String(CY));
  ring.setAttribute('r', String(RING_R));
  ring.setAttribute('stroke-width', '2.5');
  ring.style.fill = 'none';
  ring.style.stroke = RING_STROKE;
  svg.appendChild(ring);

  const face = document.createElementNS(SVG_NS, 'circle');
  face.setAttribute('cx', String(CX));
  face.setAttribute('cy', String(CY));
  face.setAttribute('r', String(FACE_R));
  face.setAttribute('stroke-width', '0.75');
  face.style.fill = FACE_FILL;
  face.style.stroke = 'rgba(0, 0, 0, 0.35)';
  svg.appendChild(face);

  // Ghost pointer (kit editor "common" readout, see the ghostValue doc
  // above): a single muted pointer line for a scalar ghost, or a thin arc
  // for a range ghost — never both at once. Appended before the live
  // pointer(s) below so it always draws BEHIND them.
  const ghostPointerGroup = document.createElementNS(SVG_NS, 'g');
  ghostPointerGroup.setAttribute('data-role', 'ghost-pointer');
  ghostPointerGroup.style.display = 'none';
  const ghostPointer = document.createElementNS(SVG_NS, 'line');
  ghostPointer.setAttribute('x1', String(CX));
  ghostPointer.setAttribute('y1', String(CY - 8));
  ghostPointer.setAttribute('x2', String(CX));
  ghostPointer.setAttribute('y2', String(CY - FACE_R + 4));
  ghostPointer.setAttribute('stroke-width', '2');
  ghostPointer.setAttribute('stroke-linecap', 'round');
  ghostPointer.style.stroke = GHOST_STROKE;
  ghostPointer.style.pointerEvents = 'none';
  ghostPointerGroup.appendChild(ghostPointer);
  svg.appendChild(ghostPointerGroup);

  const ghostArc = document.createElementNS(SVG_NS, 'path');
  ghostArc.setAttribute('data-role', 'ghost-arc');
  ghostArc.setAttribute('stroke-width', '2');
  ghostArc.setAttribute('stroke-linecap', 'round');
  ghostArc.style.fill = 'none';
  ghostArc.style.stroke = GHOST_STROKE;
  ghostArc.style.pointerEvents = 'none';
  ghostArc.style.display = 'none';
  svg.appendChild(ghostArc);

  // Engraved pointer: a dark groove offset just below a light pointer line.
  const pointerGroup = document.createElementNS(SVG_NS, 'g');
  const groove = document.createElementNS(SVG_NS, 'line');
  groove.setAttribute('x1', String(CX));
  groove.setAttribute('y1', String(CY - 8));
  groove.setAttribute('x2', String(CX));
  groove.setAttribute('y2', String(CY - FACE_R + 4));
  groove.setAttribute('transform', 'translate(0 0.9)');
  groove.setAttribute('stroke-width', '3.4');
  groove.setAttribute('stroke-linecap', 'round');
  groove.style.stroke = 'rgba(0, 0, 0, 0.45)';
  pointerGroup.appendChild(groove);
  const pointer = document.createElementNS(SVG_NS, 'line');
  pointer.setAttribute('x1', String(CX));
  pointer.setAttribute('y1', String(CY - 8));
  pointer.setAttribute('x2', String(CX));
  pointer.setAttribute('y2', String(CY - FACE_R + 4));
  // Named, so a test can find the indicator without counting <line>s — there
  // are nearly thirty in the tick ring alone.
  pointer.setAttribute('data-role', 'pointer');
  pointer.setAttribute('stroke-width', '2.4');
  pointer.setAttribute('stroke-linecap', 'round');
  pointer.style.stroke = POINTER_STROKE;
  pointerGroup.appendChild(pointer);
  svg.appendChild(pointerGroup);

  // v0.0.56 centre hub: the visible target for "the whole control" — drag it
  // and both ends of a span move together, tap it and the dial resets. It is
  // drawn as a hairline ring rather than a filled disc so it reads as a zone
  // on the faceplate, not a button sitting on top of one; when the dial is
  // ZEROED the same circle is what goes hollow and bright, which is why the
  // two states share one element.
  const hub = document.createElementNS(SVG_NS, 'circle');
  hub.setAttribute('data-role', 'hub');
  hub.setAttribute('cx', String(CX));
  hub.setAttribute('cy', String(CY));
  hub.setAttribute('r', String(+(FACE_R * HUB_FRACTION).toFixed(2)));
  hub.setAttribute('stroke-width', '1');
  hub.style.fill = 'none';
  hub.style.stroke = HUB_STROKE;
  hub.style.pointerEvents = 'none';
  // Not drawn on an enumeration. Its two jobs — carry both ends of a span, and
  // zero the dial — are both meaningless where there is no span and no zero,
  // and a circle with nothing behind it is the thing the owner objected to.
  if (allowRange) svg.appendChild(hub);

  // Live pointer: where inside a span the value actually is right now. A span
  // whose drift cannot be seen is a control with no feedback, so this is not
  // decoration — it is the only readout of what the walk is doing between the
  // two ends the user set.
  const livePointer = document.createElementNS(SVG_NS, 'line');
  livePointer.setAttribute('data-role', 'live-pointer');
  // v0.0.60 (owner): "can it be made a thin line that goes all the way from
  // the centre of the dial to its outer circle?" A 6px tick at the rim was
  // easy to mistake for a tick mark; a full radius cannot be mistaken for
  // anything but a pointer, and being thin is what keeps it from competing
  // with the two ends it sits between.
  livePointer.setAttribute('x1', String(CX));
  livePointer.setAttribute('y1', String(CY));
  livePointer.setAttribute('x2', String(CX));
  livePointer.setAttribute('y2', String(CY - RING_R));
  livePointer.setAttribute('stroke-width', '1.1');
  livePointer.setAttribute('stroke-linecap', 'round');
  livePointer.style.stroke = LIVE_STROKE;
  livePointer.style.pointerEvents = 'none';
  livePointer.style.display = 'none';
  svg.appendChild(livePointer);

  // Max thumb: a short accent pointer straddling the ring (range mode only).
  const maxPointerGroup = document.createElementNS(SVG_NS, 'g');
  const maxGroove = document.createElementNS(SVG_NS, 'line');
  maxGroove.setAttribute('x1', String(CX));
  maxGroove.setAttribute('y1', String(CY - RING_R - 5));
  maxGroove.setAttribute('x2', String(CX));
  maxGroove.setAttribute('y2', String(CY - RING_R + 5));
  maxGroove.setAttribute('stroke-width', '3.2');
  maxGroove.setAttribute('stroke-linecap', 'round');
  maxGroove.style.stroke = 'rgba(0, 0, 0, 0.35)';
  maxPointerGroup.appendChild(maxGroove);
  const maxPointer = document.createElementNS(SVG_NS, 'line');
  maxPointer.setAttribute('x1', String(CX));
  maxPointer.setAttribute('y1', String(CY - RING_R - 5));
  maxPointer.setAttribute('x2', String(CX));
  maxPointer.setAttribute('y2', String(CY - RING_R + 5));
  maxPointer.setAttribute('data-role', 'max-pointer');
  maxPointer.setAttribute('stroke-width', '2');
  maxPointer.setAttribute('stroke-linecap', 'round');
  maxPointer.style.stroke = ACCENT_WARM;
  maxPointerGroup.appendChild(maxPointer);
  svg.appendChild(maxPointerGroup);
  root.appendChild(svg);

  const labelEl = document.createElement('div');
  labelEl.className = 'knob-label';
  labelEl.textContent = label;
  labelEl.style.fontFamily = LABEL_FONT;
  labelEl.style.color = LABEL_COLOR;
  labelEl.style.fontSize = '11px';
  labelEl.style.letterSpacing = '0.08em';
  labelEl.style.textTransform = 'uppercase';
  labelEl.style.textAlign = 'center';
  labelEl.style.marginTop = '2px';
  root.appendChild(labelEl);

  // v14: the readout is itself a focusable control — a plain-chrome <button>
  // so click-to-type is reachable by click OR by keyboard (Enter/Space),
  // with no pointer required. It is a separate DOM node from the face, so
  // its own click/keydown never collides with the face's drag or its
  // click-to-toggle-mode gesture (guarded explicitly in onPointerDown too).
  const valueEl = document.createElement('button');
  valueEl.setAttribute('type', 'button');
  valueEl.className = 'knob-value';
  valueEl.style.fontFamily = LABEL_FONT;
  valueEl.style.color = VALUE_COLOR;
  valueEl.style.fontSize = '12px';
  valueEl.style.textAlign = 'center';
  valueEl.style.background = 'none';
  valueEl.style.border = 'none';
  valueEl.style.padding = '0';
  valueEl.style.margin = '0';
  valueEl.style.cursor = 'pointer';
  root.appendChild(valueEl);

  function degFor(v) {
    return START_DEG + (SWEEP_DEG * (v - min)) / range;
  }

  /** Clamps a ghost coordinate into [min,max] without step quantising it. */
  function ghostClamp(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return n < min ? min : n > max ? max : n;
  }

  let ghostValue = null; // number | {min,max} | null
  let liveValue = null; // where inside a span the value is right now, or null

  function updateGhostView() {
    if (ghostValue == null) {
      ghostPointerGroup.style.display = 'none';
      ghostArc.style.display = 'none';
      return;
    }
    if (typeof ghostValue === 'object') {
      ghostPointerGroup.style.display = 'none';
      const a = ghostClamp(ghostValue.min);
      const b = ghostClamp(ghostValue.max);
      if (a == null || b == null) {
        ghostArc.style.display = 'none';
        return;
      }
      const loDeg = degFor(Math.min(a, b));
      const hiDeg = degFor(Math.max(a, b));
      const p1 = polar(RING_R, loDeg);
      const p2 = polar(RING_R, hiDeg);
      const largeArc = hiDeg - loDeg > 180 ? 1 : 0;
      ghostArc.setAttribute('d', `M ${p1.x} ${p1.y} A ${RING_R} ${RING_R} 0 ${largeArc} 1 ${p2.x} ${p2.y}`);
      ghostArc.style.display = '';
      return;
    }
    ghostArc.style.display = 'none';
    const v = ghostClamp(ghostValue);
    if (v == null) {
      ghostPointerGroup.style.display = 'none';
      return;
    }
    const deg = degFor(v);
    ghostPointerGroup.setAttribute('transform', `rotate(${+deg.toFixed(2)} ${CX} ${CY})`);
    ghostPointerGroup.style.display = '';
  }

  function applyGhost(v) {
    if (v == null) {
      ghostValue = null;
    } else if (typeof v === 'object') {
      ghostValue = { min: toFinite(v.min, NaN), max: toFinite(v.max, NaN) };
    } else {
      const n = Number(v);
      ghostValue = Number.isFinite(n) ? n : null;
    }
    updateGhostView();
  }

  // v12: an optional `glyph(value, valueMax)` renders trusted inline SVG
  // markup ahead of the text readout (e.g. a waveform icon, or a pair for a
  // fractional morph) — the glyph node carries no text, so el.children[2]
  // .textContent stays exactly `fmt(...)`, same as the no-glyph path.
  const glyphFn = typeof opts.glyph === 'function' ? opts.glyph : null;
  // v14.1: glyphOnly hides the text portion visually (the glyph IS the
  // readout); the text survives in a visually-hidden span so click-to-type
  // and AT labelling keep working, and aria-valuetext is unaffected.
  const glyphOnly = glyphFn && opts.glyphOnly === true;
  function setValueText(text) {
    if (!glyphFn) {
      valueEl.textContent = text;
      return;
    }
    valueEl.textContent = '';
    let markup = null;
    try {
      markup = glyphFn(value, mode === 'range' ? valueMax : undefined);
    } catch {
      markup = null;
    }
    if (markup) {
      const g = document.createElement('span');
      g.className = 'knob-value-glyph';
      g.innerHTML = markup;
      valueEl.appendChild(g);
    }
    if (glyphOnly && markup) {
      const t = document.createElement('span');
      t.className = 'visually-hidden';
      t.textContent = text;
      valueEl.appendChild(t);
    } else {
      valueEl.appendChild(document.createTextNode(text));
    }
  }

  /**
   * "Zeroed" is the dial sitting at the bottom of its own scale with no spread
   * — nothing set, nothing drifting. It is a display state only: nothing about
   * the value or the gestures changes, the pointer and hub just go grey so a
   * panel of dials can be read at a glance.
   */
  /**
   * v0.0.60 (owner, 2026-07-28): "when a dial is being moved, bold its
   * indicator, make it at least twice as thick. So as soon as you let go, it
   * reverts to regular thickness. Then you can see if you have let go or not."
   *
   * The report behind it: "far too often I set the dial as I want it then move
   * to go elsewhere and I've ruined it." A pointer capture that outlives the
   * gesture is invisible — the dial looks exactly the same whether or not it is
   * still listening — so the next movement anywhere on the page silently drags
   * it. This makes the two states different at a glance, which is the only
   * thing that lets someone notice before they have ruined the setting.
   */
  const POINTER_W = 2.4;
  const POINTER_W_DRAG = 5.2;
  const MAX_POINTER_W = 2;
  const MAX_POINTER_W_DRAG = 4.4;
  const ARC_W = 4;
  const ARC_W_DRAG = 11;

  function applyGripLook() {
    // v0.0.65 (owner, 2026-07-29): "Grabbing one indicator shouldn't have both
    // indicators bold. They should only both bold if what you are going to do
    // will affect both." So the thickening is a statement about what THIS
    // gesture will move, not about the dial being touched.
    const held = dragging;
    const spreading = held && dragAxis === 'spread';
    // A spread drag moves both ends outward; a hub drag carries both along.
    const both = spreading || dragThumb === 'both';
    const minHeld = held && (both || dragThumb === 'min' || mode !== 'range');
    const maxHeld = held && (both || dragThumb === 'max');
    pointer.setAttribute('stroke-width', String(minHeld ? POINTER_W_DRAG : POINTER_W));
    maxPointer.setAttribute('stroke-width', String(maxHeld ? MAX_POINTER_W_DRAG : MAX_POINTER_W));
    // The arc is the SPREAD's own indicator, so it thickens only when the
    // spread itself is being dragged — and is thin but always present the rest
    // of the time, which is what says "there is a range here" without claiming
    // you are editing it.
    rangeArc.setAttribute('stroke-width', String(spreading ? ARC_W_DRAG : ARC_W));
    root.setAttribute('data-dragging', held ? 'true' : 'false');
    root.setAttribute('data-grip', !held ? 'none' : both ? 'both' : dragThumb);
  }

  function applyZeroedLook() {
    const zeroed = mode !== 'range' && value === min;
    pointer.style.stroke = zeroed ? ZERO_POINTER_STROKE : POINTER_STROKE;
    hub.style.stroke = zeroed ? ZERO_HUB_STROKE : HUB_STROKE;
    hub.setAttribute('stroke-width', zeroed ? '1.6' : '1');
    root.setAttribute('data-zeroed', zeroed ? 'true' : 'false');
  }

  function applyLive() {
    // Only meaningful inside a span: in single mode the main pointer already
    // IS the live value, and a second mark on top of it would be noise.
    if (liveValue == null || mode !== 'range') {
      livePointer.style.display = 'none';
      return;
    }
    const v = Math.min(Math.max(liveValue, value), valueMax);
    livePointer.style.display = '';
    livePointer.setAttribute('transform', `rotate(${+degFor(v).toFixed(2)} ${CX} ${CY})`);
  }

  function updateView() {
    const deg = degFor(value);
    pointerGroup.setAttribute('transform', `rotate(${+deg.toFixed(2)} ${CX} ${CY})`);
    applyGripLook();
    applyZeroedLook();
    applyLive();
    if (mode === 'range') {
      const maxDeg = degFor(valueMax);
      maxPointerGroup.setAttribute('transform', `rotate(${+maxDeg.toFixed(2)} ${CX} ${CY})`);
      maxPointerGroup.style.display = '';
      const a = polar(RING_R, deg);
      const b = polar(RING_R, maxDeg);
      const largeArc = maxDeg - deg > 180 ? 1 : 0;
      rangeArc.setAttribute('d', `M ${a.x} ${a.y} A ${RING_R} ${RING_R} 0 ${largeArc} 1 ${b.x} ${b.y}`);
      rangeArc.style.display = '';
      root.setAttribute('aria-valuenow', String(value));
      // v16: a collapsed range (both thumbs pushed onto the same value) has
      // no spread left to describe — "min X, max X, drifting" would read as
      // a range that doesn't exist, so it collapses to a single-value form.
      root.setAttribute(
        'aria-valuetext',
        value === valueMax
          ? `${fmt(value)} (range collapsed)`
          : `min ${fmt(value)}, max ${fmt(valueMax)}, drifting`
      );
      setValueText(`${fmt(value)} – ${fmt(valueMax)}`);
    } else {
      maxPointerGroup.style.display = 'none';
      rangeArc.style.display = 'none';
      root.setAttribute('aria-valuenow', String(value));
      root.setAttribute('aria-valuetext', fmt(value));
      setValueText(fmt(value));
    }
  }

  function emit() {
    if (!onInput) return;
    try {
      onInput(mode === 'range' ? { min: value, max: valueMax } : value);
    } catch {
      // a listener error must never break the knob
    }
  }

  // v16 push-through: the moving thumb is bounded only by the knob's own
  // [min,max] — never by the other thumb. If moving one thumb would cross
  // the other, the other is PUSHED along with it (range width collapses to
  // 0, then both move together) rather than the mover being clamped.
  function commit(v, fireInput) {
    const next = quantise(v);
    let maxPushed = false;
    if (mode === 'range' && next > valueMax) {
      valueMax = next;
      maxPushed = true;
    }
    if (next === value && !maxPushed) return;
    value = next;
    updateView();
    if (fireInput) emit();
  }

  function commitMax(v, fireInput) {
    const next = quantise(v);
    let minPushed = false;
    if (next < value) {
      value = next;
      minPushed = true;
    }
    if (next === valueMax && !minPushed) return;
    valueMax = next;
    updateView();
    if (fireInput) emit();
  }

  // v0.0.56: `toggleMode` is gone with the click-to-toggle gesture that was
  // its only caller. Opening and closing a span is now what a horizontal drag
  // (or Shift+Left/Right) expresses, through applySpread — which is the same
  // idea with a width instead of an on/off, so there is nothing left to
  // toggle. Typing "20-30" in the readout still opens a span directly.

  // -- v14 click-to-type ----------------------------------------------------

  let editing = false;
  let editInput = null;
  let editCleanup = null;

  /** Parse committed editor text and apply it through the normal clamp path. */
  function applyTypedValue(raw) {
    const text = String(raw == null ? '' : raw).trim();
    if (!text) return; // empty commit: leave the value unchanged
    if (mode === 'range') {
      const toMatch = /^(-?[\d.]+)\s*to\s*(-?[\d.]+)$/i.exec(text);
      const dashMatch = !toMatch && /^(-?[\d.]+)\s*-\s*(-?[\d.]+)$/.exec(text);
      const m = toMatch || dashMatch;
      if (m) {
        const a = quantise(Number(m[1]));
        const b = quantise(Number(m[2]));
        if (!Number.isFinite(a) || !Number.isFinite(b)) return;
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        const changed = lo !== value || hi !== valueMax;
        value = lo;
        valueMax = hi;
        activeThumb = 'min';
        dragRaw = value;
        updateView();
        if (changed) emit();
        return;
      }
      // A lone number in range mode sets the ACTIVE thumb only — the same
      // target PgUp/PgDn/Home/End would hit — via the existing per-thumb
      // commit/commitMax clamp path.
      const single = Number(text);
      if (!Number.isFinite(single)) return;
      if (activeThumb === 'max') commitMax(single, true);
      else commit(single, true);
      return;
    }
    const single = Number(text);
    if (!Number.isFinite(single)) return; // unparsable: silently discarded
    commit(single, true);
  }

  function closeEditor() {
    if (!editing) return;
    editing = false;
    if (editCleanup) {
      editCleanup();
      editCleanup = null;
    }
    if (editInput) {
      try {
        if (typeof editInput.remove === 'function') editInput.remove();
        else if (editInput.parentNode) editInput.parentNode.removeChild(editInput);
      } catch {
        // ignore
      }
      editInput = null;
    }
    valueEl.style.display = '';
  }

  function openEditor() {
    if (editing) return;
    editing = true;
    valueEl.style.display = 'none';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'knob-value-edit';
    input.style.fontFamily = LABEL_FONT;
    input.style.color = VALUE_COLOR;
    input.style.fontSize = '12px';
    input.style.textAlign = 'center';
    input.style.width = '100%';
    input.style.boxSizing = 'border-box';
    input.style.border = `1px solid ${RING_STROKE}`;
    input.style.borderRadius = '3px';
    input.style.background = 'none';
    input.style.padding = '0 2px';
    input.style.outline = 'none';
    input.value = mode === 'range' ? `${value}-${valueMax}` : `${value}`;

    function commitEdit() {
      const raw = input.value;
      closeEditor();
      applyTypedValue(raw);
    }
    function onEditKeydown(e) {
      if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
      const key = e && e.key;
      if (key === 'Enter') {
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
        commitEdit();
      } else if (key === 'Escape') {
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
        closeEditor();
      }
    }
    function onEditBlur() {
      commitEdit();
    }
    function onEditGuard(e) {
      if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
    }
    input.addEventListener('keydown', onEditKeydown);
    input.addEventListener('blur', onEditBlur);
    input.addEventListener('click', onEditGuard);
    input.addEventListener('pointerdown', onEditGuard);
    editCleanup = () => {
      input.removeEventListener('keydown', onEditKeydown);
      input.removeEventListener('blur', onEditBlur);
      input.removeEventListener('click', onEditGuard);
      input.removeEventListener('pointerdown', onEditGuard);
    };
    editInput = input;
    root.appendChild(input);
    if (typeof input.focus === 'function') input.focus();
    if (typeof input.select === 'function') input.select();
  }

  function onValueClick(e) {
    if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
    openEditor();
  }
  function onValueKeydown(e) {
    const key = e && e.key;
    if (key === 'Enter' || key === ' ' || key === 'Spacebar') {
      if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
      if (e && typeof e.preventDefault === 'function') e.preventDefault();
      openEditor();
    }
  }
  valueEl.addEventListener('click', onValueClick);
  valueEl.addEventListener('keydown', onValueKeydown);

  // -- interaction ---------------------------------------------------------

  const listeners = [];
  function listen(type, fn, listenOpts) {
    root.addEventListener(type, fn, listenOpts);
    listeners.push([type, fn, listenOpts]);
  }

  let dragging = false;
  let lastY = 0;
  let dragRaw = value; // continuous accumulator so `step` quantisation can't stall a drag
  let dragThumb = 'min'; // 'min' | 'max' | 'both'
  let pressed = false;
  let pressX = NaN;
  let pressY = NaN;
  // v0.0.56 axis lock: null until the press has travelled LOCK_PX, then
  // 'value' (vertical) or 'spread' (horizontal) for the rest of the gesture,
  // back to null if the pointer returns inside REARM_PX of where it started.
  let dragAxis = null;
  let pressHub = false; // the press landed on the centre hub
  let travelled = 0; // furthest the press has been from its origin, in px
  let dragSpread = 0; // half-width the spread gesture started from
  let dragSpreadCentre = value; // midpoint the spread gesture opens about
  let spreadOriginX = 0; // clientX at the moment the spread axis locked
  let refusalSaid = false; // onRangeRefused fired for THIS gesture already

  /**
   * Shared rect/centre lookup for pointer geometry — mock-safe: returns null
   * when getBoundingClientRect is missing or degenerate (bare-DOM test
   * mocks), so callers fall back to their non-geometric alternative (Shift).
   */
  function pointerCentre(e) {
    if (!e || typeof e.clientX !== 'number' || typeof e.clientY !== 'number') return null;
    if (typeof root.getBoundingClientRect !== 'function') return null;
    let rect;
    try {
      rect = root.getBoundingClientRect();
    } catch {
      return null;
    }
    if (!rect || !Number.isFinite(rect.left) || !Number.isFinite(rect.top) || !(rect.width > 0)) {
      return null;
    }
    // The SVG face is a square spanning the root's width, at its top.
    return { rect, cx: rect.left + rect.width / 2, cy: rect.top + rect.width / 2 };
  }

  /** Pointer angle (deg, 0 = top, clockwise) relative to the face centre. */
  function pointerDeg(e) {
    const c = pointerCentre(e);
    if (!c) return null;
    return (Math.atan2(e.clientX - c.cx, c.cy - e.clientY) * 180) / Math.PI;
  }

  /**
   * v0.0.56: is a pointerdown inside the centre hub? The hub is the part of
   * the dial that means "the whole control" — drag it and both ends move
   * together keeping their width, tap it and the dial goes back to its
   * default. Returns null when geometry is unavailable (bare-DOM mocks), and
   * every caller treats null as "not the hub" so a geometry-less environment
   * still gets ordinary single-value behaviour.
   */
  /**
   * A pointer precise enough for angular aiming. A fingertip covers most of a
   * small dial, so the angle it reports is noise; a mouse or a stylus does not.
   * `pointerType` is the direct answer where the event carries it, and the
   * media query is the fallback for environments that do not.
   */
  function finePointer(e) {
    if (e && typeof e.pointerType === 'string') return e.pointerType !== 'touch';
    try {
      return typeof matchMedia === 'function' ? matchMedia('(pointer: fine)').matches : true;
    } catch {
      return true;
    }
  }

  /** Is the pointer within the dial's own face circle? */
  function pointerOnFace(e) {
    const c = pointerCentre(e);
    if (!c) return false;
    const dx = e.clientX - c.cx;
    const dy = e.clientY - c.cy;
    const faceRadiusPx = (FACE_R / 100) * c.rect.width;
    return Math.sqrt(dx * dx + dy * dy) <= faceRadiusPx;
  }

  function pointerInHub(e) {
    const c = pointerCentre(e);
    if (!c) return null;
    const dx = e.clientX - c.cx;
    const dy = e.clientY - c.cy;
    const distPx = Math.sqrt(dx * dx + dy * dy);
    const hubRadiusPx = ((FACE_R * HUB_FRACTION) / 100) * c.rect.width;
    return distPx <= hubRadiusPx;
  }

  /**
   * Which end of a span a press grabs: whichever is nearer by sweep angle.
   * This is a half-plane test rather than a hit target, so there is nothing
   * small to miss — every point on the dial belongs to one end or the other,
   * which is what makes it usable with a thumb.
   */
  function nearerThumb(e) {
    const deg = pointerDeg(e);
    // No geometry (bare-DOM tests, and any environment without
    // getBoundingClientRect) means no angle to compare, so the press cannot
    // tell the ends apart. Shift stays the documented fallback selector there
    // — it costs nothing in a real browser, where the angle always decides and
    // Shift means fine control.
    if (deg == null) return e && e.shiftKey ? 'max' : 'min';
    const dMin = Math.abs(deg - degFor(value));
    const dMax = Math.abs(deg - degFor(valueMax));
    return dMax < dMin ? 'max' : 'min';
  }

  function onPointerDown(e) {
    if (e && e.target && (e.target === valueEl || e.target === editInput)) return; // readout owns its own click/keydown, never the face's drag
    if (e && e.button != null && e.button !== 0) return;
    dragging = true;
    pressed = true;
    applyGripLook();
    lastY = e && typeof e.clientY === 'number' ? e.clientY : 0;
    pressX = e && typeof e.clientX === 'number' ? e.clientX : NaN;
    pressY = e && typeof e.clientY === 'number' ? e.clientY : NaN;
    dragAxis = null; // nothing moves until LOCK_PX of travel picks an axis
    pressHub = pointerInHub(e) === true;
    travelled = 0;
    // The hub means "the whole control", so a drag from it carries both ends.
    // Anywhere else grabs the nearer end alone — the only way an asymmetric
    // span like 20–30% is reachable.
    dragThumb = mode === 'range' ? (pressHub ? 'both' : nearerThumb(e)) : 'min';
    dragRaw = dragThumb === 'max' ? valueMax : value;
    dragSpread = (valueMax - value) / 2;
    refusalSaid = false;
    try {
      if (e && e.pointerId != null && typeof root.setPointerCapture === 'function') {
        root.setPointerCapture(e.pointerId);
      }
    } catch {
      // capture is an enhancement, not a requirement
    }
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
  }

  /**
   * Widen or narrow the span by `halfWidth` in value units, about the value
   * the gesture started from. Crossing zero width collapses back to a single
   * value; leaving zero opens a span out of one.
   *
   * At a bound the span grows ONE-SIDED rather than refusing to grow. The
   * symmetric-only version of this was written first and was wrong in the way
   * that matters most: a dial already at the top of its scale — a Volume at
   * 100%, a Reprise at 100% — could not open a span at all, so the gesture
   * silently did nothing on exactly the dials someone is most likely to want
   * variation from. "Give me some variation here" is the ask; sliding the
   * centre down to deliver it is the only honest reading of that at a ceiling.
   */
  function applySpread(halfWidth) {
    const centre = dragSpreadCentre;
    if (halfWidth <= 0) {
      if (mode === 'single') return;
      mode = 'single';
      value = quantise(centre);
      valueMax = value;
      activeThumb = 'min';
      updateView();
      emit();
      return;
    }
    let lo = centre - halfWidth;
    let hi = centre + halfWidth;
    // Push whatever overhangs a bound onto the other side, so the WIDTH the
    // gesture asked for survives; then clamp, which only bites once the span
    // is as wide as the whole scale.
    if (lo < min) { hi += min - lo; lo = min; }
    if (hi > max) { lo -= hi - max; hi = max; }
    lo = quantise(Math.max(lo, min));
    hi = quantise(Math.min(hi, max));
    if (hi <= lo) return;
    if (mode === 'range' && lo === value && hi === valueMax) return;
    mode = 'range';
    value = lo;
    valueMax = hi;
    updateView();
    emit();
  }

  function onPointerMove(e) {
    if (!dragging || !e || typeof e.clientY !== 'number') return;
    const totalX = typeof e.clientX === 'number' ? e.clientX - pressX : 0;
    const totalY = e.clientY - pressY;
    const fromOrigin = Math.sqrt(totalX * totalX + totalY * totalY);
    travelled = Math.max(travelled, fromOrigin);

    // Scheme A: lock on first real travel, re-arm on return to the origin.
    if (dragAxis === null) {
      if (fromOrigin < LOCK_PX) {
        lastY = e.clientY;
        return;
      }
      dragAxis = Math.abs(totalX) > Math.abs(totalY) ? 'spread' : 'value';
      if (dragAxis === 'value' && !allowRange && mode === 'range') {
        // A single-only dial can DISPLAY a span made elsewhere (set() draws
        // it; refusing to draw state that exists would be the readout lying),
        // but dragging it is the "set one steady value" act its contract
        // promises — so the span collapses to its midpoint and the gesture
        // proceeds single. Without this the drag moved one END of the span
        // and committed {min,max} from the very dial built to refuse spans.
        mode = 'single';
        value = quantise((value + valueMax) / 2);
        valueMax = value;
        activeThumb = 'min';
        dragThumb = 'min';
        dragRaw = value;
        updateView();
        emit();
      }
      if (dragAxis === 'spread') {
        // Opening a span happens about where the value is NOW, so the value
        // the user has already set is the centre of the span they get.
        dragSpreadCentre = mode === 'range' ? (value + valueMax) / 2 : value;
        dragSpread = mode === 'range' ? (valueMax - value) / 2 : 0;
        // Measured from where the press STARTED, not from where the axis
        // locked, so the six pixels that bought the lock are not also a dead
        // zone. The vertical axis has always counted its travel this way; the
        // two must match or a horizontal flick would need to be longer than a
        // vertical one to do anything.
        spreadOriginX = pressX;
      }
    } else if (fromOrigin < REARM_PX) {
      dragAxis = null;
      lastY = e.clientY;
      return;
    }

    if (dragAxis === 'spread') {
      if (!allowRange) {
        // No span to open — but never refuse in silence when the page gave
        // the refusal a voice. Once per gesture: the message is a teaching,
        // not a metronome.
        if (onRangeRefused && !refusalSaid) {
          refusalSaid = true;
          try {
            onRangeRefused();
          } catch {}
        }
        return;
      }
      const dx = e.clientX - spreadOriginX;
      applySpread(dragSpread + dx * (range / SPREAD_RANGE_PX));
      lastY = e.clientY;
      return;
    }

    // v0.0.65 (owner, 2026-07-29): "Grabbing a min or max line it seems more
    // intuitive to move it where you want it to go than to move up to increase
    // and down to decrease."
    //
    // He is right, and the reason it was not built that way is the gap at the
    // bottom of a 270° dial: a pointer that follows the finger exactly jumps
    // from maximum to minimum the moment the finger crosses it. So the finger
    // leads WHILE IT IS ON THE FACE, and the moment it leaves, control reverts
    // to relative vertical — which is also how a hardware-style dial gives
    // fine control, by moving further from the centre. Aim first, trim second.
    //
    // Crossing the gap is refused rather than wrapped: the value clamps at
    // whichever end it reached. Nothing a user does with one finger should be
    // able to take a dial from full to nothing in a millimetre.
    // Angle-following needs the pointer to be somewhere an angle MEANS
    // something: on the face, outside the hub (where a millimetre swings the
    // angle wildly), and out of the dead zone at the bottom of the sweep. Any
    // of those failing falls through to relative vertical rather than doing
    // nothing — a gesture that silently refuses is worse than one that is
    // merely less direct.
    // v0.0.66, after the research the owner asked for. The finding is one-sided
    // and it goes against the first cut of this: angular drag breaks down near
    // the centre, where a millimetre swings the angle wildly, and professional
    // audio software standardised on vertical drag decades ago precisely
    // because it is predictable and identical on mouse and touch. The counter-
    // point is real too — people DO instinctively try to circle a knob, and a
    // control that ignores that "wrests control away" — which is why angular
    // stays as an ASSIST rather than being removed.
    //
    // So: vertical is the primary everywhere, angular applies only in the
    // annulus between the hub and the face edge, and only on a FINE pointer.
    // The owner's own instinct — "for small dials on iOS I guess up/down may
    // win" — is exactly right and is now the rule: on touch, where the whole
    // dial may be under the fingertip, there is no angular mode at all.
    const onFace = finePointer(e) && pointerOnFace(e) && !pointerInHub(e);
    if (onFace && !e.shiftKey) {
      const deg = pointerDeg(e);
      if (deg != null && deg >= START_DEG && deg <= START_DEG + SWEEP_DEG) {
        const t = (deg - START_DEG) / SWEEP_DEG;
        const aimed = min + t * range;
        lastY = e.clientY;
        dragRaw = aimed;
        if (mode === 'range' && dragThumb === 'both') {
          const width = valueMax - value;
          let lo = aimed - width / 2;
          if (lo < min) lo = min;
          if (lo + width > max) lo = max - width;
          const nextLo = quantise(lo);
          const nextHi = quantise(lo + width);
          if (nextLo !== value || nextHi !== valueMax) {
            value = nextLo;
            valueMax = nextHi;
            updateView();
            emit();
          }
          return;
        }
        if (mode === 'range') {
          activeThumb = dragThumb;
          if (dragThumb === 'max') { commitMax(aimed, true); return; }
        }
        commit(aimed, true);
        return;
      }
      // In the dead zone at the bottom of the sweep: fall through to the
      // relative drag below rather than jumping across it.
    }

    const dy = lastY - e.clientY; // drag up = increase
    lastY = e.clientY;
    const fine = e.shiftKey ? 0.1 : 1;
    const delta = dy * (range / DRAG_RANGE_PX) * fine;

    if (mode === 'range' && dragThumb === 'both') {
      // Both ends together, width preserved. The span stops at the bound it
      // reaches first rather than being squashed against it.
      const width = valueMax - value;
      let lo = value + delta;
      if (lo < min) lo = min;
      if (lo + width > max) lo = max - width;
      const nextLo = quantise(lo);
      const nextHi = quantise(lo + width);
      if (nextLo === value && nextHi === valueMax) return;
      value = nextLo;
      valueMax = nextHi;
      updateView();
      emit();
      return;
    }

    dragRaw += delta;
    // v16: bounded only by the knob's own [min,max] — push-through (inside
    // commit/commitMax) handles carrying the other thumb along, so a drag
    // is never capped at the opposite thumb's current position.
    if (dragRaw < min) dragRaw = min;
    else if (dragRaw > max) dragRaw = max;
    if (mode === 'range') {
      activeThumb = dragThumb;
      if (dragThumb === 'max') {
        commitMax(dragRaw, true);
        return;
      }
    }
    commit(dragRaw, true);
  }

  function endPointer(e) {
    dragging = false;
    dragAxis = null;
    dragRaw = value;
    applyGripLook();
    try {
      if (e && e.pointerId != null && typeof root.releasePointerCapture === 'function') {
        root.releasePointerCapture(e.pointerId);
      }
    } catch {
      // ignore
    }
  }

  function onPointerUp(e) {
    const wasPress = pressed;
    const wasHub = pressHub;
    const moved = travelled;
    pressed = false;
    endPointer(e);
    // v0.0.63: the inner circle is the ZERO button, which is the meaning the
    // owner assigned it on 2026-07-27 ("single clicking OUTSIDE the zero
    // button…") and which it then spent six versions without — it was drawn,
    // it was draggable, and a tap on it did nothing, which is exactly his
    // "you are just drawing it with no assigned meaning".
    //
    // Zero is not the same as default and the two do not compete: this sends
    // the dial to the bottom of its own scale (where it already renders grey,
    // shipped in v0.0.56), while double-click anywhere restores the default.
    // A dial that cannot spread has no hub drawn at all, so there is nothing
    // to press there.
    if (wasPress && e && wasHub && allowRange && moved <= TAP_SLOP_PX) toZero();
    // v0.0.60: a single tap does NOTHING. The reset is back on double-click,
    // reversing the v0.0.56 model at the owner's request on 2026-07-28 — and
    // he gave the reason himself: "if you leave a dial still tracking your
    // position despite your having let go, all you can do to fix it is click,
    // that currently resets everything". A single-click reset makes the one
    // reflex available to someone whose dial is stuck the most destructive
    // thing they can do. His earlier motor-control argument against
    // double-click still stands, which is why the keyboard reset
    // (Backspace/Delete) is not going anywhere and is now the documented
    // equal-footing route rather than an afterthought.
  }

  function onPointerCancel(e) {
    pressed = false;
    endPointer(e);
  }

  function onWheel(e) {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    const dy = e && typeof e.deltaY === 'number' ? e.deltaY : 0;
    if (!dy) return;
    const dir = dy < 0 ? 1 : -1;
    if (mode === 'range') {
      const target = e && e.shiftKey ? 'max' : 'min';
      activeThumb = target;
      if (target === 'max') commitMax(valueMax + dir * wheelStep, true);
      else commit(value + dir * wheelStep, true);
      return;
    }
    const fine = e && e.shiftKey ? 0.1 : 1;
    commit(value + dir * wheelStep * fine, true);
  }

  function onKeyDown(e) {
    const key = e && e.key;
    const isRange = mode === 'range';
    const shifted = !!(e && e.shiftKey);

    // The keyboard's tap-the-centre. Without it, deleting double-click would
    // have left a keyboard user with no way back to the default at all.
    if (key === 'Backspace' || key === 'Delete') {
      if (e && typeof e.preventDefault === 'function') e.preventDefault();
      resetToDefault();
      return;
    }

    // The keyboard's horizontal drag: Shift+Left narrows the spread,
    // Shift+Right widens it, and widening from nothing opens a span. Without
    // this a keyboard user could not create a spread at all — the old scheme
    // could only move the ends of a span that a pointer had already opened.
    if (allowRange && shifted && (key === 'ArrowLeft' || key === 'ArrowRight')) {
      if (e && typeof e.preventDefault === 'function') e.preventDefault();
      dragSpreadCentre = isRange ? (value + valueMax) / 2 : value;
      const half = isRange ? (valueMax - value) / 2 : 0;
      applySpread(half + (key === 'ArrowRight' ? keyStep : -keyStep));
      return;
    }
    // The keyboard spread on a dial that stays single: same voice as the
    // pointer refusal, so the two routes never disagree.
    if (!allowRange && onRangeRefused && shifted && (key === 'ArrowLeft' || key === 'ArrowRight')) {
      if (e && typeof e.preventDefault === 'function') e.preventDefault();
      try {
        onRangeRefused();
      } catch {}
      return;
    }

    // The keyboard mirror of the pointer collapse above: a single-only dial
    // showing a display-only span collapses it on the first keyboard EDIT
    // (never on a passing Tab or letter) and proceeds single, so the two
    // routes never disagree.
    const isEditKey = key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft'
      || key === 'ArrowRight' || key === 'PageUp' || key === 'PageDown'
      || key === 'Home' || key === 'End';
    if (!allowRange && isRange && isEditKey) {
      mode = 'single';
      value = quantise((value + valueMax) / 2);
      valueMax = value;
      activeThumb = 'min';
      updateView();
      emit();
    }

    let target = 'min';
    if (mode === 'range') {
      const isArrow =
        key === 'ArrowUp' || key === 'ArrowRight' || key === 'ArrowDown' || key === 'ArrowLeft';
      // Arrows: plain=min, Shift=max. PgUp/PgDn/Home/End: the active thumb
      // (last edited, default min); Shift still forces max.
      target = shifted ? 'max' : isArrow ? 'min' : activeThumb;
    }
    const cur = target === 'max' ? valueMax : value;
    let next = null;
    switch (key) {
      case 'ArrowUp':
      case 'ArrowRight':
        next = cur + keyStep;
        break;
      case 'ArrowDown':
      case 'ArrowLeft':
        next = cur - keyStep;
        break;
      case 'PageUp':
        next = cur + keyStep * 10;
        break;
      case 'PageDown':
        next = cur - keyStep * 10;
        break;
      case 'Home':
        next = min;
        break;
      case 'End':
        next = max;
        break;
      default:
        return;
    }
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    if (mode === 'range') activeThumb = target;
    if (target === 'max') commitMax(next, true);
    else commit(next, true);
  }

  /**
   * Back to the declared default — value AND spread. Reached by tapping the
   * centre hub or pressing Backspace/Delete with the dial focused. This
   * replaces double-click, which the owner ruled out on 2026-07-27: a gesture
   * nobody with a motor-control difficulty can rely on producing, sharing a
   * target with a single click that has to mean something else.
   */
  /**
   * Send the dial to the bottom of its own scale, collapsing any spread. The
   * zero button's job. Emits like any other edit, so it is undoable by the
   * same route as a drag.
   */
  function toZero() {
    closeEditor();
    if (mode === 'single' && value === min) return;
    mode = 'single';
    value = min;
    valueMax = min;
    activeThumb = 'min';
    dragRaw = value;
    updateView();
    emit();
  }

  function resetToDefault() {
    closeEditor();
    const changed =
      mode !== resetMode ||
      value !== resetValue ||
      (resetMode === 'range' && valueMax !== resetValueMax);
    mode = resetMode;
    value = resetValue;
    valueMax = resetValueMax;
    activeThumb = 'min';
    dragRaw = value;
    if (!changed) return;
    updateView();
    emit();
  }

  listen('pointerdown', onPointerDown);
  listen('pointermove', onPointerMove);
  listen('pointerup', onPointerUp);
  listen('pointercancel', onPointerCancel);
  listen('wheel', onWheel, { passive: false });
  listen('keydown', onKeyDown);
  listen('dblclick', (e) => {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    resetToDefault();
  });

  updateView();
  applyGhost(opts.ghostValue != null ? opts.ghostValue : null);
  if (container && typeof container.appendChild === 'function') {
    container.appendChild(root);
  }

  // -- public handle -------------------------------------------------------

  let destroyed = false;

  return {
    el: root,
    /** Update the knob silently — no onInput. Accepts number | {min,max}; the mode follows. */
    set(v) {
      closeEditor();
      if (v != null && typeof v === 'object') {
        const a = quantise(toFinite(v.min, value));
        const b = quantise(toFinite(v.max, value));
        // With allowRange:false this is DISPLAY only — a span made elsewhere
        // (Advanced's Tempo) still draws here, because refusing to draw state
        // that exists would be the readout lying. The gesture handlers are
        // what keep such a dial single: see collapseIfSingleOnly().
        mode = 'range';
        value = Math.min(a, b);
        valueMax = Math.max(a, b);
        activeThumb = 'min';
        updateView();
      } else {
        const wasRange = mode === 'range';
        mode = 'single';
        commit(v, false);
        if (wasRange) updateView(); // commit may early-return; the mode switch must still render
      }
      dragRaw = value;
    },
    /** Moves/hides the ghost pointer (kit editor "common" readout). See the
     * ghostValue doc above — number | {min,max} | null, display-only. */
    setGhost(v) {
      applyGhost(v);
    },
    /**
     * Where inside the span the value actually is at this instant — a number
     * from a caller polling the engine, or null to hide the mark. Display
     * only: it never commits, never fires onInput, and is ignored outside
     * range mode where the main pointer already shows it.
     */
    setLive(v) {
      // `Number(null)` is 0, not NaN — checking finiteness alone would turn
      // "hide the mark" into "the mark is at zero".
      const n = v == null ? NaN : Number(v);
      liveValue = Number.isFinite(n) ? n : null;
      applyLive();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      dragging = false;
      closeEditor();
      try {
        valueEl.removeEventListener('click', onValueClick);
        valueEl.removeEventListener('keydown', onValueKeydown);
      } catch {
        // ignore
      }
      for (const [type, fn, listenOpts] of listeners) {
        try {
          root.removeEventListener(type, fn, listenOpts);
        } catch {
          // ignore
        }
      }
      listeners.length = 0;
      try {
        if (typeof root.remove === 'function') root.remove();
        else if (root.parentNode) root.parentNode.removeChild(root);
      } catch {
        // ignore
      }
    },
  };
}

export default createKnob;
