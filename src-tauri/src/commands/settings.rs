//! settings:*, the model download and the whisper.cpp install.

use std::time::Instant;

use serde_json::Value;
use tauri::WebviewWindow;
use tauri_plugin_clipboard_manager::ClipboardExt;
use tokio_util::sync::CancellationToken;

use super::from_library;
use crate::core::{core, SetupJob, PROGRESS_MIN_MS};
use crate::ollama::Ollama;
use crate::recording::check_disk;
use crate::services::{apply_setting, choose_notes_folder, open_ollama, refresh_ollama};
use crate::settings_gate::{gate_library_patch, Installed};
use crate::types::{Outcome, SettingsState, SetupState};
use crate::ui::{diagnostics, notify_settings, settings_state};
use crate::windowing::{notify, show_dictations};
use crate::{log_error, log_info, whisper_setup};

#[tauri::command]
pub fn settings_get(window: WebviewWindow) -> Option<SettingsState> {
    if !from_library(&window) {
        return None;
    }
    check_disk(false);
    Some(settings_state())
}

#[tauri::command]
pub fn settings_set(window: WebviewWindow, patch: Value) -> Option<SettingsState> {
    if !from_library(&window) {
        return None;
    }
    let c = core();
    let (models, devices, whisper_models) = (c.state().models.clone(), c.capture.devices(), c.whisper.models());
    let clean = gate_library_patch(&patch, &Installed { whisper_models: &whisper_models, models: &models, devices: &devices });
    if !clean.is_empty() {
        let keys = clean.keys().cloned().collect::<Vec<_>>().join(", ");
        apply_setting(clean);
        log_info!("settings changed: {keys}");
    }
    Some(settings_state())
}

#[tauri::command]
pub async fn settings_choose_notes_folder(window: WebviewWindow) -> Option<SettingsState> {
    if !from_library(&window) {
        return None;
    }
    choose_notes_folder().await;
    Some(settings_state())
}

#[tauri::command]
pub async fn settings_open_ollama(window: WebviewWindow) -> Option<SettingsState> {
    if !from_library(&window) {
        return None;
    }
    open_ollama().await;
    Some(settings_state())
}

#[tauri::command]
pub fn settings_open_dictations(window: WebviewWindow) {
    if from_library(&window) {
        show_dictations();
    }
}

#[tauri::command]
pub fn settings_open_log(window: WebviewWindow) -> bool {
    if !from_library(&window) {
        return false;
    }
    match crate::logger::path() {
        Some(p) => {
            crate::recording::open_path(&p);
            true
        }
        None => false,
    }
}

#[tauri::command]
pub fn settings_copy_diagnostics(window: WebviewWindow) -> bool {
    from_library(&window) && core().app.clipboard().write_text(diagnostics()).is_ok()
}

#[tauri::command]
pub fn settings_restart_capture(window: WebviewWindow) -> bool {
    if !from_library(&window) {
        return false;
    }
    core().capture.restart();
    true
}

#[tauri::command]
pub fn settings_cancel_setup(window: WebviewWindow) -> Option<SettingsState> {
    if !from_library(&window) {
        return None;
    }
    if let Some(job) = core().state().setup.as_ref() {
        job.cancel.cancel();
    }
    Some(settings_state())
}

#[tauri::command]
pub fn settings_test_mic(window: WebviewWindow) -> Outcome {
    if !from_library(&window) {
        return Outcome::no("");
    }
    crate::voice::start_mic_test()
}

#[tauri::command]
pub fn settings_test_mic_stop(window: WebviewWindow) -> Option<SettingsState> {
    if !from_library(&window) {
        return None;
    }
    crate::voice::stop_mic_test();
    Some(settings_state())
}

/// Updates the download in flight, pushing it to the pane a few times a second.
fn setup_progress(status: String, completed: u64, total: u64) {
    {
        let mut s = core().state();
        let throttle = s.last_setup_at.is_some_and(|t| t.elapsed().as_millis() < PROGRESS_MIN_MS);
        let Some(job) = s.setup.as_mut() else { return };
        job.state.status = status;
        job.state.completed = completed;
        job.state.total = total;
        if throttle {
            return;
        }
        s.last_setup_at = Some(Instant::now());
    }
    notify_settings();
}

