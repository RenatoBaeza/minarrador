//! Voice input: press the hotkey, say a sentence, press it again, and the text
//! is pasted where you were typing.
//!
//! A second worker, not a second graph: it owns its own microphone stream, so a
//! dictation can run in the middle of a recorded meeting without either
//! disturbing the other. The live caption is a preview; the finished text comes
//! from a careful pass over the whole clip, trimmed of room tone.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::mpsc::UnboundedSender;

use crate::audio::{self, to_i16};
use crate::live::LiveTranscriber;
use crate::ollama::Ollama;
use crate::types::Engine;
use crate::wav::{build_wav, rms, SAMPLE_RATE};
use crate::whisper::{timeout_for, WhisperServer};
use crate::{log_error, log_info, log_warn};

const RATE: usize = SAMPLE_RATE as usize;
/// A session nobody stops is ended at five minutes.
pub const MAX_SECONDS: usize = 300;
pub const SILENCE_GATE: f64 = 0.004;

/// The engine for the finished text: the one asked for when it can run, else
/// whichever can — a dictation should never fail for want of a preference.
pub fn dictation_engine_for(setting: &str, whisper_available: bool, ollama_up: bool) -> Engine {
    let wants_whisper = setting != "ollama";
    if wants_whisper && whisper_available {
        Engine::Whisper
    } else if !wants_whisper && ollama_up {
        Engine::Ollama
    } else if whisper_available {
        Engine::Whisper
    } else {
        Engine::Ollama
    }
}

/// Cuts room tone off both ends with a 50 ms windowed RMS gate.
pub fn trim_silence(pcm: &[i16], gate: f64) -> &[i16] {
    let window = RATE / 20;
    let (mut first, mut last) = (None, 0);
    let mut start = 0;
    while start < pcm.len() {
        let end = (start + window).min(pcm.len());
        if rms(&pcm[start..end]) >= gate {
            first.get_or_insert(start);
            last = end;
        }
        start += window;
    }
    match first {
        Some(f) => &pcm[f..last],
        None => &pcm[0..0],
    }
}

#[derive(Debug, Clone)]
pub enum DictationEvent {
    Live(String),
    Cap,
    Level(f32),
    Status { label: String, error: String },
}

enum Cmd {
    Start { id: String, label: String, test: bool },
    Stop(Option<mpsc::Sender<()>>),
    Shutdown,
}

#[derive(Debug, Default)]
pub struct DictationResult {
    pub text: String,
    pub seconds: f64,
    pub error: String,
    pub saved: Option<PathBuf>,
}

struct Shared {
    chunks: Mutex<Vec<i16>>,
    active: AtomicBool,
    capped: AtomicBool,
    mic_error: Mutex<String>,
    events: UnboundedSender<DictationEvent>,
    live: Arc<LiveTranscriber>,
}

fn worker(shared: Arc<Shared>, rx: mpsc::Receiver<Cmd>) {
    let mut source: Option<audio::Source> = None;
    let mut test = false;
    let mut last_level = Instant::now();
    let mut level_acc = (0.0f64, 0usize);
    loop {
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(Cmd::Start { id, label, test: t }) => {
                test = t;
                source = None;
                *shared.mic_error.lock().unwrap() = String::new();
                match audio::open_mic(&id, &label, Instant::now()) {
                    Ok((s, note)) => {
                        let error = note.unwrap_or_default();
                        if !error.is_empty() {
                            log_warn!("dictation mic: {error}");
                        }
                        let _ = shared.events.send(DictationEvent::Status { label: s.label.clone(), error });
                        source = Some(s);
                    }
                    Err(e) => {
                        log_error!("dictation capture: {e}");
                        *shared.mic_error.lock().unwrap() = e.clone();
                        let _ = shared.events.send(DictationEvent::Status { label: String::new(), error: e });
                    }
                }
            }
            Ok(Cmd::Stop(ack)) => {
                if let Some(s) = source.take() {
                    deliver(&shared, &s.queue.take_all(), test);
                }
                if let Some(a) = ack {
                    let _ = a.send(());
                }
            }
            Ok(Cmd::Shutdown) | Err(RecvTimeoutError::Disconnected) => return,
            Err(RecvTimeoutError::Timeout) => {}
        }
        if let Some(s) = &source {
            if s.failed() {
                *shared.mic_error.lock().unwrap() = "The microphone went away.".into();
                source = None;
                continue;
            }
            let samples = s.queue.take_all();
            level_acc.0 += samples.iter().map(|x| (*x as f64).powi(2)).sum::<f64>();
            level_acc.1 += samples.len();
            deliver(&shared, &samples, test);
            if last_level.elapsed() >= Duration::from_millis(100) && level_acc.1 > 0 {
                let level = (level_acc.0 / level_acc.1 as f64).sqrt() as f32;
                let _ = shared.events.send(DictationEvent::Level(level));
                level_acc = (0.0, 0);
                last_level = Instant::now();
            }
        }
    }
}

