//! Minarrador — local-only meeting notes for Windows.
//!
//! Tray-only: no window at startup. Records mic + system audio, transcribes and
//! summarises with whisper.cpp and Ollama on this machine, and can dictate a
//! sentence into whatever has the cursor. Nothing leaves the machine.

pub mod logger;
pub mod types;
pub mod settings;
pub mod paths;
pub mod wav;
pub mod win;
pub mod ollama;
pub mod whisper;
pub mod whisper_setup;
pub mod oauth;
pub mod cloud;
pub mod pipeline;
pub mod library;
pub mod stores;
pub mod settings_gate;
pub mod diskusage;
pub mod audio_serve;
pub mod audio;
pub mod live;
pub mod capture;
pub mod dictation;
pub mod wallpaper;
pub mod core;
pub mod windowing;
pub mod ui;
pub mod recording;
pub mod services;
pub mod voice;
pub mod pdf;
pub mod tray;
pub mod desktop_todos;
pub mod commands;
pub mod app;

use tauri::RunEvent;

use commands::{dictation as dc, disk as dk, library as lc, settings as sc, sync as sy};

pub fn run() {
    // A fault in the core is logged, not fatal: a recording in progress is
    // worth more than a tidy process.
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log_error!("panic: {info}");
        default_hook(info);
    }));

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|_app, args, _cwd| {
            if core::try_core().is_none() {
                return;
            }
            if args.iter().any(|a| a == "--library") {
                windowing::show_library(None);
            } else {
                windowing::notify("Minarrador is already running", "Look for the waveform icon in your system tray.", None);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .register_asynchronous_uri_scheme_protocol("meeting-audio", |_ctx, request, responder| {
            tauri::async_runtime::spawn_blocking(move || responder.respond(lc::serve_audio(request)));
        })
        .invoke_handler(tauri::generate_handler![
            lc::snippets_list,
            lc::snippets_save,
            lc::todos_list,
            lc::todos_save,
            lc::library_list,
            lc::library_read,
            lc::library_health,
            lc::library_initial_section,
            lc::library_open,
            lc::library_open_notes_folder,
            lc::library_copy,
            lc::library_minimize,
            lc::library_close,
            lc::library_reprocess,
            lc::library_delete,
            lc::library_rename,
            lc::library_record,
            lc::library_pause,
            lc::library_stop,
            sc::settings_get,
            sc::settings_set,
            sc::settings_choose_notes_folder,
            sc::settings_open_ollama,
            sc::settings_open_dictations,
            sc::settings_open_log,
            sc::settings_copy_diagnostics,
            sc::settings_restart_capture,
            sc::settings_cancel_setup,
            sc::settings_test_mic,
            sc::settings_test_mic_stop,
            sc::settings_pull_model,
            sc::settings_install_whisper,
            sy::sync_sign_in,
            sy::sync_sign_out,
            sy::sync_now,
            dk::disk_choose,
            dk::disk_cancel,
            dk::disk_list,
            dk::disk_reveal,
            dk::disk_trash,
            dc::dictations_list,
            dc::dictations_update,
            dc::dictations_remove,
            dc::dictations_copy,
            dc::dictations_close,
        ])
        .setup(|app| {
            if let Err(e) = app::setup(app.handle()) {
                log_error!("startup failed: {e}");
                let log = logger::path().map(|p| format!("Details are in {}", p.display())).unwrap_or_else(|| "The log file was never created.".into());
                win::message_box("Minarrador could not start", &format!("{e}\n\n{log}"));
                std::process::exit(1);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Minarrador");

    app.run(|_app, event| match event {
        // A tray app outlives its windows.
        RunEvent::ExitRequested { code: None, api, .. } => api.prevent_exit(),
        RunEvent::Exit => app::shutdown(),
        _ => {}
    });
}
