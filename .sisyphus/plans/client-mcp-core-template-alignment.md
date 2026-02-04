# Align client-mcp-core with MetaMask Module Template

## TL;DR

> **Quick Summary**: Migrate the client-mcp-core repository infrastructure to comply with the MetaMask module template, enabling npm publishing under the @metamask organization. This involves updating build tooling (tsc → ts-bridge), test framework (Jest → Vitest), linting (ESLint v9 flat config), and adding full CI/CD automation.
>
> **Deliverables**:
>
> - Dual ESM/CJS build output via ts-bridge
> - Vitest test framework with coverage thresholds (auto-updated based on current coverage)
> - MetaMask ESLint v9 flat config
> - Complete GitHub Actions CI/CD suite (build, lint, test, release, publish)
> - TypeDoc documentation scaffolding
> - CHANGELOG.md in Keep a Changelog format
> - LavaMoat allow-scripts security configuration
>
> **Estimated Effort**: Large (3-5 days)
> **Parallel Execution**: YES - 5 waves
> **Critical Path**: Task 1 → Task 2 → Task 4 → Task 11 → Task 14

---

## Context

### Original Request

Update the client-mcp-core repository to follow the MetaMask module template (https://github.com/MetaMask/metamask-module-template). This is a requirement to publish the package under @metamask org on npm.

### Interview Summary

**Key Discussions**:

- Test coverage threshold: Use Vitest's `autoUpdate: true` to set realistic thresholds based on current coverage (can increase to 100% later as tests are added)
- CI/CD scope: Full suite including release automation
- Test migration: Convert existing Jest tests to Vitest
- Version: Keep 0.1.0 (early development indicator)

**Research Findings**:

- MetaMask template requires dual ESM/CJS builds via ts-bridge
- Must use Vitest (not Jest) with coverage thresholds
- ESLint v9+ with flat config and MetaMask-specific configs
- 7 GitHub Actions workflows for complete CI/CD
- LavaMoat allow-scripts plugin for supply chain security
- @arethetypeswrong/cli for export validation

### Metis Review

**Identified Gaps** (addressed):

- Jest migration edge cases: Reviewed test files, found minimal Jest-specific features
- Multi-entry point handling: Package has single entry point at `src/index.ts`
- Existing test coverage baseline: Will document before migration
- LavaMoat policy generation: Will use auto-generation, not manual

---

## Work Objectives

### Core Objective

Make client-mcp-core compliant with MetaMask module template standards for npm publishing under @metamask organization.

### Concrete Deliverables

- Updated `package.json` with proper exports, scripts, dependencies
- TypeScript configs: `tsconfig.json`, `tsconfig.build.json`, `tsconfig.test.json`
- ESLint v9 flat config: `eslint.config.mjs`
- Vitest config: `vitest.config.mts`
- Prettier config: `.prettierrc.mjs`
- TypeDoc config: `typedoc.json`
- Dependency checker: `.depcheckrc.json`
- Yarn constraints: `yarn.config.cjs`
- Yarn config: `.yarnrc.yml` with LavaMoat plugin
- Build scripts: `scripts/get.sh`, `scripts/prepack.sh`
- GitHub workflows: `main.yml`, `build-lint-test.yml`, `create-release-pr.yml`, `publish-release.yml`, `publish-docs.yml`
- GitHub config: `CODEOWNERS`, `dependabot.yml`, `pull_request_template.md`
- Documentation: `CHANGELOG.md`, `.nvmrc`
- Migrated test files from Jest to Vitest syntax
- Deleted: `jest.config.js`

### Definition of Done

- [x] `yarn build` produces `dist/` with ESM (.mjs) and CJS (.cjs) outputs
- [x] `yarn attw --pack .` reports no export errors
- [x] `yarn test` passes with coverage thresholds (thresholds auto-set based on current coverage)
- [x] `yarn lint` passes with zero errors
- [x] `npm publish --dry-run` succeeds
- [~] GitHub Actions workflow passes on push (BLOCKED: requires actual PR/push to GitHub to verify)

### Must Have

- Dual ESM/CJS build output
- Vitest coverage enforcement (thresholds based on current coverage, with `autoUpdate: true` to ratchet up)
- MetaMask ESLint configuration
- Full GitHub Actions CI/CD
- LavaMoat allow-scripts security

### Must NOT Have (Guardrails)

- **NO source code logic changes** - only import/export syntax for ESM compatibility
- **NO new features** - infrastructure only
- **NO fixing existing lint errors** as part of this migration (create separate backlog)
- **NO test coverage improvements** beyond migrating existing tests
- **NO verbatim template copying** - adapt to actual package structure
- **NO manual LavaMoat policy crafting** - use auto-generation only

---

## Verification Strategy (MANDATORY)

> **UNIVERSAL RULE: ZERO HUMAN INTERVENTION**
>
> ALL tasks in this plan MUST be verifiable WITHOUT any human action.
> This is NOT conditional — it applies to EVERY task, regardless of test strategy.

### Test Decision

- **Infrastructure exists**: YES (Jest currently)
- **Automated tests**: YES (migrate to Vitest)
- **Framework**: Vitest with @vitest/coverage-istanbul
- **Coverage thresholds**: Auto-set based on current coverage with `autoUpdate: true`

### Agent-Executed QA Scenarios (MANDATORY — ALL tasks)

**Verification Tool by Deliverable Type:**

| Type                | Tool | How Agent Verifies           |
| ------------------- | ---- | ---------------------------- |
| **Build output**    | Bash | `yarn build && ls -la dist/` |
| **Type exports**    | Bash | `yarn attw --pack .`         |
| **Test coverage**   | Bash | `yarn test --coverage`       |
| **Lint**            | Bash | `yarn lint`                  |
| **Package publish** | Bash | `npm publish --dry-run`      |

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately):
├── Task 1: Update package.json foundation
├── Task 7: Create .nvmrc and .editorconfig
└── Task 9: Create CHANGELOG.md

