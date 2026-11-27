//! Starting a meeting, ending it, and turning it into notes.
//!
//! Seven things can end a meeting — the tray, the shortcut, the library, the
//! silence watcher, the duration cap, a full disk, a quit — and the audio is
//! the one artefact nothing can regenerate. `state.stopping` makes the first
//! caller the only one.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use serde_json::{json, Map, Value};
use tokio_util::sync::CancellationToken;

use crate::core::{core, folder_name, human, Job, Phase, DISK_WARN_BYTES};
use crate::ollama::{ChatMessage, Ollama};
use crate::paths;
use crate::pipeline::{self, fmt_duration, transcribe_engine_for, Engines, Progress};
use crate::settings::hotkey_label;
use crate::types::{Engine, JobProgress, Outcome};
use crate::ui::{notify_library, notify_progress, notify_settings, refresh_tray, send_activity};
use crate::whisper::timeout_for;
use crate::windowing::{error_box, notify, show_library};
use crate::{log_error, log_info, log_warn};

/// Below this a meeting is refused; below the second, one in progress ends.
const DISK_REFUSE_BYTES: u64 = 300 * 1024 * 1024;
const DISK_STOP_BYTES: u64 = 150 * 1024 * 1024;
const DISK_CHECK_SECS: u64 = 30;
const LONG_RECORDING_SECONDS: f64 = 3.0 * 3600.0;
const LONG_RECORDING_REPEAT_SECONDS: f64 = 3600.0;

/// Re-reads the free space (at most every 30 s unless forced) and acts on it.
pub fn check_disk(force: bool) -> Option<u64> {
    let c = core();
    let notes = c.notes_dir();
    {
        let s = c.state();
        if !force && s.disk.checked_at.is_some_and(|t| t.elapsed().as_secs() < DISK_CHECK_SECS) {
            return s.disk.free;
        }
    }
    let free = crate::win::free_space(&notes);
    let (recording, mut warn_change) = {
        let mut s = c.state();
        s.disk.checked_at = Some(Instant::now());
        s.disk.free = free;
        (s.phase == Phase::Recording, None)
    };
    let free = free?;
    if recording && free < DISK_STOP_BYTES {
        log_error!("stopping the recording: only {} left on the notes volume", human(free));
        notify("Out of disk space", &format!("Minarrador stopped recording with {} left. The audio so far is saved.", human(free)), None);
        tauri::async_runtime::spawn(stop_recording());
        return Some(free);
    }
    {
        let mut s = c.state();
        if free < DISK_WARN_BYTES && !s.disk.warned {
            s.disk.warned = true;
            warn_change = Some(true);
        } else if free >= DISK_WARN_BYTES && s.disk.warned {
            s.disk.warned = false;
            warn_change = Some(false);
        }
    }
    match warn_change {
        Some(true) => {
            notify("Running out of space", &format!("{} left where meetings are saved. An hour of recording needs about 230 MB.", human(free)), None);
            notify_settings();
        }
        Some(false) => notify_settings(),
        None => {}
    }
    Some(free)
}

/// Holds off idle sleep while recording, when the setting says to.
pub fn apply_sleep_blocker() {
    let c = core();
    let prevent = c.settings().prevent_sleep;
    let mut s = c.state();
    let wanted = prevent && s.phase == Phase::Recording;
    if wanted == s.sleep_blocker.is_some() {
        return;
    }
    if wanted {
        s.sleep_blocker = Some(crate::win::SleepBlocker::start());
        log_info!("holding off system sleep for the duration of the recording");
    } else {
        s.sleep_blocker = None;
    }
}

pub fn start_recording() {
    let c = core();
    if c.state().phase == Phase::Recording {
        return;
    }
    let settings = c.settings();
    let result = (|| -> Result<(), String> {
        let notes = PathBuf::from(&settings.notes_dir);
        fs::create_dir_all(&notes).map_err(|e| e.to_string())?;
        if let Some(free) = check_disk(true) {
            if free < DISK_REFUSE_BYTES {
                error_box(
                    "Minarrador",
                    &format!("There is only {} free where meetings are saved.\n\nFree up some space, or choose another folder under Settings → Meetings folder.", human(free)),
                );
                return Ok(());
            }
        }
        let dir = paths::create_meeting_dir(&notes, &chrono::Local::now()).map_err(|e| e.to_string())?;
        c.capture.start_recording(&dir.join(paths::AUDIO), settings.separate_channels, settings.silence_stop_minutes)?;
        {
            let mut s = c.state();
            s.current_dir = Some(dir.clone());
            s.live_dir = Some(dir);
            s.recording_started_at = Some(chrono::Utc::now());
            s.warned_long_at = 0.0;
            s.heard = (0.0, 0.0);
            s.phase = Phase::Recording;
        }
        apply_sleep_blocker();
        refresh_tray();
        notify_library();
        if settings.live_transcript {
            show_library(Some("reader"));
        }
        let registered = c.state().hotkey_registered;
        notify(
            "Recording",
            &if registered {
                format!("Minarrador is capturing this meeting. Press {} again to stop.", hotkey_label(&settings.hotkey))
            } else {
                "Minarrador is capturing this meeting. Stop it from the tray icon.".into()
            },
            None,
        );
        Ok(())
    })();
    if let Err(e) = result {
        log_error!("startRecording failed: {e}");
        error_box("Minarrador", &format!("Could not start recording:\n\n{e}"));
        {
            let mut s = c.state();
            if s.phase == Phase::Recording && !c.capture.is_recording() {
                s.phase = Phase::Idle;
            }
        }
        apply_sleep_blocker();
        refresh_tray();
    }
}

