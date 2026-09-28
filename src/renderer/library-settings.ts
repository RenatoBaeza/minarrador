// The Settings feature: every setting, and whether the thing it names is
// actually installed.

import type { Engine, Settings, SettingsState } from '../shared/types';
import { el, readerEl, view, navigate } from './library-common.js';

// --------------------------------------------------------------- the settings

// Everything the tray's Settings submenu used to hold, plus the one thing a
// submenu could not show: whether the value a setting names is actually there.
// A model that was never pulled and a model that is running look identical in a
// radio list, and the difference is the whole meeting's notes — so a setting
// pointing at something missing is marked, in red, with what to do about it.

/** A row that is a checkbox: the whole label toggles it. */
export interface RowText {
  title: string;
  hint?: string;
  /** The red line under a row pointing at something missing. */
  alert?: string;
}

export interface Option {
  value: string;
  label: string;
}

export function toggleRow({
  title,
  hint,
  alert: alertText,
  key,
  checked,
  disabled,
}: RowText & { key: keyof Settings; checked: boolean; disabled?: boolean }): HTMLElement {
  const row = el('label', `row${alertText ? ' missing' : ''}`);
  const body = el('span', 'row-body');
  body.append(el('span', 'row-title', title));
  if (hint) body.append(el('span', 'row-hint', hint));
  if (alertText) body.append(el('span', 'row-alert', alertText));

  const box = el('input', 'switch');
  box.type = 'checkbox';
  box.checked = Boolean(checked);
  box.disabled = Boolean(disabled);
  box.addEventListener('change', () => saveSetting({ [key]: box.checked }));

  row.append(body, box);
  return row;
}

/**
 * A row that is a dropdown.
 *
 * `missing` is the red state: the value in settings.json is not among the
 * options, because whatever it names is not installed any more. The value stays
 * selected rather than being silently swapped for the first thing in the list —
 * the app already does that for models when it can, and where it cannot, saying
 * so is more useful than pretending.
 */
export function selectRow({
  title,
  hint,
  alert: alertText,
  note,
  ok,
  options,
  value,
  missing,
  disabled,
  onPick,
}: RowText & {
  note?: string;
  ok?: string;
  options: Option[];
  value: string;
  missing?: boolean;
  disabled?: boolean;
  onPick: (value: string) => unknown;
}): HTMLElement {
  const row = el('div', `row${missing ? ' missing' : ''}`);
  const body = el('span', 'row-body');
  body.append(el('span', 'row-title', title));
  if (hint) body.append(el('span', 'row-hint', hint));
  if (alertText) body.append(el('span', missing ? 'row-alert' : 'row-hint', alertText));
  if (note) body.append(el('span', 'row-hint', note));
  if (ok) body.append(el('span', 'row-ok', ok));

  const picker = el('select', 'control');
  picker.disabled = Boolean(disabled) || options.length === 0;
  for (const option of options) {
    const node = el('option', '', option.label);
    node.value = option.value;
    node.selected = option.value === value;
    picker.append(node);
  }
  picker.addEventListener('change', () => onPick(picker.value));

  row.append(body, picker);
  return row;
}

/** A row whose control is a button: a folder to pick, an app to start, a list to edit. */
export function buttonRow({
  title,
  hint,
  alert: alertText,
  ok,
  value,
  missing,
  label,
  primary,
  disabled,
  onClick,
}: RowText & {
  ok?: string;
  value?: string;
  missing?: boolean;
  label: string;
  primary?: boolean;
  disabled?: boolean;
  onClick: (button: HTMLButtonElement) => unknown;
}): HTMLElement {
  const row = el('div', `row${missing ? ' missing' : ''}`);
  const body = el('span', 'row-body');
  body.append(el('span', 'row-title', title));
  if (value) body.append(el('span', 'value', value));
  if (hint) body.append(el('span', 'row-hint', hint));
  if (alertText) body.append(el('span', missing ? 'row-alert' : 'row-hint', alertText));
  if (ok) body.append(el('span', 'row-ok', ok));

  const button = el('button', `button${primary ? ' primary' : ''}`, label);
  button.type = 'button';
  button.disabled = Boolean(disabled);
  button.addEventListener('click', () => onClick(button));

  row.append(body, button);
  return row;
}

