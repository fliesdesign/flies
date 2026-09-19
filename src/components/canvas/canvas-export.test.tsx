import assert from "node:assert/strict";
import { test } from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import { CanvasDocument } from "@/lib/canvas-document";

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
