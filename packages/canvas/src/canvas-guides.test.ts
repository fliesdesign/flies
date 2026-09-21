/// <reference types="node" />

import assert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import { CanvasDocument, type CanvasFrame } from "./canvas-document";
import type { ResizeHandle } from "./canvas-geometry";
import {
  AlignmentGuideIndex,
  AlignmentGuideTargets,
  CanvasGuides,
  type AlignmentGuide,
  type AlignmentSnapState,
} from "./canvas-guides";

const target = { id: "target", x: 100, y: 100, width: 200, height: 200 };

describe("visible alignment targets", () => {
  const frame: CanvasFrame = { id: "frame", name: "Frame", x: 0, y: 0, width: 100, height: 100 };

  const child: CanvasFrame = {
    id: "child",
    name: "Child",
    parentId: "frame",
    kind: "rectangle",
    fill: "#fff",
    x: 150,
    y: 150,
    width: 30,
    height: 30,
  };

  const viewport = { x: -100, y: -100, width: 1000, height: 1000 };

  it("excludes fully clipped and hidden targets instead of snapping to invisible edges", () => {
    const document = new CanvasDocument([frame, child, { ...child, id: "hidden", hidden: true }]);
    const targets = new AlignmentGuideTargets(document, new Set([frame.id]));
    const rect = { x: 154, y: 400, width: 1, height: 10 };
    assert.deepEqual(targets.inViewport(viewport).snap(rect, 1), { rect, guides: [] });
    document.update({ ...frame, clipContent: false });
    const unclipped = new AlignmentGuideTargets(document, new Set([frame.id]));
    assert.equal(unclipped.inViewport(viewport).snap(rect, 1).rect.x, 150);
  });

  it("uses only the visible part of a clipped child for edges, center and guide endpoints", () => {
    const document = new CanvasDocument([frame, { ...child, x: 80, y: 70, width: 60, height: 60 }]);
    const index = new AlignmentGuideTargets(document, new Set([frame.id])).inViewport(viewport);
    assert.equal(index.snap({ x: 93, y: 400, width: 1, height: 10 }, 1).rect.x, 90);
    const rect = { x: 137, y: 400, width: 1, height: 10 };
    assert.deepEqual(index.snap(rect, 1), { rect, guides: [] });
    assert.deepEqual(index.snap({ x: 82, y: 400, width: 1, height: 10 }, 1).guides, [
      { axis: "x", position: 80, start: 70, end: 410 },
    ]);
  });

  it("excludes rounded corner cutouts and snaps to the visible curved overlap bounds", () => {
    const rounded = { ...frame, cornerRadius: 50 };
    const document = new CanvasDocument([rounded, { ...child, x: 0, y: 0, width: 5, height: 5 }]);
    const rect = { x: 4, y: 400, width: 1, height: 10 };
    assert.deepEqual(
      new AlignmentGuideTargets(document, new Set([frame.id])).inViewport(viewport).snap(rect, 1),
      { rect, guides: [] },
    );
    document.update({ ...child, x: 0, y: 0, width: 20, height: 40 });
    const index = new AlignmentGuideTargets(document, new Set([frame.id])).inViewport(viewport);
    const result = index.snap({ x: 4, y: 400, width: 1, height: 10 }, 1);
    const visibleLeft = 50 - Math.sqrt(50 ** 2 - 10 ** 2);
    assert.ok(Math.abs(result.rect.x - visibleLeft) < 1e-8);
    assert.equal(result.guides[0].start, 10);
  });

  it("finds newly revealed targets while auto-panning without including distant objects", () => {
    const document = new CanvasDocument([
      { ...frame, id: "near", x: 100, y: 100 },
      { ...frame, id: "far", x: 1000, y: 100 },
    ]);

    const targets = new AlignmentGuideTargets(document, new Set());
    const rect = { x: 1004, y: 400, width: 1, height: 10 };
    const initial = targets.inViewport({ x: 0, y: 0, width: 800, height: 600 });
    assert.deepEqual(initial.snap(rect, 1), { rect, guides: [] });
    const afterPan = targets.inViewport({ x: 300, y: 0, width: 800, height: 600 });
    assert.equal(afterPan.snap(rect, 1).rect.x, 1000);
  });

  it("snapshots gesture geometry and excludes all active descendants", () => {
    const document = new CanvasDocument([frame, { ...child, x: 20, y: 20 }]);

    const targets = new AlignmentGuideTargets(
      document,
      new Set(document.getDescendantIds(["frame"])),
    );

    const rect = { x: 23, y: 400, width: 1, height: 10 };
    assert.deepEqual(targets.inViewport(viewport).snap(rect, 1), { rect, guides: [] });
  });
});

