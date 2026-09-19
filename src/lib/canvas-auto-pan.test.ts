/// <reference types="node" />
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CanvasAutoPan, edgePanVelocity, pointerWorldDelta } from "./canvas-auto-pan";
import { CanvasDocument } from "./canvas-document";
import { resizeFrame, screenToWorld, type Point } from "./canvas-geometry";
import { rectFromPoints } from "./canvas-tools";

function scheduler() {
  let id = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  return {
    callbacks,
    request(callback: FrameRequestCallback) {
      callbacks.set(++id, callback);
      return id;
    },
    cancel(key: number) {
      callbacks.delete(key);
    },
    tick(time: number) {
      const current = [...callbacks.values()];
      callbacks.clear();
      current.forEach((callback) => callback(time));
    },
  };
}

describe("canvas edge auto-pan", () => {
  const size = { x: 800, y: 600 };

  it("ramps smoothly at every edge, stays still in the center and caps diagonal speed", () => {
    assert.deepEqual(edgePanVelocity({ x: 400, y: 300 }, size), { x: 0, y: 0 });
    assert.deepEqual(edgePanVelocity({ x: 24, y: 300 }, size), { x: 180, y: 0 });
    assert.deepEqual(edgePanVelocity({ x: 776, y: 300 }, size), { x: -180, y: 0 });
    assert.deepEqual(edgePanVelocity({ x: 400, y: 24 }, size), { x: 0, y: 180 });
    assert.deepEqual(edgePanVelocity({ x: 400, y: 576 }, size), { x: 0, y: -180 });
    assert.deepEqual(edgePanVelocity({ x: -100, y: 300 }, size), { x: 720, y: 0 });
    const diagonal = edgePanVelocity({ x: 800, y: 600 }, size);
    assert.ok(Math.abs(Math.hypot(diagonal.x, diagonal.y) - 720) < 1e-8);
    assert.deepEqual(edgePanVelocity({ x: 20, y: 20 }, { x: 40, y: 40 }), { x: 0, y: 0 });
  });

  it("keeps panning with a stationary pointer and coalesces high frequency input", () => {
    const clock = scheduler();
    const deltas: Point[] = [];
    const pan = new CanvasAutoPan(clock.request, clock.cancel);
    for (let index = 0; index < 10; index++)
      pan.update({ x: 800, y: 300 }, size, (delta) => deltas.push(delta));
    assert.equal(clock.callbacks.size, 1);
    clock.tick(0);
    clock.tick(16);
    clock.tick(32);
    assert.equal(deltas.length, 3);
    assert.equal(deltas[1].x, -11.52);
    assert.equal(deltas[2].x, -11.52);
    pan.update({ x: 400, y: 300 }, size, (delta) => deltas.push(delta));
    assert.equal(clock.callbacks.size, 0);
    clock.tick(48);
    assert.equal(deltas.length, 3);
  });

  it("limits background-tab jumps and resets elapsed time after stopping", () => {
    const clock = scheduler();
    let moved = 0;
    const pan = new CanvasAutoPan(clock.request, clock.cancel);
    const update = () => pan.update({ x: 0, y: 300 }, size, (delta) => (moved += delta.x));
    update();
    clock.tick(0);
    clock.tick(5000);
    assert.equal(moved, 23.04);
    pan.stop();
    assert.equal(clock.callbacks.size, 0);
    update();
    clock.tick(10000);
    assert.equal(moved, 23.04);
    pan.stop();
  });

  it("can stop from its callback without scheduling a stale frame", () => {
    const clock = scheduler();
    const pan = new CanvasAutoPan(clock.request, clock.cancel);
    pan.update({ x: 0, y: 300 }, size, () => pan.stop());
    clock.tick(0);
    assert.equal(clock.callbacks.size, 0);
  });

  for (const zoom of [0.25, 1, 4]) {
    it(`preserves move, resize and marquee world geometry at ${zoom}x zoom`, () => {
      const original = { x: 50, y: -20, zoom };
      const pointer = { x: 200, y: 250 };
      const worldStart = screenToWorld(pointer, original);
      const next = { ...original, x: original.x - 40, y: original.y + 20 };
      const delta = pointerWorldDelta(worldStart, pointer, next);
      assert.deepEqual(delta, { x: 40 / zoom, y: -20 / zoom });
      const rect = { x: 100, y: 100, width: 200, height: 200 };
      const resized = resizeFrame(rect, "se", delta, 1);
      assert.equal(resized.width, 200 + 40 / zoom);
      assert.equal(resized.height, 200 - 20 / zoom);
      const marquee = rectFromPoints(worldStart, screenToWorld(pointer, next), 0);
      assert.equal(marquee.width, 40 / zoom);
      assert.equal(marquee.height, 20 / zoom);
      assert.equal(worldStart.x * next.zoom + next.x, pointer.x - 40);
      assert.equal(worldStart.y * next.zoom + next.y, pointer.y + 20);
    });
  }

  it("treats pointer movement and auto-pan as one undoable gesture and cancels previews", () => {
    const original = { id: "a", name: "A", x: 100, y: 100, width: 100, height: 100 };
    const document = new CanvasDocument([original]);
    const clock = scheduler();
    const pan = new CanvasAutoPan(clock.request, clock.cancel);
    let viewport = { x: 0, y: 0, zoom: 1 };
    const start = { x: 150, y: 150 };
    const pointer = { x: 800, y: 300 };
    const update = () => {
      const delta = pointerWorldDelta(start, pointer, viewport);
      document.preview({ ...original, x: original.x + delta.x, y: original.y + delta.y });
    };
    document.beginGesture(original.id);
    update();
    pan.update(pointer, size, (delta) => {
      viewport = { ...viewport, x: viewport.x + delta.x, y: viewport.y + delta.y };
      update();
    });
    clock.tick(0);
    clock.tick(16);
    clock.tick(32);
    pan.stop();
    document.endGesture();
    assert.ok(document.getFrame(original.id)!.x > 750);
    document.undo();
    assert.deepEqual(document.getFrame(original.id), original);
    assert.equal(document.getSnapshot().canUndo, false);
    document.beginGesture(original.id);
    update();
    document.endGesture(true);
    assert.deepEqual(document.getFrame(original.id), original);
    assert.equal(clock.callbacks.size, 0);
  });
});
