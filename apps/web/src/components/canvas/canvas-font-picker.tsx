import { ensureCanvasFonts, listCanvasFonts, type CanvasFrame } from "@flies/canvas";
import { useEffect, useId, useState } from "react";

import { CanvasTokenSelect, type TokenChoiceProps } from "./canvas-token-select";

export function CanvasFontPicker({
  value,
  tokens,
  tokenId,
  onToken,
  nodes,
  disabled,
  onChange,
}: TokenChoiceProps & {
  value: string | undefined;
  nodes: readonly CanvasFrame[];
  disabled: boolean;
  onChange: (family: string) => void;
}) {
  const id = useId();
  const [families, setFamilies] = useState<string[]>([]);
  const [draft, setDraft] = useState(value ?? "");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [previousValue, setPreviousValue] = useState(value);
  if (previousValue !== value) {
    setPreviousValue(value);
    setDraft(value ?? "");
  }
  useEffect(() => {
    let active = true;
    void listCanvasFonts()
      .then((fonts) => {
        if (active) setFamilies(fonts);
        return fonts;
      })
      .catch((reason: unknown) => {
        if (active) setError(String(reason));
      });
    return () => {
      active = false;
    };
  }, []);
  async function commit() {
    const family = draft.trim();
    if (!family || family === value || loading) return;
    setLoading(true);
    setError("");
    try {
      await ensureCanvasFonts(
        nodes
          .filter((node) => node.kind === "text")
          .map((node) => ({
            fontFamily: family,
            fontWeight: node.fontWeight,
            fontStyle: node.fontStyle,
            text: node.text,
          })),
      );
      onChange(family);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }
  return (
    <div className="canvas-font-picker">
      <CanvasTokenSelect
        tokens={tokens}
        tokenId={tokenId}
        onToken={onToken}
        label="Font family"
        disabled={disabled || loading}
      />
      <input
        aria-label="Font family"
        aria-busy={loading}
        list={id}
        value={draft}
        disabled={disabled || loading}
        placeholder="Choose or type a font"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") {
            event.preventDefault();
            void commit();
          }
          if (event.key === "Escape") setDraft(value ?? "");
        }}
      />
      <datalist id={id}>
        {families.map((family) => (
          <option key={family} value={family}>
            {family}
          </option>
        ))}
      </datalist>
      {loading && <output>Loading font…</output>}
      {error && <span role="alert">{error}</span>}
    </div>
  );
}
