/**
 * The first visit and the storage states, in a real browser.
 *
 *   npm run build && .vibe/measure.sh local drive tests/first-visit-drive.mjs
 *
 * page-boot asserts (in jsdom) that a fresh boot persists nothing before
 * consent; hostile-prefs feeds corrupt presets/layout/genre/voices values
 * through the cleaners in jsdom. Neither can drive the consent card, throw
 * from a REAL Storage, fill a real quota, reload a playing page, run two tabs
 * on one store, or hide a tab. This one does, each in a fresh browser
 * context (its own cookie jar and localStorage), with every Storage write
 * logged from before the first script runs:
 *
 *   A. a brand-new visitor: the card asks at boot; play, drag, Save, Share
 *      and nothing under ambi4: is written; No thanks; play, edit, Save a
 *      preset, Share; reload — nothing persisted, the card not re-asked,
 *      the page says the preset was for this visit only;
 *   B. the same, answered Save LATER in the visit: everything chosen before
 *      the answer is written at that moment and survives a reload;
 *   C. Storage throwing at boot (setItem/getItem, and the localStorage
 *      getter itself): the page boots and plays, no errors;
 *   D. Storage throwing MID-session, consent granted: no errors, the page
 *      says the change could not be kept;
 *   E. the quota filled mid-session: a dial drag and a preset Save both say
 *      so; clearing room makes the next write land;
 *   F. corrupt stored values at boot (generator: not JSON, wrong types,
 *      prototype keys, huge; presets and layout junk alongside): boots on
 *      defaults, engine agrees with the page, no errors;
 *   G. reload while playing: comes back stopped, settings intact;
 *   H. two tabs on one store: last write wins, no errors, a reload reads it;
 *   I. the tab hidden and shown while playing: still playing, no errors;
 *   J. ten fresh visits: the opening genre varies, and no visible text or
 *      readout anywhere says undefined / NaN / null after boot.
 *
 * Console errors and page errors fail the drive, per context.
 */

const BAD_TEXT = /\b(undefined|NaN|null)\b/;

const diffPaths = (a, b, path = '', out = []) => {
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  const isObj = (v) => v !== null && typeof v === 'object';
  if (!isObj(a) || !isObj(b) || Array.isArray(a) !== Array.isArray(b)) {
    out.push(`${path || '(root)'}: ${JSON.stringify(a)?.slice(0, 60)} -> ${JSON.stringify(b)?.slice(0, 60)}`);
    return out;
  }
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    diffPaths(a[key], b[key], path ? `${path}.${key}` : key, out);
  }
  return out;
};
const NOT_A_SETTING = ['tempoLanding'];
const settingDiffs = (a, b) => diffPaths(a, b).filter((line) => !NOT_A_SETTING.some((k) => line.startsWith(`${k}:`)));

// Logged from before the first page script: every Storage write, by key,
// survives a later removeItem (No thanks wipes the namespace, which would
// hide a write that happened before it).
const WRITE_LOG = `(() => {
  const log = [];
  window.__storeWrites = log;
  const set = Storage.prototype.setItem;
  const del = Storage.prototype.removeItem;
  Storage.prototype.setItem = function (k, v) { log.push({ op: 'set', k: String(k), bytes: String(v).length }); return set.call(this, k, v); };
  Storage.prototype.removeItem = function (k) { log.push({ op: 'del', k: String(k) }); return del.call(this, k); };
})();`;

