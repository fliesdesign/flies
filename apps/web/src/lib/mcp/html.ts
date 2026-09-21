import { SVG_DATA_URL, svgDataUrl, ensureCanvasFonts } from "@flies/canvas";
import type { CanvasFrame } from "@flies/canvas";

import {
  captureTransform,
  nativeTransform,
  nativeFilters,
  nativeBlend,
  nativeGradient,
} from "./html-paint";
import { sanitizeHtml } from "./html-sanitize";
import { effectsStyle, htmlColor, nodeName, resolveFontFamily, textStyle } from "./html-style";
import { validateSharedCss } from "./styles";
export { sanitizeHtml } from "./html-sanitize";

function transformedText(value: string, style: CSSStyleDeclaration, rendered = false) {
  const text =
    !rendered && ["normal", "nowrap"].includes(style.whiteSpace)
      ? value.replace(/[\t\r\n ]+/g, " ")
      : value;

  if (style.textTransform === "uppercase") return text.toUpperCase();
  if (style.textTransform === "lowercase") return text.toLowerCase();
  if (style.textTransform === "capitalize")
    return text.replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());

  return text;
}

/** Measure passive HTML into native editable layers, without leaking editor artboard chrome. */
export async function importHtml(
  source: string,
  options: {
    parentId?: string;
    x: number;
    y: number;
    width: number;
    height?: number;
    css?: string;
  },
): Promise<CanvasFrame[]> {
  if (options.width < 40 || options.width > 8192)
    throw new Error("HTML layout width must be between 40 and 8192px.");
  if (options.height !== undefined && (options.height < 1 || options.height > 8192))
    throw new Error("HTML layout height must be between 1 and 8192px.");
  const css = options.css ? validateSharedCss(options.css) : "";
  const fragment = sanitizeHtml(source, Boolean(css));

  const tailwind = fragment.querySelector("[class]")
    ? await (await import("./tailwind")).compileTailwind(fragment)
    : undefined;

  return importHtmlFragment(fragment, {
    ...options,
    stylesheet: [tailwind, css].filter(Boolean).join("\n"),
    sharedStyles: Boolean(css),
  });
}

