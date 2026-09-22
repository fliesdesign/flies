import type {
  CanvasFrame,
  CanvasVectorBoolean,
  CanvasVectorData,
  EditableCanvasSvg,
} from "@flies/canvas";
import { PenLineIcon } from "lucide-react";

import { ColorSwatch, PropertyField } from "./canvas-property-controls";
import { Section } from "./canvas-property-section";

export function CanvasVectorControls({
  node,
  disabled,
  editing,
  onConvert,
  onEdit,
  onChange,
  onPreviewStart,
  onPreview,
  onPreviewEnd,
}: {
  node: CanvasFrame;
  disabled: boolean;
  editing: boolean;
  onConvert: () => void;
  onEdit: () => void;
  onChange: (vector: CanvasVectorData) => void;
  onPreviewStart: () => void;
  onPreview: (vector: CanvasVectorData) => void;
  onPreviewEnd: (cancel: boolean) => void;
}) {
  if (!["svg", "rectangle", "pen"].includes(node.kind ?? "frame")) return null;
  const vector = node.kind === "svg" ? (node as EditableCanvasSvg).vector : undefined;

  return (
    <Section title="Vector">
      <div className="canvas-properties-stack">
        <button
          type="button"
          className="canvas-property-text-button"
          disabled={disabled || editing}
          onClick={vector ? onEdit : onConvert}
        >
          <PenLineIcon size={13} />
          {editing ? "Editing points" : vector ? "Edit points" : "Convert to vector"}
        </button>
        {vector && (
          <>
            <div className="canvas-properties-grid">
              <label className="canvas-property-select">
                <select
                  aria-label="Vector fill"
                  disabled={disabled}
                  value={vector.fill === "none" ? "none" : "color"}
                  onChange={(event) =>
                    onChange({
                      ...vector,
                      fill: event.target.value === "none" ? "none" : "#000000",
                    })
                  }
                >
                  <option value="none">No fill</option>
                  <option value="color">Fill</option>
                </select>
              </label>
              {vector.fill !== "none" && (
                <ColorSwatch
                  label="Vector fill color"
                  value={vector.fill}
                  disabled={disabled}
                  onStart={onPreviewStart}
                  onPreview={(fill) => onPreview({ ...vector, fill })}
                  onEnd={onPreviewEnd}
                />
              )}
            </div>
            <div className="canvas-properties-grid">
              <label className="canvas-property-select">
                <select
                  aria-label="Vector stroke"
                  disabled={disabled}
                  value={vector.stroke === "none" ? "none" : "color"}
                  onChange={(event) =>
                    onChange({
                      ...vector,
                      stroke: event.target.value === "none" ? "none" : "#000000",
                    })
                  }
                >
                  <option value="none">No stroke</option>
                  <option value="color">Stroke</option>
                </select>
              </label>
              {vector.stroke !== "none" && (
                <ColorSwatch
                  label="Vector stroke color"
                  value={vector.stroke}
                  disabled={disabled}
                  onStart={onPreviewStart}
                  onPreview={(stroke) => onPreview({ ...vector, stroke })}
                  onEnd={onPreviewEnd}
                />
              )}
            </div>
            {vector.stroke !== "none" && (
              <PropertyField
                label="Vector stroke width"
                prefix="W"
                numeric
                min={0}
                value={vector.strokeWidth}
                disabled={disabled}
                onCommit={(value) => {
                  const strokeWidth = Number(value);
                  if (Number.isFinite(strokeWidth) && strokeWidth >= 0)
                    onChange({ ...vector, strokeWidth });
                }}
              />
            )}
          </>
        )}
      </div>
    </Section>
  );
}

export function CanvasVectorBooleanControls({
  disabled,
  onBoolean,
}: {
  disabled: boolean;
  onBoolean: (operation: CanvasVectorBoolean) => void;
}) {
  return (
    <Section title="Combine shapes">
      <div className="canvas-properties-grid">
        {(["union", "subtract", "intersect", "exclude"] as const).map((operation) => (
          <button
            key={operation}
            type="button"
            className="canvas-property-text-button"
            disabled={disabled}
            onClick={() => onBoolean(operation)}
          >
            {operation[0].toUpperCase() + operation.slice(1)}
          </button>
        ))}
      </div>
    </Section>
  );
}
