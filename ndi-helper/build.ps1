# Stage Previz NDI Helper — Windows build script
#
# 用法：
#   .\build.ps1            → 編 release exe（最快、不建 MSI）
#   .\build.ps1 -Msi       → 編 + 用 cargo-wix 包成 .msi（需要先 cargo install cargo-wix）
#   .\build.ps1 -Run       → 編 + 跑（dev 測試用）
#
# 需求：
#   1. Rust toolchain（https://rustup.rs/）
#   2. NDI Tools 安裝（不然 helper 跑起來找不到 SDK）
#   3. turbojpeg：vcpkg install libjpeg-turbo:x64-windows
#   4. （MSI only）WiX Toolset v3.x（cargo wix 自動下）

param(
    [switch]$Msi,
    [switch]$Run,
    [switch]$Verbose
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "── Stage Previz NDI Helper Build ──" -ForegroundColor Cyan

# 確認 cargo 在 PATH
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    Write-Host "❌ cargo 不在 PATH。請先裝 Rust：https://rustup.rs/" -ForegroundColor Red
    exit 1
}

Write-Host "🔨 Building release..." -ForegroundColor Yellow
$cargoArgs = @("build", "--release")
if ($Verbose) { $cargoArgs += "--verbose" }
& cargo @cargoArgs
if ($LASTEXITCODE -ne 0) { Write-Host "❌ Build failed" -ForegroundColor Red; exit 1 }

$exe = Join-Path $PSScriptRoot "target\release\stage-previz-ndi-helper.exe"
if (-not (Test-Path $exe)) {
    Write-Host "❌ Build succeeded but exe not found: $exe" -ForegroundColor Red
    exit 1
}
$size = [math]::Round((Get-Item $exe).Length / 1MB, 2)
Write-Host "✅ Built: $exe ($size MB)" -ForegroundColor Green

if ($Msi) {
    if (-not (Get-Command cargo-wix -ErrorAction SilentlyContinue)) {
        Write-Host "🔧 cargo-wix 沒裝，現在安裝..." -ForegroundColor Yellow
        cargo install cargo-wix
        if ($LASTEXITCODE -ne 0) { Write-Host "❌ cargo-wix install failed" -ForegroundColor Red; exit 1 }
    }
    # 第一次跑要 init
    if (-not (Test-Path "wix\main.wxs")) {
        Write-Host "📝 cargo wix init（第一次）..." -ForegroundColor Yellow
        cargo wix init --force
    }
    Write-Host "📦 Building MSI..." -ForegroundColor Yellow
    cargo wix --no-build
    if ($LASTEXITCODE -ne 0) { Write-Host "❌ MSI build failed" -ForegroundColor Red; exit 1 }
    $msi = Get-ChildItem "target\wix\*.msi" | Select-Object -First 1
    if ($msi) {
        $msiSize = [math]::Round($msi.Length / 1MB, 2)
        Write-Host "✅ MSI: $($msi.FullName) ($msiSize MB)" -ForegroundColor Green
    }
}

if ($Run) {
    Write-Host "🚀 Running helper..." -ForegroundColor Yellow
    & $exe
}
