'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { listMeetings, readMeeting, meetingDir, openTarget } = require('../src/main/library');
const { FILES, SPEAKERS, speakerLine } = require('../src/main/paths');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minarrador-library-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Writes a meeting folder. Only the artefacts named actually appear, so a test
 * can build the half-finished folders the library has to explain.
 */
function meeting(
  root,
  id,
  { notes, meta, transcript, liveTranscript, transcriptJson, title, audio = true, extra = {} } = {},
) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  if (audio) fs.writeFileSync(path.join(dir, FILES.audio), 'RIFF');
  if (notes) fs.writeFileSync(path.join(dir, FILES.notesJson), JSON.stringify(notes));
  if (meta) fs.writeFileSync(path.join(dir, FILES.meta), JSON.stringify(meta));
  if (transcript !== undefined) fs.writeFileSync(path.join(dir, FILES.transcript), transcript);
  if (liveTranscript !== undefined) fs.writeFileSync(path.join(dir, FILES.liveTranscript), liveTranscript);
  if (transcriptJson) fs.writeFileSync(path.join(dir, FILES.transcriptJson), JSON.stringify(transcriptJson));
  if (title !== undefined) fs.writeFileSync(path.join(dir, FILES.title), title);
  for (const [name, body] of Object.entries(extra)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}

/** A transcript line as the reader receives it. */
const line = (text, { at = null, speaker = '' } = {}) => ({ startSeconds: at, speaker, text });

const NOTES = {
  title: 'Pricing review',
  summary: ['We settled on the new tiers.', 'Launch is the week after next.'],
  decisions: [{ decision: 'Ship three tiers', context: 'Two was too blunt' }],
  action_items: [{ task: 'Draft the pricing page', owner: 'Ana', due: 'Friday' }],
};

test('listMeetings returns the newest meeting first', (t) => {
  const root = tmpDir(t);
  meeting(root, '2026-08-09_09-00-00', { notes: { ...NOTES, title: 'Oldest' } });
  meeting(root, '2026-08-11_14-32-05', { notes: { ...NOTES, title: 'Newest' } });
  meeting(root, '2026-08-10_11-00-00', { notes: { ...NOTES, title: 'Middle' } });

  assert.deepEqual(listMeetings(root).map((m) => m.title), ['Newest', 'Middle', 'Oldest']);
});

test('listMeetings dates a meeting from meta, falling back to the folder name', (t) => {
  const root = tmpDir(t);
  meeting(root, '2026-08-11_14-32-05', { notes: NOTES });
  meeting(root, '2026-08-10_11-00-00', {
    notes: NOTES,
    // A folder re-run elsewhere can carry a start time its name does not match.
    meta: { startedAt: '2026-08-12T08:00:00.000Z', durationSeconds: 1800 },
  });

  const [first, second] = listMeetings(root);
  assert.equal(first.startedAt, '2026-08-12T08:00:00.000Z', 'meta wins when it is there');
  assert.equal(first.durationSeconds, 1800);
  assert.equal(new Date(second.startedAt).getFullYear(), 2026);
  assert.equal(new Date(second.startedAt).getHours(), 14, 'folder name is read as local time');
});

test('listMeetings ignores folders that are not meetings', (t) => {
  const root = tmpDir(t);
  meeting(root, '2026-08-11_14-32-05', { notes: NOTES });
  fs.mkdirSync(path.join(root, 'Screenshots'));
  fs.writeFileSync(path.join(root, 'notes-to-self.txt'), 'not a meeting');

  assert.deepEqual(listMeetings(root).map((m) => m.id), ['2026-08-11_14-32-05']);
});

test('listMeetings is empty rather than throwing when the notes folder is gone', () => {
  assert.deepEqual(listMeetings(path.join(os.tmpdir(), 'minarrador-does-not-exist')), []);
});

test('listMeetings says why a folder has no notes in it', (t) => {
  const root = tmpDir(t);
  meeting(root, '2026-08-11_10-00-00', { notes: NOTES });
  meeting(root, '2026-08-11_11-00-00', { extra: { 'ERROR.txt': 'Ollama was down' } });
  meeting(root, '2026-08-11_12-00-00', { extra: { 'UNPROCESSED.txt': 'quit mid-recording' } });
  meeting(root, '2026-08-11_13-00-00', {});

  const status = Object.fromEntries(listMeetings(root).map((m) => [m.id.slice(11, 13), m.status]));
  assert.deepEqual(status, { 10: 'ready', 11: 'failed', 12: 'unprocessed', 13: 'pending' });
});

