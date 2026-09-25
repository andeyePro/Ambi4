/**
 * rule-control.js — the ONE shape every rule the engine obeys is shown in
 * (owner ruling 2026-09-25; docs/dial-control-plane-plan.md § 5).
 *
 *   NOW     the value playing, editable — a picker or a dial the page mounts.
 *   CHANCE  how likely a redraw is, 0 holds Now for good, with a WHEN of bar,
 *           section or piece — a dial the page mounts, the When this module's.
 *   POOL    the ordered, weighted list a redraw may pick from, by weight or in
 *           turn — summarised here, edited through the page's own editor.
 *
 * Disclosure is a global LEVEL plus in-place expand: Simple shows Now,
 * Advanced adds Chance, Expert adds Pool; the "more" button opens the next
 * hidden layer whatever the level, and a mark on Now says something is set
 * beneath. Pure DOM, no engine import: the page hands in what each layer
 * shows and what to do when it is touched, exactly as knob.js is handed a
 * value and an onInput.
 */

export const RULE_LEVELS = Object.freeze(['simple', 'advanced', 'expert']);
export const RULE_LAYERS = Object.freeze(['now', 'chance', 'pool']);
export const RULE_LEVEL_LABELS = Object.freeze({
  simple: 'What plays',
  advanced: '+ Chance',
  expert: '+ Pool',
});
export const RULE_WHEN = Object.freeze([
  ['bar', 'each bar'],
  ['section', 'each section'],
  ['piece', 'each piece'],
]);

/** Is `layer` shown at `level` before any in-place expand? */
export function layerShown(level, layer) {
  const li = RULE_LEVELS.indexOf(level);
  const la = RULE_LAYERS.indexOf(layer);
  if (la < 0) return false;
  return (li < 0 ? 0 : li) >= la;
}

/** A pool as one readable line: "Keys › Tines › Bell · by weight", or "empty". */
export function poolSummary(pool, order, labelOf = (id) => id) {
  const rows = Array.isArray(pool) ? pool.filter((entry) => entry && typeof entry.id === 'string') : [];
  if (!rows.length) return 'empty — the voice you picked, and only that';
  const names = rows.map((entry) => {
    const w = Number(entry.weight);
    return Number.isFinite(w) && w !== 1 && order !== 'turn' ? `${labelOf(entry.id)} ×${Math.round(w)}` : labelOf(entry.id);
  });
  return `${names.join(' › ')} · ${order === 'turn' ? 'in turn' : 'by weight'}`;
}

/** A chance as a word: Hold, Auto (follows Randomness) or a percentage. */
export function chanceSummary(chance) {
  if (chance === null || chance === undefined) return 'follows Randomness';
  const n = Number(chance);
  if (!Number.isFinite(n) || n <= 0) return 'Hold';
  return `${Math.round(n * 100)}%`;
}

/**
 * Mount one rule into `host`.
 *
 * spec = {
 *   id, name,                       // 'voice', 'Voice'
 *   level,                          // the global level at mount
 *   describe(el, text),             // the page's tooltip + description helper (optional)
 *   now:    { text, hint, onOpen }, // the value playing; onOpen focuses its control
 *   chance: { hint, when, onWhen, whenIds: { select } },  // the dial is mounted into handle.chanceSlot by the page
 *   pool:   { rows, order, labelOf, hint, onEdit, ids: { edit } },
 * }
 */
