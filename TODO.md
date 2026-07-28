# TODO

Segregated by target version (owner's call, 2026-07-27). Triage lives inside
each version rather than above it, because an undecided item still belongs to a
release. **[decide]** needs an owner ruling before build; **[flagged]** carries
a reason the owner has not yet agreed to.

Shipped: **v0.0.34** (`package.json` 0.0.34, tag `v0.0.34-first-weekend`). No
post-release version exists — v0.0.34 is the current head.

Ladder: **v0.0.35 → v0.0.42** are pre-release increments. **v0.1.0 is the
initial public release.** **v0.2.x** is everything deliberately held back until
after that release. Fable reviewed the whole span on 2026-07-27; its findings
are folded in below and into `docs/dial-control-plane-plan.md`, and the review
is what re-scoped v0.0.35 down to what actually shipped.

History audit: brain2 `Ambi4-history-audit-2026-07-27`. UX brief: brain2
`Ambi4-UX-philosophy`. Dial plan: `docs/dial-control-plane-plan.md`.

---

## Next up (owner ask, 2026-07-28)

- [x] *(SHIPPED v0.0.55)* **The Stop key does nothing** — the second press that cuts the outro short was written in v0.0.41 and made unreachable by a `if (finishing) return;` guard left over from the era of a separate Stop key. Guard removed; the Stop caption also gained its own square glyph, having been drawn beside the finish barline since v0.0.41.
- [x] *(SHIPPED v0.0.55)* **Overlapping text** — `Auto (follows Randomness)` is 148 px of readout in an 84 px `.vary-knob` cell, so all four Randomise dials in every track editor overpainted each other by 56 px. Reads `Auto` now. Found by `.vibe/measure.sh overlaps`, which is the durable half of the fix.

- [x] *(SHIPPED v0.0.57)* **Universal | Per instrument toggle** (the owner's "I know I don't have the universal dial implementation"). It is filed under v0.0.37 below with two open flags of mine, which is why it kept being passed over, so here is the honest state: **Swing and Complexity are the only two that can be built today** — the engine already reads `tracks[t].swing` and `tracks[t].density` as "null means follow the global dial", so a per-instrument mode there is a UI change alone. **Reprise and Reverb tail cannot be**: there is one hook and one motif bank per piece and one shared convolver, so per-instrument versions of those are new engine features (per-track sends or per-track convolvers), not a toggle. Randomness is already per-track via Variation. Recommend building the two that are real and dropping the other two from the list rather than leaving the item blocked on a ruling about controls that cannot exist yet.
- [x] *(SHIPPED v0.0.57)* **Next-beat tempo quantisation is now Simple-only, so it can be A/B'd** — new engine param `tempoLanding` ('beat' | 'bar', default 'beat'). Simple's Energy macro writes 'beat' so a beginner hears what they just dragged; the Advanced Tempo dial writes 'bar' so the change lands on the barline, which is what every build before v0.0.48 did and is the "sounds better than immediate" option. Turning the two dials against each other IS the A/B, and it needs no switch. Both directions have their own engine test.
- [x] *(SHIPPED — `docs/deploying.md`)* **Write the deploy gate down in the repo** — branch-to-environment table, the four-step gate with the reason it exists, the pre-push commands, and the note that pushing `main` IS the publish. Referenced from CONTRIBUTING.md.
- [x] *(SHIPPED — `docs/rendering-host.md`)* **Document the Mac test account for every vibe on this machine** — what the two scripts do, why `measure` and not `shot` decides anything, the one-time setup, and how a vibe in another project reuses the account.

- [ ] **Dependabot: 10 alerts on the default branch (3 high) — root fix is the Astro 4→7 major** — local `npm audit`: 3 findings (2 high), ALL resolved only by astro@7.1.4 (breaking). Honest exposure for a prebuilt static site is low: esbuild's file-read is dev-server-on-Windows, sharp's libvips CVEs are build-time image processing, and the two Astro XSS advisories need unescaped spread attrs / transition:* directives on hydrated islands, which this page doesn't use with untrusted input. Plan it as a deliberate migration (astro 7 upgrade + full suite + shot sweep + frozen-reference check), not an `npm audit fix --force` drive-by. Review the 7 GitHub-only alerts at github.com/andeyePro/Ambi4/security/dependabot when wiring the upgrade.

- [x] *(SHIPPED 5e14459 + cf30b1a, 2026-07-28)* **Adopt CLA v1.0** — CLA.md (verbatim, stamped) + CONTRIBUTORS.md live; the CLA Assistant workflow commit cf30b1a is LOCAL-ONLY (PAT lacks workflow scope — Martin pushes from the Mac checkout: plain `git push` in Projects/Ambi4). After it lands, optionally add the `CLAAssistant` check to required status checks in branch protection (GitHub settings, Martin).
- [x] *(SHIPPED bf0f978, 2026-07-28 — owner go in-session)* **Land the AGPL section-7 audio-output additional permission in LICENSE BEFORE merging any outside PR** — the cla.md analysis says it must land while andeye owns 100% of the copyright; Martin's "yes, draft it" (fromClaude item on the section-7 exception) still comes via fromMartin. Draft is ready to write the moment he says yes.
- [x] *(SHIPPED v0.0.54, 2b26262)* **Move the version number to the top of the screen** — left of the right-aligned `?` tutorial launcher, so a refresh shows the running build without scrolling to the footer. Keep the footer stamp too (it is the durable record; the top one is the glanceable one).

## Genre and bass listening verdicts (owner, 2026-07-28)

The owner's second full listen. Sorted by what they actually are, because
"dischordant" and "there is a click on the note" want completely different work.

**Two are defects, not taste.** Both are reproducible descriptions of a sound
fault, and neither is a mixing judgement:

- [ ] **A click on note onset — `fingered` bass, and bossa generally.** Reported twice, independently ("Soul Groove - Fingered bass is also cracking on note start", "Bossa … has a lot of sounds that are starting with a click, due to inadvertant sound design issues"). Candidates in order: the FILTER envelope, which on `fingered` snaps to full in 8 ms with `envAmount: 1` over a 455 Hz cutoff and a decay of 0.01 s that does nothing at all because sustain is 1 — an 8 ms filter slam is audible as a crack in a way an 8 ms amplitude ramp is not; the 0.14 s release colliding with the next note's onset on a fast line; and any voice whose note starts on a non-zero phase. **Do not tune this blind.** Nobody in the container can hear it, and audio-reference.mjs digests note tuples rather than samples, so it would not catch a change either way. The Mac test account can render real audio offline — measure the onset for a step discontinuity, fix, measure again.
- [ ] **A noise layer that reads as sawing, in Ambient** — "it seems to have a noise layer in it that always makes me think there's someone sawing. I find that quite distracting." He attributes it to a voice he calls "call" and asks whether Synthwave uses the same one. **Checked, and the answer is no on both counts, which changes where to look:** Ambient's shipped voices are pad `warm`, arp `softPluck`, melody `bell`, bass `breath`, texture `wash`, percussion `soft`, and Synthwave shares NONE of them (`polysaw`/`crystal`/`keys`/`sawbass`/`cloud`/`soft`). The `call` voice exists but no genre selects it by default. The two noise-shaped candidates in Ambient are `breath` (its "bass", a 0.18 s-attack sine through a wide-open filter) and `wash` (texture, a bandpass at 320 Hz with q 1.2, 2.4 s attack, reverb 0.85) — `wash` is the better suspect for a sustained sawing, since a narrow bandpass on noise is exactly what a saw stroke sounds like. Confirm with him which track it is by soloing before changing anything.

**One is a genre that fails its own name:**

- [ ] **Cinematic does not sound cinematic** — "it frankly sounds much more like most of the other Ambi4 tracks than anything you would call Cinematic." This is the v0.0.29 blind-identification test failing for one genre. It needs a voicing pass of its own, not a tweak.
- [ ] **Acid Jazz is dissonant throughout** — "all of it. So bad that I'm not going to waste time researching what acid jazz basslines are supposed to sound like." Fair: researching the reference is the build's job, not the listener's. Its signature voice is the tine e-piano; the dissonance is more likely the harmony (extended chords over a pentatonic scale table) than the voice.
- [ ] **Bossa is dissonant** — same shape of problem as Acid Jazz, same likely cause, separate from its click defect above.

**Three are a melody that spoils an otherwise working track:**

- [ ] **Deep House** — "bass and other tracks seem fine, just let down by an annoying melody." He notes its bass is rapid and repetitive and asks whether that is simply the genre: it is, and deep house basslines are meant to sit that way, so leave the bass alone.
- [ ] **Lofi Beats** — "also has a bad melody."
- [ ] **Downtempo** — bass fine "until the drums enter, and they seem to be clashing with each other." That is a rhythmic collision rather than a melodic one — check the kit pattern against the bass placement.

**Two need the genre researched before anything is judged:**

- [ ] **Minimalism** and **New Age** — "I need to research the actual genre to find out if I don't like it, or just don't like the conflict between Ambi4's tracks." Research is ours to do and report, not his.

**Two are working, and say what working sounds like:**

- **Synthwave — keep.** "Good job with Synthwave." He plays it with the low cutoff pulled to the bottom for a mellower bass and the drums adjusted, and can listen for hours. Do not regress this one; it is the reference.
- **Techno Tools — second most musical.** Very repetitive bass, and he likes it anyway.

- [ ] **Ambient has no bass line by definition** — already the plan (bass gates off for Ambient), noted here so it is not re-raised.

## Awaiting an owner decision

Nothing below can be built without a ruling. Parked here rather than buried in a
version so they are the first thing seen.

1. **Does the Simple tab keep its fused Randomness dial?** The UX brief says the
   two randomness axes "must never be fused into one control", but Simple keeps
   exactly that — one knob writing both `repetition` and every track's
   randomness. v0.0.35 shipped with Simple fused and Advanced separated, on the
   judgement that one knob for "how much does this change" is what makes Simple
   simple. If the brief is meant literally, Simple needs a second dial and the
   tab stops being four controls.
2. **Which tier gates the patch sockets?** The plan said "Studio tier". There is
   no Studio tier — the ladder is Free, Plus, Pro, Premium — payments do not
   exist at v0.1.0, and the standing rule is that no paid feature is visible
   before its tier can be bought. So a paid gate means the whole modulation-graph
   version ships dark at the public release, while the transparency version needs
   those same cables for free-tier value. Either the graph is free at launch with
   a paid gate only on the v0.2.x user-authored instruments, or the graph moves
   after v0.1.0.
3. **~~The drag scheme~~ — SETTLED 2026-07-27: Scheme A.** Axis lock with
   re-arm; the diagonal question is parked until the feel is nailed. The rig at
   https://claude.ai/code/artifact/0f976490-5baa-4100-a7fe-9cd08debe58b is now
   Scheme A only, with the stuck-drag bug fixed — the rig never called
   `preventDefault` on pointerdown, so the browser started its own selection
   drag and swallowed the release. That bug was poisoning the comparison, so
   revisit the diagonal only after Scheme A itself feels right.
4. **Is Reprise the right name?** Shipped in v0.0.35 over Recall, because in
   every mixer and synth "recall" means restoring saved settings and this app
   has presets and share links. One word to revert.
5. **Structure block limit** — the cap of 8 is enforced in three places. Keep or
   raise?
6. **BPM range** — the old "hardcoded 40–120" note is stale; the UI slider is
   20–220 on a log curve centred at 60. The original question stands: what are
   the slowest and fastest tempos to achieve significant commercial success, and
   should the engine clamp match the UI?
7. **The strategy note and this plan disagree about the next flagship.**
   `Ambi4-strategy` says genres; v0.0.35 to v0.1.0 contains no genre work at all.

## Consult follow-ups — measured 2026-07-28 (tests/energy-measure.mjs; flip ENERGY_MEASURE_STRICT=1 when done)

- [ ] **C7 knot tuning: a quartile of Energy must beat the piece's own drift 3×** — measured ~1.0× for notes/bar and tracks/bar. The competition is not noise: the structure preset's own intensity envelope walks the auto-track ladder (per-bar section intensities 0.7→0.3 over 16 untouched bars moved tracks as much as the dial did). Tuning the complexity knots alone may not get there — candidates: Energy also narrowing the section-intensity span, or steeper auto-track thresholds. Changes the shipped feel; owner should listen after.
- [ ] **Complexity edits are swallowed by the frozen plan for ~2 bars** — the edit reaches the generator inside 1 bar but the next bar replays a frozen plan (first audible difference 2.00 bars, budget 1). An upward complexity move should invalidate frozen plans the way the consult argued for Change; applies to Energy's structural half.
- [x] *(SHIPPED v0.0.58)* **Volume taper too compressive at the top** — measured again after the fix: the smallest 10% step is now **4.00 dB** and **0/9** steps fall under the 2 dB floor, against 1.56 dB and 3/9 before. **This item's own suggested fix was wrong and would have made it worse:** an exponent nearer 1.5 lowers the top step, because a power law gives 0.916·n dB there (1.7 → 1.56, 1.5 → 1.37). The problem is the power law itself — dB = 20n·log₁₀(t), so a step near the top is a small ratio whatever n is. Replaced with a two-segment fader law, dB linear in dial travel: 20 dB over the top half (4 dB per 10%), 40 over the bottom half (8.3 per 10%), off below 2%. `params.volume` untouched, so a stored preset plays at exactly the loudness it always did; only where the thumb sits for it changes.
- [ ] **Energy's top half adds no layers** — the full track ladder is reached by Energy 0.5, and top-quartile notes/bar growth is 18% vs the ≥25% target. Spread the ladder crossings (knots or thresholds) so the upper travel still buys audible growth.

## v0.0.35 — de-fuse, rename, share versioning  *(SHIPPED 2026-07-27, pushed)*

Re-scoped on Fable's review, which found the original v0.0.35 was four plan
phases plus eight unrelated UI items plus two new engine params plus an
unresolved owner gate. What shipped here is the part that needed no registry
and fixed the bug the owner personally hit; the refactor moves to v0.0.36.

- [x] **Share payload is versioned.** Fable's most serious finding, verified: share links shipped in v0.0.33 carrying the raw settings tree base64url'd with **no schema field**, so an older client meeting a newer link silently dropped unknown keys and played a different piece — **under the right three-word name**, because the name is a hash of the payload bytes. Added `v: 1` to the payload, read-and-strip on decode, absent `v` read as version 0 so every existing link keeps working, and an arrival notice when a link comes from a newer build. One-time cost: the same settings now hash to different words than before
- [x] **De-fused Randomness and Reprise on Advanced.** The Advanced Randomness dial was a `buildMirroredDial` view of the Simple fused dial, so it wrote `repetition = 1 − randomness` and every track's randomness, and displayed `(1 − repetition + mean(randomness)) / 2`. Advanced now has its own **Variation** dial writing only per-track randomness and reading `trackRandomnessValue()`; Simple keeps the fused macro deliberately. **[decide]** the brief says the two axes "must never be fused into one control" while Simple keeps exactly that — I ruled Simple stays fused because that is what makes it simple, but it is the owner's call
- [x] **Renamed the dials.** Repetition → **Reprise**, Randomness (Advanced) → **Variation**, with their own end-marks (Hold ↔ Vary, Rarely ↔ Always) instead of the mirror-image word sets. Reprise over Recall on Fable's argument: in every mixer and synth "recall" means restoring saved settings, and this app has presets and share links, so the collision is real. Extremes corrected too — "Never" was false, since at Reprise 0 the hook still loops every eight chords
- [x] **Advanced opens with the main dials above the Tracks list**, so tempo is where Simple users expect it
- [x] Wire-key freeze recorded: `randomness` and `repetition` stay the serialised keys forever; Variation and Reprise are UI labels only

## v0.0.36 — the oscilloscope and piano roll say what they mean  *(SHIPPED 2026-07-27)*

Chosen as the next increment because it needs no owner input and is the part
worth looking at on a real device. The registry refactor is invisible by design,
so it waits.

- [x] **Total trace no longer needs another trace on first.** Not the latch I first diagnosed — the guard `if (!allowed || !open || !ids.length) return` bailed out before any attach whenever no *track* trace was selected, and the total is an analyser of the finished mix that owes nothing to any track. An empty track list is now a legitimate attach when Total is what was asked for (`normaliseTracks` already accepts `[]`), the attach key distinguishes "no tracks" from "no tracks plus total", and toggling Total re-attaches
- [x] **Oscilloscope labels stopped pretending to be buttons.** Pill border, radius, uppercase and letter-spacing all gone — that styling is why 11px read visibly larger than the piano roll's own 11px lane labels sitting beside it. Same size, same case, same weight now
- [x] **Tri-state dots**, matching the roll's lamp: the track's own colour for "will show when it plays", white for "sounding right now", a bar for "playing but its trace is hidden"
- [x] **Spread is a vertical double arrow**, not the word "Spread" sitting between the track traces and the total trace reading as another trace. Tooltip carries the words
- [x] **The section label has its own strip below the lanes.** It was drawn at `height - 4` with nothing reserved, so it landed inside the lowest lane — under the kick, invisible, while chord names always cleared the top pad. Full size now that it is not competing with anything
- [x] **Chord labels stack onto a second row instead of overdrawing.** There was no `measureText` in `visualiser.js` at all; the only guard was an 8px tick-spacing gate, narrower than "Cmaj7". Each name now measures itself, takes the first row it clears, and drops to the second if it does not — with a per-character fallback if a context ever lacks `measureText`, and the mock context in the smoke suite gained it
- [x] **Maximise works on iPhone.** The gate required `Element.requestFullscreen`, which iOS Safari does not implement at all, so both ⛶ buttons were simply hidden on the device that most wanted them. The native API is now preferred rather than required; without it the stage is pinned over the viewport at `100dvh` (so the collapsing address bar cannot crop it), with Escape wired up by hand since only the native path gets it free

## v0.0.37 — registry, renderer and gestures

- [ ] **Parameter registry** — one declarative table keyed by dotted path carrying domain, curve, unit, format, default, rangeable, scope and sampling. Engine sanitiser and UI both read it. Deletes the boot-time probes (`probePatchSource`, index.astro:2225) and makes `allowRange` derived. No visible change
- [ ] **`buildKnobEditor` becomes a renderer over the registry** — ~600 lines of hand-written `addKnob` literals collapse to a loop. Behaviour byte-identical; existing smoke tests are the gate
- [x] *(SHIPPED v0.0.56)* **Gesture rebuild** — vertical drag = value, horizontal drag = spread, axis locks after ~6 px with re-arm, centre tap = default with no timing requirement, muted-grey zeroed state. `onDoubleClick`, the click-to-toggle path and the inside/outside-face zone scheme are all deleted; the zone scheme is replaced by "the nearer end by sweep angle", with the centre hub carrying both ends. Mobile `--knob-size` goes to 88 px under `pointer: coarse`. One thing the plan did not anticipate: opening a span symmetrically about the value does nothing at all on a dial already at its bound, so a span at a bound grows one-sided
- [x] *(SHIPPED v0.0.56)* **Live-value pointer** on min-max dials — shows where inside the span the value actually sits right now, so a walk or an LFO is visible on the dial face. Needs only the walk, which has existed since v7 (`resolveRange`, ambient-engine.js:3952), and reuses the `ghostValue` substrate. Ships with the gesture rebuild, not later: under the spread-is-depth rule, a span whose behaviour is invisible is a control with no feedback
- [x] *(SHIPPED v0.0.56, with the gesture as required)* **Third tooltip line for the spread axis.** The dial tooltips carry `↑ Fast` / `↓ Slow` since v0.0.45; they gain `↔ Vary tempo` (and the equivalent per dial — vary the complexity, the volume, the amount of change, the swing, the reverb tail) so all three directions the dial responds to are stated in one place. **Must not land before the gesture does**: a tooltip that advertises a left-right drag on a dial that ignores it teaches the user the control is broken, which is the exact failure the owner's consistency principle is about. `dialHint(high, low, mid, detail)` gains a spread label; dials that are not rangeable (enumerations) omit the line entirely rather than showing a dead one.
- [x] *(SHIPPED v0.0.56)* **Independent min and max.** Once a span exists, pointerdown grabs the *nearer* of the two ends by sweep angle — no small target, so it works with a thumb — and vertical drag then moves that end alone. Dragging one end past the other carries the other along instead of blocking (matching knob.js v16 push semantics), so the span cannot be wedged. Alt-drag slides both ends together keeping the width, desktop only. This is what makes an asymmetric span like 20–30% reachable at all; the base-and-spread-only model of the first trial could not express it
- [x] *(SETTLED 2026-07-27: Scheme A — see the Awaiting block above)* **[decide] Drag scheme — A/B trial built, owner to judge.** Scheme A (axis lock on first movement past ~6 px, re-arming when the pointer returns near the origin) versus Scheme B (nothing moves until the pointer clears a commit radius, then the leave-angle decides: within ±20° of an axis gives that axis alone, out on the diagonal gives both at once with orbiting to rebalance or settle). Live side-by-side with tunable lock threshold, commit radius, cone half-angle, travel and an orbit-snap switch, plus gesture-path traces showing why each gesture was classified as it was: https://claude.ai/code/artifact/0f976490-5baa-4100-a7fe-9cd08debe58b — **must be judged on a phone as well as a mouse**, since a thumb arrives at an angle and moves in an arc. My prior reservation stands until disproved (a diagonal band is a knife-edge that drift falls out of), but the trial exists precisely to settle whether it is a USP or a bad idea
- [ ] **Sampling control** — generalise `walk()` (ambient-engine.js:3907) from its hard-coded per-bar step to the registry's sampling field; ship the tiny bottom-left dial with four icon positions (note/bar/chord/section), dim when inherited, centre tap to return to inherit
- [ ] **Step rule in the fourth bay** — what value a stepped source takes when it fires: absolute random in span, random walk, walk up, walk down, ping-pong, cycle. Step size from Drift rate, inherited. Hidden when the source is continuous
- [ ] **Reserve the whole six-level path grammar, not just `bus`** — dial → voice → instrument → track → bus → master. Fable caught the plan document declaring only four levels (dial/voice/track/master), which would have booked a namespace with no room for `instrument` either. Reserve alongside them the modulation-source namespaces (`env`, `lfo`, `macro`, utility ids), the sampling enum values and the step-rule enum values, since graph edges serialise from the modulation-graph version and are permanent from the first shared link
- [x] *(SHIPPED v0.0.56 — `tests/knob-gesture.mjs`, 35 assertions, written first; plus `tests/dial-drive.mjs`, which drives real pointer gestures in headless Chromium)* **Write the replacement for `knobscope-smoke.mjs` before the gesture rebuild, not after.** 2,548 lines currently exercise click-toggle, double-click reset, face zones, wheel and keyboard — the rebuild invalidates much of it. The harness already drives pointer sequences, so axis lock, re-arm, nearest-end grab and push-through are all unit-testable against the spec. "Feels right on a phone" is not a gate
- [ ] **Specify the keyboard path — it is inadequate today and the rebuild makes it worse.** Arrows move min and Shift+arrows move max, but only inside an existing range, and mode entry is click-only, so a keyboard user cannot create a span at all. Deleting the click gesture leaves no way to open, close or collapse a spread, and deleting double-click removes the only reset. Needs: a keyboard spread gesture, a reset key, and a dual-thumb aria contract — `role="slider"` with a single `aria-valuenow` is already wrong for two thumbs
- [x] *(SHIPPED v0.0.53)* **Build the frozen-reference audio comparison** before any version that changes how existing presets sound. `engine-smoke.mjs` is seeded and deterministic so the substrate exists, but the harness does not and nothing scheduled it
- [ ] **Specify the iOS gesture environment** for a two-axis drag: horizontal drag near a screen edge is Safari's back-swipe, `touch-action` policy is unstated, and centre-tap must not collide with double-tap-zoom
- [x] *(SHIPPED v0.0.45, 00c8878)* Delete the dial end-words and move them into the tooltip, laid out **vertically with up/down arrows** to match the drag direction. Confirmed overlap: the caption box is a fixed 148 px (:11571) centred over cells that floor at 120–130 px (:11625, :12440), overhanging into the neighbour by 9–14 px each side with no ellipsis rule. Set to remove: Slow/Fast, Calm/Complex, Repetitive/Evolving/Random, Quiet/Loud, Random/Evolving/Repetitive, Straight/Swung, Room/Cathedral
- [x] *(SHIPPED v0.0.46, 5c35359)* Drop the BPM slider (`input#bpm`, :590) — a third view of the same tempo (`setTempo`, :2958), already covered by the dial
- [x] *(SHIPPED v0.0.57 — Swing and Complexity only)* **Universal | Per instrument** segmented toggle. Both flags are resolved rather than waived. **Layout:** it is styled as a third caption rather than a button — 10 px, sentence case, no letter-spacing, hairline divider — which fits 147 px into the 143 px four-column cell with a 2 px bleed into the gutter, the same rule the v18 dial contract already applies to a long readout. Measured across five viewports; the uppercase version was clipping "Per instrument" by 8 px and neither the collision nor the overflow sweep saw it, which is why `measure.sh` gained a third sweep for containers that cut their own children. **Repetition, Reverb tail and Randomness are dropped from the list, as flagged:** one hook and one motif bank per piece, one shared convolver, and Randomness has been per-track since v21. **[flagged]** Engine `repetition` drives the *global* hook length, recall cycle, mutation chance and bar-draw — there is one hook and one motif bank per piece, so a per-track value could only scope the two genuinely per-track reads (arp mask reroll, percussion reuse). It cannot make the chord loop four bars for the pad and eight for the bass, and the item's own definition of Reprise as global rules it out. Reverb tail is also global (one shared convolver), so per-instrument means per-track sends or per-track convolvers — a mixer feature, not "an engine param adding"
- [ ] Poly | Mono segmented toggle replacing the current Mono control — today an `aria-pressed` button distinguished only by fill-vs-outline (:4056). Glide gets the same treatment plus a **legato** option
- [x] *(SHIPPED v0.0.57 — reconciled, not obeyed literally)* Simple-tab horizontal swipe. The 2026-07-27 instruction was "teach instead of act"; the 2026-07-28 instruction was "everything should be spreadable with horizontal drag", which is the consistency principle and wins. So the gesture WORKS on Simple and Simple explains it, once, the first time it happens — which answers the worry behind the earlier instruction (a new player who did not mean to do it is told what they did and how to undo it) without teaching them that a gesture does nothing. The line holds its slot for seven seconds against the v0.0.51 effect announcements, which were overwriting it a tenth of a second later

## v0.0.38 — layout and chrome

- [ ] Oscilloscope labels and the spread control hide along with `+ piano roll` and `Exit (Esc)`. They currently do not — the scope module is *moved* into the fullscreen stage (:8567) and its overlay is unaffected by the 2.6 s auto-collapse (:8624)

- [x] *(SHIPPED v0.0.44, d8b6593)* Right-align the `?` tutorial launcher to the **GENERATOR tab**, which sits between the "Ambi4: Ambience for Work" title and TRANSPORT. It currently sits immediately right of the Processor label inside `.transport-head` (:117-129), reading as documentation for the processor control. (Resolves the earlier open question — the PLAYLIST tab is gone, GENERATOR remains.) Fallback if space is tight: open as a tooltip like the ⓘ boxes
- [ ] No-orphan layout control across the whole UI. The Processor case is deliberate today and needs reversing: label in `.transport-head` (:119), dial last in `.transport-main` after the transport buttons and sleep/alarm icons (:246), readout in `.transport-row` (:345) *after* the genre row and the whole play-along block. Comments at :10925 and :11639 record the split as intentional
- [x] *(SHIPPED v0.0.38, 39f2164)* Collapse play-along/capture behind a single open/close button — not collapsible today (`#play-along`, :290; the comment at :280 saying no control may move is superseded)
- [x] *(SHIPPED v0.0.40, 0abb56d — this line was left unticked by mistake; found by the 2026-07-28 audit)* Fold sleep and alarm into one button — one clock icon opens a Timers popover holding both
- [ ] Every info section gets a ⓘ, opening momentarily on hover and toggling on click. `infoButton` exists (:3419) with exactly **one** call site (the sequencer legend, :4689). **[flagged]** touch has no hover, so tap-toggle is the only behaviour there
- [ ] ⓘ content opens in the tutorial area right of the main UI where space permits — `#tutorial-panel` (:656) already collapses to a static block below 1100px
- [ ] Group dials so an even number that will not fit on one row splits evenly across two, instead of three on one line and one below
- [ ] Processor dial defaults to a min-max range Eco→Full rather than Auto as its top setting. **[flagged]** only works if the governor stays the thing that moves the value within the range; otherwise the CPU-pressure sensing in `power.js` is lost. **v0.0.57 note:** the dial is explicitly `allowRange: false` for now — it is five NAMED tiers and `setProcessorTier` takes one of them, so a span would be silently rounded. Building this item means teaching the governor to move a value inside a declared range, which is a `power.js` change; the dial is the easy half
- [x] *(SHIPPED v0.0.41-43, 8a465c4/a5c0787)* Delete the Stop button (`#stop-now`, :156). Play/Finish is already one dual button (`#toggle-play`, :132); extend it so Finish becomes STOP with the stop icon — two presses at any speed give an immediate stop
- [x] *(SHIPPED v0.0.58 — the Back key)* Add Previous alongside Next. The snapshot stack exists now: up to 24 setups, pushed by the two gestures that replace a whole setup at once (Next, and picking a genre) and by nothing else. It is deliberately NOT a general undo — an undo stack over every dial move is a much larger feature, and a button that sometimes undoes a dial and sometimes a whole piece would be worse than none. Back disables itself at the end of the history

## v0.0.39 — harmony and structure

- [x] *(SHIPPED v0.0.46, 5c35359)* Root and Scale on one row; Time signature and Chord length on one row. All four are stacked one per row as bare `div.control` blocks (:564-609)
- [ ] Time signature gains a custom option — fixed list today (3/4, 4/4, 5/4, 6/8, 7/8, :26)
- [ ] Chord length gains a custom option in **beats, bars or sections**. Engine whitelist is `['auto',1,2,4,8]` bars (:898) so this needs an engine change. (Owner clarified "measure" meant *beat* — a bar of 4/4 has four beats — so beats is a third unit, not a synonym for bars)
- [x] *(SHIPPED v0.0.57)* **Restructure the scale list into a short primary set plus Other.** Both groups are `<optgroup>`s, which is the real HTML convention for this rather than an invented two-step reveal. Six scales added to the engine (blues, harmonic minor, melodic minor, locrian, diminished, chromatic), purely additively, so every stored preset and share link keeps the scale it had; `audio-reference` unchanged across all 24 configs. The page now probes EVERY option the markup offers and prunes what the engine rejects, replacing a hand-kept "new modes" literal that had already begun duplicating options. **[flagged]** the non-Western entries are not one item each: Maqamat need quarter tones (24-TET), Gamelan slendro/pelog are genuinely non-12-TET and vary per instrument set, and Ragas are as much ascent/descent rules and ornament as pitch set. Naming them by tradition ("Middle Eastern", "Indian", "East Asian") is also inaccurate — better to name actual scales (Hijaz, Bhairav, Hirajoshi, Pelog) grouped under a tradition heading. Recommend: ship the 12-TET list here, and treat tuning as its own item below
- [x] *(already true; confirmed and recorded in the code, v0.0.57)* Keep the label **"Scale"**, not "Mode" — the list is mixed: Dorian, Lydian, Aeolian, Ionian, Mixolydian, Phrygian and Locrian are modes, but the pentatonics, blues, whole tone, diminished and chromatic are not. The element id stays `mode` because it is a wire key
- [x] *(SHIPPED v0.0.57)* Structure gains a ⓘ explaining each option — one line per option plus what Custom's blocks mean. Info boxes are `white-space: pre-line` now, so a list reads as a list rather than as a paragraph
- [ ] Structure custom gains V and V1–N, and sections carry both a letter and a customisable title so B can double as bridge and C as chorus. Today the label is a fixed select of Section A–D (:8906)
- [ ] **[decide]** the 8-block structure limit — enforced in three places (:8993, :9005, ambient-engine.js:1563). Keep or raise?
- [ ] Make the differences between sections visible and editable per track. A section is currently only `{label, bars, intensity}`; intensity drives an automatic activation ladder and brightness (ambient-engine.js:3175), and nothing lets you see or set what a given track does in A versus B
- [x] *(SHIPPED v0.0.57)* Label the Custom builder's controls — both now carry a visible name ("bars", "intensity") and the intensity slider a live percentage. They had an `aria-label` and nothing a sighted user could read, which is exactly why the unlabelled range control read as a second BPM slider

## v0.0.40 — modulation graph

- [ ] **Modulation graph** — serialisable `{source, destination}` edges, no depth field since spread is depth. Sources are per-voice envelopes, global LFOs and macros, and any parameter patched out. One slot per destination, so patching replaces the internal randomiser. Patch in/out sockets, ENV/LFO/MACRO panels
- [ ] **Utility (maths) modules** — Sample & hold clocked by note/bar/chord/section, Mix (signed sum), Multiply, Slew. Keeps one-slot-per-dial while allowing sources to be merged upstream
- [ ] *(moved earlier — see the gesture-rebuild version.)* The live-value pointer needs only the walk, which has existed since v7, so deferring it here would leave several versions where a span's behaviour is invisible on the dial
- [ ] **Then** remove the per-track summary line ("level 55% · random 15% · swing 2% · density 1×"). It is not a duplicate of the dials — `applyResolved` (:8756) polls `engine.getResolved()` at 4 Hz and prints what is actually sounding, every range resolved through its walk. Delete it only once the pointer above carries that information
- [ ] **Dissolve the Randomise row** — Volume, Timing and Pan become spreads on their own dials; Pitch splits into Passing notes and Octave wander; Voice becomes a probability dial. `vary.*` migrates: `null` to a MACRO patch, an explicit number to a spread. The *write* path may retire after one release, but the **decode-side shim must live forever** — old share links carrying `vary.*` never expire
- [ ] Connection-count performance warning wired into the existing governor (`power.js`), which already senses CPU pressure and frame times. Warn on active connections, not LFO count

## v0.0.41 — generative transparency

- [ ] **Auto step sequencers must show what they chose.** The grid renders only user-entered steps (:5487); in Auto the engine plans the bar from groove/hook/section state and the grid is ignored, undimmed and unannotated. The only feedback is a playhead column carrying no pattern information (:5585). Any generated sequence can be expressed in a step grid, so Auto should write its actual choices into it
- [ ] **Pitch selection must become visible and editable.** There is no chord-sequence editor, degree list, progression grid or pitch lane anywhere — step grids carry on/off, velocity, probability, group, tie and gate, never pitch (stated in-code at :9659). The only display of chosen pitches is the read-only piano-roll canvas
- [ ] Pick or set a chord sequence on one instrument and have others link to it or diverge from it, using patch cables from the v0.0.39 graph
- [ ] See and edit how individual notes are selected from the current chord, and the reverse
- [ ] Engine telemetry to support all of the above — there are currently **zero** callbacks exposing chord, bar or plan decisions, so every readout needs new plumbing

## v0.0.42 — input, copy and launch polish

- [ ] **Default-sound improvements that are actually cheap** — the gains NAM was hoped to give come more reliably from deterministic DSP: master-bus compression, tape/console-style saturation (a waveshaper, not a neural net), and a per-genre EQ curve. Each is a few Web Audio nodes, costs almost nothing on Eco, and needs no downloads. Do these before reaching for neural modelling
- [ ] **Investigate play-along keyboard latency** — reported as much worse than a DAW's computer-keyboard mode. The engine is not the cause: `noteOn` schedules at `ctx.currentTime` with no quantisation or lookahead (ambient-engine.js:5261-5283). **The obvious suspect is a dead end**: the AudioContext is constructed bare (`new Ctor()`, :7418-7421), but the default `latencyHint` is already `'interactive'`, the lowest-latency setting, so adding it explicitly changes nothing. Ranked candidates instead: keydown-to-`noteOn` handling, the selected voice's own attack envelope reading as delay, platform `outputLatency`, and any lookahead in the master compressor chain. First step is to measure and report `ctx.baseLatency` / `ctx.outputLatency`
- [ ] Touch keyboard and drum pads with per-finger expression — none today; play-along is computer-keyboard only (`PLAY_ALONG_KEYS`, :9679). **[flagged]** true MPE over Web MIDI is Chrome/Edge only with no Web MIDI on iOS Safari, so on-screen pads must implement expression natively
- [ ] Derive an accompanying chord sequence from a played MIDI keyboard, once root and scale are declared. **MIDI input itself already ships** — `requestMIDIAccess` with note-on/off into the play-along track (:9854-9900); only the chord derivation is missing
- [x] *(SHIPPED v0.0.57)* ⓘ explaining the three-word share name — that the preset name and the words are independent, that renaming does not change the words, and that editing any setting does
- [x] *(SHIPPED v0.0.57 — the terms; the legal read is still open, see below)* Preset-submission terms, behind an ⓘ beside Submit, in the owner's own words with nothing reworded. **The anonymous checkbox was built in the same commit because the terms refer to it** — publishing terms describing a control the page does not have would be worse than publishing none; ticking it prefixes the submission with a line saying so. **STILL OPEN: the legal-tone read before public release.** Owner's wording, reproduced verbatim in the app: during beta we may publish presets with creator credits at our discretion unless the anonymous box is checked; we may compile presets or genres from several creators' submissions and credit all who wish to be credited; we cannot take responsibility for similarity between such compilations and non-credited submissions, since submissions may be similar and we have no way to assess similarity for non-paying creators; paid tiers should later allow similarity assessment and crediting of the original submitter where the sign-up email matches the submission. **Do not rewrite without asking**

## v0.1.0 — initial public release

**Fable's standing note: the three cheapest items here are on the critical path
and only get more expensive by waiting — file the AMBI4 trademark application,
stand up contact.andeye.com, and clear the three high Dependabot advisories.
All three can run concurrently with any build version.**

- [ ] **[decide] Name and trademark.** Blocking: publicising a name we cannot secure is the one mistake that cannot be undone cheaply. Establish whether our first use of "Ambi4" predates any likely complainant; if it does, proceed and register. If it does not, we need a new name before any publicity, because waiting on a registration is not affordable. Owner's criteria: five letters or fewer, .com available, pronounceable, memorable, ideally starting with A. Also worth weighing that "Ambi4" implies an ambient-only focus the app has outgrown — twelve genres ship today
  - **"Ambi" IS registrable and IS registered** — the owner's assumption that it is too generic is wrong. The owner's own UK IPO search (27 Jul 2026, "Ambi4" similar, all classes, live) returned 141 marks. In our classes specifically: bare **AMBI** UK00004060529 (classes 7, 9, 37, 42) and UK00004217938 (7, 9, 10, 12); **AMBI ROBOTICS** UK00003858339 (7, 9, 37, 42); **ambi CLIMATE** (9, 35); **ambi light** (9, 11); **Ambiel** (9, 41); **AMBIFY** (9, 35, 42); **Ambigo** (41); plus AMBIT, AMBIX, AMBIE, AMBIN, AMBION all in class 9
  - **Timing is the one thing in our favour.** Both bare-AMBI registrations postdate our 2024-01-27 first use (filed 6 Jun 2024 and 12 Jun 2025). AMBI ROBOTICS (Dec 2022) predates us and shares the same class set, so the bare AMBI is probably the same owner extending a robotics mark — goods far from music software, though class 9 is broad
  - **Nothing named "Ambi4" is registered anywhere**, in any class or jurisdiction. The space is actively being claimed though: **Ambixa** (class 9) was filed 18 May 2026 and **THE AMBI ROOM** (class 41) on 18 Jun 2026
  - Unregistered prior use also exists in our exact space: **Noise Makers** (noisemakers.fr) have sold Ambi Head, Ambi Pan, Ambi Converter and Ambi Verb HD since **February 2016**, and an **"Ambi" iOS app** — an algorithmic ambient noise generator, the closest functional twin — since **March 2014**
  - **Practical read:** contestable, not blocked. Adding a numeral to a registered word mark rarely creates enough distance on its own, so AMBI in class 9 is a live objection risk; our January 2024 use is a defence rather than a clean right. The cheap diagnostic is to **file a UK application for AMBI4 in classes 9 and 41** (£170 first class, £50 each additional, online) — examination and the two-month publication window surface any real opponent early and affordably. A clearance opinion from a trade mark attorney is the proper route if certainty is wanted before spending on branding
  - `ambi4.com` and `ambi4.work` are **both the owner's** (correcting an earlier note that ambi4.com was third-party)
  - Of the owner's candidates: `algo4.com` is registered (Hurricane Electric DNS, no A record, privately held); `algos.com` is registered and parked for monetisation via Above/Trellian; `alsyn.com` is registered via a Chinese registrar. `adsr.com` and `aion.com` showed no nameserver delegation and are worth a real availability check — `adsr` would suit an algorithmic synth well
  - A domain-hunt prompt for the Claude Chrome extension (Cloudflare registrar, checks availability without purchasing) is drafted at `docs/domain-hunt-prompt.md`
- [ ] Web Analytics privacy-page line — andeye.com/privacy mention of the Cloudflare cookie-less beacon (copy already drafted in the build log)
- [ ] Cloudflare Web Analytics: click Enable (RUM, cookie-less)
- [ ] contact.andeye.com form (preset submissions point at it; 404 today)
- [ ] Official andeye logo asset for the footer (placeholder deleted)
- [ ] Preset-name moderation taste rules (whitelist → AI review → human escalation) — policy must precede Plus-tier renames
- [ ] Record button tier decision (free now vs gated when payments exist)
- [ ] xander. playlist copy + NotXander filename: keep / reword / drop
- [ ] Custom-track share notice wording — ships as "Brought N custom track(s), playing stock voices."
- [ ] Address the 10 Dependabot advisories on the default branch (3 high, 4 moderate, 3 low) before going public
- [x] *(SHIPPED — `CONTRIBUTING.md`)* **Write CONTRIBUTING.md** — scales and genres (including the blind-identification bar a new genre has to clear), the no-tunings-on-spec policy, PD/CC0-with-provenance for art, the AI-free distinction (labelling is a claim a user signs about music, not about source), the test gates with `audio-reference` explained, house style, AGPL-3.0 + section-7 output exception + CLA, and how to report a fault you can only hear

## v0.2.x — held back until after public release

- [ ] **[decide] Name the tier that gates the patch sockets.** The plan said "Studio tier"; there is no Studio tier (Free, Plus, Pro, Premium), payments do not exist at v0.1.0, and the standing rule is that no paid feature is visible before its tier can be bought — so gating the graph to a paid tier ships the whole modulation-graph version dark at launch, while the transparency version needs those same cables for free-tier value. Either the graph is free at launch with a paid gate only on the v0.2.x user-authored instruments, or the graph moves after v0.1.0
- [ ] **Data-defined dials for paid-tier instrument building** — extend the registry with user-authored bindings so a Studio user can build an instrument and assign a dial to any parameter. Needs an address space beyond patch params and a persisted panel layout
- [ ] **NAM (Neural Amp Modeler) profile loading, A2 architecture — advanced feature, NOT a default.** Feasible and proven in-browser: TONE3000 ship a WASM fork of Atkinson's NAM core running inside an AudioWorklet, and the NAM Web Player already does this. A2 is the right architecture to target, since it exists so profiles load on weaker CPUs without conversion. **Scope it to monophonic tracks first — bass and lead — not the master bus and not the defaults.** Reasoning: a NAM model is a capture of a guitar amp, a nonlinear system built for a monophonic instrument-level input, so feeding it a six-track polyphonic mix produces intermodulation distortion that worsens with every simultaneous pitch, on top of an amp's hard band-limiting (roughly 80 Hz–5 kHz through a cab). Even Feather costs real CPU per instance, and defaults must run on the weakest device we support — the Eco tier caps at 8 voices and 15 fps because such devices exist. A default depending on a multi-megabyte downloaded model also breaks first-load and offline. Gives a large free profile library (TONE3000, `pelennor2170/NAM_models`) and a "bring your own tone" hook. Resolve first: model files can never ride in a share link and need their own loading UI, and the WASM fork's licence must be checked against our AGPL-3.0
- [ ] **Alternate tunings and custom scales** — a tuning system beyond 12-TET (cents or ratios rather than semitone integers), unlocking Maqamat quarter tones, Gamelan slendro/pelog, imported temperaments and a user scale builder. Deep engine change to the pitch pipeline. **Owner policy for requests (2026-07-27): we do not build these on spec.** A requester either contributes a PR themselves following the contributing guide, or takes a Premium licence and we undertake to build it to their satisfaction within three months. **Unblocked** — the policy is now written into CONTRIBUTING.md
- [ ] Tempo clock-in patch. **[flagged]** MIDI clock in is feasible on Chrome/Edge desktop via Web MIDI, unavailable on iOS Safari, and Ableton Link needs a native host — so this lands properly only in the Mac/iOS wrapper
- [ ] Audio-in track — mic capture to a buffer (on-device only), trim/normalise/loop editing, through the normal track chain. Capture half needs a real-device test
- [ ] Vocal-input auto-accompaniment with lyrics displayed against the derived chords — significant effort; wants the audio-in track first
- [ ] Block editor phase 2 — full JS seam editor (>_ icon), "default to code" pref (Pro, hidden until purchasable; sandbox design wants an owner glance)
- [ ] Arrangement studio — MIDI capture, offline render, mastered binaural/lossless exports (Pro)
- [ ] Stereo recording polish — wav via offline render (webm live capture already ships free)
- [ ] AI-free pledge labelling — a listed preset/album can carry "AI-free" if the user signs a pledge that no external AI compiled it
- [ ] Standalone one-off-purchase Mac/iOS build (Tauri/Capacitor) — a distribution commitment, strategic call not routine build
- [ ] Share tier 2 (named links via Workers KV + submit/approve) and tier 3 (code-bearing presets, sandbox + review gate, paid)
- [ ] Playlists rebuild — service-selectable across streaming platforms, broader instrumental artists, Ambi4-made categories; blocked on PD/CC0 artwork
- [ ] Premium tier: define the offer

---

## Gaps Fable found that had no home

- [ ] **[decide] State ownership when Auto writes its choices into the step grid.** If the generated pattern lands in the user-editable grid, what happens when the user edits a written step — does the track flip to Manual, or does that one step pin while Auto keeps the rest? Undefined, and it is the whole design of the transparency item. Probably needs a read-only engine-rendered layer distinct from user steps, plus a defined promotion rule
- [ ] **Error states for the modulation graph** — deleting an LFO or macro that has live edges, a share link naming a source the recipient's build lacks, and circular patches through utilities (a Mix fed from a parameter patched from itself). None specified
- [ ] **[decide] The strategy note and this plan disagree about the next flagship.** `Ambi4-strategy` says genres are it; v0.0.35 through v0.1.0 contains no genre work at all. If dials have consciously displaced genres, the strategy note needs updating to say so
- [ ] **Preset-name moderation has a policy but no build.** The Workers infrastructure, appeal flow and strikes ladder from the 2026-07-25 rulings appear in no version

## Open questions carried forward

- [ ] **[decide]** BPM range. The old note said "hardcoded 40–120", but the UI slider is `min=20 max=220` (:590) on a two-segment log curve centred at 60 (:1765), so that note is stale. The remaining question is the owner's original one — what are the slowest and fastest tempos to achieve significant commercial success — and whether the engine's clamp matches the UI
- [ ] Bass verdict — craft pass BUILT (v24) but failed the owner's ears twice; stays default-off until a listen passes
- [ ] Bass voice envelopes cap articulation (~1 s minimum note from `sub`) — halving it is a deliberate timbre decision
- [ ] Transport buttons: review which (if any) demote to Advanced-only
- [ ] Remind Martin to feed back on the dissolved Randomise row once he has tried it in a build

## Should not be built

- [!] Greyed (plus)/(pro) editor buttons — superseded by the "hidden until purchasable" owner rule (commit 60217c0)
- [!] Apple Music playlist integration (pl.u- shares) — broke when the subscription lapsed; superseded by the multi-service playlists plan
- [!] Bass on by default — attempted twice (v14 groove, v24 craft pass), failed the owner's listening verdict both times
- [!] Simultaneous value-and-spread drag at exactly 45° — see the axis re-arm item in v0.0.35 for the reasoning; superseded rather than rejected outright

## Branches

Cleaned 2026-07-27. `depluralise`, `thumbnails` and `update_worker_name_to_ambi4`
were deleted from the remote after proving each branch tip's tree was
**byte-identical** to a commit already in main (`dea3882`, `7624384`, `150d6c1`).
They showed as unmerged only because main's history was rewritten by the
earlier scrub, leaving them orphaned with no common ancestor. `main-clean` had
already been removed remotely; a stale local branch of that name remains.
Remote now holds `main` alone.

## Shipped log

Everything asked for across 2026-07-24 → 27 is built and verified — 41 items
traced to commits/files/tests in the audit record (brain2
`Ambi4-history-audit-2026-07-27`); day-by-day detail in CHANGELOG.md.
