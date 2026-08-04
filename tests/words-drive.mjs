/**
 * "Words", his third compose method — his 116, verbatim: "c) lyrics that you
 * enter - like a poem - and the system determines the meter, so can, for
 * example, generate a melody based on the chosen chord sequence."
 *
 *   npm run build && .vibe/measure.sh local drive tests/words-drive.mjs
 *
 * Asserted at the ENGINE: the syllables must arrive as pinned steps whose
 * pitches came from the chord sequence, the stresses must land on the metre's
 * pulses, and a triple-time poem must actually change the metre. A grid drawing
 * a melody the engine never received is this repo's oldest failure.
 */

export default async function drive(page) {
  const results = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
  };

  await page.click('#consent-slot button:has-text("Save on this device")').catch(() => {});
  await page.waitForTimeout(200);
  // The metre is pinned; the KEY is READ rather than forced. A fresh visit draws
  // a random genre, and selectOption on the mode list is not guaranteed to hold
  // (this drive was written asserting C major and the engine was in C aeolian —
  // the chord tones it names are the SCALE's, so the test has to ask the engine
  // what the scale is instead of assuming one).
  await page.selectOption('#time-signature', '4/4').catch(() => {});
  await page.waitForTimeout(400);
  await page.click('#play-along-open');
  await page.waitForTimeout(300);

  const present = await page.evaluate(() => ({
    box: !!document.getElementById('compose-words-text'),
    button: !!document.getElementById('compose-words-write'),
    hint: document.getElementById('compose-words-text')?.placeholder || '',
  }));
  check('the words box is in the compose row', present.box && present.button, (v) => v === true);
  check('…and says the metre comes out of the words', /metre comes out of them/.test(present.hint), (v) => v === true);

  const sing = async (text, chords) => {
    await page.evaluate(([words, seed]) => {
      if (seed) window.__ambi4Engine.setParams({ harmony: { seed } });
      const box = document.getElementById('compose-words-text');
      box.value = words;
      box.dispatchEvent(new Event('input', { bubbles: true }));
    }, [text, chords || null]);
    await page.click('#compose-words-write');
    await page.waitForTimeout(900);
    return page.evaluate(() => {
      const p = window.__ambi4Engine.getParams();
      const track = p.tracks.melody;
      const bar = (index) => {
        const seq = track.sequencers[index];
        if (!seq) return null;
        const steps = Array.isArray(seq.steps) ? seq.steps : Object.values(seq.steps)[0];
        return steps.map((s, i) => (s.on ? { slot: i, midi: s.midi ?? null, vmax: +s.vmax.toFixed(2) } : null))
          .filter(Boolean);
      };
      return {
        metre: p.timeSignature,
        bars: track.sequencers.length,
        advance: track.sequencerAdvance ?? null,
        state: track.state,
        mode: track.sequencers[0].mode,
        bar1: bar(0),
        bar2: bar(1),
        tip: document.getElementById('guided-tip')?.textContent || '',
      };
    });
  };

  // An iambic line over I - IV: eight syllables, four of them stressed.
  const iambic = await sing('The sky is falling down tonight', [
    { degree: 0, extension: -1 }, { degree: 3, extension: -1 },
  ]);
  check('the melody track is on and manual',
    iambic.state !== 'off' && iambic.mode === 'manual', (v) => v === true);
  check('every syllable became a step', iambic.bar1.length + (iambic.bar2?.length || 0), 8);
  check('every step names its own note', iambic.bar1.every((s) => Number.isFinite(s.midi)), (v) => v === true);
  // 4/4 at sixteenths: the pulses are slots 0, 4, 8, 12. The stresses are the
  // loud ones, and they must be ON those slots.
  const loud = iambic.bar1.filter((s) => s.vmax > 0.8).map((s) => s.slot);
  check('the stressed syllables land on the beats', loud.every((slot) => slot % 4 === 0), (v) => v === true);
  check('…and there are some', loud.length >= 3, (v) => v === true);
  // A stressed syllable sings a chord tone OF THE CHORD UNDER IT. The scale comes
  // from the ENGINE MODULE, imported in the browser by its hashed URL — a drive
  // file is loaded as a data: URL, so it cannot import the project's own modules
  // itself, and hardcoding a key is what made this test wrong the first time
  // (it asserted C major while the visit was in C aeolian; the chord tones are
  // the scale's, so the scale has to be asked for).
  const triad = await page.evaluate(async () => {
    const html = await (await fetch('/')).text();
    const direct = html.match(/\/_astro\/ambient-engine\.[A-Za-z0-9_-]+\.js/);
    let url = direct ? direct[0] : null;
    if (!url) {
      const entry = html.match(/\/_astro\/index\.astro[^"']+\.js/);
      if (entry) {
        const js = await (await fetch(entry[0])).text();
        const nested = js.match(/ambient-engine\.[A-Za-z0-9_-]+\.js/);
        if (nested) url = `/_astro/${nested[0]}`;
      }
    }
    if (!url) return null;
    const mod = await import(url);
    const p = window.__ambi4Engine.getParams();
    const scale = mod.SCALES[p.mode] || mod.SCALES.ionian;
    const rootPc = mod.pitchClass(p.root) ?? 0;
    const degree = p.harmony?.seed?.[0]?.degree ?? 0;
    return {
      root: p.root,
      mode: p.mode,
      degree,
      pcs: [0, 2, 4].map((step) => {
        const n = scale.length;
        const i = (((degree + step) % n) + n) % n;
        return ((rootPc + scale[i]) % 12 + 12) % 12;
      }),
    };
  });
  check('the engine module was reachable, so the chord can be named', !!triad, (v) => v === true);
  const loudNotes = iambic.bar1.filter((s) => s.vmax > 0.8).map((s) => ((s.midi % 12) + 12) % 12);
  const quietNotes = iambic.bar1.filter((s) => s.vmax < 0.8).map((s) => ((s.midi % 12) + 12) % 12);
  if (triad) {
    check(`a stressed syllable sings a chord tone (${triad.root} ${triad.mode}, chord ${triad.degree + 1})`,
      loudNotes.every((pc) => triad.pcs.includes(pc)), (v) => v === true);
    // An UNSTRESSED syllable need not be a chord tone: that is what makes it a
    // passing note rather than another statement of the chord.
    check('…and the unstressed ones pass between them',
      quietNotes.some((pc) => !triad.pcs.includes(pc)), (v) => v === true);
  }

  check('the report counts the syllables and says where the notes came from',
    /8 syllables/.test(iambic.tip) && /from your chord sequence/.test(iambic.tip), (v) => v === true);
  check('…and names the instrument that sang them', /Melody sings/.test(iambic.tip), (v) => v === true);
  check('…and says the steps are yours to edit', /drag any note the words got wrong/.test(iambic.tip), (v) => v === true);

  // A triple-time poem must MOVE the metre — his "the system determines the
  // meter", asserted at the engine rather than in the select.
  const triple = await sing(
    'And the sound of the sea in the morning\nWith a hush of the wind in the wing',
    [{ degree: 0, extension: -1 }],
  );
  check('a poem that scans in threes changes the metre to 6/8', triple.metre, '6/8');
  check('…and says so', /metre is now 6\/8/.test(triple.tip), (v) => v === true);
  check('…with the second line in its own bar', triple.bars >= 2, (v) => v === true);
  check('…played in order', triple.advance, 'chain');

  // No chord sequence: the tonic, and the report says that instead of implying
  // there was a progression.
  const noChords = await page.evaluate(async () => {
    window.__ambi4Engine.setParams({ harmony: { seed: null } });
    const box = document.getElementById('compose-words-text');
    box.value = 'Silence over the water';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('compose-words-write').click();
    await new Promise((r) => setTimeout(r, 900));
    return document.getElementById('guided-tip')?.textContent || '';
  });
  check('with no chords set it says the line sits on the tonic',
    /no chord sequence set/.test(noChords), (v) => v === true);

  // Nothing typed is refused, and leaves the melody alone.
  const before = await page.evaluate(() =>
    JSON.stringify(window.__ambi4Engine.getParams().tracks.melody.sequencers));
  const refused = await page.evaluate(async () => {
    const box = document.getElementById('compose-words-text');
    box.value = '   ';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('compose-words-write').click();
    await new Promise((r) => setTimeout(r, 600));
    return JSON.stringify(window.__ambi4Engine.getParams().tracks.melody.sequencers);
  });
  check('blank words change nothing', refused, before);

  // v0.0.152 (his "start with ANY track, not a privileged few"): the words can be
  // sung by any tuned instrument, and the picker says which. Asserted at the
  // ENGINE on a track that is NOT the melody, because "it works for melody" was
  // never the question.
  const onBass = await page.evaluate(async () => {
    const select = document.getElementById('compose-words-track');
    const has = [...select.options].some((o) => o.value === 'bass');
    if (!has) return { skipped: 'no bass in the picker' };
    select.value = 'bass';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    const before = JSON.stringify(window.__ambi4Engine.getParams().tracks.melody.sequencers);
    const box = document.getElementById('compose-words-text');
    box.value = 'The river carries every stone away';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('compose-words-write').click();
    await new Promise((r) => setTimeout(r, 900));
    const p = window.__ambi4Engine.getParams();
    const steps = (seq) => (Array.isArray(seq.steps) ? seq.steps : Object.values(seq.steps)[0]);
    return {
      bassNotes: p.tracks.bass.sequencers.flatMap((s) => steps(s).filter((x) => x.on).map((x) => x.midi)),
      bassState: p.tracks.bass.state,
      melodyUnchanged: JSON.stringify(p.tracks.melody.sequencers) === before,
      tip: document.getElementById('guided-tip')?.textContent || '',
      picker: [...select.options].map((o) => o.value),
    };
  });
  if (onBass.skipped) {
    check(`the picker offers more than the melody (${onBass.skipped})`, false, (v) => v === true);
  } else {
    check('the picker offers the tuned tracks, and not the kit',
      onBass.picker.includes('bass') && !onBass.picker.includes('percussion'), (v) => v === true);
    check('the words land on the instrument the picker names',
      onBass.bassNotes.length > 0 && onBass.bassNotes.every((m) => Number.isFinite(m)), (v) => v === true);
    check('…that instrument is switched on', onBass.bassState !== 'off', (v) => v === true);
    check('…the melody is left exactly as it was', onBass.melodyUnchanged, true);
    check('…and the report names it', /Bass sings/.test(onBass.tip), (v) => v === true);
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'words-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n'),
    );
  }
  return { passed: results.length };
}
