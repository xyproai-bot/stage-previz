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

/// 設定檔格式版本（升級規則見 upgrade）：
///   2：autostart 舊預設 false → 一次性改成 true（「裝一次就不用管」）；之後用戶在 tray 關掉就尊重用戶
///   3（0.1.13）：畫質變好 — 不再固定縮一半（改成太大才縮，見 max_output_pixels）、JPEG 75 → 90
pub const CURRENT_CONFIG_VERSION: u32 = 3;

/// 送出去的畫面最多幾個像素（downsample 開著時）。
/// 450 萬 = 常用的 8800×2024 畫布用 AE「Half」送出來的 4400×1012 原樣送；
/// 整張 8800×2024（1780 萬）縮成 1/2；量測見 README「畫質」
pub const DEFAULT_MAX_OUTPUT_PIXELS: u32 = 4_500_000;

/// JPEG 品質（本機傳輸、頻寬不重要；只花 CPU）
pub const DEFAULT_JPEG_QUALITY: u8 = 90;

/// 0.1.12 以前的 JPEG 預設品質（升級時是這個值 = 沒改過 → 換成新預設）
const OLD_DEFAULT_JPEG_QUALITY: u8 = 75;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    /// WebSocket port（預設 7777）
    pub port: u16,

    /// 手動指定的 NDI source 名稱（精確比對）。None = 自動挑（本機 AE 優先）。
    /// 網頁送 select_source 會改這欄並存檔。
    pub source_name: Option<String>,

    /// 畫面太大才縮小（預設 true）：縮成整數分之一（1/2、1/3…），剛好不超過 max_output_pixels；
    /// 本來就不大的畫面原樣送。false = 永遠不縮（原尺寸送，吃 CPU）
    pub downsample: bool,

    /// 送出去的畫面最多幾個像素（downsample 開著時；預設 DEFAULT_MAX_OUTPUT_PIXELS）
    pub max_output_pixels: u32,

    /// JPEG quality 1-100（預設 90；色度不降取樣 4:4:4）
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
            max_output_pixels: DEFAULT_MAX_OUTPUT_PIXELS,
            jpeg_quality: DEFAULT_JPEG_QUALITY,
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

/// 舊版設定檔升級到 CURRENT_CONFIG_VERSION。回傳 true = 有改（要寫回檔案）。
/// 只改「還是舊預設值」的欄位；用戶自己改過的值不動。
pub fn upgrade(cfg: &mut Config) -> bool {
    let mut dirty = false;
    let from = cfg.config_version;
    if from < 2 {
        // v0.1.8 以前預設 autostart=false 而且第一次跑就寫進檔案 → 舊用戶永遠是 false。
        // 升級時一次性打開；之後用戶自己關掉就不會再被改回來。
        cfg.autostart = true;
        dirty = true;
    }
    if from < 3 {
        // 0.1.12 以前：downsample=true 是「固定縮一半」，現在是「太大才縮」（同一個開關，意思變好）；
        // false（用戶自己關掉縮小）照舊 = 永遠不縮。JPEG 還是舊預設 75 → 90；改過的（例如 60）不動。
        if cfg.jpeg_quality == OLD_DEFAULT_JPEG_QUALITY {
            cfg.jpeg_quality = DEFAULT_JPEG_QUALITY;
        }
    }
    if from < CURRENT_CONFIG_VERSION {
        cfg.config_version = CURRENT_CONFIG_VERSION;
        dirty = true;
    }
    // 壞掉 / 沒填的值補回預設（不算升級，任何版本都檢查）
    if cfg.max_fps == 0 {
        cfg.max_fps = 30;
        dirty = true;
    }
    if cfg.max_output_pixels == 0 {
        cfg.max_output_pixels = DEFAULT_MAX_OUTPUT_PIXELS;
        dirty = true;
    }
    if cfg.jpeg_quality == 0 || cfg.jpeg_quality > 100 {
        cfg.jpeg_quality = DEFAULT_JPEG_QUALITY;
        dirty = true;
    }
    dirty
}

