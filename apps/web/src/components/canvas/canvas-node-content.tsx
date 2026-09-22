import {
  appendCanvasText,
  canvasAppearanceStyle,
  canvasTextRunCss,
  canvasTextSegments,
  fontFamilyCss,
  gradientCss,
} from "@flies/canvas";
import type { CanvasFrame, CanvasPen, CanvasText } from "@flies/canvas";
import { memo, useMemo, type CSSProperties } from "react";

import "./canvas-nodes.css";

/** Keep the rendered text, editing field, and height measurement on one typography definition. */
export function canvasTextStyle(frame: CanvasText): CSSProperties {
  return {
    color: frame.color,
    fontSize: frame.fontSize,
    fontFamily: fontFamilyCss(frame.fontFamily),
    fontWeight: frame.fontWeight ?? 400,
    fontStyle: frame.fontStyle ?? "normal",
    textDecoration: frame.textDecoration ?? "none",
    lineHeight: frame.lineHeight ?? 1.25,
    letterSpacing: frame.letterSpacing ?? 0,
    textAlign: frame.textAlign ?? "left",
  };
}

/** Measure unscaled content at its actual wrapping width, including an empty trailing line. */
export function measureCanvasTextHeight(frame: CanvasText): number {
  const lineHeight = frame.fontSize * (frame.lineHeight ?? 1.25);

  if (typeof document === "undefined") {
    return Math.max(1, Math.ceil(frame.text.split("\n").length * lineHeight));
  }

  const measurement = document.createElement("span");
  const typography = canvasTextStyle(frame);
  measurement.className = "canvas-text-content canvas-text-measurement";
  Object.assign(measurement.style, typography, {
    fontSize: `${frame.fontSize}px`,
    letterSpacing: `${frame.letterSpacing ?? 0}px`,
    width: `${frame.width}px`,
  });
  appendCanvasText(measurement, frame, true);
  document.body.append(measurement);

  const height = Math.max(
    1,
    Math.ceil(lineHeight),
    Math.ceil(measurement.getBoundingClientRect().height),
  );

  measurement.remove();

  return height;
}

const PenContent = memo(function PenContent({ frame }: { frame: CanvasPen }) {
  const points = useMemo(
    () => frame.points.map((point) => `${point.x},${point.y}`).join(" "),
    [frame.points],
  );

  const first = frame.points[0];

  return (
    <svg
      className="canvas-pen-content"
      viewBox={`0 0 ${frame.pathWidth} ${frame.pathHeight}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      {frame.points.length === 1 && first ? (
        <circle cx={first.x} cy={first.y} r={frame.strokeWidth / 2} fill={frame.stroke} />
      ) : (
        <polyline
          points={points}
          fill="none"
          stroke={frame.stroke}
          strokeWidth={frame.strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
});

/** Shared by mounted nodes and the temporary drawing preview. */
export const CanvasNodeContent = memo(function CanvasNodeContent({
  frame,
}: {
  frame: CanvasFrame;
}) {
  switch (frame.kind) {
    case "rectangle":
      return (
        <span
          className="canvas-rectangle-content"
          style={{
            background: frame.gradient ? gradientCss(frame.gradient) : frame.fill,
            borderRadius: frame.cornerRadius ?? 0,
          }}
        />
      );
    case "text":
      return (
        <span className="canvas-text-content" style={canvasTextStyle(frame)}>
          {canvasTextSegments(frame).map((segment) => (
            <span key={segment.start} style={canvasTextRunCss(segment.style)}>
              {segment.text}
            </span>
          ))}
        </span>
      );
    case "image":
      if (frame.crop)
        return (
          <span className="canvas-cropped-image" style={{ borderRadius: frame.cornerRadius ?? 0 }}>
            <img
              src={frame.src}
              alt=""
              draggable={false}
              decoding="async"
              style={{
                position: "absolute",
                maxWidth: "none",
                width: `${100 / frame.crop.width}%`,
                height: `${100 / frame.crop.height}%`,
                left: `${(-100 * frame.crop.x) / frame.crop.width}%`,
                top: `${(-100 * frame.crop.y) / frame.crop.height}%`,
              }}
            />
          </span>
        );

      return (
        <img
          className="canvas-image-content"
          src={frame.src}
          alt=""
          draggable={false}
          decoding="async"
          style={{ borderRadius: frame.cornerRadius ?? 0 }}
        />
      );
    case "svg":
      return (
        <img
          className="canvas-image-content"
          src={frame.src}
          alt=""
          draggable={false}
          decoding="async"
          style={{ borderRadius: frame.cornerRadius ?? 0 }}
        />
      );
    case "pen":
      return <PenContent frame={frame} />;
    default:
      return null;
  }
});

/** Place after children so borders and inset shadows sit above their contents. */
export const CanvasNodeAppearance = memo(function CanvasNodeAppearance({
  frame,
}: {
  frame: CanvasFrame;
}) {
  const style = canvasAppearanceStyle(frame);

  return style ? <span aria-hidden="true" data-canvas-appearance="" style={style} /> : null;
});

/** Commit before the document's non-capture persistence listeners read its state. */
export function subscribeTextDraftLifecycle(
  commit: () => void,
  page: EventTarget,
  visibility: EventTarget & { readonly visibilityState: DocumentVisibilityState },
) {
  const commitWhenHidden = () => {
    if (visibility.visibilityState === "hidden") commit();
  };

  page.addEventListener("pagehide", commit, true);
  visibility.addEventListener("visibilitychange", commitWhenHidden, true);

  return () => {
    page.removeEventListener("pagehide", commit, true);
    visibility.removeEventListener("visibilitychange", commitWhenHidden, true);
  };
}

export { CanvasRichTextEditor as CanvasTextEditor } from "./canvas-rich-text-editor";