/**
 * A row that is a dropdown *and* a button: pick a thing, then fetch it.
 *
 * Only used by the two first-run downloads, where the choice and the action
 * belong to the same sentence — "install whisper.cpp with these weights" is one
 * decision, and splitting it across two rows would read as two.
 */
export function downloadRow({
  title,
  hint,
  alert: alertText,
  options,
  value,
  onPick,
  label,
  disabled,
  onClick,
}: RowText & {
  options?: Option[];
  value?: string;
  onPick?: (value: string) => unknown;
  label: string;
  disabled?: boolean;
  onClick: (button: HTMLButtonElement) => unknown;
}): HTMLElement {
  const row = el('div', 'row missing');
  const body = el('span', 'row-body');
  body.append(el('span', 'row-title', title));
  if (hint) body.append(el('span', 'row-hint', hint));
  if (alertText) body.append(el('span', 'row-alert', alertText));

  const controls = el('span', 'row-controls');
  if (options) {
    const picker = el('select', 'control narrow');
    for (const option of options) {
      const node = el('option', '', option.label);
      node.value = option.value;
      node.selected = option.value === value;
      picker.append(node);
    }
    picker.disabled = Boolean(disabled);
    picker.addEventListener('change', () => onPick?.(picker.value));
    controls.append(picker);
  }

  const button = el('button', 'button primary', label);
  button.type = 'button';
  button.disabled = Boolean(disabled);
  button.addEventListener('click', () => onClick(button));
  controls.append(button);

  row.append(body, controls);
  return row;
}

/**
 * The download in flight, wherever it was started from.
 *
 * At the top of the pane rather than in the section that launched it: it is
 * minutes of work with nothing else to look at, and burying it under a section
 * heading would mean scrolling to find out whether it is still going.
 */
export function setupRow(setup: NonNullable<SettingsState['setup']>): HTMLElement {
  const row = el('div', 'row');
  const body = el('span', 'row-body');
  body.append(el('span', 'row-title', `Downloading ${setup.label}`));
  const detail = setup.total
    ? `${setup.status} — ${fmtBytes(setup.completed)} of ${fmtBytes(setup.total)}`
    : setup.status || 'starting…';
  body.append(el('span', 'row-hint', detail));

  const track = el('div', 'progress-track');
  const bar = el('div', 'progress-bar');
  track.classList.toggle('indeterminate', !setup.total);
  bar.style.width = setup.total ? `${Math.round((setup.completed / setup.total) * 100)}%` : '100%';
  track.append(bar);
  body.append(track);

  const button = el('button', 'button', 'Cancel');
  button.type = 'button';
  button.addEventListener('click', async () => {
    button.disabled = true;
    view.settings = await window.library.settings.cancelSetup();
    if (view.mode === 'settings') renderSettings();
  });

  row.append(body, button);
  return row;
}

export const group = (frag: DocumentFragment, heading: string, rows: HTMLElement[]): void => {
  frag.append(el('h2', '', heading));
  const box = el('div', 'rows');
  box.append(...rows);
  frag.append(box);
};

/**
 * "Default: x", but only once the value has been moved off it.
 *
 * A pane that reprinted the default beside every row would be noise; the useful
 * moment is the one where a setting is no longer what the app shipped with, and
 * the person reading it wants to know what it used to be.
 */
export const defaultNote = (value: unknown, fallback: unknown, label: unknown = fallback): string =>
  fallback === undefined || value === fallback ? '' : `Default: ${label}`;

/** Options for a model dropdown, keeping a value that is no longer installed. */
export function modelOptions(names: string[], current: string, suffix: (name: string) => string = () => ''): Option[] {
  const options = names.map((name) => ({ value: name, label: `${name}${suffix(name)}` }));
  if (current && !names.includes(current)) {
    options.unshift({ value: current, label: `${current} — not installed` });
  }
  return options;
}

