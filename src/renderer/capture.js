'use strict';

// Owns the audio graph. Two sources (microphone, system loopback) are mixed to
// one 16 kHz mono stream. The same graph serves both jobs: it always reports a
// level so the app can suggest recording, and it emits PCM only while armed.
//
//   mic ──► gain ─┐
//                 ├─► mixer ─► pcm-processor ─► (zero gain) ─► destination
//   system ─ gain ┘
//
// The worklet must stay reachable from destination or Chromium stops pulling
// it, hence the muted tail.

const SAMPLE_RATE = 16000;

const state = {
  ctx: null,
  worklet: null,
  mic: { stream: null, node: null, analyser: null, ok: false, error: '' },
  system: { stream: null, node: null, analyser: null, ok: false, error: '' },
  recording: false,
  config: { captureMic: true, captureSystem: true },
  levelTimer: null,
};

function post(status) {
  window.capture.sendStatus({
    micOk: state.mic.ok,
    systemOk: state.system.ok,
    micError: state.mic.error,
    systemError: state.system.error,
    running: Boolean(state.ctx),
    ...status,
  });
}

async function openMic() {
  const s = state.mic;
  s.ok = false;
  s.error = '';
  try {
    // Echo cancellation stops the far end (already captured via loopback) from
    // being picked up twice through the speakers.
    s.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      video: false,
    });
    s.ok = true;
  } catch (err) {
    s.error = err?.message || String(err);
  }
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

function attach(source, mixer, gain) {
  if (!source.stream) return;
  source.node = state.ctx.createMediaStreamSource(source.stream);
  source.analyser = state.ctx.createAnalyser();
  source.analyser.fftSize = 512;
  const g = state.ctx.createGain();
  g.gain.value = gain;
  source.node.connect(source.analyser);
  source.node.connect(g).connect(mixer);
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

  const mixer = state.ctx.createGain();
  mixer.channelCount = 1;
  mixer.channelCountMode = 'explicit';
  mixer.channelInterpretation = 'speakers';
  mixer.gain.value = 1;

  // Halve each source when both are live so a two-way sum cannot clip.
  const gain = state.mic.ok && state.system.ok ? 0.6 : 1.0;
  attach(state.mic, mixer, gain);
  attach(state.system, mixer, gain);

  state.worklet = new AudioWorkletNode(state.ctx, 'pcm-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: 'explicit',
  });
  state.worklet.port.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'pcm') {
      if (state.recording) window.capture.sendPcm(msg.buffer);
    } else if (msg.type === 'level') {
      state.lastMixed = msg.rms;
    }
  };

  const silent = state.ctx.createGain();
  silent.gain.value = 0;
  mixer.connect(state.worklet);
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

window.capture.onSetRecording((value) => {
  state.recording = Boolean(value);
  state.worklet?.port.postMessage({ type: 'record', value: state.recording });
  // Reset transcript when a new recording starts
  if (state.recording) {
    const transDiv = document.getElementById('transcript');
    if (transDiv) transDiv.textContent = '';
  }
});

// Language selector handling
const langSelect = document.getElementById('langSelect');
if (langSelect) {
  langSelect.addEventListener('change', (e) => {
    const lang = e.target.value;
    window.capture.setLanguage(lang);
  });
}

// Transcription display
window.capture.onTranscription((text) => {
  const transDiv = document.getElementById('transcript');
  if (transDiv) {
    const span = document.createElement('span');
    span.className = 'sentence';
    span.textContent = text + ' ';
    transDiv.appendChild(span);
    transDiv.scrollTop = transDiv.scrollHeight;
  }
});
