import { formatDistanceToNow } from "date-fns";
import {
  FileIcon,
  LayoutGridIcon,
  ListIcon,
  PlusIcon,
  UploadIcon,
} from "lucide-react";
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { CanvasFrame } from "@/lib/canvas-document";
import type { FileLibrary, FileSummary } from "@/lib/local-files";

import "./file-library.css";

type Props = {
  library: FileLibrary | null;
  busy: boolean;
  error: string;
  desktop: boolean;
  onCreate: (name: string) => Promise<void>;
  onOpen: (id: string) => void;
  onImport: () => void;
  onRefresh: () => Promise<void>;
  onBrowser: () => void;
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
  const [creating, setCreating] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState("");
  const [sort, setSort] = useState<"edited" | "name">("edited");
  const files = (library?.files ?? [])
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
  function fileCard(file: FileSummary) {
    return (
      <article className="library-item" key={file.id}>
        <button className="library-item-open" disabled={busy} onClick={() => onOpen(file.id)}>
          <div className="library-item-title">
            <strong>{file.name}</strong>
            <small>Edited {relative(file.updatedAt)}</small>
          </div>
          <Preview nodes={file.preview ?? []} />
          {view === "list" && (
            <>
              <time className="library-date" title={new Date(file.updatedAt).toLocaleString()}>
                {relative(file.updatedAt)}
              </time>
              <time className="library-date" title={new Date(file.createdAt).toLocaleString()}>
                {relative(file.createdAt)}
              </time>
            </>
          )}
        </button>
      </article>
    );
  }
  return (
    <main className="library-home">
      <header className="library-header">
        <h1 className="library-heading">Files</h1>
        <div className="library-actions">
          <Button disabled={!desktop || busy} onClick={() => setCreating("Untitled")}>
            <PlusIcon />
            New file
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
      {(error || failure) && creating === null && (
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
          {library && !files.length && (
            <div className="library-empty">
              <FileIcon size={30} strokeWidth={1.2} />
              <p>Your files will appear here.</p>
              <span>Create a file or import an existing project.</span>
            </div>
          )}
          <div className={`library-items library-${view}`}>
            {view === "list" && files.length > 0 && (
              <div className="library-list-head">
                <button onClick={() => setSort("name")}>Name{sort === "name" ? " ↓" : ""}</button>
                <button onClick={() => setSort("edited")}>
                  Edited{sort === "edited" ? " ↓" : ""}
                </button>
                <span>Created</span>
              </div>
            )}
            {files.map(fileCard)}
          </div>
          {library?.warnings.map((warning) => (
            <p className="file-library-error" key={warning}>
              {warning}
            </p>
          ))}
        </>
      )}
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
    </main>
  );
}
