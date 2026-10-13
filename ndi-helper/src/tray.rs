// 系統列（Windows 右下角 / macOS 選單列）圖示
//
// 圖示顏色：綠 = 網頁正在收 AE 畫面；灰 = 待機（沒網頁在看）；橘 = 需要處理（沒裝 NDI / 找不到 AE）
// 選單：
//   - 狀態（不能點）
//   - 打開 Stage Previz 平台
//   - 下載 NDI Tools（只有沒裝 NDI 時能點）
//   - 開機時自動啟動（勾選）
//   - 開啟設定資料夾
//   - 離開
//
// 必須在主執行緒跑（macOS 硬性規定）；tray icon 在 event loop 開始後（StartCause::Init）才建立。

use crate::state::{HelperState, NdiRuntime, Shared};
use log::{error, info};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tao::event::{Event, StartCause};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tray_icon::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tray_icon::{TrayIcon, TrayIconBuilder, TrayIconEvent};

const PLATFORM_URL: &str = "https://stage-previz.vercel.app/";
const NDI_TOOLS_URL: &str = "https://ndi.video/tools/";

#[derive(Clone, Copy, PartialEq, Eq)]
enum Light {
    Live,
    Idle,
    Warn,
}

fn describe(s: &HelperState, clients: usize, want_frames: bool) -> (String, Light) {
    if let Some(err) = &s.port_error {
        return (format!("⚠ {err}"), Light::Warn);
    }
    match s.ndi {
        NdiRuntime::Starting => ("啟動中…".into(), Light::Idle),
        NdiRuntime::Missing => ("⚠ 沒有 NDI — 請先安裝 NDI Tools".into(), Light::Warn),
        NdiRuntime::Error => {
            let msg = s.error.as_ref().map(|e| e.message.as_str()).unwrap_or("NDI 錯誤");
            (format!("⚠ {}", trunc(msg, 40)), Light::Warn)
        }
        NdiRuntime::Ready => match &s.source {
            None => ("等待 AE 的 NDI 輸出…".into(), Light::Warn),
            Some(name) if !want_frames => (
                format!("待機中 · {} · 網頁沒開", trunc(name, 28)),
                Light::Idle,
            ),
            Some(name) if s.receiving => (
                format!("● {} · {:.0} fps · {} 個網頁", trunc(name, 28), s.fps, clients),
                Light::Live,
            ),
            Some(name) => (format!("連線中 · {}", trunc(name, 32)), Light::Idle),
        },
    }
}

