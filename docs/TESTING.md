# Ambi4.work — manual release test (~15 min)

## Automated gate before any of this: the page boot test

The generator page has shipped blank twice (a crash inside its init, invisible to
`astro build` and to the module smoke tests). It now has a permanent regression
gate that executes the BUILT page bundle in jsdom with stubbed audio and asserts
the app unhides:

```
npm run build && node tests/page-boot.mjs
```

Green = the page boots against today's modules. Red = do not deploy; the failure
line quotes whatever init threw. Run it after ANY change to `src/pages/index.astro`
or to a module the page imports.

It also asserts the placement rules, which are markup `astro build` cannot see:

- v16 — the factory-preset gallery renders on the Simple tab BELOW the dials,
  with at least one preset card built from the build-time list. An empty gallery
  means the preset payload never reached the page.
- v18 — the oscilloscope sits ABOVE the tab strip and above the piano roll (not
  inside the Simple panel), carries no panel title, keeps the word
  "Oscilloscope" hidden while it is expanded, and has a populated legend even
  with the engine stopped.
- v26 — the oscilloscope has no `.module-panel` faceplate and its chrome
  (note, legend, options, fullscreen button, twisty) sits in an overlay OUTSIDE
  the collapsible body, so collapsing cannot take the twisty with it; both
  displays carry a fullscreen button and the fullscreen host is in the
  document; Repetition, Swing and Reverb tail share the Advanced main-dial
  row; switching Osc 2 off hides the Mix dial and switching it back on
  restores it; and the percussion editor keeps its feel dials on ONE row.
  jsdom implements no Fullscreen API, so the page hides both ⛶ buttons there —
  the gate proves they are in the document, not that they are visible.
- v19 — selecting Texture's "Coloured noise" voice and opening its editor builds
  at least ten patch dials, in Spectral / Motion / Bursts sub-rows. A voice can
  declare fields in its `controls` table that the editor's builder does not know
  about; nothing else notices, the dials simply never appear.
- v12 — the texture editor's header carries the Mono toggle and the Glide dial
  (both probed against `getParams()` before they render).
- v21 — the percussion lane list (High first, Low last), "Add lane" copying the
  neighbouring lane's pattern, click-to-type renaming, remove-proof built-ins,
  the per-track Swing/Density dials and the per-step note length. Each of these
  is asserted ONLY where the engine's own sanitiser accepts the param behind it
  — the gate runs the same probe the page does, so it starts demanding the
  control the moment the engine lands the param, and accepts its absence before
  then. A dial that renders against an engine which drops the param is also a
  failure: a control that does nothing is worse than no control.
- Iteration 4 — same probe-gated discipline as the v21 bullet above, applied
  to three more surfaces: the Scale select gains Ionian/Mixolydian/Phrygian
  options only where `mode` accepts each one; the Chord length select (near
  Structure) shows only where `harmony.rhythm` survives the sanitiser; and the
  pad editor's Breath knob shows only where `tracks.pad.padBreath` does — and
  never on any other track's editor.
- v21 track registry — the track rows are the ENGINE'S list, not the page's:
  their count, their order and their labels are asserted against `getTracks()`,
  so a page that grew a track list of its own again fails here. The one
  hardcoded table the page keeps — `FALLBACK_TRACKS`, the branch an engine
  bundle without `getTracks()` boots on — is read out of the page source and
  matched against the live registry 1:1: ids, order, labels, families, and the
  tuned/sequenced sets derived from it. Nothing else exercises that branch, so
  a fallback that has drifted from the registry would otherwise sit there
  silently waiting to boot the wrong six tracks.
- v26 genre transport — the genre picker under the Play key holds every file in
  `src/data/genres/` plus "Surprise me" and the favourites entry; a fresh boot
  (which is exactly what this harness is) opens ON a genre, with params inside
  that genre's declared ranges rather than at the engine defaults; picking a
  genre compiles it into the live params; loading a factory preset clears the
  tag; the favourites editor covers the whole set, a favourite adds its mood
  group to the list and the hide toggle prunes it; and the Pause button's
  explanation is matched against whether the engine build really ships
  `pause()` — the same probe-gated discipline as the v21 bullet above.
- Fresh install — this harness boots with empty storage and no consent, which is
  every first-time visitor: nothing is persisted before consent is granted, every
  track row builds a randomness control, and no dial read-out comes up NaN
  (the failure mode when a param arrives as a `{min,max}` range default).
- Guided tour — every step of `TUTORIAL_STEPS` rings a control that exists,
  exactly once, in the BOOTED document, and switches to a tab the page has.
  This is the half `tutorial-smoke` cannot reach: the targets the page script
  builds itself (Add track) are absent from the markup.

## The suites

Every one runs on a bare `node`, no bundler and no test runner. Counts are as of
v0.0.33 — a suite that suddenly reports fewer checks has lost tests, which is a
failure in itself.

```
npm run build && node tests/all.mjs   # EVERY suite below, non-zero if any is red
```

`tests/all.mjs` discovers the suites, so a new one is run the day it lands. It
replaced a list in this file that was run by memory — which is how `voices-smoke`
sat red for ~30 versions and `power-smoke` since the Node 22 move, both unnoticed
(audit, 2026-07-31). Individual suites still run by name:

```
node tests/engine-smoke.mjs        # engine core against a mock AudioContext
node tests/voices-smoke.mjs        # the voice library
node tests/genre-smoke.mjs         # genre compiler + every genre played
node tests/knobscope-smoke.mjs     # knob.js + scope.js
node tests/visualiser-smoke.mjs    # piano roll
# blocks-smoke.mjs went with the block editor when the paid-tier code left
# this repository (2026-07-29). It lives with that code, not here.
node tests/power-smoke.mjs         # the governor
node tests/prefs-smoke.mjs         # consent + persistence
node tests/share-name-smoke.mjs    # three-word link names
node tests/energy-measure.mjs      # the Energy dial's own measurements
node tests/content-check.mjs       # playlist frontmatter against the schema
npm run build && node tests/tutorial-smoke.mjs   # the guided tour
npm run build && node tests/page-boot.mjs        # the built page in jsdom (above)
```

Counts are deliberately NOT listed here any more: they moved every session and a
stale number reads as a lost test. `tests/all.mjs` prints each suite's own count.

### The browser drives

Everything above runs in Node against mocks. The drives run against the BUILT
site in a real headless Chromium on the Mac test account
(`docs/rendering-host.md`), one file per behaviour, each asserting at the
ENGINE seam (`window.__ambi4Engine`) rather than the DOM wherever a value has
an engine-side truth:

```
tests/sweep-drives.sh                    # every drive, RED vs FLAKY split
.vibe/measure.sh local drive tests/<name>.mjs
.vibe/measure.sh local overlaps          # three sweeps, ONE viewport per run
.vibe/measure.sh local overlaps 390 844  # …pass a viewport for the phone check
```

