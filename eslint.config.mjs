import base, { createConfig } from '@metamask/eslint-config';
import nodejs from '@metamask/eslint-config-nodejs';
import typescript from '@metamask/eslint-config-typescript';
import vitest from '@metamask/eslint-config-vitest';

const config = createConfig([
  {
    ignores: ['dist/', 'docs/', '.yarn/', 'yarn.config.cjs'],
  },

  {
    extends: base,

    languageOptions: {
      sourceType: 'module',
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },

    settings: {
      'import-x/extensions': ['.js', '.mjs'],
    },
  },

  {
    files: ['**/*.ts'],
    extends: typescript,
  },

  {
    files: ['**/*.js', '**/*.cjs'],
    extends: nodejs,

    languageOptions: {
      sourceType: 'script',
    },
  },

  {
    files: ['**/*.test.ts', '**/*.test.js'],
    extends: [vitest, nodejs],
    rules: {
      'vitest/no-conditional-expect': 'off',
      'vitest/no-conditional-in-test': 'off',
    },
  },

  {
    files: [
      'src/mcp-server/knowledge-store.ts',
      'src/mcp-server/tools/build.ts',
      'src/launcher/extension-readiness.ts',
      'src/launcher/extension-id-resolver.ts',
      'src/mcp-server/server.ts',
    ],
    rules: {
      'import-x/no-nodejs-modules': 'off',
      'no-restricted-globals': 'off',
    },
  },

  {
    files: ['src/**/*.ts'],
    rules: {},
  },
]);

export default config;
