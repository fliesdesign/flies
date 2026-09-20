import type { CanvasDocument, CanvasFrame } from "./canvas-document";

export type AgentActivity = {
  sequence: number;
  phase: "working" | "saving" | "done" | "error";
  label: string;
  nodeIds: readonly string[];
  removed: readonly CanvasFrame[];
  changedIds: readonly string[];
  changedAt: number;
};

const LABELS: Record<string, string> = {
  write_html: "Designing",
  create_artboard: "Creating frame",
  update_node: "Editing",
  set_styles: "Setting styles",
  set_theme: "Updating theme",
  apply_tokens: "Applying tokens",
  fit_node: "Fitting content",
  preview_html: "Opening preview",
  close_preview: "Closing preview",
  delete_nodes: "Removing layers",
  undo: "Undoing",
  redo: "Redoing",
  get_screenshot: "Taking screenshot",
  save_file: "Saving",
  set_selection: "Selecting",
};

/** One ephemeral presence per document. Nothing is serialized into project files. */
export class AgentActivityStore {
  private snapshot: AgentActivity | null = null;
  private listeners = new Set<() => void>();
  private sequence = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  };

  private publish(next: AgentActivity | null) {
    this.snapshot = next;
    this.listeners.forEach((listener) => listener());
  }

  begin(tool: string, args: Record<string, unknown>) {
    clearTimeout(this.timer);

    const nodeIds = Array.isArray(args.nodeIds)
      ? args.nodeIds.filter((id): id is string => typeof id === "string")
      : [args.nodeId ?? args.targetId ?? args.parentId].filter(
          (id): id is string => typeof id === "string",
        );

    const sequence = ++this.sequence;
    this.publish({
      sequence,
      phase: "working",
      label:
        tool === "write_html" && args.validateOnly === true
          ? "Checking HTML"
          : (LABELS[tool] ?? "Inspecting"),
      nodeIds,
      removed: [],
      changedIds: [],
      changedAt: 0,
    });

    return sequence;
  }

  /** Capture only the synchronous MCP transaction, never concurrent human edits while awaiting HTML or saving. */
  capture<T>(document: CanvasDocument, action: () => T): T {
    if (!this.snapshot || this.snapshot.phase !== "working") return action();
    const before = new Map(document.getFrames().map((node) => [node.id, node]));

    const unlisten = document.subscribeChanges((ids) => {
      if (!this.snapshot) return;

      const removed = ids
        .filter((id) => !document.getFrame(id))
        .flatMap((id) => (before.get(id) ? [before.get(id)!] : []));

      this.publish({
        ...this.snapshot,
        nodeIds: ids,
        removed,
        changedIds: ids.filter((id) => !!document.getFrame(id)),
        changedAt: Date.now(),
      });
    });

    try {
      return action();
    } finally {
      unlisten();
    }
  }

  saving(sequence: number) {
    if (this.snapshot?.sequence === sequence)
      this.publish({ ...this.snapshot, phase: "saving", label: "Saving" });
  }

  finish(sequence: number, failed = false) {
    if (this.snapshot?.sequence !== sequence) return;
    this.publish({
      ...this.snapshot,
      phase: failed ? "error" : "done",
      label: failed ? "Needs attention" : this.snapshot.phase === "saving" ? "Synced" : "Done",
    });
    this.timer = setTimeout(
      () => {
        if (this.snapshot?.sequence === sequence) this.publish(null);
      },
      failed ? 5000 : 1800,
    );
    this.timer.unref?.();
  }
}
const stores = new WeakMap<CanvasDocument, AgentActivityStore>();

export function agentActivity(document: CanvasDocument) {
  let store = stores.get(document);

  if (!store) {
    store = new AgentActivityStore();
    stores.set(document, store);
  }

  return store;
}

export async function withAgentActivity<T>(
  document: CanvasDocument,
  tool: string,
  args: Record<string, unknown>,
  action: (saving: () => void) => Promise<T>,
): Promise<T> {
  const store = agentActivity(document);
  const sequence = store.begin(tool, args);

  try {
    const result = await action(() => store.saving(sequence));
    store.finish(sequence);

    return result;
  } catch (error) {
    store.finish(sequence, true);
    throw error;
  }
}
