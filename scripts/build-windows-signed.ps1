# DeepAutoCode Windows Signed Release Packager
param(
    [switch]$NoRebuild
)

$ErrorActionPreference = "Stop"

Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "  DeepAutoCode Windows Release Packager  " -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan

$repoRoot = Split-Path -Parent $PSScriptRoot
$agentDir = Join-Path $repoRoot "deepautocode-agent"
$ideDir   = Join-Path $repoRoot "deepautocode"
$releaseRoot = Join-Path $repoRoot "release"
$unpackedDir = Join-Path $releaseRoot "win-unpacked"
$bundleDir   = Join-Path $releaseRoot "bundle\nsis"

# 1. Ensure signtool in PATH
$signtoolDir = "C:\Program Files (x86)\Windows Kits\10\bin\x64"
if ($env:Path -notlike "*$signtoolDir*") {
    $env:Path = "$signtoolDir;" + $env:Path
}

# 2. Check Code Signing Certificate
$thumbprint = "FEEFF01058543A90FD2119C07947368FD7A03494"
$cert = Get-ChildItem -Path Cert:\CurrentUser\My | Where-Object { $_.Thumbprint -eq $thumbprint } | Select-Object -First 1

if (-not $cert) {
    Write-Error "Certificate not found in Cert:\CurrentUser\My (Thumbprint: $thumbprint)!"
    exit 1
}

Write-Host "[1/5] Code signing certificate verified:" -ForegroundColor Green
Write-Host "  Subject: $($cert.Subject)"
Write-Host "  Expires: $($cert.NotAfter)"
Write-Host "  HasPrivateKey: $($cert.HasPrivateKey)"

# 3. Build Agent & IDE Release
if (-not $NoRebuild) {
    Write-Host "`n[2/5] Building @deepautocode/agent & DeepAutoCode IDE..." -ForegroundColor Green
    Push-Location $agentDir
    try {
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw "deepautocode-agent build failed ($LASTEXITCODE)" }
    } finally {
        Pop-Location
    }

    Push-Location $ideDir
    try {
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw "deepautocode build failed ($LASTEXITCODE)" }
    } finally {
        Pop-Location
    }
} else {
    Write-Host "`n[2/5] Skipping build step (-NoRebuild enabled)..." -ForegroundColor Yellow
}

# 4. Assemble Standalone Electron Application Bundle
Write-Host "`n[3/5] Assembling standalone Electron application bundle..." -ForegroundColor Green
$electronDist = Join-Path $ideDir "node_modules\electron\dist"
if (-not (Test-Path (Join-Path $electronDist "electron.exe"))) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ideDir "scripts\ensure-electron-binary.ps1")
}

if (Test-Path $unpackedDir) {
    Remove-Item -Recurse -Force $unpackedDir
}
New-Item -ItemType Directory -Force -Path $unpackedDir | Out-Null
New-Item -ItemType Directory -Force -Path $bundleDir | Out-Null

# Copy Electron runtime
Copy-Item -Path (Join-Path $electronDist "*") -Destination $unpackedDir -Recurse -Force

# Remove default Electron placeholder app
$defaultAsar = Join-Path $unpackedDir "resources\default_app.asar"
if (Test-Path $defaultAsar) {
    Remove-Item -Force $defaultAsar
}

# Rename electron.exe -> DeepAutoCode.exe
$mainExe = Join-Path $unpackedDir "DeepAutoCode.exe"
Move-Item -Path (Join-Path $unpackedDir "electron.exe") -Destination $mainExe -Force

# Apply icon and version metadata via rcedit if available
$rceditCandidates = @(
    "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0\rcedit-x64.exe",
    "$env:LOCALAPPDATA\Programs\Antigravity IDE\resources\app\node_modules\rcedit\bin\rcedit.exe"
)
$rceditExe = $rceditCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
$iconIco = Join-Path $ideDir "assets\logo.ico"

