/**
 * The finder's CLAIMS, measured from real offline renders (unit 16 of
 * docs/synthesis-programme.md, v0.0.185). PARKED in tests/pending until the
 * Mac test bridge key is restored (fromClaude 13); then:
 *
 *   npm run build && .vibe/measure.sh local drive tests/sound-finder-render-drive.mjs
 *
 * tests/sound-finder-smoke.mjs holds the table's integrity; this holds what
 * the table SAYS. For every word and every tuned voice set: render the
 * starting voice at its defaults, apply the two moves a third of the way
 * (moveValue), render again, and measure the quantity the word's `why` names.
 * Every window is timed from the moment the note is played (held 1.2 s, the
 * render runs 8 s so a long release is read to its end):
 *
 *   bright / dark        spectral centroid over the held note, up / down
 *   plucky               sounding length (to -20 dB of the peak) shorter,
 *                        and the peak no later
 *   sustained            sounding length longer
 *   clean / gritty       share of the steady power OUTSIDE the strongest
 *                        partial, down / up
 *   warm / glassy        spectral centroid after the strike, down / up
 *   thick                spectral components (exp entropy) after the strike, up
 *   thin                 weight (power at or below the fundamental over the
 *                        power above it), down
 *   still / moving       how far the centroid travels while it sounds, in
 *                        octaves, down / up (still also holds below 0.02
 *                        octaves; moving must also reach it)
 *
 * Every claim must move its quantity by at least 5%, the same bar for every
 * row; a failure prints the before and after numbers.
 *
 * One row is broken ON PURPOSE inside this file (bright on the pad with its
 * moves reversed) and must be reported red, so a claim the measurement cannot
 * see would be caught rather than waved through.
 */
