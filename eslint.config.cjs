const globals = require('globals');
const ignores = require('./eslint.ignores.cjs');

module.exports = [
  {ignores},
  ...require('gts'),
  {
    files: ['scripts/**/*.mjs', 'test/**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
      globals: {...globals.node, ...globals.browser},
    },
  },
  {
    // node:test's test()/describe() return promises the runner tracks.
    files: ['test/unit/**/*.ts'],
    rules: {'@typescript-eslint/no-floating-promises': 'off'},
  },
  {
    files: ['**/*.cjs'],
    languageOptions: {sourceType: 'commonjs', globals: globals.node},
  },
];