pub fn set_recording_paused(paused: bool) -> bool {
    let c = core();
    {
        let s = c.state();
        if s.phase != Phase::Recording || s.stopping {
            return false;
        }
    }
    c.capture.set_paused(paused);
    refresh_tray();
    send_activity();
    true
}

pub fn toggle_recording() {
    if core().state().phase == Phase::Recording {
        tauri::async_runtime::spawn(stop_recording());
    } else {
        start_recording();
    }
}

/// The duration cap, the long-recording reminder and the disk check — all on
/// the one-second tray tick rather than timers of their own.
pub fn check_recording_limits() {
    let c = core();
    if c.state().phase != Phase::Recording {
        return;
    }
    let settings = c.settings();
    let elapsed = c.capture.elapsed_seconds();
    let cap = settings.max_recording_minutes as f64 * 60.0;
    if cap > 0.0 && elapsed >= cap {
        log_warn!("stopping the recording at the {}-minute ceiling", settings.max_recording_minutes);
        notify("Recording stopped", &format!("This meeting reached the {} limit. The notes are being written now.", fmt_duration(cap)), None);
        tauri::async_runtime::spawn(stop_recording());
        return;
    }
    let remind = {
        let mut s = c.state();
        if elapsed >= LONG_RECORDING_SECONDS && elapsed - s.warned_long_at >= LONG_RECORDING_REPEAT_SECONDS {
            s.warned_long_at = elapsed;
            true
        } else {
            false
        }
    };
    if remind {
        notify(
            "Still recording",
            &format!("Minarrador has been recording for {}. Click to stop and write the notes.", fmt_duration(elapsed)),
            Some(Box::new(|| {
                tauri::async_runtime::spawn(stop_recording());
            })),
        );
    }
    check_disk(false);
}

/// Closes the WAV and writes meta.json. Returns None when another caller got
/// there first, or when nothing worth keeping was recorded.
pub async fn finalize_recording() -> Option<(PathBuf, Map<String, Value>)> {
    let c = core();
    let (dir, started) = {
        let mut s = c.state();
        if s.phase != Phase::Recording || s.stopping {
            return None;
        }
        s.stopping = true;
        (s.current_dir.clone()?, s.recording_started_at)
    };
    let status = c.capture.status();
    let result = c.capture.stop_recording().await;
    {
        let mut s = c.state();
        s.stopping = false;
        s.phase = if s.jobs.is_empty() { Phase::Idle } else { Phase::Processing };
        s.current_dir = None;
    }
    apply_sleep_blocker();
    refresh_tray();
    let result = match result {
        Some(r) if r.seconds >= 1.0 => r,
        _ => {
            log_warn!("discarding recording shorter than a second: {}", dir.display());
            core().state().live_dir = None;
            let _ = fs::remove_dir_all(&dir);
            notify("Nothing recorded", "The recording was too short to keep.", None);
            notify_library();
            return None;
        }
    };
    let mut meta = Map::new();
    meta.insert("startedAt".into(), json!(started.unwrap_or_else(chrono::Utc::now).to_rfc3339()));
    meta.insert("endedAt".into(), json!(chrono::Utc::now().to_rfc3339()));
    meta.insert("durationSeconds".into(), json!(result.seconds));
    meta.insert("sources".into(), json!({ "mic": status.mic_ok, "system": status.system_ok }));
    meta.insert("channels".into(), json!(result.channels));
    let _ = fs::write(dir.join(paths::META), serde_json::to_string_pretty(&Value::Object(meta.clone())).unwrap_or_default());
    notify_library();
    Some((dir, meta))
}

fn how_to_finish(dir: &Path) -> String {
    format!(
        "Open Minarrador (left-click the tray icon), pick this recording ({}), and press Generate notes.\n",
        dir.display()
    )
}

