/* oxlint-disable oxc/no-map-spread -- Vector edits return immutable document snapshots. */
import polygonClipping, { type MultiPolygon, type Ring } from "polygon-clipping";

import type { CanvasFrame, CanvasSvg } from "./canvas-document";
import type { FrameRect, Point } from "./canvas-geometry";
import type { CanvasOperationPlan } from "./canvas-operations";
import { isPaintColor } from "./canvas-paint";
import {
  IDENTITY,
  frameSource,
  inverseMatrix,
  multiplyMatrix,
  transformPoint,
  worldTransform,
  type CanvasMatrix,
} from "./canvas-transform";

export type CanvasVectorAnchor = Readonly<Point & { in?: Point; out?: Point }>;
export type CanvasVectorContour = Readonly<{
  closed: boolean;
  anchors: readonly CanvasVectorAnchor[];
}>;
export type CanvasVectorData = Readonly<{
  viewWidth: number;
  viewHeight: number;
  contours: readonly CanvasVectorContour[];
  fill: string;
  stroke: string;
  strokeWidth: number;
  fillRule?: "evenodd" | "nonzero";
}>;
export type EditableCanvasSvg = CanvasSvg & { readonly vector: CanvasVectorData };
export type CanvasVectorBoolean = "union" | "subtract" | "intersect" | "exclude";
/** Boolean operations flatten Béziers to at most a quarter of a document pixel. */
export const VECTOR_BOOLEAN_TOLERANCE = 0.25;
const { difference, intersection, union, xor } = polygonClipping;

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 10_000_000;

const isVectorPoint = (value: unknown): value is Point =>
  !!value && typeof value === "object" && finite((value as Point).x) && finite((value as Point).y);

const paint = (value: unknown) => value === "none" || isPaintColor(value);

export function isCanvasVector(value: unknown): value is CanvasVectorData {
  if (!value || typeof value !== "object") return false;
  const v = value as CanvasVectorData;
  let anchors = 0;

  return (
    finite(v.viewWidth) &&
    v.viewWidth > 0 &&
    finite(v.viewHeight) &&
    v.viewHeight > 0 &&
    paint(v.fill) &&
    paint(v.stroke) &&
    finite(v.strokeWidth) &&
    v.strokeWidth >= 0 &&
    (v.fillRule === undefined || v.fillRule === "evenodd" || v.fillRule === "nonzero") &&
    Array.isArray(v.contours) &&
    v.contours.length <= 1000 &&
    v.contours.every((contour) => {
      if (
        !contour ||
        typeof contour.closed !== "boolean" ||
        !Array.isArray(contour.anchors) ||
        contour.anchors.length < (contour.closed ? 3 : 1)
      )
        return false;
      anchors += contour.anchors.length;

      return (
        anchors <= 20000 &&
        contour.anchors.every(
          (anchor: CanvasVectorAnchor) =>
            isVectorPoint(anchor) &&
            (anchor.in === undefined || isVectorPoint(anchor.in)) &&
            (anchor.out === undefined || isVectorPoint(anchor.out)),
        )
      );
    })
  );
}

const coordinate = (value: number) => String(Number(value.toFixed(6)));
const pair = (value: Point) => `${coordinate(value.x)} ${coordinate(value.y)}`;

export function canvasVectorPath(contour: CanvasVectorContour): string {
  const first = contour.anchors[0];
  if (!first) return "";
  let path = `M${pair(first)}`;
  const count = contour.anchors.length;

  for (let index = 1; index < count + Number(contour.closed); index++) {
    const before = contour.anchors[index - 1];
    const after = contour.anchors[index % count];
    if (before.out || after.in)
      path += `C${pair(before.out ?? before)} ${pair(after.in ?? after)} ${pair(after)}`;
    else if (index < count) path += `L${pair(after)}`;
  }

  return path + (contour.closed ? "Z" : "");
}

