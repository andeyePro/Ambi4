# Ambi4 — how to work in this repo

Read this before touching anything. It is the short version; the long versions
are in `TODO.md`, `CHANGELOG.md`, `CONTRIBUTING.md` and `docs/`.

Ambi4 is a generative music app: an Astro static site with the whole engine in
the reader's own browser. `src/scripts/ambient-engine.js` is the engine,
`src/scripts/engine-voices.js` the voice library, `src/pages/index.astro` the
entire page (markup, script and styles — it is very large, edit it with `python3`
string replacement rather than by hand).

## The owner's channels — poll them, never rewrite them

Martin communicates through two files in the brain2 mount. **Poll
`Ambi4-fromMartin.md` at the start of every iteration.**

| File | What it is |
|---|---|
| `/brain2/andeye/Ambi4-fromMartin.md` | His inbox to you. Numbered items. |
| `/brain2/andeye/Ambi4-fromClaude.md` | Your **open asks** to him. Numbered. |
| `/brain2/andeye/Ambi4-QandA-archive.md` | Every input he has ever written, verbatim. |

Rules, all learned the hard way:

- **Never rewrite `fromMartin` wholesale.** Edit it only by deleting lines you
  have actioned, and copy his text into the archive verbatim first. Rewriting it
  destroyed three of his answers before he had read them, twice.
- `fromClaude` is **open asks only** — things you need him to DO or DECIDE. No
  progress notes, no information-only items. He said so explicitly: *"What do
  you want me to do? Nothing I assume so no need to tell me."*
- **One action per number.** Never append to a number he has already started
  reading; new work gets a new number, and it **names the build it landed in**.
- Needing his input is never a reason to stop. Write the ask, move to the next
  thing that needs no input.
- No backticks in brain2 files.

## Branches: `dev` is free, `main` is the deploy

- `dev` → mcdev.ambi4.work. Push freely.
- `main` → ambi4.work. **Pushing `main` IS the production deploy.** It needs his
  explicit go, every time. See `docs/deploying.md`.
- You cannot see either site from this container. He is the only one who can
  look at it.

### `git push` needs the credential-helper override

The mirrored gitconfig points github.com at a `gh` binary that does not exist in
the container. Every push must be:

```
git -c credential.helper= -c credential.helper=/usr/local/bin/vibe-credential-helper push origin HEAD:refs/heads/dev
```

A plain `git push` fails with `gh: not found`. The PAT also lacks `workflow`
scope, so anything under `.github/workflows/` has to be pushed by Martin from
the Mac checkout.

## The test gates

Nothing ships without these. There is no `npm test`; run them by name.

```
npm run build                       # must be run first — the tests use the BUILT bundle
node tests/page-boot.mjs            # the page actually boots (it has shipped blank twice)
node tests/engine-smoke.mjs         # ~237 engine assertions
node tests/audio-reference.mjs      # 24 frozen configs, note-for-note
```

Browser tests run against a headless Chromium on a Mac test account over SSH:

```
.vibe/measure.sh local drive tests/<name>-drive.mjs   # run one browser test
.vibe/measure.sh local overlaps                       # layout sweep, three viewports
```

`.vibe/measure.sh` is the one that decides layout questions. **A screenshot
cannot tell 1px apart from 1px overlapped** — three faults reached him that way.
Its three sweeps are text-rect collisions, text overflow, and containers whose
children paint past their own edge.

`tests/audio-reference.mjs` is FROZEN. If a change is meant to move it, run it
with `--update` **in the same commit** and say so in the message. If a change
was not meant to move it and does, that is a regression.

## Rules he has set, that cost time when forgotten

- **Docs change in the SAME commit as the behaviour** — including the in-app
  guided tour (`TUTORIAL_STEPS` in index.astro), which is the one that gets
  missed because it is code rather than prose. Then tooltips, then `docs/`,
  then README, then CHANGELOG.
- **`TODO.md` is the open backlog** (`[ ]` open, `[!]` abandoned with the reason,
  `[x]` done with what shipped). **`CHANGELOG.md` is the done-work log**,
  reverse-chronological, reader-facing. Both land with the code.
- Bump `package.json` version with each shipped change; the version shows at the
  top of the screen and in the footer.
- **Prove a test fails on the old code before claiming it proves the fix.**
- **Measure, don't listen and don't eyeball.** A click is a step in a sample
  stream and a step has a size; a filter sweep is a spectral centroid moving and
  it can be counted in octaves. Nobody in this container can hear anything.
- If a control cannot honestly do what it advertises, say so in the UI rather
  than hiding the control. See the chord widen button, which explains that
  Complexity is what decides the width.

## Traps in the browser tests, all of which have produced false results here

- **`page.goto` to a URL differing only in its fragment does not reload.** It is
  a same-document navigation, so nothing re-boots and every assertion after it
  passes against the page that was already there. Go to `about:blank` first.
  Three of four share-link checks were vacuous until this was found.
- **`page.mouse` is viewport-relative.** A dial below the fold receives a drag
  delivered to nothing, which is indistinguishable from a dial refusing the
  gesture. `scrollIntoView({block:'center'})` and re-read the box before every
  interaction.
- **Closing an editor hides it, it does not remove it.** Scope every query to
  `#voice-editor-<track>` or the wrong track's DOM answers.
- **A fresh visit draws a RANDOM genre.** Pin the scale/key/genre before
  asserting anything that depends on them, or the test passes or fails on the
  draw.
- **Assert the ENGINE's stored value, not just the readout.** A control drawing
  a value the engine never received is the failure mode he has hit twice, and a
  DOM-only test passes on it.
- `window.__ambi4Engine` is a deliberate test seam, not a leak — documented at
  its definition. Use it.

## Where the design decisions live

- `docs/engine-v2-contract.md` — the engine's param contract, including which
  fields are rangeable and why the ones that are not, are not.
- `docs/dial-control-plane-plan.md` — the dial gesture model.
- `docs/TESTING.md` — the manual release pass, and what `page-boot` asserts.
- `docs/deploying.md` — the branch/environment table and the deploy gate.
- `CONTRIBUTING.md` — genres, scales, the AI-free distinction, licence and CLA.
