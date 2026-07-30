# Changelog

## 2026-07-30

- [x] **v0.0.112 — Energy stage 2a: the top of the dial opens — the floor doubles and the fills arrive** — his brief for maximum Energy, verbatim: "drum fills all over the place, possibly 8 or 16 to the floor if you started with 4 to the floor." Genre kits: from 0.75 the LOW lane doubles (a hit midway between each written pair, sitting a shade under the authored accents so the accents stay the accents) and from 0.92 every slot of the bar kicks — deterministic, in the compiled lane, riding the v0.0.106 same-seed recompile so it is VISIBLE in the grid and stands down after a hand edit. Auto kits: from 0.75 a crescendo fill runs into the barline, more often the higher the dial (measured: 0 fill-bars at 0.7, all-over-the-place at 1). The identity window [0.5, 0.75) is byte-exact on both paths — pinned seed-for-seed in engine-smoke and compile-for-compile in genre-smoke — and the one sparsity cap that predated his ruling was retired with a note saying whose ruling replaced it. References untouched (24/24: the frozen configs never run auto percussion at the top). kit-softness-drive grows the top-half check: Energy full up, the Techno floor doubles on screen.

- [x] **v0.0.111 — pitch is editable in the grid: the readout gap closes** — v0.0.75 drew pitch and said so ("a READOUT, not editable"); the v0.0.109 pin makes the edit real and this build puts it under the fingers. On a melody or bass step: **P** opens an in-place box — type C#5 (or a MIDI number), Enter, and that step plays exactly C#5, every bar; an empty box clears the pin (as a null, because the engine's merge law ignores deletions). **Alt+drag** a cell up or down nudges the pin by semitones for the pointer path, so keyboard-only and mouse-only both work. The cell wears a small note-name tag while pinned and the screen reader hears "pinned to C#5 — plays exactly that note"; the legend documents both routes. Offered only where the engine honours the pin — melody, bass and user melodic lanes; the arp is excluded rather than given a dial the engine ignores. The capability is probed like every other engine seam (a build whose sanitiser drops `midi` never shows the affordance). `tests/grid-pitch-drive.mjs` (8 checks) asserts the ENGINE: the typed pin lands, the drag lands, the clear lands. All gates green; reference untouched.

- [x] **v0.0.110 — Type a melody: the second compose method lands** — a text box in the Create door's compose row: write note names (C4 E♭4 G3 — one per beat, a dash holds the note, a dot rests) and Write it puts them onto the melody grid as PINNED steps through the v0.0.109 schema, so each plays exactly the note named — no re-pitch, ever. Holds become one tied note across their beats (the v0.0.92 merged-box rendering shows them as one wide box); the lane goes manual; a silent melody track switches on; the writer says what it wrote and names anything it dropped, including tokens past the bar (a bar holds as many tokens as it has beats). Garbage is refused in place with the reason and the engine keeps what it had. One bar per write for now — the honest cap until linear multi-bar sequences have an answer (the Markov tabs shuffle, they do not sequence). `tests/typed-melody-drive.mjs` asserts the ENGINE's stored steps: pins at their beats, the tied hold, nothing past the phrase. All gates green; reference untouched.

- [x] **v0.0.109 — the step schema carries PITCH: the engine half of typed melody, editable grid pitch and MIDI import** — the one schema gap three owner asks funnel through, closed at the engine. A step may now carry an optional `midi` pin (0–127): a pinned step plays exactly the note it names — no chord re-pitch, no register fold, no cadence rewrite, because folding a stated pitch would be the readout lying — while a step without one keeps today's harmonic logic untouched (the frozen reference is byte-identical, 24/24). The pin follows the step-field merge law the tie/group fix taught this morning: absent inherits the stored value, null clears it, garbage clears it like a garbage gate. Honoured by the melody, bass and user-track manual planners (arp deferred: its pitches are sequence-derived and deserve their own ruling); the page's compact persistence round-trips the pin. Proven in engine-smoke (241 checks) at the REALISED note: a pinned 97 — outside both C major and the melody band — sounds as 97, every time, on melody and bass alike, and an unpinned grid never lands on it. UI writers (grid pitch editing, typed melody, MIDI import) are the next, now-unblocked builds.

- [x] **v0.0.108 — Energy 1c completes the low half: the AUTO kit arrives gently too** — the same ladder the genre kits got, now for the four grammar-path genres whose percussion composes itself: below the midpoint every auto hit's velocity scales down, the kick-anchor YIELDS (a gentle bar no longer opens on the kick by default), and a soft ride tick becomes the low-Energy opening instead — his words built literally: "a ride first, then soft kicks." The new draws only exist below the midpoint, so streams at 0.5 and up are byte-identical to the previous build — pinned in engine-smoke by comparing the shaped and unshaped calls seed-for-seed (240 checks now) — and the frozen reference is untouched (24/24; the low half of the ladder never fires in those configs' quiet sections because the track ladder holds percussion out there). With 1a (kick-lock), 1b (articulation fade) and both halves of 1c, the LOW half of the Energy redesign is complete; the top half (fills, bass-follows-kick, filter openness, doubling) is next.

- [x] **v0.0.107 — the raw take survives, and captures finally reach the page** — his ask, verbatim: "Keep the raw tap data so the user can re-quantise if we're doing a bad job." Every capture (tap-a-rhythm and play-along alike) now keeps its take RAW, in beat-domain — quantisation-independent — and a "Re-fit the last take" button in the Create door lands the same performance on whatever grid is current: change the time signature or the tempo, press it, and the note played past the old barline lands where it was really played instead of wrapping (engine-smoke pins exactly that, 4/4 wrap → 5/4 slot 17). Undo covers a re-fit like any capture write. **The bigger find was the missing half of every capture since v0.0.82:** the engine had the take and the page never learned — the grid drew the pre-take lane, the next step click silently wiped the take, and a reload lost it outright, unnoticed because every earlier check asserted at the engine alone. All three capture paths (take, undo, re-fit) now adopt the engine's sequencers back into settings, refresh an open editor and persist; `create-drive` asserts the take on BOTH sides of the seam (engine hits == persisted hits). All gates green; audio-reference untouched.

- [x] **v0.0.106 — Energy stage 1c: the genre's kit softens below the midpoint, in the grid where you can see it** — the ladder his words asked for ("a kit can arrive very gently"), landed on the honest side of the boundary: never a hidden note-on multiplier (a grid showing one velocity while another plays is the exact lie this project tests against), but a RECOMPILE of the genre's kit at the dial's value, same seed, written into the grid. Below the midpoint every lane's velocity band scales down (soft kicks are real kicks) and the high then mid lanes thin on an even deterministic stride — the LOW lane never loses a hit, because four-to-the-floor is the genre's identity and his steer said exactly that. Genre-appropriate by construction: Techno thins and softens, and never grows a brush. The dial only re-shapes a kit that is provably still the genre's own — the first hand edit to the grid breaks the provenance string and the follow stands down for good, so the user's data always wins. Reversible while clean: Energy back up restores the full kit byte-for-byte. No rng is consumed and nothing above the midpoint changes; `audio-reference` is untouched (24/24 — reference configs never move the dial). Pinned three ways: the compiler contract in `genre-smoke` (30 checks), the live loop in `tests/kit-softness-drive.mjs` (11 checks: thins, softens, restores, stands down after a hand edit), and every prior gate green. Still open in the low half: the AUTO kit's ladder for grammar-path genres, and ride-first instrumentation.

