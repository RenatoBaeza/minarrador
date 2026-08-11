'use strict';

// View layer for the live transcript window. Everything it can do is bounded by
// the `transcript` bridge in transcript-preload.js; it has no Node access.

const content = document.getElementById('content');
const hint = document.getElementById('hint');
// Not `status`: that name is a built-in window property and assigning to it
// would silently write to the browser status bar instead of this element.
const statusEl = document.getElementById('status');
const langSelect = document.getElementById('langSelect');

const LANGUAGE_LABELS = { '': 'Auto-detect' };

for (const lang of window.transcript.languages) {
  const option = document.createElement('option');
  option.value = lang;
  option.textContent = LANGUAGE_LABELS[lang] ?? lang;
  langSelect.append(option);
}

langSelect.addEventListener('change', (e) => window.transcript.setLanguage(e.target.value));

/** True while the view is pinned to the newest line. */
function atBottom() {
  return content.scrollHeight - content.scrollTop - content.clientHeight < 40;
}

window.transcript.onClear(() => {
  content.replaceChildren(hint);
});

window.transcript.onLine((text) => {
  if (!text.trim()) return;
  const stick = atBottom();
  hint.remove();
  const p = document.createElement('p');
  // textContent, never innerHTML: this string came out of a language model.
  p.textContent = text;
  content.append(p);
  if (stick) content.scrollTop = content.scrollHeight;
});

window.transcript.onState(({ recording, label, engine }) => {
  const text = label ?? (recording ? 'Recording' : 'Idle');
  statusEl.textContent = engine ? `${text} · ${engine}` : text;
  statusEl.classList.toggle('recording', Boolean(recording));
});
