//! The JSON settings store (`%APPDATA%\Minarrador\settings.json`).
//!
//! Settings are a plain file a user may hand-edit, and a wrong type surfaces far
//! away — a numeric notesDir becomes a path crash at Start, a string chunkSeconds
//! a nonsense chunk mid-pipeline. So every field is coerced against its default
//! and anything that does not fit is dropped rather than repaired.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Shortcuts the app is willing to register, and the only values `hotkey` may
/// hold. A fixed list because a global shortcut is claimed against the whole
/// desktop, and the value is written from a window that should never be able to
/// invent one. `off` is a value because an empty string falls back to the default.
pub const HOTKEY_CHOICES: [&str; 5] = [
    "CommandOrControl+Shift+R",
    "CommandOrControl+Shift+M",
    "CommandOrControl+Alt+R",
    "Alt+Shift+R",
    "off",
];

/// The voice-input hotkey's choices — disjoint from [`HOTKEY_CHOICES`] so the
/// two can never be the same key. `Super` is the Windows key.
pub const DICTATE_HOTKEY_CHOICES: [&str; 5] = [
    "Super+Shift+X",
    "Super+Shift+W",
    "CommandOrControl+Alt+W",
    "CommandOrControl+Shift+H",
    "off",
];

pub const ENGINES: [&str; 2] = ["whisper", "ollama"];

/// Everything settings.json holds.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub notes_dir: String,
    pub ollama_host: String,
    pub transcribe_model: String,
    pub summary_model: String,
    pub capture_mic: bool,
    pub capture_system: bool,
    /// Which microphone to record, or `""` for the Windows default. The label
    /// is kept beside it: a device id is not always reissued, a name usually is.
    pub mic_device_id: String,
    pub mic_device_label: String,
    /// Keep the microphone and the system audio on separate WAV channels — the
    /// reason the notes can say who owns an action item.
    pub separate_channels: bool,
    /// Offer to record when sustained audio is heard while idle. Off by default.
    pub suggest_on_audio: bool,
    /// Stop a recording that has heard nothing for this many minutes; 0 never.
    pub silence_stop_minutes: u32,
    /// Hard ceiling on one recording, in minutes; 0 removes it.
    pub max_recording_minutes: u32,
    pub prevent_sleep: bool,
    pub start_at_login: bool,
    pub live_transcript: bool,
    pub live_engine: String,
    pub transcribe_engine: String,
    pub whisper_model: String,
    pub whisper_root: String,
    pub whisper_threads: u32,
    pub chunk_seconds: u32,
    pub hotkey: String,
    pub dictate_hotkey: String,
    pub dictate_engine: String,
    pub dictate_auto_paste: bool,
    /// Draw the open to-do tasks onto the wallpaper. Off by default: it replaces
    /// the wallpaper, which is not something to do to a desktop unasked.
    pub desktop_todos: bool,
}

/// Fields with a fixed vocabulary.
const ENUMS: &[(&str, &[&str])] = &[
    ("liveEngine", &ENGINES),
    ("transcribeEngine", &ENGINES),
    ("hotkey", &HOTKEY_CHOICES),
    ("dictateHotkey", &DICTATE_HOTKEY_CHOICES),
    ("dictateEngine", &ENGINES),
];

/// Numeric fields with a range that has to hold however the file was edited.
const RANGES: &[(&str, f64, f64)] = &[
    ("chunkSeconds", 5.0, 300.0),
    ("whisperThreads", 0.0, 64.0),
    ("silenceStopMinutes", 0.0, 240.0),
    ("maxRecordingMinutes", 0.0, 1440.0),
];

static NOTES_DEFAULT: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Where meetings go when nobody chose: Documents\Minarrador. Set once at startup.
pub fn set_documents_dir(documents: &Path) {
    *NOTES_DEFAULT.lock().unwrap() = Some(documents.join("Minarrador"));
}

pub fn defaults() -> Settings {
    let notes = NOTES_DEFAULT
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_else(|| PathBuf::from("Minarrador"));
    Settings {
        notes_dir: notes.to_string_lossy().into_owned(),
        ollama_host: "http://127.0.0.1:11434".into(),
        transcribe_model: "gemma4:12b".into(),
        summary_model: "gemma4:12b".into(),
        capture_mic: true,
        capture_system: true,
        mic_device_id: String::new(),
        mic_device_label: String::new(),
        separate_channels: true,
        suggest_on_audio: false,
        silence_stop_minutes: 15,
        max_recording_minutes: 240,
        prevent_sleep: true,
        start_at_login: true,
        live_transcript: true,
        live_engine: "whisper".into(),
        transcribe_engine: "whisper".into(),
        whisper_model: "ggml-base.bin".into(),
        whisper_root: String::new(),
        whisper_threads: 0,
        chunk_seconds: 60,
        hotkey: HOTKEY_CHOICES[0].into(),
        dictate_hotkey: DICTATE_HOTKEY_CHOICES[0].into(),
        dictate_engine: "ollama".into(),
        dictate_auto_paste: true,
        desktop_todos: false,
    }
}

