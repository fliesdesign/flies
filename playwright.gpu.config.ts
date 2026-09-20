import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./scripts/gpu-tests",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: {
    browserName: "chromium",
    headless: true,
    baseURL: "http://127.0.0.1:1432",
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    launchOptions: { args: ["--enable-unsafe-webgpu", "--use-angle=swiftshader"] },
  },
  webServer: {
    command: "bun run dev --host 127.0.0.1 --port 1432 --strictPort",
    url: "http://127.0.0.1:1432",
    reuseExistingServer: false,
  },
});
