import { canvasDimensionLimits, clampCanvasDimension } from "./canvas-constraints";
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
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  wrap?: boolean;
  /** Gap between wrapped rows or columns; defaults to gap. */
  rowGap?: number;
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

export function canvasLayoutPadding(layout: CanvasLayout) {
  return {
    top: layout.paddingTop ?? layout.padding,
    right: layout.paddingRight ?? layout.padding,
    bottom: layout.paddingBottom ?? layout.padding,
    left: layout.paddingLeft ?? layout.padding,
  };
}

function nonnegative(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function isCanvasLayout(value: unknown): value is CanvasLayout {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const layout = value as Record<string, unknown>;

  return (
    (layout.direction === "row" || layout.direction === "column") &&
    nonnegative(layout.gap) &&
    nonnegative(layout.padding) &&
    ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "rowGap"].every(
      (key) => layout[key] === undefined || nonnegative(layout[key]),
    ) &&
    (layout.wrap === undefined || typeof layout.wrap === "boolean") &&
    (layout.align === "start" || layout.align === "center" || layout.align === "end") &&
    ["start", "center", "end", "space-between"].includes(String(layout.justify))
  );
}

function axes(container: CanvasFrameNode) {
  const layout = container.layout!;
  const padding = canvasLayoutPadding(layout);
  const horizontal = layout.direction === "row";

  return {
    main: horizontal ? ("width" as const) : ("height" as const),
    cross: horizontal ? ("height" as const) : ("width" as const),
    mainSizing: horizontal ? ("widthSizing" as const) : ("heightSizing" as const),
    crossSizing: horizontal ? ("heightSizing" as const) : ("widthSizing" as const),
    mainStart: horizontal ? padding.left : padding.top,
    mainEnd: horizontal ? padding.right : padding.bottom,
    crossStart: horizontal ? padding.top : padding.left,
    crossEnd: horizontal ? padding.bottom : padding.right,
    horizontal,
  };
}

function intrinsic(node: CanvasFrame, axis: "width" | "height") {
  const sizing = axis === "width" ? node.widthSizing : node.heightSizing;

  return sizing === "fill"
    ? canvasDimensionLimits(node, axis).minimum
    : clampCanvasDimension(node, axis, node[axis]);
}

function linesFor(
  container: CanvasFrameNode,
  children: readonly CanvasFrame[],
  resolveFill: boolean,
) {
  const layout = container.layout!;
  const { main, mainSizing, mainStart, mainEnd } = axes(container);
  const available = container[main] - mainStart - mainEnd;
  const wrap = layout.wrap && container[mainSizing] !== "hug";
  const lines: CanvasFrame[][] = [];
  let line: CanvasFrame[] = [];
  let occupied = 0;

  for (const node of children) {
    if (node.hidden) continue;
    const size = resolveFill ? intrinsic(node, main) : node[main];
    const next = occupied + (line.length ? layout.gap : 0) + size;

    if (wrap && line.length && next > available) {
      lines.push(line);
      line = [];
      occupied = 0;
    }

    occupied += (line.length ? layout.gap : 0) + size;
    line.push(node);
  }

  if (line.length) lines.push(line);

  return lines;
}

/** Resolved line membership is shared with spacing handles so wrapped gaps remain editable. */
export function canvasLayoutLines(container: CanvasFrameNode, children: readonly CanvasFrame[]) {
  return container.layout ? linesFor(container, children, true) : [];
}

/** Bounded water filling redistributes leftover space after a child reaches its min or max. */
function allocate(container: CanvasFrameNode, line: readonly CanvasFrame[]) {
  const { main, mainSizing, mainStart, mainEnd } = axes(container);
  const sizes = new Map<string, number>();
  let pending = line.filter((node) => node[mainSizing] === "fill");

  let remaining =
    container[main] - mainStart - mainEnd - container.layout!.gap * Math.max(0, line.length - 1);

  for (const node of line) {
    if (node[mainSizing] === "fill") continue;
    const size = clampCanvasDimension(node, main, node[main]);
    sizes.set(node.id, size);
    remaining -= size;
  }

  while (pending.length) {
    const share = remaining / pending.length;

    const clampedTotal = pending.reduce(
      (total, node) => total + clampCanvasDimension(node, main, share),
      0,
    );

    // Freeze only the limits pushing the total away from the available space.
    // Freezing both minimum and maximum violations together can over-allocate
    // despite a feasible distribution (for example min80/max10/max30 in 100px).
    const limited = pending.filter((node) => {
      const size = clampCanvasDimension(node, main, share);

      return clampedTotal > remaining ? size > share : size < share;
    });

    if (!limited.length) {
      for (const node of pending) sizes.set(node.id, clampCanvasDimension(node, main, share));
      break;
    }

    for (const node of limited) {
      const size = clampCanvasDimension(node, main, share);
      sizes.set(node.id, size);
      remaining -= size;
    }

    pending = pending.filter((node) => !sizes.has(node.id));
  }

  return sizes;
}

