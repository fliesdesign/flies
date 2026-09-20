import type { CanvasFrame } from "./canvas-document";
import { isFontFamily } from "./canvas-fonts";

export const THEME_TOKEN_TYPES = [
  "color",
  "radius",
  "spacing",
  "container",
  "breakpoint",
  "fontFamily",
  "fontWeight",
  "fontSize",
  "lineHeight",
  "letterSpacing",
] as const;
export type ThemeTokenType = (typeof THEME_TOKEN_TYPES)[number];
export type ThemeToken = Readonly<{
  id: string;
  name: string;
  type: ThemeTokenType;
  value: string | number;
}>;
export type CanvasTheme = Readonly<{ tokens: readonly ThemeToken[] }>;
export const EMPTY_THEME: CanvasTheme = Object.freeze({ tokens: Object.freeze([]) });

function starter(type: ThemeTokenType, id: string, value: string | number, name = id): ThemeToken {
  return Object.freeze({ id, name, type, value });
}

const STARTER_GRAY = [
  ["50", "#fafafa"],
  ["100", "#f5f5f5"],
  ["200", "#e5e5e5"],
  ["300", "#d4d4d4"],
  ["400", "#a3a3a3"],
  ["500", "#737373"],
  ["600", "#525252"],
  ["700", "#404040"],
  ["800", "#262626"],
  ["900", "#171717"],
  ["950", "#0a0a0a"],
] as const;

const STARTER_BLUE = [
  ["50", "#eff6ff"],
  ["100", "#dbeafe"],
  ["200", "#bfdbfe"],
  ["300", "#93c5fd"],
  ["400", "#60a5fa"],
  ["500", "#3b82f6"],
  ["600", "#2563eb"],
  ["700", "#1d4ed8"],
  ["800", "#1e40af"],
  ["900", "#1e3a8a"],
  ["950", "#172554"],
] as const;

const STARTER_CONTAINERS = [
  ["sm", 384],
  ["md", 448],
  ["lg", 512],
  ["xl", 576],
  ["2xl", 672],
  ["3xl", 768],
  ["4xl", 896],
  ["5xl", 1024],
  ["6xl", 1152],
  ["7xl", 1280],
] as const;

const STARTER_BREAKPOINTS = [
  ["sm", 640],
  ["md", 768],
  ["lg", 1024],
  ["xl", 1280],
  ["2xl", 1536],
] as const;

const STARTER_WEIGHTS = [
  ["thin", 100],
  ["extralight", 200],
  ["light", 300],
  ["normal", 400],
  ["medium", 500],
  ["semibold", 600],
  ["bold", 700],
  ["extrabold", 800],
  ["black", 900],
] as const;

const STARTER_LINE_HEIGHTS = [
  ["none", 1],
  ["tight", 1.25],
  ["snug", 1.375],
  ["normal", 1.5],
  ["relaxed", 1.625],
  ["loose", 2],
] as const;

const STARTER_TRACKING = [
  ["tighter", -1],
  ["tight", -0.4],
  ["normal", 0],
  ["wide", 0.4],
  ["wider", 0.8],
  ["widest", 1.6],
] as const;

