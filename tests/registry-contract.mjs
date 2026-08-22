/**
 * Registry contract test — run with:
 *   node tests/registry-contract.mjs
 *
 * `tests/engine-smoke.mjs`'s "the registry and the patch schema cannot drift"
 * test (v0.0.165) builds BOTH sides of its `deepEqual` from
 * `param-registry.js` itself (`regPaths` from `PARAM_REGISTRY`, `schemaPaths`
 * from `patchSections()`/`patchSectionRows()`) and computes a `probe` it then
 * throws away with `void probe`. That is `f(REG) === REG`: it would pass
 * against an empty schema, or against a registry whose domains bear no
 * relation to what the engine actually clamps to. Two production comments
 * (`param-registry.js`'s own header, and `index.astro:9369`) already cite that
 * test as proof a domain mismatch cannot ship. This suite is what makes those
 * comments true: every assertion below drives `sanitiseParams` — the engine's
 * own gate — and never re-derives the expectation from the registry it is
 * checking.
 */

import assert from 'node:assert/strict';
import {
  sanitiseParams,
  TRACK_ORDER,
  PARAM_REGISTRY,
  RESERVED_TOKENS,
  isRangeable,
} from '../src/scripts/ambient-engine.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// Any built-in track and any voice id work here: sanitisePatches drops unknown
// TRACK names but keeps any voice id verbatim, since the voice library loads
// lazily and the engine cannot know what it will offer. TRACK_ORDER[0] rather
// than a literal, so a track-order rename does not need this file touched.
const TRACK = TRACK_ORDER[0];
const VOICE = 'registryContractProbe';

/** The `patches` partial one row's field lives at, for `sanitiseParams`. */
function patchPartial(section, field, value) {
  return { patches: { [TRACK]: { [VOICE]: { [section]: { [field]: value } } } } };
}

/** Read the same field back out of a `sanitiseParams` result. */
function readPatch(sanitised, section, field) {
  return sanitised.patches?.[TRACK]?.[VOICE]?.[section]?.[field];
}

// --------------------------------------------------------------------------
// 1 + 3 + 4 — every registry row, driven through sanitiseParams: domain
// round-trip, both-direction clamp, span legality (real, via isRangeable —
// which had zero consumers before this file), integer span-end rounding.
// --------------------------------------------------------------------------

