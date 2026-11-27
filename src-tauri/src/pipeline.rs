//! Everything that happens after Stop: transcribe → summarise → PDF.
//!
//! Each step writes its artefact to the meeting folder before the next begins,
//! so a failure late in the chain never costs the earlier work. The engines are
//! handed in as closures, so every stage can be exercised without a model.

use std::fs;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tokio_util::sync::CancellationToken;

use crate::ollama::ChatMessage;
use crate::paths::{self, speaker_line, SPEAKER_MIC, SPEAKER_SYSTEM};
use crate::types::{ActionItem, Decision, Engine, Speaker};
use crate::wav::{self, build_wav, deinterleave, downmix, rms, split_into_chunks};

pub type BoxFut<T> = Pin<Box<dyn Future<Output = T> + Send>>;
/// (wav, prompt tail, seconds) → text
pub type AsrFn = Arc<dyn Fn(Vec<u8>, String, f64) -> BoxFut<Result<String, String>> + Send + Sync>;
/// (messages, temperature) → reply
pub type ChatFn = Arc<dyn Fn(Vec<ChatMessage>, f64) -> BoxFut<Result<String, String>> + Send + Sync>;
/// (html file, pdf file)
pub type PdfFn = Arc<dyn Fn(PathBuf, PathBuf) -> BoxFut<Result<(), String>> + Send + Sync>;
/// "is Ollama answering?"
pub type UpFn = Arc<dyn Fn() -> BoxFut<bool> + Send + Sync>;

/// Chunks quieter than this are room tone; skip them.
const SILENCE_RMS: f64 = 0.004;
/// Above this many characters the transcript is condensed in passes first.
const CONDENSE_THRESHOLD: usize = 48_000;
const CONDENSE_BLOCK: usize = 40_000;
/// How much of the previous chunk is handed on as decoder context.
const PROMPT_CHARS: usize = 300;

#[derive(Debug, Clone, Default)]
pub struct Progress {
    pub phase: &'static str,
    pub done: u64,
    pub total: u64,
    pub warning: Option<String>,
}

pub type ProgressFn = Arc<dyn Fn(Progress) + Send + Sync>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub index: usize,
    pub chunk: usize,
    pub speaker: Speaker,
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MeetingNotes {
    pub title: String,
    pub summary: Vec<String>,
    pub decisions: Vec<Decision>,
    pub action_items: Vec<ActionItem>,
}

pub struct TranscribeResult {
    pub transcript: String,
    pub segments: Vec<Segment>,
    pub duration_seconds: f64,
    pub channels: u16,
}

/// Which engine writes the saved transcript: whisper.cpp whenever installed
/// and not switched off, else the Ollama audio model.
pub fn transcribe_engine_for(setting: &str, whisper_available: bool) -> Engine {
    if setting != "ollama" && whisper_available { Engine::Whisper } else { Engine::Ollama }
}

/// One track per side of the conversation, or the single mono track.
pub fn tracks_of(pcm: &[i16], channels: u16) -> Vec<(Speaker, Vec<i16>)> {
    if channels != 2 {
        return vec![(Speaker::None, pcm.to_vec())];
    }
    let mut sides = deinterleave(pcm, 2).into_iter();
    let mic = sides.next().unwrap_or_default();
    let system = sides.next().unwrap_or_default();
    vec![(Speaker::Mic, mic), (Speaker::System, system)]
}

fn tail_chars(s: &str, n: usize) -> String {
    let count = s.chars().count();
    s.chars().skip(count.saturating_sub(n)).collect()
}

fn round1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

