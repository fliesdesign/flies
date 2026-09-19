import { invoke } from "@tauri-apps/api/core";

import { CanvasDocument, type CanvasFrame } from "./canvas-document";
import { parseCanvasProject } from "./canvas-project";

export type LocalFile = {
  format: "flies";
  version: 1;
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
  nodes: CanvasFrame[];
};
export type LibraryFolder = {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
};
export type FileSummary = {
  id: string;
  name: string;
  updatedAt: number;
  createdAt: number;
  nodeCount: number;
  folderId: string | null;
  preview: CanvasFrame[];
};
export type FileLibrary = {
  files: FileSummary[];
  folders: LibraryFolder[];
  warnings: string[];
  directory: string;
};
export const listFiles = () => invoke<FileLibrary>("list_files");
export const createFile = (
  name: string,
  nodes: CanvasFrame[] = [],
  folderId: string | null = null,
) => invoke<LocalFile>("create_file", { name, nodes, folderId });
export const createFolder = (name: string, parentId: string | null) =>
  invoke<LibraryFolder>("create_folder", { name, parentId });
export const renameFolder = (id: string, name: string) =>
  invoke<void>("rename_folder", { id, name });
export const moveLibraryItem = (id: string, folderId: string | null, isFolder: boolean) =>
  invoke<void>("move_library_item", { id, folderId, isFolder });
export async function openFile(id: string) {
  const file = await invoke<LocalFile>("open_file", { id });
  file.nodes = new CanvasDocument(file.nodes).getCommittedFrames();
  return file;
}
export async function importFile(folderId: string | null = null) {
  const source = await invoke<string | null>("choose_project_json");
  if (source === null) return null;
  const project = parseCanvasProject(source);
  return createFile(project.name, project.nodes, folderId);
}
export const saveFile = (file: LocalFile, nodes: CanvasFrame[]) =>
  invoke<LocalFile>("save_file", { id: file.id, revision: file.revision, name: file.name, nodes });

/** Serializes writes and keeps failed/newer snapshots available for retry. */
export class FileAutosave {
  private pending: { name: string; nodes: CanvasFrame[] } | null = null;
  private desiredName: string;
  private latestNodes: CanvasFrame[];
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private file: LocalFile,
    private write = saveFile,
    private status: (message: string) => void = () => {},
    private onSaved: (file: LocalFile) => void = () => {},
  ) {
    this.desiredName = file.name;
    this.latestNodes = file.nodes;
  }
  enqueue(nodes: CanvasFrame[]) {
    this.latestNodes = nodes;
    this.pending = { name: this.desiredName, nodes };
    this.status("Unsaved changes");
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.flush().catch(() => {});
    }, 500);
  }
  rename(name: string): Promise<void> {
    this.desiredName = name;
    this.enqueue(this.latestNodes);
    return this.flush();
  }
  flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.running) return this.running;
    this.running = this.drain().finally(() => {
      this.running = null;
    });
    return this.running;
  }
  private async drain() {
    while (this.pending !== null) {
      const snapshot = this.pending;
      this.pending = null;
      this.status("Saving…");
      try {
        // Each write must use the revision returned by the previous write.
        // eslint-disable-next-line no-await-in-loop
        this.file = await this.write({ ...this.file, name: snapshot.name }, snapshot.nodes);
        this.onSaved(this.file);
      } catch (error) {
        this.pending ??= snapshot;
        this.status(`Save failed: ${String(error)}`);
        throw error;
      }
    }
    this.status("Saved locally");
  }
}
