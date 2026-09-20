/// <reference types="node" />

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CanvasDocument, type CanvasFrame, type CanvasFrameNode } from "./canvas-document";
import { DEFAULT_CANVAS_LAYOUT } from "./canvas-layout";
import { CanvasRenderNodeStore } from "./canvas-render-node";

function frame(id: string, x = 100, y = 100, parentId?: string): CanvasFrameNode {
  return { id, name: id, x, y, width: 200, height: 100, parentId };
}

function fixture() {
  const document = new CanvasDocument([
    frame("root"),
    frame("child", 130, 150, "root"),
    frame("grandchild", 150, 160, "child"),
    frame("other", 500, 600),
  ]);
  return { document, store: new CanvasRenderNodeStore(document, "child") };
}

function translated(node: CanvasFrame, x: number, y: number): CanvasFrame {
  return { ...node, x: node.x + x, y: node.y + y };
}

describe("canvas render node snapshots", () => {
  it("keeps local snapshots stable while a whole subtree is previewed and committed", () => {
    const { document, store } = fixture();
    const descendant = new CanvasRenderNodeStore(document, "grandchild");
    const original = store.getSnapshot();
    const originalDescendant = descendant.getSnapshot();
    assert.deepEqual([original?.x, original?.y], [30, 50]);
    assert.ok(Object.isFrozen(original));
    let notifications = 0;
    const unsubscribe = store.subscribe(() => notifications++);
    const unsubscribeDescendant = descendant.subscribe(() => notifications++);
    const subtree = document.getDescendantIds(["root"]);
    document.beginGesture(subtree);
    for (let step = 0; step < 5; step++) {
      document.previewMany(subtree.map((id) => translated(document.getFrame(id)!, 4, 8)));
      assert.strictEqual(store.getSnapshot(), original);
      assert.strictEqual(descendant.getSnapshot(), originalDescendant);
    }
    document.endGesture();
    assert.strictEqual(store.getSnapshot(), original);
    assert.strictEqual(descendant.getSnapshot(), originalDescendant);
    assert.equal(notifications, 0);
    assert.deepEqual([document.getFrame("child")?.x, document.getFrame("child")?.y], [150, 190]);
    document.undo();
    assert.strictEqual(store.getSnapshot(), original);
    assert.strictEqual(descendant.getSnapshot(), originalDescendant);
    assert.equal(notifications, 0);
    unsubscribe();
    unsubscribeDescendant();
  });

  it("updates local coordinates when the child or just its parent moves", () => {
    const { document, store } = fixture();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => notifications++);
    const initial = store.getSnapshot();
    document.update(translated(document.getFrame("child")!, 10, 20));
    assert.notStrictEqual(store.getSnapshot(), initial);
    assert.deepEqual([store.getSnapshot()?.x, store.getSnapshot()?.y], [40, 70]);
    document.update(translated(document.getFrame("root")!, 5, 7));
    assert.deepEqual([store.getSnapshot()?.x, store.getSnapshot()?.y], [35, 63]);
    assert.equal(notifications, 2);
    unsubscribe();
  });

  it("ignores fractional translation noise while preserving real subpixel changes", () => {
    const { document, store } = fixture();
    const initial = store.getSnapshot();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => notifications++);
    const subtree = document.getDescendantIds(["root"]);
    document.beginGesture(subtree);
    for (let step = 0; step < 80; step++) {
      document.previewMany(subtree.map((id) => translated(document.getFrame(id)!, 0.1, 0.3)));
      assert.strictEqual(store.getSnapshot(), initial);
    }
    document.endGesture();
    assert.equal(notifications, 0);
    document.update(translated(document.getFrame("child")!, 0.00001, 0));
    const subpixel = store.getSnapshot();
    assert.notStrictEqual(subpixel, initial);
    assert.equal(notifications, 1);
    assert.equal(subpixel?.x, document.getFrame("child")!.x - document.getFrame("root")!.x);

    // Compare with the cached local coordinate, so smaller edits accumulate.
    for (let step = 0; step < 20; step++)
      document.update(translated(document.getFrame("child")!, 1e-10, 0));
    assert.notStrictEqual(store.getSnapshot(), subpixel);
    assert.ok(notifications > 1);
    unsubscribe();
  });

  it("reflects visual fields and optional field removal without changing world data", () => {
    const { document, store } = fixture();
    const initial = store.getSnapshot();
    document.update({ ...document.getFrame("child")!, opacity: 0.5, borderColor: "#f00" });
    const changed = store.getSnapshot();
    assert.notStrictEqual(changed, initial);
    assert.equal(changed?.opacity, 0.5);
    assert.equal(changed?.borderColor, "#f00");
    assert.equal(changed?.x, 30);
    assert.equal(document.getFrame("child")?.x, 130);
    document.update({ ...document.getFrame("child")!, opacity: undefined });
    assert.notStrictEqual(store.getSnapshot(), changed);
    assert.equal(store.getSnapshot()?.opacity, undefined);
  });

  it("compares copied layouts by value and keeps frozen geometry arrays stable", () => {
    const document = new CanvasDocument([
      frame("root"),
      { ...frame("child", 130, 150, "root"), layout: DEFAULT_CANVAS_LAYOUT },
      {
        ...frame("pen", 140, 160, "child"),
        kind: "pen",
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 10 },
        ],
        pathWidth: 10,
        pathHeight: 10,
        stroke: "#000",
        strokeWidth: 1,
        shadows: [{ offsetX: 2, offsetY: 2, blur: 4, spread: 0, color: "#000" }],
      },
    ]);
    const child = new CanvasRenderNodeStore(document, "child");
    const pen = new CanvasRenderNodeStore(document, "pen");
    const before = child.getSnapshot();
    const beforePen = pen.getSnapshot();
    document.updateMany(document.getFrames().map((node) => translated(node, 10, 20)));
    assert.strictEqual(child.getSnapshot(), before);
    assert.strictEqual(pen.getSnapshot(), beforePen);
    assert.notStrictEqual(
      (document.getFrame("child") as CanvasFrameNode).layout,
      (before as CanvasFrameNode).layout,
    );
    document.update({
      ...(document.getFrame("child") as CanvasFrameNode),
      layout: { ...DEFAULT_CANVAS_LAYOUT, gap: 32 },
    });
    assert.notStrictEqual(child.getSnapshot(), before);
  });

  it("follows reparenting and unsubscribes the previous parent", () => {
    const { document, store } = fixture();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => notifications++);
    document.update({ ...document.getFrame("child")!, parentId: "other" });
    assert.equal(store.getSnapshot()?.parentId, "other");
    assert.deepEqual([store.getSnapshot()?.x, store.getSnapshot()?.y], [-370, -450]);
    assert.equal(notifications, 1);
    document.update(translated(document.getFrame("root")!, 1, 2));
    assert.equal(notifications, 1);
    document.update(translated(document.getFrame("other")!, 10, 20));
    assert.equal(notifications, 2);
    assert.deepEqual([store.getSnapshot()?.x, store.getSnapshot()?.y], [-380, -470]);
    document.update({ ...document.getFrame("child")!, parentId: undefined });
    assert.deepEqual([store.getSnapshot()?.x, store.getSnapshot()?.y], [130, 150]);
    assert.equal(notifications, 3);
    document.update(translated(document.getFrame("other")!, 10, 20));
    assert.equal(notifications, 3);
    unsubscribe();
  });

  it("handles deletion, undo and missing nodes being added later", () => {
    const { document, store } = fixture();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => notifications++);
    document.remove("root");
    assert.equal(store.getSnapshot(), undefined);
    assert.equal(notifications, 1);
    document.undo();
    assert.deepEqual([store.getSnapshot()?.x, store.getSnapshot()?.y], [30, 50]);
    assert.equal(notifications, 2);
    document.update(translated(document.getFrame("root")!, 10, 20));
    assert.deepEqual([store.getSnapshot()?.x, store.getSnapshot()?.y], [20, 30]);
    assert.equal(notifications, 3);
    unsubscribe();

    const missing = new CanvasRenderNodeStore(document, "new");
    let added = 0;
    const stop = missing.subscribe(() => added++);
    assert.equal(missing.getSnapshot(), undefined);
    document.add(frame("new", 140, 160, "root"));
    assert.deepEqual([missing.getSnapshot()?.x, missing.getSnapshot()?.y], [30, 40]);
    assert.equal(added, 1);
    stop();
  });

  it("disconnects frame listeners when unused and reconnects to the current parent", () => {
    const { document, store } = fixture();
    const subscribeFrame = document.subscribeFrame;
    const active = new Set<string>();
    document.subscribeFrame = (id, listener) => {
      active.add(id);
      const unsubscribe = subscribeFrame(id, listener);
      return () => {
        active.delete(id);
        unsubscribe();
      };
    };
    let notifications = 0;
    const first = store.subscribe(() => notifications++);
    const second = store.subscribe(() => notifications++);
    assert.deepEqual(active, new Set(["child", "root"]));
    first();
    assert.equal(active.size, 2);
    second();
    assert.equal(active.size, 0);
    document.update({ ...document.getFrame("child")!, parentId: "other" });
    assert.equal(notifications, 0);
    const third = store.subscribe(() => notifications++);
    assert.deepEqual(active, new Set(["child", "other"]));
    document.update(translated(document.getFrame("other")!, 10, 20));
    assert.equal(notifications, 1);
    third();
    assert.equal(active.size, 0);
  });
});
