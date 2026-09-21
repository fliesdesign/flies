import {
  canvasSizingLabel,
  inverseMatrix,
  multiplyMatrix,
  pointBounds,
  transformPoint,
  worldCorners,
  worldPointInFrame,
  worldTransform,
  getClippingAncestors,
  clippingRadius,
  type CanvasDocument,
  type CanvasFrame,
  type CanvasMatrix,
  type ResizeHandle,
  type Viewport,
} from "@flies/canvas";
import { useId, type ReactNode } from "react";

const HANDLES: ResizeHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

const NAMES = {
  nw: "top left",
  n: "top",
  ne: "top right",
  e: "right",
  se: "bottom right",
  s: "bottom",
  sw: "bottom left",
  w: "left",
};

/** Rotation-aware editor chrome. SVG clips preserve rotated and rounded ancestor boundaries. */
export function CanvasTransformedOutline({
  document,
  frames,
  viewport,
  selection = true,
}: {
  document: CanvasDocument;
  frames: readonly CanvasFrame[];
  viewport: Viewport;
  selection?: boolean;
}) {
  const prefix = useId().replace(/:/g, "");
  const single = frames.length === 1 ? frames[0] : undefined;
  const bounds = pointBounds(frames.flatMap((frame) => worldCorners(document, frame)));

  const matrix: CanvasMatrix = single
    ? worldTransform(document, single)
    : { a: 1, b: 0, c: 0, d: 1, e: bounds.x, f: bounds.y };

  const width = single?.width ?? bounds.width,
    height = single?.height ?? bounds.height;

  const paths = frames.map((frame) => getClippingAncestors(document, frame));

  const clips = paths[0].filter((ancestor) =>
    paths.every((path) => path.some((node) => node.id === ancestor.id)),
  );

  const relative = clips.map((ancestor) =>
    multiplyMatrix(inverseMatrix(matrix), worldTransform(document, ancestor)),
  );

  let border: ReactNode = (
    <rect
      x={0}
      y={0}
      width={width}
      height={height}
      fill="none"
      stroke="var(--editor-outline, #888)"
      strokeWidth={1}
      vectorEffect="non-scaling-stroke"
    />
  );

  for (let i = 0; i < clips.length; i++)
    border = (
      <g key={i} clipPath={`url(#${prefix}-${i})`}>
        {border}
      </g>
    );

  const locked = frames.some((frame) => {
    let node: CanvasFrame | undefined = frame;

    while (node) {
      if (node.locked) return true;
      node = node.parentId ? document.getFrame(node.parentId) : undefined;
    }

    return false;
  });

  const label = single ? canvasSizingLabel(single) : `${Math.round(width)} × ${Math.round(height)}`;
  const halfLabelWidth = (label.length * 7 + 14) / (2 * viewport.zoom);

  const showDimensions =
    selection &&
    [width / 2 - halfLabelWidth, width / 2 + halfLabelWidth].every((x) =>
      [12, 32].every((offset) => {
        const point = transformPoint(matrix, { x, y: height + offset / viewport.zoom });

        return clips.every((clip) => worldPointInFrame(document, clip, point));
      }),
    );

  return (
    <div
      className={selection ? "canvas-selection" : "canvas-hover"}
      data-frame-id={single?.id}
      style={{
        width: width * viewport.zoom,
        height: height * viewport.zoom,
        transformOrigin: "0 0",
        outline: "none",
        transform: `matrix(${matrix.a},${matrix.b},${matrix.c},${matrix.d},${viewport.x + matrix.e * viewport.zoom},${viewport.y + matrix.f * viewport.zoom})`,
      }}
    >
      <svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${width} ${height}`}
        style={{ position: "absolute", inset: 0, overflow: "visible", pointerEvents: "none" }}
        aria-hidden="true"
      >
        <defs>
          {clips.map((ancestor, i) => {
            const m = relative[i];

            return (
              <clipPath key={ancestor.id} id={`${prefix}-${i}`} clipPathUnits="userSpaceOnUse">
                <rect
                  width={ancestor.width}
                  height={ancestor.height}
                  rx={clippingRadius(ancestor)}
                  transform={`matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f})`}
                />
              </clipPath>
            );
          })}
        </defs>
        {border}
      </svg>
      {selection &&
        !locked &&
        HANDLES.filter((handle) => {
          const point = transformPoint(matrix, {
            x: width * (handle.includes("w") ? 0 : handle.includes("e") ? 1 : 0.5),
            y: height * (handle.includes("n") ? 0 : handle.includes("s") ? 1 : 0.5),
          });

          return clips.every((clip) => worldPointInFrame(document, clip, point));
        }).map((handle) => (
          <button
            key={handle}
            type="button"
            className={`canvas-resize canvas-resize-${handle}`}
            data-handle={handle}
            aria-label={`Resize ${single?.name ?? `${frames.length} objects`} from ${NAMES[handle]}`}
            title={`Resize ${NAMES[handle]}`}
          />
        ))}
      {showDimensions && <span className="canvas-dimensions">{label}</span>}
    </div>
  );
}
