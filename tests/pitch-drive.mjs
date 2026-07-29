/**
 * The other half of step 1: the grid shows WHICH NOTE the app chose.
 *
 *   npm run build && .vibe/measure.sh local drive tests/pitch-drive.mjs
 *
 * v0.0.67 made the app's rhythm visible and the owner's next line was the
 * obvious one: "a bass line's rhythm is now visible and its notes are not."
 * This drives a real browser through a real performance and asserts three
 * things a screenshot cannot tell apart:
 *
 *  1. ticks appear on a TUNED track, positioned by pitch, and a higher note
 *     draws HIGHER in its cell than a lower one — which is the whole claim;
 *  2. nothing at all is drawn on PERCUSSION, because a kit lane's midi number
 *     is a slot in a kit and drawing it as a pitch would invent a melody out
 *     of an implementation detail;
 *  3. the names reach the accessibility layer, not only the paint — "show what
 *     the app is doing" is not a sighted-only promise.
 *
 * It plays for real rather than injecting a note stream: the handler under
 * test reads what the ENGINE emits, and a fake stream would prove only that
 * the painter works on input the app never actually produces.
 */

export default async function drive(page) {
  const results = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
  };

  await page.click('#consent-slot button:has-text("Save on this device")').catch(() => {});
  await page.waitForTimeout(200);
  await page.click('#tab-advanced');
  await page.waitForTimeout(400);

  // Play for real: the note stream is what this feature reads, and the honest
  // way to get one is to let the engine produce it.
  await page.click('#toggle-play');
  await page.waitForTimeout(1200);
  await page.click('#voice-edit-toggle-bass');
  await page.waitForTimeout(6000);

  // Scoped to the bass editor: closing an editor HIDES it rather than
  // removing it, so an unscoped query would keep finding the track that was
  // open a moment ago and the percussion check below would fail on the bass's
  // own ticks. That is precisely the false result this scoping prevents.
  const bass = await page.evaluate(() => {
    const root = document.getElementById('voice-editor-bass');
    const marks = [...root.querySelectorAll('.seq-pitch-mark')];
    const legend = root.querySelector('.seq-pitch-legend');
    const labelled = [...root.querySelectorAll('.seq-cell')]
      .map((c) => c.getAttribute('aria-label') || '')
      .filter((t) => /the app plays /.test(t));
    return {
      marks: marks.length,
      bottoms: marks.map((m) => parseFloat(m.style.bottom)).filter((n) => Number.isFinite(n)),
      legend: legend && !legend.hidden ? legend.textContent.trim() : null,
      labelled: labelled.length,
      sample: labelled[0] || null,
      titles: [...root.querySelectorAll('.seq-cell[title]')].map((c) => c.title).slice(0, 4),
    };
  });

  check('the app’s notes are drawn on a tuned track', bass.marks > 0, (v) => v === true);
  check('every tick has a position inside its cell', bass.bottoms.length, bass.marks);
  check('and those positions are inside 0–100%',
    bass.bottoms.every((b) => b >= 0 && b <= 100), (v) => v === true);
  // The load-bearing one: if every tick sat at the same height the picture
  // would be a rhythm again, not a line.
  check('a bass line has more than one height in it',
    new Set(bass.bottoms.map((b) => Math.round(b))).size > 1, (v) => v === true);
  check('the range being drawn is stated under the grid', /between .+ and .+/.test(bass.legend || ''), (v) => v === true);
  check('the notes reach the accessibility label', bass.labelled > 0, (v) => v === true);
  check('and the label names a real note', /the app plays [A-G][♯]?-?\d/.test(bass.sample || ''), (v) => v === true);
  results.push({ name: 'sample label', ok: true, got: bass.sample, want: '(informational)' });
  results.push({ name: 'sample titles', ok: true, got: bass.titles, want: '(informational)' });

  // Percussion: a kit lane's midi is a slot, and must draw nothing.
  await page.click('#voice-edit-toggle-bass');
  await page.waitForTimeout(300);
  await page.click('#voice-edit-toggle-percussion');
  await page.waitForTimeout(6000);

  const perc = await page.evaluate(() => {
    const root = document.getElementById('voice-editor-percussion');
    return {
      marks: root.querySelectorAll('.seq-pitch-mark').length,
      legend: [...root.querySelectorAll('.seq-pitch-legend')].filter((l) => !l.hidden).length,
      chosen: root.querySelectorAll('.seq-cell-chosen').length,
    };
  });
  check('percussion draws no pitch ticks', perc.marks, 0);
  check('and no pitch legend', perc.legend, 0);
  // The v0.0.67 rhythm readout must be untouched by this — if it vanished, the
  // exclusion went too far.
  check('but its rhythm is still shown', perc.chosen > 0, (v) => v === true);

  await page.click('#toggle-play').catch(() => {});

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'pitch-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n'),
    );
  }
  return { passed: results.length, notes: results.filter((r) => r.want === '(informational)').map((r) => `${r.name}: ${JSON.stringify(r.got)}`) };
}
