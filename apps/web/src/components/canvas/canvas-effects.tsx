import type {
  CanvasFrame,
  CanvasProperty,
  CanvasPropertyOptions,
  CanvasShadow,
} from "@flies/canvas";
import { MinusIcon, PlusIcon } from "lucide-react";

import { ColorSwatch, PropertyField } from "./canvas-property-controls";
import { IconButton, Section } from "./canvas-property-section";
import { normalizeCanvasHex } from "./canvas-property-values";

type Change = (
  property: CanvasProperty,
  value: string | number | boolean,
  options?: CanvasPropertyOptions,
) => void;

type EffectsProps = {
  nodes: readonly CanvasFrame[];
  disabled: boolean;
  onChange: Change;
  onPreviewStart: () => void;
  onPreview: Change;
  onPreviewEnd: (cancel: boolean) => void;
};

function common<T>(values: readonly T[]): T | undefined {
  return values.length && values.every((value) => value === values[0]) ? values[0] : undefined;
}

export function CanvasEffects({
  nodes,
  disabled,
  onChange,
  onPreviewStart,
  onPreview,
  onPreviewEnd,
}: EffectsProps) {
  const hasBorder = nodes.some((node) => node.borderWidth !== undefined);

  function colorField(
    label: string,
    property: CanvasProperty,
    value: string | undefined,
    options?: CanvasPropertyOptions,
  ) {
    return (
      <div className="canvas-properties-color">
        <ColorSwatch
          label={label}
          value={value}
          disabled={disabled}
          onStart={onPreviewStart}
          onPreview={(next) => onPreview(property, next, options)}
          onEnd={onPreviewEnd}
        />
        <PropertyField
          label={label}
          prefix="#"
          value={value?.replace(/^#/, "").toUpperCase()}
          disabled={disabled}
          onCommit={(next) => {
            const hex = normalizeCanvasHex(next);
            if (hex) onChange(property, hex, options);
          }}
        />
      </div>
    );
  }

  function numericField(
    label: string,
    prefix: string,
    property: CanvasProperty,
    value: number | undefined,
    min?: number,
    options?: CanvasPropertyOptions,
  ) {
    return (
      <PropertyField
        label={label}
        prefix={prefix}
        value={value}
        numeric
        min={min}
        disabled={disabled}
        onCommit={(next) => onChange(property, Number(next), options)}
        preview={{
          onStart: onPreviewStart,
          onPreview: (next) => onPreview(property, next, options),
          onEnd: onPreviewEnd,
        }}
      />
    );
  }

  return (
    <>
      <Section
        key={String(hasBorder)}
        title="Border"
        actions={
          <IconButton
            label={hasBorder ? "Remove border" : "Add border"}
            disabled={disabled}
            onClick={() => onChange(hasBorder ? "borderRemove" : "borderWidth", 1)}
          >
            {hasBorder ? <MinusIcon size={15} /> : <PlusIcon size={15} />}
          </IconButton>
        }
      >
        {hasBorder && (
          <>
            {colorField(
              "Border color",
              "borderColor",
              common(nodes.map((node) => node.borderColor ?? "#000000")),
            )}
            {numericField(
              "Border width",
              "W",
              "borderWidth",
              common(nodes.map((node) => node.borderWidth ?? 0)),
              0,
            )}
          </>
        )}
      </Section>
      {[false, true].map((inset) => {
        const title = inset ? "Inner shadow" : "Shadow";

        const stacks = nodes.map((node) =>
          (node.shadows ?? []).filter((shadow) => Boolean(shadow.inset) === inset),
        );

        const count = Math.max(0, ...stacks.map((stack) => stack.length));
        const mixedCount = stacks.some((stack) => stack.length !== count);

        return (
          <Section
            key={`${title}:${count}`}
            title={title}
            actions={
              <IconButton
                label={`Add ${title.toLowerCase()}`}
                disabled={disabled || nodes.some((node) => (node.shadows?.length ?? 0) >= 8)}
                onClick={() => onChange("shadowAdd", true, { shadowInset: inset })}
              >
                <PlusIcon size={15} />
              </IconButton>
            }
          >
            {mixedCount && (
              <p className="canvas-property-hint">
                Different shadow counts. Edits affect layers with the matching shadow.
              </p>
            )}
            {Array.from({ length: count }, (_, index) => {
              const options = { shadowInset: inset, shadowIndex: index };

              const value = <K extends keyof CanvasShadow>(key: K) =>
                common(stacks.map((stack) => stack[index]?.[key]));

              return (
                <fieldset
                  key={index}
                  className="canvas-effect-card"
                  aria-label={`${title} ${index + 1}`}
                >
                  <div className="canvas-effect-heading">
                    <span>
                      {title} {index + 1}
                    </span>
                    <IconButton
                      label={`Remove ${title.toLowerCase()} ${index + 1}`}
                      disabled={disabled}
                      onClick={() => onChange("shadowRemove", true, options)}
                    >
                      <MinusIcon size={14} />
                    </IconButton>
                  </div>
                  {colorField(
                    `${title} ${index + 1} color`,
                    "shadowColor",
                    value("color"),
                    options,
                  )}
                  <div className="canvas-properties-grid">
                    {numericField(
                      `${title} ${index + 1} X offset`,
                      "X",
                      "shadowOffsetX",
                      value("offsetX"),
                      undefined,
                      options,
                    )}
                    {numericField(
                      `${title} ${index + 1} Y offset`,
                      "Y",
                      "shadowOffsetY",
                      value("offsetY"),
                      undefined,
                      options,
                    )}
                    {numericField(
                      `${title} ${index + 1} blur`,
                      "Blur",
                      "shadowBlur",
                      value("blur"),
                      0,
                      options,
                    )}
                    {numericField(
                      `${title} ${index + 1} spread`,
                      "Spread",
                      "shadowSpread",
                      value("spread"),
                      undefined,
                      options,
                    )}
                  </div>
                </fieldset>
              );
            })}
          </Section>
        );
      })}
    </>
  );
}
