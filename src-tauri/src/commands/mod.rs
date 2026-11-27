//! The commands the windows may invoke, one module per channel namespace.
//!
//! Every command checks which window sent it: the library's commands answer
//! only the library, the archive's only the archive.

pub mod dictation;
pub mod disk;
pub mod library;
pub mod settings;
pub mod sync;

use tauri::WebviewWindow;

pub(crate) fn from(window: &WebviewWindow, label: &str) -> bool {
    window.label() == label
}

pub(crate) fn from_library(window: &WebviewWindow) -> bool {
    from(window, crate::windowing::LIBRARY)
}
