import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://ambi4.work',
  // v0.0.275: spread-dials.js (the dissolved Randomise row's table and
  // decode shim) is imported statically by the page AND by the engine, which
  // the page loads dynamically. Left to itself Rollup puts a shared module
  // inside the page's entry chunk, so the engine chunk imports the ENTRY
  // back: harmless in a browser (one URL, one instance), but a harness that
  // imports the bundle under a cache-busting query (tests/voice-rule-page.mjs)
  // then ran the whole page twice — two Edit handlers, the second closing the
  // editor the first opened. Its own chunk keeps the engine off the entry.
  vite: {
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.replace(/\\/g, '/').endsWith('/src/scripts/spread-dials.js')) return 'spread-dials';
            return undefined;
          },
        },
      },
    },
  },
  // trailingSlash defaults to 'ignore', so each entry covers both '/x' and '/x/'.
  redirects: {
    '/generator': '/',
    '/ambient/eno': '/playlists',
    '/classical/mozart': '/playlists',
    '/instrumental/xander': '/playlists',
  },
});
