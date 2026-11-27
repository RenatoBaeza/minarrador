'use strict';

// Flat config for the one TypeScript tree left: the window pages under
// src/renderer, which run in WebView2 with no Node. Everything else is Rust and
// is linted by clippy (`npm run lint` runs both).
//
// CommonJS (.cjs) on purpose: it is the one file ESLint loads before any
// compiler has run, and package.json declares ES modules.

const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const globals = require('globals');

module.exports = tseslint.config(
  { ignores: ['dist/**', 'out/**', 'node_modules/**', 'assets/**', 'vendor/**', 'src-tauri/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.ts'],
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'smart'],
      'no-implicit-coercion': ['error', { allow: ['!!'] }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
    },
  },

  {
    // Pages: browser only. The Rust core is reached through the bridge each
    // page's window installs, never through window.__TAURI__ directly — only
    // the bridge modules may touch it.
    files: ['src/renderer/**/*.ts'],
    ignores: ['src/renderer/**/*.d.ts'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.browser } },
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'window', property: '__TAURI__', message: 'Go through the window bridge (bridge-common.ts).' },
      ],
    },
  },

  {
    files: ['src/renderer/bridge-common.ts', 'src/renderer/*-bridge.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },

  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node } },
  },

  {
    files: ['eslint.config.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
