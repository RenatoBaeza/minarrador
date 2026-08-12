# AGENTS.md

Electron tray-only meeting-notes app. All logic is plain CommonJS in `src/main/`;
no bundler, no TypeScript, no runtime npm dependencies (only Electron plus two
localhost HTTP APIs: Ollama and whisper.cpp).

## Reference

`CLAUDE.md` at the repo root is the deep architecture doc (capture graph,
pipeline, library, settings model, full IPC channel table). This file only adds
what that one leaves out.

## Commands

- `npm run check` — lint + test. Run this before finishing. There is **no typecheck** (`jsconfig.json` is editor-only).
- `npm test` — Node's built-in test runner (`node --test "test/**/*.test.js"`), no framework. Tests are pure Node: they never launch Electron and stub Ollama/whisper with fakes defined inside the test files.
- `npm run lint` — ESLint flat config (`eslint.config.js`).
- `npm start` — launch the app (Windows only; needs a real display + mic).
- `npm run pipeline -- "<meeting folder>"` and `npm run capture-test` run **under Electron** (`electron scripts/...`), unlike tests — they need the Electron binary. `pipeline` re-runs transcribe→summarise→PDF on a real meeting folder and needs Ollama/whisper working.
- `npm run whisper:setup` — download whisper.cpp + a GGML model into `vendor/whisper` (gitignored, fetched from GitHub/Hugging Face; the app's only outbound network path).

## ESLint environments are chosen by filename, not by a list

The flat config maps renderer files to environments via naming convention:

- `src/renderer/**/*preload.js` → preload (browser + Node)
- `src/renderer/**/*worklet.js` → audio-thread globals only (no `window`, no Node)
- every other `src/renderer/**/*.js` → browser only; `require` is a lint error. A page reaches its bridge as `window.<name>`, never a bare global.
- `src/main/**` → Node, but bare `fetch` is a lint error (`no-restricted-globals`) except in `ollama.js`, `whisper.js`, `whisper-setup.js`, `scripts/setup-whisper.js`. New network code must go through one of those clients so retries/timeouts apply.

## Conventions

- `'use strict'` and CommonJS (`require`/`module.exports`) in every file. No ESM.
- No external runtime dependencies — never `npm install` a runtime package; `package.json` devDependencies are only electron, electron-builder, eslint.
- The settings store (`settings.json`) coerces every value against a scalar default and drops the rest. Lists of records (quick-copy snippets, dictations) therefore live in their own JSON files (`snippets.json`, `dictations.json`).
- Global shortcut values come only from the enum lists in `settings.js` (`HOTKEY_CHOICES`, `DICTATE_HOTKEY_CHOICES`) — never free text. `globalShortcut.register` returning `false` means another app already holds the combo.
- Renderers are sandboxed and context-isolated; only `src/main/` touches fs/shell.

## Gotchas

- `vendor/` is gitignored — whisper.cpp binaries/weights are a download, not part of the repo. `npm run dist` packages it via `extraResources`; a fresh checkout without `whisper:setup` builds an installer without whisper (which still works, falling back to Ollama).
- `package.json` requires Node `>=20.11`; README/CLAUDE.md say v18 — trust the manifest.
- CI runs lint + test on windows/ubuntu × node 20/22 (`ELECTRON_SKIP_BINARY_DOWNLOAD=1`), then `npm run dist` on Windows for the installer artifact.
- The dictation feature (`src/main/dictation.js`, renderer `dictate-*`) is a second capture worker deliberately separate from the meeting one in `capture.js`, so dictation can run mid-recording. It has its own archive (`src/main/dictations.js` → `dictations.json`) and window — nothing is shared with the meeting pipeline.
