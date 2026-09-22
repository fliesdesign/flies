import {
  canUseCanvasMask,
  FULL_IMAGE_CROP,
  type CanvasDocument,
  type CanvasFrame,
  type CanvasImage,
  type CanvasImageCrop,
} from "@flies/canvas";
import { useEffect, useRef, useState, type PointerEvent } from "react";

import { PropertyField } from "./canvas-property-controls";
import { Section } from "./canvas-property-section";

function CropControls({
  document,
  node,
  disabled,
}: {
  document: CanvasDocument;
  node: CanvasImage;
  disabled: boolean;
}) {
  const crop = node.crop ?? FULL_IMAGE_CROP;
  const [ratio, setRatio] = useState(1.5);
  const area = useRef<HTMLDivElement>(null);

  const gesture = useRef<{
    x: number;
    y: number;
    crop: CanvasImageCrop;
    mode: string;
    node: CanvasImage;
  } | null>(null);

  useEffect(
    () => () => {
      if (gesture.current) {
        gesture.current = null;
        document.endGesture(true);
      }
    },
    [document],
  );

  const change = (key: keyof CanvasImageCrop, value: number) => {
    const next = { ...crop, [key]: value / 100 };
    next.x = Math.max(0, Math.min(next.x, 1 - (key === "x" ? next.width : 0.001)));
    next.y = Math.max(0, Math.min(next.y, 1 - (key === "y" ? next.height : 0.001)));
    next.width = Math.max(0.001, Math.min(next.width, 1 - next.x));
    next.height = Math.max(0.001, Math.min(next.height, 1 - next.y));
    document.update({ ...node, crop: next });
  };

  const start = (event: PointerEvent<HTMLButtonElement>, mode: string) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { x: event.clientX, y: event.clientY, crop, mode, node };
    document.beginGesture(node.id);
  };

  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const active = gesture.current,
      bounds = area.current?.getBoundingClientRect();

    if (!active || !bounds) return;

    const dx = (event.clientX - active.x) / bounds.width,
      dy = (event.clientY - active.y) / bounds.height;

    const next = { ...active.crop };

    if (active.mode === "move") {
      next.x = Math.max(0, Math.min(1 - next.width, next.x + dx));
      next.y = Math.max(0, Math.min(1 - next.height, next.y + dy));
    } else {
      const right = next.x + next.width,
        bottom = next.y + next.height;

      if (active.mode.includes("w")) {
        next.x = Math.max(0, Math.min(right - 0.001, next.x + dx));
        next.width = right - next.x;
      }

      if (active.mode.includes("e"))
        next.width = Math.max(0.001, Math.min(1 - next.x, next.width + dx));

      if (active.mode.includes("n")) {
        next.y = Math.max(0, Math.min(bottom - 0.001, next.y + dy));
        next.height = bottom - next.y;
      }

      if (active.mode.includes("s"))
        next.height = Math.max(0.001, Math.min(1 - next.y, next.height + dy));
    }

    document.preview({ ...active.node, crop: next });
  };

  const end = (cancel = false) => {
    if (gesture.current) {
      gesture.current = null;
      document.endGesture(cancel);
    }
  };

  return (
    <Section title="Image crop">
      <div ref={area} className="canvas-crop-preview" style={{ aspectRatio: ratio }}>
        <img
          src={node.src}
          alt="Crop source"
          draggable={false}
          onLoad={(event) =>
            setRatio(event.currentTarget.naturalWidth / event.currentTarget.naturalHeight)
          }
        />
        <button
          type="button"
          aria-label="Move crop"
          disabled={disabled}
          className="canvas-crop-region"
          style={{
            left: `${crop.x * 100}%`,
            top: `${crop.y * 100}%`,
            width: `${crop.width * 100}%`,
            height: `${crop.height * 100}%`,
          }}
          onPointerDown={(event) => start(event, "move")}
          onPointerMove={move}
          onPointerUp={() => end()}
          onPointerCancel={() => end(true)}
          onLostPointerCapture={() => end(true)}
          onKeyDown={(event) => {
            if (event.key === "Escape") end(true);
          }}
        />
        {["nw", "ne", "se", "sw"].map((corner) => (
          <button
            key={corner}
            type="button"
            aria-label={`Crop ${corner} corner`}
            disabled={disabled}
            className="canvas-crop-handle"
            style={{
              left: `${(crop.x + (corner.includes("e") ? crop.width : 0)) * 100}%`,
              top: `${(crop.y + (corner.includes("s") ? crop.height : 0)) * 100}%`,
            }}
            onPointerDown={(event) => start(event, corner)}
            onPointerMove={move}
            onPointerUp={() => end()}
            onPointerCancel={() => end(true)}
            onLostPointerCapture={() => end(true)}
          />
        ))}
      </div>
      <div className="canvas-properties-grid">
        {(["x", "y", "width", "height"] as const).map((key) => (
          <PropertyField
            key={key}
            label={`Crop ${key} percent`}
            prefix={key === "width" ? "W" : key === "height" ? "H" : key.toUpperCase()}
            numeric
            value={Number((crop[key] * 100).toFixed(2))}
            disabled={disabled}
            min={key === "width" || key === "height" ? 0.1 : 0}
            max={100}
            onCommit={(value) => change(key, Number(value))}
          />
        ))}
      </div>
      <button
        type="button"
        className="canvas-property-text-button"
        disabled={disabled || !node.crop}
        onClick={() => document.update({ ...node, crop: undefined })}
      >
        Reset crop
      </button>
    </Section>
  );
}

export function CanvasMediaControls({
  document,
  node,
  disabled,
}: {
  document: CanvasDocument;
  node: CanvasFrame;
  disabled: boolean;
}) {
  const nodes = document.getFrames();
  const sources = nodes.filter((source) => canUseCanvasMask(node, source, nodes));

  return (
    <>
      {node.kind === "image" && (
        <CropControls document={document} node={node} disabled={disabled} />
      )}
      {(sources.length > 0 || node.maskId) && (
        <Section title="Layer mask">
          <label className="canvas-property-select">
            <select
              aria-label="Mask source"
              disabled={disabled}
              value={node.maskId ?? ""}
              onChange={(event) =>
                document.update({ ...node, maskId: event.target.value || undefined })
              }
            >
              <option value="">None</option>
              {sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.name}
                </option>
              ))}
            </select>
          </label>
          <p className="canvas-property-hint">
            The source stays editable in Layers. Its transparency defines the visible area.
          </p>
        </Section>
      )}
    </>
  );
}
