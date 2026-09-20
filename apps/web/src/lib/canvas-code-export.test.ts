import type { CanvasFrame } from "@flies/canvas";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { describe, expect, it } from "vite-plus/test";

import { CANVAS_CODE_FORMATS, exportCanvasCode } from "./canvas-code-export";

const nodes: CanvasFrame[] = [
  {
    id: "frame",
    name: 'Card "one"',
    x: 100,
    y: 200,
    width: 300,
    height: 200,
    fill: "#ffffff",
    borderWidth: 2,
    borderColor: "#123456",
    cornerRadius: 12,
    shadows: [{ offsetX: 1, offsetY: 2, blur: 3, spread: 0, color: "#00000080" }],
  },
  {
    id: "text",
    parentId: "frame",
    kind: "text",
    name: "Title",
    x: 120,
    y: 230,
    width: 200,
    height: 50,
    text: '<script>alert("x")</script> & {value}\nnext',
    fontSize: 20,
    color: "#123456",
    fontWeight: 600,
  },
  {
    id: "pen",
    parentId: "frame",
    kind: "pen",
    name: "Line",
    x: 110,
    y: 300,
    width: 100,
    height: 20,
    points: [
      { x: 0, y: 0 },
      { x: 100, y: 20 },
    ],
    pathWidth: 100,
    pathHeight: 20,
    stroke: "#000000",
    strokeWidth: 2,
  },
  {
    id: "hidden",
    parentId: "frame",
    kind: "rectangle",
    name: "Secret",
    hidden: true,
    x: 110,
    y: 210,
    width: 40,
    height: 40,
    fill: "#ffffff",
  },
  { id: "other", name: "Unselected", x: 500, y: 200, width: 100, height: 100 },
];

describe("copy as code", () => {
  it("exports only selection roots and visible descendants with relative geometry and effects", () => {
    const html = exportCanvasCode(nodes, ["frame", "text"], "CSS");
    expect(html.match(/data-name="Title"/g)).toHaveLength(1);
    expect(html).toContain("left: 20px; top: 30px");
    expect(html).toContain("border-width: 2px");
    expect(html).toContain("box-shadow: 1px 2px 3px 0px #00000080");
    expect(html).toContain("overflow: hidden");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("Secret");
    expect(html).not.toContain("Unselected");
  });

  it("normalizes detached children and multiple selections without mutating the document", () => {
    const before = JSON.stringify(nodes);
    const html = exportCanvasCode(nodes, ["text", "other"], "CSS");
    expect(html).toContain("width: 480px; height: 100px");
    expect(html).toContain("left: 0px; top: 30px");
    expect(html).toContain("left: 380px; top: 0px");
    expect(JSON.stringify(nodes)).toBe(before);
    expect(() => exportCanvasCode(nodes, [], "CSS")).toThrow("Select a visible layer");
    expect(() => exportCanvasCode(nodes, ["hidden"], "CSS")).toThrow("Select a visible layer");
  });

  it.each(CANVAS_CODE_FORMATS)("produces valid %s syntax and safely escaped content", (format) => {
    const code = exportCanvasCode(nodes, ["frame"], format);
    if (format.startsWith("React")) {
      const compiled = ts.transpileModule(code, {
        reportDiagnostics: true,
        compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS },
        fileName: "selection.tsx",
      });
      expect(compiled.diagnostics).toEqual([]);
      const exports: { default?: React.ComponentType } = {};
      // Execute only our generated fixture code, never user input or arbitrary source.
      new Function("React", "exports", compiled.outputText)(React, exports);
      const html = renderToStaticMarkup(React.createElement(exports.default!));
      expect(html).toContain("&lt;script&gt;");
      expect(html).toContain('stroke-width="2"');
      expect(html).toContain("{value}");
      expect(code).toContain("strokeWidth=");
    } else {
      expect(code).toContain('stroke-width="2"');
    }
    if (format.includes("Tailwind")) {
      expect(code).toContain("w-[300px]");
      expect(code).toContain("[font-family:Arial,_Helvetica,_sans-serif]");
      expect(code).not.toContain("style=");
    } else {
      expect(code).toContain("style=");
      expect(code).not.toContain("class=");
    }
  });
});
