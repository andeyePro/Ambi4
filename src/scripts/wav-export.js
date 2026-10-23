/**
 * WAV encoding — pure arithmetic, no Web Audio, no DOM.
 *
 * Save as WAV (the transport row's button) captures the engine's own output
 * while it plays and hands the samples here, a chunk at a time; this module
 * turns them into a canonical 44-byte-header RIFF/WAVE file of 16-bit signed
 * PCM, little-endian, interleaved. Every multi-byte field is written through a
 * DataView with littleEndian = true, so the file is the same on a big-endian
 * machine (an Int16Array would be in the platform's own byte order).
 *
 * Conversion is clipping-safe: a sample beyond ±1 is clamped rather than
 * wrapped (a wrapped 1.01 becomes a full-scale negative step — a click), and
 * NaN is silence. -1 maps to -32768 and +1 to +32767, the asymmetric scaling
 * every PCM reader expects, so 0 stays exactly 0.
 *
 * The writer converts each chunk to bytes as it arrives, so a ten-minute take
 * is held as 16-bit (11.5 MB a minute at 48 kHz stereo), never as Float32.
 * The bytes go into one fixed segment (1 MiB); given a Blob constructor, each
 * full segment is SEALED into a Blob and the segment reused, so finish()'s
 * `parts` are the header and those Blobs, and the page's new Blob(parts)
 * composes Blobs rather than copying the whole file a second time. Measured in
 * Node for a ten-minute 48 kHz take (review, 2026-10-23 evening): 245 MB peak
 * with the chunks held as arrays, 129 MB sealed (the file itself is 115). Without a Blob constructor
 * (the tests' encodeWav) the segments themselves are the parts.
 */

export const WAV_HEADER_BYTES = 44;
const BITS = 16;
const BYTES_PER_SAMPLE = BITS / 8;
// RIFF sizes are uint32; the RIFF size field is the file length minus 8.
const MAX_DATA_BYTES = 0xffffffff - (WAV_HEADER_BYTES - 8);

/** One float sample to a 16-bit integer: clamped, NaN as silence. */
export function floatToInt16(x) {
  if (!(x === x)) return 0; // NaN
  const v = x > 1 ? 1 : x < -1 ? -1 : x;
  return v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff);
}

function checkFormat(sampleRate, channelCount) {
  if (!Number.isInteger(sampleRate) || sampleRate < 1 || sampleRate > 768000) {
    throw new RangeError(`wav-export: sample rate ${sampleRate} is not a whole number of Hz`);
  }
  if (!Number.isInteger(channelCount) || channelCount < 1 || channelCount > 8) {
    throw new RangeError(`wav-export: ${channelCount} channels is not 1 to 8`);
  }
}

/** The 44-byte RIFF/fmt/data header for `frames` frames of 16-bit PCM. */
export function wavHeader({ sampleRate, channelCount, frames }) {
  checkFormat(sampleRate, channelCount);
  const blockAlign = channelCount * BYTES_PER_SAMPLE;
  const dataBytes = frames * blockAlign;
  if (!Number.isInteger(frames) || frames < 0 || dataBytes > MAX_DATA_BYTES) {
    throw new RangeError(`wav-export: ${frames} frames do not fit a WAV file`);
  }
  const bytes = new Uint8Array(WAV_HEADER_BYTES);
  const view = new DataView(bytes.buffer);
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, WAV_HEADER_BYTES - 8 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);                     // fmt chunk size (PCM)
  view.setUint16(20, 1, true);                      // format: 1 = integer PCM
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, BITS, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  return bytes;
}

/**
 * Planar float channels (equal lengths, or the shortest wins) to interleaved
 * little-endian 16-bit bytes. `frames` caps how many frames are taken.
 */
export function interleaveInt16(channels, frames = Infinity) {
  const n = Math.min(frames, ...channels.map((c) => c.length));
  const count = channels.length;
  const bytes = new Uint8Array(n * count * BYTES_PER_SAMPLE);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < count; c++) {
      view.setInt16(offset, floatToInt16(channels[c][i]), true);
      offset += BYTES_PER_SAMPLE;
    }
  }
  return bytes;
}

