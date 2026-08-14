# Dial + modulation control plane — plan

Status: **owner-decided 2026-07-27; the DIAL half shipped, the modulation graph
has not** (corrected 2026-07-31 — the audit found this file still claiming
nothing was built, while its decisions had been live for dozens of versions).
Shipped: spreads on every rangeable dial (v0.0.56/74), the hub/annulus gesture
model with vertical primary and angular assist on a fine pointer only
(v0.0.65/66), grip-look rules, zero-on-hub-tap and double-click-to-default,
click-to-type, spread SHAPES (Drift/Rise/Fall/Swell, v0.0.72), and the
refusal-with-a-reason for the one dial ruled to stay single (v0.0.102). NOT
built: sources (envelopes, LFOs, macros) driving arbitrary destinations, one
slot per destination, patch sockets on the dials — the "rest of the patching
system" TODO item, which also owns Energy's filter-openness axis. The UX brief
this serves is in brain2, `Ambi4-UX-philosophy`.

Goal, in the owner's words: simple and unintimidating to start, every last
nuance reachable later, and *all dials working exactly the same way*.

This document (a) corrects the factual picture the design was first built on,
(b) records the decided design, (c) sequences the build, (d) names the risks.

---

## 1. How variation actually works today

The proposal assumed the value inside a min-max span is chosen by the Randomise
dials, which follow the track's Randomness macro. **That is not what happens.**
There are two separate systems, and neither of them is the other.

### 1a. The min-max span is resolved by a per-parameter random walk

`resolveRange` (`ambient-engine.js:3952`):

```js
rangeValue.min + (rangeValue.max - rangeValue.min) * walk(track, param)
```

- `walk` keeps **one bounded random walk per `track:param` key**
  (`ambient-engine.js:3907`). Every ranged parameter therefore already varies
  *independently* of every other one.
- The walk steps **once per bar**, by ±0.15 scaled by the track's `driftRate`
  (`WALK_STEP`, `walkStep`), reflecting at 0 and 1 so probability doesn't pile
  up against the clamp.
- `driftRate` is exposed as the per-track **"Drift rate"** dial, 0.02×–1×
  (`index.astro:4132`). That is the *only* user control over how a range is
  traversed.
- A held or frozen track stops its walks entirely (`advanceWalks`).

### 1b. The Randomise row is a different axis

`VARY_KEYS` = Voice, Volume, Pitch, Timing, Pan (`index.astro:999`). Each dial
has an Auto detent at raw 0 meaning "follow this track's Randomness macro";
raw 1–21 map to an explicit 0–100% override (`varyAmount`,
`ambient-engine.js:3966`).

These control **how much generative variation each aspect receives** — whether
the groove re-rolls, how far the motif develops, velocity jitter, timing
scatter. They do not select a position inside a min-max span. (Confusingly,
the vary dials are *themselves* rangeable, so they too get walked.)

### 1c. Consequences for the owner's three limitations

| Owner's limitation | Verdict |
|---|---|
| No way to add LFO / envelope / follow to a dial | **Correct.** `lfo()` exists (`engine-voices.js:694`) but is hard-wired inside individual voice recipes — e.g. detune wobble on a saw. Nothing is user-addressable, and there is no modulation graph at all. |
| No way to have different elements of a voice vary differently | **Partly wrong, and the real gap is sharper.** They already vary independently — each has its own walk. What is missing is control over *how* each varies: shape is always a random walk, rate is one dial for the whole track, and the step is always one bar. |
| 5 Randomise dials untouched by many, too coarse for others | **Correct**, and worse than stated: they are a *second* modulation system with different semantics from the walk, which is precisely the inconsistency the owner's principle forbids. |

The owner's proposed tiny dial — inherit / note / bar / chord / section — is
therefore not a new feature bolted on. **It is the missing control over a
mechanism that already exists and is currently hard-coded to "bar".** That is
a strong validation of the design.

### 1d. Two smaller corrections

- **Double-click.** It is the reverse of the proposal's description. A *single*
  click on the face toggles min ↔ max mode (`knob.js:927`, gated on
  `allowRange`); a *double* click restores the initial value **and** mode
  (`knob.js:995`). So the collision is real but it is single-vs-double, not
  double-doing-two-things.
