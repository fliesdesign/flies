import {
  CANVAS_BLEND_MODES,
  CANVAS_FILTERS,
  gradientLine,
  type CanvasBlendMode,
  type CanvasFilters,
  type CanvasFilterName,
  type CanvasGradient,
} from "@flies/canvas";

import { htmlColor } from "./html-style";

/** Split CSS lists without breaking color functions, calc(), or nested color-mix(). */
function parts(value: string, separator: "comma" | "space") {
  const result: string[] = [];

  let depth = 0,
    start = 0;

  for (let i = 0; i < value.length; i++) {
    if (value[i] === "(") depth++;
    if (value[i] === ")") depth--;

    if (depth === 0 && (separator === "comma" ? value[i] === "," : /\s/.test(value[i]))) {
      if (value.slice(start, i).trim()) result.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }

  if (value.slice(start).trim()) result.push(value.slice(start).trim());

  return result;
}

function angle(value: string): number {
  const match = value.match(/^([+-]?(?:\d*\.)?\d+)(deg|rad|grad|turn)$/);
  if (!match) throw new Error(`Unsupported angle: ${value}. Use a 2D rotation.`);

  return Number(match[1]) * { deg: 1, rad: 180 / Math.PI, grad: 0.9, turn: 360 }[match[2]]!;
}

function length(value: string, size: number): number {
  const match = value.match(/^([+-]?(?:\d*\.)?\d+)(px|%)?$/);
  if (!match || (!match[2] && Number(match[1]) !== 0))
    throw new Error(`Unsupported length: ${value}. Use pixels or percentages.`);

  return Number(match[1]) * (match[2] === "%" ? size / 100 : 1);
}

export type HtmlTransform = {
  transform: string;
  rotate: string;
  translate: string;
  scale: string;
  origin: string;
};

export function captureTransform(style: CSSStyleDeclaration): HtmlTransform {
  return {
    transform: style.transform,
    rotate: style.rotate,
    translate: style.translate,
    scale: style.scale,
    origin: style.transformOrigin,
  };
}

export function nativeTransform(saved: HtmlTransform, width: number, height: number) {
  const matrix = new DOMMatrix(saved.transform === "none" ? undefined : saved.transform);
  const rotation = saved.rotate === "none" ? 0 : angle(saved.rotate.replace(/^z\s+|^0 0 1\s+/, ""));
  const t = saved.translate === "none" ? [] : parts(saved.translate, "space");
  const scale = saved.scale === "none" ? [1] : parts(saved.scale, "space").map(Number);
  if (
    !matrix.is2D ||
    scale.some((n) => n !== 1) ||
    t.length > 2 ||
    Math.abs(matrix.a ** 2 + matrix.b ** 2 - 1) > 0.00001 ||
    Math.abs(matrix.c + matrix.b) > 0.00001 ||
    Math.abs(matrix.d - matrix.a) > 0.00001
  )
    throw new Error(
      "Editable transforms support 2D rotation and translation. Scale, skew, reflections and 3D transforms are not supported.",
    );

  const combined = new DOMMatrix()
    .translate(t[0] ? length(t[0], width) : 0, t[1] ? length(t[1], height) : 0)
    .rotate(rotation)
    .multiply(matrix);

  const origins = parts(saved.origin, "space");
  if (origins.length > 2 && parseFloat(origins[2]) !== 0)
    throw new Error("Use a 2D transform origin.");

  const ox = length(origins[0], width) - width / 2,
    oy = length(origins[1], height) - height / 2;

  return {
    rotation: (Math.atan2(combined.b, combined.a) * 180) / Math.PI,
    dx: combined.e + ox - combined.a * ox - combined.c * oy,
    dy: combined.f + oy - combined.b * ox - combined.d * oy,
  };
}

export function nativeFilters(value: string): CanvasFilters | undefined {
  if (value === "none") return undefined;

  const filters: Partial<Record<CanvasFilterName, number>> = {},
    order: CanvasFilterName[] = [];

  for (const item of parts(value, "space")) {
    const match = item.match(/^([a-z-]+)\(([^()]*)\)$/);
    const key = (match?.[1] === "hue-rotate" ? "hue" : match?.[1]) as CanvasFilterName;
    if (!match || !Object.prototype.hasOwnProperty.call(CANVAS_FILTERS, key))
      throw new Error(
        `Unsupported filter: ${item}. Use blur, brightness, contrast, saturate, grayscale, sepia, invert or hue-rotate.`,
      );
    if (order.includes(key))
      throw new Error(
        `Repeated ${key} filters cannot be represented by one editable filter. Combine them first.`,
      );
    const raw = match[2].trim();
    let number: number;

    if (key === "blur") number = length(raw, 0);
    else if (key === "hue") number = ((((angle(raw) + 180) % 360) + 360) % 360) - 180;
    else {
      if (!/^(?:\d*\.)?\d+%?$/.test(raw)) throw new Error(`Unsupported ${key} value: ${raw}`);
      number = parseFloat(raw) / (raw.endsWith("%") ? 100 : 1);
    }

    const config = CANVAS_FILTERS[key];
    if (key === "grayscale" || key === "sepia" || key === "invert") number = Math.min(number, 1);
    if (!Number.isFinite(number) || number < config.min || number > config.max)
      throw new Error(`${config.label} must be between ${config.min} and ${config.max}.`);
    filters[key] = number;
    order.push(key);
  }

  return { ...filters, order };
}

export function nativeBlend(value: string): CanvasBlendMode | undefined {
  if (!CANVAS_BLEND_MODES.includes(value as CanvasBlendMode))
    throw new Error(`Unsupported blend mode: ${value}`);

  return value === "normal" ? undefined : (value as CanvasBlendMode);
}

export function nativeGradient(
  style: CSSStyleDeclaration,
  width: number,
  height: number,
): CanvasGradient | undefined {
  const value = style.backgroundImage;
  if (value === "none") return undefined;
  const match = value.match(/^(linear|radial)-gradient\((.*)\)$/);
  if (!match || parts(value, "comma").length !== 1)
    throw new Error(
      "Use one linear or centered elliptical radial gradient. Repeating, conic and multiple backgrounds are not supported.",
    );
  if (
    style.backgroundSize !== "auto" ||
    !["0% 0%", "0px 0px"].includes(style.backgroundPosition) ||
    style.backgroundClip !== "border-box" ||
    style.backgroundBlendMode !== "normal"
  )
    throw new Error(
      "Gradient backgrounds must fill the layer: use auto background size, default position, border-box clipping and normal background blending.",
    );
  if (
    style.backgroundOrigin !== "border-box" &&
    [
      style.borderTopWidth,
      style.borderRightWidth,
      style.borderBottomWidth,
      style.borderLeftWidth,
    ].some((v) => parseFloat(v) > 0)
  )
    throw new Error("For a gradient with borders, set background-origin: border-box.");

  const type = match[1] as "linear" | "radial",
    entries = parts(match[2], "comma");

  let heading = "",
    degrees = 180;

  if (!CSS.supports("color", parts(entries[0], "space")[0])) heading = entries.shift()!;

  // Browsers may omit the default interpolation space during serialization.
  // Modern color syntax defaults to Oklab; legacy RGB gradients retain sRGB.
  const interpolation =
    heading.match(/\bin\s+(\S+)/)?.[1] ??
    (entries.some((entry) => /(?:oklab|oklch|lab|lch|color)\(/.test(entry)) ? "oklab" : "srgb");

  if (!["srgb", "oklab"].includes(interpolation))
    throw new Error("Editable gradients support sRGB or Oklab interpolation.");
  heading = heading.replace(/\bin\s+(srgb|oklab)\b/, "").trim();

  if (type === "linear" && heading) {
    if (heading.startsWith("to ")) {
      const sides = heading.slice(3).split(/\s+/);
      if (sides.some((side) => !["top", "bottom", "left", "right"].includes(side)))
        throw new Error("Unsupported gradient direction.");
      const x = sides.includes("right") ? 1 : sides.includes("left") ? -1 : 0;
      const y = sides.includes("bottom") ? 1 : sides.includes("top") ? -1 : 0;
      degrees = (Math.atan2(x * (y ? height : 1), -y * (x ? width : 1)) * 180) / Math.PI;
    } else degrees = angle(heading);
  }

  if (type === "radial") {
    const [shape = "", center = "center"] = heading.split(/\s*\bat\b\s*/);
    if (
      !/^(?:(?:ellipse|farthest-corner)\s*)*$/.test(shape.trim()) ||
      !["center", "50% 50%", "center center"].includes(center.trim())
    )
      throw new Error(
        "Use a centered ellipse with farthest-corner sizing for an editable radial gradient.",
      );
  }

  const line = gradientLine(width, height, degrees),
    extent =
      type === "linear"
        ? Math.hypot(line.end.x - line.start.x, line.end.y - line.start.y)
        : width / Math.SQRT2;

  const stops: { offset?: number; color: string }[] = [];

  for (const entry of entries) {
    const tokens = parts(entry, "space"),
      color = tokens.shift()!;

    if (!CSS.supports("color", color) || tokens.length > 2)
      throw new Error("Use gradient color stops without interpolation hints.");
    if (!tokens.length) stops.push({ color: htmlColor(color) });
    else
      for (const position of tokens)
        stops.push({ color: htmlColor(color), offset: length(position, extent) / extent });
  }

  if (stops.length < 2 || stops.length > 16) throw new Error("Gradients need 2–16 color stops.");
  stops[0].offset ??= 0;
  stops[stops.length - 1].offset ??= 1;
  let previous = stops[0].offset;

  for (const stop of stops)
    if (stop.offset !== undefined) {
      stop.offset = Math.max(previous, stop.offset);
      previous = stop.offset;
    }

  for (let i = 0; i < stops.length; i++) {
    if (stops[i].offset !== undefined) continue;
    let end = i + 1;
    while (stops[end].offset === undefined) end++;

    const from = stops[i - 1].offset!,
      to = stops[end].offset!;

    for (let j = i; j < end; j++)
      stops[j].offset = from + ((to - from) * (j - i + 1)) / (end - i + 1);
    i = end;
  }

  if (stops.some((s) => s.offset! < 0 || s.offset! > 1))
    throw new Error("Keep editable gradient stops between 0% and 100%.");
  const background = htmlColor(style.backgroundColor);

  return {
    type,
    angle: degrees,
    interpolation: interpolation as "srgb" | "oklab",
    stops: stops as CanvasGradient["stops"],
    ...(background.endsWith("00") ? {} : { background }),
  };
}
