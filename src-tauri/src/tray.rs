//! The system-tray icon and its menu — the app's only permanent surface.
//!
//! Left-click opens the library, right-click the menu. The menu is short on
//! purpose: the quick-copy list, Record meeting, Start dictation, Quit.
//! Everything configured rather than done lives in the library window.

use tauri::image::Image;
use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Wry};
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::core::{core, Phase};
use crate::types::Snippet;

const SNIPPET_LABEL_CHARS: usize = 44;

fn icon(phase: Phase) -> Image<'static> {
    let bytes: &'static [u8] = match phase {
        Phase::Idle => include_bytes!("../../assets/tray-idle@2x.png"),
        Phase::Recording => include_bytes!("../../assets/tray-recording@2x.png"),
        Phase::Processing => include_bytes!("../../assets/tray-processing@2x.png"),
    };
    Image::from_bytes(bytes).expect("tray icon")
}

pub fn clock(seconds: f64) -> String {
    let s = seconds.max(0.0) as u64;
    let (h, m) = (s / 3600, (s / 60) % 60);
    if h > 0 { format!("{h}:{m:02}:{:02}", s % 60) } else { format!("{m}:{:02}", s % 60) }
}

pub fn snippet_label(s: &Snippet) -> String {
    let raw = if s.label.is_empty() { &s.text } else { &s.label };
    let flat = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let short = if flat.chars().count() > SNIPPET_LABEL_CHARS {
        format!("{}…", flat.chars().take(SNIPPET_LABEL_CHARS - 1).collect::<String>())
    } else {
        flat
    };
    // A lone & is a mnemonic marker in a Windows menu.
    short.replace('&', "&&")
}

pub struct TrayView {
    pub phase: Phase,
    pub elapsed: f64,
    pub progress: String,
    pub current_dir: String,
    pub snippets: Vec<Snippet>,
    pub hotkey: String,
    pub dictation_active: bool,
    pub dictation_transcribing: bool,
    pub dictate_hotkey: String,
}

pub struct AppTray {
    tray: TrayIcon,
    phase: Phase,
    menu_key: String,
    snippets: Vec<Snippet>,
}

fn with_key(label: &str, key: &str) -> String {
    if key.is_empty() { label.into() } else { format!("{label} ({key})") }
}

fn build_menu(app: &AppHandle, v: &TrayView) -> tauri::Result<Menu<Wry>> {
    let mut b = MenuBuilder::new(app).item(&MenuItemBuilder::with_id("heading", "Quick copy").enabled(false).build(app)?);
    if v.snippets.is_empty() {
        b = b.item(&MenuItemBuilder::with_id("quickcopy", "No shorthands yet — add one…").build(app)?);
    } else {
        for (i, s) in v.snippets.iter().enumerate() {
            b = b.item(&MenuItemBuilder::with_id(format!("snip:{i}"), snippet_label(s)).build(app)?);
        }
    }
    b = b.separator();
    b = if v.phase == Phase::Recording {
        b.item(&MenuItemBuilder::with_id("stop", with_key("Stop recording", &v.hotkey)).build(app)?)
    } else {
        b.item(&MenuItemBuilder::with_id("record", with_key("Record meeting", &v.hotkey)).build(app)?)
    };
    b = if v.dictation_transcribing {
        b.item(&MenuItemBuilder::with_id("dictating", "Transcribing dictation…").enabled(false).build(app)?)
    } else {
        let label = if v.dictation_active { "Stop dictation" } else { "Start dictation" };
        b.item(&MenuItemBuilder::with_id("dictate", with_key(label, &v.dictate_hotkey)).build(app)?)
    };
    b = b.separator();
    let quit = if v.phase == Phase::Recording { "Quit Minarrador (saves the recording)" } else { "Quit Minarrador" };
    b.item(&MenuItemBuilder::with_id("quit", quit).build(app)?).build()
}

fn on_menu(app: &AppHandle, id: &str) {
    match id {
        "quickcopy" => crate::windowing::show_library(Some("quickcopy")),
        "record" => crate::recording::start_recording(),
        "stop" => {
            tauri::async_runtime::spawn(crate::recording::stop_recording());
        }
        "dictate" => crate::voice::toggle_dictation(),
        "quit" => crate::app::quit(),
        other => {
            if let Some(i) = other.strip_prefix("snip:").and_then(|n| n.parse::<usize>().ok()) {
                let text = core().tray.lock().unwrap().as_ref().and_then(|t| t.snippets.get(i).map(|s| s.text.clone()));
                if let Some(text) = text {
                    let _ = app.clipboard().write_text(text);
                }
            }
        }
    }
}

impl AppTray {
    pub fn create(app: &AppHandle) -> tauri::Result<AppTray> {
        let tray = TrayIconBuilder::with_id("main")
            .icon(icon(Phase::Idle))
            .tooltip("Minarrador")
            .show_menu_on_left_click(false)
            .on_menu_event(|app, event| on_menu(app, event.id.as_ref()))
            .on_tray_icon_event(|_tray, event| {
                if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                    crate::windowing::show_library(None);
                }
            })
            .build(app)?;
        Ok(AppTray { tray, phase: Phase::Idle, menu_key: String::new(), snippets: vec![] })
    }

    pub fn update(&mut self, app: &AppHandle, v: TrayView) {
        if v.phase != self.phase {
            let _ = self.tray.set_icon(Some(icon(v.phase)));
            self.phase = v.phase;
        }
        let headline = match v.phase {
            Phase::Recording => format!("Recording — {}", clock(v.elapsed)),
            Phase::Processing => if v.progress.is_empty() { "Processing…".into() } else { v.progress.clone() },
            Phase::Idle => "Idle".into(),
        };
        let dir = if v.current_dir.is_empty() { String::new() } else { format!(" — {}", v.current_dir) };
        let _ = self.tray.set_tooltip(Some(format!("Minarrador — {headline}{dir}")));
        // The menu is rebuilt only when it would change, not on every tick.
        let key = format!(
            "{:?}|{}|{}|{}|{}|{}",
            v.phase,
            v.hotkey,
            v.dictation_active,
            v.dictation_transcribing,
            v.dictate_hotkey,
            v.snippets.iter().map(snippet_label).collect::<Vec<_>>().join("\u{1}")
        );
        if key != self.menu_key {
            if let Ok(menu) = build_menu(app, &v) {
                let _ = self.tray.set_menu(Some(menu));
                self.menu_key = key;
            }
        }
        self.snippets = v.snippets;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clocks_and_labels() {
        assert_eq!(clock(65.0), "1:05");
        assert_eq!(clock(3725.0), "1:02:05");
        let s = Snippet { label: String::new(), text: format!("  {}", "x".repeat(60)) };
        assert_eq!(snippet_label(&s).chars().count(), SNIPPET_LABEL_CHARS);
        assert_eq!(snippet_label(&Snippet { label: "Hi".into(), text: "t".into() }), "Hi");
    }
}