test('listMeetings previews the summary, or the transcript when there is none', (t) => {
  const root = tmpDir(t);
  meeting(root, '2026-08-11_10-00-00', { notes: NOTES, transcript: 'Something else entirely.' });
  meeting(root, '2026-08-11_11-00-00', { transcript: '  So where did we land on pricing?\n\nWe did not.  ' });

  const [untranscribed, summarised] = listMeetings(root);
  assert.equal(summarised.preview, 'We settled on the new tiers.');
  assert.equal(untranscribed.preview, 'So where did we land on pricing? We did not.');
  assert.equal(untranscribed.title, 'Untitled recording');
});

test('a query keeps only the meetings that said it, and counts the hits', (t) => {
  const root = tmpDir(t);
  meeting(root, '2026-08-11_10-00-00', {
    notes: NOTES,
    transcript: 'The pricing page needs work. Pricing again. And once more: PRICING.',
  });
  meeting(root, '2026-08-11_11-00-00', { notes: { ...NOTES, title: 'Hiring sync' }, transcript: 'Two more engineers.' });

  const hits = listMeetings(root, { query: 'pricing' });
  assert.equal(hits.length, 1);
  // Three in the transcript and one in the title; the summary preview it was
  // listed with says nothing about pricing.
  assert.equal(hits[0].matches, 4);
  assert.match(hits[0].preview, /pricing page needs work/i);
});

test('a query matches a title even when the meeting has no transcript', (t) => {
  const root = tmpDir(t);
  meeting(root, '2026-08-11_10-00-00', { notes: { ...NOTES, title: 'Board offsite' } });

  assert.equal(listMeetings(root, { query: 'offsite' }).length, 1);
  assert.equal(listMeetings(root, { query: 'offsite' })[0].matches, 1);
  assert.deepEqual(listMeetings(root, { query: 'nothing said this' }), []);
});

test('readMeeting timestamps transcript lines from the chunks they came from', (t) => {
  const root = tmpDir(t);
  meeting(root, '2026-08-11_10-00-00', {
    notes: NOTES,
    transcript: 'First minute.\n\nSecond minute.',
    transcriptJson: {
      segments: [
        { index: 0, startSeconds: 0, endSeconds: 60, text: 'First minute.' },
        { index: 1, startSeconds: 60, endSeconds: 95, text: '  ' },
        { index: 2, startSeconds: 95, endSeconds: 150, text: 'Second minute.' },
      ],
    },
  });

  const detail = readMeeting(root, '2026-08-11_10-00-00');
  assert.deepEqual(detail.transcript, [line('First minute.', { at: 0 }), line('Second minute.', { at: 95 })]);
});

test('readMeeting falls back to paragraphs when there is no segment file', (t) => {
  const root = tmpDir(t);
  meeting(root, '2026-08-11_10-00-00', { notes: NOTES, transcript: 'One.\n\n\nTwo.\n' });

  const detail = readMeeting(root, '2026-08-11_10-00-00');
  assert.deepEqual(detail.transcript, [line('One.'), line('Two.')]);
});

// The live preview is the only text a meeting whose pipeline never ran has, so
// everything that reads a transcript has to find it — otherwise keeping it on
// disk would change nothing the user can see.

test('readMeeting falls back to the live transcript, one caption per line', (t) => {
  const root = tmpDir(t);
  meeting(root, '2026-08-11_10-00-00', {
    liveTranscript: 'So where did we land on pricing?\nWe did not.\n\n',
    extra: { 'UNPROCESSED.txt': 'quit mid-recording' },
  });

  const detail = readMeeting(root, '2026-08-11_10-00-00');
  assert.equal(detail.transcriptSource, 'live');
  assert.deepEqual(detail.transcript, [line('So where did we land on pricing?'), line('We did not.')]);
});