describe("alignment guides", () => {
  it("aligns both axes and draws lines spanning the reference and moving object", () => {
    const index = new AlignmentGuideIndex([target], "moving");
    const result = index.snap({ x: 104, y: 403, width: 80, height: 90 }, 1);
    assert.deepEqual(result.rect, { x: 100, y: 403, width: 80, height: 90 });
    assert.deepEqual(result.guides, [{ axis: "x", position: 100, start: 100, end: 493 }]);

    const both = index.snap({ x: 104, y: 296, width: 80, height: 90 }, 1);
    assert.deepEqual(both.rect, { x: 100, y: 300, width: 80, height: 90 });
    assert.equal(both.guides.length, 2);
  });

  it("snaps centers and opposite edges without changing size", () => {
    const index = new AlignmentGuideIndex([target], "moving");
    assert.equal(index.snap({ x: 173, y: 500, width: 60, height: 20 }, 1).rect.x, 170);
    assert.equal(index.snap({ x: 37, y: 500, width: 60, height: 20 }, 1).rect.x, 40);
    const fractional = new AlignmentGuideIndex([{ ...target, width: 201 }], "moving");
    assert.equal(fractional.snap({ x: 170, y: 500, width: 60, height: 20 }, 1).rect.x, 170.5);
  });

  for (const zoom of [0.1, 0.5, 1, 2, 4]) {
    it(`uses a six-screen-pixel snap distance at ${zoom * 100}% zoom`, () => {
      const index = new AlignmentGuideIndex([target], "moving");
      const rect = { x: 300 + 5 / zoom, y: 1000, width: 80, height: 90 };
      assert.equal(index.snap(rect, zoom).rect.x, 300);
      const outside = { ...rect, x: 300 + 7 / zoom };
      assert.deepEqual(index.snap(outside, zoom), { rect: outside, guides: [] });
    });
  }

  it("excludes the active object and offscreen objects from snap targets", () => {
    const rect = { id: "moving", x: 104, y: 103, width: 80, height: 90 };

    const index = new AlignmentGuideIndex([rect, { ...target, y: 1000 }], rect.id, {
      x: 0,
      y: 0,
      width: 600,
      height: 600,
    });

    assert.deepEqual(index.snap(rect, 1).guides, []);
    assert.equal(index.snap(rect, 1).rect.x, 104);
  });

  it("chooses the closest target regardless of document order", () => {
    const a = { ...target, x: 102 };
    const b = { ...target, id: "b", x: 99 };
    const rect = { x: 100, y: 500, width: 80, height: 90 };
    for (const targets of [
      [a, b],
      [b, a],
    ])
      assert.equal(new AlignmentGuideIndex(targets, "moving").snap(rect, 1).rect.x, 99);
  });

  for (const handle of ["n", "ne", "e", "se", "s", "sw", "w", "nw"] as ResizeHandle[]) {
    it(`snaps only the active ${handle} edges, keeping opposite edges fixed`, () => {
      const index = new AlignmentGuideIndex([target], "moving");
      const rect = { x: 104, y: 104, width: 192, height: 192 };
      const { rect: next, guides } = index.snap(rect, 1, handle, 40);
      assert.equal(next.x, handle.includes("w") ? 100 : 104);
      assert.equal(next.y, handle.includes("n") ? 100 : 104);
      assert.equal(next.x + next.width, handle.includes("e") ? 300 : 296);
      assert.equal(next.y + next.height, handle.includes("s") ? 300 : 296);
      assert.equal(guides.length, handle.length);
    });
  }

  it("never snaps a resize below its minimum size", () => {
    const index = new AlignmentGuideIndex([target], "moving");

    for (const [handle, rect] of [
      ["e", { x: 64, y: 500, width: 40, height: 80 }],
      ["w", { x: 296, y: 500, width: 40, height: 80 }],
      ["s", { x: 500, y: 64, width: 80, height: 40 }],
      ["n", { x: 500, y: 296, width: 80, height: 40 }],
    ] as const) {
      assert.deepEqual(index.snap(rect, 1, handle, 40), { rect, guides: [] });
    }
  });

  it("finds a valid snap when a closer target would violate the minimum", () => {
    const index = new AlignmentGuideIndex([target, { ...target, id: "b", x: 106 }], "moving");
    const result = index.snap({ x: 61, y: 500, width: 40, height: 80 }, 1, "e", 40);
    assert.equal(result.rect.width, 45);
    assert.equal(result.guides[0].position, 106);
  });

  it("coalesces coincident anchors in dense documents into a bounded overlay", () => {
    const index = new AlignmentGuideIndex(
      Array.from({ length: 10000 }, (_, i) => ({ ...target, id: String(i), y: 100 + i })),
      "moving",
    );

    const result = index.snap({ x: 104, y: 12000, width: 80, height: 90 }, 1);
    assert.deepEqual(result.guides, [{ axis: "x", position: 100, start: 100, end: 12090 }]);
  });

  it("commits a snapped drag as one undo step and restores cancelled previews", () => {
    const moving = { id: "moving", name: "Rectangle", x: 400, y: 500, width: 80, height: 90 };
    const document = new CanvasDocument([moving, { ...target, name: "Target" }]);
    const index = new AlignmentGuideIndex(document.getFrames(), moving.id);
    document.beginGesture(moving.id);
    for (const x of [150, 120, 104])
      document.preview({ ...moving, ...index.snap({ ...moving, x }, 1).rect });
    document.endGesture();
    assert.equal(document.getFrame(moving.id)?.x, 100);
    document.undo();
    assert.equal(document.getFrame(moving.id)?.x, 400);
    assert.equal(document.getSnapshot().canUndo, false);
    document.redo();
    assert.equal(document.getFrame(moving.id)?.x, 100);
    document.beginGesture(moving.id);
    document.preview({ ...moving, ...index.snap({ ...moving, x: 304 }, 1).rect });
    document.endGesture(true);
    assert.equal(document.getFrame(moving.id)?.x, 100);
  });
});

