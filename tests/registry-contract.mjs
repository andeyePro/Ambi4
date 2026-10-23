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
import { readFileSync } from 'node:fs';
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

/**
 * v0.0.249: the registry grew its first rows outside the patch namespace —
 * `master.<field>` (a top-level param) and `track.<field>` (the same field on
 * every track). The partial each path lives at, and its value read back.
 */
function partialFor(path, value) {
  const [scope, a, b] = path.split('.');
  if (scope === 'patch') return patchPartial(a, b, value);
  if (scope === 'master') return { [a]: value };
  if (scope === 'track') return { tracks: { [TRACK]: { [a]: value } } };
  throw new Error(`${path}: no partial for scope '${scope}'`);
}

/**
 * `raw` is what is stored. Without it, a master/track row reads its SPARSE
 * meaning: those rows are absent at 0 (nothing stored, nothing built), so an
 * absent key reads as the row's domain floor.
 */
function readBack(sanitised, path, { raw = false } = {}) {
  const [scope, a, b] = path.split('.');
  let got;
  if (scope === 'patch') return readPatch(sanitised, a, b);
  if (scope === 'master') got = sanitised[a];
  else if (scope === 'track') got = sanitised.tracks?.[TRACK]?.[a];
  if (got === undefined && !raw) return PARAM_REGISTRY[path].domain[0];
  return got;
}

// --------------------------------------------------------------------------
// 1 + 3 + 4 — every registry row, driven through sanitiseParams: domain
// round-trip, both-direction clamp, span legality (real, via isRangeable —
// which had zero consumers before this file), integer span-end rounding.
// --------------------------------------------------------------------------

