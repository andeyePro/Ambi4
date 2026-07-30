/**
 * Smoke test for the guided tour in src/pages/index.astro — run with:
 *   npm run build && node tests/tutorial-smoke.mjs
 *
 * The tour is the one part of the page that describes the product in prose, so
 * it rots silently: a control gets a new id, a step keeps ringing a selector
 * that matches nothing, and the panel walks a first-time visitor past features
 * that no longer exist. Nothing else in the suite reads it — `astro build`
 * cannot see a dead selector inside a string, and page-boot never opens the
 * panel.
 *
 * What this holds:
 *  - every step's `target` resolves to EXACTLY ONE element (never zero, and
 *    never two — an ambiguous selector rings whichever came first, which is
 *    how `.sliders-module` quietly pointed at either dial panel);
 *  - every `tab` is a tab the page actually renders;
 *  - the arc stays Simple → Advanced (a step cannot send a newcomer back);
 *  - the copy is non-empty, plain text, UK-spelled and free of brand names.
 *
 * The DOM it checks against is the BUILT page (dist/index.html), read as
 * markup — no script is executed here, so a handful of targets the page script
 * builds at runtime (Add track) cannot be resolved statically. Those are
 * verified two ways instead: the id must be assigned in the page source, and
 * page-boot.mjs re-runs the whole target check against the BOOTED document,
 * where they exist. That is why `readTutorialSteps` is exported.
 */

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pageSourcePath = join(repoRoot, 'src/pages/index.astro');
const indexHtml = join(repoRoot, 'dist/index.html');

/** Steps a first run can reasonably sit through, and a floor that catches a truncated array. */
export const TUTORIAL_MIN_STEPS = 8;
export const TUTORIAL_MAX_STEPS = 14;

/**
 * The tour's step list, read out of the page source. The array is a literal —
 * the same trick page-boot uses for FALLBACK_TRACKS — so it can be evaluated
 * without a bundler and without executing the page.
 */
export function readTutorialSteps(source = readFileSync(pageSourcePath, 'utf8')) {
  const match = /const TUTORIAL_STEPS = (\[[\s\S]*?\n {6}\]);/.exec(source);
  assert.ok(match, 'src/pages/index.astro has no TUTORIAL_STEPS array literal');
  const steps = new Function(`return ${match[1]};`)();
  assert.ok(Array.isArray(steps) && steps.length, 'TUTORIAL_STEPS did not evaluate to a list');
  return steps;
}

/**
 * Every step target, resolved against a document. Shared with page-boot so the
 * booted-DOM gate and this one cannot disagree about what "resolves" means.
 * Returns a list of failure strings — empty means clean.
 */
export function resolveTutorialTargets(steps, doc, { runtimeAllowed = null } = {}) {
  const failures = [];
  for (const [index, step] of steps.entries()) {
    const target = step && step.target;
    if (target === null || target === undefined) continue;
    if (typeof target !== 'string' || !target.trim()) {
      failures.push(`tutorial step ${index + 1}: target is not a selector (${JSON.stringify(target)})`);
      continue;
    }
    let found;
    try {
      found = doc.querySelectorAll(target);
    } catch {
      failures.push(`tutorial step ${index + 1}: "${target}" is not a valid selector`);
      continue;
    }
    if (found.length === 1) continue;
    if (found.length === 0) {
      // Statically absent is allowed ONLY where the caller says the element is
      // built by the page script and can prove the id is assigned there.
      const runtimeOk = runtimeAllowed ? runtimeAllowed(target) : false;
      if (!runtimeOk) {
        failures.push(`tutorial step ${index + 1}: "${target}" matches no element`);
      }
      continue;
    }
    failures.push(
      `tutorial step ${index + 1}: "${target}" matches ${found.length} elements — a step must ring one control`
    );
  }
  return failures;
}

// --------------------------------------------------------------------------
// Copy rules
// --------------------------------------------------------------------------

/**
 * Brand names, matched case-sensitively as whole words so ordinary prose ("the
 * top edge", "an apple") cannot trip them. The tour describes THIS instrument;
 * naming someone else's product in it is either an endorsement we have not
 * made or a comparison that dates.
 */
const BRAND_NAMES = [
  'Spotify', 'Apple', 'YouTube', 'Deezer', 'SoundCloud', 'Bandcamp', 'Tidal',
  'Ableton', 'Cubase', 'GarageBand', 'Logic Pro', 'Pro Tools', 'FL Studio', 'Reaper',
  'Kontakt', 'Serum', 'Moog', 'Korg', 'Roland', 'Yamaha', 'Fender', 'Steinway',
  'Chrome', 'Safari', 'Firefox', 'Windows', 'macOS', 'iPhone', 'iPad', 'Android',
  'ChatGPT', 'OpenAI', 'Anthropic', 'Claude', 'Cloudflare', 'Google', 'Microsoft',
];

