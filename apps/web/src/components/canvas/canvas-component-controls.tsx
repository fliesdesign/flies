import type { CanvasComponentFields, CanvasFrame } from "@flies/canvas";
import { ComponentIcon, CopyIcon, Link2OffIcon, RotateCcwIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { IconButton, Section } from "./canvas-property-section";

export type CanvasComponentControlProps = {
  node: CanvasFrame;
  components: readonly CanvasFrame[];
  disabled: boolean;
  onCreate: (id: string) => void;
  onInsert: (componentId: string, variantId?: string) => void;
  onDetach: (instanceId: string) => void;
  onReset: (instanceId: string) => void;
  onVariant: (instanceId: string, variantId?: string) => void;
  onSaveVariant: (instanceId: string, name: string) => void;
  onRemoveVariant: (componentId: string, variantId: string) => void;
  onSelectSource: (componentId: string) => void;
};

/** Reuse the properties panel's compact fields so components remain part of normal layer editing. */
export function CanvasComponentControls({
  node,
  components,
  disabled,
  onCreate,
  onInsert,
  onDetach,
  onReset,
  onVariant,
  onSaveVariant,
  onRemoveVariant,
  onSelectSource,
}: CanvasComponentControlProps) {
  const [variantDraft, setVariantDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [selectedVariant, setSelectedVariant] = useState("");
  const value = node as CanvasFrame & CanvasComponentFields;
  const instance = value.instance;

  const source = instance
    ? components.find((component) => component.id === instance.componentId)
    : value;

  const definition = (source as (CanvasFrame & CanvasComponentFields) | undefined)?.component;
  if (node.kind !== undefined && node.kind !== "frame") return null;

  if (!instance && !definition) {
    return (
      <Section title="Component">
        <button
          type="button"
          className="canvas-property-text-button"
          disabled={disabled}
          onClick={() => onCreate(node.id)}
        >
          <ComponentIcon size={13} />
          Create component
        </button>
      </Section>
    );
  }

  const variantId =
    instance?.variantId ??
    (definition?.variants.some((variant) => variant.id === selectedVariant) ? selectedVariant : "");

  return (
    <Section
      title={instance ? "Instance" : "Component"}
      actions={
        instance ? (
          <>
            <IconButton
              label="Reset overrides"
              disabled={disabled || !instance.overrides.length}
              onClick={() => onReset(node.id)}
            >
              <RotateCcwIcon size={13} />
            </IconButton>
            <IconButton
              label="Detach instance"
              disabled={disabled}
              onClick={() => onDetach(node.id)}
            >
              <Link2OffIcon size={13} />
            </IconButton>
          </>
        ) : undefined
      }
    >
      <div className="canvas-properties-stack">
        {instance && source && (
          <button
            type="button"
            className="canvas-property-text-button"
            onClick={() => onSelectSource(source.id)}
            title="Go to main component"
          >
            <ComponentIcon size={13} />
            {source.name}
          </button>
        )}
        <div className="canvas-properties-grid">
          <label className="canvas-property-select">
            <select
              aria-label="Component variant"
              disabled={disabled}
              value={variantId}
              onChange={(event) => {
                if (instance) onVariant(node.id, event.target.value || undefined);
                else setSelectedVariant(event.target.value);
              }}
            >
              <option value="">Default</option>
              {definition?.variants.map((variant) => (
                <option key={variant.id} value={variant.id}>
                  {variant.name}
                </option>
              ))}
            </select>
          </label>
          {!instance && variantId && (
            <IconButton
              label="Remove variant"
              disabled={disabled}
              onClick={() => onRemoveVariant(node.id, variantId)}
            >
              <Trash2Icon size={13} />
            </IconButton>
          )}
        </div>
        {instance ? (
          <>
            <p className="canvas-property-hint">
              {instance.overrides.length
                ? `${instance.overrides.length} layer override${instance.overrides.length === 1 ? "" : "s"}`
                : "Linked to the main component"}
            </p>
            {saving ? (
              <form
                className="canvas-properties-stack"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!variantDraft.trim()) return;
                  onSaveVariant(node.id, variantDraft.trim());
                  setSaving(false);
                  setVariantDraft("");
                }}
              >
                <label className="canvas-property-field">
                  <input
                    aria-label="Variant name"
                    placeholder="Variant name"
                    value={variantDraft}
                    onChange={(event) => setVariantDraft(event.target.value)}
                    disabled={disabled}
                  />
                </label>
                <div className="canvas-properties-grid">
                  <button
                    type="button"
                    className="canvas-property-text-button"
                    onClick={() => setSaving(false)}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="canvas-property-text-button"
                    disabled={disabled || !variantDraft.trim()}
                  >
                    Save variant
                  </button>
                </div>
              </form>
            ) : (
              <button
                type="button"
                className="canvas-property-text-button"
                disabled={disabled}
                onClick={() => setSaving(true)}
              >
                Save as variant
              </button>
            )}
          </>
        ) : (
          <button
            type="button"
            className="canvas-property-text-button"
            disabled={disabled}
            onClick={() => onInsert(node.id, variantId || undefined)}
          >
            <CopyIcon size={13} />
            Create instance
          </button>
        )}
      </div>
    </Section>
  );
}

export function CanvasComponentLibrary({
  components,
  disabled,
  onInsert,
}: {
  components: readonly CanvasFrame[];
  disabled: boolean;
  onInsert: (componentId: string) => void;
}) {
  const [selected, setSelected] = useState("");

  const available = components.filter(
    (node) => (node as CanvasFrame & CanvasComponentFields).component,
  );

  if (!available.length) return null;
  const id = available.some((node) => node.id === selected) ? selected : available[0].id;

  return (
    <Section title="Components">
      <div className="canvas-properties-stack">
        <label className="canvas-property-select">
          <select
            aria-label="Insert component"
            value={id}
            disabled={disabled}
            onChange={(event) => setSelected(event.target.value)}
          >
            {available.map((component) => (
              <option key={component.id} value={component.id}>
                {component.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="canvas-property-text-button"
          disabled={disabled}
          onClick={() => onInsert(id)}
        >
          <ComponentIcon size={13} />
          Insert instance
        </button>
      </div>
    </Section>
  );
}
