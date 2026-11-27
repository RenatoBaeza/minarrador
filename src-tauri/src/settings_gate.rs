//! What a settings patch from the window may change.
//!
//! The window is still a page, so a patch is filtered here to a fixed set of
//! keys. Nothing in that set names a place: the notes folder, the Ollama host
//! and the whisper root are paths, and a page that could set one could point
//! this app's reading and writing anywhere on the machine. The two model names
//! and the mic device are checked against what is actually installed.

use serde_json::{Map, Value};

use crate::types::AudioDevice;

pub const LIBRARY_SETTINGS: [&str; 22] = [
    "suggestOnAudio",
    "startAtLogin",
    "liveTranscript",
    "captureMic",
    "captureSystem",
    "separateChannels",
    "micDeviceId",
    "micDeviceLabel",
    "silenceStopMinutes",
    "maxRecordingMinutes",
    "preventSleep",
    "hotkey",
    "dictateHotkey",
    "dictateEngine",
    "dictateAutoPaste",
    "desktopTodos",
    "liveEngine",
    "transcribeEngine",
    "whisperModel",
    "whisperThreads",
    "transcribeModel",
    "summaryModel",
];

pub const PATH_SETTINGS: [&str; 3] = ["notesDir", "ollamaHost", "whisperRoot"];

pub struct Installed<'a> {
    pub whisper_models: &'a [String],
    pub models: &'a [String],
    pub devices: &'a [AudioDevice],
}

pub fn gate_library_patch(patch: &Value, installed: &Installed) -> Map<String, Value> {
    let mut clean = Map::new();
    if let Value::Object(given) = patch {
        for (k, v) in given {
            if LIBRARY_SETTINGS.contains(&k.as_str()) {
                clean.insert(k.clone(), v.clone());
            }
        }
    }
    let has = |list: &[String], v: Option<&Value>| v.and_then(Value::as_str).is_some_and(|s| list.iter().any(|m| m == s));
    if clean.contains_key("whisperModel") && !has(installed.whisper_models, clean.get("whisperModel")) {
        clean.remove("whisperModel");
    }
    for key in ["transcribeModel", "summaryModel"] {
        if clean.contains_key(key) && !has(installed.models, clean.get(key)) {
            clean.remove(key);
        }
    }
    if let Some(id) = clean.get("micDeviceId").and_then(Value::as_str) {
        if !id.is_empty() && !installed.devices.iter().any(|d| d.id == id) {
            clean.remove("micDeviceId");
            clean.remove("micDeviceLabel");
        }
    }
    clean
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn no_path_is_settable() {
        for p in PATH_SETTINGS {
            assert!(!LIBRARY_SETTINGS.contains(&p));
        }
    }

    #[test]
    fn filters_unknown_and_uninstalled() {
        let models = vec!["gemma4:12b".to_string()];
        let devices = vec![AudioDevice { id: "Mic A".into(), label: "Mic A".into() }];
        let installed = Installed { whisper_models: &[], models: &models, devices: &devices };
        let out = gate_library_patch(
            &json!({
                "notesDir": "C:\\", "captureMic": false, "summaryModel": "gemma4:12b",
                "transcribeModel": "evil", "whisperModel": "x.bin", "micDeviceId": "ghost", "micDeviceLabel": "Ghost"
            }),
            &installed,
        );
        assert_eq!(out.get("captureMic"), Some(&json!(false)));
        assert_eq!(out.get("summaryModel"), Some(&json!("gemma4:12b")));
        for gone in ["notesDir", "transcribeModel", "whisperModel", "micDeviceId", "micDeviceLabel"] {
            assert!(!out.contains_key(gone), "{gone}");
        }
        let default_mic = gate_library_patch(&json!({ "micDeviceId": "", "micDeviceLabel": "" }), &installed);
        assert_eq!(default_mic.len(), 2);
    }
}
