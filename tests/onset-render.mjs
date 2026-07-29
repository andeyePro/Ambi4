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

  for (const [track, id] of targets) {
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
      voice.play(ctx, bus, { time: 0.25, freq: 110, midi: 45, velocity: 0.9, duration: 1 }, null);
      const buffer = await ctx.startRendering();
      const data = buffer.getChannelData(0);

      const at = (s) => Math.floor(s * SR);
      const jump = (from, to) => {
        let worst = 0;
        let where = 0;
        for (let i = Math.max(1, from); i < Math.min(to, data.length); i++) {
          const d = Math.abs(data[i] - data[i - 1]);
          if (d > worst) { worst = d; where = i; }
        }
        return { worst, at: +(where / SR).toFixed(4) };
      };
      // The onset window starts a hair BEFORE the scheduled time: a step at
      // exactly t0 is the one being hunted.
      const onset = jump(at(0.245), at(0.30));
      // The body: well past any attack, before any release.
      const body = jump(at(0.45), at(0.95));
      const peak = data.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
      // A FAST LINE, which is where the owner heard it: a second note landing
      // 120 ms after the first, so the first note's release is still ringing
      // when the second starts. One isolated note cannot show a collision.
      let fast = null;
      try {
        const ctx2 = new OfflineAudioContext(1, SR * 2, SR);
        const bus2 = ctx2.createGain();
        bus2.gain.value = 1;
        bus2.connect(ctx2.destination);
        voice.play(ctx2, bus2, { time: 0.25, freq: 110, midi: 45, velocity: 0.9, duration: 0.12 }, null);
        voice.play(ctx2, bus2, { time: 0.37, freq: 146.83, midi: 50, velocity: 0.9, duration: 0.12 }, null);
        const b2 = await ctx2.startRendering();
        const d2 = b2.getChannelData(0);
        const at2 = (sec) => Math.floor(sec * SR);
        let worst = 0;
        let where = 0;
        for (let i = at2(0.365); i < at2(0.40); i++) {
          const d = Math.abs(d2[i] - d2[i - 1]);
          if (d > worst) { worst = d; where = i; }
        }
        let bodyWorst = 0;
        for (let i = at2(0.30); i < at2(0.35); i++) {
          const d = Math.abs(d2[i] - d2[i - 1]);
          if (d > bodyWorst) bodyWorst = d;
        }
        fast = {
          secondOnsetJump: +worst.toFixed(5),
          at: +(where / SR).toFixed(4),
          firstNoteBodyJump: +bodyWorst.toFixed(5),
          ratio: bodyWorst > 0 ? +(worst / bodyWorst).toFixed(2) : null,
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
        const h = voice.play(ctx3, bus3, { time: 0.25, freq: 110, midi: 45, velocity: 0.9, duration: 1.2 }, null);
        const cancellable = h && typeof h.cancel === 'function';
        if (cancellable) h.cancel(0.6);
        const b3 = await ctx3.startRendering();
        const d3 = b3.getChannelData(0);
        const at3 = (sec) => Math.floor(sec * SR);
        let worst = 0;
        let where = 0;
        for (let i = at3(0.595); i < at3(0.65); i++) {
          const d = Math.abs(d3[i] - d3[i - 1]);
          if (d > worst) { worst = d; where = i; }
        }
        let bodyWorst = 0;
        for (let i = at3(0.45); i < at3(0.59); i++) {
          const d = Math.abs(d3[i] - d3[i - 1]);
          if (d > bodyWorst) bodyWorst = d;
        }
        cut = cancellable ? {
          cancelJump: +worst.toFixed(5),
          at: +(where / SR).toFixed(4),
          bodyJump: +bodyWorst.toFixed(5),
          ratio: bodyWorst > 0 ? +(worst / bodyWorst).toFixed(2) : null,
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
        const h1 = voice.play(ctx4, bus4, { time: 0.25, freq: 110, midi: 45, velocity: 0.9, duration: 0.2 }, null);
        const n2 = { time: 0.37, freq: 146.83, midi: 50, velocity: 0.9, duration: 0.2,
          legatoFrom: { freq: 110, handle: h1, glide: 0.05 } };
        const h2 = voice.play(ctx4, bus4, n2, null);
        const took2 = !!(h2 && h2.legato === true);
        const h3ref = took2 ? h1 : h2;
        const n3 = { time: 0.49, freq: 110, midi: 45, velocity: 0.9, duration: 0.3,
          legatoFrom: { freq: 146.83, handle: h3ref, glide: 0.05 } };
        const h3 = voice.play(ctx4, bus4, n3, null);
        const took3 = !!(h3 && h3.legato === true);
        const b4 = await ctx4.startRendering();
        const d4 = b4.getChannelData(0);
        const at4 = (sec) => Math.floor(sec * SR);
        const worstIn = (from, to) => {
          let w = 0;
          for (let i = at4(from); i < at4(to); i++) {
            const d = Math.abs(d4[i] - d4[i - 1]);
            if (d > w) w = d;
          }
          return w;
        };
        const hand2 = worstIn(0.365, 0.44);
        const hand3 = worstIn(0.485, 0.56);
        const bodyW = worstIn(0.28, 0.36);
        slur = {
          took: [took2, took3],
          handoverJump2: +hand2.toFixed(5),
          handoverJump3: +hand3.toFixed(5),
          bodyJump: +bodyW.toFixed(5),
          ratio: bodyW > 0 ? +(Math.max(hand2, hand3) / bodyW).toFixed(2) : null,
        };
      } catch (err) {
        slur = { error: String(err && err.message ? err.message : err) };
      }

      out.push({
        track,
        id,
        peak: +peak.toFixed(4),
        onsetJump: +onset.worst.toFixed(5),
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
    VOICES.bass.fingered.play(ctx5, bus5, { time: 0.25, freq: 110, midi: 45, velocity: 0.9, duration: 0.6 }, null);
    VOICES.pad.warm.play(ctx5, bus5, { time: 0.25, freq: 220, midi: 57, velocity: 0.8, duration: 1.2 }, null);
    if (VOICES.percussion && VOICES.percussion.soft) {
      VOICES.percussion.soft.play(ctx5, bus5,
        { time: 0.25, freq: 80, midi: 36, velocity: 0.9, duration: 0.3, kind: 'low', lane: 'low' }, null);
    }
    const b5 = await ctx5.startRendering();
    const d5 = b5.getChannelData(0);
    const at5 = (sec) => Math.floor(sec * SR);
    let worst = 0;
    for (let i = at5(0.245); i < at5(0.30); i++) {
      const d = Math.abs(d5[i] - d5[i - 1]);
      if (d > worst) worst = d;
    }
    let bodyWorst = 0;
    for (let i = at5(0.45); i < at5(0.75); i++) {
      const d = Math.abs(d5[i] - d5[i - 1]);
      if (d > bodyWorst) bodyWorst = d;
    }
    out.push({ track: 'sum', id: 'fingered+warm+soft',
      onsetJump: +worst.toFixed(5), bodyJump: +bodyWorst.toFixed(5),
      ratio: bodyWorst > 0 ? +(worst / bodyWorst).toFixed(2) : null });
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
  const targets = [['bass', 'fingered'], ['bass', 'upright'], ['bass', 'sub'], ['bass', 'sawbass']];
  const rows = await page.evaluate(
    ([fn, url, list]) => new Function(`return (${fn})`)()(url, list),
    [PROBE.toString(), moduleUrl, targets],
  );

  const failed = rows.filter((r) => r.error);
  if (failed.length === rows.length) {
    throw new Error('onset-render: every voice failed\n' + failed.map((r) => `  ${r.track}/${r.id}: ${r.error}`).join('\n'));
  }
  return { moduleUrl, rows };
}