if ($rceditExe -and (Test-Path $iconIco)) {
    Write-Host "  Applying brand icon & version info via rcedit..." -ForegroundColor Gray
    & $rceditExe $mainExe `
        --set-icon $iconIco `
        --set-version-string "ProductName" "DeepAutoCode" `
        --set-version-string "FileDescription" "DeepAutoCode AI Native IDE" `
        --set-version-string "CompanyName" "Wuhan Fixed Point Network Technology Co.,Ltd" `
        --set-version-string "LegalCopyright" "Copyright (c) 2026 DeepAutoCode" `
        --set-version-string "OriginalFilename" "DeepAutoCode.exe" `
        --set-file-version "1.1.0" `
        --set-product-version "1.1.0"
}

# Populate resources/app
$appDir = Join-Path $unpackedDir "resources\app"
New-Item -ItemType Directory -Force -Path $appDir | Out-Null

Copy-Item -Path (Join-Path $ideDir "package.json") -Destination (Join-Path $appDir "package.json") -Force
Copy-Item -Path (Join-Path $ideDir "LICENSE")      -Destination (Join-Path $appDir "LICENSE")      -Force -ErrorAction SilentlyContinue
Copy-Item -Path (Join-Path $ideDir "electron")     -Destination (Join-Path $appDir "electron")     -Recurse -Force
Copy-Item -Path (Join-Path $ideDir "dist")         -Destination (Join-Path $appDir "dist")         -Recurse -Force
Copy-Item -Path (Join-Path $ideDir "assets")       -Destination (Join-Path $appDir "assets")       -Recurse -Force
Copy-Item -Path (Join-Path $ideDir "product")      -Destination (Join-Path $appDir "product")      -Recurse -Force
Copy-Item -Path (Join-Path $ideDir "docs")         -Destination (Join-Path $appDir "docs")         -Recurse -Force

# Copy runtime node_modules (@deepautocode/agent, ws, zod, typescript)
$appNodeModules = Join-Path $appDir "node_modules"
$appAgentPkg    = Join-Path $appNodeModules "@deepautocode\agent"
New-Item -ItemType Directory -Force -Path $appAgentPkg | Out-Null

Copy-Item -Path (Join-Path $agentDir "package.json") -Destination (Join-Path $appAgentPkg "package.json") -Force
Copy-Item -Path (Join-Path $agentDir "dist")         -Destination (Join-Path $appAgentPkg "dist")         -Recurse -Force
Copy-Item -Path (Join-Path $agentDir "providers")    -Destination (Join-Path $appAgentPkg "providers")    -Recurse -Force

foreach ($dep in @("ws", "zod", "typescript")) {
    $srcDep = Join-Path $ideDir "node_modules\$dep"
    if (Test-Path $srcDep) {
        Copy-Item -Path $srcDep -Destination (Join-Path $appNodeModules $dep) -Recurse -Force
    }
}

# Sign DeepAutoCode.exe before packaging into NSIS installer
$tsUrl = "http://timestamp.sectigo.com"
Write-Host "  Signing inner executable: DeepAutoCode.exe..." -ForegroundColor Yellow
& signtool.exe sign /sha1 $thumbprint /fd sha256 /tr $tsUrl /td sha256 $mainExe
if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to sign $mainExe"
    exit $LASTEXITCODE
}

# 5. Build NSIS Installer & Sign Release Bundles
Write-Host "`n[4/5] Building and signing NSIS Setup Installer..." -ForegroundColor Green
$makensisCandidates = @(
    "$env:LOCALAPPDATA\tauri\NSIS\makensis.exe",
    "$env:LOCALAPPDATA\electron-builder\Cache\nsis\nsis-3.0.4.1\makensis.exe",
    "C:\Program Files (x86)\NSIS\makensis.exe"
)
$makensis = $makensisCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $makensis) {
    Write-Error "makensis.exe not found!"
    exit 1
}

$setupVersioned = Join-Path $bundleDir "DeepAutoCode-Setup-v1.1.0.exe"
$setupStandard  = Join-Path $bundleDir "DeepAutoCode_1.1.0_x64-setup.exe"
$nsiPath        = Join-Path $releaseRoot "installer.nsi"
$licenseFile    = Join-Path $repoRoot "LICENSE"

$nsiContent = @"
Unicode True
!include "MUI2.nsh"

