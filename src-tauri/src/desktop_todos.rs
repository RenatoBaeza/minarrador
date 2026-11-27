//! Draws the open to-do tasks onto the desktop wallpaper: deciding when, the
//! drawing, and putting the original back.
//!
//! It is a picture, not a window: a window kept behind everything still
//! disappears under Show desktop (Win+D) — exactly when someone is looking at
//! the wallpaper. The current wallpaper is copied into `desktop-todos/`, every
//! redraw starts from that copy, and a desktop showing anything other than our
//! own `wallpaper-a/b.png` means the user picked a new picture, which becomes
//! the new original.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::core::core;
use crate::wallpaper::{self, read_wallpaper, set_wallpaper, DesktopPage, Fonts, WallpaperState};
use crate::windowing::notify;
use crate::{log_info, log_warn};

const REDRAW: Duration = Duration::from_millis(1500);
const SETTLE: Duration = Duration::from_millis(3000);
const POLL: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Original {
    #[serde(flatten)]
    state: WallpaperState,
    copy: String,
    size: u64,
    mtime_ms: f64,
}

fn folder() -> PathBuf {
    core().user_data.join("desktop-todos")
}

fn same(a: &Path, b: &Path) -> bool {
    a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
}

fn is_ours(file: &str) -> bool {
    let p = Path::new(file);
    !file.is_empty()
        && p.parent().is_some_and(|d| same(d, &folder()))
        && p.file_name().map(|n| n.to_string_lossy().to_lowercase()).is_some_and(|n| n == "wallpaper-a.png" || n == "wallpaper-b.png")
}

fn read_original() -> Option<Original> {
    serde_json::from_str(&fs::read_to_string(folder().join("original.json")).ok()?).ok()
}

fn write_original(o: &Original) {
    let _ = fs::write(folder().join("original.json"), serde_json::to_string_pretty(o).unwrap_or_default());
}

fn stat(path: &str) -> Option<(u64, f64)> {
    let m = fs::metadata(path).ok().filter(|m| m.is_file())?;
    let mtime = m.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_secs_f64() * 1000.0;
    Some((m.len(), mtime))
}

/// Takes the picture Windows is showing as the new original (copied, since
/// Windows overwrites its own TranscodedWallpaper with ours).
fn adopt(current: &WallpaperState, previous: Option<Original>) -> Original {
    let Some((size, mtime_ms)) = (!current.path.is_empty()).then(|| stat(&current.path)).flatten() else {
        let solid = Original { state: current.clone(), ..Default::default() };
        write_original(&solid);
        return solid;
    };
    let unchanged = previous.as_ref().is_some_and(|p| {
        !p.copy.is_empty() && same(Path::new(&p.state.path), Path::new(&current.path)) && p.size == size && p.mtime_ms == mtime_ms && folder().join(&p.copy).exists()
    });
    let copy = if unchanged {
        previous.map(|p| p.copy).unwrap_or_default()
    } else {
        let ext = Path::new(&current.path).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_else(|| "jpg".into());
        let name = format!("original.{ext}");
        if let Ok(entries) = fs::read_dir(folder()) {
            for e in entries.flatten() {
                let n = e.file_name().to_string_lossy().to_lowercase();
                if n.starts_with("original.") && n != "original.json" {
                    let _ = fs::remove_file(e.path());
                }
            }
        }
        let _ = fs::copy(&current.path, folder().join(&name));
        name
    };
    let o = Original { state: current.clone(), copy, size, mtime_ms };
    write_original(&o);
    o
}

static LAST_KEY: Mutex<String> = Mutex::new(String::new());
static FLIP: AtomicBool = AtomicBool::new(false);

fn draw() -> Result<(), String> {
    let dir = folder();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let current = read_wallpaper()?;
    let mut original = read_original();
    if !is_ours(&current.path) {
        original = Some(adopt(&current, original));
    }
    let original = original.unwrap_or_else(|| Original { state: WallpaperState { path: String::new(), ..current.clone() }, ..Default::default() });
    let monitor = crate::win::primary_monitor().ok_or("could not find the primary display")?;
    let scale = core().app.primary_monitor().ok().flatten().map(|m| m.scale_factor()).unwrap_or(1.0) as f32;
    let (tasks, more) = wallpaper::desktop_tasks(&core().todos.list(), chrono::Local::now().date_naive());
    let key = format!("{tasks:?}|{more}|{}|{}|{}|{}|{}|{}|{monitor:?}|{scale}", original.copy, original.size, original.mtime_ms, original.state.style, original.state.tile, original.state.background);
    if *LAST_KEY.lock().unwrap() == key && is_ours(&current.path) && Path::new(&current.path).exists() {
        return Ok(());
    }
    let picture = (!original.copy.is_empty()).then(|| image::open(dir.join(&original.copy)).ok().map(|i| i.to_rgba8())).flatten();
    let (bx, by, bw, bh) = monitor.bounds;
    let (wx, wy, ww, wh) = monitor.work;
    let page = DesktopPage {
        tasks: &tasks,
        more,
        width: bw.max(1) as u32,
        height: bh.max(1) as u32,
        scale,
        insets: (wy - by, bx + bw - (wx + ww), by + bh - (wy + wh), wx - bx),
        background: wallpaper::background_rgb(&original.state.background),
        picture: picture.as_ref(),
        style: &original.state.style,
        tile: &original.state.tile,
    };
    let img = wallpaper::render(&page, &Fonts::load()?);
    let flip = !FLIP.fetch_xor(true, Ordering::Relaxed);
    let file = dir.join(format!("wallpaper-{}.png", if flip { "a" } else { "b" }));
    img.save(&file).map_err(|e| e.to_string())?;
    set_wallpaper(&file, "10", "0")?;
    *LAST_KEY.lock().unwrap() = key;
    log_info!("desktop to-do: drew {} task(s){} onto the wallpaper", tasks.len(), if more > 0 { format!(" (+{more})") } else { String::new() });
    Ok(())
}

