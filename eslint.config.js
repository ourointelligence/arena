import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// Arena may only use the SDK packages through their public entry points. A deep import into dist or src
// would couple Arena to build output that the release files do not promise.
const sdkDeepImport = {
  group: ['@ourointelligence/*/*'],
  message: 'Import the SDK packages by their public entry point only (no deep imports into dist or src).',
};

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.d.ts', 'apps/web/playwright-report/**', 'apps/web/test-results/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.mts', '**/*.js', '**/*.mjs'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [sdkDeepImport] }],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['scripts/**/*.mjs', 'infra/**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', URL: 'readonly', fetch: 'readonly' } },
  },
  {
    files: ['apps/web/src/**/*.ts'],
    languageOptions: {
      globals: {
        window: 'readonly', document: 'readonly', localStorage: 'readonly', requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly', IntersectionObserver: 'readonly', EventSource: 'readonly', fetch: 'readonly',
        navigator: 'readonly', HTMLElement: 'readonly', HTMLCanvasElement: 'readonly', CanvasRenderingContext2D: 'readonly',
        performance: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
        clearInterval: 'readonly', console: 'readonly', URL: 'readonly', URLSearchParams: 'readonly', history: 'readonly',
        location: 'readonly', MouseEvent: 'readonly', WheelEvent: 'readonly', KeyboardEvent: 'readonly', Event: 'readonly',
        ResizeObserver: 'readonly', devicePixelRatio: 'readonly', matchMedia: 'readonly', AbortController: 'readonly',
      },
    },
  },
);