Name "DeepAutoCode v1.1.0"
OutFile "$setupVersioned"
InstallDir "`$LOCALAPPDATA\Programs\DeepAutoCode"
InstallDirRegKey HKCU "Software\DeepAutoCode" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma

!define MUI_ICON "$iconIco"
!define MUI_UNICON "$iconIco"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "`$INSTDIR\DeepAutoCode.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Launch DeepAutoCode AI IDE"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Section "DeepAutoCode IDE" SecMain
  SetOutPath "`$INSTDIR"
  File /r "$unpackedDir\*.*"

  WriteRegStr HKCU "Software\DeepAutoCode" "InstallDir" "`$INSTDIR"
  WriteUninstaller "`$INSTDIR\Uninstall DeepAutoCode.exe"

  CreateDirectory "`$SMPROGRAMS\DeepAutoCode"
  CreateShortCut "`$SMPROGRAMS\DeepAutoCode\DeepAutoCode.lnk" "`$INSTDIR\DeepAutoCode.exe" "" "`$INSTDIR\DeepAutoCode.exe" 0
  CreateShortCut "`$DESKTOP\DeepAutoCode.lnk" "`$INSTDIR\DeepAutoCode.exe" "" "`$INSTDIR\DeepAutoCode.exe" 0

  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DeepAutoCode" "DisplayName" "DeepAutoCode AI IDE"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DeepAutoCode" "UninstallString" '"`$INSTDIR\Uninstall DeepAutoCode.exe"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DeepAutoCode" "DisplayIcon" "`$INSTDIR\DeepAutoCode.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DeepAutoCode" "Publisher" "Wuhan Fixed Point Network Technology Co.,Ltd"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DeepAutoCode" "DisplayVersion" "1.1.0"
SectionEnd

Section "Uninstall"
  Delete "`$DESKTOP\DeepAutoCode.lnk"
  RMDir /r "`$SMPROGRAMS\DeepAutoCode"
  RMDir /r "`$INSTDIR"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DeepAutoCode"
  DeleteRegKey HKCU "Software\DeepAutoCode"
SectionEnd
"@

Set-Content -Path $nsiPath -Value $nsiContent -Encoding UTF8
& $makensis /V2 $nsiPath
if ($LASTEXITCODE -ne 0) {
    Write-Error "NSIS installer compilation failed with code $LASTEXITCODE"
    exit $LASTEXITCODE
}

Copy-Item -Path $setupVersioned -Destination $setupStandard -Force

$filesToSign = @($setupVersioned, $setupStandard)
foreach ($f in $filesToSign) {
    $item = Get-Item $f
    Write-Host "  Signing installer: $($item.Name)..." -ForegroundColor Yellow
    & signtool.exe sign /sha1 $thumbprint /fd sha256 /tr $tsUrl /td sha256 $item.FullName
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to sign $($item.FullName)"
        exit $LASTEXITCODE
    }
}

# 6. Output Summary Report
Write-Host "`n[5/5] Release packaging complete! Artifacts report:" -ForegroundColor Cyan
Write-Host "----------------------------------------------------------------------"
$allArtifacts = @(
    (Get-Item $mainExe),
    (Get-Item $setupVersioned),
    (Get-Item $setupStandard)
)

foreach ($art in $allArtifacts) {
    $sig = Get-AuthenticodeSignature $art.FullName
    $sizeMb = [math]::Round($art.Length / 1MB, 2)
    $color = if ($sig.Status -eq "Valid") { "Green" } else { "Red" }
    Write-Host "  File Name: $($art.Name)" -ForegroundColor White
    Write-Host "  Path:      $($art.FullName)"
    Write-Host "  Size:      $sizeMb MB"
    Write-Host "  Signature: $($sig.Status) ($($sig.StatusMessage))" -ForegroundColor $color
    if ($sig.SignerCertificate) {
        Write-Host "  Signer:    $($sig.SignerCertificate.Subject)"
    }
    if ($sig.TimeStamperCertificate) {
        Write-Host "  Timestamp: $($sig.TimeStamperCertificate.Subject)"
    }
    Write-Host "----------------------------------------------------------------------"
}

Write-Host "Windows release artifacts are successfully built and signed!" -ForegroundColor Green

