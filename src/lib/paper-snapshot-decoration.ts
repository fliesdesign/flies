import type { CanvasFrame } from "@/lib/canvas-document";
import { nodeName } from "@/lib/mcp/html-style";

type Corner = { x: number; y: number };
type Decoration = { src: string; name: string; borders: number[] };
export type SnapshotDecorations = Map<string, Decoration>;
const SIDES = ["Top", "Right", "Bottom", "Left"] as const;

function radiusLength(part: string, side: number) {
  return part.endsWith("%") ? (parseFloat(part) * side) / 100 : parseFloat(part);
}

function cornersFor(style: CSSStyleDeclaration, width: number, height: number): Corner[] {
  const corners = [
    style.borderTopLeftRadius,
    style.borderTopRightRadius,
    style.borderBottomRightRadius,
    style.borderBottomLeftRadius,
  ].map((value) => {
    const [x, y = x] = value.split(" ");
    return { x: radiusLength(x, width), y: radiusLength(y, height) };
  });
  const [tl, tr, br, bl] = corners;
  const scale = Math.min(
    1,
    width / (tl.x + tr.x || 1),
    width / (bl.x + br.x || 1),
    height / (tl.y + bl.y || 1),
    height / (tr.y + br.y || 1),
  );
  return corners.map(({ x, y }) => ({ x: x * scale, y: y * scale }));
}

function borderRegion(width: number, height: number, borders: number[], side: number) {
  const distances = [
    [0, 1, 0],
    [-1, 0, width],
    [0, -1, height],
    [1, 0, 0],
  ];
  let polygon = [
    [0, 0],
    [width, 0],
    [width, height],
    [0, height],
  ];
  for (let other = 0; other < 4; other++) {
    if (other === side || !borders[other]) continue;
    const [a, b, c] = distances[side].map(
      (n, i) => n / borders[side] - distances[other][i] / borders[other],
    );
    const distance = ([x, y]: number[]) => a * x + b * y + c;
    const next: number[][] = [];
    for (let i = 0; i < polygon.length; i++) {
      const start = polygon[i],
        end = polygon[(i + 1) % polygon.length];
      const from = distance(start),
        to = distance(end);
      if (from <= 0) next.push(start);
      if (from <= 0 !== to <= 0) {
        const t = from / (from - to);
        next.push([start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t]);
      }
    }
    polygon = next;
  }
  return polygon;
}