/// Reads the WAV in chunks cut once on the downmix, each side keeping its own
/// prompt tail, and writes transcript.txt and transcript.json.
pub async fn transcribe(
    dir: &Path,
    chunk_seconds: u32,
    engine: Engine,
    engine_label: &str,
    asr: &AsrFn,
    progress: &ProgressFn,
    cancel: &CancellationToken,
) -> Result<TranscribeResult, String> {
    let audio = dir.join(paths::AUDIO);
    let chunk_secs = chunk_seconds as f64;
    let (data, tracks, chunks) = tokio::task::spawn_blocking(move || -> Result<_, String> {
        let data = wav::read_wav(&audio)?;
        let tracks = tracks_of(&data.pcm, data.channels);
        let chunks = split_into_chunks(&downmix(&data.pcm, data.channels), data.sample_rate, chunk_secs, 4.0);
        Ok((wav::WavData { pcm: vec![], ..data }, tracks, chunks))
    })
    .await
    .map_err(|e| e.to_string())??;

    let mut segments: Vec<Segment> = vec![];
    let mut tails: Vec<String> = vec![String::new(); tracks.len()];
    let total = chunks.len() as u64;
    for (i, c) in chunks.iter().enumerate() {
        let seconds = c.end_seconds - c.start_seconds;
        for (t, (speaker, pcm)) in tracks.iter().enumerate() {
            if cancel.is_cancelled() {
                return Err("cancelled".into());
            }
            let slice = &pcm[c.start.min(pcm.len())..c.end.min(pcm.len())];
            let mut text = String::new();
            if rms(slice) >= SILENCE_RMS {
                let wav = build_wav(slice, data.sample_rate, 1);
                text = asr(wav, tails[t].clone(), seconds).await?;
                if !text.is_empty() {
                    tails[t] = tail_chars(&text, PROMPT_CHARS);
                }
            }
            progress(Progress { phase: "transcribing", done: i as u64, total, warning: None });
            segments.push(Segment {
                index: segments.len(),
                chunk: i,
                speaker: *speaker,
                start_seconds: round1(c.start_seconds),
                end_seconds: round1(c.end_seconds),
                text,
            });
        }
    }
    progress(Progress { phase: "transcribing", done: total, total, warning: None });

    let transcript = segments
        .iter()
        .filter(|s| !s.text.trim().is_empty())
        .map(|s| speaker_line(s.speaker, s.text.trim()))
        .collect::<Vec<_>>()
        .join("\n\n");
    fs::write(dir.join(paths::TRANSCRIPT), if transcript.is_empty() { String::new() } else { format!("{transcript}\n") })
        .map_err(|e| e.to_string())?;
    let speakers = if data.channels == 2 { json!({ "mic": SPEAKER_MIC, "system": SPEAKER_SYSTEM }) } else { json!({}) };
    let doc = json!({
        "model": engine_label,
        "engine": engine.as_str(),
        "sampleRate": data.sample_rate,
        "channels": data.channels,
        "speakers": speakers,
        "durationSeconds": data.seconds.round(),
        "segments": segments,
    });
    fs::write(dir.join(paths::TRANSCRIPT_JSON), serde_json::to_string_pretty(&doc).unwrap_or_default())
        .map_err(|e| e.to_string())?;
    Ok(TranscribeResult { transcript, segments, duration_seconds: data.seconds, channels: data.channels })
}

const NOTES_SCHEMA: &str = r#"{
  "title": "short descriptive meeting title",
  "summary": ["exactly 5 bullet strings covering what the meeting was about"],
  "decisions": [{ "decision": "what was decided", "context": "one sentence of why, or \"\"" }],
  "action_items": [{ "task": "what must be done", "owner": "person named, or \"Unassigned\"", "due": "date or timeframe stated, or \"\"" }]
}"#;

const SUMMARY_RULES: &str = "Base every statement strictly on the transcript. Never invent people, dates, numbers or commitments.
The transcript comes from automatic speech recognition and may contain errors; interpret charitably but do not fabricate.
summary must contain exactly 5 bullets. If the meeting was short, keep bullets brief rather than padding with filler.
Only list a decision if the transcript shows something was actually settled. An empty array is correct when nothing was decided.
Only list an action item if someone is expected to do something. Set owner to the name said in the transcript, else \"Unassigned\".
Respond with a single JSON object and nothing else. No markdown fences, no commentary.";

fn speaker_rules() -> String {
    format!(
        "Every line is prefixed with who said it. \"{m}:\" is the person recording this meeting; \"{s}:\" is everyone else on the call, captured together from the speakers.
An action item accepted by \"{m}\" has owner \"{m}\". One accepted by a named person takes that name. Only fall back to \"Unassigned\" when nobody took it on.
\"{s}\" is several people sharing one channel, so never treat it as one person's name — use the name they are called by in the transcript, if there is one.
Never repeat the prefixes in the notes themselves; they are transcript formatting, not content.",
        m = SPEAKER_MIC,
        s = SPEAKER_SYSTEM
    )
}

