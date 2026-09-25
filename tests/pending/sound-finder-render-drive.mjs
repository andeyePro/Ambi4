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
 * (moveValue), render again, and measure the quantity the word names:
 *
 *   bright / dark        spectral centroid of the first 300 ms, up / down
 *   plucky / sustained   time from onset to peak, shorter / longer,
 *                        and RMS at one second, lower / higher
 *   clean / gritty       spectral flatness, lower / higher
 *   warm / glassy        centroid, down / up
 *   thick / thin         RMS of the steady state, up / down
 *   still / moving       RMS modulation depth over the note, down / up
 *
 * One row is broken ON PURPOSE inside this file (bright on the pad with its
 * moves reversed) and must be reported red, so a claim the measurement cannot
 * see would be caught rather than waved through.
 */
const PROBE = async (voicesUrl, finderUrl, registryUrl) => {
  const { VOICES } = await import(voicesUrl);
  const { SOUND_WORDS, moveValue } = await import(finderUrl);
  const { PARAM_REGISTRY } = await import(registryUrl);
  const SR = 48000;
  const NOTE = { when: 0.05, freq: 220, midi: 57, velocity: 0.9, duration: 1.2 };
  const render = async (voice, patch) => {
    const ctx = new OfflineAudioContext(1, SR * 2, SR);
    const bus = ctx.createGain();
    bus.connect(ctx.destination);
    voice.play(ctx, bus, NOTE, patch);
    return (await ctx.startRendering()).getChannelData(0);
  };
  const spectrum = (data, fromSec, toSec) => {
    const from = Math.floor(fromSec * SR);
    const to = Math.min(Math.floor(toSec * SR), data.length);
    const n = 4096;
    const win = Math.min(n, to - from);
    const mag = new Float64Array(n / 2);
    for (let k = 0; k < n / 2; k++) {
      let sr = 0;
      let si = 0;
      const w = (2 * Math.PI * k) / n;
      for (let i = 0; i < win; i++) {
        const x = data[from + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / win));
        sr += x * Math.cos(w * i);
        si -= x * Math.sin(w * i);
      }
      mag[k] = Math.hypot(sr, si);
    }
    return { mag, binHz: SR / n };
  };
  const centroid = ({ mag, binHz }) => {
    let num = 0;
    let den = 0;
    for (let k = 1; k < mag.length; k++) { num += k * binHz * mag[k]; den += mag[k]; }
    return den > 0 ? num / den : 0;
  };
  const flatness = ({ mag }) => {
    let logSum = 0;
    let sum = 0;
    let n = 0;
    for (let k = 1; k < mag.length; k++) { const v = mag[k] + 1e-12; logSum += Math.log(v); sum += v; n += 1; }
    return Math.exp(logSum / n) / (sum / n);
  };
  const rms = (data, fromSec, toSec) => {
    const from = Math.floor(fromSec * SR);
    const to = Math.min(Math.floor(toSec * SR), data.length);
    let acc = 0;
    for (let i = from; i < to; i++) acc += data[i] * data[i];
    return Math.sqrt(acc / Math.max(1, to - from));
  };
  const timeToPeak = (data) => {
    let peak = 0;
    let at = 0;
    for (let i = 0; i < data.length; i++) if (Math.abs(data[i]) > peak) { peak = Math.abs(data[i]); at = i; }
    return at / SR - NOTE.when;
  };
  const modulation = (data) => {
    const blocks = [];
    const block = Math.floor(SR / 20);
    for (let i = Math.floor(0.2 * SR); i + block <= Math.floor(1.2 * SR); i += block) blocks.push(rms(data, i / SR, (i + block) / SR));
    const mean = blocks.reduce((a, b) => a + b, 0) / blocks.length;
    const dev = Math.sqrt(blocks.reduce((a, b) => a + (b - mean) ** 2, 0) / blocks.length);
    return mean > 0 ? dev / mean : 0;
  };
  const MEASURE = {
    bright: (a, b) => centroid(spectrum(b, 0.05, 0.35)) > centroid(spectrum(a, 0.05, 0.35)) * 1.05,
    dark: (a, b) => centroid(spectrum(b, 0.05, 0.35)) < centroid(spectrum(a, 0.05, 0.35)) * 0.95,
    plucky: (a, b) => timeToPeak(b) <= timeToPeak(a) && rms(b, 1.0, 1.1) < rms(a, 1.0, 1.1),
    sustained: (a, b) => rms(b, 1.0, 1.1) > rms(a, 1.0, 1.1),
    clean: (a, b) => flatness(spectrum(b, 0.2, 0.5)) < flatness(spectrum(a, 0.2, 0.5)),
    gritty: (a, b) => flatness(spectrum(b, 0.2, 0.5)) > flatness(spectrum(a, 0.2, 0.5)),
    warm: (a, b) => centroid(spectrum(b, 0.2, 0.5)) < centroid(spectrum(a, 0.2, 0.5)),
    glassy: (a, b) => centroid(spectrum(b, 0.2, 0.5)) > centroid(spectrum(a, 0.2, 0.5)),
    thick: (a, b) => rms(b, 0.3, 0.8) > rms(a, 0.3, 0.8),
    thin: (a, b) => rms(b, 0.3, 0.8) < rms(a, 0.3, 0.8),
    still: (a, b) => modulation(b) <= modulation(a),
    moving: (a, b) => modulation(b) > modulation(a),
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
      rows.push({ word: entry.word, set, voice: spec.voice, holds: MEASURE[entry.word](a, b), brokenOnPurpose: entry.word === 'bright' && set === 'pad' });
    }
  }
  return rows;
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
    return { voices: find('engine-voices'), finder: find('sound-finder'), registry: find('param-registry') };
  });
  if (!urls.voices || !urls.finder || !urls.registry) throw new Error(`sound-finder-render: module urls missing ${JSON.stringify(urls)}`);
  const rows = await page.evaluate(
    ([fn, u]) => new Function(`return (${fn})`)()(u.voices, u.finder, u.registry),
    [PROBE.toString(), urls],
  );
  const broken = rows.filter((r) => r.brokenOnPurpose);
  const failed = rows.filter((r) => !r.holds && !r.brokenOnPurpose);
  const problems = failed.map((r) => `${r.word} on ${r.set} (${r.voice}): the moves did not make it ${r.word}`);
  if (broken.some((r) => r.holds)) problems.push('the row broken on purpose passed — the measurement does not bite');
  if (problems.length) throw new Error('sound-finder-render: ' + problems.join('\n  '));
  return { rows: rows.length, asserted: rows.length };
}
