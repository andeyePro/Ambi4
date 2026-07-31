/**
 * Standard MIDI File → notes in BEATS. Pure: no DOM, no audio, no state, and
 * safe to import in Node, which is how `tests/midi-file-smoke.mjs` drives it.
 *
 * WHY IT EXISTS. His item 96, deciding where import belongs: "MIDI file import
 * is a compose option IMHO, the assumption is that the user composed the MIDI
 * in another app, we can't know if that wasn't the case." So a file lands on
 * the compose side, next to typed chords and typed melody, and writes the same
 * thing they write: pinned steps on a track's grid.
 *
 * WHY A PARSER OF OUR OWN. The page ships no third-party code and the container
 * cannot reach a CDN; an SMF reader for the subset that matters here is about a
 * hundred lines. The subset: format 0 and 1 (format 2 is a set of independent
 * songs, which is not a thing to import onto one grid), metrical time only
 * (SMPTE division is timecode video work, not composition), note on/off,
 * per-track channel filtering, and the tempo/time-signature meta events that
 * tell the caller what the file THINKS it is. Everything else is skipped by
 * length, which is what the format's own chunking is for.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not quantise, choose a track, or
 * decide what a bar is: those are musical decisions the caller makes with the
 * user's own grid in front of it. This module answers exactly one question —
 * "what notes are in this file, and when, in beats?" — and reports what it
 * could not read rather than guessing.
 */

/** A quarter note is the unit: SMF division is ticks per quarter note. */
const DEFAULT_DIVISION = 480;

class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.at = 0;
  }

  get done() {
    return this.at >= this.bytes.length;
  }

  byte() {
    if (this.at >= this.bytes.length) throw new Error('unexpected end of file');
    return this.bytes[this.at++];
  }

  uint(count) {
    let value = 0;
    for (let i = 0; i < count; i++) value = value * 256 + this.byte();
    return value;
  }

  /** SMF variable-length quantity: seven bits per byte, high bit continues. */
  varint() {
    let value = 0;
    for (let i = 0; i < 4; i++) {
      const b = this.byte();
      value = (value << 7) | (b & 0x7f);
      if ((b & 0x80) === 0) return value;
    }
    throw new Error('a variable-length quantity ran past four bytes');
  }

  string(count) {
    let out = '';
    for (let i = 0; i < count; i++) out += String.fromCharCode(this.byte());
    return out;
  }

  skip(count) {
    this.at += count;
  }
}

/**
 * Read one MTrk chunk into note events, in TICKS. Running status is honoured
 * (a file that omits repeated status bytes is ordinary, not broken), and a
 * note-on at velocity 0 is a note-off — both are in the spec and both appear
 * in the wild.
 */
function readTrack(reader, length) {
  const end = reader.at + length;
  const notes = [];
  const open = new Map(); // `${channel}|${midi}` → { start, velocity }
  const meta = { tempoMicrosPerBeat: null, timeSignature: null, name: null };
  let ticks = 0;
  let status = 0;

  while (reader.at < end) {
    ticks += reader.varint();
    let byte = reader.byte();
    if (byte & 0x80) {
      status = byte;
    } else {
      // Running status: this byte is the first DATA byte of the last message.
      reader.at -= 1;
      if (!status) throw new Error('data byte with no running status');
    }
    byte = status;
    const kind = byte & 0xf0;
    const channel = byte & 0x0f;

    if (byte === 0xff) {
      const type = reader.byte();
      const size = reader.varint();
      const from = reader.at;
      if (type === 0x51 && size === 3) {
        meta.tempoMicrosPerBeat = reader.uint(3);
      } else if (type === 0x58 && size >= 2) {
        const numerator = reader.byte();
        const denominator = 2 ** reader.byte();
        meta.timeSignature = `${numerator}/${denominator}`;
      } else if (type === 0x03 && size > 0) {
        meta.name = reader.string(size).trim() || null;
      }
      reader.at = from + size;
      continue;
    }
    if (byte === 0xf0 || byte === 0xf7) {
      reader.skip(reader.varint()); // sysex: not a note, skipped by its length
      continue;
    }

    if (kind === 0x90 || kind === 0x80) {
      const midi = reader.byte() & 0x7f;
      const velocity = reader.byte() & 0x7f;
      const key = `${channel}|${midi}`;
      if (kind === 0x90 && velocity > 0) {
        open.set(key, { start: ticks, velocity });
      } else {
        const started = open.get(key);
        if (started) {
          open.delete(key);
          notes.push({
            midi,
            channel,
            startTicks: started.start,
            endTicks: ticks,
            velocity: started.velocity,
          });
        }
      }
      continue;
    }

    // Everything else is skipped by its own data length: two bytes for the
    // channel messages that carry two, one for program change and channel
    // pressure. Guessing here is how a parser walks off its own rails.
    if (kind === 0xc0 || kind === 0xd0) reader.skip(1);
    else reader.skip(2);
  }

  // A note still held at the end of the track ends there: a file that forgot
  // its note-off is common, and dropping the note would lose music.
  for (const [key, started] of open) {
    const midi = Number(key.split('|')[1]);
    notes.push({
      midi,
      channel: Number(key.split('|')[0]),
      startTicks: started.start,
      endTicks: ticks,
      velocity: started.velocity,
    });
  }

  reader.at = end;
  return { notes, meta };
}