/** All attributes come from validated numeric geometry or hex colors; no markup is accepted. */
export function canvasVectorSvg(vector: CanvasVectorData): string {
  if (!isCanvasVector(vector)) throw new Error("Invalid editable vector geometry.");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${coordinate(vector.viewWidth)}" height="${coordinate(vector.viewHeight)}" viewBox="0 0 ${coordinate(vector.viewWidth)} ${coordinate(vector.viewHeight)}"><path d="${vector.contours.map(canvasVectorPath).join(" ")}" fill="${vector.fill}" fill-rule="${vector.fillRule ?? "evenodd"}" stroke="${vector.stroke}" stroke-width="${coordinate(vector.strokeWidth)}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

export function canvasVectorSource(vector: CanvasVectorData) {
  return `data:image/svg+xml;base64,${btoa(canvasVectorSvg(vector))}`;
}

export function updateCanvasVector(node: CanvasSvg, vector: CanvasVectorData): EditableCanvasSvg {
  return { ...node, vector, src: canvasVectorSource(vector) };
}

/** Expand the view box around moved anchors while preserving every existing point's world position. */
export function fitCanvasVectorNode(node: CanvasSvg, vector: CanvasVectorData): EditableCanvasSvg {
  const points = vector.contours.flatMap((contour) =>
    contour.anchors.flatMap((anchor) => [
      anchor,
      ...(anchor.in ? [anchor.in] : []),
      ...(anchor.out ? [anchor.out] : []),
    ]),
  );

  const pad = vector.stroke === "none" ? 0 : vector.strokeWidth / 2;
  const left = Math.min(0, ...points.map((point) => point.x - pad));
  const top = Math.min(0, ...points.map((point) => point.y - pad));
  const right = Math.max(vector.viewWidth, ...points.map((point) => point.x + pad));
  const bottom = Math.max(vector.viewHeight, ...points.map((point) => point.y + pad));

  const sx = node.width / vector.viewWidth,
    sy = node.height / vector.viewHeight;

  const width = (right - left) * sx,
    height = (bottom - top) * sy;

  const dx = left * sx + (width - node.width) / 2,
    dy = top * sy + (height - node.height) / 2;

  const radians = ((node.rotation ?? 0) * Math.PI) / 180;
  const x = node.x + (node.width - width) / 2 + dx * Math.cos(radians) - dy * Math.sin(radians);
  const y = node.y + (node.height - height) / 2 + dx * Math.sin(radians) + dy * Math.cos(radians);

  return updateCanvasVector(
    { ...node, x, y, width, height },
    {
      ...vector,
      viewWidth: right - left,
      viewHeight: bottom - top,
      contours: vector.contours.map((contour) =>
        transformContour(contour, { ...IDENTITY, e: -left, f: -top }),
      ),
    },
  );
}

export function createCanvasVectorNode(
  id: string,
  name: string,
  vector: CanvasVectorData,
  rect: FrameRect,
  parentId?: string,
): EditableCanvasSvg {
  return updateCanvasVector({ id, name, kind: "svg", ...rect, parentId, src: "" }, vector);
}

function editContour(
  vector: CanvasVectorData,
  contourIndex: number,
  edit: (contour: CanvasVectorContour) => CanvasVectorContour,
): CanvasVectorData {
  if (!vector.contours[contourIndex]) throw new Error("Vector contour not found.");

  const result = {
    ...vector,
    contours: vector.contours.map((contour, index) =>
      index === contourIndex ? edit(contour) : contour,
    ),
  };

  if (!isCanvasVector(result)) throw new Error("Invalid vector edit.");

  return result;
}

export function moveCanvasVectorAnchor(
  vector: CanvasVectorData,
  contourIndex: number,
  anchorIndex: number,
  position: Point,
  handle?: "in" | "out",
  mirror = false,
): CanvasVectorData {
  return editContour(vector, contourIndex, (contour) => {
    if (!contour.anchors[anchorIndex]) throw new Error("Vector anchor not found.");

    return {
      ...contour,
      anchors: contour.anchors.map((anchor, index) => {
        if (index !== anchorIndex) return anchor;
        if (handle)
          return {
            ...anchor,
            [handle]: position,
            ...(mirror
              ? {
                  [handle === "in" ? "out" : "in"]: {
                    x: anchor.x * 2 - position.x,
                    y: anchor.y * 2 - position.y,
                  },
                }
              : {}),
          };
        const dx = position.x - anchor.x;
        const dy = position.y - anchor.y;

        return {
          ...anchor,
          ...position,
          ...(anchor.in ? { in: { x: anchor.in.x + dx, y: anchor.in.y + dy } } : {}),
          ...(anchor.out ? { out: { x: anchor.out.x + dx, y: anchor.out.y + dy } } : {}),
        };
      }),
    };
  });
}

const lerp = (a: Point, b: Point, t: number): Point => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});

