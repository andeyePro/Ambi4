/**
 * MIDI-file import, end to end in a real browser.
 *
 *   npm run build && .vibe/measure.sh local drive tests/midi-import-drive.mjs
 *
 * His item 96: "MIDI file import is a compose option IMHO, the assumption is
 * that the user composed the MIDI in another app, we can't know if that wasn't
 * the case." So the file's notes must arrive as ordinary, editable, PINNED
 * steps on the chosen instrument's grid — asserted at the ENGINE, because a
 * grid that draws an import the engine never received is this repo's oldest
 * failure. The file is built here (a few dozen bytes) rather than committed as
 * a binary nobody can review.
 */

export default async function drive(page) {
  const results = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
  };

  await page.click('#consent-slot button:has-text("Save on this device")').catch(() => {});
  await page.waitForTimeout(200);
  await page.selectOption('#time-signature', '4/4').catch(() => {});
  await page.waitForTimeout(300);
  await page.click('#play-along-open');
  await page.waitForTimeout(300);

  const present = await page.evaluate(() => ({
    input: !!document.getElementById('compose-midi'),
    picker: !!document.getElementById('compose-midi-track'),
    options: [...(document.getElementById('compose-midi-track')?.options || [])].map((o) => o.value),
  }));
  check('the import control is in the compose row', present.input && present.picker, (v) => v === true);
  check('…and offers the sequenced tracks', present.options.includes('melody') && present.options.includes('bass'), (v) => v === true);

  // A five-note file: C4 D4 E4 in bar 1 (beats 0, 1, 2), G4 in bar 2 (beat 4),
  // plus an E4 sharing beat 0 with the C4 — the chord case a step grid cannot
  // hold, so it must collapse to the HIGHEST note and be reported.
  const imported = await page.evaluate(async () => {
    const varint = (value) => {
      const out = [value & 0x7f];
      let v = value >> 7;
      while (v > 0) { out.unshift((v & 0x7f) | 0x80); v >>= 7; }
      return out;
    };
    const uint = (value, count) => {
      const out = [];
      for (let i = count - 1; i >= 0; i--) out.push((value >> (i * 8)) & 0xff);
      return out;
    };
    const chunk = (id, body) => [...[...id].map((c) => c.charCodeAt(0)), ...uint(body.length, 4), ...body];
    const D = 480;
    const events = [
      ...varint(0), 0x90, 60, 100, //        C4 at beat 0
      ...varint(0), 0x90, 64, 90, //         E4 also at beat 0 (the chord)
      ...varint(D), 0x80, 60, 0,
      ...varint(0), 0x80, 64, 0,
      ...varint(0), 0x90, 62, 100, //        D4 at beat 1
      ...varint(D), 0x80, 62, 0,
      ...varint(0), 0x90, 64, 100, //        E4 at beat 2
      ...varint(D), 0x80, 64, 0,
      ...varint(D * 1), 0x90, 67, 100, //    G4 at beat 4 — next bar
      ...varint(D), 0x80, 67, 0,
    ];
    const bytes = new Uint8Array([
      ...chunk('MThd', [...uint(1, 2), ...uint(1, 2), ...uint(D, 2)]),
      ...chunk('MTrk', [...events, ...varint(0), 0xff, 0x2f, 0x00]),
    ]);
    const file = new File([bytes], 'phrase.mid', { type: 'audio/midi' });
    const input = document.getElementById('compose-midi');
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 900));
    const live = window.__ambi4Engine.getParams().tracks.melody;
    const bar = (index) => {
      const seq = live.sequencers[index];
      if (!seq) return null;
      const steps = Array.isArray(seq.steps) ? seq.steps : Object.values(seq.steps)[0];
      return steps.map((s, i) => (s.on ? { slot: i, midi: s.midi ?? null } : null)).filter(Boolean);
    };
    return {
      bars: live.sequencers.length,
      advance: live.sequencerAdvance ?? null,
      state: live.state,
      bar1: bar(0),
      bar2: bar(1),
      tip: document.getElementById('guided-tip')?.textContent || '',
    };
  });

  check('the file became two bars', imported.bars, 2);
  check('…played in order at the ENGINE', imported.advance, 'chain');
  check('…on a track that now sounds', imported.state !== 'off', (v) => v === true);
  check('bar 1 holds the three notes, pinned, at their beats',
    imported.bar1, [{ slot: 0, midi: 64 }, { slot: 4, midi: 62 }, { slot: 8, midi: 64 }]);
  check('bar 2 holds the note that fell past the barline', imported.bar2, [{ slot: 0, midi: 67 }]);
  check('the report names the note count and the bars', /Imported 4 notes onto Melody, 2 bars/.test(imported.tip), (v) => v === true);
  check('…and says a chord collapsed rather than hiding it', /shared a step/.test(imported.tip), (v) => v === true);

  // A file we refuse must say why, and must not touch what is already there.
  const refused = await page.evaluate(async () => {
    const before = JSON.stringify(window.__ambi4Engine.getParams().tracks.melody.sequencers);
    const input = document.getElementById('compose-midi');
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array([1, 2, 3, 4, 5])], 'notes.txt', { type: 'text/plain' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 700));
    return {
      tip: document.getElementById('guided-tip')?.textContent || '',
      unchanged: JSON.stringify(window.__ambi4Engine.getParams().tracks.melody.sequencers) === before,
    };
  });
  check('a file that is not MIDI is refused with a reason', /could not be read/.test(refused.tip), (v) => v === true);
  check('…and the import that WAS there is untouched', refused.unchanged, true);

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'midi-import-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n'),
    );
  }
  return { passed: results.length };
}