describe("guide overlay lifecycle", () => {
  it("coalesces pointer samples, clears immediately, and discards pending guides on cancellation", () => {
    const request = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
    const cancel = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame");
    let id = 0;
    const callbacks = new Map<number, FrameRequestCallback>();
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: (callback: FrameRequestCallback) => {
        callbacks.set(++id, callback);

        return id;
      },
    });
    Object.defineProperty(globalThis, "cancelAnimationFrame", {
      configurable: true,
      value: (key: number) => callbacks.delete(key),
    });

    const tick = () => {
      const ready = [...callbacks.values()];
      callbacks.clear();
      ready.forEach((callback) => callback(16));
    };

    try {
      const overlay = new CanvasGuides();
      let notifications = 0;
      const unsubscribe = overlay.subscribe(() => notifications++);
      const guide: AlignmentGuide = { axis: "x", position: 100, start: 0, end: 500 };
      overlay.set([guide]);
      overlay.set([{ ...guide, end: 600 }]);
      assert.equal(callbacks.size, 1);
      assert.equal(overlay.getSnapshot().length, 0);
      tick();
      assert.equal(overlay.getSnapshot()[0].end, 600);
      assert.equal(notifications, 1);
      overlay.set([{ ...guide, end: 600 }]);
      tick();
      assert.equal(notifications, 1);
      overlay.set([guide]);
      overlay.clear();
      assert.equal(callbacks.size, 0);
      tick();
      assert.deepEqual(overlay.getSnapshot(), []);
      assert.equal(notifications, 2);
      unsubscribe();
      overlay.set([guide]);
      tick();
      assert.equal(notifications, 2);
    } finally {
      if (request) Object.defineProperty(globalThis, "requestAnimationFrame", request);
      else Reflect.deleteProperty(globalThis, "requestAnimationFrame");
      if (cancel) Object.defineProperty(globalThis, "cancelAnimationFrame", cancel);
      else Reflect.deleteProperty(globalThis, "cancelAnimationFrame");
    }
  });
});

describe("stable gesture snapping", () => {
  for (const zoom of [0.5, 1, 4]) {
    it(`holds one target through competing anchors and releases at nine screen pixels (${zoom}x)`, () => {
      const index = new AlignmentGuideIndex(
        [
          { id: "a", x: 100, y: 0, width: 0, height: 100 },
          { id: "b", x: 100 + 8 / zoom, y: 0, width: 0, height: 100 },
        ],
        "moving",
      );

      const state: AlignmentSnapState = {};
      const rect = (offset: number) => ({ x: 100 + offset / zoom, y: 500, width: 0, height: 20 });
      assert.equal(index.snap(rect(2), zoom, undefined, 1, state).rect.x, 100);
      assert.equal(index.snap(rect(7), zoom, undefined, 1, state).rect.x, 100);
      assert.equal(index.snap(rect(10), zoom, undefined, 1, state).rect.x, 100 + 8 / zoom);
      assert.deepEqual(index.snap(rect(18), zoom, undefined, 1, state).guides, []);
      assert.equal(state.x, undefined);
    });
  }

  it("drops locks for targets that leave the visible index", () => {
    const state: AlignmentSnapState = {};
    const index = new AlignmentGuideIndex([target], "moving");
    const rect = { x: 104, y: 500, width: 20, height: 20 };
    assert.equal(index.snap(rect, 1, undefined, 1, state).rect.x, 100);
    assert.deepEqual(new AlignmentGuideIndex([], "moving").snap(rect, 1, undefined, 1, state), {
      rect,
      guides: [],
    });
    assert.equal(state.x, undefined);
  });

  it("releases resize locks that would violate minimum dimensions", () => {
    const state: AlignmentSnapState = {};
    const index = new AlignmentGuideIndex([target], "moving");
    index.snap({ x: 50, y: 500, width: 48, height: 20 }, 1, "e", 40, state);
    const rect = { x: 64, y: 500, width: 40, height: 20 };
    assert.deepEqual(index.snap(rect, 1, "e", 40, state), { rect, guides: [] });
  });
});