for (const [path, row] of Object.entries(PARAM_REGISTRY)) {
  const [, section, field] = path.split('.');

  if (row.kind === 'number') {
    const [lo, hi] = row.domain;

    test(`${path}: a mid-domain value round-trips unchanged`, () => {
      const mid = row.integer ? Math.round((lo + hi) / 2) : (lo + hi) / 2;
      const out = sanitiseParams(patchPartial(section, field, mid));
      const got = readPatch(out, section, field);
      assert.equal(got, mid,
        `${path}: mid-domain value ${mid} (domain [${lo}, ${hi}]) must survive sanitiseParams unchanged, got ${got}`);
    });

    test(`${path}: a value above domain[1] clamps to ${hi}`, () => {
      const over = hi + 1;
      const out = sanitiseParams(patchPartial(section, field, over));
      const got = readPatch(out, section, field);
      assert.equal(got, hi,
        `${path}: ${over} is above the domain [${lo}, ${hi}] and must clamp to ${hi}, got ${got}`);
    });

    test(`${path}: a value below domain[0] clamps to ${lo}`, () => {
      const under = lo - 1;
      const out = sanitiseParams(patchPartial(section, field, under));
      const got = readPatch(out, section, field);
      assert.equal(got, lo,
        `${path}: ${under} is below the domain [${lo}, ${hi}] and must clamp to ${lo}, got ${got}`);
    });

    test(`${path}: rangeable (${isRangeable(path)}) decides whether a {min,max} span is legal`, () => {
      const spanMin = lo + (hi - lo) * 0.25;
      const spanMax = lo + (hi - lo) * 0.75;
      const out = sanitiseParams(patchPartial(section, field, { min: spanMin, max: spanMax }));
      const got = readPatch(out, section, field);
      if (isRangeable(path)) {
        assert.ok(got && typeof got === 'object',
          `${path}: rangeable is true (domain [${lo}, ${hi}]) so a span [${spanMin}, ${spanMax}] must survive, got ${JSON.stringify(got)}`);
        if (!row.integer) {
          assert.equal(got.min, spanMin,
            `${path}: span min ${spanMin} must survive unrounded (domain [${lo}, ${hi}]), got ${got.min}`);
          assert.equal(got.max, spanMax,
            `${path}: span max ${spanMax} must survive unrounded (domain [${lo}, ${hi}]), got ${got.max}`);
        }
      } else {
        assert.equal(got, undefined,
          `${path}: rangeable is false (domain [${lo}, ${hi}]) so a span [${spanMin}, ${spanMax}] must be refused, got ${JSON.stringify(got)}`);
      }
    });

    if (row.integer) {
      test(`${path}: an integer span rounds BOTH ends, not just the value`, () => {
        // Deliberately fractional and safely inside the domain — the law this
        // guards is that a span's ends round the same way a plain value does;
        // `octave` is the one live case (a fractional octave stop does not
        // exist), so this is the test that would catch a NEW integer row
        // shipping without that same rounding.
        const rawMin = lo + 0.4;
        const rawMax = hi - 0.4;
        const out = sanitiseParams(patchPartial(section, field, { min: rawMin, max: rawMax }));
        const got = readPatch(out, section, field);
        assert.deepEqual(got, { min: Math.round(rawMin), max: Math.round(rawMax) },
          `${path}: span ends [${rawMin}, ${rawMax}] (domain [${lo}, ${hi}]) must round to [${Math.round(rawMin)}, ${Math.round(rawMax)}], got ${JSON.stringify(got)}`);
      });
    }
  } else if (row.kind === 'enum') {
    test(`${path}: every one of its own enum values round-trips`, () => {
      for (const value of row.domain) {
        const out = sanitiseParams(patchPartial(section, field, value));
        const got = readPatch(out, section, field);
        assert.equal(got, value,
          `${path}: enum value '${value}' (legal values [${row.domain.join(', ')}]) must survive sanitiseParams, got ${JSON.stringify(got)}`);
      }
    });

    test(`${path}: a value outside its enum is dropped`, () => {
      const bogus = '__registry_contract_not_a_real_value__';
      const out = sanitiseParams(patchPartial(section, field, bogus));
      const got = readPatch(out, section, field);
      assert.equal(got, undefined,
        `${path}: '${bogus}' is not one of [${row.domain.join(', ')}] and must be dropped, got ${JSON.stringify(got)}`);
    });

    test(`${path}: rangeable (${isRangeable(path)}) refuses a {min,max} span`, () => {
      // An enum has no numeric axis for a span's own bounds to mean anything
      // along, so the values chosen here are arbitrary — what matters is that
      // the sanitiser drops the field entirely rather than storing something.
      const out = sanitiseParams(patchPartial(section, field, { min: 0, max: 1 }));
      const got = readPatch(out, section, field);
      assert.equal(isRangeable(path), false,
        `${path}: D9 says every enum row is non-rangeable, but isRangeable() disagrees`);
      assert.equal(got, undefined,
        `${path}: a {min,max} span must be refused on a non-rangeable enum row, got ${JSON.stringify(got)}`);
    });
  } else {
    test(`${path}: has a recognised row kind`, () => {
      assert.fail(`${path}: unrecognised row kind '${row.kind}' — this suite has no coverage plan for it`);
    });
  }
}

// --------------------------------------------------------------------------
// 5 — the D7 reserved-token table, adopted by the engine, not just declared.
// Drives sanitiseParams with the sampling and routing fields directly, so a
// spelling drift in RESERVED_TOKENS OR in the sanitiser's own literals — in
// either direction — fails here.
// --------------------------------------------------------------------------

