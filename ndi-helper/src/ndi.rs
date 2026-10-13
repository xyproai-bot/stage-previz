// NDI receiver（runtime 動態載入 NDI 函式庫：Windows Processing.NDI.Lib.x64.dll / macOS libndi.dylib）
//
// 為何不用既有 ndi-rs crate？
//   它在 build 時就要連結 NDI SDK、路徑寫死。我們要在 runtime 找 NDI Tools 裝在哪，
//   沒裝也照樣跑起來，回報 ndi:"missing" 讓網頁提示「請先安裝 NDI Tools」。
//
// 整個 NDI 流程在一條專用 thread 跑（NDI C API 帶 raw pointer，不放進 async）：
//
//   載入 NDI 函式庫（找不到 → 狀態 missing，每 5 秒再找一次）
//     → NDIlib_initialize + 一直開著的 finder（每秒更新來源清單）
//     → 挑來源：手動指定（config.source_name）> 本機 AE > 本機其他 > 別台 AE > 第一個
//     → 只有在至少一個網頁要畫面時才建 receiver（沒人看就斷開，不解碼、不編碼）
//     → 每幀：限速 max_fps（預設 30）→ 2x 縮小 + limited→full → turbojpeg → 廣播給網頁

use crate::config::Config;
use crate::state::{HelperError, NdiRuntime, Shared, SourceInfo};
use libloading::Library;
use log::{debug, info, warn};
use rayon::prelude::*;
use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

// ── NDI SDK structs（只列我們用到的欄位）──────────────────────────────

#[repr(C)]
#[derive(Clone, Copy)]
struct NdiSource {
    p_ndi_name: *const c_char,
    p_url_address: *const c_char,
}

#[repr(C)]
struct NdiRecvCreateV3 {
    source_to_connect_to: NdiSource,
    color_format: c_int,
    bandwidth: c_int,
    allow_video_fields: bool,
    p_ndi_recv_name: *const c_char,
}

#[repr(C)]
struct NdiVideoFrameV2 {
    xres: c_int,
    yres: c_int,
    fourcc: c_int,
    frame_rate_n: c_int,
    frame_rate_d: c_int,
    picture_aspect_ratio: f32,
    frame_format_type: c_int,
    timecode: i64,
    p_data: *mut u8,
    line_stride_in_bytes: c_int,
    p_metadata: *const c_char,
    timestamp: i64,
}

const FRAME_TYPE_VIDEO: c_int = 1;
const FRAME_TYPE_ERROR: c_int = 4;
const RECV_BANDWIDTH_HIGHEST: c_int = 100;
// NDIlib_recv_color_format_RGBX_RGBA = 2 → buffer 是 RGBA byte 順序
// （enum 0 = BGRX_BGRA 在這個 SDK 版本收不到 frame，實測 2 才穩）
const RECV_COLOR_FORMAT_RGBX_RGBA: c_int = 2;

type FnInitialize = unsafe extern "C" fn() -> bool;
type FnFindCreateV2 = unsafe extern "C" fn(*const c_void) -> *mut c_void;
type FnFindGetCurrentSources = unsafe extern "C" fn(*mut c_void, *mut u32) -> *const NdiSource;
type FnFindDestroy = unsafe extern "C" fn(*mut c_void);
type FnRecvCreateV3 = unsafe extern "C" fn(*const NdiRecvCreateV3) -> *mut c_void;
type FnRecvCaptureV2 = unsafe extern "C" fn(
    *mut c_void,
    *mut NdiVideoFrameV2,
    *mut c_void, // audio frame（傳 null = 丟掉）
    *mut c_void, // metadata（傳 null = 丟掉）
    u32,         // timeout_ms
) -> c_int;
type FnRecvDestroy = unsafe extern "C" fn(*mut c_void);
type FnRecvFreeVideoV2 = unsafe extern "C" fn(*mut c_void, *mut NdiVideoFrameV2);

#[derive(Debug)]
pub enum NdiError {
    Missing(String),
    InitFailed,
    FindFailed,
    EncoderFailed(String),
}

impl std::fmt::Display for NdiError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            NdiError::Missing(detail) => write!(f, "找不到 NDI Runtime，請先安裝 NDI Tools（{detail}）"),
            NdiError::InitFailed => write!(f, "NDI 初始化失敗（CPU 不支援？）"),
            NdiError::FindFailed => write!(f, "NDI 來源搜尋啟動失敗"),
            NdiError::EncoderFailed(e) => write!(f, "JPEG 編碼器啟動失敗：{e}"),
        }
    }
}

// ── 找 / 載入 NDI 函式庫 ─────────────────────────────────────────────

