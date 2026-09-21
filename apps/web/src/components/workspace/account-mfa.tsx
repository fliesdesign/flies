import { useCallback, useEffect, useRef, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { api, post } from "@/lib/api";

type MfaStatus = { enrolled: boolean; factorId?: string };
type MfaEnrollment = {
  factorId: string;
  challengeId: string;
  qrCode: string;
  secret: string;
  uri: string;
};

export function AccountMfa() {
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [enrollment, setEnrollment] = useState<MfaEnrollment | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [turningOff, setTurningOff] = useState(false);
  const busy = useRef(false);
  const keepFactor = useRef(false);

  const reload = useCallback(async () => {
    setStatus(await api<MfaStatus>("/api/account/mfa"));
  }, []);

  useEffect(() => {
    // Reload resolves network requests before updating state.
    // eslint-disable-next-line react/set-state-in-effect
    void reload().catch((cause: unknown) =>
      setError(
        cause instanceof Error ? cause.message : "Could not load two-factor authentication.",
      ),
    );
  }, [reload]);

  async function run(action: () => Promise<void>) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError("");
    setNotice("");

    try {
      await action();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not update two-factor authentication.",
      );
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  async function start() {
    keepFactor.current = false;
    await run(async () => {
      setEnrollment(await post<MfaEnrollment>("/api/account/mfa", {}));
      setCode("");
    });
  }

  async function confirm(nextCode: string) {
    if (!enrollment || nextCode.length !== 6) return;
    await run(async () => {
      await post("/api/account/mfa/verify", {
        factorId: enrollment.factorId,
        challengeId: enrollment.challengeId,
        code: nextCode,
      });
      keepFactor.current = true;
      setEnrollment(null);
      setCode("");
      setNotice("Two-factor authentication is on.");
      await reload();
    });
  }

  async function cancelEnrollment() {
    if (keepFactor.current || !enrollment) {
      keepFactor.current = false;
      setEnrollment(null);

      return;
    }

    const factorId = enrollment.factorId;
    setEnrollment(null);
    setCode("");
    await run(async () => {
      await post("/api/account/mfa/remove", { factorId });
      await reload();
    });
  }

  async function turnOff() {
    await run(async () => {
      await post("/api/account/mfa/remove", {});
      setTurningOff(false);
      setNotice("Two-factor authentication is off.");
      await reload();
    });
  }

  return (
    <section className="space-y-4" aria-label="Two-factor authentication">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">Two-factor authentication</h3>
        <p className="text-sm text-muted-foreground">
          Add a one-time code from an authenticator app when you sign in.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm">{status?.enrolled ? "On" : status ? "Off" : "Checking…"}</p>
        {status?.enrolled ? (
          <Button variant="outline" disabled={pending} onClick={() => setTurningOff(true)}>
            Turn off
          </Button>
        ) : (
          <Button variant="outline" disabled={pending || !status} onClick={() => void start()}>
            {pending && !enrollment ? "Starting…" : "Add authenticator app"}
          </Button>
        )}
      </div>
      {notice && <p className="text-sm text-muted-foreground">{notice}</p>}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Dialog
        open={!!enrollment}
        onOpenChange={(open) => {
          if (!open && !pending) void cancelEnrollment();
        }}
      >
        <DialogContent className="sm:max-w-sm" showCloseButton={!pending}>
          <DialogHeader>
            <DialogTitle>Add an authenticator app</DialogTitle>
            <DialogDescription>
              Scan the QR code in your authenticator app, then enter the 6-digit code it shows.
            </DialogDescription>
          </DialogHeader>
          {enrollment && (
            <div className="grid gap-4">
              {enrollment.qrCode.startsWith("data:image/png;base64,") && (
                <img
                  src={enrollment.qrCode}
                  alt="Authenticator QR code"
                  className="mx-auto size-40 rounded-lg bg-white p-2"
                />
              )}
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Can't scan? Enter this key instead.</p>
                <code className="block rounded-lg bg-muted px-2 py-1.5 text-xs break-all">
                  {enrollment.secret}
                </code>
              </div>
              <InputOTP
                maxLength={6}
                value={code}
                disabled={pending}
                aria-label="Authenticator code"
                onChange={(value) => {
                  setCode(value);
                  if (value.length === 6) void confirm(value);
                }}
              >
                <InputOTPGroup>
                  {Array.from({ length: 6 }, (_, index) => (
                    <InputOTPSlot key={index} index={index} />
                  ))}
                </InputOTPGroup>
              </InputOTP>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={pending} onClick={() => void cancelEnrollment()}>
              Cancel
            </Button>
            <Button disabled={pending || code.length !== 6} onClick={() => void confirm(code)}>
              {pending ? "Checking…" : "Turn on"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={turningOff} onOpenChange={setTurningOff}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Turn off two-factor authentication?</AlertDialogTitle>
            <AlertDialogDescription>
              Sign-in will only need your password or connected account.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Keep it on</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={pending}
              onClick={() => void turnOff()}
            >
              {pending ? "Turning off…" : "Turn off"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
