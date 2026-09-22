import type { CanvasFrame } from "./canvas-document";
import { filterCss } from "./canvas-paint";
import {
  inverseMatrix,
  localTransform,
  multiplyMatrix,
  pointBounds,
  transformPoint,
  type CanvasMatrix,
} from "./canvas-transform";
import { rasterizeNode, rasterResolution } from "./webgl/canvas-raster";

export type CanvasMaskStyle = Record<string, string>;
export const EMPTY_CANVAS_MASK: CanvasMaskStyle = {
  maskImage: "linear-gradient(transparent, transparent)",
};

/** Paint source alpha once, in target-local coordinates, for DOM rendering and portable exports. */
export async function rasterizeCanvasMask(
  target: CanvasFrame,
  source: CanvasFrame,
  scale = 1,
  transform: CanvasMatrix = multiplyMatrix(
    inverseMatrix(localTransform(target)),
    localTransform(source),
  ),
): Promise<CanvasMaskStyle> {
  if (source.hidden) return EMPTY_CANVAS_MASK;
  const raster = await rasterizeNode(source, Math.min(4, scale), false);
  const blur = (source.filters?.blur ?? 0) * 4;

  const bounds = pointBounds(
    [
      { x: raster.x - blur, y: raster.y - blur },
      { x: raster.x + raster.width + blur, y: raster.y - blur },
      { x: raster.x + raster.width + blur, y: raster.y + raster.height + blur },
      { x: raster.x - blur, y: raster.y + raster.height + blur },
    ].map((point) => transformPoint(transform, point)),
  );

  const canvas = document.createElement("canvas");
  const size = rasterResolution(bounds.width, bounds.height, scale);
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not paint the layer mask.");
  ctx.scale(size.width / bounds.width, size.height / bounds.height);
  ctx.translate(-bounds.x, -bounds.y);
  ctx.transform(transform.a, transform.b, transform.c, transform.d, transform.e, transform.f);

  if (raster.decoration) {
    const body = raster.body.getContext("2d")!;
    body.save();
    body.resetTransform();
    body.drawImage(raster.decoration, 0, 0);
    body.restore();
  }

  ctx.globalAlpha = source.opacity ?? 1;
  ctx.filter = filterCss(source.filters) ?? "none";
  ctx.drawImage(raster.body, raster.x, raster.y, raster.width, raster.height);

  return {
    maskImage: `url("${canvas.toDataURL()}")`,
    maskSize: `${bounds.width}px ${bounds.height}px`,
    maskPosition: `${bounds.x}px ${bounds.y}px`,
    maskRepeat: "no-repeat",
    maskClip: "no-clip",
    maskMode: "alpha",
  };
}
