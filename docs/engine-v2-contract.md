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

## v6 amendment 2 — per-track randomisation targets

`tracks[track].vary = { voice, volume, pitch, timing, pan }` — each 0–1 or null
(default null = "follow this track's `randomness`"); an explicit number overrides the
macro for that aspect. Sanitiser: clamp/null per field, deep-merge.
Engine semantics (all bar-quantised where audible):
- voice: probability per bar of wandering to another of that track's voices (new notes
  only — per-note synthesis makes this click-free; re-apply defaults.sends on switch;
  getParams still reports the USER-selected voice, wander is ephemeral).
- volume: bounded slow random walk on the track gain (±up to ~6 dB at 1.0, centre =
  configured level) plus per-note velocity jitter.
- pitch: register/octave wander and passing-note likelihood (scale-aware as ever).
- timing: humanisation spread ±≤25 ms (respect lookahead).
- pan: per-note stereo spread width.
`randomness` remains the macro: it drives every null aspect; explicit aspects ignore it.
UI: a "Randomise" row of five mini knobs (Voice/Volume/Pitch/Timing/Pan) in each track's
Edit panel beside the existing Random/Hold/Randomness controls; each knob has an Auto
detent representing null (left end position, labelled in aria-valuetext); slider fallback.

---

# v7 addendum (range dials: min/max randomisable values; screws removed)

## RangeValue

