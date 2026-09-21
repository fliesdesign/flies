import type { CanvasFrame, CanvasFrameNode } from "./canvas-document";
import type { FrameRect, Point } from "./canvas-geometry";

export type CanvasSizing = "fixed" | "fill" | "hug";

export function isCanvasSizing(value: unknown): value is CanvasSizing {
  return value === "fixed" || value === "fill" || value === "hug";
}

export function canvasMinimumSize(node: CanvasFrame): number {
  return !node.kind || node.kind === "frame" ? 40 : 1;
}

/** Labels use resolved dimensions; Fit is the user-facing name for hug contents. */
export function canvasSizingLabel(node: CanvasFrame): string {
  const label = (axis: "width" | "height") => {
    const mode = node[axis === "width" ? "widthSizing" : "heightSizing"];
    const prefix = mode === "fill" ? "Fill " : mode === "hug" ? "Fit " : "";

    return `${prefix}${Math.round(node[axis] * 100) / 100}`;
  };

  return `${label("width")} × ${label("height")}`;
}

export type CanvasLayout = Readonly<{
  direction: "row" | "column";
  gap: number;
  padding: number;
  align: "start" | "center" | "end";
  justify: "start" | "center" | "end" | "space-between";
}>;

export const DEFAULT_CANVAS_LAYOUT: CanvasLayout = Object.freeze({
  direction: "row",
  gap: 16,
  padding: 16,
  align: "start",
  justify: "start",
});

export function isCanvasLayout(value: unknown): value is CanvasLayout {
  if (!value || typeof value !== "object") return false;
  const layout = value as Record<string, unknown>;

  return (
    (layout.direction === "row" || layout.direction === "column") &&
    typeof layout.gap === "number" &&
    Number.isFinite(layout.gap) &&
    layout.gap >= 0 &&
    typeof layout.padding === "number" &&
    Number.isFinite(layout.padding) &&
    layout.padding >= 0 &&
    (layout.align === "start" || layout.align === "center" || layout.align === "end") &&
    (layout.justify === "start" ||
      layout.justify === "center" ||
      layout.justify === "end" ||
      layout.justify === "space-between")
  );
}

/** Measure before allocation. Fill on a hugged axis contributes its minimum size,
 * avoiding a dependency cycle between a parent's size and its children's fills. */
export function canvasLayoutHugSize(
  container: CanvasFrameNode,
  children: readonly CanvasFrame[],
): Pick<FrameRect, "width" | "height"> {
  const result = { width: container.width, height: container.height };
  if (!container.layout) return result;
  const { direction, padding, gap } = container.layout;
  const visible = children.filter((node) => !node.hidden);

  for (const axis of ["width", "height"] as const) {
    const sizing = axis === "width" ? "widthSizing" : "heightSizing";
    if (container[sizing] !== "hug") continue;

    const sizes = visible.map((child) =>
      child[sizing] === "fill" ? canvasMinimumSize(child) : child[axis],
    );

    const main = (axis === "width") === (direction === "row");

    const content = main
      ? sizes.reduce((total, size) => total + size, 0) + gap * Math.max(0, sizes.length - 1)
      : sizes.reduce((largest, size) => Math.max(largest, size), 0);

    result[axis] = Math.max(40, content + padding * 2);
  }

  return result;
}

/** Allocate fill children equally after fixed sizes, padding and minimum gaps.
 * Minimum sizes are retained during overflow, just like fixed-size children. */
export function canvasLayoutRects(
  container: CanvasFrameNode,
  children: readonly CanvasFrame[],
): ReadonlyMap<string, FrameRect> {
  const layout = container.layout;
  if (!layout) return new Map();
  const visible = children.filter((node) => !node.hidden);
  const main = layout.direction === "row" ? "width" : "height";
  const cross = main === "width" ? "height" : "width";
  const mainSizing = main === "width" ? "widthSizing" : "heightSizing";
  const crossSizing = cross === "width" ? "widthSizing" : "heightSizing";
  const fills = visible.filter((node) => node[mainSizing] === "fill");

  const available =
    container[main] - layout.padding * 2 - layout.gap * Math.max(0, visible.length - 1);

  let remaining =
    available -
    visible.reduce((total, node) => total + (node[mainSizing] === "fill" ? 0 : node[main]), 0);

  const allocated = new Map<string, number>();
  let pending = fills;

  while (pending.length) {
    const share = remaining / pending.length;
    const constrained = pending.filter((node) => canvasMinimumSize(node) > share);

    if (!constrained.length) {
      for (const node of pending) allocated.set(node.id, share);
      break;
    }

    for (const node of constrained) {
      const minimum = canvasMinimumSize(node);
      allocated.set(node.id, minimum);
      remaining -= minimum;
    }

    pending = pending.filter((node) => !allocated.has(node.id));
  }

  // oxlint-disable-next-line oxc/no-map-spread -- Input nodes are immutable document snapshots.
  const resolved = visible.map((node) => ({
    ...node,
    [main]:
      node[mainSizing] === "fill"
        ? container[mainSizing] === "hug"
          ? canvasMinimumSize(node)
          : allocated.get(node.id)!
        : node[main],
    [cross]:
      node[crossSizing] === "fill"
        ? container[crossSizing] === "hug"
          ? canvasMinimumSize(node)
          : Math.max(canvasMinimumSize(node), container[cross] - layout.padding * 2)
        : node[cross],
  }));

  const positions = canvasLayoutPositions(container, resolved);

  return new Map(
    resolved.map((node) => [
      node.id,
      {
        ...positions.get(node.id)!,
        width: node.width,
        height: node.height,
      },
    ]),
  );
}

/** Position children whose dimensions are already resolved. */
export function canvasLayoutPositions(
  container: CanvasFrameNode,
  children: readonly CanvasFrame[],
): ReadonlyMap<string, Point> {
  const positions = new Map<string, Point>();
  const layout = container.layout;
  if (!layout) return positions;
  const visible = children.filter((node) => !node.hidden);
  if (!visible.length) return positions;
  const horizontal = layout.direction === "row";
  const mainSize = horizontal ? "width" : "height";
  const crossSize = horizontal ? "height" : "width";
  const available = container[mainSize] - layout.padding * 2;
  const content = visible.reduce((sum, child) => sum + child[mainSize], 0);
  const minimumGaps = layout.gap * (visible.length - 1);
  const remaining = Math.max(0, available - content - minimumGaps);

  const gap =
    layout.justify === "space-between" && visible.length > 1
      ? layout.gap + remaining / (visible.length - 1)
      : layout.gap;

  let cursor =
    layout.padding +
    (layout.justify === "center" ? remaining / 2 : layout.justify === "end" ? remaining : 0);

  for (const child of visible) {
    const crossRemaining = Math.max(
      0,
      container[crossSize] - layout.padding * 2 - child[crossSize],
    );

    const cross =
      layout.padding +
      (layout.align === "center"
        ? crossRemaining / 2
        : layout.align === "end"
          ? crossRemaining
          : 0);

    positions.set(child.id, {
      x: container.x + (horizontal ? cursor : cross),
      y: container.y + (horizontal ? cross : cursor),
    });
    cursor += child[mainSize] + gap;
  }

  return positions;
}
