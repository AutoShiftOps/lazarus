import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  // One worker: the demo endpoint is rate limited per IP.
  workers: 1,
  use: {
    baseURL: "http://localhost:3000",
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 120_000,
    // Merged over the parent environment; .env.local still supplies Redis credentials.
    env: {
      LAZARUS_DEV_ALLOW_LOOPBACK: "1",
      LAZARUS_GRAVEWOOD_HOST: "localhost:3000",
    },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
