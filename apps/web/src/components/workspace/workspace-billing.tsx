import { ArrowUpRightIcon, CheckIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { api, post } from "@/lib/api";

export type BillingStatus =
  | { enabled: false; plan: null; limits: null }
  | {
      enabled: true;
      plan: "free" | "pro";
      limits: { designFiles: number; imageUploadBytes: number; mcpCallsPerWeek: number };
    };

async function openBillingUrl(url: string, desktop: boolean) {
  const target = new URL(url);
  if (target.protocol !== "https:") throw new Error("The billing link is invalid. Please retry.");

  if (desktop) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(target.href);
  } else {
    window.location.assign(target.href);
  }
}

export function WorkspaceBilling({ desktop }: { desktop: boolean }) {
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const mounted = useRef(false);
  const checking = useRef(false);
  const launching = useRef(false);
  const awaitingReturn = useRef(false);

  const refresh = useCallback(async (force = false) => {
    if (checking.current) return;
    checking.current = true;

    try {
      const next = force
        ? await post<BillingStatus>("/api/billing/refresh", {})
        : await api<BillingStatus>("/api/billing");

      if (!mounted.current) return;
      setStatus(next);
      setError("");

      if (awaitingReturn.current && next.enabled) {
        setNotice(
          next.plan === "pro"
            ? "Your Pro plan is active."
            : "Your plan is still Free. If you just paid, refresh again in a moment.",
        );
        if (next.plan === "pro") awaitingReturn.current = false;
      }
    } catch (failure) {
      if (mounted.current)
        setError(
          failure instanceof Error ? failure.message : "Could not load your plan. Please retry.",
        );
    } finally {
      checking.current = false;
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const returning = new URLSearchParams(window.location.search).get("billing") === "success";
    awaitingReturn.current = returning;
    // Synchronize with the server; state updates occur after the network response.
    // eslint-disable-next-line react/set-state-in-effect
    void refresh(returning);

    const onFocus = () => {
      if (awaitingReturn.current) void refresh(true);
    };

    window.addEventListener("focus", onFocus);

    return () => {
      mounted.current = false;
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  async function launch() {
    if (launching.current || !status?.enabled) return;
    launching.current = true;
    setPending(true);
    setError("");
    setNotice("");

    try {
      const { url } = await post<{ url: string }>(
        status.plan === "pro" ? "/api/billing/portal" : "/api/billing/checkout",
        status.plan === "pro" ? {} : { seats: 1 },
      );

      awaitingReturn.current = true;
      await openBillingUrl(url, desktop);
      if (mounted.current && desktop)
        setNotice(
          "Continue in your browser, then return here. Your plan will refresh automatically.",
        );
    } catch (failure) {
      if (mounted.current)
        setError(
          failure instanceof Error ? failure.message : "Could not open billing. Please retry.",
        );
    } finally {
      launching.current = false;
      if (mounted.current) setPending(false);
    }
  }

  if (status?.enabled === false || (!status && !error)) return null;
  const pro = status?.enabled && status.plan === "pro";

  return (
    <div className="mt-auto border-t border-sidebar-border p-3">
      <div className="mb-2 flex items-center justify-between text-xs">
        <span className="font-medium">
          {status ? (pro ? "Pro plan" : "Free plan") : "Billing unavailable"}
        </span>
        {status?.enabled && (
          <span className="text-muted-foreground">{status.limits.designFiles} files</span>
        )}
      </div>
      {status ? (
        <Button
          className="w-full"
          size="sm"
          variant={pro ? "outline" : "default"}
          onClick={() => setOpen(true)}
        >
          {pro ? "Manage subscription" : "Upgrade to Pro"}
          <ArrowUpRightIcon aria-hidden="true" />
        </Button>
      ) : (
        <Button
          className="w-full"
          size="sm"
          variant="outline"
          disabled={loading}
          onClick={() => {
            setLoading(true);
            void refresh();
          }}
        >
          {loading ? "Loading…" : "Retry billing"}
        </Button>
      )}
      {error && !open && (
        <p className="mt-2 text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
      {notice && !open && (
        <output className="mt-2 block text-xs text-muted-foreground">{notice}</output>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>{pro ? "Your Pro plan" : "More room to create"}</DialogTitle>
          <DialogDescription>
            {pro
              ? "Manage your subscription, payment method, and invoices in the billing portal."
              : "Upgrade your workspace to Pro. Billed monthly, cancel anytime."}
          </DialogDescription>
          <div className="flex items-baseline gap-1.5 border-b pb-4">
            <span className="text-3xl font-semibold tracking-tight">$12</span>
            <span className="text-xs text-muted-foreground">
              USD / user / month · plus applicable tax
            </span>
          </div>
          <ul className="grid gap-2.5 text-sm">
            {[
              "250 design files",
              "Image uploads up to 250 MB",
              "500,000 MCP calls per week",
              "Commercial use",
            ].map((feature) => (
              <li key={feature} className="flex items-center gap-2">
                <CheckIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                {feature}
              </li>
            ))}
          </ul>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Team workspaces, public MCP access, and share links are coming soon.
          </p>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          {notice && <output className="text-xs text-muted-foreground">{notice}</output>}
          <Button disabled={pending || loading} onClick={() => void launch()}>
            {pending ? "Opening…" : pro ? "Open billing portal" : "Continue to checkout"}
            <ArrowUpRightIcon aria-hidden="true" />
          </Button>
          <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <span>
              {pro ? "Changes are managed securely by Polar." : "One user · $12 per month"}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={loading || pending}
              onClick={() => {
                setLoading(true);
                void refresh(true);
              }}
            >
              {loading ? "Refreshing…" : "Refresh plan"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