#[cfg(windows)]
const LIB_NAME: &str = "Processing.NDI.Lib.x64.dll";
#[cfg(target_os = "macos")]
const LIB_NAME: &str = "libndi.dylib";
#[cfg(not(any(windows, target_os = "macos")))]
const LIB_NAME: &str = "libndi.so.6";

/// 依序列出可能的 NDI 函式庫位置（存在的才列），最後再讓系統自己找（只給檔名）。
fn library_candidates() -> Vec<PathBuf> {
    // 進階 / 測試：STAGE_PREVIZ_NDI_LIB 直接指定函式庫檔案（只用這個，不再找別的）
    if let Some(p) = std::env::var_os("STAGE_PREVIZ_NDI_LIB").filter(|p| !p.is_empty()) {
        return vec![PathBuf::from(p)];
    }
    let mut out: Vec<PathBuf> = Vec::new();
    let mut push = |p: PathBuf| {
        if p.is_file() && !out.contains(&p) {
            out.push(p);
        }
    };

    // 1. NDI 官方環境變數（NDI Tools / Runtime 安裝時設）
    for var in ["NDI_RUNTIME_DIR_V6", "NDI_RUNTIME_DIR_V5", "NDI_RUNTIME_DIR_V4"] {
        if let Some(dir) = std::env::var_os(var) {
            push(PathBuf::from(dir).join(LIB_NAME));
        }
    }

    #[cfg(windows)]
    {
        for base in [
            r"C:\Program Files\NDI\NDI 6 Runtime\v6",
            r"C:\Program Files\NDI\NDI 6 Tools\Runtime",
            r"C:\Program Files\NDI\NDI 6 SDK\Bin\x64",
            r"C:\Program Files\NDI\NDI 5 Runtime\v5",
            r"C:\Program Files\NDI\NDI 5 SDK\Bin\x64",
            r"C:\Program Files\NewTek\NDI 5 Runtime\v5",
            r"C:\Program Files\NewTek\NDI 4 Runtime\v4",
        ] {
            push(PathBuf::from(base).join(LIB_NAME));
        }
        if let Some(sdk) = std::env::var_os("NDI_SDK_DIR") {
            push(PathBuf::from(sdk).join("Bin").join("x64").join(LIB_NAME));
        }
    }

    #[cfg(target_os = "macos")]
    {
        // NDI Tools for Mac 裝的 runtime
        push(PathBuf::from("/usr/local/lib/libndi.dylib"));
        push(PathBuf::from("/opt/homebrew/lib/libndi.dylib"));
        // NDI SDK for Apple（新版 lib/macOS，舊版 lib/x64）；名稱可能是 "NDI SDK for Apple" / "NDI 6 SDK for Apple"
        for dir in dirs_matching("/Library", |n| n.starts_with("NDI") && n.contains("SDK")) {
            push(dir.join("lib/macOS/libndi.dylib"));
            push(dir.join("lib/x64/libndi.dylib"));
        }
        // NDI Tools 的 app 自己帶的函式庫（例如 NDI Video Monitor.app）
        let mut app_dirs = dirs_matching("/Applications", |n| n.contains("NDI"));
        for d in app_dirs.clone() {
            if d.extension().map(|e| e != "app").unwrap_or(true) {
                // /Applications/NDI Tools/… 這種資料夾 → 往下一層找 .app
                app_dirs.extend(dirs_matching(&d.to_string_lossy(), |n| n.ends_with(".app")));
            }
        }
        for app in app_dirs {
            for f in files_matching(&app.join("Contents/Frameworks"), |n| {
                n.starts_with("libndi") && n.ends_with(".dylib")
            }) {
                push(f);
            }
        }
        // AE 的 NDI 外掛（裝 NDI for Adobe CC 時一起裝的）
        let mediacore = "/Library/Application Support/Adobe/Common/Plug-ins/7.0/MediaCore";
        for plugin in dirs_matching(mediacore, |n| n.to_ascii_lowercase().contains("ndi")) {
            for sub in ["Contents/Frameworks", "Contents/MacOS", "Contents/Resources"] {
                for f in files_matching(&plugin.join(sub), |n| n.starts_with("libndi") && n.ends_with(".dylib")) {
                    push(f);
                }
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        for p in [
            "/usr/lib/x86_64-linux-gnu/libndi.so.6",
            "/usr/lib/x86_64-linux-gnu/libndi.so.5",
            "/usr/lib/libndi.so.6",
            "/usr/lib/libndi.so.5",
            "/usr/local/lib/libndi.so.6",
            "/usr/local/lib/libndi.so.5",
        ] {
            push(PathBuf::from(p));
        }
    }

    // 最後：只給檔名，讓系統依標準搜尋路徑找（PATH / dyld 預設路徑）
    out.push(PathBuf::from(LIB_NAME));
    out
}

#[cfg(target_os = "macos")]
fn dirs_matching(parent: &str, pred: impl Fn(&str) -> bool) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(parent) else { return Vec::new() };
    rd.filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .filter(|e| pred(&e.file_name().to_string_lossy()))
        .map(|e| e.path())
        .collect()
}

#[cfg(target_os = "macos")]
fn files_matching(dir: &std::path::Path, pred: impl Fn(&str) -> bool) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    rd.filter_map(|e| e.ok())
        .filter(|e| pred(&e.file_name().to_string_lossy()))
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .collect()
}

