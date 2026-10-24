# Ambi4.work
## Ambience for Work
Customisable endless music generated just for you, to help you work — the generator lives at `/`.
Plus a growing list of work-optimised music playlists at `/playlists/`, being rebuilt across YouTube Music, Spotify, Deezer and SoundCloud (Apple Music is legacy — it needs a paid subscription).

## What the generator does
Everything runs in your own browser: the engine, the voices and the analysis. Some of what you can do with it:

- **Every track works the same way.** Pad, bass, melody, arp, texture, the kit and kit tracks of your own: each with a voice, a level and an editor of dials. Drag a dial sideways and it spreads into a range the music wanders inside, with a live pointer showing where it is now.
- **Play along.** Musical typing, a MIDI keyboard, or the on-screen keys and drum pads on a phone or tablet. Turn on **Follow my chords** and the keys you hold choose the harmony at the next chord change.
- **Write it yourself.** Type a chord loop, then **Write a tune over these chords** onto any tuned track. **Tap a rhythm** onto the built-in kit or a kit track of your own. Texture has an opt-in step grid too.
- **See why each note was chosen.** Hover a lit step in a grid and its tooltip says what the note is against the chord and where it came from (the motif, a passing tone, leaning into the next chord).
- **Match a sample.** Choose a sound file or record a note from the microphone, and the editor sets the closest synth voice on that track (or one drum on the kit). The sample is measured in the browser and then dropped: never kept, played back or uploaded.
- **Opt-in voices and tone.** Plucked string (a modelled string), Pulse bass and Sync lead run on an AudioWorklet; a Vowel filter type sweeps u–o–a–e–i; **Drive** adds gentle saturation on the master and on any track. No genre or preset turns these on for you.
- **Help where you look.** Every section has an ⓘ: hover to peek, click to keep it open. On wide screens it opens in the tutorial panel beside the controls.

## Get involved
1. Install Node.js 22.12 or newer (Astro 7 refuses to build on anything older; `.nvmrc` and `.node-version` both pin the major)
2. Fork this
3. `npm install` then `npm run dev` to open your local development server
4. See changes you make live in your local development server
5. Send a pull request

## Adding a playlist
Add a markdown file under `src/content/playlists/[genre]/` — the genre folder name becomes the section heading on `/playlists/`, and the page body is the description. Frontmatter:

```yaml
title: 'Eno'
date: 2024-01-30T17:41:26Z
artwork: null                     # REQUIRED key — null where there is none
thumbnail: '/img/EnoSynths.jpg'   # optional
services:
  youtube: null      # PL… playlist id (also serves YouTube Music)
  spotify: null      # playlist id
  deezer: null       # numeric playlist id
  soundcloud: null   # user/sets/slug path
  apple: 'ambi4-work-ambient-eno/pl.u-…'   # embed path (legacy — needs a paid subscription)
```

Each service value is that service's playlist id/path, or `null` if the playlist isn't on that service yet (the page shows a "Not on … yet" placeholder there).

## License
[AGPL-3.0](LICENSE) — © 2024–2026 andeye Ltd. Run it, read it, fork it; if you serve a modified version, share your changes.
