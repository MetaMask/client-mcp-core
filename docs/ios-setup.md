# iOS Mobile Support Setup Guide

This guide covers the prerequisites and setup steps for iOS mobile testing with MetaMask Mobile using the XCUITest runner.

## Overview

The iOS mobile support enables automated testing of MetaMask Mobile on iOS simulators using:
- **Xcode** - Apple's development environment
- **iOS Simulator** - Virtual iOS devices
- **XCUITest** - Apple's UI testing framework
- **MetaMask Mobile** - Built with Expo and Detox for E2E testing

## Prerequisites

### Required Software

#### 1. Xcode 15 or Later

Xcode is Apple's integrated development environment and is required for iOS development.

**Installation:**
- Download from [App Store](https://apps.apple.com/us/app/xcode/id497799835) (recommended)
- Or download from [Apple Developer](https://developer.apple.com/download/all/) (requires Apple ID)

**Verify Installation:**
```bash
xcodebuild -version
```

Expected output:
```
Xcode 15.0
Build version 15A240d
```

**Command Line Tools:**
After installing Xcode, ensure command-line tools are set:
```bash
sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer
```

#### 2. iOS Simulator Runtime (iOS 17+)

The iOS simulator runtime allows you to run virtual iOS devices on your Mac.

**Installation:**
1. Open Xcode
2. Go to **Xcode > Settings > Platforms**
3. Click the **+** button to add a new platform
4. Select **iOS** and download iOS 17 or later

**Verify Installation:**
```bash
xcrun simctl list runtimes | grep iOS
```

Expected output:
```
iOS 17.2 (17.2) -- com.apple.CoreSimulator.SimRuntime.iOS-17-2
iOS 18.0 (18.0) -- com.apple.CoreSimulator.SimRuntime.iOS-18-0
```

#### 3. Simulator Devices

Create at least one iOS simulator device for testing.

**Create a Device:**
```bash
# Create iPhone 15 with iOS 17.2
xcrun simctl create "iPhone 15" \
  com.apple.CoreSimulator.SimDeviceType.iPhone-15 \
  com.apple.CoreSimulator.SimRuntime.iOS-17-2
```

**List Available Devices:**
```bash
xcrun simctl list devices available
```

**Boot a Device:**
```bash
# Get device UDID from list above
xcrun simctl boot <device-udid>

# Or use device name
xcrun simctl boot "iPhone 15"
```

### Optional: MetaMask Mobile Repository

To build MetaMask Mobile for testing, you'll need the MetaMask Mobile repository.

**Setup:**
1. Clone the repository:
   ```bash
   git clone https://github.com/MetaMask/metamask-mobile.git
   cd metamask-mobile
   ```

2. Set the environment variable:
   ```bash
   export METAMASK_MOBILE_APP_PATH="/path/to/metamask-mobile"
   ```

3. Add to your shell profile (`~/.zshrc` or `~/.bash_profile`):
   ```bash
   export METAMASK_MOBILE_APP_PATH="/path/to/metamask-mobile"
   ```

## Validation

Run the prerequisite validation script to check your setup:

```bash
./scripts/validate-ios-prerequisites.sh
```

**Expected Output (All Checks Pass):**
```
==========================================
iOS Prerequisites Validation
==========================================

Checking Xcode installation...
✓ PASS - Xcode >= 15
  └─ Xcode 15.0 (Build: 15A240d)

Checking iOS simulator runtimes...
✓ PASS - iOS simulator runtime available
  └─ 2 runtime(s) available. Latest: iOS 18.0

Checking available simulator devices...
✓ PASS - Simulator devices available
  └─ 3 device(s) available. Example: iPhone 15

Checking for booted simulators...
✓ PASS - Booted simulator (optional)
  └─ 1 simulator(s) booted. Example: iPhone 15

Checking MetaMask Mobile app path...
✓ PASS - METAMASK_MOBILE_APP_PATH environment variable
  └─ /Users/username/metamask-mobile

==========================================
Summary
==========================================
Passed: 5
Failed: 0

All checks passed! ✓

Next steps:
1. Build MetaMask Mobile for simulator:
   cd $METAMASK_MOBILE_APP_PATH
   yarn build:ios:main:e2e

2. Run the XCUITest runner to execute tests
```

## Building MetaMask Mobile

Once prerequisites are validated, build MetaMask Mobile for the iOS simulator.

**Build Steps:**

1. Navigate to the MetaMask Mobile repository:
   ```bash
   cd $METAMASK_MOBILE_APP_PATH
   ```

2. Install dependencies:
   ```bash
   yarn install
   ```

3. Build for iOS simulator with E2E testing support:
   ```bash
   yarn build:ios:main:e2e
   ```

   This command:
   - Builds the MetaMask Mobile app for the iOS simulator
   - Includes Detox E2E testing framework
   - Generates the `.app` bundle for deployment

4. The built app will be located at:
   ```
   ios/build/Build/Products/Release-iphonesimulator/MetaMask.app
   ```

**Build Troubleshooting:**

| Issue | Solution |
|-------|----------|
| `Pod install` fails | Run `cd ios && pod install && cd ..` |
| Xcode build fails | Ensure Xcode command-line tools are set: `sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer` |
| Out of disk space | Clean build artifacts: `yarn clean:ios` |
| Simulator not found | Create a device: `xcrun simctl create "iPhone 15" com.apple.CoreSimulator.SimDeviceType.iPhone-15 com.apple.CoreSimulator.SimRuntime.iOS-17-2` |

## Running Tests

### Using the XCUITest Runner

The XCUITest runner executes tests on the iOS simulator using Apple's native testing framework.

**Basic Test Execution:**
```bash
# Run all tests
xcodebuild test-without-building \
  -scheme MetaMask \
  -destination 'platform=iOS Simulator,name=iPhone 15'

# Run specific test class
xcodebuild test-without-building \
  -scheme MetaMask \
  -destination 'platform=iOS Simulator,name=iPhone 15' \
  -only-testing MetaMaskUITests/SendFlowTests
```

### Using the MCP Server

The `@metamask/client-mcp-core` package provides MCP tools for iOS testing:

```typescript
import { createMcpServer, setSessionManager } from '@metamask/client-mcp-core';

// Implement ISessionManager with iOS-specific logic
class iOSSessionManager implements ISessionManager {
  // ... implementation
}

const sessionManager = new iOSSessionManager();
setSessionManager(sessionManager);

const server = createMcpServer({
  name: 'metamask-ios-mcp',
  version: '1.0.0',
});

await server.start();
```

## Troubleshooting

### Xcode Not Found

**Error:** `xcodebuild: command not found`

**Solution:**
1. Install Xcode from App Store
2. Set command-line tools:
   ```bash
   sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer
   ```
3. Verify:
   ```bash
   xcodebuild -version
   ```

### No iOS Runtimes Available

**Error:** `No iOS runtimes found`

**Solution:**
1. Open Xcode
2. Go to **Xcode > Settings > Platforms**
3. Click **+** to add iOS platform
4. Download iOS 17 or later
5. Verify:
   ```bash
   xcrun simctl list runtimes | grep iOS
   ```

### Simulator Device Not Found

**Error:** `No available simulator devices found`

**Solution:**
1. Create a new device:
   ```bash
   xcrun simctl create "iPhone 15" \
     com.apple.CoreSimulator.SimDeviceType.iPhone-15 \
     com.apple.CoreSimulator.SimRuntime.iOS-17-2
   ```

2. List devices:
   ```bash
   xcrun simctl list devices available
   ```

3. Boot the device:
   ```bash
   xcrun simctl boot "iPhone 15"
   ```

### MetaMask Mobile Build Fails

**Error:** `Build failed with exit code 1`

**Solution:**
1. Clean build artifacts:
   ```bash
   cd $METAMASK_MOBILE_APP_PATH
   yarn clean:ios
   ```

2. Reinstall dependencies:
   ```bash
   rm -rf node_modules ios/Pods
   yarn install
   cd ios && pod install && cd ..
   ```

3. Rebuild:
   ```bash
   yarn build:ios:main:e2e
   ```

### Simulator Crashes or Hangs

**Solution:**
1. Kill the simulator:
   ```bash
   xcrun simctl shutdown all
   ```

2. Erase and reset:
   ```bash
   xcrun simctl erase all
   ```

3. Reboot:
   ```bash
   xcrun simctl boot "iPhone 15"
   ```

## Testing Accessibility

MetaMask Mobile includes 4,553+ testIDs for accessibility testing. These can be used with the MCP tools:

```typescript
// Get all testIDs on current screen
const testIds = await mcpServer.call('mm_list_testids', { limit: 150 });

// Get accessibility tree with deterministic refs
const a11y = await mcpServer.call('mm_accessibility_snapshot', {});

// Click element by testID
await mcpServer.call('mm_click', { testId: 'send-button' });

// Click element by accessibility ref
await mcpServer.call('mm_click', { a11yRef: 'e5' });
```

## Resources

- [Apple Xcode Documentation](https://developer.apple.com/xcode/)
- [iOS Simulator Guide](https://developer.apple.com/documentation/xcode/running-your-app-in-the-simulator-or-on-a-device)
- [XCUITest Framework](https://developer.apple.com/documentation/xctest/user_interface_tests)
- [MetaMask Mobile Repository](https://github.com/MetaMask/metamask-mobile)
- [Detox E2E Testing](https://wix.github.io/Detox/)

## Next Steps

1. Run the validation script: `./scripts/validate-ios-prerequisites.sh`
2. Build MetaMask Mobile: `yarn build:ios:main:e2e`
3. Start the MCP server with iOS session manager
4. Begin writing tests using the MCP tools
