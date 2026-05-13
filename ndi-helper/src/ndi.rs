// NDI receiver（FFI to Processing.NDI.Lib.x64.dll via libloading）
//
// 為何不用既有 ndi-rs crate？
//   - 它要求 build-time link，DLL 路徑寫死。我們要在 runtime 找 NDI Tools 安裝路徑，
//     沒裝就提示用戶，比較友善。
//   - 同樣方式跟 Electron 版的 koffi 對應（ndi-receiver.js），易移植。
//
// NDI SDK API 我們只用四個函式：
//   NDIlib_initialize()
//   NDIlib_find_create_v2 + find_get_current_sources + find_destroy
//   NDIlib_recv_create_v3 + recv_capture_v2 + recv_destroy + recv_free_video_v2
//
// 一旦拿到 BGRA frame：
//   1. (optional) 2x downsample（簡單 box filter，純 Rust 跑）
//   2. (optional) limited (16..235) → full (0..255) per channel
//   3. turbojpeg encode（質量 cfg.jpeg_quality）
//   4. broadcast 到 ws clients（payload 格式：JSON header + binary JPEG，見下）
//
// WebSocket payload 格式：
//   text frame：{"type":"frame","width":W,"height":H,"ts":epoch_ms} + 同時送 binary frame (JPEG bytes)
//   或更簡單：直接送 binary JPEG，前端用 Blob → ImageBitmap 解；header 透過初次連線送 metadata。
//   為了極簡，我們 binary-only：每幀一個 binary message = JPEG bytes。寬高用 sniff 即可（或附在開頭）。
//
// 簡化決定：每個 binary frame = JPEG bytes。前端 ImageDecoder/createImageBitmap 自己解析寬高。

use crate::HelperState;
use crate::config::Config;
use libloading::{Library, Symbol};
use log::{debug, info, warn};
use std::ffi::{c_int, c_void, CStr};
use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};

// NDI SDK structs（只列我們用到的欄位）
#[repr(C)]
#[derive(Clone, Copy)]
pub struct NDIlibSourceT {
    pub p_ndi_name: *const i8,
    pub p_url_address: *const i8,
}

#[repr(C)]
pub struct NDIlibRecvCreateV3T {
    pub source_to_connect_to: NDIlibSourceT,
    pub color_format: c_int,
    pub bandwidth: c_int,
    pub allow_video_fields: bool,
    pub p_ndi_recv_name: *const i8,
}

#[repr(C)]
pub struct NDIlibVideoFrameV2T {
    pub xres: c_int,
    pub yres: c_int,
    pub fourcc: c_int,
    pub frame_rate_n: c_int,
    pub frame_rate_d: c_int,
    pub picture_aspect_ratio: f32,
    pub frame_format_type: c_int,
    pub timecode: i64,
    pub p_data: *mut u8,
    pub line_stride_in_bytes: c_int,
    pub p_metadata: *const i8,
    pub timestamp: i64,
}

const NDILIB_FRAME_TYPE_NONE: c_int = 0;
const NDILIB_FRAME_TYPE_VIDEO: c_int = 1;
const NDILIB_RECV_BANDWIDTH_HIGHEST: c_int = 100;
const NDILIB_RECV_COLOR_FORMAT_BGRX_BGRA: c_int = 2; // BGRA / BGRX

type NDIlib_initialize_t = unsafe extern "C" fn() -> bool;
type NDIlib_find_create_v2_t = unsafe extern "C" fn(*const c_void) -> *mut c_void;
type NDIlib_find_get_current_sources_t =
    unsafe extern "C" fn(*mut c_void, *mut u32) -> *const NDIlibSourceT;
type NDIlib_find_destroy_t = unsafe extern "C" fn(*mut c_void);
type NDIlib_recv_create_v3_t = unsafe extern "C" fn(*const NDIlibRecvCreateV3T) -> *mut c_void;
type NDIlib_recv_capture_v2_t = unsafe extern "C" fn(
    *mut c_void,
    *mut NDIlibVideoFrameV2T,
    *mut c_void, // audio frame
    *mut c_void, // metadata
    u32,         // timeout_ms
) -> c_int;
type NDIlib_recv_destroy_t = unsafe extern "C" fn(*mut c_void);
type NDIlib_recv_free_video_v2_t = unsafe extern "C" fn(*mut c_void, *mut NDIlibVideoFrameV2T);

#[derive(Debug)]
pub enum NdiError {
    DllNotFound(String),
    SymbolMissing(String),
    InitFailed,
    RecvCreateFailed,
    NoSource,
}

