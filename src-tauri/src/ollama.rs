//! Thin client for a local Ollama daemon.
//!
//! Audio goes through the OpenAI-compatible endpoint: Ollama's native
//! /api/chat and /api/generate routes silently drop audio fields, while
//! /v1/chat/completions accepts `input_audio` parts.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use base64::Engine as _;
use futures_util::StreamExt;
use regex::Regex;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

pub const DEFAULT_HOST: &str = "http://127.0.0.1:11434";

#[derive(Debug, Clone)]
pub struct OllamaError {
    pub message: String,
    /// Whether another attempt could plausibly succeed.
    pub retryable: bool,
}

impl std::fmt::Display for OllamaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for OllamaError {}

fn err(message: impl Into<String>, retryable: bool) -> OllamaError {
    OllamaError { message: message.into(), retryable }
}

fn cancelled() -> OllamaError {
    err("Cancelled", false)
}

/// Runs `f` until it finishes or `cancel` fires, whichever is first.
pub async fn until_cancelled<F: Future>(cancel: Option<&CancellationToken>, f: F) -> Option<F::Output> {
    match cancel {
        None => Some(f.await),
        Some(token) => {
            if token.is_cancelled() {
                return None;
            }
            tokio::select! {
                out = f => Some(out),
                _ = token.cancelled() => None,
            }
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ChatMessage {
    pub role: &'static str,
    pub content: String,
}

impl ChatMessage {
    pub fn system(content: impl Into<String>) -> Self {
        ChatMessage { role: "system", content: content.into() }
    }
    pub fn user(content: impl Into<String>) -> Self {
        ChatMessage { role: "user", content: content.into() }
    }
}

#[derive(Debug, Clone, Default)]
pub struct PullProgress {
    pub status: String,
    pub completed: u64,
    pub total: u64,
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| reqwest::Client::builder().no_proxy().build().expect("http client"))
}

#[derive(Debug, Clone)]
pub struct Ollama {
    pub host: String,
}

impl Ollama {
    pub fn new(host: &str) -> Ollama {
        let host = if host.trim().is_empty() { DEFAULT_HOST } else { host };
        Ollama { host: host.trim_end_matches('/').to_string() }
    }

    async fn once(&self, route: &str, body: &Value, timeout: Duration, cancel: Option<&CancellationToken>) -> Result<Value, OllamaError> {
        let request = client().post(format!("{}{route}", self.host)).timeout(timeout).json(body).send();
        let response = match until_cancelled(cancel, request).await {
            None => return Err(cancelled()),
            Some(Ok(r)) => r,
            Some(Err(e)) if e.is_timeout() => {
                return Err(err(format!("Ollama did not respond within {}s ({route})", timeout.as_secs()), false))
            }
            Some(Err(e)) => {
                return Err(err(format!("Cannot reach Ollama at {} — is it running? ({e})", self.host), true))
            }
        };
        let status = response.status();
        let text = match until_cancelled(cancel, response.text()).await {
            None => return Err(cancelled()),
            Some(Ok(t)) => t,
            Some(Err(e)) if e.is_timeout() => {
                return Err(err(format!("Ollama did not respond within {}s ({route})", timeout.as_secs()), false))
            }
            Some(Err(e)) => return Err(err(format!("Ollama {route} failed mid-response: {e}"), true)),
        };
        if !status.is_success() {
            let snippet: String = text.chars().take(300).collect();
            return Err(err(format!("Ollama {route} returned {}: {snippet}", status.as_u16()), status.is_server_error()));
        }
        serde_json::from_str(&text).map_err(|e| err(format!("Ollama {route} returned unparseable JSON: {e}"), false))
    }

    /// POST with retries for the failures a model swap or a daemon restart
    /// produce mid-run: three attempts with a growing pause by default.
    async fn post(&self, route: &str, body: &Value, timeout: Duration, cancel: Option<&CancellationToken>, attempts: u32) -> Result<Value, OllamaError> {
        let mut last = err("no attempt was made", false);
        for attempt in 1..=attempts.max(1) {
            match self.once(route, body, timeout, cancel).await {
                Ok(v) => return Ok(v),
                Err(e) => {
                    let again = e.retryable && attempt < attempts && !cancel.is_some_and(|c| c.is_cancelled());
                    last = e;
                    if !again {
                        break;
                    }
                    if until_cancelled(cancel, tokio::time::sleep(Duration::from_secs(2 * attempt as u64))).await.is_none() {
                        return Err(cancelled());
                    }
                }
            }
        }
        Err(last)
    }

    pub async fn is_up(&self) -> bool {
        matches!(
            client().get(format!("{}/api/tags", self.host)).timeout(Duration::from_secs(3)).send().await,
            Ok(r) if r.status().is_success()
        )
    }

    pub async fn list_models(&self) -> Vec<String> {
        let Ok(res) = client().get(format!("{}/api/tags", self.host)).timeout(Duration::from_secs(10)).send().await else {
            return vec![];
        };
        if !res.status().is_success() {
            return vec![];
        }
        let json: Value = res.json().await.unwrap_or(Value::Null);
        json["models"]
            .as_array()
            .map(|models| models.iter().filter_map(|m| m["name"].as_str().map(String::from)).collect())
            .unwrap_or_default()
    }

    pub async fn capabilities(&self, model: &str) -> Vec<String> {
        match self.post("/api/show", &json!({ "model": model }), Duration::from_secs(30), None, 1).await {
            Ok(json) => json["capabilities"]
                .as_array()
                .map(|c| c.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default(),
            Err(_) => vec![],
        }
    }

    /// Loads a model into memory ahead of the first request that needs it.
    pub async fn preload(&self, model: &str) -> bool {
        if model.is_empty() {
            return false;
        }
        matches!(
            client()
                .post(format!("{}/api/generate", self.host))
                .timeout(Duration::from_secs(120))
                .json(&json!({ "model": model, "keep_alive": "30m" }))
                .send()
                .await,
            Ok(r) if r.status().is_success()
        )
    }

    pub async fn audio_models(&self) -> Vec<String> {
        let mut out = vec![];
        for name in self.list_models().await {
            if self.capabilities(&name).await.iter().any(|c| c == "audio") {
                out.push(name);
            }
        }
        out
    }

    pub async fn transcribe(&self, model: &str, wav: &[u8], language: Option<&str>, seconds: Option<f64>, cancel: Option<&CancellationToken>) -> Result<String, OllamaError> {
        let instruction = format!(
            "You are a speech-to-text engine. Transcribe the following audio verbatim{}. Output ONLY the transcript text. \
             Do not translate. Do not summarise. Do not add timestamps, speaker labels, headings, quotation marks or any commentary. \
             If the audio contains no intelligible speech, reply with exactly: [no speech]",
            language.map(|l| format!(" in {l}")).unwrap_or_else(|| " in the language actually spoken".into())
        );
        let seconds = seconds.unwrap_or_else(|| estimate_wav_seconds(wav));
        let max_tokens = (120.0 + seconds * 25.0).round() as u64;
        let body = json!({
            "model": model,
            "temperature": 0,
            "max_tokens": max_tokens,
            "reasoning_effort": "none",
            "messages": [{
                "role": "user",
                "content": [
                    { "type": "text", "text": instruction },
                    { "type": "input_audio", "input_audio": {
                        "data": base64::engine::general_purpose::STANDARD.encode(wav),
                        "format": "wav"
                    } }
                ]
            }]
        });
        let json = self.post("/v1/chat/completions", &body, Duration::from_secs(15 * 60), cancel, 3).await?;
        Ok(clean_transcript(json["choices"][0]["message"]["content"].as_str().unwrap_or("")))
    }

    pub async fn chat(&self, model: &str, messages: &[ChatMessage], temperature: f64, cancel: Option<&CancellationToken>) -> Result<String, OllamaError> {
        let body = json!({ "model": model, "temperature": temperature, "messages": messages });
        let json = self.post("/v1/chat/completions", &body, Duration::from_secs(15 * 60), cancel, 3).await?;
        Ok(json["choices"][0]["message"]["content"].as_str().unwrap_or("").to_string())
    }

    /// Asks the daemon to download a model, streaming its progress lines.
    pub async fn pull(&self, model: &str, mut on_progress: impl FnMut(PullProgress), cancel: &CancellationToken) -> Result<String, OllamaError> {
        if model.is_empty() {
            return Err(err("No model was named to pull.", false));
        }
        let request = client().post(format!("{}/api/pull", self.host)).json(&json!({ "model": model, "stream": true })).send();
        let res = match until_cancelled(Some(cancel), request).await {
            None => return Err(cancelled()),
            Some(Ok(r)) => r,
            Some(Err(e)) => return Err(err(format!("Cannot reach Ollama at {} — is it running? ({e})", self.host), false)),
        };
        if !res.status().is_success() {
            let status = res.status().as_u16();
            let text: String = res.text().await.unwrap_or_default().chars().take(300).collect();
            return Err(err(format!("Ollama /api/pull returned {status}: {text}"), false));
        }
        let mut stream = res.bytes_stream();
        let mut buffered = String::new();
        let mut last = String::new();
        loop {
            let next = match until_cancelled(Some(cancel), stream.next()).await {
                None => return Err(cancelled()),
                Some(n) => n,
            };
            let Some(chunk) = next else { break };
            let chunk = chunk.map_err(|e| err(format!("The download from Ollama broke off: {e}"), false))?;
            buffered.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(at) = buffered.find('\n') {
                let line: String = buffered.drain(..=at).collect();
                let Ok(json) = serde_json::from_str::<Value>(line.trim()) else { continue };
                if let Some(e) = json.get("error") {
                    return Err(err(e.as_str().map(String::from).unwrap_or_else(|| e.to_string()), false));
                }
                if let Some(status) = json["status"].as_str() {
                    last = status.to_string();
                }
                on_progress(PullProgress {
                    status: last.clone(),
                    completed: json["completed"].as_u64().unwrap_or(0),
                    total: json["total"].as_u64().unwrap_or(0),
                });
            }
        }
        Ok(last)
    }
}

/// Where the Windows install of Ollama may live: the tray app first, so the
/// daemon it starts outlives this process, the CLI as a fallback.
pub fn ollama_candidates() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = vec![];
    if let Ok(v) = std::env::var("LOCALAPPDATA") {
        roots.push(Path::new(&v).join("Programs").join("Ollama"));
    }
    for var in ["PROGRAMFILES", "ProgramW6432"] {
        if let Ok(v) = std::env::var(var) {
            roots.push(Path::new(&v).join("Ollama"));
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        roots.extend(std::env::split_paths(&path));
    }
    let mut out: Vec<PathBuf> = roots.iter().map(|d| d.join("ollama app.exe")).collect();
    out.extend(roots.iter().map(|d| d.join("ollama.exe")));
    out
}

pub fn find_ollama() -> Option<PathBuf> {
    ollama_candidates().into_iter().find(|p| p.is_file())
}

/// Starts the installed Ollama, detached, and returns what was started.
pub fn launch_ollama() -> Result<PathBuf, OllamaError> {
    let exe = find_ollama().ok_or_else(|| err("Ollama does not appear to be installed. Get it from https://ollama.com/download", false))?;
    let cli = exe.file_name().map(|n| n.to_string_lossy().to_lowercase() != "ollama app.exe").unwrap_or(true);
    let mut cmd = std::process::Command::new(&exe);
    if cli {
        cmd.arg("serve");
    }
    crate::win::detach(&mut cmd);
    cmd.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    cmd.spawn().map_err(|e| err(format!("Could not start {}: {e}", exe.display()), false))?;
    Ok(exe)
}

fn estimate_wav_seconds(wav: &[u8]) -> f64 {
    if wav.len() < 44 {
        return 60.0;
    }
    let rate = u32::from_le_bytes([wav[24], wav[25], wav[26], wav[27]]) as f64;
    let channels = u16::from_le_bytes([wav[22], wav[23]]) as f64;
    if rate <= 0.0 || channels <= 0.0 {
        return 60.0;
    }
    (wav.len() - 44) as f64 / (rate * channels * 2.0)
}

/// Cuts a phrase repeated more than `max_run` times in a row down to two —
/// the audio model's repetition loop, and whisper's on long silences.
pub fn collapse_repeats(text: &str, max_run: usize) -> String {
    let words: Vec<&str> = text.split_whitespace().collect();
    let lower: Vec<String> = words.iter().map(|w| w.to_lowercase()).collect();
    for len in 1..=6usize {
        let mut i = 0;
        while i + len * max_run <= words.len() {
            let phrase = &lower[i..i + len];
            let mut runs = 1;
            while i + len * (runs + 1) <= words.len() && &lower[i + len * runs..i + len * (runs + 1)] == phrase {
                runs += 1;
            }
            if runs > max_run {
                let mut out: Vec<&str> = words[..i + len * 2].to_vec();
                out.extend_from_slice(&words[i + len * runs..]);
                return out.join(" ").trim().to_string();
            }
            i += 1;
        }
    }
    text.to_string()
}

fn re(pattern: &'static str, cell: &'static OnceLock<Regex>) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).unwrap())
}

