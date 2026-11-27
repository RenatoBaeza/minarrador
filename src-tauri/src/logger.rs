//! File logger. One file in the app's data folder, rotated once at 2 MB, so the
//! log the settings pane offers is always there and never grows without bound.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const MAX_BYTES: u64 = 2 * 1024 * 1024;

struct LogState {
    path: Option<PathBuf>,
    bytes: u64,
}

static STATE: Mutex<LogState> = Mutex::new(LogState { path: None, bytes: 0 });

fn rotate(state: &mut LogState) {
    if let Some(path) = &state.path {
        let mut old = path.clone().into_os_string();
        old.push(".1");
        let _ = fs::rename(path, PathBuf::from(old));
    }
    state.bytes = 0;
}

/// Points the logger at `dir/minarrador.log`, rotating it first if it is too big.
pub fn init(dir: &Path) {
    let mut state = STATE.lock().unwrap_or_else(|e| e.into_inner());
    let path = dir.join("minarrador.log");
    let _ = fs::create_dir_all(dir);
    state.bytes = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    state.path = Some(path);
    if state.bytes > MAX_BYTES {
        rotate(&mut state);
    }
}

pub fn path() -> Option<PathBuf> {
    STATE.lock().unwrap_or_else(|e| e.into_inner()).path.clone()
}

pub fn write(level: &str, message: &str) {
    let line = format!(
        "{} [{}] {}",
        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        level,
        message
    );
    println!("{line}");
    let mut state = STATE.lock().unwrap_or_else(|e| e.into_inner());
    let Some(path) = state.path.clone() else { return };
    if state.bytes > MAX_BYTES {
        rotate(&mut state);
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
        if writeln!(file, "{line}").is_ok() {
            state.bytes += line.len() as u64 + 1;
        }
    }
}

#[macro_export]
macro_rules! log_info {
    ($($arg:tt)*) => { $crate::logger::write("info", &format!($($arg)*)) };
}

#[macro_export]
macro_rules! log_warn {
    ($($arg:tt)*) => { $crate::logger::write("warn", &format!($($arg)*)) };
}

#[macro_export]
macro_rules! log_error {
    ($($arg:tt)*) => { $crate::logger::write("error", &format!($($arg)*)) };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_and_rotates() {
        let dir = tempfile::tempdir().unwrap();
        init(dir.path());
        write("info", "hello");
        let body = fs::read_to_string(dir.path().join("minarrador.log")).unwrap();
        assert!(body.contains("[info] hello"));
        {
            let mut state = STATE.lock().unwrap();
            state.bytes = MAX_BYTES + 1;
        }
        write("warn", "after");
        assert!(dir.path().join("minarrador.log.1").exists());
        let body = fs::read_to_string(dir.path().join("minarrador.log")).unwrap();
        assert!(body.contains("after") && !body.contains("hello"));
    }
}