- [x] **v0.0.105 — Energy stage 1b: the bass's off-pulse articulation fades below the midpoint and is gone at 0%** — his steer, verbatim: "0% would remove the acid articulation if 4 to the floor is genre-defining." The groove builder always hung at least ONE syncopation cell off a pulse — fifth-and-octave off-beats, the acid figure on a Techno bass — unconditionally, at any Energy, which made the line's articulation the second thing (after 1a's kick-lock) the dial could not thin. The first cell now fades with complexity below the midpoint and is gone at the bottom, while the accented anchor spine keeps the genre's identity; from 0.5 up no extra rng draw is made, and byte-identity with the previous build is PROVEN against the pre-change engine and pinned as a golden stream in engine-smoke (238 checks now). Measured at the groove: off-pulse notes per bar 1.50 → 0.00 at complexity 0, 0.11 at 0.04 (where Energy 0 lands), unchanged from the midpoint up. The seven sub-midpoint reference configs move DELIBERATELY — thinning quiet pieces' articulation is the point — and the baseline is re-frozen at 0.0.105 in this same commit. Next in the ladder: the genre-appropriate kit-softness pass ("I don't imagine Techno ever uses brushes and rim shots").

- [x] **v0.0.104 — the genre's rules are on screen, and editing them re-draws the piece: the everything-editable build opens at the layer he chose** — his steer was option (a), the GENRE layer: "show the grammar of the current genre as editable text/controls, so changing 'x---x---x---' changes every bar drawn from it." A Rules button now sits beside the genre picker: the current genre's chord grammar (roman-numeral lines), its kit patterns and its syncopation cells, each an editable text box; Apply deep-copies the genre, overlays the edits and **recompiles at the same seed** — the compiler's fixed draw order spends the bpm/mode/metre/swing/structure dice before the grammar does, so only what you change, changes (drive-proven: bpm and time signature survive the edit byte-for-byte). Honesty travels with it: the picker entry and the button both read "edited rules", garbage is refused in place with the reason, an emptied box falls back to the genre's own rules, and Back to the genre's rules recompiles clean at the same seed. Two compiler truths shaped the panel: kit-path genres write their kit from `fallbackLists.grooves` (three lanes per pattern — so that is what the box edits there, not the anchor guidance the kit never reads), and the progression pool weighs `fallbackLists.progressions` double, so a chord-grammar edit empties that pool or the old chords keep being drawn. `tests/genre-rules-drive.mjs` (16 checks) pins the whole loop at the engine seam: the one-kick kit lands lane-exact, a one-chord grammar seeds a one-degree loop, refusal keeps the engine untouched, reset restores the genre's own kit. All gates green; audio-reference untouched.

- [x] **v0.0.103 — probability groups paint into a selected group, gaps and all — and unties finally reach the engine** — his ruling landed both halves of the groups question: the chain semantics stay exactly as shipped (each member rolls in turn; a member that stays silent silences the rest of its group for the bar — his own description, option a), and the JOIN rule is rebuilt, because "the probability group is not always contiguous … a gap is NOT a probability group boundary." Press any dot to start a group or select an existing one — its dots ring — then press any other dots, gaps and all, to paint them in; press a selected member again to remove it; Esc drops the selection; G does the same from the keyboard, per lane (the engine rolls each lane's chain on its own, so groups do not cross lanes). **The build surfaced a real stored-state defect**: the engine's step sanitiser MERGES against the stored step, so the page's `delete step.tie` / `delete step.group` never cleared anything engine-side — the boxes split while the engine played on tied. Proven live by a new engine-seam check (red on the old bundle), fixed by sending an explicit null everywhere a tie or group is cleared. `tests/prob-group-drive.mjs` (16 checks, red on the old bundle) pins the new model; `tests/tie-merge-drive.mjs` now asserts the untie at the engine. All gates green; audio-reference untouched.

- [x] **v0.0.102 — Simple's Tempo is the one dial that stays single** — his ruling, verbatim: "it's the one dial that shouldn't be variable." A sideways drag on the Simple tab's Tempo no longer opens a span — instead the message he asked for appears under the dials: drag up or down for speed; a randomly varying tempo is rarely a good thing; the Advanced tab's Tempo dial keeps the sideways drag for the piece that wants one. The refusal is never silent: `knob.js` gains `onRangeRefused`, fired once per gesture for pointer and keyboard alike, because a dial that silently ignores the spread gesture teaches that the gesture does nothing anywhere (the v0.0.57 worry, resolved the other way for this one dial by his ruling). A span created in Advanced still displays on the Simple view — refusing to draw state that exists would be the readout lying. Drive-proven at the engine seam both ways: the refusal sends no `spans.bpm`, the Advanced drag stores one; the three new checks fail on the pre-change bundle. All gates green; audio-reference untouched.

- [x] **The "intermittent shape-span loss" is closed — no engine defect existed; the drive's genre pin was dead code** — the session's opener, hunted with an instrumented twin of `tests/spread-all-drive.mjs` that logged every `setParams` payload. The filed theory ("the shape dial draws a span the engine never stores — the commit path, racing something") was disproven by the first captured failure: in failing runs **OSC 1 was never dragged at all**. The pin matched option value `synthwave`, but the picker's options are prefixed (`g:synthwave`) — `.find()` matched nothing, so every run played on the random draw, and roughly one draw in three deals the pad a voice with no shape dials (glass), which the named-dial loop then skipped **silently**. The engine seam is clean: every span the page sent, the engine stored, in every logged run. The drive now pins by the real option value, VERIFIES the pin at the engine (`tracks.pad.voice === 'polysaw'`, loud failure naming the picker's actual options if it does not take), and treats a missing named dial as a named failure rather than a skip. 5/5 consecutive green after; the same pin mistake had now been made twice ('ambient', then bare 'synthwave'), so the drive carries the history in a comment.

- [x] **v0.0.101 — the dev deploy is unstuck: Cloudflare could not build Astro 7** — his morning report was the symptom: mcdev hard-refreshed and still serving v0.0.85, which is exactly the last commit before the Astro 7 migration. Reproduced in the container: on Node 20, `astro build` refuses outright ("Node.js v20.20.2 is not supported by Astro!"), and a failed Cloudflare build leaves the previous deploy serving — silently. The v0.0.86 `.nvmrc` pinned the exact patch `22.23.2`, the newest 22.x in existence that day, which a build image's version cache can easily not carry yet; it now says just `22`, the loosest spec that satisfies Astro's `>=22.12` floor by resolving to whatever current 22.x the builder has. The version bump itself is the test: mcdev showing v0.0.101 proves the pipeline. Fallback if it stays stale (dashboard-side, owner only): set `NODE_VERSION=22` on the Worker's build settings and read the failed build log. Also fixed en route: `tests/page-boot.mjs` assigned jsdom globals by `=`, which Node 21+ rejects for its own getter-only `navigator` — the gate only ever passed under Node 20; it now defines the property and passes on the same Node 22 the builds use.

- [x] **v0.0.100 — a wandering voice says so** — the close of his "I never selected Call myself". Both routes were real: one factory preset (Dawn Song) chooses Call by design, and the deliberate anti-monotony voice wander on pad and texture can land on any voice in the bank — correct behaviour, kept. The genuine defect was display: the track row's live option labelled a wandered voice exactly like a chosen one, which is precisely how "Texture: Call" read as a setting he never made. It now reads **"Call · wandering"**, with the tooltip carrying the escape hatch (your own choice is unchanged; picking any voice ends the wander at once). Engine-smoke pins the whole seam while the engine RUNS — `getResolved` reports the wander, `getParams` holds the user's choice, the wander never leaves the track's own bank, and an explicit pick ends it immediately (the first draft asserted on a stopped engine, which has no wander to show, and was caught by its own failure). All gates green; reference unchanged.

- [x] **v0.0.99 — Energy redesign, stage 1a: low Energy finally thins the bass** — his Techno-at-0% report, run to ground: the bass takes any pulse the kick lands on with probability **1**, at any Energy — the kick-lock that makes a rhythm section read as one instrument also made the bass the one line Energy could not thin, and a four-on-the-floor kit locks every pulse. Below the dial's midpoint the lock now loosens with complexity (the accented anchor itself never goes); from 0.5 up the chance is exactly the old 1 with an unchanged rng draw count, so every stream at or above the midpoint is byte-identical. Measured on the live engine: **Techno bass at Energy 0 drops 4.4 → 2.98 notes per bar**, and 0.55 is untouched. This DELIBERATELY moves the five frozen reference configs whose complexity sits below the midpoint — thinning quiet pieces' bass at low Energy is the point — so `tests/audio-reference.mjs --update` re-freezes the baseline at 0.0.98 in this same commit. Stages 1b onward (the kit-softness ladder, fills, coupling, filter, doubling) are staged in the TODO as the next session's opener.

- [x] **v0.0.98 — custom time signatures** — the fixed five-metre list gains **Custom…**: an N/D pair beside the select accepting any N/4 up to 5 and any N/8 up to 10, which is the step grid's own twenty-step bound stated as a rule rather than a surprise. Compound /8 bars group in threes when they divide that way (6/8, 9/8), otherwise twos with the odd three last — exactly how the shipped 7/8 has always grouped, generalised. The engine is the judge: `metrePulses()` grids named and custom metres alike, the sanitiser accepts precisely what can be gridded and keeps the stored metre otherwise, and the commit path re-reads the engine so the inputs always show what actually stuck. One landmine stepped on and defused: an early `describe()` call re-created the recorded blank-page TDZ crash (6105e0d) and page-boot caught it before it could ship. Behaviour pinned in engine-smoke; every gate green, `audio-reference` unchanged.

- [x] **v0.0.97 — sections can be verses, and they can carry their own names** — the custom structure builder gains **V and V1–V4** labels alongside A–D, and every block takes an optional **title** (up to 24 characters) so B can double as "bridge" and C as "chorus". The title is additive on the wire — absent when empty, so every structure stored before tonight round-trips byte-identically — travels with the engine's section event, and the piano roll's section strip draws it in place of "Section B" when one exists. Sanitiser behaviour pinned in engine-smoke (trim, cap, drop-when-empty, V-family legality); visualiser 45/45; layout sweep clean; `audio-reference` unchanged.

- [x] **v0.0.96 — Processor becomes one block, and the guided tour is back inside its own spec** — the no-orphan rule's worst offender reversed: the Processor label lived in the transport header, its dial three containers later, its readout inside the genre row; all three are one labelled column now, and the no-JS removal path is one removal instead of three. Running `tutorial-smoke` (listed as a gate, quietly unrun for a stretch) then surfaced real drift: the tour had grown to fifteen steps and two steps had swollen past tour length with the night's additions. Play and Pause merged into one transport step, the dials and Create steps were cut back to tour size — their detail lives in the panel ⓘs, where he ruled instructions belong — and the coverage list learned the keyboard's real name, Musical typing. `tutorial-smoke` 8 checks + 8/8 mutations at 14 steps; every other gate green.

- [x] **v0.0.95 — the preset-slug constraint is self-enforcing, and the drive suite is documented** — two hygiene closes. The advisory review's one live caveat (a preset slug is interpolated into an inline script, safe only while slugs are machine-made) is now a BUILD-time assert: any slug beyond lowercase/digits/hyphens fails `astro build` with a message naming why, so a future submission-sourced preset can never quietly carry markup to the page. And `docs/TESTING.md` gains the browser-drive inventory — twenty-one drives and three offline render harnesses, what each holds the line on — which existed only as filenames until now.

- [x] **v0.0.94 — mass edit: Fill, Every 2nd, Clear** — the first slice of his 89's mass-edit ask ("fill a whole row, or every second note"). Three actions above every step grid, acting on the focused lane (which is the only lane everywhere but the kit, where it is the lane last touched). They act on the VISIBLE bar — the stored lane is longer than the metre shows, and the first cut walked off the rendered cells and died before committing, which the engine-seam drive caught (the settings changed, the engine never heard). Asserted at the engine's stored lane: all on, alternating, all off. Setting a probability across a selection is the remaining half and lands with the resolution control. All gates green.

- [x] **v0.0.93 — notes on top, chance and grouping at the bottom** — his reading order, asked for twice: the probability-group dots move from above the cells to BELOW them, beside the probability bars, so a lane reads notes-and-pitch at the top and everything about chance together underneath. The grid legend and keyboard help follow in the same commit, and the drive asserts the ordering by geometry.

- [x] **v0.0.92 — a tie is one wide box** — his 105: *"it should merge two boxes into one double width box, three into triple… The current implementation is very hard to see."* A tied run now renders as ONE box spanning its steps — in all three rows at once (the cell, its group dot and its probability bar), because the engine genuinely drops an absorbed step from the bar, so showing it a live-looking bar of its own was a lie. A thin warm underline marks tied-versus-just-long. Keyboard focus walks over absorbed steps in the direction of travel instead of landing on nothing. `tests/tie-merge-drive.mjs` proves it by geometry — head box ≥1.85× a plain cell after T, two boxes again after untying — because "double width" is a number, not an impression. All suites, sweeps and the frozen reference green.

- [x] **v0.0.91 — the mix goes straight to the speakers everywhere but iOS** — his latency report ("intolerable, for a percussionist"), traced to a real buffering stage rather than guessed at. Since the mute-switch work, EVERY platform's mix routed through a MediaStream → `<audio>` element — but only iOS needs that (its hardware mute silences a bare AudioContext), and the media pipeline adds its own buffering on top of the context's on machines that never asked for it. The element sink is now gated to iOS (including iPadOS-as-Macintosh); everywhere else the limiter feeds the destination directly. New `getOutputInfo()` on the engine reports the route and the context's own figures; `tests/latency-drive.mjs` asserts the desktop route is DIRECT and measured the honest floor on the Mac test machine: **5.3 ms base + 40 ms output at 48 kHz** — the browser's floor, which no scheduling change can go below (and which Bluetooth output would add 100–300 ms on top of, wherever it is in use). The engine-smoke iOS-route test now dresses as iOS to exercise the element path. 237/237, `audio-reference` unchanged.

- [x] **v0.0.90 — guided start is a visible option, and silence after Blank slate is a tested promise** — two halves of his 105/103 follow-ups. **Help me start** now sits first among the create options: it points at the genre seed (which names where that genre's composers usually begin) and the three dive-in doors. And his "press blank slate then play, I get a complex bassline I didn't programme" — reproduced against the old stub's behaviour, unreproducible against the real blank: the drive now presses Blank slate, presses Play, listens for three and a half seconds at the engine's own note stream and asserts **zero notes arrive**, locked in as a permanent regression check.

- [x] **v0.0.89 — Create rebuilt to his correction: an icon, Zero buttons, and a blank slate that is actually blank** — his 103, point by point. The wide orange button that "forced everything into two lines" is gone: Create is back in the icon-row slot, **icon-only, orange, CREATE in the tooltip**, and the drive now gates on the transport buttons sharing one line. The duplicate Create title is gone. The create options are his: **[Blank slate] [Zero voices] [Zero chords] [Zero notes] [Zero rhythms] [Zero FX]** — the Zero buttons strip one layer at a time so ANY preset can be the starting material. **Blank slate is real now**: it was a stub that only switched track states off, which is why he still had "massive reverb and delay" — it now loads the same full blank snapshot as the Advanced button, and that snapshot itself learned to zero the FX (room to its smallest, every default voice's sends to zero). The instruction prose is out of the panel and into two ⓘs — including that Blank slate or a zero-AI preset is what makes a piece eligible for a zero-AI badge — and the keyboard section is named what the industry names it: **Musical typing**, its toggle labelled Keys. A MIDI keyboard needs no setup (the ⓘ says so). `tests/create-drive.mjs` grew to 21 checks, all at the engine seam where it matters. All sweeps and suites green; `audio-reference` unchanged.

- [x] **v0.0.88 — the noise leaves the Call voice, deleted not rebalanced** — his ruling in full: *"The whistle is nice, I don't know why you need the static pink noise in there at all… it's just not a natural part of a bird call, or a noise we hear in reality with that duration and spacing, other than IMHO someone sawing — please just delete the noise from the Call instrument and be done with it."* Done: the breath layer (a pink-noise band gated with every chirp) is removed from `callVoice`, for both the melody and texture readings. The bare whistle then measured five times quieter than the two-layer voice — the noise had been carrying most of the level — so the tone gets a ×3 makeup that lands the voice near its previous place in the mix (0.016 peak against 0.027 before, 0.005 bare). `tests/call-breath-render.mjs` now asserts the whistle stands ALONE (a noise layer sneaking back would drag the top-band share below its floor), still rises, and still sits in the texture register. Engine 237/237, `audio-reference` 24/24 unchanged — no frozen config reaches the call defaults.

- [x] **v0.0.87 — Tap a rhythm: the Space bar is a drum** — the create door's next piece (his items 96 and 89, "space bar or button — love it"). One press of Tap a rhythm points the play-along keys at the kit, arms them AND arms Capture, so every Space tap sounds the kit live and lands in the drum grid at its current resolution; press again to stop, and Capture reports what it wrote. Space is only a drum while tap mode is on — everywhere else it stays what it was, including toggling grid steps under focus. Drive-proven at the engine seam: taps arrive on the percussion track, arming and disarming both work, and the guided tour sentence rides in the same commit. All sweeps and suites green; `audio-reference` untouched.

- [x] **v0.0.86 — Astro 5 → 7, and the security page's root fix is in: zero vulnerabilities** — his ruling (93: a) on the Dependabot investigation. `astro@7.1.6` builds this site with **no source changes at all** — the fifteen pages compile as they were — and an npm override lifts astro's bundled `sharp` to 0.35.3, which closes the last advisory: `npm audit` reads **0 vulnerabilities** across all 373 packages, against 3-high/4-moderate/3-low before. Astro 7 requires Node ≥ 22.12: the container builds with a checksummed Node 22.23.2 toolchain, and `.nvmrc` rides in the repo so Cloudflare Pages builds with the same — if mcdev ever shows a stale version after this, the Pages project needs `NODE_VERSION=22` set in its dashboard. Proven the expensive way, because a build-system major deserves it: the full browser-drive suite — all 21 drives — plus the layout sweep at three viewports, engine 237/237, and `tests/audio-reference.mjs` **24/24 byte-unchanged**. The ten GitHub alerts close on their own once main carries this lockfile (main moves only on the owner's go, as ever).

- [x] **v0.0.85 — Create is the app's second main door** — his item 96, built to his structure. The piano icon is gone from the icon row; in its place an **orange Create button sits beside Play, at Play's own height**, opening a panel with his three doors: **Create** — a Blank slate button that switches every instrument off at the engine so you build from silence, plus a genre seed that writes a genre's instrument voices into the engine without playing a note, and a guided line that names what that genre's composers usually start with (techno starts with the drums, ambient with the pad, minimalism with one repeating cell…); **Compose** — typed chords are live today (the roman-numeral editor, one press to hear a chord), with typed melody, words and MIDI import named as landing here; **Play along** — the whole existing keyboard, unchanged. Popovers also learned to pick the side with room on open, since the new button moved every anchor. Drive-proven at the engine seam (`tests/create-drive.mjs`, 11 checks: states really go off, Synthwave's exact voices really arrive, states stay off through seeding); page-boot's location assertion updated for the deliberate move; all sweeps and suites green, `audio-reference` untouched.

- [x] **v0.0.84 — popovers stay on screen, and the play-along keys stay armed** — both from his item 95. The timer and play-along popovers anchored `left: 0` and grew rightward from icons at the page's right edge, straight off the screen; they right-align and grow leftward now, and below 560px — where no anchored placement can fit a 240px-plus panel beside a right-edge icon — the popover takes the viewport instead (fixed, inset 16px). Proven by box geometry at 1280px and 390px in `tests/popover-drive.mjs`, because on-screen and one pixel off-screen are the same screenshot. And closing the play-along popover no longer switches the keys off: the v0.0.40 disarm-on-close is deleted, with its worry (a live instrument with nothing on screen saying so) answered by the keyboard icon staying lit while the keys are armed. The play-along drive now also proves a key still reaches the engine after the popover shuts. Engine 237/237, `audio-reference` 24/24 unchanged, layout sweep clean.

- [x] **v0.0.83 — Simple gets Tempo back** — his item 90, and he was right in a way the code had hidden: when v0.0.71 separated Energy from tempo, the Simple tab was left with **no tempo control at all** — Energy stopped writing bpm and nothing replaced it. Simple now has four dials: Tempo, Energy, Change, Volume. The new dial is a second view of the same bpm as Advanced's — the two mirror — but it lands its change on the next **beat** (a beginner needs to hear the thing they just dragged do something) where Advanced lands on the barline, which is v0.0.57's A/B preserved. The Advanced ⓘ that claimed "Tempo, Complexity and Volume are the same three values as the Simple tab" was already false and is corrected. `tests/simple-tempo-drive.mjs` asserts the ENGINE's bpm moves from a drag on each view and that each lands where it should; layout sweep clean at all three viewports; engine 237/237; `audio-reference` 24/24 unchanged.

## 2026-07-29

- [x] **The click-on-onset hunt: every voice-layer interaction now measures clean** — `tests/onset-render.mjs` gained the three cases no render had exercised, built exactly as the engine builds them: a real three-note `legatoFrom` slur chain (first coverage ever of the shipped `takeOver` path — fingered, sub and sawbass all take the slur, handover steps at 0.09–0.62 of the body's own; upright refuses by design), an engine-style `handle.cancel(at)` mid-note (no step — a plausible stale-value hypothesis measured and killed), and a bass+pad+kit same-instant sum (ratio 1.0). With isolated onsets, fast lines, slurs, cancels and summing all clean, the owner's click cannot live at the voice layer; the TODO item now names the live-context candidates (voice stealing, governor transitions, the master compressor) and the next harness (full-engine offline render), so nobody re-tunes a healthy voice on this complaint.

- [x] **The compose/create mode has a spec** — `docs/compose-mode-spec.md`, drafted to the owner's two briefs: create starts from a blank slate, any track can be the front door (chords, melody, beat, bass, arp, texture), guided questions sit beside the dive-in paths, tap-a-rhythm arrives on space bar or button, hum/whistle comes before singing, and the everything-editable ruling is the spine — derivations land as chosen data, authored data is never rewritten. Phased; phase one needs only what already exists plus the pitch-editable grid. Three open questions bundled for the owner's review.

- [x] **v0.0.82 — play-along plays again** — his report: "play-along hasn't worked since some time after my asking for the latency to be improved." Right, and the break predates the latency item (which was never built): **v0.0.40 turned the panel into a popover with `role="dialog"`, and the instrument's own typing guard treats any dialog as "someone is typing — don't play"**. Enabling the keys leaves focus on the Enable button inside that dialog, so every note key was swallowed precisely when the panel was open — and the popover disarms on close by design, so there was no state left in which a key made a sound. The panel that exists to make the keys work is what silenced them. Fix: the play-along popover is the one dialog that is NOT typing; the guard still blocks the track select, real text fields, contenteditable and every other dialog (the Timers popover included). `tests/play-along-drive.mjs` proves it at the engine seam — `noteOn`/`noteOff` are counted via the test seam, never the readout — failing on the pre-fix build with zero calls and passing after, with a regression check that typing in the track select still plays nothing. Gates: engine 237/237, `audio-reference` 24/24 unchanged, page boots, transport and ⌘Z drives untouched.

- [x] **v0.0.81 — the call voice is a bird, not a saw** — his item 85 closed the hunt: "I heard the sawing again in Synthwave, and saw that Texture was set to Call." The texture reading of call was DESIGNED as the saw without anyone noticing: "slow, low and falling" — a −9-semitone glide through formants at 620 and 1400 Hz, repeated every 1⅓ seconds, which is a low resonance falling and dying over and over: a saw stroke. It now rises (+6 semitones) through formants at 1300/2600 — still the slow, settled reading, an octave and more below melody call's quick bright bird. Measured in `tests/call-breath-render.mjs` against the shipped bundle: chirp centres 662 → ~1130 Hz, each call rising ~0.2 octaves, with a ceiling assertion keeping texture call below melody call's register. The breath layer's makeup gain is also capped at 2× (it could reach 6×, sitting the noise at twice the whistle it was meant to sit beside) — measured alone that was NOT the saw (top-band share moved 0.46 → 0.48), which is why the defaults moved too; the hypothesis was kept honest by measuring it before believing it. Full gates: 237/237 engine, 24/24 `audio-reference` unchanged (no frozen config reaches the call defaults), page boots.

- [x] **The 10 Dependabot alerts are investigated, named and judged — nothing upgraded, nothing dismissed** — `docs/dependabot-2026-07-29.md`. The PAT cannot read the alerts API, so the view was rebuilt from the outside: all 373 lockfile packages swept against the GitHub Advisory Database, returning exactly the ten findings GitHub counts (3 high, 4 moderate, 3 low). `npm audit`'s "3" is per-package grouping of eight astro advisories, not hidden alerts. Nine are inert for a prebuilt static site with no server and no untrusted input at build; the tenth (XSS via `define:vars` `</script>` sanitisation) touches the one vulnerable feature actually in use — `[preset].astro` passing the preset slug — and stays inert only while slugs are machine-generated, which makes preset-name moderation a security control rather than taste. Root fix for all ten is the astro 5→7 major, filed as a deliberate pre-release migration; the timing decision is with the owner (fromClaude 93).

- [x] **TODO.md restructured on the owner's rulings (his items 78–87)** — the v0.0.35→v0.0.42 version ladder is retired; open work now lives in unversioned Backlog groups and nothing open sits under a version older than the shipped v0.0.80. Folded in the same pass: the everything-visible-everything-editable ruling replaces the auto/manual question; his max-energy description replaces my three options as the Energy design brief; the drum-grid rebuild is closed ("good enough for now"); the scale list is parked to v0.2.x as an Other-opens-a-scales-editor flow; the sawing is pinned on the `call` voice and filed as the top defect; and the private-repo location assessment he asked for is delivered as an a/b in his channel.

- [x] **v0.0.80 — the Ambient wash stops sawing, and the full-screen bar is one row of one kind of button** — two of his smaller notes, both measured rather than eyeballed.

  **The saw.** His words: *"the whistling is fine, it's called 'call' so let it be a bird sound not a sawing sound."* Two things were moving in the wash voice and only one of them is the bird. The Q wobble is the bird and is untouched. The band CENTRE was travelling from 320 Hz up past f × 2.4 × brightness and back down again over every single note — a filter sweep, and a filter sweep repeated forever is what a saw sounds like. It holds still now, at the geometric mean of the two ends it used to travel between: the centre of the region it spent the note passing through, which is the least-surprising place to stop it, and the frequency the noise makeup gain was **already** computed at — so the level is exact now rather than an average of a moving target.

  **Measured, because "it sounds better" is not a result anybody can check** and nobody in this container can hear it anyway. A sweep is the spectral centroid moving over time. `tests/wash-sweep-render.mjs` renders one six-second note of the shipped voice offline and measures the centroid in eight windows across the body: **1.11 octaves of travel before, 0.27 after**. The lower bound is asserted too — a completely static spectrum would mean the Q wobble had gone with the sweep, which is the bird. The test was run against the old code first and fails on it.

  **The full-screen bar.** His note on approving it: one consistent button style on one line; it had two styles on two rows. The ☰ was a bare transparent glyph pinned above a pair of secondary buttons. All three are secondary buttons in one row now, stretched to a common height so they line up exactly. The ☰ stays outside the collapsing group because it is the control that brings the group back — it fades rather than sliding away, and comes to full strength the moment a pointer or the keyboard finds it. `tests/fullscreenbar-drive.mjs` measures the boxes rather than looking at them, because "on one line" and "1px apart" are the same screenshot.

- [x] **v0.0.79 — a share link is a base plus a diff, and provenance became evidence** — two items off the same v0.0.62 foundation.

  **Share links.** His note: *"share links should use the same base-and-diff. They still base64 the whole tree into the fragment, which is the same fault in a place that has not bitten yet — a fragment is not sent to a server, so it fails later and quieter (a link too long to paste into a chat window)."* A link now carries `{o: origin, d: diff}` — the style's id and seed, plus only what the sender changed. **A clean link off a genre is 116 characters**; the same setup used to be a base64 of the whole tree. After a key and scale change: 150.

  **The whole-tree branch is permanent, not transitional.** Every link already in the wild carries the full tree and lives in other people's chat logs forever, so a payload with no `o`/`d` is still read exactly as before. If a compact link names a style this build cannot rebuild — an unknown slug, a compiler that refused — the diff is applied to the plain defaults and **the arrival note says so**, because a listener hearing a different piece under the right name with no explanation is the failure that matters.

  **A test that was quietly proving nothing.** The first cut of `tests/sharelink-drive.mjs` followed each link with `page.goto`. A goto to a URL differing only in its fragment is a *same-document* navigation: nothing reloads, no payload is read, and every assertion after it passed against the page that was already there. Three of the four checks were vacuous. They force a real reload now, and the round-trip check is what actually proves the base is rebuilt byte-for-byte rather than approximately.

  **Provenance as evidence.** TODO's wording: *"a piece that is one of our genres plus a human's edits is a different object from one that arrived as an opaque blob."* The Submit panel now states, in a sentence, what this piece grew from and how many settings are the listener's own — *"Built on our Techno Tools style, with 11 settings changed by you"* — and the same block travels with the submission: the style id, the seed that rebuilds it, whether it IS rebuildable, and the count. It decides nothing about the AI-free label: that remains a claim a person signs about the music, exactly as CONTRIBUTING.md says. It puts the evidence beside the claim so a reviewer can tell the two kinds of submission apart. The line is kept current from the settings funnel, because a provenance line that was right when the panel opened and wrong ever after would be worse than none.

- [x] **v0.0.78 — ⌘Z undoes whatever you did last** — his ask, verbatim: *"cmd-z undoes the last user input, whatever it was — including Next. Not the setup-only stack Back uses; a single universal undo over every input, unlimited within a session. Back stays as the coarse control."*

  The v0.0.58 note beside the Back button said a general undo would mean "every commit path would have to opt in, and a drag would have to coalesce". Both were true and neither needed solving on its own, because the page already has **one funnel every committed change goes through**: `persistSettings()`. Every dial, every select, every grid edit, every genre pick and Next itself all call it — and it already debounces, which is exactly the coalescing a drag needs. So the undo watches the funnel rather than instrumenting a hundred call sites, and **one drag is one entry** because one drag is one persist. The test drags the Tempo dial through forty moves and asserts a single ⌘Z puts it back.

  **Entries are the previous value of whichever top-level keys changed**, not whole snapshots — "unlimited within a session" over a tree this size would otherwise mean tens of megabytes. Top-level granularity rather than per-field is deliberate: a partial patch cannot express "this key used to be absent", and restoring a whole subtree always can.

  **Redo is included** (⇧⌘Z, or Ctrl-Y). Not asked for, and here for one reason: an undo with no redo makes an accidental ⌘Z unrecoverable, which is the same trap the single-click dial reset was — and that one was already ruled against.

  **Inside a text field the browser's own undo wins**, because there the person is looking at their typing, not at the app's state.

  One bug worth recording because it took the whole page down for a build: naming `noteUndoPoint` directly inside `persistSettings` read the undo's `let`s before they existed, since `persistSettings` runs during boot and the undo state is declared much further down. It is an explicit `onSettingsCommitted` hook now, assigned once the state is real.

- [x] **v0.0.77 — chord length in any number of bars, or one chord per section** — his note was *"chord length still has no custom option in beats, bars or sections."*

  The list was Auto / 1 / 2 / 4 / 8, which left **3, 5, 6 and 12 bars unreachable for no musical reason** — a whitelist was simply the wrong shape for a bar count, not a deliberate restriction. It is now every whole bar count up to sixteen.

  **One per section** is the other unit he named. It holds a single chord for a whole structure block and reads the length from the block itself as it begins, so a six-bar verse and an eight-bar chorus each get one chord of their own length without anyone typing either number. A chord that starts mid-section runs only to that section's end, which is what makes the next one land on the boundary rather than one bar past it. On the shapeless presets (drone, waves) it degrades to one bar, which is more honest than pretending a boundary exists.

  **Beats are not offered, and the reason is in the code rather than in a promise.** Harmony advances once per BAR here — every instrument plans a whole bar against one chord — so a sub-bar chord is a change to the harmony frame and to every scheduler that reads it, not a new entry on a list. The tooltip says so, and TODO carries the shape of the change rather than a vague "later".

  The select is now **built from the engine's own `HARMONY_RHYTHMS`** rather than written out in the markup: a hand-kept copy of an engine list is exactly how a control comes to offer a value the engine then silently drops. The browser test asserts the two agree.

  The section test is the one worth keeping: two blocks of *different* lengths, so no fixed bar count could produce the same pattern by accident — the changes have to land on 5, 8, 13 and 16 rather than on any regular grid.

- [x] **v0.0.76 — chords you can hear, not only read** — his amendment to step 2 of the agreed plan, verbatim: *"that only works for people who can hear chords in their head when they see the names, we need an audible version of this with a nice visual manipulator for those who can't."*

  v0.0.68 shipped the numerals, which was his own instruction and the right first move — roman numerals are the vocabulary the twelve genre files are written in. But a numeral is a name for a sound, and naming a sound to someone who cannot summon it is not showing it to them.

  **Every chord in the loop is now a card.** Press its face and it sounds, through the piece's own pad voice on the same live-note path a played key uses — not a second synth that would drift out of agreement with the music. Printed on the card: the numeral, the chord's honest name from the semitones it actually contains, and **the notes themselves in the current key**. Arrows move the chord through the scale, a button widens it (triad → 7th → 9th), × removes it, Add a chord copies the one you were just listening to, and **Hear the loop** plays them all in order.

  **The text field stays.** It is faster for anyone fluent in numerals, and deleting the expert route to serve the beginner is the trade this project keeps refusing to make. The two are views of one value, which the test proves by writing through the field and reading the cards.

  **Nothing new is stored.** The loop is still degrees; everything on a card is derived from those degrees plus the key and scale currently set, so a share link written before this version reads exactly the same. Change the key and every card re-colours while the stored loop sits still — which is the engine's model made visible rather than papered over. It is the same re-colouring the hint has warned about in words since v0.0.68.

  **One honesty fix the test forced.** The widen button writes a real change every time, but the engine treats the extension as a NUDGE relative to Complexity rather than an absolute width — so at some Complexity settings a triad and a 7th land on the same chord. A button that silently changes nothing is the thing this app keeps ruling against, so when that happens the hint now says why and what to move instead. The test asserts *either* the chord changed *or* the app explained itself, which is the honest pair of outcomes.

  `tests/chordchip-drive.mjs` counts the sounded notes at the ENGINE rather than listening: a card that lights up and plays nothing is precisely the failure this feature exists to fix. It also pins the scale before writing a loop — a fresh visit draws a random genre, and a five-note scale refuses a loop containing vii outright, which would have made the test pass or fail on which genre was drawn.

- [x] **v0.0.75 — the grid shows which note the app chose, not just when** — the other half of the agreed plan's step 1. v0.0.67 made the app's rhythm visible and his next line was the obvious one: *"a bass line's rhythm is now visible and its notes are not."*

  The engine's note event has carried `midi` since v28 and nothing on the page was reading it here, so the grid could tell you WHEN the app plays and never WHICH NOTE. Each chosen step now draws a **tick positioned by pitch** inside its own cell, one per note, so a line's shape reads across a bar without reading a single name — which is what a grid is for. The **names are on the cell** (tooltip and accessible label: *"the app plays C2"*), because a contour is not a readout on its own, and because "show what the app is doing" is not a sighted-only promise.

  **The window the ticks are drawn in only ever widens.** A range that re-fitted itself every bar would move every tick the moment one new note arrived, and a contour you cannot compare with the bar before it is not a contour. It never narrows below an octave either, so a track playing one note does not draw it at full scale. What the window currently is gets stated under the grid rather than left to be inferred.

  **Percussion draws nothing, deliberately.** A kit lane's midi number is a slot in a kit, not a pitch, and drawing it as one would invent a melody out of an implementation detail. Its v0.0.67 rhythm readout is untouched, and the test asserts that too — an exclusion that took the rhythm with it would have gone too far.

  `tests/pitch-drive.mjs` plays for real rather than injecting a note stream, because the handler under test reads what the engine emits and a fake stream would only prove the painter works on input the app never produces. It asserts the ticks exist, sit inside their cells, and have **more than one height in them** — if every tick sat at the same height the picture would be a rhythm again. Scoping the queries to one editor is load-bearing: closing an editor hides it rather than removing it, and the first run failed on the bass track's own ticks while checking percussion.

  One tidy-up in passing: there were two note-name spellings in the page and there is now one.

- [x] **v0.0.74 — every dial that describes an amount now takes a range, and the two that do not say why** — the owner's instruction was *"either tell me why you won't add variation to all dials, or add it to them all, including OSCs and picker dials like filter type."*

  The v0.0.56 reason did not survive contact and is withdrawn. It said a span between two named switch positions would mean nothing, and named the shape morphs, octave and filter type as the params the engine cannot walk. Two thirds of that was wrong about the app's own code: **the shape morph was always continuous** — fractional positions between sine, triangle, saw and square have been legal since v5, and the dial has drawn the intermediate waveform all along — and **an oscillator jumping octave bar by bar** is an ordinary synth behaviour, not a nonsense one. What was actually blocking both was that `PATCH_SCHEMA` read them with `oneOf`/`numberIn` instead of `sanitiseRangeValue`, which is an engine gap and not a design objection.

  **Now spreadable, engine and dial together:** the two shape morphs, octave (rounded at RESOLUTION rather than at sanitise, so the stored span keeps the ends the dial drew while the walk only ever lands on a stop the switch has), per-track **glide**, and per-track **swing** and **density**. Swing and density needed a new sanitiser helper rather than a swapped one: `null` on those two means "follow the global dial", which is a different KIND of answer from a small amount, and flattening it into the bottom of a range would have lost it.

  **Still single, and this is the reason that does survive:** the filter **Type**, the **Processor** tier and — as their own case — the **Drift rate**. The first two are string enumerations with no numeric axis for a span to mean anything along; a `{min, max}` there is not a smaller claim than the engine can honour, it is a claim about a scale that does not exist. Drift rate is the speed at which every other span walks, so spreading it asks a walk to set its own step size.

  **The feel dials have one extra rule.** Swing and Density are drawn as 21 steps whose bottom stop is **Auto**, and Auto is not less swing — it is "follow the global dial". A span is therefore pushed up off that stop rather than allowed to include it, because a range reading "Auto to heavy" would claim the track alternates between following and leading, which the engine has no way to do.

  **A browser test now holds the line.** `tests/spread-all-drive.mjs` opens the voice editor, drags every visible dial sideways, and asserts there are exactly two categories: dials that spread, and named enumerations that do not. It checks the **engine's stored value**, not only the dial's readout — which is what caught the two real bugs in this change: track glide was collapsing its span to a midpoint in `commitGlide` before it ever reached `setParams`, and the octave dial was doing the same through `Math.round`. Both drew a range the engine had never been given, which is exactly the silent drop the owner has objected to twice. 31 dials are proven spreadable end to end.

  The manifest compiler needed no edit at all: it derives `rangeable` per field by round-tripping a probe value through the schema rather than from a hand-kept list, so it followed the engine change on its own — and there is now a test asserting that it did.

  Docs updated in the same commit per the standing rule: the RangeValue section of `docs/engine-v2-contract.md` carries the amendment and the withdrawn reason, and the guided tour's dial step says plainly that every dial takes a range except the few that pick a named thing.

## 2026-07-28

- [x] **v0.0.60 — you can see when a dial is still listening to you** — the owner's first and most repeated complaint on reviewing v0.0.59: *"far too often I set the dial as I want it then move to go elsewhere and I've ruined it."*

  A pointer capture that outlives the gesture is invisible — the dial looks identical whether or not it is still following the cursor — so the next movement anywhere on the page silently drags it. The indicator now more than doubles in thickness while a drag is live (2.4 → 5.2) and reverts the instant the button comes up, which is the only thing that lets someone notice before the setting is gone.

  **The reset goes back to double-click**, reversing the v0.0.56 model, on the owner's own reasoning: if a dial IS left tracking, clicking is the one reflex available to fix it — and a single-click reset made that reflex the most destructive act available. A single click now does nothing at all. His original objection to double-click (motor control) has not gone away and is answered by Backspace/Delete, which stays and is documented as an equal route rather than an afterthought.

  **The span between the two ends is filled** with the indicator's own colour at 50%, replacing a thin accent rule at 35% that read as a third mark rather than as the region the value lives in. **The live-value mark runs from the centre to the rim** as a thin line, instead of a six-pixel tick at the edge that was easy to mistake for a tick mark.

  **The guided tour was wrong and is now right.** It still taught double-click reset four versions after that gesture was deleted, and never mentioned the horizontal drag at all. The owner asked for a standing rule off the back of it — docs, including the in-app tour, change in the same commit as the behaviour — and that rule is now written down.

  Two protocol fixes in the same pass, both his: the fromClaude channel carries **one action per number** (six things had been bundled into one), and nothing is ever appended to a number he has already started reading — new work gets a new number that **names the build it landed in**.

- [x] **v0.0.59b — the onset click measured, the fullscreen chrome, and rows that split evenly** — the second half of the run, after the loop was restarted for having stopped on an exit reason that was not real.

  **The note-onset click, measured rather than deferred.** "Nobody in the container can hear it" was filed as a reason not to work on it, and that was wrong: a click is a step in the sample stream and a step has a size. `tests/onset-render.mjs` imports the built voice library into a real browser, plays a note through `VOICES[track][id].play` — the same function the engine calls, not a reconstruction — and reports the largest sample-to-sample step at the onset against the largest in the note's own body. Two hypotheses died. **The diagnosis previously written into TODO.md was wrong**: it said `fingered`'s filter envelope "snaps to full in 8 ms with `envAmount: 1`", but `envAmount` is pitch tracking, not an envelope — there is no filter ADSR to slam, and following that note would have cost an afternoon. And there is no step at an isolated onset at all: `fingered` and `sub` both measure a ratio of 1.00, because the amplitude envelope starts at `SILENCE` and ramps exponentially. So the click is an interaction — a release tail, a legato takeover, or the sum of several tracks — and TODO now points there. A follow-up commit retracted a "second note rendered silence" lead from that same investigation after checking it: `fingered` renders an identical peak at every duration from 1 s down to 60 ms. The zero was a measurement window, not the product.

  **Full screen clears itself properly.** The oscilloscope's legend and spread control stayed on screen for the whole of full screen: the scope module is *moved* into the stage rather than re-rendered there, so its overlay travelled with it and the 2.6 s auto-collapse never touched it. One flag on the stage, set by the same function that collapses the bar, so the two cannot fall out of step.

  **Voice-editor rows split evenly.** `.knob-row` used `auto-fill`, which packs as many columns as fit — six at the editor's width, so the Source row's seven dials rendered 6 + 1. Four fixed columns now, two below 520 px: 4 + 3, then 2 + 2 + 2 + 1. The measurement corrected itself on the way — the first probe said 5 + 1 + 1 because the Osc-2 toggle is 34 px tall against the dials' 109 px and took a different box top while sitting on the same line, which is a trap the TODO note now names for whoever measures a row next.

- [x] **v0.0.59 — Back, Poly | Mono, a real fader law, and two genres researched** — the second half of the "compile and complete all the TODOs" run.

  **Back.** Next has always been destructive — it recompiles the genre at a fresh seed or re-rolls the current params, and the setup it replaced was gone, with no history kept anywhere. There is a 24-deep snapshot stack now, pushed by the two gestures that replace a whole setup at once (Next, and picking a genre) and by nothing else. Deliberately not a general undo: a stack over every dial move is a much larger feature, and a button that sometimes undoes a dial and sometimes a whole piece would mislead. The tooltip says so, and Back disables itself at the end of the history.

  **Poly | Mono.** The Mono control was one button captioned "Mono", distinguished only by fill-versus-outline — which says nothing about which state you are in as opposed to which state pressing would put you in, and the caption never changed either way. Now a segmented pair on the same rule as Universal | Per instrument.

  **The volume dial gets a fader law.** The consult measured its top three 10% steps at 1.97, 1.74 and 1.56 dB against a 2 dB audible floor. The smallest step anywhere is now 4.00 dB and none falls under the floor. **The TODO's own suggested fix would have made it worse** — an exponent nearer 1.5 lowers the top step rather than raising it, because a power law gives 0.916·n dB there. The fault was the power law itself: dB = 20n·log₁₀(t), so a step near the top is a small ratio however n is set. Replaced with what a console fader does — dB linear in travel, in two segments, 20 dB over the top half and 40 over the bottom. `params.volume` is untouched, so a stored preset plays at exactly the loudness it always did; only where the thumb sits for it moves.

  **Minimalism and New Age, researched rather than guessed at** (brain2 `Ambi4-genre-research-minimalism-new-age`). Two different answers. New Age matches its genre definition on every point measured — tempo, all-major modes, near-static harmony, a 0.6 extension bias giving the major sevenths that ARE "light melodic harmonies", and flute / bells / choir voices — so the verdict on it is taste, not accuracy, and the recommendation is to spend nothing. Minimalism has the whole surface right and is missing the one thing that defines it: **process**. Phasing and additive transformation are not variation, and the engine has only variation. Reclassified from "needs a voicing pass" to "needs a process mechanism", with two costed candidates that would serve more genres than this one.

- [x] **v0.0.58 — the explanations, the labels and the scales** — three clusters of TODO items that had accumulated because none of them was individually big enough to be a version.

  **Four things that were never explained.** Structure gets a ⓘ with one line per option and what a Custom block means; info boxes are `white-space: pre-line` now so a list reads as a list. The three-word link name gets one saying that the preset name and the words are independent, that renaming does not change the words and that editing any setting does. The Custom builder's two controls are labelled — "bars" and "intensity", with a live percentage — after the owner reported he could not identify them: both carried an `aria-label` and nothing a sighted user could read, and the full-width BPM slider sitting immediately above made an unlabelled range control actively misleading. And the preset-submission terms go in behind a ⓘ beside Submit, in the owner's own words with nothing reworded. **The anonymous checkbox ships in the same commit because the terms refer to it** — publishing terms that describe a control the page does not have would be worse than publishing none. The legal-tone read before public release is still open.

  **Fifteen scales, in two groups.** Six added to the engine: blues, harmonic minor, melodic minor, locrian, diminished (whole-half octatonic) and chromatic. Additive only — no key changed, so every stored preset and share link keeps its scale, and `audio-reference` is unchanged across all 24 configs. The list is a short primary set plus Other as two `<optgroup>`s, the HTML convention for this rather than an invented reveal. Each is named for the scale it is rather than for a region, and the label stays "Scale" because the list is mixed. Maqamat, gamelan and ragas are deliberately still absent, with the reason written beside the table: they need the pitch pipeline rebuilt around cents or ratios, which is the alternate-tunings item.

  **One quiet structural fix.** The page probed a hand-written list of "the new modes" and appended them at runtime while the markup carried the rest — an arrangement that had already begun duplicating three options as the markup grew. The build-time list is the single source now and the probe only ever takes away, pruning any scale the engine rejects and any group left empty by that.

- [x] **v0.0.57b — the tempo A/B, and Simple teaches the gesture it just learned** — two more of the owner's own questions, answered as built behaviour rather than as prose.

  **"Should only the Simple dial get next-beat quantisation? Advanced users would rather it sounded better than immediate. Let's try that for now if easy and I can AB them."** New engine param `tempoLanding`: `beat` re-reads tempo every pulse so a change is heard within one beat, `bar` waits for the barline, which is musically tidier and is what every build before v0.0.48 did. Simple's Energy macro writes `beat`; the Advanced Tempo dial writes `bar`. Turning one dial against the other is the A/B, and it needs no switch to run. Both directions have their own engine test measuring the interrupted bar — 4.00 s under `bar`, cut short under `beat`.

  **The Simple tab teaches the spread gesture, once.** Two instructions had to be reconciled: "give a message instead" on Simple (27 Jul, out of a worry that a horizontal drag would confuse new players) and "everything should be spreadable with horizontal drag" (28 Jul, which is the consistency principle). The gesture works everywhere and Simple explains it the first time it happens — which answers the worry without teaching anybody that a gesture does nothing. The line holds its slot for seven seconds against the v0.0.51 effect announcements, which were overwriting it a tenth of a second later because opening a spread on Energy also moves complexity.

  **Two latent span bugs the tests found on the way.** `syncUIFromSettings` pushed every stored param back onto its dial through scalar mappings, so a spread `bpm` became `NaN` and `knob.set(NaN)` silently kept the old number — a spread that collapsed a moment after being made, on preset load and share arrival. And the Energy macro mapped only its tempo half through the span, feeding `NaN` into the complexity half. Both mapped properly now. The Processor dial is opted out of spreading: five named tiers, and `setProcessorTier` takes one of them, so a span would round silently.

  `tests/dial-drive.mjs` grew to 18 checks and got two corrections of its own, both of which had made it pass or fail for the wrong reason: every interaction now scrolls its target into view before reading coordinates (`page.mouse` is viewport-relative, so a dial below the fold receives a drag delivered to nothing, which looks exactly like a dial refusing the gesture), and dial lookups are scoped to the visible panel (Volume exists twice, and the unscoped lookup was aiming at the hidden Simple copy). The Simple teaching check now taps the hub first, because Energy arrives already spread from the Tempo drags above and widening a full-range span emits nothing at all.

- [x] **v0.0.57 — Universal | Per instrument, and a sweep for text a box cuts off** — the toggle the owner asked for on 2026-07-27 and named again on 2026-07-28 ("I know I don't have the universal dial implementation"). It sat unbuilt through five versions because the TODO line listed five dials and carried two `[flagged]` notes, which made the whole item read as blocked. Both flags are now resolved rather than waived.

  **Three of the five cannot have it, and saying so is the fix.** `repetition` drives one hook and one motif bank per piece; `reverbTail` drives one shared convolver. A per-instrument version of either is a new engine feature — per-track sends, per-track convolvers — not a toggle. Randomness has been per-track since v21 via Variation. That leaves Swing and Complexity, and those two are built.

  **The mechanism was already there and simply invisible.** Every track's editor has carried its own Swing or Density dial since v21, with an auto detent at the bottom writing `null`, and the engine reads null as "follow the global dial". What was missing was any way to see from the global dial whether it was being followed, and any way to switch every track at once. So the control is a readout as much as an input: moving a single track's own dial off its detent flips it to Per instrument by itself, because that is what has become true. Switching TO Per instrument seeds every applicable track with the value it is playing right now, so nothing changes audibly at the moment of the switch — it only becomes editable. Switching back to Universal writes null everywhere, which does change the sound; the two directions are deliberately not symmetrical.

  **The layout flag** — "wider than the dial it governs" — is answered by styling it as a third caption rather than a button: 10 px, sentence case, no letter-spacing, hairline divider, no filled pill (a filled half on a 10 px control beside a dial face reads as a lit indicator, i.e. as something the engine is reporting rather than a choice the user made). That fits 147 px into a 143 px four-column cell with a 2 px bleed into the gutter — the same rule the v18 dial contract already applies to a long readout.

  **`.vibe/measure.sh` gained a third sweep, because the first two both missed a real fault.** The uppercase first cut of this control was clipping "Per instrument" by 8 px inside its own `overflow: hidden` group, and both the collision sweep (which skips ancestor/descendant pairs, correctly) and the overflow sweep (which only looks at text leaves, whose own boxes were the right size) reported clean. `clipped` walks containers that cut and names the child they cut and by how much. The collision sweep also stopped crying wolf: a wrapped inline's bounding box is the union of its line boxes, so the footer's two-line licence link was "colliding" with every sibling on the first line — comparison is now line-box by line-box, and all five viewports read zero across all three sweeps.

  `tests/scope-drive.mjs` — ten checks in a real browser, including that both options are always shown (never one button that swaps its own label, per the owner's wording) and that the readout half works. Its per-track half opens every editor until it finds one with a Swing dial rather than assuming the first, after the first cut reported "skipped" and left that contract untested while still reading green.

- [x] **v0.0.56 — every dial answers the same four gestures, and the spread is real all the way down** — the owner's 2026-07-28 instruction was "go ahead and build the dials that you think will work best. Everything should be spreadable with horizontal drag."

  **The gesture model.** Drag up and down for the value, left and right for the spread, tap the centre to reset, type in the readout for an exact figure. Axis lock is Scheme A, as ruled on 2026-07-27: nothing moves until the pointer has travelled 6 px, the larger of |dx| and |dy| at that moment wins, and bringing the pointer back within 4 px of the origin re-arms so one press can change its mind. The diagonal-does-both idea stays rejected — a knife-edge band that ordinary drift falls out of.

  **Where the press lands decides what the vertical drag moves**, which is what finally makes an asymmetric span like 20–30% reachable: the centre hub carries both ends together keeping their width, anywhere else grabs the nearer end alone by sweep angle. "Nearer" is a half-plane test, not a hit target, so there is nothing small to miss with a thumb. Push-through survives — an end driven past the other carries it along rather than wedging.

  **Deleted: double-click, click-to-toggle-range, and the inside/outside-face zone scheme.** The owner's ruling was that a double-click is a gesture nobody with a motor-control difficulty can rely on producing, and that a single and double click meaning different things is a trap. A tap on the hub resets with no timing requirement at all; a tap anywhere else is inert rather than destructive. Keyboard gets the same two powers it was missing: Shift+Left/Right narrows and widens the spread (a keyboard user could not previously CREATE a span at all), Backspace/Delete resets.

  **A dial at its ceiling still spreads.** The first cut opened spans symmetrically about the value and therefore did nothing whatsoever on a Volume or a Reprise sitting at 100% — silently, on exactly the dials someone is most likely to want variation from. A span at a bound now grows one-sided and keeps the width the gesture asked for.

  **Zeroed and live states.** A dial at its own minimum with no spread draws its pointer and hub in muted grey, so "off" is legible across a panel without reading a single number (the owner's "make zeroed a muted version of the dial"). Inside a span, a bright tick marks where the value actually is this bar, fed from the existing 4 Hz `getResolved()` poll — a span whose drift cannot be seen is a control with no feedback.

  **The engine half, without which the rest would be a lie.** The seven global dials wrote plain numbers: `NUMERIC_RANGES` accepted no spans, so a spread on Tempo or Swing would have been a gesture the engine discarded. Any of those keys now takes `{min,max}`; the span is stored beside the value in `params.spans` and walked into `params[key]` once a bar on the same bounded reflecting walk the per-track ranges already use. `params.bpm` stays a plain number at every one of the dozens of places that read it, which is why this did not need an audit of all of them. Volume and reverb tail are pushed into the audio graph when the walk moves them; the power governor's cap applies to both ends of a spread tail. `getResolved().globals` reports the drifting ones, and only those.

  **Spreadable is now the default** — a caller opts out, never in. Five dials do: Octave, filter Type and the two shape morphs are enumerations the engine itself names as unrangeable, per-lane Feel is an enumeration of named grooves, and track Glide and Drift rate are plain numbers in the engine (Drift rate is also the rate at which every other spread walks). Every main dial gained the third tooltip line — `↔ Vary the tempo` and its equivalents — which ships *with* the gesture and not a version before it, since a tooltip advertising a drag the dial ignores teaches the user the control is broken. On touch screens the small dials go up to 88 px so the hub is a real target rather than a notional one.

  **Verification.** `tests/knob-gesture.mjs` (35 assertions) specifies the contract against a mock DOM carrying real geometry — written before the rebuild, as the ladder asked. `tests/dial-drive.mjs` (14 checks) drives real pointer gestures on the built page in headless Chromium and proves the whole chain: the drag opens a span, the readout shows it, every main dial answers, a tap resets, and all seven spans reach local storage. The thirteen tests in `knobscope-smoke.mjs` that described the deleted gestures were rewritten rather than dropped. `audio-reference.mjs` is unchanged across all 24 configs, so nothing here alters how an existing preset sounds.

- [x] **v0.0.55 — the Stop key actually stops, and the Randomise row stops smearing** — two owner reports from the fromMartin channel, both reproduced and both fixed with a mechanical witness rather than a screenshot.

  **"It doesn't appear to do anything."** True, and the cause was a stale line rather than the stop logic. v0.0.41 deleted the separate Stop key and made Play/Finish the whole control — Play → Finish → Stop, with the second press cutting the outro short — and wrote that second press inside `finishOrStop()`. But the click handler above it still opened with `if (finishing) return;`, a guard that made sense when a separate Stop key existed and re-entering the button could only have meant "finish again". So the branch was unreachable: the caption changed to Stop, and pressing it did nothing while the 8-second outro played on. The guard is gone; the handler now routes a press to `finishOrStop()` whenever the engine is running, paused **or** finishing.

  **The icon never swapped.** The button carried two glyphs, ▶ and the final barline 𝄂, for three captions — so "Stop" was drawn beside the finish glyph. It has its own square now, one glyph per caption.

  **The overlapping text**, found by measuring rather than looking: inside any track's editor, the four Randomise dials read `Auto (follows Randomness)` at the Auto detent. That readout renders 148 px wide in `.vary-knob` cells that are 84 px on a 92 px pitch, and the v18 dial contract deliberately gives readouts `overflow: visible` so a long value bleeds into a gutter instead of pushing the dial faces out of line — with no gutter here, each caption was painted 56 px over both neighbours and the row read as one smear. The detent now reads `Auto`; what it follows is already the first thing the dial's tooltip says.

  **New: two verification tools, because "I looked at a screenshot" is how all three of these shipped.** `.vibe/measure.sh` runs real JS in the same headless Chromium `shot.sh` photographs with — `overlaps` sweeps every visible text leaf for collisions and overflow and prints the rects, `box`/`eval` measure on demand, and `drive` ships a local `.mjs` over to script the page. `tests/transport-drive.mjs` is the first of those: eight assertions over the full Play → Finish → Stop cycle, including that the stop lands in under two seconds rather than at the end of the outro. Proven to fail on the pre-fix code before being trusted.

- [x] **v0.0.53 — the sound gets a frozen reference** (7b7e61a) — tests/audio-reference.mjs digests eight settled bars of every factory preset and stock genre at a fixed seed (note count, track set, sha256 over quantised note tuples) against a committed baseline pinning v0.0.52's sound. Any commit that deliberately changes how presets sound regenerates the baseline in the same commit and says so; drift without that declaration is a regression. 24 configs, ~13 s, determinism proven byte-identical across runs; the drift path proven by deliberate tamper before being trusted. Built ahead of the consult tuning follow-ups on the ladder's own "before any version that changes how existing presets sound" rule.

- [x] **v0.0.52 — the Energy dial gets measured** (357c63e) — the consult's §D suite (tests/energy-measure.mjs): monotonicity across the sweep PASS; tempo 0.96 s and volume 0.15 s inside their latency budgets; two targets measured honestly SHORT and gated behind ENERGY_MEASURE_STRICT=1 with follow-ups filed in TODO § Consult follow-ups — Energy's complexity half is swallowed by the frozen plan for ~2 bars, and a quartile of Energy travel moves the piece no more than the structure preset's own intensity envelope already does (~1× against the 3× perceptibility target). Also measured: the volume taper's top three 10% steps sit under the 2 dB audible floor, and the track ladder saturates by Energy 0.5.

- [x] **v0.0.51 — the dials say what they just did** (6b9ef7a) — consult C5: a three-second plain-English line under the Simple dials names each discontinuity as it happens ("Percussion joined", "Now moving in longer waves"), computed by diffing the pure engine deciders (autoActiveTracks, resolveStructure) around every complexity-bearing commit; the affected track's lamp blinks at the same moment. Reserved space, no reflow; no confirmation sound by design.

- [x] **v0.0.50 — Simple asks three plain questions** (dd8176f) — the consult's dial set: Energy / Change / Volume. Energy is a real macro (bounded 42–124 bpm log sweep + a piecewise complexity map spreading the audible thresholds evenly; double-click rests at 0.35 = 61 bpm so the default sound is unchanged); Tempo and Complexity become Advanced component views that visibly follow it. Change is the fused macro renamed, with a snapped bottom detent for the hold (repetition 0.90 there — a mid-length hook, not an endless loop) and randomness 0.15–0.85 decoupled from strict 1−x; sub-floor genre values read just-above-Never, never as a hold. Volume reads % on Simple, dB on Advanced. Structural commits ride a 120 ms trailing debounce (C8) so a drag can't shred the banks.

- [x] **v0.0.49 — Total joins the legend, and full screen goes bezel-free** (f1b020d) — Total reads as one more legend entry, after Percussion, ALLCAPS, white dot; double-click shows the mix alone, mirroring track solo. Full screen drops page background and stage padding (black edge to edge, incl. the iOS pinned fallback; viewport-fit=cover), hides the collapse twisty, and the scope overlay clears the menu bar it previously sat behind. Verified on rendered shots.

- [x] **v0.0.48 — a tempo change lands on the next beat** (02d7927) — the other consult engine defect: secPerBeat was bar-snapshotted, so a bpm change waited up to a barline (12 s at the slow end) — far past gesture-attribution. tick() now re-reads tempo per pulse (only LOOKAHEAD is committed); harmony, swing and structure stay bar-quantised. The new engine test measures the interrupted bar: exactly 4.00 s on the old engine (red), early completion after (green).

- [x] **v0.0.47 — the volume dial gets its own effect back** — the first of the two engine defects
  the psychologist consult turned up, and a real one.

  The listening-level fader was `master.gain`, which sits *inside* the glue compressor
  (threshold −18 dB, knee 24 dB, ratio 3). That soft knee spans −30 to −6 dBFS, which is exactly
  where this material sits, so the compressor ate a large share of every fader move —
  differentiating the knee, roughly 28% of it lost at −20 dBFS programme and over half at −10.
  The dial was weakest precisely where people actually listen. It also meant the compressor's
  glue behaviour changed with the volume knob, which is a second bug hiding inside the first.

  A gain node now sits *after* the compressor and carries all level automation — the volume
  target, the start and stop fades, the outro, and the live-chain open. `master.gain` becomes a
  fixed headroom trim that nothing automates. The master analyser deliberately stays on the
  compressor: the scope should show the music, not how loud it is being played.

  *Taper*: loudness roughly doubles per +10 dB, so perceived loudness goes as gain^0.6 and a
  linear fader is compressive — the top half of the travel barely changes anything. Dial position
  is now `position^1.7`, so half travel is about half as loud. This is a UI mapping only;
  `params.volume` is stored and sent exactly as before, so every share link and saved preset
  sounds identical.

  *Test*: the v26 routing check asserted the output route leaves the compressor. It now leaves
  the post-compressor gain, so the test follows the corrected graph — and it still proves the tap
  hangs off the compressor, which is now a genuinely different node.

- [x] **v0.0.46 — track labels, paired harmony rows, and a consent notice that actually informs**

  *Track labels*: `.track-name` was a fixed 84px, narrower than what it holds. "Percussion"
  overflowed it and rendered as "Percussio", and the `— off` suffix pushed the longer labels onto
  a second line inside the button, so a switched-off Arp read as "Arp —" over "off". Wide enough
  for "Percussion — off" now, with `nowrap`, and still fixed so the voice pickers stay aligned
  down the column.

  *Harmony rows*: Root and Scale share a row, Time signature and Chord length share the next.
  Six full-width selects stacked down the page for values two or three characters wide was most
  of what made Advanced feel long and empty. The BPM slider went with them — it was a third view
  of the tempo the dial already owns, with `setTempo` driving all three. Its standalone readout
  went too, since the dial prints "52 bpm" under its own face and is click-to-type in its own
  right. Both references are guarded rather than deleted outright.

  *Consent*: the mechanism was already sound — nothing reaches localStorage before consent, and
  the choice is recorded in a first-party cookie that is itself the strictly-necessary kind. The
  WORDING was not. "Remember your settings and presets on this device?" gives the purpose but
  never says what is stored, never mentions that answering sets a cookie at all, and never links
  the privacy page — so the consent it collected was not informed. `consentPrompt` now takes
  `{ message, detail, privacyUrl }` (a plain string still works) and the notice says what goes
  into local storage, discloses the cookie set either way, states that nothing is uploaded and
  there is no tracking, and links Privacy.

  *Test*: page-boot's genre checks read the tempo off the Tempo dial's readout now that the
  slider is gone — the bpm-range assertions are what prove a genre's declared tempo reaches the
  engine, so they were worth keeping a reader for rather than deleting with the input.

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
