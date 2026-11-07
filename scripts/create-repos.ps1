# DeepAutoCode Dual-Repository Initialization Script (v1.1 - PowerShell)
# ADR-002: Only maintain two primary repositories:
#   1. deepautocode        (IDE Workbench / Code - OSS Fork / Webview UI / Docs)
#   2. deepautocode-agent  (Cline SDK Runtime Integration / Bridge / Providers)

$ErrorActionPreference = "Stop"
$RootDir = Split-Path -Parent $PSScriptRoot

$IdeDirs = @(
    "product",
    "src",
    "extensions",
    "webview",
    "docs",
    "build",
    "scripts",
    ".github/workflows"
)

$AgentDirs = @(
    "src/runtime",
    "src/bridge",
    "src/capabilities",
    "providers",
    "tests",
    "docs",
    ".github/workflows"
)

foreach ($dir in $IdeDirs) {
    New-Item -ItemType Directory -Force -Path (Join-Path "$RootDir\deepautocode" $dir) | Out-Null
}

foreach ($dir in $AgentDirs) {
    New-Item -ItemType Directory -Force -Path (Join-Path "$RootDir\deepautocode-agent" $dir) | Out-Null
}

foreach ($repo in @("deepautocode", "deepautocode-agent")) {
    $repoPath = Join-Path $RootDir $repo
    if (-not (Test-Path (Join-Path $repoPath ".git"))) {
        git init $repoPath | Out-Null
        Write-Host "Initialized Git repository: $repo"
    } else {
        Write-Host "Git repository already initialized: $repo"
    }
}

Write-Host "=== Done: 2 repositories initialized (deepautocode, deepautocode-agent) ==="

