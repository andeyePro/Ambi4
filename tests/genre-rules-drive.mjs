/**
 * The genre's rules are on screen, editable, and edits reach the ENGINE.
 *
 *   npm run build && .vibe/measure.sh local drive tests/genre-rules-drive.mjs
 *
 * His ruling on where the everything-editable build starts: the GENRE layer —
 * "show the grammar of the current genre as editable text/controls, so
 * changing 'x---x---x---' changes every bar drawn from it" (his words were the
 * option; his answer was "a"). The compiler is pure and seed-deterministic,
 * so the drive also proves the same-dice promise: bpm and time signature
 * survive a rules edit untouched, because the fixed draw order spends those
 * rng calls before the grammar does.
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

  const rulesState = () =>
    page.evaluate(() => ({
      toggleHidden: document.getElementById('genre-rules-toggle')?.hidden,
      toggleText: document.getElementById('genre-rules-toggle')?.textContent,
      progressions: document.getElementById('genre-rules-progressions')?.value,
      anchors: document.getElementById('genre-rules-anchors')?.value,
      errorHidden: document.getElementById('genre-rules-error')?.hidden,
      optionLabel: [...document.getElementById('genre-select').options]
        .find((o) => o.value === 'g:synthwave')?.textContent,
    }));

  let state = await rulesState();
  check('the Rules button shows once a genre is active', state.toggleHidden, false);

  const ensureRulesOpen = async () => {
    const hidden = await page.evaluate(() => document.getElementById('genre-rules').hidden);
    if (hidden) {
      await page.click('#genre-rules-toggle');
      await page.waitForTimeout(250);
    }
  };

  await ensureRulesOpen();
  state = await rulesState();
  check('the genre’s own chord grammar is on screen', /i VI III VII/.test(state.progressions || ''), (v) => v === true);
  check('…and its kit patterns, lane by lane', /low: x-------x-----x-/.test(state.anchors || ''), (v) => v === true);

  // Edit: one kick per bar. Apply. The kit the engine holds must be re-drawn
  // from THAT pattern, while bpm and time signature keep their draw.
  await page.evaluate(() => {
    document.getElementById('genre-rules-anchors').value =
      'low: x---------------\nmid: ----------------\nhigh: ----------------';
  });
  await page.click('#genre-rules-apply');
  await page.waitForTimeout(600);

  const after = await engineView();
  state = await rulesState();
  check('the edit compiled without error', state.errorHidden, true);
  check('ONE kit sequencer — the single anchor is the whole groove pool', after.kitSequencers, 1);
  const lowKey = Object.keys(after.kitOnCounts).find((k) => /low|only/.test(k)) || Object.keys(after.kitOnCounts)[0];
  check('the low lane carries exactly the one hit written', after.kitOnCounts[lowKey], 1);
  check('bpm survived the edit (same dice)', after.bpm, before.bpm);
  check('time signature survived the edit (same dice)', after.timeSignature, before.timeSignature);
  check('the button says the rules are edited', /edited/.test(state.toggleText || ''), (v) => v === true);
  check('the picker says so too', /edited rules/.test(state.optionLabel || ''), (v) => v === true);

  // Garbage is refused in place, and the engine keeps what it had.
  await ensureRulesOpen();
  await page.evaluate(() => {
    document.getElementById('genre-rules-anchors').value = 'low: xq--';
  });
  await page.click('#genre-rules-apply');
  await page.waitForTimeout(300);
  state = await rulesState();
  const unchanged = await engineView();
  check('garbage anchors are refused with a message', state.errorHidden, false);
  check('…and the engine kept the previous kit', unchanged.kitOnCounts[lowKey], 1);

  // The chord grammar edit reaches the harmony seed: a one-chord grammar can
  // only ever seed degree 1 (token "i" = scale degree index 0).
  await page.evaluate(() => {
    document.getElementById('genre-rules-anchors').value =
      'low: x---------------\nmid: ----------------\nhigh: ----------------';
    document.getElementById('genre-rules-progressions').value = 'i i i i';
  });
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
  state = await rulesState();
  check('reset restores the genre’s own kit density', resetView.kitOnCounts[lowKey] > 1, (v) => v === true);
  check('…and the edited marker is gone', /edited/.test(state.toggleText || ''), (v) => v === false);

  // v0.0.149 (his 124): "does it really override the much easier to use GUI of
  // the Preset editor?" It did — Apply rebuilt the whole setup from the genre and
  // took every voice choice and every voice-editor dial with it, under a button
  // that promises only what you changed changes. The rules decide what is PLAYED;
  // the voice editor decides how it SOUNDS. Asserted at the ENGINE either side of
  // an Apply.
  const kept = await page.evaluate(async () => {
    const engine = window.__ambi4Engine;
    // A sound the genre did not choose: a different voice, and a filter nowhere
    // near whatever it publishes.
    const before = engine.getParams();
    const track = 'pad';
    const voices = [...document.querySelectorAll(`#track-voice-${track} option`)].map((o) => o.value);
    // Not the __live sentinel: the page ignores it by design, so picking it would
    // make this test assert that nothing changed and then congratulate itself.
    const other = voices.find((v) => v && !v.startsWith('__') && v !== before.tracks[track].voice) || null;
    if (!other) return { skipped: 'only one pad voice' };
    const select = document.getElementById(`track-voice-${track}`);
    select.value = other;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    engine.setParams({ patches: { [track]: { [other]: { filter: { cutoff: 812 } } } } });
    await new Promise((r) => setTimeout(r, 200));
    const mine = {
      was: before.tracks[track].voice,
      asked: other,
      voice: engine.getParams().tracks[track].voice,
      cutoff: engine.getParams().patches?.[track]?.[other]?.filter?.cutoff ?? null,
    };
    // Now re-apply the rules, unchanged: the notes may redraw, the sound may not.
    document.getElementById('genre-rules-apply')?.click();
    await new Promise((r) => setTimeout(r, 900));
    const after = engine.getParams();
    return {
      mine,
      voiceAfter: after.tracks[track].voice,
      cutoffAfter: after.patches?.[track]?.[other]?.filter?.cutoff ?? null,
      note: document.getElementById('dial-confirm')?.textContent || '',
    };
  });
  if (kept.skipped) {
    check(`the pad voice list is long enough to test with (${kept.skipped})`, false, (v) => v === true);
  } else {
    // The change has to have LANDED for the law below to mean anything: a select
    // whose event did nothing would make "the voice survived" vacuously true.
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
