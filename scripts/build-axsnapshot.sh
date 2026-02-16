#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
AX_DIR="$REPO_ROOT/ios-runner/AXSnapshot"
OUTPUT_DIR="$REPO_ROOT/dist/bin"
OUTPUT_BIN="$OUTPUT_DIR/axsnapshot"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "Skipping AXSnapshot build on non-macOS host"
  exit 0
fi

if [ ! -f "$AX_DIR/Package.swift" ]; then
  echo "❌ AXSnapshot package not found at $AX_DIR"
  exit 1
fi

echo "🔨 Building AXSnapshot binary..."
swift build -c release --package-path "$AX_DIR"

mkdir -p "$OUTPUT_DIR"
cp -f "$AX_DIR/.build/release/axsnapshot" "$OUTPUT_BIN"
chmod +x "$OUTPUT_BIN"

echo "✅ AXSnapshot binary ready: $OUTPUT_BIN"
