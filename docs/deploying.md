# Deploying Ambi4

Two environments, both Cloudflare Workers static assets, both built from this
repository by branch:

| Branch | Worker | URL | What it is |
|---|---|---|---|
| `dev` | `ambi4-dev` | https://mcdev.ambi4.work | staging — push freely |
| `main` | `ambi4` | https://ambi4.work | **production — pushing IS the deploy** |

## The gate

**Pushing `main` publishes to the live site immediately. There is no separate
release step, no approval queue and no staging promotion.** Treat a push to
`main` as the act of publishing, because that is what it is.

The standing rule, set by the owner on 2026-07-28 after v0.0.41 reached
production unreviewed:

1. Push the change to `dev`.
2. Look at https://mcdev.ambi4.work yourself if you can (see
   `docs/rendering-host.md` — an agent working in a container can, and should).
3. Ask the owner to hard-refresh mcdev, naming **what to look at**, not just
   "please check". "Hard refresh mcdev, check the dials open a spread when
   dragged sideways" is the shape.
4. Push `main` only on an explicit go.

The order matters and was got backwards once: the owner was being asked to run
the *staging* deploy by hand while production was being pushed autonomously.
Staging is the cheap one. Production is the one that needs a human.

### When the gate does not apply

Never, for a change that reaches the site. Documentation-only commits that
cannot alter the built page are still pushed to `dev` first, because the cost
of doing so is nothing.

## Before pushing anything

```
npm run build && node tests/page-boot.mjs
node tests/audio-reference.mjs
```

`page-boot` is the blank-page gate — the generator has shipped blank twice, and
neither time did `astro build` complain. `audio-reference` answers "does this
change how existing presets sound"; if it reports drift, either the change was
not meant to touch the sound, or the regenerated baseline belongs in the same
commit with a sentence saying why.

For a change to layout or to a dial, also run the rendered checks in
`docs/rendering-host.md`. A screenshot is enough to notice that something looks
wrong and useless for proving it is right.

## The manual pass

`docs/TESTING.md` is the ~15-minute human release test. Run it before a version
that changes anything a person touches.

## Deploying by hand

Cloudflare builds from the branch, so an ordinary `git push` is the whole
deploy. The direct route exists for when the git integration is not the thing
you want to exercise:

```
PUBLIC_AMBI4_ENV=dev npm run build && npx wrangler deploy --env dev
npm run build && npx wrangler deploy --env ""
```

The empty `--env ""` is deliberate: with several environments defined in
`wrangler.jsonc`, omitting the flag makes wrangler guess, and it warns about
exactly that.

## Node version — and the silent way a deploy goes stale

Astro 7 refuses to build on anything below Node 22.12, and **a failed
Cloudflare build does not take the site down — it leaves the previous deploy
serving**, so the only symptom is a stale version string in the footer.
`.nvmrc` names the major (`22`) and deliberately not an exact patch: the
builder resolves the newest 22.x it has, whereas an exact pin fails outright
whenever the build image cannot supply that precise patch (this happened:
`22.23.2` — the newest 22.x in existence at the time — was pinned by the
Astro 7 migration, and mcdev sat on v0.0.85 through every push that
followed). If mcdev ever goes stale
again: check the Worker's build log in the Cloudflare dashboard, and if it is
the node version, set `NODE_VERSION=22` in the Worker's build settings —
both are dashboard-side and owner-only; the container has no Cloudflare
credential and its firewall blocks the API.

## Version numbers

`package.json` carries the version; the page prints it at the top of the screen
and again in the footer with the commit and the environment. Bump it in the same
commit as the change it names, so the footer of a deployed build always
identifies what is running.
