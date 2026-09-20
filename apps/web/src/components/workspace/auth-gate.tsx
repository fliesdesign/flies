import { ArrowUpRightIcon, MousePointer2Icon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { api, ApiError, signIn, type Account } from "@/lib/api";

import { FileWorkspace } from "./file-workspace";
import "./auth-gate.css";

export function AuthGate() {
  const [account, setAccount] = useState<Account | null>(null);
  const [loading, setLoading] = useState(true);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(
    () =>
      api<Account>("/api/me")
        .then((value) => {
          setAccount(value);
          setError("");

          return value;
        })
        .catch((failure: unknown) => {
          if (!(failure instanceof ApiError && failure.status === 401)) setError(String(failure));
        })
        .finally(() => setLoading(false)),
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);
  if (loading)
    return (
      <main className="auth-screen">
        <output>Opening your workspace…</output>
      </main>
    );
  if (account)
    return (
      <FileWorkspace key={account.user.id} account={account} onSignedOut={() => setAccount(null)} />
    );

  return (
    <main className="auth-screen">
      <div className="auth-content">
        <span className="auth-wordmark">Flies</span>
        <div className="auth-artboard" aria-hidden="true">
          <span className="auth-artboard-label">Your next idea</span>
          <div className="auth-artboard-shape" />
          <MousePointer2Icon className="auth-cursor" />
        </div>
        <h1>A space for your ideas.</h1>
        <p>Sign in to open your workspace and keep your designs together.</p>
        <Button
          size="lg"
          disabled={signingIn}
          onClick={() => {
            setSigningIn(true);
            setError("");
            void signIn()
              .then(load)
              .catch((failure) => setError(String(failure)))
              .finally(() => setSigningIn(false));
          }}
        >
          {signingIn ? "Continue in your browser…" : "Sign in to Flies"}
          <ArrowUpRightIcon aria-hidden="true" />
        </Button>
        {error && (
          <p className="auth-error" role="alert">
            {error} <button onClick={() => void load()}>Retry</button>
          </p>
        )}
      </div>
    </main>
  );
}