/// Leaves a note in a folder whose notes were never written, saying how to
/// finish it from inside the app.
pub fn write_resume_note(dir: &Path, reason: &str) {
    let body = format!("{reason}\n\nThe audio is still in {}.\n\n{}", paths::AUDIO, how_to_finish(dir));
    if let Err(e) = fs::write(dir.join(paths::UNPROCESSED), body) {
        log_warn!("could not write the resume note in {}: {e}", dir.display());
    }
}

pub async fn stop_recording() {
    let Some((dir, meta)) = finalize_recording().await else { return };
    let c = core();
    let settings = c.settings();
    let mut plan = "Transcribing, then the notes and the PDF brief.".to_string();
    let mut on_click: Option<crate::windowing::OnClick> = None;
    let up = c.state().ollama_up || Ollama::new(&settings.ollama_host).is_up().await;
    if !up {
        plan = if transcribe_engine_for(&settings.transcribe_engine, c.whisper.available()) == Engine::Whisper {
            "Ollama is not running, so the notes cannot be written yet. Click to start it — the transcription carries on either way.".into()
        } else {
            "Ollama is not running, so the notes cannot be written. Click to start it and generate them again.".into()
        };
        on_click = Some(Box::new(|| {
            tauri::async_runtime::spawn(crate::services::open_ollama());
        }));
    }
    let duration = meta.get("durationSeconds").and_then(Value::as_f64).unwrap_or(0.0);
    notify("Recording saved", &format!("{} captured. {plan}", fmt_duration(duration)), on_click);
    process_meeting(dir, meta).await;
}

/// Wires the pipeline to the real engines.
pub fn engines(cancel: CancellationToken) -> Engines {
    let c = core();
    let settings = c.settings();
    let engine = transcribe_engine_for(&settings.transcribe_engine, c.whisper.available());
    let engine_label = match engine {
        Engine::Whisper => format!("whisper.cpp ({})", c.whisper.model_name()),
        Engine::Ollama => settings.transcribe_model.clone(),
    };
    let ollama = Ollama::new(&settings.ollama_host);
    let (asr_ollama, asr_cancel, model, whisper) = (ollama.clone(), cancel.clone(), settings.transcribe_model.clone(), c.whisper.clone());
    let asr: pipeline::AsrFn = Arc::new(move |wav, prompt, seconds| {
        let (ollama, cancel, model, whisper) = (asr_ollama.clone(), asr_cancel.clone(), model.clone(), whisper.clone());
        Box::pin(async move {
            match engine {
                Engine::Whisper => whisper.transcribe(wav, None, Some(&prompt), timeout_for(seconds), Some(&cancel)).await.map_err(|e| e.to_string()),
                Engine::Ollama => ollama.transcribe(&model, &wav, None, Some(seconds), Some(&cancel)).await.map_err(|e| e.to_string()),
            }
        })
    });
    let (chat_ollama, chat_cancel, summary) = (ollama.clone(), cancel.clone(), settings.summary_model.clone());
    let chat: pipeline::ChatFn = Arc::new(move |messages: Vec<ChatMessage>, temperature| {
        let (ollama, cancel, model) = (chat_ollama.clone(), chat_cancel.clone(), summary.clone());
        Box::pin(async move { ollama.chat(&model, &messages, temperature, Some(&cancel)).await.map_err(|e| e.to_string()) })
    });
    let up_ollama = ollama.clone();
    Engines {
        engine,
        engine_label,
        summary_model: settings.summary_model.clone(),
        ollama_host: settings.ollama_host.clone(),
        asr,
        chat,
        pdf: Arc::new(|html, pdf| Box::pin(crate::pdf::html_to_pdf(html, pdf))),
        ollama_up: Arc::new(move || {
            let o = up_ollama.clone();
            Box::pin(async move { o.is_up().await })
        }),
    }
}

fn progress_label(p: &Progress) -> Option<String> {
    Some(match p.phase {
        "transcribing" => format!("Transcribing {}/{}…", p.done, p.total),
        "summarising" if p.total > 0 => format!("Condensing {}/{}…", p.done, p.total),
        "summarising" => "Writing notes…".into(),
        "designing" => "Designing the brief…".into(),
        "rendering" => "Exporting PDF…".into(),
        _ => return None,
    })
}

