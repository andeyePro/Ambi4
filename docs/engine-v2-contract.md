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

---

# v4 addendum (site restructure wave — runs WITH wave 3; ownership below)

File ownership for this wave (nobody touches another's files):
- **Engine v3** (wave 3): src/scripts/ambient-engine.js, tests/engine-smoke.mjs
- **Voices v3** (wave 3): src/scripts/engine-voices.js, tests/voices-smoke.mjs
- **Generator page**: src/pages/index.astro, src/pages/generator.astro
- **Playlists/site**: src/pages/playlists.astro, src/layouts/Base.astro, astro.config.mjs,
  src/content.config.ts, src/content/playlists/**, src/components/**, README.md,
  and DELETING src/pages/[...slug].astro (replaced by /playlists/)
- **Prefs/consent**: src/scripts/prefs.js, tests/prefs-smoke.mjs

## Site map (v4)

- `/` = the generator (was homepage listing). Old `/generator/` → redirect to `/`.
- `/playlists/` = single page: all playlists grouped by genre heading, with a service
  selector. Old `/ambient/eno/`, `/classical/mozart/`, `/instrumental/xander/` → redirect
  to `/playlists/` (astro.config.mjs `redirects`, owned by Playlists/site agent).
- Base.astro header gains nav: "Generator" (/) · "Playlists" (/playlists/).

## Streaming services (free tiers CAN create playlists)

ids: `youtube`, `spotify`, `deezer`, `soundcloud`, `apple` (legacy — needs paid sub).
Content frontmatter replaces `playlist:` with:
```yaml
services:
  apple: 'ambi4-work-ambient-eno/pl.u-oZyl4BYtRpW092'  # keep existing values
  youtube: null      # PL… playlist id (also serves YouTube Music)
  spotify: null      # playlist id
  deezer: null       # numeric playlist id
  soundcloud: null   # user/sets/slug path
```
Embed URL templates (ServiceEmbed component, replaces AppleMusicEmbed):
- youtube: `https://www.youtube-nocookie.com/embed/videoseries?list=<id>` (h≈360)
- spotify: `https://open.spotify.com/embed/playlist/<id>` (h≈380)
- deezer: `https://widget.deezer.com/widget/auto/playlist/<id>` (h≈380)
- soundcloud: `https://w.soundcloud.com/player/?url=https%3A%2F%2Fsoundcloud.com%2F<encoded path>` (h≈380)
- apple: existing embed.music.apple.com iframe (h=450)
Selector: pill buttons; default = first service for which ANY playlist has an id, else
youtube. Playlists lacking the chosen service show a "Not on <service> yet" note instead
of an iframe. Service choice → `prefs.set('service', id)` (consent flow below).

## Consent + storage — src/scripts/prefs.js (contract)

No third-party cookies anywhere; this governs OUR persistence (cookies/localStorage are
"similar technologies" — same consent bar). API:
```js
export const prefs = {
  consent(),                 // 'granted' | 'denied' | null (unasked)
  setConsent(granted),       // persists the consent decision itself (tiny cookie 'ambi4-consent')
  get(key), set(key, value), remove(key),  // JSON values in localStorage, namespaced 'ambi4:'.
                             // Without granted consent: set() writes to an in-memory map only
                             // (session-scoped) and returns false; get() reads memory first.
}
export function consentPrompt(container, message) // renders an inline ask (not a banner):
  // message + [Save on this device] [No thanks] buttons, returns Promise<boolean>,
  // calls setConsent() accordingly. Idempotent per container. Theme via CSS vars.
```
Rules: nothing persistent is written before setConsent(true) — INCLUDING the generator's
existing settings localStorage (Generator agent migrates: on first settings change with
consent unasked, show consentPrompt "Remember your settings and presets on this device?";
denied → memory-only for the session, never re-ask that session, re-ask next visit).
`ambi4-generator-settings-v2` key migrates to `ambi4:generator` via prefs.

## Generator presets (Generator page agent, using prefs)

- "Presets" row: name input + Save (→ prefs `ambi4:presets` array, consent-gated),
  load select, delete. A preset = full v2/v3 params snapshot + name.
- "Submit preset" button → opens `https://contact.andeye.com/?subject=<enc>&message=<enc JSON>`
  in a new tab AND offers a copy-to-clipboard of the JSON (the domain may not exist yet —
  the copy path is the reliable one; keep the URL in ONE const at the top of the page script).

---

# v5 addendum (dial aesthetic + wave morphing). Ownership:
# voices-morph: engine-voices.js + tests/voices-smoke.mjs
# knob-scope: src/scripts/knob.js, src/scripts/scope.js, tests/knobscope-smoke.mjs
# page: src/pages/index.astro
# theme: src/styles/global.css, src/layouts/Base.astro
# (engine sanitiser change goes to the engine agent separately)

## Patch source becomes continuous (morphable)

`source.shape1`, `source.shape2`: number 0–3 or null (shape2 only) — 0 sine, 1 triangle,
2 sawtooth, 3 square; fractional = Fourier-interpolated morph (PeriodicWave, ~64 cached
steps per context, normalised so loudness doesn't jump across the dial). Legacy string
`osc1`/`osc2` values remain accepted everywhere (map: sine→0 triangle→1 sawtooth→2
square→3) and defaults now publish numeric shapes. mix/detune/octave unchanged.

## Knob component — src/scripts/knob.js

```js
export function createKnob(container, { label, min, max, value, step?, marks?,
  format?, onInput }) => { el, set(value), destroy() }
```
270° sweep (-135°..+135°), pointer vertical-drag + wheel + full keyboard (role="slider",
arrows/PgUp/Home/End), double-click resets to initial value, tick ring + engraved pointer,
all colours from the theme tokens below. No imports; import-safe in bare node.

## Scope — src/scripts/scope.js

```js
export function renderPatchWave(canvas, patch, { freq = 220 }) // static trace: offline
  // render ~2 cycles of shape1/shape2 mix (detune/octave applied) through the patch
  // filter, NO adsr; normalised amplitude; draws phosphor-style trace on grid.
export function attachLiveScope(canvas, analyser) => { destroy() } // rAF time-domain trace
```
OfflineAudioContext feature-detected (fallback: draw from a math model of the same mix —
must still show blend/filter qualitatively). Debounce external calls; canvas dpr-aware.

## Theme tokens (theme agent defines; page consumes — names are fixed)

`--panel`, `--panel-edge`, `--panel-inset`, `--knob-face`, `--knob-ring`, `--knob-pointer`,
`--tick`, `--tick-major`, `--scope-bg`, `--scope-grid`, `--scope-trace`, `--accent-warm`,
`--label-font` (small-caps-ish retro label stack). Both light (cream/walnut) and dark
(charcoal/walnut/amber) themes; AA contrast for labels/values; existing tokens unchanged.

## Page (index.astro)

Voice editor rebuilt on knobs: shape1 dial, shape2 dial (+off position), mix/detune/octave,
filter cutoff (log)/Q/envAmount + type dial, ADSR knobs, send knobs — grouped in a 70s
"module" panel per section with the scope canvas centre-top showing renderPatchWave of the
live-edited patch (debounced ~80 ms), switching to attachLiveScope(track analyser) while
the engine is running. Primary sliders/tabs stay (knob treatment optional there); tracks
rows keep selects but pick up panel styling. All existing behaviour (consent, presets,
interlinks, sleep/alarm, hardening) preserved.

---

# v6 addendum (random/hold, schedule UI, arp relocation, percussion sequencer)

## Engine params/API (engine-v6 agent)

- `tracks[track].randomness`: 0–1 (default 0.5) — scales that track's generative variation:
  note-choice spread, velocity jitter, octave wander, timing humanisation (±≤20 ms),
  pattern re-roll eagerness. 0 = deterministic/repetitive as possible, 1 = maximal variation.
- `tracks[track].hold`: boolean (default false) — freeze the track's current material at the
  next bar: melody loops its current phrase, arp freezes its mask+pattern, percussion its
  pattern, pad/bass lock the chord progression loop (harmony keeps following the progression).
  Hold wins over repetition/randomness re-rolls; releasing hold resumes normal generation.
- `engine.randomise(track)` — re-roll that track's material (new phrase/pattern/voicing seed)
  effective next bar; works while held (re-rolls the held material once); no-op when stopped
  is fine but must not throw. Also `engine.randomise()` (no arg) = all tracks.
- Percussion sequencer param:
  `percussion: { mode: 'auto'|'manual', steps: { low: Step[20], mid: Step[20], high: Step[20] } }`
  where `Step = { on: bool, vmin: 0–1, vmax: 0–1, prob: 0–1 }` (vmin ≤ vmax enforced).
  Steps-per-bar by metre (first N slots used): 3/4→12, 4/4→16, 5/4→20, 6/8→12, 7/8→14.
  In 'manual', each bar plays each lane's active steps: trigger iff random() < prob, velocity
  uniform in [vmin, vmax], kind = lane. randomness adds timing/velocity jitter on top; hold
  freezes the per-bar random outcomes (same trigger/velocity draw looping). 'auto' = current
  generative behaviour (complexity/intensity-driven), unchanged.
- Events: add 'perc-step' emission is NOT required; 'note' events already cover the visualiser.

## UI (page-v6 agent)

- Transport row: two icon buttons (inline SVG, aria-labelled, 44 px targets) next to
  Play/Finish — clock icon → "Sleep timer" popover (existing sleep controls; REMOVE the
  tab-open caveat here); alarm-clock icon → popover titled "Schedule start" (existing alarm
  controls; KEEPS the tab-open/device-awake warning). Popovers: anchored panels (module
  styling), Esc/outside-click close, focus-trapped while open, state preserved when closed.
  Countdown chips appear beside the icons when armed.
- Per-track controls (tracks panel rows AND mirrored in each voice editor): a "Random"
  button (dice icon + text) → engine.randomise(track); a "Hold" toggle (aria-pressed) →
  tracks[track].hold; a small Randomness knob (or slider fallback) → tracks[track].randomness.
- Arpeggiator editor MOVES inside the Arp track's Edit panel, ABOVE the voice/source
  sections (delete it from the Advanced tab body). Same controls, panel-labelled "Arpeggiator".
- Percussion sequencer at the TOP of the Percussion track's Edit panel: three lanes
  (Low/Mid/High) × metre-length steps (re-render on time-signature change; persist all 20
  slots). Per step: on/off; velocity BAND (vertical drag on the cell sets vmin–vmax, shown
  as a filled range); probability (per step — compact editable representation, e.g. a
  mini-bar row under each lane or a per-step secondary drag axis; MUST be keyboard/AT
  operable: cells are focusable with arrow navigation, Enter toggles, documented key pairs
  adjust band and probability). Auto/Manual segmented control above (mode param); beat
  numbers marked; all knob/panel styling from the v5 tokens.
- All new engine features feature-detected (engine v6 may deploy later than the page).

## v6 amendment — unified per-track step sequencers (supersedes the percussion-only shape)

Generalise: pulsed tracks `melody`, `bass`, `arp`, `percussion` each get
`tracks[track].sequencer = { mode: 'auto'|'manual', steps }`:
- melody/bass/arp: `steps: Step[20]` single lane, `Step = { on, prob 0–1, vmin, vmax }`;
  in 'manual' the step grid gates WHEN notes sound (metre-length prefix as v6 mapping);
  PITCHES stay generative (scale/chord-aware — the engine picks them as now), so manual
  sequencing stays musical. Trigger iff random() < prob; velocity uniform in band.
- arp: this REPLACES the old boolean `arp.steps` mask as the source of truth (keep
  accepting the legacy `arp.steps` booleans by mapping to {on, prob:1, band 0.5–0.9});
  pattern/rate/octaves/gate stay in the `arp` param group.
- percussion: three lanes as already specced (`steps: {low, mid, high}` of Step[20]).
- 'auto' everywhere = current generative behaviour; hold/randomness compose as specced.
- UI: ONE shared sequencer component pattern (per-step on/prob/velocity-band editing,
  keyboard/AT operable) rendered at the top of each of those tracks' Edit panels —
  visually identical treatment so users learn it once; percussion shows 3 lanes,
  melodic tracks one lane.
