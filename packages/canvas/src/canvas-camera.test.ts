/// <reference types="node" />

import assert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import { AnimationFrameBatch, CanvasCamera, LatestValueFrameBatch } from "./canvas-camera";

function animationFrames() {
  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  const cancelled: number[] = [];
  return {
    callbacks,
    cancelled,
    request: (callback: FrameRequestCallback) => {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    },
    cancel: (id: number) => {
      cancelled.push(id);
      callbacks.delete(id);
    },
    tick: () => {
      const ready = [...callbacks.values()];
      callbacks.clear();
      for (const callback of ready) callback(16);
    },
  };
}

function withAnimationFrames(run: (frames: ReturnType<typeof animationFrames>) => void) {
  const request = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
  const cancel = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame");
  const frames = animationFrames();
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: frames.request,
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", {
    configurable: true,
    value: frames.cancel,
  });
  try {
    run(frames);
  } finally {
    if (request) Object.defineProperty(globalThis, "requestAnimationFrame", request);
    else Reflect.deleteProperty(globalThis, "requestAnimationFrame");
    if (cancel) Object.defineProperty(globalThis, "cancelAnimationFrame", cancel);
    else Reflect.deleteProperty(globalThis, "cancelAnimationFrame");
  }
}

describe("animation frame batching", () => {
  it("coalesces repeated scheduling into one run with the latest input", () => {
    const frames = animationFrames();
    let sample = 0;
    const published: number[] = [];
    const batch = new AnimationFrameBatch(
      () => published.push(sample),
      frames.request,
      frames.cancel,
    );

    for (let i = 1; i <= 100; i++) {
      sample = i;
      batch.schedule();
    }
    assert.equal(frames.callbacks.size, 1);
    assert.deepEqual(published, []);
    frames.tick();
    assert.deepEqual(published, [100]);

    sample = 101;
    batch.schedule();
    frames.tick();
    assert.deepEqual(published, [100, 101]);
  });

  it("flushes the final sample once and cancels its scheduled callback", () => {
    const frames = animationFrames();
    let runs = 0;
    const batch = new AnimationFrameBatch(() => runs++, frames.request, frames.cancel);

    batch.flush();
    assert.equal(runs, 0);
    batch.schedule();
    batch.flush();
    assert.equal(runs, 1);
    assert.equal(frames.cancelled.length, 1);
    assert.equal(frames.callbacks.size, 0);
    batch.flush();
    frames.tick();
    assert.equal(runs, 1);
  });

  it("cancels without publishing and can be scheduled again", () => {
    const frames = animationFrames();
    let runs = 0;
    const batch = new AnimationFrameBatch(() => runs++, frames.request, frames.cancel);

    batch.schedule();
    batch.cancel();
    batch.cancel();
    frames.tick();
    assert.equal(runs, 0);
    assert.equal(frames.cancelled.length, 1);
    batch.schedule();
    frames.tick();
    assert.equal(runs, 1);
  });

  it("allows a running callback to schedule the next frame", () => {
    const frames = animationFrames();
    let runs = 0;
    const batch = new AnimationFrameBatch(
      () => {
        runs++;
        if (runs === 1) batch.schedule();
      },
      frames.request,
      frames.cancel,
    );

    batch.schedule();
    frames.tick();
    assert.equal(runs, 1);
    assert.equal(frames.callbacks.size, 1);
    frames.tick();
    assert.equal(runs, 2);
  });
});

