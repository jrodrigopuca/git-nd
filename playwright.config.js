// Browser E2E (on demand: `npm run e2e`, or the "E2E" workflow's manual button).
// Unit/service/HTTP tests live in test/ and run in CI on every push.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.js',
  // One worker: each worker runs its own git-nd server, and the server holds
  // a single "open repo" — tests in a worker open their own repos in turn.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 8_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    // The installed Google Chrome: nothing to download (GitHub's Ubuntu runners have it too).
    channel: 'chrome',
    headless: true,
    viewport: { width: 1400, height: 900 },
    trace: 'retain-on-failure',
  },
});
