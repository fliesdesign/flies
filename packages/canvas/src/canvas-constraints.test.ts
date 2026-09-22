import assert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import { canvasConstrainedRect, isCanvasConstraints } from "./canvas-constraints";
import {
  CanvasDocument,
  loadCanvasFrames,
  saveCanvasFrames,
  type CanvasFrame,
} from "./canvas-document";
import { resizeSelection } from "./canvas-operations";
import { worldCorners } from "./canvas-transform";

const parent: CanvasFrame = {
  id: "parent",
  name: "Parent",
  x: 100,
  y: 100,
  width: 300,
  height: 200,
};

const child = (id: string, extra: Partial<CanvasFrame> = {}): CanvasFrame =>
  ({
    id,
    name: id,
    kind: "rectangle",
    parentId: "parent",
    x: 130,
    y: 120,
    width: 100,
    height: 60,
    fill: "#fff",
    ...extra,
  }) as CanvasFrame;

describe("canvas resize constraints", () => {
  it("resolves start, end, center, stretch and scale independently in parent coordinates", () => {
    const after = { ...parent, x: 120, y: 110, width: 600, height: 400 };
    const sample = child("child", { constraints: { horizontal: "end", vertical: "center" } });
    assert.deepEqual(canvasConstrainedRect(parent, after, sample), {
      x: 450,
      y: 230,
      width: 100,
      height: 60,
    });
    assert.deepEqual(
      canvasConstrainedRect(parent, after, {
        ...sample,
        constraints: { horizontal: "stretch", vertical: "scale" },
      }),
      { x: 150, y: 150, width: 400, height: 120 },
    );
    assert.deepEqual(canvasConstrainedRect(parent, after, { ...sample, constraints: {} }), {
      x: 150,
      y: 130,
      width: 100,
      height: 60,
    });
    assert.deepEqual(canvasConstrainedRect(parent, after, child("legacy")), {
      x: 130,
      y: 120,
      width: 100,
      height: 60,
    });
  });

  it("retains the existing unconstrained crop behavior and updates pinned children atomically", () => {
    const document = new CanvasDocument([
      parent,
      child("pinned", { constraints: { horizontal: "end" } }),
      child("legacy"),
    ]);

    const before = document.getFrames();
    document.update({ ...parent, width: 400 });
    assert.equal(document.getFrame("pinned")?.x, 230);
    assert.equal(document.getFrame("legacy")?.x, 130);
    assert.equal(document.getHistoryStats().undoEntries, 1);
    document.undo();
    assert.deepEqual(document.getFrames(), before);
    document.redo();
    assert.equal(document.getFrame("pinned")?.x, 230);
  });

  it("propagates nested free-frame constraints and translates descendant subtrees", () => {
    const document = new CanvasDocument([
      parent,
      {
        id: "inner",
        name: "Inner",
        parentId: "parent",
        x: 120,
        y: 120,
        width: 100,
        height: 100,
        constraints: { horizontal: "stretch" },
      },
      child("nested", {
        parentId: "inner",
        x: 190,
        y: 130,
        width: 20,
        constraints: { horizontal: "end" },
      }),
    ]);

    document.update({ ...parent, width: 400 });
    assert.equal(document.getFrame("inner")?.width, 200);
    assert.equal(document.getFrame("nested")?.x, 290);
    document.undo();
    assert.equal(document.getFrame("nested")?.x, 190);
  });

  it("derives previews from the gesture baseline after a min bound clamps a stretch", () => {
    const pinned = child("pinned", {
      width: 180,
      minWidth: 50,
      constraints: { horizontal: "stretch" },
    });

    const document = new CanvasDocument([parent, pinned]);
    const original = document.getFrames();
    document.beginGesture("parent");
    assert.equal(document.preview({ ...parent, width: 100 }), true);
    assert.equal(document.getFrame("pinned")?.width, 50);
    assert.deepEqual(document.getCommittedFrames(), original);
    assert.equal(document.preview({ ...parent, width: 350 }), true);
    assert.equal(document.getFrame("pinned")?.width, 230);
    document.endGesture();
    assert.equal(document.getFrame("pinned")?.width, 230);
    assert.equal(document.getHistoryStats().undoEntries, 1);
    document.undo();
    assert.deepEqual(document.getFrames(), original);
    document.beginGesture("parent");
    document.preview({ ...parent, width: 400 });
    document.endGesture(true);
    assert.deepEqual(document.getFrames(), original);
  });

  it("honors explicit child updates in the same transaction instead of applying pins twice", () => {
    const pinned = child("pinned", { constraints: { horizontal: "end" } });
    const document = new CanvasDocument([parent, pinned]);
    document.transact({
      update: [
        { ...parent, width: 500 },
        { ...pinned, x: 150 },
      ],
    });
    assert.equal(document.getFrame("pinned")?.x, 150);
  });

  it("applies free-child constraints after an auto-layout parent allocates its fill width", () => {
    const document = new CanvasDocument([
      {
        ...parent,
        layout: { direction: "row", padding: 0, gap: 0, align: "start", justify: "start" },
      },
      {
        id: "inner",
        name: "Inner",
        parentId: "parent",
        x: 100,
        y: 100,
        width: 300,
        height: 150,
        widthSizing: "fill",
      },
      child("nested", {
        parentId: "inner",
        x: 350,
        y: 120,
        width: 30,
        constraints: { horizontal: "end" },
      }),
    ]);

    document.update({ ...document.getFrame("parent")!, width: 500 });
    assert.equal(document.getFrame("inner")?.width, 500);
    assert.equal(document.getFrame("nested")?.x, 550);
  });

  it("validates, freezes and persists bounds and constraints and clamps manual sizes", () => {
    assert.equal(isCanvasConstraints({ horizontal: "end", vertical: "scale" }), true);
    assert.equal(isCanvasConstraints({ horizontal: "invalid" }), false);
    assert.equal(isCanvasConstraints({ unknown: "end" }), false);

    const document = new CanvasDocument([
      parent,
      child("limited", {
        width: 100,
        minWidth: 140,
        maxWidth: 180,
        constraints: { horizontal: "stretch" },
      }),
    ]);

    assert.equal(document.getFrame("limited")?.width, 140);
    assert.ok(Object.isFrozen(document.getFrame("limited")?.constraints));
    document.update({ ...document.getFrame("limited")!, width: 999 });
    assert.equal(document.getFrame("limited")?.width, 180);
    assert.equal(document.update({ ...document.getFrame("limited")!, minWidth: 200 }), false);
    assert.equal(document.update({ ...document.getFrame("limited")!, maxHeight: Infinity }), false);
    assert.equal(document.update({ ...parent, maxWidth: 20 }), false);
    let saved = "";
    saveCanvasFrames(document.getFrames(), {
      setItem: (_key, value) => {
        saved = value;
      },
    });
    assert.deepEqual(loadCanvasFrames({ getItem: () => saved }), document.getFrames());
  });
});

