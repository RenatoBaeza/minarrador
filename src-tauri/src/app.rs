//! The app's lifecycle and the wiring between its parts, and nothing else.
//!
//! Startup is all-or-nothing: a tray-only app that fails during init has
//! nowhere to say so, so it reports the failure and exits instead of sitting in
//! Task Manager with no icon. Quitting mid-recording seals the WAV and leaves a
//! note; quitting mid-pipeline cancels it and leaves the same note.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use tauri::{AppHandle, Manager};
use tokio::sync::mpsc::unbounded_channel;

use crate::capture::{CaptureController, CaptureEvent};
use crate::core::{self, core, Core, Phase};
use crate::dictation::DictationController;
use crate::library::LibraryCache;
use crate::live::LiveTranscriber;
use crate::ollama::Ollama;
use crate::pipeline::fmt_duration;
use crate::recording::{apply_sleep_blocker, check_disk, check_recording_limits, finalize_recording, start_recording, stop_recording, write_resume_note};
use crate::services::{apply_capture_config, apply_dictate_hotkey, apply_hotkey, apply_live_config, apply_login_item, refresh_ollama, whisper_roots};
use crate::settings::{hotkey_label, SettingsStore};
use crate::stores::{self, ListStore};
use crate::ui::{append_live_transcript, health_ticking, hear, notify_library, notify_settings, refresh_tray, send_health, send_live_line};
use crate::whisper::WhisperServer;
use crate::windowing::notify;
use crate::{log_error, log_info, log_warn};

const OLLAMA_POLL: Duration = Duration::from_secs(60);

/// Electron kept everything in %APPDATA%\Minarrador; so does this build, so
/// settings, shorthands, tasks and dictations carry straight over.
/// `MINARRADOR_DATA_DIR` points a development run somewhere else entirely.
fn user_data(app: &AppHandle) -> PathBuf {
    if let Some(dir) = std::env::var_os("MINARRADOR_DATA_DIR").filter(|d| !d.is_empty()) {
        return PathBuf::from(dir);
    }
    app.path().data_dir().map(|d| d.join("Minarrador")).unwrap_or_else(|_| PathBuf::from("Minarrador"))
}