/** Split a cubic with de Casteljau so inserting an anchor does not change its shape. */
export function addCanvasVectorAnchor(
  vector: CanvasVectorData,
  contourIndex: number,
  afterIndex: number,
  t = 0.5,
): CanvasVectorData {
  if (!(t > 0 && t < 1)) throw new Error("Anchor position must be inside a segment.");

  return editContour(vector, contourIndex, (contour) => {
    const before = contour.anchors[afterIndex];
    const nextIndex = (afterIndex + 1) % contour.anchors.length;
    const after = contour.anchors[nextIndex];
    if (!before || !after || (!contour.closed && nextIndex === 0))
      throw new Error("Choose a path segment.");
    const anchors = [...contour.anchors];
    let anchor: CanvasVectorAnchor;
    if (before.out || after.in) {
      const a = lerp(before, before.out ?? before, t);
      const b = lerp(before.out ?? before, after.in ?? after, t);
      const c = lerp(after.in ?? after, after, t);
      const d = lerp(a, b, t);
      const e = lerp(b, c, t);
      anchor = { ...lerp(d, e, t), in: d, out: e };
      anchors[afterIndex] = { ...before, out: a };
      anchors[nextIndex] = { ...after, in: c };
    } else anchor = lerp(before, after, t);
    anchors.splice(afterIndex + 1, 0, anchor);

    return { ...contour, anchors };
  });
}

export function removeCanvasVectorAnchor(
  vector: CanvasVectorData,
  contourIndex: number,
  index: number,
): CanvasVectorData {
  return editContour(vector, contourIndex, (contour) => {
    if (index < 0 || index >= contour.anchors.length) throw new Error("Vector anchor not found.");
    if (contour.anchors.length <= (contour.closed ? 3 : 1))
      throw new Error("The path needs its remaining anchors.");

    return { ...contour, anchors: contour.anchors.filter((_, anchor) => anchor !== index) };
  });
}

export function setCanvasVectorAnchorSmooth(
  vector: CanvasVectorData,
  contourIndex: number,
  index: number,
  smooth: boolean,
): CanvasVectorData {
  return editContour(vector, contourIndex, (contour) => {
    const anchor = contour.anchors[index];
    if (!anchor) throw new Error("Vector anchor not found.");
    const previous = contour.anchors[(index + contour.anchors.length - 1) % contour.anchors.length];
    const next = contour.anchors[(index + 1) % contour.anchors.length];
    const dx = (next.x - previous.x) / 6;
    const dy = (next.y - previous.y) / 6;

    return {
      ...contour,
      anchors: contour.anchors.map((point, i) =>
        i !== index
          ? point
          : smooth
            ? {
                ...anchor,
                in: { x: anchor.x - dx, y: anchor.y - dy },
                out: { x: anchor.x + dx, y: anchor.y + dy },
              }
            : { x: anchor.x, y: anchor.y },
      ),
    };
  });
}

export function setCanvasVectorClosed(
  vector: CanvasVectorData,
  contourIndex: number,
  closed: boolean,
): CanvasVectorData {
  return editContour(vector, contourIndex, (contour) => ({ ...contour, closed }));
}

function distanceToLine(p: Point, a: Point, b: Point) {
  const length = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;

  const t =
    length === 0
      ? 0
      : Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / length));

  return Math.hypot(p.x - a.x - t * (b.x - a.x), p.y - a.y - t * (b.y - a.y));
}

function flattenCubic(
  a: Point,
  b: Point,
  c: Point,
  d: Point,
  tolerance: number,
  output: Point[],
  depth = 0,
) {
  if (depth >= 18 || Math.max(distanceToLine(b, a, d), distanceToLine(c, a, d)) <= tolerance) {
    output.push(d);

    return;
  }

  const ab = lerp(a, b, 0.5),
    bc = lerp(b, c, 0.5),
    cd = lerp(c, d, 0.5);

  const abc = lerp(ab, bc, 0.5),
    bcd = lerp(bc, cd, 0.5),
    middle = lerp(abc, bcd, 0.5);

  flattenCubic(a, ab, abc, middle, tolerance, output, depth + 1);
  flattenCubic(middle, bcd, cd, d, tolerance, output, depth + 1);
}

