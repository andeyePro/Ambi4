/**
 * What the Submit button actually puts in a URL.
 *
 *   npm run build && .vibe/measure.sh local drive tests/submit-drive.mjs
 *
 * The owner pressed Submit and got ERR_CONNECTION_CLOSED. The cause was not
 * the form: the button built a URL out of the entire settings tree, and it came
 * to 115,897 characters. Browsers cap a URL between two and eight thousand and
 * Cloudflare closes the connection on a long one, so the failure arrived as a
 * dead socket rather than as anything anyone could read.
 *
 * His fix, and it is the right one: send the ID of the genre or preset it is
 * based on plus a diff. This proves the three properties that makes that work —
 * the URL is short, the provenance is real, and an untouched setup carries an
 * EMPTY diff, which is the property that proves the base is being reproduced
 * exactly rather than approximately.
 */

const submitUrl = async (page) => {
  await page.evaluate(() => { window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; });
  await page.click('#preset-submit');
  await page.waitForTimeout(700);
  return page.evaluate(() => window.__opened.pop() || null);
};

const messageOf = (url) => {
  if (!url) return null;
  const m = /[?&]message=([^&]*)/.exec(url);
  return m ? decodeURIComponent(m[1]) : null;
};

const isObjectLike = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

export default async function drive(page) {
  const results = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
  };

  await page.click('#tab-advanced');
  await page.waitForTimeout(400);

  // 1. Straight off the genre the page opened on.
  const clean = await submitUrl(page);
  check('Submit produced a URL', !!clean, (v) => v === true);
  // 2,000 is the figure even the strictest stack allows; the handler caps at
  // 1,800 to leave room for the base and the other params.
  check('the URL is inside every browser and CDN limit', clean.length < 2000, (v) => v === true);
  check('the form is told which site sent it', /[?&]source=/.test(clean), (v) => v === true);

  const cleanBody = messageOf(clean);
  check('it is not the fallback — a clean preset fits', !/too long/.test(cleanBody || ''), (v) => v === true);
  let parsed = null;
  try { parsed = JSON.parse(cleanBody); } catch { /* asserted below */ }
  check('the message is parseable JSON', !!parsed, (v) => v === true);
  check('it names what the preset grew from', parsed?.origin?.kind, 'genre');
  check('and the exact compile, not just the genre', Number.isFinite(parsed?.origin?.seed), (v) => v === true);
  // The load-bearing one. An untouched setup diffing to nothing proves the
  // base is being rebuilt byte-for-byte from (slug, seed) — if the rebuild
  // were even slightly off, every field it got wrong would show up here.
  check('an untouched setup carries an EMPTY diff', Object.keys(parsed?.diff || {}), []);
  results.push({ name: 'clean URL length', ok: true, got: clean.length, want: '(informational)' });

  // 2. After real edits, the diff names only what moved.
  await page.evaluate(() => {
    for (const k of [...document.querySelectorAll('#panel-advanced .knob')].slice(0, 5)) {
      for (let i = 0; i < 4; i++) k.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    }
  });
  await page.waitForTimeout(500);
  const edited = await submitUrl(page);
  check('still inside the limit after editing', edited.length < 2000, (v) => v === true);
  const editedBody = messageOf(edited);
  let parsed2 = null;
  try { parsed2 = JSON.parse(editedBody); } catch { /* asserted below */ }
  // AUDIT FIX (vacuous test): every diff assertion used to sit inside an
  // `if (parsed2 && parsed2.diff)`, so an unparseable message — or a missing
  // diff, which is the very failure this file exists to catch — skipped the
  // whole second half SILENTLY and the drive still reported green.
  check('the edited message is parseable JSON', !!parsed2, (v) => v === true);
  check('…and carries a diff', isObjectLike(parsed2 && parsed2.diff), (v) => v === true);
  const keys = Object.keys((parsed2 && parsed2.diff) || {});
  check('the diff is non-empty once something moved', keys.length > 0, (v) => v === true);
  // A diff carrying the whole tree would mean the base is not being
  // reproduced — the exact failure this design replaces.
  check('and does not carry the whole tree', keys.length < 10, (v) => v === true);
  // AUDIT: an Energy move re-shapes the genre's kit, which is a FUNCTION of
  // (genre, seed, shaping) — the origin records the shaping, so the diff must
  // stay small instead of carrying every kit lane (that pushed a submission
  // past the URL ceiling into the clipboard fallback, silently).
  check('a re-shaped kit rides the ORIGIN, not the diff', editedBody.length < 2000, (v) => v === true);
  results.push({ name: 'edited body length', ok: true, got: editedBody.length, want: '(informational)' });
  results.push({ name: 'edited diff keys', ok: true, got: keys, want: '(informational)' });
  results.push({ name: 'edited URL length', ok: true, got: edited.length, want: '(informational)' });

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'submit-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n'),
    );
  }
  return { passed: results.length, notes: results.filter((r) => r.want === '(informational)').map((r) => `${r.name}: ${JSON.stringify(r.got)}`) };
}
