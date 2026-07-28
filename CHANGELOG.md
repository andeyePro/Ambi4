# Changelog

## 2026-07-28

- [x] **v0.0.45 — the dial end-words come off the faceplate** — they hung under each dial in a
  caption box a fixed 148px wide (`--knob-size` 96 + 52) centred over grid cells that floor at
  120px, so on the Advanced row of seven they overlapped into one run-on line: "Fast Calm Complex
  Hold Vary Quiet", with Randomness contributing three words of its own. Screenshotting Advanced
  made it obvious in a way reading the CSS never did.

  They now live in each dial's tooltip, laid out vertically with arrows — the dial is dragged up
  and down, so its labels read up and down. `.ui-tooltip` becomes `white-space: pre-line` to keep
  the newlines. Every main dial gained a range tooltip in the process, including Swing and Reverb
  tail, which had prose but no statement of which end was which.

- [x] **v0.0.44 — the `?` lines up with the panels** — it was pinned to the layout wrapper's right
  edge, which is 720px minus 32px of padding, while `#generator-app` is capped at 640px. So it
  overhung everything below it by 48px. The header's action row now shares the content column,
  which is the general rule: a right-aligned action has to sit above the column it belongs to,
  not the wrapper that happens to contain it.

- [x] **v0.0.43 — the transport row, checked with eyes instead of inference** — and the reason the
  three attempts before it failed: there is no browser in the container and no route to the
  deployed site, so every layout judgement was being made by reading CSS. `.vibe/shot.sh` fixes
  that — it drives the Mac test account over SSH, renders with headless Chromium and copies the
  PNG back, and `shot.sh local` ships the freshly built `./dist` over and shoots that, so a
  layout is checked BEFORE it is pushed.

  What the first screenshot showed: `.play-toggle` was `flex: 2 1 200px`, taking nearly half the
  row on its own, which is what pushed Next onto a second line. Now `1 1 150px` with a 260px cap
  — still the widest control and still obviously primary, but it stops.

  The staircase (Play, Pause, then the clock half a button low, then Next lower again) came from
  nesting: `.transport-buttons` is its own wrapping flex box, so when the row tightened it became
  two rows tall and `.transport-icons`, centred against it, floated to its middle. `display:
  contents` dissolves both wrappers so every button, icon and the dial are direct children of one
  row and can only wrap as equals.

  The dial sat ~7px high because it carries a value caption, making its block taller than a 56px
  button; centring the block lifts the dial. Both are 56px, so aligning tops is what actually
  levels it with Play. The grid and its reserved column are gone — the processor items are just
  the last thing in each row, pushed right with `margin-left: auto`. And the "huge gap" under the
  genre picker was an empty `<p>` carrying the user agent's default ~16px margins, which nothing
  in the sheet resets.

- [x] **v0.0.42 — four layout faults, four separate causes** — all found in the cascade rather than
  guessed at, and each verified against the compiled CSS afterwards.

  *Icons on their own line*: `.transport-main` was `flex-wrap: wrap` and `.transport-buttons` is
  `flex: 1 1 auto`, so with the panel now two columns the button group grew until it pushed the
  clock and keyboard onto a second row. The outer row is `nowrap` and the button group gets
  `min-width: 0` so it can actually shrink; the buttons still wrap internally.

  *Dial not level with Play*: `.transport-main` carried `margin-bottom: 8px` and the processor
  cell beside it carried none, so with `align-items: center` the left cell's contents sat 4px
  high. The grid's `row-gap` owns that spacing now.

  *An alarm clock for both timers*: the merged icon kept the alarm glyph, bells and all, when it
  stands for sleep as well. Plain clock face now.

  *Bags of space under the genre picker*: roughly 50px of it, from four sources stacking — the
  genre row's own 8px margin, the grid's row-gap, and a status band reserving 22px with a 12px
  margin under it for a line that is usually blank. The reservation stays (status text appearing
  must never reflow the panel) but at 18px with no margin; the two redundant margins are gone.

- [x] **v0.0.41 — the transport panel is two aligned columns, and Stop goes** — TRANSPORT and
  PROCESSOR share the heading row, the play buttons and the processor dial share the row below,
  and the genre picker sits left of the processor readout on the last. Everything in the right
  column is right-aligned to the panel edge, so the label is level with TRANSPORT, the dial level
  with Play, and the numbers sit directly under the dial that produces them — and they stay that
  way as the panel narrows, because they are grid cells rather than three things that happened to
  be near each other.

  The guided-tour `?` moved out of the transport panel entirely and up to the site header, level
  with the Generator nav item, via a new `header-actions` slot on the layout. It had been sitting
  beside the Processor label, where it read as documentation for the processor control.

  The Stop button is deleted. Pressing the dual button again while it is finishing now stops
  outright, making one control the whole transport: Play → Finish → Stop. That also means the
  button stays enabled while finishing where it used to disable itself and read "Finishing…" —
  pressing it again is the point. This is the one form of double click worth having, since two
  presses reach the same place however slowly they are made.

- [x] **v0.0.40 — the transport row reads as three jobs, not five glyphs** — sleep and schedule-start
  were two identical clock faces sitting side by side; they are the same kind of thing (when does
  the music happen) and are now one clock opening one Timers popover with both inside. The
  play-along keyboard joins it as a peer icon at the same 24px size, its panel a popover rather
  than a strip below the genre picker. Closing that popover disarms the keys, via a new `onClose`
  hook on `setupPopover` — every route out (the toggle, Escape, an outside click) lands in one
  place, so a caller needing to stand something down says so once.

  The Processor heading, dial and readout are one column. They were three separate places — the
  label in the panel header, the dial last in the button row, the readout a full-width line at
  the foot after the genre row and the whole play-along block — which is what let narrowing the
  viewport scatter them. The genre picker drops to half width; it was full width for a single
  short name.

  Test note: an earlier attempt watched the popover's `hidden` attribute with a MutationObserver,
  which does not exist in the page-boot harness's environment and took the whole init down with
  it — caught by the gate, replaced with the explicit hook. The play-along boot assertions moved
  with the design: they now prove the ICON is present and reachable when the engine can sound
  live notes, and that the panel starts closed.

- [x] **v0.0.39 — the dial panel opens with dials and nothing else** — dropped the "Main dials"
  heading (seven dials with their own names under them do not need a word above them saying they
  are dials, and the panel is the first thing on the tab so there is nothing to distinguish it
  from), and moved the explanatory line about which dials are shared with Simple out of
  permanent prose and into an ⓘ at the end of the grid. That line answers a question you ask
  once; it was taking a row of height on every visit. Second call site for `infoButton`, which
  had exactly one.

- [x] **v0.0.38 — play-along folds behind one keyboard button** — it sat open on the front page
  with five controls and a five-line hint showing at all times, for a feature most listeners
  never touch. Now a single icon-only keyboard button opens it; the open state persists, so
  someone who plays along every session gets it open every session and someone who never does
  never sees it. Closing it disarms the keys deliberately — leaving them live under a shut panel
  would mean stray keystrokes making noise with nothing on screen to explain why. The original
  rule that no control may move once the panel is open still holds inside it; what changed is
  that the panel itself is now closed until asked for.

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