pub fn run(shared: Arc<Shared>) -> Result<(), Box<dyn std::error::Error>> {
    #[allow(unused_mut)]
    let mut event_loop = EventLoopBuilder::new().build();

    // macOS：只在選單列出現，不要 Dock 圖示
    #[cfg(target_os = "macos")]
    {
        use tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS};
        event_loop.set_activation_policy(ActivationPolicy::Accessory);
    }

    let autostart_on = shared.cfg().autostart;

    let menu = Menu::new();
    let item_status = MenuItem::new("啟動中…", false, None);
    let item_open_platform = MenuItem::new("打開 Stage Previz 平台", true, None);
    let item_get_ndi = MenuItem::new("下載 NDI Tools（免費）", false, None);
    let item_autostart = CheckMenuItem::new("開機時自動啟動", true, autostart_on, None);
    let item_open_config = MenuItem::new("開啟設定資料夾", true, None);
    let item_quit = MenuItem::new("離開", true, None);
    menu.append(&item_status)?;
    menu.append(&PredefinedMenuItem::separator())?;
    menu.append(&item_open_platform)?;
    menu.append(&item_get_ndi)?;
    menu.append(&PredefinedMenuItem::separator())?;
    menu.append(&item_autostart)?;
    menu.append(&item_open_config)?;
    menu.append(&PredefinedMenuItem::separator())?;
    menu.append(&item_quit)?;

    let menu_channel = MenuEvent::receiver();
    let tray_channel = TrayIconEvent::receiver();
    let id_open_platform = item_open_platform.id().clone();
    let id_get_ndi = item_get_ndi.id().clone();
    let id_autostart = item_autostart.id().clone();
    let id_open_config = item_open_config.id().clone();
    let id_quit = item_quit.id().clone();

    let mut tray: Option<TrayIcon> = None;
    let mut menu_slot: Option<Menu> = Some(menu);
    let mut last_label = String::new();
    let mut last_light: Option<Light> = None;

    event_loop.run(move |event, _, control_flow| {
        // 每 500ms 醒一次更新狀態文字
        *control_flow = ControlFlow::WaitUntil(Instant::now() + Duration::from_millis(500));

        if let Event::NewEvents(StartCause::Init) = event {
            if let Some(menu) = menu_slot.take() {
                match TrayIconBuilder::new()
                    .with_tooltip("Stage Previz NDI Helper")
                    .with_menu(Box::new(menu))
                    .with_icon(build_icon(Light::Idle))
                    .build()
                {
                    Ok(t) => tray = Some(t),
                    Err(e) => error!("tray icon build failed: {e}"),
                }
            }
        }

        // 狀態文字 / 圖示顏色
        let (label, light) = {
            let clients = shared.clients();
            let want = shared.frame_clients() > 0;
            let s = shared.state();
            let (l, light) = describe(&s, clients, want);
            item_get_ndi.set_enabled(s.ndi == NdiRuntime::Missing);
            (l, light)
        };
        if label != last_label {
            item_status.set_text(&label);
            if let Some(t) = &tray {
                let _ = t.set_tooltip(Some(format!("Stage Previz NDI Helper\n{label}")));
            }
            last_label = label;
        }
        if last_light != Some(light) {
            if let Some(t) = &tray {
                let _ = t.set_icon(Some(build_icon(light)));
                last_light = Some(light);
            }
        }

        while let Ok(ev) = menu_channel.try_recv() {
            if ev.id() == &id_open_platform {
                let _ = open::that(PLATFORM_URL);
            } else if ev.id() == &id_get_ndi {
                let _ = open::that(NDI_TOOLS_URL);
            } else if ev.id() == &id_autostart {
                let want = !shared.cfg().autostart;
                let actual = crate::autostart::set(want);
                {
                    let mut c = shared.cfg();
                    c.autostart = actual;
                    if let Err(e) = crate::config::save(&c) {
                        error!("save config failed: {e}");
                    }
                }
                item_autostart.set_checked(actual);
                info!("autostart → {actual}");
            } else if ev.id() == &id_open_config {
                let _ = open::that(crate::config::config_dir());
            } else if ev.id() == &id_quit {
                info!("Quit from tray");
                tray = None;
                *control_flow = ControlFlow::Exit;
            }
        }
        // 點圖示本身不做事（選單由系統處理）；把事件清掉避免累積
        while tray_channel.try_recv().is_ok() {}
    });
}

fn trunc(s: &str, n: usize) -> String {
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i >= n {
            out.push('…');
            break;
        }
        out.push(c);
    }
    out
}

fn build_icon(light: Light) -> tray_icon::Icon {
    // 32×32 圓點（高 DPI 也清楚；系統會自己縮）
    const W: u32 = 32;
    const H: u32 = 32;
    let (r, g, b) = match light {
        Light::Live => (0x10, 0xc7, 0x8a),
        Light::Idle => (0x8a, 0x93, 0x9e),
        Light::Warn => (0xf5, 0x9e, 0x0b),
    };
    let mut buf = Vec::with_capacity((W * H * 4) as usize);
    let c = W as f32 / 2.0;
    for y in 0..H {
        for x in 0..W {
            let dx = x as f32 + 0.5 - c;
            let dy = y as f32 + 0.5 - c;
            let d = (dx * dx + dy * dy).sqrt();
            // 半徑 12，邊緣 1px 反鋸齒
            let alpha = ((12.5 - d).clamp(0.0, 1.0) * 255.0) as u8;
            buf.extend_from_slice(&[r, g, b, alpha]);
        }
    }
    tray_icon::Icon::from_rgba(buf, W, H).unwrap_or_else(|e| {
        error!("Icon build failed: {e}; using empty");
        tray_icon::Icon::from_rgba(vec![0, 0, 0, 0], 1, 1).expect("1x1 icon")
    })
}
