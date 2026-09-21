import type { CanvasFrame, CanvasShadow, CanvasText } from "../canvas-document";
import { ensureCanvasFont, fontFamilyCss } from "../canvas-fonts";
import { gradientLine, type CanvasGradient } from "../canvas-paint";

export type NodeRaster = {
  body: HTMLCanvasElement;
  decoration?: HTMLCanvasElement;
  /** Local bounds, in document pixels, shared by both layers. */
  x: number;
  y: number;
  width: number;
  height: number;
};

const MAX_RASTER_EDGE = 4096;
const MAX_RASTER_PIXELS = 4_194_304;

const rootShadow: CanvasShadow = {
  offsetX: 0,
  offsetY: 2,
  blur: 8,
  spread: 0,
  color: "#0000001a",
};

function shadows(frame: CanvasFrame, root: boolean): readonly CanvasShadow[] {
  return (
    frame.shadows ??
    (root && (frame.kind === undefined || frame.kind === "frame") ? [rootShadow] : [])
  );
}

/** Include pen overflow and the visible tails of box shadows, without allocating from world size. */
export function nodeRasterBounds(frame: CanvasFrame, root: boolean) {
  let left = 0;
  let top = 0;
  let right = frame.width;
  let bottom = frame.height;

  if (frame.kind === "pen") {
    const sx = frame.width / frame.pathWidth;
    const sy = frame.height / frame.pathHeight;

    for (const point of frame.points) {
      left = Math.min(left, (point.x - frame.strokeWidth / 2) * sx);
      top = Math.min(top, (point.y - frame.strokeWidth / 2) * sy);
      right = Math.max(right, (point.x + frame.strokeWidth / 2) * sx);
      bottom = Math.max(bottom, (point.y + frame.strokeWidth / 2) * sy);
    }
  }

  for (const shadow of shadows(frame, root)) {
    if (shadow.inset) continue;
    // CSS blur has sigma = radius / 2. Four sigma captures its visible tail.
    const extent = Math.max(0, shadow.spread) + shadow.blur * 2;
    left = Math.min(left, shadow.offsetX - extent);
    top = Math.min(top, shadow.offsetY - extent);
    right = Math.max(right, frame.width + shadow.offsetX + extent);
    bottom = Math.max(bottom, frame.height + shadow.offsetY + extent);
  }

  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function rasterResolution(width: number, height: number, requested: number) {
  const desired = Number.isFinite(requested) && requested > 0 ? requested : 1;

  const scale = Math.min(
    desired,
    MAX_RASTER_EDGE / Math.max(1, width),
    MAX_RASTER_EDGE / Math.max(1, height),
    Math.sqrt(MAX_RASTER_PIXELS / Math.max(1, width * height)),
  );

  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}

function roundedRect(
  path: Path2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  if (width <= 0 || height <= 0) return;
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  path.roundRect(x, y, width, height, r);
}

function shape(frame: CanvasFrame, inset = 0, x = 0, y = 0) {
  const path = new Path2D();
  roundedRect(
    path,
    x + inset,
    y + inset,
    frame.width - 2 * inset,
    frame.height - 2 * inset,
    Math.max(0, (frame.cornerRadius ?? 0) - inset),
  );

  return path;
}

function makeLayer(
  bounds: ReturnType<typeof nodeRasterBounds>,
  resolution: { width: number; height: number },
) {
  const canvas = document.createElement("canvas");
  canvas.width = resolution.width;
  canvas.height = resolution.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("The canvas rasterizer could not create a 2D context.");
  ctx.setTransform(
    resolution.width / bounds.width,
    0,
    0,
    resolution.height / bounds.height,
    (-bounds.x * resolution.width) / bounds.width,
    (-bounds.y * resolution.height) / bounds.height,
  );

  return { canvas, ctx };
}

type Color = readonly [number, number, number, number];

function color(value: string): Color {
  let hex = value.slice(1);
  if (hex.length <= 4) hex = [...hex].map((digit) => digit + digit).join("");

  return [
    parseInt(hex.slice(0, 2), 16) / 255,
    parseInt(hex.slice(2, 4), 16) / 255,
    parseInt(hex.slice(4, 6), 16) / 255,
    hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
  ];
}

const linear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

const channel = (v: number) =>
  Math.max(0, Math.min(1, v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055)) * 255;

function oklab(value: Color): Color {
  const r = linear(value[0]);
  const g = linear(value[1]);
  const b = linear(value[2]);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    value[3],
  ];
}

