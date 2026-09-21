/** Serializable native paint, shared by the DOM, GPU, properties and code export. */
export type CanvasGradient = Readonly<{
  type: "linear" | "radial";
  /** CSS angle: zero points up, 90 points right. */
  angle: number;
  interpolation?: "srgb" | "oklab";
  background?: string;
  stops: readonly Readonly<{ offset: number; color: string }>[];
}>;

export const CANVAS_BLEND_MODES = [
  "normal",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
] as const;
export type CanvasBlendMode = (typeof CANVAS_BLEND_MODES)[number];
export const CANVAS_FILTERS = {
  blur: { label: "Blur", min: 0, max: 100, initial: 0, unit: "px" },
  brightness: { label: "Brightness", min: 0, max: 4, initial: 1, unit: "" },
  contrast: { label: "Contrast", min: 0, max: 4, initial: 1, unit: "" },
  saturate: { label: "Saturation", min: 0, max: 4, initial: 1, unit: "" },
  grayscale: { label: "Grayscale", min: 0, max: 1, initial: 0, unit: "" },
  sepia: { label: "Sepia", min: 0, max: 1, initial: 0, unit: "" },
  invert: { label: "Invert", min: 0, max: 1, initial: 0, unit: "" },
  hue: { label: "Hue", min: -180, max: 180, initial: 0, unit: "deg" },
} as const;
export type CanvasFilterName = keyof typeof CANVAS_FILTERS;
export type CanvasFilters = Readonly<
  Partial<Record<CanvasFilterName, number>> & { order?: readonly CanvasFilterName[] }
>;

export function canvasFilterOrder(filters?: CanvasFilters): CanvasFilterName[] {
  return [
    ...new Set([...(filters?.order ?? []), ...(Object.keys(CANVAS_FILTERS) as CanvasFilterName[])]),
  ];
}

export const isPaintColor = (value: unknown): value is string =>
  typeof value === "string" && /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value);

export function isCanvasGradient(value: unknown): value is CanvasGradient {
  if (!value || typeof value !== "object") return false;
  const g = value as CanvasGradient;

  return (
    (g.type === "linear" || g.type === "radial") &&
    Number.isFinite(g.angle) &&
    (g.interpolation === undefined || ["srgb", "oklab"].includes(g.interpolation)) &&
    (g.background === undefined || isPaintColor(g.background)) &&
    Array.isArray(g.stops) &&
    g.stops.length >= 2 &&
    g.stops.length <= 16 &&
    g.stops.every(
      (stop, i) =>
        stop &&
        Number.isFinite(stop.offset) &&
        stop.offset >= 0 &&
        stop.offset <= 1 &&
        isPaintColor(stop.color) &&
        (!i || stop.offset >= g.stops[i - 1].offset),
    )
  );
}

export function isCanvasFilters(value: unknown): value is CanvasFilters {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;

  return Object.entries(value).every(([key, v]) => {
    if (key === "order")
      return (
        Array.isArray(v) &&
        v.length <= 8 &&
        new Set(v).size === v.length &&
        v.every((name) => Object.prototype.hasOwnProperty.call(CANVAS_FILTERS, name))
      );
    if (!Object.prototype.hasOwnProperty.call(CANVAS_FILTERS, key)) return false;
    const limits = CANVAS_FILTERS[key as CanvasFilterName];

    return typeof v === "number" && Number.isFinite(v) && v >= limits.min && v <= limits.max;
  });
}

export function gradientCss(gradient: CanvasGradient) {
  const stops = gradient.stops.map((s) => `${s.color} ${s.offset * 100}%`).join(", ");

  const space = gradient.interpolation === "oklab" ? " in oklab" : "";

  const image =
    gradient.type === "linear"
      ? `linear-gradient(${gradient.angle}deg${space}, ${stops})`
      : `radial-gradient(ellipse farthest-corner at center${space}, ${stops})`;

  return image + (gradient.background ? ` ${gradient.background}` : "");
}

export function filterCss(filters?: CanvasFilters) {
  return (
    canvasFilterOrder(filters)
      .filter((key) => filters?.[key] !== undefined && filters[key] !== CANVAS_FILTERS[key].initial)
      .map(
        (key) =>
          `${key === "hue" ? "hue-rotate" : key}(${filters![key]}${CANVAS_FILTERS[key].unit})`,
      )
      .join(" ") || undefined
  );
}

/** Linear endpoints matching CSS magic-corner geometry, in local pixels. */
export function gradientLine(width: number, height: number, angle: number) {
  const rad = (angle * Math.PI) / 180;

  const dx = Math.sin(rad),
    dy = -Math.cos(rad);

  const length = Math.abs(width * dx) + Math.abs(height * dy);

  return {
    start: { x: width / 2 - (dx * length) / 2, y: height / 2 - (dy * length) / 2 },
    end: { x: width / 2 + (dx * length) / 2, y: height / 2 + (dy * length) / 2 },
  };
}
