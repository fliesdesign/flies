import {
  applyTokenBindings,
  THEME_PROPERTIES,
  tokenMatchesProperty,
  type ThemeProperty,
} from "@flies/canvas";
import type { CanvasArrangeAction } from "@flies/canvas";
import type { CanvasDocument, CanvasFrame } from "@flies/canvas";
import type { CanvasProperty, CanvasPropertyOptions } from "@flies/canvas";
import {
  AlignCenterIcon,
  AlignLeftIcon,
  AlignRightIcon,
  ChevronDownIcon,
  EyeIcon,
  EyeOffIcon,
  LinkIcon,
  LockKeyholeIcon,
  PanelRightCloseIcon,
  ScanTextIcon,
  UnlinkIcon,
  UnlockKeyholeIcon,
} from "lucide-react";
import { memo, useCallback, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";

import { prepareTokenUpdates } from "@/lib/canvas-theme-actions";

import { CanvasFontPicker } from "./canvas-font-picker";
import { ColorSwatch, PropertyField, type PropertyPreview } from "./canvas-property-controls";
import { normalizeCanvasHex } from "./canvas-property-values";
import { CanvasTokenSelect, type TokenChoiceProps } from "./canvas-token-select";
import "./canvas-properties.css";

export type { CanvasProperty, CanvasPropertyOptions } from "@flies/canvas";

type CanvasPropertiesProps = {
  document: CanvasDocument;
  selectedIds: readonly string[];
  onChange: (
    property: CanvasProperty,
    value: string | number | boolean,
    options?: CanvasPropertyOptions,
  ) => void;
  onPreviewStart: () => void;
  onPreview: (
    property: CanvasProperty,
    value: string | number | boolean,
    options?: CanvasPropertyOptions,
  ) => void;
  onPreviewEnd: (cancel: boolean) => void;
  onArrange: (action: CanvasArrangeAction) => void;
  onFitText: () => void;
  onCollapse: () => void;
};

function IconButton({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="canvas-property-icon-button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function AlignIcon({ action }: { action: CanvasArrangeAction }) {
  const paths: Partial<Record<CanvasArrangeAction, ReactNode>> = {
    left: (
      <>
        <path d="M3 3v14" />
        <rect x="6" y="5" width="10" height="3" />
        <rect x="6" y="12" width="6" height="3" />
      </>
    ),
    center: (
      <>
        <path d="M10 2v3m0 10v3" />
        <rect x="4" y="6" width="12" height="3" />
        <rect x="6" y="12" width="8" height="3" />
      </>
    ),
    right: (
      <>
        <path d="M17 3v14" />
        <rect x="4" y="5" width="10" height="3" />
        <rect x="8" y="12" width="6" height="3" />
      </>
    ),
    top: (
      <>
        <path d="M3 3h14" />
        <rect x="5" y="6" width="3" height="10" />
        <rect x="12" y="6" width="3" height="6" />
      </>
    ),
    middle: (
      <>
        <path d="M2 10h3m10 0h3" />
        <rect x="6" y="4" width="3" height="12" />
        <rect x="12" y="6" width="3" height="8" />
      </>
    ),
    bottom: (
      <>
        <path d="M3 17h14" />
        <rect x="5" y="4" width="3" height="10" />
        <rect x="12" y="8" width="3" height="6" />
      </>
    ),
  };
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[action]}
    </svg>
  );
}

