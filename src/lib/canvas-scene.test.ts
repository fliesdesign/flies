/// <reference types="node" />

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CanvasCamera } from "./canvas-camera";
import { CanvasDocument, type CanvasFrame } from "./canvas-document";
import { CanvasScene } from "./canvas-scene";

function frame(id: string, x = 0, y = 0): CanvasFrame {
  return { id, name: id, x, y, width: 100, height: 100 };
}

function withScene(
  initial: readonly CanvasFrame[],
  run: (scene: CanvasScene, document: CanvasDocument, camera: CanvasCamera) => void,
) {
  const request = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
  const cancel = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame");
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: () => 1,
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", {
    configurable: true,
    value: () => {},
  });
  const document = new CanvasDocument(initial);
  const camera = new CanvasCamera();
  camera.setSize({ x: 1000, y: 800 });
  camera.flush();
  const scene = new CanvasScene(document, camera);
  const disconnect = scene.connect();
  try {
    run(scene, document, camera);
  } finally {
    disconnect();
    camera.cancel();
    if (request) Object.defineProperty(globalThis, "requestAnimationFrame", request);
    else Reflect.deleteProperty(globalThis, "requestAnimationFrame");
    if (cancel) Object.defineProperty(globalThis, "cancelAnimationFrame", cancel);
    else Reflect.deleteProperty(globalThis, "cancelAnimationFrame");
  }
}

