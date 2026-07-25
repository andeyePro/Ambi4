# Ambi4.work
## Ambience for Work
Customisable endless music generated just for you, to help you work — the generator lives at `/`.
Plus a growing list of work-optimised music playlists at `/playlists/`, being rebuilt across YouTube Music, Spotify, Deezer and SoundCloud (Apple Music is legacy — it needs a paid subscription).

## Get involved
1. Install Node.js 20+
2. Fork this
3. `npm install` then `npm run dev` to open your local development server
4. See changes you make live in your local development server
5. Send a pull request

## Adding a playlist
Add a markdown file under `src/content/playlists/[genre]/` — the genre folder name becomes the section heading on `/playlists/`, and the page body is the description. Frontmatter:

```yaml
title: 'Eno'
date: 2024-01-30T17:41:26Z
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
