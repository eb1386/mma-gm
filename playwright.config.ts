import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests against a production preview.
 *
 * The suite runs on a real build, because several of the defects it guards against are
 * about routing and asset paths and cannot be reproduced against the dev server.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['Pixel 5'], viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    // The preview server serves the prebuilt dist. Without building first the browser suite can
    // silently test stale code and pass against a version that no longer exists in the source,
    // which is exactly the failure this suite is meant to catch.
    command: 'npm run build && npm run preview -- --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: true,
    timeout: 240_000,
  },
});
