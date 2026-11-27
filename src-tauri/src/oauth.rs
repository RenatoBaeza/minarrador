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
use tokio::net::{TcpListener, TcpStream};
use tokio_util::sync::CancellationToken;

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const REVOKE_URL: &str = "https://oauth2.googleapis.com/revoke";
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
const KEYRING_SERVICE: &str = "Minarrador";

const ICON_PNG: &[u8] = include_bytes!("../../assets/icon.png");

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

    let (code, mut browser) = tokio::select! {
        r = wait_for_code(&listener, &state) => r?,
        _ = tokio::time::sleep(SIGN_IN_TIMEOUT) => return Err("Sign-in timed out — nothing came back from the browser.".into()),
        _ = cancel.cancelled() => return Err(String::new()),
    };
    drop(listener);

    let result = token_request(&[
        ("grant_type", "authorization_code"),
        ("code", &code),
        ("client_id", &cfg.client_id),
        ("client_secret", &cfg.client_secret),
        ("redirect_uri", &redirect),
        ("code_verifier", &verifier),
    ])
    .await
    .map_err(|(_, e)| e)
    .and_then(tokens_from)
    .and_then(|tokens| {
        let account = account_from_id_token(&tokens.id_token).ok_or("Google's ID token could not be read.")?;
        Ok((account, tokens))
    });
    // The tab shows what actually happened, not just that Google redirected.
    let page = match &result {
        Ok((account, _)) => Page::Done { email: &account.email },
        Err(reason) => Page::Failed { reason },
    };
    respond(&mut browser, "200 OK", &page.html()).await;
    result
}

async fn respond(sock: &mut TcpStream, status: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\n\
Content-Security-Policy: default-src 'none'; img-src data:; style-src 'unsafe-inline'\r\n\
Cache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = sock.write_all(response.as_bytes()).await;
    let _ = sock.shutdown().await;
}

/// The redirect's code, with the browser's connection still open so the page
/// it gets can say how the sign-in ended.
async fn wait_for_code(listener: &TcpListener, state: &str) -> Result<(String, TcpStream), String> {
    loop {
        let (mut sock, _) = listener.accept().await.map_err(|e| format!("Lost the browser's answer: {e}"))?;
        let mut buf = vec![0u8; 8192];
        let n = match tokio::time::timeout(Duration::from_secs(5), sock.read(&mut buf)).await {
            Ok(Ok(n)) => n,
            _ => 0,
        };
        let request = String::from_utf8_lossy(&buf[..n]).into_owned();
        match parse_callback(&request, state) {
            Callback::Code(code) => return Ok((code, sock)),
            Callback::Denied(e) => {
                let reason = if e == "access_denied" { String::new() } else { format!("Google refused the sign-in ({e}).") };
                let page = if reason.is_empty() { Page::Cancelled } else { Page::Failed { reason: &reason } };
                respond(&mut sock, "200 OK", &page.html()).await;
                return Err(reason);
            }
            Callback::Other => respond(&mut sock, "404 Not Found", "").await,
        }
    }
}

// ------------------------------------------------------- the browser's page

