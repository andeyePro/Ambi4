/**
 * Every dial that CAN carry a range does, and the ones that cannot say why.
 *
 *   npm run build && .vibe/measure.sh local drive tests/spread-all-drive.mjs
 *
 * The owner's instruction was "either tell me why you won't add variation to
 * all dials, or add it to them all, including OSCs and picker dials like filter
 * type". v0.0.74 added it to all of them except the string enums, so this file
 * exists to hold that line: it opens the voice editor, finds every visible
 * dial, drags each one sideways, and asserts that the ONLY ones which refuse
 * are the named-position controls that have no numeric axis at all.
 *
 * The failure mode this catches is the one the owner met twice: a dial that
 * looks spreadable, takes the gesture, and has the span dropped somewhere
 * between the DOM and setParams — so the check is on the ENGINE's stored value
 * as well as on the dial's own readout. A dial that shows a span the engine
 * never received is a lie, and would pass a DOM-only test.
 *
 * page.mouse is viewport-relative, so every interaction re-reads its target's
 * box after scrolling it to centre. See tests/dial-drive.mjs for the two false
 * results that rule came from.
 */

/** The named-position controls. A span between two NAMES means nothing. */
const ENUM_DIALS = new Set(['Type', 'Processor']);

/**
 * Drift rate is the one numeric dial still deliberately single-valued: it is
 * the speed at which every OTHER span walks, so spreading it would be asking a
 * walk to set its own step size. Called out here rather than left implied.
 */
const CIRCULAR_DIALS = new Set(['Drift rate']);

const visibleDials = (page, scope) =>
  page.evaluate((sel) => {
    const vis = (el) => {
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        if (n.hidden || n.getAttribute?.('aria-hidden') === 'true') return false;
        const cs = getComputedStyle(n);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      }
      return true;
    };
    return [...document.querySelectorAll(`${sel} .knob`)]
      .filter(vis)
      .map((k) => k.getAttribute('aria-label'))
      .filter((v, i, a) => v && a.indexOf(v) === i);
  }, scope);

const dialAt = (page, label, scope) =>
  page.evaluate(([name, sel]) => {
    const vis = (el) => {
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        if (n.hidden || n.getAttribute?.('aria-hidden') === 'true') return false;
        const cs = getComputedStyle(n);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      }
      return true;
    };
    const k = [...document.querySelectorAll(`${sel} .knob`)]
      .find((el) => el.getAttribute('aria-label') === name && vis(el));
    if (!k) return null;
    k.scrollIntoView({ block: 'center' });
    const r = k.getBoundingClientRect();
    return {
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.width / 2),
      valuetext: k.getAttribute('aria-valuetext'),
    };
  }, [label, scope]);

