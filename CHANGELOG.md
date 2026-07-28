# Changelog

## 2026-07-28

- [x] **v0.0.37 — the Main dials stop stacking** — the Advanced tab's Main dials were rendering
  as one preposterous vertical column instead of a row. Cause: `#advanced-dials` carries
  `.sliders-module`, which is `display: flex` so the Simple tab's four dials sit in a row — so
  the grid inside it was a flex item with no width of its own, shrink-to-fit, and its
  `repeat(auto-fit, minmax(120px, 1fr))` resolved to the single narrowest column it could fit.
  The panel wraps a label, a grid and a hint; it was never meant to be a flex row itself.

  Now `display: block` on the panel and an explicit four-column grid, so the four dials that
  mirror Simple fill the first row and the extra three — Reprise, Swing, Reverb tail — sit
  beneath them, which is both the shape asked for and the one that reads. Two columns below
  760px, one below 400px. The flex-context `max-width` is dropped inside the grid, where a cell
  already centres its dial and the cap would only strand the label to one side.

  Suites green: knob/scope 106, visualiser 45, blocks 41, governor 12, prefs 22, share-name 13,
  genre 29, tutorial 8+8, page-boot.

## 2026-07-27

- [x] **v0.0.36 — the oscilloscope and piano roll say what they mean** — the increment that
  needed no owner input, and the one worth looking at on a real device.

  **The total trace no longer waits for another trace.** Not the latch first diagnosed: the
  guard `if (!allowed || !open || !ids.length) return` bailed out before any attach whenever no
  *track* trace was selected — and the total is an analyser of the finished mix that owes
  nothing to any track. An empty track list is now a legitimate attach when Total is what was
  asked for (`normaliseTracks` has always accepted `[]`), the attach key distinguishes "no
  tracks" from "no tracks plus total", and toggling Total re-attaches rather than only calling
  the setter.

  **Oscilloscope labels stopped pretending to be buttons.** Pill border, radius, uppercase and
  0.06em letter-spacing all gone — that styling is why 11px read visibly larger than the piano
  roll's own 11px lane labels sitting right beside it. The dots went tri-state to match the
  roll's lamp: the track's own colour for "will show when it plays", white for "sounding now",
  a bar for "playing but its trace is hidden". Spread became a vertical double arrow, because
  the word sat between the track traces and the total trace and read as another trace.

  **The section label got its own strip below the lanes.** It was drawn at `height - 4` with
  nothing reserved for it, so it landed inside the lowest lane — under the kick, invisible —
  while chord names always cleared the top pad because TOP_MARGIN reserved theirs. Lanes now sit
  between a top strip and a bottom strip, and the label is full size again.

  **Chord labels stack instead of overdrawing.** There was no `measureText` anywhere in
  visualiser.js; the only crowding guard was an 8px bar-tick gate, narrower than "Cmaj7", so
  adjacent names simply painted over each other. Each name now measures itself, takes the first
  row it clears and drops to a second row if it does not — with a per-character fallback if a
  context ever lacks `measureText`, and the smoke suite's mock context gained the method.

  **Maximise works on iPhone.** The capability gate required `Element.requestFullscreen`, which
  iOS Safari does not implement at all, so both fullscreen buttons were hidden outright on the
  device that most wanted them. The native API is now preferred rather than required; without it
  the stage is pinned over the viewport at `100dvh`, so Safari's collapsing address bar cannot
  crop the display, and Escape is wired by hand since only the native path gets it free.

  Also adds a staging environment: `wrangler.jsonc` gains an `env.dev` serving the same assets
  as `ambi4-dev` on mcdev.ambi4.work, and a `PUBLIC_AMBI4_ENV=dev` build stamps the footer and
  adds noindex, so a staging copy cannot compete with the real site for its own name.

  Suites green: engine 222, voices 283, knob/scope 106, visualiser 45, blocks 41, governor 12,
  prefs 22, share-name 13, genre 29, tutorial 8+8, page-boot.


