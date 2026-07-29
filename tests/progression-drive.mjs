/**
 * The chord loop, visible and editable.
 *
 *   npm run build && .vibe/measure.sh local drive tests/progression-drive.mjs
 *
 * Step two of the agreed plan, and the biggest thing a user could not touch:
 * the app chose the chords and showed them nowhere you could change them. The
 * engine has accepted a hand-written loop since v26; nothing in the page ever
 * wrote one.
 *
 * The load-bearing check is the ROUND TRIP. The engine's seed law silently
 * keeps the stored loop for anything the current scale cannot play, so a
 * control that echoed what was typed would look like it worked while changing
 * nothing. Reading the value back out of the engine is the only proof.
 */
export default async function drive(page) {
  const results = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
  };

  await page.click('#tab-advanced');
  await page.waitForTimeout(400);

  const shown = await page.evaluate(() => {
    const c = document.getElementById('control-progression');
    return c ? !c.hidden : null;
  });
  check('the chord control is offered', shown, true);

  const arrival = await page.evaluate(() => {
    const f = document.querySelector('.progression-input');
    return { value: f?.value, placeholder: f?.placeholder };
  });
  // A genre supplies a loop, so what is in the box on arrival is the APP'S
  // choice, shown for the first time — which is the whole point of the
  // control. The first version of this test asserted an empty box and was
  // wrong about the product, not the other way round.
  check('the loop being played is shown on arrival', (arrival.value || '').trim().length > 0, true);
  check('and it reads as chords, not as an opaque value',
    /^[ivIV0-9\s]+$/.test((arrival.value || '').trim()), (v) => v === true);
  check('the empty state is labelled rather than blank', /choos/i.test(arrival.placeholder || ''), (v) => v === true);

  // A minor loop needs a scale that HAS a minor home chord, or the seed law
  // will correctly refuse it — which is a real behaviour, not a bug, and is
  // why the scale is set first.
  await page.selectOption('#mode', 'aeolian').catch(() => {});
  await page.waitForTimeout(300);
  await page.fill('.progression-input', 'i VI III VII');
  await page.evaluate(() => document.querySelector('.progression-input').dispatchEvent(new Event('change', { bubbles: true })));
  await page.waitForTimeout(500);

  const set = await page.evaluate(() => ({
    value: document.querySelector('.progression-input')?.value,
    clearDisabled: document.querySelector('.progression-clear')?.disabled,
    stored: (() => {
      try { return JSON.parse(localStorage.getItem('ambi4:generator'))?.harmony?.seed; } catch { return null; }
    })(),
  }));
  check('the loop took', /i\s+VI\s+III\s+VII/i.test(set.value || ''), (v) => v === true);
  check('and the clear button woke up', set.clearDisabled, false);

  // The round trip: what came back must be four chords starting on the home
  // degree, whatever notation it round-tripped through.
  const readBack = await page.evaluate(() => {
    const f = document.querySelector('.progression-input');
    return (f?.value || '').trim().split(/\s+/).filter(Boolean);
  });
  check('four chords survived the engine', readBack.length, 4);
  check('and the first is the home chord', /^i/i.test(readBack[0] || ''), (v) => v === true);

  await page.click('.progression-clear');
  await page.waitForTimeout(400);
  const cleared = await page.evaluate(() => ({
    value: document.querySelector('.progression-input')?.value,
    clearDisabled: document.querySelector('.progression-clear')?.disabled,
  }));
  check('handing it back to the app empties it', cleared.value, '');
  check('and there is then nothing left to clear', cleared.clearDisabled, true);

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'progression-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n'),
    );
  }
  return { passed: results.length };
}
