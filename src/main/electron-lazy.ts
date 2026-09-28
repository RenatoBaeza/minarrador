// Several stores and helpers need exactly one thing from Electron — where
// `userData` or `documents` lives — and are also loaded by the test suite and
// the command-line scripts, where `require('electron')` is only the path to the
// binary. Reaching for Electron at the moment of use, rather than importing it,
// is what keeps those modules loadable outside the app.

import type * as ElectronModule from 'electron';

type Electron = typeof ElectronModule;
type PathName = Parameters<Electron['app']['getPath']>[0];

/** `app.getPath(name)`, resolved when called rather than when imported. */
// eslint-disable-next-line @typescript-eslint/no-require-imports
export const electronPath = (name: PathName): string => (require('electron') as Electron).app.getPath(name);
