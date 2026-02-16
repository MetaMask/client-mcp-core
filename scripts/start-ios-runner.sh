#!/usr/bin/env bash
# Start the XCUITest runner and output the port
# The runner starts an HTTP server on a dynamic port

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
DERIVED_DATA="${IOS_RUNNER_DERIVED_DATA_PATH:-$REPO_ROOT/ios-runner-derived-data}"

if [ ! -d "$DERIVED_DATA" ]; then
    LEGACY_DERIVED_DATA="$HOME/.metamask-mcp/ios-runner/DerivedData"
    if [ -d "$LEGACY_DERIVED_DATA" ]; then
        DERIVED_DATA="$LEGACY_DERIVED_DATA"
    fi
fi

if [ ! -d "$DERIVED_DATA" ]; then
    echo "❌ Runner not built. Run scripts/build-ios-runner.sh first."
    exit 1
fi

# Find the xctestrun file
XCTESTRUN_FILE=$(find "$DERIVED_DATA" -name "*.xctestrun" -type f | head -1)
if [ -z "$XCTESTRUN_FILE" ]; then
    echo "❌ No .xctestrun file found. Rebuild the runner."
    exit 1
fi

echo "🚀 Starting XCUITest runner..."
echo "📋 Using: $XCTESTRUN_FILE"

# Start xcodebuild test-without-building
# The runner will print AGENT_DEVICE_RUNNER_PORT=<port> when ready
xcodebuild test-without-building \
    -xctestrun "$XCTESTRUN_FILE" \
    -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
    2>&1 | while IFS= read -r line; do
        echo "$line"
        if [[ "$line" == *"AGENT_DEVICE_RUNNER_PORT="* ]]; then
            PORT=$(echo "$line" | grep -o 'AGENT_DEVICE_RUNNER_PORT=[0-9]*' | cut -d= -f2)
            echo ""
            echo "✅ Runner ready on port: $PORT"
            echo "RUNNER_PORT=$PORT"
        fi
    done
