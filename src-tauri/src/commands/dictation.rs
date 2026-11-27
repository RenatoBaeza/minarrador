//! dictations:* — the dictation archive window.

use tauri::WebviewWindow;
use tauri_plugin_clipboard_manager::ClipboardExt;

use super::from;
use crate::core::core;
use crate::types::Dictation;
use crate::windowing::DICTATIONS;

fn ours(w: &WebviewWindow) -> bool {
    from(w, DICTATIONS)
}

#[tauri::command]
pub fn dictations_list(window: WebviewWindow) -> Vec<Dictation> {
    if !ours(&window) {
        return vec![];
    }
    core().dictations.list()
}

#[tauri::command]
pub fn dictations_update(window: WebviewWindow, id: String, text: String) -> Option<Vec<Dictation>> {
    if !ours(&window) {
        return None;
    }
    let next = core().dictations.update(&id, &text);
    if next.is_some() {
        crate::cloud::changed("dictations");
    }
    next
}

#[tauri::command]
pub fn dictations_remove(window: WebviewWindow, id: String) -> Option<Vec<Dictation>> {
    if !ours(&window) {
        return None;
    }
    let next = core().dictations.remove(&id);
    if next.is_some() {
        crate::cloud::changed("dictations");
    }
    next
}

#[tauri::command]
pub fn dictations_copy(window: WebviewWindow, text: String) {
    if ours(&window) {
        let _ = core().app.clipboard().write_text(text);
    }
}

#[tauri::command]
pub fn dictations_close(window: WebviewWindow) {
    if ours(&window) {
        let _ = window.close();
    }
}
