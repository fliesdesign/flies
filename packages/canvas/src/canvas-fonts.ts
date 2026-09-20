import { invoke, isTauri } from "@tauri-apps/api/core";

export const GOOGLE_FONT_FAMILIES = [
  "Inter",
  "Roboto",
  "Open Sans",
  "Lato",
  "Montserrat",
  "Poppins",
  "Nunito Sans",
  "DM Sans",
  "Manrope",
  "Work Sans",
  "Outfit",
  "Space Grotesk",
  "Plus Jakarta Sans",
  "Source Sans 3",
  "Noto Sans",
  "Noto Serif",
  "Lora",
  "Merriweather",
  "Playfair Display",
  "Libre Baskerville",
  "IBM Plex Sans",
  "IBM Plex Mono",
  "JetBrains Mono",
  "Fira Code",
];
export const BUILTIN_FONT_FAMILIES = ["Arial", "Helvetica", "Georgia", "Courier New"];
export type FontRequest = {
  fontFamily?: string;
  fontWeight?: number;
  fontStyle?: string;
  text?: string;
};
type SystemFont = { family: string; postscriptName: string; weight: number; style: string };
let systemFonts: Promise<SystemFont[]> | undefined;
const stylesheets = new Map<string, Promise<string>>();
const loaded = new WeakMap<Document, Map<string, Promise<void>>>();

export function isFontFamily(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 200 &&
    ![...value].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) &&
    !/[;{}<>]/.test(value)
  );
}
export function fontFamilyCss(family = "Arial"): string {
  const known: Record<string, string> = {
    Arial: "Arial, Helvetica, sans-serif",
    Helvetica: "Helvetica, Arial, sans-serif",
    Georgia: "Georgia, 'Times New Roman', serif",
    "Courier New": "'Courier New', Courier, monospace",
  };
  return known[family] ?? `${JSON.stringify(family)}, sans-serif`;
}
export function resolveCanvasFontFamily(stack: string): string {
  const aliases: Record<string, string> = {
    "sans-serif": "Arial",
    "system-ui": "Arial",
    "-apple-system": "Arial",
    blinkmacsystemfont: "Arial",
    "ui-sans-serif": "Arial",
    serif: "Georgia",
    "ui-serif": "Georgia",
    monospace: "Courier New",
    "ui-monospace": "Courier New",
  };
  const first = stack
    .split(",")[0]
    .trim()
    .replace(/^["']|["']$/g, "");
  if (!isFontFamily(first)) throw new Error("Invalid font family.");
  return aliases[first.toLowerCase()] ?? first;
}
function getSystemFonts() {
  systemFonts ??= invoke<SystemFont[]>("list_system_fonts").catch((error) => {
    systemFonts = undefined;
    throw error;
  });
  return systemFonts;
}
export async function listCanvasFonts(): Promise<string[]> {
  const local = isTauri() ? (await getSystemFonts()).map((face) => face.family) : [];
  // eslint-disable-next-line unicorn/no-array-sort -- Canvas targets ES2022.
  return [...new Set([...BUILTIN_FONT_FAMILIES, ...local, ...GOOGLE_FONT_FAMILIES])].sort((a, b) =>
    a.localeCompare(b),
  );
}
function timeout<T>(promise: Promise<T>, family: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Font “${family}” took too long to load.`)),
      10000,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        return resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
async function googleStyles(family: string, weight: number, italic: boolean) {
  const key = `${family}:${weight}:${italic}`;
  let pending = stylesheets.get(key);
  if (!pending) {
    const url = new URL("https://fonts.googleapis.com/css2");
    url.searchParams.set("family", `${family}:ital,wght@${italic ? 1 : 0},${weight}`);
    url.searchParams.set("display", "swap");
    pending = fetch(url, { signal: AbortSignal.timeout(10000), cache: "force-cache" })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(`Font “${family}” is not available locally or on Google Fonts.`);
        const css = await response.text();
        if (!css.includes("@font-face"))
          throw new Error(`Google Fonts returned no font for “${family}”.`);
        return css;
      })
      .catch((error) => {
        stylesheets.delete(key);
        throw error;
      });
    stylesheets.set(key, pending);
  }
  return pending;
}

/** Load the requested face in the actual measuring/rendering document, including isolated imports. */
export async function ensureCanvasFont(
  request: FontRequest,
  targetDocument?: Document,
): Promise<void> {
  const family = request.fontFamily ?? "Arial";
  if (!isFontFamily(family)) throw new Error("Invalid font family.");
  if (BUILTIN_FONT_FAMILIES.some((name) => name.toLowerCase() === family.toLowerCase())) return;
  const doc = targetDocument ?? document;
  const weight = request.fontWeight ?? 400;
  const italic = request.fontStyle === "italic" || request.fontStyle === "oblique";
  const key = `${family}:${weight}:${italic}`;
  let cache = loaded.get(doc);
  if (!cache) {
    cache = new Map();
    loaded.set(doc, cache);
  }
  let pending = cache.get(key);
  if (!pending) {
    pending = (async () => {
      if (isTauri()) {
        const faces = (await getSystemFonts()).filter(
          (face) => face.family.toLowerCase() === family.toLowerCase(),
        );
        if (faces.length) {
          const localFaces = faces.map(
            (face) =>
              new FontFace(family, `local(${JSON.stringify(face.postscriptName)})`, {
                weight: String(face.weight),
                style: face.style,
              }),
          );
          const results = await Promise.allSettled(localFaces.map((face) => face.load()));
          const available = results.flatMap((result) =>
            result.status === "fulfilled" ? [result.value] : [],
          );
          if (available.length) {
            for (const face of available) doc.fonts.add(face);
            return;
          }
        }
      }
      const css = await googleStyles(family, weight, italic);
      const style = doc.createElement("style");
      style.dataset.canvasFont = key;
      style.textContent = css;
      doc.head.append(style);
    })().catch((error) => {
      cache!.delete(key);
      throw error;
    });
    cache.set(key, pending);
  }
  try {
    await timeout(pending, family);
    // Later text can require additional Unicode subsets of an already registered face.
    const faces = await timeout(
      doc.fonts.load(
        `${italic ? "italic" : "normal"} ${weight} 16px ${JSON.stringify(family)}`,
        request.text || "BESbswy",
      ),
      family,
    );
    if (!faces.length) throw new Error(`Font “${family}” could not be loaded.`);
  } catch (error) {
    cache.delete(key);
    for (const style of doc.querySelectorAll<HTMLStyleElement>("style[data-canvas-font]")) {
      if (style.dataset.canvasFont === key) style.remove();
    }
    throw error;
  }
}

export async function ensureCanvasFonts(nodes: readonly FontRequest[], doc: Document = document) {
  const requests = new Map<string, FontRequest>();
  for (const node of nodes) {
    if (!node.fontFamily) continue;
    const key = `${node.fontFamily}:${node.fontWeight ?? 400}:${node.fontStyle ?? "normal"}`;
    const previous = requests.get(key);
    requests.set(key, { ...node, text: (previous?.text ?? "") + (node.text ?? "") });
  }
  await Promise.all([...requests.values()].map((request) => ensureCanvasFont(request, doc)));
}
