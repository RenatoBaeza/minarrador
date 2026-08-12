'use strict';

// Owns the audio graph. Two sources (microphone, system loopback) are kept
// apart all the way to the worklet, at 16 kHz. The same graph serves both jobs:
// it always reports a level so the app can suggest recording, and it emits PCM
// only while armed.
//
//   mic ────► analyser
//        └──► merger[0] ─┐
//                        ├─► pcm-processor ─► (zero gain) ─► destination
//   system ─► merger[1] ─┘
//        └──► analyser
//
// The merger rather than a mixer is the whole of item 5: left is you, right is
// everyone else, so the pipeline can transcribe the two separately and label
// every line with who said it. Mixing them to mono threw that away for nothing —
// the two sources were never the same signal. A merger input is mono by
// definition, so the system's stereo loopback is folded down on the way in.
//
// The worklet must stay reachable from destination or Chromium stops pulling
// it, hence the muted tail.

const SAMPLE_RATE = 16000;

const state = {
  ctx: null,
  worklet: null,
  mic: { stream: null, node: null, analyser: null, ok: false, error: '', label: '' },
  system: { stream: null, node: null, analyser: null, ok: false, error: '' },
  recording: false,
  /** WAV layout the main process asked for: 1 = summed, 2 = mic left, system right. */
  channels: 1,
  config: { captureMic: true, captureSystem: true, micDeviceId: '', micDeviceLabel: '' },
  levelTimer: null,
};

function post(status) {
  window.capture.sendStatus({
    micOk: state.mic.ok,
    systemOk: state.system.ok,
    micError: state.mic.error,
    systemError: state.system.error,
    // Which microphone is actually being recorded, which is the one thing a
    // green "Mic ✓" could never tell anyone. Picking the wrong default input is
    // silent otherwise: the meeting records the laptop lid instead of a headset.
    micLabel: state.mic.label,
    running: Boolean(state.ctx),
    ...status,
  });
}

/**
 * Constraints for the chosen microphone.
 *
 * `exact` rather than `ideal` on purpose: a device that has been unplugged
 * should fail loudly here and fall back once, with the fallback reported, not
 * quietly record something else for an hour. The label is the second key
 * because Chromium's device ids are salted per origin and do not always survive
 * a restart — the name on the box does.
 */
function micConstraints(deviceId) {
  return {
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      // Echo cancellation stops the far end (already captured via loopback) from
      // being picked up twice through the speakers.
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
    video: false,
  };
}

/**
 * The input devices the app can offer, and what is on them.
 *
 * Only meaningful once a microphone has been opened: without permission
 * Chromium returns entries with empty labels, which is a picker nobody can use.
 */
async function reportDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    window.capture.sendDevices(
      devices
        .filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'communications')
        .map((d) => ({ id: d.deviceId, label: d.label || 'Unnamed input' })),
    );
  } catch (err) {
    window.capture.sendDevices([]);
    post({ note: `Could not list the audio inputs: ${err.message}` });
  }
}

/** Resolves the configured microphone to a device id this machine still has. */
async function chosenMicId() {
  const { micDeviceId, micDeviceLabel } = state.config;
  if (!micDeviceId) return '';
  try {
    const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    if (inputs.some((d) => d.deviceId === micDeviceId)) return micDeviceId;
    // The id is salted per origin and can be reissued between sessions; the
    // label is how the same headset is recognised on the other side of that.
    const byLabel = micDeviceLabel && inputs.find((d) => d.label === micDeviceLabel);
    return byLabel ? byLabel.deviceId : micDeviceId;
  } catch {
    return micDeviceId;
  }
}

async function openMic() {
  const s = state.mic;
  s.ok = false;
  s.error = '';
  s.label = '';

  const wanted = await chosenMicId();
  try {
    s.stream = await navigator.mediaDevices.getUserMedia(micConstraints(wanted));
  } catch (err) {
    if (!wanted) {
      s.error = err?.message || String(err);
      return;
    }
    // The chosen device has gone. Record on the default rather than not at all,
    // and say which one so the settings pane can mark the choice as missing.
    try {
      s.stream = await navigator.mediaDevices.getUserMedia(micConstraints(''));
      s.error = `${state.config.micDeviceLabel || 'The chosen microphone'} is not available; using the system default.`;
    } catch (fallbackErr) {
      s.error = fallbackErr?.message || String(fallbackErr);
      return;
    }
  }

  s.label = s.stream.getAudioTracks()[0]?.label ?? '';
  s.ok = true;
  await reportDevices();
}

