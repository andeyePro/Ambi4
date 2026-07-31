/**
 * Note-onset discontinuity, measured from a REAL offline render.
 *
 *   npm run build && .vibe/measure.sh local drive tests/onset-render.mjs
 *
 * The owner reported a click on note onset twice, independently — "Soul Groove
 * — Fingered bass is also cracking on note start" and "Bossa … has a lot of
 * sounds that are starting with a click". Nobody in the container can hear it,
 * and that was wrongly filed as a reason not to work on it: a click IS a
 * measurement. It is a step in the sample stream, and a step has a size.
 *
 * This imports the shipped voice library into the page, plays one note of each
 * voice into an OfflineAudioContext, renders it, and reports the largest
 * sample-to-sample jump in the first 50 ms against the largest jump in the
 * steady part of the note. A voice whose onset jumps far harder than its own
 * body does is a voice that clicks.
 *
 * It measures the SHIPPED code — `VOICES[track][id].play` is the same function
 * the engine calls — rather than a reconstruction of it, which is the whole
 * reason it runs in a browser instead of in Node.
 */

const PROBE = async (moduleUrl, targets) => {
  const mod = await import(moduleUrl);
  const VOICES = mod.VOICES;
  const SR = 48000;
  const out = [];

  // v0.0.138: EVERY voice in the library, not the four bass ones this started
  // with. He reported the click twice and the second report was not about bass
  // at all — "Bossa … has a lot of sounds that are starting with a click" — so
  // a gate that only ever rendered basses could not have seen it. `targets` of
  // null means "enumerate whatever the shipped library holds", which also means
  // a voice added later is measured the day it lands.
  // One window measurer for every scenario: steepest step, loudest sample, and
  // the steepness (step ÷ loudest) that the click law compares.
  const steepIn = (data, sr, fromSec, toSec) => {
    const from = Math.max(1, Math.floor(fromSec * sr));
    const to = Math.min(Math.floor(toSec * sr), data.length);
    let worst = 0;
    let where = from;
    let peak = 0;
    for (let i = from; i < to; i++) {
      const d = Math.abs(data[i] - data[i - 1]);
      if (d > worst) { worst = d; where = i; }
      if (Math.abs(data[i]) > peak) peak = Math.abs(data[i]);
    }
    // How many steps in this window are within half the worst one. A NOISE
    // transient — a mallet strike, a finger on a string, a hand on a drum — is
    // dozens of steep steps in a row, because noise is steep by nature and the
    // burst is deliberate. A discontinuity is ONE step in an otherwise smooth
    // signal. Without this count, a gate on steepness accuses every percussive
    // voice of clicking for having an attack transient.
    let spikes = 0;
    for (let i = from; i < to; i++) {
      if (Math.abs(data[i] - data[i - 1]) > worst * 0.5) spikes += 1;
    }
    return {
      worst: +worst.toFixed(5),
      peak: +peak.toFixed(5),
      steepness: peak > 0 ? +(worst / peak).toFixed(4) : null,
      spikes,
      at: +(where / sr).toFixed(4),
    };
  };
  /**
   * Does this step RECUR one waveform period later? A bright attack lets a
   * saw's or pulse's wrap through while the filter is open, and that wrap is the
   * waveform: it happens again on the next cycle, and the cycle after. A
   * discontinuity happens once. Without this the two are indistinguishable —
   * a filter that closes within 50 ms leaves exactly one visible wrap inside
   * the onset window, which looks like a lone step and is not one.
   */
  const recursAtPeriod = (data, sr, sample, freq) => {
    if (!Number.isFinite(freq) || freq <= 0) return null;
    const period = sr / freq;
    const step = Math.abs(data[sample] - data[sample - 1]);
    if (!(step > 0)) return null;
    for (const multiple of [1, 2, 3]) {
      const centre = Math.round(sample + period * multiple);
      let best = 0;
      for (let i = centre - 4; i <= centre + 4; i++) {
        if (i < 1 || i >= data.length) continue;
        best = Math.max(best, Math.abs(data[i] - data[i - 1]));
      }
      if (best >= step * 0.55) return +(best / step).toFixed(3);
    }
    return null;
  };
  const peakOf = (data) => {
    let peak = 0;
    for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
    return peak;
  };
  const list = Array.isArray(targets) && targets.length
    ? targets
    : Object.entries(VOICES || {}).flatMap(([track, family]) =>
      Object.keys(family || {}).map((id) => [track, id]));

  for (const [track, id] of list) {
    const voice = VOICES?.[track]?.[id];
    if (!voice || typeof voice.play !== 'function') {
      out.push({ track, id, error: 'voice not found' });
      continue;
    }
    try {
      const ctx = new OfflineAudioContext(1, SR * 2, SR);
      const bus = ctx.createGain();
      bus.gain.value = 1;
      bus.connect(ctx.destination);
      // One note, starting a comfortable way into the buffer so the onset is
      // surrounded by real silence rather than by the buffer edge.
      voice.play(ctx, bus, { when: 0.25, freq: 110, midi: 45, velocity: 0.9, duration: 1 }, null);
      const buffer = await ctx.startRendering();
      const data = buffer.getChannelData(0);

      const at = (s) => Math.floor(s * SR);
      // v0.0.138: a window reports its steepest step AND its own loudest
      // sample, because the only honest way to ask "is this a click?" is to ask
      // how steep the signal is RELATIVE TO HOW LOUD IT IS. A sawtooth wraps
      // by its whole amplitude every cycle — steepness ≈ 1 — at onset and in
      // the middle of the note alike; a click is steepness that appears at one
      // instant and is absent either side of it.
      const jump = (from, to) => steepIn(data, SR, from / SR, to / SR);
      // The onset window starts a hair BEFORE the scheduled time: a step at
      // exactly t0 is the one being hunted.
      const onset = jump(at(0.245), at(0.30));
      // The reference for the onset is the note's next 60 ms — still at full
      // amplitude on a plucked voice, unlike the old 0.45–0.95 window, which on
      // a fast-decaying voice was near-silence and made every ratio explode.
      const nextCycles = jump(at(0.30), at(0.36));
      // v0.0.138 — THE PRECONDITION THIS FILE WAS MISSING. It used to pass
      // `time:` in the note, but the shipped voices read `when:` (see
      // engine-voices.js), so every note started at ctx.currentTime — zero —
      // and every window below measured a part of the note nobody asked
      // about: the "onset" window sat 250 ms into the body, and fingered
      // bass's real onset step (0.084, 77% of its own peak) was never seen.
      // The rename alone would leave the same trap open for the next field
      // change, so the harness now PROVES it found the note: the first
      // audible sample must land inside the onset window, or the row fails.
      let firstAudible = null;
      {
        const floor = Math.max(1e-4, peakOf(data) * 0.01);
        for (let i = 0; i < data.length; i++) {
          if (Math.abs(data[i]) > floor) { firstAudible = +(i / SR).toFixed(4); break; }
        }
      }
      // Anything sounding before the scheduled onset means the harness is not
      // measuring the note it thinks it is.
      const silenceBefore = +peakOf(data.subarray(0, at(0.245))).toFixed(6);
      const onsetRecurs = recursAtPeriod(data, SR, Math.round(onset.at * SR), 110);
      // The body: well past any attack, before any release.
      const body = jump(at(0.45), at(0.95));
      const peak = peakOf(data);
      // A FAST LINE, which is where the owner heard it: a second note landing
      // 120 ms after the first, so the first note's release is still ringing
      // when the second starts. One isolated note cannot show a collision.
      let fast = null;
      try {
        const ctx2 = new OfflineAudioContext(1, SR * 2, SR);
        const bus2 = ctx2.createGain();
        bus2.gain.value = 1;
        bus2.connect(ctx2.destination);
        voice.play(ctx2, bus2, { when: 0.25, freq: 110, midi: 45, velocity: 0.9, duration: 0.12 }, null);
        voice.play(ctx2, bus2, { when: 0.37, freq: 146.83, midi: 50, velocity: 0.9, duration: 0.12 }, null);
        const b2 = await ctx2.startRendering();
        const d2 = b2.getChannelData(0);
        const event = steepIn(d2, SR, 0.365, 0.40);
        const reference = steepIn(d2, SR, 0.30, 0.35);
        fast = {
          recurs: recursAtPeriod(d2, SR, Math.round(event.at * SR), 146.83),
          secondOnsetJump: event.worst,
          spikes: event.spikes,
          at: event.at,
          firstNoteBodyJump: reference.worst,
          eventSteepness: event.steepness,
          referenceSteepness: reference.steepness,
          ratio: reference.worst > 0 ? +(event.worst / reference.worst).toFixed(2) : null,
        };
      } catch (err) {
        fast = { error: String(err && err.message ? err.message : err) };
      }

      // The engine-mediated CANCEL: on a mono re-strike the engine releases
      // the sounding note AT the new onset (ambient-engine.js releaseMono),
      // via handle.cancel(at) with `at` in the future. cancel() samples
      // out.gain.value at SCHEDULING time and re-asserts that value at `at` —
      // if the envelope has moved in between, the gain STEPS. No isolated
      // render can show it because nothing cancels.
      let cut = null;
      try {
        const ctx3 = new OfflineAudioContext(1, SR * 2, SR);
        const bus3 = ctx3.createGain();
        bus3.gain.value = 1;
        bus3.connect(ctx3.destination);
        const h = voice.play(ctx3, bus3, { when: 0.25, freq: 110, midi: 45, velocity: 0.9, duration: 1.2 }, null);
        const cancellable = h && typeof h.cancel === 'function';
        if (cancellable) h.cancel(0.6);
        const b3 = await ctx3.startRendering();
        const d3 = b3.getChannelData(0);
        const event = steepIn(d3, SR, 0.595, 0.65);
        const reference = steepIn(d3, SR, 0.45, 0.59);
        cut = cancellable ? {
          recurs: recursAtPeriod(d3, SR, Math.round(event.at * SR), 110),
          cancelJump: event.worst,
          spikes: event.spikes,
          at: event.at,
          bodyJump: reference.worst,
          eventSteepness: event.steepness,
          referenceSteepness: reference.steepness,
          ratio: reference.worst > 0 ? +(event.worst / reference.worst).toFixed(2) : null,
        } : { skipped: 'no cancel handle' };
      } catch (err) {
        cut = { error: String(err && err.message ? err.message : err) };
      }

      // The legato slur chain: takeOver() runs only when legatoFrom arrives,
      // built here exactly as the engine builds it — so this is the first
      // render ever to exercise the shipped slur path.
      let slur = null;
      try {
        const ctx4 = new OfflineAudioContext(1, SR * 2, SR);
        const bus4 = ctx4.createGain();
        bus4.gain.value = 1;
        bus4.connect(ctx4.destination);
        const h1 = voice.play(ctx4, bus4, { when: 0.25, freq: 110, midi: 45, velocity: 0.9, duration: 0.2 }, null);
        const n2 = { when: 0.37, freq: 146.83, midi: 50, velocity: 0.9, duration: 0.2,
          legatoFrom: { freq: 110, handle: h1, glide: 0.05 } };
        const h2 = voice.play(ctx4, bus4, n2, null);
        const took2 = !!(h2 && h2.legato === true);
        const h3ref = took2 ? h1 : h2;
        const n3 = { when: 0.49, freq: 110, midi: 45, velocity: 0.9, duration: 0.3,
          legatoFrom: { freq: 146.83, handle: h3ref, glide: 0.05 } };
        const h3 = voice.play(ctx4, bus4, n3, null);
        const took3 = !!(h3 && h3.legato === true);
        const b4 = await ctx4.startRendering();
        const d4 = b4.getChannelData(0);
        const hand2W = steepIn(d4, SR, 0.365, 0.44);
        const hand3W = steepIn(d4, SR, 0.485, 0.56);
        const bodyWin = steepIn(d4, SR, 0.28, 0.36);
        slur = {
          took: [took2, took3],
          recurs2: recursAtPeriod(d4, SR, Math.round(hand2W.at * SR), 146.83),
          recurs3: recursAtPeriod(d4, SR, Math.round(hand3W.at * SR), 110),
          handoverJump2: hand2W.worst,
          handoverJump3: hand3W.worst,
          spikes2: hand2W.spikes,
          spikes3: hand3W.spikes,
          handoverSteepness2: hand2W.steepness,
          handoverSteepness3: hand3W.steepness,
          bodyJump: bodyWin.worst,
          bodySteepness: bodyWin.steepness,
          ratio: bodyWin.worst > 0 ? +(Math.max(hand2W.worst, hand3W.worst) / bodyWin.worst).toFixed(2) : null,
        };
      } catch (err) {
        slur = { error: String(err && err.message ? err.message : err) };
      }

      out.push({
        track,
        id,
        firstAudible,
        silenceBefore,
        peak: +peak.toFixed(4),
        onsetJump: onset.worst,
        onsetSteepness: onset.steepness,
        onsetSpikes: onset.spikes,
        onsetRecurs,
        nextCyclesJump: +nextCycles.worst.toFixed(5),
        nextCyclesSteepness: nextCycles.peak > 0 ? +(nextCycles.worst / nextCycles.peak).toFixed(4) : null,
        onsetAt: onset.at,
        bodyJump: +body.worst.toFixed(5),
        // The number that matters: how much harder the onset steps than the
        // note's own waveform does. A sawtooth's body already steps once per
        // cycle, so an absolute threshold would flag every bright voice.
        ratio: body.worst > 0 ? +(onset.worst / body.worst).toFixed(2) : null,
        fastLine: fast,
        cancelCut: cut,
        slurChain: slur,
      });
    } catch (err) {
      out.push({ track, id, error: String(err && err.message ? err.message : err) });
    }
  }

  // The multi-track sum: bass, pad and a kit lane struck at the same instant
  // into one bus. Addition cannot create a discontinuity that no part has,
  // but the negative deserves to be a measurement rather than an argument.
  try {
    const ctx5 = new OfflineAudioContext(1, SR * 2, SR);
    const bus5 = ctx5.createGain();
    bus5.gain.value = 1;
    bus5.connect(ctx5.destination);
    VOICES.bass.fingered.play(ctx5, bus5, { when: 0.25, freq: 110, midi: 45, velocity: 0.9, duration: 0.6 }, null);
    VOICES.pad.warm.play(ctx5, bus5, { when: 0.25, freq: 220, midi: 57, velocity: 0.8, duration: 1.2 }, null);
    if (VOICES.percussion && VOICES.percussion.soft) {
      VOICES.percussion.soft.play(ctx5, bus5,
        { when: 0.25, freq: 80, midi: 36, velocity: 0.9, duration: 0.3, kind: 'low', lane: 'low' }, null);
    }
    const b5 = await ctx5.startRendering();
    const d5 = b5.getChannelData(0);
    const eventSum = steepIn(d5, SR, 0.245, 0.30);
    const referenceSum = steepIn(d5, SR, 0.30, 0.36);
    out.push({ track: 'sum', id: 'fingered+warm+soft',
      onsetJump: eventSum.worst, bodyJump: referenceSum.worst,
      onsetSteepness: eventSum.steepness, nextCyclesSteepness: referenceSum.steepness,
      onsetSpikes: eventSum.spikes,
      ratio: referenceSum.worst > 0 ? +(eventSum.worst / referenceSum.worst).toFixed(2) : null });
  } catch (err) {
    out.push({ track: 'sum', id: 'fingered+warm+soft', error: String(err && err.message ? err.message : err) });
  }
  return out;
};

