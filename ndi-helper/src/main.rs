// stage-previz-ndi-helper
//
// 這個 binary 跑在動畫師本機，背景接收 AE 的 NDI 輸出，透過 WebSocket
// 把每幀（JPEG）推給瀏覽器中的 Stage Previz 平台。
//
// 架構：
//   AE NDI Output → Processing.NDI.Lib.x64.dll (FFI via libloading)
//        → ndi_recv 收到 BGRA buffer
//        → 2x downsample + limited→full range
//        → turbojpeg encode (q ≈ 70, ~ 200KB / frame@1080p)
//        → broadcast 到所有 ws clients (ws://127.0.0.1:7777)
//
// 瀏覽器端：lib/ndi-client.ts 連 ws → 拿 JPEG bytes → drawImage 到 canvas
// → uploadTexture 給 Three.js LED panel material（取代 procedural mock）
//
// 平台：Windows（NDI SDK 主要用），macOS / Linux 用 NDI for macOS / Linux
// 動態載入：使用者要先裝 NDI Tools (https://www.ndi.tv/tools/)

#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod ndi;
mod ws_server;
mod tray;
mod config;
mod autostart;

use log::{error, info};
use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};

// 全域狀態（給 tray 顯示）
#[derive(Default, Clone)]
pub struct HelperState {
    pub source_name: Option<String>,
    pub frame_count: u64,
    pub fps: f32,
    pub clients: usize,
    pub last_error: Option<String>,
    /// 目前掃描到的所有 NDI sources（顯示給瀏覽器讓用戶挑）
    pub available_sources: Vec<String>,
    /// 瀏覽器透過 WebSocket 指定要連的 source（NDI receiver 讀這個重連）
    pub requested_source: Option<String>,
}

#[tokio::main]
async fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    info!("Stage Previz NDI Helper v{}", env!("CARGO_PKG_VERSION"));

    // 確保只有一個 instance 在跑（同 path 上的 mutex）
    let _instance = single_instance::SingleInstance::new("stage-previz-ndi-helper").unwrap();
    if !_instance.is_single() {
        eprintln!("Another instance is already running.");
        std::process::exit(1);
    }

    let cfg = config::load_or_default();
    info!("Config loaded: {:?}", cfg);

    let state = Arc::new(RwLock::new(HelperState::default()));

    // broadcast channel: NDI receiver → ws clients
    // 用 broadcast 讓多個瀏覽器 tab 都能接到同一份 frame
    let (tx, _rx) = broadcast::channel::<Arc<Vec<u8>>>(8);

    // Spawn WebSocket server
    {
        let tx = tx.clone();
        let state = state.clone();
        let port = cfg.port;
        tokio::spawn(async move {
            if let Err(e) = ws_server::run(port, tx, state).await {
                error!("WS server failed: {e}");
            }
        });
    }

    // Spawn NDI receiver — 用 spawn_blocking 因為 NDI C API 帶 raw pointer
    // 跨 await 不滿足 Send，整個 receiver 改成同步函式跑在 blocking pool。
    {
        let tx = tx.clone();
        let state = state.clone();
        let cfg = cfg.clone();
        tokio::task::spawn_blocking(move || {
            // 重試迴圈（NDI source 不在線時退出但每 5s 重試）
            loop {
                match ndi::run_receiver(&cfg, &tx, &state) {
                    Ok(_) => info!("NDI receiver exited cleanly"),
                    Err(e) => {
                        error!("NDI receiver error: {e}");
                        let mut s = state.blocking_write();
                        s.last_error = Some(e.to_string());
                    }
                }
                std::thread::sleep(std::time::Duration::from_secs(5));
            }
        });
    }

    // Tray icon — blocks the main thread (event loop)
    if let Err(e) = tray::run(state, cfg) {
        error!("Tray failed: {e}");
        // 沒 tray 就退出（背景跑沒 UI 沒意義）
        std::process::exit(1);
    }
}