/// Runs the pipeline over one folder, reporting progress per meeting.
pub async fn process_meeting(dir: PathBuf, meta: Map<String, Value>) -> bool {
    let c = core();
    for name in [paths::ERROR, paths::UNPROCESSED] {
        let _ = fs::remove_file(dir.join(name));
    }
    let cancel = CancellationToken::new();
    {
        let mut s = c.state();
        let progress = JobProgress { phase: "preparing".into(), done: 0, total: 0, label: "Preparing…".into() };
        s.progress = progress.label.clone();
        s.jobs.insert(dir.clone(), Job { cancel: cancel.clone(), progress });
        if s.phase == Phase::Idle {
            s.phase = Phase::Processing;
        }
    }
    refresh_tray();
    notify_library();
    let job_dir = dir.clone();
    let on_progress: pipeline::ProgressFn = Arc::new(move |p: Progress| {
        if let Some(w) = &p.warning {
            log_warn!("pipeline: {w}");
        }
        let Some(label) = progress_label(&p) else { return };
        {
            let mut s = core().state();
            s.progress = label.clone();
            if let Some(job) = s.jobs.get_mut(&job_dir) {
                job.progress = JobProgress { phase: p.phase.into(), done: p.done, total: p.total, label };
            }
        }
        refresh_tray();
        notify_progress();
    });
    let duration = meta.get("durationSeconds").and_then(Value::as_f64).unwrap_or(0.0);
    let result = pipeline::run_pipeline(&dir, c.settings().chunk_seconds, &engines(cancel.clone()), meta, &on_progress, &cancel).await;
    let ok = match result {
        Ok(out) => {
            c.state().last_dir = Some(dir.clone());
            log_info!("pipeline complete: {}", dir.display());
            let open = dir.clone();
            notify(
                &out.notes.title,
                &format!("{} · {} action item(s). Click to open the folder.", fmt_duration(duration), out.notes.action_items.len()),
                Some(Box::new(move || open_path(&open))),
            );
            true
        }
        Err(_) if cancel.is_cancelled() => {
            log_warn!("pipeline cancelled for {}", dir.display());
            false
        }
        Err(message) => {
            log_error!("pipeline failed for {}: {message}", dir.display());
            let _ = fs::write(
                dir.join(paths::ERROR),
                format!(
                    "Processing failed at {}\n\nError: {message}\n\nThe audio is still in {}. Fix the problem (usually: start Ollama, or pull the model),\nthen generate the notes again.\n\n{}",
                    chrono::Utc::now().to_rfc3339(),
                    paths::AUDIO,
                    how_to_finish(&dir)
                ),
            );
            let open = dir.clone();
            let short: String = message.chars().take(180).collect();
            notify("Notes failed", &format!("{short} — audio was saved. Click to open the folder."), Some(Box::new(move || open_path(&open))));
            false
        }
    };
    {
        let mut s = c.state();
        s.jobs.remove(&dir);
        if s.jobs.is_empty() {
            if s.phase == Phase::Processing {
                s.phase = Phase::Idle;
            }
            s.progress.clear();
        }
    }
    refresh_tray();
    notify_library();
    ok
}

pub fn open_path(path: &Path) {
    use tauri_plugin_opener::OpenerExt;
    if let Err(e) = core().app.opener().open_path(path.to_string_lossy(), None::<&str>) {
        log_warn!("could not open {}: {e}", path.display());
    }
}

/// "Generate notes" from the library: re-runs the pipeline over a folder.
pub fn reprocess_meeting(id: &str) -> Outcome {
    let c = core();
    let Some(dir) = paths::meeting_dir(&c.notes_dir(), id) else {
        return Outcome::no("That recording is not in the meetings folder any more.");
    };
    if !dir.join(paths::AUDIO).exists() {
        return Outcome::no("There is no audio in that folder to work from.");
    }
    let busy = meeting_busy(&dir);
    if !busy.is_empty() {
        return Outcome::no(busy);
    }
    let meta = fs::read_to_string(dir.join(paths::META))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_else(|| {
            let mut m = Map::new();
            let mtime = fs::metadata(dir.join(paths::AUDIO)).and_then(|m| m.modified()).ok().map(chrono::DateTime::<chrono::Utc>::from);
            m.insert("startedAt".into(), json!(mtime.unwrap_or_else(chrono::Utc::now).to_rfc3339()));
            m.insert("durationSeconds".into(), json!(0));
            m
        });
    log_info!("generating notes again for {}", folder_name(&dir));
    tauri::async_runtime::spawn(process_meeting(dir, meta));
    Outcome::ok()
}

/// Why a folder cannot be touched right now, or `""`.
pub fn meeting_busy(dir: &Path) -> String {
    let s = core().state();
    if s.phase == Phase::Recording && s.current_dir.as_deref() == Some(dir) {
        return "That meeting is still recording.".into();
    }
    if s.jobs.contains_key(dir) {
        return "Those notes are still being written.".into();
    }
    String::new()
}
