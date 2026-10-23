/**
 * Save as WAV — the real-time tap.
 *
 * The engine schedules against a live AudioContext from a Worker/setInterval
 * tick and draws its music with Math.random in both the engine and the voice
 * library, so an offline render would be ANOTHER performance of the same
 * settings, not the one the listener is hearing. This records the one they
 * are hearing: a tap on the engine's output analyser (post-fader, post-
 * limiter — the listening level, Volume dial included; see buildGraph), taken
 * in raw float PCM and encoded to 16-bit WAV by wav-export.js. No lossy codec
 * sits anywhere in the chain, and nothing leaves the device.
 *
 * An AudioWorklet (a Blob-URL module) where the browser has one, else a
 * ScriptProcessor. The tap is a dead end for sound: its own output goes to
 * the destination through a gain of 0, only because a ScriptProcessor that
 * reaches no destination is never run.
 */

import { createWavWriter } from './wav-export.js';

export const WAV_CHANNELS = 2;
const CHUNK_FRAMES = 4096;

const WORKLET_SOURCE = `
class Ambi4WavTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = true;
    this.reset();
    this.port.onmessage = (e) => {
      if (e.data === 'flush') { this.flush(); this.port.postMessage({ flushed: true }); }
      else if (e.data === 'stop') { this.flush(); this.on = false; this.port.postMessage({ flushed: true }); }
    };
  }
  reset() { this.buf = [new Float32Array(${CHUNK_FRAMES}), new Float32Array(${CHUNK_FRAMES})]; this.n = 0; }
  flush() {
    if (this.n > 0) {
      const out = this.buf.map((b) => b.slice(0, this.n));
      this.port.postMessage({ chunk: out }, out.map((b) => b.buffer));
    }
    this.reset();
  }
  process(inputs) {
    if (!this.on) return false;
    const input = inputs[0];
    if (input && input.length) {
      const len = input[0].length;
      if (this.n + len > ${CHUNK_FRAMES}) this.flush();
      for (let c = 0; c < 2; c++) this.buf[c].set(input[Math.min(c, input.length - 1)], this.n);
      this.n += len;
    }
    return true;
  }
}
registerProcessor('ambi4-wav-tap', Ambi4WavTap);
`;

function hasWorklet(ctx, g) {
  return !!(ctx && ctx.audioWorklet && typeof ctx.audioWorklet.addModule === 'function'
    && typeof g.AudioWorkletNode === 'function'
    && typeof g.Blob === 'function' && g.URL && typeof g.URL.createObjectURL === 'function');
}

/**
 * The tap's module, loaded ONCE per context: a second
 * registerProcessor('ambi4-wav-tap') in the same AudioWorkletGlobalScope throws
 * NotSupportedError, which rejects that addModule — so loading it per take
 * sent every take after the first to the ScriptProcessor. A WeakMap, so a
 * closed context takes its entry with it; the Blob URL is revoked as soon as
 * the load settles, since a loaded module no longer needs it.
 */