export function createRule(host, spec) {
  const doc = host.ownerDocument;
  const el = doc.createElement('div');
  el.className = 'rule';
  el.dataset.rule = spec.id;
  el.dataset.level = RULE_LEVELS.includes(spec.level) ? spec.level : 'simple';
  el.dataset.expanded = '0';
  const describe = typeof spec.describe === 'function' ? spec.describe : () => {};

  // -- Now
  const now = doc.createElement('div');
  now.className = 'rule-layer rule-now';
  now.dataset.layer = 'now';
  const name = doc.createElement('span');
  name.className = 'rule-name';
  name.textContent = spec.name;
  const nowValue = doc.createElement('button');
  nowValue.type = 'button';
  nowValue.className = 'rule-now-value';
  nowValue.textContent = spec.now && spec.now.text ? spec.now.text : '';
  nowValue.addEventListener('click', () => { if (spec.now && typeof spec.now.onOpen === 'function') spec.now.onOpen(); });
  if (spec.now && spec.now.hint) describe(nowValue, spec.now.hint);
  const mark = doc.createElement('span');
  mark.className = 'rule-mark';
  mark.textContent = '·';
  mark.title = 'Chance or pool is set beneath';
  mark.hidden = true;
  now.append(name, nowValue, mark);

  // -- Chance
  const chance = doc.createElement('div');
  chance.className = 'rule-layer rule-chance';
  chance.dataset.layer = 'chance';
  const chanceName = doc.createElement('span');
  chanceName.className = 'rule-layer-name';
  chanceName.textContent = 'Chance';
  const chanceSlot = doc.createElement('div');
  chanceSlot.className = 'rule-chance-slot';
  const when = doc.createElement('select');
  when.className = 'genre-select rule-when';
  if (spec.chance && spec.chance.whenIds && spec.chance.whenIds.select) when.id = spec.chance.whenIds.select;
  when.setAttribute('aria-label', `${spec.name}: when a redraw may happen`);
  for (const [value, text] of RULE_WHEN) {
    const option = doc.createElement('option');
    option.value = value;
    option.textContent = text;
    when.append(option);
  }
  when.value = spec.chance && RULE_WHEN.some(([v]) => v === spec.chance.when) ? spec.chance.when : 'bar';
  when.addEventListener('change', () => { if (spec.chance && typeof spec.chance.onWhen === 'function') spec.chance.onWhen(when.value); });
  describe(when, 'When the redraw may happen: at every bar, at every new section, or once per piece.');
  chance.append(chanceName, chanceSlot, when);

  // -- Pool
  const pool = doc.createElement('div');
  pool.className = 'rule-layer rule-pool';
  pool.dataset.layer = 'pool';
  const poolName = doc.createElement('span');
  poolName.className = 'rule-layer-name';
  poolName.textContent = 'Pool';
  const poolText = doc.createElement('span');
  poolText.className = 'rule-pool-summary';
  const poolEdit = doc.createElement('button');
  poolEdit.type = 'button';
  poolEdit.className = 'secondary-button rule-pool-edit';
  if (spec.pool && spec.pool.ids && spec.pool.ids.edit) poolEdit.id = spec.pool.ids.edit;
  poolEdit.textContent = 'Edit…';
  poolEdit.addEventListener('click', () => { if (spec.pool && typeof spec.pool.onEdit === 'function') spec.pool.onEdit(); });
  if (spec.pool && spec.pool.hint) describe(poolEdit, spec.pool.hint);
  pool.append(poolName, poolText, poolEdit);

  // -- more / less
  const more = doc.createElement('button');
  more.type = 'button';
  more.className = 'rule-more';
  more.setAttribute('aria-expanded', 'false');
  more.addEventListener('click', () => {
    const level = el.dataset.level;
    const expanded = Number(el.dataset.expanded) || 0;
    const hiddenLayers = RULE_LAYERS.filter((layer, i) => !layerShown(level, layer) && i > expanded);
    el.dataset.expanded = hiddenLayers.length ? String(RULE_LAYERS.indexOf(hiddenLayers[0])) : '0';
    apply();
  });

  el.append(now, chance, pool, more);
  host.append(el);

  function apply() {
    const level = el.dataset.level;
    const expanded = Number(el.dataset.expanded) || 0;
    let anyHidden = false;
    for (const layer of [now, chance, pool]) {
      const i = RULE_LAYERS.indexOf(layer.dataset.layer);
      const shown = layerShown(level, layer.dataset.layer) || i <= expanded;
      layer.hidden = !shown;
      if (!shown) anyHidden = true;
    }
    more.hidden = layerShown(level, 'pool');
    more.textContent = anyHidden ? 'more' : 'less';
    more.setAttribute('aria-expanded', anyHidden ? 'false' : 'true');
    more.setAttribute('aria-label', anyHidden ? `${spec.name}: show the next layer` : `${spec.name}: fold back to the level`);
  }

  function setPool(rows, order) {
    poolText.textContent = poolSummary(rows, order, spec.pool && spec.pool.labelOf);
  }
  function setMark(on) { mark.hidden = !on; }
  function setNow(text) { nowValue.textContent = text; }
  function setLevel(level) {
    el.dataset.level = RULE_LEVELS.includes(level) ? level : 'simple';
    el.dataset.expanded = '0';
    apply();
  }
  function setWhen(value) { if (RULE_WHEN.some(([v]) => v === value)) when.value = value; }

  setPool(spec.pool ? spec.pool.rows : [], spec.pool ? spec.pool.order : 'weight');
  apply();
  return { el, chanceSlot, when, setPool, setMark, setNow, setLevel, setWhen };
}
