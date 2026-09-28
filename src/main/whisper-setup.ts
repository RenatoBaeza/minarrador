// Fetches whisper.cpp — the prebuilt server binary and a GGML model — into an
// install root the WhisperServer can then find.
//
// This is the one place in src/main that reaches beyond this machine, and it is
// worth being precise about what that means. Nothing about a meeting is
// involved: no audio, no transcript, no telemetry, no identifier. Two fixed
// hosts are contacted, for two files, and only when somebody presses the button
// that says so. Everything the app does *with* a meeting still happens here.
//
// It used to live only in scripts/setup-whisper, on the reasoning that a
// download should be something you type rather than something an app decides to
// do. That reasoning survives — this still never runs on its own — but the
// conclusion did not: anyone who installed the build has no checkout, no npm
// and no terminal, so "run npm run whisper:setup" was an instruction to nobody,
// and the app shipped able to be in a state it could not get out of.
//
// Layout it produces, under `root`:
//   bin/whisper-server.exe (+ the ggml/whisper DLLs beside it)
//   models/ggml-<name>.bin
//   INSTALL.json

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

/** Pinned so a rebuild is reproducible; bump deliberately. */
export const RELEASE = 'v1.9.2';

/**
 * Release assets worth offering. The plain CPU build already dispatches between
 * per-microarchitecture DLLs at runtime, so it is a sound default; the others
 * are for machines with the matching hardware and drivers.
 */
export const VARIANTS = {
  cpu: 'whisper-bin-x64.zip',
  blas: 'whisper-blas-bin-x64.zip',
  'cublas-11.8': 'whisper-cublas-11.8.0-bin-x64.zip',
  'cublas-12.4': 'whisper-cublas-12.4.0-bin-x64.zip',
} as const;

/**
 * Models, with the rough cost of each. Live captions are superseded by the
 * post-recording pass, so the trade is latency against how readable the preview
 * is while the meeting is happening.
 *
 * A `qN_M` suffix is a quantised copy of the model above it: same weights at
 * lower precision, so it loads and decodes faster on a fraction of the memory
 * for a small accuracy cost. That is what makes `large-v3-turbo-q5_0` the
 * accurate pick here rather than `large-v3` — turbo's decoder is distilled down
 * to 4 layers from 32, and the quantisation brings it under 600 MB, so it stays
 * usable on CPU where the full model does not.
 */
export const MODELS = {
  tiny: '75 MB · fastest, visibly more errors',
  'tiny.en': '75 MB · English only',
  base: '142 MB · the default; comfortably realtime on CPU',
  'base.en': '142 MB · English only',
  small: '466 MB · noticeably more accurate, ~3x realtime',
  'small.en': '466 MB · English only',
  medium: '1.5 GB · accurate, needs a strong CPU or GPU build',
  'large-v3-turbo': '1.6 GB · large-v3 accuracy, GPU build recommended',
  'large-v3-turbo-q5_0': '547 MB · the accurate pick — near large-v3, runs on CPU',
  'large-v3': '2.9 GB · most accurate; GPU build, not realtime on CPU',
} as const;

export type WhisperModelKey = keyof typeof MODELS;
export type WhisperVariant = keyof typeof VARIANTS;

/** One step of an install, as reported to whoever is showing it. */
export interface InstallProgress {
  phase: 'binaries' | 'unpacking' | 'model' | 'done';
  label?: string;
  completed?: number;
  total?: number;
  done?: boolean;
}

type DownloadProgress = Omit<InstallProgress, 'phase'>;

const MODEL_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';
const RELEASE_BASE_URL = `https://github.com/ggml-org/whisper.cpp/releases/download/${RELEASE}`;

export const SERVER_EXE = process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server';

