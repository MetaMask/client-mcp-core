#!/usr/bin/env bash
# iOS Integration Test Script
#
# Runs a simple end-to-end integration test for the iOS platform support.
# This script is macOS-only and requires:
#   - Xcode 15+ with iOS simulator runtimes
#   - A booted simulator (or one will be booted)
#   - The XCUITest runner built via scripts/build-ios-runner.sh
#
# This script is NOT intended for CI — it requires a macOS machine with
# Xcode and simulator access.
#
# Usage:
#   ./scripts/test-ios-integration.sh [--device-udid <UDID>]
#
# If --device-udid is not provided, the script will use the first booted
# simulator or boot the first available iPhone simulator.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
DERIVED_DATA="${IOS_RUNNER_DERIVED_DATA_PATH:-$REPO_ROOT/ios-runner-derived-data}"
if [ ! -d "$DERIVED_DATA" ] && [ -d "$HOME/.metamask-mcp/ios-runner/DerivedData" ]; then
    DERIVED_DATA="$HOME/.metamask-mcp/ios-runner/DerivedData"
fi
RUNNER_PID=""
RUNNER_PORT=""
DEVICE_UDID=""

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

cleanup() {
    echo ""
    echo "🧹 Cleaning up..."

    if [ -n "$RUNNER_PID" ] && kill -0 "$RUNNER_PID" 2>/dev/null; then
        echo "  Stopping runner (PID: $RUNNER_PID)..."
        kill "$RUNNER_PID" 2>/dev/null || true
        wait "$RUNNER_PID" 2>/dev/null || true
    fi

    echo -e "${GREEN}✓ Cleanup complete${NC}"
}

trap cleanup EXIT

parse_args() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            --device-udid)
                DEVICE_UDID="$2"
                shift 2
                ;;
            *)
                echo "Unknown option: $1"
                echo "Usage: $0 [--device-udid <UDID>]"
                exit 1
                ;;
        esac
    done
}

# Step 1: Validate prerequisites
step_validate_prerequisites() {
    echo "=========================================="
    echo "Step 1: Validate Prerequisites"
    echo "=========================================="

    if ! bash "$SCRIPT_DIR/validate-ios-prerequisites.sh"; then
        echo -e "${RED}Prerequisites check failed. Aborting.${NC}"
        exit 1
    fi
    echo ""
}

