import type { CanvasDocument, CanvasFrame } from "./canvas-document";
import type { CanvasLayout } from "./canvas-layout";

type Listener = () => void;
// Subtracting two translated world positions can introduce tiny rounding noise.
const LOCAL_COORDINATE_EPSILON = 1e-9;

function layoutsEqual(first: CanvasLayout | undefined, second: CanvasLayout | undefined) {
  return (
    first === second ||
    (first !== undefined &&
      second !== undefined &&
      first.direction === second.direction &&
      first.gap === second.gap &&
      first.padding === second.padding &&
      first.align === second.align &&
      first.justify === second.justify)
  );
}

function visualFieldsEqual(first: CanvasFrame, second: CanvasFrame) {
  const before = first as unknown as Record<string, unknown>;
  const after = second as unknown as Record<string, unknown>;

  // Documents freeze and reuse point/shadow arrays. Layout objects are copied,
  // so compare their scalars while keeping every other field reference-based.
  for (const key in before) {
    if (key === "x" || key === "y") continue;
    if (key === "layout") {
      if (!layoutsEqual(before[key] as CanvasLayout, after[key] as CanvasLayout)) return false;
    } else if (before[key] !== after[key]) return false;
  }

  for (const key in after) {
    if (!(key in before)) return false;
  }

  return true;
}

/** Render coordinates are local; persisted document coordinates remain world-space. */
export class CanvasRenderNodeStore {
  private frame: CanvasFrame | undefined;
  private parent: CanvasFrame | undefined;
  private snapshot: CanvasFrame | undefined;
  private published: CanvasFrame | undefined;
  private parentId: string | undefined;
  private unsubscribeNode: (() => void) | undefined;
  private unsubscribeParent: (() => void) | undefined;
  private readonly listeners = new Set<Listener>();

  constructor(
    private readonly document: CanvasDocument,
    private readonly id: string,
  ) {}

  getSnapshot = (): CanvasFrame | undefined => {
    const frame = this.document.getFrame(this.id);

    const parent =
      frame?.parentId === undefined ? undefined : this.document.getFrame(frame.parentId);

    if (frame === this.frame && parent === this.parent) return this.snapshot;
    this.frame = frame;
    this.parent = parent;

    if (!frame) {
      this.snapshot = undefined;

      return this.snapshot;
    }

    const x = frame.x - (parent?.x ?? 0);
    const y = frame.y - (parent?.y ?? 0);
    if (
      !this.snapshot ||
      Math.abs(this.snapshot.x - x) > LOCAL_COORDINATE_EPSILON ||
      Math.abs(this.snapshot.y - y) > LOCAL_COORDINATE_EPSILON ||
      !visualFieldsEqual(this.snapshot, frame)
    )
      this.snapshot = Object.freeze({ ...frame, x, y });

    return this.snapshot;
  };

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);

    if (this.listeners.size === 1) {
      this.published = this.getSnapshot();
      this.unsubscribeNode = this.document.subscribeFrame(this.id, this.refresh);
      this.followParent();
    }

    return () => {
      this.listeners.delete(listener);

      if (this.listeners.size === 0) {
        this.unsubscribeNode?.();
        this.unsubscribeParent?.();
        this.unsubscribeNode = undefined;
        this.unsubscribeParent = undefined;
        this.parentId = undefined;
      }
    };
  };

  private followParent() {
    const parentId = this.document.getFrame(this.id)?.parentId;
    if (parentId === this.parentId) return;
    this.unsubscribeParent?.();
    this.parentId = parentId;
    this.unsubscribeParent =
      parentId === undefined ? undefined : this.document.subscribeFrame(parentId, this.refresh);
  }

  private refresh = () => {
    this.followParent();
    const snapshot = this.getSnapshot();
    if (snapshot === this.published) return;
    this.published = snapshot;
    this.listeners.forEach((listener) => listener());
  };
}
