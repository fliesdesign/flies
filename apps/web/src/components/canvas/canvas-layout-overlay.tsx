import {
  clippingRadius,
  getClippingAncestors,
  localTransform,
  transformPoint,
  useCanvasSnapshot,
  worldPointInFrame,
  worldBounds,
  worldTransform,
  type CanvasCamera,
  type CanvasDocument,
  type CanvasFrame,
  type CanvasFrameNode,
  type FrameRect,
  type Point,
} from "@flies/canvas";
import {
  memo,
  useId,
  useState,
  useSyncExternalStore,
  type PointerEvent,
  type ReactNode,
} from "react";

import "./canvas-layout-overlay.css";
import { useLayoutOverlayStore } from "./canvas-layout-overlay-store";

export type LayoutHandle = {
  key: string;
  label: string;
  property: "layoutPadding" | "layoutGap";
  axis: "x" | "y";
  sign: number;
  value: number;
  rect: FrameRect;
  anchor: Point;
  distributed?: boolean;
};

const EMPTY_IDS: readonly string[] = [];

function isLayoutLocked(document: CanvasDocument, frame: CanvasFrame): boolean {
  let node: CanvasFrame | undefined = frame;

  while (node) {
    if (node.locked) return true;
    node = node.parentId ? document.getFrame(node.parentId) : undefined;
  }

  return false;
}

/** Geometry is in the container's unrotated local space; handles stay screen sized. */
export function layoutHandles(
  frame: CanvasFrameNode,
  children: readonly CanvasFrame[],
  zoom: number,
): LayoutHandle[] {
  const layout = frame.layout;
  if (!layout) return [];
  const { width, height } = frame;
  const px = Math.min(layout.padding, width / 2);
  const py = Math.min(layout.padding, height / 2);
  const insetX = Math.min(width / 2, Math.max(px / 2, 14 / zoom));
  const insetY = Math.min(height / 2, Math.max(py / 2, 14 / zoom));

  const padding = (
    key: string,
    axis: "x" | "y",
    sign: number,
    rect: FrameRect,
    anchor: Point,
  ): LayoutHandle => ({
    key: `padding-${key}`,
    label: `${key[0].toUpperCase()}${key.slice(1)} padding`,
    property: "layoutPadding",
    axis,
    sign,
    value: layout.padding,
    rect,
    anchor,
  });

  const handles: LayoutHandle[] = [
    padding("top", "y", 1, { x: 0, y: 0, width, height: py }, { x: width / 2, y: insetY }),
    padding(
      "bottom",
      "y",
      -1,
      { x: 0, y: height - py, width, height: py },
      { x: width / 2, y: height - insetY },
    ),
    padding(
      "left",
      "x",
      1,
      { x: 0, y: py, width: px, height: height - py * 2 },
      { x: insetX, y: height / 2 },
    ),
    padding(
      "right",
      "x",
      -1,
      { x: width - px, y: py, width: px, height: height - py * 2 },
      { x: width - insetX, y: height / 2 },
    ),
  ];

  const visible = children.filter((child) => !child.hidden);
  const row = layout.direction === "row";

  for (let i = 1; i < visible.length; i++) {
    const before = visible[i - 1];
    const after = visible[i];
    const start = row ? before.x + before.width - frame.x : before.y + before.height - frame.y;
    const end = row ? after.x - frame.x : after.y - frame.y;
    if (end < start) continue;

    const rect = row
      ? { x: start, y: py, width: end - start, height: height - py * 2 }
      : { x: px, y: start, width: width - px * 2, height: end - start };

    handles.push({
      key: `gap-${before.id}-${after.id}`,
      label: `Gap between ${before.name} and ${after.name}`,
      property: "layoutGap",
      axis: row ? "x" : "y",
      sign: 1,
      value: layout.gap,
      rect,
      anchor: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
      distributed: layout.justify === "space-between",
    });
  }

  return handles;
}

