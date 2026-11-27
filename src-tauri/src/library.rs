//! The meeting library: a read-only view over the notes folder.
//!
//! The folder on disk is the source of truth — no index, no database. A meeting
//! is recognised by its artefacts, not its name. Nothing here writes, renames
//! or deletes. What is read is cached by size+mtime, so a warm search reads no
//! transcript at all.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde_json::Value;

use crate::paths::{self, meeting_dir, normalise_title, parse_folder_stamp, parse_speaker_line, SPEAKER_MIC, SPEAKER_SYSTEM};
use crate::types::*;

const PREVIEW_CHARS: usize = 180;
const PREVIEW_BYTES: usize = 4096;
const SNIPPET_PAD: usize = 70;
const MAX_QUERY: usize = 120;
const ERROR_CHARS: usize = 400;
pub const MAX_CACHED_CHARS: usize = 32 * 1024 * 1024;

/// The files a card is built from; any change to one rebuilds the card.
const CARD_FILES: [&str; 7] =
    [paths::META, paths::NOTES_JSON, paths::TITLE, paths::TRANSCRIPT, paths::LIVE_TRANSCRIPT, paths::ERROR, paths::UNPROCESSED];

fn read_json(file: &Path) -> Option<serde_json::Map<String, Value>> {
    match serde_json::from_str::<Value>(&fs::read_to_string(file).ok()?).ok()? {
        Value::Object(m) => Some(m),
        _ => None,
    }
}

fn head(file: &Path, bytes: usize) -> String {
    let Ok(f) = fs::File::open(file) else { return String::new() };
    let mut buf = Vec::with_capacity(bytes);
    let _ = f.take(bytes as u64).read_to_end(&mut buf);
    String::from_utf8_lossy(&buf).into_owned()
}

fn clip(text: &str, chars: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() > chars {
        format!("{}…", flat.chars().take(chars - 1).collect::<String>())
    } else {
        flat
    }
}

/// Transcript text as prose: speaker prefixes off, so a search for "you" does
/// not match every labelled line.
pub fn spoken(text: &str) -> String {
    text.lines()
        .map(|l| l.strip_prefix(&format!("{SPEAKER_MIC}: ")).or_else(|| l.strip_prefix(&format!("{SPEAKER_SYSTEM}: "))).unwrap_or(l))
        .collect::<Vec<_>>()
        .join("\n")
}

fn signature(file: &Path) -> Option<String> {
    let m = fs::metadata(file).ok()?;
    let mtime = m.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_nanos();
    Some(format!("{}:{mtime}", m.len()))
}

struct CachedText {
    signature: String,
    text: String,
    lower: String,
}

#[derive(Default)]
pub struct LibraryCache {
    cards: HashMap<PathBuf, (String, MeetingCard)>,
    texts: HashMap<PathBuf, CachedText>,
    order: Vec<PathBuf>,
    chars: usize,
    max_chars: usize,
}

impl LibraryCache {
    pub fn new() -> Self {
        LibraryCache { max_chars: MAX_CACHED_CHARS, ..Default::default() }
    }

    fn prune(&mut self, root: &Path, seen: &HashSet<PathBuf>) {
        self.cards.retain(|dir, _| dir.parent() != Some(root) || seen.contains(dir));
        let gone: Vec<PathBuf> = self
            .texts
            .keys()
            .filter(|f| f.parent().is_some_and(|d| d.parent() == Some(root) && !seen.contains(d)))
            .cloned()
            .collect();
        for f in gone {
            self.drop_text(&f);
        }
    }

    fn drop_text(&mut self, file: &Path) {
        if let Some(old) = self.texts.remove(file) {
            self.chars -= old.text.len();
            self.order.retain(|f| f != file);
        }
    }

    fn put_text(&mut self, file: PathBuf, entry: CachedText) {
        self.drop_text(&file);
        if entry.text.len() > self.max_chars {
            return;
        }
        while self.chars + entry.text.len() > self.max_chars && !self.order.is_empty() {
            let oldest = self.order.remove(0);
            if let Some(old) = self.texts.remove(&oldest) {
                self.chars -= old.text.len();
            }
        }
        self.chars += entry.text.len();
        self.order.push(file.clone());
        self.texts.insert(file, entry);
    }
}