fn deliver(shared: &Shared, samples: &[f32], test: bool) {
    if test || samples.is_empty() || !shared.active.load(Ordering::Relaxed) {
        return;
    }
    let pcm: Vec<i16> = samples.iter().map(|&s| to_i16(s)).collect();
    let total = {
        let mut chunks = shared.chunks.lock().unwrap();
        chunks.extend_from_slice(&pcm);
        chunks.len()
    };
    shared.live.push(&pcm);
    if total >= MAX_SECONDS * RATE && !shared.capped.swap(true, Ordering::Relaxed) {
        let _ = shared.events.send(DictationEvent::Cap);
    }
}

pub struct DictationController {
    shared: Arc<Shared>,
    cmd: mpsc::Sender<Cmd>,
    transcribing: AtomicBool,
    whisper: Arc<WhisperServer>,
    ollama: Ollama,
    error_dir: PathBuf,
}

impl DictationController {
    pub fn new(events: UnboundedSender<DictationEvent>, whisper: Arc<WhisperServer>, ollama: Ollama, error_dir: PathBuf) -> DictationController {
        let live = LiveTranscriber::new(whisper.clone(), ollama.clone());
        let tx = events.clone();
        live.on_text(Arc::new(move |text, _| {
            let _ = tx.send(DictationEvent::Live(text));
        }));
        let shared = Arc::new(Shared {
            chunks: Mutex::new(vec![]),
            active: AtomicBool::new(false),
            capped: AtomicBool::new(false),
            mic_error: Mutex::new(String::new()),
            events,
            live,
        });
        let (cmd, rx) = mpsc::channel();
        let s = shared.clone();
        std::thread::Builder::new().name("dictation".into()).spawn(move || worker(s, rx)).expect("dictation thread");
        DictationController { shared, cmd, transcribing: AtomicBool::new(false), whisper, ollama, error_dir }
    }

    pub fn active(&self) -> bool {
        self.shared.active.load(Ordering::Relaxed)
    }

    pub fn transcribing(&self) -> bool {
        self.transcribing.load(Ordering::Relaxed)
    }

    pub fn start(&self, mic_id: &str, mic_label: &str, model: &str, live_engine: &str) {
        if self.active() {
            return;
        }
        self.shared.chunks.lock().unwrap().clear();
        self.shared.capped.store(false, Ordering::Relaxed);
        self.shared.active.store(true, Ordering::Relaxed);
        self.transcribing.store(false, Ordering::Relaxed);
        self.shared.live.configure(true, live_engine, model);
        self.shared.live.start(1);
        let (ollama, model_owned) = (self.ollama.clone(), model.to_string());
        tauri::async_runtime::spawn(async move {
            ollama.preload(&model_owned).await;
        });
        let _ = self.cmd.send(Cmd::Start { id: mic_id.into(), label: mic_label.into(), test: false });
        log_info!("dictation started");
    }

    /// Opens the mic for the settings pane's meter; records nothing.
    pub fn start_test(&self, mic_id: &str, mic_label: &str) {
        if self.active() {
            return;
        }
        let _ = self.cmd.send(Cmd::Start { id: mic_id.into(), label: mic_label.into(), test: true });
    }

    pub fn stop_test(&self) {
        if !self.active() {
            let _ = self.cmd.send(Cmd::Stop(None));
        }
    }

    pub fn cancel(&self) {
        if !self.active() {
            return;
        }
        self.shared.active.store(false, Ordering::Relaxed);
        self.transcribing.store(false, Ordering::Relaxed);
        self.shared.live.stop();
        let _ = self.cmd.send(Cmd::Stop(None));
        self.shared.chunks.lock().unwrap().clear();
    }

