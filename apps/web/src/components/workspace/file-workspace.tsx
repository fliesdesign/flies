import { withAgentActivity } from "@flies/canvas";
import { useBlocker, useLocation, useNavigate } from "@tanstack/react-router";
import { isTauri } from "@tauri-apps/api/core";
import { Menu } from "@tauri-apps/api/menu";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { FileIcon, LayoutGridIcon, PlusIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { DesignCanvas, type CanvasControls } from "@/components/canvas/design-canvas";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { signIn, signOut, type Account } from "@/lib/api";
import {
  archiveFile,
  createFile,
  FileAutosave,
  importFile,
  listFiles,
  openFile,
  restoreFile,
  type FileLibrary,
  type DesignFile,
} from "@/lib/files";
import { connectMcp } from "@/lib/mcp/bridge";
import { editorTool, textResult, stringArg, type McpResult } from "@/lib/mcp/editor";
import { resolveMcpFileId, waitForMcpControls, withFileLock } from "@/lib/mcp/session";
import {
  loadWorkspaceSession,
  patchWorkspaceSession,
  restoreableOpenIds,
} from "@/lib/workspace-session";

import { FileLibraryView } from "./file-library";
import { DesktopUpdateBanner } from "./update-settings";
import "./file-workspace.css";

function TopLoader({ active }: { active: boolean }) {
  return active ? (
    <div className="file-toploader">
      <progress className="sr-only" aria-label="File operation in progress" />
      <span aria-hidden="true" />
    </div>
  ) : null;
}

type FileSession = {
  controls: CanvasControls | null;
  flush: () => Promise<void>;
  isDirty: () => boolean;
  rename: (name: string) => Promise<void>;
};

function FileEditor({
  file,
  onHome,
  onOpen,
  register,
  onSaved,
}: {
  register: (id: string, session: FileSession | null) => void;
  onSaved: (file: DesignFile) => void;
  file: DesignFile;
  onHome: () => void;
  onOpen: (file: DesignFile) => void;
}) {
  const [status, setStatus] = useState("Saved");
  const [controls, setControls] = useState<CanvasControls | null>(null);
  const [save] = useState(() => new FileAutosave(file, undefined, setStatus, onSaved));
  const [opening, setOpening] = useState(false);
  useEffect(() => {
    if (!controls) return;

    return controls.document.subscribe(() =>
      save.enqueue(controls.document.getCommittedFrames(), controls.document.getTheme()),
    );
  }, [controls, save]);

  const flush = useCallback(async () => {
    controls?.prepare();
    await save.flush();
  }, [controls, save]);

  useEffect(() => {
    register(file.id, {
      controls,
      flush,
      isDirty: () => save.isDirty(),
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
        initialTheme={file.theme}
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
          <Button
            size="sm"
            onClick={() => {
              void (save.needsSignIn ? signIn(true).then(flush) : flush()).catch((failure) =>
                setStatus(`Save failed: ${String(failure)}`),
              );
            }}
          >
            {save.needsSignIn ? "Sign in and retry" : "Retry save"}
          </Button>
        </div>
      )}
    </>
  );
}

export function FileWorkspace({
  account,
  onSignedOut,
}: {
  account: Account;
  onSignedOut: () => void;
}) {
  const desktop = isTauri();
  const [library, setLibrary] = useState<FileLibrary | null>(null);
  const [files, setFiles] = useState<DesignFile[]>([]);
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const activeId = /^\/files\/([^/]+)\/?$/.exec(pathname)?.[1] ?? null;

  const section =
    pathname === "/settings"
      ? "settings"
      : pathname === "/files"
        ? "files"
        : pathname === "/archive"
          ? "archive"
          : "recents";

  const [fileError, setFileError] = useState<{ id: string; message: string } | null>(null);

  const navigateFile = useCallback(
    (id: string | null) =>
      id ? navigate({ to: "/files/$id", params: { id } }) : navigate({ to: "/files" }),
    [navigate],
  );

  const [ready, setReady] = useState(false);
  const savers = useRef(new Map<string, FileSession>());
  const switching = useRef(false);

  const register = useCallback((id: string, session: FileSession | null) => {
    if (session) savers.current.set(id, session);
    else savers.current.delete(id);
  }, []);

  const activateFile = useCallback(
    (file: DesignFile) => {
      setFiles((current) =>
        current.some((entry) => entry.id === file.id) ? current : [...current, file],
      );
      void navigateFile(file.id);
    },
    [navigateFile],
  );

  const ensureFile = useCallback((file: DesignFile) => {
    setFiles((current) =>
      current.some((entry) => entry.id === file.id) ? current : [...current, file],
    );
  }, []);

  const forgetFile = useCallback(
    (id: string) => {
      savers.current.delete(id);
      setFiles((current) => current.filter((file) => file.id !== id));
      if (activeId === id) void navigateFile(null);
    },
    [activeId, navigateFile],
  );

  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setLibrary(await listFiles());
      setError("");
    } catch (failure) {
      setError(String(failure));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const listing = await listFiles();
        if (cancelled) return;
        setLibrary(listing);
        setError("");
        const session = loadWorkspaceSession();
        const opened: DesignFile[] = [];

        const restoreIds = restoreableOpenIds(
          session,
          listing.files.filter((file) => !file.archived).map((file) => file.id),
        ).filter(() => desktop);

        for (const id of restoreIds) {
          try {
            // Restore tabs in the saved order so the strip matches the previous session.
            // eslint-disable-next-line no-await-in-loop
            opened.push(await openFile(id));
          } catch {
            /* listed files can still miss a snapshot */
          }

          if (cancelled) return;
        }

        setFiles(opened);
      } catch (failure) {
        if (!cancelled) setError(String(failure));
      } finally {
        if (!cancelled) setReady(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [desktop]);
  useEffect(() => {
    if (!ready) return;
    patchWorkspaceSession({
      openIds: files.map((file) => file.id),
      activeId,
    });
  }, [ready, files, activeId]);

  useBlocker({
    enableBeforeUnload: false,
    shouldBlockFn: async () => {
      try {
        await Promise.all([...savers.current.values()].map((session) => session.flush()));

        return false;
      } catch (failure) {
        setError(String(failure));

        return true;
      }
    },
  });

  // Browser history controls which editor sessions remain mounted.
  /* eslint-disable react/set-state-in-effect */
  useEffect(() => {
    if (!ready) return;

    if (!activeId) {
      if (!desktop && files.length) setFiles([]);

      return;
    }

    const cached = files.find((file) => file.id === activeId);

    if (cached) {
      if (!desktop && files.length > 1) setFiles([cached]);

      return;
    }

    let cancelled = false;
    setFileError(null);
    void openFile(activeId)
      .then((file) => {
        if (!cancelled) setFiles((current) => (desktop ? [...current, file] : [file]));

        return file;
      })
      .catch((failure) => {
        if (!cancelled) setFileError({ id: activeId, message: String(failure) });
      });

    return () => {
      cancelled = true;
    };
  }, [ready, activeId, desktop, files]);
  /* eslint-enable react/set-state-in-effect */

  async function run(action: () => Promise<DesignFile | null>) {
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
        await navigateFile(id);
        setError("");
        if (id === null) void refresh();
      } catch (failure) {
        setError(String(failure));
      } finally {
        switching.current = false;
      }
    },
    [activeId, navigateFile, refresh],
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
      event.preventDefault();

      try {
        await Promise.all([...savers.current.values()].map((session) => session.flush()));
        await getCurrentWindow().destroy();
      } catch (failure) {
        event.preventDefault();
        setError(String(failure));
      }
    });

    return () => {
      void listener.then((unlisten) => unlisten());
    };
  }, [desktop]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if ([...savers.current.values()].some((session) => session.isDirty())) {
        event.preventDefault();
        event.returnValue = "";
      }
    };

    window.addEventListener("beforeunload", warn);

    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [renameError, setRenameError] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);

  const onSaved = useCallback((saved: DesignFile) => {
    setFiles((current) =>
      current.map((file) => (file.id === saved.id ? { ...file, name: saved.name } : file)),
    );
  }, []);

  const beginRename = (file: DesignFile) => {
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

  async function showTabMenu(file: DesignFile, index: number) {
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

  const mcpState = useRef({ activeId, files });
  useEffect(() => {
    mcpState.current = { activeId, files };
  }, [activeId, files]);
  useEffect(() => {
    if (!desktop || !ready) return;

    return connectMcp(async (name, args): Promise<McpResult> => {
      if (name === "list_files") {
        const listing = await listFiles();

        return textResult({
          files: listing.files.map(({ preview: _preview, ...file }) => file),
          warnings: listing.warnings,
        });
      }

      if (name === "create_file" || name === "open_file") {
        const file =
          name === "create_file"
            ? await createFile(stringArg(args, "name"))
            : await openFile(stringArg(args, "fileId"));

        return withFileLock(file.id, async () => {
          ensureFile(file);
          await waitForMcpControls(() => Boolean(savers.current.get(file.id)?.controls));

          return textResult({ fileId: file.id, name: file.name });
        });
      }

      if (name === "archive_file") {
        const fileId = stringArg(args, "fileId");

        return withFileLock(fileId, async () => {
          await savers.current.get(fileId)?.flush();
          await archiveFile(fileId);
          forgetFile(fileId);

          return textResult({ archived: true, fileId });
        });
      }

      if (name === "restore_file") {
        const fileId = stringArg(args, "fileId");
        await restoreFile(fileId);

        return textResult({ restored: true, fileId });
      }

      const fileId = resolveMcpFileId(args, mcpState.current.activeId);
      if (!fileId)
        throw new Error("No open file. Call create_file or open_file first, or pass fileId.");

      return withFileLock(fileId, async () => {
        if (!savers.current.get(fileId)?.controls && args.fileId) {
          ensureFile(await openFile(fileId));
        }

        await waitForMcpControls(
          () => Boolean(savers.current.get(fileId)?.controls),
          "That file is not open. Call open_file or create_file first.",
        );
        const session = savers.current.get(fileId);
        if (!session?.controls)
          throw new Error("That file is not open. Call open_file or create_file first.");
        const loaded = session.controls;

        const controls =
          fileId === mcpState.current.activeId ? loaded : { ...loaded, prepare: () => {} };

        return withAgentActivity(controls.document, name, args, async (saving) => {
          if (name === "get_basic_info") {
            return textResult({
              fileId,
              name: mcpState.current.files.find((file) => file.id === fileId)?.name,
              nodeCount: controls.document.getIds().length,
              roots: controls.document.getChildren().map((id) => {
                const node = controls.document.getFrame(id)!;

                return {
                  id,
                  name: node.name,
                  kind: node.kind ?? "frame",
                  x: node.x,
                  y: node.y,
                  width: node.width,
                  height: node.height,
                };
              }),
              viewport: controls.camera.getCurrent(),
            });
          }

          if (name === "save_file") {
            saving();
            await session.flush();

            return textResult({ saved: true, fileId });
          }

          const result = await editorTool(controls, name, args);

          if (
            [
              "create_artboard",
              "write_html",
              "update_node",
              "set_styles",
              "set_theme",
              "apply_tokens",
              "fit_node",
              "delete_nodes",
              "undo",
              "redo",
            ].includes(name) &&
            !(name === "write_html" && args.validateOnly === true)
          ) {
            saving();
            await session.flush();
          }

          return result;
        });
      });
    });
  }, [desktop, ready, ensureFile, forgetFile]);

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
          <DialogDescription>Update the name of your file.</DialogDescription>
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
      {desktop && ready && (
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
            disabled={busy}
            onClick={() =>
              void run(async () => {
                if (activeId) await savers.current.get(activeId)?.flush();

                return createFile("Untitled");
              })
            }
          >
            <PlusIcon aria-hidden="true" />
          </button>
          <div className="workspace-tab-drag" data-tauri-drag-region />
        </div>
      )}
      {ready &&
        activeId &&
        !files.some((file) => file.id === activeId) &&
        (fileError?.id === activeId ? (
          <main className="flex min-h-screen flex-col items-center justify-center gap-4">
            <p role="alert">{fileError.message}</p>
            <Button onClick={() => void navigateFile(null)}>Back to files</Button>
          </main>
        ) : (
          <TopLoader active />
        ))}
      {ready &&
        files.map((file) => (
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
      <DesktopUpdateBanner desktop={desktop} />
      {!ready && <TopLoader active />}
      {ready && activeId === null && (
        <>
          <TopLoader active={busy || (!library && !error)} />
          <FileLibraryView
            library={library}
            busy={busy}
            error={error}
            desktop={desktop}
            section={section}
            onSectionChange={(next) => {
              void navigate({ to: `/${next}` });
            }}
            onCreate={async (name) => {
              const file = await createFile(name);
              activateFile(file);
            }}
            onOpen={(id) => void run(() => openFile(id))}
            onImport={() => void run(importFile)}
            onArchive={async (id) => {
              await archiveFile(id);
              forgetFile(id);
              await refresh();
            }}
            onRestore={async (id) => {
              await restoreFile(id);
              await refresh();
            }}
            onRefresh={refresh}
            account={account}
            onSignOut={async () => {
              await Promise.all([...savers.current.values()].map((session) => session.flush()));
              await signOut();
              onSignedOut();
            }}
          />
        </>
      )}
    </>
  );
}