struct FolderState {
    names: HashSet<String>,
    signature: String,
}

fn folder_state(dir: &Path) -> Option<FolderState> {
    let names: HashSet<String> = fs::read_dir(dir).ok()?.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    let mut parts: Vec<String> = CARD_FILES
        .iter()
        .filter(|n| names.contains(**n))
        .map(|n| format!("{n}:{}", signature(&dir.join(n)).unwrap_or_else(|| "?".into())))
        .collect();
    for n in [paths::AUDIO, paths::NOTES, paths::PDF] {
        if names.contains(n) {
            parts.push(n.to_string());
        }
    }
    Some(FolderState { names, signature: parts.join("|") })
}

fn is_meeting(names: &HashSet<String>) -> bool {
    [paths::AUDIO, paths::NOTES_JSON, paths::META].iter().any(|f| names.contains(*f))
}

fn pick_transcript(dir: &Path, names: &HashSet<String>) -> (Option<PathBuf>, TranscriptSource) {
    if names.contains(paths::TRANSCRIPT) {
        (Some(dir.join(paths::TRANSCRIPT)), TranscriptSource::Pipeline)
    } else if names.contains(paths::LIVE_TRANSCRIPT) {
        (Some(dir.join(paths::LIVE_TRANSCRIPT)), TranscriptSource::Live)
    } else {
        (None, TranscriptSource::None)
    }
}

fn iso(value: &Value) -> Option<String> {
    let s = value.as_str()?;
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|d| d.with_timezone(&chrono::Utc).to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

fn build_card(dir: &Path, names: &HashSet<String>) -> MeetingCard {
    let id = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let has = |n: &str| names.contains(n);
    let meta = if has(paths::META) { read_json(&dir.join(paths::META)) } else { None }.unwrap_or_default();
    let notes = if has(paths::NOTES_JSON) { read_json(&dir.join(paths::NOTES_JSON)) } else { None };
    let title_raw = if has(paths::TITLE) { fs::read_to_string(dir.join(paths::TITLE)).unwrap_or_default() } else { String::new() };

    let started_at = meta
        .get("startedAt")
        .and_then(iso)
        .or_else(|| parse_folder_stamp(&id).map(|d| d.with_timezone(&chrono::Utc).to_rfc3339_opts(chrono::SecondsFormat::Millis, true)))
        .or_else(|| {
            fs::metadata(dir)
                .and_then(|m| m.modified())
                .ok()
                .map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        })
        .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".into());

    let (transcript, source) = pick_transcript(dir, names);
    let first_summary = notes.as_ref().and_then(|n| n.get("summary")).and_then(Value::as_array).and_then(|a| a.iter().find_map(Value::as_str)).map(String::from);
    let preview = clip(&spoken(&first_summary.unwrap_or_else(|| transcript.as_deref().map(|f| head(f, PREVIEW_BYTES)).unwrap_or_default())), PREVIEW_CHARS);
    let status = if notes.is_some() {
        "ready"
    } else if has(paths::ERROR) {
        "failed"
    } else if has(paths::UNPROCESSED) {
        "unprocessed"
    } else {
        "pending"
    };
    let chosen = normalise_title(&title_raw);
    let generated = notes.as_ref().and_then(|n| n.get("title")).and_then(Value::as_str).map(str::trim).unwrap_or("").to_string();
    let count = |key: &str| notes.as_ref().and_then(|n| n.get(key)).and_then(Value::as_array).map(Vec::len).unwrap_or(0);
    MeetingCard {
        title: if !chosen.is_empty() {
            chosen.clone()
        } else if !generated.is_empty() {
            generated.clone()
        } else {
            "Untitled recording".into()
        },
        id,
        generated_title: generated,
        renamed: !chosen.is_empty(),
        started_at,
        duration_seconds: meta.get("durationSeconds").and_then(Value::as_f64).filter(|d| d.is_finite()).unwrap_or(0.0),
        status,
        preview,
        decisions: count("decisions"),
        action_items: count("action_items"),
        transcript_source: source,
        files: MeetingFiles { audio: has(paths::AUDIO), transcript: source != TranscriptSource::None, notes: has(paths::NOTES), pdf: has(paths::PDF) },
        matches: None,
    }
}

fn card_for(dir: &Path, state: &FolderState, cache: &mut LibraryCache) -> MeetingCard {
    if let Some((sig, card)) = cache.cards.get(dir) {
        if *sig == state.signature {
            return card.clone();
        }
    }
    let card = build_card(dir, &state.names);
    cache.cards.insert(dir.to_path_buf(), (state.signature.clone(), card.clone()));
    card
}

/// One card, fresh enough for a confirmation dialog.
pub fn describe_meeting(dir: &Path, cache: &mut LibraryCache) -> Option<MeetingCard> {
    let state = folder_state(dir)?;
    Some(card_for(dir, &state, cache))
}

fn spoken_transcript<'a>(file: &Path, cache: &'a mut LibraryCache) -> Option<&'a CachedText> {
    let sig = signature(file)?;
    let fresh = cache.texts.get(file).is_some_and(|t| t.signature == sig);
    if !fresh {
        let text = spoken(&fs::read_to_string(file).unwrap_or_default());
        let lower = text.to_lowercase();
        cache.put_text(file.to_path_buf(), CachedText { signature: sig, text, lower });
    }
    cache.texts.get(file)
}

