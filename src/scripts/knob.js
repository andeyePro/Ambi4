/**
 * knob.js — 1970s hi-fi rotary knob control, rendered with SVG (v5 contract).
 *
 * export function createKnob(container, { label, min, max, value, step?, marks?,
 *   format?, onInput }) => { el, set(value), destroy() }
 *
 * 270° sweep (-135°..+135°) with a tick ring (minor ticks plus major marks at
 * `marks` values, or quartiles by default), an engraved pointer line on a
 * circular face, the label below and a formatted value readout beneath that.
 * All colours come from the theme tokens (--knob-face, --knob-ring,
 * --knob-pointer, --tick, --tick-major, --label-font, --secondary) with
 * sensible fallbacks, so the knob renders before the theme lands.
 *
 * Interaction: pointer-capture vertical drag (hold Shift for 10× finer
 * control), wheel (non-passive, small steps), full keyboard on the focusable
 * knob (role="slider": arrows ±step, PgUp/PgDn ±10 steps, Home/End), and
 * double-click resets to the INITIAL value. `step` is optional — without it
 * the knob is continuous and keys move by (max-min)/200.
 *
 * The value scale is strictly linear between min and max. Log-feel (e.g. a
 * filter-cutoff dial) is the CALLER's job: pass a mapped domain (such as
 * min=log2(40), max=log2(12000)) and unmap in `format`/`onInput`.
 *
 * No imports; import-safe in bare Node — every DOM access happens inside
 * createKnob(), nothing at module scope touches document/window.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

const START_DEG = -135;
const SWEEP_DEG = 270;
const MINOR_TICKS = 25;
const DRAG_RANGE_PX = 200; // pixels of vertical travel for the full sweep

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

  let value = quantise(toFinite(opts.value, (min + max) / 2));
  const initialValue = value;

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
  for (const mv of markValues) {
    const deg = START_DEG + (SWEEP_DEG * (mv - min)) / range;
    ticks.appendChild(tickLine(TICK_MAJOR_IN, TICK_MAJOR_OUT, deg, TICK_MAJOR_STROKE, 1.8));
  }
  svg.appendChild(ticks);

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

  function updateView() {
    const deg = START_DEG + (SWEEP_DEG * (value - min)) / range;
    pointerGroup.setAttribute('transform', `rotate(${+deg.toFixed(2)} ${CX} ${CY})`);
    root.setAttribute('aria-valuenow', String(value));
    root.setAttribute('aria-valuetext', fmt(value));
    valueEl.textContent = fmt(value);
  }

  function commit(v, fireInput) {
    const next = quantise(v);
    if (next === value) return;
    value = next;
    updateView();
    if (fireInput && onInput) {
      try {
        onInput(value);
      } catch {
        // a listener error must never break the knob
      }
    }
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

  function onPointerDown(e) {
    if (e && e.button != null && e.button !== 0) return;
    dragging = true;
    lastY = e && typeof e.clientY === 'number' ? e.clientY : 0;
    dragRaw = value;
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
    const fine = e.shiftKey ? 0.1 : 1;
    dragRaw += dy * (range / DRAG_RANGE_PX) * fine;
    if (dragRaw < min) dragRaw = min;
    else if (dragRaw > max) dragRaw = max;
    commit(dragRaw, true);
  }

  function onPointerUp(e) {
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

  function onWheel(e) {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    const dy = e && typeof e.deltaY === 'number' ? e.deltaY : 0;
    if (!dy) return;
    const fine = e && e.shiftKey ? 0.1 : 1;
    commit(value + (dy < 0 ? 1 : -1) * wheelStep * fine, true);
  }

  function onKeyDown(e) {
    let next = null;
    switch (e && e.key) {
      case 'ArrowUp':
      case 'ArrowRight':
        next = value + keyStep;
        break;
      case 'ArrowDown':
      case 'ArrowLeft':
        next = value - keyStep;
        break;
      case 'PageUp':
        next = value + keyStep * 10;
        break;
      case 'PageDown':
        next = value - keyStep * 10;
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
    commit(next, true);
  }

  function onDoubleClick(e) {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    dragRaw = initialValue;
    commit(initialValue, true);
  }

  listen('pointerdown', onPointerDown);
  listen('pointermove', onPointerMove);
  listen('pointerup', onPointerUp);
  listen('pointercancel', onPointerUp);
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
    /** Update the knob silently — no onInput. */
    set(v) {
      commit(v, false);
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