fn restore() -> Result<(), String> {
    let dir = folder();
    if !dir.exists() {
        return Ok(());
    }
    let current = read_wallpaper()?;
    if !is_ours(&current.path) {
        let _ = fs::remove_dir_all(&dir);
        return Ok(());
    }
    let Some(original) = read_original() else {
        log_warn!("desktop to-do: no record of the original wallpaper to restore");
        return Ok(());
    };
    let own = !original.state.path.is_empty()
        && Path::new(&original.state.path).exists()
        && !Path::new(&original.state.path).file_name().map(|n| n.to_string_lossy().to_lowercase().starts_with("transcodedwallpaper")).unwrap_or(false);
    let file = if own { PathBuf::from(&original.state.path) } else if !original.copy.is_empty() { dir.join(&original.copy) } else { PathBuf::new() };
    set_wallpaper(&file, &original.state.style, &original.state.tile)?;
    LAST_KEY.lock().unwrap().clear();
    if !own && !original.copy.is_empty() {
        // Windows is showing the copy itself; deleting it would blank the desktop.
        return Ok(());
    }
    let _ = fs::remove_dir_all(&dir);
    log_info!("desktop to-do: original wallpaper restored");
    Ok(())
}

static RUNNING: AtomicBool = AtomicBool::new(false);
static AGAIN: AtomicBool = AtomicBool::new(false);
static WARNED: AtomicBool = AtomicBool::new(false);
static SCHEDULE: AtomicU64 = AtomicU64::new(0);

async fn run() {
    if RUNNING.swap(true, Ordering::SeqCst) {
        AGAIN.store(true, Ordering::SeqCst);
        return;
    }
    let enabled = core().settings().desktop_todos;
    let result = tauri::async_runtime::spawn_blocking(move || if enabled { draw() } else { restore() }).await.unwrap_or_else(|e| Err(e.to_string()));
    match result {
        Ok(()) => WARNED.store(false, Ordering::Relaxed),
        Err(e) => {
            log_warn!("desktop to-do: could not update the wallpaper: {e}");
            if !WARNED.swap(true, Ordering::Relaxed) {
                notify("Could not update the wallpaper", &e, None);
            }
        }
    }
    RUNNING.store(false, Ordering::SeqCst);
    if AGAIN.swap(false, Ordering::SeqCst) {
        schedule(Duration::ZERO);
    }
}

fn schedule(delay: Duration) {
    let generation = SCHEDULE.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(delay).await;
        if SCHEDULE.load(Ordering::SeqCst) == generation {
            run().await;
        }
    });
}

/// After a to-do save settles.
pub fn after_save() {
    if core().settings().desktop_todos {
        schedule(REDRAW);
    }
}

pub fn on_resume() {
    after_save();
}

static WATCH: AtomicU64 = AtomicU64::new(0);

/// Turns the feature on or off. Off — or starting with it off while the folder
/// still exists — puts the original back and deletes the folder.
pub fn apply(startup: bool) {
    let watch = WATCH.fetch_add(1, Ordering::SeqCst) + 1;
    if !core().settings().desktop_todos {
        if !startup || folder().exists() {
            schedule(Duration::ZERO);
        }
        return;
    }
    schedule(Duration::ZERO);
    // One watcher for the three things that call for a redraw: the user picking
    // a new picture, the display changing, and midnight (for the due labels).
    tauri::async_runtime::spawn(async move {
        let mut last_path = read_wallpaper().map(|w| w.path).unwrap_or_default();
        let mut last_monitor = crate::win::primary_monitor();
        let mut last_day = chrono::Local::now().date_naive();
        loop {
            tokio::time::sleep(POLL).await;
            if WATCH.load(Ordering::SeqCst) != watch {
                return;
            }
            let path = read_wallpaper().map(|w| w.path).unwrap_or_default();
            if path != last_path {
                last_path = path.clone();
                if !is_ours(&path) {
                    schedule(SETTLE);
                }
            }
            let monitor = crate::win::primary_monitor();
            if monitor != last_monitor {
                last_monitor = monitor;
                schedule(REDRAW);
            }
            let today = chrono::Local::now().date_naive();
            if today != last_day {
                last_day = today;
                schedule(Duration::ZERO);
            }
        }
    });
}

pub fn stop() {
    WATCH.fetch_add(1, Ordering::SeqCst);
    SCHEDULE.fetch_add(1, Ordering::SeqCst);
}