export default async function drive(page) {
  const results = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
  };

  async function dragSideways(label, scope, dx = 90) {
    const d = await dialAt(page, label, scope);
    if (!d) return null;
    await page.mouse.move(d.x, d.y);
    await page.mouse.down();
    for (let t = 4; t <= dx; t += 8) await page.mouse.move(d.x + t, d.y);
    await page.mouse.up();
    await page.waitForTimeout(260);
    return dialAt(page, label, scope);
  }

  const spread = (d) => /drifting/.test(d?.valuetext || '');

  await page.click('#consent-slot button:has-text("Save on this device")').catch(() => {});
  await page.waitForTimeout(200);
  // The fresh visit draws a RANDOM genre, and some genres deal the pad a
  // voice with no shape dial at all (glass exposes only detune and octave) —
  // which made the shape-span checks fail on the draw, intermittently. Pin
  // through the UI (the page's own settings must agree with the engine, so
  // an engine-side setParams is NOT equivalent): Synthwave is always in the
  // public picker and its pad (polysaw) carries every control this drive
  // drags.
  //
  // HISTORY, because this pin has now been wrong TWICE in the same way: the
  // picker's option values are PREFIXED ('g:synthwave', 'mood:…',
  // 'favourites'), and both earlier pins matched a value that no option
  // carries ('ambient', then bare 'synthwave') — .find() returned undefined,
  // nothing was selected, and the "intermittent shape-span loss" filed on
  // 2026-07-30 was this drive running unpinned on whatever the draw dealt:
  // a glass pad has no OSC dials, the named-dial loop silently skipped them,
  // and the end-check then read a shape1 nothing had dragged. So the pin is
  // now VERIFIED at the engine seam and a pin that did not take is its own
  // loud failure, never a silent pass-through.
  await page.evaluate(() => {
    const sel = document.getElementById('genre-select');
    const opt = [...sel.options].find((o) => o.value === 'g:synthwave');
    if (opt) {
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  const pinned = await page
    .waitForFunction(
      () => window.__ambi4Engine?.getParams?.()?.tracks?.pad?.voice === 'polysaw',
      { timeout: 5000 }
    )
    .then(() => true)
    .catch(() => false);
  if (!pinned) {
    const state = await page.evaluate(() => ({
      options: [...document.getElementById('genre-select').options].map((o) => o.value),
      padVoice: window.__ambi4Engine?.getParams?.()?.tracks?.pad?.voice,
    }));
    throw new Error(
      'spread-all-drive: the Synthwave pin did not apply — pad voice is ' +
        JSON.stringify(state.padVoice) +
        ', picker offers ' +
        JSON.stringify(state.options)
    );
  }
  await page.waitForTimeout(400);
  await page.click('#tab-advanced');
  await page.waitForTimeout(400);

  // Open a tuned voice editor: that is where the OSC dials the owner named
  // actually live, and where the v7 exclusions were.
  await page.click('#voice-edit-toggle-pad').catch(() => {});
  await page.waitForTimeout(600);

  const labels = await visibleDials(page, '#panel-advanced');
  check('the voice editor is open with its dials showing', labels.length >= 12, (v) => v === true);

  // The three that v0.0.74 changed, named individually so a regression on any
  // one of them fails by name rather than as a count. On the pinned polysaw
  // every one of these dials EXISTS, so a missing label is a failure, not a
  // skip — the silent `continue` that used to be here is exactly how the
  // unpinned-genre runs hid OSC 1 never being dragged at all.
  for (const label of ['Octave', 'OSC 1', 'OSC 2', 'Glide']) {
    check(`${label} is on the pinned pad`, labels.includes(label), (v) => v === true);
    if (!labels.includes(label)) continue;
    const after = await dragSideways(label, '#panel-advanced');
    check(`${label} takes a spread`, spread(after), (v) => v === true);
  }

  // Whatever else is on screen: numeric spreads, enums do not, and there is no
  // third category. A dial that neither spreads nor is a named enum is exactly
  // the silent-refusal the owner objected to.
  const refused = [];
  const spreadable = [];
  for (const label of labels) {
    if (ENUM_DIALS.has(label) || CIRCULAR_DIALS.has(label)) continue;
    const after = await dragSideways(label, '#panel-advanced');
    if (spread(after)) spreadable.push(label);
    else refused.push(label);
  }
  check('no numeric dial refuses the gesture', refused, []);
  results.push({ name: 'dials proven spreadable', ok: true, got: spreadable.length, want: '(informational)' });

  // The enums refuse, and refusing is the POINT — if one started accepting, the
  // engine would be storing a span it has no way to resolve to a filter type.
  for (const label of labels.filter((l) => ENUM_DIALS.has(l))) {
    const after = await dragSideways(label, '#panel-advanced');
    check(`${label} is a named enumeration and stays single`, spread(after), (v) => v === false);
  }

  // The load-bearing half: the ENGINE holds the span, not just the DOM. A dial
  // drawing a range the engine never received is the failure this catches.
  // KNOWN INTERMITTENT (filed 2026-07-30, TODO § Owner-reported defects):
  // roughly one run in three, the OSC 1 dial DRAWS its span while the engine
  // never stores it — the exact defect class this check exists to catch, so
  // it stays a hard failure rather than being retried into silence.
  const stored = await page.evaluate(() => {
    const p = window.__ambi4Engine?.getParams?.();
    const voice = p?.tracks?.pad?.voice;
    const src = p?.patches?.pad?.[voice]?.source || {};
    const isSpan = (v) => !!v && typeof v === 'object' && 'min' in v && 'max' in v;
    return {
      octave: isSpan(src.octave),
      shape1: isSpan(src.shape1),
      glide: isSpan(p?.tracks?.pad?.glide),
      filterType: typeof p?.patches?.pad?.[voice]?.filter?.type,
    };
  });
  check('the engine stored the octave span', stored.octave, (v) => v === true);
  check('the engine stored the shape span', stored.shape1, (v) => v === true);
  check('filter type is still the plain string the engine can use', stored.filterType, 'string');

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'spread-all-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n'),
    );
  }
  return { passed: results.length, notes: results.filter((r) => r.want === '(informational)').map((r) => `${r.name}: ${JSON.stringify(r.got)}`) };
}