- [x] **v0.0.35 — the two randomness dials come apart, and share links learn their own version** —
  Three things, all of them things that were quietly wrong.

  **Share payload versioning.** Links have shipped since v0.0.33 carrying the raw settings
  tree, base64url'd, with no schema field at all. An older client meeting a newer link
  therefore dropped every key it did not recognise and played a *different piece* — under the
  *right* three-word name, because the name is a hash of the payload bytes. Silent divergence
  with a matching identity is the worst failure a serverless share scheme can have. The payload
  now carries `v: 1`, read and stripped on decode so it can never reach the settings tree;
  an absent `v` reads as version 0, so every link minted before today keeps working untouched;
  and a link from a newer build now says so in the arrival note instead of pretending. One-time
  cost, taken deliberately: the same settings hash to different words than they did yesterday.

  **Randomness and Repetition de-fused on Advanced.** The owner reported that cranking
  Repetition dragged Randomness from 96% to ~46%. It did: the Advanced Randomness dial was a
  `buildMirroredDial` view of the *Simple tab's fused macro*, so it wrote
  `repetition = 1 − randomness` plus every track's randomness, and displayed
  `(1 − repetition + mean(randomness)) / 2` — two engine params that share no code path,
  presented as one control. Advanced now has its own **Variation** dial writing only per-track
  randomness and reading `trackRandomnessValue()`, and **Reprise** owning `repetition` alone.
  Simple keeps its fused macro on purpose: one knob for "how much does this change" is what
  makes the Simple tab simple.

  **Names and end-marks.** Repetition → **Reprise** (Rarely ↔ Always), Advanced Randomness →
  **Variation** (Hold ↔ Vary), each with its own marks instead of the mirror-image word sets
  (Repetitive/Evolving/Random against Random/Evolving/Repetitive) that made the pair read as
  one dial in the first place. Reprise rather than Recall because in every mixer and synth
  "recall" means restoring saved settings, and this app has presets and share links. "Never"
  was dropped as an end-mark because it is untrue — at Reprise 0 the hook still loops every
  eight chords. Wire keys are frozen: `randomness` and `repetition` stay the serialised names
  forever; these are labels only.

  Advanced also now opens with the main dials **above** the Tracks list, so tempo is where a
  Simple-tab user expects to find it.

  Scope set by a Fable review of the whole v0.0.35–v0.1.0 span, which found the original
  v0.0.35 was four plan phases plus eight unrelated UI items plus two new engine params plus an
  unresolved owner gate. Its findings are folded into TODO.md and
  `docs/dial-control-plane-plan.md`; the share-versioning gap above was its most serious catch.
  All suites green: engine 222, voices 283, knob/scope 106, visualiser 45, blocks 41,
  governor 12, prefs 22, share-name 13, genre 29, tutorial 8+8, page-boot.


## 2026-07-25

- [x] **v0.0.34 — the guided tour tells the truth again** — TUTORIAL_STEPS rewritten 10→14 for the shipped product (genres + Surprise me + favourites + Pause/Next, play-along + Capture, spread/fullscreen displays, Add Track, share flow with its three-word name); the closing step's stale claims corrected. New tutorial-smoke suite (every step's target resolves to exactly one element in the BUILT page, tabs real, copy brand-free UK English, arc Simple→Advanced→share; 8 checks + 8 mutations bit) + a page-boot tutorial gate for script-built targets. TODO: greyed paid-button item struck as superseded by the hidden-until-purchasable rule.

- [x] **v0.0.33 — three-word names for share links (free tier)** — every `#p=` link now has a
  deterministic three-word name drawn from the 938-word vetted list
  (`misty-harbour-lantern`): FNV-1a/32 over the fragment payload, three frozen seeds,
  murmur3 finaliser, indices made distinct — no clock, no randomness, no server, so the
  sender and the receiver read the same three words off the same link forever. Shown
  when the link is copied (reserved line under the Share row, in the share note, and
  offered as the preset name only while that box is empty) and again when a link
  arrives. Display only — a handle for a wall of base64, not a claim: `ambi4.work/[name]`
  stays the paid registry tier. New module `src/scripts/share-name.js` +
  `tests/share-name-smoke.mjs` (13 checks), 5 new page-boot gates covering both ends of
  a link (the receiving end is a second jsdom boot against a real share URL); 4/4
  mutation checks bit. Contract v29 addendum.

