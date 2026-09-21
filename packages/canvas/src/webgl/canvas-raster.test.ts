import assert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import type { CanvasFrame } from "../canvas-document";
import { nodeRasterBounds, rasterGradientStops, rasterResolution } from "./canvas-raster";

const frame: CanvasFrame = { id: "frame", name: "Frame", x: 500, y: -100, width: 100, height: 50 };

describe("WebGL raster allocation", () => {
  it("includes the default root shadow only when shadows have not been authored", () => {
    assert.deepEqual(nodeRasterBounds(frame, true), { x: -16, y: -14, width: 132, height: 82 });
    assert.deepEqual(nodeRasterBounds({ ...frame, shadows: [] }, true), {
      x: 0,
      y: 0,
      width: 100,
      height: 50,
    });
    assert.deepEqual(nodeRasterBounds({ ...frame, kind: "group" }, true), {
      x: 0,
      y: 0,
      width: 100,
      height: 50,
    });
  });

  it("includes scaled pen caps and offset outer shadows, and keeps inset shadows inside", () => {
    const pen: CanvasFrame = {
      ...frame,
      kind: "pen",
      pathWidth: 50,
      pathHeight: 100,
      points: [{ x: 0, y: 100 }],
      stroke: "#000000",
      strokeWidth: 10,
      shadows: [
        { offsetX: 20, offsetY: -10, blur: 5, spread: 2, color: "#000000" },
        { offsetX: 1000, offsetY: 1000, blur: 100, spread: 100, color: "#000000", inset: true },
      ],
    };

    assert.deepEqual(nodeRasterBounds(pen, false), { x: -10, y: -22, width: 142, height: 74.5 });
  });

  it("keeps texture dimensions and pixel count bounded at extreme canvas zoom and sizes", () => {
    for (const [width, height, scale] of [
      [100000, 50000, 20],
      [1, 100000000, 4],
      [100, 200, 2],
    ]) {
      const result = rasterResolution(width, height, scale);
      assert.ok(result.width > 0 && result.width <= 4096);
      assert.ok(result.height > 0 && result.height <= 4096);
      assert.ok(result.width * result.height <= 4_194_304);
    }

    assert.deepEqual(rasterResolution(100, 200, 2), { width: 200, height: 400 });
  });
});

describe("WebGL Oklab gradient rasterization", () => {
  it("premultiplies translucent sRGB stops just as CSS does", () => {
    const stops = rasterGradientStops({
      type: "linear",
      angle: 90,
      stops: [
        { offset: 0, color: "#ff000000" },
        { offset: 1, color: "#0000ff" },
      ],
    });

    assert.equal(stops.find((stop) => stop.offset === 0.5)!.color, "rgba(0,0,255,0.5)");
  });

  it("preserves hard stops and uses the Oklab midpoint instead of an sRGB purple", () => {
    const stops = rasterGradientStops({
      type: "linear",
      angle: 90,
      interpolation: "oklab",
      stops: [
        { offset: 0, color: "#ff0000" },
        { offset: 1, color: "#0000ff" },
        { offset: 1, color: "#ffffff" },
      ],
    });

    assert.equal(stops.length, 34);
    const midpoint = stops.find((stop) => stop.offset === 0.5)!;
    const channels = midpoint.color.match(/[\d.]+/g)!.map(Number);
    assert.ok(Math.abs(channels[0] - 140.36) < 1);
    assert.ok(Math.abs(channels[1] - 83.03) < 1);
    assert.ok(Math.abs(channels[2] - 162.31) < 1);
    assert.equal(stops[32].color, "#0000ff");
    assert.equal(stops[33].color, "#ffffff");
  });

  it("interpolates premultiplied alpha to avoid dark halos at transparent stops", () => {
    const stops = rasterGradientStops({
      type: "radial",
      angle: 0,
      interpolation: "oklab",
      stops: [
        { offset: 0, color: "#f000" },
        { offset: 1, color: "#00ff" },
      ],
    });

    const channels = stops
      .find((stop) => stop.offset === 0.5)!
      .color.match(/[\d.]+/g)!
      .map(Number);

    assert.ok(channels[0] < 1 && channels[1] < 1 && channels[2] > 254);
    assert.equal(channels[3], 0.5);
  });
});
