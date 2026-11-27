//! library:*, snippets:*, todos:*, and the `meeting-audio` protocol.

use std::fs;
use std::time::Instant;

use serde_json::Value;
use tauri::WebviewWindow;
use tauri_plugin_clipboard_manager::ClipboardExt;

use super::from_library;
use crate::audio_serve::{mono_bytes, mono_size, parse_range, wav_layout, Range, MAX_RESPONSE};
use crate::core::{core, folder_name, Phase};
use crate::library;
use crate::paths::{self, normalise_title};
use crate::recording::{meeting_busy, reprocess_meeting, set_recording_paused, start_recording, stop_recording};
use crate::types::*;
use crate::ui::{health, library_activity, notify_library, notify_settings, refresh_tray};
use crate::windowing::{confirm, window, LIBRARY};
use crate::{log_error, log_info, log_warn};

#[tauri::command]
pub fn snippets_list(window: WebviewWindow) -> Vec<Snippet> {
    if !from_library(&window) {
        return vec![];
    }
    core().snippets.list()
}

#[tauri::command]
pub fn snippets_save(window: WebviewWindow, items: Value) -> Vec<Snippet> {
    if !from_library(&window) {
        return vec![];
    }
    let saved = core().snippets.save(&items);
    crate::cloud::changed("snippets");
    refresh_tray();
    notify_settings();
    log_info!("quick copy: {} shorthand(s) saved", saved.len());
    saved
}

#[tauri::command]
pub fn todos_list(window: WebviewWindow) -> Vec<Todo> {
    if !from_library(&window) {
        return vec![];
    }
    core().todos.list()
}

#[tauri::command]
pub fn todos_save(window: WebviewWindow, items: Value) -> Vec<Todo> {
    if !from_library(&window) {
        return vec![];
    }
    let saved = core().todos.save(&items);
    crate::cloud::changed("todos");
    log_info!("to-do: {} task(s) saved", saved.len());
    crate::desktop_todos::after_save();
    saved
}

#[tauri::command]
pub async fn library_list(window: WebviewWindow, query: String) -> LibraryList {
    if !from_library(&window) {
        return LibraryList { meetings: vec![], activity: library_activity() };
    }
    let started = Instant::now();
    let searching = !query.trim().is_empty();
    let meetings = tauri::async_runtime::spawn_blocking(move || {
        let c = core();
        library::list_meetings(&c.notes_dir(), &query, &mut c.cache.lock().unwrap())
    })
    .await
    .unwrap_or_else(|e| {
        log_error!("library list failed: {e}");
        vec![]
    });
    log_info!(
        "library list: {} meeting(s) in {} ms{}",
        meetings.len(),
        started.elapsed().as_millis(),
        if searching { " (search)" } else { "" }
    );
    LibraryList { meetings, activity: library_activity() }
}

