'use strict';

// Everything that happens after Stop: transcribe -> summarise -> PDF.
// Each step writes its artefact to the meeting folder before the next begins,
// so a failure late in the chain never costs you the earlier work.

const fs = require('node:fs');
const path = require('node:path');

const { Ollama } = require('./ollama');
const { readWav, buildWav, splitIntoChunks, deinterleave, downmix, rms } = require('./wav');
const { FILES, SPEAKERS, speakerLine, readTitle } = require('./paths');

// ./pdf pulls in Electron, so it is required at call time rather than on import.
// That keeps every pure stage of this file usable from a plain Node process.
const htmlToPdf = (...args) => require('./pdf').htmlToPdf(...args);

/** Chunks quieter than this are almost certainly room tone; skip them. */
const SILENCE_RMS = 0.004;
/** Above this many characters we summarise in passes instead of one shot. */
const CONDENSE_THRESHOLD = 48000;
const CONDENSE_BLOCK = 40000;
/** How much of the previous chunk whisper is given as decoder context. */
const PROMPT_CHARS = 300;

// ------------------------------------------------------------------ transcribe

/**
 * Which engine transcribes the saved recording.
 *
 * whisper.cpp whenever it is installed and the setting has not been moved off
 * it. The difference is not marginal: an audio LLM costs roughly a request per
 * chunk with a model of its own to keep loaded, so an hour of meeting takes
 * about an hour, while whisper.cpp reads the same hour in a few minutes on
 * ggml-base — and it is a purpose-built recogniser rather than a model that
 * occasionally falls into a repetition loop (hence collapseRepeats).
 *
 * It also decides how much of the app an unreachable Ollama takes down. With
 * whisper doing this pass, the daemon is only needed to write the notes — so a
 * meeting stopped with Ollama down keeps a full transcript, and the notes can be
 * generated later from the library.
 */
function transcribeEngineFor(config, whisper) {
  return config.transcribeEngine !== 'ollama' && whisper?.available ? 'whisper' : 'ollama';
}

/** What produced a transcript, as it is recorded in meta.json and the footer. */
function transcribeEngineLabel(engine, config, whisper) {
  return engine === 'whisper' ? `whisper.cpp (${path.basename(whisper.model)})` : config.transcribeModel;
}

/**
 * How long to allow one whisper request over a chunk of the saved audio.
 *
 * The live preview's minute is sized for a few seconds of speech; a chunk here
 * is a minute of it, and a large model on a modest machine can run slower than
 * realtime. Scale with the audio rather than letting a slow decode look like a
 * hung server.
 */
const whisperTimeoutMs = (seconds) => Math.max(60_000, Math.round(seconds * 15_000));

/**
 * The tracks a recording is transcribed as, in the order they are read.
 *
 * A mono file is one anonymous track. A two-channel one is the microphone and
 * the system loopback, kept apart by the capture graph and therefore already
 * separated by speaker — which is the whole reason for recording two channels.
 * Attribution used to depend on somebody saying a name out loud.
 *
 * @param {Buffer} pcm interleaved PCM straight out of the WAV
 * @param {number} channels
 * @returns {{ speaker: string, pcm: Buffer }[]}
 */
function tracksOf(pcm, channels) {
  if (channels !== 2) return [{ speaker: '', pcm }];
  const [mic, system] = deinterleave(pcm, 2);
  return [
    { speaker: 'mic', pcm: mic },
    { speaker: 'system', pcm: system },
  ];
}

/**
 * @param {object} deps
 * @param {import('./whisper').WhisperServer} [deps.whisper] when installed and
 *   configured, this transcribes instead of the Ollama audio model
 */