test("reserved sampling tokens 'chord' and 'section' are honoured verbatim", () => {
  assert.ok(RESERVED_TOKENS.sampling.includes('chord'),
    `RESERVED_TOKENS.sampling [${RESERVED_TOKENS.sampling.join(', ')}] must list 'chord'`);
  assert.ok(RESERVED_TOKENS.sampling.includes('section'),
    `RESERVED_TOKENS.sampling [${RESERVED_TOKENS.sampling.join(', ')}] must list 'section'`);
  for (const token of ['chord', 'section']) {
    const out = sanitiseParams({ sampling: { 'pad:level': token } });
    assert.equal(out.sampling['pad:level'], token,
      `sampling token '${token}' (from RESERVED_TOKENS.sampling) must round-trip through sanitiseParams, got ${JSON.stringify(out.sampling)}`);
  }
});

test("reserved sampling token 'bar' stays the unstored default (v0.0.167), never a stored key", () => {
  assert.ok(RESERVED_TOKENS.sampling.includes('bar'),
    `RESERVED_TOKENS.sampling [${RESERVED_TOKENS.sampling.join(', ')}] must list 'bar'`);
  const out = sanitiseParams({ sampling: { 'pad:level': 'bar' } });
  assert.equal(out.sampling['pad:level'], undefined,
    "sampling token 'bar' is documented as the unstored default — an explicit write of it must still be dropped, or a future explicit 'bar' would silently mean something different from absent");
});

test("reserved sampling token 'note' stays refused until per-note resolution exists (v0.0.167)", () => {
  assert.ok(RESERVED_TOKENS.sampling.includes('note'),
    `RESERVED_TOKENS.sampling [${RESERVED_TOKENS.sampling.join(', ')}] must list 'note'`);
  const out = sanitiseParams({ sampling: { 'pad:level': 'note' } });
  assert.equal(out.sampling['pad:level'], undefined,
    "sampling token 'note' must be refused (not silently played as 'bar') until the per-note resolution path lands — this fails the day it starts being accepted without that work shipping alongside it");
});

test('a sampling token outside the reserved vocabulary is dropped', () => {
  const out = sanitiseParams({ sampling: { 'pad:level': 'week' } });
  assert.equal(out.sampling['pad:level'], undefined,
    `sampling token 'week' is not in RESERVED_TOKENS.sampling [${RESERVED_TOKENS.sampling.join(', ')}] and must be dropped, got ${JSON.stringify(out.sampling)}`);
});

test('reserved modulation-source namespaces lfo and macro are the routing sources the engine honours', () => {
  for (const namespace of ['lfo', 'macro']) {
    assert.ok(RESERVED_TOKENS.modulationSources.includes(namespace),
      `RESERVED_TOKENS.modulationSources [${RESERVED_TOKENS.modulationSources.join(', ')}] must list '${namespace}'`);
  }
  for (const source of ['lfo.1', 'macro.1']) {
    const out = sanitiseParams({ routing: [{ source, destination: 'pad:level' }] });
    assert.deepEqual(out.routing, [{ source, destination: 'pad:level' }],
      `routing source '${source}' must round-trip through sanitiseParams, got ${JSON.stringify(out.routing)}`);
  }
});

test("reserved modulation-source namespace 'env' is reserved but not yet an accepted routing source (plan phase 5)", () => {
  assert.ok(RESERVED_TOKENS.modulationSources.includes('env'),
    `RESERVED_TOKENS.modulationSources [${RESERVED_TOKENS.modulationSources.join(', ')}] must list 'env'`);
  const out = sanitiseParams({ routing: [{ source: 'env.1', destination: 'pad:level' }] });
  assert.deepEqual(out.routing, [],
    "'env' is reserved for per-voice envelopes (docs/dial-control-plane-plan.md D4/D8, plan phase 5 'still to come') — the sanitiser must refuse it as a routing source until envelopes ship as sources, or a routed envelope would silently do nothing");
});

test('a routing source outside the reserved namespaces is refused', () => {
  const out = sanitiseParams({ routing: [{ source: 'random.1', destination: 'pad:level' }] });
  assert.deepEqual(out.routing, [],
    `routing source 'random.1' names no reserved namespace (RESERVED_TOKENS.modulationSources [${RESERVED_TOKENS.modulationSources.join(', ')}]) and must be refused, got ${JSON.stringify(out.routing)}`);
});

// --------------------------------------------------------------------------

let failures = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}\n     ${error.message}`);
  }
}
console.log(`\n${tests.length - failures}/${tests.length} passed`);
process.exit(failures ? 1 : 0);
