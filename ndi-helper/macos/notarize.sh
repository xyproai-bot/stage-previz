#!/usr/bin/env bash
# 用 Apple Developer ID 簽章 + 公證（notarize）+ staple → 使用者第一次打開不會被 Gatekeeper 擋
# （在有 Developer ID 憑證的 Mac 上手動跑；CI 只做 ad-hoc 簽章，見 make-app.sh）
#
# 用法：macos/notarize.sh <輸入> <輸出資料夾>
#   <輸入> = make-app.sh 做好的 .app，或 CI / Release 上的 stage-previz-ndi-helper-mac.zip
#   例：macos/notarize.sh dist/stage-previz-ndi-helper-mac.zip dist/notarized
# 產出：<輸出資料夾>/Stage Previz NDI Helper.app（已簽章、公證、staple）
#       <輸出資料夾>/stage-previz-ndi-helper-mac.zip（上傳 Release 用這個）
#
# 需要的環境變數（帳號 / 密碼一律不要寫進 repo）：
#   公證帳號，二選一：
#     NOTARY_PROFILE=<名稱>          先跑過一次 `xcrun notarytool store-credentials <名稱>`（存在鑰匙圈）
#     APPLE_ID + APPLE_TEAM_ID + APPLE_APP_SPECIFIC_PASSWORD（App 專用密碼，appleid.apple.com 產生）
#   NOTARY_ENV_FILE=<檔案>           可省略：從這個檔（repo 外）讀上面的變數
#   APPLE_SIGN_IDENTITY             可省略：預設用鑰匙圈裡第一個「Developer ID Application」憑證
#
# entitlements.plist：公證一定要開 hardened runtime，而 hardened runtime 預設不准載入別的開發者簽的函式庫；
# libndi.dylib 是 NewTek 簽的 → 加 disable-library-validation（說明見 entitlements.plist）。
set -euo pipefail

INPUT="$1"
OUT="$2"
HERE="$(cd "$(dirname "$0")" && pwd)"
APP_NAME="Stage Previz NDI Helper.app"
ZIP_NAME="stage-previz-ndi-helper-mac.zip"
ENTITLEMENTS="$HERE/entitlements.plist"

if [ -n "${NOTARY_ENV_FILE:-}" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$NOTARY_ENV_FILE"
  set +a
fi

# ── 公證帳號 ──
if [ -n "${NOTARY_PROFILE:-}" ]; then
  NOTARY_AUTH=(--keychain-profile "$NOTARY_PROFILE")
elif [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ] && [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]; then
  NOTARY_AUTH=(--apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD")
else
  echo "需要 NOTARY_PROFILE，或 APPLE_ID + APPLE_TEAM_ID + APPLE_APP_SPECIFIC_PASSWORD（見檔案開頭說明）" >&2
  exit 2
fi

# ── 簽章憑證（用 SHA-1 指定，鑰匙圈裡同一張憑證出現兩次也不會 ambiguous）──
IDENTITY="${APPLE_SIGN_IDENTITY:-}"
if [ -z "$IDENTITY" ]; then
  IDENTITY="$(security find-identity -v -p codesigning | awk '/"Developer ID Application:/ { print $2; exit }')"
fi
if [ -z "$IDENTITY" ]; then
  echo "鑰匙圈裡找不到「Developer ID Application」憑證" >&2
  exit 2
fi
echo "簽章憑證：$(security find-identity -v -p codesigning | grep -m1 "$IDENTITY" || echo "$IDENTITY")"

WORK="$(mktemp -d -t ndi-helper-notarize)"
trap 'rm -rf "$WORK"' EXIT

# ── 準備 .app（不改動輸入檔）──
mkdir -p "$OUT"
APP="$OUT/$APP_NAME"
rm -rf "$APP"
case "$INPUT" in
  *.zip)
    # --noqtn：不要把下載來的 quarantine 標記帶進來
    ditto -x -k --noqtn "$INPUT" "$WORK/unzipped"
    ditto --noqtn "$WORK/unzipped/$APP_NAME" "$APP"
    ;;
  *.app | *.app/)
    ditto --noqtn "$INPUT" "$APP"
    ;;
  *)
    echo "輸入要是 .app 或 .zip：$INPUT" >&2
    exit 2
    ;;
esac
# codesign 不接受多餘的延伸屬性（Finder 資訊、quarantine…）
xattr -cr "$APP"
lipo -info "$APP/Contents/MacOS/stage-previz-ndi-helper"

# ── 簽章：hardened runtime + Apple timestamp（公證必要）。timestamp 伺服器偶爾失敗 → 重試 ──
for attempt in 1 2 3; do
  if codesign --force --options runtime --timestamp --entitlements "$ENTITLEMENTS" --sign "$IDENTITY" "$APP"; then
    break
  fi
  if [ "$attempt" = 3 ]; then
    echo "簽章失敗" >&2
    exit 1
  fi
  sleep "$attempt"
done
codesign --verify --strict --deep --verbose=2 "$APP"
codesign -d --verbose=2 "$APP" 2>&1 | grep -E '^(Authority|TeamIdentifier|Timestamp|Runtime Version|CodeDirectory)' || true
codesign -d --entitlements - "$APP" 2>/dev/null | grep -q disable-library-validation \
  || { echo "entitlements 沒簽進去" >&2; exit 1; }

# ── 公證（通常 1–5 分鐘）──
ditto -c -k --keepParent "$APP" "$WORK/submit.zip"
echo "送 Apple 公證…"
set +e
xcrun notarytool submit "$WORK/submit.zip" "${NOTARY_AUTH[@]}" --wait --output-format plist > "$WORK/submit.plist"
SUBMIT_EXIT=$?
set -e
STATUS="$(/usr/libexec/PlistBuddy -c 'Print status' "$WORK/submit.plist" 2>/dev/null || echo unknown)"
SUBMISSION_ID="$(/usr/libexec/PlistBuddy -c 'Print id' "$WORK/submit.plist" 2>/dev/null || echo '')"
echo "公證結果：$STATUS（id $SUBMISSION_ID）"
if [ "$STATUS" != "Accepted" ]; then
  cat "$WORK/submit.plist" >&2 || true
  if [ -n "$SUBMISSION_ID" ]; then
    xcrun notarytool log "$SUBMISSION_ID" "${NOTARY_AUTH[@]}" >&2 || true
  fi
  echo "公證沒過（exit $SUBMIT_EXIT）" >&2
  exit 1
fi

# ── staple：把公證票據釘在 App 上（使用者電腦離線也驗得過）──
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"
# Gatekeeper 實際判斷：要看到 source=Notarized Developer ID
spctl -a -vvv -t exec "$APP" 2>&1 | tee "$WORK/spctl.txt"
grep -q "Notarized Developer ID" "$WORK/spctl.txt" || { echo "Gatekeeper 沒認出公證" >&2; exit 1; }

rm -f "$OUT/$ZIP_NAME"
(cd "$OUT" && ditto -c -k --sequesterRsrc --keepParent "$APP_NAME" "$ZIP_NAME")
ls -la "$OUT"
echo "完成：$OUT/$ZIP_NAME"
