/// <reference types="node" />
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CanvasCamera } from "./canvas-camera";
import {
  CanvasDocument,
  loadCanvasFrames,
  saveCanvasFrames,
  type CanvasFrame,
} from "./canvas-document";
import { marqueeSelection, reparentSelection } from "./canvas-operations";
import { CanvasScene } from "./canvas-scene";

const frame = (id: string, parentId?: string): CanvasFrame => ({
  id,
  name: id,
  parentId,
  x: 20,
  y: 30,
  width: 200,
  height: 160,
});

describe("layer movement", () => {
  it("reorders front-to-back layer rows with one reversible edit", () => {
    const document = new CanvasDocument([frame("a"), frame("b"), frame("c")]);
    assert.equal(document.moveLayers(["a"], "c", "before"), true);
    assert.deepEqual(document.getChildren(), ["b", "c", "a"]);
    document.undo();
    assert.deepEqual(document.getChildren(), ["a", "b", "c"]);
    document.redo();
    assert.deepEqual(document.getChildren(), ["b", "c", "a"]);
    assert.equal(document.moveLayers(["a"], "c", "before"), false);
  });

  it("preserves relative stacking when several siblings move together", () => {
    const document = new CanvasDocument([frame("a"), frame("b"), frame("c")]);
    document.moveLayers(["c", "a"], "b", "before");
    assert.deepEqual(document.getChildren(), ["b", "a", "c"]);
  });

  it("moves whole subtrees into frames without changing world coordinates", () => {
    const initial = [frame("destination"), frame("moving"), frame("child", "moving")];
    const document = new CanvasDocument(initial);
    assert.equal(document.moveLayers(["moving", "child"], "destination", "inside"), true);
    assert.equal(document.getFrame("moving")?.parentId, "destination");
    assert.equal(document.getFrame("child")?.parentId, "moving");
    assert.equal(document.getFrame("moving")?.x, 20);
    assert.equal(document.getFrame("child")?.y, 30);
    document.undo();
    assert.equal(document.getFrame("moving")?.parentId, undefined);
    assert.deepEqual(
      document.getIds(),
      initial.map((node) => node.id),
    );
  });

  it("moves the last group child out and restores the empty group with undo", () => {
    const document = new CanvasDocument([
      { ...frame("group"), kind: "group" },
      frame("child", "group"),
      frame("other"),
    ]);
    document.moveLayers(["child"], "group", "after");
    assert.equal(document.getFrame("group"), undefined);
    assert.equal(document.getFrame("child")?.parentId, undefined);
    assert.deepEqual(document.getChildren(), ["child", "other"]);
    document.undo();
    assert.equal(document.getFrame("group")?.kind, "group");
    assert.equal(document.getFrame("child")?.parentId, "group");
  });

  it("supports dropping at the root bottom and updates source group bounds", () => {
    const document = new CanvasDocument([
      { ...frame("group"), kind: "group" },
      frame("a", "group"),
      { ...frame("b", "group"), x: 400 },
    ]);
    document.moveLayers(["b"], null, "after");
    assert.deepEqual(document.getChildren(), ["b", "group"]);
    assert.equal(document.getFrame("group")?.width, 200);
    document.undo();
    assert.deepEqual(document.getChildren("group"), ["a", "b"]);
  });

  it("rejects cycles, leaf containers and locked source or destination branches", () => {
    const document = new CanvasDocument([
      frame("parent"),
      frame("child", "parent"),
      { ...frame("locked"), locked: true },
      { ...frame("leaf"), kind: "rectangle", fill: "#fff" },
    ]);
    const before = document.getFrames();
    assert.equal(document.moveLayers(["parent"], "child", "inside"), false);
    assert.equal(document.moveLayers(["child"], "child", "before"), false);
    assert.equal(document.moveLayers(["child"], "leaf", "inside"), false);
    assert.equal(document.moveLayers(["locked"], "parent", "inside"), false);
    assert.equal(document.moveLayers(["child"], "locked", "inside"), false);
    assert.deepEqual(document.getFrames(), before);
  });
});

describe("layer visibility", () => {
  it("persists hidden states, inherits visibility, and keeps independent child states on undo", () => {
    const document = new CanvasDocument([
      frame("parent"),
      { ...frame("child", "parent"), hidden: true },
    ]);
    document.update({ ...document.getFrame("parent")!, hidden: true });
    assert.equal(document.isHidden("child"), true);
    document.undo();
    assert.equal(document.isHidden("parent"), false);
    assert.equal(document.isHidden("child"), true);
    let saved = "";
    saveCanvasFrames(document.getFrames(), {
      setItem: (_key, value) => {
        saved = value;
      },
    });
    assert.equal(loadCanvasFrames({ getItem: () => saved })[1].hidden, true);
  });

  it("unmounts hidden subtrees even when pinned and restores them when shown", () => {
    const document = new CanvasDocument([frame("parent"), frame("child", "parent")]);
    class TestCamera extends CanvasCamera {
      override getSnapshot = () => ({
        viewport: { x: 0, y: 0, zoom: 1 },
        size: { x: 800, y: 600 },
      });
    }
    const camera = new TestCamera();
    const scene = new CanvasScene(document, camera);
    const disconnect = scene.connect();
    scene.setPinned("child");
    assert.deepEqual(scene.getSnapshot(), ["parent", "child"]);
    document.update({ ...document.getFrame("parent")!, hidden: true });
    assert.deepEqual(scene.getSnapshot(), []);
    document.undo();
    assert.deepEqual(scene.getSnapshot(), ["parent", "child"]);
    disconnect();
  });

  it("ignores hidden objects and descendants for marquee and drop targets", () => {
    const nodes = [{ ...frame("parent"), hidden: true }, frame("child", "parent"), frame("moving")];
    assert.deepEqual(marqueeSelection(nodes, { x: 0, y: 0, width: 1000, height: 1000 }), [
      "moving",
    ]);
    assert.deepEqual(reparentSelection(nodes, ["moving"]), []);
  });
});