test('the pipeline transcript wins over the live one wherever both exist', (t) => {
  const root = tmpDir(t);
  meeting(root, '2026-08-11_10-00-00', {
    notes: NOTES,
    transcript: 'The careful pass.',
    liveTranscript: 'The rough one.',
  });

  const detail = readMeeting(root, '2026-08-11_10-00-00');
  assert.equal(detail.transcriptSource, 'pipeline');
  assert.deepEqual(detail.transcript, [line('The careful pass.')]);
  assert.equal(
    openTarget(root, '2026-08-11_10-00-00', 'transcript'),
    path.join(root, '2026-08-11_10-00-00', FILES.transcript),
  );
});

// ------------------------------------------------------------------- speakers
//
// A two-channel recording is transcribed one side at a time, so every line
// already knows who said it. The reader has to receive that as a field rather
// than as part of the sentence, and search has to not treat the labels as
// something anybody said.

test('readMeeting carries the speaker for each line of a two-channel meeting', (t) => {
  const root = tmpDir(t);
  meeting(root, '2026-08-11_10-00-00', {
    notes: NOTES,
    transcript: `${speakerLine('mic', 'So where did we land on pricing?')}\n\n${speakerLine('system', 'We did not.')}`,
    transcriptJson: {
      channels: 2,
      speakers: SPEAKERS,
      segments: [
        { index: 0, chunk: 0, speaker: 'mic', startSeconds: 0, endSeconds: 60, text: 'So where did we land on pricing?' },
        { index: 1, chunk: 0, speaker: 'system', startSeconds: 0, endSeconds: 60, text: 'We did not.' },
      ],
    },
  });

  const detail = readMeeting(root, '2026-08-11_10-00-00');
  assert.deepEqual(detail.transcript, [
    line('So where did we land on pricing?', { at: 0, speaker: 'mic' }),
    line('We did not.', { at: 0, speaker: 'system' }),
  ]);
  assert.deepEqual(detail.speakers, SPEAKERS, 'the reader is given the names, not the channel scheme');
});

test('readMeeting reads the speaker back off a live transcript, which is only text', (t) => {
  const root = tmpDir(t);
  meeting(root, '2026-08-11_10-00-00', {
    liveTranscript: `${speakerLine('mic', 'I will draft it.')}\n${speakerLine('system', 'Thanks.')}\nUnattributed.\n`,
  });

  assert.deepEqual(readMeeting(root, '2026-08-11_10-00-00').transcript, [
    line('I will draft it.', { speaker: 'mic' }),
    line('Thanks.', { speaker: 'system' }),
    line('Unattributed.'),
  ]);
});

test('readMeeting ignores a speaker that is not one of the two channels', (t) => {
  const root = tmpDir(t);
  meeting(root, '2026-08-11_10-00-00', {
    transcript: 'said things',
    transcriptJson: { segments: [{ index: 0, speaker: 'somebody-else', startSeconds: 0, text: 'said things' }] },
  });
  assert.deepEqual(readMeeting(root, '2026-08-11_10-00-00').transcript, [line('said things', { at: 0 })]);
});

test('a search does not count the speaker labels as words anybody said', (t) => {
  const root = tmpDir(t);
  // Notes, so the preview quotes the summary rather than the transcript — this
  // is about what the transcript contributes, and nothing else.
  meeting(root, '2026-08-11_10-00-00', {
    notes: NOTES,
    transcript: [
      speakerLine('mic', 'Did you see the pricing page?'),
      speakerLine('system', 'Not yet.'),
      speakerLine('mic', 'Have a look.'),
    ].join('\n\n'),
  });

  // "You:" prefixes two of the three lines. Only the one somebody actually said
  // counts; otherwise every labelled line in every meeting is a hit for "you".
  const hits = listMeetings(root, { query: 'you' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].matches, 1);
  assert.match(hits[0].preview, /Did you see/, 'the quote is the sentence, not the label on it');
});

test('a card previews what was said, not how the file marks up who said it', (t) => {
  const root = tmpDir(t);
  meeting(root, '2026-08-11_10-00-00', {
    transcript: `${speakerLine('mic', 'Did you see the pricing page?')}\n\n${speakerLine('system', 'Not yet.')}`,
  });

  assert.equal(listMeetings(root)[0].preview, 'Did you see the pricing page? Not yet.');
});

