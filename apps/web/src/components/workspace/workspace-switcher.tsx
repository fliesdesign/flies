import { CheckIcon, ChevronsUpDownIcon, SettingsIcon } from "lucide-react";
import { useState } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api } from "@/lib/api";

import { switchWorkspace, type WorkspaceList } from "./workspace-members";

export function WorkspaceSwitcher({
  workspace,
  onSettings,
}: {
  workspace: { id: string; name: string } | null;
  onSettings: () => void;
}) {
  const [list, setList] = useState<WorkspaceList | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const name = workspace?.name ?? "Loading workspace…";

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open)
          void api<WorkspaceList>("/api/workspaces")
            .then((value) => {
              setList(value);
              setError("");

              return value;
            })
            .catch(() => setError("Could not load workspaces. Reopen to retry."));
      }}
    >
      <DropdownMenuTrigger
        disabled={!workspace}
        aria-label={`Switch workspace: ${name}`}
        className="flex w-full items-center gap-2.5 rounded-lg px-1.5 py-2 text-left transition-colors hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50 data-popup-open:bg-sidebar-accent"
      >
        <span
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary text-sm font-semibold text-sidebar-primary-foreground"
        >
          {workspace?.name.trim().charAt(0).toUpperCase() || "F"}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{name}</span>
        <ChevronsUpDownIcon
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={6} className="min-w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
          {(list?.workspaces ?? (workspace ? [workspace] : [])).map((item) => (
            <DropdownMenuItem
              key={item.id}
              aria-current={item.id === workspace?.id ? "true" : undefined}
              disabled={pending}
              onClick={() => {
                if (item.id === workspace?.id) return;
                setPending(true);
                void switchWorkspace(item.id).catch((cause: unknown) => {
                  setError(cause instanceof Error ? cause.message : "Could not switch workspace.");
                  setPending(false);
                });
              }}
            >
              <span className="flex-1 truncate">{item.name}</span>
              {item.id === workspace?.id && (
                <CheckIcon
                  aria-label="Current workspace"
                  className="size-3.5 text-muted-foreground"
                />
              )}
            </DropdownMenuItem>
          ))}
          {!!list?.invitations.length && (
            <DropdownMenuItem onClick={onSettings}>
              {list.invitations.length} pending invitations · Settings → Members
            </DropdownMenuItem>
          )}
          {error && (
            <p role="alert" className="max-w-64 px-2 py-1 text-xs text-destructive">
              {error}
            </p>
          )}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onSettings}>
          <SettingsIcon aria-hidden="true" />
          Settings
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
