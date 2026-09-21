import type { CanvasFrame, CanvasText } from "./canvas-document";
import { isFontFamily } from "./canvas-fonts";
import { DEFAULT_CANVAS_LAYOUT, isCanvasSizing } from "./canvas-layout";
import {
  moveSelection,
  resizeSelection,
  selectionBounds,
  selectionRoots,
} from "./canvas-operations";
import {
  CANVAS_BLEND_MODES,
  CANVAS_FILTERS,
  type CanvasBlendMode,
  type CanvasFilterName,
} from "./canvas-paint";
import {
  frameSource,
  hasRotation,
  worldBounds,
  moveSelectionWorld,
  scaleSelectionWorld,
  pointBounds,
} from "./canvas-transform";

export type CanvasProperty =
  | "rotation"
  | "blendMode"
  | "filterValue"
  | "filtersReset"
  | "gradientType"
  | "gradientAngle"
  | "gradientInterpolation"
  | "gradientBackground"
  | "gradientStopColor"
  | "gradientStopOffset"
  | "gradientStopAdd"
  | "gradientStopRemove"
  | "x"
  | "y"
  | "width"
  | "height"
  | "widthSizing"
  | "heightSizing"
  | "opacity"
  | "cornerRadius"
  | "fill"
  | "fontFamily"
  | "fontWeight"
  | "fontStyle"
  | "textDecoration"
  | "borderRemove"
  | "borderWidth"
  | "borderColor"
  | "shadowAdd"
  | "shadowRemove"
  | "shadowOffsetX"
  | "shadowOffsetY"
  | "shadowBlur"
  | "shadowSpread"
  | "shadowColor"
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
  | "layoutPosition"
  | "hidden"
  | "locked";

