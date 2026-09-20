import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, post } from "@/lib/api";

import { useBilling } from "./workspace-billing";

export type WorkspaceList = {
  workspaces: { id: string; name: string; ownerId: string }[];
  invitations: { id: string; workspaceName: string; expiresAt: string }[];
};
type Team = {
  owner: boolean;
  seats: number | null;
  used: number;
  reserved: number;
  members: { userId: string; name: string; email: string; role: string; active: boolean }[];
  invitations: { id: string; email: string; expiresAt: string }[];
};

export async function switchWorkspace(id: string) {
  await post("/api/workspaces/switch", { id });
  window.location.assign("/recents");
}

export function WorkspaceMembers() {
  const [team, setTeam] = useState<Team | null>(null);
  const [incoming, setIncoming] = useState<WorkspaceList["invitations"]>([]);
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const { setOpen, status, refresh } = useBilling();

  const reload = useCallback(async () => {
    const [next, list] = await Promise.all([
      api<Team>("/api/workspaces/members"),
      api<WorkspaceList>("/api/workspaces"),
    ]);

    setTeam(next);
    setIncoming(list.invitations);
    await refresh();
  }, [refresh]);

  useEffect(() => {
    // Reload resolves network requests before updating state.
    // eslint-disable-next-line react/set-state-in-effect
    void reload().catch((cause: unknown) =>
      setError(cause instanceof Error ? cause.message : "Could not load members."),
    );
  }, [reload]);

  async function run(action: () => Promise<unknown>, message: string) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError("");
    setNotice("");

    try {
      await action();
      setNotice(message);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not complete the request.");
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  const full = !!team && team.seats !== null && team.used + team.reserved >= team.seats;

  return (
    <section className="space-y-6" aria-label="Workspace members">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-base font-medium">Your workspace team</h2>
          <p className="text-sm text-muted-foreground">
            Invite people to work on the files in this workspace.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => void run(reload, "Members refreshed.")}
        >
          Refresh
        </Button>
      </div>
      {incoming.length > 0 && (
        <div className="space-y-3 rounded-lg border p-4">
          <h3 className="text-sm font-medium">Invitations for you</h3>
          {incoming.map((invitation) => (
            <div key={invitation.id} className="flex items-center justify-between gap-3 text-sm">
              <span>{invitation.workspaceName}</span>
              <Button
                size="sm"
                disabled={pending}
                onClick={() =>
                  void run(async () => {
                    const { workspaceId } = await post<{ workspaceId: string }>(
                      `/api/workspaces/invitations/${invitation.id}/accept`,
                      {},
                    );

                    await switchWorkspace(workspaceId);
                  }, "Invitation accepted.")
                }
              >
                Join workspace
              </Button>
            </div>
          ))}
        </div>
      )}
      {team ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border p-4">
            <div>
              <p className="text-sm font-medium">
                {team.seats === null
                  ? `${team.used} members · unlimited seats`
                  : `${team.used + team.reserved} of ${team.seats} seats occupied`}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {team.used} {team.used === 1 ? "member" : "members"}, including the owner ·{" "}
                {team.reserved} pending invitations
              </p>
            </div>
            {team.owner && status?.enabled && (
              <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
                {status.plan === "pro" ? "Manage seats" : "Upgrade to Pro"}
              </Button>
            )}
          </div>
          {team.owner ? (
            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  await post("/api/workspaces/invitations", { email: email.trim() });
                  setEmail("");
                }, "Invitation sent. The seat is reserved until they join or the invitation expires.");
              }}
            >
              <label htmlFor="invite-email" className="text-sm font-medium">
                Invite by email
              </label>
              <div className="flex flex-wrap gap-2">
                <Input
                  id="invite-email"
                  type="email"
                  required
                  maxLength={254}
                  value={email}
                  disabled={pending || full}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="teammate@company.com"
                  className="min-w-48 flex-1"
                />
                <Button type="submit" size="sm" disabled={pending || full || !email.trim()}>
                  {pending ? "Working…" : "Send invitation"}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {full
                  ? "All seats are occupied. Add seats in Billing or revoke an invitation to make room."
                  : "Invitations expire after 7 days and reserve one seat. Invitees must sign in with this email."}
              </p>
            </form>
          ) : (
            <p className="text-sm text-muted-foreground">
              Only the workspace owner can invite people or manage seats.
            </p>
          )}
          <div className="divide-y rounded-lg border px-4">
            {team.members.map((member) => (
              <div key={member.userId} className="flex items-center justify-between gap-3 py-4">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {member.name}{" "}
                    <span className="font-normal text-muted-foreground">
                      ·{" "}
                      {member.role === "owner"
                        ? "Owner"
                        : member.active
                          ? "Member"
                          : "No paid seat"}
                    </span>
                  </p>
                  <p className="truncate text-xs text-muted-foreground">{member.email}</p>
                </div>
                {team.owner && member.role !== "owner" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() =>
                      void run(
                        () => post("/api/workspaces/members/remove", { userId: member.userId }),
                        "Member removed.",
                      )
                    }
                  >
                    Remove
                  </Button>
                )}
              </div>
            ))}
            {team.invitations.map((invitation) => (
              <div key={invitation.id} className="flex items-center justify-between gap-3 py-4">
                <div className="min-w-0">
                  <p className="truncate text-sm">{invitation.email}</p>
                  <p className="text-xs text-muted-foreground">
                    Invited · expires {new Date(invitation.expiresAt).toLocaleDateString()}
                  </p>
                </div>
                {team.owner && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() =>
                      void run(
                        () => post(`/api/workspaces/invitations/${invitation.id}/revoke`, {}),
                        "Invitation revoked.",
                      )
                    }
                  >
                    Revoke
                  </Button>
                )}
              </div>
            ))}
          </div>
        </>
      ) : (
        !error && <output className="text-sm text-muted-foreground">Loading members…</output>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && <output className="block text-sm text-muted-foreground">{notice}</output>}
    </section>
  );
}
