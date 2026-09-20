import { resolveCanvasFontFamily as resolveFontFamily } from "@flies/canvas";
import type { CanvasFrame, CanvasText } from "@flies/canvas";

export function htmlColor(value: string): string {
  // Computed CSS may use modern color syntax; the canvas converts it to sRGB consistently.
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d")!;
  context.fillStyle = value;
  context.fillRect(0, 0, 1, 1);

  return (
    "#" +
    Array.from(context.getImageData(0, 0, 1, 1).data, (n) => n.toString(16).padStart(2, "0")).join(
      "",
    )
  );
}

export { resolveCanvasFontFamily as resolveFontFamily } from "@flies/canvas";

export function textStyle(
  style: CSSStyleDeclaration,
): Pick<
  CanvasText,
  | "fontFamily"
  | "fontSize"
  | "fontWeight"
  | "fontStyle"
  | "textDecoration"
  | "color"
  | "lineHeight"
  | "letterSpacing"
  | "textAlign"
> {
  const fontFamily = resolveFontFamily(style.fontFamily);
  const fontSize = parseFloat(style.fontSize);
  const weight = Number(style.fontWeight);
  if (!Number.isInteger(weight) || weight < 1 || weight > 1000)
    throw new Error("Font weight must be between 1 and 1000.");
  const decoration = style.textDecorationLine;
  if (!["none", "underline", "line-through"].includes(decoration))
    throw new Error("Use a single underline or line-through decoration.");

  return {
    fontFamily,
    fontSize,
    fontWeight: weight as CanvasText["fontWeight"],
    fontStyle: style.fontStyle === "normal" ? "normal" : "italic",
    textDecoration: decoration as CanvasText["textDecoration"],
    color: htmlColor(style.color),
    lineHeight: style.lineHeight === "normal" ? 1.25 : parseFloat(style.lineHeight) / fontSize,
    letterSpacing: style.letterSpacing === "normal" ? 0 : parseFloat(style.letterSpacing),
    textAlign:
      style.textAlign === "center"
        ? "center"
        : ["right", "end"].includes(style.textAlign)
          ? "right"
          : "left",
  };
}

export function effectsStyle(
  style: CSSStyleDeclaration,
  width: number,
  height: number,
): Pick<CanvasFrame, "cornerRadius" | "borderWidth" | "borderColor" | "shadows"> {
  const radii = [
    style.borderTopLeftRadius,
    style.borderTopRightRadius,
    style.borderBottomLeftRadius,
    style.borderBottomRightRadius,
  ];

  if (radii.some((r) => r !== radii[0] || r.includes(" ")))
    throw new Error("Use a uniform corner radius.");

  const cornerRadius = radii[0].endsWith("%")
    ? (Math.min(width, height) * parseFloat(radii[0])) / 100
    : parseFloat(radii[0]);

  if (radii[0].endsWith("%") && width !== height)
    throw new Error("Use a px radius for non-square shapes (e.g. 999px for a pill).");

  const widths = [
    style.borderTopWidth,
    style.borderRightWidth,
    style.borderBottomWidth,
    style.borderLeftWidth,
  ];

  const colors = [
    style.borderTopColor,
    style.borderRightColor,
    style.borderBottomColor,
    style.borderLeftColor,
  ];

  const styles = [
    style.borderTopStyle,
    style.borderRightStyle,
    style.borderBottomStyle,
    style.borderLeftStyle,
  ];

  if (styles.some((s) => !["none", "solid"].includes(s)))
    throw new Error("Only solid borders are supported.");
  const uniform = widths.every((v) => v === widths[0]) && colors.every((v) => v === colors[0]);
  const shadows: NonNullable<CanvasFrame["shadows"]>[number][] = [];

  if (style.boxShadow !== "none") {
    // Split only commas outside rgb()/color() functions.
    const parts = style.boxShadow.split(/,(?![^()]*\))/);
    if (parts.length > 8) throw new Error("Use at most eight box shadows.");

    for (const part of parts) {
      const match = part.match(/(?:rgba?|color|oklch|oklab|lab|lch)\([^)]*\)|#[\da-f]+/i);
      if (!match) throw new Error("Unsupported shadow color.");

      const values = part
        .replace(match[0], "")
        .replace("inset", "")
        .trim()
        .split(/\s+/)
        .map(parseFloat);

      if (values.length !== 4 || values.some((v) => !Number.isFinite(v)))
        throw new Error("Unsupported box shadow.");
      shadows.push({
        offsetX: values[0],
        offsetY: values[1],
        blur: values[2],
        spread: values[3],
        color: htmlColor(match[0]),
        inset: part.includes("inset"),
      });
    }
  }

  return {
    cornerRadius,
    borderWidth: uniform ? parseFloat(widths[0]) : 0,
    borderColor: uniform ? htmlColor(colors[0]) : undefined,
    shadows: shadows.length ? shadows : undefined,
  };
}

export function nodeName(element: HTMLElement, style: CSSStyleDeclaration): string {
  const explicit =
    element.dataset.name ||
    element.getAttribute("aria-label") ||
    element.id ||
    element.getAttribute("title");

  if (explicit) return explicit.trim().slice(0, 120);
  const text = element.textContent?.replace(/\s+/g, " ").trim();
  if (
    ["button", "a", "label", "p", "span", "h1", "h2", "h3", "h4", "h5", "h6"].includes(
      element.localName,
    ) &&
    text
  )
    return text.slice(0, 80);

  const semantic: Record<string, string> = {
    header: "Header",
    footer: "Footer",
    nav: "Navigation",
    main: "Main",
    section: "Section",
    article: "Article",
    aside: "Sidebar",
    input: "Input",
    textarea: "Text area",
    img: "Image",
    ul: "List",
    ol: "List",
    li: "List item",
  };

  return (
    semantic[element.localName] ??
    (style.display.includes("grid")
      ? "Grid"
      : style.display.includes("flex")
        ? style.flexDirection.includes("column")
          ? "Column"
          : "Row"
        : "Container")
  );
}
