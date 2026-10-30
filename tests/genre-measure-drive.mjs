/**
 * Every genre, measured — not listened to. Nobody in the container can hear
 * a note, so this plays each stock genre in a real headless Chromium with the
 * engine's events tapped and the OUTPUT tapped by an AudioWorklet, and turns
 * forty-eight bars into numbers: notes per bar per track, bars with nothing
 * sounding, pitches against the scale the draw chose, how closely the chords
 * follow the genre's own loop, and RMS per bar off the master.
 *
 *   npm run build && .vibe/measure.sh local drive tests/genre-measure-drive.mjs
 *
 * Every genre is run TWICE, on two fixed seeds, through the same compact
 * share link a listener's own link uses (`#p=` with an origin of
 * { kind: 'genre', id, seed }) — the one door that reaches a genre that is
 * off the public menu and pins its draw, so a run is reproducible bar for bar.
 * Runs go several pages at a time; each page has its own engine and its own
 * AudioContext.
 *
 * The drive FAILS on structural faults — a console error, a genre that would
 * not pin, a track switched ON that never plays a note in 48 bars, an
 * off-scale note on a track whose Dissonance cannot reach above zero, a
 * chord loop the engine kept (harmony.seed survived) yet never visits — and
 * returns everything else as numbers, so the taste questions (too sparse, too
 * loud, too quiet for too long) are reported with evidence for the owner to
 * rule on, never decided here. (`findings` in the result carries both kinds,
 * each tagged `fault` or `ruling`.)
 */

const BARS = 48;
// Five pages at once, started a few seconds apart: six booting together
// starved the Mac's little static server (ERR_SOCKET_NOT_CONNECTED) and three
// engines took over half a minute to appear.
const CONCURRENCY = 5;
const STAGGER_MS = 5000;
const SEEDS = [1001, 20260];
const GENRES = [
  'acid-jazz', 'ambient', 'bossa', 'cinematic', 'deep-house', 'downtempo',
  'lofi-beats', 'minimalism', 'new-age', 'soul-groove', 'synthwave', 'techno-tools',
];

