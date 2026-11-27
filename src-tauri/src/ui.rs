//! What the windows and the tray are told, and when.
//!
//! `library:changed` fires at the four moments the folder changes (recording
//! start and end, pipeline start and end) — never from the one-second tray tick,
//! which would have the window re-reading every transcript for a clock.
//! Progress rides its own channel, throttled, and is applied in place.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;
use std::time::Instant;

use crate::core::{core, folder_name, Phase, DISK_WARN_BYTES, PROGRESS_MIN_MS};
use crate::paths::{self, speaker_line};
use crate::settings::{defaults, hotkey_label, DICTATE_HOTKEY_CHOICES, HOTKEY_CHOICES};
use crate::types::*;
use crate::windowing::emit_library;
use crate::{log_warn, ollama, whisper_setup};

/// The health strip shows for the first seconds of a recording, because the
/// failure it exists for can only be seen by listening.
pub const HEALTH_WINDOW_SECONDS: f64 = 10.0;
const HEARD_RMS: f32 = 0.006;

fn hotkey_state(value: &str, registered: bool, choices: &[&str]) -> HotkeyState {
    HotkeyState {
        value: value.into(),
        registered,
        choices: choices.iter().map(|v| Choice { value: v.to_string(), label: hotkey_label(v) }).collect(),
    }
}

pub fn settings_state() -> SettingsState {
    let c = core();
    let settings = c.settings();
    let s = c.state();
    let status = c.capture.status();
    let mut pullable: Vec<String> = vec![];
    for name in [&settings.transcribe_model, &settings.summary_model] {
        if !name.is_empty() && !s.models.contains(name) && !pullable.contains(name) {
            pullable.push(name.clone());
        }
    }
    SettingsState {
        version: c.version(),
        defaults: defaults(),
        models: s.models.clone(),
        audio_models: s.audio_models.clone(),
        whisper: Some(c.whisper.describe()),
        ollama: OllamaState {
            host: settings.ollama_host.clone(),
            up: s.ollama_up,
            checking: s.ollama_checking,
            installed: ollama::find_ollama().is_some(),
        },
        live_engine: c.capture.live.engine(),
        mic: MicState {
            devices: c.capture.devices(),
            active: status.mic_label.clone(),
            chosen: settings.mic_device_id.clone(),
            chosen_label: settings.mic_device_label.clone(),
        },
        recording_channels: c.capture.recording_channels(settings.separate_channels),
        disk: DiskState { free: s.disk.free, low: s.disk.free.is_some_and(|f| f < DISK_WARN_BYTES) },
        setup: s.setup.as_ref().map(|j| j.state.clone()),
        whisper_models: whisper_setup::MODELS.iter().map(|(k, note)| Choice { value: k.to_string(), label: format!("{k} — {note}") }).collect(),
        pullable,
        hotkey: hotkey_state(&settings.hotkey, s.hotkey_registered, &HOTKEY_CHOICES),
        dictate_hotkey: hotkey_state(&settings.dictate_hotkey, s.dictate_hotkey_registered, &DICTATE_HOTKEY_CHOICES),
        dictation: DictationFlags { active: c.dictation.active(), transcribing: c.dictation.transcribing() },
        notes_dir_exists: Path::new(&settings.notes_dir).exists(),
        snippet_count: c.snippets.list().len(),
        recording: s.phase == Phase::Recording,
        settings,
    }
}

pub fn library_activity() -> LibraryActivity {
    let c = core();
    let settings = c.settings();
    let s = c.state();
    let recording = s.phase == Phase::Recording;
    LibraryActivity {
        recording_id: if recording { s.current_dir.as_deref().map(folder_name) } else { None },
        elapsed: if recording { c.capture.elapsed_seconds() } else { 0.0 },
        paused: recording && c.capture.paused(),
        live_engine: if recording && settings.live_transcript {
            if c.capture.live.engine() == Engine::Whisper { "whisper.cpp".into() } else { settings.transcribe_model.clone() }
        } else {
            String::new()
        },
        processing_ids: s.jobs.keys().map(|d| folder_name(d)).collect(),
        processing: s.jobs.iter().map(|(d, j)| ProcessingEntry { id: folder_name(d), progress: j.progress.clone() }).collect(),
    }
}