async function transcribe(dir, config, { onProgress, signal, ollama, whisper = null }) {
  const audioPath = path.join(dir, FILES.audio);
  const { pcm, sampleRate, channels, seconds } = readWav(audioPath);

  const engine = transcribeEngineFor(config, whisper);
  const engineLabel = transcribeEngineLabel(engine, config, whisper);
  const tracks = tracksOf(pcm, channels);
  // Chunked once, on the mix: both sides are then cut in the same place, and
  // that place is a moment when neither of them was talking. Chunking each
  // track on its own silences would put the boundaries somewhere different on
  // each, and every line's timestamp would be measured against its own grid.
  const chunks = splitIntoChunks(downmix(pcm, channels), sampleRate, config.chunkSeconds ?? 60);
  const segments = [];
  /** Tail of the last chunk *of that track*, so a split sentence keeps its context. */
  const tails = new Map(tracks.map((t) => [t.speaker, '']));

  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const chunkSeconds = c.endSeconds - c.startSeconds;
    for (const track of tracks) {
      if (signal?.aborted) throw new Error('cancelled');
      // The boundaries were found on the downmix, which is frame-for-frame the
      // same length as each track, so the offsets carry across unchanged.
      const slice = track.pcm.subarray(c.start, c.end);
      let text = '';
      // The side that was listening is silent for most of the meeting, so this
      // is what keeps two channels from costing two transcriptions.
      if (rms(slice) >= SILENCE_RMS) {
        const wav = buildWav(slice, sampleRate);
        text =
          engine === 'whisper'
            ? await whisper.transcribe(wav, {
                prompt: tails.get(track.speaker),
                signal,
                timeoutMs: whisperTimeoutMs(chunkSeconds),
              })
            : await ollama.transcribe(config.transcribeModel, wav, { signal, seconds: chunkSeconds });
        if (text) tails.set(track.speaker, text.slice(-PROMPT_CHARS));
      }
      onProgress?.({ phase: 'transcribing', done: i, total: chunks.length, text, engine, speaker: track.speaker });
      segments.push({
        index: segments.length,
        chunk: i,
        speaker: track.speaker,
        startSeconds: Math.round(c.startSeconds * 10) / 10,
        endSeconds: Math.round(c.endSeconds * 10) / 10,
        text,
      });
    }
  }
  onProgress?.({ phase: 'transcribing', done: chunks.length, total: chunks.length, engine });

  // Both sides of a chunk are timestamped to the same minute, so nothing finer
  // than the chunk decides the order — within one, the microphone goes first.
  const transcript = segments
    .filter((s) => s.text.trim())
    .map((s) => speakerLine(s.speaker, s.text.trim()))
    .join('\n\n');

  fs.writeFileSync(path.join(dir, FILES.transcript), transcript ? `${transcript}\n` : '');
  fs.writeFileSync(
    path.join(dir, FILES.transcriptJson),
    JSON.stringify(
      {
        model: engineLabel,
        engine,
        sampleRate,
        channels,
        speakers: channels === 2 ? SPEAKERS : {},
        durationSeconds: Math.round(seconds),
        segments,
      },
      null,
      2,
    ),
  );
  return { transcript, segments, durationSeconds: seconds, channels, engine, engineLabel };
}

// ------------------------------------------------------------------- summarise

const NOTES_SCHEMA = `{
  "title": "short descriptive meeting title",
  "summary": ["exactly 5 bullet strings covering what the meeting was about"],
  "decisions": [{ "decision": "what was decided", "context": "one sentence of why, or \\"\\"" }],
  "action_items": [{ "task": "what must be done", "owner": "person named, or \\"Unassigned\\"", "due": "date or timeframe stated, or \\"\\"" }]
}`;

const SUMMARY_RULES = [
  'Base every statement strictly on the transcript. Never invent people, dates, numbers or commitments.',
  'The transcript comes from automatic speech recognition and may contain errors; interpret charitably but do not fabricate.',
  'summary must contain exactly 5 bullets. If the meeting was short, keep bullets brief rather than padding with filler.',
  'Only list a decision if the transcript shows something was actually settled. An empty array is correct when nothing was decided.',
  'Only list an action item if someone is expected to do something. Set owner to the name said in the transcript, else "Unassigned".',
  'Respond with a single JSON object and nothing else. No markdown fences, no commentary.',
].join('\n');

/**
 * The extra rules a two-channel transcript earns.
 *
 * Only added when the lines are actually labelled: telling the model to read
 * speaker prefixes off a transcript that has none is an invitation to imagine
 * some, which is exactly the failure the base rules spend their length on.
 */
