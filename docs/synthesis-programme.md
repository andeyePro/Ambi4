# Synthesis and authoring programme – the decisions

Status: **decided 2026-09-25 by the build (chair + planner), open to the owner's
veto; first slice shipped in the same commit as this file.** The brief, in the
owner's words: everything the author could do in code when writing the stock
genres and their voices must be doable by a human, intuitively, accessibly and
expressively; decide which methods of synthesis the app should have, such that
breadth and depth never get in the way of a new user making great-sounding
music; and give people a way to explore and learn synthesis that actually helps
them reach the sound in their head.

This document (a) states what "creating a genre in code" and "creating a voice
in code" consisted of, so parity can be measured rather than felt, (b) rules on
every synthesis method, with the reason, (c) states the disclosure rule that
keeps breadth out of a beginner's way, (d) designs the learning layer, and (e)
sequences the build. The UX brief it serves is in brain2, `Ambi4-UX-philosophy`;
the dial and modulation plan is `docs/dial-control-plane-plan.md`; the param
contract is `docs/engine-v2-contract.md`.

---

## 1. What the author could do in code, and what a human can do today

### 1a. A genre

A genre is one JSON file in `src/data/genres/`, compiled at runtime by
`src/scripts/genre-compiler.js` into a full engine params object. Its fields:

| Field | What it decides | Human can edit it today? |
|---|---|---|
| `essence.bpm` [lo, hi] | tempo draw | no (only the compiled tempo, after the draw) |
| `essence.swing` [lo, hi] | swing draw | no |
| `essence.timeSignatures` (weighted) | metre draw | no |
| `essence.modes` (weighted) | scale draw | no |
| `chordLanguage.progressionGrammar[]` | chord loops | **yes** (Rules panel, v0.0.161) |
| `chordLanguage.substitutionRules[]` | chord swaps with odds | **yes** (Rules panel) |
| `chordLanguage.extensionBias` | chord colour → complexity | no |
| `chordLanguage.harmonicRhythm` (weighted) | bars per chord | no |
| `grooveGrammar.anchorPatterns[]` | kit or density guidance | **yes** (Rules panel) |
| `grooveGrammar.syncopationCells[]` | bass figures | **yes** (Rules panel) |
| `grooveGrammar.articulation[]` | bass articulation menu | no |
| `grooveGrammar.pocketMs` [lo, hi] | bass timing spread | no |
| `instrumentation.perTrack` | state, voice, level, randomness per track | per track, yes; as part of the genre, no |
| `instrumentation.patches` | the voices' patches | per voice, yes (voice editor); as part of the genre, no |
| `instrumentation.reverbTail` | reverb tail | as a dial, yes; as part of the genre, no |
| `energyArc` (weighted) | structure draw | no |
| `dissonanceRange` [lo, hi] | dissonance band | no |
| `densityBias` | density multiplier | no |
| `fallbackLists.progressions[]`, `.grooves[]` | the recognisable core | grooves yes; progressions folded into the grammar rows |
| `defiance[]` | the genre's own "defy me" dials | no |
| name, slug, cluster, one-liner | identity | no |

Nothing lets a human **name and keep** a genre of their own: the picker holds
the twelve built-in slugs, a share link carries `origin (slug + seed) + diff`,
and a preset is a compiled setup, not a set of rules that draws new setups.

### 1b. A voice

A voice is a `play()` function in `src/scripts/engine-voices.js` plus its
`DEFAULTS`, `CONTROLS` and `ENGINE_TYPES` entries. Thirty-six exist. What a
human can edit is the **patch**: the registry rows in
`src/scripts/param-registry.js` (source, filter, adsr, sends, and the sculpt and
call groups on the voices that carry them). What the author could do and a
human cannot:

| Technique | Where it lives in code | Exposed? |
|---|---|---|
| two-operator FM (ratio, index, index decay) | `fm()` helper; bell, keys, tines, sparkle, crystal with literal ratios | no |
| additive partials (PeriodicWave) | glass (five stretched partials), stab (six drawbars) | no |
| modal struck-object models (overtone ratios + per-partial decays) | chimes, marimba; `membrane()` for drums | no |
| granular noise clouds | `grainField()`, cloud | sculpt dials only |
| formant sweeps | call voices, choir | call dials only |
| wave folding | `foldCurve()`, any stack voice | yes (Fold) |
| oscillator morph sine→triangle→saw→square | `shapeWave()` | yes (OSC 1/2) |
| detune in three meanings (pair, stack, scatter) | `DETUNE_MODES` | yes (Detune/Spread) |
| a new voice from nothing, with a name | writing a function | no |