    pub async fn stop(&self, engine: Engine, model: &str) -> DictationResult {
        if !self.active() {
            return DictationResult::default();
        }
        self.transcribing.store(true, Ordering::Relaxed);
        let (ack_tx, ack_rx) = mpsc::channel();
        let _ = self.cmd.send(Cmd::Stop(Some(ack_tx)));
        self.shared.live.stop();
        let _ = tokio::task::spawn_blocking(move || ack_rx.recv_timeout(Duration::from_secs(2))).await;
        self.shared.active.store(false, Ordering::Relaxed);
        let pcm = std::mem::take(&mut *self.shared.chunks.lock().unwrap());
        let seconds = pcm.len() as f64 / RATE as f64;
        let mic_error = self.shared.mic_error.lock().unwrap().clone();
        if seconds < 0.25 && !mic_error.is_empty() {
            self.transcribing.store(false, Ordering::Relaxed);
            return DictationResult { seconds, error: mic_error, ..Default::default() };
        }
        let trimmed = trim_silence(&pcm, SILENCE_GATE).to_vec();
        let mut result = DictationResult { seconds, ..Default::default() };
        if !trimmed.is_empty() && rms(&trimmed) >= SILENCE_GATE && trimmed.len() >= RATE {
            match self.transcribe(&trimmed, engine, model).await {
                Ok(text) => result.text = text,
                Err(e) => {
                    log_error!("dictation transcription failed: {e}");
                    result.saved = self.save_clip(&trimmed);
                    result.error = e;
                }
            }
        }
        self.transcribing.store(false, Ordering::Relaxed);
        log_info!(
            "dictation stopped: {seconds:.1}s, {}",
            if result.text.is_empty() { "no speech".to_string() } else { format!("{} chars", result.text.len()) }
        );
        result
    }

    async fn transcribe(&self, pcm: &[i16], engine: Engine, model: &str) -> Result<String, String> {
        let seconds = pcm.len() as f64 / RATE as f64;
        let wav = build_wav(pcm, SAMPLE_RATE, 1);
        match engine {
            Engine::Whisper => {
                if !self.whisper.available() {
                    return Err("whisper.cpp is not installed".into());
                }
                self.whisper.transcribe(wav, None, None, timeout_for(seconds), None).await.map_err(|e| e.to_string())
            }
            Engine::Ollama => {
                if model.is_empty() {
                    return Err("no Ollama audio model is configured".into());
                }
                self.ollama.transcribe(model, &wav, None, Some(seconds), None).await.map_err(|e| e.to_string())
            }
        }
    }

    /// A clip whose words could not be written down is kept as a WAV, so a
    /// machine that comes back can still finish the job.
    fn save_clip(&self, pcm: &[i16]) -> Option<PathBuf> {
        let stamp = chrono::Utc::now().format("%Y-%m-%dT%H-%M-%S-%3fZ");
        let file = self.error_dir.join(format!("dictation-{stamp}.wav"));
        std::fs::create_dir_all(&self.error_dir).ok()?;
        std::fs::write(&file, build_wav(pcm, SAMPLE_RATE, 1)).ok()?;
        Some(file)
    }

    pub fn destroy(&self) {
        self.shared.live.stop();
        let _ = self.cmd.send(Cmd::Shutdown);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trims_room_tone() {
        let mut pcm = vec![0i16; 16_000];
        pcm.extend(vec![3000i16; 8_000]);
        pcm.extend(vec![0i16; 16_000]);
        let t = trim_silence(&pcm, SILENCE_GATE);
        assert_eq!(t.len(), 8_000);
        assert!(trim_silence(&[0; 4000], SILENCE_GATE).is_empty());
    }

    #[test]
    fn engine_choice() {
        assert_eq!(dictation_engine_for("whisper", true, true), Engine::Whisper);
        assert_eq!(dictation_engine_for("ollama", true, true), Engine::Ollama);
        assert_eq!(dictation_engine_for("ollama", true, false), Engine::Whisper);
        assert_eq!(dictation_engine_for("whisper", false, false), Engine::Ollama);
    }
}