# Step 2: Boot simulator if needed
step_boot_simulator() {
    echo "=========================================="
    echo "Step 2: Boot Simulator"
    echo "=========================================="

    if [ -n "$DEVICE_UDID" ]; then
        echo "Using provided device UDID: $DEVICE_UDID"
        BOOTED_STATE=$(xcrun simctl list devices | grep "$DEVICE_UDID" | grep -c "Booted" || true)
        if [ "$BOOTED_STATE" -eq 0 ]; then
            echo "Booting device $DEVICE_UDID..."
            xcrun simctl boot "$DEVICE_UDID"
            sleep 5
        else
            echo "Device already booted."
        fi
    else
        BOOTED_UDID=$(xcrun simctl list devices booted -j | python3 -c "
import json, sys
data = json.load(sys.stdin)
for runtime, devices in data.get('devices', {}).items():
    for d in devices:
        if d.get('state') == 'Booted':
            print(d['udid'])
            sys.exit(0)
" 2>/dev/null || true)

        if [ -n "$BOOTED_UDID" ]; then
            DEVICE_UDID="$BOOTED_UDID"
            echo "Using already-booted simulator: $DEVICE_UDID"
        else
            echo "No booted simulator found. Booting first available iPhone..."
            DEVICE_UDID=$(xcrun simctl list devices available -j | python3 -c "
import json, sys
data = json.load(sys.stdin)
for runtime, devices in data.get('devices', {}).items():
    if 'iOS' not in runtime:
        continue
    for d in devices:
        if 'iPhone' in d.get('name', ''):
            print(d['udid'])
            sys.exit(0)
print('')
" 2>/dev/null || true)

            if [ -z "$DEVICE_UDID" ]; then
                echo -e "${RED}No available iPhone simulator found. Create one first.${NC}"
                exit 1
            fi

            echo "Booting simulator: $DEVICE_UDID"
            xcrun simctl boot "$DEVICE_UDID"
            sleep 5
        fi
    fi

    echo -e "${GREEN}✓ Simulator ready: $DEVICE_UDID${NC}"
    echo ""
}

# Step 3: Build XCUITest runner
step_build_runner() {
    echo "=========================================="
    echo "Step 3: Build XCUITest Runner"
    echo "=========================================="

    bash "$SCRIPT_DIR/build-ios-runner.sh"
    echo ""
}

# Step 4: Start XCUITest runner
step_start_runner() {
    echo "=========================================="
    echo "Step 4: Start XCUITest Runner"
    echo "=========================================="

    XCTESTRUN_FILE=$(find "$DERIVED_DATA" -name "*.xctestrun" -type f | head -1)
    if [ -z "$XCTESTRUN_FILE" ]; then
        echo -e "${RED}No .xctestrun file found. Build may have failed.${NC}"
        exit 1
    fi

    echo "Starting runner with: $XCTESTRUN_FILE"

    xcodebuild test-without-building \
        -xctestrun "$XCTESTRUN_FILE" \
        -destination "platform=iOS Simulator,id=$DEVICE_UDID" \
        > /tmp/ios-runner-output.log 2>&1 &
    RUNNER_PID=$!

    echo "Runner started (PID: $RUNNER_PID). Waiting for port..."

    TIMEOUT=60
    ELAPSED=0
    while [ $ELAPSED -lt $TIMEOUT ]; do
        if grep -q "AGENT_DEVICE_RUNNER_PORT=" /tmp/ios-runner-output.log 2>/dev/null; then
            RUNNER_PORT=$(grep -o 'AGENT_DEVICE_RUNNER_PORT=[0-9]*' /tmp/ios-runner-output.log | head -1 | cut -d= -f2)
            break
        fi

        if ! kill -0 "$RUNNER_PID" 2>/dev/null; then
            echo -e "${RED}Runner process exited unexpectedly.${NC}"
            cat /tmp/ios-runner-output.log
            exit 1
        fi

        sleep 1
        ELAPSED=$((ELAPSED + 1))
    done

    if [ -z "$RUNNER_PORT" ]; then
        echo -e "${RED}Runner did not emit port within ${TIMEOUT}s.${NC}"
        cat /tmp/ios-runner-output.log
        exit 1
    fi

    echo -e "${GREEN}✓ Runner ready on port: $RUNNER_PORT${NC}"
    echo ""
}

# Step 5: Run test sequence
step_run_tests() {
    echo "=========================================="
    echo "Step 5: Run Integration Tests"
    echo "=========================================="

    local BASE_URL="http://127.0.0.1:$RUNNER_PORT/command"
    local TESTS_PASSED=0
    local TESTS_FAILED=0

    run_test() {
        local test_name=$1
        local payload=$2
        local response

        echo -n "  Testing $test_name... "
        response=$(curl -s -X POST "$BASE_URL" \
            -H "Content-Type: application/json" \
            -d "$payload" \
            --max-time 30 2>&1)

        if echo "$response" | python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get('ok') else 1)" 2>/dev/null; then
            echo -e "${GREEN}PASS${NC}"
            ((TESTS_PASSED++))
        else
            echo -e "${RED}FAIL${NC}"
            echo "    Response: $response"
            ((TESTS_FAILED++))
        fi
    }

    run_test "healthcheck" '{"command":"healthcheck"}'
    run_test "snapshot" '{"command":"snapshot"}'
    run_test "screenshot" '{"command":"screenshot"}'

    echo ""
    echo "Results: ${TESTS_PASSED} passed, ${TESTS_FAILED} failed"

    if [ "$TESTS_FAILED" -gt 0 ]; then
        echo -e "${RED}Some tests failed!${NC}"
        return 1
    fi

    echo -e "${GREEN}✓ All integration tests passed${NC}"
    echo ""
}

# Main
main() {
    parse_args "$@"

    echo ""
    echo "╔══════════════════════════════════════════╗"
    echo "║   iOS Integration Test Suite             ║"
    echo "║   @metamask/client-mcp-core              ║"
    echo "╚══════════════════════════════════════════╝"
    echo ""

    step_validate_prerequisites
    step_boot_simulator
    step_build_runner
    step_start_runner
    step_run_tests

    echo "=========================================="
    echo -e "${GREEN}Integration test complete ✓${NC}"
    echo "=========================================="
}

main "$@"