const SPEAKER_RULES = [
  `Every line is prefixed with who said it. "${SPEAKERS.mic}:" is the person recording this meeting; ` +
    `"${SPEAKERS.system}:" is everyone else on the call, captured together from the speakers.`,
  `An action item accepted by "${SPEAKERS.mic}" has owner "${SPEAKERS.mic}". One accepted by a named person ` +
    'takes that name. Only fall back to "Unassigned" when nobody took it on.',
  `"${SPEAKERS.system}" is several people sharing one channel, so never treat it as one person's name — ` +
    'use the name they are called by in the transcript, if there is one.',
  'Never repeat the prefixes in the notes themselves; they are transcript formatting, not content.',
].join('\n');

/**
 * @param {object} deps
 * @param {boolean} [deps.speakers] whether the transcript carries speaker labels
 */
async function summarise(dir, config, { onProgress, signal, ollama, transcript, speakers = false }) {
  onProgress?.({ phase: 'summarising' });

  let source = transcript;
  if (transcript.length > CONDENSE_THRESHOLD) {
    source = await condense(transcript, config, { ollama, signal, onProgress, speakers });
  }

  const raw = await ollama.chat(
    config.summaryModel,
    [
      {
        role: 'system',
        content:
          `You are a meticulous meeting-notes assistant.\n${SUMMARY_RULES}` +
          (speakers ? `\n${SPEAKER_RULES}` : ''),
      },
      {
        role: 'user',
        content:
          `Read the meeting transcript below and produce notes as JSON matching this shape:\n\n${NOTES_SCHEMA}\n\n` +
          `--- TRANSCRIPT START ---\n${source}\n--- TRANSCRIPT END ---`,
      },
    ],
    { signal, temperature: 0.2 },
  );

  const notes = normaliseNotes(extractJson(raw), transcript);
  fs.writeFileSync(path.join(dir, FILES.notesJson), JSON.stringify(notes, null, 2));
  return notes;
}

/** Squeezes an over-long transcript into per-block digests before the final pass. */
async function condense(transcript, config, { ollama, signal, onProgress, speakers = false }) {
  const blocks = [];
  let pos = 0;
  while (pos < transcript.length) {
    let end = Math.min(pos + CONDENSE_BLOCK, transcript.length);
    if (end < transcript.length) {
      // Prefer a paragraph boundary so a block never ends mid-sentence.
      const br = transcript.lastIndexOf('\n\n', end);
      if (br > pos + CONDENSE_BLOCK / 2) end = br;
    }
    blocks.push(transcript.slice(pos, end));
    pos = end;
  }

  const digests = [];
  for (let i = 0; i < blocks.length; i++) {
    onProgress?.({ phase: 'summarising', done: i, total: blocks.length });
    const d = await ollama.chat(
      config.summaryModel,
      [
        { role: 'system', content: 'You compress meeting transcripts without losing facts.' },
        {
          role: 'user',
          content:
            `This is part ${i + 1} of ${blocks.length} of a meeting transcript. Write a dense factual digest ` +
            'preserving every decision, commitment, owner name, date and number mentioned. Prose only, no headings.' +
            // The digest is all the final pass will see, so who committed to
            // what has to survive this step or the labels were pointless.
            (speakers
              ? `\nLines are prefixed with the speaker: "${SPEAKERS.mic}" is the person recording, ` +
                `"${SPEAKERS.system}" is everyone else. Keep track of which of them said each thing.`
              : '') +
            `\n\n${blocks[i]}`,
        },
      ],
      { signal, temperature: 0.1 },
    );
    digests.push(d.trim());
  }
  return digests.join('\n\n');
}

/** Pulls the first JSON object out of a model reply that may be fenced or chatty. */
function extractJson(raw) {
  const text = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(text);
  } catch {
    // Fall through to brace scanning.
  }
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

const str = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());

