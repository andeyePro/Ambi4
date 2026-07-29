/**
 * The full-screen bar: one row, one button style.
 *
 *   npm run build && .vibe/measure.sh local drive tests/fullscreenbar-drive.mjs
 *
 * His note on approving full screen: "one consistent button style on one line.
 * It currently has two different button styles on two rows." The ☰ was a bare
 * transparent glyph pinned above a pair of secondary buttons.
 *
 * Measured rather than eyeballed, because "on one line" and "1px apart" look
 * identical in a screenshot: the three buttons' boxes must share a row, and
 * they must share a class. The collapse behaviour is checked too — the ☰ is
 * the control that brings the others back, so it must NOT travel with them.
 */

const bar = (page) =>
  page.evaluate(() => {
    const ids = ['fullscreen-add', 'fullscreen-exit', 'fullscreen-menu'];
    const seen = ids.map((id) => {
      const el = document.getElementById(id);
      if (!el || el.hidden) return null;
      const r = el.getBoundingClientRect();
      return { id, top: Math.round(r.top), bottom: Math.round(r.bottom), cls: el.className };
    }).filter(Boolean);
    return {
      seen,
      collapsed: document.getElementById('fullscreen-bar')?.dataset.collapsed !== undefined,
      menuVisible: (() => {
        const el = document.getElementById('fullscreen-menu');
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).pointerEvents !== 'none';
      })(),
    };
  });

export default async function drive(page) {
  const results = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
  };

  await page.click('#consent-slot button:has-text("Save on this device")').catch(() => {});
  await page.waitForTimeout(300);
  await page.click('#front-scope-fullscreen');
  await page.waitForTimeout(900);

  const open = await bar(page);
  check('at least the Exit and menu buttons are showing', open.seen.length >= 2, (v) => v === true);
  // One LINE, measured: every visible button's box overlaps the first one's
  // vertical span. A second row would show up here and nowhere else.
  const first = open.seen[0];
  check('every button sits on the same row',
    open.seen.every((b) => b.top < first.bottom && b.bottom > first.top), (v) => v === true);
  // One STYLE: they are the same kind of button, not a glyph beside two buttons.
  check('and every button is the same kind of button',
    open.seen.every((b) => /\bsecondary-button\b/.test(b.cls)), (v) => v === true);
  results.push({ name: 'buttons', ok: true, got: open.seen, want: '(informational)' });

  // The collapse: the actions go, the menu stays reachable to bring them back.
  await page.evaluate(() => {
    const b = document.getElementById('fullscreen-bar');
    if (b) b.dataset.collapsed = '';
  });
  await page.waitForTimeout(700);
  const collapsed = await bar(page);
  check('the menu survives the collapse that hides the rest', collapsed.menuVisible, (v) => v === true);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'fullscreenbar-drive: ' + failed.length + ' failed\n' + JSON.stringify(open) + '\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n'),
    );
  }
  return { passed: results.length, notes: results.filter((r) => r.want === '(informational)').map((r) => `${r.name}: ${JSON.stringify(r.got)}`) };
}
