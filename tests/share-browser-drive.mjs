/**
 * A heavily edited setup, carried whole: reload, share link, whole-tree link,
 * tampered link — every one compared at the ENGINE, every field.
 *
 *   npm run build && .vibe/measure.sh local drive tests/share-browser-drive.mjs
 *
 * sharelink-drive compares a handful of fields; share-roundtrip compares the
 * whole tree but in jsdom, through the preset load path rather than through
 * the controls. This one edits the way a person does — a genre, a key, a
 * structure, several dials dragged (one opened into a span), steps set on a
 * sequencer, a track of the person's own added — then takes the engine's
 * getParams() across:
 *
 *   1. a REAL reload (localStorage persistence of every edit);
 *   2. the compact share link the page minted, opened fresh;
 *   3. a whole-tree link at the oldest stamp, as every pre-v0.0.79 link was;
 *   4. a link stamped by a "newer build" — the note must say so, the page
 *      must still boot;
 *   5. a link whose diff was tampered with — the page must boot, throw
 *      nothing, and the fields tampered must agree between page and engine.
 *
 * Every differing path is reported, not just the first. Console errors and
 * page errors are collected from the first reboot onward and fail the drive.
 */

const diffPaths = (a, b, path = '', out = []) => {
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  const isObj = (v) => v !== null && typeof v === 'object';
  if (!isObj(a) || !isObj(b) || Array.isArray(a) !== Array.isArray(b)) {
    out.push(`${path || '(root)'}: ${JSON.stringify(a)?.slice(0, 80)} -> ${JSON.stringify(b)?.slice(0, 80)}`);
    return out;
  }
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    diffPaths(a[key], b[key], path ? `${path}.${key}` : key, out);
  }
  return out;
};

// tempoLanding is WHERE THE NEXT TEMPO CHANGE LANDS (bar for the Advanced
// dial, beat for Energy): the engine keeps the last ask, the page stores none,
// and nothing reproduced depends on it. Not a setting; not compared.
const NOT_A_SETTING = ['tempoLanding'];
const settingDiffs = (a, b) => diffPaths(a, b).filter((line) => !NOT_A_SETTING.some((k) => line.startsWith(`${k}:`)));

const engineParams = (page) =>
  page.evaluate(() => JSON.parse(JSON.stringify(window.__ambi4Engine.getParams())));

