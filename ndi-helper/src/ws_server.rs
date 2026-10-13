// WebSocket server（只聽 127.0.0.1）— 把 NDI 畫面跟狀態推給瀏覽器
//
// 協議（完整說明見 README「WebSocket 協議」）：
//   server → client
//     text   {"type":"hello", ...}          連上後第一則
//     text   {"type":"status", ...}         hello 之後馬上一則；之後狀態有變就推、另外每秒推一次
//     text   {"type":"select_ack", ...}     回應 select_source
//     text   {"type":"error", ...}          看不懂的指令
//     binary JPEG bytes                      每幀一則（沒 pause 的連線才收）
//   client → server
//     "status" 或 {"type":"status"}         立刻回一則 status
//     {"type":"select_source","name":"…"}   換來源並存進 config；name = null / "" → 回到自動
//     {"type":"pause"} / {"type":"resume"}  這條連線暫停 / 恢復收畫面（全部暫停 → helper 斷開 NDI）
//
// 安全：只聽 127.0.0.1；瀏覽器連線要檢查 Origin（見 origin_allowed），
// 不然任何網站都能偷看 AE 畫面。沒有 Origin 的（Node 測試腳本等非瀏覽器工具）放行。

use crate::state::{Frame, Shared};
use futures_util::{SinkExt, StreamExt};
use log::{info, warn};
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::broadcast;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::Message;

pub const PROTOCOL_VERSION: u32 = 2;

/// 自己的網域（只限 https、預設 port、完全一樣的主機名；子網域不算）
const OWN_HOSTS: [&str; 2] = ["previz.haimiaan.com", "test.previz.haimiaan.com"];

/// 哪些網頁可以連 helper（看 WebSocket 握手的 Origin header）：
///   - https://previz.haimiaan.com、https://test.previz.haimiaan.com（自己的網域）
///   - https://stage-previz.vercel.app（正式站）
///   - https://stage-previz-xxxx.vercel.app（這個專案的 Vercel 預覽網址，單一層子網域）
///   - http://localhost[:port]、http://127.0.0.1[:port]、http://xxx.localhost[:port]（本機開發）
///   - 沒有 Origin（不是瀏覽器，例如 Node 測試腳本）→ 放行
/// 其他一律擋（403）。
pub fn origin_allowed(origin: Option<&str>) -> bool {
    let Some(origin) = origin else { return true };
    let origin = origin.trim().to_ascii_lowercase();
    let Some((scheme, rest)) = origin.split_once("://") else { return false };
    // Origin 只有 scheme://host[:port]，不會有路徑、帳密
    if rest.is_empty() || rest.contains(['/', '@', '?', '#', '\\']) {
        return false;
    }
    let (host, port) = match rest.rsplit_once(':') {
        Some((h, p)) => (h, Some(p)),
        None => (rest, None),
    };
    if let Some(p) = port {
        if p.is_empty() || p.len() > 5 || !p.bytes().all(|b| b.is_ascii_digit()) {
            return false;
        }
    }
    let valid_host = !host.is_empty()
        && host.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.')
        && !host.starts_with('.')
        && !host.ends_with('.')
        && !host.contains("..");
    if !valid_host {
        return false;
    }
    match scheme {
        "https" => {
            if port.is_some() {
                return false;
            }
            if host == "stage-previz.vercel.app" || OWN_HOSTS.contains(&host) {
                return true;
            }
            match host.strip_suffix(".vercel.app") {
                Some(label) => label.starts_with("stage-previz-") && !label.contains('.'),
                None => false,
            }
        }
        "http" => host == "localhost" || host == "127.0.0.1" || host.ends_with(".localhost"),
        _ => false,
    }
}

