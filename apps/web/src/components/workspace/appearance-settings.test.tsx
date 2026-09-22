/// <reference types="node" />

import assert from "node:assert/strict";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vite-plus/test";

import { AppearanceSettings } from "./appearance-settings";

describe("appearance settings", () => {
  it("exposes only brightness and contrast without individual color controls", () => {
    const markup = renderToStaticMarkup(<AppearanceSettings />);
    assert.match(markup, /Brightness/);
    assert.match(markup, /Contrast/);
    assert.match(markup, /Reset appearance/);
    assert.equal((markup.match(/type="range"/g) ?? []).length, 2);
    assert.match(markup, /value="16"/);
    assert.match(markup, /value="12"/);
    assert.doesNotMatch(markup, /type="color"|hex|Surfaces|Actions|Lines/);
  });
});
