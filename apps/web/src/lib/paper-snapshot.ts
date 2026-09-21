import { svgDataUrl } from "@flies/canvas";
import type { CanvasFrame } from "@flies/canvas";
import { importHtmlFragment } from "@flies/html";
import { resolveFontFamily } from "@flies/html";

import { loadSnapshotImage } from "./paper-snapshot-assets";
import {
  applySnapshotDecorations,
  preserveSnapshotDecorations,
  preserveSnapshotImageClips,
  type SnapshotDecorations,
} from "./paper-snapshot-decoration";
import { sanitizeSnapshotSvg, withSnapshotTimeout } from "./paper-snapshot-svg";

const MAX_BYTES = 5_000_000;
const RASTER = /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[a-z\d+/]+={0,2}$/i;

const TAGS = new Set(
  "div section article main header footer nav aside span p h1 h2 h3 h4 h5 h6 button label ul ol li img a strong b em i small code br input textarea".split(
    " ",
  ),
);

const BLOCKED = new Set(
  "script style link meta base iframe object embed audio video source track template noscript canvas".split(
    " ",
  ),
);

const STYLES = new Set(
  "display position left right top bottom width height min-width min-height max-width max-height box-sizing flex flex-direction flex-wrap flex-grow flex-shrink flex-basis align-items align-self align-content justify-content justify-items justify-self place-items place-content order z-index gap row-gap column-gap grid-template-columns grid-template-rows grid-column grid-row grid-auto-flow padding padding-top padding-right padding-bottom padding-left margin margin-top margin-right margin-bottom margin-left background-color color opacity visibility border border-width border-color border-style border-top border-right border-bottom border-left border-top-width border-right-width border-bottom-width border-left-width border-top-color border-right-color border-bottom-color border-left-color border-top-style border-right-style border-bottom-style border-left-style box-shadow border-radius border-top-left-radius border-top-right-radius border-bottom-left-radius border-bottom-right-radius font-style font-family font-size font-weight line-height letter-spacing text-align text-decoration-line text-transform vertical-align white-space overflow overflow-x overflow-y object-fit".split(
    " ",
  ),
);

const LOGICAL: Record<string, string> = {
  "inline-size": "width",
  "block-size": "height",
  "min-inline-size": "min-width",
  "min-block-size": "min-height",
  "max-inline-size": "max-width",
  "max-block-size": "max-height",
  "padding-inline-start": "padding-left",
  "padding-inline-end": "padding-right",
  "padding-block-start": "padding-top",
  "padding-block-end": "padding-bottom",
  "margin-inline-start": "margin-left",
  "margin-inline-end": "margin-right",
  "margin-block-start": "margin-top",
  "margin-block-end": "margin-bottom",
  "inset-inline-start": "left",
  "inset-inline-end": "right",
  "inset-block-start": "top",
  "inset-block-end": "bottom",
  "text-wrap-mode": "white-space",
};

const EFFECTS = new Set(
  "background-image filter backdrop-filter transform rotate scale translate mask mask-image clip-path text-shadow mix-blend-mode".split(
    " ",
  ),
);

/** The marker must appear near the clipboard fragment's beginning; no unbounded parsing on paste. */
export function isPaperSnapshot(source: string): boolean {
  return /<x-paper-html(?:\s|>)/i.test(source.slice(0, 4096));
}