- **Ghost.** `ghostValue` today is the kit editor's *"what Common says"*
  reference pointer — a muted second pointer shown when editing a per-drum
  override, with a text fallback when the module lacks `setGhost()`. It is not
  a live value readout. But it is exactly the right substrate: an arbitrary
  second pointer, already drawn, already themed, already tested.
- **Click-to-type is already shipped.** The value readout is its own focusable
  `<button>`; click, Enter or Space swaps it for a number field in the dial's
  own units (`knob.js` v14). No work needed.

---

## 2. The decided design

Owner decisions of 2026-07-27, after review of the draft recommendations. The
UX brief this implements is in brain2, `Ambi4-UX-philosophy`.

### D1 — No click gestures. Vertical drag = value, horizontal drag = spread

Double-click is banned: it excludes people who cannot double-click quickly, and
it misfires for anyone toggling something on and straight back off. But a
click-to-toggle on the ring band fails too — the band between face edge
(`FACE_R` 31) and tick outer (46) is about 10 px on a 56 px mobile dial, far
under the 44 pt touch minimum.

So there is **no click gesture for mode at all**:

- **Vertical drag** moves the value (as today, `DRAG_RANGE_PX` 200).
- **Horizontal drag** opens and closes the spread. Right widens, left narrows,
  fully left collapses to a single value.
- The axis **locks on first movement past ~6 px**, so a diagonal drag is never
  ambiguous.
- Collapsing by dragging the two thumbs together works identically: as the
  spread reaches zero the sockets and tiny dial flash and disappear, and
  releasing confirms.

This deletes the current zone scheme (`drag inside the face edits min, outside
edits max`, plus the ±12° max-thumb grab) along with `CLICK_MS`,
`CLICK_SLOP_PX` mode toggling, and `onDoubleClick`. The stored format stays
`{min, max}` — base-and-spread is a *view* over it, so presets and share links
are unaffected.

### D2 — Tap the centre circle to default; zeroed state is shown, not gestured

Reset moves from double-click to a **tap on the centre circle** — press and
release without moving, no timing requirement of any kind.

- At default: indicators muted grey, centre circle an empty outline.
- Away from default: indicators coloured, centre circle filled.
- The circle is ~40% of the face diameter (≈22 px at the 56 px mobile size,
  ≈38 px at 96 px). Below the 44 pt guidance, but a mis-hit falls through to
  value-adjust, which is harmless, instantly visible and self-correcting —
  the isolation the 44 pt rule protects against does not apply.
- Raise the mobile `--knob-size` breakpoint from 56 px so editor dials are at
  least 72 px.

Users arriving from other synths will still double-click to reset; the muted
grey default state is what teaches them they no longer need to.

### D3 — Modulation depth does not exist. Spread is depth

The draft proposed a depth control in the spare bay. **Dropped — the owner is
right.** Modulation spans exactly the min-max range, so a narrow span *is*
shallow modulation and a wide span *is* deep. A separate depth control would be
a second way to say the same thing.

Two consequences follow directly:

- A single-value dial has nothing for a patch to modulate, so **sockets and the
  tiny dial do not exist on a single-value dial**. They appear when spread goes
  above zero and their settings are remembered when it returns to zero.
- The bottom-right bay stays **reserved with no assigned function**.

### D4 — One modulation slot per dial; tiny dial and patch are mutually exclusive

There is exactly **one modulation slot per dial**. Its default occupant is the
internal randomiser, whose rate the tiny dial sets; patching a source in
*replaces* that occupant. Nothing sums, nothing fights, and the answer to "would
you ever want both?" is no by construction.

Tiny dial specifics:

- Four visible positions with icons: **note, bar, chord, section**.
- **Dim = inherited**, still showing the inherited icon. Turning it makes the
  setting explicit; tapping its centre returns it to inherit.
- The setting persists across collapse and reopen.

A user who genuinely needs two sources patches a MACRO, or an LFO whose own
rate is patched.

### D5 — Always show routing in use; no visibility switch

The draft's panel-level "Show routing" switch is **dropped** as cognitive
overhead. Instead:

- A coloured fill on the top-left circle means a lead of that colour arriving;
  top-right means one leaving.
- Sockets are shown **dimly at all times on min-max dials** — touch screens
  have no hover, so a hover-only reveal would be unreachable on a phone.
- Hovering a dial with nothing patched brings both empty circles to full
  intensity.

### D6 — Envelopes per voice; LFOs and macros global

