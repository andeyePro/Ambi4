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
 *
 * v0.0.145 rewrote the gesture to his 119: "once one dot is selected, a second
 * empty dot should appear next to it to allow a second probability group, then
 * third, etc." So a step carries one dot PER GROUP the lane uses plus an empty
 * one for the next, and the dots are addressed by (step, group) rather than by
 * a flat index — which is also why every check below had to be re-written.
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

  /** Press the dot for `group` under step `i` (0-based), or the empty one. */
  const pressDot = (i, group) =>
    page.evaluate(([idx, id]) => {
      const editor = document.getElementById('voice-editor-bass');
      const cells = editor ? [...editor.querySelectorAll('.seq-dot-cell')] : [];
      const host = cells[idx];
      if (!host) return false;
      const dots = [...host.children];
      const dot = id === null ? dots[dots.length - 1] : dots.find((d) => Number(d.dataset.group) === id);
      if (!dot) return false;
      dot.scrollIntoView({ block: 'center' });
      dot.click();
      return true;
    }, [i, group]).then((ok) => page.waitForTimeout(220).then(() => ok));

  const engineGroups = () =>
    page.evaluate(() => {
      const steps = window.__ambi4Engine.getParams().tracks.bass.sequencer.steps || [];
      return steps.slice(0, 8).map((s) => (Number.isFinite(s.group) ? s.group : null));
    });

  /** How many dots each step offers, and which groups they stand for. */
  const dotShape = () =>
    page.evaluate(() => {
      const editor = document.getElementById('voice-editor-bass');
      const cells = [...editor.querySelectorAll('.seq-dot-cell')].slice(0, 8);
      return {
        counts: cells.map((c) => c.children.length),
        groups: cells.map((c) => [...c.children].map((d) => Number(d.dataset.group))),
        filled: cells.map((c) => [...c.children].map((d) => d.classList.contains('seq-dot-on'))),
        labels: [...cells[0].children].map((d) => d.getAttribute('aria-label') || ''),
      };
    });

  // A lane with no groups offers exactly ONE dot per step: the empty one that
  // starts the first group. That is the whole of his 119 request — the way to
  // make another group has to be visible, not "press Escape first".
  const fresh = await dotShape();
  check('an ungrouped lane offers one empty dot per step', [...new Set(fresh.counts)], [1]);
  check('…and it says what it is for', /Put step 1 in probability group 1/.test(fresh.labels[0]), (v) => v === true);

  check('step 1 dot pressed', await pressDot(0, null), true);
  let g = await engineGroups();
  const gid = g[0];
  check('step 1 started a group in the ENGINE', gid, 0);
  const twoDots = await dotShape();
  check('a second, empty dot now appears on every step', [...new Set(twoDots.counts)], [2]);
  check('…the first stands for the group that exists', twoDots.groups[0][0], 0);
  check('…and it is filled on the step that is in it', twoDots.filled[0], [true, false]);

  // His ruling, unchanged: a gap is NOT a group boundary.
  check('step 5 group-1 dot pressed', await pressDot(4, 0), true);
  g = await engineGroups();
  check('step 5 joined the SAME group across the gap', g[4], gid);
  check('the gap stayed ungrouped', [g[1], g[2], g[3]], [null, null, null]);

  check('step 3 group-1 dot pressed', await pressDot(2, 0), true);
  g = await engineGroups();
  check('step 3 joined it too', g[2], gid);

  // Pressing the dot a step already holds takes it out — no selection state
  // needed, which is what made the old model hard to discover.
  check('step 3 pressed again', await pressDot(2, 0), true);
  g = await engineGroups();
  check('step 3 left the group', g[2], null);

  // The empty dot is how a SECOND group starts, with no Escape and no mode.
  check('step 7 empty dot pressed', await pressDot(6, null), true);
  g = await engineGroups();
  check('a second group starts on the empty dot', g[6], 1);
  const threeDots = await dotShape();
  check('…and a third empty dot appears', [...new Set(threeDots.counts)], [3]);
  check('…groups 1 and 2 keep their own dots, in order', threeDots.groups[0], [0, 1, 2]);

  // Keyboard: G paints into the selected group, which is the one just used.
  await page.evaluate(() => {
    const editor = document.getElementById('voice-editor-bass');
    const cell = editor.querySelectorAll('.seq-cell')[1];
    cell.tabIndex = 0;
    cell.focus();
  });
  await page.keyboard.press('g');
  await page.waitForTimeout(220);
  g = await engineGroups();
  check('G paints the focused step into the selected group', g[1], 1);

  // The row cannot grow past the colours it can tell apart: six groups, then
  // no empty seventh dot, because a group with no colour cannot be read off the
  // grid. Driven through the DOTS, the way a person would — pressing the empty
  // dot on a fresh step each time hands out the next group id.
  for (let step = 2; step <= 7; step++) await pressDot(step, null);
  const capShape = await dotShape();
  const groupsNow = (await engineGroups()).filter((v) => Number.isFinite(v));
  check('six groups exist at the ENGINE', new Set(groupsNow).size, 6);
  check('six groups is the cap — one dot per colour, no empty seventh', capShape.counts[0], 6);
  check('…and the dots stand for groups 1 to 6 in order', capShape.groups[0], [0, 1, 2, 3, 4, 5]);

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'prob-group-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n'),
    );
  }
  return { passed: results.length };
}
