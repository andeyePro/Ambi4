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
      });
    } catch (err) {
      out.push({ track, id, error: String(err && err.message ? err.message : err) });
    }
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
