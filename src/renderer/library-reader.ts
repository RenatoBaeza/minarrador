// The Recording feature: the rail of meetings, the reader beside it, the
// record button, and everything that loads a meeting into them.

import type { Health, ActionItem, JobProgress, LibraryActivity, MeetingCard, MeetingDetail, SettingsState } from '../shared/types';
import { type View, countEl, dateGroup, el, fmtClock, fmtDuration, fmtTime, highlighted, icon, listEl, placeholder, readerEl, recordEl, recordGlyphEl, recordLabelEl, searchingEl, view, navigate , healthEl } from './library-common.js';

/**
 * How long the record button waits for the folder list to confirm a click.
 *
 * Stopping runs a whole pipeline, but the confirmation comes from the audio file
 * closing, which is quick. This is only the backstop for the cases that produce
 * no change at all — a recording too short to keep, a start that failed.
 */
export const RECORD_CONFIRM_MS = 10_000;

export let recordTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * Sequence number for list requests.
 *
 * A search reads every transcript on disk, so a query over a big folder can
 * take longer than the one typed after it. Without this the slower, older
 * result lands last and the rail ends up showing matches for a query that is no
 * longer in the box.
 */
export let listSeq = 0;

// ------------------------------------------------------------------ progress

/** Where the pipeline has got to on one meeting, or null if it is not running. */
export const progressFor = (id: string): (JobProgress & { id: string }) | null => (view.activity.processing ?? []).find((p) => p.id === id) ?? null;

/**
 * A pipeline stage, short enough to sit in a card's pill.
 *
 * The tray has said "Transcribing 12/60…" since the pipeline existed while this
 * card said "Working…", and an hour of audio is a long time to be told only
 * that something is happening.
 */
export function progressTag(p: JobProgress | null): string {
  if (!p) return 'Working…';
  if (p.phase === 'transcribing' && p.total) return `Transcribing ${p.done}/${p.total}`;
  if (p.phase === 'summarising') return p.total ? `Condensing ${p.done}/${p.total}` : 'Writing notes';
  if (p.phase === 'designing') return 'Designing';
  if (p.phase === 'rendering') return 'Exporting PDF';
  return 'Working…';
}

/** The same thing in a sentence, for the reader where there is room for one. */
export function progressSentence(p: JobProgress | null): string {
  if (!p) return 'Starting…';
  if (p.phase === 'transcribing' && p.total) {
    return `Transcribing the audio — chunk ${Math.min(p.done + 1, p.total)} of ${p.total}.`;
  }
  if (p.phase === 'summarising') {
    return p.total ? `Condensing the transcript — part ${p.done + 1} of ${p.total}.` : 'Writing the notes.';
  }
  if (p.phase === 'designing') return 'Designing the printed brief.';
  if (p.phase === 'rendering') return 'Exporting the PDF.';
  return p.label || 'Starting…';
}

/** 0..1 through the run, or null when the stage has nothing to count. */
export const progressFraction = (p: JobProgress | null): number | null => (p && p.total ? Math.min(1, p.done / p.total) : null);

// ------------------------------------------------------------------- the rail

/** What a folder without notes should say for itself, if anything. */
export function cardTag(meeting: MeetingCard): { text: string; className: string } | null {
  if (meeting.id === view.activity.recordingId) return { text: 'Recording', className: 'recording' };
  if (view.activity.processingIds.includes(meeting.id)) {
    return { text: progressTag(progressFor(meeting.id)), className: 'working' };
  }
  if (meeting.status === 'failed') return { text: 'Failed', className: 'failed' };
  if (meeting.status === 'unprocessed') return { text: 'No notes', className: '' };
  if (meeting.status === 'pending') return { text: 'Audio only', className: '' };
  return null;
}

export function card(meeting: MeetingCard): HTMLButtonElement {
  const started = new Date(meeting.startedAt);
  const row = el('button', 'card');
  row.type = 'button';
  row.dataset.id = meeting.id;
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', String(meeting.id === view.selected));
  if (meeting.id === view.selected) row.classList.add('selected');

  const title = el('div', 'card-title');
  title.append(highlighted(meeting.title, view.query));
  row.append(title);

  const meta = el('div', 'card-meta');
  meta.append(el('span', '', fmtTime(started)));
  if (meeting.durationSeconds) {
    meta.append(el('span', 'dot', '·'), el('span', '', fmtDuration(meeting.durationSeconds)));
  }
  const tag = cardTag(meeting);
  if (tag) meta.append(el('span', `tag ${tag.className}`, tag.text));
  if (meeting.matches) meta.append(el('span', 'tag hits', `${meeting.matches} hit${meeting.matches === 1 ? '' : 's'}`));
  row.append(meta);

  if (meeting.preview) {
    const preview = el('div', 'card-preview');
    preview.append(highlighted(meeting.preview, view.query));
    row.append(preview);
  }

  row.addEventListener('click', () => openMeeting(meeting.id));
  return row;
}

