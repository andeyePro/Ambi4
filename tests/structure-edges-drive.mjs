/**
 * Structure and content, at their EDGES — in a real browser, while playing.
 *
 *   npm run build && .vibe/measure.sh local drive tests/structure-edges-drive.mjs
 *
 * The happy paths live in section-drive, progression-drive, chordchip-drive,
 * words-drive, midi-import-drive and typed-melody-drive. This one probes what
 * they do not: empty, maximal and pasted-garbage inputs, unicode where only
 * English was expected, rapid repeated edits while the piece is sounding,
 * deleting the section that is playing, a MIDI file with no notes or with
 * several tracks, and — after EVERY edit — that the ENGINE's stored structure
 * is the editor's (window.__ambi4Engine is the documented seam). A page that
 * draws one thing while the engine plays another is this repo's oldest fault,
 * and every console error or pageerror during the run fails it.
 */

const openFoldFor = async (page, selector) => {
  const more = await page.evaluate((s) => (typeof window.__ambi4FoldMore === 'function' ? window.__ambi4FoldMore(s) : null), selector);
  if (more) {
    await page.click(more);
    await page.waitForTimeout(150);
  }
};

/** The editor's rows and the engine's blocks, in one comparable shape. */
const structureParity = (page) => page.evaluate(() => {
  const norm = (b) => ({
    label: b.label,
    title: b.title || '',
    bars: Number(b.bars),
    states: Object.values(b.tracks || {}).sort().join(','),
  });
  const dom = [...document.querySelectorAll('.structure-block')].map((row) => {
    return norm({
      label: row.querySelector('select').value,
      title: row.querySelector('.block-title').value,
      bars: row.querySelector('input[type="number"]').value,
      tracks: Object.fromEntries([...row.querySelectorAll('.block-track')]
        .map((b, i) => [i, b.dataset.state]).filter(([, s]) => s && s !== 'auto')),
    });
  });
  const engine = (window.__ambi4Engine.getParams().customStructure || []).map(norm);
  return { dom, engine, same: JSON.stringify(dom) === JSON.stringify(engine) };
});