struct NdiLib {
    _lib: Library,
    initialize: FnInitialize,
    find_create: FnFindCreateV2,
    find_get: FnFindGetCurrentSources,
    find_destroy: FnFindDestroy,
    recv_create: FnRecvCreateV3,
    recv_capture: FnRecvCaptureV2,
    recv_destroy: FnRecvDestroy,
    recv_free_video: FnRecvFreeVideoV2,
}

impl NdiLib {
    fn load() -> Result<(Self, String), NdiError> {
        let mut last_err = String::from("not found");
        for path in library_candidates() {
            // SAFETY: 動態載入 NDI 函式庫（C ABI），只在這個檔案用
            let lib = match unsafe { Library::new(&path) } {
                Ok(l) => l,
                Err(e) => {
                    debug!("NDI lib {} failed: {e}", path.display());
                    last_err = format!("{}: {e}", path.display());
                    continue;
                }
            };
            match Self::from_library(lib) {
                Ok(l) => return Ok((l, path.display().to_string())),
                Err(e) => {
                    warn!("NDI lib {} missing symbol {e}", path.display());
                    last_err = format!("{}: missing {e}", path.display());
                }
            }
        }
        Err(NdiError::Missing(last_err))
    }

    fn from_library(lib: Library) -> Result<Self, String> {
        macro_rules! sym {
            ($name:literal, $ty:ty) => {{
                // SAFETY: 型別依 NDI SDK header 宣告
                let s: libloading::Symbol<$ty> = unsafe { lib.get($name) }.map_err(|_| {
                    String::from_utf8_lossy($name).trim_end_matches('\0').to_string()
                })?;
                *s
            }};
        }
        let initialize = sym!(b"NDIlib_initialize\0", FnInitialize);
        let find_create = sym!(b"NDIlib_find_create_v2\0", FnFindCreateV2);
        let find_get = sym!(b"NDIlib_find_get_current_sources\0", FnFindGetCurrentSources);
        let find_destroy = sym!(b"NDIlib_find_destroy\0", FnFindDestroy);
        let recv_create = sym!(b"NDIlib_recv_create_v3\0", FnRecvCreateV3);
        let recv_capture = sym!(b"NDIlib_recv_capture_v2\0", FnRecvCaptureV2);
        let recv_destroy = sym!(b"NDIlib_recv_destroy\0", FnRecvDestroy);
        let recv_free_video = sym!(b"NDIlib_recv_free_video_v2\0", FnRecvFreeVideoV2);
        Ok(Self {
            _lib: lib,
            initialize,
            find_create,
            find_get,
            find_destroy,
            recv_create,
            recv_capture,
            recv_destroy,
            recv_free_video,
        })
    }
}

// ── 來源清單 / 自動挑選 ─────────────────────────────────────────────

struct Src {
    name: String,
    name_c: CString,
    url_c: Option<CString>,
    local: bool,
    after_effects: bool,
}

/// 「這台電腦」的身分：hostname + 對外 IP，用來判斷哪個 NDI 來源是本機送的
struct LocalIdentity {
    host: String,
    ips: Vec<IpAddr>,
}

/// "Johns-MacBook-Pro.local" → "johns-macbook-pro"
fn short_host(s: &str) -> String {
    s.trim().split('.').next().unwrap_or("").trim().to_lowercase()
}

impl LocalIdentity {
    fn detect() -> Self {
        let host = short_host(&gethostname::gethostname().to_string_lossy());
        let mut ips = Vec::new();
        // UDP connect 不會真的送封包，只是讓系統挑出「預設對外網卡」的 IP
        if let Ok(sock) = std::net::UdpSocket::bind("0.0.0.0:0") {
            if sock.connect("8.8.8.8:80").is_ok() {
                if let Ok(addr) = sock.local_addr() {
                    ips.push(addr.ip());
                }
            }
        }
        Self { host, ips }
    }

