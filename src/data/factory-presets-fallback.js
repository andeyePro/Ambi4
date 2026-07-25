/**
 * Factory presets — build-time fallback.
 *
 * v16 moves the curated presets to `src/data/factory-presets.json`. Until that
 * file lands this module IS the set: `src/pages/index.astro` and
 * `src/pages/[preset].astro` both glob-import the JSON and fall back here when
 * it is absent, so the gallery and the `/[slug]` routes never disagree about
 * which presets exist.
 *
 * Schema (identical to the JSON's): { slug, name, oneLiner, rationale, params }.
 * `slug` is URL-safe and is the route; `rationale` is the psychology-informed
 * reasoning, shown as the card's tooltip. `params` is a PARTIAL params object —
 * the page deep-merges it over its own DEFAULTS — so loading one is an ordinary
 * settings load and everything stays editable afterwards.
 */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const isUsablePreset = (p) =>
  !!p &&
  typeof p === 'object' &&
  SLUG_RE.test(String(p.slug ?? '')) &&
  typeof p.name === 'string' &&
  !!p.params &&
  typeof p.params === 'object';

/**
 * The preset set this build ships: `factory-presets.json` when it exists,
 * FACTORY_PRESETS_FALLBACK when it does not. `import.meta.glob` (not a static
 * import) is what makes the absent file a non-event — an unmatched glob is an
 * empty object, where a static import would fail the build. Anything the JSON
 * gets wrong (not an array, an entry without a usable slug/name/params) falls
 * back wholesale rather than half-loading: a partial gallery is harder to
 * diagnose than none at all.
 *
 * Build-time only — both callers are Astro frontmatter.
 */
export function resolveFactoryPresets() {
  const modules = import.meta.glob('./factory-presets.json', { eager: true });
  for (const module of Object.values(modules)) {
    const list = module && module.default;
    if (Array.isArray(list) && list.length && list.every(isUsablePreset)) return list;
  }
  return FACTORY_PRESETS_FALLBACK;
}

