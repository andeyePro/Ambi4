/**
 * Smoke test for src/scripts/share-name.js — run with:
 *   node tests/share-name-smoke.mjs
 *
 * The share name is the one string two strangers have to agree on without
 * exchanging anything but a link, so the properties worth asserting are
 * arithmetic ones: same payload → same name, forever and on every device;
 * different payload → almost surely a different name; every word that reaches
 * a listener came out of the vetted list untouched.
 *
 * The wordlist is read with readFileSync rather than imported, so this suite
 * needs no import attributes and no bundler — it runs on a bare `node`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  SHARE_NAME_WORDS,
  WORD_GROUPS,
  shareNameFor,
  shareNameIndices,
  sharePayloadFrom,
  wordPoolFrom,
} from '../src/scripts/share-name.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const wordlist = JSON.parse(readFileSync(join(repoRoot, 'src/data/wordlist.json'), 'utf8'));
const pool = wordPoolFrom(wordlist);

let checks = 0;
function check(label, fn) {
  fn();
  checks += 1;
  console.log(`  ok — ${label}`);
}

/** A deterministic stand-in for real share payloads (base64url, no seeding). */
function payload(n) {
  let text = '';
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  // An LCG's LOW bits have a short period (mod 64 it repeats every 64 draws),
  // which quietly made this generator emit rotations of one string. Take the
  // top six bits instead — full period, distinct payloads.
  let state = (Math.imul(n ^ 0x9e3779b9, 2654435761) + n) >>> 0;
  for (let i = 0; i < 64; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    text += alphabet[state >>> 26];
  }
  return text;
}

console.log('share-name-smoke');

// ---- the pool ------------------------------------------------------------

check('the wordlist declares the counts it ships', () => {
  for (const group of WORD_GROUPS) {
    assert.ok(Array.isArray(wordlist[group]), `wordlist.${group} is not an array`);
    assert.equal(
      wordlist[group].length,
      wordlist.counts[group],
      `wordlist.${group} has ${wordlist[group].length} words, counts says ${wordlist.counts[group]}`
    );
  }
});

check('the pool is every vetted word, in file order, verbatim', () => {
  const expected = WORD_GROUPS.flatMap((group) => wordlist[group]);
  assert.deepEqual(pool, expected);
  assert.equal(pool.length, 938, `pool is ${pool.length} words, expected 938`);
  assert.equal(new Set(pool).size, pool.length, 'the pool holds a duplicate word');
  for (const word of pool) {
    assert.match(word, /^[a-z]+$/, `"${word}" is not a plain lower-case word`);
  }
});

// ---- determinism ---------------------------------------------------------

check('the same fragment always names the same link', () => {
  for (let i = 0; i < 200; i += 1) {
    const p = payload(i);
    const first = shareNameFor(p, pool);
    assert.equal(shareNameFor(p, pool), first);
    assert.equal(shareNameFor(`p=${p}`, pool), first, 'the p= form named a different link');
    assert.equal(shareNameFor(`#p=${p}`, pool), first, 'the #p= form named a different link');
    assert.equal(
      shareNameFor(`p=${p}&x=1`, pool),
      first,
      'a second fragment key changed the name'
    );
    assert.equal(shareNameFor(` #p=${p} `, pool), first, 'whitespace changed the name');
  }
});

check('the names are frozen — these payloads name these links', () => {
  // Hard-coded expectations, regenerated ONLY when a rename of every link ever
  // shared is the intended change (it never is: a link in someone's chat log
  // must still read as the same name years later).
  const frozen = [
    ['e30', 'glacier-reviving-loamy'],
    ['eyJicG0iOjcyfQ', 'windswept-nebula-vase'],
    ['A', 'breeze-stable-palette'],
  ];
  for (const [input, expected] of frozen) {
    assert.equal(shareNameFor(input, pool), expected, `"${input}" no longer names ${expected}`);
  }
});

// ---- shape ---------------------------------------------------------------

check('a name is three distinct vetted words, kebab-joined', () => {
  for (let i = 0; i < 2000; i += 1) {
    const name = shareNameFor(payload(i), pool);
    const words = name.split('-');
    assert.equal(words.length, SHARE_NAME_WORDS, `"${name}" is not ${SHARE_NAME_WORDS} words`);
    assert.equal(new Set(words).size, words.length, `"${name}" repeats a word`);
    for (const word of words) {
      assert.ok(pool.includes(word), `"${word}" is not in the vetted wordlist`);
    }
    assert.match(name, /^[a-z]+-[a-z]+-[a-z]+$/);
  }
});

