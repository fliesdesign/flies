import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./scripts/mcp-tests",
  fullyParallel: false,
  use: { browserName: "chromium", headless: true, baseURL: "http://127.0.0.1:1431" },
  webServer: {
    command: "bun run dev --host 127.0.0.1 --port 1431 --strictPort",
    url: "http://127.0.0.1:1431",
    reuseExistingServer: false,
  },
});
