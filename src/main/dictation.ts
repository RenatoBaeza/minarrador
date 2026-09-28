// The voice-input controller: a hidden, mic-only capture worker plus the
// record → transcribe → return pipeline for the dictation hotkey.
//
// Deliberately separate from CaptureController. That one owns the meeting
// graph, writes to a WAV, and watches for silence; this one grabs the mic for
// the length of a sentence, keeps the audio in memory, and hands the finished
// text back to main. The two never share a window or a stream, so a dictation
// can run in the middle of a recorded meeting without either disturbing the
// other.

import { BrowserWindow, ipcMain } from 'electron';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

import log from './logger';
import { Ollama } from './ollama';
import { LiveTranscriber, registerMediaClient, unregisterMediaClient, type LiveWhisper } from './capture';
import { buildWav, rms } from './wav';
import { errorMessage } from './errors';
import type { Engine } from './settings';
import type { DictateStatus } from '../shared/types';

export const SAMPLE_RATE = 16000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2; // 16-bit mono

/**
 * Hard ceiling on one dictation, in seconds.
 *
 * The hotkey is a toggle, so a press nobody noticed could otherwise leave the
 * mic open and RAM filling for ever. Five minutes is far past a sentence and
 * still only ~10 MB of PCM. Main stops the session at the cap and says so.
 */
export const MAX_SECONDS = 300;
/**
 * How long a stop waits for the worklet's final flush to cross IPC.
 *
 * The renderer sends `dictate:stop`, the worklet is told to stop recording and
 * posts the last buffered batch, then the graph closes. This is the same
 * settle window CaptureController.stopRecording uses, and for the same reason.
 */
const STOP_SETTLE_MS = 400;
/** Edges of the clip quieter than this are room tone, not speech. */
export const SILENCE_GATE = 0.004;
/** How long a transcription request for a whisper segment is allowed to take. */
const whisperTimeoutMs = (seconds: number): number => Math.max(60_000, Math.round(seconds * 15_000));

const RENDERER = path.join(__dirname, '..', 'renderer');

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Which engine will transcribe a finished dictation.
 *
 * The setting names the preference; this resolves it against what is actually
 * installed, exactly like transcribeEngineFor in pipeline.ts. A preference
 * whose engine cannot run falls back to the other one, because a dictation
 * that cannot be transcribed is a dictation that is lost — the failure mode
 * that matters here.
 */
export function dictationEngineFor(
  config: { dictateEngine: string },
  whisper: { available?: boolean } | null | undefined,
  ollamaUp: boolean,
): Engine {
  const wantsWhisper = config.dictateEngine !== 'ollama';
  const whisperThere = Boolean(whisper?.available);
  if (wantsWhisper && whisperThere) return 'whisper';
  if (!wantsWhisper && ollamaUp) return 'ollama';
  if (whisperThere) return 'whisper';
  return 'ollama';
}

/**
 * Trims room tone off both ends of a mono PCM clip.
 *
 * A dictation starts and ends with the tap of the hotkey, which is almost never
 * aligned with the first and last word. Windowed RMS — 50 ms at a time — finds
 * the audible span instead of trusting the exact byte the user released the
 * key on, and sending the surrounding silence to an audio model is exactly how
 * an otherwise fine sentence comes back with a phantom "[no speech]" prefix.
 *
 * @param pcm mono 16-bit PCM
 * @returns a view over the original buffer, or an empty one
 */
export function trimSilence(
  pcm: Buffer,
  { sampleRate = SAMPLE_RATE, gate = SILENCE_GATE }: { sampleRate?: number; gate?: number } = {},
): Buffer {
  const frames = Math.floor(pcm.length / 2);
  const windowFrames = Math.max(1, Math.round(sampleRate * 0.05));
  let first = -1;
  let last = -1;
  for (let start = 0; start < frames; start += windowFrames) {
    const end = Math.min(start + windowFrames, frames);
    if (rms(pcm, start * 2, end * 2) >= gate) {
      if (first === -1) first = start;
      last = end;
    }
  }
  if (first === -1) return pcm.subarray(0, 0);
  return pcm.subarray(first * 2, last * 2);
}

/** Which microphone to open, as the settings name it. */
export interface MicChoice {
  micDeviceId?: string;
  micDeviceLabel?: string;
}

export interface DictationStartConfig extends MicChoice {
  transcribeModel?: string;
  liveEngine?: Engine;
}

export interface DictationResult {
  text: string;
  seconds: number;
  /** Why a non-empty clip could not be transcribed. */
  error?: string;
  /** Where the clip was kept, when it was kept for a failed transcription. */
  saved?: string;
}

/**
 * Drives one voice-input session from the main process.
 *
 * Emits `live` (one live caption while recording), `level` (an RMS level, for
 * the indicator), `status` (what the worker reported about the mic) and `cap`
 * (a session ran into MAX_SECONDS).
 */
