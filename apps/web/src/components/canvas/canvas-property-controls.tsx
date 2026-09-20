import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import {
  colorFromHsv,
  colorToHsv,
  normalizeCanvasHex,
  scrubNumericValue,
  type HsvColor,
} from "./canvas-property-values";
import { CanvasTokenSelect, type TokenChoiceProps } from "./canvas-token-select";

export type PropertyPreview = {
  onStart: () => void;
  onPreview: (value: number) => void;
  onEnd: (cancel: boolean) => void;
};

type FieldProps = TokenChoiceProps & {
  label: string;
  prefix?: ReactNode;
  value: string | number | undefined;
  disabled?: boolean;
  suffix?: string;
  min?: number;
  max?: number;
  numeric?: boolean;
  step?: number;
  preview?: PropertyPreview;
  onCommit: (value: string) => void;
};

function displayNumber(value: number) {
  return String(Math.round(value * 10000) / 10000);
}

export function PropertyField({
  label,
  prefix,
  value,
  disabled,
  suffix,
  min,
  max,
  numeric = false,
  step = 1,
  preview,
  onCommit,
  tokens,
  tokenId,
  onToken,
}: FieldProps) {
  const source = typeof value === "number" ? displayNumber(value) : (value ?? "");
  const [draft, setDraft] = useState<{ source: string; value: string } | null>(null);
  const skipCommit = useRef(false);
  const active = useRef<{ pointerId: number; lastX: number; value: number } | null>(null);
  const scrubber = useRef<HTMLButtonElement>(null);
  const previewRef = useRef(preview);
  useLayoutEffect(() => {
    previewRef.current = preview;
  }, [preview]);
  const shown = draft?.source === source ? draft.value : source;
  const scrubbable = numeric && preview && typeof value === "number" && !disabled;

  function finishScrub(cancel: boolean) {
    const gesture = active.current;
    if (!gesture) return;
    active.current = null;
    previewRef.current?.onEnd(cancel);
    if (scrubber.current?.hasPointerCapture(gesture.pointerId))
      scrubber.current.releasePointerCapture(gesture.pointerId);
  }

  useEffect(() => {
    function cancel() {
      if (active.current) {
        active.current = null;
        previewRef.current?.onEnd(true);
      }
    }
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("blur", cancel);
      cancel();
    };
  }, []);

  return (
    <div className="canvas-property-field" data-disabled={disabled || undefined}>
      {prefix &&
        (numeric && preview ? (
          <button
            ref={scrubber}
            type="button"
            className="canvas-property-prefix canvas-property-scrubber"
            aria-label={`Adjust ${label.toLowerCase()}`}
            title={`Drag to adjust ${label.toLowerCase()}. Shift: faster. Alt: finer.`}
            disabled={!scrubbable}
            onPointerDown={(event) => {
              if (event.button !== 0 || typeof value !== "number" || !scrubbable) return;
              event.preventDefault();
              event.stopPropagation();
              event.currentTarget.focus({ preventScroll: true });
              event.currentTarget.setPointerCapture(event.pointerId);
              active.current = { pointerId: event.pointerId, lastX: event.clientX, value };
              setDraft(null);
              preview.onStart();
            }}
            onPointerMove={(event) => {
              const gesture = active.current;
              if (!gesture || gesture.pointerId !== event.pointerId) return;
              event.preventDefault();
              const next = scrubNumericValue(gesture.value, event.clientX - gesture.lastX, {
                step,
                min,
                max,
                shift: event.shiftKey,
                alt: event.altKey,
              });
              gesture.lastX = event.clientX;
              gesture.value = next;
              preview.onPreview(next);
            }}
            onPointerUp={(event) => {
              if (active.current?.pointerId === event.pointerId) finishScrub(false);
            }}
            onPointerCancel={() => finishScrub(true)}
            onLostPointerCapture={() => finishScrub(true)}
            onBlur={() => finishScrub(false)}
            onCopy={(event) => {
              if (active.current) event.stopPropagation();
            }}
            onCut={(event) => {
              if (active.current) event.stopPropagation();
            }}
            onPaste={(event) => {
              if (active.current) event.stopPropagation();
            }}
            onKeyDown={(event) => {
              const historyShortcut =
                (event.metaKey || event.ctrlKey) && ["z", "y"].includes(event.key.toLowerCase());
              // Once the scrub ends, let the editor undo the committed gesture normally.
              if (historyShortcut && !active.current) return;
              event.stopPropagation();
              if (event.key === "Escape" || (active.current && historyShortcut)) {
                event.preventDefault();
                finishScrub(true);
              } else if (
                !active.current &&
                typeof value === "number" &&
                ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
              ) {
                event.preventDefault();
                const direction = event.key === "ArrowRight" || event.key === "ArrowUp" ? 1 : -1;
                onCommit(
                  String(
                    scrubNumericValue(value, direction, {
                      step,
                      min,
                      max,
                      shift: event.shiftKey,
                      alt: event.altKey,
                    }),
                  ),
                );
              }
            }}
          >
            {prefix}
          </button>
        ) : (
          <span className="canvas-property-prefix" aria-hidden="true">
            {prefix}
          </span>
        ))}
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
          if (event.key === "Enter" || event.key === "Escape") {
            event.preventDefault();
            if (event.key === "Escape") {
              skipCommit.current = true;
              setDraft(null);
            }
            const panel = event.currentTarget.closest<HTMLElement>(".canvas-properties");
            event.currentTarget.blur();
            panel?.focus({ preventScroll: true });
          } else if (numeric && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
            event.preventDefault();
            const next = scrubNumericValue(Number(shown || 0), event.key === "ArrowUp" ? 1 : -1, {
              step,
              min,
              max,
              shift: event.shiftKey,
              alt: event.altKey,
            });
            setDraft({ source, value: displayNumber(next) });
          }
        }}
      />
      {suffix && (
        <span className="canvas-property-suffix" aria-hidden="true">
          {suffix}
        </span>
      )}
      <CanvasTokenSelect
        tokens={tokens}
        tokenId={tokenId}
        onToken={onToken}
        label={label}
        disabled={disabled}
      />
    </div>
  );
}

