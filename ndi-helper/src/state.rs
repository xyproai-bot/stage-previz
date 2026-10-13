// 全域共用狀態：NDI 執行緒寫、WebSocket / tray 讀
//
// 用 std::sync::Mutex（臨界區都很短，不會跨 await 持有）。
// 有「值得馬上告訴網頁」的變化（來源清單、目前來源、NDI 裝了沒、開始/停止收到畫面…）
// 就呼叫 notify() → 每個 WebSocket 連線會立刻推一次 status。

use crate::config::Config;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use tokio::sync::{broadcast, watch};

/// 一張 JPEG（多個網頁共用同一份 bytes）
pub type Frame = Arc<Vec<u8>>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NdiRuntime {
    /// 剛啟動，還在找 NDI DLL / dylib
    Starting,
    /// 找不到 NDI Runtime（沒裝 NDI Tools）
    Missing,
    /// NDI 載入成功
    Ready,
    /// NDI 找到了但初始化失敗
    Error,
}

impl NdiRuntime {
    pub fn as_str(self) -> &'static str {
        match self {
            NdiRuntime::Starting => "starting",
            NdiRuntime::Missing => "missing",
            NdiRuntime::Ready => "ready",
            NdiRuntime::Error => "error",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceInfo {
    pub name: String,
    /// 這台電腦送出來的（名稱的機器名 = 本機 hostname，或 IP 是本機）
    pub local: bool,
    /// 名稱裡有 "After Effects"
    pub after_effects: bool,
}

/// 開機自動啟動的實際狀況（給網頁 status.autostart / 系統列顯示）
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AutostartStatus {
    /// config 要不要開機自動啟動
    pub wanted: bool,
    /// 真的有登記、而且指到目前這個執行檔（Windows Run 機碼 / macOS LaunchAgent）
    pub registered: bool,
    /// 上一次登記 / 取消失敗的原因（中文，可以直接顯示）；成功 = None
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HelperError {
    pub code: &'static str,
    pub message: String,
}

#[derive(Clone, Debug)]
pub struct HelperState {
    pub ndi: NdiRuntime,
    /// 實際載入的 NDI 函式庫路徑
    pub ndi_path: Option<String>,
    /// 目前網路上看得到的 NDI 來源
    pub sources: Vec<SourceInfo>,
    /// 目前要接（或正在接）的來源
    pub source: Option<String>,
    /// NDI receiver 是否連著（有網頁要畫面時才連）
    pub connected: bool,
    /// 最近 2 秒內有收到 NDI 畫面
    pub receiving: bool,
    /// NDI 原始畫面尺寸
    pub width: u32,
    pub height: u32,
    /// 送給瀏覽器的 JPEG 尺寸
    pub out_width: u32,
    pub out_height: u32,
    /// 每秒送出的 JPEG 張數（已套 max_fps 上限）
    pub fps: f32,
    /// 每秒從 NDI 收到的張數（未限速）
    pub ndi_fps: f32,
    /// 最近一秒每張的平均處理時間（縮小 + JPEG 編碼，毫秒）
    pub encode_ms: f32,
    pub frame_count: u64,
    pub error: Option<HelperError>,
    /// WebSocket port 開不起來（多半是已經有另一個小程序在跑）
    pub port_error: Option<String>,
    /// 開機自動啟動（啟動時 + 背景定期檢查）
    pub autostart: AutostartStatus,
}

impl Default for HelperState {
    fn default() -> Self {
        Self {
            ndi: NdiRuntime::Starting,
            ndi_path: None,
            sources: Vec::new(),
            source: None,
            connected: false,
            receiving: false,
            width: 0,
            height: 0,
            out_width: 0,
            out_height: 0,
            fps: 0.0,
            ndi_fps: 0.0,
            encode_ms: 0.0,
            frame_count: 0,
            error: None,
            port_error: None,
            autostart: AutostartStatus::default(),
        }
    }
}

impl HelperState {
    /// 給網頁的一句話狀態（switch 這個就好）
    pub fn summary(&self, clients_want_frames: bool) -> &'static str {
        match self.ndi {
            NdiRuntime::Starting => "starting",
            NdiRuntime::Missing => "ndi_missing",
            NdiRuntime::Error => "ndi_error",
            NdiRuntime::Ready => {
                if self.source.is_none() {
                    "searching"
                } else if !clients_want_frames {
                    "standby"
                } else if self.receiving {
                    "live"
                } else {
                    "connecting"
                }
            }
        }
    }
}

pub struct Shared {
    state: Mutex<HelperState>,
    cfg: Mutex<Config>,
    status_tx: watch::Sender<u64>,
    /// 手動選來源有變 → NDI 執行緒馬上重挑（不用等下一次輪詢）
    pub pref_gen: AtomicU64,
    /// 已連線的 WebSocket 數量
    pub clients: AtomicUsize,
    /// NDI → 網頁的 JPEG 廣播。receiver 數 = 想收畫面的連線數
    /// （沒有人要 → 不連 NDI、不編碼，閒置時幾乎不吃 CPU）
    pub frames: broadcast::Sender<Frame>,
    pub port: u16,
}

impl Shared {
    pub fn new(cfg: Config, port: u16) -> Self {
        let (status_tx, _) = watch::channel(0u64);
        // 容量小 = 延遲低；網頁跟不上就跳幀（Lagged）而不是越積越多
        let (frames, _) = broadcast::channel::<Frame>(2);
        Self {
            state: Mutex::new(HelperState::default()),
            cfg: Mutex::new(cfg),
            status_tx,
            pref_gen: AtomicU64::new(0),
            clients: AtomicUsize::new(0),
            frames,
            port,
        }
    }

    pub fn state(&self) -> MutexGuard<'_, HelperState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn cfg(&self) -> MutexGuard<'_, Config> {
        self.cfg.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn subscribe_status(&self) -> watch::Receiver<u64> {
        self.status_tx.subscribe()
    }

    /// 通知所有 WebSocket 連線推一次 status
    pub fn notify(&self) {
        self.status_tx.send_modify(|v| *v = v.wrapping_add(1));
    }

    /// 改 state；closure 回傳 true（真的有變）才通知
    pub fn update(&self, f: impl FnOnce(&mut HelperState) -> bool) {
        let changed = {
            let mut s = self.state();
            f(&mut s)
        };
        if changed {
            self.notify();
        }
    }

    pub fn clients(&self) -> usize {
        self.clients.load(Ordering::Relaxed)
    }

    pub fn frame_clients(&self) -> usize {
        self.frames.receiver_count()
    }
}
