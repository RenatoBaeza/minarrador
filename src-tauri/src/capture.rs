//! Meeting capture: a worker thread that owns the audio streams and mixes them,
//! and the controller that writes what it mixes to the WAV.
//!
//! The worker plays the part the hidden Chromium window played in the Electron
//! build: it opens the microphone and WASAPI loopback, puts the mic on the left
//! and the system on the right, and ships 16 kHz PCM plus levels. The layout is
//! decided here, by the side that owns the file, because a WAV header declares
//! its channel count once and has to keep it.
//!
//! A worker that dies is the one failure that must not pass unnoticed — the WAV
//! would simply stop growing while everything else said "Recording". So the
//! worker loop runs under `catch_unwind`, is rebuilt with the configuration it
//! last had, and re-arms recording into the same file, up to `MAX_RECOVERIES`
//! times in a row.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::mpsc::UnboundedSender;

use crate::audio::{self, frames_since, to_i16, Source};
use crate::live::{LiveTranscriber, SilenceDetector, SpeechDetector};
use crate::types::{AudioDevice, CaptureLevels, CaptureStatus, Speaker};
use crate::wav::{WavCloseResult, WavWriter, SAMPLE_RATE};
use crate::{log_error, log_info, log_warn};

/// How far behind "now" the mixer runs, to absorb packet jitter (250 ms).
const LATENCY: i64 = 4000;
/// PCM is shipped in 4096-frame batches (256 ms), like the old worklet.
const BATCH_FRAMES: usize = 4096;
/// Levels every 200 ms of audio.
const LEVEL_FRAMES: usize = 3200;
const RESTART_AFTER: Duration = Duration::from_millis(1500);
const RESTART_PAUSE: Duration = Duration::from_millis(600);
const DEVICE_POLL: Duration = Duration::from_secs(5);
const MAX_RECOVERIES: u32 = 3;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct CaptureConfig {
    pub active: bool,
    pub capture_mic: bool,
    pub capture_system: bool,
    pub mic_device_id: String,
    pub mic_device_label: String,
}

#[derive(Debug, Clone)]
pub enum CaptureEvent {
    Status(CaptureStatus),
    Devices(Vec<AudioDevice>),
    Levels(CaptureLevels),
    Transcript(String, Speaker),
    Speech,
    Silence(u32),
    WriteFailed { error: String, seconds: f64 },
    WorkerGone { was_recording: bool, recovering: bool },
}

enum Cmd {
    Configure(CaptureConfig),
    Record(bool, u16, Option<mpsc::Sender<()>>),
    Restart,
    Shutdown,
}

struct Shared {
    writer: Mutex<Option<WavWriter>>,
    status: Mutex<CaptureStatus>,
    levels: Mutex<CaptureLevels>,
    devices: Mutex<Vec<AudioDevice>>,
    detector: Mutex<SpeechDetector>,
    silence: Mutex<SilenceDetector>,
    monitoring: AtomicBool,
    paused: AtomicBool,
    write_failed: AtomicBool,
    config: Mutex<CaptureConfig>,
    recoveries: AtomicU32,
    quitting: AtomicBool,
    events: UnboundedSender<CaptureEvent>,
    live: Arc<LiveTranscriber>,
}

impl Shared {
    fn emit(&self, e: CaptureEvent) {
        let _ = self.events.send(e);
    }

    fn on_pcm(&self, pcm: &[i16]) {
        if self.paused.load(Ordering::Relaxed) {
            return;
        }
        let mut guard = self.writer.lock().unwrap();
        let Some(writer) = guard.as_mut() else { return };
        writer.write(pcm);
        if !writer.error.is_empty() && !self.write_failed.swap(true, Ordering::Relaxed) {
            log_error!("recording could not be written: {}", writer.error);
            self.emit(CaptureEvent::WriteFailed { error: writer.error.clone(), seconds: writer.seconds() });
        }
        drop(guard);
        self.live.push(pcm);
    }

