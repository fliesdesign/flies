/// <reference types="node" />

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fitViewport, type FrameRect } from "./canvas-geometry";
import { CanvasSpatialIndex, viewportBounds } from "./canvas-spatial-index";

type Frame = FrameRect & { id: string };

function bruteForce(frames: readonly Frame[], bounds: FrameRect) {
  return new Set(
    frames
      .filter(
        (frame) =>
          frame.x <= bounds.x + bounds.width &&
          frame.x + frame.width >= bounds.x &&
          frame.y <= bounds.y + bounds.height &&
          frame.y + frame.height >= bounds.y,
      )
      .map((frame) => frame.id),
  );
}

function randomSequence() {
  let seed = 0x56fe7121;
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
}

describe("canvas spatial index", () => {
  it("handles empty documents and unknown removals", () => {
    const index = new CanvasSpatialIndex();
    index.remove("missing");
    assert.deepEqual(index.query({ x: -100, y: -100, width: 200, height: 200 }), []);
  });

  it("finds exact intersections across negative and positive cell boundaries", () => {
    const frames: Frame[] = [
      { id: "negative", x: -1100, y: -1100, width: 100, height: 100 },
      { id: "crossing", x: -20, y: -20, width: 40, height: 40 },
      { id: "positive", x: 1024, y: 1024, width: 100, height: 100 },
      { id: "same-cell-miss", x: 500, y: 500, width: 100, height: 100 },
    ];
    const index = new CanvasSpatialIndex(frames);
    const queries = [
      { x: -1024, y: -1024, width: 24, height: 24 },
      { x: -21, y: -21, width: 42, height: 42 },
      { x: 1024, y: 1024, width: 0, height: 0 },
      { x: 1000, y: 1000, width: 24, height: 24 },
      { x: 200, y: 200, width: 20, height: 20 },
    ];

    for (const query of queries) {
      assert.deepEqual(new Set(index.query(query)), bruteForce(frames, query));
    }
  });

  it("includes touching edges and returns spanning frames only once", () => {
    const index = new CanvasSpatialIndex([
      { id: "spanning", x: -1024, y: -1024, width: 2048, height: 2048 },
    ]);

    assert.deepEqual(index.query({ x: -2000, y: -2000, width: 4000, height: 4000 }), ["spanning"]);
    for (const point of [
      { x: -1024, y: 0 },
      { x: 1024, y: 0 },
      { x: 0, y: -1024 },
      { x: 0, y: 1024 },
      { x: 1024, y: 1024 },
    ]) {
      assert.deepEqual(index.query({ ...point, width: 0, height: 0 }), ["spanning"]);
    }
    assert.deepEqual(index.query({ x: 1024.001, y: 0, width: 0, height: 0 }), []);
  });

  it("replaces existing entries and removes stale cell and oversized memberships", () => {
    const index = new CanvasSpatialIndex([{ id: "moving", x: 0, y: 0, width: 100, height: 100 }]);
    const origin = { x: 0, y: 0, width: 10, height: 10 };

    index.upsert({ id: "moving", x: 5000, y: 5000, width: 100, height: 100 });
    assert.deepEqual(index.query(origin), []);
    assert.deepEqual(index.query({ x: 5050, y: 5050, width: 10, height: 10 }), ["moving"]);

    index.upsert({ id: "moving", x: -1e9, y: -1e9, width: 2e9, height: 2e9 });
    assert.deepEqual(index.query(origin), ["moving"]);

    index.upsert({ id: "moving", x: -5000, y: -5000, width: 100, height: 100 });
    assert.deepEqual(index.query(origin), []);
    assert.deepEqual(index.query({ x: -4950, y: -4950, width: 10, height: 10 }), ["moving"]);
    index.remove("moving");
    assert.deepEqual(index.query({ x: -1e9, y: -1e9, width: 2e9, height: 2e9 }), []);

    index.upsert({ id: "giant", x: -1e9, y: -1e9, width: 2e9, height: 2e9 });
    index.remove("giant");
    assert.deepEqual(index.query(origin), []);
  });

  it("bounds work for giant frames, distant coordinates, and enormous queries", () => {
    const frames: Frame[] = [
      { id: "giant", x: -1e12, y: -1e12, width: 2e12, height: 2e12 },
      { id: "origin", x: 0, y: 0, width: 100, height: 100 },
      { id: "distant", x: 1e100, y: 1e100, width: 1e90, height: 1e90 },
    ];
    const index = new CanvasSpatialIndex(frames);

    assert.deepEqual(
      new Set(index.query({ x: 1, y: 1, width: 10, height: 10 })),
      new Set(["giant", "origin"]),
    );
    assert.deepEqual(index.query({ x: 2e12, y: 2e12, width: 100, height: 100 }), []);
    assert.deepEqual(index.query({ x: 1e100, y: 1e100, width: 1, height: 1 }), ["distant"]);
    assert.deepEqual(
      new Set(index.query({ x: -1e101, y: -1e101, width: 2e101, height: 2e101 })),
      new Set(["distant", "giant", "origin"]),
    );
  });

  it("captures geometry on insertion instead of retaining externally mutable rectangles", () => {
    const frame = { id: "frame", x: 10, y: 20, width: 30, height: 40 };
    const index = new CanvasSpatialIndex([frame]);
    frame.x = 10000;
    assert.deepEqual(index.query({ x: 10, y: 20, width: 0, height: 0 }), ["frame"]);
    index.upsert(frame);
    assert.deepEqual(index.query({ x: 10, y: 20, width: 0, height: 0 }), []);
  });

  it("matches brute force after randomized insertions, replacements, and removals", () => {
    const random = randomSequence();
    const frames = new Map<string, Frame>();
    const index = new CanvasSpatialIndex();
    const rectangle = (): FrameRect => ({
      x: Math.floor(random() * 100000) - 50000,
      y: Math.floor(random() * 100000) - 50000,
      width: Math.floor(random() * 10000),
      height: Math.floor(random() * 10000),
    });

    for (let i = 0; i < 1500; i++) {
      const frame = { id: `frame-${i}`, ...rectangle() };
      frames.set(frame.id, frame);
      index.upsert(frame);
    }

    for (let i = 0; i < 300; i++) {
      const id = `frame-${Math.floor(random() * 1500)}`;
      if (i % 3 === 0) {
        frames.delete(id);
        index.remove(id);
      } else {
        const frame = { id, ...rectangle() };
        frames.set(id, frame);
        index.upsert(frame);
      }
      const query = rectangle();
      assert.deepEqual(new Set(index.query(query)), bruteForce([...frames.values()], query));
    }
  });
});