export function flattenCanvasVectorContour(
  contour: CanvasVectorContour,
  matrix: CanvasMatrix = IDENTITY,
  tolerance = VECTOR_BOOLEAN_TOLERANCE,
): Point[] {
  if (!(tolerance > 0)) throw new Error("Vector tolerance must be positive.");
  const points = contour.anchors;
  if (!points.length) return [];
  const output = [transformPoint(matrix, points[0])];

  for (let index = 1; index < points.length + Number(contour.closed); index++) {
    const before = points[index - 1],
      after = points[index % points.length];

    if (before.out || after.in)
      flattenCubic(
        transformPoint(matrix, before),
        transformPoint(matrix, before.out ?? before),
        transformPoint(matrix, after.in ?? after),
        transformPoint(matrix, after),
        tolerance,
        output,
      );
    else output.push(transformPoint(matrix, after));
  }

  return output;
}

function roundedBox(
  width: number,
  height: number,
  radiusX = 0,
  radiusY = radiusX,
): CanvasVectorContour {
  const x = Math.min(width / 2, radiusX),
    y = Math.min(height / 2, radiusY);

  if (x <= 0 || y <= 0)
    return {
      closed: true,
      anchors: [
        { x: 0, y: 0 },
        { x: width, y: 0 },
        { x: width, y: height },
        { x: 0, y: height },
      ],
    };
  const k = 0.5522847498307936;

  return {
    closed: true,
    anchors: [
      { x, y: 0, in: { x: x * (1 - k), y: 0 } },
      { x: width - x, y: 0, out: { x: width - x * (1 - k), y: 0 } },
      { x: width, y, in: { x: width, y: y * (1 - k) } },
      { x: width, y: height - y, out: { x: width, y: height - y * (1 - k) } },
      { x: width - x, y: height, in: { x: width - x * (1 - k), y: height } },
      { x, y: height, out: { x: x * (1 - k), y: height } },
      { x: 0, y: height - y, in: { x: 0, y: height - y * (1 - k) } },
      { x: 0, y, out: { x: 0, y: y * (1 - k) } },
    ],
  };
}

function transformContour(contour: CanvasVectorContour, matrix: CanvasMatrix): CanvasVectorContour {
  return {
    ...contour,
    anchors: contour.anchors.map((anchor) => ({
      ...transformPoint(matrix, anchor),
      ...(anchor.in ? { in: transformPoint(matrix, anchor.in) } : {}),
      ...(anchor.out ? { out: transformPoint(matrix, anchor.out) } : {}),
    })),
  };
}

/** Parse the common editable path commands; reject unsupported arcs instead of changing their shape. */
export function parseCanvasVectorPath(data: string): CanvasVectorContour[] {
  const tokens = data.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g) ?? [];
  if (data.replace(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?|[\s,]/g, ""))
    throw new Error("Invalid SVG path.");

  const contours: {
    closed: boolean;
    anchors: { x: number; y: number; in?: Point; out?: Point }[];
  }[] = [];

  let cursor = 0,
    command = "",
    previousCommand = "";

  let current: Point = { x: 0, y: 0 },
    quadratic: Point | undefined;

  let active: (typeof contours)[number] | undefined;

  const number = () => {
    const value = Number(tokens[cursor++]);
    if (!Number.isFinite(value)) throw new Error("Invalid SVG path coordinate.");

    return value;
  };

  while (cursor < tokens.length) {
    if (/^[a-zA-Z]$/.test(tokens[cursor])) command = tokens[cursor++];

    const name = command.toUpperCase(),
      relative = command !== name;

    const next = (): Point => ({
      x: number() + (relative ? current.x : 0),
      y: number() + (relative ? current.y : 0),
    });

    if (name === "M") {
      current = next();
      active = { closed: false, anchors: [{ ...current }] };
      contours.push(active);
      command = relative ? "l" : "L";
    } else if (name === "Z") {
      if (!active) throw new Error("SVG path must start with a move.");
      active.closed = true;
      current = active.anchors[0];
      command = "";
    } else {
      if (!active) throw new Error("SVG path must start with a move.");
      const before = active.anchors[active.anchors.length - 1];
      let anchor: { x: number; y: number; in?: Point };
      if (name === "L") anchor = next();
      else if (name === "H") anchor = { x: number() + (relative ? current.x : 0), y: current.y };
      else if (name === "V") anchor = { x: current.x, y: number() + (relative ? current.y : 0) };
      else if (name === "C" || name === "S") {
        before.out =
          name === "C"
            ? next()
            : (previousCommand === "C" || previousCommand === "S") && before.in
              ? { x: 2 * current.x - before.in.x, y: 2 * current.y - before.in.y }
              : { ...current };
        const incoming = next();
        anchor = { ...next(), in: incoming };
      } else if (name === "Q" || name === "T") {
        const control =
          name === "Q"
            ? next()
            : (previousCommand === "Q" || previousCommand === "T") && quadratic
              ? { x: 2 * current.x - quadratic.x, y: 2 * current.y - quadratic.y }
              : { ...current };

        anchor = next();
        before.out = lerp(current, control, 2 / 3);
        anchor.in = lerp(anchor, control, 2 / 3);
        quadratic = control;
      } else
        throw new Error(
          `SVG path command ${name || "(missing)"} cannot be converted to editable anchors.`,
        );
      active.anchors.push(anchor);
      current = anchor;
    }

    previousCommand = name;
    if (name !== "Q" && name !== "T") quadratic = undefined;
  }

  return contours.map((contour) => {
    const anchors = [...contour.anchors];

    const first = anchors[0],
      last = anchors[anchors.length - 1];

    if (contour.closed && anchors.length > 1 && first.x === last.x && first.y === last.y) {
      anchors[0] = { ...first, ...(last.in ? { in: last.in } : {}) };
      anchors.pop();
    }

    return { ...contour, anchors };
  });
}

