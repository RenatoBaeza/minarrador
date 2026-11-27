//! Meeting folder naming, the file names inside one, and speaker labels.
//!
//! These are part of the on-disk format the library, the pipeline and anyone
//! opening the folder by hand all rely on, so they live in one place.

use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Datelike, Local, NaiveDate, TimeZone, Timelike};

use crate::types::Speaker;

pub const AUDIO: &str = "audio.wav";
pub const TRANSCRIPT: &str = "transcript.txt";
pub const TRANSCRIPT_JSON: &str = "transcript.json";
/// The live preview, written line by line during the meeting — the one piece
/// of text that survives a pipeline that never ran.
pub const LIVE_TRANSCRIPT: &str = "live-transcript.txt";
pub const NOTES: &str = "notes.md";
pub const NOTES_JSON: &str = "notes.json";
pub const HTML: &str = "notes.html";
pub const PDF: &str = "notes.pdf";
pub const META: &str = "meta.json";
/// A title the user typed. Its own file because notes.json and meta.json are
/// rewritten by every pipeline run, and a rename stored there would revert.
pub const TITLE: &str = "title.txt";
pub const ERROR: &str = "ERROR.txt";
pub const UNPROCESSED: &str = "UNPROCESSED.txt";

/// Every artefact the pipeline may leave, in the order meta.json lists them.
pub const ALL_FILES: [&str; 10] =
    [AUDIO, TRANSCRIPT, TRANSCRIPT_JSON, LIVE_TRANSCRIPT, NOTES, NOTES_JSON, HTML, PDF, META, TITLE];

/// Longest title worth keeping; past this it is a paragraph, not a name.
pub const MAX_TITLE: usize = 120;

/// What each channel of a two-channel recording is called in a transcript:
/// left is the microphone, right is everything the system played.
pub const SPEAKER_MIC: &str = "You";
pub const SPEAKER_SYSTEM: &str = "Others";

pub fn speaker_name(speaker: Speaker) -> Option<&'static str> {
    match speaker {
        Speaker::Mic => Some(SPEAKER_MIC),
        Speaker::System => Some(SPEAKER_SYSTEM),
        Speaker::None => None,
    }
}

/// Slug for a meeting folder: `2026-08-11_14-32-05`.
pub fn folder_stamp(date: &DateTime<Local>) -> String {
    format!(
        "{:04}-{:02}-{:02}_{:02}-{:02}-{:02}",
        date.year(),
        date.month(),
        date.day(),
        date.hour(),
        date.minute(),
        date.second()
    )
}

/// Inverse of [`folder_stamp`]: the local time a folder name encodes, or None
/// when the name was not written by this app. Tolerates the `-2` suffix two
/// meetings in the same second get.
pub fn parse_folder_stamp(name: &str) -> Option<DateTime<Local>> {
    let re = regex_lite();
    let caps = re.captures(name)?;
    let n = |i: usize| caps.get(i).and_then(|m| m.as_str().parse::<u32>().ok());
    let date = NaiveDate::from_ymd_opt(n(1)? as i32, n(2)?, n(3)?)?;
    let naive = date.and_hms_opt(n(4)?, n(5)?, n(6)?)?;
    Local.from_local_datetime(&naive).earliest()
}

fn regex_lite() -> &'static regex::Regex {
    use std::sync::OnceLock;
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})(?:-\d+)?$").unwrap())
}