    fn on_levels(&self, levels: CaptureLevels) {
        *self.levels.lock().unwrap() = levels;
        let recording = self.writer.lock().unwrap().is_some();
        if self.monitoring.load(Ordering::Relaxed) && !recording && self.detector.lock().unwrap().push(levels.mic, levels.system) {
            self.emit(CaptureEvent::Speech);
        }
        if recording && !self.paused.load(Ordering::Relaxed) {
            let mut silence = self.silence.lock().unwrap();
            if silence.push(levels.mic, levels.system) {
                let minutes = silence.minutes;
                drop(silence);
                self.emit(CaptureEvent::Silence(minutes));
            }
        }
        self.emit(CaptureEvent::Levels(levels));
    }

    fn update_status(&self, f: impl FnOnce(&mut CaptureStatus)) {
        let status = {
            let mut s = self.status.lock().unwrap();
            f(&mut s);
            s.clone()
        };
        if status.running {
            self.recoveries.store(0, Ordering::Relaxed);
        }
        if let Some(fatal) = &status.fatal {
            log_error!("capture fatal: {fatal}");
        } else if !status.mic_error.is_empty() || !status.system_error.is_empty() {
            log_warn!(
                "capture sources — mic: {}; system: {}",
                if status.mic_error.is_empty() { "ok" } else { &status.mic_error },
                if status.system_error.is_empty() { "ok" } else { &status.system_error }
            );
        }
        self.emit(CaptureEvent::Status(status));
    }
}

/// Everything the worker thread owns. Streams cannot leave the thread that
/// opened them, which is why this is a thread and not a set of callbacks.
struct Worker {
    shared: Arc<Shared>,
    config: CaptureConfig,
    epoch: Instant,
    mic: Option<Source>,
    system: Option<Source>,
    running: bool,
    recording: bool,
    channels: u16,
    emitted: i64,
    batch: Vec<i16>,
    lv: (f64, f64, f64, usize),
    restart_at: Option<Instant>,
    last_poll: Instant,
    output_name: Option<String>,
}

impl Worker {
    fn new(shared: Arc<Shared>) -> Worker {
        Worker {
            shared,
            config: CaptureConfig::default(),
            epoch: Instant::now(),
            mic: None,
            system: None,
            running: false,
            recording: false,
            channels: 1,
            emitted: 0,
            batch: Vec::new(),
            lv: (0.0, 0.0, 0.0, 0),
            restart_at: None,
            last_poll: Instant::now(),
            output_name: None,
        }
    }

    fn stop_graph(&mut self) {
        self.mic = None;
        self.system = None;
        self.running = false;
        self.restart_at = None;
    }

    fn start_graph(&mut self) {
        self.stop_graph();
        self.epoch = Instant::now();
        let (mut mic_ok, mut mic_err, mut mic_label) = (false, String::new(), String::new());
        if self.config.capture_mic {
            match audio::open_mic(&self.config.mic_device_id, &self.config.mic_device_label, self.epoch) {
                Ok((source, note)) => {
                    mic_ok = true;
                    mic_label = source.label.clone();
                    mic_err = note.unwrap_or_default();
                    self.mic = Some(source);
                }
                Err(e) => mic_err = e,
            }
        }
        let (mut sys_ok, mut sys_err) = (false, String::new());
        if self.config.capture_system {
            match audio::open_loopback(self.epoch) {
                Ok(source) => {
                    sys_ok = true;
                    self.system = Some(source);
                }
                Err(e) => sys_err = e,
            }
            self.output_name = audio::default_output_name();
        }
        self.running = mic_ok || sys_ok;
        self.emitted = frames_since(self.epoch) - LATENCY;
        self.lv = (0.0, 0.0, 0.0, 0);
        let running = self.running;
        let fatal = (!running).then(|| "No audio source available. Check the microphone and the output device.".to_string());
        self.shared.update_status(|s| {
            s.mic_ok = mic_ok;
            s.system_ok = sys_ok;
            s.mic_error = mic_err;
            s.system_error = sys_err;
            s.mic_label = mic_label;
            s.running = running;
            s.fatal = fatal;
        });
        self.report_devices();
    }

    fn report_devices(&mut self) {
        let devices = audio::list_inputs();
        let changed = *self.shared.devices.lock().unwrap() != devices;
        if changed {
            *self.shared.devices.lock().unwrap() = devices.clone();
            self.shared.emit(CaptureEvent::Devices(devices));
        }
    }

