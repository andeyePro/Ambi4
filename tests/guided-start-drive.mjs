/**
 * The guided start: his genre tree, and what it does when answered.
 *
 *   npm run build && .vibe/measure.sh local drive tests/guided-start-drive.mjs
 *
 * His item 96: "Guided start, if it is as simple as this you can also ask if
 * people want to produce a certain genre (possibly giving them a genre tree,
 * with other as final answer with most) then let them know which instruments
 * composers in that genre most commonly start with. That would help the many
 * people who simply don't know where to start."
 *
 * Asserted at the ENGINE where it matters: answering the tree SEEDS that
 * genre's voices and switches nothing on or off — a guided start that began
 * playing (or silenced what was playing) would be making the choice for the
 * person it is helping.
 */

export default async function drive(page) {
  const results = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
  };

  await page.click('#consent-slot button:has-text("Save on this device")').catch(() => {});
  await page.waitForTimeout(200);
  await page.click('#play-along-open');
  await page.waitForTimeout(300);

  const choices = () =>
    page.evaluate(() => ({
      open: !document.getElementById('guided-tree')?.hidden,
      question: document.getElementById('guided-question')?.textContent || '',
      labels: [...document.querySelectorAll('#guided-choices button')].map((b) => b.textContent),
    }));

  const pick = async (label) => {
    await page.evaluate((text) => {
      [...document.querySelectorAll('#guided-choices button')]
        .find((b) => b.textContent === text)?.click();
    }, label);
    await page.waitForTimeout(400);
  };

  await page.click('#guided-start');
  await page.waitForTimeout(400);
  const first = await choices();
  check('the guided start asks a question', first.open, true);
  check('…about the feel, in plain words', /what do you want to make/i.test(first.question), (v) => v === true);
  // The moods offered are the ones the PUBLIC list actually has genres for —
  // only two genres are public (his v0.0.64 ruling: just the ones he did not
  // criticise), and both are Drive. Offering an empty mood would be a
  // question with no answers.
  check('…offering only moods that have genres', first.labels.length >= 2, (v) => v === true);
  check('…which today is Drive', first.labels.includes('Drive'), (v) => v === true);
  // His "other as final answer with most".
  check('…with Something else LAST', first.labels[first.labels.length - 1], 'Something else');

  await pick('Drive');
  const second = await choices();
  check('the second question narrows to genres', /nearest/i.test(second.question), (v) => v === true);
  check('…listing that mood\'s genres', second.labels.length >= 2, (v) => v === true);
  check('…and Something else again, never a dead end', second.labels[second.labels.length - 1], 'Something else');

  // Answering seeds the genre's VOICES and starts nothing: a guided start that
  // began playing would be making the choice for the person it is helping.
  // (A fresh visit already has a genre playing, so the law is that the pick
  // does not CHANGE what is sounding — not that everything is off.)
  const before = await page.evaluate(() =>
    Object.values(window.__ambi4Engine.getParams().tracks).map((t) => t.state));
  const genre = second.labels[0];
  await pick(genre);
  await page.waitForTimeout(700);
  const seeded = await page.evaluate(() => {
    const tracks = window.__ambi4Engine.getParams().tracks;
    return {
      treeClosed: document.getElementById('guided-tree')?.hidden,
      states: Object.values(tracks).map((t) => t.state),
      voices: Object.fromEntries(Object.entries(tracks).map(([k, v]) => [k, v.voice])),
      tip: document.getElementById('guided-tip')?.textContent || '',
      seedValue: document.getElementById('create-seed')?.value || '',
    };
  });
  check('answering closes the tree', seeded.treeClosed, true);
  check('…seeds that genre in the seed picker', seeded.seedValue.length > 0, (v) => v === true);
  check('…switches nothing on or off', seeded.states, before);
  check('…writes the genre\'s own voices to the ENGINE',
    Object.values(seeded.voices).every((v) => typeof v === 'string' && v.length > 0), (v) => v === true);
  check('…and names the instrument to start with', /start/i.test(seeded.tip), (v) => v === true);

  // The no-genre escape: Something else → Something else → no genre.
  await page.click('#guided-start');
  await page.waitForTimeout(400);
  await pick('Something else');
  const wide = await choices();
  // Every listed genre at once, plus the no-genre escape — so the last answer
  // is never a dead end, which is what his "other as final answer" asks for.
  check('Something else offers every listed genre plus an escape',
    wide.labels.length >= 3, (v) => v === true);
  check('…and a way in with no genre at all',
    wide.labels.some((l) => /no genre/i.test(l)), (v) => v === true);
  await pick(wide.labels.find((l) => /no genre/i.test(l)));
  const escaped = await page.evaluate(() => ({
    closed: document.getElementById('guided-tree')?.hidden,
    tip: document.getElementById('guided-tip')?.textContent || '',
  }));
  check('choosing no genre closes the tree', escaped.closed, true);
  check('…and names the three ways in that need none',
    /Tap a rhythm/.test(escaped.tip) && /Type the chords/.test(escaped.tip), (v) => v === true);

  // The button is a toggle, not a one-way door.
  await page.click('#guided-start');
  await page.waitForTimeout(300);
  await page.click('#guided-start');
  await page.waitForTimeout(300);
  const closed = await page.evaluate(() => document.getElementById('guided-tree')?.hidden);
  check('pressing Help me start again puts it away', closed, true);

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'guided-start-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n'),
    );
  }
  return { passed: results.length };
}
