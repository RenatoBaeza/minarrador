'use strict';

// View layer for the dictation indicator. It renders whatever the main process
// sends over dictate:state and nothing else — no buttons, no input, because the
// window is focusable:false and must never steal the cursor.

const body = document.body;
const label = document.getElementById('label');
const caption = document.getElementById('caption');

const TITLES = {
  listening: 'Listening',
  transcribing: 'Transcribing…',
  done: 'Pasted',
  error: 'Could not transcribe',
};

/** A momentary flash of the live caption, so "is it hearing me" has an answer. */
let flashTimer = null;

window.dictateIndicator.onState(({ state, text, error }) => {
  body.classList.toggle('transcribing', state === 'transcribing');
  body.classList.toggle('done', state === 'done');
  body.classList.toggle('error', state === 'error');
  body.classList.toggle('listening', state === 'listening');

  label.textContent = TITLES[state] ?? 'Listening';

  const shown = error || text || '';
  caption.hidden = !shown;
  caption.textContent = shown;
  caption.classList.toggle('error', Boolean(error));

  // A live caption is a glimpse, not a transcript; clear it so the pill does not
  // sit there looking like the final text.
  clearTimeout(flashTimer);
  if (state === 'listening' && shown && !error) {
    flashTimer = setTimeout(() => {
      caption.hidden = true;
      caption.textContent = '';
    }, 3000);
  }
});