const SCALES = {
  majorPentatonic: [0, 2, 4, 7, 9],
  minorPentatonic: [0, 3, 5, 7, 10],
  ionian: [0, 2, 4, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  wholeTone: [0, 2, 4, 6, 8, 10],
  blues: [0, 3, 5, 6, 7, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  melodicMinor: [0, 2, 3, 5, 7, 9, 11],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  diminished: [0, 2, 3, 5, 6, 8, 9, 11],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};
const NOTE_PC = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };

const shareLink = (base, slug, seed) => {
  const payload = { o: { kind: 'genre', id: slug, seed }, d: {}, v: 1 };
  const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${base}#p=${b64}`;
};

/** The in-page half: tap the engine and the output, play BARS bars, return the raw record. */
async function measureOne(page, { slug, seed, url }) {
  const errors = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err && err.message ? err.message : err}`));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`console: ${msg.text()}`); });

  await page.goto('about:blank');
  await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForSelector('#generator-app:not([hidden])', { timeout: 20000 }).catch(() => {});
  // (Playwright's options are the THIRD argument; passed second they are the
  // page function's `arg` and the default 30 s applies silently.)
  await page.waitForFunction(() => !!window.__ambi4Engine?.getParams, undefined, { timeout: 60000 });
  await page.click('#consent-slot button:has-text("No thanks")').catch(() => {});
  await page.waitForTimeout(300);

  const pinned = await page.evaluate(() => window.__ambi4Engine.getParams().genre);
  if (pinned !== slug) throw new Error(`${slug}/${seed}: the share link did not pin the genre at the engine (got ${JSON.stringify(pinned)})`);

  await page.evaluate((bars) => {
    const engine = window.__ambi4Engine;
    const rec = { bars: [], notes: [], chords: [], rms: [], tap: 'none' };
    window.__gm = rec;
    const snapshot = () => {
      const p = engine.getParams();
      const tracks = {};
      for (const [id, t] of Object.entries(p.tracks || {})) {
        tracks[id] = { state: t.state, voice: t.voice, level: t.level, density: t.density, dissonance: t.dissonance, passingNotes: t.passingNotes };
      }
      return { mode: p.mode, root: p.root, bpm: p.bpm, timeSignature: p.timeSignature, structure: p.structure,
        harmony: p.harmony, complexity: p.complexity, repetition: p.repetition, tracks };
    };
    engine.on('bar', (e) => { if (rec.bars.length <= bars) rec.bars.push({ bar: e.bar, time: e.time, beats: e.beatsPerBar, params: snapshot() }); });
    engine.on('note', (e) => { rec.notes.push({ track: e.track, midi: e.midi, time: e.time, duration: e.duration, velocity: e.velocity, role: e.role, lane: e.lane, kind: e.kind, source: e.source }); });
    engine.on('chord', (e) => { rec.chords.push({ name: e.name, midis: e.midis, bar: e.bar, time: e.time, beat: e.beat }); });
  }, BARS);

  await page.click('#toggle-play');
  await page.waitForFunction(() => !!window.__ambi4Engine.getOutputAnalyser?.(), undefined, { timeout: 20000 });

  // The output tap: RMS per 2048-sample window, stamped with the context
  // clock, from the audio thread — a main-thread rAF meter is throttled the
  // moment a page is not the focused one, and several run at once here.
  await page.evaluate(async () => {
    const engine = window.__ambi4Engine;
    const a = engine.getOutputAnalyser();
    const ctx = a.context;
    const rec = window.__gm;
    const sink = ctx.createGain();
    sink.gain.value = 0;
    sink.connect(ctx.destination);
    try {
      const code = `class RmsTap extends AudioWorkletProcessor {
        constructor() { super(); this.sum = 0; this.n = 0; this.t0 = currentTime; }
        process(inputs) {
          const ch = inputs[0];
          if (ch && ch.length) {
            const L = ch[0], R = ch[1] || ch[0];
            for (let i = 0; i < L.length; i++) { const v = (L[i] + R[i]) / 2; this.sum += v * v; }
            this.n += L.length;
          } else { this.n += 128; }
          if (this.n >= 2048) {
            this.port.postMessage({ t: this.t0, rms: Math.sqrt(this.sum / this.n) });
            this.sum = 0; this.n = 0; this.t0 = currentTime;
          }
          return true;
        }
      }
      registerProcessor('ambi4-rms-tap', RmsTap);`;
      const blobUrl = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
      await ctx.audioWorklet.addModule(blobUrl);
      const node = new AudioWorkletNode(ctx, 'ambi4-rms-tap', { numberOfInputs: 1, numberOfOutputs: 1 });
      node.port.onmessage = (m) => rec.rms.push(m.data);
      a.connect(node);
      node.connect(sink);
      rec.tap = 'worklet';
    } catch (err) {
      const spn = ctx.createScriptProcessor(2048, 2, 1);
      spn.onaudioprocess = (ev) => {
        const L = ev.inputBuffer.getChannelData(0), R = ev.inputBuffer.numberOfChannels > 1 ? ev.inputBuffer.getChannelData(1) : L;
        let s = 0;
        for (let i = 0; i < L.length; i++) { const v = (L[i] + R[i]) / 2; s += v * v; }
        rec.rms.push({ t: ev.playbackTime, rms: Math.sqrt(s / L.length) });
      };
      a.connect(spn);
      spn.connect(sink);
      rec.tap = 'scriptprocessor:' + (err && err.message);
    }
  });

  // Wait for BARS+1 bar events (the last one dates the end of bar BARS) and
  // for the clock to pass it, so the tap has seen every bar in full.
  const first = await page.evaluate(() => window.__ambi4Engine.getParams());
  const beats = ({ '3/4': 3, '4/4': 4, '5/4': 5, '6/8': 3, '7/8': 3.5 })[first.timeSignature] || 4;
  const barSec = beats * 60 / Math.max(20, first.bpm || 90);
  const budget = Math.round((BARS + 2) * barSec * 1000 * 1.25) + 40000;
  const done = await page.waitForFunction((bars) => {
    const rec = window.__gm;
    if (rec.bars.length <= bars) return false;
    const end = rec.bars[bars].time;
    const a = window.__ambi4Engine.getOutputAnalyser();
    return a && a.context.currentTime > end + 0.2;
  }, BARS, { timeout: budget, polling: 500 }).then(() => true).catch(() => false);
  const raw = await page.evaluate(() => {
    const rec = window.__gm;
    const a = window.__ambi4Engine.getOutputAnalyser();
    return { bars: rec.bars, notes: rec.notes, chords: rec.chords, rms: rec.rms, tap: rec.tap, now: a ? a.context.currentTime : null, running: window.__ambi4Engine.running };
  });
  await page.click('#toggle-play').catch(() => {});
  await page.waitForTimeout(200);
  return { slug, seed, done, budget, raw, errors };
}

const dB = (x) => (x > 0 ? +(20 * Math.log10(x)).toFixed(1) : -120);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const longestRun = (flags) => { let best = 0, cur = 0; for (const f of flags) { cur = f ? cur + 1 : 0; best = Math.max(best, cur); } return best; };

/** Turn one run's raw record into numbers and findings. */
function analyse(run) {
  const { slug, seed, raw } = run;
  const bars = raw.bars.slice(0, BARS + 1);
  const findings = [];
  const out = { genre: slug, seed, tap: raw.tap, barsSeen: raw.bars.length, done: run.done };
  if (!bars.length) { findings.push({ kind: 'fault', what: 'no bar events at all' }); return { ...out, findings }; }
  const p0 = bars[0].params;
  Object.assign(out, { bpm: p0.bpm, timeSignature: p0.timeSignature, mode: p0.mode, root: p0.root, structure: p0.structure,
    rhythm: p0.harmony?.rhythm, complexity: p0.complexity, repetition: p0.repetition });
  const seedLoop = Array.isArray(p0.harmony?.seed) ? p0.harmony.seed.map((s) => s.degree) : null;
  out.seedLoop = seedLoop;
  const n = Math.min(BARS, bars.length - 1);
  out.barsMeasured = n;
  if (n < BARS) findings.push({ kind: 'fault', what: `only ${n} of ${BARS} bars measured within the budget (${run.budget} ms)` });
  const barIndex = (t) => { for (let i = 0; i < n; i++) if (t >= bars[i].time - 0.02 && t < bars[i + 1].time - 0.02) return i; return -1; };
  const scalePcs = (mode, root) => new Set((SCALES[mode] || []).map((s) => (s + (NOTE_PC[root] ?? 0)) % 12));

  // Notes per bar, per track.
  const trackIds = Object.keys(p0.tracks);
  const perTrack = {};
  for (const id of trackIds) perTrack[id] = { counts: new Array(n).fill(0), outside: [], roles: {}, states: {} };
  for (const bar of bars.slice(0, n)) for (const [id, t] of Object.entries(bar.params.tracks)) {
    if (!perTrack[id]) perTrack[id] = { counts: new Array(n).fill(0), outside: [], roles: {}, states: {} };
    perTrack[id].states[t.state] = (perTrack[id].states[t.state] || 0) + 1;
  }
  const anyNote = new Array(n).fill(false);
  for (const note of raw.notes) {
    const i = barIndex(note.time);
    if (i < 0) continue;
    const pt = perTrack[note.track] || (perTrack[note.track] = { counts: new Array(n).fill(0), outside: [], roles: {}, states: {} });
    pt.counts[i] += 1;
    anyNote[i] = true;
    if (Number.isFinite(note.midi) && note.role) {
      pt.roles[note.role] = (pt.roles[note.role] || 0) + 1;
      const bp = bars[i].params;
      const inScale = scalePcs(bp.mode, bp.root).has(((Math.round(note.midi) % 12) + 12) % 12);
      if (!inScale) pt.outside.push({ bar: i, midi: note.midi, role: note.role, source: note.source, dissonance: bp.tracks[note.track]?.dissonance });
    }
  }
  out.tracks = {};
  for (const [id, pt] of Object.entries(perTrack)) {
    const cfg = p0.tracks[id] || {};
    const total = pt.counts.reduce((a, b) => a + b, 0);
    const summary = {
      state: cfg.state, voice: cfg.voice, level: cfg.level, density: cfg.density, dissonance: cfg.dissonance, passingNotes: cfg.passingNotes,
      notesPerBar: { mean: +mean(pt.counts).toFixed(2), min: Math.min(...pt.counts), max: Math.max(...pt.counts) },
      total, silentBars: pt.counts.filter((c) => c === 0).length, roles: pt.roles, outside: pt.outside.length,
    };
    if (pt.outside.length) summary.outsideSample = pt.outside.slice(0, 4);
    if (Object.keys(pt.states).length > 1) summary.statesSeen = pt.states;
    out.tracks[id] = summary;
    if (cfg.state === 'on' && total === 0) findings.push({ kind: 'fault', what: `${id} is ON (${cfg.voice}) and played nothing in ${n} bars` });
    const dissMax = cfg.dissonance && typeof cfg.dissonance === 'object' ? cfg.dissonance.max : cfg.dissonance;
    // The bass's groove fifth is a PERFECT fifth by contract (interval 7,
    // docs/engine-v2-contract.md § note sources), which sits off the scale
    // over a diminished triad (vi in dorian, ii in aeolian, iii in
    // mixolydian). Counted apart, as a ruling: it is documented, and it is
    // not what Dissonance drew.
    const bassFifth = pt.outside.filter((o) => o.source === 'groove-fifth' || o.source === 'approach');
    if (id === 'bass' && bassFifth.length) {
      summary.perfectFifthOffScale = bassFifth.length;
      findings.push({ kind: 'ruling', what: `bass: ${bassFifth.length}/${total} notes are a perfect fifth (or an approach via it) off the ${p0.root} ${p0.mode} scale — a diminished chord's fifth played perfect (Dissonance ${JSON.stringify(cfg.dissonance)})`, sample: bassFifth.slice(0, 2) });
      pt.outside = pt.outside.filter((o) => !bassFifth.includes(o));
    }
    if (pt.outside.length && !(Number(dissMax) > 0)) {
      findings.push({ kind: 'fault', what: `${id} played ${pt.outside.length} note(s) off the ${p0.root} ${p0.mode} scale with Dissonance ${JSON.stringify(cfg.dissonance)}`, sample: pt.outside.slice(0, 3) });
    } else if (pt.outside.length) {
      findings.push({ kind: 'ruling', what: `${id}: ${pt.outside.length}/${total} notes off the scale (Dissonance ${JSON.stringify(cfg.dissonance)}, Passing ${JSON.stringify(cfg.passingNotes)})`, sample: pt.outside.slice(0, 3) });
    }
  }
  out.barsWithNoOnset = anyNote.filter((f) => !f).length;

  // Loudness per bar off the master tap.
  const rmsBars = Array.from({ length: n }, () => []);
  for (const f of raw.rms) { const i = barIndex(f.t + 0.023); if (i >= 0) rmsBars[i].push(f.rms); }
  const barRms = rmsBars.map((xs) => (xs.length ? Math.sqrt(mean(xs.map((x) => x * x))) : 0));
  const barDb = barRms.map(dB);
  // Bar 0 is the tap's warm-up (the worklet module loads after Play, and
  // under five pages' load that can outlast a fast bar) as well as the entry
  // bar, so the quietest/loudest/near-silent readings start at bar 1.
  const rated = barDb.map((d, i) => (i === 0 ? null : d));
  const med = median(barDb.slice(1).filter((d) => d > -120));
  const quietIdx = rated.indexOf(Math.min(...barDb.slice(1)));
  const loudIdx = rated.indexOf(Math.max(...barDb.slice(1)));
  out.loudness = { quietestBar: { bar: quietIdx, dB: barDb[quietIdx] }, loudestBar: { bar: loudIdx, dB: barDb[loudIdx] }, medianDb: med,
    framesTapped: raw.rms.length, barDb };
  const nearSilent = barDb.map((d, i) => i > 0 && d < -50);
  out.loudness.nearSilentBars = nearSilent.filter(Boolean).length;
  out.loudness.longestNearSilentRun = longestRun(nearSilent);
  if (!raw.rms.length) findings.push({ kind: 'fault', what: 'the output tap saw no audio frames' });
  if (barDb[loudIdx] - med > 12) findings.push({ kind: 'ruling', what: `loudest bar ${loudIdx} is ${(barDb[loudIdx] - med).toFixed(1)} dB above the median (${barDb[loudIdx]} vs ${med} dBFS)` });
  if (out.loudness.longestNearSilentRun >= 4) findings.push({ kind: 'ruling', what: `${out.loudness.longestNearSilentRun} consecutive bars under -50 dBFS while playing (bars ${nearSilent.indexOf(true)}…)` });

  // Chord loop adherence: every chord event's root as a scale degree, against the seed loop.
  const chordDegrees = [];
  for (const c of raw.chords) {
    const i = barIndex(c.time);
    if (i < 0 || !c.name) continue;
    const m = /^([A-G]#?)/.exec(c.name);
    const bp = bars[i].params;
    const pcs = (SCALES[bp.mode] || []).map((s) => (s + (NOTE_PC[bp.root] ?? 0)) % 12);
    const degree = m ? pcs.indexOf(NOTE_PC[m[1]]) : -1;
    chordDegrees.push({ bar: i, name: c.name, degree });
  }
  const dedup = chordDegrees.filter((c, k) => k === 0 || c.degree !== chordDegrees[k - 1].degree);
  out.chords = { events: chordDegrees.length, changes: dedup.length, sequence: dedup.map((c) => c.degree + 1).join(' '), names: dedup.slice(0, 12).map((c) => c.name).join(' ') };
  if (seedLoop && seedLoop.length) {
    const set = new Set(seedLoop);
    const inLoop = chordDegrees.filter((c) => set.has(c.degree)).length / Math.max(1, chordDegrees.length);
    const pairs = new Set(seedLoop.map((d, k) => `${d}>${seedLoop[(k + 1) % seedLoop.length]}`));
    let okT = 0;
    for (let k = 1; k < dedup.length; k++) if (pairs.has(`${dedup[k - 1].degree}>${dedup[k].degree}`)) okT += 1;
    out.chords.inLoopShare = +inLoop.toFixed(2);
    out.chords.transitionsInLoop = dedup.length > 1 ? +(okT / (dedup.length - 1)).toFixed(2) : null;
    if (seedLoop.length > 1 && chordDegrees.length >= 4 && inLoop < 0.5) findings.push({ kind: 'fault', what: `chord loop kept as harmony.seed [${seedLoop.map((d) => d + 1).join(' ')}] but only ${(inLoop * 100).toFixed(0)}% of chords sit in it: ${out.chords.sequence}` });
    if (seedLoop.length === 1 && chordDegrees.length >= 4 && inLoop < 0.5) findings.push({ kind: 'fault', what: `one-chord loop [${seedLoop[0] + 1}] but chords wandered: ${out.chords.sequence}` });
  } else {
    out.chords.seedDropped = true;
    findings.push({ kind: 'fault', what: `the genre's progression did not survive sanitising in ${p0.mode} (harmony.seed is null) — the engine walked its own loop: ${out.chords.sequence}` });
  }
  if (run.errors.length) findings.push({ kind: 'fault', what: `${run.errors.length} page/console error(s)`, sample: run.errors.slice(0, 3) });
  if (!run.done) findings.push({ kind: 'fault', what: `did not reach bar ${BARS} inside ${run.budget} ms (bars seen ${raw.bars.length}, clock ${raw.now})` });
  out.findings = findings;
  return out;
}

