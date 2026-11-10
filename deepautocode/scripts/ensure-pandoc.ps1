param(
  [string]$RepoRoot = (Split-Path (Split-Path -Parent $PSScriptRoot) -Parent)
)

$ErrorActionPreference = 'Stop'

$versionsPath = Join-Path $PSScriptRoot 'tool-versions.json'
if (-not (Test-Path $versionsPath)) {
  Write-Error "Missing tool-versions.json at $versionsPath"
}
$version = (Get-Content $versionsPath -Raw | ConvertFrom-Json).pandoc
if (-not $version) {
  Write-Error "tool-versions.json must define pandoc version"
}

$destDir = Join-Path $RepoRoot '.tools\pandoc\win'
$pandocExe = Join-Path $destDir 'pandoc.exe'
$versionFile = Join-Path $RepoRoot '.tools\pandoc\VERSION'

if ((Test-Path $pandocExe) -and (Test-Path $versionFile)) {
  $installed = (Get-Content $versionFile -Raw).Trim()
  if ($installed -eq $version) {
    Write-Host "Bundled pandoc $version already present at $pandocExe"
    exit 0
  }
}

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x86_64' }
# Pandoc publishes win x86_64 zip; runs on ARM64 Windows via emulation.
if ($arch -eq 'arm64') {
  Write-Host "Note: using pandoc windows-x86_64 build on ARM64."
  $arch = 'x86_64'
}

$zipName = "pandoc-$version-windows-$arch.zip"
$zipPath = Join-Path $env:TEMP $zipName
$url = "https://github.com/jgm/pandoc/releases/download/$version/$zipName"

Write-Host "Downloading pandoc $version from $url ..."
New-Item -ItemType Directory -Force -Path $destDir | Out-Null

& curl.exe --ssl-no-revoke -fL $url -o $zipPath
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $zipPath)) {
  Write-Error "curl failed to download pandoc (exit $LASTEXITCODE). Check proxy or set HTTPS_PROXY."
}

$stage = Join-Path $env:TEMP "pandoc-$version-extract"
if (Test-Path $stage) {
  Remove-Item -Recurse -Force $stage
}
New-Item -ItemType Directory -Force -Path $stage | Out-Null
Expand-Archive -Path $zipPath -DestinationPath $stage -Force

$found = Get-ChildItem -Path $stage -Recurse -Filter 'pandoc.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $found) {
  Write-Error "pandoc.exe not found inside $zipName"
}

Copy-Item -Path $found.FullName -Destination $pandocExe -Force
Set-Content -Path $versionFile -NoNewline -Value $version
Write-Host "Installed bundled pandoc at $pandocExe"
exit 0
