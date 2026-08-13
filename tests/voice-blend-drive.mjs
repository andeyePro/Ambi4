/**
 * The voice blend: weights reach the ENGINE, sections draw from them, and an
 * explicit pick ends the blend (v0.0.163 — his 128, option a).
 *
 *   npm run build && .vibe/measure.sh local drive tests/voice-blend-drive.mjs
 *
 * Asserts the engine's stored voiceWeights and the resolved (drawn) voice —
 * never just the select's label — and the round-trip through a real reload.
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

  // The Blend entry exists on a multi-voice track's select.
  const hasBlend = await page.evaluate(() =>
    [...document.getElementById('track-voice-pad').options].some((o) => o.value === '__blend'));
  check('the pad select offers Blend voices…', hasBlend, true);

  // Open it the way a person does: pick the entry.
  await page.evaluate(() => {
    const select = document.getElementById('track-voice-pad');
    select.value = '__blend';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(300);
  const dialogOpen = await page.evaluate(() => !!document.getElementById('voice-blend-editor'));
  check('the blend dialog opens', dialogOpen, true);

  // Warm 1 / Glass 1, Done.
  await page.evaluate(() => {
    const set = (id, v) => {
      const el = document.getElementById(id);
      el.value = String(v);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set('blend-weight-pad-warm', 1);
    set('blend-weight-pad-glass', 1);
  });
  await page.click('#voice-blend-editor button:has-text("Done")');
  await page.waitForTimeout(400);

  const stored = await page.evaluate(() => {
    const p = window.__ambi4Engine.getParams();
    return { weights: p.tracks.pad.voiceWeights ?? null, voice: p.tracks.pad.voice };
  });
  check('the ENGINE stores the weights', stored.weights, { warm: 1, glass: 1 });
  check('…and keeps the configured voice untouched', typeof stored.voice, 'string');

  // Play a bar: the resolved (drawn) voice must come from the pool, and the
  // select's live option must say blend.
  await page.evaluate(() => {
    window.__ambi4Engine.setParams({ tracks: { pad: { state: 'on' } } });
    document.getElementById('toggle-play').click();
  });
  await page.waitForTimeout(3000);
  const live = await page.evaluate(() => ({
    resolved: window.__ambi4Engine.getResolved().tracks.pad.voice,
    label: document.querySelector('#track-voice-pad .voice-live-option')?.textContent ?? null,
  }));
  await page.evaluate(() => document.getElementById('toggle-play').click());
  check('the drawn voice comes from the pool', ['warm', 'glass'].includes(live.resolved), (v) => v === true);
  check('the select names the drawn voice and the state', /· blend$/.test(live.label || ''), (v) => v === true);

  // A REAL reload: the blend survives to the engine.
  const url = page.url();
  await page.goto('about:blank');
  await page.goto(url);
  await page.waitForTimeout(2000);
  await page.click('#consent-slot button:has-text("Save on this device")').catch(() => {});
  await page.waitForTimeout(300);
  const reloaded = await page.evaluate(() =>
    window.__ambi4Engine.getParams().tracks.pad.voiceWeights ?? null);
  check('the blend survives a reload at the ENGINE', reloaded, { warm: 1, glass: 1 });

  // An explicit voice pick ends the blend, as the live option promises.
  await page.click('#tab-advanced').catch(() => {});
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const select = document.getElementById('track-voice-pad');
    const plain = [...select.options].find((o) => o.value && !o.value.startsWith('__'));
    select.value = plain.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(300);
  const cleared = await page.evaluate(() => ({
    weights: window.__ambi4Engine.getParams().tracks.pad.voiceWeights ?? null,
    liveOption: document.querySelector('#track-voice-pad .voice-live-option')?.textContent ?? null,
  }));
  check('an explicit pick clears the blend at the ENGINE', cleared.weights, null);
  check('…and the blend label goes with it', /blend/.test(cleared.liveOption || ''), (v) => v === false);

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'voice-blend-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n'),
    );
  }
  return { passed: results.length };
}
