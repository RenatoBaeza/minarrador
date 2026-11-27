//! Every window the app opens, notifications, and native dialogs.
//!
//! Each window is single-instance: "show" focuses it if it is there and builds
//! it if not. Windows are always built from an async task — building one on
//! the main thread from a tray or menu handler can deadlock WebView2.

use std::sync::{mpsc, Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use tauri::window::Color;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::core::core;
use crate::types::DictateIndicatorState;
use crate::{log_error, log_info};

pub const LIBRARY: &str = "library";
pub const DICTATIONS: &str = "dictations";
pub const INDICATOR: &str = "indicator";

const BACKGROUND: Color = Color(0x16, 0x16, 0x1a, 0xff);

pub fn window(label: &str) -> Option<WebviewWindow> {
    core().app.get_webview_window(label)
}

fn raise(w: &WebviewWindow) {
    let _ = w.unminimize();
    let _ = w.show();
    let _ = w.set_focus();
}

/// Opens (or raises) the library window, optionally onto one feature.
pub fn show_library(section: Option<&str>) {
    let section = section.map(String::from);
    tauri::async_runtime::spawn(async move {
        if let Some(w) = window(LIBRARY) {
            raise(&w);
            if let Some(s) = section {
                let _ = w.emit("library:show", s);
            }
            return;
        }
        core().state().library_section = section;
        let built = WebviewWindowBuilder::new(&core().app, LIBRARY, WebviewUrl::App("library.html".into()))
            .title("Minarrador")
            .inner_size(1120.0, 760.0)
            .min_inner_size(780.0, 480.0)
            .decorations(false)
            .background_color(BACKGROUND)
            .visible(false)
            .center()
            .build();
        match built {
            Ok(w) => {
                w.on_window_event(|e| {
                    if let tauri::WindowEvent::Destroyed = e {
                        library_closed();
                    }
                });
                raise(&w);
            }
            Err(e) => log_error!("library window failed to open: {e}"),
        }
    });
}

/// What has to let go when the library closes: the mic test, a disk scan.
fn library_closed() {
    crate::voice::stop_mic_test();
    crate::commands::disk::cancel_scan();
    *core().disk_scan.lock().unwrap() = None;
}

pub fn show_dictations() {
    tauri::async_runtime::spawn(async move {
        if let Some(w) = window(DICTATIONS) {
            raise(&w);
            return;
        }
        let built = WebviewWindowBuilder::new(&core().app, DICTATIONS, WebviewUrl::App("dictations.html".into()))
            .title("Dictations")
            .inner_size(560.0, 640.0)
            .min_inner_size(420.0, 320.0)
            .decorations(false)
            .background_color(BACKGROUND)
            .visible(false)
            .center()
            .build();
        match built {
            Ok(w) => raise(&w),
            Err(e) => log_error!("dictations window failed to open: {e}"),
        }
    });
}

pub fn notify_dictations() {
    emit_to(DICTATIONS, "dictations:changed", ());
}

/// The floating "listening" pill. It never takes focus — a window that could
/// take the cursor would move the very target the text is pasted into.
pub fn show_indicator() {
    core().state().indicator_generation += 1;
    tauri::async_runtime::spawn(async move {
        let w = match window(INDICATOR) {
            Some(w) => w,
            None => {
                let (width, height) = (380.0, 64.0);
                let built = WebviewWindowBuilder::new(&core().app, INDICATOR, WebviewUrl::App("dictate-indicator.html".into()))
                    .title("Dictation")
                    .inner_size(width, height)
                    .decorations(false)
                    .resizable(false)
                    .always_on_top(true)
                    .skip_taskbar(true)
                    .focused(false)
                    .focusable(false)
                    .background_color(BACKGROUND)
                    .visible(false)
                    .build();
                match built {
                    Ok(w) => {
                        if let (Some(m), Ok(size)) = (crate::win::primary_monitor(), w.outer_size()) {
                            let (wx, wy, ww, wh) = m.work;
                            let x = wx + (ww - size.width as i32) / 2;
                            let y = wy + wh - size.height as i32 - (48.0 * w.scale_factor().unwrap_or(1.0)) as i32;
                            let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
                        }
                        if let Ok(hwnd) = w.hwnd() {
                            crate::win::make_unfocusable(hwnd.0 as isize);
                        }
                        // Give the page a moment to load before it is shown.
                        tokio::time::sleep(Duration::from_millis(250)).await;
                        w
                    }
                    Err(e) => {
                        log_error!("dictate indicator failed to open: {e}");
                        return;
                    }
                }
            }
        };
        if let Ok(hwnd) = w.hwnd() {
            crate::win::show_no_activate(hwnd.0 as isize);
        }
    });
}

pub fn send_to_dictate(state: &'static str, text: Option<String>, error: Option<String>) {
    emit_to(INDICATOR, "dictate:state", DictateIndicatorState { state, text, error });
}

/// Hides the pill four seconds from now, unless another dictation starts.
pub fn schedule_indicator_hide() {
    let generation = {
        let mut s = core().state();
        s.indicator_generation += 1;
        s.indicator_generation
    };
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(4)).await;
        if core().state().indicator_generation != generation {
            return;
        }
        if let Some(w) = window(INDICATOR) {
            if let Ok(hwnd) = w.hwnd() {
                crate::win::hide_window(hwnd.0 as isize);
            }
        }
    });
}

