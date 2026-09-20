/// <reference types="node" />

import assert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import { penFromPoints, rectFromPoints } from "./canvas-tools";

describe("canvas tool geometry", () => {
  it("normalizes drawing in each direction without losing the anchor corner", () => {
    const start = { x: 10, y: 20 };
    assert.deepEqual(rectFromPoints(start, { x: 70, y: 50 }), {
      x: 10,
      y: 20,
      width: 60,
      height: 30,
    });
    assert.deepEqual(rectFromPoints(start, { x: -50, y: -10 }), {
      x: -50,
      y: -10,
      width: 60,
      height: 30,
    });
    assert.deepEqual(rectFromPoints(start, { x: -50, y: 50 }), {
      x: -50,
      y: 20,
      width: 60,
      height: 30,
    });
  });

  it("gives click-only drawings positive bounds", () => {
    assert.deepEqual(rectFromPoints({ x: 10, y: 20 }, { x: 10, y: 20 }), {
      x: 10,
      y: 20,
      width: 1,
      height: 1,
    });
  });

  it("applies minimum dimensions in the drawn direction", () => {
    assert.deepEqual(rectFromPoints({ x: 10, y: 20 }, { x: 9.5, y: 19.5 }, 40), {
      x: -30,
      y: -20,
      width: 40,
      height: 40,
    });
  });

  it("ignores an invalid or nonpositive minimum", () => {
    const point = { x: 0, y: 0 };
    for (const min of [-4, 0, NaN, Infinity]) {
      assert.deepEqual(rectFromPoints(point, point, min), { x: 0, y: 0, width: 1, height: 1 });
    }
  });

  it("converts world pen points to local coordinates with stroke padding", () => {
    const points = [
      { x: 10, y: 20 },
      { x: -10, y: 35 },
      { x: 15, y: -5 },
    ];
    const geometry = penFromPoints(points)!;
    assert.deepEqual(geometry, {
      x: -12,
      y: -7,
      width: 29,
      height: 44,
      pathWidth: 29,
      pathHeight: 44,
      points: [
        { x: 22, y: 27 },
        { x: 2, y: 42 },
        { x: 27, y: 2 },
      ],
    });
    assert.deepEqual(
      geometry.points.map((point) => ({ x: point.x + geometry.x, y: point.y + geometry.y })),
      points,
    );
  });

  it("preserves a single-point pen stroke as a padded dot", () => {
    assert.deepEqual(penFromPoints([{ x: 10, y: -5 }]), {
      x: 8,
      y: -7,
      width: 4,
      height: 4,
      pathWidth: 4,
      pathHeight: 4,
      points: [{ x: 2, y: 2 }],
    });
  });

  it("handles horizontal, vertical, repeated, and empty pen input", () => {
    assert.equal(penFromPoints([]), null);
    assert.equal(
      penFromPoints([
        { x: 1, y: 2 },
        { x: 1, y: 20 },
      ])?.width,
      4,
    );
    assert.equal(
      penFromPoints([
        { x: 1, y: 2 },
        { x: 20, y: 2 },
      ])?.height,
      4,
    );
    assert.deepEqual(
      penFromPoints([
        { x: 1, y: 2 },
        { x: 1, y: 2 },
      ])?.points,
      [
        { x: 2, y: 2 },
        { x: 2, y: 2 },
      ],
    );
  });
});
