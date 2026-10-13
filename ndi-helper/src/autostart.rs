// 開機（登入）自動啟動
//
// Windows：HKCU\Software\Microsoft\Windows\CurrentVersion\Run（不用 admin）
// macOS：  ~/Library/LaunchAgents/com.xyproai.stage-previz-ndi-helper.plist（RunAtLoad）
// Linux：  還沒做（no-op）
//
// enable() 每次啟動都會重寫成「目前這個執行檔」的路徑，換安裝位置 / 升級也不會指到舊檔。
// 測試時設 STAGE_PREVIZ_NDI_NO_AUTOSTART=1 → 完全不碰（見 main.rs）。

#[cfg(windows)]
mod imp {
    use winreg::enums::*;
    use winreg::RegKey;

    const RUN_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
    const VALUE_NAME: &str = "StagePrevizNdiHelper";

    pub fn enable() -> std::io::Result<()> {
        let exe = std::env::current_exe()?.to_string_lossy().into_owned();
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let (key, _) = hkcu.create_subkey(RUN_KEY)?;
        // 路徑有空白（C:\Program Files\...）→ 加引號
        key.set_value(VALUE_NAME, &format!("\"{exe}\""))?;
        Ok(())
    }

    pub fn disable() -> std::io::Result<()> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let (key, _) = hkcu.create_subkey(RUN_KEY)?;
        match key.delete_value(VALUE_NAME) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        }
    }

    pub fn is_enabled() -> bool {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        hkcu.open_subkey(RUN_KEY)
            .and_then(|k| k.get_value::<String, _>(VALUE_NAME))
            .is_ok()
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use std::path::{Path, PathBuf};

    pub const LABEL: &str = "com.xyproai.stage-previz-ndi-helper";
    /// 跟 .app 的 Info.plist CFBundleIdentifier 一致
    pub const BUNDLE_ID: &str = "com.xyproai.stage-previz-ndi-helper";

    fn plist_path() -> std::io::Result<PathBuf> {
        let home = dirs::home_dir()
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no home dir"))?;
        Ok(home.join("Library/LaunchAgents").join(format!("{LABEL}.plist")))
    }

    fn xml_escape(s: &str) -> String {
        s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
    }

    /// 目前執行檔所在的 .app（…/X.app/Contents/MacOS/bin → …/X.app）
    fn app_bundle(exe: &Path) -> Option<PathBuf> {
        let bundle = exe.parent()?.parent()?.parent()?;
        if bundle.extension().map(|e| e == "app").unwrap_or(false) {
            Some(bundle.to_path_buf())
        } else {
            None
        }
    }

    fn program_arguments() -> std::io::Result<Vec<String>> {
        let exe = std::env::current_exe()?;
        let exe_s = exe.to_string_lossy().into_owned();
        Ok(match app_bundle(&exe) {
            // 從「下載」直接打開沒拖進「應用程式」時，macOS 會把 app 搬到隨機的暫存路徑
            // （AppTranslocation），重開機後就不在了 → 改用 bundle id 讓系統自己找 app。
            Some(_) if exe_s.contains("/AppTranslocation/") => {
                vec!["/usr/bin/open".into(), "-g".into(), "-b".into(), BUNDLE_ID.into()]
            }
            Some(bundle) => vec![
                "/usr/bin/open".into(),
                "-g".into(),
                bundle.to_string_lossy().into_owned(),
            ],
            None => vec![exe_s],
        })
    }

    pub fn enable() -> std::io::Result<()> {
        let path = plist_path()?;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let args: String = program_arguments()?
            .iter()
            .map(|a| format!("    <string>{}</string>\n", xml_escape(a)))
            .collect();
        let plist = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array>
{args}  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
</dict>
</plist>
"#
        );
        // 內容一樣就不重寫（避免每次開都跳「已加入背景項目」通知）
        if std::fs::read_to_string(&path).map(|old| old == plist).unwrap_or(false) {
            return Ok(());
        }
        std::fs::write(&path, plist)
    }

    pub fn disable() -> std::io::Result<()> {
        let path = plist_path()?;
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        }
    }

    pub fn is_enabled() -> bool {
        plist_path().map(|p| p.exists()).unwrap_or(false)
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod imp {
    pub fn enable() -> std::io::Result<()> { Ok(()) }
    pub fn disable() -> std::io::Result<()> { Ok(()) }
    pub fn is_enabled() -> bool { false }
}

pub use imp::{disable, enable, is_enabled};

/// 測試時可以完全關掉自啟動的任何動作（不寫 registry / LaunchAgent）
pub fn suppressed() -> bool {
    std::env::var("STAGE_PREVIZ_NDI_NO_AUTOSTART")
        .map(|v| !v.is_empty() && v != "0")
        .unwrap_or(false)
}

/// 啟動時同步：config 說要自啟動 → 確保登記的是目前這個執行檔。
/// config 說不要 → 不主動刪（tray 關掉時已經刪了）。
pub fn sync(want: bool) {
    if suppressed() || !want {
        return;
    }
    if let Err(e) = enable() {
        log::warn!("autostart enable failed: {e}");
    }
}

/// tray 切換用：開 / 關並回傳實際結果
pub fn set(want: bool) -> bool {
    if suppressed() {
        return want;
    }
    let r = if want { enable() } else { disable() };
    if let Err(e) = r {
        log::warn!("autostart set({want}) failed: {e}");
    }
    is_enabled()
}
