// Windows 開機自啟（HKCU\Software\Microsoft\Windows\CurrentVersion\Run）
//
// 不寫 HKLM 避免要 admin 權限；HKCU 對單一用戶足夠。
// macOS：launchctl plist；Linux：~/.config/autostart/*.desktop（之後再寫）

#![allow(dead_code)]

#[cfg(windows)]
pub fn enable() -> std::io::Result<()> {
    use winreg::enums::*;
    use winreg::RegKey;
    let exe = std::env::current_exe()?.to_string_lossy().into_owned();
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = hkcu.create_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Run")?;
    key.set_value("StagePrevizNdiHelper", &exe)?;
    Ok(())
}

#[cfg(windows)]
pub fn disable() -> std::io::Result<()> {
    use winreg::enums::*;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = hkcu.create_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Run")?;
    key.delete_value("StagePrevizNdiHelper")?;
    Ok(())
}

#[cfg(windows)]
pub fn is_enabled() -> bool {
    use winreg::enums::*;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    if let Ok(key) = hkcu.open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Run") {
        if let Ok(_v) = key.get_value::<String, _>("StagePrevizNdiHelper") {
            return true;
        }
    }
    false
}

#[cfg(not(windows))]
pub fn enable() -> std::io::Result<()> { Ok(()) }
#[cfg(not(windows))]
pub fn disable() -> std::io::Result<()> { Ok(()) }
#[cfg(not(windows))]
pub fn is_enabled() -> bool { false }