- [x] **v0.0.32 — play the instrument: live play-along + capture** — engine noteOn/noteOff/allNotesOff through each track's existing chain (custom tracks included, stopped or playing, never perturbing the deterministic stream — proven byte-identical over 3 seeds); QWERTY two-row keyboard with octave shift that never captures while typing; feature-detected Web MIDI on the same seam; Capture arms a take and quantises rhythm/velocity/length into the track's sequencer with one-click Undo (pitches follow the piece's harmony — step lanes hold no pitch, stated honestly in the UI). Transport row probe-gated; engine 211→222; ~20 new page-boot checks incl. a mocked MIDI device; 9/9 mutation checks bit. Free tier. Contract v28 addendum.

- [x] **v0.0.31 — custom tracks SHIP (registry commit 4/4)** — instrument manifests (sanitised, range-derived dials, code-shaped content rejected whole, zero-dial manifests refused, engine.getTrackManifest accessor) + the Add Track UI: name-and-family form, live rows built by the same wiring as the built-in six (pre-mortem blocker 4 cleared by extraction), kit grids for percussive user tracks, remove on user tracks only, --track-user-1…6 CVD-searched palette, genre/Blank-slate keep user tracks. Also fixed: a stored setup carrying userTracks would have blank-paged init. Engine 208→211, +3 page-boot gates, byte-identity clean, all suites green. Custom tracks are free-tier.

- [x] **v0.0.30 — user-track API (registry commit 3/4)** — engine.addTrack/removeTrack/canAddTrack: id generation from label with collision-suffixing, family-driven voice-set defaults, cap 12 total / 6 user, built-in removal refused, `tracks` event on registry change only, and a sparse quarter-note opening grid so a fresh track sounds intentional (stored blobs keep their own lanes). Engine suite 198→208; byte-identity clean over 3 seeds × 6 runs; 4/4 mutation checks bit.

- [x] **v0.0.29 — genre-signature voicings (owner verdict: genres sounded samey)** — eleven new voices (poly-saw pad; fingered/saw/squelch/upright basses; tine e-piano, nylon guitar, worn tape keys, organ-stab melodies; muted comping arp; worn lo-fi kit); all twelve genres re-voiced so no two share a pad/bass/melody triple and each leads with an instrument an expert could name in a bar; bass reined in everywhere (level 0.55–0.68, randomness 0.1–0.3 so the riff locks). Voices suite 214→283, genre 25→29 with binding uniqueness/restraint rules; contract v27 addendum. The short-release basses also close half of the v24 "true staccato unreachable" ceiling.

- [x] **v0.0.28 — user tracks in the engine (registry commit 2/4)** — `params.userTracks`: sanitised schema, live per-track graph chains added/removed mid-run with ring-out teardown, chord-tone line + percussion-kit grid planners for user tracks, unknown-id-safe voice/stats/analyser paths. Engine suite 184 → 198; byte-identity vs pre-change capture over 3 seeds; mutation-checked. Fullscreen menu glide + dismissable spread labels (aedcb49) rode along earlier today.

- [x] **Owner rulings actioned (fromMartin 22/25)** (ca150e8, dda9129) — front oscilloscope stays dark until Play (stopped-state composite retired, boot gate inverted to assert darkness); Blank slate button in Advanced silences everything (tracks off, sequencer lanes cleared + Manual, arp emptied, swing/complexity/repetition zeroed, genre cleared) with its own boot gate — groundwork for AI-free pledge labelling. Confidential strategy/VC/SWOT and FTO/IP teams dispatched to brain2.

- [x] **v0.0.25-27 — bass craft, genres audible** — bass groove machinery fixed at root (never engaged under waves/build) + pocket/articulation/ghosts/fills; twelve director-reviewed genre grammars; deterministic genre compiler; harmony.seed carries genre chord degrees into the hook; genre picker with mood-grouped favourites, Surprise me, weighted opening genres; true Pause and Next; master analyser + white Total trace; rainbow track colours (CVD-verified); borderless fullscreen oscilloscope with spread mode; advanced layout rows; registry commit 1/4.

- [x] **v24 — bass craft pass (second failed verdict)** — diagnosis-led feel work on the bass, harmonic contract untouched. Root cause of "low-pitch random": `ensureBassGroove` keyed its cache on the section intensity to three decimals, and `waves`/`build` hand out a fresh intensity every bar, so the v14 groove never engaged at all under either preset. Also fixed: per-note timing humanisation replaced by ONE per-groove lay-back (`bassPocketSeconds`, never early, scaled by vary.timing so 0 still means machine-tight); per-role gates replaced by per-step articulation cycles (`BASS_ARTICULATIONS`) plus a committed phrase ending (held rings across the barline, anything else lifts); the flat 0.1 s duration floor — longer than a clipped sixteenth at most tempos, so every short note rendered identically — replaced by a span-relative one; ghosts 0.42 → 0.25 and the anchor accent 0.85 → 0.92; a turnaround `fill` op on the last bar of each eight-bar count, intensity-scaled, never repeated; the octave pop held inside MIDI 28–55 instead of climbing into the tune's register; and a drummerless line now draws its own anchor stride instead of coin-flipping every pulse. Contract in docs/engine-v2-contract.md § v24, including the ceiling this pass does NOT clear (the bass voices' 0.12 s attack / 0.75 s release makes true staccato unreachable from the engine). Engine suite 164 → 173 tests; also killed the long-standing `finish()` outro flake at its root — humanisation could push a note forward over the barline into the closing bar, and `playNote` now holds every note inside the bar it was planned in at both ends.

