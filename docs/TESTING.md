# Ambi4.work — manual release test (~15 min)

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
- [ ] A row of dots sits above each lane. Click one to start a probability group (coloured); click the next dot to extend it; click a grouped dot to leave. Keyboard: G.
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

## v12 delta — UI round (2026-07-25)
- [ ] Double-click ANY knob resets it to its declared default — a voice-editor knob resets to that VOICE's own factory value (not just whatever value it happened to load with, e.g. from a saved preset); a track's Level/Randomness knob resets to 80%/50%.
- [ ] Voice editor Detune stays 0-50 cents (unipolar, no negative) and Octave stays -1/0/+1 — both intentionally NOT widened this round (the engine only accepts those ranges; a wider dial would silently clamp).
- [ ] Track rows: the track name is now a lamp button — click it (or Tab to it + Enter/Space) to cycle Off -> Auto -> On; the dot goes dark/grey/lit to match. The existing Off/Auto/On pill control still works and stays in sync both ways.
- [ ] Structure block labels in the custom builder now read "Section A", "Section B" etc, not a bare letter.
- [ ] Voice editor Shape 1 / Shape 2 dials show sine/triangle/saw/square waveform icons at the four marks, and the readout shows the icon(s) too (one icon on a canonical shape, two either side of "~" mid-morph).
- [ ] Simple tab is now five dials: Speed, Complexity, Repetition, Randomness, Master volume. Randomness is new — turning it sets ALL SIX tracks' randomness at once; if tracks disagree (e.g. you'd tweaked one individually) the dial shows their average and clicking it can switch to a drifting min-max range (per-track randomness supports that; Complexity/Repetition don't, so clicking them does nothing — expected, the engine only takes a single number for those two). Interlinks still work: dragging Speed moves the Advanced-tab BPM field and vice versa; dragging Complexity snaps structure/arp/track-states back to Auto.