/** "20 minutes", "4 hours", or the word for the value that turns a limit off. */
export function minuteOptions(values: number[], never: string): Option[] {
  return values.map((n) => ({
    value: String(n),
    label: n === 0 ? never : n % 60 === 0 ? `${n / 60} hour${n === 60 ? '' : 's'}` : `${n} minutes`,
  }));
}

export const SILENCE_CHOICES = [0, 5, 10, 15, 30, 60];
export const MAX_LENGTH_CHOICES = [0, 60, 120, 180, 240, 480];

export const fmtBytes = (bytes: number): string =>
  bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;

export function recordingSection(frag: DocumentFragment, s: SettingsState): void {
  const noSource = !s.settings.captureMic && !s.settings.captureSystem;
  const hotkeyOff = s.hotkey.value === 'off';
  const hotkeyDefault = s.hotkey.choices.find((c) => c.value === s.defaults.hotkey);
  group(frag, 'Recording', [
    selectRow({
      title: 'Start and stop shortcut',
      hint: 'Works anywhere in Windows, so a call can be recorded without hunting for the tray icon first.',
      // A shortcut another application already holds registers as nothing at
      // all — the one failure here that looks exactly like success.
      alert: hotkeyOff || s.hotkey.registered ? '' : 'Another application already holds this shortcut. Pick a different one.',
      missing: !hotkeyOff && !s.hotkey.registered,
      options: s.hotkey.choices,
      value: s.hotkey.value,
      note: defaultNote(s.hotkey.value, s.defaults.hotkey, hotkeyDefault?.label ?? s.defaults.hotkey),
      onPick: (value) => saveSetting({ hotkey: value }),
    }),
    toggleRow({
      title: 'Suggest recording when audio is detected',
      hint: 'Minarrador watches the levels while idle and offers to start a meeting.',
      key: 'suggestOnAudio',
      checked: s.settings.suggestOnAudio,
    }),
    toggleRow({
      title: 'Start Minarrador at login',
      hint: 'Starts hidden, in the tray.',
      key: 'startAtLogin',
      checked: s.settings.startAtLogin,
    }),
    toggleRow({
      title: 'Open the live transcript when recording starts',
      hint: 'A rough preview while the meeting runs. The saved transcript is a separate, fuller pass.',
      key: 'liveTranscript',
      checked: s.settings.liveTranscript,
    }),
    toggleRow({
      title: 'Record the microphone',
      hint: s.recording ? 'Cannot be changed while a meeting is recording.' : 'Your side of the conversation.',
      alert: noSource ? 'Both sources are off — a recording would capture nothing.' : '',
      key: 'captureMic',
      checked: s.settings.captureMic,
      disabled: s.recording,
    }),
    toggleRow({
      title: 'Record system audio',
      hint: s.recording ? 'Cannot be changed while a meeting is recording.' : 'Everyone else, as your speakers hear them.',
      alert: noSource ? 'Both sources are off — a recording would capture nothing.' : '',
      key: 'captureSystem',
      checked: s.settings.captureSystem,
      disabled: s.recording,
    }),
    micRow(s),
    micTestRow(),
    toggleRow({
      title: 'Keep the two sources on separate channels',
      hint:
        'Records you on the left and everyone else on the right, so the transcript can say who said what ' +
        'and the notes can name who owns an action item. Costs about twice the disk.',
      key: 'separateChannels',
      checked: s.settings.separateChannels,
      disabled: s.recording,
    }),
  ]);

  group(frag, 'Limits', [
    selectRow({
      title: 'Stop after silence',
      hint: 'Ends a meeting that nobody stopped. The notes are written from what was actually said.',
      options: minuteOptions(SILENCE_CHOICES, 'Never'),
      value: String(s.settings.silenceStopMinutes),
      note: defaultNote(
        s.settings.silenceStopMinutes,
        s.defaults.silenceStopMinutes,
        `${s.defaults.silenceStopMinutes} minutes`,
      ),
      onPick: (value) => saveSetting({ silenceStopMinutes: Number(value) }),
    }),
    selectRow({
      title: 'Longest recording',
      // The backstop for the first one failing to notice: hold music, a fan the
      // microphone can hear, a call left connected over a weekend.
      hint: 'A hard ceiling. Minarrador stops and writes the notes when a meeting reaches it.',
      alert:
        s.settings.silenceStopMinutes === 0 && s.settings.maxRecordingMinutes === 0
          ? 'Nothing will stop a recording you forget about.'
          : '',
      missing: s.settings.silenceStopMinutes === 0 && s.settings.maxRecordingMinutes === 0,
      options: minuteOptions(MAX_LENGTH_CHOICES, 'No limit'),
      value: String(s.settings.maxRecordingMinutes),
      note: defaultNote(
        s.settings.maxRecordingMinutes,
        s.defaults.maxRecordingMinutes,
        `${s.defaults.maxRecordingMinutes / 60} hours`,
      ),
      onPick: (value) => saveSetting({ maxRecordingMinutes: Number(value) }),
    }),
    toggleRow({
      title: 'Keep the machine awake while recording',
      // Honest about what it can and cannot do: Windows suspends on a lid close
      // whatever this says, which is why the app also rebuilds on resume.
      hint:
        'Stops Windows suspending an idle machine mid-meeting. Closing the lid still suspends it — Minarrador ' +
        'rebuilds the audio graph on wake and carries on into the same file.',
      key: 'preventSleep',
      checked: s.settings.preventSleep,
    }),
  ]);
}