- [x] **v0.0.23-24 — harmony depth + track registry core** (adfcbfe, f99c224) — chord-length control, pad breath, Ionian/Mixolydian/Phrygian; TRACK_REGISTRY single-source with identity proofs and display-order views; page/visualiser/scope registry-driven; v23 user-tracks spec + adversarial pre-mortem authored.

- [x] **v0.0.20-22 — sculpting, shape model, rhythm depth** (cf9b076..HEAD) — parametric noise-sculpting voices (colour/cloud/call) with sixteen dials; skew-based shape morph + wavefolder; offline waveform rendering everywhere; per-track swing/density/driftRate; per-step gate/length; dynamic percussion kit lanes; reverb tail control; drifting randomness defaults; ghost pointers; psychology presets refreshed (far-rain, dawn-song); playlists provenance machinery; governor fps/reverb budgets live.

- [x] **v0.0.19 — design polish + naming infra** (dc554f5) — hardware-panel rule (no state-text reflow), aligned baselines, track-coloured rings, docked oscilloscope with functional legend, true repeat barlines, percussion Pitch/Noise dials, engineType + Custom-(engine) selector honesty, 938-word vetted share wordlist, semver adoption.
- [x] **v0.0.18 wave 2 — presets/blocks/routes** (259820b..ce3f236) — psychology-grounded factory presets (headless-auditioned), block editor v1 (pattern blocks incl. tie-to-beat), preset URL routes + gallery below the Simple dials, knob push-through ranges, piano-roll chord de-overlap, ranged-patch resolution fix, paid features behind one launch flag.
- [x] **v0.0.18 — the everything build** (6105e0d, fix bb29670) — silence-floor guarantee, groove bass (kick-locked, per-section development), swing, honest chord events, dissonance, multi-sequencers with ties + probability groups, randomness-0-as-hold, transport strip, fused Randomness dial, tutorial, factory presets, power governor + cost meters, sharper canvases; TDZ blank-page fix with permanent boot gate.
- [x] **AGPL + public-flip prep** (ae6068b..1a19db6) — LICENSE, strategy scrubbed to brain2, AI imagery removed, playlists parked, history rewrite branch (main-clean), .vss untracked, brand-name scrub.
- Earlier v1–v14 engine/UI history: see git log 2026-07-24 (Hugo→Astro conversion through the six-track generative engine, voices, sequencers, musicality waves).