export class DictationController extends EventEmitter {
  window: BrowserWindow | null = null;
  readonly ollama: Ollama;
  readonly whisper: LiveWhisper | null;
  /** Where a clip whose transcription failed is kept. */
  readonly errorDir: string;
  /** Live preview of what is being said, shown on the indicator. */
  readonly live: LiveTranscriber;
  /** PCM buffers accumulating for this session, mono. */
  chunks: Buffer[] = [];
  bytes = 0;
  /** True from the hotkey press until the final transcription has been returned. */
  active = false;
  /** Recording, as opposed to the final transcription run. */
  recording = false;
  /** True while the model is decoding the clip. */
  transcribing = false;
  /** Why the microphone could not open, if it could not. */
  micError = '';
  startedAt: Date | null = null;
  /** Set once a session exceeds MAX_SECONDS, so the cap is reported once. */
  capped = false;
  _quitting = false;

  /**
   * `errorDir` is where a clip whose transcription failed is kept, so the
   * "never lose the meeting" rule extends to dictations.
   */
  constructor({
    ollamaHost,
    whisper = null,
    errorDir = '',
  }: { ollamaHost?: string; whisper?: LiveWhisper | null; errorDir?: string } = {}) {
    super();
    this.ollama = new Ollama(ollamaHost);
    this.whisper = whisper;
    this.errorDir = errorDir;
    this.live = new LiveTranscriber({ ollama: this.ollama, whisper });
    this.live.on('text', (text: string) => this.emit('live', text));
  }

  /** Seconds of audio captured so far. */
  get elapsedSeconds(): number {
    return this.bytes / BYTES_PER_SECOND;
  }

  async init(): Promise<void> {
    ipcMain.on('dictate:pcm', (event, arrayBuffer: ArrayBuffer) => {
      // Gated on `active` rather than `recording` on purpose: a stop first
      // clears `recording`, and the worklet's final flush crosses IPC in the
      // beat that follows — drop it and the last ~256 ms of the sentence is
      // missing. The meeting capture gates on the writer being open for the
      // same reason.
      if (event.sender.id !== this.window?.webContents.id || !this.active) return;
      const buf = Buffer.from(arrayBuffer);
      this.chunks.push(buf);
      this.bytes += buf.length;
      this.live.push(buf);
      if (this.bytes >= MAX_SECONDS * BYTES_PER_SECOND) {
        if (!this.capped) {
          this.capped = true;
          this.emit('cap');
        }
      }
    });

    ipcMain.on('dictate:level', (event, level: unknown) => {
      if (event.sender.id !== this.window?.webContents.id) return;
      if (typeof level === 'number' && Number.isFinite(level)) this.emit('level', level);
    });

    ipcMain.on('dictate:status', (event, status: DictateStatus | null | undefined) => {
      if (event.sender.id !== this.window?.webContents.id) return;
      if (status?.fatal) {
        this.micError = status.fatal;
        log.error('dictation capture fatal:', status.fatal);
      } else if (status?.micError) {
        this.micError = status.micError;
        log.warn('dictation mic:', status.micError);
      }
      // Forwarded so main can run the settings pane's mic test on the same
      // worker — the test needs the mic's name and its failures too.
      this.emit('status', status ?? {});
    });

    await this.#createWindow();
  }