/** Compact starter set shown in the Theme tab empty state. */
export const STARTER_THEME: CanvasTheme = Object.freeze({
  tokens: Object.freeze([
    ...STARTER_GRAY.map(([step, value]) => starter("color", `color-gray-${step}`, value)),
    ...STARTER_BLUE.map(([step, value]) => starter("color", `color-blue-${step}`, value)),
    starter("radius", "radius-xs", 2),
    starter("radius", "radius-sm", 4),
    starter("radius", "radius-md", 6),
    starter("radius", "radius-lg", 8),
    starter("radius", "radius-xl", 12),
    starter("radius", "radius-2xl", 16),
    starter("spacing", "spacing-xs", 4),
    starter("spacing", "spacing-sm", 8),
    starter("spacing", "spacing-md", 12),
    starter("spacing", "spacing-lg", 16),
    starter("spacing", "spacing-xl", 24),
    starter("spacing", "spacing-2xl", 32),
    starter("spacing", "spacing-3xl", 48),
    starter("spacing", "spacing-4xl", 64),
    ...STARTER_CONTAINERS.map(([step, value]) =>
      starter("container", `container-${step}`, value, step),
    ),
    ...STARTER_BREAKPOINTS.map(([step, value]) =>
      starter("breakpoint", `breakpoint-${step}`, value, step),
    ),
    starter("fontFamily", "font-sans", "Inter"),
    starter("fontFamily", "font-serif", "Georgia"),
    starter("fontFamily", "font-mono", "Courier New"),
    ...STARTER_WEIGHTS.map(([step, value]) =>
      starter("fontWeight", `font-weight-${step}`, value, step),
    ),
    starter("fontSize", "text-xs", 12),
    starter("fontSize", "text-sm", 14),
    starter("fontSize", "text-base", 16),
    starter("fontSize", "text-lg", 18),
    starter("fontSize", "text-xl", 20),
    starter("fontSize", "text-2xl", 24),
    ...STARTER_LINE_HEIGHTS.map(([step, value]) =>
      starter("lineHeight", `leading-${step}`, value, step),
    ),
    ...STARTER_TRACKING.map(([step, value]) =>
      starter("letterSpacing", `tracking-${step}`, value, step),
    ),
  ]),
});
export const THEME_PROPERTIES = {
  fill: "color",
  color: "color",
  stroke: "color",
  borderColor: "color",
  fontFamily: "fontFamily",
  fontWeight: "fontWeight",
  fontSize: "fontSize",
  lineHeight: "lineHeight",
  letterSpacing: "letterSpacing",
  cornerRadius: "radius",
  layoutGap: "spacing",
  layoutPadding: "spacing",
  borderWidth: "spacing",
  strokeWidth: "spacing",
} as const;
export type ThemeProperty = keyof typeof THEME_PROPERTIES;
export type TokenBindings = Readonly<Partial<Record<ThemeProperty, string>>>;

const TEXT_THEME_PROPERTIES = new Set<ThemeProperty>([
  "fontFamily",
  "fontWeight",
  "fontSize",
  "lineHeight",
  "letterSpacing",
  "color",
]);

function isThemeTokenType(value: unknown): value is ThemeTokenType {
  return typeof value === "string" && (THEME_TOKEN_TYPES as readonly string[]).includes(value);
}

function isValidTokenValue(type: ThemeTokenType, value: unknown): boolean {
  if (type === "color")
    return typeof value === "string" && /^#(?:[a-f\d]{6}|[a-f\d]{8})$/i.test(value);
  if (type === "fontFamily") return isFontFamily(value);
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  if (type === "fontWeight") return Number.isInteger(value) && value >= 1 && value <= 1000;
  if (type === "lineHeight") return value >= 0.5 && value <= 4;
  if (type === "letterSpacing") return value >= -10 && value <= 100;
  if (type === "fontSize") return value >= 1 && value <= 10000;

  return value >= 0 && value <= 10000;
}

/** Letter spacing still accepts older spacing tokens that were bound before the dedicated type. */
export function tokenMatchesProperty(token: ThemeToken, property: ThemeProperty): boolean {
  return (
    token.type === THEME_PROPERTIES[property] ||
    (property === "letterSpacing" && token.type === "spacing")
  );
}

export function tokenCssValue(token: ThemeToken): string {
  if (token.type === "fontFamily") return JSON.stringify(token.value);
  if (token.type === "color") return String(token.value);
  if (token.type === "fontWeight" || token.type === "lineHeight") return String(token.value);

  return `${token.value}px`;
}

/** Text color and pen stroke share the Fill picker and a single binding. */
export function canonicalThemeProperty(node: CanvasFrame, property: ThemeProperty): ThemeProperty {
  return (property === "color" && node.kind === "text") ||
    (property === "stroke" && node.kind === "pen")
    ? "fill"
    : property;
}

export function normalizeTheme(value: unknown): CanvasTheme {
  if (
    !value ||
    typeof value !== "object" ||
    !("tokens" in value) ||
    !Array.isArray(value.tokens) ||
    value.tokens.length > 500
  )
    throw new Error("Theme must contain an array of at most 500 tokens.");
  const ids = new Set<string>();

  const tokens = value.tokens.map((token: unknown): ThemeToken => {
    if (!token || typeof token !== "object") throw new Error("Invalid theme token.");
    const entry = token as ThemeToken;
    if (
      typeof entry.id !== "string" ||
      !/^[a-z][a-z0-9-]{0,79}$/.test(entry.id) ||
      ids.has(entry.id)
    )
      throw new Error(
        "Token IDs must be unique lowercase names using letters, numbers and hyphens.",
      );
    ids.add(entry.id);
    if (typeof entry.name !== "string" || !entry.name.trim() || entry.name.length > 120)
      throw new Error("Tokens need a name of 1–120 characters.");
    if (!isThemeTokenType(entry.type) || !isValidTokenValue(entry.type, entry.value))
      throw new Error(
        `Invalid value for ${entry.name}. Use hex colors, a font family, a weight (1–1000), a line height (0.5–4), letter spacing (−10–100px), or a non-negative pixel value.`,
      );

    return Object.freeze({
      id: entry.id,
      name: entry.name.trim(),
      type: entry.type,
      value: entry.value,
    });
  });

  return Object.freeze({ tokens: Object.freeze(tokens) });
}

