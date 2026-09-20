import type { CanvasCamera } from "./canvas-camera";
import type { CanvasDocument, CanvasFrame } from "./canvas-document";
import type { FrameRect } from "./canvas-geometry";
import { CanvasSpatialIndex, viewportBounds } from "./canvas-spatial-index";

const EMPTY_IDS: readonly string[] = Object.freeze([]);

/** Visibility is independent of React's document and pointer interaction state. */
export class CanvasScene {
  private readonly index: CanvasSpatialIndex;
  private visible: readonly string[] = [];
  private visibleChildren = new Map<string | undefined, readonly string[]>();
  private order = new Map<string, number>();
  private orderedIds: readonly string[] = [];
  private pinnedIds: readonly string[] = [];
  private pinnedSubtree: ReadonlySet<string> | undefined;
  private pinnedFrames = new Map<string, CanvasFrame | undefined>();
  private pinnedSubscriptions: (() => void)[] = [];
  private connected = false;
  private readonly listeners = new Set<() => void>();
  private queriedBounds: FrameRect | undefined;
  private queriedZoom = 1;

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
      // Parent changes can preserve document order, so an ids-array comparison is
      // insufficient to invalidate selected descendants after a commit.
      this.pinnedSubtree = undefined;
      for (const id of ids) {
        const frame = this.document.getFrame(id);
        if (frame) this.index.upsert(frame);
        else this.index.remove(id);
      }
      this.refresh();
    });
    const unsubscribeCamera = this.camera.subscribe(this.refreshCamera);
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
  /** Each parent's snapshot changes only when its own mounted children change. */
  getVisibleChildren = (parentId?: string): readonly string[] =>
    this.visibleChildren.get(parentId) ?? EMPTY_IDS;
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
    this.pinnedSubtree = undefined;
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

  private refreshCamera = () => {
    const { viewport, size } = this.camera.getSnapshot();
    // The existing mounting buffer keeps every on-screen node available. Reuse
    // it until the screen crosses its boundary instead of querying, walking and
    // sorting the same populated artboards at every animation frame.
    if (
      size.x > 0 &&
      size.y > 0 &&
      this.queriedBounds &&
      // Zooming far inward must also release nodes from the old, wider view.
      viewport.zoom < this.queriedZoom * 1.25 &&
      contains(this.queriedBounds, viewportBounds(viewport, size, 0))
    )
      return;
    this.refresh();
  };

  private refresh = () => {
    const ids = this.document.getIds();
    if (ids !== this.orderedIds) {
      this.orderedIds = ids;
      this.order = new Map(ids.map((id, index) => [id, index]));
    }
    const { viewport, size } = this.camera.getSnapshot();
    const bounds = viewportBounds(viewport, size);
    const hasViewport = size.x > 0 && size.y > 0;
    this.queriedBounds = hasViewport ? bounds : undefined;
    this.queriedZoom = viewport.zoom;
    this.pinnedSubtree ??= new Set(this.document.getDescendantIds(this.pinnedIds));
    const pinnedSubtree = new Set(this.pinnedSubtree);
    if (this.pinnedIds.length) {
      for (const id of this.document.getPreviewIds()) pinnedSubtree.add(id);
    }
    const candidates = hasViewport
      ? this.index.query(bounds).filter((id) => !pinnedSubtree.has(id))
      : [];
    // Committed spatial bounds stay stable during gestures. Query the live bounds
    // for selected subtrees and their derived layout changes, while retaining culling.
    for (const id of pinnedSubtree) {
      const frame = this.document.getFrame(id);
      if (frame && hasViewport && intersects(frame, bounds)) candidates.push(id);
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
    const membershipChanged = !sameIds(visible, this.visible);
    const childrenChanged = this.refreshVisibleChildren(visible);
    if (!membershipChanged && !childrenChanged) return;
    if (membershipChanged) this.visible = visible;
    this.listeners.forEach((listener) => listener());
  };

  private refreshVisibleChildren(visible: readonly string[]) {
    const children = new Map<string | undefined, string[]>();
    for (const id of visible) {
      const parentId = this.document.getFrame(id)?.parentId;
      const siblings = children.get(parentId);
      if (siblings) siblings.push(id);
      else children.set(parentId, [id]);
    }
    let changed = children.size !== this.visibleChildren.size;
    const next = new Map<string | undefined, readonly string[]>();
    for (const [parentId, ids] of children) {
      const previous = this.visibleChildren.get(parentId);
      if (previous && sameIds(previous, ids)) next.set(parentId, previous);
      else {
        changed = true;
        next.set(parentId, Object.freeze(ids));
      }
    }
    this.visibleChildren = next;
    return changed;
  }
}

function sameIds(first: readonly string[], second: readonly string[]) {
  return first.length === second.length && first.every((id, index) => id === second[index]);
}

function contains(outer: FrameRect, inner: FrameRect) {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

function intersects(first: FrameRect, second: FrameRect) {
  return (
    first.x <= second.x + second.width &&
    first.x + first.width >= second.x &&
    first.y <= second.y + second.height &&
    first.y + first.height >= second.y
  );
}
