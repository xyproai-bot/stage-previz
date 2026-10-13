// Log 同時寫到 stderr 跟設定資料夾裡的 helper.log
//
// Release 版（Windows）沒有命令列視窗，stderr 等於丟掉 → 以前出錯（例如開機自動啟動沒登記成功）完全看不到。
// 現在一律也寫進 <設定資料夾>/helper.log（系統列選單「開啟設定資料夾」就找得到）。
// 超過 2 MB 就把舊的改名成 helper.log.old 再重新開始，不會無限長大。

use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

const MAX_BYTES: u64 = 2 * 1024 * 1024;

pub fn log_path() -> PathBuf {
    crate::config::config_dir().join("helper.log")
}

struct LogWriter {
    path: PathBuf,
    file: Option<File>,
    written: u64,
}

fn open_append(path: &Path) -> Option<File> {
    OpenOptions::new().create(true).append(true).open(path).ok()
}

impl LogWriter {
    fn new(path: PathBuf) -> Self {
        let mut w = Self { file: open_append(&path), written: 0, path };
        w.written = w.file.as_ref().and_then(|f| f.metadata().ok()).map(|m| m.len()).unwrap_or(0);
        if w.written > MAX_BYTES {
            w.rotate();
        }
        w
    }

    fn rotate(&mut self) {
        self.file = None;
        let old = self.path.with_extension("log.old");
        let _ = std::fs::remove_file(&old);
        let _ = std::fs::rename(&self.path, &old);
        self.file = open_append(&self.path);
        self.written = 0;
    }
}

impl Write for LogWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        // stderr 失敗（Release 版沒有主控台）不管它
        let _ = io::stderr().write_all(buf);
        if let Some(f) = self.file.as_mut() {
            if f.write_all(buf).is_ok() {
                self.written += buf.len() as u64;
                if self.written > MAX_BYTES {
                    self.rotate();
                }
            }
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        let _ = io::stderr().flush();
        if let Some(f) = self.file.as_mut() {
            let _ = f.flush();
        }
        Ok(())
    }
}

/// 開 logger（預設 info；RUST_LOG 可以改）
pub fn init() {
    let writer = LogWriter::new(log_path());
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .target(env_logger::Target::Pipe(Box::new(writer)))
        .init();
}
