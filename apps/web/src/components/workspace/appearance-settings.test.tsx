/// <reference types="node" />

import assert from "node:assert/strict";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vite-plus/test";

import { AppearanceSettings } from "./appearance-settings";

describe("appearance settings", () => {
  it("exposes brightness, contrast, and a picker for each UI color", () => {
    const markup = renderToStaticMarkup(<AppearanceSettings />);
    assert.match(markup, /Brightness/);
    assert.match(markup, /Contrast/);
    assert.match(markup, /Reset appearance/);
    assert.match(markup, /aria-label="Background"/);
    assert.match(markup, /aria-label="Foreground"/);
    assert.match(markup, /aria-label="Primary"/);
    assert.match(markup, /type="color"/);
    assert.match(markup, /#0c0c0c/);
  });
});
