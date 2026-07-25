# TODO

## Open

### Awaiting Martin (decisions / actions)
- [ ] GitHub branch swap (default → main-clean, delete main, rename → main) then repo → public (AGPL prepped)
- [ ] Verdict round 2: bass groove rework (still off by default); melody now auto
- [ ] Record button tier decision (free now vs gated when payments exist)
- [ ] xander. playlist copy + NotXander filename: keep / reword / drop
- [ ] Official andeye logo asset for the footer (placeholder deleted)
- [ ] contact.andeye.com form (preset submissions point at it; 404 today)
- [ ] Cloudflare Web Analytics: click Enable (RUM, cookie-less)
- [ ] Preset-name moderation taste rules (whitelist → AI review → human escalation)
- [ ] Premium tier: define the offer
- [ ] Transport buttons: review which (if any) demote to Advanced-only (one-line gate ready)

### In flight (overnight wave 2)
- [ ] Psychology-grounded factory presets (src/data/factory-presets.json)
- [ ] Block editor v1 (pattern blocks, tie-to-beat links)
- [ ] Preset URL routes (ambi4.work/[slug]) + presets below Simple dials
- [ ] Knob push-through min/max; piano-roll chord de-overlap

### Next build queue (schema gaps from the preset psychologist)
- [ ] Per-track density param (masking presets need one dense track without global thickening)
- [ ] Per-track swing override; per-step gate/length on melodic lanes
- [ ] Harmonic-rhythm control (chords-per-bar / hold-this-chord)
- [ ] Pad breathing locked to bar phase (Breathe preset premise)
- [ ] RangeValue drift-rate param (slow walks for masking)
- [ ] Per-preset reverb tail (decouple from governor tier)
- [ ] Modes: ionian, mixolydian, phrygian

### Next build queue
- [ ] Voice editor "ghost common" upgrade: knob-level ghost pointers (current: secondary readout + dot)
- [ ] Extensible percussion kit: user-added lanes (toms, cymbals), editable lane names (tier-gated)
- [ ] Mono/glide UI exposure (params live engine-side, melody/bass defaults on)
- [ ] Per-track swing overrides (global swing shipped)
- [ ] visualFps setter in visualiser/scope so the governor's fps budget bites
- [ ] Engine reverb-length hook so the governor's reverbSeconds budget bites
- [ ] randomness default-range flip (probe ready; ship range default with matching UI)
- [ ] Tutorial: add "algorithmic, not AI" provenance note; keep steps current with UI changes
- [ ] Playlists rebuild: verified PD/CC0 artwork, broader instrumental artists, Ambi4-made playlist categories
- [ ] Web Analytics privacy-page line (andeye.com/privacy mention of Cloudflare cookie-less beacon)

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