export default async function drive(page) {
  const results = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
  };
  const note = (name, got) => results.push({ name, ok: true, got, want: '(informational)' });

  const home = await page.evaluate(() => location.origin + location.pathname);
  const browser = page.context().browser();
  const viewport = page.viewportSize() || { width: 1280, height: 900 };

  // ---- context plumbing ------------------------------------------------------
  const contexts = [];
  const watch = (pg, errors) => {
    pg.on('pageerror', (e) => errors.push(`pageerror: ${e && e.message ? e.message : e}`));
    pg.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 200)}`); });
  };
  const fresh = async ({ init = [], cookies = null, storage = null } = {}) => {
    const ctx = await browser.newContext({ viewport, colorScheme: 'light' });
    contexts.push(ctx);
    const errors = [];
    await ctx.addInitScript(WRITE_LOG);
    for (const script of init) await ctx.addInitScript(script);
    if (cookies) await ctx.addCookies(cookies.map((c) => ({ ...c, url: home })));
    if (storage) {
      // Seed localStorage before the app's first read: an init script runs on
      // every navigation, so it seeds once (guarded) and only on this origin.
      await ctx.addInitScript(`(() => {
        if (!/^https?:/.test(location.protocol)) return; // about:blank has no storage
        try {
          if (sessionStorage.getItem('__seeded')) return;
          sessionStorage.setItem('__seeded', '1');
          for (const [k, v] of ${JSON.stringify(Object.entries(storage))}) localStorage.setItem(k, v);
        } catch (e) { console.warn('seed failed: ' + e); }
      })();`);
    }
    const pg = await ctx.newPage();
    watch(pg, errors);
    return { ctx, pg, errors };
  };
  const boot = async (pg, url = home) => {
    await pg.goto('about:blank');
    await pg.goto(url);
    await pg.waitForTimeout(2500);
  };
  const booted = (pg) => pg.evaluate(() => {
    const app = document.getElementById('generator-app');
    return !!app && !app.hidden && !!window.__ambi4Engine && typeof window.__ambi4Engine.getParams === 'function';
  });
  const params = (pg) => pg.evaluate(() => JSON.parse(JSON.stringify(window.__ambi4Engine.getParams())));
  const ambiKeys = (pg) => pg.evaluate(() => { try { return Object.keys(localStorage).filter((k) => k.startsWith('ambi4')).sort(); } catch { return 'unreadable'; } });
  const ambiWrites = (pg) => pg.evaluate(() => (window.__storeWrites || []).filter((w) => w.op === 'set' && w.k.startsWith('ambi4')).map((w) => w.k));
  const cookie = (pg) => pg.evaluate(() => (document.cookie.split(';').map((s) => s.trim()).find((s) => s.startsWith('ambi4-consent=')) || '').slice('ambi4-consent='.length) || null);
  const cardShown = (pg) => pg.evaluate(() => {
    const slot = document.getElementById('consent-slot');
    const buttons = slot ? [...slot.querySelectorAll('button')].map((b) => b.textContent.trim()) : [];
    return { text: (slot?.textContent || '').slice(0, 60), buttons };
  });
  const accept = async (pg) => { await pg.click('#consent-slot button:has-text("Save on this device")'); await pg.waitForTimeout(300); };
  const decline = async (pg) => { await pg.click('#consent-slot button:has-text("No thanks")'); await pg.waitForTimeout(300); };
  const said = (pg) => pg.evaluate(() => ({
    dial: document.getElementById('dial-confirm')?.textContent?.trim() || '',
    share: document.getElementById('share-note')?.textContent?.trim() || '',
    slot: document.getElementById('consent-slot')?.textContent?.trim().slice(0, 80) || '',
  }));
  const running = (pg) => pg.evaluate(() => !!window.__ambi4Engine.running);
  const play = async (pg) => { await pg.click('#toggle-play'); await pg.waitForTimeout(1200); };
  // The transport is Play -> Finish (an ~8 s outro) -> Stop now: two presses
  // stop at once, one press only starts the outro (tests/transport-drive).
  const stop = async (pg) => {
    if (!(await running(pg))) return;
    await pg.click('#toggle-play');
    await pg.waitForTimeout(400);
    await pg.click('#toggle-play');
    await pg.waitForFunction(() => !window.__ambi4Engine.running, { timeout: 3000 }).catch(() => {});
    await pg.waitForTimeout(200);
  };
  const stored = (pg, key) => pg.evaluate((k) => { try { const raw = localStorage.getItem(k); return raw === null ? null : JSON.parse(raw); } catch { return 'unreadable'; } }, key);
  const openFoldFor = async (pg, selector) => {
    const more = await pg.evaluate((s) => (typeof window.__ambi4FoldMore === 'function' ? window.__ambi4FoldMore(s) : null), selector);
    if (more) { await pg.click(more); await pg.waitForTimeout(150); }
  };
  const savePreset = async (pg, name) => {
    await pg.click('#tab-advanced').catch(() => {});
    await pg.waitForTimeout(250);
    await openFoldFor(pg, '#preset-save');
    await pg.fill('#preset-name', name);
    await pg.click('#preset-save');
    await pg.waitForTimeout(350);
  };
  const listedPresets = (pg) => pg.evaluate(() => [...document.querySelectorAll('#preset-load option')].filter((o) => o.value !== '').map((o) => o.textContent));
  const share = async (pg) => {
    await pg.click('#tab-advanced').catch(() => {});
    await pg.waitForTimeout(200);
    await pg.evaluate(() => { window.__copied = null; navigator.clipboard.writeText = (t) => { window.__copied = t; return Promise.resolve(); }; });
    await openFoldFor(pg, '#preset-share');
    await pg.click('#preset-share');
    await pg.waitForTimeout(600);
    return pg.evaluate(() => window.__copied);
  };
  // The Tempo dial on Advanced, dragged a real distance; returns the engine's
  // bpm before and after so the drag is proven at the engine, not the readout.
  const dragTempo = async (pg, dx = 60) => {
    await pg.click('#tab-advanced').catch(() => {});
    await pg.waitForTimeout(250);
    await openFoldFor(pg, '#panel-advanced .knob[aria-label="Tempo"]');
    const before = (await params(pg)).bpm;
    const d = await pg.evaluate(() => {
      const k = [...document.querySelectorAll('#panel-advanced .knob')].find((el) => el.getAttribute('aria-label') === 'Tempo');
      if (!k) return null;
      k.scrollIntoView({ block: 'center' });
      const r = k.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.width / 2) };
    });
    if (!d) return { before, after: before, found: false };
    await pg.mouse.move(d.x, d.y);
    await pg.mouse.down();
    for (let t = 4; t <= Math.abs(dx); t += 6) await pg.mouse.move(d.x, d.y - Math.sign(dx) * t);
    await pg.mouse.up();
    await pg.waitForTimeout(450); // past the 250 ms persist debounce
    const after = (await params(pg)).bpm;
    // A Tempo already at its top does not move on an upward drag (since
    // v0.0.289 a drag from the hub is vertical, and no longer swings to the
    // angle it crosses). Once the other way, so the drag is a real change.
    if (JSON.stringify(after) === JSON.stringify(before) && dx > 0) return dragTempo(pg, -dx);
    return { before, after, found: true };
  };
  const bpmOf = (v) => (v && typeof v === 'object' ? v.min : v);
  // Every visible text node and the readable attributes, scanned for the
  // half-initialised words. Returns the offending snippets.
  const badText = (pg) => pg.evaluate((re) => {
    const rx = new RegExp(re);
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement && /^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT)$/.test(n.parentElement.tagName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n.textContent;
      const m = rx.exec(t);
      if (m) out.push(`text "${t.slice(Math.max(0, m.index - 25), m.index + 30).trim()}" in ${n.parentElement.tagName.toLowerCase()}${n.parentElement.id ? '#' + n.parentElement.id : ''}`);
    }
    for (const el of document.body.querySelectorAll('[aria-valuetext],[title],[placeholder],[aria-label],input,option')) {
      for (const attr of ['aria-valuetext', 'title', 'placeholder', 'aria-label']) {
        const v = el.getAttribute(attr);
        if (v && rx.test(v)) out.push(`${attr}="${v.slice(0, 60)}" on ${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}`);
      }
      if (el.tagName === 'INPUT' && el.type !== 'hidden' && typeof el.value === 'string' && rx.test(el.value)) out.push(`input value "${el.value.slice(0, 60)}" on #${el.id}`);
    }
    return out.slice(0, 12);
  }, BAD_TEXT.source);
  const clean = (pg) => pg.evaluate(() => {
    // Only the ambi4 namespace is ours to clear; the junk keys are the test's.
    try { for (const k of Object.keys(localStorage)) if (k.startsWith('junk:')) localStorage.removeItem(k); } catch {}
  });

  // ---- A. a brand-new visitor, who says No thanks ------------------------------
  {
    const { pg, errors } = await fresh();
    await boot(pg);
    check('A: a fresh visit boots', await booted(pg), true);
    const card = await cardShown(pg);
    check('A: the consent card asks at boot, with both answers', card.buttons, ['Save on this device', 'No thanks']);
    check('A: the card names the purpose', /Remember your settings/.test(card.text), true);
    check('A: no ambi4 key written before an answer (boot)', await ambiWrites(pg), []);
    check('A: no consent cookie before an answer', await cookie(pg), null);
    check('A: nothing half-initialised on a fresh boot', await badText(pg), []);
    await play(pg);
    check('A: a fresh visitor can play before answering', await running(pg), true);
    const drag = await dragTempo(pg);
    check('A: a dial dragged before answering reaches the engine', drag.found && bpmOf(drag.after) !== bpmOf(drag.before), true);
    await savePreset(pg, 'before answer');
    check('A: a preset saved before answering is listed', (await listedPresets(pg)).includes('before answer'), true);
    const link = await share(pg);
    check('A: Share works before answering', typeof link === 'string' && link.includes('#p='), true);
    check('A: still no ambi4 key written after play, drag, Save, Share', await ambiWrites(pg), []);
    check('A: the card is still up (Save and Share did not re-ask or dismiss it)', (await cardShown(pg)).buttons.length, 2);
    await stop(pg);

    await decline(pg);
    check('A: No thanks records the refusal in the cookie', await cookie(pg), 'denied');
    check('A: No thanks removes the card', (await cardShown(pg)).buttons, []);
    check('A: No thanks writes no ambi4 key', await ambiWrites(pg), []);
    await play(pg);
    check('A: plays after No thanks', await running(pg), true);
    const drag2 = await dragTempo(pg, 40);
    check('A: a dial dragged after No thanks reaches the engine', drag2.found && bpmOf(drag2.after) !== bpmOf(drag2.before), true);
    // v0.0.295: a layout Save under No thanks says it is for this visit only,
    // as a preset Save already did (voice and genre Saves share the words).
    await pg.evaluate(() => {
      const more = document.getElementById('pinned-more');
      const row = document.getElementById('pinned-layouts');
      if (more && row && row.hidden) more.click();
      const name = document.getElementById('layout-name');
      if (name) name.value = 'No thanks layout';
      document.getElementById('layout-save')?.click();
    });
    await pg.waitForTimeout(300);
    const savedLayout = await said(pg);
    note('A: what a layout Save under No thanks says', savedLayout);
    check('A: a layout Save under No thanks says it is for this visit only', /saved/i.test(savedLayout.dial) && /this visit only/i.test(savedLayout.dial), true);
    await pg.selectOption('#root', 'F');
    await pg.waitForTimeout(450);
    check('A: a select after No thanks reaches the engine', (await params(pg)).root, 'F');
    await savePreset(pg, 'declined');
    check('A: a preset saved after No thanks is listed for the visit', (await listedPresets(pg)).includes('declined'), true);
    const saidD = await said(pg);
    note('A: what the page says after a Save under No thanks', saidD);
    check('A: a Save under No thanks says it is for this visit only', /this visit only/i.test(saidD.dial) && /chose not to/i.test(saidD.dial), true);
    const link2 = await share(pg);
    check('A: Share works after No thanks', typeof link2 === 'string' && link2.includes('#p='), true);
    const withEdits = await params(pg);
    check('A: after everything, no ambi4 key written', await ambiWrites(pg), []);
    check('A: and none in storage', await ambiKeys(pg), []);
    await stop(pg);
    const saidBefore = await said(pg);
    note('A: the page before reload', saidBefore);

    await boot(pg);
    check('A: reload after No thanks boots', await booted(pg), true);
    check('A: reload after No thanks is not asked again', (await cardShown(pg)).buttons, []);
    check('A: the cookie still says denied', await cookie(pg), 'denied');
    const afterReload = await params(pg);
    check('A: nothing persisted across the reload (root is not the edit)', afterReload.root === 'F' && bpmOf(afterReload.bpm) === bpmOf(withEdits.bpm), false);
    check('A: the preset did not persist', (await listedPresets(pg)).includes('declined'), false);
    check('A: no ambi4 key written by the reload', await ambiWrites(pg), []);
    check('A: nothing half-initialised after the reload', await badText(pg), []);
    check('A: no console or page errors', errors, []);
  }

  // ---- B. answered Save later in the same visit ----------------------------------
  {
    const { pg, errors } = await fresh();
    await boot(pg);
    check('B: boots', await booted(pg), true);
    await pg.click('#tab-advanced');
    await pg.waitForTimeout(300);
    await pg.selectOption('#genre-select', 'g:synthwave');
    await pg.waitForFunction(() => window.__ambi4Engine?.getParams?.()?.genre === 'synthwave', { timeout: 5000 }).catch(() => {});
    await pg.selectOption('#root', 'G');
    await pg.selectOption('#mode', 'dorian');
    const drag = await dragTempo(pg, 50);
    check('B: the pre-answer drag reached the engine', drag.found && bpmOf(drag.after) !== bpmOf(drag.before), true);
    await savePreset(pg, 'kept later');
    check('B: nothing written before the answer', await ambiWrites(pg), []);
    const before = await params(pg);
    await accept(pg);
    check('B: Save records the grant', await cookie(pg), 'granted');
    const writes = await ambiWrites(pg);
    check('B: the grant writes generator and presets at once', ['ambi4:generator', 'ambi4:presets'].every((k) => writes.includes(k)), true);
    note('B: keys written on grant', [...new Set(writes)]);
    const gen = await stored(pg, 'ambi4:generator');
    check('B: the stored setup is the pre-answer setup (root, mode, genre)', [gen?.root, gen?.mode, gen?.genre], ['G', 'dorian', 'synthwave']);
    check('B: the stored tempo is the dragged one', bpmOf(gen?.bpm), bpmOf(before.bpm));
    const presets = await stored(pg, 'ambi4:presets');
    check('B: the pre-answer preset is stored', Array.isArray(presets) && presets.some((p) => p && p.name === 'kept later'), true);
    await boot(pg);
    check('B: the reload is not asked again', (await cardShown(pg)).buttons, []);
    check('B: every pre-answer edit survives the reload AT THE ENGINE', settingDiffs(before, await params(pg)), []);
    check('B: the preset is listed after the reload', (await listedPresets(pg)).includes('kept later'), true);
    check('B: no console or page errors', errors, []);
  }

  // ---- C. Storage throwing at boot ------------------------------------------------
  const THROW_METHODS = `(() => {
    const err = () => { throw new DOMException('The operation is insecure.', 'SecurityError'); };
    for (const m of ['setItem', 'getItem', 'removeItem', 'key', 'clear']) Storage.prototype[m] = err;
    Object.defineProperty(Storage.prototype, 'length', { get: err, configurable: true });
  })();`;
  const THROW_GETTER = `Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('Access is denied for this document.', 'SecurityError'); } });`;
  for (const [label, init] of [['methods throw', THROW_METHODS], ['the getter throws', THROW_GETTER]]) {
    const { pg, errors } = await fresh({ init: [init] });
    await boot(pg);
    check(`C (${label}): boots with Storage throwing`, await booted(pg), true);
    note(`C (${label}): what is asked`, await cardShown(pg));
    check(`C (${label}): nothing half-initialised`, await badText(pg), []);
    await play(pg);
    check(`C (${label}): plays`, await running(pg), true);
    const drag = await dragTempo(pg, 40);
    check(`C (${label}): a drag reaches the engine`, drag.found && bpmOf(drag.after) !== bpmOf(drag.before), true);
    // Answer Save if asked: the grant must not crash on a store that throws.
    if ((await cardShown(pg)).buttons.length) await accept(pg);
    await pg.selectOption('#root', 'D');
    await pg.waitForTimeout(500);
    check(`C (${label}): a select after the answer reaches the engine`, (await params(pg)).root, 'D');
    await savePreset(pg, 'nowhere to go');
    check(`C (${label}): Save still lists the preset`, (await listedPresets(pg)).includes('nowhere to go'), true);
    const s = await said(pg);
    note(`C (${label}): what the page says`, s);
    check(`C (${label}): the page says the change could not be kept`, /could not be kept|not kept|this visit only/i.test(s.dial), true);
    await stop(pg);
    check(`C (${label}): no console or page errors`, errors, []);
  }

  // ---- D. Storage throwing mid-session, consent granted ---------------------------
  {
    const { pg, errors } = await fresh();
    await boot(pg);
    await accept(pg);
    await pg.click('#tab-advanced');
    await pg.waitForTimeout(300);
    await pg.selectOption('#root', 'E');
    await pg.waitForTimeout(500);
    check('D: a write lands while the store works', (await stored(pg, 'ambi4:generator'))?.root, 'E');
    await pg.evaluate(() => {
      const err = () => { throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); };
      Storage.prototype.setItem = err;
    });
    await pg.selectOption('#root', 'A');
    await pg.waitForTimeout(500);
    check('D: the select still reaches the engine with the store throwing', (await params(pg)).root, 'A');
    check('D: the stored setup is the last one that landed', (await stored(pg, 'ambi4:generator'))?.root, 'E');
    const s1 = await said(pg);
    note('D: what the page says after a lost dial write', s1);
    check('D: a lost write is said', /this visit only/i.test(s1.dial) && /storage/i.test(s1.dial), true);
    const drag = await dragTempo(pg, 40);
    check('D: a drag reaches the engine with the store throwing', drag.found && bpmOf(drag.after) !== bpmOf(drag.before), true);
    await savePreset(pg, 'lost');
    check('D: a Save the store refused is listed for the visit', (await listedPresets(pg)).includes('lost'), true);
    const s2 = await said(pg);
    check('D: a Save the store refused says so', /could not be kept|this visit only/i.test(s2.dial), true);
    const link = await share(pg);
    check('D: Share still works', typeof link === 'string' && link.includes('#p='), true);
    check('D: no console or page errors', errors, []);
    await boot(pg); // the override is gone with the page
    check('D: the reload reads the last write that landed', (await params(pg)).root, 'E');
    check('D: and the refused preset is not there', (await listedPresets(pg)).includes('lost'), false);
  }

  // ---- E. the quota filled mid-session --------------------------------------------
  {
    const { pg, errors } = await fresh();
    await boot(pg);
    await accept(pg);
    await pg.click('#tab-advanced');
    await pg.waitForTimeout(300);
    await pg.selectOption('#root', 'B');
    await pg.waitForTimeout(500);
    check('E: a write lands before the fill', (await stored(pg, 'ambi4:generator'))?.root, 'B');
    const filled = await pg.evaluate(() => {
      // Fill the per-origin pot to the byte: big blocks, then small ones.
      let n = 0;
      let total = 0;
      for (const size of [1 << 20, 1 << 16, 1 << 12, 1 << 8, 16]) {
        const block = 'x'.repeat(size);
        for (;;) {
          try { localStorage.setItem(`junk:${n}`, block); n++; total += size; } catch { break; }
          if (n > 20000) break;
        }
      }
      return { blocks: n, mb: +(total / 1048576).toFixed(2) };
    });
    note('E: storage filled', filled);
    check('E: the pot was filled (something was written)', filled.blocks > 0, true);
    await pg.selectOption('#root', 'C');
    await pg.waitForTimeout(500);
    check('E: the select reaches the engine with the pot full', (await params(pg)).root, 'C');
    const storedFull = await stored(pg, 'ambi4:generator');
    note('E: stored root with the pot full', storedFull?.root);
    const s1 = await said(pg);
    note('E: what the page says after a write the full pot refused', s1);
    if (storedFull?.root !== 'C') check('E: a dial write the full pot refused is said', /could not be kept|not kept|storage/i.test(s1.dial), true);
    await savePreset(pg, 'full pot');
    const s2 = await said(pg);
    const presetsFull = await stored(pg, 'ambi4:presets');
    const presetLanded = Array.isArray(presetsFull) && presetsFull.some((p) => p && p.name === 'full pot');
    note('E: preset Save with the pot full', { landed: presetLanded, said: s2.dial });
    if (!presetLanded) check('E: a preset Save the full pot refused says so', /storage is full|could not be kept/i.test(s2.dial), true);
    // A Save voice the full pot refuses says "save it again" — and the
    // settings write the Save makes 250 ms later (the voice's tag), refused
    // too, must not replace it with "move it again" (2026-11-06 review).
    const padEdit = '.track-row[data-track="pad"] .voice-edit-toggle';
    await pg.$eval(padEdit, (b) => b.scrollIntoView({ block: 'center' }));
    await pg.click(padEdit);
    await pg.waitForTimeout(500);
    const voiceSaved = await pg.evaluate(() => {
      const ed = document.getElementById('voice-editor-pad');
      const name = ed?.querySelector('.ve-voice-name');
      const btn = ed?.querySelector('.ve-save-voice');
      if (!name || !btn) return false;
      name.value = 'full pot voice';
      btn.click();
      return true;
    });
    check('E: Save voice was pressed', voiceSaved, true);
    await pg.waitForTimeout(800);
    const s3 = await said(pg);
    const voicesFull = await stored(pg, 'ambi4:voices');
    const voiceLanded = JSON.stringify(voicesFull ?? null).includes('full pot voice');
    note('E: Save voice with the pot full', { landed: voiceLanded, said: s3.dial });
    if (!voiceLanded) {
      check('E: a Save voice the full pot refused says save it again', /save it again/i.test(s3.dial), true);
      check('E: …and is not overwritten by the dial-move wording', /move it again/i.test(s3.dial), false);
    }
    await clean(pg);
    await pg.selectOption('#root', 'D');
    await pg.waitForTimeout(500);
    check('E: once there is room again the next write lands', (await stored(pg, 'ambi4:generator'))?.root, 'D');
    check('E: no console or page errors', errors, []);
  }

  // ---- F. corrupt stored values at boot -------------------------------------------
  const granted = [{ name: 'ambi4-consent', value: 'granted' }];
  const CORRUPT = [
    ['not JSON', 'not json at all {'],
    ['a string', '"a string"'],
    ['a number', '42'],
    ['an array', '[1,2,3]'],
    ['wrong types', JSON.stringify({ bpm: 'abc', tracks: 'x', ui: null, harmony: 5, userTracks: 'y', complexity: [1], root: 7, mode: {}, genre: ['a'], structure: 1e308 })],
    ['prototype keys', '{"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":2}},"bpm":100}'],
    ['huge', JSON.stringify({ bpm: 90, junk: 'j'.repeat(3 * 1048576) })],
    ['NaN-ish numbers', JSON.stringify({ bpm: 1e999, complexity: -1e999, swing: 'NaN', tracks: { bass: { level: null, pan: 'NaN' } } })],
  ];
  const defaultBpm = bpmOf((await (async () => { const { pg } = await fresh({ cookies: granted }); await boot(pg); return params(pg); })()).bpm);
  for (const [label, raw] of CORRUPT) {
    const { pg, errors } = await fresh({
      cookies: granted,
      storage: { 'ambi4:generator': raw, 'ambi4:presets': '{"not":"a list"}', 'ambi4:layout': '"nope"' },
    });
    await boot(pg);
    check(`F (${label}): boots on a corrupt stored setup`, await booted(pg), true);
    const p = await params(pg);
    check(`F (${label}): the engine's tempo is a finite number`, Number.isFinite(bpmOf(p.bpm)), true);
    check(`F (${label}): nothing half-initialised`, await badText(pg), []);
    check(`F (${label}): the prototype is clean`, await pg.evaluate(() => ({}).polluted === undefined && Object.prototype.polluted === undefined), true);
    check(`F (${label}): the preset list is empty, not broken`, await listedPresets(pg), []);
    note(`F (${label}): what the page says`, await said(pg));
    await play(pg);
    check(`F (${label}): plays`, await running(pg), true);
    await stop(pg);
    check(`F (${label}): no console or page errors`, errors, []);
  }
  note('F: default tempo for reference', defaultBpm);

  // ---- G. reload while playing -------------------------------------------------------
  {
    const { pg, errors } = await fresh({ cookies: granted });
    await boot(pg);
    await pg.click('#tab-advanced');
    await pg.waitForTimeout(300);
    await pg.selectOption('#genre-select', 'g:synthwave');
    await pg.waitForFunction(() => window.__ambi4Engine?.getParams?.()?.genre === 'synthwave', { timeout: 5000 }).catch(() => {});
    await pg.selectOption('#root', 'F');
    const drag = await dragTempo(pg, 45);
    check('G: the drag reached the engine', drag.found && bpmOf(drag.after) !== bpmOf(drag.before), true);
    await play(pg);
    check('G: playing', await running(pg), true);
    await pg.waitForTimeout(1500);
    const playing = await params(pg);
    const playLabel = () => pg.evaluate(() => ({ pressed: document.getElementById('toggle-play')?.getAttribute('aria-pressed'), text: document.getElementById('toggle-play')?.textContent?.trim().slice(0, 20), label: document.getElementById('toggle-play')?.getAttribute('aria-label') }));
    const whilePlaying = await playLabel();
    await boot(pg);
    check('G: the reload boots', await booted(pg), true);
    check('G: the reload comes back stopped', await running(pg), false);
    const afterReload = await playLabel();
    note('G: the play control before and after', { whilePlaying, afterReload });
    check('G: the play control does not claim to be playing', JSON.stringify(afterReload) !== JSON.stringify(whilePlaying), true);
    check('G: settings intact across a reload while playing (differing paths)', settingDiffs(playing, await params(pg)), []);
    check('G: nothing half-initialised', await badText(pg), []);
    check('G: no console or page errors', errors, []);
  }

  // ---- H. two tabs on one store ----------------------------------------------------------
  {
    const { ctx, pg: tab1, errors } = await fresh({ cookies: granted });
    await boot(tab1);
    const tab2 = await ctx.newPage();
    watch(tab2, errors);
    await boot(tab2);
    check('H: both tabs boot', (await booted(tab1)) && (await booted(tab2)), true);
    for (const t of [tab1, tab2]) { await t.click('#tab-advanced'); await t.waitForTimeout(250); }
    await tab1.selectOption('#root', 'F');
    await tab1.waitForTimeout(450);
    await tab2.selectOption('#root', 'G');
    await tab2.waitForTimeout(450);
    check('H: the later tab\'s write is the stored one', (await stored(tab1, 'ambi4:generator'))?.root, 'G');
    check('H: the first tab keeps its own engine value', (await params(tab1)).root, 'F');
    await tab1.selectOption('#mode', 'dorian');
    await tab1.waitForTimeout(450);
    const after = await stored(tab2, 'ambi4:generator');
    check('H: the first tab\'s next write wins whole (its root and mode)', [after?.root, after?.mode], ['F', 'dorian']);
    await tab1.bringToFront();
    await tab2.bringToFront();
    await tab2.waitForTimeout(300);
    await boot(tab2);
    const reread = await params(tab2);
    check('H: a reload of the second tab reads the last write', [reread.root, reread.mode], ['F', 'dorian']);
    check('H: no console or page errors across both tabs', errors, []);
  }

  // ---- I. hidden and shown while playing --------------------------------------------------
  {
    const { pg, errors } = await fresh({ cookies: granted });
    await boot(pg);
    await play(pg);
    check('I: playing', await running(pg), true);
    const setHidden = (hidden) => pg.evaluate((h) => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
      document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);
    await setHidden(true);
    await pg.waitForTimeout(1500);
    check('I: still playing while hidden', await running(pg), true);
    await setHidden(false);
    await pg.evaluate(() => window.dispatchEvent(new Event('focus')));
    await pg.waitForTimeout(800);
    check('I: still playing when shown again', await running(pg), true);
    await pg.click('#tab-advanced');
    await pg.waitForTimeout(250);
    await pg.selectOption('#root', 'G');
    await pg.waitForTimeout(500);
    check('I: edits still land after the round trip', (await stored(pg, 'ambi4:generator'))?.root, 'G');
    // Hidden, then Finish and Stop now: neither press is refused by the hidden path.
    await setHidden(true);
    await pg.click('#toggle-play');
    await pg.waitForTimeout(400);
    await pg.click('#toggle-play');
    await pg.waitForFunction(() => !window.__ambi4Engine.running, { timeout: 3000 }).catch(() => {});
    check('I: a stop while hidden stops', await running(pg), false);
    await setHidden(false);
    check('I: nothing half-initialised', await badText(pg), []);
    check('I: no console or page errors', errors, []);
  }

  // ---- J. ten fresh visits --------------------------------------------------------------------
  {
    const draws = [];
    const bad = [];
    const errs = [];
    for (let i = 0; i < 10; i++) {
      const { pg, errors } = await fresh();
      await boot(pg);
      if (!(await booted(pg))) { errs.push(`visit ${i}: did not boot`); continue; }
      const p = await params(pg);
      draws.push(p.genre || '(none)');
      const b = await badText(pg);
      if (b.length) bad.push({ visit: i, genre: p.genre, bad: b });
      if ((await cardShown(pg)).buttons.length !== 2) errs.push(`visit ${i}: the card was not asked`);
      if ((await ambiWrites(pg)).length) errs.push(`visit ${i}: wrote ${(await ambiWrites(pg)).join(',')}`);
      if (!Number.isFinite(bpmOf(p.bpm))) errs.push(`visit ${i}: tempo ${JSON.stringify(p.bpm)}`);
      if (errors.length) errs.push(`visit ${i}: ${errors.join(' | ')}`);
    }
    note('J: the ten opening draws', draws);
    check('J: ten fresh visits booted', draws.length, 10);
    check('J: the opening draw varies', new Set(draws).size >= 2, true);
    check('J: no visible undefined / NaN / null in any fresh visit', bad, []);
    check('J: no fresh visit wrote, failed to ask, or erred', errs, []);
  }

  for (const ctx of contexts) await ctx.close().catch(() => {});

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'first-visit-drive: ' + failed.length + ' failed\n' +
      results.filter((r) => r.want === '(informational)').map((r) => `  · ${r.name}: ${JSON.stringify(r.got)}`).join('\n') + '\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n'),
    );
  }
  return { passed: results.length, notes: results.filter((r) => r.want === '(informational)').map((r) => `${r.name}: ${JSON.stringify(r.got)}`) };
}