export function renderList(): void {
  const { meetings, query } = view;
  countEl.textContent = query
    ? `${meetings.length} match${meetings.length === 1 ? '' : 'es'}`
    : `${meetings.length} meeting${meetings.length === 1 ? '' : 's'}`;

  if (!meetings.length) {
    listEl.replaceChildren(
      el(
        'p',
        'rail-empty',
        query
          ? 'Nothing said in any meeting matches that.'
          : 'No recordings yet. Start one from the tray and it will appear here when the notes are ready.',
      ),
    );
    return;
  }

  const nodes: HTMLElement[] = [];
  let group = '';
  for (const meeting of meetings) {
    const next = dateGroup(new Date(meeting.startedAt));
    if (next !== group) {
      group = next;
      nodes.push(el('div', 'group', group));
    }
    nodes.push(card(meeting));
  }
  listEl.replaceChildren(...nodes);
}

// ----------------------------------------------------------------- the reader

export function metaRow(meeting: MeetingDetail): HTMLElement {
  const started = new Date(meeting.startedAt);
  const bits = [started.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })];
  bits.push(fmtTime(started));
  if (meeting.durationSeconds) bits.push(fmtDuration(meeting.durationSeconds));

  const sources = [meeting.sources.mic && 'mic', meeting.sources.system && 'system audio'].filter(Boolean);
  if (sources.length) bits.push(sources.join(' + '));

  const row = el('div', 'doc-meta');
  bits.forEach((bit, i) => {
    if (i) row.append(el('span', 'dot', '·'));
    row.append(el('span', '', bit));
  });
  return row;
}

// -------------------------------------------------------------- what is copied

/**
 * The transcript as text, with the speaker kept on each line where there is one.
 *
 * Pasting a transcript into anything else is the point of the button, and a
 * two-channel meeting pasted without its labels loses the one thing that
 * separates a transcript from a wall of sentences. `withTimes` prepends each
 * line's `[mm:ss]` — the version for quoting "the bit about pricing" rather
 * than reproducing the meeting.
 */
export const transcriptText = (meeting: MeetingDetail, withTimes = false): string =>
  meeting.transcript
    .map((line) => {
      const who = line.speaker ? `${window.library.speakers[line.speaker]}: ` : '';
      const at = withTimes && line.startSeconds !== null ? `[${fmtClock(line.startSeconds)}] ` : '';
      return `${at}${who}${line.text}`;
    })
    .join('\n\n');

/** Just the checkboxes — the thing people actually paste into Slack or Jira. */
export const actionItemsMarkdown = (meeting: { actionItems: ActionItem[] }): string =>
  meeting.actionItems
    .map((a) => `- [ ] ${a.task}${a.owner ? ` — **${a.owner}**` : ''}${a.due ? ` *(${a.due})*` : ''}`)
    .join('\n');

/**
 * The notes as Markdown.
 *
 * Built here from the structured meeting rather than read back out of
 * notes.md — that file only exists once the pipeline has finished, and this
 * button is at its most useful on the meeting that just landed. It is also the
 * shape "copy the action items" is a subset of.
 */
export function notesMarkdown(meeting: MeetingDetail): string {
  const started = new Date(meeting.startedAt);
  const lines = [`# ${meeting.title}`, '', `*${started.toLocaleString()} · ${fmtDuration(meeting.durationSeconds)}*`, ''];

  if (meeting.summary.length) {
    lines.push('## Summary', '');
    for (const bullet of meeting.summary) lines.push(`- ${bullet}`);
    lines.push('');
  }

  lines.push('## Decisions', '');
  if (meeting.decisions.length) {
    for (const d of meeting.decisions) lines.push(`- **${d.decision}**${d.context ? ` — ${d.context}` : ''}`);
  } else {
    lines.push('- *Nothing was settled in this meeting.*');
  }
  lines.push('');

  lines.push('## Action items', '');
  lines.push(actionItemsMarkdown(meeting) || '- *Nobody left with anything to do.*');
  lines.push('');
  return lines.join('\n');
}

// ----------------------------------------------------------------- the actions


/**
 * One row of the side panel: an icon and a label, with a tooltip that says why
 * it is greyed out when it is. A disabled button that does not explain itself
 * reads as a broken one.
 */
export interface PanelButtonOptions {
  label: string;
  tip?: string;
  iconName: string;
  className?: string;
  enabled?: boolean;
  /** Why it is greyed out, when it is. */
  why?: string;
  action?: string;
  onClick: (button: HTMLButtonElement, label: HTMLElement) => unknown;
}

export function panelButton({
  label,
  tip = label,
  iconName,
  className = '',
  enabled = true,
  why,
  action,
  onClick,
}: PanelButtonOptions): HTMLButtonElement {
  const button = el('button', `panel-button${className ? ` ${className}` : ''}`);
  button.type = 'button';
  if (action) button.dataset.action = action;
  const text = el('span', 'panel-label', label);
  button.append(icon(iconName), text);
  button.disabled = !enabled;
  // The label can be hidden when the panel folds to a row of icons, so the
  // tooltip always says the whole thing.
  button.title = !enabled && why ? why : tip;
  if (enabled) button.addEventListener('click', () => onClick(button, text));
  return button;
}

/**
 * A button that copies, and says so.
 *
 * The clipboard gives no feedback of its own, and a button that does nothing
 * visible reads as one that did not work.
 */
