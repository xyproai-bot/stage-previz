// 設定檔（JSON 在 OS config dir）
//
// Windows: %APPDATA%\stage-previz-ndi-helper\config.json
// macOS:   ~/Library/Application Support/stage-previz-ndi-helper/config.json
// Linux:   ~/.config/stage-previz-ndi-helper/config.json

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    /// WebSocket port (預設 7777)
    pub port: u16,

    /// NDI source name preference（精確比對）— None = 隨便選一個第一個出現的
    pub source_name: Option<String>,

    /// 2x downsample（節省 IPC payload，預設 true）
    pub downsample: bool,

    /// JPEG quality 0-100（預設 75，平衡畫質 vs 大小）
    pub jpeg_quality: u8,

    /// Limited (16-235) → Full (0-255) range conversion（NDI 的 BT.709 多半是 limited）
    pub limited_to_full: bool,

    /// 開機自啟（Windows registry HKCU\Run）
    pub autostart: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            port: 7777,
            source_name: None,
            downsample: true,
            jpeg_quality: 75,
            limited_to_full: true,
            autostart: false,
        }
    }
}

pub fn config_path() -> PathBuf {
    let mut p = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    p.push("stage-previz-ndi-helper");
    let _ = std::fs::create_dir_all(&p);
    p.push("config.json");
    p
}

pub fn load_or_default() -> Config {
    let path = config_path();
    if let Ok(data) = std::fs::read_to_string(&path) {
        if let Ok(cfg) = serde_json::from_str::<Config>(&data) {
            return cfg;
        }
    }
    let cfg = Config::default();
    let _ = save(&cfg);
    cfg
}

pub fn save(cfg: &Config) -> std::io::Result<()> {
    let path = config_path();
    let data = serde_json::to_string_pretty(cfg).unwrap();
    std::fs::write(path, data)
}