function svgTransform(source: string): CanvasMatrix {
  let result = IDENTITY;
  const regex = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(source))) {
    const values = match[2]
      .trim()
      .split(/[\s,]+/)
      .map(Number);

    if (!values.every(Number.isFinite)) throw new Error("Invalid SVG transform.");
    const [a = 0, b = a, c = 0, d = 0, e = 0, f = 0] = values;
    let next: CanvasMatrix;
    if (match[1] === "matrix" && values.length === 6) next = { a, b, c, d, e, f };
    else if (match[1] === "translate") next = { ...IDENTITY, e: a, f: values[1] ?? 0 };
    else if (match[1] === "scale") next = { ...IDENTITY, a, d: b };
    else if (match[1] === "rotate") {
      const angle = (a * Math.PI) / 180,
        cosine = Math.cos(angle),
        sine = Math.sin(angle);

      const x = values[1] ?? 0,
        y = values[2] ?? 0;

      next = {
        a: cosine,
        b: sine,
        c: -sine,
        d: cosine,
        e: x - cosine * x + sine * y,
        f: y - sine * x - cosine * y,
      };
    } else if (match[1] === "skewX") next = { ...IDENTITY, c: Math.tan((a * Math.PI) / 180) };
    else if (match[1] === "skewY") next = { ...IDENTITY, b: Math.tan((a * Math.PI) / 180) };
    else throw new Error("Unsupported SVG transform.");
    result = multiplyMatrix(result, next);
  }

  if (source.replace(regex, "").trim()) throw new Error("Unsupported SVG transform.");

  return result;
}