/// Strips the wrapping an audio LLM sometimes puts around a transcript, and
/// turns its "there is no speech" answers into an empty string.
pub fn clean_transcript(raw: &str) -> String {
    static FENCE_OPEN: OnceLock<Regex> = OnceLock::new();
    static FENCE_CLOSE: OnceLock<Regex> = OnceLock::new();
    static PREAMBLE: OnceLock<Regex> = OnceLock::new();
    static LABEL: OnceLock<Regex> = OnceLock::new();
    static NO_SPEECH: OnceLock<Regex> = OnceLock::new();
    static SILENCE: OnceLock<Regex> = OnceLock::new();
    static SENTENCE: OnceLock<Regex> = OnceLock::new();
    let mut t = raw.trim().to_string();
    t = re(r"(?i)^```(?:text|txt)?\s*", &FENCE_OPEN).replace(&t, "").to_string();
    t = re(r"(?i)```$", &FENCE_CLOSE).replace(&t, "").trim().to_string();
    t = re(r"(?i)^(?:here (?:is|'s)|this is)\b[^:\n]{0,60}:\s*", &PREAMBLE).replace(&t, "").to_string();
    t = re(r"(?i)^transcript(?:ion)?\s*:\s*", &LABEL).replace(&t, "").trim().to_string();
    if re(r"(?i)^\[?\s*no speech\s*\]?\.?$", &NO_SPEECH).is_match(&t)
        || re(r"(?i)^\[?\s*(silence|inaudible|no audio|blank_audio)\s*\]?\.?$", &SILENCE).is_match(&t)
    {
        return String::new();
    }
    if t.chars().count() < 220
        && re(r"(?i)\b(no intelligible speech|contains no speech|audio is silent|there is no speech)\b", &SENTENCE).is_match(&t)
    {
        return String::new();
    }
    collapse_repeats(&t, 4)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collapses_loops() {
        assert_eq!(collapse_repeats("thank you thank you thank you thank you thank you thank you bye", 4), "thank you thank you bye");
        assert_eq!(collapse_repeats("a b c", 4), "a b c");
        assert_eq!(collapse_repeats("go go go go go then", 4), "go go then");
    }

    #[test]
    fn cleans_wrappers_and_no_speech() {
        assert_eq!(clean_transcript("```text\nhello there\n```"), "hello there");
        assert_eq!(clean_transcript("Here is the transcript: hello"), "hello");
        assert_eq!(clean_transcript("Transcription: hi"), "hi");
        assert_eq!(clean_transcript("[no speech]"), "");
        assert_eq!(clean_transcript("[BLANK_AUDIO]"), "");
        assert_eq!(clean_transcript("The audio contains no speech."), "");
    }

    #[test]
    fn estimates_seconds_from_header() {
        let wav = crate::wav::build_wav(&vec![0i16; 16000], 16000, 1);
        assert!((estimate_wav_seconds(&wav) - 1.0).abs() < 1e-9);
    }
}
