import { EMPTY_THEME } from "@flies/canvas";
import {
  applyDocumentDelta,
  diffDocument,
  hasDocumentDelta,
  type DocumentDelta,
  type SyncSnapshot,
} from "@flies/canvas/sync";
import { ulid } from "ulid";

import type { CanvasControls } from "@/components/canvas/design-canvas";

import { apiUrl, ApiError, post } from "./api";
import { openFile, saveFile, type DesignFile } from "./files";

export type Peer = {
  connectionId: string;
  userId: string;
  name: string;
  color: string;
  cursor: { x: number; y: number } | null;
  selection: string[];
  activity: "viewing" | "editing";
  updatedAt: number;
};
export type Presence = Pick<Peer, "cursor" | "selection" | "activity">;
export type RealtimeState = {
  state: "connecting" | "live" | "offline" | "disabled";
  peers: Peer[];
  userId?: string;
};

const snapshot = (file: DesignFile): SyncSnapshot => ({
  name: file.name,
  nodes: file.nodes,
  theme: file.theme ?? EMPTY_THEME,
});

/** Local intents survive reconnects; server acknowledgements identify durable revisions. */
export class RealtimeFile {
  needsSignIn = false;
  private base: DesignFile;
  private observed: SyncSnapshot;
  private controls: CanvasControls | null = null;
  private applying = false;
  private queue: DocumentDelta[] = [];
  private inFlight: { mutationId: string; delta: DocumentDelta; count: number } | null = null;
  private running: Promise<void> | null = null;
  private reading: Promise<void> | null = null;
  private requestedRevision = -1;
  private socket: WebSocket | null = null;
  private mode: "unknown" | "enabled" | "disabled" = "unknown";
  private stopped = false;
  private generation = 0;
  private retryDelay = 500;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private presenceTimer?: ReturnType<typeof setInterval>;
  private unsubscribe?: () => void;
  private id = "";
  private userId = "";
  private peers = new Map<string, Peer>();
  private ownPresence: Presence = { cursor: null, selection: [], activity: "viewing" };
  private sentPresence = "";
  private heartbeat = 0;
  private ack = new Map<
    string,
    { resolve: () => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout> }
  >();

  private state: RealtimeState = { state: "connecting", peers: [] };
  private listeners = new Set<() => void>();
  constructor(
    file: DesignFile,
    private status: (message: string) => void,
    private onSaved: (file: DesignFile) => void,
  ) {
    this.base = file;
    this.observed = snapshot(file);
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.state;
  private publish(state = this.state.state) {
    const now = Date.now();
    for (const [id, peer] of this.peers) if (now - peer.updatedAt > 25_000) this.peers.delete(id);
    this.state = {
      state,
      userId: this.userId,
      peers: [...this.peers.values()].filter((peer) => peer.connectionId !== this.id),
    };
    this.listeners.forEach((listener) => listener());
  }

  bind(controls: CanvasControls) {
    this.generation++;
    this.controls = controls;
    this.stopped = false;
    this.unsubscribe = controls.document.subscribe(() => {
      if (this.applying) return;

      const next = {
        name: this.observed.name,
        nodes: controls.document.getCommittedFrames(),
        theme: controls.document.getTheme(),
      };

      this.enqueue(next);
    });
    this.presenceTimer = setInterval(() => {
      this.sendPresence();
      this.publish();
      if (this.requestedRevision > this.base.revision) void this.pull().catch(() => {});
    }, 100);
    void this.connect();

    return () => this.dispose();
  }

  private enqueue(next: SyncSnapshot) {
    const delta = diffDocument(this.observed, next);
    this.observed = next;
    if (!hasDocumentDelta(delta)) return;
    this.queue.push(delta);
    this.status("Unsaved changes");
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flush().catch(() => {}), 180);
  }

  isDirty = () => this.queue.length > 0 || this.running !== null;
  rename = async (name: string) => {
    this.enqueue({ ...this.observed, name });
    await this.flush();
  };

  presence = (presence: Presence) => {
    this.ownPresence = presence;
  };

