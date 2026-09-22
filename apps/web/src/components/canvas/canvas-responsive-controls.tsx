import type {
  CanvasDocument,
  CanvasFrame,
  CanvasProperty,
  CanvasPropertyOptions,
} from "@flies/canvas";
import { ChevronDownIcon } from "lucide-react";

import { PropertyField } from "./canvas-property-controls";
import { Section } from "./canvas-property-section";

interface Props {
  nodes: readonly CanvasFrame[];
  document: CanvasDocument;
  disabled: boolean;
  onChange: (
    property: CanvasProperty,
    value: string | number | boolean,
    options?: CanvasPropertyOptions,
  ) => void;
}

function common<T>(nodes: readonly CanvasFrame[], value: (node: CanvasFrame) => T): T | undefined {
  const first = value(nodes[0]);

  return nodes.every((node) => value(node) === first) ? first : undefined;
}

export function CanvasSizeConstraints({ nodes, document, disabled, onChange }: Props) {
  const supportsLimits = nodes.every((node) => node.kind !== "group" && node.kind !== "page");

  const freeChildren = nodes.every((node) => {
    const parent = node.parentId ? document.getFrame(node.parentId) : undefined;

    return parent && (!parent.kind || parent.kind === "frame") && !parent.layout;
  });

  return (
    <Section title="Size limits and constraints">
      {supportsLimits && (
        <div className="canvas-properties-grid">
          {(["minWidth", "maxWidth", "minHeight", "maxHeight"] as const).map((property) => (
            <PropertyField
              key={property}
              label={
                {
                  minWidth: "Minimum width",
                  maxWidth: "Maximum width",
                  minHeight: "Minimum height",
                  maxHeight: "Maximum height",
                }[property]
              }
              prefix={property.startsWith("min") ? "Min" : "Max"}
              value={common(nodes, (node) => node[property] ?? "")}
              suffix={property.endsWith("Width") ? "W" : "H"}
              disabled={disabled}
              onCommit={(value) => onChange(property, value.trim() === "" ? "" : Number(value))}
            />
          ))}
        </div>
      )}
      {freeChildren && (
        <div className="canvas-property-option">
          <label>
            <input
              type="checkbox"
              aria-label="Resize with parent"
              disabled={disabled}
              checked={nodes.every((node) => node.constraints !== undefined)}
              onChange={(event) => onChange("constraintsEnabled", event.target.checked)}
            />
            <span>Resize with parent</span>
          </label>
        </div>
      )}
      {freeChildren && nodes.some((node) => node.constraints !== undefined) && (
        <div className="canvas-properties-grid">
          {(["horizontal", "vertical"] as const).map((axis) => (
            <label className="canvas-property-select" key={axis}>
              <select
                aria-label={`${axis === "horizontal" ? "Horizontal" : "Vertical"} resize constraint`}
                value={
                  common(nodes, (node) =>
                    node.constraints ? (node.constraints[axis] ?? "start") : undefined,
                  ) ?? "mixed"
                }
                disabled={disabled}
                onChange={(event) =>
                  onChange(
                    axis === "horizontal" ? "constraintHorizontal" : "constraintVertical",
                    event.target.value,
                  )
                }
              >
                <option value="mixed" disabled>
                  Mixed
                </option>
                <option value="start">{axis === "horizontal" ? "Left" : "Top"}</option>
                <option value="end">{axis === "horizontal" ? "Right" : "Bottom"}</option>
                <option value="center">Center</option>
                <option value="stretch">
                  {axis === "horizontal" ? "Left and right" : "Top and bottom"}
                </option>
                <option value="scale">Scale</option>
              </select>
              <ChevronDownIcon size={13} aria-hidden="true" />
            </label>
          ))}
        </div>
      )}
      <p className="canvas-property-hint">
        {supportsLimits
          ? "Leave limits blank for no limit."
          : "Group dimensions follow their contents."}
        {freeChildren ? " Constraints respond to parent resizing." : ""}
      </p>
    </Section>
  );
}

export function CanvasWrappingControls({ nodes, disabled, onChange }: Omit<Props, "document">) {
  const frames = nodes.filter((node) => (!node.kind || node.kind === "frame") && node.layout);
  if (!frames.length) return null;

  return (
    <>
      <div className="canvas-property-option">
        <label>
          <input
            type="checkbox"
            aria-label="Wrap layout"
            disabled={disabled}
            checked={frames.every(
              (node) => (!node.kind || node.kind === "frame") && node.layout?.wrap,
            )}
            onChange={(event) => onChange("layoutWrap", event.target.checked)}
          />
          <span>Wrap to next line</span>
        </label>
      </div>
      <div className="canvas-properties-grid">
        {(["Top", "Right", "Bottom", "Left"] as const).map((side) => (
          <PropertyField
            key={side}
            label={`${side} padding`}
            prefix={side.slice(0, 1)}
            disabled={disabled}
            value={common(frames, (node) =>
              !node.kind || node.kind === "frame"
                ? (node.layout?.[`padding${side}`] ?? node.layout?.padding)
                : undefined,
            )}
            onCommit={(value) =>
              onChange(`layoutPadding${side}`, value.trim() === "" ? "" : Number(value))
            }
          />
        ))}
        {frames.some((node) => (!node.kind || node.kind === "frame") && node.layout?.wrap) && (
          <PropertyField
            label="Line gap"
            prefix="↕"
            disabled={disabled}
            value={common(frames, (node) =>
              !node.kind || node.kind === "frame"
                ? (node.layout?.rowGap ?? node.layout?.gap)
                : undefined,
            )}
            onCommit={(value) => onChange("layoutRowGap", value.trim() === "" ? "" : Number(value))}
          />
        )}
      </div>
    </>
  );
}
