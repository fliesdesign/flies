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
import {
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import type { CanvasArrangeAction } from "@/lib/canvas-arrange";
import type { CanvasDocument, CanvasFrame } from "@/lib/canvas-document";
import type { CanvasProperty, CanvasPropertyOptions } from "@/lib/canvas-properties";

import "./canvas-properties.css";

export type { CanvasProperty, CanvasPropertyOptions } from "@/lib/canvas-properties";

type CanvasPropertiesProps = {
  document: CanvasDocument;
  selectedIds: readonly string[];
  onChange: (
    property: CanvasProperty,
    value: string | number | boolean,
    options?: CanvasPropertyOptions,
  ) => void;
  onArrange: (action: CanvasArrangeAction) => void;
  onFitText: () => void;
  onCollapse: () => void;
};

type FieldProps = {
  label: string;
  prefix?: ReactNode;
  value: string | number | undefined;
  disabled?: boolean;
  suffix?: string;
  min?: number;
  max?: number;
  numeric?: boolean;
  onCommit: (value: string) => void;
};

function displayNumber(value: number) {
  return String(Math.round(value * 100) / 100);
}

function PropertyField({
  label,
  prefix,
  value,
  disabled,
  suffix,
  min,
  max,
  numeric = false,
  onCommit,
}: FieldProps) {
  const source = typeof value === "number" ? displayNumber(value) : (value ?? "");
  const [draft, setDraft] = useState<{ source: string; value: string } | null>(null);
  const skipCommit = useRef(false);
  const shown = draft?.source === source ? draft.value : source;
  return (
    <label className="canvas-property-field" data-disabled={disabled || undefined}>
      {prefix && (
        <span className="canvas-property-prefix" aria-hidden="true">
          {prefix}
        </span>
      )}
      <input
        aria-label={label}
        title={label}
        type="text"
        inputMode={numeric ? "decimal" : undefined}
        value={shown}
        placeholder={value === undefined ? "Mixed" : undefined}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => setDraft({ source, value: event.target.value })}
        onFocus={(event) => event.currentTarget.select()}
        onBlur={() => {
          if (skipCommit.current) {
            skipCommit.current = false;
          } else if (shown.trim() !== source && shown.trim() !== "") {
            const number = Number(shown);
            if (
              !numeric ||
              (Number.isFinite(number) &&
                (min === undefined || number >= min) &&
                (max === undefined || number <= max))
            ) {
              onCommit(numeric ? String(number) : shown.trim());
            }
          }
          setDraft(null);
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") {
            event.preventDefault();
            const panel = event.currentTarget.closest<HTMLElement>(".canvas-properties");
            event.currentTarget.blur();
            panel?.focus({ preventScroll: true });
          } else if (event.key === "Escape") {
            event.preventDefault();
            skipCommit.current = true;
            setDraft(null);
            const panel = event.currentTarget.closest<HTMLElement>(".canvas-properties");
            event.currentTarget.blur();
            panel?.focus({ preventScroll: true });
          } else if (numeric && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
            event.preventDefault();
            const number = Number(shown || 0);
            const step = event.shiftKey ? 10 : 1;
            const next = Math.min(
              max ?? Infinity,
              Math.max(min ?? -Infinity, number + (event.key === "ArrowUp" ? step : -step)),
            );
            setDraft({ source, value: displayNumber(next) });
          }
        }}
      />
      {suffix && (
        <span className="canvas-property-suffix" aria-hidden="true">
          {suffix}
        </span>
      )}
    </label>
  );
}

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
}: {
  label: string;
  value: string | number | undefined;
  disabled?: boolean;
  choices: readonly { value: string | number; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
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

function normalizeHex(value: string) {
  const hex = value.replace(/^#/, "");
  if (/^[\da-f]{3,4}$/i.test(hex))
    return `#${hex
      .split("")
      .map((digit) => digit + digit)
      .join("")}`;
  return /^[\da-f]{6}([\da-f]{2})?$/i.test(hex) ? `#${hex}` : null;
}

function ColorSwatch({
  value,
  disabled,
  onCommit,
}: {
  value: string | undefined;
  disabled: boolean;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState<{ source: string | undefined; value: string } | null>(null);
  const shown = draft && draft.source === value ? draft.value : value;
  return (
    <label
      className="canvas-property-swatch"
      title="Choose fill color"
      data-mixed={value === undefined || undefined}
      style={{ backgroundColor: shown }}
    >
      <input
        type="color"
        aria-label="Fill color picker"
        disabled={disabled}
        value={normalizeHex(shown ?? "")?.slice(0, 7) ?? "#000000"}
        onChange={(event) => setDraft({ source: value, value: event.target.value })}
        onBlur={() => {
          if (draft && draft.source === value && draft.value !== value) onCommit(draft.value);
          setDraft(null);
        }}
      />
    </label>
  );
}

const ALIGN_ACTIONS = [
  { action: "left", label: "Align left" },
  { action: "center", label: "Align horizontal centers" },
  { action: "right", label: "Align right" },
  { action: "top", label: "Align top" },
  { action: "middle", label: "Align vertical centers" },
  { action: "bottom", label: "Align bottom" },
] as const;
const FONT_CHOICES = ["Arial", "Helvetica", "Georgia", "Courier New"].map((font) => ({
  value: font,
  label: font,
}));
const WEIGHT_CHOICES = [
  { value: 400, label: "Regular" },
  { value: 500, label: "Medium" },
  { value: 600, label: "Semibold" },
  { value: 700, label: "Bold" },
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
  onArrange,
  onFitText,
  onCollapse,
}: CanvasPropertiesProps) {
  const nodes = useSelectedNodes(document, selectedIds);
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
  const ownLocked = nodes.some((node) => node.locked);
  const allHidden = nodes.length > 0 && nodes.every((node) => node.hidden);
  const allText = nodes.length > 0 && nodes.every((node) => node.kind === "text");
  const hasFill = nodes.length > 0 && nodes.every((node) => fillFor(node) !== undefined);
  const hasRadius =
    nodes.length > 0 &&
    nodes.every((node) => !node.kind || ["frame", "rectangle", "image"].includes(node.kind));
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
  const changeFill = (value: string) => {
    const hex = normalizeHex(value);
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
                    disabled={nodes.length < 2 || anyLocked}
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
                  disabled={anyLocked}
                  onCommit={numberChange("x")}
                />
                <PropertyField
                  label="Y position"
                  prefix="Y"
                  value={top - (parent?.y ?? 0)}
                  numeric
                  disabled={anyLocked}
                  onCommit={numberChange("y")}
                />
                <PropertyField
                  label="Width"
                  prefix="W"
                  value={width}
                  numeric
                  min={1}
                  disabled={anyLocked}
                  onCommit={(value) => onChange("width", Number(value), { preserveAspect })}
                />
                <PropertyField
                  label="Height"
                  prefix="H"
                  value={height}
                  numeric
                  min={1}
                  disabled={anyLocked}
                  onCommit={(value) => onChange("height", Number(value), { preserveAspect })}
                />
              </div>
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
                  onCommit={(value) => onChange("opacity", Number(value) / 100)}
                />
                {hasRadius && (
                  <PropertyField
                    label="Corner radius"
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
                    onCommit={numberChange("cornerRadius")}
                  />
                )}
              </div>
            </Section>
            {hasFill && (
              <Section title={allPens ? "Stroke" : "Fill"}>
                <div className="canvas-properties-color">
                  <ColorSwatch value={fill} disabled={anyLocked} onCommit={changeFill} />
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
                    prefix="W"
                    value={commonValue(nodes, (node) =>
                      node.kind === "pen" ? node.strokeWidth : undefined,
                    )}
                    numeric
                    min={0.1}
                    max={1000}
                    suffix="px"
                    disabled={anyLocked}
                    onCommit={numberChange("strokeWidth")}
                  />
                )}
              </Section>
            )}
            {allText && (
              <Section title="Text">
                <PropertySelect
                  label="Font family"
                  value={textValue((node) => node.fontFamily ?? "Arial")}
                  choices={FONT_CHOICES}
                  disabled={anyLocked}
                  onChange={(value) => onChange("fontFamily", value)}
                />
                <PropertySelect
                  label="Font weight"
                  value={textValue((node) => node.fontWeight ?? 400)}
                  choices={WEIGHT_CHOICES}
                  disabled={anyLocked}
                  onChange={numberChange("fontWeight")}
                />
                <div className="canvas-properties-grid canvas-properties-grid-three">
                  <PropertyField
                    label="Font size"
                    prefix="A"
                    value={textValue((node) => node.fontSize)}
                    numeric
                    min={1}
                    max={1000}
                    disabled={anyLocked}
                    onCommit={numberChange("fontSize")}
                  />
                  <PropertyField
                    label="Line height"
                    prefix="↕"
                    value={textValue((node) => node.lineHeight ?? 1.25)}
                    numeric
                    min={0.5}
                    max={4}
                    disabled={anyLocked}
                    onCommit={numberChange("lineHeight")}
                  />
                  <PropertyField
                    label="Letter spacing"
                    prefix="↔"
                    value={textValue((node) => node.letterSpacing ?? 0)}
                    numeric
                    min={-10}
                    max={100}
                    disabled={anyLocked}
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
