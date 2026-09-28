import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { LIBRARY_SETTINGS, PATH_SETTINGS, gateLibraryPatch, type Installed } from '../src/main/settings-gate';

// The library window is a renderer, and anything it sends is a claim. A patch
// that could set the notes folder, the Ollama host or the whisper root could
// point this app's reading and writing anywhere on the machine, so none of
// them ever gets through — at either gate.

const INSTALLED: Installed = {
  whisperModels: ['ggml-base.bin'],
  models: ['gemma4:12b'],
  devices: [{ id: 'headset-1', label: 'Headset' }],
};

test('no setting that names a place can be written from the window', () => {
  for (const key of PATH_SETTINGS) assert.equal(LIBRARY_SETTINGS.has(key), false, key);

  const clean = gateLibraryPatch(
    {
      notesDir: 'C:\\Windows\\System32',
      ollamaHost: 'http://attacker.example',
      whisperRoot: '\\\\server\\share',
      chunkSeconds: 1,
      liveTranscript: true,
    },
    INSTALLED,
  );
  assert.deepEqual(clean, { liveTranscript: true });
});

test('an inherited key is not a setting', () => {
  const patch = Object.create({ notesDir: 'C:\\' }) as Record<string, unknown>;
  patch.preventSleep = false;
  assert.deepEqual(gateLibraryPatch(patch, INSTALLED), { preventSleep: false });
});

test('model names must be installed, and a device must be one the worker reported', () => {
  assert.deepEqual(
    gateLibraryPatch(
      {
        whisperModel: '..\\..\\secrets.bin',
        transcribeModel: 'not-pulled',
        summaryModel: 'gemma4:12b',
        micDeviceId: 'made-up',
        micDeviceLabel: 'Spoofed',
      },
      INSTALLED,
    ),
    { summaryModel: 'gemma4:12b' },
  );
  assert.deepEqual(gateLibraryPatch({ micDeviceId: 'headset-1', micDeviceLabel: 'Headset' }, INSTALLED), {
    micDeviceId: 'headset-1',
    micDeviceLabel: 'Headset',
  });
  assert.deepEqual(
    gateLibraryPatch({ micDeviceId: '', micDeviceLabel: '' }, INSTALLED),
    { micDeviceId: '', micDeviceLabel: '' },
    'the empty id means "the Windows default" and is always allowed',
  );
});

test('a patch that is not an object changes nothing', () => {
  for (const patch of [null, undefined, 'notesDir', 42]) {
    assert.deepEqual(gateLibraryPatch(patch, INSTALLED), {});
  }
});

/**
 * The preload is the first gate, and it cannot be imported here — a sandboxed
 * preload requires Electron at load. Its FIELDS table is typed from the same
 * LibrarySettingKey as the gate, so a drift is a compile error; this reads the
 * source as well, so the check does not rest on the type alone.
 */
test('the preload offers exactly the keys main accepts, and no path', () => {
  // Compiled to out/test, two levels below the checkout.
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'library-preload.ts'), 'utf8');
  const body = /const FIELDS[^{]*\{([\s\S]*?)\n\};/.exec(src)?.[1] ?? '';
  const keys = [...body.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
  assert.ok(keys.length > 10, 'FIELDS was found in the preload');
  assert.deepEqual(new Set(keys), new Set(LIBRARY_SETTINGS));
  for (const key of PATH_SETTINGS) assert.equal(keys.includes(key), false, key);
});