/// Counts of `needle` (already lower-cased) and the first hit's context.
fn find_hits(text: &str, lower: &str, needle: &str) -> (usize, Option<String>) {
    let mut count = 0;
    let mut first = None;
    let mut from = 0;
    while let Some(at) = lower[from..].find(needle).map(|i| i + from) {
        if first.is_none() {
            // `lower` and `text` only line up byte for byte when lower-casing
            // kept every length, which is true of almost all text; when it is
            // not, the snippet is cut from the lower-cased copy instead.
            let src = if text.len() == lower.len() { text } else { lower };
            let start = floor(src, at.saturating_sub(SNIPPET_PAD));
            let end = floor(src, (at + needle.len() + SNIPPET_PAD).min(src.len()));
            first = Some(format!("{}{}…", if at > SNIPPET_PAD { "…" } else { "" }, &src[start..end]));
        }
        count += 1;
        from = at + needle.len().max(1);
    }
    (count, first)
}

fn floor(s: &str, mut i: usize) -> usize {
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn find_in_meeting(dir: &Path, names: &HashSet<String>, card: &MeetingCard, needle: &str, cache: &mut LibraryCache) -> Option<(usize, String)> {
    let mut count = 0;
    let mut snippet: Option<String> = None;
    if let (Some(file), _) = pick_transcript(dir, names) {
        if let Some(t) = spoken_transcript(&file, cache) {
            let (n, first) = find_hits(&t.text, &t.lower, needle);
            count += n;
            if let Some(f) = first {
                snippet = Some(clip(&f, PREVIEW_CHARS));
            }
        }
    }
    for text in [&card.title, &card.preview] {
        let (n, _) = find_hits(text, &text.to_lowercase(), needle);
        if n > 0 && snippet.is_none() {
            snippet = Some(card.preview.clone());
        }
        count += n;
    }
    if count > 0 { Some((count, snippet.unwrap_or_default())) } else { None }
}

/// Every meeting in the notes folder, newest first; filtered by `query`.
pub fn list_meetings(notes_dir: &Path, query: &str, cache: &mut LibraryCache) -> Vec<MeetingCard> {
    let root = notes_dir.to_path_buf();
    let Ok(entries) = fs::read_dir(&root) else { return vec![] };
    let needle: String = query.trim().chars().take(MAX_QUERY).collect::<String>().to_lowercase();
    let mut seen = HashSet::new();
    let mut out = vec![];
    for entry in entries.filter_map(|e| e.ok()) {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let dir = entry.path();
        let Some(state) = folder_state(&dir) else { continue };
        if !is_meeting(&state.names) {
            continue;
        }
        seen.insert(dir.clone());
        let mut card = card_for(&dir, &state, cache);
        if !needle.is_empty() {
            match find_in_meeting(&dir, &state.names, &card, &needle, cache) {
                Some((count, snippet)) => {
                    card.matches = Some(count);
                    card.preview = snippet;
                }
                None => continue,
            }
        }
        out.push(card);
    }
    cache.prune(&root, &seen);
    out.sort_by(|a, b| b.started_at.cmp(&a.started_at).then_with(|| b.id.cmp(&a.id)));
    out
}

fn transcript_lines(dir: &Path, file: Option<&Path>, source: TranscriptSource) -> Vec<TranscriptLine> {
    if source == TranscriptSource::Pipeline {
        if let Some(segments) = read_json(&dir.join(paths::TRANSCRIPT_JSON)).and_then(|j| j.get("segments").and_then(Value::as_array).cloned()) {
            return segments
                .iter()
                .filter_map(|s| {
                    let text = s["text"].as_str()?.trim();
                    if text.is_empty() {
                        return None;
                    }
                    Some(TranscriptLine {
                        start_seconds: s["startSeconds"].as_f64().filter(|v| v.is_finite()),
                        speaker: Speaker::parse(s["speaker"].as_str().unwrap_or("")),
                        text: text.to_string(),
                    })
                })
                .collect();
        }
    }
    let Some(file) = file else { return vec![] };
    let raw = fs::read_to_string(file).unwrap_or_default().replace("\r\n", "\n");
    let blocks: Vec<&str> = if source == TranscriptSource::Live { raw.split('\n').collect() } else { split_paragraphs(&raw) };
    blocks
        .into_iter()
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .map(|b| {
            let (speaker, text) = parse_speaker_line(b);
            TranscriptLine { start_seconds: None, speaker, text }
        })
        .collect()
}

fn split_paragraphs(raw: &str) -> Vec<&str> {
    let re = regex::Regex::new(r"\n{2,}").unwrap();
    re.split(raw).collect()
}

fn error_summary(dir: &Path) -> String {
    let raw = head(&dir.join(paths::ERROR), PREVIEW_BYTES).replace("\r\n", "\n");
    if raw.trim().is_empty() {
        return String::new();
    }
    let re = regex::Regex::new(r"\n\s*\n").unwrap();
    let parts: Vec<&str> = re.split(&raw).collect();
    let body = parts[1..].join("\n");
    let body = if body.trim().is_empty() { raw.clone() } else { body.trim().to_string() };
    let first = body.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
    clip(first.strip_prefix("Error: ").unwrap_or(first), ERROR_CHARS)
}

pub fn read_meeting(notes_dir: &Path, id: &str, cache: &mut LibraryCache) -> Option<MeetingDetail> {
    let dir = meeting_dir(notes_dir, id)?;
    let state = folder_state(&dir)?;
    if !is_meeting(&state.names) {
        return None;
    }
    let card = card_for(&dir, &state, cache);
    let (file, source) = pick_transcript(&dir, &state.names);
    let notes = read_json(&dir.join(paths::NOTES_JSON)).unwrap_or_default();
    let meta = read_json(&dir.join(paths::META)).unwrap_or_default();
    let arr = |key: &str| notes.get(key).and_then(Value::as_array).cloned().unwrap_or_default();
    let text = |v: &Value| match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        o => o.to_string(),
    };
    Some(MeetingDetail {
        summary: arr("summary").iter().filter_map(Value::as_str).filter(|s| !s.trim().is_empty()).map(String::from).collect(),
        decisions: arr("decisions")
            .iter()
            .map(|d| Decision { decision: text(&d["decision"]), context: text(&d["context"]) })
            .filter(|d| !d.decision.is_empty())
            .collect(),
        action_items: arr("action_items")
            .iter()
            .map(|a| ActionItem { task: text(&a["task"]), owner: text(&a["owner"]), due: text(&a["due"]) })
            .filter(|a| !a.task.is_empty())
            .collect(),
        transcript: transcript_lines(&dir, file.as_deref(), source),
        error: if card.status == "failed" { error_summary(&dir) } else { String::new() },
        sources: Sources {
            mic: meta.get("sources").and_then(|s| s["mic"].as_bool()).unwrap_or(false),
            system: meta.get("sources").and_then(|s| s["system"].as_bool()).unwrap_or(false),
        },
        speakers: SpeakerNames { mic: SPEAKER_MIC, system: SPEAKER_SYSTEM },
        models: ModelNames {
            transcribe: meta.get("models").map(|m| text(&m["transcribe"])).unwrap_or_default(),
            summary: meta.get("models").map(|m| text(&m["summary"])).unwrap_or_default(),
        },
        id: card.id,
        title: card.title,
        generated_title: card.generated_title,
        renamed: card.renamed,
        started_at: card.started_at,
        duration_seconds: card.duration_seconds,
        status: card.status,
        preview: card.preview,
        transcript_source: card.transcript_source,
        files: card.files,
    })
}