function copyStyle(source: Element, target: HTMLElement, warn: (message: string) => void) {
  const style = (source as HTMLElement).style;
  if (!style) return;

  for (const input of Array.from(style)) {
    const value = style.getPropertyValue(input);
    if (EFFECTS.has(input) && !["none", "normal", "0px"].includes(value))
      warn("Gradients, filters, transforms and other unsupported effects were omitted.");
    const property = LOGICAL[input] ?? input;
    if (!STYLES.has(property)) continue;
    if (LOGICAL[input] && style.getPropertyValue(property)) continue;

    if (/[\\@]|(?:url|var|expression)\s*\(/i.test(value)) {
      warn("External resources and unresolved CSS values were omitted.");
      continue;
    }

    if (property === "position" && ["fixed", "sticky"].includes(value)) {
      target.style.position = value === "fixed" ? "absolute" : "relative";
      continue;
    }

    if (CSS.supports(property, value)) target.style.setProperty(property, value);
  }

  // Captures can specify a solid background using a shorthand as well.
  if (!target.style.backgroundColor && style.background && CSS.supports("color", style.background))
    target.style.backgroundColor = style.background;

  if (style.fontFamily) {
    try {
      target.style.fontFamily = resolveFontFamily(style.fontFamily);
    } catch {
      target.style.fontFamily = "Arial";
    }
  }

  if (style.fontWeight) {
    const weight = style.fontWeight === "bold" ? 700 : Number(style.fontWeight) || 400;
    target.style.fontWeight = String(Math.min(1000, Math.max(1, Math.round(weight))));
  }

  if (style.textDecorationLine)
    target.style.textDecorationLine = style.textDecorationLine.includes("underline")
      ? "underline"
      : style.textDecorationLine.includes("line-through")
        ? "line-through"
        : "none";
  target.style.setProperty("animation", "none");
  target.style.setProperty("transition", "none");
}

function normalizeMeasuredStyles(layout: HTMLElement, warn: (message: string) => void) {
  for (const element of Array.from(layout.querySelectorAll<HTMLElement>("*"))) {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (rect.width > 8192 || rect.height > 8192)
      throw new Error("Snapshot elements must be no larger than 8192px per side.");

    for (const side of ["Top", "Right", "Bottom", "Left"] as const) {
      if (!["none", "solid"].includes(style[`border${side}Style`])) {
        element.style[`border${side}Style`] = "solid";
        warn("Non-solid borders were simplified to solid borders.");
      }
    }

    if (
      (rect.width < 40 || rect.height < 40) &&
      [style.overflowX, style.overflowY].some((v) => ["hidden", "clip"].includes(v))
    ) {
      element.style.overflow = "visible";
      if (
        element.scrollWidth > element.clientWidth + 1 ||
        element.scrollHeight > element.clientHeight + 1
      )
        warn("Clipping in containers smaller than 40px was omitted.");
    }

    const size = parseFloat(style.fontSize);
    const lineHeight = style.lineHeight === "normal" ? 1.25 : parseFloat(style.lineHeight) / size;
    if (!Number.isFinite(lineHeight) || lineHeight < 0.5 || lineHeight > 4)
      element.style.lineHeight = String(
        Number.isFinite(lineHeight) ? Math.min(4, Math.max(0.5, lineHeight)) : 1.25,
      );
    const letterSpacing = parseFloat(style.letterSpacing);
    if (letterSpacing < -10 || letterSpacing > 100)
      element.style.letterSpacing = `${Math.min(100, Math.max(-10, letterSpacing))}px`;
    if (size === 0 && element.textContent?.trim()) element.style.fontSize = "1px";

    if (style.boxShadow !== "none" && style.boxShadow.split(/,(?![^()]*\))/).length > 8) {
      element.style.boxShadow = "none";
      warn("Excessive box shadows were omitted.");
    }
  }
}

