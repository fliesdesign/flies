/// <reference types="node" />

import assert from "node:assert/strict";

import { CanvasDocument, type CanvasFrame } from "@flies/canvas";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vite-plus/test";

import { CanvasProperties } from "./canvas-properties";

const frame: CanvasFrame = {
  id: "frame",
  name: "Artboard",
  x: 100,
  y: 200,
  width: 400,
  height: 300,
};

const rectangle: CanvasFrame = {
  id: "rect",
  name: "Rectangle",
  kind: "rectangle",
  parentId: "frame",
  x: 130,
  y: 240,
  width: 80,
  height: 60,
  fill: "#abc123",
};

const text: CanvasFrame = {
  id: "text",
  name: "Heading",
  kind: "text",
  x: 20,
  y: 30,
  width: 240,
  height: 30,
  text: "Hello",
  fontSize: 24,
  color: "#ededed",
};

function render(nodes: readonly CanvasFrame[], selectedIds: readonly string[]) {
  return renderToStaticMarkup(
    <CanvasProperties
      document={new CanvasDocument(nodes)}
      selectedIds={selectedIds}
      onChange={() => {}}
      onPreviewStart={() => {}}
      onPreview={() => {}}
      onPreviewEnd={() => {}}
      onArrange={() => {}}
      onFitText={() => {}}
      onCollapse={() => {}}
    />,
  );
}

