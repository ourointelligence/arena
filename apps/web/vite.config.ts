import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';

const MOCK_PORT = Number(process.env['ARENA_MOCK_PORT'] ?? 8788);
const API_TARGET = process.env['ARENA_API_PROXY'] ?? `http://127.0.0.1:${MOCK_PORT}`;

/** In dev, start the mock API in-process so `pnpm dev` is the whole setup. */
function mockApi(): Plugin {
  return {
    name: 'arena-mock-api',
    apply: 'serve',
    async configureServer() {
      if (process.env['ARENA_API_PROXY'] || process.env['VITEST']) return;
      const mod = await import('./test/mock-api.ts');
      await mod.startMockApi(MOCK_PORT);
    },
  };
}

export default defineConfig({
  base: '/arena/',
  plugins: [mockApi()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    modulePreload: { polyfill: false },
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: { '/arena/api': { target: API_TARGET, changeOrigin: false } },
  },
  preview: {
    port: 4173,
    strictPort: true,
    proxy: { '/arena/api': { target: API_TARGET, changeOrigin: false } },
  },
  test: {
    include: ['test/**/*.test.ts'],
  },
});
