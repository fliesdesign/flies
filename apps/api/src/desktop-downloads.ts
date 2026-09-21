const origin = "https://desktop.flies.design";

const targets: Record<string, string> = {
  "mac-arm": "darwin-aarch64",
  "mac-intel": "darwin-x86_64",
  "windows-arm": "windows-aarch64",
  "windows-intel": "windows-x86_64",
  linux: "linux-x86_64",
};

export function desktopDownloadUrl(target: string, manifest: unknown): string | null {
  const key = targets[target];
  if (!key || !manifest || typeof manifest !== "object" || !("platforms" in manifest)) return null;
  const platforms = manifest.platforms as Record<string, { url?: unknown }>;
  const value = platforms?.[key]?.url;
  if (typeof value !== "string") return null;
  const url = new URL(value);
  if (url.origin !== origin || !url.pathname.startsWith("/releases/")) return null;

  if (target.startsWith("mac-")) {
    if (!url.pathname.endsWith(".app.tar.gz")) return null;
    url.pathname = url.pathname.replace(/\.app\.tar\.gz$/, ".dmg");
  }

  return url.href;
}

export async function latestDesktopDownload(target: string): Promise<string | null> {
  if (!Object.hasOwn(targets, target)) return null;

  const response = await fetch(`${origin}/latest.json`, {
    signal: AbortSignal.timeout(8000),
    headers: { "User-Agent": "Flies-Downloads/1.0" },
  });

  if (!response.ok) throw new Error("Desktop downloads are unavailable.");

  return desktopDownloadUrl(target, await response.json());
}
