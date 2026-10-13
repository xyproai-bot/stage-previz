#!/usr/bin/env bash
# 把編好的執行檔包成 macOS .app 再壓成 zip（CI 用，也可以在 Mac 上手動跑）
#
# 用法：macos/make-app.sh <執行檔> <版本> <輸出資料夾>
#   例：macos/make-app.sh dist/stage-previz-ndi-helper 0.1.9 dist
# 產出：<輸出資料夾>/Stage Previz NDI Helper.app
#       <輸出資料夾>/stage-previz-ndi-helper-mac.zip
#
# 沒有 Apple 開發者簽章 → 用 ad-hoc 簽（Apple Silicon 一定要有簽章才跑得動）。
# 使用者第一次打開要「仍要打開」，見 README。
set -euo pipefail

BIN="$1"
VERSION="$2"
OUT="$3"
HERE="$(cd "$(dirname "$0")" && pwd)"
APP_NAME="Stage Previz NDI Helper.app"
APP="$OUT/$APP_NAME"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/stage-previz-ndi-helper"
chmod +x "$APP/Contents/MacOS/stage-previz-ndi-helper"
sed "s/__VERSION__/$VERSION/g" "$HERE/Info.plist" > "$APP/Contents/Info.plist"
plutil -lint "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"

codesign --force --deep --sign - "$APP"
codesign --verify --deep --verbose=2 "$APP"

rm -f "$OUT/stage-previz-ndi-helper-mac.zip"
# ditto 保留 .app 結構、執行權限、簽章
(cd "$OUT" && ditto -c -k --sequesterRsrc --keepParent "$APP_NAME" stage-previz-ndi-helper-mac.zip)
ls -la "$OUT"
