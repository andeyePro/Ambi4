# Ambient engine v2 — integration contract

Fixed interfaces between four workstreams. Do not deviate without updating this file.
File ownership (no agent touches another's file):

- **Engine core**: `src/scripts/ambient-engine.js` (+ `tests/engine-smoke.mjs`)
- **Voice library**: `src/scripts/engine-voices.js` (+ `tests/voices-smoke.mjs`)
- **UI**: `src/pages/generator.astro`
- **Visualiser**: `src/scripts/visualiser.js`

## Tracks

Six tracks, fixed order and ids: `pad`, `bass`, `melody`, `texture`, `arp`, `percussion`.

## Params (engine `setParams` / `getParams`)

```js
{
  speed: 1,                // 0.25–2, tempo multiplier
  complexity: 0.5,         // 0–1 — drives density, chord colour, AND auto choices (structure, arp, auto-track activity)
  repetition: 0.5,         // 0–1
  root: 'C',               // 'C'..'B' (sharps; flats accepted, normalised)
  mode: 'majorPentatonic', // majorPentatonic|minorPentatonic|dorian|lydian|aeolian|wholeTone
  timeSignature: '4/4',    // 3/4|4/4|5/4|6/8|7/8
  bpm: 60,                 // 40–120
  volume: 0.8,             // 0–1
  structure: 'auto',       // 'auto'|'drone'|'waves'|'build'|'abab'|'journey'|'custom'
                           // 'auto' = engine picks a preset from complexity
  customStructure: [       // used only when structure === 'custom'
    { label: 'A', bars: 8, intensity: 0.4 },   // label 'A'–'D', bars 1–32, intensity 0–1
    { label: 'B', bars: 8, intensity: 0.7 },
  ],                       // loops forever in order; max 8 blocks
  arp: {
    mode: 'auto',          // 'auto' (complexity-driven) | 'manual' (fields below apply)
    pattern: 'up',         // 'up'|'down'|'updown'|'random'
    rate: '1/8',           // '1/4'|'1/8'|'1/16'|'1/8T'
    octaves: 2,            // 1–3
    gate: 0.6,             // 0.1–1
    steps: [true × 16],    // 16 booleans, step-enable mask
  },
  tracks: {
    pad:        { state: 'auto', voice: 'warm' },
    bass:       { state: 'auto', voice: 'sub' },
    melody:     { state: 'auto', voice: 'pluck' },
    texture:    { state: 'auto', voice: 'sparkle' },
    arp:        { state: 'auto', voice: 'softPluck' },
    percussion: { state: 'auto', voice: 'soft' },
  },
}
```

- Track `state`: `'off'` never plays; `'on'` always plays; `'auto'` — engine decides from
  structure-section intensity + complexity (low complexity → fewer active tracks; arp and
  percussion are the last to join).
- v1 `voices: 1–4` param is REMOVED. Sanitiser ignores unknown keys.
- Everything clamps/validates as v1; partial `setParams` merges deeply for `arp`, `tracks`.

## Structure presets (engine behaviour)

Sections have `{ label, intensity 0–1 }`; intensity scales note density, active auto-tracks,
filter brightness, chord extension chance. Section changes only on bar boundaries; crossfade
gracefully (pads may sustain across).
- `drone`: single section, intensity 0.35, no changes
- `waves`: slow sine of intensity 0.25→0.75, ~16-bar period
- `build`: 0.2 → 0.85 over ~32 bars, then release to 0.3, repeat
- `abab`: A(8 bars, 0.4) B(8, 0.7) alternating
- `journey`: A(8, 0.35) A(8, 0.45) B(8, 0.65) A(8, 0.45) C(8, 0.8) B(8, 0.6), loop
- `auto`: complexity <0.33 → drone, <0.55 → waves, <0.75 → abab, else journey

## Voice library — `src/scripts/engine-voices.js`

```js
export const VOICES = {
  pad:        { warm: {label:'Warm', play}, glass: {label:'Glass', play}, strings: {label:'Strings', play}, choir: {label:'Choir', play} },
  bass:       { sub: {label:'Sub', play}, round: {label:'Round', play}, breath: {label:'Breath', play} },
  melody:     { pluck: {label:'Pluck', play}, bell: {label:'Bell', play}, flute: {label:'Flute', play}, keys: {label:'Keys', play} },
  texture:    { sparkle: {label:'Sparkle', play}, grains: {label:'Grains', play}, chimes: {label:'Chimes', play}, wash: {label:'Wash', play} },
  arp:        { softPluck: {label:'Soft pluck', play}, crystal: {label:'Crystal', play}, marimba: {label:'Marimba', play} },
  percussion: { soft: {label:'Soft kit', play}, hand: {label:'Hand drum', play}, tick: {label:'Ticks', play} },
};
```

`play(ctx, destination, note)` where `note = { midi, freq, velocity 0–1, duration seconds,
when (ctx time), pan -1..1, kind }`:
- Schedules its own nodes starting at `note.when`; must ramp (no clicks), self-stop and
  disconnect after release; may exceed `duration` slightly with a release tail.
- Must honour `note.pan` (StereoPannerNode) and `note.velocity`.
- Renders DRY into `destination` (a per-track GainNode); engine owns reverb/delay sends.
- Percussion notes have `midi: null, freq: null` and `kind: 'low'|'mid'|'high'`; pitched
  tracks have `kind: null`.
- Optional return `{ cancel() }` for hard-stop.
- Pure module: no import-time AudioContext, no other imports.

## Engine events + analysers (for visualiser)

```js
const off = engine.on(type, cb);   // returns unsubscribe fn
// 'note':    { track, midi|null, kind|null, velocity, time, duration }  (time = ctx seconds)
// 'section': { label, intensity, bar, time }
// 'bar':     { bar, beatsPerBar, time }
// 'state':   { running }
engine.now();          // AudioContext.currentTime, 0 if not started
engine.getAnalysers(); // { pad: AnalyserNode|null, ... } per track, null before start()
engine.getParams(); engine.setParams(partial); await engine.start(); engine.stop(); engine.running;
```

Events fire at schedule time (≤ ~0.15 s before audible time); consumers use `time` vs `now()`.

## Visualiser — `src/scripts/visualiser.js`

```js
export function initVisualiser(canvas, engine) => { destroy() }
```
Six labelled horizontal lanes (track order above); scrolling note events + per-track level
from analysers; theme via CSS variables (`--text`, `--secondary`, `--border`, `--link`) read
off `getComputedStyle(canvas)`; devicePixelRatio-aware; rAF only while `engine.running`
(idle = single static frame); respect `prefers-reduced-motion` (levels only, no scroll).

## UI (`generator.astro`) additions

- Per-track panel: 3-state segmented control Off / Auto / On + voice `<select>` (labels from
  this contract; UI hardcodes them — do not import engine-voices.js into frontmatter).
- Advanced concertina gains: Structure `<select>` (Auto/Drone/Waves/Build/ABAB/Journey/Custom)
  + custom builder shown only for Custom: up to 8 blocks, each label A–D select, bars 1–32
  number, intensity slider; add/remove/reorder (up/down buttons).
- Arpeggiator editor: Auto/Manual toggle; manual reveals pattern, rate, octaves, gate,
  16-step toggle grid.
- Voices slider (v1) is removed. localStorage key becomes `ambi4-generator-settings-v2`
  (ignore/discard v1 key).
- `<canvas id="track-visualiser">` above the sliders; page script calls
  `initVisualiser(canvas, engine)` after engine creation.

---

# v3 addendum (wave 3 — NOT in scope for the v2 agents; ignore if you are building v2)

## Engine API additions

```js
engine.arm();                  // create+resume AudioContext silently (call from a user gesture);
                               // lets start() later succeed outside a gesture. Idempotent.
await engine.finish(opts?);    // graceful musical ending: complete current bar, one closing
                               // bar resolving to the tonic, release pads, fade master over
                               // opts.fadeSeconds (default 8, 1–30); resolves when silent.
                               // 'state' event fires {running:false, finished:true} at the end.
engine.stop();                 // stays: immediate ~0.5 s fade (used for hard stop/page hide)
```

## Tempo model change (interlinking)

`speed` param is DEPRECATED at the UI level: the UI keeps one tempo value (bpm 40–120);
the Simple speed slider is a log-mapped view of bpm. Engine keeps accepting `speed`
(back-compat) but UI always sends `speed: 1` and drives `bpm`.

## Per-voice patch model (voice editor)

New param `patches: { [track]: { [voiceId]: Patch } }` — sparse; absent = voice defaults.
```js
Patch = {
  source: { // subtractive core (voices with FM/physical sources expose what applies)
    osc1: 'sine'|'triangle'|'sawtooth'|'square', osc2: same|null,
    mix: 0–1, detune: 0–50 (cents), octave: -1|0|1
  },
  filter: { type: 'lowpass'|'highpass'|'bandpass'|'notch', cutoff: 40–12000 (Hz, log UI),
            q: 0.1–20, envAmount: 0–1 },
  adsr:   { attack: 0.001–8 s, decay: 0.001–8 s, sustain: 0–1, release: 0.01–12 s },
  sends:  { reverb: 0–1, delay: 0–1 },
}
```
- engine-voices.js: every voice's `play()` gains an optional 4th arg `patch` (sanitised,
  merged over that voice's own defaults) and must honour filter/adsr; subtractive-source
  voices honour `source` too; FM/noise/physical voices ignore `source` fields that don't
  apply. Each voice exports its defaults: `VOICES[track][id].defaults` (full Patch).
- Engine: per-track per-note it passes `patches[track]?.[voiceId]` through to play(), and
  applies `sends` by giving each track its OWN reverb-send and delay-send gains (replacing
  any global fixed sends). Patch changes apply to newly scheduled notes (no retro-edit).
- UI: voice editor panel per track voice — collapsible under each track row or a modal;
  controls per Patch schema; "Reset to default" per voice; persisted inside the same
  localStorage settings object under `patches`.

## Sleep / schedule (UI-owned, engine-agnostic)

- Sleep timer: duration input (15 m / 30 m / 1 h / 2 h / custom minutes); at expiry call
  `engine.finish()`. Countdown shown near Play.
- Alarm: time-of-day input; on set: `engine.arm()` (gesture), show armed state + countdown;
  at target call `engine.start()`. Warn inline: works only while this tab stays open and
  the device is awake. Both cancellable. Timers use wall-clock re-check every ≤5 s
  (setTimeout drift-proof), not one long setTimeout.

## UI restructure (wave 3)

- Delete the intro paragraph entirely.
- Tabs "Simple" | "Advanced" (role="tablist", keyboard arrows) replacing the <details>
  concertina. Simple: Play/Finish, visualiser, speed/complexity/repetition/volume sliders,
  sleep+alarm. Advanced: tracks panel (+ per-voice editors), root/scale/timeSig/bpm,
  structure, arpeggiator. Visualiser stays visible on both tabs.
- Button label becomes "Finish" while running (calls finish(); a long-press or small
  secondary "Stop now" affordance may call stop()).
- Slider labels: complexity "Calm – Complex"; repetition gets three labels
  "Random – Evolving – Repetitive" (ends + centre).
- Interlink rules: speed slider ↔ bpm (one tempo, two views, either updates the other);
  complexity slider moves → structure/arp/track-states return to Auto + complexity set;
  hand-setting structure/arp/forced-on tracks → complexity slider shows a derived
  "combined complexity" estimate (structure preset intensity mean, arp manual density,
  fraction of tracks forced on — document the exact formula in the UI code) without
  overwriting the user's advanced choices.