export function copyButton(
  label: string,
  enabled: boolean,
  text: () => string,
  { why, action, iconName = 'copy' }: { why?: string; action?: string; iconName?: string } = {},
): HTMLButtonElement {
  return panelButton({
    label,
    tip: `Copy ${label.toLowerCase()}`,
    iconName,
    enabled,
    why,
    action,
    onClick: (button, labelEl) => {
      window.library.copy(text());
      labelEl.textContent = 'Copied';
      button.classList.add('copied');
      button.firstElementChild?.replaceWith(icon('check'));
      setTimeout(() => {
        labelEl.textContent = label;
        button.classList.remove('copied');
        button.firstElementChild?.replaceWith(icon(iconName));
      }, 1200);
    },
  });
}

/**
 * The meeting's actions, as a panel beside the reading column rather than a
 * row of buttons above it.
 *
 * Grouped by what they do — open a file, copy text out, change the archive —
 * so the eye finds a verb before it reads a label, and pinned while the page
 * scrolls so a transcript read to the end still has its copy button in reach.
 * The destructive group sits last and apart, where it is never clicked on the
 * way to something else.
 */
export function actionPanel(meeting: MeetingDetail): HTMLElement {
  const panel = el('aside', 'doc-panel');
  panel.setAttribute('aria-label', 'Meeting actions');

  const group = (heading: string, ...buttons: HTMLElement[]): void => {
    const section = el('div', 'panel-group');
    section.setAttribute('role', 'group');
    section.setAttribute('aria-label', heading);
    section.append(el('div', 'panel-heading', heading), ...buttons);
    panel.append(section);
  };

  const noNotes = meeting.status === 'ready' ? '' : 'Available once the notes are written.';
  const noTranscript = 'Available once there is a transcript.';

  group(
    'Open',
    panelButton({
      label: 'PDF brief',
      tip: 'Open the PDF brief',
      iconName: 'pdf',
      className: 'primary',
      enabled: meeting.files.pdf,
      why: 'The PDF is written with the notes.',
      onClick: () => window.library.open(meeting.id, 'pdf'),
    }),
    panelButton({
      label: 'Play audio',
      tip: 'Play the recording here, or pause it',
      iconName: 'audio',
      enabled: canPlay(meeting),
      why: meeting.files.audio ? 'Available once the recording has stopped.' : 'This meeting has no audio file.',
      onClick: () => togglePlay(meeting),
    }),
    panelButton({
      label: 'Show folder',
      tip: 'Open the meeting folder',
      iconName: 'folder',
      onClick: () => window.library.open(meeting.id, 'folder'),
    }),
  );

  group(
    'Copy',
    copyButton('Notes', meeting.status === 'ready', () => notesMarkdown(meeting), { why: noNotes }),
    // The single most-pasted thing a meeting produces, and until now the only
    // way at it was to open the PDF and retype it.
    copyButton('Action items', meeting.actionItems.length > 0, () => actionItemsMarkdown(meeting), {
      why: 'No action items in this meeting.',
      iconName: 'list',
    }),
    copyButton('Transcript', meeting.transcript.length > 0, () => transcriptText(meeting), {
      why: noTranscript,
      action: 'copy-transcript',
    }),
    // The quote-able version: the same words with each line's [mm:ss] in front.
    // Only offered when the transcript actually has times to quote.
    copyButton(
      'With timestamps',
      meeting.transcript.some((line) => line.startSeconds !== null),
      () => transcriptText(meeting, true),
      { why: 'This transcript has no timestamps.', iconName: 'clock' },
    ),
  );

  // Editing the archive sits apart from reading it, at the bottom of the panel.
  group(
    'Manage',
    panelButton({ label: 'Rename', tip: 'Rename this meeting', iconName: 'rename', onClick: () => startRename(meeting) }),
    panelButton({
      label: 'Delete',
      tip: 'Move this meeting to the Recycle Bin',
      iconName: 'trash',
      className: 'danger',
      onClick: (button) => removeMeeting(meeting, button),
    }),
  );
  return panel;
}

/**
 * Turns the title into a text box.
 *
 * A meeting is called whatever the summariser made of it, for ever — which is
 * how an archive becomes a hundred rows of "Weekly Sync Discussion". The folder
 * name is left alone: it is the meeting's id everywhere else, and a timestamp
 * is a better permanent name than anything typed in a hurry.
 */
export function startRename(meeting: MeetingDetail): void {
  const heading = readerEl.querySelector('.doc-header h1');
  if (!heading || view.renaming) return;
  view.renaming = true;

  const input = el('input', 'title-input');
  input.type = 'text';
  input.value = meeting.title;
  input.maxLength = 120;
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Meeting title');
  heading.replaceChildren(input);
  input.focus();
  input.select();

  let settled = false;
  const finish = async (save: boolean): Promise<void> => {
    if (settled) return;
    settled = true;
    view.renaming = false;
    const wanted = input.value.trim();
    // Unchanged, or cancelled: put the heading back without a round trip.
    if (!save || wanted === meeting.title) {
      renderReader(meeting);
      return;
    }
    const result = await window.library.rename(meeting.id, wanted);
    // A rename changes the rail as well as the reader, so the refresh behind
    // library:changed is what redraws this — but a failure never fires one, and
    // the pane must not be left holding a dead input.
    if (!result?.ok) renderReader(meeting);
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      // Stop it reaching the window handler, which reads Escape as "close".
      e.stopPropagation();
      e.preventDefault();
      finish(false);
    }
  });
  // Clicking away commits, the way a rename does everywhere else.
  input.addEventListener('blur', () => finish(true));
}

