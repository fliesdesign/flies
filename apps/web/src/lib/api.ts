import { isTauri } from "@tauri-apps/api/core";

const configuredUrl = import.meta.env.VITE_API_URL as string | undefined;

export function apiUrl(path: string) {
  const base =
    configuredUrl ?? (isTauri() ? (import.meta.env.DEV ? "http://localhost:3001" : "") : "");

  if (isTauri() && !base) throw new Error("This desktop build needs VITE_API_URL configured.");

  return `${base.replace(/\/$/, "")}${path}`;
}

// Desktop tokens stay in memory; WorkOS refresh credentials never enter the webview.
let desktopToken: string | null = null;

export const setDesktopToken = (token: string | null) => {
  desktopToken = token;
};

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (desktopToken) headers.set("Authorization", `Bearer ${desktopToken}`);
  const response = await fetch(apiUrl(path), { ...options, headers, credentials: "include" });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(
      response.status,
      body?.error ?? "Could not reach your workspace. Please retry.",
    );
  }

  return response.json() as Promise<T>;
}

export const post = <T>(path: string, body: unknown) =>
  api<T>(path, { method: "POST", body: JSON.stringify(body) });
export type Account = {
  user: { id: string; name: string; email: string };
  workspace: { id: string; name: string };
};

export async function signIn(preserveEditor = false) {
  if (!isTauri()) {
    const loginUrl = apiUrl(`/auth/login?returnTo=${encodeURIComponent(window.location.pathname)}`);

    if (!preserveEditor) {
      window.location.assign(loginUrl);

      return;
    }

    window.open(loginUrl, "_blank", "noopener,noreferrer");
    const expires = Date.now() + 10 * 60_000;

    while (Date.now() < expires) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 1500));

      try {
        // eslint-disable-next-line no-await-in-loop
        await api<Account>("/api/me");

        return;
      } catch (failure) {
        if (!(failure instanceof ApiError && failure.status === 401)) throw failure;
      }
    }

    throw new Error("Sign-in timed out. Your edits are still here; please try again.");
  }

  const verifier = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));

  const challenge = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(apiUrl(`/auth/login?desktop=${challenge}`));
  const deadline = Date.now() + 10 * 60_000;

  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 1500));
    // eslint-disable-next-line no-await-in-loop
    const { token } = await post<{ token: string | null }>("/auth/desktop/complete", { verifier });

    if (token) {
      setDesktopToken(token);

      return;
    }
  }

  throw new Error("Sign-in timed out. Please try again.");
}

export async function signOut() {
  await post("/auth/logout", {});
  setDesktopToken(null);
}