    fn configure(&mut self, config: CaptureConfig) {
        // The replay at startup and the first Configure carry the same thing.
        if config == self.config && config.active && self.running {
            return;
        }
        self.config = config;
        if self.config.active {
            self.start_graph();
        } else {
            self.stop_graph();
            self.shared.update_status(|s| {
                s.running = false;
                s.fatal = None;
            });
        }
    }

    fn set_recording(&mut self, on: bool, channels: u16) {
        if on {
            self.channels = if channels == 2 { 2 } else { 1 };
            self.batch.clear();
            self.recording = true;
        } else if self.recording {
            // The last quarter second is still inside the jitter cushion:
            // mix it now rather than lose the end of the meeting.
            self.mix_until(frames_since(self.epoch));
            self.flush();
            self.recording = false;
        }
    }

    fn flush(&mut self) {
        if !self.batch.is_empty() {
            let batch = std::mem::take(&mut self.batch);
            self.shared.on_pcm(&batch);
        }
    }

    fn mix_until(&mut self, target: i64) {
        if !self.running {
            return;
        }
        let n = (target - self.emitted).clamp(0, SAMPLE_RATE as i64 * 5) as usize;
        if n == 0 {
            return;
        }
        if target - self.emitted > n as i64 {
            self.emitted = target - n as i64;
        }
        let mut left = vec![0.0f32; n];
        let mut right = vec![0.0f32; n];
        if let Some(m) = &self.mic {
            m.queue.take_range(self.emitted, &mut left);
        }
        if let Some(s) = &self.system {
            s.queue.take_range(self.emitted, &mut right);
        }
        for i in 0..n {
            let (l, r) = (left[i], right[i]);
            let mixed = (l + r) / 2.0;
            self.lv.0 += (l * l) as f64;
            self.lv.1 += (r * r) as f64;
            self.lv.2 += (mixed * mixed) as f64;
            self.lv.3 += 1;
            if self.recording {
                if self.channels == 2 {
                    self.batch.push(to_i16(l));
                    self.batch.push(to_i16(r));
                } else {
                    self.batch.push(to_i16(l + r));
                }
            }
            if self.lv.3 >= LEVEL_FRAMES {
                let c = self.lv.3 as f64;
                let levels = CaptureLevels {
                    mic: (self.lv.0 / c).sqrt() as f32,
                    system: (self.lv.1 / c).sqrt() as f32,
                    mixed: (self.lv.2 / c).sqrt() as f32,
                };
                self.lv = (0.0, 0.0, 0.0, 0);
                self.shared.on_levels(levels);
            }
        }
        self.emitted += n as i64;
        if self.batch.len() >= BATCH_FRAMES * self.channels as usize {
            self.flush();
        }
    }

    fn tick(&mut self) {
        if let Some(at) = self.restart_at {
            if Instant::now() >= at {
                log_info!("restarting the audio sources");
                self.start_graph();
            }
            return;
        }
        if !self.running {
            return;
        }
        let failed = self.mic.as_ref().is_some_and(Source::failed) || self.system.as_ref().is_some_and(Source::failed);
        if failed {
            log_warn!("a capture source ended; restarting");
            self.mic = None;
            self.system = None;
            self.restart_at = Some(Instant::now() + RESTART_AFTER);
            self.shared.update_status(|s| {
                s.mic_ok = false;
                s.system_ok = false;
            });
            return;
        }
        self.mix_until(frames_since(self.epoch) - LATENCY);
        if self.last_poll.elapsed() >= DEVICE_POLL {
            self.last_poll = Instant::now();
            self.report_devices();
            // Loopback follows the device it opened; when the default output
            // changes (headphones plugged in), follow it.
            if self.config.capture_system && audio::default_output_name() != self.output_name {
                log_info!("the default output device changed; following it");
                self.restart_at = Some(Instant::now());
            }
        }
    }
}

