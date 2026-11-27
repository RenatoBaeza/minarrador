//! HTML → PDF with WebView2's own printer, in a hidden window.
//!
//! The page is loaded from disk with a CSP that blocks every network request
//! (added by the pipeline), has no IPC access — it is not app content — and is
//! never allowed to navigate anywhere else.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use tauri::webview::PageLoadEvent;
use tauri::{WebviewUrl, WebviewWindowBuilder};
use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2Environment6, ICoreWebView2_7};
use webview2_com::PrintToPdfCompletedHandler;
use windows::core::{Interface, HSTRING};

use crate::core::core;

const LOAD_TIMEOUT: Duration = Duration::from_secs(30);
const PRINT_TIMEOUT: Duration = Duration::from_secs(60);

pub async fn html_to_pdf(html: PathBuf, pdf: PathBuf) -> Result<(), String> {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let label = format!("pdf-{}", SEQ.fetch_add(1, Ordering::Relaxed));
    let url = url::Url::from_file_path(&html).map_err(|_| format!("not a printable path: {}", html.display()))?;
    let allowed = url.clone();
    let (loaded_tx, loaded_rx) = tokio::sync::oneshot::channel::<()>();
    let loaded_tx = std::sync::Mutex::new(Some(loaded_tx));
    let window = WebviewWindowBuilder::new(&core().app, &label, WebviewUrl::External(url))
        .title("Minarrador PDF")
        .inner_size(900.0, 1200.0)
        .visible(false)
        .skip_taskbar(true)
        .focused(false)
        .on_navigation(move |u| *u == allowed)
        .on_page_load(move |_, payload| {
            if payload.event() == PageLoadEvent::Finished {
                if let Some(tx) = loaded_tx.lock().unwrap().take() {
                    let _ = tx.send(());
                }
            }
        })
        .build()
        .map_err(|e| format!("could not open the PDF renderer: {e}"))?;

    let result = async {
        tokio::time::timeout(LOAD_TIMEOUT, loaded_rx).await.map_err(|_| "the brief did not load in time".to_string())?.ok();
        tokio::time::sleep(Duration::from_millis(250)).await;
        if let Some(dir) = pdf.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let (done_tx, done_rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
        let target = pdf.clone();
        window
            .with_webview(move |pw| {
                let started = (|| -> windows::core::Result<()> {
                    unsafe {
                        let core2 = pw.controller().CoreWebView2()?;
                        let core7: ICoreWebView2_7 = core2.cast()?;
                        let env6: ICoreWebView2Environment6 = pw.environment().cast()?;
                        let settings = env6.CreatePrintSettings()?;
                        settings.SetShouldPrintBackgrounds(true)?;
                        settings.SetShouldPrintHeaderAndFooter(false)?;
                        settings.SetPageWidth(8.5)?;
                        settings.SetPageHeight(11.0)?;
                        for set in [
                            settings.SetMarginTop(0.5),
                            settings.SetMarginBottom(0.5),
                            settings.SetMarginLeft(0.5),
                            settings.SetMarginRight(0.5),
                        ] {
                            set?;
                        }
                        let tx = std::sync::Mutex::new(Some(done_tx));
                        let handler = PrintToPdfCompletedHandler::create(Box::new(move |res, ok| {
                            let outcome = match (res, ok) {
                                (Ok(()), true) => Ok(()),
                                (Err(e), _) => Err(format!("PDF export failed: {e}")),
                                (Ok(()), false) => Err("PDF export reported failure".to_string()),
                            };
                            if let Some(tx) = tx.lock().unwrap().take() {
                                let _ = tx.send(outcome);
                            }
                            Ok(())
                        }));
                        core7.PrintToPdf(&HSTRING::from(target.as_os_str()), &settings, &handler)
                    }
                })();
                if let Err(e) = started {
                    crate::log_error!("PrintToPdf could not start: {e}");
                }
            })
            .map_err(|e| e.to_string())?;
        match tokio::time::timeout(PRINT_TIMEOUT, done_rx).await {
            Err(_) => Err("PDF export timed out".to_string()),
            Ok(Err(_)) => Err("PDF export could not start".to_string()),
            Ok(Ok(r)) => r,
        }
    }
    .await;
    let _ = window.destroy();
    result
}