/**
 * Parse a Standard MIDI File.
 *
 * `bytes` is anything indexable and byte-valued (a Uint8Array from a File, or
 * an array in a test). Returns:
 *
 *   { format, division, tracks: [{ name, channels, notes }], tempoBpm,
 *     timeSignature, notes, skipped }
 *
 * where every note carries `{ midi, channel, start, end, velocity }` with
 * start/end in BEATS (quarter notes) and velocity 0–1, and `notes` is every
 * track's notes merged in time order — the shape a caller wants when the user
 * picked "import this file onto this track". `skipped` names what could not be
 * read, so the UI can say so instead of quietly importing less than the file
 * holds.
 */
export function parseMidiFile(bytes) {
  const reader = new Reader(bytes);
  const skipped = [];
  if (reader.string(4) !== 'MThd') throw new Error('not a MIDI file (no MThd header)');
  const headerLength = reader.uint(4);
  const format = reader.uint(2);
  const trackCount = reader.uint(2);
  const divisionRaw = reader.uint(2);
  reader.skip(Math.max(0, headerLength - 6));

  if (format === 2) {
    throw new Error('format 2 files are a set of independent songs — open one song and export that');
  }
  // A negative division is SMPTE timecode: frames per second, not beats. That
  // is video-sync work and has no bar to land on, so it is refused outright
  // rather than imported at a silently wrong speed.
  if (divisionRaw & 0x8000) {
    throw new Error('this file is timed in SMPTE timecode, not beats — export it as a musical (PPQ) file');
  }
  const division = divisionRaw || DEFAULT_DIVISION;

  const tracks = [];
  let tempoMicrosPerBeat = null;
  let timeSignature = null;
  for (let i = 0; i < trackCount && !reader.done; i++) {
    const id = reader.string(4);
    const length = reader.uint(4);
    if (id !== 'MTrk') {
      skipped.push(`a '${id}' chunk (not a track)`);
      reader.skip(length);
      continue;
    }
    const { notes, meta } = readTrack(reader, length);
    if (meta.tempoMicrosPerBeat && tempoMicrosPerBeat === null) {
      tempoMicrosPerBeat = meta.tempoMicrosPerBeat;
    }
    if (meta.timeSignature && timeSignature === null) timeSignature = meta.timeSignature;
    tracks.push({
      name: meta.name,
      channels: [...new Set(notes.map((n) => n.channel))].sort((a, b) => a - b),
      notes: notes.map((n) => ({
        midi: n.midi,
        channel: n.channel,
        start: n.startTicks / division,
        end: n.endTicks / division,
        velocity: Math.max(0.05, Math.min(1, n.velocity / 127)),
      })),
    });
  }

  const notes = tracks
    .flatMap((track, index) => track.notes.map((note) => ({ ...note, track: index })))
    .sort((a, b) => a.start - b.start || a.midi - b.midi);

  return {
    format,
    division,
    tracks,
    notes,
    tempoBpm: tempoMicrosPerBeat ? Math.round(60000000 / tempoMicrosPerBeat) : null,
    timeSignature,
    skipped,
  };
}

/**
 * Notes in beats → steps on a grid, one bar per array.
 *
 * The caller supplies the grid it is writing onto: `stepBeats` (the track's own
 * resolution rung) and `slotsPerBar` (what the metre plays at that rung). Notes
 * are quantised to the nearest slot; a slot can hold ONE note, because a step
 * grid holds one, so a chord collapses to its HIGHEST note and the count of
 * what that dropped is reported rather than hidden. `maxBars` caps the import
 * the way the typed-melody writer caps a phrase.
 *
 * Returns `{ bars, written, dropped, collapsed, beats }` — bars of sparse
 * `{ slot, midi, velocity, gate }` records, so the caller decides how to build
 * its own step objects and never has this module guessing at its schema.
 */
export function notesToBars(notes, { stepBeats = 0.25, slotsPerBar = 16, maxBars = 8 } = {}) {
  const bars = [];
  let written = 0;
  let dropped = 0;
  let collapsed = 0;
  const barBeats = stepBeats * slotsPerBar;
  const list = Array.isArray(notes) ? [...notes].sort((a, b) => a.start - b.start) : [];
  const origin = list.length ? Math.min(...list.map((n) => n.start)) : 0;

  for (const note of list) {
    if (!Number.isFinite(note.midi) || note.midi < 0 || note.midi > 127) { dropped += 1; continue; }
    const beat = note.start - origin;
    const slotIndex = Math.round(beat / stepBeats);
    const bar = Math.floor(slotIndex / slotsPerBar);
    if (bar >= maxBars) { dropped += 1; continue; }
    const slot = slotIndex % slotsPerBar;
    while (bars.length <= bar) bars.push(new Map());
    const held = Math.max(0, (note.end ?? note.start) - note.start);
    const record = {
      slot,
      midi: Math.round(note.midi),
      velocity: Number.isFinite(note.velocity) ? note.velocity : 0.8,
      // A gate of 1 is exactly one slot; the grid's own contract.
      gate: held > 0 ? Math.max(0.1, Math.min(2, held / stepBeats)) : 1,
    };
    const existing = bars[bar].get(slot);
    if (existing) {
      collapsed += 1;
      if (record.midi > existing.midi) bars[bar].set(slot, record);
    } else {
      bars[bar].set(slot, record);
      written += 1;
    }
  }

  return {
    bars: bars.map((map) => [...map.values()].sort((a, b) => a.slot - b.slot)),
    written,
    dropped,
    collapsed,
    beats: list.length ? Math.max(...list.map((n) => n.end ?? n.start)) - origin : 0,
  };
}

export default parseMidiFile;
