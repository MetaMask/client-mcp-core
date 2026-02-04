# Issues - client-mcp-core-template-alignment

## 2026-02-03 Session Start

- engines.node is currently >=24.0.0, needs to change to ^20 || ^22 || >=24
- tsconfig.build.json doesn't reference ts-bridge yet
- tsconfig.test.json doesn't exist

## 2026-02-03 - Deferred Items (By Design)

### 1. Lint Errors (DEFERRED)

- **Status**: 2582 ESLint errors (2377 auto-fixable)
- **Reason**: Plan guardrails explicitly state "NO fixing existing lint errors as part of this migration"
- **Action**: Create separate task/PR to run `yarn lint:fix` and address remaining errors
- **Command**: `yarn lint:fix` will auto-fix 2377 errors

### 2. GitHub Actions Verification (BLOCKED)

- **Status**: Cannot verify without pushing to GitHub
- **Reason**: Workflows only run on push/PR events
- **Action**: Will be verified when PR is created/pushed
- **Note**: All workflow YAML files are syntactically valid and follow MetaMask template

These items are intentionally not marked as complete because they are outside the scope of this migration task.
