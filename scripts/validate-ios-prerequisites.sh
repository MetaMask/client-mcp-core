#!/bin/bash

# iOS Prerequisites Validation Script
# Checks all required tools and configurations for iOS development with MetaMask Mobile

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Counters
PASSED=0
FAILED=0

# Helper function to print check result
print_check() {
  local check_name=$1
  local status=$2
  local details=$3

  if [ "$status" = "PASS" ]; then
    echo -e "${GREEN}✓ PASS${NC} - $check_name"
    if [ -n "$details" ]; then
      echo "  └─ $details"
    fi
    ((PASSED++))
  else
    echo -e "${RED}✗ FAIL${NC} - $check_name"
    if [ -n "$details" ]; then
      echo "  └─ $details"
    fi
    ((FAILED++))
  fi
}

echo "=========================================="
echo "iOS Prerequisites Validation"
echo "=========================================="
echo ""

# Check 1: Xcode Installation and Version
echo "Checking Xcode installation..."
if command -v xcodebuild &> /dev/null; then
  XCODE_VERSION=$(xcodebuild -version | head -1)
  XCODE_BUILD_VERSION=$(xcodebuild -version | grep "Build version" | awk '{print $3}')
  
  # Extract major version number
  MAJOR_VERSION=$(echo "$XCODE_VERSION" | awk '{print $2}' | cut -d. -f1)
  
  if [ "$MAJOR_VERSION" -ge 15 ]; then
    print_check "Xcode >= 15" "PASS" "$XCODE_VERSION (Build: $XCODE_BUILD_VERSION)"
  else
    print_check "Xcode >= 15" "FAIL" "Found $XCODE_VERSION, but Xcode 15+ is required"
  fi
else
  print_check "Xcode >= 15" "FAIL" "xcodebuild not found. Install Xcode from App Store or https://developer.apple.com"
fi

echo ""

# Check 2: iOS Simulator Runtimes
echo "Checking iOS simulator runtimes..."
if command -v xcrun &> /dev/null; then
  RUNTIMES=$(timeout 10 xcrun simctl list runtimes 2>/dev/null | grep "iOS" || true)
  
  if [ -z "$RUNTIMES" ]; then
    print_check "iOS simulator runtime available" "FAIL" "No iOS runtimes found. Install via Xcode > Settings > Platforms"
  else
    # Count available iOS runtimes
    RUNTIME_COUNT=$(echo "$RUNTIMES" | wc -l)
    LATEST_RUNTIME=$(echo "$RUNTIMES" | tail -1 | grep -oE "iOS [0-9]+\.[0-9]+" || echo "unknown")
    print_check "iOS simulator runtime available" "PASS" "$RUNTIME_COUNT runtime(s) available. Latest: $LATEST_RUNTIME"
  fi
else
  print_check "iOS simulator runtime available" "FAIL" "xcrun not found. Ensure Xcode is properly installed"
fi

echo ""

# Check 3: Simulator Devices
echo "Checking available simulator devices..."
if command -v xcrun &> /dev/null; then
  DEVICES=$(timeout 10 xcrun simctl list devices available 2>/dev/null | grep -E "iPhone|iPad" | grep -v "unavailable" || true)
  
  if [ -z "$DEVICES" ]; then
    print_check "Simulator devices available" "FAIL" "No available simulator devices found. Create one via Xcode or: xcrun simctl create 'iPhone 15' com.apple.CoreSimulator.SimDeviceType.iPhone-15 com.apple.CoreSimulator.SimRuntime.iOS-17-2"
  else
    DEVICE_COUNT=$(echo "$DEVICES" | wc -l)
    FIRST_DEVICE=$(echo "$DEVICES" | head -1 | sed 's/^[[:space:]]*//')
    print_check "Simulator devices available" "PASS" "$DEVICE_COUNT device(s) available. Example: $FIRST_DEVICE"
  fi
else
  print_check "Simulator devices available" "FAIL" "xcrun not found"
fi

echo ""

# Check 4: Booted Simulators (Optional - not required, but helpful)
echo "Checking for booted simulators..."
if command -v xcrun &> /dev/null; then
  BOOTED=$(timeout 10 xcrun simctl list devices booted 2>/dev/null | grep -E "iPhone|iPad" || true)
  
  if [ -z "$BOOTED" ]; then
    print_check "Booted simulator (optional)" "FAIL" "No simulator currently booted. Start one with: xcrun simctl boot <device-udid>"
  else
    BOOTED_COUNT=$(echo "$BOOTED" | wc -l)
    FIRST_BOOTED=$(echo "$BOOTED" | head -1 | sed 's/^[[:space:]]*//')
    print_check "Booted simulator (optional)" "PASS" "$BOOTED_COUNT simulator(s) booted. Example: $FIRST_BOOTED"
  fi
else
  print_check "Booted simulator (optional)" "FAIL" "xcrun not found"
fi

echo ""

# Check 5: MetaMask Mobile App Path (Optional)
echo "Checking MetaMask Mobile app path..."
if [ -n "$METAMASK_MOBILE_APP_PATH" ]; then
  if [ -d "$METAMASK_MOBILE_APP_PATH" ]; then
    print_check "METAMASK_MOBILE_APP_PATH environment variable" "PASS" "$METAMASK_MOBILE_APP_PATH"
  else
    print_check "METAMASK_MOBILE_APP_PATH environment variable" "FAIL" "Path does not exist: $METAMASK_MOBILE_APP_PATH"
  fi
else
  print_check "METAMASK_MOBILE_APP_PATH environment variable" "FAIL" "Not set. Set it to the MetaMask Mobile repository path"
fi

echo ""

# Summary
echo "=========================================="
echo "Summary"
echo "=========================================="
echo -e "${GREEN}Passed: $PASSED${NC}"
echo -e "${RED}Failed: $FAILED${NC}"
echo ""

if [ $FAILED -eq 0 ]; then
  echo -e "${GREEN}All checks passed! ✓${NC}"
  echo ""
  echo "Next steps:"
  echo "1. Build MetaMask Mobile for simulator:"
  echo "   cd \$METAMASK_MOBILE_APP_PATH"
  echo "   yarn build:ios:main:e2e"
  echo ""
  echo "2. Run the XCUITest runner to execute tests"
  echo ""
  exit 0
else
  echo -e "${RED}Some checks failed. Please fix the issues above.${NC}"
  echo ""
  echo "For detailed setup instructions, see: docs/ios-setup.md"
  echo ""
  exit 1
fi
