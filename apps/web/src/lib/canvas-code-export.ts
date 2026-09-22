import {
  rasterizeCanvasMask,
  worldTransform,
  inverseMatrix,
  multiplyMatrix,
  canvasMaskSourceIds,
  type CanvasMaskStyle,
} from "@flies/canvas";
import {
  gradientCss,
  filterCss,
  detachCanvasSelection,
  exportBounds,
  canvasTextSegments,
  canvasTextRunCss,
} from "@flies/canvas";
import { CanvasDocument, selectionBounds, fontFamilyCss, type CanvasFrame } from "@flies/canvas";

export const CANVAS_CODE_FORMATS = ["Tailwind", "CSS", "React Tailwind", "React CSS"] as const;
export type CanvasCodeFormat = (typeof CANVAS_CODE_FORMATS)[number];
type Styles = Record<string, string>;
type Element = {
  tag: string;
  styles?: Styles;
  attrs?: Record<string, string>;
  children?: (Element | string)[];
  inlineChildren?: boolean;
};
const px = (value: number) => `${Number(value.toFixed(4))}px`;

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function nodeElement(
  node: CanvasFrame,
  doc: CanvasDocument,
  origin: { x: number; y: number },
  masks: ReadonlyMap<string, CanvasMaskStyle>,
  maskSources: ReadonlySet<string>,
): Element {
  const frame = !node.kind || node.kind === "frame";

  const styles: Styles = {
    position: "absolute",
    left: px(node.x - origin.x),
    top: px(node.y - origin.y),
    width: px(node.width),
    height: px(node.height),
    "box-sizing": "border-box",
    isolation: "isolate",
    margin: "0px",
    padding: "0px",
    border: "0px",
  };

  const mask = masks.get(node.id);
  if (mask)
    Object.assign(
      styles,
      Object.fromEntries(
        Object.entries(mask).map(([key, value]) => [
          key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`),
          value,
        ]),
      ),
    );
  if (node.rotation) styles.transform = `rotate(${node.rotation}deg)`;
  if (node.blendMode) styles["mix-blend-mode"] = node.blendMode;
  const filter = filterCss(node.filters);
  if (filter) styles.filter = filter;
  if (node.opacity !== undefined) styles.opacity = String(node.opacity);
  const children: Element[] = [];

  const fillStyles: Styles = {
    display: "block",
    width: "100%",
    height: "100%",
    "border-radius": px(node.cornerRadius ?? 0),
  };

  if (frame || node.kind === "rectangle") {
    styles.background = node.gradient ? gradientCss(node.gradient) : (node.fill ?? "#ffffff");
    styles["border-radius"] = px(node.cornerRadius ?? 0);
  } else if (node.kind === "text") {
    children.push({
      tag: "span",
      inlineChildren: true,
      styles: {
        ...fillStyles,
        "box-sizing": "border-box",
        margin: "0px",
        padding: "0px",
        border: "0px",
        color: node.color,
        "font-size": px(node.fontSize),
        "font-family": fontFamilyCss(node.fontFamily),
        "font-weight": String(node.fontWeight ?? 400),
        "font-style": node.fontStyle ?? "normal",
        "text-decoration": node.textDecoration ?? "none",
        "line-height": String(node.lineHeight ?? 1.25),
        "letter-spacing": px(node.letterSpacing ?? 0),
        "text-align": node.textAlign ?? "left",
        "white-space": "pre-wrap",
        "overflow-wrap": "anywhere",
        "tab-size": "4",
        overflow: "hidden",
      },
      children: node.textRuns?.length
        ? canvasTextSegments(node).map((segment) => ({
            tag: segment.style.href ? "a" : "span",
            styles: {
              ...(segment.style.href && { color: "inherit", "text-decoration": "inherit" }),
              ...Object.fromEntries(
                Object.entries(canvasTextRunCss(segment.style)).map(([key, value]) => [
                  key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`),
                  value,
                ]),
              ),
            },
            ...(segment.style.href && { attrs: { href: segment.style.href } }),
            children: [segment.text],
          }))
        : [node.text],
    });
  } else if (node.kind === "image" || node.kind === "svg") {
    const crop = node.kind === "image" ? node.crop : undefined;

    const image: Element = {
      tag: "img",
      styles: {
        ...fillStyles,
        "max-width": "none",
        "object-fit": "fill",
        ...(crop && {
          position: "absolute",
          width: `${100 / crop.width}%`,
          height: `${100 / crop.height}%`,
          left: `${(-100 * crop.x) / crop.width}%`,
          top: `${(-100 * crop.y) / crop.height}%`,
        }),
      },
      attrs: { src: node.src, alt: "" },
    };

    children.push(
      crop
        ? {
            tag: "div",
            styles: { ...fillStyles, position: "relative", overflow: "hidden" },
            children: [image],
          }
        : image,
    );
  } else if (node.kind === "pen") {
    const first = node.points[0];
    children.push({
      tag: "svg",
      styles: { ...fillStyles, overflow: "visible" },
      attrs: {
        xmlns: "http://www.w3.org/2000/svg",
        viewBox: `0 0 ${node.pathWidth} ${node.pathHeight}`,
        preserveAspectRatio: "none",
        "aria-hidden": "true",
      },
      children: [
        node.points.length === 1 && first
          ? {
              tag: "circle",
              attrs: {
                cx: String(first.x),
                cy: String(first.y),
                r: String(node.strokeWidth / 2),
                fill: node.stroke,
              },
            }
          : {
              tag: "polyline",
              attrs: {
                points: node.points.map((p) => `${p.x},${p.y}`).join(" "),
                fill: "none",
                stroke: node.stroke,
                "stroke-width": String(node.strokeWidth),
                "stroke-linecap": "round",
                "stroke-linejoin": "round",
              },
            },
      ],
    });
  }

  const descendants = doc
    .getChildren(node.id)
    .map((id) => doc.getFrame(id)!)
    .filter((child) => !child.hidden && !maskSources.has(child.id));

  if (descendants.length) {
    const clip = frame && node.clipContent !== false;
    children.push({
      tag: "div",
      styles: {
        position: "absolute",
        inset: "0px",
        overflow: clip ? "hidden" : "visible",
        "border-radius": clip ? px(node.cornerRadius ?? 0) : "0px",
      },
      children: descendants.map((child) => nodeElement(child, doc, node, masks, maskSources)),
    });
  }

  // Overlay effects preserve the canvas's border-box geometry and child clipping.
  if (node.borderWidth || node.shadows?.length) {
    const appearance: Styles = {
      position: "absolute",
      inset: "0px",
      "box-sizing": "border-box",
      "pointer-events": "none",
      "border-style": "solid",
      "border-width": px(node.borderWidth ?? 0),
      "border-color": node.borderColor ?? "#000000",
      "border-radius": px(node.cornerRadius ?? 0),
    };

    if (node.shadows?.length)
      appearance["box-shadow"] = node.shadows
        .map(
          (s) =>
            `${s.inset ? "inset " : ""}${px(s.offsetX)} ${px(s.offsetY)} ${px(s.blur)} ${px(s.spread)} ${s.color}`,
        )
        .join(", ");
    children.push({ tag: "div", attrs: { "aria-hidden": "true" }, styles: appearance });
  }

  return { tag: "div", attrs: { "data-name": node.name }, styles, children };
}

