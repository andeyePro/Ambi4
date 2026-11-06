/**
 * The words cannot name a control that is gone.
 *
 *   node tests/doc-drift.mjs
 *
 * Why this exists (post-D8 audit, v0.0.276): v0.0.272-275 retired the
 * per-track summary line, renamed Shuffle / In order to By weight / In turn,
 * and dissolved the Randomise row into dials of their own — and the manual
 * release pass still told the tester to find "the Randomise row's first
 * knob", a tooltip still pointed at "the old summary line", and the contract
 * still described the kit's tabs by their old order words. Nothing failed:
 * prose cannot fail. This does.
 *
 * It reads only what a person reads as CURRENT instructions:
 *   - README.md, whole;
 *   - docs/TESTING.md's open "- [ ]" checklist items (the manual release pass)
 *     — closed items and prose between them are history;
 *   - src/pages/index.astro's user-facing words: every string literal and
 *     template in its scripts (TUTORIAL_STEPS, RULE_CHAPTERS, LESSON_CHAPTERS,
 *     every hint, tooltip and describe() string) and the markup's text, with
 *     code comments stripped (a comment saying what a thing USED to be is
 *     exactly where that belongs);
 *   - every `hint` in src/scripts/param-registry.js (both editors read it as
 *     the dial's tooltip and accessible description).
 *
 * Dated history in docs/*.md (version-stamped sections) is left alone on
 * purpose: it says what shipped at the time.
 *
 * To retire a control: add its name below with the version that retired it,
 * in the same commit as the rename. Exit is non-zero on any hit.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

// ---------------------------------------------------------------------------
// The retired names. Each entry: the pattern, the version that retired it,
// and what replaced it (printed with every hit, so the fix is in the message).
// ---------------------------------------------------------------------------
const RETIRED = [
  // v0.0.275 (D8): the row dissolved into Pan / Timing spreads, Dynamics,
  // Octave wander, Passing notes, and Voice chance in the voice rule's Chance slot.
  { re: /\bRandomi[sz]e row\b/i, retired: 'v0.0.275', now: 'Pan/Timing spreads, Dynamics, Octave wander, Passing notes in the feel row; Voice chance in the voice rule' },
  { re: /\b(?:above|under|below|beside|in) (?:the |its |a )?Randomi[sz]e\b/i, retired: 'v0.0.275', now: 'the editor has no Randomise section; name the feel row or the rule block' },
  { re: /\bvary\.(?:voice|volume|pitch|timing|pan)\b/, retired: 'v0.0.275', now: 'voiceWander / dynamics / octaveWander / timing / pan (spread-dials.js)' },
  // v0.0.273: the sequencer tabs' order toggle uses the Pool's words.
  { re: /\bShuffle\b.*\bIn order\b/, retired: 'v0.0.273', now: 'By weight / In turn' },
  { re: /\bShuffle weights\b/i, retired: 'v0.0.273', now: 'By weight' },
  // v0.0.40: the sleep and alarm icons became one clock button and one Timers popover.
  { re: /\bbehind the alarm icon\b/i, retired: 'v0.0.40', now: 'the Timers popover behind the one clock icon by Play (Sleep timer and Schedule start)' },
  // v0.0.272: the 4 Hz line under each track row; its numbers are on the dials' live pointers.
  { re: /\bsummary line\b/i, retired: 'v0.0.272', now: 'the dials\' live pointers' },
  { re: /\blevel \d+ ?% · random\b/i, retired: 'v0.0.272', now: 'the dials\' live pointers' },
  // v0.0.298 (tour and tooltip audit): words that were FALSE about a control
  // still there — the chord colour button is a nudge either side of the width
  // Complexity gives, not a chord type, and it goes round; the additive P4+
  // are each voice's own partials, not fixed harmonics; a dial that cannot
  // spread has no hub to tap; Simple's Tempo refuses a sideways drag.
  { re: /\bmakes it wider \(a triad\b/, retired: 'v0.0.298', now: 'a step narrower or wider than Complexity plays it' },
  { re: /\bPress to widen it\b/, retired: 'v0.0.298', now: 'narrower / as played / wider, and it goes round' },
  { re: /\bthe button beside them widens it\b/, retired: 'v0.0.298', now: 'sets it a step narrower or wider than Complexity plays it' },
  { re: /\bTap the centre for the middle\b/i, retired: 'v0.0.298', now: 'Double-click for the middle (no hub on a dial that cannot spread)' },
  { re: /\bfourth partial, two octaves up\b|\bfifth partial, two octaves and a third\b|\bsixth partial, two octaves and a fifth\b/i, retired: 'v0.0.298', now: 'the Nth partial this voice is built from' },
  { re: /\bLEFT AND RIGHT to give it a range to drift between, or\b/, retired: 'v0.0.298', now: '…(all but Tempo, which holds one steady speed here)' },
  { re: /\bSurprise me, last in the list\b/, retired: 'v0.0.298', now: "under More, every genre you have not hidden" },
];

const hits = [];
const scan = (where, text) => {
  for (const { re, retired, now } of RETIRED) {
    const m = re.exec(text);
    if (m) hits.push(`${where}: "${m[0]}" (retired ${retired}; now ${now})\n      ${text.replace(/\s+/g, ' ').trim().slice(0, 200)}`);
  }
};

// ---- README.md, line by line (a hit names its line) -----------------------
read('README.md').split('\n').forEach((line, i) => scan(`README.md:${i + 1}`, line));

// ---- docs/TESTING.md's open checklist items --------------------------------
// An item is its "- [ ]" line plus the indented continuation lines under it.
{
  const lines = read('docs/TESTING.md').split('\n');
  let item = null;
  const flush = () => { if (item) scan(`docs/TESTING.md:${item.line}`, item.text); item = null; };
  lines.forEach((line, i) => {
    if (/^\s*- \[ \]/.test(line)) { flush(); item = { line: i + 1, text: line }; return; }
    if (item && /^\s{2,}\S/.test(line) && !/^\s*- \[/.test(line)) { item.text += ` ${line.trim()}`; return; }
    flush();
  });
  flush();
}

// ---- param-registry.js hints ------------------------------------------------
{
  const { PARAM_REGISTRY } = await import(path.join(ROOT, 'src/scripts/param-registry.js'));
  let n = 0;
  for (const [key, row] of Object.entries(PARAM_REGISTRY)) {
    if (typeof row.hint === 'string') { scan(`param-registry ${key} hint`, row.hint); n += 1; }
  }
  if (n < 20) hits.push(`param-registry: only ${n} hints read — the scan lost its rows`);
}

// ---- index.astro: strings and markup text, never comments -----------------
{
  const require = createRequire(import.meta.url);
  let parse;
  try {
    ({ parse } = require('@babel/parser'));
  } catch {
    console.error('doc-drift: @babel/parser is not installed (it comes with astro); run npm ci');
    process.exit(1);
  }
  const source = read('src/pages/index.astro');
  const lineOf = (offset) => source.slice(0, offset).split('\n').length;

  // Every script body: the frontmatter, and each <script> that is not JSON.
  const scripts = [];
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(source);
  if (fm) scripts.push({ start: fm.index + 4, code: fm[1] });
  for (const m of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (/application\/json/.test(m[1]) || !m[2].trim()) continue;
    scripts.push({ start: m.index + m[0].indexOf('>') + 1, code: m[2] });
  }
  if (scripts.length < 2) hits.push(`index.astro: found ${scripts.length} script bodies — the scan lost the page script`);

  // A string's words, located: a literal, a template (its fixed parts, the
  // holes as "…"), or a + chain of them, which is one sentence split for width.
  const words = (node) => {
    if (!node) return null;
    if (node.type === 'StringLiteral') return node.value;
    if (node.type === 'TemplateLiteral') return node.quasis.map((q) => q.value.cooked ?? q.value.raw).join('…');
    if (node.type === 'BinaryExpression' && node.operator === '+') {
      const a = words(node.left);
      const b = words(node.right);
      if (a === null && b === null) return null;
      return `${a ?? '…'}${b ?? '…'}`;
    }
    return null;
  };
  // Which named table a string belongs to, for the message.
  const TABLES = new Set(['TUTORIAL_STEPS', 'RULE_CHAPTERS', 'LESSON_CHAPTERS']);
  let strings = 0;
  const tableSeen = new Set();
  const walk = (node, start, table) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && TABLES.has(node.id.name)) {
      table = node.id.name;
      tableSeen.add(table);
    }
    const text = words(node);
    if (text !== null && (node.type !== 'BinaryExpression' || /[A-Za-z]{3}/.test(text))) {
      strings += 1;
      scan(`index.astro:${lineOf(start + node.start)}${table ? ` (${table})` : ''}`, text);
      if (node.type !== 'TemplateLiteral') return; // a chain's parts are in its words
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue;
      const v = node[key];
      if (Array.isArray(v)) v.forEach((child) => walk(child, start, table));
      else if (v && typeof v === 'object' && typeof v.type === 'string') walk(v, start, table);
    }
  };
  for (const { start, code } of scripts) {
    const ast = parse(code, { sourceType: 'module', plugins: ['typescript'], errorRecovery: true });
    walk(ast.program, start, null);
  }
  if (strings < 1000) hits.push(`index.astro: only ${strings} strings read — the scan lost the page script`);
  for (const t of TABLES) if (!tableSeen.has(t)) hits.push(`index.astro: ${t} not found — the tour scan lost it`);

  // The markup: everything outside the frontmatter, the scripts and the
  // styles, with HTML and JSX comments removed. Line numbers survive because
  // every removed span is replaced by its own newlines.
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  let markup = source
    .replace(/^---\n[\s\S]*?\n---\n/, blank)
    .replace(/<script\b[\s\S]*?<\/script>/g, blank)
    .replace(/<style\b[\s\S]*?<\/style>/g, blank)
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, blank);
  markup.split('\n').forEach((line, i) => { if (line.trim()) scan(`index.astro:${i + 1} (markup)`, line); });
}

if (hits.length) {
  console.log(`doc-drift FAILED — ${hits.length} place(s) still name a retired control:`);
  for (const h of hits) console.log(`  - ${h}`);
  process.exit(1);
}
console.log('doc-drift: ok — no retired control named in README, the open release pass, the page\'s words or the registry hints');
