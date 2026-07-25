/**
 * Content-provenance report for src/content/playlists/**\/*.md — run with:
 *   node tests/content-check.mjs
 *
 * NOT a smoke test: it never exits non-zero. It exists so unparking the
 * playlists page (TODO.md ## Parked — "no AI art allowed; needs PD/CC0
 * imagery for all artists before revival") doesn't require grepping every
 * frontmatter file by hand. Every playlist entry's `artwork` key is REQUIRED
 * by src/content.config.ts (nullable value) precisely so this script can
 * find every pending decision: it walks the collection's raw frontmatter
 * (no Astro build needed) and prints one report line per entry whose
 * `artwork` is `null` — the images that still need a human to pick a
 * verified PD/CC0/CC-BY source and record it, entry by entry.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const playlistsDir = join(repoRoot, 'src', 'content', 'playlists');

function findMarkdownFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...findMarkdownFiles(full));
    } else if (name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

function readFrontmatter(filePath) {
  const raw = readFileSync(filePath, 'utf8');
  const match = /^---\n([\s\S]*?)\n---/.exec(raw);
  if (!match) return null;
  return yaml.load(match[1]);
}

const files = findMarkdownFiles(playlistsDir).sort();

console.log(`content-check: ${files.length} playlist entr${files.length === 1 ? 'y' : 'ies'} found\n`);

const pendingArtwork = [];
const missingArtworkKey = [];
const generatedCover = [];

for (const file of files) {
  const rel = relative(repoRoot, file);
  const data = readFrontmatter(file);
  if (!data) {
    console.log(`  ! ${rel} — no parseable frontmatter`);
    continue;
  }
  if (!('artwork' in data)) {
    missingArtworkKey.push(rel);
    continue;
  }
  if (data.artwork === null) {
    if (data.presetSeed) {
      generatedCover.push({ rel, title: data.title, presetSeed: data.presetSeed });
    } else {
      pendingArtwork.push({ rel, title: data.title });
    }
  }
}

if (generatedCover.length > 0) {
  console.log(`Generated covers (no sourced image needed, provenance = code) — ${generatedCover.length}:`);
  for (const { rel, title, presetSeed } of generatedCover) {
    console.log(`  - ${title ?? '(untitled)'} [${rel}] — PresetCover seed "${presetSeed}"`);
  }
  console.log('');
}

console.log(`Pending sourced artwork (artwork: null, no PresetCover) — ${pendingArtwork.length}:`);
if (pendingArtwork.length === 0) {
  console.log('  (none)');
} else {
  for (const { rel, title } of pendingArtwork) {
    console.log(`  - ${title ?? '(untitled)'} [${rel}]`);
  }
}

if (missingArtworkKey.length > 0) {
  console.log(`\nMissing \`artwork\` key entirely (schema requires the key) — ${missingArtworkKey.length}:`);
  for (const rel of missingArtworkKey) {
    console.log(`  - ${rel}`);
  }
}

// Informational only — never fails the build. Sourcing PD/CC0/CC-BY imagery
// and recording provenance is a human decision, not something this script
// can pass or fail.
process.exit(0);