const UTILITIES: Record<string, string> = {
  "position:absolute": "absolute",
  "position:relative": "relative",
  "display:block": "block",
  "box-sizing:border-box": "box-border",
  "isolation:isolate": "isolate",
  "width:100%": "w-full",
  "height:100%": "h-full",
  "overflow:hidden": "overflow-hidden",
  "overflow:visible": "overflow-visible",
  "pointer-events:none": "pointer-events-none",
  "object-fit:fill": "object-fill",
  "white-space:pre-wrap": "whitespace-pre-wrap",
  "border-style:solid": "border-solid",
};

const PREFIXES: Record<string, string> = {
  width: "w",
  height: "h",
  left: "left",
  top: "top",
  inset: "inset",
  margin: "m",
  padding: "p",
  "border-radius": "rounded",
  opacity: "opacity",
};

function utility(property: string, value: string): string {
  const known = UTILITIES[`${property}:${value}`];
  if (known) return known;
  const encoded = value.replace(/_/g, "\\_").replace(/ /g, "_");

  return PREFIXES[property] ? `${PREFIXES[property]}-[${encoded}]` : `[${property}:${encoded}]`;
}

function render(element: Element, react: boolean, tailwind: boolean, depth: number): string {
  const indent = "  ".repeat(depth);

  const attrs = Object.entries(element.attrs ?? {}).map(([name, value]) => {
    const attribute =
      react && name.startsWith("stroke-")
        ? name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
        : name;

    return react
      ? `${attribute}={${JSON.stringify(value)}}`
      : `${attribute}="${escapeHtml(value)}"`;
  });

  const styles = Object.entries(element.styles ?? {});

  if (styles.length) {
    if (tailwind) {
      const classes = styles.map(([property, value]) => utility(property, value)).join(" ");
      attrs.push(
        react ? `className={${JSON.stringify(classes)}}` : `class="${escapeHtml(classes)}"`,
      );
    } else if (react) {
      const style = Object.fromEntries(
        styles.map(([property, value]) => [
          property.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()),
          value,
        ]),
      );

      attrs.push(`style={${JSON.stringify(style)}}`);
    } else {
      attrs.push(
        `style="${escapeHtml(styles.map(([property, value]) => `${property}: ${value}`).join("; "))}"`,
      );
    }
  }

  const open = `${indent}<${element.tag}${attrs.length ? " " + attrs.join(" ") : ""}`;
  if (element.tag === "img") return open + (react ? " />" : ">");
  if (!element.children?.length) return `${open}></${element.tag}>`;

  if (element.inlineChildren) {
    const content = element.children
      .map((child) =>
        typeof child === "string"
          ? react
            ? `{${JSON.stringify(child)}}`
            : escapeHtml(child)
          : render(child, react, tailwind, 0),
      )
      .join("");

    return `${open}>${content}</${element.tag}>`;
  }

  if (element.children.length === 1 && typeof element.children[0] === "string") {
    const text = element.children[0];

    return `${open}>${react ? `{${JSON.stringify(text)}}` : escapeHtml(text)}</${element.tag}>`;
  }

  return `${open}>\n${element.children.map((child) => (typeof child === "string" ? `${indent}  ${react ? `{${JSON.stringify(child)}}` : escapeHtml(child)}` : render(child, react, tailwind, depth + 1))).join("\n")}\n${indent}</${element.tag}>`;
}