**Why the sweep script and not a shell loop:** run back to back, seven of the
twenty-eight drives failed and every one passed when re-run alone (2026-07-31).
The drives are honest individually; the waits are tuned for an idle Mac. The
solo re-run therefore RESTS (`SWEEP_SOLO_COOLDOWN`, default 20 s) and a drive
that still fails gets a second rested run before it is called red — a re-run
three seconds after thirty browsers is measuring the load that failed it. The
script re-runs each failure solo and reports RED (failed alone too — a real
regression, non-zero exit) separately from FLAKY (green alone — load), because
a sweep that cries wolf is a sweep that stops being run.

| Drive | Holds the line on |
|---|---|
| dial-drive | pointer gestures on the dials |
| spread-all-drive | every rangeable dial takes a spread, engine-verified |
| simple-tempo-drive | Simple's Tempo view moves engine bpm; beat/bar landing |
| create-drive | the Create door: blank slate silences (incl. FX), Zero buttons, seeding, tap-a-rhythm, silent-under-Play |
| play-along-drive | musical typing reaches noteOn/noteOff; typing guards; stays armed on close |
| popover-drive | popovers stay on screen at 1280 and 390 |
| latency-drive | desktop output routes DIRECT (no media-element hop); reports the context's latency floor |
| tie-merge-drive | ties render as one wide box; mass edit lands at the engine |
| transport-drive, undo-drive | the transport keys and ⌘Z/⇧⌘Z |
| sharelink-drive, provenance-drive, submit-drive | links, provenance, Submit |
| chordchip-drive, chordlength-drive, progression-drive | the chord loop editors |
| chosen-drive, pitch-drive, section-drive | the grid's engine readouts |
| loudness-drive, scope-drive, fullscreenbar-drive, driftshape-drive | output level, scope, fullscreen chrome, spread shapes |

Offline render harnesses (browser, `OfflineAudioContext`, measured not
listened to): `onset-render` (onset steps, slur chains, cancels, sums),
`wash-sweep-render` (the wash holds its band), `call-breath-render` (the call
is a rising whistle, alone).

`tutorial-smoke` reads `TUTORIAL_STEPS` out of `src/pages/index.astro` and checks
it against the BUILT page: every target resolves to exactly one element (an
ambiguous selector rings whichever came first, so two matches fail as loudly as
none), every `tab` is a tab the page renders, no two steps ring the same control,
the arc runs Simple → Advanced and closes on sharing, and the copy is non-empty,
plain text, UK-spelled and free of brand names. It carries its own mutation
checks — a bogus selector, an ambiguous one, an unknown tab, a duplicate target,
empty copy, a brand name, a US spelling and a step that sends a newcomer back to
Simple all have to be caught, or the gate is not a gate.

Tester: Martin, Mac (Chrome or Safari) + iPhone Safari. URL: https://ambi4.work (deploys from main ~2 min after push — check the commit you expect is live before starting). Start with device volume MODEST — new voices are untested at loud levels.

Worst-first within each section: if a step fails, note it and keep going.

## 1. Core audio — generator at `/`

- [ ] Open `/` — the generator IS the homepage (not the old listing page).
- [ ] Click Play — audio starts within ~1 s.
- [ ] Listen 60 s at defaults — pleasant, no clicks/pops/clipping, no runaway volume.
- [ ] Button now reads "Finish" — click it: current bar completes, resolves to the tonic, fades out over ~8 s, then state returns to stopped.
- [ ] Play again, use the "Stop now" affordance (small secondary control or long-press) — fast stop, ~0.5 s fade, no click.
- [ ] Tabs "Simple" and "Advanced" present; arrow keys move between them; visualiser stays visible on both.

## 2. Simple sliders (playing)

- [ ] Speed slider — tempo audibly changes AND the BPM field on Advanced moves with it (and vice versa: edit BPM, speed slider follows).
- [ ] Complexity ("Calm – Complex") low → sparse/drone-ish; high → busier, more tracks join. Moving it also resets structure/arp/track-states to Auto on the Advanced tab — verify.
- [ ] Repetition ("Random – Evolving – Repetitive") — each end audibly different over ~30 s.
- [ ] Volume slider — smooth level change, no zipper noise.

## 3. Tracks + voices (playing)

- [ ] Each of the six tracks (pad, bass, melody, texture, arp, percussion) has Off / Auto / On + voice select.
- [ ] Set a quiet track to On — it joins; set a loud one to Off — it drops. No glitch on switch.
- [ ] Switch pad voice Warm → Glass → Strings → Choir mid-play — new notes use the new voice, no click, old notes ring out.
- [ ] Sample at least one alternate voice per track — note any that sound bad/harsh/too loud (per-voice verdicts wanted, see Report back).

## 4. Voice editor (playing, pad easiest to hear)

- [ ] Open the pad voice editor. Drag ADSR attack long — new pad notes swell in obviously slowly. Drag short — percussive onset.
- [ ] Sweep filter cutoff down then up — obvious darkening/brightening of new notes.
- [ ] Reverb send 0 → 1 — dry vs washed. Delay send similarly.
- [ ] "Reset to default" restores the original sound.
- [ ] Edits apply to NEW notes only (no retro-change of ringing notes) — expected, not a bug.

## 5. Arpeggiator + structure (Advanced, playing)

- [ ] Arp track On, arp editor to Manual — pattern up/down/updown/random audibly differ; rate 1/4 vs 1/16 obvious; toggling steps off in the 16-step grid creates matching gaps.
- [ ] Structure select → Custom: build A(2 bars, low intensity) B(2 bars, high). Blocks audibly alternate sparse/busy every 2 bars. Add/remove/reorder buttons work.
- [ ] Structure Waves for 1–2 min — slow intensity swell/ebb.

## 6. Visualiser

- [ ] Six labelled lanes in track order pad→percussion.
- [ ] Notes appear in lanes matching what you hear (mute a track — its lane goes quiet); levels move with the audio.
- [ ] Stop — visualiser idles (static frame, no animation).

## 7. Longevity + background tab (start this, do sections 8–10 while it runs)

- [ ] Start playback, switch to another tab/app for 10 min. KNOWN RISK: background-tab throttling may gap the audio — listen for dropouts/stutters and report yes/no + browser. Audio should continue while hidden.
- [ ] After 10 min: still musical, no drift into noise, no memory-pressure stutter.

## 8. Sleep timer + alarm

- [ ] Set sleep timer, custom 1 min, while playing — countdown shows near Play; at expiry a musical Finish (resolve + fade), not a hard cut.
- [ ] Set alarm 2 min ahead (tab open, Mac awake, click Set = the arming gesture) — armed state + countdown show; at target time playback auto-starts. Inline warning about tab-open/device-awake is present.
- [ ] Cancel works for both.

