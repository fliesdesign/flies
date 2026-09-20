import type { ThemeToken } from "@flies/canvas";

export type TokenChoiceProps = {
  tokens?: readonly ThemeToken[];
  tokenId?: string;
  onToken?: (id: string | null) => void;
};

export function CanvasTokenSelect({
  tokens,
  tokenId,
  onToken,
  label,
  disabled,
}: TokenChoiceProps & { label: string; disabled?: boolean }) {
  if (!tokens?.length || !onToken) return null;

  return (
    <select
      className="canvas-token-select"
      aria-label={`${label} token`}
      value={tokenId ?? ""}
      disabled={disabled}
      onChange={(event) => onToken(event.target.value || null)}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <option value="">Custom value</option>
      {tokens.map((token) => (
        <option key={token.id} value={token.id}>
          {token.name} · {token.value}
        </option>
      ))}
    </select>
  );
}
