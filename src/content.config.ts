import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const serviceId = z.string().nullable().optional();

// Provenance record for a sourced cover image — no entry ships without one.
// `artwork` itself is REQUIRED (the key must be present) but its VALUE is
// nullable: `null` means "no cleared image yet" (the parked/pending state),
// never an entry that simply omits the question. See TODO.md ## Parked.
const artwork = z
  .object({
    src: z.string(),
    licence: z.enum(['PD', 'CC0', 'CC-BY']),
    sourceUrl: z.string(),
    attribution: z.string().optional(),
  })
  .nullable();

const playlists = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/playlists' }),
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    services: z.object({
      youtube: serviceId,
      spotify: serviceId,
      deezer: serviceId,
      soundcloud: serviceId,
      apple: serviceId,
    }),
    thumbnail: z.string().optional(),
    artwork,
    // Presence (any string) means: no sourced image is needed at all — the
    // cover is rendered by <PresetCover> from this seed, deterministically,
    // at build/request time. Provenance for that cover is the generator code
    // itself, not an external asset, so it lives outside the `artwork`
    // provenance record rather than satisfying it.
    presetSeed: z.string().optional(),
  }),
});

export const collections = { playlists };