export default async function drive(page) {
  // The engine modules are emitted with content hashes, so the URL is
  // discovered rather than assumed.
  const moduleUrl = await page.evaluate(async () => {
    const html = await (await fetch('/')).text();
    const direct = html.match(/\/_astro\/engine-voices\.[A-Za-z0-9_-]+\.js/);
    if (direct) return direct[0];
    // Not referenced from the page directly: it is imported by the page's own
    // bundle, so follow that one level down.
    const entry = html.match(/\/_astro\/index\.astro[^"']+\.js/);
    if (!entry) return null;
    const js = await (await fetch(entry[0])).text();
    const nested = js.match(/engine-voices\.[A-Za-z0-9_-]+\.js/);
    return nested ? `/_astro/${nested[0]}` : null;
  });
  if (!moduleUrl) throw new Error('onset-render: could not find the engine-voices module URL');

  // The two the owner named, plus a control that nobody has complained about.
  // null: every voice the shipped library exposes (see PROBE).
  const targets = null;
  const rows = await page.evaluate(
    ([fn, url, list]) => new Function(`return (${fn})`)()(url, list),
    [PROBE.toString(), moduleUrl, targets],
  );

  const failed = rows.filter((r) => r.error);
  if (failed.length === rows.length) {
    throw new Error('onset-render: every voice failed\n' + failed.map((r) => `  ${r.track}/${r.id}: ${r.error}`).join('\n'));
  }

  // AUDIT FIX (vacuous test): this file MEASURED five discontinuity metrics
  // and asserted NONE of them — the owner's two click reports could come
  // back and the drive would still report green. A click is a step in the
  // sample stream, so the law is on the step's size:
  //
  //   * absolutely, against a click floor — 0.02 of full scale is a step
  //     you hear at any level (measured worst today: 0.0025, an 8× margin);
  //   * relatively, as a share of the note's OWN peak, so a quiet voice
  //     cannot hide a proportionally huge step (worst today: 2.2%).
  //
  // The onset/body RATIO is deliberately not asserted: on a voice whose
  // steady state is near-silent (upright's 0.00006) the ratio explodes on
  // absolutely inaudible numbers, which is exactly the cry-wolf failure that
  // gets a gate switched off.
  // -- what counts as a click -------------------------------------------------
  //
  // v0.0.138, after the window fix above made the numbers real: an ABSOLUTE
  // step size cannot tell a click from a WAVEFORM. Rendering the sample values
  // around each flagged step showed what the flags actually were — a rise to
  // full amplitude and a drop back to zero, once per cycle: the wrap of a
  // sawtooth. `melody/nylon`, `bass/fingered`, `arp/marimba` and
  // `texture/chimes` are saw- and pulse-based voices, so their steepest
  // sample-to-sample step at onset is the same size as their steepest step in
  // the middle of the note. Flagging that is flagging the instrument for being
  // the instrument, and a gate that cries wolf is a gate that gets switched off.
  //
  // So a step is a click when it stands out from THE SAME NOTE's own waveform:
  //
  //   * absolutely — 0.02 of full scale is a step you hear on a voice whose own
  //     motion is smooth (a sine, a slow pad);
  //   * AND relatively — more than 1.6× the steepest step the same render makes
  //     away from the event, which is the only measure that separates "this
  //     voice moves fast" from "something discontinuous happened here".
  //
  // Both must hold. That is deliberately weaker than the v0.0.137 form and
  // deliberately stronger than the vacuous original: it still catches every
  // envelope/gain discontinuity, and it stops accusing a saw of clicking.
  // -- what counts as a click -------------------------------------------------
  //
  // v0.0.138, after the window fix above made these numbers describe the actual
  // note: an ABSOLUTE step size cannot tell a click from a WAVEFORM. Printing
  // the samples around each flagged step showed what the flags were — a rise to
  // full amplitude and a drop back to zero, once per cycle: a sawtooth's wrap.
  // `melody/nylon`, `bass/fingered`, `arp/marimba`, `texture/chimes` are saw-
  // and pulse-based voices, so their steepest step at onset is the same size as
  // their steepest step mid-note. Flagging that flags the instrument for being
  // the instrument, and a gate that cries wolf gets switched off.
  //
  // So the law is on STEEPNESS — the step divided by how loud the signal is
  // right there — compared against the SAME render a few cycles later:
  //
  //   * the step must clear 0.02 of full scale, so an inaudible wobble on a
  //     quiet voice is never a finding;
  //   * AND the event must be more than 1.6× as steep, for its own loudness, as
  //     the note is just after it.
  //
  // A saw scores ~1 either side and passes. A gain discontinuity on a smooth
  // voice scores ~1 at the event and ~0.02 after it, and fails — which is
  // exactly the shape of the two clicks the owner reported.
  const CLICK_FLOOR = 0.02;      // absolute sample-to-sample step
  const STEEP_MULT = 1.6;        // times the note's own steepness a few cycles on
  const MAX_SPIKES = 8;          // more than this is a noise transient, not a click
  // -- what survives all four filters, as a live baseline ---------------------
  //
  // Fixing these is voice-envelope surgery that moves the frozen audio
  // reference, so they are recorded with their measured numbers rather than
  // left to fail the gate — the same shape as the reference baseline itself.
  // THE GATE STAYS LIVE: a NEW click anywhere fails, a known one more than a
  // fifth worse fails, and one that gets FIXED must be removed from this list.
  //
  //   arp/marimba onset            one step of 0.103, 82% of its own loudness
  //                                against 2.3% a few cycles on, 30 ms after
  //                                the strike — which is where noiseBurst's
  //                                `rig.stopAt(source, end + 0.02)` falls for
  //                                its 1 ms attack and 8 ms decay. That is the
  //                                lead to follow first.
  //   melody/stab onset            38% against 5.7%, same shape
  //   bass/breath slur handover 2  92% against 1.4% — on a SINE voice, so
  //                                nothing about it can be waveform
  //
  // What is NOT here matters as much: `bass/fingered`, `melody/nylon`,
  // `texture/chimes` and marimba's fast-line all showed big steps that RECUR
  // one waveform period later, which makes them the instrument — a saw or pulse
  // wrap heard through an attack that has the filter open — and not a defect.
  // fingered is the voice the owner named, so its onset in isolation is clean
  // and whatever he heard in Soul Groove is in the playing, not in one note.
  const KNOWN = new Map([
    ['bass/breath slur handover 2', 0.92],
    ['arp/marimba onset', 0.82],
    ['melody/stab onset', 0.39],
  ]);
  const KNOWN_SLACK = 1.2; // a fifth worse than measured is a regression
  const known = [];
  const problems = [];
  const claim = (label, jump, steepness, reference, spikes, recurs) => {
    if (!Number.isFinite(jump) || jump <= CLICK_FLOOR) return;
    if (!Number.isFinite(steepness)) return; // no loudness reading, no verdict
    const own = Number.isFinite(reference) ? reference : 0;
    if (own > 0 && steepness <= own * STEEP_MULT) return;
    // A dense cluster of steep steps is a noise transient the voice was written
    // to have — a mallet, a fingertip, a hand on a skin. A click is one step.
    if (Number.isFinite(spikes) && spikes > MAX_SPIKES) return;
    // The same step one waveform period on: this is the instrument's own
    // wrap seen through an attack that opens the filter, not a discontinuity.
    if (Number.isFinite(recurs)) return;
    const baseline = KNOWN.get(label);
    if (baseline !== undefined) {
      if (steepness <= baseline * KNOWN_SLACK) {
        known.push(`${label}: steepness ${steepness.toFixed(3)} (known, baseline ${baseline})`);
        return;
      }
      problems.push(
        `${label}: steepness ${steepness.toFixed(3)} is WORSE than its recorded ${baseline} `
        + `(slack ${KNOWN_SLACK}×) — a known click got louder`,
      );
      return;
    }
    problems.push(
      `${label}: step ${jump.toFixed(5)}, steepness ${steepness.toFixed(3)} against `
      + `${own.toFixed(3)} a few cycles later (${own > 0 ? (steepness / own).toFixed(1) : '∞'}×, `
      + `ceiling ${STEEP_MULT}×), ${spikes} steep step(s) in the window`,
    );
  };
  for (const row of rows) {
    if (row.error) continue;
    const label = `${row.track}/${row.id}`;
    claim(`${label} onset`, row.onsetJump, row.onsetSteepness,
      row.nextCyclesSteepness ?? row.bodySteepness, row.onsetSpikes, row.onsetRecurs);
    claim(`${label} fast-line second onset`, row.fastLine?.secondOnsetJump,
      row.fastLine?.eventSteepness, row.fastLine?.referenceSteepness, row.fastLine?.spikes,
      row.fastLine?.recurs);
    claim(`${label} cancel cut`, row.cancelCut?.cancelJump,
      row.cancelCut?.eventSteepness, row.cancelCut?.referenceSteepness, row.cancelCut?.spikes,
      row.cancelCut?.recurs);
    claim(`${label} slur handover 2`, row.slurChain?.handoverJump2,
      row.slurChain?.handoverSteepness2, row.slurChain?.bodySteepness, row.slurChain?.spikes2,
      row.slurChain?.recurs2);
    claim(`${label} slur handover 3`, row.slurChain?.handoverJump3,
      row.slurChain?.handoverSteepness3, row.slurChain?.bodySteepness, row.slurChain?.spikes3,
      row.slurChain?.recurs3);
  }
  if (problems.length) {
    throw new Error('onset-render: ' + problems.length + ' click(s)\n  ' + problems.join('\n  '));
  }
  // A known click that has been FIXED must not stay in the list: a baseline
  // nobody prunes is how a fixed defect keeps being described as open.
  const stale = [...KNOWN.keys()].filter((label) => !known.some((line) => line.startsWith(label + ':')));
  if (stale.length) {
    throw new Error(
      'onset-render: ' + stale.length + ' recorded click(s) no longer measurable — '
      + 'fixed, or no longer reached by the harness. Remove them from KNOWN:\n  ' + stale.join('\n  '),
    );
  }
  return { moduleUrl, rows, knownClicks: known, asserted: rows.filter((r) => !r.error).length * 5 };
}