export default async function drive(page) {
  const base = await page.evaluate(() => location.origin + location.pathname);
  const jobs = [];
  for (const slug of GENRES) for (const seed of SEEDS) jobs.push({ slug, seed, url: shareLink(base, slug, seed) });
  // The runner's page lives in Playwright's default context, which refuses
  // newPage(); every run gets a page in a context of its own.
  const browser = page.context().browser();
  const results = [];
  let next = 0;
  const runJob = async (job) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const pg = await context.newPage();
    try {
      return analyse(await measureOne(pg, job));
    } finally {
      await context.close().catch(() => {});
    }
  };
  const worker = async (lane) => {
    await new Promise((r) => setTimeout(r, lane * STAGGER_MS));
    while (next < jobs.length) {
      const job = jobs[next++];
      try {
        results.push(await runJob(job));
      } catch (first) {
        // A page that never booted or never started is the Mac under load,
        // not the genre: one rested retry before it counts.
        await new Promise((r) => setTimeout(r, 10000));
        try {
          const again = await runJob(job);
          again.retried = `first attempt: ${first && first.message ? first.message : first}`;
          results.push(again);
        } catch (err) {
          results.push({ genre: job.slug, seed: job.seed, findings: [{ kind: 'fault', what: `drive error twice: ${err && err.message ? err.message : err}` }] });
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, (_, lane) => worker(lane)));
  results.sort((a, b) => a.genre.localeCompare(b.genre) || a.seed - b.seed);

  const faults = [];
  for (const r of results) for (const f of r.findings || []) if (f.kind === 'fault') faults.push(`${r.genre}/${r.seed}: ${f.what}${f.sample ? ' ' + JSON.stringify(f.sample) : ''}`);
  const table = results.map((r) => ({
    genre: r.genre, seed: r.seed, bpm: r.bpm, ts: r.timeSignature, key: `${r.root} ${r.mode}`, structure: r.structure,
    perBar: Object.fromEntries(Object.entries(r.tracks || {}).map(([id, t]) => [id, `${t.state}:${t.notesPerBar.mean}(${t.notesPerBar.min}-${t.notesPerBar.max})`])),
    noOnsetBars: r.barsWithNoOnset, loud: r.loudness ? `${r.loudness.quietestBar.dB}/${r.loudness.medianDb}/${r.loudness.loudestBar.dB}` : null,
    silentRun: r.loudness?.longestNearSilentRun, chords: r.chords ? `${r.chords.seedDropped ? 'seed dropped' : 'seed ' + (r.seedLoop || []).map((d) => d + 1).join(' ')} | in ${r.chords.inLoopShare ?? '-'} tr ${r.chords.transitionsInLoop ?? '-'}` : null,
    rulings: (r.findings || []).filter((f) => f.kind === 'ruling').map((f) => f.what),
  }));
  if (faults.length) {
    // The runner prints only a RETURNED result; a thrown one keeps its message.
    // The full record is the evidence, so it goes to stdout before the throw.
    console.log('GENRE-MEASURE DETAIL ' + JSON.stringify({ runs: results.length, bars: BARS, table, detail: results }));
    throw new Error(`genre-measure-drive: ${faults.length} fault(s)\n` + faults.map((f) => '  ✗ ' + f).join('\n') + '\n\nTABLE\n' + JSON.stringify(table, null, 1));
  }
  return { runs: results.length, bars: BARS, table, detail: results };
}