    /// NDI 名稱格式 "機器名 (程式名)"：機器名 = 本機 hostname（不分大小寫）就算本機；
    /// 或 URL 的 IP 是 loopback / 本機 IP 也算。
    fn is_local(&self, name: &str, url: Option<&str>) -> bool {
        let machine = name.split(" (").next().unwrap_or(name);
        if !self.host.is_empty() && short_host(machine) == self.host {
            return true;
        }
        if let Some(url) = url {
            let host = url.rsplit_once(':').map(|(h, _)| h).unwrap_or(url);
            let host = host.trim_start_matches('[').trim_end_matches(']');
            if let Ok(ip) = host.parse::<IpAddr>() {
                return ip.is_loopback() || self.ips.contains(&ip);
            }
        }
        false
    }
}

fn is_after_effects(name: &str) -> bool {
    name.to_lowercase().contains("after effects")
}

/// 挑來源：手動指定且在線 > 本機 AE > 本機其他 > 別台 AE > 清單第一個
fn pick_source(sources: &[Src], preferred: Option<&str>) -> Option<usize> {
    if let Some(p) = preferred.filter(|p| !p.is_empty()) {
        if let Some(i) = sources.iter().position(|s| s.name == p) {
            return Some(i);
        }
        if let Some(i) = sources.iter().position(|s| s.name.eq_ignore_ascii_case(p)) {
            return Some(i);
        }
    }
    let mut best: Option<(usize, u8)> = None;
    for (i, s) in sources.iter().enumerate() {
        let score = match (s.local, s.after_effects) {
            (true, true) => 3,
            (true, false) => 2,
            (false, true) => 1,
            (false, false) => 0,
        };
        if best.map_or(true, |(_, b)| score > b) {
            best = Some((i, score));
        }
    }
    best.map(|(i, _)| i)
}

// ── RAII：finder / receiver ────────────────────────────────────────

struct Finder<'a> {
    lib: &'a NdiLib,
    ptr: *mut c_void,
}

impl Drop for Finder<'_> {
    fn drop(&mut self) {
        unsafe { (self.lib.find_destroy)(self.ptr) };
    }
}

struct Receiver<'a> {
    lib: &'a NdiLib,
    ptr: *mut c_void,
    name: String,
}

impl Drop for Receiver<'_> {
    fn drop(&mut self) {
        unsafe { (self.lib.recv_destroy)(self.ptr) };
    }
}

impl<'a> Receiver<'a> {
    fn connect(lib: &'a NdiLib, src: &Src) -> Option<Self> {
        let recv_name = b"Stage Previz NDI Helper\0";
        let desc = NdiRecvCreateV3 {
            source_to_connect_to: NdiSource {
                p_ndi_name: src.name_c.as_ptr(),
                p_url_address: src.url_c.as_ref().map(|u| u.as_ptr()).unwrap_or(std::ptr::null()),
            },
            color_format: RECV_COLOR_FORMAT_RGBX_RGBA,
            bandwidth: RECV_BANDWIDTH_HIGHEST,
            allow_video_fields: false,
            p_ndi_recv_name: recv_name.as_ptr() as *const c_char,
        };
        let ptr = unsafe { (lib.recv_create)(&desc) };
        if ptr.is_null() {
            None
        } else {
            Some(Self { lib, ptr, name: src.name.clone() })
        }
    }
}

// ── 限速（max_fps）──────────────────────────────────────────────────

struct Pacer {
    next_due: Option<Instant>,
}

impl Pacer {
    /// AE 送 60fps、上限 30 → 每兩張編一張；允許提早 1/4 間隔，吸收 30fps 來源的抖動
    fn ready(&mut self, now: Instant, interval: Duration) -> bool {
        match self.next_due {
            Some(due) if now + interval / 4 < due => false,
            Some(due) => {
                let mut next = due + interval;
                if next <= now {
                    next = now + interval; // 落後太多 → 重新對齊，不要連發
                }
                self.next_due = Some(next);
                true
            }
            None => {
                self.next_due = Some(now + interval);
                true
            }
        }
    }
}

// ── 主迴圈 ─────────────────────────────────────────────────────────