function normaliseNotes(parsed, transcript) {
  const o = parsed && typeof parsed === 'object' ? parsed : {};

  const summary = (Array.isArray(o.summary) ? o.summary : [])
    .map((b) => str(typeof b === 'object' ? (b.text ?? b.bullet ?? b.point) : b))
    .filter(Boolean)
    .slice(0, 5);

  const decisions = (Array.isArray(o.decisions) ? o.decisions : [])
    .map((d) => (typeof d === 'string' ? { decision: str(d), context: '' } : { decision: str(d?.decision ?? d?.text), context: str(d?.context ?? d?.rationale) }))
    .filter((d) => d.decision);

  const actionItems = (Array.isArray(o.action_items) ? o.action_items : Array.isArray(o.actionItems) ? o.actionItems : [])
    .map((a) =>
      typeof a === 'string'
        ? { task: str(a), owner: 'Unassigned', due: '' }
        : { task: str(a?.task ?? a?.action ?? a?.text), owner: str(a?.owner ?? a?.assignee) || 'Unassigned', due: str(a?.due ?? a?.deadline ?? a?.when) },
    )
    .filter((a) => a.task);

  return {
    title: str(o.title) || 'Meeting notes',
    summary: summary.length ? summary : transcript ? ['The model did not return a usable summary. See transcript.txt.'] : ['No speech was detected in this recording.'],
    decisions,
    action_items: actionItems,
  };
}

// -------------------------------------------------------------------- markdown

function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

/** Meta comes from disk or a re-run, so neither field is guaranteed present. */
const modelsOf = (meta) => ({
  transcribe: meta?.models?.transcribe || 'unknown',
  summary: meta?.models?.summary || 'unknown',
});

/** Formats a stored ISO timestamp, tolerating a missing or unparseable one. */
function fmtRecordedAt(startedAt) {
  const d = new Date(startedAt ?? NaN);
  return Number.isNaN(d.getTime()) ? 'date unknown' : d.toLocaleString();
}

function renderMarkdown(notes, meta) {
  const L = [`# ${notes.title}`, ''];
  L.push(`*Recorded ${fmtRecordedAt(meta.startedAt)} · ${fmtDuration(meta.durationSeconds)}*`, '');

  L.push('## Summary', '');
  for (const b of notes.summary) L.push(`- ${b}`);
  L.push('');

  L.push('## Decisions', '');
  if (notes.decisions.length) {
    for (const d of notes.decisions) L.push(`- **${d.decision}**${d.context ? ` — ${d.context}` : ''}`);
  } else {
    L.push('- *No decisions were recorded in this meeting.*');
  }
  L.push('');

  L.push('## Action items', '');
  if (notes.action_items.length) {
    for (const a of notes.action_items) {
      L.push(`- [ ] ${a.task} — **${a.owner}**${a.due ? ` *(${a.due})*` : ''}`);
    }
  } else {
    L.push('- *No action items were recorded in this meeting.*');
  }
  L.push('');

  const models = modelsOf(meta);
  L.push('---', '', `<sub>Transcribed with \`${models.transcribe}\` and summarised with \`${models.summary}\`, locally. Nothing left this machine.</sub>`, '');
  return L.join('\n');
}

// ------------------------------------------------------------------ HTML / PDF

const HTML_RULES = [
  'Return ONE complete standalone HTML document beginning with <!DOCTYPE html>.',
  'All CSS must be inline in a single <style> block. No external stylesheets, no web fonts, no images, no <script> tags, no network requests of any kind — the page is rendered offline and anything external will simply be blocked.',
  'Use only system font stacks, e.g. font-family: "Segoe UI", system-ui, sans-serif.',
  'Design it for print on US Letter: a clear title block, generous whitespace, readable 11-12pt body text, and a restrained accent colour (indigo #4F46E5) used for headings and rules.',
  'Structure: title and date header, then Summary, then Decisions, then Action items as a table with Task / Owner / Due columns.',
  'Use CSS to avoid awkward page breaks (page-break-inside: avoid on cards and table rows).',
  'Do not invent any content that is not in the JSON.',
  'Output only the HTML. No markdown fences, no explanation.',
].join('\n');