// ---- separation ----------------------------------------------------------

check('different payloads almost surely get different names', () => {
  const names = new Map();
  const total = 20000;
  let collisions = 0;
  // Guard the generator, not the hash: a payload() that repeats itself would
  // make this check pass for the wrong reason (it once did — see the note in
  // payload()).
  const distinctPayloads = new Set();
  for (let i = 0; i < total; i += 1) distinctPayloads.add(payload(i));
  assert.equal(distinctPayloads.size, total, 'the test payload generator repeats itself');
  for (let i = 0; i < total; i += 1) {
    const name = shareNameFor(payload(i), pool);
    if (names.has(name)) collisions += 1;
    else names.set(name, i);
  }
  // 20k draws over ~8.2e8 names: the birthday expectation is ~0.24 collisions.
  // Anything above single figures means the three indices are not independent.
  assert.ok(collisions <= 3, `${collisions} collisions in ${total} payloads`);
});

check('a one-character edit renames the link', () => {
  let same = 0;
  for (let i = 0; i < 500; i += 1) {
    const base = payload(i);
    const edited = `${base.slice(0, -1)}${base.endsWith('A') ? 'B' : 'A'}`;
    if (shareNameFor(base, pool) === shareNameFor(edited, pool)) same += 1;
  }
  assert.equal(same, 0, `${same}/500 one-character edits kept the name`);
});

check('each position independently reaches the whole pool', () => {
  const seen = [new Set(), new Set(), new Set()];
  for (let i = 0; i < 60000; i += 1) {
    const indices = shareNameIndices(payload(i), pool.length);
    indices.forEach((index, slot) => seen[slot].add(index));
  }
  seen.forEach((set, slot) => {
    assert.equal(
      set.size,
      pool.length,
      `position ${slot + 1} only ever used ${set.size} of ${pool.length} words`
    );
  });
});

check('the three positions are not copies of one another', () => {
  let identicalPairs = 0;
  for (let i = 0; i < 500; i += 1) {
    const [a, b, c] = shareNameIndices(payload(i), pool.length);
    if (a === b || b === c || a === c) identicalPairs += 1;
  }
  assert.equal(identicalPairs, 0, 'two positions produced the same index');
});

// ---- edges ---------------------------------------------------------------

check('an empty or unusable input names nothing rather than half a name', () => {
  assert.equal(shareNameFor('', pool), '');
  assert.equal(shareNameFor('#', pool), '');
  assert.equal(shareNameFor(null, pool), '');
  assert.equal(shareNameFor(undefined, pool), '');
  assert.equal(shareNameFor('p=abc', []), '');
  assert.equal(shareNameFor('p=abc', null), '');
  assert.equal(shareNameIndices('abc', 0).length, 0);
});

check('a pool smaller than a name still yields three words', () => {
  const tiny = ['alpha', 'beta'];
  const name = shareNameFor('p=abc', tiny);
  assert.equal(name.split('-').length, SHARE_NAME_WORDS);
  for (const word of name.split('-')) assert.ok(tiny.includes(word));
});

check('a malformed wordlist yields an empty pool, never a mangled word', () => {
  assert.deepEqual(wordPoolFrom(null), []);
  assert.deepEqual(wordPoolFrom({}), []);
  assert.deepEqual(wordPoolFrom({ adjectives: ['misty', 42, '', null], nouns: 'nope' }), ['misty']);
});

check('the payload is read out of any fragment shape', () => {
  assert.equal(sharePayloadFrom('#p=abc'), 'abc');
  assert.equal(sharePayloadFrom('p=abc'), 'abc');
  assert.equal(sharePayloadFrom('abc'), 'abc');
  assert.equal(sharePayloadFrom('#x=1&p=abc'), 'abc');
  assert.equal(sharePayloadFrom('#p='), '');
  assert.equal(sharePayloadFrom('#x=1'), '#x=1'.slice(1));
});

console.log(`\nshare-name-smoke ok — ${checks} checks, ${pool.length} vetted words`);