const PROBE = async (voicesUrl, finderUrl, registryUrl, matchUrl) => {
  const { VOICES } = await import(voicesUrl);
  const { SOUND_WORDS, moveValue } = await import(finderUrl);
  const { PARAM_REGISTRY } = await import(registryUrl);
  // v0.0.237: seeded, and read from the moment the note is PLAYED. Run for
  // the first time on 2026-10-23 (it had looked for a param-registry chunk
  // the build does not emit, so it could never start), the drive drew
  // unseeded — eight voices' random phases moved every comparison by chance.
  // Windows are timed from NOTE.when, not from a detected onset: the note is
  // held for NOTE.duration from when it is played whatever its attack, and
  // analyseSample's onset on a 2.4 s swell lands a second or more in (it
  // reads the first frame within 26 dB of the peak), so an onset-relative
  // "held note" on a pad was mostly its release. A pad that has barely
  // swelled when the note ends is what a 1.2 s note on that pad IS.
  const M = await import(matchUrl);
  const SR = 48000;
  const RENDER = 8;
  const NOTE = { when: 0.05, freq: 220, midi: 57, velocity: 0.9, duration: 1.2 };
  // A render that comes back SILENT, or with a non-finite sample, is the
  // renderer failing rather than the voice. It is rendered again and
  // counted; a second failure is an error, never a row measured on nothing.
  let rerenders = 0;
  const render = async (voice, patch, tries = 2) => {
    const ctx = new OfflineAudioContext(1, SR * RENDER, SR);
    const bus = ctx.createGain();
    bus.connect(ctx.destination);
    M.withSeededRandom(() => voice.play(ctx, bus, NOTE, patch));
    const raw = (await ctx.startRendering()).getChannelData(0);
    if (raw.some((x) => !Number.isFinite(x)) || !raw.some((x) => x !== 0)) {
      if (tries <= 1) throw new Error('sound-finder-render: a render came back silent or non-finite twice');
      rerenders += 1;
      return render(voice, patch, tries - 1);
    }
    // Every window below is measured from the moment the note is played. A
    // COPY: under node-web-audio-api the channel data is native memory that a
    // later render can reuse, and a view kept across the next render was read
    // back as a different signal.
    return raw.slice(Math.floor(NOTE.when * SR));
  };
  // ---- What each render is reduced to -------------------------------------
  // A radix-2 FFT, so the spectra can be AVERAGED over a whole window (the
  // first version took one 4096-sample frame — 85 ms — and called it "the
  // first 300 ms").
  const N = 4096;
  const HOP = N / 4;
  const HANN = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  const fftPower = (data, from) => {
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = (from + i >= 0 && from + i < data.length ? data[from + i] : 0) * HANN[i];
    for (let i = 1, j = 0; i < N; i++) {
      let bit = N >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= N; len <<= 1) {
      const ang = (-2 * Math.PI) / len;
      for (let i = 0; i < N; i += len) {
        for (let k = 0; k < len / 2; k++) {
          const wr = Math.cos(ang * k);
          const wi = Math.sin(ang * k);
          const ar = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
          const ai = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
          re[i + k + len / 2] = re[i + k] - ar; im[i + k + len / 2] = im[i + k] - ai;
          re[i + k] += ar; im[i + k] += ai;
        }
      }
    }
    const p = new Float64Array(N / 2);
    for (let k = 0; k < N / 2; k++) p[k] = re[k] * re[k] + im[k] * im[k];
    return p;
  };
  const BIN = SR / N;
  // Frames whose CENTRE lies in [fromSec, toSec), zero-padded at the edges.
  const frames = (data, fromSec, toSec) => {
    const out = [];
    for (let c = Math.floor(fromSec * SR); c < Math.min(data.length, Math.floor(toSec * SR)); c += HOP) out.push(fftPower(data, c - N / 2));
    return out;
  };
  const meanPower = (fr) => {
    const p = new Float64Array(N / 2);
    for (const f of fr) for (let k = 0; k < p.length; k++) p[k] += f[k] / fr.length;
    return p;
  };
  // Spectral centroid, Hz, of the averaged magnitude spectrum.
  const centroid = (p) => {
    let num = 0;
    let den = 0;
    for (let k = 1; k < p.length; k++) { const m = Math.sqrt(p[k]); num += k * BIN * m; den += m; }
    return den > 0 ? num / den : 0;
  };
  // Share of the power OUTSIDE the single strongest partial (its peak bin and
  // two either side, the Hann main lobe). One tone: near 0.
  const impurity = (p) => {
    let total = 0;
    for (let k = 1; k < p.length; k++) total += p[k];
    let best = 0;
    for (let k = 3; k < p.length - 2; k++) best = Math.max(best, p[k - 2] + p[k - 1] + p[k] + p[k + 1] + p[k + 2]);
    return total > 0 ? 1 - best / total : 0;
  };
  // How many bins carry the power: exp of the spectral entropy. One sine is a
  // handful; a stack, a fold, a detuned spread are many.
  const components = (p) => {
    let total = 0;
    for (let k = 1; k < p.length; k++) total += p[k];
    let h = 0;
    for (let k = 1; k < p.length; k++) { const q = p[k] / total; if (q > 0) h -= q * Math.log(q); }
    return total > 0 ? Math.exp(h) : 0;
  };
  // The WEIGHT of the sound: the power at or below the fundamental (under
  // 1.5 x the note played, so the fundamental's whole lobe and anything
  // beneath it) over the power above it. A ratio rather than a share, so a
  // near-sine whose bottom is 99.8% of it can still be read losing it.
  const weight = (p) => {
    let total = 0;
    let low = 0;
    for (let k = 1; k < p.length; k++) { total += p[k]; if (k * BIN < NOTE.freq * 1.5) low += p[k]; }
    return low / Math.max(total - low, 1e-30);
  };
  // How far the brightness TRAVELS while the note sounds: the spread, in
  // octaves, of the frame-by-frame centroid, each frame weighted by its
  // amplitude. A filter opening, a band sweeping, a gust walking the
  // brightness all move it; a swell that only gets louder does not, which is
  // why this is not a level measure (the first version read RMS wobble, and a
  // slow attack counted as "moving").
  const travel = (fr) => {
    const xs = fr.map((f) => {
      let t = 0;
      for (let k = 1; k < f.length; k++) t += f[k];
      return { w: Math.sqrt(t), c: Math.log2(Math.max(1, centroid(f))) };
    }).filter((x) => x.w > 0);
    const W = xs.reduce((acc, x) => acc + x.w, 0);
    if (!(W > 0)) return 0;
    const mean = xs.reduce((acc, x) => acc + x.w * x.c, 0) / W;
    return Math.sqrt(xs.reduce((acc, x) => acc + x.w * (x.c - mean) ** 2, 0) / W);
  };
  // A 5 ms loudness envelope: when the note peaks, and how long it SOUNDS —
  // from the note's start to the last moment within 20 dB of its peak, which
  // is where a short decay, a low sustain and a quick release all show.
  const envelope = (data) => {
    const hop = Math.floor(SR / 200);
    const env = [];
    for (let i = 0; i + hop <= data.length; i += hop) {
      let s = 0;
      for (let j = i; j < i + hop; j++) s += data[j] * data[j];
      env.push(Math.sqrt(s / hop));
    }
    let peak = 0;
    let at = 0;
    env.forEach((v, i) => { if (v > peak) { peak = v; at = i; } });
    let last = at;
    env.forEach((v, i) => { if (v >= peak * 0.1) last = i; });
    return { peakAt: at / 200, length: (last + 1) / 200, truncated: last >= env.length - 2 };
  };
  // The note is held for NOTE.duration after it is played.
  const HELD = NOTE.duration;
  const features = (data) => {
    const e = envelope(data);
    const steadyP = meanPower(frames(data, 0.2, HELD));
    return {
      noteCentroid: centroid(meanPower(frames(data, 0, HELD))),
      steadyCentroid: centroid(steadyP),
      impurity: impurity(steadyP),
      components: components(steadyP),
      weight: weight(steadyP),
      travel: travel(frames(data, 0, Math.max(0.1, e.length))),
      peakAt: e.peakAt,
      length: e.length,
      truncated: e.truncated,
    };
  };
  // Every claim is a quantity moving the way the word says, by at least 5%:
  // less than that is a move nobody would notice, and the same bar for every row.
  const BY = 0.05;
  const STILL = 0.02;
  const upBy = (q) => (a, b) => ({ q, before: a[q], after: b[q], holds: b[q] > a[q] * (1 + BY) });
  const downBy = (q) => (a, b) => ({ q, before: a[q], after: b[q], holds: b[q] < a[q] * (1 - BY) });
  const MEASURE = {
    // Top end over the whole held note.
    bright: upBy('noteCentroid'),
    dark: downBy('noteCentroid'),
    // Falls away sooner, and gets to its peak no later (10 ms, two envelope steps).
    plucky: (a, b) => ({ ...downBy('length')(a, b), holds: downBy('length')(a, b).holds && b.peakAt <= a.peakAt + 0.01, peakAt: [a.peakAt, b.peakAt] }),
    // Holds and fades slowly: sounds for longer.
    sustained: upBy('length'),
    clean: downBy('impurity'),
    gritty: upBy('impurity'),
    // Tone colour once the strike has passed.
    warm: downBy('steadyCentroid'),
    glassy: upBy('steadyCentroid'),
    // Thick: more sound at once — more of the spectrum carrying power.
    thick: upBy('components'),
    // Thin: the bottom taken away. ("One voice, in tune" is clean's claim, and
    // measured there; a count of components cannot read thin, because taking
    // a dominant fundamental away SPREADS what is left across more bins.)
    thin: downBy('weight'),
    // Still: travels less, or already travels less than STILL octaves — a
    // brightness that wobbles by under a quarter of a semitone has nothing
    // left to take away. Moving: travels more, and by more than that.
    still: (a, b) => ({ ...downBy('travel')(a, b), holds: downBy('travel')(a, b).holds || b.travel < STILL }),
    moving: (a, b) => ({ ...upBy('travel')(a, b), holds: upBy('travel')(a, b).holds && b.travel >= STILL }),
  };
  const rows = [];
  for (const entry of SOUND_WORDS) {
    for (const [set, spec] of Object.entries(entry.sets)) {
      const voice = VOICES[set][spec.voice];
      const base = JSON.parse(JSON.stringify(voice.defaults));
      const moved = JSON.parse(JSON.stringify(voice.defaults));
      const moves = (entry.word === 'bright' && set === 'pad')
        ? spec.moves.map((m) => ({ ...m, direction: m.direction === 'up' ? 'down' : 'up' })) // broken on purpose
        : spec.moves;
      for (const m of moves) {
        const [section, key] = m.field.split('.');
        const row = PARAM_REGISTRY[`patch.${m.field}`];
        if (!row || row.kind !== 'number') continue;
        if (!moved[section]) moved[section] = {};
        moved[section][key] = moveValue(moved[section][key], m.direction, row.domain);
      }
      const a = await render(voice, base);
      const b = await render(voice, moved);
      const fa = features(a);
      const fb = features(b);
      const m = MEASURE[entry.word](fa, fb);
      rows.push({ word: entry.word, set, voice: spec.voice, holds: m.holds, quantity: m.q, before: m.before, after: m.after, peakAt: m.peakAt, truncated: fa.truncated || fb.truncated, brokenOnPurpose: entry.word === 'bright' && set === 'pad' });
    }
  }
  return { rows, rerenders };
};

