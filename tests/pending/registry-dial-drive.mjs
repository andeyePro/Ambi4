/**
 * PARKED, two known faults from its first real run against the deployed page —
 * kept out of tests/ so the drive sweep stays honest (sweep-drives.sh runs
 * every tests/*-drive.mjs, and a drive that is wrong about its own subject is
 * worse than no drive).
 *
 * It DID run, and the seam it needs works: the registry reaches the page as
 * window.__ambi4Registry and every dial now names its parameter in the DOM
 * (both landed in v0.0.171 and are committed).
 *
 * Fault one, mine: the octave exception's predicate reads v.row.min/.max
 * while the value handed to it is an ARRAY — [min, max]. Use v.row[0]/v.row[1].
 *
 * Fault two, the real lesson: a LOG dial reports 0..1 in aria-valuemin/max by
 * construction (addLogKnob maps the domain onto a normalised axis), so
 * filter.cutoff and the three ADSR times can never match their row's bounds
 * through ARIA. The drive must branch on the row's own `curve`: a log row's
 * dial is expected to be [0, 1], and the check worth making for those is that
 * the page draws as log exactly the rows the registry declares log. That
 * comparison finds a real discrepancy the review already flagged —
 * patch.filter.q declares curve 'log' and is drawn linear — so expect it to go
 * red and record it as a finding, not as a bug in the drive.
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
 * The one dial that is deliberately narrower than its row, with the reason it
 * is allowed to be. If this list ever needs a second entry, the entry has to
 * carry a reason too — a dial quietly narrower than what the engine accepts is
 * a dial that cannot reach values a share link can carry.
 */
const NARROWER_THAN_ITS_ROW = {
  'source.octave': 'the dial ships ±1 while the row takes ±2 — an unexplained cap, in TODO as a decision',
};

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
        row: row && row.kind === 'number' ? { min: row.domain[0], max: row.domain[1] } : null,
        kind: row ? row.kind : null,
      });
    }
    return { out };
  });
  if (dials.error) throw new Error(`registry-dial-drive: ${dials.error}`);

  check('the editor drew dials that name their parameter', dials.out.length, (n) => n >= 8);

  for (const d of dials.out) {
    // A dial with no row at all: since v0.0.166 the spec tables carry no
    // min/max of their own, so this is a dial with nothing behind its bounds.
    if (!d.row) {
      check(`${d.field} has a numeric registry row`, d.kind, (k) => k !== null && k !== undefined);
      continue;
    }
    const exception = NARROWER_THAN_ITS_ROW[d.field];
    if (exception) {
      check(`${d.field} is the documented exception (${exception})`,
        { dial: [d.min, d.max], row: [d.row.min, d.row.max] },
        (v) => v.dial[0] >= v.row.min && v.dial[1] <= v.row.max
          && (v.dial[0] !== v.row.min || v.dial[1] !== v.row.max));
      continue;
    }
    check(`${d.field} draws its registry row's bounds`,
      { min: d.min, max: d.max }, { min: d.row.min, max: d.row.max });
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