impl std::fmt::Display for NdiError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            NdiError::DllNotFound(p) => write!(f, "NDI DLL not found（請安裝 NDI Tools 或設 NDI_RUNTIME_DIR_V5 環境變數）：{p}"),
            NdiError::SymbolMissing(s) => write!(f, "NDI DLL 缺少符號：{s}"),
            NdiError::InitFailed => write!(f, "NDI initialize 失敗（CPU 不支援 SSE2/AVX？）"),
            NdiError::RecvCreateFailed => write!(f, "NDI recv 建立失敗"),
            NdiError::NoSource => write!(f, "找不到 NDI source（AE 沒開 NDI output？）"),
        }
    }
}

impl std::error::Error for NdiError {}

fn find_ndi_dll() -> Result<std::path::PathBuf, NdiError> {
    // 1. 環境變數（NDI 5+ 標準）
    for env_var in &["NDI_RUNTIME_DIR_V5", "NDI_RUNTIME_DIR_V4"] {
        if let Ok(dir) = std::env::var(env_var) {
            let p = std::path::PathBuf::from(dir).join(if cfg!(target_os = "windows") {
                "Processing.NDI.Lib.x64.dll"
            } else if cfg!(target_os = "macos") {
                "libndi.dylib"
            } else {
                "libndi.so.5"
            });
            if p.exists() {
                return Ok(p);
            }
        }
    }
    // 2. Windows: NDI Tools 預設安裝路徑
    if cfg!(target_os = "windows") {
        for base in [
            "C:\\Program Files\\NDI\\NDI 6 SDK\\Bin\\x64",
            "C:\\Program Files\\NDI\\NDI 6 Runtime\\v6",
            "C:\\Program Files\\NDI\\NDI 5 SDK\\Bin\\x64",
            "C:\\Program Files\\NDI\\NDI 5 Runtime\\v5",
            "C:\\Program Files\\NewTek\\NDI 5 Runtime\\v5",
            "C:\\Program Files\\NewTek\\NDI 4 Runtime\\v4",
        ] {
            let p = std::path::PathBuf::from(base).join("Processing.NDI.Lib.x64.dll");
            if p.exists() {
                return Ok(p);
            }
        }
    }
    // 3. macOS: 預設 Frameworks
    if cfg!(target_os = "macos") {
        for base in [
            "/Library/NDI SDK for Apple/lib/x64",
            "/Library/Frameworks",
        ] {
            let p = std::path::PathBuf::from(base).join("libndi.dylib");
            if p.exists() {
                return Ok(p);
            }
        }
    }
    // 4. Linux: /usr/lib/x86_64-linux-gnu
    if cfg!(target_os = "linux") {
        for p in [
            "/usr/lib/x86_64-linux-gnu/libndi.so.5",
            "/usr/lib/libndi.so.5",
            "/usr/local/lib/libndi.so.5",
        ] {
            let pb = std::path::PathBuf::from(p);
            if pb.exists() {
                return Ok(pb);
            }
        }
    }
    Err(NdiError::DllNotFound(
        "請去 https://www.ndi.tv/tools/ 裝 NDI Tools".into(),
    ))
}