// ------------------------------------------------------------------- renaming
//
// Every meeting is otherwise called whatever the summariser made of it, for
// ever. The override is its own file precisely so a re-run cannot revert it.

test('a typed title wins over the one the model wrote', (t) => {
  const root = tmpDir(t);
  meeting(root, '2026-08-11_10-00-00', { notes: NOTES, title: 'Q3 pricing, final\n' });

  const [card] = listMeetings(root);
  assert.equal(card.title, 'Q3 pricing, final');
  assert.equal(card.generatedTitle, 'Pricing review', 'the model’s title is kept so a rename can be undone');
  assert.equal(card.renamed, true);
  assert.equal(readMeeting(root, '2026-08-11_10-00-00').title, 'Q3 pricing, final');
});

test('a meeting with no notes can still carry a title', (t) => {
  const root = tmpDir(t);
  meeting(root, '2026-08-11_10-00-00', { title: 'Call with the bank' });

  const [card] = listMeetings(root);
  assert.equal(card.title, 'Call with the bank');
  assert.equal(card.generatedTitle, '');
  assert.equal(card.status, 'pending', 'a title says nothing about whether the notes ran');
});

test('an emptied title file falls back to the model’s, not to a blank', (t) => {
  const root = tmpDir(t);
  meeting(root, '2026-08-11_10-00-00', { notes: NOTES, title: '  \n' });

  const [card] = listMeetings(root);
  assert.equal(card.title, 'Pricing review');
  assert.equal(card.renamed, false);
});

test('a typed title is searchable like any other', (t) => {
  const root = tmpDir(t);
  meeting(root, '2026-08-11_10-00-00', { notes: NOTES, title: 'Board offsite' });
  assert.deepEqual(listMeetings(root, { query: 'offsite' }).map((m) => m.id), ['2026-08-11_10-00-00']);
});

test('a live transcript is searched and previewed like any other', (t) => {
  const root = tmpDir(t);
  meeting(root, '2026-08-11_10-00-00', { liveTranscript: 'We should revisit pricing next week.' });

  const [card] = listMeetings(root);
  assert.equal(card.preview, 'We should revisit pricing next week.');
  assert.equal(card.files.transcript, true);
  assert.equal(card.transcriptSource, 'live');

  const hits = listMeetings(root, { query: 'pricing' });
  assert.deepEqual(hits.map((m) => m.id), ['2026-08-11_10-00-00']);
  assert.equal(
    openTarget(root, '2026-08-11_10-00-00', 'transcript'),
    path.join(root, '2026-08-11_10-00-00', FILES.liveTranscript),
  );
});

test('readMeeting quotes the sentence in ERROR.txt, not the stack under it', (t) => {
  const root = tmpDir(t);
  meeting(root, '2026-08-11_10-00-00', {
    extra: {
      'ERROR.txt':
        'Processing failed at 2026-08-11T11:00:00.000Z\n\n' +
        'Error: Ollama is not reachable at http://127.0.0.1:11434\n' +
        '    at runPipeline (/app/src/main/pipeline.js:1:1)\n',
    },
  });

  const detail = readMeeting(root, '2026-08-11_10-00-00');
  assert.equal(detail.status, 'failed');
  assert.equal(detail.error, 'Ollama is not reachable at http://127.0.0.1:11434');
});

test('readMeeting carries no error line for a meeting that did not fail', (t) => {
  const root = tmpDir(t);
  meeting(root, '2026-08-11_10-00-00', { notes: NOTES });
  assert.equal(readMeeting(root, '2026-08-11_10-00-00').error, '');
});

test('readMeeting hands the reader the structured notes', (t) => {
  const root = tmpDir(t);
  meeting(root, '2026-08-11_10-00-00', {
    notes: NOTES,
    meta: { startedAt: '2026-08-11T10:00:00.000Z', durationSeconds: 900, sources: { mic: true, system: false } },
  });

  const detail = readMeeting(root, '2026-08-11_10-00-00');
  assert.equal(detail.title, 'Pricing review');
  assert.deepEqual(detail.summary, NOTES.summary);
  assert.deepEqual(detail.decisions, [{ decision: 'Ship three tiers', context: 'Two was too blunt' }]);
  assert.deepEqual(detail.actionItems, [{ task: 'Draft the pricing page', owner: 'Ana', due: 'Friday' }]);
  assert.deepEqual(detail.sources, { mic: true, system: false });
});

