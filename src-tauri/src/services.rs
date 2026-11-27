//! Ollama, the global shortcuts, and applying a setting — the single path
//! both the tray and the settings pane write through.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde_json::{Map, Value};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use crate::capture::CaptureConfig;
use crate::core::core;
use crate::ollama::{launch_ollama, Ollama};
use crate::recording::{apply_sleep_blocker, check_disk, toggle_recording};
use crate::settings::Settings;
use crate::ui::{notify_library, notify_settings, refresh_tray};
use crate::windowing::notify;
use crate::{log_error, log_info, log_warn};

const OLLAMA_START_TIMEOUT: Duration = Duration::from_secs(30);

/// Re-reads whether Ollama answers and what it has; swaps out a configured
/// model that is no longer installed rather than failing a meeting on it.
pub async fn refresh_ollama() {
    let c = core();
    let client = Ollama::new(&c.settings().ollama_host);
    let up = client.is_up().await;
    let (changed, need_models) = {
        let mut s = c.state();
        let changed = up != s.ollama_up;
        s.ollama_up = up;
        (changed, up && (changed || s.models.is_empty()))
    };
    if need_models {
        let models = client.list_models().await;
        let audio = client.audio_models().await;
        {
            let mut s = c.state();
            s.models = models.clone();
            s.audio_models = audio.clone();
        }
        let settings = c.settings();
        if !models.is_empty() && !models.contains(&settings.transcribe_model) {
            let replacement = audio.first().or(models.first()).cloned().unwrap_or_default();
            let previous = settings.transcribe_model.clone();
            save(&[("transcribeModel", Value::from(replacement.clone()))]);
            log_warn!("transcription model {previous} is not installed; switched to {replacement}");
            notify(
                "Transcription model changed",
                &format!("{previous} is no longer installed, so Minarrador switched to {replacement}. Pick another under Settings → Transcription model."),
                None,
            );
        }
        if !models.is_empty() && !models.contains(&c.settings().summary_model) {
            save(&[("summaryModel", Value::from(models[0].clone()))]);
            log_warn!("notes model missing; switched to {}", models[0]);
        }
    } else if !up {
        let mut s = c.state();
        s.models.clear();
        s.audio_models.clear();
    }
    apply_live_config();
    refresh_tray();
    if changed || !c.state().models.is_empty() {
        notify_settings();
    }
}

fn save(pairs: &[(&str, Value)]) -> Settings {
    let mut patch = Map::new();
    for (k, v) in pairs {
        patch.insert((*k).into(), v.clone());
    }
    core().store.save(patch)
}

/// Starts Ollama and waits for it to answer, rather than asking someone to go
/// and run `ollama serve`.
pub async fn open_ollama() {
    let c = core();
    {
        let mut s = c.state();
        if s.ollama_checking {
            return;
        }
        s.ollama_checking = true;
    }
    refresh_tray();
    notify_settings();
    let launched = if c.state().ollama_up {
        Ok(None)
    } else {
        launch_ollama().map(Some)
    };
    let result: Result<Option<PathBuf>, String> = match launched {
        Err(e) => Err(e.message),
        Ok(exe) => {
            if let Some(e) = &exe {
                log_info!("starting Ollama: {}", e.display());
            }
            let deadline = Instant::now() + OLLAMA_START_TIMEOUT;
            loop {
                refresh_ollama().await;
                if c.state().ollama_up || exe.is_none() || Instant::now() >= deadline {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(1500)).await;
            }
            Ok(exe)
        }
    };
    c.state().ollama_checking = false;
    refresh_tray();
    notify_settings();
    let host = c.settings().ollama_host;
    match result {
        Err(e) => {
            log_error!("could not start Ollama: {e}");
            notify("Could not start Ollama", &e, None);
        }
        Ok(_) if c.state().ollama_up => {
            let n = c.state().models.len();
            notify("Ollama is running", &format!("{n} model(s) available at {host}."), None);
        }
        Ok(exe) => {
            let name = exe.and_then(|e| e.file_name().map(|n| n.to_string_lossy().into_owned())).unwrap_or_else(|| "ollama".into());
            notify("Ollama did not answer", &format!("{name} was started but nothing is listening at {host} yet."), None);
        }
    }
}

/// Registers one global shortcut, replacing whatever `previous` held.
/// Returns whether the combination was ours to take.
fn register(previous: Option<String>, accelerator: &str, action: fn()) -> (Option<String>, bool) {
    let gs = core().app.global_shortcut();
    if let Some(p) = previous {
        let _ = gs.unregister(p.as_str());
    }
    if accelerator.is_empty() || accelerator == "off" {
        return (None, false);
    }
    let ok = gs
        .on_shortcut(accelerator, move |_app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                action();
            }
        })
        .is_ok();
    log_info!("hotkey {accelerator} {}", if ok { "registered" } else { "is held by another application" });
    (ok.then(|| accelerator.to_string()), ok)
}