describe("canvas scene visibility", () => {
  it("reuses overscan during short pans and zooms without walking the scene", () => {
    withScene([frame("near"), frame("next", 1300)], (scene, document, camera) => {
      const initial = scene.getSnapshot();
      const getFrame = document.getFrame;
      let frameReads = 0;
      document.getFrame = (id) => {
        frameReads++;
        return getFrame(id);
      };
      for (let x = 1; x <= 180; x++) {
        camera.setViewport({ x: -x, y: 0, zoom: 1 });
        camera.flush();
      }
      camera.setViewport({ x: -100, y: 0, zoom: 0.95 });
      camera.flush();
      assert.equal(frameReads, 0);
      assert.equal(scene.getSnapshot(), initial);

      // Refill before the next node reaches the actual screen edge.
      camera.setViewport({ x: -201, y: 0, zoom: 1 });
      camera.flush();
      assert.ok(frameReads > 0);
      assert.deepEqual(scene.getSnapshot(), ["near", "next"]);
    });
  });

  it("refreshes commits and live pinned previews inside a reused camera region", () => {
    withScene([frame("root"), frame("next", 5000)], (scene, document, camera) => {
      camera.setViewport({ x: -50, y: 0, zoom: 1 });
      camera.flush();
      document.update(frame("next", 300));
      assert.deepEqual(scene.getSnapshot(), ["root", "next"]);
      document.update({ ...frame("next", 300), hidden: true });
      assert.deepEqual(scene.getSnapshot(), ["root"]);
      document.update(frame("next", 300));
      scene.setPinned("root");
      document.beginGesture("root");
      document.preview(frame("root", 5000));
      assert.deepEqual(scene.getSnapshot(), ["root", "next"]);
      document.endGesture();
      scene.setPinned(null);
      assert.deepEqual(scene.getSnapshot(), ["next"]);

      camera.setSize({ x: 0, y: 0 });
      camera.flush();
      assert.deepEqual(scene.getSnapshot(), []);
      camera.setSize({ x: 1000, y: 800 });
      camera.flush();
      assert.deepEqual(scene.getSnapshot(), ["next"]);
    });
  });

  it("releases distant nodes after zooming in from a wide cached view", () => {
    withScene([frame("near"), frame("far", 5000)], (scene, _document, camera) => {
      camera.setViewport({ x: 0, y: 0, zoom: 0.1 });
      camera.flush();
      assert.deepEqual(scene.getSnapshot(), ["near", "far"]);
      camera.setViewport({ x: 0, y: 0, zoom: 1 });
      camera.flush();
      assert.deepEqual(scene.getSnapshot(), ["near"]);
    });
  });

  it("keeps unaffected parents' visible children stable across viewport changes", () => {
    const first = { ...frame("first"), width: 1000 };
    const second = { ...frame("second", 600), width: 1000 };
    withScene(
      [
        first,
        { ...frame("first-child", 100), parentId: "first" },
        second,
        { ...frame("second-child", 700), parentId: "second" },
        { ...frame("late-child", 1300), parentId: "second" },
      ],
      (scene, _document, camera) => {
        const roots = scene.getVisibleChildren();
        const firstChildren = scene.getVisibleChildren("first");
        const secondChildren = scene.getVisibleChildren("second");
        assert.deepEqual(roots, ["first", "second"]);
        assert.deepEqual(firstChildren, ["first-child"]);
        assert.deepEqual(secondChildren, ["second-child"]);
        camera.setViewport({ x: -201, y: 0, zoom: 1 });
        camera.flush();
        assert.equal(scene.getVisibleChildren(), roots);
        assert.equal(scene.getVisibleChildren("first"), firstChildren);
        assert.notEqual(scene.getVisibleChildren("second"), secondChildren);
        assert.deepEqual(scene.getVisibleChildren("second"), ["second-child", "late-child"]);
        assert.equal(scene.getVisibleChildren("missing"), scene.getVisibleChildren("empty"));
      },
    );
  });

  it("updates parent child snapshots after reparenting with unchanged visible order", () => {
    const child = { ...frame("child", 50), parentId: "root" };
    withScene([frame("root"), child], (scene, document) => {
      const visible = scene.getSnapshot();
      let notifications = 0;
      scene.subscribe(() => notifications++);
      document.update({ ...child, parentId: undefined });
      assert.equal(scene.getSnapshot(), visible);
      assert.deepEqual(scene.getVisibleChildren(), ["root", "child"]);
      assert.deepEqual(scene.getVisibleChildren("root"), []);
      assert.equal(notifications, 1);
      document.undo();
      assert.deepEqual(scene.getVisibleChildren(), ["root"]);
      assert.deepEqual(scene.getVisibleChildren("root"), ["child"]);
    });
  });

  it("caches the visible array while the camera and frame bounds keep the same membership", () => {
    withScene([frame("near"), frame("far", 5000)], (scene, document, camera) => {
      const visible = scene.getSnapshot();
      assert.deepEqual(visible, ["near"]);
      let notifications = 0;
      scene.subscribe(() => notifications++);

      camera.setViewport({ x: 100, y: 100, zoom: 1 });
      camera.flush();
      document.update(frame("near", 50, 50));
      document.update(frame("far", 6000));
      assert.equal(scene.getSnapshot(), visible);
      assert.equal(notifications, 0);

      camera.setViewport({ x: -6000, y: 0, zoom: 1 });
      assert.equal(scene.getSnapshot(), visible);
      camera.flush();
      assert.deepEqual(scene.getSnapshot(), ["far"]);
      assert.equal(notifications, 1);
    });
  });

  it("preserves document z-order after spatial updates, deletion, undo, and redo", () => {
    withScene([frame("a", 700), frame("b", 100), frame("c", 600)], (scene, document) => {
      assert.deepEqual(scene.getSnapshot(), ["a", "b", "c"]);
      document.update(frame("a", 300));
      assert.deepEqual(scene.getSnapshot(), ["a", "b", "c"]);

      document.add(frame("d", -150));
      assert.deepEqual(scene.getSnapshot(), ["a", "b", "c", "d"]);
      document.remove("b");
      assert.deepEqual(scene.getSnapshot(), ["a", "c", "d"]);
      document.undo();
      assert.deepEqual(scene.getSnapshot(), ["a", "b", "c", "d"]);
      document.redo();
      assert.deepEqual(scene.getSnapshot(), ["a", "c", "d"]);
      document.undo();
      document.undo();
      assert.deepEqual(scene.getSnapshot(), ["a", "b", "c"]);
    });
  });

  it("keeps a pinned selection mounted while moving beyond the indexed viewport", () => {
    withScene([frame("selected"), frame("other", 500)], (scene, document, camera) => {
      scene.setPinned("selected");
      document.beginGesture("selected");
      document.preview(frame("selected", 5000));
      camera.setViewport({ x: -5000, y: 0, zoom: 1 });
      camera.flush();
      assert.deepEqual(scene.getSnapshot(), ["selected"]);

      // Removing the pin before commit proves the preview did not rebuild the index.
      scene.setPinned(null);
      assert.deepEqual(scene.getSnapshot(), []);
      scene.setPinned("selected");
      document.endGesture();
      scene.setPinned(null);
      assert.deepEqual(scene.getSnapshot(), ["selected"]);

      camera.setViewport({ x: 0, y: 0, zoom: 1 });
      camera.flush();
      assert.deepEqual(scene.getSnapshot(), ["other"]);
      document.undo();
      assert.deepEqual(scene.getSnapshot(), ["selected", "other"]);
    });
  });

  it("cancels a gesture without leaving the preview position in the spatial index", () => {
    withScene([frame("selected")], (scene, document, camera) => {
      scene.setPinned("selected");
      document.beginGesture("selected");
      document.preview(frame("selected", 5000));
      document.endGesture(true);
      scene.setPinned(null);
      assert.deepEqual(scene.getSnapshot(), ["selected"]);
      assert.equal(document.getFrame("selected")?.x, 0);

      camera.setViewport({ x: -5000, y: 0, zoom: 1 });
      camera.flush();
      assert.deepEqual(scene.getSnapshot(), []);
    });
  });

  it("does not pin missing frames and drops pinned frames when deleted", () => {
    withScene([frame("near"), frame("far", 5000)], (scene, document) => {
      const initial = scene.getSnapshot();
      scene.setPinned("missing");
      assert.equal(scene.getSnapshot(), initial);
      scene.setPinned("far");
      assert.deepEqual(scene.getSnapshot(), ["near", "far"]);
      document.remove("far");
      assert.deepEqual(scene.getSnapshot(), ["near"]);
    });
  });

  it("stops notifying a removed scene subscriber", () => {
    withScene([frame("near")], (scene, document) => {
      let notifications = 0;
      const unsubscribe = scene.subscribe(() => notifications++);
      document.add(frame("other", 200));
      assert.equal(notifications, 1);
      unsubscribe();
      document.remove("other");
      assert.equal(notifications, 1);
      assert.deepEqual(scene.getSnapshot(), ["near"]);
    });
  });

  it("mounts every ancestor of a visible overflowing descendant in document order", () => {
    const root = { ...frame("root", 5000), clipContent: false };
    const nested = { ...frame("nested", 5100), kind: "group" as const, parentId: "root" };
    const child = { ...frame("child", 100), parentId: "nested" };
    withScene([root, nested, child, frame("far", 8000)], (scene) => {
      assert.deepEqual(scene.getSnapshot(), ["root", "nested", "child"]);
    });
  });

  it("pins multiple subtrees and their ancestor paths without duplicating nodes", () => {
    const root = frame("root", 5000);
    const group = { ...frame("group", 5100), kind: "group" as const, parentId: "root" };
    const child = { ...frame("child", 5200), parentId: "group" };
    withScene([frame("near"), root, group, child, frame("other", 8000)], (scene) => {
      scene.setPinned(["group", "child", "other"]);
      assert.deepEqual(scene.getSnapshot(), ["near", "root", "group", "child", "other"]);
      const pinned = scene.getSnapshot();
      scene.setPinned(["group", "child", "other"]);
      assert.equal(scene.getSnapshot(), pinned);
      scene.setPinned([]);
      assert.deepEqual(scene.getSnapshot(), ["near"]);
    });
  });

  it("refreshes the visible ancestor path when a child is reparented", () => {
    const first = { ...frame("first", 5000), clipContent: false };
    const second = { ...frame("second", 7000), clipContent: false };
    const child = { ...frame("child", 100), parentId: "first" };
    withScene([first, second, child], (scene, document) => {
      assert.deepEqual(scene.getSnapshot(), ["first", "child"]);
      document.update({ ...child, parentId: "second" });
      assert.deepEqual(scene.getSnapshot(), ["second", "child"]);
      document.undo();
      assert.deepEqual(scene.getSnapshot(), ["first", "child"]);
    });
  });

  it("culls pinned container descendants using live gesture positions", () => {
    const root = { ...frame("root", 5000), width: 4000, clipContent: false };
    const child = { ...frame("child", 5100), parentId: "root" };
    const farChild = { ...frame("far-child", 8000), parentId: "root" };
    withScene([root, child, farChild], (scene, document) => {
      scene.setPinned("root");
      assert.deepEqual(scene.getSnapshot(), ["root"]);
      document.beginGesture(["root", "child", "far-child"]);
      document.previewMany([
        { ...root, x: 0 },
        { ...child, x: 100 },
        { ...farChild, x: 3000 },
      ]);
      assert.deepEqual(scene.getSnapshot(), ["root", "child"]);
      document.endGesture(true);
      assert.deepEqual(scene.getSnapshot(), ["root"]);
      scene.setPinned(null);
      assert.deepEqual(scene.getSnapshot(), []);
    });
  });

  it("disconnects from both document commits and camera publication", () => {
    withScene([frame("near"), frame("far", 5000)], (_scene, document, camera) => {
      const scene = new CanvasScene(document, camera);
      const disconnect = scene.connect();
      const initial = scene.getSnapshot();
      let notifications = 0;
      scene.subscribe(() => notifications++);
      disconnect();
      document.remove("near");
      camera.setViewport({ x: -5000, y: 0, zoom: 1 });
      camera.flush();

      assert.equal(scene.getSnapshot(), initial);
      assert.equal(notifications, 0);
    });
  });

  it("culls auto-layout siblings using live positions during resize and restores them on cancel", () => {
    const root = {
      ...frame("root"),
      width: 10000,
      layout: {
        direction: "row" as const,
        gap: 0,
        padding: 0,
        align: "start" as const,
        justify: "start" as const,
      },
    };
    const first = { ...frame("first"), width: 5000, parentId: "root" };
    const second = { ...frame("second", 5000), parentId: "root" };
    withScene([root, first, second], (scene, document) => {
      scene.setPinned("first");
      assert.deepEqual(scene.getSnapshot(), ["root", "first"]);
      document.beginGesture("first");
      document.preview({ ...first, width: 100 });
      assert.deepEqual(scene.getSnapshot(), ["root", "first", "second"]);
      assert.equal(document.getFrame("second")?.x, 100);
      document.preview(first);
      assert.deepEqual(scene.getSnapshot(), ["root", "first"]);
      document.preview({ ...first, width: 200 });
      assert.deepEqual(scene.getSnapshot(), ["root", "first", "second"]);
      document.endGesture(true);
      assert.deepEqual(scene.getSnapshot(), ["root", "first"]);
    });
  });
});
