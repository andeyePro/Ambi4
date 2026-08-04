/**
 * Type a beat: his 118, "Much better, how do I type percussion?"
 *
 *   npm run build && .vibe/measure.sh local drive tests/typed-beat-drive.mjs
 *
 * Until v0.0.147 the answer was "you cannot" — typing wrote NOTE NAMES and a kit
 * has none. A drum line is now typed the way drum machines have always written
 * one: one token per STEP, letters naming the sound, a dot for a rest, case for
 * the accent. Asserted at the ENGINE's own stored lanes, because a grid drawing
 * an import the engine never received is this repo's oldest failure.
 */

export default async function drive(page) {
  const results = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
  };

  await page.click('#consent-slot button:has-text("Save on this device")').catch(() => {});
  await page.waitForTimeout(200);
  await page.selectOption('#time-signature', '4/4').catch(() => {});
  await page.waitForTimeout(300);
  await page.click('#play-along-open');
  await page.waitForTimeout(300);

  const present = await page.evaluate(() => ({
    input: !!document.getElementById('compose-beat-text'),
    button: !!document.getElementById('compose-beat-write'),
    placeholder: document.getElementById('compose-beat-text')?.placeholder || '',
  }));
  check('the beat box is in the compose row', present.input && present.button, (v) => v === true);
  check('…and says what the letters are', /K kick/.test(present.placeholder), (v) => v === true);

  const write = async (text) => {
    await page.evaluate((t) => {
      const box = document.getElementById('compose-beat-text');
      box.value = t;
      box.dispatchEvent(new Event('input', { bubbles: true }));
    }, text);
    await page.click('#compose-beat-write');
    await page.waitForTimeout(700);
    return page.evaluate(() => {
      const track = window.__ambi4Engine.getParams().tracks.percussion;
      const bar = (index) => {
        const seq = track.sequencers[index];
        if (!seq) return null;
        return Object.fromEntries(Object.entries(seq.steps).map(([lane, steps]) => [
          lane,
          steps.map((s, i) => (s.on ? { slot: i, vmax: +s.vmax.toFixed(2) } : null)).filter(Boolean),
        ]));
      };
      return {
        bars: track.sequencers.length,
        advance: track.sequencerAdvance ?? null,
        state: track.state,
        mode: track.sequencers[0].mode,
        bar1: bar(0),
        bar2: bar(1),
        tip: document.getElementById('guided-tip')?.textContent || '',
      };
    });
  };

  // Four to the floor with hats between, a ghost snare, and two sounds at once.
  const four = await write('K H s H KH H S H');
  check('the kit is on and manual', four.state !== 'off' && four.mode === 'manual', (v) => v === true);
  check('kicks land on the slots they were typed in',
    four.bar1.low.map((s) => s.slot), [0, 4]);
  // 4 is the KH token: the hat lands there as well as the kick, which is the
  // whole point of two letters in one token.
  check('hats land on every step they were named in',
    four.bar1.high.map((s) => s.slot), [1, 3, 4, 5, 7]);
  check('the snare hits both times it was named', four.bar1.mid.map((s) => s.slot), [2, 6]);
  // Case is the accent: a lower-case s is a ghost note, an upper-case S is not.
  check('lower case is a quiet hit, upper case a hard one',
    four.bar1.mid.map((s) => s.vmax), [0.6, 0.95]);
  check('two letters in one token are two sounds on the same step',
    four.bar1.low.some((s) => s.slot === 4) && four.bar1.high.some((s) => s.slot === 4), (v) => v === true);
  check('the report counts the hits', /Beat written: 9 hits/.test(four.tip), (v) => v === true);

  // Longer than a bar: more bars, chained in order — the melody's own machinery.
  const long = await write(['K . . .'.repeat(1), '. . . .', '. . . .', '. . . .', 'S . . .'].join(' '));
  check('a beat longer than a bar writes a second bar', long.bars, 2);
  check('…played in order at the ENGINE', long.advance, 'chain');
  check('…and the overflow lands at the top of bar 2', long.bar2.mid.map((s) => s.slot), [0]);

  // An explicit bar break jumps to the next bar even mid-bar.
  const broken = await write('K | S');
  check('| starts a new bar', broken.bars, 2);
  check('…with the kick alone in bar 1', broken.bar1.low.map((s) => s.slot), [0]);
  check('…and the snare at the top of bar 2', broken.bar2.mid.map((s) => s.slot), [0]);

  // Nonsense is refused with a reason, and leaves the grid alone.
  const before = await page.evaluate(() =>
    JSON.stringify(window.__ambi4Engine.getParams().tracks.percussion.sequencers));
  await page.evaluate(() => {
    const box = document.getElementById('compose-beat-text');
    box.value = 'zz qq';
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('#compose-beat-write');
  await page.waitForTimeout(500);
  const refused = await page.evaluate(() => ({
    tip: document.getElementById('guided-tip')?.textContent || '',
    now: JSON.stringify(window.__ambi4Engine.getParams().tracks.percussion.sequencers),
  }));
  check('a line with no drums in it says what the letters are', /K is the kick/.test(refused.tip), (v) => v === true);
  check('…and leaves the beat that was there alone', refused.now, before);

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'typed-beat-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n'),
    );
  }
  return { passed: results.length };
}
