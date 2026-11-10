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
set "DEPS_OK=1"
if not exist "%~dp0deepautocode\node_modules\tsx\dist\cli.mjs" set "DEPS_OK=0"
if not exist "%~dp0deepautocode\node_modules\vite\bin\vite.js" set "DEPS_OK=0"
if not exist "%~dp0deepautocode\node_modules\typescript\bin\tsc" set "DEPS_OK=0"
if "%DEPS_OK%"=="0" (
  echo Installing deepautocode dependencies...
  cd /d "%~dp0deepautocode"
  call npm.cmd install --ignore-scripts
  if errorlevel 1 (
    echo npm install failed — try closing programs that lock node_modules, then run again.
    pause
    exit /b 1
  )
)
if not exist "%~dp0deepautocode\node_modules\electron\dist\electron.exe" (
  echo Downloading Electron binary via mirror...
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deepautocode\scripts\ensure-electron-binary.ps1"
  if errorlevel 1 (
    echo Electron download failed — check proxy/VPN or run ensure-electron-binary.ps1 manually.
    pause
    exit /b 1
  )
)
if not exist "%~dp0.tools\pandoc\win\pandoc.exe" (
  echo Ensuring bundled pandoc for Markdown/PDF export...
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deepautocode\scripts\ensure-pandoc.ps1" -RepoRoot "%~dp0."
  if errorlevel 1 (
    echo Pandoc download failed — Agent can still write .md; run: cd deepautocode ^&^& npm run ensure:pandoc
  )
)
echo Building deepautocode webview (so UI fixes are always fresh)...
cd /d "%~dp0deepautocode"
call npm.cmd run build:webview
if errorlevel 1 (
  echo build:webview failed.
  pause
  exit /b 1
)
if not exist "%~dp0deepautocode\dist\src" (
  echo Building deepautocode host...
  call npm.cmd run build:host
  if errorlevel 1 (
    echo build:host failed.
    pause
    exit /b 1
  )
)

echo Starting DeepAutoCode v1.1 Desktop IDE...
cd /d "%~dp0deepautocode"
call npm.cmd run desktop
pause
