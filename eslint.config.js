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
      'no-restricted-globals': ['error', { name: 'fetch', message: 'Use the Ollama client so retries and timeouts apply.' }],
    },
  },

  {
    // The Ollama client is the one place allowed to talk to the network.
    files: ['src/main/ollama.js'],
    rules: { 'no-restricted-globals': 'off' },
  },

  {
    // Preloads: browser context, but with require() and the contextBridge.
    files: ['src/renderer/preload.js', 'src/renderer/transcript-preload.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: { ...globals.browser, ...globals.node },
    },
    rules: shared,
  },

  {
    // Renderer pages: browser only, no Node. contextIsolation means the bridge
    // objects arrive on window, so they are declared read-only globals.
    files: ['src/renderer/capture.js', 'src/renderer/transcript.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'script',
      globals: { ...globals.browser, capture: 'readonly', transcript: 'readonly' },
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
    files: ['src/renderer/pcm-worklet.js'],
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
