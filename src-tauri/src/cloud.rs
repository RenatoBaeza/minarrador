//! Opt-in sync of the light data to the signed-in Google account.
//!
//! What syncs: the portable settings ([`SYNCED_SETTINGS`]), quick copy, the
//! to-do list and the dictation archive — a few kilobytes of text. What never
//! does: audio, transcripts, notes, PDFs, models, and any setting that names a
//! path or a device of this machine.
//!
//! The files on disk stay the source of truth and the app works the same
//! signed out or offline. Each kind is one document on the server with an
//! `updatedAt`; the server keeps whichever write is newest (last write wins).
//! The first sync of a kind after signing in merges instead, so linking a
//! second machine never throws away either side's tasks.
//!
//! Everything that arrives goes through the same gates a window's input does:
//! settings through `gate_library_patch`, lists through their `normalize`.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri_plugin_opener::OpenerExt;
use tokio_util::sync::CancellationToken;

use crate::core::{core, try_core};
use crate::oauth::{self, Account, Config, RefreshError, Tokens};
use crate::settings_gate::{gate_library_patch, Installed};
use crate::types::{Outcome, SyncState};
use crate::ui::{notify_settings, refresh_tray};
use crate::windowing::{emit_library, notify_dictations};
use crate::{log_info, log_warn};

pub const KINDS: [&str; 4] = ["settings", "snippets", "todos", "dictations"];

/// Settings that mean the same on any machine. Device ids, thread counts,
/// installed weights, login-at-start and the wallpaper stay per machine; paths
/// are not even settable from a window, let alone from a server.
pub const SYNCED_SETTINGS: [&str; 16] = [
    "suggestOnAudio",
    "liveTranscript",
    "captureMic",
    "captureSystem",
    "separateChannels",
    "silenceStopMinutes",
    "maxRecordingMinutes",
    "preventSleep",
    "hotkey",
    "dictateHotkey",
    "dictateEngine",
    "dictateAutoPaste",
    "liveEngine",
    "transcribeEngine",
    "transcribeModel",
    "summaryModel",
];

/// A local change waits this long for the next one before going up.
const DEBOUNCE: Duration = Duration::from_secs(3);
/// And the server is asked for other machines' changes this often.
const POLL: Duration = Duration::from_secs(300);
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct KindState {
    /// Merged with the account at least once.
    linked: bool,
    /// Changed here since the last successful push.
    dirty: bool,
    changed_at: i64,
    /// The server's `updatedAt` this machine last matched.
    seen: i64,
}

/// `sync.json`: who is signed in and how far each kind got. No secret here —
/// the refresh token is in Credential Manager.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct SyncFile {
    account: Option<Account>,
    kinds: BTreeMap<String, KindState>,
    last_sync_at: Option<String>,
}

#[derive(Default)]
struct Runtime {
    signing_in: Option<CancellationToken>,
    syncing: bool,
    error: Option<String>,
    tokens: Option<Tokens>,
}

