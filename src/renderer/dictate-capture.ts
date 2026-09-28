// Owns the mic-only audio graph behind the dictation hotkey. The microphone is
// opened on demand and the stream kept until the session ends, so a second
// press of the hotkey does not pay for another getUserMedia round trip.
//
//   mic ──► merger[0] ─┐
//        (silence [1]) ┤──► pcm-processor ─► (zero gain) ─► destination
//                       ┘
//
// The pcm-worklet expects a two-channel input with "left = the source, right =
// something else" — that is the shape the meeting graph feeds it. Dictation
// feeds the mic into channel 0 and leaves channel 1 silent, which the worklet's
// mono sum reads as the mic at full gain rather than doubled.

import type { DictateStatus } from '../shared/types';

const SAMPLE_RATE = 16000;

const state = {
  ctx: null as AudioContext | null,
  worklet: null as AudioWorkletNode | null,
  stream: null as MediaStream | null,
  micOk: false,
  micError: '',
  micLabel: '',
  recording: false,
  config: { micDeviceId: '', micDeviceLabel: '' },
};

/** Pending teardown from a stop, so a start that follows it can cancel it. */
let stopTimer: ReturnType<typeof setTimeout> | undefined;

const message = (err: unknown): string => (err instanceof Error && err.message) || String(err);

function post(status: DictateStatus): void {
  window.dictate.sendStatus({
    micOk: state.micOk,
    micError: state.micError,
    micLabel: state.micLabel,
    ...status,
  });
}

/** Same constraints as the meeting capture: mono, with the echo team on. */
function micConstraints(deviceId: string): MediaStreamConstraints {
  return {
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
    video: false,
  };
}

/** Resolves the configured microphone to a device id this machine still has. */
async function chosenMicId(): Promise<string> {
  const { micDeviceId, micDeviceLabel } = state.config;
  if (!micDeviceId) return '';
  try {
    const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    if (inputs.some((d) => d.deviceId === micDeviceId)) return micDeviceId;
    const byLabel = micDeviceLabel ? inputs.find((d) => d.label === micDeviceLabel) : undefined;
    return byLabel ? byLabel.deviceId : micDeviceId;
  } catch {
    return micDeviceId;
  }
}

async function openMic(): Promise<void> {
  state.micOk = false;
  state.micError = '';
  state.micLabel = '';
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(micConstraints(await chosenMicId()));
  } catch (err) {
    state.micError = message(err);
    post({});
    return;
  }
  state.stream = stream;
  state.micLabel = stream.getAudioTracks()[0]?.label ?? '';
  state.micOk = true;
  post({});
}

/** Wires the mic onto channel 0 of a 2-channel merger; channel 1 stays silent. */
async function buildGraph(stream: MediaStream): Promise<void> {
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'playback' });
  state.ctx = ctx;
  await ctx.audioWorklet.addModule('pcm-worklet.js');

  const source = ctx.createMediaStreamSource(stream);
  const merger = ctx.createChannelMerger(2);
  source.connect(merger, 0, 0);

  const worklet = new AudioWorkletNode(ctx, 'pcm-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: 'explicit',
    channelInterpretation: 'discrete',
  });
  state.worklet = worklet;
  worklet.port.onmessage = (e: MessageEvent<{ type: string; buffer?: ArrayBuffer; rms?: number }>) => {
    const msg = e.data;
    if (msg.type === 'pcm') {
      if (state.recording && msg.buffer) window.dictate.sendPcm(msg.buffer);
    } else if (msg.type === 'level') {
      window.dictate.sendLevel(msg.rms ?? 0);
    }
  };

  const silent = ctx.createGain();
  silent.gain.value = 0;
  merger.connect(worklet);
  worklet.connect(silent).connect(ctx.destination);
  await ctx.resume();
}

async function stopGraph(): Promise<void> {
  try {
    state.worklet?.disconnect();
  } catch {
    /* already torn down */
  }
  state.worklet = null;
  try {
    state.stream?.getTracks().forEach((t) => t.stop());
  } catch {
    /* already gone */
  }
  state.stream = null;
  state.micOk = false;
  if (state.ctx) {
    await state.ctx.close().catch(() => {});
    state.ctx = null;
  }
}

window.dictate.onStart(async (cfg) => {
  state.config = { ...state.config, micDeviceId: cfg.micDeviceId, micDeviceLabel: cfg.micDeviceLabel };
  clearTimeout(stopTimer);
  stopTimer = undefined;
  if (!state.ctx) {
    await openMic();
    if (!state.micOk || !state.stream) return;
    try {
      await buildGraph(state.stream);
    } catch (err) {
      post({ fatal: message(err) });
      return;
    }
  }
  // A mic test (cfg.test) opens the graph for its levels alone and records
  // nothing — the meter is the whole point, and PCM has no destination.
  state.recording = !cfg.test;
  // The worklet is told the layout as it is built, exactly as the meeting graph
  // does, so a session cannot miss a message it was not up in time for.
  state.worklet?.port.postMessage({ type: 'record', value: !cfg.test, channels: 1 });
});

window.dictate.onStop(() => {
  state.recording = false;
  state.worklet?.port.postMessage({ type: 'record', value: false, channels: 1 });
  // The worklet flushes its tail on the record:false message; main waits a
  // beat for that to cross IPC, and this closes the graph at roughly the same
  // pace so the two never race.
  clearTimeout(stopTimer);
  stopTimer = setTimeout(() => {
    stopTimer = undefined;
    if (state.recording) return; // a new session already opened
    void stopGraph();
  }, 300);
});
