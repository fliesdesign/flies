import { ArrowUpRightIcon, CheckIcon } from "lucide-react";
import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useRef,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, post } from "@/lib/api";

export type BillingStatus =
  | { enabled: false; plan: null; limits: null }
  | {
      enabled: true;
      plan: "free" | "pro";
      seats?: number;
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

type BillingContextValue = {
  status: BillingStatus | null;
  canManage: boolean;
  error: string;
  notice: string;
  open: boolean;
  loading: boolean;
  pending: boolean;
  setOpen: (open: boolean) => void;
  setLoading: (loading: boolean) => void;
  refresh: (force?: boolean) => Promise<void>;
  launch: () => Promise<void>;
};
const BillingContext = createContext<BillingContextValue | null>(null);

export function useBilling() {
  const billing = useContext(BillingContext);
  if (!billing) throw new Error("Billing controls need a workspace billing provider.");

  return billing;
}

export function WorkspaceBillingProvider({
  desktop,
  enabled = true,
  canManage = true,
  children,
}: {
  desktop: boolean;
  enabled?: boolean;
  canManage?: boolean;
  children: ReactNode;
}) {
  const [seats, setSeats] = useState(1);
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
    if (!enabled) return;
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
  }, [enabled, refresh]);

  const launch = useCallback(async () => {
    if (launching.current || !status?.enabled || !canManage) return;
    launching.current = true;
    setPending(true);
    setError("");
    setNotice("");

    try {
      const { url } = await post<{ url: string }>(
        status.plan === "pro" ? "/api/billing/portal" : "/api/billing/checkout",
        status.plan === "pro" ? {} : { seats },
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
  }, [status, canManage, seats, desktop]);

  const pro = status?.enabled && status.plan === "pro";

  const value = useMemo(
    () => ({
      status,
      canManage,
      error,
      notice,
      open,
      loading,
      pending,
      setOpen,
      setLoading,
      refresh,
      launch,
    }),
    [status, canManage, error, notice, open, loading, pending, refresh, launch],
  );

  return (
    <BillingContext.Provider value={value}>
      {children}
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
              "Team workspace with paid seats",
            ].map((feature) => (
              <li key={feature} className="flex items-center gap-2">
                <CheckIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                {feature}
              </li>
            ))}
          </ul>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Public MCP access and share links are coming soon.
          </p>
          {!pro && canManage && (
            <div className="space-y-2">
              <label htmlFor="billing-seats" className="text-sm font-medium">
                Seats, including you
              </label>
              <Input
                id="billing-seats"
                type="number"
                min={1}
                max={1000}
                step={1}
                value={seats}
                onChange={(event) =>
                  setSeats(Math.max(1, Math.min(1000, Math.floor(Number(event.target.value) || 1))))
                }
              />
            </div>
          )}
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          {notice && <output className="text-xs text-muted-foreground">{notice}</output>}
          <Button disabled={pending || loading || !canManage} onClick={() => void launch()}>
            {pending ? "Opening…" : pro ? "Open billing portal" : "Continue to checkout"}
            <ArrowUpRightIcon aria-hidden="true" />
          </Button>
          <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <span>
              {pro
                ? "Changes are managed securely by Polar."
                : `${seats} ${seats === 1 ? "user" : "users"} · $${seats * 12} per month`}
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
    </BillingContext.Provider>
  );
}

export function WorkspaceBilling() {
  const { status, canManage, setOpen } = useBilling();

  if (!canManage || !status?.enabled || status.plan !== "free") return null;

  return (
    <div className="mt-auto border-t border-sidebar-border p-3">
      <Button className="w-full" size="sm" onClick={() => setOpen(true)}>
        Upgrade to Pro
        <ArrowUpRightIcon aria-hidden="true" />
      </Button>
    </div>
  );
}

export function BillingSettings({ fileCount }: { fileCount: number }) {
  const {
    status,
    canManage,
    error,
    notice,
    loading,
    pending,
    setOpen,
    setLoading,
    refresh,
    launch,
  } = useBilling();

  if (!status && loading)
    return <output className="text-sm text-muted-foreground">Loading your plan…</output>;
  if (status?.enabled === false)
    return (
      <div className="space-y-2">
        <h2 className="text-sm font-medium">Billing is disabled</h2>
        <p className="text-sm text-muted-foreground">
          This workspace has no subscription or plan limits.
        </p>
      </div>
    );
  const pro = status?.enabled && status.plan === "pro";

  return (
    <section className="space-y-6" aria-label="Workspace billing">
      {status?.enabled && (
        <>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1">
              <h2 className="text-base font-medium">{pro ? "Pro" : "Free"} plan</h2>
              <p className="text-sm text-muted-foreground">
                {pro
                  ? "$12 USD per user / month, plus applicable tax."
                  : "A personal workspace for your first designs."}
              </p>
            </div>
            <Button
              size="sm"
              disabled={pending || loading || !canManage}
              onClick={() => (pro ? void launch() : setOpen(true))}
            >
              {!canManage
                ? "Managed by workspace owner"
                : pending
                  ? "Opening…"
                  : pro
                    ? "Manage subscription"
                    : "Upgrade to Pro"}
              <ArrowUpRightIcon aria-hidden="true" />
            </Button>
          </div>
          <dl className="grid gap-4 rounded-lg border p-4 sm:grid-cols-3">
            <div>
              <dt className="text-xs text-muted-foreground">Design files</dt>
              <dd className="mt-1 text-sm font-medium">
                {fileCount} / {status.limits.designFiles}
              </dd>
              <p className="mt-1 text-xs text-muted-foreground">Including archived files</p>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Image upload limit</dt>
              <dd className="mt-1 text-sm font-medium">
                {status.limits.imageUploadBytes / 1_000_000} MB
              </dd>
              <p className="mt-1 text-xs text-muted-foreground">Per image</p>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">MCP allowance</dt>
              <dd className="mt-1 text-sm font-medium">
                {status.limits.mcpCallsPerWeek.toLocaleString("en-US")} / week
              </dd>
              <p className="mt-1 text-xs text-muted-foreground">Resets Monday, 00:00 UTC</p>
            </div>
          </dl>
          <div className="space-y-2">
            <h3 className="text-sm font-medium">
              {pro ? "Subscription management" : "Need more room?"}
            </h3>
            <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
              {pro
                ? "Update your payment method, download invoices, or cancel your subscription in the billing portal."
                : "Pro includes 250 files, 250 MB image uploads, 500,000 MCP calls per week, and commercial use for $12 per user per month."}
            </p>
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && <output className="block text-sm text-muted-foreground">{notice}</output>}
      <Button
        variant="outline"
        size="sm"
        disabled={loading || pending}
        onClick={() => {
          setLoading(true);
          void refresh(true);
        }}
      >
        {loading ? "Refreshing…" : "Refresh plan"}
      </Button>
    </section>
  );
}
