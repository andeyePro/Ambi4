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
editable per-step pitch (v0.0.109/111). NOT built: MIDI-file import (which now
has every engine piece it needs — pitch pins plus chain mode), words/lyrics
(awaiting his ruling on which of the two meanings he wants), and the fuller
genre-tree guided start. Where this spec and the shipped Create door disagree,
the door is what he reviewed.

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
| Chords (pad) | Type (the roman-numeral loop editor, v0.0.68/76) · play (play-along/MIDI, working again v0.0.82) | Melody suggestion; bass root-following |
| Melody | Play · type into the step grid (needs the pitch-editable grid from the transparency build) | Chord suggestion (already a backlog item for played MIDI) |
| Beat (percussion) | Step editor · **tap a rhythm — space bar or button** (his "love it") | Bass placement coupling (bass-follows-kick, from the Energy brief) |
| Bass | Play · type | Kick coupling the other way; chord roots |
| Arp / texture | Pick a voice and a pattern seed, then edit | Follows the chord loop once one exists |
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
