import { AnimationFrameBatch } from "./canvas-camera";
import type { CanvasDocument } from "./canvas-document";
import type { FrameRect, ResizeHandle } from "./canvas-geometry";
import { getClippingAncestors, getVisibleBoundsInRoundedClips } from "./canvas-outline";
import { CanvasSpatialIndex } from "./canvas-spatial-index";

type Anchor = { position: number; start: number; end: number };
export type AlignmentGuide = Anchor & { axis: "x" | "y" };
type Match = { anchor: Anchor; delta: number };

const SNAP_DISTANCE = 6;
const NO_GUIDES: readonly AlignmentGuide[] = [];

/** Freeze visible geometry once, then query nearby targets as an edge drag pans the camera. */
export class AlignmentGuideTargets {
  private readonly frames = new Map<string, FrameRect & { id: string }>();
  private readonly spatial = new CanvasSpatialIndex();

  constructor(document: CanvasDocument, excludedIds: ReadonlySet<string>) {
    for (const frame of document.getFrames()) {
      if (excludedIds.has(frame.id) || document.isHidden(frame.id)) continue;
      const bounds = getVisibleBoundsInRoundedClips(frame, getClippingAncestors(document, frame));
      if (!bounds) continue;
      const target = { id: frame.id, ...bounds };
      this.frames.set(frame.id, target);
      this.spatial.upsert(target);
    }
  }

  inViewport(bounds: FrameRect) {
    return new AlignmentGuideIndex(
      this.spatial.query(bounds).map((id) => this.frames.get(id)!),
      "",
    );
  }
}

function addAnchor(anchors: Map<number, Anchor>, position: number, start: number, end: number) {
  const existing = anchors.get(position);
  if (existing) {
    existing.start = Math.min(existing.start, start);
    existing.end = Math.max(existing.end, end);
  } else anchors.set(position, { position, start, end });
}

function lowerBound(anchors: readonly Anchor[], position: number) {
  let low = 0;
  let high = anchors.length;

  while (low < high) {
    const middle = (low + high) >>> 1;
    if (anchors[middle].position < position) low = middle + 1;
    else high = middle;
  }

  return low;
}

function closest(
  anchors: readonly Anchor[],
  positions: readonly number[],
  tolerance: number,
  minimum = -Infinity,
  maximum = Infinity,
): Match | undefined {
  let match: Match | undefined;

  for (const position of positions) {
    const index = lowerBound(anchors, Math.max(minimum, Math.min(maximum, position)));

    for (const candidate of [index - 1, index]) {
      const anchor = anchors[candidate];
      if (!anchor || anchor.position < minimum || anchor.position > maximum) continue;
      const delta = anchor.position - position;
      if (Math.abs(delta) <= tolerance && (!match || Math.abs(delta) < Math.abs(match.delta)))
        match = { anchor, delta };
    }
  }

  return match;
}

/** Snapshot visible targets once per gesture; pointer samples use binary searches. */
export class AlignmentGuideIndex {
  private readonly x: Anchor[];
  private readonly y: Anchor[];

  constructor(
    frames: readonly (FrameRect & { id: string })[],
    excludedId: string | ReadonlySet<string>,
    bounds?: FrameRect,
  ) {
    const x = new Map<number, Anchor>();
    const y = new Map<number, Anchor>();

    for (const frame of frames) {
      if (typeof excludedId === "string" ? frame.id === excludedId : excludedId.has(frame.id))
        continue;
      const right = frame.x + frame.width;
      const bottom = frame.y + frame.height;
      if (
        bounds &&
        (right < bounds.x ||
          bottom < bounds.y ||
          frame.x > bounds.x + bounds.width ||
          frame.y > bounds.y + bounds.height)
      )
        continue;
      for (const position of [frame.x, frame.x + frame.width / 2, right])
        addAnchor(x, position, frame.y, bottom);
      for (const position of [frame.y, frame.y + frame.height / 2, bottom])
        addAnchor(y, position, frame.x, right);
    }

    this.x = [...x.values()];
    this.y = [...y.values()];
    this.x.sort((a, b) => a.position - b.position);
    this.y.sort((a, b) => a.position - b.position);
  }

  snap(rect: FrameRect, zoom: number, handle?: ResizeHandle, minSize = 1) {
    const right = rect.x + rect.width;
    const bottom = rect.y + rect.height;
    const tolerance = SNAP_DISTANCE / zoom;
    const west = handle?.includes("w");
    const east = handle?.includes("e");
    const north = handle?.includes("n");
    const south = handle?.includes("s");

    const x = closest(
      this.x,
      !handle ? [rect.x, rect.x + rect.width / 2, right] : west ? [rect.x] : east ? [right] : [],
      tolerance,
      east ? rect.x + minSize : -Infinity,
      west ? right - minSize : Infinity,
    );

    const y = closest(
      this.y,
      !handle
        ? [rect.y, rect.y + rect.height / 2, bottom]
        : north
          ? [rect.y]
          : south
            ? [bottom]
            : [],
      tolerance,
      south ? rect.y + minSize : -Infinity,
      north ? bottom - minSize : Infinity,
    );

    const dx = x?.delta ?? 0;
    const dy = y?.delta ?? 0;

    const snapped: FrameRect = {
      x: rect.x + (!handle || west ? dx : 0),
      y: rect.y + (!handle || north ? dy : 0),
      width: rect.width + (east ? dx : west ? -dx : 0),
      height: rect.height + (south ? dy : north ? -dy : 0),
    };

    const guides: AlignmentGuide[] = [];
    if (x)
      guides.push({
        axis: "x",
        position: x.anchor.position,
        start: Math.min(x.anchor.start, snapped.y),
        end: Math.max(x.anchor.end, snapped.y + snapped.height),
      });
    if (y)
      guides.push({
        axis: "y",
        position: y.anchor.position,
        start: Math.min(y.anchor.start, snapped.x),
        end: Math.max(y.anchor.end, snapped.x + snapped.width),
      });

    return { rect: snapped, guides };
  }
}

/** Publish only the small overlay, without rerendering the canvas or its objects. */
export class CanvasGuides {
  private current: readonly AlignmentGuide[] = NO_GUIDES;
  private published = this.current;
  private readonly listeners = new Set<() => void>();
  private readonly batch = new AnimationFrameBatch(() => this.publish());

  getSnapshot = () => this.published;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  };

  set = (guides: readonly AlignmentGuide[]) => {
    this.current = guides;
    this.batch.schedule();
  };

  flush = () => this.batch.flush();

  clear = () => {
    this.batch.cancel();
    this.current = NO_GUIDES;
    this.publish();
  };

  private publish() {
    if (
      this.current.length === this.published.length &&
      this.current.every((guide, index) => {
        const previous = this.published[index];

        return (
          guide.axis === previous.axis &&
          guide.position === previous.position &&
          guide.start === previous.start &&
          guide.end === previous.end
        );
      })
    )
      return;
    this.published = this.current;
    this.listeners.forEach((listener) => listener());
  }
}