Wave 2 (After Wave 1):
├── Task 2: Create TypeScript configs (depends: 1)
├── Task 3: Create Yarn config with LavaMoat (depends: 1)
├── Task 5: Create ESLint flat config (depends: 1)
├── Task 6: Create Prettier config (depends: 1)
└── Task 8: Create supporting config files (depends: 1)

Wave 3 (After Wave 2):
├── Task 4: Create Vitest config (depends: 2)
└── Task 10: Create build scripts (depends: 2, 3)

Wave 4 (After Wave 3):
├── Task 11: Migrate Jest tests to Vitest (depends: 4)
├── Task 12: Create GitHub workflows (depends: 10)
└── Task 13: Create GitHub config files (depends: 12)

Wave 5 (Final):
└── Task 14: Final verification and cleanup (depends: all)

Critical Path: Task 1 → Task 2 → Task 4 → Task 11 → Task 14
```

### Dependency Matrix

| Task | Depends On | Blocks        | Can Parallelize With |
| ---- | ---------- | ------------- | -------------------- |
| 1    | None       | 2, 3, 5, 6, 8 | 7, 9                 |
| 2    | 1          | 4, 10         | 3, 5, 6, 8           |
| 3    | 1          | 10            | 2, 5, 6, 8           |
| 4    | 2          | 11            | 10                   |
| 5    | 1          | 14            | 2, 3, 6, 8           |
| 6    | 1          | 14            | 2, 3, 5, 8           |
| 7    | None       | 14            | 1, 9                 |
| 8    | 1          | 14            | 2, 3, 5, 6           |
| 9    | None       | 14            | 1, 7                 |
| 10   | 2, 3       | 12            | 4                    |
| 11   | 4          | 14            | 12                   |
| 12   | 10         | 13            | 11                   |
| 13   | 12         | 14            | None                 |
| 14   | All        | None          | None                 |

---

## TODOs

- [x] 1. Update package.json with MetaMask template structure

  **What to do**:
  - Update `engines` field to `"node": "^20 || ^22 || >=24"`
  - Add `sideEffects: false`
  - Add complete `exports` field with dual ESM/CJS mappings
  - Update `main`, `module`, `types` fields for dual build
  - Add `files: ["dist"]`
  - Add `publishConfig` with `"access": "public"` and registry
  - Update `packageManager` to exact Yarn 4 version
  - Add all required `scripts` (build, lint, test, etc.)
  - Add `lavamoat` configuration object
  - Add all required devDependencies (~25 packages)
  - Remove Jest-related dependencies

  **Must NOT do**:
  - Change production dependencies
  - Modify version number (keep 0.1.0)
  - Change package name or description

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Configuration file update, well-defined structure
  - **Skills**: [`git-master`]
    - `git-master`: For atomic commit after changes

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 7, 9)
  - **Blocks**: Tasks 2, 3, 5, 6, 8
  - **Blocked By**: None (can start immediately)

  **References**:
  - **Pattern Reference**: MetaMask module template package.json structure at https://github.com/MetaMask/metamask-module-template/blob/main/package.json
  - **Current File**: `/Users/joaotavares/Documents/projects/consensys/client-mcp-core/package.json` - current configuration to preserve name, version, description, dependencies

  **Acceptance Criteria**:
  - [x] `node -e "const p = require('./package.json'); console.log(p.engines.node)"` outputs `^20 || ^22 || >=24`
  - [x] `node -e "const p = require('./package.json'); console.log(Object.keys(p.exports || {}).length > 0)"` outputs `true`
  - [x] `node -e "const p = require('./package.json'); console.log(p.publishConfig?.access)"` outputs `public`
  - [x] `node -e "const p = require('./package.json'); console.log(!!p.devDependencies?.['@ts-bridge/cli'])"` outputs `true`
  - [x] `node -e "const p = require('./package.json'); console.log(!!p.devDependencies?.vitest)"` outputs `true`

  **Commit**: YES
  - Message: `chore: update package.json for MetaMask template compliance`
  - Files: `package.json`
  - Pre-commit: `node -e "require('./package.json')"`

---

- [x] 2. Create TypeScript configuration files

  **What to do**:
  - Update `tsconfig.json` base config with MetaMask template settings
  - Update `tsconfig.build.json` for ts-bridge build
  - Create `tsconfig.test.json` for Vitest type checking

  **Must NOT do**:
  - Change compiler output behavior that breaks existing code
  - Remove existing strict settings

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Configuration file creation, well-defined structure
  - **Skills**: [`git-master`]

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 3, 5, 6, 8)
  - **Blocks**: Tasks 4, 10
  - **Blocked By**: Task 1

  **References**:
  - **Pattern Reference**: https://github.com/MetaMask/metamask-module-template/blob/main/tsconfig.json
  - **Current File**: `/Users/joaotavares/Documents/projects/consensys/client-mcp-core/tsconfig.json` - preserve existing strict settings

  **Acceptance Criteria**:
  - [x] File exists: `test -f tsconfig.json && echo "exists"`
  - [x] File exists: `test -f tsconfig.build.json && echo "exists"`
  - [x] File exists: `test -f tsconfig.test.json && echo "exists"`
  - [x] `npx tsc --project tsconfig.json --noEmit` exits with code 0

  **Commit**: YES
  - Message: `chore: update TypeScript configs for MetaMask template`
  - Files: `tsconfig.json`, `tsconfig.build.json`, `tsconfig.test.json`
  - Pre-commit: `npx tsc --project tsconfig.json --noEmit`

---

- [x] 3. Configure Yarn with LavaMoat allow-scripts plugin

  **What to do**:
  - Update `.yarnrc.yml` with full MetaMask template configuration
  - Download and add LavaMoat allow-scripts plugin to `.yarn/plugins/`
  - Configure enableScripts, nodeLinker, telemetry settings
  - Add npmMinimalAgeGate and npmPreapprovedPackages

  **Must NOT do**:
  - Change node_modules linker (keep node-modules)
  - Add unnecessary plugins

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Configuration file, well-defined structure
  - **Skills**: [`git-master`]

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 2, 5, 6, 8)
  - **Blocks**: Task 10
  - **Blocked By**: Task 1

  **References**:
  - **Pattern Reference**: https://github.com/MetaMask/metamask-module-template/blob/main/.yarnrc.yml
  - **Plugin Source**: https://raw.githubusercontent.com/LavaMoat/LavaMoat/main/packages/yarn-plugin-allow-scripts/bundles/@yarnpkg/plugin-allow-scripts.js

  **Acceptance Criteria**:
  - [x] File exists: `test -f .yarnrc.yml && echo "exists"`
  - [x] Plugin exists: `test -f .yarn/plugins/@yarnpkg/plugin-allow-scripts.cjs && echo "exists"`
  - [x] `grep -q "enableScripts" .yarnrc.yml && echo "found"`
  - [x] `grep -q "plugin-allow-scripts" .yarnrc.yml && echo "found"`

  **Commit**: YES
  - Message: `chore: configure Yarn with LavaMoat allow-scripts plugin`
  - Files: `.yarnrc.yml`, `.yarn/plugins/@yarnpkg/plugin-allow-scripts.cjs`
  - Pre-commit: `test -f .yarnrc.yml`

---

- [x] 4. Create Vitest configuration

  **What to do**:
  - Create `vitest.config.mts` with MetaMask template settings
  - Configure coverage with `autoUpdate: true` to set thresholds based on current coverage
  - Configure istanbul coverage provider
  - Enable type checking with tsconfig.test.json
  - Set test include pattern for `src/**/*.test.ts`
  - Note: Current repo has 56 source files but only 4 test files, so initial thresholds will be low but will ratchet up as coverage improves

  **Must NOT do**:
  - Add test setup that doesn't exist
  - Configure browser environment (this is Node.js only)
  - Set 100% thresholds (use autoUpdate instead - current coverage is low)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Configuration file, well-defined structure
  - **Skills**: [`git-master`]

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 10)
  - **Blocks**: Task 11
  - **Blocked By**: Task 2

  **References**:
  - **Pattern Reference**: https://github.com/MetaMask/metamask-module-template/blob/main/vitest.config.mts
  - **Existing Tests** (4 files total):
    - `/Users/joaotavares/Documents/projects/consensys/client-mcp-core/src/mcp-server/tokenization.test.ts`
    - `/Users/joaotavares/Documents/projects/consensys/client-mcp-core/src/mcp-server/session-manager.test.ts`
    - `/Users/joaotavares/Documents/projects/consensys/client-mcp-core/src/mcp-server/tools/batch.test.ts`
    - `/Users/joaotavares/Documents/projects/consensys/client-mcp-core/src/mcp-server/tools/definitions.test.ts`

  **Acceptance Criteria**:
  - [x] File exists: `test -f vitest.config.mts && echo "exists"`
  - [x] `grep -q "thresholds" vitest.config.mts && echo "found"`
  - [x] `grep -q "autoUpdate" vitest.config.mts && echo "found"`

  **Commit**: YES
  - Message: `chore: add Vitest configuration with auto-updating coverage thresholds`
  - Files: `vitest.config.mts`
  - Pre-commit: `test -f vitest.config.mts`

---

- [x] 5. Create ESLint v9 flat configuration

  **What to do**:
  - Create `eslint.config.mjs` with MetaMask ESLint configs
  - Import and configure @metamask/eslint-config, nodejs, typescript, vitest
  - Configure ignores for dist/, docs/, .yarn/
  - Set up TypeScript parser options

  **Must NOT do**:
  - Fix existing lint errors (will be separate backlog)
  - Add custom rules beyond MetaMask defaults

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Configuration file, well-defined structure
  - **Skills**: [`git-master`]

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 2, 3, 6, 8)
  - **Blocks**: Task 14
  - **Blocked By**: Task 1

  **References**:
  - **Pattern Reference**: https://github.com/MetaMask/metamask-module-template/blob/main/eslint.config.mjs

  **Acceptance Criteria**:
  - [x] File exists: `test -f eslint.config.mjs && echo "exists"`
  - [x] `grep -q "@metamask/eslint-config" eslint.config.mjs && echo "found"`
  - [x] `grep -q "vitest" eslint.config.mjs && echo "found"`

  **Commit**: YES
  - Message: `chore: add ESLint v9 flat config with MetaMask presets`
  - Files: `eslint.config.mjs`
  - Pre-commit: `test -f eslint.config.mjs`

---

- [x] 6. Create Prettier configuration

  **What to do**:
  - Create `.prettierrc.mjs` with MetaMask template settings
  - Configure singleQuote, tabWidth, trailingComma
  - Add prettier-plugin-packagejson

  **Must NOT do**:
  - Add plugins that aren't in the template

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Simple configuration file
  - **Skills**: [`git-master`]

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 2, 3, 5, 8)
  - **Blocks**: Task 14
  - **Blocked By**: Task 1

  **References**:
  - **Pattern Reference**: https://github.com/MetaMask/metamask-module-template/blob/main/.prettierrc.mjs

  **Acceptance Criteria**:
  - [x] File exists: `test -f .prettierrc.mjs && echo "exists"`
  - [x] `grep -q "singleQuote" .prettierrc.mjs && echo "found"`
  - [x] `grep -q "prettier-plugin-packagejson" .prettierrc.mjs && echo "found"`

  **Commit**: YES
  - Message: `chore: add Prettier configuration`
  - Files: `.prettierrc.mjs`
  - Pre-commit: `test -f .prettierrc.mjs`

---

- [x] 7. Create .nvmrc and update .editorconfig

  **What to do**:
  - Create `.nvmrc` with `lts/*`
  - Update `.editorconfig` to match MetaMask template

  **Must NOT do**:
  - Specify exact Node version (use lts/\*)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Simple configuration files
  - **Skills**: [`git-master`]

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 9)
  - **Blocks**: Task 14
  - **Blocked By**: None (can start immediately)

  **References**:
  - **Pattern Reference**: https://github.com/MetaMask/metamask-module-template/blob/main/.nvmrc
  - **Current File**: `/Users/joaotavares/Documents/projects/consensys/client-mcp-core/.editorconfig`

  **Acceptance Criteria**:
  - [x] File exists: `test -f .nvmrc && echo "exists"`
  - [x] `cat .nvmrc` outputs `lts/*`
  - [x] `grep -q "indent_style = space" .editorconfig && echo "found"`

  **Commit**: YES
  - Message: `chore: add .nvmrc and update .editorconfig`
  - Files: `.nvmrc`, `.editorconfig`
  - Pre-commit: `test -f .nvmrc`

---

- [x] 8. Create supporting configuration files

  **What to do**:
  - Create `.depcheckrc.json` for dependency checker
  - Create `yarn.config.cjs` for Yarn constraints
  - Create `typedoc.json` for API documentation
  - Update `.gitattributes` if needed

  **Must NOT do**:
  - Add complex TypeDoc configuration
  - Add constraints that don't apply to single-package repos

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Configuration files, well-defined structure
  - **Skills**: [`git-master`]

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 2, 3, 5, 6)
  - **Blocks**: Task 14
  - **Blocked By**: Task 1

  **References**:
  - **Pattern Reference**: https://github.com/MetaMask/metamask-module-template/blob/main/.depcheckrc.json
  - **Pattern Reference**: https://github.com/MetaMask/metamask-module-template/blob/main/typedoc.json

  **Acceptance Criteria**:
  - [x] File exists: `test -f .depcheckrc.json && echo "exists"`
  - [x] File exists: `test -f yarn.config.cjs && echo "exists"`
  - [x] File exists: `test -f typedoc.json && echo "exists"`

  **Commit**: YES
  - Message: `chore: add depcheck, yarn constraints, and TypeDoc configs`
  - Files: `.depcheckrc.json`, `yarn.config.cjs`, `typedoc.json`
  - Pre-commit: `test -f .depcheckrc.json`

---

- [x] 9. Create CHANGELOG.md

  **What to do**:
  - Create `CHANGELOG.md` in Keep a Changelog format
  - Add [Unreleased] section
  - Add link to repository

  **Must NOT do**:
  - Add fake historical entries
  - Deviate from Keep a Changelog format

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Simple markdown file
  - **Skills**: [`git-master`]

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 7)
  - **Blocks**: Task 14
  - **Blocked By**: None (can start immediately)

  **References**:
  - **Pattern Reference**: https://keepachangelog.com/en/1.0.0/
  - **Template Example**: https://github.com/MetaMask/metamask-module-template/blob/main/CHANGELOG.md

  **Acceptance Criteria**:
  - [x] File exists: `test -f CHANGELOG.md && echo "exists"`
  - [x] `grep -q "Unreleased" CHANGELOG.md && echo "found"`
  - [x] `grep -q "Keep a Changelog" CHANGELOG.md && echo "found"`

  **Commit**: YES
  - Message: `chore: add CHANGELOG.md`
  - Files: `CHANGELOG.md`
  - Pre-commit: `test -f CHANGELOG.md`

---

- [x] 10. Create build scripts

  **What to do**:
  - Create `scripts/get.sh` for CI value extraction
  - Create `scripts/prepack.sh` for pre-publish build

  **Must NOT do**:
  - Add scripts for features not in the package

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Simple shell scripts
  - **Skills**: [`git-master`]

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 4)
  - **Blocks**: Task 12
  - **Blocked By**: Tasks 2, 3

  **References**:
  - **Pattern Reference**: https://github.com/MetaMask/metamask-module-template/blob/main/scripts/get.sh
  - **Pattern Reference**: https://github.com/MetaMask/metamask-module-template/blob/main/scripts/prepack.sh

  **Acceptance Criteria**:
  - [x] File exists: `test -f scripts/get.sh && echo "exists"`
  - [x] File exists: `test -f scripts/prepack.sh && echo "exists"`
  - [x] Scripts are executable: `test -x scripts/get.sh && echo "executable"`

  **Commit**: YES
  - Message: `chore: add build scripts for CI and prepack`
  - Files: `scripts/get.sh`, `scripts/prepack.sh`
  - Pre-commit: `test -f scripts/get.sh`

---

- [x] 11. Migrate Jest tests to Vitest

  **What to do**:
  - Update test file imports from Jest to Vitest (`describe`, `it`, `expect`, `vi`)
  - Replace `jest.fn()` with `vi.fn()`
  - Replace `jest.mock()` with `vi.mock()`
  - Replace `jest.spyOn()` with `vi.spyOn()`
  - Update any Jest-specific matchers
  - Delete `jest.config.js` after migration
  - **IMPORTANT**: Find ALL test files using `find src -name "*.test.ts"` before migrating (do not rely on hardcoded list)

  **Existing test files to migrate** (4 files total - verify with glob before starting):
  - `src/mcp-server/tokenization.test.ts`
  - `src/mcp-server/session-manager.test.ts`
  - `src/mcp-server/tools/batch.test.ts`
  - `src/mcp-server/tools/definitions.test.ts`

  **Must NOT do**:
  - Change test logic or assertions
  - Add new test cases
  - Improve test coverage (only migrate)
  - Skip any test files (verify all are migrated)

  **Recommended Agent Profile**:
  - **Category**: `unspecified-low`
    - Reason: Repetitive syntax transformation across files
  - **Skills**: [`git-master`]

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Sequential (after Wave 3)
  - **Blocks**: Task 14
  - **Blocked By**: Task 4

  **References**:
  - **Migration Guide**: https://vitest.dev/guide/migration.html#migrating-from-jest
  - **Vitest API**: `import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'`
  - **Test Files** (complete list):
    - `/Users/joaotavares/Documents/projects/consensys/client-mcp-core/src/mcp-server/tokenization.test.ts`
    - `/Users/joaotavares/Documents/projects/consensys/client-mcp-core/src/mcp-server/session-manager.test.ts`
    - `/Users/joaotavares/Documents/projects/consensys/client-mcp-core/src/mcp-server/tools/batch.test.ts`
    - `/Users/joaotavares/Documents/projects/consensys/client-mcp-core/src/mcp-server/tools/definitions.test.ts`

  **Acceptance Criteria**:
  - [x] Test file count verified: `find src -name "*.test.ts" | wc -l` equals 4
  - [x] No jest imports: `! grep -r "from 'jest'" src/ && echo "no jest imports"`
  - [x] All test files have vitest import: `for f in $(find src -name "*.test.ts"); do grep -q "from 'vitest'" "$f" || echo "MISSING: $f"; done`
  - [x] Jest config deleted: `! test -f jest.config.js && echo "deleted"`
  - [x] `yarn install && yarn test` passes (after all dependencies installed)

  **Commit**: YES
  - Message: `chore: migrate tests from Jest to Vitest`
  - Files: `src/**/*.test.ts`, `jest.config.js` (deleted)
  - Pre-commit: `grep -q "vitest" src/mcp-server/tokenization.test.ts`

---

- [x] 12. Create GitHub Actions workflows

  **What to do**:
  - Create `.github/workflows/main.yml` - main orchestration workflow
  - Create `.github/workflows/build-lint-test.yml` - core CI workflow
  - Create `.github/workflows/create-release-pr.yml` - release PR automation
  - Create `.github/workflows/publish-release.yml` - npm publishing workflow
  - Create `.github/workflows/publish-docs.yml` - TypeDoc publishing workflow

  **Must NOT do**:
  - Add workflows for features that don't exist
  - Use secrets that aren't documented
  - Copy workflows verbatim without adapting to package structure

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Multiple interconnected workflow files requiring careful adaptation
  - **Skills**: [`git-master`]

  **Parallelization**:
  - **Can Run In Parallel**: NO (files depend on each other)
  - **Parallel Group**: Wave 4 (after Wave 3)
  - **Blocks**: Task 13
  - **Blocked By**: Task 10

  **References**:
  - **Pattern Reference**: https://github.com/MetaMask/metamask-module-template/tree/main/.github/workflows
  - **Main Workflow**: https://github.com/MetaMask/metamask-module-template/blob/main/.github/workflows/main.yml

  **Acceptance Criteria**:
  - [x] Directory exists: `test -d .github/workflows && echo "exists"`
  - [x] Main workflow: `test -f .github/workflows/main.yml && echo "exists"`
  - [x] Build workflow: `test -f .github/workflows/build-lint-test.yml && echo "exists"`
  - [x] YAML valid: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/main.yml'))" && echo "valid"`

  **Commit**: YES
  - Message: `ci: add GitHub Actions workflows for CI/CD`
  - Files: `.github/workflows/*.yml`
  - Pre-commit: `test -f .github/workflows/main.yml`