/**
 * Which microphone is being recorded — and, when it is not the chosen one, that
 * it is not.
 *
 * The gap this exists for: `getUserMedia` with no deviceId takes the Windows
 * default, so a meeting can record the laptop lid while the headset sits
 * unused, and every indicator in the app says the microphone is fine.
 */
export function micRow(s: SettingsState): HTMLElement {
  const { devices, active, chosen, chosenLabel } = s.mic;
  const known = devices.some((d) => d.id === chosen);
  const options = [{ value: '', label: 'System default' }, ...devices.map((d) => ({ value: d.id, label: d.label }))];
  if (chosen && !known) options.push({ value: chosen, label: `${chosenLabel || 'Chosen device'} — not connected` });

  return selectRow({
    title: 'Microphone',
    hint: devices.length
      ? 'Which input your side of the conversation is recorded from.'
      : 'Available once Minarrador has opened a microphone at least once.',
    // Naming what is open is the whole point: a green tick next to "Mic" only
    // ever meant that something opened.
    ok: active ? `Recording from ${active}` : '',
    alert: chosen && !known ? 'That device is not connected. The system default is being used instead.' : '',
    missing: Boolean(chosen) && !known,
    options,
    value: chosen,
    disabled: !s.settings.captureMic || s.recording || !devices.length,
    onPick: (value) =>
      saveSetting({
        micDeviceId: value,
        // Stored alongside because Chromium's ids are salted per origin and are
        // not guaranteed to come back the same after a restart.
        micDeviceLabel: devices.find((d) => d.id === value)?.label ?? '',
      }),
  });
}

/**
 * The "Test microphone" row: a button that opens the chosen mic and a meter
 * that shows what it hears, so "is it my mic or the app?" is answered without
 * recording anything. It borrows the dictation worker, which already opens the
 * mic on demand and reports an RMS level — a test is a session that records
 * nothing and transcribes nothing.
 */