function fromOklab(value: Color): string {
  const l = (value[0] + 0.3963377774 * value[1] + 0.2158037573 * value[2]) ** 3;
  const m = (value[0] - 0.1055613458 * value[1] - 0.0638541728 * value[2]) ** 3;
  const s = (value[0] - 0.0894841775 * value[1] - 1.291485548 * value[2]) ** 3;

  return `rgba(${channel(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)},${channel(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)},${channel(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)},${value[3]})`;
}

/** Canvas gradients use straight sRGB alpha; CSS uses premultiplied alpha in its selected space. */
export function rasterGradientStops(gradient: CanvasGradient) {
  const perceptual = gradient.interpolation === "oklab";
  if (!perceptual && gradient.stops.every((stop) => color(stop.color)[3] === 1))
    return gradient.stops;
  const stops: { offset: number; color: string }[] = [];
  gradient.stops.forEach((stop, index) => {
    stops.push(stop);
    const next = gradient.stops[index + 1];
    if (!next || next.offset <= stop.offset) return;
    const a = perceptual ? oklab(color(stop.color)) : color(stop.color);
    const b = perceptual ? oklab(color(next.color)) : color(next.color);

    for (let step = 1; step < 32; step++) {
      const t = step / 32;
      const alpha = a[3] * (1 - t) + b[3] * t;

      const mix = (component: number) =>
        alpha === 0 ? 0 : (a[component] * a[3] * (1 - t) + b[component] * b[3] * t) / alpha;

      stops.push({
        offset: stop.offset + (next.offset - stop.offset) * t,
        color: perceptual
          ? fromOklab([mix(0), mix(1), mix(2), alpha])
          : `rgba(${mix(0) * 255},${mix(1) * 255},${mix(2) * 255},${alpha})`,
      });
    }
  });

  return stops;
}

function paintFill(ctx: CanvasRenderingContext2D, frame: CanvasFrame) {
  if (frame.kind !== undefined && frame.kind !== "frame" && frame.kind !== "rectangle") return;
  const outline = shape(frame);

  if (!frame.gradient) {
    ctx.fillStyle = frame.fill ?? "#ffffff";
    ctx.fill(outline);

    return;
  }

  const gradient = frame.gradient;

  if (gradient.background) {
    ctx.fillStyle = gradient.background;
    ctx.fill(outline);
  }

  ctx.save();
  ctx.clip(outline);
  let paint: globalThis.CanvasGradient;

  if (gradient.type === "linear") {
    const { start, end } = gradientLine(frame.width, frame.height, gradient.angle);
    paint = ctx.createLinearGradient(start.x, start.y, end.x, end.y);
  } else {
    // CSS ellipse farthest-corner: the ellipse passes through all four box corners.
    ctx.translate(frame.width / 2, frame.height / 2);
    ctx.scale(frame.width / Math.SQRT2, frame.height / Math.SQRT2);
    paint = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  }

  for (const stop of rasterGradientStops(gradient)) paint.addColorStop(stop.offset, stop.color);
  ctx.fillStyle = paint;
  if (gradient.type === "radial") ctx.fillRect(-1, -1, 2, 2);
  else ctx.fillRect(0, 0, frame.width, frame.height);
  ctx.restore();
}

