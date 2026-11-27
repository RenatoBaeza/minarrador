//! Google sign-in for a desktop app: the installed-app OAuth flow with PKCE.
//!
//! The system browser opens Google's consent page; Google redirects back to a
//! one-shot listener on `127.0.0.1:<random port>` with a code, which is traded
//! for an ID token and a refresh token. The refresh token lives in Windows
//! Credential Manager, never in a file. The ID token is the only thing the sync
//! server is ever shown, and it verifies it against Google itself — this side
//! decodes it only to show who is signed in.
//!
//! The client id, secret and server come from the build (`option_env!`), or
//! from the same variables at run time for development. A Desktop-type Google
//! client's "secret" is not secret by Google's own definition; PKCE is what
//! protects the code.

use std::time::{Duration, Instant};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const REVOKE_URL: &str = "https://oauth2.googleapis.com/revoke";
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
const KEYRING_SERVICE: &str = "Minarrador";

const PAGE_DONE: &str = "<!doctype html><meta charset=utf-8><title>Minarrador</title>\
<body style=\"font:16px system-ui;margin:3em\"><h2>Signed in to Minarrador</h2><p>You can close this tab.</p>";
const PAGE_DENIED: &str = "<!doctype html><meta charset=utf-8><title>Minarrador</title>\
<body style=\"font:16px system-ui;margin:3em\"><h2>Sign-in cancelled</h2><p>You can close this tab.</p>";

/// Where sync goes and which Google client signs in to it.
#[derive(Debug, Clone)]
pub struct Config {
    pub client_id: String,
    pub client_secret: String,
    pub server: String,
}

fn setting(name: &str, built: Option<&'static str>) -> Option<String> {
    std::env::var(name)
        .ok()
        .or(built.map(String::from))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// `None` in a build made without the three variables: sync is then simply
/// not offered.
pub fn config() -> Option<Config> {
    let server = setting("MINARRADOR_SYNC_URL", option_env!("MINARRADOR_SYNC_URL"))?;
    if !server_allowed(&server, cfg!(debug_assertions)) {
        crate::log_warn!("sync disabled: MINARRADOR_SYNC_URL must be an https:// address");
        return None;
    }
    Some(Config {
        client_id: setting("MINARRADOR_GOOGLE_CLIENT_ID", option_env!("MINARRADOR_GOOGLE_CLIENT_ID"))?,
        client_secret: setting("MINARRADOR_GOOGLE_CLIENT_SECRET", option_env!("MINARRADOR_GOOGLE_CLIENT_SECRET"))?,
        server: server.trim_end_matches('/').to_string(),
    })
}

/// HTTPS only, except a local server while developing.
pub fn server_allowed(server: &str, debug: bool) -> bool {
    let Ok(url) = url::Url::parse(server) else { return false };
    match url.scheme() {
        "https" => url.host_str().is_some(),
        "http" => debug && matches!(url.host_str(), Some("127.0.0.1" | "localhost")),
        _ => false,
    }
}

/// Who is signed in, as the ID token says. For display only.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct Account {
    pub sub: String,
    pub email: String,
    pub name: String,
}

pub fn account_from_id_token(id_token: &str) -> Option<Account> {
    let payload = id_token.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    let claims: Value = serde_json::from_slice(&bytes).ok()?;
    let text = |k: &str| claims.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let sub = text("sub");
    if sub.is_empty() {
        return None;
    }
    Some(Account { sub, email: text("email"), name: text("name") })
}

