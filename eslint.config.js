'use strict';

// Flat config. The source trees run in genuinely different environments, so
// each gets its own globals: the main process is Node, the renderer is a
// browser page with a contextBridge, and the worklet runs on the audio thread
// with neither window nor Node available. The TypeScript projects enforce the
// same split for types; this enforces it for the rules below.
//
// Left as JavaScript on purpose: it is the one file ESLint loads before any
// compiler has run.

const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const globals = require('globals');

/** Rules that apply everywhere, regardless of environment. */
const shared = {
  // The compiler already reports unused locals (noUnusedLocals); this adds
  // parameters, with the `_` escape hatch for ones a signature demands.
  'no-unused-vars': 'off',
  '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
  'no-var': 'error',
  'prefer-const': 'error',
  eqeqeq: ['error', 'smart'],
  'no-implicit-coercion': ['error', { allow: ['!!'] }],
  // Empty catch blocks are a deliberate idiom here ("logging must never take
  // the app down"), so allow them but nothing else.
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-console': 'off',
  // Everything that crosses a boundary is `unknown` and narrowed where it is
  // used; `any` is kept for the one test helper that pokes at parsed JSON.
  '@typescript-eslint/no-explicit-any': 'error',
  '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
};

module.exports = tseslint.config(
  {
    ignores: ['dist/**', 'out/**', 'node_modules/**', 'assets/**', 'vendor/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.ts'],
    rules: shared,
  },

  {
    // Main process, build scripts and tests: full Node.
    files: ['src/main/**/*.ts', 'scripts/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // The main process is the only place with filesystem and shell reach.
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'Go through the Ollama or whisper.cpp client so retries and timeouts apply.' },
      ],
    },
  },

  {
    // The two engine clients are the only places allowed to talk to the
    // network, and both only ever reach a daemon on this machine.
    // whisper-setup.ts is the sole exception that leaves it, and it fetches
    // whisper.cpp and nothing else — no meeting data is involved anywhere in
    // it. scripts/setup-whisper.ts is the terminal front end onto that.
    files: ['src/main/ollama.ts', 'src/main/whisper.ts', 'src/main/whisper-setup.ts', 'scripts/setup-whisper.ts'],
    rules: { 'no-restricted-globals': 'off' },
  },

  // The renderer blocks below match by naming convention rather than by
  // listing files. Naming them individually meant every new window silently
  // fell through to no environment at all, and a page that had simply not been
  // added to the list failed with a screenful of "'document' is not defined"
  // that says nothing about the actual mistake.

  {
    // Preloads: browser context, but with require() and the contextBridge.
    files: ['src/renderer/**/*preload.ts'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
    },
  },

  {
    // Renderer pages: browser only, no Node. Whatever the preload exposed
    // arrives on `window`, and is reached through it — there is no bare global
    // to declare here, which is what keeps this block free of a file list too.
    files: ['src/renderer/**/*.ts'],
    ignores: ['src/renderer/**/*preload.ts', 'src/renderer/**/*worklet.ts', 'src/renderer/**/*.d.ts'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'require', message: 'Renderers are context-isolated; go through the preload bridge.' },
      ],
    },
  },

  {
    // AudioWorklet global scope: no window, no Node, no fetch.
    files: ['src/renderer/**/*worklet.ts'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        AudioWorkletProcessor: 'readonly',
        registerProcessor: 'readonly',
        currentTime: 'readonly',
        sampleRate: 'readonly',
      },
    },
  },

  {
    // This file, and nothing else in JavaScript.
    files: ['eslint.config.js'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