/// 永遠不回傳：在專用 thread 上跑
pub fn run_forever(shared: Arc<Shared>) {
    let mut lib: Option<NdiLib> = None;
    loop {
        if lib.is_none() {
            match NdiLib::load() {
                Ok((l, path)) => {
                    info!("NDI library loaded: {path}");
                    shared.update(|s| {
                        s.ndi_path = Some(path);
                        true
                    });
                    lib = Some(l);
                }
                Err(e) => {
                    let msg = e.to_string();
                    shared.update(|s| {
                        let changed = s.ndi != NdiRuntime::Missing;
                        if changed {
                            warn!("{msg}");
                        }
                        s.ndi = NdiRuntime::Missing;
                        s.ndi_path = None;
                        s.sources.clear();
                        s.source = None;
                        s.connected = false;
                        s.receiving = false;
                        s.error = Some(HelperError {
                            code: "ndi_missing",
                            message: "找不到 NDI Runtime，請先安裝 NDI Tools（https://ndi.video/tools/）".into(),
                        });
                        changed
                    });
                    // 用戶可能正在裝 NDI Tools → 過幾秒再找（只是檢查幾個檔案在不在，很便宜）
                    std::thread::sleep(Duration::from_secs(5));
                    continue;
                }
            }
        }
        let l = lib.as_ref().expect("lib loaded");
        if let Err(e) = run_session(l, &shared) {
            warn!("NDI session ended: {e}");
            let code = match e {
                NdiError::Missing(_) => "ndi_missing",
                NdiError::InitFailed | NdiError::FindFailed => "ndi_init_failed",
                NdiError::EncoderFailed(_) => "encoder_failed",
            };
            shared.update(|s| {
                s.ndi = NdiRuntime::Error;
                s.connected = false;
                s.receiving = false;
                s.error = Some(HelperError { code, message: e.to_string() });
                true
            });
            std::thread::sleep(Duration::from_secs(5));
        }
    }
}

