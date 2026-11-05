import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'src/api/generated/'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    // Сквозные тесты выполняются в Node (встроенные fetch и WebSocket), а не в браузере.
    files: ['e2e/**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', fetch: 'readonly', WebSocket: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', AbortSignal: 'readonly', URL: 'readonly', Buffer: 'readonly' },
    },
  },
  {
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
