//! whisper.cpp server supervisor and its /inference client.
//!
//! One `whisper-server` child process, started on first use, kept warm, and
//! restarted when its model or thread count changes. Each request is a WAV
//! POSTed as multipart, exactly as the live preview and the pipeline both need.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use regex::Regex;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio_util::sync::CancellationToken;

use crate::ollama::{collapse_repeats, until_cancelled};
use crate::types::WhisperDescription;
use crate::{log_error, log_info, log_warn};

pub const SERVER_EXE: &str = "whisper-server.exe";
const READY_TIMEOUT: Duration = Duration::from_secs(120);
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const FIRST_PORT: u16 = 8178;
const PORT_ATTEMPTS: u16 = 20;

fn cores() -> u32 {
    std::thread::available_parallelism().map(|n| n.get() as u32).unwrap_or(4)
}

/// "Automatic" decode threads: half the logical cores, 2..=8. whisper-server's
/// own default of 4 leaves a large model below realtime on most machines.
pub fn default_threads() -> u32 {
    (cores() / 2).clamp(2, 8)
}

pub fn thread_choices() -> Vec<u32> {
    let c = cores();
    let mut out = vec![0];
    out.extend([2, 4, 6, 8, 12, 16, 24, 32].into_iter().filter(|&n| n <= c));
    out
}

/// A language name or two-letter code as whisper's `language` field wants it.
pub fn language_code(label: &str) -> String {
    let key = label.trim();
    match key {
        "" => "auto".into(),
        "English" => "en".into(),
        "Spanish" => "es".into(),
        "French" => "fr".into(),
        "German" => "de".into(),
        "Portuguese" => "pt".into(),
        "Italian" => "it".into(),
        "Dutch" => "nl".into(),
        k if k.len() == 2 && k.chars().all(|c| c.is_ascii_alphabetic()) => k.to_lowercase(),
        _ => "auto".into(),
    }
}

/// The GGML weights in a models folder, sorted.
pub fn list_models(models_dir: &Path) -> Vec<String> {
    let mut out: Vec<String> = std::fs::read_dir(models_dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| n.ends_with(".bin"))
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out
}

#[derive(Debug, Clone, PartialEq)]
pub struct WhisperInstall {
    pub root: PathBuf,
    pub binary: PathBuf,
    pub models_dir: PathBuf,
    pub model: PathBuf,
}

/// Picks the first root holding a server binary (or merely existing), and the
/// model inside it: the one asked for if present, else the first available.
pub fn resolve_install(roots: &[PathBuf], model: &str) -> WhisperInstall {
    let chosen = roots
        .iter()
        .find(|d| d.join("bin").join(SERVER_EXE).exists())
        .or_else(|| roots.iter().find(|d| d.exists()))
        .or(roots.first())
        .cloned()
        .unwrap_or_default();
    let models_dir = chosen.join("models");
    let wanted = model.trim();
    let wanted_path = Path::new(wanted);
    let resolved = if !wanted.is_empty() && wanted_path.is_absolute() && wanted_path.exists() {
        wanted_path.to_path_buf()
    } else if let Some(name) = wanted_path.file_name().filter(|_| !wanted.is_empty()) {
        let p = models_dir.join(name);
        if p.exists() {
            p
        } else {
            list_models(&models_dir).first().map(|f| models_dir.join(f)).unwrap_or_default()
        }
    } else {
        list_models(&models_dir).first().map(|f| models_dir.join(f)).unwrap_or_default()
    };
    WhisperInstall { binary: chosen.join("bin").join(SERVER_EXE), root: chosen, models_dir, model: resolved }
}

#[derive(Debug)]
pub struct WhisperError(pub String);

impl std::fmt::Display for WhisperError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for WhisperError {}

struct Inner {
    roots: Vec<PathBuf>,
    install: WhisperInstall,
    threads: u32,
    port: u16,
    ready: bool,
    wanted: bool,
    generation: u64,
    kill: Option<tokio::sync::oneshot::Sender<()>>,
    last_error: String,
}