async function renderPdf(dir, config, { onProgress, signal, ollama, notes, meta }) {
  onProgress?.({ phase: 'designing' });

  let html = '';
  try {
    const raw = await ollama.chat(
      config.summaryModel,
      [
        { role: 'system', content: `You are a meticulous HTML/CSS designer producing print-ready documents.\n${HTML_RULES}` },
        {
          role: 'user',
          content:
            `Build a polished one-page meeting brief from this data.\n\n` +
            `Meeting date: ${fmtRecordedAt(meta.startedAt)}\nDuration: ${fmtDuration(meta.durationSeconds)}\n\n` +
            JSON.stringify(notes, null, 2),
        },
      ],
      { signal, temperature: 0.4 },
    );
    html = cleanHtml(raw);
  } catch (err) {
    onProgress?.({ phase: 'designing', warning: err.message });
  }

  if (!/<html[\s>]/i.test(html) || !/<\/html>/i.test(html)) {
    html = fallbackHtml(notes, meta); // Model went off-script; ship a clean document anyway.
  }

  const htmlPath = path.join(dir, FILES.html);
  const pdfPath = path.join(dir, FILES.pdf);
  fs.writeFileSync(htmlPath, html, 'utf8');

  onProgress?.({ phase: 'rendering' });
  await htmlToPdf(htmlPath, pdfPath);

  // The PDF is the last artefact the pipeline produces, so this is where the
  // folder is declared finished — and callers open Explorer on the strength of
  // it. printToPDF resolving is not proof that usable bytes reached the disk,
  // so confirm them here rather than reporting a folder that has no brief in it.
  if (!fs.existsSync(pdfPath) || fs.statSync(pdfPath).size === 0) {
    throw new Error(`PDF export produced no usable file at ${pdfPath}`);
  }

  // Only now is the HTML redundant. Deleting it unconditionally used to discard
  // the model-authored design at the exact moment a failed render made it worth
  // keeping, leaving a re-run nothing to salvage.
  fs.rmSync(htmlPath, { force: true });
  return pdfPath;
}

