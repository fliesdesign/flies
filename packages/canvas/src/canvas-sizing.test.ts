/// <reference types="node" />

import assert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  CanvasDocument,
  loadCanvasFrames,
  type CanvasFrame,
  type CanvasFrameNode,
} from "./canvas-document";
import { canvasSizingLabel, DEFAULT_CANVAS_LAYOUT } from "./canvas-layout";
import { resizeSelection } from "./canvas-operations";
import { changeCanvasProperty } from "./canvas-properties";

const parent: CanvasFrameNode = {
  id: "parent",
  name: "Parent",
  x: 100,
  y: 200,
  width: 400,
  height: 200,
  layout: { ...DEFAULT_CANVAS_LAYOUT, padding: 20, gap: 10 },
};

const box = (id: string, overrides: Partial<CanvasFrame> = {}): CanvasFrame =>
  ({
    id,
    name: id,
    parentId: "parent",
    kind: "rectangle",
    x: 0,
    y: 0,
    width: 50,
    height: 30,
    fill: "#fff",
    ...overrides,
  }) as CanvasFrame;

describe("canvas layout sizing", () => {
  it("shares remaining main space equally and fills the cross axis, omitting hidden children", () => {
    const document = new CanvasDocument([
      parent,
      box("fixed"),
      box("a", { widthSizing: "fill", heightSizing: "fill" }),
      box("b", { widthSizing: "fill" }),
      box("hidden", { widthSizing: "fill", hidden: true }),
    ]);

    assert.equal(document.getFrame("a")?.width, 145);
    assert.equal(document.getFrame("a")?.height, 160);
    assert.equal(document.getFrame("b")?.width, 145);
    assert.equal(document.getFrame("b")?.x, 335);
    assert.equal(document.getFrame("hidden")?.width, 50);
    document.update({ ...document.getFrame("parent")!, width: 500 });
    assert.equal(document.getFrame("a")?.width, 195);
    assert.equal(document.getFrame("b")?.x, 385);
  });

  it("retains different minimum sizes during overflow without making bounds negative", () => {
    const document = new CanvasDocument([
      { ...parent, width: 80 },
      box("shape", { widthSizing: "fill" }),
      { ...parent, id: "frame", parentId: "parent", layout: undefined, widthSizing: "fill" },
    ]);

    assert.equal(document.getFrame("shape")?.width, 1);
    assert.equal(document.getFrame("frame")?.width, 40);
    assert.equal(document.getFrame("frame")?.x, 131);
  });

  it("measures both hug axes from visible contents, gap and padding and reflows ancestors", () => {
    const document = new CanvasDocument([
      { ...parent, widthSizing: "hug", heightSizing: "hug" },
      box("a"),
      box("b", { width: 80, height: 60 }),
      box("hidden", { width: 1000, hidden: true }),
    ]);

    assert.equal(document.getFrame("parent")?.width, 180);
    assert.equal(document.getFrame("parent")?.height, 100);
    document.update({ ...document.getFrame("b")!, width: 110 });
    assert.equal(document.getFrame("parent")?.width, 210);
    document.remove("a");
    assert.equal(document.getFrame("parent")?.width, 150);
    assert.equal(document.getFrame("b")?.x, 120);
  });

  it("allocates nested fill layouts downward after measuring their hug heights", () => {
    const document = new CanvasDocument([
      parent,
      {
        ...parent,
        id: "inner",
        parentId: "parent",
        widthSizing: "fill",
        heightSizing: "hug",
        layout: { ...DEFAULT_CANVAS_LAYOUT, direction: "column", padding: 10, gap: 5 },
      },
      box("a", { parentId: "inner", widthSizing: "fill" }),
      box("b", { parentId: "inner", widthSizing: "fill", height: 50 }),
    ]);

    assert.equal(document.getFrame("inner")?.width, 360);
    assert.equal(document.getFrame("inner")?.height, 105);
    assert.equal(document.getFrame("a")?.width, 340);
    assert.equal(document.getFrame("b")?.y, 265);
    document.update({ ...document.getFrame("parent")!, width: 600 });
    assert.equal(document.getFrame("a")?.width, 540);
    assert.equal(document.getFrame("inner")?.height, 105);
    document.update({ ...document.getFrame("b")!, height: 70 });
    assert.equal(document.getFrame("inner")?.height, 125);
  });

  it("breaks hug/fill cycles with minimum sizes and is stable across reloads and unrelated edits", () => {
    const document = new CanvasDocument([
      { ...parent, widthSizing: "hug", heightSizing: "hug" },
      box("a", { widthSizing: "fill", heightSizing: "fill" }),
      box("b", { width: 80, height: 60 }),
    ]);

    const before = document.getFrames();
    assert.equal(document.getFrame("parent")?.width, 131);
    assert.equal(document.getFrame("a")?.width, 1);
    assert.equal(document.getFrame("parent")?.height, 100);

    for (let i = 0; i < 5; i++) {
      document.update({ ...document.getFrame("parent")!, name: `Parent ${i}` });
      assert.equal(document.getFrame("parent")?.width, 131);
      assert.equal(document.getFrame("a")?.height, 1);
      assert.deepEqual(new CanvasDocument(document.getFrames()).getFrames(), document.getFrames());
    }

    assert.deepEqual(
      loadCanvasFrames({ getItem: () => JSON.stringify({ version: 2, nodes: before }) }),
      before,
    );
  });

  it("previews all derived dimensions then cancels or undoes the complete change atomically", () => {
    const document = new CanvasDocument([parent, box("a", { widthSizing: "fill" })]);
    const before = document.getFrames();
    document.beginGesture("parent");
    document.preview({ ...parent, width: 700 });
    assert.equal(document.getFrame("a")?.width, 660);
    assert.deepEqual(document.getCommittedFrames(), before);
    document.endGesture(true);
    assert.deepEqual(document.getFrames(), before);
    document.beginGesture("parent");
    document.preview({ ...parent, width: 700 });
    document.endGesture();
    const after = document.getFrames();
    assert.equal(document.getHistoryStats().undoEntries, 1);
    document.undo();
    assert.deepEqual(document.getFrames(), before);
    document.redo();
    assert.deepEqual(document.getFrames(), after);
  });

  it("rejects malformed sizing and unsupported hug/group combinations atomically", () => {
    const document = new CanvasDocument([parent, box("a")]);
    const before = document.getFrames();

    for (const invalid of [
      { ...box("a"), widthSizing: "auto" },
      { ...box("a"), widthSizing: "hug" },
      { ...parent, layout: undefined, widthSizing: "hug" },
      { ...box("a"), kind: "group", widthSizing: "fill" },
    ]) {
      assert.equal(document.update(invalid as CanvasFrame), false);
      assert.deepEqual(document.getFrames(), before);
    }
  });

  it("manual dimensions and resizing release only the changed automatic axes", () => {
    const document = new CanvasDocument([
      parent,
      box("a", { widthSizing: "fill", heightSizing: "fill" }),
    ]);

    const before = document.getFrames();
    const a = document.getFrame("a")!;
    const resized = resizeSelection(before, ["a"], a, { ...a, width: 100 });
    assert.equal(resized[0].widthSizing, "fixed");
    assert.equal(resized[0].heightSizing, "fill");
    const explicitSameWidth = changeCanvasProperty(before, ["a"], "width", a.width, () => 30);
    assert.equal(explicitSameWidth[0].widthSizing, "fixed");
    assert.equal(explicitSameWidth[0].heightSizing, "fill");
    assert.equal(changeCanvasProperty(before, ["a"], "widthSizing", "hug", () => 30).length, 0);
    document.updateMany(explicitSameWidth);
    document.update({ ...document.getFrame("parent")!, width: 500 });
    assert.equal(document.getFrame("a")?.width, 360);
  });

  it("removing layout fixes hug dimensions, and labels report the resolved sizing", () => {
    const document = new CanvasDocument([
      { ...parent, widthSizing: "hug", heightSizing: "hug" },
      box("a"),
    ]);

    const changes = changeCanvasProperty(
      document.getFrames(),
      ["parent"],
      "layoutMode",
      "none",
      () => 30,
    );

    assert.equal(document.updateMany(changes), true);
    assert.equal(document.getFrame("parent")?.widthSizing, "fixed");
    assert.equal(document.getFrame("parent")?.width, 90);
    assert.equal(
      canvasSizingLabel({
        ...parent,
        width: 740,
        height: 168,
        widthSizing: "fill",
        heightSizing: "hug",
      }),
      "Fill 740 × Fit 168",
    );
  });

  it("preserves fill on descendants moved only to compensate a rotated frame resize", () => {
    const document = new CanvasDocument([
      { ...parent, rotation: 30 },
      box("a", { widthSizing: "fill" }),
    ]);

    const changes = changeCanvasProperty(document.getFrames(), ["parent"], "width", 500, () => 30);
    document.updateMany(changes);
    assert.equal(document.getFrame("a")?.widthSizing, "fill");
    assert.equal(document.getFrame("a")?.width, 460);
    assert.equal(document.getHistoryStats().undoEntries, 1);
    document.undo();
    assert.equal(document.getFrame("a")?.width, 360);
  });
});
