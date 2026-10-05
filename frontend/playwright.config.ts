import { defineConfig, devices } from '@playwright/test';

// Browser tests against the DEPLOYED site (CloudFront). Run them with `npm run e2e` from the project
// root: that script looks up the site URL from the stack and sets WEB_URL for you.
const baseURL = process.env.WEB_URL;
if (!baseURL) throw new Error('WEB_URL is not set. Run "npm run e2e" from the project root, or set WEB_URL to the site address.');

export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results',
  use: { baseURL, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] }, testMatch: /smoke\.spec\.ts/ },
    { name: 'phone', use: { ...devices['Pixel 7'] }, testMatch: /phone\.spec\.ts/ },
  ],
});
