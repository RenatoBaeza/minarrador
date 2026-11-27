//! sync:* — signing in with Google and syncing the light data.

use tauri::WebviewWindow;

use super::from_library;
use crate::types::{Outcome, SettingsState};
use crate::ui::settings_state;

/// Opens Google's consent page in the browser and waits for it.
#[tauri::command]
pub async fn sync_sign_in(window: WebviewWindow) -> Outcome {
    if !from_library(&window) {
        return Outcome::quiet();
    }
    crate::cloud::sign_in().await
}

/// Cancels a sign-in in progress, or signs out. Nothing local is deleted.
#[tauri::command]
pub fn sync_sign_out(window: WebviewWindow) -> Option<SettingsState> {
    if !from_library(&window) {
        return None;
    }
    crate::cloud::sign_out();
    Some(settings_state())
}

#[tauri::command]
pub async fn sync_now(window: WebviewWindow) -> Outcome {
    if !from_library(&window) {
        return Outcome::quiet();
    }
    crate::cloud::sync_now().await
}
