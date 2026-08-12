'use strict';

// Flat config. The three source trees run in genuinely different environments,
// so each gets its own globals: the main process is Node, the renderer is a
// browser page with a contextBridge, and the worklet runs on the audio thread
// with neither window nor Node available.

const js = require('@eslint/js');
const globals = require('globals');

/** Rules that apply everywhere, regardless of environment. */
const shared = {
  'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
  'no-var': 'error',
  'prefer-const': 'error',
  eqeqeq: ['error', 'smart'],
  'no-implicit-coercion': ['error', { allow: ['!!'] }],
  // Empty catch blocks are a deliberate idiom here ("logging must never take
  // the app down"), so allow them but nothing else.
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-console': 'off',
};

module.exports = [
  {
    ignores: ['dist/**', 'node_modules/**', 'assets/**'],
  },

  js.configs.recommended,

  {
    // Main process, build scripts and tests: full Node.
    files: ['src/main/**/*.js', 'scripts/**/*.js', 'test/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      ...shared,
      // The main process is the only place with filesystem and shell reach.
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'Go through the Ollama or whisper.cpp client so retries and timeouts apply.' },
      ],
    },
  },

  {
    // The two engine clients are the only places allowed to talk to the
    // network, and both only ever reach a daemon on this machine. The setup
    // script is the sole exception that leaves it: it runs from a terminal, not
    // from the app, and only to fetch whisper.cpp itself.
    files: ['src/main/ollama.js', 'src/main/whisper.js', 'scripts/setup-whisper.js'],
    rules: { 'no-restricted-globals': 'off' },
  },

  // The three renderer blocks below match by naming convention rather than by
  // listing files. Naming them individually meant every new window silently
  // fell through to no environment at all, and a page that had simply not been
  // added to the list failed with a screenful of "'document' is not defined"
  // that says nothing about the actual mistake.

  {
    // Preloads: browser context, but with require() and the contextBridge.
    files: ['src/renderer/**/*preload.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: { ...globals.browser, ...globals.node },
    },
    rules: shared,
  },

  {
    // Renderer pages: browser only, no Node. Whatever the preload exposed
    // arrives on `window`, and is reached through it — there is no bare global
    // to declare here, which is what keeps this block free of a file list too.
    files: ['src/renderer/**/*.js'],
    ignores: ['src/renderer/**/*preload.js', 'src/renderer/**/*worklet.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'script',
      globals: { ...globals.browser },
    },
    rules: {
      ...shared,
      'no-restricted-globals': [
        'error',
        { name: 'require', message: 'Renderers are context-isolated; go through the preload bridge.' },
      ],
    },
  },

  {
    // AudioWorklet global scope: no window, no Node, no fetch.
    files: ['src/renderer/**/*worklet.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'script',
      globals: {
        AudioWorkletProcessor: 'readonly',
        registerProcessor: 'readonly',
        currentTime: 'readonly',
        sampleRate: 'readonly',
      },
    },
    rules: shared,
  },
];
