import { isTauri } from "@tauri-apps/api/core";
import type { Update } from "@tauri-apps/plugin-updater";

export const UPDATE_CHECK_TIMEOUT_MS = 15_000;

export type UpdateProgress = {
  received: number;
  total: number;
};

export type UpdateStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "current" }
  | { kind: "available"; version: string; notes: string }
  | { kind: "downloading"; received: number; total: number }
  | { kind: "error"; message: string };

export type DesktopUpdate = {
  version: string;
  notes: string;
  currentVersion: string;
  install: (onProgress: (progress: UpdateProgress) => void) => Promise<void>;
};

export function shouldAutoCheckUpdates(desktop: boolean, production: boolean): boolean {
  return desktop && production;
}

export function updateProgressPercent(received: number, total: number): number | null {
  if (total <= 0) return null;

  return Math.min(100, Math.round((received / total) * 100));
}

export function updateDownloadLabel(received: number, total: number): string {
  const percent = updateProgressPercent(received, total);
  if (percent === null) return "Downloading update…";

  return `Downloading update… ${percent}%`;
}

export function formatUpdateError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const trimmed = raw.replace(/^Error:\s*/i, "").trim();

  return trimmed || "Could not check for updates.";
}

export function updateStatusText(status: UpdateStatus): string {
  switch (status.kind) {
    case "idle":
      return "Check GitHub for a newer desktop build.";
    case "checking":
      return "Checking for updates…";
    case "current":
      return "You are on the latest version.";
    case "available":
      return `Flies ${status.version} is available.`;
    case "downloading":
      return updateDownloadLabel(status.received, status.total);
    case "error":
      return status.message;
  }
}

export async function desktopAppVersion(): Promise<string | null> {
  if (!isTauri()) return null;
  const { getVersion } = await import("@tauri-apps/api/app");

  return getVersion();
}

export async function checkForDesktopUpdate(): Promise<DesktopUpdate | null> {
  if (!isTauri()) return null;
  const { check } = await import("@tauri-apps/plugin-updater");

  const update = await check({
    timeout: UPDATE_CHECK_TIMEOUT_MS,
    headers: { Accept: "application/octet-stream" },
  });

  if (!update) return null;

  return wrapUpdate(update);
}

function wrapUpdate(update: Update): DesktopUpdate {
  return {
    version: update.version,
    notes: update.body?.trim() ?? "",
    currentVersion: update.currentVersion,
    install: async (onProgress) => {
      let received = 0;
      let total = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
          received = 0;
        } else if (event.event === "Progress") {
          received += event.data.chunkLength;
        }

        onProgress({ received, total });
      });
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    },
  };
}
