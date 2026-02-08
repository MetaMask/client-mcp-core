#!/usr/bin/env bash
# Build the XCUITest runner for iOS simulator testing
# Caches build output at ~/.metamask-mcp/ios-runner/

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
RUNNER_DIR="$REPO_ROOT/ios-runner/AgentDeviceRunner"
CACHE_DIR="$HOME/.metamask-mcp/ios-runner"
CHECKSUM_FILE="$CACHE_DIR/.source-checksum"

# Check prerequisites
if ! command -v xcodebuild &>/dev/null; then
    echo "❌ xcodebuild not found. Please install Xcode."
    exit 1
fi

if [ ! -d "$RUNNER_DIR" ]; then
    echo "❌ Runner directory not found at $RUNNER_DIR"
    exit 1
fi

# Check if rebuild is needed (source checksum)
CURRENT_CHECKSUM=$(find "$RUNNER_DIR" -name "*.swift" -exec md5 -q {} \; | sort | md5 -q)
if [ -f "$CHECKSUM_FILE" ] && [ "$(cat "$CHECKSUM_FILE")" = "$CURRENT_CHECKSUM" ]; then
    echo "✅ Runner already built (source unchanged). Cache: $CACHE_DIR"
    exit 0
fi

echo "🔨 Building XCUITest runner..."
mkdir -p "$CACHE_DIR"

# Build for testing (creates .xctestrun file)
xcodebuild build-for-testing \
    -project "$RUNNER_DIR/AgentDeviceRunner.xcodeproj" \
    -scheme AgentDeviceRunnerUITests \
    -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
    -derivedDataPath "$CACHE_DIR/DerivedData" \
    2>&1 | tail -5

if [ $? -eq 0 ]; then
    echo "$CURRENT_CHECKSUM" > "$CHECKSUM_FILE"
    echo "✅ Runner built successfully. Cache: $CACHE_DIR"
else
    echo "❌ Build failed."
    exit 1
fi
