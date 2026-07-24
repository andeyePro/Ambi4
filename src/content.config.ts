import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const playlists = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/playlists' }),
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    playlist: z.string(),
    thumbnail: z.string().optional(),
  }),
});

export const collections = { playlists };