fn worker_loop(shared: Arc<Shared>, rx: &mpsc::Receiver<Cmd>) {
    let mut w = Worker::new(shared.clone());
    let config = shared.config.lock().unwrap().clone();
    w.configure(config);
    let channels = shared.writer.lock().unwrap().as_ref().map(|wr| wr.channels);
    if let Some(ch) = channels {
        w.set_recording(true, ch);
        log_info!("capture worker rebuilt; recording continues into the same file");
    }
    loop {
        match rx.recv_timeout(Duration::from_millis(20)) {
            Ok(Cmd::Configure(c)) => w.configure(c),
            Ok(Cmd::Record(on, ch, ack)) => {
                w.set_recording(on, ch);
                if let Some(a) = ack {
                    let _ = a.send(());
                }
            }
            Ok(Cmd::Restart) => {
                w.stop_graph();
                std::thread::sleep(RESTART_PAUSE);
                let c = w.config.clone();
                w.configure(c);
            }
            Ok(Cmd::Shutdown) | Err(RecvTimeoutError::Disconnected) => return,
            Err(RecvTimeoutError::Timeout) => {}
        }
        w.tick();
    }
}

pub struct CaptureController {
    shared: Arc<Shared>,
    cmd: Mutex<Option<mpsc::Sender<Cmd>>>,
    pub live: Arc<LiveTranscriber>,
}

impl CaptureController {
    pub fn new(events: UnboundedSender<CaptureEvent>, live: Arc<LiveTranscriber>) -> CaptureController {
        let tx = events.clone();
        live.on_text(Arc::new(move |text, speaker| {
            let _ = tx.send(CaptureEvent::Transcript(text, speaker));
        }));
        CaptureController {
            shared: Arc::new(Shared {
                writer: Mutex::new(None),
                status: Mutex::new(CaptureStatus::default()),
                levels: Mutex::new(CaptureLevels::default()),
                devices: Mutex::new(vec![]),
                detector: Mutex::new(SpeechDetector::default()),
                silence: Mutex::new(SilenceDetector::default()),
                monitoring: AtomicBool::new(false),
                paused: AtomicBool::new(false),
                write_failed: AtomicBool::new(false),
                config: Mutex::new(CaptureConfig::default()),
                recoveries: AtomicU32::new(0),
                quitting: AtomicBool::new(false),
                events,
                live: live.clone(),
            }),
            cmd: Mutex::new(None),
            live,
        }
    }

    /// Starts the worker thread; a panic inside it rebuilds it.
    pub fn init(&self) {
        let (tx, rx) = mpsc::channel::<Cmd>();
        *self.cmd.lock().unwrap() = Some(tx);
        let shared = self.shared.clone();
        std::thread::Builder::new()
            .name("capture".into())
            .spawn(move || loop {
                let outcome = catch_unwind(AssertUnwindSafe(|| worker_loop(shared.clone(), &rx)));
                if outcome.is_ok() || shared.quitting.load(Ordering::Relaxed) {
                    return;
                }
                let was_recording = shared.writer.lock().unwrap().is_some();
                let n = shared.recoveries.fetch_add(1, Ordering::Relaxed) + 1;
                let recovering = n <= MAX_RECOVERIES;
                log_error!("capture worker crashed{} (attempt {n})", if was_recording { " mid-recording" } else { "" });
                shared.update_status(|s| {
                    s.mic_ok = false;
                    s.system_ok = false;
                    s.running = false;
                });
                shared.emit(CaptureEvent::WorkerGone { was_recording, recovering });
                if !recovering {
                    log_error!("capture worker failed {n} times in a row; not rebuilding it again");
                    return;
                }
                std::thread::sleep(RESTART_AFTER);
            })
            .expect("capture thread");
    }

    fn send(&self, c: Cmd) {
        if let Some(tx) = self.cmd.lock().unwrap().as_ref() {
            let _ = tx.send(c);
        }
    }

    /// Rebuilds the sources and re-arms recording into the same file — after
    /// sleep, and from Settings → Restart audio capture.
    pub fn restart(&self) {
        self.send(Cmd::Restart);
    }

    pub fn set_active(&self, active: bool, mut config: CaptureConfig) {
        self.shared.monitoring.store(active, Ordering::Relaxed);
        if !active {
            self.shared.detector.lock().unwrap().reset();
        }
        config.active = active;
        *self.shared.config.lock().unwrap() = config.clone();
        self.send(Cmd::Configure(config));
    }

