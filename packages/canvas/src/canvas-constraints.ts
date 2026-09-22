import type { CanvasFrame } from "./canvas-document";
import type { FrameRect } from "./canvas-geometry";

export const CANVAS_CONSTRAINT_MODES = ["start", "end", "center", "stretch", "scale"] as const;
export type CanvasConstraintMode = (typeof CANVAS_CONSTRAINT_MODES)[number];
export type CanvasConstraints = Readonly<{
  horizontal?: CanvasConstraintMode;
  vertical?: CanvasConstraintMode;
}>;

export function isCanvasConstraints(value: unknown): value is CanvasConstraints {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;

  return Object.entries(value).every(
    ([axis, mode]) =>
      (axis === "horizontal" || axis === "vertical") &&
      CANVAS_CONSTRAINT_MODES.includes(mode as CanvasConstraintMode),
  );
}

export function canvasDimensionLimits(node: CanvasFrame, axis: "width" | "height") {
  const floor = node.kind === "page" ? 0 : !node.kind || node.kind === "frame" ? 40 : 1;
  const minimum = axis === "width" ? node.minWidth : node.minHeight;
  const maximum = axis === "width" ? node.maxWidth : node.maxHeight;

  return { minimum: Math.max(floor, minimum ?? floor), maximum: maximum ?? Infinity };
}

export function clampCanvasDimension(node: CanvasFrame, axis: "width" | "height", value: number) {
  const { minimum, maximum } = canvasDimensionLimits(node, axis);

  return Math.max(minimum, Math.min(maximum, value));
}

/** Resolve explicit pins in the parent's local coordinate system. Unconfigured nodes keep cropping. */
export function canvasConstrainedRect(
  before: FrameRect,
  after: FrameRect,
  child: CanvasFrame,
): FrameRect {
  const result = { x: child.x, y: child.y, width: child.width, height: child.height };
  if (!child.constraints) return result;

  for (const [axis, position, constraint] of [
    ["width", "x", "horizontal"],
    ["height", "y", "vertical"],
  ] as const) {
    const mode = child.constraints[constraint] ?? "start";
    const delta = after[axis] - before[axis];
    const offset = child[position] - before[position];
    let size = child[axis];
    let nextOffset = offset;

    if (mode === "end") nextOffset += delta;
    else if (mode === "center") nextOffset += delta / 2;
    else if (mode === "stretch") size += delta;
    else if (mode === "scale") {
      const ratio = before[axis] > 0 ? after[axis] / before[axis] : 1;
      nextOffset *= ratio;
      size *= ratio;
    }

    result[position] = after[position] + nextOffset;
    result[axis] = clampCanvasDimension(child, axis, size);
  }

  return result;
}

/** Internal resize compensation must not override the document's responsive child updates. */
export function canvasConstraintDrivenIds(
  nodes: readonly CanvasFrame[],
  before: CanvasFrame,
  after: CanvasFrame,
): ReadonlySet<string> {
  const result = new Set<string>();
  if (
    (before.kind && before.kind !== "frame") ||
    before.layout ||
    (before.width === clampCanvasDimension(after, "width", after.width) &&
      before.height === clampCanvasDimension(after, "height", after.height))
  )
    return result;
  const children = new Map<string, CanvasFrame[]>();

  for (const node of nodes) {
    if (!node.parentId) continue;
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node);
    children.set(node.parentId, siblings);
  }

  const pending = (children.get(before.id) ?? []).filter((node) => node.constraints !== undefined);

  while (pending.length) {
    const node = pending.pop()!;
    if (result.has(node.id)) continue;
    result.add(node.id);
    pending.push(...(children.get(node.id) ?? []));
  }

  return result;
}