function input(markup: string, label: string) {
  return markup.match(new RegExp(`<input[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? "";
}

function button(markup: string, label: string) {
  return markup.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? "";
}

describe("canvas properties panel", () => {
  it("provides a quiet empty state with no inapplicable editing controls", () => {
    const markup = render([frame], []);
    assert.match(markup, /Select a layer to edit its properties/);
    assert.match(markup, /aria-label="Collapse properties"/);
    assert.doesNotMatch(markup, /<input|aria-label="Layout"/);
  });

  it("shows child position relative to its frame, with actual dimensions and fill", () => {
    const markup = render([frame, rectangle], [rectangle.id]);
    assert.match(input(markup, "X position"), /value="30"/);
    assert.match(input(markup, "Y position"), /value="40"/);
    assert.match(input(markup, "Width"), /value="80"/);
    assert.match(input(markup, "Height"), /value="60"/);
    assert.match(input(markup, "Fill color"), /value="ABC123"/);
    assert.doesNotMatch(markup, /Clip contents|Font family/);
  });

  it("accepts abbreviated alpha colors and exposes an accessible color popover", () => {
    const markup = render([{ ...rectangle, parentId: undefined, fill: "#abcd" }], [rectangle.id]);
    assert.match(input(markup, "Fill color"), /value="ABCD"/);
    assert.match(button(markup, "Fill color picker"), /aria-haspopup="dialog"/);
    assert.match(button(markup, "Fill color picker"), /aria-expanded="false"/);
    assert.match(markup, /aria-label="Properties panel"[^>]*tabindex="-1"/);
  });

  it("shows frame clipping, white fill and neutral appearance defaults", () => {
    const markup = render([frame], [frame.id]);
    assert.match(markup, /Clip contents/);
    assert.match(input(markup, "Fill color"), /value="FFFFFF"/);
    assert.match(input(markup, "Opacity"), /value="100"/);
    assert.match(input(markup, "Corner radius"), /value="0"/);
    assert.match(button(markup, "Align left"), /disabled/);
  });

  it("uses combined world bounds and mixed appearance values for multiple roots", () => {
    const other: CanvasFrame = {
      ...rectangle,
      id: "other",
      parentId: undefined,
      x: 300,
      y: 320,
      opacity: 0.4,
      fill: "#ffffff",
    };

    const markup = render([frame, rectangle, other], [rectangle.id, other.id]);
    assert.match(input(markup, "X position"), /value="130"/);
    assert.match(input(markup, "Width"), /value="250"/);
    assert.match(input(markup, "Opacity"), /placeholder="Mixed"/);
    assert.match(input(markup, "Fill color"), /placeholder="Mixed"/);
    assert.doesNotMatch(button(markup, "Align left"), /disabled/);
  });

  it("offers only relevant text controls with documented defaults", () => {
    const markup = render([text], [text.id]);
    assert.match(markup, /aria-label="Font family"/);
    assert.match(markup, /aria-label="Font family"[^>]*value="Arial"/);
    assert.match(input(markup, "Font size"), /value="24"/);
    assert.match(input(markup, "Line height"), /value="1.25"/);
    assert.match(input(markup, "Letter spacing"), /value="0"/);
    assert.match(button(markup, "Align text left"), /aria-pressed="true"/);
    assert.match(markup, /Fit text height/);
    assert.doesNotMatch(markup, /Corner radius|Clip contents|Stroke width/);
  });

  it("disables locked geometry while preserving visibility and unlock actions", () => {
    const markup = render([{ ...rectangle, parentId: undefined, locked: true }], [rectangle.id]);
    assert.match(input(markup, "Width"), /disabled/);
    assert.match(input(markup, "Fill color"), /disabled/);
    assert.doesNotMatch(button(markup, "Hide selection"), /disabled/);
    assert.doesNotMatch(button(markup, "Unlock selection"), /disabled/);
    assert.match(button(markup, "Unlock selection"), /aria-pressed="true"/);
  });

  it("shows hidden nodes and honors ancestor locks without pretending to unlock the parent", () => {
    const markup = render(
      [
        { ...frame, locked: true },
        { ...rectangle, hidden: true },
      ],
      [rectangle.id],
    );

    assert.match(input(markup, "X position"), /disabled/);
    assert.match(button(markup, "Show selection"), /aria-pressed="true"/);
    assert.match(button(markup, "Lock selection"), /aria-pressed="false"/);
  });

  it("uses pen stroke controls and avoids irrelevant fill shape controls", () => {
    const pen: CanvasFrame = {
      id: "pen",
      name: "Path",
      kind: "pen",
      x: 0,
      y: 0,
      width: 80,
      height: 80,
      points: [
        { x: 0, y: 0 },
        { x: 80, y: 80 },
      ],
      pathWidth: 80,
      pathHeight: 80,
      stroke: "#ff0000",
      strokeWidth: 3,
    };

    const markup = render([pen], [pen.id]);
    assert.match(input(markup, "Stroke color"), /value="FF0000"/);
    assert.match(input(markup, "Stroke width"), /value="3"/);
    assert.doesNotMatch(markup, /Corner radius|Font family/);
  });

  it("provides accessible numeric scrub controls while keeping locked labels inert", () => {
    const editable = render([frame, rectangle], [rectangle.id]);
    assert.doesNotMatch(button(editable, "Adjust width"), /disabled/);
    assert.match(button(editable, "Adjust width"), /Shift: faster. Alt: finer./);
    const locked = render([frame, { ...rectangle, locked: true }], [rectangle.id]);
    assert.match(button(locked, "Adjust width"), /disabled/);
  });

  it("shows frame auto layout settings and keeps free layout controls compact", () => {
    const free = render([frame], [frame.id]);
    assert.match(free, /aria-label="Auto layout direction"/);
    assert.match(button(free, "Free layout"), /aria-pressed="true"/);
    assert.doesNotMatch(free, /aria-label="Layout gap"/);

    const arranged = render(
      [
        {
          ...frame,
          layout: {
            direction: "row",
            gap: 20,
            padding: 12,
            align: "center",
            justify: "space-between",
          },
        },
      ],
      [frame.id],
    );

    assert.match(button(arranged, "Horizontal"), /aria-pressed="true"/);
    assert.match(input(arranged, "Layout gap"), /value="20"/);
    assert.match(input(arranged, "Layout padding"), /value="12"/);
    assert.match(arranged, /<option value="space-between" selected="">Space between/);
  });

  it("disables auto-managed child positions and alignment while allowing sizing", () => {
    const markup = render(
      [
        {
          ...frame,
          layout: { direction: "column", gap: 16, padding: 16, align: "start", justify: "start" },
        },
        rectangle,
      ],
      [rectangle.id],
    );

    assert.match(input(markup, "X position"), /disabled/);
    assert.match(input(markup, "Y position"), /disabled/);
    assert.match(button(markup, "Adjust x position"), /disabled/);
    assert.match(button(markup, "Align left"), /disabled/);
    assert.doesNotMatch(input(markup, "Width"), /disabled/);
    assert.match(markup, /Position managed by auto layout/);
    assert.doesNotMatch(markup, /aria-label="Auto layout direction"/);
  });
});

describe("expanded property controls", () => {
  it("exposes existing effects and disables their controls under an ancestor lock", () => {
    const node = {
      ...rectangle,
      borderWidth: 3,
      borderColor: "#abcdef",
      shadows: [
        { offsetX: 1, offsetY: 2, blur: 12, spread: -2, color: "#00000040" },
        { offsetX: 0, offsetY: 1, blur: 4, spread: 0, color: "#ffffff80", inset: true },
      ],
    };

    const markup = render([frame, node], [node.id]);
    assert.match(input(markup, "Border width"), /value="3"/);
    assert.match(input(markup, "Shadow 1 spread"), /value="-2"/);
    assert.match(input(markup, "Inner shadow 1 blur"), /value="4"/);
    assert.match(button(markup, "Border color picker"), /aria-haspopup="dialog"/);
    const locked = render([{ ...frame, locked: true }, node], [node.id]);
    for (const label of [
      "Add shadow",
      "Remove border",
      "Remove inner shadow 1",
      "Border color picker",
    ])
      assert.match(button(locked, label), /disabled/);
    assert.match(input(locked, "Shadow 1 blur"), /disabled/);
  });

  it("shows custom weights and current text styles accurately", () => {
    const markup = render(
      [
        {
          ...text,
          fontWeight: 450,
          fontStyle: "italic" as const,
          textDecoration: "underline" as const,
        },
      ],
      [text.id],
    );

    assert.match(markup, /<option value="450" selected="">450/);
    assert.match(button(markup, "Italic"), /aria-pressed="true"/);
    assert.match(button(markup, "Underline"), /aria-pressed="true"/);
    assert.match(button(markup, "Strikethrough"), /aria-pressed="false"/);
  });

  it("maps the alignment grid to column layout", () => {
    const markup = render(
      [
        {
          ...frame,
          layout: { direction: "column", align: "end", justify: "center", gap: 10, padding: 8 },
        },
      ],
      [frame.id],
    );

    assert.match(button(markup, "Align content middle right"), /aria-pressed="true"/);
    assert.match(button(markup, "Vertical"), /aria-pressed="true"/);
  });
});