fn run_session(lib: &NdiLib, shared: &Shared) -> Result<(), NdiError> {
    if !unsafe { (lib.initialize)() } {
        return Err(NdiError::InitFailed);
    }
    let finder_ptr = unsafe { (lib.find_create)(std::ptr::null()) };
    if finder_ptr.is_null() {
        return Err(NdiError::FindFailed);
    }
    let finder = Finder { lib, ptr: finder_ptr };

    let mut compressor =
        turbojpeg::Compressor::new().map_err(|e| NdiError::EncoderFailed(e.to_string()))?;
    let mut quality: i32 = -1;

    shared.update(|s| {
        s.ndi = NdiRuntime::Ready;
        if s.error.as_ref().map(|e| e.code.starts_with("ndi_")).unwrap_or(false) {
            s.error = None;
        }
        true
    });
    info!("NDI ready; searching for sources…");

    let mut sources: Vec<Src> = Vec::new();
    let mut identity = LocalIdentity::detect();
    info!("Local host = {:?}, ips = {:?}", identity.host, identity.ips);
    let mut last_refresh: Option<Instant> = None;
    let mut seen_gen = u64::MAX;
    let mut recv: Option<Receiver> = None;
    let mut retry_connect_at: Option<Instant> = None;
    let mut pacer = Pacer { next_due: None };

    // 統計
    let mut frame_count: u64 = 0;
    let mut sec_start = Instant::now();
    let mut sec_ndi = 0u32;
    let mut sec_sent = 0u32;
    let mut sec_encode = Duration::ZERO;
    let mut last_frame_at: Option<Instant> = None;

    loop {
        let now = Instant::now();
        let gen = shared.pref_gen.load(Ordering::Relaxed);

        // 1. 每秒（或手動選來源時）更新來源清單
        if last_refresh.map_or(true, |t| now.duration_since(t) >= Duration::from_secs(1)) || gen != seen_gen {
            if last_refresh.map_or(true, |t| now.duration_since(t) >= Duration::from_secs(30)) {
                identity = LocalIdentity::detect(); // IP 可能換了（DHCP / 換網路）
            }
            refresh_sources(lib, &finder, &identity, &mut sources);
            last_refresh = Some(now);
            let infos: Vec<SourceInfo> = sources
                .iter()
                .map(|s| SourceInfo { name: s.name.clone(), local: s.local, after_effects: s.after_effects })
                .collect();
            shared.update(|s| {
                if s.sources != infos {
                    info!("NDI sources: {:?}", infos.iter().map(|i| &i.name).collect::<Vec<_>>());
                    s.sources = infos;
                    true
                } else {
                    false
                }
            });
        }
        seen_gen = gen;

        let cfg: Config = shared.cfg().clone();
        let target = pick_source(&sources, cfg.source_name.as_deref());
        // 目前來源：挑到的；都沒有就維持正在接的（AE 暫時從清單消失，NDI 會自己重連）
        let target_name = target
            .map(|i| sources[i].name.clone())
            .or_else(|| recv.as_ref().map(|r| r.name.clone()));
        shared.update(|s| {
            let mut changed = false;
            if s.source != target_name {
                s.source = target_name.clone();
                changed = true;
            }
            let no_source = target_name.is_none();
            let has_no_source_err = s.error.as_ref().map(|e| e.code == "no_source").unwrap_or(false);
            if no_source && s.error.is_none() {
                s.error = Some(HelperError {
                    code: "no_source",
                    message: "找不到 NDI 來源（AE 有開 NDI 輸出嗎？）".into(),
                });
                changed = true;
            } else if !no_source && has_no_source_err {
                s.error = None;
                changed = true;
            }
            changed
        });

        // 2. 沒有網頁要畫面 → 斷開 receiver（不解碼、不編碼），只留 finder 更新清單
        if shared.frame_clients() == 0 {
            if recv.take().is_some() {
                info!("No browser wants frames → NDI receiver disconnected (idle)");
                pacer.next_due = None;
                last_frame_at = None;
                shared.update(|s| {
                    s.connected = false;
                    s.receiving = false;
                    s.fps = 0.0;
                    s.ndi_fps = 0.0;
                    true
                });
            }
            std::thread::sleep(Duration::from_millis(200));
            continue;
        }

        // 3. 要接的來源變了 → 重建 receiver
        if let Some(i) = target {
            let need_switch = recv.as_ref().map(|r| r.name != sources[i].name).unwrap_or(true);
            if need_switch && retry_connect_at.map_or(true, |t| now >= t) {
                if let Some(old) = recv.take() {
                    info!("Switching NDI source: {} → {}", old.name, sources[i].name);
                }
                match Receiver::connect(lib, &sources[i]) {
                    Some(r) => {
                        info!("NDI receiver connected: {}", r.name);
                        recv = Some(r);
                        retry_connect_at = None;
                        pacer.next_due = None;
                        last_frame_at = None;
                        shared.update(|s| {
                            s.connected = true;
                            s.receiving = false;
                            // 新來源的尺寸等第一幀進來再填
                            (s.width, s.height, s.out_width, s.out_height) = (0, 0, 0, 0);
                            if s.error.as_ref().map(|e| e.code == "recv_failed").unwrap_or(false) {
                                s.error = None;
                            }
                            true
                        });
                    }
                    None => {
                        warn!("NDI recv_create failed for {}", sources[i].name);
                        retry_connect_at = Some(now + Duration::from_secs(2));
                        shared.update(|s| {
                            s.connected = false;
                            s.error = Some(HelperError {
                                code: "recv_failed",
                                message: format!("連不上 NDI 來源：{}", sources[i].name),
                            });
                            true
                        });
                    }
                }
            }
        }

        let Some(r) = recv.as_ref() else {
            std::thread::sleep(Duration::from_millis(200));
            continue;
        };

        // 4. 收一幀（最多等 100ms）
        let mut vf: NdiVideoFrameV2 = unsafe { std::mem::zeroed() };
        let frame_type = unsafe {
            (lib.recv_capture)(r.ptr, &mut vf, std::ptr::null_mut(), std::ptr::null_mut(), 100)
        };
        let now = Instant::now();

        if frame_type == FRAME_TYPE_VIDEO && !vf.p_data.is_null() && vf.xres > 0 && vf.yres > 0 {
            sec_ndi += 1;
            last_frame_at = Some(now);
            let w = vf.xres as usize;
            let h = vf.yres as usize;
            let stride = vf.line_stride_in_bytes as usize;
            let interval = Duration::from_secs_f64(1.0 / cfg.max_fps.clamp(1, 120) as f64);

            if pacer.ready(now, interval) && shared.frame_clients() > 0 && stride >= w * 4 {
                if quality != cfg.jpeg_quality as i32 {
                    quality = cfg.jpeg_quality.clamp(1, 100) as i32;
                    let _ = compressor.set_quality(quality);
                }
                // SAFETY: NDI 保證 p_data 有 stride * yres bytes，直到 free_video
                let raw = unsafe { std::slice::from_raw_parts(vf.p_data, stride * h) };
                let t_enc = Instant::now();
                let encoded = encode_frame(raw, w, h, stride, &cfg, &mut compressor);
                sec_encode += t_enc.elapsed();
                if let Some((jpeg, ow, oh)) = encoded {
                    let _ = shared.frames.send(Arc::new(jpeg));
                    frame_count += 1;
                    sec_sent += 1;
                    shared.update(|s| {
                        let size = (w as u32, h as u32, ow as u32, oh as u32);
                        if (s.width, s.height, s.out_width, s.out_height) != size {
                            (s.width, s.height, s.out_width, s.out_height) = size;
                            true
                        } else {
                            false
                        }
                    });
                }
            }
            unsafe { (lib.recv_free_video)(r.ptr, &mut vf) };
        } else if frame_type == FRAME_TYPE_ERROR {
            // 連線斷了（AE 關掉）→ NDI 會自己重連；稍等一下避免空轉
            std::thread::sleep(Duration::from_millis(50));
        }

        // 5. 每秒更新 fps；超過 2 秒沒畫面 → receiving = false
        let receiving = last_frame_at.map_or(false, |t| now.duration_since(t) < Duration::from_secs(2));
        let elapsed = now.duration_since(sec_start);
        if elapsed >= Duration::from_secs(1) {
            let secs = elapsed.as_secs_f32();
            let (fps, ndi_fps) = (sec_sent as f32 / secs, sec_ndi as f32 / secs);
            let encode_ms = if sec_sent > 0 { sec_encode.as_secs_f32() * 1000.0 / sec_sent as f32 } else { 0.0 };
            sec_start = now;
            sec_ndi = 0;
            sec_sent = 0;
            sec_encode = Duration::ZERO;
            shared.update(|s| {
                s.fps = fps;
                s.ndi_fps = ndi_fps;
                s.encode_ms = encode_ms;
                s.frame_count = frame_count;
                false // fps 每秒本來就會推，不另外通知
            });
        }
        shared.update(|s| {
            if s.receiving != receiving {
                s.receiving = receiving;
                if !receiving {
                    s.fps = 0.0;
                    s.ndi_fps = 0.0;
                }
                true
            } else {
                false
            }
        });
    }
}

