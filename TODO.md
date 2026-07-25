# TODO

## Open

### Awaiting Martin (decisions / actions)
- [ ] Bass verdict FAILED TWICE — craft pass BUILT (v24: pocket, articulation, contour, fills, register, drummerless anchor; see CHANGELOG + contract § v24). Needs Martin's ears; stays default-off until it passes
- [ ] Bass voice envelopes cap articulation — `sub` attack 0.12 s / release 0.75 s means the shortest note any bass voice can sound is ~1 s, so true staccato is unreachable from the engine. Owner: engine-voices.js (shortening the patch ADSR per note also swaps the filter path and adds a node, so it is a deliberate timbre decision, not a tweak)
- [ ] Record button tier decision (free now vs gated when payments exist)
- [ ] xander. playlist copy + NotXander filename: keep / reword / drop
- [ ] Official andeye logo asset for the footer (placeholder deleted)
- [ ] contact.andeye.com form (preset submissions point at it; 404 today)
- [ ] Cloudflare Web Analytics: click Enable (RUM, cookie-less)
- [ ] Preset-name moderation taste rules (whitelist → AI review → human escalation)
- [ ] Premium tier: define the offer
- [ ] Transport buttons: review which (if any) demote to Advanced-only (one-line gate ready)

### Next build queue (engine gaps from v26)
- [x] Master/total analyser (engine) so the scope's white Total trace can ship — `getAnalysers().total` / `getMasterAnalyser()`, tapped off the compressor so both output routes feed it
- [x] Hook-seed param so genre chord DEGREES reach the audio — `harmony.seed`, emitted by compileGenre from its expanded progression
- [ ] Genre UI: dropdown + surprise-me + favourites (mood groups, hide-non-favourites), Pause, Fast-forward, weighted initial-load genre pick — engine side of Pause is in (`engine.pause()` / `resume()`, `state` events carry `paused`)

### Next build queue
- [ ] Playlists rebuild: verified PD/CC0 artwork, broader instrumental artists, Ambi4-made playlist categories
- [ ] Web Analytics privacy-page line (andeye.com/privacy mention of Cloudflare cookie-less beacon)

### Product roadmap additions (v19+)
- [ ] AI-free pledge labelling: a listed preset/album can carry "AI-free" if the user signs a pledge that no external AI compiled it (pairs with Blank slate; enforcement = pledge + moderation, not detection)
- [ ] Custom tracks commit 4 (last): manifests + Add Track UI + --track-user-1…6 theme vars + page-boot user-track gates (commits 1–3 landed: registry, params.userTracks live chains, addTrack/removeTrack/canAddTrack API with sparse quarter-note opening grid)
- [ ] Live MIDI/QWERTY recording into tracks
- [ ] Live play-along mode (same input path triggering track voices in real time)
- [ ] Audio-in track: mic capture to a buffer (on-device only), trim/normalise/loop editing, played through the normal track chain

### Product roadmap (specs in docs/engine-v2-contract.md + brain2 Ambi4-strategy)
- [ ] Share tier 2: named links ambi4.work/[name] via Workers KV + submit/approve
- [ ] Share tier 3: code-bearing presets (sandbox + review gate) — paid
- [ ] Block editor phase 2: full JS seam editor (>_ icon), "default to code" pref
- [ ] Greyed (plus)/(pro) editor buttons routing to a subscription page
- [ ] Arrangement studio: MIDI capture, offline render, mastered binaural/lossless exports
- [ ] Stereo recording tier polish (wav via offline render; webm live capture shipped free for now)
- [ ] Standalone one-off-purchase Mac/iOS build (Tauri/Capacitor)
- [ ] Three-random-word preset naming for free-tier shares

## Parked
- [!] Playlists section (out of nav) — no AI art allowed; needs PD/CC0 imagery for all artists before revival
- [!] Apple Music playlists — lapsed subscription broke pl.u- shares; superseded by multi-service plan