export default async function drive(page) {
  const results = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
  };
  const info = (name, got) => results.push({ name, ok: true, got, want: '(informational)' });

  // Every console error and uncaught exception during the run is a finding.
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e && e.message ? e.message : String(e)}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  await page.click('#consent-slot button:has-text("Save on this device")').catch(() => {});
  await page.waitForTimeout(200);

  // Pin the draw: a fresh visit picks a random genre, and the scale decides
  // which chord loops the seed law will accept.
  await page.evaluate(() => {
    const sel = document.getElementById('genre-select');
    const opt = [...sel.options].find((o) => o.value === 'g:synthwave');
    if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await page.waitForFunction(() => window.__ambi4Engine?.getParams?.()?.genre === 'synthwave', { timeout: 5000 }).catch(() => {});
  await page.selectOption('#time-signature', '4/4').catch(() => {});
  await page.waitForTimeout(300);

  // Everything below happens while the piece is SOUNDING.
  await page.click('#toggle-play');
  await page.waitForFunction(() => window.__ambi4Engine?.running === true, { timeout: 8000 }).catch(() => {});
  check('the piece is playing before the edits start', await page.evaluate(() => window.__ambi4Engine.running), true);

  // ---------------------------------------------------------------- structure
  await page.click('#tab-advanced');
  await page.waitForTimeout(400);
  await openFoldFor(page, '#structure');
  await page.selectOption('#structure', 'custom');
  await page.waitForTimeout(400);

  const rows = () => page.evaluate(() => document.querySelectorAll('.structure-block').length);

  // Grow to the cap. Eight is the engine's cap too, so the ninth must be refused.
  for (let i = 0; i < 10; i++) {
    const disabled = await page.evaluate(() => document.getElementById('add-structure-block').disabled);
    if (disabled) break;
    await page.click('#add-structure-block');
    await page.waitForTimeout(120);
  }
  check('Add block stops at eight rows', await rows(), 8);
  check('…and the engine holds eight', await page.evaluate(() => window.__ambi4Engine.getParams().customStructure.length), 8);
  check('…and the button says so', await page.evaluate(() => document.getElementById('add-structure-block').disabled), true);
  let parity = await structureParity(page);
  check('editor and engine agree after growing', parity.same, true);

  // Bars at the edges: the box clamps and the ENGINE gets the clamped value.
  const setBars = async (row, text) => {
    await page.evaluate(([i, v]) => {
      const input = document.querySelectorAll('.structure-block')[i].querySelector('input[type="number"]');
      input.value = v;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, [row, text]);
    await page.waitForTimeout(150);
    return page.evaluate((i) => ({
      shown: document.querySelectorAll('.structure-block')[i].querySelector('input[type="number"]').value,
      engine: window.__ambi4Engine.getParams().customStructure[i]?.bars ?? null,
    }), row);
  };
  check('bars 0 becomes 1 in the box and the engine', await setBars(1, '0'), { shown: '1', engine: 1 });
  check('bars 999 becomes 32 in the box and the engine', await setBars(1, '999'), { shown: '32', engine: 32 });
  check('bars -3 becomes 1', await setBars(1, '-3'), { shown: '1', engine: 1 });
  const beforeJunk = await page.evaluate(() => window.__ambi4Engine.getParams().customStructure[2].bars);
  const junk = await setBars(2, 'abc');
  check('a non-number leaves the engine bars alone', junk.engine, beforeJunk);
  await setBars(1, '4');
  await setBars(2, '2');

  // A title in unicode, longer than the cap: stored once, truncated once,
  // and the engine's copy is the editor's copy.
  const longTitle = 'Chørüs ✨ 日本語 — and then some more words';
  await page.evaluate((t) => {
    const input = document.querySelectorAll('.structure-block')[0].querySelector('.block-title');
    input.value = t;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, longTitle);
  await page.waitForTimeout(200);
  const title = await page.evaluate(() => ({
    engine: window.__ambi4Engine.getParams().customStructure[0].title,
    shown: document.querySelectorAll('.structure-block')[0].querySelector('.block-title').value,
  }));
  check('a unicode title reaches the engine, cut to 24 characters', title.engine, longTitle.slice(0, 24).trim());
  check('…and the box shows the same text the engine holds', title.shown, title.engine);

  // The label select: the engine follows, and the per-instrument buttons
  // beside it must name the NEW section — a tooltip naming the old one is
  // a readout lying.
  await page.evaluate(() => {
    const sel = document.querySelectorAll('.structure-block')[0].querySelector('select');
    sel.value = 'C';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(200);
  const relabelled = await page.evaluate(() => ({
    engine: window.__ambi4Engine.getParams().customStructure[0].label,
    buttonTitle: document.querySelectorAll('.structure-block')[0].querySelector('.block-track').title,
  }));
  check('a relabelled block reaches the engine', relabelled.engine, 'C');
  check('…and its instrument buttons name the new section', /section C\b/.test(relabelled.buttonTitle), (v) => v === true);
  info('button title after relabel', relabelled.buttonTitle);

  // Instrument states on a block other than the first, and a reorder.
  await page.click('.structure-block:nth-child(3) .block-track:nth-of-type(2)');
  await page.click('.structure-block:nth-child(3) .block-track:nth-of-type(2)');
  await page.click('.structure-block:nth-child(3) .block-track:nth-of-type(3)');
  await page.waitForTimeout(200);
  check('block 3 instrument states reach the engine', await page.evaluate(() =>
    Object.values(window.__ambi4Engine.getParams().customStructure[2].tracks).sort()), ['off', 'on']);
  await page.click('.structure-block:nth-child(3) .block-move:nth-of-type(1)');
  await page.waitForTimeout(200);
  parity = await structureParity(page);
  check('moving a block keeps editor and engine in step', parity.same, true);
  check('…and the moved block carried its states with it', parity.engine[1].states, 'off,on');

  // Delete the block that is PLAYING. The engine restarts the structure from
  // its new first block; nothing may throw, and the clock must keep ticking.
  const playingLabel = await page.evaluate(() => new Promise((resolve) => {
    let done = false;
    const finish = (label) => { if (!done) { done = true; resolve(label); } };
    try { window.__ambi4Engine.on('section', (e) => finish(e.label)); } catch {}
    setTimeout(() => finish(null), 4000);
    // The opening section is announced on the first bar; if it already was,
    // the next bar event names where we are through the structure keys.
    try { window.__ambi4Engine.on('bar', () => setTimeout(() => finish(null), 50)); } catch {}
  }));
  info('section announced while editing', playingLabel);
  const firstBefore = await page.evaluate(() => window.__ambi4Engine.getParams().customStructure[0].label);
  await page.click('.structure-block:nth-child(1) .block-remove');
  await page.waitForTimeout(200);
  const afterDelete = await page.evaluate(() => ({
    rows: document.querySelectorAll('.structure-block').length,
    engine: window.__ambi4Engine.getParams().customStructure.length,
    first: window.__ambi4Engine.getParams().customStructure[0].label,
    running: window.__ambi4Engine.running,
  }));
  check('deleting the playing block removes exactly one', [afterDelete.rows, afterDelete.engine], [7, 7]);
  check('…the engine still runs', afterDelete.running, true);
  info('first block before/after delete', [firstBefore, afterDelete.first]);
  const ticked = await page.evaluate(() => new Promise((resolve) => {
    let seen = false;
    try { window.__ambi4Engine.on('bar', () => { seen = true; resolve(true); }); } catch { resolve('no bar event'); }
    setTimeout(() => resolve(seen), 9000);
  }));
  check('…and a bar still arrives after the delete', ticked, true);

  // Rapid repeated edits while sounding: twenty quick changes, no waits.
  for (let i = 0; i < 20; i++) {
    const row = 1 + (i % 5);
    await page.click(`.structure-block:nth-child(${row}) .block-track:nth-of-type(${1 + (i % 4)})`, { timeout: 2000 }).catch(() => {});
    await page.evaluate(([r, v]) => {
      const input = document.querySelectorAll('.structure-block')[r - 1]?.querySelector('input[type="number"]');
      if (!input) return;
      input.value = String(v);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, [row, 1 + (i % 7)]);
  }
  await page.waitForTimeout(400);
  parity = await structureParity(page);
  check('twenty rapid edits leave editor and engine identical', parity.same, true);
  if (!parity.same) info('parity after rapid edits', parity);

  // Shrink to one: the last block cannot be removed.
  for (let i = 0; i < 10; i++) {
    const disabled = await page.evaluate(() => document.querySelector('.structure-block .block-remove')?.disabled ?? true);
    if (disabled) break;
    await page.click('.structure-block:nth-child(1) .block-remove');
    await page.waitForTimeout(100);
  }
  check('the last block cannot be removed', [await rows(), await page.evaluate(() => window.__ambi4Engine.getParams().customStructure.length)], [1, 1]);
  check('…and the engine still resolves a custom structure', await page.evaluate(() => window.__ambi4Engine.running), true);

  // ----------------------------------------------------- sequencer order
  // By weight / In turn (renamed v0.0.273): the labels, the tooltip and the
  // engine must all tell the same story.
  await page.evaluate(() => {
    for (const row of document.querySelectorAll('.track-row')) {
      if (/melody/i.test(row.textContent || '')) { row.querySelector('.voice-edit-toggle')?.click(); return; }
    }
  });
  await page.waitForTimeout(600);
  await page.evaluate(() => document.querySelector('#voice-editor-melody .seq-add')?.scrollIntoView({ block: 'center' }));
  await page.click('#voice-editor-melody .seq-add').catch(() => {});
  await page.waitForTimeout(300);
  const order = await page.evaluate(() => {
    const ed = document.getElementById('voice-editor-melody');
    const wrap = ed.querySelector('.seq-order');
    const labels = [...wrap.querySelectorAll('label')].map((l) => l.textContent.trim());
    const descId = wrap.getAttribute('aria-describedby');
    const tip = descId ? document.getElementById(descId)?.textContent || '' : '';
    return { labels, tip, tabs: ed.querySelectorAll('.seq-tab-strip input, .seq-tab-strip button').length };
  });
  check('the order toggle reads By weight / In turn', order.labels, ['By weight', 'In turn']);
  check('…and its tooltip uses the same two names', /By weight/.test(order.tip) && /In turn/.test(order.tip) && !/Shuffle|In order/.test(order.tip), (v) => v === true);
  await page.evaluate(() => document.querySelector('label[for="seq-order-melody-chain"]').click());
  await page.waitForTimeout(300);
  const chained = await page.evaluate(() => ({
    engine: window.__ambi4Engine.getParams().tracks.melody.sequencerAdvance ?? null,
    weightHidden: document.querySelector('#voice-editor-melody .seq-weight')?.hidden ?? null,
  }));
  check('In turn reaches the engine', chained.engine, 'chain');
  check('…and hides the weight the engine then ignores', chained.weightHidden, true);
  await page.evaluate(() => document.querySelector('label[for="seq-order-melody-weights"]').click());
  await page.waitForTimeout(300);
  const weighted = await page.evaluate(() => ({
    engine: window.__ambi4Engine.getParams().tracks.melody.sequencerAdvance ?? null,
    weightHidden: document.querySelector('#voice-editor-melody .seq-weight')?.hidden ?? null,
  }));
  check('By weight reaches the engine', weighted.engine, null);
  check('…and the weight box comes back', weighted.weightHidden, false);

  // --------------------------------------------------------- progression
  await page.evaluate(() => document.getElementById('progression-row')?.scrollIntoView({ block: 'center' }));
  const commitLoop = async (text) => {
    await page.fill('#progression-row .progression-input', text);
    await page.press('#progression-row .progression-input', 'Enter');
    await page.waitForTimeout(400);
    return page.evaluate(() => ({
      shown: document.querySelector('#progression-row .progression-input')?.value || '',
      engine: (window.__ambi4Engine.getParams().harmony?.seed || []).map((s) => `${s.degree}:${s.extension}`).join(' '),
      count: (window.__ambi4Engine.getParams().harmony?.seed || []).length,
      hint: document.getElementById('progression-hint')?.textContent || '',
    }));
  };
  const base = await commitLoop('I IV V vi');
  check('a plain loop is accepted', base.count, 4);
  const withJunk = await commitLoop('I IV xyz');
  check('a loop with a word in it is refused whole, and the engine keeps the old loop', withJunk.engine, base.engine);
  check('…the box snaps back to the loop that is playing', withJunk.shown.trim().split(/\s+/).length, 4);
  check('…and the hint SAYS the text was refused, naming the token', /xyz/.test(withJunk.hint) && /(kept|refused|not|could)/i.test(withJunk.hint), (v) => v === true);
  info('hint after junk', withJunk.hint);
  const unicode = await commitLoop('Ⅰ Ⅳ Ⅴ');
  check('unicode roman numerals are refused, not misread', unicode.engine, base.engine);
  check('…and explained', /Ⅰ/.test(unicode.hint) || /refused|kept|not/i.test(unicode.hint), (v) => v === true);
  const long = await commitLoop('I IV V vi I IV V vi I IV V vi I IV V vi');
  check('sixteen chords are cut to the cap of eight', long.count, 8);
  check('…and the hint says the rest were dropped', /eight|8/.test(long.hint) && /(first|kept|dropped|cut|only)/i.test(long.hint), (v) => v === true);
  info('hint after sixteen', long.hint);
  const commas = await commitLoop('I, IV, V, vi');
  check('commas separate chords', commas.count, 4);
  const empty = await commitLoop('   ');
  check('whitespace hands the loop back to the app', empty.count, 0);
  check('…and the hint says the app is choosing', /app is writing|choos/i.test(empty.hint), (v) => v === true);
  // Rapid commits while playing.
  for (let i = 0; i < 8; i++) {
    await page.fill('#progression-row .progression-input', i % 2 ? 'I V vi IV' : 'vi IV I V');
    await page.press('#progression-row .progression-input', 'Enter');
  }
  await page.waitForTimeout(400);
  const rapid = await commitLoop('I V vi IV');
  check('rapid commits settle on the last loop', rapid.engine, '0:-1 4:-1 5:-1 3:-1');
  check('…and the chips agree with the engine', await page.evaluate(() => document.querySelectorAll('#progression-chords .chord-chip').length), 4);

  // --------------------------------------------------------------- MIDI
  await page.click('#play-along-open');
  await page.waitForTimeout(300);
  await page.selectOption('#create-write', 'midi');
  await page.waitForTimeout(150);
  // One SMF builder in the page, used for every case.
  await page.evaluate(() => {
    const varint = (value) => { const out = [value & 0x7f]; let v = value >> 7; while (v > 0) { out.unshift((v & 0x7f) | 0x80); v >>= 7; } return out; };
    const uint = (value, count) => { const out = []; for (let i = count - 1; i >= 0; i--) out.push((value >> (i * 8)) & 0xff); return out; };
    const chunk = (id, body) => [...[...id].map((c) => c.charCodeAt(0)), ...uint(body.length, 4), ...body];
    window.__smf = ({ format = 0, division = 480, tracks = [], extraChunks = [], truncate = null }) => {
      const parts = [...chunk('MThd', [...uint(format, 2), ...uint(tracks.length + extraChunks.length, 2), ...uint(division, 2)])];
      extraChunks.forEach((c) => parts.push(...chunk(c.id, c.body)));
      for (const t of tracks) {
        const ev = [];
        if (t.timeSignature) ev.push(...varint(0), 0xff, 0x58, 4, t.timeSignature[0], Math.log2(t.timeSignature[1]), 24, 8);
        if (t.tempo) ev.push(...varint(0), 0xff, 0x51, 3, ...uint(Math.round(60000000 / t.tempo), 3));
        if (t.name) ev.push(...varint(0), 0xff, 0x03, t.name.length, ...[...t.name].map((c) => c.charCodeAt(0)));
        let at = 0;
        for (const n of (t.notes || [])) {
          ev.push(...varint(Math.round((n.start - at) * division)), 0x90 | (n.channel || 0), n.midi, n.velocity || 100);
          ev.push(...varint(Math.round((n.length ?? 1) * division)), 0x80 | (n.channel || 0), n.midi, 0);
          at = n.start + (n.length ?? 1);
        }
        ev.push(...varint(0), 0xff, 0x2f, 0x00);
        parts.push(...chunk('MTrk', ev));
      }
      const bytes = new Uint8Array(truncate ? parts.slice(0, truncate) : parts);
      return new File([bytes], 'probe.mid', { type: 'audio/midi' });
    };
    window.__importFile = async (file) => {
      const input = document.getElementById('compose-midi');
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 900));
      const live = window.__ambi4Engine.getParams().tracks.melody;
      const steps = (seq) => (Array.isArray(seq.steps) ? seq.steps : Object.values(seq.steps)[0]);
      return {
        bars: live.sequencers.length,
        notes: live.sequencers.map((s) => steps(s).filter((x) => x.on).map((x) => x.midi)),
        tip: document.getElementById('guided-tip')?.textContent || '',
      };
    };
  });
  const melodyBefore = await page.evaluate(() => JSON.stringify(window.__ambi4Engine.getParams().tracks.melody.sequencers));
  const noNotes = await page.evaluate(async () => {
    const r = await window.__importFile(window.__smf({ tracks: [{ tempo: 100 }] }));
    return { ...r, same: JSON.stringify(window.__ambi4Engine.getParams().tracks.melody.sequencers) };
  });
  check('a MIDI file with no notes is refused with a reason', /no notes/.test(noNotes.tip), (v) => v === true);
  check('…and leaves the melody exactly as it was', noNotes.same, melodyBefore);
  const truncated = await page.evaluate(async () => {
    const r = await window.__importFile(window.__smf({ tracks: [{ notes: [{ start: 0, midi: 60 }, { start: 1, midi: 62 }] }], truncate: 30 }));
    return { ...r, same: JSON.stringify(window.__ambi4Engine.getParams().tracks.melody.sequencers) };
  });
  check('a truncated file is refused with a reason', /could not be read/.test(truncated.tip), (v) => v === true);
  check('…and changes nothing', truncated.same, melodyBefore);
  // Format 1, three tracks and a foreign chunk: a tempo track, a tune and a
  // bass line under it. They all land on ONE grid; the report has to say
  // the file had several tracks, or "notes shared a step" is a mystery.
  const multi = await page.evaluate(async () => window.__importFile(window.__smf({
    format: 1,
    extraChunks: [{ id: 'XFIH', body: [1, 2, 3, 4] }],
    tracks: [
      { tempo: 90, timeSignature: [3, 4], name: 'conductor' },
      { name: 'tune', notes: [{ start: 0, midi: 72 }, { start: 1, midi: 74 }, { start: 2, midi: 76 }] },
      { name: 'bass', channel: 1, notes: [{ start: 0, midi: 48, channel: 1 }, { start: 2, midi: 43, channel: 1 }] },
    ],
  })));
  check('a multi-track file imports', /Imported/.test(multi.tip), (v) => v === true);
  check('…the higher part wins where the parts share a step', multi.notes[0], [72, 74, 76]);
  check('…the report says notes shared a step', /shared a step/.test(multi.tip), (v) => v === true);
  check('…and that the file had several tracks, merged onto one grid', /\b(two|three|2|3) (note )?tracks\b/i.test(multi.tip) || /several tracks/i.test(multi.tip), (v) => v === true);
  check('…and names the file’s metre against the piece’s', /3\/4/.test(multi.tip), (v) => v === true);
  info('multi-track tip', multi.tip);
  // Forty bars of notes: eight land, the rest are counted out loud.
  const longFile = await page.evaluate(async () => window.__importFile(window.__smf({
    tracks: [{ notes: Array.from({ length: 160 }, (_, i) => ({ start: i, midi: 60 + (i % 12) })) }],
  })));
  check('a long file is cut to eight bars', longFile.bars, 8);
  check('…and the report counts what was left out', /left out/.test(longFile.tip) && /128/.test(longFile.tip), (v) => v === true);
  info('long-file tip', longFile.tip);

  // -------------------------------------------------------------- words
  await page.selectOption('#create-write', 'words');
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    const select = document.getElementById('compose-words-track');
    select.value = 'melody';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const sing = async (text) => {
    await page.evaluate((words) => {
      const box = document.getElementById('compose-words-text');
      box.value = words;
      box.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('compose-words-write').click();
    }, text);
    await page.waitForTimeout(900);
    return page.evaluate(() => {
      const live = window.__ambi4Engine.getParams().tracks.melody;
      const steps = (seq) => (Array.isArray(seq.steps) ? seq.steps : Object.values(seq.steps)[0]);
      return {
        bars: live.sequencers.length,
        midis: live.sequencers.flatMap((s) => steps(s).filter((x) => x.on).map((x) => x.midi)),
        tip: document.getElementById('guided-tip')?.textContent || '',
      };
    });
  };
  const accented = await sing('Café naïve résumé tonight');
  check('accented words sing', accented.midis.length >= 4 && accented.midis.every((m) => Number.isFinite(m)), (v) => v === true);
  info('accented tip', accented.tip);
  const cyrillic = await sing('Привет мир\n日本語の詩\n🎵 🎶');
  check('a poem with no Latin letters is refused honestly rather than crashing', /No words understood/.test(cyrillic.tip), (v) => v === true);
  check('…and leaves the previous melody', cyrillic.midis.length, accented.midis.length);
  const epic = await sing(Array.from({ length: 30 }, (_, i) => `The river carries every stone away ${i}`).join('\n'));
  check('a thirty-line poem stops at eight bars', epic.bars <= 8, (v) => v === true);
  check('…and says the cap was hit', /eight bars is the cap/.test(epic.tip), (v) => v === true);
  for (let i = 0; i < 6; i++) {
    await page.evaluate((i) => {
      const box = document.getElementById('compose-words-text');
      box.value = i % 2 ? 'The sky is falling down tonight' : 'Silence over the water';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('compose-words-write').click();
    }, i);
  }
  await page.waitForTimeout(1200);
  const settled = await page.evaluate(() => {
    const live = window.__ambi4Engine.getParams().tracks.melody;
    const steps = (seq) => (Array.isArray(seq.steps) ? seq.steps : Object.values(seq.steps)[0]);
    return live.sequencers.reduce((n, s) => n + steps(s).filter((x) => x.on).length, 0);
  });
  check('six rapid writes settle on the last poem (8 syllables)', settled, 8);

  // ------------------------------------------------- typed melody, off-rung
  // "One token per beat" — at the melody's OWN resolution. The writer must
  // ask the track what a beat is in slots; at the ×2 rung (quavers) a beat is
  // two slots, not four, and a lane is ten, not twenty.
  await page.selectOption('#create-write', 'melody');
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    const select = document.getElementById('compose-melody-track');
    select.value = 'melody';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.fill('#compose-melody-text', 'C4 X E4 ☃');
  await page.click('#compose-melody-write');
  await page.waitForTimeout(400);
  const unread = await page.evaluate(() => document.getElementById('guided-tip')?.textContent || '');
  check('a token that is not a note is reported as not understood, not as past the cap', /X/.test(unread) && !/eight bars is the cap/.test(unread), (v) => v === true);
  info('tip for C4 X E4 ☃', unread);
  // Close the popover (the tab strip sits in its shadow), set the rung.
  await page.click('#play-along-open');
  await page.waitForTimeout(150);
  await page.evaluate(() => document.querySelector('#voice-editor-melody .seq-res-step')?.scrollIntoView({ block: 'center' }));
  await page.click('#voice-editor-melody .seq-res-step:first-of-type'); // ×2: quavers
  await page.waitForTimeout(400);
  const rung = await page.evaluate(() => window.__ambi4Engine.getParams().tracks.melody.stepBeats ?? 0.25);
  check('the melody grid is at the quaver rung', rung, 0.5);
  await page.click('#play-along-open');
  await page.waitForTimeout(300);
  await page.selectOption('#create-write', 'melody');
  await page.waitForTimeout(150);
  await page.fill('#compose-melody-text', 'C4 D4 E4 F4');
  await page.click('#compose-melody-write');
  await page.waitForTimeout(500);
  const quavers = await page.evaluate(() => {
    const track = window.__ambi4Engine.getParams().tracks.melody;
    const steps = track.sequencers[0].steps;
    return {
      bars: track.sequencers.length,
      laneLength: steps.length,
      pins: steps.map((s, i) => (s.on && !(i > 0 && steps[i - 1].tie && steps[i - 1].midi === s.midi) ? { slot: i, midi: s.midi } : null)).filter(Boolean),
      on: steps.map((s) => (s.on ? 1 : 0)).join(''),
    };
  });
  check('four beats at the quaver rung are ONE bar', quavers.bars, 1);
  check('…with the notes on beats 1 2 3 4 — slots 0 2 4 6', quavers.pins, [{ slot: 0, midi: 60 }, { slot: 2, midi: 62 }, { slot: 4, midi: 64 }, { slot: 6, midi: 65 }]);
  info('quaver lane', quavers);

  // ----------------------------------------------------------- the errors
  check('no console errors or uncaught exceptions during the run', errors, []);

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'structure-edges-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n') +
      '\n  notes:\n' + results.filter((r) => r.want === '(informational)').map((r) => `    ${r.name}: ${JSON.stringify(r.got)}`).join('\n'),
    );
  }
  return { passed: results.length, notes: results.filter((r) => r.want === '(informational)').map((r) => `${r.name}: ${JSON.stringify(r.got)}`) };
}