test('readMeeting survives a notes file that has been hand-edited into nonsense', (t) => {
  const root = tmpDir(t);
  const dir = meeting(root, '2026-08-11_10-00-00', {});
  fs.writeFileSync(path.join(dir, FILES.notesJson), '{ "title": ');

  const detail = readMeeting(root, '2026-08-11_10-00-00');
  assert.equal(detail.title, 'Untitled recording');
  assert.deepEqual(detail.summary, []);
  assert.deepEqual(detail.actionItems, []);
});

test('readMeeting keeps only the fields the reader renders', (t) => {
  const root = tmpDir(t);
  meeting(root, '2026-08-11_10-00-00', {
    notes: {
      title: 'Odd shapes',
      summary: ['fine', 42, null],
      decisions: [{ decision: '', context: 'orphaned' }, { decision: 'kept' }],
      action_items: [{ owner: 'nobody' }, { task: 'kept', owner: 'Ana' }],
    },
  });

  const detail = readMeeting(root, '2026-08-11_10-00-00');
  assert.deepEqual(detail.summary, ['fine']);
  assert.deepEqual(detail.decisions, [{ decision: 'kept', context: '' }]);
  assert.deepEqual(detail.actionItems, [{ task: 'kept', owner: 'Ana', due: '' }]);
});

test('readMeeting refuses an id that is not a meeting', (t) => {
  const root = tmpDir(t);
  meeting(root, '2026-08-11_10-00-00', { notes: NOTES });
  fs.mkdirSync(path.join(root, 'Screenshots'));

  assert.equal(readMeeting(root, 'Screenshots'), null, 'a folder with no artefacts is not a meeting');
  assert.equal(readMeeting(root, 'never-existed'), null);
  assert.equal(readMeeting(root, ''), null);
});

// The id crosses an IPC boundary from a renderer, so this is the check that
// keeps a window that only ever lists folders from being able to name files
// anywhere else on the disk.
test('meetingDir accepts only a direct child of the notes folder', (t) => {
  const root = tmpDir(t);
  meeting(root, '2026-08-11_10-00-00', { notes: NOTES });
  fs.mkdirSync(path.join(root, 'nested', 'deeper'), { recursive: true });

  assert.equal(meetingDir(root, '2026-08-11_10-00-00'), path.join(root, '2026-08-11_10-00-00'));
  for (const id of [
    '..',
    '../..',
    path.join('..', path.basename(root)),
    'nested/deeper',
    'nested\\deeper',
    path.join(root, '2026-08-11_10-00-00'),
    'C:\\Windows',
    '/etc',
    '',
    '   ',
    null,
    undefined,
    42,
    ['2026-08-11_10-00-00'],
  ]) {
    assert.equal(meetingDir(root, id), null, `should refuse ${JSON.stringify(id)}`);
  }
});

test('meetingDir refuses a file, however real the path is', (t) => {
  const root = tmpDir(t);
  fs.writeFileSync(path.join(root, 'settings.json'), '{}');
  assert.equal(meetingDir(root, 'settings.json'), null);
});

test('openTarget resolves only the named artefacts, and only ones that exist', (t) => {
  const root = tmpDir(t);
  const dir = meeting(root, '2026-08-11_10-00-00', { notes: NOTES, transcript: 'said things' });
  const id = '2026-08-11_10-00-00';

  assert.equal(openTarget(root, id, 'folder'), dir);
  assert.equal(openTarget(root, id, 'audio'), path.join(dir, FILES.audio));
  assert.equal(openTarget(root, id, 'transcript'), path.join(dir, FILES.transcript));
  assert.equal(openTarget(root, id, 'pdf'), null, 'this meeting has no PDF');
  assert.equal(openTarget(root, id, 'audio.wav'), null, 'targets are names, not files');
  assert.equal(openTarget(root, id, '../../settings.json'), null);
  assert.equal(openTarget(root, id, 'constructor'), null, 'no inherited property is a target');
  assert.equal(openTarget(root, '..', 'folder'), null);
});