  private sendPresence() {
    if (this.socket?.readyState !== WebSocket.OPEN || this.state.state !== "live") return;
    const value = JSON.stringify(this.ownPresence);
    if (value === this.sentPresence && Date.now() - this.heartbeat < 8000) return;
    this.sentPresence = value;
    this.heartbeat = Date.now();
    this.socket.send(JSON.stringify({ type: "presence", presence: this.ownPresence }));
  }

  private async connect() {
    const generation = this.generation;

    try {
      const result = await post<{ enabled: boolean; ticket?: string }>("/api/sync/ticket", {
        fileId: this.base.id,
      });

      if (this.stopped || generation !== this.generation) return;

      if (!result.enabled) {
        this.mode = "disabled";
        this.publish("disabled");
        if (this.queue.length) void this.flush().catch(() => {});

        return;
      }

      this.mode = "enabled";
      const url = new URL(apiUrl("/api/sync/socket"), window.location.href);
      if (url.protocol === "https:") url.protocol = "wss:";
      else if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) url.protocol = "ws:";
      else throw new Error("Realtime requires an encrypted connection.");
      const socket = new WebSocket(url, ["flies-sync-v1", `ticket.${result.ticket}`]);
      this.socket = socket;

      socket.addEventListener("message", (event) => {
        if (this.stopped || generation !== this.generation || socket !== this.socket) return;

        try {
          this.receive(JSON.parse(String(event.data)));
        } catch {
          socket.close(1002, "Invalid sync message");
        }
      });

      socket.addEventListener("close", () => {
        if (socket !== this.socket) return;
        this.socket = null;

        for (const pending of this.ack.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error("Connection interrupted. Your changes are retained."));
        }

        this.ack.clear();
        this.peers.clear();
        this.publish("offline");
        this.retry();
      });