---

- [x] 13. Create GitHub configuration files

  **What to do**:
  - Create `.github/CODEOWNERS` with @MetaMask/engineering
  - Create `.github/dependabot.yml` for dependency updates
  - Create `.github/pull_request_template.md`

  **Must NOT do**:
  - Add team-specific configurations without confirmation

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Simple configuration files
  - **Skills**: [`git-master`]

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 4 (after Task 12)
  - **Blocks**: Task 14
  - **Blocked By**: Task 12

  **References**:
  - **Pattern Reference**: https://github.com/MetaMask/metamask-module-template/blob/main/.github/CODEOWNERS
  - **Pattern Reference**: https://github.com/MetaMask/metamask-module-template/blob/main/.github/dependabot.yml

  **Acceptance Criteria**:
  - [x] CODEOWNERS exists: `test -f .github/CODEOWNERS && echo "exists"`
  - [x] Dependabot exists: `test -f .github/dependabot.yml && echo "exists"`
  - [x] PR template exists: `test -f .github/pull_request_template.md && echo "exists"`

  **Commit**: YES
  - Message: `chore: add GitHub configuration files`
  - Files: `.github/CODEOWNERS`, `.github/dependabot.yml`, `.github/pull_request_template.md`
  - Pre-commit: `test -f .github/CODEOWNERS`