/**
 * An incremental writer. push(channels) takes one chunk of planar Float32
 * channels and answers how many frames it kept (fewer once `maxFrames` is
 * reached); finish() answers { parts, byteLength, frames, seconds } — the
 * header is written last, when the length is known. `Blob`, when given, seals
 * each full `segmentBytes` of the file into a Blob (see the top of the file).
 */
export function createWavWriter({ sampleRate, channelCount, maxFrames = Infinity, Blob: BlobCtor = null, segmentBytes = 1 << 20 }) {
  checkFormat(sampleRate, channelCount);
  const frameBytes = channelCount * BYTES_PER_SAMPLE;
  const capFrames = Math.min(maxFrames, Math.floor(MAX_DATA_BYTES / frameBytes));
  const segFrames = Math.max(1, Math.floor(segmentBytes / frameBytes));
  const sealed = [];
  let seg = null;
  let view = null;
  let segAt = 0; // frames in the open segment
  let frames = 0;
  const open = () => {
    seg = new Uint8Array(segFrames * frameBytes);
    view = new DataView(seg.buffer);
    segAt = 0;
  };
  const seal = () => {
    if (!seg || segAt === 0) return;
    const bytes = seg.subarray(0, segAt * frameBytes);
    if (BlobCtor) {
      // The Blob copies the bytes, so the segment is reused, not reallocated.
      sealed.push(new BlobCtor([bytes]));
      segAt = 0;
    } else {
      sealed.push(bytes);
      seg = null;
    }
  };
  return {
    get frames() { return frames; },
    get seconds() { return frames / sampleRate; },
    get full() { return frames >= capFrames; },
    push(channels) {
      if (!channels || channels.length === 0) return 0;
      if (channels.length !== channelCount) {
        throw new RangeError(`wav-export: a ${channels.length}-channel chunk for a ${channelCount}-channel file`);
      }
      const room = capFrames - frames;
      if (room <= 0) return 0;
      const n = Math.min(room, ...channels.map((c) => c.length));
      for (let i = 0; i < n; i++) {
        if (!seg) open();
        let offset = segAt * frameBytes;
        for (let c = 0; c < channelCount; c++) {
          view.setInt16(offset, floatToInt16(channels[c][i]), true);
          offset += BYTES_PER_SAMPLE;
        }
        segAt += 1;
        if (segAt === segFrames) seal();
      }
      frames += n;
      return n;
    },
    finish() {
      seal();
      const header = wavHeader({ sampleRate, channelCount, frames });
      return {
        parts: [header, ...sealed],
        byteLength: WAV_HEADER_BYTES + frames * frameBytes,
        frames,
        seconds: frames / sampleRate,
      };
    },
  };
}

/** A whole file in one call: planar float channels to WAV bytes. */
export function encodeWav({ sampleRate, channels }) {
  const writer = createWavWriter({ sampleRate, channelCount: channels.length });
  writer.push(channels);
  const { parts, byteLength } = writer.finish();
  const out = new Uint8Array(byteLength);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Read a 16-bit PCM WAV back (this module's own output, or any canonical
 * one): walks the chunks rather than assuming offset 44, so a file with an
 * extra chunk still parses. Samples come back as floats, sample / 32768.
 */
export function parseWav(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('wav-export: not a RIFF/WAVE file');
  let fmt = null;
  let data = null;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      fmt = {
        format: view.getUint16(body, true),
        channelCount: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        byteRate: view.getUint32(body + 8, true),
        blockAlign: view.getUint16(body + 12, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      data = { offset: body, size: Math.min(size, bytes.length - body) };
    }
    offset = body + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('wav-export: no fmt or data chunk');
  if (fmt.format !== 1 || fmt.bitsPerSample !== 16) throw new Error('wav-export: only 16-bit PCM is read');
  const frames = Math.floor(data.size / fmt.blockAlign);
  const channels = Array.from({ length: fmt.channelCount }, () => new Float32Array(frames));
  let at = data.offset;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < fmt.channelCount; c++) {
      channels[c][i] = view.getInt16(at, true) / 32768;
      at += 2;
    }
  }
  return { ...fmt, riffSize: view.getUint32(4, true), dataBytes: data.size, frames, channels };
}

/** "ambi4-2026-10-23T14-05-09.wav" — sortable, and legal on every filesystem. */
export function wavFileName(date = new Date()) {
  return `ambi4-${date.toISOString().replace(/\.\d+Z$/, '').replace(/:/g, '-')}.wav`;
}
