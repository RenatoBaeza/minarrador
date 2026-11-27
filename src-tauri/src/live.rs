//! The live transcript, and the two level watchers.
//!
//! The live preview cuts recorded PCM into segments at natural pauses (not on a
//! fixed clock), with a ceiling for someone who never pauses, and sends each to
//! whisper.cpp — or the Ollama audio model when whisper is not installed. It is
//! a rough preview, always superseded by the pipeline's careful pass.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::ollama::Ollama;
use crate::types::{Engine, Speaker};
use crate::wav::{self, build_wav, channel_rms, downmix, rms};
use crate::whisper::{WhisperServer, REQUEST_TIMEOUT};
use crate::log_warn;

const RATE: usize = 16_000;
const POLL: Duration = Duration::from_millis(250);
/// Oldest audio is dropped beyond this, so a slow engine cannot fall ever
/// further behind; the saved transcript comes from a separate pass anyway.
const MAX_SECONDS: usize = 20;
const SILENCE_RMS: f64 = 0.004;
const PROMPT_CHARS: usize = 300;

/// (min voiced seconds, max seconds, trailing silence that ends a segment).
/// whisper decodes a few seconds in a fraction of one, so it can afford short
/// segments; an audio LLM costs ~1 s per request regardless of length.
fn shape(engine: Engine) -> (f64, f64, f64) {
    match engine {
        Engine::Whisper => (1.0, 12.0, 0.6),
        Engine::Ollama => (4.0, 20.0, 0.9),
    }
}

/// The segmenting state, kept apart from the engines so it can be tested.
#[derive(Default)]
pub struct Segmenter {
    pub channels: u16,
    chunks: VecDeque<Vec<i16>>,
    /// All counts are interleaved samples, so "seconds" scale with channels.
    pub samples: usize,
    pub quiet: usize,
    pub voiced: usize,
    voiced_by: [usize; 2],
}

impl Segmenter {
    pub fn per_second(&self) -> usize {
        RATE * self.channels.max(1) as usize
    }

    pub fn reset(&mut self) {
        self.chunks.clear();
        self.samples = 0;
        self.quiet = 0;
        self.voiced = 0;
        self.voiced_by = [0, 0];
    }

    pub fn push(&mut self, buf: &[i16]) {
        let levels = if self.channels == 2 { [channel_rms(buf, 2, 0), channel_rms(buf, 2, 1)] } else { [rms(buf), 0.0] };
        if levels[0].max(levels[1]) < SILENCE_RMS {
            self.quiet += buf.len();
        } else {
            self.quiet = 0;
            self.voiced += buf.len();
            for c in 0..2 {
                if levels[c] >= SILENCE_RMS {
                    self.voiced_by[c] += buf.len();
                }
            }
        }
        self.chunks.push_back(buf.to_vec());
        self.samples += buf.len();
        while self.samples > MAX_SECONDS * self.per_second() && self.chunks.len() > 1 {
            if let Some(old) = self.chunks.pop_front() {
                self.samples -= old.len();
            }
        }
        self.voiced = self.voiced.min(self.samples);
    }

    pub fn ready(&self, engine: Engine) -> bool {
        let (min, max, hold) = shape(engine);
        let per = self.per_second() as f64;
        if self.samples as f64 >= max * per {
            return true;
        }
        if (self.voiced as f64) < min * per {
            return false;
        }
        self.quiet as f64 >= hold * per
    }

    /// Whichever side carried most of the segment, by a 2:1 margin — the mic
    /// hears the speakers, so a wrong label is worse than none.
    pub fn speaker(&self) -> Speaker {
        if self.channels != 2 {
            return Speaker::None;
        }
        let [mic, system] = self.voiced_by;
        if mic > system * 2 {
            Speaker::Mic
        } else if system > mic * 2 {
            Speaker::System
        } else {
            Speaker::None
        }
    }

    fn take(&mut self) -> Vec<i16> {
        let out: Vec<i16> = self.chunks.drain(..).flatten().collect();
        self.reset();
        out
    }
}

struct LiveState {
    enabled: bool,
    preferred: Engine,
    model: String,
    seg: Segmenter,
    tail: String,
    busy: bool,
    running: bool,
    generation: u64,
}

pub type TextHook = Arc<dyn Fn(String, Speaker) + Send + Sync>;

pub struct LiveTranscriber {
    state: Mutex<LiveState>,
    whisper: Arc<WhisperServer>,
    ollama: Ollama,
    hook: Mutex<Option<TextHook>>,
}