pub fn setup(app: &AppHandle) -> Result<(), String> {
    let user_data = user_data(app);
    crate::logger::init(&user_data);
    let hidden = std::env::args().any(|a| a == "--hidden");
    log_info!("Minarrador {} starting (hidden={hidden}, packaged={})", app.package_info().version, !cfg!(debug_assertions));
    if !cfg!(debug_assertions) {
        crate::win::set_app_user_model_id(&app.config().identifier);
    }
    if let Ok(docs) = app.path().document_dir() {
        crate::settings::set_documents_dir(&docs);
    }
    let first_run = !SettingsStore::exists(&user_data);
    let store = SettingsStore::load(&user_data);
    let settings = store.get();
    std::fs::create_dir_all(&settings.notes_dir).map_err(|e| format!("cannot create {}: {e}", settings.notes_dir))?;

    let mut roots = vec![user_data.join("whisper")];
    if !settings.whisper_root.is_empty() {
        roots = vec![PathBuf::from(&settings.whisper_root)];
    } else if cfg!(debug_assertions) {
        roots.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("vendor").join("whisper"));
    }
    let whisper = Arc::new(WhisperServer::new(roots, &settings.whisper_model, settings.whisper_threads));
    let ollama = Ollama::new(&settings.ollama_host);
    let (capture_tx, mut capture_rx) = unbounded_channel::<CaptureEvent>();
    let (dictate_tx, mut dictate_rx) = unbounded_channel();
    let live = LiveTranscriber::new(whisper.clone(), ollama.clone());
    let capture = CaptureController::new(capture_tx, live);
    let dictation = DictationController::new(dictate_tx, whisper.clone(), ollama, user_data.join("dictation-errors"));

    let c = Arc::new(Core {
        app: app.clone(),
        started_hidden: hidden,
        store,
        state: Mutex::new(Default::default()),
        whisper: whisper.clone(),
        capture,
        dictation,
        cache: Mutex::new(LibraryCache::new()),
        snippets: ListStore::open(user_data.join("snippets.json"), stores::snippets::normalize),
        todos: ListStore::open(user_data.join("todos.json"), stores::todos::normalize),
        dictations: ListStore::open(user_data.join("dictations.json"), stores::dictations::normalize),
        disk_scan: Mutex::new(None),
        disk_cancel: Mutex::new(None),
        tray: Mutex::new(None),
        user_data,
    });
    core::install(c.clone());
    apply_login_item();
    check_disk(true);
    c.whisper.configure(Some(whisper_roots()), &settings.whisper_model, settings.whisper_threads);
    log_info!(
        "{}",
        if c.whisper.available() {
            format!("whisper.cpp found: {} in {}", c.whisper.model_name(), c.whisper.install().root.display())
        } else {
            format!("whisper.cpp not installed in {} — the live preview falls back to Ollama", c.whisper.install().root.display())
        }
    );
    whisper.on_change(Arc::new(refresh_tray));

    *c.tray.lock().unwrap() = Some(crate::tray::AppTray::create(app).map_err(|e| format!("tray: {e}"))?);

    tauri::async_runtime::spawn(async move {
        while let Some(event) = capture_rx.recv().await {
            on_capture(event);
        }
    });
    tauri::async_runtime::spawn(async move {
        while let Some(event) = dictate_rx.recv().await {
            crate::voice::on_event(event);
        }
    });

    c.capture.init();
    apply_capture_config();
    apply_live_config();
    apply_hotkey();
    apply_dictate_hotkey();
    watch_for_resume();
    crate::desktop_todos::apply(true);
    notify_library();

    tauri::async_runtime::spawn(async move {
        refresh_ollama().await;
        loop {
            tokio::time::sleep(OLLAMA_POLL).await;
            refresh_ollama().await;
        }
    });
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            if core().state().phase != Phase::Recording {
                continue;
            }
            refresh_tray();
            check_recording_limits();
            if health_ticking() {
                send_health();
            }
        }
    });

    if first_run {
        let start = if settings.hotkey != "off" { hotkey_label(&settings.hotkey) } else { "the tray icon".into() };
        let dictate = if settings.dictate_hotkey != "off" {
            format!(" Press {} to speak a sentence into whatever you are typing.", hotkey_label(&settings.dictate_hotkey))
        } else {
            String::new()
        };
        notify("Welcome to Minarrador", &format!("Record a meeting from anywhere with {start} — the waveform icon lives in the tray.{dictate}"), None);
    } else if !hidden {
        notify("Minarrador is running", "Use the waveform icon in your system tray to start recording.", None);
    }
    refresh_tray();
    // `--library` opens the window straight away (a shortcut, or development).
    if std::env::args().any(|a| a == "--library") {
        crate::windowing::show_library(None);
    }
    Ok(())
}

fn on_capture(event: CaptureEvent) {
    match event {
        CaptureEvent::Status(_) => {
            refresh_tray();
            notify_settings();
        }
        CaptureEvent::Devices(_) => notify_settings(),
        CaptureEvent::Levels(levels) => hear(&levels),
        CaptureEvent::Transcript(text, speaker) => {
            append_live_transcript(&text, speaker);
            send_live_line(&text, speaker);
        }
        CaptureEvent::Speech => {
            if core().settings().suggest_on_audio && core().state().phase != Phase::Recording {
                notify("Sounds like a meeting", "Minarrador heard sustained audio. Click to start recording.", Some(Box::new(start_recording)));
            }
        }
        CaptureEvent::Silence(minutes) => {
            if core().state().phase == Phase::Recording {
                log_info!("stopping the recording after {minutes} minutes of silence");
                notify("Recording stopped", &format!("Nothing was audible for {minutes} minutes, so Minarrador stopped and is writing the notes."), None);
                tauri::async_runtime::spawn(stop_recording());
            }
        }
        CaptureEvent::WriteFailed { error, seconds } => {
            log_error!("the recording could not be written: {error}");
            notify("Recording stopped", &format!("Minarrador could not keep writing the audio ({error}). {} was saved.", fmt_duration(seconds)), None);
            tauri::async_runtime::spawn(stop_recording());
        }
        CaptureEvent::WorkerGone { was_recording, recovering } => {
            refresh_tray();
            if !recovering {
                notify(
                    "Audio capture has stopped",
                    if was_recording {
                        "The capture worker keeps crashing. Stop the recording to keep what was captured so far."
                    } else {
                        "The capture worker keeps crashing. Try Settings → Restart audio capture."
                    },
                    None,
                );
            } else if was_recording {
                notify("Audio capture restarted", "A few seconds of the meeting were lost. Recording continues into the same file.", None);
            }
        }
    }
}