fn item(key: &'static str, label: &'static str, state: &'static str, detail: impl Into<String>) -> HealthItem {
    HealthItem { key, label, state, detail: detail.into() }
}

/// Whether the next (or just-started) meeting will produce notes.
pub fn health() -> Health {
    let c = core();
    let settings = c.settings();
    let status = c.capture.status();
    let (recording, heard, ollama_up, has_model) = {
        let s = c.state();
        (s.phase == Phase::Recording, s.heard, s.ollama_up, s.models.contains(&settings.summary_model))
    };
    let elapsed = if recording { c.capture.elapsed_seconds() } else { 0.0 };
    let early = recording && elapsed < HEALTH_WINDOW_SECONDS;
    let source = |key: &'static str, label: &'static str, enabled: bool, open: bool, error: &str, heard: f32| {
        if !enabled {
            return item(key, label, "off", "Not recorded — turned off in Settings.");
        }
        if !open {
            let fallback = if key == "mic" { "The microphone did not open." } else { "System audio did not open." };
            return item(key, label, "warn", if error.is_empty() { fallback.to_string() } else { error.to_string() });
        }
        if !recording {
            return item(
                key,
                label,
                "ok",
                if key == "mic" {
                    if status.mic_label.is_empty() { "Open.".to_string() } else { format!("Open: {}.", status.mic_label) }
                } else {
                    "Open, ready to hear the call.".to_string()
                },
            );
        }
        if heard >= HEARD_RMS {
            return item(key, label, "ok", "Hearing sound.");
        }
        if early {
            return item(key, label, "wait", "Listening… nothing heard yet.");
        }
        item(
            key,
            label,
            "warn",
            if key == "mic" {
                "Open, but silent so far. Is the microphone muted?"
            } else {
                "Silent so far. Is the call playing through a different output device?"
            },
        )
    };
    let mic = source("mic", "Mic", settings.capture_mic, status.mic_ok, &status.mic_error, heard.0);
    let system = source("system", "System", settings.capture_system, status.system_ok, &status.system_error, heard.1);
    let whisper = if c.whisper.available() {
        item("whisper", "Whisper", "ok", format!("Installed: {}.", c.whisper.model_name()))
    } else {
        item("whisper", "Whisper", "warn", "Not installed. The Ollama audio model transcribes instead, which takes about as long as the meeting.")
    };
    let notes_model = &settings.summary_model;
    let ollama = if !ollama_up {
        item("ollama", "Ollama", "warn", "Not running. The audio is kept, but no notes until it is.")
    } else if !has_model {
        item("ollama", "Ollama", "warn", format!("Running, but {notes_model} is not installed."))
    } else {
        item("ollama", "Ollama", "ok", format!("Running, with {notes_model}."))
    };
    let show = !recording || early || mic.state == "warn" || system.state == "warn";
    Health { items: vec![mic, system, whisper, ollama], recording, elapsed, show }
}

pub fn send_health() {
    if crate::windowing::window(crate::windowing::LIBRARY).is_some() {
        emit_library("library:health", health());
    }
}

pub fn health_ticking() -> bool {
    core().state().phase == Phase::Recording && core().capture.elapsed_seconds() <= HEALTH_WINDOW_SECONDS + 2.0
}

pub fn hear(levels: &CaptureLevels) {
    let mut s = core().state();
    if s.phase != Phase::Recording {
        return;
    }
    s.heard.0 = s.heard.0.max(levels.mic);
    s.heard.1 = s.heard.1.max(levels.system);
}

pub fn notify_library() {
    emit_library("library:changed", ());
    send_health();
    refresh_tray();
    tauri::async_runtime::spawn_blocking(|| {
        let retry = find_retry_candidate();
        core().state().retry = retry;
    });
}

