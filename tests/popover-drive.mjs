/**
 * Popovers stay on screen: they grow LEFT from their right-edge anchors.
 *
 *   npm run build && .vibe/measure.sh local drive tests/popover-drive.mjs
 *
 * His item 95 (2026-07-30): "the popovers currently (as of 80) pop to right,
 * taking them off-screen, they need to pop to left." The anchored icons sit
 * at the page's right edge and the popover CSS grew rightward from `left: 0`.
 *
 * Measured by box geometry at two viewports, because on-screen and 1px
 * off-screen are the same screenshot.
 */

export default async function drive(page) {
  const results = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
  };

  await page.click('#consent-slot button:has-text("Save on this device")').catch(() => {});
  await page.waitForTimeout(200);

  const POPOVERS = [
    ['timers-toggle', 'timers-popover'],
    ['play-along-open', 'play-along'],
  ];
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(300);
    for (const [toggleId, popId] of POPOVERS) {
      await page.evaluate((id) => document.getElementById(id)?.scrollIntoView({ block: 'center' }), toggleId);
      await page.click(`#${toggleId}`);
      await page.waitForTimeout(250);
      const box = await page.evaluate((id) => {
        const el = document.getElementById(id);
        if (!el || el.hidden) return null;
        const r = el.getBoundingClientRect();
        return { left: Math.round(r.left), right: Math.round(r.right), vw: window.innerWidth };
      }, popId);
      check(`${popId} opens at ${width}px`, !!box, (v) => v === true);
      if (box) {
        check(`${popId} right edge on screen at ${width}px`, box.right <= box.vw, (v) => v === true);
        check(`${popId} left edge on screen at ${width}px`, box.left >= 0, (v) => v === true);
      }
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
    }
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'popover-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n'),
    );
  }
  return { passed: results.length, notes: [] };
}
