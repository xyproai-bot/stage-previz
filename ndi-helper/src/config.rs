// 設定檔（JSON 在 OS config dir）
//
// Windows: %APPDATA%\stage-previz-ndi-helper\config.json
// macOS:   ~/Library/Application Support/stage-previz-ndi-helper/config.json
// Linux:   ~/.config/stage-previz-ndi-helper/config.json
//
// 測試 / 開發用環境變數（一般使用者不用管）：
//   STAGE_PREVIZ_NDI_CONFIG_DIR   換設定檔資料夾（不碰正式的 config.json）
//   STAGE_PREVIZ_NDI_PORT         換 WebSocket port（不寫回 config）

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// 設定檔格式版本。舊版（沒有這欄 = 0/1）的 autostart 預設是 false，
/// 升到 2 時一次性改成 true（「裝一次就不用管」）；之後用戶在 tray 關掉就尊重用戶。
pub const CURRENT_CONFIG_VERSION: u32 = 2;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    /// WebSocket port（預設 7777）
    pub port: u16,

    /// 手動指定的 NDI source 名稱（精確比對）。None = 自動挑（本機 AE 優先）。
    /// 網頁送 select_source 會改這欄並存檔。
    pub source_name: Option<String>,

    /// 2x downsample（節省頻寬 / CPU，預設 true）
    pub downsample: bool,

    /// JPEG quality 0-100（預設 75）
    pub jpeg_quality: u8,

    /// Limited (16-235) → Full (0-255) range conversion（NDI 的 BT.709 多半是 limited）
    pub limited_to_full: bool,

    /// 開機自動啟動（Windows：HKCU Run；macOS：~/Library/LaunchAgents）
    pub autostart: bool,

    /// 送給瀏覽器的最高 fps（預設 30；AE 送 60 也只編 30 張 JPEG）
    pub max_fps: u32,

    /// 設定檔格式版本（見 CURRENT_CONFIG_VERSION）。
    /// 舊檔沒有這欄 → 0（不是 struct 預設的 CURRENT），才會觸發升級。
    #[serde(default)]
    pub config_version: u32,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            port: 7777,
            source_name: None,
            downsample: true,
            jpeg_quality: 75,
            limited_to_full: true,
            autostart: true,
            max_fps: 30,
            config_version: CURRENT_CONFIG_VERSION,
        }
    }
}

pub fn config_dir() -> PathBuf {
    let p = match std::env::var_os("STAGE_PREVIZ_NDI_CONFIG_DIR") {
        Some(d) if !d.is_empty() => PathBuf::from(d),
        _ => {
            let mut p = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
            p.push("stage-previz-ndi-helper");
            p
        }
    };
    let _ = std::fs::create_dir_all(&p);
    p
}

pub fn config_path() -> PathBuf {
    config_dir().join("config.json")
}

/// 讀設定檔；沒有就建預設的。舊格式會自動升級（autostart 改成預設開）。
pub fn load_or_default() -> Config {
    let path = config_path();
    let mut cfg = match std::fs::read_to_string(&path) {
        Ok(data) => match serde_json::from_str::<Config>(&data) {
            Ok(c) => c,
            Err(e) => {
                log::warn!("config.json 讀不懂（{e}），改用預設值");
                Config::default()
            }
        },
        Err(_) => Config::default(),
    };

    let mut dirty = !path.exists();
    if cfg.config_version < CURRENT_CONFIG_VERSION {
        // v0.1.8 以前預設 autostart=false 而且第一次跑就寫進檔案 → 舊用戶永遠是 false。
        // 升級時一次性打開；之後用戶自己關掉就不會再被改回來。
        cfg.autostart = true;
        cfg.config_version = CURRENT_CONFIG_VERSION;
        dirty = true;
    }
    if cfg.max_fps == 0 {
        cfg.max_fps = 30;
        dirty = true;
    }
    if dirty {
        if let Err(e) = save(&cfg) {
            log::warn!("寫 config.json 失敗：{e}");
        }
    }
    cfg
}

pub fn save(cfg: &Config) -> std::io::Result<()> {
    let path = config_path();
    let data = serde_json::to_string_pretty(cfg).unwrap_or_else(|_| "{}".into());
    // 先寫暫存檔再改名，避免寫到一半當機留下壞掉的檔案
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, data)?;
    std::fs::rename(&tmp, &path)
}

/// WebSocket port：環境變數 STAGE_PREVIZ_NDI_PORT 優先（測試用，不寫回 config）
pub fn effective_port(cfg: &Config) -> u16 {
    std::env::var("STAGE_PREVIZ_NDI_PORT")
        .ok()
        .and_then(|v| v.trim().parse::<u16>().ok())
        .filter(|p| *p != 0)
        .unwrap_or(cfg.port)
}