/// A PKCE verifier (64 random hex characters) and its S256 challenge.
pub fn pkce_pair() -> (String, String) {
    let verifier = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

#[derive(Debug, PartialEq)]
pub enum Callback {
    Code(String),
    Denied(String),
    /// A favicon, a stray request, or a redirect carrying someone else's state.
    Other,
}

/// Reads the first line of the browser's request to the loopback listener.
pub fn parse_callback(request: &str, state: &str) -> Callback {
    let Some(target) = request.lines().next().and_then(|l| l.split_whitespace().nth(1)) else { return Callback::Other };
    let Ok(url) = url::Url::parse(&format!("http://127.0.0.1{target}")) else { return Callback::Other };
    if url.path() != "/" {
        return Callback::Other;
    }
    let param = |k: &str| url.query_pairs().find(|(name, _)| name == k).map(|(_, v)| v.into_owned());
    if param("state").as_deref() != Some(state) {
        return Callback::Other;
    }
    if let Some(error) = param("error") {
        return Callback::Denied(error);
    }
    match param("code") {
        Some(code) if !code.is_empty() => Callback::Code(code),
        _ => Callback::Other,
    }
}

/// An ID token and when to stop trusting it.
#[derive(Debug, Clone)]
pub struct Tokens {
    pub id_token: String,
    pub expires_at: Instant,
    pub refresh_token: Option<String>,
}

impl Tokens {
    /// Still good for at least five minutes — long enough for one sync.
    pub fn fresh(&self) -> bool {
        self.expires_at > Instant::now() + Duration::from_secs(300)
    }
}

#[derive(Deserialize)]
struct TokenResponse {
    id_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
    error: Option<String>,
    error_description: Option<String>,
}

pub enum RefreshError {
    /// The grant was revoked or expired: only signing in again helps.
    Revoked,
    Failed(String),
}

fn http() -> reqwest::Client {
    reqwest::Client::builder().timeout(HTTP_TIMEOUT).build().unwrap_or_default()
}

async fn token_request(form: &[(&str, &str)]) -> Result<TokenResponse, (Option<String>, String)> {
    let res = http()
        .post(TOKEN_URL)
        .form(form)
        .send()
        .await
        .map_err(|e| (None, format!("Could not reach Google: {e}")))?;
    let body: TokenResponse = res.json().await.map_err(|e| (None, format!("Google answered with something unreadable: {e}")))?;
    if let Some(error) = body.error.clone() {
        let detail = body.error_description.clone().unwrap_or_else(|| error.clone());
        return Err((Some(error), format!("Google refused: {detail}")));
    }
    Ok(body)
}

fn tokens_from(body: TokenResponse) -> Result<Tokens, String> {
    let id_token = body.id_token.ok_or("Google did not return an ID token.")?;
    Ok(Tokens {
        id_token,
        expires_at: Instant::now() + Duration::from_secs(body.expires_in.unwrap_or(3600)),
        refresh_token: body.refresh_token,
    })
}

/// The whole browser round trip. `open` shows the consent page.
pub async fn sign_in(
    cfg: &Config,
    open: impl FnOnce(&str) -> Result<(), String>,
    cancel: &CancellationToken,
) -> Result<(Account, Tokens), String> {
    let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| format!("Could not listen for Google's answer: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect = format!("http://127.0.0.1:{port}");
    let (verifier, challenge) = pkce_pair();
    let state = uuid::Uuid::new_v4().simple().to_string();

    let mut url = url::Url::parse(AUTH_URL).expect("static URL");
    url.query_pairs_mut()
        .append_pair("client_id", &cfg.client_id)
        .append_pair("redirect_uri", &redirect)
        .append_pair("response_type", "code")
        .append_pair("scope", "openid email profile")
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &state)
        .append_pair("access_type", "offline")
        // Without it Google returns a refresh token only the first time ever.
        .append_pair("prompt", "consent select_account");
    open(url.as_str())?;

    let code = tokio::select! {
        r = wait_for_code(&listener, &state) => r?,
        _ = tokio::time::sleep(SIGN_IN_TIMEOUT) => return Err("Sign-in timed out — nothing came back from the browser.".into()),
        _ = cancel.cancelled() => return Err(String::new()),
    };
    drop(listener);

    let body = token_request(&[
        ("grant_type", "authorization_code"),
        ("code", &code),
        ("client_id", &cfg.client_id),
        ("client_secret", &cfg.client_secret),
        ("redirect_uri", &redirect),
        ("code_verifier", &verifier),
    ])
    .await
    .map_err(|(_, e)| e)?;
    let tokens = tokens_from(body)?;
    let account = account_from_id_token(&tokens.id_token).ok_or("Google's ID token could not be read.")?;
    Ok((account, tokens))
}

async fn wait_for_code(listener: &TcpListener, state: &str) -> Result<String, String> {
    loop {
        let (mut sock, _) = listener.accept().await.map_err(|e| format!("Lost the browser's answer: {e}"))?;
        let mut buf = vec![0u8; 8192];
        let n = match tokio::time::timeout(Duration::from_secs(5), sock.read(&mut buf)).await {
            Ok(Ok(n)) => n,
            _ => 0,
        };
        let request = String::from_utf8_lossy(&buf[..n]);
        let (status, body, result) = match parse_callback(&request, state) {
            Callback::Code(code) => ("200 OK", PAGE_DONE, Some(Ok(code))),
            Callback::Denied(e) => ("200 OK", PAGE_DENIED, Some(Err(if e == "access_denied" { String::new() } else { format!("Google refused the sign-in ({e}).") }))),
            Callback::Other => ("404 Not Found", "", None),
        };
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = sock.write_all(response.as_bytes()).await;
        let _ = sock.shutdown().await;
        if let Some(result) = result {
            return result;
        }
    }
}

/// A new ID token from the stored refresh token.
pub async fn refresh(cfg: &Config, refresh_token: &str) -> Result<Tokens, RefreshError> {
    let body = token_request(&[
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("client_id", &cfg.client_id),
        ("client_secret", &cfg.client_secret),
    ])
    .await
    .map_err(|(code, e)| if code.as_deref() == Some("invalid_grant") { RefreshError::Revoked } else { RefreshError::Failed(e) })?;
    tokens_from(body).map_err(RefreshError::Failed)
}

/// Best effort: tells Google the refresh token is done with.
pub async fn revoke(refresh_token: &str) {
    let _ = http().post(REVOKE_URL).form(&[("token", refresh_token)]).send().await;
}

// ----------------------------------------------------------- the credential

pub fn save_refresh_token(slot: &str, token: &str) -> Result<(), String> {
    keyring::Entry::new(KEYRING_SERVICE, slot)
        .and_then(|e| e.set_password(token))
        .map_err(|e| format!("Could not store the sign-in in Windows Credential Manager: {e}"))
}

pub fn load_refresh_token(slot: &str) -> Option<String> {
    keyring::Entry::new(KEYRING_SERVICE, slot).ok()?.get_password().ok().filter(|t| !t.is_empty())
}

pub fn forget_refresh_token(slot: &str) {
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, slot) {
        let _ = entry.delete_credential();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_callback() {
        let req = "GET /?state=abc&code=4%2F0Ab&scope=email HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n";
        assert_eq!(parse_callback(req, "abc"), Callback::Code("4/0Ab".into()));
        assert_eq!(parse_callback(req, "xyz"), Callback::Other);
        assert_eq!(parse_callback("GET /favicon.ico HTTP/1.1\r\n", "abc"), Callback::Other);
        assert_eq!(parse_callback("GET /?state=abc&error=access_denied HTTP/1.1\r\n", "abc"), Callback::Denied("access_denied".into()));
        assert_eq!(parse_callback("", "abc"), Callback::Other);
    }

    #[test]
    fn decodes_the_id_token() {
        let payload = URL_SAFE_NO_PAD.encode(br#"{"sub":"123","email":"a@b.c","name":"Ann"}"#);
        let token = format!("h.{payload}.s");
        assert_eq!(account_from_id_token(&token), Some(Account { sub: "123".into(), email: "a@b.c".into(), name: "Ann".into() }));
        assert_eq!(account_from_id_token("garbage"), None);
        let no_sub = URL_SAFE_NO_PAD.encode(br#"{"email":"a@b.c"}"#);
        assert_eq!(account_from_id_token(&format!("h.{no_sub}.s")), None);
    }

    #[test]
    fn pkce_is_well_formed() {
        let (verifier, challenge) = pkce_pair();
        assert_eq!(verifier.len(), 64);
        assert_eq!(challenge.len(), 43);
        assert_ne!(pkce_pair().0, verifier);
    }

    #[test]
    fn server_must_be_https() {
        assert!(server_allowed("https://sync.example.com", false));
        assert!(!server_allowed("http://sync.example.com", true));
        assert!(server_allowed("http://localhost:3000", true));
        assert!(!server_allowed("http://localhost:3000", false));
        assert!(!server_allowed("file:///C:/x", true));
        assert!(!server_allowed("nonsense", true));
    }
}