#[tauri::command]
pub async fn library_read(window: WebviewWindow, id: String) -> Option<MeetingDetail> {
    if !from_library(&window) {
        return None;
    }
    tauri::async_runtime::spawn_blocking(move || {
        let c = core();
        library::read_meeting(&c.notes_dir(), &id, &mut c.cache.lock().unwrap())
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
pub fn library_health(window: WebviewWindow) -> Option<Health> {
    from_library(&window).then(health)
}

/// The section main asked the window to open onto, handed over once the page
/// is listening — an event sent while it was still loading would be lost.
#[tauri::command]
pub fn library_initial_section(window: WebviewWindow) -> Option<String> {
    if !from_library(&window) {
        return None;
    }
    core().state().library_section.take()
}

#[tauri::command]
pub fn library_open(window: WebviewWindow, id: String, target: String) -> bool {
    if !from_library(&window) {
        return false;
    }
    match library::open_target(&core().notes_dir(), &id, &target) {
        Some(path) => {
            crate::recording::open_path(&path);
            true
        }
        None => false,
    }
}

#[tauri::command]
pub fn library_open_notes_folder(window: WebviewWindow) -> bool {
    if !from_library(&window) {
        return false;
    }
    crate::recording::open_path(&core().notes_dir());
    true
}

#[tauri::command]
pub fn library_copy(window: WebviewWindow, text: String) {
    if from_library(&window) {
        let _ = core().app.clipboard().write_text(text);
    }
}

#[tauri::command]
pub fn library_minimize(window: WebviewWindow) {
    if from_library(&window) {
        let _ = window.minimize();
    }
}

#[tauri::command]
pub fn library_close(window: WebviewWindow) {
    if from_library(&window) {
        let _ = window.close();
    }
}

#[tauri::command]
pub fn library_reprocess(window: WebviewWindow, id: String) -> Outcome {
    if !from_library(&window) {
        return Outcome::no("");
    }
    reprocess_meeting(&id)
}

#[tauri::command]
pub async fn library_delete(window: WebviewWindow, id: String) -> Outcome {
    if !from_library(&window) {
        return Outcome::no("");
    }
    let c = core();
    let Some(dir) = paths::meeting_dir(&c.notes_dir(), &id) else {
        return Outcome::no("That recording is not in the meetings folder any more.");
    };
    let busy = meeting_busy(&dir);
    if !busy.is_empty() {
        return Outcome::no(busy);
    }
    let title = library::describe_meeting(&dir, &mut c.cache.lock().unwrap()).map(|m| m.title).unwrap_or_else(|| id.clone());
    let confirmed = confirm(
        "Delete this recording?",
        &format!("Delete “{title}”?"),
        "The audio, the transcript, the notes and the brief all go to the Recycle Bin together. Nothing else in Minarrador keeps a copy.",
        "Move to Recycle Bin",
        "Keep",
    )
    .await;
    if !confirmed {
        return Outcome::quiet();
    }
    let target = dir.clone();
    match tauri::async_runtime::spawn_blocking(move || trash::delete(&target)).await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            log_error!("could not delete {}: {e}", dir.display());
            return Outcome::no(format!("Windows would not move that folder to the Recycle Bin: {e}"));
        }
        Err(e) => return Outcome::no(e.to_string()),
    }
    log_info!("deleted {}", dir.display());
    {
        let mut s = c.state();
        if s.last_dir.as_deref() == Some(dir.as_path()) {
            s.last_dir = None;
        }
    }
    notify_library();
    Outcome::ok()
}

/// A rename is `title.txt`, which no pipeline run ever rewrites; an empty title
/// deletes it and the model's title comes back.
#[tauri::command]
pub fn library_rename(window: WebviewWindow, id: String, title: String) -> Outcome {
    if !from_library(&window) {
        return Outcome::no("");
    }
    let Some(dir) = paths::meeting_dir(&core().notes_dir(), &id) else {
        return Outcome::no("That recording is not in the meetings folder any more.");
    };
    let clean = normalise_title(&title);
    let result = if clean.is_empty() {
        match fs::remove_file(dir.join(paths::TITLE)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        }
    } else {
        fs::write(dir.join(paths::TITLE), format!("{clean}\n"))
    };
    if let Err(e) = result {
        log_warn!("could not rename {}: {e}", dir.display());
        return Outcome::no(format!("That title could not be saved: {e}"));
    }
    log_info!("{}", if clean.is_empty() { format!("reverted the title of {}", folder_name(&dir)) } else { format!("renamed {} to \"{clean}\"", folder_name(&dir)) });
    notify_library();
    Outcome::ok()
}

#[tauri::command]
pub fn library_record(window: WebviewWindow, on: bool) -> bool {
    if !from_library(&window) {
        return false;
    }
    if on {
        start_recording();
    } else {
        tauri::async_runtime::spawn(stop_recording());
    }
    true
}

#[tauri::command]
pub fn library_pause(window: WebviewWindow, paused: bool) -> bool {
    from_library(&window) && set_recording_paused(paused)
}

#[tauri::command]
pub async fn library_stop(window: WebviewWindow) -> Outcome {
    if !from_library(&window) {
        return Outcome::no("");
    }
    if core().state().phase != Phase::Recording {
        return Outcome::no("Nothing is being recorded.");
    }
    let confirmed = confirm(
        "Stop recording?",
        "Stop recording this meeting?",
        "The notes are written from what has been recorded so far. A stopped recording cannot be continued.",
        "Stop recording",
        "Keep recording",
    )
    .await;
    if !confirmed {
        return Outcome::no("");
    }
    if core().state().phase == Phase::Recording {
        tauri::async_runtime::spawn(stop_recording());
    }
    Outcome { ok: true, reason: Some(String::new()) }
}

fn empty(status: u16) -> http::Response<Vec<u8>> {
    http::Response::builder().status(status).body(vec![]).unwrap()
}

/// `meeting-audio://meeting/<id>` (served as `http://meeting-audio.localhost/<id>`
/// on Windows): a meeting's audio.wav as mono, by byte range. The URL carries
/// only a meeting id, and the meeting being recorded is refused.
pub fn serve_audio(request: http::Request<Vec<u8>>) -> http::Response<Vec<u8>> {
    let Some(c) = crate::core::try_core() else { return empty(503) };
    if window(LIBRARY).is_none() {
        return empty(403);
    }
    let path = request.uri().path().trim_start_matches('/');
    let path = path.strip_prefix("meeting/").unwrap_or(path);
    let id = percent_encoding::percent_decode_str(path).decode_utf8_lossy().into_owned();
    let Some(file) = library::open_target(&c.notes_dir(), &id, "audio") else { return empty(404) };
    {
        let s = c.state();
        if s.phase == Phase::Recording && s.current_dir.as_deref() == file.parent() {
            return empty(409);
        }
    }
    let Some(layout) = wav_layout(&file) else { return empty(415) };
    let size = mono_size(&layout);
    let range = request.headers().get("range").and_then(|v| v.to_str().ok());
    let (start, end, partial) = match parse_range(range, size) {
        Range::Invalid => {
            return http::Response::builder().status(416).header("Content-Range", format!("bytes */{size}")).body(vec![]).unwrap();
        }
        Range::Whole => (0, size - 1, false),
        Range::Part(a, b) => (a, b, true),
    };
    // Open-ended requests get a slice; the player asks again for the rest.
    let end = if partial { end.min(start + MAX_RESPONSE - 1) } else { end };
    let partial = partial || end < size - 1;
    let end = if !partial { end } else { end.min(size - 1) };
    match mono_bytes(&file, &layout, start, end) {
        Ok(body) => {
            let mut b = http::Response::builder()
                .status(if partial { 206 } else { 200 })
                .header("Content-Type", "audio/wav")
                .header("Accept-Ranges", "bytes")
                .header("Content-Length", body.len().to_string());
            if partial {
                b = b.header("Content-Range", format!("bytes {start}-{}/{size}", start + body.len() as u64 - 1));
            }
            b.body(body).unwrap()
        }
        Err(e) => {
            log_warn!("could not serve {}: {e}", file.display());
            empty(500)
        }
    }
}