/// A lid close suspends the machine regardless of any sleep block. When the
/// wall clock jumps far past what a short sleep should take, the machine was
/// asleep: rebuild the audio sources and re-arm them into the same file.
fn watch_for_resume() {
    std::thread::Builder::new()
        .name("resume-watch".into())
        .spawn(|| {
            let step = Duration::from_secs(5);
            let mut last = SystemTime::now();
            loop {
                std::thread::sleep(step);
                let now = SystemTime::now();
                let gap = now.duration_since(last).unwrap_or_default();
                last = now;
                if gap > step + Duration::from_secs(25) {
                    on_resume(gap.as_secs_f64() - step.as_secs_f64());
                }
            }
        })
        .ok();
}

fn on_resume(asleep: f64) {
    log_info!("the machine resumed after {}", fmt_duration(asleep));
    let c = core();
    let was_recording = c.state().phase == Phase::Recording;
    c.capture.restart();
    crate::desktop_todos::on_resume();
    if !was_recording {
        return;
    }
    c.state().disk.checked_at = None;
    notify(
        "Recording resumed",
        &format!("The machine was asleep for {}. That part of the meeting was not recorded, but this one continues.", fmt_duration(asleep)),
    None,
    );
    check_recording_limits();
}

/// Quit from the tray. Mid-recording, the WAV is sealed and the folder told
/// why it has no notes before the process goes.
pub fn quit() {
    tauri::async_runtime::spawn(async {
        let c = core();
        let recording = c.capture.is_recording();
        let first = {
            let mut s = c.state();
            let first = !s.quitting;
            s.quitting = true;
            first
        };
        if recording && first {
            log_info!("quit requested while recording — closing the audio file first");
            if let Some((dir, _)) = finalize_recording().await {
                write_resume_note(&dir, "Minarrador quit while this meeting was still recording, so the audio was saved but the notes were never generated.");
                notify("Recording saved", "Minarrador quit before writing the notes. Click to open the folder.", None);
            }
        }
        shutdown();
        c.app.exit(0);
    });
}

pub fn shutdown() {
    let Some(c) = core::try_core() else { return };
    crate::desktop_todos::stop();
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let _ = c.app.global_shortcut().unregister_all();
    c.state().phase = Phase::Idle;
    apply_sleep_blocker();
    let jobs: Vec<(PathBuf, tokio_util::sync::CancellationToken)> = {
        let mut s = c.state();
        if let Some(setup) = &s.setup {
            setup.cancel.cancel();
        }
        s.jobs.drain().map(|(d, j)| (d, j.cancel)).collect()
    };
    for (dir, cancel) in jobs {
        cancel.cancel();
        log_warn!("quit requested while processing {}", dir.display());
        write_resume_note(&dir, "Minarrador quit while these notes were still being written.");
    }
    c.capture.destroy();
    c.dictation.cancel();
    c.dictation.destroy();
    c.whisper.stop();
    crate::voice::stop_mic_test();
    *c.tray.lock().unwrap() = None;
}
