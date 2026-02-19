#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
RUNNER_DIR="$REPO_ROOT/ios-runner/AgentDeviceRunner"
PACKAGE_OUTPUT_DIR="${IOS_RUNNER_DERIVED_DATA_PATH:-$REPO_ROOT/ios-runner-derived-data}"
CHECKSUM_FILE="$PACKAGE_OUTPUT_DIR/.source-checksum"
BUILD_TMP_DIR="$REPO_ROOT/.ios-runner-build-tmp"

if [ "$(uname -s)" != "Darwin" ]; then
    echo "Skipping iOS runner build on non-macOS host"
    exit 0
fi

if ! command -v xcodebuild >/dev/null 2>&1; then
    echo "❌ xcodebuild not found. Please install Xcode."
    exit 1
fi

if [ ! -d "$RUNNER_DIR" ]; then
    echo "❌ Runner directory not found at $RUNNER_DIR"
    exit 1
fi

CURRENT_CHECKSUM=$(find "$RUNNER_DIR" \( -name "*.swift" -o -name "*.m" -o -name "*.h" \) -exec md5 -q {} \; | sort | md5 -q)
if [ -f "$CHECKSUM_FILE" ] && [ "$(cat "$CHECKSUM_FILE")" = "$CURRENT_CHECKSUM" ] && [ -d "$PACKAGE_OUTPUT_DIR/Build/Products" ]; then
    echo "✅ Runner already built (source unchanged): $PACKAGE_OUTPUT_DIR"
    exit 0
fi

echo "🔨 Building XCUITest runner..."
rm -rf "$BUILD_TMP_DIR"
mkdir -p "$BUILD_TMP_DIR"

xcodebuild build-for-testing \
    -project "$RUNNER_DIR/AgentDeviceRunner.xcodeproj" \
    -scheme AgentDeviceRunner \
    -destination 'platform=iOS Simulator,name=iPhone 16e' \
    -derivedDataPath "$BUILD_TMP_DIR" \
    2>&1 | tail -20

if [ ! -d "$BUILD_TMP_DIR/Build/Products" ]; then
    echo "❌ Build succeeded but Build/Products was not generated"
    exit 1
fi

rm -rf "$PACKAGE_OUTPUT_DIR"
mkdir -p "$PACKAGE_OUTPUT_DIR/Build"
cp -R "$BUILD_TMP_DIR/Build/Products" "$PACKAGE_OUTPUT_DIR/Build/Products"
rm -rf "$BUILD_TMP_DIR"

echo "$CURRENT_CHECKSUM" > "$CHECKSUM_FILE"
echo "✅ Runner built successfully: $PACKAGE_OUTPUT_DIR"
