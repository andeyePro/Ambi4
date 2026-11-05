/**
 * Promoted from tests/pending on 2026-11-05, once the test bridge was back:
 * the two faults its first real run found in the drive itself are fixed.
 *
 * Fault one: the octave exception's predicate read v.row.min/.max while the
 * value handed to it was an ARRAY. Rows are [min, max] arrays throughout now.
 *
 * Fault two, the real lesson: a LOG dial reports 0..1 in aria-valuemin/max by
 * construction (addLogKnob maps the domain onto a normalised axis), so
 * filter.cutoff and the three ADSR times could never match their row's bounds
 * through ARIA. The drive branches on the row's own `curve`: a log row's dial
 * must be drawn [0, 1], a linear row's over its own ends — so the page draws
 * as log exactly the rows the registry declares log — and every dial's
 * Home/End must store the row's ends in the ENGINE, which is the only witness
 * that a log dial's normalised axis maps onto its row's domain. The two dials
 * that depart from their row (Octave's ±1, Resonance drawn linear) are held
 * to exactly their recorded departure in DEPARTURES, pending the owner.
 */

/**
 * Every dial's bounds are the registry row's bounds.
 *
 *   npm run build && .vibe/measure.sh local drive tests/registry-dial-drive.mjs
 *
 * Routing phase 2a and 2b (v0.0.166, v0.0.169) moved every patch dial's domain
 * out of the page and into the registry the engine's own sanitiser is built
 * from, and both commits said "no dial moves; the full gate is the proof". The
 * gate could not have proved it: nothing in the suite read a rendered dial's
 * bounds at all, so a mistyped path returning the literal fallback, or a row
 * whose domain does not match the dial drawn from it, would have shipped
 * green. That is the repo's named failure mode — a control that draws a value
 * the engine never receives — and this drive is what closes it.
 *
 * It reads the bounds off the DOM (aria-valuemin/max, what a screen reader and
 * the gesture layer both use) and the domain out of the engine's own exported
 * table, so neither side of the comparison is derived from the other.
 *
 * Two traps this file obeys, both of which have produced false results here:
 * a fresh visit draws a RANDOM genre, so the genre is pinned and the pin is
 * verified at the engine before anything is asserted; and closing an editor
 * hides it rather than removing it, so every query is scoped to the panel
 * being read.
 */

/**
 * The dials that deliberately depart from their registry row, each with the
 * owner's open ruling it waits on. The page keeps the same set in
 * index.astro's DIAL_DEPARTURES (tests/registry-contract.mjs pins it there);
 * this drive holds each one to EXACTLY its recorded departure, so the entry
 * cannot widen quietly, and a ruling either way turns it red until this list
 * follows. A new entry has to carry its ruling too — a dial quietly differing
 * from what the engine accepts is a dial that cannot reach values a share
 * link can carry.
 */
const DEPARTURES = {
  'source.octave': {
    ruling: 'the dial ships ±1 while the row takes ±2 — held pending the owner (fromClaude 11)',
    dial: [-1, 1],
  },
  'filter.q': {
    ruling: 'the row says log and Resonance is drawn linear — held pending the owner (fromClaude 10/28)',
    curve: 'linear',
  },
};

const near = (a, b) => typeof a === 'number' && Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b));

