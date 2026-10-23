# Compose/create mode — spec, first draft (2026-07-29)

Drafted from the owner's two in-chat briefs of 2026-07-29 (verbatim in the
brain2 Q&A archive) and his standing rulings. This is the spec the TODO's
"spec before build" item asked for.

**Status corrected 2026-07-31** (the audit found this file still saying nothing
was built): the owner reviewed it in his item 96 and MOST of it has shipped.
Built: the Create door itself, rebuilt to his 103 (v0.0.85/89/90) — Blank slate
that empties everything including FX, the Zero buttons, guided start,
tap-a-rhythm with raw-take retention and Re-fit (v0.0.87/107), typed chords
(v0.0.68/76), typed melody up to eight bars played in order (v0.0.110/116), and
editable per-step pitch (v0.0.109/111). Since then the rest has landed too:
MIDI-file import (v0.0.134), words/lyrics with the metre read out of the
stresses (v0.0.148, his ruling c), the fuller genre-tree guided start
(v0.0.135), typed beats (v0.0.147), every compose tool aimed at any instrument
(v0.0.152/153), and the first derivation running the OTHER way — **Fit chords
to the tune** (v0.0.155) reads whatever tune a track already carries and
writes the diatonic chord loop that fits it (pure module
`src/scripts/harmonise.js`; on-beat notes decide, off-beat notes pass, no
draw anywhere so the same tune always yields the same loop). Where this spec
and the shipped Create door disagree, the door is what he reviewed.

## Status per row (triaged 2026-10-23, against v0.0.250)

| Row | Status | Where |
|---|---|---|
| Play or type a melody, chords derived | SHIPPED | Write: Melody (any tuned track, v0.0.152), touch keys v0.0.240, Fit chords to the tune v0.0.155 |
| Play or type a chord sequence, melody derived | SHIPPED | Typed chords in the Chords row itself; Follow my chords (v0.0.250) is the played half; Words sings over the loop; and Write a tune over these chords (this build) derives a plain melody from whatever loop is set onto any tuned track's grid — pure module src/scripts/tune-from-chords.js, rules pinned in tests/tune-from-chords-smoke.mjs: chord tones on the beats, stepwise passing/neighbour tones between, an arch per four-bar phrase, density from Complexity, a cadence at the end, the track's register (a texture-voiced track in the texture's 79-100 band), deterministic per loop and seed. A written tune is a chain of at most eight bars, so it follows the loop only at a fixed chord length whose pass fits eight bars: Auto, One per section and a longer pass (four chords at four bars) are set to the longest that fits (chordBarsForTune), and the tip says so |
| Start with a beat, tap a rhythm | SHIPPED | Write: Beat (v0.0.147, any kit v0.0.153), Tap a rhythm (v0.0.87/107) onto any kit, a user's own included, through an "onto" picker in the same row (v0.0.262; the built-in kit first, the raw take and Re-fit follow the kit tapped on) |
| Hum / whistle, then sing | OPEN, long-term | Needs the v0.2.x audio-in track |
| Start with words | SHIPPED | Write: Words, v0.0.148 |
| Start with ANY track | SHIPPED | Melody, Words, MIDI file onto any tuned/sequenced track (v0.0.152); Beat onto any kit (v0.0.153); Chords START the pad (typed chords and Fit chords switch it on after Blank slate); a MIDI file is hand-written and enters at once. Texture (v0.0.262): an OPT-IN step grid — absent is today's drift to the draw (texture stays out of SEQUENCED_TRACKS, the draw-order list; tests/texture-grid-smoke.mjs pins the gridless stream to dev's digests), a Manual grid plays exactly its steps. Write: Melody targets it and starts it; its editor shows the grid, or Add a step grid when it has none |
| Guided start | SHIPPED | Help me start, v0.0.135 |
| Authored-versus-generated seam | BLOCKED | fromClaude 18 (what a hand-edited step does); staged entry of a typed line inside a genre is fromClaude 19 |
| Simple and Advanced both | SHIPPED | the Create door, his 96 |
| MIDI-file import | SHIPPED | v0.0.134, compose side per his 96 |
| Recipe sheet | BLOCKED | fromClaude 22 |

## What it is