async function openSystem() {
  const s = state.system;
  s.ok = false;
  s.error = '';
  try {
    // The main process answers this with { video: screen, audio: 'loopback' }.
    // Video is required for the request to be granted but is dropped at once.
    s.stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    for (const track of s.stream.getVideoTracks()) {
      track.stop();
      s.stream.removeTrack(track);
    }
    if (s.stream.getAudioTracks().length === 0) {
      throw new Error('No system-audio track was returned (loopback unavailable).');
    }
    s.ok = true;
  } catch (err) {
    s.error = err?.message || String(err);
  }
}

function closeSource(s) {
  try {
    s.node?.disconnect();
  } catch {
    /* already torn down */
  }
  s.node = null;
  s.analyser = null;
  s.stream?.getTracks().forEach((t) => t.stop());
  s.stream = null;
  s.ok = false;
}

/** Wires one source onto its own channel of the merger, and its own analyser. */
function attach(source, merger, channel) {
  if (!source.stream) return;
  source.node = state.ctx.createMediaStreamSource(source.stream);
  source.analyser = state.ctx.createAnalyser();
  source.analyser.fftSize = 512;
  source.node.connect(source.analyser);
  source.node.connect(merger, 0, channel);
}

function analyserRms(analyser) {
  if (!analyser) return 0;
  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

async function startGraph() {
  await stopGraph();

  if (state.config.captureMic) await openMic();
  if (state.config.captureSystem) await openSystem();

  if (!state.mic.ok && !state.system.ok) {
    post({ fatal: 'No audio source available. Check microphone and screen-recording permissions.' });
    return;
  }

  state.ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'playback' });
  await state.ctx.audioWorklet.addModule('pcm-worklet.js');

  const merger = state.ctx.createChannelMerger(2);
  attach(state.mic, merger, 0);
  attach(state.system, merger, 1);

  state.worklet = new AudioWorkletNode(state.ctx, 'pcm-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: 'explicit',
    // 'speakers' would helpfully fold our two deliberately different signals
    // back into the mono we just stopped producing.
    channelInterpretation: 'discrete',
  });
  state.worklet.port.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'pcm') {
      if (state.recording) window.capture.sendPcm(msg.buffer);
    } else if (msg.type === 'level') {
      state.lastMixed = msg.rms;
    }
  };
  // A graph rebuilt mid-meeting — a renderer crash, a resume from sleep, a
  // source ending — arrives here with the recording still open in the main
  // process. Telling the new worklet what it is joining is what makes the WAV
  // start growing again; waiting for another capture:setRecording would leave
  // the rest of the meeting silent whenever one never came.
  state.worklet.port.postMessage({ type: 'record', value: state.recording, channels: state.channels });

  const silent = state.ctx.createGain();
  silent.gain.value = 0;
  merger.connect(state.worklet);
  state.worklet.connect(silent).connect(state.ctx.destination);

  await state.ctx.resume();

  state.levelTimer = setInterval(() => {
    window.capture.sendLevel({
      mixed: state.lastMixed ?? 0,
      mic: analyserRms(state.mic.analyser),
      system: analyserRms(state.system.analyser),
    });
  }, 200);

  // A device unplug or a user "stop sharing" click ends the track; rebuild.
  for (const s of [state.mic, state.system]) {
    s.stream?.getAudioTracks().forEach((t) => {
      t.onended = () => {
        s.ok = false;
        post({ note: 'A capture source ended; restarting.' });
        setTimeout(() => startGraph().catch((e) => post({ fatal: e.message })), 1500);
      };
    });
  }

  post({});
}

async function stopGraph() {
  if (state.levelTimer) {
    clearInterval(state.levelTimer);
    state.levelTimer = null;
  }
  try {
    state.worklet?.disconnect();
  } catch {
    /* already torn down */
  }
  state.worklet = null;
  closeSource(state.mic);
  closeSource(state.system);
  if (state.ctx) {
    await state.ctx.close().catch(() => {});
    state.ctx = null;
  }
}

window.capture.onConfigure(async (cfg) => {
  state.config = { ...state.config, ...cfg };
  if (cfg.active === false) {
    await stopGraph();
    post({ running: false });
    return;
  }
  try {
    await startGraph();
  } catch (err) {
    post({ fatal: err?.message || String(err) });
  }
});

window.capture.onSetRecording((value, channels) => {
  state.recording = Boolean(value);
  if (channels === 1 || channels === 2) state.channels = channels;
  state.worklet?.port.postMessage({ type: 'record', value: state.recording, channels: state.channels });
});

// Plugging in a headset mid-meeting changes what the picker should offer, and
// the labels only exist once something has been opened — so this is also how an
// empty first list fills in.
navigator.mediaDevices?.addEventListener?.('devicechange', () => {
  if (state.mic.ok) reportDevices();
});