/** Draw only the shadow by positioning its source outside the raster's visible bounds. */
function paintShadow(
  ctx: CanvasRenderingContext2D,
  frame: CanvasFrame,
  shadow: CanvasShadow,
  bounds: ReturnType<typeof nodeRasterBounds>,
) {
  const inset = shadow.inset
    ? Math.min(frame.borderWidth ?? 0, frame.width / 2, frame.height / 2)
    : 0;

  const pad = Math.max(frame.width, frame.height, shadow.blur * 4, Math.abs(shadow.spread)) + 1;
  const path = shadow.inset ? new Path2D() : shape(frame, -shadow.spread);

  if (shadow.inset) {
    path.rect(-pad, -pad, frame.width + pad * 2, frame.height + pad * 2);
    roundedRect(
      path,
      inset + shadow.spread,
      inset + shadow.spread,
      frame.width - 2 * (inset + shadow.spread),
      frame.height - 2 * (inset + shadow.spread),
      Math.max(0, (frame.cornerRadius ?? 0) - inset - shadow.spread),
    );
  }

  const clip = shape(frame, inset);

  if (!shadow.inset) {
    clip.rect(bounds.x - pad, bounds.y - pad, bounds.width + pad * 2, bounds.height + pad * 2);
  }

  ctx.save();
  ctx.clip(clip, shadow.inset ? "nonzero" : "evenodd");
  const transform = ctx.getTransform();
  const shift = bounds.width + Math.abs(bounds.x) + frame.width + pad * 4;
  ctx.translate(-shift, 0);
  ctx.shadowColor = shadow.color;
  ctx.shadowBlur = shadow.blur * Math.max(transform.a, transform.d);
  ctx.shadowOffsetX = (shift + shadow.offsetX) * transform.a;
  ctx.shadowOffsetY = shadow.offsetY * transform.d;
  ctx.fillStyle = "#000000";
  ctx.fill(path, "evenodd");
  ctx.restore();
}

const images = new Map<string, { pending: Promise<HTMLImageElement>; pixels: number }>();

function pruneImages() {
  let pixels = 0;
  for (const cached of images.values()) pixels += cached.pixels;

  while (images.size > 64 || pixels > 16_777_216) {
    const source = images.keys().next().value!;
    pixels -= images.get(source)!.pixels;
    images.delete(source);
  }
}

function loadImage(source: string): Promise<HTMLImageElement> {
  if (!source.startsWith("data:image/"))
    throw new Error("Canvas images must use embedded image data.");
  const cached = images.get(source);

  if (cached) {
    images.delete(source);
    images.set(source, cached);

    return cached.pending;
  }

  const pending = new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image), { once: true });
    image.addEventListener(
      "error",
      () => reject(new Error("The embedded image could not be decoded.")),
      { once: true },
    );
    image.src = source;
  });

  const entry = { pending, pixels: 0 };
  images.set(source, entry);
  // Bound decoded image retention independently from the WebGL texture cache.
  pruneImages();
  void pending.then(
    (image) => {
      entry.pixels = image.naturalWidth * image.naturalHeight;
      pruneImages();

      return image;
    },
    () => {
      if (images.get(source) === entry) images.delete(source);
    },
  );

  return pending;
}

function typography(element: HTMLElement, frame: CanvasText) {
  Object.assign(element.style, {
    all: "initial",
    display: "block",
    position: "fixed",
    left: "0",
    top: "0",
    width: `${frame.width}px`,
    margin: "0",
    padding: "0",
    border: "0",
    visibility: "hidden",
    contain: "layout style",
    fontFamily: fontFamilyCss(frame.fontFamily),
    fontSize: `${frame.fontSize}px`,
    fontWeight: String(frame.fontWeight ?? 400),
    fontStyle: frame.fontStyle ?? "normal",
    lineHeight: String(frame.lineHeight ?? 1.25),
    letterSpacing: `${frame.letterSpacing ?? 0}px`,
    textAlign: frame.textAlign ?? "left",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    tabSize: "4",
    direction: "ltr",
  });
}

type TextRun = { text: string; x: number; top: number; width: number };

/** Ask the same browser line breaker used by the editor; paint glyphs directly, never a DOM screenshot. */
function textRuns(frame: CanvasText): { runs: TextRun[]; baseline: number } {
  const measurement = document.createElement("div");
  typography(measurement, frame);
  const text = document.createTextNode(frame.text);
  measurement.append(text);
  const calibration = document.createElement("div");
  typography(calibration, frame);
  calibration.style.width = "100000px";
  calibration.style.textAlign = "left";
  const calibrationText = document.createTextNode("M");
  const marker = document.createElement("span");
  marker.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline";
  calibration.append(calibrationText, marker);
  document.body.append(measurement, calibration);

  try {
    const range = document.createRange();
    range.selectNodeContents(calibrationText);
    const baseline = marker.getBoundingClientRect().top - range.getBoundingClientRect().top;
    const origin = measurement.getBoundingClientRect();
    const runs: TextRun[] = [];
    let start = 0;
    let currentTop = Number.NaN;
    let offset = 0;

    const append = (end: number) => {
      if (end <= start) return;
      range.setStart(text, start);
      range.setEnd(text, end);
      const rect = range.getBoundingClientRect();
      runs.push({
        text: frame.text.slice(start, end),
        x: rect.left - origin.left,
        top: rect.top - origin.top,
        width: rect.width,
      });
    };

    for (const character of frame.text) {
      const next = offset + character.length;
      range.setStart(text, offset);
      range.setEnd(text, next);
      const rect = range.getBoundingClientRect();
      const top = rect.top - origin.top;
      if (character === "\n" || character === "\r" || character === "\t") {
        append(offset);
        start = next;
        currentTop = Number.NaN;
      } else if (Number.isFinite(currentTop) && Math.abs(top - currentTop) > 0.5) {
        append(offset);
        start = offset;
        currentTop = top;
      } else currentTop = top;
      offset = next;
    }

    append(offset);

    return { runs, baseline };
  } finally {
    measurement.remove();
    calibration.remove();
  }
}