export function isTokenBindings(value: unknown): value is TokenBindings {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.entries(value).every(
      ([key, id]) =>
        Object.prototype.hasOwnProperty.call(THEME_PROPERTIES, key) &&
        typeof id === "string" &&
        /^[a-z][a-z0-9-]{0,79}$/.test(id),
    )
  );
}

export function tokenPropertyValue(node: CanvasFrame, property: ThemeProperty): unknown {
  if (property === "fill")
    return node.kind === "text"
      ? node.color
      : node.kind === "pen"
        ? node.stroke
        : "fill" in node
          ? node.fill
          : undefined;
  if (property === "layoutGap" || property === "layoutPadding")
    return !node.kind || node.kind === "frame"
      ? node.layout?.[property === "layoutGap" ? "gap" : "padding"]
      : undefined;

  return Reflect.get(node, property);
}

function assignToken(
  node: CanvasFrame,
  property: ThemeProperty,
  value: string | number,
): CanvasFrame {
  if (property === "fill") {
    if (node.kind === "text") return { ...node, color: value as string };
    if (node.kind === "pen") return { ...node, stroke: value as string };
    if (!node.kind || node.kind === "frame" || node.kind === "rectangle")
      return { ...node, fill: value as string };
  } else if (property === "layoutGap" || property === "layoutPadding") {
    if (!node.kind || node.kind === "frame")
      return {
        ...node,
        layout: {
          direction: "row",
          gap: 16,
          padding: 16,
          align: "start",
          justify: "start",
          ...node.layout,
          [property === "layoutGap" ? "gap" : "padding"]: value,
        },
      } as CanvasFrame;
  } else if (TEXT_THEME_PROPERTIES.has(property)) {
    if (node.kind === "text") return { ...node, [property]: value } as CanvasFrame;
  } else if (property === "stroke" || property === "strokeWidth") {
    if (node.kind === "pen") return { ...node, [property]: value } as CanvasFrame;
  } else return { ...node, [property]: value } as CanvasFrame;
  throw new Error(`${property} tokens cannot be used on ${node.kind ?? "frame"} nodes.`);
}

export function applyTokenBindings(
  node: CanvasFrame,
  theme: CanvasTheme,
  bindings = node.tokenBindings,
  strict = false,
): CanvasFrame {
  if (!bindings) return node;
  let updated = node;
  const kept: Partial<Record<ThemeProperty, string>> = {};

  for (const [property, id] of Object.entries(bindings) as [ThemeProperty, string][]) {
    const token = theme.tokens.find((entry) => entry.id === id);

    if (!token || !tokenMatchesProperty(token, property)) {
      if (strict) throw new Error(`Token ${id} is missing or incompatible with ${property}.`);
      continue;
    }

    const canonical = canonicalThemeProperty(node, property);
    updated = assignToken(updated, canonical, token.value);
    kept[canonical] = id;
  }

  return { ...updated, tokenBindings: Object.keys(kept).length ? kept : undefined };
}

/** Literal edits detach their binding; changing a theme uses a separate atomic operation. */
export function detachChangedTokens(before: CanvasFrame, after: CanvasFrame): CanvasFrame {
  if (!after.tokenBindings) return after;
  const bindings = { ...after.tokenBindings };

  for (const property of Object.keys(bindings) as ThemeProperty[]) {
    if (
      bindings[property] === before.tokenBindings?.[property] &&
      tokenPropertyValue(before, property) !== tokenPropertyValue(after, property)
    )
      delete bindings[property];
  }

  return { ...after, tokenBindings: Object.keys(bindings).length ? bindings : undefined };
}

export function themeCss(theme: CanvasTheme): string {
  return `:root{${theme.tokens.map((token) => `--${token.id}:${tokenCssValue(token)};`).join("")}}`;
}