/**
 * Deletes a meeting, once the main process has asked whether that is meant.
 *
 * The confirmation is raised there rather than here: this is the one thing the
 * window can do that destroys work, and a page cannot be the thing that
 * vouches for having asked first.
 */
export async function removeMeeting(meeting: MeetingDetail, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  const result = await window.library.delete(meeting.id);
  if (result?.ok) {
    // The folder is gone; the refresh behind library:changed drops the card.
    view.selected = null;
    view.meeting = null;
    renderPlaceholder();
    return;
  }
  button.disabled = false;
  // No reason means the confirmation was declined, which needs no comment.
  if (result?.reason) button.parentElement?.append(el('span', 'notice-warn', result.reason));
}

export function tabs(meeting: MeetingDetail): HTMLElement {
  const bar = el('div', 'tabs');
  const options: [View['tab'], string][] = [
    ['notes', 'Notes'],
    ['transcript', meeting.transcript.length ? `Transcript · ${meeting.transcript.length}` : 'Transcript'],
  ];
  for (const [id, label] of options) {
    const button = el('button', `tab${view.tab === id ? ' active' : ''}`, label);
    button.type = 'button';
    button.setAttribute('aria-pressed', String(view.tab === id));
    button.addEventListener('click', () => {
      if (view.tab === id) return;
      view.tab = id;
      // The tab someone reads in is a habit, not a decision — keep it across
      // meetings and across launches.
      sessionStorage.setItem('minarrador:tab', id);
      renderReader(meeting);
    });
    bar.append(button);
  }
  return bar;
}

/**
 * The button that finishes a meeting the pipeline never did.
 *
 * The most likely failure in the app is Ollama not running at the moment Stop
 * was pressed, and the audio is always kept — so this is the difference between
 * a folder that is a dead WAV and one that is a meeting. It replaces an
 * instruction to run `npm run pipeline`, which assumed a checkout nobody who
 * installed the app has.
 *
 * The click is confirmed by the folder changing under us: main starts the run
 * and returns immediately, and the `library:changed` that follows rebuilds this
 * pane with the "Still working" notice in place of the button.
 */
export function generateButton(meeting: MeetingDetail): HTMLElement {
  const wrap = el('div', 'notice-actions');
  const label = meeting.status === 'failed' ? 'Try again' : 'Generate notes';
  const button = el('button', 'button primary', label);
  button.type = 'button';
  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'Starting…';
    const result = await window.library.reprocess(meeting.id);
    if (result?.ok) return;
    button.disabled = false;
    button.textContent = label;
    wrap.append(el('span', 'notice-warn', result?.reason || 'Could not start that run.'));
  });

  wrap.append(button, el('span', 'notice-hint', 'Transcribes the saved audio again and rewrites the notes.'));
  return wrap;
}

/**
 * The "this is still running" notice, with where it has got to.
 *
 * The numbers were already being produced — the tray has shown them since the
 * pipeline existed — they simply never left the main process. An hour of audio
 * is a long time to be told only that something is happening.
 */
export function workingNotice(meeting: MeetingDetail): HTMLElement {
  const notice = el('div', 'notice');
  notice.append(
    el('strong', '', 'Still working. '),
    'Transcription and notes are running now — this page fills in when they land.',
  );

  const p = progressFor(meeting.id);
  notice.append(el('div', 'notice-progress', progressSentence(p)));
  const track = el('div', 'progress-track');
  const bar = el('div', 'progress-bar');
  const fraction = progressFraction(p);
  // No bar at all rather than an empty one for a stage with nothing to count:
  // a bar stuck at zero reads as a run that is not moving.
  track.classList.toggle('indeterminate', fraction === null);
  bar.style.width = fraction === null ? '100%' : `${Math.round(fraction * 100)}%`;
  track.append(bar);
  notice.append(track);
  return notice;
}

/** The "there are no notes here" explanation, phrased for why there are none. */
export function notesNotice(meeting: MeetingDetail): HTMLElement {
  if (view.activity.processingIds.includes(meeting.id)) return workingNotice(meeting);
  const notice = el('div', 'notice');
  if (meeting.id === view.activity.recordingId) {
    notice.append(el('strong', '', 'Recording. '), 'Notes are written once you stop, from a full pass over the saved audio.');
    return notice;
  }

  if (meeting.status === 'failed') {
    notice.append(
      el('strong', '', 'The notes run failed. '),
      'The audio is safe in this folder, so nothing is lost — fix what went wrong and run it again.',
    );
    // Quoted rather than pointed at: it is one sentence, and it is almost always
    // the reason the button below would fail too.
    if (meeting.error) notice.append(el('div', 'notice-error', meeting.error));
  } else {
    notice.append(
      el('strong', '', 'No notes for this recording. '),
      'The audio was saved but the pipeline never finished.',
    );
  }
  if (meeting.files.audio) notice.append(generateButton(meeting));
  return notice;
}