async function paintText(ctx: CanvasRenderingContext2D, frame: CanvasText) {
  await ensureCanvasFont(frame);
  const { runs, baseline } = textRuns(frame);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, frame.width, frame.height);
  ctx.clip();
  ctx.font = `${frame.fontStyle ?? "normal"} ${frame.fontWeight ?? 400} ${frame.fontSize}px ${fontFamilyCss(frame.fontFamily)}`;
  ctx.fontKerning = "normal";
  ctx.letterSpacing = `${frame.letterSpacing ?? 0}px`;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.direction = "ltr";
  ctx.fillStyle = frame.color;

  for (const run of runs) {
    if (run.top > frame.height || run.top + frame.fontSize * 2 < 0) continue;
    ctx.fillText(run.text, run.x, run.top + baseline);

    if (frame.textDecoration && frame.textDecoration !== "none") {
      const thickness = Math.max(1, frame.fontSize / 16);

      const y =
        run.top +
        baseline +
        (frame.textDecoration === "underline"
          ? Math.max(1, frame.fontSize / 10)
          : -frame.fontSize * 0.3);

      ctx.fillRect(run.x, y, run.width, thickness);
    }
  }

  ctx.restore();
}

export async function rasterizeNode(
  frame: CanvasFrame,
  scale: number,
  root: boolean,
): Promise<NodeRaster> {
  const bounds = nodeRasterBounds(frame, root);
  const resolution = rasterResolution(bounds.width, bounds.height, scale);
  const { canvas: body, ctx } = makeLayer(bounds, resolution);
  const effects = shadows(frame, root);

  for (let index = effects.length - 1; index >= 0; index--) {
    if (!effects[index].inset) paintShadow(ctx, frame, effects[index], bounds);
  }

  paintFill(ctx, frame);

  if (frame.kind === "text") await paintText(ctx, frame);
  else if (frame.kind === "image" || frame.kind === "svg") {
    const image = await loadImage(frame.src);
    ctx.save();
    ctx.clip(shape(frame));
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, 0, 0, frame.width, frame.height);
    ctx.restore();
  } else if (frame.kind === "pen" && frame.points.length) {
    ctx.save();
    ctx.scale(frame.width / frame.pathWidth, frame.height / frame.pathHeight);
    ctx.lineWidth = frame.strokeWidth;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = frame.stroke;
    ctx.fillStyle = frame.stroke;
    ctx.beginPath();
    const first = frame.points[0];

    if (frame.points.length === 1) {
      ctx.arc(first.x, first.y, frame.strokeWidth / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.moveTo(first.x, first.y);
      for (let i = 1; i < frame.points.length; i++)
        ctx.lineTo(frame.points[i].x, frame.points[i].y);
      ctx.stroke();
    }

    ctx.restore();
  }

  let decoration: HTMLCanvasElement | undefined;

  if ((frame.borderWidth ?? 0) > 0 || effects.some((effect) => effect.inset)) {
    const layer = makeLayer(bounds, resolution);
    decoration = layer.canvas;

    for (let index = effects.length - 1; index >= 0; index--) {
      if (effects[index].inset) paintShadow(layer.ctx, frame, effects[index], bounds);
    }

    if ((frame.borderWidth ?? 0) > 0) {
      const border = shape(frame);
      border.addPath(shape(frame, frame.borderWidth));
      layer.ctx.fillStyle = frame.borderColor ?? "#000000";
      layer.ctx.fill(border, "evenodd");
    }
  }

  return { ...bounds, body, decoration };
}
