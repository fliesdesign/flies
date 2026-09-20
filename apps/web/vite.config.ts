import path from "node:path";
import process from "node:process";

import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin, lazyPlugins } from "vite-plus";

const host = process.env.TAURI_DEV_HOST;
const repoRoot = path.resolve(import.meta.dirname, "../..");

function repoUrlPlugin(): Plugin {
  return {
    name: "flies-repo-urls",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (!req.url) return next();
        const [pathname, query] = req.url.split("?");

        if (!pathname?.startsWith("/scripts/") && !pathname?.startsWith("/packages/")) {
          return next();
        }

        const file = path.resolve(repoRoot, decodeURIComponent(pathname.slice(1)));
        req.url = `/@fs${file}${query ? `?${query}` : ""}`;
        next();
      });
    },
  };
}

export default defineConfig(() => ({
  plugins: lazyPlugins(() => [
    repoUrlPlugin(),
    // Must come before @vitejs/plugin-react so generated routes are transformed.
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
    tailwindcss(),
  ]),

  resolve: {
    // Browser test harnesses live outside apps/web; resolve shared dependencies
    // from the app so they use the same canvas store and React instance.
    dedupe: ["@flies/canvas", "react", "react-dom"],
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  // pixi.js lives on @flies/canvas and is loaded by the lazy GPU renderer.
  // Prebundle it through that package so the first WebGPU import does not
  // invalidate the dep cache and reload the editor.
  optimizeDeps: { include: ["@flies/canvas > pixi.js"] },
  envDir: repoRoot,
  clearScreen: false,
  server: {
    proxy: { "/api": "http://localhost:3001", "/auth": "http://localhost:3001" },
    port: 1420,
    strictPort: true,
    host: host || false,
    fs: { allow: [repoRoot] },
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/apps/desktop/target/**"],
    },
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",
  },
}));
