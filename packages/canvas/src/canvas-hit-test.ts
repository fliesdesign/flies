import type { CanvasDocument, CanvasFrame } from "./canvas-document";
import type { Point } from "./canvas-geometry";
import { getClippingAncestors, roundedClipsContainPoint } from "./canvas-outline";
import { CanvasSpatialIndex } from "./canvas-spatial-index";

/** Pointer picking for canvas artwork, independent of mounted HTML or the renderer. */
export class CanvasHitTester {
  private index: CanvasSpatialIndex;
  private orderedIds: readonly string[] = [];
  private order = new Map<string, number>();

  constructor(private readonly document: CanvasDocument) {
    this.index = new CanvasSpatialIndex(document.getCommittedFrames());
    this.refreshOrder();
  }

  connect = () => {
    // Reconnecting after an effect cleanup also catches edits made while disconnected.
    this.index = new CanvasSpatialIndex(this.document.getCommittedFrames());
    this.refreshOrder();

    return this.document.subscribeChanges((ids) => {
      for (const id of ids) {
        const frame = this.document.getFrame(id);
        if (frame) this.index.upsert(frame);
        else this.index.remove(id);
      }

      this.refreshOrder();
    });
  };

  hit = (point: Point): string | undefined => {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    const previews = new Set(this.document.getPreviewIds());
    let result: string | undefined;
    let topOrder = -1;

    const consider = (id: string) => {
      const order = this.order.get(id) ?? -1;
      if (order <= topOrder) return;
      const frame = this.document.getFrame(id);
      if (!frame || !this.contains(frame, point)) return;
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
    if (
      point.x < frame.x ||
      point.y < frame.y ||
      point.x > frame.x + frame.width ||
      point.y > frame.y + frame.height
    )
      return false;
    let node: CanvasFrame | undefined = frame;

    while (node) {
      if (node.hidden || node.locked) return false;
      node = node.parentId ? this.document.getFrame(node.parentId) : undefined;
    }

    // Text, groups and pen strokes have rectangular interaction bounds, matching
    // their HTML buttons; rounded frames, images and shapes use their painted body.
    if (
      frame.kind !== "text" &&
      frame.kind !== "group" &&
      frame.kind !== "pen" &&
      !roundedClipsContainPoint([frame], point)
    )
      return false;

    return roundedClipsContainPoint(getClippingAncestors(this.document, frame), point);
  }
}
