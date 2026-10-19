import { defineConfig, devices } from "@playwright/test";

process.env.NEXT_PUBLIC_STELLAR_RPC_URL = "https://soroban-testnet.stellar.org";
process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
process.env.NEXT_PUBLIC_INDEXER_URL = "http://127.0.0.1:3101";
process.env.NEXT_PUBLIC_CIRCLE_FACTORY_ADDRESS = "";
process.env.NEXT_PUBLIC_REPUTATION_ADDRESS = "";
process.env.NEXT_PUBLIC_USDC_ADDRESS = "";

export default defineConfig({
  testDir: ".",
  testMatch: "visual.spec.ts",
  snapshotPathTemplate: "__screenshots__/{arg}-{projectName}{ext}",
  fullyParallel: true,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3100",
    browserName: "chromium",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    reducedMotion: "reduce",
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } },
    },
    {
      name: "mobile",
      use: { ...devices["iPhone 13"], browserName: "chromium", viewport: { width: 390, height: 844 } },
    },
  ],
  webServer: [
    {
      command: "node tests/visual/fixture-server.mjs",
      cwd: "../..",
      url: "http://127.0.0.1:3101/health",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: "../node_modules/.bin/next dev --hostname 127.0.0.1 --port 3100",
      cwd: "../../app",
      url: "http://127.0.0.1:3100",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});