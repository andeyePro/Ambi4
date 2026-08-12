/**
 * "Fit chords to the tune" — the derivation half of his compose entry point
 * one: "Play or type a melody, chords derived algorithmically on request."
 *
 *   npm run build && .vibe/measure.sh local drive tests/derive-chords-drive.mjs
 *
 * Asserted at the ENGINE: the derived loop must land in harmony.seed (not just
 * in a readout), the chord under the tune's first bar must actually CONTAIN
 * that bar's notes, and a track with nothing pitched must refuse without
 * touching the loop that was already there. The key is pinned through the
 * page's own Root and Scale selects and VERIFIED at the engine, because a
 * fresh visit draws a random genre and an assertion about "I" is an assertion
 * about the key it is a first degree OF.
 */

export default async function drive(page) {
  const results = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
  };

  await page.click('#consent-slot button:has-text("Save on this device")').catch(() => {});
  await page.waitForTimeout(200);
  // Pin the key through the page's own controls, so settings and engine agree.
  // The selects live on the HIDDEN Advanced tab, so Playwright's selectOption
  // (which requires visibility) silently fails — drive the change event the
  // page actually listens to instead.
  await page.evaluate(() => {
    const set = (id, value) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.value = value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set('timeSignature', '4/4');
    set('root', 'C');
    set('mode', 'ionian');
  });
  await page.waitForTimeout(400);
  await page.click('#play-along-open');
  await page.waitForTimeout(300);

  const boot = await page.evaluate(() => {
    const select = document.getElementById('compose-harmonise-track');
    const p = window.__ambi4Engine.getParams();
    return {
      button: !!document.getElementById('compose-harmonise'),
      picker: select ? [...select.options].map((o) => o.value) : [],
      root: p.root,
      mode: p.mode,
    };
  });
  check('the fit-chords button is in the compose panel', boot.button, true);
  check('its picker offers the tuned tracks, and not the kit',
    boot.picker.includes('melody') && boot.picker.includes('bass') && !boot.picker.includes('percussion'),
    (v) => v === true);
  const keyPinned = boot.root === 'C' && boot.mode === 'ionian';
  check('the key pin took at the engine (C ionian)', keyPinned, true);

  // With nothing pitched on the chosen track, the button must refuse and must
  // NOT touch the loop that is already set.
  const refusal = await page.evaluate(async () => {
    window.__ambi4Engine.setParams({ harmony: { seed: [{ degree: 3, extension: -1 }] } });
    const before = JSON.stringify(window.__ambi4Engine.getParams().harmony.seed);
    const select = document.getElementById('compose-harmonise-track');
    select.value = 'bass';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('compose-harmonise').click();
    await new Promise((r) => setTimeout(r, 700));
    return {
      after: JSON.stringify(window.__ambi4Engine.getParams().harmony.seed),
      before,
      tip: document.getElementById('guided-tip')?.textContent || '',
    };
  });
  check('an unpitched track is refused with a reason', /Nothing pitched on Bass/.test(refusal.tip), (v) => v === true);
  check('…and the loop that was set is untouched', refusal.after, refusal.before);

  // Type a two-bar tune — a C arpeggio then a G arpeggio — and fit chords to it.
  const fitted = await page.evaluate(async () => {
    const melodySelect = document.getElementById('compose-melody-track');
    melodySelect.value = 'melody';
    melodySelect.dispatchEvent(new Event('change', { bubbles: true }));
    const box = document.getElementById('compose-melody-text');
    box.value = 'C4 E4 G4 E4 G4 B4 D5 B4';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('compose-melody-write').click();
    await new Promise((r) => setTimeout(r, 900));
    const select = document.getElementById('compose-harmonise-track');
    select.value = 'melody';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('compose-harmonise').click();
    await new Promise((r) => setTimeout(r, 900));
    const p = window.__ambi4Engine.getParams();
    return {
      seed: p.harmony?.seed ?? null,
      tip: document.getElementById('guided-tip')?.textContent || '',
    };
  });
  check('the derived loop landed in the ENGINE\'s harmony.seed',
    Array.isArray(fitted.seed) && fitted.seed.length >= 1, (v) => v === true);
  check('every slot is a degree object the seed law accepted',
    (fitted.seed || []).every((s) => Number.isInteger(s.degree)), (v) => v === true);
  if (keyPinned) {
    // In C ionian, C-E-G then G-B-D is I then V, and I V collapses to no
    // shorter loop. Exact, because the key is proven pinned above.
    check('in C major the tune reads I then V',
      (fitted.seed || []).map((s) => s.degree), [0, 4]);
  }
  check('the report names the instrument and the chords',
    /Chords fitted to Melody/.test(fitted.tip) && (!keyPinned || /I – V/.test(fitted.tip)), (v) => v === true);
  check('…and points at the chord editor', /chord editor/.test(fitted.tip), (v) => v === true);

  // The first bar's notes must sit INSIDE the first chord — asked of the
  // engine module's own scale table rather than assumed.
  const containment = await page.evaluate(async ([seedJson]) => {
    const seed = JSON.parse(seedJson);
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
    const degree = seed[0].degree;
    const n = scale.length;
    const triad = [0, 2, 4].map((step) => ((rootPc + scale[(((degree + step) % n) + n) % n]) % 12 + 12) % 12);
    const barOne = [60, 64, 67].map((m) => m % 12);
    return { triad, inside: barOne.every((pc) => triad.includes(pc)) };
  }, [JSON.stringify(fitted.seed || [])]);
  check('the engine module was reachable, so the chord can be spelled', !!containment, (v) => v === true);
  if (containment && keyPinned) {
    // Only meaningful when C-E-G is in the scale at all: in a random key the
    // typed notes may be chromatic, and a chromatic note is deliberately NOT
    // chord evidence.
    check('the first bar\'s notes all sit inside the first chord', containment.inside, true);
  }

  // Any-track: the same button fits chords to a tune on the BASS.
  const onBass = await page.evaluate(async () => {
    const melodySelect = document.getElementById('compose-melody-track');
    melodySelect.value = 'bass';
    melodySelect.dispatchEvent(new Event('change', { bubbles: true }));
    const box = document.getElementById('compose-melody-text');
    box.value = 'F2 A2 C3 A2';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('compose-melody-write').click();
    await new Promise((r) => setTimeout(r, 900));
    const select = document.getElementById('compose-harmonise-track');
    select.value = 'bass';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('compose-harmonise').click();
    await new Promise((r) => setTimeout(r, 900));
    const p = window.__ambi4Engine.getParams();
    return {
      seed: p.harmony?.seed ?? null,
      tip: document.getElementById('guided-tip')?.textContent || '',
    };
  });
  check('a tune on the bass gets its own fit, and the report says so',
    /Chords fitted to Bass/.test(onBass.tip), (v) => v === true);
  if (keyPinned) {
    check('F-A-C in C major reads IV', (onBass.seed || []).map((s) => s.degree), [3]);
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'derive-chords-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n'),
    );
  }
  return { passed: results.length };
}
