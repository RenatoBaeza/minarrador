//! Downloads whisper.cpp — the one outbound path in the app.
//!
//! It runs only from Settings → Install whisper.cpp, and fetches two things: a
//! release binary from GitHub and a set of GGML weights from Hugging Face. No
//! meeting data is ever in a request.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use tokio_util::sync::CancellationToken;

use crate::ollama::until_cancelled;
use crate::whisper::SERVER_EXE;

pub const RELEASE: &str = "v1.9.2";
const CPU_ASSET: &str = "whisper-bin-x64.zip";
const MODEL_BASE_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

pub const MODELS: [(&str, &str); 10] = [
    ("tiny", "75 MB · fastest, visibly more errors"),
    ("tiny.en", "75 MB · English only"),
    ("base", "142 MB · the default; comfortably realtime on CPU"),
    ("base.en", "142 MB · English only"),
    ("small", "466 MB · noticeably more accurate, ~3x realtime"),
    ("small.en", "466 MB · English only"),
    ("medium", "1.5 GB · accurate, needs a strong CPU or GPU build"),
    ("large-v3-turbo", "1.6 GB · large-v3 accuracy, GPU build recommended"),
    ("large-v3-turbo-q5_0", "547 MB · the accurate pick — near large-v3, runs on CPU"),
    ("large-v3", "2.9 GB · most accurate; GPU build, not realtime on CPU"),
];

pub fn is_model(key: &str) -> bool {
    MODELS.iter().any(|(k, _)| *k == key)
}

#[derive(Debug, Clone, Default)]
pub struct InstallProgress {
    pub status: String,
    pub completed: u64,
    pub total: u64,
}

async fn download(url: &str, dest: &Path, label: &str, cancel: &CancellationToken, progress: &mut (dyn FnMut(InstallProgress) + Send)) -> Result<(), String> {
    let client = reqwest::Client::builder().build().map_err(|e| e.to_string())?;
    let res = match until_cancelled(Some(cancel), client.get(url).send()).await {
        None => return Err("Cancelled".into()),
        Some(r) => r.map_err(|e| format!("{label}: {e}"))?,
    };
    if !res.status().is_success() {
        return Err(format!("{label}: {url} returned {}", res.status().as_u16()));
    }
    let total = res.content_length().unwrap_or(0);
    if let Some(dir) = dest.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut tmp = dest.as_os_str().to_owned();
    tmp.push(".part");
    let tmp = PathBuf::from(tmp);
    let mut file = fs::File::create(&tmp).map_err(|e| e.to_string())?;
    let mut stream = res.bytes_stream();
    let mut seen = 0u64;
    let mut last = Instant::now();
    let outcome: Result<(), String> = async {
        loop {
            let next = until_cancelled(Some(cancel), stream.next()).await.ok_or("Cancelled")?;
            let Some(chunk) = next else { break };
            let chunk = chunk.map_err(|e| format!("{label}: the download broke off ({e})"))?;
            file.write_all(&chunk).map_err(|e| e.to_string())?;
            seen += chunk.len() as u64;
            if last.elapsed() >= Duration::from_millis(250) {
                last = Instant::now();
                progress(InstallProgress { status: label.into(), completed: seen, total });
            }
        }
        Ok(())
    }
    .await;
    drop(file);
    if let Err(e) = outcome {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    fs::rename(&tmp, dest).map_err(|e| e.to_string())?;
    progress(InstallProgress { status: label.into(), completed: seen, total: if total > 0 { total } else { seen } });
    Ok(())
}

/// Copies the server, the CLI and their DLLs out of an unpacked release into
/// `bin_dir`, wherever in the archive they were.
fn install_binaries(archive: &Path, bin_dir: &Path) -> Result<usize, String> {
    let file = fs::File::open(archive).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("the release archive is unreadable: {e}"))?;
    let names: Vec<String> = (0..zip.len()).filter_map(|i| zip.by_index(i).ok().map(|f| f.name().replace('\\', "/"))).collect();
    let server = names.iter().find(|n| n.rsplit('/').next() == Some(SERVER_EXE)).ok_or("the release archive contained no whisper-server binary")?;
    let folder = server.rsplit_once('/').map(|(d, _)| format!("{d}/")).unwrap_or_default();
    let _ = fs::remove_dir_all(bin_dir);
    fs::create_dir_all(bin_dir).map_err(|e| e.to_string())?;
    let mut copied = 0;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().replace('\\', "/");
        let Some(base) = name.strip_prefix(&folder).filter(|b| !b.contains('/') && !b.is_empty()) else { continue };
        let lower = base.to_lowercase();
        let keep = matches!(lower.as_str(), "whisper-server.exe" | "whisper-cli.exe") || lower.ends_with(".dll");
        if !keep || lower.starts_with("sdl2.") {
            continue;
        }
        let mut out = fs::File::create(bin_dir.join(base)).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
        copied += 1;
    }
    Ok(copied)
}

