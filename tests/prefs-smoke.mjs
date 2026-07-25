/**
 * Smoke test for src/scripts/prefs.js — run with:
 *   node tests/prefs-smoke.mjs
 *
 * Phase 1 imports the module in bare node (no document, no localStorage) and
 * proves it degrades to memory-only. Phase 2 installs mocks — a cookie jar
 * honouring enough Max-Age semantics for the consent cookie, a Storage-shaped
 * localStorage, and a minimal DOM — then exercises the full contract: consent
 * lifecycle, memory-before-consent + flush-on-grant, namespace-only wipe on
 * denial, JSON round-trips, corrupt-entry recovery, quota fallback, and the
 * inline consent prompt.
 */

import assert from 'node:assert/strict';

let passed = 0;
function ok(name, fn) {
  fn();
  passed += 1;
  console.log('  ok - ' + name);
}
async function okAsync(name, fn) {
  await fn();
  passed += 1;
  console.log('  ok - ' + name);
}

// --------------------------------------------------------------------------
// Phase 1: bare node — import before any mocks exist.
// --------------------------------------------------------------------------

assert.equal(typeof document, 'undefined', 'test must start in bare node');
assert.equal(typeof localStorage, 'undefined', 'test must start in bare node');

const { prefs, consentPrompt } = await import('../src/scripts/prefs.js');

console.log('bare node (no document, no localStorage)');

ok('consent() is null', () => {
  assert.equal(prefs.consent(), null);
});

ok('set() falls back to memory and returns false', () => {
  assert.equal(prefs.set('bare', { a: 1 }), false);
  assert.deepEqual(prefs.get('bare'), { a: 1 });
});

ok('remove() clears the memory layer without throwing', () => {
  prefs.remove('bare');
  assert.equal(prefs.get('bare'), null);
});

ok('setConsent() does not throw without a document', () => {
  prefs.setConsent(true);
  assert.equal(prefs.consent(), null, 'no cookie jar → still unasked');
});

await okAsync('consentPrompt resolves false and renders nothing', async () => {
  const fakeContainer = { children: [], appendChild() { throw new Error('must not render'); } };
  assert.equal(await consentPrompt(fakeContainer, 'hi'), false);
  assert.equal(fakeContainer.children.length, 0);
});

// --------------------------------------------------------------------------
// Mocks: cookie jar, localStorage, minimal DOM.
// --------------------------------------------------------------------------

const cookieJar = new Map();
let lastCookieWrite = '';

function makeElement(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    children: [],
    parentNode: null,
    attributes: {},
    style: {},
    listeners: {},
    textContent: '',
    focused: false,
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; },
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      child.parentNode = null;
      return child;
    },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    click() { for (const fn of this.listeners.click || []) fn({ type: 'click' }); },
    focus() { this.focused = true; },
  };
}

globalThis.document = {
  get cookie() {
    return [...cookieJar.entries()].map(([k, v]) => k + '=' + v).join('; ');
  },
  set cookie(str) {
    lastCookieWrite = String(str);
    const parts = lastCookieWrite.split(';').map((s) => s.trim());
    const eq = parts[0].indexOf('=');
    const name = parts[0].slice(0, eq);
    const value = parts[0].slice(eq + 1);
    let maxAge = null;
    for (const attr of parts.slice(1)) {
      const [k, v] = attr.split('=');
      if (k.trim().toLowerCase() === 'max-age') maxAge = Number(v);
    }
    if (maxAge !== null && maxAge <= 0) cookieJar.delete(name);
    else cookieJar.set(name, value);
  },
  createElement: makeElement,
};

function makeLocalStorage() {
  const data = new Map();
  return {
    get length() { return data.size; },
    key(i) { return [...data.keys()][i] ?? null; },
    getItem(k) { return data.has(k) ? data.get(k) : null; },
    setItem(k, v) { data.set(String(k), String(v)); },
    removeItem(k) { data.delete(k); },
    clear() { data.clear(); },
  };
}
globalThis.localStorage = makeLocalStorage();

function resetConsent() {
  document.cookie = 'ambi4-consent=; Max-Age=0';
}

function collectButtons(el, out = []) {
  if (el.tagName === 'BUTTON') out.push(el);
  for (const child of el.children || []) collectButtons(child, out);
  return out;
}

// --------------------------------------------------------------------------
// Phase 2: consent lifecycle.
// --------------------------------------------------------------------------

console.log('consent lifecycle');

ok('starts unasked', () => {
  assert.equal(prefs.consent(), null);
});

ok('setConsent(true) → granted, cookie has the contract shape', () => {
  prefs.setConsent(true);
  assert.equal(prefs.consent(), 'granted');
  assert.match(lastCookieWrite, /^ambi4-consent=granted/);
  assert.ok(lastCookieWrite.includes('Path=/'));
  assert.ok(lastCookieWrite.includes('Max-Age=31536000'));
  assert.ok(lastCookieWrite.includes('SameSite=Lax'));
  assert.ok(!lastCookieWrite.includes('Secure'), 'no Secure flag off https');
});

ok('setConsent(false) → denied', () => {
  prefs.setConsent(false);
  assert.equal(prefs.consent(), 'denied');
  assert.match(lastCookieWrite, /^ambi4-consent=denied/);
});

// --------------------------------------------------------------------------
// Memory before consent + flush on grant.
// --------------------------------------------------------------------------

console.log('memory-before-consent and flush-on-grant');

resetConsent();

ok('pre-consent set() is memory-only and returns false', () => {
  assert.equal(prefs.consent(), null);
  assert.equal(prefs.set('theme', 'dark'), false);
  assert.equal(localStorage.getItem('ambi4:theme'), null);
  assert.equal(prefs.get('theme'), 'dark');
});