function cleanHtml(raw) {
  let h = String(raw).trim();
  h = h.replace(/^```(?:html)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = h.search(/<!doctype html|<html[\s>]/i);
  if (start > 0) h = h.slice(start);
  // Belt and braces: the render session blocks these anyway.
  h = h.replace(/<script\b[\s\S]*?<\/script>/gi, '');
  return h.trim();
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function fallbackHtml(notes, meta) {
  const rows = notes.action_items.length
    ? notes.action_items
        .map((a) => `<tr><td>${esc(a.task)}</td><td class="owner">${esc(a.owner)}</td><td>${esc(a.due) || '—'}</td></tr>`)
        .join('\n      ')
    : '<tr><td colspan="3" class="empty">No action items were recorded.</td></tr>';

  const decisions = notes.decisions.length
    ? notes.decisions
        .map((d) => `<li><strong>${esc(d.decision)}</strong>${d.context ? `<span> — ${esc(d.context)}</span>` : ''}</li>`)
        .join('\n      ')
    : '<li class="empty">No decisions were recorded.</li>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(notes.title)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", system-ui, sans-serif; color: #1e1b30; margin: 0; padding: 8px 4px; font-size: 11.5pt; line-height: 1.55; }
  header { border-bottom: 3px solid #4F46E5; padding-bottom: 14px; margin-bottom: 26px; }
  h1 { font-size: 23pt; margin: 0 0 6px; letter-spacing: -0.02em; color: #312e81; }
  .meta { color: #6b7280; font-size: 10pt; }
  h2 { font-size: 12pt; text-transform: uppercase; letter-spacing: .09em; color: #4F46E5; margin: 28px 0 12px; }
  ul { margin: 0; padding-left: 20px; }
  li { margin-bottom: 9px; page-break-inside: avoid; }
  li span { color: #4b5563; }
  table { width: 100%; border-collapse: collapse; margin-top: 4px; }
  th { text-align: left; font-size: 9pt; text-transform: uppercase; letter-spacing: .07em; color: #6b7280; border-bottom: 2px solid #e5e7eb; padding: 0 10px 7px 0; }
  td { padding: 10px 10px 10px 0; border-bottom: 1px solid #f1f1f5; vertical-align: top; page-break-inside: avoid; }
  td.owner { font-weight: 600; white-space: nowrap; }
  .empty { color: #9ca3af; font-style: italic; }
  footer { margin-top: 34px; padding-top: 12px; border-top: 1px solid #e5e7eb; color: #9ca3af; font-size: 8.5pt; }
</style>
</head>
<body>
  <header>
    <h1>${esc(notes.title)}</h1>
    <div class="meta">${esc(fmtRecordedAt(meta.startedAt))} · ${esc(fmtDuration(meta.durationSeconds))}</div>
  </header>

  <h2>Summary</h2>
  <ul>
      ${notes.summary.map((b) => `<li>${esc(b)}</li>`).join('\n      ')}
  </ul>

  <h2>Decisions</h2>
  <ul>
      ${decisions}
  </ul>

  <h2>Action items</h2>
  <table>
    <thead><tr><th>Task</th><th>Owner</th><th>Due</th></tr></thead>
    <tbody>
      ${rows}
    </tbody>
  </table>

  <footer>Transcribed and summarised on this machine (${esc(modelsOf(meta).transcribe)} / ${esc(modelsOf(meta).summary)}). Nothing left it.</footer>
</body>
</html>`;
}

// ----------------------------------------------------------------- entry point

/** Fails a run before, or between, the stages that cannot proceed without Ollama. */
async function requireOllama(ollama, config, what) {
  if (await ollama.isUp()) return;
  throw new Error(
    `Ollama is not reachable at ${config.ollamaHost}, so Minarrador cannot ${what}. ` +
      'Start it from Settings → Open Ollama, then generate the notes for this recording again.',
  );
}

/**
 * Runs the full post-recording chain over a meeting folder that already
 * contains audio.wav.
 *
 * @param {{ whisper?: import('./whisper').WhisperServer }} [options] `whisper`
 *   offers the local recogniser for the transcription stage; without it the
 *   Ollama audio model does that pass too.
 */
async function runPipeline(dir, config, { onProgress, signal, meta: metaIn, whisper = null } = {}) {
  const ollama = new Ollama(config.ollamaHost);
  const engine = transcribeEngineFor(config, whisper);

  // Ollama writes the notes whichever engine reads the audio, so an unreachable
  // daemon fails the run in the end either way — but where it fails decides what
  // survives. Checked up front only when Ollama is also the transcriber, so an
  // hour of transcription is never spent on a run that was doomed at the start;
  // checked again after it, because whisper.cpp can take that hour and the
  // daemon may have gone away during it. In between, transcript.txt is already
  // on disk.
  if (engine === 'ollama') await requireOllama(ollama, config, 'transcribe this recording');

  const meta = {
    version: 1,
    startedAt: new Date().toISOString(),
    durationSeconds: 0,
    sources: {},
    ...(metaIn ?? {}),
    models: { transcribe: transcribeEngineLabel(engine, config, whisper), summary: config.summaryModel },
  };

  const { transcript, durationSeconds, channels } = await transcribe(dir, config, {
    onProgress,
    signal,
    ollama,
    whisper,
  });
  meta.durationSeconds = meta.durationSeconds || durationSeconds;
  // What the audio turned out to be, rather than what the recorder intended:
  // this folder may have been recorded by an older version, or by hand.
  meta.channels = channels;

  await requireOllama(ollama, config, 'write the notes');

  const notes = await summarise(dir, config, {
    onProgress,
    signal,
    ollama,
    transcript,
    speakers: channels === 2,
  });

  // notes.json keeps what the model produced; everything a person reads gets
  // the title they typed, if they typed one. Applied here rather than inside
  // summarise so the override survives a re-run without being written back into
  // the model's own output.
  const titled = { ...notes, title: readTitle(dir) || notes.title };
  fs.writeFileSync(path.join(dir, FILES.notes), renderMarkdown(titled, meta));

  const pdfPath = await renderPdf(dir, config, { onProgress, signal, ollama, notes: titled, meta });

  meta.completedAt = new Date().toISOString();
  meta.files = Object.values(FILES).filter((f) => f !== FILES.html && fs.existsSync(path.join(dir, f)));
  // A title the user typed is theirs, not this run's to overwrite — but it is
  // worth recording that one is in force, so meta.json still describes the
  // folder as it reads.
  meta.title = readTitle(dir) || notes.title;
  fs.writeFileSync(path.join(dir, FILES.meta), JSON.stringify(meta, null, 2));

  onProgress?.({ phase: 'done' });
  return { dir, notes, pdfPath, transcriptLength: transcript.length };
}

module.exports = {
  runPipeline,
  transcribe,
  tracksOf,
  transcribeEngineFor,
  transcribeEngineLabel,
  summarise,
  renderPdf,
  renderMarkdown,
  extractJson,
  normaliseNotes,
  fmtDuration,
  fallbackHtml,
};
