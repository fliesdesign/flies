/* oxlint-disable react/no-array-index-key -- Contour and anchor indices identify geometry; coordinate keys would remount drag targets. */
/* oxlint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex -- This named SVG application implements its own keyboard and pointer geometry editor. */
import {
  addCanvasVectorAnchor,
  canvasVectorPath,
  inverseMatrix,
  moveCanvasVectorAnchor,
  multiplyMatrix,
  removeCanvasVectorAnchor,
  setCanvasVectorAnchorSmooth,
  setCanvasVectorClosed,
  transformPoint,
  type CanvasMatrix,
  type CanvasVectorData,
  type EditableCanvasSvg,
  type Point,
} from "@flies/canvas";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

type Selection = { contour: number; anchor: number };
export type CanvasVectorEditorProps = {
  node: EditableCanvasSvg;
  transform: CanvasMatrix;
  onPreviewStart: () => void;
  onPreview: (vector: CanvasVectorData) => void;
  onPreviewEnd: (cancel: boolean) => void;
  onCommit: (vector: CanvasVectorData) => void;
  onClose: () => void;
};

/** Screen-space handles keep a constant hit target at every canvas zoom. */
export function CanvasVectorEditor({
  node,
  transform,
  onPreviewStart,
  onPreview,
  onPreviewEnd,
  onCommit,
  onClose,
}: CanvasVectorEditorProps) {
  const [selected, setSelected] = useState<Selection | null>(null);
  const svg = useRef<SVGSVGElement>(null);

  const dragging = useRef<{
    pointer: number;
    selection: Selection;
    handle?: "in" | "out";
    vector: CanvasVectorData;
    inverse: CanvasMatrix;
    left: number;
    top: number;
  } | null>(null);

  const end = useRef(onPreviewEnd);
  useEffect(() => {
    end.current = onPreviewEnd;
  }, [onPreviewEnd]);
  useEffect(
    () => () => {
      if (dragging.current) end.current(true);
    },
    [],
  );

  const matrix = multiplyMatrix(transform, {
    a: node.width / node.vector.viewWidth,
    b: 0,
    c: 0,
    d: node.height / node.vector.viewHeight,
    e: 0,
    f: 0,
  });

  const screen = (point: Point) => transformPoint(matrix, point);

  const selection =
    selected && node.vector.contours[selected.contour]?.anchors[selected.anchor] ? selected : null;

  const contour = selection ? node.vector.contours[selection.contour] : undefined;
  const anchor = selection && contour ? contour.anchors[selection.anchor] : undefined;

  const start = (
    event: ReactPointerEvent<SVGElement>,
    target: Selection,
    handle?: "in" | "out",
  ) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    const bounds = svg.current!.getBoundingClientRect();
    setSelected(target);
    dragging.current = {
      pointer: event.pointerId,
      selection: target,
      handle,
      vector: node.vector,
      inverse: inverseMatrix(matrix),
      left: bounds.left,
      top: bounds.top,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    svg.current?.focus();
    onPreviewStart();
  };

  const finish = (cancel: boolean) => {
    if (!dragging.current) return;
    dragging.current = null;
    onPreviewEnd(cancel);
  };

  const remove = () => {
    if (!selection || !contour || contour.anchors.length <= (contour.closed ? 3 : 1)) return;
    onCommit(removeCanvasVectorAnchor(node.vector, selection.contour, selection.anchor));
    setSelected(null);
  };

  const insert = () => {
    if (
      !selection ||
      !contour ||
      (!contour.closed && selection.anchor === contour.anchors.length - 1)
    )
      return;
    onCommit(addCanvasVectorAnchor(node.vector, selection.contour, selection.anchor));
    setSelected({ ...selection, anchor: selection.anchor + 1 });
  };

  return (
    <>
      <svg
        ref={svg}
        data-vector-editor=""
        aria-label={`Edit ${node.name} vector points`}
        role="application"
        tabIndex={0}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          pointerEvents: "none",
          overflow: "visible",
          outline: "none",
          zIndex: 8,
        }}
        onKeyDown={(event) => {
          if (["Delete", "Backspace", "Escape", "Enter"].includes(event.key)) {
            event.preventDefault();
            event.stopPropagation();
          }

          if (event.key === "Delete" || event.key === "Backspace") remove();

          if (event.key === "Escape") {
            if (dragging.current) finish(true);
            else onClose();
          }

          if (event.key === "Enter") {
            finish(false);
            onClose();
          }
        }}
        onPointerMove={(event) => {
          const drag = dragging.current;
          if (!drag || drag.pointer !== event.pointerId) return;
          event.stopPropagation();

          const position = transformPoint(drag.inverse, {
            x: event.clientX - drag.left,
            y: event.clientY - drag.top,
          });

          onPreview(
            moveCanvasVectorAnchor(
              drag.vector,
              drag.selection.contour,
              drag.selection.anchor,
              position,
              drag.handle,
              event.altKey,
            ),
          );
        }}
        onPointerUp={(event) => {
          if (dragging.current?.pointer === event.pointerId) {
            event.stopPropagation();
            finish(false);
          }
        }}
        onPointerCancel={() => finish(true)}
      >
        {node.vector.contours.map((path, contourIndex) => {
          const visual = {
            ...path,
            anchors: path.anchors.map((point) => ({
              ...screen(point),
              ...(point.in ? { in: screen(point.in) } : {}),
              ...(point.out ? { out: screen(point.out) } : {}),
            })),
          };

          return (
            <g key={contourIndex}>
              <path d={canvasVectorPath(visual)} fill="none" stroke="#4285d4" strokeWidth={1.5} />
              {path.anchors.map((point, anchorIndex) => {
                const position = screen(point);

                const active =
                  selection?.contour === contourIndex && selection.anchor === anchorIndex;

                return (
                  <g key={anchorIndex}>
                    {active &&
                      (["in", "out"] as const).map((handle) => {
                        const control = point[handle];
                        if (!control) return null;
                        const p = screen(control);

                        return (
                          <g key={handle}>
                            <line
                              x1={position.x}
                              y1={position.y}
                              x2={p.x}
                              y2={p.y}
                              stroke="#4285d4"
                              strokeWidth={1}
                            />
                            <circle
                              cx={p.x}
                              cy={p.y}
                              r={4}
                              fill="white"
                              stroke="#4285d4"
                              strokeWidth={1.5}
                              style={{ pointerEvents: "all", cursor: "move" }}
                              onPointerDown={(event) =>
                                start(event, { contour: contourIndex, anchor: anchorIndex }, handle)
                              }
                            />
                          </g>
                        );
                      })}
                    <rect
                      x={position.x - 4}
                      y={position.y - 4}
                      width={8}
                      height={8}
                      fill={active ? "#4285d4" : "white"}
                      stroke="#4285d4"
                      strokeWidth={1.5}
                      style={{ pointerEvents: "all", cursor: "move" }}
                      onPointerDown={(event) =>
                        start(event, { contour: contourIndex, anchor: anchorIndex })
                      }
                      onDoubleClick={(event) => {
                        event.stopPropagation();
                        onCommit(
                          setCanvasVectorAnchorSmooth(
                            node.vector,
                            contourIndex,
                            anchorIndex,
                            !point.in && !point.out,
                          ),
                        );
                      }}
                    />
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
      <div
        role="toolbar"
        aria-label="Vector editing"
        style={{
          position: "absolute",
          left: "50%",
          bottom: 20,
          transform: "translateX(-50%)",
          display: "flex",
          gap: 4,
          padding: 6,
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--popover)",
          boxShadow: "0 4px 16px #0002",
          zIndex: 9,
        }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="canvas-property-text-button"
          disabled={
            !selection ||
            !contour ||
            (!contour.closed && selection.anchor === contour.anchors.length - 1)
          }
          onClick={insert}
        >
          Add point
        </button>
        <button
          type="button"
          className="canvas-property-text-button"
          disabled={!selection || !contour || contour.anchors.length <= (contour.closed ? 3 : 1)}
          onClick={remove}
        >
          Remove
        </button>
        <button
          type="button"
          className="canvas-property-text-button"
          disabled={!selection}
          onClick={() => {
            if (selection)
              onCommit(
                setCanvasVectorAnchorSmooth(
                  node.vector,
                  selection.contour,
                  selection.anchor,
                  !anchor?.in && !anchor?.out,
                ),
              );
          }}
        >
          {anchor?.in || anchor?.out ? "Corner" : "Smooth"}
        </button>
        <button
          type="button"
          className="canvas-property-text-button"
          disabled={!selection || !contour || contour.anchors.length < 3}
          onClick={() => {
            if (selection && contour)
              onCommit(setCanvasVectorClosed(node.vector, selection.contour, !contour.closed));
          }}
        >
          {contour?.closed ? "Open path" : "Close path"}
        </button>
        <button type="button" className="canvas-property-text-button" onClick={onClose}>
          Done
        </button>
      </div>
    </>
  );
}