/** Export the measured selection, with descendants and no editor chrome or document IDs. */
export function exportCanvasCode(
  nodes: readonly CanvasFrame[],
  selectedIds: readonly string[],
  format: CanvasCodeFormat,
  masks: ReadonlyMap<string, CanvasMaskStyle> = new Map(),
): string {
  const original = new CanvasDocument(nodes);
  const maskSources = canvasMaskSourceIds(nodes);

  const roots = original
    .getRootIds(selectedIds)
    .filter((id) => !original.isHidden(id) && !maskSources.has(id));

  const exported = new Set(original.getDescendantIds(roots));
  if (nodes.some((node) => node.maskId && exported.has(node.id) && !masks.has(node.id)))
    throw new Error("Use exportCanvasCodeWithAssets to include layer masks.");

  // Export materialized appearance; links and editor metadata stay in the project file.
  const detached = detachCanvasSelection(
    nodes.map(
      ({ component: _c, instance: _i, componentSourceId: _s, maskId: _m, ...node }) =>
        node as CanvasFrame,
    ),
    roots,
  );

  const doc = new CanvasDocument(detached);

  const bounds = selectionBounds(
    roots.map((id) => ({
      ...doc.getFrame(id)!,
      ...exportBounds(doc, doc.getFrame(id)!),
      parentId: undefined,
    })),
    roots,
  );

  if (!bounds) throw new Error("Select a visible layer to copy as code.");

  const scene: Element = {
    tag: "div",
    styles: {
      position: "relative",
      width: px(bounds.width),
      height: px(bounds.height),
      isolation: "isolate",
    },
    children: roots.map((id) => nodeElement(doc.getFrame(id)!, doc, bounds, masks, maskSources)),
  };

  const react = format.startsWith("React");
  const markup = render(scene, react, format.includes("Tailwind"), react ? 2 : 0);

  return react
    ? `export default function CanvasSelection() {\n  return (\n${markup}\n  );\n}\n`
    : markup;
}

/** Resolve mask images before copying; generated code remains self-contained. */
export async function exportCanvasCodeWithAssets(
  nodes: readonly CanvasFrame[],
  selectedIds: readonly string[],
  format: CanvasCodeFormat,
) {
  const doc = new CanvasDocument(nodes);
  const exported = new Set(doc.getDescendantIds(doc.getRootIds(selectedIds)));
  const masks = new Map<string, CanvasMaskStyle>();
  await Promise.all(
    nodes
      .filter((node) => node.maskId && exported.has(node.id))
      .map(async (target) => {
        const source = doc.getFrame(target.maskId!)!;

        const transform = multiplyMatrix(
          inverseMatrix(worldTransform(doc, target)),
          worldTransform(doc, source),
        );

        masks.set(target.id, await rasterizeCanvasMask(target, source, 2, transform));
      }),
  );

  return exportCanvasCode(nodes, selectedIds, format, masks);
}
