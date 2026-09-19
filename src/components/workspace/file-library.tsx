import { formatDistanceToNow } from "date-fns";
import {
  FolderIcon,
  LayoutGridIcon,
  ListIcon,
  MoreHorizontalIcon,
  PlusIcon,
  ChevronRightIcon,
  FileIcon,
  UploadIcon,
} from "lucide-react";
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import type { CanvasFrame } from "@/lib/canvas-document";
import {
  createFolder,
  renameFolder,
  moveLibraryItem,
  type FileLibrary,
  type FileSummary,
  type LibraryFolder,
} from "@/lib/local-files";

import "./file-library.css";

type Props = {
  library: FileLibrary | null;
  folderId: string | null;
  onFolder: (id: string | null) => void;
  busy: boolean;
  error: string;
  desktop: boolean;
  onCreate: (name: string) => Promise<void>;
  onOpen: (id: string) => void;
  onImport: () => void;
  onRefresh: () => Promise<void>;
  onBrowser: () => void;
};
type Action = {
  kind: "new-file" | "new-folder" | "rename-folder" | "move";
  id?: string;
  name: string;
  folder?: boolean;
};

function Preview({ nodes }: { nodes: CanvasFrame[] }) {
  const prefix = useId();
  if (!nodes.length)
    return (
      <div className="library-preview library-preview-empty">
        <FileIcon size={28} strokeWidth={1.2} />
      </div>
    );
  const left = Math.min(...nodes.map((n) => n.x));
  const top = Math.min(...nodes.map((n) => n.y));
  const width = Math.max(1, ...nodes.map((n) => n.x + n.width - left));
  const height = Math.max(1, ...nodes.map((n) => n.y + n.height - top));
  const pad = Math.max(width, height) * 0.06;
  return (
    <div className="library-preview">
      <svg
        aria-hidden="true"
        viewBox={`${left - pad} ${top - pad} ${width + pad * 2} ${height + pad * 2}`}
      >
        {nodes.map((node, index) => {
          const kind = node.kind ?? "frame";
          if (kind === "group") return null;
          const shape = node as CanvasFrame & {
            fill?: string;
            color?: string;
            text?: string;
            fontSize?: number;
            cornerRadius?: number;
          };
          const clip = `${prefix}-${index}`;
          return (
            <g key={node.id} opacity={node.opacity ?? 1}>
              {kind === "text" ? (
                <>
                  <defs>
                    <clipPath id={clip}>
                      <rect x={node.x} y={node.y} width={node.width} height={node.height} />
                    </clipPath>
                  </defs>
                  <text
                    x={node.x}
                    y={node.y + (shape.fontSize ?? 14)}
                    fontSize={shape.fontSize ?? 14}
                    fill={shape.color ?? "#222"}
                    clipPath={`url(#${clip})`}
                  >
                    {shape.text}
                  </text>
                </>
              ) : (
                <rect
                  x={node.x}
                  y={node.y}
                  width={node.width}
                  height={node.height}
                  rx={shape.cornerRadius ?? 0}
                  fill={shape.fill ?? (kind === "frame" ? "#fff" : "#888")}
                />
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

const relative = (time: number) => formatDistanceToNow(time, { addSuffix: true });

export function FileLibraryView({
  library,
  folderId,
  onFolder,
  busy,
  error,
  desktop,
  onCreate,
  onOpen,
  onImport,
  onRefresh,
  onBrowser,
}: Props) {
  const [view, setView] = useState<"grid" | "list">(() => {
    try {
      return localStorage.getItem("flies.library-view") === "list" ? "list" : "grid";
    } catch {
      return "grid";
    }
  });
  const [action, setAction] = useState<Action | null>(null);
  const [destination, setDestination] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState("");
  const [sort, setSort] = useState<"edited" | "name">("edited");
  const folders = library?.folders ?? [];
  const current = folders.find((folder) => folder.id === folderId);
  const breadcrumb: LibraryFolder[] = [];
  const visited = new Set<string>();
  let ancestor = current;
  while (ancestor && !visited.has(ancestor.id)) {
    breadcrumb.unshift(ancestor);
    visited.add(ancestor.id);
    ancestor = folders.find((folder) => folder.id === ancestor?.parentId);
  }
  const shownFolders = folders.filter((folder) => folder.parentId === folderId);
  const files = (library?.files ?? [])
    .filter((file) => file.folderId === folderId)
    // Sorting the filtered copy leaves the library index unchanged.
    // eslint-disable-next-line unicorn/no-array-sort
    .sort((a, b) => (sort === "name" ? a.name.localeCompare(b.name) : b.updatedAt - a.updatedAt));
  function chooseView(next: "grid" | "list") {
    setView(next);
    try {
      localStorage.setItem("flies.library-view", next);
    } catch {
      /* View preferences are optional. */
    }
  }
  function showAction(next: Action) {
    setFailure("");
    setDestination(folderId ?? "");
    setAction(next);
  }
  function folderPath(folder: LibraryFolder) {
    const names = [folder.name];
    const seen = new Set([folder.id]);
    let parent = folder.parentId;
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      const item = folders.find((f) => f.id === parent);
      if (!item) break;
      names.unshift(item.name);
      parent = item.parentId;
    }
    return names.join(" / ");
  }
  function validDestination(folder: LibraryFolder) {
    if (!action?.folder) return true;
    let item: LibraryFolder | undefined = folder;
    const seen = new Set<string>();
    while (item && !seen.has(item.id)) {
      if (item.id === action.id) return false;
      seen.add(item.id);
      item = folders.find((f) => f.id === item?.parentId);
    }
    return true;
  }
  async function submit() {
    if (!action || pending) return;
    setPending(true);
    setFailure("");
    try {
      if (action.kind === "new-file") await onCreate(action.name.trim());
      else if (action.kind === "new-folder") await createFolder(action.name.trim(), folderId);
      else if (action.kind === "rename-folder" && action.id)
        await renameFolder(action.id, action.name.trim());
      else if (action.kind === "move" && action.id)
        await moveLibraryItem(action.id, destination || null, Boolean(action.folder));
      await onRefresh();
      setAction(null);
    } catch (err) {
      setFailure(String(err));
    } finally {
      setPending(false);
    }
  }
  function itemMenu(item: FileSummary | LibraryFolder, folder: boolean) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger className="library-item-menu" aria-label={`Actions for ${item.name}`}>
          <MoreHorizontalIcon size={16} />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="canvas-menu">
          {folder && (
            <DropdownMenuItem
              onClick={() =>
                showAction({ kind: "rename-folder", id: item.id, name: item.name, folder })
              }
            >
              Rename folder…
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onClick={() => showAction({ kind: "move", id: item.id, name: item.name, folder })}
          >
            Move to…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }
  return (
    <main className="library-home">
      <header className="library-header">
        <nav aria-label="Folder breadcrumb">
          <button className="library-heading" onClick={() => onFolder(null)}>
            Files
          </button>
          {breadcrumb.map((folder) => (
            <span key={folder.id}>
              <ChevronRightIcon size={16} />
              <button onClick={() => onFolder(folder.id)}>{folder.name}</button>
            </span>
          ))}
        </nav>
        <div className="library-actions">
          <Button
            disabled={!desktop || busy}
            onClick={() => showAction({ kind: "new-file", name: "Untitled" })}
          >
            <PlusIcon />
            New file
          </Button>
          <Button
            variant="outline"
            disabled={!desktop || busy}
            onClick={() => showAction({ kind: "new-folder", name: "New folder" })}
          >
            <PlusIcon />
            New folder
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Import file"
            title="Import JSON or compressed JSON"
            disabled={!desktop || busy}
            onClick={onImport}
          >
            <UploadIcon size={16} />
          </Button>
          <div className="library-view-toggle" aria-label="File view">
            <button
              aria-label="Grid view"
              aria-pressed={view === "grid"}
              onClick={() => chooseView("grid")}
            >
              <LayoutGridIcon size={17} />
            </button>
            <button
              aria-label="List view"
              aria-pressed={view === "list"}
              onClick={() => chooseView("list")}
            >
              <ListIcon size={18} />
            </button>
          </div>
        </div>
      </header>
      {(error || failure) && !action && (
        <p className="file-library-error" role="alert">
          {error || failure} <button onClick={() => void onRefresh()}>Retry</button>
        </p>
      )}
      {!desktop ? (
        <div className="library-empty">
          <p>Local files are available in the desktop app.</p>
          <Button variant="outline" onClick={onBrowser}>
            Continue in browser
          </Button>
        </div>
      ) : (
        <>
          {!library && !error && <p className="library-empty">Loading files…</p>}
          {library && !files.length && !shownFolders.length && (
            <div className="library-empty">
              <FolderIcon size={30} strokeWidth={1.2} />
              <p>{folderId ? "This folder is empty." : "Your files will appear here."}</p>
              <span>Create a file or import an existing project.</span>
            </div>
          )}
          <div className={`library-items library-${view}`}>
            {view === "list" && (files.length > 0 || shownFolders.length > 0) && (
              <div className="library-list-head">
                <button onClick={() => setSort("name")}>Name{sort === "name" ? " ↓" : ""}</button>
                <button onClick={() => setSort("edited")}>
                  Edited{sort === "edited" ? " ↓" : ""}
                </button>
                <span>Created</span>
              </div>
            )}
            {shownFolders.map((folder) => (
              <article className="library-item library-folder" key={folder.id}>
                <button className="library-item-open" onClick={() => onFolder(folder.id)}>
                  <div className="library-item-title">
                    <strong>{folder.name}</strong>
                    <small>Folder</small>
                  </div>
                  <div className="library-folder-preview">
                    <FolderIcon size={view === "grid" ? 44 : 26} strokeWidth={1.3} />
                  </div>
                  {view === "list" && (
                    <>
                      <span className="library-date">—</span>
                      <time className="library-date">{relative(folder.createdAt)}</time>
                    </>
                  )}
                </button>
                {itemMenu(folder, true)}
              </article>
            ))}
            {files.map((file) => (
              <article className="library-item" key={file.id}>
                <button
                  className="library-item-open"
                  disabled={busy}
                  onClick={() => onOpen(file.id)}
                >
                  <div className="library-item-title">
                    <strong>{file.name}</strong>
                    <small>Edited {relative(file.updatedAt)}</small>
                  </div>
                  <Preview nodes={file.preview} />
                  {view === "list" && (
                    <>
                      <time
                        className="library-date"
                        title={new Date(file.updatedAt).toLocaleString()}
                      >
                        {relative(file.updatedAt)}
                      </time>
                      <time
                        className="library-date"
                        title={new Date(file.createdAt).toLocaleString()}
                      >
                        {relative(file.createdAt)}
                      </time>
                    </>
                  )}
                </button>
                {itemMenu(file, false)}
              </article>
            ))}
          </div>
          {library?.warnings.map((warning) => (
            <p className="file-library-error" key={warning}>
              {warning}
            </p>
          ))}
        </>
      )}
      <Dialog
        open={action !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setAction(null);
        }}
      >
        <DialogContent>
          <DialogTitle>
            {action?.kind === "move"
              ? `Move ${action.name}`
              : action?.kind === "rename-folder"
                ? "Rename folder"
                : action?.kind === "new-folder"
                  ? "New folder"
                  : "New file"}
          </DialogTitle>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            {action?.kind === "move" ? (
              <label className="flex flex-col gap-2 text-sm">
                Destination
                <select
                  className="library-destination"
                  value={destination}
                  onChange={(event) => setDestination(event.target.value)}
                >
                  <option value="">Files</option>
                  {folders.filter(validDestination).map((folder) => (
                    <option key={folder.id} value={folder.id}>
                      {folderPath(folder)}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <Input
                aria-label="Name"
                maxLength={120}
                value={action?.name ?? ""}
                onFocus={(event) => event.currentTarget.select()}
                onChange={(event) =>
                  setAction(
                    (currentAction) =>
                      currentAction && { ...currentAction, name: event.target.value },
                  )
                }
              />
            )}
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
                onClick={() => setAction(null)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={pending || !action?.name.trim()}>
                {pending
                  ? "Saving…"
                  : action?.kind === "move"
                    ? "Move"
                    : action?.kind === "rename-folder"
                      ? "Rename"
                      : "Create"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </main>
  );
}