export function micTestRow() {
  const t = view.micTest;
  const row = el('div', 'row');
  const body = el('span', 'row-body');
  body.append(el('span', 'row-title', 'Test microphone'));

  const note = el('span', 'row-hint', t.note || 'Opens the chosen microphone and shows what it hears. Nothing is recorded.');
  const track = el('div', 'mic-meter');
  const bar = el('div', 'mic-meter-bar');
  bar.style.width = `${Math.min(100, Math.round(t.level * 600))}%`;
  track.append(bar);
  body.append(note, track);

  const button = el('button', `button${t.testing ? ' danger' : ''}`, t.testing ? 'Stop' : 'Test');
  button.type = 'button';
  button.addEventListener('click', async () => {
    if (view.micTest.testing) {
      window.library.settings.testMicStop();
      view.micTest = { testing: false, level: 0, note: '' };
      if (view.mode === 'settings') renderSettings();
      return;
    }
    const result = await window.library.settings.testMicStart();
    if (!result?.ok) {
      view.micTest = { testing: false, level: 0, note: result?.reason || 'Could not open the microphone.' };
      if (view.mode === 'settings') renderSettings();
      return;
    }
    view.micTest = { testing: true, level: 0, note: '' };
    if (view.mode === 'settings') renderSettings();
  });

  view.micTestEls = { note, bar, button };
  row.append(body, button);
  return row;
}

export function liveSection(frag: DocumentFragment, s: SettingsState): void {
  const whisper = s.whisper;
  const installed = Boolean(whisper?.available);
  const wantsWhisper = s.settings.liveEngine === 'whisper';
  const models = whisper?.models ?? [];
  const model = whisper?.model ?? '';
  const busy = Boolean(s.setup);

  const rows = [];
  // The way out of "this app cannot transcribe anything". It used to say `npm
  // run whisper:setup`, which needs a checkout, npm and a terminal — none of
  // which exist for anyone who installed the build, so the app shipped able to
  // be in a state it could not get out of.
  if (!installed) {
    rows.push(
      downloadRow({
        title: 'Install whisper.cpp',
        hint:
          'A local speech recogniser: several times faster than the audio model, and it means Ollama is only ' +
          'needed for the notes. Downloaded once, from GitHub and Hugging Face. No meeting data is involved.',
        alert: 'Not installed. Transcription falls back to the Ollama audio model, which takes about as long as the meeting did.',
        options: s.whisperModels,
        value: view.whisperPick,
        onPick: (value) => {
          view.whisperPick = value;
        },
        label: busy ? 'Downloading…' : 'Download',
        disabled: busy,
        onClick: async () => {
          const result = await window.library.settings.installWhisper(view.whisperPick);
          view.settings = await window.library.settings.get();
          if (view.mode === 'settings') renderSettings();
          return result;
        },
      }),
    );
  }

  rows.push(
    selectRow({
      title: 'Engine',
      hint: 'whisper.cpp is a local speech recogniser and runs several times faster than the audio model.',
      alert: wantsWhisper && !installed ? 'whisper.cpp is not installed — falling back to Ollama.' : '',
      missing: wantsWhisper && !installed,
      options: [
        { value: 'whisper', label: installed ? `whisper.cpp — ${model}` : 'whisper.cpp — not installed' },
        { value: 'ollama', label: `Ollama — ${s.settings.transcribeModel}` },
      ],
      value: s.settings.liveEngine,
      note: defaultNote(s.settings.liveEngine, s.defaults.liveEngine, 'whisper.cpp'),
      onPick: (value) => saveSetting({ liveEngine: value as Engine }),
    }),
    selectRow({
      title: 'Whisper model',
      hint: 'Bigger weights are more accurate and slower. Captions trail further behind as they grow.',
      alert: installed ? '' : 'No GGML models yet — install one above.',
      note: defaultNote(model, s.defaults.whisperModel),
      missing: !installed,
      options: modelOptions(models, model),
      value: model,
      disabled: !installed,
      onPick: (value) => saveSetting({ whisperModel: value }),
    }),
    selectRow({
      title: 'Whisper decode threads',
      hint: 'The large models need more than the automatic share to keep up with the room. Applies to the next segment.',
      note: defaultNote(whisper?.threads ?? 0, s.defaults.whisperThreads, 'automatic'),
      options: (whisper?.threadChoices ?? [0]).map((n) => ({
        value: String(n),
        label: n === 0 ? `Automatic (${whisper?.effectiveThreads ?? 4})` : `${n} threads`,
      })),
      value: String(whisper?.threads ?? 0),
      disabled: !installed,
      onPick: (value) => saveSetting({ whisperThreads: Number(value) }),
    }),
  );

  group(frag, 'Live transcript', rows);
}