/** US spellings whose UK forms the rest of the page uses. */
const US_SPELLINGS = [
  'color', 'colors', 'colored', 'favorite', 'favorites', 'gray', 'center', 'centered',
  'behavior', 'customize', 'customized', 'visualizer', 'analyzer', 'organize', 'sync\'d',
];

const MIN_TEXT_CHARS = 30;
const MAX_TEXT_CHARS = 460;

/**
 * The whole rule set, as a pure function of (steps, document, tab ids). Kept
 * pure so the mutation checks at the foot of this file can run it over
 * deliberately broken step lists and prove each rule actually bites.
 */
export function validateTutorial(steps, doc, tabIds, { runtimeAllowed = null } = {}) {
  const failures = [];

  if (steps.length < TUTORIAL_MIN_STEPS || steps.length > TUTORIAL_MAX_STEPS) {
    failures.push(
      `the tour is ${steps.length} steps — a first run wants ${TUTORIAL_MIN_STEPS}–${TUTORIAL_MAX_STEPS}`
    );
  }

  failures.push(...resolveTutorialTargets(steps, doc, { runtimeAllowed }));

  const seen = new Map();
  let untargeted = 0;
  const tabOrder = [];

  for (const [index, step] of steps.entries()) {
    const n = index + 1;
    if (!step || typeof step !== 'object') {
      failures.push(`tutorial step ${n}: not an object`);
      continue;
    }

    // ---- copy ----
    const text = step.text;
    if (typeof text !== 'string' || !text.trim()) {
      failures.push(`tutorial step ${n}: no copy`);
    } else {
      if (text.trim().length < MIN_TEXT_CHARS) {
        failures.push(`tutorial step ${n}: copy is ${text.trim().length} chars — too short to say anything`);
      }
      if (text.length > MAX_TEXT_CHARS) {
        failures.push(`tutorial step ${n}: copy is ${text.length} chars — longer than a tour step should be`);
      }
      if (/[<>]/.test(text)) {
        failures.push(`tutorial step ${n}: copy carries markup — the panel renders it as text`);
      }
      for (const brand of BRAND_NAMES) {
        if (new RegExp(`\\b${brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text)) {
          failures.push(`tutorial step ${n}: copy names a brand ("${brand}")`);
        }
      }
      for (const word of US_SPELLINGS) {
        if (new RegExp(`\\b${word}\\b`, 'i').test(text)) {
          failures.push(`tutorial step ${n}: copy uses the US spelling "${word}"`);
        }
      }
    }

    // ---- tab ----
    if (step.tab !== undefined && step.tab !== null) {
      if (!tabIds.includes(step.tab)) {
        failures.push(`tutorial step ${n}: tab "${step.tab}" is not a tab this page renders`);
      } else {
        tabOrder.push(step.tab);
      }
    }

    // ---- target bookkeeping ----
    if (step.target === null || step.target === undefined) {
      untargeted += 1;
    } else if (typeof step.target === 'string') {
      if (seen.has(step.target)) {
        failures.push(
          `tutorial step ${n}: "${step.target}" is already step ${seen.get(step.target)}'s target`
        );
      } else {
        seen.set(step.target, n);
      }
    }
  }

  // ---- arc ----
  // A newcomer is walked forward, never back: once the tour has moved to
  // Advanced, no later step may drop them on Simple again.
  const firstAdvanced = tabOrder.indexOf('advanced');
  if (firstAdvanced >= 0 && tabOrder.slice(firstAdvanced).includes('simple')) {
    failures.push(`the tour returns to Simple after Advanced: ${tabOrder.join(' → ')}`);
  }
  if (tabOrder.length && tabOrder[0] !== 'simple') {
    failures.push(`the tour opens on "${tabOrder[0]}" rather than the Simple tab`);
  }
  if (untargeted > 1) {
    failures.push(`${untargeted} steps ring nothing — only the closing step may have no target`);
  }

  return failures;
}

// --------------------------------------------------------------------------
// Runner
// --------------------------------------------------------------------------

async function main() {
  if (!existsSync(indexHtml)) {
    console.error('tutorial-smoke: dist/index.html is missing — run `npm run build` first.');
    process.exit(1);
  }

  const { JSDOM } = await import('jsdom');
  const source = readFileSync(pageSourcePath, 'utf8');
  const dom = new JSDOM(readFileSync(indexHtml, 'utf8'));
  const doc = dom.window.document;
  const steps = readTutorialSteps(source);

  // The tabs are read off the built page, not listed here: a renamed tab must
  // fail as "not a tab this page renders", not pass against a stale copy.
  const tabIds = Array.from(doc.querySelectorAll('[role="tab"]'))
    .map((tab) => tab.id.replace(/^tab-/, ''))
    .filter(Boolean);
  assert.ok(tabIds.length >= 2, 'the built page renders fewer than two tabs');

  /**
   * A target absent from the markup passes only if the page script assigns
   * that id itself — which is a weaker proof than resolving it, so page-boot
   * runs resolveTutorialTargets() again against the booted document.
   */
  const runtimeAllowed = (selector) => {
    const id = /^#([A-Za-z][\w-]*)$/.exec(selector);
    if (!id) return false;
    return new RegExp(`\\.id\\s*=\\s*['"\`]${id[1]}['"\`]`).test(source);
  };

  let checks = 0;
  function check(label, fn) {
    fn();
    checks += 1;
    console.log(`  ok — ${label}`);
  }

  console.log('tutorial-smoke');

  const failures = validateTutorial(steps, doc, tabIds, { runtimeAllowed });

  check(`the tour reads out of the page source (${steps.length} steps)`, () => {
    assert.ok(steps.length >= TUTORIAL_MIN_STEPS);
  });

  check('the shipped tour breaks none of the rules', () => {
    assert.deepEqual(failures, []);
  });

  // Each rule asserted on its own too, so a red run names the rule that bit
  // rather than one heap of strings.
  check('every target resolves to exactly one element', () => {
    assert.deepEqual(resolveTutorialTargets(steps, doc, { runtimeAllowed }), []);
  });

  check('every tab is a tab the page renders', () => {
    for (const step of steps) {
      if (step.tab === undefined || step.tab === null) continue;
      assert.ok(tabIds.includes(step.tab), `unknown tab "${step.tab}"`);
    }
  });

  check('no two steps ring the same control', () => {
    const targets = steps.map((step) => step.target).filter((target) => typeof target === 'string');
    assert.equal(new Set(targets).size, targets.length);
  });

  check('every step carries plain, UK-spelled, brand-free copy', () => {
    for (const step of steps) {
      assert.ok(step.text && step.text.trim().length >= MIN_TEXT_CHARS);
      assert.ok(!/[<>]/.test(step.text));
    }
  });

  check('the arc runs Simple → Advanced and ends with the share step', () => {
    const tabbed = steps.filter((step) => step.tab).map((step) => step.tab);
    assert.equal(tabbed[0], 'simple');
    assert.equal(tabbed[tabbed.length - 1], 'advanced');
    const last = steps[steps.length - 1];
    assert.equal(last.target, null, 'the tour should close on the untargeted step');
    const targeted = steps.filter((step) => step.target);
    assert.equal(
      targeted[targeted.length - 1].target,
      '#preset-share',
      'sharing should be the last control the tour rings'
    );
  });

  check('the shipped product is actually covered', () => {
    const all = steps.map((step) => step.text).join(' ').toLowerCase();
    for (const topic of [
      'genre',
      'surprise me',
      'favourites',
      'pause',
      'next',
      'add track',
      // v0.0.96: renamed on the owner's ask — the keyboard is Musical typing.
      'musical typing',
      'capture',
      'spread',
      'share',
      'three-word',
    ]) {
      assert.ok(all.includes(topic), `the tour never mentions ${topic}`);
    }
  });

  // ---- mutation checks -----------------------------------------------------
  // Each one breaks the shipped list in exactly one way and asserts the
  // validator reports it. A rule that cannot be made to fail is not a gate.
  let mutations = 0;
  function mutation(label, mutate, expected) {
    const broken = steps.map((step) => ({ ...step }));
    mutate(broken);
    const found = validateTutorial(broken, doc, tabIds, { runtimeAllowed });
    assert.ok(
      found.some((line) => line.includes(expected)),
      `mutation "${label}" was not caught — validator said: ${found.join(' | ') || '(nothing)'}`
    );
    mutations += 1;
    console.log(`  bit — ${label}`);
  }

  mutation(
    'a target that matches nothing',
    (broken) => {
      broken[0].target = '#no-such-control-9d3f';
    },
    'matches no element'
  );

  mutation(
    'a target that matches two elements',
    (broken) => {
      broken[0].target = '.sliders-module';
    },
    'matches 2 elements'
  );

  mutation(
    'a tab the page does not render',
    (broken) => {
      broken[0].tab = 'expert';
    },
    'is not a tab this page renders'
  );

  mutation(
    'two steps ringing the same control',
    (broken) => {
      broken[1].target = broken[0].target;
    },
    'is already step 1'
  );

  mutation(
    'a step with no copy',
    (broken) => {
      broken[0].text = '';
    },
    'no copy'
  );

  mutation(
    'a brand name in the copy',
    (broken) => {
      broken[0].text = `${broken[0].text} It also works in Chrome.`;
    },
    'names a brand'
  );

  mutation(
    'a US spelling in the copy',
    (broken) => {
      broken[0].text = `${broken[0].text} Each track has its own color.`;
    },
    'US spelling'
  );

  mutation(
    'a step sending a newcomer back to Simple',
    (broken) => {
      broken[broken.length - 1].tab = 'simple';
    },
    'returns to Simple after Advanced'
  );

  console.log(
    `\ntutorial-smoke ok — ${checks} checks, ${mutations}/${mutations} mutation checks bit, ${steps.length} steps`
  );
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  await main();
}
