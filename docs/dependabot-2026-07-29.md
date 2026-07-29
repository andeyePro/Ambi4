# The 10 Dependabot alerts — per-alert findings, 2026-07-29

Owner ask (2026-07-29): investigate all ten before deciding anything. This is
the investigation; **nothing was upgraded and nothing was dismissed**.

## How the list was obtained

The container's PAT cannot read the Dependabot alerts API (403), so the view
was reconstructed instead: every one of the 373 distinct packages in
`package-lock.json` was swept against the GitHub Advisory Database (the same
source Dependabot matches the lockfile against) via the public GraphQL
`securityVulnerabilities` API. The sweep returns **exactly ten findings — 3
high, 4 moderate, 3 low — matching the counts on the security page**, so this
is the same set GitHub is showing. `npm audit` reports "3" because it groups
the eight astro advisories into one entry per package, not because seven
alerts are invisible locally (an earlier note in TODO.md guessed at orphaned
lockfile entries — wrong; it is only grouping).

## The ten, and what each is actually exposed to here

Context that decides most of them: this is a **prebuilt static site** — no
adapter, no SSR, no server islands; production is static files on Cloudflare.
Every request-time rendering path the XSS advisories need does not exist in
production. The dev server runs only on the developer's own machine.

| # | Severity | Package | Advisory | What it needs | Here |
|---|---|---|---|---|---|
| 1 | High | astro 5.18.2 | GHSA-2pvr-wf23-7pc7 — Host-header SSRF in prerendered error-page fetch | The astro server (SSR/preview) serving requests | **Inert in production** (no server); dev/preview only, localhost |
| 2 | High | astro 5.18.2 | GHSA-8hv8-536x-4wqp — reflected XSS via unescaped slot name | Request-time rendering of a dynamic slot name | **Inert** — two slots exist, both literal (`Base.astro`), and nothing renders at request time |
| 3 | High | sharp 0.34.5 | GHSA-f88m-g3jw-g9cj — inherited libvips CVEs | sharp processing untrusted images | **Inert** — no `astro:assets`/`<Image>` use anywhere; sharp ships with astro but processes nothing; there are no untrusted images regardless |
| 4 | Moderate | astro 5.18.2 | GHSA-f48w-9m4c-m7f5 — XSS via spread attribute names (`renderHTMLElement`) | Spread props fed untrusted names | **Inert** — zero spread props in any `.astro` file |
| 5 | Moderate | astro 5.18.2 | GHSA-jrpj-wcv7-9fh9 — XSS via spread prop attribute names | Same | **Inert** — same reason |
| 6 | Moderate | astro 5.18.2 | GHSA-4g3v-8h47-v7g6 — reflected XSS via View Transition animation properties | `transition:*` directives | **Inert** — none used (greps match only CSS `transition:` properties) |
| 7 | Moderate | astro 5.18.2 | GHSA-j687-52p2-xcff — XSS in `define:vars` via incomplete `</script>` sanitisation | A `define:vars` value carrying attacker text | **The one real constraint** — see below |
| 8 | Low | astro 5.18.2 | GHSA-7pw4-f3q4-r2p2 — XSS via `transition:*` directive value | `transition:*` directives | **Inert** — none used |
| 9 | Low | astro 5.18.2 | GHSA-xr5h-phrj-8vxv — server-island encrypted params | Server islands (`server:defer`) | **Inert** — none |
| 10 | Low | esbuild 0.27.7 | GHSA-g7r4-m6w7-qqqr — dev-server arbitrary file read | The dev server reachable by an attacker | **Inert in production**; local-dev-only surface |

### Alert 7 is the only one touching a feature this site uses

`src/pages/[preset].astro:63` passes `define:vars={{ slug: preset }}`. The
slugs come from `resolveFactoryPresets()` at build time — machine-generated
three-word names in committed data, not user input — so today the alert is
inert. It stops being inert the day a **submitted** preset's slug reaches the
factory-preset data without moderation: a slug containing `</script>` would
break out of the inline script. Two consequences, neither urgent: the
preset-name moderation policy (already in TODO for v0.1.0) is a security
control, not just taste; and a build-time assert that no slug contains `<`,
`>` or quotes would make the constraint self-enforcing. The real fix is the
astro upgrade.

## The root fix, and the decision to make

Every astro advisory is fixed by **astro ≥ 7.1.0** (the latest
first-patched-version among the eight; current is 7.1.4), and `npm audit`
confirms the esbuild and sharp findings also resolve through the astro major
(`fixAvailable: astro` on all three packages). astro 5 → 7 is a breaking
major: it must be a deliberate migration — upgrade, full engine suite, every
browser drive, the layout sweep, and `tests/audio-reference.mjs` byte-still —
never `npm audit fix --force`.

**Recommendation:** all ten are honestly dismissible today ("vulnerable code
is not used" / no server), BUT the v0.1.0 gate already says the advisories
must be addressed before going public, and the moderation caveat on alert 7
means the static-site argument weakens the moment preset submissions open. So:
plan the Astro 7 migration as its own pre-v0.1.0 item rather than dismissing
and forgetting; dismissal in GitHub (owner-only — the PAT cannot) is optional
cosmetics in the meantime, with "vulnerable code is not used" as the reason on
1–6 and 8–10, and alert 7 left open as the reminder that carries the caveat.

Asked in fromClaude 93: his go on planning the migration now versus nearer
v0.1.0, and whether he wants the cosmetic dismissals meanwhile.