const TAP_MODULES = new WeakMap();
function loadTapModule(ctx, g) {
  let loading = TAP_MODULES.get(ctx);
  if (!loading) {
    const url = g.URL.createObjectURL(new g.Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
    loading = Promise.resolve()
      .then(() => ctx.audioWorklet.addModule(url))
      .finally(() => { try { g.URL.revokeObjectURL(url); } catch { /* best effort */ } });
    TAP_MODULES.set(ctx, loading);
  }
  return loading;
}

function hasScriptProcessor(ctx) {
  return !!(ctx && typeof ctx.createScriptProcessor === 'function');
}

/**
 * Why a capture cannot start, in words for the person — or null when it can.
 * `node` is the engine's output analyser (null before the first Play).
 */
export function wavCaptureProblem(node, g = globalThis) {
  const ctx = node && node.context;
  if (!ctx) {
    const any = typeof g.AudioWorkletNode === 'function' || typeof g.ScriptProcessorNode === 'function';
    if (!any) return 'This browser cannot hand raw audio to the page (it has neither AudioWorklet nor ScriptProcessor), so Save as WAV is unavailable here.';
    return 'Press Play first: Save as WAV captures the music as it plays.';
  }
  if (!hasWorklet(ctx, g) && !hasScriptProcessor(ctx)) {
    return 'This browser cannot hand raw audio to the page (it has neither AudioWorklet nor ScriptProcessor), so Save as WAV is unavailable here.';
  }
  if (ctx.state !== 'running') return 'Press Play first: Save as WAV captures the music as it plays.';
  return null;
}

/**
 * Start capturing from `node`. Resolves to { stop(), writer, sampleRate,
 * mode }. stop() resolves to the writer's finish() — { parts, byteLength,
 * frames, seconds } — and is safe to call twice. `onFull` fires once when
 * `maxSeconds` of audio is held (the caller stops and saves); `onProgress`
 * fires per chunk with the seconds held.
 */
export async function startWavCapture(node, { maxSeconds = 600, onProgress, onFull, g = globalThis } = {}) {
  const problem = wavCaptureProblem(node, g);
  if (problem) throw new Error(problem);
  const ctx = node.context;
  const sampleRate = Math.round(ctx.sampleRate);
  const writer = createWavWriter({
    sampleRate, channelCount: WAV_CHANNELS, maxFrames: Math.floor(maxSeconds * sampleRate),
  });
  let fullSent = false;
  let stopped = false;
  const accept = (channels) => {
    if (stopped) return;
    writer.push(channels);
    if (onProgress) onProgress(writer.seconds);
    if (writer.full && !fullSent) {
      fullSent = true;
      if (onFull) onFull();
    }
  };

  const mute = ctx.createGain();
  mute.gain.value = 0;
  mute.connect(ctx.destination);

  let tap = null;
  let mode = null;
  if (hasWorklet(ctx, g)) {
    try {
      await loadTapModule(ctx, g);
      tap = new g.AudioWorkletNode(ctx, 'ambi4-wav-tap', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
        channelCount: WAV_CHANNELS, channelCountMode: 'explicit', channelInterpretation: 'speakers',
      });
      tap.port.onmessage = (e) => { if (e.data && e.data.chunk) accept(e.data.chunk); };
      mode = 'worklet';
    } catch {
      tap = null; // a CSP or an old engine refusing the module: fall through
    }
  }
  if (!tap) {
    if (!hasScriptProcessor(ctx)) {
      try { mute.disconnect(); } catch { /* never connected further */ }
      throw new Error('This browser refused the audio tap, so Save as WAV is unavailable here.');
    }
    tap = ctx.createScriptProcessor(CHUNK_FRAMES, WAV_CHANNELS, 1);
    try { tap.channelCountMode = 'explicit'; tap.channelInterpretation = 'speakers'; } catch { /* fixed on some engines */ }
    tap.onaudioprocess = (e) => {
      const input = e.inputBuffer;
      const n = input.numberOfChannels;
      const out = [];
      for (let c = 0; c < WAV_CHANNELS; c++) out.push(input.getChannelData(Math.min(c, n - 1)).slice());
      accept(out);
    };
    mode = 'script-processor';
  }
  node.connect(tap);
  tap.connect(mute);

  let finished = null;
  async function stop() {
    if (finished) return finished;
    finished = (async () => {
      if (mode === 'worklet') {
        // The last partial chunk is still in the worklet: ask for it, and
        // wait a bounded time (a suspended context never answers).
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 500);
          const prior = tap.port.onmessage;
          tap.port.onmessage = (e) => {
            if (prior) prior(e);
            if (e.data && e.data.flushed) { clearTimeout(timer); resolve(); }
          };
          tap.port.postMessage('stop');
        });
      }
      stopped = true;
      try { node.disconnect(tap); } catch { /* the graph is gone */ }
      try { tap.disconnect(); } catch { /* same */ }
      try { mute.disconnect(); } catch { /* same */ }
      if (mode === 'script-processor') tap.onaudioprocess = null;
      return writer.finish();
    })();
    return finished;
  }

  return { stop, writer, sampleRate, mode };
}
