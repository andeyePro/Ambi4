/**
 * The audible half of chord editing.
 *
 *   npm run build && .vibe/measure.sh local drive tests/chordchip-drive.mjs
 *
 * His amendment to step 2, verbatim: "that only works for people who can hear
 * chords in their head when they see the names, we need an audible version of
 * this with a nice visual manipulator for those who can't."
 *
 * v0.0.68 shipped the numerals, which was his own instruction and the right
 * first move. This proves the follow-on actually does what it claims:
 *
 *  1. every chord in the loop shows the NOTES it contains, not only its name;
 *  2. the tools move the chord and the stored loop follows — the chips are an
 *     editor, not a picture of one;
 *  3. changing the KEY re-colours every chip while leaving the stored loop
 *     alone, which is the engine's model made visible rather than papered
 *     over;
 *  4. pressing a chord actually sounds it — asserted through the engine's own
 *     live-note path rather than by listening, since a button that lights up
 *     and plays nothing is exactly the failure this feature is for.
 */

const chips = (page) =>
  page.evaluate(() => [...document.querySelectorAll('#progression-chords .chord-chip')].map((c) => ({
    numeral: c.querySelector('.chord-chip-numeral')?.textContent || '',
    name: c.querySelector('.chord-chip-name')?.textContent || '',
    notes: c.querySelector('.chord-chip-notes')?.textContent || '',
  })));

const storedLoop = (page) =>
  page.evaluate(() => {
    const seed = window.__ambi4Engine?.getParams?.()?.harmony?.seed;
    return Array.isArray(seed) ? seed.map((s) => `${s.degree}:${s.extension}`).join(' ') : null;
  });

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

  // Pin the scale first. A fresh visit draws a RANDOM genre, and a genre in a
  // five-note scale refuses a loop containing vii outright — the seed law
  // keeps the stored loop whole rather than repairing it. Without this line
  // the test passes or fails on which genre was drawn, which is the flakiest
  // kind of red there is.
  await page.selectOption('#mode', 'aeolian');
  await page.waitForTimeout(300);

  // Write a loop through the text field, which is the route that already
  // existed — so this also proves the two editors are views of ONE value.
  await page.fill('#progression-row .progression-input', 'i VI III VII');
  await page.press('#progression-row .progression-input', 'Enter');
  await page.waitForTimeout(500);

  const first = await chips(page);
  check('one chip per chord in the loop', first.length, 4);
  check('each names its degree', first.map((c) => c.numeral), ['i', 'vi', 'iii', 'vii']);
  // The whole point of the amendment: the notes, not only the name.
  check('each shows the notes it actually contains',
    first.every((c) => /[A-G][♯]?-?\d/.test(c.notes)), (v) => v === true);
  check('and an honest chord name', first.every((c) => c.name.length > 0), (v) => v === true);
  results.push({ name: 'chips as built', ok: true, got: first, want: '(informational)' });

  // 2. The tools edit. Moving the first chord up a scale step must change both
  // the chip and the loop the ENGINE holds.
  const before = await storedLoop(page);
  await page.click('#progression-chords .chord-chip:first-child .chord-chip-step');
  await page.waitForTimeout(500);
  const after = await storedLoop(page);
  check('a step button changes the stored loop', after !== before, (v) => v === true);
  check('and only the chord that was pressed',
    after.split(' ').slice(1).join(' '), before.split(' ').slice(1).join(' '));

  // The colour cycle. It writes a real change to the stored loop every time —
  // but the extension is a NUDGE relative to Complexity, not an absolute
  // width, so at some Complexity settings two of the three land on the same
  // chord. That is the engine's design, and the requirement here is that the
  // app SAYS SO rather than leaving a button that appears to do nothing.
  const widenedFrom = (await chips(page))[0];
  const extBefore = (await storedLoop(page)).split(' ')[0];
  await page.click('#progression-chords .chord-chip:first-child .chord-chip-colour');
  await page.waitForTimeout(500);
  const widenedTo = (await chips(page))[0];
  check('the colour button changes what is stored',
    (await storedLoop(page)).split(' ')[0] !== extBefore, (v) => v === true);
  const audible = widenedTo.notes !== widenedFrom.notes || widenedTo.name !== widenedFrom.name;
  const hint = await page.evaluate(() => document.getElementById('progression-hint')?.textContent || '');
  check('and either the chord changes or the app explains why it did not',
    audible || /decided by Complexity/.test(hint), (v) => v === true);
  results.push({ name: 'colour change was audible', ok: true, got: audible, want: '(informational)' });

  // Add and remove.
  await page.click('#progression-chords .chord-chip-add');
  await page.waitForTimeout(400);
  check('Add a chord lengthens the loop', (await chips(page)).length, 5);
  await page.click('#progression-chords .chord-chip:first-child .chord-chip-drop');
  await page.waitForTimeout(400);
  check('and × shortens it', (await chips(page)).length, 4);

  // 3. A key change re-colours the chips and leaves the stored loop alone.
  const loopBeforeKey = await storedLoop(page);
  const notesBeforeKey = (await chips(page)).map((c) => c.notes).join('|');
  await page.selectOption('#root', 'F');
  await page.waitForTimeout(500);
  const notesAfterKey = (await chips(page)).map((c) => c.notes).join('|');
  check('a key change re-colours every chip', notesAfterKey !== notesBeforeKey, (v) => v === true);
  check('and does not touch the stored loop', await storedLoop(page), loopBeforeKey);

  // 4. Pressing a chord sounds it. Counted at the engine, because a chip that
  // lights up and plays nothing is precisely what this feature exists to fix.
  await page.click('#toggle-play');
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    window.__chordHeard = 0;
    window.__ambi4Engine.on('note', (e) => { if (e && e.live) window.__chordHeard += 1; });
  });
  await page.click('#progression-chords .chord-chip:first-child .chord-chip-hear');
  await page.waitForTimeout(600);
  const heard = await page.evaluate(() => window.__chordHeard);
  check('pressing a chord actually sounds it', heard > 0, (v) => v === true);
  check('and sounds every note in it, not just the root', heard >= 3, (v) => v === true);
  results.push({ name: 'notes sounded', ok: true, got: heard, want: '(informational)' });

  const sounding = await page.evaluate(() =>
    document.querySelectorAll('.chord-chip-sounding').length);
  check('the chip says it is the one making the noise', sounding, 1);

  // And it stops on its own rather than hanging the note on.
  await page.waitForTimeout(1400);
  check('the preview releases itself', await page.evaluate(() =>
    document.querySelectorAll('.chord-chip-sounding').length), 0);

  await page.click('#toggle-play').catch(() => {});

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'chordchip-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n'),
    );
  }
  return { passed: results.length, notes: results.filter((r) => r.want === '(informational)').map((r) => `${r.name}: ${JSON.stringify(r.got)}`) };
}