/// Writes notes.json from the transcript, condensing a long one first.
pub async fn summarise(dir: &Path, transcript: &str, speakers: bool, chat: &ChatFn, progress: &ProgressFn) -> Result<MeetingNotes, String> {
    progress(Progress { phase: "summarising", ..Default::default() });
    let source = if transcript.len() > CONDENSE_THRESHOLD {
        condense(transcript, speakers, chat, progress).await?
    } else {
        transcript.to_string()
    };
    let system = format!(
        "You are a meticulous meeting-notes assistant.\n{SUMMARY_RULES}{}",
        if speakers { format!("\n{}", speaker_rules()) } else { String::new() }
    );
    let user = format!(
        "Read the meeting transcript below and produce notes as JSON matching this shape:\n\n{NOTES_SCHEMA}\n\n--- TRANSCRIPT START ---\n{source}\n--- TRANSCRIPT END ---"
    );
    let raw = chat(vec![ChatMessage::system(system), ChatMessage::user(user)], 0.2).await?;
    let notes = normalise_notes(&extract_json(&raw), transcript);
    fs::write(dir.join(paths::NOTES_JSON), serde_json::to_string_pretty(&notes).unwrap_or_default()).map_err(|e| e.to_string())?;
    Ok(notes)
}

fn floor_char(s: &str, mut i: usize) -> usize {
    i = i.min(s.len());
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

async fn condense(transcript: &str, speakers: bool, chat: &ChatFn, progress: &ProgressFn) -> Result<String, String> {
    let mut blocks = vec![];
    let mut pos = 0;
    while pos < transcript.len() {
        let mut end = floor_char(transcript, pos + CONDENSE_BLOCK);
        if end < transcript.len() {
            if let Some(br) = transcript[..end].rfind("\n\n") {
                if br > pos + CONDENSE_BLOCK / 2 {
                    end = br;
                }
            }
        }
        if end <= pos {
            end = transcript.len();
        }
        blocks.push(&transcript[pos..end]);
        pos = end;
    }
    let mut digests = vec![];
    for (i, block) in blocks.iter().enumerate() {
        progress(Progress { phase: "summarising", done: i as u64, total: blocks.len() as u64, warning: None });
        let who = if speakers {
            format!(
                "\nLines are prefixed with the speaker: \"{SPEAKER_MIC}\" is the person recording, \"{SPEAKER_SYSTEM}\" is everyone else. Keep track of which of them said each thing."
            )
        } else {
            String::new()
        };
        let user = format!(
            "This is part {} of {} of a meeting transcript. Write a dense factual digest preserving every decision, commitment, owner name, date and number mentioned. Prose only, no headings.{who}\n\n{block}",
            i + 1,
            blocks.len()
        );
        let d = chat(vec![ChatMessage::system("You compress meeting transcripts without losing facts."), ChatMessage::user(user)], 0.1).await?;
        digests.push(d.trim().to_string());
    }
    Ok(digests.join("\n\n"))
}

/// The first JSON object in a model reply, fenced or not.
pub fn extract_json(raw: &str) -> Value {
    let mut text = raw.trim();
    if let Some(rest) = text.strip_prefix("```json").or_else(|| text.strip_prefix("```JSON")).or_else(|| text.strip_prefix("```")) {
        text = rest.trim_start();
    }
    let text = text.trim_end().trim_end_matches("```").trim();
    if let Ok(v) = serde_json::from_str::<Value>(text) {
        return v;
    }
    let Some(start) = text.find('{') else { return Value::Null };
    let (mut depth, mut in_str, mut esc) = (0i32, false, false);
    for (i, ch) in text[start..].char_indices() {
        if in_str {
            if esc {
                esc = false;
            } else if ch == '\\' {
                esc = true;
            } else if ch == '"' {
                in_str = false;
            }
            continue;
        }
        match ch {
            '"' => in_str = true,
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return serde_json::from_str(&text[start..start + i + 1]).unwrap_or(Value::Null);
                }
            }
            _ => {}
        }
    }
    Value::Null
}

fn s(v: &Value) -> String {
    match v {
        Value::String(x) => x.trim().to_string(),
        Value::Null => String::new(),
        other => other.to_string().trim().to_string(),
    }
}

fn first<'a>(o: &'a Value, keys: &[&str]) -> &'a Value {
    keys.iter().map(|k| &o[*k]).find(|v| !v.is_null()).unwrap_or(&Value::Null)
}

