import assert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import { CanvasDocument } from "./canvas-document";
import { fontFamilyCss, isFontFamily, resolveCanvasFontFamily } from "./canvas-fonts";

describe("font families", () => {
  it("preserves named imported fonts and resolves generic stacks", () => {
    assert.equal(resolveCanvasFontFamily('"Space Grotesk", Arial, sans-serif'), "Space Grotesk");
    assert.equal(resolveCanvasFontFamily("system-ui, sans-serif"), "Arial");
    assert.equal(fontFamilyCss("Space Grotesk"), '"Space Grotesk", sans-serif');
    assert.equal(isFontFamily("Font; color:red"), false);
    assert.equal(isFontFamily("Font\u0000"), false);
  });
  it("retains custom families and light weights in the document model", () => {
    const document = new CanvasDocument([
      {
        id: "text",
        name: "Text",
        kind: "text",
        x: 0,
        y: 0,
        width: 200,
        height: 40,
        text: "Hello",
        fontSize: 20,
        color: "#000000",
        fontFamily: "Space Grotesk",
        fontWeight: 300,
      },
    ]);

    const node = document.getFrame("text");
    assert.equal(node?.kind, "text");
    if (node?.kind !== "text") throw new Error("Missing text");
    assert.equal(node.fontFamily, "Space Grotesk");
    assert.equal(node.fontWeight, 300);
  });
});
