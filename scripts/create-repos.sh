#!/usr/bin/env bash
# DeepAutoCode Dual-Repository Initialization Script (v1.1)
# ADR-002: Only maintain two primary repositories:
#   1. deepautocode        (IDE Workbench / Code - OSS Fork / Webview UI / Docs)
#   2. deepautocode-agent  (Cline SDK Runtime Integration / Bridge / Providers)
# Note: deepautocode-models and deepautocode-docs are merged into the two repositories above.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

REPOS=(
  "deepautocode"
  "deepautocode-agent"
)

echo "=== DeepAutoCode v1.1 Repository Bootstrapper ==="
echo "Workspace root: ${ROOT_DIR}"

# Create deepautocode directory structure
mkdir -p "${ROOT_DIR}/deepautocode"/{product,src,extensions,webview,docs,build,scripts,.github/workflows}

# Create deepautocode-agent directory structure
mkdir -p "${ROOT_DIR}/deepautocode-agent"/{src/runtime,src/bridge,src/capabilities,providers,tests,docs,.github/workflows}

for repo in "${REPOS[@]}"; do
  REPO_PATH="${ROOT_DIR}/${repo}"
  if [ ! -d "${REPO_PATH}/.git" ]; then
    echo "Initializing Git repository: ${repo}"
    git init "${REPO_PATH}"
  else
    echo "Git repository already initialized: ${repo}"
  fi
done

echo "=== Done: 2 repositories initialized (deepautocode, deepautocode-agent) ==="

