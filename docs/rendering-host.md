# Seeing the page from inside a container

**If you are an agent working in a vibe container on this Mac: you can see
rendered pages and drive them. Most sessions do not know this, which is why this
file exists.**

There is no browser in the container and none can be installed — the firewall
allows GitHub, npm, Anthropic and the VS Code marketplace, and every host that
could supply a Chromium binary is blocked. The container also cannot reach
ambi4.work or mcdev.ambi4.work directly.

A dedicated macOS test account on this machine can do both. Two scripts drive it
over SSH.

## What is available

| Command | What it does |
|---|---|
| `.vibe/shot.sh local` | builds nothing — ships the existing `./dist`, serves it on the Mac, screenshots it |
| `.vibe/shot.sh https://mcdev.ambi4.work/` | screenshots a live URL |
| `.vibe/measure.sh local overlaps` | sweeps every visible text leaf for collisions and overflow, prints the rectangles |
| `.vibe/measure.sh local box '.knob-value'` | prints the rect of every match |
| `.vibe/measure.sh local eval '<one-line expression>'` | runs JS in the page |
| `.vibe/measure.sh local drive tests/dial-drive.mjs` | ships a local `.mjs` over and scripts the page with Playwright |

Both take `[width] [height]`, and honour `SHOT_CLICKS` (comma-separated
selectors clicked before the shot — how you reach a tab or open a popover),
`SHOT_THEME=dark` and `SHOT_PATH=/some/page`.

`shot.sh` writes a PNG under `.vibe/shots/` and prints the path; read it with
the Read tool, which displays images.

## Use measure, not shot, to decide anything

A picture is enough to notice that something looks wrong and completely useless
for proving it is right. Two captions one pixel apart and two captions one pixel
overlapped render identically at any scale an agent reads a screenshot at — and
that is not hypothetical, it is how four dial captions came to be painted 56 px
over each other in every track editor and shipped.

So: `shot.sh` to see what a change looks like, `measure.sh overlaps` to assert
that nothing collides, and a committed `drive` script for any behaviour you want
to stay fixed. `tests/transport-drive.mjs` and `tests/dial-drive.mjs` are the
two that exist; both were proven to fail against the pre-fix code before being
trusted.

## Setup (once, on the Mac, as the test user)

Since 2026-10-03 the test user is vibe's own `claude` account (the old
`ambitick` account no longer exists on the Mac), reached with the project key
`.vibe/id_ed25519_mac` (gitignored; generate with `ssh-keygen -t ed25519 -N ''
-f .vibe/id_ed25519_mac` if missing). The scripts pass `-F /dev/null`, so the
Mac's own `~/.ssh/config` needs no edit.

1. Authorise the key, as an admin on the Mac — `-H` matters, without it `~` is
   the admin's own home: `cd / && sudo -H -u claude sh -c 'mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys' < .vibe/id_ed25519_mac.pub`
2. `mkdir -p ~/shot && cd ~/shot && npm init -y && npm i playwright && npx playwright install chromium`

Local to the account, not `-g`: the global module directory belongs to the
primary user, so a global install from the test account fails with EACCES.

`AMBI4_SHOT_HOST` overrides the SSH target and `AMBI4_SHOT_KEY` the key file name in `.vibe/` (default `id_ed25519_mac`).

## Two Macs, many runs at once (2026-10-30)

There is a second test account on the second Mac (MBP08L; brain2's
mac-test-account note names the account), and Martin's rule is to use it
whenever it answers: it is the faster machine and has a fan. Its
`authorized_keys` holds `.vibe/id_ed25519_ambi4shot` (not `id_ed25519_mac`),
and its Node is `~/shot/node/bin/node` in that account. `measure.sh` tries it first
(a four-second probe) and falls back to the Air; `AMBI4_SHOT_MAC=air` or
`AMBI4_SHOT_MAC=mbp08l` forces one. The scripts live in `.vibe/`, which is
gitignored, so a fresh clone has to copy them from a sibling checkout.

Several agents can share a Mac: `AMBI4_SHOT_SLOT=<n>` gives a run its own port
(`8731 + n`), site folder (`~/shot/site-<n>`) and tarball, so one run's
`pkill` no longer stops another's server. Slot 0 is the old single-run layout.
A worktree sets `AMBI4_REPO_ROOT=<worktree>` (or copies `.vibe/` in) so its own
`dist` is the one uploaded. Builds still go one at a time on the 7 GB
container: `flock /tmp/ambi4-build.lock npm run build`.

The site server (2026-11-05) is the stdlib's `ThreadingHTTPServer` with a listen
backlog of 128, started by a `python3 -c` one-liner whose command line still
reads `http.server <port>` so the `pkill` patterns match. `python3 -m
http.server` queues only 5 connections, and a boot that fetches its twelve
modules at once (v0.0.293) got ERR_CONNECTION_RESET from it — a fault of the
test server, not of the page; a sibling checkout's older `measure.sh` still has
it. Never build into another `--outDir` beside a running gate: astro writes the
pages into `./dist` regardless, under the gate's feet.

## For a vibe in another project

The account and its Playwright install are not specific to Ambi4 — anything that
can be served over HTTP can be shot and measured. Copy `.vibe/shot.sh` and
`.vibe/measure.sh` into that project and change `AMBI4_SHOT_HOST` and the key
path, or point `--host` at the same account with your own key. If it does not
work, ask the vibe project's own session to fix it rather than debugging the SSH
plumbing by hand — key plumbing is a tar-pit.

## What this is not

It is not general SSH-out authorisation. These two scripts talk to one local
test account for the single purpose of rendering a page. Anything else that
wants to leave the container still needs asking about first.
