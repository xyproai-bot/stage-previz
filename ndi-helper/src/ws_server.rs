// WebSocket server — 把 NDI broadcast frames 推給瀏覽器
//
// 協議（極簡）：
//   - 連線後 server 立刻送 text JSON: {"type":"hello","version":"0.1.0"}
//   - 之後每幀：binary frame（JPEG bytes）
//   - 客戶端 status 查詢：可以送 text "status" → 回 {"type":"status",...}
//   - Heartbeat：tungstenite 自動 ping/pong

use crate::HelperState;
use futures_util::{SinkExt, StreamExt};
use log::{info, warn};
use std::sync::Arc;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, RwLock};
use tokio_tungstenite::tungstenite::Message;

pub async fn run(
    port: u16,
    tx: broadcast::Sender<Arc<Vec<u8>>>,
    state: Arc<RwLock<HelperState>>,
) -> std::io::Result<()> {
    let addr = format!("127.0.0.1:{port}");
    let listener = TcpListener::bind(&addr).await?;
    info!("WebSocket server on ws://{addr}");

    loop {
        let (stream, peer) = listener.accept().await?;
        let tx = tx.clone();
        let state = state.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_client(stream, peer, tx, state).await {
                warn!("client {peer}: {e}");
            }
        });
    }
}

async fn handle_client(
    stream: TcpStream,
    peer: std::net::SocketAddr,
    tx: broadcast::Sender<Arc<Vec<u8>>>,
    state: Arc<RwLock<HelperState>>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let ws = tokio_tungstenite::accept_async(stream).await?;
    info!("WS client connected: {peer}");
    {
        let mut s = state.write().await;
        s.clients = s.clients.saturating_add(1);
    }

    let (mut sink, mut src) = ws.split();
    sink.send(Message::Text(
        serde_json::json!({
            "type": "hello",
            "version": env!("CARGO_PKG_VERSION"),
            "source": *state.read().await.source_name.as_ref().unwrap_or(&String::new()),
        })
        .to_string()
        .into(),
    ))
    .await?;

    let mut rx = tx.subscribe();
    let result: Result<(), Box<dyn std::error::Error + Send + Sync>> = loop {
        tokio::select! {
            // 廣播的 NDI frame → 推給此 client
            r = rx.recv() => {
                match r {
                    Ok(bytes) => {
                        // 失敗（client 滿了 / 斷線）就退出
                        if let Err(e) = sink.send(Message::Binary((*bytes).clone().into())).await {
                            break Err(e.into());
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_n)) => {
                        // 太慢 → 跳過，下一幀再試
                        continue;
                    }
                    Err(broadcast::error::RecvError::Closed) => break Ok(()),
                }
            }
            // Client 傳 text（status query / pong / 控制指令）
            Some(msg) = src.next() => {
                match msg {
                    Ok(Message::Text(t)) => {
                        let t = t.as_str();
                        if t == "status" {
                            let s = state.read().await;
                            let json = serde_json::json!({
                                "type": "status",
                                "source": s.source_name,
                                "fps": s.fps,
                                "frameCount": s.frame_count,
                                "clients": s.clients,
                                "lastError": s.last_error,
                                "availableSources": s.available_sources,
                            }).to_string();
                            if sink.send(Message::Text(json.into())).await.is_err() { break Ok(()); }
                        } else if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(t) {
                            // 控制指令：{"type":"select_source","name":"PCNAME (NDI Output)"}
                            if parsed.get("type").and_then(|v| v.as_str()) == Some("select_source") {
                                if let Some(name) = parsed.get("name").and_then(|v| v.as_str()) {
                                    let mut s = state.write().await;
                                    s.requested_source = Some(name.to_string());
                                    let ack = serde_json::json!({
                                        "type": "select_ack",
                                        "name": name,
                                    }).to_string();
                                    if sink.send(Message::Text(ack.into())).await.is_err() { break Ok(()); }
                                }
                            }
                        }
                    }
                    Ok(Message::Close(_)) | Err(_) => break Ok(()),
                    _ => {}
                }
            }
            else => break Ok(()),
        }
    };

    info!("WS client disconnected: {peer}");
    {
        let mut s = state.write().await;
        s.clients = s.clients.saturating_sub(1);
    }
    result
}
