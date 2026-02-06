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
    files: ['src/**/*.ts'],
    rules: {
      'import-x/no-nodejs-modules': 'off',
      'no-restricted-globals': 'off',
      'jsdoc/require-jsdoc': [
        'error',
        {
          require: {
            FunctionDeclaration: true,
            MethodDefinition: true,
            ClassDeclaration: true,
          },
        },
      ],
    },
  },

  {
    files: ['**/*.test.ts', '**/*.test.js', '**/test-utils/**'],
    extends: [vitest, nodejs],
    rules: {
      'vitest/no-conditional-expect': 'off',
      'vitest/no-conditional-in-test': 'off',
      'jsdoc/require-jsdoc': 'off',
      'id-length': 'off',
      'no-empty-function': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/unbound-method': 'off',
      'no-restricted-globals': 'off',
    },
  },
]);

export default config;
