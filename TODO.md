# TODO

Reorganised 2026-07-27 by the full history audit (every Martin ask across all
sessions checked against the shipped code; audit record in brain2,
Ambi4-history-audit-2026-07-27). Three sections per the owner's triage.

## 1) No reason not to build

- [ ] Web Analytics privacy-page line — andeye.com/privacy mention of the Cloudflare cookie-less beacon (copy already drafted in the build log; pure copy addition)
- [ ] AI-free pledge labelling — a listed preset/album can carry "AI-free" if the user signs a pledge that no external AI compiled it (spec settled: pledge + moderation, not detection; pairs with the shipped Blank slate)
- [ ] Audio-in track — mic capture to a buffer (on-device only), trim/normalise/loop editing, through the normal track chain (well-specified; capture half needs a real-device test before it can claim done)
- [ ] Block editor phase 2 — full JS seam editor (>_ icon), "default to code" pref (Pro, hidden until purchasable; sandbox design should get an owner glance before the code-execution surface ships)
- [ ] Arrangement studio — MIDI capture, offline render, mastered binaural/lossless exports (Pro; builds on shipped MIDI capture + offline rendering)
- [ ] Stereo recording polish — wav via offline render (webm live capture already shipped free)

## 2) Discussion / decision required

- [ ] BPM range is still hardcoded 40–120 — Martin asked (2026-07-24) "What's the slowest and fastest music to achieve significant commercial success?" as grounds to widen it; the question was never answered and the range never changed. **Only genuine dropped ask the audit found.** Needs: the research answer, then Martin's call on new bounds
- [ ] Bass verdict — craft pass BUILT (v24) but failed Martin's ears twice; stays default-off until his listen passes
- [ ] Bass voice envelopes cap articulation (~1 s minimum note from `sub`) — halving it is a deliberate timbre decision (new fingered/acid basses already close part of the gap)
- [ ] Record button tier decision (free now vs gated when payments exist)
- [ ] xander. playlist copy + NotXander filename: keep / reword / drop
- [ ] Official andeye logo asset for the footer (placeholder deleted)
- [ ] contact.andeye.com form (preset submissions point at it; 404 today — in progress in the andeye.com vibe per the 2026-07-27 session)
- [ ] Cloudflare Web Analytics: click Enable (RUM, cookie-less)
- [ ] Preset-name moderation taste rules (whitelist → AI review → human escalation) — policy must precede Plus-tier renames
- [ ] Premium tier: define the offer
- [ ] Transport buttons: review which (if any) demote to Advanced-only (one-line gate ready)
- [ ] Custom-track share notice wording — shipped as "Brought N custom track(s), playing stock voices."; Martin may overrule
- [ ] Share tier 2 (named links ambi4.work/[name] via Workers KV + submit/approve) and tier 3 (code-bearing presets, sandbox + review gate, paid) — blocked on tier/pricing decisions and Martin's Cloudflare infra step
- [ ] Standalone one-off-purchase Mac/iOS build (Tauri/Capacitor) — a distribution commitment (App Store accounts, review, maintenance), strategic call not routine build
- [ ] Playlists rebuild — service-selectable across streaming platforms, broader instrumental artists, Ambi4-made categories; blocked on Martin sourcing/approving PD/CC0 artwork

## 3) Should not be built

- [!] Greyed (plus)/(pro) editor buttons — superseded by the "hidden until purchasable" owner rule (commit 60217c0); do not build
- [!] Apple Music playlist integration (pl.u- shares) — broke when the subscription lapsed; superseded by the multi-service playlists plan
- [!] Bass on by default — attempted twice (v14 groove, v24 craft pass), failed the owner's listening verdict both times; no further fix determinable without new direction — stays off pending the section-2 listen

## Shipped log

Everything else asked for across 2026-07-24 → 27 is built and verified — 41
items traced to commits/files/tests in the audit record
(brain2 Ambi4-history-audit-2026-07-27); day-by-day detail in CHANGELOG.md.
