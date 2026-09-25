/**
 * v0.0.196 — the rule primitive (src/scripts/rule-control.js), in jsdom.
 *
 *   node tests/rule-control-smoke.mjs
 *
 * One shape for every rule: Now, Chance (with When), Pool. The level decides
 * which layers open by default; "more" opens the next whatever the level; the
 * summaries say what a pool and a chance are in words.
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const mod = await import('../src/scripts/rule-control.js');
const { createRule, layerShown, poolSummary, chanceSummary, RULE_LEVELS } = mod;
const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
const doc = dom.window.document;

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('layerShown: simple = Now, advanced = + Chance, expert = + Pool', () => {
  assert.deepEqual(RULE_LEVELS, ['simple', 'advanced', 'expert']);
  assert.equal(layerShown('simple', 'now'), true);
  assert.equal(layerShown('simple', 'chance'), false);
  assert.equal(layerShown('advanced', 'chance'), true);
  assert.equal(layerShown('advanced', 'pool'), false);
  assert.equal(layerShown('expert', 'pool'), true);
  assert.equal(layerShown('nonsense', 'now'), true, 'an unknown level reads as simple');
});

test('poolSummary and chanceSummary say it in words', () => {
  assert.equal(poolSummary([], 'weight'), 'empty — the voice you picked, and only that');
  assert.equal(poolSummary([{ id: 'keys', weight: 1 }, { id: 'tines', weight: 3 }], 'weight', (id) => id.toUpperCase()), 'KEYS › TINES ×3 · by weight');
  assert.equal(poolSummary([{ id: 'keys', weight: 1 }, { id: 'tines', weight: 3 }], 'turn'), 'keys › tines · in turn');
  assert.equal(chanceSummary(null), 'follows Randomness');
  assert.equal(chanceSummary(0), 'Hold');
  assert.equal(chanceSummary(0.25), '25%');
});

test('createRule: the level hides layers, "more" opens the next, a level change folds back', () => {
  const host = doc.getElementById('host');
  host.innerHTML = '';
  const seen = { when: null, opened: 0, edited: 0 };
  const handle = createRule(host, {
    id: 'voice', name: 'Voice', level: 'simple',
    now: { text: 'Keys', onOpen: () => { seen.opened += 1; } },
    chance: { when: 'section', whenIds: { select: 'when-voice' }, onWhen: (v) => { seen.when = v; } },
    pool: { rows: [{ id: 'keys', weight: 1 }], order: 'weight', ids: { edit: 'edit-voice' }, onEdit: () => { seen.edited += 1; } },
  });
  const el = host.querySelector('.rule[data-rule="voice"]');
  assert.ok(el, 'the rule mounts with its id');
  const layer = (name) => el.querySelector(`.rule-layer[data-layer="${name}"]`);
  assert.equal(layer('now').hidden, false);
  assert.equal(layer('chance').hidden, true, 'simple hides Chance');
  assert.equal(layer('pool').hidden, true, 'simple hides Pool');
  const more = el.querySelector('.rule-more');
  assert.equal(more.textContent, 'more');
  more.click();
  assert.equal(layer('chance').hidden, false, '"more" opens Chance in place');
  assert.equal(layer('pool').hidden, true);
  more.click();
  assert.equal(layer('pool').hidden, false, '"more" again opens Pool');
  assert.equal(more.textContent, 'less');
  more.click();
  assert.equal(layer('chance').hidden, true, '"less" folds back to the level');
  handle.setLevel('expert');
  assert.equal(layer('pool').hidden, false, 'expert shows every layer');
  assert.equal(more.hidden, true, 'nothing left to open');
  handle.setLevel('advanced');
  assert.equal(layer('chance').hidden, false);
  assert.equal(layer('pool').hidden, true);
  // the parts the page wires
  assert.ok(handle.chanceSlot instanceof dom.window.HTMLElement, 'a slot for the page\'s dial');
  const when = doc.getElementById('when-voice');
  assert.equal(when.value, 'section');
  when.value = 'piece';
  when.dispatchEvent(new dom.window.Event('change'));
  assert.equal(seen.when, 'piece');
  doc.getElementById('edit-voice').click();
  assert.equal(seen.edited, 1);
  el.querySelector('.rule-now-value').click();
  assert.equal(seen.opened, 1);
  assert.equal(el.querySelector('.rule-pool-summary').textContent, 'keys · by weight');
  handle.setPool([{ id: 'keys', weight: 1 }, { id: 'bell', weight: 1 }], 'turn');
  assert.equal(el.querySelector('.rule-pool-summary').textContent, 'keys › bell · in turn');
  assert.equal(el.querySelector('.rule-mark').hidden, true);
  handle.setMark(true);
  assert.equal(el.querySelector('.rule-mark').hidden, false);
  handle.setNow('Tines');
  assert.equal(el.querySelector('.rule-now-value').textContent, 'Tines');
});

let failures = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`ok   ${name}`); }
  catch (error) { failures += 1; console.error(`FAIL ${name}\n     ${error.message}`); }
}
console.log(`${tests.length - failures}/${tests.length} passed`);
if (failures) process.exit(1);
