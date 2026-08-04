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
  // The kit's patch as it stands BEFORE the blank: the law below is that a blank
  // slate does not rewrite it, and params.patches keeps whatever a genre wrote
  // for the same voice, so "unchanged" has to be measured against this rather
  // than against an assumption about what is in there.
  const kitBefore = await page.evaluate(() => {
    const p = window.__ambi4Engine.getParams();
    const voice = p.tracks.percussion.voice;
    const patch = p.patches?.percussion?.[voice] ?? null;
    if (!patch) return null;
    const { sends, ...rest } = patch;
    return JSON.stringify(rest);
  });
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

  // v0.0.143, his 117: "none of the instruments seem to be at sensible blanks.
  // For example I would expect only one OSC to be selected, detune to be zero,
  // the filter cutoff to be fully open with resonance zero, likewise envelope
  // should be at whatever people would expect of a zeroed state." Asserted at
  // the ENGINE's own sanitised patch, not at the dials — a dial drawing a value
  // the engine never received is the failure this repo keeps catching.
  const init = await page.evaluate(() => {
    const p = window.__ambi4Engine.getParams();
    // params.patches echoes what was SENT, so a partial override is partial
    // here — which is exactly what the kit's must be.
    const read = (id) => {
      const t = p.tracks[id];
      const patch = p.patches?.[id]?.[t.voice];
      if (!patch) return null;
      return {
        shape2: patch.source ? patch.source.shape2 : undefined,
        detune: patch.source ? patch.source.detune : undefined,
        cutoff: patch.filter ? patch.filter.cutoff : undefined,
        q: patch.filter ? patch.filter.q : undefined,
        envAmount: patch.filter ? patch.filter.envAmount : undefined,
        adsr: patch.adsr || null,
        keys: Object.keys(patch).sort(),
      };
    };
    return {
      tuned: Object.keys(p.tracks).filter((id) => id !== 'percussion').map((id) => [id, read(id)]),
      kit: read('percussion'),
      kitRest: (() => {
        const voice = p.tracks.percussion.voice;
        const patch = p.patches?.percussion?.[voice] ?? null;
        if (!patch) return null;
        const { sends, ...rest } = patch;
        return JSON.stringify(rest);
      })(),
      seed: p.harmony?.seed ?? null,
      arpMode: p.arp?.mode ?? null,
    };
  });
  // Every tuned track must HAVE a patch after a blank slate: on the old code
  // they carried a sends-only override, so this list was full of undefineds and
  // the laws below are what caught it.
  const tuned = init.tuned.filter(([, v]) => v);
  check('every tuned track gets an init patch at all', tuned.length, init.tuned.length);
  check('every tuned track opens on ONE oscillator', tuned.every(([, v]) => v.shape2 === null), (v) => v === true);
  check('…with no spread', tuned.every(([, v]) => v.detune === 0), (v) => v === true);
  check('…the filter fully open', tuned.every(([, v]) => v.cutoff >= 12000), (v) => v === true);
  check('…resonance and filter envelope at their floors',
    tuned.every(([, v]) => v.q <= 0.1 && v.envAmount === 0), (v) => v === true);
  check('…and a gate for an envelope: instant on, full while held, instant off',
    tuned.every(([, v]) => v.adsr && v.adsr.attack <= 0.001 && v.adsr.decay <= 0.001
      && v.adsr.sustain === 1 && v.adsr.release <= 0.01), (v) => v === true);
  // The kit is deliberately NOT zeroed: it publishes one envelope for three
  // sounds, so a zeroed envelope would leave three clicks and no way back
  // until per-sound envelopes land (his open item 129).
  // What the measurement actually showed, and it is the right answer: a blank
  // slate clears the genre's kit patch and writes NO envelope, filter or
  // oscillator of its own, so the kit falls back to the sound its voice
  // publishes. The tuned tracks get the init patch; the kit gets nothing,
  // because one envelope for three sounds cannot be zeroed without leaving
  // three clicks (his open item 129).
  check('a blank slate leaves the kit on its own authored sound, with no init written over it',
    init.kitRest, '{}');
  check('…and it really did have a genre patch before, so that is a change not a coincidence',
    kitBefore !== null && kitBefore !== '{}', (v) => v === true);
  // The two reasons "stuff happens" when you turn the instruments on.
  check('blank leaves ONE chord, not a progression the app wrote',
    Array.isArray(init.seed) && init.seed.length === 1, (v) => v === true);
  check('…and the arp is manual, so its cleared lane stays cleared', init.arpMode, 'manual');

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

  // AUDIT (critical 1 + majors 5/16): the Zero buttons must never bake the
  // ENGINE's power-scaled/capped/walked values into the user's settings, and
  // Zero chords must write a seed the sanitiser can take (an array).
  {
    const askBefore = await page.evaluate(() => {
      const all = JSON.parse(localStorage.getItem('ambi4:generator') || '{}');
      return { level: all?.tracks?.texture?.level ?? null, tail: all?.reverbTail ?? null };
    });
    await page.click('#zero-chords');
    await page.waitForTimeout(600);
    const afterZero = await page.evaluate(() => {
      const all = JSON.parse(localStorage.getItem('ambi4:generator') || '{}');
      const seed = window.__ambi4Engine.getParams().harmony?.seed;
      return {
        level: all?.tracks?.texture?.level ?? null,
        tail: all?.reverbTail ?? null,
        seedLength: Array.isArray(seed) ? seed.length : null,
      };
    });
    check('Zero keeps the user’s stored texture level byte-exact', afterZero.level, askBefore.level);
    check('…and the stored reverb-tail ask', afterZero.tail, askBefore.tail);
    check('Zero chords writes a seed the ENGINE accepts (one chord)', afterZero.seedLength, 1);
  }

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

  // v0.0.143, the second half of his 117: "if I press play and turn on all
  // instruments, stuff happens - that's not particularly blank". So turn them
  // ALL on and measure what the engine schedules. A held chord is the floor —
  // an instrument that is on has to sound something — but there must be no
  // progression, no drum pattern and no melodic line, because none of that was
  // asked for. Note events carry their track, so this is measured per track.
  // The panel HIDES rather than unmounts, and the block above pressed Escape —
  // so reopen it before clicking, or the click lands on an invisible button.
  if (await page.evaluate(() => document.getElementById('play-along').hidden)) {
    await page.click('#play-along-open');
    await page.waitForTimeout(250);
  }
  await page.click('#create-blank');
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const engine = window.__ambi4Engine;
    const tracks = {};
    for (const id of Object.keys(engine.getParams().tracks)) tracks[id] = { state: 'on' };
    engine.setParams({ tracks });
    window.__onNotes = [];
    engine.on('note', (e) => { window.__onNotes.push({ track: e.track, midi: e.midi }); });
  });
  await page.click('#toggle-play');
  await page.waitForTimeout(4000);
  const allOn = await page.evaluate(() => {
    const byTrack = {};
    for (const n of window.__onNotes) {
      byTrack[n.track] = byTrack[n.track] || new Set();
      byTrack[n.track].add(n.midi);
    }
    return {
      states: Object.values(window.__ambi4Engine.getParams().tracks).map((t) => t.state),
      tracks: Object.fromEntries(Object.entries(byTrack).map(([k, v]) => [k, [...v].sort((a, b) => a - b)])),
      total: window.__onNotes.length,
    };
  });
  await page.click('#toggle-play').catch(() => {});
  await page.waitForTimeout(200);
  check('every track really was switched on', allOn.states.every((s) => s === 'on'), (v) => v === true);
  const stepped = ['bass', 'melody', 'arp', 'percussion'].filter((id) => allOn.tracks[id]);
  check('no drum pattern, no bassline, no melody, no arp line — nothing was written',
    stepped, []);
  // The sustaining tracks may hold the one chord; what they must NOT do is move
  // through a progression, so the set of pitches they play is one chord's worth.
  const held = ['pad', 'texture'].flatMap((id) => allOn.tracks[id] || []);
  check('the sustaining tracks hold one chord at most, never a sequence',
    held.length <= 4, (v) => v === true);

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