describe("latest-value animation frame batching", () => {
  it("publishes only the most recent value from a burst of input samples", () => {
    const frames = animationFrames();
    const published: number[] = [];
    const batch = new LatestValueFrameBatch<number>(
      (value) => published.push(value),
      frames.request,
      frames.cancel,
    );

    for (let sample = 1; sample <= 100; sample++) batch.schedule(sample);
    assert.equal(frames.callbacks.size, 1);
    frames.tick();
    assert.deepEqual(published, [100]);
    batch.flush();
    assert.deepEqual(published, [100]);
  });

  it("flushes the final value before gesture commit without a later duplicate", () => {
    const frames = animationFrames();
    const events: string[] = [];
    const batch = new LatestValueFrameBatch<number>(
      (value) => events.push(`preview:${value}`),
      frames.request,
      frames.cancel,
    );

    batch.schedule(20);
    batch.schedule(25);
    batch.flush();
    events.push("commit");
    frames.tick();
    assert.deepEqual(events, ["preview:25", "commit"]);
    assert.equal(frames.cancelled.length, 1);
  });

  it("discards cancelled input and accepts a fresh sample including undefined", () => {
    const frames = animationFrames();
    const published: (number | undefined)[] = [];
    const batch = new LatestValueFrameBatch<number | undefined>(
      (value) => published.push(value),
      frames.request,
      frames.cancel,
    );

    batch.schedule(100);
    batch.cancel();
    batch.flush();
    frames.tick();
    assert.deepEqual(published, []);
    batch.schedule(undefined);
    frames.tick();
    assert.deepEqual(published, [undefined]);
    batch.schedule(200);
    batch.flush();
    assert.deepEqual(published, [undefined, 200]);
  });
});

describe("canvas camera", () => {
  it("exposes immediate input state but publishes only the latest state per animation frame", () => {
    withAnimationFrames((frames) => {
      const camera = new CanvasCamera();
      const initial = camera.getSnapshot();
      let notifications = 0;
      camera.subscribe(() => notifications++);

      camera.setSize({ x: 1200, y: 800 });
      camera.setViewport({ x: 50, y: 100, zoom: 0.5 });
      camera.setViewport({ x: 75, y: 120, zoom: 0.75 });
      const latest = camera.getCurrent();
      assert.deepEqual(latest, {
        viewport: { x: 75, y: 120, zoom: 0.75 },
        size: { x: 1200, y: 800 },
      });
      assert.equal(camera.getSnapshot(), initial);
      assert.equal(frames.callbacks.size, 1);
      assert.equal(notifications, 0);

      frames.tick();
      assert.equal(camera.getSnapshot(), latest);
      assert.equal(notifications, 1);
    });
  });

  it("keeps snapshot identity for equal inputs and flushes the last pending state synchronously", () => {
    withAnimationFrames((frames) => {
      const camera = new CanvasCamera();
      const initial = camera.getSnapshot();
      let notifications = 0;
      camera.subscribe(() => notifications++);

      camera.setSize({ x: 0, y: 0 });
      camera.setViewport({ x: 0, y: 0, zoom: 1 });
      assert.equal(frames.callbacks.size, 0);
      assert.equal(camera.getCurrent(), initial);

      camera.setViewport({ x: 200, y: -100, zoom: 2 });
      camera.flush();
      assert.deepEqual(camera.getSnapshot().viewport, { x: 200, y: -100, zoom: 2 });
      assert.equal(notifications, 1);
      const snapshot = camera.getSnapshot();
      camera.setViewport({ x: 200, y: -100, zoom: 2 });
      camera.flush();
      frames.tick();
      assert.equal(camera.getSnapshot(), snapshot);
      assert.equal(notifications, 1);
    });
  });

  it("stops subscriptions and cancels pending publication", () => {
    withAnimationFrames((frames) => {
      const camera = new CanvasCamera();
      const initial = camera.getSnapshot();
      let notifications = 0;
      const unsubscribe = camera.subscribe(() => notifications++);

      camera.setViewport({ x: 10, y: 20, zoom: 1 });
      camera.cancel();
      frames.tick();
      assert.equal(camera.getSnapshot(), initial);
      assert.equal(notifications, 0);

      camera.setViewport({ x: 30, y: 40, zoom: 1 });
      unsubscribe();
      camera.flush();
      assert.deepEqual(camera.getSnapshot().viewport, { x: 30, y: 40, zoom: 1 });
      assert.equal(notifications, 0);
    });
  });
});
