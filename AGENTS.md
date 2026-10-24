# AGENTS.md

Instructions for an AI coding agent asked to work on Ambi4. If you are a human
contributor, read `CONTRIBUTING.md` instead.

Ambi4 is a generative music instrument: an Astro static site whose whole engine
runs in the reader's own browser, with no server and no account. Most of what it
does is heard, not seen, and nobody in an agent's sandbox can hear anything. That
is the constraint everything below follows from: measure what can be measured, and
for anything that has to be judged by ear or by eye, the final quality gate is a
contributor who has listened and looked, and can answer for every line.

## Process

`CONTRIBUTING.md` is the authority on what the project will take (scales, genres,
artwork, AI-generated work), tests, house style and licensing. Read it and follow
it; do not restate it in a PR body. Every PR is checked against the CLA
(`CLA.md`); your user agrees to it, not you.

`main` is the production deploy (ambi4.work): never push to it and never target it.
Open pull requests against `dev`, which deploys to a staging site the owner listens
to before anything reaches `main`. See `docs/deploying.md`.

## How it builds

- Astro 7 needs Node 22.12 or later (`.nvmrc`). `npm install`, then `npm run dev`
  for a local server and `npm run build` for the static build.
- `src/pages/index.astro` is the whole generator page: markup, inline script and
  styles in one very large file, on purpose. Edit it with a script doing exact
  string replacement rather than by hand, and check the replacement matched once.
- `src/scripts/ambient-engine.js` is the engine (no DOM), `engine-voices.js` the
  voice library, `knob.js` the dial control, `src/data/genres/*.json` the genres.
- `docs/engine-v2-contract.md` is the engine's parameter contract;
  `docs/dial-control-plane-plan.md` is the dial gesture model. Read the relevant one
  before changing either.

## Verification, and reporting it

There is no `npm test`. The tests are standalone Node scripts under `tests/` that
exit non-zero on failure, and most of them run against the BUILT bundle.
`tests/all.mjs` finds suites by itself – every `tests/*.mjs` whose default export is
not a browser `drive(page)` – so a new suite you add runs in the gate automatically.

```
npm run build
node tests/page-boot.mjs     # the minimum gate (also run first by all.mjs)
node tests/all.mjs           # every Node suite; non-zero if any is red
```

- Run `npm install` with Node 22.12 or later before building (`.nvmrc` says 22).
- Run `npm run build` first; a stale build makes the tests lie.
- Run one gate at a time. Two concurrent `tests/all.mjs` runs contend and flake.
- `page-boot.mjs` boots the whole bundle in jsdom and is memory-hungry (it caps its own
  heap at 1280 MB since v0.0.267). Run it alone, never next to another suite or a second
  copy. An exit code of 137 means the OS killed it for memory, not a test failure –
  re-run it solo before reporting red.
- Run a single suite by name when you want it: `node tests/engine-smoke.mjs`
  (about four minutes), `node tests/knob-gesture.mjs`,
  `node tests/audio-reference.mjs`.
- `tests/audio-reference.mjs` is frozen: it digests settled bars of every preset and
  genre against `tests/audio-reference-baseline.json`. If your change is meant to
  move it, run it with `--update` in the same commit and say so in the PR. If it
  moved and you did not mean it to, that is a regression.
- The `tests/*-drive.mjs` browser tests need Playwright and a real Chromium against the
  built `dist/`. The project's own runner for them is not in the repo, so they are not
  part of the PR gate. List which drives you could not run in the PR.

A change to behaviour comes with its test in the same commit. Prove a new test
fails on the old code before claiming it proves the fix. Measure, do not listen and
do not eyeball: a click is a step in a sample stream and a filter sweep is a
spectral centroid moving, and both can be counted.

Traps in the browser tests that have produced false results:

- `page.goto` to a URL that differs only in its fragment does not reload. Go to
  `about:blank` first.
- `page.mouse` is viewport-relative. Scroll the control into view and re-read its
  box before each interaction.
- Closing an editor hides it rather than removing it; scope queries to the right
  `#voice-editor-<track>`.
- A fresh visit draws a random genre. Pin scale, key and genre before asserting.
- Assert the engine's stored value (`window.__ambi4Engine` is a deliberate test
  seam), not only what the readout shows.

Every PR description must state: what changed and why (and the issue it fixes);
what it does, as a short list; the harness and model you used; the checks run, one
line each with its result, including whether `audio-reference` moved; what was
tested and in which browser; and what was not tested, stated plainly, including
anything that needs ears.

## Rules that are easy to break

- **Nothing may change instantaneously while it is sounding.** A source stopped
  mid-signal, a level set rather than reached, a `cancelScheduledValues` that drops
  to the last completed event: all of these click. `tests/onset-render.mjs` holds
  the line for every voice.
- **Docs change in the same commit as the behaviour**, including the in-app guided
  tour (`TUTORIAL_STEPS` in `index.astro`), which is the one that gets missed
  because it is code. Then tooltips, then `docs/`, then README and CHANGELOG.
- **One interaction model.** The UI is uniform and progressive: learn one way to
  interact and you know how everything works. Do not put every option on the
  surface; nest detail behind the same gesture. A control that cannot honestly do
  what it advertises says so in the UI rather than hiding.
- **Genres and scales have a bar.** A genre must be nameable blind from one bar;
  name a scale for what it is, not for a region. See `CONTRIBUTING.md`.
- **No AI-generated images.** Artwork is verifiable public domain or CC0, with
  source and licence named in the PR. The one recorded exemption is the project's
  own logo, drawn live from the app's components (`CONTRIBUTING.md`).
- **No server, no account, no upload** of anything the user makes.
- **The AI-free label is a user's claim about a piece of music**, not a statement
  about the source code. Do not conflate the two in copy.
- **British spelling, no em dashes** in user-facing copy.
- **Comments explain why.** A comment naming the bug a line prevents stays; one
  restating the line goes.

## What gets an agent-written PR rejected

- **Noise in the diff.** No comments restating the line below, no defensive checks
  for conditions that cannot arise, no helper used once.
- **Silent drift in how presets sound.** An unexplained change to the
  `audio-reference` baseline.
- **Anything obviously odd.** Unused code, a pattern that appears nowhere else in
  the tree, code that does not match the surrounding file.
- **A contributor who cannot answer for the code.** Explain every change to your
  user in plain terms before the PR goes up: what it does, why, and what breaks
  without it.
- **Personal or machine-specific detail.** No LAN addresses, hostnames, usernames
  or home paths.

## If a second AI reviews the diff

A review that does not cite specific files and line numbers from the diff did not
read the diff. Discard it. Require citations, check two of them against the diff,
and throw the review away if they do not match.