**Settled.** ENV 1 always exists and controls amplitude; users add more through
the same mechanism. The universal-then-localised model (ENV 1 becoming ENV L1
when edited) is rejected — a control that silently renames and changes scope
when touched has no precedent users could transfer in.

The patch-in menu offers **ENV 1, ENV 2, LFO 1, MACRO 1**, then "other": first
every parameter already patched out, then every parameter.

**MACRO 1** behaves exactly like LFO 1 but its panel appears **above** the
tracks, and the view scrolls to a macro the first time it is selected. LFO
panels appear below the track list.

### D7 — Inheritance is dial → voice → instrument → track → bus → master

The draft collapsed voice into track. **Wrong, and corrected twice.** A drum
track has at least one instrument, and each instrument cycles voices differing
in pitch, noise and decay — so **voice sits below instrument**, not above it. A
melodic track has one instrument with one voice, so both levels exist but
neither is visible there. The percussion kit editor's existing
Common-plus-override structure is the shape this generalises.

**Six levels, and all six must be reserved in the path grammar before the first
public link.** An earlier draft of this document said four (dial → voice →
track → master), which would have booked a namespace with no room for
`instrument` or `bus`. Reserve alongside them: the modulation-source namespaces
(`env`, `lfo`, `macro`, utility ids), the sampling enum values, and the
step-rule enum values — graph edges serialise from v0.0.39 and are permanent
from the moment one is shared.

**The reserved tokens, verbatim (2026-08-12).** These are the wire spellings a
serialised graph edge, sampling field or step rule will use. Nothing enforces
them yet because nothing serialises them yet — that is exactly why they are
written down now, while changing a spelling still costs nothing. The registry
build adopts this table as its vocabulary; any addition extends the table in
the same commit.

| Namespace | Reserved tokens | Source of the list |
|---|---|---|
| Path levels | `dial` `voice` `instrument` `track` `bus` `master` | D7, this section |
| Modulation sources | `env` `lfo` `macro` | D4/D8 — per-voice envelopes, global LFOs, macros |
| Utility modules | `sh` `mix` `mul` `slew` | The maths-module item: Sample & hold, Mix (signed sum), Multiply, Slew |
| Sampling (when a stepped source fires) | `note` `bar` `chord` `section` | The sampling-control dial's four icon positions |
| Step rule (what value it takes) | `absolute` `walk` `up` `down` `pingpong` `cycle` | The fourth-bay step-rule item |

Two spellings ruled out on sight, so nobody books them by accident: `inst`
(ambiguous against a future `instance`) and `random` (says less than
`absolute` about what the draw is relative to — the span).

### D8 — The Randomise row dissolves into ordinary dials

The five Voice/Volume/Pitch/Timing/Pan dials are a *second* randomness system
with different semantics from the min-max walk. They are not hidden — they are
**dissolved**, each becoming an ordinary dial next to the thing it affects,
with the track's Randomness becoming a MACRO patched to them.

| Vary aspect | What it actually does | Becomes |
|---|---|---|
| Volume | ±6 dB swing around Level via a walk (`trackGain`) | The spread on the **Level** dial |
| Timing | `±TIMING_SPREAD × amount` per note | The spread on a **Timing** dial |
| Pan | `±PAN_SPREAD × amount` per note | The spread on the **Pan** dial |
| Pitch | Two things: passing-note likelihood, and an 18%-at-full per-note octave jump | Two dials: **Passing notes** and **Octave wander** |
| Voice | `VOICE_WANDER_CHANCE × amount` chance of swapping voice | A **Voice change** probability dial, its tiny dial setting how often the swap is considered |