/// Whatever the model returned, coerced into notes the reader can render.
pub fn normalise_notes(parsed: &Value, transcript: &str) -> MeetingNotes {
    let arr = |key: &str| parsed[key].as_array().cloned().unwrap_or_default();
    let summary: Vec<String> = arr("summary")
        .iter()
        .map(|b| if b.is_object() { s(first(b, &["text", "bullet", "point"])) } else { s(b) })
        .filter(|b| !b.is_empty())
        .take(5)
        .collect();
    let decisions = arr("decisions")
        .iter()
        .map(|d| match d {
            Value::String(x) => Decision { decision: x.trim().into(), context: String::new() },
            _ => Decision { decision: s(first(d, &["decision", "text"])), context: s(first(d, &["context", "rationale"])) },
        })
        .filter(|d| !d.decision.is_empty())
        .collect();
    let raw_items = parsed["action_items"].as_array().or_else(|| parsed["actionItems"].as_array()).cloned().unwrap_or_default();
    let action_items = raw_items
        .iter()
        .map(|a| match a {
            Value::String(x) => ActionItem { task: x.trim().into(), owner: "Unassigned".into(), due: String::new() },
            _ => {
                let owner = s(first(a, &["owner", "assignee"]));
                ActionItem {
                    task: s(first(a, &["task", "action", "text"])),
                    owner: if owner.is_empty() { "Unassigned".into() } else { owner },
                    due: s(first(a, &["due", "deadline", "when"])),
                }
            }
        })
        .filter(|a| !a.task.is_empty())
        .collect();
    let title = s(&parsed["title"]);
    MeetingNotes {
        title: if title.is_empty() { "Meeting notes".into() } else { title },
        summary: if !summary.is_empty() {
            summary
        } else if !transcript.is_empty() {
            vec!["The model did not return a usable summary. See transcript.txt.".into()]
        } else {
            vec!["No speech was detected in this recording.".into()]
        },
        decisions,
        action_items,
    }
}

pub fn fmt_duration(seconds: f64) -> String {
    let s = seconds.max(0.0).round() as u64;
    let (h, m) = (s / 3600, (s % 3600) / 60);
    if h > 0 {
        format!("{h}h {m}m")
    } else if m > 0 {
        format!("{m}m {}s", s % 60)
    } else {
        format!("{s}s")
    }
}

fn meta_str(meta: &Map<String, Value>, path: &[&str]) -> String {
    let mut v = meta.get(path[0]).unwrap_or(&Value::Null);
    for k in &path[1..] {
        v = &v[*k];
    }
    v.as_str().unwrap_or("").to_string()
}

fn models_of(meta: &Map<String, Value>) -> (String, String) {
    let t = meta_str(meta, &["models", "transcribe"]);
    let m = meta_str(meta, &["models", "summary"]);
    (if t.is_empty() { "unknown".into() } else { t }, if m.is_empty() { "unknown".into() } else { m })
}

fn fmt_recorded_at(meta: &Map<String, Value>) -> String {
    chrono::DateTime::parse_from_rfc3339(&meta_str(meta, &["startedAt"]))
        .map(|d| d.with_timezone(&chrono::Local).format("%-d %b %Y, %H:%M").to_string())
        .unwrap_or_else(|_| "date unknown".into())
}

fn duration_of(meta: &Map<String, Value>) -> f64 {
    meta.get("durationSeconds").and_then(Value::as_f64).unwrap_or(0.0)
}

pub fn render_markdown(notes: &MeetingNotes, meta: &Map<String, Value>) -> String {
    let mut l = vec![format!("# {}", notes.title), String::new()];
    l.push(format!("*Recorded {} · {}*", fmt_recorded_at(meta), fmt_duration(duration_of(meta))));
    l.extend([String::new(), "## Summary".into(), String::new()]);
    l.extend(notes.summary.iter().map(|b| format!("- {b}")));
    l.extend([String::new(), "## Decisions".into(), String::new()]);
    if notes.decisions.is_empty() {
        l.push("- *No decisions were recorded in this meeting.*".into());
    }
    for d in &notes.decisions {
        l.push(format!("- **{}**{}", d.decision, if d.context.is_empty() { String::new() } else { format!(" — {}", d.context) }));
    }
    l.extend([String::new(), "## Action items".into(), String::new()]);
    if notes.action_items.is_empty() {
        l.push("- *No action items were recorded in this meeting.*".into());
    }
    for a in &notes.action_items {
        l.push(format!("- [ ] {} — **{}**{}", a.task, a.owner, if a.due.is_empty() { String::new() } else { format!(" *({})*", a.due) }));
    }
    let (t, m) = models_of(meta);
    l.extend([
        String::new(),
        "---".into(),
        String::new(),
        format!("<sub>Transcribed with `{t}` and summarised with `{m}`, locally. Nothing left this machine.</sub>"),
        String::new(),
    ]);
    l.join("\n")
}

