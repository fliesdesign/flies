/* oxlint-disable unicorn/no-array-sort -- Sort only a newly allocated local boundary array; target ES2020. */
import { fontFamilyCss, isFontFamily } from "./canvas-fonts";

/** UTF-16 offsets match DOM selections and JavaScript strings. Runs are sparse overrides. */
export type CanvasTextRunStyle = Readonly<{
  color?: string;
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: number;
  fontStyle?: "normal" | "italic";
  textDecoration?: "none" | "underline" | "line-through";
  href?: string;
}>;
export type CanvasTextRun = CanvasTextRunStyle & Readonly<{ start: number; end: number }>;
export type CanvasTextContent = Readonly<{
  text: string;
  textRuns?: readonly CanvasTextRun[];
}>;

const styleKeys = [
  "color",
  "fontSize",
  "fontFamily",
  "fontWeight",
  "fontStyle",
  "textDecoration",
  "href",
] as const;

export function isCanvasTextLink(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    Array.from(value).some((character) => character.charCodeAt(0) <= 32)
  )
    return false;

  try {
    const url = new URL(value);

    return ["http:", "https:", "mailto:"].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function isCanvasTextRuns(value: unknown, text: string): value is readonly CanvasTextRun[] {
  if (!Array.isArray(value) || value.length > 10000) return false;
  let end = 0;

  return value.every((run) => {
    if (!run || typeof run !== "object" || Array.isArray(run)) return false;
    if (
      Object.keys(run).some(
        (key) =>
          key !== "start" &&
          key !== "end" &&
          !styleKeys.includes(key as (typeof styleKeys)[number]),
      )
    )
      return false;
    if (
      !Number.isInteger(run.start) ||
      !Number.isInteger(run.end) ||
      run.start < end ||
      run.end <= run.start ||
      run.end > text.length
    )
      return false;
    end = run.end;

    return (
      (run.color === undefined ||
        (typeof run.color === "string" &&
          /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(run.color))) &&
      (run.fontSize === undefined ||
        (Number.isFinite(run.fontSize) && run.fontSize >= 1 && run.fontSize <= 1000)) &&
      (run.fontFamily === undefined || isFontFamily(run.fontFamily)) &&
      (run.fontWeight === undefined ||
        (Number.isInteger(run.fontWeight) && run.fontWeight >= 1 && run.fontWeight <= 1000)) &&
      (run.fontStyle === undefined || ["normal", "italic"].includes(run.fontStyle)) &&
      (run.textDecoration === undefined ||
        ["none", "underline", "line-through"].includes(run.textDecoration)) &&
      (run.href === undefined || isCanvasTextLink(run.href))
    );
  });
}

export function canvasTextRunStyle(run: CanvasTextRunStyle): CanvasTextRunStyle {
  return Object.fromEntries(
    styleKeys.flatMap((key) => (run[key] === undefined ? [] : [[key, run[key]]])),
  ) as CanvasTextRunStyle;
}

function sameStyle(a: CanvasTextRunStyle, b: CanvasTextRunStyle) {
  return styleKeys.every((key) => a[key] === b[key]);
}

export function normalizeCanvasTextRuns(
  text: string,
  runs: readonly CanvasTextRun[],
): readonly CanvasTextRun[] {
  if (!isCanvasTextRuns(runs, text)) throw new Error("Invalid text runs.");
  const result: CanvasTextRun[] = [];

  for (const run of runs) {
    const style = canvasTextRunStyle(run);
    if (!Object.keys(style).length) continue;
    const previous = result[result.length - 1];
    if (previous && previous.end === run.start && sameStyle(previous, style)) {
      result[result.length - 1] = { ...previous, end: run.end };
    } else result.push({ start: run.start, end: run.end, ...style });
  }

  return Object.freeze(result.map((run) => Object.freeze(run)));
}

export function canvasTextSegments(content: CanvasTextContent) {
  const result: { start: number; end: number; text: string; style: CanvasTextRunStyle }[] = [];
  let cursor = 0;

  for (const run of content.textRuns ?? []) {
    if (run.start > cursor)
      result.push({
        start: cursor,
        end: run.start,
        text: content.text.slice(cursor, run.start),
        style: {},
      });
    result.push({
      start: run.start,
      end: run.end,
      text: content.text.slice(run.start, run.end),
      style: canvasTextRunStyle(run),
    });
    cursor = run.end;
  }

  if (cursor < content.text.length)
    result.push({
      start: cursor,
      end: content.text.length,
      text: content.text.slice(cursor),
      style: {},
    });

  return result;
}

/** Replace selected style keys without removing unrelated formatting. Null clears an override. */
export function formatCanvasTextRange(
  content: CanvasTextContent,
  start: number,
  end: number,
  patch: { [K in keyof CanvasTextRunStyle]?: CanvasTextRunStyle[K] | null },
): readonly CanvasTextRun[] {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end > content.text.length ||
    start > end
  )
    throw new Error("Invalid text selection.");
  if (start === end) return content.textRuns ?? [];
  const runs: CanvasTextRun[] = [];

  for (const segment of canvasTextSegments(content)) {
    const cuts = [
      ...new Set([
        segment.start,
        segment.end,
        Math.max(segment.start, Math.min(segment.end, start)),
        Math.max(segment.start, Math.min(segment.end, end)),
      ]),
    ].sort((a, b) => a - b);

    for (let i = 0; i < cuts.length - 1; i++) {
      const from = cuts[i],
        to = cuts[i + 1];

      const style = { ...segment.style };

      if (from >= start && to <= end) {
        for (const key of styleKeys) {
          if (!(key in patch)) continue;
          if (patch[key] === null || patch[key] === undefined) delete style[key];
          else Object.assign(style, { [key]: patch[key] });
        }
      }

      if (to > from) runs.push({ start: from, end: to, ...style });
    }
  }

  return normalizeCanvasTextRuns(content.text, runs);
}

