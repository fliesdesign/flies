import { describe, expect, it } from "vite-plus/test";

import {
  canvasTextSegments,
  editCanvasTextRuns,
  formatCanvasTextRange,
  isCanvasTextRuns,
  normalizeCanvasTextRuns,
} from "./canvas-rich-text";

describe("rich text ranges", () => {
  it("splits a range across existing styles and preserves unrelated attributes", () => {
    const content = { text: "Hello world", textRuns: [{ start: 0, end: 5, color: "#ff0000" }] };
    const runs = formatCanvasTextRange(content, 3, 8, { fontWeight: 700 });
    expect(runs).toEqual([
      { start: 0, end: 3, color: "#ff0000" },
      { start: 3, end: 5, color: "#ff0000", fontWeight: 700 },
      { start: 5, end: 8, fontWeight: 700 },
    ]);
    expect(
      canvasTextSegments({ ...content, textRuns: runs })
        .map((run) => run.text)
        .join(""),
    ).toBe(content.text);
  });
  it("clears one attribute without losing links or other attributes", () => {
    expect(
      formatCanvasTextRange(
        {
          text: "abc",
          textRuns: [{ start: 0, end: 3, fontWeight: 700, href: "https://flies.design" }],
        },
        0,
        3,
        { fontWeight: null },
      ),
    ).toEqual([{ start: 0, end: 3, href: "https://flies.design" }]);
  });
  it("merges adjacent equal ranges and deeply freezes them", () => {
    const runs = normalizeCanvasTextRuns("abc", [
      { start: 0, end: 1, fontWeight: 700 },
      { start: 1, end: 3, fontWeight: 700 },
    ]);

    expect(runs).toEqual([{ start: 0, end: 3, fontWeight: 700 }]);
    expect(Object.isFrozen(runs[0])).toBe(true);
  });
  it("preserves formatting through insertion, deletion and replacement", () => {
    const content = {
      text: "hello world",
      textRuns: [
        { start: 0, end: 5, fontWeight: 700 },
        { start: 6, end: 11, color: "#ff0000" },
      ],
    };

    expect(editCanvasTextRuns(content, "hello brave world")).toEqual([
      { start: 0, end: 5, fontWeight: 700 },
      { start: 6, end: 17, color: "#ff0000" },
    ]);
    expect(editCanvasTextRuns(content, "world")).toEqual([{ start: 0, end: 5, color: "#ff0000" }]);
    expect(editCanvasTextRuns(content, "hi world")).toEqual([
      { start: 0, end: 2, fontWeight: 700 },
      { start: 3, end: 8, color: "#ff0000" },
    ]);
  });
  it("uses DOM-compatible UTF-16 offsets for emoji and composition", () => {
    expect(
      editCanvasTextRuns(
        { text: "a🙂b", textRuns: [{ start: 1, end: 3, fontWeight: 700 }] },
        "a🙂🙂b",
      ),
    ).toEqual([{ start: 1, end: 5, fontWeight: 700 }]);
  });
  it("rejects overlapping/out-of-bounds ranges, unknown style fields and unsafe links", () => {
    for (const runs of [
      [{ start: 0, end: 4 }],
      [
        { start: 0, end: 2 },
        { start: 1, end: 3 },
      ],
      [{ start: 0, end: 1, onclick: "bad" }],
      [{ start: 0, end: 1, href: "javascript:alert(1)" }],
      [{ start: 0, end: 1, fontSize: Infinity }],
    ])
      expect(isCanvasTextRuns(runs, "abc")).toBe(false);
  });
});