const encode = (page, payload) =>
  page.evaluate((p) => {
    const bytes = new TextEncoder().encode(JSON.stringify(p));
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return `${location.origin}${location.pathname}#p=${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
  }, payload);

const decode = (page, url) =>
  page.evaluate((u) => {
    const value = new URLSearchParams(new URL(u).hash.slice(1)).get('p') || '';
    const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))));
  }, url);

const openFoldFor = async (page, selector) => {
  const more = await page.evaluate((s) => (typeof window.__ambi4FoldMore === 'function' ? window.__ambi4FoldMore(s) : null), selector);
  if (more) {
    await page.click(more);
    await page.waitForTimeout(150);
  }
};

const dialAt = (page, label, scope) =>
  page.evaluate(([name, sel]) => {
    const root = sel ? document.querySelector(sel) : document;
    const visible = (el) => {
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        if (n.hidden || n.getAttribute?.('aria-hidden') === 'true') return false;
        const cs = getComputedStyle(n);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      }
      return true;
    };
    const k = [...(root || document).querySelectorAll('.knob')]
      .find((el) => (name ? el.getAttribute('aria-label') === name : true) && visible(el));
    if (!k) return null;
    k.scrollIntoView({ block: 'center' });
    const r = k.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.width / 2),
      label: k.getAttribute('aria-label'), valuetext: k.getAttribute('aria-valuetext') };
  }, [label, scope]);

export default async function drive(page) {
  const results = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
  };
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e && e.message ? e.message : e} @ ${String(e && e.stack || '').split('\n').slice(1, 4).join(' | ').slice(0, 400)}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 200)}`); });

  const home = await page.evaluate(() => location.origin + location.pathname);
  let step = 'start';
  const mark = (label) => { step = label; errors.push(`-- ${label}`); };
  const boot = async (url) => {
    mark(`boot ${url.slice(0, 60)}`);
    await page.goto('about:blank');
    await page.goto(url);
    await page.waitForTimeout(2500);
  };
  const consent = async () => {
    await page.click('#consent-slot button:has-text("Save on this device")').catch(() => {});
    await page.waitForTimeout(250);
  };
  const dragDial = async (label, dx, dy, scope) => {
    if (label) await openFoldFor(page, `${scope} .knob[aria-label="${label}"]`);
    const d = await dialAt(page, label, scope);
    if (!d) return null;
    await page.mouse.move(d.x, d.y);
    await page.mouse.down();
    const steps = Math.max(Math.abs(dx), Math.abs(dy));
    for (let t = 4; t <= steps; t += 8) {
      const f = t / steps;
      await page.mouse.move(d.x + Math.round(dx * f), d.y + Math.round(dy * f));
    }
    await page.mouse.up();
    await page.waitForTimeout(320);
    return dialAt(page, d.label, scope);
  };
  const noteText = () => page.evaluate(() => document.getElementById('share-note')?.textContent || '');
  const booted = () => page.evaluate(() => !!document.getElementById('generator-app') && !document.getElementById('generator-app').hidden && !!window.__ambi4Engine);

  // Reboot so the error listeners cover boot too.
  await boot(home);
  await consent();
  await page.click('#tab-advanced');
  await page.waitForTimeout(500);

  // ---- pin, then edit widely --------------------------------------------
  await page.selectOption('#genre-select', 'g:synthwave');
  const pinned = await page.waitForFunction(() => window.__ambi4Engine?.getParams?.()?.genre === 'synthwave', { timeout: 5000 }).then(() => true).catch(() => false);
  check('Synthwave pinned at the engine', pinned, true);
  await page.selectOption('#root', 'F');
  await page.selectOption('#mode', 'dorian');
  await openFoldFor(page, '#structure');
  await page.selectOption('#structure', 'journey');
  await page.waitForTimeout(500);
  const pristine = await engineParams(page);

  const ADV = '#panel-advanced';
  const tempoSpan = await dragDial('Tempo', 70, 0, ADV);
  check('Tempo dragged into a span', /drifting/.test(tempoSpan?.valuetext || ''), true);
  const labels = await page.evaluate(() => [...document.querySelectorAll('#panel-advanced .knob')].map((k) => k.getAttribute('aria-label')).filter((l) => l && l !== 'Tempo'));
  const dragged = [];
  for (const [i, label] of labels.slice(0, 4).entries()) {
    const after = await dragDial(label, i % 2 ? 50 : 0, i % 2 ? 0 : -55, ADV);
    if (after) dragged.push({ label, valuetext: after.valuetext });
  }
  results.push({ name: 'dials dragged', ok: true, got: dragged, want: '(informational)' });

  // Steps on the bass sequencer, and a per-track dial inside its editor.
  const opened = await page.evaluate(() => {
    for (const row of document.querySelectorAll('.track-row')) {
      if (/bass/i.test(row.textContent || '')) { row.querySelector('.voice-edit-toggle')?.click(); return true; }
    }
    return false;
  });
  check('the bass editor opened', opened, true);
  await page.waitForTimeout(700);
  for (const idx of [0, 3, 5]) {
    await page.evaluate((i) => {
      const cell = document.getElementById('voice-editor-bass')?.querySelectorAll('.seq-cell')[i];
      if (cell) { cell.scrollIntoView({ block: 'center' }); cell.click(); }
    }, idx);
    await page.waitForTimeout(200);
  }
  const editorDial = await dragDial(null, 45, 0, '#voice-editor-bass');
  results.push({ name: 'editor dial dragged', ok: true, got: editorDial, want: '(informational)' });

  // A track of the person's own.
  await page.click('#add-track');
  await page.waitForTimeout(250);
  await page.fill('#add-track-name', 'Probe line');
  await page.click('#add-track-form button[type="submit"]');
  await page.waitForTimeout(700);
  const userTrack = await page.evaluate(() => {
    const p = window.__ambi4Engine.getParams();
    const u = (p.userTracks || []).find((t) => t && t.label === 'Probe line');
    return { listed: !!u, inTracks: !!(u && p.tracks[u.id]) };
  });
  check('the user track is in the engine', userTrack, { listed: true, inTracks: true });

  await page.waitForTimeout(600); // past the persist debounce
  const edited = await engineParams(page);
  const movedPaths = diffPaths(pristine, edited);
  check('the edits reached the engine (many paths moved)', movedPaths.length >= 8, (v) => v === true);
  results.push({ name: 'paths moved by the edits', ok: true, got: movedPaths.length, want: '(informational)' });

  // ---- the page's own snapshot: Save a preset and read it back ------------
  await openFoldFor(page, '#preset-save');
  await page.fill('#preset-name', 'probe A');
  await page.click('#preset-save');
  await page.waitForTimeout(300);
  const pageSnapshot = await page.evaluate(() => {
    const list = JSON.parse(localStorage.getItem('ambi4:presets') || '[]');
    return (list.find((p) => p.name === 'probe A') || {}).params || null;
  });
  check('the saved preset is in localStorage', !!pageSnapshot, true);

  // ---- the share link ------------------------------------------------------
  await page.evaluate(() => {
    window.__copied = null;
    navigator.clipboard.writeText = (text) => { window.__copied = text; return Promise.resolve(); };
  });
  await page.click('#preset-share');
  await page.waitForTimeout(700);
  const link = await page.evaluate(() => window.__copied);
  check('Share produced a link', typeof link === 'string' && link.includes('#p='), true);
  const payload = await decode(page, link);
  check('the link is compact (origin + diff)', !!(payload && payload.o && 'd' in payload), true);
  results.push({ name: 'link', ok: true, got: { length: link.length, v: payload?.v, diffKeys: Object.keys(payload?.d || {}) }, want: '(informational)' });
  const localLink = await page.evaluate((u) => location.origin + location.pathname + new URL(u).hash, link);

  // ---- 1. reload: everything persisted -------------------------------------
  await boot(home);
  check('the page rebooted', await booted(), true);
  const reloaded = await engineParams(page);
  check('every edit survives a reload AT THE ENGINE (differing paths)', settingDiffs(edited, reloaded), []);
  const presetListed = await page.evaluate(() => [...document.querySelectorAll('#preset-load option')].map((o) => o.textContent));
  check('the saved preset is listed after the reload', presetListed.includes('probe A'), true);
  // The stored setup as it stands. Arriving on a link must leave it alone:
  // the arrival note says "Save to keep it", and the boot comment says
  // nothing is persisted — so the person's own setup must still be there
  // when they come back without the link.
  const storedGenerator = () => page.evaluate(() => localStorage.getItem('ambi4:generator'));
  const storedBefore = await storedGenerator();
  const storedIntact = async (label) => {
    const now = await storedGenerator();
    const a = JSON.parse(storedBefore || 'null'); const b = JSON.parse(now || 'null');
    check(`${label} leaves the stored setup alone (differing stored paths)`, diffPaths(a, b).slice(0, 12), []);
  };

  // ---- 2. the compact link, opened fresh -----------------------------------
  await boot(localLink);
  check('the compact link booted', await booted(), true);
  check('the compact link arrives identical (differing paths)', settingDiffs(edited, await engineParams(page)), []);
  check('and its base was rebuilt', !/could not be rebuilt/.test(await noteText()), true);
  await storedIntact('arriving on a compact link');

  // ---- 3. a whole-tree link at the oldest stamp ----------------------------
  await boot(await encode(page, { ...pageSnapshot, v: 1 }));
  check('a whole-tree v1 link booted', await booted(), true);
  check('a whole-tree v1 link arrives identical (differing paths)', settingDiffs(edited, await engineParams(page)), []);
  await storedIntact('arriving on a whole-tree link');

  // ---- 4. a link from a "newer build" --------------------------------------
  await boot(await encode(page, { ...payload, v: 99 }));
  check('a newer-stamp link booted', await booted(), true);
  const newerNote = await noteText();
  check('a newer-stamp link says so', /newer/i.test(newerNote), true);
  results.push({ name: 'newer note', ok: true, got: newerNote, want: '(informational)' });
  await storedIntact('arriving on a newer-stamp link');

  // ---- 6. unreadable links: the page boots on its stored setup, silently ---
  for (const [label, hash] of [
    ['not base64', '#p=%%%not-a-link%%%'],
    ['a JSON array', `#p=${btoa('[1,2,3]')}`],
    ['a JSON string', `#p=${btoa('"hello"')}`],
  ]) {
    await boot(home + hash);
    check(`an unreadable link (${label}) still boots`, await booted(), true);
  }
  check('and the stored setup is what plays after them (differing paths)', settingDiffs(edited, await engineParams(page)), []);
  await storedIntact('arriving on unreadable links');
  // Readable but empty: a whole-tree payload holding no setting at all is a
  // link to the defaults. It loads (as a link), and must not be kept either.
  await boot(home + `#p=${btoa(JSON.stringify({ o: 'x', d: null, v: 1 }))}`);
  check('a readable link with nothing in it still boots', await booted(), true);
  await storedIntact('arriving on an empty link');

  // ---- 5. a tampered link ----------------------------------------------------
  const tampered = JSON.parse(JSON.stringify(payload));
  tampered.o.seed = 'NaN';
  tampered.d.bpm = 'abc';
  tampered.d.structure = 'nope';
  tampered.d.complexity = 1e9;
  tampered.d.tracks = { ...(tampered.d.tracks || {}), bass: { ...((tampered.d.tracks || {}).bass || {}), voice: 42, pan: 'left', level: -5 } };
  tampered.d.userTracks = 'x';
  tampered.d.arp = 'nope';
  await boot(await encode(page, tampered));
  check('a tampered link still boots', await booted(), true);
  await storedIntact('arriving on a tampered link');
  await page.click('#tab-advanced');
  await page.waitForTimeout(400);
  await openFoldFor(page, '#preset-save');
  await page.fill('#preset-name', 'tampered');
  await page.click('#preset-save');
  await page.waitForTimeout(300);
  const agree = await page.evaluate(() => {
    const list = JSON.parse(localStorage.getItem('ambi4:presets') || '[]');
    const s = (list.find((p) => p.name === 'tampered') || {}).params || {};
    const e = window.__ambi4Engine.getParams();
    const pick = (o) => ({ bpm: o.bpm, structure: o.structure, complexity: o.complexity,
      bassVoice: o.tracks?.bass?.voice, bassPan: o.tracks?.bass?.pan, userTracks: Array.isArray(o.userTracks) });
    return { page: pick(s), engine: pick(e) };
  });
  check('page and engine agree on the tampered fields', agree.page, agree.engine);
  check('the tampered numbers are finite numbers', [agree.engine.bpm, agree.engine.complexity].every((v) => Number.isFinite(v) || (v && Number.isFinite(v.min))), true);
  results.push({ name: 'tampered fields', ok: true, got: agree, want: '(informational)' });

  // ---- 7. a link off a FACTORY preset origin --------------------------------
  await page.click('#tab-simple').catch(() => {});
  await page.waitForTimeout(300);
  const card = await page.evaluate(() => {
    const el = document.querySelector('#factory-preset-row .factory-preset');
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    el.click();
    return el.dataset.preset;
  });
  check('a factory preset card loaded', !!card, true);
  await page.waitForTimeout(800);
  await page.click('#tab-advanced');
  await page.waitForTimeout(400);
  await page.selectOption('#root', 'B');
  await page.waitForTimeout(500);
  const fromPreset = await engineParams(page);
  await page.evaluate(() => {
    window.__copied = null;
    navigator.clipboard.writeText = (text) => { window.__copied = text; return Promise.resolve(); };
  });
  await openFoldFor(page, '#preset-share');
  await page.click('#preset-share');
  await page.waitForTimeout(700);
  const presetLink = await page.evaluate(() => window.__copied);
  const presetPayload = presetLink ? await decode(page, presetLink) : null;
  check('a preset-origin link is compact and names the preset', presetPayload?.o?.kind === 'preset' && presetPayload?.o?.id === card, true);
  results.push({ name: 'preset link', ok: true, got: { length: presetLink?.length, v: presetPayload?.v, diffKeys: Object.keys(presetPayload?.d || {}) }, want: '(informational)' });
  await boot(await page.evaluate((u) => location.origin + location.pathname + new URL(u).hash, presetLink));
  check('a preset-origin link arrives identical (differing paths)', settingDiffs(fromPreset, await engineParams(page)), []);

  check('no console errors or page errors', errors.filter((e) => !e.startsWith('-- ')), []);
  results.push({ name: 'error timeline', ok: true, got: errors, want: '(informational)' });

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'share-browser-drive: ' + failed.length + ' failed\n' + JSON.stringify(results.filter((r) => r.want === '(informational)')) + '\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n'),
    );
  }
  return { passed: results.length, notes: results.filter((r) => r.want === '(informational)').map((r) => `${r.name}: ${JSON.stringify(r.got)}`) };
}
