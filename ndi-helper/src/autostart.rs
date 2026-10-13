// 開機（登入）自動啟動
//
// Windows：HKCU\Software\Microsoft\Windows\CurrentVersion\Run\StagePrevizNdiHelper = "\"<exe 路徑>\""（不用 admin）
// macOS：  ~/Library/LaunchAgents/com.xyproai.stage-previz-ndi-helper.plist（RunAtLoad；直接執行 App 裡的執行檔，
//          「登入項目」才會顯示 App 名稱而不是「open」）
// Linux：  還沒做（no-op）
//
// config.autostart = true 時，每次啟動都會「確保」登記的是目前這個執行檔（換安裝位置 / 升級也不會指到舊檔），
// 寫完會讀回來確認；之後背景每隔一段時間再檢查一次（被別的程式刪掉 → 補回去並寫進 log）。
// 結果放在 status 的 `autostart` 欄位 + 系統列提示，失敗不會再安安靜靜吞掉。
// 測試時設 STAGE_PREVIZ_NDI_NO_AUTOSTART=1 → 完全不寫（只讀）。

use crate::state::{AutostartStatus, Shared};
use log::{info, warn};
use std::sync::Arc;
use std::time::Duration;

// ↓ Windows Run 機碼用（其他平台只有測試會用到）

/// 現在登記的值 vs 應該的值 → 要不要重寫
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunValueAction {
    Keep,
    Write,
}

/// Windows Run 機碼的值：路徑有空白（C:\Program Files\...）→ 一定要加引號
#[cfg_attr(not(windows), allow(dead_code))]
pub fn run_command(exe: &std::path::Path) -> String {
    format!("\"{}\"", exe.display())
}

/// 不分大小寫（Windows 路徑）、忽略前後空白；沒有值 / 沒引號 / 指到別的檔案 → 重寫
#[cfg_attr(not(windows), allow(dead_code))]
pub fn decide(current: Option<&str>, expected: &str) -> RunValueAction {
    match current {
        Some(c) if c.trim().eq_ignore_ascii_case(expected.trim()) => RunValueAction::Keep,
        _ => RunValueAction::Write,
    }
}

#[cfg(windows)]
mod imp {
    use super::{decide, run_command, RunValueAction};
    use std::io;
    use winreg::enums::*;
    use winreg::RegKey;

    pub const RUN_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
    pub const VALUE_NAME: &str = "StagePrevizNdiHelper";

    fn expected() -> io::Result<String> {
        Ok(run_command(&std::env::current_exe()?))
    }