pub async fn run(shared: Arc<Shared>) {
    let addr = format!("127.0.0.1:{}", shared.port);
    let listener = match TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            warn!("WebSocket server bind {addr} failed: {e}");
            shared.update(|s| {
                s.port_error = Some(format!("port {} 被占用（已經開了另一個小程序？）", shared.port));
                true
            });
            return;
        }
    };
    info!("WebSocket server on ws://{addr}");

    loop {
        match listener.accept().await {
            Ok((stream, peer)) => {
                let shared = shared.clone();
                tokio::spawn(async move {
                    if let Err(e) = handle_client(stream, peer, shared).await {
                        warn!("client {peer}: {e}");
                    }
                });
            }
            Err(e) => {
                warn!("accept failed: {e}");
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }
    }
}

fn platform() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

fn hello_message(shared: &Shared) -> String {
    let source = shared.state().source.clone().unwrap_or_default();
    json!({
        "type": "hello",
        "version": env!("CARGO_PKG_VERSION"),
        "protocol": PROTOCOL_VERSION,
        "platform": platform(),
        "port": shared.port,
        "source": source,
    })
    .to_string()
}

pub fn status_message(shared: &Shared, frames_paused: bool) -> String {
    let (preferred, max_fps) = {
        let c = shared.cfg();
        (c.source_name.clone(), c.max_fps)
    };
    let clients = shared.clients();
    let want_frames = shared.frame_clients() > 0;
    let s = shared.state();
    let error = s.error.as_ref().map(|e| json!({ "code": e.code, "message": e.message }));
    let sources: Vec<Value> = s
        .sources
        .iter()
        .map(|i| json!({ "name": i.name, "local": i.local, "afterEffects": i.after_effects }))
        .collect();
    let names: Vec<&str> = s.sources.iter().map(|i| i.name.as_str()).collect();
    json!({
        "type": "status",
        "version": env!("CARGO_PKG_VERSION"),
        "state": s.summary(want_frames),
        "ndi": s.ndi.as_str(),
        "error": error,
        "lastError": s.error.as_ref().map(|e| e.message.clone()),
        "mode": if preferred.is_some() { "manual" } else { "auto" },
        "preferred": preferred,
        "source": s.source,
        "sources": sources,
        "availableSources": names,
        "connected": s.connected,
        "receiving": s.receiving,
        "fps": round1(s.fps),
        "ndiFps": round1(s.ndi_fps),
        "encodeMs": round1(s.encode_ms),
        "maxFps": max_fps,
        "width": s.width,
        "height": s.height,
        "outWidth": s.out_width,
        "outHeight": s.out_height,
        "frameCount": s.frame_count,
        "clients": clients,
        "framesPaused": frames_paused,
        "autostart": {
            "wanted": s.autostart.wanted,
            "registered": s.autostart.registered,
            "error": s.autostart.error,
        },
    })
    .to_string()
}

fn round1(v: f32) -> f64 {
    ((v as f64) * 10.0).round() / 10.0
}

fn error_message(code: &str, message: &str) -> String {
    json!({ "type": "error", "code": code, "message": message }).to_string()
}

/// 有訂閱就等下一幀；暫停中就永遠等（讓 select! 走別的分支）
async fn next_frame(rx: &mut Option<broadcast::Receiver<Frame>>) -> Result<Frame, broadcast::error::RecvError> {
    match rx {
        Some(r) => r.recv().await,
        None => std::future::pending().await,
    }
}

/// 斷線時一定要把計數減回去
struct ClientGuard(Arc<Shared>);

impl Drop for ClientGuard {
    fn drop(&mut self) {
        self.0.clients.fetch_sub(1, Ordering::Relaxed);
        self.0.notify();
    }
}