## 9. Consent + storage (fresh private window)

- [ ] Open `/` in a private window. DevTools → Application → Cookies + Local Storage: nothing of ours yet (no `ambi4-consent`, no `ambi4:*`, no `ambi4-generator-settings-v2`).
- [ ] Move a slider (first save-worthy action) — inline ask appears ("Remember your settings…?"), an inline element, not a banner.
- [ ] Click "Save on this device" — devtools now shows ONLY cookie `ambi4-consent` + localStorage keys namespaced `ambi4:*`. No third-party cookies anywhere.
- [ ] Reload — settings persisted.
- [ ] New private window, repeat, click "No thanks" — settings still work for the session (change a slider, it holds), but nothing lands in storage; reload loses them; not re-asked this session.

## 10. Presets

- [ ] (Consented window) Name + Save a preset; change settings; Load it — settings restored. Delete removes it.
- [ ] "Submit preset" — copy-to-clipboard yields valid-looking JSON (paste somewhere to check). The contact.andeye.com tab will 404 — EXPECTED for now, the form doesn't exist yet.

## 11. Playlists + routes

- [ ] `/playlists/` — single page, playlists grouped by genre, service pill selector (YouTube / Spotify / Deezer / SoundCloud / Apple).
- [ ] Most services show "Not on X yet" — EXPECTED until playlist ids are supplied. Apple pills/embeds carry the lapsed-subscription note.
- [ ] Old URLs all redirect: `/generator/` → `/`; `/ambient/eno/`, `/classical/mozart/`, `/instrumental/xander/` → `/playlists/`.
- [ ] Header nav "Generator" / "Playlists" works both ways.
- [ ] Junk URL (e.g. `/nope/`) → proper 404 page.

## 12. iPhone Safari

- [ ] Open `/`, tap Play — audio starts. Note silent-switch behaviour (audio with switch on silent: yes/no).
- [ ] Sliders/tabs/track controls usable with a thumb; nothing overflows or clips off-screen.
- [ ] Finish works; lock the screen briefly — note whether audio survives (informational, not pass/fail).

## Report back

The six most valuable things to tell the orchestrator:

1. Any click/pop/clipping — with exactly what you were doing when it happened.
2. Background-tab 10-min result: gap yes/no, which browser.
3. Alarm fired on time yes/no; sleep-timer Finish musical yes/no.
4. Per-voice verdicts: which voices sound bad/harsh/mislevelled and need tuning.
5. Consent flow: anything persisted before you accepted, or after "No thanks"?
6. iPhone: Play worked? silent-switch result? any layout overflow?

## v6 delta (2026-07-25)
- [ ] Sleep timer now lives behind the clock icon by Play; "Schedule start" behind the alarm icon (tab-open warning appears only there). Both popovers: Esc closes, countdown chips show when armed.
- [ ] Melody and Bass now DEFAULT TO OFF - expected silence from them on a fresh visit; click a track name/state to wake them.
- [ ] Tracks list: per-track Level knob (click it to switch to a min-max drifting range, double-click resets). Random button, Hold toggle, Randomness knob per track.
- [ ] Step sequencers at the top of Melody/Bass/Arp/Percussion editors (Auto/Manual): click cells on/off, drag vertically for the velocity band, [ ] or , . for probability. Percussion has three lanes; the Arp lane length follows its rate.
- [ ] Voice editors open when a track row gains focus; only applicable knobs show per voice (e.g. Wash shows no oscillator section).
- [ ] Heat check: leave it playing 10 min - the machine should run much cooler than the previous build (30 fps visuals, no glow blur).

## v14/v15 delta — big UI pass (2026-07-25)

Transport strip
- [ ] The strip reads: ▶ Play (triangle icon), ■ Stop, ● Record, and — hard right — the clock and alarm-clock icons stacked, each about half the Play button's height. Popovers behave as before.
- [ ] Playing: the button reads "Finish" with a final-barline icon AFTER the word; the triangle is gone. Stop is greyed when nothing is playing and live when it is.
- [ ] Record: EXPECTED to be greyed with a tooltip saying recording arrives with the next engine update — the engine keeps its mixed output stream private, so the page cannot reach it yet. The MediaRecorder path is wired and lights up the moment the engine publishes a stream. (If your browser has no MediaRecorder, the tooltip says so instead.)
- [ ] All transport buttons show on BOTH tabs this build.