ok('grant flushes memory into localStorage', () => {
  prefs.setConsent(true);
  assert.equal(localStorage.getItem('ambi4:theme'), '"dark"');
  assert.equal(prefs.get('theme'), 'dark');
});

ok('post-consent set() persists and returns true', () => {
  assert.equal(prefs.set('count', 5), true);
  assert.equal(localStorage.getItem('ambi4:count'), '5');
});

// --------------------------------------------------------------------------
// Denial wipes only the ambi4: namespace.
// --------------------------------------------------------------------------

console.log('denial wipes only ambi4: keys');

ok('foreign keys survive, ambi4: keys are wiped', () => {
  localStorage.setItem('other-app-key', 'keep-me');
  prefs.setConsent(false);
  assert.equal(localStorage.getItem('ambi4:theme'), null);
  assert.equal(localStorage.getItem('ambi4:count'), null);
  assert.equal(localStorage.getItem('other-app-key'), 'keep-me');
  assert.equal(prefs.get('theme'), null, 'flushed keys are gone after wipe');
});

ok('memory layer keeps working after denial', () => {
  assert.equal(prefs.set('session-only', [1, 2]), false);
  assert.deepEqual(prefs.get('session-only'), [1, 2]);
  assert.equal(localStorage.getItem('ambi4:session-only'), null);
  prefs.remove('session-only');
});

// --------------------------------------------------------------------------
// Round-trips, remove, corrupt entries, quota fallback.
// --------------------------------------------------------------------------

console.log('get/set/remove round-trips and failure modes');

resetConsent();
prefs.setConsent(true);

ok('objects, arrays, numbers, strings, booleans round-trip', () => {
  const cases = [
    ['obj', { a: 1, b: { c: [true, 'x'] } }],
    ['arr', [1, 'two', { three: 3 }]],
    ['num', 42.5],
    ['str', 'hello'],
    ['bool', false],
  ];
  for (const [key, value] of cases) {
    assert.equal(prefs.set(key, value), true);
    assert.deepEqual(prefs.get(key), value);
    prefs.remove(key);
  }
});

ok('remove() clears both layers', () => {
  prefs.set('gone', 1);
  prefs.remove('gone');
  assert.equal(prefs.get('gone'), null);
  assert.equal(localStorage.getItem('ambi4:gone'), null);
});

ok('unknown key → null', () => {
  assert.equal(prefs.get('never-set'), null);
});

ok('corrupt JSON → null and the bad entry is removed', () => {
  localStorage.setItem('ambi4:bad', '{not json');
  assert.equal(prefs.get('bad'), null);
  assert.equal(localStorage.getItem('ambi4:bad'), null);
});

ok('quota exception → silent memory fallback', () => {
  const realSetItem = localStorage.setItem;
  localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
  assert.equal(prefs.set('quota', 'squeezed'), false);
  localStorage.setItem = realSetItem;
  assert.equal(prefs.get('quota'), 'squeezed', 'value survived in memory');
  assert.equal(localStorage.getItem('ambi4:quota'), null);
  prefs.remove('quota');
});

// --------------------------------------------------------------------------
// consentPrompt.
// --------------------------------------------------------------------------

console.log('consentPrompt');

resetConsent();

await okAsync('renders an accessible card and resolves true on accept', async () => {
  const container = makeElement('div');
  const promise = consentPrompt(container, 'Remember your settings?');
  assert.equal(container.children.length, 1, 'card rendered');
  const card = container.children[0];
  assert.equal(card.getAttribute('role'), 'group');
  assert.equal(card.getAttribute('aria-label'), 'Remember your settings?');
  assert.equal(card.getAttribute('tabindex'), '-1');
  assert.equal(card.focused, true, 'focus moved to the card');

  const buttons = collectButtons(card);
  assert.equal(buttons.length, 2);
  const accept = buttons.find((b) => b.textContent === 'Save on this device');
  const decline = buttons.find((b) => b.textContent === 'No thanks');
  assert.ok(accept && decline, 'both contract buttons present');
  assert.equal(accept.getAttribute('type'), 'button');
  assert.equal(decline.getAttribute('type'), 'button');

  accept.click();
  assert.equal(await promise, true);
  assert.equal(prefs.consent(), 'granted');
  assert.equal(container.children.length, 0, 'card removed');
});

await okAsync('second call while open returns the same pending promise', async () => {
  resetConsent();
  const container = makeElement('div');
  const first = consentPrompt(container, 'msg');
  const second = consentPrompt(container, 'msg');
  assert.equal(first, second, 'idempotent per container');
  assert.equal(container.children.length, 1, 'no duplicate card');
  collectButtons(container).find((b) => b.textContent === 'No thanks').click();
  assert.equal(await first, false);
  assert.equal(prefs.consent(), 'denied');
});

await okAsync('already-decided consent short-circuits without rendering', async () => {
  resetConsent();
  prefs.setConsent(true);
  const granted = makeElement('div');
  assert.equal(await consentPrompt(granted, 'x'), true);
  assert.equal(granted.children.length, 0);

  prefs.setConsent(false);
  const denied = makeElement('div');
  assert.equal(await consentPrompt(denied, 'y'), false);
  assert.equal(denied.children.length, 0);
});

await okAsync('a fresh prompt works again after the previous one settled', async () => {
  resetConsent();
  const container = makeElement('div');
  const promise = consentPrompt(container, 'again?');
  assert.equal(container.children.length, 1);
  collectButtons(container).find((b) => b.textContent === 'Save on this device').click();
  assert.equal(await promise, true);
});

console.log('\nprefs-smoke: ' + passed + ' checks passed');