const HTML_RULES: &str = "Return ONE complete standalone HTML document beginning with <!DOCTYPE html>.
All CSS must be inline in a single <style> block. No external stylesheets, no web fonts, no images, no <script> tags, no network requests of any kind — the page is rendered offline and anything external will simply be blocked.
Use only system font stacks, e.g. font-family: \"Segoe UI\", system-ui, sans-serif.
Design it for print on US Letter: a clear title block, generous whitespace, readable 11-12pt body text, and a restrained accent colour (indigo #4F46E5) used for headings and rules.
Structure: title and date header, then Summary, then Decisions, then Action items as a table with Task / Owner / Due columns.
Use CSS to avoid awkward page breaks (page-break-inside: avoid on cards and table rows).
Do not invent any content that is not in the JSON.
Output only the HTML. No markdown fences, no explanation.";

pub fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn clean_html(raw: &str) -> String {
    let mut h = raw.trim();
    for fence in ["```html", "```HTML", "```"] {
        if let Some(rest) = h.strip_prefix(fence) {
            h = rest;
            break;
        }
    }
    let h = h.trim_end().trim_end_matches("```").trim();
    let lower = h.to_lowercase();
    let start = [lower.find("<!doctype html"), lower.find("<html")].into_iter().flatten().min().unwrap_or(0);
    let mut out = h[start..].to_string();
    let re = regex::Regex::new(r"(?is)<script\b.*?</script>").unwrap();
    out = re.replace_all(&out, "").to_string();
    out.trim().to_string()
}

fn fmt_offset(seconds: f64) -> String {
    let t = seconds.max(0.0).floor() as u64;
    let (h, m, s) = (t / 3600, (t % 3600) / 60, t % 60);
    if h > 0 { format!("{h}:{m:02}:{s:02}") } else { format!("{m}:{s:02}") }
}

/// The full transcript, built in code from transcript.json — never passed
/// through the model, so it is neither paraphrased nor a burden on the prompt.
fn transcript_html(dir: &Path) -> String {
    let mut lines: Vec<(String, String, String)> = vec![];
    let parsed = fs::read_to_string(dir.join(paths::TRANSCRIPT_JSON)).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok());
    if let Some(segs) = parsed.as_ref().and_then(|p| p["segments"].as_array()) {
        for seg in segs {
            let text = seg["text"].as_str().unwrap_or("").trim();
            if text.is_empty() {
                continue;
            }
            let who = paths::speaker_name(Speaker::parse(seg["speaker"].as_str().unwrap_or(""))).unwrap_or("");
            lines.push((fmt_offset(seg["startSeconds"].as_f64().unwrap_or(0.0)), who.into(), text.into()));
        }
    } else if let Ok(t) = fs::read_to_string(dir.join(paths::TRANSCRIPT)) {
        for block in t.split("\n\n").map(str::trim).filter(|b| !b.is_empty()) {
            lines.push((String::new(), String::new(), block.into()));
        }
    }
    if lines.is_empty() {
        return String::new();
    }
    let rows = lines
        .iter()
        .map(|(at, who, text)| {
            format!(
                "<p>{}{}{}</p>",
                if at.is_empty() { String::new() } else { format!("<span class=\"mn-at\">{}</span>", esc(at)) },
                if who.is_empty() { String::new() } else { format!("<span class=\"mn-who\">{}</span>", esc(who)) },
                esc(text)
            )
        })
        .collect::<Vec<_>>()
        .join("\n    ");
    format!(
        r#"
<section class="mn-transcript">
  <style>
    .mn-transcript {{ page-break-before: always; break-before: page; font-family: "Segoe UI", system-ui, sans-serif; color: #1e1b30; font-size: 10pt; line-height: 1.5; }}
    .mn-transcript h2 {{ font-size: 12pt; text-transform: uppercase; letter-spacing: .09em; color: #4F46E5; margin: 0 0 14px; padding-bottom: 8px; border-bottom: 2px solid #e5e7eb; }}
    .mn-transcript p {{ margin: 0 0 8px; }}
    .mn-transcript .mn-at {{ color: #9ca3af; font-size: 8.5pt; font-variant-numeric: tabular-nums; margin-right: 8px; }}
    .mn-transcript .mn-who {{ font-weight: 600; color: #312e81; margin-right: 6px; }}
    .mn-transcript .mn-who::after {{ content: ":"; }}
  </style>
  <h2>Full transcript</h2>
    {rows}
</section>
"#
    )
}

fn insert_before_last(html: &str, tag: &str, section: &str) -> Option<String> {
    let at = html.to_lowercase().rfind(tag)?;
    Some(format!("{}{}{}", &html[..at], section, &html[at..]))
}

/// The page is rendered offline: a CSP in the head blocks anything a model
/// might still have put in it that reaches for the network.
const OFFLINE_CSP: &str =
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:\">";

pub fn finish_html(html: &str, transcript: &str) -> String {
    let mut out = if transcript.is_empty() {
        html.to_string()
    } else {
        insert_before_last(html, "</body>", transcript)
            .or_else(|| insert_before_last(html, "</html>", transcript))
            .unwrap_or_else(|| format!("{html}{transcript}"))
    };
    let lower = out.to_lowercase();
    if let Some(head) = lower.find("<head>") {
        out.insert_str(head + 6, OFFLINE_CSP);
    } else if let Some(html_at) = lower.find("<html") {
        if let Some(close) = out[html_at..].find('>') {
            out.insert_str(html_at + close + 1, &format!("<head>{OFFLINE_CSP}</head>"));
        }
    }
    out
}

pub fn fallback_html(notes: &MeetingNotes, meta: &Map<String, Value>) -> String {
    let rows = if notes.action_items.is_empty() {
        "<tr><td colspan=\"3\" class=\"empty\">No action items were recorded.</td></tr>".to_string()
    } else {
        notes
            .action_items
            .iter()
            .map(|a| {
                format!(
                    "<tr><td>{}</td><td class=\"owner\">{}</td><td>{}</td></tr>",
                    esc(&a.task),
                    esc(&a.owner),
                    if a.due.is_empty() { "—".to_string() } else { esc(&a.due) }
                )
            })
            .collect::<Vec<_>>()
            .join("\n      ")
    };
    let decisions = if notes.decisions.is_empty() {
        "<li class=\"empty\">No decisions were recorded.</li>".to_string()
    } else {
        notes
            .decisions
            .iter()
            .map(|d| {
                format!(
                    "<li><strong>{}</strong>{}</li>",
                    esc(&d.decision),
                    if d.context.is_empty() { String::new() } else { format!("<span> — {}</span>", esc(&d.context)) }
                )
            })
            .collect::<Vec<_>>()
            .join("\n      ")
    };
    let summary = notes.summary.iter().map(|b| format!("<li>{}</li>", esc(b))).collect::<Vec<_>>().join("\n      ");
    let (t, m) = models_of(meta);
    format!(
        r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{title}</title>
<style>
  * {{ box-sizing: border-box; }}
  body {{ font-family: "Segoe UI", system-ui, sans-serif; color: #1e1b30; margin: 0; padding: 8px 4px; font-size: 11.5pt; line-height: 1.55; }}
  header {{ border-bottom: 3px solid #4F46E5; padding-bottom: 14px; margin-bottom: 26px; }}
  h1 {{ font-size: 23pt; margin: 0 0 6px; letter-spacing: -0.02em; color: #312e81; }}
  .meta {{ color: #6b7280; font-size: 10pt; }}
  h2 {{ font-size: 12pt; text-transform: uppercase; letter-spacing: .09em; color: #4F46E5; margin: 28px 0 12px; }}
  ul {{ margin: 0; padding-left: 20px; }}
  li {{ margin-bottom: 9px; page-break-inside: avoid; }}
  li span {{ color: #4b5563; }}
  table {{ width: 100%; border-collapse: collapse; margin-top: 4px; }}
  th {{ text-align: left; font-size: 9pt; text-transform: uppercase; letter-spacing: .07em; color: #6b7280; border-bottom: 2px solid #e5e7eb; padding: 0 10px 7px 0; }}
  td {{ padding: 10px 10px 10px 0; border-bottom: 1px solid #f1f1f5; vertical-align: top; page-break-inside: avoid; }}
  td.owner {{ font-weight: 600; white-space: nowrap; }}
  .empty {{ color: #9ca3af; font-style: italic; }}
  footer {{ margin-top: 34px; padding-top: 12px; border-top: 1px solid #e5e7eb; color: #9ca3af; font-size: 8.5pt; }}
</style>
</head>
<body>
  <header>
    <h1>{title}</h1>
    <div class="meta">{when} · {dur}</div>
  </header>
  <h2>Summary</h2>
  <ul>
      {summary}
  </ul>
  <h2>Decisions</h2>
  <ul>
      {decisions}
  </ul>
  <h2>Action items</h2>
  <table>
    <thead><tr><th>Task</th><th>Owner</th><th>Due</th></tr></thead>
    <tbody>
      {rows}
    </tbody>
  </table>
  <footer>Transcribed and summarised on this machine ({t} / {m}). Nothing left it.</footer>
</body>
</html>"#,
        title = esc(&notes.title),
        when = esc(&fmt_recorded_at(meta)),
        dur = esc(&fmt_duration(duration_of(meta))),
        t = esc(&t),
        m = esc(&m),
    )
}

/// Asks the model for a designed brief (falling back to a plain one), appends
/// the transcript, and prints it to notes.pdf.
pub async fn render_pdf(dir: &Path, notes: &MeetingNotes, meta: &Map<String, Value>, chat: &ChatFn, pdf: &PdfFn, progress: &ProgressFn) -> Result<PathBuf, String> {
    progress(Progress { phase: "designing", ..Default::default() });
    let user = format!(
        "Build a polished one-page meeting brief from this data.\n\nMeeting date: {}\nDuration: {}\n\n{}",
        fmt_recorded_at(meta),
        fmt_duration(duration_of(meta)),
        serde_json::to_string_pretty(notes).unwrap_or_default()
    );
    let mut html = match chat(
        vec![ChatMessage::system(format!("You are a meticulous HTML/CSS designer producing print-ready documents.\n{HTML_RULES}")), ChatMessage::user(user)],
        0.4,
    )
    .await
    {
        Ok(raw) => clean_html(&raw),
        Err(e) => {
            progress(Progress { phase: "designing", warning: Some(e), ..Default::default() });
            String::new()
        }
    };
    let lower = html.to_lowercase();
    if !(lower.contains("<html") && lower.contains("</html>")) {
        html = fallback_html(notes, meta);
    }
    let html = finish_html(&html, &transcript_html(dir));
    let html_path = dir.join(paths::HTML);
    let pdf_path = dir.join(paths::PDF);
    fs::write(&html_path, html).map_err(|e| e.to_string())?;
    progress(Progress { phase: "rendering", ..Default::default() });
    let printed = pdf(html_path.clone(), pdf_path.clone()).await;
    let _ = fs::remove_file(&html_path);
    printed?;
    if fs::metadata(&pdf_path).map(|m| m.len()).unwrap_or(0) == 0 {
        return Err(format!("PDF export produced no usable file at {}", pdf_path.display()));
    }
    Ok(pdf_path)
}

pub struct Engines {
    pub engine: Engine,
    pub engine_label: String,
    pub summary_model: String,
    pub ollama_host: String,
    pub asr: AsrFn,
    pub chat: ChatFn,
    pub pdf: PdfFn,
    pub ollama_up: UpFn,
}

pub struct RunResult {
    pub notes: MeetingNotes,
    pub pdf_path: PathBuf,
}

async fn require_ollama(e: &Engines, what: &str) -> Result<(), String> {
    if (e.ollama_up)().await {
        return Ok(());
    }
    Err(format!(
        "Ollama is not reachable at {}, so Minarrador cannot {what}. Start it from Settings → Open Ollama, then generate the notes for this recording again.",
        e.ollama_host
    ))
}

/// The whole chain over one meeting folder. Re-runnable: every stage
/// overwrites its own artefact.
pub async fn run_pipeline(
    dir: &Path,
    chunk_seconds: u32,
    engines: &Engines,
    meta_in: Map<String, Value>,
    progress: &ProgressFn,
    cancel: &CancellationToken,
) -> Result<RunResult, String> {
    if engines.engine == Engine::Ollama {
        require_ollama(engines, "transcribe this recording").await?;
    }
    let mut meta = Map::new();
    meta.insert("version".into(), json!(1));
    meta.insert("startedAt".into(), json!(chrono::Utc::now().to_rfc3339()));
    meta.insert("durationSeconds".into(), json!(0));
    meta.insert("sources".into(), json!({}));
    for (k, v) in meta_in {
        meta.insert(k, v);
    }
    meta.insert("models".into(), json!({ "transcribe": engines.engine_label, "summary": engines.summary_model }));

    let t = transcribe(dir, chunk_seconds, engines.engine, &engines.engine_label, &engines.asr, progress, cancel).await?;
    if duration_of(&meta) <= 0.0 {
        meta.insert("durationSeconds".into(), json!(t.duration_seconds));
    }
    meta.insert("channels".into(), json!(t.channels));

    require_ollama(engines, "write the notes").await?;
    if cancel.is_cancelled() {
        return Err("cancelled".into());
    }
    let notes = summarise(dir, &t.transcript, t.channels == 2, &engines.chat, progress).await?;
    let typed = paths::read_title(dir);
    let titled = MeetingNotes { title: if typed.is_empty() { notes.title.clone() } else { typed.clone() }, ..notes.clone() };
    fs::write(dir.join(paths::NOTES), render_markdown(&titled, &meta)).map_err(|e| e.to_string())?;
    if cancel.is_cancelled() {
        return Err("cancelled".into());
    }
    let pdf_path = render_pdf(dir, &titled, &meta, &engines.chat, &engines.pdf, progress).await?;

    meta.insert("completedAt".into(), json!(chrono::Utc::now().to_rfc3339()));
    let files: Vec<&str> = paths::ALL_FILES.iter().copied().filter(|f| *f != paths::HTML && dir.join(f).exists()).collect();
    meta.insert("files".into(), json!(files));
    meta.insert("title".into(), json!(titled.title));
    fs::write(dir.join(paths::META), serde_json::to_string_pretty(&Value::Object(meta)).unwrap_or_default()).map_err(|e| e.to_string())?;
    progress(Progress { phase: "done", ..Default::default() });
    Ok(RunResult { notes, pdf_path })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn quiet() -> ProgressFn {
        Arc::new(|_| {})
    }

    #[test]
    fn extracts_json_from_chatter() {
        assert_eq!(extract_json("```json\n{\"a\":1}\n```")["a"], 1);
        assert_eq!(extract_json("Sure! {\"a\": \"}\"} trailing")["a"], "}");
        assert!(extract_json("nothing").is_null());
    }

    #[test]
    fn normalises_loose_notes() {
        let v = serde_json::json!({
            "summary": ["a", {"text": "b"}, "", "c", "d", "e", "f"],
            "decisions": ["ship it", {"text": "hire", "rationale": "growth"}, {}],
            "actionItems": [{"action": "write", "assignee": ""}, "call"]
        });
        let n = normalise_notes(&v, "x");
        assert_eq!(n.title, "Meeting notes");
        assert_eq!(n.summary, vec!["a", "b", "c", "d", "e"]);
        assert_eq!(n.decisions[1], Decision { decision: "hire".into(), context: "growth".into() });
        assert_eq!(n.action_items[0].owner, "Unassigned");
        assert_eq!(n.action_items[1].task, "call");
        assert_eq!(normalise_notes(&Value::Null, "").summary, vec!["No speech was detected in this recording."]);
    }

    #[test]
    fn durations() {
        assert_eq!(fmt_duration(5.0), "5s");
        assert_eq!(fmt_duration(65.0), "1m 5s");
        assert_eq!(fmt_duration(3720.0), "1h 2m");
    }

    #[test]
    fn markdown_and_html() {
        let notes = MeetingNotes {
            title: "T".into(),
            summary: vec!["s".into()],
            decisions: vec![],
            action_items: vec![ActionItem { task: "x".into(), owner: "You".into(), due: "".into() }],
        };
        let md = render_markdown(&notes, &Map::new());
        assert!(md.contains("# T") && md.contains("- [ ] x — **You**") && md.contains("No decisions"));
        let html = finish_html(&fallback_html(&notes, &Map::new()), "<section>tx</section>");
        assert!(html.contains("Content-Security-Policy"));
        assert!(html.find("<section>tx</section>").unwrap() < html.rfind("</body>").unwrap());
        assert_eq!(clean_html("```html\n<p>x</p><html><script>bad()</script></html>```"), "<html></html>");
    }

    #[tokio::test]
    async fn transcribes_each_side_with_its_own_prompt() {
        let dir = tempfile::tempdir().unwrap();
        let mut pcm = vec![];
        for i in 0..32000 {
            pcm.push(if i < 16000 { 8000 } else { 0 });
            pcm.push(if i < 16000 { 0 } else { 8000 });
        }
        std::fs::write(dir.path().join(paths::AUDIO), build_wav(&pcm, 16000, 2)).unwrap();
        let calls = Arc::new(std::sync::Mutex::new(vec![]));
        let seen = calls.clone();
        let asr: AsrFn = Arc::new(move |_wav, prompt, _s| {
            seen.lock().unwrap().push(prompt);
            Box::pin(async { Ok("hello".to_string()) })
        });
        let r = transcribe(dir.path(), 1, Engine::Whisper, "w", &asr, &quiet(), &CancellationToken::new()).await.unwrap();
        assert_eq!(r.channels, 2);
        assert!(r.transcript.contains("You: hello") && r.transcript.contains("Others: hello"));
        let calls = calls.lock().unwrap();
        assert_eq!(calls[0], "");
        assert!(calls.len() >= 2);
        assert!(dir.path().join(paths::TRANSCRIPT_JSON).exists());
    }
}
