/**
 * Share-link names (v29) — src/scripts/share-name.js
 *
 * Every tier-1 share link (`https://ambi4.work/#p=…`, params in the fragment,
 * no server) gets a three-word nickname drawn from the vetted wordlist:
 * "misty-harbour-lantern". It is a HANDLE, not an address — something two
 * people can say out loud, or write next to a link in a chat, so a wall of
 * base64 stops being anonymous. Named links at `ambi4.work/[name]` are the
 * PAID ladder (registry + Worker); nothing here claims a name, reserves one,
 * or talks to a server, and the page says so beside the name.
 *
 * WHY IT IS A MODULE. The page cannot be imported by a test — it is an Astro
 * component whose script only ever runs in a browser — so anything that has to
 * be proved by arithmetic rather than by clicking lives out here, next to its
 * own smoke test (tests/share-name-smoke.mjs). This module is pure: no DOM, no
 * storage, no clock, no randomness, no module state. Same input, same name,
 * on any device, in any year — which is the whole point: the sender and the
 * receiver of a link must read the same three words without ever exchanging
 * anything but the link.
 *
 * THE NAME IS A FUNCTION OF THE PAYLOAD, not of the URL around it. The `p`
 * value — the base64url of the params snapshot — is what gets hashed, so the
 * same preset shared from a different host (a preview deploy, a local dev
 * server) or through a fragment that later grows a second key still names the
 * same piece.
 *
 * THE HASH is FNV-1a/32 run three times over the payload, once per seed, each
 * result passed through a murmur3 finaliser before it is reduced modulo the
 * pool size. Three independent 32-bit hashes rather than three byte-slices of
 * one: the pool is 938 words, which does not fit in a byte, and slicing a
 * single 32-bit value would leave the three indices correlated. No external
 * dependency, no Web Crypto (which is async, and unavailable in an insecure
 * context — a share name must never fail to appear).
 *
 * WORDLIST DISCIPLINE. src/data/wordlist.json is a multi-agent vetted list
 * (profanity, innuendo, brand/artist collisions, cross-language offence,
 * homophones — see its `vetting` field). Words are used VERBATIM and in file
 * order: never sliced, never re-cased, never stemmed, never joined into a new
 * word. Every entry in all three groups is eligible for every one of the three
 * positions — the name is not a grammar, it is three draws from one pool.
 */

/** The wordlist groups, in the order they are concatenated into the pool. */
export const WORD_GROUPS = ['adjectives', 'nouns', 'verbs'];

/** Words per name. */
export const SHARE_NAME_WORDS = 3;

/** The fragment key a tier-1 share link carries its params under. */
export const SHARE_PARAM = 'p';

const FNV_PRIME = 0x01000193;

/**
 * One seed per word position. The first is the standard FNV-1a offset basis;
 * the other two are the murmur3/xxhash mixing constants, used here only as
 * arbitrary well-distributed starting states. Changing these renames every
 * link ever shared, so they are frozen.
 */
const SEEDS = [0x811c9dc5, 0xc2b2ae35, 0x27d4eb2f];

/**
 * FNV-1a/32 over a string, seeded. Characters are consumed as bytes (low byte
 * first, then high byte for anything above U+00FF) so the result never depends
 * on how a runtime happens to encode a string — a share payload is base64url
 * in practice, but a payload that is not must still hash identically here and
 * in the browser.
 */
function fnv1a32(text, seed) {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    hash = Math.imul(hash ^ (code & 0xff), FNV_PRIME) >>> 0;
    if (code > 0xff) hash = Math.imul(hash ^ ((code >>> 8) & 0xff), FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

/**
 * murmur3's fmix32 avalanche. FNV-1a's low bits carry most of its structure,
 * and `% poolSize` reads exactly those bits — without this, two payloads
 * differing in one character land close together far too often.
 */
function avalanche(hash) {
  let h = hash >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h >>> 0;
}

/**
 * The word pool for a parsed wordlist.json: adjectives, then nouns, then
 * verbs, each in file order, each word verbatim. Non-string and empty entries
 * are dropped rather than repaired — a wordlist that needs repairing is a data
 * bug, and silently mangling it would put an unvetted string in front of a
 * user. Returns a NEW array; callers may hold it for the life of the page.
 */
export function wordPoolFrom(wordlist) {
  const pool = [];
  if (!wordlist || typeof wordlist !== 'object') return pool;
  for (const group of WORD_GROUPS) {
    const words = wordlist[group];
    if (!Array.isArray(words)) continue;
    for (const word of words) {
      if (typeof word === 'string' && word.length > 0) pool.push(word);
    }
  }
  return pool;
}

/**
 * The payload a name is computed from, given anything fragment-shaped: a bare
 * payload, `p=…`, `#p=…`, or a multi-key fragment holding `p`. Split by hand
 * rather than through URLSearchParams because base64url is percent-free and
 * plus-free by construction, so no decoding step can change the value — and a
 * decoding step is exactly the kind of thing that would drift between the two
 * ends of a link.
 */
export function sharePayloadFrom(fragment, param = SHARE_PARAM) {
  let text = String(fragment ?? '').trim();
  if (text.startsWith('#')) text = text.slice(1);
  if (!text) return '';
  if (text.includes('=')) {
    for (const part of text.split('&')) {
      const eq = part.indexOf('=');
      if (eq > 0 && part.slice(0, eq) === param) return part.slice(eq + 1);
    }
  }
  return text;
}

/**
 * The three pool indices for a payload. Distinct by construction: a collision
 * steps to the next index, which costs a hair of uniformity (~0.3% of names
 * are affected at pool size 938) and buys never showing a listener
 * "misty-misty-lantern", which reads as a bug rather than as a name.
 */
export function shareNameIndices(payload, poolSize) {
  const size = Math.floor(poolSize);
  if (!Number.isFinite(size) || size <= 0) return [];
  const text = String(payload ?? '');
  const indices = [];
  for (const seed of SEEDS.slice(0, SHARE_NAME_WORDS)) {
    let index = avalanche(fnv1a32(text, seed)) % size;
    if (size >= SHARE_NAME_WORDS) {
      while (indices.includes(index)) index = (index + 1) % size;
    }
    indices.push(index);
  }
  return indices;
}

/**
 * The three-word name for a share fragment, kebab-joined. Returns '' for an
 * empty fragment or an unusable pool — the caller shows nothing rather than a
 * half-name.
 */
export function shareNameFor(fragment, pool) {
  if (!Array.isArray(pool) || pool.length === 0) return '';
  const payload = sharePayloadFrom(fragment);
  if (!payload) return '';
  return shareNameIndices(payload, pool.length)
    .map((index) => pool[index])
    .join('-');
}