/// The newest meeting with audio and no notes that nothing is working on.
fn find_retry_candidate() -> Option<(String, String)> {
    let c = core();
    let (recording_id, busy): (Option<String>, Vec<String>) = {
        let s = c.state();
        (
            if s.phase == Phase::Recording { s.current_dir.as_deref().map(folder_name) } else { None },
            s.jobs.keys().map(|d| folder_name(d)).collect(),
        )
    };
    let notes = c.notes_dir();
    let meetings = crate::library::list_meetings(&notes, "", &mut c.cache.lock().unwrap());
    let found = meetings.into_iter().find(|m| m.files.audio && m.status != "ready" && Some(&m.id) != recording_id.as_ref() && !busy.contains(&m.id))?;
    let label = chrono::DateTime::parse_from_rfc3339(&found.started_at)
        .map(|d| d.with_timezone(&chrono::Local).format("%b %-d, %-I:%M %p").to_string())
        .unwrap_or_else(|_| found.id.clone());
    Some((found.id, label))
}

pub fn notify_settings() {
    emit_library("settings:changed", ());
    send_health();
}

pub fn send_activity() {
    emit_library("library:progress", library_activity());
}

pub fn notify_progress() {
    {
        let mut s = core().state();
        if s.last_progress_at.is_some_and(|t| t.elapsed().as_millis() < PROGRESS_MIN_MS) {
            return;
        }
        s.last_progress_at = Some(Instant::now());
    }
    send_activity();
}

pub fn send_live_line(text: &str, speaker: Speaker) {
    let line = text.trim();
    let Some(dir) = core().state().live_dir.clone() else { return };
    if line.is_empty() {
        return;
    }
    emit_library("library:liveLine", LiveLine { id: folder_name(&dir), text: line.into(), speaker });
}

/// Every caption is on disk before it is on screen: appended line by line, so
/// a crash or a power cut still leaves a rough transcript.
pub fn append_live_transcript(text: &str, speaker: Speaker) {
    let line = text.trim();
    let Some(dir) = core().state().live_dir.clone() else { return };
    if line.is_empty() {
        return;
    }
    let result = OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(paths::LIVE_TRANSCRIPT))
        .and_then(|mut f| writeln!(f, "{}", speaker_line(speaker, line)));
    if let Err(e) = result {
        log_warn!("could not append to the live transcript: {e}");
    }
}

pub fn refresh_tray() {
    let c = core();
    let settings = c.settings();
    let (phase, progress, current) = {
        let s = c.state();
        (s.phase, s.progress.clone(), if s.phase == Phase::Recording { s.current_dir.as_deref().map(folder_name) } else { None })
    };
    let view = crate::tray::TrayView {
        phase,
        elapsed: c.capture.elapsed_seconds(),
        progress,
        current_dir: current.unwrap_or_default(),
        snippets: c.snippets.list(),
        hotkey: if settings.hotkey == "off" { String::new() } else { hotkey_label(&settings.hotkey) },
        dictation_active: c.dictation.active(),
        dictation_transcribing: c.dictation.transcribing(),
        dictate_hotkey: if settings.dictate_hotkey == "off" { String::new() } else { hotkey_label(&settings.dictate_hotkey) },
    };
    if let Some(tray) = c.tray.lock().unwrap().as_mut() {
        tray.update(&c.app, view);
    }
}

pub fn diagnostics() -> String {
    let c = core();
    let s = c.state();
    let doc = serde_json::json!({
        "version": c.version(),
        "platform": format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
        "packaged": !cfg!(debug_assertions),
        "startedHidden": c.started_hidden,
        "phase": format!("{:?}", s.phase),
        "ollamaUp": s.ollama_up,
        "models": s.models,
        "audioModels": s.audio_models,
        "whisper": c.whisper.describe(),
        "hotkeyRegistered": s.hotkey_registered,
        "dictateActive": c.dictation.active(),
        "dictateHotkeyRegistered": s.dictate_hotkey_registered,
        "retry": s.retry,
        "captureStatus": c.capture.status(),
        "micDevices": c.capture.devices(),
        "levels": c.capture.levels(),
        "diskFreeBytes": s.disk.free,
        "sleepBlocked": s.sleep_blocker.is_some(),
        "settings": c.settings(),
        "logPath": crate::logger::path(),
    });
    drop(s);
    let mut doc = doc;
    doc["liveEngine"] = serde_json::json!(c.capture.live.engine());
    doc["health"] = serde_json::json!(health().items.iter().map(|i| serde_json::json!({ "key": i.key, "state": i.state, "detail": i.detail })).collect::<Vec<_>>());
    serde_json::to_string_pretty(&doc).unwrap_or_default()
}
