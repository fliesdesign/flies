import { CheckIcon, ChevronsUpDownIcon, SettingsIcon } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function WorkspaceSwitcher({
  workspace,
  onSettings,
}: {
  workspace: { id: string; name: string } | null;
  onSettings: () => void;
}) {
  const name = workspace?.name ?? "Loading workspace…";

  return (
    <DropdownMenu>
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
          <DropdownMenuItem aria-current="true">
            <span className="flex-1 truncate">{name}</span>
            <CheckIcon aria-label="Current workspace" className="size-3.5 text-muted-foreground" />
          </DropdownMenuItem>
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
