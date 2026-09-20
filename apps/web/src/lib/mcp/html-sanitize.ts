import { readCanvasSvg } from "@flies/canvas";

import { resolveFontFamily } from "./html-style";
const TAGS = new Set(
  "div section article main header footer nav aside span p h1 h2 h3 h4 h5 h6 button label ul ol li img a strong b em i small code br input textarea".split(
    " ",
  ),
);
const STYLES = new Set(
  "display position left right top bottom width height min-width min-height max-width max-height box-sizing flex flex-direction flex-wrap flex-grow flex-shrink flex-basis align-items align-self align-content justify-content justify-items justify-self place-items place-content order z-index gap row-gap column-gap grid-template-columns grid-template-rows grid-column grid-row grid-auto-flow padding padding-top padding-right padding-bottom padding-left margin margin-top margin-right margin-bottom margin-left background background-color color opacity visibility border border-width border-color border-style border-top border-right border-bottom border-left border-top-width border-right-width border-bottom-width border-left-width border-top-color border-right-color border-bottom-color border-left-color border-top-style border-right-style border-bottom-style border-left-style box-shadow border-radius font font-style font-family font-size font-weight line-height letter-spacing text-align text-decoration text-decoration-line text-transform vertical-align white-space overflow overflow-x overflow-y object-fit".split(
    " ",
  ),
);
const RASTER = /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[a-z\d+/]+={0,2}$/i;

/** Build fresh, passive elements. Never mount caller markup or copy event/URL attributes. */
export function sanitizeHtml(source: string, allowVariables = false): DocumentFragment {
  if (new TextEncoder().encode(source).length > 200_000)
    throw new Error("HTML is limited to 200KB.");
  const template = document.createElement("template");
  template.innerHTML = source;
  let count = 0;
  const copy = (node: Node, depth: number): Node => {
    if (depth > 30) throw new Error("HTML nesting is limited to 30 levels.");
    if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.textContent ?? "");
    if (node instanceof Element && node.localName === "svg") {
      const svgSource = node.cloneNode(true) as SVGSVGElement;
      // Root CSS opacity belongs to the editable wrapper, not both wrapper and asset.
      if (svgSource.style.opacity) {
        svgSource.style.removeProperty("opacity");
        svgSource.removeAttribute("opacity");
      }
      const vector = readCanvasSvg(new XMLSerializer().serializeToString(svgSource));
      const image = document.createElement("img");
      image.src = vector.src;
      image.width = vector.width;
      image.height = vector.height;
      for (const attribute of ["class", "data-name", "aria-label"])
        if (node.hasAttribute(attribute))
          image.setAttribute(attribute, node.getAttribute(attribute)!);
      const rootStyle = (node as SVGElement).style;
      for (const property of Array.from(rootStyle)) {
        if (STYLES.has(property))
          image.style.setProperty(property, rootStyle.getPropertyValue(property));
      }
      // Reuse the HTML style validation before mounting this passive image.
      return copy(image, depth);
    }
    if (!(node instanceof HTMLElement) || !TAGS.has(node.localName))
      throw new Error(
        "Only passive HTML elements are supported. No scripts, stylesheets or custom elements.",
      );
    if (++count > 500) throw new Error("HTML is limited to 500 elements.");
    const element = document.createElement(node.localName);
    for (const attribute of Array.from(node.attributes)) {
      if (
        ![
          "style",
          "data-name",
          "src",
          "alt",
          "id",
          "class",
          "aria-label",
          "title",
          "href",
          "type",
          "placeholder",
          "value",
          "width",
          "height",
        ].includes(attribute.name)
      )
        throw new Error(
          `Unsupported HTML attribute: ${attribute.name}. Use Tailwind classes, inline styles and data-name.`,
        );
      if (
        attribute.name === "src" &&
        (node.localName !== "img" ||
          (!RASTER.test(attribute.value) &&
            !/^data:image\/svg\+xml;base64,[a-z\d+/]+={0,2}$/i.test(attribute.value)))
      )
        throw new Error("Images must use embedded raster or SVG data URLs.");
      // Names and typography remain useful; links and form actions are never interactive.
      if (!["style", "href", "type"].includes(attribute.name))
        element.setAttribute(attribute.name, attribute.value);
    }
    // Reject values before assigning styles, including escaped URLs and CSS custom properties.
    const raw = node.getAttribute("style") ?? "";
    if (/url\s*\(|\\|@|expression\s*\(/i.test(raw) || (!allowVariables && /var\s*\(/i.test(raw)))
      throw new Error("External resources, CSS escapes and variables are not supported.");
    for (const declaration of raw.split(";").filter((entry) => entry.trim())) {
      const colon = declaration.indexOf(":");
      if (colon < 1) throw new Error("Invalid inline CSS declaration.");
      const property = declaration.slice(0, colon).trim().toLowerCase();
      const value = declaration.slice(colon + 1).trim();
      if (!CSS.supports(property, value)) throw new Error(`Invalid CSS: ${property}: ${value}`);
      if (!STYLES.has(property)) throw new Error(`Unsupported CSS property: ${property}`);
      if (/gradient\s*\(/i.test(value))
        throw new Error("Gradients are not supported by editable canvas layers yet.");
      if (property === "position" && !["relative", "absolute", "static"].includes(value))
        throw new Error("Use static, relative or absolute positioning.");
      if (
        (property === "background" || property === "background-color" || property === "color") &&
        !CSS.supports("color", value)
      )
        throw new Error("Only solid CSS colors are supported.");
      element.style.setProperty(property, value);
    }
    if (element.style.fontFamily)
      element.style.fontFamily = resolveFontFamily(element.style.fontFamily);
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType !== Node.COMMENT_NODE) element.append(copy(child, depth + 1));
    }
    if (element instanceof HTMLInputElement) {
      if (
        !["text", "search", "email", "url", "tel", "password", ""].includes(
          node.getAttribute("type") ?? "",
        )
      )
        throw new Error(
          "Only text-like inputs can be imported. Draw other controls with styled elements.",
        );
      element.readOnly = true;
    }
    return element;
  };
  const fragment = document.createDocumentFragment();
  for (const node of Array.from(template.content.childNodes)) {
    if (
      node.nodeType === Node.COMMENT_NODE ||
      (node.nodeType === Node.TEXT_NODE && !node.textContent?.trim())
    )
      continue;
    if (node.nodeType === Node.TEXT_NODE) throw new Error("Wrap top-level text in an element.");
    fragment.append(copy(node, 0));
  }
  if (!fragment.childNodes.length) throw new Error("HTML must contain at least one element.");
  return fragment;
}
