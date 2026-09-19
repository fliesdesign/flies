import type { CanvasCamera } from "./canvas-camera";
import type { CanvasDocument, CanvasFrame } from "./canvas-document";
import type { FrameRect } from "./canvas-geometry";
import { CanvasSpatialIndex, viewportBounds } from "./canvas-spatial-index";

/** Visibility is independent of React's document and pointer interaction state. */
export class CanvasScene {
  private readonly index: CanvasSpatialIndex;
  private visible: readonly string[] = [];
  private order = new Map<string, number>();
  private orderedIds: readonly string[] = [];
  private pinnedIds: readonly string[] = [];
  private pinnedFrames = new Map<string, CanvasFrame | undefined>();
  private pinnedSubscriptions: (() => void)[] = [];
  private connected = false;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly document: CanvasDocument,
    private readonly camera: CanvasCamera,
  ) {
    this.index = new CanvasSpatialIndex(document.getFrames());
    this.refresh();
  }

  connect = () => {
    this.connected = true;
    this.subscribePinned();
    const unsubscribeDocument = this.document.subscribeChanges((ids) => {
      for (const id of ids) {
        const frame = this.document.getFrame(id);
        if (frame) this.index.upsert(frame);
        else this.index.remove(id);
      }
      this.refresh();
    });
    const unsubscribeCamera = this.camera.subscribe(this.refresh);
    this.refresh();
    return () => {
      this.connected = false;
      this.pinnedSubscriptions.forEach((unsubscribe) => unsubscribe());
      this.pinnedSubscriptions = [];
      unsubscribeDocument();
      unsubscribeCamera();
    };
  };

  getSnapshot = () => this.visible;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  setPinned = (ids: string | readonly string[] | null) => {
    const next = typeof ids === "string" ? [ids] : (ids ?? []);
    if (next.length === this.pinnedIds.length && next.every((id, i) => id === this.pinnedIds[i]))
      return;
    this.pinnedIds = [...next];
    this.subscribePinned();
    this.refresh();
  };

  private subscribePinned() {
    this.pinnedSubscriptions.forEach((unsubscribe) => unsubscribe());
    this.pinnedSubscriptions = this.connected
      ? this.pinnedIds.map((id) =>
          this.document.subscribeFrame(id, () => {
            // previewMany installs every changed node before publishing. Refresh once
            // for that batch, even when hundreds of selected roots are being moved.
            if (this.document.getFrame(id) !== this.pinnedFrames.get(id)) this.refresh();
          }),
        )
      : [];
  }

  private refresh = () => {
    const ids = this.document.getIds();
    if (ids !== this.orderedIds) {
      this.orderedIds = ids;
      this.order = new Map(ids.map((id, index) => [id, index]));
    }
    const { viewport, size } = this.camera.getSnapshot();
    const bounds = viewportBounds(viewport, size);
    const hasViewport = size.x > 0 && size.y > 0;
    const subtree = this.document.getDescendantIds(this.pinnedIds);
    const pinnedSubtree = new Set(subtree);
    if (this.pinnedIds.length) {
      for (const id of this.document.getPreviewIds()) pinnedSubtree.add(id);
    }
    const candidates = hasViewport
      ? this.index.query(bounds).filter((id) => !pinnedSubtree.has(id))
      : [];
    // Committed spatial bounds stay stable during gestures. Query the live bounds
    // for selected subtrees and their derived layout changes, while retaining culling.
    for (const id of pinnedSubtree) {
      const frame = this.document.getFrame(id)!;
      if (hasViewport && intersects(frame, bounds)) candidates.push(id);
    }
    for (const id of this.pinnedIds) candidates.push(id);
    this.pinnedFrames = new Map(this.pinnedIds.map((id) => [id, this.document.getFrame(id)]));
    const mounted = new Set<string>();
    for (const id of candidates) {
      if (this.document.isHidden(id)) continue;
      let node = this.document.getFrame(id);
      while (node && !mounted.has(node.id)) {
        mounted.add(node.id);
        node = node.parentId ? this.document.getFrame(node.parentId) : undefined;
      }
    }
    const visible = [...mounted];
    visible.sort((a, b) => this.order.get(a)! - this.order.get(b)!);
    if (
      visible.length === this.visible.length &&
      visible.every((id, index) => id === this.visible[index])
    )
      return;
    this.visible = visible;
    this.listeners.forEach((listener) => listener());
  };
}

function intersects(first: FrameRect, second: FrameRect) {
  return (
    first.x <= second.x + second.width &&
    first.x + first.width >= second.x &&
    first.y <= second.y + second.height &&
    first.y + first.height >= second.y
  );
}