type ColorProps = TokenChoiceProps & {
  value: string | undefined;
  disabled: boolean;
  onStart: () => void;
  onPreview: (value: string) => void;
  onEnd: (cancel: boolean) => void;
};

export function ColorSwatch({
  value,
  disabled,
  onStart,
  onPreview,
  onEnd,
  tokens,
  tokenId,
  onToken,
}: ColorProps) {
  const [position, setPosition] = useState<{ top: number; right: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const session = useRef(false);
  const onEndRef = useRef(onEnd);
  useLayoutEffect(() => {
    onEndRef.current = onEnd;
  }, [onEnd]);

  function close(cancel: boolean, restoreFocus = true) {
    if (!session.current) return;
    session.current = false;
    onEndRef.current(cancel);
    setPosition(null);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  }

  useEffect(
    () => () => {
      if (session.current) {
        session.current = false;
        onEndRef.current(true);
      }
    },
    [],
  );

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="canvas-property-swatch"
        aria-label="Fill color picker"
        aria-haspopup="dialog"
        aria-expanded={!!position}
        title="Choose fill color"
        disabled={disabled}
        data-mixed={value === undefined || undefined}
        style={{ backgroundColor: value }}
        onClick={(event) => {
          if (session.current) return close(false);
          const rect = event.currentTarget.getBoundingClientRect();
          session.current = true;
          onStart();
          setPosition({
            top: Math.max(8, Math.min(window.innerHeight - 360, rect.bottom + 8)),
            right: Math.max(8, window.innerWidth - rect.right - 192),
          });
        }}
      />
      {position && (
        <ColorPopover
          tokens={tokens}
          tokenId={tokenId}
          onToken={(id) => {
            close(true);
            onToken?.(id);
          }}
          initialColor={value ?? "#000000"}
          position={position}
          onPreview={onPreview}
          onClose={close}
        />
      )}
    </>
  );
}

