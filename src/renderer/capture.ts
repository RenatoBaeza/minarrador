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

import type { CaptureStatus } from '../shared/types';
import type { CaptureConfig } from './bridges';

const SAMPLE_RATE = 16000;

interface Source {
  stream: MediaStream | null;
  node: MediaStreamAudioSourceNode | null;
  analyser: AnalyserNode | null;
  ok: boolean;
  error: string;
  label: string;
}

const source = (): Source => ({ stream: null, node: null, analyser: null, ok: false, error: '', label: '' });

const state = {
  ctx: null as AudioContext | null,
  worklet: null as AudioWorkletNode | null,
  mic: source(),
  system: source(),
  recording: false,
  /** WAV layout the main process asked for: 1 = summed, 2 = mic left, system right. */
  channels: 1,
  config: { captureMic: true, captureSystem: true, micDeviceId: '', micDeviceLabel: '' } as Omit<CaptureConfig, 'active'>,
  levelTimer: null as ReturnType<typeof setInterval> | null,
  /** RMS of the mix, as the worklet last reported it. */
  lastMixed: 0,
};

const message = (err: unknown): string => (err instanceof Error && err.message) || String(err);

function post(status: Partial<CaptureStatus>): void {
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
function micConstraints(deviceId: string): MediaStreamConstraints {
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
async function reportDevices(): Promise<void> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    window.capture.sendDevices(
      devices
        .filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'communications')
        .map((d) => ({ id: d.deviceId, label: d.label || 'Unnamed input' })),
    );
  } catch (err) {
    window.capture.sendDevices([]);
    post({ note: `Could not list the audio inputs: ${message(err)}` });
  }
}

/** Resolves the configured microphone to a device id this machine still has. */
async function chosenMicId(): Promise<string> {
  const { micDeviceId, micDeviceLabel } = state.config;
  if (!micDeviceId) return '';
  try {
    const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    if (inputs.some((d) => d.deviceId === micDeviceId)) return micDeviceId;
    // The id is salted per origin and can be reissued between sessions; the
    // label is how the same headset is recognised on the other side of that.
    const byLabel = micDeviceLabel ? inputs.find((d) => d.label === micDeviceLabel) : undefined;
    return byLabel ? byLabel.deviceId : micDeviceId;
  } catch {
    return micDeviceId;
  }
}

async function openMic(): Promise<void> {
  const s = state.mic;
  s.ok = false;
  s.error = '';
  s.label = '';

  const wanted = await chosenMicId();
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(micConstraints(wanted));
  } catch (err) {
    if (!wanted) {
      s.error = message(err);
      return;
    }
    // The chosen device has gone. Record on the default rather than not at all,
    // and say which one so the settings pane can mark the choice as missing.
    try {
      stream = await navigator.mediaDevices.getUserMedia(micConstraints(''));
      s.error = `${state.config.micDeviceLabel || 'The chosen microphone'} is not available; using the system default.`;
    } catch (fallbackErr) {
      s.error = message(fallbackErr);
      return;
    }
  }

  s.stream = stream;
  s.label = stream.getAudioTracks()[0]?.label ?? '';
  s.ok = true;
  await reportDevices();
}

async function openSystem(): Promise<void> {
  const s = state.system;
  s.ok = false;
  s.error = '';
  try {
    // The main process answers this with { video: screen, audio: 'loopback' }.
    // Video is required for the request to be granted but is dropped at once.
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    s.stream = stream;
    for (const track of stream.getVideoTracks()) {
      track.stop();
      stream.removeTrack(track);
    }
    if (stream.getAudioTracks().length === 0) {
      throw new Error('No system-audio track was returned (loopback unavailable).');
    }
    s.ok = true;
  } catch (err) {
    s.error = message(err);
  }
}

function closeSource(s: Source): void {
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
function attach(ctx: AudioContext, s: Source, merger: ChannelMergerNode, channel: number): void {
  if (!s.stream) return;
  s.node = ctx.createMediaStreamSource(s.stream);
  s.analyser = ctx.createAnalyser();
  s.analyser.fftSize = 512;
  s.node.connect(s.analyser);
  s.node.connect(merger, 0, channel);
}

function analyserRms(analyser: AnalyserNode | null): number {
  if (!analyser) return 0;
  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

async function startGraph(): Promise<void> {
  await stopGraph();

  if (state.config.captureMic) await openMic();
  if (state.config.captureSystem) await openSystem();

  if (!state.mic.ok && !state.system.ok) {
    post({ fatal: 'No audio source available. Check microphone and screen-recording permissions.' });
    return;
  }

  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'playback' });
  state.ctx = ctx;
  await ctx.audioWorklet.addModule('pcm-worklet.js');

  const merger = ctx.createChannelMerger(2);
  attach(ctx, state.mic, merger, 0);
  attach(ctx, state.system, merger, 1);

  const worklet = new AudioWorkletNode(ctx, 'pcm-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: 'explicit',
    // 'speakers' would helpfully fold our two deliberately different signals
    // back into the mono we just stopped producing.
    channelInterpretation: 'discrete',
  });
  state.worklet = worklet;
  worklet.port.onmessage = (e: MessageEvent<{ type: string; buffer?: ArrayBuffer; rms?: number }>) => {
    const msg = e.data;
    if (msg.type === 'pcm') {
      if (state.recording && msg.buffer) window.capture.sendPcm(msg.buffer);
    } else if (msg.type === 'level') {
      state.lastMixed = msg.rms ?? 0;
    }
  };
  // A graph rebuilt mid-meeting — a renderer crash, a resume from sleep, a
  // source ending — arrives here with the recording still open in the main
  // process. Telling the new worklet what it is joining is what makes the WAV
  // start growing again; waiting for another capture:setRecording would leave
  // the rest of the meeting silent whenever one never came.
  worklet.port.postMessage({ type: 'record', value: state.recording, channels: state.channels });

  const silent = ctx.createGain();
  silent.gain.value = 0;
  merger.connect(worklet);
  worklet.connect(silent).connect(ctx.destination);

  await ctx.resume();

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
        setTimeout(() => startGraph().catch((e: unknown) => post({ fatal: message(e) })), 1500);
      };
    });
  }

  post({});
}

async function stopGraph(): Promise<void> {
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
  const { active, ...rest } = cfg;
  state.config = { ...state.config, ...rest };
  if (active === false) {
    await stopGraph();
    post({ running: false });
    return;
  }
  try {
    await startGraph();
  } catch (err) {
    post({ fatal: message(err) });
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
  if (state.mic.ok) void reportDevices();
});
