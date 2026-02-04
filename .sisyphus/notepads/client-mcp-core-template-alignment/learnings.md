# Learnings - client-mcp-core-template-alignment

## 2026-02-03 Session Start
- Branch: cryptotavares/aling-with-module-template
- Latest commit: 462b6de chore: update to yarn 4
- Yarn 4.11.0 already configured (packageManager field set)
- Basic TypeScript configs exist (tsconfig.json, tsconfig.build.json)
- .editorconfig exists with standard settings
- All 4 test files use Jest (not yet migrated to Vitest)
- No GitHub workflows or configs exist

## Task 8: Supporting Configuration Files

### Completed
- Created `.depcheckrc.json` with MetaMask template ignores list
- Created `typedoc.json` with basic API documentation config
- Created `yarn.config.cjs` with Yarn constraints for MetaMask module compliance

### Key Patterns
1. **depcheck ignores**: Includes all dev-only dependencies and ESLint/TypeScript tooling
2. **TypeDoc config**: Minimal setup with `entryPoints`, `excludePrivate`, `hideGenerator`, `out`
3. **Yarn constraints**: Uses `defineConfig` from @yarnpkg/types, validates package fields, sets export structure

### Notes
- yarn.config.cjs uses BASE_URL pointing to MetaMask organization
- Constraints validate: name, version, license, description, dependencies, exports
- All three files follow MetaMask template patterns exactly