function ColorPopover({
  tokens,
  tokenId,
  onToken,
  initialColor,
  position,
  onPreview,
  onClose,
}: {
  tokens?: TokenChoiceProps["tokens"];
  tokenId?: string;
  onToken?: TokenChoiceProps["onToken"];
  initialColor: string;
  position: { top: number; right: number };
  onPreview: (value: string) => void;
  onClose: (cancel: boolean, restoreFocus?: boolean) => void;
}) {
  const [color, setColor] = useState(() => colorToHsv(initialColor));
  const [hexDraft, setHexDraft] = useState<string | null>(null);
  const panel = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  useLayoutEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  const hex = colorFromHsv(color);

  useEffect(() => {
    panel.current?.focus({ preventScroll: true });
    function dismiss(event: PointerEvent) {
      if (!(event.target instanceof Node) || panel.current?.contains(event.target)) return;
      if (event.target instanceof Element && event.target.closest(".canvas-property-swatch"))
        return;
      // Commit before the canvas or another control begins a new document gesture.
      closeRef.current(false, false);
    }
    function focusOutside(event: FocusEvent) {
      if (event.target instanceof Element && event.target.closest(".canvas-property-swatch"))
        return;
      if (event.target instanceof Node && !panel.current?.contains(event.target))
        closeRef.current(false, false);
    }
    function cancel() {
      closeRef.current(true);
    }
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("focusin", focusOutside);
    window.addEventListener("blur", cancel);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("focusin", focusOutside);
      window.removeEventListener("blur", cancel);
    };
  }, []);

  function change(next: HsvColor) {
    setColor(next);
    setHexDraft(null);
    onPreview(colorFromHsv(next));
  }

  function pick(event: ReactPointerEvent<HTMLButtonElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    change({
      ...color,
      s: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      v: 1 - Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    });
  }

  return (
    <dialog
      ref={panel}
      open
      aria-label="Fill color"
      tabIndex={-1}
      className="canvas-color-popover"
      style={position}
      onCopy={(event) => event.stopPropagation()}
      onCut={(event) => event.stopPropagation()}
      onPaste={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (
          event.key === "Escape" ||
          ((event.metaKey || event.ctrlKey) && ["z", "y"].includes(event.key.toLowerCase()))
        ) {
          event.preventDefault();
          onClose(true);
        }
      }}
    >
      <div className="canvas-color-heading">Color</div>
      <CanvasTokenSelect tokens={tokens} tokenId={tokenId} onToken={onToken} label="Fill color" />
      <button
        type="button"
        className="canvas-color-spectrum"
        aria-label="Color saturation and brightness"
        style={{ backgroundColor: `hsl(${color.h} 100% 50%)` }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.focus({ preventScroll: true });
          event.currentTarget.setPointerCapture(event.pointerId);
          pick(event);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) pick(event);
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => onClose(true)}
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
          event.preventDefault();
          const step = event.shiftKey ? 0.1 : 0.01;
          change({
            ...color,
            s: Math.max(
              0,
              Math.min(
                1,
                color.s +
                  (event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0),
              ),
            ),
            v: Math.max(
              0,
              Math.min(
                1,
                color.v + (event.key === "ArrowUp" ? step : event.key === "ArrowDown" ? -step : 0),
              ),
            ),
          });
        }}
      >
        <span style={{ left: `${color.s * 100}%`, top: `${(1 - color.v) * 100}%` }} />
      </button>
      <label className="canvas-color-slider-row">
        <span>Hue</span>
        <input
          type="range"
          className="canvas-color-hue"
          aria-label="Color hue"
          min={0}
          max={360}
          step={1}
          value={color.h}
          onChange={(event) => change({ ...color, h: Number(event.target.value) })}
        />
      </label>
      <label className="canvas-color-slider-row">
        <span>Alpha</span>
        <input
          type="range"
          className="canvas-color-alpha"
          aria-label="Color alpha"
          min={0}
          max={100}
          step={1}
          value={Math.round(color.a * 100)}
          style={{ backgroundImage: `linear-gradient(to right, transparent, ${hex.slice(0, 7)})` }}
          onChange={(event) => change({ ...color, a: Number(event.target.value) / 100 })}
        />
        <span>{Math.round(color.a * 100)}%</span>
      </label>
      <div className="canvas-property-field">
        <span className="canvas-property-prefix" aria-hidden="true">
          #
        </span>
        <input
          aria-label="Color hex"
          value={hexDraft ?? hex.slice(1).toUpperCase()}
          autoComplete="off"
          spellCheck={false}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => {
            setHexDraft(event.target.value);
            const normalized = normalizeCanvasHex(event.target.value);
            if (normalized) {
              setColor(colorToHsv(normalized));
              onPreview(normalized);
            }
          }}
          onBlur={() => setHexDraft(null)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onClose(false);
            }
          }}
        />
      </div>
      <div className="canvas-color-actions">
        <button type="button" className="canvas-property-text-button" onClick={() => onClose(true)}>
          Cancel
        </button>
        <button
          type="button"
          className="canvas-property-text-button"
          onClick={() => onClose(false)}
        >
          Done
        </button>
      </div>
    </dialog>
  );
}