for (const [path, row] of Object.entries(PARAM_REGISTRY)) {

  if (row.kind === 'number') {
    const [lo, hi] = row.domain;

    test(`${path}: a mid-domain value round-trips unchanged`, () => {
      const mid = row.integer ? Math.round((lo + hi) / 2) : (lo + hi) / 2;
      const out = sanitiseParams(partialFor(path, mid));
      const got = readBack(out, path);
      assert.equal(got, mid,
        `${path}: mid-domain value ${mid} (domain [${lo}, ${hi}]) must survive sanitiseParams unchanged, got ${got}`);
    });

    test(`${path}: a value above domain[1] clamps to ${hi}`, () => {
      const over = hi + 1;
      const out = sanitiseParams(partialFor(path, over));
      const got = readBack(out, path);
      assert.equal(got, hi,
        `${path}: ${over} is above the domain [${lo}, ${hi}] and must clamp to ${hi}, got ${got}`);
    });

    test(`${path}: a value below domain[0] clamps to ${lo}`, () => {
      const under = lo - 1;
      const out = sanitiseParams(partialFor(path, under));
      const got = readBack(out, path);
      assert.equal(got, lo,
        `${path}: ${under} is below the domain [${lo}, ${hi}] and must clamp to ${lo}, got ${got}`);
    });

    test(`${path}: rangeable (${isRangeable(path)}) decides whether a {min,max} span is legal`, () => {
      const spanMin = lo + (hi - lo) * 0.25;
      const spanMax = lo + (hi - lo) * 0.75;
      const out = sanitiseParams(partialFor(path, { min: spanMin, max: spanMax }));
      const got = readBack(out, path, { raw: true });
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
        const out = sanitiseParams(partialFor(path, { min: rawMin, max: rawMax }));
        const got = readBack(out, path);
        assert.deepEqual(got, { min: Math.round(rawMin), max: Math.round(rawMax) },
          `${path}: span ends [${rawMin}, ${rawMax}] (domain [${lo}, ${hi}]) must round to [${Math.round(rawMin)}, ${Math.round(rawMax)}], got ${JSON.stringify(got)}`);
      });
    }
  } else if (row.kind === 'enum') {
    test(`${path}: every one of its own enum values round-trips`, () => {
      for (const value of row.domain) {
        const out = sanitiseParams(partialFor(path, value));
        const got = readBack(out, path);
        assert.equal(got, value,
          `${path}: enum value '${value}' (legal values [${row.domain.join(', ')}]) must survive sanitiseParams, got ${JSON.stringify(got)}`);
      }
    });

    test(`${path}: a value outside its enum is dropped`, () => {
      const bogus = '__registry_contract_not_a_real_value__';
      const out = sanitiseParams(partialFor(path, bogus));
      const got = readBack(out, path);
      assert.equal(got, undefined,
        `${path}: '${bogus}' is not one of [${row.domain.join(', ')}] and must be dropped, got ${JSON.stringify(got)}`);
    });

    test(`${path}: rangeable (${isRangeable(path)}) refuses a {min,max} span`, () => {
      // An enum has no numeric axis for a span's own bounds to mean anything
      // along, so the values chosen here are arbitrary — what matters is that
      // the sanitiser drops the field entirely rather than storing something.
      const out = sanitiseParams(partialFor(path, { min: 0, max: 1 }));
      const got = readBack(out, path);
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
// The page's side of the same contract. Phase 2a deleted the min/max literals
// from the sculpt and call spec tables so a dial's domain would be stated
// exactly once — which means a spec whose field has NO registry row is a dial
// with undefined bounds, and its write clamp is clamp(x, undefined, undefined):
// NaN, into the patch, with nothing to catch it. The page now drops such a
// dial rather than draw it, and this is the gate that stops one shipping.
// Source-scanned rather than executed, the way tutorial-smoke reads the page.

test('every sculpt and call dial has the registry row its domain now comes from', () => {
  const page = readFileSync(new URL('../src/pages/index.astro', import.meta.url), 'utf8');
  for (const table of ['SCULPT_GROUPS', 'CALL_GROUPS']) {
    const start = page.indexOf(`const ${table} = [`);
    assert.ok(start > 0, `${table} is not in the page any more — this gate is watching the wrong name`);
    // The table ends at the first line that closes it at column zero-plus-six,
    // the indentation every top-level const in this file's script block has.
    const end = page.indexOf('\n      ];', start);
    assert.ok(end > start, `${table} does not close where this scan expects`);
    const body = page.slice(start, end);
    const fields = [...body.matchAll(/field:\s*'([A-Za-z0-9_.]+)'/g)].map((m) => m[1]);
    assert.ok(fields.length > 0, `${table} names no fields — the scan found nothing to check`);
    for (const field of fields) {
      const row = PARAM_REGISTRY[`patch.source.${field}`];
      assert.ok(row, `${table} draws a dial for patch.source.${field}, which has no registry row: since v0.0.166 the spec carries no min/max of its own, so that dial would render with undefined bounds and write NaN into the patch`);
      assert.equal(row.kind, 'number',
        `${table}'s ${field} is drawn as a numeric dial but its registry row is ${row.kind}`);
    }
  }
});

test('the page offers exactly the oscillator and filter types the engine accepts', () => {
  const page = readFileSync(new URL('../src/pages/index.astro', import.meta.url), 'utf8');
  const labelBlock = (name) => {
    const start = page.indexOf(`const ${name} = {`);
    assert.ok(start > 0, `${name} is not in the page — this gate is watching the wrong name`);
    const end = page.indexOf('};', start);
    return [...page.slice(start, end).matchAll(/([A-Za-z0-9_]+):\s*'/g)].map((m) => m[1]);
  };
  // The menus are BUILT from the registry rows now, so the only thing that can
  // drift is a type with no display name — it would show as its own wire id.
  for (const [name, path] of [['OSC_LABELS', 'patch.source.osc1'], ['FILTER_LABELS', 'patch.filter.type']]) {
    const labelled = labelBlock(name);
    for (const id of PARAM_REGISTRY[path].domain) {
      assert.ok(labelled.includes(id),
        `${path} accepts '${id}' but ${name} has no display name for it, so the menu would offer the raw wire id`);
    }
    for (const id of labelled) {
      assert.ok(PARAM_REGISTRY[path].domain.includes(id),
        `${name} names '${id}', which ${path} would refuse — a menu entry the engine drops on selection`);
    }
  }
});

// --------------------------------------------------------------------------
// v0.0.172 — every dial says what you will hear (docs/synthesis-programme.md
// § 3). The hint is a column of the row, so a dial's domain and its words
// have one source; a row without words would render a bare label, which the
// programme forbids. The bounds are copy discipline: long enough to say what
// changes, short enough to read as a tooltip, plain text, and a sentence.
// --------------------------------------------------------------------------

test('every registry row carries a hint that reads as one plain sentence', () => {
  for (const [path, row] of Object.entries(PARAM_REGISTRY)) {
    assert.equal(typeof row.hint, 'string', `${path}: hint is not a string`);
    const hint = row.hint.trim();
    assert.ok(hint.length >= 20 && hint.length <= 180,
      `${path}: hint is ${hint.length} characters (20–180 reads as a tooltip): ${JSON.stringify(hint)}`);
    assert.ok(/[.!?]$/.test(hint), `${path}: hint does not end as a sentence: ${JSON.stringify(hint)}`);
    assert.ok(!/[<>`]/.test(hint), `${path}: hint carries markup: ${JSON.stringify(hint)}`);
    assert.ok(!/\b(Claude|Anthropic|Ableton|Moog|Roland|Yamaha)\b/.test(hint),
      `${path}: hint names a brand: ${JSON.stringify(hint)}`);
    assert.ok(!/\b(color|synthesizer|analyze|favorite)\b/i.test(hint),
      `${path}: hint is not UK-spelled: ${JSON.stringify(hint)}`);
  }
});

test('the page reads every dial\'s hint from the registry, not from a literal of its own', () => {
  const page = readFileSync(new URL('../src/pages/index.astro', import.meta.url), 'utf8');
  // The v19 sculpt and call tables were the one place a dial's words lived on
  // the page; the words moved into the rows. A `hint:` literal back in either
  // table is a second source that can drift from the first.
  const start = page.indexOf('const SCULPT_GROUPS = [');
  const end = page.indexOf('function overlayRegistryDomains(');
  assert.ok(start > 0 && end > start, 'the sculpt/call spec tables are not where this gate expects them');
  assert.ok(!/\n\s+hint: '/.test(page.slice(start, end)),
    'a sculpt or call spec carries its own hint literal — the registry row is the one source');
  // And both editors ask the registry: the knob editor once per dial, the
  // slider editor once per control.
  assert.ok(/if \(field\) describe\(handle\.el, registryHint\(field\)\);/.test(page),
    'buildKnobEditor no longer describes every dial from its registry row');
  // v0.0.189: the slider editor's Filter/Envelope/Sends controls are one loop
  // (the count of literal call sites that stood in for this is gone with the
  // literals); page-boot's fallback check proves every rendered control's
  // accessible description equals its row's hint, over all 36 voices.
  const sliderStart = page.indexOf('function buildSliderEditor(');
  const sliderEnd = page.indexOf('function buildKnobEditor(');
  const slider = page.slice(sliderStart, sliderEnd);
  assert.ok(/hint: registryHint\(path\),/.test(slider),
    'the slider editor\'s registry loop no longer passes each control its row\'s hint');
  const sliderCalls = (slider.match(/hint: registryHint\(/g) || []).length;
  assert.ok(sliderCalls >= 10,
    `the slider editor passes registryHint on ${sliderCalls} call sites; its source, engine and loop controls all must`);
});

// --------------------------------------------------------------------------
// Phase 2c — the voice editors state no fact the registry row already holds.
// Every registry-backed dial is built from registryDial(path), which reads
// the row's domain, curve, unit and rangeable (and applies DIAL_DEPARTURES,
// the named list of places a shipped dial disagrees with its row). A literal
// bound, curve, tick list or allowRange flag back in either editor is a
// second source that can drift from the first, which is what 2c removed.
//
// What this scans, precisely: the page source from `function
// buildSliderEditor(` up to `async function renderVoiceEditor(` — the
// slider fallback editor and the whole knob editor — with the body of
// `addLogKnob` cut out, because its `min: 0, max: 1` and `clamp(t, 0, 1)` are
// the log map's normalised axis, not a parameter's domain. It does NOT scan
// the SCULPT_GROUPS / CALL_GROUPS tables (the test above holds those to "no
// min/max"; their tick `marks` are per-dial presentation), nor the non-voice
// dials elsewhere on the page (tempo, level, chance…), which have no row.
// --------------------------------------------------------------------------

function voiceEditorSource(page) {
  const start = page.indexOf('function buildSliderEditor(');
  const end = page.indexOf('async function renderVoiceEditor(');
  assert.ok(start > 0 && end > start, 'the two voice editors are not where this gate expects them');
  let body = page.slice(start, end);
  const logStart = body.indexOf('function addLogKnob(');
  assert.ok(logStart > 0, 'addLogKnob is not inside buildKnobEditor any more — this gate is cutting the wrong body');
  const logEnd = body.indexOf('\n        }\n', logStart);
  assert.ok(logEnd > logStart, 'addLogKnob does not close where this gate expects');
  body = body.slice(0, logStart) + body.slice(logEnd);
  return body;
}

test('phase 2c: neither voice editor hand-writes a domain, curve, tick list or allowRange for a registry field', () => {
  const page = readFileSync(new URL('../src/pages/index.astro', import.meta.url), 'utf8');
  const body = voiceEditorSource(page);
  const forbidden = [
    [/\b(?:min|max):\s*-?\d/, 'a numeric min/max literal — the bound is the registry row\'s (registryDial)'],
    [/\bclamp\([^()]*?,\s*-?\d[\d.]*\s*,\s*-?\d[\d.]*\s*\)/, 'a clamp to two literal bounds — clamp to the dial\'s min/max'],
    [/\ballowRange:(?!\s*dial\.allowRange\b)/, 'an allowRange that is not the row\'s rangeable (dial.allowRange)'],
    // (A `log: true` chosen BY the dial's own curve — `d.log ? { log: true }` — is the row speaking.)
    [/\blog:\s*(?:true|false)\b|\bcurve:\s*'/, 'a hand-set curve — the row\'s curve, or a DIAL_DEPARTURES entry', /\.log\s*\?/],
    [/\bmarks:\s*\[\s*-?\d/, 'a literal tick list — derive the marks from the dial\'s ends'],
    [/\bfallback:\s*\[/, 'a pre-registry fallback domain'],
    [/\b(?:patchDomain|regDomain|registryEnum|engineCaps\.patch(?:V19Range|NoiseRange|DetuneBipolar))\b/, 'a retired accessor that carried its own copy of a row fact'],
  ];
  const offences = [];
  for (const line of body.split('\n')) {
    if (/^\s*(?:\/\/|\*)/.test(line)) continue; // prose may name what it replaced
    for (const [pattern, why, unless] of forbidden) {
      if (pattern.test(line) && !(unless && unless.test(line))) offences.push(`${why}:\n       ${line.trim()}`);
    }
  }
  // Multi-line, so scanned over the whole body: a select whose options are a
  // literal list of numbers (the octave select's '-1', '0', '1' was one).
  for (const m of body.matchAll(/\boptions:\s*\[\s*\[\s*'-?\d[^\]]*\]/g)) {
    offences.push(`a literal numeric option list — derive it from the dial's ends:\n       ${m[0].replace(/\s+/g, ' ')}`);
  }
  assert.deepEqual(offences, [], `the voice editors restate ${offences.length} registry fact(s):\n     ${offences.join('\n     ')}`);
  // And the dials really are built from the rows: every literal path handed
  // to registryDial names a row, or that dial silently vanishes.
  const paths = [...page.matchAll(/registryDial\('([A-Za-z0-9_.]+)'\)/g)].map((m) => m[1]);
  assert.ok(paths.length >= 20, `only ${paths.length} registryDial('…') call sites — the editors are not reading the registry`);
  for (const path of paths) {
    assert.ok(PARAM_REGISTRY[`patch.${path}`], `registryDial('${path}') names no registry row — that dial would never be drawn`);
  }
  assert.ok(/allowRange:\s*row\.rangeable === true/.test(page),
    'registryDial no longer derives allowRange from the row\'s rangeable');
});

test('phase 2c: DIAL_DEPARTURES is exactly the known, still-real disagreements', () => {
  const page = readFileSync(new URL('../src/pages/index.astro', import.meta.url), 'utf8');
  const start = page.indexOf('const DIAL_DEPARTURES = Object.freeze({');
  assert.ok(start > 0, 'DIAL_DEPARTURES is not in the page — this gate is watching the wrong name');
  const end = page.indexOf('\n      });', start);
  const block = page.slice(start, end);
  const entries = Object.fromEntries([...block.matchAll(/^\s*'([A-Za-z0-9_.]+)':\s*Object\.freeze\((\{[^}]*\})\)/gm)]
    .map((m) => [m[1], Function(`return (${m[2]});`)()]));
  // A new departure is a dial that disagrees with its row on purpose — that
  // is a ruling to record (and list in docs/dial-control-plane-plan.md), not
  // a literal to slip in, so the set is pinned.
  assert.deepEqual(Object.keys(entries).sort(), ['filter.q', 'source.octave'],
    `DIAL_DEPARTURES lists ${JSON.stringify(Object.keys(entries))}; a change to this set is a ruling, update this gate and the plan with it`);
  for (const [path, departure] of Object.entries(entries)) {
    const row = PARAM_REGISTRY[`patch.${path}`];
    assert.ok(row && row.kind === 'number', `DIAL_DEPARTURES names ${path}, which has no numeric registry row`);
    // Each must still DEPART — a row that came round to the dial makes the
    // entry dead weight that hides the agreement.
    const departs = (departure.min !== undefined && departure.min !== row.domain[0])
      || (departure.max !== undefined && departure.max !== row.domain[1])
      || (departure.log !== undefined && departure.log !== (row.curve === 'log'));
    assert.ok(departs, `DIAL_DEPARTURES['${path}'] ${JSON.stringify(departure)} no longer differs from its row — delete the entry`);
    if (departure.min !== undefined) assert.ok(departure.min >= row.domain[0] && departure.max <= row.domain[1],
      `DIAL_DEPARTURES['${path}'] draws past what the sanitiser accepts [${row.domain}]`);
  }
});

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
