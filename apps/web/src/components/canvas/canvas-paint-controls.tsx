import {
  CANVAS_BLEND_MODES,
  CANVAS_FILTERS,
  gradientCss,
  type CanvasFilterName,
  type CanvasFrame,
  type CanvasProperty,
  type CanvasPropertyOptions,
} from "@flies/canvas";
import { PlusIcon, MinusIcon } from "lucide-react";

import { ColorSwatch, PropertyField } from "./canvas-property-controls";
import { IconButton, Section } from "./canvas-property-section";
import { normalizeCanvasHex } from "./canvas-property-values";

type Change = (
  property: CanvasProperty,
  value: string | number | boolean,
  options?: CanvasPropertyOptions,
) => void;
export type PaintControlProps = {
  nodes: readonly CanvasFrame[];
  disabled: boolean;
  onChange: Change;
  onPreviewStart: () => void;
  onPreview: Change;
  onPreviewEnd: (cancel: boolean) => void;
};

const common = <T,>(values: readonly T[]) =>
  values.every((v) => v === values[0]) ? values[0] : undefined;

export function CanvasGradientControls({
  nodes,
  disabled,
  onChange,
  onPreviewStart,
  onPreview,
  onPreviewEnd,
}: PaintControlProps) {
  const type = common(nodes.map((node) => node.gradient?.type ?? "solid"));
  const count = Math.max(0, ...nodes.map((node) => node.gradient?.stops.length ?? 0));
  const preview = nodes.find((node) => node.gradient)?.gradient;

  return (
    <>
      <fieldset className="canvas-properties-segmented" aria-label="Fill type">
        {(["solid", "linear", "radial"] as const).map((value) => (
          <IconButton
            key={value}
            label={`${value[0].toUpperCase() + value.slice(1)} fill`}
            active={type === value}
            disabled={disabled}
            onClick={() => onChange("gradientType", value)}
          >
            <span>{value[0].toUpperCase() + value.slice(1)}</span>
          </IconButton>
        ))}
      </fieldset>
      {count > 0 && (
        <>
          <div
            className="canvas-gradient-preview"
            style={{ background: preview ? gradientCss(preview) : undefined }}
            aria-hidden="true"
          />
          {nodes.some((node) => !node.gradient || node.gradient.stops.length !== count) && (
            <p className="canvas-property-hint">
              Different fills. Stop edits affect layers with the matching stop.
            </p>
          )}
          <label className="canvas-property-select">
            <select
              aria-label="Gradient interpolation"
              value={common(nodes.map((node) => node.gradient?.interpolation ?? "srgb")) ?? ""}
              disabled={disabled}
              onChange={(event) => onChange("gradientInterpolation", event.target.value)}
            >
              <option value="" disabled>
                Mixed interpolation
              </option>
              <option value="srgb">sRGB</option>
              <option value="oklab">Oklab</option>
            </select>
          </label>
          {nodes.some((node) => node.gradient?.background) && (
            <div className="canvas-filter-control">
              <span>Background</span>
              <ColorSwatch
                label="Gradient background"
                value={common(nodes.map((node) => node.gradient?.background ?? "#00000000"))}
                disabled={disabled}
                onStart={onPreviewStart}
                onPreview={(value) => onPreview("gradientBackground", value)}
                onEnd={onPreviewEnd}
              />
            </div>
          )}
          {type !== "radial" && (
            <PropertyField
              label="Gradient angle"
              prefix="∠"
              value={common(nodes.map((node) => node.gradient?.angle))}
              numeric
              suffix="°"
              disabled={disabled}
              onCommit={(value) => onChange("gradientAngle", Number(value))}
              preview={{
                onStart: onPreviewStart,
                onPreview: (value) => onPreview("gradientAngle", value),
                onEnd: onPreviewEnd,
              }}
            />
          )}
          {Array.from({ length: count }, (_, index) => {
            const options = { gradientStop: index };
            const color = common(nodes.map((node) => node.gradient?.stops[index]?.color));
            const offset = common(nodes.map((node) => node.gradient?.stops[index]?.offset));
            const label = `Gradient stop ${index + 1}`;

            return (
              <div key={`${count}:${index}`} className="canvas-gradient-stop">
                <ColorSwatch
                  label={`${label} color`}
                  value={color}
                  disabled={disabled}
                  onStart={onPreviewStart}
                  onPreview={(value) => onPreview("gradientStopColor", value, options)}
                  onEnd={onPreviewEnd}
                />
                <PropertyField
                  label={`${label} color`}
                  prefix="#"
                  value={color?.replace(/^#/, "").toUpperCase()}
                  disabled={disabled}
                  onCommit={(value) => {
                    const hex = normalizeCanvasHex(value);
                    if (hex) onChange("gradientStopColor", hex, options);
                  }}
                />
                <PropertyField
                  label={`${label} position`}
                  value={offset === undefined ? undefined : offset * 100}
                  numeric
                  min={0}
                  max={100}
                  suffix="%"
                  disabled={disabled}
                  onCommit={(value) => onChange("gradientStopOffset", Number(value) / 100, options)}
                />
                <IconButton
                  label={`Remove gradient stop ${index + 1}`}
                  disabled={
                    disabled || nodes.some((node) => (node.gradient?.stops.length ?? 0) <= 2)
                  }
                  onClick={() => onChange("gradientStopRemove", true, options)}
                >
                  <MinusIcon size={13} />
                </IconButton>
              </div>
            );
          })}
          <button
            type="button"
            className="canvas-property-text-button"
            disabled={disabled || nodes.some((node) => (node.gradient?.stops.length ?? 0) >= 16)}
            onClick={() => onChange("gradientStopAdd", true)}
          >
            <PlusIcon size={13} />
            Add color stop
          </button>
        </>
      )}
    </>
  );
}

export function CanvasBlendControls({ nodes, disabled, onChange }: PaintControlProps) {
  const mode = common(nodes.map((node) => node.blendMode ?? "normal"));

  return (
    <label className="canvas-property-select">
      <select
        aria-label="Blend mode"
        value={mode ?? ""}
        disabled={disabled}
        onChange={(event) => onChange("blendMode", event.target.value)}
      >
        {mode === undefined && (
          <option value="" disabled>
            Mixed
          </option>
        )}
        {CANVAS_BLEND_MODES.map((value) => (
          <option key={value} value={value}>
            {value[0].toUpperCase() + value.slice(1).replace(/-/g, " ")}
          </option>
        ))}
      </select>
    </label>
  );
}

export function CanvasFilterControls({
  nodes,
  disabled,
  onChange,
  onPreviewStart,
  onPreview,
  onPreviewEnd,
}: PaintControlProps) {
  const hasFilters = nodes.some((node) => node.filters !== undefined);

  return (
    <Section
      key={String(hasFilters)}
      title="Filters"
      actions={
        <IconButton
          label={hasFilters ? "Remove filters" : "Add filters"}
          disabled={disabled}
          onClick={() =>
            onChange(hasFilters ? "filtersReset" : "filterValue", 4, { filterName: "blur" })
          }
        >
          {hasFilters ? <MinusIcon size={15} /> : <PlusIcon size={15} />}
        </IconButton>
      }
    >
      {hasFilters && (
        <div className="canvas-properties-grid">
          {(Object.keys(CANVAS_FILTERS) as CanvasFilterName[]).map((key) => {
            const config = CANVAS_FILTERS[key],
              scale = key === "blur" || key === "hue" ? 1 : 100;

            const value = common(nodes.map((node) => node.filters?.[key] ?? config.initial));
            const options = { filterName: key };

            return (
              <div key={key} className="canvas-filter-control">
                <span>{config.label}</span>
                <PropertyField
                  label={`${config.label} filter`}
                  value={value === undefined ? undefined : value * scale}
                  prefix={key === "blur" ? "B" : key === "hue" ? "H" : "%"}
                  numeric
                  min={config.min * scale}
                  max={config.max * scale}
                  disabled={disabled}
                  onCommit={(next) => onChange("filterValue", Number(next) / scale, options)}
                  preview={{
                    onStart: onPreviewStart,
                    onPreview: (next) => onPreview("filterValue", next / scale, options),
                    onEnd: onPreviewEnd,
                  }}
                />
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}
