import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState } from "react";

import { DesignCanvas, type CanvasControls } from "@/components/canvas/design-canvas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { loadCanvasFrames } from "@/lib/canvas-document";
import {
  createFile,
  FileAutosave,
  importFile,
  listFiles,
  openFile,
  type FileLibrary,
  type LocalFile,
} from "@/lib/local-files";

import "./file-workspace.css";

function FileEditor({
  file,
  onHome,
  onOpen,
}: {
  file: LocalFile;
  onHome: () => void;
  onOpen: (file: LocalFile) => void;
}) {
  const [status, setStatus] = useState("Saved locally");
  const [controls, setControls] = useState<CanvasControls | null>(null);
  const [save] = useState(() => new FileAutosave(file, undefined, setStatus));
  const closing = useRef(false);
  useEffect(() => {
    if (!controls) return;
    return controls.document.subscribe(() => save.enqueue(controls.document.getCommittedFrames()));
  }, [controls, save]);
  const flush = useCallback(async () => {
    controls?.prepare();
    await save.flush();
  }, [controls, save]);
  useEffect(() => {
    let disposed = false;
    const listener = getCurrentWindow().onCloseRequested(async (event) => {
      if (closing.current) return;
      event.preventDefault();
      try {
        await flush();
        closing.current = true;
        await getCurrentWindow().close();
      } catch (error) {
        closing.current = false;
        setStatus(`Save failed: ${String(error)}`);
      }
    });
    void listener.then((unlisten) => {
      if (disposed) unlisten();
    });
    return () => {
      disposed = true;
      void listener.then((unlisten) => unlisten());
    };
  }, [flush]);
  return (
    <>
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
            await flush();
            const next = await importFile();
            await flush();
            if (next) onOpen(next);
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
  const [active, setActive] = useState<LocalFile | null>(null);
  const [browserCanvas, setBrowserCanvas] = useState(false);
  const [name, setName] = useState("Untitled");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    if (!desktop) return;
    try {
      setLibrary(await listFiles());
      setError("");
    } catch (error) {
      setError(String(error));
    }
  }, [desktop]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  async function run(action: () => Promise<LocalFile | null>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const file = await action();
      if (file) setActive(file);
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }
  if (active)
    return (
      <FileEditor
        key={active.id}
        file={active}
        onOpen={setActive}
        onHome={() => {
          setActive(null);
          void refresh();
        }}
      />
    );
  if (browserCanvas) return <DesignCanvas />;
  const previous = desktop && loadCanvasFrames().length > 0;
  return (
    <main className="file-home">
      <div className="file-home-content">
        <header>
          <h1>Flies</h1>
          <p>Your files, on this device.</p>
        </header>
        <form
          className="file-create"
          onSubmit={(event) => {
            event.preventDefault();
            void run(() => createFile(name));
          }}
        >
          <Input
            aria-label="New file name"
            maxLength={120}
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={!desktop || busy}
          />
          <Button type="submit" disabled={!desktop || busy || !name.trim()}>
            New file
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!desktop || busy}
            onClick={() => void run(importFile)}
          >
            Open JSON…
          </Button>
        </form>
        {!desktop && (
          <div className="file-empty">
            <p>Local JSON files are available in the desktop app.</p>
            <Button variant="outline" onClick={() => setBrowserCanvas(true)}>
              Continue in browser
            </Button>
          </div>
        )}
        {error && (
          <div className="file-library-error" role="alert">
            <p>{error}</p>
            <Button variant="outline" size="sm" onClick={() => void refresh()}>
              Retry
            </Button>
          </div>
        )}
        {desktop && (
          <section aria-label="Local files">
            <h2>Files</h2>
            {!library && !error && <p className="file-empty">Loading files…</p>}
            {library && library.files.length === 0 && (
              <p className="file-empty">No files yet. Create one to start designing.</p>
            )}
            <div className="file-list">
              {library?.files.map((file) => (
                <button
                  type="button"
                  key={file.id}
                  disabled={busy}
                  className="file-row"
                  onClick={() => void run(() => openFile(file.id))}
                >
                  <span>
                    <strong>{file.name}</strong>
                    <small>
                      {file.nodeCount} {file.nodeCount === 1 ? "node" : "nodes"}
                    </small>
                  </span>
                  <time dateTime={new Date(file.updatedAt).toISOString()}>
                    {new Date(file.updatedAt).toLocaleString(undefined, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </time>
                </button>
              ))}
            </div>
            {previous && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void run(() => createFile("Recovered canvas", loadCanvasFrames()))}
                disabled={busy}
              >
                Recover previous canvas
              </Button>
            )}
            {library?.warnings.map((warning) => (
              <p className="file-library-error" key={warning}>
                {warning}
              </p>
            ))}
            <p className="file-storage-note">
              Changes save automatically. Opening a JSON file adds a copy to your library.
            </p>
            {library && (
              <details className="file-storage-note">
                <summary>Storage location</summary>
                <p>{library.directory}</p>
              </details>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