export function ollamaSection(frag: DocumentFragment, s: SettingsState): void {
  const { models, audioModels, ollama } = s;
  const audio = new Set(audioModels);
  const missingTranscribe = !models.includes(s.settings.transcribeModel);
  const missingSummary = !models.includes(s.settings.summaryModel);
  const whisperInstalled = Boolean(s.whisper?.available);
  const whisperModel = s.whisper?.model ?? '';
  const wantsWhisper = s.settings.transcribeEngine === 'whisper';
  const busy = Boolean(s.setup);

  // A running Ollama with nothing pulled is the other half of an install that
  // cannot work, and `ollama pull` in a terminal is not an answer for anyone
  // who arrived here via an installer. Only the models this app is set to use
  // are on offer — main refuses anything else, so no tag typed anywhere could
  // reach the daemon.
  const pulls = (s.pullable ?? []).map((name) =>
    downloadRow({
      title: `Download ${name}`,
      hint: 'Ollama fetches this to your machine and Minarrador uses it from there. It is the model the settings below name.',
      alert: 'Configured but not installed. Nothing can be transcribed or summarised until it is.',
      label: busy ? 'Downloading…' : 'Download',
      disabled: busy || !ollama.up,
      onClick: async () => {
        const result = await window.library.settings.pullModel(name);
        view.settings = await window.library.settings.get();
        if (view.mode === 'settings') renderSettings();
        return result;
      },
    }),
  );

  group(frag, 'Transcription and notes', [
    ...(ollama.up ? pulls : []),
    buttonRow({
      title: 'Ollama',
      value: ollama.host,
      hint: 'Writes the saved transcript and the notes. Nothing is sent anywhere else.',
      alert: ollama.up
        ? ''
        : ollama.installed
          ? 'Not running. A meeting stopped now would keep its audio but get no notes.'
          : 'Not installed on this machine. Get it from https://ollama.com/download, then pull a model.',
      ok: ollama.up ? `Running · ${models.length} model${models.length === 1 ? '' : 's'} installed` : '',
      missing: !ollama.up,
      label: ollama.checking ? 'Starting…' : 'Open Ollama',
      primary: !ollama.up,
      disabled: ollama.up || ollama.checking || !ollama.installed,
      onClick: async () => {
        // The main process starts the daemon and waits for it to answer, which
        // takes seconds; the pane redraws from settings:changed either way.
        view.settings = await window.library.settings.openOllama();
        if (view.mode === 'settings') renderSettings();
      },
    }),
    selectRow({
      title: 'Saved transcript engine',
      hint:
        'whisper.cpp reads an hour of audio in a few minutes on the default weights, and needs nothing ' +
        'from Ollama — which is then only required for the notes.',
      alert: wantsWhisper && !whisperInstalled
        ? 'whisper.cpp is not installed — the audio model transcribes instead. Run npm run whisper:setup.'
        : '',
      missing: wantsWhisper && !whisperInstalled,
      options: [
        { value: 'whisper', label: whisperInstalled ? `whisper.cpp — ${whisperModel}` : 'whisper.cpp — not installed' },
        { value: 'ollama', label: `Ollama — ${s.settings.transcribeModel}` },
      ],
      value: s.settings.transcribeEngine,
      note: defaultNote(s.settings.transcribeEngine, s.defaults.transcribeEngine, 'whisper.cpp'),
      onPick: (value) => saveSetting({ transcribeEngine: value as Engine }),
    }),
    selectRow({
      title: 'Transcription model',
      hint: 'The audio model, used for the saved transcript and the live preview whenever whisper.cpp is not.',
      alert: models.length ? '' : 'No models to choose from while Ollama is unreachable.',
      missing: missingTranscribe,
      note: defaultNote(s.settings.transcribeModel, s.defaults.transcribeModel),
      options: modelOptions(models, s.settings.transcribeModel, (name) => (audio.has(name) ? ' · audio' : '')),
      value: s.settings.transcribeModel,
      disabled: !models.length,
      onPick: (value) => saveSetting({ transcribeModel: value }),
    }),
    selectRow({
      title: 'Notes model',
      hint: 'Turns the transcript into the summary, decisions and action items.',
      alert: models.length ? '' : 'No models to choose from while Ollama is unreachable.',
      missing: missingSummary,
      note: defaultNote(s.settings.summaryModel, s.defaults.summaryModel),
      options: modelOptions(models, s.settings.summaryModel),
      value: s.settings.summaryModel,
      disabled: !models.length,
      onPick: (value) => saveSetting({ summaryModel: value }),
    }),
  ]);
}