function Section({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="canvas-properties-section" aria-label={title}>
      <div className="canvas-properties-section-heading">
        <h3>{title}</h3>
        {actions && <div className="canvas-properties-actions">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

function PropertySelect({
  label,
  value,
  disabled,
  choices,
  onChange,
  tokens,
  tokenId,
  onToken,
}: {
  label: string;
  value: string | number | undefined;
  disabled?: boolean;
  choices: readonly { value: string | number; label: string }[];
  onChange: (value: string) => void;
} & TokenChoiceProps) {
  const select = (
    <label className="canvas-property-select" data-disabled={disabled || undefined}>
      <select
        aria-label={label}
        title={label}
        value={value ?? ""}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {value === undefined && (
          <option value="" disabled>
            Mixed
          </option>
        )}
        {choices.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </select>
      <ChevronDownIcon size={13} aria-hidden="true" />
    </label>
  );
  if (!tokens?.length || !onToken) return select;
  return (
    <div className="canvas-property-select-stack">
      <CanvasTokenSelect
        tokens={tokens}
        tokenId={tokenId}
        onToken={onToken}
        label={label}
        disabled={disabled}
      />
      {select}
    </div>
  );
}

function commonValue<T>(
  nodes: readonly CanvasFrame[],
  read: (node: CanvasFrame) => T,
): T | undefined {
  if (!nodes.length) return undefined;
  const first = read(nodes[0]);
  return nodes.every((node) => read(node) === first) ? first : undefined;
}

function fillFor(node: CanvasFrame) {
  switch (node.kind) {
    case "text":
      return node.color;
    case "rectangle":
      return node.fill;
    case "pen":
      return node.stroke;
    case undefined:
    case "frame":
      return node.fill ?? "#ffffff";
    default:
      return undefined;
  }
}

const ALIGN_ACTIONS = [
  { action: "left", label: "Align left" },
  { action: "center", label: "Align horizontal centers" },
  { action: "right", label: "Align right" },
  { action: "top", label: "Align top" },
  { action: "middle", label: "Align vertical centers" },
  { action: "bottom", label: "Align bottom" },
] as const;
const WEIGHT_CHOICES = [
  { value: 100, label: "Thin" },
  { value: 200, label: "Extra light" },
  { value: 300, label: "Light" },
  { value: 400, label: "Regular" },
  { value: 500, label: "Medium" },
  { value: 600, label: "Semibold" },
  { value: 700, label: "Bold" },
  { value: 800, label: "Extra bold" },
  { value: 900, label: "Black" },
];

function createSelectionSnapshot(document: CanvasDocument, selectedIds: readonly string[]) {
  let cached: { revision: number; nodes: CanvasFrame[] } | undefined;
  return () => {
    const nodes = selectedIds
      .map((id) => document.getFrame(id))
      .filter((node): node is CanvasFrame => !!node);
    const revision = document.getSnapshot().revision;
    if (
      !cached ||
      cached.revision !== revision ||
      cached.nodes.length !== nodes.length ||
      nodes.some((node, index) => node !== cached!.nodes[index])
    ) {
      cached = { revision, nodes };
    }
    return cached;
  };
}

function useSelectedNodes(document: CanvasDocument, selectedIds: readonly string[]) {
  const getSnapshot = useMemo(
    () => createSelectionSnapshot(document, selectedIds),
    [document, selectedIds],
  );
  const subscribe = useCallback(
    (listener: () => void) => {
      const unsubscribe = [
        document.subscribe(listener),
        ...selectedIds.map((id) => document.subscribeFrame(id, listener)),
      ];
      return () => unsubscribe.forEach((stop) => stop());
    },
    [document, selectedIds],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot).nodes;
}

export const CanvasProperties = memo(function CanvasProperties({
  document,
  selectedIds,
  onChange,
  onPreviewStart,
  onPreview,
  onPreviewEnd,
  onArrange,
  onFitText,
  onCollapse,
}: CanvasPropertiesProps) {
  const nodes = useSelectedNodes(document, selectedIds);
  const theme = useSyncExternalStore(document.subscribe, document.getTheme, document.getTheme);
  const [tokenError, setTokenError] = useState("");
  const tokenChoice = (property: ThemeProperty) => ({
    tokens: theme.tokens
      .filter((token) => tokenMatchesProperty(token, property))
      .slice()
      .sort(
        (left, right) =>
          Number(right.type === THEME_PROPERTIES[property]) -
          Number(left.type === THEME_PROPERTIES[property]),
      ),
    tokenId: commonValue(nodes, (node) => node.tokenBindings?.[property]),
    onToken: (id: string | null) => {
      onPreviewEnd(true);
      setTokenError("");
      void (async () => {
        const before = nodes.map((node) => document.getFrame(node.id)!);
        const updates = before.map((node) => {
          const bindings = { ...node.tokenBindings };
          if (id) bindings[property] = id;
          else delete bindings[property];
          return applyTokenBindings(node, theme, bindings, true);
        });
        await prepareTokenUpdates(updates, before);
        if (
          document.getTheme() !== theme ||
          before.some((node) => document.getFrame(node.id) !== node)
        )
          throw new Error("Selection changed while loading its token. Try again.");
        if (
          !document.updateMany(updates) &&
          updates.some((node, index) => JSON.stringify(node) !== JSON.stringify(before[index]))
        )
          throw new Error("This token value is not valid for the selection.");
      })().catch((error: unknown) =>
        setTokenError(error instanceof Error ? error.message : String(error)),
      );
    },
  });
  const [preserveAspect, setPreserveAspect] = useState(false);
  const single = nodes.length === 1 ? nodes[0] : undefined;
  const selectedKey = nodes.map((node) => node.id).join(":");
  const anyLocked = nodes.some((node) => {
    let ancestor: CanvasFrame | undefined = node;
    while (ancestor) {
      if (ancestor.locked) return true;
      ancestor = ancestor.parentId ? document.getFrame(ancestor.parentId) : undefined;
    }
    return false;
  });
  const managedPosition = nodes.some((node) => {
    const parent = node.parentId ? document.getFrame(node.parentId) : undefined;
    return parent && (!parent.kind || parent.kind === "frame") && !!parent.layout;
  });
  const ownLocked = nodes.some((node) => node.locked);
  const allHidden = nodes.length > 0 && nodes.every((node) => node.hidden);
  const allText = nodes.length > 0 && nodes.every((node) => node.kind === "text");
  const hasFill = nodes.length > 0 && nodes.every((node) => fillFor(node) !== undefined);
  const hasRadius =
    nodes.length > 0 &&
    nodes.every((node) => !node.kind || ["frame", "rectangle", "image", "svg"].includes(node.kind));
  const allFrames = nodes.length > 0 && nodes.every((node) => !node.kind || node.kind === "frame");
  const allPens = nodes.length > 0 && nodes.every((node) => node.kind === "pen");
  const parent = single?.parentId ? document.getFrame(single.parentId) : undefined;
  const left = Math.min(...nodes.map((node) => node.x));
  const top = Math.min(...nodes.map((node) => node.y));
  const width = Math.max(...nodes.map((node) => node.x + node.width)) - left;
  const height = Math.max(...nodes.map((node) => node.y + node.height)) - top;
  const fill = commonValue(nodes, fillFor);
  const opacity = commonValue(nodes, (node) => node.opacity ?? 1);
  const radius = commonValue(nodes, (node) => node.cornerRadius ?? 0);
  const numberChange = (property: CanvasProperty) => (value: string) =>
    onChange(property, Number(value));
  const numberPreview = (
    property: CanvasProperty,
    scale = 1,
    options?: CanvasPropertyOptions,
  ): PropertyPreview => ({
    onStart: onPreviewStart,
    onPreview: (value) => onPreview(property, value * scale, options),
    onEnd: onPreviewEnd,
  });
  const layoutValue = <T,>(
    read: (layout: NonNullable<Extract<CanvasFrame, { kind?: "frame" }>["layout"]>) => T,
    fallback: T,
  ) =>
    commonValue(nodes, (node) =>
      (!node.kind || node.kind === "frame") && node.layout ? read(node.layout) : fallback,
    );
  const layoutMode = layoutValue((layout) => layout.direction as string, "none");
  const changeFill = (value: string) => {
    const hex = normalizeCanvasHex(value);
    if (hex) onChange("fill", hex);
  };
  const textValue = <T,>(read: (node: Extract<CanvasFrame, { kind: "text" }>) => T) =>
    commonValue(nodes, (node) => (node.kind === "text" ? read(node) : undefined));

  return (
    <aside
      className="canvas-properties"
      aria-label="Properties panel"
      data-canvas-ui=""
      tabIndex={-1}
    >
      <header className="canvas-properties-header">
        <div>
          <h2 title={single?.name}>
            {single?.name ?? (nodes.length > 1 ? `${nodes.length} layers` : "Canvas")}
          </h2>
          {single && <span>{single.kind ?? "frame"}</span>}
        </div>
        <IconButton label="Collapse properties" onClick={onCollapse}>
          <PanelRightCloseIcon size={16} />
        </IconButton>
      </header>
      <div className="canvas-properties-body" key={selectedKey}>
        {tokenError && (
          <p role="alert" className="canvas-theme-error">
            {tokenError}
          </p>
        )}
        {!nodes.length ? (
          <div className="canvas-properties-empty">
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.25"
              aria-hidden="true"
            >
              <path d="M5 3v15l4-4 3 7 3-1-3-7h6L5 3Z" />
            </svg>
            <p>Select a layer to edit its properties.</p>
          </div>
        ) : (
          <>
            <Section title="Layout">
              <div className="canvas-properties-align">
                {ALIGN_ACTIONS.map(({ action, label }) => (
                  <IconButton
                    key={action}
                    label={label}
                    disabled={nodes.length < 2 || anyLocked || managedPosition}
                    onClick={() => onArrange(action)}
                  >
                    <AlignIcon action={action} />
                  </IconButton>
                ))}
              </div>
              <div className="canvas-properties-grid">
                <PropertyField
                  label="X position"
                  prefix="X"
                  value={left - (parent?.x ?? 0)}
                  numeric
                  disabled={anyLocked || managedPosition}
                  preview={numberPreview("x")}
                  onCommit={numberChange("x")}
                />
                <PropertyField
                  label="Y position"
                  prefix="Y"
                  value={top - (parent?.y ?? 0)}
                  numeric
                  disabled={anyLocked || managedPosition}
                  preview={numberPreview("y")}
                  onCommit={numberChange("y")}
                />
                <PropertyField
                  label="Width"
                  prefix="W"
                  value={width}
                  numeric
                  min={1}
                  disabled={anyLocked}
                  preview={numberPreview("width", 1, { preserveAspect })}
                  onCommit={(value) => onChange("width", Number(value), { preserveAspect })}
                />
                <PropertyField
                  label="Height"
                  prefix="H"
                  value={height}
                  numeric
                  min={1}
                  disabled={anyLocked}
                  preview={numberPreview("height", 1, { preserveAspect })}
                  onCommit={(value) => onChange("height", Number(value), { preserveAspect })}
                />
              </div>
              {managedPosition && (
                <p className="canvas-property-hint">Position managed by auto layout.</p>
              )}
              <div className="canvas-property-option">
                <label>
                  <input
                    type="checkbox"
                    checked={preserveAspect}
                    disabled={anyLocked}
                    onChange={(event) => setPreserveAspect(event.target.checked)}
                  />
                  <span>Keep proportions</span>
                </label>
                {preserveAspect ? (
                  <LinkIcon size={13} aria-hidden="true" />
                ) : (
                  <UnlinkIcon size={13} aria-hidden="true" />
                )}
              </div>
              {allFrames && (
                <div className="canvas-property-option">
                  <label>
                    <input
                      type="checkbox"
                      checked={nodes.every(
                        (node) =>
                          (node.kind === "frame" || !node.kind) && node.clipContent !== false,
                      )}
                      disabled={anyLocked}
                      onChange={(event) => onChange("clipContent", event.target.checked)}
                    />
                    <span>Clip contents</span>
                  </label>
                </div>
              )}
            </Section>
            {allFrames && (
              <Section title="Auto layout">
                <PropertySelect
                  label="Auto layout direction"
                  value={layoutMode}
                  disabled={anyLocked}
                  choices={[
                    { value: "none", label: "Free layout" },
                    { value: "row", label: "Horizontal" },
                    { value: "column", label: "Vertical" },
                  ]}
                  onChange={(value) => onChange("layoutMode", value)}
                />
                {layoutMode !== "none" && (
                  <>
                    <div className="canvas-properties-grid">
                      <PropertyField
                        label="Layout gap"
                        {...tokenChoice("layoutGap")}
                        prefix="↔"
                        value={layoutValue((layout) => layout.gap, 16)}
                        numeric
                        min={0}
                        disabled={anyLocked}
                        preview={numberPreview("layoutGap")}
                        onCommit={numberChange("layoutGap")}
                      />
                      <PropertyField
                        label="Layout padding"
                        {...tokenChoice("layoutPadding")}
                        prefix="⊞"
                        value={layoutValue((layout) => layout.padding, 16)}
                        numeric
                        min={0}
                        disabled={anyLocked}
                        preview={numberPreview("layoutPadding")}
                        onCommit={numberChange("layoutPadding")}
                      />
                    </div>
                    <div className="canvas-property-labeled-select">
                      <span>Align</span>
                      <PropertySelect
                        label="Layout cross alignment"
                        value={layoutValue((layout) => layout.align, "start")}
                        disabled={anyLocked}
                        choices={[
                          { value: "start", label: "Start" },
                          { value: "center", label: "Center" },
                          { value: "end", label: "End" },
                        ]}
                        onChange={(value) => onChange("layoutAlign", value)}
                      />
                    </div>
                    <div className="canvas-property-labeled-select">
                      <span>Justify</span>
                      <PropertySelect
                        label="Layout main alignment"
                        value={layoutValue((layout) => layout.justify, "start")}
                        disabled={anyLocked}
                        choices={[
                          { value: "start", label: "Start" },
                          { value: "center", label: "Center" },
                          { value: "end", label: "End" },
                          { value: "space-between", label: "Space between" },
                        ]}
                        onChange={(value) => onChange("layoutJustify", value)}
                      />
                    </div>
                  </>
                )}
              </Section>
            )}
            <Section
              title="Appearance"
              actions={
                <>
                  <IconButton
                    label={allHidden ? "Show selection" : "Hide selection"}
                    active={allHidden}
                    onClick={() => onChange("hidden", !allHidden)}
                  >
                    {allHidden ? <EyeOffIcon size={15} /> : <EyeIcon size={15} />}
                  </IconButton>
                  <IconButton
                    label={ownLocked ? "Unlock selection" : "Lock selection"}
                    active={ownLocked}
                    onClick={() => onChange("locked", !ownLocked)}
                  >
                    {ownLocked ? <LockKeyholeIcon size={14} /> : <UnlockKeyholeIcon size={14} />}
                  </IconButton>
                </>
              }
            >
              <div className={hasRadius ? "canvas-properties-grid" : "canvas-properties-stack"}>
                <PropertyField
                  label="Opacity"
                  prefix={<span className="canvas-opacity-icon" />}
                  value={opacity === undefined ? undefined : opacity * 100}
                  numeric
                  min={0}
                  max={100}
                  suffix="%"
                  disabled={anyLocked}
                  preview={numberPreview("opacity", 0.01)}
                  onCommit={(value) => onChange("opacity", Number(value) / 100)}
                />
                {hasRadius && (
                  <PropertyField
                    label="Corner radius"
                    {...tokenChoice("cornerRadius")}
                    prefix={
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 14 14"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.3"
                        aria-hidden="true"
                      >
                        <path d="M3 11V7a4 4 0 0 1 4-4h4" />
                      </svg>
                    }
                    value={radius}
                    numeric
                    min={0}
                    disabled={anyLocked}
                    preview={numberPreview("cornerRadius")}
                    onCommit={numberChange("cornerRadius")}
                  />
                )}
              </div>
            </Section>
            {hasFill && (
              <Section title={allPens ? "Stroke" : "Fill"}>
                <div className="canvas-properties-color">
                  <ColorSwatch
                    {...tokenChoice("fill")}
                    value={fill}
                    disabled={anyLocked}
                    onStart={onPreviewStart}
                    onPreview={(value) => onPreview("fill", value)}
                    onEnd={onPreviewEnd}
                  />
                  <PropertyField
                    label={allPens ? "Stroke color" : "Fill color"}
                    value={fill?.replace(/^#/, "").toUpperCase()}
                    prefix="#"
                    disabled={anyLocked}
                    onCommit={changeFill}
                  />
                </div>
                {allPens && (
                  <PropertyField
                    label="Stroke width"
                    {...tokenChoice("strokeWidth")}
                    prefix="W"
                    value={commonValue(nodes, (node) =>
                      node.kind === "pen" ? node.strokeWidth : undefined,
                    )}
                    numeric
                    min={0.1}
                    max={1000}
                    suffix="px"
                    disabled={anyLocked}
                    step={0.1}
                    preview={numberPreview("strokeWidth")}
                    onCommit={numberChange("strokeWidth")}
                  />
                )}
              </Section>
            )}
            {allText && (
              <Section title="Text">
                <CanvasFontPicker
                  {...tokenChoice("fontFamily")}
                  value={textValue((node) => node.fontFamily ?? "Arial")}
                  nodes={nodes}
                  disabled={anyLocked}
                  onChange={(value) => onChange("fontFamily", value)}
                />
                <PropertySelect
                  label="Font weight"
                  {...tokenChoice("fontWeight")}
                  value={textValue((node) => node.fontWeight ?? 400)}
                  choices={WEIGHT_CHOICES}
                  disabled={anyLocked}
                  onChange={numberChange("fontWeight")}
                />
                <div className="canvas-properties-grid canvas-properties-grid-three">
                  <PropertyField
                    label="Font size"
                    {...tokenChoice("fontSize")}
                    prefix="A"
                    value={textValue((node) => node.fontSize)}
                    numeric
                    min={1}
                    max={1000}
                    disabled={anyLocked}
                    preview={numberPreview("fontSize")}
                    onCommit={numberChange("fontSize")}
                  />
                  <PropertyField
                    label="Line height"
                    {...tokenChoice("lineHeight")}
                    prefix="↕"
                    value={textValue((node) => node.lineHeight ?? 1.25)}
                    numeric
                    min={0.5}
                    max={4}
                    disabled={anyLocked}
                    step={0.01}
                    preview={numberPreview("lineHeight")}
                    onCommit={numberChange("lineHeight")}
                  />
                  <PropertyField
                    label="Letter spacing"
                    {...tokenChoice("letterSpacing")}
                    prefix="↔"
                    value={textValue((node) => node.letterSpacing ?? 0)}
                    numeric
                    min={-10}
                    max={100}
                    disabled={anyLocked}
                    step={0.1}
                    preview={numberPreview("letterSpacing")}
                    onCommit={numberChange("letterSpacing")}
                  />
                </div>
                <div className="canvas-properties-segmented">
                  {(
                    [
                      { value: "left", label: "Align text left", Icon: AlignLeftIcon },
                      { value: "center", label: "Align text center", Icon: AlignCenterIcon },
                      { value: "right", label: "Align text right", Icon: AlignRightIcon },
                    ] as const
                  ).map(({ value, label, Icon }) => (
                    <IconButton
                      key={value}
                      label={label}
                      active={textValue((node) => node.textAlign ?? "left") === value}
                      disabled={anyLocked}
                      onClick={() => onChange("textAlign", value)}
                    >
                      <Icon size={16} />
                    </IconButton>
                  ))}
                </div>
                <button
                  type="button"
                  className="canvas-property-text-button"
                  disabled={anyLocked}
                  onClick={onFitText}
                >
                  <ScanTextIcon size={14} />
                  Fit text height
                </button>
              </Section>
            )}
          </>
        )}
      </div>
    </aside>
  );
});
