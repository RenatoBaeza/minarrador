// The account button at the bottom of the sidebar.
//
// Signed out, it is the way in — one click opens Google in the browser — so
// syncing never depends on finding a row deep in Settings. Signed in, it is a
// glance: the initial of the account, a dot for how the last sync went, and a
// click through to the full row in Settings.

import type { SettingsState } from '../shared/types';
import { byId, navigate } from './library-common.js';

const button = byId<HTMLButtonElement>('account');
const mark = byId('account-mark');
const label = byId('account-label');

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Google's "G", drawn as Google draws it for sign-in buttons. */
function googleMark(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 48 48');
  const paths: [string, string][] = [
    ['#EA4335', 'M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z'],
    ['#4285F4', 'M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z'],
    ['#FBBC05', 'M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z'],
    ['#34A853', 'M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z'],
  ];
  for (const [fill, d] of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('fill', fill);
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

function dot(kind: '' | 'failed' | 'busy'): HTMLElement {
  const el = document.createElement('span');
  el.className = `dot${kind ? ` ${kind}` : ''}`;
  return el;
}

let onClick: () => void = () => {};
button.addEventListener('click', () => onClick());

export function renderAccount(s: SettingsState | null): void {
  const sync = s?.sync;
  button.hidden = !sync?.configured;
  if (!sync?.configured) return;

  button.classList.remove('signed-out', 'signed-in', 'waiting');
  button.disabled = false;

  if (sync.signingIn) {
    button.classList.add('waiting');
    mark.replaceChildren(googleMark());
    label.textContent = 'Waiting…';
    button.title = 'Finish signing in in your browser — or click to see the details in Settings.';
    onClick = () => void navigate('settings');
    return;
  }

  if (!sync.signedIn) {
    button.classList.add('signed-out');
    mark.replaceChildren(googleMark());
    label.textContent = 'Sign in';
    button.title =
      'Sign in with Google to sync settings, quick copy, to-dos and dictations between your computers. ' +
      'Audio, transcripts and notes stay here.';
    onClick = () => {
      button.disabled = true;
      label.textContent = 'Opening…';
      // The state that comes back (settings:changed) redraws this button.
      void window.library.sync.signIn().catch(() => undefined);
    };
    return;
  }

  button.classList.add('signed-in');
  const who = sync.name || sync.email;
  mark.replaceChildren(document.createTextNode((who.trim()[0] ?? '?').toUpperCase()), dot(sync.syncing ? 'busy' : sync.error ? 'failed' : ''));
  label.textContent = 'Synced';
  if (sync.syncing) label.textContent = 'Syncing…';
  else if (sync.error) label.textContent = 'Sync failed';
  button.title = `${sync.email}${sync.error ? `\nThe last sync failed: ${sync.error}` : ''}\nClick for account and sync settings.`;
  onClick = () => void navigate('settings');
}