/** Fill on a hugged axis contributes its minimum, avoiding cyclic sizing dependencies. */
export function canvasLayoutHugSize(
  container: CanvasFrameNode,
  children: readonly CanvasFrame[],
): Pick<FrameRect, "width" | "height"> {
  const result = { width: container.width, height: container.height };
  if (!container.layout) return result;

  const { main, cross, mainSizing, crossSizing, mainStart, mainEnd, crossStart, crossEnd } =
    axes(container);

  const visible = children.filter((node) => !node.hidden);

  if (container[mainSizing] === "hug") {
    result[main] = clampCanvasDimension(
      container,
      main,
      visible.reduce((sum, node) => sum + intrinsic(node, main), 0) +
        container.layout.gap * Math.max(0, visible.length - 1) +
        mainStart +
        mainEnd,
    );
  }

  if (container[crossSizing] === "hug") {
    const lines = linesFor({ ...container, ...result }, visible, true);

    const content = lines.reduce(
      (sum, line) => sum + Math.max(0, ...line.map((node) => intrinsic(node, cross))),
      0,
    );

    result[cross] = clampCanvasDimension(
      container,
      cross,
      content +
        (container.layout.rowGap ?? container.layout.gap) * Math.max(0, lines.length - 1) +
        crossStart +
        crossEnd,
    );
  }

  return result;
}

function resolve(container: CanvasFrameNode, children: readonly CanvasFrame[], resize: boolean) {
  const result = new Map<string, FrameRect>();
  const layout = container.layout;
  if (!layout) return result;

  const {
    main,
    cross,
    mainSizing,
    crossSizing,
    mainStart,
    mainEnd,
    crossStart,
    crossEnd,
    horizontal,
  } = axes(container);

  const lines = linesFor(container, children, resize);
  let crossCursor = crossStart;

  for (const line of lines) {
    const mainSizes = resize
      ? allocate(container, line)
      : new Map(line.map((node) => [node.id, node[main]]));

    const lineCross = layout.wrap
      ? Math.max(0, ...line.map((node) => (resize ? intrinsic(node, cross) : node[cross])))
      : container[cross] - crossStart - crossEnd;

    const available = container[main] - mainStart - mainEnd;

    const occupied = line.reduce(
      (sum, node) =>
        sum +
        (container[mainSizing] === "hug" && resize
          ? intrinsic(node, main)
          : mainSizes.get(node.id)!),
      0,
    );

    const remaining = Math.max(0, available - occupied - layout.gap * Math.max(0, line.length - 1));

    const gap =
      layout.justify === "space-between" && line.length > 1
        ? layout.gap + remaining / (line.length - 1)
        : layout.gap;

    let cursor =
      mainStart +
      (layout.justify === "center" ? remaining / 2 : layout.justify === "end" ? remaining : 0);

    for (const node of line) {
      const mainSize =
        resize && container[mainSizing] === "hug" ? intrinsic(node, main) : mainSizes.get(node.id)!;

      const crossSize =
        resize && node[crossSizing] === "fill"
          ? clampCanvasDimension(
              node,
              cross,
              container[crossSizing] === "hug" ? intrinsic(node, cross) : lineCross,
            )
          : clampCanvasDimension(node, cross, node[cross]);

      const crossRemaining = Math.max(0, lineCross - crossSize);

      const offset =
        crossCursor +
        (layout.align === "center"
          ? crossRemaining / 2
          : layout.align === "end"
            ? crossRemaining
            : 0);

      result.set(node.id, {
        x: container.x + (horizontal ? cursor : offset),
        y: container.y + (horizontal ? offset : cursor),
        width: horizontal ? mainSize : crossSize,
        height: horizontal ? crossSize : mainSize,
      });
      cursor += mainSize + gap;
    }

    crossCursor += lineCross + (layout.rowGap ?? layout.gap);
  }

  return result;
}

export function canvasLayoutRects(
  container: CanvasFrameNode,
  children: readonly CanvasFrame[],
): ReadonlyMap<string, FrameRect> {
  return resolve(container, children, true);
}

/** Position already resolved dimensions without changing their sizing modes. */
export function canvasLayoutPositions(
  container: CanvasFrameNode,
  children: readonly CanvasFrame[],
): ReadonlyMap<string, Point> {
  return new Map(
    [...resolve(container, children, false)].map(([id, rect]) => [id, { x: rect.x, y: rect.y }]),
  );
}