/// Called whenever the server becomes ready or exits on its own.
pub type ChangeHook = Arc<dyn Fn() + Send + Sync>;

pub struct WhisperServer {
    inner: Mutex<Inner>,
    start_lock: tokio::sync::Mutex<()>,
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
    hook: Mutex<Option<ChangeHook>>,
}

impl WhisperServer {
    pub fn new(roots: Vec<PathBuf>, model: &str, threads: u32) -> WhisperServer {
        let install = resolve_install(&roots, model);
        WhisperServer {
            inner: Mutex::new(Inner {
                roots,
                install,
                threads,
                port: 0,
                ready: false,
                wanted: false,
                generation: 0,
                kill: None,
                last_error: String::new(),
            }),
            start_lock: tokio::sync::Mutex::new(()),
            stderr_tail: Arc::new(Mutex::new(VecDeque::new())),
            hook: Mutex::new(None),
        }
    }

    pub fn on_change(&self, hook: ChangeHook) {
        *self.hook.lock().unwrap() = Some(hook);
    }

    fn fire(&self) {
        let hook = self.hook.lock().unwrap().clone();
        if let Some(h) = hook {
            h();
        }
    }

    /// Re-resolves the install; a changed binary, model or thread count
    /// restarts a running server, since none of them can change under it.
    pub fn configure(&self, roots: Option<Vec<PathBuf>>, model: &str, threads: u32) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(r) = roots {
            inner.roots = r;
        }
        let install = resolve_install(&inner.roots, model);
        let changed = install.binary != inner.install.binary || install.model != inner.install.model || threads != inner.threads;
        inner.install = install;
        inner.threads = threads;
        let running = inner.kill.is_some();
        drop(inner);
        if changed && running {
            log_info!("whisper: configuration changed, restarting the server");
            self.stop();
        }
    }

    pub fn install(&self) -> WhisperInstall {
        self.inner.lock().unwrap().install.clone()
    }

    pub fn available(&self) -> bool {
        let i = self.install();
        !i.model.as_os_str().is_empty() && i.binary.exists() && i.model.exists()
    }

    pub fn running(&self) -> bool {
        let inner = self.inner.lock().unwrap();
        inner.kill.is_some() && inner.ready
    }

    pub fn model_name(&self) -> String {
        self.install().model.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
    }

    pub fn models(&self) -> Vec<String> {
        list_models(&self.install().models_dir)
    }

    pub fn effective_threads(&self) -> u32 {
        let t = self.inner.lock().unwrap().threads;
        if t > 0 { t } else { default_threads() }
    }

    pub fn describe(&self) -> WhisperDescription {
        let inner = self.inner.lock().unwrap();
        let install = inner.install.clone();
        let threads = inner.threads;
        let port = inner.port;
        let running = inner.kill.is_some() && inner.ready;
        let last_error = inner.last_error.clone();
        drop(inner);
        WhisperDescription {
            root: install.root.to_string_lossy().into_owned(),
            binary: install.binary.to_string_lossy().into_owned(),
            model: self.model_name(),
            models: list_models(&install.models_dir),
            threads,
            effective_threads: if threads > 0 { threads } else { default_threads() },
            thread_choices: thread_choices(),
            available: self.available(),
            running,
            port: if port > 0 { Some(port) } else { None },
            last_error,
        }
    }

    /// Starts the server if it is not already up; concurrent callers wait for
    /// the same start rather than racing a second process into existence.
    pub async fn ensure_ready(self: &Arc<Self>) -> Result<(), WhisperError> {
        if self.running() {
            return Ok(());
        }
        let _guard = self.start_lock.lock().await;
        if self.running() {
            return Ok(());
        }
        self.start().await
    }

    async fn start(self: &Arc<Self>) -> Result<(), WhisperError> {
        let install = self.install();
        if !self.available() {
            return Err(WhisperError(format!(
                "whisper.cpp is not installed — use Settings → Install whisper.cpp (looked in {})",
                install.root.display()
            )));
        }
        let port = free_port().ok_or_else(|| {
            WhisperError(format!("no free port in {FIRST_PORT}-{} for whisper-server", FIRST_PORT + PORT_ATTEMPTS - 1))
        })?;
        let threads = self.effective_threads();
        log_info!(
            "whisper: starting {} on {} (port {port}, {threads} threads)",
            SERVER_EXE,
            install.model.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
        );
        let mut cmd = tokio::process::Command::new(&install.binary);
        cmd.arg("--model")
            .arg(&install.model)
            .args(["--host", "127.0.0.1", "--port", &port.to_string(), "--no-timestamps", "--suppress-nst", "--language", "auto"])
            .args(["--threads", &threads.to_string()])
            .current_dir(install.binary.parent().unwrap_or(Path::new(".")))
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        crate::win::hide_tokio(&mut cmd);
        let started = Instant::now();
        self.stderr_tail.lock().unwrap().clear();
        let mut child = cmd.spawn().map_err(|e| {
            let msg = format!("could not spawn whisper-server: {e}");
            self.inner.lock().unwrap().last_error = msg.clone();
            log_error!("whisper: {msg}");
            WhisperError(msg)
        })?;
        crate::win::tie_child_to_us(&child);
        if let Some(stderr) = child.stderr.take() {
            let tail = self.stderr_tail.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let line = line.trim().to_string();
                    if line.is_empty() {
                        continue;
                    }
                    let mut t = tail.lock().unwrap();
                    t.push_back(line);
                    if t.len() > 20 {
                        t.pop_front();
                    }
                }
            });
        }
        let (kill_tx, kill_rx) = tokio::sync::oneshot::channel::<()>();
        let (exit_tx, mut exit_rx) = tokio::sync::watch::channel(false);
        let generation = {
            let mut inner = self.inner.lock().unwrap();
            inner.generation += 1;
            inner.port = port;
            inner.ready = false;
            inner.wanted = true;
            inner.kill = Some(kill_tx);
            inner.generation
        };
        let me = Arc::downgrade(self);
        let tail = self.stderr_tail.clone();
        tokio::spawn(async move {
            let status = tokio::select! {
                s = child.wait() => s.ok(),
                _ = kill_rx => { let _ = child.kill().await; None }
            };
            let _ = exit_tx.send(true);
            let Some(server) = me.upgrade() else { return };
            let mut inner = server.inner.lock().unwrap();
            if inner.generation != generation {
                return;
            }
            inner.kill = None;
            inner.ready = false;
            inner.port = 0;
            if inner.wanted {
                inner.last_error = format!(
                    "whisper-server exited ({})",
                    status.map(|s| s.to_string()).unwrap_or_else(|| "killed".into())
                );
                let last: Vec<String> = tail.lock().unwrap().iter().rev().take(3).rev().cloned().collect();
                log_warn!("whisper: {}: {}", inner.last_error, last.join(" | "));
                drop(inner);
                server.fire();
            }
        });

        let deadline = Instant::now() + READY_TIMEOUT;
        let client = reqwest::Client::builder().no_proxy().build().map_err(|e| WhisperError(e.to_string()))?;
        loop {
            if *exit_rx.borrow_and_update() {
                let last: Vec<String> = self.stderr_tail.lock().unwrap().iter().rev().take(3).rev().cloned().collect();
                let msg = format!(
                    "whisper-server exited during startup: {}",
                    if last.is_empty() { "no output".into() } else { last.join(" | ") }
                );
                self.inner.lock().unwrap().last_error = msg.clone();
                self.stop();
                return Err(WhisperError(msg));
            }
            if Instant::now() >= deadline {
                let msg = format!("whisper-server did not start within {}s", READY_TIMEOUT.as_secs());
                self.inner.lock().unwrap().last_error = msg.clone();
                self.stop();
                return Err(WhisperError(msg));
            }
            if let Ok(res) = client.get(format!("http://127.0.0.1:{port}/")).timeout(Duration::from_secs(2)).send().await {
                let _ = res.bytes().await;
                break;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        {
            let mut inner = self.inner.lock().unwrap();
            if inner.generation == generation {
                inner.ready = true;
                inner.last_error.clear();
            }
        }
        log_info!("whisper: ready in {:.1}s", started.elapsed().as_secs_f64());
        self.fire();
        Ok(())
    }

    pub async fn transcribe(self: &Arc<Self>, wav: Vec<u8>, language: Option<&str>, prompt: Option<&str>, timeout: Duration, cancel: Option<&CancellationToken>) -> Result<String, WhisperError> {
        if cancel.is_some_and(|c| c.is_cancelled()) {
            return Err(WhisperError("Cancelled".into()));
        }
        match until_cancelled(cancel, self.ensure_ready()).await {
            None => return Err(WhisperError("Cancelled".into())),
            Some(r) => r?,
        }
        let port = self.inner.lock().unwrap().port;
        let part = reqwest::multipart::Part::bytes(wav).file_name("live.wav").mime_str("audio/wav").map_err(|e| WhisperError(e.to_string()))?;
        let mut form = reqwest::multipart::Form::new()
            .part("file", part)
            .text("response_format", "json")
            .text("temperature", "0.0")
            .text("temperature_inc", "0.2")
            .text("no_timestamps", "true")
            .text("suppress_nst", "true")
            .text("language", language_code(language.unwrap_or("")));
        if let Some(p) = prompt.filter(|p| !p.is_empty()) {
            let flat = p.replace(['\r', '\n'], " ");
            let tail: String = flat.chars().rev().take(400).collect::<Vec<_>>().into_iter().rev().collect();
            form = form.text("prompt", tail);
        }
        let client = reqwest::Client::builder().no_proxy().build().map_err(|e| WhisperError(e.to_string()))?;
        let request = client.post(format!("http://127.0.0.1:{port}/inference")).multipart(form).timeout(timeout).send();
        let res = match until_cancelled(cancel, request).await {
            None => return Err(WhisperError("Cancelled".into())),
            Some(Err(e)) if e.is_timeout() => {
                return Err(WhisperError(format!("whisper-server did not answer within {}s", timeout.as_secs())))
            }
            Some(Err(e)) => return Err(WhisperError(format!("whisper-server request failed: {e}"))),
            Some(Ok(r)) => r,
        };
        let status = res.status();
        let body = res.text().await.map_err(|e| WhisperError(format!("whisper-server request failed: {e}")))?;
        if !status.is_success() {
            return Err(WhisperError(format!("whisper-server returned {}: {}", status.as_u16(), body.chars().take(300).collect::<String>())));
        }
        let json: serde_json::Value = serde_json::from_str(&body)
            .map_err(|_| WhisperError(format!("whisper-server returned unparseable JSON: {}", body.chars().take(200).collect::<String>())))?;
        if let Some(e) = json.get("error") {
            return Err(WhisperError(e.as_str().map(String::from).unwrap_or_else(|| e.to_string())));
        }
        Ok(clean_whisper_text(json["text"].as_str().unwrap_or("")))
    }

    pub fn stop(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.wanted = false;
        inner.ready = false;
        inner.port = 0;
        if let Some(kill) = inner.kill.take() {
            let _ = kill.send(());
        }
    }
}