impl LiveTranscriber {
    pub fn new(whisper: Arc<WhisperServer>, ollama: Ollama) -> Arc<LiveTranscriber> {
        Arc::new(LiveTranscriber {
            state: Mutex::new(LiveState {
                enabled: false,
                preferred: Engine::Whisper,
                model: String::new(),
                seg: Segmenter::default(),
                tail: String::new(),
                busy: false,
                running: false,
                generation: 0,
            }),
            whisper,
            ollama,
            hook: Mutex::new(None),
        })
    }

    pub fn on_text(&self, hook: TextHook) {
        *self.hook.lock().unwrap() = Some(hook);
    }

    /// The engine actually in use: whisper falls back to Ollama on its own.
    pub fn engine(&self) -> Engine {
        let preferred = self.state.lock().unwrap().preferred;
        if preferred == Engine::Whisper && self.whisper.available() { Engine::Whisper } else { Engine::Ollama }
    }

    fn ready(&self) -> bool {
        match self.engine() {
            Engine::Whisper => true,
            Engine::Ollama => !self.state.lock().unwrap().model.is_empty(),
        }
    }

    pub fn enabled(&self) -> bool {
        self.state.lock().unwrap().enabled
    }

    pub fn configure(self: &Arc<Self>, enabled: bool, engine: &str, model: &str) {
        let was = self.engine();
        let (was_model, running) = {
            let mut s = self.state.lock().unwrap();
            let was_model = s.model.clone();
            s.enabled = enabled;
            s.preferred = if engine == "ollama" { Engine::Ollama } else { Engine::Whisper };
            s.model = model.to_string();
            (was_model, s.running)
        };
        if !enabled {
            self.stop();
        } else if running && (self.engine() != was || model != was_model) {
            self.warm();
        }
    }

    pub fn start(self: &Arc<Self>, channels: u16) {
        if !self.enabled() || !self.ready() {
            return;
        }
        let generation = {
            let mut s = self.state.lock().unwrap();
            if s.running {
                return;
            }
            s.seg.channels = if channels == 2 { 2 } else { 1 };
            s.seg.reset();
            s.tail.clear();
            s.running = true;
            s.generation += 1;
            s.generation
        };
        self.warm();
        let me = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(POLL).await;
                let ready = {
                    let s = me.state.lock().unwrap();
                    if !s.running || s.generation != generation {
                        return;
                    }
                    s.seg.samples > 0
                };
                if ready {
                    let engine = me.engine();
                    let due = me.state.lock().unwrap().seg.ready(engine);
                    if due {
                        me.drain().await;
                    }
                }
            }
        });
    }

    pub fn stop(&self) {
        let mut s = self.state.lock().unwrap();
        s.running = false;
        s.generation += 1;
        s.seg.reset();
    }

    fn warm(self: &Arc<Self>) {
        let engine = self.engine();
        let me = self.clone();
        tauri::async_runtime::spawn(async move {
            match engine {
                Engine::Whisper => {
                    if let Err(e) = me.whisper.ensure_ready().await {
                        log_warn!("whisper warm-up failed: {e}");
                    }
                }
                Engine::Ollama => {
                    let model = me.state.lock().unwrap().model.clone();
                    me.ollama.preload(&model).await;
                }
            }
        });
    }

    pub fn push(&self, buf: &[i16]) {
        let mut s = self.state.lock().unwrap();
        if s.running {
            s.seg.push(buf);
        }
    }

    async fn drain(self: &Arc<Self>) {
        let engine = self.engine();
        let (raw, channels, speaker, tail, model, seconds) = {
            let mut s = self.state.lock().unwrap();
            if s.busy || s.seg.samples < s.seg.per_second() {
                return;
            }
            s.busy = true;
            let speaker = s.seg.speaker();
            let channels = s.seg.channels;
            let seconds = s.seg.samples as f64 / s.seg.per_second() as f64;
            (s.seg.take(), channels, speaker, s.tail.clone(), s.model.clone(), seconds)
        };
        let result = if rms(&raw) < SILENCE_RMS {
            Ok(String::new())
        } else {
            let pcm = if channels == 2 { downmix(&raw, 2) } else { raw };
            let wav = build_wav(&pcm, wav::SAMPLE_RATE, 1);
            match engine {
                Engine::Whisper => self.whisper.transcribe(wav, None, Some(&tail), REQUEST_TIMEOUT, None).await.map_err(|e| e.to_string()),
                Engine::Ollama => self.ollama.transcribe(&model, &wav, None, Some(seconds), None).await.map_err(|e| e.to_string()),
            }
        };
        let text = match result {
            Ok(t) => t,
            Err(e) => {
                log_warn!("live transcription ({}) failed: {e}", engine.as_str());
                String::new()
            }
        };
        {
            let mut s = self.state.lock().unwrap();
            s.busy = false;
            if !text.is_empty() {
                let count = text.chars().count();
                s.tail = text.chars().skip(count.saturating_sub(PROMPT_CHARS)).collect();
            }
        }
        if !text.is_empty() {
            let hook = self.hook.lock().unwrap().clone();
            if let Some(h) = hook {
                h(text, speaker);
            }
        }
    }
}

