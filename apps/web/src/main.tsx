import { RouterProvider, createRouter } from "@tanstack/react-router";
import { isTauri } from "@tauri-apps/api/core";
import React from "react";
import ReactDOM from "react-dom/client";

import { applyStoredAppearance } from "@/lib/appearance";

import { routeTree } from "./routeTree.gen";
import "./styles.css";

applyStoredAppearance();

// Reserve native window controls only in the macOS desktop webview.
if (isTauri() && /Mac/.test(navigator.userAgent)) {
  document.documentElement.dataset.nativeTitlebar = "macos";
}

const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  defaultPreloadStaleTime: 0,
  scrollRestoration: true,
});

// Register the router instance for full type-safety across the app.
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