pub fn emit_to<S: Serialize + Clone>(label: &str, event: &str, payload: S) {
    if window(label).is_some() {
        let _ = core().app.emit_to(label, event, payload);
    }
}

pub fn emit_library<S: Serialize + Clone>(event: &str, payload: S) {
    emit_to(LIBRARY, event, payload);
}

// ---------------------------------------------------------------- toasts

type Job = Box<dyn FnOnce() + Send>;

/// Toasts are shown from one long-lived thread, so the COM apartment their
/// click handlers live in outlasts the toast.
fn toast_thread() -> &'static Mutex<mpsc::Sender<Job>> {
    static TX: OnceLock<Mutex<mpsc::Sender<Job>>> = OnceLock::new();
    TX.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<Job>();
        std::thread::Builder::new()
            .name("toasts".into())
            .spawn(move || {
                while let Ok(job) = rx.recv() {
                    job();
                }
            })
            .expect("toast thread");
        Mutex::new(tx)
    })
}

fn app_id() -> String {
    if cfg!(debug_assertions) {
        tauri_winrt_notification::Toast::POWERSHELL_APP_ID.to_string()
    } else {
        core().app.config().identifier.clone()
    }
}

pub type OnClick = Box<dyn FnOnce() + Send>;

/// A Windows notification. Starting and stopping both raise one — a tray icon
/// changing colour is not confirmation that a room is being recorded.
pub fn notify(title: &str, body: &str, on_click: Option<OnClick>) {
    log_info!("notification: {title} — {body}");
    let (title, body, id) = (title.to_string(), body.to_string(), app_id());
    let job: Job = Box::new(move || {
        let click = Mutex::new(on_click);
        let toast = tauri_winrt_notification::Toast::new(&id).title(&title).text1(&body).on_activated(move |_| {
            if let Some(f) = click.lock().unwrap().take() {
                f();
            }
            Ok(())
        });
        if let Err(e) = toast.show() {
            log_error!("could not show a notification: {e:?}");
        }
    });
    let _ = toast_thread().lock().unwrap().send(job);
}

/// A native confirmation, raised by the app itself — a page cannot be the
/// thing that vouches for having asked first.
pub async fn confirm(title: &str, message: &str, detail: &str, ok: &str, cancel: &str) -> bool {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = core()
        .app
        .dialog()
        .message(if detail.is_empty() { message.to_string() } else { format!("{message}\n\n{detail}") })
        .title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(ok.into(), cancel.into()));
    if let Some(w) = window(LIBRARY) {
        dialog = dialog.parent(&w);
    }
    dialog.show(move |answer| {
        let _ = tx.send(answer);
    });
    rx.await.unwrap_or(false)
}

pub fn error_box(title: &str, body: &str) {
    log_error!("{title}: {body}");
    core().app.dialog().message(body).title(title).kind(MessageDialogKind::Error).show(|_| {});
}