Designated numeric params accept `number | { min: number, max: number }` (min ≤ max
enforced, both clamped to the param's range). A range means the EFFECTIVE value drifts
over time between min and max: engine keeps one bounded random-walk phase per
(track, param) updated per bar (coherent drift, not per-note white noise), except
per-note-natured params (velocity already banded; pan spread) which draw per note.
Sequencer step `prob` becomes rangeable too: the effective probability itself drifts
between min and max.

Rangeable + DEFAULT RANGE mode (ships as {min,max} in defaults where marked *):
filter cutoff*, sends reverb/delay, sequencer step prob, track randomness macro.
Rangeable + default SINGLE: mix, detune, Q, envAmount, ADSR (all four), vary aspects,
volume knobs. NOT rangeable: shapes (morph dial), octave, filter type, structure/arp
discrete selects, bpm/speed/timeSignature/root/mode, master volume.
Sanitisers (engine + voices patch layer) accept both forms everywhere rangeable;
`number` behaves exactly as today. getParams returns whatever form is stored.

## Dual knob (knob.js)

`createKnob` gains `range: {enabled, value2?}` support: opts `{allowRange?: bool,
rangeDefault?: bool}`; value may be number or {min,max}. Visual: single mode = current
pointer; range mode = inner pointer (min) + outer arc pointer (max) with the arc between
them tinted (--accent-warm at low alpha). CLICK on the knob face toggles single ↔ range
(preserving values: split → min=max=value; merge → value=(min+max)/2); drag/keys edit
min (inner) by default, the outer max via a modifier (Shift-drag / Shift-arrows) AND by
grabbing the outer arc directly; aria: two-thumb pattern (the knob exposes
aria-valuetext "min X, max Y, drifting" in range mode). onInput receives number or
{min,max} matching mode. Double-click still resets (to the initial form).

## Screws

The `.screw` decoration is retired — remove usages from pages; the theme keeps (or
drops) the class definition harmlessly.

---

# v8 addendum (user round 2026-07-25 early)

- Tracks list: per-track VOLUME knob (RangeValue-capable, click toggles min/max drift)
  visible in the main tracks rows; engine param `tracks[track].level` number|{min,max}
  0–1 default 0.8, multiplying the track gain (distinct from the vary.volume walk).
- Voice editor visibility: the per-track editor panel opens when its track row gains
  focus/selection (click or keyboard), collapsing others (accordion; remembers scroll).
  Explicit Edit buttons may remain as secondary affordance.
- Default track states: melody and bass ship state 'off' (defaults change in engine
  DEFAULT_PARAMS.tracks) until the musicality rework passes the USER's subjective
  "catchy" gate — that verdict is hard-escalate (user-only), never auto-passed.
- Bass harmonic contract (musicality rework): bass MUST voice the root of the CURRENT
  chord the pad/melody/arp share (approach notes only into changes); add a property test
  (bass note pitch-class == chord root pc on strong beats ≥95% of bars).
- Structure presets: every preset begins with a staged entry (never all active tracks at
  bar 0; pad first, others join per activation order across the first section).
- Voice control metadata: each voice's `defaults` is joined by `controls` — a descriptor
  of which patch sections/fields genuinely apply (e.g. wash: filter/adsr/sends only).
  The editor renders ONLY applicable controls; inapplicable = hidden (not greyed).

## v8 clarification — spec-critic rulings (2026-07-25, binding)

Headlines: controls schema uniform
true|false|string[] per section (adsr/sends always true); gain chain
TRACK_MIX × clamp(drift(level)×walk,·,1) preserves v5 headroom; randomness stays a
number default (page probe must widen before any range default ships); sequencer
grid = sixteenths (6/8→12, accents from pulse starts) EXCEPT the arp lane which is
indexed by arp-step-within-bar at the current rate; hold freezes the realised bar
plan but harmony keeps advancing; vary.voice wander is ephemeral and off-state is
absolute; staging is piece-level (bar 0 = pad only, all presets, even forced-on
tracks; all eligible by bar 5); tracks-row knob is labelled "Level" (master stays
"Master volume", vary mini-knob stays "Volume"); tracks.percussion.sequencer is
authoritative (top-level percussion param accepted as legacy input only); voice
defaults stay NUMBERS — the engine resolves every RangeValue to a number before
play(); RangeValue walk: w∈[0,1], ±0.15/bar, effective = min+(max-min)·w.

---

# v9 addendum (performance/thermal)

- Visual perf floor (immediate): no shadowBlur in any rAF loop (pre-rendered glow
  sprite/gradient allowed); visualiser + live scope ≤30 fps active, ≤2 fps hidden-tab
  (already off), pause via IntersectionObserver when scrolled out; dpr capped at 2.
- Power governor (src/scripts/power.js): quality tiers eco|low|med|full + auto.
  Auto senses: PressureObserver (feature-detected), rAF frame-time EMA, audio
  underrun proxy (ctx.outputLatency drift / currentTime stalls), hardwareConcurrency,
  deviceMemory, battery discharging. Governor outputs a budget the engine + visuals
  honour: max simultaneous notes (voice-steal oldest/quietest), reverb IR length
  (4s/2s/1s/off), texture+arp density scale, visual fps cap, scope on/off.
- Engine: engine.setPowerBudget(budget) + per-track live stats API
  engine.getStats() → {perTrack: {activeNotes, nodesEstimate, notesPerMin}, total}
  for the UI's per-track cost meters.
- UI: "Processor" dial (Eco–Full + Auto) on the transport panel; per-track cost
  meter (bar) in the tracks list; the meters and dial are the user-facing story of
  what is eating CPU.
- Factory presets: curated preset gallery (name + one-line character) shipping in
  the page alongside user presets; selecting one = full param snapshot load, fully
  editable afterwards (no lock-in).

---

# v10 addendum (user-editable everything)

Phase 1 — graphical coverage of the remaining non-dial params: chord-progression
editor (degree sequence per section label), structure intensity curve editor
(drawable per-block or preset-curve), phrase/motif shape controls (contour, rest
density, cell length). All params-only, preset-captured.

Phase 2 — "open the hood" code seams: engine + voices expose named seams
(voices.play per voice; phrase generator; chord walk; percussion pattern maker)
whose REAL source ships as strings alongside the compiled functions. UI: per-seam
editor panel (monospace, no external libs) showing that source; Save → compile via
Blob dynamic import in a try/catch harness; any throw at compile OR during playback
auto-reverts to factory and surfaces a one-line error; factory reset per seam;
user code persists via prefs (consent-gated) under 'ambi4:code:<seam>'.

Boundary (hard rule): shared/submitted presets serialise params ONLY. Code never
travels in presets or the submit flow; user code runs only on the device that
wrote it.

---

# v11 addendum (sharing, studio, hook — product roadmap + musicality brief)

- Preset share links: params serialised into a share URL (fragment, no server);
  later, named links ambi4.work/[name] via Workers KV + submit/approve;
  code-bearing presets require sandboxed execution + a review gate before listing.
  Hard rule from v10 stands: code never auto-runs from a link without the sandbox.
- Arrangement studio (roadmap): live-mix recording → MIDI capture from note
  events; offline render via OfflineAudioContext; export WAV + FLAC (wasm encoder),
  binaural (HRTF PannerNode) variant, mastering chain (limiter + LUFS normalise,
  platform presets ~-14 LUFS).
- MUSICALITY brief addition (hook system, addresses "pads monotonous on auto"):
  auto harmony gains a HOOK — a 4-8 chord loop that establishes early, repeats with
  small mutations (voicing, one-chord substitution), BANKS strong variants
  (periodic snapshot + simple salience heuristic), and recalls banked variants on a
  slow cycle (ear-worm return). Structure sections modulate which variant plays.
  Pad anti-monotony: rhythmic breathing (occasional half-bar re-attack or rest),
  dynamic swells tied to section intensity, default voice-wander slightly above
  zero on pad/texture in auto. Property tests: chord-loop recurrence rate within
  bounds; banked-variant recall happens; pad inter-onset variety above a floor.

---

# v12 addendum (iteration 3 — Musicality II + UI round; planner-authored, agents do NOT edit this file)

## Melody motif system (engine)
A motif = 3-5 note cell (contour + rhythm + scale-degree shape), established once per
section, DEVELOPED not re-rolled: exact repeat, diatonic transposition onto the current
hook chord, rhythmic displacement, occasional inversion/retrograde; ornament density
scales with complexity. Motif banking/recall REUSES the hook bank machinery (salience,
slow-cycle recall). Phrases breathe (inter-phrase rests) and land on a chord tone at
section boundaries. Register band ±14 semitones around octave 4 root. Each melody bar
carries a motif-derivation flag in its bar plan (tester asserts the flag).

## Bass (engine, v8 contract tightened)
Root pitch-class on strong beats (≥95% of bars, property-tested); approach notes only
into chord changes; per-section rhythm pattern (no per-bar re-roll); non-root chord
tones limited to fifth/octave, off strong beats only.

## Mono + legato (engine + voices)
Params: tracks[t].mono bool, tracks[t].glide 0-1 (maps ~0.02-0.12 s). Mono = max one
sounding note per track (previous note released at new onset). Legato: overlapping/
abutting mono notes retarget pitch (setTargetAtTime) without envelope retrigger.
Defaults: melody mono:true glide:0.3; bass mono:true glide:0.15; all others mono:false.
No UI exposure this iteration. Node counts must not rise materially.

## Hard constraints
DEFAULT_PARAMS.tracks.melody/.bass STAY 'off' (user gate). Turning either to auto/on
mid-playback joins cleanly at the next bar (staging respected, no click).

## UI round (page/knob/css) — priority order, partial land acceptable
1. Double-click resets any knob to its DECLARED DEFAULT (ranges collapse to scalar
   default) — knob.js gains a `defaultValue` opt; page passes voice/param defaults.
2. Detune bipolar -50..+50 cents, centre detent; octave -2..+2. (Voices already clamp;
   engine sanitiser range widens accordingly — U does NOT edit engine: the sanitiser
   already accepts 0-50; NEGATIVE detune requires an engine change, so U implements
   the UI as ±50 but clamps outgoing patch values to the engine's accepted range and
   marks the negative half "pending engine" if the engine rejects it — check first:
   if sanitiser clamps to [0,50], ship octave ±2 only and leave detune unipolar with
   a note. Do not silently break patches.)
3. Track-row lamp: click cycles off→auto→on; black/grey/white lamp + text label;
   keyboard operable (button semantics).
4. Section labels read "Section A" etc. wherever sections surface.
5. Shape dials get sine/triangle/saw/square glyphs (inline SVG/CSS only) positioned at
   the canonical marks, readout reflects fractional morphs.
6. Simple tab = five music-box dials via knob.js (existing params ONLY):
   Speed (log bpm view 40-120), Complexity (0-1), Repetition (0-1),
   Randomness (fan-out write to all six tracks[t].randomness; reads their mean;
   mixed values display the mean — display-only convergence), Volume (master 0-1,
   NOT rangeable). Click = single↔range toggle where the param is rangeable
   (complexity/repetition/randomness), double-click = default. Sliders remain as the
   no-JS/knob-fallback path.

## Terminus
After the gate + push, the loop STOPS at the user's catchy verdict. No iteration 4.

---

# v13 addendum (user round 03:5xZ — sequencer 2.0, UX corrections)

## Editor access levels
Some editors (block editor, code editor) are gated by account level; gated editors
render greyed with a level tag and route to an upgrade page when clicked.
Commercial details live outside this repo.

## Corrections/redesigns from live testing (next UI/engine waves)
- Track state lamp lives on the VISUALISER lane names too (scrolling piano bar),
  clickable in Simple and Advanced: cycle auto(grey)→on(white)→off(black).
- Off is musical: never cut mid-note; stop at the next note/bar boundary (verify +
  property-test; believed already true engine-side).
- Random+Hold buttons REPLACED by the randomness dial semantic: 0 = hold (loop the
  current bars exactly); re-rolls scale in as randomness rises. Single row per track.
- ALL dials min/max capable; interaction redesign: in range mode, drag INSIDE the
  dial circle = min, drag OUTSIDE the circle = max (replaces Shift-modifier).
- Track order everywhere: pad, arp, melody, bass, texture, percussion.
- Sequencer 2.0: (a) velocity-top grab must be easy (fatter hit zones); (b) click-
  drag across cells MERGES beats (tied notes); (c) probability GROUPS: dot row atop
  the grid, colour-coded groups; selecting a dot spawns the next; chain rule -
  within a group, a note's effective probability is multiplied by whether the
  group's prior note sounded (conditional trigs); (d) MULTIPLE sequencers per track:
  add copies current sequence; per-sequencer transition probabilities decide which
  plays next at loop end (Markov chain).
- Visualiser bar labels show the ACTUAL CHORD name per bar (from the hook), not the
  section letter; section label moves elsewhere/secondary.
- Per-tuned-instrument 'dissonance' dial (min/max capable): degree of permitted
  deviation from the group chord.
- Hook↔voice association; call-and-response option (riff stated by one instrument,
  answered by another, returning with the banked hook).
- Front-page oscilloscope: user-selectable instrument set (one, several, all),
  one colour trace per instrument, governor-respecting.
- Live value readouts on dials showing the currently-resolved (drifting) value —
  low-rate (≤4 Hz) poll, cheap.
- Editor follows the SOUNDING voice (wander switches the visible dial set live).
- Footer build-stamp (short SHA + date) so testers know which version they're on.
- Loudness: flute trim vs peers; bass 'breath' level check; bass vary.voice
  default 0 (wind-noise report root cause).

## v13 additions (user round 04:1xZ)
- Tooltips on hover/focus for compact labels (e.g. Auto detents: "follows Randomness");
  long inline explanations (sequencer key legend etc.) move behind small ⓘ info
  buttons opening dismissable info boxes. Native title attrs are NOT sufficient
  (touch/keyboard) — small CSS/JS tooltip pattern, theme-tokened, aria-described.
- Tutorial: collapsible panel docked RIGHT of the main screen (no library);
  stepped walkthrough (Play → Simple dials → tracks/lamps → sequencer → voice
  editors → presets), each step visually highlighting its control; open state
  persisted via prefs; linked from a "?" icon near the transport.
- Accordion fix: explicitly closing an auto-revealed edit panel (Edit toggle)
  suppresses focus-triggered reopen for that track until Edit is toggled on again
  (focus-open re-arms only via the toggle).
- Per-track identity COLOUR everywhere: each of the six tracks gets a stable theme
  colour (AA-checked in both themes) used for its visualiser lane trace, its lamp,
  its row accent, its editor panel accent, and future multi-trace scope colours.

## v12 clarification (post-landing, planner-recorded)
Two API additions the implementation established: melody 'note' events carry a
boolean `motif` field (true iff the bar's notes derive from the current cell);
`note.legatoFrom = {freq, handle, glide}` with glide in SECONDS, and a takeover
handle marks `handle.legato === true`. Bass vary.voice defaults to 0 (wind-report
fix); pad/texture stay 0.15. Patch detune is now -50..50, octave -2..2.

## v13 addition (04:4xZ)
- Click-to-type on ALL numeric readouts (knob values incl. range min/max, BPM,
  structure bars, timer minutes, step values): click swaps readout for an input;
  Enter/blur commits through the same clamp/sanitise path as the control; Esc
  cancels; keyboard reachable (readouts become buttons). Zero idle cost.

---

# v14 addendum (the "deliver everything" run, 2026-07-25 ~04:50Z)

DECISIONS: melody default state becomes 'auto'. Bass needs rework toward rhythmic identity: bass rework = groove-led:
a per-section rhythmic PATTERN with real identity (anchor pulse + syncopation cells,
locked to percussion's low lane where active), root-note discipline unchanged, note
lengths/gates shaping groove (staccato/held mix), pattern develops like the motif
system (variation of a stated groove, not re-rolls). Stays default-off until the user
passes it.

DEFECT (high priority): defaults can fall silent for long stretches. Fix with a
musical floor: at least one track audibly sounding at all times at default params —
pad breathing rests capped (never >1 bar of total silence; texture or pad must cover
gaps), auto-activation never drops below 1 active track, staging never yields an
empty bar after bar 0.

Simple tab: single labelling — dial label once, end-marks say Slow/Fast (etc.) at
the tick extremes; remove the duplicated above-dial end-label text.

Random+Hold merge (ships now, was v13): remove both buttons; tracks get ONE row;
randomness dial 0 = hold (loop current material exactly); Hold param stays engine-
side (UI writes hold=true iff randomness===0 or maps continuously — engine keeps
both, UI drives them from the one dial). Keep engine.randomise() API for power use.

Knob interaction v2: range mode editing = drag INSIDE the dial circle for min,
OUTSIDE (ring/beyond) for max (replaces Shift); all range-capable dials get it.
Click-to-type on every numeric readout (v13 spec).

Track colours: theme defines --track-pad/-arp/-melody/-bass/-texture/-percussion
(AA in both themes); used in visualiser lanes, lamps, row accents, editor accents.
Track ORDER everywhere: pad, arp, melody, bass, texture, percussion.

Visualiser: lane name = clickable lamp (auto grey/on white/off black) in Simple and
Advanced; bar labels show the CHORD NAME (engine emits 'chord' event {name, midis,
bar, time}); section label secondary.

Dissonance: tracks[t].dissonance 0-1 RangeValue (tuned tracks only; default 0) —
permitted deviation from the group chord (passing/neighbour tones at low values,
borrowed tones higher). Call-and-response: hook/motif statements can alternate
between two chosen instruments (engine picks pairs in auto; param later).

Live readouts: dials show the currently-resolved drifting value (≤4 Hz poll via
getParams + resolved-values accessor engine.getResolved?.() — engine may expose it
cheaply). Editor follows the SOUNDING voice (wander switches the visible dial set).

Power governor (v9 ships now): src/scripts/power.js + Processor dial (Eco-Full+Auto)
+ per-track cost meters from getStats(); auto-tier from PressureObserver/frame-time.
Factory presets: 6-10 curated snapshots in the page (name + one-liner), fully
editable after load. Footer build stamp (short SHA + build date).

Sequencer 2.0 (engine + page): fat velocity-top hit zones; drag-across-cells merges
into tied notes (step gains `tie`); probability GROUPS (dot row, colour-coded;
in-group conditional multiplication — a note's effective prob scales by whether the
group's previous note sounded); MULTIPLE sequencers per track with end-of-loop
transition probabilities (Markov chain; add copies current; engine param
tracks[t].sequencers[] with weights — sequencer (singular) stays as alias to [0]).

## v14 additions (user round 05:2xZ)
- Percussion auto threshold LOWERED so defaults actually reach it (arrives at
  moderate complexity/intensity; still last in). Bass groove locks to the
  percussion low lane BY DEFAULT when percussion is active.
- SWING: global param swing 0-1 (default ~0, global scope default; per-track
  override param reserved); delays off-beat subdivision onsets musically
  (classic 50-75% range mapping); sequencers, arp and percussion all honour it.
- Kit editor (percussion per-instrument overrides): selector tabs
  Common | (instruments, HIGH at top ... LOW at bottom everywhere lanes render);
  dials show the common value as a GHOST pointer; editing with an instrument
  selected creates a per-instrument override (dial accent switches to the
  instrument colour); clicking the ghost reverts that dial to follow common.
  Typical split: source/pitch/envelope per instrument, filter/sends common —
  but ANY dial may be overridden per instrument. Param shape:
  patches[track][voice].perKind = {low:{...}, mid:{...}, high:{...}} sparse
  overrides over the common patch.
- Extensible kit: percussion lanes not limited to three — users can ADD lanes
  (toms, cymbals for fills) once multi-sequencers land; lane names editable; engine kind becomes lane-indexed with a voice-kind mapping.
- Shape dial polish: saw glyph = one full cycle (two teeth), truly vertical
  drops; square = one full cycle (two verticals); the bulky readout text is
  replaced by a live MINI-WAVEFORM of the exact morphed shape (tiny canvas/SVG
  of the interpolated Fourier wave, updates on change only); tooltips on the
  four canonical glyph marks explain each shape.
- Sequencer playhead: the currently-sounding step is highlighted (white) —
  driven off note/bar events at step rate, DOM update only, no rAF.
- Lamp/state clicks NEVER open the edit accordion (off-toggle expanding the
  editor is a bug); only name-area/Edit affordances open it.
- Out-of-box goal (product principle): defaults must sound excellent with only
  the Simple dials; Advanced exists to show it's all user-buildable from
  scratch (tutorial narrative + "algorithmic, not AI" provenance note).

## v14 addition (05:4xZ)
- Visualiser blur: MAX_DPR=2 cap renders soft under browser zoom / >2 dpr.
  Fix: per-canvas cap raised (visualiser/scope ≤3 or exact dpr — their areas are
  small; fps cap carries the perf load), plus device-pixel snapping for 1px lines
  and label text. Verify sharpness at 100%/125%/150% zoom.

## v15 addendum (transport strip + repeats + record)
- Transport strip layout (left→right): [▶ Play/Finish combined button — triangle
  icon left of "Play"; while running it reads "Finish" with a final-barline 𝄂 icon
  to its right] [■ Stop button] [● Record button, classic red dot; MediaRecorder on
  the engine's existing MediaStream output → local download (webm/opus baseline;
  wav via offline later); recording indicator + elapsed] [far right: sleep (clock)
  and schedule (alarm) icon buttons stacked, each half the Play button's height].
- Piano-roll REPEAT BRACKETS: click on the roll's bar ruler sets an open-repeat
  mark 𝄆 at that bar; the next click to its right sets the close 𝄇; the enclosed
  bar range then LOOPS (engine replays the captured bar plans + hook state for
  that range, positional-hold semantics; params stay live) until the user clicks
  the close mark again (or the open mark to cancel). Engine API:
  engine.setLoopRegion(startBar, endBar) / engine.clearLoopRegion(); visualiser
  draws the brackets + dims bars outside; 'bar' events carry loop info.

---

# v16 addendum (overnight wave 2)

- Factory presets move to src/data/factory-presets.json (page imports it):
  [{slug, name, oneLiner, rationale, params}] — psychology-informed (arousal/
  tempo mapping vs use-case; rationale field documents the reasoning, shown as
  a tooltip). Slugs are URL-safe.
- Preset URL routes: ambi4.work/[slug] for every factory preset (Astro static
  route per slug from the JSON — src/pages/[preset].astro with getStaticPaths;
  loads the generator with that preset applied, canonical → /). User presets
  stay #p= links.
- Presets gallery moves BELOW the Simple dials (both tabs keep access).
- Knob push-through: in range mode, dragging min above max PUSHES max along
  (and max below min pushes min down) — replaces cross-clamping; allowRange
  becomes the default for every continuous dial (single-value params just
  collapse identically; discrete/stepped dials excluded).
- Piano roll: simultaneous notes in one lane get vertical offset slots
  (alternating high/low, up to 4 positions) so chord blips never overlap.
- Block editor v1 (src/scripts/blocks.js, own module): snap-together block
  surface for PATTERNS (not arbitrary code): palette of step/tie/group/
  probability/velocity-band/lane blocks; drag to arrange; "tie to beat N [of
  lane L]" blocks link beats (compiles to sequencer step.tie + group chains);
  compiles to tracks[t].sequencer(s) params via a pure toParams()/fromParams()
  round-trip; page hosts it behind the code-block icon on sequencer panels
  (v13 entry: block icon → blocks; >_ stays reserved for the future JS editor).
  Fully keyboard operable; no external libs.

---

# v17 addendum (share registry + naming + launch gating)

- PAID_FEATURES_HIDDEN flag (page): all tier-gated UI (JS-editor icon, Record,
  future upgrade buttons) renders NOTHING while true; one-line launch flip.
- Slug grammar: factory two words; assigned free names three words (from the
  vetted wordlist); registered tiers add username prefixes (business rules
  live outside this repo). Slugs kebab-case, dictionary words only.
- Registry architecture: public slug→params registry as repo data → static
  JSON shards at build time (free static reads at any scale); Worker + D1/KV
  write path only (register/claim/submit); accounts/PII in D1, never the repo.
- Wordlist: src/data/wordlist.json — multi-agent vetted (profanity, innuendo,
  brand/artist collisions incl. dictionary-word acts, cross-language offence,
  homophones), adjudicated in-doubt-leave-out; versioned with review notes.

---

# v18 addendum (design polish round, 2026-07-25 morning)

- Layout contract: TRANSPORT and PROCESSOR panel titles vertically aligned (one
  baseline); ALL dial faces in any row share a baseline — text (labels, ends,
  readouts) gets reserved space BELOW the face, never pushing faces up; audit
  every dial row against this.
- Track colour on dials: every knob inside a track's editor (and its row knobs)
  takes that track's --track-* accent (ring/pointer tint), so location is
  glanceable.
- Oscilloscope placement: NO title; sits BETWEEN the transport strip and the
  piano roll, full width (same width as the piano roll); collapsible twisty top
  right — collapsed state shows the word "oscilloscope"; legend right-aligned,
  DOM-functional: single click toggles that instrument's trace, double click
  solos it (all off bar the clicked one); the old chip buttons are removed.
  Scope + piano roll live ABOVE the Simple|Advanced tabs (persistent); only
  control surfaces switch with the tabs.
- Percussion patch: source.pitch replaces octave for percussion voices —
  continuous ±24 semitones (±2 octaves); new source.noise 0-1 (noise-component
  level). Engine PATCH_SCHEMA + voices honour both; kit perKind inherits.
- Voice selector honesty: when voice wander lands on a preset voice, the
  selector display follows the SOUNDING voice name; when the sounding patch has
  user edits (≠ voice defaults), display "custom [engine]" where engine is the
  voice's synthesis class — voices export engineType per voice
  ('subtractive'|'fm'|'noise'|'physical'|'hybrid') beside label/defaults/controls.

## v18 hardware-panel rule (binding, user-stated)
Like a classic hardware synth faceplate: NO control ever moves or resizes because of a state
or text change. Every button/label zone is sized to its WIDEST state at build
time (Play/Finish/Finishing…, armed countdowns, processor status, record
elapsed); dynamic text changes swap content inside fixed boxes. Any layout
shift caused by state text is a defect.

## v19 — parametric noise-sculpting surface (supersedes the v18 noise list)

NOT a menu of preset nature sounds. Texture becomes a modular noise instrument:
one or two base voices ("coloured noise", "grain cloud") whose DIALS span the
space, so users sculpt real-world impressions themselves:
- Spectral: colour/tilt (white↔brown continuum), band centre + width, band
  sweep rate + depth, resonance.
- Granular: density, grain size, grain pitch scatter, stereo scatter.
- Modulation: gust amount + rate (slow random walks on level/brightness),
  burst probability + sharpness (droplets, crackle), swell/crescendo shaper
  (slow attack curves up to storm-scale, RangeValue-capable everywhere).
- Call-synthesis primitives (second engine, melody/texture-capable): pitch
  glide range + curve, dual formant centres, chirp cadence + irregularity,
  repetition phrasing — sufficient to voice birdsong/whale-song-like calls by
  dial skill alone (tutorial material, not presets).
- All dials RangeValue-capable; sculpted settings are ordinary patches
  (preset-captured, shareable); steady-state node budget stays governor-safe.


## v19 roadmap additions
- Custom tracks (Premium-class): engine track REGISTRY refactor (dynamic track
  list replacing the fixed six across mix/staging/colours/lanes/stats) + user
  instrument manifests (JSON dial spec auto-building editor knobs + a code seam
  for the voice body per v10).
- Live input recording: Web MIDI (feature-detected) + QWERTY key mapping →
  capture into sequencer steps (quantise option) or free events on a chosen
  track.
- Offline waveform rule (defect): with the engine stopped OR a track off, every
  voice-editor scope shows the STATIC patch render, re-rendered on every dial
  change; the front oscilloscope shows a composite static preview of active
  tracks' patches when stopped.

## v19 roadmap additions (2)
- Live play-along: the MIDI/QWERTY input path also triggers the selected
  track's voice in real time (monitoring through the normal chain).
- Audio-in track: getUserMedia capture into an AudioBuffer (never leaves the
  device), first-class track playback (level/sends/sequencer trigger), sample
  editing v1 = trim / normalise / loop points.

## v20 — oscillator shape model revision + modifiers
- The shape dial's triangle→saw segment becomes PEAK SKEW: a variable-skew
  triangle whose peak position travels 50%→~99% (closed-form Fourier series →
  PeriodicWave, alias-safe). Full dial: sine→triangle (harmonic fade-in),
  triangle→saw (skew travel), saw→square (existing crossfade). Sources stay
  conceptually simple; glyph readout mini-wave reflects the true skewed shape.
- Shape MODIFIER patch fields (oscillator voices): fold 0-1 — wavefolder
  (WaveShaperNode folding curve, 2x oversampling; 0 = bypass, no extra nodes);
  reserved: drive, pulseWidth. RangeValue-capable; controls tables honest.

---

# v21 addendum (planner-specced ahead of iterations 3-4 and the registry refactor)

## Param shapes (engine, iterations 3-4)
- tracks[t].swing: 0-1|null (null = follow global swing); same warp law.
- tracks[t].density: 0-2|null (null = complexity-derived; scales that track's
  event rate only, post-activation).
- tracks[t].driftRate: 0.02-1 (scales ALL of that track's RangeValue walk step
  sizes; default 1 = current ±0.15/bar).
- reverbTail: 0.5-6 seconds (global preset-capturable; engine rebuilds the IR
  async on change, crossfading sends — governor tier caps still apply on top).
- harmony.rhythm: 'auto'|1|2|4|8 bars-per-chord (hook pass length adapts).
- Pad breathing: swell phase locks to bar phase (existing sin contour keyed to
  bar clock — already bar-phased; expose padBreath 0-1 depth param).
- Modes add: ionian, mixolydian, phrygian (scale tables + chord naming).
- Percussion lanes become DYNAMIC: sequencer.steps keyed by lane id (built-ins
  'high','mid','low' preserved; user lanes append, each with a voice-kind map
  and display name; cap 8 lanes). perKind keys follow lane ids.

## Track-registry API (window 2 refactor target)
engine.getTracks() → ordered [{id, label, builtin, colourToken}]; addTrack(
{id, label, family: 'melodic'|'percussive', voiceSet}) / removeTrack(id) for
user tracks (cap 12 total); ALL fixed six-key structures (TRACK_MIX, staging
order, auto-activation ladder, stats, params.tracks) become registry-driven;
events carry track ids as now; UI/visualiser/blocks build lanes from
getTracks(). Built-ins undeletable; user tracks persist in params.

---

# v22 — track registry (shipped half) vs pending half

SHIPPED (v0.0.24): internal TRACK_REGISTRY as single source of truth; all six
fixed tables derived with pinned identity proofs; getTracks() public view in
DISPLAY order (pad, arp, melody, bass, texture, percussion — user rule) with
displayOrder distinct from engine/staging order (byte-identity preserved);
page/visualiser/scope consume getTracks() with hardcoded fallbacks.
PENDING (window 3): addTrack/removeTrack for user tracks (cap 12), user
instrument manifests (JSON dial spec), persistence of user tracks in params.

---

# v23 — user tracks (window-3 build spec; supersedes v22's PENDING note)

## The frozen floor (THE decision — read this before anything below)

Every derived table (TRACK_ORDER, SEQUENCED_TRACKS, TUNED_TRACKS, TRACK_MIX,
AUTO_THRESHOLDS, MAX_STAGE_INDEX, TRACK_VIEWS) is a module-level constant,
frozen at import, built from the six built-ins. Runtime mutation cannot reach
them and MUST NOT try. So the registry splits in two:

- FLOOR (module scope, unchanged forever): the six built-ins and every table
  above. Frozen, six entries, byte-identity-pinned by the v22 proofs. Nothing
  in this window edits a line of it.
- LAYER (instance scope, inside `createEngine`): `userTracks[]` plus derived
  ACCESSORS over floor+user — `trackOrder()`, `sequencedTracks()`,
  `tunedTracks()`, `tunedSet()`, `trackMix(id)`, `autoThreshold(id)`,
  `stageIndexOf(id)`, `stageBars()`, `trackViews()`. Every engine-internal
  loop `for (const name of TRACK_ORDER)` becomes `for (const name of
  trackOrder())`; `const STAGE_BARS = MAX_STAGE_INDEX` becomes `stageBars()`
  (it is captured at closure build today and would freeze a stale value).
- IDENTITY SHORTCUT (load-bearing, not an optimisation): with zero user
  tracks every accessor returns THE SAME FROZEN OBJECT the module built —
  `trackOrder() === TRACK_ORDER`, `trackViews() === TRACK_VIEWS`. No copy, no
  allocation, no re-sort. `engine.getTracks() === getTracks()` therefore still
  holds, and the existing handle test keeps passing unchanged.
- Consumers: the MODULE export `getTracks()` stays built-ins-only forever —
  it is what `index.astro` imports at BUILD time for the SSR track rows, and a
  server render cannot know a user's tracks. `engine.getTracks()` (instance)
  is floor+user, in display order: built-ins in their fixed display order
  first, user tracks after, in creation order. The page, visualiser and scope
  all already read the instance handle; they need no new API, only the
  understanding that the list length is no longer 6.
- Module-level exported helpers that read a floor table gain an optional
  trailing argument and default it to the floor: `autoActiveTracks(intensity,
  complexity, tracks = TRACK_ORDER)`, `stageIndexOf(name, tracks =
  TRACK_REGISTRY)`. Existing call sites and tests are untouched.
- ORDER RULE: user tracks append after every built-in in engine order, in
  sequenced order, in staging and in the auto ladder. The first six draws of
  every per-track rng pass are therefore the built-ins' own draws, in the
  order they have always been.
- BYTE-IDENTITY IS CONDITIONAL, and stated plainly: zero user tracks ⇒ the
  note stream is bit-identical to v0.0.24 under the same seeded `options.rng`.
  One user track legitimately changes the stream (it draws). That is not a
  regression and no test may assert otherwise.

## addTrack

`engine.addTrack({ id, label, family, voiceSet, colourToken? })` → the frozen
public view of the new track (`{id, label, builtin: false, colourToken,
family}` — the same five fields, no sixth; the v22 key-set pin stands).

- `id`: `/^[a-z][a-z0-9-]{1,23}$/` — 2-24 chars, lowercase ASCII, digits and
  hyphen, must start with a letter. `#` is banned explicitly because frozen
  plan keys are `${track}#${lane}`; whitespace, dots and uppercase are banned
  because the id is a params key, a CSS-var suffix and a share-link token.
- Reserved ids (rejected as `reserved-id`): the six built-ins, plus `master`,
  `global`, `all`, `none`, `off`, `auto`, `on` — the last three collide with
  TRACK_STATES in every select the UI builds.
- Collision with an existing user track: `duplicate-id`. Case is not folded —
  the grammar forbids uppercase, so there is nothing to fold.
- `label`: non-empty string after trim, ≤ 24 chars; trimmed before storage.
- `family`: `'melodic' | 'percussive'` exactly.
- `voiceSet`: a key of the voice library — `'pad'|'bass'|'melody'|'texture'|
  'arp'|'percussion'`. A `'percussive'` family REQUIRES `voiceSet:
  'percussion'`; any other pairing is `bad-voice-set`. The track's voice bank
  is `VOICES[voiceSet]`, its default voice `DEFAULT_TRACK_VOICES[voiceSet]`,
  and `voiceFor()` falls back through `FALLBACK_VOICES[voiceSet]` exactly as a
  built-in does. No new voice code ships for a user track (v10 boundary).
- `colourToken`: optional; must match `/^--[a-z][a-z0-9-]{1,31}$/`. Absent ⇒
  the engine assigns `--track-user-N`, N = 1-6 by creation ordinal.
- Cap: 12 tracks total, so 6 user tracks. Exceeding ⇒ `cap`.
- THROWS, never returns false. `TypeError` for a malformed shape or grammar,
  `RangeError` for the cap; every thrown error carries `err.code` from
  `'bad-id'|'reserved-id'|'duplicate-id'|'bad-label'|'bad-family'|
  'bad-voice-set'|'bad-colour-token'|'cap'`. Rationale: a false is
  indistinguishable between "your id is bad" and "you are full", and the
  sanitiser-tolerance convention exists for `setParams` (untrusted stored
  data), not for a UI-driven API call.
- `engine.canAddTrack(spec)` → `null` when addTrack would succeed, else the
  same code string. Non-throwing, allocates nothing, is the probe the Add
  Track button enables/disables from. Same idiom as every other engineCaps
  probe.
- Effects, in order: validate → append to `params.userTracks` → rebuild the
  instance accessors → `ensureTrackChain(id)` (build the input/tone/dry/sends/
  analyser chain if `graph` exists) → seed `params.tracks[id]` from the
  defaults below. `ensureTrackChain` DRAWS NO RANDOMNESS — the reverb IR is
  the only rng in `buildGraph` and it is not rebuilt.
- Adding mid-playback is legal. The new track sounds from the NEXT bar (it has
  no plan for the bar already realised) and is subject to `stageIndexOf`.

## removeTrack

`engine.removeTrack(id)` → `true` removed, `false` unknown id (idempotent —
calling twice is not an error). Throws `Error` with `code: 'builtin'` for any
of the six: deleting a built-in is a programming fault, not a user outcome.

- Params: `params.userTracks` entry and `params.tracks[id]` are both deleted
  synchronously. `getParams()` stops reporting the track on the same tick.
- Scheduling: no new note is scheduled for the track from the moment of the
  call. Plans already realised for the current bar are discarded, frozen plans
  under `${id}` and `${id}#*` are cleared.
- Voice teardown: in-flight notes RING OUT. The track's chain is disconnected
  only after `max(entry.until)` over its live notes has passed (the existing
  `pruneLiveNotes` bookkeeping already knows this), then input/tone/dry/sends/
  analyser are disconnected and dropped. Stopped engine ⇒ teardown is
  immediate. No fade is applied: cutting a ringing note is the click the
  50 ms-fade rule exists to prevent.
- `getAnalysers()` drops the key at once (the analyser node may outlive it by
  a tail; nothing may hold it).
- Staging reindex: user stage indices are `MAX_STAGE_INDEX + 1 + ordinal`,
  compacted on removal so the remaining user tracks stay contiguous.
  `stageBars()` shrinks with them. A RUN IN PROGRESS is not re-staged
  retroactively — a track already sounding keeps sounding; the reindex only
  decides who may enter on a future bar.
- Auto ladder thresholds recompute the same way (see § getStats + ladder).

## params.userTracks (persistence)

Identity lives in its OWN ordered array, NOT inside `params.tracks`:

```
params.userTracks = [{ id, label, family, voiceSet, colourToken, manifest? }]
```

- Order = creation order = append order everywhere (engine order, sequenced
  order, staging, ladder). Cap 6; entries past the cap are dropped from the
  TAIL.
- `params.tracks[id]` is an ordinary track entry, built by the same
  `defaultTracks()`/`sanitiseTracks()` code paths as a built-in: state, voice,
  level, randomness, driftRate, swing, density, hold, mono, glide, vary; plus
  `dissonance` when melodic (melodic ⇒ tuned), plus `lanes` when percussive,
  plus `sequencers`/`sequencer` — EVERY user track is sequenced (see below).
- Defaults for a freshly added track: `state: 'on'` (the user just made it —
  it should sound), `voice: DEFAULT_TRACK_VOICES[voiceSet]`, level 0.8,
  randomness {0.35, 0.65}, driftRate 1, swing null, density null, hold false,
  mono false, glide 0, vary all null (no voice wander — the pad/texture 0.15
  is a built-in-specific ruling), dissonance the standard default.
- SANITISER ORDER: `sanitiseUserTracks(value, base)` runs FIRST and its result
  defines the id set `sanitiseTracks` then iterates (built-ins first, user
  tracks in stored order). `params.userTracks` is AUTHORITATIVE on setParams —
  addTrack/removeTrack are sugar that write it. That is what lets loading a
  preset recreate tracks with no extra API call.
- Unknown ids: a `params.tracks` key that is neither a built-in nor a
  surviving `userTracks` id is DROPPED SILENTLY, exactly as today. A
  `userTracks` entry that fails validation is dropped whole (its `tracks`
  entry then orphans and drops with it) — never coerced, never renamed.
- Compat: absent `userTracks` ⇒ zero user tracks ⇒ params byte-identical to
  v0.0.24. Every stored preset, share link and `ambi4:`-namespaced settings
  blob written before this window loads unchanged. A user track added and
  later removed leaves nothing behind.
- `getParams()` returns `userTracks` in its copy; `copyParams` deep-copies it.

## Share semantics (v10 code-never-travels)

- A manifest is JSON DATA — dial ranges, labels, a voiceSet name. It is not a
  function body, carries no source string and no URL. It therefore TRAVELS in
  a saved preset and in a `#p=` share link, like every other param. The v10
  boundary is unmoved: user CODE (`ambi4:code:<seam>` voice bodies) never
  travels and is never referenced by id from a manifest.
- The sanitiser strips any key not in the schema below on the way in. A
  manifest field that looks like code (a string containing `function`, `=>`,
  `import`, or any `javascript:`/`data:` URL) is grounds to reject the whole
  manifest, not to clean it.
- Receiving device, track it has never seen: RECOMMENDED DEFAULT is GENERIC
  SYNTHESIS WITH A NOTICE — create the track, sound it through the built-in
  `voiceSet` the manifest names (always present), apply every dial the local
  PATCH_SCHEMA knows, drop dials it doesn't, and surface one line under the
  share note: "Added N custom tracks — their custom voice code isn't included
  in shared links." Rationale: dropping the track silently orphans its mix
  levels and sequencer grids and the arrangement arrives wrong; refusing loses
  the whole preset over one track.
  THIS IS A USER DECISION — recorded here as a recommendation, not a ruling.
  The alternatives, if Martin picks differently: drop-with-notice (safest
  sonically, loses arrangement) or refuse (never silently wrong, worst UX).
- Size: a manifest is ~200-600 bytes per track; six of them stay well inside
  the few-KB share-link budget the fragment already carries losslessly.

## User instrument manifest (JSON schema)

```
{
  schema: 'ambi4.instrument/1',
  id, label,
  kind: 'melodic' | 'percussive',
  voiceSet: 'pad'|'bass'|'melody'|'texture'|'arp'|'percussion',
  voice: <a voice id within that set>,
  colourToken?: '--track-…',
  dials: [{
    section: 'source'|'filter'|'adsr'|'sends',
    field:   <a PATCH_SCHEMA field name in that section>,
    label:   <≤ 20 chars>,
    min, max, default,                       // finite; min < max; min ≤ default ≤ max
    curve?: 'linear'|'log',                  // default 'linear'
    unit?:  ''|'%'|'Hz'|'s'|'st'|'ct'|'oct'|'dB'|'x',
    rangeable?: boolean                      // default true; false pins it single-valued
  }]
}
```

- `id`/`label`/`kind`/`voiceSet` mirror addTrack's rules and must agree with
  the track they belong to; disagreement rejects the manifest.
- `dials` cap 24. A dial naming a field PATCH_SCHEMA does not know is DROPPED
  (never rendered): a control the engine will silently drop is worse than no
  control — the standing v21 gate rule. A dial whose min/max fall outside the
  schema's own range for that field is clamped to the schema range, not
  rejected.
- Duplicate `field` within a section: last wins, earlier dropped.
- MAPPING onto the page dial-builder: the manifest compiles to exactly what
  `VOICES[track][voiceId]` already publishes, so the builder needs no new
  branch —
  - `controls` ← `{ source: [fields…], filter: [fields…], adsr: true|[…],
    sends: true|[…] }`, each section's array being the manifest's fields for
    it; a section with no dials becomes `false` and vanishes from the editor.
  - `defaults` ← a patch object of each dial's `default`, merged over the
    named voice's own defaults.
  - the per-field min/max/unit/curve table feeds the same spec shape the v19
    sculpting groups already use (`{field, min, max, fallback, unit}`), so
    read-outs carry units and double-click-to-default works untouched.
  - `engineType` ← the named voice's own `engineType`; the "custom [engine]"
    selector-honesty rule (v17) applies unchanged.
- A manifest is OPTIONAL. A user track without one is a perfectly good track:
  it gets its voiceSet's stock editor.

## Percussion lanes

- A user percussive track gets its OWN lane set: `params.tracks[id].lanes`,
  defaulting to a copy of the three built-in lanes (low/mid/high, kinds to
  match). Lanes are already per-track in the params shape; nothing is shared
  with the built-in kit.
- The three built-in lane IDS are undeletable inside EVERY percussive track —
  they are the kinds the drum voices actually synthesise, and every legacy
  `steps: {low, mid, high}` grid and stored `perKind` patch is keyed by them.
  User lanes append per track, cap 8 lanes PER TRACK.
- Caps compose multiplicatively and that is accepted: 12 tracks × 8 lanes is
  the paper worst case (7 percussive tracks = 56 lanes). Lanes cost nothing
  until they fire; the v9 power governor's polyphony cap is global and
  unchanged, and it is the only backstop needed.
- A user MELODIC track has no lanes: one step grid, like melody/bass/arp.
- EVERY user track is sequenced (appended to `sequencedTracks()` after
  `percussion`). A user track has no bespoke generative pass — there is no
  motif engine, bass groove or chord wash written for it — so its material
  comes from its step grid (manual, or the Markov auto mode every sequenced
  track already has) with pitch from the current chord when melodic.

## getStats, ladder, mix defaults

- `getStats().perTrack` is keyed by `trackOrder()`: six keys in the same order
  with zero user tracks, +1 key per user track after them. `nodesEstimate`
  counts `NODES_PER_TRACK` for each. `getResolved().tracks`,
  `getResolved().patches` and `getAnalysers()` gain their keys the same way.
- Auto ladder: user thresholds are `0.6 + 0.05 × (ordinal + 1)` → 0.65, 0.70,
  0.75, 0.80, 0.85, 0.90. Rising and above percussion's 0.6, so the active set
  stays a PREFIX of `trackOrder()` — the property the v22 ladder proof asserts,
  now asserted over the instance list too.
- Default mix (the decorative tier, deliberately not the pad/bass tier):
  - melodic: `{ level: 0.2, dry: 0.7, reverb: 0.45, delay: 0.25, tone: 6500 }`
  - percussive: `{ level: 0.24, dry: 0.85, reverb: 0.3, delay: 0.12, tone: 9000 }`
- No auto-scaling of built-in levels when user tracks arrive: a built-in's
  gain must not depend on how many tracks the user made. Twelve tracks at full
  tilt lean on the master's 0.7 headroom and the glue compressor, which is
  what they are for.

## Consumer contract beyond the fixed six

- Colour: a user track publishes `colourToken: '--track-user-N'` (N = 1-6).
  The theme MUST define those six vars — hues spaced away from the built-in
  six. Where a var is missing, the existing fallbacks already cover it:
  `scope.js` hashes list position to a hue, `visualiser.js` `laneAccentFor`
  parses with a computed fallback. Nothing throws on an undefined var today
  and nothing may start to.
- The public view keeps EXACTLY its five keys (id, label, builtin,
  colourToken, family). No sixth field, no literal colour — the v22 key-set
  pin is a contract, and a literal colour would bypass theming.
- Hardcoded fallback tables stay SIX FOREVER: `FALLBACK_TRACKS`
  (index.astro), `MULTISCOPE_ALL_TRACKS` (scope.js), the visualiser's own
  fallback. They are the branch an engine bundle WITHOUT `getTracks()` boots
  on; an engine with `addTrack` necessarily has `getTracks()`, so that branch
  can never meet a seventh track. Corollary for the boot gate: the 1:1
  fallback-vs-registry assertion must compare against the MODULE `getTracks()`
  (built-ins), not the live instance list, or adding a track in the harness
  fails a test about something else.
- SSR: `index.astro` renders six rows at build time from the module export;
  user rows are appended CLIENT-side after the engine boots, into a container
  BELOW the built-in six, so no existing control moves (v18 hardware-panel
  rule — an insertion below is not a layout shift of anything above).
- `scope.attachMultiScope` reads the registry once at attach. A track added
  after attach is not traced until re-attach; the legend must not grow
  silently. Re-attach on registry change is the page's call to make.

## Test plan

Engine (`tests/engine-smoke.mjs`), named:

- `identity: zero user tracks returns the module's own frozen lists` —
  `trackOrder() === TRACK_ORDER`, `trackViews() === TRACK_VIEWS`, object
  identity not deep equality.
- `identity: the v22 proofs still pass with the accessors in place` — the six
  existing proofs run unedited. A failure here is a behaviour change.
- `byte-identity: the same seed produces the same note stream with no user
  tracks` — two runs under a fixed `options.rng`, note streams deepEqual, one
  of them on an engine that has had a track added AND removed.
- `addTrack: the id grammar accepts and rejects exactly what it says` — table
  test over good/bad ids, asserting `err.code`.
- `addTrack: built-in and reserved ids are refused` / `addTrack: duplicate id
  is refused` / `addTrack: family and voiceSet must agree`.
- `addTrack: the twelfth track is the last one` — cap, `RangeError`, code
  `'cap'`.
- `addTrack: canAddTrack returns the code addTrack would throw` — same spec
  through both paths, no throw from the probe.
- `addTrack: the new track appears in getTracks(), getParams().tracks,
  getStats().perTrack, getResolved() and getAnalysers()` — one test, five
  surfaces, order asserted.
- `addTrack: a track added mid-playback sounds from the next bar and draws no
  rng at chain build`.
- `removeTrack: built-ins throw, unknown ids return false twice`.
- `removeTrack: in-flight notes ring out and the chain is dropped after them`.
- `removeTrack: staging and the ladder compact` — indices contiguous,
  `stageBars()` shrinks, active set stays a prefix.
- `params: userTracks round-trips through setParams/getParams` including an
  over-cap array (tail dropped) and a malformed entry (dropped whole).
- `params: an orphan tracks entry is dropped and a pre-v23 blob is unchanged`.
- `manifest: dials naming unknown fields are dropped, out-of-range min/max are
  clamped, a code-shaped string rejects the manifest`.
- `manifest: compiles to a controls/defaults pair the voice-editor shape
  accepts`.
- `lanes: a user percussive track gets its own three lanes; built-in lane ids
  are undeletable in it; the eighth lane is the last`.
- `ladder: user thresholds rise above percussion and keep the set a prefix`.

Page (`tests/page-boot.mjs`), named:

- `v23 user tracks — probe-gated` — the Add Track control renders ONLY where
  `engine.canAddTrack` is a function; absent engine support ⇒ absent control
  (present-but-does-nothing is the bug).
- `v23 fallback table is still the built-in six` — `FALLBACK_TRACKS` matched
  1:1 against the MODULE registry, user tracks excluded from the comparison.
- `v23 a user track row appends below the built-in six` — nothing above it
  moves (v18).

Standing discipline: with zero user tracks EVERY built-in behaviour is
byte-identical. Any test that has to be "updated" to accommodate this window
is a defect report, not a test edit.

## Staged delivery (4 commits, each safe as the last landed)

1. `floor/layer split` — accessors replace the direct table reads inside
   `createEngine`, `STAGE_BARS` becomes `stageBars()`, module helpers gain
   their defaulted trailing argument. Zero user tracks exist, zero public API
   changes, the identity + byte-identity tests are the whole gate. Landing
   alone changes nothing observable.
2. `params.userTracks` — schema, sanitiser ordering, defaults, persistence,
   share round-trip, `ensureTrackChain`/teardown, staging + ladder + mix +
   stats over N tracks. A hand-written params blob can now create a track, so
   the entire runtime is exercised head-lessly with no UI at all.
3. `addTrack / removeTrack / canAddTrack` — the API over commit 2's machinery,
   plus mid-playback add and ring-out removal. Still no UI: the console and
   the smoke tests are the users.
4. `manifests + UI` — manifest schema and sanitiser, the controls/defaults
   compile, the Add Track surface, `--track-user-N` theme vars, the
   shared-preset notice. The only commit that can move a pixel.

Out of window: live MIDI/QWERTY capture, audio-in tracks, per-user-track
generative passes, and any code seam for a user voice body (v10 stands).

## v23 cross-reference (chair)
The window-3 build MUST clear the seven hard blockers in
docs-private/window3-addtrack-premortem.md (frozen tables vs instance layer;
one-shot graph build; voiceFor unknown-id throw; unguarded page listeners on
build-time rows; sanitiser dropping unknown track/patch keys; no generator for
user tracks — resolved by v23's every-user-track-is-sequenced rule; getStats
deref). New tests over repaired tests: the suite has 7-track fixtures but zero
runtime-add coverage.

---

# v24 — bass craft pass (the second failed verdict)

The v14 groove rework (anchor pulse + syncopation cells + per-section
development) answered the FIRST verdict, "it's a rhythm instrument, not a
low-pitch random". It failed the second: "still definitely the weakest link".
This pass is diagnosis-led and touches feel only — the v8 harmonic contract
(root on every felt pulse, fifth/octave off the pulse only, approach notes only
into a change) is unchanged and still property-tested.

## What was actually wrong (evidence, not theory)

1. **The groove was re-rolled every bar under three of the five structure
   presets.** `ensureBassGroove` keyed its cache on `round3(sectionIntensity())`,
   and `waves` (a cosine) and `build` (a ramp) hand out a fresh intensity for
   EVERY bar. The v14 groove therefore never engaged at all under either — the
   line really was a per-bar random walk, exactly as the first verdict said.
2. **Timing was generic per-note humanisation.** `timingNudge('bass')` drew an
   independent ±25 ms either side of the grid for every note. Scatter either
   side of the beat reads as unsteady; a bassist picks one relationship to the
   beat and keeps it.
3. **Note length was per ROLE, not per STEP.** The gate table had three entries
   (anchor/pulse/offbeat), so every pulse in a bar was one length. On the shipped
   mono bass a note that reaches the next onset is SLURRED into it and anything
   shorter is re-struck and cancelled at that onset (`releaseMono` →
   `cancel(at)`, a 50 ms fade from the new note's onset) — so a bar whose steps
   share one gate has exactly one articulation, whatever that gate is.
4. **The 0.1 s duration floor swamped the gate.** `Math.max(0.1, span * gate)`
   is longer than a clipped sixteenth at anything above a slow tempo, so every
   short note in the line rendered at exactly 100 ms regardless of its gate.
5. **Ghosts were not quiet.** 0.42 against a 0.74 pulse is ~5 dB — a slightly
   soft note. The anchor accent was 0.85 against 0.74, about 1 dB: inaudible.
6. **No fills.** `bassGrooveOp` had ghost/push/simplify/double, all micro. A line
   that never turns around is a loop.
7. **The octave pop could leave the bass register.** `root + 12` off a high chord
   root lands in the tune's octave (MIDI 64 was observed).
8. **With no kit playing, every non-anchor pulse was an independent coin flip.**
   The kick-lock path gave the line a spine; the drummerless path gave it a
   density.

## The contract as it now stands

- **Groove identity** = feel (staccato/held/mixed) + articulation cycle +
  anchor grid + pocket + syncopation cells. Stated once per section-energy BAND
  and developed, never re-rolled per bar. The cache key bands section intensity
  to the nearest quarter; the four-/eight-bar development count belongs to the
  SECTION label, so a swell that restates the groove does not restart it.
- **Pocket**: ONE lay-back constant, in seconds, shared by every bass note of
  the section (`bassPocketSeconds`, exported). Never early. Scaled by the
  track's `vary.timing`, so `vary.timing 0` still means machine-tight and the
  shipped default sits a few ms behind. The bass takes NO per-note timing
  humanisation — that is the whole point.
- **Articulation**: `BASS_ARTICULATIONS` multiplier cycles (even / longShort /
  shortLong / holdOne) applied across the pulse spine at build time, clamped to
  0.12–1. Which notes ring into the next and which stop short is part of the
  line's identity and is identical every bar the groove is stated. The bar's
  last note commits: a `held` groove rings across the barline (gate 1, handed
  over by the mono glide), anything else lifts (gate ≤ 0.45).
- **Duration floor**: `min(0.06 s, span * 0.6)`, so the gate renders and a short
  slot is never stretched past itself.
- **Velocities**: accent 0.92, pulse 0.68, off-pulse 0.58, ghost 0.25, fill 0.74.
  `BASS_GHOST_CEILING` (0.34) is the exported bound a ghost must still be under
  after velocity jitter and the engine's clamp.
- **Fills**: op `fill`, only on the last bar of an eight-bar count (so never in
  the opening bars of a section), probability scaled by section intensity, never
  said twice running, and off at randomness 0. A fill CLEARS the bar's tail and
  lays a 2–3 note run off the pulse into the next bar; every felt pulse survives
  it, still voicing the root, and the run's last note is what the approach logic
  re-pitches towards the chord ahead.
- **Register**: `BASS_RANGE` = MIDI 28–55 (E1–G3). The octave tone pops up if it
  fits, drops an octave if not, and stays on the root if neither does.
- **Internal pulse**: with no kit to lock to, the groove draws a stride through
  the bar's felt pulses and treats it exactly as it treats a kick — chance 1 on
  the grid, a (thinner) density draw off it. One code path, drums or not.

## Known ceiling, NOT fixed here (owner: engine-voices.js)

True staccato is not reachable from the engine. The bass voices' envelopes are
`sub` attack 0.12 s / release 0.75 s, `round` 0.05/0.55, `breath` 0.18/0.9, and
`bassSub` computes `hold = max(0.1, dur - attack)`, so the shortest note any of
them can sound is roughly one second of envelope. Note length therefore reads as
slur-vs-re-strike and as where a phrase's tail decay begins, not as silence
between notes. Shortening the patch ADSR per note would work but changes the
filter path (`mainFilter` switches from note-tracking to the patch cutoff and
adds a trim node), which is a timbre and node-count change outside this pass.
