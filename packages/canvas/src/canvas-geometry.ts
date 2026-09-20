export type Point = { x: number; y: number };

/** Screen position = world position × zoom + viewport translation. */
export type Viewport = Point & { zoom: number };

export type FrameRect = Point & { width: number; height: number };

export type ResizeHandle = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 4;

function clampZoom(zoom: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export function screenToWorld(point: Point, viewport: Viewport): Point {
  return {
    x: (point.x - viewport.x) / viewport.zoom,
    y: (point.y - viewport.y) / viewport.zoom,
  };
}

/** Keep the world point under the cursor stationary when changing zoom. */
export function zoomAtPoint(viewport: Viewport, point: Point, nextZoom: number): Viewport {
  const worldPoint = screenToWorld(point, viewport);
  const zoom = clampZoom(nextZoom);

  return {
    x: point.x - worldPoint.x * zoom,
    y: point.y - worldPoint.y * zoom,
    zoom,
  };
}

/** Delta is measured in world coordinates from the beginning of the gesture. */
export function resizeFrame(
  start: FrameRect,
  handle: ResizeHandle,
  delta: Point,
  minSize = 40,
): FrameRect {
  const frame = { ...start };
  const minimum = Math.max(1, Math.ceil(minSize));

  if (handle.includes("e")) {
    frame.width = Math.max(minimum, Math.round(start.width + delta.x));
  }
  if (handle.includes("w")) {
    frame.width = Math.max(minimum, Math.round(start.width - delta.x));
    frame.x = start.x + start.width - frame.width;
  }
  if (handle.includes("s")) {
    frame.height = Math.max(minimum, Math.round(start.height + delta.y));
  }
  if (handle.includes("n")) {
    frame.height = Math.max(minimum, Math.round(start.height - delta.y));
    frame.y = start.y + start.height - frame.height;
  }

  return frame;
}

/** Shift-resize preserves aspect ratio and anchors the opposite corner/edge. */
export function resizeFrameProportionally(
  start: FrameRect,
  handle: ResizeHandle,
  delta: Point,
  minSize = 1,
): FrameRect {
  const west = handle.includes("w");
  const east = handle.includes("e");
  const north = handle.includes("n");
  const south = handle.includes("s");
  const scaleX = 1 + (west ? -delta.x : east ? delta.x : 0) / start.width;
  const scaleY = 1 + (north ? -delta.y : south ? delta.y : 0) / start.height;
  const horizontal = west || east;
  const vertical = north || south;
  const requested =
    horizontal && vertical
      ? Math.abs(scaleX - 1) >= Math.abs(scaleY - 1)
        ? scaleX
        : scaleY
      : horizontal
        ? scaleX
        : scaleY;
  const scale = Math.max(minSize / start.width, minSize / start.height, requested);
  const width = start.width * scale;
  const height = start.height * scale;
  return {
    x: west ? start.x + start.width - width : east ? start.x : start.x + (start.width - width) / 2,
    y: north
      ? start.y + start.height - height
      : south
        ? start.y
        : start.y + (start.height - height) / 2,
    width,
    height,
  };
}

/** Fit all frame bounds without enlarging them beyond their actual size. */
export function fitViewport(
  frames: readonly FrameRect[],
  viewportSize: Point,
  padding = 80,
): Viewport {
  if (frames.length === 0) {
    return { x: viewportSize.x / 2, y: viewportSize.y / 2, zoom: 1 };
  }

  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const frame of frames) {
    left = Math.min(left, frame.x);
    top = Math.min(top, frame.y);
    right = Math.max(right, frame.x + frame.width);
    bottom = Math.max(bottom, frame.y + frame.height);
  }
  const inset = Math.max(0, padding);
  const availableWidth = Math.max(1, viewportSize.x - inset * 2);
  const availableHeight = Math.max(1, viewportSize.y - inset * 2);
  const zoom = clampZoom(
    Math.min(
      1,
      availableWidth / Math.max(1, right - left),
      availableHeight / Math.max(1, bottom - top),
    ),
  );

  return {
    x: viewportSize.x / 2 - ((left + right) / 2) * zoom,
    y: viewportSize.y / 2 - ((top + bottom) / 2) * zoom,
    zoom,
  };
}
