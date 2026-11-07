@echo off
chcp 65001 >nul
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
echo Cleaning up any stale DeepAutoCode backend on port 3840 and previous Electron window...
powershell -NoProfile -Command "Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*DeepAu*oCode*' } | Stop-Process -Force -ErrorAction SilentlyContinue; $pids = Get-NetTCPConnection -LocalPort 3840,3841 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique; foreach ($p in $pids) { if ($p -gt 0) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue } }; Remove-Item -Recurse -Force \"$env:APPDATA\Electron\Cache\",\"$env:APPDATA\Electron\Code Cache\" -ErrorAction SilentlyContinue"

if not exist "%~dp0deepautocode-agent\node_modules" (
  echo Installing deepautocode-agent dependencies...
  cd /d "%~dp0deepautocode-agent"
  call npm.cmd install
)
if not exist "%~dp0deepautocode-agent\dist" (
  echo Building deepautocode-agent...
  cd /d "%~dp0deepautocode-agent"
  call npm.cmd run build
)
if not exist "%~dp0deepautocode\node_modules\.bin\tsx.cmd" (
  echo Installing deepautocode dependencies...
  cd /d "%~dp0deepautocode"
  call npm.cmd install
)
if not exist "%~dp0deepautocode\node_modules\electron\dist\electron.exe" (
  echo Downloading Electron binary via mirror...
  cd /d "%~dp0deepautocode"
  node node_modules\electron\install.js
)
if not exist "%~dp0deepautocode\dist\webview" (
  echo Building deepautocode webview and host...
  cd /d "%~dp0deepautocode"
  call npm.cmd run build
)

echo Starting DeepAutoCode v1.1 Desktop IDE...
cd /d "%~dp0deepautocode"
call npm.cmd run desktop
pause