  /**
   * Builds the hidden worker that owns the dictation audio graph.
   *
   * A second window rather than a second graph in the meeting capture worker:
   * a shared graph would have to interleave two different owners of the same
   * mic stream, and the only thing that buys is a battle over who is recording.
   */
  async #createWindow(): Promise<void> {
    const win = new BrowserWindow({
      show: false,
      width: 420,
      height: 320,
      skipTaskbar: true,
      webPreferences: {
        preload: path.join(RENDERER, 'dictate-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    this.window = win;

    // Media permission is gated on an allow-list in capture.ts; join it so the
    // dictation worker is the one place besides the meeting worker that can
    // open a microphone.
    registerMediaClient(win.webContents.id);

    win.on('close', (e) => {
      if (!this._quitting) e.preventDefault();
    });
    win.webContents.on('console-message', (e) => {
      const level = e.level === 'error' ? 'error' : e.level === 'warning' ? 'warn' : null;
      if (level) log[level](`dictate renderer: ${e.message}`);
    });

    await win.loadFile(path.join(RENDERER, 'dictate-capture.html'));
  }

  /** Opens the mic and starts accumulating audio. */
  start(cfg: DictationStartConfig = {}): void {
    if (this.active || !this.window) return;
    this.chunks.length = 0;
    this.bytes = 0;
    this.active = true;
    this.recording = true;
    this.transcribing = false;
    this.micError = '';
    this.capped = false;
    this.startedAt = new Date();

    // The live preview is best-effort (whisper.cpp when it is there); the saved
    // pass — the text that actually gets pasted — is decided by main at stop.
    this.live.configure({
      enabled: true,
      engine: cfg.liveEngine ?? 'whisper',
      model: cfg.transcribeModel,
    });
    this.live.start(1);

    // A cold audio model would otherwise pay its load on the very sentence the
    // user wants back fastest.
    void this.ollama.preload(cfg.transcribeModel ?? '');

    this.window.webContents.send('dictate:start', {
      micDeviceId: cfg.micDeviceId ?? '',
      micDeviceLabel: cfg.micDeviceLabel ?? '',
    });
    log.info('dictation started');
  }

  /**
   * Opens the microphone and streams levels, recording and transcribing nothing.
   *
   * The settings pane's mic test: same worker, same mic resolution, and the
   * levels it already reports — just with `test: true` telling the renderer to
   * keep the graph out of the record path. Distinct from {@link start} so a
   * test can never be mistaken for a dictation session (`this.active` stays
   * false, and a test mic can be opened or closed at will).
   */
  startTest(cfg: MicChoice = {}): void {
    if (this.active || !this.window) return;
    this.micError = '';
    this.window.webContents.send('dictate:start', {
      micDeviceId: cfg.micDeviceId ?? '',
      micDeviceLabel: cfg.micDeviceLabel ?? '',
      test: true,
    });
  }

  /** Closes the microphone the settings pane asked to hear. */
  stopTest(): void {
    this.window?.webContents.send('dictate:stop');
  }

  /** Stops the session early — a quit, a cap, a user cancel. No transcription. */
  cancel(): void {
    if (!this.active) return;
    this.recording = false;
    this.transcribing = false;
    this.active = false;
    this.live.stop();
    this.window?.webContents.send('dictate:stop');
    this.chunks.length = 0;
    this.bytes = 0;
  }

  /**
   * Closes the capture, transcribes what was said, and returns it.
   *
   * @param opts the engine main resolved for the *saved* pass, and its model name.
   */
  async stop({ engine = 'whisper', model = '' }: { engine?: Engine; model?: string } = {}): Promise<DictationResult> {
    if (!this.active) return { text: '', seconds: 0 };
    this.recording = false;
    this.transcribing = true;

    this.window?.webContents.send('dictate:stop');
    this.live.stop();

    // Let the worklet's final flush land before sealing the clip.
    await delay(STOP_SETTLE_MS);

    const chunks = this.chunks;
    const bytes = this.bytes;
    this.chunks = [];
    this.bytes = 0;
    this.active = false;

    const seconds = bytes / BYTES_PER_SECOND;
    const trimmed = trimSilence(Buffer.concat(chunks, bytes));

    // A microphone that never opened is the other way to capture nothing.
    if (seconds < 0.25 && this.micError) {
      this.transcribing = false;
      return { text: '', seconds, error: this.micError };
    }

    let text = '';
    let error = '';
    let saved = '';
    // Nothing audible — a mistap of the hotkey — is not an error, just nothing.
    if (trimmed.length > 0 && rms(trimmed) >= SILENCE_GATE && trimmed.length >= BYTES_PER_SECOND) {
      try {
        text = await this.#transcribe(trimmed, { engine, model });
      } catch (err) {
        error = (err instanceof Error && err.message) || String(err);
        log.error('dictation transcription failed:', error);
        // The words are not recoverable, but the audio is — keep it so a
        // machine that comes back can still finish the job by hand.
        saved = this.#saveClip(trimmed);
      }
    }
    this.transcribing = false;
    log.info(`dictation stopped: ${seconds.toFixed(1)}s, ${text ? `${text.length} chars` : 'no speech'}`);
    return { text, seconds, error, saved };
  }

  /** @param pcm mono PCM, already trimmed */
  async #transcribe(pcm: Buffer, { engine, model }: { engine: Engine; model: string }): Promise<string> {
    const seconds = pcm.length / BYTES_PER_SECOND;
    const wav = buildWav(pcm, SAMPLE_RATE);
    if (engine === 'whisper') {
      if (!this.whisper?.available) throw new Error('whisper.cpp is not installed');
      return this.whisper.transcribe(wav, { timeoutMs: whisperTimeoutMs(seconds) });
    }
    if (!model) throw new Error('no Ollama audio model is configured');
    return this.ollama.transcribe(model, wav, { seconds });
  }

  /** @param pcm mono PCM */
  #saveClip(pcm: Buffer): string {
    if (!this.errorDir) return '';
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = path.join(this.errorDir, `dictation-${stamp}.wav`);
      fs.mkdirSync(this.errorDir, { recursive: true });
      fs.writeFileSync(file, buildWav(pcm, SAMPLE_RATE));
      return file;
    } catch (err) {
      log.warn('could not keep the failed dictation clip:', errorMessage(err));
      return '';
    }
  }

  destroy(): void {
    this._quitting = true;
    this.live.stop();
    this.live.removeAllListeners();
    if (this.window && !this.window.isDestroyed()) {
      unregisterMediaClient(this.window.webContents.id);
      this.window.destroy();
    }
    this.window = null;
  }
}
