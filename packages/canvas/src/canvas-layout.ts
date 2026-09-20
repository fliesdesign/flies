import type { CanvasFrame, CanvasFrameNode } from "./canvas-document";
import type { Point } from "./canvas-geometry";

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

/** Fixed-size layout: overflow retains its natural size and minimum gap. */
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
