/**
 * Playwright configuration for E2E tests.
 *
 * Runs against the PWA dev server (Vite on port 5174).
 * The server is started automatically before tests run.
 */

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: 0,

  use: {
    // Base URL for all tests — Vite PWA dev server
    baseURL: 'http://localhost:5174',
    // Capture screenshots on failure
    screenshot: 'only-on-failure',
    // Capture traces on failure
    trace: 'on-first-retry',
  },

  projects: [
    {
      name: 'mobile-chrome',
      use: {
        ...devices['iPhone 14'],
      },
    },
  ],

  // Start the Vite PWA dev server before running tests
  webServer: {
    command: 'cd pwa && npx vite --config vite.config.pwa.ts --port 5174',
    url: 'http://localhost:5174',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
