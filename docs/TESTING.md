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