      socket.addEventListener("error", () => socket.close());
    } catch (error) {
      if (this.stopped || generation !== this.generation) return;
      this.needsSignIn = error instanceof ApiError && error.status === 401;
      this.publish("offline");
      this.retry();
    }
  }

  private retry() {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.connect(), this.retryDelay + Math.random() * 300);
    this.retryDelay = Math.min(this.retryDelay * 2, 15_000);
  }

  private receive(message: {
    type: string;
    revision?: number;
    connectionId?: string;
    userId?: string;
    peers?: Peer[];
    peer?: Peer;
    mutationId?: string;
    code?: number;
    error?: string;
  }) {
    if (message.type === "ready") {
      this.id = message.connectionId!;
      this.userId = message.userId ?? "";
      this.peers = new Map((message.peers ?? []).map((peer) => [peer.connectionId, peer]));
      this.retryDelay = 500;
      this.sentPresence = "";
      this.publish("live");
      this.requestedRevision = Math.max(this.requestedRevision, message.revision ?? 0);
      void this.pull()
        .then(() => this.flush())
        .catch(() => {});
    } else if (message.type === "presence" && message.peer) {
      this.peers.set(message.peer.connectionId, message.peer);
      this.publish();
    } else if (message.type === "leave") {
      this.peers.delete(message.connectionId!);
      this.publish();
    } else if (message.type === "changed") {
      this.requestedRevision = Math.max(this.requestedRevision, message.revision ?? 0);
      void this.pull().catch(() => {});
    } else if (message.mutationId && (message.type === "ack" || message.type === "error")) {
      const waiting = this.ack.get(message.mutationId);
      if (!waiting) return;
      this.ack.delete(message.mutationId);
      clearTimeout(waiting.timer);

      if (message.type === "error")
        waiting.reject(new ApiError(message.code ?? 503, message.error ?? "Sync failed."));
      else {
        this.requestedRevision = Math.max(this.requestedRevision, message.revision ?? 0);
        waiting.resolve();
      }
    }
  }

  private apply(file: DesignFile) {
    if (!this.controls || file.revision < this.base.revision) return;
    if ([...this.controls.document.getPreviewIds()].length) return;
    this.base = file;
    const merged = this.queue.reduce(applyDocumentDelta, snapshot(file));
    this.applying = true;

    try {
      this.controls.document.replaceAll(merged.nodes, merged.theme, true);
      this.observed = merged;
    } finally {
      this.applying = false;
    }

    this.onSaved({ ...file, name: merged.name });
  }

  private pull(force = false): Promise<void> {
    if (this.reading)
      return this.reading.then(() =>
        this.requestedRevision > this.base.revision ? this.pull() : undefined,
      );
    if (!force && this.requestedRevision <= this.base.revision) return Promise.resolve();
    if (this.controls && [...this.controls.document.getPreviewIds()].length)
      return Promise.resolve();
    this.reading = openFile(this.base.id)
      .then((file) => {
        if (!this.stopped && file.revision >= this.requestedRevision) this.apply(file);

        return;
      })
      .finally(() => {
        this.reading = null;
      });

    return this.reading.then(() =>
      !this.stopped && this.requestedRevision > this.base.revision ? this.pull() : undefined,
    );
  }

  flush = (): Promise<void> => {
    clearTimeout(this.saveTimer);
    if (this.running) return this.running;
    this.running = this.drain().finally(() => {
      this.running = null;
    });

    return this.running;
  };

  private async drain() {
    if (!this.queue.length) return;

    if (this.mode === "unknown") {
      this.status("Save failed: Connecting. Your changes are retained.");
      throw new Error("Connecting to workspace.");
    }

    while (this.queue.length) {
      if (!this.inFlight) {
        const next = this.queue.reduce(applyDocumentDelta, snapshot(this.base));
        this.inFlight = {
          mutationId: ulid(),
          delta: diffDocument(snapshot(this.base), next),
          count: this.queue.length,
        };
      }

      const change = this.inFlight;
      this.status("Saving…");

      try {
        if (this.mode === "disabled") {
          const next = applyDocumentDelta(snapshot(this.base), change.delta);

          // eslint-disable-next-line no-await-in-loop
          const saved = await saveFile(
            { ...this.base, name: next.name, theme: next.theme },
            next.nodes,
            change.mutationId,
          );

          this.queue.splice(0, change.count);
          this.inFlight = null;
          this.apply(saved);
        } else {
          // eslint-disable-next-line no-await-in-loop
          await this.sendChange(change);
          this.queue.splice(0, change.count);
          this.inFlight = null;
          // eslint-disable-next-line no-await-in-loop
          await this.pull(true);
        }

        this.needsSignIn = false;
      } catch (error) {
        this.needsSignIn = error instanceof ApiError && error.status === 401;
        this.status(
          `Save failed: ${error instanceof Error ? error.message : "Your changes are retained. Retry."}`,
        );

        if (
          !this.stopped &&
          (!(error instanceof ApiError) || error.status >= 500 || error.status === 429)
        ) {
          clearTimeout(this.saveTimer);
          this.saveTimer = setTimeout(
            () => void this.flush().catch(() => {}),
            error instanceof ApiError && error.status === 429 ? 5000 : 1500,
          );
        }

        throw error;
      }
    }

    this.status("Saved");
  }

  private async sendChange(change: { mutationId: string; delta: DocumentDelta }) {
    const payload = JSON.stringify({
      type: "commit",
      change: { mutationId: change.mutationId, delta: change.delta },
    });

    if (
      this.socket?.readyState !== WebSocket.OPEN ||
      this.state.state !== "live" ||
      new TextEncoder().encode(payload).length > 500_000
    ) {
      const result = await post<{ revision: number }>(`/api/files/${this.base.id}/changes`, {
        mutationId: change.mutationId,
        delta: change.delta,
      });

      this.requestedRevision = Math.max(this.requestedRevision, result.revision);

      return;
    }

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ack.delete(change.mutationId);
        reject(new Error("Sync timed out. Retry to confirm this save."));
      }, 15_000);

      this.ack.set(change.mutationId, { resolve, reject, timer });
      this.socket!.send(payload);
    });
  }

  private dispose() {
    this.stopped = true;
    this.generation++;
    this.unsubscribe?.();
    clearTimeout(this.retryTimer);
    clearTimeout(this.saveTimer);
    clearInterval(this.presenceTimer);
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, "File closed");

    for (const pending of this.ack.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("File closed."));
    }

    this.ack.clear();
  }
}
