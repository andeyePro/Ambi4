/**
 * Additive metres reach the ENGINE and survive a reload (v0.0.160, his 134).
 *
 *   npm run build && .vibe/measure.sh local drive tests/additive-metre-drive.mjs
 *
 * His proposal, verbatim: "Lets get around this by allowing multiple bars -
 * for example: 4/4+3/4 gives 7/4 -problem?" No problem — a repeating cycle of
 * bars, each its own legal metre, so no single bar outgrows the five-beat
 * lane. This drives the CONTROL (the custom metre's numerator takes "4+3")
 * and asserts the engine's stored value, the alternating bar events, and the
 * round-trip through a real reload — never just the readout.
 */

export default async function drive(page) {
  const results = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
  };

  await page.click('#consent-slot button:has-text("Save on this device")').catch(() => {});
  await page.waitForTimeout(300);
  await page.click('#tab-advanced');
  await page.waitForTimeout(300);

  // Pin the metre through the real control: Custom…, numerator "4+3", unit 4.
  await page.evaluate(() => {
    const select = document.getElementById('timeSignature');
    select.value = 'custom';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const n = document.getElementById('custom-metre-n');
    const d = document.getElementById('custom-metre-d');
    d.value = '4';
    n.value = '4+3';
    n.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(300);

  const stored = await page.evaluate(() => window.__ambi4Engine.getParams().timeSignature);
  check('the ENGINE stores the additive metre', stored, '4/4+3/4');

  // The engine plays it as alternating bars of 4 then 3 beats.
  const bars = await page.evaluate(async () => {
    const engine = window.__ambi4Engine;
    const seen = [];
    const off = engine.on('bar', (e) => seen.push({ bar: e.bar, beats: e.beatsPerBar }));
    document.getElementById('toggle-play').click();
    await new Promise((resolve) => {
      const poll = setInterval(() => {
        if (seen.length >= 3) { clearInterval(poll); resolve(); }
      }, 200);
      setTimeout(() => { clearInterval(poll); resolve(); }, 25000);
    });
    document.getElementById('toggle-play').click(); // begin the finish
    if (typeof off === 'function') off();
    return seen.slice(0, 4);
  });
  check('at least three bars played', bars.length >= 3, (v) => v === true);
  check('every bar plays its own component (4,3,4…)',
    bars.length >= 3 && bars.every((b) => b.beats === (b.bar % 2 === 0 ? 4 : 3)),
    (v) => v === true);

  // A REAL reload (about:blank first — a fragment-only goto never reboots):
  // the metre must come back from storage, at the engine and on the control.
  const url = page.url();
  await page.goto('about:blank');
  await page.goto(url);
  await page.waitForTimeout(2000);
  await page.click('#consent-slot button:has-text("Save on this device")').catch(() => {});
  await page.click('#tab-advanced').catch(() => {});
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => ({
    stored: window.__ambi4Engine ? window.__ambi4Engine.getParams().timeSignature : null,
    select: document.getElementById('timeSignature')?.value ?? null,
    numerator: document.getElementById('custom-metre-n')?.value ?? null,
    numeratorShown: document.getElementById('custom-metre')?.hidden === false,
  }));
  check('the metre survives a reload at the ENGINE', after.stored, '4/4+3/4');
  check('…the select shows Custom', after.select, 'custom');
  check('…the custom pair is visible', after.numeratorShown, true);
  check('…and the numerator shows the cycle', after.numerator, '4+3');

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'additive-metre-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n'),
    );
  }
  return { passed: results.length };
}
