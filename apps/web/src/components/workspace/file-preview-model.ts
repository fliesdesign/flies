import type { FilePreviewNode } from "@/lib/local-files";

export const PREVIEW_NODE_LIMIT = 80;
const HEX_COLOR = /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i;

export type PreviewRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function hex(value: unknown): string | undefined {
  return typeof value === "string" && HEX_COLOR.test(value) ? value : undefined;
}

export function readPreviewNodes(input: unknown): FilePreviewNode[] {
  if (!Array.isArray(input)) return [];
  const nodes: FilePreviewNode[] = [];
  for (const item of input) {
    if (nodes.length >= PREVIEW_NODE_LIMIT) break;
    if (typeof item !== "object" || item === null) continue;
    const node = item as Record<string, unknown>;
    const id = typeof node.id === "string" && node.id ? node.id : undefined;
    const x = finite(node.x);
    const y = finite(node.y);
    const width = finite(node.width);
    const height = finite(node.height);
    if (!id || x === undefined || y === undefined || width === undefined || height === undefined) {
      continue;
    }
    if (width <= 0 || height <= 0) continue;
    const opacity = finite(node.opacity);
    if (opacity === 0) continue;
    const fontSize = finite(node.fontSize);
    const fontWeight = finite(node.fontWeight);
    const cornerRadius = finite(node.cornerRadius);
    const preview: FilePreviewNode = {
      id,
      x,
      y,
      width,
      height,
      ...(typeof node.parentId === "string" && node.parentId ? { parentId: node.parentId } : {}),
      ...(typeof node.kind === "string" ? { kind: node.kind } : {}),
      ...(hex(node.fill) ? { fill: hex(node.fill) } : {}),
      ...(hex(node.color) ? { color: hex(node.color) } : {}),
      ...(fontSize !== undefined && fontSize > 0 ? { fontSize } : {}),
      ...(fontWeight !== undefined && fontWeight >= 1 && fontWeight <= 1000 ? { fontWeight } : {}),
      ...(typeof node.fontFamily === "string" && node.fontFamily
        ? { fontFamily: node.fontFamily }
        : {}),
      ...(typeof node.textAlign === "string" ? { textAlign: node.textAlign } : {}),
      ...(typeof node.fontStyle === "string" ? { fontStyle: node.fontStyle } : {}),
      ...(cornerRadius !== undefined && cornerRadius >= 0 ? { cornerRadius } : {}),
      ...(opacity !== undefined && opacity > 0 && opacity <= 1 ? { opacity } : {}),
      ...(typeof node.clipContent === "boolean" ? { clipContent: node.clipContent } : {}),
      ...(typeof node.text === "string" && node.text ? { text: node.text } : {}),
    };
    nodes.push(preview);
  }
  return nodes;
}

export function previewBounds(nodes: readonly FilePreviewNode[]): PreviewRect | null {
  if (!nodes.length) return null;
  let x = Infinity;
  let y = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const node of nodes) {
    x = Math.min(x, node.x);
    y = Math.min(y, node.y);
    right = Math.max(right, node.x + node.width);
    bottom = Math.max(bottom, node.y + node.height);
  }
  if (!Number.isFinite(x) || right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

export function previewViewBox(bounds: PreviewRect, paddingRatio = 0.08): PreviewRect {
  const pad = Math.max(bounds.width, bounds.height, 1) * paddingRatio;
  return {
    x: bounds.x - pad,
    y: bounds.y - pad,
    width: bounds.width + pad * 2,
    height: bounds.height + pad * 2,
  };
}

export function previewTree(nodes: readonly FilePreviewNode[]): {
  roots: FilePreviewNode[];
  nested: Map<string, FilePreviewNode[]>;
} {
  const ids = new Set(nodes.map((node) => node.id));
  const nested = new Map<string, FilePreviewNode[]>();
  const roots: FilePreviewNode[] = [];
  for (const node of nodes) {
    if (node.parentId && ids.has(node.parentId)) {
      const siblings = nested.get(node.parentId);
      if (siblings) siblings.push(node);
      else nested.set(node.parentId, [node]);
    } else {
      roots.push(node);
    }
  }
  return { roots, nested };
}
