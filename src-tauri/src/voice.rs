//! The dictation gesture end to end, and the settings pane's microphone test.

use std::time::Duration;

use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::core::core;
use crate::dictation::{dictation_engine_for, DictationEvent};
use crate::types::{Engine, MicTestUpdate, Outcome};
use crate::ui::refresh_tray;
use crate::windowing::{emit_library, notify, notify_dictations, schedule_indicator_hide, send_to_dictate, show_dictations, show_indicator};
use crate::{log_info, log_warn};

const MIC_TEST_MAX: Duration = Duration::from_secs(15);

pub fn toggle_dictation() {
    if core().dictation.active() {
        tauri::async_runtime::spawn(stop_dictation());
    } else {
        start_dictation();
    }
}

fn start_dictation() {
    let c = core();
    if c.dictation.active() {
        return;
    }
    stop_mic_test();
    if !c.whisper.available() && crate::ollama::find_ollama().is_none() {
        notify("Voice input is not ready", "Neither Ollama nor whisper.cpp is installed, so nothing could transcribe it.", None);
        return;
    }
    let s = c.settings();
    c.dictation.start(&s.mic_device_id, &s.mic_device_label, &s.transcribe_model, &s.live_engine);
    show_indicator();
    send_to_dictate("listening", None, None);
    refresh_tray();
}

pub async fn stop_dictation() {
    let c = core();
    if !c.dictation.active() {
        return;
    }
    send_to_dictate("transcribing", None, None);
    refresh_tray();
    let s = c.settings();
    let ollama_up = c.state().ollama_up;
    let engine = dictation_engine_for(&s.dictate_engine, c.whisper.available(), ollama_up);
    let model = if engine == Engine::Whisper { String::new() } else { s.transcribe_model.clone() };
    let result = c.dictation.stop(engine, &model).await;
    refresh_tray();
    if result.text.is_empty() {
        if !result.error.is_empty() {
            let body = if result.saved.is_some() {
                format!("Could not transcribe: {}. The audio is kept — open it to check.", result.error)
            } else {
                format!("Could not transcribe: {}.", result.error)
            };
            let click = result.saved.clone().and_then(|p| p.parent().map(|d| d.to_path_buf())).map(|dir| {
                Box::new(move || crate::recording::open_path(&dir)) as crate::windowing::OnClick
            });
            notify("Voice input failed", &body, click);
            send_to_dictate("error", None, Some(result.error));
        } else {
            notify("Nothing heard", "No speech was captured. Press the voice-input shortcut and try again.", None);
            send_to_dictate("error", None, Some("Nothing was heard".into()));
        }
        schedule_indicator_hide();
        return;
    }
    let _ = c.app.clipboard().write_text(result.text.clone());
    let mut pasted = false;
    if s.dictate_auto_paste {
        pasted = tokio::task::spawn_blocking(crate::win::paste_clipboard).await.unwrap_or(false);
        if !pasted {
            log_warn!("the auto-paste did not land — the clipboard still holds the text");
        }
    }
    c.dictations.add(&result.text);
    notify_dictations();
    let preview = if result.text.chars().count() > 90 { format!("{}…", result.text.chars().take(90).collect::<String>()) } else { result.text.clone() };
    let title = if pasted {
        "Dictated and pasted"
    } else if s.dictate_auto_paste {
        "Dictated — copied to clipboard"
    } else {
        "Dictated"
    };
    let suffix = if s.dictate_auto_paste && !pasted { " (could not paste here; the text is on your clipboard)" } else { "" };
    notify(title, &format!("{preview}{suffix}"), Some(Box::new(show_dictations)));
    send_to_dictate("done", None, None);
    schedule_indicator_hide();
    log_info!("dictation finished: {:.1}s", result.seconds);
}

/// What the dictation worker reports, routed to the pill or the mic meter.
pub fn on_event(event: DictationEvent) {
    let c = core();
    match event {
        DictationEvent::Live(text) => {
            if c.dictation.active() {
                send_to_dictate("listening", Some(text), None);
            }
        }
        DictationEvent::Cap => {
            if c.dictation.active() {
                log_warn!("stopping the dictation at the length cap");
                notify("Voice input stopped", "That was a long one — Minarrador cut it off at the five-minute ceiling.", None);
                tauri::async_runtime::spawn(stop_dictation());
            }
        }
        DictationEvent::Level(level) => {
            if c.state().mic_testing {
                send_mic_test(MicTestUpdate { testing: true, level: Some(level), ..Default::default() });
            }
        }
        DictationEvent::Status { label, error } => {
            if c.state().mic_testing {
                send_mic_test(MicTestUpdate { testing: true, mic_label: Some(label), mic_error: Some(error), ..Default::default() });
            }
        }
    }
}

pub fn start_mic_test() -> Outcome {
    let c = core();
    if c.dictation.active() {
        return Outcome::no("A dictation is in progress — finish it first.");
    }
    let generation = {
        let mut s = c.state();
        if s.mic_testing {
            return Outcome::no("A microphone test is already running.");
        }
        s.mic_testing = true;
        s.mic_test_generation += 1;
        s.mic_test_generation
    };
    let settings = c.settings();
    c.dictation.start_test(&settings.mic_device_id, &settings.mic_device_label);
    send_mic_test(MicTestUpdate { testing: true, ..Default::default() });
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(MIC_TEST_MAX).await;
        if core().state().mic_test_generation == generation {
            stop_mic_test();
        }
    });
    Outcome::ok()
}

pub fn stop_mic_test() {
    let Some(c) = crate::core::try_core() else { return };
    {
        let mut s = c.state();
        if !s.mic_testing {
            return;
        }
        s.mic_testing = false;
        s.mic_test_generation += 1;
    }
    c.dictation.stop_test();
    send_mic_test(MicTestUpdate { testing: false, level: Some(0.0), ..Default::default() });
}

fn send_mic_test(update: MicTestUpdate) {
    emit_library("settings:micTest", update);
}
