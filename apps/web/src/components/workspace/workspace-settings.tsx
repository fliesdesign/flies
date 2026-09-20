import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Account } from "@/lib/api";

import { AppearanceSettings } from "./appearance-settings";
import { UpdateSettings } from "./update-settings";
import { BillingSettings } from "./workspace-billing";
import { WorkspaceMembers } from "./workspace-members";

export function WorkspaceSettings({
  desktop,
  account,
  workspaceName,
  fileCount,
  onSignOut,
}: {
  desktop: boolean;
  account?: Account;
  workspaceName?: string;
  fileCount: number;
  onSignOut?: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  return (
    <Tabs defaultValue="appearance" className="max-w-3xl gap-6">
      <div className="overflow-x-auto border-b pb-1">
        <TabsList variant="line" aria-label="Settings sections" className="gap-2">
          <TabsTrigger value="appearance">Appearance</TabsTrigger>
          <TabsTrigger value="billing">Billing</TabsTrigger>
          <TabsTrigger value="members">Members</TabsTrigger>
          <TabsTrigger value="updates">Updates</TabsTrigger>
          <TabsTrigger value="account">Account</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="appearance">
        <div className="mb-6 space-y-1">
          <h2 className="text-base font-medium">Make it yours</h2>
          <p className="text-sm text-muted-foreground">
            Adjust the interface colors and contrast on this device.
          </p>
        </div>
        <AppearanceSettings />
      </TabsContent>
      <TabsContent value="billing">
        <BillingSettings fileCount={fileCount} />
      </TabsContent>
      <TabsContent value="members">
        <WorkspaceMembers />
      </TabsContent>
      <TabsContent value="updates">
        <div className="mb-6 space-y-1">
          <h2 className="text-base font-medium">Keep Flies up to date</h2>
          <p className="text-sm text-muted-foreground">
            Get the latest improvements for your desktop app.
          </p>
        </div>
        <UpdateSettings desktop={desktop} />
      </TabsContent>
      <TabsContent value="account">
        <section className="space-y-6" aria-label="Account details">
          <div className="space-y-1">
            <h2 className="text-base font-medium">Your account</h2>
            <p className="text-sm text-muted-foreground">Your profile and current workspace.</p>
          </div>
          <dl className="grid gap-5 text-sm">
            {account && (
              <>
                <div>
                  <dt className="text-xs text-muted-foreground">Name</dt>
                  <dd className="mt-1 break-words">{account.user.name}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Email</dt>
                  <dd className="mt-1 break-words">{account.user.email}</dd>
                </div>
              </>
            )}
            <div>
              <dt className="text-xs text-muted-foreground">Workspace</dt>
              <dd className="mt-1 break-words">
                {workspaceName ?? account?.workspace.name ?? "Loading…"}
              </dd>
            </div>
          </dl>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {onSignOut && (
            <div className="border-t pt-5">
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => {
                  setPending(true);
                  setError("");
                  void onSignOut()
                    .catch((cause) =>
                      setError(
                        cause instanceof Error
                          ? cause.message
                          : "Could not sign out. Please retry.",
                      ),
                    )
                    .finally(() => setPending(false));
                }}
              >
                {pending ? "Signing out…" : "Sign out"}
              </Button>
            </div>
          )}
        </section>
      </TabsContent>
    </Tabs>
  );
}
