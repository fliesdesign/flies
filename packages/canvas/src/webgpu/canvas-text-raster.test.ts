import assert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import { textRasterResolution } from "./canvas-text-raster";

describe("GPU text raster density", () => {
  it("covers display density and zoom without changing on every fractional zoom step", () => {
    assert.equal(textRasterResolution(140, 20, 1, 1), 2);
    assert.equal(textRasterResolution(140, 20, 1, 1.01), 2);
    assert.equal(textRasterResolution(140, 20, 1, 1.8), 2);
    assert.equal(textRasterResolution(140, 20, 1, 4), 4);
    assert.equal(textRasterResolution(140, 20, 2, 4), 8);
  });

  it("caps actual pooled canvas edges and area for long and multi-line text", () => {
    for (const [width, height] of [
      [12000, 20],
      [20, 12000],
      [3000.1, 3000.1],
      [900, 1800],
      [100000, 100000],
    ]) {
      const resolution = textRasterResolution(width, height, 2, 4);

      const backing = (size: number) =>
        2 ** Math.ceil(Math.log2(Math.ceil(Math.ceil(size) * resolution)));

      assert.ok(resolution > 0);
      assert.ok(backing(width) <= 4096);
      assert.ok(backing(height) <= 4096);
      assert.ok(backing(width) * backing(height) <= 4_194_304);
    }
  });
});
