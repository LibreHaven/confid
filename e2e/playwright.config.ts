import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 150_000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    // Use the system Edge browser (Playwright's bundled headless shell
    // download is unreliable on this network).
    channel: 'msedge',
  },
  webServer: [
    {
      command: 'go run ./cmd/server -addr :8787',
      cwd: '../signaling',
      url: 'http://localhost:8787/ws',
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      command: 'npm run dev',
      cwd: '../client',
      url: 'http://localhost:5173',
      reuseExistingServer: true,
      timeout: 30_000,
    },
  ],
});
