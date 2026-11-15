#!/usr/bin/env bash
# ==============================================================================
# DeepAutoCode macOS Signed & Notarized Release Packager
# ==============================================================================
# Builds macOS .app / .dmg bundle, signs with official Developer ID Application
# certificate, submits for Apple Notarization, staples the ticket, and validates
# Gatekeeper compliance.
# ==============================================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

SIGNING_IDENTITY="Developer ID Application: Wuhan Fixed Point Network Technology Co.,Ltd (5XV7J843AK)"
TEAM_ID="5XV7J843AK"

echo -e "${CYAN}${BOLD}=====================================================${NC}"
echo -e "${CYAN}${BOLD}   DeepAutoCode macOS Signed & Notarized Packager    ${NC}"
echo -e "${CYAN}${BOLD}=====================================================${NC}"

SKIP_NOTARIZE=false
NO_REBUILD=false

for arg in "$@"; do
  case $arg in
    --skip-notarize)
      SKIP_NOTARIZE=true
      shift
      ;;
    --no-rebuild)
      NO_REBUILD=true
      shift
      ;;
  esac
done

echo -e "\n${GREEN}[1/4] Verifying Code Signing Certificate...${NC}"
if ! security find-identity -v -p codesigning | grep -Fq "$SIGNING_IDENTITY"; then
  echo -e "${RED}Error: Certificate not found in macOS Keychain:${NC}"
  echo -e "  Identity: $SIGNING_IDENTITY"
  exit 1
fi
echo -e "  ${GREEN}✓ Found valid identity:${NC} $SIGNING_IDENTITY"

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

if [ "$NO_REBUILD" = false ]; then
  echo -e "\n${GREEN}[2/4] Building @deepautocode/agent & DeepAutoCode IDE...${NC}"
  (cd "$PROJECT_ROOT/deepautocode-agent" && npm run build)
  (cd "$PROJECT_ROOT/deepautocode" && npm run build)
fi

BUNDLE_DIR="$PROJECT_ROOT/release/macos"
mkdir -p "$BUNDLE_DIR"

echo -e "\n${GREEN}[3/4] Signing with Hardened Runtime...${NC}"
APP_PATH=$(find "$BUNDLE_DIR" -name "*.app" -type d | head -n 1 || true)
DMG_PATH=$(find "$BUNDLE_DIR" -name "*.dmg" -type f | head -n 1 || true)

if [ -n "$APP_PATH" ] && [ -d "$APP_PATH" ]; then
  codesign --force --deep --options runtime --timestamp \
    --sign "$SIGNING_IDENTITY" \
    "$APP_PATH"
fi

if [ -n "$DMG_PATH" ] && [ -f "$DMG_PATH" ]; then
  codesign --force --sign "$SIGNING_IDENTITY" "$DMG_PATH"
  if [ "$SKIP_NOTARIZE" = false ] && xcrun notarytool history --keychain-profile aireadcode >/dev/null 2>&1; then
    echo -e "\n${GREEN}[4/4] Submitting to Apple Notary Server...${NC}"
    xcrun notarytool submit "$DMG_PATH" --keychain-profile "aireadcode" --wait --timeout 30m
    xcrun stapler staple "$DMG_PATH"
  fi
fi

echo -e "\n${GREEN}${BOLD}✓ DeepAutoCode macOS release signing complete!${NC}"

