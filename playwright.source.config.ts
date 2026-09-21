import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./scripts/source-production-tests",
  use: { browserName: "chromium", headless: true, baseURL: "http://127.0.0.1:1433" },
  webServer: {
    command:
      "VITE_API_URL= bun run build && vp -C apps/web preview --host 127.0.0.1 --port 1433 --strictPort",
    url: "http://127.0.0.1:1433",
    reuseExistingServer: false,
  },
});