/** Convert simple uniformly painted SVG shapes; keep unsupported SVGs intact. */
export function readEditableCanvasSvg(source: string): CanvasVectorData {
  const parsed = new DOMParser().parseFromString(source, "image/svg+xml");
  if (parsed.querySelector("parsererror")) throw new Error("Invalid SVG.");
  const root = parsed.documentElement;
  if (root.localName !== "svg") throw new Error("Choose an SVG document.");

  const view = (root.getAttribute("viewBox") ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);

  if (
    root.hasAttribute("viewBox") &&
    (view.length !== 4 || !view.every(Number.isFinite) || view[2] <= 0 || view[3] <= 0)
  )
    throw new Error("Invalid SVG viewBox.");

  const dimension = (name: string, fallback?: number) => {
    const value = root.getAttribute(name);

    return value && /^\d*\.?\d+(?:px)?$/.test(value) ? parseFloat(value) : fallback;
  };

  const width = dimension("width", view[2])!,
    height = dimension("height", view[3])!;

  if (!finite(width) || !finite(height) || width <= 0 || height <= 0)
    throw new Error("SVG dimensions must be finite and positive.");

  let viewport = IDENTITY;

  if (root.hasAttribute("viewBox")) {
    const aspect = root.getAttribute("preserveAspectRatio")?.trim() || "xMidYMid meet";

    const sx = width / view[2],
      sy = height / view[3];

    if (aspect === "none")
      viewport = { a: sx, b: 0, c: 0, d: sy, e: -view[0] * sx, f: -view[1] * sy };
    else {
      const match = /^x(Min|Mid|Max)Y(Min|Mid|Max)(?:\s+(meet|slice))?$/.exec(aspect);
      if (!match) throw new Error("Unsupported SVG aspect ratio.");
      const scale = match[3] === "slice" ? Math.max(sx, sy) : Math.min(sx, sy);
      const align = { Min: 0, Mid: 0.5, Max: 1 };
      viewport = {
        a: scale,
        b: 0,
        c: 0,
        d: scale,
        e: -view[0] * scale + (width - view[2] * scale) * align[match[1] as keyof typeof align],
        f: -view[1] * scale + (height - view[3] * scale) * align[match[2] as keyof typeof align],
      };
    }
  }

  const contours: CanvasVectorContour[] = [];

  let appearance:
    | { fill: string; stroke: string; strokeWidth: number; fillRule: "evenodd" | "nonzero" }
    | undefined;

  const color = (value: string) => {
    if (paint(value)) return value;
    const ctx = document.createElement("canvas").getContext("2d")!;
    ctx.fillStyle = "#010203";
    ctx.fillStyle = value;
    if (!isPaintColor(ctx.fillStyle) || (ctx.fillStyle === "#010203" && value !== "#010203"))
      throw new Error("This SVG paint cannot be edited as one path.");

    return ctx.fillStyle;
  };

  const visit = (element: Element, parent: CanvasMatrix, inherited: Record<string, string>) => {
    const style = { ...inherited };

    const paintProperties = [
      "fill",
      "stroke",
      "stroke-width",
      "fill-rule",
      "stroke-linecap",
      "stroke-linejoin",
    ];

    for (const property of paintProperties)
      if (element.hasAttribute(property)) style[property] = element.getAttribute(property)!;

    for (const item of (element.getAttribute("style") ?? "").split(";")) {
      const [key, value] = item.split(":").map((part) => part.trim());
      if (!key) continue;
      if (!paintProperties.includes(key))
        throw new Error("This SVG style cannot be converted without changing its appearance.");
      style[key] = value;
    }

    if (
      [
        "filter",
        "mask",
        "clip-path",
        "opacity",
        "fill-opacity",
        "stroke-opacity",
        "vector-effect",
        "stroke-dasharray",
        "stroke-dashoffset",
        "marker-start",
        "marker-mid",
        "marker-end",
      ].some((attribute) => element.hasAttribute(attribute))
    )
      throw new Error("SVG effects must be removed before editing anchors.");
    const matrix = multiplyMatrix(parent, svgTransform(element.getAttribute("transform") ?? ""));
    const name = element.localName;
    if (name === "svg" && element !== root)
      throw new Error("Nested SVG viewports cannot be converted to one editable path.");

    if (["svg", "g"].includes(name)) {
      for (const child of element.children) visit(child, matrix, style);

      return;
    }

    if (["title", "desc"].includes(name)) return;

    const numeric = (attribute: string, fallback = 0) =>
      element.hasAttribute(attribute) ? Number(element.getAttribute(attribute)) : fallback;

    let shape: CanvasVectorContour[];
    if (name === "path") shape = parseCanvasVectorPath(element.getAttribute("d") ?? "");
    else if (name === "rect")
      shape = [
        transformContour(
          roundedBox(
            numeric("width"),
            numeric("height"),
            numeric("rx", numeric("ry")),
            numeric("ry", numeric("rx")),
          ),
          { ...IDENTITY, e: numeric("x"), f: numeric("y") },
        ),
      ];
    else if (name === "circle" || name === "ellipse") {
      const rx = numeric(name === "circle" ? "r" : "rx"),
        ry = numeric(name === "circle" ? "r" : "ry");

      shape = [
        transformContour(roundedBox(rx * 2, ry * 2, rx, ry), {
          ...IDENTITY,
          e: numeric("cx") - rx,
          f: numeric("cy") - ry,
        }),
      ];
    } else if (name === "polygon" || name === "polyline") {
      const values = (element.getAttribute("points") ?? "")
        .trim()
        .split(/[\s,]+/)
        .map(Number);

      if (values.length % 2) throw new Error("Invalid SVG points.");
      shape = [
        {
          closed: name === "polygon",
          anchors: values.flatMap((x, index) => (index % 2 ? [] : [{ x, y: values[index + 1] }])),
        },
      ];
    } else if (name === "line")
      shape = [
        {
          closed: false,
          anchors: [
            { x: numeric("x1"), y: numeric("y1") },
            { x: numeric("x2"), y: numeric("y2") },
          ],
        },
      ];
    else throw new Error(`SVG ${name} cannot be converted to editable anchors.`);

    const current = {
      fill: color(style.fill ?? "#000000"),
      stroke: color(style.stroke ?? "none"),
      strokeWidth: Number(style["stroke-width"] ?? 1),
      fillRule: (style["fill-rule"] ?? "nonzero") as "nonzero" | "evenodd",
    };

    if (current.stroke !== "none" && current.strokeWidth > 0) {
      const sx = Math.hypot(matrix.a, matrix.b),
        sy = Math.hypot(matrix.c, matrix.d);

      if (
        Math.abs(sx - sy) > Math.max(sx, sy) * 1e-8 ||
        Math.abs(matrix.a * matrix.c + matrix.b * matrix.d) > Math.max(sx * sy, 1) * 1e-8
      )
        throw new Error(
          "Skewed or unevenly scaled SVG strokes cannot be converted without changing their appearance.",
        );

      const smooth =
        name === "circle" ||
        name === "ellipse" ||
        (name === "rect" && numeric("rx", numeric("ry")) > 0 && numeric("ry", numeric("rx")) > 0);

      if (
        (!smooth && (style["stroke-linejoin"] ?? "miter") !== "round") ||
        (shape.some((contour) => !contour.closed) &&
          (style["stroke-linecap"] ?? "butt") !== "round")
      )
        throw new Error("Use round SVG stroke joins and caps before editing this path.");
      current.strokeWidth *= sx;
    }

    if (appearance && JSON.stringify(current) !== JSON.stringify(appearance))
      throw new Error("Select an SVG with one fill and stroke to edit its anchors.");
    appearance = current;
    contours.push(...shape.map((contour) => transformContour(contour, matrix)));
  };

  visit(root, viewport, {});

  const result: CanvasVectorData = {
    viewWidth: width,
    viewHeight: height,
    contours,
    ...(appearance ?? { fill: "#000000", stroke: "none", strokeWidth: 0, fillRule: "evenodd" }),
  };

  if (!isCanvasVector(result)) throw new Error("SVG geometry could not be converted.");

  return result;
}

