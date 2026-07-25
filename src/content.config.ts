import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const serviceId = z.string().nullable().optional();

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
  }),
});

export const collections = { playlists };
