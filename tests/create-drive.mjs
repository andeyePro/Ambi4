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

  // The button: Play's height, within a pixel.
  const geometry = await page.evaluate(() => {
    const play = document.getElementById('toggle-play')?.getBoundingClientRect();
    const create = document.getElementById('play-along-open')?.getBoundingClientRect();
    const label = document.getElementById('play-along-open')?.textContent.trim();
    return play && create ? { dh: Math.abs(play.height - create.height), label } : null;
  });
  check('the Create button exists', !!geometry, (v) => v === true);
  check('it says Create', geometry?.label, 'Create');
  check('it stands at the Play button’s height', geometry && geometry.dh <= 1, (v) => v === true);

  // The panel: three doors.
  await page.click('#play-along-open');
  await page.waitForTimeout(250);
  const doors = await page.evaluate(() => ({
    open: !document.getElementById('play-along').hidden,
    create: !!document.getElementById('create-section-title'),
    compose: !!document.getElementById('compose-section-title'),
    playalong: !!document.getElementById('play-along-section-title'),
    seedOptions: document.getElementById('create-seed')?.options.length ?? 0,
  }));
  check('the panel opens with all three doors', doors.open && doors.create && doors.compose && doors.playalong, (v) => v === true);
  check('the seed list carries the public genres', doors.seedOptions >= 3, (v) => v === true);

  // Blank slate: every ENGINE track state goes off.
  await page.click('#create-blank');
  await page.waitForTimeout(400);
  const states = await page.evaluate(() => {
    const t = window.__ambi4Engine.getParams().tracks;
    return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.state]));
  });
  check('blank slate turns every track off at the ENGINE', Object.values(states).every((v) => v === 'off'), (v) => v === true);

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

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'create-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n'),
    );
  }
  return { passed: results.length, notes: results.filter((r) => r.want === '(informational)').map((r) => `${r.name}: ${JSON.stringify(r.got)}`) };
}