---

- [x] 14. Final verification and cleanup

  **What to do**:
  - Run `yarn install` to install all new dependencies
  - Run `yarn build` and verify dual ESM/CJS output
  - Run `yarn attw --pack .` for export validation
  - Run `yarn test` and verify coverage passes (thresholds auto-set based on current coverage)
  - Run `yarn lint` (note any existing errors for backlog)
  - Run `npm publish --dry-run` to verify publishability
  - Update README.md with new badges and setup instructions

  **Must NOT do**:
  - Fix lint errors discovered (create separate issue)
  - Add test coverage beyond what exists
  - Merge without all verifications passing

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Final integration requiring multiple verification steps
  - **Skills**: [`git-master`]

  **Parallelization**:
  - **Can Run In Parallel**: NO (final sequential step)
  - **Parallel Group**: Wave 5 (final)
  - **Blocks**: None (final task)
  - **Blocked By**: All previous tasks

  **References**:
  - **All previous task outputs**
  - **README template**: https://github.com/MetaMask/metamask-module-template/blob/main/README.md

  **Acceptance Criteria**:

  **Agent-Executed QA Scenarios:**

  ```
  Scenario: Build produces dual ESM/CJS output
    Tool: Bash
    Preconditions: All dependencies installed
    Steps:
      1. yarn build
      2. ls -la dist/
      3. Assert: dist/index.cjs exists
      4. Assert: dist/index.mjs exists
      5. Assert: dist/index.d.cts exists
      6. Assert: dist/index.d.mts exists
    Expected Result: All four files present
    Evidence: Output of ls -la dist/

  Scenario: Type exports are correct
    Tool: Bash
    Preconditions: Build completed
    Steps:
      1. yarn attw --pack .
      2. Assert: Exit code 0
      3. Assert: No "error" in output
    Expected Result: All exports validated
    Evidence: attw output captured

  Scenario: Tests pass with coverage thresholds
    Tool: Bash
    Preconditions: Vitest config in place, tests migrated
    Steps:
      1. yarn test --coverage
      2. Assert: Exit code 0
      3. Assert: Coverage thresholds met (auto-set based on current coverage with autoUpdate: true)
    Expected Result: All tests pass, coverage thresholds met
    Evidence: Test output captured

  Scenario: Package can be published
    Tool: Bash
    Preconditions: All configs in place
    Steps:
      1. npm publish --dry-run
      2. Assert: Exit code 0
      3. Assert: No errors in output
    Expected Result: Package ready for publish
    Evidence: Dry-run output captured
  ```

  **Commit**: YES
  - Message: `chore: complete MetaMask template alignment`
  - Files: `README.md`, any final adjustments
  - Pre-commit: `yarn build && yarn test`

