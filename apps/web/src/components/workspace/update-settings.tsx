import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  checkForDesktopUpdate,
  desktopAppVersion,
  formatUpdateError,
  shouldAutoCheckUpdates,
  updateStatusText,
  type DesktopUpdate,
  type UpdateStatus,
} from "@/lib/updates";

import "./update-settings.css";

export function UpdateSettings({ desktop }: { desktop: boolean }) {
  const [version, setVersion] = useState<string | null>(null);
  const [status, setStatus] = useState<UpdateStatus>({ kind: "idle" });
  const pending = useRef<DesktopUpdate | null>(null);
  const busy = status.kind === "checking" || status.kind === "downloading";

  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    void (async () => {
      try {
        const next = await desktopAppVersion();
        if (!cancelled) setVersion(next);
      } catch {
        if (!cancelled) setVersion(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [desktop]);

  async function check() {
    setStatus({ kind: "checking" });
    try {
      const found = await checkForDesktopUpdate();
      pending.current = found;
      setStatus(
        found
          ? { kind: "available", version: found.version, notes: found.notes }
          : { kind: "current" },
      );
    } catch (error) {
      pending.current = null;
      setStatus({ kind: "error", message: formatUpdateError(error) });
    }
  }

  async function install() {
    const update = pending.current;
    if (!update) return;
    setStatus({ kind: "downloading", received: 0, total: 0 });
    try {
      await update.install((progress) => {
        setStatus({ kind: "downloading", ...progress });
      });
    } catch (error) {
      setStatus({ kind: "error", message: formatUpdateError(error) });
    }
  }

  return (
    <div className="library-setting-files update-settings">
      <p className="library-setting-label">Updates</p>
      {!desktop ? (
        <p className="library-setting-value">Updates are available in the desktop app.</p>
      ) : (
        <>
          <p className="library-setting-value">{version ? `Version ${version}` : "Desktop app"}</p>
          <p className="appearance-hint" role={status.kind === "error" ? "alert" : undefined}>
            {updateStatusText(status)}
          </p>
          {status.kind === "available" && status.notes ? (
            <p className="update-notes">{status.notes}</p>
          ) : null}
          <div className="update-actions">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void check()}
            >
              {status.kind === "checking" ? "Checking…" : "Check for updates"}
            </Button>
            {(status.kind === "available" || status.kind === "downloading") && (
              <Button
                type="button"
                size="sm"
                disabled={status.kind === "downloading"}
                onClick={() => void install()}
              >
                {status.kind === "downloading" ? updateStatusText(status) : "Install and restart"}
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export function DesktopUpdateBanner({ desktop }: { desktop: boolean }) {
  const [status, setStatus] = useState<UpdateStatus>({ kind: "idle" });
  const pending = useRef<DesktopUpdate | null>(null);

  useEffect(() => {
    if (!shouldAutoCheckUpdates(desktop, import.meta.env.PROD)) return;
    let cancelled = false;
    void (async () => {
      try {
        const found = await checkForDesktopUpdate();
        if (cancelled || !found) return;
        pending.current = found;
        setStatus({ kind: "available", version: found.version, notes: found.notes });
      } catch {
        /* production launch check stays silent when GitHub is unreachable */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [desktop]);

  async function install() {
    const update = pending.current;
    if (!update) return;
    setStatus({ kind: "downloading", received: 0, total: 0 });
    try {
      await update.install((progress) => {
        setStatus({ kind: "downloading", ...progress });
      });
    } catch (error) {
      setStatus({ kind: "error", message: formatUpdateError(error) });
    }
  }

  if (status.kind !== "available" && status.kind !== "downloading") return null;

  return (
    <output className="file-update-banner">
      <span>{updateStatusText(status)}</span>
      <Button size="sm" disabled={status.kind === "downloading"} onClick={() => void install()}>
        {status.kind === "downloading" ? "Installing…" : "Install and restart"}
      </Button>
    </output>
  );
}
