import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://ambi4.work',
  // trailingSlash defaults to 'ignore', so each entry covers both '/x' and '/x/'.
  redirects: {
    '/generator': '/',
    '/ambient/eno': '/playlists',
    '/classical/mozart': '/playlists',
    '/instrumental/xander': '/playlists',
  },
});
