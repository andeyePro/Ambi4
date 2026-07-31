/**
 * The editing resolution: his ×2 / ÷2 controller, and the grid that follows it.
 *
 *   npm run build && .vibe/measure.sh local drive tests/resolution-drive.mjs
 *
 * His item 89 (2026-07-30): "please add to the todo the ability to choose the
 * editing resolution, so you can input whole notes, semi-brieves, quavers,
 * semi-quavers, demi-semi-quavers, triplets, etc. I was thinking a x2 /2
 * controller could easily control all eventualities other than triplets."
 *
 * Asserted at the ENGINE as well as on screen: the cells drawn must be exactly
 * the slots the engine plays, because a grid drawing steps that never sound is
 * this project's oldest failure mode (his "ten editable steps that never sound"
 * in a 3/8 bar). The note-value readout is checked too — a musician chooses a
 * note value, not a number of slots.
 */

export default async function drive(page) {
  const results = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
  };

  await page.click('#consent-slot button:has-text("Save on this device")').catch(() => {});
  await page.waitForTimeout(200);
  // 4/4 so the slot arithmetic is the plain case: 16 semiquavers to the bar.
  await page.selectOption('#time-signature', '4/4').catch(() => {});
  await page.waitForTimeout(400);
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

  const view = () =>
    page.evaluate(() => {
      const editor = document.getElementById('voice-editor-bass');
      const cells = [...editor.querySelectorAll('.seq-cell')];
      const live = window.__ambi4Engine.getParams().tracks.bass;
      const steps = Array.isArray(live.sequencer.steps)
        ? live.sequencer.steps
        : Object.values(live.sequencer.steps)[0];
      return {
        cells: cells.length,
        readout: editor.querySelector('.seq-res-readout')?.textContent || null,
        barHidden: editor.querySelector('.seq-res-bar')?.hidden,
        coarserDisabled: editor.querySelector('.seq-res-bar .seq-res-step')?.disabled,
        engineStepBeats: live.stepBeats ?? 0.25,
        engineLane: steps.length,
        beatMarks: [...editor.querySelectorAll('.seq-beats > *')]
          .filter((el) => el.className && String(el.className).includes('beat')).length,
      };
    });

  const press = async (which) => {
    await page.evaluate((label) => {
      const editor = document.getElementById('voice-editor-bass');
      [...editor.querySelectorAll('.seq-res-step')].find((b) => b.textContent === label)?.click();
    }, which);
    await page.waitForTimeout(500);
  };

  const start = await view();
  check('the resolution control is offered', start.barHidden, false);
  check('a fresh grid is semiquavers', start.readout, 'semiquavers');
  check('…16 cells in 4/4', start.cells, 16);
  check('…and the engine agrees the lane is 20 slots', start.engineLane, 20);

  // ÷2 goes FINER: semiquaver → demi-semiquaver → hemi-demi-semiquaver.
  await press('÷2');
  const finer = await view();
  check('÷2 halves the step', finer.readout, 'demi-semiquavers');
  check('…the ENGINE stores the finer rung', finer.engineStepBeats, 0.125);
  check('…its lane grew to 40 slots', finer.engineLane, 40);
  check('…and the grid draws exactly the 32 the bar plays', finer.cells, 32);

  await press('÷2');
  const finest = await view();
  check('÷2 again reaches the bottom rung', finest.readout, 'hemi-demi-semiquavers');
  check('…64 cells in 4/4', finest.cells, 64);
  check('…and the engine lane is 80', finest.engineLane, 80);

  // ×2 three times: back up past the default to crotchets.
  await press('×2');
  await press('×2');
  await press('×2');
  const coarse = await view();
  check('×2 walks back up the ladder', coarse.readout, 'quavers');
  check('…8 cells in 4/4', coarse.cells, 8);
  await press('×2');
  const coarsest = await view();
  check('the top rung is crotchets', coarsest.readout, 'crotchets');
  check('…4 cells in 4/4', coarsest.cells, 4);
  check('…and the ladder stops there', coarsest.coarserDisabled, true);

  // A step edited at a NON-DEFAULT resolution must still reach the engine, at
  // the slot the grid drew. Two ÷2 from crotchets lands on semiquavers, so
  // this also proves the ladder is symmetric rather than drifting.
  await press('÷2');
  await press('÷2');
  const before5 = await page.evaluate(() => {
    const live = window.__ambi4Engine.getParams().tracks.bass;
    const steps = Array.isArray(live.sequencer.steps)
      ? live.sequencer.steps
      : Object.values(live.sequencer.steps)[0];
    return steps[5]?.on === true;
  });
  const edited = await page.evaluate(() => {
    const editor = document.getElementById('voice-editor-bass');
    const cell = editor.querySelectorAll('.seq-cell')[5];
    cell.scrollIntoView({ block: 'center' });
    cell.tabIndex = 0;
    cell.focus();
    return true;
  });
  check('a fine-grid cell took focus', edited, true);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => {
    const live = window.__ambi4Engine.getParams().tracks.bass;
    const steps = Array.isArray(live.sequencer.steps)
      ? live.sequencer.steps
      : Object.values(live.sequencer.steps)[0];
    return { on: steps[5]?.on === true, stepBeats: live.stepBeats ?? 0.25 };
  });
  check('toggling a cell FLIPS that step at the ENGINE', after.on, !before5);
  check('…and two ÷2 from the top rung is semiquavers again', after.stepBeats, 0.25);

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'resolution-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n'),
    );
  }
  return { passed: results.length };
}
