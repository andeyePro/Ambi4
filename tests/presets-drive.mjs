/**
 * Presets, in a real browser, asserted at the ENGINE and in localStorage.
 *
 *   npm run build && .vibe/measure.sh local drive tests/presets-drive.mjs
 *
 * hostile-prefs covers a damaged stored list in jsdom; nothing drove the
 * preset row itself in a browser. Here: Save; Save again under the same name
 * (an overwrite, never a second entry — v0.0.282); Load, compared to the
 * engine's getParams() at the moment of the Save, every path; a "rename"
 * (Save under a new name, Delete the old — there is no rename control);
 * a 75-character NEW name cut to 60; a 70-character name stored by an older
 * build that saves back onto itself; 100 presets stored, a 101st refused and
 * an existing name still saved; a reload with all of it in localStorage;
 * Delete with nothing chosen. Console and page errors fail the drive.
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
// dial, beat for Energy) — the engine keeps the last ask, the page stores
// none, and nothing reproduced depends on it. Not a setting; not compared.
const NOT_A_SETTING = ['tempoLanding'];
const settingDiffs = (a, b) => diffPaths(a, b).filter((line) => !NOT_A_SETTING.some((k) => line.startsWith(`${k}:`)));

const engineParams = (page) =>
  page.evaluate(() => JSON.parse(JSON.stringify(window.__ambi4Engine.getParams())));

const stored = (page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('ambi4:presets') || '[]').map((p) => p.name));

const listed = (page) =>
  page.evaluate(() => [...document.querySelectorAll('#preset-load option')].slice(1).map((o) => o.textContent));

const openFoldFor = async (page, selector) => {
  const more = await page.evaluate((s) => (typeof window.__ambi4FoldMore === 'function' ? window.__ambi4FoldMore(s) : null), selector);
  if (more) {
    await page.click(more);
    await page.waitForTimeout(150);
  }
};

export default async function drive(page) {
  const results = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
  };
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e && e.message ? e.message : e}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 200)}`); });

  const home = await page.evaluate(() => location.origin + location.pathname);
  const boot = async () => {
    await page.goto('about:blank');
    await page.goto(home);
    await page.waitForTimeout(2500);
    await page.click('#consent-slot button:has-text("Save on this device")').catch(() => {});
    await page.waitForTimeout(250);
    await page.click('#tab-advanced');
    await page.waitForTimeout(400);
    await openFoldFor(page, '#preset-save');
  };
  const save = async (name) => {
    await page.evaluate((n) => { document.getElementById('preset-name').value = n; }, name);
    await page.click('#preset-save');
    await page.waitForTimeout(300);
  };
  const load = async (name) => {
    const value = await page.evaluate((n) => [...document.querySelectorAll('#preset-load option')].find((o) => o.textContent === n)?.value ?? null, name);
    if (value === null) throw new Error(`presets-drive: the picker does not list ${JSON.stringify(name)}`);
    await page.selectOption('#preset-load', value);
    await page.waitForTimeout(600);
  };
  const confirmLine = () => page.evaluate(() => document.getElementById('dial-confirm')?.textContent?.trim() || '');

  await boot();
  await page.selectOption('#genre-select', 'g:synthwave');
  await page.waitForFunction(() => window.__ambi4Engine?.getParams?.()?.genre === 'synthwave', { timeout: 5000 }).catch(() => {});
  await page.selectOption('#root', 'F');
  await page.waitForTimeout(400);

  // ---- Save, then Save again under the same name -------------------------
  await save('alpha');
  check('Save stores one preset', await stored(page), ['alpha']);
  await page.selectOption('#root', 'G');
  await page.waitForTimeout(400);
  const atSecondSave = await engineParams(page);
  await save('alpha');
  check('Save under the same name overwrites, never copies', await stored(page), ['alpha']);
  const storedRoot = await page.evaluate(() => JSON.parse(localStorage.getItem('ambi4:presets'))[0].params.root);
  check('and the overwrite holds the new value', storedRoot, 'G');

  // ---- Load: the engine comes back to the moment of the Save --------------
  await page.selectOption('#root', 'A');
  await page.selectOption('#mode', 'lydian');
  await page.waitForTimeout(400);
  check('the setup moved away from the preset', (await engineParams(page)).root !== atSecondSave.root, true);
  await load('alpha');
  check('Load restores the engine exactly (differing paths)', settingDiffs(atSecondSave, await engineParams(page)), []);
  check('Load names the preset in the name box', await page.inputValue('#preset-name'), 'alpha');

  // ---- "rename": Save as a new name, Delete the old ------------------------
  await save('beta');
  check('a new name is a second preset', await stored(page), ['alpha', 'beta']);
  await load('alpha');
  await page.click('#preset-delete');
  await page.waitForTimeout(300);
  check('Delete removes the chosen preset only', await stored(page), ['beta']);
  check('and the picker agrees', await listed(page), ['beta']);
  await page.click('#preset-delete'); // nothing chosen now
  await page.waitForTimeout(200);
  check('Delete with nothing chosen deletes nothing', await stored(page), ['beta']);

  // ---- names: a long NEW name is cut; a long STORED name saves onto itself -
  const long75 = 'L'.repeat(75);
  await save(long75);
  const names1 = await stored(page);
  check('a 75-character new name is cut to 60', names1.map((n) => n.length), [4, 60]);
  const old70 = 'O'.repeat(70);
  await page.evaluate((n) => {
    const list = JSON.parse(localStorage.getItem('ambi4:presets'));
    list.push({ name: n, params: list[0].params });
    localStorage.setItem('ambi4:presets', JSON.stringify(list));
  }, old70);
  await boot();
  check('a 70-character stored name is listed after a reload', (await listed(page)).includes(old70), true);
  await load(old70);
  await save(old70);
  check('saving a long stored name back overwrites it (v0.0.282)', (await stored(page)).filter((n) => n.startsWith('O')).length, 1);

  // ---- the store is full: a Save that cannot be kept must say so ----------
  // localStorage is a 5 MB per-origin pot. Filled to within a few hundred
  // characters, the next Save's prefs.set throws quota, falls back to session
  // memory and returns false — the picker lists the preset, nothing says it
  // was not kept, and a reload loses it. Red on v0.0.284.
  await page.evaluate(() => {
    let n = 0;
    for (const size of [1 << 18, 1 << 14, 1 << 10, 1 << 9]) {
      const chunk = 'x'.repeat(size);
      for (let i = 0; i < 100000; i++) {
        try { localStorage.setItem(`filler${n}`, chunk); n += 1; } catch { break; }
      }
    }
  });
  await save('full');
  const full = await page.evaluate(() => ({
    listed: [...document.querySelectorAll('#preset-load option')].slice(1).map((o) => o.textContent).includes('full'),
    stored: JSON.parse(localStorage.getItem('ambi4:presets') || '[]').some((p) => p.name === 'full'),
    said: document.getElementById('dial-confirm')?.textContent?.trim() || '',
  }));
  check('a Save the store refused is not in localStorage', full.stored, false);
  check('…and the page SAYS it could not be kept', /storage is full/i.test(full.said), true);
  results.push({ name: 'full-store Save', ok: true, got: full, want: '(informational)' });
  await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('filler')) localStorage.removeItem(k); });

  // ---- the cap: 100 stored, a new name refused, an existing one kept ------
  await page.evaluate(() => {
    const base = JSON.parse(localStorage.getItem('ambi4:presets'))[0].params;
    const list = [];
    for (let i = 1; i <= 100; i++) list.push({ name: `p${String(i).padStart(3, '0')}`, params: base });
    localStorage.setItem('ambi4:presets', JSON.stringify(list));
  });
  await boot();
  check('100 stored presets are all listed', (await listed(page)).length, 100);
  await save('overflow');
  check('a 101st preset is refused', (await stored(page)).length, 100);
  check('and the refusal is said under the dials', /100 presets/.test(await confirmLine()), true);
  await page.selectOption('#root', 'D');
  await page.waitForTimeout(400);
  const atCapSave = await engineParams(page);
  await save('p050');
  check('an existing name still saves at the cap', (await stored(page)).length, 100);
  await page.selectOption('#root', 'E');
  await page.waitForTimeout(400);
  await load('p050');
  check('the overwritten preset loads to the engine exactly (differing paths)', settingDiffs(atCapSave, await engineParams(page)), []);
  await boot();
  check('the 100 presets survive another reload', (await listed(page)).length, 100);
  check('localStorage still holds them', (await stored(page)).length, 100);

  check('no console errors or page errors', errors, []);

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'presets-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n'),
    );
  }
  return { passed: results.length };
}