Sample playback, wavetable playback, PWM, hard sync, ring modulation and
Karplus–Strong strings do not exist in the code at all.

---

## 2. The ruling on every synthesis method

The list is Wikipedia's *Category: Sound synthesis types* plus the ones the
brief names. The test for each: would a person who has a sound in their head
reach it sooner with this method than without, in a browser, with no samples,
no recordings and no AI, on a phone? A method that adds breadth without adding
reachable sounds is declined, however famous.

| Method | Ruling | Reason |
|---|---|---|
| **Subtractive** (analogue modelling) | **keep as the base** | It is the whole editor today: morphing oscillators, three detune meanings, fold, filter with envelope, ADSR. Every other engine below still ends in this filter and this envelope, so what a beginner learns here transfers everywhere. |
| **FM** (two-operator) | **add, as an engine section** | Five voices already are FM with their ratios hard-coded. Bells, electric pianos, tines, glassy arps and metallic textures are FM sounds people have in their heads and cannot reach by filtering a saw. Three dials cover it: Ratio (harmonic at whole numbers, bell-like between; the voice's literal is its default), Depth (a MULTIPLIER over the voice's own velocity-scaled index law, default exactly 1, because the shipped indexes are `f * (1.5 + 2.5 * v)` and the like, which no flat field could reproduce), Bite (the index decay, the voice's literal as default). At the defaults the graph is the one that ships. |
| **Additive** | **add, as drawbars** | Glass and Organ stab already are additive. Eight partial levels plus a Stretch dial is the organ-drawbar model everyone can read at a glance. The levels are MULTIPLIERS (default 1) over the voice's own partial table and Stretch is an OFFSET (default 0), because glass's stretched partials are not one stretch law and plain drawbar values would change the shipped sound. A voice made from the Additive template starts from a harmonic 1..8 table, where the same dials read as drawbars. Organ stab is reclassified from physical to additive, so the engine label teaches the right thing. It is also the mechanism minimalism needs for a phasing process (TODO). |
| **Physical modelling – modal** | **add, as an engine section** | Chimes, marimba and every drum body are modal already. Material (an enumeration of overtone-ratio tables: wood, metal, glass, skin; the voice's own table is its default), Hardness (strike brightness) and Damping (a multiplier over per-partial decay, default 1) reach struck and rung objects no filter can. No Size dial: the note already sets the pitch, so a size dial would either fight the note or do nothing. |
| **Physical modelling – plucked string** (Karplus–Strong, digital waveguide) | **defer until an AudioWorklet exists** | A feedback loop through a `DelayNode` cannot go below 128 samples, so at 48 kHz the shortest string is ~375 Hz: nothing above F4 can be modelled. Nylon and Upright stay subtractive. When the worklet lands the section is Pluck position, Damping, Brightness; it joins the same disclosure rule. |
| **Banded waveguide** | decline | A special case of modal plus a delay line; modal covers the reachable sounds. |
| **Noise / granular noise** | **keep as the noise family** | Wind, rain, surf, grain clouds are sculpted noise; the sculpt and burst dials already are the interface. Granular over samples is declined with samples. |
| **Formant / vowel** | **keep the call and choir sweeps; add a Vowel filter type later** | The call dials already reach birdsong; a vowel filter type (two tracked formants with an A–E–I–O–U dial) is one cheap addition to the filter menu, after the engine sections. |
| **Wave folding / distortion / phase distortion** | **keep Fold; add saturation as an effect** | The folder already is this family. Drive and saturation belong on the track and the master bus, not in the voice, and are the cheap default-sound win TODO already names. |
| **Ring / amplitude modulation** | later, as a Source option | One gain node. Low priority: FM reaches nearly everything ring mod does and is already there. |
| **PWM, hard sync** | **defer until an AudioWorklet exists** | Web Audio has no oscillator sync at all, and pulse-width modulation needs either a worklet or a stack of PeriodicWaves crossfaded per width. Both join the plucked string on the worklet, with the same disclosure rule. |
| **Wavetable** (user tables) | **decline** | The continuous morph IS a one-dimensional wavetable, and a spread on OSC 1 already scans it. User-drawn tables add breadth without a sound a person can name. |
| **Sample-based, concatenative, linear arithmetic** | **decline** | No samples anywhere, by design: nothing to license, nothing to download, nothing that is a recording. The one exception in the future is the person's own microphone (the audio-in track, v0.2.x), which is an input, not a library. |
| **Vector** | decline | Crossfading four sources by a joystick is the blend-by-weight the voice picker already does per section, and the mix dial does per note. |
| **Scanned, vowel–consonant, Essynth** | decline | No reachable sound a listener would name; research methods. |

So the engines are **Subtractive, FM, Additive, Modal, Noise**, with Hybrid for a
voice that genuinely runs two. That is the `ENGINE_TYPES` table the voice table
already declares, made real as sections a person can turn.

---

## 3. The disclosure rule: breadth never in the way

- **The engine is a property of the voice, never a mode the user picks up
  front.** A beginner picks Bell and sees an FM section with three dials and a
  one-line hint; they never see FM dials on a pad. Same rule the Spectral,
  Motion and Burst rows already follow for noise voices: a section appears only
  when the voice carries it, and nothing moves when it appears.
- **Simple stays four dials.** Nothing in this programme touches the Simple
  tab. Advanced opens with the same four.
- **Every new dial is a registry row** (`param-registry.js`), so the sanitiser,
  both editors, the share wire and the modulation graph learn it once. A dial
  with no row does not render.
- **Every default is the voice as shipped.** An FM Depth of 1, a Stretch of 0,
  a Material at the voice's own value change nothing. A saved link from before
  the section existed sounds exactly as it did.
- **A new voice starts from an engine template, not from nothing.** "New voice"
  offers Subtractive, FM, Additive, Modal, Noise as five starting voices with a
  name box; the result lives on this device, appears in the picker under the
  track it was made on, and travels in a link as data (the instrument manifest
  in the contract doc), never as code.
- **A dial says what you will hear.** Every core dial gets the same kind of
  hint the sculpt dials have: perceptual, present tense, what changes when you
  turn it. No dial anywhere is a bare label. The hint is a column of the
  registry row, so a dial's domain, unit, curve and its words live in one
  place and both editors read them; a row without a hint fails the registry
  contract.
- **The editor names the engine.** A chip at the top of every voice editor
  says which engine the voice is (Subtractive, FM, Additive, Modal, Noise,
  Hybrid) and one sentence of what that means, so the first time a person
  meets an FM section they have already been told what FM is. The picker's
  option text stays a name: drives match on it, and the Simple tab stays
  uncluttered.

---

## 4. The learning design: from the sound in your head to the dial

Four layers, each usable alone, cheapest first.

1. **Hints on every core dial.** Cutoff: "How much of the top end gets through:
   left is muffled, right is bright." Resonance: "A ring at the cutoff: a little
   is body, a lot is a whistle." Attack, Decay, Sustain, Release, Reverb, Delay,
   OSC 1, Mix, Detune, Octave, Fold, and the new engine dials likewise. Shipped
   as `hint` strings on the knob specs, read by the same `describe()` every
   sculpt dial uses, so keyboard focus reads them too.
2. **"What makes this sound", generated from the patch.** A line under the
   dials of every voice editor, written by the page from the live patch object,
   in words: "Two saws 12 cents apart, low-pass at 900 Hz opening with each
   note, half a second to fade." It updates as the dials move, so the
   instrument is knowable (the transparency rule) and the words teach the
   vocabulary by use. Pure function of (engine type, patch): testable in Node.
3. **Engine lessons as chapters.** One chapter per engine, on a real voice on a
   real track: "Subtractive in three moves" (open the filter, add resonance,
   shorten the release), "FM in three moves" (ratio to 3.5, depth up, bite
   down), "Additive", "Modal", "Noise". Each step names the dial, says what to
   drag and what to listen for. The main tour is capped at fourteen steps by
   its own test, so chapters are separate step arrays opened from the engine
   chip in the editor, rendered by the same tutorial panel and held by the
   same tutorial-smoke rules plus one more: a chapter's targets resolve inside
   its own voice's editor. A drive checks every "turn this" step moves the
   engine's stored value.
4. **The sound-in-mind finder.** Pick words, not methods: bright/dark,
   plucky/sustained, clean/gritty, warm/glassy, thick/thin, still/moving. The
   finder names the engine, a starting voice on the current track, and the two
   dials that move it there, and sets them. It is a lookup over the voice table
   and the hints, not an AI, and it says why in one line. Every row's claim is
   held by measurement, not by taste: bright moves the spectral centroid up,
   plucky shortens attack-to-peak, sustained raises the RMS at one second,
   moving raises the RMS modulation. A row the render suite cannot prove does
   not ship.

---

## 5. Build sequence

Each unit is one commit, one version, docs in the same commit, proven red on
the old code first. Owner decisions that block a unit are named; nothing else
waits.

| # | Unit | Proves it | Waits on |
|---|---|---|---|
| 1 | this document; a hint on every registry row and so on every dial in both editors; the engine chip in the editor header; Organ stab reclassified additive (v0.0.172) | registry-contract: every row has a hint; page-boot: every dial in every editor carries its hint as its accessible description, and the chip matches the voice table | – |
| 2 | the four parked engine faults (`tests/pending/engine-fixes-v0.0.171.mjs.txt`; `quantiseCapture` first, it is user-visible) | the parked tests are red on v0.0.171 and go green; a drive records a take finer than a sixteenth and finds no holes | – |
| 3 | "what makes this sound", a pure describer over (engine, patch), under the dials of every editor | a Node suite: every stock voice yields a sentence and every number in it equals the patch value; page-boot: the line changes after a dial commit | – |
| 4 | FM section: `patch.fm.ratio`, `.depth`, `.bite`; `fm()` reads the patch; bell, keys, tines, sparkle, crystal defaults are their literals | voices-smoke graph snapshot of the five voices unchanged at defaults; a render suite: depth 2 raises bell's spectral centroid, a ratio change moves the first sideband to f·ratio; red on old code because the sanitiser drops the fields | – |
| 5 | Additive section: `patch.additive.p1..p8` (multipliers), `.stretch` (offset); glass and stab read them | FFT partial amplitudes track the levels; frozen reference unchanged | – |
| 6 | Modal section: `patch.modal.material` (enum), `.hardness`, `.damping`; chimes and marimba read them. The membrane kits do NOT: a drum's skin is a pitched bend over noise with a per-sound envelope the kit editor already owns, and a material table has nothing to select there; a kit-material unit, if ever, is its own row | the overtone table swaps with the material; hardness tilts the upper partials and scales the click; damping shortens every ring; the defaults rebuild the shipped stack exactly | – |
| 7 | Ring/AM as a Source option; Vowel as a filter type | sidebands at f±m; vowel peaks land on the formant table | – |
| 8 | "New voice" from a template (Subtractive, FM, Additive, Modal, Noise, each backed by a stock voice), named, per device through prefs, in the picker, compiled through the contract's instrument manifest | the manifest sanitiser cases in the contract (unknown field dropped, out-of-range clamped, code-shaped string rejected); a drive makes a voice, reloads through about:blank, and finds it in the picker with its patch | – |
| 9 | a user voice travels in a link as a manifest (schema stamp, size cap) | sharelink-drive round trip; a link carrying code is refused | – |
| 10 | Rules panel, essence I: bpm and swing as spread dials, time signatures, modes, harmonic rhythm | genre-rules-drive asserts the compiled values the engine stores; genre-smoke: the compile stays deterministic with edited fields | – |
| 11 | Rules panel, essence II: energy arc, extension bias, dissonance, density, per-track instrumentation and the current patches captured into the genre | as 10 | – |
| 12 | "Save as my genre": named, per device, in the picker, favourites-aware | a drive saves, reloads, picks it, and the same seed compiles to the same setup | – |
| 13 | a user genre travels in a link as a diff against its origin (schema stamp) | sharelink-drive round trip; a size assertion | – |
| 14 | defiance dial authoring (param, label, range) | the drive asserts the dial moves the engine's stored param inside the authored range | fromClaude 11/12 only if the dial needs a routing address; the executor checks first |
| 15 | engine lesson chapters, five of them | tutorial-smoke extended to chapters; a drive checks every "turn this" step moves the stored value | 4, 5, 6 |
| 16 | the sound-in-mind finder | the render suite proves every row by measurement; one row is broken on purpose to prove the suite bites | 4, 5, 6 |
| later | saturation on track and master (the FX backlog); plucked string, PWM and hard sync on an AudioWorklet | onset-render; a pitch test above F4 | a worklet |

Standing rules for every unit: docs in the same commit; every engine unit
extends the describer of unit 3 to its own section; every unit that adds patch
fields stamps the share schema, adds the rows to both spec tables and runs
onset-render; the frozen audio-reference stays green WITHOUT `--update`, which
is the proof that the defaults equal the old literals. The genre units (10 to
14) do not depend on the engine units and can interleave with them.

The modulation graph's visible half (sockets, the sampling dial, phase 3
gestures) stays where the dial plan left it: blocked on fromClaude 10, 11 and
12. Nothing above depends on those answers; the address grammar they settle
will name the new rows exactly as it names the old ones.