export default async function drive(page) {
  const urls = await page.evaluate(async () => {
    const html = await (await fetch('/')).text();
    const entry = html.match(/\/_astro\/index\.astro[^"']+\.js/);
    const js = entry ? await (await fetch(entry[0])).text() : '';
    const find = (name) => {
      const direct = html.match(new RegExp(`/_astro/${name}\\.[A-Za-z0-9_-]+\\.js`));
      if (direct) return direct[0];
      const nested = js.match(new RegExp(`${name}\\.[A-Za-z0-9_-]+\\.js`));
      return nested ? `/_astro/${nested[0]}` : null;
    };
    // The registry is bundled into the engine chunk, which re-exports it.
    return { voices: find('engine-voices'), finder: find('sound-finder'), registry: find('param-registry') || find('ambient-engine'), match: find('sample-match') };
  });
  if (!urls.voices || !urls.finder || !urls.registry || !urls.match) throw new Error(`sound-finder-render: module urls missing ${JSON.stringify(urls)}`);
  const { rows, rerenders } = await page.evaluate(
    ([fn, u]) => new Function(`return (${fn})`)()(u.voices, u.finder, u.registry, u.match),
    [PROBE.toString(), urls],
  );
  const broken = rows.filter((r) => r.brokenOnPurpose);
  const failed = rows.filter((r) => !r.holds && !r.brokenOnPurpose);
  const num = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toPrecision(3));
  const say = (r) => `${r.word} on ${r.set} (${r.voice}): ${r.quantity} ${num(r.before)} -> ${num(r.after)}`
    + (r.peakAt ? `, peak at ${r.peakAt[0]} -> ${r.peakAt[1]} s` : '') + (r.truncated ? ' (the render ended while it still sounded)' : '');
  const problems = failed.map((r) => `${say(r)}: the moves did not make it ${r.word}`);
  if (broken.some((r) => r.holds)) problems.push(`the row broken on purpose passed — the measurement does not bite: ${broken.map(say).join('; ')}`);
  if (problems.length) throw new Error('sound-finder-render: ' + problems.join('\n  '));
  return { rows: rows.length, asserted: rows.length, rerenders, caughtOnPurpose: broken.map(say), measured: rows.filter((r) => !r.brokenOnPurpose).map(say) };
}
