#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
AX_DIR="$REPO_ROOT/ios-runner/AXSnapshot"
BUILD_DIR="$AX_DIR/.build"
CACHE_STAMP="$BUILD_DIR/axsnapshot-source-root"
OUTPUT_BIN="$AX_DIR/.build/release/axsnapshot"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "Skipping AXSnapshot build on non-macOS host"
  exit 0
fi

if [ ! -f "$AX_DIR/Package.swift" ]; then
  echo "❌ AXSnapshot package not found at $AX_DIR"
  exit 1
fi

if [ -d "$BUILD_DIR" ]; then
  cached_root=""
  if [ -f "$CACHE_STAMP" ]; then
    cached_root="$(<"$CACHE_STAMP")"
  fi

  if [ "$cached_root" != "$AX_DIR" ]; then
    echo "🧹 Cleaning stale AXSnapshot SwiftPM cache..."
    rm -rf "$BUILD_DIR"
  fi
fi

echo "🔨 Building AXSnapshot binary..."
swift build -c release --package-path "$AX_DIR"

if [ ! -x "$OUTPUT_BIN" ]; then
  echo "❌ Build completed but axsnapshot binary missing or not executable at $OUTPUT_BIN"
  exit 1
fi

printf '%s\n' "$AX_DIR" > "$CACHE_STAMP"

echo "✅ AXSnapshot binary ready: $OUTPUT_BIN"
