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

**[decide] Which tier gates the patch sockets.** An earlier draft said "Studio
tier". There is no Studio tier — the ladder is Free, Plus, Pro, Premium — and
the standing owner rule is that no paid feature is ever visible before its tier
can be bought. Payments do not exist at v0.1.0, so gating the graph to a paid
tier means the whole of v0.0.39 ships dark at the public release, built ahead
of launch blockers. Worse, v0.0.40's chord-sequence linking is specified to use
those same cables and is free-tier value. Either the graph is free at launch
and a paid gate applies only to the v0.2.x user-authored instrument work, or
the graph moves after v0.1.0. This is a pricing decision, not a build one.

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
2. **`buildKnobEditor` becomes a renderer over the registry.** The ~600 lines
   of hand-written `addKnob` literals collapse into a loop. Behaviour must be
   byte-identical; the existing smoke tests are the gate.
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
5. **Modulation graph (D3-D6, D10).** A serialisable list of
   `{source, destination}` edges — no depth field, since spread is depth.
   Sources are envelopes (per voice), LFOs and macros (global), and any
   parameter patched out. One slot per destination, so patching replaces the
   internal randomiser. Patch sockets, ENV/LFO/MACRO panels, connection
   accounting in `power.js`.
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
