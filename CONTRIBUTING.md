# Contributing to Ambi4

Thanks for looking. Ambi4 is a generative music instrument that runs entirely in
a browser tab — no server, no account, no upload of anything you make. That
shapes most of what follows.

## The short version

- Open an issue before a large change, so nobody builds the same thing twice.
- Run `npm run build && node tests/page-boot.mjs` before you open a pull request.
- Add your name to `CONTRIBUTORS.md` in your first pull request, in your own commit.
- Everything you contribute is released under AGPL-3.0 and, separately, licensed
  to andeye Ltd under `CLA.md`. Both are explained under **Licensing** below.

## What the project will and will not take

### Scales, modes and genres — yes, with a shape

New 12-TET scales are cheap and welcome: the scale table is a plain array of
semitone offsets in `src/scripts/ambient-engine.js`. Add the intervals, name the
scale for what it actually is rather than for a region ("Hijaz", not "Middle
Eastern"), and say in the pull request where the interval set comes from.

New genres are a data file under `src/data/genres/` plus a voicing. The bar a
genre has to clear is the one the existing twelve are held to: **someone who
knows the genre should be able to name it blind, from one bar, without being
told.** A genre that sounds like the others with a different tempo is not a
genre yet. `node tests/genre-smoke.mjs` checks the data; ears check the rest.

### Tunings beyond 12-TET — not on spec

Quarter-tone maqamat, gamelan slendro and pelog, imported temperaments and a
user scale builder all need the pitch pipeline rebuilt around cents or ratios
rather than semitone integers. It is real work and it is on the roadmap, but the
project does not build individual tuning systems to order. Two routes are open:
contribute the change yourself following this guide, or take a Premium licence,
in which case andeye undertakes to build it to your satisfaction within three
months.

### Artwork — public domain or CC0 only, with provenance in the commit

No AI-generated images, anywhere, ever. Any artwork added to this repository
must be verifiably public domain or CC0, and the pull request must name the
source and the licence for each file. Artwork whose provenance cannot be shown
is removed rather than researched later.

### AI-generated code and music

You may use whatever tools you like to write your contribution — this project
is itself largely written with an AI assistant, which the footer says out loud.
What matters is that you understand what you are submitting and can answer
questions about it in review.

The AI-free labelling that appears on presets and albums is a different thing
entirely: it is a claim a **user** signs about a piece of music, not a claim
about the source code. Do not conflate the two in copy.

## Working on the code

### Layout

- `src/pages/index.astro` — the generator page. Large, and deliberately one
  file: it is the page, its inline script and its styles.
- `src/scripts/ambient-engine.js` — the engine. Scheduling, harmony, structure,
  the random walks. No DOM.
- `src/scripts/engine-voices.js` — the voice library and patch defaults.
- `src/scripts/knob.js` — the dial control. Read its header before changing a
  gesture; the interaction model is a specification, not an accident.
- `src/scripts/scope.js`, `visualiser.js` — oscilloscope and piano roll.
- `src/data/genres/*.json` — one file per genre.
- `tests/` — see below.
- `docs/` — the deploy gate, the manual release test, the dial plan.

### Tests

There is no test runner; every file is a standalone Node script that exits
non-zero on failure.

```
npm run build && node tests/page-boot.mjs     # the minimum gate for any PR
node tests/engine-smoke.mjs                   # ~4 min, the big one
node tests/knob-gesture.mjs                   # the dial gesture contract
node tests/audio-reference.mjs                # does this change how presets sound?
```

`tests/audio-reference.mjs` deserves a paragraph. It digests eight settled bars
of every factory preset and stock genre at a fixed seed and compares the result
against a committed baseline. **If your change alters that baseline, that is not
automatically a failure — but it must be deliberate, declared in the pull
request, and the regenerated baseline must land in the same commit.** Silent
drift in how existing presets sound is the one regression this project cannot
detect any other way.

Some checks need a real browser and therefore a rendering host — see
`docs/rendering-host.md`. They are not part of the pull-request gate; a
maintainer runs them.

### House style

- British spelling in prose and in user-facing copy.
- Comments explain **why**, not what. A comment that restates the line above it
  will be removed; a comment naming the bug a line prevents will not.
- Never hide a fix behind a version number in a comment without saying what the
  fault was. Half this codebase's comments are load-bearing for that reason.
- No em dashes in user-facing copy; en dashes with spaces are fine.

## Licensing — what you are agreeing to

Ambi4 is licensed under **AGPL-3.0**, with one additional permission under
section 7 recorded at the top of `LICENSE`: **the audio you make with Ambi4 is
yours.** Output is not a covered work, so nothing about the AGPL reaches the
music a user generates, records or sells.

Contributions are additionally covered by the **andeye Contributor Licence
Agreement** (`CLA.md`, version 1.0). In plain terms: you keep your copyright,
your contribution stays available under AGPL-3.0 and that cannot be taken back,
and you additionally allow andeye Ltd to relicense it — which is what lets the
same code ship in places the AGPL cannot reach, such as an App Store build, and
lets andeye maintain the output exception above. The numbered clauses in
`CLA.md` are what actually binds; the summary box at the top of that file is
friendly, not authoritative.

The CLA Assistant check runs on every pull request and will ask you to agree
once. Please read `CLA.md` before you do.

## Reporting a problem with the sound

Ambi4 is an instrument, so a lot of its bugs are things you can hear and nobody
can see. Those reports are welcome and they are much more useful with:

- the genre or preset, and the share link if you have one (the three-word name
  is enough — it identifies the exact settings);
- which track it is, found by muting the others;
- whether it happens from the first bar or only after a while;
- what you expected instead.

"The bass clicks at the start of each note in Soul Groove" is a report that can
be acted on. "The bass sounds wrong" is a conversation, which is also fine —
open an issue and we will work it out.