/// "Open this" names a target from a fixed table, never a file: the window is
/// never given the vocabulary to ask for anything else in the notes folder.
pub fn open_target(notes_dir: &Path, id: &str, target: &str) -> Option<PathBuf> {
    let dir = meeting_dir(notes_dir, id)?;
    let names: &[&str] = match target {
        "folder" => return Some(dir),
        "pdf" => &[paths::PDF],
        "notes" => &[paths::NOTES],
        "transcript" => &[paths::TRANSCRIPT, paths::LIVE_TRANSCRIPT],
        "audio" => &[paths::AUDIO],
        _ => return None,
    };
    names.iter().map(|n| dir.join(n)).find(|f| f.exists())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meeting(root: &Path, name: &str, files: &[(&str, &str)]) -> PathBuf {
        let dir = root.join(name);
        fs::create_dir_all(&dir).unwrap();
        for (f, body) in files {
            fs::write(dir.join(f), body).unwrap();
        }
        dir
    }

    #[test]
    fn lists_reads_and_searches() {
        let root = tempfile::tempdir().unwrap();
        let r = root.path();
        meeting(r, "2026-01-01_10-00-00", &[
            (paths::AUDIO, "x"),
            (paths::NOTES_JSON, r#"{"title":"Budget","summary":["We cut costs"],"decisions":[{"decision":"cut","context":""}],"action_items":[]}"#),
            (paths::TRANSCRIPT, "You: the budget is tight\n\nOthers: agreed, budget"),
        ]);
        meeting(r, "2026-01-02_10-00-00", &[(paths::AUDIO, "x"), (paths::LIVE_TRANSCRIPT, "You: hello\nOthers: hi\n"), (paths::UNPROCESSED, "quit")]);
        meeting(r, "holiday photos", &[("a.jpg", "")]);
        let mut cache = LibraryCache::new();
        let all = list_meetings(r, "", &mut cache);
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].id, "2026-01-02_10-00-00");
        assert_eq!(all[0].status, "unprocessed");
        assert_eq!(all[0].transcript_source, TranscriptSource::Live);
        assert_eq!(all[1].title, "Budget");
        assert_eq!(all[1].decisions, 1);

        let hits = list_meetings(r, "BUDGET", &mut cache);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].matches, Some(3));
        assert!(list_meetings(r, "you", &mut cache).is_empty(), "speaker labels are not speech");

        let detail = read_meeting(r, "2026-01-02_10-00-00", &mut cache).unwrap();
        assert_eq!(detail.transcript.len(), 2);
        assert_eq!(detail.transcript[1].speaker, Speaker::System);
        assert!(read_meeting(r, "holiday photos", &mut cache).is_none());
        assert!(read_meeting(r, "../x", &mut cache).is_none());
    }

    #[test]
    fn titles_and_errors() {
        let root = tempfile::tempdir().unwrap();
        meeting(root.path(), "m", &[(paths::AUDIO, ""), (paths::TITLE, " Mine \n"), (paths::ERROR, "Processing failed at x\n\nError: Ollama down\nstack")]);
        let mut cache = LibraryCache::new();
        let d = read_meeting(root.path(), "m", &mut cache).unwrap();
        assert_eq!(d.title, "Mine");
        assert!(d.renamed);
        assert_eq!(d.status, "failed");
        assert_eq!(d.error, "Ollama down");
        assert!(open_target(root.path(), "m", "audio").is_some());
        assert!(open_target(root.path(), "m", "pdf").is_none());
        assert!(open_target(root.path(), "m", "../../etc").is_none());
    }
}
