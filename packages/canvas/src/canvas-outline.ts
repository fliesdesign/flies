import type { CanvasDocument, CanvasFrame } from "./canvas-document";
import type { FrameRect, Point } from "./canvas-geometry";
import { hasRotation, visibleWorldPolygon } from "./canvas-transform";

export type CanvasClipBounds = { left: number; top: number; right: number; bottom: number };

export function getClippingAncestors(document: CanvasDocument, frame: CanvasFrame) {
  const ancestors: CanvasFrame[] = [];
  const visited = new Set([frame.id]);
  let parent = frame.parentId ? document.getFrame(frame.parentId) : undefined;

  while (parent && !visited.has(parent.id)) {
    visited.add(parent.id);
    if ((!parent.kind || parent.kind === "frame") && parent.clipContent !== false)
      ancestors.push(parent);
    parent = parent.parentId ? document.getFrame(parent.parentId) : undefined;
  }

  return ancestors;
}

export function getClipBounds(ancestors: readonly CanvasFrame[]): CanvasClipBounds {
  const bounds = { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity };

  for (const ancestor of ancestors) {
    bounds.left = Math.max(bounds.left, ancestor.x);
    bounds.top = Math.max(bounds.top, ancestor.y);
    bounds.right = Math.min(bounds.right, ancestor.x + ancestor.width);
    bounds.bottom = Math.min(bounds.bottom, ancestor.y + ancestor.height);
  }

  return bounds;
}

export function isRectVisibleInClip(frame: FrameRect, clip: CanvasClipBounds) {
  return (
    Math.min(frame.x + frame.width, clip.right) > Math.max(frame.x, clip.left) &&
    Math.min(frame.y + frame.height, clip.bottom) > Math.max(frame.y, clip.top)
  );
}

export function clippingRadius(frame: CanvasFrame) {
  return Math.min(frame.cornerRadius ?? 0, frame.width / 2, frame.height / 2);
}

function pointInRoundedClip(frame: CanvasFrame, point: Point, strict = false) {
  const right = frame.x + frame.width;
  const bottom = frame.y + frame.height;
  if (
    strict
      ? point.x <= frame.x || point.x >= right || point.y <= frame.y || point.y >= bottom
      : point.x < frame.x || point.x > right || point.y < frame.y || point.y > bottom
  )
    return false;
  const radius = clippingRadius(frame);
  if (!radius) return true;
  const centerX = Math.min(Math.max(point.x, frame.x + radius), right - radius);
  const centerY = Math.min(Math.max(point.y, frame.y + radius), bottom - radius);
  const distance = Math.hypot(point.x - centerX, point.y - centerY);

  return strict ? distance < radius : distance <= radius + 1e-8;
}

export function roundedClipsContainPoint(ancestors: readonly CanvasFrame[], point: Point) {
  return ancestors.every((frame) => pointInRoundedClip(frame, point));
}

type Circle = Point & { radius: number };

/** Rounded clips are convex. Their boundary crossings and extrema bound any visible overlap. */
export function getVisibleBoundsInRoundedClips(
  frame: FrameRect,
  ancestors: readonly CanvasFrame[],
): FrameRect | undefined {
  const clip = getClipBounds(ancestors);
  if (!isRectVisibleInClip(frame, clip)) return;
  const left = Math.max(frame.x, clip.left);
  const top = Math.max(frame.y, clip.top);
  const right = Math.min(frame.x + frame.width, clip.right);
  const bottom = Math.min(frame.y + frame.height, clip.bottom);
  const rounded = ancestors.filter((ancestor) => clippingRadius(ancestor) > 0);
  if (!rounded.length) return { x: left, y: top, width: right - left, height: bottom - top };
  const candidates: Point[] = [];

  const add = (x: number, y: number) => {
    const point = { x, y };
    if (
      x >= left &&
      x <= right &&
      y >= top &&
      y <= bottom &&
      roundedClipsContainPoint(rounded, point)
    )
      candidates.push(point);
  };

  add((left + right) / 2, (top + bottom) / 2);
  for (const x of [left, right]) for (const y of [top, bottom]) add(x, y);
  const circles: Circle[] = [];

  for (const ancestor of rounded) {
    const radius = clippingRadius(ancestor);
    for (const x of [ancestor.x + radius, ancestor.x + ancestor.width - radius])
      for (const y of [ancestor.y + radius, ancestor.y + ancestor.height - radius])
        circles.push({ x, y, radius });
  }

  for (const circle of circles) {
    add(circle.x - circle.radius, circle.y);
    add(circle.x + circle.radius, circle.y);
    add(circle.x, circle.y - circle.radius);
    add(circle.x, circle.y + circle.radius);

    for (const x of [left, right]) {
      const square = circle.radius ** 2 - (x - circle.x) ** 2;
      if (square < 0) continue;
      const delta = Math.sqrt(square);
      add(x, circle.y - delta);
      add(x, circle.y + delta);
    }

    for (const y of [top, bottom]) {
      const square = circle.radius ** 2 - (y - circle.y) ** 2;
      if (square < 0) continue;
      const delta = Math.sqrt(square);
      add(circle.x - delta, y);
      add(circle.x + delta, y);
    }
  }

  for (let index = 0; index < circles.length; index++) {
    const a = circles[index];

    for (let other = index + 1; other < circles.length; other++) {
      const b = circles[other];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.hypot(dx, dy);
      if (!distance || distance > a.radius + b.radius || distance < Math.abs(a.radius - b.radius))
        continue;
      const along = (a.radius ** 2 - b.radius ** 2 + distance ** 2) / (2 * distance);
      const across = Math.sqrt(Math.max(0, a.radius ** 2 - along ** 2));
      const x = a.x + (dx * along) / distance;
      const y = a.y + (dy * along) / distance;
      add(x - (dy * across) / distance, y + (dx * across) / distance);
      add(x + (dy * across) / distance, y - (dx * across) / distance);
    }
  }

  if (!candidates.length) return;

  // Averaging feasible points stays inside every convex clip. Strict containment
  // distinguishes an actual visible area from a boundary-only touch.
  const center = candidates.reduce(
    (point, next) => ({ x: point.x + next.x, y: point.y + next.y }),
    { x: 0, y: 0 },
  );

  center.x /= candidates.length;
  center.y /= candidates.length;
  if (center.x <= left || center.x >= right || center.y <= top || center.y >= bottom) return;
  if (!rounded.every((ancestor) => pointInRoundedClip(ancestor, center, true))) return;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const point of candidates) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function isRectVisibleInRoundedClips(frame: FrameRect, ancestors: readonly CanvasFrame[]) {
  return getVisibleBoundsInRoundedClips(frame, ancestors) !== undefined;
}

/** A layer can stay selected in the tree without creating invisible canvas controls. */
export function getVisibleSelectionFrames(document: CanvasDocument, ids: readonly string[]) {
  return document
    .getRootIds(ids)
    .filter((id) => !document.isHidden(id))
    .map((id) => document.getFrame(id))
    .filter((frame): frame is CanvasFrame =>
      Boolean(
        frame &&
        (hasRotation(document, frame)
          ? visibleWorldPolygon(document, frame).length > 2
          : isRectVisibleInRoundedClips(frame, getClippingAncestors(document, frame))),
      ),
    );
}