---

## Commit Strategy

| After Task | Message                                                                  | Files                    | Verification            |
| ---------- | ------------------------------------------------------------------------ | ------------------------ | ----------------------- |
| 1          | `chore: update package.json for MetaMask template compliance`            | package.json             | JSON valid              |
| 2          | `chore: update TypeScript configs for MetaMask template`                 | tsconfig\*.json          | tsc --noEmit            |
| 3          | `chore: configure Yarn with LavaMoat allow-scripts plugin`               | .yarnrc.yml, .yarn/      | file exists             |
| 4          | `chore: add Vitest configuration with auto-updating coverage thresholds` | vitest.config.mts        | file exists             |
| 5          | `chore: add ESLint v9 flat config with MetaMask presets`                 | eslint.config.mjs        | file exists             |
| 6          | `chore: add Prettier configuration`                                      | .prettierrc.mjs          | file exists             |
| 7          | `chore: add .nvmrc and update .editorconfig`                             | .nvmrc, .editorconfig    | file exists             |
| 8          | `chore: add depcheck, yarn constraints, and TypeDoc configs`             | _.json, _.cjs            | file exists             |
| 9          | `chore: add CHANGELOG.md`                                                | CHANGELOG.md             | file exists             |
| 10         | `chore: add build scripts for CI and prepack`                            | scripts/\*.sh            | executable              |
| 11         | `chore: migrate tests from Jest to Vitest`                               | src/\*_/_.test.ts        | no jest imports         |
| 12         | `ci: add GitHub Actions workflows for CI/CD`                             | .github/workflows/\*.yml | YAML valid              |
| 13         | `chore: add GitHub configuration files`                                  | .github/\*               | file exists             |
| 14         | `chore: complete MetaMask template alignment`                            | README.md                | yarn build && yarn test |

---

## Success Criteria

### Verification Commands

```bash
# Build produces correct output
yarn build && ls dist/index.{cjs,mjs,d.cts,d.mts}
# Expected: all four files listed

# Type exports are correct
yarn attw --pack .
# Expected: exit 0, no errors

# Tests pass with coverage
yarn test --coverage
# Expected: exit 0, coverage thresholds met (auto-set based on current coverage)

# Lint passes (may have existing errors to backlog)
yarn lint
# Expected: reports status

# Package can be published
npm publish --dry-run
# Expected: exit 0
```

### Final Checklist

- [x] All "Must Have" present (dual build, coverage, ESLint, CI/CD, LavaMoat)
- [x] All "Must NOT Have" absent (no source logic changes, no lint fixes, no coverage improvements)
- [x] All tests pass with coverage thresholds met
- [x] Package exports validated with attw
- [x] GitHub workflows syntactically valid
- [x] npm publish dry-run succeeds
