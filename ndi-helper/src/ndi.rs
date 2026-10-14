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
//     → 挑來源：手動指定（config.source_name，可以是別台）> 本機 AE > 本機其他；
//       自動模式「絕不」接別台電腦（不會自動顯示同事的畫面）→ 這台沒有就等（no_local_source）
//     → 只有在至少一個網頁要畫面時才建 receiver（沒人看就斷開，不解碼、不編碼）
//     → 每幀：限速 max_fps（預設 30）→ 太大才縮小（整數分之一，不超過 max_output_pixels）
//       →（設定開著才）limited→full → turbojpeg（品質 90、4:4:4）→ 廣播給網頁

use crate::config::Config;
use crate::state::{HelperError, NdiRuntime, Shared, SourceInfo};
use libloading::Library;
use log::{debug, info, warn};
use rayon::prelude::*;
use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
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

/// 「這台電腦」的身分：電腦名稱 + 對外 IP，用來判斷哪個 NDI 來源是本機送的
struct LocalIdentity {
    /// 小寫、去掉網域（hostname；Windows 另外加 COMPUTERNAME，名稱超過 15 字時兩個會不一樣）
    hosts: Vec<String>,
    ips: Vec<IpAddr>,
}

/// "Johns-MacBook-Pro.local" → "johns-macbook-pro"
fn short_host(s: &str) -> String {
    s.trim().split('.').next().unwrap_or("").trim().to_lowercase()
}

impl LocalIdentity {
    fn detect() -> Self {
        let mut hosts = vec![short_host(&gethostname::gethostname().to_string_lossy())];
        #[cfg(windows)]
        if let Ok(n) = std::env::var("COMPUTERNAME") {
            hosts.push(short_host(&n));
        }
        hosts.retain(|h| !h.is_empty());
        hosts.dedup();
        let mut ips = Vec::new();
        // UDP connect 不會真的送封包，只是讓系統挑出「預設對外網卡」的 IP
        if let Ok(sock) = std::net::UdpSocket::bind("0.0.0.0:0") {
            if sock.connect("8.8.8.8:80").is_ok() {
                if let Ok(addr) = sock.local_addr() {
                    ips.push(addr.ip());
                }
            }
        }
        Self { hosts, ips }
    }

