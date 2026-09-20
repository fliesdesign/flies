import type { CanvasFrame, CanvasText } from "./canvas-document";
import { isFontFamily } from "./canvas-fonts";
import { DEFAULT_CANVAS_LAYOUT } from "./canvas-layout";
import {
  moveSelection,
  resizeSelection,
  selectionBounds,
  selectionRoots,
} from "./canvas-operations";

export type CanvasProperty =
  | "x"
  | "y"
  | "width"
  | "height"
  | "opacity"
  | "cornerRadius"
  | "fill"
  | "fontFamily"
  | "fontWeight"
  | "fontSize"
  | "lineHeight"
  | "letterSpacing"
  | "textAlign"
  | "strokeWidth"
  | "clipContent"
  | "layoutMode"
  | "layoutGap"
  | "layoutPadding"
  | "layoutAlign"
  | "layoutJustify"
  | "hidden"
  | "locked";

export type CanvasPropertyOptions = { preserveAspect?: boolean };

function isLocked(node: CanvasFrame, byId: ReadonlyMap<string, CanvasFrame>): boolean {
  const visited = new Set<string>();
  let current: CanvasFrame | undefined = node;
  while (current && !visited.has(current.id)) {
    if (current.locked) return true;
    visited.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return false;
}

function styleChange(
  node: CanvasFrame,
  property: CanvasProperty,
  value: string | number | boolean,
): CanvasFrame {
  const numeric = typeof value === "number" && Number.isFinite(value);
  const frame = !node.kind || node.kind === "frame";
  switch (property) {
    case "hidden":
    case "locked":
      return typeof value === "boolean" ? { ...node, [property]: value } : node;
    case "opacity":
      return numeric && value >= 0 && value <= 1 ? { ...node, opacity: value } : node;
    case "cornerRadius":
      return numeric &&
        value >= 0 &&
        (frame || node.kind === "rectangle" || node.kind === "image" || node.kind === "svg")
        ? { ...node, cornerRadius: value }
        : node;
    case "fill": {
      if (
        typeof value !== "string" ||
        !/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value)
      )
        return node;
      if (node.kind === "text") return { ...node, color: value };
      if (node.kind === "pen") return { ...node, stroke: value };
      return frame || node.kind === "rectangle" ? { ...node, fill: value } : node;
    }
    case "clipContent":
      return frame && typeof value === "boolean" ? { ...node, clipContent: value } : node;
    case "layoutMode": {
      if (node.kind && node.kind !== "frame") return node;
      if (value === "none") {
        const { layout: _layout, ...withoutLayout } = node;
        return withoutLayout;
      }
      return value === "row" || value === "column"
        ? { ...node, layout: { ...(node.layout ?? DEFAULT_CANVAS_LAYOUT), direction: value } }
        : node;
    }
    case "layoutGap":
    case "layoutPadding":
    case "layoutAlign":
    case "layoutJustify": {
      if ((node.kind && node.kind !== "frame") || !node.layout) return node;
      if ((property === "layoutGap" || property === "layoutPadding") && numeric && value >= 0)
        return {
          ...node,
          layout: { ...node.layout, [property === "layoutGap" ? "gap" : "padding"]: value },
        };
      if (
        property === "layoutAlign" &&
        (value === "start" || value === "center" || value === "end")
      )
        return { ...node, layout: { ...node.layout, align: value } };
      if (
        property === "layoutJustify" &&
        (value === "start" || value === "center" || value === "end" || value === "space-between")
      )
        return { ...node, layout: { ...node.layout, justify: value } };
      return node;
    }
    case "strokeWidth":
      return node.kind === "pen" && numeric && value > 0 ? { ...node, strokeWidth: value } : node;
    case "fontFamily":
      return node.kind === "text" && isFontFamily(value)
        ? { ...node, fontFamily: value.trim() }
        : node;
    case "fontWeight":
      return node.kind === "text" &&
        typeof value === "number" &&
        Number.isInteger(value) &&
        value >= 1 &&
        value <= 1000
        ? { ...node, fontWeight: value }
        : node;
    case "fontSize":
      return node.kind === "text" && numeric && value > 0 ? { ...node, fontSize: value } : node;
    case "lineHeight":
      return node.kind === "text" && numeric && value >= 0.5 && value <= 4
        ? { ...node, lineHeight: value }
        : node;
    case "letterSpacing":
      return node.kind === "text" && numeric && value >= -10 && value <= 100
        ? { ...node, letterSpacing: value }
        : node;
    case "textAlign":
      return node.kind === "text" && (value === "left" || value === "center" || value === "right")
        ? { ...node, textAlign: value as CanvasText["textAlign"] }
        : node;
    default:
      return node;
  }
}

/** Produce one document update so geometry, descendants and text reflow undo together. */
export function changeCanvasProperty(
  nodes: readonly CanvasFrame[],
  ids: readonly string[],
  property: CanvasProperty,
  value: string | number | boolean,
  measureText: (node: CanvasText) => number,
  options: CanvasPropertyOptions = {},
): CanvasFrame[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const roots = selectionRoots(nodes, ids);
  const selected = roots.map((id) => byId.get(id)!);
  if (!selected.length) return [];
  if (
    property !== "locked" &&
    property !== "hidden" &&
    selected.some((node) => isLocked(node, byId))
  )
    return [];
  const bounds = selectionBounds(nodes, roots)!;
  const single = selected.length === 1 ? selected[0] : undefined;
  if (property === "x" || property === "y") {
    if (typeof value !== "number" || !Number.isFinite(value)) return [];
    const parent = single?.parentId ? byId.get(single.parentId) : undefined;
    const next = value + (parent?.[property] ?? 0);
    return moveSelection(nodes, roots, {
      x: property === "x" ? next - bounds.x : 0,
      y: property === "y" ? next - bounds.y : 0,
    });
  }
  if (property === "width" || property === "height") {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return [];
    const minimum = single && (!single.kind || single.kind === "frame") ? 40 : 1;
    const dimension = Math.max(minimum, value);
    const next = { ...bounds, [property]: dimension };
    if (options.preserveAspect) {
      const other = property === "width" ? "height" : "width";
      const scale = Math.max(dimension / bounds[property], minimum / bounds[other]);
      next.width = bounds.width * scale;
      next.height = bounds.height * scale;
    }
    const updates = resizeSelection(nodes, roots, bounds, next);
    if (single?.kind === "text" && property === "width" && !options.preserveAspect) {
      for (let index = 0; index < updates.length; index++) {
        const node = updates[index];
        if (node.kind === "text") updates[index] = { ...node, height: measureText(node) };
      }
    }
    return updates;
  }
  const reflow = ["fontFamily", "fontWeight", "fontSize", "lineHeight", "letterSpacing"].includes(
    property,
  );
  return selected.flatMap((node) => {
    const updated = styleChange(node, property, value);
    if (updated === node) return [];
    return [
      reflow && updated.kind === "text" ? { ...updated, height: measureText(updated) } : updated,
    ];
  });
}
