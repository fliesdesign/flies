import type { CanvasFrame } from "./canvas-document";
import { isFontFamily } from "./canvas-fonts";

export type ThemeTokenType = "color" | "fontFamily" | "spacing" | "radius" | "fontSize";
export type ThemeToken = Readonly<{
  id: string;
  name: string;
  type: ThemeTokenType;
  value: string | number;
}>;
export type CanvasTheme = Readonly<{ tokens: readonly ThemeToken[] }>;
export const EMPTY_THEME: CanvasTheme = Object.freeze({ tokens: Object.freeze([]) });
export const THEME_PROPERTIES = {
  fill: "color",
  color: "color",
  stroke: "color",
  borderColor: "color",
  fontFamily: "fontFamily",
  fontSize: "fontSize",
  cornerRadius: "radius",
  layoutGap: "spacing",
  layoutPadding: "spacing",
  letterSpacing: "spacing",
  borderWidth: "spacing",
  strokeWidth: "spacing",
} as const;
export type ThemeProperty = keyof typeof THEME_PROPERTIES;
export type TokenBindings = Readonly<Partial<Record<ThemeProperty, string>>>;

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
    const valid =
      entry.type === "color"
        ? typeof entry.value === "string" && /^#(?:[a-f\d]{6}|[a-f\d]{8})$/i.test(entry.value)
        : entry.type === "fontFamily"
          ? isFontFamily(entry.value)
          : ["spacing", "radius", "fontSize"].includes(entry.type) &&
            typeof entry.value === "number" &&
            Number.isFinite(entry.value) &&
            entry.value >= (entry.type === "fontSize" ? 1 : 0) &&
            entry.value <= 10000;
    if (!valid)
      throw new Error(
        `Invalid value for ${entry.name}. Use hex colors, a font family, or a non-negative pixel value.`,
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
  } else if (["fontFamily", "fontSize", "letterSpacing", "color"].includes(property)) {
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
    if (!token || token.type !== THEME_PROPERTIES[property]) {
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
  return `:root{${theme.tokens.map((token) => `--${token.id}:${token.type === "fontFamily" ? JSON.stringify(token.value) : token.type === "color" ? token.value : `${token.value}px`};`).join("")}}`;
}