Simple tab
- [ ] FOUR dials now: Speed, Complexity, Randomness, Volume. Repetition has gone from Simple — it is fused into Randomness (and still has its own dial on Advanced).
- [ ] Each dial is labelled ONCE (under the dial), with end-marks at the tick extremes: Slow/Fast, Calm/Complex, Repetitive/Random, Quiet/Loud. Randomness also carries "Evolving" at the top of its sweep. No duplicated label row above.
- [ ] Randomness is ONE control for "how much does this change": turning it writes Advanced's Repetition (as its mirror, 1 − x) AND all six tracks' randomness in one go. Check on Advanced that Repetition moves the opposite way as you turn it.
- [ ] Randomness at 0 reads "Hold": perfect loop, tightest hook — set it to 0 while playing and the material should stop re-rolling. At 1 everything wanders.
- [ ] Hand-set Advanced's Repetition (or one track's own Randomness) to something inconsistent, then look at the Simple Randomness dial: it shows a blended average and must NOT have overwritten what you just set. Turning it again takes control back.
- [ ] Click the Randomness dial to switch it to a drifting min–max range: the range goes to every track's randomness, and Repetition takes the mirror of the range's midpoint (Repetition itself can't drift — the engine only accepts a single number there).
- [ ] Processor dial under the transport (Eco/Low/Med/Full/Auto) with a readout of the tier and note cap. Set Eco while playing: the machine should quieten down; the voice editor's scope drops to the static OFFLINE trace instead of the live one.

Tracks (Advanced)
- [ ] Order everywhere is pad, arp, melody, bass, texture, percussion.
- [ ] ONE row per track: coloured lamp + name, voice select, Level dial, Randomness dial, Edit. The Random button and the Hold toggle are GONE.
- [ ] Each row has its track's colour as a left accent bar and in its lamp.
- [ ] Clicking the lamp cycles off → auto → on and NEVER opens the editor. Turning a track off never expands or keeps open its editor.
- [ ] Close an editor with Edit, then Tab through that row: it must NOT spring open again. Pressing Edit again re-arms that behaviour.
- [ ] Off/Auto/On pills now live in the Edit panel header, next to a small dice button (re-roll that track).
- [ ] While playing, each row shows a live "level … · random …" readout and a thin cost bar in the track's colour.

Sequencer 2.0 (Edit panel of melody / bass / arp / percussion)
- [ ] Percussion lanes render High at the TOP, Low at the bottom.
- [ ] The sounding step lights white as it plays.
- [ ] There is a fat handle at the top of each velocity band — grab it and only the loud edge moves.
- [ ] Click-drag SIDEWAYS across cells: they merge into one long tied note (a bridge shows between them). Drag back to shorten. Keyboard: T on a focused cell.
- [ ] A row of dots sits below each lane, beside the probability bars. Click one to start a probability group (coloured, ringed while selected); click ANY other dots — gaps allowed — to paint them into it; click a selected member again to remove it; Esc drops the selection so the next click starts a fresh group. Keyboard: G on a focused cell, Esc to drop.
- [ ] Press Help me start: a question about the feel, then one about the genre, each with "Something else" last. Answering seeds that genre's voices, names the instrument its writers start with, and starts nothing playing. "Something else" twice offers every listed genre plus a no-genre way in; pressing the button again puts the questions away.
- [ ] Import a MIDI file you have to hand (Create → Import a MIDI file, picking an instrument): its notes appear as pinned steps on that grid, longer files become tabs played In order, and the line under the buttons says how many notes landed plus anything that could not fit (chords sharing a step, bars past eight, a different time signature).
- [ ] Under a melodic grid, press ÷2: the cells double in number, the readout names the note value (semiquavers → demi-semiquavers), and a step you draw on the fine grid sounds where you drew it. ×2 walks back up; the pair stops at crotchets and at hemi-demi-semiquavers.
- [ ] Press **Triplets**: the readout keeps the note value and adds "triplets" (semiquavers → semiquaver triplets), the bar's cell count goes to three where two sat (8 → 12 at quavers in 4/4), the beat marks still land on the beats, and a step drawn there sounds where you drew it. ×2 / ÷2 now walk the triplet values; pressing Triplets again returns to straight time at the same value.
- [ ] Untie a tied note (T on its head), then confirm the two steps really play separately — the untie must reach the engine, not just split the boxes.
- [ ] On a melody or bass step: P, type C#5, Enter — the cell shows a small C#5 tag and that step plays exactly C#5 every bar (never re-pitched by the chords). Alt+drag the cell up/down nudges the pin by semitones; P then Enter on an empty box clears it.
- [ ] "+" adds a second sequencer (a copy). Tabs 1 / 2 appear, plus a Weight box — how likely the others are to hand over to this one at loop end.
- [ ] The long key legend has moved behind the small ⓘ next to "Step sequencer".

New dials
- [ ] Repetition now lives on Advanced (Random ← Evolving → Repetitive) and still works on its own.
- [ ] Swing appears on Advanced (global, Straight → Swung). Set it high with percussion on: an audible shuffle.
- [ ] Every tuned track's Edit panel has a Dissonance dial (0 = strict to the chord). Push melody's up and it should stray.

Everything else
- [ ] Shape 1 / Shape 2 readouts show a LIVE mini-waveform of the exact morphed shape, redrawn as you turn. Hovering a waveform mark on the tick ring shows what that shape sounds like. (The short text name stays beside it — it is what screen readers announce.)
- [ ] Hovering or Tab-focusing a compact control shows a themed tooltip (not a native title); Escape dismisses it.
- [ ] "?" beside "Transport" opens a docked guided tour on the right; Next/Back walk seven steps, each highlighting the control it describes and switching tabs as needed. The open state survives a reload.
- [ ] Click the BPM number: it becomes a text box. Enter commits, Escape cancels.
- [ ] Factory presets row (8 of them) on Advanced. Load one — everything changes and stays fully editable. Your own presets sit below, unchanged.
- [ ] Melody now DEFAULTS TO AUTO (it used to be off); bass is still off by default.
- [ ] Regression sweep: consent ask still appears on the first save-worthy change in a private window; save/load/delete/submit presets still work; sleep + alarm popovers unchanged; lock-screen transport keys still work; settings still persist across a reload.

## v15 delta — front scope, share links, kit editor (2026-07-25)

Front-page oscilloscope (Simple tab, under the piano roll)
- [ ] An "Oscilloscope" panel sits between the piano roll and the dials, with a
      row of six coloured track chips under the canvas.
- [ ] Press Play: one trace per selected track, each in that track's colour,
      sharing one grid. A silent track draws nothing (not a flat line).
- [ ] Chips toggle: click Percussion off — its trace goes; click it back on — it
      returns. Default selection is every track that isn't switched off, so a
      track you set to Off drops out of the scope by itself.
- [ ] Click the "Oscilloscope" heading to collapse the panel; reload — it stays
      collapsed (and your chip selection survives too).
- [ ] Switch to Advanced, or set Processor to Eco while playing: the trace stops
      (the note beside the heading says why). Back to Simple / a higher tier
      restarts it.
- [ ] Scroll the panel off screen while playing: no frames are drawn while it's
      out of view (heat check — the machine should not warm up with it scrolled
      away).
- [ ] If this build ships against an older scope.js, the whole panel is absent
      rather than dead — expected, not a bug.

Share links (Advanced → Your presets)
- [ ] "Share" copies a link to the clipboard and confirms on the button. Paste it
      somewhere: it starts `https://ambi4.work/#p=` and is a few KB long.
- [ ] v29 link name: the "Link name" line under the Share row fills with three
      words (`misty-harbour-lantern`), the note names the same three words, and
      the Preset name box — if you left it empty — is filled with them too. A
      name you had TYPED is left alone. Share the same setup twice: same name.
      Change a dial and share again: a different name. Nothing above the line
      moves when the name appears.
- [ ] Open the link in a fresh window: the shared settings are live BEFORE
      anything is drawn (dials, tracks, sequencers, voice patches all match), a
      note reads "Loaded misty-harbour-lantern — this link's name. Save to keep
      it" with the SAME three words the sender saw, and the `#p=…` has been
      stripped from the address bar. Reload: your own stored settings are
      back — a shared link is a visit, not a takeover, until you Save it.
- [ ] Mangle the fragment (delete some characters) and open it: the page boots
      normally on your own settings, no error shown. Silence is correct here.
- [ ] The link never carries code — only params (per the v10 boundary). If the
      clipboard is refused, the link is printed in the note to copy by hand.

Kit editor (Percussion → Edit)
- [ ] Above the dials: Common | High | Mid | Low. Common is the whole kit's
      sound and behaves exactly as the voice editor always has.
- [ ] Pick High: the same dial set appears, each dial carrying a small
      "common …" read-out beneath it (that is the ghost — knob.js draws only one
      pointer, so the common value shows as a coloured-dot read-out rather than
      a second pointer on the face).
- [ ] Move a dial on High: it takes the track accent ring and a "follow" button
      appears. Mid and Low are untouched — check by switching tabs.
- [ ] Press "follow" on that dial: the override goes and the dial returns to the
      common value. The button at the foot reads "Clear High overrides" on an
      instrument tab (it clears only that instrument) and "Reset to default" on
      Common.
- [ ] Overrides persist across reload and travel in presets and share links.
- [ ] EXPECTED until the engine's own pass lands: per-instrument overrides may
      not be audible yet — the engine plays the common patch and ignores
      `perKind`. The editing, persistence and capture are all live now.

Dials
- [ ] Simple reads Tempo / Complexity / Randomness / Volume (was Speed and
      Master volume). Each name appears ONCE, under its dial — nothing repeated
      above it.
- [ ] The same four dials sit at the foot of the Advanced tab under "Main
      dials". They are views, not copies: turn one, its twin follows, and so
      does the BPM field for Tempo. Double-click resets on either.
- [ ] Percussion lanes still render High at the top, Low at the bottom.
- [ ] Transport is ONE row: Play / Stop / Record, the clock + alarm icons, and
      the Processor dial — which now reads "Processor" ABOVE the dial with its
      status ("Auto (med) · 22 notes · 30 fps") in small secondary text BELOW
      it, and no repeated caption on the knob itself.
- [ ] Narrow the window to ~360 px: the transport wraps gracefully — the
      Processor dial may drop to a second line, but nothing overlaps or clips.

## v16 delta — presets below the dials, preset URLs, block editor (2026-07-25)

Presets gallery (Simple tab)
- [ ] The factory presets sit on SIMPLE now, directly BELOW the four dials —
      not on Advanced. Hovering (or Tab-focusing) a card shows a tooltip
      explaining WHY that preset is shaped the way it is.
- [ ] Advanced, where the gallery used to be: a line above "Your presets"
      reading "Factory presets moved to the Simple tab — show them". Click it:
      it switches to Simple and puts the focus on the first preset card.
- [ ] Load a card — everything changes and stays fully editable, exactly as
      before. Your own presets are unchanged.

Preset URLs
- [ ] Every factory preset has its own address: open `https://ambi4.work/deep-focus`
      (any card's name, lower case, hyphenated). It flashes a "Loading the …
      preset" line and lands on the generator WITH that preset applied — dials,
      tracks and voice editors all match — plus a note reading "Loaded the … preset
      — Save to keep it".
- [ ] The address bar reads `/` afterwards, not `/deep-focus`, and Back leaves
      the site rather than bouncing through the redirect.
- [ ] Reload: your own stored settings are back. A preset link is a visit, not a
      takeover, until you Save it (same rule as a `#p=` share link).
- [ ] A junk slug (e.g. `/not-a-preset`) → the normal 404 page.

Min-max dials
- [ ] "Randomise" dials in a track's Edit panel (Voice / Pitch / Timing / …) can
      now be clicked to switch to a drifting min–max range, like Level and
      Randomness. The left detent (Auto — "follows Randomness") is a single
      value only: collapse a range onto it and the dial reads Auto again.
- [ ] Clicking Tempo, Complexity, Repetition, Volume, Swing, Processor, Octave,
      Filter type or the Shape dials does NOTHING — those params take a single
      value engine-side, so they deliberately have no range affordance.

Paid features hidden until launch
- [ ] The transport strip is Play / Stop / clock / alarm / Processor. There is NO
      Record button anywhere, on either tab — not greyed, not tooltipped, absent.
      (This supersedes the v14/v15 delta's "Record is greyed" expectation.)
- [ ] Sequencer panels show only the blocks icon; there is no `>_` JS-editor
      icon. Nothing anywhere is greyed with a "coming soon" caption.
- [ ] Both are one flag away: `PAID_FEATURES_HIDDEN` at the top of the page
      script. The MediaRecorder wiring underneath is untouched and dormant.

Block editor (sequencer panels)
- [ ] Melody / Bass / Arp / Percussion Edit panels: one small button to the
      right of Auto/Manual — the blocks icon.
- [ ] Click the blocks icon: the step grid is replaced by the block canvas
      (palette on the left, one row per lane). Percussion shows High at the TOP,
      as everywhere else.
- [ ] Place a Rest on beat 1, then click the icon again to go back to the grid:
      step 1 is now off. The two editors are two views of one pattern — whichever
      you use, the sound follows.
- [ ] Keyboard: Tab into the palette, arrows to choose a block, Tab into the
      canvas, arrows to move, Enter/Space to place, Delete to clear.
- [ ] If this build ships without blocks.js the icon is absent rather than dead
      — expected, not a bug.

## v12 delta — UI round (2026-07-25)
- [ ] Double-click ANY knob resets it to its declared default — a voice-editor knob resets to that VOICE's own factory value (not just whatever value it happened to load with, e.g. from a saved preset); a track's Level/Randomness knob resets to 80%/50%.
- [ ] Voice editor Detune stays 0-50 cents (unipolar, no negative) and Octave stays -1/0/+1 — both intentionally NOT widened this round (the engine only accepts those ranges; a wider dial would silently clamp).
- [ ] Track rows: the track name is now a lamp button — click it (or Tab to it + Enter/Space) to cycle Off -> Auto -> On; the dot goes dark/grey/lit to match. The existing Off/Auto/On pill control still works and stays in sync both ways.
- [ ] Structure block labels in the custom builder now read "Section A", "Section B" etc, not a bare letter.
- [ ] Voice editor Shape 1 / Shape 2 dials show sine/triangle/saw/square waveform icons at the four marks, and the readout shows the icon(s) too (one icon on a canonical shape, two either side of "~" mid-morph).
- [ ] Simple tab is now five dials: Speed, Complexity, Repetition, Randomness, Master volume. Randomness is new — turning it sets ALL SIX tracks' randomness at once; if tracks disagree (e.g. you'd tweaked one individually) the dial shows their average and clicking it can switch to a drifting min-max range (per-track randomness supports that; Complexity/Repetition don't, so clicking them does nothing — expected, the engine only takes a single number for those two). Interlinks still work: dragging Speed moves the Advanced-tab BPM field and vice versa; dragging Complexity snaps structure/arp/track-states back to Auto.

## v18 delta — design polish: alignment, colour, scope, honesty (2026-07-25)

Panel rule (applies everywhere — report ANY breach as a bug)
- [ ] Nothing moves or resizes when text changes. Press Play and watch the
      transport: the key reads Play → Finish → Finishing… without changing
      width, and the Processor dial beside it never jumps to a second line.
- [ ] Start recording: "Recording 0:07" appears in the status line without
      shifting the transport status beside it, and stops without shifting it
      back. Same for the sleep/alarm countdown badges on their icons.
- [ ] The Processor status ("Auto (med) · 22 notes · 30 fps") is now its own
      full-width line at the foot of the transport panel, right-aligned. Change
      the tier while playing: the text changes length; nothing above it moves.
- [ ] Track rows keep their height when Play starts (the cost meter's space is
      reserved whether or not it is drawn).

Alignment
- [ ] TRANSPORT and PROCESSOR are titles on ONE line at the top of the transport
      panel — same size, same baseline.
- [ ] Every dial in a row lines up: the four Simple dials, the same four at the
      foot of Advanced, the Level/Randomness pair in a track row, and every row
      of dials inside a voice editor. Faces on one baseline, names under them on
      one baseline, read-outs under those on one baseline.
- [ ] The Randomness dial's "Evolving" mark now reads on the caption line UNDER
      the dial, between "Repetitive" and "Random" — not above the face.
- [ ] Turn a voice-editor dial into a range (click the read-out area / drag with
      a second thumb) so it reads e.g. "2.0 kHz–8.0 kHz": the long read-out does
      not wrap, and the dials either side of it do not move.
- [ ] On the kit tabs (Percussion → Edit → High), an overridden dial takes a
      coloured ring WITHOUT shifting down relative to its neighbours.

Track colour on dials
- [ ] Every dial belonging to a track wears that track's colour on its ring —
      the Level/Randomness dials in the row, and every dial inside that track's
      editor. Open two editors in turn: the ring colour follows the track.
- [ ] The four main dials and the Processor dial keep the brass ring (they
      belong to no track). Dial pointers stay brass everywhere — only the ring
      is tinted, so the pointer keeps its contrast on the dark face.

Oscilloscope
- [ ] It sits between the transport panel and the piano roll, full width (same
      width as the piano roll), with NO title — just a twisty at the top right.
- [ ] Switch to Advanced: the scope and the piano roll stay put. Only the
      controls below the tabs change. Both keep drawing.
- [ ] Click the twisty: the body collapses and the word "Oscilloscope" appears
      beside it. Reload — it is still collapsed. Click again to reopen.
- [ ] The legend is right-aligned under the trace, one key per track in that
      track's colour. Single-click a key: that trace toggles off/on.
      Double-click a key: it solos (every other trace off). Double-click the
      soloed key again: the previous selection comes back.
- [ ] Your legend selection survives a reload.
- [ ] The old chip row above the legend is gone.

Voice selector honesty (Advanced → track rows)
- [ ] With everything at defaults, each row's voice select reads the voice you
      chose, as before.
- [ ] Open a voice editor and move any dial: the row's select now reads
      "Custom (…)" — the bracket names that voice's synthesis class
      (Subtractive / FM / Noise / Physical / Hybrid). Press "Reset to default"
      in the editor: it goes back to the voice name.
- [ ] Choosing a voice from the list still works and is still what gets saved:
      reload after a Custom reading and your chosen voice is intact.
- [ ] While playing with randomness up, a track whose voice wanders shows the
      voice you are HEARING in the select. Stop and reload: your own choice is
      back.

Percussion Pitch + Noise (Percussion → Edit)
- [ ] The Source section has a Pitch dial (±24 semitones, reads e.g. "+7 st")
      where the Octave switch used to be, and a new Noise dial (0–100%).
- [ ] Turn Pitch up: the kit's tuned parts rise in pitch. Turn Noise down: the
      hats/clicks recede and the drum body dominates.
- [ ] Both are per-instrument-overridable on the High/Mid/Low tabs like every
      other dial.
- [ ] If this build ships against an engine that does not know the fields, the
      old Octave switch is still there instead — expected, not a bug.

## v19/v20/v21 delta — sculpting dials, mono/glide, reverb tail (2026-07-25)

Voice editors are dials again (regression fix — check this first)
- [ ] Open ANY track's Edit panel: its Source/Filter/Envelope/Sends controls are
      knobs, not the plain sliders-and-dropdowns fallback. The last build lost a
      binding inside the knob builder, and because that builder is wrapped in a
      try/catch the page quietly served the fallback editor instead. Sliders
      anywhere in a voice editor now mean the same fault has returned.

Sculpting surface (Advanced → Texture)
- [ ] Texture's voice list now offers "Coloured noise", "Grain cloud" and
      "Call" alongside the old four; Melody's offers "Call".
- [ ] Pick Coloured noise and press Edit. The Source row holds only Octave (this
      voice has no oscillator to shape), and below it are three new labelled
      rows: Spectral (Tilt, Band, Width), Motion (Sweep, Depth, Gust, Gust rate,
      Swell) and Bursts (Density, Sharpness).
- [ ] Every one of those dials has a tooltip on hover AND on keyboard focus, and
      its read-out carries the unit it is in: Hz for Band, octaves for Width,
      Hz for the two rates, % for the rest.
- [ ] Play. Tilt left is a brown rumble, right is white hiss. Band moves the
      pitch you hear in the bed; Width opens it from a whistle to open weather.
- [ ] Sweep at 0 holds the band still whatever Depth says. Turn Sweep to ~0.1 Hz
      and Depth up: the band walks up and down over a few seconds.
- [ ] Gust up: the bed breathes in and out, and never gets LOUDER than it was at
      Gust 0 (gusts only duck).
- [ ] Grain cloud: Density from nothing to a downpour, Sharpness from soft damp
      drops to a dry bright crackle.
- [ ] Call (Texture or Melody): Sweep sets how far each call slides in semitones
      (negative falls, positive rises), the two Formants place its vowel, and
      Cadence/Irregular set how many calls a bar and how evenly spaced.
- [ ] Click any of these dials to split it into a min–max range: the value
      drifts between the two ends as it plays. None of them OPENS as a range —
      only Cutoff and the two Sends do that.
- [ ] Double-click any of them: back to that voice's own factory value.

Mono + Glide (Advanced → any tuned track → Edit)
- [ ] Every tuned track's editor header (not Percussion) has a Mono toggle and a
      Glide dial beside the state lamp. Melody and Bass ship Mono ON.
- [ ] Melody, Mono on, Glide up: the line slurs from note to note instead of
      re-striking each one. Glide at Off: clean steps.
- [ ] Mono off on Melody with Randomness up: overlapping notes are audible again
      (a wash rather than a line).
- [ ] Both survive a reload, and both travel in a saved preset.

Reverb tail (Advanced) — only if this build's engine ships it
- [ ] A "Reverb tail" dial appears beside Swing, reading in seconds (Room →
      Cathedral). Turn it up while playing: the tail lengthens within a second
      or two, without a click or a gap.
- [ ] Set it long, then set Processor to Eco: the tail shortens (the tier caps
      it). Set Processor back to Full: your full length comes back — the dial
      never moved, because the cap is applied on the way to the engine only.
- [ ] If this build's engine has no reverb-tail hook, the dial is simply absent.
      Same for the Fold dial (oscillator voices) and the per-track Drift rate
      dial — absent until the engine accepts them. Not a bug.

Kit ghost pointers (Advanced → Percussion → Edit → High)
- [ ] Each dial shows a second, muted pointer where the Common tab has that
      value — a thin arc instead when Common holds a min–max range.
- [ ] Move a dial: it takes the track colour ring and a "follow" link appears.
      Click "follow": the override goes and the dial returns to the ghost.
- [ ] On an older knob build the ghost shows as "common 2.0 kHz" text under the
      dial instead. Either is correct; a dial with NEITHER is a bug.

Guided tour
- [ ] Open the "?" tour: it now has steps for the sculpting voices, for the
      oscilloscope legend (click to toggle a trace, double-click to solo), for
      the preset gallery under the Simple dials, and a last step explaining that
      nothing here is AI or a recording — every note is worked out in the tab.

## v21 delta — kit lanes, per-track feel, note length (2026-07-25)

Everything in this section is engine-gated: if this build ships against an
engine that does not take the param, the control is simply absent. Absent is
correct; present-but-does-nothing is the bug.

Kit lanes (Advanced → Percussion → Edit)
- [ ] The lanes still read High at the TOP, Low at the bottom, and each lane
      now has a header: a grip, its name, a Low/Mid/High picker, ▲/▼ and (user
      lanes only) ×.
- [ ] "Add lane" above the grid: a new lane appears under Mid called "Lane 4",
      already carrying a COPY of Mid's pattern rather than an empty row.
- [ ] Click its name: it becomes a text box. Type "Rim", press Enter — the lane,
      the kit editor tab below and the block editor all read Rim. Escape
      cancels instead.
- [ ] Its Low/Mid/High picker sets which of the kit's sounds it strikes. On the
      three built-in lanes that picker is fixed (a built-in lane IS its sound) —
      rename or move them instead.
- [ ] ▲/▼ move a lane; so does Alt+↑/↓ with the name focused, and so does
      dragging the grip and releasing over another lane. The three built-ins
      have no × — they cannot be removed. Removing a user lane takes its pattern
      with it.
- [ ] Each lane's velocity bars are a different shade of the percussion colour,
      strongest at the top — one instrument, its lanes told apart by shade.
- [ ] Kit editor tabs (below the grid) follow the lanes: Common | High | Mid |
      Rim | Low, and an override you set on Rim survives a reload and travels in
      a preset. Remove Rim and the editor drops back to Common.
- [ ] Eight lanes is the ceiling — "Add lane" greys out at eight.

Per-track feel (Advanced → any track → Edit)
- [ ] Melody / Bass / Arp / Percussion have a Swing dial in their edit panel;
      Pad / Arp / Melody / Bass / Texture have a Density dial. Percussion has no
      Density (it is a tuned-track control) and Pad/Texture no Swing.
- [ ] Both open at the left detent reading "Auto": Swing follows the global
      Swing dial, Density lets Complexity decide. Turn one and only THAT track
      changes — set the global Swing high and one track's Swing low, and that
      track alone stays straight.
- [ ] Double-click either: back to Auto.

Per-step note length (Melody / Bass / Arp → Edit → step grid)
- [ ] Drag vertically in the LOWER half of a step: the bar narrows and widens
      across the step — that is the note's length. The upper half still shapes
      the velocity band, and the fat handle at the band top is unchanged.
- [ ] Keyboard: − and = (or +) on a focused step shorten and lengthen it; the
      screen reader announcement includes "length".
- [ ] Past a full step the note runs into the next one and a small › appears at
      the step's right edge. Playing: a long note audibly slurs into its
      neighbour on Melody (which ships Mono), a short one sounds clipped.
- [ ] Percussion has no length axis — a kit hit has no length to shape.

Detune (any voice editor → Source)
- [ ] Detune is now ±50 cents with a centre detent: turning left detunes flat,
      right sharp, and the middle reads "In tune" and is findable by feel. (The
      v12 delta's "stays 0–50, unipolar" line is superseded — the engine has
      accepted negative cents since v18.)

## Iteration 4 delta — three more modes, chord length, pad breath

Everything below is engine-gated, same discipline as the v21 delta above: if
this build ships against an engine that has not landed the param yet, the
control is simply absent — check the boot gate's "iteration 4 probe-gated
surfaces" block passed before assuming a missing control is a bug here.

Scale (Advanced → Scale select)
- [ ] Ionian (Major), Mixolydian and Phrygian are selectable alongside the
      original six. Each audibly plays a normal 7-note scale, not a silent or
      broken one.

Chord length (Advanced, near Structure)
- [ ] A "Chord length" select sits directly under Structure: Auto / 1 / 2 / 4 /
      8 bars.
- [ ] Auto behaves as today (the hook picks its own pass length). Setting 1
      bar audibly changes chord every bar; 8 bars holds one chord for a long
      stretch. Changing it while playing takes effect without a glitch.

Pad breath (Advanced → Pad → Edit)
- [ ] A "Breath" knob (0–1) sits in the pad's own editor — nowhere else.
      Tooltip/hover text: "How much the pad swells with each bar."
- [ ] At 0 the pad's bar-to-bar swell is much shallower than the current
      default sound; turned up it swells more obviously in time with the bar.
- [ ] Persists in a saved preset and across a reload like every other pad
      setting.

Live readouts (Advanced → any pulsed/tuned track's row, playing)
- [ ] If this engine build reports resolved swing/density (Live readouts
      already show `level`/`random` next to each track), the same small text
      now also shows the track's actual sounding `swing`/`density` value —
      only on tracks where that field applies (swing on Melody/Bass/Arp/
      Percussion, density on the tuned tracks), and only once the engine
      actually reports it. Absence here on an engine that doesn't report it
      yet is correct.

## v26 delta — OSC 2 linkage, packed dial rows, bare scope, fullscreen

Osc 2 and Mix (Advanced → any track with a second oscillator → Edit)
- [ ] Hovering the "Osc 2" switch reads "Adds a second oscillator; Mix
      balances the two."
- [ ] Switching Osc 2 OFF takes the Mix dial away with it (Mix is the balance
      between the two oscillators — with one source it did nothing, which read
      as a broken control).
- [ ] Switching Osc 2 back ON brings Mix back at the value it had before, not
      at a default. Save a preset with Osc 2 off, reload, switch it on: the
      balance you set is still there.
- [ ] The same on a voice that ships with Osc 2 already off — the editor opens
      with no Mix dial at all, and grows one the moment you switch Osc 2 on.

Dials pack horizontally (Advanced)
- [ ] Tempo, Complexity, Randomness, Volume, Repetition, Swing and Reverb tail
      are ONE wrapping row at the top of the tab, under Tracks — not seven
      controls on seven lines. Narrow the window: they re-wrap into two or
      three rows, still with their faces on a shared baseline and their names
      and read-outs below the faces.
- [ ] Swing and Reverb tail are absent on an engine that doesn't take them,
      and the row simply gets shorter — no gap where they would have been.
- [ ] Percussion → Edit: Drift rate and Swing sit side by side on ONE row.
      This was the named offender — they used to be on separate lines.
- [ ] Melody → Edit: Dissonance, Drift rate, Swing and Density are all on one
      aligned row. Pad → Edit: Dissonance, Drift rate and Breath likewise.

Oscilloscope chrome
- [ ] The oscilloscope has no faceplate/panel around it any more — it is a
      bare display with one hairline edge, the same look as the piano roll
      below it.
- [ ] The track legend and the twisty sit ON the display's top edge, over the
      trace, not in a strip above or below it. The traces are still readable
      underneath (there is a soft fade behind the chrome).
- [ ] Collapsing it still shows the word "Oscilloscope" beside the twisty, and
      the legend goes away with the display. Re-expanding restores both.

Fullscreen (both displays)
- [ ] A small ⛶ sits on the oscilloscope and on the piano roll. Pressing
      either takes that display fullscreen on its own.
- [ ] In fullscreen, a "+ piano roll" (or "+ oscilloscope") control stacks the
      other one below it, both filling half the height. Both keep drawing, and
      both look sharp rather than upscaled — they resize to the new size and
      screen density.
- [ ] Esc, the browser's own exit affordance and the "Exit (Esc)" button all
      restore the page with both displays back where they were, still running.
- [ ] Pressing ⛶ again while fullscreen exits it.

Oscilloscope options (in the overlay, while playing)
- [ ] A "Spread" toggle appears once the trace is live. On, each track gets its
      own flat line to wobble on, stacked up the display; off, they share one.
      The setting survives a reload.
- [ ] A white "Total" toggle appears ONLY if this build's engine publishes a
      master/post-effects analyser. It is OFF by default. If it is absent, that
      is correct for now, not a bug: the engine's `getAnalysers()` publishes
      per-track analysers only, and the page skips the toggle entirely rather
      than shipping one that does nothing. It lights up with no page change the
      moment the engine adds `getMasterAnalyser()` (or a `master` key on
      `getAnalysers()`) — that is the engine's next pass, owed from here.
- [ ] Neither toggle shows on a build whose scope module has no `setSpread` /
      `setTotalVisible`, for the same reason.

## v26 delta — genre transport (picker, favourites, Pause, Next)

Fresh load opens on a genre (private window, or clear this site's data first)
- [ ] Open `/` with nothing stored: the genre picker under the Play button
      already names a genre, and the tempo/scale/tracks are that genre's, not
      the old defaults. Close the window and open a fresh one two or three
      times — a different genre or at least a different piece each time. (The
      opening draw is from the quieter, work-music end of the set: Ambient,
      Cinematic, Downtempo, Lofi Beats, Minimalism, New Age. Arriving straight
      into peak-time techno is not the intended first impression.)
- [ ] A reload of a session where you HAVE changed something restores your own
      setup instead — the opening draw only ever runs when there is nothing
      stored, no share link and no preset route.

The genre picker (directly under Play/Finish)
- [ ] Twelve genres, then "Surprise me", then the favourites entry. Keyboard
      only: tab to it, open with the keyboard, arrow through it, choose with
      Enter.
- [ ] Choosing a genre while STOPPED loads its setup — tempo, scale, metre,
      structure, which tracks play, the kit. Press Play: it sounds like that
      genre.
- [ ] Choosing a genre while PLAYING switches on a bar line rather than
      cutting a bar off.
- [ ] The same genre chosen twice is a different piece both times (different
      tempo/chord loop within the genre's own rules) — genres are rules, not
      presets.
- [ ] Your master Volume does NOT jump when you change genre. Everything else
      is allowed to.
- [ ] "Surprise me" never lands on the genre already playing.
- [ ] "No genre" clears the tag and leaves the music alone (the params are
      still whatever the genre compiled — clearing the tag is not an undo).
- [ ] Loading a factory preset clears the genre back to "No genre", and the
      preset card's tooltip says so. Presets are fixed snapshots.
- [ ] Reload: the genre you chose is still named in the picker.

Favourites
- [ ] The first time you choose the favourites entry it reads "Favourites…"
      and opens a checkbox list of all twelve, grouped by mood (Calm, Groove,
      Drive). After that the entry reads "Edit favourites…".
- [ ] Tick two genres in different moods: both mood groups appear in the
      picker under "Favourite moods", each showing how many favourites it
      holds. Choosing one plays a random favourite from that mood.
- [ ] "Hide the rest of the genres from the list" prunes the main list to your
      favourites (the genre currently playing stays listed either way, or the
      picker could not show its own value). Surprise me and the favourites
      entry never get pruned.
- [ ] With the hide toggle on, a fresh load opens on one of your favourites.
- [ ] Esc closes the editor and focus returns to the picker; clicking outside
      closes it too. Favourites survive a reload (consent granted).

Pause
- [ ] Play, then Pause: the sound stops immediately and the button reads
      Resume. Stop stays available; the main key still reads Finish, because
      the piece has not ended.
- [ ] Resume: the piece continues from where it was — the same bar, the same
      chord loop, not a fresh build. (On an engine without a real pause the
      button says so in its tooltip and Resume starts it building again; that
      is the fallback, not the shipped behaviour.)
- [ ] Pause, then leave the tab for a minute and come back: it is still
      paused, not quietly resumed.
- [ ] Pause then Stop: stopped, and the button reads Pause again.
- [ ] Headphone/lock-screen pause key does the same thing as the button.

Next (fast-forward)
- [ ] With a genre set, Next skips to a completely different setup inside that
      genre — different tempo/chords/kit, same genre in the picker.
- [ ] With no genre, Next re-rolls the material of the current setup: the
      dials do not move, but the music changes within a bar or two.
- [ ] Next while playing does not click, drop out or restart the piece from
      silence.

Automated: the page-boot gate additions
- [ ] `npm run build && node tests/page-boot.mjs` asserts the picker holds
      every genre FILE plus Surprise me and the favourites entry (a glob that
      resolved to nothing, or a new genre file the page never picked up, fails
      here); that a fresh boot opened on a genre whose compiled params are
      inside that genre's own declared ranges and are not the engine defaults;
      that picking a genre lands inside its declared bpm/scale; that a factory
      preset clears the tag; that favouriting adds a mood group and the hide
      toggle prunes the list; and that the Pause button's own explanation
      matches whether this engine build actually ships `pause()`.
