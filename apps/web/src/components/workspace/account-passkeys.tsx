import { useState } from "react";

import { Button } from "@/components/ui/button";
import { signIn } from "@/lib/api";

export function AccountPasskeys() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  return (
    <section className="space-y-4" aria-label="Passkeys">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">Passkeys</h3>
        <p className="text-sm text-muted-foreground">
          Use Face ID, Touch ID, Windows Hello, or a security key when you sign in. Sign in with
          your email and password to add one.
        </p>
      </div>
      <Button
        variant="outline"
        disabled={pending}
        onClick={() => {
          setPending(true);
          setError("");
          void signIn(false, { returnTo: "/settings#account", passkey: true }).catch((cause) => {
            setError(
              cause instanceof Error ? cause.message : "Could not open sign-in. Please retry.",
            );
            setPending(false);
          });
        }}
      >
        {pending ? "Opening sign-in…" : "Add a passkey"}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
