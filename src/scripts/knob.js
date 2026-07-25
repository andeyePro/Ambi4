/**
 * knob.js — 1970s hi-fi rotary knob control, rendered with SVG (v5 contract
 * plus the v7 dual-range addendum).
 *
 * export function createKnob(container, { label, min, max, value, step?, marks?,
 *   format?, onInput, allowRange?, rangeDefault?, defaultValue? }) =>
 *   { el, set(value), destroy() }
 *
 * 270° sweep (-135°..+135°) with a tick ring (minor ticks plus major marks at
 * `marks` values, or quartiles by default), an engraved pointer line on a
 * circular face, the label below and a formatted value readout beneath that.
 * All colours come from the theme tokens (--knob-face, --knob-ring,
 * --knob-pointer, --tick, --tick-major, --accent-warm, --label-font,
 * --secondary) with sensible fallbacks, so the knob renders before the theme
 * lands.
 *
 * Interaction: pointer-capture vertical drag (hold Shift for 10× finer
 * control), wheel (non-passive, small steps), full keyboard on the focusable
 * knob (role="slider": arrows ±step, PgUp/PgDn ±10 steps, Home/End), and
 * double-click resets to the DECLARED DEFAULT. `step` is optional — without
 * it the knob is continuous and keys move by (max-min)/200.
 *
 * `defaultValue` (number | {min,max}, optional): the value/mode double-click
 * restores. When omitted, double-click falls back to the pre-v12 behaviour
 * of restoring the INITIAL value/mode the knob was constructed with. A range
 * `defaultValue` collapses a scalar `value` on reset (and vice versa) exactly
 * like the initial-value case already did.
 *
 * v7 range mode: `value` accepts number | {min,max}. With `allowRange`, a
 * CLICK on the face (pointerup within 5 px and 300 ms of pointerdown, so
 * drags never toggle) switches single ↔ range — split keeps the value
 * (min=max=value), merge takes (min+max)/2. Range mode draws the engraved
 * inner pointer for min, a short accent pointer riding the ring for max, and
 * tints the arc between them with --accent-warm at low alpha. Plain
 * drag/wheel/arrows edit min; Shift selects max instead (fine-drag is a
 * single-mode nicety only); pointerdown within ~12° of the max pointer grabs
 * max regardless of Shift; the moving thumb clamps at the other. The knob
 * stays ONE tab stop: PgUp/PgDn/Home/End act on the last-edited thumb
 * (default min) and aria-valuetext reads "min X, max Y, drifting". onInput
 * emits a number in single mode and {min,max} in range mode; set() accepts
 * both and switches mode to match silently; `rangeDefault` starts a plain
 * numeric value split (min=max=value); double-click restores the INITIAL
 * value AND mode.
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
 * No imports; import-safe in bare Node — every DOM access happens inside
 * createKnob(), nothing at module scope touches document/window.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

const START_DEG = -135;
const SWEEP_DEG = 270;
const MINOR_TICKS = 25;
const DRAG_RANGE_PX = 200; // pixels of vertical travel for the full sweep

// v7 range-mode interaction thresholds
const CLICK_SLOP_PX = 5; // pointerup within this distance of pointerdown …
const CLICK_MS = 300; //    … and this fast = a click (mode toggle)
const MAX_GRAB_DEG = 12; // pointerdown within this many degrees grabs the max thumb

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
    return { el: null, set() {}, destroy() {} };
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
  const format = typeof opts.format === 'function' ? opts.format : null;
  const allowRange = !!opts.allowRange;
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
  const rangeArc = document.createElementNS(SVG_NS, 'path');
  rangeArc.setAttribute('stroke-width', '5');
  rangeArc.setAttribute('stroke-linecap', 'round');
  rangeArc.style.fill = 'none';
  rangeArc.style.stroke = ACCENT_WARM;
  rangeArc.style.opacity = '0.35';
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
  pointer.setAttribute('stroke-width', '2.4');
  pointer.setAttribute('stroke-linecap', 'round');
  pointer.style.stroke = POINTER_STROKE;
  pointerGroup.appendChild(pointer);
  svg.appendChild(pointerGroup);

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

  const valueEl = document.createElement('div');
  valueEl.className = 'knob-value';
  valueEl.style.fontFamily = LABEL_FONT;
  valueEl.style.color = VALUE_COLOR;
  valueEl.style.fontSize = '12px';
  valueEl.style.textAlign = 'center';
  root.appendChild(valueEl);

  function degFor(v) {
    return START_DEG + (SWEEP_DEG * (v - min)) / range;
  }

  // v12: an optional `glyph(value, valueMax)` renders trusted inline SVG
  // markup ahead of the text readout (e.g. a waveform icon, or a pair for a
  // fractional morph) — the glyph node carries no text, so el.children[2]
  // .textContent stays exactly `fmt(...)`, same as the no-glyph path.
  const glyphFn = typeof opts.glyph === 'function' ? opts.glyph : null;
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
    valueEl.appendChild(document.createTextNode(text));
  }

  function updateView() {
    const deg = degFor(value);
    pointerGroup.setAttribute('transform', `rotate(${+deg.toFixed(2)} ${CX} ${CY})`);
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
      root.setAttribute('aria-valuetext', `min ${fmt(value)}, max ${fmt(valueMax)}, drifting`);
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

  function commit(v, fireInput) {
    let next = quantise(v);
    if (mode === 'range' && next > valueMax) next = valueMax;
    if (next === value) return;
    value = next;
    updateView();
    if (fireInput) emit();
  }

  function commitMax(v, fireInput) {
    let next = quantise(v);
    if (next < value) next = value;
    if (next === valueMax) return;
    valueMax = next;
    updateView();
    if (fireInput) emit();
  }

  function toggleMode() {
    if (mode === 'single') {
      mode = 'range';
      valueMax = value; // split: min=max=value
    } else {
      mode = 'single';
      value = quantise((value + valueMax) / 2); // merge: midpoint
    }
    activeThumb = 'min';
    dragRaw = value;
    updateView();
    emit();
  }

  // -- interaction ---------------------------------------------------------

  const listeners = [];
  function listen(type, fn, listenOpts) {
    root.addEventListener(type, fn, listenOpts);
    listeners.push([type, fn, listenOpts]);
  }

  let dragging = false;
  let lastY = 0;
  let dragRaw = value; // continuous accumulator so `step` quantisation can't stall a drag
  let dragThumb = 'min';
  let pressed = false;
  let pressX = NaN;
  let pressY = NaN;
  let pressTime = 0;

  /** Pointer angle (deg, 0 = top, clockwise) relative to the face centre. */
  function pointerDeg(e) {
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
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.width / 2;
    return (Math.atan2(e.clientX - cx, cy - e.clientY) * 180) / Math.PI;
  }

  function onPointerDown(e) {
    if (e && e.button != null && e.button !== 0) return;
    dragging = true;
    lastY = e && typeof e.clientY === 'number' ? e.clientY : 0;
    pressed = true;
    pressX = e && typeof e.clientX === 'number' ? e.clientX : NaN;
    pressY = e && typeof e.clientY === 'number' ? e.clientY : NaN;
    pressTime = Date.now();
    dragThumb = 'min';
    if (mode === 'range') {
      const deg = pointerDeg(e);
      if (deg != null) {
        let diff = deg - degFor(valueMax);
        while (diff > 180) diff -= 360;
        while (diff < -180) diff += 360;
        if (Math.abs(diff) <= MAX_GRAB_DEG) dragThumb = 'max'; // grab the outer thumb directly
      }
      if (dragThumb !== 'max' && e && e.shiftKey) dragThumb = 'max';
    }
    dragRaw = dragThumb === 'max' ? valueMax : value;
    try {
      if (e && e.pointerId != null && typeof root.setPointerCapture === 'function') {
        root.setPointerCapture(e.pointerId);
      }
    } catch {
      // capture is an enhancement, not a requirement
    }
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
  }

  function onPointerMove(e) {
    if (!dragging || !e || typeof e.clientY !== 'number') return;
    const dy = lastY - e.clientY; // drag up = increase
    lastY = e.clientY;
    // In range mode Shift selects the max thumb instead of fine control.
    const fine = mode !== 'range' && e.shiftKey ? 0.1 : 1;
    dragRaw += dy * (range / DRAG_RANGE_PX) * fine;
    const lo = mode === 'range' && dragThumb === 'max' ? value : min;
    const hi = mode === 'range' && dragThumb === 'min' ? valueMax : max;
    if (dragRaw < lo) dragRaw = lo;
    else if (dragRaw > hi) dragRaw = hi;
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
    dragRaw = value;
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
    pressed = false;
    endPointer(e);
    if (!allowRange || !wasPress || !e) return;
    const dx = typeof e.clientX === 'number' ? e.clientX - pressX : NaN;
    const dy = typeof e.clientY === 'number' ? e.clientY - pressY : NaN;
    const dist = Math.sqrt(dx * dx + dy * dy); // NaN when coords were missing → not a click
    if (dist <= CLICK_SLOP_PX && Date.now() - pressTime < CLICK_MS) toggleMode();
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
    let target = 'min';
    if (isRange) {
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
    if (isRange) activeThumb = target;
    if (target === 'max') commitMax(next, true);
    else commit(next, true);
  }

  function onDoubleClick(e) {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
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
  listen('dblclick', onDoubleClick);

  updateView();
  if (container && typeof container.appendChild === 'function') {
    container.appendChild(root);
  }

  // -- public handle -------------------------------------------------------

  let destroyed = false;

  return {
    el: root,
    /** Update the knob silently — no onInput. Accepts number | {min,max}; the mode follows. */
    set(v) {
      if (v != null && typeof v === 'object') {
        const a = quantise(toFinite(v.min, value));
        const b = quantise(toFinite(v.max, value));
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
    destroy() {
      if (destroyed) return;
      destroyed = true;
      dragging = false;
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