export const CanvasLayoutOverlay = memo(function CanvasLayoutOverlay({
  document,
  camera,
  id,
  activeHandle,
  onStart,
  onChange,
}: {
  document: CanvasDocument;
  camera: CanvasCamera;
  id: string | null;
  activeHandle: string | null;
  onStart: (event: PointerEvent<HTMLButtonElement>, handle: LayoutHandle) => void;
  onChange: (property: "layoutPadding" | "layoutGap", value: number) => void;
}) {
  const snapshot = useCanvasSnapshot(document);
  const selected = id ? document.getFrame(id) : undefined;
  const parent = selected?.parentId ? document.getFrame(selected.parentId) : undefined;

  const context =
    selected && (!selected.kind || selected.kind === "frame") && selected.layout
      ? selected
      : parent && (!parent.kind || parent.kind === "frame") && parent.layout
        ? parent
        : undefined;

  const contextId = context?.id;

  const childIds = contextId ? document.getChildren(contextId) : EMPTY_IDS;
  const revision = snapshot.revision;
  useLayoutOverlayStore(document, contextId, childIds, revision);

  const { viewport, size } = useSyncExternalStore(
    camera.subscribe,
    camera.getSnapshot,
    camera.getSnapshot,
  );

  const [hovered, setHovered] = useState<string | null>(null);
  const prefix = useId().replace(/:/g, "");
  if (!context || !selected || document.isHidden(selected.id)) return null;
  // Read again after the frame subscription; previews do not publish document revisions.
  const frame = document.getFrame(context.id) as CanvasFrameNode;

  const children = document
    .getChildren(frame.id)
    .map((childId) => document.getFrame(childId)!)
    .filter((child) => !child.hidden);

  const matrix = worldTransform(document, frame);

  const screen = (point: Point) => {
    const p = transformPoint(matrix, point);

    return { x: viewport.x + p.x * viewport.zoom, y: viewport.y + p.y * viewport.zoom };
  };

  const clipFrames = [
    ...getClippingAncestors(document, frame),
    ...(frame.clipContent !== false ? [frame] : []),
  ];

  const editable = selected.id === frame.id && !isLayoutLocked(document, frame);

  const handles =
    editable && frame.width * viewport.zoom >= 56 && frame.height * viewport.zoom >= 56
      ? layoutHandles(frame, children, viewport.zoom).filter((handle) => {
          const world = transformPoint(matrix, handle.anchor);
          const point = screen(handle.anchor);

          return (
            point.x >= 12 &&
            point.x <= size.x - 12 &&
            point.y >= 12 &&
            point.y <= size.y - 12 &&
            clipFrames.every((clip) => worldPointInFrame(document, clip, world))
          );
        })
      : [];

  const active = handles.find((handle) => handle.key === (activeHandle ?? hovered));

  const transform = (m: typeof matrix) =>
    `matrix(${m.a * viewport.zoom} ${m.b * viewport.zoom} ${m.c * viewport.zoom} ${m.d * viewport.zoom} ${viewport.x + m.e * viewport.zoom} ${viewport.y + m.f * viewport.zoom})`;

  let outlines: ReactNode = (
    <g transform={transform(matrix)}>
      {selected.id !== frame.id && (
        <rect className="canvas-layout-child" width={frame.width} height={frame.height} />
      )}
      {children
        .filter((child) => {
          const bounds = worldBounds(document, child);

          return (
            viewport.x + (bounds.x + bounds.width) * viewport.zoom >= 0 &&
            viewport.y + (bounds.y + bounds.height) * viewport.zoom >= 0 &&
            viewport.x + bounds.x * viewport.zoom <= size.x &&
            viewport.y + bounds.y * viewport.zoom <= size.y
          );
        })
        .map((child) => {
          const m = localTransform(child, frame);

          return (
            <rect
              key={child.id}
              data-layout-child={child.id}
              className="canvas-layout-child"
              width={child.width}
              height={child.height}
              transform={`matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f})`}
            />
          );
        })}
      {active && (
        <rect className="canvas-layout-region" data-spacing={active.property} {...active.rect} />
      )}
    </g>
  );

  for (let i = 0; i < clipFrames.length; i++)
    outlines = (
      <g key={i} clipPath={`url(#${prefix}-${i})`}>
        {outlines}
      </g>
    );
  const point = active ? screen(active.anchor) : undefined;

  return (
    <div className="canvas-layout-overlay" data-layout-context={frame.id}>
      <svg aria-hidden="true" className="canvas-layout-outlines" width="100%" height="100%">
        <defs>
          {clipFrames.map((clip, index) => (
            <clipPath id={`${prefix}-${index}`} key={clip.id} clipPathUnits="userSpaceOnUse">
              <rect
                width={clip.width}
                height={clip.height}
                rx={clippingRadius(clip)}
                transform={transform(worldTransform(document, clip))}
              />
            </clipPath>
          ))}
        </defs>
        {outlines}
      </svg>
      {handles.map((handle) => {
        const anchor = screen(handle.anchor);

        const angle =
          (Math.atan2(matrix.b, matrix.a) * 180) / Math.PI + (handle.axis === "x" ? 90 : 0);

        return (
          <button
            key={handle.key}
            type="button"
            className="canvas-layout-handle"
            data-layout-handle={handle.key}
            data-spacing={handle.property}
            data-active={active?.key === handle.key || undefined}
            aria-label={`${handle.label}: ${handle.value}px`}
            title={`${handle.label}${handle.property === "layoutPadding" ? " (all sides)" : handle.distributed ? " (minimum gap)" : ""}. Drag to adjust; arrow keys change by 1, Shift by 10.`}
            style={
              {
                left: anchor.x,
                top: anchor.y,
                cursor:
                  Math.abs(Math.sin((angle * Math.PI) / 180)) > 0.7 ? "ew-resize" : "ns-resize",
                "--handle-angle": `${angle}deg`,
              } as React.CSSProperties
            }
            onPointerDown={(event) => onStart(event, handle)}
            onPointerEnter={() => setHovered(handle.key)}
            onPointerLeave={() => setHovered(null)}
            onFocus={() => setHovered(handle.key)}
            onBlur={() => setHovered(null)}
            onKeyDown={(event) => {
              if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
              event.preventDefault();
              event.stopPropagation();
              onChange(
                handle.property,
                Math.max(
                  0,
                  handle.value +
                    (event.key === "ArrowLeft" || event.key === "ArrowDown" ? -1 : 1) *
                      (event.shiftKey ? 10 : 1),
                ),
              );
            }}
          >
            <span />
          </button>
        );
      })}
      {active && point && (
        <span
          className="canvas-layout-value"
          data-spacing={active.property}
          style={{
            left: Math.max(32, Math.min(size.x - 48, point.x + 24)),
            top: Math.max(6, Math.min(size.y - 26, point.y - 10)),
          }}
        >
          {active.distributed ? "Min " : ""}
          {Math.round(active.value * 100) / 100}
        </span>
      )}
    </div>
  );
});