/// 讀設定檔；沒有就建預設的。舊格式會自動升級（見 upgrade）。
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

    let from = cfg.config_version;
    let mut dirty = !path.exists();
    if upgrade(&mut cfg) {
        dirty = true;
        if from < CURRENT_CONFIG_VERSION && path.exists() {
            log::info!("config.json 從第 {from} 版升級到第 {CURRENT_CONFIG_VERSION} 版：{cfg:?}");
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(json: &str) -> Config {
        serde_json::from_str(json).expect("config json")
    }

    /// 0.1.12 裝好沒改過的 config.json（第 2 版、舊預設值）
    const V2_DEFAULTS: &str = r#"{
        "port": 7777, "source_name": null, "downsample": true, "jpeg_quality": 75,
        "limited_to_full": true, "autostart": true, "max_fps": 30, "config_version": 2
    }"#;

    #[test]
    fn upgrades_old_defaults_to_new_quality() {
        let mut c = parse(V2_DEFAULTS);
        assert_eq!(c.max_output_pixels, DEFAULT_MAX_OUTPUT_PIXELS, "舊檔沒有這欄 → 預設");
        assert!(upgrade(&mut c));
        assert_eq!(c.config_version, CURRENT_CONFIG_VERSION);
        assert_eq!(c.jpeg_quality, 90);
        assert!(c.downsample, "還是開著：意思變成「太大才縮」");
        assert_eq!(c.max_output_pixels, DEFAULT_MAX_OUTPUT_PIXELS);
        // 再跑一次不會再改
        assert!(!upgrade(&mut c));
    }

    #[test]
    fn upgrade_keeps_customised_values() {
        let mut c = parse(
            r#"{ "downsample": false, "jpeg_quality": 60, "autostart": false, "max_fps": 24,
                 "source_name": "B (y)", "max_output_pixels": 8000000, "config_version": 2 }"#,
        );
        upgrade(&mut c);
        assert!(!c.downsample, "用戶關掉縮小 → 照舊永遠不縮");
        assert_eq!(c.jpeg_quality, 60);
        assert!(!c.autostart, "第 2 版以後用戶關掉開機啟動 → 尊重");
        assert_eq!(c.max_fps, 24);
        assert_eq!(c.max_output_pixels, 8_000_000);
        assert_eq!(c.source_name.as_deref(), Some("B (y)"));
        assert_eq!(c.config_version, CURRENT_CONFIG_VERSION);
    }

    #[test]
    fn upgrade_from_very_old_config() {
        // 0.1.8 以前：沒有 config_version、autostart 預設 false
        let mut c = parse(r#"{ "port": 7777, "downsample": true, "jpeg_quality": 75, "autostart": false }"#);
        assert_eq!(c.config_version, 0);
        assert!(upgrade(&mut c));
        assert!(c.autostart);
        assert_eq!(c.jpeg_quality, 90);
        assert_eq!(c.config_version, CURRENT_CONFIG_VERSION);
    }

    #[test]
    fn current_version_is_left_alone() {
        // 升級後用戶自己改回 75 → 不會再被改成 90
        let mut c = Config { jpeg_quality: 75, config_version: CURRENT_CONFIG_VERSION, ..Config::default() };
        assert!(!upgrade(&mut c));
        assert_eq!(c.jpeg_quality, 75);
    }

    #[test]
    fn broken_values_fall_back_to_defaults() {
        let mut c = parse(r#"{ "max_fps": 0, "max_output_pixels": 0, "jpeg_quality": 0, "config_version": 3 }"#);
        assert!(upgrade(&mut c));
        assert_eq!(c.max_fps, 30);
        assert_eq!(c.max_output_pixels, DEFAULT_MAX_OUTPUT_PIXELS);
        assert_eq!(c.jpeg_quality, DEFAULT_JPEG_QUALITY);
        let mut c = parse(r#"{ "jpeg_quality": 200, "config_version": 3 }"#);
        upgrade(&mut c);
        assert_eq!(c.jpeg_quality, DEFAULT_JPEG_QUALITY);
    }

    #[test]
    fn new_install_defaults() {
        let c = Config::default();
        assert!(c.downsample);
        assert_eq!(c.jpeg_quality, 90);
        assert_eq!(c.max_output_pixels, DEFAULT_MAX_OUTPUT_PIXELS);
        assert_eq!(c.config_version, CURRENT_CONFIG_VERSION);
        let mut c2 = c.clone();
        assert!(!upgrade(&mut c2), "新裝的不用升級");
    }
}