export type CanvasPropertyOptions = {
  preserveAspect?: boolean;
  filterName?: CanvasFilterName;
  gradientStop?: number;
  /** Index within the inner or outer shadow stack, not the combined array. */
  shadowIndex?: number;
  shadowInset?: boolean;
};

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
  options: CanvasPropertyOptions,
): CanvasFrame {
  const numeric = typeof value === "number" && Number.isFinite(value);
  const frame = !node.kind || node.kind === "frame";

  const color =
    typeof value === "string" && /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value);

  if (property.startsWith("shadow")) {
    const shadows = [...(node.shadows ?? [])];
    const inset = options.shadowInset ?? false;

    if (property === "shadowAdd") {
      if (shadows.length >= 8) return node;

      return {
        ...node,
        shadows: [
          ...shadows,
          { offsetX: 0, offsetY: 4, blur: 12, spread: 0, color: "#00000040", inset },
        ],
      };
    }

    const index = options.shadowIndex ?? 0;
    if (!Number.isInteger(index) || index < 0) return node;

    const target = shadows
      .map((shadow, i) => ({ shadow, i }))
      .filter(({ shadow }) => Boolean(shadow.inset) === inset)[index]?.i;

    if (target === undefined) return node;

    if (property === "shadowRemove") shadows.splice(target, 1);
    else {
      const shadow = shadows[target];

      switch (property) {
        case "shadowOffsetX":
          if (!numeric) return node;
          shadows[target] = { ...shadow, offsetX: value };
          break;
        case "shadowOffsetY":
          if (!numeric) return node;
          shadows[target] = { ...shadow, offsetY: value };
          break;
        case "shadowBlur":
          if (!numeric || value < 0) return node;
          shadows[target] = { ...shadow, blur: value };
          break;
        case "shadowSpread":
          if (!numeric) return node;
          shadows[target] = { ...shadow, spread: value };
          break;
        case "shadowColor":
          if (!color) return node;
          shadows[target] = { ...shadow, color: value };
          break;
        default:
          return node;
      }
    }

    return { ...node, shadows };
  }

  switch (property) {
    case "rotation":
      return numeric ? { ...node, rotation: ((value % 360) + 360) % 360 } : node;
    case "blendMode":
      return typeof value === "string" && CANVAS_BLEND_MODES.includes(value as CanvasBlendMode)
        ? { ...node, blendMode: value as CanvasBlendMode }
        : node;

    case "filtersReset": {
      const { filters: _filters, ...rest } = node;

      return rest;
    }

    case "filterValue": {
      const key = options.filterName;
      if (!key || !Object.prototype.hasOwnProperty.call(CANVAS_FILTERS, key) || !numeric)
        return node;
      const limits = CANVAS_FILTERS[key];

      return value >= limits.min && value <= limits.max
        ? { ...node, filters: { ...node.filters, [key]: value } }
        : node;
    }

    case "gradientType": {
      if (!frame && node.kind !== "rectangle") return node;

      if (value === "solid") {
        const { gradient: _gradient, ...rest } = node;

        return rest;
      }

      if (value !== "linear" && value !== "radial") return node;

      return {
        ...node,
        gradient: {
          ...node.gradient,
          type: value,
          angle: node.gradient?.angle ?? 90,
          stops: node.gradient?.stops ?? [
            { offset: 0, color: node.fill ?? "#ffffff" },
            { offset: 1, color: "#000000" },
          ],
        },
      };
    }

    case "gradientInterpolation":
      return node.gradient && (value === "srgb" || value === "oklab")
        ? { ...node, gradient: { ...node.gradient, interpolation: value } }
        : node;
    case "gradientBackground":
      return node.gradient && color
        ? { ...node, gradient: { ...node.gradient, background: value } }
        : node;
    case "gradientAngle":
      return numeric && node.gradient
        ? { ...node, gradient: { ...node.gradient, angle: ((value % 360) + 360) % 360 } }
        : node;
    case "gradientStopColor":
    case "gradientStopOffset":
    case "gradientStopAdd":

    case "gradientStopRemove": {
      if (!node.gradient) return node;
      const stops = node.gradient.stops.map((stop) => ({ ...stop }));
      const index = options.gradientStop ?? 0;
      if (!Number.isInteger(index) || !stops[index]) return node;

      if (property === "gradientStopAdd") {
        if (stops.length >= 16) return node;
        let at = 0;
        for (let i = 1; i < stops.length - 1; i++)
          if (stops[i + 1].offset - stops[i].offset > stops[at + 1].offset - stops[at].offset)
            at = i;
        stops.splice(at + 1, 0, {
          offset: (stops[at].offset + stops[at + 1].offset) / 2,
          color: stops[at].color,
        });
      } else if (property === "gradientStopRemove") {
        if (stops.length <= 2) return node;
        stops.splice(index, 1);
      } else if (property === "gradientStopColor") {
        if (!color) return node;
        stops[index].color = value;
      } else {
        if (!numeric || value < 0 || value > 1) return node;
        stops[index].offset = Math.max(
          stops[index - 1]?.offset ?? 0,
          Math.min(stops[index + 1]?.offset ?? 1, value),
        );
      }

      return { ...node, gradient: { ...node.gradient, stops } };
    }

    case "borderRemove": {
      const { borderWidth: _width, borderColor: _color, ...rest } = node;

      return rest;
    }

    case "borderWidth":
      return numeric && value >= 0 ? { ...node, borderWidth: value } : node;
    case "borderColor":
      return color ? { ...node, borderColor: value } : node;
    case "fontStyle":
      return node.kind === "text" && (value === "normal" || value === "italic")
        ? { ...node, fontStyle: value as CanvasText["fontStyle"] }
        : node;
    case "textDecoration":
      return node.kind === "text" &&
        (value === "none" || value === "underline" || value === "line-through")
        ? { ...node, textDecoration: value as CanvasText["textDecoration"] }
        : node;
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

        return {
          ...withoutLayout,
          ...(node.widthSizing === "hug" ? { widthSizing: "fixed" } : {}),
          ...(node.heightSizing === "hug" ? { heightSizing: "fixed" } : {}),
        };
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

    case "layoutPosition": {
      if (!frame || !node.layout || typeof value !== "string") return node;
      const [x, y] = value.split(":");
      if (!/^(start|center|end):(start|center|end)$/.test(value)) return node;
      const horizontal = node.layout.direction === "row";

      return {
        ...node,
        layout: {
          ...node.layout,
          align: (horizontal ? y : x) as "start" | "center" | "end",
          justify: (horizontal ? x : y) as "start" | "center" | "end",
        },
      };
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
  const source = frameSource(nodes);
  const rotatedMultiple = selected.length > 1 && selected.some((node) => hasRotation(source, node));

  const bounds = rotatedMultiple
    ? pointBounds(
        selected.flatMap((node) => {
          const b = worldBounds(source, node);

          return [
            { x: b.x, y: b.y },
            { x: b.x + b.width, y: b.y + b.height },
          ];
        }),
      )
    : selectionBounds(nodes, roots)!;

  const single = selected.length === 1 ? selected[0] : undefined;

  if (property === "widthSizing" || property === "heightSizing") {
    if (!isCanvasSizing(value)) return [];

    return selected.flatMap((node) => {
      if (
        value === "hug" &&
        ((node.kind && node.kind !== "frame") || !("layout" in node && node.layout))
      )
        return [];
      const parent = node.parentId ? byId.get(node.parentId) : undefined;
      if (
        value === "fill" &&
        (node.kind === "group" ||
          !parent ||
          (parent.kind && parent.kind !== "frame") ||
          !parent.layout)
      )
        return [];

      return [{ ...node, [property]: value }];
    });
  }

  if (property === "x" || property === "y") {
    if (typeof value !== "number" || !Number.isFinite(value)) return [];
    const parent = single?.parentId ? byId.get(single.parentId) : undefined;
    const next = value + (parent?.[property] ?? 0);

    return (rotatedMultiple ? moveSelectionWorld : moveSelection)(nodes, roots, {
      x: property === "x" ? next - bounds.x : 0,
      y: property === "y" ? next - bounds.y : 0,
    });
  }

  if (property === "width" || property === "height") {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return [];
    const minimum = single && (!single.kind || single.kind === "frame") ? 40 : 1;
    const dimension = Math.max(minimum, value);
    const next = { ...bounds, [property]: dimension };

    if (options.preserveAspect || rotatedMultiple) {
      const other = property === "width" ? "height" : "width";
      const scale = Math.max(dimension / bounds[property], minimum / bounds[other]);
      next.width = bounds.width * scale;
      next.height = bounds.height * scale;
    }

    const updates = rotatedMultiple
      ? scaleSelectionWorld(nodes, roots, bounds, next)
      : resizeSelection(nodes, roots, bounds, next);

    if (single?.kind === "text" && property === "width" && !options.preserveAspect) {
      for (let index = 0; index < updates.length; index++) {
        const node = updates[index];
        if (node.kind === "text") updates[index] = { ...node, height: measureText(node) };
      }
    }

    // oxlint-disable-next-line oxc/no-map-spread -- Geometry updates are immutable snapshots.
    return updates.map((node) => {
      // Resizing rotated frames also moves descendants to compensate for the
      // changed rotation center. Those descendants retain their sizing modes.
      if (!roots.includes(node.id)) return node;

      return {
        ...node,
        ...((property === "width" || options.preserveAspect || rotatedMultiple) &&
        node.widthSizing !== undefined
          ? { widthSizing: "fixed" as const }
          : {}),
        ...((property === "height" || options.preserveAspect || rotatedMultiple) &&
        node.heightSizing !== undefined
          ? { heightSizing: "fixed" as const }
          : {}),
      };
    });
  }

  const reflow = [
    "fontFamily",
    "fontWeight",
    "fontStyle",
    "fontSize",
    "lineHeight",
    "letterSpacing",
  ].includes(property);

  return selected.flatMap((node) => {
    const updated = styleChange(node, property, value, options);
    if (updated === node) return [];

    return [
      reflow && updated.kind === "text" ? { ...updated, height: measureText(updated) } : updated,
    ];
  });
}