export function human(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

/**
 * Streams a URL to disk.
 *
 * Downloads to a temporary name and renames on success, so an interrupted run
 * never leaves a half-file that later looks like a working install — which
 * would be the worst outcome here, since `available` is a file-exists check.
 */
async function download(
  url: string,
  dest: string,
  label: string,
  { onProgress, signal }: { onProgress?: (p: DownloadProgress) => void; signal?: AbortSignal } = {},
): Promise<void> {
  const res = await fetch(url, { redirect: 'follow', signal });
  if (!res.ok || !res.body) throw new Error(`${label}: ${url} returned ${res.status}`);

  const total = Number(res.headers.get('content-length') ?? 0);
  let seen = 0;
  let lastTick = 0;
  const tmp = `${dest}.part`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  const body = Readable.fromWeb(res.body as WebReadableStream<Uint8Array>);
  body.on('data', (chunk: Buffer) => {
    seen += chunk.length;
    const now = Date.now();
    if (now - lastTick < 250) return;
    lastTick = now;
    onProgress?.({ label, completed: seen, total });
  });

  try {
    await pipeline(body, fs.createWriteStream(tmp), { signal });
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  fs.renameSync(tmp, dest);
  onProgress?.({ label, completed: seen, total: total || seen, done: true });
}

/**
 * Unpacks a zip using what Windows already has.
 *
 * The app ships no runtime dependencies and Node has no zip reader, so this
 * borrows Expand-Archive rather than pulling in a package for one call.
 */
function unzip(zipPath: string, destDir: string): void {
  fs.rmSync(destDir, { recursive: true, force: true });
  if (process.platform !== 'win32') {
    execFileSync('unzip', ['-q', zipPath, '-d', destDir], { stdio: 'ignore' });
    return;
  }
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`,
    ],
    { stdio: 'ignore', windowsHide: true },
  );
}

/**
 * Flattens the release layout into <root>/bin.
 *
 * The Windows zips put everything in a single `Release/` directory, but that is
 * an artefact of how they are built rather than a promise, so find the folder
 * holding the server binary instead of assuming the name.
 */
function installBinaries(unpackedDir: string, binDir: string): number {
  const stack = [unpackedDir];
  let source: string | null = null;
  while (stack.length && !source) {
    const dir = stack.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) stack.push(path.join(dir, entry.name));
      else if (entry.name === 'whisper-server.exe' || entry.name === 'whisper-server') source = dir;
    }
  }
  if (!source) throw new Error('the release archive contained no whisper-server binary');

  fs.rmSync(binDir, { recursive: true, force: true });
  fs.mkdirSync(binDir, { recursive: true });
  let copied = 0;
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    // The server plus the libraries it loads. The rest of the archive is other
    // examples and their test binaries, which would triple the install for
    // nothing — dropping them also keeps SDL2 and the talk-llama demo out.
    const keep =
      /^(whisper-server|whisper-cli)(\.exe)?$/.test(entry.name) || /\.(dll|so|dylib)$/i.test(entry.name);
    // SDL2 is only there for the microphone-capturing examples, which this app
    // has no use for — Minarrador does its own capture and posts WAVs.
    if (!keep || /^SDL2\./i.test(entry.name)) continue;
    fs.copyFileSync(path.join(source, entry.name), path.join(binDir, entry.name));
    copied++;
  }
  return copied;
}

export interface InstallOptions {
  /** Install directory; created if it does not exist. */
  root: string;
  /** A key of {@link MODELS}. */
  model?: string;
  /** A key of {@link VARIANTS}. */
  variant?: string;
  /** Re-download over an existing tree. */
  force?: boolean;
  onProgress?: (p: InstallProgress) => void;
  signal?: AbortSignal;
}

/**
 * Puts a working whisper.cpp under `root`.
 *
 * Models accumulate: installing a second one leaves the first in place and adds
 * to what Settings offers, so switching back is a click rather than another
 * download. The binaries are only fetched when they are not already there,
 * which is what makes "add a bigger model" cheap.
 */
export async function install({
  root,
  model = 'base',
  variant = 'cpu',
  force = false,
  onProgress,
  signal,
}: InstallOptions): Promise<{ root: string; model: string; binaries: number }> {
  if (!root) throw new Error('no install root was given');
  if (!Object.hasOwn(MODELS, model)) {
    throw new Error(`unknown model "${model}" — one of: ${Object.keys(MODELS).join(', ')}`);
  }
  if (!Object.hasOwn(VARIANTS, variant)) {
    throw new Error(`unknown variant "${variant}" — one of: ${Object.keys(VARIANTS).join(', ')}`);
  }
  if (process.platform !== 'win32' && variant !== 'cpu') {
    throw new Error('the prebuilt variants are Windows x64 only; build whisper.cpp yourself elsewhere');
  }

  const binDir = path.join(root, 'bin');
  const modelsDir = path.join(root, 'models');
  const modelName = `ggml-${model}.bin`;
  const modelFile = path.join(modelsDir, modelName);
  const serverExe = path.join(binDir, SERVER_EXE);

  let binaries = 0;
  if (!fs.existsSync(serverExe) || force) {
    const asset = VARIANTS[variant as WhisperVariant];
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'minarrador-whisper-'));
    try {
      const zip = path.join(work, asset);
      onProgress?.({ phase: 'binaries' });
      await download(`${RELEASE_BASE_URL}/${asset}`, zip, 'binaries', {
        onProgress: (p) => onProgress?.({ phase: 'binaries', ...p }),
        signal,
      });
      onProgress?.({ phase: 'unpacking' });
      unzip(zip, path.join(work, 'unpacked'));
      binaries = installBinaries(path.join(work, 'unpacked'), binDir);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }

  if (!fs.existsSync(modelFile) || force) {
    onProgress?.({ phase: 'model' });
    await download(`${MODEL_BASE_URL}/${modelName}`, modelFile, modelName, {
      onProgress: (p) => onProgress?.({ phase: 'model', ...p }),
      signal,
    });
  }

  fs.writeFileSync(
    path.join(root, 'INSTALL.json'),
    `${JSON.stringify({ release: RELEASE, variant, model: modelName, installedAt: new Date().toISOString() }, null, 2)}\n`,
  );

  onProgress?.({ phase: 'done' });
  return { root, model: modelName, binaries };
}