/** Import the extension's clipboard HTML as editable native layers with local SVG raster assets. */
export async function importPaperSnapshot(
  source: string,
  options: { loadImage?: (url: string) => Promise<string> } = {},
): Promise<{ nodes: CanvasFrame[]; warnings: string[] }> {
  if (!isPaperSnapshot(source)) throw new Error("The clipboard does not contain a Paper snapshot.");
  if (source.length > MAX_BYTES || new TextEncoder().encode(source).length > MAX_BYTES)
    throw new Error("Paper snapshots are limited to 5MB. Capture a smaller section.");
  const template = document.createElement("template");
  template.innerHTML = source;
  const capture = template.content.querySelector("x-paper-html");
  if (!capture) throw new Error("The Paper snapshot is missing its captured content.");
  const warnings = new Set<string>();

  const warn = (message: string) => {
    warnings.add(message);
  };

  const svgs: { holder: HTMLElement; svg: SVGSVGElement }[] = [];
  const images: { image: HTMLImageElement; src: string }[] = [];
  let count = 0;

  const copy = (node: Node, depth: number, inheritedFill = ""): Node | null => {
    if (depth > 60) throw new Error("Paper snapshot nesting is limited to 60 levels.");
    if (++count > 2000)
      throw new Error("Paper snapshots are limited to 2000 nodes. Capture a smaller section.");
    if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.textContent ?? "");
    if (!(node instanceof Element)) return null;
    if (BLOCKED.has(node.localName)) return null;
    const fill = (node as HTMLElement).style?.fill || inheritedFill;

    if (node.localName === "svg") {
      if (svgs.length >= 64) throw new Error("Paper snapshots are limited to 64 SVG images.");
      const holder = document.createElement("span");
      holder.style.display = "inline-block";
      copyStyle(node, holder, warn);
      if (!holder.style.opacity && node.hasAttribute("opacity"))
        holder.style.opacity = node.getAttribute("opacity")!;
      for (const dimension of ["width", "height"] as const)
        if (!holder.style[dimension] && node.getAttribute(dimension))
          holder.style[dimension] = /^\d+(?:\.\d+)?$/.test(node.getAttribute(dimension)!)
            ? `${node.getAttribute(dimension)}px`
            : node.getAttribute(dimension)!;
      if (!holder.style.width) holder.style.width = "24px";
      if (!holder.style.height) holder.style.height = "24px";
      count += node.querySelectorAll("*").length;
      if (count > 2000)
        throw new Error("Paper snapshots are limited to 2000 nodes. Capture a smaller section.");
      const svg = sanitizeSnapshotSvg(node, warn);
      // The surrounding editable layer carries root opacity.
      svg.removeAttribute("opacity");
      svg.style.removeProperty("opacity");
      if (!svg.style.fill && fill && (CSS.supports("color", fill) || fill === "none"))
        svg.style.fill = fill;
      svgs.push({ holder, svg });

      return holder;
    }

    const tag = TAGS.has(node.localName) ? node.localName : "div";
    const imageSource = node.getAttribute("src") ?? "";

    const externalImage =
      tag === "img" && !RASTER.test(imageSource) && !/^https?:\/\//i.test(imageSource);

    const element = document.createElement(externalImage ? "div" : tag);
    copyStyle(node, element, warn);
    for (const name of ["data-name", "aria-label", "title", "alt"])
      if (node.hasAttribute(name))
        element.setAttribute(name, node.getAttribute(name)!.slice(0, 120));

    if (externalImage) {
      warn("Images with unsupported URLs were left as placeholders.");
      element.dataset.name = node.getAttribute("alt") || "Image placeholder";
      if (!element.style.backgroundColor) element.style.backgroundColor = "#80808030";
    }

    if (tag === "img") {
      for (const dimension of ["width", "height"] as const)
        if (!element.style[dimension] && /^\d+(?:\.\d+)?$/.test(node.getAttribute(dimension) ?? ""))
          element.style[dimension] = `${node.getAttribute(dimension)}px`;

      if (element instanceof HTMLImageElement) {
        if (images.length >= 64)
          throw new Error("Paper snapshots are limited to 64 embedded images.");
        element.style.objectFit = "fill";
        if (
          node.getAttribute("style")?.includes("object-fit") &&
          (node as HTMLElement).style.objectFit !== "fill"
        )
          warn("Image fitting was simplified to fill its captured bounds.");
        images.push({ image: element, src: node.getAttribute("src")! });
      }
    }

    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      element.readOnly = true;
      element.value = node.getAttribute("value") || node.textContent || "";
      element.placeholder = node.getAttribute("placeholder") ?? "";

      if (
        !element.value &&
        element.placeholder &&
        node.hasAttribute("data-paper-placeholder-styles")
      ) {
        const placeholder = document.createElement("span");
        const declarations = document.createElement("span").style;
        declarations.cssText = node.getAttribute("data-paper-placeholder-styles")!;
        for (const property of [
          "color",
          "font-family",
          "font-size",
          "font-weight",
          "font-style",
          "letter-spacing",
          "text-transform",
        ])
          placeholder.style.setProperty(property, declarations.getPropertyValue(property));
        copyStyle(placeholder, element, warn);
      }
    }

    for (const child of Array.from(node.childNodes)) {
      const safe = copy(child, depth + 1, fill);
      if (safe) element.append(safe);
    }

    return element;
  };

  const fragment = document.createDocumentFragment();

  for (const node of Array.from(capture.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE && !node.textContent?.trim()) continue;
    const safe = copy(node, 0);
    if (safe) fragment.append(safe);
  }

  if (!fragment.children.length)
    throw new Error("The Paper snapshot contains no visible elements.");
  const roots = Array.from(fragment.children) as HTMLElement[];
  const firstStyle = roots[0].style;
  const width = Math.min(8192, Math.max(40, parseFloat(firstStyle.width) || 1440));
  let bounds = { x: 0, y: 0, width, height: 1 };
  let decorations: SnapshotDecorations = new Map();

  const nodes = await importHtmlFragment(fragment, {
    x: 0,
    y: 0,
    width,
    onUnsupportedClip: warn,
    prepare: async (layout) => {
      const deadline = performance.now() + 12_000;
      await withSnapshotTimeout(document.fonts.ready).catch(() =>
        warn("Fonts were still loading; local fallback metrics were used."),
      );
      let embeddedPixels = 0;

      for (const { image, src } of images) {
        if (performance.now() > deadline)
          throw new Error("Snapshot decoding took too long. Capture a smaller section.");

        try {
          // Resolve remote URLs into bounded local raster data before anything is mounted.
          let resolved = src;

          if (!RASTER.test(src)) {
            // eslint-disable-next-line no-await-in-loop
            resolved = await withSnapshotTimeout(
              (options.loadImage ?? loadSnapshotImage)(src),
              5000,
            );
          }

          if (!RASTER.test(resolved))
            throw new Error("The image resolver returned unsupported image data.");
          image.src = resolved;
          // Decode sequentially so the retained bitmap budget is checked before the next image.
          // eslint-disable-next-line no-await-in-loop
          await withSnapshotTimeout(image.decode());
          embeddedPixels += image.naturalWidth * image.naturalHeight;
          if (embeddedPixels > 16_000_000) throw new Error("Large image");
        } catch {
          const placeholder = document.createElement("div");
          placeholder.style.cssText = image.style.cssText;
          placeholder.style.backgroundColor = "#80808030";
          placeholder.dataset.name = "Image placeholder";
          image.replaceWith(placeholder);
          image.removeAttribute("src");
          warn("Images that could not be loaded were replaced with placeholders.");
        }
      }

      preserveSnapshotImageClips(layout);
      normalizeMeasuredStyles(layout, warn);
      let pixels = 0;

      for (const { holder, svg } of svgs) {
        if (performance.now() > deadline)
          throw new Error("Snapshot decoding took too long. Capture a smaller section.");
        const rect = holder.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        pixels += Math.min(1_000_000, rect.width * rect.height * 4);
        if (pixels > 8_000_000)
          throw new Error(
            "Snapshot SVG images exceed the decoding budget. Capture a smaller section.",
          );
        svg.style.color = getComputedStyle(holder).color;
        const image = document.createElement("img");

        try {
          svg.setAttribute("width", String(rect.width));
          svg.setAttribute("height", String(rect.height));
          image.src = svgDataUrl(svg);
          image.style.cssText = holder.style.cssText;
          image.style.width = `${rect.width}px`;
          image.style.height = `${rect.height}px`;
          image.style.boxSizing = "border-box";
          image.style.objectFit = "fill";
          image.alt = "Vector image";
          // eslint-disable-next-line no-await-in-loop
          await withSnapshotTimeout(image.decode());
          holder.replaceWith(image);
        } catch {
          warn("An unsupported SVG image was omitted.");
        }
      }

      normalizeMeasuredStyles(layout, warn);
      decorations = preserveSnapshotDecorations(layout, warn);

      const rects = Array.from(layout.children)
        .filter((root) => root.isConnected)
        .map((root) => root.getBoundingClientRect())
        .filter((rect) => rect.width && rect.height);

      if (!rects.length) throw new Error("The Paper snapshot contains no visible elements.");
      const origin = layout.getBoundingClientRect();

      const x = Math.min(...rects.map((r) => r.x)),
        y = Math.min(...rects.map((r) => r.y));

      bounds = {
        x: x - origin.x,
        y: y - origin.y,
        width: Math.max(...rects.map((r) => r.right)) - x,
        height: Math.max(...rects.map((r) => r.bottom)) - y,
      };
      if (bounds.width > 8192 || bounds.height > 8192)
        throw new Error("Paper snapshots must be no larger than 8192px per side.");
    },
  });

  const rootId = crypto.randomUUID();

  const root: CanvasFrame = {
    id: rootId,
    kind: "group",
    name: "Paper snapshot",
    x: 0,
    y: 0,
    width: Math.max(1, bounds.width),
    height: Math.max(1, bounds.height),
  };

  const imported: CanvasFrame[] = [root];
  for (const node of applySnapshotDecorations(nodes, decorations))
    imported.push({
      ...node,
      parentId: node.parentId ?? rootId,
      x: node.x - bounds.x,
      y: node.y - bounds.y,
    });

  return { nodes: imported, warnings: Array.from(warnings) };
}
