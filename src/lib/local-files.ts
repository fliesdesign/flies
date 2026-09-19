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
export type FileLibrary = {
  files: { id: string; name: string; updatedAt: number; nodeCount: number }[];
  warnings: string[];
  directory: string;
};
export const listFiles = () => invoke<FileLibrary>("list_files");
export const createFile = (name: string, nodes: CanvasFrame[] = []) =>
  invoke<LocalFile>("create_file", { name, nodes });
export async function openFile(id: string) {
  const file = await invoke<LocalFile>("open_file", { id });
  new CanvasDocument(file.nodes);
  return file;
}
export async function importFile() {
  const source = await invoke<string | null>("choose_project_json");
  if (source === null) return null;
  const project = parseCanvasProject(source);
  return createFile(project.name, project.nodes);
}
export const saveFile = (file: LocalFile, nodes: CanvasFrame[]) =>
  invoke<LocalFile>("save_file", { id: file.id, revision: file.revision, name: file.name, nodes });

/** Serializes writes and keeps failed/newer snapshots available for retry. */
export class FileAutosave {
  private pending: CanvasFrame[] | null = null;
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private file: LocalFile,
    private write = saveFile,
    private status: (message: string) => void = () => {},
  ) {}
  enqueue(nodes: CanvasFrame[]) {
    this.pending = nodes;
    this.status("Unsaved changes");
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.flush().catch(() => {});
    }, 500);
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
      const nodes = this.pending;
      this.pending = null;
      this.status("Saving…");
      try {
        this.file = await this.write(this.file, nodes);
      } catch (error) {
        this.pending ??= nodes;
        this.status(`Save failed: ${String(error)}`);
        throw error;
      }
    }
    this.status("Saved locally");
  }
}