export default async function drive(page) {
  const results = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
  };

  await page.click('#consent-slot button:has-text("Save on this device")').catch(() => {});
  await page.waitForTimeout(200);

  // Synthwave's pad (polysaw) carries the widest set of source dials, which is
  // why the other dial drives pin it too. The option values are PREFIXED, and
  // a pin that does not take must be loud rather than a silent pass-through.
  await page.evaluate(() => {
    const sel = document.getElementById('genre-select');
    const opt = [...sel.options].find((o) => o.value === 'g:synthwave');
    if (opt) {
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  const pinned = await page
    .waitForFunction(() => window.__ambi4Engine?.getParams?.()?.tracks?.pad?.voice === 'polysaw',
      { timeout: 5000 })
    .then(() => true).catch(() => false);
  if (!pinned) {
    const padVoice = await page.evaluate(() => window.__ambi4Engine?.getParams?.()?.tracks?.pad?.voice);
    throw new Error(`registry-dial-drive: the Synthwave pin did not apply — pad voice is ${JSON.stringify(padVoice)}`);
  }
  await page.waitForTimeout(400);

  // Open the pad's voice editor, where the patch dials live. The toggle lives
  // on the track row, not at a stable id — the same route every other editor
  // drive takes.
  await page.click('#tab-advanced');
  await page.waitForTimeout(400);
  const opened = await page.evaluate(() => {
    for (const row of document.querySelectorAll('.track-row')) {
      if (/pad/i.test(row.textContent || '')) { row.querySelector('.voice-edit-toggle')?.click(); return true; }
    }
    return false;
  });
  check('the pad voice editor opened', opened, true);
  await page.waitForTimeout(700);

  const registryPresent = await page.evaluate(() => !!window.__ambi4Registry);
  check('the engine exposes the registry to the page it renders from', registryPresent, true);

  const dials = await page.evaluate(() => {
    const scope = document.querySelector('#voice-editor-pad');
    if (!scope) return { error: 'no #voice-editor-pad in the DOM' };
    const table = window.__ambi4Registry || {};
    const vis = (el) => {
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        if (n.hidden || n.getAttribute?.('aria-hidden') === 'true') return false;
        const cs = getComputedStyle(n);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      }
      return true;
    };
    const out = [];
    for (const cell of scope.querySelectorAll('.knob-cell[data-field]')) {
      const knob = cell.querySelector('.knob');
      if (!knob || !vis(cell)) continue;
      const field = cell.dataset.field;
      const row = table[`patch.${field}`];
      out.push({
        field,
        min: Number(knob.getAttribute('aria-valuemin')),
        max: Number(knob.getAttribute('aria-valuemax')),
        row: row && row.kind === 'number' ? [row.domain[0], row.domain[1]] : null,
        curve: row ? row.curve : null,
        kind: row ? row.kind : null,
      });
    }
    return { out };
  });
  if (dials.error) throw new Error(`registry-dial-drive: ${dials.error}`);

  check('the editor drew dials that name their parameter', dials.out.length, (n) => n >= 8);

  // Read the stored value the ENGINE holds for this pad patch field, not the
  // readout: a dial drawing an end the engine never receives is the failure
  // this drive exists for.
  const stored = (field) => page.evaluate((f) => {
    const [section, key] = f.split('.');
    return window.__ambi4Engine?.getParams?.()?.patches?.pad?.polysaw?.[section]?.[key] ?? null;
  }, field);
  const lowEnd = (v) => (v && typeof v === 'object' ? v.min : v);
  const highEnd = (v) => (v && typeof v === 'object' ? v.max : v);
  // Home, then Shift+End: in single mode both move the one value; in range
  // mode Home takes the min thumb (the default active one) and Shift forces
  // the max thumb, so each press lands on exactly one end.
  const reachEnds = async (field) => {
    const sel = `#voice-editor-pad .knob-cell[data-field="${field}"] .knob`;
    await page.evaluate((q) => {
      const k = document.querySelector(q);
      k.scrollIntoView({ block: 'center' });
      k.focus();
    }, sel);
    await page.keyboard.press('Home');
    await page.waitForTimeout(250);
    const lo = lowEnd(await stored(field));
    await page.keyboard.press('Shift+End');
    await page.waitForTimeout(250);
    const hi = highEnd(await stored(field));
    return [lo, hi];
  };

  for (const d of dials.out) {
    // A dial with no row at all: since v0.0.166 the spec tables carry no
    // min/max of their own, so this is a dial with nothing behind its bounds.
    if (!d.row) {
      check(`${d.field} has a numeric registry row`, d.kind, (k) => k !== null && k !== undefined);
      continue;
    }
    const dep = DEPARTURES[d.field] || {};
    const reach = dep.dial || d.row;
    const curve = dep.curve || d.curve;
    const tag = dep.ruling ? ` (recorded departure: ${dep.ruling})` : '';
    // The drawing: a LOG dial reports 0..1 in ARIA by construction —
    // addLogKnob maps the row's domain onto a normalised axis — so a log row
    // must be drawn [0, 1] and a linear row over its own ends. A log row
    // drawn over its ends is a dial drawn linear against its row.
    check(`${d.field} is drawn ${curve} over ${curve === 'log' ? '[0,1]' : JSON.stringify(reach)}${tag}`,
      [d.min, d.max], curve === 'log' ? [0, 1] : reach);
    // The reach: Home and End land on the ends the engine stores. For a log
    // dial this is the only witness that its normalised axis maps onto the
    // row's domain rather than some other one.
    const ends = await reachEnds(d.field);
    check(`${d.field}'s Home/End store ${JSON.stringify(reach)} in the engine${tag}`,
      ends, (v) => near(v[0], reach[0]) && near(v[1], reach[1]));
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'registry-dial-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n'),
    );
  }
  return { passed: results.length };
}