/// Watches idle levels (one push every 200 ms) and says when sustained audio
/// sounds like a meeting starting.
pub struct SpeechDetector {
    size: usize,
    ratio: f64,
    floor: f32,
    samples: VecDeque<u8>,
    muted_until: Option<std::time::Instant>,
}

impl Default for SpeechDetector {
    fn default() -> Self {
        SpeechDetector { size: 75, ratio: 0.55, floor: 0.006, samples: VecDeque::new(), muted_until: None }
    }
}

impl SpeechDetector {
    pub fn reset(&mut self) {
        self.samples.clear();
    }

    pub fn snooze(&mut self, d: Duration) {
        self.muted_until = Some(std::time::Instant::now() + d);
        self.reset();
    }

    /// True when the window just turned out to be mostly sound.
    pub fn push(&mut self, mic: f32, system: f32) -> bool {
        self.samples.push_back(u8::from(mic.max(system) >= self.floor));
        if self.samples.len() > self.size {
            self.samples.pop_front();
        }
        if self.samples.len() < self.size || self.muted_until.is_some_and(|t| std::time::Instant::now() < t) {
            return false;
        }
        let active = self.samples.iter().map(|&b| b as f64).sum::<f64>() / self.samples.len() as f64;
        if active >= self.ratio {
            self.snooze(Duration::from_secs(600));
            return true;
        }
        false
    }
}

/// The inverse during a recording: ends a meeting nobody stopped.
#[derive(Default)]
pub struct SilenceDetector {
    pub minutes: u32,
    quiet: u64,
    fired: bool,
}

impl SilenceDetector {
    const FLOOR: f32 = 0.006;

    pub fn configure(&mut self, minutes: u32) {
        self.minutes = minutes;
    }

    pub fn reset(&mut self) {
        self.quiet = 0;
        self.fired = false;
    }

    /// True once, when `minutes` of silence have gone by.
    pub fn push(&mut self, mic: f32, system: f32) -> bool {
        if self.minutes == 0 || self.fired {
            return false;
        }
        if mic.max(system) >= Self::FLOOR {
            self.quiet = 0;
            return false;
        }
        self.quiet += 1;
        if self.quiet * 200 < self.minutes as u64 * 60_000 {
            return false;
        }
        self.fired = true;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(samples: usize, level: i16) -> Vec<i16> {
        vec![level; samples]
    }

    #[test]
    fn segments_end_at_pauses() {
        let mut s = Segmenter { channels: 1, ..Default::default() };
        s.push(&tone(16_000, 3000));
        assert!(!s.ready(Engine::Whisper), "no pause yet");
        s.push(&tone(9_600, 0));
        assert!(s.ready(Engine::Whisper));
        assert!(!s.ready(Engine::Ollama), "the audio model waits for more speech");
    }

    #[test]
    fn segments_have_a_ceiling_and_a_cap() {
        let mut s = Segmenter { channels: 1, ..Default::default() };
        for _ in 0..13 {
            s.push(&tone(16_000, 3000));
        }
        assert!(s.ready(Engine::Whisper));
        for _ in 0..20 {
            s.push(&tone(16_000, 3000));
        }
        assert!(s.samples <= MAX_SECONDS * 16_000);
    }

    #[test]
    fn infers_the_speaker_with_a_margin() {
        let mut s = Segmenter { channels: 2, ..Default::default() };
        let mut buf = vec![];
        for _ in 0..1000 {
            buf.extend([3000, 0]);
        }
        s.push(&buf);
        assert_eq!(s.speaker(), Speaker::Mic);
        let both: Vec<i16> = (0..4000).map(|_| 3000).collect();
        s.push(&both);
        assert_eq!(s.speaker(), Speaker::None);
    }

    #[test]
    fn detectors() {
        let mut speech = SpeechDetector::default();
        let fired = (0..75).map(|_| speech.push(0.1, 0.0)).filter(|&f| f).count();
        assert_eq!(fired, 1);
        assert!(!(0..75).any(|_| speech.push(0.1, 0.0)), "snoozed");

        let mut silence = SilenceDetector::default();
        silence.configure(1);
        assert!(!(0..299).any(|_| silence.push(0.0, 0.0)));
        assert!(silence.push(0.0, 0.0));
        assert!(!silence.push(0.0, 0.0), "fires once");
        silence.reset();
        assert!(!silence.push(0.1, 0.0));
    }
}