export function notesView(meeting: MeetingDetail): DocumentFragment {
  const frag = document.createDocumentFragment();
  if (meeting.status !== 'ready') {
    frag.append(notesNotice(meeting));
    if (!meeting.transcript.length) return frag;
  }

  if (meeting.summary.length) {
    frag.append(el('h2', '', 'Summary'));
    const ul = el('ul', 'bullets');
    for (const bullet of meeting.summary) {
      const li = el('li');
      li.append(highlighted(bullet, view.query));
      ul.append(li);
    }
    frag.append(ul);
  }

  if (meeting.status === 'ready') {
    frag.append(el('h2', '', 'Decisions'));
    if (meeting.decisions.length) {
      for (const d of meeting.decisions) {
        const block = el('div', 'decision');
        block.append(highlighted(d.decision, view.query));
        if (d.context) block.append(el('span', 'why', d.context));
        frag.append(block);
      }
    } else {
      frag.append(el('p', 'none', 'Nothing was settled in this meeting.'));
    }

    frag.append(el('h2', '', 'Action items'));
    if (meeting.actionItems.length) {
      for (const a of meeting.actionItems) {
        const row = el('div', 'action');
        // A meeting with a transcript can be jumped to where the action was
        // actually said — the click is what makes the summary a map instead of
        // a list. Rows without one stay plain text.
        if (meeting.transcript.length) {
          row.classList.add('linkable');
          row.tabIndex = 0;
          row.setAttribute('role', 'button');
          row.setAttribute('title', 'Show where this was said in the transcript');
          row.addEventListener('click', () => jumpToAction(meeting, a));
          row.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              jumpToAction(meeting, a);
            }
          });
        }
        row.append(el('span', 'box'));
        const task = el('span', 'task');
        task.append(highlighted(a.task, view.query));
        row.append(task);
        if (a.owner) row.append(el('span', 'owner', a.owner));
        if (a.due) row.append(el('span', 'due', a.due));
        frag.append(row);
      }
    } else {
      frag.append(el('p', 'none', 'Nobody left with anything to do.'));
    }
  }
  return frag;
}

/**
 * Jumps from an action item to the transcript lines that produced it.
 *
 * The notes model does not record which segment a task came from, so this is a
 * best-effort match rather than a link: the owner's name, then the meaningful
 * words of the task, scored against each line. The best match is picked out of
 * the rendered transcript and flashed, which turns the summary from a list into
 * a map of the meeting.
 */
export function jumpToAction(meeting: MeetingDetail, action: ActionItem): void {
  if (!meeting.transcript.length) return;
  view.tab = 'transcript';
  renderReader(meeting);

  const owner = (action.owner || '').trim().toLowerCase();
  const words = (action.task || '')
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 3);
  const terms = [...new Set(owner ? [owner, ...words] : words)].filter(Boolean);
  if (!terms.length) return;

  const scored = meeting.transcript
    .map((line, i) => {
      const text = line.text.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (!text.includes(term)) continue;
        // The owner's name carries the line, so one mention of it outweighs a
        // task word — but never lets a wrong line win.
        score += term === owner ? 4 : 1;
      }
      return { i, score };
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return;

  const row = readerEl.querySelectorAll<HTMLElement>('.line')[scored[0].i];
  if (!row) return;
  row.classList.add('jump');
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  setTimeout(() => row.classList.remove('jump'), 2500);
}

export function transcriptView(meeting: MeetingDetail): DocumentFragment {
  const frag = document.createDocumentFragment();
  if (!meeting.transcript.length) {
    // A run in progress is the most likely reason this tab is empty, and the
    // transcript is the artefact it is producing — so this is the tab someone
    // watches it on. "Not been transcribed yet" while it is being transcribed
    // is the same silence the card's bare "Working…" used to be.
    if (view.activity.processingIds.includes(meeting.id)) {
      frag.append(workingNotice(meeting));
      return frag;
    }

    const notice = el('div', 'notice');
    notice.append(
      el('strong', '', 'No transcript. '),
      meeting.files.audio
        ? 'The recording has not been transcribed yet.'
        : 'This folder has no audio in it either.',
    );
    // Same button as the notes tab, and the same two states it must not offer
    // itself in: nothing to work from, and a meeting still recording.
    const busy = meeting.id === view.activity.recordingId;
    if (meeting.files.audio && meeting.status !== 'ready' && !busy) notice.append(generateButton(meeting));
    frag.append(notice);
    return frag;
  }

  // Lines kept from the live preview are a different thing from a transcript:
  // rougher, untimed, and missing whatever was said while the engine was busy.
  // Saying so is what keeps them useful rather than misleading.
  if (meeting.transcriptSource === 'live') {
    const notice = el('div', 'notice');
    notice.append(
      el('strong', '', 'Rough live transcript. '),
      'This is what the preview heard while the meeting ran, kept because the full pass never happened. ' +
        'Generating the notes replaces it with a careful transcription of the saved audio.',
    );
    frag.append(notice);
  }

  for (const line of meeting.transcript) {
    const row = el('div', 'line');
    // Timestamps come from the chunk boundaries the pipeline transcribed at, so
    // a line is placed to the minute, not to the word. Better than no anchor at
    // all when scrubbing back to "the bit about pricing".
    row.append(timestamp(meeting, line.startSeconds));
    if (line.startSeconds !== null) row.dataset.at = String(line.startSeconds);
    const said = el('span', 'said');
    // The microphone and the system audio were recorded on separate channels
    // and transcribed separately, so a line already knows which side of the
    // call it came from. Nobody has to have said a name out loud.
    if (line.speaker) said.append(el('span', `who ${line.speaker}`, meeting.speakers?.[line.speaker] ?? line.speaker));
    said.append(highlighted(line.text, view.query));
    row.append(said);
    frag.append(row);
  }
  return frag;
}