fn free_port() -> Option<u16> {
    (FIRST_PORT..FIRST_PORT + PORT_ATTEMPTS).find(|&port| std::net::TcpListener::bind(("127.0.0.1", port)).is_ok())
}

/// Phrases whisper invents on near-silence, compared after lower-casing and
/// stripping trailing punctuation.
pub const HALLUCINATIONS: [&str; 15] = [
    "you",
    "thank you",
    "thank you very much",
    "thanks for watching",
    "thanks for watching my video",
    "please subscribe",
    "please subscribe to my channel",
    "subscribe",
    "bye",
    "bye bye",
    "goodbye",
    "the end",
    "subtitles by the amara.org community",
    "amara.org",
    "transcription by castingwords",
];

/// Strips whisper's bracketed annotations and the phrases it makes up during
/// a pause — the usual source of phantom captions.
pub fn clean_whisper_text(raw: &str) -> String {
    static BRACKETS: OnceLock<Regex> = OnceLock::new();
    static PARENS: OnceLock<Regex> = OnceLock::new();
    static PUNCT_ONLY: OnceLock<Regex> = OnceLock::new();
    static TRAILING: OnceLock<Regex> = OnceLock::new();
    let brackets = BRACKETS.get_or_init(|| Regex::new(r"\[[^\]\n]{0,60}\]").unwrap());
    let parens = PARENS.get_or_init(|| {
        Regex::new(r"(?i)\((?:music|applause|laughter|laughs?|laughing|silence|inaudible|noise|sighs?|coughs?|clears throat|speaking [^)\n]{0,20})[^)\n]{0,20}\)").unwrap()
    });
    let text = brackets.replace_all(raw, " ");
    let text = parens.replace_all(&text, " ");
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() || PUNCT_ONLY.get_or_init(|| Regex::new(r"^[.,!?¿¡'\x22\-–—…]+$").unwrap()).is_match(&text) {
        return String::new();
    }
    let key = TRAILING.get_or_init(|| Regex::new(r"[.!?…,]+$").unwrap()).replace(&text.to_lowercase(), "").trim().to_string();
    if HALLUCINATIONS.contains(&key.as_str()) {
        return String::new();
    }
    collapse_repeats(&text, 4)
}