/** Preserve styles through a single editing operation, including paste, deletion and IME replacement. */
export function editCanvasTextRuns(
  content: CanvasTextContent,
  text: string,
): readonly CanvasTextRun[] {
  if (text === content.text) return content.textRuns ?? [];
  let start = 0;
  while (start < text.length && start < content.text.length && text[start] === content.text[start])
    start++;

  let oldEnd = content.text.length,
    newEnd = text.length;

  while (oldEnd > start && newEnd > start && content.text[oldEnd - 1] === text[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }

  const delta = newEnd - oldEnd;
  const runs: CanvasTextRun[] = [];

  const insertionStyle =
    (content.textRuns ?? []).find((run) => run.start <= start && run.end > start) ??
    (content.textRuns ?? []).find((run) => run.start < start && run.end === start);

  for (const run of content.textRuns ?? []) {
    if (run.start < start) runs.push({ ...run, end: Math.min(run.end, start) });
  }

  if (newEnd > start && insertionStyle)
    runs.push({ start, end: newEnd, ...canvasTextRunStyle(insertionStyle) });

  for (const run of content.textRuns ?? []) {
    if (run.end > oldEnd)
      runs.push({ ...run, start: Math.max(run.start, oldEnd) + delta, end: run.end + delta });
  }

  return normalizeCanvasTextRuns(text, runs);
}

export function canvasTextRunCss(style: CanvasTextRunStyle): Record<string, string> {
  return {
    ...(style.color && { color: style.color }),
    ...(style.fontSize !== undefined && { fontSize: `${style.fontSize}px` }),
    ...(style.fontFamily && { fontFamily: fontFamilyCss(style.fontFamily) }),
    ...(style.fontWeight !== undefined && { fontWeight: String(style.fontWeight) }),
    ...(style.fontStyle && { fontStyle: style.fontStyle }),
    ...(style.textDecoration && { textDecoration: style.textDecoration }),
  };
}

/** DOM construction is shared by measurement and rich editing; imported markup is never executed. */
export function appendCanvasText(
  parent: HTMLElement,
  content: CanvasTextContent,
  trailingLine = false,
) {
  const doc = parent.ownerDocument;

  for (const segment of canvasTextSegments(content)) {
    const span = doc.createElement("span");
    Object.assign(span.style, canvasTextRunCss(segment.style));
    span.textContent = segment.text;
    parent.append(span);
  }

  if (trailingLine) parent.append(doc.createTextNode("\u200b"));
}

/** Scale explicit run sizes with a group; inherited sizes follow the node's base font size. */
export function scaleCanvasTextRuns(
  runs: readonly CanvasTextRun[] | undefined,
  factor: number,
): readonly CanvasTextRun[] | undefined {
  if (!runs || factor === 1) return runs;

  return runs.map((run) =>
    run.fontSize === undefined
      ? run
      : { ...run, fontSize: Math.max(1, Math.min(1000, run.fontSize * factor)) },
  );
}