The Auto detent (`null` = follow the track's Randomness macro) disappears with
the row: macro patching does that job, in the same vocabulary as everything
else. Stored presets migrate — a `vary.*` of `null` becomes a MACRO patch, an
explicit number becomes a spread.

### D9 — Range possible almost everywhere

Rangeable is a declared property of the parameter, defaulting to **true**. Only
enumerations (mode, time signature, voice choice) and identity fields are
genuinely non-rangeable; even tempo can drift, which is a rubato feel rather
than a fault. Non-rangeable dials draw the indicator line full-diameter from
the centre, and dragging right still splits them before they visibly snap back
within a fraction of a second — teaching the rule rather than merely enforcing
it.

### D10 — Warn on measured degradation

The draft's "warn from LFO 3" becomes a warning on **active modulation
connections**, wired into the existing power governor (`power.js`), which
already senses CPU pressure and frame times and steps quality tiers. Modulation
connections join what the tier budget accounts for, and the warning appears
when connections exceed the current tier's budget. One oscillator fanned out
costs roughly one node per connection, so ten dials on one LFO cost more than
three idle LFOs. Copy keeps the owner's framing: everything is processed in the
browser, so fewer connections give the best experience for everyone.

### D11 — The routing layer is off by default

Nothing above appears on the Simple tab. Corner affordances appear only when
**Advanced** is open. The Simple tab keeps its **four** dials.

**DECIDED (owner, 2026-08-13, his 137: a).** The modulation graph is FREE at
launch; only the v0.2.x user-authored instrument work carries a paid gate.
The routing half is therefore buildable now, in the phase order below —
phase 1 (the parameter registry) is the entry point. The earlier draft's
"Studio tier" said a tier that does not exist; the ladder is Free, Plus, Pro,
Premium, and no paid feature is visible before its tier can be bought.

---

## 3. Build sequence

Six phases. Phases 1-2 are the foundation and ship no visible change.

1. **Parameter registry.** One declarative table keyed by dotted path, carrying
   domain, curve, unit, format, default, rangeable, scope (dial / voice /
   instrument / track / bus / master) and *sampling* (note / bar / chord /
   section). Both the engine
   sanitiser and the UI read it. This deletes the boot-time capability probes
   (`probePatchSource`, `index.astro:2225`) and turns `allowRange` from a
   call-site opinion into a derived property. No user-visible change.
   **SHIPPED v0.0.165 (2026-08-14) for the PATCH namespace**:
   `src/scripts/param-registry.js` (rows + RESERVED_TOKENS as code), the
   engine's PATCH_SCHEMA is built from it, `PATCH_OSC_TYPES`/`PATCH_FILTER_TYPES`
   are registry rows, the page's eight patch-field probes became registry
   lookups and `probePatchSource` is gone. engine-smoke pins registry↔schema
   against drift and the derivation's corner laws. Track/bus/master rows and
   `allowRange`-as-derived land with phase 2's renderer.
2. **`buildKnobEditor` becomes a renderer over the registry.** The ~600 lines
   of hand-written `addKnob` literals collapse into a loop. Behaviour must be
   byte-identical; the existing smoke tests are the gate.
   **Phase 2a SHIPPED v0.0.166 (2026-08-14)**: every dial DOMAIN in the knob
   editor and the sculpt/call spec tables now reads the registry row
   (`regDomain`/`overlayRegistryDomains`), `DETUNE_MAX` is the registry
   ceiling, and the literals survive only as no-registry fallbacks. The one
   deliberate exception is documented in place: the octave DIAL ships ±1
   while the registry (and sanitiser) accept ±2, because every voice's own
   OCTAVES table clamps at ±1. Still open for 2b: the full literal→loop
   collapse (labels/formats/tooltips as registry UI metadata), the slider
   fallback editor's literals, and allowRange as a derived property.
3. **Gesture rebuild (D1, D2, D9).** Base-and-spread drag model, axis lock,
   centre-tap default, muted-grey zeroed state, live-value pointer (reusing the
   `ghostValue` substrate), full-diameter indicator for enumerations. Deletes
   `onDoubleClick`, the click-to-toggle path and the inside/outside-face zone
   scheme. Raise the mobile `--knob-size` breakpoint. Ship with no routing at
   all — this phase alone must leave the app fully usable.
4. **Sampling control (D4).** Generalise `walk()` from its hard-coded per-bar
   step to the registry's `sampling` field, add the inherit state, and ship the
   bottom-left tiny dial with its four icons. Delivers "a min-max dial must say
   how the value is chosen" without any patching yet.
   **ENGINE HALF SHIPPED v0.0.167 (2026-08-14)**: `params.sampling` (sparse,
   walk-keyed, replace-on-supply), honoured for `chord` and `section` with
   `bar` the unstored default, gating both the random walk and every shaped
   drift's phase counter; `'@global'` spans gate through the same map.
   `note` is refused at the sanitiser until per-note resolution exists (the
   bar-cadenced caches make it structurally later), so no stored token can
   lie. The tiny-dial UI waits on the phase-3 gesture ruling (fromClaude 10)
   because its bottom-left bay belongs to the new face layout.
5. **Modulation graph (D3-D6, D10).** A serialisable list of
   `{source, destination}` edges — no depth field, since spread is depth.
   Sources are envelopes (per voice), LFOs and macros (global), and any
   parameter patched out. One slot per destination, so patching replaces the
   internal randomiser. Patch sockets, ENV/LFO/MACRO panels, connection
   accounting in `power.js`.
   **FIRST ENGINE SLICE SHIPPED v0.0.168 (2026-08-14)**: `params.routing`
   edges with `lfo.1` (global sine, `params.lfo1.bars`) and `macro.1`
   (`params.macro1`) as sources; one-slot-per-destination enforced at the
   sanitiser (last wins); a routed walk key's position IS the source value,
   gated by hold/freeze and composed with v0.0.167 sampling. Still to come
   in this phase: envelopes as sources (per-voice), LFO 2+/macro 2+,
   params-as-sources, the socket UI (after the phase-3 ruling), and the
   D10 power-governor accounting.
6. **Dissolve the Randomise row (D8).** Volume, Timing and Pan become spreads
   on their own dials; Pitch splits into Passing notes and Octave wander; Voice
   becomes a probability dial. `vary.*` migrates: `null` becomes a MACRO patch,
   an explicit number becomes a spread. Do not delete the old params until a
   release has passed with both paths live.

The Studio-tier "build your own instrument and assign dials to anything" work
extends the same registry with user-authored bindings — it is the phase after
this programme, not a parallel one.

## 4. Risks

- **Serialisation was already permanent and unversioned until v0.0.35.**
  Share links shipped in v0.0.33 carrying the raw settings tree, base64url'd,
  with no schema field — so an older client meeting a newer link silently
  dropped keys it did not know and played a different piece **under the right
  three-word name**, because the name is a hash of the payload bytes. v0.0.35
  adds a `v` field and a "made with a newer version" notice; absent `v` reads as
  version 0, so existing links keep working. **Standing policy from here:
  serialised keys never rename.** `randomness` and `repetition` stay the wire
  keys forever; Variation and Reprise are UI labels only.
- **Registry paths and graph edges also go into presets and links.** A path
  renamed after launch breaks every link ever shared.
- **Phase 2 is a large no-op refactor.** Its only defence is the existing test
  suites; if coverage of the patch editor is thin, widen it before starting.
- **Phase 3 changes muscle memory for every existing control**, including dials
  that never had a range. It is the phase most likely to need a real-device
  test on a phone before it can claim done.
- **Behavioural drift.** Phases 4 and 6 change how existing presets sound. Both
  need a frozen-reference audio comparison — **which does not exist and is not
  scheduled anywhere.** `engine-smoke.mjs` is seeded and deterministic, so the
  substrate is there, but the harness has to be built before phase 4.
- **The gesture rebuild invalidates much of `knobscope-smoke.mjs`** (2,548
  lines exercising click-toggle, double-click reset, face zones, wheel and
  keyboard). Its replacement must be written against the spec *before* the
  rebuild starts — the harness already drives pointer sequences, so axis lock,
  re-arm, nearest-end grab and push-through are all unit-testable. "Feels right
  on a phone" is not a gate.
- **The keyboard path is not adequate and gets worse.** Today arrows move min,
  Shift+arrows move max — but only inside an existing range, and mode entry is
  click-only, so a keyboard user cannot create a span at all. After the rebuild
  deletes the click gesture there is still no keyboard way to open, close or
  collapse a spread, and deleting double-click removes the only reset. Phase 3
  must specify a keyboard spread gesture, a reset key, and a dual-thumb aria
  contract — `role="slider"` with one `aria-valuenow` is already wrong for two
  thumbs.
- **The `vary.*` migration needs a decode shim that lives forever.** Old share
  links carrying `vary.*` never expire, so only the *write* path may retire
  after a release; the read path cannot.
- **Axis lock is the one genuinely new interaction risk.** A 6 px threshold
  that feels wrong on a trackpad will feel wrong differently on a touchscreen;
  budget a tuning pass rather than a single guess.

## 5. Open decisions

None outstanding. Envelope ownership is settled (D6, per voice). The remaining
judgement call is the registry's path naming and the graph's serialisation
format, which are permanent once shared links exist — see section 4 and the
review recommendation.
