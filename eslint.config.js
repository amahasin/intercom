import { builtinModules } from 'node:module';
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const nodeBuiltins = [...new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)])];

const noElectron = {
  name: 'electron',
  message: 'Keep this code free of Electron so it runs as a bare Node process (plan rule 17.8).',
};
const noNode = (message) => nodeBuiltins.map((name) => ({ name, message }));

export default defineConfig(
  {
    ignores: [
      '**/dist/**',
      '**/release/**',
      '**/node_modules/**',
      'test-results/**',
      'playwright-report/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    files: ['**/*.{js,mjs,ts}'],
    ignores: ['apps/desktop/renderer/**'],
    languageOptions: { globals: globals.node },
  },

  // Core, sim and tests: plain Node, never Electron.
  {
    files: ['packages/core/**/*.ts', 'tools/**/*.ts', 'tests/integration/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [noElectron], patterns: [{ group: ['electron/*'], message: noElectron.message }] },
      ],
    },
  },

  // Protocol sources are shared with the renderer: no Node, no Electron.
  {
    files: ['packages/protocol/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            noElectron,
            ...noNode(
              '@officemesh/protocol is shared with the renderer; keep it free of Node APIs.',
            ),
          ],
        },
      ],
    },
  },

  // Renderer: browser only, and the core only through the typed IPC API.
  {
    files: ['apps/desktop/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.flat['recommended-latest'].rules,
      'no-restricted-imports': [
        'error',
        {
          paths: [noElectron, ...noNode('The renderer never uses Node APIs (plan rule 17.8).')],
          patterns: [
            {
              group: ['@officemesh/core', '@officemesh/core/*'],
              message:
                'The renderer talks to the core only through @officemesh/protocol/ipc (plan section 4, rule 1).',
            },
          ],
        },
      ],
      'no-restricted-globals': ['error', 'process', 'Buffer', 'require', '__dirname'],
    },
  },
);
