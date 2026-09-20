/// <reference types="node" />

import assert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  colorFromHsv,
  colorToHsv,
  normalizeCanvasHex,
  scrubNumericValue,
} from "./canvas-property-values";

describe("property color controls", () => {
  it("normalizes supported RGB and alpha colors without accepting invalid input", () => {
    assert.equal(normalizeCanvasHex("ABC"), "#aabbcc");
    assert.equal(normalizeCanvasHex("#f008"), "#ff000088");
    assert.equal(normalizeCanvasHex("aAbBcC7F"), "#aabbcc7f");

    for (const invalid of ["", "#12", "#12345", "#1234567", "red", "#abcdefgg"]) {
      assert.equal(normalizeCanvasHex(invalid), null);
    }
  });

  it("round trips colors and their existing alpha channel", () => {
    for (const color of [
      "#000000",
      "#ffffff",
      "#aabbcc",
      "#ff0000",
      "#00ff00",
      "#0000ff",
      "#ff00ff",
      "#12345678",
      "#ffffff00",
      "#abcdef01",
    ]) {
      assert.equal(colorFromHsv(colorToHsv(color)), color);
    }
  });

  it("allows hue, saturation, brightness and alpha to change independently", () => {
    const red = colorToHsv("#ff000080");
    assert.equal(colorFromHsv({ ...red, h: 120 }), "#00ff0080");
    assert.equal(colorFromHsv({ ...red, s: 0 }), "#ffffff80");
    assert.equal(colorFromHsv({ ...red, v: 0.5 }), "#80000080");
    assert.equal(colorFromHsv({ ...red, a: 1 }), "#ff0000");
    assert.equal(colorFromHsv({ ...red, h: 360 }), "#ff000080");
  });
});

describe("property numeric scrubbing", () => {
  it("uses fine and coarse modifiers and property-specific steps", () => {
    assert.equal(scrubNumericValue(100, 5), 105);
    assert.equal(scrubNumericValue(100, 5, { shift: true }), 150);
    assert.equal(scrubNumericValue(100, 5, { alt: true }), 100.5);
    assert.equal(scrubNumericValue(1.25, 5, { step: 0.01 }), 1.3);
    assert.equal(scrubNumericValue(100, 5, { shift: true, alt: true }), 100.5);
  });

  it("clamps values and immediately responds when reversing at either boundary", () => {
    assert.equal(scrubNumericValue(98, 20, { min: 0, max: 100 }), 100);
    assert.equal(scrubNumericValue(100, -1, { min: 0, max: 100 }), 99);
    assert.equal(scrubNumericValue(2, -20, { min: 0, max: 100 }), 0);
    assert.equal(scrubNumericValue(0, 1, { min: 0, max: 100 }), 1);
  });

  it("changes modifiers incrementally without jumping back to the original start value", () => {
    const normal = scrubNumericValue(10, 2);
    const coarse = scrubNumericValue(normal, 2, { shift: true });
    const fine = scrubNumericValue(coarse, -2, { alt: true });
    assert.equal(normal, 12);
    assert.equal(coarse, 32);
    assert.equal(fine, 31.8);
  });
});
