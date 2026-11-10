#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
VERSIONS="$SCRIPT_DIR/tool-versions.json"

if [[ ! -f "$VERSIONS" ]]; then
  echo "Missing tool-versions.json" >&2
  exit 1
fi

VERSION="$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).pandoc)" "$VERSIONS")"
if [[ -z "$VERSION" ]]; then
  echo "tool-versions.json must define pandoc" >&2
  exit 1
fi

UNAME="$(uname -s)"
ARCH="$(uname -m)"
TOOLS_ROOT="$REPO_ROOT/.tools/pandoc"
VERSION_FILE="$TOOLS_ROOT/VERSION"

pandoc_bin() {
  case "$UNAME" in
    Darwin)
      if [[ "$ARCH" == arm64 ]]; then
        echo "$TOOLS_ROOT/mac/bin/pandoc"
      else
        echo "$TOOLS_ROOT/mac/bin/pandoc"
      fi
      ;;
    Linux)
      echo "$TOOLS_ROOT/linux/bin/pandoc"
      ;;
    *)
      echo "" >&2
      return 1
      ;;
  esac
}

TARGET="$(pandoc_bin || true)"
if [[ -z "$TARGET" ]]; then
  echo "ensure-pandoc.sh: unsupported OS $UNAME" >&2
  exit 0
fi

if [[ -x "$TARGET" && -f "$VERSION_FILE" && "$(cat "$VERSION_FILE")" == "$VERSION" ]]; then
  echo "Bundled pandoc $VERSION already at $TARGET"
  exit 0
fi

mkdir -p "$TOOLS_ROOT"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

case "$UNAME" in
  Darwin)
    if [[ "$ARCH" == arm64 ]]; then
      ARCH_TAG=arm64
    else
      ARCH_TAG=x86_64
    fi
    ZIP="pandoc-${VERSION}-${ARCH_TAG}-macOS.zip"
    URL="https://github.com/jgm/pandoc/releases/download/${VERSION}/${ZIP}"
    curl -fL "$URL" -o "$TMP/$ZIP"
    unzip -q "$TMP/$ZIP" -d "$TMP/extract"
    mkdir -p "$TOOLS_ROOT/mac"
    rm -rf "$TOOLS_ROOT/mac"/*
    # Zip layout: pandoc-x.y/bin/pandoc
    SRC="$(find "$TMP/extract" -type f -name pandoc | head -n 1)"
    if [[ -z "$SRC" ]]; then
      echo "pandoc binary not found in $ZIP" >&2
      exit 1
    fi
    mkdir -p "$TOOLS_ROOT/mac/bin"
    cp "$SRC" "$TOOLS_ROOT/mac/bin/pandoc"
    chmod +x "$TOOLS_ROOT/mac/bin/pandoc"
    ;;
  Linux)
    TAR="pandoc-${VERSION}-linux-amd64.tar.gz"
    URL="https://github.com/jgm/pandoc/releases/download/${VERSION}/${TAR}"
    curl -fL "$URL" -o "$TMP/$TAR"
    mkdir -p "$TOOLS_ROOT/linux"
    rm -rf "$TOOLS_ROOT/linux"/*
    tar -xzf "$TMP/$TAR" -C "$TOOLS_ROOT/linux" --strip-components=1
    chmod +x "$TOOLS_ROOT/linux/bin/pandoc" 2>/dev/null || true
    ;;
esac

echo -n "$VERSION" > "$VERSION_FILE"
echo "Installed bundled pandoc $VERSION at $(pandoc_bin)"