export function convertCanvasNodeToVector(node: CanvasFrame): EditableCanvasSvg {
  let vector: CanvasVectorData;
  if (node.kind === "svg") {
    const existing = (node as EditableCanvasSvg).vector;
    if (existing) return updateCanvasVector(node, existing);
    vector = readEditableCanvasSvg(atob(node.src.split(",")[1]));
  } else if (node.kind === "rectangle") {
    if (node.gradient)
      throw new Error("Gradient rectangles cannot be converted without losing their paint.");
    vector = {
      viewWidth: node.width,
      viewHeight: node.height,
      contours: [roundedBox(node.width, node.height, node.cornerRadius)],
      fill: node.fill,
      stroke: "none",
      strokeWidth: 0,
    };
  } else if (node.kind === "pen") {
    const first = node.points[0],
      last = node.points[node.points.length - 1];

    const closed = node.points.length > 3 && first.x === last.x && first.y === last.y;
    vector = {
      viewWidth: node.pathWidth,
      viewHeight: node.pathHeight,
      contours: [{ closed, anchors: closed ? node.points.slice(0, -1) : node.points }],
      fill: "none",
      stroke: node.stroke,
      strokeWidth: node.strokeWidth,
    };
  } else throw new Error("Choose a rectangle, pen stroke, or simple SVG to edit anchors.");
  const base = { ...node } as Record<string, unknown>;
  for (const key of [
    "kind",
    "fill",
    "gradient",
    "points",
    "stroke",
    "strokeWidth",
    "pathWidth",
    "pathHeight",
    "src",
    "vector",
  ])
    delete base[key];

  const converted = updateCanvasVector({ ...base, kind: "svg", src: "" } as CanvasSvg, vector);

  return node.kind === "pen" ? fitCanvasVectorNode(converted, vector) : converted;
}

function ringArea(ring: Ring) {
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    area += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];

  return area / 2;
}