/// Installs the CPU build and one model under `root` (`bin/`, `models/`),
/// skipping whichever half is already there.
pub async fn install(root: &Path, model: &str, cancel: &CancellationToken, mut progress: impl FnMut(InstallProgress) + Send) -> Result<String, String> {
    if !is_model(model) {
        return Err(format!("unknown model \"{model}\""));
    }
    let bin_dir = root.join("bin");
    let model_name = format!("ggml-{model}.bin");
    let model_file = root.join("models").join(&model_name);
    if !bin_dir.join(SERVER_EXE).exists() {
        let work = std::env::temp_dir().join(format!("minarrador-whisper-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&work).map_err(|e| e.to_string())?;
        let zip = work.join(CPU_ASSET);
        let url = format!("https://github.com/ggml-org/whisper.cpp/releases/download/{RELEASE}/{CPU_ASSET}");
        let result = async {
            download(&url, &zip, "binaries", cancel, &mut progress).await?;
            progress(InstallProgress { status: "unpacking".into(), ..Default::default() });
            let (z, b) = (zip.clone(), bin_dir.clone());
            tokio::task::spawn_blocking(move || install_binaries(&z, &b)).await.map_err(|e| e.to_string())?
        }
        .await;
        let _ = fs::remove_dir_all(&work);
        result?;
    }
    if !model_file.exists() {
        download(&format!("{MODEL_BASE_URL}/{model_name}"), &model_file, &model_name, cancel, &mut progress).await?;
    }
    let record = serde_json::json!({
        "release": RELEASE, "variant": "cpu", "model": model_name,
        "installedAt": chrono::Utc::now().to_rfc3339(),
    });
    let _ = fs::write(root.join("INSTALL.json"), format!("{}\n", serde_json::to_string_pretty(&record).unwrap_or_default()));
    Ok(model_name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_binaries_out_of_an_archive() {
        let dir = tempfile::tempdir().unwrap();
        let zip_path = dir.path().join("r.zip");
        {
            let mut w = zip::ZipWriter::new(fs::File::create(&zip_path).unwrap());
            let opts = zip::write::SimpleFileOptions::default();
            for name in ["Release/whisper-server.exe", "Release/ggml.dll", "Release/SDL2.dll", "Release/readme.txt", "other/x.dll"] {
                w.start_file(name, opts).unwrap();
                w.write_all(b"x").unwrap();
            }
            w.finish().unwrap();
        }
        let bin = dir.path().join("bin");
        assert_eq!(install_binaries(&zip_path, &bin).unwrap(), 2);
        assert!(bin.join(SERVER_EXE).exists() && bin.join("ggml.dll").exists());
        assert!(!bin.join("SDL2.dll").exists() && !bin.join("x.dll").exists());
        assert!(is_model("base") && !is_model("huge"));
    }
}
