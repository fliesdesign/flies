import type { CanvasFrame } from "./canvas-document";

/** The visible source rectangle, normalized to the image's intrinsic dimensions. */
export type CanvasImageCrop = Readonly<{ x: number; y: number; width: number; height: number }>;
export const FULL_IMAGE_CROP: CanvasImageCrop = Object.freeze({ x: 0, y: 0, width: 1, height: 1 });

export function isCanvasImageCrop(value: unknown): value is CanvasImageCrop {
  if (!value || typeof value !== "object") return false;
  const crop = value as CanvasImageCrop;

  return (
    [crop.x, crop.y, crop.width, crop.height].every(Number.isFinite) &&
    crop.x >= 0 &&
    crop.y >= 0 &&
    crop.width > 0 &&
    crop.height > 0 &&
    crop.x + crop.width <= 1 + 1e-9 &&
    crop.y + crop.height <= 1 + 1e-9
  );
}

export function canvasMaskSourceIds(nodes: readonly CanvasFrame[]): ReadonlySet<string> {
  return new Set(nodes.flatMap((node) => (node.maskId ? [node.maskId] : [])));
}

export function canUseCanvasMask(
  target: CanvasFrame,
  source: CanvasFrame,
  nodes: readonly CanvasFrame[],
): boolean {
  return (
    target.kind !== "page" &&
    source.kind !== "page" &&
    source.kind !== "group" &&
    target.id !== source.id &&
    target.parentId === source.parentId &&
    !source.maskId &&
    !nodes.some((node) => node.parentId === source.id || node.maskId === target.id)
  );
}

export function validateCanvasMasks(nodes: readonly CanvasFrame[]): boolean {
  const byId = new Map(nodes.map((node) => [node.id, node]));

  return nodes.every(
    (node) =>
      !node.maskId ||
      (!!byId.get(node.maskId) && canUseCanvasMask(node, byId.get(node.maskId)!, nodes)),
  );
}