/// whisper requests scale with clip length; never wait less than a minute.
pub fn timeout_for(seconds: f64) -> Duration {
    Duration::from_millis(((seconds * 15_000.0).round() as u64).max(60_000))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleans_annotations_and_hallucinations() {
        assert_eq!(clean_whisper_text("[BLANK_AUDIO]"), "");
        assert_eq!(clean_whisper_text(" Thank you. "), "");
        assert_eq!(clean_whisper_text("(music) Hello [laughs] there"), "Hello there");
        assert_eq!(clean_whisper_text("..."), "");
        assert_eq!(clean_whisper_text("We ship on Friday."), "We ship on Friday.");
    }

    #[test]
    fn language_codes() {
        assert_eq!(language_code(""), "auto");
        assert_eq!(language_code("Spanish"), "es");
        assert_eq!(language_code("FR"), "fr");
        assert_eq!(language_code("Klingon"), "auto");
    }

    #[test]
    fn resolves_installs() {
        let root = tempfile::tempdir().unwrap();
        let a = root.path().join("a");
        let b = root.path().join("b");
        std::fs::create_dir_all(b.join("bin")).unwrap();
        std::fs::create_dir_all(b.join("models")).unwrap();
        std::fs::write(b.join("bin").join(SERVER_EXE), b"").unwrap();
        std::fs::write(b.join("models").join("ggml-base.bin"), b"").unwrap();
        std::fs::write(b.join("models").join("ggml-tiny.bin"), b"").unwrap();
        let install = resolve_install(&[a.clone(), b.clone()], "ggml-tiny.bin");
        assert_eq!(install.root, b);
        assert!(install.model.ends_with("ggml-tiny.bin"));
        let fallback = resolve_install(&[a, b], "missing.bin");
        assert!(fallback.model.ends_with("ggml-base.bin"));
    }

    #[test]
    fn threads_are_sane() {
        assert!((2..=8).contains(&default_threads()));
        assert_eq!(thread_choices()[0], 0);
        assert_eq!(timeout_for(1.0), Duration::from_secs(60));
        assert_eq!(timeout_for(10.0), Duration::from_secs(150));
    }
}