export function renderReader(meeting: MeetingDetail): void {
  // The heading spans the page; below it the reading column and the actions
  // panel sit side by side, so nothing but the meeting stands between the
  // title and what was said.
  const page = el('div', 'doc-page');
  const header = el('header', 'doc-header');
  const title = el('h1');
  title.append(highlighted(meeting.title, view.query));
  header.append(title, metaRow(meeting));
  const audio = playerFor(meeting);
  if (audio) header.append(audio.parentElement ?? audio);

  const doc = el('div', 'doc');
  doc.append(tabs(meeting));
  doc.append(view.tab === 'transcript' ? transcriptView(meeting) : notesView(meeting));

  const body = el('div', 'doc-body');
  body.append(doc, actionPanel(meeting));
  page.append(header, body);
  readerEl.replaceChildren(page);
  markPlaying();
}

// --------------------------------------------------------------------- player
//
// "Did they really say that?" is the most common thing anybody checks in a
// transcript, and it used to mean opening the WAV in another app and scrubbing
// for the minute. The player sits under the title, and every timed line's
// timestamp starts it from that line.
//
// The audio arrives over `meeting-audio:` (see audio-serve.ts in main), which
// resolves only a meeting id and serves a two-channel recording downmixed to
// mono — mic-left, call-right is right for transcription and wrong in
// headphones. The element is kept across redraws of the same meeting: the
// reader is rebuilt on every tab switch and every folder change, and playback
// must not stop because a pipeline elsewhere finished.

const player: { id: string | null; audio: HTMLAudioElement | null } = { id: null, audio: null };

/** Audio to play, and not the file still being written by a recording. */
const canPlay = (meeting: MeetingDetail): boolean => meeting.files.audio && meeting.id !== view.activity.recordingId;

/** The meeting's player, built once per meeting, or null when there is nothing to play. */
function playerFor(meeting: MeetingDetail): HTMLAudioElement | null {
  if (!canPlay(meeting)) {
    if (player.id === meeting.id) stopPlayer();
    return null;
  }
  if (player.audio && player.id === meeting.id) return player.audio;
  stopPlayer();

  const wrap = el('div', 'doc-player');
  const audio = el('audio');
  audio.controls = true;
  audio.preload = 'metadata';
  audio.src = window.library.audioUrl(meeting.id);
  audio.setAttribute('aria-label', 'Meeting audio');
  audio.addEventListener('timeupdate', markPlaying);
  audio.addEventListener('seeked', markPlaying);
  audio.addEventListener('error', () => {
    wrap.replaceChildren(el('span', 'notice-hint', 'This recording could not be played here.'));
  });
  wrap.append(audio);
  player.id = meeting.id;
  player.audio = audio;
  return audio;
}

/** Releases the current player: a different meeting is opening, or this one went away. */
function stopPlayer(): void {
  if (player.audio) {
    player.audio.pause();
    player.audio.removeAttribute('src');
    player.audio.load();
  }
  player.id = null;
  player.audio = null;
}

/** Plays from `seconds`, building the player if the reader has not yet. */
function playFrom(meeting: MeetingDetail, seconds: number): void {
  const audio = player.id === meeting.id ? player.audio : null;
  if (!audio) return;
  audio.currentTime = seconds;
  void audio.play().catch(() => {});
}

function togglePlay(meeting: MeetingDetail): void {
  const audio = player.id === meeting.id ? player.audio : null;
  if (!audio) return;
  if (audio.paused) void audio.play().catch(() => {});
  else audio.pause();
}

/**
 * A line's timestamp: a button that plays from there when the audio can be
 * played, plain text otherwise.
 */
function timestamp(meeting: MeetingDetail, seconds: number | null): HTMLElement {
  if (seconds === null) return el('span', 'at', '');
  if (!canPlay(meeting)) return el('span', 'at', fmtClock(seconds));
  const button = el('button', 'at play', fmtClock(seconds));
  button.type = 'button';
  button.title = `Play from ${fmtClock(seconds)}`;
  button.setAttribute('aria-label', `Play from ${fmtClock(seconds)}`);
  button.addEventListener('click', () => playFrom(meeting, seconds));
  return button;
}

