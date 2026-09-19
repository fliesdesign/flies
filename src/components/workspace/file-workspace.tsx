import { isTauri } from "@tauri-apps/api/core";
import { Menu } from "@tauri-apps/api/menu";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { FileIcon, LayoutGridIcon, PlusIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { DesignCanvas, type CanvasControls } from "@/components/canvas/design-canvas";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  createFile,
  FileAutosave,
  importFile,
  listFiles,
  openFile,
  type FileLibrary,
  type LocalFile,
} from "@/lib/local-files";

import { FileLibraryView } from "./file-library";
import "./file-workspace.css";

function TopLoader({ active }: { active: boolean }) {
  return active ? (
    <div className="file-toploader">
      <progress className="sr-only" aria-label="File operation in progress" />
      <span aria-hidden="true" />
    </div>
  ) : null;
}

type FileSession = { flush: () => Promise<void>; rename: (name: string) => Promise<void> };

function FileEditor({
  file,
  onHome,
  onOpen,
  register,
  onSaved,
}: {
  register: (id: string, session: FileSession | null) => void;
  onSaved: (file: LocalFile) => void;
  file: LocalFile;
  onHome: () => void;
  onOpen: (file: LocalFile) => void;
}) {
  const [status, setStatus] = useState("Saved locally");
  const [controls, setControls] = useState<CanvasControls | null>(null);
  const [save] = useState(() => new FileAutosave(file, undefined, setStatus, onSaved));
  const [opening, setOpening] = useState(false);
  useEffect(() => {
    if (!controls) return;
    return controls.document.subscribe(() => save.enqueue(controls.document.getCommittedFrames()));
  }, [controls, save]);
  const flush = useCallback(async () => {
    controls?.prepare();
    await save.flush();
  }, [controls, save]);
  useEffect(() => {
    register(file.id, {
      flush,
      rename: async (name) => {
        controls?.prepare();
        await save.rename(name);
      },
    });
    return () => register(file.id, null);
  }, [file.id, flush, register, controls, save]);
  return (
    <>
      <TopLoader active={opening || status === "Saving…"} />
      <DesignCanvas
        initialFrames={file.nodes}
        persist={false}
        onReady={setControls}
        fileActions={{
          name: file.name,
          status,
          save: flush,
          home: async () => {
            await flush();
            onHome();
          },
          open: async () => {
            setOpening(true);
            try {
              await flush();
              const next = await importFile();
              await flush();
              if (next) onOpen(next);
            } finally {
              setOpening(false);
            }
          },
        }}
      />
      {status.startsWith("Save failed") && (
        <div className="file-save-error" role="alert">
          {status}
          <Button size="sm" onClick={() => void flush().catch(() => {})}>
            Retry save
          </Button>
        </div>
      )}
    </>
  );
}

