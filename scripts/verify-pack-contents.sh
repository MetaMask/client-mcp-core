#!/usr/bin/env bash

# Verify that `npm pack --dry-run` produces a tarball containing the iOS
# native source files required by lazy-build runtime, and excludes build
# artifacts that should never ship.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

cd "$REPO_ROOT"

if ! command -v jq >/dev/null 2>&1; then
    echo "❌ jq is required to verify pack contents" >&2
    exit 1
fi

REQUIRED_PATHS=(
    "ios-runner/AgentDeviceRunner.xctestplan"
    "ios-runner/AgentDeviceRunner/AgentDeviceRunner.xcodeproj/project.pbxproj"
    "ios-runner/AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests.swift"
    "ios-runner/AXSnapshot/Package.swift"
    "ios-runner/AXSnapshot/Sources/AXSnapshot/main.swift"
)

EXCLUDED_PREFIXES=(
    "ios-runner/AXSnapshot/.build"
    "ios-runner/AgentDeviceRunner/AgentDeviceRunner.xcodeproj/xcuserdata"
    "ios-runner/AgentDeviceRunner/AgentDeviceRunner.xcodeproj/project.xcworkspace/xcuserdata"
)

# `npm pack --dry-run` runs lifecycle scripts (including prepack) by default.
# We intentionally skip prepack here: it invokes `yarn build` and
# `yarn build:native:sanity`, neither of which is needed to enumerate the
# tarball file list. The SKIP_PREPACK env var is honored by scripts/prepack.sh.
PACK_OUTPUT=$(SKIP_PREPACK=true npm pack --dry-run --json 2>/dev/null)
FILES=$(echo "$PACK_OUTPUT" | jq -r '.[0].files[].path')

EXIT_CODE=0

for required in "${REQUIRED_PATHS[@]}"; do
    if ! echo "$FILES" | grep -qxF "$required"; then
        echo "❌ FAIL: required path missing from tarball: $required" >&2
        EXIT_CODE=1
    fi
done

for excluded in "${EXCLUDED_PREFIXES[@]}"; do
    matching=$(echo "$FILES" | grep -F "$excluded" || true)
    if [ -n "$matching" ]; then
        echo "❌ FAIL: excluded prefix present in tarball: $excluded" >&2
        echo "  Matching entries:" >&2
        echo "$matching" | sed 's/^/    /' >&2
        EXIT_CODE=1
    fi
done

if [ $EXIT_CODE -eq 0 ]; then
    echo "✅ OK: tarball contents match contract"
    echo "   Required paths: ${#REQUIRED_PATHS[@]} verified"
    echo "   Excluded prefixes: ${#EXCLUDED_PREFIXES[@]} verified absent"
fi

exit $EXIT_CODE