/**
 * Marks the lines being heard.
 *
 * A timed line starts where its chunk starts, so the lines playing are the
 * ones with the latest start at or before the playhead — both sides of a
 * two-channel chunk share one start, and both light up.
 */
function markPlaying(): void {
  const audio = player.audio;
  const rows = [...readerEl.querySelectorAll<HTMLElement>('.line[data-at]')];
  const listening = Boolean(audio && player.id === view.selected && (!audio.paused || audio.currentTime > 0));
  let current = -1;
  if (listening && audio) {
    for (const row of rows) {
      const at = Number(row.dataset.at);
      if (at <= audio.currentTime && at > current) current = at;
    }
  }
  for (const row of rows) row.classList.toggle('playing', listening && Number(row.dataset.at) === current);
}


// ------------------------------------------------------------------ first run

/**
 * What is missing before this app can turn a meeting into notes.
 *
 * The library is the front door, and until now a fresh install opened it to a
 * cheerful empty archive — the fact that nothing was installed to transcribe
 * with was only visible to somebody who went looking in Settings. Recording
 * still works and the audio is still kept, so this is a notice rather than a
 * wall.
 *
 * @returns {string[]} one sentence per thing to fix, empty when nothing is
 */
export function setupGaps(s: SettingsState | null): string[] {
  if (!s) return [];
  const gaps: string[] = [];
  if (!s.ollama.up) {
    gaps.push(
      s.ollama.installed
        ? 'Ollama is not running. It writes the notes — start it from Settings.'
        : 'Ollama is not installed. It writes the notes; get it from ollama.com/download.',
    );
  } else if (!s.models.includes(s.settings.summaryModel)) {
    gaps.push(`The notes model (${s.settings.summaryModel}) is not installed. Settings can download it.`);
  }
  if (!s.whisper?.available && (!s.ollama.up || !s.models.includes(s.settings.transcribeModel))) {
    gaps.push('Nothing is installed to transcribe with. Settings can fetch whisper.cpp, which is the fast option.');
  }
  return gaps;
}

/** The placeholder, plus the reasons the app cannot finish a meeting yet. */
export function renderPlaceholder() {
  const gaps = setupGaps(view.settings);
  if (!gaps.length) {
    readerEl.replaceChildren(placeholder);
    return;
  }

  const wrap = el('div', 'doc');
  wrap.append(placeholder);
  const notice = el('div', 'notice');
  notice.append(
    el('strong', '', 'Minarrador is not ready to write notes. '),
    'Recording works and the audio is always kept, so nothing is lost in the meantime.',
  );
  const list = el('ul', 'bullets');
  for (const gap of gaps) list.append(el('li', '', gap));
  notice.append(list);

  const actions = el('div', 'notice-actions');
  const button = el('button', 'button primary', 'Open settings');
  button.type = 'button';
  button.addEventListener('click', () => navigate('settings'));
  actions.append(button);
  notice.append(actions);

  wrap.append(notice);
  readerEl.replaceChildren(wrap);
}

// ------------------------------------------------------------------ recording

/**
 * The record button, which is the only thing in this window that acts on the
 * world rather than reading it.
 *
 * Its state comes from the rail — `activity.recordingId` is the folder the main
 * process is recording into — so a meeting started from the tray shows up here
 * as a Stop button without this window being told anything special.
 */
export function renderRecordButton() {
  const on = Boolean(view.activity.recordingId);
  const pending = view.recordWanted !== null && view.recordWanted !== on;
  if (!pending) {
    view.recordWanted = null;
    clearTimeout(recordTimer);
  }

  recordEl.classList.toggle('stop', on);
  recordEl.disabled = pending;
  recordGlyphEl.textContent = on ? '■' : '+';
  recordLabelEl.textContent = pending
    ? view.recordWanted
      ? 'Starting…'
      : 'Stopping…'
    : on
      ? 'Stop recording'
      : 'New recording';
  recordEl.title = on ? 'Stop the meeting being recorded' : 'Start recording a meeting';
}

/**
 * The one action this window has, shared by the record button and its Ctrl+N:
 * start or stop the recording, and learn the result from the rail.
 *
 * Nothing here waits for the answer: stopping runs the whole pipeline, and the
 * confirmation is the folder list changing under us.
 */
export function toggleRecord() {
  const wanted = !view.activity.recordingId;
  view.recordWanted = wanted;
  renderRecordButton();
  window.library.record(wanted);
  clearTimeout(recordTimer);
  recordTimer = setTimeout(() => {
    view.recordWanted = null;
    renderRecordButton();
  }, RECORD_CONFIRM_MS);
}

// -------------------------------------------------------------------- loading

/**
 * Reads a meeting into the reader, if the reader is what is on screen.
 *
 * Also called from the refresh path, where the settings pane may well be open —
 * hence the checks: a pipeline finishing must not throw someone out of the
 * setting they were changing.
 */
/**
 * Moves the numbers on, and nothing else.
 *
 * The counterpart to refresh(): that one re-reads the notes folder and every
 * transcript in it, which is far too much for a chunk counter ticking several
 * times a minute. This updates the two places a number appears — the card's
 * pill and the reader's notice — from a payload that cost the main process
 * nothing to send.
 */
