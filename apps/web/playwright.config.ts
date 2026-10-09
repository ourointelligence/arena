import { defineConfig, devices } from '@playwright/test';

const MOCK_PORT = 8788;
const WEB_PORT = 4173;

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: './test-results',
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: 'retain-on-failure',
    launchOptions: { args: ['--enable-precise-memory-info'] },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: `pnpm exec tsx test/mock-api.ts ${MOCK_PORT}`,
      url: `http://127.0.0.1:${MOCK_PORT}/arena/api/health`,
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      command: 'pnpm run build && pnpm run preview',
      url: `http://127.0.0.1:${WEB_PORT}/arena/`,
      reuseExistingServer: true,
      timeout: 120_000,
      env: { ARENA_MOCK_PORT: String(MOCK_PORT) },
    },
  ],
});
