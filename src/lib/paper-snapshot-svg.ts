const SVG_NS = "http://www.w3.org/2000/svg";
const TAGS = new Set(
  "svg g path rect circle ellipse line polyline polygon defs linearGradient radialGradient stop clipPath title desc text tspan"
    .toLowerCase()
    .split(" "),
);
const ATTRIBUTES = new Set(
  "d points x y x1 x2 y1 y2 cx cy r rx ry width height viewBox preserveAspectRatio transform fill fill-rule fill-opacity stroke stroke-width stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset stroke-opacity opacity clip-path clip-rule id offset stop-color stop-opacity gradientUnits gradientTransform spreadMethod fx fy fr font-family font-size font-weight text-anchor dominant-baseline"
    .toLowerCase()
    .split(" "),
);
const STYLES = new Set(
  "fill fill-rule fill-opacity stroke stroke-width stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset stroke-opacity opacity clip-path clip-rule color stop-color stop-opacity font-family font-size font-weight text-anchor dominant-baseline visibility display".split(
    " ",
  ),
);
const LOCAL_REFERENCE = /^url\(\s*["']?#[\w-]+["']?\s*\)$/;

/** SVG is serialized into an image document, never mounted or allowed to reference the network. */
export function sanitizeSnapshotSvg(
  source: Element,
  warn: (message: string) => void,
): SVGSVGElement {
  let count = 0;
  const copy = (node: Element, depth: number): Element | null => {
    if (++count > 1000 || depth > 40) throw new Error("A snapshot SVG is too complex to import.");
    if (!TAGS.has(node.localName.toLowerCase())) {
      warn("Unsupported SVG effects and external references were omitted.");
      return null;
    }
    const target = document.createElementNS(SVG_NS, node.localName);
    const safeValue = (value: string) =>
      !/[\\@]|(?:var|expression)\s*\(/i.test(value) &&
      (!/url\s*\(/i.test(value) || LOCAL_REFERENCE.test(value));
    for (const attribute of Array.from(node.attributes)) {
      if (ATTRIBUTES.has(attribute.name.toLowerCase()) && safeValue(attribute.value))
        target.setAttribute(attribute.name, attribute.value);
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

export function withSnapshotTimeout<T>(promise: Promise<T>, milliseconds = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error("Snapshot image decoding timed out.")),
      milliseconds,
    );
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        return resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timer);
        return reject(error);
      },
    );
  });
}

export async function rasterizeSnapshotSvg(
  svg: SVGSVGElement,
  width: number,
  height: number,
): Promise<string> {
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  const scale = Math.min(
    2,
    2048 / Math.max(width, height),
    Math.sqrt(1_000_000 / (width * height)),
  );
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(width * scale));
  canvas.height = Math.max(1, Math.ceil(height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not create a snapshot image.");
  const url = URL.createObjectURL(
    new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" }),
  );
  const image = new Image();
  try {
    image.src = url;
    await withSnapshotTimeout(image.decode());
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  } finally {
    image.src = "";
    URL.revokeObjectURL(url);
  }
}