function renderBackground(
  style: CSSStyleDeclaration,
  width: number,
  height: number,
  borders: number[],
) {
  const scale = Math.min(
    2,
    2048 / Math.max(width, height),
    Math.sqrt(1_000_000 / (width * height)),
  );
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(width * scale));
  canvas.height = Math.max(1, Math.ceil(height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not preserve the snapshot's rounded background.");
  context.scale(canvas.width / width, canvas.height / height);
  const corners = cornersFor(style, width, height);
  const outline = new Path2D();
  outline.roundRect(0, 0, width, height, corners);
  context.fillStyle = style.backgroundColor;
  // eslint-disable-next-line unicorn/no-array-fill-with-reference-type
  context.fill(outline);
  const [top, right, bottom, left] = borders;
  const innerWidth = Math.max(0, width - left - right),
    innerHeight = Math.max(0, height - top - bottom);
  const inner = corners.map((corner, i) => ({
    x: Math.max(0, corner.x - (i === 0 || i === 3 ? left : right)),
    y: Math.max(0, corner.y - (i < 2 ? top : bottom)),
  }));
  if (innerWidth && innerHeight) outline.roundRect(left, top, innerWidth, innerHeight, inner);
  context.save();
  context.clip(outline, "evenodd");
  const colors = SIDES.map((side) => style[`border${side}Color`]);
  const visibleColors = colors.filter((_, index) => borders[index] > 0);
  if (visibleColors.length && visibleColors.every((color) => color === visibleColors[0])) {
    context.fillStyle = visibleColors[0];
    context.fillRect(0, 0, width, height);
  } else {
    SIDES.forEach((_, index) => {
      if (!borders[index]) return;
      context.beginPath();
      borderRegion(width, height, borders, index).forEach(([x, y], i) =>
        i ? context.lineTo(x, y) : context.moveTo(x, y),
      );
      context.closePath();
      context.fillStyle = colors[index];
      context.fill();
    });
  }
  context.restore();
  return canvas.toDataURL("image/png");
}

/** Common avatar captures place a matching image inside a small rounded clipping wrapper. */
export function preserveSnapshotImageClips(layout: HTMLElement) {
  for (const image of Array.from(layout.querySelectorAll("img"))) {
    const rect = image.getBoundingClientRect();
    for (
      let parent = image.parentElement;
      parent && parent !== layout;
      parent = parent.parentElement
    ) {
      const style = getComputedStyle(parent);
      if (![style.overflowX, style.overflowY].some((value) => ["hidden", "clip"].includes(value)))
        continue;
      const clip = parent.getBoundingClientRect();
      if (clip.width >= 40 && clip.height >= 40) continue;
      if (
        [rect.x - clip.x, rect.y - clip.y, rect.width - clip.width, rect.height - clip.height].some(
          (n) => Math.abs(n) > 0.1,
        )
      )
        continue;
      const corners = [
        style.borderTopLeftRadius,
        style.borderTopRightRadius,
        style.borderBottomRightRadius,
        style.borderBottomLeftRadius,
      ];
      if (
        corners.some((r) => r !== corners[0] || r.includes(" ")) ||
        (corners[0].endsWith("%") && rect.width !== rect.height)
      )
        continue;
      const radius = radiusLength(corners[0], rect.width);
      const current = radiusLength(getComputedStyle(image).borderTopLeftRadius, rect.width);
      if (radius > current) image.style.borderRadius = `${radius}px`;
    }
  }
}

/** Preserve the decorated pixels; native text and measured layout remain editable. */
export function preserveSnapshotDecorations(
  layout: HTMLElement,
  warn: (message: string) => void,
): SnapshotDecorations {
  const decorations: SnapshotDecorations = new Map();
  let pixels = 0;
  for (const element of Array.from(layout.querySelectorAll<HTMLElement>("*"))) {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    const corners = [
      style.borderTopLeftRadius,
      style.borderTopRightRadius,
      style.borderBottomRightRadius,
      style.borderBottomLeftRadius,
    ];
    if (
      !corners.some((r) => r !== corners[0] || r.includes(" ")) &&
      !(corners[0].endsWith("%") && rect.width !== rect.height)
    )
      continue;
    const borders = SIDES.map((side) => parseFloat(style[`border${side}Width`]));
    const hasBackground = !["transparent", "rgba(0, 0, 0, 0)"].includes(style.backgroundColor);
    if (hasBackground || borders.some((n) => n > 0)) {
      pixels += Math.min(1_000_000, rect.width * rect.height * 4);
      if (pixels > 8_000_000 || decorations.size >= 64)
        throw new Error(
          "Snapshot rounded backgrounds exceed the image budget. Capture a smaller section.",
        );
      const marker = `snapshot-decoration-${crypto.randomUUID()}`;
      decorations.set(marker, {
        src: renderBackground(style, rect.width, rect.height, borders),
        name: nodeName(element, style),
        borders,
      });
      element.dataset.name = marker;
      warn("Uneven rounded backgrounds were preserved as images.");
    }
    // Radius does not affect layout. Keep all original border widths, padding and positioning.
    element.style.borderRadius = "0px";
  }
  return decorations;
}

export function applySnapshotDecorations(
  nodes: CanvasFrame[],
  decorations: SnapshotDecorations,
): CanvasFrame[] {
  const decoratedParents = new Map<string, { node: CanvasFrame; decoration: Decoration }>();
  const output: CanvasFrame[] = [];
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    const parent = node.parentId ? decoratedParents.get(node.parentId) : undefined;
    if (parent && node.kind === "rectangle") {
      const firstBackground = nodes[index - 1]?.id === parent.node.id && node.name === "Background";
      const side = ["Top border", "Right border", "Bottom border", "Left border"].indexOf(
        node.name,
      );
      const width = parent.decoration.borders[side];
      const sameSide =
        side >= 0 &&
        width > 0 &&
        (side === 0
          ? node.x === parent.node.x &&
            node.y === parent.node.y &&
            node.width === parent.node.width &&
            node.height === width
          : side === 1
            ? node.x === parent.node.x + parent.node.width - width &&
              node.y === parent.node.y &&
              node.width === width &&
              node.height === parent.node.height
            : side === 2
              ? node.x === parent.node.x &&
                node.y === parent.node.y + parent.node.height - width &&
                node.width === parent.node.width &&
                node.height === width
              : node.x === parent.node.x &&
                node.y === parent.node.y &&
                node.width === width &&
                node.height === parent.node.height);
      if (firstBackground || sameSide) continue;
    }
    const decoration = decorations.get(node.name);
    if (!decoration) {
      output.push(node);
      continue;
    }
    if (node.kind === "rectangle") {
      output.push({
        ...node,
        name: decoration.name,
        kind: "image",
        src: decoration.src,
        cornerRadius: 0,
        borderWidth: 0,
      });
      continue;
    }
    if (node.kind !== "frame" && node.kind !== "group") {
      output.push({ ...node, name: decoration.name });
      continue;
    }
    decoratedParents.set(node.id, { node, decoration });
    output.push(
      node.kind === "frame"
        ? { ...node, name: decoration.name, fill: "#00000000", borderWidth: 0, cornerRadius: 0 }
        : { ...node, name: decoration.name },
    );
    output.push({
      id: crypto.randomUUID(),
      parentId: node.id,
      kind: "image",
      name: "Rounded background",
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      src: decoration.src,
      opacity: 1,
    });
  }
  return output;
}
