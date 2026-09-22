import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          SYNC_SERVER_SECRET: "test-sync-secret-that-is-at-least-32-characters",
          API_URL: "https://api.example.com",
          WEB_URL: "https://app.example.com",
        },
      },
    }),
  ],
  test: { include: ["test/**/*.test.ts"], testTimeout: 15000 },
});
