import { formatDistanceToNow } from "date-fns";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
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
  const [creating, setCreating] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState("");
  const [sort, setSort] = useState<"edited" | "name">("edited");
  const files = [...(library?.files ?? [])]
    // Sorting a copy leaves the library index unchanged.
    // eslint-disable-next-line unicorn/no-array-sort
    .sort((a, b) => (sort === "name" ? a.name.localeCompare(b.name) : b.updatedAt - a.updatedAt));

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

  function fileRow(file: FileSummary) {
    return (
      <button className="library-row" key={file.id} disabled={busy} onClick={() => onOpen(file.id)}>
        <strong>{file.name}</strong>
        <time
          dateTime={new Date(file.updatedAt).toISOString()}
          title={new Date(file.updatedAt).toLocaleString()}
        >
          {relative(file.updatedAt)}
        </time>
      </button>
    );
  }

  return (
    <main className="library-home">
      <header className="library-header">
        <h1 className="library-heading">Files</h1>
        <div className="library-actions">
          <Button disabled={!desktop || busy} onClick={() => setCreating("Untitled")}>
            New file
          </Button>
          <Button
            variant="ghost"
            aria-label="Import file"
            title="Import a Flies ZIP or JSON project"
            disabled={!desktop || busy}
            onClick={onImport}
          >
            Import
          </Button>
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
              <p>No files yet.</p>
              <span>Create a file or import one to get started.</span>
            </div>
          )}
          {files.length > 0 && (
            <div className="library-list">
              <div className="library-list-head">
                <button type="button" onClick={() => setSort("name")}>
                  Name{sort === "name" ? " ↓" : ""}
                </button>
                <button type="button" onClick={() => setSort("edited")}>
                  Edited{sort === "edited" ? " ↓" : ""}
                </button>
              </div>
              {files.map(fileRow)}
            </div>
          )}
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