pub struct Cloud {
    file: PathBuf,
    /// The Credential Manager entry, per data folder so a development run
    /// never signs the installed app out.
    slot: String,
    state: Mutex<SyncFile>,
    runtime: Mutex<Runtime>,
    kick: tokio::sync::Notify,
    sync_lock: tokio::sync::Mutex<()>,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

impl Cloud {
    pub fn open(user_data: &std::path::Path) -> Cloud {
        let file = user_data.join("sync.json");
        let slot = format!("google-refresh-token@{}", user_data.display());
        let mut state: SyncFile = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        if state.account.is_some() && oauth::load_refresh_token(&slot).is_none() {
            log_warn!("sync: signed-in account has no stored credential — signed out");
            state = SyncFile::default();
        }
        Cloud { file, slot, state: Mutex::new(state), runtime: Mutex::default(), kick: Default::default(), sync_lock: Default::default() }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, SyncFile> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn runtime(&self) -> std::sync::MutexGuard<'_, Runtime> {
        self.runtime.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn persist(&self) {
        let snapshot = self.state().clone();
        crate::stores::write_atomic(&self.file, &snapshot);
    }

    fn signed_in(&self) -> bool {
        self.state().account.is_some()
    }
}

/// What the settings pane shows.
pub fn state() -> SyncState {
    let c = core();
    let configured = oauth::config().is_some();
    let file = c.cloud.state().clone();
    let rt = c.cloud.runtime();
    SyncState {
        configured,
        signed_in: file.account.is_some(),
        signing_in: rt.signing_in.is_some(),
        syncing: rt.syncing,
        email: file.account.as_ref().map(|a| a.email.clone()).unwrap_or_default(),
        name: file.account.as_ref().map(|a| a.name.clone()).unwrap_or_default(),
        last_sync_at: file.last_sync_at.clone(),
        error: rt.error.clone(),
    }
}

/// Something of `kind` changed on this machine. Cheap, and a no-op signed out.
pub fn changed(kind: &str) {
    let Some(c) = try_core() else { return };
    {
        let mut s = c.cloud.state();
        if s.account.is_none() {
            return;
        }
        let k = s.kinds.entry(kind.to_string()).or_default();
        k.dirty = true;
        k.changed_at = now_ms().max(k.changed_at + 1);
    }
    c.cloud.persist();
    c.cloud.kick.notify_one();
}

/// The background loop: a debounced sync after local changes, a pull every
/// few minutes, one at startup.
pub fn start() {
    tauri::async_runtime::spawn(async {
        let c = core();
        if c.cloud.signed_in() {
            let _ = sync_now().await;
        }
        loop {
            tokio::select! {
                _ = c.cloud.kick.notified() => tokio::time::sleep(DEBOUNCE).await,
                _ = tokio::time::sleep(POLL) => {}
            }
            if c.cloud.signed_in() {
                let _ = sync_now().await;
            }
        }
    });
}

// ------------------------------------------------------------ sign in / out

pub async fn sign_in() -> Outcome {
    let Some(cfg) = oauth::config() else { return Outcome::no("Sync is not set up in this build.") };
    let c = core();
    let cancel = {
        let mut rt = c.cloud.runtime();
        if rt.signing_in.is_some() {
            return Outcome::no("A sign-in is already waiting in the browser.");
        }
        let cancel = CancellationToken::new();
        rt.signing_in = Some(cancel.clone());
        rt.error = None;
        cancel
    };
    notify_settings();
    let open = |url: &str| c.app.opener().open_url(url, None::<&str>).map_err(|e| format!("Could not open the browser: {e}"));
    let result = oauth::sign_in(&cfg, open, &cancel).await;
    c.cloud.runtime().signing_in = None;

    let outcome = match result {
        Ok((account, tokens)) => match tokens.refresh_token.as_deref() {
            None => Outcome::no("Google did not grant offline access. Try signing in again."),
            Some(refresh) => match oauth::save_refresh_token(&c.cloud.slot, refresh) {
                Err(e) => Outcome::no(e),
                Ok(()) => {
                    log_info!("sync: signed in");
                    c.cloud.runtime().tokens = Some(tokens);
                    // A fresh link: every kind merges once with the account.
                    *c.cloud.state() = SyncFile { account: Some(account), ..Default::default() };
                    c.cloud.persist();
                    tauri::async_runtime::spawn(async {
                        let _ = sync_now().await;
                    });
                    Outcome::ok()
                }
            },
        },
        Err(e) if e.is_empty() => Outcome::quiet(),
        Err(e) => {
            log_warn!("sync: sign-in failed: {e}");
            Outcome::no(e)
        }
    };
    if let Some(reason) = outcome.reason.clone().filter(|r| !r.is_empty()) {
        c.cloud.runtime().error = Some(reason);
    }
    notify_settings();
    outcome
}

/// Cancels a sign-in waiting in the browser, or signs out. Local files stay
/// exactly as they are; only the link to the account goes.
pub fn sign_out() {
    let c = core();
    if let Some(cancel) = c.cloud.runtime().signing_in.take() {
        cancel.cancel();
        notify_settings();
        return;
    }
    if let Some(token) = oauth::load_refresh_token(&c.cloud.slot) {
        tauri::async_runtime::spawn(async move { oauth::revoke(&token).await });
    }
    oauth::forget_refresh_token(&c.cloud.slot);
    {
        let mut rt = c.cloud.runtime();
        rt.tokens = None;
        rt.error = None;
    }
    *c.cloud.state() = SyncFile::default();
    c.cloud.persist();
    log_info!("sync: signed out");
    notify_settings();
}

// ------------------------------------------------------------------ syncing

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Doc {
    data: Value,
    updated_at: i64,
}

#[derive(Deserialize)]
struct Docs {
    #[serde(default)]
    docs: HashMap<String, Doc>,
}

#[derive(Deserialize)]
struct PutResult {
    applied: bool,
    doc: Doc,
}

/// One full round: pull everything, push what changed here, apply what
/// changed elsewhere. Serialised, so the button and the loop never overlap.
pub async fn sync_now() -> Outcome {
    let c = core();
    let _guard = c.cloud.sync_lock.lock().await;
    let Some(cfg) = oauth::config() else { return Outcome::no("Sync is not set up in this build.") };
    if !c.cloud.signed_in() {
        return Outcome::no("Not signed in.");
    }
    c.cloud.runtime().syncing = true;
    notify_settings();
    let result = run(&cfg).await;
    {
        let mut rt = c.cloud.runtime();
        rt.syncing = false;
        rt.error = result.as_ref().err().cloned();
    }
    if result.is_ok() && c.cloud.signed_in() {
        c.cloud.state().last_sync_at = Some(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
        c.cloud.persist();
    }
    notify_settings();
    match result {
        Ok(()) => Outcome::ok(),
        Err(e) => {
            log_warn!("sync failed: {e}");
            Outcome::no(e)
        }
    }
}

async fn run(cfg: &Config) -> Result<(), String> {
    let c = core();
    let token = id_token(cfg).await?;
    let remote = api_get(cfg, &token).await?;
    for kind in KINDS {
        let meta = c.cloud.state().kinds.get(kind).cloned().unwrap_or_default();
        let local = local_value(kind);
        let theirs = remote.docs.get(kind);

        if !meta.linked {
            let merged = merge(kind, &local, theirs.map(|d| &d.data));
            if merged != local {
                apply_local(kind, &merged);
            }
            let now = local_value(kind);
            // Settings: the account's win on a new machine, and are not pushed back.
            let push = match theirs {
                None => true,
                Some(d) => kind != "settings" && now != d.data,
            };
            let seen = if push { api_put(cfg, &token, kind, &now, now_ms()).await?.doc.updated_at } else { theirs.map_or(0, |d| d.updated_at) };
            finish(kind, &meta, seen);
        } else if meta.dirty {
            let stored = api_put(cfg, &token, kind, &local, meta.changed_at).await?;
            if !stored.applied {
                // Another machine wrote later; its version wins.
                apply_local(kind, &stored.doc.data);
            }
            finish(kind, &meta, stored.doc.updated_at);
        } else if let Some(doc) = theirs.filter(|d| d.updated_at > meta.seen) {
            apply_local(kind, &doc.data);
            finish(kind, &meta, doc.updated_at);
        }
    }
    Ok(())
}

/// Records how far `kind` got. A change made here while the request was in
/// flight keeps the kind dirty for the next round.
fn finish(kind: &str, before: &KindState, seen: i64) {
    let c = core();
    {
        let mut s = c.cloud.state();
        if s.account.is_none() {
            return;
        }
        let k = s.kinds.entry(kind.to_string()).or_default();
        k.linked = true;
        k.seen = seen;
        if k.changed_at == before.changed_at {
            k.dirty = false;
        }
    }
    c.cloud.persist();
}

async fn id_token(cfg: &Config) -> Result<String, String> {
    let c = core();
    if let Some(t) = c.cloud.runtime().tokens.as_ref().filter(|t| t.fresh()) {
        return Ok(t.id_token.clone());
    }
    let refresh = oauth::load_refresh_token(&c.cloud.slot).ok_or("The sign-in is missing from Credential Manager — sign in again.")?;
    match oauth::refresh(cfg, &refresh).await {
        Ok(tokens) => {
            let id = tokens.id_token.clone();
            c.cloud.runtime().tokens = Some(tokens);
            Ok(id)
        }
        Err(RefreshError::Revoked) => {
            sign_out();
            Err("Google ended the session — sign in again to keep syncing.".into())
        }
        Err(RefreshError::Failed(e)) => Err(e),
    }
}

fn http() -> reqwest::Client {
    reqwest::Client::builder().timeout(HTTP_TIMEOUT).build().unwrap_or_default()
}

async fn answer<T: serde::de::DeserializeOwned>(res: Result<reqwest::Response, reqwest::Error>) -> Result<T, String> {
    let res = res.map_err(|e| format!("Could not reach the sync server: {e}"))?;
    let status = res.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        core().cloud.runtime().tokens = None;
        return Err("The sync server did not accept the sign-in.".into());
    }
    if !status.is_success() {
        return Err(format!("The sync server answered {status}."));
    }
    res.json::<T>().await.map_err(|e| format!("The sync server answered with something unreadable: {e}"))
}

async fn api_get(cfg: &Config, token: &str) -> Result<Docs, String> {
    answer(http().get(format!("{}/api/sync", cfg.server)).bearer_auth(token).send().await).await
}

async fn api_put(cfg: &Config, token: &str, kind: &str, data: &Value, updated_at: i64) -> Result<PutResult, String> {
    let body = serde_json::json!({ "data": data, "updatedAt": updated_at });
    answer(http().put(format!("{}/api/sync", cfg.server)).query(&[("kind", kind)]).bearer_auth(token).json(&body).send().await).await
}

// ------------------------------------------------------- local data, in/out

fn local_value(kind: &str) -> Value {
    let c = core();
    match kind {
        "settings" => Value::Object(synced_subset(&serde_json::to_value(c.settings()).unwrap_or_default())),
        "snippets" => serde_json::to_value(c.snippets.list()).unwrap_or_default(),
        "todos" => serde_json::to_value(c.todos.list()).unwrap_or_default(),
        "dictations" => serde_json::to_value(c.dictations.list()).unwrap_or_default(),
        _ => Value::Null,
    }
}

pub fn synced_subset(settings: &Value) -> Map<String, Value> {
    let mut out = Map::new();
    if let Value::Object(all) = settings {
        for key in SYNCED_SETTINGS {
            if let Some(v) = all.get(key) {
                out.insert(key.to_string(), v.clone());
            }
        }
    }
    out
}

/// Writes what came from the account, through the same gates as a window's
/// input, without marking it as a local change.
fn apply_local(kind: &str, value: &Value) {
    let c = core();
    match kind {
        "settings" => {
            let models = c.state().models.clone();
            let (devices, whisper_models) = (c.capture.devices(), c.whisper.models());
            let gated = gate_library_patch(value, &Installed { whisper_models: &whisper_models, models: &models, devices: &devices });
            let current = serde_json::to_value(c.settings()).unwrap_or_default();
            let patch: Map<String, Value> = synced_subset(&Value::Object(gated)).into_iter().filter(|(k, v)| current.get(k) != Some(v)).collect();
            if !patch.is_empty() {
                log_info!("sync: settings from the account: {}", patch.keys().cloned().collect::<Vec<_>>().join(", "));
                crate::services::apply_patch(patch);
            }
        }
        "snippets" => {
            c.snippets.save(value);
            refresh_tray();
        }
        "todos" => {
            c.todos.save(value);
            crate::desktop_todos::after_save();
        }
        "dictations" => {
            c.dictations.save(value);
            notify_dictations();
        }
        _ => return,
    }
    emit_library("library:synced", kind);
}

// ------------------------------------------------------- the first-link merge

/// What a kind becomes the first time it meets the account.
pub fn merge(kind: &str, local: &Value, remote: Option<&Value>) -> Value {
    let Some(remote) = remote else { return local.clone() };
    let (l, r) = (as_list(local), as_list(remote));
    match kind {
        "settings" => remote.clone(),
        "snippets" => {
            let key = |v: &Value| (field(v, "label"), field(v, "text"));
            let have: HashSet<_> = r.iter().map(key).collect();
            Value::Array(r.iter().cloned().chain(l.iter().filter(|v| !have.contains(&key(v))).cloned()).collect())
        }
        "todos" => {
            let mine: HashMap<String, &Value> = l.iter().map(|v| (field(v, "id"), v)).collect();
            let theirs: HashSet<String> = r.iter().map(|v| field(v, "id")).collect();
            let newer = |a: &Value, b: &Value| if field(b, "updatedAt") > field(a, "updatedAt") { b.clone() } else { a.clone() };
            let merged = r.iter().map(|t| mine.get(&field(t, "id")).map_or(t.clone(), |m| newer(t, m)));
            Value::Array(merged.chain(l.iter().filter(|v| !theirs.contains(&field(v, "id"))).cloned()).collect())
        }
        "dictations" => {
            let mut seen = HashSet::new();
            let mut all: Vec<Value> = r.iter().chain(l.iter()).filter(|v| seen.insert(field(v, "id"))).cloned().collect();
            all.sort_by_key(|v| std::cmp::Reverse(field(v, "createdAt")));
            Value::Array(all)
        }
        _ => local.clone(),
    }
}

fn as_list(v: &Value) -> Vec<Value> {
    v.as_array().cloned().unwrap_or_default()
}

fn field(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn synced_settings_are_window_settable_and_never_paths() {
        for key in SYNCED_SETTINGS {
            assert!(crate::settings_gate::LIBRARY_SETTINGS.contains(&key), "{key}");
            assert!(!crate::settings_gate::PATH_SETTINGS.contains(&key), "{key}");
        }
        for local_only in ["micDeviceId", "micDeviceLabel", "whisperThreads", "whisperModel", "startAtLogin", "desktopTodos"] {
            assert!(!SYNCED_SETTINGS.contains(&local_only), "{local_only}");
        }
    }

    #[test]
    fn subset_keeps_only_synced_keys() {
        let s = synced_subset(&json!({ "notesDir": "C:\\x", "hotkey": "off", "micDeviceId": "m" }));
        assert_eq!(Value::Object(s), json!({ "hotkey": "off" }));
    }

    #[test]
    fn first_link_merges_todos_by_id_and_recency() {
        let local = json!([
            { "id": "a", "title": "mine newer", "updatedAt": "2026-11-02T00:00:00Z" },
            { "id": "c", "title": "only here", "updatedAt": "2026-11-01T00:00:00Z" }
        ]);
        let remote = json!([
            { "id": "a", "title": "theirs older", "updatedAt": "2026-11-01T00:00:00Z" },
            { "id": "b", "title": "only there", "updatedAt": "2026-11-01T00:00:00Z" }
        ]);
        let m = merge("todos", &local, Some(&remote));
        let titles: Vec<String> = m.as_array().unwrap().iter().map(|t| field(t, "title")).collect();
        assert_eq!(titles, ["mine newer", "only there", "only here"]);
    }

    #[test]
    fn first_link_merges_snippets_and_dictations() {
        let s = merge("snippets", &json!([{ "label": "a", "text": "1" }, { "label": "b", "text": "2" }]), Some(&json!([{ "label": "a", "text": "1" }])));
        assert_eq!(s.as_array().unwrap().len(), 2);

        let d = merge(
            "dictations",
            &json!([{ "id": "1", "text": "x", "createdAt": "2026-11-01T00:00:00Z" }]),
            Some(&json!([{ "id": "2", "text": "y", "createdAt": "2026-11-03T00:00:00Z" }, { "id": "1", "text": "x", "createdAt": "2026-11-01T00:00:00Z" }])),
        );
        let ids: Vec<String> = d.as_array().unwrap().iter().map(|v| field(v, "id")).collect();
        assert_eq!(ids, ["2", "1"]);
    }

    #[test]
    fn nothing_remote_keeps_local_and_settings_take_the_account() {
        let local = json!([{ "label": "a", "text": "1" }]);
        assert_eq!(merge("snippets", &local, None), local);
        assert_eq!(merge("settings", &json!({ "hotkey": "off" }), Some(&json!({ "hotkey": "Alt+Shift+R" }))), json!({ "hotkey": "Alt+Shift+R" }));
    }
}
