/**
 * Probability groups paint into a SELECTED group, gaps and all.
 *
 *   npm run build && .vibe/measure.sh local drive tests/prob-group-drive.mjs
 *
 * His ruling (2026-07-30): "the probability group is not always contiguous …
 * I want to be able to select a bunch of items, and have them in one
 * probability group … A gap is NOT a probability group boundary." The old
 * join-my-left-neighbour rule made a gapped group unreachable — two separated
 * clusters were two different groups by construction.
 *
 * Asserts the ENGINE's stored steps (getParams().tracks.bass.sequencer.steps),
 * not the dots: a dot painted a colour the engine never stored is the failure
 * class this repo tests against everywhere.
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
  await page.waitForTimeout(300);

  const opened = await page.evaluate(() => {
    for (const row of document.querySelectorAll('.track-row')) {
      if (/bass/i.test(row.textContent || '')) {
        row.querySelector('.voice-edit-toggle')?.click();
        return true;
      }
    }
    return false;
  });
  check('the bass editor opened', opened, true);
  await page.waitForTimeout(600);

  const clickDot = (i) =>
    page.evaluate((idx) => {
      const editor = document.getElementById('voice-editor-bass');
      const dots = editor ? [...editor.querySelectorAll('.seq-dot')] : [];
      if (!dots[idx]) return false;
      dots[idx].scrollIntoView({ block: 'center' });
      dots[idx].click();
      return true;
    }, i).then((ok) => page.waitForTimeout(200).then(() => ok));

  const engineGroups = () =>
    page.evaluate(() => {
      const steps = window.__ambi4Engine.getParams().tracks.bass.sequencer.steps || [];
      return steps.slice(0, 8).map((s) => (Number.isFinite(s.group) ? s.group : null));
    });

  const domState = () =>
    page.evaluate(() => {
      const editor = document.getElementById('voice-editor-bass');
      const dots = [...editor.querySelectorAll('.seq-dot')].slice(0, 8);
      return {
        active: dots.map((d) => d.classList.contains('seq-dot-active')),
        labels: dots.map((d) => d.getAttribute('aria-label') || ''),
      };
    });

  // Start a group on step 1, then paint step 5 in ACROSS THE GAP — the exact
  // gesture the old rule could not express (its left neighbour is ungrouped,
  // so it would have started a second group in a second colour).
  check('dot 1 pressed', await clickDot(0), true);
  let g = await engineGroups();
  const gid = g[0];
  check('step 1 started a group in the ENGINE', Number.isFinite(gid), (v) => v === true);

  check('dot 5 pressed', await clickDot(4), true);
  g = await engineGroups();
  check('step 5 joined the SAME group across the gap', g[4], gid);
  check('the gap stayed ungrouped', [g[1], g[2], g[3]], [null, null, null]);

  check('dot 3 pressed', await clickDot(2), true);
  g = await engineGroups();
  check('step 3 joined it too', g[2], gid);

  const dom = await domState();
  check('the selected group rings on the grid', dom.active[0] && dom.active[2] && dom.active[4], (v) => v === true);
  check('a member dot says it is selected', /selected/.test(dom.labels[0]), (v) => v === true);

  // A selected member pressed again leaves the group.
  check('dot 3 pressed again', await clickDot(2), true);
  g = await engineGroups();
  check('step 3 left the group', g[2], null);

  // Esc drops the selection; the next press starts a FRESH group.
  await page.evaluate(() => {
    const editor = document.getElementById('voice-editor-bass');
    const cell = editor.querySelectorAll('.seq-cell')[0];
    cell.tabIndex = 0;
    cell.focus();
  });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const afterEsc = await domState();
  check('Esc drops the selection', afterEsc.active.some(Boolean), (v) => v === false);

  check('dot 7 pressed', await clickDot(6), true);
  g = await engineGroups();
  check('a fresh press starts a NEW group', Number.isFinite(g[6]) && g[6] !== gid, (v) => v === true);

  // Keyboard path: G on a focused cell paints into the selected group.
  await page.evaluate(() => {
    const editor = document.getElementById('voice-editor-bass');
    const cell = editor.querySelectorAll('.seq-cell')[1];
    cell.tabIndex = 0;
    cell.focus();
  });
  await page.keyboard.press('g');
  await page.waitForTimeout(200);
  g = await engineGroups();
  check('G paints the focused step into the selected group', g[1], g[6]);

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'prob-group-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n'),
    );
  }
  return { passed: results.length };
}
