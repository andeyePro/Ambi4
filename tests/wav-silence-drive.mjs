/**
 * Save as WAV keeps silence as silence — the file is as long as the take.
 *
 *   npm run build && .vibe/measure.sh local drive tests/wav-silence-drive.mjs
 *
 * The WAV tap is an AudioWorklet off the output. The Web Audio spec gives a
 * worklet's input ZERO channels when nothing upstream is actively
 * processing, and the tap posted nothing then — so a stretch where every
 * track was quiet could be cut out of the file, shortening the take and
 * shifting everything after it (2026-11-06 hunt, unconfirmed in Node). This
 * records four seconds of music and four seconds with every track off, under
 * the dev unlock (Save as WAV is hidden before launch), and reads the length
 * the page reports for each file.
 */

const statusText = (page) => page.evaluate(() => document.getElementById('wav-status')?.textContent || '');
const secondsOf = (text) => {
  const m = /Saved (\d+):(\d\d)/.exec(text);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

export default async function drive(page) {
  const results = [];
  const check = (name, got, want) => {
    const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want: typeof want === 'function' ? '(predicate)' : want });
  };
  const url = page.url();
  await page.evaluate(() => { try { localStorage.setItem('ambi4:dev', '1'); } catch {} });
  await page.goto('about:blank');
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('#generator-app:not([hidden])', { timeout: 20000 });
  await page.waitForTimeout(800);
  await page.click('#consent-slot button:has-text("Save on this device")').catch(() => {});
  // Downloads are not the point here; the page's own report of the length is.
  await page.evaluate(() => { HTMLAnchorElement.prototype.click = function () {}; });

  await page.click('#toggle-play');
  await page.waitForTimeout(3000);
  const take = async (ms) => {
    await page.click('#wav-save');
    await page.waitForTimeout(ms);
    await page.click('#wav-save');
    await page.waitForTimeout(1500);
    return statusText(page);
  };

  const music = await take(4000);
  check('a take of four seconds of music is saved as about four seconds', secondsOf(music), (s) => s !== null && s >= 3 && s <= 5);

  // Every track off, and the reverb's longest tail rung out first.
  await page.evaluate(() => {
    const e = window.__ambi4Engine;
    const tracks = Object.fromEntries(Object.keys(e.getParams().tracks).map((k) => [k, { state: 'off' }]));
    e.setParams({ tracks });
  });
  await page.waitForTimeout(8000);
  const silence = await take(4000);
  check('a take of four seconds with every track off is ALSO about four seconds (silence kept, not dropped)', secondsOf(silence), (s) => s !== null && s >= 3 && s <= 5);
  results.push({ name: 'what the page said', ok: true, got: { music, silence }, want: '(informational)' });

  await page.evaluate(() => { try { localStorage.removeItem('ambi4:dev'); } catch {} });
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    throw new Error(
      'wav-silence-drive: ' + failed.length + ' failed\n' +
      failed.map((r) => `  ✗ ${r.name}\n      got  ${JSON.stringify(r.got)}\n      want ${JSON.stringify(r.want)}`).join('\n') +
      '\n' + JSON.stringify(results.filter((r) => r.want === '(informational)')),
    );
  }
  return { passed: results.length, notes: results.filter((r) => r.want === '(informational)') };
}
