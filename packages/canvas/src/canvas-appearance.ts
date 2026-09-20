import type { CSSProperties } from "react";

import type { CanvasFrame } from "./canvas-document";

/** Paint effects without changing the node bounds, text wrapping, or child clipping. */
export function canvasAppearanceStyle(frame: CanvasFrame): CSSProperties | undefined {
  if (!(frame.borderWidth && frame.borderWidth > 0) && !frame.shadows?.length) return undefined;

  return {
    position: "absolute",
    inset: 0,
    boxSizing: "border-box",
    pointerEvents: "none",
    borderStyle: "solid",
    borderWidth: frame.borderWidth ?? 0,
    borderColor: frame.borderColor ?? "#000000",
    borderRadius: frame.cornerRadius ?? 0,
    boxShadow: frame.shadows?.length
      ? frame.shadows
          .map(
            (shadow) =>
              `${shadow.inset ? "inset " : ""}${shadow.offsetX}px ${shadow.offsetY}px ${shadow.blur}px ${shadow.spread}px ${shadow.color}`,
          )
          .join(", ")
      : undefined,
  };
}
