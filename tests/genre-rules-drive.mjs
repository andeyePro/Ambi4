/**
 * The genre's rules are on screen as CONTROLS, editable, and edits reach the
 * ENGINE (v0.0.161 — his 133 "the genre rules are still horribly text based"
 * and his 130 "the user should be able to edit create and zero all rules").
 *
 *   npm run build && .vibe/measure.sh local drive tests/genre-rules-drive.mjs
 *
 * Chords are chips (a native select each), patterns are tap-grids, every rule
 * carries a ×, every section an add — and the panel now shows the
 * SUBSTITUTION rules too, which is where his 130's dead-rule find lived. The
 * compiler is pure and seed-deterministic, so the drive also proves the
 * same-dice promise: bpm and time signature survive a rules edit untouched.
 * Every assertion that matters lands at the engine seam, not the readout.
 */

export default async function drive(page) {
  const results = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
  };

  await page.click('#consent-slot button:has-text("Save on this device")').catch(() => {});
  await page.waitForTimeout(200);

  // Pin Synthwave through the UI, verified at the engine (the spread drive's
  // hard-learned lesson: an unverified pin is a run on the random draw).
  await page.evaluate(() => {
    const sel = document.getElementById('genre-select');
    const opt = [...sel.options].find((o) => o.value === 'g:synthwave');
    if (opt) {
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  const pinned = await page
    .waitForFunction(() => window.__ambi4Engine?.getParams?.()?.genre === 'synthwave', { timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  check('Synthwave pinned at the engine', pinned, (v) => v === true);

  const engineView = () =>
    page.evaluate(() => {
      const p = window.__ambi4Engine.getParams();
      const seqs = p.tracks?.percussion?.sequencers || [];
      const lanes = seqs[0]?.steps;
      const laneArrays = Array.isArray(lanes) ? { only: lanes } : lanes || {};
      const counts = {};
      for (const [key, arr] of Object.entries(laneArrays)) {
        counts[key] = (arr || []).filter((s) => s && s.on === true).length;
      }
      return {
        bpm: p.bpm,
        timeSignature: p.timeSignature,
        seed: p.harmony?.seed ?? null,
        kitSequencers: seqs.length,
        kitOnCounts: counts,
      };
    });

  const before = await engineView();

  const panelState = () =>
    page.evaluate(() => {
      const chipRows = [...document.querySelectorAll('#genre-rules-progressions-ui .rules-row')]
        .map((row) => [...row.querySelectorAll('select.rule-chip:not(.rule-length)')].map((s) => s.value));
      const subRows = [...document.querySelectorAll('#genre-rules-subs-ui .rules-row')]
        .map((row) => {
          const chips = [...row.querySelectorAll('select.rule-chip')].map((s) => s.value);
          return chips; // [from, to, prob%]
        });
      const kitBlocks = [...document.querySelectorAll('#genre-rules-anchors-ui .rules-block')]
        .map((block) => {
          const lanes = {};
          for (const row of block.querySelectorAll('.rules-row')) {
            const label = row.querySelector('.rules-lane-label')?.textContent;
            if (!label) continue;
            const cells = [...row.querySelectorAll('.rule-step')];
            if (cells.length) {
              lanes[label] = cells.map((c) => (c.getAttribute('aria-pressed') === 'true' ? 'x' : '-')).join('');
            }
          }
          return lanes;
        });
      return {
        toggleHidden: document.getElementById('genre-rules-toggle')?.hidden,
        toggleText: document.getElementById('genre-rules-toggle')?.textContent,
        errorHidden: document.getElementById('genre-rules-error')?.hidden,
        optionLabel: [...document.getElementById('genre-select').options]
          .find((o) => o.value === 'g:synthwave')?.textContent,
        chipRows,
        subRows,
        kitBlocks,
      };
    });

  let state = await panelState();
  check('the Rules button shows once a genre is active', state.toggleHidden, false);

  const ensureRulesOpen = async () => {
    const hidden = await page.evaluate(() => document.getElementById('genre-rules').hidden);
    if (hidden) {
      await page.click('#genre-rules-toggle');
      await page.waitForTimeout(250);
    }
  };

  await ensureRulesOpen();
  state = await panelState();
  check('the genre’s own chord grammar renders as chips',
    state.chipRows[0], ['i', 'VI', 'III', 'VII']);
  check('…its substitution rules render as rules (his 130’s hidden layer, on screen)',
    state.subRows[0], ['III', 'v', '15']);
  check('…and its kit pattern renders as a tap-grid, lane by lane',
    state.kitBlocks[0]?.low, 'x-------x-----x-');

  // EDIT the kit down to one kick per bar with the controls a person has:
  // tap the low lane's two later hits off, and × the mid and high lanes away
  // (removing a lane IS his "zero" for that rule). Apply. The kit the engine
  // holds must be re-drawn from THAT pattern, while bpm and time signature
  // keep their draw.
  const tapLow = async (step) => {
    await page.evaluate((n) => {
      const block = document.querySelector('#genre-rules-anchors-ui .rules-block');
      for (const row of block.querySelectorAll('.rules-row')) {
        if (row.querySelector('.rules-lane-label')?.textContent === 'low') {
          row.querySelectorAll('.rule-step')[n]?.click();
        }
      }
    }, step);
    await page.waitForTimeout(120);
  };
  await tapLow(8);
  await tapLow(14);
  for (const lane of ['mid', 'high']) {
    await page.evaluate((which) => {
      const block = document.querySelector('#genre-rules-anchors-ui .rules-block');
      for (const row of block.querySelectorAll('.rules-row')) {
        if (row.querySelector('.rules-lane-label')?.textContent === which) {
          [...row.querySelectorAll('button')]
            .find((b) => (b.getAttribute('aria-label') || '').startsWith('Remove the'))?.click();
        }
      }
    }, lane);
    await page.waitForTimeout(120);
  }
  await page.click('#genre-rules-apply');
  await page.waitForTimeout(600);

  const after = await engineView();
  state = await panelState();
  check('the edit compiled without error', state.errorHidden, true);
  check('ONE kit sequencer — the single pattern is the whole groove pool', after.kitSequencers, 1);
  const lowKey = Object.keys(after.kitOnCounts).find((k) => /low|only/.test(k)) || Object.keys(after.kitOnCounts)[0];
  check('the low lane carries exactly the one hit left standing', after.kitOnCounts[lowKey], 1);
  check('bpm survived the edit (same dice)', after.bpm, before.bpm);
  check('time signature survived the edit (same dice)', after.timeSignature, before.timeSignature);
  check('the button says the rules are edited', /edited/.test(state.toggleText || ''), (v) => v === true);
  check('the picker says so too', /edited rules/.test(state.optionLabel || ''), (v) => v === true);

  // ZERO the substitutions (his Ambient dead-rule case: rules you can now
  // see, and delete). Apply, reopen, and the EMPTY list must round-trip —
  // an emptied section stays empty rather than falling back to the genre's.
  await ensureRulesOpen();
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => {
      [...document.querySelectorAll('#genre-rules-subs-ui .rules-row button')]
        .find((b) => (b.getAttribute('aria-label') || '').startsWith('Remove substitution'))?.click();
    });
    await page.waitForTimeout(100);
  }
  await page.click('#genre-rules-apply');
  await page.waitForTimeout(600);
  await page.click('#genre-rules-toggle'); // close
  await page.waitForTimeout(200);
  await ensureRulesOpen();                 // reopen rebuilds from storage
  state = await panelState();
  check('zeroed substitutions STAY zero after a close and reopen', state.subRows.length, 0);

  // CREATE: a chord edit through the chips — every row but the first goes,
  // and the first becomes i i i i. A one-chord grammar can only ever seed
  // degree 1 (token "i" = scale degree index 0) at the ENGINE.
  const rowsNow = state.chipRows.length;
  for (let r = rowsNow - 1; r >= 1; r--) {
    await page.evaluate((idx) => {
      const rows = [...document.querySelectorAll('#genre-rules-progressions-ui .rules-row')];
      [...rows[idx].querySelectorAll('button')]
        .find((b) => (b.getAttribute('aria-label') || '').startsWith('Remove progression'))?.click();
    }, r);
    await page.waitForTimeout(100);
  }
  for (let c = 0; c < 4; c++) {
    await page.evaluate((ci) => {
      const row = document.querySelector('#genre-rules-progressions-ui .rules-row');
      const chips = [...row.querySelectorAll('select.rule-chip:not(.rule-length)')];
      const chip = chips[ci];
      if (chip) {
        chip.value = 'i';
        chip.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, c);
    await page.waitForTimeout(100);
  }
  await page.click('#genre-rules-apply');
  await page.waitForTimeout(600);
  const seeded = await engineView();
  const degreesOnly = (seed) =>
    Array.isArray(seed) ? seed.map((s) => (typeof s === 'object' && s !== null ? s.degree : s)) : null;
  const seedDegrees = degreesOnly(seeded.seed);
  check(
    'a one-chord grammar seeds a one-degree loop at the ENGINE',
    !!seedDegrees && seedDegrees.length > 0 && seedDegrees.every((d) => d === 0),
    (v) => v === true
  );

  // Back to the genre's rules: the kit refills, the labels drop their marker.
  await ensureRulesOpen();
  await page.click('#genre-rules-reset');
  await page.waitForTimeout(600);
  const resetView = await engineView();
  state = await panelState();
  check('reset restores the genre’s own kit density', resetView.kitOnCounts[lowKey] > 1, (v) => v === true);
  check('…and the edited marker is gone', /edited/.test(state.toggleText || ''), (v) => v === false);
  check('…and the substitutions are the genre’s own three again', state.subRows.length, 3);

  // v0.0.149 (his 124): the rules decide what is PLAYED; the voice editor
  // decides how it SOUNDS. Asserted at the ENGINE either side of an Apply.
  await ensureRulesOpen();
  const kept = await page.evaluate(async () => {
    const engine = window.__ambi4Engine;
    const before2 = engine.getParams();
    const track = 'pad';
    const voices = [...document.querySelectorAll(`#track-voice-${track} option`)].map((o) => o.value);
    // Not the __live sentinel: the page ignores it by design, so picking it
    // would make this assert that nothing changed and then congratulate itself.
    const other = voices.find((v) => v && !v.startsWith('__') && v !== before2.tracks[track].voice) || null;
    if (!other) return { skipped: 'only one pad voice' };
    const select = document.getElementById(`track-voice-${track}`);
    select.value = other;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    engine.setParams({ patches: { [track]: { [other]: { filter: { cutoff: 812 } } } } });
    await new Promise((r) => setTimeout(r, 200));
    const mine = {
      was: before2.tracks[track].voice,
      asked: other,
      voice: engine.getParams().tracks[track].voice,
      cutoff: engine.getParams().patches?.[track]?.[other]?.filter?.cutoff ?? null,
    };
    document.getElementById('genre-rules-apply')?.click();
    await new Promise((r) => setTimeout(r, 900));
    const after2 = engine.getParams();
    return {
      mine,
      voiceAfter: after2.tracks[track].voice,
      cutoffAfter: after2.patches?.[track]?.[other]?.filter?.cutoff ?? null,
      note: document.getElementById('dial-confirm')?.textContent || '',
    };
  });
  if (kept.skipped) {
    check(`the pad voice list is long enough to test with (${kept.skipped})`, false, (v) => v === true);
  } else {
    check(`the voice really changed first (${kept.mine.was} → ${kept.mine.asked})`,
      kept.mine.voice, kept.mine.asked);
    check('Apply keeps the voice you chose', kept.voiceAfter, kept.mine.asked);
    check('…and the dial you set on it', kept.cutoffAfter, 812);
    check('…and says so, so the promise is on screen too',
      /instruments and their dials are untouched/.test(kept.note), (v) => v === true);
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'genre-rules-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n'),
    );
  }
  return { passed: results.length };
}