export function FileWorkspace() {
  const desktop = isTauri();
  const [library, setLibrary] = useState<FileLibrary | null>(null);
  const [files, setFiles] = useState<LocalFile[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const savers = useRef(new Map<string, FileSession>());
  const switching = useRef(false);
  const register = useCallback((id: string, session: FileSession | null) => {
    if (session) savers.current.set(id, session);
    else savers.current.delete(id);
  }, []);
  const activateFile = useCallback((file: LocalFile) => {
    setFiles((current) =>
      current.some((entry) => entry.id === file.id) ? current : [...current, file],
    );
    setActiveId(file.id);
  }, []);
  const [browserCanvas, setBrowserCanvas] = useState(false);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    if (!desktop) return;
    try {
      setLibrary(await listFiles());
      setError("");
    } catch (failure) {
      setError(String(failure));
    }
  }, [desktop]);
  useEffect(() => {
    // Synchronize the file list with the Rust filesystem service.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);
  async function run(action: () => Promise<LocalFile | null>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const file = await action();
      if (file) activateFile(file);
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  }
  const switchTab = useCallback(
    async (id: string | null, closeId?: string) => {
      if (switching.current) return;
      switching.current = true;
      try {
        const saveId = closeId ?? activeId;
        if (saveId) await savers.current.get(saveId)?.flush();
        if (closeId) setFiles((current) => current.filter((file) => file.id !== closeId));
        setActiveId(id);
        setError("");
        if (id === null) void refresh();
      } catch (failure) {
        setError(String(failure));
      } finally {
        switching.current = false;
      }
    },
    [activeId, refresh],
  );
  useEffect(() => {
    if (!desktop) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        !event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        event.isComposing ||
        event.repeat
      )
        return;
      if (!/^[1-9]$/.test(event.key)) return;
      const index = Number(event.key) - 1;
      const target = index === 0 ? null : files[index - 1]?.id;
      if (target === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      if (target !== activeId) void switchTab(target);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [desktop, files, activeId, switchTab]);
  useEffect(() => {
    if (!desktop) return;
    const listener = getCurrentWindow().onCloseRequested(async (event) => {
      try {
        await Promise.all([...savers.current.values()].map((session) => session.flush()));
      } catch (failure) {
        event.preventDefault();
        setError(String(failure));
      }
    });
    return () => {
      void listener.then((unlisten) => unlisten());
    };
  }, [desktop]);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [renameError, setRenameError] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const onSaved = useCallback((saved: LocalFile) => {
    setFiles((current) =>
      current.map((file) => (file.id === saved.id ? { ...file, name: saved.name } : file)),
    );
  }, []);
  const beginRename = (file: LocalFile) => {
    setRenameError("");
    setRenaming({ id: file.id, name: file.name });
  };
  const menuRef = useRef<Menu | null>(null);
  const menuTarget = useRef<{ rename: () => void; close: () => void } | null>(null);
  const menuOpening = useRef(false);
  useEffect(
    () => () => {
      void menuRef.current?.close();
    },
    [],
  );
  async function showTabMenu(file: LocalFile, index: number) {
    if (menuOpening.current) return;
    menuOpening.current = true;
    menuTarget.current = {
      rename: () => beginRename(file),
      close: () => {
        void switchTab(
          activeId === file.id ? (files[index - 1]?.id ?? files[index + 1]?.id ?? null) : activeId,
          file.id,
        );
      },
    };
    try {
      menuRef.current ??= await Menu.new({
        items: [
          { id: "rename-tab", text: "Rename…", action: () => menuTarget.current?.rename() },
          { item: "Separator" },
          { id: "close-tab", text: "Close tab", action: () => menuTarget.current?.close() },
        ],
      });
      await menuRef.current.popup();
    } catch (failure) {
      setError(String(failure));
    } finally {
      menuOpening.current = false;
    }
  }
  async function renameFile() {
    if (!renaming || renameBusy) return;
    const nextName = renaming.name.trim();
    if (!nextName || [...nextName].length > 120 || /\p{Cc}/u.test(nextName)) {
      setRenameError("Choose a name between 1 and 120 characters.");
      return;
    }
    setRenameBusy(true);
    try {
      const session = savers.current.get(renaming.id);
      if (!session) throw new Error("This tab is no longer open.");
      await session.rename(nextName);
      setRenaming(null);
      void refresh();
    } catch (failure) {
      setRenameError(String(failure));
    } finally {
      setRenameBusy(false);
    }
  }
  return (
    <>
      <Dialog
        open={renaming !== null}
        onOpenChange={(open) => {
          if (!open && !renameBusy) setRenaming(null);
        }}
      >
        <DialogContent>
          <DialogTitle>Rename file</DialogTitle>
          <DialogDescription>Update the name of your local file.</DialogDescription>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void renameFile();
            }}
            className="flex flex-col gap-3"
          >
            <Input
              aria-label="File name"
              maxLength={120}
              value={renaming?.name ?? ""}
              disabled={renameBusy}
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) =>
                setRenaming((current) => current && { ...current, name: event.target.value })
              }
            />
            {renameError && (
              <p role="alert" className="text-sm text-destructive">
                {renameError}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={renameBusy}
                onClick={() => setRenaming(null)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={renameBusy || !renaming?.name.trim()}>
                {renameBusy ? "Saving…" : "Rename"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      {desktop && (
        <div className="workspace-tabs" data-tauri-drag-region>
          <div className="workspace-tab-list" aria-label="Open files">
            <button
              className="workspace-tab"
              data-active={activeId === null || undefined}
              title="Files (⌘1)"
              aria-keyshortcuts="Meta+1"
              onClick={() => void switchTab(null)}
            >
              <LayoutGridIcon aria-hidden="true" />
              <span>Files</span>
            </button>
            {files.map((file, index) => (
              <div
                onContextMenu={(event) => {
                  event.preventDefault();
                  void showTabMenu(file, index);
                }}
                className="workspace-tab-group"
                data-active={activeId === file.id || undefined}
                key={file.id}
              >
                <button
                  className="workspace-tab"
                  aria-current={activeId === file.id ? "page" : undefined}
                  onClick={() => void switchTab(file.id)}
                  onDoubleClick={() => beginRename(file)}
                  title={`${file.name}${index < 8 ? ` (⌘${index + 2})` : ""}`}
                  aria-keyshortcuts={index < 8 ? `Meta+${index + 2}` : undefined}
                >
                  <FileIcon aria-hidden="true" />
                  <span>{file.name}</span>
                </button>
                <button
                  className="workspace-tab-close"
                  aria-label={`Close ${file.name}`}
                  onClick={() =>
                    void switchTab(
                      activeId === file.id
                        ? (files[index - 1]?.id ?? files[index + 1]?.id ?? null)
                        : activeId,
                      file.id,
                    )
                  }
                >
                  <XIcon aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
          <button
            className="workspace-tab-add"
            aria-label="New file"
            title="New file"
            disabled={!desktop || busy}
            onClick={() =>
              void run(async () => {
                if (activeId) await savers.current.get(activeId)?.flush();
                return createFile("Untitled", [], folderId);
              })
            }
          >
            <PlusIcon aria-hidden="true" />
          </button>
          <div className="workspace-tab-drag" data-tauri-drag-region />
        </div>
      )}
      {files.map((file) => (
        <div key={file.id} hidden={activeId !== file.id} inert={activeId !== file.id}>
          <FileEditor
            file={file}
            register={register}
            onSaved={onSaved}
            onOpen={activateFile}
            onHome={() => {
              void switchTab(null);
            }}
          />
        </div>
      ))}
      {activeId !== null && error && (
        <div className="file-save-error" role="alert">
          {error}
        </div>
      )}
      {activeId === null &&
        (browserCanvas ? (
          <DesignCanvas />
        ) : (
          <>
            <TopLoader active={busy || (desktop && !library && !error)} />
            <FileLibraryView
              library={library}
              folderId={folderId}
              onFolder={setFolderId}
              busy={busy}
              error={error}
              desktop={desktop}
              onCreate={async (name) => {
                const file = await createFile(name, [], folderId);
                activateFile(file);
              }}
              onOpen={(id) => void run(() => openFile(id))}
              onImport={() => void run(() => importFile(folderId))}
              onRefresh={refresh}
              onBrowser={() => setBrowserCanvas(true)}
            />
          </>
        ))}
    </>
  );
}
