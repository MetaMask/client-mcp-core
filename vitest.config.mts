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

      // Coverage thresholds. If the coverage is below these thresholds, the
      // test will fail.
      thresholds: {
        // Auto-update the coverage thresholds when running locally.
        // Disabled in CI to prevent non-deterministic config changes.
        autoUpdate: !process.env.CI,
        branches: 87.95,
        functions: 90.87,
        lines: 94.23,
        statements: 93.97,
      },
    },

    typecheck: {
      enabled: true,

      // The path to the tsconfig file to use for type checking.
      tsconfig: './tsconfig.test.json',
    },
  },
});