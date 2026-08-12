'use strict';

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

const SAMPLE_RATE = 16000;

const state = {
  ctx: null,
  worklet: null,
  stream: null,
  micOk: false,
  micError: '',
  micLabel: '',
  recording: false,
  config: { micDeviceId: '', micDeviceLabel: '' },
};

/** Pending teardown from a stop, so a start that follows it can cancel it. */
let stopTimer = null;

function post(status) {
  window.dictate.sendStatus({
    micOk: state.micOk,
    micError: state.micError,
    micLabel: state.micLabel,
    ...status,
  });
}

/** Same constraints as the meeting capture: mono, with the echo team on. */
function micConstraints(deviceId) {
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
async function chosenMicId() {
  const { micDeviceId, micDeviceLabel } = state.config;
  if (!micDeviceId) return '';
  try {
    const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    if (inputs.some((d) => d.deviceId === micDeviceId)) return micDeviceId;
    const byLabel = micDeviceLabel && inputs.find((d) => d.label === micDeviceLabel);
    return byLabel ? byLabel.deviceId : micDeviceId;
  } catch {
    return micDeviceId;
  }
}

async function openMic() {
  state.micOk = false;
  state.micError = '';
  state.micLabel = '';
  try {
    state.stream = await navigator.mediaDevices.getUserMedia(micConstraints(await chosenMicId()));
  } catch (err) {
    state.micError = err?.message || String(err);
    post({});
    return;
  }
  state.micLabel = state.stream.getAudioTracks()[0]?.label ?? '';
  state.micOk = true;
  post({});
}

/** Wires the mic onto channel 0 of a 2-channel merger; channel 1 stays silent. */
async function buildGraph() {
  state.ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'playback' });
  await state.ctx.audioWorklet.addModule('pcm-worklet.js');

  const source = state.ctx.createMediaStreamSource(state.stream);
  const merger = state.ctx.createChannelMerger(2);
  source.connect(merger, 0, 0);

  state.worklet = new AudioWorkletNode(state.ctx, 'pcm-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: 'explicit',
    channelInterpretation: 'discrete',
  });
  state.worklet.port.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'pcm') {
      if (state.recording) window.dictate.sendPcm(msg.buffer);
    } else if (msg.type === 'level') {
      window.dictate.sendLevel(msg.rms);
    }
  };

  const silent = state.ctx.createGain();
  silent.gain.value = 0;
  merger.connect(state.worklet);
  state.worklet.connect(silent).connect(state.ctx.destination);
  await state.ctx.resume();
}

async function stopGraph() {
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
  state.config = { ...state.config, ...cfg };
  clearTimeout(stopTimer);
  stopTimer = null;
  if (!state.ctx) {
    await openMic();
    if (!state.micOk) return;
    try {
      await buildGraph();
    } catch (err) {
      post({ fatal: err?.message || String(err) });
      return;
    }
  }
  state.recording = true;
  // The worklet is told the layout as it is built, exactly as the meeting graph
  // does, so a session cannot miss a message it was not up in time for.
  state.worklet?.port.postMessage({ type: 'record', value: true, channels: 1 });
});

window.dictate.onStop(async () => {
  state.recording = false;
  state.worklet?.port.postMessage({ type: 'record', value: false, channels: 1 });
  // The worklet flushes its tail on the record:false message; main waits a
  // beat for that to cross IPC, and this closes the graph at roughly the same
  // pace so the two never race.
  clearTimeout(stopTimer);
  stopTimer = setTimeout(() => {
    stopTimer = null;
    if (state.recording) return; // a new session already opened
    stopGraph();
  }, 300);
});