pub async fn run_receiver(
    cfg: &Config,
    tx: &broadcast::Sender<Arc<Vec<u8>>>,
    state: &Arc<RwLock<HelperState>>,
) -> Result<(), NdiError> {
    let dll_path = find_ndi_dll()?;
    info!("Loading NDI DLL from {}", dll_path.display());

    // SAFETY: 動態載入 NDI DLL；ABI = C；只有此檔案使用
    let lib = unsafe {
        Library::new(&dll_path).map_err(|e| NdiError::DllNotFound(format!("{}: {e}", dll_path.display())))?
    };

    macro_rules! sym {
        ($name:literal, $ty:ty) => {{
            let s: Symbol<$ty> = unsafe { lib.get($name) }
                .map_err(|_| NdiError::SymbolMissing(
                    String::from_utf8_lossy($name).trim_end_matches('\0').to_string()
                ))?;
            *s
        }};
    }

    let ndi_init = sym!(b"NDIlib_initialize\0", NDIlib_initialize_t);
    let find_create = sym!(b"NDIlib_find_create_v2\0", NDIlib_find_create_v2_t);
    let find_get = sym!(b"NDIlib_find_get_current_sources\0", NDIlib_find_get_current_sources_t);
    let find_destroy = sym!(b"NDIlib_find_destroy\0", NDIlib_find_destroy_t);
    let recv_create = sym!(b"NDIlib_recv_create_v3\0", NDIlib_recv_create_v3_t);
    let recv_capture = sym!(b"NDIlib_recv_capture_v2\0", NDIlib_recv_capture_v2_t);
    let recv_destroy = sym!(b"NDIlib_recv_destroy\0", NDIlib_recv_destroy_t);
    let recv_free_video = sym!(b"NDIlib_recv_free_video_v2\0", NDIlib_recv_free_video_v2_t);

    if !unsafe { ndi_init() } {
        return Err(NdiError::InitFailed);
    }

    // Find sources
    let finder = unsafe { find_create(std::ptr::null()) };
    if finder.is_null() {
        return Err(NdiError::InitFailed);
    }

    // 等 5 秒讓 finder 找到 sources
    info!("Searching for NDI sources (5s)...");
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;

    let mut count: u32 = 0;
    let sources_ptr = unsafe { find_get(finder, &mut count) };
    if sources_ptr.is_null() || count == 0 {
        unsafe { find_destroy(finder) };
        return Err(NdiError::NoSource);
    }

    let sources = unsafe { std::slice::from_raw_parts(sources_ptr, count as usize) };
    let mut chosen: Option<NDIlibSourceT> = None;
    let mut chosen_name = String::new();
    let mut all_names: Vec<String> = Vec::with_capacity(count as usize);
    // 用戶透過 WS 指定的 source 優先
    let requested = state.read().await.requested_source.clone();
    let preferred = requested.as_ref().or(cfg.source_name.as_ref()).cloned();

    for s in sources {
        let name = unsafe { CStr::from_ptr(s.p_ndi_name) }
            .to_string_lossy()
            .into_owned();
        info!("Found NDI source: {name}");
        all_names.push(name.clone());
        if let Some(ref want) = preferred {
            if &name == want {
                chosen = Some(*s);
                chosen_name = name;
                break;
            }
        } else if chosen.is_none() {
            chosen = Some(*s);
            chosen_name = name;
        }
    }
    {
        let mut s = state.write().await;
        s.available_sources = all_names;
    }
    let chosen = match chosen {
        Some(c) => c,
        None => {
            unsafe { find_destroy(finder) };
            return Err(NdiError::NoSource);
        }
    };
    info!("Connecting to NDI source: {chosen_name}");
    {
        let mut s = state.write().await;
        s.source_name = Some(chosen_name.clone());
        s.last_error = None;
    }

    // Create receiver
    let recv_name = b"stage-previz-ndi-helper\0";
    let recv_desc = NDIlibRecvCreateV3T {
        source_to_connect_to: chosen,
        color_format: NDILIB_RECV_COLOR_FORMAT_BGRX_BGRA,
        bandwidth: NDILIB_RECV_BANDWIDTH_HIGHEST,
        allow_video_fields: false,
        p_ndi_recv_name: recv_name.as_ptr() as *const i8,
    };
    let recv = unsafe { recv_create(&recv_desc) };
    unsafe { find_destroy(finder) };
    if recv.is_null() {
        return Err(NdiError::RecvCreateFailed);
    }

    let mut frame_count: u64 = 0;
    let mut last_fps_t = std::time::Instant::now();
    let mut fps_frames = 0u32;
    let connected_to = chosen_name.clone();

    // Encoder：turbojpeg compressor，重複用
    let mut compressor = match turbojpeg::Compressor::new() {
        Ok(c) => c,
        Err(e) => {
            warn!("turbojpeg compressor init failed: {e}; running without encoding");
            return Ok(());
        }
    };
    let _ = compressor.set_quality(cfg.jpeg_quality as i32);

    loop {
        let mut video_frame: NDIlibVideoFrameV2T = unsafe { std::mem::zeroed() };
        let frame_type = unsafe {
            recv_capture(
                recv,
                &mut video_frame,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                100, // timeout 100ms
            )
        };

        if frame_type == NDILIB_FRAME_TYPE_VIDEO && !video_frame.p_data.is_null() {
            let w = video_frame.xres as usize;
            let h = video_frame.yres as usize;
            let stride = video_frame.line_stride_in_bytes as usize;
            // BGRA = 4 bytes per pixel
            let raw = unsafe {
                std::slice::from_raw_parts(video_frame.p_data, stride * h)
            };
            let raw_owned = raw.to_vec(); // copy 出來，馬上 free 給 NDI
            unsafe { recv_free_video(recv, &mut video_frame) };

            // 處理 + encode
            let payload = encode_frame(&raw_owned, w, h, stride, cfg, &mut compressor);
            if let Some(jpeg) = payload {
                let bytes = Arc::new(jpeg);
                if tx.send(bytes).is_err() {
                    debug!("no ws clients, frame dropped");
                }
                frame_count += 1;
                fps_frames += 1;
            }

            // 每 1 秒更新 fps
            let now = std::time::Instant::now();
            if now.duration_since(last_fps_t).as_secs_f32() >= 1.0 {
                let fps = fps_frames as f32 / now.duration_since(last_fps_t).as_secs_f32();
                let mut s = state.write().await;
                s.frame_count = frame_count;
                s.fps = fps;
                last_fps_t = now;
                fps_frames = 0;
            }
        } else if frame_type == NDILIB_FRAME_TYPE_NONE {
            // 檢查瀏覽器有沒有要求換 source；有就退出（main 會 5s 後重啟 receiver）
            let want = state.read().await.requested_source.clone();
            if let Some(want_name) = want {
                if want_name != connected_to {
                    info!("Source change requested: {connected_to} → {want_name}; restarting receiver");
                    unsafe { recv_destroy(recv) };
                    return Ok(());
                }
            }
            tokio::task::yield_now().await;
        }
    }

    // Unreachable in normal flow; cleanup happens via process exit
    #[allow(unreachable_code)]
    {
        unsafe { recv_destroy(recv) };
        Ok(())
    }
}

