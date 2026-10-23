/**
 * Match a sample, measured on the SHIPPED voices (v0.0.229). PARKED in
 * tests/pending until the Mac test bridge key is restored (fromClaude 13);
 * then:
 *
 *   npm run build && .vibe/measure.sh local drive tests/pending/sample-match-drive.mjs
 *
 * tests/sample-match-smoke.mjs proves the analysis and the search in Node
 * against a stand-in synth. This proves the claim on the real thing: a note
 * rendered from a stock voice with its dials moved — at 48 kHz, where the
 * match renders at 24 kHz, so the ruler is not just comparing a file with
 * itself — is handed to the matcher as a "sample", and the matcher must name
 * that voice and end closer than the voice as shipped.
 *
 * One case is a sanity floor rather than a search: a voice's own default note
 * must match itself at 90% or better, or the ruler cannot tell anything apart.
 */
const PROBE = async (voicesUrl, matchUrl, engineUrl) => {
  const { VOICES } = await import(voicesUrl);
  const M = await import(matchUrl);
  const { PARAM_REGISTRY } = await import(engineUrl);
  const renderAt = async (SR, set, id, patch, note, seconds = M.MAX_SECONDS) => {
    const ctx = new OfflineAudioContext(1, Math.round(SR * seconds), SR);
    M.withSeededRandom(() => VOICES[set][id].play(ctx, ctx.destination, note, patch));
    return { samples: (await ctx.startRendering()).getChannelData(0), sampleRate: SR };
  };
  const exposes = (set, id, field) => {
    const v = VOICES[set][id];
    const [section, key] = field.split('.');
    const spec = v.controls ? v.controls[section] : undefined;
    if (spec === false) return false;
    if (Array.isArray(spec) && !spec.includes(key)) return false;
    return !!(v.defaults && v.defaults[section] && key in v.defaults[section]);
  };
  const CASES = [
    { set: 'melody', id: 'bell', moves: { 'fm.depth': 1.8, 'adsr.release': 0.6 }, freq: 392 },
    { set: 'pad', id: 'warm', moves: { 'filter.cutoff': 900, 'adsr.attack': 0.6 }, freq: 220 },
    { set: 'bass', id: 'fingered', moves: {}, freq: 82.41, self: true },
    { set: 'arp', id: 'marimba', moves: { 'modal.damping': 2 }, freq: 523.25 },
    // A one-second file: the match renders only what the file can be compared on.
    { set: 'melody', id: 'pluck', moves: { 'filter.envAmount': 0.4 }, freq: 293.66, cut: 1 },
  ];
  const rows = [];
  for (const c of CASES) {
    const patch = JSON.parse(JSON.stringify(VOICES[c.set][c.id].defaults));
    for (const [field, value] of Object.entries(c.moves)) {
      const [s, k] = field.split('.');
      patch[s][k] = value;
    }
    const midi = Math.round(69 + 12 * Math.log2(c.freq / 440));
    const sample = await renderAt(48000, c.set, c.id, patch, { when: 0.1, freq: c.freq, midi, velocity: 0.8, duration: 0.8 });
    const samples = c.cut ? sample.samples.slice(0, Math.round(c.cut * sample.sampleRate)) : sample.samples;
    const target = M.analyseSample(samples, sample.sampleRate);
    const candidates = Object.entries(VOICES[c.set]).map(([id, v]) => ({
      id, label: v.label, defaults: JSON.parse(JSON.stringify(v.defaults)),
      fields: M.searchFieldsFor(v.defaults, PARAM_REGISTRY, (f) => exposes(c.set, id, f)),
    }));
    const t0 = performance.now();
    const result = await M.matchSample(target, {
      candidates, budget: 600, render: (id, p, note, seconds) => renderAt(24000, c.set, id, p, note, seconds),
    });
    rows.push({
      case: `${c.set}/${c.id}`,
      heard: target.note && target.note.name,
      best: result.best.id,
      similarity: result.best.similarity,
      start: M.similarity(result.best.start),
      ranked: result.ranked.map((r) => `${r.id} ${r.similarity}%`).join(', '),
      ms: Math.round(performance.now() - t0),
      self: !!c.self,
      want: c.id,
      line: M.describeMatch(target, result),
    });
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
    return { voices: find('engine-voices'), match: find('sample-match'), engine: find('ambient-engine') };
  });
  if (!urls.voices || !urls.match || !urls.engine) throw new Error(`sample-match-drive: module urls missing ${JSON.stringify(urls)}`);
  const rows = await page.evaluate(
    ([fn, u]) => new Function(`return (${fn})`)()(u.voices, u.match, u.engine),
    [PROBE.toString(), urls],
  );
  const problems = [];
  for (const r of rows) {
    if (r.best !== r.want) problems.push(`${r.case}: matched ${r.best} (${r.ranked})`);
    if (r.self && r.similarity < 90) problems.push(`${r.case}: a voice's own note matched itself at only ${r.similarity}%`);
    if (!r.self && !(r.similarity > r.start)) problems.push(`${r.case}: the search did not improve on the default (${r.start}% -> ${r.similarity}%)`);
  }
  if (problems.length) throw new Error('sample-match-drive: ' + problems.join('\n  ') + '\n' + JSON.stringify(rows, null, 1));
  return { rows };
}