/// The recording shortcut — because the first twenty seconds of a call are
/// exactly where finding a tray icon means the meeting goes unrecorded.
pub fn apply_hotkey() {
    let previous = core().state().hotkey.take();
    let (held, ok) = register(previous, &core().settings().hotkey, toggle_recording);
    let mut s = core().state();
    s.hotkey = held;
    s.hotkey_registered = ok;
}

pub fn apply_dictate_hotkey() {
    let previous = core().state().dictate_hotkey.take();
    let (held, ok) = register(previous, &core().settings().dictate_hotkey, crate::voice::toggle_dictation);
    let mut s = core().state();
    s.dictate_hotkey = held;
    s.dictate_hotkey_registered = ok;
}

/// A change made on this machine: applied, then queued for sync when it
/// touches a setting that travels between machines.
pub fn apply_setting(patch: Map<String, Value>) -> Settings {
    let synced = patch.keys().any(|k| crate::cloud::SYNCED_SETTINGS.contains(&k.as_str()));
    let settings = apply_patch(patch);
    if synced {
        crate::cloud::changed("settings");
    }
    settings
}

/// Saves a patch and applies whatever it changes — shared by local changes
/// and settings arriving from the account.
pub fn apply_patch(patch: Map<String, Value>) -> Settings {
    let keys: Vec<String> = patch.keys().cloned().collect();
    let has = |k: &str| keys.iter().any(|x| x == k);
    let settings = core().store.save(patch);
    if has("startAtLogin") {
        apply_login_item();
    }
    if has("hotkey") {
        apply_hotkey();
    }
    if has("dictateHotkey") {
        apply_dictate_hotkey();
    }
    if has("preventSleep") {
        apply_sleep_blocker();
    }
    if has("desktopTodos") {
        crate::desktop_todos::apply(false);
    }
    if has("silenceStopMinutes") {
        core().capture.set_silence_minutes(settings.silence_stop_minutes);
    }
    if ["captureMic", "captureSystem", "micDeviceId", "micDeviceLabel"].iter().any(|k| has(k)) {
        apply_capture_config();
    }
    if ["whisperModel", "whisperThreads"].iter().any(|k| has(k)) {
        apply_whisper_config();
    }
    if ["liveTranscript", "transcribeModel", "liveEngine", "whisperModel"].iter().any(|k| has(k)) {
        apply_live_config();
    }
    refresh_tray();
    notify_settings();
    settings
}

/// The notes folder comes from a dialog, where the path comes from the user —
/// never from the page.
pub async fn choose_notes_folder() -> bool {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = core().app.dialog().file().set_title("Choose where meetings are saved").set_directory(core().notes_dir());
    if let Some(w) = crate::windowing::window(crate::windowing::LIBRARY) {
        dialog = dialog.set_parent(&w);
    }
    dialog.pick_folder(move |picked| {
        let _ = tx.send(picked);
    });
    let Some(Some(picked)) = rx.await.ok() else { return false };
    let Ok(path) = picked.into_path() else { return false };
    save(&[("notesDir", Value::from(path.to_string_lossy().into_owned()))]);
    let _ = std::fs::create_dir_all(&path);
    core().state().disk = Default::default();
    check_disk(true);
    refresh_tray();
    notify_settings();
    notify_library();
    true
}

/// Registers (or removes) the login item, with `--hidden` so a start at login
/// raises no notification. Development builds never register themselves.
pub fn apply_login_item() {
    if cfg!(debug_assertions) {
        return;
    }
    use winreg::enums::{HKEY_CURRENT_USER, KEY_SET_VALUE};
    let Ok(run) = winreg::RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags("Software\\Microsoft\\Windows\\CurrentVersion\\Run", KEY_SET_VALUE)
    else {
        return;
    };
    if core().settings().start_at_login {
        if let Ok(exe) = std::env::current_exe() {
            let _ = run.set_value("Minarrador", &format!("\"{}\" --hidden", exe.display()));
        }
    } else {
        let _ = run.delete_value("Minarrador");
    }
}

pub fn apply_capture_config() {
    let s = core().settings();
    core().capture.set_active(
        true,
        CaptureConfig {
            active: true,
            capture_mic: s.capture_mic,
            capture_system: s.capture_system,
            mic_device_id: s.mic_device_id,
            mic_device_label: s.mic_device_label,
        },
    );
}

/// Where whisper.cpp may live: the app's own install, then (in development)
/// the checkout's vendor folder. A configured root replaces both.
pub fn whisper_roots() -> Vec<PathBuf> {
    let s = core().settings();
    if !s.whisper_root.is_empty() {
        return vec![PathBuf::from(s.whisper_root)];
    }
    let mut roots = vec![core().user_data.join("whisper")];
    if cfg!(debug_assertions) {
        roots.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("vendor").join("whisper"));
    }
    roots
}

pub fn apply_whisper_config() {
    let s = core().settings();
    core().whisper.configure(Some(whisper_roots()), &s.whisper_model, s.whisper_threads);
}

pub fn apply_live_config() {
    let s = core().settings();
    core().capture.configure_live(s.live_transcript, &s.live_engine, &s.transcribe_model);
}
