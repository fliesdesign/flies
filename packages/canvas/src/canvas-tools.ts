import type { FrameRect, Point } from "./canvas-geometry";

export type CanvasTool = "select" | "frame" | "rectangle" | "text" | "image" | "pen" | "pan";

/** Keep the pointer-down corner anchored when a short reverse drag hits the minimum. */
export function rectFromPoints(start: Point, end: Point, min = 1): FrameRect {
  const minimum = Math.max(1, Number.isFinite(min) ? min : 1);
  const width = Math.max(minimum, Math.abs(end.x - start.x));
  const height = Math.max(minimum, Math.abs(end.y - start.y));

  return {
    x: end.x < start.x ? start.x - width : start.x,
    y: end.y < start.y ? start.y - height : start.y,
    width,
    height,
  };
}

export type CanvasPenGeometry = FrameRect & {
  points: Point[];
  pathWidth: number;
  pathHeight: number;
};

/** Local points and a padded viewBox keep a three-pixel stroke inside its node bounds. */
export function penFromPoints(points: readonly Point[]): CanvasPenGeometry | null {
  if (points.length === 0) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;

  for (const point of points) {
    left = Math.min(left, point.x);
    top = Math.min(top, point.y);
    right = Math.max(right, point.x);
    bottom = Math.max(bottom, point.y);
  }

  const padding = 2;
  const x = left - padding;
  const y = top - padding;
  const width = right - left + padding * 2;
  const height = bottom - top + padding * 2;

  return {
    x,
    y,
    width,
    height,
    pathWidth: width,
    pathHeight: height,
    points: points.map((point) => ({ x: point.x - x, y: point.y - y })),
  };
}