/// Creates and returns a fresh folder for one recording.
pub fn create_meeting_dir(notes_dir: &Path, date: &DateTime<Local>) -> std::io::Result<PathBuf> {
    let stamp = folder_stamp(date);
    let mut dir = notes_dir.join(&stamp);
    let mut n = 2;
    while dir.exists() {
        dir = notes_dir.join(format!("{stamp}-{n}"));
        n += 1;
    }
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// One transcript line, labelled when it is known who said it.
pub fn speaker_line(speaker: Speaker, text: &str) -> String {
    match speaker_name(speaker) {
        Some(name) => format!("{name}: {text}"),
        None => text.to_string(),
    }
}

/// Pulls a speaker label back off a line written by [`speaker_line`].
pub fn parse_speaker_line(line: &str) -> (Speaker, String) {
    for (speaker, name) in [(Speaker::Mic, SPEAKER_MIC), (Speaker::System, SPEAKER_SYSTEM)] {
        if let Some(rest) = line.strip_prefix(name).and_then(|r| r.strip_prefix(": ")) {
            return (speaker, rest.to_string());
        }
    }
    (Speaker::None, line.to_string())
}

/// A user-typed title, flattened to one line. `""` means "use the model's".
pub fn normalise_title(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    flat.chars().take(MAX_TITLE).collect::<String>().trim().to_string()
}

/// The title someone typed over this meeting, or `""` if they never did.
pub fn read_title(dir: &Path) -> String {
    fs::read_to_string(dir.join(TITLE)).map(|t| normalise_title(&t)).unwrap_or_default()
}

/// The folder a bare name names inside the notes folder, or None.
///
/// The id is a folder name, never a path: anything with a separator, a `..`, or
/// a parent other than the notes folder itself names nothing.
pub fn meeting_dir(notes_dir: &Path, id: &str) -> Option<PathBuf> {
    let id = id.trim_end();
    if id.trim().is_empty() || id.contains(['/', '\\', ':']) || id == "." || id == ".." {
        return None;
    }
    let dir = notes_dir.join(id);
    if dir.parent() != Some(notes_dir) || dir.file_name().map(|n| n.to_string_lossy() != id).unwrap_or(true) {
        return None;
    }
    if !dir.is_dir() {
        return None;
    }
    Some(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stamps_round_trip() {
        let date = Local.with_ymd_and_hms(2026, 8, 11, 14, 32, 5).unwrap();
        let stamp = folder_stamp(&date);
        assert_eq!(stamp, "2026-08-11_14-32-05");
        assert_eq!(parse_folder_stamp(&stamp), Some(date));
        assert_eq!(parse_folder_stamp("2026-08-11_14-32-05-2"), Some(date));
        assert_eq!(parse_folder_stamp("2026-13-45_14-32-05"), None);
        assert_eq!(parse_folder_stamp("notes"), None);
    }

    #[test]
    fn creates_unique_dirs() {
        let root = tempfile::tempdir().unwrap();
        let date = Local.with_ymd_and_hms(2026, 1, 2, 3, 4, 5).unwrap();
        let a = create_meeting_dir(root.path(), &date).unwrap();
        let b = create_meeting_dir(root.path(), &date).unwrap();
        assert!(a.ends_with("2026-01-02_03-04-05"));
        assert!(b.ends_with("2026-01-02_03-04-05-2"));
    }

    #[test]
    fn speaker_lines_round_trip() {
        assert_eq!(speaker_line(Speaker::Mic, "hi"), "You: hi");
        assert_eq!(speaker_line(Speaker::None, "hi"), "hi");
        assert_eq!(parse_speaker_line("Others: yes"), (Speaker::System, "yes".into()));
        assert_eq!(parse_speaker_line("Bob: yes"), (Speaker::None, "Bob: yes".into()));
    }

    #[test]
    fn titles_are_flattened() {
        assert_eq!(normalise_title("  a\n\tb  "), "a b");
        assert_eq!(normalise_title(&"x".repeat(500)).len(), MAX_TITLE);
    }

    #[test]
    fn meeting_dir_rejects_paths() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("m1")).unwrap();
        assert!(meeting_dir(root.path(), "m1").is_some());
        assert!(meeting_dir(root.path(), "..").is_none());
        assert!(meeting_dir(root.path(), "../m1").is_none());
        assert!(meeting_dir(root.path(), "m1\\..\\..").is_none());
        assert!(meeting_dir(root.path(), "C:\\Windows").is_none());
        assert!(meeting_dir(root.path(), "missing").is_none());
        assert!(meeting_dir(root.path(), "").is_none());
    }
}
