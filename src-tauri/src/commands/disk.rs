//! disk:* — the Disk usage feature. The folder comes from a native dialog and
//! every entry is an opaque id; no path crosses into the page either way.

use tauri::WebviewWindow;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tokio_util::sync::CancellationToken;

use super::from_library;
use crate::core::{core, Phase};
use crate::diskusage::{is_within, DiskScan};
use crate::types::{DiskChoice, DiskEntry, Outcome};
use crate::ui::notify_library;
use crate::windowing::{confirm, emit_library, window, LIBRARY};
use crate::{log_error, log_info};

pub fn cancel_scan() {
    if let Some(c) = crate::core::try_core() {
        if let Some(token) = c.disk_cancel.lock().unwrap().take() {
            token.cancel();
        }
    }
}

#[tauri::command]
pub async fn disk_choose(window: WebviewWindow) -> DiskChoice {
    if !from_library(&window) {
        return DiskChoice::default();
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = core().app.dialog().file().set_title("Choose a folder to measure");
    if let Some(w) = crate::windowing::window(LIBRARY) {
        dialog = dialog.set_parent(&w);
    }
    dialog.pick_folder(move |p| {
        let _ = tx.send(p);
    });
    let Some(Some(picked)) = rx.await.ok() else { return DiskChoice::default() };
    let Ok(root) = picked.into_path() else { return DiskChoice::default() };
    cancel_scan();
    let cancel = CancellationToken::new();
    *core().disk_cancel.lock().unwrap() = Some(cancel.clone());
    *core().disk_scan.lock().unwrap() = None;
    let token = cancel.clone();
    let walked = tauri::async_runtime::spawn_blocking(move || {
        let mut scan = DiskScan::new(root);
        let result = scan.walk(&token, |p| emit_library("disk:progress", p));
        result.map(|_| scan)
    })
    .await;
    if cancel.is_cancelled() {
        *core().disk_cancel.lock().unwrap() = None;
    }
    let mut scan = match walked {
        Ok(Ok(scan)) => scan,
        Ok(Err(_)) => return DiskChoice { ok: false, reason: Some("Scan cancelled.".into()), ..Default::default() },
        Err(e) => {
            log_error!("disk scan failed: {e}");
            return DiskChoice { ok: false, reason: Some(format!("Could not read that folder: {e}")), ..Default::default() };
        }
    };
    let root = scan.root_entry();
    let entries = scan.list(root.id).unwrap_or_default();
    *core().disk_scan.lock().unwrap() = Some(scan);
    DiskChoice { ok: true, reason: None, root: Some(root), entries: Some(entries) }
}

#[tauri::command]
pub fn disk_cancel(window: WebviewWindow) -> bool {
    if !from_library(&window) {
        return false;
    }
    cancel_scan();
    true
}

#[tauri::command]
pub async fn disk_list(window: WebviewWindow, id: u64) -> Option<Vec<DiskEntry>> {
    if !from_library(&window) {
        return None;
    }
    tauri::async_runtime::spawn_blocking(move || core().disk_scan.lock().unwrap().as_mut()?.list(id)).await.ok().flatten()
}

#[tauri::command]
pub fn disk_reveal(window: WebviewWindow, id: u64) -> bool {
    if !from_library(&window) {
        return false;
    }
    let Some(node) = core().disk_scan.lock().unwrap().as_ref().and_then(|s| s.resolve(id)) else { return false };
    core().app.opener().reveal_item_in_dir(&node.path).is_ok()
}

/// Refuses the scanned root and anything holding a meeting that is recording
/// or mid-pipeline; asks first; and takes the weight off the totals itself.
#[tauri::command]
pub async fn disk_trash(window: WebviewWindow, id: u64) -> Outcome {
    if !from_library(&window) {
        return Outcome::no("");
    }
    let c = core();
    let (node, root) = {
        let scan = c.disk_scan.lock().unwrap();
        match scan.as_ref().and_then(|s| s.resolve(id).map(|n| (n, s.root.clone()))) {
            Some(found) => found,
            None => return Outcome::no("That entry is not in the current scan any more."),
        }
    };
    if node.path == root {
        return Outcome::no("The folder being measured cannot be deleted from here.");
    }
    let busy: Vec<_> = {
        let s = c.state();
        let mut b: Vec<_> = s.jobs.keys().cloned().collect();
        if s.phase == Phase::Recording {
            b.extend(s.current_dir.clone());
        }
        b
    };
    if busy.iter().any(|d| is_within(&node.path, d)) {
        return Outcome::no("A meeting in there is still being recorded or processed.");
    }
    let what = if node.is_directory { "folder" } else { "file" };
    let confirmed = confirm(
        "Move to the Recycle Bin?",
        &format!("Move this {what} to the Recycle Bin?"),
        &node.path.to_string_lossy(),
        "Move to Recycle Bin",
        "Keep",
    )
    .await;
    if !confirmed {
        return Outcome::quiet();
    }
    let path = node.path.clone();
    match tauri::async_runtime::spawn_blocking(move || trash::delete(&path)).await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => return Outcome::no(format!("Windows would not move that to the Recycle Bin: {e}")),
        Err(e) => return Outcome::no(e.to_string()),
    }
    log_info!("trashed from disk usage {}", node.path.display());
    if let Some(scan) = c.disk_scan.lock().unwrap().as_mut() {
        scan.forget(id);
    }
    if window_open() {
        notify_library();
    }
    Outcome::ok()
}

fn window_open() -> bool {
    window(LIBRARY).is_some()
}
