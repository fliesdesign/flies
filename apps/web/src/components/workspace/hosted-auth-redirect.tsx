import { isTauri } from "@tauri-apps/api/core";
import { useEffect } from "react";

import { apiUrl } from "@/lib/api";

import { AuthGate } from "./auth-gate";

export function HostedAuthRedirect() {
  const desktop = isTauri();

  useEffect(() => {
    if (desktop) return;
    const requested = new URLSearchParams(window.location.search).get("returnTo") ?? "/recents";

    const returnTo = /^\/(?:recents|settings|archive|files(?:\/[A-Za-z0-9-]+)?)$/.test(requested)
      ? requested
      : "/recents";

    window.location.replace(apiUrl(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`));
  }, [desktop]);

  if (desktop) return <AuthGate />;

  return (
    <main className="auth-screen">
      <output>Opening secure sign-in…</output>
    </main>
  );
}
