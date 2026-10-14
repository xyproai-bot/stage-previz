// stage-previz-ndi-helper
//
// 跑在動畫師電腦背景（系統列小圖示），接收 AE 的 NDI 輸出，
// 透過本機 WebSocket（ws://127.0.0.1:7777）把畫面（JPEG）跟狀態推給瀏覽器裡的 Stage Previz。
//
// 架構：
//   AE NDI Output → NDI 函式庫（runtime 動態載入）
//        → ndi.rs：挑來源（本機 AE 優先）、限速 30fps、太大才縮小（整數分之一）、turbojpeg 編碼（兩個工人輪流）
//        → state.rs：broadcast 給每個網頁連線
//        → ws_server.rs：hello / status / JPEG frames；收 select_source / pause / resume
//   tray.rs：系統列圖示（主執行緒；macOS 規定）
//   autostart.rs：開機自動啟動（預設開，tray 可關；啟動時確保有登記 + 背景定期檢查）
//   logfile.rs：log 也寫進設定資料夾的 helper.log（Release 版沒有主控台）
//
// 開發 / 測試用環境變數：
//   STAGE_PREVIZ_NDI_PORT=7790          換 port（不寫回 config）
//   STAGE_PREVIZ_NDI_CONFIG_DIR=…       換設定檔資料夾
//   STAGE_PREVIZ_NDI_NO_AUTOSTART=1     不碰開機自啟動設定
//   STAGE_PREVIZ_NDI_HEADLESS=1         不開系統列圖示（CI / 測試）

// Release 版不開黑色命令列視窗
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod autostart;
mod config;
mod logfile;
mod ndi;
mod state;
mod tray;
mod ws_server;

use log::{error, info};
use std::sync::Arc;

fn env_flag(name: &str) -> bool {
    std::env::var(name).map(|v| !v.is_empty() && v != "0").unwrap_or(false)
}

fn main() {
    logfile::init();
    info!(
        "Stage Previz NDI Helper v{} ({})",
        env!("CARGO_PKG_VERSION"),
        std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default()
    );

    let cfg = config::load_or_default();
    let port = config::effective_port(&cfg);
    info!("Config {}: {:?} (port {port})", config::config_path().display(), cfg);

    // 同一個 port 只能有一個 helper（重複打開就直接結束，不吵用戶）
    #[cfg(target_os = "macos")]
    let instance_name = config::config_dir()
        .join(format!("instance-{port}.lock"))
        .to_string_lossy()
        .into_owned();
    #[cfg(not(target_os = "macos"))]
    let instance_name = if port == 7777 {
        "stage-previz-ndi-helper".to_string()
    } else {
        format!("stage-previz-ndi-helper-{port}")
    };
    let _instance = match single_instance::SingleInstance::new(&instance_name) {
        Ok(i) => {
            if !i.is_single() {
                info!("Another instance is already running on port {port}; exiting.");
                return;
            }
            Some(i)
        }
        Err(e) => {
            error!("single-instance check failed ({e}); continuing");
            None
        }
    };

    let shared = Arc::new(state::Shared::new(cfg, port));

    // 開機自動啟動：預設開，確保登記的是目前這個執行檔（寫完讀回確認）；
    // 之後背景再檢查（被別的程式刪掉會補回去）。結果在 status.autostart + 系統列
    autostart::startup(&shared);
    {
        let shared = shared.clone();
        std::thread::Builder::new()
            .name("autostart".into())
            .spawn(move || autostart::watch(shared))
            .expect("spawn autostart thread");
    }

    // WebSocket server（tokio，兩條 worker 就夠）
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .thread_name("ws")
        .enable_all()
        .build()
        .expect("tokio runtime");
    runtime.spawn(ws_server::run(shared.clone()));

    // NDI 接收（專用 thread；NDI C API 用 raw pointer）
    {
        let shared = shared.clone();
        std::thread::Builder::new()
            .name("ndi".into())
            .spawn(move || ndi::run_forever(shared))
            .expect("spawn ndi thread");
    }

    if env_flag("STAGE_PREVIZ_NDI_HEADLESS") {
        info!("Headless mode (no tray icon)");
        loop {
            std::thread::park();
        }
    }

    // 系統列圖示：佔用主執行緒直到「離開」
    if let Err(e) = tray::run(shared) {
        error!("Tray failed: {e}");
        // 沒有系統列圖示也繼續在背景服務（網頁照樣能連）
        loop {
            std::thread::park();
        }
    }
    drop(runtime);
}