export const FACTORY_PRESETS_FALLBACK = [
  {
    slug: 'night-shift',
    name: 'Night Shift',
    oneLiner: 'Slow, low and unhurried — for the small hours.',
    rationale:
      'Tempo well under resting heart rate and a drone structure: low arousal, ' +
      'nothing that asks for attention. Aeolian on A keeps it dark without turning bleak.',
    params: {
      bpm: 46, root: 'A', mode: 'aeolian', timeSignature: '4/4',
      complexity: 0.28, repetition: 0.75, structure: 'drone', volume: 0.7,
      tracks: {
        pad: { state: 'on', voice: 'warm', level: 0.85, randomness: 0.2 },
        arp: { state: 'off' },
        melody: { state: 'off' },
        bass: { state: 'auto', voice: 'sub', level: 0.7, randomness: 0.15 },
        texture: { state: 'auto', voice: 'wash', level: 0.5, randomness: 0.3 },
        percussion: { state: 'off' },
      },
    },
  },
  {
    slug: 'glass-office',
    name: 'Glass Office',
    oneLiner: 'Bright, clean and slightly restless. Daylight work.',
    rationale:
      'Mid arousal for routine daytime work: lydian is the brightest of the modes ' +
      'and a crystal arp keeps a light pulse going without a beat to lock onto.',
    params: {
      bpm: 68, root: 'C', mode: 'lydian', timeSignature: '4/4',
      complexity: 0.48, repetition: 0.55, structure: 'waves',
      tracks: {
        pad: { state: 'on', voice: 'glass', level: 0.75 },
        arp: { state: 'auto', voice: 'crystal', level: 0.6, randomness: 0.4 },
        melody: { state: 'off' },
        bass: { state: 'off' },
        texture: { state: 'auto', voice: 'chimes', level: 0.55 },
        percussion: { state: 'off' },
      },
    },
  },
  {
    slug: 'deep-focus',
    name: 'Deep Focus',
    oneLiner: 'Almost nothing happens, on purpose.',
    rationale:
      'Deep work wants the fewest possible onsets: high repetition, no melody, no ' +
      'percussion. Nothing new enters often enough to pull attention off the task.',
    params: {
      bpm: 56, root: 'D', mode: 'dorian', timeSignature: '4/4',
      complexity: 0.22, repetition: 0.9, structure: 'drone', volume: 0.72,
      tracks: {
        pad: { state: 'on', voice: 'strings', level: 0.8, randomness: 0.1 },
        arp: { state: 'off' },
        melody: { state: 'off' },
        bass: { state: 'off' },
        texture: { state: 'auto', voice: 'grains', level: 0.45, randomness: 0.15 },
        percussion: { state: 'off' },
      },
    },
  },
  {
    slug: 'morning-rain',
    name: 'Morning Rain',
    oneLiner: 'Soft ticking, a bell now and then, everything damp.',
    rationale:
      'A gentle wake-up ramp: tempo just above resting, quiet ticks for time-sense, ' +
      'and a bell melody random enough to feel alive but too quiet to interrupt.',
    params: {
      bpm: 72, root: 'G', mode: 'majorPentatonic', timeSignature: '4/4',
      complexity: 0.55, repetition: 0.5, structure: 'waves',
      tracks: {
        pad: { state: 'auto', voice: 'warm', level: 0.65 },
        arp: { state: 'auto', voice: 'softPluck', level: 0.5 },
        melody: { state: 'auto', voice: 'bell', level: 0.6, randomness: 0.6, dissonance: 0.15 },
        bass: { state: 'off' },
        texture: { state: 'auto', voice: 'sparkle', level: 0.5 },
        percussion: { state: 'auto', voice: 'tick', level: 0.35 },
      },
    },
  },
  {
    slug: 'slow-tide',
    name: 'Slow Tide',
    oneLiner: 'Long swells in six-eight. Choir underneath.',
    rationale:
      'Six-eight swings in long arcs rather than square bars, which reads as ' +
      'breathing — the classic wind-down shape when you want calm but not sleep.',
    params: {
      bpm: 52, root: 'F', mode: 'minorPentatonic', timeSignature: '6/8',
      complexity: 0.38, repetition: 0.65, structure: 'waves', volume: 0.78,
      tracks: {
        pad: { state: 'on', voice: 'choir', level: 0.8 },
        arp: { state: 'off' },
        melody: { state: 'off' },
        bass: { state: 'auto', voice: 'round', level: 0.7 },
        texture: { state: 'auto', voice: 'wash', level: 0.55 },
        percussion: { state: 'off' },
      },
    },
  },
  {
    slug: 'paper-lanterns',
    name: 'Paper Lanterns',
    oneLiner: 'Marimba, hand drum and a shuffle. Warm evening.',
    rationale:
      'Sociable rather than solitary: a swung hand drum near walking pace is the ' +
      'tempo people talk over comfortably, so it suits a room with company in it.',
    params: {
      bpm: 82, root: 'E', mode: 'majorPentatonic', timeSignature: '4/4',
      complexity: 0.62, repetition: 0.45, structure: 'abab', swing: 0.4,
      tracks: {
        pad: { state: 'auto', voice: 'warm', level: 0.6 },
        arp: { state: 'on', voice: 'marimba', level: 0.65, randomness: 0.55 },
        melody: { state: 'auto', voice: 'keys', level: 0.6 },
        bass: { state: 'auto', voice: 'round', level: 0.65 },
        texture: { state: 'auto', voice: 'chimes', level: 0.4 },
        percussion: { state: 'on', voice: 'hand', level: 0.55 },
      },
    },
  },
  {
    slug: 'cold-start',
    name: 'Cold Start',
    oneLiner: 'Whole-tone and wide awake. The busiest of the set.',
    rationale:
      'High arousal on purpose: fast, seven-eight so the metre never settles, and ' +
      'whole-tone so no note reads as home. For shifting a flat morning, not for reading.',
    params: {
      bpm: 96, root: 'A', mode: 'wholeTone', timeSignature: '7/8',
      complexity: 0.78, repetition: 0.3, structure: 'journey', swing: 0.15,
      tracks: {
        pad: { state: 'auto', voice: 'glass', level: 0.55 },
        arp: { state: 'on', voice: 'crystal', level: 0.6, randomness: 0.7 },
        melody: { state: 'on', voice: 'flute', level: 0.6, randomness: 0.65, dissonance: 0.35 },
        bass: { state: 'auto', voice: 'sub', level: 0.7 },
        texture: { state: 'auto', voice: 'sparkle', level: 0.45 },
        percussion: { state: 'on', voice: 'soft', level: 0.5 },
      },
    },
  },
  {
    slug: 'long-corridor',
    name: 'Long Corridor',
    oneLiner: 'One chord, drifting filters, no hurry at all.',
    rationale:
      'The slowest of the set, and the only one whose levels themselves drift: one ' +
      'chord in three-four with nothing to mark the bar, so time stops being countable.',
    params: {
      bpm: 44, root: 'B', mode: 'aeolian', timeSignature: '3/4',
      complexity: 0.2, repetition: 0.85, structure: 'drone', volume: 0.68,
      tracks: {
        pad: { state: 'on', voice: 'strings', level: { min: 0.55, max: 0.85 }, randomness: 0.12 },
        arp: { state: 'off' },
        melody: { state: 'off' },
        bass: { state: 'off' },
        texture: { state: 'auto', voice: 'grains', level: { min: 0.3, max: 0.55 }, randomness: 0.2 },
        percussion: { state: 'off' },
      },
    },
  },
];