/** Internal measurement entry point for already sanitized, passive capture fragments. */
export async function importHtmlFragment(
  fragment: DocumentFragment,
  options: {
    parentId?: string;
    x: number;
    y: number;
    width: number;
    height?: number;
    stylesheet?: string;
    sharedStyles?: boolean;
    prepare?: (layout: HTMLElement) => Promise<void>;
    onUnsupportedClip?: (message: string) => void;
  },
): Promise<CanvasFrame[]> {
  // A separate viewport makes responsive utilities deterministic and keeps theme,
  // preflight, @property declarations and arbitrary selectors out of the editor.
  const viewport = options.stylesheet ? document.createElement("iframe") : undefined;

  if (viewport) {
    viewport.setAttribute("sandbox", "allow-same-origin");
    viewport.setAttribute("aria-hidden", "true");
    viewport.tabIndex = -1;
    Object.assign(viewport.style, {
      position: "fixed",
      left: "-100000px",
      top: "0",
      border: "0",
      width: `${options.width}px`,
      height: `${options.height ?? 900}px`,
      pointerEvents: "none",
    });
    document.body.append(viewport);
  }

  const measurementDocument = viewport?.contentDocument ?? document;

  if (viewport) {
    const policy = document.createElement("meta");
    policy.httpEquiv = "Content-Security-Policy";
    policy.content =
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src https://fonts.gstatic.com data:";
    measurementDocument.head.append(policy);
  }

  const host = document.createElement("div");
  Object.assign(host.style, {
    position: "fixed",
    left: "-100000px",
    top: "0",
    width: `${options.width}px`,
    pointerEvents: "none",
  });
  host.setAttribute("aria-hidden", "true");
  const shadow = viewport ? host : host.attachShadow({ mode: "closed" });
  const reset = document.createElement("style");
  reset.textContent =
    ":host{all:initial} *{box-sizing:border-box;margin:0;padding:0;border:0;font:inherit;color:inherit} div,section,article,main,header,footer,nav,aside,p,h1,h2,h3,h4,h5,h6,ul,ol,li{display:block} h1{font-size:32px;font-weight:700} h2{font-size:24px;font-weight:700} h3{font-size:20px;font-weight:700} strong,b{font-weight:700} em,i{font-style:italic} small{font-size:0.85em} code{font-family:'Courier New'} button{background:transparent;text-align:center} input,textarea{background:transparent;appearance:none} img{display:block} a{text-decoration:none}";
  const layout = document.createElement("div");
  Object.assign(layout.style, {
    position: "relative",
    width: `${options.width}px`,
    height: options.height === undefined ? undefined : `${options.height}px`,
    font: options.sharedStyles
      ? "inherit"
      : options.stylesheet
        ? "400 16px/1.5 Arial"
        : "400 16px/1.25 Arial",
    color: options.sharedStyles ? "inherit" : "#000000",
  });

  if (options.stylesheet) {
    reset.textContent =
      "html{font:400 16px/1.5 Arial;color:#000;color-scheme:light} body{margin:0}\n" +
      options.stylesheet;
    // Theme variables target :root, so the compiled sheet belongs in the iframe head.
    measurementDocument.head.append(reset);
  }

  layout.append(fragment);
  if (!viewport) shadow.append(reset);
  shadow.append(layout);
  measurementDocument.body.append(host);

  try {
    if (options.stylesheet) {
      for (const element of Array.from(layout.querySelectorAll<HTMLElement>("*"))) {
        const style = getComputedStyle(element);
        if (
          style.backdropFilter !== "none" ||
          style.clipPath !== "none" ||
          style.maskImage !== "none" ||
          style.animationName !== "none"
        )
          throw new Error(
            "Backdrop filters, masks, clipping paths and animations are not supported by editable canvas layers.",
          );
        if (!["static", "relative", "absolute"].includes(style.position))
          throw new Error("Use static, relative or absolute positioning.");

        for (const pseudo of ["::before", "::after"]) {
          const content = getComputedStyle(element, pseudo).content;
          if (content !== "none" && content !== "normal")
            throw new Error(
              "Tailwind generated pseudo-element content is not supported by editable layers.",
            );
        }

        // Measure with the same fonts that the editable canvas will render.
        element.style.setProperty("font-family", resolveFontFamily(style.fontFamily), "important");
      }
    }

    for (const image of layout.querySelectorAll("img")) {
      if (!SVG_DATA_URL.test(image.src)) continue;

      const bytes = Uint8Array.from(atob(image.src.split(",")[1]), (character) =>
        character.charCodeAt(0),
      );

      const svg = new DOMParser().parseFromString(
        new TextDecoder().decode(bytes),
        "image/svg+xml",
      ).documentElement;

      if (svg.localName !== "svg") throw new Error("Invalid SVG image.");
      (svg as unknown as SVGSVGElement).style.color = getComputedStyle(image).color;
      image.src = svgDataUrl(svg as unknown as SVGSVGElement);
    }

    await ensureCanvasFonts(
      Array.from(layout.querySelectorAll<HTMLElement>("*")).map((element) => {
        const style = getComputedStyle(element);

        return {
          fontFamily: resolveFontFamily(style.fontFamily),
          fontWeight: Number(style.fontWeight),
          fontStyle: style.fontStyle,
          text: element.textContent ?? "",
        };
      }),
      measurementDocument,
    );

    if (options.prepare) {
      await options.prepare(layout);
    } else {
      await measurementDocument.fonts.ready;
      await Promise.all(Array.from(layout.querySelectorAll("img"), (img) => img.decode()));
    }

    // Measure layout boxes and text ranges without transformed axis-aligned bounds.
    // Keep the original transform as native rotation plus a layout-space translation.
    const elements = Array.from(layout.querySelectorAll<HTMLElement>("*"));

    const transforms = new Map(
      elements.map((element) => [element, captureTransform(getComputedStyle(element))]),
    );

    for (const element of elements) {
      const saved = transforms.get(element)!;

      const active = [saved.transform, saved.translate, saved.rotate, saved.scale].some(
        (v) => v !== "none",
      );

      if (!active) continue;
      const style = getComputedStyle(element);
      if (style.display === "inline")
        throw new Error("Use inline-block for transformed inline elements.");
      // Transforms establish an absolute-positioning containing block even on static elements.
      if (style.position === "static")
        element.style.setProperty("position", "relative", "important");
      for (const property of ["transform", "translate", "rotate", "scale"])
        element.style.setProperty(property, "none", "important");
    }

    const shifts = new Map<string, { dx: number; dy: number }>();
    const origin = layout.getBoundingClientRect();
    const nodes: CanvasFrame[] = [];
    let textFragments = 0;

    const add = (node: CanvasFrame) => {
      if (nodes.length >= 3000)
        throw new Error("HTML generated too many layers. Split the design into smaller sections.");
      nodes.push(node);
    };

    const baseFor = (rect: DOMRect, parentId: string | undefined, name: string) => ({
      id: crypto.randomUUID(),
      parentId,
      name,
      x: options.x + rect.x - origin.x,
      y: options.y + rect.y - origin.y,
      width: Math.max(1, rect.width),
      height: Math.max(1, rect.height),
    });

    const measuredText = (textNode: Text, parentId?: string, opacity = 1) => {
      if (!textNode.textContent?.trim()) return;
      const style = getComputedStyle(textNode.parentElement!);
      const type = textStyle(style);
      const value = textNode.textContent;
      const range = document.createRange();
      const lineHeight = type.fontSize * (type.lineHeight ?? 1.25);

      const emit = (start: number, end: number) => {
        if (!["pre", "pre-wrap", "break-spaces"].includes(style.whiteSpace)) {
          while (start < end && /\s/.test(value[start])) start++;
          while (end > start && /\s/.test(value[end - 1])) end--;
        }

        if (start === end) return;
        range.setStart(textNode, start);
        range.setEnd(textNode, end);
        const rect = range.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        if (++textFragments > 2000)
          throw new Error("Too many text fragments. Import a smaller section.");
        const text = transformedText(value.slice(start, end), style);
        add({
          ...baseFor(rect, parentId, text.slice(0, 80)),
          ...type,
          opacity,
          kind: "text",
          text,
          textAlign: "left",
          y: options.y + rect.y - origin.y - (lineHeight - rect.height) / 2,
          width: rect.width + 0.5,
          height: Math.max(1, lineHeight),
        });
      };

      let start = 0;

      while (start < value.length) {
        range.setStart(textNode, start);
        range.setEnd(textNode, value.length);

        if (range.getClientRects().length <= 1) {
          emit(start, value.length);
          break;
        }

        let low = start + 1,
          high = value.length;

        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          range.setEnd(textNode, mid);
          if (range.getClientRects().length <= 1) low = mid;
          else high = mid - 1;
        }

        emit(start, low);
        start = low;
      }
    };

    const visit = (element: HTMLElement, parentId?: string, isRoot = false) => {
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || element.localName === "br")
        return;
      const rect = element.getBoundingClientRect();

      if (style.display === "contents") {
        for (const child of Array.from(element.childNodes))
          if (child instanceof HTMLElement) visit(child, parentId);
          else if (child instanceof Text) measuredText(child, parentId);

        return;
      }

      if (!rect.width || !rect.height) return;
      if (rect.width > 8192 || rect.height > 8192)
        throw new Error("HTML elements must be no larger than 8192px per side.");
      const name = nodeName(element, style);
      const pose = nativeTransform(transforms.get(element)!, rect.width, rect.height);

      const filters = nativeFilters(style.filter),
        blendMode = nativeBlend(style.mixBlendMode);

      const gradient = nativeGradient(style, rect.width, rect.height);

      const transformed =
        Math.abs(pose.rotation) > 1e-8 || Math.abs(pose.dx) > 1e-8 || Math.abs(pose.dy) > 1e-8;

      const painted = transformed || Boolean(filters || blendMode);

      const base = {
        ...baseFor(rect, parentId, name),
        opacity: Number(style.opacity),
        ...(transformed ? { rotation: pose.rotation } : {}),
        ...(filters ? { filters } : {}),
        ...(blendMode ? { blendMode } : {}),
      };

      if (transformed) shifts.set(base.id, pose);
      const effects = effectsStyle(style, rect.width, rect.height);
      const fill = htmlColor(style.backgroundColor);
      const hasFill = !fill.endsWith("00");
      const hasEffects = Boolean(effects.borderWidth || effects.shadows?.length);

      const borderWidths = [
        style.borderTopWidth,
        style.borderRightWidth,
        style.borderBottomWidth,
        style.borderLeftWidth,
      ].map(parseFloat);

      const borderColors = [
        style.borderTopColor,
        style.borderRightColor,
        style.borderBottomColor,
        style.borderLeftColor,
      ];

      const separateBorders = !effects.borderWidth && borderWidths.some((width) => width > 0);
      const decorated = hasFill || hasEffects || separateBorders || Boolean(gradient);
      let clipped = [style.overflowX, style.overflowY].some((v) => ["hidden", "clip"].includes(v));

      if (clipped && (rect.width < 40 || rect.height < 40) && options.onUnsupportedClip) {
        clipped = false;
        if (
          element.scrollWidth > element.clientWidth + 1 ||
          element.scrollHeight > element.clientHeight + 1
        )
          options.onUnsupportedClip("Clipping in containers smaller than 40px was omitted.");
      }

      const children = Array.from(element.children);
      const hasChildren = children.some((child) => child.localName !== "br");

      // Keep section slots available for subsequent tool calls, including empty ones.
      const section =
        ["section", "article", "main", "header", "footer", "nav", "aside"].includes(
          element.localName,
        ) ||
        (element.localName === "div" && Boolean(element.dataset.name || element.id));

      const input = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;

      const plainText = input
        ? element.value || element.getAttribute("placeholder") || ""
        : element.innerText;

      const leafText = !hasChildren && plainText.trim() && !(element instanceof HTMLImageElement);

      const contentRect = new DOMRect(
        rect.x + parseFloat(style.paddingLeft) + borderWidths[3],
        rect.y + parseFloat(style.paddingTop) + borderWidths[0],
        Math.max(
          1,
          rect.width -
            parseFloat(style.paddingLeft) -
            parseFloat(style.paddingRight) -
            borderWidths[1] -
            borderWidths[3],
        ),
        Math.max(
          1,
          rect.height -
            parseFloat(style.paddingTop) -
            parseFloat(style.paddingBottom) -
            borderWidths[0] -
            borderWidths[2],
        ),
      );

      if (element instanceof HTMLInputElement || element.localName === "button") {
        const typography = textStyle(style);
        const lineHeight = typography.fontSize * (typography.lineHeight ?? 1.25);

        if (contentRect.height > lineHeight) {
          contentRect.y += (contentRect.height - lineHeight) / 2;
          contentRect.height = lineHeight;
        }
      }

      if (
        leafText &&
        !section &&
        !input &&
        !decorated &&
        !painted &&
        !clipped &&
        (style.display === "inline" ||
          style.display.includes("flex") ||
          style.display.includes("grid"))
      ) {
        for (const child of Array.from(element.childNodes))
          if (child instanceof Text) measuredText(child, parentId, base.opacity);

        return;
      }

      if (
        leafText &&
        !section &&
        !decorated &&
        !painted &&
        !clipped &&
        !style.display.includes("flex") &&
        !style.display.includes("grid") &&
        style.display !== "inline"
      ) {
        add({
          ...baseFor(contentRect, parentId, element.dataset.name ?? plainText.trim().slice(0, 80)),
          ...textStyle(style),
          kind: "text",
          text: transformedText(plainText, style, true),
          opacity: base.opacity,
        });

        return;
      }

      if (element instanceof HTMLImageElement && style.objectFit !== "fill")
        throw new Error("Use object-fit: fill for editable images.");

      if (element instanceof HTMLImageElement && !decorated && !clipped) {
        add({
          ...base,
          kind: SVG_DATA_URL.test(element.src) ? "svg" : "image",
          src: element.src,
          cornerRadius: effects.cornerRadius,
        });

        return;
      }

      if (
        !section &&
        !hasChildren &&
        !leafText &&
        !separateBorders &&
        !(element instanceof HTMLImageElement)
      ) {
        if (decorated) {
          add({ ...base, ...effects, kind: "rectangle", fill, ...(gradient ? { gradient } : {}) });
        }

        return;
      }

      // Drop purely structural, unnamed single-child divs. Their measured layout still applies.
      if (
        !isRoot &&
        element.localName === "div" &&
        !decorated &&
        !painted &&
        !clipped &&
        base.opacity === 1 &&
        !element.dataset.name &&
        !element.id &&
        children.length === 1 &&
        !Array.from(element.childNodes).some(
          (node) => node instanceof Text && node.textContent?.trim(),
        )
      ) {
        visit(children[0] as HTMLElement, parentId);

        return;
      }

      if (clipped && (rect.width < 40 || rect.height < 40))
        throw new Error(`${name}: clipped containers must be at least 40px per side.`);
      const frame = (section || decorated || clipped) && rect.width >= 40 && rect.height >= 40;
      add(
        frame
          ? {
              ...base,
              ...effects,
              kind: "frame",
              fill,
              clipContent: clipped,
              ...(gradient ? { gradient } : {}),
            }
          : { ...base, kind: "group" },
      );
      if (!frame && decorated)
        add({
          ...base,
          ...effects,
          id: crypto.randomUUID(),
          parentId: base.id,
          name: "Background",
          kind: "rectangle",
          fill,
          rotation: undefined,
          filters: undefined,
          blendMode: undefined,
          ...(gradient ? { gradient } : {}),
          opacity: 1,
        });

      if (element instanceof HTMLImageElement)
        add({
          ...baseFor(
            contentRect,
            base.id,
            element.dataset.name ||
              element.alt ||
              (SVG_DATA_URL.test(element.src) ? "SVG" : "Image"),
          ),
          kind: SVG_DATA_URL.test(element.src) ? "svg" : "image",
          src: element.src,
          cornerRadius: Math.max(0, (effects.cornerRadius ?? 0) - Math.max(...borderWidths)),
          opacity: 1,
        });
      else if (
        leafText &&
        (input ||
          (!style.display.includes("flex") &&
            !style.display.includes("grid") &&
            style.display !== "inline"))
      ) {
        add({
          ...baseFor(contentRect, base.id, plainText.trim().slice(0, 80)),
          ...textStyle(style),
          kind: "text",
          text: transformedText(plainText, style, true),
        });
      } else {
        // DOM text ranges preserve inline color runs, wrapping, and flex/grid centering.
        const ordered = Array.from(element.childNodes).map((node, index) => ({
          node,
          index,
          order: node instanceof HTMLElement ? Number(getComputedStyle(node).order) || 0 : 0,
          z: node instanceof HTMLElement ? Number(getComputedStyle(node).zIndex) || 0 : 0,
        }));

        ordered.sort((a, b) => a.z - b.z || a.order - b.order || a.index - b.index);

        for (const { node } of ordered) {
          if (node instanceof Text) measuredText(node, base.id);
          else if (node instanceof HTMLElement) visit(node, base.id);
        }
      }

      addBorders(base.id);

      function addBorders(id: string) {
        if (!separateBorders) return;
        // A one-sided divider remains an editable rectangle, rather than disappearing.
        borderWidths.forEach((width, side) => {
          if (!width) return;
          const horizontal = side === 0 || side === 2;
          add({
            ...base,
            id: crypto.randomUUID(),
            parentId: id,
            name: ["Top border", "Right border", "Bottom border", "Left border"][side],
            kind: "rectangle",
            x: base.x + (side === 1 ? base.width - width : 0),
            y: base.y + (side === 2 ? base.height - width : 0),
            width: horizontal ? base.width : width,
            height: horizontal ? width : base.height,
            fill: htmlColor(borderColors[side]),
            rotation: undefined,
            filters: undefined,
            blendMode: undefined,
            opacity: 1,
          });
        });
      }
    };

    for (const child of Array.from(layout.children))
      visit(child as HTMLElement, options.parentId, true);
    if (!nodes.length) throw new Error("HTML did not produce visible layers.");

    const byId = new Map(nodes.map((node) => [node.id, node]));

    return nodes.map((node) => {
      let ancestor: CanvasFrame | undefined = node,
        dx = 0,
        dy = 0;

      while (ancestor) {
        const shift = shifts.get(ancestor.id);
        dx += shift?.dx ?? 0;
        dy += shift?.dy ?? 0;
        ancestor = ancestor.parentId ? byId.get(ancestor.parentId) : undefined;
      }

      return dx || dy ? Object.assign({}, node, { x: node.x + dx, y: node.y + dy }) : node;
    });
  } finally {
    host.remove();
    viewport?.remove();
  }
}
