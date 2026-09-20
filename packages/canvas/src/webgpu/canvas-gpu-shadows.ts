import { Sprite, Texture } from "pixi.js";

import type { CanvasFrame, CanvasShadow } from "../canvas-document";

const MAX_TEXTURE_EDGE = 4096;
const MAX_TEXTURE_PIXELS = 8_000_000;

/** Cache only each node's shadow pixels. The artwork itself remains native GPU geometry. */
export function createShadowSprite(
  frame: CanvasFrame,
  shadows: readonly CanvasShadow[],
  inset: boolean,
  resolution: number,
): Sprite | undefined {
  const matching = shadows.filter((shadow) => Boolean(shadow.inset) === inset);
  if (!matching.length) return;

  const padding = inset
    ? 0
    : Math.ceil(
        Math.max(
          ...matching.map(
            (shadow) =>
              Math.max(Math.abs(shadow.offsetX), Math.abs(shadow.offsetY)) +
              shadow.blur * 2 +
              Math.max(0, shadow.spread),
          ),
        ) + 2,
      );

  const width = frame.width + padding * 2;
  const height = frame.height + padding * 2;

  const scale = Math.min(
    resolution,
    MAX_TEXTURE_EDGE / width,
    MAX_TEXTURE_EDGE / height,
    Math.sqrt(MAX_TEXTURE_PIXELS / (width * height)),
  );

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(width * scale));
  canvas.height = Math.max(1, Math.ceil(height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Unable to create shadow texture.");
  context.scale(scale, scale);
  const radius = Math.max(0, Math.min(frame.cornerRadius ?? 0, frame.width / 2, frame.height / 2));

  // CSS paints the first listed shadow above subsequent shadows.
  for (let index = matching.length - 1; index >= 0; index--) {
    const shadow = matching[index];
    context.save();
    context.beginPath();
    if (!inset) context.rect(0, 0, width, height);
    context.roundRect(padding, padding, frame.width, frame.height, radius);
    context.clip(inset ? "nonzero" : "evenodd");

    // Draw the source shape off-texture; only its displaced shadow lands in the texture.
    const margin =
      shadow.blur * 2 +
      Math.abs(shadow.spread) +
      Math.max(Math.abs(shadow.offsetX), Math.abs(shadow.offsetY)) +
      4;

    const displacement = width + margin * 2 + 10;
    context.shadowOffsetX = (displacement + shadow.offsetX) * scale;
    context.shadowOffsetY = shadow.offsetY * scale;
    context.shadowBlur = shadow.blur * scale;
    context.shadowColor = shadow.color;
    context.fillStyle = "#000";
    context.beginPath();

    if (inset) {
      context.rect(-displacement - margin, -margin, width + margin * 2, height + margin * 2);
      const innerWidth = Math.max(0, frame.width - shadow.spread * 2);
      const innerHeight = Math.max(0, frame.height - shadow.spread * 2);

      if (innerWidth && innerHeight) {
        context.roundRect(
          padding - displacement + shadow.spread,
          padding + shadow.spread,
          innerWidth,
          innerHeight,
          Math.max(0, radius - shadow.spread),
        );
      }

      context.fill("evenodd");
    } else {
      const spreadWidth = frame.width + shadow.spread * 2;
      const spreadHeight = frame.height + shadow.spread * 2;

      if (spreadWidth > 0 && spreadHeight > 0) {
        context.roundRect(
          padding - displacement - shadow.spread,
          padding - shadow.spread,
          spreadWidth,
          spreadHeight,
          Math.max(0, radius + shadow.spread),
        );
        context.fill();
      }
    }

    context.restore();
  }

  const sprite = new Sprite(Texture.from(canvas, true));
  sprite.position.set(-padding, -padding);
  sprite.width = width;
  sprite.height = height;

  return sprite;
}
