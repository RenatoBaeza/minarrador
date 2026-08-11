'use strict';

// Everything that happens after Stop: transcribe -> summarise -> PDF.
// Each step writes its artefact to the meeting folder before the next begins,
// so a failure late in the chain never costs you the earlier work.

const fs = require('node:fs');
const path = require('node:path');

const { Ollama } = require('./ollama');
const { readWav, buildWav, splitIntoChunks, rms } = require('./wav');
const { htmlToPdf } = require('./pdf');
const { FILES } = require('./paths');

/** Chunks quieter than this are almost certainly room tone; skip them. */
const SILENCE_RMS = 0.004;
/** Above this many characters we summarise in passes instead of one shot. */
const CONDENSE_THRESHOLD = 48000;
const CONDENSE_BLOCK = 40000;

// ------------------------------------------------------------------ transcribe

async function transcribe(dir, config, { onProgress, signal, ollama }) {
  const audioPath = path.join(dir, FILES.audio);
  const { pcm, sampleRate, seconds } = readWav(audioPath);

  const chunks = splitIntoChunks(pcm, sampleRate, config.chunkSeconds ?? 60);
  const segments = [];

  for (let i = 0; i < chunks.length; i++) {
    if (signal?.aborted) throw new Error('cancelled');
    const c = chunks[i];
    let text = '';
    if (rms(c.pcm) >= SILENCE_RMS) {
      text = await ollama.transcribe(config.transcribeModel, buildWav(c.pcm, sampleRate), {
        signal,
        seconds: c.endSeconds - c.startSeconds,
      });
    }
    onProgress?.({ phase: 'transcribing', done: i, total: chunks.length, text });
    segments.push({
      index: i,
      startSeconds: Math.round(c.startSeconds * 10) / 10,
      endSeconds: Math.round(c.endSeconds * 10) / 10,
      text,
    });
  }
  onProgress?.({ phase: 'transcribing', done: chunks.length, total: chunks.length });

  const transcript = segments
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join('\n\n');

  fs.writeFileSync(path.join(dir, FILES.transcript), transcript ? `${transcript}\n` : '');
  fs.writeFileSync(
    path.join(dir, FILES.transcriptJson),
    JSON.stringify({ model: config.transcribeModel, sampleRate, durationSeconds: Math.round(seconds), segments }, null, 2),
  );
  return { transcript, segments, durationSeconds: seconds };
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

async function summarise(dir, config, { onProgress, signal, ollama, transcript }) {
  onProgress?.({ phase: 'summarising' });

  let source = transcript;
  if (transcript.length > CONDENSE_THRESHOLD) {
    source = await condense(transcript, config, { ollama, signal, onProgress });
  }

  const raw = await ollama.chat(
    config.summaryModel,
    [
      { role: 'system', content: `You are a meticulous meeting-notes assistant.\n${SUMMARY_RULES}` },
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
async function condense(transcript, config, { ollama, signal, onProgress }) {
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
            'preserving every decision, commitment, owner name, date and number mentioned. Prose only, no headings.\n\n' +
            blocks[i],
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

function renderMarkdown(notes, meta) {
  const L = [`# ${notes.title}`, ''];
  L.push(`*Recorded ${new Date(meta.startedAt).toLocaleString()} · ${fmtDuration(meta.durationSeconds)}*`, '');

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

  L.push('---', '', `<sub>Transcribed with \`${meta.models.transcribe}\` and summarised with \`${meta.models.summary}\` locally via Ollama. Nothing left this machine.</sub>`, '');
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
            `Meeting date: ${new Date(meta.startedAt).toLocaleString()}\nDuration: ${fmtDuration(meta.durationSeconds)}\n\n` +
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
  try {
    await htmlToPdf(htmlPath, pdfPath);
  } finally {
    // The HTML is an intermediate artefact; the PDF is the deliverable.
    fs.rmSync(htmlPath, { force: true });
  }
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
    <div class="meta">${esc(new Date(meta.startedAt).toLocaleString())} · ${esc(fmtDuration(meta.durationSeconds))}</div>
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

  <footer>Transcribed and summarised locally with Ollama (${esc(meta.models.transcribe)} / ${esc(meta.models.summary)}). Nothing left this machine.</footer>
</body>
</html>`;
}

// ----------------------------------------------------------------- entry point

/**
 * Runs the full post-recording chain over a meeting folder that already
 * contains audio.wav.
 */
async function runPipeline(dir, config, { onProgress, signal, meta: metaIn } = {}) {
  const ollama = new Ollama(config.ollamaHost);
  if (!(await ollama.isUp())) {
    throw new Error(`Ollama is not reachable at ${config.ollamaHost}. Start it with "ollama serve" and re-run notes for this folder.`);
  }

  const meta = {
    version: 1,
    startedAt: new Date().toISOString(),
    durationSeconds: 0,
    sources: {},
    ...(metaIn ?? {}),
    models: { transcribe: config.transcribeModel, summary: config.summaryModel },
  };

  const { transcript, durationSeconds } = await transcribe(dir, config, { onProgress, signal, ollama });
  meta.durationSeconds = meta.durationSeconds || durationSeconds;

  const notes = await summarise(dir, config, { onProgress, signal, ollama, transcript });
  fs.writeFileSync(path.join(dir, FILES.notes), renderMarkdown(notes, meta));

  const pdfPath = await renderPdf(dir, config, { onProgress, signal, ollama, notes, meta });

  meta.completedAt = new Date().toISOString();
  meta.files = Object.values(FILES).filter((f) => f !== FILES.html && fs.existsSync(path.join(dir, f)));
  fs.writeFileSync(path.join(dir, FILES.meta), JSON.stringify(meta, null, 2));

  onProgress?.({ phase: 'done' });
  return { dir, notes, pdfPath, transcriptLength: transcript.length };
}

module.exports = { runPipeline, transcribe, summarise, renderPdf, renderMarkdown, extractJson, normaliseNotes, fmtDuration, fallbackHtml };