fn encode_frame(
    raw: &[u8],
    w: usize,
    h: usize,
    stride: usize,
    cfg: &Config,
    compressor: &mut turbojpeg::Compressor,
) -> Option<Vec<u8>> {
    // 路徑 A：不 downsample, 不 range — 直接 encode raw BGRA
    // 路徑 B：downsample 2x（box filter），輸出 RGBA 給 turbojpeg
    let (out_buf, out_w, out_h) = if cfg.downsample {
        let dw = w / 2;
        let dh = h / 2;
        let mut buf = vec![0u8; dw * dh * 3]; // 我們直接出 RGB 給 turbojpeg（省 alpha）
        for y in 0..dh {
            for x in 0..dw {
                let sx = x * 2;
                let sy = y * 2;
                // 平均 4 個 source pixel（BGRA → RGB）
                let mut b: u32 = 0; let mut g: u32 = 0; let mut r: u32 = 0;
                for dy in 0..2 {
                    for dx in 0..2 {
                        let off = (sy + dy) * stride + (sx + dx) * 4;
                        b += raw[off] as u32;
                        g += raw[off + 1] as u32;
                        r += raw[off + 2] as u32;
                    }
                }
                let mut rr = (r >> 2) as u8;
                let mut gg = (g >> 2) as u8;
                let mut bb = (b >> 2) as u8;
                if cfg.limited_to_full {
                    rr = limited_to_full(rr);
                    gg = limited_to_full(gg);
                    bb = limited_to_full(bb);
                }
                let dst = (y * dw + x) * 3;
                buf[dst    ] = rr;
                buf[dst + 1] = gg;
                buf[dst + 2] = bb;
            }
        }
        (buf, dw, dh)
    } else {
        // 直送 BGRA -> RGB，不 downsample
        let mut buf = vec![0u8; w * h * 3];
        for y in 0..h {
            for x in 0..w {
                let off = y * stride + x * 4;
                let mut b = raw[off];
                let mut g = raw[off + 1];
                let mut r = raw[off + 2];
                if cfg.limited_to_full {
                    b = limited_to_full(b);
                    g = limited_to_full(g);
                    r = limited_to_full(r);
                }
                let dst = (y * w + x) * 3;
                buf[dst    ] = r;
                buf[dst + 1] = g;
                buf[dst + 2] = b;
            }
        }
        (buf, w, h)
    };

    // Encode JPEG
    let img = turbojpeg::Image {
        pixels: out_buf.as_slice(),
        width: out_w,
        pitch: out_w * 3,
        height: out_h,
        format: turbojpeg::PixelFormat::RGB,
    };
    match compressor.compress_to_vec(img) {
        Ok(bytes) => Some(bytes),
        Err(e) => {
            warn!("turbojpeg encode error: {e}");
            None
        }
    }
}

#[inline]
fn limited_to_full(v: u8) -> u8 {
    // BT.709 limited range: [16, 235] → full [0, 255]
    let f = (v as i32 - 16).max(0).min(219);
    ((f * 255 + 110) / 219).min(255) as u8
}
