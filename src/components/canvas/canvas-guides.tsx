import { memo, useSyncExternalStore } from "react";

import type { CanvasCamera } from "@/lib/canvas-camera";
import type { CanvasGuides } from "@/lib/canvas-guides";

export const CanvasAlignmentGuides = memo(function CanvasAlignmentGuides({
  guides,
  camera,
}: {
  guides: CanvasGuides;
  camera: CanvasCamera;
}) {
  const lines = useSyncExternalStore(guides.subscribe, guides.getSnapshot);
  const { viewport } = useSyncExternalStore(camera.subscribe, camera.getSnapshot);
  if (!lines.length) return null;
  return (
    <svg className="canvas-guides" aria-hidden="true">
      {lines.map((guide) => {
        const vertical = guide.axis === "x";
        const position = guide.position * viewport.zoom + (vertical ? viewport.x : viewport.y);
        const offset = vertical ? viewport.y : viewport.x;
        const start = guide.start * viewport.zoom + offset;
        const end = guide.end * viewport.zoom + offset;
        return (
          <g key={guide.axis} data-guide-axis={guide.axis}>
            <line
              x1={vertical ? position : start}
              y1={vertical ? start : position}
              x2={vertical ? position : end}
              y2={vertical ? end : position}
            />
            {(["start", "end"] as const).map((edge) => {
              const endpoint = edge === "start" ? start : end;
              return (
                <path
                  key={edge}
                  d={
                    vertical
                      ? `M ${position - 3} ${endpoint} h 6 M ${position} ${endpoint - 3} v 6`
                      : `M ${endpoint - 3} ${position} h 6 M ${endpoint} ${position - 3} v 6`
                  }
                />
              );
            })}
          </g>
        );
      })}
    </svg>
  );
});
