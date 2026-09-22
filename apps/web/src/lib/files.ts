import {
  CanvasDocument,
  DEFAULT_PAGE_NAME,
  EMPTY_THEME,
  ensureCanvasPages,
  unpackCanvasProject,
  MAX_PROJECT_BYTES,
  type CanvasFrame,
  type CanvasTheme,
} from "@flies/canvas";
import { ulid } from "ulid";

import { api, post, ApiError } from "./api";

export type DesignFile = {
  format: "flies";
  version: 1;
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
  nodes: CanvasFrame[];
  theme?: CanvasTheme;
};
export type FilePreviewNode = {
  id: string;
  parentId?: string;
  kind?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fill?: string;
  color?: string;
  fontSize?: number;
  fontWeight?: number;
  fontFamily?: string;
  textAlign?: string;
  fontStyle?: string;
  cornerRadius?: number;
  opacity?: number;
  clipContent?: boolean;
  text?: string;
};
export type FileSummary = {
  id: string;
  name: string;
  updatedAt: number;
  createdAt: number;
  nodeCount: number;
  preview: FilePreviewNode[];
  archived: boolean;
};
export type FileLibrary = {
  files: FileSummary[];
  warnings: string[];
  workspace: { id: string; name: string };
};
export const listFiles = () => api<FileLibrary>("/api/files");
export const archiveFile = (id: string) =>
  post<void>(`/api/files/${id}/archive`, { archived: true });
export const restoreFile = (id: string) =>
  post<void>(`/api/files/${id}/archive`, { archived: false });
export const createFile = (
  name: string,
  nodes: CanvasFrame[] = [],
  theme: CanvasTheme = EMPTY_THEME,
) => post<DesignFile>("/api/files", { name, nodes, theme });

/** An editable local file whose page IDs also travel in the create request. */
export function draftFile(name: string): DesignFile {
  const now = Date.now();

  return withPages({
    format: "flies",
    version: 1,
    id: `draft-${ulid()}`,
    name: name.trim(),
    createdAt: now,
    updatedAt: now,
    revision: 0,
    nodes: [],
    theme: EMPTY_THEME,
  });
}

/** Derived from the file id so collaborators migrating the same file agree on the page. */
export const migratedPageId = (fileId: string) => `page-${fileId}`;

export function withPages(file: DesignFile): DesignFile {
  return {
    ...file,
    nodes: ensureCanvasPages(file.nodes, DEFAULT_PAGE_NAME, () => migratedPageId(file.id)),
  };
}

export async function openFile(id: string) {
  const file = withPages(await api<DesignFile>(`/api/files/${id}`));
  file.nodes = new CanvasDocument(file.nodes, file.theme).getCommittedFrames();

  return file;
}

export async function importFile() {
  const selected = await new Promise<File | null>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".zip,.json,.lra,.gz";
    input.addEventListener("change", () => resolve(input.files?.[0] ?? null), { once: true });
    input.addEventListener("cancel", () => resolve(null), { once: true });
    input.click();
  });

  if (!selected) return null;
  if (selected.size > MAX_PROJECT_BYTES) throw new Error("Files must be smaller than 100 MB.");
  const project = unpackCanvasProject(new Uint8Array(await selected.arrayBuffer()));

  return createFile(project.name, project.nodes, project.theme);
}

export const saveFile = (file: DesignFile, nodes: CanvasFrame[], mutationId: string) =>
  post<DesignFile>(`/api/files/${file.id}/revisions`, {
    revision: file.revision,
    mutationId,
    name: file.name,
    nodes,
    theme: file.theme ?? EMPTY_THEME,
  });

/** Serializes writes and keeps failed/newer snapshots available for retry. */
export class FileAutosave {
  needsSignIn = false;
  private pending: {
    name: string;
    nodes: CanvasFrame[];
    theme: CanvasTheme;
    mutationId: string;
  } | null = null;

  private retry: NonNullable<FileAutosave["pending"]> | null = null;
  private desiredName: string;
  private latestNodes: CanvasFrame[];
  private latestTheme: CanvasTheme;
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private file: DesignFile,
    private write = saveFile,
    private status: (message: string) => void = () => {},
    private onSaved: (file: DesignFile) => void = () => {},
  ) {
    this.desiredName = file.name;
    this.latestNodes = file.nodes;
    this.latestTheme = file.theme ?? EMPTY_THEME;
  }

  isDirty() {
    return this.pending !== null || this.retry !== null || this.running !== null;
  }

  enqueue(nodes: CanvasFrame[], theme: CanvasTheme = this.latestTheme) {
    this.latestNodes = nodes;
    this.latestTheme = theme;
    this.pending = { name: this.desiredName, nodes, theme, mutationId: ulid() };
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
    while (this.retry !== null || this.pending !== null) {
      const snapshot = this.retry ?? this.pending!;
      if (this.retry) this.retry = null;
      else this.pending = null;
      this.status("Saving…");

      try {
        // Each write must use the revision returned by the previous write.
        // eslint-disable-next-line no-await-in-loop
        this.file = await this.write(
          { ...this.file, name: snapshot.name, theme: snapshot.theme },
          snapshot.nodes,
          snapshot.mutationId,
        );
        this.needsSignIn = false;
        this.onSaved(this.file);
      } catch (error) {
        this.needsSignIn = error instanceof ApiError && error.status === 401;
        this.retry = snapshot;
        this.status(`Save failed: ${String(error)}`);
        throw error;
      }
    }

    this.status("Saved");
  }
}