    pub fn configure_live(&self, enabled: bool, engine: &str, model: &str) {
        self.live.configure(enabled, engine, model);
        let channels = self.shared.writer.lock().unwrap().as_ref().map(|w| w.channels);
        if let (Some(ch), true) = (channels, self.live.enabled()) {
            self.live.start(ch);
        }
    }

    pub fn status(&self) -> CaptureStatus {
        self.shared.status.lock().unwrap().clone()
    }

    pub fn levels(&self) -> CaptureLevels {
        *self.shared.levels.lock().unwrap()
    }

    pub fn devices(&self) -> Vec<AudioDevice> {
        self.shared.devices.lock().unwrap().clone()
    }

    pub fn is_recording(&self) -> bool {
        self.shared.writer.lock().unwrap().is_some()
    }

    pub fn paused(&self) -> bool {
        self.shared.paused.load(Ordering::Relaxed)
    }

    pub fn set_silence_minutes(&self, minutes: u32) {
        self.shared.silence.lock().unwrap().configure(minutes);
    }

    /// Pause keeps the file open and the sources running — reopening devices
    /// on resume is where a meeting loses its first seconds.
    pub fn set_paused(&self, paused: bool) {
        if !self.is_recording() || self.paused() == paused {
            return;
        }
        self.shared.paused.store(paused, Ordering::Relaxed);
        if !paused {
            self.shared.silence.lock().unwrap().reset();
        }
        log_info!("{}", if paused { "recording paused" } else { "recording resumed" });
    }

    /// The clock is the WAV's length, so it stands still while paused.
    pub fn elapsed_seconds(&self) -> f64 {
        self.shared.writer.lock().unwrap().as_ref().map(WavWriter::seconds).unwrap_or(0.0)
    }

    /// Two channels only when both sources opened and separation is on — a
    /// stereo file with a dead channel is twice the disk for nothing.
    pub fn recording_channels(&self, separate: bool) -> u16 {
        let s = self.status();
        if separate && s.mic_ok && s.system_ok { 2 } else { 1 }
    }

    pub fn start_recording(&self, path: &Path, separate: bool, silence_minutes: u32) -> Result<(), String> {
        if self.is_recording() {
            return Ok(());
        }
        let channels = self.recording_channels(separate);
        let writer = WavWriter::create(path, SAMPLE_RATE, channels).map_err(|e| e.to_string())?;
        self.shared.write_failed.store(false, Ordering::Relaxed);
        self.shared.paused.store(false, Ordering::Relaxed);
        *self.shared.writer.lock().unwrap() = Some(writer);
        self.shared.detector.lock().unwrap().reset();
        {
            let mut silence = self.shared.silence.lock().unwrap();
            silence.configure(silence_minutes);
            silence.reset();
        }
        self.live.start(channels);
        self.send(Cmd::Record(true, channels, None));
        log_info!("recording -> {} ({})", path.display(), if channels == 2 { "mic left, system right" } else { "mono" });
        Ok(())
    }

    /// Stops the worker writing, waits for its last batch, and seals the file.
    pub async fn stop_recording(&self) -> Option<WavCloseResult> {
        let channels = self.shared.writer.lock().unwrap().as_ref().map(|w| w.channels)?;
        let (ack_tx, ack_rx) = mpsc::channel();
        self.send(Cmd::Record(false, channels, Some(ack_tx)));
        self.live.stop();
        self.shared.silence.lock().unwrap().reset();
        let _ = tokio::task::spawn_blocking(move || ack_rx.recv_timeout(Duration::from_secs(2))).await;
        self.shared.paused.store(false, Ordering::Relaxed);
        let mut writer = self.shared.writer.lock().unwrap().take()?;
        let result = writer.close();
        self.shared.detector.lock().unwrap().snooze(Duration::from_secs(120));
        log_info!("stopped: {:.1}s, {} bytes", result.seconds, result.bytes);
        Some(result)
    }

    /// Closes everything on the way out; the WAV is sealed first.
    pub fn destroy(&self) {
        self.shared.quitting.store(true, Ordering::Relaxed);
        self.live.stop();
        if let Some(mut w) = self.shared.writer.lock().unwrap().take() {
            w.close();
        }
        self.send(Cmd::Shutdown);
    }
}