/// Coerces whatever was stored against `base`, field by field.
///
/// Booleans must be booleans, numbers finite numbers, strings non-empty after
/// trimming; anything else keeps the base value. Enums and ranges are then
/// enforced on the keys `base` defines.
pub fn coerce_map(stored: &Value, base: &Map<String, Value>) -> Map<String, Value> {
    let mut out = base.clone();
    if let Value::Object(given) = stored {
        for (key, fallback) in base {
            let Some(value) = given.get(key) else { continue };
            match (fallback, value) {
                (Value::Bool(_), Value::Bool(_)) => {
                    out.insert(key.clone(), value.clone());
                }
                (Value::Number(_), Value::Number(n)) if n.as_f64().is_some_and(f64::is_finite) => {
                    out.insert(key.clone(), value.clone());
                }
                (Value::String(_), Value::String(s)) if !s.trim().is_empty() => {
                    out.insert(key.clone(), Value::String(s.trim().to_string()));
                }
                _ => {}
            }
        }
    }
    for (key, allowed) in ENUMS {
        if let Some(Value::String(v)) = out.get(*key) {
            if !allowed.contains(&v.as_str()) {
                out.insert((*key).into(), base[*key].clone());
            }
        }
    }
    for (key, lo, hi) in RANGES {
        if let Some(v) = out.get(*key).and_then(Value::as_f64) {
            let clamped = v.round().clamp(*lo, *hi) as u64;
            out.insert((*key).into(), Value::from(clamped));
        }
    }
    out
}

fn to_map(settings: &Settings) -> Map<String, Value> {
    match serde_json::to_value(settings) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

pub fn coerce(stored: &Value) -> Settings {
    let map = coerce_map(stored, &to_map(&defaults()));
    serde_json::from_value(Value::Object(map)).unwrap_or_else(|_| defaults())
}

/// The store: a cache in front of one file, written by replace-then-rename.
pub struct SettingsStore {
    file: PathBuf,
    current: Mutex<Settings>,
}

impl SettingsStore {
    pub fn load(user_data: &Path) -> SettingsStore {
        let file = user_data.join("settings.json");
        let stored = fs::read_to_string(&file)
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .unwrap_or(Value::Null);
        SettingsStore { file, current: Mutex::new(coerce(&stored)) }
    }

    pub fn get(&self) -> Settings {
        self.current.lock().unwrap().clone()
    }

    pub fn exists(user_data: &Path) -> bool {
        user_data.join("settings.json").exists()
    }

    /// Merges `patch` over what is stored, coerces the result and writes it.
    pub fn save(&self, patch: Map<String, Value>) -> Settings {
        let mut current = self.current.lock().unwrap();
        let mut merged = to_map(&current);
        for (k, v) in patch {
            merged.insert(k, v);
        }
        let next = coerce(&Value::Object(merged));
        if let Some(dir) = self.file.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let tmp = self.file.with_extension("json.tmp");
        if let Ok(text) = serde_json::to_string_pretty(&next) {
            if fs::write(&tmp, text).is_ok() {
                let _ = fs::rename(&tmp, &self.file);
            }
        }
        *current = next.clone();
        next
    }
}

/// `CommandOrControl+Shift+R` → `Ctrl + Shift + R`.
pub fn hotkey_label(accelerator: &str) -> String {
    if accelerator.is_empty() || accelerator == "off" {
        return "No shortcut".into();
    }
    accelerator
        .replace("CommandOrControl", "Ctrl")
        .replace("Super", "Win")
        .replace('+', " + ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn coerces_types_enums_and_ranges() {
        let s = coerce(&json!({
            "notesDir": 42,
            "captureMic": "yes",
            "chunkSeconds": 9999,
            "whisperThreads": -3,
            "hotkey": "Ctrl+Alt+Delete",
            "liveEngine": "ollama",
            "summaryModel": "  llama3  ",
            "silenceStopMinutes": 0
        }));
        let d = defaults();
        assert_eq!(s.notes_dir, d.notes_dir);
        assert!(s.capture_mic);
        assert_eq!(s.chunk_seconds, 300);
        assert_eq!(s.whisper_threads, 0);
        assert_eq!(s.hotkey, HOTKEY_CHOICES[0]);
        assert_eq!(s.live_engine, "ollama");
        assert_eq!(s.summary_model, "llama3");
        assert_eq!(s.silence_stop_minutes, 0);
    }

    #[test]
    fn garbage_falls_back_to_defaults() {
        assert_eq!(coerce(&json!([1, 2, 3])), defaults());
        assert_eq!(coerce(&Value::Null), defaults());
    }

    #[test]
    fn save_merges_and_persists() {
        let dir = tempfile::tempdir().unwrap();
        let store = SettingsStore::load(dir.path());
        let mut patch = Map::new();
        patch.insert("chunkSeconds".into(), json!(30.4));
        let saved = store.save(patch);
        assert_eq!(saved.chunk_seconds, 30);
        let again = SettingsStore::load(dir.path());
        assert_eq!(again.get().chunk_seconds, 30);
    }

    #[test]
    fn labels_hotkeys() {
        assert_eq!(hotkey_label("CommandOrControl+Shift+R"), "Ctrl + Shift + R");
        assert_eq!(hotkey_label("Super+Shift+X"), "Win + Shift + X");
        assert_eq!(hotkey_label("off"), "No shortcut");
    }
}
