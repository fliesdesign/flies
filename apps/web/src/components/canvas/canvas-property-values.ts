export type HsvColor = { h: number; s: number; v: number; a: number };

export function normalizeCanvasHex(value: string) {
  const hex = value.replace(/^#/, "");
  if (/^[\da-f]{3,4}$/i.test(hex))
    return `#${hex
      .split("")
      .map((digit) => digit + digit)
      .join("")}`.toLowerCase();
  return /^[\da-f]{6}([\da-f]{2})?$/i.test(hex) ? `#${hex.toLowerCase()}` : null;
}

export function colorToHsv(value: string): HsvColor {
  const hex = normalizeCanvasHex(value) ?? "#000000";
  const r = Number.parseInt(hex.slice(1, 3), 16) / 255;
  const g = Number.parseInt(hex.slice(3, 5), 16) / 255;
  const b = Number.parseInt(hex.slice(5, 7), 16) / 255;
  const maximum = Math.max(r, g, b);
  const delta = maximum - Math.min(r, g, b);
  let h = 0;
  if (delta) {
    if (maximum === r) h = ((g - b) / delta) % 6;
    else if (maximum === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h = (h * 60 + 360) % 360;
  }
  return {
    h,
    s: maximum ? delta / maximum : 0,
    v: maximum,
    a: hex.length === 9 ? Number.parseInt(hex.slice(7), 16) / 255 : 1,
  };
}

const byte = (value: number) =>
  Math.round(value * 255)
    .toString(16)
    .padStart(2, "0");

export function colorFromHsv({ h, s, v, a }: HsvColor) {
  const hue = (((h % 360) + 360) % 360) / 60;
  const saturation = Math.max(0, Math.min(1, s));
  const brightness = Math.max(0, Math.min(1, v));
  const chroma = brightness * saturation;
  const x = chroma * (1 - Math.abs((hue % 2) - 1));
  const base = brightness - chroma;
  const rgb =
    hue < 1
      ? [chroma, x, 0]
      : hue < 2
        ? [x, chroma, 0]
        : hue < 3
          ? [0, chroma, x]
          : hue < 4
            ? [0, x, chroma]
            : hue < 5
              ? [x, 0, chroma]
              : [chroma, 0, x];
  const alpha = Math.max(0, Math.min(1, a));
  return `#${rgb.map((channel) => byte(channel + base)).join("")}${alpha < 1 ? byte(alpha) : ""}`;
}

/** Incremental deltas keep changing modifiers from making the value jump. */
export function scrubNumericValue(
  value: number,
  pixels: number,
  {
    step = 1,
    min = -Infinity,
    max = Infinity,
    shift = false,
    alt = false,
  }: {
    step?: number;
    min?: number;
    max?: number;
    shift?: boolean;
    alt?: boolean;
  } = {},
) {
  const scale = alt ? 0.1 : shift ? 10 : 1;
  const next = Math.max(min, Math.min(max, value + pixels * step * scale));
  return Math.round(next * 10000) / 10000;
}
