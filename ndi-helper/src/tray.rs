// System tray icon
//
// 顯示：
//   - NDI source 名稱（或「等待 NDI source…」）
//   - 當前 fps
//   - 已連線瀏覽器數量
//   - 最後錯誤
//
// Menu items:
//   - Open admin (打開瀏覽器到 stage-previz.vercel.app)
//   - Show config folder
//   - Toggle autostart
//   - Quit

use crate::config::Config;
use crate::HelperState;
use log::{error, info};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tokio::sync::RwLock;
use tray_icon::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tray_icon::{TrayIconBuilder, TrayIconEvent};

pub fn run(state: Arc<RwLock<HelperState>>, _cfg: Config) -> Result<(), Box<dyn std::error::Error>> {
    let event_loop = EventLoopBuilder::new().build();

    // 建 menu
    let menu = Menu::new();
    let item_status = MenuItem::new("等待 NDI source…", false, None);
    let item_open_admin = MenuItem::new("打開 Stage Previz 平台", true, None);
    let item_open_config = MenuItem::new("開啟 config 資料夾", true, None);
    let item_quit = MenuItem::new("離開", true, None);
    menu.append(&item_status)?;
    menu.append(&PredefinedMenuItem::separator())?;
    menu.append(&item_open_admin)?;
    menu.append(&item_open_config)?;
    menu.append(&PredefinedMenuItem::separator())?;
    menu.append(&item_quit)?;

    let icon = build_icon();
    let tray = TrayIconBuilder::new()
        .with_tooltip("Stage Previz NDI Helper")
        .with_menu(Box::new(menu))
        .with_icon(icon)
        .build()?;

    let menu_channel = MenuEvent::receiver();
    let tray_channel = TrayIconEvent::receiver();

    let id_open_admin = item_open_admin.id().clone();
    let id_open_config = item_open_config.id().clone();
    let id_quit = item_quit.id().clone();

    // 用共享字串槽傳 label：polling thread 寫、event loop 讀後 set_text。
    // 不能直接把 item_status 丟進 thread（tray-icon 內部 Rc 不是 Send）。
    let label_slot = Arc::new(Mutex::new(String::from("等待 NDI source…")));
    {
        let label_slot = label_slot.clone();
        let state_for_status = state.clone();
        std::thread::spawn(move || {
            let runtime = tokio::runtime::Runtime::new().expect("runtime");
            loop {
                std::thread::sleep(Duration::from_secs(1));
                let s = runtime.block_on(state_for_status.read());
                let label = match (&s.source_name, s.last_error.as_deref()) {
                    (Some(name), None) => format!("● {} · {:.1} fps · {} 連線", trunc(name, 28), s.fps, s.clients),
                    (Some(name), Some(err)) => format!("⚠ {} · {}", trunc(name, 24), trunc(err, 30)),
                    (None, Some(err)) => format!("⚠ {}", trunc(err, 50)),
                    (None, None) => "等待 NDI source…".to_string(),
                };
                if let Ok(mut g) = label_slot.lock() {
                    *g = label;
                }
            }
        });
    }

    let mut last_label = String::new();
    event_loop.run(move |_event, _, control_flow| {
        // 每 500ms 醒一次抓最新 label
        *control_flow = ControlFlow::WaitUntil(Instant::now() + Duration::from_millis(500));
        if let Ok(g) = label_slot.lock() {
            if *g != last_label {
                item_status.set_text(g.as_str());
                last_label = g.clone();
            }
        }

        // poll menu events
        if let Ok(ev) = menu_channel.try_recv() {
            if ev.id() == &id_open_admin {
                let _ = open::that("https://stage-previz.vercel.app/");
            } else if ev.id() == &id_open_config {
                let path = crate::config::config_path();
                let dir = path.parent().unwrap_or(std::path::Path::new("."));
                let _ = open::that(dir);
            } else if ev.id() == &id_quit {
                info!("Quit from tray");
                *control_flow = ControlFlow::Exit;
            }
        }

        // tray click（左鍵 toggle 狀態視窗 — 暫時用不到）
        if let Ok(_ev) = tray_channel.try_recv() {
            // intentionally empty
        }

        let _ = &tray; // keep alive
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

fn build_icon() -> tray_icon::Icon {
    // 16×16 純色綠 icon（之後換成正式 SVG/PNG 編進 binary）
    const W: u32 = 16;
    const H: u32 = 16;
    let mut buf = Vec::with_capacity((W * H * 4) as usize);
    for y in 0..H {
        for x in 0..W {
            // 中心圈圈 = 綠；邊邊 = 透明
            let cx = W as f32 / 2.0;
            let cy = H as f32 / 2.0;
            let dx = x as f32 + 0.5 - cx;
            let dy = y as f32 + 0.5 - cy;
            let r = (dx * dx + dy * dy).sqrt();
            let alpha = if r < 6.0 { 255u8 } else if r < 7.0 { 128 } else { 0 };
            buf.push(0x10); // R
            buf.push(0xc7); // G
            buf.push(0x8a); // B
            buf.push(alpha);
        }
    }
    tray_icon::Icon::from_rgba(buf, W, H).unwrap_or_else(|e| {
        error!("Icon build failed: {e}; using empty");
        // fallback：1×1 透明
        tray_icon::Icon::from_rgba(vec![0, 0, 0, 0], 1, 1).unwrap()
    })
}