export function storageSection(frag: DocumentFragment, s: SettingsState): void {
  const free = s.disk?.free ?? null;
  // Two channels is ~230 MB an hour, one is ~115. Saying so beside the number
  // is what turns "41 GB free" into something anyone can act on.
  const space = free === null ? '' : `${fmtBytes(free)} free — about ${Math.floor(free / (230 * 1024 ** 2))} hours of recording`;

  group(frag, 'Storage and shorthands', [
    buttonRow({
      title: 'Meetings folder',
      value: s.settings.notesDir,
      hint: 'One folder per recording: the audio, the transcript, the notes and the PDF brief.',
      alert: !s.notesDirExists
        ? 'This folder does not exist any more. Pick another, or the library stays empty.'
        : s.disk?.low
          ? `Running out of space — ${space}.`
          : '',
      ok: s.notesDirExists && !s.disk?.low && space ? space : '',
      missing: !s.notesDirExists || Boolean(s.disk?.low),
      label: 'Change…',
      onClick: async () => {
        view.settings = await window.library.settings.chooseNotesFolder();
        if (view.mode === 'settings') renderSettings();
      },
    }),
    buttonRow({
      title: 'Quick copy',
      hint: s.snippetCount
        ? `${s.snippetCount} shorthand${s.snippetCount === 1 ? '' : 's'} at the top of the tray menu, one click to the clipboard.`
        : 'Phrases you type all day, one click from the tray menu to the clipboard.',
      alert: s.snippetCount ? '' : 'Nothing saved yet — the tray section is empty until you add one.',
      label: 'Edit quick copy…',
      onClick: () => navigate('quickcopy'),
    }),
  ]);
}

/**
 * A button that says whether it worked, in place, then goes back to its label.
 * A diagnostics copy or a capture restart otherwise has no visible result.
 */
export async function runAction(
  button: HTMLButtonElement,
  busy: string,
  done: string,
  action: () => Promise<boolean>,
): Promise<void> {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = busy;
  const ok = await action().catch(() => false);
  button.textContent = ok ? done : 'Failed';
  setTimeout(() => {
    button.textContent = label;
    button.disabled = false;
  }, 1500);
}

export function troubleshootingSection(frag: DocumentFragment): void {
  group(frag, 'Troubleshooting', [
    buttonRow({
      title: 'Log file',
      hint: 'What Minarrador has been doing, kept on this machine. The first thing to look at when something failed.',
      label: 'Open log file',
      onClick: (button) => runAction(button, 'Opening…', 'Opened', () => window.library.settings.openLog()),
    }),
    buttonRow({
      title: 'Diagnostics',
      hint: 'Versions, engines, devices and settings as text on the clipboard — no audio or transcripts.',
      label: 'Copy diagnostics',
      onClick: (button) => runAction(button, 'Copying…', 'Copied', () => window.library.settings.copyDiagnostics()),
    }),
    buttonRow({
      title: 'Audio capture',
      hint: 'Rebuilds the microphone and system-audio capture. A recording in progress continues into the same file.',
      label: 'Restart audio capture',
      onClick: (button) => runAction(button, 'Restarting…', 'Restarted', () => window.library.settings.restartCapture()),
    }),
  ]);
}

