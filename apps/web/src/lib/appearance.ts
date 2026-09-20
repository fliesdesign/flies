export const APPEARANCE_STORAGE_KEY = "flies.appearance.v1";
export const APPEARANCE_RANGE = { min: -50, max: 50 } as const;

export const UI_COLOR_TOKENS = [
  { id: "background", label: "Background", group: "Surfaces" },
  { id: "shell", label: "Shell", group: "Surfaces" },
  { id: "card", label: "Panel", group: "Surfaces" },
  { id: "popover", label: "Menu", group: "Surfaces" },
  { id: "muted", label: "Muted", group: "Surfaces" },
  { id: "secondary", label: "Secondary", group: "Surfaces" },
  { id: "accent", label: "Accent", group: "Surfaces" },
  { id: "input", label: "Input", group: "Surfaces" },
  { id: "editor-field", label: "Field", group: "Surfaces" },
  { id: "editor-field-hover", label: "Field hover", group: "Surfaces" },
  { id: "editor-selection", label: "Selection", group: "Surfaces" },
  { id: "foreground", label: "Foreground", group: "Text" },
  { id: "muted-foreground", label: "Muted text", group: "Text" },
  { id: "secondary-foreground", label: "Secondary text", group: "Text" },
  { id: "accent-foreground", label: "Accent text", group: "Text" },
  { id: "primary-foreground", label: "Primary text", group: "Text" },
  { id: "editor-selection-text", label: "Selection text", group: "Text" },
  { id: "border", label: "Border", group: "Lines" },
  { id: "card-border", label: "Panel border", group: "Lines" },
  { id: "ring", label: "Focus ring", group: "Lines" },
  { id: "editor-guide", label: "Guides", group: "Lines" },
  { id: "primary", label: "Primary", group: "Actions" },
  { id: "primary-hover", label: "Primary hover", group: "Actions" },
  { id: "destructive", label: "Destructive", group: "Actions" },
] as const;

export type UiColorId = (typeof UI_COLOR_TOKENS)[number]["id"];
export type Appearance = {
  brightness: number;
  contrast: number;
  colors: Partial<Record<UiColorId, string>>;
};

/** Defaults match `:root` in styles.css. */
export const DEFAULT_UI_COLORS: Record<UiColorId, string> = {
  background: "#0c0c0c",
  shell: "#080808",
  card: "#121212",
  popover: "#161616",
  muted: "#141414",
  secondary: "#1c1c1c",
  accent: "#242424",
  input: "#1a1a1a",
  "editor-field": "#0f0f0f",
  "editor-field-hover": "#161616",
  "editor-selection": "#2a2a2a",
  foreground: "#ececec",
  "muted-foreground": "#8e8e8e",
  "secondary-foreground": "#e6e6e6",
  "accent-foreground": "#f0f0f0",
  "primary-foreground": "#111111",
  "editor-selection-text": "#f2f2f2",
  border: "#222222",
  "card-border": "#242424",
  ring: "#c8c8c8",
  "editor-guide": "#c8c8c8",
  primary: "#c8c8c8",
  "primary-hover": "#f2f2f2",
  destructive: "#e05252",
};

export const DEFAULT_APPEARANCE: Appearance = {
  brightness: 0,
  contrast: 0,
  colors: {},
};

const TOKEN_IDS = new Set<string>(UI_COLOR_TOKENS.map((token) => token.id));

export function isUiColorId(value: string): value is UiColorId {
  return TOKEN_IDS.has(value);
}

export function parseUiHex(value: string): string | null {
  const hex = value.trim().replace(/^#/, "");
  if (/^[\da-f]{3}$/i.test(hex))
    return `#${hex
      .split("")
      .map((digit) => digit + digit)
      .join("")}`.toLowerCase();
  return /^[\da-f]{6}$/i.test(hex) ? `#${hex.toLowerCase()}` : null;
}

function clampRange(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(APPEARANCE_RANGE.min, Math.min(APPEARANCE_RANGE.max, Math.round(value)));
}

function mixChannel(channel: number, amount: number) {
  return amount >= 0 ? channel + (255 - channel) * amount : channel * (1 + amount);
}

function contrastChannel(channel: number, amount: number) {
  return 128 + (channel - 128) * (1 + amount);
}

export function adjustUiColor(hex: string, brightness: number, contrast: number): string {
  const parsed = parseUiHex(hex);
  if (!parsed) return DEFAULT_UI_COLORS.background;
  const lift = (clampRange(brightness) / APPEARANCE_RANGE.max) * 0.45;
  const stretch = (clampRange(contrast) / APPEARANCE_RANGE.max) * 0.55;
  if (lift === 0 && stretch === 0) return parsed;
  let output = "#";
  for (let index = 1; index <= 5; index += 2) {
    const channel = Number.parseInt(parsed.slice(index, index + 2), 16);
    const next = Math.round(
      Math.max(0, Math.min(255, contrastChannel(mixChannel(channel, lift), stretch))),
    );
    output += next.toString(16).padStart(2, "0");
  }
  return output;
}

export function normalizeAppearance(value: unknown): Appearance {
  const source = value && typeof value === "object" ? (value as Partial<Appearance>) : {};
  const colors: Appearance["colors"] = {};
  if (source.colors && typeof source.colors === "object") {
    for (const [id, hex] of Object.entries(source.colors)) {
      if (!isUiColorId(id) || typeof hex !== "string") continue;
      const parsed = parseUiHex(hex);
      if (parsed && parsed !== DEFAULT_UI_COLORS[id]) colors[id] = parsed;
    }
  }
  return {
    brightness: clampRange(typeof source.brightness === "number" ? source.brightness : 0),
    contrast: clampRange(typeof source.contrast === "number" ? source.contrast : 0),
    colors,
  };
}

export function isDefaultAppearance(appearance: Appearance) {
  return (
    appearance.brightness === 0 &&
    appearance.contrast === 0 &&
    Object.keys(appearance.colors).length === 0
  );
}

export function resolvedUiColors(appearance: Appearance): Record<UiColorId, string> {
  const resolved = { ...DEFAULT_UI_COLORS };
  for (const token of UI_COLOR_TOKENS) {
    const base = appearance.colors[token.id] ?? DEFAULT_UI_COLORS[token.id];
    resolved[token.id] = adjustUiColor(base, appearance.brightness, appearance.contrast);
  }
  return resolved;
}

function storage() {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function loadAppearance(): Appearance {
  const raw = storage()?.getItem(APPEARANCE_STORAGE_KEY);
  if (!raw) return DEFAULT_APPEARANCE;
  try {
    return normalizeAppearance(JSON.parse(raw) as unknown);
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

export function applyAppearance(
  appearance: Appearance,
  target?: {
    style: { setProperty(name: string, value: string): void; removeProperty(name: string): void };
  } | null,
) {
  const root = target ?? globalThis.document?.documentElement;
  if (!root) return;
  if (isDefaultAppearance(appearance)) {
    for (const token of UI_COLOR_TOKENS) root.style.removeProperty(`--${token.id}`);
    return;
  }
  const colors = resolvedUiColors(appearance);
  for (const token of UI_COLOR_TOKENS) root.style.setProperty(`--${token.id}`, colors[token.id]);
}

export function applyStoredAppearance() {
  applyAppearance(loadAppearance());
}

export function saveAppearance(appearance: Appearance): Appearance {
  const next = normalizeAppearance(appearance);
  try {
    if (isDefaultAppearance(next)) storage()?.removeItem(APPEARANCE_STORAGE_KEY);
    else storage()?.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* private mode still applies the live theme */
  }
  applyAppearance(next);
  return next;
}