    /// NDI 名稱格式 "機器名 (程式名)"：機器名 = 本機名稱（不分大小寫）就算本機；
    /// 或 URL 的 IP 是 loopback / 本機 IP 也算。
    fn is_local(&self, name: &str, url: Option<&str>) -> bool {
        let machine = short_host(name.split(" (").next().unwrap_or(name));
        if !machine.is_empty() && self.hosts.iter().any(|h| *h == machine) {
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

/// 挑來源的結果
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Pick {
    /// 接 sources[i]
    Source(usize),
    /// 網路上有來源，但都是別台電腦的 → 不自動接（網頁可以手動選）
    NoLocal,
    /// 一個來源都沒有
    NoSource,
}

impl Pick {
    fn index(self) -> Option<usize> {
        match self {
            Pick::Source(i) => Some(i),
            _ => None,
        }
    }
}

/// 名稱一樣（先比完全一樣，再比不分大小寫）
fn same_name(a: &str, b: &str) -> bool {
    a == b || a.eq_ignore_ascii_case(b)
}

/// 挑來源：
///   1. 手動指定（網頁送 select_source）而且在線 → 用它（可以是別台電腦）
///   2. 這台電腦的 After Effects
///   3. 這台電腦的其他 NDI 來源
///   別台電腦的來源**不會自動接**（不要自動顯示同事的畫面）→ NoLocal，等這台的 AE 上線或網頁手動選
fn pick_source(sources: &[Src], preferred: Option<&str>) -> Pick {
    if let Some(p) = preferred.filter(|p| !p.trim().is_empty()) {
        if let Some(i) = sources.iter().position(|s| s.name == p) {
            return Pick::Source(i);
        }
        if let Some(i) = sources.iter().position(|s| same_name(&s.name, p)) {
            return Pick::Source(i);
        }
    }
    if let Some(i) = sources.iter().position(|s| s.local && s.after_effects) {
        return Pick::Source(i);
    }
    if let Some(i) = sources.iter().position(|s| s.local) {
        return Pick::Source(i);
    }
    if sources.is_empty() {
        Pick::NoSource
    } else {
        Pick::NoLocal
    }
}

/// 沒挑到新來源時，正在接的還能不能留著（AE 暫時從清單消失時 NDI 會自己重連，不用斷）：
/// 只有「手動指定的那個」或「這台電腦的」可以留；別台電腦的（例如剛從手動切回自動）要斷開。
fn may_keep_receiver(recv_name: &str, recv_local: bool, preferred: Option<&str>) -> bool {
    recv_local || preferred.map_or(false, |p| same_name(recv_name, p.trim()))
}

/// 沒有可以接的來源時回報給網頁的錯誤
fn no_source_error(pick: Pick, sources: &[Src]) -> Option<HelperError> {
    match pick {
        Pick::Source(_) => None,
        Pick::NoSource => Some(HelperError {
            code: "no_source",
            message: "找不到 NDI 來源（AE 有開 NDI 輸出嗎？）".into(),
        }),
        Pick::NoLocal => Some(HelperError {
            code: "no_local_source",
            message: format!(
                "這台電腦的 AE 沒有在送 NDI（網路上有 {} 個別台電腦的來源，不會自動接；要看請在網頁上選）",
                sources.len()
            ),
        }),
    }
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
    /// 這台電腦的來源（自動模式只能留著本機的）
    local: bool,
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
            Some(Self { lib, ptr, name: src.name.clone(), local: src.local })
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

fn run_session(lib: &NdiLib, shared: &Arc<Shared>) -> Result<(), NdiError> {
    if !unsafe { (lib.initialize)() } {
        return Err(NdiError::InitFailed);
    }
    let finder_ptr = unsafe { (lib.find_create)(std::ptr::null()) };
    if finder_ptr.is_null() {
        return Err(NdiError::FindFailed);
    }
    let finder = Finder { lib, ptr: finder_ptr };

    // JPEG 品質讀一次（config.json 改了要重開小程序）
    let quality: u8 = shared.cfg().jpeg_quality;
    let out = shared.clone();
    let pool = EncoderPool::new(ENCODER_THREADS, quality, move |jpeg| {
        let _ = out.frames.send(Arc::new(jpeg));
    })
    .map_err(NdiError::EncoderFailed)?;
    let mut seq: u64 = 0;
    // 上一次記到 log 的尺寸（變了才記：AE 切 Full / Half / Third、換合成）
    let mut logged_size: Option<(usize, usize, usize, usize)> = None;

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
    info!("Local names = {:?}, ips = {:?}", identity.hosts, identity.ips);
    let mut last_refresh: Option<Instant> = None;
    let mut seen_gen = u64::MAX;
    let mut recv: Option<Receiver> = None;
    let mut retry_connect_at: Option<Instant> = None;
    let mut pacer = Pacer { next_due: None };

    // 統計（送出幾張、花多久在編碼工人那邊算：pool.stats）
    let mut sec_start = Instant::now();
    let mut sec_ndi = 0u32;
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
        let pick = pick_source(&sources, cfg.source_name.as_deref());
        let target = pick.index();
        // 沒挑到：正在接的如果還能留（手動指定的那個 / 這台電腦的）就留著
        // （AE 暫時從清單消失，NDI 會自己重連）；別台電腦的要斷開（例如剛從手動切回自動）
        if target.is_none() {
            let must_drop = recv
                .as_ref()
                .map_or(false, |r| !may_keep_receiver(&r.name, r.local, cfg.source_name.as_deref()));
            if must_drop {
                if let Some(old) = recv.take() {
                    info!("Auto mode never shows another computer's source → disconnected {}", old.name);
                }
                pacer.next_due = None;
                last_frame_at = None;
                shared.update(|s| {
                    s.connected = false;
                    s.receiving = false;
                    s.fps = 0.0;
                    s.ndi_fps = 0.0;
                    (s.width, s.height, s.out_width, s.out_height, s.downscale) = (0, 0, 0, 0, 0);
                    true
                });
            }
        }
        // 目前來源：挑到的；都沒有就維持正在接的（上面已經把不能留的斷開了）
        let target_name = target
            .map(|i| sources[i].name.clone())
            .or_else(|| recv.as_ref().map(|r| r.name.clone()));
        // 真的沒東西可接才報 no_source / no_local_source
        let want_err = if target_name.is_none() { no_source_error(pick, &sources) } else { None };
        shared.update(|s| {
            let mut changed = false;
            if s.source != target_name {
                s.source = target_name.clone();
                changed = true;
            }
            let is_ours = s
                .error
                .as_ref()
                .map_or(false, |e| e.code == "no_source" || e.code == "no_local_source");
            match want_err {
                // 不蓋掉 NDI 本身的錯誤；no_source ↔ no_local_source 會切換、來源數會更新；
                // 舊來源的 recv_failed 已經沒意義（沒有要接的來源了）→ 換成這個
                Some(e) => {
                    let replaceable = is_ours || s.error.as_ref().map_or(true, |x| x.code == "recv_failed");
                    if replaceable && s.error.as_ref() != Some(&e) {
                        s.error = Some(e);
                        changed = true;
                    }
                }
                None => {
                    if is_ours {
                        s.error = None;
                        changed = true;
                    }
                }
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
                            (s.width, s.height, s.out_width, s.out_height, s.downscale) = (0, 0, 0, 0, 0);
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

            // 編碼工人都在忙 → 這張跳過（不排隊）；有空才看限速
            let wanted = shared.frame_clients() > 0 && stride >= w * 4;
            if wanted && pool.try_reserve() {
                if !pacer.ready(now, interval) {
                    pool.release();
                } else {
                    // SAFETY: NDI 保證 p_data 有 stride * yres bytes，直到 free_video
                    let raw = unsafe { std::slice::from_raw_parts(vf.p_data, stride * h) };
                    let t0 = Instant::now();
                    let factor = downscale_factor(w, h, cfg.downsample, cfg.max_output_pixels as u64);
                    let lut = if cfg.limited_to_full { Some(limited_lut()) } else { None };
                    let (rgb, ow, oh) = shrink_to_rgb(raw, w, h, stride, factor, lut);
                    pool.stats.work_ns.fetch_add(t0.elapsed().as_nanos() as u64, Ordering::Relaxed);
                    if ow == 0 || oh == 0 {
                        pool.release();
                    } else {
                        seq += 1;
                        pool.submit(EncodeJob { seq, rgb, w: ow, h: oh });
                        if logged_size != Some((w, h, ow, oh)) {
                            logged_size = Some((w, h, ow, oh));
                            info!("NDI frame {w}×{h} → JPEG {ow}×{oh}（縮小 1/{factor}，品質 {quality}）");
                        }
                        shared.update(|s| {
                            let size = (w as u32, h as u32, ow as u32, oh as u32, factor as u32);
                            if (s.width, s.height, s.out_width, s.out_height, s.downscale) != size {
                                (s.width, s.height, s.out_width, s.out_height, s.downscale) = size;
                                true
                            } else {
                                false
                            }
                        });
                    }
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
            let sec_sent = pool.stats.sec_sent.swap(0, Ordering::Relaxed);
            let work_ns = pool.stats.work_ns.swap(0, Ordering::Relaxed);
            let (fps, ndi_fps) = (sec_sent as f32 / secs, sec_ndi as f32 / secs);
            let encode_ms = if sec_sent > 0 { work_ns as f32 / 1e6 / sec_sent as f32 } else { 0.0 };
            let frame_count = pool.stats.sent.load(Ordering::Relaxed);
            sec_start = now;
            sec_ndi = 0;
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

/// 縮小倍數上限（再大也只縮到 1/16）
const MAX_DOWNSCALE: usize = 16;

/// 送出去的畫面要縮成幾分之一（整數 1、2、3…）：
///   - downsample 關掉 → 1（永遠不縮）
///   - 開著 → 最小的 f，讓 (w/f)×(h/f) ≤ max_pixels；畫面本來就不大 → 1（原樣送，不會變糊）
/// 例（450 萬上限）：1920×1080、AE Third 的 2933×675、AE Half 的 4400×1012 → 1；
///   整張 8800×2024（1780 萬）→ 2；3840×2160（830 萬）→ 2；10496×5120（5370 萬）→ 4
pub fn downscale_factor(w: usize, h: usize, downsample: bool, max_pixels: u64) -> usize {
    if !downsample || w == 0 || h == 0 {
        return 1;
    }
    let max = max_pixels.max(1);
    let limit = MAX_DOWNSCALE.min(w).min(h);
    let mut f = 1;
    while f < limit && ((w / f) as u64) * ((h / f) as u64) > max {
        f += 1;
    }
    f
}

/// NDI 的 RGBA → 每 f×f 個像素平均成一個（f = 1 原樣）→（limited_to_full 才）拉色域 → RGB。
/// 輸出 (w/f)×(h/f)；除不盡的最右 / 最下幾個像素（最多 f-1）不要。
/// rayon：每個輸出 row 一個 task，跨核心同時跑。
pub fn shrink_to_rgb(
    raw: &[u8],
    w: usize,
    h: usize,
    stride: usize,
    f: usize,
    lut: Option<&[u8; 256]>,
) -> (Vec<u8>, usize, usize) {
    let f = f.clamp(1, w.min(h).max(1));
    let (ow, oh) = (w / f, h / f);
    let mut buf = vec![0u8; ow * oh * 3];
    if ow == 0 || oh == 0 {
        return (buf, ow, oh);
    }
    let map = |v: u8| match lut {
        Some(t) => t[v as usize],
        None => v,
    };
    if f == 1 {
        buf.par_chunks_exact_mut(ow * 3).enumerate().for_each(|(y, row)| {
            let src = &raw[y * stride..y * stride + w * 4];
            for (dst, px) in row.chunks_exact_mut(3).zip(src.chunks_exact(4)) {
                dst[0] = map(px[0]);
                dst[1] = map(px[1]);
                dst[2] = map(px[2]);
            }
        });
        return (buf, ow, oh);
    }
    let n = (f * f) as u32;
    let half = n / 2;
    buf.par_chunks_exact_mut(ow * 3).enumerate().for_each(|(y, row)| {
        // 先把 f 條來源 row 一條一條橫向加總到 acc（記憶體照順序讀，快取友善）
        let mut acc = vec![0u32; ow * 3];
        for sy in y * f..y * f + f {
            let src = &raw[sy * stride..sy * stride + ow * f * 4];
            for (a, block) in acc.chunks_exact_mut(3).zip(src.chunks_exact(f * 4)) {
                let (mut r, mut g, mut b) = (0u32, 0u32, 0u32);
                for px in block.chunks_exact(4) {
                    r += px[0] as u32;
                    g += px[1] as u32;
                    b += px[2] as u32;
                }
                a[0] += r;
                a[1] += g;
                a[2] += b;
            }
        }
        for (dst, a) in row.iter_mut().zip(acc.iter()) {
            // 四捨五入（以前是無條件捨去，整張會偏暗一點點）
            *dst = map(((a + half) / n) as u8);
        }
    });
    (buf, ow, oh)
}

/// JPEG 編碼器：品質照 config；色度不降取樣（4:4:4）— LED 內容常有銳利的彩色邊，4:2:0 會糊掉顏色
fn new_compressor(quality: u8) -> Result<turbojpeg::Compressor, String> {
    let mut c = turbojpeg::Compressor::new().map_err(|e| e.to_string())?;
    c.set_quality(quality.clamp(1, 100) as i32).map_err(|e| e.to_string())?;
    c.set_subsamp(turbojpeg::Subsamp::None).map_err(|e| e.to_string())?;
    Ok(c)
}

/// 一張編好的畫面（encode_frame 的結果）
#[cfg(test)]
struct Encoded {
    jpeg: Vec<u8>,
    out_w: usize,
    out_h: usize,
    factor: usize,
}

/// 同時編幾張 JPEG：大畫面（450 萬像素）一張 20–40 ms（JPEG 編碼只能單執行緒），
/// 兩個輪流編 → 中階筆電也能 30 fps；畫面小的時候一樣只用到一個
const ENCODER_THREADS: usize = 2;

/// 一張要編的畫面（已經縮小成 RGB）
struct EncodeJob {
    seq: u64,
    rgb: Vec<u8>,
    w: usize,
    h: usize,
}

#[derive(Default)]
struct EncodeStats {
    /// 送出幾張（累計）
    sent: AtomicU64,
    /// 縮小 + 編碼花的時間（奈秒，NDI 執行緒每秒拿走歸零）
    work_ns: AtomicU64,
    /// 這一秒送出幾張（NDI 執行緒每秒拿走歸零）
    sec_sent: AtomicU64,
    /// 最後送出的那張的編號（比它舊的編好也不送，畫面不會倒退）
    last_seq: AtomicU64,
}

/// JPEG 編碼工人：每個有自己的 turbojpeg；NDI 執行緒縮小完丟進來，編好直接送出去（output）。
/// 全部都在忙 → try_reserve 回 false → 這一張跳過（不排隊，延遲不會越積越多）
struct EncoderPool {
    tx: Option<std::sync::mpsc::Sender<EncodeJob>>,
    in_flight: Arc<AtomicUsize>,
    workers: usize,
    stats: Arc<EncodeStats>,
    threads: Vec<std::thread::JoinHandle<()>>,
}

impl EncoderPool {
    fn new(workers: usize, quality: u8, output: impl Fn(Vec<u8>) + Send + Sync + 'static) -> Result<Self, String> {
        let workers = workers.max(1);
        let (tx, rx) = std::sync::mpsc::channel::<EncodeJob>();
        let rx = Arc::new(std::sync::Mutex::new(rx));
        let output = Arc::new(output);
        let in_flight = Arc::new(AtomicUsize::new(0));
        let stats = Arc::new(EncodeStats::default());
        let mut threads = Vec::with_capacity(workers);
        for i in 0..workers {
            let mut compressor = new_compressor(quality)?;
            let (rx, output, in_flight, stats) = (rx.clone(), output.clone(), in_flight.clone(), stats.clone());
            let t = std::thread::Builder::new()
                .name(format!("jpeg-{i}"))
                .spawn(move || loop {
                    let job = match rx.lock().unwrap_or_else(|e| e.into_inner()).recv() {
                        Ok(j) => j,
                        Err(_) => break, // pool 收掉了
                    };
                    let t0 = Instant::now();
                    let img = turbojpeg::Image {
                        pixels: job.rgb.as_slice(),
                        width: job.w,
                        pitch: job.w * 3,
                        height: job.h,
                        format: turbojpeg::PixelFormat::RGB,
                    };
                    match compressor.compress_to_vec(img) {
                        Ok(jpeg) => {
                            stats.work_ns.fetch_add(t0.elapsed().as_nanos() as u64, Ordering::Relaxed);
                            // 另一個工人已經送了更新的 → 這張不送（不倒退）
                            if stats.last_seq.fetch_max(job.seq, Ordering::AcqRel) < job.seq {
                                output(jpeg);
                                stats.sent.fetch_add(1, Ordering::Relaxed);
                                stats.sec_sent.fetch_add(1, Ordering::Relaxed);
                            }
                        }
                        Err(e) => warn!("turbojpeg encode error: {e}"),
                    }
                    in_flight.fetch_sub(1, Ordering::AcqRel);
                })
                .map_err(|e| e.to_string())?;
            threads.push(t);
        }
        Ok(Self { tx: Some(tx), in_flight, workers, stats, threads })
    }

    /// 有空的工人 → 佔一個（之後一定要 submit 或 release）
    fn try_reserve(&self) -> bool {
        let mut cur = self.in_flight.load(Ordering::Acquire);
        while cur < self.workers {
            match self.in_flight.compare_exchange(cur, cur + 1, Ordering::AcqRel, Ordering::Acquire) {
                Ok(_) => return true,
                Err(now) => cur = now,
            }
        }
        false
    }

    fn release(&self) {
        self.in_flight.fetch_sub(1, Ordering::AcqRel);
    }

    fn submit(&self, job: EncodeJob) {
        match &self.tx {
            Some(tx) if tx.send(job).is_ok() => {}
            _ => self.release(),
        }
    }
}

impl Drop for EncoderPool {
    fn drop(&mut self) {
        self.tx.take(); // 工人收到 Err 就結束
        for t in self.threads.drain(..) {
            let _ = t.join();
        }
    }
}

/// RGBA → 縮小（太大才縮）→ limited→full（設定開著才做）→ RGB → JPEG（單張，測試 / 量測用；
/// 正式流程是 shrink_to_rgb 在 NDI 執行緒做、JPEG 交給 EncoderPool）
#[cfg(test)]
fn encode_frame(
    raw: &[u8],
    w: usize,
    h: usize,
    stride: usize,
    cfg: &Config,
    compressor: &mut turbojpeg::Compressor,
) -> Option<Encoded> {
    let factor = downscale_factor(w, h, cfg.downsample, cfg.max_output_pixels as u64);
    let lut = if cfg.limited_to_full { Some(limited_lut()) } else { None };
    let (out_buf, out_w, out_h) = shrink_to_rgb(raw, w, h, stride, factor, lut);
    if out_w == 0 || out_h == 0 {
        return None;
    }
    let img = turbojpeg::Image {
        pixels: out_buf.as_slice(),
        width: out_w,
        pitch: out_w * 3,
        height: out_h,
        format: turbojpeg::PixelFormat::RGB,
    };
    match compressor.compress_to_vec(img) {
        Ok(jpeg) => Some(Encoded { jpeg, out_w, out_h, factor }),
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
        assert_eq!(pick_source(&list, None), Pick::Source(2));
    }

    #[test]
    fn local_other_source_beats_remote_after_effects() {
        let list = vec![src("A (x)", false), src("B (Adobe After Effects)", false), src("ME (y)", true)];
        assert_eq!(pick_source(&list, None), Pick::Source(2));
    }

    #[test]
    fn auto_never_picks_another_computer() {
        // 辦公室：自己的 AE 沒在送，網路上只有同事的 AE → 不接，等（no_local_source）
        let list = vec![src("TERRYGRACOMPANY (Adobe After Effects)", false)];
        assert_eq!(pick_source(&list, None), Pick::NoLocal);
        let list = vec![src("A (x)", false), src("B (Adobe After Effects)", false)];
        assert_eq!(pick_source(&list, None), Pick::NoLocal);
        assert_eq!(pick_source(&list, Some("")), Pick::NoLocal);
        assert_eq!(pick_source(&[], None), Pick::NoSource);
    }

    #[test]
    fn manual_choice_can_be_another_computer() {
        let list = vec![src("ME (Adobe After Effects)", true), src("B (y)", false)];
        assert_eq!(pick_source(&list, Some("B (y)")), Pick::Source(1));
        assert_eq!(pick_source(&list, Some("b (Y)")), Pick::Source(1));
        let list = vec![src("TERRYGRACOMPANY (Adobe After Effects)", false)];
        assert_eq!(pick_source(&list, Some("TERRYGRACOMPANY (Adobe After Effects)")), Pick::Source(0));
    }

    #[test]
    fn manual_choice_offline_falls_back_to_local_only() {
        // 手動選的（自己的 AE）不在線 → 照自動規則，但一樣只接這台電腦的
        let list = vec![src("TERRYGRACOMPANY (Adobe After Effects)", false)];
        assert_eq!(pick_source(&list, Some("ULTRA9-285K (Adobe After Effects)")), Pick::NoLocal);
        let list = vec![src("OTHER (Adobe After Effects)", false), src("ME (Test Pattern)", true)];
        assert_eq!(pick_source(&list, Some("GONE (z)")), Pick::Source(1));
        assert_eq!(pick_source(&[], Some("GONE (z)")), Pick::NoSource);
    }

    #[test]
    fn keeps_receiver_only_if_local_or_chosen() {
        // AE 暫時從清單消失：本機的 / 手動選的留著（NDI 會自己重連）
        assert!(may_keep_receiver("ME (Adobe After Effects)", true, None));
        assert!(may_keep_receiver("B (Adobe After Effects)", false, Some("B (Adobe After Effects)")));
        assert!(may_keep_receiver("B (Adobe After Effects)", false, Some("b (adobe after effects) ")));
        // 別台電腦的、沒有手動選它（例如剛切回自動）→ 斷開
        assert!(!may_keep_receiver("B (Adobe After Effects)", false, None));
        assert!(!may_keep_receiver("B (Adobe After Effects)", false, Some("ME (Adobe After Effects)")));
    }

    #[test]
    fn error_codes_for_no_source() {
        let remote = vec![src("A (Adobe After Effects)", false), src("B (y)", false)];
        let e = no_source_error(pick_source(&remote, None), &remote).unwrap();
        assert_eq!(e.code, "no_local_source");
        assert!(e.message.contains('2'), "{}", e.message);
        let e = no_source_error(pick_source(&[], None), &[]).unwrap();
        assert_eq!(e.code, "no_source");
        let local = vec![src("ME (Adobe After Effects)", true)];
        assert_eq!(no_source_error(pick_source(&local, None), &local), None);
    }

    #[test]
    fn local_detection() {
        let id = LocalIdentity { hosts: vec!["ultra9-285k".into()], ips: vec!["192.168.1.5".parse().unwrap()] };
        assert!(id.is_local("ULTRA9-285K (Adobe After Effects)", None));
        assert!(id.is_local("Ultra9-285K.local (x)", None));
        assert!(!id.is_local("TERRYGRACOMPANY (Adobe After Effects)", None));
        assert!(!id.is_local("OTHER (Adobe After Effects)", Some("192.168.1.9:5961")));
        assert!(id.is_local("OTHER (x)", Some("192.168.1.5:5961")));
        assert!(id.is_local("OTHER (x)", Some("127.0.0.1:5961")));
        // Windows 電腦名稱超過 15 字：hostname 跟 COMPUTERNAME 不一樣，兩個都算
        let id = LocalIdentity { hosts: vec!["studio-workstation-01".into(), "studio-workstat".into()], ips: vec![] };
        assert!(id.is_local("STUDIO-WORKSTAT (Adobe After Effects)", None));
        assert!(id.is_local("STUDIO-WORKSTATION-01 (Adobe After Effects)", None));
        // 沒有名稱也不會把空字串當成本機
        let id = LocalIdentity { hosts: vec![], ips: vec![] };
        assert!(!id.is_local(" (x)", None));
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

    // ── 縮小 / JPEG ──

    const BUDGET: u64 = crate::config::DEFAULT_MAX_OUTPUT_PIXELS as u64;

    #[test]
    fn small_frames_pass_through_untouched() {
        // 本來就不大 → 原樣送（不會變糊）
        assert_eq!(downscale_factor(1920, 1080, true, BUDGET), 1);
        assert_eq!(downscale_factor(2933, 675, true, BUDGET), 1, "8800×2024 用 AE Third");
        assert_eq!(downscale_factor(4400, 1012, true, BUDGET), 1, "8800×2024 用 AE Half");
        assert_eq!(downscale_factor(2200, 506, true, BUDGET), 1, "8800×2024 用 AE Quarter");
        assert_eq!(downscale_factor(1, 1, true, BUDGET), 1);
    }

    #[test]
    fn big_frames_get_smallest_integer_factor() {
        assert_eq!(downscale_factor(8800, 2024, true, BUDGET), 2, "整張 8800×2024 → 4400×1012");
        assert_eq!(downscale_factor(3840, 2160, true, BUDGET), 2);
        assert_eq!(downscale_factor(5248, 2560, true, BUDGET), 2, "10496×5120 用 AE Half");
        assert_eq!(downscale_factor(3499, 1707, true, BUDGET), 2, "10496×5120 用 AE Third（600 萬）");
        assert_eq!(downscale_factor(10496, 5120, true, BUDGET), 4);
        // 上限 400 萬時（README 的例子）：整張 8800×2024 → 1/3
        assert_eq!(downscale_factor(8800, 2024, true, 4_000_000), 3);
        assert_eq!(downscale_factor(2933, 675, true, 4_000_000), 1);
        // 每個 f 都是「剛好不超過」：f-1 會超過
        for (w, h) in [(8800, 2024), (10496, 5120), (7680, 4320), (32768, 1080)] {
            let f = downscale_factor(w, h, true, BUDGET);
            assert!(((w / f) * (h / f)) as u64 <= BUDGET, "{w}×{h} ÷{f}");
            if f > 1 {
                assert!(((w / (f - 1)) * (h / (f - 1))) as u64 > BUDGET, "{w}×{h} ÷{f} 不是最小");
            }
        }
    }

    #[test]
    fn downsample_off_never_shrinks() {
        assert_eq!(downscale_factor(8800, 2024, false, BUDGET), 1);
        assert_eq!(downscale_factor(32768, 32768, false, 1), 1);
    }

    #[test]
    fn factor_never_makes_empty_frames() {
        // 很細長的畫面：寬高都至少 1
        let f = downscale_factor(30000, 3, true, 10);
        assert!(f <= 3);
        assert_eq!(downscale_factor(100_000, 1, true, 10), 1);
        assert!(downscale_factor(1 << 20, 1 << 20, true, 1) <= MAX_DOWNSCALE);
    }

    /// RGBA 測試畫面（stride 可以比 w*4 大，跟 NDI 一樣）
    fn rgba(w: usize, h: usize, stride: usize, f: impl Fn(usize, usize) -> [u8; 3]) -> Vec<u8> {
        let mut v = vec![0u8; stride * h];
        for y in 0..h {
            for x in 0..w {
                let [r, g, b] = f(x, y);
                let o = y * stride + x * 4;
                v[o..o + 4].copy_from_slice(&[r, g, b, 255]);
            }
        }
        v
    }

    #[test]
    fn shrink_factor_1_is_exact_copy() {
        let (w, h, stride) = (7, 3, 7 * 4 + 12);
        let raw = rgba(w, h, stride, |x, y| [(x * 30) as u8, (y * 80) as u8, 200]);
        let (out, ow, oh) = shrink_to_rgb(&raw, w, h, stride, 1, None);
        assert_eq!((ow, oh), (7, 3));
        for y in 0..h {
            for x in 0..w {
                let o = (y * w + x) * 3;
                assert_eq!(&out[o..o + 3], &[(x * 30) as u8, (y * 80) as u8, 200]);
            }
        }
    }

    #[test]
    fn shrink_box_filter_averages_and_rounds() {
        // 3×3 方塊平均：一格裡 0..8 → 平均 4；一黑一白交錯 → 四捨五入（不是無條件捨去）
        let (w, h) = (7, 6); // 除以 3 → 2×2，最右邊一行不要
        let raw = rgba(w, h, w * 4, |x, y| {
            let i = ((y % 3) * 3 + (x % 3)) as u8;
            [i * 10, if (x + y) % 2 == 0 { 255 } else { 0 }, 128]
        });
        let (out, ow, oh) = shrink_to_rgb(&raw, w, h, w * 4, 3, None);
        assert_eq!((ow, oh), (2, 2));
        for px in out.chunks_exact(3) {
            assert_eq!(px[0], 40); // (0+10+…+80)/9
            assert!(px[1] == 142 || px[1] == 113, "{}", px[1]); // 5×255/9 = 141.7 → 142；4×255/9 = 113.3 → 113
            assert_eq!(px[2], 128);
        }
        // 2x：(255+255+0+0)/4 = 127.5 → 128（以前 >>2 = 127）
        let raw = rgba(2, 2, 8, |_, y| if y == 0 { [255; 3] } else { [0; 3] });
        let (out, _, _) = shrink_to_rgb(&raw, 2, 2, 8, 2, None);
        assert_eq!(out, vec![128, 128, 128]);
    }

    #[test]
    fn shrink_applies_lut_only_when_given() {
        let raw = rgba(2, 1, 8, |_, _| [16, 235, 128]);
        let (out, _, _) = shrink_to_rgb(&raw, 2, 1, 8, 1, None);
        assert_eq!(out, vec![16, 235, 128, 16, 235, 128]);
        let (out, _, _) = shrink_to_rgb(&raw, 2, 1, 8, 1, Some(limited_lut()));
        assert_eq!(&out[..3], &[0, 255, limited_to_full(128)]);
    }

    /// 從 JPEG 讀出：每個色版的取樣（4:4:4 = 全部 0x11）、第一張量化表的 DC 值
    fn jpeg_info(jpeg: &[u8]) -> (Vec<u8>, u8) {
        let (mut sampling, mut dc) = (Vec::new(), 0u8);
        let mut i = 2;
        while i + 4 <= jpeg.len() {
            assert_eq!(jpeg[i], 0xFF, "marker");
            let m = jpeg[i + 1];
            let len = ((jpeg[i + 2] as usize) << 8) | jpeg[i + 3] as usize;
            let seg = &jpeg[i + 4..i + 2 + len];
            match m {
                0xDB if dc == 0 => dc = seg[1], // Pq/Tq, 然後 64 個值（第一個是 DC）
                0xC0 | 0xC1 | 0xC2 => {
                    let n = seg[5] as usize;
                    sampling = (0..n).map(|c| seg[6 + c * 3 + 1]).collect();
                }
                0xDA => break,
                _ => {}
            }
            i += 2 + len;
        }
        (sampling, dc)
    }

    #[test]
    fn jpeg_is_quality_90_and_444() {
        let cfg = Config::default();
        let (w, h) = (64, 32);
        let raw = rgba(w, h, w * 4, |x, y| if (x / 8 + y / 8) % 2 == 0 { [255, 0, 0] } else { [0, 0, 255] });
        let mut c = new_compressor(cfg.jpeg_quality).unwrap();
        let enc = encode_frame(&raw, w, h, w * 4, &cfg, &mut c).unwrap();
        assert_eq!((enc.out_w, enc.out_h, enc.factor), (64, 32, 1));
        let (sampling, dc) = jpeg_info(&enc.jpeg);
        assert_eq!(sampling, vec![0x11, 0x11, 0x11], "4:4:4（色度不降取樣）");
        // libjpeg 的品質縮放：q90 → 亮度 DC 16×(200-180)/100 = 3.2 → 3；q75 → 8
        assert_eq!(dc, 3);
        let mut c75 = new_compressor(75).unwrap();
        let enc75 = encode_frame(&raw, w, h, w * 4, &cfg, &mut c75).unwrap();
        assert_eq!(jpeg_info(&enc75.jpeg).1, 8);
        // 解回來的尺寸對
        let header = turbojpeg::read_header(&enc.jpeg).unwrap();
        assert_eq!((header.width, header.height), (64, 32));
    }

    #[test]
    fn encode_reports_factor_and_size() {
        let cfg = Config { max_output_pixels: 100, ..Config::default() };
        let (w, h) = (40, 21);
        let raw = rgba(w, h, w * 4 + 16, |x, _| [x as u8 * 6, 0, 0]);
        let mut c = new_compressor(90).unwrap();
        let enc = encode_frame(&raw, w, h, w * 4 + 16, &cfg, &mut c).unwrap();
        // 40×21 = 840 > 100 → ÷3 = 13×7 = 91
        assert_eq!((enc.factor, enc.out_w, enc.out_h), (3, 13, 7));
        let header = turbojpeg::read_header(&enc.jpeg).unwrap();
        assert_eq!((header.width, header.height), (13, 7));
        let off = Config { downsample: false, ..cfg };
        let enc = encode_frame(&raw, w, h, w * 4 + 16, &off, &mut c).unwrap();
        assert_eq!((enc.factor, enc.out_w, enc.out_h), (1, 40, 21));
    }

    fn wait_idle(pool: &EncoderPool) {
        let t = Instant::now();
        while pool.in_flight.load(Ordering::Acquire) > 0 {
            assert!(t.elapsed() < Duration::from_secs(10), "編碼工人卡住");
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    #[test]
    fn encoder_pool_limits_in_flight_and_never_goes_backwards() {
        let got = Arc::new(std::sync::Mutex::new(Vec::<(usize, usize)>::new()));
        let g = got.clone();
        let pool = EncoderPool::new(2, 90, move |jpeg| {
            let h = turbojpeg::read_header(&jpeg).unwrap();
            g.lock().unwrap().push((h.width, h.height));
        })
        .unwrap();
        // 兩個工人：最多佔兩個，第三個不排隊
        assert!(pool.try_reserve());
        assert!(pool.try_reserve());
        assert!(!pool.try_reserve(), "兩個都在忙 → 跳過這張");
        pool.release();
        pool.release();
        let job = |seq: u64, w: usize| EncodeJob { seq, rgb: vec![128; w * 8 * 3], w, h: 8 };
        assert!(pool.try_reserve());
        pool.submit(job(1, 16));
        wait_idle(&pool);
        assert!(pool.try_reserve());
        pool.submit(job(3, 24));
        wait_idle(&pool);
        // 比已經送出的舊（另一個工人比較慢才編好）→ 不送，畫面不倒退
        assert!(pool.try_reserve());
        pool.submit(job(2, 32));
        wait_idle(&pool);
        assert_eq!(*got.lock().unwrap(), vec![(16, 8), (24, 8)]);
        assert_eq!(pool.stats.sent.load(Ordering::Relaxed), 2);
        assert!(pool.stats.work_ns.load(Ordering::Relaxed) > 0);
    }

    #[test]
    fn encoder_pool_shuts_down_cleanly() {
        let pool = EncoderPool::new(2, 90, |_| {}).unwrap();
        assert!(pool.try_reserve());
        pool.submit(EncodeJob { seq: 1, rgb: vec![0; 8 * 8 * 3], w: 8, h: 8 });
        drop(pool); // join 工人，不會卡住
    }

    /// 像 LED 內容的測試畫面：漸層 + 彩色硬邊 + 細線 + 一點雜訊（雜訊會讓 JPEG 變慢，比較保守）
    fn led_like(w: usize, h: usize) -> Vec<u8> {
        let mut seed = 0x1234_5678u32;
        let mut noise = move || {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            ((seed >> 24) as i32 % 13) - 6
        };
        let mut v = vec![0u8; w * h * 4];
        for y in 0..h {
            for x in 0..w {
                let bar = (x * 8 / w.max(1)) as u8;
                let mut px = [
                    (x * 255 / w.max(1)) as i32,
                    (y * 255 / h.max(1)) as i32,
                    if bar % 2 == 0 { 230 } else { 20 },
                ];
                if (x / 37 + y / 23) % 5 == 0 {
                    px = [255, 40, 200]; // 彩色方塊
                }
                if x % 97 < 2 || y % 61 < 2 {
                    px = [255, 255, 255]; // 細線
                }
                let o = (y * w + x) * 4;
                for c in 0..3 {
                    v[o + c] = (px[c] + noise()).clamp(0, 255) as u8;
                }
                v[o + 3] = 255;
            }
        }
        v
    }

    fn median_ms(mut f: impl FnMut(), runs: usize) -> f64 {
        f(); // 暖機
        let mut t: Vec<f64> = (0..runs)
            .map(|_| {
                let s = Instant::now();
                f();
                s.elapsed().as_secs_f64() * 1000.0
            })
            .collect();
        t.sort_by(|a, b| a.partial_cmp(b).unwrap());
        t[t.len() / 2]
    }

    /// 量測（不是一般測試）：cargo test --release -- --ignored --nocapture encode_benchmark
    #[test]
    #[ignore]
    fn encode_benchmark() {
        println!("\n— JPEG 編碼（單執行緒，turbojpeg）每張毫秒 / KB —");
        for (w, h) in [(1920usize, 1080usize), (2933, 675), (2667, 1500), (4400, 1012)] {
            let raw = led_like(w, h);
            let (rgb, _, _) = shrink_to_rgb(&raw, w, h, w * 4, 1, None);
            for (q, sub, label) in [
                (75, turbojpeg::Subsamp::Sub2x2, "q75 4:2:0"),
                (75, turbojpeg::Subsamp::None, "q75 4:4:4"),
                (90, turbojpeg::Subsamp::Sub2x2, "q90 4:2:0"),
                (90, turbojpeg::Subsamp::None, "q90 4:4:4"),
            ] {
                let mut c = turbojpeg::Compressor::new().unwrap();
                c.set_quality(q).unwrap();
                c.set_subsamp(sub).unwrap();
                let mut size = 0;
                let ms = median_ms(
                    || {
                        let img = turbojpeg::Image { pixels: rgb.as_slice(), width: w, pitch: w * 3, height: h, format: turbojpeg::PixelFormat::RGB };
                        size = c.compress_to_vec(img).unwrap().len();
                    },
                    15,
                );
                println!("{w}×{h} ({:.1} MP) {label}: {ms:.1} ms, {} KB", (w * h) as f64 / 1e6, size / 1024);
            }
        }
        println!("\n— 整條（縮小 + 色彩 + JPEG q90 4:4:4）—");
        let cfg = Config::default();
        for (w, h, budget) in [
            (2933usize, 675usize, BUDGET),
            (4400, 1012, BUDGET),
            (8800, 2024, BUDGET),
            (8800, 2024, 4_000_000),
            (3840, 2160, BUDGET),
        ] {
            let raw = led_like(w, h);
            let cfg = Config { max_output_pixels: budget as u32, ..cfg.clone() };
            let mut c = new_compressor(90).unwrap();
            let mut out = (0, 0, 0);
            let ms = median_ms(
                || {
                    let e = encode_frame(&raw, w, h, w * 4, &cfg, &mut c).unwrap();
                    out = (e.out_w, e.out_h, e.factor);
                },
                11,
            );
            let shrink = median_ms(
                || {
                    let f = downscale_factor(w, h, true, budget);
                    std::hint::black_box(shrink_to_rgb(&raw, w, h, w * 4, f, None));
                },
                11,
            );
            println!(
                "{w}×{h} 上限 {:.1} MP → {}×{} (÷{}): {ms:.1} ms（其中縮小 {shrink:.1} ms）",
                budget as f64 / 1e6, out.0, out.1, out.2
            );
        }
        println!("（舊版：8800×2024 固定縮一半 q75 4:4:4 + limited→full）");
        let raw = led_like(8800, 2024);
        let mut c = new_compressor(75).unwrap();
        let ms = median_ms(
            || {
                let (rgb, ow, oh) = shrink_to_rgb(&raw, 8800, 2024, 8800 * 4, 2, Some(limited_lut()));
                let img = turbojpeg::Image { pixels: rgb.as_slice(), width: ow, pitch: ow * 3, height: oh, format: turbojpeg::PixelFormat::RGB };
                std::hint::black_box(c.compress_to_vec(img).unwrap());
            },
            11,
        );
        println!("8800×2024 → 4400×1012 q75: {ms:.1} ms");

        println!("\n— 每秒最多編幾張（q90 4:4:4，一直丟畫面進去 2 秒）—");
        for (w, h) in [(2933usize, 675usize), (4400, 1012)] {
            let raw = led_like(w, h);
            let (rgb, _, _) = shrink_to_rgb(&raw, w, h, w * 4, 1, None);
            for workers in [1usize, 2] {
                let pool = EncoderPool::new(workers, 90, |_| {}).unwrap();
                let t0 = Instant::now();
                let mut seq = 0;
                while t0.elapsed() < Duration::from_secs(2) {
                    if pool.try_reserve() {
                        seq += 1;
                        pool.submit(EncodeJob { seq, rgb: rgb.clone(), w, h });
                    } else {
                        std::thread::sleep(Duration::from_micros(200));
                    }
                }
                wait_idle(&pool);
                let fps = pool.stats.sent.load(Ordering::Relaxed) as f64 / t0.elapsed().as_secs_f64();
                println!("{w}×{h}，{workers} 個編碼工人：{fps:.0} 張/秒");
            }
        }
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