export function voiceSection(frag: DocumentFragment, s: SettingsState): void {
  const dh = s.dictateHotkey ?? { value: 'off', registered: false, choices: [] };
  const whisperInstalled = Boolean(s.whisper?.available);
  group(frag, 'Voice input', [
    selectRow({
      title: 'Dictate shortcut',
      hint:
        'Press it to start the microphone, press it again to stop, transcribe and paste. ' +
        'Works anywhere in Windows, like the recording shortcut.',
      alert:
        dh.value === 'off' || dh.registered ? '' : 'Another application already holds this shortcut. Pick a different one.',
      missing: dh.value !== 'off' && !dh.registered,
      options: dh.choices,
      value: dh.value,
      onPick: (value) => saveSetting({ dictateHotkey: value }),
    }),
    selectRow({
      title: 'Transcribe with',
      hint:
        'Which engine writes the dictated text. The Ollama audio model is the careful pass — the sentence as it was ' +
        'said; whisper.cpp is the fast one.',
      alert: !whisperInstalled && s.settings.dictateEngine === 'whisper'
        ? 'whisper.cpp is not installed — the audio model will be used instead.'
        : '',
      missing: !whisperInstalled && s.settings.dictateEngine === 'whisper',
      options: [
        { value: 'ollama', label: `Ollama — ${s.settings.transcribeModel}` },
        { value: 'whisper', label: whisperInstalled ? `whisper.cpp — ${s.whisper?.model}` : 'whisper.cpp — not installed' },
      ],
      value: s.settings.dictateEngine,
      note: defaultNote(s.settings.dictateEngine, s.defaults.dictateEngine, 'Ollama'),
      onPick: (value) => saveSetting({ dictateEngine: value as Engine }),
    }),
    toggleRow({
      title: 'Paste where you were typing',
      hint:
        'Types the text into the window that had the cursor, using Windows itself. The clipboard always gets ' +
        'a copy too, and nothing is ever sent anywhere else.',
      key: 'dictateAutoPaste',
      checked: s.settings.dictateAutoPaste,
    }),
    buttonRow({
      title: 'Dictation history',
      hint: 'Everything you dictated, editable and copyable, kept on this machine.',
      label: 'Open dictations…',
      onClick: () => window.library.settings.openDictations(),
    }),
  ]);
}

export function renderSettings() {
  const s = view.settings;
  const doc = el('div', 'doc settings');
  doc.append(el('h1', '', 'Settings'));
  if (!s) {
    doc.append(el('p', 'settings-lead', 'Reading the settings…'));
    readerEl.replaceChildren(doc);
    return;
  }

  doc.append(
    el(
      'p',
      'settings-lead',
      'Everything Minarrador uses runs on this machine. Anything marked in red is set to something that is not there.',
    ),
  );

  const frag = document.createDocumentFragment();
  // A download in flight goes above every section, because it is the only thing
  // on this pane that is happening rather than set.
  if (s.setup) {
    const box = el('div', 'rows');
    box.append(setupRow(s.setup));
    frag.append(box);
  }
  recordingSection(frag, s);
  ollamaSection(frag, s);
  liveSection(frag, s);
  voiceSection(frag, s);
  storageSection(frag, s);
  troubleshootingSection(frag);
  doc.append(frag);
  // The whole pitch of the app, said where the privacy-sensitive settings live.
  doc.append(
    el(
      'p',
      'settings-foot',
      'Everything Minarrador does runs on this machine — audio, transcripts and notes never leave it.' +
        (s.version ? ` Version ${s.version}.` : ''),
    ),
  );
  readerEl.replaceChildren(doc);
}

/** Writes one setting and redraws from the state the main process wrote. */
export async function saveSetting(patch: Partial<Settings>): Promise<void> {
  view.settings = await window.library.settings.set(patch);
  if (view.mode === 'settings') renderSettings();
}
