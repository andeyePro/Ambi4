/**
 * Simple has a Tempo dial again, and it moves the ENGINE's bpm.
 *
 *   npm run build && .vibe/measure.sh local drive tests/simple-tempo-drive.mjs
 *
 * His item 90 (2026-07-30): "Simple still has three dials, there is no tempo
 * dial in simple mode. That's what I meant." Right — v0.0.71 separated Energy
 * from tempo, which left the Simple tab with NO tempo control at all.
 *
 * Asserts the engine's stored value, not the readout: bpm before and after a
 * drag on the Simple dial, the beat-landing rule (Simple lands on the next
 * beat, Advanced on the barline — v0.0.57's A/B), and that the two views
 * mirror one another.
 */

const engineState = (page) =>
  page.evaluate(() => {
    const p = window.__ambi4Engine.getParams();
    return { bpm: JSON.stringify(p.bpm), landing: p.tempoLanding };
  });

async function dragDial(page, slotId, dy) {
  const box = await page.evaluate((id) => {
    const slot = document.getElementById(id);
    if (!slot) return null;
    const k = slot.querySelector('.knob') || slot;
    k.scrollIntoView({ block: 'center' });
    const r = k.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }, slotId);
  if (!box) return false;
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(box.x, box.y - Math.round((dy / 12) * i));
  await page.mouse.up();
  await page.waitForTimeout(500);
  return true;
}

export default async function drive(page) {
  const results = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
  };

  await page.click('#consent-slot button:has-text("Save on this device")').catch(() => {});
  await page.waitForTimeout(300);

  const present = await page.evaluate(() => ({
    slot: !!document.querySelector('#panel-simple #speed-dial .knob'),
    count: document.querySelectorAll('#panel-simple .simple-dial:not([hidden]) .knob').length,
  }));
  check('the Simple tab has a Tempo dial', present.slot, (v) => v === true);
  check('Simple shows four dials', present.count, 4);

  const before = await engineState(page);
  check('a drag on Simple Tempo moved the drag', await dragDial(page, 'speed-dial', 60), (v) => v === true);
  const after = await engineState(page);
  check('the ENGINE bpm changed', after.bpm !== before.bpm, (v) => v === true);
  check('Simple lands on the BEAT', after.landing, 'beat');

  // The Advanced view mirrors, and its own drag lands on the barline.
  await page.click('#tab-advanced');
  await page.waitForTimeout(400);
  const mirrored = await page.evaluate(() => {
    const simple = document.querySelector('#speed-dial .knob');
    const adv = document.querySelector('#speed-dial-adv .knob');
    return simple && adv
      ? { s: simple.getAttribute('aria-valuetext'), a: adv.getAttribute('aria-valuetext') }
      : null;
  });
  check('both views read the same bpm', !!mirrored && mirrored.s === mirrored.a, (v) => v === true);
  check('a drag on Advanced Tempo…', await dragDial(page, 'speed-dial-adv', -40), (v) => v === true);
  const afterAdv = await engineState(page);
  check('…lands on the BARLINE', afterAdv.landing, 'bar');
  results.push({ name: 'bpm before/after/adv', ok: true, got: [before.bpm, after.bpm, afterAdv.bpm], want: '(informational)' });

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'simple-tempo-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n'),
    );
  }
  return { passed: results.length, notes: results.filter((r) => r.want === '(informational)').map((r) => `${r.name}: ${JSON.stringify(r.got)}`) };
}
