/// <reference types="node" />

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  fitViewport,
  MAX_ZOOM,
  MIN_ZOOM,
  resizeFrame,
  resizeFrameProportionally,
  screenToWorld,
  zoomAtPoint,
  type FrameRect,
  type ResizeHandle,
} from "./canvas-geometry";

describe("canvas coordinates", () => {
  it("converts translated and zoomed screen points into world coordinates", () => {
    assert.deepEqual(screenToWorld({ x: 80, y: 30 }, { x: 120, y: -30, zoom: 2 }), {
      x: -20,
      y: 30,
    });
  });

  for (const requestedZoom of [0.001, 0.5, 2, 100]) {
    it(`keeps the cursor anchor fixed when zooming to ${requestedZoom}`, () => {
      const viewport = { x: -240, y: 135, zoom: 0.75 };
      const cursor = { x: 317, y: 491 };
      const before = screenToWorld(cursor, viewport);
      const next = zoomAtPoint(viewport, cursor, requestedZoom);
      const after = screenToWorld(cursor, next);

      assert.ok(Math.abs(before.x - after.x) < 1e-9);
      assert.ok(Math.abs(before.y - after.y) < 1e-9);
      assert.equal(next.zoom, Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, requestedZoom)));
    });
  }
});

describe("frame resizing", () => {
  const start: FrameRect = { x: -100, y: -50, width: 200, height: 120 };
  const cases: [ResizeHandle, FrameRect][] = [
    ["n", { x: -100, y: -20, width: 200, height: 90 }],
    ["ne", { x: -100, y: -20, width: 220, height: 90 }],
    ["e", { x: -100, y: -50, width: 220, height: 120 }],
    ["se", { x: -100, y: -50, width: 220, height: 150 }],
    ["s", { x: -100, y: -50, width: 200, height: 150 }],
    ["sw", { x: -80, y: -50, width: 180, height: 150 }],
    ["w", { x: -80, y: -50, width: 180, height: 120 }],
    ["nw", { x: -80, y: -20, width: 180, height: 90 }],
  ];

  for (const [handle, expected] of cases) {
    it(`resizes ${handle} while preserving the opposite edges`, () => {
      assert.deepEqual(resizeFrame(start, handle, { x: 20, y: 30 }), expected);
    });

    it(`keeps ${handle} from crossing the opposite edges at minimum size`, () => {
      const delta = {
        x: handle.includes("w") ? 500 : -500,
        y: handle.includes("n") ? 500 : -500,
      };
      const result = resizeFrame(start, handle, delta);
      const horizontal = handle.includes("w") || handle.includes("e");
      const vertical = handle.includes("n") || handle.includes("s");

      assert.equal(result.width, horizontal ? 40 : start.width);
      assert.equal(result.height, vertical ? 40 : start.height);
      assert.equal(
        handle.includes("w") ? result.x + result.width : result.x,
        handle.includes("w") ? start.x + start.width : start.x,
      );
      assert.equal(
        handle.includes("n") ? result.y + result.height : result.y,
        handle.includes("n") ? start.y + start.height : start.y,
      );
    });
  }

  it("rounds fractional movement and supports custom minimum dimensions", () => {
    assert.deepEqual(resizeFrame(start, "nw", { x: -15.2, y: -20.7 }), {
      x: -115,
      y: -71,
      width: 215,
      height: 141,
    });
    assert.deepEqual(resizeFrame(start, "se", { x: -500, y: -500 }, 64), {
      x: -100,
      y: -50,
      width: 64,
      height: 64,
    });
    assert.deepEqual(start, { x: -100, y: -50, width: 200, height: 120 });
  });
});

describe("fitting the viewport", () => {
  it("centers the origin for an empty canvas", () => {
    assert.deepEqual(fitViewport([], { x: 1200, y: 800 }), { x: 600, y: 400, zoom: 1 });
  });

  it("fits the complete union of frames, including negative positions", () => {
    const frames = [
      { x: -400, y: -200, width: 300, height: 200 },
      { x: 200, y: 100, width: 400, height: 500 },
    ];
    const viewport = fitViewport(frames, { x: 800, y: 640 }, 80);

    assert.deepEqual(viewport, { x: 340, y: 200, zoom: 0.6 });
    assert.equal(-200 * viewport.zoom + viewport.y, 80);
    assert.equal(600 * viewport.zoom + viewport.y, 560);
  });

  it("centers small frames at actual size instead of zooming in", () => {
    assert.deepEqual(
      fitViewport([{ x: 50, y: 100, width: 200, height: 100 }], { x: 1000, y: 800 }),
      { x: 350, y: 250, zoom: 1 },
    );
  });

  it("respects the minimum zoom even for enormous bounds and tiny viewports", () => {
    const frames = [{ x: -10000, y: -10000, width: 20000, height: 20000 }];
    assert.deepEqual(fitViewport(frames, { x: 100, y: 100 }), {
      x: 50,
      y: 50,
      zoom: MIN_ZOOM,
    });
  });
});

describe("proportional resizing", () => {
  const start = { x: 100, y: 200, width: 200, height: 100 };
  for (const handle of ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as ResizeHandle[]) {
    it(`preserves aspect and the opposite anchor for ${handle}`, () => {
      const next = resizeFrameProportionally(start, handle, { x: 50, y: 30 });
      assert.equal(next.width / next.height, 2);
      if (handle.includes("w")) assert.equal(next.x + next.width, 300);
      else if (handle.includes("e")) assert.equal(next.x, 100);
      else assert.equal(next.x + next.width / 2, 200);
      if (handle.includes("n")) assert.equal(next.y + next.height, 300);
      else if (handle.includes("s")) assert.equal(next.y, 200);
      else assert.equal(next.y + next.height / 2, 250);
    });
  }
  it("keeps both minimum dimensions and never flips", () => {
    const next = resizeFrameProportionally(start, "nw", { x: 1000, y: 1000 }, 40);
    assert.deepEqual(next, { x: 220, y: 260, width: 80, height: 40 });
  });
});
