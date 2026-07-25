// v4 streaming-service metadata (see docs/engine-v2-contract.md, v4 addendum).
// Order matters: it is the contract order used for the default-service pick.
export const SERVICE_ORDER = ['youtube', 'spotify', 'deezer', 'soundcloud', 'apple'] as const;

export type ServiceId = (typeof SERVICE_ORDER)[number];

export interface ServiceMeta {
  label: string;
  height: number;
  /** iframe `allow` policy applied when the embed is click-loaded. */
  allow: string;
  embedUrl: (id: string) => string;
  openUrl: (id: string) => string;
}

const STREAMING_ALLOW = 'autoplay *; encrypted-media *; fullscreen *; clipboard-write';

export const SERVICES: Record<ServiceId, ServiceMeta> = {
  youtube: {
    label: 'YouTube Music',
    height: 360,
    allow: 'encrypted-media',
    embedUrl: (id) => `https://www.youtube-nocookie.com/embed/videoseries?list=${id}`,
    openUrl: (id) => `https://music.youtube.com/playlist?list=${id}`,
  },
  spotify: {
    label: 'Spotify',
    height: 380,
    allow: STREAMING_ALLOW,
    embedUrl: (id) => `https://open.spotify.com/embed/playlist/${id}`,
    openUrl: (id) => `https://open.spotify.com/playlist/${id}`,
  },
  deezer: {
    label: 'Deezer',
    height: 380,
    allow: STREAMING_ALLOW,
    embedUrl: (id) => `https://widget.deezer.com/widget/auto/playlist/${id}`,
    openUrl: (id) => `https://www.deezer.com/playlist/${id}`,
  },
  soundcloud: {
    label: 'SoundCloud',
    height: 380,
    allow: STREAMING_ALLOW,
    embedUrl: (id) =>
      `https://w.soundcloud.com/player/?url=${encodeURIComponent(`https://soundcloud.com/${id}`)}`,
    openUrl: (id) => `https://soundcloud.com/${id}`,
  },
  apple: {
    label: 'Apple Music',
    height: 450,
    allow: STREAMING_ALLOW,
    embedUrl: (id) => `https://embed.music.apple.com/gb/playlist/${id}`,
    openUrl: (id) => `https://music.apple.com/gb/playlist/${id}`,
  },
};
