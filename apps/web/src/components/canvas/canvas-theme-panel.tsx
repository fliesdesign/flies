import {
  EMPTY_THEME,
  type CanvasDocument,
  type ThemeToken,
  type ThemeTokenType,
} from "@flies/canvas";
import { useState, useSyncExternalStore } from "react";

import { updateDocumentTheme } from "@/lib/canvas-theme-actions";

const TYPES: { value: ThemeTokenType; label: string; initial: string | number }[] = [
  { value: "color", label: "Colors", initial: "#6366f1" },
  { value: "fontFamily", label: "Font families", initial: "Arial" },
  { value: "spacing", label: "Spacing", initial: 16 },
  { value: "radius", label: "Radii", initial: 8 },
  { value: "fontSize", label: "Font sizes", initial: 16 },
];
export function CanvasThemePanel({ document }: { document: CanvasDocument }) {
  useSyncExternalStore(document.subscribe, document.getSnapshot, document.getSnapshot);
  const theme = document.getTheme();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function save(tokens: readonly ThemeToken[]) {
    setError("");
    setBusy(true);
    try {
      await updateDocumentTheme(document, { tokens });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }
  function add(type: ThemeTokenType, initial: string | number) {
    let index = 1;
    const prefix = type === "fontFamily" ? "font" : type === "fontSize" ? "text" : type;
    while (theme.tokens.some((token) => token.id === `${prefix}-${index}`)) index++;
    void save([
      ...theme.tokens,
      { id: `${prefix}-${index}`, name: `${prefix} ${index}`, type, value: initial },
    ]);
  }
  function edit(token: ThemeToken, patch: Partial<ThemeToken>) {
    void save(
      theme.tokens.map((entry) => (entry.id === token.id ? { ...entry, ...patch } : entry)),
    );
  }
  return (
    <div className="canvas-theme-panel" aria-label="Theme tokens" aria-busy={busy}>
      <p className="canvas-theme-intro">
        Define once, reuse across your design. Linked layers update when a token changes.
      </p>
      {error && (
        <p role="alert" className="canvas-theme-error">
          {error}
        </p>
      )}
      {TYPES.map(({ value: type, label, initial }) => (
        <section className="canvas-theme-section" key={type} aria-label={label}>
          <header>
            <h3>{label}</h3>
            <button
              type="button"
              disabled={busy}
              onClick={() => add(type, initial)}
              aria-label={`Add ${label.toLowerCase()} token`}
            >
              +
            </button>
          </header>
          {theme.tokens
            .filter((token) => token.type === type)
            .map((token) => (
              <div className="canvas-theme-token" key={`${token.id}:${token.name}:${token.value}`}>
                {type === "color" && (
                  <span
                    className="canvas-theme-swatch"
                    style={{ background: String(token.value) }}
                  />
                )}
                <div className="canvas-theme-token-fields">
                  <input
                    aria-label={`Token name ${token.id}`}
                    defaultValue={token.name}
                    disabled={busy}
                    onBlur={(event) => {
                      if (event.target.value !== token.name)
                        edit(token, { name: event.target.value });
                    }}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === "Enter") event.currentTarget.blur();
                    }}
                  />
                  <input
                    aria-label={`Token value ${token.id}`}
                    defaultValue={String(token.value)}
                    disabled={busy}
                    type={typeof token.value === "number" ? "number" : "text"}
                    min={type === "fontSize" ? 1 : 0}
                    step="any"
                    onBlur={(event) => {
                      const value =
                        typeof token.value === "number"
                          ? Number(event.target.value)
                          : event.target.value;
                      if (value !== token.value) edit(token, { value });
                    }}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === "Enter") event.currentTarget.blur();
                    }}
                  />
                  <small title={`CSS variable: --${token.id}`}>--{token.id}</small>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`Delete token ${token.name}`}
                  title="Delete token; linked layers keep their current values"
                  onClick={() => void save(theme.tokens.filter((entry) => entry.id !== token.id))}
                >
                  ×
                </button>
              </div>
            ))}
          {!theme.tokens.some((token) => token.type === type) && (
            <p className="canvas-theme-empty">No tokens yet</p>
          )}
        </section>
      ))}
      {theme.tokens.length > 0 && (
        <button
          type="button"
          className="canvas-property-text-button"
          disabled={busy}
          onClick={() => void save(EMPTY_THEME.tokens)}
        >
          Clear theme
        </button>
      )}
    </div>
  );
}
