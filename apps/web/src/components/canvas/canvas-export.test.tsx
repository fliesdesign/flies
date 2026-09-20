import assert from "node:assert/strict";

import { CanvasDocument } from "@flies/canvas";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "vite-plus/test";

import { CanvasExportScene } from "./canvas-export";

test("export renders full frame subtree with clipping and excludes editor chrome and hidden children", () => {
  const document = new CanvasDocument([
    {
      id: "frame",
      name: "Artboard",
      x: 1000,
      y: 2000,
      width: 400,
      height: 300,
      fill: "#abcdef",
      cornerRadius: 20,
    },
    {
      id: "text",
      name: "Text",
      parentId: "frame",
      kind: "text",
      x: 1020,
      y: 2030,
      width: 250,
      height: 50,
      text: "Actual artwork",
      fontSize: 32,
      color: "#111111",
      fontWeight: 700,
    },
    {
      id: "hidden",
      name: "Hidden",
      parentId: "frame",
      kind: "text",
      x: 1020,
      y: 2090,
      width: 200,
      height: 50,
      text: "Do not export",
      fontSize: 20,
      color: "#000000",
      hidden: true,
    },
  ]);

  const output = renderToStaticMarkup(<CanvasExportScene document={document} ids={["frame"]} />);
  assert.ok(output.includes("Actual artwork"));
  assert.ok(!output.includes("Do not export"));
  assert.ok(!output.includes("canvas-resize"));
  assert.ok(!output.includes("Artboard"));
  assert.ok(output.includes("left:20px;top:30px"));
  assert.ok(output.includes("border-radius:20px"));
  assert.ok(output.includes("background:#abcdef"));
});

test("export preserves authored borders, rounded edges, multiple shadows, and text emphasis", () => {
  const document = new CanvasDocument([
    { id: "artboard", name: "Artboard", x: 0, y: 0, width: 500, height: 400 },
    {
      id: "search",
      name: "Search field",
      parentId: "artboard",
      kind: "rectangle",
      x: 20,
      y: 30,
      width: 240,
      height: 44,
      fill: "#ffffff",
      cornerRadius: 22,
      borderWidth: 1,
      borderColor: "#dadce0",
      shadows: [
        { offsetX: 0, offsetY: 2, blur: 8, spread: 0, color: "#0000001f" },
        { offsetX: -1, offsetY: 0, blur: 1, spread: -1, color: "#ffffff80", inset: true },
      ],
    },
    {
      id: "link",
      name: "Link",
      parentId: "artboard",
      kind: "text",
      x: 20,
      y: 100,
      width: 180,
      height: 24,
      text: "Google offered in:",
      fontSize: 14,
      color: "#1a0dab",
      fontStyle: "italic",
      textDecoration: "underline",
    },
  ]);

  const output = renderToStaticMarkup(<CanvasExportScene document={document} ids={["artboard"]} />);
  assert.ok(
    output.includes(
      "box-sizing:border-box;pointer-events:none;border-style:solid;border-width:1px;border-color:#dadce0;border-radius:22px",
    ),
  );
  assert.ok(
    output.includes("box-shadow:0px 2px 8px 0px #0000001f, inset -1px 0px 1px -1px #ffffff80"),
  );
  assert.ok(output.includes("font-style:italic;text-decoration:underline"));
  assert.equal(output.match(/data-canvas-appearance/g)?.length, 1);
  assert.ok(!output.includes("canvas-frame-label"));
});
