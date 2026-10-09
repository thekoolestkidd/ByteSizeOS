# ============================================================================
# publish-portable.ps1 - build a shareable copy of ByteSize OS.
#
# Produces:   dist\ByteSizeOS-portable-win-x64.zip
#
# The ZIP is fully self-contained: your friend only needs to unzip it and
# double-click ByteSizeOS.exe. No .NET install, no Visual Studio.
#
# (The WebView2 Runtime - preinstalled on Windows 11 and virtually every
# updated Windows 10 - is still required. If it's missing, the app itself
# shows a one-click download link, so don't worry about it up front.)
#
# Usage:  powershell -ExecutionPolicy Bypass -File tools\publish-portable.ps1
# ============================================================================

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# The OS keeps its sandbox next to the exe; stop a running copy so the
# build output isn't locked.
Get-Process -Name ByteSizeOS -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 400

$out = Join-Path $root "bin\portable"
$dist = Join-Path $root "dist"

if (Test-Path $out)  { Remove-Item $out -Recurse -Force }
if (-not (Test-Path $dist)) { New-Item $dist -ItemType Directory -Force | Out-Null }

Write-Host "Publishing Release win-x64 (self-contained, single file)..." -ForegroundColor Cyan
dotnet publish ByteSizeOS.csproj -c Release -r win-x64 --self-contained true `
  -p:PublishSingleFile=true -o $out -v quiet | Out-Null
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed" }

$zip = Join-Path $dist "ByteSizeOS-portable-win-x64.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }

Write-Host "Zipping..." -ForegroundColor Cyan
Compress-Archive -Path (Join-Path $out "*") -DestinationPath $zip -CompressionLevel Optimal

$size = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host ""
Write-Host "Done! Send this file to your friend:" -ForegroundColor Green
Write-Host ("  {0}  ({1} MB zip)" -f $zip, $size)
Write-Host ""
Write-Host "Friend instructions:" -ForegroundColor Yellow
Write-Host "  1. Unzip anywhere (e.g. Documents\ByteSizeOS)."
Write-Host "  2. Double-click ByteSizeOS.exe."
Write-Host "  3. That's it - the OS creates its own little storage folder next to the exe."