async fn handle_client(
    stream: TcpStream,
    peer: std::net::SocketAddr,
    shared: Arc<Shared>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let _ = stream.set_nodelay(true);
    let check_origin = |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
        // Origin 不是合法字串 → 當成不明來源（擋）
        let origin = req.headers().get("origin").map(|v| v.to_str().unwrap_or("invalid"));
        if origin_allowed(origin) {
            Ok(resp)
        } else {
            warn!("WS rejected origin {origin:?} from {peer}");
            let mut err = ErrorResponse::new(Some("origin not allowed".into()));
            *err.status_mut() = StatusCode::FORBIDDEN;
            Err(err)
        }
    };
    let ws = tokio_tungstenite::accept_hdr_async(stream, check_origin).await?;
    info!("WS client connected: {peer}");
    shared.clients.fetch_add(1, Ordering::Relaxed);
    let _guard = ClientGuard(shared.clone());

    let (mut sink, mut src) = ws.split();
    sink.send(Message::Text(hello_message(&shared).into())).await?;

    // 預設要畫面（舊版網頁不會送 resume）
    let mut rx: Option<broadcast::Receiver<Frame>> = Some(shared.frames.subscribe());
    shared.notify(); // 其他連線的 clients 數也更新
    sink.send(Message::Text(status_message(&shared, false).into())).await?;

    let mut status_rx = shared.subscribe_status();
    status_rx.borrow_and_update();
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    tick.tick().await; // 第一下是立即的，吃掉

    let result: Result<(), Box<dyn std::error::Error + Send + Sync>> = loop {
        tokio::select! {
            r = next_frame(&mut rx) => {
                match r {
                    Ok(bytes) => {
                        if let Err(e) = sink.send(Message::Binary(bytes.as_ref().clone())).await {
                            break Err(e.into());
                        }
                    }
                    // 網頁太慢 → 跳過舊的，下一幀再送
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break Ok(()),
                }
            }
            changed = status_rx.changed() => {
                if changed.is_err() { break Ok(()); }
                status_rx.borrow_and_update();
                if sink.send(Message::Text(status_message(&shared, rx.is_none()).into())).await.is_err() {
                    break Ok(());
                }
            }
            _ = tick.tick() => {
                if sink.send(Message::Text(status_message(&shared, rx.is_none()).into())).await.is_err() {
                    break Ok(());
                }
            }
            msg = src.next() => {
                let text = match msg {
                    Some(Ok(Message::Text(t))) => t.as_str().to_owned(),
                    Some(Ok(Message::Close(_))) | None => break Ok(()),
                    Some(Err(e)) => break Err(e.into()),
                    Some(Ok(_)) => continue, // ping/pong/binary：忽略（pong 由 tungstenite 自動回）
                };
                let reply = handle_command(&text, &shared, &mut rx);
                if sink.send(Message::Text(reply.into())).await.is_err() { break Ok(()); }
            }
        }
    };

    drop(rx);
    // 回 close frame（不然瀏覽器會看到 1006 異常斷線）
    let _ = tokio::time::timeout(Duration::from_millis(500), sink.close()).await;
    info!("WS client disconnected: {peer}");
    result
}

/// 每個指令都回一則 text
fn handle_command(text: &str, shared: &Arc<Shared>, rx: &mut Option<broadcast::Receiver<Frame>>) -> String {
    let trimmed = text.trim();
    if trimmed == "status" {
        return status_message(shared, rx.is_none());
    }
    let parsed: Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(_) => return error_message("bad_json", "看不懂的訊息（要 JSON）"),
    };
    match parsed.get("type").and_then(|v| v.as_str()) {
        Some("status") | Some("get_status") => status_message(shared, rx.is_none()),
        Some("select_source") => {
            // name: 字串 = 指定來源；null / "" / 沒給 = 回到自動
            let name = match parsed.get("name") {
                None | Some(Value::Null) => None,
                Some(Value::String(s)) if s.trim().is_empty() => None,
                Some(Value::String(s)) => Some(s.trim().to_string()),
                Some(_) => return error_message("bad_command", "select_source 的 name 要是字串或 null"),
            };
            {
                let mut c = shared.cfg();
                if c.source_name != name {
                    c.source_name = name.clone();
                    if let Err(e) = crate::config::save(&c) {
                        warn!("save config failed: {e}");
                    }
                }
            }
            info!("select_source: {}", name.as_deref().unwrap_or("(auto)"));
            shared.pref_gen.fetch_add(1, Ordering::Relaxed);
            let available = name
                .as_ref()
                .map(|n| shared.state().sources.iter().any(|s| &s.name == n))
                .unwrap_or(true);
            shared.notify();
            json!({
                "type": "select_ack",
                "name": name,
                "mode": if name.is_some() { "manual" } else { "auto" },
                "available": available,
            })
            .to_string()
        }
        Some("pause") => {
            if rx.take().is_some() {
                shared.notify();
            }
            status_message(shared, true)
        }
        Some("resume") => {
            if rx.is_none() {
                *rx = Some(shared.frames.subscribe());
                shared.notify();
            }
            status_message(shared, false)
        }
        Some(other) => error_message("unknown_command", &format!("不認得的指令：{other}")),
        None => error_message("bad_command", "缺少 type"),
    }
}

