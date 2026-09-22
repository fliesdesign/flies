import type { CanvasDocument, CanvasFrame } from "./canvas-document";
import type { Point } from "./canvas-geometry";
import { getClippingAncestors } from "./canvas-outline";
import { CanvasSpatialIndex } from "./canvas-spatial-index";
import { worldBounds, worldPointInFrame } from "./canvas-transform";

/** Pointer picking for canvas artwork, independent of mounted HTML or the renderer. */
export class CanvasHitTester {
  private index: CanvasSpatialIndex;
  private orderedIds: readonly string[] = [];
  private order = new Map<string, number>();

  constructor(private readonly document: CanvasDocument) {
    this.index = this.buildIndex();
    this.refreshOrder();
  }

  /** Picking only ever reaches the active page; other canvases are not indexed. */
  private buildIndex() {
    const committed = new Map(
      this.document.getCommittedFrames().map((frame) => [frame.id, frame] as const),
    );

    return new CanvasSpatialIndex(
      this.document
        .getSceneIds()
        .map((id) => committed.get(id))
        .filter((frame) => frame !== undefined)
        .map((frame) => Object.assign(worldBounds(this.document, frame), { id: frame.id })),
    );
  }

  connect = () => {
    // Reconnecting after an effect cleanup also catches edits made while disconnected.
    this.index = this.buildIndex();
    this.refreshOrder();

    const unsubscribePage = this.document.subscribeActivePage(() => {
      this.index = this.buildIndex();
      this.refreshOrder();
    });

    const unsubscribeChanges = this.document.subscribeChanges((ids) => {
      const scene = new Set(this.document.getSceneIds());

      for (const id of new Set([...ids, ...this.document.getDescendantIds(ids)])) {
        const frame = scene.has(id) ? this.document.getFrame(id) : undefined;
        if (frame)
          this.index.upsert(Object.assign(worldBounds(this.document, frame), { id: frame.id }));
        else this.index.remove(id);
      }

      this.refreshOrder();
    });

    return () => {
      unsubscribePage();
      unsubscribeChanges();
    };
  };

  hit = (point: Point): string | undefined => {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    const previews = new Set(this.document.getDescendantIds([...this.document.getPreviewIds()]));
    let result: string | undefined;
    let topOrder = -1;

    const consider = (id: string) => {
      const order = this.order.get(id) ?? -1;
      if (order <= topOrder) return;
      const frame = this.document.getFrame(id);
      if (!frame || this.document.isMaskSource(id) || !this.contains(frame, point)) return;
      result = id;
      topOrder = order;
    };

    for (const id of this.index.query({ ...point, width: 0, height: 0 })) {
      if (!previews.has(id)) consider(id);
    }

    // Gestures do not publish document changes. Test only their live nodes, keeping
    // stale committed bounds out of the result without reindexing the whole scene.
    for (const id of previews) consider(id);

    return result;
  };

  private refreshOrder() {
    const ids = this.document.getIds();
    if (ids === this.orderedIds) return;
    this.orderedIds = ids;
    this.order = new Map(ids.map((id, index) => [id, index]));
  }

  private contains(frame: CanvasFrame, point: Point) {
    let node: CanvasFrame | undefined = frame;

    while (node) {
      if (node.hidden || node.locked) return false;
      node = node.parentId ? this.document.getFrame(node.parentId) : undefined;
    }

    if (
      !worldPointInFrame(
        this.document,
        frame,
        point,
        frame.kind !== "text" && frame.kind !== "group" && frame.kind !== "pen",
      )
    )
      return false;

    return getClippingAncestors(this.document, frame).every((ancestor) =>
      worldPointInFrame(this.document, ancestor, point),
    );
  }
}
