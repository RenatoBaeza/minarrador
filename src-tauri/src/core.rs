//! The shared state every part of the app reads: settings, what is recording
//! or processing, the controllers, the stores.
//!
//! One `Core`, created once at startup and reachable from anywhere through
//! [`core()`], because the callers are many and arrive from many threads — the
//! tray, two hotkeys, the windows, the capture worker, timers.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use tauri::AppHandle;
use tokio_util::sync::CancellationToken;

use crate::capture::CaptureController;
use crate::cloud::Cloud;
use crate::dictation::DictationController;
use crate::diskusage::DiskScan;
use crate::library::LibraryCache;
use crate::settings::{Settings, SettingsStore};
use crate::stores::ListStore;
use crate::tray::AppTray;
use crate::types::{Dictation, JobProgress, SetupState, Snippet, Todo};
use crate::whisper::WhisperServer;
use crate::win::SleepBlocker;

/// Below this much free space where meetings go, the pane turns amber.
pub const DISK_WARN_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Progress pushed to the window at most this often.
pub const PROGRESS_MIN_MS: u128 = 700;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Idle,
    Recording,
    Processing,
}

pub struct Job {
    pub cancel: CancellationToken,
    pub progress: JobProgress,
}

pub struct SetupJob {
    pub state: SetupState,
    pub cancel: CancellationToken,
}

#[derive(Default)]
pub struct DiskInfo {
    pub free: Option<u64>,
    pub checked_at: Option<Instant>,
    pub warned: bool,
}

pub struct AppState {
    pub phase: Phase,
    pub progress: String,
    pub current_dir: Option<PathBuf>,
    /// Where live captions go — kept past Stop, so the segment still decoding
    /// when Stop is pressed lands in the meeting it was said in.
    pub live_dir: Option<PathBuf>,
    pub recording_started_at: Option<chrono::DateTime<chrono::Utc>>,
    pub warned_long_at: f64,
    pub disk: DiskInfo,
    pub sleep_blocker: Option<SleepBlocker>,
    pub last_dir: Option<PathBuf>,
    pub ollama_up: bool,
    pub ollama_checking: bool,
    pub models: Vec<String>,
    pub audio_models: Vec<String>,
    /// One entry per meeting folder mid-pipeline; two runs can overlap.
    pub jobs: HashMap<PathBuf, Job>,
    pub setup: Option<SetupJob>,
    pub hotkey: Option<String>,
    pub hotkey_registered: bool,
    pub dictate_hotkey: Option<String>,
    pub dictate_hotkey_registered: bool,
    pub retry: Option<(String, String)>,
    pub quitting: bool,
    /// Only one caller can end a meeting: the first one in sets this.
    pub stopping: bool,
    pub mic_testing: bool,
    pub mic_test_generation: u64,
    /// The loudest each source has been since Start, for the health strip.
    pub heard: (f32, f32),
    pub library_section: Option<String>,
    pub last_progress_at: Option<Instant>,
    pub last_setup_at: Option<Instant>,
    pub indicator_generation: u64,
}

impl Default for AppState {
    fn default() -> Self {
        AppState {
            phase: Phase::Idle,
            progress: String::new(),
            current_dir: None,
            live_dir: None,
            recording_started_at: None,
            warned_long_at: 0.0,
            disk: DiskInfo::default(),
            sleep_blocker: None,
            last_dir: None,
            ollama_up: false,
            ollama_checking: false,
            models: vec![],
            audio_models: vec![],
            jobs: HashMap::new(),
            setup: None,
            hotkey: None,
            hotkey_registered: false,
            dictate_hotkey: None,
            dictate_hotkey_registered: false,
            retry: None,
            quitting: false,
            stopping: false,
            mic_testing: false,
            mic_test_generation: 0,
            heard: (0.0, 0.0),
            library_section: None,
            last_progress_at: None,
            last_setup_at: None,
            indicator_generation: 0,
        }
    }
}

pub struct Core {
    pub app: AppHandle,
    pub user_data: PathBuf,
    pub started_hidden: bool,
    pub store: SettingsStore,
    pub state: Mutex<AppState>,
    pub whisper: Arc<WhisperServer>,
    pub capture: CaptureController,
    pub dictation: DictationController,
    pub cache: Mutex<LibraryCache>,
    pub snippets: ListStore<Snippet>,
    pub todos: ListStore<Todo>,
    pub dictations: ListStore<Dictation>,
    pub disk_scan: Mutex<Option<DiskScan>>,
    pub disk_cancel: Mutex<Option<CancellationToken>>,
    pub tray: Mutex<Option<AppTray>>,
    pub cloud: Cloud,
}

static CORE: OnceLock<Arc<Core>> = OnceLock::new();

pub fn install(core: Arc<Core>) {
    let _ = CORE.set(core);
}

pub fn core() -> &'static Arc<Core> {
    CORE.get().expect("core used before startup")
}

pub fn try_core() -> Option<&'static Arc<Core>> {
    CORE.get()
}

impl Core {
    pub fn settings(&self) -> Settings {
        self.store.get()
    }

    pub fn state(&self) -> std::sync::MutexGuard<'_, AppState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn notes_dir(&self) -> PathBuf {
        PathBuf::from(self.settings().notes_dir)
    }

    pub fn version(&self) -> String {
        self.app.package_info().version.to_string()
    }
}

pub fn human(bytes: u64) -> String {
    if bytes >= 1024 * 1024 * 1024 {
        format!("{:.1} GB", bytes as f64 / (1024.0 * 1024.0 * 1024.0))
    } else {
        format!("{} MB", (bytes as f64 / (1024.0 * 1024.0)).round())
    }
}

pub fn folder_name(dir: &std::path::Path) -> String {
    dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}