fn refresh_sources(lib: &NdiLib, finder: &Finder, identity: &LocalIdentity, out: &mut Vec<Src>) {
    let mut count: u32 = 0;
    let ptr = unsafe { (lib.find_get)(finder.ptr, &mut count) };
    let mut next: Vec<Src> = Vec::with_capacity(count as usize);
    if !ptr.is_null() && count > 0 {
        // SAFETY: 回傳的陣列在下一次 find_get / find_destroy 前有效；這裡馬上複製出來
        let list = unsafe { std::slice::from_raw_parts(ptr, count as usize) };
        for s in list {
            if s.p_ndi_name.is_null() {
                continue;
            }
            let name_c = unsafe { CStr::from_ptr(s.p_ndi_name) }.to_owned();
            let name = name_c.to_string_lossy().into_owned();
            let url_c = if s.p_url_address.is_null() {
                None
            } else {
                Some(unsafe { CStr::from_ptr(s.p_url_address) }.to_owned())
            };
            let url = url_c.as_ref().map(|u| u.to_string_lossy().into_owned());
            let local = identity.is_local(&name, url.as_deref());
            let after_effects = is_after_effects(&name);
            next.push(Src { name, name_c, url_c, local, after_effects });
        }
    }
    *out = next;
}

/// RGBA → (2x box 縮小) → limited→full → RGB → JPEG。回傳 (jpeg, 輸出寬, 輸出高)
fn encode_frame(
    raw: &[u8],
    w: usize,
    h: usize,
    stride: usize,
    cfg: &Config,
    compressor: &mut turbojpeg::Compressor,
) -> Option<(Vec<u8>, usize, usize)> {
    // rayon：每個輸出 row 一個 task，跨核心同時跑。
    // 大張 LED canvas（10912×2024）約 22M pixel；單執行緒 200-400ms，8 核 30-60ms。
    let lut = limited_lut();
    let do_limited = cfg.limited_to_full;

    let (out_buf, out_w, out_h) = if cfg.downsample && w >= 2 && h >= 2 {
        let dw = w / 2;
        let dh = h / 2;
        let mut buf = vec![0u8; dw * dh * 3];
        buf.par_chunks_exact_mut(dw * 3).enumerate().for_each(|(y, row)| {
            let sy = y * 2;
            for x in 0..dw {
                let sx = x * 2;
                let (mut r, mut g, mut b) = (0u32, 0u32, 0u32);
                for dy in 0..2 {
                    let row_off = (sy + dy) * stride;
                    for dx in 0..2 {
                        let off = row_off + (sx + dx) * 4;
                        r += raw[off] as u32;
                        g += raw[off + 1] as u32;
                        b += raw[off + 2] as u32;
                    }
                }
                let (mut rr, mut gg, mut bb) = ((r >> 2) as u8, (g >> 2) as u8, (b >> 2) as u8);
                if do_limited {
                    rr = lut[rr as usize];
                    gg = lut[gg as usize];
                    bb = lut[bb as usize];
                }
                let dst = x * 3;
                row[dst] = rr;
                row[dst + 1] = gg;
                row[dst + 2] = bb;
            }
        });
        (buf, dw, dh)
    } else {
        let mut buf = vec![0u8; w * h * 3];
        buf.par_chunks_exact_mut(w * 3).enumerate().for_each(|(y, row)| {
            let row_off = y * stride;
            for x in 0..w {
                let off = row_off + x * 4;
                let (mut r, mut g, mut b) = (raw[off], raw[off + 1], raw[off + 2]);
                if do_limited {
                    r = lut[r as usize];
                    g = lut[g as usize];
                    b = lut[b as usize];
                }
                let dst = x * 3;
                row[dst] = r;
                row[dst + 1] = g;
                row[dst + 2] = b;
            }
        });
        (buf, w, h)
    };

    let img = turbojpeg::Image {
        pixels: out_buf.as_slice(),
        width: out_w,
        pitch: out_w * 3,
        height: out_h,
        format: turbojpeg::PixelFormat::RGB,
    };
    match compressor.compress_to_vec(img) {
        Ok(bytes) => Some((bytes, out_w, out_h)),
        Err(e) => {
            warn!("turbojpeg encode error: {e}");
            None
        }
    }
}

