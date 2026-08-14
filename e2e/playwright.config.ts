import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 150_000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    // Local dev uses the system Edge (zero download). CI installs
    // Playwright's own Chromium (see .github/workflows/ci.yml) — the
    // channel must be unset there or Playwright will look for Edge.
    channel: process.env.CI ? undefined : 'msedge',
  },
  webServer: [
    {
      command: 'go run ./cmd/server -addr :8787',
      cwd: '../signaling',
      url: 'http://localhost:8787/ws',
      reuseExistingServer: true,
      // First boot compiles the Go binary and may fetch modules.
      timeout: 90_000,
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
