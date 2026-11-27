//! The few Win32 calls the app makes directly.
//!
//! Each is small and fixed: hide or detach a child process, tie a child's life
//! to ours, read free space, hold off sleep, press Ctrl+V, find the primary
//! monitor, set the wallpaper. Nothing here takes text from a window.

#![allow(clippy::missing_safety_doc)]

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::sync::mpsc;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, HWND, POINT, RECT};
use windows_sys::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTOPRIMARY};
use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VK_CONTROL, VK_LMENU,
    VK_LSHIFT, VK_LWIN, VK_MENU, VK_RMENU, VK_RSHIFT, VK_RWIN, VK_SHIFT,
};
use windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetWindowLongPtrW, SetWindowLongPtrW, ShowWindow, SystemParametersInfoW, GWL_EXSTYLE, SPIF_SENDWININICHANGE,
    SPIF_UPDATEINIFILE, SPI_SETDESKWALLPAPER, SW_HIDE, SW_SHOWNOACTIVATE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    WS_EX_TOPMOST,
};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const DETACHED_PROCESS: u32 = 0x0000_0008;
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

pub fn wide(s: impl AsRef<OsStr>) -> Vec<u16> {
    s.as_ref().encode_wide().chain(std::iter::once(0)).collect()
}

/// A child that must outlive this process (Ollama's daemon).
pub fn detach(cmd: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
}

/// A console child that should never flash a window.
pub fn hide(cmd: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

pub fn hide_tokio(cmd: &mut tokio::process::Command) {
    cmd.creation_flags(CREATE_NO_WINDOW);
}

/// A job object that kills everything in it when this process goes away — so
/// a crash never leaves a whisper-server holding a port and a gigabyte of RAM.
fn job() -> Option<HANDLE> {
    static JOB: OnceLock<usize> = OnceLock::new();
    let handle = *JOB.get_or_init(|| unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return 0;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if ok == 0 {
            CloseHandle(job);
            return 0;
        }
        job as usize
    });
    if handle == 0 { None } else { Some(handle as HANDLE) }
}

pub fn tie_child_to_us(child: &tokio::process::Child) {
    if let (Some(job), Some(process)) = (job(), child.raw_handle()) {
        unsafe {
            AssignProcessToJobObject(job, process as HANDLE);
        }
    }
}

/// Bytes free to this user on the volume holding `dir`.
pub fn free_space(dir: &Path) -> Option<u64> {
    let path = wide(dir.as_os_str());
    let mut available = 0u64;
    let ok = unsafe { GetDiskFreeSpaceExW(path.as_ptr(), &mut available, std::ptr::null_mut(), std::ptr::null_mut()) };
    if ok == 0 { None } else { Some(available) }
}

/// Holds off idle system sleep for as long as it lives.
///
/// `SetThreadExecutionState` is per thread, so the request is made from a
/// thread of its own that stays parked until the blocker is dropped.
pub struct SleepBlocker {
    stop: Option<mpsc::Sender<()>>,
}

impl SleepBlocker {
    pub fn start() -> SleepBlocker {
        let (tx, rx) = mpsc::channel::<()>();
        std::thread::Builder::new()
            .name("sleep-blocker".into())
            .spawn(move || unsafe {
                SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED);
                let _ = rx.recv();
                SetThreadExecutionState(ES_CONTINUOUS);
            })
            .ok();
        SleepBlocker { stop: Some(tx) }
    }
}

impl Drop for SleepBlocker {
    fn drop(&mut self) {
        if let Some(tx) = self.stop.take() {
            let _ = tx.send(());
        }
    }
}

fn key(vk: u16, up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT { wVk: vk, wScan: 0, dwFlags: if up { KEYEVENTF_KEYUP } else { 0 }, time: 0, dwExtraInfo: 0 },
        },
    }
}

fn held(vk: u16) -> bool {
    unsafe { (GetAsyncKeyState(vk as i32) as u16 & 0x8000) != 0 }
}

/// Presses Ctrl+V in whatever window has the keyboard — the one place the app
/// touches another application. Waits (briefly) for the hotkey's own modifiers
/// to be let go first, or Win/Shift/Alt would turn the paste into something
/// else. An elevated window silently refuses the input; the clipboard holds
/// the text either way.
pub fn paste_clipboard() -> bool {
    let modifiers = [VK_SHIFT, VK_LSHIFT, VK_RSHIFT, VK_LWIN, VK_RWIN, VK_MENU, VK_LMENU, VK_RMENU];
    let deadline = Instant::now() + Duration::from_millis(1500);
    while modifiers.iter().any(|&vk| held(vk)) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(30));
    }
    let inputs = [key(VK_CONTROL, false), key(b'V' as u16, false), key(b'V' as u16, true), key(VK_CONTROL, true)];
    let sent = unsafe { SendInput(inputs.len() as u32, inputs.as_ptr(), std::mem::size_of::<INPUT>() as i32) };
    sent as usize == inputs.len()
}

/// The primary monitor's full and working rectangles, in physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MonitorRects {
    pub bounds: (i32, i32, i32, i32),
    pub work: (i32, i32, i32, i32),
}

fn rect(r: RECT) -> (i32, i32, i32, i32) {
    (r.left, r.top, r.right - r.left, r.bottom - r.top)
}

pub fn primary_monitor() -> Option<MonitorRects> {
    unsafe {
        let monitor = MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY);
        if monitor.is_null() {
            return None;
        }
        let mut info: MONITORINFO = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(monitor, &mut info) == 0 {
            return None;
        }
        Some(MonitorRects { bounds: rect(info.rcMonitor), work: rect(info.rcWork) })
    }
}

/// Makes a window one that never takes focus or a taskbar button.
pub fn make_unfocusable(hwnd: isize) {
    unsafe {
        let hwnd = hwnd as HWND;
        let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style | (WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST) as isize);
    }
}

/// Shows a window without activating it, so the caret stays where it was.
pub fn show_no_activate(hwnd: isize) {
    unsafe {
        ShowWindow(hwnd as HWND, SW_SHOWNOACTIVATE);
    }
}

pub fn hide_window(hwnd: isize) {
    unsafe {
        ShowWindow(hwnd as HWND, SW_HIDE);
    }
}

/// The same call the Settings app makes, so the choice persists and Explorer
/// redraws. An empty path means a solid colour.
pub fn set_desk_wallpaper(file: &Path) -> Result<(), String> {
    let path = wide(file.as_os_str());
    let ok = unsafe {
        SystemParametersInfoW(SPI_SETDESKWALLPAPER, 0, path.as_ptr() as *mut _, SPIF_UPDATEINIFILE | SPIF_SENDWININICHANGE)
    };
    if ok == 0 {
        Err(format!("SystemParametersInfo failed: {}", std::io::Error::last_os_error()))
    } else {
        Ok(())
    }
}

pub fn set_app_user_model_id(id: &str) {
    let id = wide(id);
    unsafe {
        SetCurrentProcessExplicitAppUserModelID(id.as_ptr());
    }
}

/// A message box for the one moment nothing else can speak: startup failing.
pub fn message_box(title: &str, body: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
    let (t, b) = (wide(title), wide(body));
    unsafe {
        MessageBoxW(std::ptr::null_mut(), b.as_ptr(), t.as_ptr(), MB_OK | MB_ICONERROR);
    }
}