    /// 確保 HKCU\<key_path>\<name> = expected；回傳有沒有寫（原本就對 = false）。
    /// 寫完讀回來比對，不一樣就當失敗。
    pub fn ensure_at(key_path: &str, name: &str, expected: &str) -> io::Result<bool> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let (key, _) = hkcu.create_subkey_with_flags(key_path, KEY_READ | KEY_WRITE)?;
        let current: Option<String> = key.get_value(name).ok();
        if decide(current.as_deref(), expected) == RunValueAction::Keep {
            return Ok(false);
        }
        key.set_value(name, &expected.to_string())?;
        let back: String = key.get_value(name)?;
        if decide(Some(&back), expected) != RunValueAction::Keep {
            return Err(io::Error::new(io::ErrorKind::Other, format!("寫進去之後讀回來不一樣：{back}")));
        }
        Ok(true)
    }

    pub fn registered_at(key_path: &str, name: &str, expected: &str) -> bool {
        RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey(key_path)
            .and_then(|k| k.get_value::<String, _>(name))
            .map(|v| decide(Some(&v), expected) == RunValueAction::Keep)
            .unwrap_or(false)
    }

    pub fn ensure_registered() -> io::Result<bool> {
        ensure_at(RUN_KEY, VALUE_NAME, &expected()?)
    }

    pub fn disable() -> io::Result<()> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let (key, _) = hkcu.create_subkey_with_flags(RUN_KEY, KEY_READ | KEY_WRITE)?;
        match key.delete_value(VALUE_NAME) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        }
    }

    /// 有登記、而且指到目前這個執行檔
    pub fn is_registered() -> bool {
        expected().map(|e| registered_at(RUN_KEY, VALUE_NAME, &e)).unwrap_or(false)
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use std::io;
    use std::path::{Path, PathBuf};

    pub const LABEL: &str = "com.xyproai.stage-previz-ndi-helper";
    /// 跟 .app 的 Info.plist CFBundleIdentifier 一致
    pub const BUNDLE_ID: &str = "com.xyproai.stage-previz-ndi-helper";

    fn plist_path() -> io::Result<PathBuf> {
        let home = dirs::home_dir().ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no home dir"))?;
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

    fn program_arguments(exe: &Path) -> Vec<String> {
        let exe_s = exe.to_string_lossy().into_owned();
        match app_bundle(exe) {
            // 從「下載」直接打開沒拖進「應用程式」時，macOS 會把 app 搬到隨機的暫存路徑
            // （AppTranslocation），重開機後就不在了 → 改用 bundle id 讓系統自己找 app。
            Some(_) if exe_s.contains("/AppTranslocation/") => {
                vec!["/usr/bin/open".into(), "-g".into(), "-b".into(), BUNDLE_ID.into()]
            }
            // 直接執行 App 裡的執行檔（0.1.11 以前是 /usr/bin/open -g <App>）：macOS 會把背景項目算在
            // 「執行檔是誰簽的」頭上 → 用 open 時「登入項目」和「App 背景活動」通知都顯示成「open」，
            // 使用者很可能以為是不明程式而關掉；直接執行才會顯示「Stage Previz NDI Helper」
            _ => vec![exe_s],
        }
    }

    /// LaunchAgent 的內容（exe = 目前的執行檔）
    pub fn plist_for(exe: &Path) -> String {
        let args: String = program_arguments(exe)
            .iter()
            .map(|a| format!("    <string>{}</string>\n", xml_escape(a)))
            .collect();
        // 在 .app 裡 → 跟「登入項目」說這個背景項目屬於哪個 App（macOS 13 起）
        let associated = if app_bundle(exe).is_some() {
            format!("  <key>AssociatedBundleIdentifiers</key>\n  <array>\n    <string>{BUNDLE_ID}</string>\n  </array>\n")
        } else {
            String::new()
        };
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{LABEL}</string>
{associated}  <key>ProgramArguments</key>
  <array>
{args}  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
</dict>
</plist>
"#
        )
    }

    fn expected_plist() -> io::Result<String> {
        Ok(plist_for(&std::env::current_exe()?))
    }

    /// 回傳有沒有寫（內容一樣就不重寫，避免每次開都跳「已加入背景項目」通知）
    pub fn ensure_registered() -> io::Result<bool> {
        let path = plist_path()?;
        let plist = expected_plist()?;
        if std::fs::read_to_string(&path).map(|old| old == plist).unwrap_or(false) {
            return Ok(false);
        }
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(&path, &plist)?;
        if std::fs::read_to_string(&path)? != plist {
            return Err(io::Error::new(io::ErrorKind::Other, "寫進去之後讀回來不一樣"));
        }
        Ok(true)
    }

    pub fn disable() -> io::Result<()> {
        let path = plist_path()?;
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        }
    }

    pub fn is_registered() -> bool {
        match (plist_path(), expected_plist()) {
            (Ok(p), Ok(want)) => std::fs::read_to_string(p).map(|s| s == want).unwrap_or(false),
            _ => false,
        }
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod imp {
    pub fn ensure_registered() -> std::io::Result<bool> {
        Ok(false)
    }
    pub fn disable() -> std::io::Result<()> {
        Ok(())
    }
    pub fn is_registered() -> bool {
        false
    }
}

/// 這個平台有沒有做開機自動啟動
pub const SUPPORTED: bool = cfg!(any(windows, target_os = "macos"));

/// 測試時可以完全關掉自啟動的寫入（不寫 registry / LaunchAgent）
pub fn suppressed() -> bool {
    std::env::var("STAGE_PREVIZ_NDI_NO_AUTOSTART")
        .map(|v| !v.is_empty() && v != "0")
        .unwrap_or(false)
}

/// config 要自啟動 → 確保登記的是目前這個執行檔（寫完讀回確認）。
/// config 不要 → 不主動刪（tray 關掉時已經刪了）。
/// 回傳 (目前狀況, 這次有沒有寫)。
pub fn ensure(want: bool) -> (AutostartStatus, bool) {
    if suppressed() || !want || !SUPPORTED {
        let st = AutostartStatus { wanted: want, registered: imp::is_registered(), error: None };
        return (st, false);
    }
    match imp::ensure_registered() {
        Ok(wrote) => (AutostartStatus { wanted: true, registered: true, error: None }, wrote),
        Err(e) => {
            warn!("autostart: 登記開機自動啟動失敗：{e}");
            let st = AutostartStatus {
                wanted: true,
                registered: imp::is_registered(),
                error: Some(format!("開機自動啟動沒設定成功：{e}")),
            };
            (st, false)
        }
    }
}

/// tray 切換用：開 / 關，回傳實際結果
pub fn set(want: bool) -> AutostartStatus {
    if suppressed() {
        return AutostartStatus { wanted: want, registered: imp::is_registered(), error: None };
    }
    if want {
        return ensure(true).0;
    }
    match imp::disable() {
        Ok(()) => AutostartStatus { wanted: false, registered: imp::is_registered(), error: None },
        Err(e) => {
            warn!("autostart: 取消開機自動啟動失敗：{e}");
            AutostartStatus {
                wanted: false,
                registered: imp::is_registered(),
                error: Some(format!("取消開機自動啟動失敗：{e}")),
            }
        }
    }
}

/// 把結果記進共用狀態（有變才通知網頁）
pub fn publish(shared: &Shared, st: AutostartStatus) {
    shared.update(|s| {
        if s.autostart != st {
            s.autostart = st;
            true
        } else {
            false
        }
    });
}

/// 啟動時做一次（main 呼叫，tray 出來前就知道結果）
pub fn startup(shared: &Shared) {
    let want = shared.cfg().autostart;
    let (st, wrote) = ensure(want);
    if st.wanted && st.registered {
        info!("autostart: {}", if wrote { "已登記開機自動啟動" } else { "開機自動啟動已經登記好了" });
    } else if st.wanted && suppressed() {
        info!("autostart: STAGE_PREVIZ_NDI_NO_AUTOSTART → 不寫（目前登記 = {}）", st.registered);
    }
    publish(shared, st);
}

/// 背景再檢查：15 秒、1 分鐘後，之後每 10 分鐘。被別的程式刪掉 / 改掉 → 補回去並記 log。
pub fn watch(shared: Arc<Shared>) {
    let mut delays = [Duration::from_secs(15), Duration::from_secs(60)].into_iter();
    loop {
        std::thread::sleep(delays.next().unwrap_or(Duration::from_secs(600)));
        let want = shared.cfg().autostart;
        let (st, wrote) = ensure(want);
        if wrote {
            warn!("autostart: 開機自動啟動的登記不見了 / 被改掉了（可能是別的程式），已經重新登記");
        }
        publish(&shared, st);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_command_is_quoted() {
        let p = std::path::Path::new(r"C:\Program Files\stage-previz-ndi-helper\bin\stage-previz-ndi-helper.exe");
        assert_eq!(
            run_command(p),
            r#""C:\Program Files\stage-previz-ndi-helper\bin\stage-previz-ndi-helper.exe""#
        );
    }

    #[test]
    fn decide_what_to_write() {
        let want = r#""C:\Program Files\stage-previz-ndi-helper\bin\stage-previz-ndi-helper.exe""#;
        assert_eq!(decide(None, want), RunValueAction::Write);
        assert_eq!(decide(Some(want), want), RunValueAction::Keep);
        // 大小寫 / 前後空白不同 → 一樣是同一個檔案
        assert_eq!(decide(Some(&format!(" {} ", want.to_lowercase())), want), RunValueAction::Keep);
        // 沒有引號（0.1.7 的寫法）→ 重寫成有引號的
        assert_eq!(
            decide(Some(r"C:\Program Files\stage-previz-ndi-helper\bin\stage-previz-ndi-helper.exe"), want),
            RunValueAction::Write
        );
        // 指到舊位置 / 開發版 → 重寫
        assert_eq!(decide(Some(r#""C:\Users\me\Desktop\stage-previz-ndi-helper.exe""#), want), RunValueAction::Write);
        assert_eq!(decide(Some(""), want), RunValueAction::Write);
    }

    /// LaunchAgent 內容：一般位置直接執行 App 裡的執行檔 + 標明屬於哪個 App；暫存位置用 bundle id；開發版直接跑
    #[cfg(target_os = "macos")]
    #[test]
    fn launch_agent_plist() {
        use std::path::Path;
        let app = imp::plist_for(Path::new(
            "/Applications/Stage Previz NDI Helper.app/Contents/MacOS/stage-previz-ndi-helper",
        ));
        assert!(app.contains(
            "<string>/Applications/Stage Previz NDI Helper.app/Contents/MacOS/stage-previz-ndi-helper</string>"
        ));
        assert!(!app.contains("/usr/bin/open"), "{app}");
        assert!(app.contains("<key>AssociatedBundleIdentifiers</key>"));
        assert!(app.contains("<string>com.xyproai.stage-previz-ndi-helper</string>"));

        let moved = imp::plist_for(Path::new(
            "/Users/me/Desktop/R&D <test>/Stage Previz NDI Helper.app/Contents/MacOS/stage-previz-ndi-helper",
        ));
        assert!(moved.contains("R&amp;D &lt;test&gt;"), "{moved}");

        let translocated = imp::plist_for(Path::new(
            "/private/var/folders/x/T/AppTranslocation/ABC/d/Stage Previz NDI Helper.app/Contents/MacOS/stage-previz-ndi-helper",
        ));
        assert!(translocated.contains("<string>/usr/bin/open</string>"));
        assert!(translocated.contains("<string>-b</string>"));
        assert!(!translocated.contains("AppTranslocation"), "{translocated}");

        let dev = imp::plist_for(Path::new("/Users/me/stage-previz/ndi-helper/target/release/stage-previz-ndi-helper"));
        assert!(dev.contains("<string>/Users/me/stage-previz/ndi-helper/target/release/stage-previz-ndi-helper</string>"));
        assert!(!dev.contains("AssociatedBundleIdentifiers"));
    }

    /// 真的寫 registry，但只寫在測試用的暫時機碼（HKCU\Software\xyproai-ndi-helper-test-<pid>），跑完刪掉
    #[cfg(windows)]
    #[test]
    fn ensure_writes_verifies_and_is_idempotent() {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        let key = format!("Software\\xyproai-ndi-helper-test-{}", std::process::id());
        let want = r#""C:\Program Files\x y\helper.exe""#;
        let result = std::panic::catch_unwind(|| {
            assert!(!imp::registered_at(&key, "V", want));
            assert_eq!(imp::ensure_at(&key, "V", want).unwrap(), true, "first call writes");
            assert!(imp::registered_at(&key, "V", want));
            assert_eq!(imp::ensure_at(&key, "V", want).unwrap(), false, "second call keeps");
            // 被改成別的 → 補回來
            RegKey::predef(HKEY_CURRENT_USER)
                .open_subkey_with_flags(&key, winreg::enums::KEY_WRITE)
                .unwrap()
                .set_value("V", &"C:\\old\\helper.exe".to_string())
                .unwrap();
            assert!(!imp::registered_at(&key, "V", want));
            assert_eq!(imp::ensure_at(&key, "V", want).unwrap(), true);
            let v: String = RegKey::predef(HKEY_CURRENT_USER).open_subkey(&key).unwrap().get_value("V").unwrap();
            assert_eq!(v, want);
        });
        let _ = RegKey::predef(HKEY_CURRENT_USER).delete_subkey_all(&key);
        if let Err(e) = result {
            std::panic::resume_unwind(e);
        }
    }
}