#[inline]
fn limited_to_full(v: u8) -> u8 {
    // BT.709 limited range: [16, 235] → full [0, 255]
    let f = (v as i32 - 16).clamp(0, 219);
    ((f * 255 + 110) / 219).min(255) as u8
}

/// 256 格查表（第一次算好後一直用）
fn limited_lut() -> &'static [u8; 256] {
    use std::sync::OnceLock;
    static LUT: OnceLock<[u8; 256]> = OnceLock::new();
    LUT.get_or_init(|| {
        let mut a = [0u8; 256];
        for (i, v) in a.iter_mut().enumerate() {
            *v = limited_to_full(i as u8);
        }
        a
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn src(name: &str, local: bool) -> Src {
        Src {
            name: name.into(),
            name_c: CString::new(name).unwrap(),
            url_c: None,
            local,
            after_effects: is_after_effects(name),
        }
    }

    #[test]
    fn picks_local_after_effects_first() {
        let list = vec![
            src("OTHER-PC (Adobe After Effects)", false),
            src("ULTRA9-285K (Test Pattern)", true),
            src("ULTRA9-285K (Adobe After Effects)", true),
        ];
        assert_eq!(pick_source(&list, None), Some(2));
    }

    #[test]
    fn local_beats_remote_ae_and_fallbacks() {
        let list = vec![src("A (x)", false), src("B (Adobe After Effects)", false), src("ME (y)", true)];
        assert_eq!(pick_source(&list, None), Some(2));
        let list = vec![src("A (x)", false), src("B (Adobe After Effects)", false)];
        assert_eq!(pick_source(&list, None), Some(1));
        let list = vec![src("A (x)", false), src("B (y)", false)];
        assert_eq!(pick_source(&list, None), Some(0));
        assert_eq!(pick_source(&[], None), None);
    }

    #[test]
    fn explicit_choice_wins_when_online() {
        let list = vec![src("ME (Adobe After Effects)", true), src("B (y)", false)];
        assert_eq!(pick_source(&list, Some("B (y)")), Some(1));
        // 不在線 → 照自動規則
        assert_eq!(pick_source(&list, Some("GONE (z)")), Some(0));
    }

    #[test]
    fn local_detection() {
        let id = LocalIdentity { host: "ultra9-285k".into(), ips: vec!["192.168.1.5".parse().unwrap()] };
        assert!(id.is_local("ULTRA9-285K (Adobe After Effects)", None));
        assert!(id.is_local("Ultra9-285K.local (x)", None));
        assert!(!id.is_local("OTHER (Adobe After Effects)", Some("192.168.1.9:5961")));
        assert!(id.is_local("OTHER (x)", Some("192.168.1.5:5961")));
        assert!(id.is_local("OTHER (x)", Some("127.0.0.1:5961")));
    }

    #[test]
    fn pacer_caps_60_to_30() {
        let mut p = Pacer { next_due: None };
        let start = Instant::now();
        let interval = Duration::from_secs_f64(1.0 / 30.0);
        let mut sent = 0;
        for i in 0..120 {
            // 60fps 來源，兩秒
            let t = start + Duration::from_secs_f64(i as f64 / 60.0);
            if p.ready(t, interval) {
                sent += 1;
            }
        }
        assert!((59..=61).contains(&sent), "sent {sent}");
    }

    #[test]
    fn pacer_keeps_all_30fps_frames_with_jitter() {
        let mut p = Pacer { next_due: None };
        let start = Instant::now();
        let interval = Duration::from_secs_f64(1.0 / 30.0);
        let mut sent = 0;
        for i in 0..60 {
            let jitter = if i % 2 == 0 { 4.0 } else { -4.0 };
            let t = start + Duration::from_secs_f64((i as f64 * 33.3667 + jitter + 10.0) / 1000.0);
            if p.ready(t, interval) {
                sent += 1;
            }
        }
        assert!(sent >= 58, "sent {sent}");
    }
}
