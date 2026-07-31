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
- You CAN see both sites from this container, through the Mac test bridge:
  `.vibe/measure.sh https://mcdev.ambi4.work/ eval '<expr>'` (and the same for
  ambi4.work) runs real JS in a headless Chromium against the deployed site,
  which is how a stale deploy was caught on 2026-07-30. `docs/rendering-host.md`
  is the how; `docs/deploying.md` says to look before asking him to. What you
  cannot do is JUDGE it — he is the only one who can hear it, and a screenshot
  cannot tell 1px apart from 1px overlapped.

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
node tests/all.mjs                  # EVERY node suite; non-zero exit if any is red
```

`tests/all.mjs` discovers the suites rather than listing them, so a new one is
run the day it lands. It exists because a list in a doc cannot fail: two suites
(`voices-smoke`, red for ~30 versions; `power-smoke`, red since the Node 22
move) sat failing because nothing ran them. Individual suites still run by
name when you want one — `node tests/engine-smoke.mjs`, `node
tests/audio-reference.mjs`, and so on.

Browser tests run against a headless Chromium on a Mac test account over SSH:

```
tests/sweep-drives.sh                                 # EVERY drive, one command
.vibe/measure.sh local drive tests/<name>-drive.mjs   # run one browser test
.vibe/measure.sh local overlaps                       # layout sweep: three SWEEPS, one viewport per run
.vibe/measure.sh local overlaps 390 844               # …so pass a viewport to check a phone
```

`tests/sweep-drives.sh` exists because a hand-run sweep lied: seven of
twenty-eight drives failed in a row and all seven passed alone — their waits
are tuned for an idle Mac. It re-runs a failure SOLO and splits the outcome:
**RED** (failed alone twice, rested) fails the gate; **FLAKY** (green alone) is
listed loudly and does not. The solo re-run RESTS twenty seconds first and a
still-failing drive gets a second rested run — a re-run that starts three
seconds after thirty browser drives is measuring the same load that failed it,
which called `submit-drive` red twice on 2026-07-31 when it passes solo every
time. `SWEEP_SOLO_COOLDOWN` tunes the rest; `SWEEP_RETRY=0` makes every in-suite
failure red when you want the strictest reading.

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
- **Nothing may change instantaneously while it is sounding** — a source stopped
  mid-signal, a `cancelScheduledValues` that drops back to the last completed
  event, a level set rather than reached. Both clicks he reported were this, and
  `tests/onset-render.mjs` now holds the line for every voice. See
  `docs/engine-v2-contract.md`.
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