describe("native rotated frame resize constraints", () => {
  it("derives constrained subtrees while preserving unconstrained world coordinates under size limits", () => {
    const rotated = { ...parent, rotation: 35, maxWidth: 450 };

    const document = new CanvasDocument([
      rotated,
      child("pinned", { constraints: { horizontal: "end", vertical: "center" } }),
      child("legacy", { x: 160, y: 180 }),
    ]);

    const frames = document.getFrames();
    const legacy = worldCorners(document, document.getFrame("legacy")!);

    const updates = resizeSelection(frames, [parent.id], rotated, {
      ...rotated,
      x: 70,
      y: 80,
      width: 600,
      height: 300,
    });

    assert.equal(updates[0].width, 450);
    assert.ok(!updates.some((node) => node.id === "pinned"));
    document.beginGesture(document.getDescendantIds([parent.id]));
    document.previewMany(updates);
    assert.equal(document.getFrame("pinned")?.x, 250);
    assert.equal(document.getFrame("pinned")?.y, 150);
    const moved = worldCorners(document, document.getFrame("legacy")!);

    for (const [index, point] of moved.entries()) {
      assert.ok(Math.abs(point.x - legacy[index].x) < 1e-9);
      assert.ok(Math.abs(point.y - legacy[index].y) < 1e-9);
    }

    document.endGesture();
    document.undo();
    assert.deepEqual(document.getFrames(), frames);
  });
});

it("rejects group and page size limits while retaining group parent constraints", () => {
  const group: CanvasFrame = {
    id: "group",
    name: "Group",
    kind: "group",
    parentId: parent.id,
    x: 130,
    y: 120,
    width: 100,
    height: 60,
    constraints: { horizontal: "end" },
  };

  const document = new CanvasDocument([parent, group, child("member", { parentId: group.id })]);
  assert.equal(document.update({ ...group, maxWidth: 50 }), false);
  assert.throws(
    () =>
      new CanvasDocument([
        { id: "page", name: "Page", kind: "page", x: 0, y: 0, width: 0, height: 0, minWidth: 100 },
      ]),
  );
  document.update({ ...parent, width: 400 });
  assert.equal(document.getFrame(group.id)?.x, 230);
  assert.equal(document.getFrame("member")?.x, 230);
});