#[cfg(test)]
mod tests {
    use super::origin_allowed;

    #[test]
    fn allows_production_and_previews() {
        assert!(origin_allowed(Some("https://stage-previz.vercel.app")));
        assert!(origin_allowed(Some("https://stage-previz-git-feat-live-stage-look-xyproai.vercel.app")));
        assert!(origin_allowed(Some("https://stage-previz-abc123-xyproai.vercel.app")));
        assert!(origin_allowed(Some("HTTPS://Stage-Previz.Vercel.App")));
    }

    #[test]
    fn allows_own_domains() {
        assert!(origin_allowed(Some("https://previz.haimiaan.com")));
        assert!(origin_allowed(Some("https://test.previz.haimiaan.com")));
        assert!(origin_allowed(Some("HTTPS://Previz.Haimiaan.com")));
        assert!(origin_allowed(Some(" https://test.previz.haimiaan.com ")));
    }

    #[test]
    fn rejects_lookalikes_of_own_domains() {
        for o in [
            "http://previz.haimiaan.com",
            "http://test.previz.haimiaan.com",
            "https://previz.haimiaan.com:8443",
            "https://previz.haimiaan.com:443",
            "https://previz.haimiaan.com.evil.com",
            "https://evilpreviz.haimiaan.com",
            "https://evil.previz.haimiaan.com",
            "https://a.test.previz.haimiaan.com",
            "https://haimiaan.com",
            "https://www.haimiaan.com",
            "https://test.haimiaan.com",
            "https://previz-haimiaan.com",
            "https://previz.haimiaan.co",
            "https://previz.haimiaan.com/",
            "https://previz.haimiaan.com/share/x",
            "https://user@previz.haimiaan.com",
            "https://previz.haimiaan.com.",
            "wss://previz.haimiaan.com",
        ] {
            assert!(!origin_allowed(Some(o)), "should reject {o:?}");
        }
    }

    #[test]
    fn allows_local_dev_and_non_browser() {
        assert!(origin_allowed(None));
        assert!(origin_allowed(Some("http://localhost:5173")));
        assert!(origin_allowed(Some("http://localhost")));
        assert!(origin_allowed(Some("http://127.0.0.1:8080")));
        assert!(origin_allowed(Some("http://app.localhost:3000")));
    }

    #[test]
    fn rejects_everything_else() {
        for o in [
            "https://evil.com",
            "https://stage-previz.vercel.app.evil.com",
            "https://evil.vercel.app",
            "https://stage-previz.evil.vercel.app",
            "https://a.stage-previz-x.vercel.app",
            "https://stage-previz-.vercel.app.evil.com",
            "https://stage-previz-x.vercel.app:8443",
            "http://stage-previz.vercel.app",
            "https://localhost:5173",
            "http://localhost.evil.com",
            "http://evil.com:80",
            "http://127.0.0.2:80",
            "null",
            "",
            "invalid",
            "file://",
            "https://stage-previz.vercel.app/path",
            "https://user@stage-previz.vercel.app",
            "http://localhost:abc",
            "http://localhost:",
            "chrome-extension://abcdef",
        ] {
            assert!(!origin_allowed(Some(o)), "should reject {o:?}");
        }
    }
}
