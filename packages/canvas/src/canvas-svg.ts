const SVG_NS = "http://www.w3.org/2000/svg";

const TAGS = new Set(
  "svg g path rect circle ellipse line polyline polygon defs linearGradient radialGradient stop clipPath mask use symbol pattern marker filter feGaussianBlur feOffset feColorMatrix feBlend feComposite feFlood feMerge feMergeNode feDropShadow title desc text tspan"
    .toLowerCase()
    .split(" "),
);

const ATTRIBUTES = new Set(
  "filter in in2 result stdDeviation dx dy type values mode operator k1 k2 k3 k4 flood-color flood-opacity color-interpolation-filters filterUnits primitiveUnits patternUnits patternContentUnits patternTransform markerWidth markerHeight refX refY orient markerUnits marker-start marker-mid marker-end color font-style letter-spacing href xlink:href d points x y x1 x2 y1 y2 cx cy r rx ry width height viewBox preserveAspectRatio transform fill fill-rule fill-opacity stroke stroke-width stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset stroke-opacity opacity mask clip-path clip-rule id offset stop-color stop-opacity maskUnits maskContentUnits gradientUnits gradientTransform spreadMethod fx fy fr font-family font-size font-weight text-anchor dominant-baseline"
    .toLowerCase()
    .split(" "),
);

const STYLES = new Set(
  "fill fill-rule fill-opacity stroke stroke-width stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset stroke-opacity opacity filter mask marker-start marker-mid marker-end clip-path clip-rule color stop-color stop-opacity font-family font-size font-weight text-anchor dominant-baseline visibility display".split(
    " ",
  ),
);

const LOCAL_REFERENCE = /^url\(\s*["']?#[\w-]+["']?\s*\)$/;

/** SVG is serialized into an image document, never mounted or allowed to reference the network. */
export function sanitizeCanvasSvg(
  source: Element,
  warn: (message: string) => void = () => {},
): SVGSVGElement {
  let count = 0;

  const copy = (node: Element, depth: number): Element | null => {
    if (++count > 1000 || depth > 40) throw new Error("An SVG is too complex to import.");

    if (!TAGS.has(node.localName.toLowerCase())) {
      warn("Unsupported SVG effects and external references were omitted.");

      return null;
    }

    const target = document.createElementNS(SVG_NS, node.localName);

    const safeValue = (value: string) =>
      !/[\\@]|(?:var|expression)\s*\(/i.test(value) &&
      (!/url\s*\(/i.test(value) || LOCAL_REFERENCE.test(value));

    for (const attribute of Array.from(node.attributes)) {
      if (
        ATTRIBUTES.has(attribute.name.toLowerCase()) &&
        safeValue(attribute.value) &&
        (!attribute.name.endsWith("href") || /^#[\w-]+$/.test(attribute.value))
      )
        target.setAttribute(
          attribute.name === "xlink:href" ? "href" : attribute.name,
          attribute.value,
        );
    }

    const style = (node as SVGElement).style;

    if (style) {
      for (const property of Array.from(style)) {
        const value = style.getPropertyValue(property);
        if (STYLES.has(property) && safeValue(value))
          (target as SVGElement).style.setProperty(property, value);
      }
    }

    for (const child of Array.from(node.childNodes)) {
      if (child instanceof Element) {
        const safe = copy(child, depth + 1);
        if (safe) target.append(safe);
      } else if (
        child.nodeType === Node.TEXT_NODE &&
        ["text", "tspan", "title", "desc"].includes(node.localName)
      ) {
        target.append(document.createTextNode(child.textContent ?? ""));
      }
    }

    return target;
  };

  const svg = copy(source, 0) as SVGSVGElement;
  svg.setAttribute("xmlns", SVG_NS);

  return svg;
}

export const SVG_DATA_URL = /^data:image\/svg\+xml;base64,[a-z\d+/]+={0,2}$/i;

export function svgDataUrl(svg: SVGSVGElement): string {
  const bytes = new TextEncoder().encode(new XMLSerializer().serializeToString(svg));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);

  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

/** Keep source vectors in the document; only the GPU's temporary texture is rasterized. */
export function readCanvasSvg(source: string, name = "SVG") {
  if (new TextEncoder().encode(source).length > 2_000_000)
    throw new Error("Choose an SVG smaller than 2 MB.");
  const parsed = new DOMParser().parseFromString(source, "image/svg+xml");
  if (parsed.querySelector("parsererror") || parsed.documentElement.localName !== "svg")
    throw new Error("This file is not valid SVG.");
  const svg = sanitizeCanvasSvg(parsed.documentElement);

  const viewBox = (svg.getAttribute("viewBox") ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);

  const dimension = (attribute: string, fallback: number) => {
    const value = svg.getAttribute(attribute) ?? "";
    const pixels = /^\d+(?:\.\d+)?(?:px)?$/.test(value) ? parseFloat(value) : fallback;

    return Number.isFinite(pixels) && pixels > 0 ? pixels : 100;
  };

  const width = dimension("width", viewBox[2]);
  const height = dimension("height", viewBox[3]);
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  if (!svg.hasAttribute("viewBox")) svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

  return { kind: "svg" as const, src: svgDataUrl(svg), width, height, name };
}
