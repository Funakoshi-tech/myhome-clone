import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    files: ['js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        THREE: 'readonly',
      },
    },
    rules: {
      'no-redeclare': 'error',
      'no-shadow': ['error', { allow: ['err', 'e', 'ctx'] }],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    },
  },
];
