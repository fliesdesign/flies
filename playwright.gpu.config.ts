import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./scripts/gpu-tests",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: {
    browserName: "chromium",
    headless: process.env.FLIES_GPU_HEADED !== "1",
    baseURL: "http://127.0.0.1:1432",
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: Number(process.env.FLIES_GPU_DPR ?? "1"),
    screenshot: "only-on-failure",
    // Software WebGL verifies pixels in CI. Use the hardware mode for timing reports.
    launchOptions: {
      args:
        process.env.FLIES_GPU_HARDWARE === "1"
          ? process.platform === "darwin"
            ? ["--use-angle=metal"]
            : []
          : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    },
  },
  webServer: {
    command: "vp -C apps/web dev --host 127.0.0.1 --port 1432 --strictPort",
    url: "http://127.0.0.1:1432",
    reuseExistingServer: false,
  },
});
