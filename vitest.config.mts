import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Vitest enables watch mode by default. We disable it here, so it can be
    // explicitly enabled with `yarn test:watch`.
    watch: false,

    // The files to include in the test run.
    include: ['src/**/*.test.ts'],

    coverage: {
      enabled: true,

      // Configure the coverage provider. We use `istanbul` here, because it
      // is more stable than `v8`.
      provider: 'istanbul',

      // The files to include in the coverage report.
      include: [
        'src/**/*.ts',
        'src/**/*.tsx',
        'src/**/*.js',
        'src/**/*.jsx',
        'src/**/*.mjs',
      ],

      // The files to exclude from the coverage report. Vitest excludes test
      // files by default, but not `test-d.ts` files.
      exclude: ['src/**/*.test-d.ts', 'src/tools/test-utils/'],

      // Coverage floors. The run fails when coverage drops below these.
      // Keep whole numbers. Do not turn on `autoUpdate`, and do not commit the
      // exact percentages from a test run: every PR rewrites these same four
      // lines, so open PRs conflict with each other on merge. Raise a floor
      // only after coverage has stayed a full point above it.
      thresholds: {
        branches: 94,
        functions: 96,
        lines: 97,
        statements: 97,
      },
    },

    typecheck: {
      enabled: true,

      // The path to the tsconfig file to use for type checking.
      tsconfig: './tsconfig.test.json',
    },
  },
});