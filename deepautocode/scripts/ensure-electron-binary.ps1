param(
  [string]$PackageRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'

$electronDir = Join-Path $PackageRoot 'node_modules\electron'
$electronExe = Join-Path $electronDir 'dist\electron.exe'

if (Test-Path $electronExe) {
  exit 0
}

if (-not (Test-Path (Join-Path $electronDir 'package.json'))) {
  Write-Error "electron package is missing under $electronDir (run npm install first)."
}

$version = (Get-Content (Join-Path $electronDir 'package.json') -Raw | ConvertFrom-Json).version
if (-not $env:ELECTRON_MIRROR) {
  $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
}

Push-Location $electronDir
try {
  & node install.js
  if (Test-Path $electronExe) {
    exit 0
  }
} catch {
  Write-Warning "node install.js failed: $_"
} finally {
  Pop-Location
}

Write-Host "Retrying Electron download with curl (works better behind some proxies)..."

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
$zipName = "electron-v${version}-win32-${arch}.zip"
$zipPath = Join-Path $env:TEMP $zipName
$mirror = $env:ELECTRON_MIRROR.TrimEnd('/')
$url = "$mirror/v$version/$zipName"

& curl.exe --ssl-no-revoke -fL $url -o $zipPath
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $zipPath)) {
  Write-Error "curl failed to download $url (exit $LASTEXITCODE)."
}

$dist = Join-Path $electronDir 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null
if (Test-Path $dist) {
  Get-ChildItem $dist -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}
Expand-Archive -Path $zipPath -DestinationPath $dist -Force

Set-Content -Path (Join-Path $electronDir 'path.txt') -NoNewline -Value 'electron.exe'
Set-Content -Path (Join-Path $dist 'version') -NoNewline -Value "v$version"

if (-not (Test-Path $electronExe)) {
  Write-Error "Electron binary still missing after extract: $electronExe"
}

exit 0
