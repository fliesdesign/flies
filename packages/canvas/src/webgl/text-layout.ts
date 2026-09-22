import type { CanvasText } from "../canvas-document";
import { fontFamilyCss } from "../canvas-fonts";
import { canvasTextRunCss, canvasTextSegments } from "../canvas-rich-text";

type TextRun = {
  text: string;
  x: number;
  top: number;
  width: number;
  baseline: number;
  segment: number;
};
type Layout = { runs: TextRun[]; cost: number };
type Cache = { layouts: Map<string, Layout>; characters: number; hits: number; misses: number };
const caches = new WeakMap<Document, Cache>();
const MAX_LAYOUTS = 512;
const MAX_CHARACTERS = 2_000_000;

function cacheFor(doc: Document) {
  let cache = caches.get(doc);

  if (!cache) {
    cache = { layouts: new Map(), characters: 0, hits: 0, misses: 0 };
    caches.set(doc, cache);
    const current = cache;
    doc.fonts?.addEventListener("loadingdone", () => {
      current.layouts.clear();
      current.characters = 0;
    });
  }

  return cache;
}

export function textLayoutStats() {
  const cache = cacheFor(document);

  return {
    entries: cache.layouts.size,
    retainedCharacters: cache.characters,
    hits: cache.hits,
    misses: cache.misses,
  };
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

/** Browser shaping is cached independently of paint color, texture density and document position. */
export function layoutCanvasText(frame: CanvasText) {
  const segments = canvasTextSegments(frame);
  const cache = cacheFor(document);

  const key = JSON.stringify([
    frame.text,
    frame.width,
    frame.fontFamily,
    frame.fontSize,
    frame.fontWeight,
    frame.fontStyle,
    frame.lineHeight,
    frame.letterSpacing,
    frame.textAlign,
    segments.map(({ start, end, style }) => [
      start,
      end,
      style.fontFamily,
      style.fontSize,
      style.fontWeight,
      style.fontStyle,
    ]),
  ]);

  const cached = cache.layouts.get(key);

  if (cached) {
    cache.layouts.delete(key);
    cache.layouts.set(key, cached);
    cache.hits++;

    return { segments, runs: cached.runs };
  }

  cache.misses++;
  const measurement = document.createElement("div");
  typography(measurement, frame);

  const nodes = segments.map((segment) => {
    const span = document.createElement("span");
    Object.assign(span.style, canvasTextRunCss(segment.style));
    const text = document.createTextNode(segment.text);
    span.append(text);
    measurement.append(span);

    return text;
  });

  const calibrations = segments.map((segment) => {
    const container = document.createElement("div");
    typography(container, { ...frame, ...segment.style });
    container.style.width = "100000px";
    container.style.textAlign = "left";
    const text = document.createTextNode("M");
    const marker = document.createElement("span");
    marker.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline";
    container.append(text, marker);

    return { container, text, marker };
  });

  document.body.append(measurement, ...calibrations.map(({ container }) => container));

  try {
    const range = document.createRange();
    const origin = measurement.getBoundingClientRect();
    const runs: TextRun[] = [];

    for (const [segment, text] of nodes.entries()) {
      const calibration = calibrations[segment];
      range.selectNodeContents(calibration.text);

      const baseline =
        calibration.marker.getBoundingClientRect().top - range.getBoundingClientRect().top;

      let start = 0;
      let currentTop = Number.NaN;
      let offset = 0;

      const append = (end: number) => {
        if (end <= start) return;
        range.setStart(text, start);
        range.setEnd(text, end);
        const rect = range.getBoundingClientRect();
        runs.push({
          text: text.data.slice(start, end),
          x: rect.left - origin.left,
          top: rect.top - origin.top,
          width: rect.width,
          baseline,
          segment,
        });
      };

      for (const character of text.data) {
        const next = offset + character.length;
        range.setStart(text, offset);
        range.setEnd(text, next);
        const top = range.getBoundingClientRect().top - origin.top;

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
    }

    const cost = key.length + frame.text.length;

    if (cost <= MAX_CHARACTERS) {
      cache.layouts.set(key, { runs, cost });
      cache.characters += cost;

      while (cache.layouts.size > MAX_LAYOUTS || cache.characters > MAX_CHARACTERS) {
        const oldest = cache.layouts.keys().next().value!;
        cache.characters -= cache.layouts.get(oldest)!.cost;
        cache.layouts.delete(oldest);
      }
    }

    return { segments, runs };
  } finally {
    measurement.remove();
    for (const { container } of calibrations) container.remove();
  }
}