function inside(p: readonly number[], ring: Ring) {
  let contained = false;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];

    if (
      a[1] > p[1] !== b[1] > p[1] &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      contained = !contained;
  }

  return contained;
}

export function canvasVectorPolygons(
  vector: CanvasVectorData,
  matrix: CanvasMatrix = IDENTITY,
): MultiPolygon {
  if (vector.contours.some((contour) => !contour.closed))
    throw new Error("Close every path before combining shapes.");

  const rings: Ring[] = vector.contours.map((contour) =>
    flattenCanvasVectorContour(contour, matrix).map((point) => [point.x, point.y]),
  );

  const areas = rings.map(ringArea);

  const parents = rings.map((ring, index) => {
    let parent = -1;

    for (let other = 0; other < rings.length; other++) {
      if (
        other === index ||
        Math.abs(areas[other]) <= Math.abs(areas[index]) ||
        !inside(ring[0], rings[other])
      )
        continue;
      if (parent === -1 || Math.abs(areas[other]) < Math.abs(areas[parent])) parent = other;
    }

    return parent;
  });

  const filled = rings.map((_, index) => {
    let level = 0,
      winding = 0;

    for (let current = index; current !== -1; current = parents[current]) {
      level++;
      winding += Math.sign(areas[current]);
    }

    return vector.fillRule === "nonzero" ? winding !== 0 : level % 2 === 1;
  });

  const polygons = new Map<number, Ring[]>();
  for (let index = 0; index < rings.length; index++)
    if (filled[index] && (parents[index] === -1 || !filled[parents[index]]))
      polygons.set(index, [rings[index]]);

  for (let index = 0; index < rings.length; index++) {
    if (filled[index] || parents[index] === -1 || !filled[parents[index]]) continue;
    let owner = parents[index];
    while (owner !== -1 && !polygons.has(owner)) owner = parents[owner];
    if (owner !== -1) polygons.get(owner)!.push(rings[index]);
  }

  return [...polygons.values()];
}

export function booleanCanvasVectors(
  nodes: readonly CanvasFrame[],
  ids: readonly string[],
  operation: CanvasVectorBoolean,
  allocate: () => string = () => crypto.randomUUID(),
): CanvasOperationPlan {
  const chosen = nodes.filter((node) => ids.includes(node.id));
  if (chosen.length < 2) throw new Error("Select at least two closed shapes.");
  const source = frameSource(nodes);
  const vectors = chosen.map(convertCanvasNodeToVector);

  const shapes = vectors.map((node) =>
    canvasVectorPolygons(
      node.vector,
      multiplyMatrix(worldTransform(source, node), {
        ...IDENTITY,
        a: node.width / node.vector.viewWidth,
        d: node.height / node.vector.viewHeight,
      }),
    ),
  );

  const operations = { union, subtract: difference, intersect: intersection, exclude: xor };
  const result = operations[operation](shapes[0], ...shapes.slice(1));
  if (!result.length) return { upsert: [], remove: chosen.map((node) => node.id), selection: [] };
  const parentId = chosen[0].parentId;
  const parent = parentId ? source.getFrame(parentId) : undefined;
  const inverse = parent ? inverseMatrix(worldTransform(source, parent)) : IDENTITY;

  const contours = result.flatMap((polygon) =>
    polygon.map((ring) => ({
      closed: true,
      anchors: ring.slice(0, -1).map(([x, y]) => transformPoint(inverse, { x, y })),
    })),
  );

  const anchors = contours.flatMap((contour) => contour.anchors);

  const left = Math.min(...anchors.map((p) => p.x)),
    top = Math.min(...anchors.map((p) => p.y));

  const width = Math.max(1, Math.max(...anchors.map((p) => p.x)) - left),
    height = Math.max(1, Math.max(...anchors.map((p) => p.y)) - top);

  const vector: CanvasVectorData = {
    ...vectors[0].vector,
    viewWidth: width,
    viewHeight: height,
    fillRule: "evenodd",
    contours: contours.map((contour) =>
      transformContour(contour, { ...IDENTITY, e: -left, f: -top }),
    ),
  };

  const node = createCanvasVectorNode(
    allocate(),
    `${operation[0].toUpperCase()}${operation.slice(1)}`,
    vector,
    { x: (parent?.x ?? 0) + left, y: (parent?.y ?? 0) + top, width, height },
    parentId,
  );

  return { upsert: [node], remove: chosen.map((frame) => frame.id), selection: [node.id] };
}
