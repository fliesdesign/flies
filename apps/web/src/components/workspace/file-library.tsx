import { formatDistanceToNow } from "date-fns";
import {
  ArchiveIcon,
  ClockIcon,
  FolderIcon,
  SearchIcon,
  SettingsIcon,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState, type CSSProperties } from "react";

import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInput,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@/components/ui/sidebar";
import type { Account } from "@/lib/api";
import type { FileLibrary, FileSummary } from "@/lib/files";
import {
  loadWorkspaceSession,
  patchWorkspaceSession,
  type LibrarySection,
} from "@/lib/workspace-session";

import { FilePreview } from "./file-preview";
import { GetDesktop } from "./get-desktop";
import { WorkspaceBilling, WorkspaceBillingProvider } from "./workspace-billing";
import { WorkspaceSettings } from "./workspace-settings";
import { WorkspaceSwitcher } from "./workspace-switcher";
import "./file-library.css";

type Props = {
  library: FileLibrary | null;
  busy: boolean;
  error: string;
  desktop: boolean;
  section?: LibrarySection;
  onSectionChange?: (section: LibrarySection) => void;
  onCreate: (name: string) => Promise<void>;
  onOpen: (id: string) => void;
  onImport: () => void;
  onArchive: (id: string) => Promise<void>;
  onRestore: (id: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  account?: Account;
  onSignOut?: () => Promise<void>;
};

const SECTIONS: { id: LibrarySection; label: string; icon: LucideIcon }[] = [
  { id: "recents", label: "Recents", icon: ClockIcon },
  { id: "files", label: "Files", icon: FolderIcon },
  { id: "archive", label: "Archive", icon: ArchiveIcon },
  { id: "settings", label: "Settings", icon: SettingsIcon },
];

function SectionIcon({ icon: Icon }: { icon: LucideIcon }) {
  return <Icon aria-hidden="true" strokeWidth={1.7} className="size-3.5 text-muted-foreground" />;
}

const relative = (time: number) => formatDistanceToNow(time, { addSuffix: true });

export function FileLibraryView({
  library,
  busy,
  error,
  desktop,
  onCreate,
  onOpen,
  onImport,
  onArchive,
  onRestore,
  onRefresh,
  account,
  onSignOut,
  section: routeSection,
  onSectionChange,
}: Props) {
  const [creating, setCreating] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState("");

  const [localSection, setSection] = useState<LibrarySection>(
    () => loadWorkspaceSession().librarySection,
  );

  const section = routeSection ?? localSection;

  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"edited" | "name">("edited");

  const files = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const archived = section === "archive";

    const matched = (library?.files ?? []).filter(
      (file) => file.archived === archived && (!needle || file.name.toLowerCase().includes(needle)),
    );

    const ordered = [...matched];
    // Sorting a copy leaves the library index unchanged.
    // eslint-disable-next-line unicorn/no-array-sort
    ordered.sort((a, b) =>
      section === "files" && sort === "name"
        ? a.name.localeCompare(b.name)
        : b.updatedAt - a.updatedAt,
    );

    return ordered;
  }, [library, query, section, sort]);

  const heading = SECTIONS.find((item) => item.id === section)?.label ?? "Recents";
  const showList = section === "recents" || section === "files" || section === "archive";
  const showActions = section === "recents" || section === "files";
  const searching = query.trim().length > 0;

  async function submit() {
    if (creating === null || pending) return;
    setPending(true);
    setFailure("");

    try {
      await onCreate(creating.trim());
      setCreating(null);
    } catch (err) {
      setFailure(String(err));
    } finally {
      setPending(false);
    }
  }

  async function setArchived(file: FileSummary, archived: boolean) {
    if (pending) return;
    setPending(true);
    setFailure("");

    try {
      await (archived ? onArchive : onRestore)(file.id);
    } catch (err) {
      setFailure(String(err));
    } finally {
      setPending(false);
    }
  }

  function fileCard(file: FileSummary) {
    const edited = relative(file.updatedAt);

    return (
      <ContextMenu key={file.id}>
        <ContextMenuTrigger className="library-card-hit" render={<div />}>
          <button
            type="button"
            className="library-card"
            disabled={busy}
            aria-label={`${file.name}, ${edited}`}
            onClick={() => onOpen(file.id)}
          >
            <FilePreview nodes={file.preview} />
            <span className="library-card-meta">
              <strong>{file.name}</strong>
              <time
                dateTime={new Date(file.updatedAt).toISOString()}
                title={new Date(file.updatedAt).toLocaleString()}
              >
                {edited}
              </time>
            </span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-max min-w-0 rounded-md p-0.5">
          <ContextMenuItem
            className="min-h-6 px-2 py-0.5 text-xs"
            onClick={() => void setArchived(file, section !== "archive")}
          >
            {section === "archive" ? "Restore" : "Archive"}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  }

  return (
    <WorkspaceBillingProvider
      key={account?.workspace.id ?? "anonymous"}
      desktop={desktop}
      enabled={!!account}
      canManage={!account?.workspace.ownerId || account.workspace.ownerId === account.user.id}
    >
      <SidebarProvider
        className="library-shell"
        style={{ "--sidebar-width": "14rem" } as CSSProperties}
      >
        <Sidebar collapsible="none" className="library-sidebar">
          <SidebarHeader>
            <WorkspaceSwitcher
              workspace={library?.workspace ?? account?.workspace ?? null}
              onSettings={() => {
                setSection("settings");
                onSectionChange?.("settings");
                patchWorkspaceSession({ librarySection: "settings" });
              }}
            />
            <div className="relative">
              <SearchIcon
                aria-hidden="true"
                strokeWidth={1.7}
                className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
              />
              <SidebarInput
                type="search"
                value={query}
                placeholder="Search"
                aria-label="Search files"
                autoComplete="off"
                spellCheck={false}
                className="h-7 pl-7 text-xs md:text-xs"
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup className="pt-0">
              <SidebarGroupContent>
                <SidebarMenu className="gap-0.5">
                  {SECTIONS.map((item) => (
                    <SidebarMenuItem key={item.id}>
                      <SidebarMenuButton
                        size="sm"
                        className="[&_svg]:size-3.5"
                        isActive={section === item.id}
                        aria-current={section === item.id ? "page" : undefined}
                        onClick={() => {
                          setSection(item.id);
                          onSectionChange?.(item.id);
                          patchWorkspaceSession({ librarySection: item.id });
                        }}
                      >
                        <SectionIcon icon={item.icon} />
                        <span>{item.label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
          {account && <WorkspaceBilling />}
          {!desktop && <GetDesktop />}
        </Sidebar>
        <SidebarInset className="library-home">
          <div className="library-pane">
            <header className="library-header">
              <h1 className="library-heading">{heading}</h1>
              {showActions && (
                <div className="library-actions">
                  <Button disabled={busy} onClick={() => setCreating("Untitled")}>
                    New file
                  </Button>
                  <Button
                    variant="ghost"
                    aria-label="Import file"
                    title="Import a Flies ZIP or JSON project"
                    disabled={busy}
                    onClick={onImport}
                  >
                    Import
                  </Button>
                </div>
              )}
            </header>
            {(error || failure) && creating === null && (
              <p className="file-library-error" role="alert">
                {error || failure} <button onClick={() => void onRefresh()}>Retry</button>
              </p>
            )}
            {showList && (
              <>
                {!library && !error && <p className="library-empty">Loading files…</p>}
                {library && !files.length && (
                  <div className="library-empty">
                    <p>
                      {searching
                        ? "No matching files."
                        : section === "archive"
                          ? "Nothing in the archive."
                          : "No files yet."}
                    </p>
                    {!searching && (
                      <span>
                        {section === "archive"
                          ? "Right-click a file and choose Archive."
                          : "Create a file or import one to get started."}
                      </span>
                    )}
                  </div>
                )}
                {files.length > 0 && (
                  <>
                    {section === "files" && (
                      <div className="library-sort">
                        <button
                          type="button"
                          aria-pressed={sort === "name"}
                          onClick={() => setSort("name")}
                        >
                          Name
                        </button>
                        <button
                          type="button"
                          aria-pressed={sort === "edited"}
                          onClick={() => setSort("edited")}
                        >
                          Edited
                        </button>
                      </div>
                    )}
                    <div className="library-grid">{files.map(fileCard)}</div>
                  </>
                )}
                {library?.warnings.map((warning) => (
                  <p className="file-library-error" key={warning}>
                    {warning}
                  </p>
                ))}
              </>
            )}
            {section === "settings" && (
              <WorkspaceSettings
                desktop={desktop}
                account={account}
                workspaceName={library?.workspace.name}
                fileCount={library?.files.length ?? 0}
                onSignOut={onSignOut}
              />
            )}
          </div>
          <Dialog
            open={creating !== null}
            onOpenChange={(open) => {
              if (!open && !pending) setCreating(null);
            }}
          >
            <DialogContent>
              <DialogTitle>New file</DialogTitle>
              <form
                className="flex flex-col gap-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submit();
                }}
              >
                <Input
                  aria-label="Name"
                  maxLength={120}
                  value={creating ?? ""}
                  onFocus={(event) => event.currentTarget.select()}
                  onChange={(event) => setCreating(event.target.value)}
                />
                {failure && (
                  <p role="alert" className="text-sm text-destructive">
                    {failure}
                  </p>
                )}
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={pending}
                    onClick={() => setCreating(null)}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={pending || !creating?.trim()}>
                    {pending ? "Saving…" : "Create"}
                  </Button>
                </div>
              </form>
            </DialogContent>
          </Dialog>
        </SidebarInset>
      </SidebarProvider>
    </WorkspaceBillingProvider>
  );
}