/// One download at a time, cancellable, always cleared when it ends.
fn begin_setup(kind: &str, label: &str) -> Result<CancellationToken, Outcome> {
    let mut s = core().state();
    if let Some(job) = &s.setup {
        return Err(Outcome::no(format!("{} is already downloading.", job.state.label)));
    }
    let cancel = CancellationToken::new();
    s.setup = Some(SetupJob {
        state: SetupState { kind: kind.into(), label: label.into(), status: "starting".into(), completed: 0, total: 0 },
        cancel: cancel.clone(),
    });
    Ok(cancel)
}

fn end_setup(label: &str, result: Result<(), String>, cancel: &CancellationToken) -> Outcome {
    core().state().setup = None;
    notify_settings();
    match result {
        Ok(()) => Outcome::ok(),
        Err(_) if cancel.is_cancelled() => {
            log_info!("{label}: cancelled");
            Outcome::no("")
        }
        Err(e) => {
            log_error!("{label} failed: {e}");
            Outcome::no(e)
        }
    }
}

/// Only the two models the settings already name can be pulled — no string a
/// page can invent should reach `ollama pull`.
#[tauri::command]
pub async fn settings_pull_model(window: WebviewWindow, name: String) -> Outcome {
    if !from_library(&window) {
        return Outcome::no("");
    }
    let c = core();
    let settings = c.settings();
    if !c.state().ollama_up {
        return Outcome::no(format!("Nothing is listening at {}.", settings.ollama_host));
    }
    if name != settings.transcribe_model && name != settings.summary_model {
        return Outcome::no("Minarrador only downloads the models it is set to use.");
    }
    let cancel = match begin_setup("model", &name) {
        Ok(c) => c,
        Err(o) => return o,
    };
    notify_settings();
    let result = Ollama::new(&settings.ollama_host)
        .pull(&name, |p| setup_progress(p.status, p.completed, p.total), &cancel)
        .await
        .map(|_| ())
        .map_err(|e| e.message);
    let outcome = end_setup(&name, result, &cancel);
    if outcome.ok {
        refresh_ollama().await;
        notify("Model ready", &format!("{name} is installed. Minarrador can transcribe and write notes now."), None);
    } else if let Some(reason) = outcome.reason.as_ref().filter(|r| !r.is_empty()) {
        notify("Could not download the model", reason, None);
    }
    outcome
}

#[tauri::command]
pub async fn settings_install_whisper(window: WebviewWindow, model: String) -> Outcome {
    if !from_library(&window) {
        return Outcome::no("");
    }
    if !whisper_setup::is_model(&model) {
        return Outcome::no("That is not a model Minarrador knows how to fetch.");
    }
    let c = core();
    let root = {
        let configured = c.settings().whisper_root;
        if configured.is_empty() { c.user_data.join("whisper") } else { configured.into() }
    };
    let label = format!("whisper.cpp · ggml-{model}");
    let cancel = match begin_setup("whisper", &label) {
        Ok(c) => c,
        Err(o) => return o,
    };
    notify_settings();
    let result = whisper_setup::install(&root, &model, &cancel, |p| setup_progress(p.status, p.completed, p.total)).await.map(|_| ());
    let outcome = end_setup(&label, result, &cancel);
    if !outcome.ok {
        if let Some(reason) = outcome.reason.as_ref().filter(|r| !r.is_empty()) {
            notify("Could not install whisper.cpp", reason, None);
        }
        return outcome;
    }
    let mut patch = serde_json::Map::new();
    patch.insert("whisperModel".into(), Value::from(format!("ggml-{model}.bin")));
    crate::services::apply_whisper_config();
    apply_setting(patch);
    log_info!("whisper.cpp installed into {}", root.display());
    notify("whisper.cpp is ready", &format!("ggml-{model} is installed. Transcription runs locally and several times faster now."), None);
    outcome
}