describe("viewport visibility bounds", () => {
  for (const zoom of [0.1, 0.5, 1, 4]) {
    it(`keeps a 200px screen-space overscan at zoom ${zoom}`, () => {
      const viewport = { x: -350, y: 175, zoom };
      const size = { x: 1200, y: 800 };
      const bounds = viewportBounds(viewport, size);

      assert.equal(bounds.x * zoom + viewport.x, -200);
      assert.equal(bounds.y * zoom + viewport.y, -200);
      assert.equal((bounds.x + bounds.width) * zoom + viewport.x, size.x + 200);
      assert.equal((bounds.y + bounds.height) * zoom + viewport.y, size.y + 200);
    });
  }

  it("supports a custom buffer and clamps negative overscan to zero", () => {
    assert.deepEqual(viewportBounds({ x: 100, y: -200, zoom: 2 }, { x: 800, y: 600 }, 40), {
      x: -70,
      y: 80,
      width: 440,
      height: 340,
    });
    assert.deepEqual(viewportBounds({ x: 100, y: -200, zoom: 2 }, { x: 800, y: 600 }, -10), {
      x: -50,
      y: 100,
      width: 400,
      height: 300,
    });
  });

  it("fits large indexed documents without spreading frame bounds onto the call stack", () => {
    const frames = Array.from({ length: 200000 }, (_, i) => ({
      x: i,
      y: 0,
      width: 1,
      height: 1,
    }));
    assert.deepEqual(fitViewport(frames, { x: 1000, y: 800 }), {
      x: -9500,
      y: 399.95,
      zoom: 0.1,
    });
  });
});
