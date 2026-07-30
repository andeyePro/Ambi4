/**
 * The Create entry: orange, Play-sized, and its three doors do real things.
 *
 *   npm run build && .vibe/measure.sh local drive tests/create-drive.mjs
 *
 * His item 96, in his structure: an orange button at the Play button's own
 * height where the piano icon sat; inside it create (blank slate + genre
 * voice seeding + guided start line), compose (typed chords today), and play
 * along. Asserted at the ENGINE where it matters: blank slate turns every
 * track's state off IN THE ENGINE, and seeding writes the genre's voices to
 * the engine while leaving every state off.
 */

export default async function drive(page) {
  const results = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
  };

  await page.click('#consent-slot button:has-text("Save on this device")').catch(() => {});
  await page.waitForTimeout(300);

  // v0.0.89 (his 103): icon-only, in the icon row, CREATE in the tooltip —
  // and the transport buttons stay on ONE line, which is what the wide
  // button broke.
  const shape = await page.evaluate(() => {
    const btn = document.getElementById('play-along-open');
    const inIconRow = !!btn?.closest('.transport-icons');
    const tops = [...document.querySelectorAll('.transport-buttons > button')]
      .filter((b) => b.offsetParent !== null)
      .map((b) => Math.round(b.getBoundingClientRect().top));
    return btn ? {
      inIconRow,
      title: btn.title,
      textOnly: btn.textContent.trim(),
      oneLine: tops.length > 1 && Math.max(...tops) - Math.min(...tops) <= 2,
    } : null;
  });
  check('the Create icon exists in the icon row', !!shape && shape.inIconRow, (v) => v === true);
  check('CREATE lives in the tooltip, not the row', shape?.title, 'Create');
  check('the button carries no visible text', shape?.textOnly, '');
  check('the transport buttons sit on one line', shape?.oneLine, (v) => v === true);

  // The panel: three doors.
  await page.click('#play-along-open');
  await page.waitForTimeout(250);
  const doors = await page.evaluate(() => ({
    open: !document.getElementById('play-along').hidden,
    titles: [...document.querySelectorAll('#play-along .panel-label')].map((el) => el.textContent.trim()),
    zeros: ['zero-voices', 'zero-chords', 'zero-notes', 'zero-rhythms', 'zero-fx']
      .every((id) => !!document.getElementById(id)),
    infos: !!document.querySelector('#create-info button') && !!document.querySelector('#musical-typing-info button'),
    seedOptions: document.getElementById('create-seed')?.options.length ?? 0,
  }));
  check('the panel opens', doors.open, (v) => v === true);
  check('ONE Create title, and Musical typing below it', doors.titles.filter((t) => t === 'Create').length === 1 && doors.titles.includes('Musical typing'), (v) => v === true);
  check('the five Zero buttons are there', doors.zeros, (v) => v === true);
  check('the instructions live in ⓘ buttons', doors.infos, (v) => v === true);
  check('the seed list carries the public genres', doors.seedOptions >= 3, (v) => v === true);

  // Blank slate is the REAL one now: states off AND the FX zeroed (his
  // "still have massive reverb and delay" was the stub's gap).
  await page.click('#create-blank');
  await page.waitForTimeout(500);
  const blank = await page.evaluate(() => {
    const p = window.__ambi4Engine.getParams();
    const sends = Object.entries(p.tracks).map(([id, t]) => {
      const patch = p.patches?.[id]?.[t.voice];
      return patch && patch.sends ? patch.sends.reverb + patch.sends.delay : null;
    });
    return {
      states: Object.values(p.tracks).map((t) => t.state),
      reverbTail: p.reverbTail,
      sends,
    };
  });
  check('blank slate turns every track off at the ENGINE', blank.states.every((v) => v === 'off'), (v) => v === true);
  check('…drops the room to its smallest', blank.reverbTail <= 0.5, (v) => v === true);
  check('…and zeroes every default voice’s sends', blank.sends.every((v) => v === 0), (v) => v === true);

  // Seeding: voices arrive from the genre, states stay off.
  // The fresh visit draws a RANDOM genre, so "did a voice change" races the
  // draw (it once WAS synthwave). Assert the seeded result against the
  // genre's own fixed voice set instead.
  await page.selectOption('#create-seed', 'synthwave');
  await page.waitForTimeout(500);
  const seeded = await page.evaluate(() => {
    const t = window.__ambi4Engine.getParams().tracks;
    return {
      voices: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.voice])),
      states: Object.values(t).map((v) => v.state),
      tip: document.getElementById('guided-tip')?.textContent || '',
    };
  });
  const SYNTHWAVE_VOICES = { pad: 'polysaw', bass: 'sawbass', melody: 'keys', texture: 'cloud', arp: 'crystal', percussion: 'soft' };
  const seededRight = Object.entries(SYNTHWAVE_VOICES).every(([k, v]) => seeded.voices[k] === v);
  check('seeding wrote the genre’s own voices to the ENGINE', seededRight, (v) => v === true);
  check('…while every track stays off', seeded.states.every((v) => v === 'off'), (v) => v === true);
  check('…and the guided line names where to start', /start/i.test(seeded.tip), (v) => v === true);
  results.push({ name: 'seeded voices', ok: true, got: seeded.voices, want: '(informational)' });

  // Compose door: lands on the chord editor in Advanced.
  await page.click('#play-along-open').catch(() => {});
  await page.waitForTimeout(200);
  const panelOpen = await page.evaluate(() => !document.getElementById('play-along').hidden);
  if (!panelOpen) {
    await page.click('#play-along-open');
    await page.waitForTimeout(200);
  }
  await page.click('#compose-chords');
  await page.waitForTimeout(700);
  const composeLanding = await page.evaluate(() => ({
    advanced: !document.getElementById('panel-advanced').hidden,
    progressionThere: !!document.getElementById('control-progression'),
  }));
  check('Type-the-chords lands on the Advanced chord editor', composeLanding.advanced && composeLanding.progressionThere, (v) => v === true);

  // Tap a rhythm: one press arms the kit and Capture; Space taps reach the
  // ENGINE on the percussion track.
  await page.evaluate(() => {
    const e = window.__ambi4Engine;
    window.__tap = [];
    const on = e.noteOn.bind(e);
    e.noteOn = (track, midi, velocity) => { window.__tap.push(track); return on(track, midi, velocity); };
  });
  const panelShut = await page.evaluate(() => document.getElementById('play-along').hidden);
  if (panelShut) {
    await page.click('#play-along-open');
    await page.waitForTimeout(250);
  }
  await page.click('#create-tap');
  await page.waitForTimeout(300);
  const tapState = await page.evaluate(() => ({
    pressed: document.getElementById('create-tap').getAttribute('aria-pressed'),
    track: document.getElementById('play-along-track').value,
    keysArmed: document.getElementById('play-along-toggle').getAttribute('aria-pressed'),
    captureArmed: document.getElementById('play-along-capture').getAttribute('aria-pressed'),
  }));
  check('Tap arms the keys on the kit', tapState.pressed === 'true' && tapState.track === 'percussion' && tapState.keysArmed === 'true', (v) => v === true);
  check('…and arms Capture', tapState.captureArmed, 'true');
  for (let i = 0; i < 3; i++) {
    await page.keyboard.down(' ');
    await page.waitForTimeout(120);
    await page.keyboard.up(' ');
    await page.waitForTimeout(180);
  }
  const taps = await page.evaluate(() => window.__tap.filter((t) => t === 'percussion').length);
  check('Space taps reach the ENGINE on percussion', taps >= 2, (v) => v === true);
  await page.click('#create-tap');
  await page.waitForTimeout(300);
  const tapOff = await page.evaluate(() => ({
    pressed: document.getElementById('create-tap').getAttribute('aria-pressed'),
    captureArmed: document.getElementById('play-along-capture').getAttribute('aria-pressed'),
  }));
  check('a second press stops tapping and Capture', tapOff.pressed === 'false' && tapOff.captureArmed === 'false', (v) => v === true);

  // v0.0.107 — the take must land on BOTH sides of the seam: the engine
  // played it, and the PAGE's own settings carry it (the grid, the next edit
  // and the persistence all read settings — an engine-only take was lost to
  // a reload and wiped by the next step click, which shipped unnoticed
  // because every earlier check looked at the engine alone).
  await page.waitForTimeout(600); // past the 250 ms persist debounce
  const adopted = await page.evaluate(() => {
    const eng = window.__ambi4Engine.getParams().tracks.percussion.sequencers;
    let stored = null;
    try {
      const all = JSON.parse(localStorage.getItem('ambi4:generator'));
      stored = all?.tracks?.percussion?.sequencers ?? null;
    } catch {}
    const hits = (seqs) => {
      if (!Array.isArray(seqs)) return -1;
      const lanes = seqs[seqs.length - 1]?.steps || {};
      return Object.values(lanes).flat().filter((s) => s && s.on === true).length;
    };
    return { engineHits: hits(eng), storedHits: stored === null ? null : hits(stored), refitVisible: !document.getElementById('create-refit')?.hidden };
  });
  check('the take reached the engine', adopted.engineHits > 0, (v) => v === true);
  check('…and the page ADOPTED it (persisted settings carry the take)', adopted.storedHits, adopted.engineHits);
  check('the re-fit button appears once a take exists', adopted.refitVisible, (v) => v === true);

  // His 103 repro: "press [blank slate] then press play, I get a complex
  // bassline I didn't programme". The real blank must stay SILENT under Play.
  const panelShut2 = await page.evaluate(() => document.getElementById('play-along').hidden);
  if (panelShut2) {
    await page.click('#play-along-open');
    await page.waitForTimeout(200);
  }
  await page.click('#create-blank');
  await page.waitForTimeout(400);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    window.__blankNotes = 0;
    window.__ambi4Engine.on('note', () => { window.__blankNotes += 1; });
  });
  await page.click('#toggle-play');
  await page.waitForTimeout(3500);
  const blankPlay = await page.evaluate(() => ({
    notes: window.__blankNotes,
    running: window.__ambi4Engine.running === true,
  }));
  check('Play after Blank slate schedules NOTHING', blankPlay.running && blankPlay.notes === 0, (v) => v === true);
  await page.click('#toggle-play').catch(() => {});
  await page.waitForTimeout(300);

  // Guided start is a visible option now.
  const guided = await page.evaluate(() => !!document.getElementById('guided-start'));
  check('Help me start is a create option', guided, (v) => v === true);

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'create-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n'),
    );
  }
  return { passed: results.length, notes: results.filter((r) => r.want === '(informational)').map((r) => `${r.name}: ${JSON.stringify(r.got)}`) };
}
