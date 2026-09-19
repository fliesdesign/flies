import { MoreHorizontalIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { CanvasDocument, CanvasFrame } from "@/lib/canvas-document";
import {
  downloadCanvasFile,
  MAX_PROJECT_BYTES,
  parseCanvasProject,
  projectFilename,
  serializeCanvasProject,
} from "@/lib/canvas-project";

export type CanvasFileActions = {
  name: string;
  status: string;
  save: () => Promise<void>;
  open: () => Promise<void>;
  home: () => Promise<void>;
};

type CanvasFileMenuProps = {
  fileActions?: CanvasFileActions;
  document: CanvasDocument;
  selectedIds: readonly string[];
  onPrepare: () => void;
  onOpen: (nodes: CanvasFrame[]) => void;
  onNotice: (message: string) => void;
};

export function CanvasFileMenu({
  fileActions,
  document,
  selectedIds,
  onPrepare,
  onOpen,
  onNotice,
}: CanvasFileMenuProps) {
  const [name, setName] = useState("Untitled");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const prepare = useCallback(() => {
    // Text drafts and typed property values commit before collecting the file snapshot.
    const active = fileRef.current?.ownerDocument.activeElement;
    if (active instanceof HTMLElement) active.blur();
    onPrepare();
  }, [onPrepare]);

  const runAction = useCallback(
    async (action: () => Promise<void>) => {
      if (busyRef.current) return;
      prepare();
      busyRef.current = true;
      setBusy(true);
      try {
        await action();
      } catch (error) {
        onNotice(String(error));
      } finally {
        busyRef.current = false;
        if (mounted.current) setBusy(false);
      }
    },
    [prepare, onNotice],
  );

  const save = useCallback(() => {
    if (fileActions) {
      void runAction(fileActions.save);
      return;
    }
    if (busyRef.current) return;
    prepare();
    downloadCanvasFile(
      new Blob([serializeCanvasProject(name, document.getCommittedFrames())], {
        type: "application/json",
      }),
      projectFilename(name),
    );
    onNotice("Project downloaded.");
  }, [document, name, onNotice, prepare, fileActions, runAction]);

  const open = useCallback(() => {
    if (fileActions) {
      void runAction(fileActions.open);
      return;
    }
    if (busyRef.current) return;
    prepare();
    fileRef.current?.click();
  }, [prepare, fileActions, runAction]);

  const exportPng = useCallback(async () => {
    if (busyRef.current) return;
    if (!selectedIds.length) {
      onNotice("Select a frame or layer to export.");
      return;
    }
    prepare();
    busyRef.current = true;
    setBusy(true);
    const nodes = document.getCommittedFrames();
    const filename =
      selectedIds.length === 1
        ? (document.getFrame(selectedIds[0])?.name ?? name)
        : `${name} selection`;
    onNotice("Exporting PNG…");
    try {
      const { exportCanvasPng } = await import("./canvas-export");
      const blob = await exportCanvasPng(nodes, selectedIds);
      if (mounted.current) {
        downloadCanvasFile(blob, projectFilename(filename, "png"));
        onNotice("PNG downloaded at 1× size.");
      }
    } catch (error) {
      if (mounted.current)
        onNotice(error instanceof Error ? error.message : "Could not export this selection.");
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [document, name, onNotice, prepare, selectedIds]);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.isComposing || !(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "s" && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        save();
      } else if (key === "o" && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        open();
      } else if (key === "e" && event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        void exportPng();
      }
    };
    window.addEventListener("keydown", shortcut, true);
    return () => window.removeEventListener("keydown", shortcut, true);
  }, [exportPng, open, save]);

  async function readProject(file: File) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      if (file.size > MAX_PROJECT_BYTES)
        throw new Error("This project is larger than 100 MB. Open a smaller project.");
      const project = parseCanvasProject(await file.text());
      if (!mounted.current) return;
      // A large file can finish reading after a new field or text draft has started.
      prepare();
      onOpen(project.nodes);
      setName(project.name);
      onNotice(`Opened ${project.name}. Undo restores the previous canvas.`);
    } catch (error) {
      if (mounted.current)
        onNotice(
          error instanceof Error
            ? error.message
            : "Could not open this project. Your current canvas has been kept.",
        );
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          className="canvas-tool"
          aria-label="Project menu"
          title="Project menu"
          disabled={busy}
        >
          <MoreHorizontalIcon size={16} strokeWidth={1.65} aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" sideOffset={10} className="canvas-menu">
          {fileActions && (
            <>
              <div className="px-2 py-2 text-xs text-muted-foreground">
                <div className="truncate text-foreground">{fileActions.name}</div>
                <div role="status">{fileActions.status}</div>
              </div>
              <DropdownMenuItem onClick={() => void runAction(fileActions.home)}>
                All files
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem onClick={open}>
            Open project…<DropdownMenuShortcut>⌘ O</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={save}>
            Save project<DropdownMenuShortcut>⌘ S</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!selectedIds.length} onClick={() => void exportPng()}>
            Export as PNG<DropdownMenuShortcut>⇧ ⌘ E</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <input
        ref={fileRef}
        hidden
        type="file"
        accept=".lra,.json,application/json"
        aria-label="Open canvas project"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) void readProject(file);
        }}
      />
    </>
  );
}