A third way into the app, beside "the app draws a genre" and "a share link
arrives": **Create — a blank slate the listener fills**, starting from
whichever musical element they think in. His words: create "should start from
a blank slate"; capture-what-is-playing is explicitly ruled OUT (that is what
Advanced editing already is), and MIDI-file import belongs to the play side,
not here.

## The governing rule it inherits

The everything-editable ruling (his item 79) is the spine of the mode: *"all
of the data required to produce what you hear is visible, and if you edit
that, what you hear will change… the app isn't doing anything in secret,
EVERYTHING can be edited."* In compose terms:

- Anything the user enters is **authored** data (the grid's filled marks).
- Anything a derivation suggests is **chosen** data (the grid's outlined
  marks) — visible, editable, and replaceable by the same derivation run
  again; editing a chosen element makes it authored.
- The engine accompanies; it never rewrites authored material.

This is the same promotion rule as the transparency build, decided once for
both.

## Entry points

Any track can be the start — his extension of the bassline point: "chords=pad,
melody=melody, drums=percussion… why not let people start with an arp, or even
texture if they like. It should be easy to dive in and start anything with any
of these."

| Start with | Enter it by | Derivations offered |
|---|---|---|
| Chords (pad) | Type (in the Chords row itself — writing chords switches the pad on; the roman-numeral loop editor, v0.0.68/76, is one press away) · play (Follow my chords, v0.0.250) | Melody suggestion — SHIPPED as Write a tune over these chords, onto any tuned track; bass root-following |
| Melody | Play · type into the step grid (needs the pitch-editable grid from the transparency build) | Chord suggestion — SHIPPED v0.0.155 as Fit chords to the tune, reading any tuned track's grid whatever put the notes there |
| Beat (percussion) | Step editor · **tap a rhythm — space bar or button** (his "love it") | Bass placement coupling (bass-follows-kick, from the Energy brief) |
| Bass | Play · type | Kick coupling the other way; chord roots |
| Arp / texture | Arp: any Write row that takes a track (typed, words, MIDI file). Texture: Write → Melody onto Texture, which gives it its opt-in grid (v0.0.262), or its own row to let it drift | Follows the chord loop once one exists |
| Voice (long-term) | **Hum or whistle first, sing later** (his ordering; both want the audio-in track) | Melody transcription, then everything melody offers |
| Words (long-term) | Type lyrics | Algorithmic melody attempt from syllable count, stress and contour — no external AI, so the AI-free position is untouched |

## Guided start

Beside the dive-in tiles, a short question flow ("what do you want to make? do
you hear a tune, a groove, or chords first?") that recommends where to begin
and opens that entry point. It is guidance only — the same entries underneath,
never a separate implementation. This is Simple's natural face of the mode.

## Simple and Advanced

Same entry points, same data. Simple derives without asking — play a melody
and it just makes chords (derivations run with defaults, results land as
chosen data the user can hear and replace). Advanced exposes what the
derivation is doing — which harmonisation, constraints, per-track regeneration
— as controls over the same machinery. No second implementation, no
Simple-only file format.

## Phasing

1. **Phase 1 (buildable now):** the Create entry surface (blank slate + per-
   track tiles + guided questions), chords-first via the existing loop editor,
   beat-first via the step editor plus tap-a-rhythm, melody-first via
   play-along (fixed in v0.0.82) with derive-chords-from-played-notes. Needs
   the pitch-editable grid for typed melody — shared with the transparency
   build, which should land first or together.
2. **Phase 2:** bass/arp/texture-first framing, derivation controls in
   Advanced, bass-follows-kick coupling (shared with the Energy redesign).
3. **Phase 3 (v0.2.x era):** hum/whistle (needs audio-in), then sing, then
   words-to-melody.

## Out of scope, by ruling

- Capture-what-is-playing as a create entry (ruled out — that is editing).
- MIDI-file import (play side; same derivation paths once imported).
- Any derivation that writes over authored data.

## Open questions for the owner (not yet asked — bundled here for review)

- Where does Create live: a third tab beside Simple/Advanced, or a "New piece"
  action inside both? (The spec leans "action inside both", so the mode never
  forks the interface.)
- Does a blank slate keep the current genre's voices as its palette, or start
  from a neutral default kit?
- Tap-a-rhythm quantisation: snap to the grid resolution on entry (editable
  after), or keep raw timing as capture already does?
