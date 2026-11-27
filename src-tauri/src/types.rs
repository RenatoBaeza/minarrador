//! Shapes that cross the bridge between the Rust core and a window.
//!
//! Every struct here serialises to exactly the field names `src/shared/types.d.ts`
//! declares, so the pages keep reading the payloads they always read. The two
//! files are the two halves of one contract: change one, change the other.

use serde::{Deserialize, Serialize};

pub use crate::settings::Settings;

/// Which side of a two-channel recording said a line; `""` when nobody can say.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
pub enum Speaker {
    #[serde(rename = "mic")]
    Mic,
    #[serde(rename = "system")]
    System,
    #[default]
    #[serde(rename = "")]
    None,
}

impl Speaker {
    pub fn key(self) -> &'static str {
        match self {
            Speaker::Mic => "mic",
            Speaker::System => "system",
            Speaker::None => "",
        }
    }

    pub fn parse(value: &str) -> Speaker {
        match value {
            "mic" => Speaker::Mic,
            "system" => Speaker::System,
            _ => Speaker::None,
        }
    }
}

/// A transcription engine: whisper.cpp, or the Ollama audio model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    Whisper,
    Ollama,
}

impl Engine {
    pub fn as_str(self) -> &'static str {
        match self {
            Engine::Whisper => "whisper",
            Engine::Ollama => "ollama",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Snippet {
    pub label: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Todo {
    pub id: String,
    pub title: String,
    pub description: String,
    pub project: String,
    pub priority: String,
    pub due: String,
    pub done: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Dictation {
    pub id: String,
    pub text: String,
    pub created_at: String,
}

/// The answer to a request that can be refused; `reason` is `""` for a quiet no.
#[derive(Debug, Clone, Serialize, Default)]
pub struct Outcome {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl Outcome {
    pub fn ok() -> Self {
        Outcome { ok: true, reason: None }
    }
    pub fn no(reason: impl Into<String>) -> Self {
        Outcome { ok: false, reason: Some(reason.into()) }
    }
    /// Refused without anything to say — a cancelled dialog.
    pub fn quiet() -> Self {
        Outcome { ok: false, reason: None }
    }
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct JobProgress {
    pub phase: String,
    pub done: u64,
    pub total: u64,
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessingEntry {
    pub id: String,
    #[serde(flatten)]
    pub progress: JobProgress,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryActivity {
    pub recording_id: Option<String>,
    pub elapsed: f64,
    pub paused: bool,
    pub live_engine: String,
    pub processing_ids: Vec<String>,
    pub processing: Vec<ProcessingEntry>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LiveLine {
    pub id: String,
    pub text: String,
    pub speaker: Speaker,
}

#[derive(Debug, Clone, Serialize)]
pub struct LibraryList {
    pub meetings: Vec<MeetingCard>,
    pub activity: LibraryActivity,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskEntry {
    pub id: u64,
    pub name: String,
    pub is_directory: bool,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_children: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inaccessible: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiskProgress {
    pub files: u64,
    pub dirs: u64,
    pub current: String,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct DiskChoice {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root: Option<DiskEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entries: Option<Vec<DiskEntry>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhisperDescription {
    pub root: String,
    pub binary: String,
    pub model: String,
    pub models: Vec<String>,
    pub threads: u32,
    pub effective_threads: u32,
    pub thread_choices: Vec<u32>,
    pub available: bool,
    pub running: bool,
    pub port: Option<u16>,
    pub last_error: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SetupState {
    pub kind: String,
    pub label: String,
    pub status: String,
    pub completed: u64,
    pub total: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Choice<T: Serialize> {
    pub value: T,
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct HotkeyState {
    pub value: String,
    pub registered: bool,
    pub choices: Vec<Choice<String>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct OllamaState {
    pub host: String,
    pub up: bool,
    pub checking: bool,
    pub installed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MicState {
    pub devices: Vec<AudioDevice>,
    pub active: String,
    pub chosen: String,
    pub chosen_label: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiskState {
    pub free: Option<u64>,
    pub low: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct DictationFlags {
    pub active: bool,
    pub transcribing: bool,
}

/// Sign-in and sync, for the settings pane. Assembled by `cloud::state`.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncState {
    /// Built with a Google client and a sync server; otherwise not offered.
    pub configured: bool,
    pub signed_in: bool,
    pub signing_in: bool,
    pub syncing: bool,
    pub email: String,
    pub name: String,
    pub last_sync_at: Option<String>,
    pub error: Option<String>,
}

/// Everything the settings pane renders. Assembled by `ui::settings_state`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsState {
    pub version: String,
    pub settings: Settings,
    pub defaults: Settings,
    pub models: Vec<String>,
    pub audio_models: Vec<String>,
    pub whisper: Option<WhisperDescription>,
    pub ollama: OllamaState,
    pub live_engine: Engine,
    pub mic: MicState,
    pub recording_channels: u16,
    pub disk: DiskState,
    pub setup: Option<SetupState>,
    pub whisper_models: Vec<Choice<String>>,
    pub pullable: Vec<String>,
    pub hotkey: HotkeyState,
    pub dictate_hotkey: HotkeyState,
    pub dictation: DictationFlags,
    pub notes_dir_exists: bool,
    pub snippet_count: usize,
    pub recording: bool,
    pub sync: SyncState,
}

#[derive(Debug, Clone, Serialize)]
pub struct HealthItem {
    pub key: &'static str,
    pub label: &'static str,
    pub state: &'static str,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Health {
    pub items: Vec<HealthItem>,
    pub recording: bool,
    pub elapsed: f64,
    pub show: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MicTestUpdate {
    pub testing: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub level: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mic_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mic_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct DictateIndicatorState {
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AudioDevice {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Copy, Serialize, Default)]
pub struct CaptureLevels {
    pub mixed: f32,
    pub mic: f32,
    pub system: f32,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStatus {
    pub mic_ok: bool,
    pub system_ok: bool,
    pub mic_error: String,
    pub system_error: String,
    pub mic_label: String,
    pub running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fatal: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TranscriptSource {
    Pipeline,
    Live,
    None,
}

#[derive(Debug, Clone, Serialize)]
pub struct MeetingFiles {
    pub audio: bool,
    pub transcript: bool,
    pub notes: bool,
    pub pdf: bool,
}

/// A meeting as a rail card: enough to render it, nothing that costs a full read.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingCard {
    pub id: String,
    pub title: String,
    pub generated_title: String,
    pub renamed: bool,
    pub started_at: String,
    pub duration_seconds: f64,
    /// `ready` | `failed` | `unprocessed` | `pending`
    pub status: &'static str,
    pub preview: String,
    pub decisions: usize,
    pub action_items: usize,
    pub transcript_source: TranscriptSource,
    pub files: MeetingFiles,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matches: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptLine {
    pub start_seconds: Option<f64>,
    pub speaker: Speaker,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Decision {
    pub decision: String,
    pub context: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ActionItem {
    pub task: String,
    pub owner: String,
    pub due: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Sources {
    pub mic: bool,
    pub system: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SpeakerNames {
    pub mic: &'static str,
    pub system: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct ModelNames {
    pub transcribe: String,
    pub summary: String,
}

/// Everything the reader pane shows for one meeting.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingDetail {
    pub id: String,
    pub title: String,
    pub generated_title: String,
    pub renamed: bool,
    pub started_at: String,
    pub duration_seconds: f64,
    pub status: &'static str,
    pub preview: String,
    pub transcript_source: TranscriptSource,
    pub files: MeetingFiles,
    pub summary: Vec<String>,
    pub decisions: Vec<Decision>,
    pub action_items: Vec<ActionItem>,
    pub transcript: Vec<TranscriptLine>,
    pub error: String,
    pub sources: Sources,
    pub speakers: SpeakerNames,
    pub models: ModelNames,
}
