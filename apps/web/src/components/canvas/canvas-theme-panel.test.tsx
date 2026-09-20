/// <reference types="node" />

import assert from "node:assert/strict";

import { CanvasDocument } from "@flies/canvas";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vite-plus/test";

import { CanvasThemePanel } from "./canvas-theme-panel";

describe("canvas theme panel", () => {
  it("shows one empty state instead of a section per token type", () => {
    const markup = renderToStaticMarkup(<CanvasThemePanel document={new CanvasDocument()} />);
    assert.match(markup, /No tokens/);
    assert.match(markup, /Create token/);
    assert.match(markup, /Use starter theme/);
    assert.equal(markup.includes("No tokens yet"), false);
    assert.equal(markup.includes("Define once, reuse"), false);
  });

  it("lists populated tokens in collapsible type groups", () => {
    const markup = renderToStaticMarkup(
      <CanvasThemePanel
        document={
          new CanvasDocument([], {
            tokens: [
              { id: "brand", name: "Brand", type: "color", value: "#123456" },
              { id: "space", name: "Space", type: "spacing", value: 20 },
              { id: "bold", name: "Bold", type: "fontWeight", value: 700 },
              { id: "page", name: "Page", type: "container", value: 1024 },
            ],
          })
        }
      />,
    );
    assert.match(markup, /4 tokens/);
    assert.match(markup, /Brand/);
    assert.match(markup, />20</);
    assert.match(markup, /Font weight/);
    assert.match(markup, /Container/);
    assert.equal(markup.includes("Use starter theme"), false);
    assert.equal(markup.includes("Font family"), false);
    assert.equal(markup.includes("Breakpoint"), false);
  });
});