export function renderProgress(activity: Partial<LibraryActivity>): void {
  view.activity = { ...view.activity, ...activity };
  for (const p of view.activity.processing ?? []) {
    const tag = listEl.querySelector(`.card[data-id="${CSS.escape(p.id)}"] .tag.working`);
    if (tag) tag.textContent = progressTag(p);
  }

  if (view.mode !== 'reader' || !view.selected) return;
  const line = readerEl.querySelector('.notice-progress');
  if (!line) return;
  const p = progressFor(view.selected);
  line.textContent = progressSentence(p);
  const fraction = progressFraction(p);
  const track = readerEl.querySelector('.progress-track');
  const bar = readerEl.querySelector<HTMLElement>('.progress-bar');
  if (!track || !bar) return;
  track.classList.toggle('indeterminate', fraction === null);
  bar.style.width = fraction === null ? '100%' : `${Math.round(fraction * 100)}%`;
}

export async function select(id: string): Promise<void> {
  view.selected = id;
  for (const row of listEl.querySelectorAll<HTMLElement>('.card')) {
    const on = row.dataset.id === id;
    row.classList.toggle('selected', on);
    row.setAttribute('aria-selected', String(on));
  }

  const meeting = await window.library.read(id);
  // The folder can vanish between listing and opening it — a manual delete
  // while the window sat there. Fall back to a fresh list rather than a blank.
  if (!meeting) {
    view.selected = null;
    view.meeting = null;
    if (view.mode === 'reader') renderPlaceholder();
    await refresh();
    return;
  }
  if (view.selected !== id) return; // A faster click won.
  view.meeting = meeting;
  // The window reopens onto the same meeting it was closed on; a recording that
  // finished belongs at the top, so a stale id simply falls back to newest.
  sessionStorage.setItem('minarrador:lastMeeting', id);
  if (view.mode !== 'reader') return;
  // A pipeline finishing somewhere else must not throw away a half-typed
  // title. The rail behind it is already up to date either way.
  if (view.renaming) return;
  readerEl.scrollTop = 0;
  renderReader(meeting);
}

/** A click in the rail, which is only on screen while Recording is. */
export function openMeeting(id: string): void {
  select(id);
}

/**
 * Rebuilds the rail from disk, keeping the open meeting open.
 *
 * Called on every search keystroke and whenever a recording starts or finishes,
 * so it must never steal the reader from whatever is being read.
 */
export async function refresh() {
  const seq = ++listSeq;
  const { meetings, activity } = await window.library.list(view.query);
  if (seq !== listSeq) return; // A later query already answered.
  view.meetings = meetings;
  view.activity = activity;
  searchingEl.hidden = true;
  // The record button reads its state from here, so a meeting started from the
  // tray flips it without this window being told anything else.
  renderRecordButton();
  if (view.selected && !meetings.some((m) => m.id === view.selected)) {
    // Filtered out by the current search, not gone: keep it on screen, just
    // unhighlighted in a rail that no longer lists it.
    listEl.querySelector('.card.selected')?.classList.remove('selected');
  }
  renderList();
}

// --------------------------------------------------------------------- health

/**
 * The lights under the record button: microphone, system audio, whisper.cpp
 * and Ollama, each green, amber, or grey when turned off.
 *
 * Every one of these used to be discovered after the meeting — a system
 * channel that heard nothing because the call played through a headset the
 * loopback was not on is the classic — and the record button is the one place
 * everybody looks right before a call. Main decides when it is shown: always
 * while idle, and for the first ten seconds of a recording, when a source that
 * has heard nothing turns from "listening" to a warning. The first warning is
 * spelled out, since a coloured dot alone does not say what to do.
 */
export function renderHealth(health: Health | null): void {
  if (!health || !health.show) {
    healthEl.hidden = true;
    return;
  }
  const lights = el('div', 'health-lights');
  for (const item of health.items) {
    const light = el('span', `health-item ${item.state}`);
    light.title = `${item.label}: ${item.detail}`;
    light.append(el('span', 'health-dot'), el('span', 'health-label', item.label));
    light.setAttribute('aria-label', `${item.label}: ${item.detail}`);
    lights.append(light);
  }
  const nodes: HTMLElement[] = [lights];
  // The one spelled out is the one that costs the most: a silent source loses
  // the meeting, a missing Ollama loses the notes, a missing whisper.cpp only
  // makes them slower.
  const severity = ['system', 'mic', 'ollama', 'whisper'];
  const warn = health.items
    .filter((i) => i.state === 'warn')
    .sort((a, b) => severity.indexOf(a.key) - severity.indexOf(b.key))[0];
  const waiting = health.items.some((i) => i.state === 'wait');
  if (warn) nodes.push(el('div', 'health-note', `${warn.label}: ${warn.detail}`));
  else if (waiting) nodes.push(el('div', 'health-note quiet', 'Listening for the first few seconds…'));
  healthEl.replaceChildren(...nodes);
  healthEl.classList.toggle('recording', health.recording);
  healthEl.hidden = false;
}