/// What the browser tab says once Google hands it back. Styled like the app
/// window: the same dark surfaces, the indigo accent, Segoe UI, the app icon.
pub enum Page<'a> {
    Done { email: &'a str },
    Cancelled,
    Failed { reason: &'a str },
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

const PAGE_STYLE: &str = r#"
:root{color-scheme:dark;--bg:#16161a;--card:#1e1e24;--line:#2c2c34;--chip:#2a2a32;--text:#eaeaea;--muted:#9ca3af;--faint:#6b7280;--accent:#4c6ef5;--ok:#34d399;--bad:#f87171}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;
  background:radial-gradient(900px 480px at 50% -8%,rgba(76,110,245,.22),transparent 62%),var(--bg);
  color:var(--text);font:15px/1.55 "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif}
.card{width:100%;max-width:440px;background:var(--card);border:1px solid var(--line);border-radius:16px;
  padding:36px 32px 26px;text-align:center;box-shadow:0 24px 70px rgba(0,0,0,.5);animation:rise .35s cubic-bezier(.22,.61,.36,1)}
@keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.card{animation:none}}
.mark{position:relative;width:76px;height:76px;margin:0 auto 22px}
.mark img{width:76px;height:76px;border-radius:20px;display:block;box-shadow:0 8px 24px rgba(76,110,245,.25)}
.badge{position:absolute;right:-7px;bottom:-7px;width:30px;height:30px;border-radius:50%;display:grid;place-items:center;
  font:700 15px/1 "Segoe UI",system-ui,sans-serif;border:3px solid var(--card);color:#0d0d13}
.ok .badge{background:var(--ok)} .bad .badge{background:var(--bad)} .muted .badge{background:var(--muted)}
h1{margin:0 0 8px;font:600 23px/1.3 "Segoe UI Variable Display","Segoe UI",system-ui,sans-serif;letter-spacing:-.01em}
p{margin:0 0 10px;color:var(--muted)}
p.lead{color:var(--text)} .bad p.lead{color:var(--bad)}
strong{color:var(--text);font-weight:600}
.close{margin-top:22px;padding-top:18px;border-top:1px solid var(--line);font-size:13px;color:var(--muted)}
kbd{display:inline-block;margin-left:4px;padding:1px 7px;border-radius:6px;background:var(--chip);border:1px solid var(--line);
  color:var(--text);font:600 12px/1.6 "Segoe UI",system-ui,sans-serif}
.brand{margin-top:16px;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--faint)}
"#;

impl Page<'_> {
    pub fn html(&self) -> String {
        let (tone, badge, title, lead, detail) = match self {
            Page::Done { email } => (
                "ok",
                "&#10003;",
                "You're signed in",
                if email.is_empty() {
                    "Minarrador is linked to your Google account.".to_string()
                } else {
                    format!("Minarrador is linked to <strong>{}</strong>.", escape(email))
                },
                "Your settings, quick copy, to-dos and dictations sync to it. Audio, transcripts and meeting notes stay on your computer.",
            ),
            Page::Cancelled => ("muted", "&#8211;", "Sign-in cancelled", "Nothing was changed.".to_string(), "You can sign in any time from Minarrador."),
            Page::Failed { reason } => ("bad", "!", "Sign-in didn't finish", escape(reason), "Go back to Minarrador and try again."),
        };
        let icon = base64::engine::general_purpose::STANDARD.encode(ICON_PNG);
        format!(
            "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\
<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
<title>Minarrador — {title}</title><link rel=\"icon\" href=\"data:image/png;base64,{icon}\">\
<style>{PAGE_STYLE}</style></head><body><main class=\"card {tone}\">\
<div class=\"mark\"><img src=\"data:image/png;base64,{icon}\" alt=\"\"><span class=\"badge\">{badge}</span></div>\
<h1>{title}</h1><p class=\"lead\">{lead}</p><p>{detail}</p>\
<div class=\"close\">You can close this tab and go back to the app.<kbd>Ctrl + W</kbd></div>\
<div class=\"brand\">Minarrador</div></main></body></html>"
        )
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
    fn pages_escape_what_they_show() {
        let html = Page::Done { email: "a<b>@c.d" }.html();
        assert!(html.contains("a&lt;b&gt;@c.d") && !html.contains("a<b>"));
        assert!(Page::Failed { reason: "nope" }.html().contains("didn't finish"));
        assert!(Page::Cancelled.html().contains("cancelled"));
    }

    /// `MINARRADOR_RENDER_OUT=<dir> cargo test -- --ignored render_sign_in_pages`
    #[test]
    #[ignore]
    fn render_sign_in_pages() {
        let dir = std::path::PathBuf::from(std::env::var("MINARRADOR_RENDER_OUT").expect("MINARRADOR_RENDER_OUT"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("signin-done.html"), Page::Done { email: "someone@example.com" }.html()).unwrap();
        std::fs::write(dir.join("signin-cancelled.html"), Page::Cancelled.html()).unwrap();
        std::fs::write(dir.join("signin-failed.html"), Page::Failed { reason: "Google refused: invalid_client" }.html()).unwrap();
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
