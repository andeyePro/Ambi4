/**
 * A share link is a base plus a diff — and every old link still works.
 *
 *   npm run build && .vibe/measure.sh local drive tests/sharelink-drive.mjs
 *
 * His note: "share links should use the same base-and-diff. They still base64
 * the whole tree into the fragment, which is the same fault in a place that
 * has not bitten yet — a fragment is not sent to a server, so it fails later
 * and quieter (a link too long to paste into a chat window)."
 *
 * Four properties, and the last is the one that matters most:
 *
 *  1. a link off a genre is SHORT — the tree it replaces was six figures;
 *  2. an untouched setup round-trips to the same settings, which is what
 *     proves the base is rebuilt exactly rather than approximately;
 *  3. an edited setup carries the edit and nothing else;
 *  4. a WHOLE-TREE link — the form every link in the wild is written in —
 *     still loads. That branch is permanent, not transitional: links live in
 *     other people's chat logs forever.
 */

const settingsNow = (page) =>
  page.evaluate(() => {
    const p = window.__ambi4Engine.getParams();
    return JSON.stringify({
      bpm: p.bpm, root: p.root, mode: p.mode, structure: p.structure,
      complexity: p.complexity, harmony: p.harmony,
      levels: Object.fromEntries(Object.keys(p.tracks).map((k) => [k, p.tracks[k].level])),
    });
  });

/**
 * The link the Share button produced, re-pointed at the page under test.
 * SHARE_BASE is the production origin by design — a link has to be openable
 * by whoever it is sent to — so following one verbatim would navigate the
 * browser off the build being tested and prove nothing about it.
 */
const local = (page, url) =>
  page.evaluate((u) => location.origin + location.pathname + new URL(u).hash, url);

/**
 * Open a share link so the page actually BOOTS on it.
 *
 * A plain goto to a URL differing only in its fragment is a same-document
 * navigation: nothing reloads, no share payload is read, and every assertion
 * after it passes trivially against the page that was already there. The first
 * three checks in this file were vacuous until this helper existed — which is
 * exactly the failure it now prevents.
 */
const openLink = async (page, url) => {
  await page.goto('about:blank');
  await page.goto(url);
  await page.waitForTimeout(2500);
};

const shareUrl = async (page) => {
  await page.evaluate(() => {
    window.__copied = null;
    // The button prefers the clipboard, which headless Chromium refuses
    // without a permission grant — and a refused copy prints the link in the
    // note instead. Capture it at the source rather than depending on which
    // of those two paths the browser takes today.
    navigator.clipboard.writeText = (text) => { window.__copied = text; return Promise.resolve(); };
  });
  await page.click('#preset-share');
  await page.waitForTimeout(700);
  return page.evaluate(() => window.__copied);
};

export default async function drive(page) {
  const results = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
  };

  await page.click('#consent-slot button:has-text("Save on this device")').catch(() => {});
  await page.waitForTimeout(200);
  await page.click('#tab-advanced');
  await page.waitForTimeout(600);

  // 1. Straight off whatever genre the visit opened on.
  const clean = await shareUrl(page);
  check('Share produced a link', !!clean, (v) => v === true);
  // The old form ran to six figures. Two thousand is the figure even a strict
  // chat client will carry without folding it.
  check('the link is short enough to paste anywhere', clean.length < 2000, (v) => v === true);
  results.push({ name: 'clean link length', ok: true, got: clean.length, want: '(informational)' });

  const beforeReload = await settingsNow(page);

  // 2. Follow it. An untouched setup must come back byte-for-byte — if the
  // base were rebuilt even slightly differently, this is where it shows.
  await openLink(page, await local(page, clean));
  check('an untouched setup round-trips exactly', await settingsNow(page), beforeReload);
  const note = await page.evaluate(() =>
    document.getElementById('share-note')?.textContent || '');
  check('and the base was rebuilt, not substituted',
    !/could not be rebuilt/.test(note), (v) => v === true);

  // 3. Now edit, share, follow — the edit has to survive.
  await page.click('#tab-advanced');
  await page.waitForTimeout(400);
  await page.selectOption('#root', 'F');
  await page.selectOption('#mode', 'dorian');
  await page.waitForTimeout(600);
  const edited = await settingsNow(page);
  const editedUrl = await shareUrl(page);
  check('an edited link is still short', editedUrl.length < 2400, (v) => v === true);
  results.push({ name: 'edited link length', ok: true, got: editedUrl.length, want: '(informational)' });
  await openLink(page, await local(page, editedUrl));
  check('the edit survives the round trip', await settingsNow(page), edited);

  // 4. The permanent shim. A whole-tree payload is what every link minted
  // before this version carries, and it must load forever.
  const legacy = await page.evaluate(() => {
    // Built the way the OLD encoder built it: the trimmed whole tree, no
    // origin, no diff.
    const p = window.__ambi4Engine.getParams();
    const payload = { ...p, v: 1 };
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    const b64 = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `${location.origin}${location.pathname}#p=${b64}`;
  });
  await openLink(page, legacy);
  const legacyLoaded = await page.evaluate(() => ({
    booted: !!document.getElementById('generator-app') && !document.getElementById('generator-app').hidden,
    note: document.getElementById('share-note')?.textContent || '',
  }));
  check('a whole-tree link still boots the page', legacyLoaded.booted, (v) => v === true);
  check('and is announced as a shared preset', /Save to keep it/.test(legacyLoaded.note), (v) => v === true);
  results.push({ name: 'legacy note', ok: true, got: legacyLoaded.note, want: '(informational)' });

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'sharelink-drive: ' + failed.length + ' failed\n' + JSON.stringify(results.filter((r)=>r.want==='(informational)')) + '\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n'),
    );
  }
  return { passed: results.length, notes: results.filter((r) => r.want === '(informational)').map((r) => `${r.name}: ${JSON.stringify(r.got)}`) };
}
